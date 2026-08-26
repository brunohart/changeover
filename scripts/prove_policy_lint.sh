#!/usr/bin/env bash
# E1, at the only moment it is cheap to fix. `changeover lint` MUST exit 1 on a
# policy whose edges would target an Occasion published at another origin, and
# MUST exit 0 on a clean one — over the real CLI, by its real exit code, not by
# calling the library and believing what it returns.
#
# The obvious cheaper check — asserting that a cross-origin edge is absent from
# the derived output — would pass on an implementation that silently drops it,
# which is the failure mode that matters most here: E1 is what stops a Publisher
# attesting a claim about a competitor room from an origin this specification
# declares authoritative (SPEC.md 3.3), and an author whose edges vanish without
# a word will assume the tool is broken and stop using it. So this asserts both:
# the edge never reaches the wire, AND somebody is told why.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/yaml ] || { echo "cannot prove — yaml not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/ajv ]  || { echo "cannot prove — ajv not installed; run npm install at the repository root"; exit 2; }
[ -f packages/cli/src/bin.ts ] || { echo "cannot prove — packages/cli/src/bin.ts missing; there is no command to run"; exit 2; }
[ -f fixtures/policy/arthouse.yaml ] || { echo "cannot prove — fixtures/policy/arthouse.yaml missing"; exit 2; }
[ -f fixtures/policy/cross-origin/policy.yaml ] || { echo "cannot prove — fixtures/policy/cross-origin/policy.yaml missing"; exit 2; }
[ -d fixtures/golden ] || { echo "cannot prove — fixtures/golden missing"; exit 2; }

node --input-type=module -e '
import { spawnSync } from "node:child_process";
import { loadCorpusFiles, parsePolicy } from "./packages/semantics/src/policy.ts";
import { deriveSubstitutions } from "./packages/semantics/src/derive.ts";
import { lint } from "./packages/semantics/src/lint.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const cli = (...args) => {
  const run = spawnSync(process.execPath, ["packages/cli/src/bin.ts", ...args], { encoding: "utf8" });
  return { code: run.status, out: (run.stdout ?? "") + (run.stderr ?? "") };
};

/* ---- the clean fixture --------------------------------------------------- */

const clean = cli("lint", "--policy", "fixtures/policy/arthouse.yaml", "--corpus", "fixtures/golden");
if (clean.code === 0) ok("changeover lint exits 0 on the clean arthouse policy over the golden corpus");
else bad("changeover lint exited " + clean.code + " on the clean arthouse policy:\n" + clean.out);

if (/RULE_NEVER_FIRES/.test(clean.out)) ok("a rule that can never fire is a warning, named, and does not fail the exit code — a policy is authored once and read for years");
else bad("lint said nothing about the arthouse rules that match no Occasion in the golden corpus");

/* ---- the cross-origin fixture -------------------------------------------- */

const crossed = cli("lint", "--policy", "fixtures/policy/cross-origin/policy.yaml", "--corpus", "fixtures/policy/cross-origin/corpus");
if (crossed.code === 1) ok("changeover lint exits 1 on a policy whose edges would cross an origin (E1)");
else bad("changeover lint exited " + crossed.code + " on the cross-origin fixture, and 1 is the only honest answer:\n" + crossed.out);

const machine = cli("lint", "--policy", "fixtures/policy/cross-origin/policy.yaml", "--corpus", "fixtures/policy/cross-origin/corpus", "--json");
let report = null;
try { report = JSON.parse(machine.out); } catch { report = null; }
if (report && report.diagnostics.some((d) => d.code === "E1_CROSS_ORIGIN" && d.severity === "error")) {
  ok("the refusal is machine-readable as E1_CROSS_ORIGIN, so a publish pipeline can branch on it rather than on prose");
} else {
  bad("lint --json carried no E1_CROSS_ORIGIN diagnostic: " + machine.out.slice(0, 400));
}
if (report && /same venue.origin/.test(report.diagnostics.map((d) => d.message).join(" "))) {
  ok("the message names both origins and the cluster, so the author can see that one cluster string at two origins is two clusters (E3)");
} else {
  bad("the E1 message does not explain itself");
}

/* ---- absent by construction, not merely reported ------------------------- */

