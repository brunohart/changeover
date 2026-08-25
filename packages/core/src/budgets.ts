/**
 * X1–X5 — the exhaustion ceilings, bound inside the insert transaction.
 *
 * Owner: CORE-006. This is G1 step 9, and the derived half of step 8.
 *
 * *"A hold API that ships without exhaustion limits ships a weapon"* (SPEC.md
 * §4.7). Everything here exists to make that weapon small, and three properties
 * decide whether it actually is:
 *
 * **1 · Every ceiling is scoped to a customer, not to a platform.** X1 makes the
 * per-showtime, per-site, per-cluster and per-seat ceilings **per
 * `(agent_id, principal_scope)`**. Scoped to `agent_id` alone — the draft's
 * error — one Wellington household holding the Friday 35mm locks out every other
 * customer of that platform anywhere in the world. {@link file://./principal.ts}
 * carries the tuple; this module never assembles one itself.
 *
 * **2 · Every ceiling is enforced by a constraint or a lock, inside the insert
 * transaction.** N1, and §4.6 names the concrete failure: *"at READ COMMITTED
 * two `hold_seats` three milliseconds apart both count zero live holds in a
 * cluster, both pass, both commit — so X2 failed to two concurrent requests."*
 * A read-then-write check is a race with extra steps. So `hold_slot`'s primary
 * key carries {@link ExhaustionLimitName max_live_holds_per_showtime} outright,
 * `hold_cluster_live` carries the labelled cluster, and every remaining
 * aggregate is counted **under an advisory transaction lock on its own scope**
 * — see {@link budgetLockKeys}. Nothing here is decided by an unlocked `SELECT`.
 *
 * **3 · Nothing unpublished is enforced.** §2.5: *"A Server MUST NOT enforce a
 * limit it has not published here or in the capability document, and
 * C-CAPABILITY asserts the converse: no limit observed at runtime may be absent
 * from the document."* *An undisclosed limit is indistinguishable from a bug to
 * a caller with no eyes.* That converse is made **structural** rather than
 * tested: every ceiling is read through {@link PublishedPolicy.value}, which
 * throws {@link UnpublishedLimit} — a server fault, never a refusal — for a
 * member the published document does not carry. There is no path in this module
 * from a number to a refusal that does not pass through the published document
 * first, and {@link PublishedPolicy.consulted} records which ones it read, so a
 * proof can assert the inclusion rather than trust this paragraph.
 *
 * **The cluster, and why the semantics layer pays rent twice.** X2's own note:
 * *"anti-exhaustion is enforceable here **because** substitutability is
 * machine-checkable. The same merchant-authored structure pays rent twice — as
 * customer protection against price-routing, and as defence against speculative
 * fan-out across interchangeable inventory."* The `hold_cluster_live` index
 * enforces the publisher's **label**. {@link demandCluster} enforces the
 * publisher's **attestations**: two Occasions that accept each other as
 * substitutes are one demand cluster whether or not anybody labelled them, and a
 * principal holding both is hedging across interchangeable inventory. A
 * mutually-substitutable set is a strongly connected component of the attested
 * relation, and every such component is an antichain — no member can strictly
 * dominate another, because domination requires that there be no edge back.
 * {@link isAntichain} asserts exactly that, so the coupling is checkable and not
 * merely asserted.
 *
 * **`claimed` is deliberately outside every cluster predicate.** *"Two purchases
 * in one cluster by one household are legitimate and are not fan-out"* — Friday
 * night for the couple and the Sunday matinee for the grandparents is a normal
 * transaction. Every count here reads `live` and `handed_off` and nothing else,
 * through {@link derivedStateIn}, so M3 holds too: an abandoned Hold stops
 * counting when it expires, not when somebody happens to contend it.
 */

import type { Queryable, Row } from "@changeover/store/db.ts";
import type { DurationMs } from "@changeover/schema/scalars.ts";
import type { RefusalCode } from "@changeover/schema/refusal.ts";
import { Refusal, refuse } from "@changeover/schema/refusal.ts";
import { CONSTRAINT } from "@changeover/store/schema.ts";
import type { Candidate } from "@changeover/semantics/poset.ts";
import { buildPoset, reaches, strictlyDominates } from "@changeover/semantics/poset.ts";
import { candidateFromOccasion } from "@changeover/semantics/antichain.ts";

import type { BudgetContext, BudgetGuard } from "./hold-seats.ts";
import { HOLD_POLICY_DEFAULTS, classify23505 } from "./guards.ts";
import { derivedStateIn } from "./derived.ts";
import { compareC } from "./locking.ts";
import type { Principal } from "./principal.ts";
import { platformKey, principalKey } from "./principal.ts";

