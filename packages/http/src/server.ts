/**
 * The HTTP binding: nine routes on `node:http`, no framework.
 *
 * Nine routes do not need a router library, and taking one would put a
 * third-party path-matching grammar between the specification's route table and
 * the code that serves it. `routes.ts` IS the table; this file walks it.
 *
 * ### The order guards run in, and why it is this order
 *
 *  1. **Route.** Path first, method second, so a typo is a `405` naming what the
 *     path does allow rather than a `404` denying it exists.
 *  2. **Version (V1).** A request declaring a version this Server does not
 *     support is refused before anything reads its members, because the members'
 *     *meaning* is what the version fixes.
 *  3. **Credential.** Authentication, then surface. `revoke` is an operator
 *     route and an agent credential does not reach it.
 *  4. **Profile.** A hold verb at Profile 0 is `501 profile_not_supported` — G1
 *     step 1, and the binding applies it to all five `/holds` routes because at
 *     Profile 0 there are no Holds for any of them to address.
 *  5. **Rate limit.** Transport-level, which is what §6.3 calls `rate_limited`.
 *  6. **`If-Match`.** Refused on every route whose target it does not name.
 *  7. **The verb.**
 *
 * Everything above the verb is decided before a body is parsed. A refusal that
 * had already read a body would be answering a question it should not have
 * asked.
 *
 * ### What this binding deliberately does not do
 *
 * **The access log (§5.4, A1–A4) is not wired here.** `@changeover/core`'s
 * `access-log.ts` needs a `SiteEpoch` whose key is derived from
 * `CHANGEOVER_HMAC_KEY`, and `packages/core/src/hmac.ts` — the module that is
 * supposed to make that key the same one `idempotency.ts` hashes under — has not
 * been written. Half-wiring it would produce log rows that cannot be correlated
 * to the idempotency records they belong to, and crypto-shredding an epoch would
 * then shred the log and leave the digests hashed under a key nothing names.
 * {@link ServerOptions.access_log} is the seam; the default is off and says so.
 *
 * **The human gate (§6.2, SEP-2322) is an MCP mechanism.** This binding
 * publishes `gate_stage` and enforces nothing at the hold stage.
 */

import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { Db } from "@changeover/store/db.ts";
import type { DurationMs, RefusalCode, Rfc3339 } from "@changeover/schema/refusal.ts";
import {
  REFUSAL_STATUS,
  REVOCATION_REASONS,
  isRefusal,
  refuse,
} from "@changeover/schema/refusal.ts";
import { HOLD_POLICY_PUBLISHED, principalBudgets } from "@changeover/core/budgets.ts";
import type { HoldPolicyDocument } from "@changeover/core/budgets.ts";
import { serverTime } from "@changeover/core/clock.ts";
import { writeAccessLog } from "@changeover/core/access-log.ts";
import type { Invocation, SecondarySink, SiteEpoch } from "@changeover/core/access-log.ts";
import type { AccessLogVerb } from "@changeover/store/schema.ts";
import { HOLD_COLUMNS, HOLD_STATE, deriveState } from "@changeover/core/derived.ts";
import type { HoldRow, HoldState } from "@changeover/core/derived.ts";
import { assertHoldSeatsShape, holdSeats } from "@changeover/core/hold-seats.ts";
import type { Credential, HoldSeatsOptions, HoldSeatsRequest } from "@changeover/core/hold-seats.ts";
import { getHold } from "@changeover/core/get-hold.ts";
import type { GetHoldOptions } from "@changeover/core/get-hold.ts";
import { releaseHold } from "@changeover/core/release.ts";
import { handOff } from "@changeover/core/hand-off.ts";
import type { HandOffOptions } from "@changeover/core/hand-off.ts";
import {
  KEY_REQUIRED_VERBS,
  assertKeyShape,
  handOffDigest,
  holdSeatsDigest,
  releaseHoldDigest,
  withIdempotency,
} from "@changeover/core/idempotency.ts";
import type { IdempotentVerb } from "@changeover/core/idempotency.ts";

import { capabilityDocument, delegationRecord, maxPageSize, maxWindowMs, maxDocumentAgeMs } from "./capability.ts";
import type { SiteConfig } from "./capability.ts";
import {
  bearerToken,
  credentialIsWellFormed,
  credentialOf,
  permits,
  stripScopeBearing,
} from "./credential.ts";
import type { Profile, SiteCredential, TokenDirectory } from "./credential.ts";
import {
  HEADER,
  SUPPORTED_VERSIONS,
  ifMatchMatches,
  maxAge,
  occasionMaxAgeSeconds,
  processTimeRfc3339,
  quoteEtag,
  retryAfterSeconds,
  serverTimeOf,
} from "./headers.ts";
import {
  STORE_OCCASIONS,
  WHOLE_DOCUMENT_CHANGED,
  decodeCursor,
  encodeCursor,
  fitToProseBudget,
  maxStalenessMs,
} from "./occasions.ts";
import type { ChangedPathsSource, OccasionSource } from "./occasions.ts";
import { PROBLEM_CONTENT_TYPE, blankProblem, problemOf } from "./problem.ts";
import { SURFACE, lookup } from "./routes.ts";
import type { Route } from "./routes.ts";

/* -- Options ---------------------------------------------------------------- */

/**
 * Transport-level throttling. §6.3's `rate_limited` is explicitly transport, so
 * it belongs to a binding and not to a verb — and it is a seam rather than an
 * implementation because a real deployment throttles at its edge, not in Node.
 */
