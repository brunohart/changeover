/**
 * `release_hold`. SPEC.md §4.8 (**R1**, **R2**), §4.9 (Z1 and the transition
 * table), §4.6 (L1, M1).
 *
 * Owner: CORE-003.
 *
 * **Total, and idempotent, with exactly one exception.**
 *
 * > **R2.** `release_hold` is **total**: `204` for every Hold the credential may
 * > address, in `live`, `released`, `expired`, `claimed` or `revoked`, and it
 * > **MUST NOT** refuse.
 *
 * Not politeness — arithmetic. Abandonment is the common case, so a cleanup
 * path that treats a non-2xx as an error logs false alarms *at a rate
 * proportional to abandonment*. Every one of those alarms is a human being
 * asked to look at a Hold that expired exactly as designed. A verb which is
 * total is a verb an operator can wire to a `finally` block and forget.
 *
 * > **R1.** `release_hold` on a `handed_off` Hold **MUST** be refused `409
 * > handoff_consumed`. Hand-off is agent-terminal: once a claim URL is minted,
 * > the Hold's disposition belongs to the customer and the exhibitor. **No
 * > Agent verb can shorten the seats' life.**
 *
 * The 409 does not free the seat, and that is the whole content of the rule.
 * The draft's guard-free `handed_off → released` row was a remote kill switch
 * on a customer standing in a checkout, and it is *exactly* what an injected
 * instruction asks for: "release the hold" arriving in a page of prose, at the
 * moment the seats have stopped being the agent's to release. Making the verb
 * refuse is what makes the instruction unreachable rather than merely
 * disobeyed.
 *
 * **What "released" does to the record.** For a `live` Hold the release is a
 * transition: `released_at` is stamped, the seat rows stop occupying, the
 * cluster row vacates and the budget slot is handed back, so the seats and the
 * budgets return together (M1 — "derived state means the budgets return with
 * them"). For a Hold that is already `released`, `claimed` or `revoked`,
 * §4.9's table says *(no change)*, and no change is what happens: a second
 * release does not re-date the first, which is what idempotent means for a verb
 * whose whole job is to be called more than once.
 */

import type { Db, Queryable } from "@changeover/store/db.ts";
import type { Rfc3339 } from "@changeover/schema/scalars.ts";
import { refuse } from "@changeover/schema/refusal.ts";
import type { Credential } from "./hold-seats.ts";
import { serverTime } from "./clock.ts";
import { lockSeats } from "./locking.ts";
import type { HoldRow, HoldState } from "./derived.ts";
import { HOLD_STATE, deriveState } from "./derived.ts";
import { loadHold, requireCredential } from "./get-hold.ts";

/* ── 1 · What the verb returns ─────────────────────────────────────────────── */

/**
 * There is no body. §6.3 gives `release_hold` a `204`, and this is what a
 * binding renders it from — the members exist so a conformance class can assert
 * *which* of R2's five states it was total in, and whether the seats came back.
 */
export interface ReleaseOutcome {
  readonly hold_id: string;
  /** R2. The only status this verb produces; every refusal is thrown, not returned. */
  readonly status: 204;
  /** M1, before the call. One of R2's five, never `handed_off` — that throws. */
  readonly state_before: HoldState;
  /** M1, after it. `released` where the call transitioned; otherwise unchanged. */
  readonly state: HoldState;
  readonly released_at: Rfc3339 | null;
  /** Seat rows that stopped occupying. `0` on every idempotent repeat. */
  readonly seats_freed: number;
  readonly server_time: Rfc3339;
}

/* ── 2 · The verb ──────────────────────────────────────────────────────────── */

/**
 * Release a Hold. `204` in `live`, `released`, `expired`, `claimed` and
 * `revoked`; `409 handoff_consumed` in `handed_off`, with the seat untouched;
 * `404 hold_not_found` for a Hold this credential may not address (Z1 — never
 * `403`, so the surface is not an existence oracle).
 */
