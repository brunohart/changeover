/**
 * The two things the differential property tests QUIETLY ASSUME, asserted.
 *
 * antichain-properties.test.ts compares `maximalAntichain` against the oracle
 * over a generated corpus. That comparison is evidence only if two facts hold,
 * and neither of them was being checked:
 *
 *   1. The oracle shares no code with the implementation. The moment it imports
 *      poset.ts — for an axis order, for `extensionBlock`, for a type — the
 *      property test proves that a program agrees with itself, and it goes on
 *      passing while both sides are wrong in the same way. The file says it
 *      imports nothing; this asserts it, so the claim survives an edit.
 *
 *   2. The corpus exercises B4, rather than merely containing an `x-` class.
 *      The vacuity test counted posets where a SURVIVING MEMBER surfaced a
 *      token — which is satisfied by a token that never blocked anything. What
 *      B4 actually claims is that an attested one-way permission, which would
 *      otherwise establish domination, is VOIDED by an `x-` class. If the
 *      generator drifts so that case away, every extension assertion in this
 *      package becomes vacuously true and nothing goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";

import { buildPoset, extensionBlock, reaches, strictlyDominates } from "../src/poset.ts";
import { candidateSetArbitrary } from "./lib/poset-generator.ts";

const RUNS = 500;
const ORACLE = join(import.meta.dirname, "lib", "antichain-oracle.ts");

test("the oracle imports nothing: it shares no module, helper, type or constant with the implementation", () => {
  const source = readFileSync(ORACLE, "utf8");
  const borrowed = source
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line) || /\brequire\s*\(/.test(line) || /\bawait\s+import\s*\(/.test(line));
  assert.deepEqual(
    borrowed,
    [],
    "an oracle that imports the implementation proves only that a program agrees with itself",
  );
});

test("the generated corpus VOIDS dominations with x- classes, not merely surfaces tokens", () => {
  let voided = 0;
  let total = 0;

  fc.assert(
    fc.property(candidateSetArbitrary(), (candidates) => {
      total++;
      const poset = buildPoset(candidates);
      for (const a of poset.ids) {
        for (const b of poset.ids) {
          if (a === b) continue;
          // An attested one-way permission: without B4, b strictly dominates a.
          if (!reaches(poset, a, b)) continue;
          if (reaches(poset, b, a)) continue;
          if (extensionBlock(poset, a, b).length === 0) continue;
          voided++;
          // And the void is total: neither direction survives as domination.
          assert.equal(strictlyDominates(poset, b, a), false);
          assert.equal(strictlyDominates(poset, a, b), false);
          return true;
        }
      }
      return true;
    }),
    { numRuns: RUNS },
  );

  assert.ok(
    voided > total / 10,
    `only ${voided}/${total} posets had a domination actually voided by an x- class; ` +
      "every extension assertion in this package is vacuous below that",
  );
});
