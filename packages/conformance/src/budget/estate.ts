/**
 * The bench C-BUDGET and C-FANOUT both run on.
 *
 * Owner: TEST-002. Nothing here decides anything — it seeds an estate, issues
 * grants, and counts rows. The two class modules beside it hold the assertions.
 *
 * **Two houses, deliberately.** X4's ceiling is a `min` of an absolute number and
 * a fraction of the room, *"so a small house is not sold out by one credential"*.
 * A bench with one 400-seat auditorium exercises only the absolute half: 500 basis
 * points of 400 is twenty seats, so `max_live_seats_per_showtime: 6` always wins
 * and the fraction is never the number that refuses anybody. The 40-seat house
 * makes the fraction bind at two seats, which is the half of X4 that protects the
 * archival print — *"twenty-four immovable seats on an archival 35mm print is the
 * sell-out"* — and the half nothing in this repository observed before.
 *
 * **The estate is owned, not shared.** `resetEstate` runs before `seedEstate`,
 * because `seedEstate` upserts what it names and leaves every other Occasion in
 * place: correct for a seeder, wrong for a bench that then asks how many holds
 * the store carries. Under PGlite that distinction is invisible — every
 * `openDb()` gets its own cluster — and under a real `CHANGEOVER_PG_URL` it is
 * the difference between a count and a coincidence. The access log is never
 * touched: it is append-only, and a helper that quietly emptied it would be the
 * first crack in the property this repository asserts.
 */

import type { Db, Row } from "@changeover/store/db.ts";
import { sqlstate } from "@changeover/store/db.ts";
import type { Estate, OccasionSeed } from "@changeover/store/fixtures.ts";
import { seatGrid, seedEstate } from "@changeover/store/fixtures.ts";
import { resetEstate, resetHoldStore } from "@changeover/store/migrate.ts";
import type { Refusal } from "@changeover/schema/refusal.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";
import type { HoldDocument } from "@changeover/core/hold-seats.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import { releaseHold } from "@changeover/core/release.ts";
import type { HoldPolicyDocument, ObservableBudgetGuard } from "@changeover/core/budgets.ts";
import { HOLD_POLICY_PUBLISHED, principalBudgets } from "@changeover/core/budgets.ts";

/** One agent platform serving many customers. X0's whole point. */
export const AGENT = "agt_examplebot";

export const ORIGIN = "https://embassy.example";

/** X2's labelled cluster: one 35mm run across a Friday and a Sunday. */
export const CLUSTER = "clu_35mm_run";

/** The premiere. 500bp of 400 is twenty seats, so the absolute half of X4 binds. */
export const BIG_HOUSE = 400;

/** The archival print. 500bp of 40 is two seats, so the fraction binds instead. */
export const SMALL_HOUSE = 40;

/** How many distinct showtimes the hourly-rate scenario needs: `max + 1`. */
export const RATE_SHOWTIMES = 7;

export interface Household {
  readonly agent_id: string;
  readonly principal_scope: string;
}

/** A customer session of that platform. Never a person, never a request member. */
export function household(label: string): Household {
  return { agent_id: AGENT, principal_scope: `ppid_${label}` };
}

/**
 * A syntactically valid `etag` derived from the id.
 *
 * The bench needs `1:` plus forty-three URL-safe characters and needs the same
 * id to yield the same bytes on every call; it does not need JCS, because
 * nothing here asserts anything about digests. C-ETAG does, over a pinned golden
 * fixture, and that fixture is frozen and is not this one.
 */
export function etagFor(seed: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let h = 2166136261;
  for (let i = 0; i < 43; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0;
    out += alphabet[h % alphabet.length];
  }
  return `1:${out}`;
}

function occasion(occasion_id: string, cluster: string | null, capacity: number): OccasionSeed {
  return {
    occasion_id,
    revision: 1,
    etag: etagFor(occasion_id),
    origin: ORIGIN,
    source: "reference",
    showtime_id: occasion_id,
    cluster,
    seating: "allocated",
    capacity,
    availability_mode: "seat_map",
    starts_at: "2027-01-29T19:00:00+13:00",
    local_wall: "2027-01-29T19:00",
    local_wall_offset: "+13:00",
    sales_cutoff_at: "2027-01-29T19:15:00+13:00",
    seats: seatGrid({ capacity, per_row: 10 }),
  };
}

