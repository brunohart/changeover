/**
 * The refusal taxonomy — one module, single source of truth.
 *
 * SPEC.md §2.7 (the Refusal document) and §6.3 (the code table: every code, its HTTP
 * status, its retryability). `schemas/refusal.schema.json` is the frozen wire contract
 * and this module is bound to it mechanically: `scripts/prove_refusals_closed.sh`
 * asserts set equality, in BOTH directions, between the codes here, the `code` enum in
 * the schema, and the codes parsed out of §6.3's markdown table — and asserts that
 * every `detail` shape declared here is exactly the branch the schema declares.
 *
 * Three properties this module exists to make structural rather than conventional:
 *
 *  1. **The code set is closed.** There is no `other`, no free-form string, no escape
 *     hatch. An unmatched condition is a defect, not a new code invented at the call
 *     site — because the set is what an Agent's whole decision procedure ranges over.
 *
 *  2. **`detail` is bound per code.** A code with a branch requires it; a code the
 *     schema declares `detail: false` for MUST emit none. Wrong-shaped detail is a
 *     TypeScript error where the code is a literal, and a construction-time throw
 *     where it is not. A malformed refusal never reaches the wire.
 *
 *  3. **`reason` is a prose envelope, and nothing reads it.** It is explicitly
 *     non-load-bearing and never an instruction. There is deliberately no free-text
 *     `suggestion` member (SPEC.md §2.7 deletes the draft's): it was an instruction
 *     channel to a consumer with no judgement. **An Agent MUST derive its next action
 *     from `code` and `remediation` only.**
 *
 * A refusal is THROWN, never returned. Throwing is what makes "a refusal MUST NOT be
 * mixed with rows; first failure wins" structural: a guard cascade that throws cannot
 * accumulate a partial result alongside an error.
 *
 * Type-stripping rules (docs/BUILD-CONTRACT.md §5): `as const` objects and union types.
 * No `enum`, no namespace, no decorators, no parameter properties.
 */

import type { Axis, DurationMs, Prose, Rfc3339, RevocationReason } from "./scalars.ts";
import { prose } from "./scalars.ts";

export type { Axis, DurationMs, Prose, Rfc3339, RevocationReason } from "./scalars.ts";
export { AXIS, AXES, REVOCATION_REASON, REVOCATION_REASONS, PROSE_MAX_LENGTH, prose } from "./scalars.ts";

/* ── 1 · The closed code set ───────────────────────────────────────────────── */

/**
 * Every refusal code, in the order SPEC.md §6.3 tables them (ascending HTTP status).
 * Set-equal, both directions, with `schemas/refusal.schema.json#/properties/code/enum`.
 */
export const REFUSAL_CODE = {
  schema_validation: "schema_validation",
  hint_rejected: "hint_rejected",
  unknown_seat: "unknown_seat",
  window_too_wide: "window_too_wide",
  not_authorised: "not_authorised",
  principal_scope_missing: "principal_scope_missing",
  occasion_not_found: "occasion_not_found",
  hold_not_found: "hold_not_found",
  seat_contended: "seat_contended",
  seat_unavailable: "seat_unavailable",
  seat_rule_violated: "seat_rule_violated",
  availability_unknown: "availability_unknown",
  availability_stale: "availability_stale",
  past_sales_cutoff: "past_sales_cutoff",
  hold_not_live: "hold_not_live",
  hold_expired: "hold_expired",
  hold_revoked: "hold_revoked",
  handoff_consumed: "handoff_consumed",
  stale_read: "stale_read",
  idempotency_in_flight: "idempotency_in_flight",
  claim_consumed: "claim_consumed",
  claim_expired: "claim_expired",
  occasion_moved: "occasion_moved",
  substitution_refused: "substitution_refused",
  idempotency_key_reused: "idempotency_key_reused",
  hold_budget_exhausted: "hold_budget_exhausted",
  seat_budget_exhausted: "seat_budget_exhausted",
  cluster_fanout: "cluster_fanout",
  rate_limited: "rate_limited",
  profile_not_supported: "profile_not_supported",
  floor_unavailable: "floor_unavailable",
  upstream_unavailable: "upstream_unavailable",
} as const;

