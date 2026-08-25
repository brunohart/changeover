#!/usr/bin/env bash
# C-LOG. The access log's WRITE PATH: one row per invocation including refusals,
# a CHECK that forces a reason on a refusal, UPDATE and DELETE denied to the
# agent role by GRANT, retention that detaches rather than deletes, partitioning
# by local_wall through both a DST fold and a DST gap, and A2's asymmetry — a
# write verb fails closed where a read verb degrades to a durable sink and
# records the degradation as an event.
#
# The cheaper check — "the writer inserted a row and did not throw" — would not
# have caught any of it. A log that quietly drops the second of a marathon's two
# 02:30 sessions still inserts. A log partitioned on the UTC date still inserts,
# and puts a site's whole Sunday-morning cohort in Saturday night once a year.
# A log whose agent role holds UPDATE still inserts, and is not append-only. A
# writer that swallows a failed write still returns, and then the boundary is
# granting seats it cannot account for. Every one of those is a boundary
# reporting a property it does not have.
#
# The grant denials are asserted by ATTEMPTING both statements under SET LOCAL
# ROLE, never by reading information_schema.role_table_grants: a missing row in
# a catalogue is also what a typo in a schema name looks like. There is a
# positive control beside them for the same reason.
#
# This runs against PGlite deliberately, on the substrate every clean clone has.
# Nothing here needs true concurrency: every assertion is about one caller and
# what the store does to it.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ]         || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/access-log.ts ]           || { echo "cannot prove — packages/core/src/access-log.ts missing"; exit 2; }
[ -f packages/store/src/migrations/0002_access_log.sql ] || { echo "cannot prove — 0002_access_log.sql missing"; exit 2; }
[ -f packages/store/src/migrations/0003_roles_and_grants.sql ] || { echo "cannot prove — 0003_roles_and_grants.sql missing; the append-only property is carried by its grants"; exit 2; }

node --input-type=module -e '
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./packages/store/src/db.ts";
import { migrate } from "./packages/store/src/migrate.ts";
import {
  AccessLogUnavailable, GRAIN_SQL, accessLogRow, detachLogPartition, epochHmac,
  grain, jsonlSink, writeAccessLog,
} from "./packages/core/src/access-log.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const EPOCH = { site_epoch_id: "2026-Q3", key: "a-site-epoch-key-that-is-destroyed-on-rotation" };
const TZ = "Pacific/Auckland";
const OPTIONS = { epoch: EPOCH, timezone: TZ };
const AT = "2026-08-31T13:00:00.000000+00:00";       // 2026-09-01T01:00+12:00 in Auckland

// The raw values a competent agent would send. They must exist in this process
// and appear nowhere in the store.
const RAW_HINT = "The Conversation";
const RAW_DIGEST = "A".repeat(43);
const RAW_KEY = "idem-0001-not-a-hash";

const inv = (over) => ({
  verb: "hold_seats", outcome: "ok", agent_id: "agt_reference", principal_scope: "ps_01H8Z", ...over,
});
const state = (err) => (err && typeof err === "object" && typeof err.code === "string") ? err.code : String(err && err.name);
const n = (r) => Number(r.rows[0] ? Object.values(r.rows[0])[0] : 0);

const dir = await mkdtemp(join(tmpdir(), "changeover-proof-log-"));
const sinkPath = join(dir, "secondary.jsonl");
const db = await openDb({ driver: "pglite" });

