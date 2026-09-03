/**
 * Bearer credentials, and the rule that scope is **refilled, never merged**.
 *
 * > `agent_id`, `principal_scope`, site scope and permitted profile derive **from
 * > the credential**; `agent_id` is server-assigned at issue and never echoed
 * > from the caller. Any scope-bearing field in a request body **MUST** be
 * > deleted from caller input and refilled from the token, never merged.
 * > — SPEC.md §6.3
 *
 * **Merging is the failure mode, and it is subtle.** A merge — `{...body,
 * ...credential}` — looks safe: the credential wins every collision. It is not
 * safe, because it means a caller who supplies the field is *participating in
 * deciding its own authority*, and the only thing standing between that caller
 * and a widened scope is the spread order in one expression. Reverse it in a
 * refactor and nothing fails: every test still passes, because every test sends
 * a body whose scope agrees with its token. Deleting first makes the caller's
 * value **unreachable** rather than **outranked**.
 *
 * So {@link stripScopeBearing} deletes, and returns what it deleted, and the
 * verb's scope comes from a separate argument that never touched the body.
 */

import type { Credential } from "@changeover/core/hold-seats.ts";
import { AGENT_ID_PATTERN } from "@changeover/core/principal.ts";

import { SURFACE } from "./routes.ts";
import type { Surface } from "./routes.ts";

/* ── What a token resolves to ──────────────────────────────────────────────── */

export type Profile = "0" | "1" | "1S";

/**
 * The credential, in full. Every member is assigned at issue by the exhibitor
 * and none of them is readable from a request body.
 */
export interface SiteCredential {
  /** Z2/I2. Server-assigned at issue. Never echoed from the caller. */
  readonly agent_id: string;
  /** X0. The principal this credential acts for. Absence is `403`. */
  readonly principal_scope: string;
  /** The site this token was issued for. A token is a per-site credential. */
  readonly site_id: string;
  /** Which surfaces this credential may reach. `revoke` needs the operator one. */
  readonly surfaces: readonly Surface[];
  /** The permitted profile, where the credential caps it below the site's. */
  readonly profile?: Profile;
}

/**
 * Token → credential. An interface rather than a Map so that a deployment can
 * put a real issuer behind it — the reference one is in-memory and that is a
 * property of the reference deployment, not of the binding.
 */
export interface TokenDirectory {
  lookup(token: string): SiteCredential | null;
}

/** The reference directory: a frozen table, looked up in constant time. */
export function tokenDirectory(tokens: Readonly<Record<string, SiteCredential>>): TokenDirectory {
  const table = new Map<string, SiteCredential>(Object.entries(tokens));
  return {
    lookup(token: string): SiteCredential | null {
      return table.get(token) ?? null;
    },
  };
}

/* ── Parsing Authorization ─────────────────────────────────────────────────── */

export type BearerOutcome =
  | { readonly present: true; readonly token: string }
  | { readonly present: false };

/**
 * `Authorization: Bearer <token>`, RFC 6750 §2.1. The scheme is compared
 * case-insensitively because RFC 9110 §11.1 says auth-scheme is; the token is
 * not touched.
 */
export function bearerToken(header: string | undefined): BearerOutcome {
  if (typeof header !== "string") return { present: false };
  const space = header.indexOf(" ");
  if (space < 0) return { present: false };
  if (header.slice(0, space).toLowerCase() !== "bearer") return { present: false };
  const token = header.slice(space + 1).trim();
  if (token.length === 0) return { present: false };
  return { present: true, token };
}

/* ── The scope-bearing members ─────────────────────────────────────────────── */

/**
 * Every member a body could carry that names authority rather than intent.
 *
 * The list is deliberately wider than the two members the verbs actually read.
 * `site`, `site_id` and `profile` are not arguments to any of the five verbs —
 * which is exactly why a body carrying one must be treated as an attempt rather
 * than as a harmless extra: the only reason to send `"profile": "1"` to a
 * Profile 0 Server is to see whether it merges.
 */
export const SCOPE_BEARING_MEMBERS: readonly string[] = Object.freeze([
  "agent_id",
  "principal_scope",
  "site",
  "site_id",
  "profile",
  "surfaces",
]);

export interface StripResult {
  /** The body with every scope-bearing member removed. A new object; the input is untouched. */
  readonly body: Record<string, unknown>;
  /** What was removed, in the order {@link SCOPE_BEARING_MEMBERS} declares. */
  readonly ignored: readonly string[];
}

/**
 * Delete every scope-bearing member from a request body.
 *
 * Returns the removed names so the binding can *say* it ignored them — silently
 * dropping a member a caller believed was load-bearing is the other half of V3's
 * complaint about tolerance, and a conformance harness needs to observe the
 * deletion rather than infer it from an outcome that would also hold if the
 * member had been merged and happened to agree.
 */
export function stripScopeBearing(body: unknown): StripResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { body: {}, ignored: Object.freeze([]) };
  }
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  const ignored: string[] = [];
  for (const member of SCOPE_BEARING_MEMBERS) {
    if (Object.hasOwn(copy, member)) {
      ignored.push(member);
      delete copy[member];
    }
  }
  return { body: copy, ignored: Object.freeze(ignored) };
}

/**
 * The verb's `Credential`, built from the token and from nothing else.
 *
 * There is no body argument. That is not an omission — it is the enforcement:
 * this function *cannot* read a body, so no future edit can make it merge one.
 */
export function credentialOf(site: SiteCredential): Credential {
  return { agent_id: site.agent_id, principal_scope: site.principal_scope };
}

/** Whether this credential may reach a route on that surface. */
export function permits(site: SiteCredential, surface: Surface): boolean {
  if (surface === SURFACE.public) return true;
  return site.surfaces.includes(surface);
}

/** A credential is well-formed when its two scope members are (X0, Z2). */
export function credentialIsWellFormed(site: SiteCredential): boolean {
  return typeof site.principal_scope === "string" && site.principal_scope.length > 0 &&
    typeof site.agent_id === "string" && AGENT_ID_PATTERN.test(site.agent_id);
}
