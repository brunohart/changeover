/**
 * maximalAntichain against the frozen worked example and the named edges.
 * SPEC.md §2.3 and §9.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Candidate } from "../src/poset.ts";
import type { OccasionLike } from "../src/antichain.ts";
import { antichainIds, candidateFromOccasion, maximalAntichain } from "../src/antichain.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const EMBASSY = "occ_embassy_20260829T1900_s1";
const SAT_DCP = "occ_multiplex_20260829T2100_s4";
const SUN_MATINEE = "occ_multiplex_20260830T1400_s4";

function golden(): Candidate[] {
  return [
    "occasion-embassy-sat-1900.json",
    "occasion-multiplex-sat-2100.json",
    "occasion-multiplex-sun-1400.json",
  ].map((name) =>
    candidateFromOccasion(JSON.parse(readFileSync(join(ROOT, "fixtures", "golden", name), "utf8")) as OccasionLike),
  );
}

function candidate(occasion_id: string, extra: Partial<Candidate> = {}): Candidate {
  return {
    occasion_id,
    policy: "strict",
    presentation_classes: ["pres:dcp-2k-flat"],
    occasion_classes: [],
    accepts_substitute: [],
    not_substitutable_for: [],
    facets: { instant: `2026-08-29T19:00:00+12:00`, auditorium_id: "aud_one" },
    ...extra,
  };
}

test("the golden three-Occasion case returns exactly the Embassy 35mm and the Sunday matinee", () => {
  assert.deepEqual(antichainIds(golden()), [EMBASSY, SUN_MATINEE]);
});

test("the Saturday DCP attests it accepts the 35mm, so it is dominated and dropped", () => {
  const result = maximalAntichain(golden());
  assert.deepEqual(result.dropped, [
    { occasion_id: SAT_DCP, dominated_by: [EMBASSY], axes: ["presentation_class"] },
  ]);
  const embassy = result.members.find((m) => m.occasion_id === EMBASSY);
  assert.deepEqual(embassy?.supersedes, [{ occasion_id: SAT_DCP, axes: ["presentation_class"] }]);
});

test("domination drops the cheaper option, and that is the Publisher's right to exercise", () => {
  // NZD 1400 loses to NZD 2600 because the Publisher attested the edge. §2.3's
  // named sharp edge: "the remedy is not to attest the edge."
  const documents = ["occasion-embassy-sat-1900.json", "occasion-multiplex-sat-2100.json"].map(
    (name) => JSON.parse(readFileSync(join(ROOT, "fixtures", "golden", name), "utf8")) as OccasionLike,
  );
  const amounts = documents.map((d) => ((d.offers as { amount_minor: number }[])[0]).amount_minor);
  assert.deepEqual(amounts, [2600, 1400]);
  assert.deepEqual(antichainIds(documents.map(candidateFromOccasion)), [EMBASSY]);
});

test("the Sunday matinee is incomparable and survives with accessibility as a distinguishing axis", () => {
  const result = maximalAntichain(golden());
  const sunday = result.members.find((m) => m.occasion_id === SUN_MATINEE);
  assert.ok(sunday, "the Sunday matinee survives");
  assert.equal(sunday.distinguishing_axes.includes("accessibility"), true);
  assert.deepEqual(sunday.supersedes, []);
});

test("no single optimum is returned: two options, no ranking, no price", () => {
  const result = maximalAntichain(golden());
  assert.equal(result.members.length, 2);
  for (const member of result.members) {
    assert.equal(Object.prototype.hasOwnProperty.call(member, "amount_minor"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(member, "rank"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(member, "score"), false);
  }
});

test("changing a price changes nothing: the amount never enters the selection", () => {
  const documents = golden;
  const before = maximalAntichain(documents());

  const cheapened = [
    "occasion-embassy-sat-1900.json",
    "occasion-multiplex-sat-2100.json",
    "occasion-multiplex-sun-1400.json",
  ].map((name) => {
    const document = JSON.parse(
      readFileSync(join(ROOT, "fixtures", "golden", name), "utf8"),
    ) as OccasionLike;
    for (const offer of (document.offers ?? []) as { amount_minor: number }[]) offer.amount_minor = 1;
    return candidateFromOccasion(document);
  });

  assert.deepEqual(
    maximalAntichain(cheapened).members.map((m) => m.occasion_id),
    before.members.map((m) => m.occasion_id),
  );
});

test("members come back in document order, never sorted by occasion_id (Z3)", () => {
  const candidates = [candidate("occ_zzz"), candidate("occ_aaa", { facets: { instant: "2026-08-30T14:00:00+12:00" } })];
  assert.deepEqual(antichainIds(candidates), ["occ_zzz", "occ_aaa"]);
});

test("a mutually substitutable pair is not domination: both survive", () => {
  const candidates = [
    candidate("occ_a", { accepts_substitute: [{ occasion_id: "occ_b", axis: "instant" }] }),
    candidate("occ_b", {
      accepts_substitute: [{ occasion_id: "occ_a", axis: "instant" }],
      facets: { instant: "2026-08-30T14:00:00+12:00", auditorium_id: "aud_one" },
    }),
  ];
  assert.deepEqual(antichainIds(candidates), ["occ_a", "occ_b"]);
});

test("an x- class survives domination and is surfaced as a distinguishing axis", () => {
  const candidates = [
    candidate("occ_a", { accepts_substitute: [{ occasion_id: "occ_b", axis: "presentation_class" }] }),
    candidate("occ_b", {
      presentation_classes: ["pres:dcp-2k-flat", "x-drive-in"],
      facets: { instant: "2026-08-30T14:00:00+12:00", auditorium_id: "aud_one" },
    }),
  ];
  const result = maximalAntichain(candidates);
  assert.deepEqual(result.members.map((m) => m.occasion_id), ["occ_a", "occ_b"]);
  for (const member of result.members) {
    assert.deepEqual(member.extension_classes, ["x-drive-in"]);
    assert.equal(member.distinguishing_axes.includes("presentation_class"), true);
  }
});

test("an x- class on the occasion_classes array is surfaced on that axis", () => {
  const candidates = [
    candidate("occ_a", { accepts_substitute: [{ occasion_id: "occ_b", axis: "occasion_class" }] }),
    candidate("occ_b", {
      occasion_classes: ["x-club-night"],
      facets: { instant: "2026-08-30T14:00:00+12:00", auditorium_id: "aud_one" },
    }),
  ];
  const result = maximalAntichain(candidates);
  assert.equal(result.members.length, 2);
  assert.equal(result.members[0].distinguishing_axes.includes("occasion_class"), true);
});

test("a chain collapses to its top: only the undominated survive", () => {
  const candidates = [
    candidate("occ_low", { accepts_substitute: [{ occasion_id: "occ_mid", axis: "presentation_class" }] }),
    candidate("occ_mid", {
      accepts_substitute: [{ occasion_id: "occ_top", axis: "presentation_class" }],
      facets: { instant: "2026-08-29T21:00:00+12:00", auditorium_id: "aud_one" },
    }),
    candidate("occ_top", { facets: { instant: "2026-08-30T14:00:00+12:00", auditorium_id: "aud_one" } }),
  ];
  assert.deepEqual(antichainIds(candidates), ["occ_top"]);
});

test("every member of a two-or-more candidate set carries a non-empty annotation", () => {
  const result = maximalAntichain(golden());
  for (const member of result.members) assert.ok(member.distinguishing_axes.length > 0);
});

test("the single-candidate boundary annotates nothing, and says so honestly", () => {
  // Nothing distinguishes a lone option from nothing. This is a documented
  // boundary of the annotation, not a defect: two Occasions in one cluster
  // always differ on at least `instant` or `auditorium` (SPEC.md §2.1).
  const result = maximalAntichain([candidate("occ_only")]);
  assert.deepEqual(result.members.map((m) => m.occasion_id), ["occ_only"]);
  assert.deepEqual(result.members[0].distinguishing_axes, []);
});

test("an empty candidate set returns an empty antichain rather than throwing", () => {
  const result = maximalAntichain([]);
  assert.deepEqual(result.members, []);
  assert.deepEqual(result.dropped, []);
});

test("candidateFromOccasion reads the band label and never the amount", () => {
  const document = JSON.parse(
    readFileSync(join(ROOT, "fixtures", "golden", "occasion-multiplex-sun-1400.json"), "utf8"),
  ) as OccasionLike;
  const read = candidateFromOccasion(document);
  assert.deepEqual(read.facets?.price_bands, ["Matinee"]);
  assert.equal(JSON.stringify(read).includes("1200"), false);
  assert.equal(JSON.stringify(read).includes("amount_minor"), false);
});

test("candidateFromOccasion discards an edge whose axis is not in the vocabulary", () => {
  const read = candidateFromOccasion({
    occasion_id: "occ_a",
    substitution: {
      policy: "strict",
      accepts_substitute: [
        { occasion_id: "occ_b", axis: "presentation_class" },
        { occasion_id: "occ_c", axis: "vibes" },
      ],
    },
  });
  assert.deepEqual(read.accepts_substitute, [{ occasion_id: "occ_b", axis: "presentation_class" }]);
});
