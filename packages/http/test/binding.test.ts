/**
 * The binding, over a real socket.
 *
 * Every assertion here is made against a response that travelled through
 * `node:http` — not against `handle()`. The header contract is a claim about
 * what an intermediary sees, and an intermediary sees bytes: a `Retry-After` set
 * on an object that the socket layer then dropped would satisfy a test written
 * against the object and nothing else.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { REFUSAL_STATUS } from "@changeover/schema/refusal.ts";

import { ROUTES } from "../src/routes.ts";
import { codeOfUrn } from "../src/problem.ts";
import { occasionMaxAgeSeconds, retryAfterSeconds } from "../src/headers.ts";
import {
  AGENT_TOKEN,
  ETAG_A,
  OCCASION_A,
  OCCASION_B,
  OPERATOR_TOKEN,
  OTHER_TOKEN,
  call,
  holdBody,
  httpBench,
  key,
} from "./lib/http-bench.ts";
import type { Call, HttpBench } from "./lib/http-bench.ts";

let bench: HttpBench;

before(async () => {
  bench = await httpBench();
});

after(async () => {
  await bench.close();
});

/* -- Helpers ---------------------------------------------------------------- */

async function grant(seats: readonly string[], seed: string, token = AGENT_TOKEN): Promise<Call> {
  return call(bench, "POST", "/changeover/v0/holds", {
    token,
    headers: { "Idempotency-Key": key(seed) },
    body: holdBody(seats),
  });
}

/** Every response, on every route, carries the instant it was decided at. */
function assertServerTime(response: Call, where: string): void {
  const stamped = response.headers.get("changeover-server-time");
  assert.ok(stamped, `${where} carried no Changeover-Server-Time`);
  assert.match(
    stamped as string,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/,
    `${where} stamped a non-RFC-3339 server time`,
  );
}

/** A refusal on the wire is problem+json, with a URN naming its own code. */
function assertProblem(response: Call, code: string, where: string): void {
  assert.equal(
    response.headers.get("content-type"),
    "application/problem+json",
    `${where} was not problem+json`,
  );
  assert.equal(response.json.code, code, where);
  assert.equal(response.json.type, `urn:changeover:refusal:${code}`, where);
  assert.equal(response.json.status, response.status, `${where} disagreed with its own status`);
  assert.equal(response.status, REFUSAL_STATUS[code as "hold_not_live"], where);
  assert.equal(codeOfUrn(response.json.type), code, where);
  assertServerTime(response, where);
}

/* -- All nine routes -------------------------------------------------------- */

test("all nine routes answer, and every answer carries Changeover-Server-Time", async () => {
  await bench.reset();
  const held = await grant(["A:1", "A:2"], "walk");
  assert.equal(held.status, 201);
  const hold_id = held.json.hold_id as string;
  const read = await call(bench, "GET", `/changeover/v0/holds/${hold_id}`, { token: AGENT_TOKEN });

  const calls: Record<string, () => Promise<Call>> = {
    capability: () => call(bench, "GET", "/.well-known/changeover"),
    delegation: () => call(bench, "GET", "/.well-known/changeover/delegation.json"),
    resolve_occasions: () => call(bench, "GET", "/changeover/v0/occasions", { token: AGENT_TOKEN }),
    get_occasion: () =>
      call(bench, "GET", `/changeover/v0/occasions/${OCCASION_A}`, { token: AGENT_TOKEN }),
    hold_seats: () => grant(["A:7"], "walk-hold"),
    get_hold: () => call(bench, "GET", `/changeover/v0/holds/${hold_id}`, { token: AGENT_TOKEN }),
    hand_off: () =>
      call(bench, "POST", `/changeover/v0/holds/${hold_id}/hand-off`, {
        token: AGENT_TOKEN,
        headers: { "Idempotency-Key": key("walk-off") },
        body: { read_token: read.json.read_token },
      }),
    revoke: () =>
      call(bench, "POST", `/changeover/v0/holds/${hold_id}/revoke`, {
        token: OPERATOR_TOKEN,
        body: { revocation_reason: "venue_operations" },
      }),
    release_hold: () =>
      call(bench, "DELETE", `/changeover/v0/holds/${hold_id}`, { token: AGENT_TOKEN }),
  };

  // Driven off the table, so a tenth route added without a call here fails.
  assert.deepEqual(Object.keys(calls).sort(), ROUTES.map((r) => r.name).sort());

  for (const route of ROUTES) {
    const response = await (calls[route.name] as () => Promise<Call>)();
    assert.ok(response.status < 500, `${route.name} answered ${response.status}`);
    assert.notEqual(response.json?.type, "about:blank", `${route.name} did not route`);
    assertServerTime(response, route.name);
  }
});

