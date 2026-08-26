/**
 * G1 — the guard order, as data.
 *
 * Owner: CORE-002.
 *
 * SPEC.md:430 fixes the order in which `hold_seats` evaluates its guards, and
 * the order is part of the **wire contract**, not an implementation detail:
 *
 * > *"with a moved start time **and** lost seats, one server costs the agent two
 * > round trips and a stale presentation and another costs one, and both
 * > conformed."*
 *
 * Every code carries different retry semantics, so which failure is reported
 * first decides what the Agent does next. A server that reports `seat_contended`
 * for a request whose etag was also stale sends the Agent back to re-resolve
 * seats it will then be refused again for a reason it was never told.
 *
 * **The order is a table, not a cascade.** Twelve `if` statements in the right
 * sequence are correct today and are one careless insertion away from being
 * wrong tomorrow, and nothing observes the difference until a conformance run
 * three weeks later. Here the order is {@link G1}: an ordered array,
 * `holdSeats()` is a `for` loop over it, and `scripts/prove_guard_order.sh`
 * parses SPEC.md:430 out of the specification and asserts this array reproduces
 * it exactly — **the order itself, not its consequences.** Reordering a guard is
 * then a diff to a table that a proof reads the authority for.
 *
 * Two further properties are carried here rather than remembered:
 *
 *  - **`phase`** — steps 1 and 2 decide from the request alone and need no
 *    store. They are a prefix of the order (asserted at load), so the verb can
 *    refuse a malformed request without opening a transaction, and the loop
 *    still walks one table in one direction.
 *  - **`writes`** — G1 permits no store mutation "before the first six pass".
 *    {@link G1_READ_ONLY_THROUGH} is that boundary and
 *    {@link G1_FIRST_WRITING_STEP} is the first step whose guard is enforced by
 *    a write. A guard that acquired locks or inserted a row before step 7 would
 *    be mutating the store for a request it then refuses — which is exactly what
 *    the draft's implied order did.
 */

import type { RefusalCode } from "@changeover/schema/refusal.ts";
import { REFUSAL_CODE, Refusal, refuse } from "@changeover/schema/refusal.ts";
import type { DurationMs } from "@changeover/schema/scalars.ts";
import { SQLSTATE, constraintName, sqlstate } from "@changeover/store/db.ts";
import { CONSTRAINT } from "@changeover/store/schema.ts";

/* ── 1 · The twelve steps ──────────────────────────────────────────────────── */

/**
 * Where a guard can be decided.
 *
 * `request` — from the request and the published capability document alone.
 * `transaction` — inside the single transaction of N1, against the store.
 */
export type GuardPhase = "request" | "transaction";

export interface G1Step {
  /** 1-based, exactly as SPEC.md:430 numbers them. */
  readonly step: number;
  /** The runner key. Stable; `holdSeats` dispatches on it. */
  readonly name: string;
  /** Every refusal code this step may produce, in the specification's own order. */
  readonly codes: readonly RefusalCode[];
  readonly phase: GuardPhase;
  /**
   * True where this guard is enforced by a write — a lock, an insert, a
   * constraint. G1 forbids any of it before the first six pass.
   */
  readonly writes: boolean;
  /** One line on what the step decides, and what it must not be confused with. */
  readonly decides: string;
}

/**
 * SPEC.md:430, verbatim in order and in membership.
 *
 * `scripts/prove_guard_order.sh` re-derives this list from the specification and
 * asserts set-and-sequence equality. If the specification's order changes, that
 * proof fails here — it does not quietly agree with whatever this file says.
 */
