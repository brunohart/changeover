#!/usr/bin/env bash
# CORE-003 · R1 and R2. release_hold answers 204 in live, released, expired,
# claimed and revoked; it refuses 409 handoff_consumed in handed_off; and after
# that 409 the seat is STILL HELD.
#
# The cheaper check — assert the 409 — would not have caught the failure this
# exists for. A boundary can refuse the verb and free the seat anyway: raise the
# refusal after the update, or free the row in a cleanup path, and every test
# that reads the status code passes while a customer standing in a checkout
# loses their seats to a remote instruction. So the seat row is COUNTED after
# the refusal, from the store, in the state it must still be in.
#
# The other half is totality, and totality is only visible by exhaustion: a verb
# that refuses in one of R2 five states logs a false alarm at a rate
# proportional to abandonment, which is the common case, so the loop runs every
# state R2 names rather than a representative one.
#
# Single-connection is sufficient and that is not a concession: R1 and R2 are
# properties of one call against one Hold. Nothing here depends on two callers
# racing, so PGlite proves it exactly.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ]        || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/release.ts ]             || { echo "cannot prove — packages/core/src/release.ts missing"; exit 2; }
[ -f packages/core/src/get-hold.ts ]            || { echo "cannot prove — packages/core/src/get-hold.ts missing"; exit 2; }
[ -f packages/core/test/lib/hold-fixtures.ts ]  || { echo "cannot prove — packages/core/test/lib/hold-fixtures.ts missing"; exit 2; }
[ -d packages/store/src/migrations ]            || { echo "cannot prove — packages/store/src/migrations/ missing"; exit 2; }

node --input-type=module -e '
import { openDb } from "./packages/store/src/db.ts";
import { migrate } from "./packages/store/src/migrate.ts";
import { seedEstate } from "./packages/store/src/fixtures.ts";
import { isRefusal } from "./packages/schema/src/refusal.ts";
import { HOLD_STATE } from "./packages/core/src/derived.ts";
import { getHold } from "./packages/core/src/get-hold.ts";
import { releaseHold } from "./packages/core/src/release.ts";
import { house, mintHold } from "./packages/core/test/lib/hold-fixtures.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const CREDENTIAL = { agent_id: "agt_reference", principal_scope: "site_wellington" };
const SEATS = ["A:1", "A:2"];

const db = await openDb();
try {
  await migrate(db);
  const seed = house();
  await seedEstate(db, { name: "core-003-release", occasions: [seed] });

  const fresh = async (state, extra = {}) => {
    await db.query("delete from hold");
    return mintHold(db, { state, occasion: seed, seats: SEATS, ...extra });
  };
  const seatStates = async (hold_id) => {
    const rows = await db.query(
      "select seat_id, state from hold_seat where hold_id = $1 order by seat_id", [hold_id]);
    return rows.rows;
  };

  /* 1 · R2 — total in all five states it names. ---------------------------- */
  for (const state of [HOLD_STATE.live, HOLD_STATE.released, HOLD_STATE.expired,
                       HOLD_STATE.claimed, HOLD_STATE.revoked]) {
    const minted = await fresh(state);
    try {
      const outcome = await releaseHold(db, minted.hold_id, CREDENTIAL);
      outcome.status === 204 && outcome.state_before === state
        ? ok("release_hold answers 204 in " + state)
        : bad("release_hold answered " + outcome.status + " in " + state);
    } catch (err) {
      bad("release_hold refused in " + state + ": " + (isRefusal(err) ? err.code : String(err)));
    }
  }

  /* 2 · R2 — and it is idempotent, not merely total once. ------------------ */
  {
    const minted = await fresh(HOLD_STATE.live);
    const first = await releaseHold(db, minted.hold_id, CREDENTIAL);
    const second = await releaseHold(db, minted.hold_id, CREDENTIAL);
    second.status === 204 && second.released_at === first.released_at && second.seats_freed === 0
      ? ok("a second release is 204 and does not re-date the first")
      : bad("a second release was not idempotent: " + JSON.stringify(second));
  }

  /* 3 · The seats and the budgets come back together. ---------------------- */
  {
    const minted = await fresh(HOLD_STATE.live, { slot: 0 });
    await releaseHold(db, minted.hold_id, CREDENTIAL);
    const seats = await seatStates(minted.hold_id);
    seats.length === SEATS.length && seats.every((r) => r.state === "released")
      ? ok("releasing a live Hold takes its seat rows out of the occupying states")
      : bad("the released seat rows are " + JSON.stringify(seats));
    const slots = await db.query("select slot from hold_slot where hold_id = $1", [minted.hold_id]);
    slots.rows.length === 0
      ? ok("and the budget slot came back with them, so a derived-live count is free again")
      : bad("the budget slot did not come back");
  }

  /* 4 · R1 — the refusal, and the seat that is still held after it. -------- */
  {
    const minted = await fresh(HOLD_STATE.handed_off);
    const before = await seatStates(minted.hold_id);
    let refusal = null;
    try {
      await releaseHold(db, minted.hold_id, CREDENTIAL);
    } catch (err) {
      refusal = err;
    }
    refusal !== null && isRefusal(refusal) && refusal.code === "handoff_consumed" && refusal.status === 409
      ? ok("release_hold on a handed-off Hold is 409 handoff_consumed")
      : bad("release_hold on a handed-off Hold gave " + (refusal === null ? "204" : String(refusal)));

    const after = await seatStates(minted.hold_id);
    const held = after.length === before.length
      && after.length === SEATS.length
      && after.every((r) => r.state === "handed_off");
    held
      ? ok("and the seat is STILL HELD after that 409 — every row still handed_off")
      : bad("the 409 freed the seat anyway: " + JSON.stringify(after));

    const document = await getHold(db, minted.hold_id, CREDENTIAL);
    document.state === HOLD_STATE.handed_off
      ? ok("and the Hold is still handed_off, so the refusal transitioned nothing")
      : bad("the refusal moved the Hold to " + document.state);
  }

  /* 5 · A sold seat is not releasable either, and does not refuse. --------- */
  {
    const minted = await fresh(HOLD_STATE.claimed);
    const outcome = await releaseHold(db, minted.hold_id, CREDENTIAL);
    const seats = await seatStates(minted.hold_id);
    outcome.status === 204 && outcome.seats_freed === 0 && seats.every((r) => r.state === "claimed")
      ? ok("a claimed Hold answers 204 and keeps its seats for the life of the screening")
      : bad("releasing a claimed Hold freed " + outcome.seats_freed + " seats");
  }

  /* 6 · Z1 — and none of this is available to another credential. ---------- */
  {
    const minted = await fresh(HOLD_STATE.live);
    let refusal = null;
    try {
      await releaseHold(db, minted.hold_id, { agent_id: "agt_other", principal_scope: CREDENTIAL.principal_scope });
    } catch (err) {
      refusal = err;
    }
    const seats = await seatStates(minted.hold_id);
    refusal !== null && isRefusal(refusal) && refusal.code === "hold_not_found" && refusal.status === 404
      && seats.every((r) => r.state === "live")
      ? ok("another agent releasing this Hold is 404 hold_not_found, and the seats do not move")
      : bad("a second agent at the same site could act on the first agent Hold");
  }
} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err));
} finally {
  await db.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
