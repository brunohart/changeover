/**
 * RFC 9457 `application/problem+json`, with `type` as a **URN**.
 *
 * `urn:changeover:refusal:seat_contended`. RFC 9457 §3.1.1 permits any URI and
 * recommends a resolvable one; a URL would imply a domain that must resolve, and
 * this project's domain is unverified. A dangling `https://` type would be
 * copied into every error an implementer ever logged and would rot there. A URN
 * makes the identity of the problem type exact and promises nothing about
 * fetching it. It is also already the shape every other identifier in this
 * specification uses — `urn:changeover:schema:refusal:0.1`.
 *
 * ### The body composition, decided
 *
 * `schemas/refusal.schema.json` is `additionalProperties: false`, so a body that
 * carries RFC 9457 members alongside the refusal members does not validate
 * against the refusal schema as-is. `docs/BUILD-CONTRACT.md` §6 asked BIND-001
 * to decide this and its default ruling stands, because SPEC.md §6.3 does not
 * decide it otherwise: **the HTTP body is the refusal document plus exactly
 * three RFC 9457 members — `type`, `status`, `title` — and C-REFUSE validates
 * the document obtained by removing exactly those three.** The MCP binding
 * carries the refusal document unmodified.
 *
 * **RFC 9457's `detail` member is deliberately NOT among them.** That name is
 * already taken, by a *machine-readable* closed `oneOf` branch keyed on the
 * code. Adding RFC 9457's human-readable string `detail` would either collide
 * with it or force a rename of a member the schema freezes. Three members, not
 * four, is exactly why the ruling says three.
 *
 * `title` is the code itself. RFC 9457 asks for a short human-readable summary
 * that identifies the *type* and does not vary between occurrences; the code is
 * exactly that string and it is already closed and already documented. Writing a
 * second sentence there would open a **second** prose channel to a consumer with
 * no judgement, next to `reason`, which SPEC.md §5.3 exists to prevent. One
 * prose channel, and nothing reads it.
 */

import type { RefusalCode, RefusalDocument, Rfc3339 } from "@changeover/schema/refusal.ts";
import { REFUSAL_STATUS, isRefusalCode } from "@changeover/schema/refusal.ts";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** The URN namespace every refusal type is minted in. */
export const REFUSAL_URN_PREFIX = "urn:changeover:refusal:";

/**
 * RFC 9457 §4.2.1: `about:blank` means "no problem semantics beyond the status
 * code". It is what a `404` on a path this Server does not serve gets, because
 * the refusal taxonomy is **closed** and "no such route" is not a member of it.
 * Inventing a thirty-third code to describe a routing fact would be the exact
 * thing the closed set exists to forbid.
 */
export const ABOUT_BLANK = "about:blank";

export function refusalUrn(code: RefusalCode): string {
  return REFUSAL_URN_PREFIX + code;
}

/** The inverse, for a consumer or a proof reading a type back off the wire. */
export function codeOfUrn(type: string): RefusalCode | null {
  if (!type.startsWith(REFUSAL_URN_PREFIX)) return null;
  const code = type.slice(REFUSAL_URN_PREFIX.length);
  return isRefusalCode(code) ? code : null;
}

/**
 * The three RFC 9457 members this binding adds, and the whole of what C-REFUSE
 * removes before validating against `refusal.schema.json`.
 */
export const RFC9457_MEMBERS: readonly string[] = Object.freeze(["type", "status", "title"]);

export interface ProblemDocument extends RefusalDocument {
  readonly type: string;
  readonly status: number;
  readonly title: string;
}

/**
 * Render a refusal document as a problem document.
 *
 * `status` is read from `REFUSAL_STATUS`, never passed in: §6.3 fixes one status
 * per code and a binding that accepted a status argument would be a place two
 * call sites could disagree about what a `seat_contended` is.
 */
export function problemOf(document: RefusalDocument): ProblemDocument {
  // The spread comes FIRST and the three members last, so that the three are
  // authoritative rather than defaults a body member could shadow. The refusal
  // schema is `additionalProperties: false` and cannot carry them today; a
  // rendering that depended on that staying true would be one member away from
  // emitting a `status` some other layer chose.
  return {
    ...document,
    type: refusalUrn(document.code),
    status: REFUSAL_STATUS[document.code],
    title: document.code,
  };
}

/**
 * A problem document for an HTTP fact that is not a CHANGEOVER refusal.
 *
 * It carries **no `code`**, and that absence is the contract: a consumer
 * switching on `code` sees nothing to switch on, which is true, rather than a
 * code that means something else.
 */
export interface BlankProblem {
  readonly type: typeof ABOUT_BLANK;
  readonly status: number;
  readonly title: string;
  readonly changeover: "0.1";
  readonly server_time: Rfc3339;
}

export function blankProblem(status: number, title: string, server_time: Rfc3339): BlankProblem {
  return { type: ABOUT_BLANK, status, title, changeover: "0.1", server_time };
}

/** Strip the three added members, which is what a refusal-schema check does first. */
export function refusalDocumentOf(problem: ProblemDocument): RefusalDocument {
  const copy = { ...problem } as Record<string, unknown>;
  for (const member of RFC9457_MEMBERS) delete copy[member];
  return copy as unknown as RefusalDocument;
}
