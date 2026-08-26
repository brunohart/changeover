#!/usr/bin/env bash
# C-SUBST, from the agent side. SPEC.md 2.3: the maximal antichain is every
# non-dominated option with its distinguishing axes, never a single optimum,
# and never a ranking by price.
#
# The obvious cheaper check — assert the antichain looks like an antichain —
# passes on an implementation that is wrong in one consistent direction, which
# is exactly how this algorithm goes wrong. So the claim here is a DIFFERENTIAL
# one: a second, deliberately naive implementation of the same five specified
# lines (packages/semantics/test/lib/antichain-oracle.ts, index-based boolean
# matrices relaxed over all triples, O(n^4), unusable and obviously right) is
# compared against the fast path over 500 generated posets, on the WHOLE result
# — members in document order, their distinguishing axes, their surfaced x-
# tokens, what each supersedes, and what was dropped and by whom. An oracle that
# imported the implementation would prove only that a program agrees with
# itself, so its independence is asserted textually before it is trusted, and
# the corpus is asserted non-vacuous before agreement over it means anything.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/fast-check ] || { echo "cannot prove — fast-check not installed; run npm install at the repository root"; exit 2; }
[ -f packages/semantics/src/antichain.ts ] || { echo "cannot prove — packages/semantics/src/antichain.ts missing"; exit 2; }
[ -f packages/semantics/src/poset.ts ]     || { echo "cannot prove — packages/semantics/src/poset.ts missing"; exit 2; }
[ -f packages/semantics/test/lib/antichain-oracle.ts ] || { echo "cannot prove — packages/semantics/test/lib/antichain-oracle.ts missing; the antichain has nothing independent to be compared against"; exit 2; }
[ -f packages/semantics/test/lib/poset-generator.ts ]  || { echo "cannot prove — packages/semantics/test/lib/poset-generator.ts missing; there is no corpus to compare over"; exit 2; }
[ -f schemas/common.schema.json ] || { echo "cannot prove — schemas/common.schema.json missing; the axis vocabulary has no frozen source"; exit 2; }
for f in occasion-embassy-sat-1900 occasion-multiplex-sat-2100 occasion-multiplex-sun-1400; do
  [ -f "fixtures/golden/$f.json" ] || { echo "cannot prove — fixtures/golden/$f.json missing; the frozen worked example is the only non-generated case here"; exit 2; }
done

node --input-type=module -e '
import { readFileSync } from "node:fs";
import fc from "fast-check";

import { antichainIds, candidateFromOccasion, maximalAntichain } from "./packages/semantics/src/antichain.ts";
import {
  AXES, buildPoset, extensionBlock, reaches, reflexivityWitness,
  satisfiesStrictPolicy, strictlyDominates, transitivityWitness,
} from "./packages/semantics/src/poset.ts";
import { maximalAntichainOracle, satisfiesStrictPolicyOracle } from "./packages/semantics/test/lib/antichain-oracle.ts";
import { candidateSetArbitrary, extensionCaseArbitrary } from "./packages/semantics/test/lib/poset-generator.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const RUNS = 500;
// Pinned so a disagreement is reproducible by anyone who reads this output. A
// proof that draws a fresh corpus every run reports a different fact each time.
const SEED = Number(process.env.CHANGEOVER_ANTICHAIN_SEED || 20260825);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- 1. the oracle is independent, or nothing below means anything ------- */

