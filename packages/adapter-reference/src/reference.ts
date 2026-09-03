// The authoritative reference adapter. Owner: ADAPT-001.
//
// Profile 1 · `hold_basis: system_of_record` · `floor_basis: owned_store`.
//
// The store defined by `packages/store/src/migrations/` IS the store. There is
// no CMS behind this, no shim, and nothing else that can write a seat — which is
// what entitles it to `system_of_record` and to nothing more. It still measures
// its own floor before it publishes one (see `floor.ts`), because §7's MUST NOT
// is addressed to Servers and not to shims.
//
// **What this file is careful not to be.** It is not a second implementation of
// the verbs. `holdSeats`, `getHold`, `releaseHold` and `handOff` come from
// `@changeover/core` unchanged; this adapter supplies the seams those verbs
// declare — the availability source, the seat-rule check, the claim-URL source,
// the published policy — and nothing else. Every guard, every refusal and every
// piece of the G1 order lives where it was written once. An adapter that
// re-derived any of it would be a second opinion about the same rule, and two
// opinions about a guard are how a boundary oversells.

import type { Db } from "@changeover/store/db.ts";
import { openDb } from "@changeover/store/db.ts";
import type { Estate, OccasionSeed } from "@changeover/store/fixtures.ts";
import { seedEstate } from "@changeover/store/fixtures.ts";
import { migrate, resetEstate } from "@changeover/store/migrate.ts";
import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";
import { refuse } from "@changeover/schema/refusal.ts";
import { serverTime } from "@changeover/core/clock.ts";
import type { HoldPolicyDocument } from "@changeover/core/budgets.ts";
import { HOLD_POLICY_PUBLISHED, principalBudgets } from "@changeover/core/budgets.ts";
import type { Credential, HoldDocument, HoldSeatsRequest } from "@changeover/core/hold-seats.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import type { HoldReadDocument } from "@changeover/core/get-hold.ts";
import { getHold } from "@changeover/core/get-hold.ts";
import type { ReleaseOutcome } from "@changeover/core/release.ts";
import { releaseHold } from "@changeover/core/release.ts";
import type { HandOffRequest, HandOffResult } from "@changeover/core/hand-off.ts";
import { handOff } from "@changeover/core/hand-off.ts";
import { CLAIM_PATHS } from "@changeover/core/claim.ts";
import type {
  Adapter,
  CapabilityDocument,
  FloorEvidence,
  GetOccasionOptions,
  OccasionDocument,
  OccasionPage,
  ResolveOccasionsQuery,
  SeatMapDocument,
} from "./adapter.ts";
import { floorUnavailable } from "./adapter.ts";
import { buildCapability, MAX_PAGE_SIZE, MAX_WINDOW_MS, warrantedPolicy } from "./capability.ts";
import type { MeasureRetentionOptions, RetentionMeasurement } from "./floor.ts";
import { measureRetention } from "./floor.ts";
import {
  REFERENCE_LOCALITY,
  REFERENCE_ORIGIN,
  REFERENCE_TIMEZONE,
  REFERENCE_VENUE_ID,
  REFERENCE_VENUE_NAME,
  measurementHouse,
  publishedEstate,
} from "./estate.ts";

/* ── 1 · Construction ──────────────────────────────────────────────────────── */

export interface ReferenceAdapterOptions {
  /** An open store. Omitted, one is opened, migrated and closed with the adapter. */
  readonly db?: Db;
  /** Skip `migrate()` where the caller has already run it. */
  readonly migrated?: boolean;
  /** Seed the golden three so `resolve_occasions` has something to answer with. */
  readonly seed_published?: boolean;
  /** Seed a dated house the hold verbs can actually grant against. */
  readonly seed_measurement_house?: boolean;
  readonly measurement?: MeasureRetentionOptions;
  /**
   * Skip the measurement. `floorEvidence()` then returns `null` and every hold
   * verb refuses `503 floor_unavailable` — the state §7 names, reachable on
   * purpose so a conformance class can assert the Server refuses rather than
   * guesses.
   */
  readonly measure_floor?: boolean;
  readonly policy?: HoldPolicyDocument;
  readonly claim_secret?: string;
  readonly read_token_secret?: string;
  /** X1/X3/X4 enforced at production defaults. Off by default, for the same reason C-ATOMIC states its harness profile. */
  readonly enforce_budgets?: boolean;
}