/* ── 1 · The published document ────────────────────────────────────────────── */

/**
 * `urn:changeover:schema:hold-policy:0.1`, SPEC.md §2.5, all fourteen members.
 *
 * `additionalProperties: false` and every member `required`, so a policy
 * document is complete or it is not a policy document. That is what makes
 * {@link PublishedPolicy.value} a real gate rather than a formality: there is no
 * partially-published policy in which a ceiling could hide.
 */
export interface HoldPolicyDocument {
  readonly policy_max_floor_ms: DurationMs;
  readonly handoff_floor_ms: DurationMs;
  readonly clock_guard_ms: DurationMs;
  readonly max_clock_skew_tolerance_ms: DurationMs;
  readonly max_seats_per_hold: number;
  readonly max_live_holds_per_showtime: number;
  readonly max_holds_per_site_per_hour: number;
  readonly max_live_holds_per_cluster: number;
  readonly max_live_seats_per_showtime: number;
  readonly max_held_seat_fraction_bp: number;
  readonly max_held_fraction_per_showtime: number;
  readonly max_live_holds_per_site: number;
  readonly revocation_voids_holds: boolean;
  readonly abandonment_floor_penalty_bp: number;
}

/**
 * **Production defaults.** §2.5's own numbers wherever it gives one, and this
 * Server's published choice — marked — for the two it leaves open.
 *
 * These are the defaults the gate runs at. There is deliberately no "harness
 * profile" with softer numbers: a fan-out proof at limits nobody ships is a
 * proof about a configuration file.
 */
export const HOLD_POLICY_PUBLISHED: HoldPolicyDocument = Object.freeze({
  policy_max_floor_ms: 300000,
  /** §2.5 gives only `≥ 1000`. This Server publishes two minutes to claim. */
  handoff_floor_ms: 120000,
  clock_guard_ms: 2000,
  max_clock_skew_tolerance_ms: 1000,
  max_seats_per_hold: 6,
  max_live_holds_per_showtime: 2,
  max_holds_per_site_per_hour: 6,
  max_live_holds_per_cluster: 1,
  max_live_seats_per_showtime: 6,
  max_held_seat_fraction_bp: 500,
  max_held_fraction_per_showtime: 0.02,
  /**
   * §2.5 gives only `≥ 1`. This Server publishes 200, deliberately far above
   * every per-principal ceiling: X3 is a blast radius for one platform
   * misbehaving, and a platform ceiling set near a customer ceiling would refuse
   * the platform's 201st honest household for the sins of none of them.
   */
  max_live_holds_per_site: 200,
  revocation_voids_holds: true,
  abandonment_floor_penalty_bp: 0,
});

/* ── 2 · The ceilings, as a table ──────────────────────────────────────────── */

/** The seven §2.5 members that are exhaustion ceilings. The other seven are not. */
export const EXHAUSTION_LIMIT_NAMES = [
  "max_live_holds_per_showtime",
  "max_holds_per_site_per_hour",
  "max_live_holds_per_cluster",
  "max_live_seats_per_showtime",
  "max_held_seat_fraction_bp",
  "max_held_fraction_per_showtime",
  "max_live_holds_per_site",
] as const;

export type ExhaustionLimitName = (typeof EXHAUSTION_LIMIT_NAMES)[number];

/** One hour, in the integer milliseconds every duration in this repository is. */
export const HOUR_MS: DurationMs = 3600000;

/**
 * `hold_budget_exhausted.detail.window_ms` for a **concurrency** ceiling.
 *
 * The member is required, and a concurrency ceiling has no window: it binds
 * while the holds are live and not for any fixed span. Zero says that, and says
 * it in the one place an Agent with no eyes will look to tell a rate limit from
 * a ceiling — which is exactly why the member exists.
 */
export const NO_WINDOW_MS: DurationMs = 0;

export interface ExhaustionCeiling {
  readonly limit: ExhaustionLimitName;
  /** The rule of §4.7 this ceiling discharges. */
  readonly rule: "X1" | "X2" | "X3" | "X4";
  /** Per customer session, or per agent platform. Getting this wrong is the draft's bug. */
  readonly scope: "principal" | "platform";
  readonly code: RefusalCode;
  /** N1: a constraint a concurrent transaction cannot bypass, or a lock it cannot skip. */
  readonly backed_by: "constraint" | "lock";
  /** The constraint's own name where `backed_by` is `constraint`. Never a literal. */
  readonly constraint?: string;
  readonly window_ms: DurationMs;
  readonly decides: string;
}

/**
 * Every ceiling this module can enforce, and how each one is made unbypassable.
 *
 * A **table**, for the same reason `G1` is one: a proof can read it. It answers
 * two questions mechanically — *is every published exhaustion limit actually
 * enforced somewhere*, and *does every enforcement site name a published limit*
 * — and §2.5's converse is precisely the second of those.
 */
