/**
 * The adapter, end to end, and the report it makes about itself. Owner: ADAPT-001.
 *
 * One adapter is built for the whole file and shared. Building it measures the
 * floor, which costs a floor's worth of wall clock, and paying that once per
 * file rather than once per test is the difference between a suite people run
 * and a suite people skip.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { isRefusal } from "@changeover/schema/refusal.ts";
import { availableSeatIds } from "@changeover/store/fixtures.ts";
import { warrantableFloorMs } from "@changeover/adapter-reference/floor.ts";
import { unpublishedLimits } from "@changeover/adapter-reference/capability.ts";
import type { ReferenceAdapter } from "@changeover/adapter-reference/reference.ts";
import { createReferenceAdapter } from "@changeover/adapter-reference/reference.ts";
import {
  CONFORMANCE_CLASSES,
  reportConformance,
} from "@changeover/adapter-reference/classes.ts";
import {
  CAPABILITY_SCHEMA_ID,
  HOLD_SCHEMA_ID,
  OCCASION_SCHEMA_ID,
  SEATMAP_SCHEMA_ID,
  schemaValidator,
} from "./lib/schema-validator.ts";

const validate = schemaValidator();
const READER = { agent_id: "agt_reference_test", principal_scope: "prn_reference_test" };

let adapter: ReferenceAdapter;

before(async () => {
  adapter = await createReferenceAdapter({ measurement: { trials: 3 } });
});

after(async () => {
  await adapter.close();
});

/* ── identity ──────────────────────────────────────────────────────────────── */

test("the authoritative adapter declares Profile 1 over a store it owns", () => {
  assert.equal(adapter.profile, "1");
  assert.equal(adapter.hold_basis, "system_of_record");
  assert.equal(adapter.floor_basis, "owned_store");
});

/* ── the capability document ───────────────────────────────────────────────── */

test("the capability document validates and publishes only a floor it measured", async () => {
  const document = (await adapter.capability()) as Record<string, any>;
  assert.equal(validate(CAPABILITY_SCHEMA_ID, document), null);

  const evidence = await adapter.floorEvidence();
  assert.ok(evidence !== null);
  assert.ok(evidence.observations > 0);
  assert.deepEqual(document.floor_evidence, { ...evidence });
  assert.ok(
    document.hold_policy.policy_max_floor_ms <= warrantableFloorMs(evidence),
    "the published ceiling exceeds what the measurement warrants",
  );
  assert.deepEqual([...unpublishedLimits(document)], []);
  assert.deepEqual([...document.authorised_origins], [document.venue.origin]);
});

/* ── the read half ─────────────────────────────────────────────────────────── */

test("resolve_occasions pages, and every page member validates", async () => {
  const all = await adapter.resolveOccasions({}, READER);
  assert.equal(all.occasions.length, 3);
  assert.equal(all.next_cursor, undefined, "a last page carries no cursor to a page that is not there");
  for (const occasion of all.occasions) assert.equal(validate(OCCASION_SCHEMA_ID, occasion), null);

  const first = await adapter.resolveOccasions({ page_size: 2 }, READER);
  assert.equal(first.occasions.length, 2);
  assert.ok(typeof first.next_cursor === "string");
  const second = await adapter.resolveOccasions({ page_size: 2, cursor: first.next_cursor }, READER);
  assert.equal(second.occasions.length, 1);
  assert.equal(second.next_cursor, undefined);
});

test("a window wider than max_window_ms is refused rather than quietly truncated", async () => {
  await assert.rejects(
    () =>
      adapter.resolveOccasions(
        { window_start: "2026-01-01T00:00:00+12:00", window_end: "2027-01-01T00:00:00+12:00" },
        READER,
      ),
    (err: unknown) => isRefusal(err) && err.code === "window_too_wide",
  );
});

