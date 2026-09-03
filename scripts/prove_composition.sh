#!/usr/bin/env bash
# INTEGRATION · the seams between the core modules, which no single item's proof
# can see.
#
# Every other proof in this directory is written by the agent that owns the
# module under test, and each one is honest about its own module. None of them
# can be honest about the JOIN: CORE-005 wraps a verb it does not own, CORE-006
# plugs a guard into a seam it did not declare, CORE-003 reads rows CORE-002
# wrote, and CORE-007 hashes a value CORE-005 also hashes. Each of those is a
# pair of files that typecheck independently and can still disagree at runtime,
# because nothing in the tree calls them together — the HTTP and MCP bindings
# that eventually will are both empty.
#
# Why the obvious cheaper check would not have caught it: `npx tsc --noEmit`
# passes on every one of these seams today, and passed on all of them while the
# two P2 hashers were keyed differently. A type is a claim about shape. These are
# claims about VALUES agreeing — one digest, one seat order, one set of published
# numbers, one epoch key — and the only way to see those is to run the stack.
#
# Single-connection is sufficient and that is not a concession. Nothing asserted
# here depends on two callers racing; every one of these is a property of one
# call through several modules. The concurrency assertions live in
# prove_lock_order.sh, prove_idempotent_race.sh and prove_no_fanout_concurrent.sh
# and exit 2 where they belong.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ]      || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]        || { echo "cannot prove — packages/core/src/hold-seats.ts missing (CORE-002)"; exit 2; }
[ -f packages/core/src/derived.ts ]           || { echo "cannot prove — packages/core/src/derived.ts missing (CORE-003)"; exit 2; }
[ -f packages/core/src/get-hold.ts ]          || { echo "cannot prove — packages/core/src/get-hold.ts missing (CORE-003)"; exit 2; }
[ -f packages/core/src/release.ts ]           || { echo "cannot prove — packages/core/src/release.ts missing (CORE-003)"; exit 2; }
[ -f packages/core/src/idempotency.ts ]       || { echo "cannot prove — packages/core/src/idempotency.ts missing (CORE-005)"; exit 2; }
[ -f packages/core/src/budgets.ts ]           || { echo "cannot prove — packages/core/src/budgets.ts missing (CORE-006)"; exit 2; }
[ -f packages/core/src/principal.ts ]         || { echo "cannot prove — packages/core/src/principal.ts missing (CORE-006)"; exit 2; }
[ -f packages/core/src/access-log.ts ]        || { echo "cannot prove — packages/core/src/access-log.ts missing (CORE-007)"; exit 2; }
[ -d packages/store/src/migrations ]          || { echo "cannot prove — packages/store/src/migrations/ missing (CORE-001)"; exit 2; }

# The P2 seam below is about whether two modules agree GIVEN a configured site
# epoch. Fixed here so the assertion is about the two modules and not about the
# operator's shell.
export CHANGEOVER_HMAC_KEY="composition-proof-site-epoch"

node --input-type=module -e '
import { openDb } from "./packages/store/src/db.ts";
import { migrate } from "./packages/store/src/migrate.ts";
import { seatGrid, seedEstate } from "./packages/store/src/fixtures.ts";
import { isRefusal } from "./packages/schema/src/refusal.ts";

import { decisionMembers, holdSeats } from "./packages/core/src/hold-seats.ts";
import { HOLD_POLICY_DEFAULTS } from "./packages/core/src/guards.ts";
import { getHold } from "./packages/core/src/get-hold.ts";
import { releaseHold } from "./packages/core/src/release.ts";
import { HOLD_COLUMNS, deriveState } from "./packages/core/src/derived.ts";
import { holdSeatsDigest, keyHmac, requestDigest, withIdempotency } from "./packages/core/src/idempotency.ts";
import { HOLD_POLICY_PUBLISHED, principalBudgets } from "./packages/core/src/budgets.ts";
import {
  HANDOFF_GATE_BUDGET_DEFAULT_MS,
  assertGateBudget,
  minPolicyMaxFloorMs,
} from "./packages/core/src/principal.ts";
import { epochHmac, writeAccessLog } from "./packages/core/src/access-log.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const OID  = "occ_composition";
const ETAG = "1:" + "C".repeat(43);
const CRED = { agent_id: "agt_integrator", principal_scope: "ppid_household_seam" };
const KEY  = "k_composition_00000000001";
const EPOCH = { site_epoch_id: "epoch_composition_1", key: process.env.CHANGEOVER_HMAC_KEY };

