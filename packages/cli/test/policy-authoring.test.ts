/**
 * SPEC-007 — the policy authoring layer: parse, lint, derive, close.
 *
 * These tests live in packages/cli/test/ rather than packages/semantics/test/
 * because docs/BUILD-CONTRACT.md gives that directory to SPEC-008, and a
 * directory with two owners is a directory with none. They exercise
 * @changeover/semantics through the same public modules the CLI uses. The
 * integrator may move the file wholesale once SPEC-008 has landed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OccasionDocument, PolicyRule } from "@changeover/semantics/policy.ts";
import {
  AXIS_FOR_REASON, axisForReason, corpusFromDocuments, expressionMatchesOccasion, inEffect,
  loadCorpusFiles, loadPolicyFile, occasionRecord, parsePolicy, scopeMatches, substitutionValidator,
} from "@changeover/semantics/policy.ts";
import { deriveSubstitutions, expandRules } from "@changeover/semantics/derive.ts";
import { transitiveClosure, transitivityWitness } from "@changeover/semantics/closure.ts";
import { explainRule, lint } from "@changeover/semantics/lint.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const GOLDEN = [
  join(ROOT, "fixtures/golden/occasion-embassy-sat-1900.json"),
  join(ROOT, "fixtures/golden/occasion-multiplex-sat-2100.json"),
  join(ROOT, "fixtures/golden/occasion-multiplex-sun-1400.json"),
];
const ARTHOUSE = join(ROOT, "fixtures/policy/arthouse.yaml");

const EMBASSY = "occ_embassy_20260829T1900_s1";
const SATURDAY_DCP = "occ_multiplex_20260829T2100_s4";
const SUNDAY_DCP = "occ_multiplex_20260830T1400_s4";

function occasion(over: Partial<{
  occasion_id: string; origin: string; venue_id: string; cluster: string;
  local_wall: string; presentation_classes: string[]; occasion_classes: string[];
}> = {}): OccasionDocument {
  return {
    occasion_id: over.occasion_id ?? "occ_a",
    venue: { id: over.venue_id ?? "ven_a", origin: over.origin ?? "https://a.example" },
    instant: { local_wall: over.local_wall ?? "2026-09-05T19:00" },
    manner: {
      presentation_classes: over.presentation_classes ?? ["pres:dcp-2k-flat"],
      occasion_classes: over.occasion_classes ?? [],
    },
    substitution: { cluster: over.cluster ?? "cl" },
  };
}

function rule(over: Partial<PolicyRule> = {}): PolicyRule {
  return {
    rule_id: "r-t",
    subject: "pres:35mm-4perf",
    relation: "not_substitutable_for",
    object: "pres:dcp-*",
    policy: "strict",
    reason_code: "carrier",
    authored_by: "venue",
    authored_at: "2026-09-01T09:00:00+12:00",
    effective_from: "2026-01-01",
    ...over,
  };
}

const policyOf = (...rules: PolicyRule[]) => ({ policy_id: "pol_t", rule_version: "2026.1", rules });

/* ------------------------------------------------------------------ policy */

test("the arthouse fixture validates against substitution-policy.schema.json", () => {
  const load = loadPolicyFile(ARTHOUSE);
  assert.equal(load.schema_error, null);
  assert.equal(load.policy?.policy_id, "pol_embassy_2026");
  assert.equal(load.policy?.rules.length, 8);
});

test("YAML dates arrive as strings, not Date objects", () => {
  // YAML 1.1 parsed bare ISO dates as timestamps. A Date here would fail
  // format: date-time silently at the far end of a publish pipeline.
  const load = loadPolicyFile(ARTHOUSE);
  const first = load.policy?.rules[0];
  assert.equal(typeof first?.authored_at, "string");
  assert.equal(typeof first?.effective_from, "string");
  assert.equal(first?.effective_to, "2026-08-29");
});

test("an unknown member is refused: the schema is additionalProperties false", () => {
  const load = parsePolicy("policy_id: p\nrule_version: \"1\"\nrules: []\nsettlement: yes\n", "<inline>");
  assert.notEqual(load.schema_error, null);
  assert.equal(load.policy, null);
});

