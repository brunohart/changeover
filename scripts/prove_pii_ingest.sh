#!/usr/bin/env bash
# C-PII-INGEST. The default behaviour of a competent agent, run at the boundary,
# and then the whole store read back looking for what it sent.
#
# SPEC.md §5.4 is blunt about the threat: a user says "The Conversation, 35mm,
# wheelchair space for my mother Ruth, sarah.chen@gmail.com has the booking",
# and a well-built agent puts that in `work_hint` because that is what the field
# is for. "That is not an adversarial scenario; it is the default behaviour of a
# competent agent." The draft of this specification would have written it,
# verbatim, into a permanent, DELETE-denied log.
#
# Two separate properties are asserted here, and the second is the one that
# matters:
#
#   P1 — an email-, phone- or PAN-shaped work_hint is REFUSED, 400
#        hint_rejected, and never silently stripped.
#   P2 — and if a caller ignores P1 entirely, the store STILL holds no copy,
#        because the write path persists an HMAC and there is no column a raw
#        value could go in.
#
# The second is why the assertion is made against the STORE and not against the
# response. A refusal is a promise about one call; a scan of every text value in
# every table in every schema is a property of the system. A filter can be
# paraphrased past. A column that does not exist cannot be.
#
# The cheaper check — "the API returned 400" — proves nothing about what was
# written before it returned, which is exactly where a draft implementation puts
# the row.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/access-log.ts ]   || { echo "cannot prove — packages/core/src/access-log.ts missing"; exit 2; }
[ -f packages/store/src/migrate.ts ]     || { echo "cannot prove — packages/store/src/migrate.ts missing"; exit 2; }

node --input-type=module -e '
import { openDb } from "./packages/store/src/db.ts";
import { migrate } from "./packages/store/src/migrate.ts";
import { classifyWorkHint, requireValidWorkHint, writeAccessLog } from "./packages/core/src/access-log.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

/* ── The poison. Every one of these is a thing a real user actually says. ──── */

const POISON = [
  { shape: "email",  value: "sarah.chen@gmail.com" },
  { shape: "email",  value: "The Conversation, 35mm, wheelchair space for my mother Ruth, sarah.chen@gmail.com has the booking" },
  { shape: "email",  value: "book under s.chen+cinema@example.co.nz" },
  { shape: "phone",  value: "0212345678" },
  { shape: "phone",  value: "+64 21 555 0199" },
  { shape: "phone",  value: "call 021 555 0199 to confirm" },
  { shape: "pan",    value: "4111111111111111" },
  { shape: "pan",    value: "4111 1111 1111 1111" },
  { shape: "pan",    value: "5500-0000-0000-0004" },
  { shape: "uri",    value: "https://exfiltrate.example/?e=sarah.chen@gmail.com" },
];

/* ── The scanner. Written here, independent of the implementation. ─────────── */
/* A scan that imported the writer\x27s own patterns would be a tautology: it would */
/* find exactly what the writer went looking for and nothing else.             */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const DIGIT_RUN = /[0-9]{7,}/;

// A whole value that is an RFC 3339 date or instant is a timestamp, not a phone
// number. The exemption is anchored at both ends, so "2026-09-01 sarah@x.com"
// is not exempt from anything.
const RFC3339_WHOLE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?)?$/;
// A whole value that is 43 base64url characters is a digest by construction —
// every column in this schema that can hold one carries a CHECK saying so.
// Exempt from the digit-run test only; still scanned for an email.
const DIGEST_WHOLE = /^[A-Za-z0-9_-]{43}$/;

const collapse = (s) => s.replace(/(?<=[0-9])[ .\-](?=[0-9])/g, "");

function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

function panIn(s) {
  for (const run of collapse(s).match(/[0-9]{13,19}/g) ?? []) if (luhn(run)) return true;
  return false;
}

/** What a value is poisoned with, or null. Exemptions are named, never silent. */
function poisonIn(value) {
  if (EMAIL.test(value)) return "email";
  if (panIn(value)) return "pan";
  if (RFC3339_WHOLE.test(value) || DIGEST_WHOLE.test(value)) return null;
  if (DIGIT_RUN.test(value) || DIGIT_RUN.test(collapse(value))) return "phone";
  return null;
}

const db = await openDb({ driver: "pglite" });

