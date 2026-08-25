// The estate, the credentials and the two running servers the twelve classes of
// TEST-006 assert over. Owner: TEST-006.
//
// Not a `.test.ts` file, so `node --test` does not run it.
//
// **Why this is not `packages/http/test/lib/http-bench.ts`.** That bench exists
// and it is good, and this one deliberately differs in three ways that the
// classes below are entirely about. It *strips* every non-substitutability
// assertion from its Occasions — correct there, because S1 would otherwise
// refuse an ordinary hold, and fatal here, because C-SUBST's whole claim is that
// a hold crossing a strict boundary is refused and writes no seat row. It
// publishes one profile, and C-PROFILE0 needs two. And it holds one credential
// per surface, where C-AUTHZ needs **two agent credentials on one site** —
// B addressing A's Hold is the enumeration oracle the class exists to close, and
// it cannot be staged with one agent.
//
// **Two servers, one store, one site.** The Profile 0 server is the same
// `SiteConfig` with `profile: "0"`, because §6.3's Profile 0 is a publication
// choice and not a different venue. A second site would have proved that two
// different configurations behave differently, which nobody doubted.
//
// **`reset()` re-seeds the estate, and that is not belt-and-braces.** PGlite
// hands every `openDb()` a fresh in-process cluster; a real Postgres does not.
// C-SEATMAP attaches the reference adapter to this store and the adapter seeds a
// measurement house into it; run C-SUBST after that against an un-reset estate
// and `resolve_occasions` answers with a foreign Occasion. Resetting before
// every class makes the order of the twelve irrelevant, which is the only state
// in which "each class passes" means what it says.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import type { Db } from "@changeover/store/db.ts";
import { openDb } from "@changeover/store/db.ts";
import { migrate, resetEstate, resetHoldStore } from "@changeover/store/migrate.ts";
import type { Estate, OccasionSeed, SeatSeed } from "@changeover/store/fixtures.ts";
import { occasionSeedFromDocument, seatGrid, seedEstate } from "@changeover/store/fixtures.ts";
import type { RefusalCode } from "@changeover/schema/refusal.ts";

import { createServer } from "@changeover/http/server.ts";
import type { AccessLog, ServerOptions } from "@changeover/http/server.ts";
import { tokenDirectory } from "@changeover/http/credential.ts";
import type { SiteCredential } from "@changeover/http/credential.ts";
import type { SiteConfig } from "@changeover/http/capability.ts";

/* ── 1 · Where the repository is, from here ────────────────────────────────── */

/** `packages/conformance/src/classes` → the repository root. */
export const REPO_ROOT: string = join(import.meta.dirname, "../../../..");

export function repoFile(relative: string): string {
  return join(REPO_ROOT, relative);
}

function readJson(relative: string): Record<string, any> {
  return JSON.parse(readFileSync(repoFile(relative), "utf8")) as Record<string, any>;
}

/* ── 2 · The venue, and what counts as its own origin ──────────────────────── */

export const SITE_ID = "site_conformance_embassy";
export const VENUE_ORIGIN = "https://embassy.example";
/** O1's delegation. The golden fixture's own `book_url` sits here, not at the apex. */
export const DELEGATED_ORIGIN = "https://tickets.embassy.example";
/** Same-origin with neither. Nothing this Server publishes may name it. */
export const FOREIGN_ORIGIN = "https://not-the-venue.example";

export const AUTHORISED_ORIGINS: readonly string[] = Object.freeze([
  VENUE_ORIGIN,
  DELEGATED_ORIGIN,
]);

/* ── 3 · Instants ──────────────────────────────────────────────────────────── */

const OFFSET_MINUTES = 12 * 60;
const OFFSET = "+12:00";

export interface Instant {
  readonly starts_at: string;
  readonly local_wall: string;
  readonly local_wall_offset: string;
  readonly sales_cutoff_at: string;
}

/**
 * `now + days`, on the hour, at a fixed +12:00 wall.
 *
 * Computed and not written down: a fixture with a hard-coded 2026 sales cutoff
 * passes today and starts refusing `past_sales_cutoff` on a date nobody chose.
 */
export function futureInstant(days: number): Instant {
  const at = new Date(Date.now() + days * 86400000);
  at.setUTCMinutes(0, 0, 0);
  const wall = new Date(at.getTime() + OFFSET_MINUTES * 60000).toISOString();
  const cutoff = new Date(at.getTime() + 15 * 60000 + OFFSET_MINUTES * 60000).toISOString();
  return {
    starts_at: wall.slice(0, 19) + OFFSET,
    local_wall: wall.slice(0, 16),
    local_wall_offset: OFFSET,
    sales_cutoff_at: cutoff.slice(0, 19) + OFFSET,
  };
}