export type RefusalCode = (typeof REFUSAL_CODE)[keyof typeof REFUSAL_CODE];

/** The code set as an array. Frozen: the closure is the point. */
export const REFUSAL_CODES: readonly RefusalCode[] = Object.freeze(Object.keys(REFUSAL_CODE) as RefusalCode[]);

export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === "string" && Object.hasOwn(REFUSAL_CODE, value);
}

/* ── 2 · The closed remediation set ────────────────────────────────────────── */

/**
 * SPEC.md §2.7. This, with `code`, is the ENTIRE decision surface an Agent may act on.
 * Set-equal, both directions, with `schemas/refusal.schema.json#/properties/remediation/enum`.
 */
export const REMEDIATION = {
  re_resolve: "re_resolve",
  re_read: "re_read",
  release_conflicting_hold: "release_conflicting_hold",
  retry_same_key: "retry_same_key",
  retry_after: "retry_after",
  hand_off_existing: "hand_off_existing",
  use_book_url: "use_book_url",
  contact_venue: "contact_venue",
  none: "none",
} as const;

export type Remediation = (typeof REMEDIATION)[keyof typeof REMEDIATION];
export const REMEDIATIONS: readonly Remediation[] = Object.freeze(Object.keys(REMEDIATION) as Remediation[]);

/* ── 3 · Code → HTTP status ────────────────────────────────────────────────── */

/**
 * Transcribed from SPEC.md §6.3's table. The proof re-parses that table out of the
 * markdown and asserts every status here equals the one printed there — so a status
 * edited in the specification and not here FAILS, rather than drifting quietly into
 * a binding that two implementations then disagree about.
 */
export const REFUSAL_STATUS = {
  schema_validation: 400,
  hint_rejected: 400,
  unknown_seat: 400,
  window_too_wide: 400,
  not_authorised: 403,
  principal_scope_missing: 403,
  occasion_not_found: 404,
  hold_not_found: 404,
  seat_contended: 409,
  seat_unavailable: 409,
  seat_rule_violated: 409,
  availability_unknown: 409,
  availability_stale: 409,
  past_sales_cutoff: 409,
  hold_not_live: 409,
  hold_expired: 409,
  hold_revoked: 409,
  handoff_consumed: 409,
  stale_read: 409,
  idempotency_in_flight: 409,
  claim_consumed: 409,
  claim_expired: 410,
  occasion_moved: 412,
  substitution_refused: 412,
  idempotency_key_reused: 422,
  hold_budget_exhausted: 429,
  seat_budget_exhausted: 429,
  cluster_fanout: 429,
  rate_limited: 429,
  profile_not_supported: 501,
  floor_unavailable: 503,
  upstream_unavailable: 503,
} as const satisfies Record<RefusalCode, number>;

/* ── 4 · Code → retryability ───────────────────────────────────────────────── */

/**
 * §6.3's third column, tokenised. `no` is not "try again later"; it means the same
 * call will never succeed, and an Agent that retries it is a hammer.
 *
 * `same_key` is the one that is easy to get wrong: `idempotency_in_flight` is retryable
 * ONLY with the identical `Idempotency-Key`. Retrying it with a fresh key duplicates
 * the hold, which is exactly the failure idempotency exists to prevent.
 */
export const RETRY_KIND = {
  no: "no",
  after_re_resolve: "after_re_resolve",
  after_get_hold: "after_get_hold",
  after_release: "after_release",
  retry_after_ms: "retry_after_ms",
  same_key: "same_key",
} as const;

export type RetryKind = (typeof RETRY_KIND)[keyof typeof RETRY_KIND];