try {
  await migrate(db, { logPartitionsFrom: new Date(Date.UTC(2026, 3, 1)), logPartitionMonths: 6 });

  /* ---- 0. The scanner finds the poison when the poison is there. --------- */
  const missed = POISON.filter((p) => p.shape !== "uri").filter((p) => poisonIn(p.value) === null);
  const falsePositives = [
    "2026-09-01", "2026-09-01T01:00", "2026-08-31 13:00:00+00", "+12:00",
    "The Conversation", "2001: A Space Odyssey", "hold_seats", "agt_reference",
  ].filter((v) => poisonIn(v) !== null);
  (missed.length === 0 && falsePositives.length === 0)
    ? ok(`the scanner is a positive control first: it flags all ${POISON.length - 1} personal values and none of the eight structural ones`)
    : bad(`the scanner missed [${missed.map((m) => m.shape).join(",")}] and false-positived [${falsePositives.join(",")}]`);

  /* ---- 1. P1 refuses each shape, and refuses rather than strips. --------- */
  for (const shape of ["email", "phone", "pan"]) {
    const cases = POISON.filter((p) => p.shape === shape);
    const survivors = cases.filter((p) => classifyWorkHint(p.value) === null);
    const returned = cases.map((p) => {
      try { return requireValidWorkHint(p.value); } catch (err) { return err; }
    });
    const allRefused = returned.every((r) => r && r.code === "hint_rejected" && r.remediation !== undefined);
    const stripped = returned.filter((r) => typeof r === "string");
    (survivors.length === 0 && allRefused && stripped.length === 0)
      ? ok(`P1 refuses every ${shape}-shaped work_hint — ${cases.length} of them, each 400 hint_rejected, none returned modified`)
      : bad(`${shape}: ${survivors.length} admitted, ${stripped.length} returned as a stripped string`);
  }

  const leaked = POISON.map((p) => {
    try { requireValidWorkHint(p.value); return null; } catch (err) { return err.reason ?? ""; }
  }).filter((reason) => reason !== null && POISON.some((p) => reason.includes(p.value)));
  leaked.length === 0
    ? ok("no refusal reason quotes the hint back — P1 forbids interpolating it into any prose field, and a reason is one")
    : bad(`${leaked.length} refusal reasons carried the offending value`);

  /* ---- 2. The poisoned run. Guarded AND unguarded, both logged. ---------- */
  const OPTIONS = { epoch: { site_epoch_id: "2026-Q3", key: "destroy-me-on-rotation" }, timezone: "Pacific/Auckland" };
  const AT = "2026-08-31T13:00:00.000000+00:00";
  let i = 0;
  for (const p of POISON) {
    i++;
    // (a) The conforming caller: validate, then log the refusal. A4 — code,
    //     verb, agent_id, slot. The hint itself is not carried at all.
    try {
      requireValidWorkHint(p.value);
      bad(`${p.shape} was admitted by P1 and reached the log unrefused`);
    } catch {
      await writeAccessLog(db, {
        verb: "resolve_occasions", outcome: "refused", refusal_code: "hint_rejected",
        agent_id: "agt_reference", principal_scope: "ps_01H8Z", natural_key: `guarded-${i}`,
      }, AT, OPTIONS);
    }
    // (b) The careless caller: hands the raw value straight to the writer,
    //     having skipped P1 entirely. This is the case P2 exists for — the
    //     store must hold no copy even when the filter was never run.
    await writeAccessLog(db, {
      verb: "resolve_occasions", outcome: "ok",
      agent_id: "agt_reference", principal_scope: "ps_01H8Z", natural_key: `unguarded-${i}`,
      work_hint: p.value, intent_digest: p.value, idempotency_key: p.value,
    }, AT, OPTIONS);
  }
  const written = await db.query("select count(*)::text as c from changeover_log.access_log");
  Number(written.rows[0].c) === POISON.length * 2
    ? ok(`the poisoned run wrote ${POISON.length * 2} rows — ${POISON.length} guarded refusals and ${POISON.length} careless successes`)
    : bad(`the poisoned run wrote ${written.rows[0].c} rows where ${POISON.length * 2} were due`);

  /* ---- 3. The full scan. Every text value, every table, every schema. ---- */
  const columns = await db.query(`
    select c.table_schema as s, c.table_name as t, c.column_name as col
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema = c.table_schema and tb.table_name = c.table_name
     where tb.table_type = \x27BASE TABLE\x27
       and c.table_schema not in (\x27pg_catalog\x27, \x27information_schema\x27, \x27pg_toast\x27)
     order by c.table_schema, c.table_name, c.ordinal_position`);

  const identifier = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
  const hits = [];
  let values = 0, scanned = 0;
  const schemas = new Set(), tables = new Set();
  for (const { s, t, col } of columns.rows) {
    if (!identifier.test(s) || !identifier.test(t) || !identifier.test(col)) {
      bad(`a catalogue identifier "${s}.${t}.${col}" is not an identifier; the scan was not run`);
      continue;
    }
    schemas.add(s); tables.add(`${s}.${t}`); scanned++;
    const r = await db.query(`select distinct "${col}"::text as v from "${s}"."${t}" where "${col}" is not null`);
    for (const row of r.rows) {
      values++;
      const found = poisonIn(String(row.v));
      if (found !== null) hits.push(`${s}.${t}.${col} [${found}] ${String(row.v).slice(0, 60)}`);
    }
  }

  (scanned > 40 && tables.size >= 8 && schemas.has("changeover_log") && schemas.has("public") && values > 50)
    ? ok(`the scan reached ${scanned} columns across ${tables.size} tables in ${schemas.size} schemas, reading ${values} distinct values`)
    : bad(`the scan reached only ${scanned} columns / ${tables.size} tables / ${values} values — a scan that visits nothing also finds nothing`);

  hits.length === 0
    ? ok("a full scan of the store matches no email, no phone and no PAN — asserted on the store, not on the response")
    : bad(`the store holds ${hits.length} personal values: ${hits.slice(0, 5).join(" ; ")}`);

  /* ---- 4. And the raw strings themselves, byte for byte. ---------------- */
  const substrings = [];
  for (const { s, t, col } of columns.rows) {
    if (!identifier.test(s) || !identifier.test(t) || !identifier.test(col)) continue;
    const r = await db.query(
      `select count(*)::text as c from "${s}"."${t}" where "${col}"::text like any ($1::text[])`,
      [POISON.map((p) => "%" + p.value + "%")]);
    if (Number(r.rows[0].c) > 0) substrings.push(`${s}.${t}.${col}`);
  }
  substrings.length === 0
    ? ok(`none of the ${POISON.length} raw values appears as a substring anywhere — the careless caller\x27s hint became an HMAC and nothing else`)
    : bad(`the raw values survive in ${substrings.join(", ")}`);

} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
} finally {
  await db.close();
}

if (pass < 8 && !fail) bad(`only ${pass} assertions ran; the proof did not reach the end`);
console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
