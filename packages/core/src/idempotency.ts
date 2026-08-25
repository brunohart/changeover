/**
 * The store behind `Idempotency-Key` — SPEC.md §4.5, I1–I9. Owner: CORE-005.
 *
 * **A replay is not a cached response.** That single sentence is the whole item.
 * I4 splits the response in two: `hold_id`, `seats`, `granted_at`, `floor_ms`
 * and `floor_deadline` are byte-identical on replay, and `server_time`, `state`,
 * `expires_at` and `claim_expires_at` are **re-projected from current state**.
 * A Hold served from a response cache asserts `state: live` over a floor that
 * expired forty seconds ago, and an Agent obeying K1 exactly then computes 180
 * seconds of runway when it has 140. The split maps onto the two cue marks
 * (ADR-002): the floor is immovable, so it replays unchanged; `expires_at` moves
 * upward, so it must be re-read.
 *
 * I8 puts this layer **strictly before** the state guards. A key-and-digest
 * match replays without reaching G1 at all — it never takes a seat lock, never
 * reaps, and never returns a state-guard refusal. A server that refused a
 * matched key because the Hold had since expired would give one key two
 * different answers depending on when the retry arrived, which is precisely the
 * property idempotency exists to remove.
 *
 * @see SPEC.md §4.5 (I1–I9) · §4.6 M1 (derived state) · §5.5 D1–D4
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

import type { Db, Queryable } from "@changeover/store/db.ts";
import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";
import { Refusal, refuse } from "@changeover/schema/refusal.ts";

import type { HoldSeatsRequest } from "./hold-seats.ts";
import { decisionMembers } from "./hold-seats.ts";
import { rfc3339Sql } from "./clock.ts";

/* ── 1 · The keyed verbs, and the scope a key lives in ─────────────────────── */

/**
 * I1: REQUIRED on `hold_seats` and `hand_off`, RECOMMENDED on `release_hold`.
 * The `verb` column's CHECK in `0001_hold_store.sql` carries the same three.
 */
export const IDEMPOTENT_VERB = {
  hold_seats: "hold_seats",
  hand_off: "hand_off",
  release_hold: "release_hold",
} as const;

export type IdempotentVerb = (typeof IDEMPOTENT_VERB)[keyof typeof IDEMPOTENT_VERB];

export const IDEMPOTENT_VERBS: readonly IdempotentVerb[] =
  Object.freeze(Object.keys(IDEMPOTENT_VERB) as IdempotentVerb[]);

/** I1: the verbs on which a key is REQUIRED, as data a binding can read. */
export const KEY_REQUIRED_VERBS: readonly IdempotentVerb[] =
  Object.freeze(["hold_seats", "hand_off"]);

/**
 * I2: *"Scope is `(agent_id, principal_scope, verb, key)`, all credential-derived,
 * never read from a body."*
 *
 * That the scope tuple is an argument and not a request member is the whole
 * enforcement: there is no path by which a body could widen it. It is also I9's
 * second half — a stored response is returned only to the `(agent_id,
 * principal_scope)` that stored it, which is structural here rather than a
 * check, because a different scope simply does not address the same row.
 */
export interface IdempotencyScope {
  readonly agent_id: string;
  readonly principal_scope: string;
  readonly verb: IdempotentVerb;
  /**
   * The raw `Idempotency-Key` header value. It is hashed on the way in and
   * **never persisted** — P2 (SPEC.md:516) requires the log to store it only as
   * an HMAC, and there is no reason for the idempotency table to be weaker than
   * the log about the same secret.
   */
  readonly idempotency_key: string;
}

/* ── 2 · I1 — what a Server can actually check about a key ─────────────────── */

/**
 * I1 requires ≥128 bits from a CSPRNG. **Entropy is not observable at the
 * boundary** and this function does not pretend otherwise: a server that tried
 * to detect a low-entropy key would have to reject UUIDv7, which I1 explicitly
 * permits. What is checkable is that the key is long enough to *carry* 128 bits
 * in any encoding an Agent would plausibly use, and that it is a token rather
 * than a sentence.
 *
 * 128 bits is 22 base64url characters, 32 hex characters, 26 Crockford base32
 * characters (a ULID is 26) and 36 characters of dashed UUID. 22 is therefore
 * the floor below which the requirement is *provably* unmet, and the only floor
 * a server may impose without refusing a conforming Agent.
 */