export const REFUSAL_RETRYABILITY = {
  schema_validation: "no",
  hint_rejected: "no",
  unknown_seat: "no",
  window_too_wide: "no",
  not_authorised: "no",
  principal_scope_missing: "no",
  occasion_not_found: "no",
  hold_not_found: "no",
  seat_contended: "after_re_resolve",
  seat_unavailable: "after_re_resolve",
  seat_rule_violated: "after_re_resolve",
  availability_unknown: "no",
  availability_stale: "after_re_resolve",
  past_sales_cutoff: "no",
  hold_not_live: "no",
  hold_expired: "after_re_resolve",
  hold_revoked: "no",
  handoff_consumed: "no",
  stale_read: "after_get_hold",
  idempotency_in_flight: "same_key",
  claim_consumed: "no",
  claim_expired: "no",
  occasion_moved: "after_re_resolve",
  substitution_refused: "no",
  idempotency_key_reused: "no",
  hold_budget_exhausted: "retry_after_ms",
  seat_budget_exhausted: "retry_after_ms",
  cluster_fanout: "after_release",
  rate_limited: "retry_after_ms",
  profile_not_supported: "no",
  floor_unavailable: "retry_after_ms",
  upstream_unavailable: "retry_after_ms",
} as const satisfies Record<RefusalCode, RetryKind>;

/** True where §6.3 says the SAME call may be repeated after a wait. */
export function isRetryable(code: RefusalCode): boolean {
  return REFUSAL_RETRYABILITY[code] !== "no";
}

/** Codes for which `retry_after_ms` is the wait an Agent must honour. */
export function wantsRetryAfterMs(code: RefusalCode): boolean {
  const kind: RetryKind = REFUSAL_RETRYABILITY[code];
  return kind === "retry_after_ms" || kind === "same_key";
}

/* ── 5 · Code → remediation default ────────────────────────────────────────── */

/**
 * The remediation a Server emits unless the call site has a better one. Defaults, not
 * law: a caller MAY override, and the schema constrains only membership of the enum.
 *
 * Consistency with §6.3 is asserted mechanically by the proof, in the direction the
 * table actually fixes: `after_re_resolve → re_resolve`, `after_get_hold → re_read`,
 * `after_release → release_conflicting_hold`, `same_key → retry_same_key`,
 * `retry_after_ms → retry_after`, and `no →` never a retry remediation. Two of them
 * are pinned by SPEC.md's own worked example (§9): `cluster_fanout` carries
 * `release_conflicting_hold` (SPEC.md:724) and `substitution_refused` carries
 * `re_resolve` (SPEC.md:735).
 */
export const REFUSAL_REMEDIATION = {
  schema_validation: "none",
  hint_rejected: "none",
  unknown_seat: "re_resolve",
  window_too_wide: "none",
  not_authorised: "contact_venue",
  principal_scope_missing: "contact_venue",
  occasion_not_found: "re_resolve",
  hold_not_found: "none",
  seat_contended: "re_resolve",
  seat_unavailable: "re_resolve",
  seat_rule_violated: "re_resolve",
  availability_unknown: "use_book_url",
  availability_stale: "re_resolve",
  past_sales_cutoff: "none",
  hold_not_live: "none",
  hold_expired: "re_resolve",
  hold_revoked: "use_book_url",
  handoff_consumed: "none",
  stale_read: "re_read",
  idempotency_in_flight: "retry_same_key",
  claim_consumed: "none",
  claim_expired: "use_book_url",
  occasion_moved: "re_resolve",
  substitution_refused: "re_resolve",
  idempotency_key_reused: "none",
  hold_budget_exhausted: "retry_after",
  seat_budget_exhausted: "retry_after",
  cluster_fanout: "release_conflicting_hold",
  rate_limited: "retry_after",
  profile_not_supported: "use_book_url",
  floor_unavailable: "retry_after",
  upstream_unavailable: "retry_after",
} as const satisfies Record<RefusalCode, Remediation>;

/* ── 6 · The detail branches, bound per code ───────────────────────────────── */

/** `seat_contended | unknown_seat | seat_unavailable` */
export interface SeatIdsDetail {
  seat_ids: string[];
}

/** `seat_rule_violated` */
export interface SeatRuleViolatedDetail {
  rule: string;
  suggested_seats?: string[];
}

/** `occasion_moved` */
export interface OccasionMovedDetail {
  changed_paths: string[];
}

/** `substitution_refused` (S1) */
export interface SubstitutionRefusedDetail {
  from_occasion_id: string;
  crossed_axis: Axis;
}

