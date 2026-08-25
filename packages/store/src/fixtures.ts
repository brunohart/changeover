// The fixture estate. Owner: CORE-001.
//
// Every later item needs a house to hold seats in, and if each one invents its
// own the conformance report stops comparing like with like. This module is the
// single place an estate comes from: DEMO-001's cold start, the conformance
// harness, and the store's own tests all seed from here.
//
// An estate is the exhibitor's side of the boundary, not CHANGEOVER's. It is
// the Occasions and the seat inventory those Occasions are published against —
// W1's "auditorium's own seat inventory", W3's "exhibitor's system of record".
// The reference implementation is Profile 1 (`hold_basis: system_of_record`),
// so for it that record is two tables in this database, and `changeover_agent`
// can read them and cannot write them. Profile 1S puts a CMS there instead
// (ADR-008) and an adapter answers.
//
// Nothing in an estate names a person. Seats have ids, sections, rows and
// numbers; nobody sits in them until the exhibitor's own checkout says so, and
// that moment is outside this boundary by construction (ADR-001).

import type { Db, Queryable } from "./db.ts";
import type { SeatStatus } from "./schema.ts";

export interface SeatSeed {
  readonly seat_id: string;
  readonly section?: string | null;
  readonly seat_row?: string | null;
  readonly seat_number?: number | null;
  readonly status: SeatStatus;
  readonly adjacency_group?: string | null;
}

export interface OccasionSeed {
  readonly occasion_id: string;
  readonly revision: number;
  readonly etag: string;
  /** venue.origin as an O1 bare origin. */
  readonly origin: string;
  /** showtime_ref.source, or "reference" where the publisher omits showtime_ref. */
  readonly source: string;
  /** showtime_ref.showtime_id, or occasion_id where the publisher omits it. */
  readonly showtime_id: string;
  /** X2's fan-out key, with origin. Null means this Occasion is in no cluster. */
  readonly cluster: string | null;
  readonly seating: "allocated" | "unallocated" | "unknown";
  readonly capacity: number;
  readonly availability_mode: "seat_map" | "count" | "unknown";
  readonly starts_at: string;
  readonly local_wall: string;
  readonly local_wall_offset: string;
  readonly sales_cutoff_at: string | null;
  readonly withdrawn?: boolean;
  /** The Occasion exactly as published, or null. Read-side only. */
  readonly document?: unknown;
  readonly seats: readonly SeatSeed[];
}

export interface Estate {
  readonly name: string;
  readonly occasions: readonly OccasionSeed[];
}

export interface SeededEstate {
  readonly occasions: number;
  readonly seats: number;
}

// ---------------------------------------------------------------------------
// Building an estate
// ---------------------------------------------------------------------------

export interface SeatGridOptions {
  readonly capacity: number;
  /** Seats per row. Default 20. The last row is short where it does not divide. */
  readonly per_row?: number;
  /**
   * How many seats end up `available`. Default: all of them that are not
   * wheelchair spaces. The shortfall becomes `sold`, in row order,
   * deterministically — gone for a reason that is not a CHANGEOVER Hold, which
   * W3 makes `409 seat_unavailable` and the exhibitor's fact, not the
   * boundary's.
   *
   * Stated as `available` rather than as `sold` so that a caller can pass an
   * Occasion's own `availability.seats_available` straight through and have the
   * estate agree with the document that describes it.
   */
  readonly available?: number;
  /** Every Nth seat of the last row is a wheelchair space. 0 disables. */
  readonly wheelchair_every?: number;
}

/**
 * A deterministic allocated house. `F:11` is the seat-id shape SPEC.md uses;
 * rows run A, B, … Z, AA, AB, and numbers run from 1 within a row.
 *
 * Deterministic matters more than realistic: two conformance runs over the same
 * estate must contend over the same seats, or C-ATOMIC's "exactly 100 succeed"
 * is a statement about a coin.
 */
export function seatGrid(options: SeatGridOptions): SeatSeed[] {
  const perRow = options.per_row ?? 20;
  const wheelchairEvery = options.wheelchair_every ?? 0;
  const lastRowIndex = Math.floor((options.capacity - 1) / perRow);

  const isWheelchair = (rowIndex: number, number: number): boolean =>
    wheelchairEvery > 0 && rowIndex === lastRowIndex && number % wheelchairEvery === 0;

  let wheelchairSeats = 0;
  for (let i = 0; i < options.capacity; i++) {
    if (isWheelchair(Math.floor(i / perRow), (i % perRow) + 1)) wheelchairSeats++;
  }
  const holdable = options.capacity - wheelchairSeats;
  const available = Math.max(0, Math.min(holdable, options.available ?? holdable));
  let sold = holdable - available;

  const seats: SeatSeed[] = [];
  for (let i = 0; i < options.capacity; i++) {
    const rowIndex = Math.floor(i / perRow);
    const number = (i % perRow) + 1;
    const row = rowLabel(rowIndex);
    let status: SeatStatus = "available";
    if (isWheelchair(rowIndex, number)) {
      status = "wheelchair";
    } else if (sold > 0) {
      status = "sold";
      sold--;
    }
    seats.push({
      seat_id: `${row}:${number}`,
      section: rowIndex < 3 ? "front" : "stalls",
      seat_row: row,
      seat_number: number,
      status,
      adjacency_group: row,
    });
  }
  return seats;
}

