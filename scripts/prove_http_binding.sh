#!/usr/bin/env bash
# C-REFUSE / C-PROFILE0 / C-CLOCK, at the HTTP boundary. Asserts that the nine
# routes of SPEC.md 6.3 answer over a real socket and that the four header rules
# hold on the bytes: the URN type, Changeover-Server-Time, ceil() on Retry-After,
# and min(max_staleness_ms/1000, 30) on an Occasion.
#
# The cheaper check would be to call handle() and inspect the object it returns.
# That would pass with a node:http adapter that dropped every header it was
# given, because the header contract is a claim about what an intermediary sees
# and an intermediary sees bytes. Everything below goes through fetch().
#
# Two assertions count ROWS rather than responses, because the response is the
# thing under test: a refused If-Match that had already granted a Hold answers
# 400 either way, and a merged scope that happened to agree with its token
# answers 201 either way.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/http/src/server.ts ]       || { echo "cannot prove — packages/http/src/server.ts missing"; exit 2; }
[ -f packages/http/test/lib/http-bench.ts ] || { echo "cannot prove — packages/http/test/lib/http-bench.ts missing; it seeds the estate this proof reads"; exit 2; }
[ -f fixtures/golden/occasion-embassy-sat-1900.json ] || { echo "cannot prove — fixtures/golden/occasion-embassy-sat-1900.json missing; the bench derives its Occasions from it"; exit 2; }

node --input-type=module -e '
import { REFUSAL_STATUS } from "@changeover/schema/refusal.ts";
import { ROUTES } from "./packages/http/src/routes.ts";
import { codeOfUrn } from "./packages/http/src/problem.ts";
import { occasionMaxAgeSeconds, retryAfterSeconds } from "./packages/http/src/headers.ts";
import {
  AGENT_TOKEN, OPERATOR_TOKEN, OTHER_TOKEN,
  ETAG_A, OCCASION_A, OCCASION_B,
  call, holdBody, httpBench, key,
} from "./packages/http/test/lib/http-bench.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };
const is  = (actual, expected, m) =>
  actual === expected ? ok(m) : bad(m + " (expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual) + ")");

const STALE_ETAG = "1:0000000000000000000000000000000000000000000";

const serverTimeOk = (r) => {
  const t = r.headers.get("changeover-server-time");
  return typeof t === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/.test(t);
};

const bench = await httpBench();
let legible = null;
let throttled = null;

