/**
 * A migrated store with a house in it, and a Hold minted directly into any of
 * the six states. Owner: CORE-003.
 *
 * Not a `.test.ts` file, so `node --test` does not run it.
 *
 * **Why the rows are written with SQL rather than by calling `hold_seats`.**
 * Three of the six states this item must read back — `expired`, `handed_off`,
 * `claimed` — cannot be reached through the grant verb at all: one needs a
 * clock forty seconds in the past, and the other two are CORE-004's verbs. A
 * fixture that could only produce the states the grant path produces would
 * quietly narrow every assertion about derived state to the one case that is
 * already easy. Writing the row is also the sharper test: it asserts that
 * `deriveState` reads the *columns*, and cannot accidentally agree with a
 * `state` the grant path happened to return.
 *
 * Every timestamp is derived in SQL from one reading of the database clock, so
 * the fixtures obey K4 for the same reason the implementation does.
 */

import type { Db } from "@changeover/store/db.ts";
import { openDb } from "@changeover/store/db.ts";
import { migrate, resetHoldStore } from "@changeover/store/migrate.ts";
import type { Estate, OccasionSeed } from "@changeover/store/fixtures.ts";
import { seatGrid, seedEstate } from "@changeover/store/fixtures.ts";
import type { Rfc3339 } from "@changeover/schema/scalars.ts";
import type { HoldState } from "../../src/derived.ts";
import { HOLD_STATE } from "../../src/derived.ts";

/* ── The house ─────────────────────────────────────────────────────────────── */

/** A well-formed etag body: `1:` and 43 base64url characters, deterministic. */
export function etagFor(seed: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let h = 2166136261;
  for (let i = 0; i < 43; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0;
    out += alphabet[h % alphabet.length];
  }
  return "1:" + out;
}

export interface HouseOptions {
  readonly occasion_id?: string;
  /** §4.6: several Occasions may map to one physical screening. */
  readonly showtime_id?: string;
  readonly cluster?: string | null;
  readonly capacity?: number;
}

export function house(options: HouseOptions = {}): OccasionSeed {
  const occasion_id = options.occasion_id ?? "occ_derived_state";
  const capacity = options.capacity ?? 20;
  return {
    occasion_id,
    revision: 1,
    etag: etagFor(occasion_id),
    origin: "https://reference.example",
    source: "reference",
    showtime_id: options.showtime_id ?? occasion_id,
    cluster: options.cluster === undefined ? null : options.cluster,
    seating: "allocated",
    capacity,
    availability_mode: "seat_map",
    starts_at: "2026-08-29T19:00:00+12:00",
    local_wall: "2026-08-29T19:00",
    local_wall_offset: "+12:00",
    sales_cutoff_at: "2026-12-29T19:15:00+12:00",
    seats: seatGrid({ capacity, per_row: 10, available: capacity }),
  };
}

export interface Bench {
  readonly db: Db;
  readonly occasions: readonly OccasionSeed[];
  close(): Promise<void>;
  reset(): Promise<void>;
}

/** A migrated in-process store carrying exactly the Occasions given. */
export async function bench(occasions: readonly OccasionSeed[] = [house()]): Promise<Bench> {
  const db = await openDb();
  await migrate(db);
  // A shared store is not a fresh one. PGlite hands every script its own
  // in-process database, so seeding into it is seeding into an empty world; a
  // real Postgres at CHANGEOVER_PG_URL is ONE database that every proof script
  // in the suite seeds into in turn, and the second one collides on ids the
  // first left behind. Truncating here is what makes a script's fixtures its
  // own regardless of substrate. The access log is deliberately NOT truncated
  // — it is append-only, and a helper that quietly emptied it would be the
  // first crack in the property this repository asserts.
  // Found 2026-08-25: six proofs passed individually and failed in the suite
  // the first time it ran against a real Postgres.
  await resetHoldStore(db);
  const estate: Estate = { name: "core-003", occasions: [...occasions] };
  await seedEstate(db, estate);
  return {
    db,
    occasions,
    close: () => db.close(),
    reset: () => resetHoldStore(db),
  };
}

