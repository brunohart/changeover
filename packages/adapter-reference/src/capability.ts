// The capability document. Owner: ADAPT-001.
//
// `GET /.well-known/changeover` — §2.9, `additionalProperties: false`, the file
// the protocol bootstraps from. Assembled member by member from an explicit
// list, never by spreading a config object: the schema is closed, so a spread of
// a member somebody adds next year would be a document that fails validation for
// a reason nobody would find quickly.
//
// Two rules make this builder more than a JSON literal.
//
//   **The floor is warranted, not chosen.** `hold_policy.policy_max_floor_ms` is
//   the largest floor an Agent may request and therefore the largest this Server
//   will grant, so §7 binds it: it MUST NOT exceed `min_observed_retention_ms −
//   safety_margin_ms`. It is CLAMPED here rather than validated here, because a
//   builder that threw on an over-large configured value would leave the choice
//   of publishing a lie available to whoever wrote the config; a builder that
//   clamps makes the honest number the only reachable one.
//
//   **`gate_stage` is derived from what the floor can fund.** X6: at
//   `gate_stage: "handoff"` the human is asked AFTER the seats are held, so a
//   Server MUST NOT publish a `policy_max_floor_ms` below `handoff_gate_budget_ms
//   + clock_guard_ms + 30000`. A measured floor of a few seconds cannot fund a
//   two-minute gate, so this Server publishes `gate_stage: "hold"` — the gate is
//   asked before the seats are taken — and `assertGateBudget` is run over the
//   finished document so the arithmetic is checked rather than reasoned about.

import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";
import { prose } from "@changeover/schema/scalars.ts";
import type { HoldPolicyDocument } from "@changeover/core/budgets.ts";
import { HOLD_POLICY_PUBLISHED } from "@changeover/core/budgets.ts";
import type { GateStage } from "@changeover/core/principal.ts";
import {
  GATE_STAGE,
  HANDOFF_GATE_BUDGET_DEFAULT_MS,
  assertGateBudget,
  minPolicyMaxFloorMs,
} from "@changeover/core/principal.ts";
import { HOLD_SCHEMA_MIN_FLOOR_MS } from "@changeover/core/clock.ts";
import type { ClaimBinding } from "@changeover/core/claim.ts";
import { DEFAULT_CLAIM_BINDING } from "@changeover/core/claim.ts";
import type {
  CapabilityDocument,
  FloorBasis,
  FloorEvidence,
  HoldBasis,
  OccasionDocument,
  Profile,
} from "./adapter.ts";
import { FloorNotWarranted, warrantableFloorMs } from "./floor.ts";

/* ── 1 · The constants this Server publishes ───────────────────────────────── */

/** `supported_versions`. V1: a request naming a version absent from this is refused. */
export const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(["0.1"]);

/**
 * `register_version`. Kept as a constant rather than read from
 * `register/2026.1.json` at runtime, so the document has no filesystem in its
 * hot path — and asserted equal to the register file by a test, so it cannot
 * drift away from it quietly.
 */
export const REGISTER_VERSION = "2026.1";

/** §2.9 RECOMMENDED 1209600000 — fourteen days. Beyond it, `400 window_too_wide`. */
export const MAX_WINDOW_MS: DurationMs = 1209600000;
/** §2.9 RECOMMENDED 200. */
export const MAX_PAGE_SIZE = 200;
/** §2.9 default 90. */
export const LOG_RETENTION_DAYS = 90;
/** How long a cached capability document may be believed before it is re-fetched. */
export const MAX_DOCUMENT_AGE_MS: DurationMs = 300000;
export const READ_RATE_LIMIT_PER_HOUR = 3600;

/**
 * The reference Server's `usage_policy`.
 *
 * `contact` is a **path, not a person**. §5.6 and C-ABSENCE.4 forbid personal
 * data in any emitted document, and the outbound byte canary fails the build on
 * a response body matching an email — which an operator's address in this member
 * would be. A contact route at the venue's own origin says the same thing and
 * says nothing about anybody.
 */
