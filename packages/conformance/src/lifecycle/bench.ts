/**
 * The lifecycle bench: a migrated store, a house nobody else is holding, and a
 * `Db` that remembers every statement issued through it.
 *
 * Owner: TEST-003 (C-IDEMPOTENT, C-RELEASE, C-ORPHAN).
 *
 * Three things here are load-bearing and none of them is obvious.
 *
 * **The estate is reset, not merely seeded.** PGlite hands every `openDb()` its
 * own fresh in-process cluster; a real Postgres at `CHANGEOVER_PG_URL` is one
 * database that every proof script in the suite seeds into in turn. Every
 * assertion below is of the form *"the store contains exactly what I put in
 * it"*, and that sentence is true by accident on the default path and false the
 * moment the variable is set. The access log is deliberately **not** reset: it
 * is append-only and a helper that quietly emptied it would be the first crack
 * in the property this repository asserts.
 *
 * **The Occasion carries a per-run nonce.** Two runs of this script against one
 * Postgres must not contend over each other's seats, and `resetHoldStore`
 * cannot help a run that is still in flight.
 *
 * **The counter counts reclaim statements, not queries.** C-ORPHAN's whole
 * claim is that *nothing ran*. A config flag saying `sweeper: false` records
 * what an operator intended; a count of the statements this process actually
 * issued records what is true. {@link RECLAIMS} is deliberately wide — any
 * DELETE or UPDATE against `hold_seat`, `hold_slot` or `hold_cluster` — because
 * a sweeper that freed the slot and left the seat would still be a sweeper.
 */

import type { Db, Queryable, QueryResult, Row, TransactionOptions } from "@changeover/store/db.ts";
import { openDb } from "@changeover/store/db.ts";
import { migrate, resetEstate, resetHoldStore } from "@changeover/store/migrate.ts";
import type { Estate, OccasionSeed } from "@changeover/store/fixtures.ts";
import { seatGrid, seedEstate } from "@changeover/store/fixtures.ts";

/** O1: a bare origin. The same one the core fixtures publish, so nothing drifts. */
export const LIFECYCLE_ORIGIN = "https://reference.example";

/**
 * A well-formed 43-character etag body.
 *
 * Deliberately **not** imported from `packages/core/test/lib/estate.ts`: this is
 * a fixture identifier, not a projection. The digest a proof compares against is
 * always minted by `@changeover/schema`; nothing here may become a second
 * projector, because C-ETAG's whole claim is that two independent
 * implementations agree and importing one into the other makes it a tautology.
 */
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

export interface LifecycleOccasionOptions {
  readonly occasion_id: string;
  readonly showtime_id?: string;
  readonly cluster?: string | null;
  readonly capacity?: number;
}

/**
 * One deterministic Occasion, seating `A:1 … A:10, B:1 …`.
 *
 * `starts_at` and `sales_cutoff_at` are computed forward from now rather than
 * written as literals. A hard-coded cutoff is a proof with an expiry date on it:
 * it passes for a year and then every grant in the file starts refusing
 * `past_sales_cutoff` for a reason that has nothing to do with the code.
 */
export function lifecycleOccasion(options: LifecycleOccasionOptions): OccasionSeed {
  const capacity = options.capacity ?? 40;
  const starts = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return {
    occasion_id: options.occasion_id,
    revision: 1,
    etag: etagFor(options.occasion_id),
    origin: LIFECYCLE_ORIGIN,
    source: "reference",
    showtime_id: options.showtime_id ?? options.occasion_id,
    cluster: options.cluster === undefined ? null : options.cluster,
    seating: "allocated",
    capacity,
    availability_mode: "seat_map",
    starts_at: starts.toISOString(),
    local_wall: starts.toISOString().slice(0, 16),
    local_wall_offset: "+00:00",
    sales_cutoff_at: new Date(starts.getTime() + 15 * 60 * 1000).toISOString(),
    seats: seatGrid({ capacity, per_row: 10 }),
  };
}

/* ── The statement counter ─────────────────────────────────────────────────── */

/**
 * Anything that could hand a seat, a slot or a cluster row back.
 *
 * A reap is `with doomed as (…) delete from hold_seat h using doomed d`, a
 * budget return is `delete from hold_slot s using hold h`, and a release is
 * `update hold_seat set state = …`. All three free occupancy, so all three
 * count: the assertion is that **nothing** freed the orphan, not that one
 * particular spelling did not.
 */
export const RECLAIMS = /\b(delete|update)\b[\s\S]{0,400}?\bhold_(seat|slot|cluster)\b/i;

export interface Counted {
  readonly db: Db;
  /** Every statement issued through this handle, in order. */
  readonly statements: string[];
  /** Those of them that could have freed occupancy. */
  reclaims(): string[];
  clear(): void;
}

/** A `Db` that answers exactly as the real one does and remembers what it was asked. */
export function counted(inner: Db): Counted {
  const statements: string[] = [];

  const watch = (q: Queryable): Queryable => ({
    async query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      statements.push(sql);
      return q.query<T>(sql, params);
    },
    async exec(sql: string): Promise<void> {
      statements.push(sql);
      return q.exec(sql);
    },
  });

  const outer = watch(inner);
  const db: Db = {
    query: outer.query,
    exec: outer.exec,
    driver: inner.driver,
    concurrent: inner.concurrent,
    close: () => inner.close(),
    transaction: <T,>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions) =>
      inner.transaction((tx) => fn(watch(tx)), options),
  };

  return {
    db,
    statements,
    reclaims: () => statements.filter((sql) => RECLAIMS.test(sql)),
    clear: () => {
      statements.length = 0;
    },
  };
}