// Deliberately NOT in C order on the way in, and deliberately the pair the
// specification warns about: byte order puts "F:10" BEFORE "F:2" because "1" <
// "2", where a human and several locales put F:2 first. Seat order is a value
// three modules have an opinion about — the lock sequence, the digest
// projection and the granted document — and handing them an already-sorted
// array would assert nothing at all.
const SEATS_AS_ASKED  = ["F:2", "F:10"];
const SEATS_AS_SORTED = ["F:10", "F:2"];

const REQUEST = {
  occasion_id: OID, occasion_etag: ETAG,
  sought: { occasion_id: OID, occasion_etag: ETAG },
  seats: SEATS_AS_ASKED, requested_floor_ms: 60000,
};

const ESTATE = { name: "composition", occasions: [{
  occasion_id: OID, revision: 1, etag: ETAG,
  origin: "https://embassy.example", source: "reference",
  showtime_id: OID, cluster: null, seating: "allocated",
  capacity: 100, availability_mode: "seat_map",
  starts_at: "2026-08-29T19:00:00+12:00",
  local_wall: "2026-08-29T19:00", local_wall_offset: "+12:00",
  sales_cutoff_at: "2026-12-29T19:15:00+12:00", document: undefined,
  seats: seatGrid({ capacity: 100, per_row: 10 }),
}]};