/** Every Occasion the two classes need, and no others. */
export const BUDGET_ESTATE: Estate = {
  name: "c-budget/c-fanout at production defaults",
  occasions: [
    occasion("occ_slots", null, BIG_HOUSE),
    occasion("occ_seats_big", null, BIG_HOUSE),
    occasion("occ_seats_small", null, SMALL_HOUSE),
    occasion("occ_platform", null, BIG_HOUSE),
    occasion("occ_fri", CLUSTER, BIG_HOUSE),
    occasion("occ_sat", CLUSTER, BIG_HOUSE),
    ...Array.from({ length: RATE_SHOWTIMES }, (_unused, i) => occasion(`occ_rate_${i + 1}`, null, BIG_HOUSE)),
  ],
};

export interface Bench {
  readonly db: Db;
  readonly policy: HoldPolicyDocument;
  readonly budgets: ObservableBudgetGuard;
}

/**
 * Seed the bench at the **published** policy.
 *
 * `principalBudgets()` defaults to `HOLD_POLICY_PUBLISHED` and the guard is
 * constructed from it explicitly here anyway, so that the one line a reader has
 * to check — *are these the production numbers?* — is visible rather than
 * inherited from a default argument three modules away.
 */
export async function bootBudgetBench(db: Db): Promise<Bench> {
  await resetEstate(db);
  await seedEstate(db, BUDGET_ESTATE);
  await resetHoldStore(db);
  return { db, policy: HOLD_POLICY_PUBLISHED, budgets: principalBudgets(HOLD_POLICY_PUBLISHED) };
}

/** Between scenarios. The estate stays; the holds do not. */
export async function freshHolds(db: Db): Promise<void> {
  await resetHoldStore(db);
}

/** Every way a grant can end. A refusal is an answer; a SQLSTATE is a design failure. */
export type Attempt =
  | { readonly kind: "grant"; readonly hold: HoldDocument }
  | { readonly kind: "refusal"; readonly code: string; readonly detail: unknown; readonly refusal: Refusal }
  | { readonly kind: "fault"; readonly sqlstate: string | undefined; readonly message: string };

export async function attempt(
  bench: Bench,
  occasion_id: string,
  seats: readonly string[],
  who: Household,
): Promise<Attempt> {
  const occasion_etag = etagFor(occasion_id);
  try {
    const hold = await holdSeats(
      bench.db,
      {
        occasion_id,
        occasion_etag,
        sought: { occasion_id, occasion_etag },
        seats,
        requested_floor_ms: 60000,
      },
      who,
      { policy: bench.policy, budgets: bench.budgets },
    );
    return { kind: "grant", hold };
  } catch (err) {
    if (isRefusal(err)) return { kind: "refusal", code: err.code, detail: err.detail, refusal: err };
    return {
      kind: "fault",
      sqlstate: sqlstate(err),
      message: String(err instanceof Error ? err.message : err),
    };
  }
}

export async function release(bench: Bench, hold_id: string, who: Household): Promise<void> {
  await releaseHold(bench.db, hold_id, who);
}

export const grants = (outcomes: readonly Attempt[]): number =>
  outcomes.filter((o) => o.kind === "grant").length;

export const refusals = (outcomes: readonly Attempt[], code: string): number =>
  outcomes.filter((o) => o.kind === "refusal" && o.code === code).length;

export const faults = (outcomes: readonly Attempt[]): Extract<Attempt, { kind: "fault" }>[] =>
  outcomes.filter((o): o is Extract<Attempt, { kind: "fault" }> => o.kind === "fault");

export const deadlocks = (outcomes: readonly Attempt[]): number =>
  faults(outcomes).filter((f) => f.sqlstate === "40P01").length;

