/**
 * X0 and X6. Owner: CORE-006.
 *
 * The assertions that matter here are the ones about *absence*: an absent
 * principal scope, an absent `attended` grant, an absent price half. Each one is
 * a place where a permissive default would be invisible in every test that
 * supplied the value.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isRefusal } from "@changeover/schema/refusal.ts";
import {
  AGENT_ID_PATTERN,
  GATE_STAGE,
  GateBudgetError,
  GateShapeError,
  HANDOFF_GATE_BUDGET_DEFAULT_MS,
  PRINCIPAL_SCOPE_MAX_LENGTH,
  assertGateBudget,
  containsUri,
  gateRequired,
  holdGateCaption,
  inputRequired,
  isAttended,
  minPolicyMaxFloorMs,
  platformKey,
  principalKey,
  requirePrincipal,
  samePrincipal,
} from "@changeover/core/principal.ts";

const AGENT = "agt_examplebot";

function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(isRefusal(err), `expected a Refusal, got ${String(err)}`);
    return (err as { code: string }).code;
  }
  assert.fail("expected a refusal and none was thrown");
}

/* ── X0 ────────────────────────────────────────────────────────────────────── */

test("X0 · a credential carrying a principal scope passes, and carries it through", () => {
  const principal = requirePrincipal({ agent_id: AGENT, principal_scope: "ppid_kSk3" });
  assert.equal(principal.agent_id, AGENT);
  assert.equal(principal.principal_scope, "ppid_kSk3");
});

test("X0 · an absent principal scope is 403 principal_scope_missing, in all three shapes of absence", () => {
  assert.equal(refusalCode(() => requirePrincipal({ agent_id: AGENT })), "principal_scope_missing");
  assert.equal(
    refusalCode(() => requirePrincipal({ agent_id: AGENT, principal_scope: null })),
    "principal_scope_missing",
  );
  // An empty string is absence. A platform sending "" for every customer would
  // collapse its entire population into one budget — X0's failure arriving
  // through the door marked "present".
  assert.equal(
    refusalCode(() => requirePrincipal({ agent_id: AGENT, principal_scope: "" })),
    "principal_scope_missing",
  );
});

test("X0 · a scope longer than the column is refused rather than truncated", () => {
  const long = "p".repeat(PRINCIPAL_SCOPE_MAX_LENGTH + 1);
  assert.equal(
    refusalCode(() => requirePrincipal({ agent_id: AGENT, principal_scope: long })),
    "principal_scope_missing",
  );
  // Exactly at the bound is a scope, not a refusal.
  const at = requirePrincipal({ agent_id: AGENT, principal_scope: "p".repeat(PRINCIPAL_SCOPE_MAX_LENGTH) });
  assert.equal(at.principal_scope.length, PRINCIPAL_SCOPE_MAX_LENGTH);
});

test("X0 · no agent identity is 403 not_authorised, which is a different fix", () => {
  assert.equal(refusalCode(() => requirePrincipal({ agent_id: "", principal_scope: "p" })), "not_authorised");
  assert.equal(refusalCode(() => requirePrincipal({ agent_id: "examplebot", principal_scope: "p" })), "not_authorised");
  assert.ok(AGENT_ID_PATTERN.test(AGENT));
});

test("X0 · principalKey is injective, so two households can never share one budget", () => {
  // The collision a naive `agent + ":" + scope` produces. If these two keys were
  // equal, one household would be denied a seat because of the other's hedging,
  // with no way for either to find out why.
  const a = principalKey({ agent_id: "agt_a", principal_scope: "b:c" });
  const b = principalKey({ agent_id: "agt_a-b", principal_scope: "c" });
  assert.notEqual(a, b);

  assert.equal(
    principalKey({ agent_id: AGENT, principal_scope: "x" }),
    principalKey({ agent_id: AGENT, principal_scope: "x" }),
  );
  assert.notEqual(
    principalKey({ agent_id: AGENT, principal_scope: "x" }),
    principalKey({ agent_id: AGENT, principal_scope: "y" }),
  );
});

test("X0 · the platform key drops the customer half, and only that half", () => {
  const one = { agent_id: AGENT, principal_scope: "x" };
  const two = { agent_id: AGENT, principal_scope: "y" };
  assert.equal(platformKey(one), platformKey(two));
  assert.notEqual(principalKey(one), principalKey(two));
  assert.ok(!samePrincipal(one, two));
  assert.ok(samePrincipal(one, { agent_id: AGENT, principal_scope: "x" }));
});

/* ── X6 ────────────────────────────────────────────────────────────────────── */

test("X6 · absence means false, and so does everything that is not literally true", () => {
  assert.equal(isAttended({ agent_id: AGENT }), false);
  assert.equal(isAttended({ agent_id: AGENT, attended: false }), false);
  assert.equal(isAttended({ agent_id: AGENT, attended: true }), true);
  // A truthy non-boolean is not an exhibitor-issued grant.
  assert.equal(isAttended({ agent_id: AGENT, attended: 1 as unknown as boolean }), false);
});

