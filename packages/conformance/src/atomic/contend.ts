/**
 * The rig: one contender, and the questions asked of the store afterwards.
 * Owner: TEST-001.
 *
 * **Counting responses proves the server said the right thing; counting rows
 * proves it did the right thing.** A Server that returns `409` and leaves a row
 * behind passes every response-level assertion and oversells in production, so
 * every count in this module reads the store. That is not a stylistic
 * preference — §7 says C-ATOMIC asserts "zero oversell, zero partial holds",
 * and neither of those is a property of a response.
 *
 * Three outcome kinds, and the third is why this file exists. A `Refusal` is an
 * **answer**: the boundary was asked for a seat it could not give and said so,
 * with a code from the closed taxonomy. A raw SQLSTATE is a **fault**: nobody
 * decided it. `40P01` in particular is a design failure, not a refusal, and
 * collapsing it into "the call did not succeed" is exactly how a lock-ordering
 * defect survives a green suite.
 */

import type { Db, Queryable } from "@changeover/store/db.ts";
import { sqlstate } from "@changeover/store/db.ts";
import type { RefusalCode, RefusalDetail } from "@changeover/schema/refusal.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";
import type { Credential, HoldSeatsOptions } from "@changeover/core/hold-seats.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import { etagFor } from "./estate.ts";

export const AGENT_ID = "agt_conformance";

/** The occupying states. §4.6: `claimed` is deliberately among them. */
export const OCCUPYING = "('live','handed_off','claimed')";

export interface Grant {
  readonly kind: "grant";
  readonly hold_id: string;
  readonly seats: readonly string[];
}

export interface Refused {
  readonly kind: "refusal";
  readonly code: RefusalCode;
  readonly status: number;
  readonly detail?: RefusalDetail;
}

export interface Fault {
  readonly kind: "fault";
  readonly sqlstate?: string;
  readonly message: string;
}

export type Outcome = Grant | Refused | Fault;

export interface Contender {
  readonly occasion_id: string;
  readonly seats: readonly string[];
  readonly principal_scope: string;
}

/**
 * One `hold_seats`, classified. Never throws: a contender that threw would take
 * `Promise.all` down with it and the ninety-nine other outcomes would be lost
 * along with the evidence.
 */