test("every reason_code maps to exactly one wire axis", () => {
  const reasons = ["format", "carrier", "occasion", "accessibility", "language", "room", "time"] as const;
  for (const reason of reasons) assert.ok(AXIS_FOR_REASON[reason], `${reason} has no axis`);
  assert.equal(axisForReason("carrier"), "presentation_class");
  assert.equal(axisForReason("occasion"), "occasion_class");
  assert.equal(axisForReason("room"), "auditorium");
  assert.equal(axisForReason("time"), "instant");
});

test("a class glob matches on the class, never on the occasion id", () => {
  const record = occasionRecord(occasion({ occasion_id: "occ_pres_dcp_9000", presentation_classes: ["pres:35mm-4perf"] }));
  assert.equal(expressionMatchesOccasion("pres:dcp-*", record), false);
  assert.equal(expressionMatchesOccasion("pres:35mm-4perf", record), true);
  assert.equal(expressionMatchesOccasion("pres:*", record), true);
});

test("an axis token matches no Occasion: axis-level rules are not derivable in v0.1", () => {
  const record = occasionRecord(occasion());
  assert.equal(expressionMatchesOccasion("presentation_class", record), false);
});

test("the effective window is inclusive at both ends and read from local_wall", () => {
  const inside = occasionRecord(occasion({ local_wall: "2026-08-29T19:00" }));
  const after = occasionRecord(occasion({ local_wall: "2026-08-30T14:00" }));
  const window = rule({ effective_from: "2026-08-01", effective_to: "2026-08-29" });
  assert.equal(inside.local_date, "2026-08-29");
  assert.equal(inEffect(window, inside), true);
  assert.equal(inEffect(window, after), false);
  assert.equal(inEffect(rule({ effective_from: "2026-08-29", effective_to: "2026-08-29" }), inside), true);
});

test("scope narrows by venue and by cluster pattern, and work_id needs an identifier the Occasion carries", () => {
  const record = occasionRecord(occasion({ venue_id: "ven_a", cluster: "the-conversation-wlg-2026-w35" }));
  assert.equal(scopeMatches(rule({ scope: { venue_id: "ven_a" } }), record), true);
  assert.equal(scopeMatches(rule({ scope: { venue_id: "ven_b" } }), record), false);
  assert.equal(scopeMatches(rule({ scope: { cluster_pattern: "the-conversation-*" } }), record), true);
  assert.equal(scopeMatches(rule({ scope: { cluster_pattern: "kubrick-*" } }), record), false);
  assert.equal(scopeMatches(rule({ scope: { work_id: "10.5240/X" } }), record), false);
});

test("a corpus file that is not an Occasion document is skipped, not counted", () => {
  const corpus = loadCorpusFiles([...GOLDEN, join(ROOT, "fixtures/golden/delegation.json")]);
  assert.equal(corpus.records.length, 3);
  assert.equal(corpus.skipped.length, 1);
});

/* ----------------------------------------------------------------- closure */

test("a chain closes, and the derived edge carries the union of the axes and the rules it crossed", () => {
  const closed = transitiveClosure(["a", "b", "c"], [
    { from: "a", to: "b", axes: ["presentation_class"], rules: ["r1"] },
    { from: "b", to: "c", axes: ["accessibility"], rules: ["r2"] },
  ]);
  const ac = closed.find((e) => e.from === "a" && e.to === "c");
  assert.ok(ac, "a -> c was not derived");
  assert.deepEqual([...ac.axes].sort(), ["accessibility", "presentation_class"]);
  assert.deepEqual([...ac.rules].sort(), ["r1", "r2"]);
  assert.equal(closed.length, 3);
});

test("a cycle is ordinary, and no Occasion is ever its own substitute", () => {
  const closed = transitiveClosure(["a", "b"], [
    { from: "a", to: "b", axes: ["instant"], rules: ["r1"] },
    { from: "b", to: "a", axes: ["instant"], rules: ["r2"] },
  ]);
  assert.equal(closed.length, 2);
  assert.equal(closed.filter((e) => e.from === e.to).length, 0);
});