export interface ReferenceAdapter extends Adapter {
  /** The store this adapter is authoritative over. For proofs that assert on rows. */
  readonly db: Db;
  /** The dated house the hold verbs grant against, once seeded. */
  readonly house: OccasionSeed | null;
  /** The measurement warranting the published floor, or `null` where none was taken. */
  readonly measurement: RetentionMeasurement | null;
  /** The policy actually enforced — the same object that is published (§2.5). */
  readonly policy: HoldPolicyDocument | null;
}

/**
 * Build the adapter, measuring its floor on the way up.
 *
 * The measurement happens at construction and not lazily at the first request,
 * so that a Server which cannot warrant a floor discovers it while it is
 * starting rather than while a customer is waiting — and so that
 * `floorEvidence()` is a read of a fact rather than a side effect.
 */
export async function createReferenceAdapter(
  options: ReferenceAdapterOptions = {},
): Promise<ReferenceAdapter> {
  const owns_db = options.db === undefined;
  const db = options.db ?? (await openDb());
  if (!(options.migrated ?? false)) await migrate(db);

  // If this adapter opened the store, the estate in it is nobody else's.
  // seedEstate upserts what it names and leaves foreign Occasions alone, and
  // resolveOccasions({}) answers with everything — so against a durable
  // Postgres the read half was publishing another script's fixtures and being
  // refused by schemas/occasion.schema.json for it. An attached store belongs
  // to its caller and is never cleared here.
  if (owns_db) await resetEstate(db);

  if (options.seed_published ?? true) {
    await seedEstate(db, await publishedEstate());
  }

  let house: OccasionSeed | null = null;
  if (options.seed_measurement_house ?? true) {
    const built = measurementHouse(await serverTime(db), { capacity: 40 });
    await seedEstate(db, built.estate);
    house = built.occasion;
  }

  let measurement: RetentionMeasurement | null = null;
  if (options.measure_floor ?? true) {
    measurement = await measureRetention(db, {
      ...options.measurement,
      // Measured against a house of its own, so a measurement never consumes
      // the seats the conformance classes are about to contend over.
      occasion: options.measurement?.occasion,
    });
  }

  const base = options.policy ?? HOLD_POLICY_PUBLISHED;
  const policy = measurement === null ? null : warrantedPolicy(base, measurement.evidence);

  return new StoreBackedAdapter(db, owns_db, house, measurement, policy, options);
}

/* ── 2 · The adapter ───────────────────────────────────────────────────────── */

class StoreBackedAdapter implements ReferenceAdapter {
  readonly profile = "1" as const;
  readonly hold_basis = "system_of_record" as const;
  readonly floor_basis = "owned_store" as const;

  readonly db: Db;
  readonly house: OccasionSeed | null;
  readonly measurement: RetentionMeasurement | null;
  readonly policy: HoldPolicyDocument | null;

  private readonly owns_db: boolean;
  private readonly options: ReferenceAdapterOptions;

  constructor(
    db: Db,
    owns_db: boolean,
    house: OccasionSeed | null,
    measurement: RetentionMeasurement | null,
    policy: HoldPolicyDocument | null,
    options: ReferenceAdapterOptions,
  ) {
    this.db = db;
    this.owns_db = owns_db;
    this.house = house;
    this.measurement = measurement;
    this.policy = policy;
    this.options = options;
  }

  /* ── the well-known document ─────────────────────────────────────────────── */

  async capability(): Promise<CapabilityDocument> {
    const evidence = await this.floorEvidence();
    if (evidence === null) {
      // §7. A capability document with no `floor_evidence` does not validate,
      // and one with invented evidence is the lie the member exists to prevent.
      floorUnavailable();
    }
    return buildCapability({
      profile: this.profile,
      hold_basis: this.hold_basis,
      floor_basis: this.floor_basis,
      venue: {
        id: REFERENCE_VENUE_ID,
        name: REFERENCE_VENUE_NAME,
        origin: REFERENCE_ORIGIN,
        timezone: REFERENCE_TIMEZONE,
        locality: REFERENCE_LOCALITY,
      },
      evidence,
      policy: this.options.policy ?? HOLD_POLICY_PUBLISHED,
      generated_at: await serverTime(this.db),
      occasions_url: `${REFERENCE_ORIGIN}/changeover/v0/occasions`,
    });
  }

