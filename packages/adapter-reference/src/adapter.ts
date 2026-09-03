// The adapter interface. Owner: ADAPT-001.
//
// One interface, three implementations, and only one of them owns its store.
//
// ADAPT-001 is the authoritative adapter: CHANGEOVER's own tables ARE the
// system of record, so `profile: "1"`, `hold_basis: "system_of_record"`,
// `floor_basis: "owned_store"`. ADAPT-002 is a Vista-shaped shim at Profile 1S
// above a CMS it does not control, and ADAPT-003 is a read-only Profile 0
// probe. **Both must satisfy this file without modifying it**, which is what
// fixes its shape:
//
//   1 · No method takes a `Db`. The store is the adapter's business and a
//       Profile 1S adapter does not have one to hand you. An adapter closes
//       over whatever it is above.
//   2 · The interface is TOTAL. A Profile 0 adapter implements all four write
//       methods and each one throws `501 profile_not_supported` — see
//       {@link profileNotSupported}. A missing method would make "this Server
//       does not hold seats" a TypeError at the binding instead of a typed
//       refusal on the wire, and §6.3 gives it a code precisely so it is not.
//   3 · `floorEvidence()` is a method, not a constant. §7: *a Server MUST NOT
//       grant a floor it has not measured.* At Profile 1 the measurement is of
//       a table this adapter owns; at 1S it is of a CMS's observed retention,
//       taken over a window, and it can legitimately come back `null` — for
//       which the answer is `503 floor_unavailable` and never a number.
//   4 · Refusals are THROWN, never returned. A method's return type is the
//       success shape only, so there is no branch anywhere in a binding that
//       holds a document and must remember to check a status beside it.
//
// There is no settlement method, and there is no seam where one could be added
// without adding it here in the open (ADR-001).

import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";
import { refuse } from "@changeover/schema/refusal.ts";
import type { Credential, HoldDocument, HoldSeatsRequest } from "@changeover/core/hold-seats.ts";
import type { HoldReadDocument } from "@changeover/core/get-hold.ts";
import type { ReleaseOutcome } from "@changeover/core/release.ts";
import type { HandOffRequest, HandOffResult } from "@changeover/core/hand-off.ts";

/* ── 1 · Identity: the three declarations a report is keyed on ─────────────── */

/** §6.3 Profiles. `0` Legible · `1` Held · `1S` Shadow. */
export const PROFILE = { legible: "0", held: "1", shadow: "1S" } as const;
export type Profile = (typeof PROFILE)[keyof typeof PROFILE];
export const PROFILES: readonly Profile[] = Object.freeze(Object.values(PROFILE));

/**
 * `capability.hold_basis`.
 *
 * §6.3: a 1S Server **MAY** mint Holds and **MUST NOT** be advertised as
 * Profile 1. `shadow` is the honest name for a hold whose authoritative seat
 * state lives somewhere the box office, the kiosks, the app and the phone room
 * can also write.
 */
export const HOLD_BASIS = { system_of_record: "system_of_record", shadow: "shadow" } as const;
export type HoldBasis = (typeof HOLD_BASIS)[keyof typeof HOLD_BASIS];

/**
 * `capability.floor_basis`.
 *
 * `owned_store` hard-fails C-FLOOR at **one** violation; `measured_warranty`
 * reports a rate against a published threshold. The difference is not severity
 * — it is whether a violation is a bug in software you wrote or an observation
 * about someone else's system.
 */
export const FLOOR_BASIS = { owned_store: "owned_store", measured_warranty: "measured_warranty" } as const;
export type FloorBasis = (typeof FLOOR_BASIS)[keyof typeof FLOOR_BASIS];

/** The three declarations `changeover conform` writes into the dated report. */
export interface AdapterIdentity {
  readonly profile: Profile;
  readonly hold_basis: HoldBasis;
  readonly floor_basis: FloorBasis;
}

/* ── 2 · The documents crossing the interface ──────────────────────────────── */

/**
 * An Occasion exactly as published — `urn:changeover:schema:occasion:0.1`.
 *
 * Deliberately opaque here. `additionalProperties: false` and PROJECTION_0_1
 * are the authority on its shape, and a hand-written TypeScript mirror of a
 * frozen schema is a second definition that drifts. Bindings validate; this
 * interface carries.
 */
export type OccasionDocument = Readonly<Record<string, unknown>>;

/** `urn:changeover:schema:seatmap:0.1`. Opaque here for the same reason. */
export type SeatMapDocument = Readonly<Record<string, unknown>>;

/** `urn:changeover:schema:capability:0.1`. See `capability.ts` for the builder. */
export type CapabilityDocument = Readonly<Record<string, unknown>>;

/**
 * §7's `floor_evidence`, and the whole price of admission for an adapter.
 *
 * `floor_ms` — and therefore the published `policy_max_floor_ms` an Agent may
 * request up to — **MUST NOT** exceed `min_observed_retention_ms −
 * safety_margin_ms`. A `floor_basis` of `owned_store` does not exempt an
 * adapter from measuring; it only changes what the measurement is of.
 */