export const REFERENCE_USAGE_POLICY = Object.freeze({
  redistribution: "forbidden" as const,
  cache_max_age_ms: 300000,
  attribution_text: prose("Occasion data published by the venue under CHANGEOVER 0.1."),
  contact: "/changeover/contact",
});

/* ── 2 · The builder ───────────────────────────────────────────────────────── */

export interface VenueIdentity {
  readonly id: string;
  /** Rendered into the `prose` envelope. Plain text; never an instruction (PR). */
  readonly name: string;
  readonly origin: string;
  readonly timezone: string;
  readonly locality?: string;
}

export interface BuildCapabilityOptions {
  readonly profile: Profile;
  readonly hold_basis: HoldBasis;
  readonly floor_basis: FloorBasis;
  readonly venue: VenueIdentity;
  /** The measurement warranting the floor. Absent or empty, no document is built. */
  readonly evidence: FloorEvidence;
  readonly generated_at: Rfc3339;
  /** Delegated origins under O3. Defaults to the venue's own, and only its own. */
  readonly authorised_origins?: readonly string[];
  readonly policy?: HoldPolicyDocument;
  readonly claim_binding?: ClaimBinding;
  readonly handoff_gate_budget_ms?: DurationMs;
  /** Profile 0 and small Profile 1 sites inline their Occasions; larger ones link. */
  readonly occasions?: readonly OccasionDocument[];
  readonly occasions_url?: string;
  readonly read_rate_limit_per_hour?: number;
}

/**
 * The published `hold_policy`, with the floor clamped to what was measured.
 *
 * Exported because the adapter enforces the SAME clamped number it publishes —
 * §2.5's *"a Server MUST NOT enforce a limit it has not published"* is only
 * structural while one function produces both.
 */
export function warrantedPolicy(
  policy: HoldPolicyDocument,
  evidence: FloorEvidence,
): HoldPolicyDocument {
  const warrantable = warrantableFloorMs(evidence);
  if (evidence.observations <= 0) {
    throw new FloorNotWarranted(
      evidence,
      0,
      "no retention observation exists, so this Server publishes no floor and refuses 503 floor_unavailable (§7)",
    );
  }
  if (warrantable < HOLD_SCHEMA_MIN_FLOOR_MS) {
    throw new FloorNotWarranted(
      evidence,
      warrantable,
      `the measurement warrants ${warrantable}ms, below the ${HOLD_SCHEMA_MIN_FLOOR_MS}ms minimum ` +
        "hold.schema.json requires of floor_ms",
    );
  }
  return Object.freeze({
    ...policy,
    policy_max_floor_ms: Math.min(policy.policy_max_floor_ms, warrantable),
  });
}

/**
 * `handoff` where the warranted floor funds X6's arithmetic, `hold` where it
 * does not. Never `none`: this Server does gate, and publishing `none` to dodge
 * the inequality would be answering a MUST NOT by deleting the question.
 */
export function warrantedGateStage(
  policy: HoldPolicyDocument,
  handoff_gate_budget_ms: DurationMs,
): GateStage {
  const required = minPolicyMaxFloorMs(handoff_gate_budget_ms, policy.clock_guard_ms);
  return policy.policy_max_floor_ms >= required ? GATE_STAGE.handoff : GATE_STAGE.hold;
}

/**
 * Build the document. Throws {@link FloorNotWarranted} rather than publish a
 * floor nothing measured — a server-configuration defect, deliberately not a
 * `Refusal`, because nothing an Agent did caused it and nothing it can do fixes it.
 */
