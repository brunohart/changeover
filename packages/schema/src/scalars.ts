/**
 * Shared scalar vocabulary for the CHANGEOVER wire.
 *
 * Every value here is transcribed from a frozen artefact — `schemas/common.schema.json`
 * and `schemas/hold.schema.json` — and `scripts/prove_refusals_closed.sh` asserts the
 * two closed enums below set-equal, in both directions, against those files. Nothing in
 * this module is a convention; each item is a claim that is checked.
 *
 * Type-stripping rules (docs/BUILD-CONTRACT.md §5): `as const` object + union type.
 * Never `enum`.
 */

/** RFC 3339 timestamp with a mandatory offset. Never a `Date`, never epoch millis. */
export type Rfc3339 = string;

/** An integer of milliseconds. Never an ISO 8601 duration, never seconds, never a float. */
export type DurationMs = number;

/**
 * `schemas/common.schema.json#/$defs/prose` — PR: non-load-bearing human text,
 * outside PROJECTION_0_1, rendered as plain text regardless of `content_type` (V4).
 */
export interface Prose {
  content_type: "text/plain";
  value: string;
}

/** `$defs/prose.properties.value.maxLength`. Prose is clamped, never allowed to invalidate a document. */
export const PROSE_MAX_LENGTH = 2000;

/** Build a prose envelope, clamped to the schema's own bound. */
export function prose(value: string): Prose {
  return { content_type: "text/plain", value: value.length > PROSE_MAX_LENGTH ? value.slice(0, PROSE_MAX_LENGTH) : value };
}

/** `schemas/common.schema.json#/$defs/axis` — the non-substitutability axes. */
export const AXIS = {
  instant: "instant",
  auditorium: "auditorium",
  presentation_class: "presentation_class",
  occasion_class: "occasion_class",
  price_band: "price_band",
  seat: "seat",
  accessibility: "accessibility",
} as const;
export type Axis = (typeof AXIS)[keyof typeof AXIS];
export const AXES: readonly Axis[] = Object.freeze(Object.keys(AXIS) as Axis[]);

/** `schemas/hold.schema.json#/properties/revocation_reason` — Operator Override reasons. */
export const REVOCATION_REASON = {
  session_cancelled: "session_cancelled",
  session_moved: "session_moved",
  seat_withdrawn: "seat_withdrawn",
  safety: "safety",
  venue_operations: "venue_operations",
  credential_revoked: "credential_revoked",
} as const;
export type RevocationReason = (typeof REVOCATION_REASON)[keyof typeof REVOCATION_REASON];
export const REVOCATION_REASONS: readonly RevocationReason[] = Object.freeze(Object.keys(REVOCATION_REASON) as RevocationReason[]);
