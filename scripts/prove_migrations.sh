#!/usr/bin/env bash
# CORE-001. The schema carries the floor: oversell is unrepresentable rather
# than prevented, the Hold's state is derived rather than stored, and the access
# log is append-only by GRANT rather than by discipline.
#
# The cheaper check — "the migration ran without error" — would not have caught
# any of it. A predicate missing 'claimed' still creates an index. A `state`
# column on `hold` still applies. A log with UPDATE granted to the agent role
# still logs. Each of those is a boundary reporting a property it does not have,
# which is the one failure mode this repository exists to make impossible.
#
# This runs against PGlite deliberately, even when CHANGEOVER_PG_URL is set, so
# the gate always tests the substrate every clean clone actually has.
# scripts/prove_migrations_pg.sh runs the identical assertion set against a real
# Postgres 16+ and exits 2 when there is not one. Both call auditSchema() in
# packages/store/src/audit.ts, so the two can never drift apart.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/store/src/migrate.ts ]     || { echo "cannot prove — packages/store/src/migrate.ts missing"; exit 2; }
[ -f packages/store/src/audit.ts ]       || { echo "cannot prove — packages/store/src/audit.ts missing"; exit 2; }
[ -d packages/store/src/migrations ]     || { echo "cannot prove — packages/store/src/migrations/ missing"; exit 2; }

node --input-type=module -e '
import { openDb } from "./packages/store/src/db.ts";
import { auditSchema } from "./packages/store/src/audit.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const db = await openDb({ driver: "pglite" });
try {
  if (db.driver !== "pglite") bad("openDb returned " + db.driver + " when pglite was asked for");
  const result = await auditSchema(db);
  for (const line of result.held) ok(line);
  for (const line of result.failed) bad(line);
  if (result.held.length + result.failed.length < 20) {
    bad("the audit reported only " + (result.held.length + result.failed.length) + " assertions; it did not run to the end");
  }
} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err));
} finally {
  await db.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
