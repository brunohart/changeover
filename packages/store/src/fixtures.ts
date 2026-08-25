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
  // DEMO-001's four venues across two origins. Defined at the bottom of this
  // file, and dated from the moment this module loaded rather than written down.
  get "nz-four-site"() {
    return NZ_FOUR_SITE;
  },
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

// ---------------------------------------------------------------------------
// The four-site New Zealand circuit. Added by DEMO-001.
// ---------------------------------------------------------------------------
//
// Four venues, TWO origins, and the split is load-bearing rather than
// decorative.
//
// **E1** requires every substitution edge to target an Occasion published at
// the same `venue.origin`, and **E3** scopes `cluster` to `(venue.origin,
// cluster)`. So the three rooms that argue with each other about what is a
// substitute for what — the archival house and the two multiplex screens — are
// one operator at one origin, which is the ordinary shape of a small circuit.
// Cross-exhibitor substitution is out of scope in v0.1 and this estate is built
// so that a demo cannot accidentally imply otherwise.
//
// The fourth site is a different exhibitor entirely, and it is here because it
// publishes no seat map. `availability.mode: "unknown"` is not a gap in the
// fixture; it is the state §2.9 gives a code for. An Agent MUST NOT read it as
// sold out and MUST NOT read it as available, and there is no way to show that
// with an estate where every house answers.
//
// **Every instant is computed from `now`.** An estate with a written-down 2026
// sales cutoff passes today and starts refusing `past_sales_cutoff` on a date
// nobody chose — G1 step 6, arriving as a demo that used to work. `days_ahead`
// is relative and the house is always open.

export const NZ_ORIGIN_CIRCUIT = "https://aro-circuit.example";
export const NZ_ORIGIN_INDEPENDENT = "https://whitcombe.example";

/** X2's fan-out key at {@link NZ_ORIGIN_CIRCUIT}. Distinct from the golden cluster. */
export const NZ_CLUSTER = "the-conversation-2026-w35";

/** The four Occasion ids, named so a reel refers to a constant and not a string. */
export const NZ_OCCASION = {
  /** 35mm four-perf, the archival house. What the customer chose. */
  kereru: "occ_kereru_fri_1900_s1",
  /** DCP, later the same night, cheaper. Attests it is substitutable BY the print. */
  totara_4: "occ_totara4_fri_2115_s4",
  /** DCP, Sunday matinee, open captions. Incomparable — a different night. */
  totara_2: "occ_totara2_sun_1400_s2",
  /** A different exhibitor, publishing no seat map at all. */
  whitcombe: "occ_whitcombe_sat_1830_s1",
} as const;

export type NzOccasionKey = keyof typeof NZ_OCCASION;

/** `1:` plus 43 base64url characters, derived from the id so two runs agree. */
function stableEtag(seed: string): string {
  const bytes = Buffer.alloc(32);
  // A fixed, non-cryptographic spread of the id across the 32 bytes. The value
  // is opaque and Z3 forbids parsing it; what matters is that it is stable for
  // an id, differs between ids, and is not mistakable for a PROJECTION_0_1
  // digest by anything that recomputes one.
  let h = 0x811c9dc5;
  for (let i = 0; i < 32; i++) {
    for (let j = 0; j < seed.length; j++) {
      h = Math.imul(h ^ seed.charCodeAt(j), 0x01000193) >>> 0;
    }
    h = Math.imul(h ^ i, 0x01000193) >>> 0;
    bytes[i] = h & 0xff;
  }
  return `1:${bytes.toString("base64url")}`;
}

/**
 * The local wall and offset of an instant in a named zone, without importing a
 * package that computes it. `longOffset` is `GMT+12:00` in winter and
 * `GMT+13:00` under New Zealand daylight time, so an estate built in February
 * and an estate built in July both carry the offset that was true.
 */
function wallAt(at: Date, timezone: string): { local_wall: string; local_wall_offset: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const of = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const hour = of("hour") === "24" ? "00" : of("hour");
  const zone = of("timeZoneName").replace(/^GMT/, "");
  return {
    local_wall: `${of("year")}-${of("month")}-${of("day")}T${hour}:${of("minute")}`,
    local_wall_offset: zone === "" ? "+00:00" : zone,
  };
}

