#!/usr/bin/env bash
# C-IDEMPOTENT. CORE-005, SPEC.md 4.5.
#
# The assertion is that this is an idempotency store and not a response cache.
# The cheaper check every implementation actually ships — "the same key returns
# the same body" — passes on a cache, and a cache is the defect: a Hold replayed
# from one asserts `state: live` over a floor that expired forty seconds ago, and
# an Agent obeying K1 exactly then computes runway it does not have. So the
# replay here is made over a Hold whose deadline has been pushed into the past,
# and the four time-bearing members are required to have MOVED while the five
# identity and floor members are required not to have.
#
# I4s two member lists are read out of SPEC.md rather than transcribed, because
# a transcription is what drifts.
#
# What is NOT here: the two-connection race. Two callers arriving on one key
# simultaneously, separated by the primary key rather than by a read, needs two
# real connections and PGlite is single-connection and in-process. That is
# scripts/prove_idempotent_race.sh, which exits 2 until CHANGEOVER_PG_URL is set.
# The in-flight assertion below is a genuine one — the marker is COMMITTED
# before the verb runs, and a second call reads a real in-flight row — but it is
# sequential, and it is labelled as such.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f SPEC.md ]                                          || { echo "cannot prove — SPEC.md missing"; exit 2; }
[ -f packages/core/src/idempotency.ts ]                 || { echo "cannot prove — packages/core/src/idempotency.ts missing (CORE-005)"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]                  || { echo "cannot prove — packages/core/src/hold-seats.ts missing (CORE-002 supplies the verb this wraps)"; exit 2; }
[ -f packages/core/test/lib/estate.ts ]                 || { echo "cannot prove — packages/core/test/lib/estate.ts missing (the shared seeder)"; exit 2; }
[ -f packages/store/src/migrations/0001_hold_store.sql ] || { echo "cannot prove — the hold store migration is missing (CORE-001)"; exit 2; }

node --input-type=module -e '
import { readFileSync } from "node:fs";

import { REFUSAL_STATUS, isRefusal } from "@changeover/schema/refusal.ts";
import { holdSeats } from "./packages/core/src/hold-seats.ts";
import {
  REPLAYED_MEMBERS,
  REPROJECTED_MEMBERS,
  handOffDigest,
  holdSeatsDigest,
  withIdempotency,
} from "./packages/core/src/idempotency.ts";
import { rfc3339Sql } from "./packages/core/src/clock.ts";
import { bench, etagFor, occasion } from "./packages/core/test/lib/estate.ts";

let fail = 0, pass = 0;
const ok   = (m) => { console.log("ok — " + m); pass++; };
const bad  = (m) => { console.log("FAIL — " + m); fail = 1; };

/* ── I4 read from the specification, not transcribed ───────────────────────── */

const spec = readFileSync("SPEC.md", "utf8").split("\n");
const i4 = spec.find((line) => line.startsWith("> **I4.**"));
if (i4 === undefined) {
  console.log("cannot prove — SPEC.md carries no I4 rule to read the member lists from");
  process.exit(2);
}
const between = (text, from, to) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to);
  return a < 0 || b < 0 || b < a ? "" : text.slice(a + from.length, b);
};
const backticked = (text) => [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);

const specReprojected = backticked(between(i4, "**except**", "which **MUST** be re-projected"));
const specReplayed = backticked(between(i4, "at replay.", "**MUST** be byte-identical"));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

same(specReprojected, [...REPROJECTED_MEMBERS])
  ? ok("REPROJECTED_MEMBERS is the list I4 names: " + specReprojected.join(", "))
  : bad("REPROJECTED_MEMBERS is " + [...REPROJECTED_MEMBERS].join(", ") + " and I4 names " + specReprojected.join(", "));

same(specReplayed, [...REPLAYED_MEMBERS])
  ? ok("REPLAYED_MEMBERS is the list I4 names: " + specReplayed.join(", "))
  : bad("REPLAYED_MEMBERS is " + [...REPLAYED_MEMBERS].join(", ") + " and I4 names " + specReplayed.join(", "));