const db = await openDb();
try {
  await migrate(db);
  await seedEstate(db, ESTATE);

  /* ── 1 · the two published-policy tables ──────────────────────────────────
     CORE-002 clamps a requested floor with HOLD_POLICY_DEFAULTS; CORE-006
     PUBLISHES HOLD_POLICY_PUBLISHED. They are two hand-maintained tables of the
     same numbers in two files, and a number this Server publishes but does not
     honour is a false statement to a consumer that has no way to check it.

     budgets.ts already refuses to LOAD when these disagree, which is the
     stronger guard and is CORE-006 own. Asserting it here anyway makes the
     property legible in the proof output rather than arriving later as an
     unexplained module-init crash, and it states which direction the
     containment runs — the enforced set must be a subset of the published one,
     never the reverse. */
  const shared = Object.keys(HOLD_POLICY_DEFAULTS);
  const drifted = shared.filter((k) => HOLD_POLICY_DEFAULTS[k] !== HOLD_POLICY_PUBLISHED[k]);
  drifted.length === 0
    ? ok("the enforced policy and the published policy agree on all " + shared.length + " members they share")
    : bad("published/enforced policy drift on " + JSON.stringify(drifted));

  const missing = shared.filter((k) => !(k in HOLD_POLICY_PUBLISHED));
  missing.length === 0
    ? ok("every limit CORE-002 enforces is a member CORE-006 publishes — no undisclosed ceiling")
    : bad("enforced but unpublished: " + JSON.stringify(missing));

  /* X6 is a constraint BETWEEN the two: a policy_max_floor_ms below the gate
     budget plus the clock guard plus headroom makes a hand-off gate
     unsatisfiable at the numbers this Server actually ships. */
  const floor = minPolicyMaxFloorMs(HANDOFF_GATE_BUDGET_DEFAULT_MS, HOLD_POLICY_PUBLISHED.clock_guard_ms);
  let gate_ok = true;
  try {
    assertGateBudget({
      policy_max_floor_ms: HOLD_POLICY_PUBLISHED.policy_max_floor_ms,
      handoff_gate_budget_ms: HANDOFF_GATE_BUDGET_DEFAULT_MS,
      clock_guard_ms: HOLD_POLICY_PUBLISHED.clock_guard_ms,
    });
  } catch (err) { gate_ok = false; bad("X6 — published policy cannot fund a hand-off gate: " + err.message); }
  if (gate_ok) ok("the published policy funds X6 at its own numbers: " + HOLD_POLICY_PUBLISHED.policy_max_floor_ms + "ms >= " + floor + "ms");

  HOLD_POLICY_PUBLISHED.handoff_floor_ms <= HOLD_POLICY_PUBLISHED.policy_max_floor_ms
    ? ok("the published hand-off floor fits inside the published maximum floor")
    : bad("handoff_floor_ms exceeds policy_max_floor_ms");

  /* ── 2 · one digest projection, not two ───────────────────────────────────
     I3 is the rule that HTTP and MCP compute the same digest for the same
     decision. That holds by CONSTRUCTION only while CORE-005 projects through
     CORE-002 own exported decisionMembers() rather than re-deriving D from a
     body. If it ever re-derives, both bindings still work and they disagree. */
  holdSeatsDigest(REQUEST) === requestDigest(decisionMembers(REQUEST))
    ? ok("CORE-005 digests CORE-002 own projection of D — the two bindings cannot drift apart")
    : bad("holdSeatsDigest does not route through decisionMembers(): I3 parity is not structural");

  const projected = decisionMembers(REQUEST);
  JSON.stringify(projected.seats) === JSON.stringify(SEATS_AS_SORTED)
    ? ok("D carries the seats already sorted, so two orderings of one request are one decision")
    : bad("D seats " + JSON.stringify(projected.seats) + " != " + JSON.stringify(SEATS_AS_SORTED));

  ("intent_digest" in projected) === false
    ? ok("D excludes intent_digest, so a gate retry is the same request (I3)")
    : bad("intent_digest reached the digest projection");

  /* ── 3 · the vertical, run once ───────────────────────────────────────────
     CORE-005 wrapping CORE-002 with CORE-006 guard in CORE-002 seam. */
  const scope = { ...CRED, verb: "hold_seats", idempotency_key: KEY };
  const digest = holdSeatsDigest(REQUEST);
  const first = await withIdempotency(db, scope, digest,
    () => holdSeats(db, REQUEST, CRED, { budgets: principalBudgets() }));

  first.disposition === "executed"
    ? ok("the stack composes: CORE-005 executed CORE-002 with CORE-006 guard plugged into CORE-002 seam")
    : bad("first call disposition was " + first.disposition);

  const hold = first.record;
  JSON.stringify(hold.seats) === JSON.stringify(SEATS_AS_SORTED)
    ? ok("the granted document reports the seats in the same byte order the digest used")
    : bad("granted seats " + JSON.stringify(hold.seats));

  /* CORE-006 guard ran under CORE-002 locks and left its row: the seam is
     load-bearing, not merely accepted. A guard that typechecks and no-ops would
     pass every assertion above this line. */
  const slots = Number((await db.query(
    "select count(*)::text as n from hold_slot where hold_id = $1", [hold.hold_id])).rows[0].n);
  slots === 1
    ? ok("the budget guard wrote its slot inside the grant transaction — the seam is load-bearing")
    : bad("hold_slot rows for this hold: " + slots + ", expected 1");

  /* ── 4 · the replay re-projects through CORE-003 ──────────────────────────
     I4 replay state must be COMPUTED by the same M1 that get_hold uses. Two
     M1s disagree the first time one of them learns a new marker. */
  let entered = 0;
  const replay = await withIdempotency(db, scope, digest, async () => {
    entered++;
    return holdSeats(db, REQUEST, CRED, { budgets: principalBudgets() });
  });
  (replay.disposition === "replayed" && entered === 0)
    ? ok("the replay answered without re-entering the verb, so no second seat was taken")
    : bad("replay disposition=" + replay.disposition + " entered=" + entered);

  replay.record.hold_id === hold.hold_id
    ? ok("the replay returned the same hold_id the grant minted")
    : bad("replay hold_id drifted from the grant");

  const read = await getHold(db, hold.hold_id, CRED);
  replay.record.state === read.state
    ? ok("the replayed state and the get_hold state are one derivation: both " + read.state)
    : bad("replay state " + replay.record.state + " but get_hold says " + read.state);

  /* And the same derivation again, called directly on the row, so a third
     opinion cannot hide behind the two agreeing.

     Read through HOLD_COLUMNS, which is the projection CORE-003 exports for
     exactly this and which renders every timestamp as RFC 3339. A bare
     `select *` hands deriveState() a Date where HoldFacts declares an Rfc3339
     string, and the comparison then silently yields `expired` for a live Hold
     rather than throwing — the seam is unchecked because Row is
     Record<string, unknown>. Any binding that reads the hold table directly
     must go through this constant. */
  const row = (await db.query(
    `select ${HOLD_COLUMNS} from hold where hold_id = $1`, [hold.hold_id])).rows[0];
  const direct = deriveState(row, read.server_time);
  direct === read.state
    ? ok("deriveState() on the raw row agrees with both, so there is exactly one M1")
    : bad("deriveState() says " + direct + " where the document says " + read.state);

  JSON.stringify(read.seats) === JSON.stringify(SEATS_AS_SORTED)
    ? ok("get_hold reports the seats as granted, in the granted order (M2)")
    : bad("get_hold seats " + JSON.stringify(read.seats));

  /* ── 5 · the P2 epoch, across two modules ─────────────────────────────────
     CORE-005 hashes the Idempotency-Key to key the record; CORE-007 hashes the
     SAME key into the access log. Different keys means the log cannot be
     correlated to the record and shredding one epoch does not shred both. */
  const logged = await writeAccessLog(db, {
    verb: "hold_seats", outcome: "ok",
    agent_id: CRED.agent_id, principal_scope: CRED.principal_scope,
    occasion_id: OID, hold_id: hold.hold_id, idempotency_key: KEY,
  }, read.server_time, { epoch: EPOCH, timezone: "Pacific/Auckland" });

  logged.sink === "primary"
    ? ok("CORE-007 wrote a CORE-002 invocation to the primary log")
    : bad("access log sink was " + logged.sink);

  logged.row.idempotency_key_hmac === epochHmac(EPOCH, KEY)
    ? ok("the log stored the key as an HMAC under the named site epoch, never in the clear")
    : bad("the log idempotency_key_hmac is not epochHmac(epoch, key)");

  logged.row.idempotency_key_hmac === keyHmac(KEY)
    ? ok("CORE-005 and CORE-007 hash one key to one digest under one configured epoch")
    : bad("SPLIT EPOCH — CORE-005 keyHmac and CORE-007 epochHmac disagree; see docs/BUILD-CONTRACT.md 2, the seam Gate 1 left open");

  const clear = await db.query(
    "select count(*)::text as n from changeover_log.access_log where idempotency_key_hmac = $1", [KEY]);
  Number(clear.rows[0].n) === 0
    ? ok("and the raw key appears nowhere in the log table")
    : bad("the raw idempotency key is stored in the access log");

  /* ── 6 · release closes the loop CORE-002 opened ──────────────────────── */
  const rel = await releaseHold(db, hold.hold_id, CRED);
  (rel.status === 204 && rel.seats_freed === SEATS_AS_SORTED.length)
    ? ok("CORE-003 release freed exactly the seats CORE-002 took")
    : bad("release status=" + rel.status + " seats_freed=" + rel.seats_freed);

  const slots_after = Number((await db.query(
    "select count(*)::text as n from hold_slot where hold_id = $1", [hold.hold_id])).rows[0].n);
  slots_after === 0
    ? ok("and CORE-006 budget slot came back with them, so the ceiling is free again")
    : bad("hold_slot still carries " + slots_after + " row(s) after release");

  /* The whole point of a commitment boundary: the seats are grantable again. */
  const again = await holdSeats(db, REQUEST, CRED, { budgets: principalBudgets() });
  (again.hold_id !== hold.hold_id && JSON.stringify(again.seats) === JSON.stringify(SEATS_AS_SORTED))
    ? ok("the same seats granted again to a new Hold — the loop closes end to end")
    : bad("the re-grant did not produce a distinct Hold over the same seats");

} catch (err) {
  if (isRefusal(err)) bad("a refusal escaped the composition: " + err.code + " — " + err.reason);
  else bad("unexpected: " + (err && err.stack ? String(err.stack).split("\n").slice(0, 3).join(" | ") : String(err)));
} finally {
  await db.close();
}

console.log("PASS=" + (fail ? 0 : pass));
process.exit(fail);
'
