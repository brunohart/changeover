/**
 * The header contract of SPEC.md §6.3, as arithmetic rather than as prose.
 *
 * Requests:  `Authorization: Bearer` · `Idempotency-Key` · `Changeover-Version`
 *            · optional `Changeover-Occasion-ETag` · `If-Match` (one route only)
 * Responses: `Changeover-Server-Time` · `Idempotency-Replayed` · `Retry-After`
 *            · `ETag` · `Cache-Control`
 *
 * Two numbers exist twice and the specification fixes which one is normative, so
 * that the two bindings cannot disagree with themselves. Both live here, as
 * functions, because a rule implemented at four call sites is four rules.
 */

import type { DurationMs, Rfc3339 } from "@changeover/schema/refusal.ts";

/* ── Header names ──────────────────────────────────────────────────────────── */

export const HEADER = {
  authorization: "authorization",
  idempotency_key: "idempotency-key",
  changeover_version: "changeover-version",
  changeover_occasion_etag: "changeover-occasion-etag",
  if_match: "if-match",
  content_type: "content-type",

  server_time: "Changeover-Server-Time",
  idempotency_replayed: "Idempotency-Replayed",
  retry_after: "Retry-After",
  etag: "ETag",
  cache_control: "Cache-Control",
  allow: "Allow",
  location: "Location",
} as const;

/** The version this binding speaks. V1: a request declaring another is refused. */
export const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(["0.1"]);

/* ── Retry-After ───────────────────────────────────────────────────────────── */

/**
 * `Retry-After` **MUST** be `ceil(retry_after_ms / 1000)` wherever both appear,
 * and `retry_after_ms` is the normative one.
 *
 * `Retry-After` is delta-seconds (RFC 9110 §10.2.3) and exists for
 * intermediaries, which is why it survives at all: it is the only one a proxy
 * reads. Without the rule a 400 ms backoff becomes `Retry-After: 0` under
 * truncation — a hammer, and an intermediary that honours it retries instantly
 * — or `Retry-After: 1` under one implementation and `2` under another that
 * rounded a 1400 ms wait up twice. Ceiling, once, here.
 */
export function retryAfterSeconds(retry_after_ms: DurationMs): number {
  if (!Number.isFinite(retry_after_ms) || retry_after_ms < 0) {
    throw new RangeError("retry_after_ms must be a non-negative number of milliseconds");
  }
  return Math.ceil(retry_after_ms / 1000);
}

/* ── Cache-Control on an Occasion ──────────────────────────────────────────── */

/** The ceiling §6.3 puts on an Occasion's cache life, in seconds. */
export const OCCASION_MAX_AGE_CEILING_S = 30;

/**
 * `Cache-Control` on an Occasion **MUST** be `max-age = min(max_staleness_ms/1000, 30)`.
 *
 * The division **floors**. `max-age` is delta-seconds and must be an integer, so
 * a 1500 ms staleness budget is either 1 or 2 and only one of those is honest:
 * caching for 2 s a document the publisher says is stale after 1.5 s would serve
 * a document the publisher has already disowned. Floor is the direction that
 * cannot over-promise, and 30 is the hard ceiling regardless.
 */
export function occasionMaxAgeSeconds(max_staleness_ms: DurationMs): number {
  if (!Number.isFinite(max_staleness_ms) || max_staleness_ms < 0) {
    throw new RangeError("max_staleness_ms must be a non-negative number of milliseconds");
  }
  return Math.min(Math.floor(max_staleness_ms / 1000), OCCASION_MAX_AGE_CEILING_S);
}

export function maxAge(seconds: number): string {
  return `max-age=${Math.max(0, Math.floor(seconds))}`;
}

/* ── ETag ──────────────────────────────────────────────────────────────────── */

/** The wire form: `1:` and 43 base64url characters. Unquoted, everywhere but a header. */
export const WIRE_ETAG_PATTERN = /^1:[A-Za-z0-9_-]{43}$/;

/**
 * `ETag` and `If-Match` carry the wire etag as a **quoted strong entity-tag**,
 * and a Server MUST strip quotes before comparing.
 *
 * The two forms are not cosmetic variants. `1:abc` in a body and `"1:abc"` in a
 * header are the same value in two grammars, and an implementation that compared
 * them without stripping would refuse every conditional request it ever received
 * — while passing every test written by the same author, who would quote both
 * sides or neither.
 */
export function quoteEtag(wire: string): string {
  return `"${wire}"`;
}

/**
 * The unquoted wire form of a header value, or `null` where the header cannot
 * take part in a strong comparison.
 *
 * A weak tag (`W/"…"`) returns `null` rather than its inner value: RFC 9110
 * §13.1.1 requires `If-Match` to use the **strong** comparison function, under
 * which a weak validator never matches. Returning the inner value would let a
 * weak tag satisfy a precondition the RFC says it cannot.
 */
export function unquoteEtag(header: string): string | null {
  const value = header.trim();
  if (value.startsWith("W/")) return null;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  // An unquoted value is not a valid entity-tag. Accepting it would make this
  // Server the only one on which a non-conforming client's conditional works.
  return null;
}

/** `If-Match: *` matches any current representation (RFC 9110 §13.1.1). */
export function ifMatchIsWildcard(header: string): boolean {
  return header.trim() === "*";
}

/**
 * Strong comparison of an `If-Match` list against the current wire etag.
 * A list is `"a", "b"` and matches when any member matches.
 */
export function ifMatchMatches(header: string, current: string): boolean {
  if (ifMatchIsWildcard(header)) return true;
  for (const candidate of header.split(",")) {
    if (unquoteEtag(candidate) === current) return true;
  }
  return false;
}

/* ── Time ──────────────────────────────────────────────────────────────────── */

/**
 * A last-resort RFC 3339 instant from the process clock.
 *
 * K4 says the time source is the database, and every response that can reach it
 * uses it. This exists for the one response that cannot: a `503
 * upstream_unavailable` rendered *because* the store did not answer still owes
 * the caller a `Changeover-Server-Time`, and refusing to emit one would turn a
 * degraded read into a malformed response.
 */
export function processTimeRfc3339(): Rfc3339 {
  return new Date().toISOString().replace("Z", "+00:00");
}

/** The `server_time` a body already carries, so header and body cannot disagree. */
export function serverTimeOf(body: unknown): Rfc3339 | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>).server_time;
  return typeof value === "string" ? value : null;
}
