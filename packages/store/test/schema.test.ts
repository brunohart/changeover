// The constraints ARE the specification, here. Owner: CORE-001.
//
// Every test below provokes a write the schema must refuse. A rule that is only
// enforced in application code is a rule that holds until someone writes a
// second code path, and this project's whole claim is that its floor does not
// depend on anyone remembering.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { SQLSTATE, constraintName, openDb, sqlstate } from "@changeover/store/db.ts";
import type { Db } from "@changeover/store/db.ts";
import { migrate, resetHoldStore } from "@changeover/store/migrate.ts";
import { HUNDRED_SEAT_HOUSE, seedEstate } from "@changeover/store/fixtures.ts";
import { CONSTRAINT, SEAT_OCCUPYING_STATES, isLogIngestConflict } from "@changeover/store/schema.ts";

const OCCASION = HUNDRED_SEAT_HOUSE.occasions[0]!;
const AGENT = "agt_schema_test";
const PRINCIPAL = "ppid_schema_test";
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWX";

const db: Db = await openDb({ driver: "pglite" });
await migrate(db);
await seedEstate(db, HUNDRED_SEAT_HOUSE);
after(() => db.close());

let counter = 0;
/** A fresh hold_id of the shape Z2 requires: hold_ + 32 Crockford base32. */
function nextHoldId(): string {
  counter++;
  return "hold_" + ALPHABET + String(counter % 10) + String(Math.floor(counter / 10) % 10);
}

interface HoldOverrides {
  readonly hold_id?: string;
  readonly seats?: unknown;
  readonly floor_ms?: number;
  /** Seconds added to granted_at to reach floor_deadline. Default floor_ms/1000. */
  readonly floor_secs?: number;
  /** Seconds added to granted_at to reach expires_at. Default 600. */
  readonly expires_secs?: number;
  readonly cluster?: string | null;
  readonly principal_scope?: string;
}

async function insertHold(over: HoldOverrides = {}): Promise<string> {
  const id = over.hold_id ?? nextHoldId();
  const floorMs = over.floor_ms ?? 120000;
  await db.query(
    "insert into hold (hold_id, agent_id, principal_scope, origin, cluster, occasion_id, occasion_etag," +
      " sought_occasion_id, showtime_id, seats, granted_at, floor_ms, floor_deadline, expires_at)" +
      " select $1, $2, $3, $4, $5, $6, $7, $6, $6, $8, g, $9::int," +
      "        g + make_interval(secs => $10::float8), g + make_interval(secs => $11::float8)" +
      " from (select clock_timestamp() as g) t",
    [
      id,
      AGENT,
      over.principal_scope ?? PRINCIPAL,
      OCCASION.origin,
      over.cluster === undefined ? null : over.cluster,
      OCCASION.occasion_id,
      OCCASION.etag,
      over.seats === undefined ? ["A:1"] : over.seats,
      floorMs,
      over.floor_secs ?? floorMs / 1000,
      over.expires_secs ?? 600,
    ],
  );
  return id;
}

async function occupy(holdId: string, seatId: string, state: string): Promise<void> {
  await db.query(
    "insert into hold_seat (hold_id, occasion_id, showtime_id, seat_id, state, held_until)" +
      " values ($1, $2, $3, $4, $5, clock_timestamp() + make_interval(secs => 600))",
    [holdId, OCCASION.occasion_id, OCCASION.showtime_id, seatId, state],
  );
}

/** Runs `fn`, returning the SQLSTATE and constraint of the failure it must cause. */
async function refused(fn: () => Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await fn();
    return {};
  } catch (err) {
    return { code: sqlstate(err), constraint: constraintName(err) };
  }
}

// ---------------------------------------------------------------------------

test("no two holds may occupy one seat in ANY seat-occupying state — nine combinations", async () => {
  for (const held of SEAT_OCCUPYING_STATES) {
    for (const wanted of SEAT_OCCUPYING_STATES) {
      await resetHoldStore(db);
      const first = await insertHold();
      const second = await insertHold();
      await occupy(first, "B:1", held);
      const outcome = await refused(() => occupy(second, "B:1", wanted));
      assert.equal(outcome.code, SQLSTATE.unique_violation, `${held} → ${wanted} was permitted`);
      assert.equal(outcome.constraint, CONSTRAINT.hold_seat_occupied, `${held} → ${wanted} named the wrong constraint`);
    }
  }
});