export function buildCapability(options: BuildCapabilityOptions): CapabilityDocument {
  const base = options.policy ?? HOLD_POLICY_PUBLISHED;
  const hold_policy = warrantedPolicy(base, options.evidence);
  const handoff_gate_budget_ms = options.handoff_gate_budget_ms ?? HANDOFF_GATE_BUDGET_DEFAULT_MS;
  const gate_stage = warrantedGateStage(hold_policy, handoff_gate_budget_ms);

  // X6, checked on the finished numbers rather than trusted from the branch
  // above. A GateBudgetError here is a defect in this builder, and it should
  // surface as one at configuration time and not as a refusal on the wire.
  assertGateBudget({
    gate_stage,
    handoff_gate_budget_ms,
    clock_guard_ms: hold_policy.clock_guard_ms,
    policy_max_floor_ms: hold_policy.policy_max_floor_ms,
  });

  const document: Record<string, unknown> = {
    changeover: "0.1",
    supported_versions: [...SUPPORTED_VERSIONS],
    profile: options.profile,
    venue: {
      id: options.venue.id,
      name: prose(options.venue.name),
      origin: options.venue.origin,
      timezone: options.venue.timezone,
      ...(options.venue.locality === undefined ? {} : { locality: options.venue.locality }),
    },
    authorised_origins: [...(options.authorised_origins ?? [options.venue.origin])],
    hold_policy,
    register_version: REGISTER_VERSION,
    claim_binding: options.claim_binding ?? DEFAULT_CLAIM_BINDING,
    gate_stage,
    handoff_gate_budget_ms,
    hold_basis: options.hold_basis,
    floor_basis: options.floor_basis,
    floor_evidence: { ...options.evidence },
    usage_policy: { ...REFERENCE_USAGE_POLICY },
    max_window_ms: MAX_WINDOW_MS,
    max_page_size: MAX_PAGE_SIZE,
    read_rate_limit_per_hour: options.read_rate_limit_per_hour ?? READ_RATE_LIMIT_PER_HOUR,
    log_retention_days: LOG_RETENTION_DAYS,
    generated_at: options.generated_at,
    max_document_age_ms: MAX_DOCUMENT_AGE_MS,
  };

  // `anyOf: [occasions_url, occasions]` — one of the two, and this is where a
  // Profile 0 static file and a Profile 1 service diverge.
  if (options.occasions_url !== undefined) document.occasions_url = options.occasions_url;
  if (options.occasions !== undefined) document.occasions = options.occasions.map((o) => ({ ...o }));
  if (document.occasions_url === undefined && document.occasions === undefined) {
    throw new Error(
      "adapter-reference: a capability document MUST carry occasions_url or an inline occasions array (§2.9)",
    );
  }

  return Object.freeze(document);
}

/* ── 3 · The limits this Server actually enforces ──────────────────────────── */

/**
 * C-CAPABILITY: *"no limit observed at runtime is absent from it."*
 *
 * The list is here, beside the builder, so the class is an assertion over two
 * objects rather than a reading of two files. Every name is a member of
 * `hold-policy.schema.json` or of the capability document itself; a limit this
 * Server begins enforcing and does not add here fails its own conformance class,
 * which is the point — §2.5 calls an undisclosed limit *indistinguishable from a
 * bug to a caller with no eyes*.
 */
export const ENFORCED_LIMIT_NAMES: readonly string[] = Object.freeze([
  "policy_max_floor_ms",
  "handoff_floor_ms",
  "clock_guard_ms",
  "max_clock_skew_tolerance_ms",
  "max_seats_per_hold",
  "max_live_holds_per_showtime",
  "max_holds_per_site_per_hour",
  "max_live_holds_per_cluster",
  "max_live_seats_per_showtime",
  "max_held_seat_fraction_bp",
  "max_held_fraction_per_showtime",
  "max_live_holds_per_site",
  "max_window_ms",
  "max_page_size",
  "read_rate_limit_per_hour",
  "handoff_gate_budget_ms",
]);

/** Every enforced limit that the document does not publish. Empty is conformant. */
export function unpublishedLimits(document: CapabilityDocument): readonly string[] {
  const policy = (document as { hold_policy?: Record<string, unknown> }).hold_policy ?? {};
  return ENFORCED_LIMIT_NAMES.filter(
    (name) =>
      !Object.prototype.hasOwnProperty.call(policy, name) &&
      !Object.prototype.hasOwnProperty.call(document, name),
  );
}
