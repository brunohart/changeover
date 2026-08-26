// The names the migrations create. Owner: CORE-001.
//
// This module exists so that no other package retypes a constraint name as a
// string literal. SPEC.md:393 maps a 23505 to a refusal BY CONSTRAINT NAME, and
// "any other 23505 MUST NOT be reported as seat_contended" — which means a
// typo in a constraint name is not a typo, it is a seat reported as contended
// when it was something else entirely, to a caller with no eyes.
//
// Nothing here reaches SQL as an interpolated identifier from user input. These
// are compile-time constants compared against `constraintName(err)`.

import { SQLSTATE, constraintName, sqlstate } from "./db.ts";

/** Tables in the hold store, in `public`. */
export const TABLE = {
  occasion: "occasion",
  occasion_seat: "occasion_seat",
  hold: "hold",
  hold_seat: "hold_seat",
  hold_cluster: "hold_cluster",
  hold_slot: "hold_slot",
  idempotency: "idempotency",
  schema_migration: "schema_migration",
} as const;

/** The access log, on its own schema under its own ownership (A1, A3). */
export const LOG_SCHEMA = "changeover_log";
export const LOG_TABLE = "changeover_log.access_log";
export const LOG_DEFAULT_PARTITION = "changeover_log.access_log_default";

/**
 * The constraint names a caught 23505 is branched on.
 *
 * The first three are SPEC.md:393 verbatim:
 *   hold_seat_occupied → 409 seat_contended
 *   hold_cluster_live  → 429 cluster_fanout
 *   hold_slot          → 429 hold_budget_exhausted
 */
export const CONSTRAINT = {
  /** The floor. Partial unique on (occasion_id, seat_id) where the seat is occupied. */
  hold_seat_occupied: "hold_seat_occupied",
  /** X2 fan-out. Partial unique on (agent_id, principal_scope, origin, cluster). */
  hold_cluster_live: "hold_cluster_live",
  /**
   * X1 budget. Primary key on (agent_id, principal_scope, showtime_id, slot).
   *
   * SPEC.md:393 spells this constraint `hold_slot`, which Postgres cannot
   * carry: tables and indexes share one namespace, so a constraint of that name
   * on the table of that name is 42P07. The table keeps the specification's
   * name; the constraint is `hold_slot_taken`. Branch on THIS constant — a
   * switch written against the literal "hold_slot" falls through to `default`
   * and turns a 429 hold_budget_exhausted into a 500.
   */
  hold_slot: "hold_slot_taken",
  /** I2/I6. Primary key on (agent_id, principal_scope, verb, idempotency_key_hmac). */
  idempotency_scope: "idempotency_scope",
  /** T1/T3. floor_deadline = granted_at + floor_ms, unwritable otherwise. */
  hold_floor_derived: "hold_floor_derived",
  /** T2. expires_at >= floor_deadline. */
  hold_expiry_not_before_floor: "hold_expiry_not_before_floor",
  /** T6. claim_expires_at >= expires_at. */
  hold_claim_not_before_expiry: "hold_claim_not_before_expiry",
  /** §5.4. A CHECK forces a reason on refusals. */
  access_log_refusal_has_reason: "access_log_refusal_has_reason",
  /**
   * §5.4. Idempotent ingest, including local_wall_offset.
   *
   * Do not branch on this name. On a PARTITIONED table a unique violation names
   * the partition's own index — `access_log_2026_08_local_wall_date_record_…` —
   * and never the parent constraint, so an equality check against this string
   * silently never matches. Use `isLogIngestConflict`, or better, write
   * `on conflict (local_wall_date, record_source, natural_key, local_wall_offset)
   * do nothing` and do not catch anything at all.
   */
  access_log_ingest: "access_log_ingest",
} as const;

/** The columns `access_log_ingest` is unique over, for an ON CONFLICT target. */
export const LOG_INGEST_KEY = [
  "local_wall_date",
  "record_source",
  "natural_key",
  "local_wall_offset",
] as const;

/**
 * True when `err` is the access log's idempotent-ingest conflict.
 *
 * Recognised by shape rather than by name, because Postgres reports the
 * partition's auto-generated index. Repeated ingest of one measurement row is
 * benign by design, so the ordinary handling is ON CONFLICT DO NOTHING and this
 * predicate is for the paths that cannot use one.
 */
export function isLogIngestConflict(err: unknown): boolean {
  if (sqlstate(err) !== SQLSTATE.unique_violation) return false;
  const name = constraintName(err) ?? "";
  return name === CONSTRAINT.access_log_ingest || (name.startsWith("access_log") && name.includes("record_source"));
}

export const ROLE = {
  /** The boundary's own write role. Append-only on the log; no DELETE on `hold`. */
  agent: "changeover_agent",
  /** A3. Owns the log and its partitions, and holds nothing else. */
  retention: "changeover_retention",
} as const;

/**
 * Seat occupancy on `hold_seat`. NOT the Hold's state, which is derived at
 * every read (M1) and has no column anywhere.
 *
 * The predicate of `hold_seat_occupied` is exactly the first three. `claimed`
 * is in it deliberately: it is terminal, it occupies its seat for the life of
 * the screening, and it MUST NOT be reaped.
 */
export const SEAT_OCCUPYING_STATES = ["live", "handed_off", "claimed"] as const;
/** X2's predicate. `claimed` is deliberately absent: the purchase is done. */
export const CLUSTER_OCCUPYING_STATES = ["live", "handed_off"] as const;

export const SEAT_ROW_STATES = [
  "live",
  "handed_off",
  "claimed",
  "released",
  "expired",
  "revoked",
] as const;
export type SeatRowState = (typeof SEAT_ROW_STATES)[number];

/** §2.10, and what W3 decides `seat_unavailable` from. */
export const SEAT_STATUS = [
  "available",
  "held",
  "sold",
  "blocked",
  "companion",
  "wheelchair",
] as const;
export type SeatStatus = (typeof SEAT_STATUS)[number];

/** Every invocation the access log accepts. The five verbs, and the claim. */
export const ACCESS_LOG_VERBS = [
  "resolve_occasions",
  "hold_seats",
  "get_hold",
  "release_hold",
  "hand_off",
  "claim_render",
  "claim_confirm",
] as const;
export type AccessLogVerb = (typeof ACCESS_LOG_VERBS)[number];

/** §5.4: every invocation — ok, refused, error. */
export const ACCESS_LOG_OUTCOMES = ["ok", "refused", "error"] as const;
export type AccessLogOutcome = (typeof ACCESS_LOG_OUTCOMES)[number];

/** Columns `changeover_agent` may UPDATE on `hold`. Everything else is immovable. */
export const HOLD_UPDATABLE_COLUMNS = [
  "expires_at",
  "handed_off_at",
  "handoff_floor_ms",
  "claim_expires_at",
  "released_at",
  "claimed_at",
  "revoked_at",
  "revocation_reason",
  "read_token_hmac",
  "read_token_at",
] as const;
