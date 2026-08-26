#!/usr/bin/env bash
# T5 / T6 / CL3 / CL4 — the grant, the claim window and the exhibitor's own
# close of sale, asserted as one arithmetic rather than as three rules that
# happen to agree.
#
# The cheaper check — "hold_seats refuses an Occasion whose sales_cutoff_at has
# already passed" — is G1 step 6 and `prove_guard_order.sh` already asserts it.
# It says nothing about the case this script exists for: a cutoff that has NOT
# passed, and a requested floor longer than the time left until it. Measured
# against real Postgres on 2026-08-25, a 300-second floor requested twenty
# seconds before the cutoff was granted an `expires_at` 280 seconds past the
# close of sale; `hand_off` then minted a `claim_expires_at` 280,083 ms past it;
# `renderClaim` answered 200 `handed_off` and `confirmClaim` answered 200
# `claimed` after the sale had closed, where CL3 requires 410 `claim_expired`.
# Because `claimed` is terminal and §4.6 forbids reaping it, the seat left the
# house's inventory for the life of the screening on a claim that should never
# have been accepted.
#
# Every assertion here runs on one connection and therefore on every substrate.
# There is nothing concurrent about a clamp.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]   || { echo "cannot prove — packages/core/src/hold-seats.ts missing (CORE-002)"; exit 2; }
[ -f packages/core/src/hand-off.ts ]     || { echo "cannot prove — packages/core/src/hand-off.ts missing (CORE-004)"; exit 2; }
[ -f packages/core/src/claim.ts ]        || { echo "cannot prove — packages/core/src/claim.ts missing (CORE-004)"; exit 2; }
[ -f packages/core/test/lib/estate.ts ]  || { echo "cannot prove — packages/core/test/lib/estate.ts missing (CORE-002)"; exit 2; }

node --input-type=module -e '
import { bench, etagFor, occasion } from "./packages/core/test/lib/estate.ts";
import { holdSeats } from "./packages/core/src/hold-seats.ts";
import { getHold } from "./packages/core/src/get-hold.ts";
import { handOff } from "./packages/core/src/hand-off.ts";
import { confirmClaim, parseClaimUrl, renderClaim } from "./packages/core/src/claim.ts";
import { isRefusal } from "./packages/schema/src/refusal.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const AGENT = { agent_id: "agt_reference", principal_scope: "ps_household_1" };
const ms = (a, b) => Date.parse(a) - Date.parse(b);

const req = (occasion_id, over = {}) => ({
  occasion_id,
  occasion_etag: etagFor(occasion_id),
  sought: { occasion_id, occasion_etag: etagFor(occasion_id) },
  seats: ["A:1", "A:2"],
  requested_floor_ms: 120000,
  ...over,
});

const refusalOf = async (fn) => {
  try { await fn(); return null; }
  catch (err) { if (isRefusal(err)) return err; throw err; }
};

/* Cutoffs are computed off the process clock only to WRITE the fixture. Every
 * assertion below reads instants the STORE minted, per K4. */
const inMs = (n) => new Date(Date.now() + n).toISOString();

const NEAR = "occ_sale_near";      // cutoff 20s away: shorter than the floor asked for
const FAR  = "occ_sale_far";       // cutoff a year away: the clamp must not bite
const EDGE = "occ_sale_edge";      // cutoff 400ms away: no floor this venue can warrant
const NONE = "occ_sale_none";      // no published cutoff at all
const SOON = "occ_sale_soon";      // a cutoff that closes while the proof watches

const b = await bench([
  occasion({ occasion_id: NEAR, capacity: 20, sales_cutoff_at: inMs(20_000) }),
  occasion({ occasion_id: FAR,  capacity: 20, sales_cutoff_at: inMs(365 * 24 * 3600 * 1000) }),
  occasion({ occasion_id: EDGE, capacity: 20, sales_cutoff_at: inMs(400) }),
  occasion({ occasion_id: NONE, capacity: 20, sales_cutoff_at: null }),
  occasion({ occasion_id: SOON, capacity: 20, sales_cutoff_at: inMs(60_000) }),
]);