test("a seat whose row is released, expired or revoked is free again — the index is genuinely partial", async () => {
  for (const spent of ["released", "expired", "revoked"]) {
    await resetHoldStore(db);
    const first = await insertHold();
    const second = await insertHold();
    await occupy(first, "B:2", spent);
    await occupy(second, "B:2", "live");
    const rows = await db.query<{ n: string }>(
      "select count(*)::text as n from hold_seat where seat_id = $1",
      ["B:2"],
    );
    assert.equal(Number(rows.rows[0]?.n), 2, `a ${spent} row must not occupy the seat`);
  }
});

test("floor_deadline that is not granted_at + floor_ms is unwritable (T1, T3)", async () => {
  const outcome = await refused(() => insertHold({ floor_ms: 120000, floor_secs: 300 }));
  assert.equal(outcome.code, SQLSTATE.check_violation);
  assert.equal(outcome.constraint, CONSTRAINT.hold_floor_derived);
});

test("expires_at below floor_deadline is unwritable — expires_at >= floor_deadline, always (T2)", async () => {
  const outcome = await refused(() => insertHold({ floor_ms: 120000, expires_secs: 60 }));
  assert.equal(outcome.code, SQLSTATE.check_violation);
  assert.equal(outcome.constraint, CONSTRAINT.hold_expiry_not_before_floor);
});

test("claim_expires_at below expires_at is unwritable — claim >= expires >= floor (T6)", async () => {
  await resetHoldStore(db);
  const id = await insertHold({ expires_secs: 600 });
  const outcome = await refused(() =>
    db.query(
      "update hold set handed_off_at = clock_timestamp(), handoff_floor_ms = 120000," +
        " claim_expires_at = granted_at + make_interval(secs => 300) where hold_id = $1",
      [id],
    ),
  );
  assert.equal(outcome.code, SQLSTATE.check_violation);
  assert.equal(outcome.constraint, CONSTRAINT.hold_claim_not_before_expiry);
});

test("a half-written hand-off is unwritable — all three members or none (T5, CL4)", async () => {
  await resetHoldStore(db);
  const id = await insertHold();
  const outcome = await refused(() =>
    db.query("update hold set handed_off_at = clock_timestamp() where hold_id = $1", [id]),
  );
  assert.equal(outcome.code, SQLSTATE.check_violation);
  assert.equal(outcome.constraint, "hold_handoff_complete");
});

test("a claim with no hand-off before it is unwritable (§4.9)", async () => {
  await resetHoldStore(db);
  const id = await insertHold();
  const outcome = await refused(() =>
    db.query("update hold set claimed_at = clock_timestamp() where hold_id = $1", [id]),
  );
  assert.equal(outcome.code, SQLSTATE.check_violation);
  assert.equal(outcome.constraint, "hold_claim_follows_handoff");
});

test("a revocation always carries a reason, and only one from the closed enum (T1a)", async () => {
  await resetHoldStore(db);
  const id = await insertHold();
  const reasonless = await refused(() =>
    db.query("update hold set revoked_at = clock_timestamp() where hold_id = $1", [id]),
  );
  assert.equal(reasonless.constraint, "hold_revocation_has_reason");

  const invented = await refused(() =>
    db.query("update hold set revoked_at = clock_timestamp(), revocation_reason = $2 where hold_id = $1", [
      id,
      "we_felt_like_it",
    ]),
  );
  assert.equal(invented.code, SQLSTATE.check_violation);

  await db.query(
    "update hold set revoked_at = clock_timestamp(), revocation_reason = $2 where hold_id = $1",
    [id, "session_cancelled"],
  );
  const stored = await db.query<{ revocation_reason: string }>(
    "select revocation_reason from hold where hold_id = $1",
    [id],
  );
  assert.equal(stored.rows[0]?.revocation_reason, "session_cancelled");
});

test("a ULID-shaped hold_id is unwritable — Z2 rejects a monotonic, guessable handle", async () => {
  const ulid = "hold_01J9ZQY7WKQ0V3B8N6M2D4T5X7";
  assert.equal(ulid.length - "hold_".length, 26, "the draft's pattern was 26 characters");
  const outcome = await refused(() => insertHold({ hold_id: ulid }));
  assert.equal(outcome.code, SQLSTATE.check_violation);
});

