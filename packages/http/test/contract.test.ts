/**
 * The header arithmetic, the URN, the route table and the scope strip — as
 * units, before any of them is put behind a socket.
 *
 * These are the four rules of §6.3 that are pure functions, and a pure function
 * is where an off-by-one is cheapest to find. `binding.test.ts` then asserts the
 * same rules end to end, because a correct `ceil()` that nothing calls is not a
 * `Retry-After` header.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DETAIL_BEARING_CODES,
  DETAIL_FREE_CODES,
  REFUSAL_CODES,
  REFUSAL_STATUS,
  refuse,
} from "@changeover/schema/refusal.ts";

import {
  ifMatchMatches,
  maxAge,
  occasionMaxAgeSeconds,
  quoteEtag,
  retryAfterSeconds,
  unquoteEtag,
} from "../src/headers.ts";
import {
  ABOUT_BLANK,
  RFC9457_MEMBERS,
  codeOfUrn,
  problemOf,
  refusalDocumentOf,
  refusalUrn,
} from "../src/problem.ts";
import { ROUTES, lookup } from "../src/routes.ts";
import { SCOPE_BEARING_MEMBERS, bearerToken, stripScopeBearing } from "../src/credential.ts";

const SERVER_TIME = "2026-08-29T19:00:00+12:00";

/* -- Retry-After ------------------------------------------------------------ */

test("Retry-After is ceil(retry_after_ms / 1000), which is where the rule bites", () => {
  // A 400 ms backoff truncates to 0 - a hammer, honoured instantly by any
  // intermediary that reads the header.
  assert.equal(retryAfterSeconds(400), 1);
  assert.equal(retryAfterSeconds(1), 1);
  assert.equal(retryAfterSeconds(1000), 1);
  assert.equal(retryAfterSeconds(1001), 2);
  // 1400 ms is the case two implementations disagree on: 1 by truncation,
  // 2 by ceiling, and only one of them is in the specification.
  assert.equal(retryAfterSeconds(1400), 2);
  assert.equal(retryAfterSeconds(2500), 3);
  assert.equal(retryAfterSeconds(0), 0);
});

test("Retry-After refuses a negative or non-finite duration rather than emitting one", () => {
  assert.throws(() => retryAfterSeconds(-1), RangeError);
  assert.throws(() => retryAfterSeconds(Number.NaN), RangeError);
});

/* -- Cache-Control ---------------------------------------------------------- */

test("Cache-Control on an Occasion is min(max_staleness_ms/1000, 30), floored", () => {
  assert.equal(occasionMaxAgeSeconds(30000), 30);
  assert.equal(occasionMaxAgeSeconds(5000), 5);
  assert.equal(occasionMaxAgeSeconds(600000), 30, "the 30 s ceiling is hard");
  assert.equal(occasionMaxAgeSeconds(0), 0);
  // 1500 ms is either 1 or 2 and only 1 is honest: caching for two seconds a
  // document the publisher disowns after one and a half serves a stale Occasion.
  assert.equal(occasionMaxAgeSeconds(1500), 1);
  assert.equal(maxAge(5), "max-age=5");
});

/* -- The etag, quoted and unquoted ------------------------------------------ */

const WIRE = "1:XB7PZvK6GJP0BY4IPzKdmuCc-R5RaivznwPz_KDY-04";

test("the wire etag is unquoted and the header form is quoted, and they round-trip", () => {
  assert.equal(quoteEtag(WIRE), `"${WIRE}"`);
  assert.equal(unquoteEtag(quoteEtag(WIRE)), WIRE);
  assert.equal(unquoteEtag(` "${WIRE}" `), WIRE, "surrounding whitespace is not part of the tag");
});

test("an unquoted or weak If-Match never matches, because RFC 9110 §13.1.1 is strong comparison", () => {
  assert.equal(unquoteEtag(WIRE), null, "a bare value is not an entity-tag");
  assert.equal(unquoteEtag(`W/"${WIRE}"`), null, "a weak validator cannot satisfy If-Match");
  assert.equal(ifMatchMatches(`W/"${WIRE}"`, WIRE), false);
  assert.equal(ifMatchMatches(quoteEtag(WIRE), WIRE), true);
  assert.equal(ifMatchMatches(`"other", ${quoteEtag(WIRE)}`, WIRE), true, "a list matches on any member");
  assert.equal(ifMatchMatches("*", WIRE), true);
  assert.equal(ifMatchMatches('"1:nope"', WIRE), false);
});

/* -- The URN ---------------------------------------------------------------- */

test("every one of the 32 codes has a URN type, and the URN maps back to it", () => {
  assert.equal(REFUSAL_CODES.length, 32);
  for (const code of REFUSAL_CODES) {
    const urn = refusalUrn(code);
    assert.match(urn, /^urn:changeover:refusal:[a-z_]+$/);
    assert.equal(codeOfUrn(urn), code);
  }
  assert.equal(codeOfUrn("https://changeover.dev/refusal/seat_contended"), null);
  assert.equal(codeOfUrn("urn:changeover:refusal:not_a_code"), null);
  assert.equal(codeOfUrn(ABOUT_BLANK), null);
});