test("a 204 carries no body and still carries the server time", async () => {
  await bench.reset();
  const held = await grant(["A:4"], "no-body");
  const released = await call(bench, "DELETE", `/changeover/v0/holds/${held.json.hold_id}`, {
    token: AGENT_TOKEN,
  });
  assert.equal(released.status, 204);
  assert.equal(released.text, "");
  assertServerTime(released, "release_hold");
});

/* -- Errors ----------------------------------------------------------------- */

test("every refusal is problem+json with a URN type that names its code", async () => {
  await bench.reset();
  const cases: { where: string; code: string; run: () => Promise<Call> }[] = [
    {
      where: "no credential",
      code: "not_authorised",
      run: () => call(bench, "GET", "/changeover/v0/occasions"),
    },
    {
      where: "unknown Occasion",
      code: "occasion_not_found",
      run: () => call(bench, "GET", "/changeover/v0/occasions/occ_nope", { token: AGENT_TOKEN }),
    },
    {
      where: "unknown Hold",
      code: "hold_not_found",
      run: () =>
        call(bench, "GET", "/changeover/v0/holds/hold_00000000000000000000000000000000", {
          token: AGENT_TOKEN,
        }),
    },
    {
      where: "an agent on the operator surface",
      code: "not_authorised",
      run: () =>
        call(bench, "POST", "/changeover/v0/holds/hold_X/revoke", {
          token: AGENT_TOKEN,
          body: { revocation_reason: "safety" },
        }),
    },
    {
      where: "a body that is not JSON",
      code: "schema_validation",
      run: () =>
        call(bench, "POST", "/changeover/v0/holds", {
          token: AGENT_TOKEN,
          headers: { "Idempotency-Key": key("bad"), "Content-Type": "application/json" },
          body: undefined,
        }),
    },
  ];

  for (const one of cases) {
    assertProblem(await one.run(), one.code, one.where);
  }
});