try {
  await migrate(db, { logPartitionsFrom: new Date(Date.UTC(2026, 3, 1)), logPartitionMonths: 6 });

  /* ---- 1. One row per invocation. ok, refused and error alike. ------------ */
  const written = [
    inv({ natural_key: "i1", work_hint: RAW_HINT, intent_digest: RAW_DIGEST, idempotency_key: RAW_KEY, occasion_id: "occ_a" }),
    inv({ natural_key: "i2", verb: "get_hold" }),
    inv({ natural_key: "i3", verb: "release_hold", outcome: "error" }),
    inv({ natural_key: "i4", verb: "hold_seats", outcome: "refused", refusal_code: "seat_contended" }),
    inv({ natural_key: "i5", verb: "resolve_occasions", outcome: "refused", refusal_code: "hint_rejected" }),
  ];
  for (const i of written) await writeAccessLog(db, i, AT, OPTIONS);

  const rows = await db.query("select count(*)::text as c from changeover_log.access_log");
  n(rows) === written.length
    ? ok(`one row per invocation — ${written.length} calls, ${n(rows)} rows, refusals and errors included`)
    : bad(`${written.length} invocations produced ${n(rows)} rows`);

  const refused = await db.query(
    "select refusal_code from changeover_log.access_log where outcome = \x27refused\x27 order by refusal_code");
  const codes = refused.rows.map((r) => r.refusal_code).join(",");
  codes === "hint_rejected,seat_contended"
    ? ok("refusals are logged with their closed code — a log of only successes cannot show a boundary being probed")
    : bad(`the refusal rows carried [${codes}]`);

  /* ---- 2. A4: bounded size. There is no column a body could go in. -------- */
  const wide = await db.query(`
    select max(greatest(
      length(agent_id), length(principal_scope), length(verb), length(outcome),
      coalesce(length(refusal_code), 0), coalesce(length(hold_id), 0),
      coalesce(length(occasion_id), 0), length(site_epoch_id),
      length(record_source), length(natural_key)))::text as m
    from changeover_log.access_log`);
  const unbounded = await db.query(`
    select count(*)::text as c from information_schema.columns
     where table_schema = \x27changeover_log\x27 and table_name = \x27access_log\x27
       and data_type in (\x27json\x27, \x27jsonb\x27, \x27bytea\x27, \x27xml\x27)`);
  (n(wide) <= 255 && n(unbounded) === 0)
    ? ok(`A4: every logged value is bounded (longest ${n(wide)} chars) and no json/bytea column exists to put a body in`)
    : bad(`A4: longest value ${n(wide)} chars, ${n(unbounded)} unbounded columns`);

  /* ---- 3. The CHECK forces a reason on refusals, both directions. --------- */
  const insertRaw = async (outcome, code, key) => {
    const row = { ...accessLogRow(inv({ natural_key: key }), AT, OPTIONS), outcome, refusal_code: code };
    const cols = Object.keys(row);
    try {
      await db.query(
        `insert into changeover_log.access_log (${cols.join(", ")}) values (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`,
        cols.map((c) => row[c]));
      return null;
    } catch (err) { return state(err); }
  };
  const noReason = await insertRaw("refused", null, "c1");
  const reasonWithoutRefusal = await insertRaw("ok", "seat_contended", "c2");
  (noReason === "23514" && reasonWithoutRefusal === "23514")
    ? ok("a CHECK forces a reason on refusals and forbids one anywhere else — both attempted, both 23514")
    : bad(`the refusal CHECK gave [${noReason}] and [${reasonWithoutRefusal}] where 23514 was due`);

  /* ---- 4. Append-only BY GRANT. Attempted, not read out of a catalogue. --- */
  const asAgent = async (sql) => {
    try { await db.transaction(async (tx) => { await tx.query(sql); }, { role: "changeover_agent" }); return null; }
    catch (err) { return state(err); }
  };
  const updated = await asAgent("update changeover_log.access_log set outcome = \x27ok\x27");
  const deleted = await asAgent("delete from changeover_log.access_log");
  updated === "42501"
    ? ok("UPDATE on the access log is denied to changeover_agent — attempted under SET LOCAL ROLE, 42501")
    : bad(`UPDATE as changeover_agent gave [${updated}] where 42501 was due`);
  deleted === "42501"
    ? ok("DELETE on the access log is denied to changeover_agent — attempted under SET LOCAL ROLE, 42501")
    : bad(`DELETE as changeover_agent gave [${deleted}] where 42501 was due`);

  let control = null;
  try {
    await db.transaction(async (tx) => {
      await writeAccessLog(tx, inv({ natural_key: "as-agent" }), AT, OPTIONS);
      await tx.query("select count(*) from changeover_log.access_log");
    }, { role: "changeover_agent" });
  } catch (err) { control = state(err); }
  const controlRow = await db.query(
    "select count(*)::text as c from changeover_log.access_log where natural_key = \x27as-agent\x27");
  (control === null && n(controlRow) === 1)
    ? ok("the positive control: the same role INSERTs and SELECTs, so the two denials are the grant and not a typo")
    : bad(`the positive control failed [${control}], ${n(controlRow)} rows — the denials above prove nothing`);

  /* ---- 5. §2.8: the fold. One local_wall, two offsets, two rows. --------- */
  const FOLD_A = "2026-04-04T13:30:00.000000+00:00";   // 02:30 +13:00
  const FOLD_B = "2026-04-04T14:30:00.000000+00:00";   // 02:30 +12:00, one hour later
  for (const at of [FOLD_A, FOLD_B]) {
    await writeAccessLog(db, inv({ verb: "get_hold", natural_key: "marathon" }), at, OPTIONS);
  }
  const fold = await db.query(`
    select local_wall, local_wall_offset, local_wall_date::text as d, tableoid::regclass::text as part
      from changeover_log.access_log where natural_key = \x27marathon\x27 order by local_wall_offset`);
  const foldOk =
    fold.rows.length === 2 &&
    fold.rows.every((r) => r.local_wall === "2026-04-05T02:30" && r.d === "2026-04-05" && /access_log_2026_04$/.test(r.part)) &&
    fold.rows[0].local_wall_offset === "+12:00" && fold.rows[1].local_wall_offset === "+13:00";
  foldOk
    ? ok("the DST fold: both 02:30s land, in the 2026-04 local_wall partition, distinguished by +12:00 and +13:00")
    : bad(`the fold produced ${fold.rows.length} rows: ${JSON.stringify(fold.rows)} — one of a marathon\x27s two sessions was dropped`);

  /* ---- 6. §2.8: the gap. A wall time that does not exist is never emitted. */
  const GAP_BEFORE = "2026-09-26T13:59:00.000000+00:00";  // 01:59 +12:00
  const GAP_AFTER  = "2026-09-26T14:00:00.000000+00:00";  // 03:00 +13:00 — 02:00–02:59 never happens
  await writeAccessLog(db, inv({ verb: "get_hold", natural_key: "gap-before" }), GAP_BEFORE, OPTIONS);
  await writeAccessLog(db, inv({ verb: "get_hold", natural_key: "gap-after" }), GAP_AFTER, OPTIONS);
  const gap = await db.query(`
    select natural_key, local_wall, local_wall_offset, tableoid::regclass::text as part
      from changeover_log.access_log where natural_key like \x27gap-%\x27 order by natural_key`);
  const nonexistent = await db.query(`
    select count(*)::text as c from changeover_log.access_log
     where local_wall_date = date \x272026-09-27\x27 and substring(local_wall from 12 for 2) = \x2702\x27`);
  const gapOk =
    gap.rows.length === 2 &&
    gap.rows[0].local_wall === "2026-09-27T03:00" && gap.rows[0].local_wall_offset === "+13:00" &&
    gap.rows[1].local_wall === "2026-09-27T01:59" && gap.rows[1].local_wall_offset === "+12:00" &&
    gap.rows.every((r) => /access_log_2026_09$/.test(r.part)) && n(nonexistent) === 0;
  gapOk
    ? ok("the DST gap: 01:59+12:00 and 03:00+13:00 both land in the 2026-09 partition, and no row carries the 02:xx that never happened")
    : bad(`the gap produced ${JSON.stringify(gap.rows)}, ${n(nonexistent)} rows inside the gap`);

  /* ---- 7. The partition key is the LOCAL date, not the UTC one. ---------- */
  const boundary = await db.query(`
    select local_wall_date::text as d, local_wall_slot as slot, tableoid::regclass::text as part
      from changeover_log.access_log where natural_key = \x27i1\x27`);
  const b = boundary.rows[0] ?? {};
  (b.d === "2026-09-01" && Number(b.slot) === 1 && /access_log_2026_09$/.test(String(b.part)))
    ? ok("a 31 August UTC instant lands in the 2026-09 partition at local slot 1 — the grain is local_wall, never UTC")
    : bad(`the boundary row landed at ${JSON.stringify(b)} where 2026-09-01 slot 1 in access_log_2026_09 was due`);

  /* ---- 8. P2: HMAC only, and the raw values are nowhere in the log. ------ */
  const stored = await db.query(`
    select work_hint_hmac, intent_digest_hmac, idempotency_key_hmac, site_epoch_id
      from changeover_log.access_log where natural_key = \x27i1\x27`);
  const s = stored.rows[0] ?? {};
  const shaped = /^[A-Za-z0-9_-]{43}$/;
  const p2Ok =
    s.work_hint_hmac === epochHmac(EPOCH, RAW_HINT) &&
    s.intent_digest_hmac === epochHmac(EPOCH, RAW_DIGEST) &&
    s.idempotency_key_hmac === epochHmac(EPOCH, RAW_KEY) &&
    [s.work_hint_hmac, s.intent_digest_hmac, s.idempotency_key_hmac].every((v) => shaped.test(v)) &&
    s.site_epoch_id === "2026-Q3";
  p2Ok
    ? ok("P2: work_hint, intent_digest and Idempotency-Key are stored as 43-character HMACs under a named site epoch")
    : bad(`P2: the row carried ${JSON.stringify(s)}`);

  const scan = await db.query(`
    select count(*)::text as c from changeover_log.access_log
     where (agent_id || principal_scope || verb || outcome || coalesce(refusal_code, \x27\x27)
            || coalesce(hold_id, \x27\x27) || coalesce(occasion_id, \x27\x27) || site_epoch_id
            || coalesce(work_hint_hmac, \x27\x27) || coalesce(intent_digest_hmac, \x27\x27)
            || coalesce(idempotency_key_hmac, \x27\x27) || record_source || natural_key
            || local_wall || local_wall_offset)
           like any (array[$1, $2, $3])`,
    ["%" + RAW_HINT + "%", "%" + RAW_DIGEST + "%", "%" + RAW_KEY + "%"]);
  n(scan) === 0
    ? ok("a scan of every text column of every row matches none of the three raw values — the store holds no copy")
    : bad(`${n(scan)} rows carry a raw value; P2 has been defeated`);

  /* ---- 9. P3: the grain does not need a P2 field, and cannot be given one. */
  const p2Columns = ["work_hint_hmac", "intent_digest_hmac", "idempotency_key_hmac"].filter((c) => GRAIN_SQL.includes(c));
  const g = await grain(db, "2026-09-01", "2026-09-01");
  const okRow = g.find((r) => r.outcome === "ok" && r.verb === "hold_seats");
  // The rate is checked against an independently written count, not against a
  // number typed into this script: a hard-coded expectation goes stale the
  // moment an assertion above writes one more row, and then it is edited to
  // match rather than believed.
  const oracle = await db.query(`
    select (count(*) filter (where occasion_id is not null))::text as a, count(*)::text as t
      from changeover_log.access_log
     where local_wall_date = date \x272026-09-01\x27 and local_wall_slot = 1
       and verb = \x27hold_seats\x27 and outcome = \x27ok\x27`);
  const attributed = Number(oracle.rows[0].a), total = Number(oracle.rows[0].t);
  const refusalRow = g.find((r) => r.outcome === "refused");
  (p2Columns.length === 0 && okRow && okRow.local_wall_slot === 1 && total > 0 &&
   okRow.invocations === total && okRow.attribution_rate === attributed / total &&
   refusalRow && refusalRow.refusal_code !== "")
    ? ok(`P3: the grain is slot × verb × outcome, with attribution_rate ${attributed}/${total} published beside the count, and its SQL names no P2 column`)
    : bad(`P3: GRAIN_SQL names [${p2Columns.join(",")}], returned ${JSON.stringify(okRow)} against an oracle of ${attributed}/${total}`);

  /* ---- 10. A3: retention detaches, and only changeover_retention may. ---- */
  const agentDetach = await asAgent("alter table changeover_log.access_log detach partition changeover_log.access_log_2026_05");
  agentDetach !== null
    ? ok(`detaching a partition as changeover_agent is refused (${agentDetach}) — the DROP capability is not in the boundary\x27s role`)
    : bad("changeover_agent detached a partition; A3 puts that capability in a separate role holding nothing else");

  let retentionDetach = null;
  try { await detachLogPartition(db, "access_log_2026_05"); } catch (err) { retentionDetach = state(err); }
  const stillAttached = await db.query(`
    select count(*)::text as c from pg_inherits i join pg_class c on c.oid = i.inhrelid
     where c.relname = \x27access_log_2026_05\x27`);
  (retentionDetach === null && n(stillAttached) === 0)
    ? ok("detaching succeeds as changeover_retention — retention is a DROP on a partition, never an UPDATE or DELETE on a row")
    : bad(`detach as changeover_retention gave [${retentionDetach}], ${n(stillAttached)} still attached`);

  /* ---- 11. A2. The log is now genuinely gone, not mocked away. ----------- */
  await db.transaction(async (tx) => {
    await tx.query("drop table changeover_log.access_log_default");
  }, { role: "changeover_retention" });
  for (const m of ["04", "06", "07", "08", "09"]) {
    try { await detachLogPartition(db, `access_log_2026_${m}`); } catch { /* already detached */ }
  }
  const landing = await db.query(`
    select count(*)::text as c from pg_inherits i join pg_class p on p.oid = i.inhparent
     join pg_namespace ns on ns.oid = p.relnamespace
     where ns.nspname = \x27changeover_log\x27 and p.relname = \x27access_log\x27`);
  n(landing) === 0
    ? ok("the log now has nowhere for a row to land — a real store failure, not a stubbed one")
    : bad(`${n(landing)} partitions remain; the A2 assertions below would not be testing a failure`);

  const options = { ...OPTIONS, secondary: jsonlSink(sinkPath) };
  let closed = null;
  try { await writeAccessLog(db, inv({ verb: "hold_seats", natural_key: "w1" }), AT, options); }
  catch (err) { closed = err; }
  (closed instanceof AccessLogUnavailable && closed.verb === "hold_seats")
    ? ok("A2: a write verb whose log row cannot be written fails CLOSED — hold_seats throws rather than granting unlogged")
    : bad(`A2: the write verb returned ${closed === null ? "successfully" : String(closed && closed.name)} instead of failing closed`);

  let read = null, readErr = null;
  try {
    read = await writeAccessLog(
      db, inv({ verb: "get_hold", natural_key: "r1", work_hint: RAW_HINT, idempotency_key: RAW_KEY }), AT, options);
  } catch (err) { readErr = err; }
  (read && read.sink === "secondary" && read.degraded === true && read.row.degraded === true)
    ? ok("A2: a read verb degrades to the durable secondary sink rather than denying the read")
    : bad(`A2: the read verb gave ${readErr ? String(readErr.name) : JSON.stringify(read)} — an unbounded fail-closed log is an availability weapon`);

  const sinkText = await readFile(sinkPath, "utf8");
  const lines = sinkText.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rowLine = lines.find((l) => l.kind === "access_log_row");
  const eventLine = lines.find((l) => l.event === "access_log_degraded");
  (rowLine && rowLine.degraded === true && eventLine && eventLine.verb === "get_hold" && typeof eventLine.cause_token === "string")
    ? ok("A2: the degradation is recorded as an event beside the row — a degradation that is not an event is a silent gap")
    : bad(`A2: the sink held ${JSON.stringify(lines)}`);

  const sinkClean =
    !sinkText.includes(RAW_HINT) && !sinkText.includes(RAW_KEY) && !sinkText.includes(RAW_DIGEST) &&
    !/duplicate key|violates|Key \(|no partition of relation/.test(sinkText);
  sinkClean
    ? ok("the secondary sink is storage too: it carries HMACs only, and a cause token rather than a driver message that quotes the row")
    : bad("the secondary sink carries a raw value or a driver message — P2 is defeated on the degraded path");

} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
} finally {
  await db.close();
  await rm(dir, { recursive: true, force: true });
}

if (pass < 17 && !fail) bad(`only ${pass} assertions ran; the proof did not reach the end`);
console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