test("a walk through a cycle carries the cycle's axes (D5c), which is what makes the oracle comparable", () => {
  // The subtle case. If the closure quantified over simple paths rather than
  // walks, a -> b would carry only {instant} here, and this implementation and
  // the Floyd-Warshall in scripts/lib/closure-oracle.mjs would disagree on
  // every cyclic policy — two mutually substitutable screenings being the
  // ordinary way a cycle appears.
  const closed = transitiveClosure(["a", "b", "c"], [
    { from: "a", to: "b", axes: ["instant"], rules: ["r1"] },
    { from: "b", to: "a", axes: ["seat"], rules: ["r2"] },
    { from: "b", to: "c", axes: ["auditorium"], rules: ["r3"] },
  ]);
  const ab = closed.find((e) => e.from === "a" && e.to === "b")!;
  assert.deepEqual([...ab.axes], ["instant", "seat"]);
  assert.deepEqual([...ab.rules], ["r1", "r2"]);
  const ac = closed.find((e) => e.from === "a" && e.to === "c")!;
  assert.deepEqual([...ac.axes], ["auditorium", "instant", "seat"]);
});

test("transitivityWitness finds the hole in a relation that is not closed", () => {
  const open = [
    { from: "a", to: "b", axes: [] as never[], rules: [] as never[] },
    { from: "b", to: "c", axes: [] as never[], rules: [] as never[] },
  ];
  assert.notEqual(transitivityWitness(open), null);
  assert.equal(transitivityWitness(transitiveClosure(["a", "b", "c"], open)), null);
});

test("an edge whose endpoint is outside the node set never enters the closure", () => {
  const closed = transitiveClosure(["a", "b"], [
    { from: "a", to: "b", axes: ["seat"], rules: ["r1"] },
    { from: "b", to: "elsewhere", axes: ["seat"], rules: ["r2"] },
  ]);
  assert.equal(closed.length, 1);
});

/* ------------------------------------------------------------------ derive */

test("the three golden edge sets reproduce byte for byte from eight authored rules", () => {
  const load = loadPolicyFile(ARTHOUSE);
  const corpus = loadCorpusFiles(GOLDEN);
  const derived = deriveSubstitutions(load.policy!, corpus);
  for (const path of GOLDEN) {
    const golden = JSON.parse(readFileSync(path, "utf8")) as { occasion_id: string; substitution: unknown };
    assert.equal(
      JSON.stringify(derived.blocks.get(golden.occasion_id)),
      JSON.stringify(golden.substitution),
      `${path} differs`,
    );
  }
  assert.equal(derived.diagnostics.filter((d) => d.severity === "error").length, 0);
});

test("every derived block validates against substitution.schema.json", () => {
  const load = loadPolicyFile(ARTHOUSE);
  const derived = deriveSubstitutions(load.policy!, loadCorpusFiles(GOLDEN));
  const validate = substitutionValidator();
  for (const block of derived.blocks.values()) assert.equal(validate(block), null);
});

test("a ranking publishes a refusal on the print and the converse permission on the DCP", () => {
  const load = loadPolicyFile(ARTHOUSE);
  const derived = deriveSubstitutions(load.policy!, loadCorpusFiles(GOLDEN));
  const print = derived.blocks.get(EMBASSY)!;
  const dcp = derived.blocks.get(SATURDAY_DCP)!;
  assert.equal(print.accepts_substitute.length, 0);
  assert.deepEqual(print.not_substitutable_for.map((e) => e.occasion_id), [SATURDAY_DCP, SUNDAY_DCP]);
  assert.deepEqual(dcp.accepts_substitute, [{ occasion_id: EMBASSY, axis: "presentation_class" }]);
  assert.equal(dcp.not_substitutable_for.length, 0);
});

test("out of its effective window a rule emits nothing, and the provenance still names it", () => {
  const load = loadPolicyFile(ARTHOUSE);
  const derived = deriveSubstitutions(load.policy!, loadCorpusFiles(GOLDEN));
  const sunday = derived.blocks.get(SUNDAY_DCP)!;
  assert.deepEqual(sunday.accepts_substitute, []);
  assert.deepEqual(sunday.not_substitutable_for, []);
  assert.deepEqual(sunday.derived_from.rule_ids, ["r-35mm-carrier"]);
});