test("an unrouted path is about:blank and carries no code, because the taxonomy is closed", async () => {
  const missing = await call(bench, "GET", "/changeover/v0/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "application/problem+json");
  assert.equal(missing.json.type, "about:blank");
  assert.equal(missing.json.code, undefined, "a routing fact was given a refusal code");
  assertServerTime(missing, "no route");

  const wrong = await call(bench, "PUT", "/changeover/v0/occasions", { token: AGENT_TOKEN });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET");
  assert.equal(wrong.json.type, "about:blank");
  assertServerTime(wrong, "method not allowed");
});

/* -- Retry-After ------------------------------------------------------------ */

test("Retry-After is ceil(retry_after_ms/1000) on the wire, and the body's ms is normative", async () => {
  // 1400 ms is chosen because truncation and ceiling disagree about it.
  const throttled = await httpBench({
    overrides: {
      rate_limit: {
        check(_key, route) {
          return route.name === "resolve_occasions" ? 1400 : null;
        },
      },
    },
  });
  try {
    const response = await call(throttled, "GET", "/changeover/v0/occasions", {
      token: AGENT_TOKEN,
    });
    assertProblem(response, "rate_limited", "rate limited");
    assert.equal(response.json.retry_after_ms, 1400);
    assert.equal(response.headers.get("retry-after"), "2");
    assert.equal(
      Number(response.headers.get("retry-after")),
      retryAfterSeconds(response.json.retry_after_ms),
    );
  } finally {
    await throttled.close();
  }
});

/* -- Cache-Control ---------------------------------------------------------- */

test("Cache-Control on an Occasion is min(max_staleness_ms/1000, 30)", async () => {
  const a = await call(bench, "GET", `/changeover/v0/occasions/${OCCASION_A}`, {
    token: AGENT_TOKEN,
  });
  assert.equal(a.status, 200);
  assert.equal(a.json.availability.max_staleness_ms, 30000);
  assert.equal(a.headers.get("cache-control"), `max-age=${occasionMaxAgeSeconds(30000)}`);
  assert.equal(a.headers.get("cache-control"), "max-age=30");

  const b = await call(bench, "GET", `/changeover/v0/occasions/${OCCASION_B}`, {
    token: AGENT_TOKEN,
  });
  assert.equal(b.json.availability.max_staleness_ms, 5000);
  assert.equal(b.headers.get("cache-control"), "max-age=5");

  // A page of Occasions is no fresher than the stalest budget in it.
  const page = await call(bench, "GET", "/changeover/v0/occasions", { token: AGENT_TOKEN });
  assert.equal(page.json.occasions.length, 2);
  assert.equal(page.headers.get("cache-control"), "max-age=5");
});

/* -- If-Match --------------------------------------------------------------- */

test("If-Match is refused on POST /holds rather than honoured", async () => {
  await bench.reset();
  const response = await call(bench, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": key("ifmatch"), "If-Match": `"${ETAG_A}"` },
    body: holdBody(["A:9"]),
  });
  // Refused even though the etag is CORRECT. A binding that honoured it would
  // pass this request, and the failure would only appear at an intermediary that
  // evaluated the condition against the hold collection, which is what RFC 9110
  // §13.1.1 says it must do.
  assertProblem(response, "schema_validation", "If-Match on POST /holds");

  const holds = await bench.db.query<{ n: string }>("select count(*)::text as n from hold");
  assert.equal(Number(holds.rows[0]?.n), 0, "a refused conditional still granted a Hold");
});

test("If-Match is honoured on the Occasion, where the target IS the Occasion", async () => {
  const matched = await call(bench, "GET", `/changeover/v0/occasions/${OCCASION_A}`, {
    token: AGENT_TOKEN,
    headers: { "If-Match": `"${ETAG_A}"` },
  });
  assert.equal(matched.status, 200);
  // The wire form is unquoted; the header form is quoted; the Server strips.
  assert.equal(matched.headers.get("etag"), `"${ETAG_A}"`);
  assert.equal(matched.json.etag, ETAG_A);

  const moved = await call(bench, "GET", `/changeover/v0/occasions/${OCCASION_A}`, {
    token: AGENT_TOKEN,
    headers: { "If-Match": '"1:0000000000000000000000000000000000000000000"' },
  });
  assertProblem(moved, "occasion_moved", "a stale conditional");
  assert.deepEqual(moved.json.detail.changed_paths, [""]);

  // An unquoted tag is not an entity-tag, so the precondition cannot be met.
  const unquoted = await call(bench, "GET", `/changeover/v0/occasions/${OCCASION_A}`, {
    token: AGENT_TOKEN,
    headers: { "If-Match": ETAG_A },
  });
  assertProblem(unquoted, "occasion_moved", "an unquoted conditional");
});

test("Changeover-Occasion-ETag is an echo, and a disagreement is 400", async () => {
  await bench.reset();
  const agreeing = await call(bench, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": key("echo-ok"), "Changeover-Occasion-ETag": ETAG_A },
    body: holdBody(["A:11"]),
  });
  assert.equal(agreeing.status, 201);

  const disagreeing = await call(bench, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: {
      "Idempotency-Key": key("echo-bad"),
      "Changeover-Occasion-ETag": "1:0000000000000000000000000000000000000000000",
    },
    body: holdBody(["A:12"]),
  });
  assertProblem(disagreeing, "schema_validation", "a disagreeing echo");
});