/** `cluster_fanout` (X-series) */
export interface ClusterFanoutDetail {
  conflicting_hold_id: string;
  cluster: string;
  limit: number;
}

/** `hold_budget_exhausted` */
export interface HoldBudgetExhaustedDetail {
  limit: number;
  window_ms: DurationMs;
}

/** `seat_budget_exhausted` (X4) */
export interface SeatBudgetExhaustedDetail {
  limit: number;
}

/** `hold_expired` (HO1) */
export interface HoldExpiredDetail {
  expired_at: Rfc3339;
  occasion_id: string;
}

/** `hold_revoked` — Operator Override */
export interface HoldRevokedDetail {
  revocation_reason: RevocationReason;
  book_url?: string;
}

/**
 * The `oneOf`, keyed on code. Every key here has a branch in
 * `schemas/refusal.schema.json`; every code absent from here is declared `detail: false`
 * there. The proof asserts that partition in both directions.
 */
export interface RefusalDetailMap {
  seat_contended: SeatIdsDetail;
  unknown_seat: SeatIdsDetail;
  seat_unavailable: SeatIdsDetail;
  seat_rule_violated: SeatRuleViolatedDetail;
  occasion_moved: OccasionMovedDetail;
  substitution_refused: SubstitutionRefusedDetail;
  cluster_fanout: ClusterFanoutDetail;
  hold_budget_exhausted: HoldBudgetExhaustedDetail;
  seat_budget_exhausted: SeatBudgetExhaustedDetail;
  hold_expired: HoldExpiredDetail;
  hold_revoked: HoldRevokedDetail;
}

export type DetailBearingCode = keyof RefusalDetailMap;
export type DetailFreeCode = Exclude<RefusalCode, DetailBearingCode>;
export type RefusalDetail = RefusalDetailMap[DetailBearingCode];

/**
 * The runtime half of the binding: required and permitted members per branch, so that
 * a detail assembled from untyped data (a row, a JSON body, a `catch`) is still checked.
 * `additionalProperties: false` on every branch is enforced here as `permitted`.
 *
 * The proof asserts this table set-equal, member by member, with the schema's branches.
 * It is a transcription, and a transcription that is not checked is a lie waiting.
 */
export const REFUSAL_DETAIL_SHAPE = {
  seat_contended: { required: ["seat_ids"], optional: [] },
  unknown_seat: { required: ["seat_ids"], optional: [] },
  seat_unavailable: { required: ["seat_ids"], optional: [] },
  seat_rule_violated: { required: ["rule"], optional: ["suggested_seats"] },
  occasion_moved: { required: ["changed_paths"], optional: [] },
  substitution_refused: { required: ["from_occasion_id", "crossed_axis"], optional: [] },
  cluster_fanout: { required: ["conflicting_hold_id", "cluster", "limit"], optional: [] },
  hold_budget_exhausted: { required: ["limit", "window_ms"], optional: [] },
  seat_budget_exhausted: { required: ["limit"], optional: [] },
  hold_expired: { required: ["expired_at", "occasion_id"], optional: [] },
  hold_revoked: { required: ["revocation_reason"], optional: ["book_url"] },
} as const satisfies Record<DetailBearingCode, { required: readonly string[]; optional: readonly string[] }>;

/** The 11 codes carrying a detail branch. */
export const DETAIL_BEARING_CODES: readonly DetailBearingCode[] =
  Object.freeze(Object.keys(REFUSAL_DETAIL_SHAPE) as DetailBearingCode[]);

/** The 21 codes the schema declares `detail: false` for. They MUST emit none. */
export const DETAIL_FREE_CODES: readonly DetailFreeCode[] =
  Object.freeze(REFUSAL_CODES.filter((c): c is DetailFreeCode => !Object.hasOwn(REFUSAL_DETAIL_SHAPE, c)));

export function carriesDetail(code: RefusalCode): code is DetailBearingCode {
  return Object.hasOwn(REFUSAL_DETAIL_SHAPE, code);
}

/* ── 7 · Construction-time enforcement ─────────────────────────────────────── */

