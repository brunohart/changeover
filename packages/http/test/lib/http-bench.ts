/**
 * A migrated store, two published Occasions, and a running HTTP server.
 * Owner: BIND-001.
 *
 * Not a `.test.ts` file, so `node --test` does not run it.
 *
 * **The Occasion documents are the golden fixture, edited.** Writing a fresh
 * Occasion by hand here would produce a document shaped like whatever this
 * author remembered of `occasion.schema.json`; deriving it from
 * `fixtures/golden/occasion-embassy-sat-1900.json` starts from a document three
 * proofs already assert is well-formed, and — more usefully — one that carries
 * real `prose` envelopes, which is what the Q1 byte counter walks.
 *
 * **The instants are computed, not written down.** A fixture with a hard-coded
 * 2026 sales cutoff passes today and starts refusing `past_sales_cutoff` on a
 * date nobody chose. These are `now + N days`, rounded to the hour, so the house
 * is always open.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import type { Db } from "@changeover/store/db.ts";
import { openDb } from "@changeover/store/db.ts";
import { migrate, resetHoldStore } from "@changeover/store/migrate.ts";
import type { Estate, OccasionSeed } from "@changeover/store/fixtures.ts";
import { occasionSeedFromDocument, seedEstate } from "@changeover/store/fixtures.ts";

import { createServer } from "../../src/server.ts";
import type { ServerOptions } from "../../src/server.ts";
import { tokenDirectory } from "../../src/credential.ts";
import type { SiteCredential } from "../../src/credential.ts";
import type { SiteConfig } from "../../src/capability.ts";

/* -- Instants --------------------------------------------------------------- */

/** Pacific/Auckland in August, which is what the golden fixture is dated in. */
const OFFSET_MINUTES = 12 * 60;
const OFFSET = "+12:00";

export interface Instant {
  readonly starts_at: string;
  readonly local_wall: string;
  readonly local_wall_offset: string;
  readonly sales_cutoff_at: string;
}

/** `now + days`, on the hour, expressed at a fixed +12:00 wall. */
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

/* -- Occasions -------------------------------------------------------------- */

const GOLDEN_PATH = join(
  import.meta.dirname,
  "../../../../fixtures/golden/occasion-embassy-sat-1900.json",
);

function golden(): Record<string, any> {
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, any>;
}

export interface DocumentOptions {
  readonly occasion_id: string;
  readonly etag: string;
  readonly days_ahead: number;
  readonly max_staleness_ms: number;
  readonly capacity?: number;
}

/**
 * One published Occasion.
 *
 * Capacity is 300 rather than the golden fixture's 754 (PGlite seeds every seat
 * row) and rather than something tiny, because the published ceilings are
 * **proportions**: X4's principal ceiling is `capacity x 500 / 10000` and X3's
 * platform ceiling is `capacity x 0.02`. On a forty-seat house those are one
 * seat and one seat, so an ordinary two-seat hold is `429 seat_budget_exhausted`
 * and every test below would be asserting against a refusal. 300 seats puts both
 * ceilings at six, which is where §2.5's own absolute numbers sit.
 */
export function occasionDocument(options: DocumentOptions): Record<string, unknown> {
  const document = golden();
  const capacity = options.capacity ?? 300;
  const instant = futureInstant(options.days_ahead);

  document.occasion_id = options.occasion_id;
  document.etag = options.etag;
  document.revision = 1;
  document.instant = {
    starts_at: instant.starts_at,
    local_wall: instant.local_wall,
    local_wall_offset: instant.local_wall_offset,
    sales_cutoff_at: instant.sales_cutoff_at,
  };
  document.auditorium = { ...document.auditorium, capacity };
  document.availability = {
    ...document.availability,
    seats_available: capacity,
    max_staleness_ms: options.max_staleness_ms,
  };
  // The golden fixture asserts a `strict` non-substitutability against two
  // Occasions that are not in this estate. Left in place, S1 would refuse a
  // perfectly ordinary hold for crossing a boundary to a screening that does
  // not exist here.
  document.substitution = {
    cluster: "clu_http_binding",
    policy: "advisory",
    accepts_substitute: [],
    not_substitutable_for: [],
  };
  return document;
}

export const ETAG_A = "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const ETAG_B = "1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

export const OCCASION_A = "occ_http_binding_a";
export const OCCASION_B = "occ_http_binding_b";