/** `detail.limit` off a refusal — the only ceiling the caller is ever shown. */
export function detailLimit(outcome: Attempt | undefined): number | null {
  if (outcome === undefined || outcome.kind !== "refusal") return null;
  const detail = outcome.detail;
  if (detail === null || typeof detail !== "object") return null;
  const limit = (detail as Record<string, unknown>).limit;
  return typeof limit === "number" ? limit : null;
}

/** `detail.window_ms` — zero for a concurrency ceiling, an hour for a rate. */
export function detailWindow(outcome: Attempt | undefined): number | null {
  if (outcome === undefined || outcome.kind !== "refusal") return null;
  const detail = outcome.detail;
  if (detail === null || typeof detail !== "object") return null;
  const window_ms = (detail as Record<string, unknown>).window_ms;
  return typeof window_ms === "number" ? window_ms : null;
}

interface CountRow extends Row {
  readonly n: string;
}

async function count(db: Db, sql: string, params: readonly unknown[] = []): Promise<number> {
  const r = await db.query<CountRow>(sql, [...params]);
  return Number(r.rows[0]?.n ?? 0);
}

export const holdRows = (db: Db): Promise<number> =>
  count(db, "select count(*)::text as n from hold");

export const slotRows = (db: Db): Promise<number> =>
  count(db, "select count(*)::text as n from hold_slot");

export const seatRows = (db: Db): Promise<number> =>
  count(db, "select count(*)::text as n from hold_seat");

/**
 * Seats a principal is holding on one showtime, counted the way X4 counts them.
 *
 * `sum(cardinality(h.seats))` over unreleased Holds — M2's *seats as granted* —
 * and not `count(*)` over `hold_seat`, because a Hold's seat rows survive expiry
 * until somebody contends them. Counting rows here would count seats the derived
 * state already reports as gone, and the assertion would fail against a boundary
 * that was behaving correctly.
 */
export const heldSeatsForPrincipal = (db: Db, who: Household, showtime_id: string): Promise<number> =>
  count(
    db,
    `select coalesce(sum(cardinality(seats)), 0)::text as n
       from hold
      where agent_id = $1 and principal_scope = $2 and showtime_id = $3 and released_at is null`,
    [who.agent_id, who.principal_scope, showtime_id],
  );

/** The same sum across every principal of one platform. X3's half. */
export const heldSeatsForPlatform = (db: Db, showtime_id: string): Promise<number> =>
  count(
    db,
    `select coalesce(sum(cardinality(seats)), 0)::text as n
       from hold
      where agent_id = $1 and showtime_id = $2 and released_at is null`,
    [AGENT, showtime_id],
  );

/** Holds GRANTED at this origin in the trailing hour, whatever became of them. */
export const grantsInTrailingHour = (db: Db, who: Household): Promise<number> =>
  count(
    db,
    `select count(*)::text as n
       from hold
      where agent_id = $1 and principal_scope = $2 and origin = $3
        and granted_at > now() - interval '1 hour'`,
    [who.agent_id, who.principal_scope, ORIGIN],
  );

/** Live holds a principal carries on one showtime. */
export const liveHoldsForPrincipal = (db: Db, who: Household, showtime_id: string): Promise<number> =>
  count(
    db,
    `select count(*)::text as n
       from hold
      where agent_id = $1 and principal_scope = $2 and showtime_id = $3 and released_at is null`,
    [who.agent_id, who.principal_scope, showtime_id],
  );

/** Live holds a principal carries inside one labelled cluster at one origin. */
export const liveHoldsInCluster = (db: Db, who: Household): Promise<number> =>
  count(
    db,
    `select count(*)::text as n
       from hold h join occasion o on o.occasion_id = h.occasion_id
      where h.agent_id = $1 and h.principal_scope = $2 and h.origin = $3
        and o.cluster = $4 and h.released_at is null`,
    [who.agent_id, who.principal_scope, ORIGIN, CLUSTER],
  );

/** Seat ids from one row of the grid, `A:1 … A:10`. */
export function row(letter: string, from: number, count_: number): string[] {
  return Array.from({ length: count_ }, (_unused, i) => `${letter}:${from + i}`);
}
