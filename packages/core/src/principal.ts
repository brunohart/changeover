/**
 * X0 and X6 — who is asking, and whether a human was asked.
 *
 * Owner: CORE-006.
 *
 * Two rules live here and they are the same rule seen twice: **a budget is only
 * a budget if it is scoped to the party whose behaviour it is meant to bound.**
 *
 * SPEC.md §4.7 opens by naming the draft's error: the limits were scoped to
 * `agent_id`, *"which is an entire agent platform serving millions. Six holds an
 * hour across a whole site for a platform's global customer base is unusable,
 * and one live hold per cluster means that while one Wellington household holds
 * the Friday 35mm, every other customer of that platform anywhere is refused the
 * same film that week."*
 *
 * So every ceiling in {@link file://./budgets.ts} is scoped to
 * `(agent_id, principal_scope)`, and X0 makes the second half of that tuple
 * mandatory:
 *
 * > **X0.** A credential **MUST** carry `principal_scope`: an opaque,
 * > platform-minted, pairwise-pseudonymous subject id (OIDC PPID shape), scoped
 * > to `(agent_platform, site)` and rotated per customer session. It is
 * > credential-derived, never a request field, so I2 holds and D1 stands.
 * > Absence is `403 principal_scope_missing`.
 *
 * **Credential-derived, never a request field** is the load-bearing half. A
 * scope read from a body is a security decision made on caller-supplied data:
 * an agent that wanted a fresh budget would send a fresh scope, and an agent
 * that wanted to read back another customer's idempotent response would send
 * theirs. That is why {@link PrincipalCredential} is a separate argument
 * everywhere in this package and never a member of a request type — the shape
 * of the code is what keeps the rule, not a comment asking for it.
 *
 * **No personal data.** `principal_scope` is a pseudonym and this module never
 * parses one. It is compared for equality, hashed into a lock key, and stored;
 * it is never split, decoded, sorted or ranged over. Z3's discipline for
 * opaqueId applies to it in full: a Server that learned to read structure out of
 * a platform's PPID would be depending on a thing the platform is free to
 * rotate, and would be holding, in effect, a customer identifier.
 *
 * X6's gate is here for the same reason: `attended` is a **credential** claim,
 * so the decision to render a gate is a fact about who is asking rather than
 * about what they asked for.
 */

import type { DurationMs, Prose } from "@changeover/schema/scalars.ts";
import { prose } from "@changeover/schema/scalars.ts";
import { Refusal, refuse } from "@changeover/schema/refusal.ts";

/* ── 1 · The credential ────────────────────────────────────────────────────── */

/** `hold.agent_id`'s own CHECK, so a value that reaches SQL is a value SQL accepts. */
export const AGENT_ID_PATTERN = /^agt_[A-Za-z0-9_-]{1,40}$/;

/** `hold.principal_scope`'s own CHECK: `length between 1 and 255`. */
export const PRINCIPAL_SCOPE_MAX_LENGTH = 255;

/**
 * The credential, as the boundary hands it to core.
 *
 * `principal_scope` is optional **on this type only**, and that is deliberate:
 * the absence X0 refuses has to be representable somewhere or the refusal can
 * never be reached. {@link requirePrincipal} is the one place it stops being
 * optional, and everything downstream takes {@link Principal} instead.
 */
export interface PrincipalCredential {
  readonly agent_id: string;
  /** X0. Absence — missing, null, or empty — is `403 principal_scope_missing`. */
  readonly principal_scope?: string | null;
  /**
   * X6. An **exhibitor-issued** grant that a human is at the other end.
   * **Absence means false**, and X6b states the limit plainly: *"the Agent
   * renders the gate. A gate proves the Server demanded a human decision; it
   * does not prove a human made one."*
   */
  readonly attended?: boolean;
}

/** A credential that has passed X0. The tuple every ceiling is scoped to. */
export interface Principal {
  readonly agent_id: string;
  readonly principal_scope: string;
}

/**
 * X0, as the only gate between a credential and a budget.
 *
 * Throws `403 principal_scope_missing` where the scope is absent, and
 * `403 not_authorised` where there is no agent identity at all — two codes,
 * because they have different fixes: one is the platform's token minting, the
 * other is the platform's registration.
 *
 * An empty string is absence. It is not a scope that happens to be short: a
 * platform that sent `""` for every customer would collapse its entire
 * population into one budget, which is the exact failure X0 exists to prevent,
 * arriving through the door marked "present".
 */
