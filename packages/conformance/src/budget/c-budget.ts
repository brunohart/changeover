/**
 * **C-BUDGET** — the exhaustion ceilings, at the numbers the Server publishes.
 *
 * Owner: TEST-002. §7: *"The same scenario at **production defaults**: `max+1`
 * concurrent holds → exactly `max` succeed … Budgets bind in-transaction."*
 *
 * Four things separate this module from the sequential proof CORE-006 already
 * ships beside its own code:
 *
 * 1. **The numbers are checked against §2.5 itself**, parsed at run time — see
 *    `published.ts`. Every ceiling below is asserted at `HOLD_POLICY_PUBLISHED`
 *    and that object is asserted to be the specification's published defaults.
 * 2. **Every ceiling is recomputed here from the document**, not read back from
 *    the function under test. `seatCeiling()` deciding that 500bp of a 40-seat
 *    house is two seats, and this module asserting that the refusal named two,
 *    is one implementation agreeing with itself. The arithmetic is written out
 *    below instead.
 * 3. **`max_holds_per_site_per_hour` is a rate and is tested as one.** Every
 *    hold is released before the next is asked for, so nothing is live when the
 *    seventh is refused. A concurrency ceiling wearing a rate's name passes any
 *    test that does not do that, and no test in this repository did.
 * 4. **The 40-seat house.** X4's ceiling is `min(absolute, fraction × capacity)`
 *    and on a 400-seat room the absolute half always wins, so the fraction —
 *    the half that exists *"so a small house is not sold out by one credential"*
 *    — was never the number that refused anybody.
 *
 * The concurrent half of every scenario runs against a real Postgres and is the
 * only half that can tell a lock from a `SELECT`. §4.6: *"at READ COMMITTED two
 * `hold_seats` three milliseconds apart both count zero live holds in a cluster,
 * both pass, both commit."* Three of the ceilings below are lock-backed rather
 * than constraint-backed — the hourly rate, the per-principal seat ceiling and
 * the platform seat fraction — and for those, this file is the entire evidence.
 */

import type { ClassOutcome, Check, Observation } from "./observed.ts";
import { verdictOf } from "./observed.ts";
import type { PublishedTable } from "./published.ts";
import { statedAs } from "./published.ts";
import type { Attempt, Bench } from "./estate.ts";
import {
  BIG_HOUSE,
  RATE_SHOWTIMES,
  SMALL_HOUSE,
  attempt,
  deadlocks,
  detailLimit,
  detailWindow,
  faults,
  freshHolds,
  grants,
  grantsInTrailingHour,
  heldSeatsForPlatform,
  heldSeatsForPrincipal,
  holdRows,
  household,
  liveHoldsForPrincipal,
  refusals,
  release,
  row,
  seatRows,
  slotRows,
} from "./estate.ts";

export const C_BUDGET = {
  class_id: "C-BUDGET",
  asserts:
    "the published exhaustion ceilings bind at the defaults SPEC.md §2.5 states, " +
    "in-transaction, and refuse naming the same number the document publishes",
} as const;

const held = (statement: string): Check => ({ held: true, statement });
const broke = (statement: string): Check => ({ held: false, statement });
const assert = (condition: boolean, whenHeld: string, whenNot: string): Check =>
  condition ? held(whenHeld) : broke(whenNot);

/** `detail.limit`, `detail.window_ms` rendered as the caller receives them. */
function refusedWith(outcome: Attempt | undefined): string {
  if (outcome === undefined || outcome.kind !== "refusal") return "—";
  const limit = detailLimit(outcome);
  const window_ms = detailWindow(outcome);
  const parts = [`limit ${limit === null ? "absent" : String(limit)}`];
  if (window_ms !== null) parts.push(`window_ms ${String(window_ms)}`);
  return `${outcome.code} (${parts.join(", ")})`;
}

function faultText(outcomes: readonly Attempt[]): string {
  return faults(outcomes)
    .map((f) => `${f.sqlstate ?? "?"} ${f.message}`)
    .join(" | ");
}

