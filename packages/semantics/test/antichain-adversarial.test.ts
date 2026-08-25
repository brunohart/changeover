/**
 * A second corpus, hostile where poset-generator.ts is well-behaved.
 *
 * The committed generator is deliberately well-formed: G2 gives every candidate
 * a DISTINCT (instant, auditorium) pair, no candidate ever attests an edge to
 * itself, no edge is ever emitted twice, and every class array is non-empty.
 * Those are the properties of real published data — which is exactly why a
 * corpus made only of them cannot find the bugs that live at the seams.
 *
 * So this file generates the data a Publisher should never emit and a Server
 * must survive anyway: two Occasions sharing a room AND an instant, a candidate
 * attesting itself as its own substitute, the same edge twice with different
 * axes, empty `presentation_classes`, an `x-` token on both arrays at once,
 * and a phantom target drawn as often as a real one. The fast path and the
 * independent oracle are compared on every one.
 *
 * There is no fast-check here on purpose. The arbitraries live beside the
 * oracle, and a corpus meant to check the corpus should not be drawn by the
 * same machinery. A hand-rolled LCG, seeded, gives a deterministic 3000-case
 * run whose failures are reproducible from the seed printed in the assertion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Candidate } from "../src/poset.ts";
import { maximalAntichain } from "../src/antichain.ts";
import { maximalAntichainOracle, satisfiesStrictPolicyOracle } from "./lib/antichain-oracle.ts";
import type { OracleCandidate } from "./lib/antichain-oracle.ts";
import { buildPoset, satisfiesStrictPolicy } from "../src/poset.ts";

const AXES = [
  "instant", "auditorium", "presentation_class", "occasion_class",
  "price_band", "seat", "accessibility",
] as const;
type Axis = (typeof AXES)[number];

const SEED = 20260825;
const CASES = 3000;

/** mulberry-flavoured LCG. Six lines beats a dependency in a test corpus. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const BANDS: string[][] = [[], ["GA"], ["GA", "Concession"], ["Concession", "GA"]];
const ACCESS: Record<string, string>[] = [{}, { open_captions: "yes" }, { open_captions: "no" }];

/**
 * One hostile candidate set. Every dial here is a property the committed
 * generator holds fixed.
 */
function adversarial(next: () => number): Candidate[] {
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
  const size = 1 + Math.floor(next() * 6);
  const ids = Array.from({ length: size }, (_, i) => `occ_${i}`);
  const targets = [...ids, "occ_never_resolved"];

  return ids.map((occasion_id) => {
    const accepts: { occasion_id: string; axis: Axis }[] = [];
    const refuses: { occasion_id: string; axis: Axis }[] = [];
    for (let k = 0; k < 6; k++) {
      // Self-edges and duplicates are DRAWN, not avoided.
      if (next() < 0.35) accepts.push({ occasion_id: pick([...targets, occasion_id]), axis: pick(AXES) });
      if (next() < 0.2) refuses.push({ occasion_id: pick([...targets, occasion_id]), axis: pick(AXES) });
    }
    const token = next() < 0.4 ? pick(["x-drive-in", "x-singalong", "x-live-score"]) : null;
    const bothArrays = token !== null && next() < 0.3;

    return {
      occasion_id,
      policy: next() < 0.5 ? "strict" : "advisory",
      presentation_classes: [
        ...(next() < 0.7 ? ["pres:dcp-2k-flat"] : []),
        ...(token !== null && (bothArrays || next() < 0.5) ? [token] : []),
      ],
      occasion_classes: [
        ...(next() < 0.3 ? ["occ:archival-print"] : []),
        ...(token !== null && bothArrays ? [token] : []),
      ],
      accepts_substitute: accepts,
      not_substitutable_for: refuses,
      facets: {
        // Two candidates may share BOTH, which G2 forbids by construction.
        instant: pick(["2026-08-29T19:00:00+12:00", "2026-08-29T21:00:00+12:00"]),
        auditorium_id: pick(["aud_one", "aud_two"]),
        seating: pick(["allocated", "unallocated", "unknown"]),
        price_bands: pick(BANDS),
        accessibility: pick(ACCESS),
      },
    };
  });
}

test(`${CASES} hostile candidate sets: the fast path still agrees with the independent oracle`, () => {
  const next = rng(SEED);
  let agreements = 0;
  let firstDisagreement: string | null = null;

  for (let i = 0; i < CASES; i++) {
    const candidates = adversarial(next);
    const fast = maximalAntichain(candidates);
    const slow = maximalAntichainOracle(candidates as unknown as OracleCandidate[]);
    if (JSON.stringify({ members: fast.members, dropped: fast.dropped }) === JSON.stringify(slow)) {
      agreements++;
    } else if (firstDisagreement === null) {
      firstDisagreement = JSON.stringify(candidates);
    }
  }

  assert.equal(
    agreements,
    CASES,
    `seed ${SEED}: disagreed on ${CASES - agreements} hostile sets; first was ${firstDisagreement}`,
  );
});

