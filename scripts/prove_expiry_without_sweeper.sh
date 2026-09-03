#!/usr/bin/env bash
# C-ORPHAN, with C-IDEMPOTENT and C-RELEASE. TEST-003.
#
# §4.8: a client disappears — SIGKILL, a crash, a partition, a model that gave
# up — and its seats and its budgets come back through the NEXT CONTENDING
# TRANSACTION, not through a background process. "A sweeper MAY exist as an
# optimisation; correctness MUST NOT rest on it."
#
# The obvious cheaper check is to set `sweeper: false` in a config and assert the
# seats came back. That check would pass whether or not a sweeper was running: it
# records what an operator intended, and if something were quietly sweeping, the
# seats would return, the suite would go green, and the actual claim — that lazy
# reap under L1 is sufficient ON ITS OWN — would never have been tested once. So
# the absence is measured four ways instead: a call count at the Db seam, a pid
# check on the killed client, a pg_stat_activity census, and repeated counts of
# an EXPIRED Hold's rows that do not move. The fourth needs nobody's cooperation:
# anything that swept would have to make a row disappear, and rows are counted.
#
# The client is a real OS process, killed with a real SIGKILL. Simulating
# disappearance by declining to call `release_hold` would prove the reclaim works
# when the caller is polite about being rude.
#
# PGlite is PostgreSQL 18.3 compiled to wasm, single-connection and in-process:
# "the next contending transaction" requires a contender, and there cannot be
# one there. C-ORPHAN therefore exits 2 without CHANGEOVER_PG_URL and never
# exits 0 on a simulation. C-IDEMPOTENT and C-RELEASE are sequential, run on
# either substrate, and run FIRST — so a regression in them turns this script
# red even on the CI path where C-ORPHAN cannot be reached.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]   || { echo "cannot prove — packages/core/src/hold-seats.ts missing (CORE-002)"; exit 2; }
[ -f packages/core/src/release.ts ]      || { echo "cannot prove — packages/core/src/release.ts missing (CORE-003)"; exit 2; }
[ -f packages/core/src/idempotency.ts ]  || { echo "cannot prove — packages/core/src/idempotency.ts missing (CORE-005)"; exit 2; }
[ -f packages/core/src/budgets.ts ]      || { echo "cannot prove — packages/core/src/budgets.ts missing (CORE-006)"; exit 2; }
[ -f packages/conformance/src/lifecycle/c-orphan.ts ] || { echo "cannot prove — packages/conformance/src/lifecycle/c-orphan.ts missing (TEST-003)"; exit 2; }

# A static observation, before anything is opened: this repository ships no
# recurring timer at all. It is not the proof — the proof is the four
# measurements below — but a sweeper that existed in the source and was merely
# switched off is worth refusing to start from. The scan is the conformance
# module's own, called here rather than restated as a grep: two definitions of
# "a recurring timer" is one of them silently drifting.
SWEEPERS=$(node --input-type=module -e 'import { recurringTimerSources } from "./packages/conformance/src/lifecycle/sweeper-absence.ts"; console.log(recurringTimerSources().join(" "));' 2>&1)
[ -z "$SWEEPERS" ] || { echo "cannot prove — a recurring timer is registered in: $SWEEPERS"; echo "                the sweeper-absence claim needs re-stating before C-ORPHAN can mean anything"; exit 2; }

PG=1
if [ -z "${CHANGEOVER_PG_URL:-}" ]; then
  PG=0
fi

node --input-type=module -e '
import { cIdempotent } from "./packages/conformance/src/lifecycle/c-idempotent.ts";
import { cRelease } from "./packages/conformance/src/lifecycle/c-release.ts";
import { cOrphan } from "./packages/conformance/src/lifecycle/c-orphan.ts";

let fail = 0, pass = 0, unprovable = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const run = Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);

const report = (result) => {
  for (const note of result.notes) console.log("     " + result.id + " · " + note);
  if (result.unprovable !== undefined) {
    unprovable++;
    console.log("cannot prove — " + result.id + ": " + result.unprovable);
    return;
  }
  for (const check of result.checks) (check.held ? ok : bad)(result.id + " · " + check.text);
};

// Sequential first, so a regression in them is a FAILURE on every substrate and
// not a skip on the one CI runs.
report(await cIdempotent({ run_id: "i" + run }));
report(await cRelease({ run_id: "r" + run }));

if (process.env.CHANGEOVER_PG_URL) {
  report(await cOrphan({ run_id: "o" + run }));
} else {
  unprovable++;
  console.log("cannot prove — C-ORPHAN needs true concurrency, and PGlite is single-connection and in-process:");
  console.log("                \"the next contending transaction\" requires a contender, and there cannot be one there,");
  console.log("                so a pass would mean nothing and the measured latencies would be about wasm.");
  console.log("  to make it provable:");
  console.log("    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18");
  console.log("    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover");
  console.log("    bash scripts/prove_expiry_without_sweeper.sh");
}

console.log(`PASS=${fail ? 0 : pass}`);
// 1 beats 2: a failure is news and a gap is not. Only a run in which everything
// reachable held, and something was unreachable, is a 2.
process.exit(fail ? 1 : unprovable > 0 ? 2 : 0);
'
CODE=$?
exit $CODE
