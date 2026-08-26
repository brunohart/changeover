// The fixture estate. Owner: CORE-001.
//
// GOLDEN_ESTATE is hand-written from the golden Occasions, so the first test
// here is the one that stops it drifting away from them. Everything downstream
// — the demo, the conformance report, every C-* class that needs a house — is
// seeded from this module, and an estate that quietly disagreed with the
// documents describing it would make every one of those runs a comparison
// between two different cinemas.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";

import { openDb } from "@changeover/store/db.ts";
import type { Db } from "@changeover/store/db.ts";
import { migrate } from "@changeover/store/migrate.ts";
import {
  GOLDEN_ESTATE,
  HUNDRED_SEAT_HOUSE,
  availableSeatIds,
  clearEstate,
  occasionSeedFromDocument,
  seatGrid,
  seedEstate,
} from "@changeover/store/fixtures.ts";

const GOLDEN_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "golden");

const db: Db = await openDb({ driver: "pglite" });
await migrate(db);
after(() => db.close());

async function goldenDocument(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(GOLDEN_DIR, name), "utf8"));
}

test("GOLDEN_ESTATE agrees with fixtures/golden, member for member", async () => {
  const files = [
    "occasion-embassy-sat-1900.json",
    "occasion-multiplex-sat-2100.json",
    "occasion-multiplex-sun-1400.json",
  ];
  assert.equal(GOLDEN_ESTATE.occasions.length, files.length);

  for (const file of files) {
    const doc = await goldenDocument(file);
    const seed = GOLDEN_ESTATE.occasions.find((o) => o.occasion_id === doc["occasion_id"]);
    assert.ok(seed, `${file}: no seed for ${doc["occasion_id"]}`);
    assert.equal(seed.etag, doc["etag"], `${file}: etag drifted`);
    assert.equal(seed.revision, doc["revision"], `${file}: revision drifted`);
    assert.equal(seed.origin, doc["venue"].origin, `${file}: origin drifted`);
    assert.equal(seed.capacity, doc["auditorium"].capacity, `${file}: capacity drifted`);
    assert.equal(seed.seating, doc["auditorium"].seating);
    assert.equal(seed.availability_mode, doc["availability"].mode);
    assert.equal(seed.starts_at, doc["instant"].starts_at);
    assert.equal(seed.local_wall, doc["instant"].local_wall);
    assert.equal(seed.local_wall_offset, doc["instant"].local_wall_offset);
    assert.equal(seed.sales_cutoff_at, doc["instant"].sales_cutoff_at ?? null);

    const available = seed.seats.filter((s) => s.status === "available").length;
    assert.equal(
      available,
      doc["availability"].seats_available,
      `${file}: the estate offers ${available} seats and the document claims ${doc["availability"].seats_available}`,
    );

    // showtime_ref is OPTIONAL and absent from every golden fixture, which is
    // exactly the case where SPEC.md:366's index over showtime_id and ADR-005's
    // index over occasion_id are the same index.
    assert.equal(doc["showtime_ref"], undefined, `${file}: showtime_ref appeared; revisit the fallback`);
    assert.equal(seed.showtime_id, seed.occasion_id);
  }
});

test("a seat grid offers exactly the seats it says it does, and is byte-identical run to run", () => {
  const a = seatGrid({ capacity: 168, per_row: 14, available: 141, wheelchair_every: 7 });
  const b = seatGrid({ capacity: 168, per_row: 14, available: 141, wheelchair_every: 7 });
  assert.deepEqual(a, b, "an estate that is not deterministic makes C-ATOMIC a statement about a coin");
  assert.equal(a.length, 168);
  assert.equal(a.filter((s) => s.status === "available").length, 141);
  assert.equal(a.filter((s) => s.status === "wheelchair").length, 2);
  assert.equal(a.filter((s) => s.status === "sold").length, 168 - 141 - 2);
  assert.equal(new Set(a.map((s) => s.seat_id)).size, 168, "seat ids must be unique: W2 has no legal duplicate");
});

test("row labels roll past Z rather than colliding", () => {
  const big = seatGrid({ capacity: 27 * 4, per_row: 4 });
  const rows = [...new Set(big.map((s) => s.seat_row))];
  assert.equal(rows[0], "A");
  assert.equal(rows[25], "Z");
  assert.equal(rows[26], "AA");
  assert.equal(new Set(big.map((s) => s.seat_id)).size, big.length);
});

test("the hundred-seat house of ADR-005 has a hundred free seats and no reason it should not", () => {
  const house = HUNDRED_SEAT_HOUSE.occasions[0]!;
  assert.equal(house.capacity, 100);
  assert.equal(house.seats.length, 100);
  assert.equal(house.seats.filter((s) => s.status === "available").length, 100);
  assert.deepEqual(availableSeatIds(house, 3), ["A:1", "A:2", "A:3"]);
});

test("seeding is idempotent — a second seed replaces the estate rather than doubling it", async () => {
  await seedEstate(db, GOLDEN_ESTATE);
  const first = await db.query<{ n: string }>("select count(*)::text as n from occasion_seat");
  await seedEstate(db, GOLDEN_ESTATE);
  const second = await db.query<{ n: string }>("select count(*)::text as n from occasion_seat");
  assert.equal(second.rows[0]?.n, first.rows[0]?.n);
  assert.equal(Number(first.rows[0]?.n), 754 + 168 + 168);

  const occasions = await db.query<{ n: string }>("select count(*)::text as n from occasion");
  assert.equal(Number(occasions.rows[0]?.n), 3);
});

test("a golden document seeds itself, document and all", async () => {
  await clearEstate(db, GOLDEN_ESTATE);
  const doc = await goldenDocument("occasion-embassy-sat-1900.json");
  const seed = occasionSeedFromDocument(doc, { cluster: "clu_the_conversation" });
  await seedEstate(db, { name: "one", occasions: [seed] });

  const row = await db.query<{ etag: string; capacity: number; cluster: string; document: unknown }>(
    "select etag, capacity, cluster, document from occasion where occasion_id = $1",
    [doc["occasion_id"]],
  );
  assert.equal(row.rows[0]?.etag, doc["etag"]);
  assert.equal(Number(row.rows[0]?.capacity), 754);
  assert.equal(row.rows[0]?.cluster, "clu_the_conversation");

  const stored = row.rows[0]?.document;
  const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
  assert.equal((parsed as Record<string, unknown>)["occasion_id"], doc["occasion_id"]);

  const seats = await db.query<{ n: string }>(
    "select count(*)::text as n from occasion_seat where occasion_id = $1 and status = $2",
    [doc["occasion_id"], "available"],
  );
  assert.equal(Number(seats.rows[0]?.n), doc["availability"].seats_available);
});
