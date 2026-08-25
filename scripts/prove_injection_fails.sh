#!/usr/bin/env bash
# C-INJECT (and the refusal half of C-PII-INGEST). Poison every prose surface
# SPEC.md 5.2 names as attacker-controlled -- work.synopsis, manner.note.body,
# auditorium.why_this_room, offers[].eligibility_note, the substitution edge
# detail, and refusal.reason -- and assert that nothing which decides anything
# moved: the etag is BYTE-IDENTICAL to the unpoisoned run, a hold across a
# strict boundary still returns 412 and writes no row, every URL an emitted
# document carries is same-origin under O1, and prose bytes stay within Q1.
#
# The obvious cheaper check -- "the injected text did not appear in the
# response" -- would not have caught any of this. It tests a filter, and 5.3 is
# explicit that this specification does not attempt to detect injection and a
# conforming Server MUST NOT claim to, because detection is unfalsifiable and
# every filter is one paraphrase from defeat. What is checked here instead is
# that the injected text is STRUCTURALLY unable to move an assertion: prose sits
# outside PROJECTION_0_1, the substitution poset is built over ids, and the
# refusal taxonomy is closed. A paraphrase defeats a filter; it does not defeat
# a projection that never read the field.
#
# The etag is minted with the HARNESS projector (scripts/lib/project.mjs plus a
# third-party RFC 8785 canonicaliser and node:crypto), never with a CHANGEOVER
# package. The question is whether the SPECIFICATION leaks prose, and asking a
# CHANGEOVER implementation would be asking the accused.
#
# Not concurrency-gated. Every assertion here is a digest comparison, a guard
# refusal, a regex over a document or a byte count, so it is provable on PGlite
# and it is provable identically against CHANGEOVER_PG_URL.
#
# What this proof does NOT assert, deliberately: that an agent behaves. The
# draft of C-INJECT asserted that an agent the author wrote, deliberately
# compromised, changes no boundary behaviour. That is true by construction and
# worthless -- the agent is not the boundary, and an agent you wrote cannot
# falsify your own claim. SPEC.md:645 deletes it from the class and so does this
# script.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/canonicalize ]         || { echo "cannot prove — canonicalize not installed; run npm install at the repository root"; exit 2; }
[ -f scripts/lib/project.mjs ]           || { echo "cannot prove — scripts/lib/project.mjs missing; C-ETAG needs the harness projector"; exit 2; }
[ -f schemas/projection-0-1.json ]       || { echo "cannot prove — schemas/projection-0-1.json missing"; exit 2; }
[ -f fixtures/golden/delegation.json ]   || { echo "cannot prove — fixtures/golden/delegation.json missing; O1 cannot be decided without the venue delegation record"; exit 2; }
[ -f fixtures/golden/occasion-embassy-sat-1900.json ] || { echo "cannot prove — the golden Occasions are missing; the byte-identity claim has nothing to be identical to"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]   || { echo "cannot prove — packages/core/src/hold-seats.ts missing; there is no boundary to cross"; exit 2; }
[ -f packages/core/src/access-log.ts ]   || { echo "cannot prove — packages/core/src/access-log.ts missing; P1 is enforced there"; exit 2; }
[ -f packages/conformance/src/inject/c-inject.ts ] || { echo "cannot prove — packages/conformance/src/inject/c-inject.ts missing"; exit 2; }

node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { project } from "./scripts/lib/project.mjs";
import { CannotProve, EXIT_CANNOT_PROVE, openDb } from "./packages/store/src/db.ts";
import { runCInject } from "./packages/conformance/src/inject/c-inject.ts";
import { runCPiiIngest } from "./packages/conformance/src/inject/c-pii-ingest.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };
const report = (checks) => { for (const c of checks) (c.held ? ok : bad)(c.id + ": " + c.note); };

const POINTERS = JSON.parse(readFileSync("schemas/projection-0-1.json", "utf8")).pointers;
const mint = (occasion) =>
  "1:" + createHash("sha256").update(Buffer.from(canonicalize(project(occasion, POINTERS)), "utf8")).digest("base64url");

const db = await openDb();
let unreachable = null;
try {
  report(await runCInject({ db, mint }));
  report(runCPiiIngest());
} catch (err) {
  // A precondition that vanished is not a failure. CannotProve is raised only
  // where the estate this proof seeded was removed from the store underneath
  // it, which is reachable against a shared CHANGEOVER_PG_URL and says nothing
  // whatever about the boundary.
  if (err instanceof CannotProve) unreachable = err;
  else bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 5).join(" | ") : err));
} finally {
  await db.close();
}

if (unreachable !== null) {
  console.log("cannot prove — " + unreachable.message);
  console.log("  to make it provable:");
  for (const line of unreachable.remedy.split("\n")) console.log("    " + line);
  process.exit(EXIT_CANNOT_PROVE);
}

if (pass < 20 && !fail) bad("only " + pass + " assertions ran; the proof did not reach the end");
console.log("PASS=" + (fail ? 0 : pass));
process.exit(fail);
'