/* -- Scope ------------------------------------------------------------------ */

test("a scope-bearing body member is ignored, and the scope comes from the token", async () => {
  await bench.reset();
  // The token is OTHER's. The body claims to be AGENT. If the binding merged,
  // the credential would win the collision and this test would still pass - so
  // it asserts the STORE, where a merge that had gone the other way in a
  // refactor would be visible as the wrong principal owning the seats.
  const response = await call(bench, "POST", "/changeover/v0/holds", {
    token: OTHER_TOKEN,
    headers: { "Idempotency-Key": key("scope") },
    body: holdBody(["A:14"], {
      agent_id: "agt_reference",
      principal_scope: "prin_wellington",
      profile: "1",
      site_id: "site_elsewhere",
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(response.json.agent_id, "agt_other");

  const row = await bench.db.query<{ agent_id: string; principal_scope: string }>(
    "select agent_id, principal_scope from hold where hold_id = $1",
    [response.json.hold_id],
  );
  assert.equal(row.rows[0]?.agent_id, "agt_other");
  assert.equal(row.rows[0]?.principal_scope, "prin_auckland");

  // Z1: the principal named in the body cannot read the Hold it did not make.
  const stolen = await call(bench, "GET", `/changeover/v0/holds/${response.json.hold_id}`, {
    token: AGENT_TOKEN,
  });
  assertProblem(stolen, "hold_not_found", "another principal's Hold");
});

/* -- Versioning ------------------------------------------------------------- */

test("V1: a request declaring an unsupported version is refused before its members are read", async () => {
  const refused = await call(bench, "GET", "/changeover/v0/occasions", {
    token: AGENT_TOKEN,
    headers: { "Changeover-Version": "0.9" },
  });
  assertProblem(refused, "schema_validation", "an unsupported version");

  const accepted = await call(bench, "GET", "/changeover/v0/occasions", {
    token: AGENT_TOKEN,
    headers: { "Changeover-Version": "0.1" },
  });
  assert.equal(accepted.status, 200);
});

test("V3: an unknown write member is refused, and a scope member is ignored instead", async () => {
  await bench.reset();
  const unknown = await call(bench, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": key("v3") },
    body: holdBody(["A:16"], { hurry: true }),
  });
  assertProblem(unknown, "schema_validation", "an unknown member");

  // `agent_id` is not unknown - it is recognised and simply not an input. §6.3's
  // delete-and-refill rule is the specific one and it runs first.
  const scoped = await call(bench, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": key("v3-scope") },
    body: holdBody(["A:17"], { agent_id: "agt_impostor" }),
  });
  assert.equal(scoped.status, 201);
});

/* -- Idempotency ------------------------------------------------------------ */

test("a replay is 200 with Idempotency-Replayed, and a first execution is 201", async () => {
  await bench.reset();
  const first = await grant(["A:18"], "replay");
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("idempotency-replayed"), "false");
  assert.equal(
    first.headers.get("location"),
    `/changeover/v0/holds/${first.json.hold_id}`,
  );

  const second = await grant(["A:18"], "replay");
  assert.equal(second.status, 200, "a replay created nothing and must not say 201");
  assert.equal(second.headers.get("idempotency-replayed"), "true");
  assert.equal(second.json.hold_id, first.json.hold_id);

  const holds = await bench.db.query<{ n: string }>("select count(*)::text as n from hold");
  assert.equal(Number(holds.rows[0]?.n), 1, "the replay granted a second Hold");
});

test("hold_seats without an Idempotency-Key is refused, because I1 requires one", async () => {
  await bench.reset();
  const response = await call(bench, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    body: holdBody(["A:19"]),
  });
  assertProblem(response, "schema_validation", "a missing Idempotency-Key");
});

/* -- Profile 0 -------------------------------------------------------------- */

