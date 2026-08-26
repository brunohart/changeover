#!/usr/bin/env bash
# CORE-001. The same assertion set as prove_migrations.sh, against a real
# Postgres 16 or later.
#
# It exists because PGlite is PostgreSQL 18.3 compiled to wasm, and "compiled to
# wasm" is a claim about the build, not about the deployment. Partial index
# predicates, declarative partitioning, column-level UPDATE grants and SET LOCAL
# ROLE are all things this schema leans its whole weight on; that they behave
# identically on both is a thing to demonstrate, not to assume.
#
# It does NOT need concurrency — every assertion here is observable on one
# connection, which is exactly why prove_migrations.sh can run them on PGlite
# and exit 0 honestly. What it needs is a second implementation of Postgres.
# Without one there is nothing to compare against, so it exits 2.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

[ -f packages/store/src/audit.ts ] || { echo "cannot prove — packages/store/src/audit.ts missing"; exit 2; }
[ -d node_modules/pg ]             || { echo "cannot prove — node-postgres not installed; run npm install at the repository root"; exit 2; }

if [ -z "${CHANGEOVER_PG_URL:-}" ]; then
  echo "cannot prove — the schema's behaviour on a real Postgres cannot be observed against PGlite:"
  echo "                PGlite is PostgreSQL 18.3 in wasm, which is the thing under comparison, not a witness to it."
  echo "  to make it provable:"
  echo "    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18"
  echo "    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover"
  echo "    bash scripts/prove_migrations_pg.sh"
  exit 2
fi

node --input-type=module -e '
import { openDb } from "./packages/store/src/db.ts";
import { auditSchema } from "./packages/store/src/audit.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const remedy = () => {
  console.log("  to make it provable:");
  console.log("    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18");
  console.log("    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover");
  console.log("    bash scripts/prove_migrations_pg.sh");
};

// node-postgres builds its pool lazily, so openDb() succeeds against a host
// that is not listening and the refusal surfaces at the first query. Everything
// up to and including that first query is therefore "could not reach the
// server" — exit 2 — and only what comes after it can be a FAIL. Getting this
// wrong is the specific lie this whole exit-code scheme exists to prevent: a
// red suite that means the network was down.
let db, version;
try {
  db = await openDb();
  if (db.driver !== "pg") {
    console.log("cannot prove — CHANGEOVER_PG_URL is set but openDb returned the " + db.driver + " driver");
    await db.close();
    process.exit(2);
  }
  const v = await db.query("select current_setting($1) as v", ["server_version_num"]);
  version = Number(v.rows[0]?.v ?? 0);
} catch (err) {
  console.log("cannot prove — CHANGEOVER_PG_URL is set but the server did not answer: " + String(err && err.message ? err.message : err));
  remedy();
  if (db) await db.close().catch(() => {});
  process.exit(2);
}

if (version < 160000) {
  console.log("cannot prove — server_version_num is " + version + "; this schema needs Postgres 16 or later");
  remedy();
  await db.close();
  process.exit(2);
}

try {
  ok("a real Postgres answered: server_version_num " + version + ", driver " + db.driver + ", concurrent " + db.concurrent);

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