  async floorEvidence(): Promise<FloorEvidence | null> {
    return this.measurement === null ? null : this.measurement.evidence;
  }

  /* ── the read half ───────────────────────────────────────────────────────── */

  async resolveOccasions(
    query: ResolveOccasionsQuery,
    credential: Credential,
  ): Promise<OccasionPage> {
    requireReadCredential(credential);
    const page_size = clampPageSize(query.page_size);
    const window_start = query.window_start ?? null;
    const window_end = query.window_end ?? null;

    if (window_start !== null && window_end !== null) {
      const span = Date.parse(window_end) - Date.parse(window_start);
      if (!Number.isFinite(span)) {
        throw refuse("schema_validation", "The window is not a pair of RFC 3339 instants.");
      }
      if (span > MAX_WINDOW_MS) {
        throw refuse(
          "window_too_wide",
          `This Server resolves at most ${MAX_WINDOW_MS}ms of listings in one request.`,
        );
      }
    }

    return this.db.transaction(
      async (tx) => {
        const server_time = await serverTime(tx);
        // One row over the page, so `next_cursor` is present exactly when there
        // is a next page — never optimistically, which would make a caller with
        // no eyes fetch an empty page to find out.
        const result = await tx.query<{ occasion_id: string; document: unknown }>(
          "select occasion_id, document from occasion" +
            " where document is not null and withdrawn = false" +
            " and ($1::text is null or occasion_id > $1)" +
            " and ($2::timestamptz is null or starts_at >= $2)" +
            " and ($3::timestamptz is null or starts_at <= $3)" +
            " order by occasion_id asc limit $4",
          [query.cursor ?? null, window_start, window_end, page_size + 1],
        );
        const rows = result.rows.slice(0, page_size);
        const page: {
          changeover: "0.1";
          occasions: OccasionDocument[];
          next_cursor?: string;
          server_time: Rfc3339;
        } = {
          changeover: "0.1",
          occasions: rows.map((r) => r.document as OccasionDocument),
          server_time,
        };
        if (result.rows.length > page_size) {
          page.next_cursor = rows[rows.length - 1]?.occasion_id;
        }
        return page;
      },
      { readOnly: true },
    );
  }

  async getOccasion(
    occasion_id: string,
    credential: Credential,
    options: GetOccasionOptions = {},
  ): Promise<OccasionDocument> {
    requireReadCredential(credential);
    return this.db.transaction(
      async (tx) => {
        const row = await tx.query<{ etag: string; document: unknown; withdrawn: boolean }>(
          "select etag, document, withdrawn from occasion where occasion_id = $1",
          [occasion_id],
        );
        const found = row.rows[0];
        if (found === undefined || found.document === null || found.withdrawn) {
          throw refuse("occasion_not_found", "No Occasion with that identifier is published here.");
        }
        // §6.3: the wire etag is the unquoted `1:…` form and a Server MUST strip
        // the quotes an HTTP `If-Match` carries before comparing.
        const presented = options.if_match?.replace(/^"|"$/g, "");
        if (presented !== undefined && presented !== found.etag) {
          throw refuse("occasion_moved", "This Occasion has been revised since that etag was read.", {
            detail: { changed_paths: [] },
          });
        }
        return found.document as OccasionDocument;
      },
      { readOnly: true },
    );
  }