test("Profile 0 answers 501 profile_not_supported on every hold verb", async () => {
  const legible = await httpBench({ profile: "0" });
  try {
    const attempts: { name: string; run: () => Promise<Call> }[] = [
      {
        name: "hold_seats",
        run: () =>
          call(legible, "POST", "/changeover/v0/holds", {
            token: AGENT_TOKEN,
            headers: { "Idempotency-Key": key("p0") },
            body: holdBody(["A:1"]),
          }),
      },
      {
        name: "get_hold",
        run: () => call(legible, "GET", "/changeover/v0/holds/hold_X", { token: AGENT_TOKEN }),
      },
      {
        name: "release_hold",
        run: () => call(legible, "DELETE", "/changeover/v0/holds/hold_X", { token: AGENT_TOKEN }),
      },
      {
        name: "hand_off",
        run: () =>
          call(legible, "POST", "/changeover/v0/holds/hold_X/hand-off", {
            token: AGENT_TOKEN,
            headers: { "Idempotency-Key": key("p0off") },
            body: { read_token: "rt" },
          }),
      },
      {
        name: "revoke",
        run: () =>
          call(legible, "POST", "/changeover/v0/holds/hold_X/revoke", {
            token: OPERATOR_TOKEN,
            body: { revocation_reason: "safety" },
          }),
      },
    ];
    assert.equal(attempts.length, ROUTES.filter((r) => r.hold_verb).length);

    for (const attempt of attempts) {
      const response = await attempt.run();
      assertProblem(response, "profile_not_supported", `${attempt.name} at Profile 0`);
      assert.equal(response.status, 501);
    }

    // The read side still works, and the capability document IS the static file.
    const capability = await call(legible, "GET", "/.well-known/changeover");
    assert.equal(capability.status, 200);
    assert.equal(capability.json.profile, "0");
    assert.equal(capability.json.occasions.length, 2);
    assert.equal(capability.headers.get("cache-control"), "max-age=5");
  } finally {
    await legible.close();
  }
});

/* -- Delegation ------------------------------------------------------------- */

test("the delegation record is served at the apex and nowhere else", async () => {
  const atApex = await call(bench, "GET", "/.well-known/changeover/delegation.json");
  assert.equal(atApex.status, 200);
  assert.deepEqual(atApex.json.delegated_origins, ["https://tickets.example"]);
  assert.equal(atApex.json.origin, "https://embassy.example");
  assert.equal(atApex.headers.get("cache-control"), "max-age=86400");

  const delegated = await httpBench({ apex: false });
  try {
    const response = await call(delegated, "GET", "/.well-known/changeover/delegation.json");
    // A delegated host that could serve this record could delegate onward.
    assert.equal(response.status, 404);
    assert.equal(response.json.type, "about:blank");
    assertServerTime(response, "delegation off the apex");
  } finally {
    await delegated.close();
  }
});

/* -- Paging ----------------------------------------------------------------- */

test("resolve_occasions pages on a stable cursor and refuses a window it does not publish", async () => {
  const first = await call(bench, "GET", "/changeover/v0/occasions?page_size=1", {
    token: AGENT_TOKEN,
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.occasions.length, 1);
  assert.equal(first.json.occasions[0].occasion_id, OCCASION_A);
  assert.ok(typeof first.json.next_cursor === "string");

  const second = await call(
    bench,
    "GET",
    `/changeover/v0/occasions?page_size=1&cursor=${encodeURIComponent(first.json.next_cursor)}`,
    { token: AGENT_TOKEN },
  );
  assert.equal(second.json.occasions[0].occasion_id, OCCASION_B);
  assert.equal(second.json.next_cursor, undefined, "the last page has no continuation");

  const wide = await call(
    bench,
    "GET",
    "/changeover/v0/occasions?from=2026-01-01T00:00:00%2B12:00&to=2030-01-01T00:00:00%2B12:00",
    { token: AGENT_TOKEN },
  );
  assertProblem(wide, "window_too_wide", "a four-year window");

  const badCursor = await call(bench, "GET", "/changeover/v0/occasions?cursor=%%%", {
    token: AGENT_TOKEN,
  });
  assertProblem(badCursor, "schema_validation", "a cursor this Server did not mint");
});
