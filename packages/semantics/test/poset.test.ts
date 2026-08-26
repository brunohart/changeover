/**
 * The preorder itself: reflexivity, transitivity, asymmetry, the `x-` rule,
 * and S1/S3. SPEC.md §2.3.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Candidate } from "../src/poset.ts";
import {
  AXES,
  buildPoset,
  differingAxes,
  extensionBlock,
  incomparable,
  reachAxes,
  reaches,
  reflexivityWitness,
  refusedAxes,
  satisfiesStrictPolicy,
  strictlyDominates,
  substitutionRefusal,
  transitivityWitness,
} from "../src/poset.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function candidate(occasion_id: string, extra: Partial<Candidate> = {}): Candidate {
  return {
    occasion_id,
    policy: "strict",
    presentation_classes: ["pres:dcp-2k-flat"],
    occasion_classes: [],
    accepts_substitute: [],
    not_substitutable_for: [],
    facets: { instant: "2026-08-29T19:00:00+12:00", auditorium_id: "aud_one" },
    ...extra,
  };
}

test("the axis vocabulary is set-equal to the frozen schema, both directions", () => {
  const common = JSON.parse(readFileSync(join(ROOT, "schemas", "common.schema.json"), "utf8")) as {
    $defs: { axis: { enum: string[] } };
  };
  const fromSchema = [...common.$defs.axis.enum].sort();
  const fromModule = [...AXES].sort();
  assert.deepEqual(fromModule, fromSchema);
});

test("the relation is reflexive: every Occasion is an acceptable substitute for itself", () => {
  const poset = buildPoset([candidate("occ_a"), candidate("occ_b")]);
  assert.equal(reflexivityWitness(poset), null);
  assert.equal(reaches(poset, "occ_a", "occ_a"), true);
  assert.equal(reaches(poset, "occ_b", "occ_b"), true);
});

test("the absence of an edge is the absence of permission, never its presence", () => {
  const poset = buildPoset([candidate("occ_a"), candidate("occ_b")]);
  assert.equal(reaches(poset, "occ_a", "occ_b"), false);
  assert.equal(reaches(poset, "occ_b", "occ_a"), false);
  assert.equal(incomparable(poset, "occ_a", "occ_b"), true);
});

test("an attested edge is a permission in one direction only", () => {
  const poset = buildPoset([
    candidate("occ_a", { accepts_substitute: [{ occasion_id: "occ_b", axis: "presentation_class" }] }),
    candidate("occ_b"),
  ]);
  assert.equal(reaches(poset, "occ_a", "occ_b"), true);
  assert.equal(reaches(poset, "occ_b", "occ_a"), false);
  assert.equal(strictlyDominates(poset, "occ_b", "occ_a"), true);
  assert.equal(strictlyDominates(poset, "occ_a", "occ_b"), false);
});

test("permission composes, and the composed label is the union over the walk", () => {
  const poset = buildPoset([
    candidate("occ_a", { accepts_substitute: [{ occasion_id: "occ_b", axis: "instant" }] }),
    candidate("occ_b", { accepts_substitute: [{ occasion_id: "occ_c", axis: "presentation_class" }] }),
    candidate("occ_c"),
  ]);
  assert.equal(transitivityWitness(poset), null);
  assert.equal(reaches(poset, "occ_a", "occ_c"), true);
  assert.deepEqual(reachAxes(poset, "occ_a", "occ_c"), ["instant", "presentation_class"]);
});

test("mutual permission is not domination: a cycle leaves both standing", () => {
  const poset = buildPoset([
    candidate("occ_a", { accepts_substitute: [{ occasion_id: "occ_b", axis: "instant" }] }),
    candidate("occ_b", { accepts_substitute: [{ occasion_id: "occ_a", axis: "instant" }] }),
  ]);
  assert.equal(reaches(poset, "occ_a", "occ_b"), true);
  assert.equal(reaches(poset, "occ_b", "occ_a"), true);
  assert.equal(strictlyDominates(poset, "occ_a", "occ_b"), false);
  assert.equal(strictlyDominates(poset, "occ_b", "occ_a"), false);
});

test("a refusal is never a permission: not_substitutable_for creates no domination", () => {
  const poset = buildPoset([
    candidate("occ_a", { not_substitutable_for: [{ occasion_id: "occ_b", axis: "presentation_class" }] }),
    candidate("occ_b", { not_substitutable_for: [{ occasion_id: "occ_a", axis: "presentation_class" }] }),
  ]);
  assert.equal(reaches(poset, "occ_a", "occ_b"), false);
  assert.equal(strictlyDominates(poset, "occ_a", "occ_b"), false);
  assert.equal(strictlyDominates(poset, "occ_b", "occ_a"), false);
  assert.deepEqual(refusedAxes(poset, "occ_a", "occ_b"), ["presentation_class"]);
});

test("an x- class blocks domination in BOTH directions, attested edge or not", () => {
  const poset = buildPoset([
    candidate("occ_a", { accepts_substitute: [{ occasion_id: "occ_b", axis: "presentation_class" }] }),
    candidate("occ_b", { presentation_classes: ["pres:dcp-2k-flat", "x-drive-in"] }),
  ]);
  assert.deepEqual(extensionBlock(poset, "occ_a", "occ_b"), ["x-drive-in"]);
  assert.equal(strictlyDominates(poset, "occ_b", "occ_a"), false);
  assert.equal(strictlyDominates(poset, "occ_a", "occ_b"), false);
  assert.equal(incomparable(poset, "occ_a", "occ_b"), true);
});

test("the same x- class on both sides is not a distinction", () => {
  const poset = buildPoset([
    candidate("occ_a", {
      presentation_classes: ["pres:dcp-2k-flat", "x-drive-in"],
      accepts_substitute: [{ occasion_id: "occ_b", axis: "presentation_class" }],
    }),
    candidate("occ_b", { presentation_classes: ["pres:dcp-2k-flat", "x-drive-in"] }),
  ]);
  assert.deepEqual(extensionBlock(poset, "occ_a", "occ_b"), []);
  assert.equal(strictlyDominates(poset, "occ_b", "occ_a"), true);
});

test("an x- class MUST NOT satisfy a strict policy, even with an attested edge", () => {
  const poset = buildPoset([
    candidate("occ_a", { accepts_substitute: [{ occasion_id: "occ_b", axis: "presentation_class" }] }),
    candidate("occ_b", { occasion_classes: ["x-live-score"] }),
  ]);
  assert.equal(reaches(poset, "occ_a", "occ_b"), true, "the edge is attested");
  assert.equal(satisfiesStrictPolicy(poset, "occ_a", "occ_b"), false, "and it still does not satisfy strict");
  const refusal = substitutionRefusal(poset, "occ_a", "occ_b");
  assert.deepEqual(refusal, { from_occasion_id: "occ_a", crossed_axis: "occasion_class" });
});

test("satisfiesStrictPolicy is reflexive: holding what was asked for always satisfies", () => {
  const poset = buildPoset([candidate("occ_a"), candidate("occ_b")]);
  assert.equal(satisfiesStrictPolicy(poset, "occ_a", "occ_a"), true);
  assert.equal(substitutionRefusal(poset, "occ_a", "occ_a"), null);
});

test("S1 refuses an unattested substitution and names the Publisher's own axis", () => {
  const poset = buildPoset([
    candidate("occ_a", { not_substitutable_for: [{ occasion_id: "occ_b", axis: "presentation_class" }] }),
    candidate("occ_b"),
  ]);
  assert.deepEqual(substitutionRefusal(poset, "occ_a", "occ_b"), {
    from_occasion_id: "occ_a",
    crossed_axis: "presentation_class",
  });
});

test("S1 does not bite under an advisory policy", () => {
  const poset = buildPoset([candidate("occ_a", { policy: "advisory" }), candidate("occ_b")]);
  assert.equal(satisfiesStrictPolicy(poset, "occ_a", "occ_b"), false);
  assert.equal(substitutionRefusal(poset, "occ_a", "occ_b"), null);
});

test("S3/A5: an edge naming an unresolved Occasion is inert here and enforced at commit", () => {
  const poset = buildPoset([
    candidate("occ_a", { accepts_substitute: [{ occasion_id: "occ_unseen", axis: "instant" }] }),
    candidate("occ_b"),
  ]);
  // Inert for selection: a phantom is never a candidate, so it dominates nothing.
  assert.deepEqual([...poset.ids], ["occ_a", "occ_b"]);
  assert.equal(strictlyDominates(poset, "occ_b", "occ_a"), false);
  // Still enforced at commit.
  assert.equal(satisfiesStrictPolicy(poset, "occ_a", "occ_unseen"), true);
  assert.equal(satisfiesStrictPolicy(poset, "occ_b", "occ_unseen"), false);
});

test("differingAxes compares for equality on all seven axes, and never for order", () => {
  const left = candidate("occ_a", {
    presentation_classes: ["pres:35mm-4perf"],
    occasion_classes: ["occ:archival-print"],
    facets: {
      instant: "2026-08-29T19:00:00+12:00",
      auditorium_id: "aud_one",
      seating: "allocated",
      price_bands: ["General admission"],
      accessibility: { open_captions: "no" },
    },
  });
  const right = candidate("occ_b", {
    presentation_classes: ["pres:dcp-2k-flat"],
    occasion_classes: [],
    facets: {
      instant: "2026-08-30T14:00:00+12:00",
      auditorium_id: "aud_two",
      seating: "unallocated",
      price_bands: ["Matinee"],
      accessibility: { open_captions: "yes" },
    },
  });
  assert.deepEqual(differingAxes(left, right), [...AXES]);
  assert.deepEqual(differingAxes(left, left), []);
});

test("class arrays compare as sets, so document order is not a difference", () => {
  const left = candidate("occ_a", { presentation_classes: ["pres:dcp-2k-flat", "pres:sound-5-1"] });
  const right = candidate("occ_b", { presentation_classes: ["pres:sound-5-1", "pres:dcp-2k-flat"] });
  assert.equal(differingAxes(left, right).includes("presentation_class"), false);
});

test("a duplicate occasion_id in the candidate set is rejected, not silently merged", () => {
  assert.throws(() => buildPoset([candidate("occ_a"), candidate("occ_a")]), /duplicate occasion_id/);
});
