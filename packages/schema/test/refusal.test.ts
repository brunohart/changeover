/**
 * The refusal taxonomy, at unit level.
 *
 * `scripts/prove_refusals_closed.sh` asserts the module against the two frozen
 * authorities — SPEC.md §6.3 and schemas/refusal.schema.json. These tests assert the
 * things a schema cannot: what the constructor REFUSES to build, what `refuse()`
 * defaults to, and that a refusal thrown from one module instance is still recognised
 * by a binding that imported another.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  AXIS,
  DETAIL_BEARING_CODES,
  DETAIL_FREE_CODES,
  PROSE_MAX_LENGTH,
  REFUSAL_CODE,
  REFUSAL_CODES,
  REFUSAL_DETAIL_SHAPE,
  REFUSAL_REMEDIATION,
  REFUSAL_RETRYABILITY,
  REFUSAL_STATUS,
  REMEDIATIONS,
  Refusal,
  RefusalShapeError,
  carriesDetail,
  isRefusal,
  isRefusalCode,
  isRetryable,
  refuse,
  wantsRetryAfterMs,
} from "../src/refusal.ts";

const SERVER_TIME = "2026-08-29T09:20:04.887Z";

/* ── the closed set ────────────────────────────────────────────────────────── */

test("the code set is closed at 32 and REFUSAL_CODES is frozen", () => {
  assert.equal(REFUSAL_CODES.length, 32);
  assert.equal(new Set(REFUSAL_CODES).size, 32);
  assert.ok(Object.isFrozen(REFUSAL_CODES));
});

test("there is no escape hatch: no code named other, unknown, custom or internal", () => {
  for (const forbidden of ["other", "unknown", "custom", "internal", "error"]) {
    assert.equal(isRefusalCode(forbidden), false, `${forbidden} must not be a code`);
  }
});

test("every code has a status, a retryability and a default remediation", () => {
  for (const code of REFUSAL_CODES) {
    assert.equal(typeof REFUSAL_STATUS[code], "number", code);
    assert.equal(typeof REFUSAL_RETRYABILITY[code], "string", code);
    assert.ok(REMEDIATIONS.includes(REFUSAL_REMEDIATION[code]), code);
  }
});

test("the detail partition is total and disjoint over all 32 codes", () => {
  assert.equal(DETAIL_BEARING_CODES.length, 11);
  assert.equal(DETAIL_FREE_CODES.length, 21);
  assert.equal(new Set([...DETAIL_BEARING_CODES, ...DETAIL_FREE_CODES]).size, 32);
  for (const code of DETAIL_BEARING_CODES) assert.ok(carriesDetail(code), code);
  for (const code of DETAIL_FREE_CODES) assert.equal(carriesDetail(code), false, code);
});

test("retryability helpers agree with the table", () => {
  assert.equal(isRetryable(REFUSAL_CODE.hold_not_live), false);
  assert.equal(isRetryable(REFUSAL_CODE.seat_contended), true);
  assert.equal(wantsRetryAfterMs(REFUSAL_CODE.rate_limited), true);
  // The one that is easy to get wrong: retryable ONLY with the identical key.
  assert.equal(REFUSAL_RETRYABILITY.idempotency_in_flight, "same_key");
  assert.equal(REFUSAL_REMEDIATION.idempotency_in_flight, "retry_same_key");
  assert.equal(wantsRetryAfterMs(REFUSAL_CODE.idempotency_in_flight), true);
  assert.equal(wantsRetryAfterMs(REFUSAL_CODE.seat_contended), false);
});

/* ── the document ──────────────────────────────────────────────────────────── */

test("toDocument emits exactly the required members for a detail-free code", () => {
  const document = refuse("hold_not_live", "That hold has already ended.").toDocument(SERVER_TIME);
  assert.deepEqual(Object.keys(document).sort(), ["code", "reason", "refused", "remediation", "server_time"]);
  assert.equal(document.refused, true);
  assert.equal(document.code, "hold_not_live");
  assert.deepEqual(document.reason, { content_type: "text/plain", value: "That hold has already ended." });
  assert.equal(document.server_time, SERVER_TIME);
});

test("there is no free-text suggestion member — an Agent derives its action from code and remediation only", () => {
  const document = refuse("seat_contended", "Those seats went elsewhere.", { detail: { seat_ids: ["F:11"] } }).toDocument(SERVER_TIME);
  assert.equal("suggestion" in document, false);
  assert.equal("hint" in document, false);
  assert.equal("instruction" in document, false);
});

test("reason is carried as a prose envelope and clamped to the schema bound", () => {
  const document = refuse("hold_not_live", "x".repeat(PROSE_MAX_LENGTH + 500)).toDocument(SERVER_TIME);
  assert.equal(document.reason.content_type, "text/plain");
  assert.equal(document.reason.value.length, PROSE_MAX_LENGTH);
});

test("server_time is projected at render time, not captured at construction", () => {
  const r = refuse("upstream_unavailable", "The exhibitor system did not answer.", { retry_after_ms: 5000 });
  const early = r.toDocument("2026-08-29T09:20:04.887Z");
  const late = r.toDocument("2026-08-29T09:25:00.000Z");
  assert.notEqual(early.server_time, late.server_time);
  assert.deepEqual({ ...early, server_time: null }, { ...late, server_time: null });
});

test("a detail-bearing code carries its branch through to the document", () => {
  const document = refuse("cluster_fanout", "A live hold already exists in this demand cluster.", {
    detail: { conflicting_hold_id: "hold_4ZZQCSHNJ2NN5ZRJW94NRCWHXYCWBW1P", cluster: "the-conversation-wlg-2026-w35", limit: 1 },
    retry_after_ms: 0,
  }).toDocument(SERVER_TIME);
  assert.equal(document.remediation, "release_conflicting_hold");
  assert.deepEqual(document.detail, { conflicting_hold_id: "hold_4ZZQCSHNJ2NN5ZRJW94NRCWHXYCWBW1P", cluster: "the-conversation-wlg-2026-w35", limit: 1 });
  assert.equal(document.retry_after_ms, 0);
});

