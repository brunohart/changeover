/**
 * M1, M2, M3 and `get_hold`. CORE-003.
 *
 * The assertions here count columns and rows rather than reading the answer the
 * verb gave: a `state` that is right today because the derivation is right, and
 * a `state` that is right today because a column happened to be written, look
 * identical from the outside. Only one of them survives a reap running on
 * another connection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { HOLD_STATE, deriveState, derivedStateSql, heldUntil } from "../src/derived.ts";
import type { HoldState } from "../src/derived.ts";
import { getHold, loadHold } from "../src/get-hold.ts";
import { readTokenIsFresh } from "../src/read-token.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";
import { EVERY_STATE, bench, house, mintHold, seatRows } from "./lib/hold-fixtures.ts";

const CREDENTIAL = { agent_id: "agt_reference", principal_scope: "site_wellington" };

/* ── 1 · M1 as a pure function ─────────────────────────────────────────────── */

const T0 = "2026-08-29T19:00:00.000+12:00";
const T_LATER = "2026-08-29T19:10:00.000+12:00";
const T_MUCH_LATER = "2026-08-29T20:00:00.000+12:00";

test("M1 reports live only while server_time is before expires_at", () => {
  assert.equal(deriveState({ expires_at: T_LATER }, T0), HOLD_STATE.live);
  assert.equal(deriveState({ expires_at: T0 }, T_LATER), HOLD_STATE.expired);
});

test("M1 reports expired exactly at expires_at, not one millisecond after", () => {
  // `live if server_time < expires_at` is strict. A Hold whose deadline is this
  // instant has no time left in it, and a `<=` here would grant one more caller
  // a window the floor never promised.
  assert.equal(deriveState({ expires_at: T0 }, T0), HOLD_STATE.expired);
});

test("M1 walks the precedence in the specification's order", () => {
  const handed_off = {
    expires_at: T_LATER,
    handed_off_at: T0,
    claim_expires_at: T_MUCH_LATER,
  };
  assert.equal(deriveState(handed_off, T0), HOLD_STATE.handed_off);
  assert.equal(deriveState({ ...handed_off, claimed_at: T0 }, T0), HOLD_STATE.claimed);
  assert.equal(deriveState({ ...handed_off, claimed_at: T0, released_at: T0 }, T0), HOLD_STATE.released);
  assert.equal(
    deriveState({ ...handed_off, claimed_at: T0, released_at: T0, revoked_at: T0 }, T0),
    HOLD_STATE.revoked,
  );
});

test("a revoked hand-off is revoked, so an Operator Override is not overtaken by a deadline", () => {
  const row = { expires_at: T_LATER, handed_off_at: T0, claim_expires_at: T_MUCH_LATER, revoked_at: T0 };
  assert.equal(deriveState(row, T0), HOLD_STATE.revoked);
});

test("a handed-off Hold past claim_expires_at is expired, and cannot fall back into live", () => {
  const row = { expires_at: T_LATER, handed_off_at: T0, claim_expires_at: T_LATER };
  assert.equal(deriveState(row, T_MUCH_LATER), HOLD_STATE.expired);
});

test("T6: held_until is expires_at while live and claim_expires_at while handed off", () => {
  assert.equal(heldUntil({ expires_at: T_LATER }, T0), T_LATER);
  assert.equal(
    heldUntil({ expires_at: T_LATER, handed_off_at: T0, claim_expires_at: T_MUCH_LATER }, T0),
    T_MUCH_LATER,
  );
});

/* ── 2 · M1 against the store, with no reaper anywhere ─────────────────────── */

test("the hold table has no state column, so a stored state is unavailable rather than discouraged", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const result = await b.db.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_name = 'hold' and column_name = 'state'",
  );
  assert.equal(result.rows.length, 0);
});

test("a Hold past expires_at reports expired while its seat rows are still live", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.expired });

  // Nothing has reaped: the rows are physically present and still say `live`.
  const rows = await seatRows(b.db, minted.hold_id);
  assert.equal(rows.length, minted.seats.length);
  assert.ok(rows.every((row) => row.state === "live"));

  const document = await getHold(b.db, minted.hold_id, CREDENTIAL);
  assert.equal(document.state, HOLD_STATE.expired);

  // And still nothing has reaped. The read did not trigger one, and there is no
  // sweeper: correctness does not rest on either (ADR-006).
  const after = await seatRows(b.db, minted.hold_id);
  assert.deepEqual(after.map((row) => row.state), rows.map((row) => row.state));
});

test("M2: seats are reported in every state, including after a reap", async (t) => {
  const b = await bench();
  t.after(() => b.close());

  for (const state of EVERY_STATE) {
    for (const reaped of [false, true]) {
      await b.reset();
      const minted = await mintHold(b.db, { state, reaped });
      const document = await getHold(b.db, minted.hold_id, CREDENTIAL);
      assert.deepEqual(
        [...document.seats],
        [...minted.seats],
        `seats absent in ${state}${reaped ? " after a reap" : ""}`,
      );
      assert.ok(document.seats.length >= 1, "hold.schema.json requires minItems: 1");
    }
  }
});

test("every minted state reads back as itself", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  for (const state of EVERY_STATE) {
    await b.reset();
    const minted = await mintHold(b.db, { state });
    const document = await getHold(b.db, minted.hold_id, CREDENTIAL);
    assert.equal(document.state, state);
  }
});

/* ── 3 · M3: the SQL derivation and the TypeScript one agree ───────────────── */