interface NzInstant {
  readonly starts_at: string;
  readonly local_wall: string;
  readonly local_wall_offset: string;
  readonly sales_cutoff_at: string;
}

/**
 * The next Friday in the venue's own zone that is at least `min_days_ahead`
 * away, as a UTC instant at local noon.
 *
 * The Occasion ids in this estate say `fri`, `sat` and `sun`. An estate that
 * computed `now + 5 days` would put a screening called Friday on a Tuesday
 * within a week of being written, and the id would be a small lie in a fixture
 * whose whole job is to be checked. Anchoring to a real weekday costs eight
 * lines and the ids stay true for as long as the calendar does.
 */
function nzAnchorFriday(now: Date, timezone: string, min_days_ahead: number): Date {
  const at = new Date(now.getTime() + min_days_ahead * 86_400_000);
  for (let i = 0; i < 7; i++) {
    const day = new Date(at.getTime() + i * 86_400_000);
    const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(day);
    if (name === "Fri") return day;
  }
  // Unreachable: seven consecutive days contain every weekday exactly once.
  throw new Error("fixtures: no Friday in seven days");
}

/** `anchor + days`, snapped to `hour:minute` in the venue's own zone. */
function nzInstant(anchor: Date, days: number, hour: number, minute: number, timezone: string): NzInstant {
  // Land on the right calendar day in the venue's zone first, then walk the
  // wall clock to the hour asked for. Doing it the other way round puts a 19:00
  // screening at 06:00 whenever the process runs in UTC.
  const day = wallAt(new Date(anchor.getTime() + days * 86_400_000), timezone);
  const date = day.local_wall.slice(0, 10);
  const offset = day.local_wall_offset;
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const starts_at = `${date}T${hh}:${mm}:00${offset}`;
  const started = new Date(starts_at);
  const cutoff = new Date(started.getTime() + 900_000);
  const cutoff_wall = wallAt(cutoff, timezone);
  return {
    starts_at,
    local_wall: `${date}T${hh}:${mm}`,
    local_wall_offset: offset,
    sales_cutoff_at: `${cutoff_wall.local_wall}:00${cutoff_wall.local_wall_offset}`,
  };
}

const NZ_TIMEZONE = "Pacific/Auckland";

/** §2.5's fourteen members, at the numbers the golden fixtures publish. */
const NZ_HOLD_POLICY = Object.freeze({
  policy_max_floor_ms: 180000,
  handoff_floor_ms: 300000,
  clock_guard_ms: 2000,
  max_clock_skew_tolerance_ms: 1000,
  max_seats_per_hold: 6,
  max_live_holds_per_showtime: 2,
  max_holds_per_site_per_hour: 6,
  max_live_holds_per_cluster: 1,
  max_live_seats_per_showtime: 6,
  max_held_seat_fraction_bp: 500,
  max_held_fraction_per_showtime: 0.02,
  max_live_holds_per_site: 40,
  revocation_voids_holds: true,
  abandonment_floor_penalty_bp: 0,
});

const prose = (value: string) => ({ content_type: "text/plain", value });

interface NzSiteSeed {
  readonly occasion_id: string;
  readonly origin: string;
  readonly venue_id: string;
  readonly venue_name: string;
  readonly locality: string;
  readonly auditorium_id: string;
  readonly auditorium_name: string;
  readonly capacity: number;
  readonly available: number;
  readonly per_row: number;
  /** Days after the anchor Friday. 0 Friday, 1 Saturday, 2 Sunday. */
  readonly day_offset: number;
  readonly hour: number;
  readonly minute: number;
  readonly presentation_classes: readonly string[];
  readonly occasion_classes?: readonly string[];
  readonly open_captions: "yes" | "no";
  readonly amount_minor: number;
  readonly offer_id: string;
  readonly band: string;
  readonly cluster: string;
  readonly policy: "strict" | "advisory";
  readonly accepts_substitute?: readonly { occasion_id: string; axis: string }[];
  readonly not_substitutable_for?: readonly {
    occasion_id: string;
    axis: string;
    reason_code: string;
    detail: string;
  }[];
  /** `unknown` publishes no seat map, no count and no staleness budget. */
  readonly availability_mode: "seat_map" | "unknown";
  readonly why_this_room?: string;
  readonly note?: string;
  readonly book_path: string;
}

