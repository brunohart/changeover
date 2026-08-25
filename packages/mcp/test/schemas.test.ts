/**
 * The schemas, as documents. What the proof scripts assert over a live
 * connection, these assert about the shapes themselves — cheaper to run and
 * much cheaper to read when one of them breaks.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DIALECT_2020_12, SCHEMA_DIR, SCHEMA_IRI, bundle } from "../src/bundle.ts";
import { TOOLS, TOOL_NAMES, toolByName } from "../src/tools.ts";
import { compileToolValidators, ajv2020 } from "../src/validate.ts";

const validators = compileToolValidators();

const holdArgs = (overrides: Record<string, unknown> = {}) => ({
  occasion_id: "occ_a",
  occasion_etag: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  sought: {
    occasion_id: "occ_a",
    occasion_etag: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  seats: ["A:1", "A:2"],
  requested_floor_ms: 120000,
  idempotency_key: "key0123456789abcdefghijklmn",
  ...overrides,
});

test("the tool table is the five verbs of schemas/verbs.json, in the specification order", () => {
  const verbs = JSON.parse(readFileSync(join(SCHEMA_DIR, "verbs.json"), "utf8")).verbs;
  assert.deepEqual([...TOOL_NAMES], verbs);
});

test("a bundled document resolves with no network and no registry", () => {
  for (const iri of Object.values(SCHEMA_IRI)) {
    const bundled = bundle(iri);
    assert.equal(bundled.$schema, DIALECT_2020_12);
    // A URN left anywhere in the bundle is a $ref no client can follow.
    assert.ok(
      !JSON.stringify(bundled).includes("urn:changeover:schema:"),
      `${iri} still carries an unresolvable URN $ref`,
    );
    assert.doesNotThrow(() => ajv2020().compile(bundled));
  }
});

test("bundling refuses an IRI no schema in schemas/ declares", () => {
  assert.throws(() => bundle("urn:changeover:schema:invented:9.9"), /no schema/);
});

test("every published schema compiles under the same strict validator the Server runs", () => {
  for (const tool of TOOLS) {
    assert.doesNotThrow(() => ajv2020().compile(tool.inputSchema), `${tool.name}.inputSchema`);
    assert.doesNotThrow(() => ajv2020().compile(tool.outputSchema), `${tool.name}.outputSchema`);
  }
});

test("W2 — a duplicate-bearing seat array is refused before any lock is taken", () => {
  assert.equal(validators.validateInput("hold_seats", holdArgs()), null);
  const problem = validators.validateInput("hold_seats", holdArgs({ seats: ["F:11", "F:11"] }));
  assert.match(String(problem), /duplicate/i);
});

test("the seat ceiling is twelve, identically to the HTTP binding", () => {
  const thirteen = Array.from({ length: 13 }, (_, index) => `A:${index}`);
  assert.notEqual(validators.validateInput("hold_seats", holdArgs({ seats: thirteen })), null);
  const twelve = thirteen.slice(0, 12);
  assert.equal(validators.validateInput("hold_seats", holdArgs({ seats: twelve })), null);
});

test("intent_digest refuses an email address — the draft own worked failure", () => {
  // "a Server accepting sarah.chen@gmail.com and echoing it emitted a Hold
  // failing its own schema". Refused at the boundary, so no such Hold exists.
  const problem = validators.validateInput(
    "hold_seats",
    holdArgs({ intent_digest: "sarah.chen@gmail.com" }),
  );
  assert.match(String(problem), /pattern/);
  assert.equal(
    validators.validateInput(
      "hold_seats",
      holdArgs({ intent_digest: "cVR3ZmFrZUludGVudERpZ2VzdEZvclBhcml0eVByb28" }),
    ),
    null,
  );
});

test("idempotency_key is bounded at 128, so a body cannot be smuggled through it", () => {
  const long = "k".repeat(129);
  assert.notEqual(validators.validateInput("hold_seats", holdArgs({ idempotency_key: long })), null);
  assert.equal(
    validators.validateInput("hold_seats", holdArgs({ idempotency_key: "k".repeat(128) })),
    null,
  );
});

test("exactly one of seats and selection, and a request carrying both is refused", () => {
  const selection = { mode: "best_available", quantity: 2 };
  const both = holdArgs({ selection });
  assert.notEqual(validators.validateInput("hold_seats", both), null);

  const { seats: _seats, ...withoutSeats } = holdArgs();
  assert.equal(validators.validateInput("hold_seats", { ...withoutSeats, selection }), null);

  const { seats: _also, ...neither } = holdArgs();
  assert.notEqual(validators.validateInput("hold_seats", neither), null);
});

test("an unknown member is refused rather than ignored, on every tool", () => {
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  assert.notEqual(
    validators.validateInput("hold_seats", holdArgs({ principal_scope: "prin_smuggled" })),
    null,
  );
});

test("SEP-2567 — hold_seats offers no hold_id to synthesise, and the other three require one", () => {
  const holdSeats = toolByName("hold_seats");
  assert.ok(holdSeats !== undefined);
  const properties = holdSeats.inputSchema.properties as Record<string, unknown>;
  assert.equal(Object.hasOwn(properties, "hold_id"), false);

  for (const name of ["get_hold", "release_hold", "hand_off"]) {
    const tool = toolByName(name);
    assert.ok(tool !== undefined, name);
    assert.ok((tool.inputSchema.required as string[]).includes("hold_id"), name);
  }
});

test("hand_off requires the read_token, because T4 is a guard and not a request", () => {
  const tool = toolByName("hand_off");
  assert.ok(tool !== undefined);
  assert.ok((tool.inputSchema.required as string[]).includes("read_token"));
  assert.notEqual(validators.validateInput("hand_off", { hold_id: "hold_x", idempotency_key: "k".repeat(24) }), null);
});

test("a gated hold validates against hold_seats own outputSchema, and so does a Hold", () => {
  const gate = {
    input_required: true,
    stage: "hold",
    inputRequests: [
      {
        prompt: { content_type: "text/plain", value: "Hold 2 seats at the Embassy on 2026-08-29T19:00?" },
        seat_count: 2,
        venue_name: "Embassy Theatre",
        local_wall: "2026-08-29T19:00",
        presentation_classes: ["carrier:35mm"],
        amount_minor: 2400,
        currency: "NZD",
      },
    ],
  };
  assert.equal(validators.validateOutput("hold_seats", gate), null);

  const hold = {
    changeover: "0.1",
    hold_id: "hold_RC49SP025EDCM127316JXV21XZR31Q1X",
    state: "live",
    occasion_id: "occ_a",
    occasion_etag: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sought_occasion_id: "occ_a",
    seats: ["A:1", "A:2"],
    granted_at: "2026-08-29T19:00:00+12:00",
    floor_ms: 120000,
    floor_deadline: "2026-08-29T19:02:00+12:00",
    expires_at: "2026-08-29T19:02:00+12:00",
    extendable: false,
    agent_id: "agt_reference",
    server_time: "2026-08-29T19:00:00+12:00",
  };
  assert.equal(validators.validateOutput("hold_seats", hold), null);
});

test("X6a — an inputRequest carrying only a caption does not validate", () => {
  const captionOnly = {
    input_required: true,
    stage: "hold",
    inputRequests: [
      { prompt: { content_type: "text/plain", value: "Hold two seats?" } },
    ],
  };
  assert.notEqual(validators.validateOutput("hold_seats", captionOnly), null);
});

test("get_hold is not widened with a gate, because reading a Hold asks nobody anything", () => {
  const tool = toolByName("get_hold");
  assert.ok(tool !== undefined);
  assert.equal(Object.hasOwn(tool.outputSchema, "oneOf"), false);
});
