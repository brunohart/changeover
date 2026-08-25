#!/usr/bin/env bash
# C-SUBST, from the authoring side. The transitive closure that
# `changeover derive` emits is compared against an INDEPENDENT closure in
# scripts/lib/closure-oracle.mjs, in both directions, over the arthouse fixture
# and over forty generated policies; and the edge sets derived for the three
# golden Occasions are compared byte-for-byte against the ones frozen in the
# root commit, with their etags recomputed.
#
# The obvious cheaper check — asserting that the derived edges look transitively
# closed — would pass on a closure that agrees with itself and on a closure that
# is subtly wrong in the same way twice. Transitivity is a Server obligation
# (SPEC.md 2.3), so the oracle exists to make the claim a fact rather than an
# assertion, exactly as scripts/lib/project.mjs does for the etag.
#
# `substitution` is inside PROJECTION_0_1. If a derived edge set moved by one
# byte, three frozen digests would move with it and every conformance report
# that ever cited them would be invalid. That is the real assertion here.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/yaml ]          || { echo "cannot prove — yaml not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/ajv ]           || { echo "cannot prove — ajv not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/canonicalize ]  || { echo "cannot prove — canonicalize not installed; run npm install at the repository root"; exit 2; }
[ -f scripts/lib/closure-oracle.mjs ] || { echo "cannot prove — scripts/lib/closure-oracle.mjs missing; the closure has nothing independent to be compared against"; exit 2; }
[ -f fixtures/policy/arthouse.yaml ]  || { echo "cannot prove — fixtures/policy/arthouse.yaml missing"; exit 2; }
[ -f fixtures/golden/EXPECTED.md ]    || { echo "cannot prove — fixtures/golden/EXPECTED.md missing"; exit 2; }
[ -f packages/semantics/src/derive.ts ] || { echo "cannot prove — packages/semantics/src/derive.ts missing"; exit 2; }

node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { project } from "./scripts/lib/project.mjs";
import { closure as oracleClosure, fingerprint, reachabilityWitness } from "./scripts/lib/closure-oracle.mjs";
import { corpusFromDocuments, loadCorpusFiles, loadPolicyFile, substitutionValidator } from "./packages/semantics/src/policy.ts";
import { deriveSubstitutions } from "./packages/semantics/src/derive.ts";
import { transitiveClosure, transitivityWitness } from "./packages/semantics/src/closure.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const GOLDEN = [
  "fixtures/golden/occasion-embassy-sat-1900.json",
  "fixtures/golden/occasion-multiplex-sat-2100.json",
  "fixtures/golden/occasion-multiplex-sun-1400.json",
];
const POINTERS = JSON.parse(readFileSync("schemas/projection-0-1.json", "utf8")).pointers;
const EXPECTED = readFileSync("fixtures/golden/EXPECTED.md", "utf8");
const mint = (occ) => "1:" + createHash("sha256").update(Buffer.from(canonicalize(project(occ, POINTERS)), "utf8")).digest("base64url");

/* ---- the arthouse fixture ------------------------------------------------ */

const load = loadPolicyFile("fixtures/policy/arthouse.yaml");
if (load.schema_error !== null) {
  bad("fixtures/policy/arthouse.yaml does not validate against substitution-policy.schema.json: " + load.schema_error);
} else {
  ok("the arthouse policy validates against substitution-policy.schema.json (" + load.policy.rules.length + " rules, authored once)");
}

const corpus = loadCorpusFiles(GOLDEN);
const derived = load.policy ? deriveSubstitutions(load.policy, corpus) : null;

if (derived && derived.diagnostics.filter((d) => d.severity === "error").length > 0) {
  bad("deriving the golden corpus raised errors: " + derived.diagnostics.map((d) => d.code).join(", "));
}

/* The relation the closure is computed over: permissions, minus any pair the
   policy explicitly refuses. That is the definition (SPEC.md 2.3 — a permission
   over the top of an authored refusal is the one thing this mechanism exists to
   make impossible), applied here independently of how derive implements it. */
const permissionRelation = (result) => {
  const refused = new Set(result.base.filter((e) => e.kind === "refusal").map((e) => e.from + " " + e.to));
  const edges = result.base
    .filter((e) => e.kind === "permission" && !refused.has(e.from + " " + e.to))
    .map((e) => ({ from: e.from, to: e.to, axes: [e.axis], rules: [e.rule_id] }));
  return { refused, edges };
};

const clustersOf = (records) => {
  const map = new Map();
  for (const record of records) {
    if (!record.cluster) continue;
    const group = map.get(record.cluster) ?? [];
    group.push(record.occasion_id);
    map.set(record.cluster, group);
  }
  return map;
};

/* Compare the implementation closure against the oracle, cluster by cluster.
   Returns { impl, oracle, mismatch }. */
const compareClosures = (result, records) => {
  const { edges } = permissionRelation(result);
  let implAll = [], oracleAll = [];
  for (const [, ids] of clustersOf(records)) {
    const inside = new Set(ids);
    const slice = edges.filter((e) => inside.has(e.from) && inside.has(e.to));
    implAll = implAll.concat(transitiveClosure(ids, slice));
    oracleAll = oracleAll.concat(oracleClosure(ids, slice));
  }
  return { impl: implAll, oracle: oracleAll, edges };
};