test("M3: derivedStateSql computes what deriveState computes, row for row", async (t) => {
  const b = await bench();
  t.after(() => b.close());

  const seed = house();
  const expected = new Map<string, HoldState>();
  // One Occasion, one showtime, six Holds — each on its own pair of seats,
  // because `hold_seat_occupied` will not let two of them cover one seat and
  // that refusal is the floor doing its job, not the fixture being awkward.
  for (const [index, state] of EVERY_STATE.entries()) {
    const seats = seed.seats.slice(index * 2, index * 2 + 2).map((seat) => seat.seat_id);
    const minted = await mintHold(b.db, { state, occasion: seed, seats });
    expected.set(minted.hold_id, state);
  }

  const rows = await b.db.query<{ hold_id: string; sql_state: string }>(
    `select hold_id, ${derivedStateSql("hold")} as sql_state from hold`,
  );
  // `rowCount` is not usable here: PGlite reports `affectedRows: 0` for a
  // SELECT and the driver passes it through, so the row array is the count.
  assert.equal(rows.rows.length, expected.size);
  for (const row of rows.rows) {
    assert.equal(row.sql_state, expected.get(row.hold_id), `SQL disagreed for ${row.hold_id}`);
  }
});

test("M3: a live count over derived state stops counting an abandoned Hold at once", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  await mintHold(b.db, { state: HOLD_STATE.live, seats: ["A:1", "A:2"] });
  await mintHold(b.db, { state: HOLD_STATE.expired, seats: ["B:1", "B:2"] });

  const counted = await b.db.query<{ n: string }>(
    `select count(*)::text as n from hold where (${derivedStateSql("hold")}) = 'live'`,
  );
  assert.equal(Number(counted.rows[0]!.n), 1);
});

/* ── 4 · get_hold: the token, the cue marks, and Z1 ────────────────────────── */

test("get_hold mints a read_token that verifies against the row it wrote", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.live });
  const document = await getHold(b.db, minted.hold_id, CREDENTIAL);
  assert.ok(typeof document.read_token === "string" && document.read_token.length >= 22);

  const row = await loadHold(b.db, minted.hold_id, CREDENTIAL);
  assert.ok(
    readTokenIsFresh({
      hold_id: minted.hold_id,
      read_token: document.read_token,
      stored_hmac: row.read_token_hmac,
      read_token_at: row.read_token_at,
      server_time: document.server_time,
    }),
  );
  assert.notEqual(row.read_token_hmac, document.read_token, "the token itself must not be stored");
});

test("a read reports the cue marks and moves neither of them", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.live });
  const first = await getHold(b.db, minted.hold_id, CREDENTIAL);
  const second = await getHold(b.db, minted.hold_id, CREDENTIAL);

  assert.equal(second.floor_deadline, first.floor_deadline, "T3: floor_deadline is immovable");
  assert.equal(second.expires_at, first.expires_at, "a read is not an extension");
  assert.equal(second.extendable, false);
  assert.ok(Date.parse(second.server_time) >= Date.parse(first.server_time), "K6");
  assert.ok(Date.parse(first.expires_at) >= Date.parse(first.floor_deadline), "T2");
});

test("Z1: a second agent at the same site cannot read the first agent's Hold", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.live });

  for (const other of [
    { agent_id: "agt_other", principal_scope: CREDENTIAL.principal_scope },
    { agent_id: CREDENTIAL.agent_id, principal_scope: "site_auckland" },
  ]) {
    await assert.rejects(
      () => getHold(b.db, minted.hold_id, other),
      (err: unknown) => isRefusal(err) && err.code === "hold_not_found" && err.status === 404,
    );
  }
});

test("a Hold that does not exist and a Hold that is not yours refuse identically", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  await assert.rejects(
    () => getHold(b.db, "hold_00000000000000000000000000000000", CREDENTIAL),
    (err: unknown) => isRefusal(err) && err.code === "hold_not_found",
  );
});

test("X0: a credential with no principal scope is refused before any lookup", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  await assert.rejects(
    () => getHold(b.db, "hold_00000000000000000000000000000000", { agent_id: "agt_reference", principal_scope: "" }),
    (err: unknown) => isRefusal(err) && err.code === "principal_scope_missing",
  );
});

test("a revoked Hold reads back its reason rather than refusing the read", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.revoked });
  const document = await getHold(b.db, minted.hold_id, CREDENTIAL);
  assert.equal(document.state, HOLD_STATE.revoked);
  assert.equal(document.revocation_reason, "venue_operations");
});

test("a handed-off Hold omits the handoff object rather than emitting a partial one", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.handed_off });
  const document = await getHold(b.db, minted.hold_id, CREDENTIAL);
  assert.equal(document.state, HOLD_STATE.handed_off);
  // CL1 puts the claim URL in CORE-004's hands; `handoff` REQUIRES all four
  // members, so three of them is not a document this schema accepts.
  assert.equal(document.handoff, undefined);
});

test("the document carries no column that is not a member of hold.schema.json", async (t) => {
  const b = await bench();
  t.after(() => b.close());
  const minted = await mintHold(b.db, { state: HOLD_STATE.live });
  const document = await getHold(b.db, minted.hold_id, CREDENTIAL);
  const permitted = new Set([
    "changeover", "hold_id", "state", "occasion_id", "occasion_etag", "sought_occasion_id",
    "seats", "granted_at", "floor_ms", "floor_deadline", "expires_at", "extendable",
    "agent_id", "cluster", "read_token", "revocation_reason", "handoff", "server_time",
  ]);
  for (const member of Object.keys(document)) {
    assert.ok(permitted.has(member), `${member} is not a member of hold.schema.json`);
  }
  assert.equal((document as unknown as Record<string, unknown>).principal_scope, undefined);
  assert.equal((document as unknown as Record<string, unknown>).read_token_hmac, undefined);
});