/* ── The Hold ──────────────────────────────────────────────────────────────── */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `^hold_[0-9A-HJKMNP-TV-Z]{32}$`. Deterministic here; Z2 requires a CSPRNG in the verb. */
export function holdIdFor(seed: string): string {
  let out = "";
  let h = 2166136261 ^ seed.length;
  for (let i = 0; i < 32; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i * 7), 16777619) >>> 0;
    out += CROCKFORD[h % 32];
  }
  return "hold_" + out;
}

export interface MintOptions {
  readonly hold_id?: string;
  readonly agent_id?: string;
  readonly principal_scope?: string;
  readonly occasion?: OccasionSeed;
  readonly seats?: readonly string[];
  /** The state the columns should derive to. */
  readonly state?: HoldState;
  /** How long before now the Hold was granted. */
  readonly granted_ago_ms?: number;
  readonly floor_ms?: number;
  /** `expires_at = granted_at + lifetime_ms`. Must be ≥ `floor_ms` (T2). */
  readonly lifetime_ms?: number;
  readonly handoff_floor_ms?: number;
  /**
   * Delete the `hold_seat` rows, as the reap of §4.6 does. M2 says `seats` is
   * still reported, from `hold`, after exactly this.
   */
  readonly reaped?: boolean;
  /** Occupy a cluster row and a budget slot, so a release can be seen returning them. */
  readonly cluster?: string | null;
  readonly slot?: number;
}

export interface MintedHold {
  readonly hold_id: string;
  readonly agent_id: string;
  readonly principal_scope: string;
  readonly occasion_id: string;
  readonly showtime_id: string;
  readonly seats: readonly string[];
  readonly state: HoldState;
  readonly granted_at: Rfc3339;
  readonly expires_at: Rfc3339;
}

/** Seat-row occupancy for a Hold minted into `state`, before any reap. */
function seatRowState(state: HoldState): HoldState {
  // `expired` is the load-bearing row: nothing reaped it, so the seat row is
  // still `live` while the Hold derives to `expired`. That gap IS M1.
  return state === HOLD_STATE.expired ? HOLD_STATE.live : state;
}

/**
 * Write one Hold into the store, in the state asked for, with the seat, cluster
 * and slot rows a Hold in that state would carry.
 */