export const EXHAUSTION: readonly ExhaustionCeiling[] = Object.freeze([
  {
    limit: "max_live_holds_per_cluster",
    rule: "X2",
    scope: "principal",
    code: "cluster_fanout",
    backed_by: "constraint",
    constraint: CONSTRAINT.hold_cluster_live,
    window_ms: NO_WINDOW_MS,
    decides:
      "a second live Hold in one (origin, cluster) for one principal — by the publisher's label via the index, and by the publisher's attestations via demandCluster()",
  },
  {
    limit: "max_live_holds_per_showtime",
    rule: "X1",
    scope: "principal",
    code: "hold_budget_exhausted",
    backed_by: "constraint",
    constraint: CONSTRAINT.hold_slot,
    window_ms: NO_WINDOW_MS,
    decides: "a slot in [0, max) is taken by a live Hold and released with it; the (max+1)th insert violates the primary key",
  },
  {
    limit: "max_holds_per_site_per_hour",
    rule: "X1",
    scope: "principal",
    code: "hold_budget_exhausted",
    backed_by: "lock",
    window_ms: HOUR_MS,
    decides: "holds GRANTED at one origin in the trailing hour, whatever became of them — a rate, not a concurrency ceiling",
  },
  {
    limit: "max_live_holds_per_site",
    rule: "X3",
    scope: "platform",
    code: "hold_budget_exhausted",
    backed_by: "lock",
    window_ms: NO_WINDOW_MS,
    decides: "one agent platform's live Holds at one origin — the blast radius of a single misbehaving platform",
  },
  {
    limit: "max_live_seats_per_showtime",
    rule: "X4",
    scope: "principal",
    code: "seat_budget_exhausted",
    backed_by: "lock",
    window_ms: NO_WINDOW_MS,
    decides: "the absolute half of X4's min() — a principal's live held seats on one showtime",
  },
  {
    limit: "max_held_seat_fraction_bp",
    rule: "X4",
    scope: "principal",
    code: "seat_budget_exhausted",
    backed_by: "lock",
    window_ms: NO_WINDOW_MS,
    decides: "the proportional half of X4's min() — basis points of the auditorium's capacity, so a small house is not sold out by one credential",
  },
  {
    limit: "max_held_fraction_per_showtime",
    rule: "X3",
    scope: "platform",
    code: "seat_budget_exhausted",
    backed_by: "lock",
    window_ms: NO_WINDOW_MS,
    decides: "one agent platform's live held seats on one showtime, as a fraction of capacity",
  },
] as const satisfies readonly ExhaustionCeiling[]);

/* ── 3 · Load-time invariants ──────────────────────────────────────────────── */
//
// Asserted at import, not in a test, because each failure below is a ceiling
// that silently stops binding — and a ceiling that stops binding is invisible
// until somebody exploits it.

{
  const seen = new Set<string>();
  for (const ceiling of EXHAUSTION) {
    if (!Object.hasOwn(HOLD_POLICY_PUBLISHED, ceiling.limit)) {
      throw new Error(`budgets: ${ceiling.limit} is enforced but is not a member of the published hold policy (§2.5)`);
    }
    if (ceiling.backed_by === "constraint" && ceiling.constraint === undefined) {
      throw new Error(`budgets: ${ceiling.limit} claims a constraint backing and names no constraint (N1)`);
    }
    if (ceiling.backed_by === "lock" && ceiling.constraint !== undefined) {
      throw new Error(`budgets: ${ceiling.limit} names a constraint but is marked lock-backed`);
    }
    seen.add(ceiling.limit);
  }
  for (const name of EXHAUSTION_LIMIT_NAMES) {
    if (!seen.has(name)) {
      throw new Error(`budgets: ${name} is published as a ceiling and no enforcement site claims it (§2.5)`);
    }
  }
}

// The grant path reads three of §2.5's members through `guards.ts`'s own
// `HoldPolicyLimits`, which deliberately excludes the exhaustion ceilings so
// that module cannot begin enforcing one. Two subsets of one document can drift,
// and the drift is invisible: `hold_seats` would cap a floor at one number while
// the capability document published another, and the difference would fall
// entirely on the Agent's side where C-FLOOR can never see it.
for (const [name, value] of Object.entries(HOLD_POLICY_DEFAULTS)) {
  const published = (HOLD_POLICY_PUBLISHED as unknown as Record<string, unknown>)[name];
  if (published !== value) {
    throw new Error(
      `budgets: guards.ts publishes ${name}=${String(value)} and the hold policy publishes ${String(published)}`,
    );
  }
}

