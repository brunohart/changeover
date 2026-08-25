/**
 * L1 and L2 — the lock discipline that makes `40P01` unreachable rather than
 * unlikely.
 *
 * Owner: CORE-002.
 *
 * > **L1.** Before any reap or insert a Server **MUST** acquire an exclusive
 * > lock per `(showtime_id, seat_id)` in ascending byte order of `seat_id` under
 * > the **C** collation, over the **full requested seat set**, irrespective of
 * > whether a hold row exists for that seat, in the same transaction as the
 * > insert.
 * > **L2.** The reap and insert **MUST** execute under those locks and **MUST
 * > NOT** acquire seat locks of their own.
 *
 * Three words in L1 are each load-bearing and each easy to drop.
 *
 * **"full requested seat set."** Not the contended seats; not the seats that
 * have rows. SPEC.md §4.6 says why, and it is the subtlest sentence in the
 * specification: *"the reap can only lock rows that exist and are doomed at its
 * own start, and a free seat has no row, so two transactions over one seat set
 * compute different lock sequences and deadlock across an expiry boundary while
 * obeying the rule exactly."* An implementation that locks lazily is correct on
 * every test that does not straddle an expiry and deadlocks in production.
 *
 * **"ascending byte order under the C collation."** Not the database's default
 * collation, which is locale-dependent and orders `A:10` before `A:2` in some
 * locales and after it in others — two nodes with different `lc_collate` then
 * compute different sequences and deadlock against each other. {@link sortCSeats}
 * sorts by UTF-8 bytes in the process, which is exactly what `COLLATE "C"` means
 * and is identical on every machine. It is deliberately not `Array.sort()`'s
 * default: that compares UTF-16 code units, which disagrees with byte order for
 * anything above the BMP.
 *
 * **"irrespective of whether a hold row exists."** The lock is on the *seat*,
 * not on a row, which is why it is an advisory lock keyed by `(showtime_id,
 * seat_id)` and not `SELECT … FOR UPDATE`. There is nothing to lock for a free
 * seat, and a free seat is precisely the one two transactions are racing for.
 *
 * **One statement per seat, issued in order by the client.** The specification's
 * own sketch locks in a single `SELECT … FROM unnest(…) ORDER BY s COLLATE "C"`.
 * That is one round trip, and the order in which the planner evaluates a volatile
 * function across a sorted scan is a planner property, not a contract — the very
 * thing L1 exists to remove from the picture. Here the sequence is decided in
 * this process, before any SQL is sent, so it is identical under both drivers,
 * observable in the emitted statements, and asserted from them by
 * `scripts/prove_lock_order.sh`. The cost is at most twelve round trips
 * (`max_seats_per_hold` caps `seats` at 12) on a connection that is about to do
 * far more work than that.
 *
 * On the lock key: L1 says `(showtime_id, seat_id)` and this module uses exactly
 * that. Note that `hold_seat_occupied` — the unique index that makes oversell
 * unrepresentable — is keyed on `(occasion_id, seat_id)` (CORE-001, reported as a
 * spec defect where the two differ). The lock is therefore the *stronger* of the
 * two domains: where several Occasions map onto one physical screening, two
 * writers for the same seat still serialise here even though the index would not
 * see them as a conflict. The occupancy read and the reap use `showtime_id` for
 * the same reason.
 */

import type { Queryable } from "@changeover/store/db.ts";

/**
 * The lock statement. One seat, one call, one round trip.
 *
 * `pg_advisory_xact_lock` releases at COMMIT or ROLLBACK with no explicit unlock
 * and no path that can leak one — an exclusive row lock the transaction forgot
 * to take is a bug; an advisory transaction lock the transaction forgot to
 * release is not representable.
 *
 * The key is `hashtextextended(showtime_id || ':' || seat_id, 0)`, exactly the
 * expression SPEC.md §4.6 gives. Both operands arrive as `$1`/`$2` parameters:
 * the key is built in the database, so a seat id containing a colon cannot be
 * made to collide with a different `(showtime_id, seat_id)` pair by string
 * surgery in this process.
 */
export const SEAT_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))";

/**
 * Ascending byte order under the **C** collation.
 *
 * `COLLATE "C"` is byte order over the encoded text, and Postgres encodes as
 * UTF-8, so this compares UTF-8 buffers. `[...ids].sort()` would compare UTF-16
 * code units instead: identical for ASCII seat ids, and different for anything
 * outside the Basic Multilingual Plane — a divergence that costs nothing until a
 * venue names a seat with an emoji and two nodes disagree about the lock order.
 */
export function sortCSeats(seat_ids: readonly string[]): string[] {
  return [...seat_ids].sort(compareC);
}

/** `COLLATE "C"` as a comparator: memcmp over the UTF-8 encoding. */
export function compareC(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Take the seat locks. **Unconditionally, over the whole set, before anything
 * else in the transaction touches a seat.**
 *
 * There is deliberately no `only_contended` option, no early return for an empty
 * intersection, and no branch of any kind: every argument that could shorten this
 * sequence is an argument for a deadlock that appears only under load. The
 * function returns the sequence it locked in, so a caller — and
 * `scripts/prove_lock_order.sh` — can assert the order without reading a comment
 * about it.
 *
 * `seat_ids` is expected to be duplicate-free: W2 refuses a duplicate-bearing
 * array at G1 step 2, "before any lock is taken". A duplicate that reached here
 * would lock one key twice, which Postgres treats as a re-entrant acquisition and
 * which is therefore harmless — but it would also mean W2 did not run, so the
 * count returned here is the count the proof compares against the request.
 */
export async function lockSeats(
  tx: Queryable,
  showtime_id: string,
  seat_ids: readonly string[],
): Promise<string[]> {
  const ordered = sortCSeats(seat_ids);
  for (const seat_id of ordered) {
    await tx.query(SEAT_LOCK_SQL, [showtime_id, seat_id]);
  }
  return ordered;
}
