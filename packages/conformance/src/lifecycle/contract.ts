/**
 * What a lifecycle class returns.
 *
 * Owner: TEST-003.
 *
 * **This is deliberately local and deliberately small.** `packages/conformance/src/harness.ts`
 * belongs to TEST-001 and does not exist yet; inventing a second harness here
 * would guarantee that the two disagree at integration, and inventing nothing
 * would mean the three class modules each grow their own private way of saying
 * *this held*. So the shape is three fields, no behaviour, and no runner: when
 * `harness.ts` lands, {@link ClassResult} maps onto it by renaming, and nothing
 * in the three class modules has to be rewritten to follow.
 *
 * One rule carried from the proof-script contract, because it is what makes a
 * count of `ok — ` lines mean something: **one {@link Check} is one assertion.**
 * Not one scenario, not one phase. A check whose text says "and" twice is two
 * checks that were too shy to be counted separately.
 */

export interface Check {
  readonly held: boolean;
  readonly text: string;
}

export interface ClassResult {
  /** The §7 class id, e.g. `C-ORPHAN`. */
  readonly id: string;
  readonly checks: readonly Check[];
  /** Measurements and profile statements. Printed; never counted as assertions. */
  readonly notes: readonly string[];
  /** Set where the class could not be reached at all. Exit 2, never 1. */
  readonly unprovable?: string;
}

export function held(text: string): Check {
  return { held: true, text };
}

export function broke(text: string): Check {
  return { held: false, text };
}

/** `assert(condition, whenItHeld, whenItDidNot)` — both texts written up front. */
export function assert(condition: boolean, when_held: string, when_broken: string): Check {
  return condition ? held(when_held) : broke(when_broken);
}

export function failed(result: ClassResult): boolean {
  return result.checks.some((c) => !c.held);
}
