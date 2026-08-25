/**
 * The three modules `hold_seats` is built on, at the unit. Owner: CORE-002.
 *
 * These are asserted here as well as in the proofs because a regression in
 * `compareC` or in the floor arithmetic is a deadlock or a short floor in
 * production, and neither announces itself. `npm test` should go red for it on
 * the same commit, not at the next conformance run.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SEAT_LOCK_SQL, compareC, lockSeats, sortCSeats } from "@changeover/core/locking.ts";
import {
  EXTENDABLE,
  GRANT_CLOCK,
  GRANT_CLOCK_SUBQUERY,
  HOLD_SCHEMA_MIN_FLOOR_MS,
  REAP_CLOCK,
  atOrAfter,
  elapsedMs,
  grantedExpiryMs,
  grantedFloorMs,
  rfc3339Column,
} from "@changeover/core/clock.ts";
import type { Queryable, QueryResult, Row } from "@changeover/store/db.ts";

/* ── locking ───────────────────────────────────────────────────────────────── */

test("compareC is byte order, which is what COLLATE \"C\" means and what Array.sort is not", () => {
  assert.ok(compareC("A:10", "A:2") < 0, "digits compare as bytes, so A:10 precedes A:2");
  assert.ok(compareC("A:1", "a:1") < 0, "upper case precedes lower case in ASCII");
  assert.ok(compareC("A:1", "A:1") === 0);

  // Above the BMP the two orders genuinely disagree. Array.sort compares UTF-16
  // code units, where a surrogate pair (0xD83D…) sits BELOW U+FFFD; in UTF-8
  // bytes the same character sits above it. Two nodes disagreeing about this is
  // the deadlock the C collation exists to prevent.
  const pair = ["\u{1F600}", "�"];
  assert.equal([...pair].sort()[0], "\u{1F600}", "UTF-16 code units put the astral character first");
  assert.equal(sortCSeats(pair)[0], "�", "UTF-8 bytes put it second, and bytes are what C means");
});

test("sortCSeats is total and never mutates what it was handed", () => {
  const requested = ["B:1", "A:10", "A:9", "A:2"];
  const copy = [...requested];
  assert.deepEqual(sortCSeats(requested), ["A:10", "A:2", "A:9", "B:1"]);
  assert.deepEqual(requested, copy, "the caller's array is the request, and a request is not scratch space");
});

test("lockSeats locks the full set, once each, in order, and returns the sequence it used", async () => {
  const sent: { sql: string; params?: readonly unknown[] }[] = [];
  const q: Queryable = {
    async query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      sent.push({ sql, params });
      return { rows: [] as T[], rowCount: 0 };
    },
    async exec() {},
  };

  const ordered = await lockSeats(q, "show_1", ["B:1", "A:10", "A:2"]);
  assert.deepEqual(ordered, ["A:10", "A:2", "B:1"]);
  assert.equal(sent.length, 3, "one lock per requested seat: there is no path that takes fewer");
  assert.ok(sent.every((s) => s.sql === SEAT_LOCK_SQL));
  assert.deepEqual(sent.map((s) => s.params?.[1]), ["A:10", "A:2", "B:1"]);
  assert.ok(sent.every((s) => s.params?.[0] === "show_1"), "keyed on the screening, not the listing");
});

test("an advisory lock is what is taken, because a free seat has no row to lock", () => {
  assert.match(SEAT_LOCK_SQL, /pg_advisory_xact_lock/);
  assert.doesNotMatch(SEAT_LOCK_SQL, /for\s+update/i, "SELECT … FOR UPDATE cannot lock a seat nobody holds");
});

/* ── clock ─────────────────────────────────────────────────────────────────── */

test("the two clocks are the two Postgres functions, spelled once each", () => {
  assert.equal(GRANT_CLOCK, "clock_timestamp()");
  assert.equal(REAP_CLOCK, "now()");
  assert.ok(GRANT_CLOCK_SUBQUERY.includes(GRANT_CLOCK));
  assert.doesNotMatch(GRANT_CLOCK_SUBQUERY, /\bnow\(\)/);
});

test("floor_ms is min(requested, policy_max), and X5's penalty is visible in the number", () => {
  assert.equal(grantedFloorMs(120000, 300000), 120000);
  assert.equal(grantedFloorMs(900000, 300000), 300000, "capped, not refused");
  assert.equal(grantedFloorMs(300000, 300000), 300000);
  assert.equal(grantedFloorMs(100000, 300000, 2500), 75000, "25% of a basis-point penalty");
  assert.equal(grantedFloorMs(100000, 300000, 0), 100000);
});

test("a floor the server cannot honour is null, never a short floor granted quietly", () => {
  assert.equal(grantedFloorMs(1000, 900), null, "below the schema's own minimum");
  assert.equal(grantedFloorMs(2000, 300000, 10000), null, "a full penalty leaves nothing to plan against");
  assert.equal(grantedFloorMs(HOLD_SCHEMA_MIN_FLOOR_MS, 300000), HOLD_SCHEMA_MIN_FLOOR_MS);
});

test("expires_at is never below the floor, and is raised to it rather than refused", () => {
  assert.equal(grantedExpiryMs(120000, undefined), 120000, "T2: the default expiry is the floor itself");
  assert.equal(grantedExpiryMs(120000, 300000), 300000);
  assert.equal(grantedExpiryMs(120000, 1000), 120000, "T2: an expiry below the floor is raised");
});

test("there is no extend verb, so extendable is a constant and not a decision", () => {
  assert.equal(EXTENDABLE, false);
});

test("elapsedMs reads offsets, because a bare Z-less string names no instant", () => {
  assert.equal(elapsedMs("2026-08-29T19:00:00+12:00", "2026-08-29T19:00:30+12:00"), 30000);
  // The same instant, written in two offsets. A parser that ignored the offset
  // would report twelve hours here.
  assert.equal(elapsedMs("2026-08-29T19:00:00+12:00", "2026-08-29T07:00:00+00:00"), 0);
  assert.equal(atOrAfter("2026-08-29T19:00:00+12:00", "2026-08-29T19:00:00+12:00"), true);
  assert.equal(atOrAfter("2026-08-29T19:00:01+12:00", "2026-08-29T19:00:00+12:00"), false);
  assert.throws(() => elapsedMs("not a time", "2026-08-29T19:00:00+12:00"));
});

test("a stored instant reaches the wire as RFC 3339 with its offset, projected by the store", () => {
  assert.equal(rfc3339Column("granted_at"), "to_json(granted_at)#>>'{}' as granted_at");
});