/* ── 4 · The DST fixtures, read rather than retyped ────────────────────────── */

export interface DstSession {
  readonly label: string;
  readonly occasion_id: string;
  readonly instant_utc: string;
  readonly starts_at: string;
  readonly local_wall: string;
  readonly local_wall_offset: string;
}

export interface DstFold {
  readonly timezone: string;
  readonly local_wall: string;
  readonly separation_ms: number;
  readonly sessions: readonly DstSession[];
}

export interface DstGapEdge {
  readonly instant_utc: string;
  readonly local_wall: string;
  readonly local_wall_offset: string;
}

export interface DstGap {
  readonly timezone: string;
  readonly absent_local_wall: string;
  readonly before: DstGapEdge;
  readonly after: DstGapEdge;
  readonly publisher_error: {
    readonly occasion_id: string;
    readonly starts_at: string;
    readonly claimed_local_wall: string;
    readonly claimed_local_wall_offset: string;
    readonly actual_local_wall: string;
    readonly actual_local_wall_offset: string;
  };
}

export const DST_FOLD_PATH = "fixtures/dst/fold.json";
export const DST_GAP_PATH = "fixtures/dst/gap.json";

export function dstFold(): DstFold {
  return readJson(DST_FOLD_PATH) as unknown as DstFold;
}

export function dstGap(): DstGap {
  return readJson(DST_GAP_PATH) as unknown as DstGap;
}

/* ── 5 · Occasions ─────────────────────────────────────────────────────────── */

const GOLDEN = "fixtures/golden/occasion-embassy-sat-1900.json";

export interface OccasionOptions {
  readonly occasion_id: string;
  readonly etag: string;
  readonly capacity: number;
  /** Either a computed future instant, or a fixed one for the DST fixtures. */
  readonly instant: Instant;
  readonly substitution: Record<string, unknown>;
  readonly book_url?: string;
  readonly max_staleness_ms?: number;
  readonly presentation_classes?: readonly string[];
  readonly auditorium_id?: string;
}

/**
 * One published Occasion, derived from the golden fixture.
 *
 * Deriving rather than hand-writing starts from a document three proofs already
 * assert is well-formed, and — more usefully here — one that carries real
 * `prose` envelopes, a real `offers[].band`, and a real `manner` block, all of
 * which `candidateFromOccasion` reads to decide which axis a substitution
 * crossed.
 */
export function occasionDocument(options: OccasionOptions): Record<string, unknown> {
  const document = readJson(GOLDEN);
  document.occasion_id = options.occasion_id;
  document.etag = options.etag;
  document.revision = 1;
  document.instant = {
    starts_at: options.instant.starts_at,
    local_wall: options.instant.local_wall,
    local_wall_offset: options.instant.local_wall_offset,
    sales_cutoff_at: options.instant.sales_cutoff_at,
  };
  document.auditorium = {
    ...document.auditorium,
    id: options.auditorium_id ?? document.auditorium.id,
    capacity: options.capacity,
  };
  if (options.presentation_classes !== undefined) {
    document.manner = { ...document.manner, presentation_classes: [...options.presentation_classes] };
  }
  document.availability = {
    ...document.availability,
    seats_available: options.capacity,
    max_staleness_ms: options.max_staleness_ms ?? 30000,
    seat_map_ref: `${VENUE_ORIGIN}/changeover/v0/occasions/${options.occasion_id}/seats`,
  };
  document.substitution = options.substitution;
  document.book_url = options.book_url ?? `${DELEGATED_ORIGIN}/session/${options.occasion_id}`;
  return document;
}

/* -- The ids, so a class names one rather than spelling it ------------------- */

export const OCCASION = {
  /** The workhorse. Advisory, no cluster, roomy enough that X3/X4 do not bind. */
  main: "occ_conf_main",
  /** `strict`, and it attests no outbound edge at all: nothing substitutes for it. */
  sought: "occ_conf_sought",
  /** `strict`, and it attests `⪯ permitted` on the `instant` axis. */
  edge_from: "occ_conf_edge_from",
  /** The far end of that edge. */
  permitted: "occ_conf_permitted",
  /** Its `book_url` is at FOREIGN_ORIGIN. Seeded on purpose, for C-ORIGIN. */
  off_origin: "occ_conf_off_origin",
  /** The two 02:30s of 2027-04-04, an hour apart. */
  fold_nzdt: "occ_dst_fold_nzdt",
  fold_nzst: "occ_dst_fold_nzst",
} as const;

