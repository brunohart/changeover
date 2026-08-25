/**
 * T4's mechanism. CORE-003.
 *
 * `hand_off` is CORE-004's verb and it is the one caller of
 * `requireFreshReadToken`; these assertions pin the mechanism it will call, so
 * that "a fresh read_token" means one thing rather than one thing per binding.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  READ_TOKEN_PATTERN,
  READ_TOKEN_TTL_MS,
  mintReadToken,
  readTokenIsFresh,
  requireFreshReadToken,
} from "../src/read-token.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";

const HOLD = "hold_0000000000000000000000000000000A";
const OTHER = "hold_0000000000000000000000000000000B";
const AT = "2026-08-29T19:00:00.000+12:00";
const SOON = "2026-08-29T19:00:05.000+12:00";
const LATE = "2026-08-29T19:05:00.000+12:00";
const SECRET = "a deployment secret";

function check(overrides: Record<string, unknown> = {}) {
  const minted = mintReadToken(HOLD, AT, { secret: SECRET });
  return {
    hold_id: HOLD,
    read_token: minted.read_token,
    stored_hmac: minted.read_token_hmac,
    read_token_at: minted.read_token_at,
    server_time: SOON,
    ...overrides,
  };
}

test("a minted token matches the pattern hold.schema.json declares", () => {
  const minted = mintReadToken(HOLD, AT, { secret: SECRET });
  assert.match(minted.read_token, READ_TOKEN_PATTERN);
  assert.equal(minted.read_token_at, AT, "the token is bound to that read's server_time");
  assert.notEqual(minted.read_token_hmac, minted.read_token, "the token itself is never stored");
});

test("two mints of one Hold at one instant are different tokens", () => {
  const a = mintReadToken(HOLD, AT, { secret: SECRET });
  const b = mintReadToken(HOLD, AT, { secret: SECRET });
  assert.notEqual(a.read_token, b.read_token);
});

test("a token minted by this read is fresh at this read", () => {
  assert.equal(readTokenIsFresh(check(), READ_TOKEN_TTL_MS, SECRET), true);
});

test("a token older than the window is not fresh", () => {
  assert.equal(readTokenIsFresh(check({ server_time: LATE }), READ_TOKEN_TTL_MS, SECRET), false);
});

test("a token from another Hold is not fresh for this one", () => {
  const foreign = mintReadToken(OTHER, AT, { secret: SECRET });
  assert.equal(
    readTokenIsFresh(check({ read_token: foreign.read_token }), READ_TOKEN_TTL_MS, SECRET),
    false,
  );
});

test("a stored hmac cannot be re-dated to buy freshness", () => {
  // `read_token_at` is inside the HMAC message, so moving the column forward
  // invalidates the digest sitting beside it.
  assert.equal(readTokenIsFresh(check({ read_token_at: SOON }), READ_TOKEN_TTL_MS, SECRET), false);
});

test("a read dated in the future is not fresh either", () => {
  assert.equal(
    readTokenIsFresh(check({ server_time: "2026-08-29T18:59:00.000+12:00" }), READ_TOKEN_TTL_MS, SECRET),
    false,
  );
});

test("absence is a refusal, because hand_off REQUIRES the token", () => {
  for (const missing of [null, undefined, "", "short"]) {
    assert.equal(readTokenIsFresh(check({ read_token: missing }), READ_TOKEN_TTL_MS, SECRET), false);
  }
  assert.equal(readTokenIsFresh(check({ stored_hmac: null }), READ_TOKEN_TTL_MS, SECRET), false);
});

test("requireFreshReadToken throws 409 stale_read with a re_read remediation", () => {
  assert.doesNotThrow(() => requireFreshReadToken(check(), READ_TOKEN_TTL_MS, SECRET));
  assert.throws(
    () => requireFreshReadToken(check({ server_time: LATE }), READ_TOKEN_TTL_MS, SECRET),
    (err: unknown) =>
      isRefusal(err) && err.code === "stale_read" && err.status === 409 && err.remediation === "re_read",
  );
});
