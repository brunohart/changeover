/**
 * The measurement itself, against a real store. Owner: ADAPT-001.
 *
 * The arithmetic is unit-tested in `capability-document.test.ts`; what is under
 * test here is the *observation* — that the trials really grant, that the seats
 * really stay, and that a floor the store could not honour would come back as a
 * violation rather than as a smaller number nobody notices.
 *
 * These tests take real wall-clock time and that is not incidental. A retention
 * measurement that did not wait would be a measurement of nothing, and the one
 * shortcut available — asserting the arithmetic and skipping the wait — is the
 * shortcut that turns §7's warranty back into an assertion.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { openDb } from "@changeover/store/db.ts";
import { migrate } from "@changeover/store/migrate.ts";
import { seedEstate } from "@changeover/store/fixtures.ts";
import { serverTime } from "@changeover/core/clock.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import { measurementHouse, publishedEstate } from "@changeover/adapter-reference/estate.ts";
import {
  DEFAULT_PROBE_FLOOR_MS,
  FloorNotWarranted,
  floorIsWarranted,
  measureRetention,
  warrantableFloorMs,
} from "@changeover/adapter-reference/floor.ts";

test("a measurement is observations of a store, not a restatement of the request", async () => {
  const db = await openDb();
  try {
    await migrate(db);
    const { evidence, warrantable_floor_ms, trials } = await measureRetention(db, { trials: 4 });

    assert.equal(evidence.observations, 4);
    assert.equal(trials.length, 4);
    assert.equal(evidence.violations, 0, "at floor_basis owned_store, one violation is a hard fail");

    // The window is the store's clock, in order, and it actually spans the floor.
    assert.ok(Date.parse(evidence.window_end) > Date.parse(evidence.window_start));
    assert.ok(
      Date.parse(evidence.window_end) - Date.parse(evidence.window_start) >= DEFAULT_PROBE_FLOOR_MS - 200,
      "the window must span the floor it was measuring, or nothing was observed",
    );

    // Every trial probed more than once — a single probe would be a grant, not
    // an observation of retention.
    for (const trial of trials) {
      assert.ok(trial.probes > 1, `trial ${trial.hold_id} took ${trial.probes} probe(s)`);
      assert.ok(trial.observed_retention_ms > 0);
      assert.equal(trial.violated, false);
    }

    // §7's inequality, on the numbers this run actually produced.
    assert.equal(warrantable_floor_ms, evidence.min_observed_retention_ms - evidence.safety_margin_ms);
    assert.ok(floorIsWarranted(warrantable_floor_ms, evidence));
    assert.ok(!floorIsWarranted(warrantable_floor_ms + 1, evidence));
  } finally {
    await db.close();
  }
});

test("the observed retention is bounded by the probe cadence, and is never invented above the floor", async () => {
  const db = await openDb();
  try {
    await migrate(db);
    const { evidence, trials } = await measureRetention(db, { trials: 2, probe_interval_ms: 50 });
    for (const trial of trials) {
      // Retention is measured to the last instant the seat was SEEN held, so it
      // sits at or below the floor by up to one cadence — never above it, which
      // is what a number copied from the request would look like.
      assert.ok(
        trial.observed_retention_ms <= trial.floor_ms,
        `${trial.observed_retention_ms} exceeds the ${trial.floor_ms}ms floor it was granted`,
      );
      assert.ok(
        trial.observed_retention_ms >= trial.floor_ms - 400,
        `${trial.observed_retention_ms} is far below the ${trial.floor_ms}ms floor — the seat went early`,
      );
    }
    assert.ok(evidence.min_observed_retention_ms <= DEFAULT_PROBE_FLOOR_MS);
  } finally {
    await db.close();
  }
});

test("a floor too short to warrant hold.schema.json's minimum refuses rather than publishes", async () => {
  const db = await openDb();
  try {
    await migrate(db);
    await assert.rejects(
      () => measureRetention(db, { trials: 1, probe_floor_ms: 1000, safety_margin_ms: 500 }),
      (err: unknown) => err instanceof FloorNotWarranted && err.warrantable_floor_ms < 1000,
    );
    // …and the same measurement is still available to a caller who wants the
    // evidence without the warranty, which is what a 503 floor_unavailable
    // Server needs in order to say honestly why it is refusing.
    const unwarranted = await measureRetention(db, {
      trials: 1,
      probe_floor_ms: 1000,
      safety_margin_ms: 500,
      require_warrantable: false,
    });
    assert.equal(unwarranted.evidence.observations, 1);
    assert.ok(unwarranted.warrantable_floor_ms < 1000);
  } finally {
    await db.close();
  }
});

test("zero observations warrant zero, and the arithmetic never goes negative", () => {
  assert.equal(
    warrantableFloorMs({
      observations: 0,
      window_start: "2026-08-25T09:00:00+12:00",
      window_end: "2026-08-25T09:00:00+12:00",
      min_observed_retention_ms: 999999,
      safety_margin_ms: 0,
      violations: 0,
    }),
    0,
    "a number with no observation behind it warrants nothing, however large",
  );
  assert.equal(
    warrantableFloorMs({
      observations: 3,
      window_start: "2026-08-25T09:00:00+12:00",
      window_end: "2026-08-25T09:00:03+12:00",
      min_observed_retention_ms: 100,
      safety_margin_ms: 5000,
      violations: 0,
    }),
    0,
  );
});

test("the measurement gives the seats back, so the next one is not a measurement of contention", async () => {
  const db = await openDb();
  try {
    await migrate(db);
    const before = await serverTime(db);
    const house = measurementHouse(before, { capacity: 12 });
    await seedEstate(db, house.estate);

    await measureRetention(db, { trials: 3, occasion: house.occasion });
    const live = await db.query<{ n: string }>(
      "select count(*)::text as n from hold_seat where showtime_id = $1 and state in ('live','handed_off','claimed')",
      [house.occasion.showtime_id],
    );
    assert.equal(Number(live.rows[0]?.n), 0, "every measured Hold was released");

    // And the seats hold again, which is the property that matters.
    const seat = house.seats[0]!.seat_id;
    const regrant = await holdSeats(
      db,
      {
        occasion_id: house.occasion.occasion_id,
        occasion_etag: house.occasion.etag,
        sought: { occasion_id: house.occasion.occasion_id, occasion_etag: house.occasion.etag },
        seats: [seat],
        requested_floor_ms: 1000,
      },
      { agent_id: "agt_after_measure", principal_scope: "prn_after_measure" },
    );
    assert.deepEqual([...regrant.seats], [seat]);
  } finally {
    await db.close();
  }
});

test("the measurement house is always ahead of the clock that seeded it", async () => {
  const db = await openDb();
  try {
    await migrate(db);
    const now = await serverTime(db);
    const house = measurementHouse(now);
    assert.ok(
      Date.parse(house.occasion.starts_at) > Date.parse(now),
      "a house that has already started would refuse past_sales_cutoff and the measurement would expire with the fixture",
    );
    assert.ok(Date.parse(house.occasion.sales_cutoff_at as string) > Date.parse(house.occasion.starts_at));
    assert.match(house.occasion.etag, /^1:[A-Za-z0-9_-]{43}$/);
    assert.equal(house.occasion.document, undefined, "an unpublished house publishes no document");
  } finally {
    await db.close();
  }
});

test("the published house is the golden three, with their frozen etags and their own seats", async () => {
  const db = await openDb();
  try {
    await migrate(db);
    const estate = await publishedEstate();
    assert.equal(estate.occasions.length, 3);
    for (const occasion of estate.occasions) {
      assert.match(occasion.etag, /^1:[A-Za-z0-9_-]{43}$/);
      assert.ok(occasion.document !== undefined, "the published house carries the published bytes");
      assert.equal((occasion.document as { etag: string }).etag, occasion.etag);
      assert.equal(occasion.seats.length, occasion.capacity);
    }
    const seeded = await seedEstate(db, estate);
    assert.equal(seeded.occasions, 3);
    assert.equal(seeded.seats, 754 + 168 + 168);
  } finally {
    await db.close();
  }
});
