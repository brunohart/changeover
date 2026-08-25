#!/usr/bin/env bash
# C-ABSENCE .1-.4 — the four locks of SPEC.md 5.1, on a WRITE path.
#
# cinema-ops-platform proves absence-not-redaction on a READ path and leaves an
# open question in its own documentation: does the triple lock generalise to a
# write path? This script is the answer, and the answer only counts because
# every part of it is executed. Reading the GRANT statements out of
# 0003_roles_and_grants.sql would prove what somebody wrote; the gap between the
# grant a migration declares and the privilege a live cluster enforces is where
# privilege bugs live, so .3 attempts eleven forbidden statements under
# SET LOCAL ROLE and reads the SQLSTATE the database raises.
#
# The obvious cheaper check for .4 would be to inspect the objects the handlers
# return. That would pass under an adapter that serialised something else, and
# it would miss the channel that matters: a refusal is prose travelling back to a
# consumer with no judgement, and an echoed personal value would appear there
# rather than in a Hold. Every body below is response text off a socket, or a
# JSON-RPC result stringified whole, including _meta.
#
# On a hit, .4 FAILS THE BUILD. It does not filter, mask or redact, and there is
# no function in packages/conformance/src/absence that could: a filter is
# behaviour that must be right on every code path nobody has written yet, and the
# claim being made here is structural.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ]  || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/@modelcontextprotocol/sdk ] || { echo "cannot prove — @modelcontextprotocol/sdk not installed; .1 reads tools/list over a connected client. Run npm install at the repository root"; exit 2; }
[ -f schemas/member-manifest.json ]       || { echo "cannot prove — schemas/member-manifest.json missing; .2 is set equality against it"; exit 2; }
[ -f packages/store/src/migrations/0003_roles_and_grants.sql ] || { echo "cannot prove — packages/store/src/migrations/0003_roles_and_grants.sql missing; .3 has no roles to switch to"; exit 2; }
[ -f packages/http/test/lib/http-bench.ts ] || { echo "cannot prove — packages/http/test/lib/http-bench.ts missing; .4 reads its bodies off that server"; exit 2; }
[ -f packages/mcp/test/lib/mcp-bench.ts ]   || { echo "cannot prove — packages/mcp/test/lib/mcp-bench.ts missing; .1 and .4 read the MCP surface through it"; exit 2; }
[ -f scripts/lib/members.mjs ]              || { echo "cannot prove — scripts/lib/members.mjs missing; the document-schema list is cross-checked against it"; exit 2; }

node --input-type=module -e '
import { openDb } from "./packages/store/src/db.ts";
import { migrate } from "./packages/store/src/migrate.ts";
import { runAbsence } from "./packages/conformance/src/absence/absence.ts";
import { DOCUMENT_SCHEMAS } from "./packages/conformance/src/absence/manifest.ts";
import { DOCUMENT_SCHEMAS as FROZEN } from "./scripts/lib/members.mjs";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

// The one thing the class module cannot check about itself: that its own list of
// document schemas has not drifted from the frozen one. schemas/report.schema.json
// is a HARNESS schema and must never join either list — adding it would drag the
// report_s member names into a set-equality check against a manifest that
// correctly does not carry them, and the failure would name a member nobody
// could place.
const mine = [...DOCUMENT_SCHEMAS].sort().join(",");
const frozen = [...FROZEN].sort().join(",");
mine === frozen
  ? ok("the class module and scripts/lib/members.mjs name the same " + FROZEN.length + " document schemas")
  : bad("document-schema drift — the class names [" + mine + "] and the frozen list names [" + frozen + "]");

const db = await openDb();
try {
  await migrate(db);
  const run = await runAbsence(db, ".");
  for (const clause of run.clauses) {
    clause.ok ? ok(clause.clause + " — " + clause.note) : bad(clause.clause + " — " + clause.note);
  }
  ok(run.http + " HTTP and " + run.mcp + " MCP response bodies were scanned, and none was filtered");
} finally {
  await db.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