const corpus = loadCorpusFiles([
  "fixtures/policy/cross-origin/corpus/occasion-roxy-sat-1900.json",
  "fixtures/policy/cross-origin/corpus/occasion-tickets-sat-2100.json",
]);
const origins = new Map(corpus.records.map((r) => [r.occasion_id, r.origin]));
const policyText = "policy_id: pol_x\nrule_version: \"2026.1\"\nrules:\n  - rule_id: r-x\n    subject: \"pres:35mm-4perf\"\n    relation: \"not_substitutable_for\"\n    object: \"pres:dcp-*\"\n    policy: \"strict\"\n    reason_code: \"carrier\"\n    authored_by: \"venue\"\n    authored_at: \"2026-09-01T09:00:00+12:00\"\n    effective_from: \"2026-09-01\"\n";
const crossPolicy = parsePolicy(policyText, "<inline>");
if (crossPolicy.schema_error !== null) {
  bad("the inline cross-origin policy did not validate: " + crossPolicy.schema_error);
} else {
  const derived = deriveSubstitutions(crossPolicy.policy, corpus);
  let leaked = 0;
  for (const [occasion_id, block] of derived.blocks) {
    for (const edge of [...block.accepts_substitute, ...block.not_substitutable_for]) {
      if (origins.get(edge.occasion_id) !== origins.get(occasion_id)) leaked++;
    }
  }
  if (leaked === 0) ok("no derived edge targets an Occasion at another origin — E1 holds by construction, so no configuration can turn it off");
  else bad(leaked + " derived edges crossed an origin boundary");

  const reported = derived.diagnostics.filter((d) => d.code === "E1_CROSS_ORIGIN").length;
  if (reported === 2) ok("both refused directions are reported separately — the refusal on the print and the converse permission on the DCP are two claims, not one");
  else bad("expected 2 E1 diagnostics for a two-Occasion cluster split across origins, got " + reported);
}

/* ---- the other things a policy gets wrong -------------------------------- */

const inline = (rules) => parsePolicy("policy_id: pol_t\nrule_version: \"2026.1\"\nrules:\n" + rules, "<inline>");
const RULE = (over) => {
  const base = {
    rule_id: "r-t", subject: "pres:35mm-4perf", relation: "not_substitutable_for", object: "pres:dcp-2k-flat",
    policy: "strict", reason_code: "carrier", authored_by: "venue",
    authored_at: "2026-09-01T09:00:00+12:00", effective_from: "2026-01-01", ...over,
  };
  return Object.entries(base).map(([k, v], i) => (i === 0 ? "  - " : "    ") + k + ": \"" + v + "\"\n").join("");
};

const typo = inline(RULE({ subject: "pres:35mm-4-perf" }));
const typoResult = lint(typo);
if (typoResult.errors > 0 && typoResult.diagnostics.some((d) => d.code === "UNKNOWN_CLASS" && /did you mean/.test(d.message))) {
  ok("a class id that is not in the 2026.1 register is an error, with the near miss named — pres:35mm-4-perf protects nothing at all, silently, forever");
} else {
  bad("a typo in a class id passed lint: " + JSON.stringify(typoResult.diagnostics));
}

const extension = inline(RULE({ subject: "x-house-print" }));
const extensionResult = lint(extension);
if (extensionResult.diagnostics.some((d) => d.code === "X_CLASS_NOT_COMPARABLE")) {
  ok("a rule over an x- extension class is refused: an x- class is incomparable in both directions and MUST NOT satisfy a strict policy, or a Publisher moves real semantics into x- ids");
} else {
  bad("a rule ranking an x- class was accepted: " + JSON.stringify(extensionResult.diagnostics));
}

const inverted = inline(RULE({ effective_from: "2026-09-30", effective_to: "2026-09-01" }));
if (lint(inverted).diagnostics.some((d) => d.code === "EFFECTIVE_WINDOW_INVERTED")) {
  ok("an effective window that runs backwards is an error rather than a rule quietly in force on no date at all");
} else {
  bad("an inverted effective window passed lint");
}

const duplicated = inline(RULE({}) + RULE({ object: "pres:dcp-4k-scope" }));
if (lint(duplicated).diagnostics.some((d) => d.code === "DUPLICATE_RULE_ID")) {
  ok("two rules sharing a rule_id is an error — derived_from.rule_ids would name one rule and mean two");
} else {
  bad("a duplicated rule_id passed lint");
}

/* ---- a missing input is not a failure ------------------------------------ */

const missing = cli("lint", "--policy", "fixtures/policy/does-not-exist.yaml");
if (missing.code === 2) ok("a policy file that is not there exits 2, not 1: a precondition that cannot be reached is not a policy that failed");
else bad("lint exited " + missing.code + " for a missing policy file, and 2 is the honest answer");

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