const ETAG_PREFIX = "1:";
/** A syntactically valid etag per Occasion. Never compared to a golden digest. */
function etagFor(seed: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let h = 2166136261;
  for (let i = 0; i < 43; i++) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    out += alphabet[h % alphabet.length];
  }
  return ETAG_PREFIX + out;
}

export const ETAG: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.values(OCCASION).map((id) => [id, etagFor(id)])),
);

const ADVISORY = (cluster: string) => ({
  cluster,
  policy: "advisory",
  accepts_substitute: [],
  not_substitutable_for: [],
  derived_from: { policy_id: "pol_conformance", rule_ids: ["r-advisory"], rule_version: "2026.1" },
});

function foldSeats(count: number): SeatSeed[] {
  return seatGrid({ capacity: count, available: count, per_row: 10 });
}

/** Everything this bench publishes, and nothing else. */
export function conformanceEstate(): Estate {
  const fold = dstFold();
  const fold_early = fold.sessions[0] as DstSession;
  const fold_late = fold.sessions[1] as DstSession;

  const documents: Record<string, unknown>[] = [
    occasionDocument({
      occasion_id: OCCASION.main,
      etag: ETAG[OCCASION.main] as string,
      capacity: 300,
      instant: futureInstant(30),
      substitution: ADVISORY("clu_conf_main"),
    }),
    occasionDocument({
      occasion_id: OCCASION.sought,
      etag: ETAG[OCCASION.sought] as string,
      capacity: 20,
      instant: futureInstant(31),
      auditorium_id: "aud_conf_other_room",
      presentation_classes: ["pres:35mm-4perf", "pres:sound-optical"],
      substitution: {
        cluster: "clu_conf_strict",
        policy: "strict",
        accepts_substitute: [],
        not_substitutable_for: [
          {
            occasion_id: OCCASION.main,
            axis: "presentation_class",
            reason_code: "carrier",
            detail: {
              content_type: "text/plain",
              value: "A digital projection is not a substitute for the print.",
            },
          },
        ],
        derived_from: {
          policy_id: "pol_conformance",
          rule_ids: ["r-35mm-carrier"],
          rule_version: "2026.1",
        },
      },
    }),
    occasionDocument({
      occasion_id: OCCASION.edge_from,
      etag: ETAG[OCCASION.edge_from] as string,
      capacity: 20,
      instant: futureInstant(32),
      substitution: {
        cluster: "clu_conf_strict",
        policy: "strict",
        accepts_substitute: [{ occasion_id: OCCASION.permitted, axis: "instant" }],
        not_substitutable_for: [],
        derived_from: {
          policy_id: "pol_conformance",
          rule_ids: ["r-same-print-later"],
          rule_version: "2026.1",
        },
      },
    }),
    occasionDocument({
      occasion_id: OCCASION.permitted,
      etag: ETAG[OCCASION.permitted] as string,
      capacity: 40,
      instant: futureInstant(33),
      substitution: ADVISORY("clu_conf_strict"),
    }),
    occasionDocument({
      occasion_id: OCCASION.off_origin,
      etag: ETAG[OCCASION.off_origin] as string,
      capacity: 20,
      instant: futureInstant(34),
      substitution: ADVISORY("clu_conf_main"),
      book_url: `${FOREIGN_ORIGIN}/book/${OCCASION.off_origin}`,
    }),
    occasionDocument({
      occasion_id: OCCASION.fold_nzdt,
      etag: ETAG[OCCASION.fold_nzdt] as string,
      capacity: 20,
      instant: {
        starts_at: fold_early.starts_at,
        local_wall: fold_early.local_wall,
        local_wall_offset: fold_early.local_wall_offset,
        sales_cutoff_at: fold_early.starts_at,
      },
      substitution: ADVISORY("clu_conf_marathon"),
    }),
    occasionDocument({
      occasion_id: OCCASION.fold_nzst,
      etag: ETAG[OCCASION.fold_nzst] as string,
      capacity: 20,
      instant: {
        starts_at: fold_late.starts_at,
        local_wall: fold_late.local_wall,
        local_wall_offset: fold_late.local_wall_offset,
        sales_cutoff_at: fold_late.starts_at,
      },
      substitution: ADVISORY("clu_conf_marathon"),
    }),
  ];

  const occasions: OccasionSeed[] = documents.map((document) => {
    const seed = occasionSeedFromDocument(document, { cluster: null });
    return { ...seed, seats: foldSeats(seed.capacity) };
  });
  return { name: "conformance", occasions };
}

