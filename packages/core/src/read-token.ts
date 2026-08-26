/**
 * The read token. SPEC.md §4.3 **T4**, and §4.9's `fresh read_token` guard.
 *
 * Owner: CORE-003.
 *
 * > **T4.** An Agent **MUST NOT** treat `expires_at` as a guarantee, **MUST**
 * > call `get_hold` before `hand_off` … The re-read has a mechanism rather than
 * > a request: `get_hold` returns an opaque `read_token` bound to `(hold_id,
 * > that read's `server_time`)`, valid for a published window; `hand_off`
 * > **REQUIRES** it and refuses `409 stale_read` otherwise. *A thing an agent
 * > must not do should not merely be asked.*
 *
 * That last sentence is the whole design of this file. Every other protocol in
 * this space writes "clients SHOULD re-read before committing" into prose and
 * discovers, in the field, that a model under time pressure does not. Here the
 * re-read leaves a mark in the store, `hand_off` will not proceed without a
 * fresh one, and the refusal is typed and retryable with a named remediation
 * (`re_read`). Nothing is asked of the Agent that the surface does not enforce.
 *
 * **Why an HMAC and not the token.** `hold.read_token_hmac` holds a keyed
 * digest, never the token itself, so a leaked backup is not a set of live
 * tokens. The token is 256 bits from a CSPRNG and is never derived from
 * `hold_id`, so possession of one says nothing about any other Hold.
 *
 * **The window.** T4 says "a published window", and there is nowhere published
 * to put it: neither `hold-policy` nor `capability` has a member for it and
 * both are `additionalProperties: false` and frozen. Reported as a defect
 * against the specification. Until a member exists, {@link READ_TOKEN_TTL_MS}
 * is the reference implementation's value, it is a constructor argument
 * everywhere it is used, and a deployment that shortens it shortens it in one
 * place.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Rfc3339 } from "@changeover/schema/scalars.ts";
import type { DurationMs } from "@changeover/schema/scalars.ts";
import { refuse } from "@changeover/schema/refusal.ts";
import { elapsedMs } from "./clock.ts";

/* ── 1 · The published window ──────────────────────────────────────────────── */

/**
 * How long a read stays fresh. Thirty seconds: long enough that an Agent which
 * reads and then hands off in the same turn never sees `stale_read`, short
 * enough that "I read this Hold" means something about the present.
 *
 * It is deliberately unrelated to `clock_guard_ms`, which binds the *Agent's*
 * planning and which HO2 forbids a Server to refuse on.
 */
export const READ_TOKEN_TTL_MS: DurationMs = 30_000;

/** 256 bits from a CSPRNG. `hold.schema.json` requires ≥22 base64url chars; this is 43. */
export const READ_TOKEN_BYTES = 32;

/** `^[A-Za-z0-9_-]{22,}$`, from `hold.schema.json`. */
export const READ_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,}$/;

/* ── 2 · The key ───────────────────────────────────────────────────────────── */

/**
 * The HMAC key. `CHANGEOVER_READ_TOKEN_SECRET` where a deployment sets one;
 * otherwise 32 fresh bytes, once, for the life of this process.
 *
 * The fallback is not a weakness and it is not a silent one either: a restart
 * invalidates every outstanding token, which surfaces as `409 stale_read` and a
 * `re_read` remediation — the one refusal in this file, already handled by
 * every conforming Agent. A multi-node deployment that does not set the
 * variable gets that refusal on every cross-node hand-off, immediately and
 * loudly, rather than a token minted on one node silently validating on
 * another. Failing closed is the whole point.
 */
function processKey(): Buffer {
  const configured = process.env.CHANGEOVER_READ_TOKEN_SECRET;
  if (typeof configured === "string" && configured.length > 0) {
    return Buffer.from(configured, "utf8");
  }
  EPHEMERAL_KEY ??= randomBytes(32);
  return EPHEMERAL_KEY;
}

let EPHEMERAL_KEY: Buffer | null = null;

/* ── 3 · Minting ───────────────────────────────────────────────────────────── */

export interface MintedReadToken {
  /** The opaque token, returned to the Agent. Never stored. */
  readonly read_token: string;
  /** What `hold.read_token_hmac` carries. Never the token. */
  readonly read_token_hmac: string;
  /** What `hold.read_token_at` carries: **that read's** `server_time`. */
  readonly read_token_at: Rfc3339;
}