/* ── refuse() ──────────────────────────────────────────────────────────────── */

test("refuse defaults remediation from the code, and a caller may override it", () => {
  assert.equal(refuse("stale_read", "Read token is stale.").remediation, "re_read");
  assert.equal(refuse("stale_read", "Read token is stale.", { remediation: "re_resolve" }).remediation, "re_resolve");
});

test("refuse rejects a remediation outside the closed set", () => {
  assert.throws(
    () => refuse("hold_not_live", "x", { remediation: "just_buy_it" as never }),
    RefusalShapeError,
  );
});

test("refuse rejects a code outside the closed set at runtime, not only at compile time", () => {
  // Cast through the erased signature: a Server assembling a code from a row or a
  // catch has no literal for TypeScript to check, and the closure must still hold.
  const untyped = refuse as unknown as (code: string, reason: string) => unknown;
  assert.throws(() => untyped("settlement_declined", "x"), RefusalShapeError);
});

/* ── what the constructor refuses to build ─────────────────────────────────── */

test("a code declaring detail: false cannot be constructed with a detail", () => {
  for (const code of DETAIL_FREE_CODES) {
    assert.throws(
      () => new Refusal(code, REFUSAL_REMEDIATION[code], "x", { detail: { seat_ids: ["F:11"] } } as never),
      RefusalShapeError,
      code,
    );
  }
});

test("a detail-bearing code cannot be constructed with its detail omitted", () => {
  for (const code of DETAIL_BEARING_CODES) {
    assert.throws(() => new Refusal(code, REFUSAL_REMEDIATION[code], "x", {} as never), RefusalShapeError, code);
  }
});

test("a detail missing a member its branch requires is refused", () => {
  assert.throws(() => refuse("substitution_refused", "x", { detail: { crossed_axis: AXIS.presentation_class } as never }), RefusalShapeError);
  assert.throws(() => refuse("hold_expired", "x", { detail: { expired_at: SERVER_TIME } as never }), RefusalShapeError);
});

test("a detail carrying any member outside its branch is refused — additionalProperties: false, enforced at construction", () => {
  assert.throws(
    () => refuse("seat_rule_violated", "x", { detail: { rule: "no_singleton_gap", suggestion: "buy it" } as never }),
    RefusalShapeError,
  );
});

test("an optional branch member is permitted and a required one is not merely optional", () => {
  const withOptional = refuse("seat_rule_violated", "x", { detail: { rule: "no_singleton_gap", suggested_seats: ["F:12", "F:13"] } });
  assert.deepEqual(withOptional.detail, { rule: "no_singleton_gap", suggested_seats: ["F:12", "F:13"] });
  assert.deepEqual(REFUSAL_DETAIL_SHAPE.seat_rule_violated.optional, ["suggested_seats"]);
});

test("detail must be an object, never an array or a scalar", () => {
  assert.throws(() => refuse("occasion_moved", "x", { detail: ["/screening/starts_at"] as never }), RefusalShapeError);
  assert.throws(() => refuse("occasion_moved", "x", { detail: "moved" as never }), RefusalShapeError);
});

test("retry_after_ms must be a non-negative integer of milliseconds", () => {
  assert.throws(() => refuse("rate_limited", "x", { retry_after_ms: -1 }), RefusalShapeError);
  assert.throws(() => refuse("rate_limited", "x", { retry_after_ms: 1.5 }), RefusalShapeError);
  assert.equal(refuse("rate_limited", "x", { retry_after_ms: 0 }).retry_after_ms, 0);
});

/* ── how a binding catches it ──────────────────────────────────────────────── */

test("a Refusal is an Error, is thrown, and carries its status and retryability", () => {
  try {
    throw refuse("occasion_moved", "The occasion moved.", { detail: { changed_paths: ["/screening/starts_at"] } });
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.ok(isRefusal(err));
    assert.equal(err.status, 412);
    assert.equal(err.retryability, "after_re_resolve");
    assert.equal(err.message, "The occasion moved.");
    return;
  }
});

test("isRefusal is false for an ordinary Error and for a RefusalShapeError — a server defect is a 500, not a wire refusal", () => {
  assert.equal(isRefusal(new Error("boom")), false);
  assert.equal(isRefusal(new RefusalShapeError("hold_not_live", "boom")), false);
  assert.equal(isRefusal(undefined), false);
  assert.equal(isRefusal({ refused: true, code: "hold_not_live" }), false);
});

test("isRefusal recognises a branded refusal from another module instance", async () => {
  const specifier = "../src/refusal.ts?realm=binding";
  const other = (await import(specifier)) as typeof import("../src/refusal.ts");
  const fromOther = other.refuse("hold_not_found", "No such hold for this principal.");
  assert.equal(fromOther instanceof Refusal, false, "precondition: a second instance is a different class");
  assert.equal(isRefusal(fromOther), true);
});

test("the status map is the one a binding renders — 409 for contention, 429 for exhaustion, 503 for upstream", () => {
  assert.equal(REFUSAL_STATUS.seat_contended, 409);
  assert.equal(REFUSAL_STATUS.hold_budget_exhausted, 429);
  assert.equal(REFUSAL_STATUS.upstream_unavailable, 503);
  assert.equal(REFUSAL_STATUS.profile_not_supported, 501);
  assert.equal(REFUSAL_STATUS.claim_expired, 410);
  assert.equal(REFUSAL_STATUS.idempotency_key_reused, 422);
});
