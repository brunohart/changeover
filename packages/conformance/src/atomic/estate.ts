/**
 * The C-ATOMIC fixture: **two Occasions sharing one `showtime_id`**. Owner: TEST-001.
 *
 * `hold_seat_occupied` is `UNIQUE (showtime_id, seat_id)` — the physical
 * screening, not the listing — and `showtime_ref` exists precisely so a
 * publisher may map several Occasions onto one screening: a premiere and a
 * standard listing of the same 7pm show, or two price bands sold as separate
 * Occasions. Keyed on `occasion_id` instead, two such listings could each hold
 * seat `F:11` and the house would sell one seat twice.
 *
 * `packages/store/src/audit.ts` asserts exactly that, sequentially, on one
 * connection: two inserts, the second raising `23505`. This is its concurrent
 * sibling, and the reason it is the sharpest fixture available is that the
 * cross-listing pair is the one collision a per-listing lock, a per-listing
 * count, or a per-listing cache would all get wrong — every one of which passes
 * a single-listing race.
 *
 * Two other choices, both made so that a `409` in this harness can mean exactly
 * one thing:
 *
 *  - **`cluster` is null on both listings.** A non-null cluster puts a row in
 *    `hold_cluster`, whose `hold_cluster_live` unique index maps to
 *    `429 cluster_fanout`. With budgets disabled that index is still a database
 *    object and still fires; a contender refused by it would be counted as a
 *    seat refusal and .1's "exactly 100 typed 409" would hold for the wrong
 *    reason.
 *  - **Every contender carries its own `principal_scope`.** Two hundred
 *    concurrent callers are two hundred customers, not one customer asking two
 *    hundred times. It also means no per-principal index can collide.
 *
 * The dates are computed from `now`, not written down. A fixture with a
 * hard-coded `starts_at` passes until the date goes by and then fails as a
 * `sales_cutoff` refusal that names nothing about atomicity.
 */

import type { Estate, OccasionSeed } from "@changeover/store/fixtures.ts";
import { seatGrid } from "@changeover/store/fixtures.ts";
import type { AtomicProfile } from "./profile.ts";
import { C_ATOMIC_PROFILE } from "./profile.ts";

/** One physical screening. Both listings below carry it. */
export const ATOMIC_SHOWTIME = "shw_atomic_1900";
export const ATOMIC_ORIGIN = "https://atomic.example";

/** The two listings of that screening. */
export const LISTING = {
  premiere: "occ_atomic_premiere",
  standard: "occ_atomic_standard",
} as const;

export type ListingId = (typeof LISTING)[keyof typeof LISTING];
export const LISTINGS: readonly ListingId[] = Object.freeze([LISTING.premiere, LISTING.standard]);

/**
 * A deterministic etag of the frozen shape `1:<43 base64url>`.
 *
 * It is not a PROJECTION_0_1 digest and does not pretend to be: `holdSeats`
 * compares the request's etag with the one the store carries, and what is under
 * test here is contention, not the projection. C-ETAG owns that claim and pins
 * it against the golden fixtures; minting a look-alike here would put a second,
 * unpinned etag implementation in the tree.
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

function listing(occasion_id: string, profile: AtomicProfile, now: Date): OccasionSeed {
  const starts = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const iso = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "+00:00");
  return {
    occasion_id,
    revision: 1,
    etag: etagFor(occasion_id),
    origin: ATOMIC_ORIGIN,
    source: "reference",
    // The whole point of the fixture.
    showtime_id: ATOMIC_SHOWTIME,
    cluster: null,
    seating: "allocated",
    capacity: profile.house_capacity,
    availability_mode: "seat_map",
    starts_at: iso(starts),
    local_wall: iso(starts).slice(0, 16),
    local_wall_offset: "+00:00",
    sales_cutoff_at: iso(new Date(starts.getTime() + 15 * 60 * 1000)),
    document: { book_url: ATOMIC_ORIGIN + "/book/" + occasion_id },
    // capacity === availability: every seat is holdable, so a shortfall in .1
    // is a violation and never a sold seat.
    seats: seatGrid({ capacity: profile.house_capacity, per_row: profile.seats_per_row }),
  };
}

export function atomicEstate(
  profile: AtomicProfile = C_ATOMIC_PROFILE,
  now: Date = new Date(),
): Estate {
  return {
    name: "c-atomic-two-listings-one-showtime",
    occasions: LISTINGS.map((id) => listing(id, profile, now)),
  };
}

/** The house's seat ids, in the order `seatGrid` laid them out. Identical at both listings. */
export function atomicSeatIds(profile: AtomicProfile = C_ATOMIC_PROFILE): string[] {
  return seatGrid({ capacity: profile.house_capacity, per_row: profile.seats_per_row }).map(
    (seat) => seat.seat_id,
  );
}

/** A seat id no listing published. `.4`'s invalid half — W1's `400 unknown_seat`. */
export const UNKNOWN_SEAT = "ZZ:999";
