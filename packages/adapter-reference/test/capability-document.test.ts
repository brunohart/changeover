/**
 * The capability document, and the two rules that make it more than a literal.
 * Owner: ADAPT-001.
 *
 * These run against synthetic `floor_evidence` rather than a measured one on
 * purpose: the arithmetic under test is *what the builder does with a
 * measurement*, and handing it a real one would make every assertion depend on
 * how fast the machine was that day. The real measurement is exercised in
 * `floor-measurement.test.ts` and in `scripts/prove_reference_adapter.sh`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HOLD_POLICY_PUBLISHED } from "@changeover/core/budgets.ts";
import { HANDOFF_GATE_BUDGET_DEFAULT_MS, minPolicyMaxFloorMs } from "@changeover/core/principal.ts";
import type { FloorEvidence } from "@changeover/adapter-reference/adapter.ts";
import {
  ENFORCED_LIMIT_NAMES,
  MAX_PAGE_SIZE,
  MAX_WINDOW_MS,
  REGISTER_VERSION,
  REFERENCE_USAGE_POLICY,
  buildCapability,
  unpublishedLimits,
  warrantedGateStage,
  warrantedPolicy,
} from "@changeover/adapter-reference/capability.ts";
import { FloorNotWarranted } from "@changeover/adapter-reference/floor.ts";
import {
  CAPABILITY_SCHEMA_ID,
  REPO_ROOT,
  schemaValidator,
} from "./lib/schema-validator.ts";

const validate = schemaValidator();

function evidence(min_observed_retention_ms: number, safety_margin_ms = 500): FloorEvidence {
  return {
    observations: 5,
    window_start: "2026-08-25T09:00:00+12:00",
    window_end: "2026-08-25T09:00:03+12:00",
    min_observed_retention_ms,
    safety_margin_ms,
    violations: 0,
  };
}

const VENUE = {
  id: "ven_embassy",
  name: "Embassy Theatre",
  origin: "https://embassy.example",
  timezone: "Pacific/Auckland",
  locality: "Wellington",
};

function build(ev: FloorEvidence) {
  return buildCapability({
    profile: "1",
    hold_basis: "system_of_record",
    floor_basis: "owned_store",
    venue: VENUE,
    evidence: ev,
    generated_at: "2026-08-25T09:00:03+12:00",
    occasions_url: "https://embassy.example/changeover/v0/occasions",
  }) as Record<string, any>;
}

test("the document validates against the frozen capability schema", () => {
  const document = build(evidence(180000));
  assert.equal(validate(CAPABILITY_SCHEMA_ID, document), null);
});

test("the published floor ceiling is clamped to the measurement, never raised by it", () => {
  // A tight measurement clamps a generous policy down.
  const tight = build(evidence(3000));
  assert.equal(tight.hold_policy.policy_max_floor_ms, 2500);

  // A generous measurement does NOT raise the policy above what it published:
  // the measurement is a ceiling on the warranty, not a licence to grow one.
  const generous = build(evidence(10_000_000));
  assert.equal(generous.hold_policy.policy_max_floor_ms, HOLD_POLICY_PUBLISHED.policy_max_floor_ms);
});

test("floor_ms never exceeds min_observed_retention_ms minus safety_margin_ms, at any margin", () => {
  for (const [min_observed, margin] of [
    [3000, 500],
    [5000, 2500],
    [180000, 30000],
    [301000, 1000],
  ] as const) {
    const document = build(evidence(min_observed, margin));
    assert.ok(
      document.hold_policy.policy_max_floor_ms <= min_observed - margin,
      `${document.hold_policy.policy_max_floor_ms} exceeds the warranted ${min_observed - margin}`,
    );
    assert.equal(validate(CAPABILITY_SCHEMA_ID, document), null);
  }
});

test("no measurement means no document — a Server MUST NOT grant a floor it has not measured", () => {
  const none: FloorEvidence = { ...evidence(3000), observations: 0 };
  assert.throws(() => warrantedPolicy(HOLD_POLICY_PUBLISHED, none), FloorNotWarranted);
  assert.throws(() => build(none), FloorNotWarranted);
});

test("a measurement too tight to warrant the schema's own minimum refuses rather than rounds up", () => {
  // 1400 - 500 = 900, below hold.schema.json's 1000ms floor_ms minimum. The
  // honest answer is no document and 503 floor_unavailable, not 1000.
  assert.throws(
    () => build(evidence(1400)),
    (err: unknown) => err instanceof FloorNotWarranted && err.warrantable_floor_ms === 900,
  );
});

test("gate_stage is derived from what the floor can fund, and X6's arithmetic is checked on the result", () => {
  const needed = minPolicyMaxFloorMs(HANDOFF_GATE_BUDGET_DEFAULT_MS, HOLD_POLICY_PUBLISHED.clock_guard_ms);
  assert.equal(needed, 152000, "120000 gate budget + 2000 clock guard + 30000 headroom");

  // A measured floor of a few seconds cannot fund a two-minute gate, so the
  // gate moves to before the seats are taken rather than the floor being lied about.
  assert.equal(build(evidence(3000)).gate_stage, "hold");
  assert.equal(warrantedGateStage({ ...HOLD_POLICY_PUBLISHED, policy_max_floor_ms: 2500 }, 120000), "hold");
  assert.equal(warrantedGateStage({ ...HOLD_POLICY_PUBLISHED, policy_max_floor_ms: 152000 }, 120000), "handoff");
});

test("register_version has not drifted away from register/2026.1.json", () => {
  const register = JSON.parse(readFileSync(`${REPO_ROOT}register/2026.1.json`, "utf8")) as {
    register_version: string;
  };
  assert.equal(REGISTER_VERSION, register.register_version);
});

test("every limit this Server enforces is published, both directions", () => {
  const document = build(evidence(180000));
  assert.deepEqual([...unpublishedLimits(document)], []);
  // And the list is not vacuously satisfiable: a limit nobody publishes is caught.
  assert.deepEqual([...unpublishedLimits({ ...document, hold_policy: {} })].sort(), [
    ...ENFORCED_LIMIT_NAMES.filter((n) => !Object.prototype.hasOwnProperty.call(document, n)),
  ].sort());
});

test("the usage policy names a path, not a person", () => {
  // C-ABSENCE.4 fails the build on a response body matching an email, and an
  // operator's address in `contact` would be exactly that.
  assert.doesNotMatch(REFERENCE_USAGE_POLICY.contact, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.equal(REFERENCE_USAGE_POLICY.redistribution, "forbidden");
  assert.equal(REFERENCE_USAGE_POLICY.attribution_text.content_type, "text/plain");
});

test("the recommended read-side limits are the ones §2.9 recommends", () => {
  assert.equal(MAX_WINDOW_MS, 1209600000);
  assert.equal(MAX_PAGE_SIZE, 200);
  const document = build(evidence(180000));
  assert.equal(document.log_retention_days, 90);
  assert.equal(document.handoff_gate_budget_ms, HANDOFF_GATE_BUDGET_DEFAULT_MS);
});

test("a document with neither occasions_url nor an inline occasions array is refused", () => {
  assert.throws(
    () =>
      buildCapability({
        profile: "1",
        hold_basis: "system_of_record",
        floor_basis: "owned_store",
        venue: VENUE,
        evidence: evidence(180000),
        generated_at: "2026-08-25T09:00:03+12:00",
      }),
    /occasions_url or an inline occasions array/,
  );
});