export const G1: readonly G1Step[] = Object.freeze([
  {
    step: 1,
    name: "profile",
    codes: [REFUSAL_CODE.profile_not_supported],
    phase: "request",
    writes: false,
    decides: "whether this Server implements the operation the request asks for at all",
  },
  {
    step: 2,
    name: "schema",
    codes: [REFUSAL_CODE.schema_validation],
    phase: "request",
    writes: false,
    decides: "request shape, including W2 — a duplicate-bearing seats array is refused BEFORE ANY LOCK IS TAKEN",
  },
  {
    step: 3,
    name: "occasion",
    codes: [REFUSAL_CODE.occasion_not_found],
    phase: "transaction",
    writes: false,
    decides: "whether the Occasion is published at this origin right now",
  },
  {
    step: 4,
    name: "etag",
    codes: [REFUSAL_CODE.occasion_moved],
    phase: "transaction",
    writes: false,
    decides: "whether the assertions the Agent presented to a human are still the assertions (S2 for sought, G2 for a changed availability.mode)",
  },
  {
    step: 5,
    name: "availability",
    codes: [REFUSAL_CODE.availability_unknown, REFUSAL_CODE.availability_stale],
    phase: "transaction",
    writes: false,
    decides: "whether availability is knowable and fresh — never sold out, never available, and never silently re-observed",
  },
  {
    step: 6,
    name: "cutoff",
    codes: [REFUSAL_CODE.past_sales_cutoff],
    phase: "transaction",
    writes: false,
    decides: "whether the exhibitor is still selling this screening",
  },
  {
    step: 7,
    name: "substitution",
    codes: [REFUSAL_CODE.substitution_refused],
    phase: "transaction",
    writes: false,
    decides: "S1 at commit — whether the Occasion held is an attested substitute for the Occasion sought",
  },
  {
    step: 8,
    name: "cluster",
    codes: [REFUSAL_CODE.cluster_fanout],
    phase: "transaction",
    writes: true,
    decides: "X2 — a second live Hold in one (origin, cluster) for one principal. Enforced by the hold_cluster_live index, never by an unlocked count (N1)",
  },
  {
    step: 9,
    name: "budget",
    codes: [REFUSAL_CODE.hold_budget_exhausted, REFUSAL_CODE.seat_budget_exhausted],
    phase: "transaction",
    writes: true,
    decides: "X1/X3/X4 — the published exhaustion ceilings, enforced by constraint or lock inside the insert transaction",
  },
  {
    step: 10,
    name: "seat_known",
    codes: [REFUSAL_CODE.unknown_seat],
    phase: "transaction",
    writes: false,
    decides: "W1 — every seat_id validated against the auditorium's own inventory, inside the hold transaction",
  },
  {
    step: 11,
    name: "seat_available",
    codes: [REFUSAL_CODE.seat_unavailable, REFUSAL_CODE.seat_rule_violated],
    phase: "transaction",
    writes: false,
    decides: "W3/W4 — unavailable for a reason that is NOT a CHANGEOVER Hold (sold, blocked, house, accessibility), or a seat rule the grant would violate",
  },
  {
    step: 12,
    name: "seat_contended",
    codes: [REFUSAL_CODE.seat_contended],
    phase: "transaction",
    writes: true,
    decides: "the seat is held by another live Hold. Last, because it alone requires locks",
  },
] as const satisfies readonly G1Step[]);

/** The runner keys, in G1 order. */
export type GuardName = (typeof G1)[number]["name"];

/** G1: "mutating no store state before the first six pass." */
export const G1_READ_ONLY_THROUGH = 6;

/** The first step whose guard is enforced by a write rather than a read. */
export const G1_FIRST_WRITING_STEP: number = G1.find((s) => s.writes)?.step ?? G1.length + 1;

/** Every code G1 orders, flattened, in the specification's sequence. */
export const G1_CODES_IN_ORDER: readonly RefusalCode[] = Object.freeze(G1.flatMap((s) => [...s.codes]));

/* ── 2 · Load-time invariants ──────────────────────────────────────────────── */
//
// Each of these is a property `holdSeats` relies on. They are asserted at import
// rather than tested, because a violated one makes the verb wrong in a way whose
// symptom appears in a conformance report weeks later, attributed to something
// else.

for (let i = 0; i < G1.length; i++) {
  const step = G1[i];
  if (step.step !== i + 1) {
    throw new Error(`guards: G1 is not densely numbered from 1 — index ${i} carries step ${step.step}`);
  }
  if (step.codes.length === 0) {
    throw new Error(`guards: G1 step ${step.step} declares no refusal code`);
  }
}