export interface ReadTokenOptions {
  readonly secret?: string;
  readonly ttl_ms?: DurationMs;
}

/**
 * Mint a token for one read of one Hold, bound to that read's `server_time`.
 *
 * `server_time` comes from the database (K4). Passing a JavaScript clock here
 * would make the freshness window a comparison between two clocks, which is
 * exactly the class of silent T1 violation K4 exists to forbid.
 */
export function mintReadToken(
  hold_id: string,
  server_time: Rfc3339,
  options: ReadTokenOptions = {},
): MintedReadToken {
  const read_token = randomBytes(READ_TOKEN_BYTES).toString("base64url");
  return {
    read_token,
    read_token_hmac: readTokenHmac(hold_id, server_time, read_token, options.secret),
    read_token_at: server_time,
  };
}

/**
 * The stored digest, over `(hold_id, read_token_at, token)`.
 *
 * `hold_id` is inside the message and not merely inside the row, so a token is
 * bound to its Hold by construction rather than by the lookup happening to be
 * keyed correctly. `read_token_at` is inside it too, so a stored digest cannot
 * be re-dated: moving `read_token_at` forward to buy freshness invalidates the
 * digest it sits beside.
 */
export function readTokenHmac(
  hold_id: string,
  read_token_at: Rfc3339,
  read_token: string,
  secret?: string,
): string {
  const key = typeof secret === "string" && secret.length > 0 ? Buffer.from(secret, "utf8") : processKey();
  return createHmac("sha256", key)
    .update(`${hold_id}\n${read_token_at}\n${read_token}`, "utf8")
    .digest("base64url");
}

/* ── 4 · Verifying ─────────────────────────────────────────────────────────── */

/** What a `hold` row carries, and what the caller presented. */
export interface ReadTokenCheck {
  readonly hold_id: string;
  /** The token the Agent presented. Absent is a refusal, per T4's REQUIRES. */
  readonly read_token: string | null | undefined;
  readonly stored_hmac: string | null | undefined;
  readonly read_token_at: Rfc3339 | null | undefined;
  /** The **current** server instant, from the database. */
  readonly server_time: Rfc3339;
}

/**
 * True where the presented token is the one this Hold's last `get_hold` minted
 * and that read is still inside the window. Never throws; see
 * {@link requireFreshReadToken} for the refusing form.
 *
 * A read dated in the future is not fresh either — `age < 0` is a clock that
 * moved backwards between two readings of the same source, and treating it as
 * "very fresh" would make a token valid forever after one such step.
 */
export function readTokenIsFresh(check: ReadTokenCheck, ttl_ms: DurationMs = READ_TOKEN_TTL_MS, secret?: string): boolean {
  const { hold_id, read_token, stored_hmac, read_token_at, server_time } = check;
  if (typeof read_token !== "string" || !READ_TOKEN_PATTERN.test(read_token)) return false;
  if (typeof stored_hmac !== "string" || stored_hmac.length === 0) return false;
  if (typeof read_token_at !== "string" || read_token_at.length === 0) return false;

  const age = elapsedMs(read_token_at, server_time);
  if (!Number.isFinite(age) || age < 0 || age > ttl_ms) return false;

  const expected = Buffer.from(readTokenHmac(hold_id, read_token_at, read_token, secret), "utf8");
  const presented = Buffer.from(stored_hmac, "utf8");
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

/**
 * T4's mechanism, at the one call site that needs it: `hand_off` (CORE-004).
 *
 * Throws `409 stale_read` — remediation `re_read` — where the token is missing,
 * unrecognised, or older than the window. One refusal for all three, because
 * distinguishing them would tell a caller which of its guesses was closer, and
 * the remediation is identical in every case: call `get_hold` again.
 */
export function requireFreshReadToken(
  check: ReadTokenCheck,
  ttl_ms: DurationMs = READ_TOKEN_TTL_MS,
  secret?: string,
): void {
  if (readTokenIsFresh(check, ttl_ms, secret)) return;
  throw refuse(
    "stale_read",
    "This hold has not been read recently enough to hand off. Call get_hold and present the read_token it returns.",
  );
}