/* ── 4 · The published-limit gate ──────────────────────────────────────────── */

/**
 * A ceiling was read that the published document does not carry.
 *
 * A **server defect**, and deliberately not a `Refusal`: `isRefusal()` is false
 * for it, so a binding renders it as a 500 rather than handing a caller a
 * refusal code for a limit it was never told about. §2.5's *"indistinguishable
 * from a bug to a caller with no eyes"* is the failure; this class is the
 * boundary at which it becomes a bug the operator can see instead.
 */
export class UnpublishedLimit extends Error {
  readonly limit: string;
  constructor(limit: string) {
    super(
      `hold policy publishes no ${limit}, and a Server MUST NOT enforce a limit it has not published (SPEC.md §2.5)`,
    );
    this.name = "UnpublishedLimit";
    this.limit = limit;
  }
}

/**
 * A published hold policy, and the only way to read a number out of one.
 *
 * `consulted` accumulates every ceiling actually read, which is the runtime
 * observation C-CAPABILITY's converse needs: *no limit observed at runtime may
 * be absent from the document.* Because `value()` is the only reader and it
 * throws for an absent member, the inclusion holds by construction — and
 * `consulted` lets a proof watch it hold rather than take the claim.
 */
export class PublishedPolicy {
  readonly document: HoldPolicyDocument;
  private readonly seen: Set<ExhaustionLimitName>;

  constructor(document: HoldPolicyDocument = HOLD_POLICY_PUBLISHED) {
    this.document = document;
    this.seen = new Set<ExhaustionLimitName>();
  }

  /** Every ceiling this policy has been asked for, in the table's own order. */
  get consulted(): readonly ExhaustionLimitName[] {
    return EXHAUSTION_LIMIT_NAMES.filter((name) => this.seen.has(name));
  }

  /** Read a published ceiling. The only path from a policy to a number. */
  value(limit: ExhaustionLimitName): number {
    const raw = (this.document as unknown as Record<string, unknown>)[limit];
    if (typeof raw !== "number" || !Number.isFinite(raw)) throw new UnpublishedLimit(limit);
    this.seen.add(limit);
    return raw;
  }
}

/**
 * X4: `min(max_live_seats_per_showtime, max_held_seat_fraction_bp × capacity / 10000)`.
 *
 * *"On the draft's defaults — six holds × twelve seats × fifteen minutes, the
 * Server forbidden to reclaim — one credential that never released took 36% of a
 * 200-seat premiere, and twenty-four immovable seats on an archival 35mm print
 * is the sell-out."* The `min` is why both halves are published: the absolute
 * number protects a large house from a large grab, and the fraction protects a
 * small one, where six seats can be a tenth of the room.
 *
 * Floored at one seat. A fraction that rounds to zero would make a small house
 * unholdable by anyone, which is not a ceiling but an outage — and `seats` is
 * `minItems: 1` on the wire, so a ceiling of zero is not a number any request
 * could satisfy.
 */
export function seatCeiling(policy: PublishedPolicy, capacity: number): number {
  const absolute = policy.value("max_live_seats_per_showtime");
  const bp = policy.value("max_held_seat_fraction_bp");
  const proportional = Math.floor((bp * capacity) / 10000);
  return Math.max(1, Math.min(absolute, proportional));
}

/** X3's platform half: `max_held_fraction_per_showtime × capacity`, floored at one. */
export function platformSeatCeiling(policy: PublishedPolicy, capacity: number): number {
  const fraction = policy.value("max_held_fraction_per_showtime");
  return Math.max(1, Math.floor(fraction * capacity));
}

/* ── 5 · The locks the aggregates are counted under ────────────────────────── */

/**
 * One advisory transaction lock, keyed by an opaque string hashed **in the
 * database**.
 *
 * `pg_advisory_xact_lock` releases at COMMIT or ROLLBACK with no explicit unlock
 * and no path that can leak one, which is the same reason `locking.ts` chose it
 * for seats. The key text arrives as `$1`, so no principal scope containing a
 * separator can be made to collide with another by string surgery in this
 * process — and {@link principalKey} length-prefixes on top of that.
 */
export const BUDGET_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended($1, 0))";