export interface FloorEvidence {
  readonly observations: number;
  readonly window_start: Rfc3339;
  readonly window_end: Rfc3339;
  readonly min_observed_retention_ms: DurationMs;
  readonly safety_margin_ms: DurationMs;
  readonly violations: number;
}

/* ── 3 · The read half ─────────────────────────────────────────────────────── */

/**
 * `resolve_occasions`. `window_*` bound the search; beyond `max_window_ms` the
 * refusal is `400 window_too_wide` and never a silent truncation, because a
 * caller with no eyes cannot tell a short page from a short answer.
 */
export interface ResolveOccasionsQuery {
  readonly window_start?: Rfc3339;
  readonly window_end?: Rfc3339;
  readonly cursor?: string;
  readonly page_size?: number;
}

/** One page of Occasions. `next_cursor` absent means this page is the last. */
export interface OccasionPage {
  readonly changeover: "0.1";
  readonly occasions: readonly OccasionDocument[];
  readonly next_cursor?: string;
  readonly server_time: Rfc3339;
}

/** `GET /changeover/v0/occasions/{occasion_id}`. `If-Match` is valid here and only here. */
export interface GetOccasionOptions {
  /** The unquoted `1:…` wire form. A mismatch is `412 occasion_moved`. */
  readonly if_match?: string;
}

/* ── 4 · The interface ─────────────────────────────────────────────────────── */

/**
 * What a binding is handed, and the only thing it is handed.
 *
 * `@changeover/http` and `@changeover/mcp` construct one of these and render
 * what it returns. Neither imports a store, a driver or a migration, which is
 * what keeps the two bindings digest-identical: they project through the same
 * objects rather than through two readings of a body.
 */
export interface Adapter extends AdapterIdentity {
  /** `GET /.well-known/changeover`. Validates against `capability.schema.json`. */
  capability(): Promise<CapabilityDocument>;

  /**
   * The measurement warranting this Server's floor, or `null` where none
   * exists. `null` is not a failure — it is the state in which every hold verb
   * owes `503 floor_unavailable`.
   */
  floorEvidence(): Promise<FloorEvidence | null>;

  resolveOccasions(query: ResolveOccasionsQuery, credential: Credential): Promise<OccasionPage>;
  getOccasion(
    occasion_id: string,
    credential: Credential,
    options?: GetOccasionOptions,
  ): Promise<OccasionDocument>;
  /** §2.10: same-origin, and requiring the same credential as `resolve_occasions`. */
  seatMap(occasion_id: string, credential: Credential): Promise<SeatMapDocument>;

  holdSeats(request: HoldSeatsRequest, credential: Credential): Promise<HoldDocument>;
  getHold(hold_id: string, credential: Credential): Promise<HoldReadDocument>;
  releaseHold(hold_id: string, credential: Credential): Promise<ReleaseOutcome>;
  handOff(request: HandOffRequest, credential: Credential): Promise<HandOffResult>;

  close(): Promise<void>;
}

/* ── 5 · The surface, as data a proof can read ─────────────────────────────── */

/**
 * The five verbs of `schemas/verbs.json`, mapped to the methods that carry them.
 *
 * A table rather than a comment, so C-ABSENCE.1's *"no settlement verb
 * anywhere"* can be asserted over the adapter surface mechanically instead of
 * by reading. There are five entries. There is no sixth and no seam for one.
 */
export const VERB_METHODS = {
  resolve_occasions: "resolveOccasions",
  hold_seats: "holdSeats",
  get_hold: "getHold",
  release_hold: "releaseHold",
  hand_off: "handOff",
} as const;

export type Verb = keyof typeof VERB_METHODS;
export const VERBS: readonly Verb[] = Object.freeze(Object.keys(VERB_METHODS) as Verb[]);

/** The four methods a Profile 0 adapter answers with `501 profile_not_supported`. */
export const WRITE_METHODS: readonly string[] = Object.freeze([
  "holdSeats",
  "getHold",
  "releaseHold",
  "handOff",
]);

/** Every method on the interface, in declaration order. Read by the surface proof. */
export const ADAPTER_METHODS: readonly string[] = Object.freeze([
  "capability",
  "floorEvidence",
  "resolveOccasions",
  "getOccasion",
  "seatMap",
  "holdSeats",
  "getHold",
  "releaseHold",
  "handOff",
  "close",
]);

/* ── 6 · The two refusals every adapter shares ─────────────────────────────── */

/**
 * `501 profile_not_supported`. What a Profile 0 adapter's four write methods
 * return — as a throw, so the totality of the interface costs a Profile 0
 * implementer four one-line bodies and no branching anywhere above it.
 */
export function profileNotSupported(profile: Profile, verb: Verb): never {
  throw refuse(
    "profile_not_supported",
    `This Server publishes Profile ${profile}, which implements no ${verb}.`,
  );
}

/**
 * `503 floor_unavailable`. §7: *where no measurement exists the refusal is
 * `503 floor_unavailable`* — not a floor picked because a worked example
 * printed one.
 */
export function floorUnavailable(retry_after_ms: DurationMs = 5000): never {
  throw refuse(
    "floor_unavailable",
    "No retention measurement warrants a floor on this Server right now, so it will not grant one.",
    { retry_after_ms },
  );
}