test("the read half is credentialed — an unauthenticated seat map is an enumeration of the house", async () => {
  const house = adapter.house;
  assert.ok(house !== null);
  for (const bad of [
    { agent_id: "agt_x", principal_scope: "" },
    { agent_id: "", principal_scope: "prn_x" },
  ]) {
    await assert.rejects(
      () => adapter.seatMap(house.occasion_id, bad),
      (err: unknown) =>
        isRefusal(err) && (err.code === "principal_scope_missing" || err.code === "not_authorised"),
    );
    await assert.rejects(() => adapter.resolveOccasions({}, bad), isRefusal);
  }
});

test("If-Match on one Occasion agrees on the unquoted etag, and a stale one is 412 occasion_moved", async () => {
  const page = await adapter.resolveOccasions({ page_size: 1 }, READER);
  const occasion = page.occasions[0] as { occasion_id: string; etag: string };

  const bare = await adapter.getOccasion(occasion.occasion_id, READER, { if_match: occasion.etag });
  assert.equal((bare as { etag: string }).etag, occasion.etag);
  // §6.3: ETag/If-Match carry the value as a quoted strong entity-tag and a
  // Server MUST strip the quotes before comparing.
  const quoted = await adapter.getOccasion(occasion.occasion_id, READER, {
    if_match: `"${occasion.etag}"`,
  });
  assert.equal((quoted as { etag: string }).etag, occasion.etag);

  await assert.rejects(
    () => adapter.getOccasion(occasion.occasion_id, READER, { if_match: "1:" + "A".repeat(43) }),
    (err: unknown) => isRefusal(err) && err.code === "occasion_moved",
  );
  await assert.rejects(
    () => adapter.getOccasion("occ_nobody_published_this", READER),
    (err: unknown) => isRefusal(err) && err.code === "occasion_not_found",
  );
});

test("the seat map validates and its ids are the ids hold_seats accepts", async () => {
  const house = adapter.house;
  assert.ok(house !== null);
  const before = (await adapter.seatMap(house.occasion_id, READER)) as {
    seats: { seat_id: string; status: string }[];
  };
  assert.equal(validate(SEATMAP_SCHEMA_ID, before), null);

  const seats = availableSeatIds(house, 2);
  const hold = await adapter.holdSeats(
    {
      occasion_id: house.occasion_id,
      occasion_etag: house.etag,
      sought: { occasion_id: house.occasion_id, occasion_etag: house.etag },
      seats,
      requested_floor_ms: 60000,
    },
    READER,
  );
  assert.deepEqual([...hold.seats], seats);

  const after = (await adapter.seatMap(house.occasion_id, READER)) as {
    seats: { seat_id: string; status: string }[];
  };
  for (const seat_id of seats) {
    assert.equal(
      after.seats.find((s) => s.seat_id === seat_id)?.status,
      "held",
      "a seat this boundary holds reads back held, not sold — W3 keeps the two facts apart",
    );
  }
  await adapter.releaseHold(hold.hold_id, READER);
});

/* ── the write half ────────────────────────────────────────────────────────── */

test("a Hold that asks for more floor than was measured is clamped, not refused and not granted", async () => {
  const house = adapter.house;
  const evidence = await adapter.floorEvidence();
  assert.ok(house !== null && evidence !== null);

  const hold = await adapter.holdSeats(
    {
      occasion_id: house.occasion_id,
      occasion_etag: house.etag,
      sought: { occasion_id: house.occasion_id, occasion_etag: house.etag },
      seats: availableSeatIds(house, 1),
      requested_floor_ms: 300000,
    },
    READER,
  );
  assert.equal(validate(HOLD_SCHEMA_ID, { ...hold }), null);
  assert.ok(hold.floor_ms <= warrantableFloorMs(evidence));
  assert.ok(Date.parse(hold.expires_at) >= Date.parse(hold.floor_deadline), "T2");
  assert.equal(hold.extendable, false);

  // T3: nothing moves the floor after the grant.
  const reread = await adapter.getHold(hold.hold_id, READER);
  assert.equal(reread.floor_ms, hold.floor_ms);
  assert.equal(reread.floor_deadline, hold.floor_deadline);

  // The hand-off is the only event that may extend the seats' held-until.
  const handed = await adapter.handOff(
    { hold_id: hold.hold_id, read_token: reread.read_token as string },
    READER,
  );
  assert.equal(handed.hold.state, "handed_off");
  assert.ok(handed.hold.handoff !== undefined);
  assert.ok(handed.hold.handoff.claim_url.startsWith("https://embassy.example/"), "O1");
  assert.ok(
    Date.parse(handed.hold.handoff.claim_expires_at) >= Date.parse(hold.expires_at),
    "T6: claim_expires_at is never below expires_at",
  );

  // R1: release after hand-off refuses and does NOT free the seat.
  await assert.rejects(
    () => adapter.releaseHold(hold.hold_id, READER),
    (err: unknown) => isRefusal(err) && err.code === "handoff_consumed",
  );
  const still = await adapter.db.query<{ n: string }>(
    "select count(*)::text as n from hold_seat where hold_id = $1 and state in ('live','handed_off','claimed')",
    [hold.hold_id],
  );
  assert.equal(Number(still.rows[0]?.n), 1);
});