/** Length-prefixed join. Injective, so two distinct scopes are two distinct locks. */
function scopeKey(...parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

/**
 * The four scopes an aggregate is counted under, for one grant.
 *
 * Returned **sorted in C byte order**, and taken in that order, for the reason
 * `sortCSeats` exists: a total order on lock keys that every transaction obeys
 * cannot contain a cycle, so two grants racing over overlapping scopes wait
 * rather than deadlock. Seat locks are taken first, by `lockAndReap`, and these
 * second — one direction, always.
 *
 * The namespace tags are not decoration. `hashtextextended` is 64 bits over one
 * advisory namespace shared with the seat locks, so distinct **inputs** are all
 * that can be arranged; a hash collision between a budget scope and a seat would
 * be a spurious wait, and in the worst case a `40P01` that Postgres detects and
 * rolls back — never a seat granted twice.
 */
export function budgetLockKeys(grant: BudgetContext): string[] {
  const principal: Principal = { agent_id: grant.agent_id, principal_scope: grant.principal_scope };
  const keys = [
    `budget:principal-showtime:${scopeKey(principalKey(principal), grant.showtime_id)}`,
    `budget:principal-site:${scopeKey(principalKey(principal), grant.origin)}`,
    `budget:platform-showtime:${scopeKey(platformKey(principal), grant.showtime_id)}`,
    `budget:platform-site:${scopeKey(platformKey(principal), grant.origin)}`,
  ];
  return keys.sort(compareC);
}

/**
 * Take every budget lock, unconditionally, in one order.
 *
 * No early return, no "only the scopes this request needs": every argument that
 * would shorten this sequence is an argument for a deadlock that appears only
 * under load. Returns the sequence, so a proof can assert the order without
 * reading a comment about it.
 */
export async function lockBudgetScopes(tx: Queryable, grant: BudgetContext): Promise<string[]> {
  const keys = budgetLockKeys(grant);
  for (const key of keys) {
    await tx.query(BUDGET_LOCK_SQL, [key]);
  }
  return keys;
}

/* ── 6 · The demand cluster, derived rather than labelled ──────────────────── */

/** A set of Occasions that are substitutes for one another, and its stable name. */
export interface DemandCluster {
  /**
   * The C-least member id. A stable name for a set that has no publisher-given
   * one, so a refusal can say *which* cluster was crossed. Never an ordering
   * over the members: Z3 forbids ranking an opaqueId, and this is a `min`, not a
   * rank.
   */
  readonly representative: string;
  /** Every member, in the candidate set's own document order. */
  readonly members: readonly string[];
}

/**
 * The mutually-substitutable class containing `occasion_id`.
 *
 * `a` and `b` are in one demand cluster when each is an acceptable substitute
 * for the other — `a ⪯ b` and `b ⪯ a` under the attested relation's transitive
 * closure. That is a strongly connected component, and it is the honest reading
 * of *"interchangeable inventory"*: a one-way edge means `b` will do instead of
 * `a`, not that a customer offered `a` would take `b`.
 *
 * A candidate with no attested edges is alone in its cluster, which is the right
 * default — the absence of an edge is the absence of permission (§2.3), and so
 * the absence of a fan-out claim. A publisher who attests nothing gets no
 * derived refusals, only the labelled ones their own `cluster` asks for.
 */
export function demandCluster(candidates: readonly Candidate[], occasion_id: string): DemandCluster {
  const poset = buildPoset(candidates);
  const members = poset.ids.filter(
    (id) => id === occasion_id || (reaches(poset, occasion_id, id) && reaches(poset, id, occasion_id)),
  );
  const representative = [...members].sort(compareC)[0] ?? occasion_id;
  return { representative, members };
}

/**
 * Is `ids` an antichain under the attested relation — no member dominating
 * another?
 *
 * This is the property that makes X2 enforceable at all. A demand cluster is a
 * mutual-reachability class, and domination requires that there be **no** edge
 * back, so a mutual class can contain no domination: the set of things a
 * customer is being offered as equivalent really is a set of equals, and
 * refusing a second simultaneous hold across it is refusing a hedge rather than
 * refusing a choice. Exported so the proof checks it against the publisher's
 * real attestations instead of taking the argument on paper.
 */
export function isAntichain(candidates: readonly Candidate[], ids: readonly string[]): boolean {
  const poset = buildPoset(candidates);
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      if (strictlyDominates(poset, a, b)) return false;
    }
  }
  return true;
}

/* ── 7 · The guard ─────────────────────────────────────────────────────────── */

/** A `BudgetGuard` that can be asked what it has enforced. */
export interface ObservableBudgetGuard extends BudgetGuard {
  /** Every published ceiling this guard has read, ever. C-CAPABILITY's converse. */
  readonly consulted: readonly ExhaustionLimitName[];
  readonly policy: PublishedPolicy;
}

/** The states that occupy a budget. `claimed` is deliberately absent — the purchase is done. */
const BUDGET_OCCUPYING = ["live", "handed_off"] as const;

/** `where` fragment: derived state, per M3, so an abandoned Hold stops counting when it expires. */
const OCCUPYING = derivedStateIn([...BUDGET_OCCUPYING], "h");