const oracleSource = readFileSync("packages/semantics/test/lib/antichain-oracle.ts", "utf8");
const borrowed = oracleSource
  .split("\n")
  .filter((line) => /^\s*import\b/.test(line) || /\brequire\s*\(/.test(line) || /\bawait\s+import\s*\(/.test(line));
if (borrowed.length > 0) {
  bad("the oracle imports " + borrowed.length + " module(s) — it must share NO code with the implementation: " + borrowed.join(" | "));
} else {
  ok("the oracle imports nothing at all: it shares no module, helper, type or constant with antichain.ts or poset.ts, so agreement is evidence and not a tautology");
}

/* ---- 2. the corpus, drawn once and used by everything below -------------- */

const corpus = fc.sample(candidateSetArbitrary(), { numRuns: RUNS, seed: SEED });
if (corpus.length !== RUNS) bad("expected " + RUNS + " generated posets, drew " + corpus.length);

let withExtension = 0, votedDown = 0, withPhantom = 0, withDrop = 0, multiMember = 0, cyclic = 0;
for (const candidates of corpus) {
  const poset = buildPoset(candidates);
  let ext = false, void_ = false, phantom = false, cycle = false;
  for (const candidate of candidates) {
    for (const token of [...(candidate.presentation_classes || []), ...(candidate.occasion_classes || [])]) {
      if (token.slice(0, 2) === "x-") ext = true;
    }
    for (const edge of candidate.accepts_substitute || []) {
      if (!poset.candidates.has(edge.occasion_id)) phantom = true;
    }
  }
  for (const a of poset.ids) for (const b of poset.ids) {
    if (a === b) continue;
    if (reaches(poset, a, b) && reaches(poset, b, a)) cycle = true;
    // An attested one-way permission that WOULD have established domination,
    // voided by an x- class. This is B4 being exercised, not merely surfaced.
    if (reaches(poset, a, b) && !reaches(poset, b, a) && extensionBlock(poset, a, b).length > 0) void_ = true;
  }
  const result = maximalAntichain(candidates);
  if (ext) withExtension++;
  if (void_) votedDown++;
  if (phantom) withPhantom++;
  if (cycle) cyclic++;
  if (result.dropped.length > 0) withDrop++;
  if (result.members.length > 1) multiMember++;
}

const rich = [
  ["carried an x- class", withExtension, RUNS / 10],
  ["had a domination voided by an x- class", votedDown, RUNS / 10],
  ["carried an edge naming an Occasion outside the resolved set (E2/S3)", withPhantom, RUNS / 10],
  ["dropped a dominated candidate", withDrop, RUNS / 10],
  ["returned more than one option", multiMember, RUNS / 2],
  ["contained a cycle in the attested relation", cyclic, RUNS / 10],
];
const thin = rich.filter((row) => row[1] <= row[2]);
if (thin.length > 0) {
  bad("the generated corpus is vacuous where it matters: " + thin.map((r) => r[1] + "/" + RUNS + " " + r[0]).join("; "));
} else {
  ok("the corpus is not vacuous (seed " + SEED + "): " + rich.map((r) => r[1] + "/" + RUNS + " " + r[0]).join("; "));
}

/* ---- 3. the differential claim ------------------------------------------ */

let agreements = 0;
let firstDisagreement = null;
for (const candidates of corpus) {
  const fast = maximalAntichain(candidates);
  const slow = maximalAntichainOracle(candidates);
  if (same({ members: fast.members, dropped: fast.dropped }, slow)) agreements++;
  else if (firstDisagreement === null) firstDisagreement = JSON.stringify(candidates);
}
if (agreements === RUNS) {
  ok(agreements + "/" + RUNS + " generated posets agree with the independent oracle on the whole result — members in document order, their distinguishing axes, their surfaced x- tokens, what each supersedes, and what was dropped and by whom");
} else {
  bad(agreements + "/" + RUNS + " agreed; first disagreement on " + firstDisagreement);
}

/* ---- 4. the comparison has teeth ---------------------------------------- */

// The bug an implementer actually writes: drop on reachability alone, with no
// check that the permission is one-way and no x- block. If the oracle cannot
// catch that, an agreement above is worth nothing.
let caught = 0;
for (const candidates of corpus) {
  const poset = buildPoset(candidates);
  const wrong = poset.ids.filter((s) => !poset.ids.some((t) => t !== s && reaches(poset, s, t)));
  const truth = maximalAntichainOracle(candidates).members.map((m) => m.occasion_id);
  if (!same(wrong, truth)) caught++;
}
if (caught > RUNS / 2) {
  ok("the comparison has teeth: a plausible wrong implementation — drop on reachability alone — is caught on " + caught + "/" + RUNS + " posets");
} else {
  bad("the oracle caught the plausible wrong implementation on only " + caught + "/" + RUNS + " posets, so agreement is weak evidence");
}

/* ---- 5. the returned set IS the non-dominated set, and it is an antichain */

let structural = 0;
for (const candidates of corpus) {
  const result = maximalAntichain(candidates);
  const poset = result.poset;
  const returned = new Set(result.members.map((m) => m.occasion_id));
  const droppedIds = result.dropped.map((d) => d.occasion_id);
  let held = true;
  for (const id of poset.ids) {
    const dominated = poset.ids.some((other) => strictlyDominates(poset, other, id));
    if (dominated === returned.has(id)) held = false;
  }
  for (const a of returned) for (const b of returned) if (a !== b && strictlyDominates(poset, a, b)) held = false;
  if (droppedIds.some((id) => returned.has(id))) held = false;
  if (returned.size + droppedIds.length !== poset.ids.length) held = false;
  if (reflexivityWitness(poset) !== null) held = false;
  if (transitivityWitness(poset) !== null) held = false;
  if (held) structural++;
}
if (structural === RUNS) {
  ok(structural + "/" + RUNS + ": the returned set is exactly the non-dominated set, no member dominates another, returned and dropped partition the candidates, and the derived relation is reflexive and transitively closed");
} else {
  bad("the structural properties held on only " + structural + "/" + RUNS + " posets");
}

/* ---- 6. the annotation is ASSERTED, not merely produced ------------------ */

let annotated = 0, membersSeen = 0, axesSeen = new Set();
for (const candidates of corpus) {
  const result = maximalAntichain(candidates);
  let held = true;
  for (const member of result.members) {
    membersSeen++;
    for (const axis of member.distinguishing_axes) axesSeen.add(axis);
    if (member.distinguishing_axes.length === 0) held = false;
    // Never a ranking: no score, no rank, no amount ever reaches a member.
    for (const key of Object.keys(member)) {
      if (/rank|score|amount|price_minor|cheap/.test(key)) held = false;
    }
    const order = member.distinguishing_axes.map((a) => AXES.indexOf(a));
    for (let i = 1; i < order.length; i++) if (order[i] <= order[i - 1]) held = false;
  }
  if (held) annotated++;
}
if (annotated === RUNS && membersSeen > 0) {
  ok("the distinguishing-axes annotation is non-empty for every one of the " + membersSeen + " returned members across " + RUNS + " posets, is in the frozen axis order, and carries no rank, score or amount (" + [...axesSeen].length + " of the 7 axes were exercised)");
} else {
  bad("a returned member carried an empty or malformed distinguishing-axes annotation (" + annotated + "/" + RUNS + " posets held)");
}

/* ---- 7. the x- class, in both directions -------------------------------- */

const extensionCases = fc.sample(extensionCaseArbitrary(), { numRuns: RUNS, seed: SEED });
let blocked = 0;
for (const drawn of extensionCases) {
  const { candidates, lower_id, upper_id, token } = drawn;
  const poset = buildPoset(candidates);
  let held = true;
  // The edge IS attested: without the extension rule, upper strictly dominates lower.
  if (!reaches(poset, lower_id, upper_id)) held = false;
  // Domination is established in NEITHER direction.
  if (strictlyDominates(poset, upper_id, lower_id)) held = false;
  if (strictlyDominates(poset, lower_id, upper_id)) held = false;
  // And the attested edge MUST NOT satisfy the strict policy, either way.
  if (satisfiesStrictPolicy(poset, lower_id, upper_id)) held = false;
  if (satisfiesStrictPolicy(poset, upper_id, lower_id)) held = false;
  if (satisfiesStrictPolicyOracle(candidates, lower_id, upper_id)) held = false;
  // Both survive, and the token is surfaced as a distinguishing axis on both.
  const result = maximalAntichain(candidates);
  if (result.members.length !== 2) held = false;
  for (const member of result.members) {
    if (!member.extension_classes.includes(token)) held = false;
    if (!member.distinguishing_axes.includes("presentation_class") && !member.distinguishing_axes.includes("occasion_class")) held = false;
  }
  if (held) blocked++;
}
if (blocked === extensionCases.length && extensionCases.length === RUNS) {
  ok(blocked + "/" + RUNS + " attested edges crossed by an x- class: incomparable in BOTH directions, both options survive, the token is surfaced as a distinguishing axis, and the edge does not satisfy the strict policy — the fast path and the oracle agreeing");
} else {
  bad("the x- class failed to block domination or to fail a strict policy on " + (extensionCases.length - blocked) + "/" + extensionCases.length + " directed cases");
}

// The same rule, over the undirected corpus rather than the directed case.
let blockedPairs = 0, blockedPairsHeld = 0;
for (const candidates of corpus) {
  const poset = buildPoset(candidates);
  for (const a of poset.ids) for (const b of poset.ids) {
    if (a === b) continue;
    if (extensionBlock(poset, a, b).length === 0) continue;
    blockedPairs++;
    const held =
      !strictlyDominates(poset, a, b) && !strictlyDominates(poset, b, a) &&
      !satisfiesStrictPolicy(poset, a, b) && !satisfiesStrictPolicy(poset, b, a);
    if (held) blockedPairsHeld++;
  }
}
if (blockedPairs > 0 && blockedPairsHeld === blockedPairs) {
  ok(blockedPairs + " pairs separated by an x- class across the generated corpus: not one establishes domination in either direction, and not one satisfies a strict policy");
} else {
  bad("of " + blockedPairs + " x- separated pairs, " + (blockedPairs - blockedPairsHeld) + " established domination or satisfied a strict policy");
}

/* ---- 8. the frozen worked example (SPEC.md 9) --------------------------- */

const EMBASSY = "occ_embassy_20260829T1900_s1";
const SAT_DCP = "occ_multiplex_20260829T2100_s4";
const SUN_MATINEE = "occ_multiplex_20260830T1400_s4";

const documents = [
  "fixtures/golden/occasion-embassy-sat-1900.json",
  "fixtures/golden/occasion-multiplex-sat-2100.json",
  "fixtures/golden/occasion-multiplex-sun-1400.json",
].map((path) => JSON.parse(readFileSync(path, "utf8")));

const golden = documents.map(candidateFromOccasion);
const goldenIds = antichainIds(golden);
if (same(goldenIds, [EMBASSY, SUN_MATINEE])) {
  ok("the frozen three-Occasion case returns exactly the Embassy 35mm and the Sunday matinee, in document order — two options, no single optimum");
} else {
  bad("the frozen three-Occasion case returned " + JSON.stringify(goldenIds) + ", expected [" + EMBASSY + ", " + SUN_MATINEE + "]");
}

const goldenResult = maximalAntichain(golden);
const attested = (documents[1].substitution.accepts_substitute || []).some((e) => e.occasion_id === EMBASSY && e.axis === "presentation_class");
const droppedRight = same(goldenResult.dropped, [{ occasion_id: SAT_DCP, dominated_by: [EMBASSY], axes: ["presentation_class"] }]);
const supersedesRight = same(
  goldenResult.members.find((m) => m.occasion_id === EMBASSY).supersedes,
  [{ occasion_id: SAT_DCP, axes: ["presentation_class"] }],
);
if (attested && droppedRight && supersedesRight) {
  ok("the Saturday DCP is dropped BECAUSE it attests the Embassy 35mm substitutes for it: the edge is in the fixture, the drop names it as the dominator, and the Embassy supersedes it on presentation_class");
} else {
  bad("the Saturday DCP drop is not grounded in the attestation (edge present: " + attested + ", dropped: " + JSON.stringify(goldenResult.dropped) + ")");
}

const amounts = documents.map((d) => d.offers[0].amount_minor);
const survivorAmounts = goldenResult.members.map((m) => amounts[documents.findIndex((d) => d.occasion_id === m.occasion_id)]);
if (amounts[1] < amounts[0] && !goldenIds.includes(SAT_DCP) && survivorAmounts.includes(2600)) {
  ok("domination dropped the CHEAPER option (" + amounts[1] + " dropped, " + amounts[0] + " kept) and the Sunday matinee at " + amounts[2] + " survived by incomparability — the sharp edge SPEC.md 2.3 names, exercised by one party, in their own room");
} else {
  bad("the price relationship in the frozen case is not what the specification describes: " + JSON.stringify(amounts) + " with survivors " + JSON.stringify(survivorAmounts));
}

const sunday = goldenResult.members.find((m) => m.occasion_id === SUN_MATINEE);
if (sunday && sunday.distinguishing_axes.includes("accessibility") && sunday.supersedes.length === 0) {
  ok("the Sunday matinee is incomparable — a different night, no attested edge — and survives with accessibility among its distinguishing axes, superseding nothing");
} else {
  bad("the Sunday matinee did not survive with the annotation SPEC.md 9 describes: " + JSON.stringify(sunday));
}

/* ---- 9. no money entered the selection ---------------------------------- */

const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const money = /amount_minor|currency|amount\b|\.price\b|cheapest|sort\s*\(\s*\(/;
const offenders = ["packages/semantics/src/antichain.ts", "packages/semantics/src/poset.ts"]
  .filter((path) => money.test(strip(readFileSync(path, "utf8"))));
if (offenders.length === 0) {
  ok("no monetary value reaches the selection: with comments stripped, neither antichain.ts nor poset.ts names an amount, a currency or a price — the band LABEL is compared for equality and the number never arrives");
} else {
  bad("a monetary value reached the selection modules: " + offenders.join(", "));
}

const cheapened = documents.map((d) => {
  const copy = JSON.parse(JSON.stringify(d));
  for (const offer of copy.offers || []) offer.amount_minor = 1;
  return candidateFromOccasion(copy);
});
if (same(antichainIds(cheapened), goldenIds)) {
  ok("flattening every amount to 1 changes nothing about which options come back: the selection is provably not a function of price");
} else {
  bad("flattening the amounts changed the antichain, so price is entering the selection");
}

/* ---- 10. the axis vocabulary is the frozen one -------------------------- */

const fromSchema = [...JSON.parse(readFileSync("schemas/common.schema.json", "utf8")).$defs.axis.enum].sort();
const fromModule = [...AXES].sort();
if (same(fromSchema, fromModule)) {
  ok("the axis vocabulary is set-equal to $defs.axis in schemas/common.schema.json, both directions (" + AXES.length + " axes)");
} else {
  bad("the axis vocabulary has drifted from the frozen schema: module " + JSON.stringify(fromModule) + " vs schema " + JSON.stringify(fromSchema));
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
