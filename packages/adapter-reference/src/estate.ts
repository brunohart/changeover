// The reference adapter's two houses. Owner: ADAPT-001.
//
// **This module writes no seeder.** `packages/store/src/fixtures.ts` is the one
// place an estate comes from — `seatGrid`, `occasionSeedFromDocument`,
// `seedEstate`, `clearEstate`, `availableSeatIds` — and everything here is a
// composition of those. A second seeder would mean the conformance report
// stopped comparing like with like the first time the two drifted, and drift
// between two seeders is invisible until the numbers disagree.
//
// There are two houses because they answer two different questions.
//
//   **The published house** is the three golden Occasions, whose etags are
//   frozen and cross-checked by `prove_etag_golden.sh`. It is what
//   `resolve_occasions` returns, and it is the only house whose Occasions carry
//   a `document` — because a published Occasion's etag is a digest over
//   PROJECTION_0_1 and this package cannot mint one (the harness projector is
//   `scripts/lib/project.mjs`, which no implementation may import, and
//   `@changeover/schema` has no projector yet).
//
//   **The measurement house** is where the floor is measured and where the
//   in-process conformance classes grant. It is dated RELATIVE TO NOW, which is
//   not a convenience: the golden Occasions carry `sales_cutoff_at` on
//   2026-08-29, and G1 step 6 refuses `past_sales_cutoff` after it. A
//   measurement that could only be taken before a fixed date is a measurement
//   that expires, and §7's whole point is a series that does not.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Estate, OccasionSeed, SeatSeed } from "@changeover/store/fixtures.ts";
import { GOLDEN_ESTATE, occasionSeedFromDocument, seatGrid } from "@changeover/store/fixtures.ts";
import { localWallAt } from "@changeover/core/access-log.ts";
import type { Rfc3339 } from "@changeover/schema/scalars.ts";

/* ── 1 · The site ──────────────────────────────────────────────────────────── */

/**
 * One site, one origin. O1 makes every absolute URL in every emitted document
 * same-origin with this, and the capability document's `authorised_origins`
 * is the list a delegation would extend — not a wildcard.
 */
export const REFERENCE_ORIGIN = "https://embassy.example";
export const REFERENCE_TIMEZONE = "Pacific/Auckland";
export const REFERENCE_VENUE_ID = "ven_embassy";
export const REFERENCE_VENUE_NAME = "Embassy Theatre";
export const REFERENCE_LOCALITY = "Wellington";

/* ── 2 · The published house ───────────────────────────────────────────────── */

const GOLDEN_FIXTURE_FILES: readonly string[] = Object.freeze([
  "occasion-embassy-sat-1900.json",
  "occasion-multiplex-sat-2100.json",
  "occasion-multiplex-sun-1400.json",
]);

/** `fixtures/golden/` — three directories up from `packages/adapter-reference/src`. */
export const GOLDEN_DIR: string = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));

/**
 * The golden three, as an estate whose Occasions carry their published document.
 *
 * `GOLDEN_ESTATE` supplies the seat inventory, unchanged, so the two do not
 * describe two different houses; `occasionSeedFromDocument` supplies everything
 * else from the published bytes. Reading the fixture rather than restating it
 * means a fixture that moved would be caught here rather than agreed with.
 */
export async function publishedEstate(): Promise<Estate> {
  const occasions: OccasionSeed[] = [];
  for (const file of GOLDEN_FIXTURE_FILES) {
    const document = JSON.parse(await readFile(GOLDEN_DIR + file, "utf8")) as Record<string, unknown>;
    const golden = GOLDEN_ESTATE.occasions.find((o) => o.occasion_id === document["occasion_id"]);
    if (golden === undefined) {
      throw new Error(`adapter-reference: fixtures/golden/${file} names an Occasion GOLDEN_ESTATE does not`);
    }
    occasions.push(occasionSeedFromDocument(document, { cluster: golden.cluster, seats: golden.seats }));
  }
  return { name: "reference-published", occasions };
}

/* ── 3 · The measurement house ─────────────────────────────────────────────── */

export interface MeasurementHouseOptions {
  /** Total seats. 40 is enough to contend over and small enough to seed in a blink. */
  readonly capacity?: number;
  /** How far ahead the screening starts. Must exceed the whole measurement window. */
  readonly starts_in_ms?: number;
  /** How long after `starts_at` the house closes for sale. */
  readonly sales_cutoff_after_ms?: number;
  /** A stable id, where a caller wants two runs to reuse one house. */
  readonly occasion_id?: string;
}

export interface MeasurementHouse {
  readonly estate: Estate;
  readonly occasion: OccasionSeed;
  readonly seats: readonly SeatSeed[];
}

/**
 * A dated house whose Occasion is always ahead of the clock that seeds it.
 *
 * The etag here is **not** a PROJECTION_0_1 digest and this house publishes no
 * document, because nothing in this package can honestly compute one. It is an
 * opaque value of the right shape, minted per house, so that the grant path's
 * etag guard has a real thing to agree with rather than a constant every run
 * shares — an etag two runs share is an etag that cannot detect a stale read.
 */
export function measurementHouse(now: Rfc3339, options: MeasurementHouseOptions = {}): MeasurementHouse {
  const capacity = options.capacity ?? 40;
  const starts_in_ms = options.starts_in_ms ?? 3_600_000;
  const cutoff_after_ms = options.sales_cutoff_after_ms ?? 900_000;

  const started = new Date(new Date(now).getTime() + starts_in_ms);
  if (Number.isNaN(started.getTime())) {
    throw new TypeError(`adapter-reference: measurementHouse was handed a non-instant: ${now}`);
  }
  const wall = localWallAt(started, REFERENCE_TIMEZONE);
  const starts_at = `${wall.local_wall}:00${wall.local_wall_offset}`;
  const cutoff = localWallAt(new Date(new Date(starts_at).getTime() + cutoff_after_ms), REFERENCE_TIMEZONE);

  const occasion_id = options.occasion_id ?? `occ_reference_measure_${randomUUID().replace(/-/g, "")}`;
  const seats = seatGrid({ capacity, per_row: 10 });

  const occasion: OccasionSeed = {
    occasion_id,
    revision: 1,
    etag: syntheticEtag(occasion_id),
    origin: REFERENCE_ORIGIN,
    source: "reference",
    // No `showtime_ref` is published for this house, so the screening key is
    // the Occasion's own id — which is the identity that makes SPEC.md §4.6's
    // index over (showtime_id, seat_id) and the single-listing case agree.
    showtime_id: occasion_id,
    // In no cluster: X2's fan-out ceiling is a real limit and a measurement
    // that tripped it would be measuring the ceiling, not the floor.
    cluster: null,
    seating: "allocated",
    capacity,
    availability_mode: "seat_map",
    starts_at,
    local_wall: wall.local_wall,
    local_wall_offset: wall.local_wall_offset,
    sales_cutoff_at: `${cutoff.local_wall}:00${cutoff.local_wall_offset}`,
    seats,
  };

  return { estate: { name: "reference-measurement", occasions: [occasion] }, occasion, seats };
}

/** `1:` plus 43 base64url characters — the shape the column's CHECK requires. */
function syntheticEtag(seed: string): string {
  const bytes = Buffer.alloc(32);
  Buffer.from(seed, "utf8").copy(bytes);
  // A per-house nonce, so two houses built from one id in one process still
  // differ. The value carries no meaning and MUST NOT be parsed (Z3).
  Buffer.from(randomUUID().replace(/-/g, ""), "hex").copy(bytes, 16);
  return `1:${bytes.toString("base64url")}`;
}