test("seats is 1..12 and carries no null — the wire cap, in the store (§2.6)", async () => {
  await resetHoldStore(db);
  const empty = await refused(() => insertHold({ seats: [] }));
  assert.equal(empty.code, SQLSTATE.check_violation, "an empty grant must be unwritable: minItems is 1");

  const thirteen = Array.from({ length: 13 }, (_v, i) => `C:${i + 1}`);
  const tooMany = await refused(() => insertHold({ seats: thirteen }));
  assert.equal(tooMany.code, SQLSTATE.check_violation, "13 seats must be unwritable: maxItems is 12");

  const withNull = await refused(() => insertHold({ seats: ["C:1", null] }));
  assert.equal(withNull.code, SQLSTATE.check_violation, "a null seat id must be unwritable");

  const twelve = await insertHold({ seats: thirteen.slice(0, 12) });
  const stored = await db.query<{ seats: string[] }>("select seats from hold where hold_id = $1", [twelve]);
  assert.equal(stored.rows[0]?.seats.length, 12);
});

test("a taken budget slot is a distinct constraint, so a 23505 is never misreported as seat_contended (X1)", async () => {
  await resetHoldStore(db);
  const first = await insertHold();
  const second = await insertHold();
  const take = (id: string, slot: number): Promise<unknown> =>
    db.query(
      "insert into hold_slot (agent_id, principal_scope, showtime_id, slot, hold_id) values ($1, $2, $3, $4, $5)",
      [AGENT, PRINCIPAL, OCCASION.showtime_id, slot, id],
    );
  await take(first, 0);
  const outcome = await refused(() => take(second, 0));
  assert.equal(outcome.code, SQLSTATE.unique_violation);
  assert.equal(outcome.constraint, CONSTRAINT.hold_slot);
  assert.notEqual(outcome.constraint, CONSTRAINT.hold_seat_occupied);

  // A different slot in the same showtime is fine; that is what a budget of 2 means.
  await take(second, 1);
});

test("idempotency is scoped to (agent_id, principal_scope, verb, key) and nothing else (I2)", async () => {
  await resetHoldStore(db);
  const digest = "A".repeat(43);
  const entry = (verb: string, key: string, principal: string): Promise<unknown> =>
    db.query(
      "insert into idempotency (agent_id, principal_scope, verb, idempotency_key_hmac, request_digest, status," +
        " created_at, retention_until) values ($1, $2, $3, $4, $5, $6, clock_timestamp(), clock_timestamp() + make_interval(secs => 86400))",
      [AGENT, principal, verb, key, digest, "in_flight"],
    );
  await entry("hold_seats", "k1", PRINCIPAL);

  const same = await refused(() => entry("hold_seats", "k1", PRINCIPAL));
  assert.equal(same.code, SQLSTATE.unique_violation);
  assert.equal(same.constraint, CONSTRAINT.idempotency_scope);

  // The same key under a different verb, or a different principal, is a
  // different operation. X0 rotates principal_scope per customer session.
  await entry("hand_off", "k1", PRINCIPAL);
  await entry("hold_seats", "k1", "ppid_someone_else");

  const stored = await refused(() =>
    db.query(
      "insert into idempotency (agent_id, principal_scope, verb, idempotency_key_hmac, request_digest, status," +
        " created_at, retention_until) values ($1, $2, $3, $4, $5, $6, clock_timestamp(), clock_timestamp())",
      [AGENT, PRINCIPAL, "release_hold", "k2", digest, "stored"],
    ),
  );
  assert.equal(stored.constraint, "idempotency_stored_has_record", "a stored entry with no response is not an entry");
});