function nzOccasion(seed: NzSiteSeed, now: Date, anchor: Date): OccasionSeed {
  const instant = nzInstant(anchor, seed.day_offset, seed.hour, seed.minute, NZ_TIMEZONE);
  const etag = stableEtag(seed.occasion_id);
  const observed_at = new Date(now.getTime() - 1200).toISOString();
  const known = seed.availability_mode === "seat_map";

  const availability: Record<string, unknown> = known
    ? {
      mode: "seat_map",
      observed_at,
      staleness_basis: "measured",
      sold_out: false,
      seats_available: seed.available,
      seat_map_ref: `${seed.origin}/changeover/v0/occasions/${seed.occasion_id}/seatmap`,
      max_staleness_ms: 30000,
    }
    // §2.9: neither sold out nor available. Every member that would imply one
    // or the other is ABSENT, because a Server that filled them in with zeroes
    // would be answering a question it cannot answer.
    : { mode: "unknown", observed_at, staleness_basis: "unknown" };

  const manner: Record<string, unknown> = {
    presentation_classes: [...seed.presentation_classes],
    ...(seed.occasion_classes === undefined ? {} : { occasion_classes: [...seed.occasion_classes] }),
    register_version: "2026.1",
    accessibility: {
      open_captions: seed.open_captions,
      captioning_devices: "no",
      audio_description: "no",
      assistive_listening: "yes",
      wheelchair_spaces: "yes",
      relaxed_environment: "no",
      sensory_adjusted: "no",
    },
    ...(seed.note === undefined
      ? {}
      : {
        note: {
          body: prose(seed.note),
          authored_by: "programmer",
          authored_at: new Date(now.getTime() - 86_400_000).toISOString(),
        },
      }),
  };

  const document: Record<string, unknown> = {
    changeover: "0.1",
    occasion_id: seed.occasion_id,
    revision: 1,
    etag,
    venue: {
      id: seed.venue_id,
      name: prose(seed.venue_name),
      origin: seed.origin,
      timezone: NZ_TIMEZONE,
      locality: seed.locality,
    },
    auditorium: {
      id: seed.auditorium_id,
      seating: "allocated",
      name: seed.auditorium_name,
      capacity: seed.capacity,
      ...(seed.why_this_room === undefined ? {} : { why_this_room: prose(seed.why_this_room) }),
    },
    work: { title: prose("The Conversation"), year: 1974, runtime_minutes: 113 },
    instant: {
      starts_at: instant.starts_at,
      local_wall: instant.local_wall,
      local_wall_offset: instant.local_wall_offset,
      sales_cutoff_at: instant.sales_cutoff_at,
    },
    manner,
    availability,
    price_disclosure: "published",
    offers: [
      {
        offer_id: seed.offer_id,
        band: prose(seed.band),
        currency: "NZD",
        amount_minor: seed.amount_minor,
        price_basis: { includes_mandatory_fees: true, includes_tax: true },
      },
    ],
    substitution: {
      cluster: seed.cluster,
      policy: seed.policy,
      accepts_substitute: (seed.accepts_substitute ?? []).map((e) => ({ ...e })),
      not_substitutable_for: (seed.not_substitutable_for ?? []).map((e) => ({
        occasion_id: e.occasion_id,
        axis: e.axis,
        reason_code: e.reason_code,
        detail: prose(e.detail),
      })),
      derived_from: {
        policy_id: "pol_aro_2026",
        rule_ids: ["r-35mm-carrier"],
        rule_version: "2026.1",
      },
    },
    hold_policy: { ...NZ_HOLD_POLICY },
    book_url: `${seed.origin}${seed.book_path}`,
    server_time: now.toISOString(),
  };

  return {
    occasion_id: seed.occasion_id,
    revision: 1,
    etag,
    origin: seed.origin,
    source: "reference",
    // No `showtime_ref` is published, so the screening key is the Occasion's
    // own id. §4.6's index is over `(showtime_id, seat_id)`, and where one
    // listing maps to one screening the two identities coincide.
    showtime_id: seed.occasion_id,
    cluster: seed.cluster,
    seating: "allocated",
    capacity: seed.capacity,
    availability_mode: seed.availability_mode,
    starts_at: instant.starts_at,
    local_wall: instant.local_wall,
    local_wall_offset: instant.local_wall_offset,
    sales_cutoff_at: instant.sales_cutoff_at,
    document,
    seats: seatGrid({ capacity: seed.capacity, per_row: seed.per_row, available: seed.available }),
  };
}

