/**
 * `get_hold`. SPEC.md §4.1, §4.3 (T4, T7), §4.9 (Z1), §4.6 (M1, M2).
 *
 * Owner: CORE-003.
 *
 * The read verb, and the only one that is REQUIRED before another. Three things
 * happen here and each is a rule with a failure behind it.
 *
 * **1 · The state is computed, not read.** There is no `state` column to select
 * (M1). The document's `state` is {@link deriveState} over this row's
 * timestamps at this read's `server_time`, so a Hold whose `expires_at` has
 * passed reports `expired` with no reaper having run — which, under ADR-006,
 * is the only reaper there is.
 *
 * **2 · The seats are the grant (M2).** They come from `hold.seats`, in every
 * state, for the life of the record. Reading them from `hold_seat` — the
 * obvious, wrong query — returns an empty array after a reap, and
 * `hold.schema.json` declares `seats` `minItems: 1`, so the document becomes
 * unrepresentable at exactly the moment an Agent most needs to read it.
 *
 * **3 · The read leaves a mark (T4).** `get_hold` mints a `read_token` bound to
 * `(hold_id, this read's server_time)` and `hand_off` refuses `409 stale_read`
 * without a fresh one. The Agent is not asked to re-read; it cannot proceed
 * without having done so.
 *
 * And one thing that does not happen: **`expires_at` is reported, never moved.**
 * A read is not an extension. T3 forbids `floor_deadline` to move by any
 * mechanism and T7 forbids `expires_at` to be reduced below a previously
 * reported value; the incumbent behaviour this specification exists to replace
 * is precisely an `expiresAt` that extends on any mutating call, and a read
 * that quietly renewed would be that behaviour with better manners.
 */

import type { Db, Queryable } from "@changeover/store/db.ts";
import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";
import { refuse } from "@changeover/schema/refusal.ts";
import type { Credential } from "./hold-seats.ts";
import { EXTENDABLE, serverTime } from "./clock.ts";
import type { HoldRow, HoldState } from "./derived.ts";
import { HOLD_COLUMNS, deriveState, seatsAsGranted } from "./derived.ts";
import { READ_TOKEN_TTL_MS, mintReadToken } from "./read-token.ts";

/* ── 1 · The document ──────────────────────────────────────────────────────── */

/** T5/CL4, and `hold.schema.json`'s `handoff` object. All four members or none. */
export interface HandoffView {
  readonly handed_off_at: Rfc3339;
  readonly handoff_floor_ms: DurationMs;
  /** CL5: a credential. The Server logs the fact of hand-off and never the token. */
  readonly claim_url: string;
  readonly claim_expires_at: Rfc3339;
}

/**
 * `urn:changeover:schema:hold:0.1`, as a read returns it.
 *
 * Assembled member by member from an explicit list — never by spreading a row.
 * `hold.schema.json` is `additionalProperties: false` and the row carries
 * `principal_scope`, `origin`, `showtime_id` and `read_token_hmac`, none of
 * which belong on the wire. A spread would put all four there and the schema
 * would catch it; a spread of a column added next year would put that there
 * too, and nothing would.
 */
export interface HoldReadDocument {
  readonly changeover: "0.1";
  readonly hold_id: string;
  readonly state: HoldState;
  readonly occasion_id: string;
  readonly occasion_etag: string;
  readonly sought_occasion_id: string;
  readonly seats: readonly string[];
  readonly granted_at: Rfc3339;
  readonly floor_ms: DurationMs;
  readonly floor_deadline: Rfc3339;
  readonly expires_at: Rfc3339;
  readonly extendable: false;
  readonly agent_id: string;
  readonly cluster?: string;
  readonly read_token?: string;
  readonly revocation_reason?: string;
  readonly handoff?: HandoffView;
  readonly server_time: Rfc3339;
}

/* ── 2 · Z1 — object-level authorisation, as one query ─────────────────────── */