test("the log's slot is derived from local wall time, never from UTC (§2.2, §5.4)", async () => {
  const insert = (date: string, wall: string, offset: string, key: string): Promise<unknown> =>
    db.query(
      "insert into changeover_log.access_log (local_wall_date, local_wall, local_wall_offset, observed_at," +
        " agent_id, principal_scope, verb, outcome, site_epoch_id, record_source, natural_key, input_watermark)" +
        " values ($1::date, $2, $3, clock_timestamp(), $4, $5, $6, $7, $8, $9, $10, clock_timestamp())",
      [date, wall, offset, AGENT, PRINCIPAL, "resolve_occasions", "ok", "epoch_1", "boundary", key],
    );
  const today = new Date().toISOString().slice(0, 10);

  await insert(today, `${today}T02:15`, "+13:00", "nk-slot-1");
  const slot = await db.query<{ local_wall_slot: number }>(
    "select local_wall_slot from changeover_log.access_log where natural_key = $1",
    ["nk-slot-1"],
  );
  assert.equal(
    Number(slot.rows[0]?.local_wall_slot),
    2,
    "a 02:15 local session belongs to the local 2am slot — in UTC+13 it is the previous UTC day",
  );

  const mismatched = await refused(() => insert("2026-01-01", `${today}T19:00`, "+12:00", "nk-slot-2"));
  assert.equal(mismatched.constraint, "access_log_partition_key_matches_wall");

  const malformed = await refused(() => insert(today, `${today} 19:00`, "+12:00", "nk-slot-3"));
  assert.equal(malformed.code, SQLSTATE.check_violation, "a local_wall without its T is not a local_wall");

  const badOffset = await refused(() => insert(today, `${today}T19:00`, "NZDT", "nk-slot-4"));
  assert.equal(badOffset.code, SQLSTATE.check_violation, "an offset must be numeric: a zone abbreviation is ambiguous");
});

test("log ingest is idempotent on (source, natural_key) INCLUDING the offset (§5.4)", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const insert = (offset: string): Promise<unknown> =>
    db.query(
      "insert into changeover_log.access_log (local_wall_date, local_wall, local_wall_offset, observed_at," +
        " agent_id, principal_scope, verb, outcome, site_epoch_id, record_source, natural_key, input_watermark)" +
        " values ($1::date, $2, $3, clock_timestamp(), $4, $5, $6, $7, $8, $9, $10, clock_timestamp())",
      [today, `${today}T02:00`, offset, AGENT, PRINCIPAL, "get_hold", "ok", "epoch_1", "boundary", "nk-fold"],
    );
  await insert("+13:00");
  // The fold: a marathon runs through 2am on the day the offset changes, and
  // the two 02:00 sessions are different sessions. Without the offset in the
  // key they collide and the log silently drops one.
  await insert("+12:00");

  // A partitioned table reports the PARTITION's index, not the parent
  // constraint, so `constraintName(err) === "access_log_ingest"` would silently
  // never match. isLogIngestConflict recognises it by shape, and the ordinary
  // handling is the ON CONFLICT below, which needs no name at all.
  let caught: unknown;
  try {
    await insert("+13:00");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "a repeated (source, natural_key, offset) must not ingest twice");
  assert.equal(sqlstate(caught), SQLSTATE.unique_violation);
  assert.notEqual(
    constraintName(caught),
    CONSTRAINT.access_log_ingest,
    "if this ever matches the parent name, simplify isLogIngestConflict",
  );
  assert.ok(isLogIngestConflict(caught), "the conflict must be recognisable without the parent constraint name");

  const swallowed = await db.query(
    "insert into changeover_log.access_log (local_wall_date, local_wall, local_wall_offset, observed_at," +
      " agent_id, principal_scope, verb, outcome, site_epoch_id, record_source, natural_key, input_watermark)" +
      " values ($1::date, $2, $3, clock_timestamp(), $4, $5, $6, $7, $8, $9, $10, clock_timestamp())" +
      " on conflict (local_wall_date, record_source, natural_key, local_wall_offset) do nothing",
    [today, `${today}T02:00`, "+13:00", AGENT, PRINCIPAL, "get_hold", "ok", "epoch_1", "boundary", "nk-fold"],
  );
  assert.equal(swallowed.rowCount, 0, "idempotent ingest is a no-op, not an error, on the ordinary path");
});

test("every input M1 derives state from is a column, and `state` itself is not", async () => {
  const r = await db.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = $1 and table_name = $2",
    ["public", "hold"],
  );
  const names = new Set(r.rows.map((row) => String(row.column_name)));
  for (const input of [
    "revoked_at",
    "released_at",
    "claimed_at",
    "handed_off_at",
    "claim_expires_at",
    "expires_at",
    "floor_deadline",
    "granted_at",
  ]) {
    assert.ok(names.has(input), `M1 needs ${input} and it is absent`);
  }
  assert.ok(!names.has("state"), "a stored state column is a lie the moment a reap runs elsewhere");
});