/** The independent's own cluster. E3 scopes it to `(origin, cluster)`, so this
 * string and {@link NZ_CLUSTER} could be equal and still make no claim about
 * each other. They are different here so nobody has to know that to read it. */
export const NZ_CLUSTER_INDEPENDENT = "the-conversation-2026-w35-otautahi";

function nzSites(): readonly NzSiteSeed[] {
  return [
    {
      // The print. What the customer chose, and the reason the other two are
      // not interchangeable with it.
      occasion_id: NZ_OCCASION.kereru,
      origin: NZ_ORIGIN_CIRCUIT,
      venue_id: "ven_kereru",
      venue_name: "The Kererū",
      locality: "Wellington",
      auditorium_id: "aud_kereru_main",
      auditorium_name: "The Main Room",
      capacity: 312,
      available: 96,
      per_row: 24,
      day_offset: 0,
      hour: 19,
      minute: 0,
      presentation_classes: ["pres:35mm-4perf", "pres:sound-optical", "pres:reserved-seating"],
      occasion_classes: ["occ:archival-print", "occ:final-run"],
      open_captions: "no",
      amount_minor: 2400,
      offer_id: "off_kereru_full",
      band: "General admission",
      cluster: NZ_CLUSTER,
      policy: "strict",
      accepts_substitute: [],
      not_substitutable_for: [
        {
          occasion_id: NZ_OCCASION.totara_4,
          axis: "presentation_class",
          reason_code: "carrier",
          detail: "A digital projection is not a substitute for the print.",
        },
        {
          occasion_id: NZ_OCCASION.totara_2,
          axis: "presentation_class",
          reason_code: "carrier",
          detail: "A digital projection is not a substitute for the print.",
        },
      ],
      availability_mode: "seat_map",
      why_this_room: "The only four-perf projector still threaded south of the harbour.",
      note: "Struck in 1974 and held in the vault since the last revival. This is the print, not a scan of it.",
      book_path: "/tickets/kereru-fri-1900",
    },
    {
      // The cheaper DCP, later the same night. It attests that the print is an
      // acceptable substitute for IT — which is what makes it dominated, and
      // which is NOT the same as being an acceptable substitute for the print.
      occasion_id: NZ_OCCASION.totara_4,
      origin: NZ_ORIGIN_CIRCUIT,
      venue_id: "ven_totara",
      venue_name: "Tōtara Cinemas",
      locality: "Wellington",
      auditorium_id: "aud_totara_4",
      auditorium_name: "Cinema 4",
      capacity: 180,
      available: 154,
      per_row: 18,
      day_offset: 0,
      hour: 21,
      minute: 15,
      presentation_classes: ["pres:dcp-2k-flat", "pres:sound-5-1", "pres:reserved-seating"],
      open_captions: "no",
      amount_minor: 1500,
      offer_id: "off_totara_full",
      band: "General admission",
      cluster: NZ_CLUSTER,
      policy: "strict",
      accepts_substitute: [{ occasion_id: NZ_OCCASION.kereru, axis: "presentation_class" }],
      not_substitutable_for: [],
      availability_mode: "seat_map",
      book_path: "/tickets/totara-4-fri-2115",
    },
    {
      // A different night, open captions, and no attested edge in either
      // direction. Incomparable, and therefore an option rather than a
      // consolation.
      occasion_id: NZ_OCCASION.totara_2,
      origin: NZ_ORIGIN_CIRCUIT,
      venue_id: "ven_totara",
      venue_name: "Tōtara Cinemas",
      locality: "Wellington",
      auditorium_id: "aud_totara_2",
      auditorium_name: "Cinema 2",
      capacity: 180,
      available: 171,
      per_row: 18,
      day_offset: 2,
      hour: 14,
      minute: 0,
      presentation_classes: ["pres:dcp-2k-flat", "pres:sound-5-1", "pres:reserved-seating"],
      open_captions: "yes",
      amount_minor: 1200,
      offer_id: "off_totara_matinee",
      band: "Matinee",
      cluster: NZ_CLUSTER,
      policy: "strict",
      accepts_substitute: [],
      not_substitutable_for: [],
      availability_mode: "seat_map",
      book_path: "/tickets/totara-2-sun-1400",
    },
    {
      // A different exhibitor, on a different origin, whose ticketing exposes no
      // seat map. It is here to be refused honestly.
      occasion_id: NZ_OCCASION.whitcombe,
      origin: NZ_ORIGIN_INDEPENDENT,
      venue_id: "ven_whitcombe",
      venue_name: "The Whitcombe",
      locality: "Ōtautahi Christchurch",
      auditorium_id: "aud_whitcombe_1",
      auditorium_name: "The Stalls",
      capacity: 240,
      available: 240,
      per_row: 20,
      day_offset: 1,
      hour: 18,
      minute: 30,
      presentation_classes: ["pres:dcp-2k-flat", "pres:sound-5-1", "pres:reserved-seating"],
      open_captions: "no",
      amount_minor: 1400,
      offer_id: "off_whitcombe_full",
      band: "General admission",
      cluster: NZ_CLUSTER_INDEPENDENT,
      policy: "advisory",
      accepts_substitute: [],
      not_substitutable_for: [],
      availability_mode: "unknown",
      note: "Our seating is on the door. We publish the screening, not the map.",
      book_path: "/tickets/whitcombe-sat-1830",
    },
  ];
}