export async function releaseHold(
  db: Db,
  hold_id: string,
  credential: Credential,
): Promise<ReleaseOutcome> {
  requireCredential(credential);

  return db.transaction(async (tx) => {
    // K4: one time source. The state this verb branches on is derived at this
    // instant and no other.
    const server_time = await serverTime(tx);

    // Z1, and the row lock the writes below run under. Locking the Hold before
    // its seats is the order every write verb in this package uses: `hold_seats`
    // reaches the seat locks with a Hold row nobody else can be holding, because
    // it has not inserted one yet, so the two orders cannot close a cycle.
    const row = await loadHold(tx, hold_id, credential, { for_update: true });
    const state_before = deriveState(row, server_time);

    // R1. First, and before any lock or write: a refusal that had already freed
    // a seat would be a refusal in name only.
    if (state_before === HOLD_STATE.handed_off) {
      throw refuse(
        "handoff_consumed",
        "These seats have been handed off to the customer and are no longer this agent's to release.",
      );
    }

    if (!FREES_SEATS.has(state_before)) {
      // §4.9: `released` / `claimed` / `revoked` → *(no change)*, 204. `claimed`
      // in particular MUST NOT be freed: it is terminal and occupies its seat
      // for the life of the screening.
      return outcome(row, state_before, state_before, row.released_at, 0, server_time);
    }

    // L1: an exclusive lock per (showtime_id, seat_id), in ascending byte order
    // under the C collation, over the full seat set, in the same transaction as
    // the write. Freeing a seat is a write to the same rows a contending
    // `hold_seats` reaps and inserts, so it takes the same locks in the same
    // order; a release that skipped them would deadlock against the grant path
    // only under load, which is the one place it would never be found.
    await lockSeats(tx, row.showtime_id, row.seats);

    const seats_freed = await vacate(tx, row, state_before);

    // §4.9: `live` → `released`. `expired` → *(no change)* — the seats and the
    // budgets come back, but the Hold does not become something it never was.
    // A Hold that ran out is `expired` forever, and an operator reading the
    // record later can tell abandonment from a clean release.
    let released_at = row.released_at;
    let state_after = state_before;
    if (state_before === HOLD_STATE.live) {
      // T1 is not in play here and it looks as though it should be: it binds the
      // *Server* not to take an Agent's seats back before `floor_deadline`. The
      // floor is the Agent's guarantee against the house, and an Agent handing
      // its own seats back early is the path §4.8 is written to make cheap.
      const updated = await tx.query<{ released_at: Rfc3339 }>(
        "update hold set released_at = $2::timestamptz where hold_id = $1 and released_at is null" +
          " returning to_json(released_at)#>>'{}' as released_at",
        [hold_id, server_time],
      );
      released_at = updated.rows[0]?.released_at ?? released_at;
      state_after = HOLD_STATE.released;
    }

    return outcome(row, state_before, state_after, released_at, seats_freed, server_time);
  });
}

/** The two states in which a release still has seats or budget to hand back. */
const FREES_SEATS: ReadonlySet<HoldState> = new Set<HoldState>([
  HOLD_STATE.live,
  HOLD_STATE.expired,
]);

/**
 * Stop occupying: the seat rows, the cluster row, and the budget slot.
 *
 * The seat rows are **marked**, not deleted, and marked with the state the Hold
 * itself derives — `released` for a release, `expired` for a Hold that had
 * already run out. `hold_seat_occupied`'s predicate is `state in ('live',
 * 'handed_off', 'claimed')`, so a marked row leaves the unique index and the
 * seat is immediately re-holdable, while the record of which seats this Hold
 * occupied survives for the access log to be reconciled against. The reap
 * deletes instead, because it is running inside somebody else's transaction and
 * has no business paying for a second index write.
 *
 * `hold_slot` is deleted rather than marked: it has no state column by design
 * (SPEC.md:370), because a slot is *occupancy*, and X1's `(max+1)`th insert
 * must collide with a primary key rather than be counted by a query.
 */
async function vacate(tx: Queryable, row: HoldRow, state_before: HoldState): Promise<number> {
  const seat_state = state_before === HOLD_STATE.live ? HOLD_STATE.released : HOLD_STATE.expired;

  const seats = await tx.query(
    "update hold_seat set state = $2 where hold_id = $1 and state in ('live', 'handed_off')",
    [row.hold_id, seat_state],
  );
  await tx.query(
    "update hold_cluster set state = $2 where hold_id = $1 and state in ('live', 'handed_off')",
    [row.hold_id, seat_state],
  );
  await tx.query("delete from hold_slot where hold_id = $1", [row.hold_id]);
  return seats.rowCount;
}

function outcome(
  row: HoldRow,
  state_before: HoldState,
  state: HoldState,
  released_at: Rfc3339 | null,
  seats_freed: number,
  server_time: Rfc3339,
): ReleaseOutcome {
  return {
    hold_id: row.hold_id,
    status: 204,
    state_before,
    state,
    released_at,
    seats_freed,
    server_time,
  };
}