if (derived) {
  const { impl, oracle } = compareClosures(derived, corpus.records);
  const implSet = new Set(fingerprint(impl).split("\n").filter(Boolean));
  const oracleSet = new Set(fingerprint(oracle).split("\n").filter(Boolean));
  const missingFromOracle = [...implSet].filter((line) => !oracleSet.has(line));
  const missingFromImpl = [...oracleSet].filter((line) => !implSet.has(line));
  if (missingFromOracle.length > 0) bad("derive emitted a closure edge the oracle does not: " + missingFromOracle[0]);
  else ok("arthouse: every closure edge derive emits, the independent oracle also computes (" + implSet.size + " edges)");
  if (missingFromImpl.length > 0) bad("the oracle computes a closure edge derive does not emit: " + missingFromImpl[0]);
  else ok("arthouse: every closure edge the oracle computes, derive also emits — equality in both directions");

  const witness = reachabilityWitness(corpus.records.map((r) => r.occasion_id), compareClosures(derived, corpus.records).edges, oracle);
  if (witness) bad("the closure disagrees with plain reachability over the same relation: " + witness);
  else ok("arthouse: the closure is exactly the reachability of the authored relation, checked breadth-first against the definition");
}

/* ---- the three frozen edge sets ------------------------------------------ */

if (derived) {
  const validateSubstitution = substitutionValidator();
  let byteEqual = 0, canonicalEqual = 0, etagsHeld = 0, schemaOk = 0;
  for (const path of GOLDEN) {
    const golden = JSON.parse(readFileSync(path, "utf8"));
    const block = derived.blocks.get(golden.occasion_id);
    const name = path.split("/").pop();
    if (!block) { bad(name + ": derive produced no substitution block at all"); continue; }

    if (JSON.stringify(block) === JSON.stringify(golden.substitution)) byteEqual++;
    else bad(name + ": derived edge set is not byte-equal to the frozen one\n         derived " + JSON.stringify(block) + "\n         frozen  " + JSON.stringify(golden.substitution));

    if (canonicalize(block) === canonicalize(golden.substitution)) canonicalEqual++;
    else bad(name + ": derived edge set differs from the frozen one under RFC 8785 canonicalisation");

    const error = validateSubstitution(block);
    if (error) bad(name + ": the derived block does not validate against substitution.schema.json: " + error);
    else schemaOk++;

    const rebuilt = { ...golden, substitution: block };
    const etag = mint(rebuilt);
    if (etag !== golden.etag) bad(name + ": substituting the derived block MOVED the frozen etag — " + etag + " for " + golden.etag);
    else if (!EXPECTED.includes(etag)) bad(name + ": " + etag + " is absent from EXPECTED.md");
    else etagsHeld++;
  }
  if (byteEqual === GOLDEN.length) ok(byteEqual + "/3 golden Occasions: the derived edge set is byte-equal to the one frozen in the root commit");
  if (canonicalEqual === GOLDEN.length) ok(canonicalEqual + "/3 golden Occasions: byte-equal under RFC 8785 too, so key order is not carrying the result");
  if (schemaOk === GOLDEN.length) ok(schemaOk + "/3 derived blocks validate against substitution.schema.json");
  if (etagsHeld === GOLDEN.length) ok(etagsHeld + "/3 frozen etags do not move when the derived block replaces the authored one — substitution is inside PROJECTION_0_1");

  const ids = GOLDEN.map((p) => JSON.parse(readFileSync(p, "utf8")).occasion_id);
  const cited = ids.map((id) => JSON.stringify(derived.blocks.get(id).derived_from.rule_ids));
  if (cited.every((c) => c === JSON.stringify(["r-35mm-carrier"]))) {
    ok("all three Occasions cite derived_from.rule_ids [r-35mm-carrier] — including the Sunday matinee, whose edge set is empty and whose provenance is not");
  } else {
    bad("derived_from.rule_ids do not match the frozen provenance: " + cited.join(" "));
  }
}

/* ---- generated policies -------------------------------------------------- */

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const CLASSES = ["pres:35mm-4perf", "pres:70mm-5perf", "pres:16mm", "pres:dcp-2k-flat", "pres:dcp-4k-scope", "pres:sound-atmos", "pres:sound-5-1", "pres:open-caption"];
const OBJECTS = CLASSES.concat(["pres:dcp-*", "pres:sound-*"]);
const REASONS = ["format", "carrier", "occasion", "accessibility", "language", "room", "time"];
const RELATIONS = ["accepts_substitute", "not_substitutable_for"];