/**
 * The four-site estate, dated from `now`.
 *
 * Deterministic given `now`: the same reference instant produces the same ids,
 * the same etags, the same seat grid and the same instants. That is what lets a
 * demo assert a stable structural transcript across two runs while still
 * printing the real times it actually took.
 */
export function nzFourSiteEstate(now: Date = new Date()): Estate {
  // At least three days out, so `hold_expired` can be demonstrated by waiting
  // rather than by moving a clock, and the sales cutoff is never the reason.
  const anchor = nzAnchorFriday(now, NZ_TIMEZONE, 3);
  return { name: "nz-four-site", occasions: nzSites().map((seed) => nzOccasion(seed, now, anchor)) };
}

/**
 * The estate, built once at module load.
 *
 * Built rather than written down for the reason above, and built ONCE so that
 * two seedings inside one process agree — an estate whose etags moved between
 * the seed and the request would fail G2 for a reason that had nothing to do
 * with anything under test.
 */
export const NZ_FOUR_SITE: Estate = nzFourSiteEstate();

/** The sub-estate one exhibitor publishes. Two origins means two Servers. */
export function occasionsAtOrigin(estate: Estate, origin: string): Estate {
  return {
    name: `${estate.name}@${origin}`,
    occasions: estate.occasions.filter((o) => o.origin === origin),
  };
}

/** One Occasion of an estate, by id. Throws rather than returning undefined:
 * a reel that silently held nothing would print a transcript about nothing. */
export function occasionOf(estate: Estate, occasion_id: string): OccasionSeed {
  const found = estate.occasions.find((o) => o.occasion_id === occasion_id);
  if (found === undefined) {
    throw new Error(`fixtures: estate ${estate.name} publishes no ${occasion_id}`);
  }
  return found;
}