interface CountRow extends Row {
  n: string;
  wait_ms: string | null;
}

/**
 * `greatest(0, ceil((min(release) - now()) * 1000))`, so a `429` carries an
 * honest wait rather than a guess.
 *
 * `hold_budget_exhausted` and `seat_budget_exhausted` are both `retry_after_ms`
 * in §6.3's retryability table, and the number an Agent is owed is the moment
 * the ceiling actually stops binding: the earliest release among the Holds that
 * are occupying it. Inventing a fixed backoff would be a false statement to a
 * consumer with no judgement, and a truthful one costs one aggregate.
 */
const WAIT_MS = `coalesce(greatest(0, ceil(extract(epoch from (min(coalesce(h.claim_expires_at, h.expires_at)) - now())) * 1000)), 0)::text`;

interface OccasionCandidateRow extends Row {
  hold_id: string;
  occasion_id: string;
  cluster: string | null;
  document: unknown;
}

/**
 * The exhaustion guard, at published ceilings, enforced in-transaction.
 *
 * Plugged in as `holdSeats(db, request, credential, { budgets: principalBudgets() })`,
 * which is the seam `BUDGETS_UNENFORCED` names honestly when nobody has.
 */
export function principalBudgets(
  document: HoldPolicyDocument = HOLD_POLICY_PUBLISHED,
): ObservableBudgetGuard {
  const policy = new PublishedPolicy(document);
  return {
    policy,
    get consulted() {
      return policy.consulted;
    },
    async reserve(tx: Queryable, grant: BudgetContext): Promise<void> {
      // N1, first and unconditionally. Everything below this line that is not
      // carried by a primary key is carried by one of these four locks, and the
      // count-then-write that follows is atomic with respect to any other
      // transaction in the same scope. Without it, two requests three
      // milliseconds apart both count zero and both commit.
      await lockBudgetScopes(tx, grant);

      // The derived half of X2 runs FIRST, before any step-9 ceiling, because
      // `cluster_fanout` is G1 step 8's code and `hold_budget_exhausted` is step
      // 9's. Only the thrown code is observable from outside the transaction, so
      // running it here keeps the ORDER an Agent sees identical to G1's — which
      // is the whole reason G1 fixes an order at all.
      await refuseDerivedFanout(tx, grant, policy);

      await refuseHoldSlotExhausted(tx, grant, policy);
      await refuseSiteRateExhausted(tx, grant, policy);
      await refusePlatformSiteExhausted(tx, grant, policy);
      await refuseSeatCeilingExhausted(tx, grant, policy);
      await refusePlatformSeatCeilingExhausted(tx, grant, policy);
    },
  };
}

/* ── 8 · The five ceilings, one function each ──────────────────────────────── */

/**
 * X2, by attestation rather than by label.
 *
 * The `hold_cluster_live` index has already refused the labelled case at G1 step
 * 8. This catches what a label cannot: two Occasions the publisher attested as
 * mutual substitutes but did not put in one `cluster`, or put in none. It reads
 * the principal's occupying Holds at this origin, builds the preorder over their
 * published documents together with this one, and refuses a second simultaneous
 * hold inside the mutual class.
 */
async function refuseDerivedFanout(
  tx: Queryable,
  grant: BudgetContext,
  policy: PublishedPolicy,
): Promise<void> {
  const limit = policy.value("max_live_holds_per_cluster");

  const held = await tx.query<OccasionCandidateRow>(
    `select h.hold_id, h.occasion_id, o.cluster, o.document
       from hold h join occasion o on o.occasion_id = h.occasion_id
      where h.agent_id = $1 and h.principal_scope = $2 and h.origin = $3
        and h.hold_id <> $4 and ${OCCUPYING}
      order by h.granted_at`,
    [grant.agent_id, grant.principal_scope, grant.origin, grant.hold_id],
  );
  if (held.rows.length === 0) return;

  const self = await tx.query<{ document: unknown }>(
    "select document from occasion where occasion_id = $1",
    [grant.occasion_id],
  );

  const candidates: Candidate[] = [
    candidateFromOccasion(asOccasionLike(self.rows[0]?.document, grant.occasion_id)),
  ];
  const seen = new Set<string>([grant.occasion_id]);
  for (const row of held.rows) {
    if (seen.has(row.occasion_id)) continue;
    seen.add(row.occasion_id);
    candidates.push(candidateFromOccasion(asOccasionLike(row.document, row.occasion_id)));
  }

  const cluster = demandCluster(candidates, grant.occasion_id);
  const inCluster = new Set(cluster.members);
  // A second Hold on the SAME Occasion is not fan-out across interchangeable
  // inventory — an Occasion is not an alternative to itself — and it is already
  // governed by `max_live_holds_per_showtime`. Counting it here would make that
  // published limit unreachable for every unlabelled Occasion: the second hold
  // would always be refused by a ceiling of one before the ceiling of two could
  // bind. The publisher's own `cluster` label still refuses the repetition, via
  // `hold_cluster_live` at G1 step 8, and that is the publisher's choice to make.
  const conflicting = held.rows.filter(
    (row) => row.occasion_id !== grant.occasion_id && inCluster.has(row.occasion_id),
  );
  if (conflicting.length + 1 <= limit) return;

  const first = conflicting[0];
  // The publisher's own word for the cluster where they gave one; the C-least
  // member id where they did not. A refusal has to name what was crossed, and
  // naming a set by its least member is a fact about the set, not a ranking.
  const name = grant.cluster ?? first.cluster ?? cluster.representative;
  throw refuse("cluster_fanout", "You already hold seats for that run of screenings.", {
    detail: { conflicting_hold_id: first.hold_id, cluster: name, limit },
  });
}

