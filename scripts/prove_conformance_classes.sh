#!/usr/bin/env bash
# TEST-006's twelve conformance classes: C-SUBST, C-ORIGIN, C-AUTHZ, C-REFUSE,
# C-CLOCK, C-LOG, C-SEATMAP, C-CLAIM, C-USAGE, C-PROFILE0, C-REVOKE, C-FLOOR.
# Every one of them RUNS and reports pass, fail, or unprovable-with-a-reason.
#
# The obvious cheaper check is to run the classes and count the failures. It
# would report a clean green suite for a class module that was deleted, renamed,
# or written to return no clauses at all -- and in a list of twelve nobody counts
# the rows. So the enumeration is held as data in `_contract.ts`, the directory
# is read back, and the two must agree in BOTH directions: a class in the list
# with no module fails, and a module nobody runs fails.
#
# The same trap, one level down. `unprovable` is the honest answer to an
# assertion this repository cannot reach, and it is also the perfect place to put
# work nobody did. Two things stop that here. Every unprovable clause must carry
# a non-empty reason -- `Clauses.cannot` throws otherwise, and a throw is a
# failure, never a pass. And where the reason is an ABSENCE, the clause names the
# absent repository path and this script re-checks it: the day somebody writes
# `packages/agent`, six clauses across four classes stop being unprovable and
# this proof turns RED until they are re-examined. A blocker that outlives its
# blocker is a lie with a green tick on it.
#
# Not concurrency-gated, and it must not become so. Every assertion in the twelve
# is a refusal, a document, a header or a count against the store, all of which
# are reachable on PGlite and identically reachable against CHANGEOVER_PG_URL.
# Both were run before this script was committed.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/ajv ]                  || { echo "cannot prove — ajv not installed; run npm install at the repository root. Four classes validate a served document against the frozen schemas"; exit 2; }
[ -f packages/conformance/src/classes/_contract.ts ] || { echo "cannot prove — packages/conformance/src/classes/_contract.ts missing; the class contract and the enumeration of the twelve live there"; exit 2; }
[ -f packages/conformance/src/classes/_bench.ts ]    || { echo "cannot prove — packages/conformance/src/classes/_bench.ts missing; there is no estate, no credential pair and no running binding to assert over"; exit 2; }
[ -f packages/http/src/server.ts ]       || { echo "cannot prove — packages/http/src/server.ts missing; eleven of the twelve classes assert over the HTTP binding"; exit 2; }
[ -f schemas/capability.schema.json ]    || { echo "cannot prove — schemas/capability.schema.json missing; C-USAGE and C-PROFILE0 validate against it"; exit 2; }
[ -f fixtures/dst/fold.json ]            || { echo "cannot prove — fixtures/dst/fold.json missing; C-CLOCK's fold fixture is the two 02:30s of one night"; exit 2; }
[ -f fixtures/dst/gap.json ]             || { echo "cannot prove — fixtures/dst/gap.json missing; C-CLOCK's gap fixture is the 02:30 that does not exist"; exit 2; }

node --input-type=module -e '
import { existsSync, readdirSync } from "node:fs";
import { EXIT_CANNOT_PROVE } from "./packages/store/src/db.ts";
import { TEST_006_CLASSES, classOutcome, classThrew } from "./packages/conformance/src/classes/_contract.ts";
import { conformanceBench } from "./packages/conformance/src/classes/_bench.ts";

let fail = 0, pass = 0, unprovable = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const DIR = "packages/conformance/src/classes";
const fileFor = (id) => id.toLowerCase() + ".ts";

/* -- 1 · the list and the directory must agree, both directions ----------- */

const on_disk = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.startsWith("_")).sort();
const expected = TEST_006_CLASSES.map(fileFor).sort();
const missing = expected.filter((f) => !on_disk.includes(f));

missing.length === 0
  ? ok(`all ${expected.length} class modules TEST_006_CLASSES names are present in ${DIR}`)
  : bad(`class modules named but absent, which is a silently skipped class: ${missing.join(", ")}`);

// The directory is SHARED — TEST-004 keeps c-absence.ts here and TEST-007 reads
// the whole of it — so a file this item does not name is somebody else running
// their own class, not a class going unrun. What must not happen is one of the
// twelve being exported from a file other than the one named for it: a module
// renamed or copied, with the original still in place, gives a report in which
// one class is silently the other. So every module here is asked its id.
const claims = new Map();
const foreign = [];
for (const file of on_disk) {
  let claimed = null;
  try {
    claimed = (await import("./" + DIR + "/" + file)).id;
  } catch (err) {
    if (expected.includes(file)) bad(`${file}: could not be imported to read its id (${err && err.message ? err.message : String(err)})`);
    continue;
  }
  if (!TEST_006_CLASSES.includes(claimed)) { foreign.push(`${file} (${claimed})`); continue; }
  claims.set(claimed, [...(claims.get(claimed) ?? []), file]);
}
const wrong = [...claims.entries()]
  .filter(([id, files]) => files.length !== 1 || files[0] !== fileFor(id))
  .map(([id, files]) => `${id} ← ${files.join(" + ")}`);