export async function contend(
  db: Db,
  who: Contender,
  options: HoldSeatsOptions,
  requested_floor_ms: number,
): Promise<Outcome> {
  const credential: Credential = { agent_id: AGENT_ID, principal_scope: who.principal_scope };
  const occasion_etag = etagFor(who.occasion_id);
  try {
    const hold = await holdSeats(
      db,
      {
        occasion_id: who.occasion_id,
        occasion_etag,
        sought: { occasion_id: who.occasion_id, occasion_etag },
        seats: who.seats,
        requested_floor_ms,
      },
      credential,
      options,
    );
    return { kind: "grant", hold_id: hold.hold_id, seats: hold.seats };
  } catch (err) {
    if (isRefusal(err)) {
      return { kind: "refusal", code: err.code, status: err.status, detail: err.detail };
    }
    return {
      kind: "fault",
      sqlstate: sqlstate(err),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface Tally {
  readonly grants: number;
  readonly refusals: number;
  readonly faults: number;
  readonly deadlocks: number;
  /** Refusal codes seen, with counts. A 409 that is not `seat_contended` is a different claim. */
  readonly codes: Readonly<Record<string, number>>;
  readonly fault_detail: readonly string[];
}

export function tally(outcomes: readonly Outcome[]): Tally {
  const codes: Record<string, number> = {};
  let grants = 0;
  let refusals = 0;
  let deadlocks = 0;
  const fault_detail: string[] = [];
  for (const o of outcomes) {
    if (o.kind === "grant") grants++;
    else if (o.kind === "refusal") {
      refusals++;
      codes[o.code] = (codes[o.code] ?? 0) + 1;
    } else {
      if (o.sqlstate === "40P01") deadlocks++;
      fault_detail.push((o.sqlstate ?? "no-sqlstate") + " " + o.message.slice(0, 120));
    }
  }
  return { grants, refusals, faults: fault_detail.length, deadlocks, codes, fault_detail };
}

export function codeSummary(t: Tally): string {
  const entries = Object.entries(t.codes);
  return entries.length === 0 ? "none" : entries.map(([c, n]) => `${n}×${c}`).join(", ");
}

/* ── What the store says, which is the only thing that counts ──────────────── */

async function scalar(q: Queryable, sql: string, params: readonly unknown[] = []): Promise<number> {
  // `count(*)::text`: bigint arrives as a string under node-postgres and as a
  // number or bigint under PGlite. Cast in SQL, convert in TS, and the two
  // drivers stop disagreeing.
  const r = await q.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

export interface StoreCensus {
  readonly holds: number;
  readonly seat_rows: number;
  /** Rows in a seat-occupying state. The floor is stated over these. */
  readonly occupied: number;
  /** `(showtime_id, seat_id)` pairs carried by more than one occupying row. MUST be 0. */
  readonly oversold: number;
  /**
   * Holds carrying **some but not all** of their granted seats.
   *
   * Not `count(hold_seat) <> cardinality(seats)`: a reaped Hold has zero seat
   * rows and a `seats` array of two, and that is correct — M2 keeps `seats` as
   * the grant for the life of the record while the reap deletes occupancy. A
   * predicate that called the reaped Hold partial would fail .2 on the very
   * behaviour .2 exists to exercise. **All, or none.**
   */
  readonly partial: number;
  readonly slots: number;
  readonly cluster_rows: number;
}

export async function census(db: Db): Promise<StoreCensus> {
  const holds = await scalar(db, "select count(*)::text as n from hold");
  const seat_rows = await scalar(db, "select count(*)::text as n from hold_seat");
  const occupied = await scalar(
    db,
    `select count(*)::text as n from hold_seat where state in ${OCCUPYING}`,
  );
  const oversold = await scalar(
    db,
    `select count(*)::text as n from (
       select showtime_id, seat_id from hold_seat where state in ${OCCUPYING}
        group by showtime_id, seat_id having count(*) > 1) d`,
  );
  const partial = await scalar(
    db,
    `select count(*)::text as n from hold h
       join lateral (select count(*) as c from hold_seat s where s.hold_id = h.hold_id) k on true
      where k.c > 0 and k.c <> cardinality(h.seats)`,
  );
  const slots = await scalar(db, "select count(*)::text as n from hold_slot");
  const cluster_rows = await scalar(db, "select count(*)::text as n from hold_cluster");
  return { holds, seat_rows, occupied, oversold, partial, slots, cluster_rows };
}

/** Occupying rows for one seat at the shared screening. 0 or 1; 2 is an oversell. */
export async function occupantsOf(db: Db, showtime_id: string, seat_id: string): Promise<number> {
  return scalar(
    db,
    `select count(*)::text as n from hold_seat
      where showtime_id = $1 and seat_id = $2 and state in ${OCCUPYING}`,
    [showtime_id, seat_id],
  );
}

/** Every seat id this Hold has a row for, whatever its occupancy state. */
export async function rowsOfHold(db: Db, hold_id: string): Promise<string[]> {
  const r = await db.query<{ seat_id: string }>(
    "select seat_id from hold_seat where hold_id = $1 order by seat_id collate \"C\"",
    [hold_id],
  );
  return r.rows.map((row) => row.seat_id);
}

/* ── Evidence that "concurrent" meant concurrent ───────────────────────────── */

export interface RaceResult {
  readonly outcomes: Outcome[];
  /** Wall clock from the first dispatch to the last settle. */
  readonly span_ms: number;
  /** The sum of every individual call's duration. */
  readonly summed_ms: number;
  /**
   * `summed_ms / span_ms`. **One means they ran one after another.**
   *
   * This is the harness auditing itself, and it is here because the exact
   * failure the exit-2 doctrine exists to prevent — a suite reporting a pass
   * for a race it never ran — is also reachable *with* a real Postgres: a pool
   * of one, an `await` inside the dispatch loop, or a driver that serialises
   * would each turn "200 concurrent holds" into two hundred sequential ones,
   * and every assertion in .1 would still hold. They would hold for a scenario
   * nobody claimed. So the overlap is asserted, not assumed.
   */
  readonly overlap: number;
}

/** Dispatch every contender at once and measure whether they actually overlapped. */
export async function raceAll(
  db: Db,
  who: readonly Contender[],
  options: HoldSeatsOptions,
  requested_floor_ms: number,
): Promise<RaceResult> {
  const started = Date.now();
  const timed = await Promise.all(
    who.map(async (c) => {
      const at = Date.now();
      const outcome = await contend(db, c, options, requested_floor_ms);
      return { outcome, ms: Date.now() - at };
    }),
  );
  const span_ms = Math.max(1, Date.now() - started);
  const summed_ms = timed.reduce((a, x) => a + x.ms, 0);
  return {
    outcomes: timed.map((x) => x.outcome),
    span_ms,
    summed_ms,
    overlap: summed_ms / span_ms,
  };
}

/**
 * Seats of ONE physical auditorium held more than once, counted **without
 * consulting `showtime_id` at all**.
 *
 * `census().oversold` groups by `(showtime_id, seat_id)` and therefore restates
 * the key `hold_seat_occupied` is built on. That is worth asserting and it is
 * not enough: an implementation that keyed the floor on `occasion_id` — which
 * is what ADR-005 originally wrote, and the divergence survived review because
 * every golden fixture omits `showtime_ref` — writes two rows whose
 * `showtime_id`s differ, and a group-by on that pair finds no duplicate. The
 * house has sold seat `A:1` twice and the oversell counter reads zero.
 *
 * This one is given the listings by the FIXTURE, so it answers the question the
 * customer would ask: is anyone else sitting there? Measured against the
 * negative control — the two listings given distinct `showtime_id`s — it goes
 * to 100 while `census().oversold` stays at 0.
 */
export async function physicalOversell(db: Db, listing_ids: readonly string[]): Promise<number> {
  return scalar(
    db,
    `select count(*)::text as n from (
       select s.seat_id from hold_seat s
         join hold h on h.hold_id = s.hold_id
        where s.state in ${OCCUPYING} and h.occasion_id = any($1::text[])
        group by s.seat_id having count(*) > 1) d`,
    [listing_ids],
  );
}