/**
 * X1's `max_live_holds_per_showtime`, carried by the `hold_slot_taken` primary
 * key.
 *
 * A slot in `[0, max)` is taken by a live Hold and released with it, so the
 * `(max+1)`th insert has nowhere to go. Two things make this a constraint and
 * not a count: the `not exists` sees only committed rows, but the primary key
 * sees the uncommitted one too — so a racer that slipped past the read still
 * raises `23505` on `hold_slot_taken` and still gets `429`, never a third slot.
 */
async function refuseHoldSlotExhausted(
  tx: Queryable,
  grant: BudgetContext,
  policy: PublishedPolicy,
): Promise<void> {
  const limit = policy.value("max_live_holds_per_showtime");
  const scope = [grant.agent_id, grant.principal_scope, grant.showtime_id];

  // Reap by HOLD, on the exact key this insert is about to contend on, and on no
  // other — ADR-006. A slot left behind by an abandoned Hold would lock its own
  // principal out of that showtime forever, which is M3's failure exactly.
  await tx.query(
    `delete from hold_slot s using hold h
      where h.hold_id = s.hold_id
        and s.agent_id = $1 and s.principal_scope = $2 and s.showtime_id = $3
        and not ${OCCUPYING}`,
    scope,
  );

  // Assembled BEFORE the insert, under the locks: a 23505 aborts the
  // transaction, and a query for the detail afterwards gets 25P02.
  const wait = await tx.query<CountRow>(
    `select count(*)::text as n, ${WAIT_MS} as wait_ms
       from hold h
      where h.agent_id = $1 and h.principal_scope = $2 and h.showtime_id = $3
        and h.hold_id <> $4 and ${OCCUPYING}`,
    [...scope, grant.hold_id],
  );
  const retry_after_ms = waitOf(wait.rows[0]);

  let taken: number;
  try {
    const inserted = await tx.query(
      `insert into hold_slot (agent_id, principal_scope, showtime_id, slot, hold_id)
       select $1, $2, $3, free.slot, $4
         from generate_series(0, $5::int - 1) as free(slot)
        where not exists (
                select 1 from hold_slot t
                 where t.agent_id = $1 and t.principal_scope = $2
                   and t.showtime_id = $3 and t.slot = free.slot)
        order by free.slot
        limit 1`,
      [...scope, grant.hold_id, limit],
    );
    taken = inserted.rowCount;
  } catch (err) {
    // A racer took the last free slot between the read and the insert. That is
    // the constraint doing the work the read could not, and it is a 429 — not
    // the 409 a bare 23505 would become if it were branched on by SQLSTATE.
    if (classify23505(err)?.code !== "hold_budget_exhausted") throw err;
    taken = 0;
  }

  if (taken === 0) {
    throw refuse("hold_budget_exhausted", "You already hold seats for this screening.", {
      detail: { limit, window_ms: NO_WINDOW_MS },
      retry_after_ms,
    });
  }
}

/**
 * X1's `max_holds_per_site_per_hour` — a **rate**, not a concurrency ceiling.
 *
 * It counts Holds *granted* in the trailing hour whatever became of them, so
 * releasing one does not buy another: a principal that could churn holds at will
 * would have no rate limit at all, only a concurrency one wearing its name. The
 * wait is therefore the moment the oldest grant leaves the window, which is a
 * different number from every other ceiling here.
 */
