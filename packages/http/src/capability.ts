/**
 * The two bootstrap documents, and the site they describe.
 *
 * `GET /.well-known/changeover` is the file the protocol bootstraps from, and
 * `GET /.well-known/changeover/delegation.json` is the one that says who else
 * may serve on this venue's behalf.
 *
 * **Delegation is served at the apex, or not at all.** SPEC.md §3.3: *"Delegation
 * is asserted by the venue at the venue's own apex, so no party can add itself
 * and the anti-aggregation property survives."* A delegated ticketing host that
 * also served a delegation record could delegate onward to anyone, and the
 * property the record exists to create would be gone the first time somebody
 * tried. So {@link SiteConfig.apex} decides whether this deployment answers
 * there at all, and a non-apex deployment has no such path.
 */

import type { DurationMs, Prose, Rfc3339 } from "@changeover/schema/refusal.ts";
import { HOLD_POLICY_PUBLISHED } from "@changeover/core/budgets.ts";
import type { HoldPolicyDocument } from "@changeover/core/budgets.ts";

import type { Profile } from "./credential.ts";

/* -- The site ---------------------------------------------------------------- */

export interface Venue {
  readonly id: string;
  readonly name: Prose;
  /** O1's bare origin: (scheme, host, port), ASCII-lowercased, default ports normalised. */
  readonly origin: string;
  readonly timezone: string;
  readonly locality?: string;
}

export interface UsagePolicy {
  readonly redistribution: "forbidden" | "attributed" | "allowed";
  readonly cache_max_age_ms: DurationMs;
  readonly attribution_text?: Prose;
  readonly terms_url?: string;
  /** A role address at the venue. Never a person: no personal data, anywhere. */
  readonly contact: string;
}

export interface FloorEvidence {
  readonly observations: number;
  readonly window_start: Rfc3339;
  readonly window_end: Rfc3339;
  readonly min_observed_retention_ms: DurationMs;
  readonly safety_margin_ms: DurationMs;
  readonly violations: number;
}

/**
 * Everything a deployment publishes about itself. One server instance serves one
 * site, because §6.3's credential is issued **per site** by the exhibitor: a
 * process serving two sites would have to decide which site an unauthenticated
 * `/.well-known/changeover` request meant, and every answer to that is a guess.
 */
export interface SiteConfig {
  readonly site_id: string;
  readonly profile: Profile;
  readonly venue: Venue;
  readonly authorised_origins: readonly string[];
  /** Whether this deployment is the venue's apex. Only an apex serves delegation. */
  readonly apex: boolean;
  /** The origins this venue delegates to, asserted here and nowhere else. */
  readonly delegated_origins?: readonly string[];
  /** How long the delegation record may be believed. */
  readonly delegation_max_age_ms?: DurationMs;
  readonly hold_policy?: HoldPolicyDocument;
  readonly register_version?: string;
  readonly claim_binding?: "session_resume" | "deep_link" | "manual";
  readonly gate_stage?: "hold" | "handoff" | "none";
  readonly handoff_gate_budget_ms?: DurationMs;
  readonly hold_basis?: "system_of_record" | "shadow";
  readonly floor_basis?: "owned_store" | "measured_warranty";
  readonly floor_evidence: FloorEvidence;
  readonly usage_policy: UsagePolicy;
  readonly max_window_ms?: DurationMs;
  readonly max_page_size?: number;
  readonly read_rate_limit_per_hour?: number;
  readonly log_retention_days?: number;
  readonly max_document_age_ms?: DurationMs;
  readonly occasions_url?: string;
}

/** §6.3's own default window, and `capability.schema.json`'s. Fourteen days. */
export const DEFAULT_MAX_WINDOW_MS: DurationMs = 1209600000;
export const DEFAULT_MAX_PAGE_SIZE = 200;
export const DEFAULT_LOG_RETENTION_DAYS = 90;
export const DEFAULT_MAX_DOCUMENT_AGE_MS: DurationMs = 300000;
export const DEFAULT_DELEGATION_MAX_AGE_MS: DurationMs = 86400000;

export function maxWindowMs(site: SiteConfig): DurationMs {
  return site.max_window_ms ?? DEFAULT_MAX_WINDOW_MS;
}

export function maxPageSize(site: SiteConfig): number {
  return site.max_page_size ?? DEFAULT_MAX_PAGE_SIZE;
}

export function maxDocumentAgeMs(site: SiteConfig): DurationMs {
  return site.max_document_age_ms ?? DEFAULT_MAX_DOCUMENT_AGE_MS;
}

/* -- The capability document ------------------------------------------------- */