export interface RateLimiter {
  /** `retry_after_ms` when this caller must wait, or `null` to let it through. */
  check(key: string, route: Route): DurationMs | null;
}

export const NO_RATE_LIMIT: RateLimiter = {
  check() {
    return null;
  },
};

/**
 * The §5.4 access log, as this binding writes it.
 *
 * The previous shape — `record({ route, outcome, code? }): void` — could not
 * satisfy §5.4 no matter what an operator plugged into it. It returned `void`,
 * so a caller could not await it and could not act on a failed log write; it
 * carried no `agent_id` and no `principal_scope`, both `NOT NULL` on
 * `changeover_log.access_log`; it carried no local wall clock, which A3
 * partitions on; and it was invoked at exactly one site — the internal-fault
 * catch — so even a fully wired implementation would have seen faults and never
 * an `ok` or a `refused`, which is the direction §5.4 cares about most: *"a log
 * with only successes cannot show someone probing the boundary"*.
 *
 * It is now {@link Invocation} — CORE-007's own type, not a second shape — plus
 * the outcome, and it is awaited on all three terminal paths of {@link handle}.
 * {@link storeAccessLog} wires it to `writeAccessLog`.
 */
export interface AccessLog {
  record(entry: Invocation, observed_at: Rfc3339): Promise<void>;
}

/**
 * No log. The default, and it is what makes the capability document omit
 * `log_retention_days`: a Server that publishes a retention period tells an
 * auditor a log exists, and this one does not.
 */
export const NO_ACCESS_LOG: AccessLog = {
  async record() {
    /* Nothing, loudly: `capability.ts` omits `log_retention_days` for this. */
  },
};

export interface StoreAccessLogOptions {
  /** IANA zone for the site whose wall clock partitions the row (A3). */
  readonly timezone: string;
  /** P2. Construct `key` from `CHANGEOVER_HMAC_KEY` — see BUILD-CONTRACT §2. */
  readonly epoch: SiteEpoch;
  /** A2's durable secondary for READ verbs. Absent means reads fail closed too. */
  readonly secondary?: SecondarySink;
}

/**
 * Wire the seam to CORE-007's writer.
 *
 * **A1 is not satisfied by this factory and saying so is the point.** A1
 * requires the log to sit on storage independent of the hold store, and a
 * deployment that passes its hold `Db` here has one store, not two. What this
 * gives an operator is the wiring; what it does not give them is the
 * independence, and the honest way to get it is a second `Db`. The signature
 * takes a `Db` rather than reading `options.db` precisely so that passing a
 * different one is the easy thing to do.
 */
export function storeAccessLog(db: Db, options: StoreAccessLogOptions): AccessLog {
  return {
    async record(entry: Invocation, observed_at: Rfc3339): Promise<void> {
      await writeAccessLog(db, entry, observed_at, {
        timezone: options.timezone,
        epoch: options.epoch,
        ...(options.secondary === undefined ? {} : { secondary: options.secondary }),
      });
    },
  };
}