async function refuseSiteRateExhausted(
  tx: Queryable,
  grant: BudgetContext,
  policy: PublishedPolicy,
): Promise<void> {
  const limit = policy.value("max_holds_per_site_per_hour");
  const counted = await tx.query<CountRow>(
    `select count(*)::text as n,
            coalesce(greatest(0, ceil(extract(epoch from
              (min(h.granted_at) + interval '1 hour' - now())) * 1000)), 0)::text as wait_ms
       from hold h
      where h.agent_id = $1 and h.principal_scope = $2 and h.origin = $3
        and h.hold_id <> $4
        and h.granted_at > now() - interval '1 hour'`,
    [grant.agent_id, grant.principal_scope, grant.origin, grant.hold_id],
  );
  const row = counted.rows[0];
  if (Number(row?.n ?? 0) + 1 <= limit) return;
  throw refuse("hold_budget_exhausted", "That is more holds at this venue than an hour allows.", {
    detail: { limit, window_ms: HOUR_MS },
    retry_after_ms: waitOf(row),
  });
}

/** X3's `max_live_holds_per_site`, per agent platform. One platform's blast radius. */
async function refusePlatformSiteExhausted(
  tx: Queryable,
  grant: BudgetContext,
  policy: PublishedPolicy,
): Promise<void> {
  const limit = policy.value("max_live_holds_per_site");
  const counted = await tx.query<CountRow>(
    `select count(*)::text as n, ${WAIT_MS} as wait_ms
       from hold h
      where h.agent_id = $1 and h.origin = $2 and h.hold_id <> $3 and ${OCCUPYING}`,
    [grant.agent_id, grant.origin, grant.hold_id],
  );
  const row = counted.rows[0];
  if (Number(row?.n ?? 0) + 1 <= limit) return;
  throw refuse("hold_budget_exhausted", "This agent platform is holding as much of this venue as it may at once.", {
    detail: { limit, window_ms: NO_WINDOW_MS },
    retry_after_ms: waitOf(row),
  });
}

/**
 * X4, per principal.
 *
 * Counted as `sum(cardinality(h.seats))` over occupying Holds — M2's *seats as
 * granted*, not a count over `hold_seat`. The seat rows of an expired Hold
 * survive until somebody contends them (ADR-006), so counting rows would count
 * seats that M1 already reports as expired; counting the grant under the derived
 * state cannot.
 */
async function refuseSeatCeilingExhausted(
  tx: Queryable,
  grant: BudgetContext,
  policy: PublishedPolicy,
): Promise<void> {
  const limit = seatCeiling(policy, grant.capacity);
  const counted = await tx.query<CountRow>(
    `select coalesce(sum(cardinality(h.seats)), 0)::text as n, ${WAIT_MS} as wait_ms
       from hold h
      where h.agent_id = $1 and h.principal_scope = $2 and h.showtime_id = $3
        and h.hold_id <> $4 and ${OCCUPYING}`,
    [grant.agent_id, grant.principal_scope, grant.showtime_id, grant.hold_id],
  );
  const row = counted.rows[0];
  if (Number(row?.n ?? 0) + grant.seat_ids.length <= limit) return;
  throw refuse("seat_budget_exhausted", "That is more seats at this screening than one customer may hold at once.", {
    detail: { limit },
    retry_after_ms: waitOf(row),
  });
}

/** X3's `max_held_fraction_per_showtime`, per agent platform, over the same derived state. */
async function refusePlatformSeatCeilingExhausted(
  tx: Queryable,
  grant: BudgetContext,
  policy: PublishedPolicy,
): Promise<void> {
  const limit = platformSeatCeiling(policy, grant.capacity);
  const counted = await tx.query<CountRow>(
    `select coalesce(sum(cardinality(h.seats)), 0)::text as n, ${WAIT_MS} as wait_ms
       from hold h
      where h.agent_id = $1 and h.showtime_id = $2 and h.hold_id <> $3 and ${OCCUPYING}`,
    [grant.agent_id, grant.showtime_id, grant.hold_id],
  );
  const row = counted.rows[0];
  if (Number(row?.n ?? 0) + grant.seat_ids.length <= limit) return;
  throw refuse("seat_budget_exhausted", "This agent platform is holding as much of this screening as it may at once.", {
    detail: { limit },
    retry_after_ms: waitOf(row),
  });
}

/* ── 9 · Small things, kept out of the ceilings ────────────────────────────── */

/** An integer of milliseconds, or `undefined` where there is nothing honest to say. */
function waitOf(row: CountRow | undefined): DurationMs | undefined {
  const raw = Number(row?.wait_ms ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.ceil(raw);
}

/** The published Occasion, or the bare id where the publisher stored no document. */
function asOccasionLike(document: unknown, occasion_id: string): Record<string, unknown> {
  if (document !== null && typeof document === "object") {
    return { ...(document as Record<string, unknown>), occasion_id };
  }
  return { occasion_id };
}

/** Re-exported so a binding can tell a refusal from a fault without a second import. */
export { Refusal };
