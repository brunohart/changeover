/**
 * A migrated store with a house in it, and a recorder that watches what
 * `hold_seats` says to it. Owner: CORE-002.
 *
 * Not a `.test.ts` file, so `node --test` does not run it.
 */

import type { Db, Queryable, QueryResult, Row, TransactionOptions } from "@changeover/store/db.ts";
import { openDb } from "@changeover/store/db.ts";
import { migrate, resetHoldStore } from "@changeover/store/migrate.ts";
import type { Estate, OccasionSeed } from "@changeover/store/fixtures.ts";
import { seatGrid, seedEstate } from "@changeover/store/fixtures.ts";

/** A real 43-character etag body, so the schema guard sees a well-formed one. */
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

export interface OccasionOverrides {
  readonly occasion_id: string;
  readonly showtime_id?: string;
  readonly cluster?: string | null;
  readonly capacity?: number;
  readonly availability_mode?: "seat_map" | "count" | "unknown";
  readonly sales_cutoff_at?: string | null;
  readonly document?: unknown;
  readonly sold?: number;
}

/** One deterministic Occasion. `A:1 … A:10, B:1 …` — the shape SPEC.md uses. */
export function occasion(overrides: OccasionOverrides): OccasionSeed {
  const capacity = overrides.capacity ?? 20;
  return {
    occasion_id: overrides.occasion_id,
    revision: 1,
    etag: etagFor(overrides.occasion_id),
    origin: "https://reference.example",
    source: "reference",
    showtime_id: overrides.showtime_id ?? overrides.occasion_id,
    cluster: overrides.cluster === undefined ? null : overrides.cluster,
    seating: "allocated",
    capacity,
    availability_mode: overrides.availability_mode ?? "seat_map",
    starts_at: "2026-08-29T19:00:00+12:00",
    local_wall: "2026-08-29T19:00",
    local_wall_offset: "+12:00",
    sales_cutoff_at: overrides.sales_cutoff_at === undefined ? "2026-12-29T19:15:00+12:00" : overrides.sales_cutoff_at,
    document: overrides.document,
    seats: seatGrid({ capacity, per_row: 10, available: capacity - (overrides.sold ?? 0) }),
  };
}

export interface Bench {
  readonly db: Db;
  readonly estate: Estate;
  close(): Promise<void>;
  reset(): Promise<void>;
}

/** A migrated in-process store carrying exactly the Occasions given. */
export async function bench(occasions: readonly OccasionSeed[]): Promise<Bench> {
  const db = await openDb();
  await migrate(db);
  const estate: Estate = { name: "core-002", occasions: [...occasions] };
  await seedEstate(db, estate);
  return {
    db,
    estate,
    close: () => db.close(),
    reset: () => resetHoldStore(db),
  };
}

/* ── The recorder ──────────────────────────────────────────────────────────── */

export interface Statement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

/**
 * Anything that changes the store, or takes a lock in order to.
 *
 * `pg_advisory_xact_lock` is included deliberately. G1's read-only prefix is
 * about not "mutating store state", but SPEC.md:433 names the draft's failure
 * as having "took locks **and** reaped rows before checking the etag" — so a
 * proof that only counted rows would miss half of what went wrong.
 */
export function isWrite(sql: string): boolean {
  return /^\s*(insert|update|delete|truncate|with\b[\s\S]*?\b(insert|update|delete))\b/i.test(sql) ||
    /pg_advisory/i.test(sql);
}

export interface Recorder {
  readonly db: Db;
  readonly statements: Statement[];
  writes(): Statement[];
  clear(): void;
}

/** A `Db` that answers exactly as the real one does and remembers what it was asked. */
export function record(inner: Db): Recorder {
  const statements: Statement[] = [];

  const wrap = (q: Queryable): Queryable => ({
    async query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      statements.push({ sql, params });
      return q.query<T>(sql, params);
    },
    async exec(sql: string): Promise<void> {
      statements.push({ sql });
      return q.exec(sql);
    },
  });

  const outer = wrap(inner);
  const db: Db = {
    query: outer.query,
    exec: outer.exec,
    driver: inner.driver,
    concurrent: inner.concurrent,
    close: () => inner.close(),
    transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T> {
      return inner.transaction((tx) => fn(wrap(tx)), options);
    },
  };

  return {
    db,
    statements,
    writes: () => statements.filter((s) => isWrite(s.sql)),
    clear: () => {
      statements.length = 0;
    },
  };
}

/* ── Counting what actually landed ─────────────────────────────────────────── */

export async function rowCounts(db: Queryable): Promise<Record<string, number>> {
  const tables = ["hold", "hold_seat", "hold_cluster", "hold_slot", "idempotency"];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const r = await db.query<{ n: string }>(`select count(*)::text as n from ${table}`);
    out[table] = Number(r.rows[0]?.n ?? 0);
  }
  return out;
}

export function totalRows(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}