/* ── 6 · Credentials — two agents on ONE site ──────────────────────────────── */

export const TOKEN = {
  /** Agent A. Every Hold in these classes is granted to this one. */
  a: "tok_conf_agent_a",
  /** Agent B. A second agent at the same site, addressing A's Hold. */
  b: "tok_conf_agent_b",
  operator: "tok_conf_operator",
} as const;

export const CREDENTIAL_A: SiteCredential = {
  agent_id: "agt_conf_a",
  principal_scope: "prin_conf_wellington",
  site_id: SITE_ID,
  surfaces: ["agent"],
};

export const CREDENTIAL_B: SiteCredential = {
  agent_id: "agt_conf_b",
  principal_scope: "prin_conf_auckland",
  site_id: SITE_ID,
  surfaces: ["agent"],
};

export const CREDENTIAL_OPERATOR: SiteCredential = {
  agent_id: "agt_conf_operator",
  principal_scope: "prin_conf_operations",
  site_id: SITE_ID,
  surfaces: ["agent", "operator"],
};

export const TOKENS = tokenDirectory({
  [TOKEN.a]: CREDENTIAL_A,
  [TOKEN.b]: CREDENTIAL_B,
  [TOKEN.operator]: CREDENTIAL_OPERATOR,
});

/* ── 7 · The site ──────────────────────────────────────────────────────────── */

export const CLAIM_SECRET = "conformance-claim-secret-not-a-credential";
export const READ_TOKEN_SECRET = "conformance-read-token-secret-not-a-credential";

export function siteConfig(profile: "0" | "1" | "1S"): SiteConfig {
  return {
    site_id: SITE_ID,
    profile,
    venue: {
      id: "ven_conf_embassy",
      name: { content_type: "text/plain", value: "Embassy Theatre" },
      origin: VENUE_ORIGIN,
      timezone: "Pacific/Auckland",
      locality: "Wellington",
    },
    authorised_origins: [VENUE_ORIGIN],
    apex: true,
    delegated_origins: [DELEGATED_ORIGIN],
    delegation_max_age_ms: 86400000,
    claim_binding: "deep_link",
    hold_basis: "system_of_record",
    floor_basis: "owned_store",
    floor_evidence: {
      observations: 24,
      window_start: "2026-08-01T00:00:00+12:00",
      window_end: "2026-08-25T00:00:00+12:00",
      min_observed_retention_ms: 300000,
      safety_margin_ms: 30000,
      violations: 0,
    },
    usage_policy: {
      redistribution: "forbidden",
      cache_max_age_ms: 30000,
      attribution_text: { content_type: "text/plain", value: "Seats held at the Embassy Theatre." },
      contact: "boxoffice@embassy.example",
    },
    max_page_size: 200,
    read_rate_limit_per_hour: 3600,
    max_document_age_ms: 300000,
    occasions_url: `${VENUE_ORIGIN}/changeover/v0/occasions`,
  };
}

/* ── 8 · The access-log seam, observed rather than replaced ────────────────── */

export interface RecordedInvocation {
  readonly route: string;
  readonly outcome: "ok" | "refused" | "error";
  readonly code?: RefusalCode;
}

/**
 * A recorder plugged into `ServerOptions.access_log`.
 *
 * The binding's default is `NO_ACCESS_LOG`, whose own comment says why: A1–A4
 * are CORE-007's and `packages/core/src/hmac.ts` is unwritten. This records what
 * the binding *decided* — one call per invocation, refusals included — which is
 * the half of C-LOG that lives at the boundary. The half that lives in the store
 * is asserted against the store, and the seam between them is named in the
 * class's own unprovable clause rather than papered over here.
 */
export interface Recorder extends AccessLog {
  readonly entries: RecordedInvocation[];
  clear(): void;
}

export function recorder(): Recorder {
  const entries: RecordedInvocation[] = [];
  return {
    entries,
    record(entry) {
      entries.push({ ...entry });
    },
    clear() {
      entries.length = 0;
    },
  };
}

/* ── 9 · Calling a server ──────────────────────────────────────────────────── */

export interface CallOptions {
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  /** `manual` leaves a 3xx unfollowed, which is how C-ORIGIN sees one at all. */
  readonly redirect?: RequestRedirect;
}

export interface Call {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: any;
}

async function callOrigin(
  origin: string,
  method: string,
  path: string,
  options: CallOptions,
): Promise<Call> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    if (headers["Content-Type"] === undefined) headers["Content-Type"] = "application/json";
  }
  const response = await fetch(origin + path, {
    method,
    headers,
    body,
    redirect: options.redirect ?? "follow",
  });
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return { status: response.status, headers: response.headers, text, json: parsed };
}