/* ── the sequential half ───────────────────────────────────────────────────── */

export async function sequential(bench: Bench, table: PublishedTable): Promise<ClassOutcome> {
  const checks: Check[] = [];
  const observations: Observation[] = [];
  const policy = bench.policy;
  let trials = 0;

  /* 1 · X1 · max_live_holds_per_showtime — constraint-backed, per principal. */
  {
    await freshHolds(bench.db);
    const who = household("slots_seq");
    const max = policy.max_live_holds_per_showtime;
    const outcomes: Attempt[] = [];
    for (let i = 0; i < max + 1; i++) {
      outcomes.push(await attempt(bench, "occ_slots", [`A:${i + 1}`], who));
      trials++;
    }
    const last = outcomes[outcomes.length - 1];
    const observed = await liveHoldsForPrincipal(bench.db, who, "occ_slots");

    checks.push(
      assert(
        grants(outcomes) === max && observed === max,
        `X1 · ${max + 1} sequential holds at the published max_live_holds_per_showtime=${max} left exactly ${max} live`,
        `X1 · ${grants(outcomes)} grants and ${observed} live holds, at a published ceiling of ${max}`,
      ),
    );
    checks.push(
      assert(
        last?.kind === "refusal" && last.code === "hold_budget_exhausted" && detailLimit(last) === max,
        `X1 · the (max+1)th is 429 hold_budget_exhausted naming limit ${max} — the caller is told the number, not "an invalid request"`,
        `X1 · the (max+1)th ended as ${refusedWith(last)}`,
      ),
    );
    checks.push(
      assert(
        detailWindow(last) === 0,
        "X1 · window_ms 0 tells an Agent with no eyes that this is a concurrency ceiling and not a rate",
        `X1 · window_ms was ${String(detailWindow(last))} on a concurrency ceiling`,
      ),
    );
    checks.push(
      assert(
        (await holdRows(bench.db)) === max && (await slotRows(bench.db)) === max && (await seatRows(bench.db)) === max,
        `X1 · the store carries exactly ${max} holds, ${max} slots and ${max} seat rows — the refusal wrote nothing`,
        `X1 · store carries ${await holdRows(bench.db)} holds, ${await slotRows(bench.db)} slots, ${await seatRows(bench.db)} seat rows`,
      ),
    );

    observations.push({
      rule: "X1",
      member: "max_live_holds_per_showtime",
      published: `${statedAs(table, "max_live_holds_per_showtime")} (= ${max})`,
      observed: `${observed} live holds`,
      refused_with: refusedWith(last),
      concurrent: false,
      counting: "live Holds one principal carries on one showtime, backed by the hold_slot primary key",
    });
  }

  /* 2 · X1 · max_holds_per_site_per_hour — a RATE, and released holds still count. */
  {
    await freshHolds(bench.db);
    const who = household("rate_seq");
    const max = policy.max_holds_per_site_per_hour;
    const outcomes: Attempt[] = [];
    for (let i = 0; i < RATE_SHOWTIMES; i++) {
      const outcome = await attempt(bench, `occ_rate_${i + 1}`, ["A:1"], who);
      trials++;
      outcomes.push(outcome);
      // Released immediately, so nothing this ceiling refuses is being held.
      if (outcome.kind === "grant") await release(bench, outcome.hold.hold_id, who);
    }
    const last = outcomes[outcomes.length - 1];
    const granted = await grantsInTrailingHour(bench.db, who);
    const live = await liveHoldsForPrincipal(bench.db, who, `occ_rate_${RATE_SHOWTIMES}`);

    checks.push(
      assert(
        grants(outcomes) === max && granted === max,
        `X1 · exactly ${max} holds were granted at this origin in the trailing hour, at a published max_holds_per_site_per_hour=${max}`,
        `X1 · ${grants(outcomes)} grants and ${granted} rows inside the hour, at a published ${max}`,
      ),
    );
    checks.push(
      assert(
        last?.kind === "refusal" && last.code === "hold_budget_exhausted" && detailLimit(last) === max,
        `X1 · the (max+1)th is 429 hold_budget_exhausted naming limit ${max}`,
        `X1 · the (max+1)th ended as ${refusedWith(last)}`,
      ),
    );
    checks.push(
      assert(
        detailWindow(last) === 3600000,
        "X1 · window_ms 3600000 distinguishes the rate from every concurrency ceiling that shares its refusal code",
        `X1 · the rate refusal carried window_ms ${String(detailWindow(last))}, not one hour`,
      ),
    );
    checks.push(
      assert(
        live === 0,
        "X1 · every earlier hold had been RELEASED and the (max+1)th was still refused — releasing does not buy another, so this is a rate and not a concurrency ceiling wearing its name",
        `X1 · ${live} holds were still live, so the refusal could have been a concurrency ceiling`,
      ),
    );

    observations.push({
      rule: "X1",
      member: "max_holds_per_site_per_hour",
      published: `${statedAs(table, "max_holds_per_site_per_hour")} (= ${max})`,
      observed: `${granted} grants in the hour, ${live} live`,
      refused_with: refusedWith(last),
      concurrent: false,
      counting: "Holds granted at one origin in the trailing hour, whatever became of them, under an advisory lock on that scope",
    });
  }

  /* 3 · X4 · the ABSOLUTE half, on the 400-seat house. */
  {
    await freshHolds(bench.db);
    const who = household("seats_big_seq");
    const absolute = policy.max_live_seats_per_showtime;
    const proportional = Math.floor((policy.max_held_seat_fraction_bp * BIG_HOUSE) / 10000);
    const ceiling = Math.max(1, Math.min(absolute, proportional));

    const first = await attempt(bench, "occ_seats_big", row("A", 1, ceiling), who);
    const second = await attempt(bench, "occ_seats_big", ["B:1"], who);
    trials += 2;
    const observed = await heldSeatsForPrincipal(bench.db, who, "occ_seats_big");

    checks.push(
      assert(
        ceiling === absolute,
        `X4 · on a ${BIG_HOUSE}-seat house min(${absolute}, ${policy.max_held_seat_fraction_bp}bp × ${BIG_HOUSE} / 10000 = ${proportional}) is the ABSOLUTE half, ${ceiling}`,
        `X4 · the arithmetic gives ${ceiling}, which is not the absolute half`,
      ),
    );
    checks.push(
      assert(
        first.kind === "grant" && observed === ceiling,
        `X4 · a principal holds ${ceiling} seats on one showtime and no more`,
        `X4 · the principal holds ${observed} seats after a ${first.kind}`,
      ),
    );
    checks.push(
      assert(
        second.kind === "refusal" && second.code === "seat_budget_exhausted" && detailLimit(second) === ceiling,
        `X4 · the next seat is 429 seat_budget_exhausted naming limit ${ceiling}`,
        `X4 · the next seat ended as ${refusedWith(second)}`,
      ),
    );

    observations.push({
      rule: "X4",
      member: "max_live_seats_per_showtime",
      published: `${statedAs(table, "max_live_seats_per_showtime")}, binding as min(${absolute}, ${proportional}) = ${ceiling}`,
      observed: `${observed} seats`,
      refused_with: refusedWith(second),
      concurrent: false,
      counting: `a principal's live held seats on one showtime, at a house of ${BIG_HOUSE}`,
    });
  }

  /* 4 · X4 · the PROPORTIONAL half, on the 40-seat house. */
  {
    await freshHolds(bench.db);
    const who = household("seats_small_seq");
    const absolute = policy.max_live_seats_per_showtime;
    const proportional = Math.floor((policy.max_held_seat_fraction_bp * SMALL_HOUSE) / 10000);
    const ceiling = Math.max(1, Math.min(absolute, proportional));

    const over = await attempt(bench, "occ_seats_small", row("A", 1, ceiling + 1), who);
    const exact = await attempt(bench, "occ_seats_small", row("A", 1, ceiling), who);
    const more = await attempt(bench, "occ_seats_small", ["D:9"], who);
    trials += 3;
    const observed = await heldSeatsForPrincipal(bench.db, who, "occ_seats_small");

    checks.push(
      assert(
        ceiling === proportional && ceiling < absolute,
        `X4 · on a ${SMALL_HOUSE}-seat house the FRACTION binds first: ${policy.max_held_seat_fraction_bp}bp × ${SMALL_HOUSE} / 10000 = ${proportional}, below the absolute ${absolute}`,
        `X4 · the fraction gives ${proportional} and the absolute ${absolute}; the fraction is not the binding half here`,
      ),
    );
    checks.push(
      assert(
        over.kind === "refusal" && over.code === "seat_budget_exhausted" && detailLimit(over) === ceiling,
        `X4 · ${ceiling + 1} seats at once is 429 seat_budget_exhausted naming limit ${ceiling} — one credential cannot take the archival print`,
        `X4 · ${ceiling + 1} seats ended as ${refusedWith(over)}`,
      ),
    );
    checks.push(
      assert(
        exact.kind === "grant" && more.kind === "refusal" && observed === ceiling,
        `X4 · ${ceiling} seats are granted, the next one is refused, and the principal holds exactly ${ceiling}`,
        `X4 · ${exact.kind} then ${more.kind}, principal holding ${observed} seats`,
      ),
    );
    checks.push(
      assert(
        (await holdRows(bench.db)) === 1,
        "X4 · exactly one hold row exists — both refusals wrote nothing",
        `X4 · ${await holdRows(bench.db)} hold rows exist, expected 1`,
      ),
    );

    observations.push({
      rule: "X4",
      member: "max_held_seat_fraction_bp",
      published: `${statedAs(table, "max_held_seat_fraction_bp")}, binding as min(${absolute}, ${proportional}) = ${ceiling}`,
      observed: `${observed} seats`,
      refused_with: refusedWith(over),
      concurrent: false,
      counting: `a principal's live held seats on one showtime, at a house of ${SMALL_HOUSE}`,
    });
  }

  /* 5 · X3 · max_held_fraction_per_showtime — per PLATFORM, across principals. */
  {
    await freshHolds(bench.db);
    const a = household("platform_a_seq");
    const b = household("platform_b_seq");
    const c = household("platform_c_seq");
    const ceiling = Math.max(1, Math.floor(policy.max_held_fraction_per_showtime * BIG_HOUSE));
    const each = policy.max_live_seats_per_showtime;

    const first = await attempt(bench, "occ_platform", row("A", 1, each), a);
    const overshoot = await attempt(bench, "occ_platform", row("B", 1, each), b);
    const fits = await attempt(bench, "occ_platform", row("B", 1, ceiling - each), b);
    const oneMore = await attempt(bench, "occ_platform", ["C:1"], c);
    trials += 4;
    const observed = await heldSeatsForPlatform(bench.db, "occ_platform");

    checks.push(
      assert(
        first.kind === "grant" && overshoot.kind === "refusal" && detailLimit(overshoot) === ceiling,
        `X3 · a second principal asking for ${each} more is 429 seat_budget_exhausted naming limit ${ceiling} = ${policy.max_held_fraction_per_showtime} × ${BIG_HOUSE}`,
        `X3 · first ${first.kind}, second ${refusedWith(overshoot)}`,
      ),
    );
    checks.push(
      assert(
        fits.kind === "grant" && observed === ceiling,
        `X3 · the platform reaches exactly ${ceiling} seats on this showtime — ${policy.max_held_fraction_per_showtime * 100}% of the house`,
        `X3 · the platform holds ${observed} seats, expected ${ceiling}`,
      ),
    );
    checks.push(
      assert(
        oneMore.kind === "refusal" && oneMore.code === "seat_budget_exhausted",
        "X3 · a THIRD principal is refused for the platform's total, not its own — the blast radius of one misbehaving platform is bounded",
        `X3 · the third principal got ${oneMore.kind === "grant" ? "a grant" : refusedWith(oneMore)}`,
      ),
    );

    observations.push({
      rule: "X3",
      member: "max_held_fraction_per_showtime",
      published: `${statedAs(table, "max_held_fraction_per_showtime")}, binding as ${policy.max_held_fraction_per_showtime} × ${BIG_HOUSE} = ${ceiling}`,
      observed: `${observed} seats across 3 principals`,
      refused_with: refusedWith(oneMore),
      concurrent: false,
      counting: "one agent platform's live held seats on one showtime, summed over every principal it serves",
    });
  }

  /* 6 · §2.5's converse — nothing was enforced that the document does not carry. */
  {
    const consulted = bench.budgets.consulted;
    const document = bench.policy as unknown as Record<string, unknown>;
    const unpublished = consulted.filter((name) => !Object.hasOwn(document, name));
    checks.push(
      assert(
        consulted.length > 0 && unpublished.length === 0,
        `§2.5 · ${consulted.length} ceilings were observed being enforced and every one is a published member: ${consulted.join(", ")}`,
        unpublished.length > 0
          ? `§2.5 · ${unpublished.join(", ")} was enforced and the published document carries no such member`
          : "§2.5 · no ceiling was observed being enforced at all, so the converse is vacuous",
      ),
    );
  }

  return {
    class_id: C_BUDGET.class_id,
    verdict: verdictOf(checks),
    checks,
    observations,
    trials,
  };
}