try {
  /* 1 — the table itself ------------------------------------------------- */

  is(ROUTES.length, 9, "the route table is nine routes and no more");

  /* 2 — every route answers, over a socket, with a server time ----------- */

  const held = await call(bench, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": key("proof-walk") },
    body: holdBody(["A:1", "A:2"]),
  });
  if (held.status !== 201) bad("could not grant a Hold to walk the routes with: " + held.status + " " + held.text.slice(0, 200));
  const hold_id = held.json?.hold_id;
  const read = await call(bench, "GET", "/changeover/v0/holds/" + hold_id, { token: AGENT_TOKEN });

  const calls = {
    capability: () => call(bench, "GET", "/.well-known/changeover"),
    delegation: () => call(bench, "GET", "/.well-known/changeover/delegation.json"),
    resolve_occasions: () => call(bench, "GET", "/changeover/v0/occasions", { token: AGENT_TOKEN }),
    get_occasion: () => call(bench, "GET", "/changeover/v0/occasions/" + OCCASION_A, { token: AGENT_TOKEN }),
    hold_seats: () => call(bench, "POST", "/changeover/v0/holds", {
      token: AGENT_TOKEN,
      headers: { "Idempotency-Key": key("proof-hold") },
      body: holdBody(["A:5"]),
    }),
    get_hold: () => call(bench, "GET", "/changeover/v0/holds/" + hold_id, { token: AGENT_TOKEN }),
    hand_off: () => call(bench, "POST", "/changeover/v0/holds/" + hold_id + "/hand-off", {
      token: AGENT_TOKEN,
      headers: { "Idempotency-Key": key("proof-off") },
      body: { read_token: read.json?.read_token },
    }),
    revoke: () => call(bench, "POST", "/changeover/v0/holds/" + hold_id + "/revoke", {
      token: OPERATOR_TOKEN,
      body: { revocation_reason: "venue_operations" },
    }),
    release_hold: () => call(bench, "DELETE", "/changeover/v0/holds/" + hold_id, { token: AGENT_TOKEN }),
  };

  const named = Object.keys(calls).sort().join(",");
  const tabled = ROUTES.map((r) => r.name).sort().join(",");
  is(named, tabled, "this proof exercises exactly the routes the table declares");

  let answered = 0, stamped = 0;
  for (const route of ROUTES) {
    const response = await calls[route.name]();
    const routed = response.status < 500 && response.json?.type !== "about:blank";
    if (routed) answered++; else bad(route.name + " did not answer: " + response.status);
    if (serverTimeOk(response)) stamped++; else bad(route.name + " carried no Changeover-Server-Time");
  }
  is(answered, 9, "all nine routes answer over a socket");
  is(stamped, 9, "every one of the nine stamps Changeover-Server-Time");

  /* 3 — every refusal is problem+json with a URN naming its own code ------ */

  await bench.reset();
  const refusals = [
    ["no credential", "not_authorised", () => call(bench, "GET", "/changeover/v0/occasions")],
    ["unknown Occasion", "occasion_not_found", () => call(bench, "GET", "/changeover/v0/occasions/occ_nope", { token: AGENT_TOKEN })],
    ["unknown Hold", "hold_not_found", () => call(bench, "GET", "/changeover/v0/holds/hold_00000000000000000000000000000000", { token: AGENT_TOKEN })],
    ["an agent on the operator surface", "not_authorised", () => call(bench, "POST", "/changeover/v0/holds/hold_X/revoke", { token: AGENT_TOKEN, body: { revocation_reason: "safety" } })],
    ["a stale conditional on an Occasion", "occasion_moved", () => call(bench, "GET", "/changeover/v0/occasions/" + OCCASION_A, { token: AGENT_TOKEN, headers: { "If-Match": JSON.stringify(STALE_ETAG) } })],
    ["a window wider than published", "window_too_wide", () => call(bench, "GET", "/changeover/v0/occasions?from=2026-01-01T00:00:00%2B12:00&to=2030-01-01T00:00:00%2B12:00", { token: AGENT_TOKEN })],
  ];

  let problems = 0, urns = 0, statuses = 0, timed = 0;
  for (const [where, code, run] of refusals) {
    const r = await run();
    if (r.headers.get("content-type") === "application/problem+json") problems++;
    else bad(where + " was not application/problem+json");

    if (r.json?.code === code && r.json?.type === "urn:changeover:refusal:" + code && codeOfUrn(r.json?.type) === code) urns++;
    else bad(where + " typed itself " + JSON.stringify(r.json?.type) + " for code " + JSON.stringify(r.json?.code));

    if (r.status === REFUSAL_STATUS[code] && r.json?.status === r.status) statuses++;
    else bad(where + " answered " + r.status + " for " + code);

    if (serverTimeOk(r)) timed++; else bad(where + " carried no Changeover-Server-Time");
  }
  is(problems, refusals.length, "every refusal is application/problem+json");
  is(urns, refusals.length, "every refusal type is a URN naming its own code");
  is(statuses, refusals.length, "every refusal status is the one SPEC.md 6.3 fixes for its code");
  is(timed, refusals.length, "every refusal stamps Changeover-Server-Time");

  const unrouted = await call(bench, "GET", "/changeover/v0/nope");
  const blank = unrouted.status === 404 &&
    unrouted.headers.get("content-type") === "application/problem+json" &&
    unrouted.json?.type === "about:blank" && unrouted.json?.code === undefined &&
    serverTimeOk(unrouted);
  blank
    ? ok("an unrouted path is about:blank with no code, because the taxonomy is closed")
    : bad("an unrouted path invented a refusal code or was not problem+json");

  /* 4 — Retry-After ------------------------------------------------------- */

  throttled = await httpBench({
    overrides: { rate_limit: { check(_k, route) { return route.name === "resolve_occasions" ? 1400 : null; } } },
  });
  const limited = await call(throttled, "GET", "/changeover/v0/occasions", { token: AGENT_TOKEN });
  is(limited.json?.retry_after_ms, 1400, "the refusal carries retry_after_ms, which is the normative value");
  is(limited.headers.get("retry-after"), String(retryAfterSeconds(1400)), "Retry-After is ceil(retry_after_ms/1000) — 1400 ms is 2 s, not 1");

  /* 5 — Cache-Control on an Occasion -------------------------------------- */

  const a = await call(bench, "GET", "/changeover/v0/occasions/" + OCCASION_A, { token: AGENT_TOKEN });
  const b = await call(bench, "GET", "/changeover/v0/occasions/" + OCCASION_B, { token: AGENT_TOKEN });
  is(a.json?.availability?.max_staleness_ms, 30000, "Occasion A publishes a 30 s staleness budget");
  is(a.headers.get("cache-control"), "max-age=" + occasionMaxAgeSeconds(30000),
     "Cache-Control on Occasion A is min(max_staleness_ms/1000, 30)");
  is(b.json?.availability?.max_staleness_ms, 5000, "Occasion B publishes a 5 s staleness budget");
  is(b.headers.get("cache-control"), "max-age=" + occasionMaxAgeSeconds(5000),
     "Cache-Control on Occasion B is min(max_staleness_ms/1000, 30), and the min has a bite");

  const page = await call(bench, "GET", "/changeover/v0/occasions", { token: AGENT_TOKEN });
  is(page.headers.get("cache-control"), "max-age=5", "a page of Occasions is no fresher than the stalest budget in it");

  /* 6 — the etag, quoted on the header and unquoted on the wire ----------- */

  is(a.headers.get("etag"), JSON.stringify(ETAG_A), "the ETag header is the quoted strong entity-tag");
  is(a.json?.etag, ETAG_A, "the wire etag in the document is the unquoted form");

  const matched = await call(bench, "GET", "/changeover/v0/occasions/" + OCCASION_A, {
    token: AGENT_TOKEN, headers: { "If-Match": JSON.stringify(ETAG_A) },
  });
  is(matched.status, 200, "a quoted If-Match round-trips against the unquoted wire etag");

  const movedDetail = await call(bench, "GET", "/changeover/v0/occasions/" + OCCASION_A, {
    token: AGENT_TOKEN, headers: { "If-Match": JSON.stringify(STALE_ETAG) },
  });
  Array.isArray(movedDetail.json?.detail?.changed_paths)
    ? ok("occasion_moved carries its closed detail branch, changed_paths")
    : bad("occasion_moved carried no changed_paths");

  /* 7 — If-Match on POST /holds is refused, not honoured ------------------ */

  await bench.reset();
  const conditional = await call(bench, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    // The etag is CORRECT. A binding that honoured the header would let this
    // through, and the divergence would surface only at an intermediary
    // evaluating the condition against the hold collection (RFC 9110 13.1.1).
    headers: { "Idempotency-Key": key("proof-ifmatch"), "If-Match": JSON.stringify(ETAG_A) },
    body: holdBody(["A:9"]),
  });
  is(conditional.status, 400, "If-Match on POST /holds is refused rather than honoured");
  is(conditional.json?.code, "schema_validation", "and it is refused as schema_validation");
  const after = await bench.db.query("select count(*)::text as n from hold");
  is(Number(after.rows[0]?.n), 0, "and the refused conditional wrote no Hold row");

  /* 8 — scope is refilled from the token, never merged -------------------- */

  await bench.reset();
  // The token is the OTHER agent at prin_auckland. The body claims to be the
  // reference agent at prin_wellington. A merge in which the credential won
  // would also answer 201 with the right agent_id, so the row is what decides.
  const scoped = await call(bench, "POST", "/changeover/v0/holds", {
    token: OTHER_TOKEN,
    headers: { "Idempotency-Key": key("proof-scope") },
    body: holdBody(["A:14"], {
      agent_id: "agt_reference",
      principal_scope: "prin_wellington",
      profile: "1",
      site_id: "site_elsewhere",
    }),
  });
  is(scoped.status, 201, "a body carrying scope members is accepted, with those members ignored");
  is(scoped.json?.agent_id, "agt_other", "the granted Hold carries the tokens agent_id, not the bodys");
  const row = await bench.db.query(
    "select agent_id, principal_scope from hold where hold_id = $1", [scoped.json?.hold_id],
  );
  is(row.rows[0]?.principal_scope, "prin_auckland", "and the store row carries the tokens principal_scope");
  const stolen = await call(bench, "GET", "/changeover/v0/holds/" + scoped.json?.hold_id, { token: AGENT_TOKEN });
  is(stolen.json?.code, "hold_not_found", "and the principal named in the body cannot address the Hold (Z1)");

  /* 9 — Profile 0 --------------------------------------------------------- */

  legible = await httpBench({ profile: "0" });
  const holdVerbs = [
    ["hold_seats", () => call(legible, "POST", "/changeover/v0/holds", { token: AGENT_TOKEN, headers: { "Idempotency-Key": key("proof-p0") }, body: holdBody(["A:1"]) })],
    ["get_hold", () => call(legible, "GET", "/changeover/v0/holds/hold_X", { token: AGENT_TOKEN })],
    ["release_hold", () => call(legible, "DELETE", "/changeover/v0/holds/hold_X", { token: AGENT_TOKEN })],
    ["hand_off", () => call(legible, "POST", "/changeover/v0/holds/hold_X/hand-off", { token: AGENT_TOKEN, headers: { "Idempotency-Key": key("proof-p0off") }, body: { read_token: "rt" } })],
    ["revoke", () => call(legible, "POST", "/changeover/v0/holds/hold_X/revoke", { token: OPERATOR_TOKEN, body: { revocation_reason: "safety" } })],
  ];
  is(holdVerbs.length, ROUTES.filter((r) => r.hold_verb).length, "the table marks exactly five routes as hold verbs");

  let notSupported = 0;
  for (const [name, run] of holdVerbs) {
    const r = await run();
    if (r.status === 501 && r.json?.code === "profile_not_supported" &&
        r.json?.type === "urn:changeover:refusal:profile_not_supported") notSupported++;
    else bad(name + " at Profile 0 answered " + r.status + " " + JSON.stringify(r.json?.code));
  }
  is(notSupported, 5, "every hold verb at Profile 0 answers 501 profile_not_supported");

  const staticFile = await call(legible, "GET", "/.well-known/changeover");
  const embedded = staticFile.status === 200 && staticFile.json?.profile === "0" &&
    Array.isArray(staticFile.json?.occasions) && staticFile.json.occasions.length === 2;
  embedded
    ? ok("Profile 0 still publishes: the capability document embeds its Occasions")
    : bad("the Profile 0 capability document did not embed its Occasions");
} finally {
  await bench.close();
  if (legible !== null) await legible.close();
  if (throttled !== null) await throttled.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