export function requirePrincipal(credential: PrincipalCredential): Principal {
  const agent_id = credential.agent_id;
  if (typeof agent_id !== "string" || !AGENT_ID_PATTERN.test(agent_id)) {
    throw refuse("not_authorised", "This credential carries no agent identity.");
  }
  const scope = credential.principal_scope;
  if (typeof scope !== "string" || scope.length === 0) {
    throw refuse("principal_scope_missing", "This credential carries no principal scope.");
  }
  if (scope.length > PRINCIPAL_SCOPE_MAX_LENGTH) {
    // Longer than the column, so it can never be stored, so a ceiling scoped to
    // it could never be counted. Refusing here is the honest answer; truncating
    // would silently merge two customers into one budget.
    throw refuse("principal_scope_missing", "This credential's principal scope is longer than this Server stores.");
  }
  return { agent_id, principal_scope: scope };
}

/** True only for a literal `true`. X6: **absence means false**, and so does anything else. */
export function isAttended(credential: PrincipalCredential): boolean {
  return credential.attended === true;
}

/**
 * The scoping key, and the thing that makes "two DIFFERENT principals on one
 * platform both succeed" a property of the code rather than a hope.
 *
 * **Length-prefixed on both members.** A naive `agent_id + ":" + scope` collides:
 * `("agt_a", "b:c")` and `("agt_a:b", "c")` produce one string, and a collision
 * here is two households sharing one budget — one of them denied a seat because
 * of the other's hedging, with no way for either to find out why. The prefix
 * makes the encoding injective, so distinct tuples are distinct keys, always.
 *
 * The same encoding is what {@link file://./budgets.ts} hashes into its advisory
 * lock keys, so a lock taken for one principal never excludes another.
 */
export function principalKey(principal: Principal): string {
  const { agent_id, principal_scope } = principal;
  return `${agent_id.length}:${agent_id}:${principal_scope.length}:${principal_scope}`;
}

/** Equality on the scoping tuple. Never an ordering: Z3 forbids ranging over an opaqueId. */
export function samePrincipal(a: Principal, b: Principal): boolean {
  return a.agent_id === b.agent_id && a.principal_scope === b.principal_scope;
}

/**
 * The platform half alone, for X3's per-`agent_id` ceilings.
 *
 * Named rather than inlined so that the two scopes can never be confused at a
 * call site: a ceiling that meant to be per-customer and was keyed here would be
 * the draft's bug restored, and it would look like a one-word diff.
 */
export function platformKey(principal: Principal): string {
  return `${principal.agent_id.length}:${principal.agent_id}`;
}

/* ── 2 · X6 — the gate ─────────────────────────────────────────────────────── */

/** `capability.gate_stage`. The closed enum of `schemas/capability.schema.json`. */
export const GATE_STAGE = {
  hold: "hold",
  handoff: "handoff",
  none: "none",
} as const;

export type GateStage = (typeof GATE_STAGE)[keyof typeof GATE_STAGE];

/** `capability.handoff_gate_budget_ms` — the schema's own default. */
export const HANDOFF_GATE_BUDGET_DEFAULT_MS: DurationMs = 120000;

/**
 * X6's headroom: *"a human who has gone to ask their partner about Saturday
 * takes longer than 180 seconds."*
 */
export const HANDOFF_GATE_HEADROOM_MS: DurationMs = 30000;

/**
 * X6: where `gate_stage` is `handoff`, a Server **MUST NOT** publish a
 * `policy_max_floor_ms` below `handoff_gate_budget_ms + clock_guard_ms + 30000`.
 *
 * The arithmetic is trivial and the reason is not: at `gate_stage: "handoff"`
 * the human is asked **after** the seats are held, so the whole time they spend
 * deciding is spent inside a floor that is already running. A floor shorter than
 * the gate budget guarantees that some fraction of honest customers lose the
 * seats they are in the middle of agreeing to.
 */
export function minPolicyMaxFloorMs(
  handoff_gate_budget_ms: DurationMs,
  clock_guard_ms: DurationMs,
): DurationMs {
  return handoff_gate_budget_ms + clock_guard_ms + HANDOFF_GATE_HEADROOM_MS;
}