test("a problem body is the refusal document plus exactly three members, and no more", () => {
  const refusal = refuse("seat_contended", "Those seats went to another hold.", {
    detail: { seat_ids: ["F:11"] },
  });
  const document = refusal.toDocument(SERVER_TIME);
  const problem = problemOf(document);

  assert.equal(problem.type, "urn:changeover:refusal:seat_contended");
  assert.equal(problem.status, REFUSAL_STATUS.seat_contended);
  assert.equal(problem.title, "seat_contended");

  const added = Object.keys(problem).filter((m) => !Object.hasOwn(document, m));
  assert.deepEqual(added.sort(), [...RFC9457_MEMBERS].sort());
  // RFC 9457's own `detail` is a human-readable string. This document's `detail`
  // is a closed machine-readable branch. The name is taken, which is exactly why
  // the ruling is three members and not four.
  assert.deepEqual(problem.detail, { seat_ids: ["F:11"] });
  assert.deepEqual(refusalDocumentOf(problem), document);
});

test("the status comes from the code, so no call site can choose one", () => {
  // The detail-free codes are the ones a loop can construct; a detail-bearing
  // code without its branch is a construction-time throw, which is the schema
  // module doing its job and not this one's to route around.
  assert.equal(DETAIL_FREE_CODES.length + DETAIL_BEARING_CODES.length, REFUSAL_CODES.length);
  for (const code of DETAIL_FREE_CODES) {
    const refusal = refuse(code as "hold_not_live", "reason");
    const problem = problemOf(refusal.toDocument(SERVER_TIME));
    assert.equal(problem.status, REFUSAL_STATUS[code], code);
    assert.equal(problem.type, refusalUrn(code));
    assert.equal(problem.detail, undefined, `${code} is declared detail: false`);
  }
});

/* -- The route table -------------------------------------------------------- */

test("the table is nine routes, and If-Match is valid on exactly one of them", () => {
  assert.equal(ROUTES.length, 9);
  const conditional = ROUTES.filter((r) => r.if_match);
  assert.deepEqual(conditional.map((r) => r.name), ["get_occasion"]);
  assert.equal(conditional[0]?.pattern, "/changeover/v0/occasions/{occasion_id}");
  const holds = ROUTES.filter((r) => r.pattern.startsWith("/changeover/v0/holds"));
  assert.equal(holds.length, 5);
  assert.ok(holds.every((r) => r.hold_verb), "every /holds route is a hold verb at Profile 0");
  assert.deepEqual(ROUTES.filter((r) => r.surface === "operator").map((r) => r.name), ["revoke"]);
});

test("the router separates a wrong method from an absent path", () => {
  const matched = lookup("GET", "/changeover/v0/holds/hold_ABC");
  assert.equal(matched.outcome, "matched");
  if (matched.outcome === "matched") {
    assert.equal(matched.match.route.name, "get_hold");
    assert.equal(matched.match.params.hold_id, "hold_ABC");
  }

  const wrong = lookup("PUT", "/changeover/v0/holds/hold_ABC");
  assert.equal(wrong.outcome, "method_not_allowed");
  if (wrong.outcome === "method_not_allowed") {
    assert.deepEqual([...wrong.allow].sort(), ["DELETE", "GET"]);
  }

  assert.equal(lookup("GET", "/changeover/v0/nope").outcome, "no_route");
  assert.equal(lookup("GET", "//changeover/v0/occasions").outcome, "no_route");
  assert.equal(
    lookup("GET", "/changeover/v0/occasions/").outcome,
    "matched",
    "a trailing slash on the collection is the collection",
  );
});

/* -- Scope ------------------------------------------------------------------ */

test("a scope-bearing member is deleted from the body, not outranked in a merge", () => {
  const body = {
    occasion_id: "occ_1",
    agent_id: "agt_impostor",
    principal_scope: "prin_elsewhere",
    profile: "1",
    seats: ["A:1"],
  };
  const stripped = stripScopeBearing(body);

  for (const member of SCOPE_BEARING_MEMBERS) {
    assert.equal(Object.hasOwn(stripped.body, member), false, `${member} survived the strip`);
  }
  assert.deepEqual([...stripped.ignored], ["agent_id", "principal_scope", "profile"]);
  assert.deepEqual(stripped.body, { occasion_id: "occ_1", seats: ["A:1"] });
  // The caller's object is untouched: a strip that mutated its input would make
  // the digest depend on whether idempotency ran before or after it.
  assert.equal(body.agent_id, "agt_impostor");
});

test("Bearer is parsed case-insensitively on the scheme and not on the token", () => {
  assert.deepEqual(bearerToken("Bearer tok_1"), { present: true, token: "tok_1" });
  assert.deepEqual(bearerToken("bearer tok_1"), { present: true, token: "tok_1" });
  assert.deepEqual(bearerToken("BEARER tok_1"), { present: true, token: "tok_1" });
  assert.deepEqual(bearerToken("Basic tok_1"), { present: false });
  assert.deepEqual(bearerToken("Bearer "), { present: false });
  assert.deepEqual(bearerToken(undefined), { present: false });
});