try {
  const cutoffOf = async (occasion_id) => {
    const r = await b.db.query(
      "select to_char(sales_cutoff_at at time zone \x27UTC\x27, \x27YYYY-MM-DD\x22T\x22HH24:MI:SS.USOF:00\x27) as c" +
      " from occasion where occasion_id = $1", [occasion_id]);
    return r.rows[0].c;
  };

  /* ---- 1 · The grant never runs past the close of sale ------------------- */

  const near_cutoff = await cutoffOf(NEAR);
  const held = await holdSeats(b.db, req(NEAR, { requested_floor_ms: 300000 }), AGENT);

  ms(held.expires_at, near_cutoff) <= 0
    ? ok("T2/T5: a 300s floor asked for 20s before the cutoff is granted an expires_at INSIDE the sale window (" +
         held.expires_at + " <= " + near_cutoff + ")")
    : bad("expires_at overran sales_cutoff_at by " + ms(held.expires_at, near_cutoff) + "ms");

  ms(held.floor_deadline, near_cutoff) <= 0
    ? ok("T1: the floor the venue warranted also ends inside its own sale window")
    : bad("floor_deadline overran sales_cutoff_at by " + ms(held.floor_deadline, near_cutoff) + "ms");

  held.floor_ms < 300000 && held.floor_ms >= 1000
    ? ok("the granted floor_ms is the clamped number the store settled (" + held.floor_ms + "ms), not the number that was asked for")
    : bad("floor_ms came back " + held.floor_ms + "; the clamp did not reach the returned document");

  ms(held.expires_at, held.floor_deadline) >= 0
    ? ok("T2 survives the clamp: expires_at >= floor_deadline")
    : bad("the clamp inverted T2: expires_at " + held.expires_at + " < floor_deadline " + held.floor_deadline);

  /* ---- 2 · A cutoff far away must not shorten anything ------------------- */

  const far = await holdSeats(b.db, req(FAR, { requested_floor_ms: 120000 }), AGENT);
  far.floor_ms === 120000
    ? ok("a cutoff a year away leaves the requested floor untouched — the clamp is a ceiling, not a policy")
    : bad("a far cutoff shortened the floor to " + far.floor_ms);

  const none = await holdSeats(b.db, req(NONE, { requested_floor_ms: 120000 }), AGENT);
  none.floor_ms === 120000
    ? ok("no published sales_cutoff_at is no clamp, not a clamp to null")
    : bad("an Occasion with no cutoff granted floor_ms " + none.floor_ms);

  /* ---- 3 · Inside the last second, the venue says so rather than shading -- */

  // Pin the cutoff to the store own clock immediately before the call.
  // Computing it off the process clock at bench-setup time would make this a
  // race with the setup cost rather than a test of the clamp — 999ms is under
  // HOLD_SCHEMA_MIN_FLOOR_MS and comfortably above one guard cascade.
  await b.db.query(
    "update occasion set sales_cutoff_at = clock_timestamp() + interval \x27999 milliseconds\x27 where occasion_id = $1",
    [EDGE]);
  const edge = await refusalOf(() => holdSeats(b.db, req(EDGE, { requested_floor_ms: 120000 }), AGENT));
  edge !== null && edge.code === "floor_unavailable"
    ? ok("X0/T1: a hold requested inside the last second of the sale is 503 floor_unavailable, not a floor the venue cannot warrant")
    : bad("a hold inside the last 400ms of the sale answered " + (edge === null ? "SUCCESS" : edge.code));

  const edge_rows = await b.db.query("select count(*)::text as c from hold where occasion_id = $1", [EDGE]);
  edge_rows.rows[0].c === "0"
    ? ok("and it took no seats on the way out — the refusal is a refusal in the store, not only on the wire")
    : bad(edge_rows.rows[0].c + " hold rows exist for an Occasion whose grant was refused");

  /* ---- 4 · CL4: the claim window is the same ceiling -------------------- */

  const read = await getHold(b.db, held.hold_id, AGENT);
  const off = await handOff(b.db, { hold_id: held.hold_id, read_token: read.read_token }, AGENT);

  ms(off.hold.handoff.claim_expires_at, near_cutoff) <= 0
    ? ok("CL4: claim_expires_at = min(handed_off_at + handoff_floor_ms, sales_cutoff_at) — the min() is honoured, not overridden (" +
         off.hold.handoff.claim_expires_at + " <= " + near_cutoff + ")")
    : bad("claim_expires_at overran sales_cutoff_at by " + ms(off.hold.handoff.claim_expires_at, near_cutoff) + "ms");

  ms(off.hold.handoff.claim_expires_at, held.expires_at) >= 0
    ? ok("T6: and it is still >= expires_at, so hand-off extended the held-until rather than cutting it")
    : bad("T6 broke: claim_expires_at " + off.hold.handoff.claim_expires_at + " < expires_at " + held.expires_at);

  /* ---- 5 · CL3: a claim presented after the window is 410, not 200 ------- */

  // The whole scenario in real time, on a cutoff two and a half seconds away.
  // Ageing the row instead would mean shifting `handed_off_at`, which the claim
  // token is signed over — the token would stop verifying and the answer would
  // be `hold_not_found` for a reason that has nothing to do with the window.
  await b.db.query(
    "update occasion set sales_cutoff_at = clock_timestamp() + interval \x272500 milliseconds\x27 where occasion_id = $1",
    [SOON]);
  const soon_held = await holdSeats(b.db, req(SOON, { requested_floor_ms: 120000 }), AGENT);
  const soon_cutoff = await cutoffOf(SOON);
  const soon_read = await getHold(b.db, soon_held.hold_id, AGENT);
  const soon_off = await handOff(
    b.db, { hold_id: soon_held.hold_id, read_token: soon_read.read_token }, AGENT);

  ms(soon_off.hold.handoff.claim_expires_at, soon_cutoff) <= 0
    ? ok("a claim window on a cutoff 2.5s away is itself 2.5s long — the ceiling binds at every scale")
    : bad("claim_expires_at overran a 2.5s cutoff by " + ms(soon_off.hold.handoff.claim_expires_at, soon_cutoff) + "ms");

  const presented = parseClaimUrl(soon_off.hold.handoff.claim_url);
  await new Promise((resolve) => setTimeout(resolve, 3500));

  const rendered = await renderClaim(b.db, presented);
  rendered.ok === false && rendered.code === "claim_expired"
    ? ok("CL3: GET on a claim past its window renders 410 claim_expired rather than a live checkout")
    : bad("a claim past its window rendered " + JSON.stringify(rendered.ok === false ? rendered.code : rendered.state));

  const confirmed = await confirmClaim(b.db, presented, { binding_ref: "sess_probe" });
  confirmed.ok === false && confirmed.code === "claim_expired"
    ? ok("CL3: and a confirm on it is 410 claim_expired — the seat is not permanently claimed by a window that has closed")
    : bad("a confirm past the claim window answered " + JSON.stringify(confirmed.ok === false ? confirmed.code : confirmed.state));

  const claimed = await b.db.query(
    "select count(*)::text as c from hold where hold_id = $1 and claimed_at is not null", [soon_held.hold_id]);
  claimed.rows[0].c === "0"
    ? ok("§4.6: nothing reached the terminal `claimed` state, so the seat is still the house\x27s to reap")
    : bad("a Hold past its claim window carries claimed_at — that seat is gone for the life of the screening");
} catch (err) {
  bad("unexpected — " + String(err && err.stack ? err.stack.split("\n").slice(0, 5).join(" | ") : err));
} finally {
  await b.close();
}

if (pass < 14 && !fail) bad("only " + pass + " assertions ran; the proof did not reach the end");
console.log("PASS=" + (fail ? 0 : pass));
process.exit(fail);
'