/**
 * A refusal that could not be built. This is a SERVER DEFECT, not a client refusal:
 * it is deliberately NOT a `Refusal`, so `isRefusal()` is false for it, so a binding
 * renders it as an internal fault rather than handing a consumer a malformed document
 * with a code it will branch on. See docs/BUILD-CONTRACT.md §6.
 */
export class RefusalShapeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`refusal ${code}: ${message}`);
    this.name = "RefusalShapeError";
    this.code = code;
  }
}

function checkDetail(code: RefusalCode, detail: unknown): void {
  if (!carriesDetail(code)) {
    if (detail !== undefined) {
      throw new RefusalShapeError(code, `schemas/refusal.schema.json declares "detail": false for this code; none may be emitted`);
    }
    return;
  }
  if (detail === undefined) {
    throw new RefusalShapeError(code, "this code carries a detail branch and detail is required");
  }
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    throw new RefusalShapeError(code, "detail must be an object");
  }
  const shape = REFUSAL_DETAIL_SHAPE[code];
  const permitted = new Set<string>([...shape.required, ...shape.optional]);
  for (const member of shape.required) {
    if ((detail as Record<string, unknown>)[member] === undefined) {
      throw new RefusalShapeError(code, `detail.${member} is required by this branch`);
    }
  }
  for (const member of Object.keys(detail)) {
    if ((detail as Record<string, unknown>)[member] === undefined) continue;
    if (!permitted.has(member)) {
      throw new RefusalShapeError(code, `detail.${member} is not a member of this branch (additionalProperties: false)`);
    }
  }
}

/* ── 8 · The wire document ─────────────────────────────────────────────────── */

/**
 * `urn:changeover:schema:refusal:0.1`. REQUIRED `{refused, code, remediation, reason,
 * server_time}`, OPTIONAL `{detail, retry_after_ms}`, `additionalProperties: false`.
 *
 * `reason` is the prose envelope — an OBJECT on the wire, `{content_type, value}` —
 * while `Refusal.reason` is the bare string. That is the only shape difference between
 * the class and the document, and it is deliberate: prose is carried, never parsed.
 */
export interface RefusalDocument {
  refused: true;
  code: RefusalCode;
  remediation: Remediation;
  reason: Prose;
  detail?: RefusalDetail;
  retry_after_ms?: DurationMs;
  server_time: Rfc3339;
}

/* ── 9 · The typed error both bindings map from ────────────────────────────── */

const REFUSAL_BRAND: unique symbol = Symbol.for("urn:changeover:schema:refusal:0.1");

/**
 * The extra members a given code admits. For a literal detail-bearing code `detail` is
 * REQUIRED and typed to that code's branch; for a literal detail-free code `detail` is
 * `never`, so supplying one is a compile error. Where the code is only known as the
 * whole union, TypeScript cannot decide and `checkDetail()` decides at construction.
 */
export type RefusalExtra<C extends RefusalCode> = C extends DetailBearingCode
  ? { readonly detail: RefusalDetailMap[C]; readonly retry_after_ms?: DurationMs }
  : { readonly detail?: never; readonly retry_after_ms?: DurationMs };

type RefusalRest<C extends RefusalCode> = [C] extends [DetailBearingCode]
  ? [extra: RefusalExtra<C>]
  : [extra?: RefusalExtra<C>];

/**
 * Thrown, never returned. A binding catches EXACTLY this and renders it; anything else
 * is an unexpected fault, is a 500, and must never reach the wire with its message —
 * an internal error string is an uncontrolled prose channel to a consumer with no
 * judgement, which is what SPEC.md §5.3 exists to prevent.
 */
export class Refusal<C extends RefusalCode = RefusalCode> extends Error {
  readonly refused: true = true;
  readonly code: C;
  readonly remediation: Remediation;
  /** Prose envelope. Non-load-bearing. Never an instruction. Nothing branches on it. */
  readonly reason: string;
  readonly detail?: RefusalDetail;
  readonly retry_after_ms?: DurationMs;
  readonly [REFUSAL_BRAND]: true = true;