/* ── The bench ─────────────────────────────────────────────────────────────── */

export interface LifecycleBenchOptions {
  /** Occasions to seed. Defaults to one 40-seat house named for the run. */
  readonly occasions?: readonly OccasionSeed[];
  /**
   * Truncate the estate and the hold store before seeding. Default `true`.
   *
   * The orphan client sets this **false**: a child process that reset the store
   * would delete the fixtures its parent is mid-assertion about, and the failure
   * would read as a boundary defect.
   */
  readonly seed?: boolean;
}

export interface LifecycleBench {
  readonly db: Db;
  readonly counter: Counted;
  readonly estate: Estate;
  readonly occasion: OccasionSeed;
  occasionAt(index: number): OccasionSeed;
  close(): Promise<void>;
}

/** A nonce that two runs against one Postgres cannot share. */
export function runId(): string {
  return Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
}

export async function lifecycleBench(
  run_id: string,
  options: LifecycleBenchOptions = {},
): Promise<LifecycleBench> {
  const occasions = options.occasions ?? [lifecycleOccasion({ occasion_id: "occ_life_" + run_id })];
  const raw = await openDb();
  await migrate(raw);
  if (options.seed !== false) {
    // Order matters: `occasion` cascades to `hold`, so the estate goes first and
    // the hold store second, leaving both provably empty rather than one of them.
    await resetEstate(raw);
    await resetHoldStore(raw);
    await seedEstate(raw, { name: "test-003", occasions: [...occasions] });
  }
  const counter = counted(raw);
  const estate: Estate = { name: "test-003", occasions: [...occasions] };
  return {
    db: counter.db,
    counter,
    estate,
    occasion: occasions[0],
    occasionAt: (index: number) => occasions[index],
    close: () => raw.close(),
  };
}

/* ── Reading the store, never the response ─────────────────────────────────── */

export interface Occupancy {
  readonly seat_rows: number;
  readonly occupying_seat_rows: number;
  readonly slot_rows: number;
  readonly cluster_rows: number;
}

/**
 * What one Hold still occupies, counted in the store.
 *
 * `seat_rows` and `occupying_seat_rows` are different numbers and the difference
 * is the whole of M1: a release **marks** its rows (they survive, and stop
 * occupying), while the reap **deletes** them (they are gone). A proof that
 * counted only one of the two could not tell a release from a reap, and
 * C-ORPHAN is precisely a claim about which one happened.
 */
export async function occupancyOf(q: Queryable, hold_id: string): Promise<Occupancy> {
  const r = await q.query<{ seat_rows: string; occupying: string; slots: string; clusters: string }>(
    `select (select count(*) from hold_seat where hold_id = $1)::text as seat_rows,
            (select count(*) from hold_seat where hold_id = $1
               and state in ('live','handed_off','claimed'))::text as occupying,
            (select count(*) from hold_slot where hold_id = $1)::text as slots,
            (select count(*) from hold_cluster where hold_id = $1)::text as clusters`,
    [hold_id],
  );
  const row = r.rows[0];
  return {
    seat_rows: Number(row?.seat_rows ?? 0),
    occupying_seat_rows: Number(row?.occupying ?? 0),
    slot_rows: Number(row?.slots ?? 0),
    cluster_rows: Number(row?.clusters ?? 0),
  };
}

/** `now()`-relative liveness of a Hold, read from the store rather than derived here. */
export async function expiredInStore(q: Queryable, hold_id: string): Promise<boolean> {
  const r = await q.query<{ past: boolean }>(
    "select (expires_at <= clock_timestamp()) as past from hold where hold_id = $1",
    [hold_id],
  );
  return r.rows[0]?.past === true;
}

/**
 * Is the estate this bench seeded still the estate the store holds?
 *
 * §12's defect class, caught rather than mis-reported. A real Postgres at
 * `CHANGEOVER_PG_URL` is ONE database, and everything in this repository resets
 * the hold store at bench setup — so a second process starting up mid-run
 * truncates `occasion`, which cascades to `hold`, which cascades to
 * `idempotency`. What that looks like from inside an assertion is a replay that
 * executed, or a Hold whose seat rows have vanished with nobody contending: the
 * two most alarming failures this file could report, and neither of them true.
 *
 * The distinction is sharp and worth making rather than papering over. A sweeper
 * deletes `hold_seat` or `hold_slot` rows and leaves the `hold` row and the
 * Occasion standing. A foreign reset takes the **Occasion** with it. So a missing
 * Occasion is *cannot prove*, and a missing seat row under a standing Occasion is
 * a failure — which is exactly the right way round.
 */
export async function estateIntact(q: Queryable, occasion_ids: readonly string[]): Promise<boolean> {
  const r = await q.query<{ n: string }>(
    "select count(*)::text as n from occasion where occasion_id = any($1::text[])",
    [[...occasion_ids]],
  );
  return Number(r.rows[0]?.n ?? 0) === occasion_ids.length;
}

/** The message every class prints when {@link estateIntact} says otherwise. */
export const ESTATE_VANISHED =
  "the estate this run seeded was truncated by another process on the shared store at " +
  "CHANGEOVER_PG_URL before the assertions finished — a Hold cannot be observed surviving a " +
  "database that no longer contains its Occasion. Re-run with the store to yourself.";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