export interface CapabilityDocument {
  readonly changeover: "0.1";
  readonly supported_versions: readonly string[];
  readonly profile: Profile;
  readonly venue: Venue;
  readonly authorised_origins: readonly string[];
  readonly hold_policy: HoldPolicyDocument;
  readonly register_version: string;
  readonly claim_binding: "session_resume" | "deep_link" | "manual";
  readonly gate_stage: "hold" | "handoff" | "none";
  readonly handoff_gate_budget_ms: DurationMs;
  readonly hold_basis: "system_of_record" | "shadow";
  readonly floor_basis: "owned_store" | "measured_warranty";
  readonly floor_evidence: FloorEvidence;
  readonly usage_policy: UsagePolicy;
  readonly max_window_ms: DurationMs;
  readonly max_page_size: number;
  readonly read_rate_limit_per_hour: number;
  readonly log_retention_days: number;
  readonly occasions_url?: string;
  /** Profile 0 publishes its Occasions inside this document. Profile 1 does not. */
  readonly occasions?: readonly unknown[];
  readonly generated_at: Rfc3339;
  readonly max_document_age_ms: DurationMs;
}

/**
 * Build the capability document.
 *
 * `hold_policy` defaults to `HOLD_POLICY_PUBLISHED` — the same object the guards
 * clamp against — rather than to a literal written here. §2.5: a Server MUST NOT
 * enforce a limit it has not published, and the only way to be sure of that is
 * for the published document and the enforced table to be **one value**.
 *
 * Profile 0 embeds its Occasions, which is what makes "any cinema with a website
 * is conformant with no software" true: the capability document plus the
 * Occasions is a static file, and this function produces exactly that file.
 */
export function capabilityDocument(
  site: SiteConfig,
  generated_at: Rfc3339,
  supported_versions: readonly string[],
  occasions?: readonly unknown[],
): CapabilityDocument {
  const document: {
    -readonly [K in keyof CapabilityDocument]: CapabilityDocument[K];
  } = {
    changeover: "0.1",
    supported_versions: [...supported_versions],
    profile: site.profile,
    venue: site.venue,
    authorised_origins: [...site.authorised_origins],
    hold_policy: site.hold_policy ?? HOLD_POLICY_PUBLISHED,
    register_version: site.register_version ?? "2026.1",
    claim_binding: site.claim_binding ?? "deep_link",
    gate_stage: site.gate_stage ?? "handoff",
    handoff_gate_budget_ms: site.handoff_gate_budget_ms ?? 120000,
    hold_basis: site.hold_basis ?? (site.profile === "1S" ? "shadow" : "system_of_record"),
    floor_basis: site.floor_basis ?? "owned_store",
    floor_evidence: site.floor_evidence,
    usage_policy: site.usage_policy,
    max_window_ms: maxWindowMs(site),
    max_page_size: maxPageSize(site),
    read_rate_limit_per_hour: site.read_rate_limit_per_hour ?? 0,
    log_retention_days: site.log_retention_days ?? DEFAULT_LOG_RETENTION_DAYS,
    generated_at,
    max_document_age_ms: maxDocumentAgeMs(site),
  };
  if (site.occasions_url !== undefined) document.occasions_url = site.occasions_url;
  if (occasions !== undefined) document.occasions = occasions;
  return document;
}

/* -- The delegation record --------------------------------------------------- */

/**
 * `https://{venue.origin}/.well-known/changeover/delegation.json`.
 *
 * There is no frozen schema for this record — `schemas/` holds eight document
 * schemas and this is not one of them — so its members are named to the build
 * contract's own conventions rather than invented freely. In particular the
 * duration is `max_age_ms`, not `max_age`: §6.3 writes "with a `max_age`" in
 * prose, and every duration an implementation reasons about in this project is
 * an integer of milliseconds with `_ms` in its name. A bare `max_age` would be
 * the one duration in the protocol whose unit a reader had to guess, next to a
 * `Cache-Control` header in seconds.
 */
export interface DelegationRecord {
  readonly changeover: "0.1";
  /** The venue asserting the delegation. Always this apex. */
  readonly origin: string;
  readonly delegated_origins: readonly string[];
  readonly max_age_ms: DurationMs;
  readonly generated_at: Rfc3339;
}

export function delegationRecord(site: SiteConfig, generated_at: Rfc3339): DelegationRecord {
  return {
    changeover: "0.1",
    origin: site.venue.origin,
    delegated_origins: [...(site.delegated_origins ?? [])],
    max_age_ms: site.delegation_max_age_ms ?? DEFAULT_DELEGATION_MAX_AGE_MS,
    generated_at,
  };
}