/* ── The estate ────────────────────────────────────────────────────────────── */

const OCCASION = "occ_changeover_proof";
const AGENT = "agt_core005proof";
const SCOPE = "principal_proof";
const CREDENTIAL = { agent_id: AGENT, principal_scope: SCOPE };

const b = await bench([occasion({ occasion_id: OCCASION, capacity: 40 })]);

let keyN = 0;
const key = () => { keyN += 1; return ("01K3QW9Z8YVJ4C7N2M5X6TB0" + String(keyN).padStart(2, "0")).slice(0, 26); };
const scope = (k, verb) => ({ agent_id: AGENT, principal_scope: SCOPE, verb: verb ?? "hold_seats", idempotency_key: k });
const request = (seats, floor) => ({
  occasion_id: OCCASION,
  occasion_etag: etagFor(OCCASION),
  sought: { occasion_id: OCCASION, occasion_etag: etagFor(OCCASION) },
  seats,
  requested_floor_ms: floor ?? 120000,
});
const TABLES = ["hold", "hold_seat", "hold_cluster", "hold_slot", "idempotency"];
const census = async () => {
  const out = {};
  for (const t of TABLES) {
    const r = await b.db.query("select count(*)::text as n from " + t);
    out[t] = Number(r.rows[0].n);
  }
  return out;
};
const codeOf = (err) => (isRefusal(err) ? err.code : null);