export const KEY_MIN_LENGTH = 22;
export const KEY_MAX_LENGTH = 255;
export const KEY_PATTERN = /^[A-Za-z0-9._~:@!$'()*+,;=-]{22,255}$/;

/** Refuses `400 schema_validation` where the key cannot carry 128 bits at all. */
export function assertKeyShape(idempotency_key: unknown): asserts idempotency_key is string {
  if (typeof idempotency_key !== "string" || !KEY_PATTERN.test(idempotency_key)) {
    throw refuse(
      "schema_validation",
      "Idempotency-Key must be 22 to 255 characters of unreserved token text, long enough to carry 128 bits.",
    );
  }
}

/* ── 3 · P2 — the key is stored as an HMAC, never in the clear ─────────────── */

/**
 * The site epoch key, under P2. CORE-007 owns `hmac.ts` and the rotation
 * schedule; this resolves the same secret so the two agree on day one, and the
 * seam below is the single line the integrator re-points when that module lands.
 *
 * With no secret configured a per-process key is minted, and that is said out
 * loud rather than hidden: idempotency then does not survive a restart, which
 * is correct behaviour for a store that has been given nowhere durable to keep
 * a secret, and is a great deal better than persisting the key in the clear.
 */
const EPHEMERAL_EPOCH_KEY: Buffer = randomBytes(32);

export function siteEpochKey(): Buffer {
  const configured = process.env.CHANGEOVER_HMAC_KEY;
  return configured !== undefined && configured.length > 0
    ? Buffer.from(configured, "utf8")
    : EPHEMERAL_EPOCH_KEY;
}

/** True where no `CHANGEOVER_HMAC_KEY` is configured and the epoch key dies with the process. */
export function epochKeyIsEphemeral(): boolean {
  const configured = process.env.CHANGEOVER_HMAC_KEY;
  return configured === undefined || configured.length === 0;
}

/** `HMAC-SHA256(site_epoch_key, key)`, base64url, unpadded — 43 characters. */
export function keyHmac(idempotency_key: string, epoch_key: Buffer = siteEpochKey()): string {
  return createHmac("sha256", epoch_key).update(idempotency_key, "utf8").digest("base64url");
}

/* ── 4 · I3 — the request digest ───────────────────────────────────────────── */

/**
 * RFC 8785 JCS, restricted to exactly the value space `D` admits, and **throwing
 * on anything outside it**.
 *
 * The restriction is the point. JCS's hard part is number formatting, and `D`
 * contains no number that is not a safe integer: `requested_floor_ms` and
 * `selection.quantity` are integer milliseconds and an integer count. Within
 * that space `String(n)` and ES6 `Number::toString` are the same string, so this
 * is exact rather than approximately exact. A float, a `NaN`, a `bigint` or a
 * `Date` reaching here is a defect in the caller's projection, and a serializer
 * that quietly emitted *something* for it would make two bindings disagree on a
 * digest — the one failure I3 exists to prevent.
 *
 * Written rather than imported so that `D` is reproducible from the
 * specification by anyone, with no dependency to install and no version to
 * match. `test/idempotency.test.ts` asserts it byte-equal to the third-party
 * `canonicalize` over a corpus of `D`s, which is what makes "restricted" a
 * claim and not a hope.
 */
export function jcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`jcs: ${String(value)} is outside the value space a decision member may occupy`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => jcs(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("jcs: only plain objects may carry decision members");
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      // RFC 8785 §3.2.3: sort by the UTF-16 code units of the member name.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + jcs(v)).join(",") + "}";
  }
  throw new TypeError(`jcs: ${typeof value} is not a JSON value`);
}

/**
 * I3: `request_digest = SHA-256(JCS(D))`, base64url — 43 characters, which is
 * exactly what `0001_hold_store.sql` CHECKs the column against.
 */