export interface ServerOptions {
  readonly db: Db;
  readonly site: SiteConfig;
  readonly tokens: TokenDirectory;
  readonly occasions?: OccasionSource;
  readonly changed_paths?: ChangedPathsSource;
  readonly rate_limit?: RateLimiter;
  readonly access_log?: AccessLog;
  readonly hold_seats?: HoldSeatsOptions;
  readonly get_hold?: GetHoldOptions;
  readonly hand_off?: HandOffOptions;
  /** Bodies above this are refused. 64 KiB; a hold request is a few hundred bytes. */
  readonly max_body_bytes?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 65536;

/* -- The request and response shapes -------------------------------------- */

export interface HttpRequestLike {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Already read. The empty string where there was none. */
  readonly body: string;
}

export interface HttpResponseLike {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** `undefined` means no body at all, which is what a `204` is. */
  readonly body: unknown;
}

/* -- Header reading --------------------------------------------------------- */

function headerOf(request: HttpRequestLike, name: string): string | undefined {
  const value = request.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

/* -- The one place a response is built ------------------------------------- */

interface Built {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Attach `Changeover-Server-Time` to every response, and take it from the body
 * where the body has one.
 *
 * K4 says the time source is the database and there is one of it. A response
 * whose header said one instant and whose document said another would be two
 * time sources wearing one response, and the mismatch would only ever be visible
 * to whoever compared them — which is to say, to nobody, until a conformance run.
 */
function stamped(built: Built, fallback: Rfc3339): HttpResponseLike {
  const server_time = serverTimeOf(built.body) ?? fallback;
  return {
    status: built.status,
    headers: { ...built.headers, [HEADER.server_time]: server_time },
    body: built.body,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Built {
  return { status, headers: { "Content-Type": "application/json", ...headers }, body };
}

/**
 * Render a refusal as RFC 9457, and set `Retry-After` wherever the refusal
 * carries `retry_after_ms`. The header is derived from the member, always, so
 * the two cannot disagree.
 */
function problemResponse(
  code: RefusalCode,
  document: ReturnType<typeof problemOf>,
  extra: Record<string, string> = {},
): Built {
  const headers: Record<string, string> = { "Content-Type": PROBLEM_CONTENT_TYPE, ...extra };
  if (document.retry_after_ms !== undefined) {
    headers[HEADER.retry_after] = String(retryAfterSeconds(document.retry_after_ms));
  }
  return { status: REFUSAL_STATUS[code], headers, body: document };
}

/* -- The handler ------------------------------------------------------------ */

/**
 * Serve one request. Pure with respect to sockets: `createServer` reads the body
 * and writes the response, and everything a conformance harness wants to assert
 * about the binding is a property of this function's return value.
 */
export async function handle(
  options: ServerOptions,
  request: HttpRequestLike,
): Promise<HttpResponseLike> {
  // **No store round trip before routing, authentication or the rate limiter.**
  //
  // Until 2026-08-26 the first statement here was `await currentTime(options.db)`,
  // which meant an unauthenticated request for a path matching no route spent a
  // pool connection and a round trip before anything had a chance to refuse it:
  // fifty sequential unauthenticated 404s produced fifty queries. §6.3 names
  // transport throttling as the defence and it was consulted three guards too
  // late, so a flood of nonexistent paths could saturate the pool and deny
  // `hold_seats` to real customers without ever presenting a credential.
  //
  // Everything ahead of the verb is stamped from `processTimeRfc3339()`, which
  // this file already accepts as the legitimate stand-in wherever the store
  // cannot answer. K4 binds the instants a Server *asserts about Holds*; a 404
  // asserts nothing about a Hold.
  const url = new URL(request.url, "http://route.invalid");
  const found = lookup(request.method, url.pathname);

  if (found.outcome === "no_route") {
    const at = processTimeRfc3339();
    return stamped(
      { status: 404, headers: { "Content-Type": PROBLEM_CONTENT_TYPE }, body: blankProblem(404, "Not Found", at) },
      at,
    );
  }
  if (found.outcome === "method_not_allowed") {
    const at = processTimeRfc3339();
    return stamped(
      {
        status: 405,
        headers: {
          "Content-Type": PROBLEM_CONTENT_TYPE,
          [HEADER.allow]: [...new Set(found.allow)].join(", "),
        },
        body: blankProblem(405, "Method Not Allowed", at),
      },
      at,
    );
  }

  const { route: matched, params } = found.match;
  let credential: SiteCredential | null = null;
  let now: Rfc3339 = processTimeRfc3339();

  try {
    credential = admit(options, request, matched);
    // Only now is this request going to reach a verb, so only now is the store
    // asked for the clock (K4).
    now = await currentTime(options.db);
    const built = await route(options, request, url, matched, params, credential, now);
    await record(options, matched, credential, now, "ok");
    return stamped(built, now);
  } catch (err) {
    if (isRefusal(err)) {
      // §5.4: refusals are logged deliberately. A log of only successes cannot
      // show someone probing the boundary, which is the thing you most want to
      // see. `credential` is null for a refusal raised by `admit` itself, and
      // the row then carries the anonymous identity rather than no row at all.
      await record(options, matched, credential, now, "refused", err.code);
      return stamped(problemResponse(err.code, problemOf(err.toDocument(now))), now);
    }
    // An internal fault MUST NOT reach the wire with its message: an error
    // string is an uncontrolled prose channel to a consumer with no judgement.
    // The operator gets the stack; the caller gets a status and nothing else.
    logInternal(err);
    await record(options, matched, credential, now, "error").catch(logInternal);
    // NOT `upstream_unavailable`. §6.3 defines that code as "The exhibitor's own
    // system is down. Never a guess." — so rendering an internal fault as one is
    // a false statement about a third party, and the `retry_after` remediation
    // attached to it tells a conforming Agent to retry, forever, on a five-second
    // cadence, a request that may be permanently malformed. The refusal taxonomy
    // is closed and has no internal-error member, which is the correct answer
    // rather than a gap: this is not a refusal. It is RFC 9457 `about:blank`,
    // exactly as the 404 and 405 paths above already are.
    return stamped(
      {
        status: 500,
        headers: { "Content-Type": PROBLEM_CONTENT_TYPE },
        body: blankProblem(500, "Internal Server Error", now),
      },
      now,
    );
  }
}

/**
 * The database is the clock (K4). Where it cannot answer, the process clock
 * stands in — a `503` rendered *because* the store is unreachable still owes the
 * caller a `Changeover-Server-Time`, and emitting none would turn a degraded
 * read into a malformed response.
 */
async function currentTime(db: Db): Promise<Rfc3339> {
  try {
    return await serverTime(db);
  } catch {
    return processTimeRfc3339();
  }
}

function logInternal(err: unknown): void {
  console.error("[changeover:http] internal fault", err);
}

/**
 * The routes §5.4 has a verb for. `capability`, `delegation` and `revoke` are
 * not agent invocations of one of the five verbs, and `ACCESS_LOG_VERBS` has no
 * member for them — so they are not logged rather than being logged under a
 * name the closed enum does not contain.
 */
const LOGGED_VERB: Readonly<Record<string, AccessLogVerb>> = Object.freeze({
  resolve_occasions: "resolve_occasions",
  get_occasion: "resolve_occasions",
  hold_seats: "hold_seats",
  get_hold: "get_hold",
  release_hold: "release_hold",
  hand_off: "hand_off",
});

/**
 * One row per invocation, on every terminal path (§5.4).
 *
 * **What this does NOT do, stated rather than implied.** A2 says fail-closed
 * applies to write verbs — *"hold_seats throws rather than granting unlogged"*.
 * That cannot be honoured from here: by the time an outcome exists the grant has
 * committed, and turning a committed Hold into an error response would strand
 * the seats AND lose the answer. Honouring A2 properly means writing the row
 * inside the verb's own transaction, which A1 forbids in the same breath — the
 * log MUST sit on storage independent of the hold store. The two rules are in
 * tension and this binding resolves it in favour of A1 and of answering the
 * customer. The gap is reported against §5.4 in
 * `docs/2026-08-25-cx-02-core-build.md` rather than papered over.
 *
 * So a failed log write is logged as an internal fault and the response stands.
 * That is a partial implementation of A2 and it is named as one.
 */
async function record(
  options: ServerOptions,
  matched: Route,
  credential: SiteCredential | null,
  observed_at: Rfc3339,
  outcome: "ok" | "refused" | "error",
  refusal_code?: RefusalCode,
): Promise<void> {
  const log = options.access_log;
  if (log === undefined) return;
  const verb = LOGGED_VERB[matched.name];
  if (verb === undefined) return;
  try {
    await log.record(
      {
        verb,
        outcome,
        ...(outcome === "refused" ? { refusal_code: refusal_code ?? null } : {}),
        // A credential that never resolved still produced an invocation. The
        // columns are NOT NULL, and "somebody unauthenticated asked" is exactly
        // the row §5.4 exists to make visible.
        agent_id: credential?.agent_id ?? "anonymous",
        principal_scope: credential?.principal_scope ?? "anonymous",
      },
      observed_at,
    );
  } catch (err) {
    logInternal(err);
  }
}

/**
 * Everything a request must satisfy before it may reach a verb, and therefore
 * before the store is touched at all: the declared version, the credential, the
 * profile, and the rate limit.
 */
function admit(
  options: ServerOptions,
  request: HttpRequestLike,
  matched: Route,
): SiteCredential | null {
  // V1: "A Server MUST reject a request whose declared version is absent from
  // supported_versions." Absent is not a declaration; a wrong one is.
  const declared = headerOf(request, HEADER.changeover_version);
  if (declared !== undefined && !SUPPORTED_VERSIONS.includes(declared.trim())) {
    throw refuse("schema_validation", "This Server does not speak that version of CHANGEOVER.");
  }

  const credential = authorise(options, request, matched);

  // G1 step 1, applied at the binding to every /holds route: Profile 0 is a
  // static file with no hold verbs, so there is no Hold for any of them to
  // address, not merely no way to create one.
  if (matched.hold_verb && effectiveProfile(options.site.profile, credential) === "0") {
    throw refuse("profile_not_supported", "This Server publishes at Profile 0 and holds no seats.");
  }

  const limiter = options.rate_limit ?? NO_RATE_LIMIT;
  const retry_after_ms = limiter.check(credential?.agent_id ?? "anonymous", matched);
  if (retry_after_ms !== null) {
    throw refuse("rate_limited", "Too many requests on this credential.", { retry_after_ms });
  }
  return credential;
}

async function route(
  options: ServerOptions,
  request: HttpRequestLike,
  url: URL,
  matched: Route,
  params: Record<string, string>,
  credential: SiteCredential | null,
  now: Rfc3339,
): Promise<Built> {
  const profile = effectiveProfile(options.site.profile, credential);

  // RFC 9110 §13.1.1 evaluates If-Match against the TARGET resource. It is valid
  // on exactly one route. On POST /holds the target is the hold collection and
  // the Occasion is named in the body, so an intermediary honouring the header
  // would be evaluating the condition against the wrong entity - which is worse
  // than no conditional, because it succeeds.
  const if_match = headerOf(request, HEADER.if_match);
  if (if_match !== undefined && !matched.if_match) {
    throw refuse(
      "schema_validation",
      "If-Match names the target resource, which is not the Occasion this request is about. " +
        "Send occasion_etag in the body.",
    );
  }

  switch (matched.name) {
    case "capability":
      return await serveCapability(options, now);
    case "delegation":
      return serveDelegation(options, now);
    case "resolve_occasions":
      return await serveOccasions(options, url, now);
    case "get_occasion":
      return await serveOccasion(options, params.occasion_id as string, if_match, now);
    case "hold_seats":
      return await serveHoldSeats(options, request, credentialOrThrow(credential), profile);
    case "get_hold":
      return await serveGetHold(options, params.hold_id as string, credentialOrThrow(credential));
    case "release_hold":
      return await serveRelease(options, request, params.hold_id as string, credentialOrThrow(credential));
    case "hand_off":
      return await serveHandOff(options, request, params.hold_id as string, credentialOrThrow(credential));
    case "revoke":
      return await serveRevoke(options, request, params.hold_id as string);
    default:
      // Unreachable while ROUTES and this switch agree, which `prove_http_binding.sh`
      // asserts by walking the table rather than by trusting this line.
      throw new Error(`no handler for route ${matched.name}`);
  }
}

/* -- Credentials ------------------------------------------------------------ */

function authorise(
  options: ServerOptions,
  request: HttpRequestLike,
  matched: Route,
): SiteCredential | null {
  const bearer = bearerToken(headerOf(request, HEADER.authorization));
  const credential = bearer.present ? options.tokens.lookup(bearer.token) : null;

  if (matched.surface === SURFACE.public) return credential;

  if (credential === null) {
    // The closed table has no 401 and there is not going to be one: `not_authorised`
    // is 403 for a credential lacking "the site, profile, or verb", and a token
    // this Server does not know lacks all three.
    throw refuse("not_authorised", "This request carries no credential this Server issued.");
  }
  if (typeof credential.principal_scope !== "string" || credential.principal_scope.length === 0) {
    throw refuse("principal_scope_missing", "This credential carries no principal scope.");
  }
  if (!credentialIsWellFormed(credential)) {
    throw refuse("not_authorised", "This credential carries no agent identity.");
  }
  if (!permits(credential, matched.surface)) {
    throw refuse("not_authorised", "This credential does not reach that surface.");
  }
  return credential;
}

function credentialOrThrow(credential: SiteCredential | null): SiteCredential {
  if (credential === null) throw refuse("not_authorised", "This request carries no credential.");
  return credential;
}

/**
 * The permitted profile derives from the credential, falling back to the site's.
 * A body can never reach this: `profile` is a scope-bearing member and is
 * deleted from every request body before any handler sees one.
 */
function effectiveProfile(site: Profile, credential: SiteCredential | null): Profile {
  return credential?.profile ?? site;
}

/* -- The bootstrap documents ------------------------------------------------ */

async function serveCapability(options: ServerOptions, now: Rfc3339): Promise<Built> {
  const { site } = options;
  let occasions: readonly unknown[] | undefined;
  let seconds = Math.floor(maxDocumentAgeMs(site) / 1000);

  if (site.profile === "0") {
    // Profile 0 IS the static file: the capability document plus the Occasions.
    const source = options.occasions ?? STORE_OCCASIONS;
    const rows = await source.page(options.db, { limit: maxPageSize(site) });
    const documents = rows.map((r) => r.document).filter((d) => d !== null);
    occasions = documents.slice(0, fitToProseBudget(documents));
    // A document that embeds Occasions is no fresher than the freshest Occasion
    // in it. Caching the envelope for longer than its contents would be a way of
    // serving a stale Occasion while obeying the rule about Occasions.
    for (const document of occasions) {
      seconds = Math.min(seconds, occasionMaxAgeSeconds(maxStalenessMs(document) ?? 0));
    }
  }

  return json(200, capabilityDocument(site, now, SUPPORTED_VERSIONS, occasions), {
    [HEADER.cache_control]: maxAge(seconds),
  });
}

function serveDelegation(options: ServerOptions, now: Rfc3339): Built {
  // Apex only. A delegated host that could also serve this record could delegate
  // onward, and the property the record exists to create - that no party can add
  // itself - would be gone the first time somebody tried.
  if (!options.site.apex) {
    return {
      status: 404,
      headers: { "Content-Type": PROBLEM_CONTENT_TYPE },
      body: blankProblem(404, "Not Found", now),
    };
  }
  const record = delegationRecord(options.site, now);
  return json(200, record, { [HEADER.cache_control]: maxAge(Math.floor(record.max_age_ms / 1000)) });
}

/* -- resolve_occasions ------------------------------------------------------ */

async function serveOccasions(options: ServerOptions, url: URL, now: Rfc3339): Promise<Built> {
  const { site } = options;
  const source = options.occasions ?? STORE_OCCASIONS;

  const from = instantParam(url, "from");
  const to = instantParam(url, "to");
  if (from !== undefined && to !== undefined) {
    const width = Date.parse(to) - Date.parse(from);
    if (width < 0) throw refuse("schema_validation", "The window ends before it begins.");
    if (width > maxWindowMs(site)) {
      throw refuse("window_too_wide", "That window is wider than this Server publishes.");
    }
  }

  const requested = url.searchParams.get("page_size");
  let page_size = maxPageSize(site);
  if (requested !== null) {
    const parsed = Number(requested);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw refuse("schema_validation", "page_size is a positive integer.");
    }
    // Clamped, not refused: `max_page_size` is a published limit and a caller
    // asking for more is asking for everything, which this answers.
    page_size = Math.min(parsed, maxPageSize(site));
  }

  const cursor = url.searchParams.get("cursor");
  const after = cursor === null ? undefined : decodeCursor(cursor);

  // One more than asked for, so "is there a next page" is a fact rather than a
  // guess from a full page.
  const rows = await source.page(options.db, { from, to, after, limit: page_size + 1 });
  const page = rows.slice(0, page_size);
  const documents = page.map((r) => r.document);
  const fits = fitToProseBudget(documents);
  const served = page.slice(0, fits);

  let seconds = 0;
  if (served.length > 0) {
    seconds = Math.min(
      ...served.map((r) => occasionMaxAgeSeconds(maxStalenessMs(r.document) ?? 0)),
    );
  }

  const body: Record<string, unknown> = {
    changeover: "0.1",
    occasions: served.map((r) => r.document),
    server_time: now,
  };
  const more = rows.length > page_size || fits < page.length;
  const last = served[served.length - 1];
  if (more && last !== undefined) {
    body.next_cursor = encodeCursor({ starts_at: last.starts_at, occasion_id: last.occasion_id });
  }

  return json(200, body, { [HEADER.cache_control]: maxAge(seconds) });
}

function instantParam(url: URL, name: string): Rfc3339 | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw refuse("schema_validation", `${name} is an RFC 3339 instant with an offset.`);
  }
  return value;
}

async function serveOccasion(
  options: ServerOptions,
  occasion_id: string,
  if_match: string | undefined,
  now: Rfc3339,
): Promise<Built> {
  const source = options.occasions ?? STORE_OCCASIONS;
  const row = await source.read(options.db, occasion_id);
  if (row === null || row.document === null || row.document === undefined) {
    throw refuse("occasion_not_found", "No such Occasion at this venue.");
  }

  // The target of this request IS the Occasion, so the condition means what RFC
  // 9110 says it means. The wire etag is unquoted; the header carries it quoted;
  // the comparison strips the quotes on the way in.
  if (if_match !== undefined && !ifMatchMatches(if_match, row.etag)) {
    const changed = (options.changed_paths ?? WHOLE_DOCUMENT_CHANGED).changedPaths(row, if_match);
    throw refuse("occasion_moved", "This Occasion has changed since that etag.", {
      detail: { changed_paths: [...changed] },
    });
  }

  return json(200, row.document, {
    [HEADER.etag]: quoteEtag(row.etag),
    [HEADER.cache_control]: maxAge(occasionMaxAgeSeconds(maxStalenessMs(row.document) ?? 0)),
  });
}

/* -- Bodies ----------------------------------------------------------------- */

/**
 * Parse a write body, delete every scope-bearing member, and refuse the rest of
 * what V3 calls unknown.
 *
 * The order is deliberate and it is the whole of §6.3's auth paragraph. Scope
 * members are deleted **before** the unknown-member check, so a body carrying
 * `agent_id` is *ignored* rather than refused: §6.3's rule about them is
 * specific and says delete-and-refill, while V3's rule is about members the
 * Server does not recognise at all. `agent_id` is recognised perfectly well; it
 * is simply not an input.
 */
function writeBody(
  request: HttpRequestLike,
  known: readonly string[],
): { body: Record<string, unknown>; ignored: readonly string[] } {
  const raw = request.body;
  if (raw.length === 0) {
    throw refuse("schema_validation", "This verb takes a JSON body.");
  }
  const content_type = headerOf(request, HEADER.content_type) ?? "";
  if (!content_type.split(";")[0]?.trim().toLowerCase().endsWith("json")) {
    throw refuse("schema_validation", "This verb takes application/json.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw refuse("schema_validation", "That body is not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw refuse("schema_validation", "That body is not a JSON object.");
  }

  const stripped = stripScopeBearing(parsed);
  for (const member of Object.keys(stripped.body)) {
    if (!known.includes(member)) {
      // V3: a Server MUST reject unknown members in write bodies. A silently
      // ignored write field is a correctness hazard wearing tolerance's clothes.
      //
      // The member NAME is caller-controlled and is NEVER interpolated. Until
      // 2026-08-26 it was, and a body whose extra member name was the payload
      // put injected instruction text, a Luhn-valid PAN, an address, an E.164
      // number, `javascript:` and raw C0 controls into `refusal.reason` — the
      // Server re-emitting an attacker's bytes as its own words, to a consumer
      // with no judgement. That breaks PR3 (never pass text into `reason`
      // without re-typing it to a code), PR2, §5.1 Lock 4, and the whole thesis
      // of §5.3. §2.7's `detail` oneOf has no schema_validation branch, so the
      // offending name has nowhere legal to go either. The accepted members are
      // a server-authored constant, so naming those says everything a caller
      // can act on.
      throw refuse(
        "schema_validation",
        `This verb accepts only these members: ${known.join(", ")}.`,
      );
    }
  }
  return { body: stripped.body, ignored: stripped.ignored };
}

function idempotencyKey(request: HttpRequestLike, verb: IdempotentVerb): string | undefined {
  const key = headerOf(request, HEADER.idempotency_key);
  if (key === undefined) {
    if (KEY_REQUIRED_VERBS.includes(verb)) {
      throw refuse("schema_validation", "This verb requires an Idempotency-Key.");
    }
    return undefined;
  }
  assertKeyShape(key);
  return key;
}

/* -- hold_seats ------------------------------------------------------------- */

const HOLD_SEATS_MEMBERS: readonly string[] = Object.freeze([
  "occasion_id",
  "occasion_etag",
  "sought",
  "seats",
  "selection",
  "requested_floor_ms",
  "intent_digest",
]);

/**
 * The options `hold_seats` runs under, derived from the policy this Server
 * **publishes** and from nothing else.
 *
 * §2.5: *"A Server MUST NOT enforce a limit it has not published."* The converse
 * is X1 and X3 — `max_live_holds_per_showtime`, `max_holds_per_site_per_hour`,
 * `max_live_holds_per_cluster`, `max_live_seats_per_showtime`,
 * `max_held_fraction_per_showtime` and `max_live_holds_per_site` **MUST** be
 * enforced — so a binding that published a `hold_policy` in its capability
 * document and left `BUDGETS_UNENFORCED` underneath it would be shipping the
 * weapon §4.7 opens by naming. The published document and the enforced guard
 * are therefore **one value**, read once, here.
 */
function holdSeatsOptions(options: ServerOptions, profile: Profile): HoldSeatsOptions {
  const published: HoldPolicyDocument = options.site.hold_policy ?? HOLD_POLICY_PUBLISHED;
  const supplied = options.hold_seats ?? {};
  return {
    ...supplied,
    profile: supplied.profile ?? profile,
    policy: supplied.policy ?? {
      policy_max_floor_ms: published.policy_max_floor_ms,
      max_seats_per_hold: published.max_seats_per_hold,
      abandonment_floor_penalty_bp: published.abandonment_floor_penalty_bp,
    },
    budgets: supplied.budgets ?? principalBudgets(published),
  };
}

/**
 * Project a request digest, or refuse. A throw out of `jcs()` or
 * `decisionMembers()` means the body was not the shape they assume — which is a
 * `400`, never a `503`.
 */
function digestOrRefuse(project: () => string): string {
  try {
    return project();
  } catch (err) {
    if (isRefusal(err)) throw err;
    throw refuse("schema_validation", "That request body is not the shape this verb takes.");
  }
}

async function serveHoldSeats(
  options: ServerOptions,
  request: HttpRequestLike,
  site_credential: SiteCredential,
  profile: Profile,
): Promise<Built> {
  const { body } = writeBody(request, HOLD_SEATS_MEMBERS);

  // `Changeover-Occasion-ETag` is an OPTIONAL echo of the body's normative
  // member. A disagreement is 400 schema_validation and not a silent preference
  // for either: two values that were supposed to be one is a caller bug, and
  // picking a winner would hide it behind a hold that succeeded against an
  // Occasion the caller did not name.
  const echoed = headerOf(request, HEADER.changeover_occasion_etag);
  if (echoed !== undefined && echoed.trim() !== body.occasion_etag) {
    throw refuse(
      "schema_validation",
      "Changeover-Occasion-ETag disagrees with occasion_etag; the body is normative.",
    );
  }

  // G1 step 2, BEFORE anything reads the request for any other purpose.
  //
  // `holdSeatsDigest` projects `D` out of the body, and `decisionMembers`
  // dereferences `request.sought.occasion_id`. On a body missing `sought` that
  // is a TypeError, thrown from inside the idempotency wrapper, caught by the
  // handler's catch-all, and — until 2026-08-26 — rendered `503
  // upstream_unavailable` with a retry instruction. `writeBody` above checks
  // JSON-ness and member NAMES only; it never checked a type or a presence.
  // I8 is not breached by moving the check here: I8 orders idempotency before
  // STATE guards, and G1 puts `schema_validation` at step 2, ahead of all of
  // them.
  assertHoldSeatsShape(body);

  const key = idempotencyKey(request, "hold_seats") as string;
  const credential: Credential = credentialOf(site_credential);
  const verb_request = body as unknown as HoldSeatsRequest;
  const grant = holdSeatsOptions(options, profile);

  const outcome = await withIdempotency(
    options.db,
    {
      agent_id: credential.agent_id,
      principal_scope: credential.principal_scope,
      verb: "hold_seats",
      idempotency_key: key,
    },
    // Belt and braces. `assertHoldSeatsShape` above makes this total, and the
    // wrapper stays because no defect in a caller's projection should ever be
    // able to reach the wire as a statement about the exhibitor's system.
    digestOrRefuse(() => holdSeatsDigest(verb_request)),
    () => holdSeats(options.db, verb_request, credential, grant),
  );

  if (outcome.disposition === "input_required") {
    // Unreachable: `holdSeats` returns a document. The gate lives in the MCP
    // binding, and this Server publishes `gate_stage` rather than enforcing one
    // here. Throwing rather than inventing a status keeps the surface honest.
    throw new Error("hold_seats returned an InputRequiredResult on the HTTP binding");
  }

  const document = outcome.record as unknown as { hold_id: string };
  const headers: Record<string, string> = {
    [HEADER.idempotency_replayed]: String(outcome.replayed),
    [HEADER.location]: `/changeover/v0/holds/${encodeURIComponent(document.hold_id)}`,
  };
  // A replay created nothing. `201` would tell every intermediary on the path
  // that a resource had just come into existence, twice, for one Hold.
  return json(outcome.replayed ? 200 : 201, outcome.record, headers);
}

/* -- get_hold / release_hold / hand_off ------------------------------------- */

async function serveGetHold(
  options: ServerOptions,
  hold_id: string,
  site_credential: SiteCredential,
): Promise<Built> {
  const document = await getHold(
    options.db,
    hold_id,
    credentialOf(site_credential),
    options.get_hold ?? {},
  );
  return json(200, document);
}

async function serveRelease(
  options: ServerOptions,
  request: HttpRequestLike,
  hold_id: string,
  site_credential: SiteCredential,
): Promise<Built> {
  const credential = credentialOf(site_credential);
  const key = idempotencyKey(request, "release_hold");

  const run = () => releaseHold(options.db, hold_id, credential);
  const outcome = key === undefined
    ? { replayed: false, record: await run() }
    : await runIdempotent(options, credential, "release_hold", key, releaseHoldDigest(hold_id), run);

  // §6.3 gives release_hold a 204. There is no body, and `Changeover-Server-Time`
  // still carries the instant the state was derived at.
  return {
    status: 204,
    headers: { [HEADER.idempotency_replayed]: String(outcome.replayed) },
    body: undefined,
  };
}

const HAND_OFF_MEMBERS: readonly string[] = Object.freeze(["read_token"]);

async function serveHandOff(
  options: ServerOptions,
  request: HttpRequestLike,
  hold_id: string,
  site_credential: SiteCredential,
): Promise<Built> {
  const { body } = writeBody(request, HAND_OFF_MEMBERS);
  const read_token = body.read_token;
  if (typeof read_token !== "string" || read_token.length === 0) {
    // T4's mechanism, and the refusal is stale_read rather than schema_validation
    // because "you did not re-read" is exactly what a missing token means.
    throw refuse("stale_read", "hand_off requires the read_token get_hold minted.");
  }
  const credential = credentialOf(site_credential);
  const key = idempotencyKey(request, "hand_off") as string;

  const outcome = await runIdempotent(
    options,
    credential,
    "hand_off",
    key,
    handOffDigest(hold_id),
    async () => (await handOff(options.db, { hold_id, read_token }, credential, options.hand_off ?? {})).hold,
  );

  return json(200, outcome.record, { [HEADER.idempotency_replayed]: String(outcome.replayed) });
}

async function runIdempotent<T extends object>(
  options: ServerOptions,
  credential: Credential,
  verb: IdempotentVerb,
  key: string,
  digest: string,
  execute: () => Promise<T>,
): Promise<{ replayed: boolean; record: T }> {
  const outcome = await withIdempotency(
    options.db,
    {
      agent_id: credential.agent_id,
      principal_scope: credential.principal_scope,
      verb,
      idempotency_key: key,
    },
    digest,
    execute,
  );
  if (outcome.disposition === "input_required") {
    throw new Error(`${verb} returned an InputRequiredResult on the HTTP binding`);
  }
  return { replayed: outcome.replayed, record: outcome.record };
}

/* -- Operator Override ------------------------------------------------------ */

const REVOKE_MEMBERS: readonly string[] = Object.freeze(["revocation_reason"]);

export interface RevokeResult {
  readonly changeover: "0.1";
  readonly hold_id: string;
  readonly state: HoldState;
  readonly revoked_at: Rfc3339 | null;
  readonly revocation_reason: string | null;
  readonly seats_freed: number;
  readonly server_time: Rfc3339;
}

/**
 * Operator Override. **Not an agent surface**, and not one of the five verbs.
 *
 * Z1 does not apply here and its absence is deliberate: Z1 exists so one agent
 * cannot address another agent's Hold, and the exhibitor is not an agent — the
 * seats are theirs. What replaces it is the surface check, which happens before
 * this function is reached: a credential without the operator surface gets `403
 * not_authorised` and never learns whether the `hold_id` exists.
 *
 * §4.9 gives `operator_override` exactly two sources, `live` and `handed_off`.
 * Every other state is *(no change)* and answers with the state it is already
 * in — including `claimed`, which is terminal because the purchase is done and
 * which an override must not quietly take back.
 */
async function serveRevoke(
  options: ServerOptions,
  request: HttpRequestLike,
  hold_id: string,
): Promise<Built> {
  const { body } = writeBody(request, REVOKE_MEMBERS);
  const reason = body.revocation_reason;
  if (typeof reason !== "string" || !REVOCATION_REASONS.includes(reason as never)) {
    throw refuse("schema_validation", "revocation_reason is one of the closed set.");
  }

  const result = await options.db.transaction(async (tx) => {
    const time = await serverTime(tx);
    const found = await tx.query<HoldRow>(
      `select ${HOLD_COLUMNS} from hold where hold_id = $1 for update`,
      [hold_id],
    );
    const row = found.rows[0];
    if (row === undefined) throw refuse("hold_not_found", "No such Hold at this venue.");

    const state = deriveState(row, time);
    if (state !== HOLD_STATE.live && state !== HOLD_STATE.handed_off) {
      return {
        changeover: "0.1",
        hold_id,
        state,
        revoked_at: row.revoked_at,
        revocation_reason: row.revocation_reason,
        seats_freed: 0,
        server_time: time,
      } as RevokeResult;
    }

    await tx.query(
      "update hold set revoked_at = $2::timestamptz, revocation_reason = $3" +
        " where hold_id = $1 and revoked_at is null",
      [hold_id, time, reason],
    );

    // `revocation_voids_holds` is published `true`, so the seats stop occupying.
    // The rows are MARKED, not deleted, exactly as a release marks them: the
    // occupancy predicate is `state in ('live','handed_off','claimed')`, so a
    // marked row leaves the unique index and the seat is immediately re-holdable
    // while the record of which seats this Hold held survives.
    const seats = await tx.query(
      "update hold_seat set state = 'revoked' where hold_id = $1 and state in ('live', 'handed_off')",
      [hold_id],
    );
    await tx.query(
      "update hold_cluster set state = 'revoked' where hold_id = $1 and state in ('live', 'handed_off')",
      [hold_id],
    );
    await tx.query("delete from hold_slot where hold_id = $1", [hold_id]);

    return {
      changeover: "0.1",
      hold_id,
      state: HOLD_STATE.revoked,
      revoked_at: time,
      revocation_reason: reason,
      seats_freed: seats.rowCount,
      server_time: time,
    } as RevokeResult;
  });

  return json(200, result);
}

/* -- node:http -------------------------------------------------------------- */

/**
 * The socket adapter, and the only part of this file that knows about sockets.
 *
 * The body is read with a cap. A body above it is refused `400
 * schema_validation` rather than `413`, because the refusal taxonomy is closed
 * and there is no 413 in it: a body this Server will not read is a body that
 * failed validation, by size, and the caller needs a code it can switch on more
 * than it needs a status that flatters HTTP.
 */
export function createServer(options: ServerOptions): Server {
  const cap = options.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;

  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let body = "";
      let over = false;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > cap) {
            over = true;
            break;
          }
          chunks.push(chunk as Buffer);
        }
        if (!over) body = Buffer.concat(chunks).toString("utf8");
      } catch {
        over = true;
      }

      const response = over
        ? await refusedBody(options)
        : await handle(options, {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers as Record<string, string | string[] | undefined>,
          body,
        });

      const headers = { ...response.headers };
      const encoded = response.body === undefined ? "" : JSON.stringify(response.body);
      if (response.body !== undefined) {
        headers["Content-Length"] = String(Buffer.byteLength(encoded, "utf8"));
      }
      res.writeHead(response.status, headers);
      res.end(response.body === undefined ? undefined : encoded);
    })();
  });
}

async function refusedBody(options: ServerOptions): Promise<HttpResponseLike> {
  const now = await currentTime(options.db);
  const refusal = refuse("schema_validation", "That request body is larger than this Server reads.");
  return stamped(problemResponse(refusal.code, problemOf(refusal.toDocument(now))), now);
}

/** The address a running server is listening on, as an origin. */
export function originOf(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server is not listening on a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}