export async function mintHold(db: Db, options: MintOptions = {}): Promise<MintedHold> {
  const occasion = options.occasion ?? house();
  const state = options.state ?? HOLD_STATE.live;
  const hold_id = options.hold_id ?? holdIdFor(`${occasion.occasion_id}:${state}`);
  const agent_id = options.agent_id ?? "agt_reference";
  const principal_scope = options.principal_scope ?? "site_wellington";
  const seats = options.seats ?? occasion.seats.slice(0, 2).map((seat) => seat.seat_id);
  const floor_ms = options.floor_ms ?? 1000;
  const lifetime_ms = options.lifetime_ms ?? Math.max(floor_ms, 60_000);
  const granted_ago_ms =
    options.granted_ago_ms ?? (state === HOLD_STATE.expired ? lifetime_ms + 5_000 : 0);
  const handoff_floor_ms = options.handoff_floor_ms ?? 120_000;
  const cluster = options.cluster === undefined ? occasion.cluster ?? null : options.cluster;

  const handed_off = state === HOLD_STATE.handed_off || state === HOLD_STATE.claimed;
  // T5/CL4: claim_expires_at = handed_off_at + handoff_floor_ms, and T6 keeps it
  // at or after expires_at for the life of the Hold.
  const handoff_after_grant_ms = Math.max(0, lifetime_ms - handoff_floor_ms);

  const base = await clockText(db);

  // Every parameter is referenced in every branch — a placeholder that appears
  // in only one branch makes the bind count disagree with the parsed statement,
  // which Postgres refuses outright. The markers are `case when <flag> then …`
  // rather than a rebuilt string, so one statement covers all six states.
  await db.query(
    `insert into hold (
       hold_id, agent_id, principal_scope, origin, cluster, occasion_id, occasion_etag,
       sought_occasion_id, showtime_id, seats,
       granted_at, floor_ms, floor_deadline, expires_at,
       handed_off_at, handoff_floor_ms, claim_expires_at,
       released_at, claimed_at, revoked_at, revocation_reason)
     values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[],
       ${at("$11", "$12::int")}, $13::int,
       ${at("$11", "$12::int + $13::int")},
       ${at("$11", "$12::int + $14::int")},
       case when $17::boolean then ${at("$11", "$12::int + $15::int")} end,
       case when $17::boolean then $16::int end,
       case when $17::boolean then ${at("$11", "$12::int + $15::int + $16::int")} end,
       case when $18::boolean then ${at("$11", "$12::int + $14::int")} end,
       case when $19::boolean then ${at("$11", "$12::int + $15::int")} end,
       case when $20::boolean then ${at("$11", "$12::int + $15::int")} end,
       case when $20::boolean then 'venue_operations' end)`,
    [
      hold_id,
      agent_id,
      principal_scope,
      occasion.origin,
      cluster,
      occasion.occasion_id,
      occasion.etag,
      occasion.occasion_id,
      occasion.showtime_id,
      seats,
      base,
      -granted_ago_ms,
      floor_ms,
      lifetime_ms,
      handoff_after_grant_ms,
      handoff_floor_ms,
      handed_off,
      state === HOLD_STATE.released,
      state === HOLD_STATE.claimed,
      state === HOLD_STATE.revoked,
    ],
  );

  if (!options.reaped) {
    const row_state = seatRowState(state);
    const held_until_ms = handed_off ? handoff_after_grant_ms + handoff_floor_ms : lifetime_ms;
    for (const seat_id of seats) {
      await db.query(
        `insert into hold_seat (hold_id, occasion_id, showtime_id, seat_id, state, held_until)
         values ($1, $2, $3, $4, $5, ${at("$6", "$7::int + $8::int")})`,
        [
          hold_id,
          occasion.occasion_id,
          occasion.showtime_id,
          seat_id,
          row_state,
          base,
          -granted_ago_ms,
          held_until_ms,
        ],
      );
    }
    if (cluster !== null) {
      await db.query(
        `insert into hold_cluster (hold_id, agent_id, principal_scope, origin, cluster, state, held_until)
         values ($1, $2, $3, $4, $5, $6, ${at("$7", "$8::int + $9::int")})`,
        [hold_id, agent_id, principal_scope, occasion.origin, cluster, row_state, base, -granted_ago_ms, held_until_ms],
      );
    }
  }

  if (options.slot !== undefined) {
    await db.query(
      "insert into hold_slot (agent_id, principal_scope, showtime_id, slot, hold_id) values ($1, $2, $3, $4, $5)",
      [agent_id, principal_scope, occasion.showtime_id, options.slot, hold_id],
    );
  }

  const back = await db.query<{ granted_at: string; expires_at: string }>(
    "select to_json(granted_at)#>>'{}' as granted_at, to_json(expires_at)#>>'{}' as expires_at from hold where hold_id = $1",
    [hold_id],
  );

  return {
    hold_id,
    agent_id,
    principal_scope,
    occasion_id: occasion.occasion_id,
    showtime_id: occasion.showtime_id,
    seats,
    state,
    granted_at: back.rows[0]!.granted_at,
    expires_at: back.rows[0]!.expires_at,
  };
}

/** `base + (…ms)`, where every offset is an integer of milliseconds. */
function at(base: string, offset_ms: string): string {
  return `(${base}::timestamptz + ((${offset_ms}) * interval '1 millisecond'))`;
}

/** One reading of the database clock, as RFC 3339 text at full stored precision. */
export async function clockText(db: Db): Promise<Rfc3339> {
  const result = await db.query<{ t: string }>("select to_json(clock_timestamp())#>>'{}' as t");
  return result.rows[0]!.t;
}

/** Seat rows still occupying for this Hold, by state. Counts rows; reads nothing derived. */
export async function seatRows(db: Db, hold_id: string): Promise<{ seat_id: string; state: string }[]> {
  const result = await db.query<{ seat_id: string; state: string }>(
    "select seat_id, state from hold_seat where hold_id = $1 order by seat_id",
    [hold_id],
  );
  return result.rows;
}

/** Every state a Hold can be read back in, in `hold.schema.json`'s order. */
export const EVERY_STATE: readonly HoldState[] = Object.freeze([
  HOLD_STATE.live,
  HOLD_STATE.handed_off,
  HOLD_STATE.claimed,
  HOLD_STATE.released,
  HOLD_STATE.expired,
  HOLD_STATE.revoked,
]);