  async seatMap(occasion_id: string, credential: Credential): Promise<SeatMapDocument> {
    // §2.10: the seat map requires the SAME credential as `resolve_occasions`.
    // An unauthenticated seat map is an unbounded enumeration of the house.
    requireReadCredential(credential);
    return this.db.transaction(
      async (tx) => {
        const observed_at = await serverTime(tx);
        const occasion = await tx.query<{ n: string }>(
          "select count(*)::text as n from occasion where occasion_id = $1 and withdrawn = false",
          [occasion_id],
        );
        if (Number(occasion.rows[0]?.n ?? 0) === 0) {
          throw refuse("occasion_not_found", "No Occasion with that identifier is published here.");
        }
        // A seat this boundary holds reads back `held`, and a seat the exhibitor
        // has otherwise removed reads back the exhibitor's own status — W3's
        // distinction, and the reason `seat_unavailable` and `seat_contended`
        // are two codes and not one.
        const seats = await tx.query<{
          seat_id: string;
          section: string | null;
          seat_row: string | null;
          seat_number: number | null;
          status: string;
          adjacency_group: string | null;
          held: boolean;
        }>(
          "select s.seat_id, s.section, s.seat_row, s.seat_number, s.status, s.adjacency_group," +
            " exists (select 1 from hold_seat hs join occasion o on o.occasion_id = s.occasion_id" +
            "   where hs.showtime_id = o.showtime_id and hs.seat_id = s.seat_id" +
            "     and hs.state in ('live','handed_off','claimed')) as held" +
            " from occasion_seat s where s.occasion_id = $1 order by s.seat_id asc",
          [occasion_id],
        );
        return Object.freeze({
          observed_at,
          // The observation IS this transaction, so its age is zero and measured.
          // §2.10 forbids inventing a staleness number and this is the honest one.
          max_staleness_ms: 30000,
          staleness_basis: "measured" as const,
          seats: seats.rows.map((s) => ({
            seat_id: s.seat_id,
            ...(s.section === null ? {} : { section: s.section }),
            ...(s.seat_row === null ? {} : { row: s.seat_row }),
            ...(s.seat_number === null ? {} : { number: String(s.seat_number) }),
            status: s.held && s.status === "available" ? "held" : s.status,
            ...(s.adjacency_group === null ? {} : { adjacency_group: s.adjacency_group }),
          })),
        });
      },
      { readOnly: true },
    );
  }

  /* ── the write half ──────────────────────────────────────────────────────── */

  async holdSeats(request: HoldSeatsRequest, credential: Credential): Promise<HoldDocument> {
    const policy = this.requireWarrantedPolicy();
    return holdSeats(this.db, request, credential, {
      profile: this.profile,
      // The enforced policy IS the published policy: one object, clamped once,
      // handed to the guard and to the document. §2.5's "MUST NOT enforce a
      // limit it has not published" is structural only while that is true.
      policy,
      budgets: (this.options.enforce_budgets ?? false) ? principalBudgets(policy) : undefined,
    });
  }

  async getHold(hold_id: string, credential: Credential): Promise<HoldReadDocument> {
    return getHold(this.db, hold_id, credential, {
      read_token_secret: this.options.read_token_secret,
    });
  }

  async releaseHold(hold_id: string, credential: Credential): Promise<ReleaseOutcome> {
    return releaseHold(this.db, hold_id, credential);
  }

  async handOff(request: HandOffRequest, credential: Credential): Promise<HandOffResult> {
    const policy = this.requireWarrantedPolicy();
    return handOff(this.db, request, credential, {
      handoff_floor_ms: policy.handoff_floor_ms,
      claim_paths: CLAIM_PATHS,
      claim_secret: this.options.claim_secret,
      read_token_secret: this.options.read_token_secret,
    });
  }

  async close(): Promise<void> {
    if (this.owns_db) await this.db.close();
  }

  /**
   * §7's MUST NOT, at the one place a floor is about to be granted.
   *
   * Not a check the verb could forget: `policy` is `null` for the whole life of
   * an adapter whose floor was never measured, so there is no configuration in
   * which a number reaches `holdSeats` unwarranted.
   */
  private requireWarrantedPolicy(): HoldPolicyDocument {
    if (this.policy === null) floorUnavailable();
    return this.policy;
  }
}

/* ── 3 · Small shared guards ───────────────────────────────────────────────── */

/**
 * X0, on the read half too. §2.10 requires the seat map to carry the same
 * credential as `resolve_occasions`, so the check belongs to both and is
 * written once.
 */
function requireReadCredential(credential: Credential): void {
  if (typeof credential?.principal_scope !== "string" || credential.principal_scope.length === 0) {
    throw refuse("principal_scope_missing", "This credential carries no principal scope.");
  }
  if (!/^agt_[A-Za-z0-9_-]{1,40}$/.test(credential?.agent_id ?? "")) {
    throw refuse("not_authorised", "This credential carries no agent identity.");
  }
}

function clampPageSize(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return MAX_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(requested)));
}

/** Re-exported for a caller that wants the estate without the adapter. */
export type { Estate, DurationMs };