test("a grant is one direction only: silence about the reverse is the absence of permission", () => {
  const corpus = corpusFromDocuments([
    { document: occasion({ occasion_id: "occ_a", presentation_classes: ["pres:35mm-4perf"] }) },
    { document: occasion({ occasion_id: "occ_b", presentation_classes: ["pres:dcp-2k-flat"] }) },
  ]);
  const derived = deriveSubstitutions(policyOf(rule({ relation: "accepts_substitute" })), corpus);
  assert.deepEqual(derived.blocks.get("occ_a")!.accepts_substitute, [{ occasion_id: "occ_b", axis: "presentation_class" }]);
  assert.deepEqual(derived.blocks.get("occ_b")!.accepts_substitute, []);
  assert.deepEqual(derived.blocks.get("occ_b")!.not_substitutable_for, []);
});

test("a refusal beats a permission over the same pair, and the contradiction is reported", () => {
  const corpus = corpusFromDocuments([
    { document: occasion({ occasion_id: "occ_a", presentation_classes: ["pres:35mm-4perf"] }) },
    { document: occasion({ occasion_id: "occ_b", presentation_classes: ["pres:dcp-2k-flat"] }) },
  ]);
  const derived = deriveSubstitutions(policyOf(
    rule({ rule_id: "r-refuse" }),
    rule({ rule_id: "r-grant", relation: "accepts_substitute" }),
  ), corpus);
  const a = derived.blocks.get("occ_a")!;
  assert.deepEqual(a.accepts_substitute, []);
  assert.equal(a.not_substitutable_for.length, 1);
  assert.ok(derived.diagnostics.some((d) => d.code === "CONTRADICTION" && d.severity === "error"));
});

test("transitivity never publishes a permission the Publisher explicitly refused", () => {
  const corpus = corpusFromDocuments([
    { document: occasion({ occasion_id: "occ_a", presentation_classes: ["pres:35mm-4perf"] }) },
    { document: occasion({ occasion_id: "occ_b", presentation_classes: ["pres:70mm-5perf"] }) },
    { document: occasion({ occasion_id: "occ_c", presentation_classes: ["pres:dcp-2k-flat"] }) },
  ]);
  const derived = deriveSubstitutions(policyOf(
    rule({ rule_id: "r-ab", subject: "pres:35mm-4perf", object: "pres:70mm-5perf", relation: "accepts_substitute" }),
    rule({ rule_id: "r-bc", subject: "pres:70mm-5perf", object: "pres:dcp-2k-flat", relation: "accepts_substitute" }),
    rule({ rule_id: "r-refuse-ac", subject: "pres:35mm-4perf", object: "pres:dcp-2k-flat" }),
  ), corpus);
  const a = derived.blocks.get("occ_a")!;
  assert.deepEqual(a.accepts_substitute.map((e) => e.occasion_id), ["occ_b"]);
  assert.ok(derived.diagnostics.some((d) => d.code === "CONTRADICTION" && d.target_occasion_id === "occ_c"));
});

test("a transitive permission reaches the wire when nothing refuses it", () => {
  const corpus = corpusFromDocuments([
    { document: occasion({ occasion_id: "occ_a", presentation_classes: ["pres:35mm-4perf"] }) },
    { document: occasion({ occasion_id: "occ_b", presentation_classes: ["pres:70mm-5perf"] }) },
    { document: occasion({ occasion_id: "occ_c", presentation_classes: ["pres:dcp-2k-flat"] }) },
  ]);
  const derived = deriveSubstitutions(policyOf(
    rule({ rule_id: "r-ab", subject: "pres:35mm-4perf", object: "pres:70mm-5perf", relation: "accepts_substitute" }),
    rule({ rule_id: "r-bc", subject: "pres:70mm-5perf", object: "pres:dcp-2k-flat", relation: "accepts_substitute", reason_code: "occasion" }),
  ), corpus);
  const a = derived.blocks.get("occ_a")!;
  assert.deepEqual(
    a.accepts_substitute,
    [
      { occasion_id: "occ_b", axis: "presentation_class" },
      { occasion_id: "occ_c", axis: "occasion_class" },
      { occasion_id: "occ_c", axis: "presentation_class" },
    ],
  );
  assert.deepEqual(a.derived_from.rule_ids, ["r-ab", "r-bc"]);
});

