/**
 * The demo, asserted. Owner: DEMO-001.
 *
 * Two halves, deliberately separated by cost. The estate and the pure functions
 * are asserted with nothing running, because a property of a fixture should not
 * need a database to check. The run itself boots once, in `before`, and every
 * assertion below it reads the same result object — the same object
 * `prove_cold_start.sh` reads, so a test and the gate cannot come to different
 * conclusions about one run.
 *
 * Living under `src/demo/` rather than `packages/cli/test/` is an ownership
 * decision, not a style one: DEMO-001 owns `packages/cli/src/demo/**` outright
 * and `packages/cli/test/` belongs to another item. `node --test` discovers by
 * filename and does not care.
 */

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { REFUSAL_STATUS } from "@changeover/schema/refusal.ts";
import {
  NZ_FOUR_SITE,
  NZ_OCCASION,
  NZ_ORIGIN_CIRCUIT,
  NZ_ORIGIN_INDEPENDENT,
  nzFourSiteEstate,
  occasionsAtOrigin,
} from "@changeover/store/fixtures.ts";
// ADAPT-001's compiled validators, named as a precondition rather than
// duplicated. `ajv` is not a dependency of this package and should not become
// one: validating a document is a thing a harness does, not a thing a CLI does
// on the way to printing.
import {
  OCCASION_SCHEMA_ID,
  schemaValidator,
} from "../../../adapter-reference/test/lib/schema-validator.ts";

import { intentDigest, refusalOf } from "./agent.ts";
import type { Wire } from "./agent.ts";
import { EXPECTED_REFUSALS, REEL_IDS } from "./reels.ts";
import type { Reel } from "./reels.ts";
import { fingerprintOf, runDemo, verdictOf } from "./run.ts";
import type { DemoResult } from "./run.ts";
import { transcript } from "./transcript.ts";
import { BUDGET_MS, parseFlags } from "../commands/demo.ts";

/* ── 1 · The estate, with nothing running ──────────────────────────────────── */

describe("the four-site estate", () => {
  test("is four venues across exactly two origins", () => {
    assert.equal(NZ_FOUR_SITE.occasions.length, 4);
    const origins = new Set(NZ_FOUR_SITE.occasions.map((o) => o.origin));
    assert.deepEqual([...origins].sort(), [NZ_ORIGIN_CIRCUIT, NZ_ORIGIN_INDEPENDENT].sort());
    assert.equal(occasionsAtOrigin(NZ_FOUR_SITE, NZ_ORIGIN_CIRCUIT).occasions.length, 3);
    assert.equal(occasionsAtOrigin(NZ_FOUR_SITE, NZ_ORIGIN_INDEPENDENT).occasions.length, 1);
  });

  test("every published document validates against the frozen Occasion schema", () => {
    const validate = schemaValidator();
    for (const occasion of NZ_FOUR_SITE.occasions) {
      assert.equal(
        validate(OCCASION_SCHEMA_ID, occasion.document),
        null,
        `${occasion.occasion_id} does not validate`,
      );
    }
  });

  test("E1: no substitution edge leaves its own origin", () => {
    const originOf = new Map(NZ_FOUR_SITE.occasions.map((o) => [o.occasion_id, o.origin]));
    for (const occasion of NZ_FOUR_SITE.occasions) {
      const substitution = (occasion.document as Record<string, any>).substitution;
      const edges = [
        ...(substitution.accepts_substitute ?? []),
        ...(substitution.not_substitutable_for ?? []),
      ] as { occasion_id: string }[];
      for (const edge of edges) {
        assert.equal(
          originOf.get(edge.occasion_id),
          occasion.origin,
          `${occasion.occasion_id} attests an edge to ${edge.occasion_id} at another origin`,
        );
      }
    }
  });

  test("every screening is still ahead of the clock, and stops selling after it starts", () => {
    const now = Date.now();
    for (const occasion of NZ_FOUR_SITE.occasions) {
      assert.ok(
        Date.parse(occasion.starts_at) > now,
        `${occasion.occasion_id} starts in the past, so G1 step 6 would refuse it`,
      );
      assert.ok(Date.parse(occasion.sales_cutoff_at as string) > Date.parse(occasion.starts_at));
    }
  });

  test("the ids do not lie about which day they fall on", () => {
    const weekday = (at: string): string =>
      new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Auckland", weekday: "short" })
        .format(new Date(at))
        .toLowerCase();
    for (const occasion of NZ_FOUR_SITE.occasions) {
      const named = /_(fri|sat|sun)_/.exec(occasion.occasion_id)?.[1];
      assert.ok(named, `${occasion.occasion_id} names no weekday`);
      assert.equal(weekday(occasion.starts_at), named, occasion.occasion_id);
    }
  });

  test("is deterministic given one reference instant", () => {
    const at = new Date("2026-03-04T02:00:00Z");
    assert.deepEqual(nzFourSiteEstate(at), nzFourSiteEstate(at));
  });

  test("the independent publishes no availability it does not have", () => {
    const whitcombe = NZ_FOUR_SITE.occasions.find((o) => o.occasion_id === NZ_OCCASION.whitcombe);
    const availability = (whitcombe?.document as Record<string, any>).availability;
    assert.equal(availability.mode, "unknown");
    assert.equal(availability.staleness_basis, "unknown");
    // Neither sold out nor available: both members are ABSENT, not zeroed.
    assert.ok(!("sold_out" in availability));
    assert.ok(!("seats_available" in availability));
  });
});