test("X6 · a gate is owed at the published stage, to an unattended credential, and nowhere else", () => {
  const unattended = { agent_id: AGENT };
  const attended = { agent_id: AGENT, attended: true };

  assert.equal(gateRequired(GATE_STAGE.hold, "hold", unattended), true);
  assert.equal(gateRequired(GATE_STAGE.hold, "handoff", unattended), false);
  assert.equal(gateRequired(GATE_STAGE.handoff, "handoff", unattended), true);
  assert.equal(gateRequired(GATE_STAGE.none, "hold", unattended), false);
  assert.equal(gateRequired(GATE_STAGE.hold, "hold", attended), false);
});

test("X6 · at gate_stage handoff the floor cap may not sit below budget + guard + 30s", () => {
  assert.equal(minPolicyMaxFloorMs(HANDOFF_GATE_BUDGET_DEFAULT_MS, 2000), 152000);

  // At `hold` the inequality does not apply: the human is asked before a seat is
  // locked, so nothing is running while they decide.
  assertGateBudget({ gate_stage: "hold", clock_guard_ms: 2000, policy_max_floor_ms: 60000 });

  assert.throws(
    () => assertGateBudget({
      gate_stage: "handoff",
      handoff_gate_budget_ms: 120000,
      clock_guard_ms: 2000,
      policy_max_floor_ms: 120000,
    }),
    GateBudgetError,
  );
  assertGateBudget({
    gate_stage: "handoff",
    handoff_gate_budget_ms: 120000,
    clock_guard_ms: 2000,
    policy_max_floor_ms: 152000,
  });
});

test("X6 · gate_stage handoff with no published budget is a defect, not a default", () => {
  assert.throws(
    () => assertGateBudget({ gate_stage: "handoff", clock_guard_ms: 2000, policy_max_floor_ms: 300000 }),
    GateBudgetError,
  );
});

/* ── X6a ───────────────────────────────────────────────────────────────────── */

const FACTS = {
  seat_count: 2,
  venue_name: "The Embassy",
  local_wall: "2026-08-29T19:00",
  presentation_classes: ["35mm"],
};

test("X6a · the prompt is a prose envelope and the contract is the structure beside it", () => {
  const result = inputRequired("hold", FACTS, holdGateCaption(FACTS));
  assert.equal(result.input_required, true);
  assert.equal(result.gate_stage, "hold");
  assert.equal(result.inputRequests.length, 1);

  const request = result.inputRequests[0];
  assert.equal(request.prompt.content_type, "text/plain");
  assert.equal(request.prompt.value, "Hold 2 seats at The Embassy, 2026-08-29T19:00?");
  assert.equal(request.seat_count, 2);
  assert.equal(request.venue_name, "The Embassy");
  assert.equal(request.local_wall, "2026-08-29T19:00");
  assert.deepEqual(request.presentation_classes, ["35mm"]);
  // No price was disclosed, so neither half is invented.
  assert.equal(Object.hasOwn(request, "amount_minor"), false);
  assert.equal(Object.hasOwn(request, "currency"), false);
});

test("X6a · a prompt carrying a URI is a server defect, and a wall time is not a URI", () => {
  assert.ok(containsUri("Hold 2 seats — https://embassy.example/book"));
  assert.ok(containsUri("Book at www.embassy.example now"));
  assert.ok(containsUri("mailto:box@embassy.example"));
  // The caption renders local_wall and an offset. Neither may be mistaken for a scheme.
  assert.equal(containsUri("Hold 2 seats at The Embassy, 2026-08-29T19:00 +12:00?"), false);

  assert.throws(() => inputRequired("hold", FACTS, "Confirm at https://embassy.example"), GateShapeError);
});

test("X6a · amount_minor and currency are disclosed together or not at all", () => {
  assert.throws(() => inputRequired("hold", { ...FACTS, amount_minor: 2400 }, "Hold?"), GateShapeError);
  assert.throws(() => inputRequired("hold", { ...FACTS, currency: "NZD" }, "Hold?"), GateShapeError);

  const both = inputRequired("hold", { ...FACTS, amount_minor: 2400, currency: "NZD" }, "Hold?");
  assert.equal(both.inputRequests[0].amount_minor, 2400);
  assert.equal(both.inputRequests[0].currency, "NZD");
});

test("X6a · every named structured member is required, so a gate cannot be half built", () => {
  assert.throws(() => inputRequired("hold", { ...FACTS, seat_count: 0 }, "Hold?"), GateShapeError);
  assert.throws(() => inputRequired("hold", { ...FACTS, venue_name: "" }, "Hold?"), GateShapeError);
  assert.throws(() => inputRequired("hold", { ...FACTS, local_wall: "" }, "Hold?"), GateShapeError);
  assert.throws(
    () => inputRequired("hold", { ...FACTS, presentation_classes: undefined as unknown as string[] }, "Hold?"),
    GateShapeError,
  );
  // An empty class list is legitimate — a standard digital screening asserts none.
  const none = inputRequired("hold", { ...FACTS, presentation_classes: [] }, "Hold?");
  assert.deepEqual(none.inputRequests[0].presentation_classes, []);
});

test("X6b · the gate is a speed bump, not consent — nothing here records an answer", () => {
  const result = inputRequired("hold", FACTS, holdGateCaption(FACTS));
  const members = Object.keys(result.inputRequests[0]).sort();
  // No `answered`, no `consented`, no `principal_present`. A gate proves the
  // Server demanded a human decision; it does not prove a human made one.
  assert.deepEqual(members, [
    "local_wall",
    "presentation_classes",
    "prompt",
    "seat_count",
    "venue_name",
  ]);
});