try {
  /* ── I4 + I8 · the replay ────────────────────────────────────────────────── */

  {
    const k = key();
    const req = request(["A:1", "A:2"]);
    const digest = holdSeatsDigest(req);
    let ran = 0;

    const first = await withIdempotency(b.db, scope(k), digest, () => { ran += 1; return holdSeats(b.db, req, CREDENTIAL); });
    const granted = first.record;

    // The deadline passes. No reap runs and no sweeper exists — M1 derives.
    // make_interval rather than an interval literal, because this program lives
    // inside a single-quoted bash string and a SQL literal cannot be spelled here.
    // ONE read of the clock, joined in, and used three times: clock_timestamp()
    // is VOLATILE and re-evaluated at every occurrence, so separate reads land
    // in separate microseconds and hold_floor_derived — which requires
    // floor_deadline = granted_at + floor_ms EXACTLY — rejects the row.
    await b.db.query(
      "update hold set granted_at = t.g - make_interval(mins => 20),"
      + " floor_deadline = t.g - make_interval(mins => 20) + make_interval(secs => floor_ms / 1000.0),"
      + " expires_at = t.g - make_interval(mins => 20) + make_interval(secs => floor_ms / 1000.0)"
      + " from (select clock_timestamp() as g) t"
      + " where hold_id = $1",
      [granted.hold_id],
    );

    const replay = await withIdempotency(b.db, scope(k), digest, () => { ran += 1; return holdSeats(b.db, req, CREDENTIAL); });

    ran === 1 ? ok("I8 — a key-and-digest match replayed without the verb running at all")
              : bad("I8 — the verb ran " + ran + " times; a matched key reached the guards");

    replay.disposition === "replayed" && replay.replayed === true
      ? ok("I4 — the second call reports itself a replay")
      : bad("I4 — the second call did not replay; it was " + replay.disposition);

    const a = granted, z = replay.record;
    const moved = REPLAYED_MEMBERS.filter((m) => JSON.stringify(z[m]) !== JSON.stringify(a[m]));
    moved.length === 0
      ? ok("I4 — hold_id, seats, granted_at, floor_ms and floor_deadline are byte-identical on replay")
      : bad("I4 — these moved on replay and must not have: " + moved.join(", "));

    Date.parse(z.server_time) > Date.parse(a.server_time)
      ? ok("I4 — server_time was re-read, not served from the stored record")
      : bad("I4 — server_time did not advance; the replay is a cached response");

    a.state === "live" && z.state === "expired"
      ? ok("I4 — state was re-projected: the stored record said live and the replay says expired")
      : bad("I4 — state was not re-projected; stored " + a.state + ", replayed " + z.state);

    Date.parse(z.expires_at) < Date.parse(z.server_time)
      ? ok("I4 — expires_at was re-projected and the replay does not claim runway it does not have")
      : bad("I4 — the replay reports expires_at at or after its own server_time");

    const keySet = (o) => Object.keys(o).sort().join(",");
    keySet(z) === keySet(a)
      ? ok("I4 — the replay carries exactly the members the grant did, added none and dropped none")
      : bad("I4 — the member set changed on replay");
  }

  await b.reset();

  /* ── I5 · same key, different digest ─────────────────────────────────────── */

  {
    const k = key();
    const req = request(["B:1"]);
    await withIdempotency(b.db, scope(k), holdSeatsDigest(req), () => holdSeats(b.db, req, CREDENTIAL));
    const before = await census();

    const other = request(["B:2"]);
    let refusal = null;
    try {
      await withIdempotency(b.db, scope(k), holdSeatsDigest(other), () => holdSeats(b.db, other, CREDENTIAL));
    } catch (err) { refusal = err; }

    codeOf(refusal) === "idempotency_key_reused" && REFUSAL_STATUS.idempotency_key_reused === 422
      ? ok("I5 — same key under a different digest is 422 idempotency_key_reused")
      : bad("I5 — expected 422 idempotency_key_reused and got " + (codeOf(refusal) ?? String(refusal)));

    const after = await census();
    const changed = TABLES.filter((t) => after[t] !== before[t]);
    changed.length === 0
      ? ok("I5 — no action taken: hold, hold_seat, hold_cluster, hold_slot and idempotency are unchanged in the store")
      : bad("I5 — a refused reuse wrote rows to " + changed.join(", "));
  }

  await b.reset();

  /* ── I6 · in flight ─────────────────────────────────────────────────────── */

  {
    const k = key();
    const req = request(["C:1"]);
    const digest = holdSeatsDigest(req);
    let inner = null;

    // Sequential, and a genuine in-flight row: the marker is committed before
    // the verb runs, so the re-entrant call reads what a second caller would.
    const outer = await withIdempotency(b.db, scope(k), digest, async () => {
      try {
        await withIdempotency(b.db, scope(k), digest, () => holdSeats(b.db, req, CREDENTIAL));
      } catch (err) { inner = err; }
      return holdSeats(b.db, req, CREDENTIAL);
    });

    codeOf(inner) === "idempotency_in_flight" && REFUSAL_STATUS.idempotency_in_flight === 409
      ? ok("I6 — a request on an in-flight key is 409 idempotency_in_flight")
      : bad("I6 — expected 409 idempotency_in_flight and got " + (codeOf(inner) ?? String(inner)));

    isRefusal(inner) && Number.isInteger(inner.retry_after_ms) && inner.retry_after_ms > 0 && inner.remediation === "retry_same_key"
      ? ok("I6 — it carries retry_after_ms " + inner.retry_after_ms + " and remediation retry_same_key")
      : bad("I6 — the in-flight refusal carried no usable retry_after_ms or the wrong remediation");

    const after = await census();
    outer.disposition === "executed" && after.hold === 1
      ? ok("I6 — the refusal produced no duplicate: exactly one Hold exists")
      : bad("I6 — the store holds " + after.hold + " Holds after one grant and one in-flight refusal");
  }

  await b.reset();

  /* ── I7 · the human gate ────────────────────────────────────────────────── */

  {
    const k = key();
    const req = request(["C:2"]);
    const digest = holdSeatsDigest(req);

    const gate = await withIdempotency(b.db, scope(k), digest, async () => ({ input_required: true }));
    const afterGate = await census();

    gate.disposition === "input_required" && afterGate.idempotency === 0
      ? ok("I7 — an input_required call recorded no idempotency entry")
      : bad("I7 — a gate recorded " + afterGate.idempotency + " idempotency rows; an InputRequiredResult is not an operation");

    const satisfied = await withIdempotency(b.db, scope(k), digest, () => holdSeats(b.db, req, CREDENTIAL));
    satisfied.disposition === "executed"
      ? ok("I7 — the same key is accepted on the gate-satisfying retry")
      : bad("I7 — the gate-satisfying retry was " + satisfied.disposition + " and not an execution");
  }

  await b.reset();

  /* ── I9 · the claim URL is a credential ─────────────────────────────────── */

  {
    const k = key();
    const hold = await holdSeats(b.db, request(["D:1"]), CREDENTIAL);
    // A hand-off whose claim window has already closed. CORE-004 owns the verb;
    // what is under test is this layers replay of one, so the document is
    // assembled at the execute seam that divides them.
    const r = await b.db.query(
      "update hold set granted_at = t.g - make_interval(mins => 30),"
      + " floor_deadline = t.g - make_interval(mins => 30) + make_interval(secs => floor_ms / 1000.0),"
      + " expires_at = t.g - make_interval(mins => 10),"
      + " handed_off_at = t.g - make_interval(mins => 25),"
      + " handoff_floor_ms = 180000,"
      + " claim_expires_at = t.g - make_interval(mins => 10)"
      + " from (select clock_timestamp() as g) t"
      + " where hold_id = $1"
      + " returning " + rfc3339Sql("handed_off_at") + " as handed_off_at,"
      + " " + rfc3339Sql("claim_expires_at") + " as claim_expires_at",
      [hold.hold_id],
    );
    const CLAIM_URL = "https://reference.example/claim/" + "t".repeat(43);
    const handed = {
      ...hold,
      state: "handed_off",
      handoff: {
        handed_off_at: r.rows[0].handed_off_at,
        handoff_floor_ms: 180000,
        claim_url: CLAIM_URL,
        claim_expires_at: r.rows[0].claim_expires_at,
      },
    };

    const s = scope(k, "hand_off");
    const digest = handOffDigest(hold.hold_id);
    await withIdempotency(b.db, s, digest, async () => handed);
    const replay = await withIdempotency(b.db, s, digest, () => { throw new Error("I8: the verb must not run on a replay"); });

    const z = replay.record;
    const serialised = JSON.stringify(z);

    replay.disposition === "replayed" && z.handoff === undefined && !serialised.includes("claim_url") && !serialised.includes(CLAIM_URL)
      ? ok("I9 — a hand_off replay past claim_expires_at carries no claim_url anywhere in the document")
      : bad("I9 — a replay past the claim window re-emitted a spent claim URL");

    const moved = REPLAYED_MEMBERS.filter((m) => JSON.stringify(z[m]) !== JSON.stringify(handed[m]));
    moved.length === 0 && z.state === "expired"
      ? ok("I9 — the departure is confined to the claim: identity and floor still replay byte-identically")
      : bad("I9 — the claim departure moved " + (moved.join(", ") || "state, which reads " + z.state));
  }

  /* ── P2 · the key itself ────────────────────────────────────────────────── */

  {
    const rows = await b.db.query("select idempotency_key_hmac from idempotency");
    const raw = [];
    for (let n = 1; n <= keyN; n++) raw.push(("01K3QW9Z8YVJ4C7N2M5X6TB0" + String(n).padStart(2, "0")).slice(0, 26));
    const leaked = rows.rows.filter((row) => raw.includes(row.idempotency_key_hmac));
    leaked.length === 0 && rows.rows.every((row) => /^[A-Za-z0-9_-]{43}$/.test(row.idempotency_key_hmac))
      ? ok("P2 — every stored key is an HMAC and no raw Idempotency-Key is in the store")
      : bad("P2 — a raw Idempotency-Key reached the store");
  }
} finally {
  await b.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
