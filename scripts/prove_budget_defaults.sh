#!/usr/bin/env bash
# C-BUDGET / C-FANOUT at the PUBLISHED production defaults, sequentially.
#
# What is asserted: that the numbers this Server enforces are the numbers
# SPEC.md section 2.5 publishes — read out of the specification at run time, not
# copied into this script — and that every ceiling refuses naming the same
# number the document gives.
#
# Why the obvious cheaper check would not have caught it: a suite can assert
# every ceiling perfectly at max_live_holds_per_cluster: 4 and prove nothing at
# all. Exhaustion tested at harness values proves the code path exists;
# exhaustion tested at the published defaults proves the product. So the table is
# PARSED and compared, and every observed count is printed beside its published
# limit — because section 2.5 asserts a converse a green tick cannot show a
# reader: no limit observed at runtime may be absent from the document.
#
# Two ceilings here were never observed binding anywhere in this repository
# before: max_holds_per_site_per_hour, tested as a RATE with every earlier hold
# released so nothing is live when the seventh is refused, and the proportional
# half of X4, which needs a small house because 500 basis points of a 400-seat
# room is twenty seats and the absolute six always wins.
#
# The concurrent half of the same scenarios lives in
# prove_budget_defaults_concurrent.sh and exits 2 without a real Postgres.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f SPEC.md ]                                                 || { echo "cannot prove — SPEC.md missing; section 2.5 is the authority these defaults are checked against"; exit 2; }
[ -f packages/core/src/budgets.ts ]                            || { echo "cannot prove — packages/core/src/budgets.ts missing (CORE-006)"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]                         || { echo "cannot prove — packages/core/src/hold-seats.ts missing (CORE-002)"; exit 2; }
[ -f packages/core/src/release.ts ]                            || { echo "cannot prove — packages/core/src/release.ts missing (CORE-003); the rate scenario releases every hold before asking for the next"; exit 2; }
[ -f packages/conformance/src/budget/c-budget.ts ]             || { echo "cannot prove — packages/conformance/src/budget/c-budget.ts missing"; exit 2; }
[ -f packages/conformance/src/budget/c-fanout.ts ]             || { echo "cannot prove — packages/conformance/src/budget/c-fanout.ts missing"; exit 2; }

node --input-type=module -e '
import { openDb } from "./packages/store/src/db.ts";
import { migrate } from "./packages/store/src/migrate.ts";
import { bootBudgetBench, estateIntact, privateBenchUrl } from "./packages/conformance/src/budget/estate.ts";
import { parsePublishedTable, parityChecks, SectionNotFound, SPEC_PATH } from "./packages/conformance/src/budget/published.ts";
import { renderObservations } from "./packages/conformance/src/budget/observed.ts";
import { C_BUDGET, sequential as budgetSequential } from "./packages/conformance/src/budget/c-budget.ts";
import { C_FANOUT, sequential as fanoutSequential } from "./packages/conformance/src/budget/c-fanout.ts";

let fail = 0, pass = 0, estateGone = false;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };
const record = (checks) => { for (const c of checks) (c.held ? ok : bad)(c.statement); };

// The table first. If section 2.5 cannot be read, nothing below means anything
// and this is an exit 2 rather than a failure: an unreadable authority is a
// thing we could not reach, not a boundary that misbehaved.
let table;
try {
  table = parsePublishedTable();
} catch (err) {
  if (err instanceof SectionNotFound) {
    console.log("cannot prove — " + err.message);
    console.log("  to make it provable: restore the hold-policy table at SPEC.md section 2.5");
    process.exit(2);
  }
  throw err;
}

if (table.size === 0) {
  console.log("cannot prove — SPEC.md section 2.5 was found and no table rows could be parsed from it");
  process.exit(2);
}
ok(`section 2.5 parsed from ${SPEC_PATH.split("/").slice(-1)[0]}: ${table.size} published members`);

// Where a real Postgres is configured, this bench takes a database of its own on
// it. PGlite already hands every openDb() a private cluster; a shared server does
// not, and every bench in this repository truncates the occasion table at setup,
// so two proofs against one database delete each others fixtures. Measured: one
// run in three came back with every grant refused occasion_not_found.
const base = process.env.CHANGEOVER_PG_URL;
const url = base ? await privateBenchUrl(base, "changeover_budget_bench") : undefined;
const db = await openDb(url ? { url } : {});
if (url) ok(`the bench holds its own database on the configured server: ${new URL(url).pathname.slice(1)}`);
const observations = [];
let trials = 0;

try {
  await migrate(db);
  const bench = await bootBudgetBench(db);

  // Parity: HOLD_POLICY_PUBLISHED IS the published document. Every scenario
  // below runs at it, so this is the check that makes the rest mean something.
  record(parityChecks(bench.policy, table));

  const budget = await budgetSequential(bench, table);
  const fanout = await fanoutSequential(bench, table);

  for (const outcome of [budget, fanout]) {
    record(outcome.checks);
    observations.push(...outcome.observations);
    trials += outcome.trials;
  }

  (budget.verdict === "pass")
    ? ok(`${C_BUDGET.class_id} · ${budget.checks.length} clauses held over ${budget.trials} hold attempts at production defaults`)
    : bad(`${C_BUDGET.class_id} · ${budget.checks.filter((c) => !c.held).length} clauses did not hold`);
  (fanout.verdict === "pass")
    ? ok(`${C_FANOUT.class_id} · ${fanout.checks.length} clauses held over ${fanout.trials} hold attempts at production defaults`)
    : bad(`${C_FANOUT.class_id} · ${fanout.checks.filter((c) => !c.held).length} clauses did not hold`);
} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
} finally {
  // Asked BEFORE the handle closes, and only consulted when something failed:
  // a neighbouring proof holding the same CHANGEOVER_PG_URL runs
  // "truncate occasion cascade" at its own bench setup, which deletes the
  // fixtures these assertions were made against. A run whose estate was taken
  // out from under it did not observe a violation.
  try { estateGone = !(await estateIntact(db)); } catch { estateGone = true; }
  await db.close();
}

if (fail && estateGone) {
  console.log("");
  console.log("cannot prove — the seeded estate is no longer in the store, so every refusal above is");
  console.log("                occasion_not_found and none of it is a statement about the boundary.");
  console.log("                A concurrent holder of this CHANGEOVER_PG_URL ran resetEstate, which is");
  console.log("                truncate occasion cascade, while these assertions were running.");
  console.log("  to make it provable:");
  console.log("    run this script with no other proof running against the same database, or");
  console.log("    unset CHANGEOVER_PG_URL to run it against a private PGlite cluster");
  process.exit(2);
}

console.log("");
console.log("observed beside published — SPEC.md section 2.5, sequential callers, " + trials + " hold attempts");
console.log(renderObservations(observations));
console.log("");

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