const generate = (seed) => {
  const rnd = mulberry32(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const occasions = 4 + Math.floor(rnd() * 7);
  const documents = [];
  for (let i = 0; i < occasions; i++) {
    const classes = [pick(CLASSES)];
    if (rnd() < 0.4) classes.push(pick(CLASSES));
    const day = 10 + Math.floor(rnd() * 6);
    documents.push({
      document: {
        occasion_id: "occ_gen_" + seed + "_" + i,
        venue: { id: "ven_gen", origin: "https://gen.example" },
        instant: { local_wall: "2026-09-" + day + "T19:00" },
        manner: { presentation_classes: [...new Set(classes)], occasion_classes: [] },
        substitution: { cluster: rnd() < 0.75 ? "cl-a" : "cl-b" },
      },
    });
  }
  const rules = [];
  const ruleCount = 1 + Math.floor(rnd() * 5);
  for (let i = 0; i < ruleCount; i++) {
    const rule = {
      rule_id: "r-gen-" + i,
      subject: pick(CLASSES),
      relation: pick(RELATIONS),
      object: pick(OBJECTS),
      policy: rnd() < 0.8 ? "strict" : "advisory",
      reason_code: pick(REASONS),
      authored_by: "venue",
      authored_at: "2026-09-01T09:00:00+12:00",
      effective_from: "2026-09-" + (10 + Math.floor(rnd() * 3)),
    };
    if (rnd() < 0.4) rule.effective_to = "2026-09-" + (12 + Math.floor(rnd() * 4));
    rules.push(rule);
  }
  return { policy: { policy_id: "pol_gen", rule_version: "2026.1", rules }, corpus: corpusFromDocuments(documents) };
};

const SEEDS = 40;
let closureAgreed = 0, emissionAgreed = 0, closedRelations = 0, totalEdges = 0, contradictory = 0;
let firstClosureFailure = null, firstEmissionFailure = null, firstOpenRelation = null;

for (let seed = 1; seed <= SEEDS; seed++) {
  const { policy, corpus: generated } = generate(seed);
  const result = deriveSubstitutions(policy, generated);
  if (result.diagnostics.some((d) => d.code === "CONTRADICTION")) contradictory++;

  const { impl, oracle, edges } = compareClosures(result, generated.records);
  const implPrint = fingerprint(impl), oraclePrint = fingerprint(oracle);
  totalEdges += impl.length;
  if (implPrint === oraclePrint) closureAgreed++;
  else if (!firstClosureFailure) {
    const implSet = new Set(implPrint.split("\n").filter(Boolean));
    const oracleSet = new Set(oraclePrint.split("\n").filter(Boolean));
    const a = [...implSet].filter((l) => !oracleSet.has(l));
    const b = [...oracleSet].filter((l) => !implSet.has(l));
    firstClosureFailure = "seed " + seed + ": derive-only [" + a.join(" | ") + "] oracle-only [" + b.join(" | ")  + "]";
  }

  const witness = transitivityWitness(oracle);
  if (!witness) closedRelations++;
  else if (!firstOpenRelation) firstOpenRelation = "seed " + seed + ": " + witness;

  /* End to end: what the wire carries must be what the oracle says it should,
     with the refused pairs removed after closure as well as before. */
  const refused = new Set(result.base.filter((e) => e.kind === "refusal").map((e) => e.from + " " + e.to));
  const expected = new Map();
  for (const edge of oracle) {
    if (refused.has(edge.from + " " + edge.to)) continue;
    const row = expected.get(edge.from) ?? [];
    for (const axis of edge.axes) row.push({ occasion_id: edge.to, axis });
    expected.set(edge.from, row);
  }
  let agreed = true;
  for (const record of generated.records) {
    const block = result.blocks.get(record.occasion_id);
    if (!block) { agreed = false; break; }
    const want = (expected.get(record.occasion_id) ?? []).slice().sort((x, y) => (x.occasion_id === y.occasion_id ? (x.axis < y.axis ? -1 : x.axis > y.axis ? 1 : 0) : x.occasion_id < y.occasion_id ? -1 : 1));
    if (JSON.stringify(block.accepts_substitute) !== JSON.stringify(want)) {
      agreed = false;
      if (!firstEmissionFailure) firstEmissionFailure = "seed " + seed + " " + record.occasion_id + ": wire " + JSON.stringify(block.accepts_substitute) + " oracle " + JSON.stringify(want);
      break;
    }
  }
  if (agreed) emissionAgreed++;
  void edges;
}

if (closureAgreed === SEEDS) ok(SEEDS + " generated policies: derive and the independent oracle agree on the closure, in both directions (" + totalEdges + " edges, " + contradictory + " of the policies self-contradictory)");
else bad("generated policies: " + (SEEDS - closureAgreed) + "/" + SEEDS + " closures disagreed — " + firstClosureFailure);

if (closedRelations === SEEDS) ok(SEEDS + " generated policies: the emitted relation is transitively closed, checked against the definition rather than against either implementation");
else bad("generated policies: " + (SEEDS - closedRelations) + "/" + SEEDS + " relations were not closed — " + firstOpenRelation);

if (emissionAgreed === SEEDS) ok(SEEDS + " generated policies: every accepts_substitute array on the wire is exactly what the oracle closure says it must be");
else bad("generated policies: " + (SEEDS - emissionAgreed) + "/" + SEEDS + " wire edge sets disagreed — " + firstEmissionFailure);

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