test("hostile sets: satisfiesStrictPolicy agrees with the oracle on every ordered pair", () => {
  const next = rng(SEED + 1);
  let pairs = 0;

  for (let i = 0; i < 500; i++) {
    const candidates = adversarial(next);
    const poset = buildPoset(candidates);
    for (const sought of poset.ids) {
      for (const offered of poset.ids) {
        pairs++;
        assert.equal(
          satisfiesStrictPolicy(poset, sought, offered),
          satisfiesStrictPolicyOracle(candidates as unknown as OracleCandidate[], sought, offered),
          `S1 disagreement on ${sought} -> ${offered} (seed ${SEED + 1})`,
        );
      }
    }
  }
  assert.ok(pairs > 1000, `only ${pairs} ordered pairs were compared`);
});

test("a candidate attesting itself as its own substitute changes nothing: reflexivity is not a row", () => {
  const base = (occasion_id: string, extra: Partial<Candidate>): Candidate => ({
    occasion_id,
    policy: "strict",
    presentation_classes: ["pres:dcp-2k-flat"],
    occasion_classes: [],
    accepts_substitute: [],
    not_substitutable_for: [],
    facets: { instant: "2026-08-29T19:00:00+12:00", auditorium_id: "aud_one" },
    ...extra,
  });

  const without = [
    base("occ_a", { accepts_substitute: [{ occasion_id: "occ_b", axis: "presentation_class" }] }),
    base("occ_b", { facets: { instant: "2026-08-30T14:00:00+12:00", auditorium_id: "aud_one" } }),
  ];
  const with_self = [
    base("occ_a", {
      accepts_substitute: [
        { occasion_id: "occ_a", axis: "instant" },
        { occasion_id: "occ_b", axis: "presentation_class" },
      ],
    }),
    base("occ_b", {
      accepts_substitute: [{ occasion_id: "occ_b", axis: "seat" }],
      facets: { instant: "2026-08-30T14:00:00+12:00", auditorium_id: "aud_one" },
    }),
  ];

  assert.deepEqual(maximalAntichain(with_self).members, maximalAntichain(without).members);
  assert.deepEqual(maximalAntichain(with_self).dropped, maximalAntichain(without).dropped);
});

test("the same edge attested twice on two axes carries BOTH axes, and neither is lost", () => {
  const candidates: Candidate[] = [
    {
      occasion_id: "occ_low",
      policy: "strict",
      presentation_classes: ["pres:dcp-2k-flat"],
      occasion_classes: [],
      accepts_substitute: [
        { occasion_id: "occ_top", axis: "presentation_class" },
        { occasion_id: "occ_top", axis: "instant" },
      ],
      not_substitutable_for: [],
      facets: { instant: "2026-08-29T19:00:00+12:00", auditorium_id: "aud_one" },
    },
    {
      occasion_id: "occ_top",
      policy: "strict",
      presentation_classes: ["pres:35mm-4perf"],
      occasion_classes: [],
      accepts_substitute: [],
      not_substitutable_for: [],
      facets: { instant: "2026-08-30T14:00:00+12:00", auditorium_id: "aud_one" },
    },
  ];

  const result = maximalAntichain(candidates);
  // Axis order is the frozen one: instant precedes presentation_class.
  assert.deepEqual(result.dropped, [
    { occasion_id: "occ_low", dominated_by: ["occ_top"], axes: ["instant", "presentation_class"] },
  ]);
  assert.deepEqual(
    maximalAntichainOracle(candidates as unknown as OracleCandidate[]).dropped,
    result.dropped,
  );
});

test("two Occasions sharing a room AND an instant still annotate honestly", () => {
  // G2 forbids this by construction; a Server receiving it must not produce an
  // empty annotation silently. They differ on presentation_class, so they do not.
  const candidates: Candidate[] = [
    {
      occasion_id: "occ_a",
      policy: "strict",
      presentation_classes: ["pres:35mm-4perf"],
      occasion_classes: [],
      accepts_substitute: [],
      not_substitutable_for: [],
      facets: { instant: "2026-08-29T19:00:00+12:00", auditorium_id: "aud_one" },
    },
    {
      occasion_id: "occ_b",
      policy: "strict",
      presentation_classes: ["pres:dcp-2k-flat"],
      occasion_classes: [],
      accepts_substitute: [],
      not_substitutable_for: [],
      facets: { instant: "2026-08-29T19:00:00+12:00", auditorium_id: "aud_one" },
    },
  ];
  const result = maximalAntichain(candidates);
  assert.deepEqual(result.members.map((m) => m.occasion_id), ["occ_a", "occ_b"]);
  for (const member of result.members) {
    assert.deepEqual(member.distinguishing_axes, ["presentation_class"]);
  }
});