test("no edge crosses an origin, and both refused directions are reported", () => {
  const corpus = corpusFromDocuments([
    { document: occasion({ occasion_id: "occ_a", origin: "https://a.example", presentation_classes: ["pres:35mm-4perf"] }) },
    { document: occasion({ occasion_id: "occ_b", origin: "https://b.example", presentation_classes: ["pres:dcp-2k-flat"] }) },
  ]);
  const derived = deriveSubstitutions(policyOf(rule()), corpus);
  assert.deepEqual(derived.blocks.get("occ_a")!.not_substitutable_for, []);
  assert.deepEqual(derived.blocks.get("occ_b")!.accepts_substitute, []);
  assert.equal(derived.diagnostics.filter((d) => d.code === "E1_CROSS_ORIGIN").length, 2);
});

test("a cluster string is scoped to its origin, so two clusters of one name never join", () => {
  const corpus = corpusFromDocuments([
    { document: occasion({ occasion_id: "occ_a", cluster: "same", presentation_classes: ["pres:35mm-4perf"] }) },
    { document: occasion({ occasion_id: "occ_b", cluster: "other", presentation_classes: ["pres:dcp-2k-flat"] }) },
  ]);
  const derived = deriveSubstitutions(policyOf(rule()), corpus);
  assert.deepEqual(derived.blocks.get("occ_a")!.not_substitutable_for, []);
});

test("a rule naming an x- extension class emits nothing in either direction", () => {
  const corpus = corpusFromDocuments([
    { document: occasion({ occasion_id: "occ_a", presentation_classes: ["x-house-print"] }) },
    { document: occasion({ occasion_id: "occ_b", presentation_classes: ["pres:dcp-2k-flat"] }) },
  ]);
  const derived = deriveSubstitutions(policyOf(rule({ subject: "x-house-print" })), corpus);
  assert.deepEqual(derived.blocks.get("occ_a")!.not_substitutable_for, []);
  assert.deepEqual(derived.blocks.get("occ_b")!.accepts_substitute, []);
});

test("an edge set over the wire cap of 64 is an error, not a truncation", () => {
  const documents = [{ document: occasion({ occasion_id: "occ_print", presentation_classes: ["pres:35mm-4perf"] }) }];
  for (let i = 0; i < 70; i++) {
    documents.push({ document: occasion({ occasion_id: `occ_dcp_${i}`, presentation_classes: ["pres:dcp-2k-flat"] }) });
  }
  const derived = deriveSubstitutions(policyOf(rule()), corpusFromDocuments(documents));
  assert.equal(derived.blocks.get("occ_print")!.not_substitutable_for.length, 70);
  assert.ok(derived.diagnostics.some((d) => d.code === "EDGE_CAP_EXCEEDED"));
});

test("the emitted policy strength is strict unless every incident rule is advisory", () => {
  const documents = [
    { document: occasion({ occasion_id: "occ_a", presentation_classes: ["pres:35mm-4perf"] }) },
    { document: occasion({ occasion_id: "occ_b", presentation_classes: ["pres:dcp-2k-flat"] }) },
  ];
  const advisory = deriveSubstitutions(policyOf(rule({ policy: "advisory" })), corpusFromDocuments(documents));
  assert.equal(advisory.blocks.get("occ_a")!.policy, "advisory");
  const mixed = deriveSubstitutions(policyOf(rule({ rule_id: "r-1", policy: "advisory" }), rule({ rule_id: "r-2", policy: "strict" })), corpusFromDocuments(documents));
  assert.equal(mixed.blocks.get("occ_a")!.policy, "strict");
  const unruled = deriveSubstitutions(policyOf(), corpusFromDocuments(documents));
  assert.equal(unruled.blocks.get("occ_a")!.policy, "strict");
});

test("expandRules emits nothing at all for an empty rule set", () => {
  const diagnostics: never[] = [];
  const corpus = loadCorpusFiles(GOLDEN);
  assert.equal(expandRules(policyOf(), corpus.records, diagnostics).length, 0);
});

/* -------------------------------------------------------------------- lint */

