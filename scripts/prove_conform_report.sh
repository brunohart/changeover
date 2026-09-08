#!/usr/bin/env bash
# TEST-007. `changeover conform` emits a dated JSON report that validates against
# schemas/report.schema.json; its per-class outcomes are the outcomes the classes
# actually returned when run; `unprovable` is representable and DISTINCT from
# both neighbours; and a second report at the same (spec_version,
# register_version, run_at) is refused rather than written.
#
# The obvious cheaper check is "the command exits 0 and a file appeared". It
# would pass for a runner that wrote `pass` over every class without importing
# one, which is precisely the failure this item exists to prevent — and it is the
# failure with the nicest-looking output. So three things are asserted that a
# self-reporting runner cannot fake:
#
#   The classes are RE-RUN here, independently, and their outcomes compared to
#   the report's. A report that says C-AUTHZ passed while C-AUTHZ returns a
#   failing clause is caught by running C-AUTHZ, not by reading the report.
#
#   Every class's recorded status is re-DERIVED from its own recorded clauses by
#   §7's rule — any fail → fail, else any unproven → unprovable, else pass — over
#   all twenty-four rows. A status that disagrees with the clauses beneath it is
#   the shape a green badge takes when somebody assigns one.
#
#   The refusal to restate is exercised by trying it, twice, and then checking
#   the bytes of the file that was already there. A refusal that truncated what
#   it refused to replace would be worse than the overwrite it prevented.
#
# Not concurrency-gated, and it must not become one. Every assertion here is
# about the RUNNER — a document, a derivation, a filesystem refusal — and each is
# identically reachable on PGlite and against CHANGEOVER_PG_URL. Both were run
# before this script was committed. What differs between the two substrates is
# which classes come back `pass` rather than `unprovable`, and the runner being
# honest about that difference is the thing being asserted, not a variable in it.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/ajv ]                  || { echo "cannot prove — ajv not installed; run npm install at the repository root. The report is validated against its schema, not eyeballed"; exit 2; }
[ -d node_modules/ajv-formats ]          || { echo "cannot prove — ajv-formats not installed; run npm install at the repository root. run_at is an RFC 3339 date-time and the format keyword is what checks it"; exit 2; }
[ -f schemas/report.schema.json ]        || { echo "cannot prove — schemas/report.schema.json missing; there is nothing for the report to validate against"; exit 2; }
[ -f packages/cli/src/commands/conform.ts ] || { echo "cannot prove — packages/cli/src/commands/conform.ts missing; there is no runner to run"; exit 2; }
[ -f packages/cli/src/bin.ts ]           || { echo "cannot prove — packages/cli/src/bin.ts missing (SPEC-007); the command cannot be dispatched"; exit 2; }
[ -f packages/conformance/src/run.ts ]   || { echo "cannot prove — packages/conformance/src/run.ts missing; nothing enumerates the classes"; exit 2; }
[ -f packages/conformance/src/report.ts ] || { echo "cannot prove — packages/conformance/src/report.ts missing; nothing assembles or refuses to restate a report"; exit 2; }
[ -f packages/conformance/src/classes/_contract.ts ] || { echo "cannot prove — packages/conformance/src/classes/_contract.ts missing; the class contract the independent re-run needs lives there"; exit 2; }
[ -f scripts/lib/members.mjs ]           || { echo "cannot prove — scripts/lib/members.mjs missing; Lock 2's eight document schemas cannot be counted"; exit 2; }
[ -d register ]                          || { echo "cannot prove — register/ missing; V8's key has no source"; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/changeover-conform-XXXXXX")" || { echo "cannot prove — could not create a temporary directory to write reports into"; exit 2; }
export CHANGEOVER_CONFORM_WORK="$WORK"
trap 'rm -rf "$WORK"' EXIT

# The command is run as a SUBPROCESS on purpose: the process exit code is one of
# the three places `unprovable` has to be first-class, and a function return read
# in-process is not that place.
node packages/cli/src/bin.ts conform \
  --only C-AUTHZ,C-USAGE,C-PII-INGEST \
  --bindings http,in_process \
  --latency-trials 3 \
  --observe-ms 50 \
  --reports-dir "$WORK/series" \
  --quiet > "$WORK/run.log" 2>&1
RUN_CODE=$?
export CHANGEOVER_CONFORM_RUN_CODE="$RUN_CODE"

node packages/cli/src/bin.ts conform \
  --only C-AUTHZ,C-PII-INGEST \
  --bindings http,in_process \
  --latency-trials 3 \
  --observe-ms 50 \
  --reports-dir "$WORK/series2" \
  --allow-unprovable --quiet > "$WORK/allow.log" 2>&1
ALLOW_CODE=$?
export CHANGEOVER_CONFORM_ALLOW_CODE="$ALLOW_CODE"

node --input-type=module -e '
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { CONFORMANCE_CLASSES } from "./packages/adapter-reference/src/classes.ts";
import { DOCUMENT_SCHEMAS } from "./scripts/lib/members.mjs";
import { classOutcome } from "./packages/conformance/src/classes/_contract.ts";
import { conformanceBench } from "./packages/conformance/src/classes/_bench.ts";
import {
  ReportRestated,
  buildReport,
  countStatuses,
  exitCodeFor,
  harnessProvenance,
  notMeasured,
  latencyNotMeasured,
  readSeries,
  reportPath,
  summaryLine,
  versions,
  writeReport,
} from "./packages/conformance/src/report.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const WORK = process.env.CHANGEOVER_CONFORM_WORK;
const RUN_CODE = Number(process.env.CHANGEOVER_CONFORM_RUN_CODE);
const ALLOW_CODE = Number(process.env.CHANGEOVER_CONFORM_ALLOW_CODE);
const SELECTED = ["C-AUTHZ", "C-USAGE", "C-PII-INGEST"];

/* ── 1 · The schema keeps three outcomes apart ────────────────────────────── */

const schema = JSON.parse(readFileSync("schemas/report.schema.json", "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
let validate = null;
try {
  validate = ajv.compile(schema);
  ok("schemas/report.schema.json compiles as JSON Schema 2020-12 with formats");
} catch (err) {
  bad("schemas/report.schema.json does not compile: " + (err && err.message ? err.message : String(err)));
}

const statusEnum = schema.$defs?.status?.enum ?? [];
["pass", "fail", "unprovable"].every((s) => statusEnum.includes(s)) && statusEnum.length === 3
  ? ok("the per-class status enum is exactly pass · fail · unprovable — three values, because two cannot carry three answers")
  : bad("the per-class status enum is " + JSON.stringify(statusEnum) + ", and unprovable must be one of exactly three");

// A schema that merely LISTS unprovable, while accepting it with no reason, has
// made it a synonym for "we did not say". The reason is what keeps it from
// becoming a place to put work.
const template = () => JSON.parse(readFileSync(REPORT_FILE, "utf8"));

/* ── 2 · The real run: it validates, and every class is in it ─────────────── */

const seriesRoot = join(WORK, "series");
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".json")) files.push(full);
  }
};
try { walk(seriesRoot); } catch { /* the runner wrote nothing */ }

