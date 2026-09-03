/**
 * C-INJECT.1 — every URL in every emitted document is same-origin.
 *
 * Owner: TEST-005.
 *
 * > **O1.** Every absolute URL emitted in any CHANGEOVER document — `book_url`,
 * > `seat_map_ref`, `claim_url` — MUST be same-origin with `venue.origin` or
 * > with an origin in that venue's delegation record, compared as the parsed
 * > `(scheme, host, port)` triple, ASCII-lowercased, default ports normalised.
 * > A URL containing userinfo is invalid regardless of host.
 *
 * The comparison is **not written here.** `originOf` and `sameOrigin` come from
 * `@changeover/core/claim.ts`, which CORE-004 wrote; this module walks
 * documents and asks that implementation. A conformance class that carries its
 * own copy of the rule it is checking is checking itself.
 *
 * Delegation is why this is not a one-line check. `book_url` in the golden
 * fixtures is `https://tickets.embassy.example/...` and `venue.origin` is
 * `https://embassy.example` — different hosts, and legal, because the venue's
 * own apex delegation record names the ticketing host. A rule written to
 * exclude aggregators that instead excludes the exhibitor's own ticketing
 * vendor is a rule nobody deploys (SPEC.md §3.3), so the audit resolves against
 * the delegation record rather than against `venue.origin` alone.
 */

import { originOf, sameOrigin } from "@changeover/core/claim.ts";

import type { StringHit } from "./poison.ts";
import { nonProseStrings, proseHits } from "./poison.ts";

/** Anything a consumer could read as a destination, whether or not it parses. */
const SCHEME_SHAPED = /[a-z][a-z0-9+.-]*:\/\//i;

/** The set of origins a venue has authorised: its own, plus whatever its apex delegated. */
export interface OriginAuthority {
  readonly venue_origin: string;
  readonly delegated: readonly string[];
}

/** Build the authority from a venue origin and the apex delegation record. */
export function authorityFrom(venue_origin: string, delegation: unknown): OriginAuthority {
  const record = delegation as { authorised_origins?: unknown } | null;
  const listed = Array.isArray(record?.authorised_origins) ? record.authorised_origins : [];
  return {
    venue_origin,
    delegated: listed.filter((o): o is string => typeof o === "string"),
  };
}

/**
 * O1, decided for one URL.
 *
 * `originOf` returns `null` for userinfo, for a non-http(s) scheme and for
 * anything that does not parse — so an unparseable string is refused rather
 * than skipped, which is the direction a safety rule has to fail in.
 */
export function permittedByO1(url: string, authority: OriginAuthority): boolean {
  if (originOf(url) === null) return false;
  if (sameOrigin(url, authority.venue_origin)) return true;
  return authority.delegated.some((origin) => sameOrigin(url, origin));
}

export interface UrlFinding {
  readonly pointer: string;
  readonly url: string;
  /** `member` — a URL in a document member. `prose` — a URL inside a prose envelope (PR2). */
  readonly where: "member" | "prose";
}

/**
 * Every absolute URL a document emits, split by whether it is a member an Agent
 * may act on or a link buried in prose an Agent must not touch.
 */
export function urlsIn(document: unknown): UrlFinding[] {
  const found: UrlFinding[] = [];
  for (const hit of nonProseStrings(document) as StringHit[]) {
    if (!SCHEME_SHAPED.test(hit.value)) continue;
    found.push({ pointer: hit.pointer, url: hit.value, where: "member" });
  }
  for (const hit of proseHits(document)) {
    const match = hit.value.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/i);
    if (match === null) continue;
    found.push({ pointer: hit.pointer, url: match[0], where: "prose" });
  }
  return found;
}

export interface OriginAudit {
  readonly checked: number;
  readonly members: number;
  /** URL members that O1 does not permit. Non-empty is a failure. */
  readonly offOrigin: readonly UrlFinding[];
  /** Navigable links found inside prose envelopes. PR2 forbids publishing these. */
  readonly proseLinks: readonly UrlFinding[];
}

/** Run O1 over a set of emitted documents. */
export function auditOrigins(documents: readonly unknown[], authority: OriginAuthority): OriginAudit {
  const offOrigin: UrlFinding[] = [];
  const proseLinks: UrlFinding[] = [];
  let checked = 0;
  let members = 0;
  for (const document of documents) {
    for (const finding of urlsIn(document)) {
      checked++;
      if (finding.where === "prose") {
        proseLinks.push(finding);
        continue;
      }
      members++;
      if (!permittedByO1(finding.url, authority)) offOrigin.push(finding);
    }
  }
  return { checked, members, offOrigin, proseLinks };
}