/** The published members X6's arithmetic reads. A subset of the capability document. */
export interface GateCapability {
  readonly gate_stage: GateStage;
  readonly handoff_gate_budget_ms?: DurationMs;
  readonly clock_guard_ms: DurationMs;
  readonly policy_max_floor_ms: DurationMs;
}

/**
 * A published pair of numbers X6 forbids. A **server defect**, deliberately not
 * a `Refusal`: nothing an Agent did caused it and nothing an Agent can do fixes
 * it, so it must surface as a fault at configuration time rather than as a
 * refusal a caller will branch on.
 */
export class GateBudgetError extends Error {
  readonly gate_stage: GateStage;
  constructor(gate_stage: GateStage, message: string) {
    super(message);
    this.name = "GateBudgetError";
    this.gate_stage = gate_stage;
  }
}

/**
 * X6's `MUST NOT`, checked against a published capability document.
 *
 * Also enforces the other half of the sentence — *"a Server **MUST** publish
 * `handoff_gate_budget_ms`"* — because an unpublished budget makes the
 * inequality unfalsifiable, which is the same failure §2.5 names for an
 * undisclosed limit.
 */
export function assertGateBudget(capability: GateCapability): void {
  if (capability.gate_stage !== GATE_STAGE.handoff) return;
  const budget = capability.handoff_gate_budget_ms;
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0) {
    throw new GateBudgetError(
      capability.gate_stage,
      "gate_stage is handoff, so handoff_gate_budget_ms MUST be published as an integer of milliseconds (X6)",
    );
  }
  const floor = minPolicyMaxFloorMs(budget, capability.clock_guard_ms);
  if (capability.policy_max_floor_ms < floor) {
    throw new GateBudgetError(
      capability.gate_stage,
      `gate_stage is handoff, so policy_max_floor_ms MUST NOT be below ${floor}ms ` +
        `(handoff_gate_budget_ms ${budget} + clock_guard_ms ${capability.clock_guard_ms} + ${HANDOFF_GATE_HEADROOM_MS}); ` +
        `this Server publishes ${capability.policy_max_floor_ms}`,
    );
  }
}

/**
 * X6: is a gate owed at this stage, for this credential?
 *
 * `at` is where the caller currently is; `stage` is where the published document
 * says the gate lives. `none` never gates. An `attended: true` grant skips it,
 * and nothing else does — in particular a *request* member could not, because
 * the credential is the only input.
 */
export function gateRequired(
  stage: GateStage,
  at: Exclude<GateStage, "none">,
  credential: PrincipalCredential,
): boolean {
  if (stage === GATE_STAGE.none) return false;
  if (stage !== at) return false;
  return !isAttended(credential);
}

/* ── 3 · X6a — the prompt, and why it is mostly structure ──────────────────── */

/**
 * X6a's structured members.
 *
 * > **X6a.** `inputRequests[].prompt` **MUST** travel in a prose envelope,
 * > **MUST NOT** contain a URI, and **MUST** be accompanied by structured
 * > members — `seat_count`, `venue_name`, `local_wall`, `presentation_classes`,
 * > `amount_minor`, `currency` — so a conforming Agent renders from the
 * > structure and the free text is a caption, not the contract.
 *
 * `amount_minor` and `currency` are a **pair** and are a read-side disclosure of
 * a number the exhibitor already published. This boundary computes no amount and
 * settles nothing (ADR-001); where the Occasion discloses no price, both members
 * are absent together, because half a price is a false statement to a human and
 * an invented one is worse.
 */
export interface GateFacts {
  readonly seat_count: number;
  readonly venue_name: string;
  /** `local_wall` — the wall clock at the venue, which is what a human recognises. */
  readonly local_wall: string;
  readonly presentation_classes: readonly string[];
  /** Disclosed, never computed. Absent unless `currency` is present too. */
  readonly amount_minor?: number;
  /** ISO 4217, uppercase. Absent unless `amount_minor` is present too. */
  readonly currency?: string;
}

/** One input request. The Agent renders it; the Server never sees the answer's provenance (X6b). */
export interface GateInputRequest {
  /** PR1: a prose envelope. Non-load-bearing, and never an instruction. */
  readonly prompt: Prose;
  readonly seat_count: number;
  readonly venue_name: string;
  readonly local_wall: string;
  readonly presentation_classes: readonly string[];
  readonly amount_minor?: number;
  readonly currency?: string;
}