/**
 * X0: `principal_scope` is credential-derived and never read from a body, and
 * its absence is `403 principal_scope_missing`. An empty string is absence.
 */
export function requireCredential(credential: Credential): void {
  if (typeof credential?.principal_scope !== "string" || credential.principal_scope.length === 0) {
    throw refuse("principal_scope_missing", "This credential carries no principal scope.");
  }
  if (!/^agt_[A-Za-z0-9_-]{1,40}$/.test(credential.agent_id ?? "")) {
    throw refuse("not_authorised", "This credential carries no agent identity.");
  }
}

export interface LoadHoldOptions {
  /** Take a row lock, for the verbs that then write. R3 requires one at the claim. */
  readonly for_update?: boolean;
}

/**
 * Load a Hold **the credential may address**, or refuse `404 hold_not_found`.
 *
 * > **Z1.** For every verb addressing a `hold_id`, a Server MUST verify the
 * > Hold's `(agent_id, principal_scope)` equals the credential's, and on
 * > mismatch MUST return `404 hold_not_found` — **never `403`**, so the surface
 * > is not an existence oracle.
 *
 * The ownership test is in the `where` clause rather than in a comparison after
 * the fetch, which is the structural version of that rule: there is no branch
 * anywhere in this package that has a Hold in hand and must remember not to
 * return it, and no timing difference between "no such Hold" and "not yours".
 * Object-level authorisation was absent from the draft — its only 403 was
 * verb-level — so a second agent at the same site could release a first agent's
 * seats and take them.
 *
 * Exported because `release_hold`, `hand_off` (CORE-004) and the claim
 * (CORE-004) each address a `hold_id` and must each apply Z1 identically. Three
 * hand-written `where` clauses would be three chances to drop a column.
 */
export async function loadHold(
  tx: Queryable,
  hold_id: string,
  credential: Credential,
  options: LoadHoldOptions = {},
): Promise<HoldRow> {
  requireCredential(credential);
  const result = await tx.query<HoldRow>(
    `select ${HOLD_COLUMNS} from hold` +
      " where hold_id = $1 and agent_id = $2 and principal_scope = $3" +
      (options.for_update ? " for update" : ""),
    [hold_id, credential.agent_id, credential.principal_scope],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw refuse("hold_not_found", "No hold with that identifier is addressable by this credential.");
  }
  return row;
}

/* ── 3 · The claim URL seam ────────────────────────────────────────────────── */

/**
 * Where a handed-off Hold's `claim_url` comes from on a re-read.
 *
 * CL1 requires the URL to be same-origin and its token to carry ≥128 bits from
 * a CSPRNG, so it is minted at hand-off and belongs to CORE-004. This module
 * will not invent one: `hold.schema.json` makes `claim_url` REQUIRED inside the
 * `handoff` object, so a Hold whose claim URL cannot be produced reports
 * `state: "handed_off"` and omits the object entirely rather than emitting a
 * three-quarters version of it.
 */
export interface ClaimUrlSource {
  /** The claim URL for this Hold, or `null` where this deployment cannot re-mint one. */
  claimUrlFor(tx: Queryable, row: HoldRow): Promise<string | null>;
}

/** The default: no re-read of a claim URL. See {@link ClaimUrlSource}. */
export const NO_CLAIM_URL: ClaimUrlSource = {
  async claimUrlFor() {
    return null;
  },
};

/* ── 4 · The verb ──────────────────────────────────────────────────────────── */

export interface GetHoldOptions {
  /**
   * T4's mark. Default `true`: every `get_hold` mints a token, in every state,
   * because `hand_off` is guarded on freshness and not on state, and a read
   * that declined to mint would make the guard depend on which state the Agent
   * happened to read the Hold in.
   */
  readonly mint_read_token?: boolean;
  readonly read_token_ttl_ms?: DurationMs;
  readonly read_token_secret?: string;
  readonly claim_url?: ClaimUrlSource;
}