export function requestDigest(decision: Record<string, unknown>): string {
  return createHash("sha256").update(jcs(decision), "utf8").digest("base64url");
}

/**
 * `D` for `hold_seats`, projected through CORE-002's own exported function so
 * that there is one definition of "decision member" and not two that drift.
 *
 * I3 names the exclusions and they are the reason I7 works: gate responses,
 * `intent_digest`, `read_token` and transport metadata **including the key
 * itself** are excluded. Digest the whole body instead and a human gate's
 * satisfying retry carries a new member, becomes a *different* request, and is
 * refused `422` — which is the draft's own worked example returning 422 to a
 * customer who had just answered the dialog.
 */
export function holdSeatsDigest(request: HoldSeatsRequest): string {
  return requestDigest(decisionMembers(request));
}

/** `D` for `hand_off` is `{hold_id}` and nothing else — I3, in as many words. */
export function handOffDecisionMembers(hold_id: string): Record<string, unknown> {
  return { hold_id };
}

export function handOffDigest(hold_id: string): string {
  return requestDigest(handOffDecisionMembers(hold_id));
}

/** `D` for `release_hold`, where a key is RECOMMENDED rather than required. */
export function releaseHoldDigest(hold_id: string): string {
  return requestDigest({ hold_id });
}

/* ── 5 · I4 — the two halves of a replayed document ────────────────────────── */

/**
 * *"`hold_id`, `seats`, `granted_at`, `floor_ms` and `floor_deadline` MUST be
 * byte-identical."* These are the identity of the grant and the immovable cue
 * mark. Nothing that happens after the grant can move any of them: there is no
 * extend verb (T3), and `floor_deadline = granted_at + floor_ms` is a CHECK
 * constraint in the schema rather than a promise in the code.
 */
export const REPLAYED_MEMBERS: readonly string[] =
  Object.freeze(["hold_id", "seats", "granted_at", "floor_ms", "floor_deadline"]);

/**
 * *"…identical in every member **except** `server_time`, `state`, `expires_at`
 * and `claim_expires_at`, which MUST be re-projected from current state at
 * replay."*
 *
 * A table rather than four assignments, because the proof reads it. A member
 * added to one list and forgotten in the other is exactly the defect that ships
 * a response cache wearing an idempotency layer's name, and a list a script can
 * compare against the specification is the only version of this that stays true.
 */
export const REPROJECTED_MEMBERS: readonly string[] =
  Object.freeze(["server_time", "state", "expires_at", "claim_expires_at"]);

/**
 * `claim_expires_at` lives at `/handoff/claim_expires_at` in the Hold document,
 * not at the root — `hold.schema.json` puts `handed_off_at`, `handoff_floor_ms`,
 * `claim_url` and `claim_expires_at` inside one REQUIRED-together object. The
 * re-projection therefore reaches one level down for exactly that member.
 */
export const HANDOFF_MEMBER = "handoff";
export const CLAIM_URL_MEMBER = "claim_url";

export const HOLD_STATE = {
  live: "live",
  handed_off: "handed_off",
  claimed: "claimed",
  released: "released",
  expired: "expired",
  revoked: "revoked",
} as const;

export type HoldState = (typeof HOLD_STATE)[keyof typeof HOLD_STATE];

/** The four members I4 re-projects, read from current state in one clock reading. */
export interface TimeBearing {
  readonly server_time: Rfc3339;
  readonly state: HoldState;
  readonly expires_at: Rfc3339;
  readonly claim_expires_at?: Rfc3339;
  /**
   * I9's trigger. True once the claim has been consumed, or once the claim
   * window has closed — either way the claim URL is spent and a replay must not
   * re-emit it.
   */
  readonly claim_spent: boolean;
}