wrong.length === 0
  ? ok(`and each of the twelve is exported by exactly the one file named for it — ${foreign.length} further module${foreign.length === 1 ? "" : "s"} in the directory belong to other items (${foreign.join(", ") || "none"}) and are theirs to run`)
  : bad(`a class id is exported by a file that is not the one named for it, so the report would name one class and run another: ${wrong.join(" · ")}`);

/* -- 2 · run the twelve --------------------------------------------------- */

const bench = await conformanceBench();
const outcomes = [];
try {
  for (const id of TEST_006_CLASSES) {
    const path = "./" + DIR + "/" + fileFor(id);
    let module = null;
    try {
      module = await import(path);
    } catch (err) {
      bad(`${id}: its module could not be imported (${err && err.message ? err.message : String(err)})`);
      outcomes.push({ class: id, status: "fail", reason: "not importable", clauses: [] });
      continue;
    }
    if (module.id !== id) {
      bad(`${id}: ${fileFor(id)} exports id "${module.id}", so the module the list names is not the module that ran`);
      continue;
    }
    if (typeof module.run !== "function" || typeof module.spec_row !== "string" || module.spec_row.length === 0) {
      bad(`${id}: the module exports no run() or no spec_row, so it cannot report anything`);
      continue;
    }

    let outcome;
    try {
      outcome = classOutcome(module, await module.run(bench));
    } catch (err) {
      outcome = classThrew(module, err);
    }
    outcomes.push(outcome);

    for (const clause of outcome.clauses) {
      if (typeof clause.note !== "string" || clause.note.trim().length === 0) {
        bad(`${clause.clause}: reported ${clause.status} with an empty note`);
        continue;
      }
      if (clause.status === "pass") ok(`${clause.clause}: ${cut(clause.note, 132)}`);
      else if (clause.status === "fail") bad(`${clause.clause}: ${clause.note}`);
      else {
        unprovable++;
        console.log("cannot prove — " + clause.clause + ": " + clause.note);
        if (clause.missing_path !== undefined && existsSync(clause.missing_path)) {
          bad(`${clause.clause}: its blocker names ${clause.missing_path}, and that path now EXISTS — the reason is stale and the clause must be re-examined`);
        }
      }
    }

    if (outcome.clauses.length === 0) {
      bad(`${id}: ${outcome.reason}`);
    } else if (outcome.status === "fail") {
      bad(`${id}: the class FAILS — ${cut(outcome.reason ?? "", 400)}`);
    }
  }
} finally {
  await bench.close();
}

/* -- 3 · the gate --------------------------------------------------------- */

const reported = outcomes.filter((o) => o.clauses.length > 0 || o.status === "fail");
reported.length === TEST_006_CLASSES.length
  ? ok(`all ${TEST_006_CLASSES.length} classes ran and reported a typed outcome; none was silently skipped`)
  : bad(`${TEST_006_CLASSES.length - reported.length} of the ${TEST_006_CLASSES.length} classes reported nothing at all`);

const by_status = (s) => outcomes.filter((o) => o.status === s).map((o) => o.class);
console.log("");
console.log("  twelve classes: " +
  by_status("pass").length + " pass · " +
  by_status("unprovable").length + " unprovable · " +
  by_status("fail").length + " fail");
for (const outcome of outcomes) {
  console.log("    " + outcome.status.padEnd(10) + " " + outcome.class.padEnd(11) +
    " " + outcome.clauses.filter((c) => c.status === "pass").length + "/" + outcome.clauses.length + " clauses held");
}
if (by_status("unprovable").length > 0) {
  console.log("");
  console.log("  These classes did not fail. Part of each §7 row could not be reached here, and each");
  console.log("  unprovable clause above names what is missing in terms an editor can act on.");
}

console.log(`PASS=${fail ? 0 : pass}`);
// 1 beats 2: a failure is news and a gap is not. Only a run in which everything
// reachable held, and something was unreachable, is a 2 — and CI runs the suite
// with --allow-unprovable, which never hides a failure.
process.exit(fail ? 1 : unprovable > 0 ? EXIT_CANNOT_PROVE : 0);
'
CODE=$?
exit $CODE