function rowLabel(index: number): string {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * An `OccasionSeed` from a published Occasion document.
 *
 * This is how DEMO-001 and the conformance harness turn `fixtures/golden/*.json`
 * into a seedable estate without this package taking a dependency on the
 * repository's directory layout. `showtime_ref` is OPTIONAL on the wire and
 * absent from all three golden fixtures, so where it is missing showtime_id
 * falls back to occasion_id — which is also what makes SPEC.md:366 (the index
 * over showtime_id) and ADR-005 (the index over occasion_id) name one index.
 */
export function occasionSeedFromDocument(
  document: unknown,
  extra: { cluster?: string | null; seats?: readonly SeatSeed[] } = {},
): OccasionSeed {
  const doc = document as Record<string, any>;
  const capacity = Number(doc["auditorium"]?.capacity ?? 0);
  const available = Number(doc["availability"]?.seats_available ?? capacity);
  return {
    occasion_id: String(doc["occasion_id"]),
    revision: Number(doc["revision"] ?? 1),
    etag: String(doc["etag"]),
    origin: String(doc["venue"]?.origin ?? ""),
    source: String(doc["showtime_ref"]?.source ?? "reference"),
    showtime_id: String(doc["showtime_ref"]?.showtime_id ?? doc["occasion_id"]),
    cluster: extra.cluster === undefined ? null : extra.cluster,
    seating: doc["auditorium"]?.seating ?? "allocated",
    capacity,
    availability_mode: doc["availability"]?.mode ?? "unknown",
    starts_at: String(doc["instant"]?.starts_at),
    local_wall: String(doc["instant"]?.local_wall),
    local_wall_offset: String(doc["instant"]?.local_wall_offset),
    sales_cutoff_at: doc["instant"]?.sales_cutoff_at ?? null,
    document,
    seats: extra.seats ?? seatGrid({ capacity, available }),
  };
}

// ---------------------------------------------------------------------------
// The two standing estates
// ---------------------------------------------------------------------------

const GOLDEN_CLUSTER = "clu_the_conversation";

/**
 * The three golden Occasions, as an estate.
 *
 * ids, etags, capacities and instants are those of `fixtures/golden/*.json`,
 * which are frozen and cross-checked by `prove_etag_golden.sh`. A test in this
 * package asserts the two agree, so this constant cannot drift away from them
 * quietly.
 *
 * All three carry one cluster. They are the same work at one origin on one
 * weekend, in three presentations — which is exactly the shape X2 exists for,
 * and exactly the shape §2.3's non-substitutability assertions exist for.
 */
export const GOLDEN_ESTATE: Estate = {
  name: "golden",
  occasions: [
    {
      occasion_id: "occ_embassy_20260829T1900_s1",
      revision: 4,
      etag: "1:XB7PZvK6GJP0BY4IPzKdmuCc-R5RaivznwPz_KDY-04",
      origin: "https://embassy.example",
      source: "reference",
      showtime_id: "occ_embassy_20260829T1900_s1",
      cluster: GOLDEN_CLUSTER,
      seating: "allocated",
      capacity: 754,
      availability_mode: "seat_map",
      starts_at: "2026-08-29T19:00:00+12:00",
      local_wall: "2026-08-29T19:00",
      local_wall_offset: "+12:00",
      sales_cutoff_at: "2026-08-29T19:15:00+12:00",
      seats: seatGrid({ capacity: 754, per_row: 26, available: 212, wheelchair_every: 13 }),
    },
    {
      occasion_id: "occ_multiplex_20260829T2100_s4",
      revision: 2,
      etag: "1:ktjR8_5bWWg_lejnE6BqPSaNzXSyCzYynsci_O9_Qr4",
      origin: "https://embassy.example",
      source: "reference",
      showtime_id: "occ_multiplex_20260829T2100_s4",
      cluster: GOLDEN_CLUSTER,
      seating: "allocated",
      capacity: 168,
      availability_mode: "seat_map",
      starts_at: "2026-08-29T21:00:00+12:00",
      local_wall: "2026-08-29T21:00",
      local_wall_offset: "+12:00",
      sales_cutoff_at: "2026-08-29T21:15:00+12:00",
      seats: seatGrid({ capacity: 168, per_row: 14, available: 141, wheelchair_every: 7 }),
    },
    {
      occasion_id: "occ_multiplex_20260830T1400_s4",
      revision: 2,
      etag: "1:9MokuOSTWVJ-_t1IMbm7cfT61VjN3kfb3yDZtK6UJJ4",
      origin: "https://embassy.example",
      source: "reference",
      showtime_id: "occ_multiplex_20260830T1400_s4",
      cluster: GOLDEN_CLUSTER,
      seating: "allocated",
      capacity: 168,
      availability_mode: "seat_map",
      starts_at: "2026-08-30T14:00:00+12:00",
      local_wall: "2026-08-30T14:00",
      local_wall_offset: "+12:00",
      sales_cutoff_at: "2026-08-30T14:15:00+12:00",
      seats: seatGrid({ capacity: 168, per_row: 14, available: 160, wheelchair_every: 7 }),
    },
  ],
};

/**
 * ADR-005's own scenario: a hundred-seat house, every seat free.
 *
 * "C-ATOMIC asserts it at 200 concurrent holds on a 100-seat house: exactly 100
 * succeed, 100 typed 409, zero oversell, zero partial holds, zero deadlocks."
 * That assertion needs a house whose capacity is exactly its availability, so
 * that a shortfall is a violation and not a sold seat.
 */
export const HUNDRED_SEAT_HOUSE: Estate = {
  name: "hundred-seat-house",
  occasions: [
    {
      occasion_id: "occ_reference_100seat_s1",
      revision: 1,
      etag: "1:5ErGRgw3QBaAHK9U3OchjOTMQkdPjkEtLDoihulCgGk",
      origin: "https://reference.example",
      source: "reference",
      showtime_id: "occ_reference_100seat_s1",
      cluster: "clu_reference",
      seating: "allocated",
      capacity: 100,
      availability_mode: "seat_map",
      starts_at: "2026-08-29T19:00:00+12:00",
      local_wall: "2026-08-29T19:00",
      local_wall_offset: "+12:00",
      sales_cutoff_at: "2026-08-29T19:15:00+12:00",
      seats: seatGrid({ capacity: 100, per_row: 10 }),
    },
  ],
};

/** Every standing estate, by name. */
export const ESTATES: Readonly<Record<string, Estate>> = {
  golden: GOLDEN_ESTATE,
  "hundred-seat-house": HUNDRED_SEAT_HOUSE,
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Write an estate into the store. Idempotent: re-seeding the same estate
 * updates the Occasion in place and replaces its seat inventory.
 *
 * Runs as the migrating role, not as `changeover_agent` — the boundary is not
 * permitted to write the estate and that is the point (W3).
 */
export async function seedEstate(db: Db, estate: Estate): Promise<SeededEstate> {
  let seats = 0;
  for (const occasion of estate.occasions) {
    await db.transaction(async (tx) => {
      await tx.query(
        `insert into occasion (occasion_id, revision, etag, origin, source, showtime_id, cluster,
           seating, capacity, availability_mode, starts_at, local_wall, local_wall_offset,
           sales_cutoff_at, withdrawn, document)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict (occasion_id) do update set
           revision = excluded.revision, etag = excluded.etag, origin = excluded.origin,
           source = excluded.source, showtime_id = excluded.showtime_id, cluster = excluded.cluster,
           seating = excluded.seating, capacity = excluded.capacity,
           availability_mode = excluded.availability_mode, starts_at = excluded.starts_at,
           local_wall = excluded.local_wall, local_wall_offset = excluded.local_wall_offset,
           sales_cutoff_at = excluded.sales_cutoff_at, withdrawn = excluded.withdrawn,
           document = excluded.document`,
        [
          occasion.occasion_id,
          occasion.revision,
          occasion.etag,
          occasion.origin,
          occasion.source,
          occasion.showtime_id,
          occasion.cluster,
          occasion.seating,
          occasion.capacity,
          occasion.availability_mode,
          occasion.starts_at,
          occasion.local_wall,
          occasion.local_wall_offset,
          occasion.sales_cutoff_at,
          occasion.withdrawn ?? false,
          occasion.document === undefined ? null : JSON.stringify(occasion.document),
        ],
      );
      await tx.query("delete from occasion_seat where occasion_id = $1", [occasion.occasion_id]);
      for (const seat of occasion.seats) {
        await tx.query(
          `insert into occasion_seat (occasion_id, seat_id, section, seat_row, seat_number, status, adjacency_group)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            occasion.occasion_id,
            seat.seat_id,
            seat.section ?? null,
            seat.seat_row ?? null,
            seat.seat_number ?? null,
            seat.status,
            seat.adjacency_group ?? null,
          ],
        );
        seats++;
      }
    });
  }
  return { occasions: estate.occasions.length, seats };
}

/** Remove an estate and, by cascade, nothing else — Holds reference Occasions. */
export async function clearEstate(db: Queryable, estate: Estate): Promise<void> {
  for (const occasion of estate.occasions) {
    await db.query("delete from occasion where occasion_id = $1", [occasion.occasion_id]);
  }
}

/** The seat ids of one Occasion in the order `seatGrid` laid them out. */
export function availableSeatIds(occasion: OccasionSeed, count: number): string[] {
  return occasion.seats
    .filter((s) => s.status === "available")
    .slice(0, count)
    .map((s) => s.seat_id);
}
