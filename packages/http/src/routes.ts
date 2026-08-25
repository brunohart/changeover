/**
 * The nine routes, as DATA.
 *
 * SPEC.md §6.3 tables them and this is that table, not a cascade of `if`s that
 * happens to agree with it. `scripts/prove_http_binding.sh` reads {@link ROUTES}
 * and asserts nine and exactly nine — a tenth route added by hand would be a
 * surface the specification does not describe, and the only way to notice one in
 * a router written as control flow is to read all of it.
 *
 * Three columns carry rules rather than routing:
 *
 *  - `if_match` — RFC 9110 §13.1.1 evaluates `If-Match` against the **target**
 *    resource. It is `true` on exactly one route, `GET /occasions/{id}`, where
 *    the target IS the Occasion. On `POST /holds` the target is the hold
 *    *collection* and the Occasion is named in the body, so a correct
 *    intermediary would evaluate the condition against the wrong entity. The
 *    header is therefore refused there, not honoured.
 *  - `hold_verb` — Profile 0 is "a static JSON file … no hold verbs" (§6.3), so
 *    every route marked here answers `501 profile_not_supported` at Profile 0.
 *  - `surface` — `revoke` is an **operator** route. It is not an agent verb, it
 *    is not one of the five, and a credential without the operator surface gets
 *    `403 not_authorised`.
 */

export const SURFACE = {
  /** No credential required: the bootstrap documents. */
  public: "public",
  /** An agent credential issued for this site. */
  agent: "agent",
  /** The exhibitor's own operator credential. Not an agent surface. */
  operator: "operator",
} as const;

export type Surface = (typeof SURFACE)[keyof typeof SURFACE];

export type Method = "GET" | "POST" | "DELETE";

export interface Route {
  readonly name: string;
  readonly method: Method;
  /** Path template. `{name}` is one path segment, bound as a parameter. */
  readonly pattern: string;
  readonly surface: Surface;
  /** Whether `If-Match` names this route's own target resource (RFC 9110 §13.1.1). */
  readonly if_match: boolean;
  /** Whether Profile 0 answers `501 profile_not_supported` here. */
  readonly hold_verb: boolean;
  /** The verb name §6.3 maps this route onto, or null where it is not one of the five. */
  readonly verb: string | null;
}

export const ROUTES: readonly Route[] = Object.freeze([
  {
    name: "capability",
    method: "GET",
    pattern: "/.well-known/changeover",
    surface: SURFACE.public,
    if_match: false,
    hold_verb: false,
    verb: null,
  },
  {
    name: "delegation",
    method: "GET",
    pattern: "/.well-known/changeover/delegation.json",
    surface: SURFACE.public,
    if_match: false,
    hold_verb: false,
    verb: null,
  },
  {
    name: "resolve_occasions",
    method: "GET",
    pattern: "/changeover/v0/occasions",
    surface: SURFACE.agent,
    if_match: false,
    hold_verb: false,
    verb: "resolve_occasions",
  },
  {
    name: "get_occasion",
    method: "GET",
    pattern: "/changeover/v0/occasions/{occasion_id}",
    surface: SURFACE.agent,
    // The one route where the target resource IS the Occasion.
    if_match: true,
    hold_verb: false,
    verb: "resolve_occasions",
  },
  {
    name: "hold_seats",
    method: "POST",
    pattern: "/changeover/v0/holds",
    surface: SURFACE.agent,
    // Removed. The target is the collection; the Occasion is in the body.
    if_match: false,
    hold_verb: true,
    verb: "hold_seats",
  },
  {
    name: "get_hold",
    method: "GET",
    pattern: "/changeover/v0/holds/{hold_id}",
    surface: SURFACE.agent,
    if_match: false,
    hold_verb: true,
    verb: "get_hold",
  },
  {
    name: "release_hold",
    method: "DELETE",
    pattern: "/changeover/v0/holds/{hold_id}",
    surface: SURFACE.agent,
    if_match: false,
    hold_verb: true,
    verb: "release_hold",
  },
  {
    name: "hand_off",
    method: "POST",
    pattern: "/changeover/v0/holds/{hold_id}/hand-off",
    surface: SURFACE.agent,
    if_match: false,
    hold_verb: true,
    verb: "hand_off",
  },
  {
    name: "revoke",
    method: "POST",
    pattern: "/changeover/v0/holds/{hold_id}/revoke",
    surface: SURFACE.operator,
    if_match: false,
    // A hold verb in the sense Profile 0 means: there are no Holds to revoke.
    hold_verb: true,
    verb: null,
  },
] as const);

