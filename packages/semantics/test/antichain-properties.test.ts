/**
 * Property tests over generated posets, against a second, independent,
 * deliberately naive oracle. SPEC.md §2.3.
 *
 * The fast implementation and the oracle share no code. They are compared on
 * the whole result — members in document order, their distinguishing axes,
 * their surfaced `x-` tokens, what each supersedes, and what was dropped and by
 * whom — not merely on the set of surviving ids, because an antichain that
 * returns the right options with the wrong reasons is still wrong.
 *
 * The last test in this file is the one that keeps the rest honest: a
 * plausible WRONG implementation must be caught by the oracle. A comparison
 * that cannot fail is not evidence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { maximalAntichain } from "../src/antichain.ts";
import {
  buildPoset,
  reaches,
  reflexivityWitness,
  satisfiesStrictPolicy,
  strictlyDominates,
  transitivityWitness,
} from "../src/poset.ts";
import { maximalAntichainOracle, satisfiesStrictPolicyOracle } from "./lib/antichain-oracle.ts";
import { candidateSetArbitrary, extensionCaseArbitrary } from "./lib/poset-generator.ts";

const RUNS = 500;

test("500 generated posets: the fast implementation agrees with the independent oracle", () => {
  let agreements = 0;
  let total = 0;
  fc.assert(
    fc.property(candidateSetArbitrary(), (candidates) => {
      total++;
      const fast = maximalAntichain(candidates);
      const slow = maximalAntichainOracle(candidates);
      const same =
        JSON.stringify({ members: fast.members, dropped: fast.dropped }) === JSON.stringify(slow);
      if (same) agreements++;
      return same;
    }),
    { numRuns: RUNS },
  );
  assert.equal(agreements, total);
  assert.ok(agreements >= RUNS, `expected at least ${RUNS} agreements, saw ${agreements}`);
});

test("the generated corpus is not vacuous: it contains drops, cycles, extensions and multi-member antichains", () => {
  let withDropped = 0;
  let multiMember = 0;
  let withExtensions = 0;
  let cyclic = 0;
  let total = 0;

  fc.assert(
    fc.property(candidateSetArbitrary(), (candidates) => {
      total++;
      const result = maximalAntichain(candidates);
      if (result.dropped.length > 0) withDropped++;
      if (result.members.length > 1) multiMember++;
      if (result.members.some((m) => m.extension_classes.length > 0)) withExtensions++;
      const poset = result.poset;
      for (const a of poset.ids) {
        for (const b of poset.ids) {
          if (a !== b && reaches(poset, a, b) && reaches(poset, b, a)) {
            cyclic++;
            return true;
          }
        }
      }
      return true;
    }),
    { numRuns: RUNS },
  );

  assert.ok(withDropped > total / 10, `only ${withDropped}/${total} posets dropped anything`);
  assert.ok(multiMember > total / 2, `only ${multiMember}/${total} antichains had more than one member`);
  assert.ok(withExtensions > total / 10, `only ${withExtensions}/${total} posets carried an x- class`);
  assert.ok(cyclic > total / 10, `only ${cyclic}/${total} relations contained a cycle`);
});

test("the derived relation is reflexive over every generated poset", () => {
  fc.assert(
    fc.property(candidateSetArbitrary(), (candidates) => reflexivityWitness(buildPoset(candidates)) === null),
    { numRuns: RUNS },
  );
});

test("the attested closure is transitive over every generated poset", () => {
  fc.assert(
    fc.property(candidateSetArbitrary(), (candidates) => transitivityWitness(buildPoset(candidates)) === null),
    { numRuns: RUNS },
  );
});

test("the returned set is exactly the non-dominated set", () => {
  fc.assert(
    fc.property(candidateSetArbitrary(), (candidates) => {
      const result = maximalAntichain(candidates);
      const poset = result.poset;
      const returned = new Set(result.members.map((m) => m.occasion_id));

      for (const id of poset.ids) {
        const dominated = poset.ids.some((other) => strictlyDominates(poset, other, id));
        if (dominated === returned.has(id)) return false;
      }
      // No returned member dominates another returned member: it is an ANTICHAIN.
      for (const a of returned) {
        for (const b of returned) {
          if (a !== b && strictlyDominates(poset, a, b)) return false;
        }
      }
      // Nothing is both returned and dropped, and together they are the whole set.
      const dropped = result.dropped.map((d) => d.occasion_id);
      if (dropped.some((id) => returned.has(id))) return false;
      return returned.size + dropped.length === poset.ids.length;
    }),
    { numRuns: RUNS },
  );
});

test("every returned member carries a non-empty distinguishing-axes annotation", () => {
  fc.assert(
    fc.property(candidateSetArbitrary(), (candidates) =>
      maximalAntichain(candidates).members.every((member) => member.distinguishing_axes.length > 0),
    ),
    { numRuns: RUNS },
  );
});

test("an x- class is incomparable in BOTH directions and does not satisfy a strict policy", () => {
  fc.assert(
    fc.property(extensionCaseArbitrary(), ({ candidates, lower_id, upper_id, token }) => {
      const poset = buildPoset(candidates);

      // The edge IS attested: without the extension rule, upper dominates lower.
      if (!reaches(poset, lower_id, upper_id)) return false;

      // Domination is established in neither direction.
      if (strictlyDominates(poset, upper_id, lower_id)) return false;
      if (strictlyDominates(poset, lower_id, upper_id)) return false;

      // And the attested edge does not satisfy the strict policy, either way.
      if (satisfiesStrictPolicy(poset, lower_id, upper_id)) return false;
      if (satisfiesStrictPolicy(poset, upper_id, lower_id)) return false;
      if (satisfiesStrictPolicyOracle(candidates, lower_id, upper_id)) return false;

      // Both survive, and the token is surfaced on both.
      const result = maximalAntichain(candidates);
      if (result.members.length !== 2) return false;
      return result.members.every(
        (member) =>
          member.extension_classes.includes(token) &&
          (member.distinguishing_axes.includes("presentation_class") ||
            member.distinguishing_axes.includes("occasion_class")),
      );
    }),
    { numRuns: RUNS },
  );
});

test("satisfiesStrictPolicy agrees with the oracle over every generated pair", () => {
  fc.assert(
    fc.property(candidateSetArbitrary(), (candidates) => {
      const poset = buildPoset(candidates);
      for (const sought of poset.ids) {
        for (const offered of poset.ids) {
          if (satisfiesStrictPolicy(poset, sought, offered) !== satisfiesStrictPolicyOracle(candidates, sought, offered)) {
            return false;
          }
        }
      }
      return true;
    }),
    { numRuns: RUNS },
  );
});

test("the comparison has teeth: a plausible wrong implementation is caught", () => {
  // The wrong implementation drops on reachability alone — no check that the
  // permission is one-way, no x- block. It is the shape of the bug an
  // implementer actually writes, and the oracle must catch it.
  let caught = 0;
  let total = 0;
  fc.assert(
    fc.property(candidateSetArbitrary(), (candidates) => {
      total++;
      const poset = buildPoset(candidates);
      const wrong = poset.ids.filter((s) => !poset.ids.some((t) => t !== s && reaches(poset, s, t)));
      const truth = maximalAntichainOracle(candidates).members.map((m) => m.occasion_id);
      if (JSON.stringify(wrong) !== JSON.stringify(truth)) caught++;
      return true;
    }),
    { numRuns: RUNS },
  );
  assert.ok(caught > total / 2, `the oracle only caught the wrong implementation on ${caught}/${total} posets`);
});