/** A well-formed Idempotency-Key: I1's alphabet, at least 22 characters. */
export function key(seed: string): string {
  return (seed.replace(/[^A-Za-z0-9_-]/g, "-") + "0123456789abcdefghijklmnopqrstuv").slice(0, 32);
}

/** A hold request against an Occasion, seeking itself unless told otherwise. */
export function holdBody(
  seats: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const occasion_id = (overrides.occasion_id as string) ?? OCCASION.main;
  const occasion_etag = ETAG[occasion_id] as string;
  return {
    occasion_id,
    occasion_etag,
    sought: { occasion_id, occasion_etag },
    seats: [...seats],
    requested_floor_ms: 120000,
    ...overrides,
  };
}

/* ── 10 · The bench ────────────────────────────────────────────────────────── */

export interface ConformanceBench {
  readonly db: Db;
  /** Profile 1. Nine routes, hold verbs live. */
  readonly origin: string;
  /** Profile 0, same site, same store. Every hold verb answers 501. */
  readonly origin0: string;
  readonly site: SiteConfig;
  readonly log: Recorder;
  /** A per-run token, so a row this run wrote is distinguishable from an old one. */
  readonly nonce: string;
  call(method: string, path: string, options?: CallOptions): Promise<Call>;
  call0(method: string, path: string, options?: CallOptions): Promise<Call>;
  /** Truncate the hold store, re-seed the estate, clear the recorder. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface BenchOptions {
  readonly overrides?: Partial<ServerOptions>;
}

export async function conformanceBench(options: BenchOptions = {}): Promise<ConformanceBench> {
  const db = await openDb();
  await migrate(db);

  const estate = conformanceEstate();
  const log = recorder();
  const nonce = `conf${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

  const reseed = async (): Promise<void> => {
    await resetHoldStore(db);
    await resetEstate(db);
    await seedEstate(db, estate);
    log.clear();
  };
  await reseed();

  const site = siteConfig("1");
  // `read_token_secret` appears TWICE on purpose. `get_hold` mints the token and
  // `hand_off` verifies it, each reading its own options object, and each
  // defaulting to a per-process random when unset. Setting it on one side only
  // makes every hand-off answer `409 stale_read` — a refusal that looks exactly
  // like the T4 mechanism working, which is how it survives a casual reading.
  const common: Partial<ServerOptions> = {
    access_log: log,
    hand_off: { claim_secret: CLAIM_SECRET, read_token_secret: READ_TOKEN_SECRET },
    get_hold: { read_token_secret: READ_TOKEN_SECRET },
    ...(options.overrides ?? {}),
  };

  const server: Server = createServer({ db, site, tokens: TOKENS, ...common } as ServerOptions);
  const server0: Server = createServer({
    db,
    site: siteConfig("0"),
    tokens: TOKENS,
    ...common,
  } as ServerOptions);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => server0.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin0 = `http://127.0.0.1:${(server0.address() as AddressInfo).port}`;

  return {
    db,
    origin,
    origin0,
    site,
    log,
    nonce,
    call: (method, path, opts = {}) => callOrigin(origin, method, path, opts),
    call0: (method, path, opts = {}) => callOrigin(origin0, method, path, opts),
    reset: reseed,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => server0.close(() => resolve()));
      await db.close();
    },
  };
}

/* ── 11 · Two things every class needs ─────────────────────────────────────── */

/** Grant a Hold to a token, over the wire, and hand back the parsed document. */
export async function grantHold(
  bench: ConformanceBench,
  token: string,
  seats: readonly string[],
  overrides: Record<string, unknown> = {},
  label = "grant",
): Promise<Call> {
  return bench.call("POST", "/changeover/v0/holds", {
    token,
    headers: { "Idempotency-Key": key(`${label}-${bench.nonce}-${seats.join("-")}`) },
    body: holdBody(seats, overrides),
  });
}

/**
 * Every absolute URL in a document, with the JSON Pointer that carried it.
 *
 * A string is a URL when it parses as one with an `http`/`https` scheme.
 * Relative references are not absolute URLs and O1 is silent about them; this
 * walker therefore reports what O1 governs and nothing else.
 */
export function absoluteUrls(value: unknown, pointer = ""): { pointer: string; url: string }[] {
  const found: { pointer: string; url: string }[] = [];
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) found.push({ pointer, url: value });
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => found.push(...absoluteUrls(entry, `${pointer}/${i}`)));
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      found.push(...absoluteUrls(v, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`));
    }
  }
  return found;
}
