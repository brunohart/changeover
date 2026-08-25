#!/usr/bin/env bash
# C-ATOMIC .1–.4. The floor: oversell is made UNREPRESENTABLE, not prevented.
#
# The obvious cheaper check — hold a seat, hold it again, observe a 409 — is
# already covered by prove_guard_order.sh and it does not test this at all.
# Sequentially the second caller reads a row the first has committed and any
# implementation refuses it. What C-ATOMIC claims is that two hundred callers
# arriving AT ONCE at a hundred seats produce exactly a hundred Holds: that the
# ceiling is a unique index a concurrent transaction cannot bypass, and not a
# SELECT that two requests three milliseconds apart both pass.
#
# And every count below is read from the STORE, never from the responses. A
# Server that answers 409 while leaving a row behind passes a response-level
# suite and oversells in production, so the assertion sits where a partial hold
# cannot hide.
#
# .3 and .4 are sequential, need no second connection, and run on PGlite — they
# are printed either way, because discarding real evidence is not honesty
# either. .1 and .2 are claims about two callers racing. PGlite 0.5.7 is
# PostgreSQL 18.3 and enforces the partial unique indexes for real, but it is
# single-connection and in-process: lock contention and 40P01 cannot occur
# there, so a pass on it would mean nothing. Without CHANGEOVER_PG_URL this
# script exits 2. It never exits 0 for a race it did not run.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]   || { echo "cannot prove — packages/core/src/hold-seats.ts missing (CORE-002)"; exit 2; }
[ -f packages/core/src/claim.ts ]        || { echo "cannot prove — packages/core/src/claim.ts missing (CORE-004)"; exit 2; }
[ -f packages/core/src/hand-off.ts ]     || { echo "cannot prove — packages/core/src/hand-off.ts missing (CORE-004)"; exit 2; }
[ -d packages/store/src/migrations ]     || { echo "cannot prove — packages/store/src/migrations missing (CORE-001)"; exit 2; }
[ -f packages/conformance/src/atomic/assertions.ts ] || { echo "cannot prove — packages/conformance/src/atomic/assertions.ts missing (TEST-001)"; exit 2; }

node --input-type=module -e '
import { openDb, CannotProve, EXIT_CANNOT_PROVE } from "./packages/store/src/db.ts";
import { C_ATOMIC_PROFILE, profileLines } from "./packages/conformance/src/atomic/profile.ts";
import {
  allOrNothing,
  claimedSeatIsUnholdable,
  raceExpiryBoundary,
  raceHouse,
  setUpAtomicEstate,
} from "./packages/conformance/src/atomic/assertions.ts";

let fail = 0, pass = 0;
const report = {
  ok:   (m) => { console.log("ok — " + m); pass++; },
  bad:  (m) => { console.log("FAIL — " + m); fail = 1; },
  note: (m) => { console.log("     · " + m); },
};

// §7: the profile is part of the assertion. A concurrency result without one is
// not reproducible.
for (const line of profileLines()) console.log("     · " + line);

const remedy = (why) => {
  console.log("cannot prove — " + why);
  console.log("  to make it provable:");
  console.log("    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18");
  console.log("    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover");
  console.log("    bash scripts/prove_no_oversell.sh");
};

const concurrent = Boolean(process.env.CHANGEOVER_PG_URL);
let db;
try {
  // One handle for all four. Under PGlite the pool size is ignored; under
  // node-postgres it is the number of connections "concurrent" actually means,
  // which is why the profile states it rather than leaving it to a default.
  db = await openDb({ poolSize: C_ATOMIC_PROFILE.pool_size });
} catch (err) {
  remedy("the store did not open: " + String(err && err.message ? err.message : err));
  process.exit(EXIT_CANNOT_PROVE);
}

try {
  await setUpAtomicEstate(db);

  /* ---- .3 and .4 — sequential, and they run everywhere ------------------- */

  await claimedSeatIsUnholdable(db, report);
  await allOrNothing(db, report);

  /* ---- .1 and .2 — only against a server that can actually race ---------- */

  if (!concurrent || !db.concurrent) {
    console.log("     · .1 and .2 were NOT run: they are the whole of the atomicity claim and they need two connections");
    remedy("C-ATOMIC .1/.2 need true concurrency, and PGlite is single-connection and in-process:\n" +
           "                lock contention and 40P01 cannot occur there, so a pass would mean nothing.");
    console.log(`PASS=${fail ? 0 : pass}`);
    await db.close();
    process.exit(fail ? 1 : EXIT_CANNOT_PROVE);
  }

  if (db.driver !== "pg") {
    console.log("cannot prove — CHANGEOVER_PG_URL is set but openDb returned the " + db.driver + " driver");
    console.log(`PASS=${fail ? 0 : pass}`);
    await db.close();
    process.exit(EXIT_CANNOT_PROVE);
  }

  const level = (await db.query("show default_transaction_isolation")).rows[0];
  report.ok(`a real Postgres answered, driver ${db.driver}, concurrent ${db.concurrent}, ` +
            `default isolation ${Object.values(level)[0]} — .1 and .2 below are races, not simulations`);

  await raceHouse(db, report);
  await raceExpiryBoundary(db, report);
} catch (err) {
  if (err instanceof CannotProve) {
    remedy(err.message);
    console.log(`PASS=${fail ? 0 : pass}`);
    await db.close();
    process.exit(EXIT_CANNOT_PROVE);
  }
  report.bad("unexpected — " + String(err && err.stack ? err.stack.split("\n").slice(0, 5).join(" | ") : err));
} finally {
  await db.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