/** MCP's `InputRequiredResult`, in the shape §6.2 names. Not an operation (I7). */
export interface InputRequiredResult {
  readonly input_required: true;
  readonly gate_stage: Exclude<GateStage, "none">;
  readonly inputRequests: readonly GateInputRequest[];
}

/**
 * A gate that could not be built. A **server defect**, like {@link GateBudgetError}:
 * a prompt carrying a URI is an uncontrolled channel to a human, and emitting a
 * malformed one is worse than emitting none.
 */
export class GateShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateShapeError";
  }
}

/**
 * Anything a consumer might follow. Deliberately broader than RFC 3986.
 *
 * X6a's ban is not about well-formed URIs; it is about a Server writing a
 * clickable destination into text a human is about to act on, which is §5.3's
 * whole concern arriving at the one moment a human is paying attention. So this
 * catches `https://…`, bare `www.`, `//host/…` and any `scheme:` that is not a
 * time — `19:30` and `+12:00` must survive, because `local_wall` renders into
 * exactly this caption.
 */
const URI_LIKE = /(?:\b[a-z][a-z0-9+.-]*:\/\/)|(?:\bwww\.[a-z0-9-]+\.)|(?:^|\s)\/\/[a-z0-9-]+\.|(?:\b(?:mailto|tel|data|javascript|file|urn):)/i;

/** True where `text` carries something a consumer could follow. X6a forbids one. */
export function containsUri(text: string): boolean {
  return URI_LIKE.test(text);
}

/**
 * Build the `InputRequiredResult` X6 owes, with X6a enforced at construction.
 *
 * The caption is checked, the structure is required, and the price pair is
 * checked for halves. There is no path through this function that produces a
 * prompt with a URI in it, which is the point: a rule enforced at the one
 * constructor is a rule, and a rule enforced at each call site is a convention.
 */
export function inputRequired(
  at: Exclude<GateStage, "none">,
  facts: GateFacts,
  caption: string,
): InputRequiredResult {
  if (!Number.isInteger(facts.seat_count) || facts.seat_count < 1) {
    throw new GateShapeError("a gate must name how many seats it is about (X6a seat_count)");
  }
  if (typeof facts.venue_name !== "string" || facts.venue_name.length === 0) {
    throw new GateShapeError("a gate must name the venue (X6a venue_name)");
  }
  if (typeof facts.local_wall !== "string" || facts.local_wall.length === 0) {
    throw new GateShapeError("a gate must name the local wall time (X6a local_wall)");
  }
  if (!Array.isArray(facts.presentation_classes)) {
    throw new GateShapeError("a gate must carry presentation_classes, empty where there are none (X6a)");
  }
  const hasAmount = facts.amount_minor !== undefined;
  const hasCurrency = facts.currency !== undefined;
  if (hasAmount !== hasCurrency) {
    throw new GateShapeError("amount_minor and currency are disclosed together or not at all (X6a)");
  }
  if (hasAmount && (!Number.isInteger(facts.amount_minor) || (facts.amount_minor as number) < 0)) {
    throw new GateShapeError("amount_minor is a non-negative integer of minor units, as disclosed (X6a)");
  }
  if (containsUri(caption)) {
    throw new GateShapeError("a gate prompt MUST NOT contain a URI (X6a)");
  }

  const request: GateInputRequest = {
    prompt: prose(caption),
    seat_count: facts.seat_count,
    venue_name: facts.venue_name,
    local_wall: facts.local_wall,
    presentation_classes: [...facts.presentation_classes],
    ...(hasAmount ? { amount_minor: facts.amount_minor, currency: facts.currency } : {}),
  };
  return { input_required: true, gate_stage: at, inputRequests: [request] };
}

/**
 * The caption X6 illustrates, built from the structure rather than beside it.
 *
 * *"Hold two seats at the Embassy?"* is the decision a human wants to make, and
 * X6 recommends `gate_stage: "hold"` because it spends human latency **before**
 * a seat is locked — where *"hand off the hold you already made?"* is a dialog
 * nobody understands.
 */
export function holdGateCaption(facts: GateFacts): string {
  const seats = facts.seat_count === 1 ? "1 seat" : `${facts.seat_count} seats`;
  return `Hold ${seats} at ${facts.venue_name}, ${facts.local_wall}?`;
}

/** Re-exported so a binding can tell a refusal from a fault without a second import. */
export { Refusal };