/* ── the concurrent half ───────────────────────────────────────────────────── */

/**
 * The same ceilings with the callers genuinely simultaneous.
 *
 * Every assertion here is unreachable on one connection. The three lock-backed
 * ceilings — the hourly rate, the per-principal seat ceiling, the platform seat
 * fraction — are counted by a `SELECT` that is correct **only** because a lock
 * is held across it, and nothing but two real connections can tell that from a
 * `SELECT` with no lock at all.
 */
export async function concurrent(bench: Bench, table: PublishedTable): Promise<ClassOutcome> {
  const checks: Check[] = [];
  const observations: Observation[] = [];
  const policy = bench.policy;
  let trials = 0;

  /* 1 · X1 · max+1 CONCURRENT holds on one showtime yield exactly max. */
  {
    await freshHolds(bench.db);
    const who = household("slots_race");
    const max = policy.max_live_holds_per_showtime;
    const outcomes = await Promise.all(
      Array.from({ length: max + 1 }, (_unused, i) => attempt(bench, "occ_slots", [`A:${i + 1}`], who)),
    );
    trials += max + 1;
    const observed = await liveHoldsForPrincipal(bench.db, who, "occ_slots");

    checks.push(
      assert(
        grants(outcomes) === max && observed === max,
        `X1 · ${max + 1} CONCURRENT holds at max_live_holds_per_showtime=${max} left exactly ${max} live`,
        `X1 · ${grants(outcomes)} grants, ${observed} live, at a published ceiling of ${max}`,
      ),
    );
    checks.push(
      assert(
        refusals(outcomes, "hold_budget_exhausted") === 1 && faults(outcomes).length === 0,
        "X1 · the loser got a typed 429, not a fault — the constraint answered it, and a 23505 became the code the caller is owed",
        `X1 · faults: ${faultText(outcomes)}`,
      ),
    );
    checks.push(
      assert(
        deadlocks(outcomes) === 0,
        "X1 · zero 40P01 — the budget scopes are locked in one byte order, so concurrent grants wait rather than cycle",
        `X1 · ${deadlocks(outcomes)} deadlocks; the lock order is not total`,
      ),
    );

    observations.push({
      rule: "X1",
      member: "max_live_holds_per_showtime",
      published: `${statedAs(table, "max_live_holds_per_showtime")} (= ${max})`,
      observed: `${observed} live holds of ${max + 1} simultaneous callers`,
      refused_with: refusedWith(outcomes.find((o) => o.kind === "refusal")),
      concurrent: true,
      counting: "live Holds one principal carries on one showtime, backed by the hold_slot primary key",
    });
  }

  /* 2 · X1 · the RATE, raced. Lock-backed: an unlocked count lets every caller through. */
  {
    await freshHolds(bench.db);
    const who = household("rate_race");
    const max = policy.max_holds_per_site_per_hour;
    const outcomes = await Promise.all(
      Array.from({ length: RATE_SHOWTIMES }, (_unused, i) => attempt(bench, `occ_rate_${i + 1}`, ["A:1"], who)),
    );
    trials += RATE_SHOWTIMES;
    const granted = await grantsInTrailingHour(bench.db, who);
    const refusal = outcomes.find((o) => o.kind === "refusal");

    checks.push(
      assert(
        grants(outcomes) === max && granted === max,
        `X1 · ${RATE_SHOWTIMES} SIMULTANEOUS holds on ${RATE_SHOWTIMES} different showtimes yielded exactly ${max} — the hourly rate is a lock, not a read`,
        `X1 · ${grants(outcomes)} grants and ${granted} rows inside the hour, at a published ${max}: every racer counted the same number and every one committed`,
      ),
    );
    checks.push(
      assert(
        faults(outcomes).length === 0,
        "X1 · every racer ended as a grant or a typed refusal, none as a fault",
        `X1 · faults: ${faultText(outcomes)}`,
      ),
    );
    checks.push(
      assert(
        detailWindow(refusal) === 3600000,
        "X1 · the losing racer is still told the window, so it can back off by an hour rather than by a guess",
        `X1 · the refusal carried window_ms ${String(detailWindow(refusal))}`,
      ),
    );

    observations.push({
      rule: "X1",
      member: "max_holds_per_site_per_hour",
      published: `${statedAs(table, "max_holds_per_site_per_hour")} (= ${max})`,
      observed: `${granted} grants of ${RATE_SHOWTIMES} simultaneous callers`,
      refused_with: refusedWith(refusal),
      concurrent: true,
      counting: "Holds granted at one origin in the trailing hour, counted under an advisory lock on that scope",
    });
  }

  /* 3 · X4 · the per-principal seat ceiling, raced. Lock-backed. */
  {
    await freshHolds(bench.db);
    const who = household("seats_big_race");
    const ceiling = Math.max(
      1,
      Math.min(policy.max_live_seats_per_showtime, Math.floor((policy.max_held_seat_fraction_bp * BIG_HOUSE) / 10000)),
    );
    const outcomes = await Promise.all([
      attempt(bench, "occ_seats_big", row("A", 1, ceiling), who),
      attempt(bench, "occ_seats_big", row("B", 1, ceiling), who),
    ]);
    trials += 2;
    const observed = await heldSeatsForPrincipal(bench.db, who, "occ_seats_big");

    checks.push(
      assert(
        observed === ceiling,
        `X4 · two SIMULTANEOUS ${ceiling}-seat holds left the principal holding exactly ${ceiling} seats — both counted zero and only one committed`,
        `X4 · the principal holds ${observed} seats after two simultaneous ${ceiling}-seat holds, above the ceiling of ${ceiling}: the seat ceiling is an unlocked SELECT`,
      ),
    );
    checks.push(
      assert(
        grants(outcomes) === 1 && refusals(outcomes, "seat_budget_exhausted") === 1,
        "X4 · exactly one grant and one 429 seat_budget_exhausted",
        `X4 · ${grants(outcomes)} grants, ${refusals(outcomes, "seat_budget_exhausted")} seat refusals, faults: ${faultText(outcomes)}`,
      ),
    );

    observations.push({
      rule: "X4",
      member: "max_live_seats_per_showtime",
      published: `${statedAs(table, "max_live_seats_per_showtime")} (= ${ceiling} at a ${BIG_HOUSE}-seat house)`,
      observed: `${observed} seats from 2 simultaneous callers`,
      refused_with: refusedWith(outcomes.find((o) => o.kind === "refusal")),
      concurrent: true,
      counting: "a principal's live held seats on one showtime, summed under an advisory lock on the principal scope",
    });
  }

  /* 4 · X4 · the fraction, raced on the small house. */
  {
    await freshHolds(bench.db);
    const who = household("seats_small_race");
    const ceiling = Math.max(
      1,
      Math.min(policy.max_live_seats_per_showtime, Math.floor((policy.max_held_seat_fraction_bp * SMALL_HOUSE) / 10000)),
    );
    const outcomes = await Promise.all([
      attempt(bench, "occ_seats_small", row("A", 1, ceiling), who),
      attempt(bench, "occ_seats_small", row("C", 1, ceiling), who),
    ]);
    trials += 2;
    const observed = await heldSeatsForPrincipal(bench.db, who, "occ_seats_small");

    checks.push(
      assert(
        observed === ceiling && grants(outcomes) === 1,
        `X4 · two SIMULTANEOUS holds on a ${SMALL_HOUSE}-seat house left ${observed} seats held, at a fraction ceiling of ${ceiling}`,
        `X4 · ${observed} seats held on a ${SMALL_HOUSE}-seat house against a ceiling of ${ceiling}, from ${grants(outcomes)} grants`,
      ),
    );
    checks.push(
      assert(
        faults(outcomes).length === 0,
        "X4 · neither racer faulted on the small house",
        `X4 · faults: ${faultText(outcomes)}`,
      ),
    );

    observations.push({
      rule: "X4",
      member: "max_held_seat_fraction_bp",
      published: `${statedAs(table, "max_held_seat_fraction_bp")} (= ${ceiling} at a ${SMALL_HOUSE}-seat house)`,
      observed: `${observed} seats from 2 simultaneous callers`,
      refused_with: refusedWith(outcomes.find((o) => o.kind === "refusal")),
      concurrent: true,
      counting: "a principal's live held seats on one small-house showtime, where the fraction is the binding half",
    });
  }

  /* 5 · X3 · the PLATFORM fraction, raced across three principals. */
  {
    await freshHolds(bench.db);
    const ceiling = Math.max(1, Math.floor(policy.max_held_fraction_per_showtime * BIG_HOUSE));
    const each = Math.floor(ceiling / 2);
    const expected = Math.floor(ceiling / each) * each;
    const outcomes = await Promise.all([
      attempt(bench, "occ_platform", row("A", 1, each), household("platform_a_race")),
      attempt(bench, "occ_platform", row("B", 1, each), household("platform_b_race")),
      attempt(bench, "occ_platform", row("C", 1, each), household("platform_c_race")),
    ]);
    trials += 3;
    const observed = await heldSeatsForPlatform(bench.db, "occ_platform");

    checks.push(
      assert(
        observed <= ceiling && observed === expected,
        `X3 · three principals of ONE platform asking for ${each} seats simultaneously left ${observed} held, at a platform ceiling of ${ceiling}`,
        `X3 · the platform holds ${observed} seats against a ceiling of ${ceiling} — the platform aggregate was counted without its lock`,
      ),
    );
    checks.push(
      assert(
        grants(outcomes) === expected / each && faults(outcomes).length === 0,
        `X3 · exactly ${expected / each} of the three simultaneous principals were granted and none faulted`,
        `X3 · ${grants(outcomes)} grants, faults: ${faultText(outcomes)}`,
      ),
    );
    checks.push(
      assert(
        deadlocks(outcomes) === 0,
        "X3 · zero 40P01 across three principals sharing two platform scopes and no principal scope",
        `X3 · ${deadlocks(outcomes)} deadlocks`,
      ),
    );

    observations.push({
      rule: "X3",
      member: "max_held_fraction_per_showtime",
      published: `${statedAs(table, "max_held_fraction_per_showtime")} (= ${ceiling} at a ${BIG_HOUSE}-seat house)`,
      observed: `${observed} seats from 3 simultaneous principals`,
      refused_with: refusedWith(outcomes.find((o) => o.kind === "refusal")),
      concurrent: true,
      counting: "one platform's live held seats on one showtime, counted under an advisory lock on the platform scope",
    });
  }

  return {
    class_id: C_BUDGET.class_id,
    verdict: verdictOf(checks),
    checks,
    observations,
    trials,
  };
}