test("the arthouse policy lints clean over the golden corpus, warnings and all", () => {
  const result = lint(loadPolicyFile(ARTHOUSE), loadCorpusFiles(GOLDEN));
  assert.equal(result.errors, 0);
  assert.ok(result.warnings > 0, "the inert rules should be named");
  assert.ok(result.diagnostics.every((d) => d.code !== "RULE_NEVER_FIRES" || d.rule_id !== "r-35mm-carrier"));
});

test("lint names the rules that can never fire, and says why", () => {
  const result = lint(loadPolicyFile(ARTHOUSE), loadCorpusFiles(GOLDEN));
  const inert = result.diagnostics.filter((d) => d.code === "RULE_NEVER_FIRES");
  assert.equal(inert.length, 7);
  assert.ok(inert.every((d) => d.message.includes("no Occasion in scope") || d.message.includes("neither")));
});

test("lint refuses a policy that does not validate, before it refuses anything else", () => {
  const result = lint(parsePolicy("policy_id: p\n", "<inline>"));
  assert.equal(result.errors, 1);
  assert.equal(result.diagnostics[0].code, "SCHEMA_INVALID");
});

test("lint warns when scope.work_id can never resolve", () => {
  const result = lint(
    parsePolicy(`policy_id: p\nrule_version: "1"\nrules:\n  - rule_id: r\n    scope:\n      work_id: "10.5240/AAAA"\n    subject: "pres:35mm-4perf"\n    relation: "not_substitutable_for"\n    object: "pres:dcp-2k-flat"\n    policy: "strict"\n    reason_code: "carrier"\n    authored_by: "venue"\n    authored_at: "2026-09-01T09:00:00+12:00"\n    effective_from: "2026-01-01"\n`, "<inline>"),
    loadCorpusFiles(GOLDEN),
  );
  assert.ok(result.diagnostics.some((d) => d.code === "WORK_ID_UNRESOLVABLE"));
});

test("explainRule states the converse face a ranking publishes", () => {
  const text = explainRule(rule());
  assert.match(text, /refuses/);
  assert.match(text, /permits/);
  assert.match(text, /acceptable substitute/);
  assert.match(explainRule(rule({ relation: "accepts_substitute" })), /absence of an edge is absence of permission/);
});

/* --------------------------------------------------------------------- CLI */

const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, "packages/cli/src/bin.ts"), ...args], { cwd: ROOT, encoding: "utf8" });

test("the command registry is the filesystem", () => {
  const help = cli("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /lint/);
  assert.match(help.stdout, /derive/);
});

test("an unknown command exits 2, not 1", () => {
  assert.equal(cli("settle").status, 2);
  assert.equal(cli("../../etc/passwd").status, 2);
});

test("changeover lint exits 0 clean and 1 on a cross-origin edge target", () => {
  assert.equal(cli("lint", "--policy", "fixtures/policy/arthouse.yaml", "--corpus", "fixtures/golden").status, 0);
  assert.equal(cli("lint", "--policy", "fixtures/policy/cross-origin/policy.yaml", "--corpus", "fixtures/policy/cross-origin/corpus").status, 1);
});

test("changeover derive writes Occasions whose substitution block is derived and whose everything else is untouched", () => {
  const out = mkdtempSync(join(tmpdir(), "changeover-derive-"));
  try {
    const run = cli("derive", "--policy", "fixtures/policy/arthouse.yaml", "--corpus", "fixtures/golden", "--out", out);
    assert.equal(run.status, 0, run.stderr);
    const written = readdirSync(out).filter((f) => f.endsWith(".json"));
    assert.equal(written.length, 3);
    for (const name of written) {
      const derived = JSON.parse(readFileSync(join(out, name), "utf8")) as Record<string, unknown>;
      const golden = JSON.parse(readFileSync(join(ROOT, "fixtures/golden", name), "utf8")) as Record<string, unknown>;
      assert.deepEqual(derived, golden, `${name} changed`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("changeover derive exits 1 when the policy would cross an origin", () => {
  const run = cli("derive", "--policy", "fixtures/policy/cross-origin/policy.yaml", "--corpus", "fixtures/policy/cross-origin/corpus");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /E1_CROSS_ORIGIN/);
});

test("changeover derive without a corpus exits 2: rules over classes need instances to expand over", () => {
  assert.equal(cli("derive", "--policy", "fixtures/policy/arthouse.yaml").status, 2);
});