  constructor(code: C, remediation: Remediation, reason: string, ...rest: RefusalRest<C>) {
    super(reason);
    const extra = (rest as ReadonlyArray<{ detail?: RefusalDetail; retry_after_ms?: DurationMs } | undefined>)[0];
    if (!isRefusalCode(code)) {
      throw new RefusalShapeError(String(code), "not a member of the closed code set (SPEC.md §6.3)");
    }
    if (!Object.hasOwn(REMEDIATION, remediation)) {
      throw new RefusalShapeError(code, `remediation "${String(remediation)}" is not a member of the closed set (SPEC.md §2.7)`);
    }
    checkDetail(code, extra?.detail);
    if (extra?.retry_after_ms !== undefined && (!Number.isInteger(extra.retry_after_ms) || extra.retry_after_ms < 0)) {
      throw new RefusalShapeError(code, "retry_after_ms must be a non-negative integer of milliseconds");
    }
    this.name = "Refusal";
    this.code = code;
    this.remediation = remediation;
    this.reason = reason;
    if (extra?.detail !== undefined) this.detail = extra.detail;
    if (extra?.retry_after_ms !== undefined) this.retry_after_ms = extra.retry_after_ms;
  }

  /** The HTTP status SPEC.md §6.3 fixes for this code. */
  get status(): number {
    return REFUSAL_STATUS[this.code];
  }

  /** §6.3's retryability token for this code. */
  get retryability(): RetryKind {
    return REFUSAL_RETRYABILITY[this.code];
  }

  /**
   * The wire document. `server_time` is projected HERE, at render time, per C-CLOCK —
   * a refusal built inside a guard cascade must not carry the moment the guard ran.
   */
  toDocument(server_time: Rfc3339): RefusalDocument {
    const document: RefusalDocument = {
      refused: true,
      code: this.code,
      remediation: this.remediation,
      reason: prose(this.reason),
      server_time,
    };
    if (this.detail !== undefined) document.detail = this.detail;
    if (this.retry_after_ms !== undefined) document.retry_after_ms = this.retry_after_ms;
    return document;
  }
}

/** Cross-realm safe: branded, so a Refusal from another module instance still matches. */
export function isRefusal(err: unknown): err is Refusal {
  if (err instanceof Refusal) return true;
  return typeof err === "object" && err !== null &&
    (err as Record<symbol, unknown>)[REFUSAL_BRAND] === true;
}

/* ── 10 · The constructor call sites use ───────────────────────────────────── */

export type RefuseOptions<C extends RefusalCode> = C extends DetailBearingCode
  ? { readonly remediation?: Remediation; readonly detail: RefusalDetailMap[C]; readonly retry_after_ms?: DurationMs }
  : { readonly remediation?: Remediation; readonly detail?: never; readonly retry_after_ms?: DurationMs };

type RefuseRest<C extends RefusalCode> = [C] extends [DetailBearingCode]
  ? [options: RefuseOptions<C>]
  : [options?: RefuseOptions<C>];

/**
 * Build a schema-valid Refusal, defaulting `remediation` from `REFUSAL_REMEDIATION`.
 *
 *   throw refuse("seat_contended", "Named seats went to another hold.", { detail: { seat_ids } });
 *   throw refuse("hold_not_live", "That hold has already ended.");
 *
 * Omitting `detail` for a detail-bearing code, or supplying one for a code the schema
 * declares `detail: false` for, is a compile error at a literal code and a
 * `RefusalShapeError` otherwise. There is no path that produces an invalid document.
 */
export function refuse<C extends RefusalCode>(code: C, reason: string, ...rest: RefuseRest<C>): Refusal<C> {
  const options = (rest as ReadonlyArray<{ remediation?: Remediation; detail?: RefusalDetail; retry_after_ms?: DurationMs } | undefined>)[0];
  if (!isRefusalCode(code)) {
    throw new RefusalShapeError(String(code), "not a member of the closed code set (SPEC.md §6.3)");
  }
  const remediation: Remediation = options?.remediation ?? REFUSAL_REMEDIATION[code];
  const extra = { detail: options?.detail, retry_after_ms: options?.retry_after_ms };
  return new Refusal(code as RefusalCode, remediation, reason, extra as RefusalExtra<RefusalCode>) as Refusal<C>;
}