/** A carries a 30 s staleness budget; B carries 5 s, so the min() has a bite. */
export function estate(): Estate {
  const a = occasionDocument({
    occasion_id: OCCASION_A,
    etag: ETAG_A,
    days_ahead: 30,
    max_staleness_ms: 30000,
  });
  const b = occasionDocument({
    occasion_id: OCCASION_B,
    etag: ETAG_B,
    days_ahead: 31,
    max_staleness_ms: 5000,
  });
  const seeds: OccasionSeed[] = [
    occasionSeedFromDocument(a, { cluster: null }),
    occasionSeedFromDocument(b, { cluster: null }),
  ];
  return { name: "http-binding", occasions: seeds };
}

/* -- Credentials ------------------------------------------------------------ */

export const SITE_ID = "site_embassy";

export const AGENT_TOKEN = "tok_agent_reference";
export const OPERATOR_TOKEN = "tok_operator_embassy";
/** A second agent, at a different principal, for the scope-refill assertion. */
export const OTHER_TOKEN = "tok_agent_other";

export const AGENT: SiteCredential = {
  agent_id: "agt_reference",
  principal_scope: "prin_wellington",
  site_id: SITE_ID,
  surfaces: ["agent"],
};

export const OPERATOR: SiteCredential = {
  agent_id: "agt_operator",
  principal_scope: "prin_operations",
  site_id: SITE_ID,
  surfaces: ["agent", "operator"],
};

export const OTHER: SiteCredential = {
  agent_id: "agt_other",
  principal_scope: "prin_auckland",
  site_id: SITE_ID,
  surfaces: ["agent"],
};

export const TOKENS = tokenDirectory({
  [AGENT_TOKEN]: AGENT,
  [OPERATOR_TOKEN]: OPERATOR,
  [OTHER_TOKEN]: OTHER,
});

/* -- The site --------------------------------------------------------------- */

export function siteConfig(profile: "0" | "1" | "1S" = "1"): SiteConfig {
  return {
    site_id: SITE_ID,
    profile,
    venue: {
      id: "ven_embassy",
      name: { content_type: "text/plain", value: "Embassy Theatre" },
      origin: "https://embassy.example",
      timezone: "Pacific/Auckland",
      locality: "Wellington",
    },
    authorised_origins: ["https://embassy.example"],
    apex: true,
    delegated_origins: ["https://tickets.example"],
    delegation_max_age_ms: 86400000,
    floor_evidence: {
      observations: 0,
      window_start: "2026-08-01T00:00:00+12:00",
      window_end: "2026-08-25T00:00:00+12:00",
      min_observed_retention_ms: 300000,
      safety_margin_ms: 30000,
      violations: 0,
    },
    usage_policy: {
      redistribution: "forbidden",
      cache_max_age_ms: 30000,
      contact: "boxoffice@embassy.example",
    },
    max_page_size: 200,
    read_rate_limit_per_hour: 600,
    max_document_age_ms: 300000,
    occasions_url: "https://embassy.example/changeover/v0/occasions",
  };
}

/* -- The bench -------------------------------------------------------------- */

export interface HttpBench {
  readonly db: Db;
  readonly server: Server;
  readonly origin: string;
  close(): Promise<void>;
  reset(): Promise<void>;
}

export interface BenchOptions {
  readonly profile?: "0" | "1" | "1S";
  readonly apex?: boolean;
  readonly overrides?: Partial<ServerOptions>;
}

export async function httpBench(options: BenchOptions = {}): Promise<HttpBench> {
  const db = await openDb();
  await migrate(db);
  // Shared-store isolation: see the note in packages/core/test/lib/estate.ts.
  // PGlite gives each script a fresh database; a real Postgres does not.
  await resetHoldStore(db);
  await seedEstate(db, estate());

  const site = { ...siteConfig(options.profile ?? "1"), apex: options.apex ?? true };
  const server = createServer({ db, site, tokens: TOKENS, ...(options.overrides ?? {}) });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    db,
    server,
    origin,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
    reset: () => resetHoldStore(db),
  };
}

/* -- Calling it ------------------------------------------------------------- */

export interface CallOptions {
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

export interface Call {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: any;
}

export async function call(
  bench: HttpBench,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Call> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    if (headers["Content-Type"] === undefined) headers["Content-Type"] = "application/json";
  }
  const response = await fetch(bench.origin + path, { method, headers, body });
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

/** A well-formed Idempotency-Key: 22+ characters from I1's alphabet. */
export function key(seed: string): string {
  return (seed + "0123456789abcdefghijklmnopqrstuv").slice(0, 32);
}

/** A hold request against Occasion A, with the seats given. */
export function holdBody(seats: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    occasion_id: OCCASION_A,
    occasion_etag: ETAG_A,
    sought: { occasion_id: OCCASION_A, occasion_etag: ETAG_A },
    seats: [...seats],
    requested_floor_ms: 120000,
    ...overrides,
  };
}