/**
 * M1, as one SQL expression over one reading of one clock.
 *
 * *"`state` is derived at every read: `revoked` if an override is recorded;
 * `released` if a release is; `claimed` if a claim is; `handed_off` if handed
 * off and `server_time < claim_expires_at`; `live` if `server_time <
 * expires_at`; else `expired`."*
 *
 * The `case` reads `t.now` five times and `t.now` is read once, in a CTE. Calling
 * `clock_timestamp()` inline in each branch would be five readings of a volatile
 * function, which can straddle a deadline mid-row and report `handed_off` beside
 * a `server_time` that says otherwise.
 *
 * **This is a placeholder for CORE-003's `derived.ts` and is exported so that it
 * can be deleted rather than diverge.** M1 must have exactly one implementation;
 * when `derived.ts` lands, the integrator points {@link STORE_REPROJECTION} at
 * it and asserts this constant is gone. A second, drifting copy of the state
 * derivation is the defect this comment exists to make visible.
 */
export const M1_STATE_SQL = `case
      when h.revoked_at is not null then 'revoked'
      when h.released_at is not null then 'released'
      when h.claimed_at is not null then 'claimed'
      when h.handed_off_at is not null and t.now < h.claim_expires_at then 'handed_off'
      when t.now < h.expires_at then 'live'
      else 'expired'
    end`;

/**
 * Where a replay reads current state from. A seam, so that the replay path and
 * `get_hold` cannot answer differently about one `hold_id`.
 */
export interface Reprojector {
  project(tx: Queryable, hold_id: string): Promise<TimeBearing | null>;
}

/** M1 against the `hold` row. Returns `null` where the Hold no longer exists. */
export const STORE_REPROJECTION: Reprojector = {
  async project(tx, hold_id) {
    const result = await tx.query<{
      server_time: string;
      state: string;
      expires_at: string;
      claim_expires_at: string | null;
      claim_spent: boolean;
    }>(
      `with t as (select clock_timestamp() as now)
       select ${rfc3339Sql("t.now")}               as server_time,
              ${M1_STATE_SQL}                      as state,
              ${rfc3339Sql("h.expires_at")}        as expires_at,
              ${rfc3339Sql("h.claim_expires_at")}  as claim_expires_at,
              (h.claimed_at is not null
                 or (h.claim_expires_at is not null and t.now >= h.claim_expires_at)) as claim_spent
         from hold h, t
        where h.hold_id = $1`,
      [hold_id],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      server_time: row.server_time,
      state: row.state as HoldState,
      expires_at: row.expires_at,
      claim_expires_at: row.claim_expires_at ?? undefined,
      claim_spent: row.claim_spent === true,
    };
  },
};

/**
 * Rebuild the stored document under I4: every member as stored, except the four
 * that are re-read.
 *
 * `{ ...stored }` then reassigns the time-bearing members in place, so a member
 * that was present stays where it was and a member that was absent stays absent.
 *
 * **On member order.** `record` is a `jsonb` column and `jsonb` does not preserve
 * member order — Postgres normalises it on the way in. "Byte-identical" in I4 is
 * therefore a claim about each member's *value*, which is what it says
 * ("identical in every member"), and what `prove_idempotent.sh` asserts member by
 * member. Whole-document string equality would be asserting a property of
 * Postgres's jsonb ordering, not a property of this implementation.
 */
export function applyReprojection<T extends object>(
  stored: T,
  time_bearing: TimeBearing,
  claim_consumed: boolean,
): T {
  const out = { ...(stored as Record<string, unknown>) };
  out.server_time = time_bearing.server_time;
  out.state = time_bearing.state;
  out.expires_at = time_bearing.expires_at;

  const handoff = out[HANDOFF_MEMBER];
  if (handoff !== undefined && handoff !== null && typeof handoff === "object") {
    if (claim_consumed) {
      // I9: the one permitted departure from I4. `claim_url` is a credential
      // (CL5) and a replay must not re-emit a spent one. `hold.schema.json`
      // declares `claim_url` REQUIRED inside `handoff` with
      // `additionalProperties: false`, so "claim_url absent" is only
      // representable as the whole `handoff` object being absent.
      delete out[HANDOFF_MEMBER];
    } else {
      out[HANDOFF_MEMBER] = {
        ...(handoff as Record<string, unknown>),
        claim_expires_at: time_bearing.claim_expires_at,
      };
    }
  }
  return out as T;
}
