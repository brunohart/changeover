/**
 * The C-ATOMIC harness profile. Owner: TEST-001.
 *
 * §7 does not merely say "200 concurrent holds on a 100-seat house". It says
 * **"Harness profile stated: budgets disabled, `max_seats_per_hold: 1`, fixed
 * seed."** — and the reason the profile is part of the assertion rather than an
 * implementation detail is that *200 against 100* means nothing if the reader
 * cannot tell what the budgets were doing.
 *
 * Budgets are disabled deliberately. With X1's `max_live_holds_per_showtime`
 * live, the hundred calls that failed could have failed because a fan-out cap
 * bound first — and from outside the boundary a `429 hold_budget_exhausted` and
 * a `409 seat_contended` are indistinguishable. The atomicity claim would be
 * untested while the suite showed green. TEST-002 runs the same shape at
 * production defaults with budgets **on**; that split is what lets a refusal be
 * attributed to one mechanism.
 *
 * Two deviations from the single stated profile, both named here rather than
 * buried in a call site, because an unstated deviation is how a profile becomes
 * a decoration:
 *
 *  - **.4 raises `max_seats_per_hold` to 2.** A one-valid-plus-one-invalid
 *    request is definitionally a two-seat request; at 1 the wire guard refuses
 *    it before a lock is taken and the all-or-nothing property is never
 *    exercised at all.
 *  - **.2 seeds its doomed Holds at two seats each.** The contenders stay at
 *    one seat, per the profile. The *fixture* has to span more than one seat or
 *    the asymmetry §4.6 names cannot exist: a reap that can only lock rows that
 *    exist and are doomed at its own start computes a different lock sequence
 *    from a transaction locking the whole requested set, and the two deadlock
 *    across an expiry boundary while obeying the ordering rule exactly. With
 *    every Hold one seat wide there is no sequence to disagree about, and .2
 *    would report zero `40P01` for the same reason a suite with no tests does.
 */

export interface AtomicProfile {
  /** Fixed, so that two runs contend over the same seats in the same order. */
  readonly seed: string;
  readonly house_capacity: number;
  readonly seats_per_row: number;
  /** Two listings of one physical screening. See `estate.ts`. */
  readonly listings: number;
  /** Concurrent `hold_seats` calls dispatched at once. §7: 200. */
  readonly trials: number;
  /** §7, verbatim. `BUDGETS_UNENFORCED` is what implements it. */
  readonly budgets: "disabled";
  /** §7, verbatim, for every contender in .1 and .2. */
  readonly max_seats_per_hold: number;
  /** .4 only, and only because a two-seat request needs two seats. */
  readonly max_seats_per_hold_all_or_nothing: number;
  /** Seats each doomed fixture Hold in .2 covers. See the note above. */
  readonly doomed_hold_seats: number;
  /** §7 .2: "50% of the seat set carries rows expiring within ±100ms". */
  readonly doomed_fraction: number;
  readonly expiry_window_ms: number;
  /** The floor every contender requests. `floor_ms >= 1000` is a CHECK. */
  readonly requested_floor_ms: number;
  /**
   * Connections in the pool. Stated because "concurrent" is a claim about the
   * server, and 200 dispatched over a pool of 1 would be a queue with a
   * flattering name.
   */
  readonly pool_size: number;
}

export const C_ATOMIC_PROFILE: AtomicProfile = Object.freeze({
  seed: "c-atomic-2026.1",
  house_capacity: 100,
  seats_per_row: 10,
  listings: 2,
  trials: 200,
  budgets: "disabled",
  max_seats_per_hold: 1,
  max_seats_per_hold_all_or_nothing: 2,
  doomed_hold_seats: 2,
  doomed_fraction: 0.5,
  expiry_window_ms: 100,
  requested_floor_ms: 60000,
  pool_size: 32,
});

/** The profile, as the lines a report and a proof script both print. */
export function profileLines(p: AtomicProfile = C_ATOMIC_PROFILE): string[] {
  return [
    `harness profile — budgets ${p.budgets}, max_seats_per_hold ${p.max_seats_per_hold}, seed "${p.seed}"`,
    `                  house ${p.house_capacity} seats across ${p.listings} listings of ONE showtime, ` +
      `${p.trials} concurrent holds over a pool of ${p.pool_size} connections`,
    `                  .2 ages ${Math.round(p.doomed_fraction * 100)}% of the seat set to expire within ` +
      `±${p.expiry_window_ms}ms of the instant the contenders fire, in Holds ${p.doomed_hold_seats} seats wide`,
    `                  .4 raises max_seats_per_hold to ${p.max_seats_per_hold_all_or_nothing}, because a ` +
      `one-valid-plus-one-invalid request is a two-seat request`,
  ];
}

/* ── The fixed seed ────────────────────────────────────────────────────────── */

/**
 * mulberry32. Small, exactly reproducible, and — the only property that matters
 * here — not `Math.random()`. §7 says *fixed seed* because "exactly 100
 * succeed" over a randomised firing order is a statement about a coin.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the seed string, so the profile can carry a name rather than a number. */
export function seedNumber(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/** Fisher–Yates, driven by the seeded generator. Returns a new array. */
export function seededShuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const swap = out[i] as T;
    out[i] = out[j] as T;
    out[j] = swap;
  }
  return out;
}
