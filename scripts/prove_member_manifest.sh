#!/usr/bin/env bash
# C-ABSENCE.2 — Lock 2. Set equality in BOTH directions between the member
# manifest and every member name declared across the eight document schemas.
# The day someone adds a member, this fails until a human writes that name into
# the manifest in the same diff.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
[ -f schemas/member-manifest.json ] || { echo "cannot prove — schemas/member-manifest.json missing"; exit 2; }
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { collectMembers, DOCUMENT_SCHEMAS } from "./scripts/lib/members.mjs";
let manifest;
try { manifest = JSON.parse(readFileSync("schemas/member-manifest.json", "utf8")); }
catch (e) { console.log("cannot prove — manifest unparseable: " + e.message); process.exit(2); }
const declared = new Set();
for (const f of DOCUMENT_SCHEMAS) {
  try { collectMembers(JSON.parse(readFileSync(f, "utf8")), declared); }
  catch (e) { console.log(`cannot prove — ${f} unparseable: ${e.message}`); process.exit(2); }
}
const listed = new Set(manifest.members);
const unmanifested = [...declared].filter(m => !listed.has(m)).sort();
const orphans = [...listed].filter(m => !declared.has(m)).sort();
let fail = 0, pass = 0;
if (!unmanifested.length) { console.log(`ok — 0 unmanifested members (${declared.size} declared across ${DOCUMENT_SCHEMAS.length} schemas)`); pass++; }
else { console.log(`FAIL — ${unmanifested.length} member(s) declared but not manifested: ${unmanifested.join(", ")}`); fail = 1; }
if (!orphans.length) { console.log(`ok — 0 orphan manifest entries`); pass++; }
else { console.log(`FAIL — ${orphans.length} manifest entr(ies) declared by no schema: ${orphans.join(", ")}`); fail = 1; }
if (manifest.count === listed.size) { console.log(`ok — declared count ${manifest.count} matches the list length`); pass++; }
else { console.log(`FAIL — count ${manifest.count} does not match list length ${listed.size}`); fail = 1; }
console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
