#!/usr/bin/env bash
# C-BUDGET / C-FANOUT at the PUBLISHED production defaults, with the callers
# genuinely simultaneous.
#
# What is asserted: section 7 states both classes in terms of CONCURRENT holds —
# "max+1 concurrent holds yield exactly max; two concurrent same-cluster holds
# for one principal yield exactly one; two principals on one platform both
# succeed" — and a sequential run cannot distinguish a ceiling that is a
# constraint or a lock from a ceiling that is an unlocked SELECT. Section 4.6
# names the failure exactly: at READ COMMITTED two hold_seats three milliseconds
# apart both count zero live holds in a cluster, both pass, both commit.
#
# Why the obvious cheaper check would not have caught it: three of the ceilings
# raced here are not carried by any constraint at all. max_holds_per_site_per_hour,
# max_live_seats_per_showtime and max_held_fraction_per_showtime are aggregates
# counted by a SELECT that is correct ONLY because an advisory transaction lock
# is held across it. Remove the lock and every sequential assertion in
# prove_budget_defaults.sh still passes. This script is the entire evidence that
# the lock is there and that it is the right one.
#
# It runs at READ COMMITTED deliberately, the level holdSeats itself opens,
# because N1 permits SERIALIZABLE with transparent retry OR constraint-and-lock
# backing, and holding at the weaker level is the evidence this implementation
# chose the second and actually did it.
#
# PGlite is single-connection and in-process: lock contention cannot occur there,
# so a pass on it would mean nothing. Without a real Postgres this exits 2. It
# never exits 0 for a race it did not run.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

[ -f SPEC.md ]                                     || { echo "cannot prove — SPEC.md missing; section 2.5 is the authority these defaults are checked against"; exit 2; }
[ -f packages/core/src/budgets.ts ]                || { echo "cannot prove — packages/core/src/budgets.ts missing (CORE-006)"; exit 2; }
[ -f packages/conformance/src/budget/c-budget.ts ] || { echo "cannot prove — packages/conformance/src/budget/c-budget.ts missing"; exit 2; }
[ -f packages/conformance/src/budget/c-fanout.ts ] || { echo "cannot prove — packages/conformance/src/budget/c-fanout.ts missing"; exit 2; }
[ -d node_modules/pg ]                             || { echo "cannot prove — node-postgres not installed; run npm install at the repository root"; exit 2; }

if [ -z "${CHANGEOVER_PG_URL:-}" ]; then
  echo "cannot prove — C-BUDGET and C-FANOUT are stated in terms of CONCURRENT holds, and PGlite is"
  echo "                single-connection and in-process: lock contention cannot occur there, so a pass"
  echo "                would mean nothing. The sequential half runs everywhere and is in"
  echo "                scripts/prove_budget_defaults.sh."
  echo "  to make it provable:"
  echo "    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18"
  echo "    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover"
  echo "    bash scripts/prove_budget_defaults_concurrent.sh"
  exit 2
fi

node --input-type=module -e '
import { openDb } from "./packages/store/src/db.ts";
import { migrate } from "./packages/store/src/migrate.ts";
import { bootBudgetBench, estateIntact, privateBenchUrl } from "./packages/conformance/src/budget/estate.ts";
import { parsePublishedTable, parityChecks, SectionNotFound } from "./packages/conformance/src/budget/published.ts";
import { renderObservations } from "./packages/conformance/src/budget/observed.ts";
import { C_BUDGET, concurrent as budgetConcurrent } from "./packages/conformance/src/budget/c-budget.ts";
import { C_FANOUT, concurrent as fanoutConcurrent } from "./packages/conformance/src/budget/c-fanout.ts";

let fail = 0, pass = 0, estateGone = false;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };
const record = (checks) => { for (const c of checks) (c.held ? ok : bad)(c.statement); };

const remedy = () => {
  console.log("  to make it provable:");
  console.log("    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18");
  console.log("    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover");
  console.log("    bash scripts/prove_budget_defaults_concurrent.sh");
};

let table;
try {
  table = parsePublishedTable();
} catch (err) {
  if (err instanceof SectionNotFound) {
    console.log("cannot prove — " + err.message);
    process.exit(2);
  }
  throw err;
}
if (table.size === 0) {
  console.log("cannot prove — SPEC.md section 2.5 was found and no table rows could be parsed from it");
  process.exit(2);
}

let db, benchUrl;
try {
  // A database of its own on the configured server. Multi-connection, which is
  // the whole point of this script, and private, which is what stops a
  // neighbouring proof truncating the estate mid-race and turning a correct
  // boundary into twenty-four red lines.
  benchUrl = await privateBenchUrl(process.env.CHANGEOVER_PG_URL, "changeover_budget_race");
  db = await openDb({ url: benchUrl, poolSize: 16 });
  if (db.driver !== "pg") {
    console.log("cannot prove — CHANGEOVER_PG_URL is set but openDb returned the " + db.driver + " driver");
    await db.close();
    process.exit(2);
  }
  if (!db.concurrent) {
    console.log("cannot prove — the driver reports concurrent=false, so these assertions cannot race");
    await db.close();
    process.exit(2);
  }
  await db.query("select 1");
} catch (err) {
  console.log("cannot prove — CHANGEOVER_PG_URL is set but the server did not answer: " +
    String(err && err.message ? err.message : err));
  remedy();
  if (db) await db.close().catch(() => {});
  process.exit(2);
}

const observations = [];
let trials = 0;

try {
  await migrate(db);
  const level = (await db.query("show default_transaction_isolation")).rows[0];
  ok(`a real Postgres answered, driver ${db.driver}, concurrent ${db.concurrent}, default isolation ${Object.values(level)[0]}`);
  ok(`section 2.5 parsed from the specification: ${table.size} published members`);
  ok(`the race holds its own database on the configured server: ${new URL(benchUrl).pathname.slice(1)}`);

  const bench = await bootBudgetBench(db);
  record(parityChecks(bench.policy, table));

  const budget = await budgetConcurrent(bench, table);
  const fanout = await fanoutConcurrent(bench, table);

  for (const outcome of [budget, fanout]) {
    record(outcome.checks);
    observations.push(...outcome.observations);
    trials += outcome.trials;
  }

  (budget.verdict === "pass")
    ? ok(`${C_BUDGET.class_id} · ${budget.checks.length} clauses held under true concurrency at production defaults`)
    : bad(`${C_BUDGET.class_id} · ${budget.checks.filter((c) => !c.held).length} clauses did not hold`);
  (fanout.verdict === "pass")
    ? ok(`${C_FANOUT.class_id} · ${fanout.checks.length} clauses held under true concurrency at production defaults`)
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
console.log("observed beside published — SPEC.md section 2.5, SIMULTANEOUS callers, " + trials + " hold attempts");
console.log(renderObservations(observations));
console.log("");

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