if (files.length !== 1) {
  bad("the run wrote " + files.length + " reports into the series and exactly one was expected; log: " +
      cut(readFileSync(join(WORK, "run.log"), "utf8"), 900));
  console.log("PASS=0");
  process.exit(1);
}
const REPORT_FILE = files[0];
ok("one run wrote exactly one report, at " + REPORT_FILE.slice(WORK.length + 1));

const report = JSON.parse(readFileSync(REPORT_FILE, "utf8"));
if (validate !== null) {
  validate(report)
    ? ok("the emitted report validates against schemas/report.schema.json, every required member present")
    : bad("the emitted report does NOT validate: " + cut(JSON.stringify(validate.errors), 1200));
}

for (const member of ["spec_version", "register_version", "profile", "hold_basis", "floor_basis", "implementation",
                      "bindings", "run_at", "trials", "floor_violations", "operator_overrides",
                      "release_latency_ms", "oversell_events"]) {
  if (report[member] === undefined) bad("§7 names " + member + " and the report does not carry it");
}
ok("every member §7'"'"'s report paragraph names is present: spec_version, register_version, profile, hold_basis, " +
   "floor_basis, implementation, bindings, run_at, trials, per-class outcomes, floor_violations, operator_overrides, " +
   "release_latency_ms {p50,p95,max}, oversell_events, and the harness commit");

