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

/**
 * The scheme allowlist PR2 names, and the reason it is an allowlist.
 *
 * §5.3 records the reviewer proposal that was rejected: a generic
 * `[a-z][a-z0-9+.-]*:` at a word boundary also rejects a programme note
 * beginning "note:", and here it would reject *Kill Bill: Vol. 1*, which is a
 * film. `://` is listed separately because it is a scheme separator whatever
 * precedes it.
 *
 * This list is the single copy. `packages/core/src/access-log.ts` imports it
 * for P1's `work_hint` check rather than keeping a second one: two lists of
 * schemes drift, and the drift is silent.
 */
export const URI_SCHEMES: readonly string[] = Object.freeze([
  "http", "https", "ftp", "ftps", "file", "ws", "wss", "mailto", "tel", "sms",
  "data", "blob", "javascript", "vbscript", "about", "urn", "view-source",
  "intent", "market", "chrome", "chrome-extension", "resource",
]);

export const URI_SCHEME_PATTERN = new RegExp(
  `(^|[^\\p{L}\\p{N}])(${URI_SCHEMES.join("|")})\\s*:`,
  "iu",
);

/**
 * A bare host, in the bounded form this repository can actually check.
 *
 * PR2 says "a bare host matching a public-suffix pattern". The real Public
 * Suffix List is thousands of entries and a dependency, and nobody on this
 * build may run `npm install` — so what ships is a labelled subset: the
 * RFC 2606 reserved names, which is what every fixture and every poison corpus
 * in this tree actually uses, plus the generic TLDs an attacker reaches for
 * first. **This is narrower than PR2 and is recorded as such** in
 * `docs/2026-08-25-cx-02-core-build.md`; a bare `evil.museum` with no scheme is
 * not caught here.
 */
const BARE_HOST_TLDS: readonly string[] = Object.freeze([
  "test", "example", "invalid", "localhost",
  "com", "net", "org", "io", "co", "app", "dev", "xyz", "info", "biz",
]);

const BARE_HOST_PATTERN = new RegExp(
  `(^|[\\s(<"'])([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(${BARE_HOST_TLDS.join("|")})(?![a-z0-9-])`,
  "i",
);

/** C0 controls, and U+007F with them. `\n` is the one this rule spares. */
const C0_EXCEPT_NEWLINE = new RegExp("[\\u0000-\\u0009\\u000B-\\u001F\\u007F]", "g");

/**
 * Thrown where a value cannot be published as prose. A publish failure, never a
 * caller refusal: every caller of {@link prose} passes text the Server itself
 * authored, and a caller-supplied string reaching this function is the defect —
 * not the throw.
 */
export class ProseNotPublishable extends Error {
  readonly rule: string;
  constructor(rule: string, why: string) {
    super(why);
    this.name = "ProseNotPublishable";
    this.rule = rule;
  }
}

/**
 * Build a prose envelope: §5.3 clause 3 and PR2, all of it.
 *
 * Three properties, and until 2026-08-26 this function implemented one. The doc
 * comment said "prose is clamped, never allowed to invalidate a document",
 * which is true, and was read as though it were the whole rule — so `https://`,
 * `mailto:`, `javascript:`, U+0007 and an ANSI colour escape all travelled to
 * the wire inside an envelope §2.7 declares non-load-bearing.
 *
 * 1. **C0 controls other than newline are stripped**, U+007F with them: the
 *    stated concern is an operator tailing a log, and an ANSI escape is a
 *    terminal-rendering attack against exactly that reader.
 * 2. **Consecutive newlines collapse.** Enough blank lines is a system prompt
 *    displaced, which is Q1's concern arriving one envelope at a time.
 * 3. **PR2 rejects at publish** — `://`, an allowlisted scheme, or a bare host.
 *    PR2 says *reject*, so this throws rather than filtering: a filtered link
 *    is a Server claiming to detect injection, which §5.3 forbids in as many
 *    words.
 *
 * The clamp runs last, so a link that would have been sliced off at 2000
 * characters is still rejected.
 */
export function prose(value: string): Prose {
  const collapsed = value.replace(C0_EXCEPT_NEWLINE, "").replace(/\n{2,}/g, "\n");
  if (collapsed.includes("://")) {
    throw new ProseNotPublishable("PR2", "a prose value carried a scheme separator");
  }
  if (URI_SCHEME_PATTERN.test(collapsed)) {
    throw new ProseNotPublishable("PR2", "a prose value carried a navigable scheme");
  }
  if (BARE_HOST_PATTERN.test(collapsed)) {
    throw new ProseNotPublishable("PR2", "a prose value carried a bare host");
  }
  return {
    content_type: "text/plain",
    value: collapsed.length > PROSE_MAX_LENGTH ? collapsed.slice(0, PROSE_MAX_LENGTH) : collapsed,
  };
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