/**
 * Read one Hold. Total for any Hold the credential may address; `404
 * hold_not_found` otherwise, in every state, per Z1 and §4.9's `get_hold` rows.
 *
 * There is no state in which `get_hold` refuses for being the wrong verb. A
 * revoked Hold reads back `revoked` with its `revocation_reason`; an expired
 * one reads back `expired` with its seats. An Agent whose Hold has gone
 * needs to be told what happened to it, and a refusal that says only
 * `hold_not_live` tells it nothing it can act on.
 */
export async function getHold(
  db: Db,
  hold_id: string,
  credential: Credential,
  options: GetHoldOptions = {},
): Promise<HoldReadDocument> {
  requireCredential(credential);
  const mint = options.mint_read_token ?? true;
  const claim_urls = options.claim_url ?? NO_CLAIM_URL;

  return db.transaction(async (tx) => {
    // K4: one time source, and it is the database. Read before the row, so the
    // instant the state is derived at is not the instant the query finished.
    const server_time = await serverTime(tx);
    const row = await loadHold(tx, hold_id, credential, { for_update: mint });
    const state = deriveState(row, server_time);

    let read_token: string | undefined;
    if (mint) {
      const minted = mintReadToken(hold_id, server_time, {
        secret: options.read_token_secret,
        ttl_ms: options.read_token_ttl_ms ?? READ_TOKEN_TTL_MS,
      });
      // The only write a read performs, and it touches nothing that bears on
      // the seats: `read_token_hmac` and `read_token_at` are the two columns
      // 0003 grants UPDATE on for this purpose. `expires_at` is not among them
      // here — a read does not extend a Hold (T3, T7).
      await tx.query(
        "update hold set read_token_hmac = $2, read_token_at = $3::timestamptz where hold_id = $1",
        [hold_id, minted.read_token_hmac, minted.read_token_at],
      );
      read_token = minted.read_token;
    }

    const claim_url = row.handed_off_at === null ? null : await claim_urls.claimUrlFor(tx, row);
    return holdDocument(row, state, server_time, read_token, claim_url);
  });
}

/**
 * Assemble the wire document. Exported so `hand_off` and the reference adapter
 * render one Hold the same way this verb does — I4 re-projects `state`,
 * `expires_at` and `claim_expires_at` at replay using exactly this derivation,
 * and a replay that echoed a second rendering would reintroduce the lie.
 */
export function holdDocument(
  row: HoldRow,
  state: HoldState,
  server_time: Rfc3339,
  read_token?: string,
  claim_url?: string | null,
): HoldReadDocument {
  const document: {
    -readonly [K in keyof HoldReadDocument]: HoldReadDocument[K];
  } = {
    changeover: "0.1",
    hold_id: row.hold_id,
    state,
    occasion_id: row.occasion_id,
    occasion_etag: row.occasion_etag,
    sought_occasion_id: row.sought_occasion_id,
    // M2. Not a count over hold_seat, in any state, ever.
    seats: seatsAsGranted(row),
    granted_at: row.granted_at,
    floor_ms: row.floor_ms,
    floor_deadline: row.floor_deadline,
    expires_at: row.expires_at,
    extendable: EXTENDABLE,
    agent_id: row.agent_id,
    server_time,
  };
  if (row.cluster !== null) document.cluster = row.cluster;
  if (read_token !== undefined) document.read_token = read_token;
  if (row.revocation_reason !== null) document.revocation_reason = row.revocation_reason;
  if (
    row.handed_off_at !== null &&
    row.handoff_floor_ms !== null &&
    row.claim_expires_at !== null &&
    typeof claim_url === "string" &&
    claim_url.length > 0
  ) {
    document.handoff = {
      handed_off_at: row.handed_off_at,
      handoff_floor_ms: row.handoff_floor_ms,
      claim_url,
      claim_expires_at: row.claim_expires_at,
    };
  }
  return document;
}