test("an adapter that measured no floor refuses 503 floor_unavailable rather than picking a number", async () => {
  const unmeasured = await createReferenceAdapter({
    measure_floor: false,
    seed_published: false,
  });
  try {
    assert.equal(await unmeasured.floorEvidence(), null);
    assert.equal(unmeasured.policy, null);
    const house = unmeasured.house;
    assert.ok(house !== null);

    for (const call of [
      () => unmeasured.capability(),
      () =>
        unmeasured.holdSeats(
          {
            occasion_id: house.occasion_id,
            occasion_etag: house.etag,
            sought: { occasion_id: house.occasion_id, occasion_etag: house.etag },
            seats: availableSeatIds(house, 1),
            requested_floor_ms: 60000,
          },
          READER,
        ),
    ]) {
      await assert.rejects(
        call,
        (err: unknown) =>
          isRefusal(err) && err.code === "floor_unavailable" && typeof err.retry_after_ms === "number",
      );
    }
  } finally {
    await unmeasured.close();
  }
});

/* ── the report about itself ───────────────────────────────────────────────── */

test("the class report covers all twenty-four §7 classes and passes none it did not run", async () => {
  const report = await reportConformance(adapter);
  assert.equal(report.classes.length, 24);
  assert.equal(CONFORMANCE_CLASSES.length, 24);
  assert.equal(report.counts.fail, 0);
  assert.equal(report.counts.pass + report.counts.unprovable, 24);

  const runners = new Set(
    CONFORMANCE_CLASSES.filter((c) => typeof c.run === "function").map((c) => c.id),
  );
  for (const entry of report.classes) {
    if (entry.status === "pass") {
      assert.ok(runners.has(entry.class), `${entry.class} passed with no runner behind it`);
      assert.ok(entry.assertions.length > 0, `${entry.class} passed asserting nothing`);
      assert.equal(entry.reason, undefined);
    } else {
      assert.ok(
        (entry.reason ?? "").trim().length > 0,
        `${entry.class} is ${entry.status} and says nothing about why`,
      );
    }
  }
});

test("every class names §7's own words, and no class is both runnable and blocked", () => {
  const ids = CONFORMANCE_CLASSES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "a class id appears once");
  for (const entry of CONFORMANCE_CLASSES) {
    assert.match(entry.id, /^C-[A-Z0-9-]+$/);
    assert.ok(entry.spec_row.length > 20, `${entry.id} carries no §7 row`);
    assert.equal(
      (typeof entry.run === "function") === (entry.blocked_by !== undefined),
      false,
      `${entry.id} must have exactly one of run / blocked_by`,
    );
  }
});

test("C-AUTHZ is the class that ran, and Z1 is why", async () => {
  const report = await reportConformance(adapter);
  const authz = report.classes.find((c) => c.class === "C-AUTHZ");
  assert.equal(authz?.status, "pass");
  assert.ok(
    authz.assertions.some((a) => a.includes("hold_not_found")),
    "the point of Z1 is 404 and never 403, so the surface is not an existence oracle",
  );
  assert.ok(authz.assertions.some((a) => a.includes("byte-identical")));
});