report.harness.commit === null || /^[0-9a-f]{40}$/.test(report.harness.commit)
  ? ok("the harness commit is a full hash (" + (report.harness.commit ?? "not a repository") + "), dirty=" + report.harness.dirty +
       " — a number without the code that measured it is an anecdote, and a hash beside uncommitted changes is a claim about code that did not run")
  : bad("the harness commit is " + JSON.stringify(report.harness.commit));

const { spec_version, register_version } = versions();
report.spec_version === spec_version && report.register_version === register_version
  ? ok("V8'"'"'s key comes off the register file itself: (" + spec_version + ", " + register_version + ")")
  : bad("the report'"'"'s versions are (" + report.spec_version + ", " + report.register_version + "), the register says (" + spec_version + ", " + register_version + ")");

const registered = CONFORMANCE_CLASSES.map((c) => c.id);
const reported = report.classes.map((c) => c.class);
const missing = registered.filter((id) => !reported.includes(id));
const duplicated = reported.filter((id, i) => reported.indexOf(id) !== i);
missing.length === 0 && duplicated.length === 0 && reported.length === registered.length
  ? ok("all " + registered.length + " §7 classes appear exactly once — a class ABSENT from a list of twenty-four is indistinguishable from one that passed")
  : bad("the report names " + reported.length + " classes: missing " + JSON.stringify(missing) + ", duplicated " + JSON.stringify(duplicated));

/* ── 3 · Every status is re-derived from its own clauses ──────────────────── */

const derive = (clauses) => {
  if (clauses.length === 0) return "empty";
  if (clauses.some((c) => c.status === "fail")) return "fail";
  if (clauses.some((c) => c.status === "unprovable")) return "unprovable";
  return "pass";
};

const disagreed = [];
for (const entry of report.classes) {
  const wanted = derive(entry.clauses);
  if (wanted === "empty") {
    // No clause at all is a fail or an unprovable, and NEVER a pass: a class
    // that ran and asserted nothing looks exactly like a class that passed.
    if (entry.status === "pass") disagreed.push(entry.class + ": pass with zero clauses");
    continue;
  }
  if (entry.status !== wanted) disagreed.push(entry.class + ": recorded " + entry.status + ", its clauses derive " + wanted);
}
disagreed.length === 0
  ? ok("every one of the " + report.classes.length + " recorded statuses is the one §7'"'"'s rule derives from that class'"'"'s own clauses — any fail → fail, else any unproven → unprovable, else pass")
  : bad("a recorded status disagrees with the clauses beneath it, which is the shape a green badge takes: " + disagreed.join(" · "));

const unreasoned = report.classes.filter((c) => c.status !== "pass" && (typeof c.reason !== "string" || c.reason.trim().length === 0));
unreasoned.length === 0
  ? ok("every fail and every unprovable carries a non-empty reason — an unreachable class with no stated reason is a place to put work")
  : bad("these carry no reason: " + unreasoned.map((c) => c.class).join(", "));

const overreasoned = report.classes.filter((c) => c.status === "pass" && c.reason !== undefined);
overreasoned.length === 0
  ? ok("and no passing class carries one, so a reason in the document always means something did not hold or could not be reached")
  : bad("these passed AND carry a reason: " + overreasoned.map((c) => c.class).join(", "));

const staleBlockers = report.classes
  .filter((c) => c.status === "unprovable" && typeof c.missing_path === "string" && existsSync(c.missing_path));
staleBlockers.length === 0
  ? ok("no unprovable class names a path that now EXISTS — the day one is written this proof turns red until the class is re-examined, which is the only mechanism that stops unprovable from outliving its blocker")
  : bad("stale blockers: " + staleBlockers.map((c) => c.class + " names " + c.missing_path + ", which exists").join(" · "));

/* ── 4 · A restricted run cannot manufacture a pass ───────────────────────── */

const unselected = report.classes.filter((c) => !SELECTED.includes(c.class));
const leaked = unselected.filter((c) => c.status !== "unprovable");
leaked.length === 0
  ? ok("all " + unselected.length + " classes this run did NOT execute are unprovable, never pass and never omitted — a restriction is a gap, not a result")
  : bad("a class the run did not execute is recorded as " + leaked.map((c) => c.class + "=" + c.status).join(", "));

unselected.every((c) => String(c.reason).startsWith("not selected"))
  ? ok("and each of them names the restriction as its reason rather than inheriting somebody else'"'"'s blocker")
  : bad("an unselected class'"'"'s reason does not name the restriction");

/* ── 5 · The classes are RE-RUN, and the report is compared to them ───────── */

const independent = new Map();
const bench = await conformanceBench();
try {
  for (const file of ["c-authz.ts", "c-usage.ts"]) {
    const module = await import("./packages/conformance/src/classes/" + file);
    const outcome = classOutcome(module, await module.run(bench));
    independent.set(module.id, outcome);
  }
} finally {
  await bench.close();
}
const { runCPiiIngest } = await import("./packages/conformance/src/inject/c-pii-ingest.ts");
const pii = runCPiiIngest();
independent.set("C-PII-INGEST", {
  class: "C-PII-INGEST",
  status: pii.length === 0 ? "fail" : pii.every((c) => c.held) ? "pass" : "fail",
  clauses: pii.map((c) => ({ clause: c.id, status: c.held ? "pass" : "fail", note: c.note })),
});

for (const id of SELECTED) {
  const mine = independent.get(id);
  const theirs = report.classes.find((c) => c.class === id);
  if (mine === undefined || theirs === undefined) { bad(id + ": could not be compared, one side is missing"); continue; }
  if (mine.status !== theirs.status) {
    bad(id + ": this script ran the class and got " + mine.status + "; the report says " + theirs.status);
    continue;
  }
  if (mine.clauses.length !== theirs.clauses.length) {
    bad(id + ": the class returned " + mine.clauses.length + " clauses and the report carries " + theirs.clauses.length +
        " — a report that drops a clause can drop the one that did not hold");
    continue;
  }
  const shape = (list) => list.map((c) => c.clause + "=" + c.status).join("|");
  shape(mine.clauses) === shape(theirs.clauses)
    ? ok(id + ": re-run independently here, and the report carries the same " + mine.clauses.length +
         " clauses with the same statuses (class " + mine.status + ")")
    : bad(id + ": the clause statuses differ between a fresh run and the report — " +
          cut(shape(mine.clauses), 300) + " vs " + cut(shape(theirs.clauses), 300));
}

/* ── 6 · unprovable is first-class in all three places at once ────────────── */

exitCodeFor({ pass: 24, fail: 0, unprovable: 0 }) === 0
  ? ok("all-pass exits 0")
  : bad("all-pass did not exit 0");
exitCodeFor({ pass: 23, fail: 0, unprovable: 1 }) === 2
  ? ok("one unprovable and no failure exits 2 — the third outcome has its own code, because collapsing it into 0 buys a green badge by making the report lie")
  : bad("an unprovable run did not exit 2");
exitCodeFor({ pass: 22, fail: 1, unprovable: 1 }) === 1
  ? ok("a failure alongside an unprovable exits 1: a failure is news and a gap is not, the same rule scripts/run_proofs.sh already encodes")
  : bad("a failing run with an unprovable did not exit 1");
exitCodeFor({ pass: 24, fail: 0, unprovable: 0 }, 1) === 2
  ? ok("and a requested binding no class drove is the same kind of gap: exit 2, because a report may not claim conformance over a transport it never spoke")
  : bad("an unexercised binding did not force exit 2");

const line = summaryLine({ pass: 6, fail: 1, unprovable: 3 });
/\b6 pass\b/.test(line) && /\b1 fail\b/.test(line) && /\b3 unprovable\b/.test(line)
  ? ok("the summary line names all three counts separately: " + JSON.stringify(line))
  : bad("the summary line does not carry three distinct counts: " + JSON.stringify(line));

const counts = countStatuses(report.classes);
counts.unprovable > 0 && counts.pass > 0
  ? ok("this run produced both outcomes at once — " + report.summary.line + " — so pass and unprovable are demonstrably distinct in one document, not merely distinct in the enum")
  : bad("this run produced " + report.summary.line + ", which cannot show the two outcomes apart");

report.summary.pass === counts.pass && report.summary.fail === counts.fail && report.summary.unprovable === counts.unprovable
  ? ok("the summary counts are the classes counted, not a number the runner was handed")
  : bad("the summary says " + JSON.stringify(report.summary) + " and the classes count " + JSON.stringify(counts));

RUN_CODE === report.summary.exit_code
  ? ok("the PROCESS exited " + RUN_CODE + ", which is the report'"'"'s own exit_code — the third place unprovable has to survive, after the enum and the summary line")
  : bad("the process exited " + RUN_CODE + " and the report says exit_code " + report.summary.exit_code);

ALLOW_CODE === 0
  ? ok("--allow-unprovable maps a whole-run 2 to 0 for CI, where there is no Postgres and no Docker daemon — the inventory is still printed in full and every entry of it is still in the report")
  : bad("--allow-unprovable did not map an unprovable run to 0; it exited " + ALLOW_CODE);

// And the limit of it, which is the half that matters. A FAILING run cannot be
// manufactured here — it would mean writing a deliberately broken class module
// into TEST-001..006'"'"'s directory, which this item may not touch — so the flag
// is applied by a function and the function is called with the codes a run
// cannot be made to produce. Five calls, no fixture, and the property is exact.
const { applyAllowUnprovable } = await import("./packages/cli/src/commands/conform.ts");
const mappings = [[0, true, 0], [1, true, 1], [2, true, 0], [1, false, 1], [2, false, 2]];
const wrong = mappings.filter(([code, allow, wanted]) => applyAllowUnprovable(code, allow) !== wanted);
wrong.length === 0
  ? ok("and it CANNOT hide a failure: --allow-unprovable maps 2→0 and leaves 1→1 and 0→0 untouched, with and without the flag — the green tick it buys CI is for a gap, never for a failure")
  : bad("--allow-unprovable maps a code it must not: " + wrong.map(([c, a, w]) => c + "/" + a + " → " + applyAllowUnprovable(c, a) + ", wanted " + w).join(" · "));

/* ── 7 · Reports are never restated ───────────────────────────────────────── */

const seriesDir = join(WORK, "restate");
const otherDir = join(WORK, "restate-other");
const fixed = "2026-08-26T09:00:00.000+12:00";
const makeReport = (run_at, classes) => buildReport({
  spec_version, register_version,
  profile: "1", hold_basis: "system_of_record", floor_basis: "owned_store",
  implementation: { name: "restatement-fixture", version: "0.0.0" },
  bindings: ["in_process"],
  binding_coverage: [{ binding: "in_process", exercised: true, classes: [classes[0].class] }],
  run_at, trials: 0, selection: { only: null }, classes,
  floor_violations: notMeasured("fixture", "this fixture asserts the writer, not a boundary"),
  operator_overrides: notMeasured("fixture", "this fixture asserts the writer, not a boundary"),
  release_latency_ms: latencyNotMeasured("fixture", "this fixture asserts the writer, not a boundary"),
  oversell_events: notMeasured("fixture", "this fixture asserts the writer, not a boundary"),
  harness: harnessProvenance({ driver: "none", concurrent: false }),
});
const passingClass = [{ class: "C-AUTHZ", spec_row: "a fixture row", status: "pass", binding: "in_process",
                        clauses: [{ clause: "C-AUTHZ.fixture", status: "pass", note: "a fixture clause" }] }];
const failingClass = [{ class: "C-AUTHZ", spec_row: "a fixture row", status: "fail", reason: "a fixture failure",
                        binding: "in_process",
                        clauses: [{ clause: "C-AUTHZ.fixture", status: "fail", note: "a fixture clause that did not hold" }] }];

const first = makeReport(fixed, passingClass);
if (validate !== null) {
  validate(first)
    ? ok("a report assembled from a fixture validates too, so the schema is a property of the shape and not of one lucky run")
    : bad("the fixture report does not validate: " + cut(JSON.stringify(validate.errors), 800));
}

const written = writeReport(first, { series_dir: seriesDir });
const before = readFileSync(written.path);
written.path === reportPath(seriesDir, { spec_version, register_version, run_at: fixed })
  ? ok("the series files a report at reports/<spec_version>/<register_version>/<run_at>.json, so V8'"'"'s key is the DIRECTORY and `ls` answers what is in the series")
  : bad("the report went to " + written.path);

let refused = 0;
const attempt = (label, doc, options) => {
  try {
    writeReport(doc, options);
    bad(label + " was WRITTEN — an overwritable report is a report somebody will quietly improve after a bad run, and then no entry in the series can be trusted");
  } catch (err) {
    if (err instanceof ReportRestated) { refused++; return true; }
    bad(label + " threw something other than ReportRestated: " + (err && err.message ? err.message : String(err)));
  }
  return false;
};

attempt("the identical report, written again", makeReport(fixed, passingClass), { series_dir: seriesDir }) &&
  ok("a second write of the same (spec_version, register_version, run_at) is REFUSED — reports are never restated (V8)");

// The dangerous one. Same triple, DIFFERENT content: this is the shape a quiet
// improvement takes, and a writer keyed on bytes would let it through.
attempt("a DIFFERENT report at the same triple", makeReport(fixed, failingClass), { series_dir: seriesDir }) &&
  ok("and so is a report with the same triple but different content — which is the shape a quiet improvement actually takes, and a writer keyed on bytes would let it through");

const after = readFileSync(written.path);
before.equals(after)
  ? ok("the report already on disk is byte-identical after both refusals — a refusal that truncated what it declined to replace would be worse than the overwrite it prevented")
  : bad("the existing report'"'"'s bytes CHANGED across a refused write");

const survivor = JSON.parse(readFileSync(written.path, "utf8"));
survivor.classes[0].status === "pass" && survivor.implementation.name === "restatement-fixture"
  ? ok("and it is still the first report, not the second: the failing fixture did not reach the file the passing one wrote")
  : bad("the file on disk is not the report that was written first");

const later = makeReport("2026-08-26T09:00:00.001+12:00", passingClass);
const secondWrite = writeReport(later, { series_dir: seriesDir });
existsSync(secondWrite.path) && secondWrite.path !== written.path
  ? ok("a LATER run at the same key is written, beside the first and not over it — V8 says a later run is a new report, and both are now in the series")
  : bad("a later run at a later run_at was not written as a new report");

readSeries(seriesDir).length === 2
  ? ok("the series now reads back as two entries, which is what a dated series that cannot be restated looks like on a disk")
  : bad("the series reads back " + readSeries(seriesDir).length + " entries and two were written");

// The refusal is scoped to a series and is not global paranoia: a different
// series root is a different series, and filing the same triple there is
// legitimate — a second implementation'"'"'s report is not a restatement of the
// first'"'"'s.
try {
  writeReport(makeReport(fixed, passingClass), { series_dir: otherDir });
  ok("the same triple filed into a DIFFERENT series root is written, because a second implementation'"'"'s report is not a restatement of the first'"'"'s");
} catch (err) {
  bad("a different series root refused a triple it has never seen: " + (err && err.message ? err.message : String(err)));
}

// --out is the convenience copy, and it is refused over an existing file for the
// same reason: `report.json` in a working directory is where the last run went.
const outPath = join(WORK, "out.json");
mkdirSync(WORK, { recursive: true });
writeFileSync(outPath, "{}\n");
attempt("--out over an existing path", makeReport("2026-08-26T09:00:00.002+12:00", passingClass),
        { series_dir: seriesDir, out: outPath }) &&
  ok("--out is refused over a file that already exists, so the convenience copy cannot destroy the previous run either");

refused === 3
  ? ok("all three restatement attempts were refused with ReportRestated, and none of them wrote anything")
  : bad(refused + " of 3 restatement attempts were refused");

/* ── 8 · The report schema is a HARNESS schema, and Lock 2 is unmoved ─────── */

DOCUMENT_SCHEMAS.length === 8 && !DOCUMENT_SCHEMAS.some((s) => String(s).includes("report"))
  ? ok("schemas/ grew by one file and Lock 2 did not move: scripts/lib/members.mjs still lists exactly 8 DOCUMENT schemas, and report.schema.json is not among them — it is a harness schema, and adding it would drag the report'"'"'s members into the member-manifest set-equality check")
  : bad("scripts/lib/members.mjs lists " + DOCUMENT_SCHEMAS.length + " document schemas: " + JSON.stringify(DOCUMENT_SCHEMAS));

// What would happen if it WERE added, computed rather than asserted. The
// contract'"'"'s warning is that report.schema.json'"'"'s members would be dragged into
// Lock 2'"'"'s set-equality check and prove_member_manifest.sh would fail for
// reasons nobody would find quickly. This is that number.
const manifest = new Set(JSON.parse(readFileSync("schemas/member-manifest.json", "utf8")).members);
const declared = new Set();
const walkSchema = (node) => {
  if (node === null || typeof node !== "object") return;
  if (node.properties !== undefined) for (const key of Object.keys(node.properties)) declared.add(key);
  for (const value of Object.values(node)) walkSchema(value);
};
walkSchema(schema);
const wouldBeAdded = [...declared].filter((m) => !manifest.has(m)).sort();
wouldBeAdded.length > 0
  ? ok("and the warning is real, not decorative: report.schema.json declares " + wouldBeAdded.length +
       " member names the manifest'"'"'s " + manifest.size + " do not carry (" + cut(wouldBeAdded.join(", "), 160) +
       "), so listing it as a document schema would break Lock 2 in both directions at once")
  : bad("report.schema.json declares no member the manifest lacks, which means the schema is empty or the manifest already carries it");

const manifestFile = readFileSync("schemas/member-manifest.json", "utf8");
!manifestFile.includes("report_schema") && !manifestFile.includes("oversell_events")
  ? ok("and schemas/member-manifest.json is untouched by this item — nothing was added to it, which is the only correct edit to a frozen allowlist that a harness schema does not belong in")
  : bad("schemas/member-manifest.json carries a report member name, so a harness schema has reached the document allowlist");

/* ── 9 · The measurements say when they were not taken ────────────────────── */

for (const name of ["floor_violations", "operator_overrides", "oversell_events"]) {
  const m = report[name];
  const consistent = m.basis === "observed" ? Number.isInteger(m.value) : m.value === null && typeof m.note === "string";
  if (!consistent) bad(name + " is inconsistent: " + JSON.stringify(m));
}
ok("every count carries its basis, and a count that was not taken is null rather than 0 — a zero meaning \"we did not look\" and a zero meaning \"we looked and there were none\" are the same byte, and the second is the finding worth publishing");

// The cohort is stated as DISTINCT Holds over attempted, so that a cohort which
// silently shrank is visible. It shrank twice while this was being written, and
// both were the runner'"'"'s fault rather than the boundary'"'"'s: `key()` truncates its
// Idempotency-Key seed at 32 characters, so a long label pushed the seat ids off
// the end and I1 correctly replayed ONE Hold six times; and a cohort larger than
// the published per-principal ceiling is a cohort the boundary is right to
// refuse. Zero violations over four Holds and zero over one are the same number
// and not the same observation, and only one of them is worth publishing.
const cohortNote = String(report.floor_violations.note ?? "");
const cohortMatch = /granted (\d+) distinct Holds of (\d+) attempted/.exec(cohortNote);
cohortMatch !== null && cohortMatch[1] === cohortMatch[2] && Number(cohortMatch[1]) > 0
  ? ok("the floor observation states its cohort as DISTINCT Holds over attempted (" + cohortMatch[0] + ") and the two agree — counting 201s instead would count one replayed Hold as many")
  : bad("the floor observation'"'"'s cohort is " + JSON.stringify(cohortNote.slice(0, 200)) + ", and a run whose cohort shrank cannot be told from one that did not");

const latency = report.release_latency_ms;
latency.basis === "observed"
  ? (typeof latency.value.substrate === "string" && latency.value.substrate.length > 0
      ? ok("release_latency_ms carries p50/p95/max AND the substrate they came from (" + latency.value.substrate + "), so an in-process number cannot read as one off an exhibitor boundary")
      : bad("release_latency_ms was observed with no substrate attached"))
  : ok("release_latency_ms is not_measured with a reason (" + cut(String(latency.note), 120) + "), which is the honest answer when C-RELEASE did not run");

console.log("");
console.log("  " + report.summary.line + " · exit " + report.summary.exit_code +
            " · driver " + report.harness.driver + " · concurrent " + report.harness.concurrent);
console.log("  This run was restricted to " + SELECTED.join(", ") + " so the proof is about the RUNNER.");
console.log("  The full twenty-four are run by `changeover conform` with no --only, and the dated series lives in reports/.");

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
CODE=$?
exit $CODE
