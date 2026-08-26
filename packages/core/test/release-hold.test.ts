/**
 * `release_hold` — total in five states, refusing in the sixth. CORE-003.
 *
 * R2's totality is asserted by calling the verb in every state R2 names and
 * insisting it did not throw; R1 is asserted by calling it in the state R1
 * names and then **counting the seat row**, because a 409 that had already
 * freed the seat would be a refusal the customer at the checkout could not tell
 * from a release.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { HOLD_STATE } from "../src/derived.ts";
import { getHold } from "../src/get-hold.ts";
import { releaseHold } from "../src/release-hold.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";
import { bench, house, mintHold, seatRows } from "./lib/hold-fixtures.ts";

const CREDENTIAL = { agent_id: "agt_reference", principal_scope: "site_wellington" };

/** R2's five. `handed_off` is deliberately absent; it has its own test. */
const TOTAL_IN = [
  HOLD_STATE.live,
  HOLD_STATE.released,
  HOLD_STATE.expired,
  HOLD_STATE.claimed,
  HOLD_STATE.revoked,
] as const;

test("R2: release_hold answers 204 in live, released, expired, claimed and revoked", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  for (const state of TOTAL_IN) {
    await b.reset();
    const minted = await mintHold(b.db, { state });
    const outcome = await releaseHold(b.db, minted.hold_id, CREDENTIAL);
    assert.equal(outcome.status, 204, `refused in ${state}`);
    assert.equal(outcome.state_before, state);
  }
});

test("R2: releasing twice is 204 twice, and does not re-date the first release", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.live });

  const first = await releaseHold(b.db, minted.hold_id, CREDENTIAL);
  assert.equal(first.state, HOLD_STATE.released);
  assert.ok(first.seats_freed > 0);

  const second = await releaseHold(b.db, minted.hold_id, CREDENTIAL);
  assert.equal(second.status, 204);
  assert.equal(second.state_before, HOLD_STATE.released);
  assert.equal(second.released_at, first.released_at, "the second release moved the first one");
  assert.equal(second.seats_freed, 0);
});

test("releasing a live Hold frees its seats, its cluster row and its budget slot", async (t) => {
  const seed = house({ occasion_id: "occ_cluster", cluster: "sat_evening_35mm" });
  const b = await bench([seed]);
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.live, occasion: seed, slot: 0 });

  const before = await seatRows(b.db, minted.hold_id);
  assert.ok(before.every((row) => row.state === "live"));

  await releaseHold(b.db, minted.hold_id, CREDENTIAL);

  const after = await seatRows(b.db, minted.hold_id);
  assert.ok(after.every((row) => row.state === "released"), "the seats still occupy");

  const cluster = await b.db.query<{ state: string }>(
    "select state from hold_cluster where hold_id = $1",
    [minted.hold_id],
  );
  assert.equal(cluster.rows[0]?.state, "released", "X2's cluster row still occupies");

  const slots = await b.db.query("select slot from hold_slot where hold_id = $1", [minted.hold_id]);
  assert.equal(slots.rows.length, 0, "X1's budget slot did not come back");
});

test("the freed seat is immediately re-holdable by another Hold", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.live });
  await releaseHold(b.db, minted.hold_id, CREDENTIAL);

  // `hold_seat_occupied` is a partial unique index over the occupying states.
  // If the release had merely marked the Hold and left the seat row occupying,
  // this second Hold on the same seats would be a 23505.
  const again = await mintHold(b.db, {
    state: HOLD_STATE.live,
    hold_id: "hold_0000000000000000000000000000000A",
    seats: minted.seats,
  });
  const rows = await seatRows(b.db, again.hold_id);
  assert.equal(rows.length, minted.seats.length);
});

test("releasing an expired Hold returns the seats without pretending it was released", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.expired, slot: 0 });

  const outcome = await releaseHold(b.db, minted.hold_id, CREDENTIAL);
  assert.equal(outcome.status, 204);
  assert.equal(outcome.state_before, HOLD_STATE.expired);
  // §4.9: `expired` + release_hold → *(no change)*. A Hold that ran out is
  // expired forever, and an operator reading the record later can still tell
  // abandonment from a clean release.
  assert.equal(outcome.state, HOLD_STATE.expired);
  assert.equal(outcome.released_at, null);

  const document = await getHold(b.db, minted.hold_id, CREDENTIAL);
  assert.equal(document.state, HOLD_STATE.expired);
  assert.deepEqual([...document.seats], [...minted.seats], "M2");

  const rows = await seatRows(b.db, minted.hold_id);
  assert.ok(rows.every((row) => row.state === "expired"), "the seats did not come back");
  const slots = await b.db.query("select slot from hold_slot where hold_id = $1", [minted.hold_id]);
  assert.equal(slots.rows.length, 0, "the budget did not come back with the seats");
});

test("R1: release on a handed-off Hold is 409 handoff_consumed and the seat stays held", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.handed_off });

  await assert.rejects(
    () => releaseHold(b.db, minted.hold_id, CREDENTIAL),
    (err: unknown) =>
      isRefusal(err) && err.code === "handoff_consumed" && err.status === 409 && err.remediation === "none",
  );

  const rows = await seatRows(b.db, minted.hold_id);
  assert.equal(rows.length, minted.seats.length);
  assert.ok(rows.every((row) => row.state === "handed_off"), "the 409 freed the seat anyway");

  const document = await getHold(b.db, minted.hold_id, CREDENTIAL);
  assert.equal(document.state, HOLD_STATE.handed_off, "the refusal transitioned the Hold");
});

test("R1 holds on every repeat: a second and third attempt refuse identically", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.handed_off });
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(
      () => releaseHold(b.db, minted.hold_id, CREDENTIAL),
      (err: unknown) => isRefusal(err) && err.code === "handoff_consumed",
    );
  }
  const rows = await seatRows(b.db, minted.hold_id);
  assert.ok(rows.every((row) => row.state === "handed_off"));
});

test("a claimed Hold answers 204 and keeps its seats for the life of the screening", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.claimed });

  const outcome = await releaseHold(b.db, minted.hold_id, CREDENTIAL);
  assert.equal(outcome.status, 204);
  assert.equal(outcome.state, HOLD_STATE.claimed);
  assert.equal(outcome.seats_freed, 0);

  const rows = await seatRows(b.db, minted.hold_id);
  assert.ok(rows.every((row) => row.state === "claimed"), "a sold seat was released");
});

test("Z1: another agent's release of this Hold is 404, never 403", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.live });

  await assert.rejects(
    () => releaseHold(b.db, minted.hold_id, { agent_id: "agt_other", principal_scope: CREDENTIAL.principal_scope }),
    (err: unknown) => isRefusal(err) && err.code === "hold_not_found" && err.status === 404,
  );

  // And the first agent's seats are exactly where they were. The draft's only
  // 403 was verb-level, so a second agent at the same site could release a
  // first agent's seats and take them.
  const rows = await seatRows(b.db, minted.hold_id);
  assert.ok(rows.every((row) => row.state === "live"));
});