/* ── 2 · Reading a refusal, with nothing running ───────────────────────────── */

function wireOf(status: number, body: unknown): Wire {
  return {
    method: "POST",
    path: "/changeover/v0/holds",
    status,
    ms: 1,
    body,
    content_type: "application/problem+json",
    server_time: "2026-08-25T19:00:00+12:00",
    retry_after: null,
  };
}

const refusalBody = (code: string) => ({
  refused: true,
  code,
  remediation: "re_resolve",
  reason: { content_type: "text/plain", value: "no" },
  type: `urn:changeover:refusal:${code}`,
  status: REFUSAL_STATUS[code as "hold_expired"],
  title: code,
});

describe("refusalOf", () => {
  test("admits a refusal the binding and the taxonomy agree on", () => {
    const read = refusalOf(wireOf(412, refusalBody("substitution_refused")));
    assert.equal(read?.code, "substitution_refused");
    assert.equal(read?.status, 412);
  });

  test("refuses a body whose status contradicts its own code", () => {
    // 200 with a refusal body is a binding disagreeing with itself, and counting
    // it would let a demo report a refusal nothing refused.
    assert.equal(refusalOf(wireOf(200, refusalBody("substitution_refused"))), null);
    assert.equal(refusalOf(wireOf(409, refusalBody("substitution_refused"))), null);
  });

  test("refuses a code outside the closed thirty-two", () => {
    assert.equal(refusalOf(wireOf(409, { ...refusalBody("hold_expired"), code: "seats_gone" })), null);
  });

  test("refuses a URN naming a different code than the body does", () => {
    const body = { ...refusalBody("hold_expired"), type: "urn:changeover:refusal:hold_revoked" };
    assert.equal(refusalOf(wireOf(409, body)), null);
  });

  test("returns null for a granted Hold, and for a body that merely looks unhappy", () => {
    assert.equal(refusalOf(wireOf(201, { hold_id: "hold_x", state: "live" })), null);
    assert.equal(refusalOf(wireOf(409, { error: "seat taken" })), null);
    assert.equal(refusalOf(wireOf(500, undefined)), null);
  });
});