// The request-phase steps must be a PREFIX. `holdSeats` runs them before opening
// a transaction; a request-phase step appearing after a transaction-phase one
// would silently be evaluated out of order.
{
  const firstTransaction = G1.findIndex((s) => s.phase === "transaction");
  const lastRequest = G1.map((s) => s.phase).lastIndexOf("request");
  if (firstTransaction !== -1 && lastRequest > firstTransaction) {
    throw new Error("guards: the request-phase steps of G1 are not a prefix of the order");
  }
}

// G1 forbids mutation before the first six pass. If a step at or below 6 ever
// declares `writes`, the verb would be mutating the store for a request it then
// refuses — the exact failure the rule's own footnote names in the draft.
for (const step of G1) {
  if (step.writes && step.step <= G1_READ_ONLY_THROUGH) {
    throw new Error(`guards: G1 step ${step.step} writes, but G1 permits no mutation before the first six pass`);
  }
}

/* ── 3 · Asking the order a question ───────────────────────────────────────── */

const STEP_OF_CODE: ReadonlyMap<RefusalCode, number> = new Map(
  G1.flatMap((step) => step.codes.map((code) => [code, step.step] as const)),
);

/** The G1 step a code belongs to, or `undefined` where G1 does not order it. */
export function g1StepOf(code: RefusalCode): number | undefined {
  return STEP_OF_CODE.get(code);
}

/**
 * Which of these failures G1 says wins. Ties inside one step keep the order the
 * step declares. A code G1 does not order is never chosen over one it does.
 *
 * This is the function a caller uses to predict the refusal; `holdSeats` itself
 * does not call it, because it never has two failures in hand at once — it
 * throws the first one it finds, walking the table. That asymmetry is the point:
 * "first failure wins" is structural, not arithmetic over a collected set.
 */
export function firstInG1Order(codes: readonly RefusalCode[]): RefusalCode | undefined {
  let best: RefusalCode | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const code of codes) {
    const step = STEP_OF_CODE.get(code);
    if (step === undefined) continue;
    const withinStep = G1[step - 1].codes.indexOf(code);
    const rank = step * 100 + withinStep;
    if (rank < bestRank) {
      bestRank = rank;
      best = code;
    }
  }
  return best;
}

/* ── 4 · 23505, by constraint name ─────────────────────────────────────────── */

/**
 * Three of the store's unique constraints are guards, and all three raise the
 * same SQLSTATE.
 *
 * SPEC.md §4.6: *"`23505` **MUST** be mapped **by constraint name**:
 * `hold_seat_occupied → 409 seat_contended` · `hold_cluster_live → 429
 * cluster_fanout` · `hold_slot → 429 hold_budget_exhausted`. **Any other `23505`
 * MUST NOT be reported as `seat_contended`.**"*
 *
 * Branching on the bare `23505` is the failure this map exists to make
 * impossible: it hands a caller with no eyes `seat_contended` — whose remediation
 * is `re_resolve` — for a fan-out ceiling it will hit again on every retry,
 * forever, at whatever rate its scheduler allows.
 *
 * Note `hold_slot`: the specification spells that constraint `hold_slot`, which
 * Postgres cannot carry (tables and indexes share one namespace), so CORE-001
 * named it `hold_slot_taken`. The key here comes from `CONSTRAINT` rather than
 * from a literal, so the spelling cannot drift.
 */
const REFUSAL_FOR_CONSTRAINT: ReadonlyMap<string, RefusalCode> = new Map([
  [CONSTRAINT.hold_seat_occupied, REFUSAL_CODE.seat_contended],
  [CONSTRAINT.hold_cluster_live, REFUSAL_CODE.cluster_fanout],
  [CONSTRAINT.hold_slot, REFUSAL_CODE.hold_budget_exhausted],
]);

export interface Unique23505 {
  readonly constraint: string;
  readonly code: RefusalCode;
}