/** Every route name, for a caller that wants to switch exhaustively. */
export const ROUTE_NAMES: readonly string[] = Object.freeze(ROUTES.map((r) => r.name));

export function routeNamed(name: string): Route | undefined {
  return ROUTES.find((r) => r.name === name);
}

/* ── Matching ──────────────────────────────────────────────────────────────── */

export interface RouteMatch {
  readonly route: Route;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * What the router concluded about a path, before any credential is read.
 *
 * `method_not_allowed` is distinct from `no_route` because the two are different
 * HTTP facts and neither is a CHANGEOVER refusal: the refusal taxonomy is closed
 * over the five verbs and the claim, and "this Server has no such path" is not
 * among them. See `problem.ts` — those two render with `about:blank`.
 */
export type RouteLookup =
  | { readonly outcome: "matched"; readonly match: RouteMatch }
  | { readonly outcome: "method_not_allowed"; readonly allow: readonly Method[] }
  | { readonly outcome: "no_route" };

function segments(path: string): string[] {
  // A leading "/" produces a leading "", which is dropped; a trailing "/" is not
  // significant. Empty interior segments are preserved so that "//holds" cannot
  // match "/holds".
  const parts = path.split("/");
  parts.shift();
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function matchOne(route: Route, parts: readonly string[]): Record<string, string> | null {
  const template = segments(route.pattern);
  if (template.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < template.length; i++) {
    const t = template[i] as string;
    const p = parts[i] as string;
    if (t.length > 2 && t.startsWith("{") && t.endsWith("}")) {
      if (p.length === 0) return null;
      // `decodeURIComponent` throws URIError on a truncated escape — `%E0%A4%A`
      // — and until 2026-08-26 that URIError propagated out of `lookup()` into
      // the handler's catch-all and was rendered `503 upstream_unavailable`
      // with `Retry-After: 5`. Three things followed from that, all reachable
      // with no credential at all, because routing runs before `authorise()`
      // and before the rate limiter: the Server published a false statement
      // about the exhibitor's upstream; a conforming Agent, which is REQUIRED
      // to act on `remediation`, retried a permanently malformed request every
      // five seconds forever; and an unauthenticated caller drove unbounded
      // stderr logging. A segment that is not a valid percent-encoding names no
      // resource, and `404` is the truthful answer.
      let decoded: string;
      try {
        decoded = decodeURIComponent(p);
      } catch {
        return null;
      }
      params[t.slice(1, -1)] = decoded;
      continue;
    }
    if (t !== p) return null;
  }
  return params;
}

/**
 * Resolve a path and method against the table.
 *
 * Path first, method second, so that a known path with the wrong method is a
 * `405` naming what it does allow rather than a `404` denying it exists — the
 * two are different facts and collapsing them makes a typo indistinguishable
 * from an unimplemented surface.
 */
export function lookup(method: string, path: string): RouteLookup {
  const parts = segments(path);
  const onPath: Route[] = [];
  for (const route of ROUTES) {
    if (matchOne(route, parts) !== null) onPath.push(route);
  }
  if (onPath.length === 0) return { outcome: "no_route" };

  for (const route of onPath) {
    if (route.method === method) {
      const params = matchOne(route, parts) as Record<string, string>;
      return { outcome: "matched", match: { route, params: Object.freeze(params) } };
    }
  }
  return { outcome: "method_not_allowed", allow: Object.freeze(onPath.map((r) => r.method)) };
}