describe("what an Agent mints", () => {
  test("intent_digest matches D3's pattern and is random per intent (D2)", () => {
    const a = intentDigest();
    const b = intentDigest();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.match(b, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
  });
});

describe("the command's flags", () => {
  test("are read from argv and default to the full transcript", () => {
    assert.deepEqual(parseFlags([]), { json: false, quiet: false, fast: false });
    assert.deepEqual(parseFlags(["--json", "--fast"]), { json: true, quiet: false, fast: true });
  });
});

/* ── 3 · The verdict, over a synthetic result ──────────────────────────────── */

function reelStub(n: number, id: (typeof REEL_IDS)[number], code: string | null): Reel {
  return {
    n,
    id,
    title: id,
    premise: "",
    outcome: code === null ? "ok" : "refused",
    refusal:
      code === null
        ? null
        : {
          code: code as "hold_expired",
          remediation: "re_resolve",
          status: REFUSAL_STATUS[code as "hold_expired"],
          reason: "",
          detail: { expired_at: "x" },
          retry_after_ms: null,
          method: "POST",
          path: "/changeover/v0/holds",
        },
    beats: [],
    ms: 1,
  };
}

function stubResult(codes: readonly (string | null)[]): DemoResult {
  const reels = REEL_IDS.map((id, i) => reelStub(i + 1, id, codes[i] ?? null));
  const refusals = reels.map((r) => r.refusal).filter((r) => r !== null);
  return {
    reels,
    refusals,
    codes: refusals.map((r) => r.code),
    boot_ms: 1,
    reels_ms: 1,
    total_ms: 2,
    floor: {
      circuit_policy_max_floor_ms: 14000,
      observations: 2,
      min_observed_retention_ms: 14500,
      safety_margin_ms: 500,
      violations: 0,
    },
    fingerprint: fingerprintOf(reels),
  };
}

const HEALTHY = [null, null, "cluster_fanout", "substitution_refused", "availability_unknown", null, "hold_expired"];

describe("verdictOf", () => {
  test("holds on a run that refused exactly the four, in order", () => {
    assert.equal(verdictOf(stubResult(HEALTHY), BUDGET_MS).held, true);
  });

  test("does NOT hold when a reel that should refuse succeeded", () => {
    const missing = [...HEALTHY];
    missing[3] = null;
    assert.equal(verdictOf(stubResult(missing), BUDGET_MS).held, false);
  });

  test("does NOT hold when the four arrive in a different order", () => {
    const shuffled = [null, null, "substitution_refused", "cluster_fanout", "availability_unknown", null, "hold_expired"];
    assert.equal(verdictOf(stubResult(shuffled), BUDGET_MS).held, false);
  });

  test("does NOT hold when the run ran over its budget", () => {
    assert.equal(verdictOf({ ...stubResult(HEALTHY), total_ms: BUDGET_MS + 1 }, BUDGET_MS).held, false);
  });

  test("does NOT hold when the floor was published without being measured", () => {
    const unmeasured = { ...stubResult(HEALTHY) };
    assert.equal(
      verdictOf({ ...unmeasured, floor: { ...unmeasured.floor, observations: 0 } }, BUDGET_MS).held,
      false,
    );
  });
});

/* ── 4 · One real run ──────────────────────────────────────────────────────── */

describe("the run itself", () => {
  let result: DemoResult;

  before(async () => {
    // One trial over a short window: this is a test of the reels, not of the
    // measurement, and `prove_cold_start.sh` runs the published defaults.
    result = await runDemo({ floor_trials: 1, probe_floor_ms: 6000 });
  }, { timeout: 120000 });

  test("plays seven reels, in the order the transcript claims", () => {
    assert.equal(result.reels.length, 7);
    assert.deepEqual(result.reels.map((r) => r.id), [...REEL_IDS]);
    assert.deepEqual(result.reels.map((r) => r.n), [1, 2, 3, 4, 5, 6, 7]);
  });

  test("refuses exactly four times, with exactly the expected codes", () => {
    assert.equal(result.refusals.length, 4);
    assert.deepEqual(result.codes, [...EXPECTED_REFUSALS]);
  });

  test("the three reels that must succeed did", () => {
    const ok = result.reels.filter((r) => r.refusal === null).map((r) => r.id);
    assert.deepEqual(ok, ["resolve", "hold", "hand_off"]);
  });

  test("every refusal's status is the one §6.3 fixes for its code", () => {
    for (const refusal of result.refusals) {
      assert.equal(refusal.status, REFUSAL_STATUS[refusal.code], refusal.code);
    }
  });

  test("substitution_refused names the Occasion the customer chose and the axis crossed", () => {
    const refusal = result.refusals.find((r) => r.code === "substitution_refused");
    assert.equal(refusal?.detail?.from_occasion_id, NZ_OCCASION.kereru);
    assert.equal(refusal?.detail?.crossed_axis, "presentation_class");
    assert.equal(refusal?.remediation, "re_resolve");
  });

  test("cluster_fanout names the conflicting Hold, the cluster and the limit", () => {
    const refusal = result.refusals.find((r) => r.code === "cluster_fanout");
    assert.match(String(refusal?.detail?.conflicting_hold_id), /^hold_[0-9A-HJKMNP-TV-Z]{32}$/);
    assert.equal(refusal?.detail?.cluster, "the-conversation-2026-w35");
    assert.equal(refusal?.detail?.limit, 1);
    assert.equal(refusal?.remediation, "release_conflicting_hold");
  });

  test("hold_expired names when it expired and what it was for", () => {
    const refusal = result.refusals.find((r) => r.code === "hold_expired");
    assert.equal(refusal?.detail?.occasion_id, NZ_OCCASION.totara_2);
    assert.match(String(refusal?.detail?.expired_at), /^\d{4}-\d{2}-\d{2}T/);
  });

  test("the floor it published was measured, and nothing violated it", () => {
    assert.ok(result.floor.observations > 0);
    assert.equal(result.floor.violations, 0);
    assert.ok(
      result.floor.circuit_policy_max_floor_ms <=
        result.floor.min_observed_retention_ms - result.floor.safety_margin_ms,
      "a floor was published above what the measurement warrants",
    );
  });

  test("the gate holds, and the run fits its budget", () => {
    const verdict = verdictOf(result, BUDGET_MS);
    assert.equal(verdict.held, true, verdict.checks.filter((c) => !c.ok).map((c) => c.text).join("; "));
    assert.ok(result.total_ms < BUDGET_MS);
  });

  test("the fingerprint is the shape, and does not carry a timing or a hold id", () => {
    assert.equal(result.fingerprint, fingerprintOf(result.reels));
    assert.match(result.fingerprint, /^1:resolve:ok\|2:hold:ok\|3:cluster_fanout:refused:cluster_fanout:429/);
    assert.doesNotMatch(result.fingerprint, /hold_[0-9A-HJKMNP-TV-Z]{32}/);
    assert.doesNotMatch(result.fingerprint, /\dms/);
  });

  test("the transcript renders every reel and says whether the gate held", () => {
    const text = transcript(result, verdictOf(result, BUDGET_MS));
    for (const reel of result.reels) assert.ok(text.includes(`REEL ${reel.n}/7`), `reel ${reel.n} missing`);
    assert.ok(text.includes("the gate holds."));
    // Every refusal appears as its code, from the object — never as prose only.
    for (const refusal of result.refusals) assert.ok(text.includes(refusal.code));
  });

  test("C-ABSENCE.1's pattern finds nothing on the transcript's machine surface", () => {
    // The pattern `prove_no_settlement_verb.sh` applies to `verbs.json`, applied
    // here to the machine-readable half of the transcript: every code, every
    // remediation, every route the run actually called, and the fingerprint.
    //
    // Deliberately NOT applied to the prose. The contract is explicit that this
    // pattern "is not applied to arbitrary source, and it must not be" — it
    // matches substrings, and the demo's central sentence is that there is no
    // settlement verb. A test that forced that sentence out to stay green would
    // be deleting the claim to satisfy the check written to protect it.
    const machine = [
      ...result.codes,
      ...result.refusals.map((r) => r.remediation),
      ...result.refusals.map((r) => r.path),
      ...result.reels.map((r) => r.id),
      result.fingerprint,
    ].join(" ");
    const hits = machine.match(/settle|pay|capture|refund|charge/gi) ?? [];
    assert.deepEqual(hits, [], `the machine surface says: ${hits.join(", ")}`);
  });

  test("the only settlement word in the prose is the one saying there is not one", () => {
    // Whitespace-collapsed first: the header wraps at 78 columns, so the claim
    // can arrive with a newline inside it and a window taken from the raw text
    // would fail on the line break rather than on the word.
    const text = transcript(result, verdictOf(result, BUDGET_MS)).replace(/\s+/g, " ");
    for (const match of text.matchAll(/settle|pay|capture|refund|charge/gi)) {
      const around = text.slice(Math.max(0, (match.index ?? 0) - 12), (match.index ?? 0) + 24);
      assert.match(
        around,
        /no settlement verb/,
        `the transcript uses a settlement word outside the claim that there is none: "${around}"`,
      );
    }
  });
});