/**
 * Classify a caught error as one of the three guard constraints, or `null`.
 *
 * `null` means **rethrow**. It covers a `23505` on a constraint that is not a
 * guard (`idempotency_scope`, `hold_slot_one_per_hold`), and every SQLSTATE that
 * is not `23505` at all. A server defect must surface as a 500, not as a refusal
 * an Agent will act on.
 *
 * **The transaction is already aborted when you get here.** Postgres refuses
 * every further statement on a connection whose last statement raised, so a
 * handler that catches this and then queries for a detail gets `25P02` and loses
 * the original failure. Assemble whatever detail the refusal needs **before** the
 * insert, under the locks that make the read stable — {@link seatContended} is
 * built that way, and CORE-006's cluster and budget refusals must be too.
 */
export function classify23505(err: unknown): Unique23505 | null {
  if (sqlstate(err) !== SQLSTATE.unique_violation) return null;
  const constraint = constraintName(err);
  if (constraint === undefined) return null;
  const code = REFUSAL_FOR_CONSTRAINT.get(constraint);
  if (code === undefined) return null;
  return { constraint, code };
}

/* ── 5 · The refusals whose detail is fiddly ───────────────────────────────── */

/** `409 seat_contended {seat_ids}` — the seats another live Hold already covers. */
export function seatContended(seat_ids: readonly string[]): Refusal<"seat_contended"> {
  return refuse("seat_contended", "Those seats are held by another commitment.", {
    detail: { seat_ids: [...seat_ids] },
  });
}

/** `400 unknown_seat {seat_ids}` — W1. Ids the auditorium's own inventory does not carry. */
export function unknownSeat(seat_ids: readonly string[]): Refusal<"unknown_seat"> {
  return refuse("unknown_seat", "Those seat identifiers are not in this auditorium.", {
    detail: { seat_ids: [...seat_ids] },
  });
}

/** `409 seat_unavailable {seat_ids}` — W3. Gone for a reason that is not a CHANGEOVER Hold. */
export function seatUnavailable(seat_ids: readonly string[]): Refusal<"seat_unavailable"> {
  return refuse("seat_unavailable", "Those seats are not available from the exhibitor.", {
    detail: { seat_ids: [...seat_ids] },
  });
}

/** `412 occasion_moved {changed_paths}` — the assertions moved under the Agent. */
export function occasionMoved(changed_paths: readonly string[]): Refusal<"occasion_moved"> {
  return refuse("occasion_moved", "That screening's published assertions have changed.", {
    detail: { changed_paths: [...changed_paths] },
  });
}

/* ── 6 · The published limits `hold_seats` reads ───────────────────────────── */

/**
 * The subset of `urn:changeover:schema:hold-policy:0.1` (SPEC.md §2.5) that the
 * grant path itself consults. The exhaustion ceilings — `max_live_holds_per_*`,
 * `max_held_*_fraction*` — are read by CORE-006 through the budget seam and are
 * deliberately absent here, so that this module cannot begin enforcing one.
 *
 * §2.5: **"A Server MUST NOT enforce a limit it has not published here or in the
 * capability document."** Every number below is published, and every refusal this
 * module raises names one of them.
 */
export interface HoldPolicyLimits {
  /** 1000 – 300000. The cap on a requested floor. */
  readonly policy_max_floor_ms: DurationMs;
  /** 1–12. The wire cap on `seats`; the schema's own maximum is 12. */
  readonly max_seats_per_hold: number;
  /** X5. 0–10000; a Server MAY reduce a granted floor by this for an abandoning principal. */
  readonly abandonment_floor_penalty_bp: number;
}

/** §2.5's own defaults, and nothing invented. */
export const HOLD_POLICY_DEFAULTS: HoldPolicyLimits = Object.freeze({
  policy_max_floor_ms: 300000,
  max_seats_per_hold: 6,
  abandonment_floor_penalty_bp: 0,
});

/** `hold.schema.json`: `seats` is 1–12, `uniqueItems`, items ≤64 characters. */
export const SEATS_WIRE_MAX = 12;
export const SEAT_ID_MAX_LENGTH = 64;
