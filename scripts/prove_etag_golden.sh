#!/usr/bin/env bash
# C-ETAG. Recomputes each frozen digest with a THIRD-PARTY RFC 8785
# implementation and node:crypto, using the harness projector in
# scripts/lib/project.mjs — which no CHANGEOVER implementation may import.
# Asserts fixture <-> EXPECTED.md <-> SPEC.md all agree, that a prose-only edit
# does not move the digest, and that a projected edit does.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
[ -d node_modules/canonicalize ] || { echo "cannot prove — canonicalize not installed (npm install)"; exit 2; }
[ -f fixtures/golden/EXPECTED.md ] || { echo "cannot prove — fixtures/golden/EXPECTED.md missing"; exit 2; }
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { project } from "./scripts/lib/project.mjs";

const POINTERS = JSON.parse(readFileSync("schemas/projection-0-1.json", "utf8")).pointers;
const EXPECTED = readFileSync("fixtures/golden/EXPECTED.md", "utf8");
const SPEC = readFileSync("SPEC.md", "utf8");

const mint = occ => "1:" + createHash("sha256").update(Buffer.from(canonicalize(project(occ, POINTERS)), "utf8")).digest("base64url");
const read = p => JSON.parse(readFileSync(p, "utf8"));

const GOLDEN = [
  "fixtures/golden/occasion-embassy-sat-1900.json",
  "fixtures/golden/occasion-multiplex-sat-2100.json",
  "fixtures/golden/occasion-multiplex-sun-1400.json",
];

let fail = 0, pass = 0, reproduced = 0;
for (const path of GOLDEN) {
  const occ = read(path);
  const computed = mint(occ);
  const name = path.split("/").pop();
  if (computed !== occ.etag) { console.log(`FAIL — ${name}: computed ${computed}, fixture carries ${occ.etag}`); fail = 1; continue; }
  if (!EXPECTED.includes(computed)) { console.log(`FAIL — ${name}: ${computed} absent from EXPECTED.md`); fail = 1; continue; }
  if (!SPEC.includes(computed)) { console.log(`FAIL — ${name}: ${computed} absent from SPEC.md`); fail = 1; continue; }
  reproduced++;
}
if (!fail) { console.log(`ok — ${reproduced}/${GOLDEN.length} digests reproduce and agree across fixture, EXPECTED.md and SPEC.md`); pass++; }

const golden = read("fixtures/golden/occasion-embassy-sat-1900.json");
const prose = read("fixtures/prose-edit/occasion-embassy-sat-1900.json");
const goldenNote = golden.manner.note.body.value, proseNote = prose.manner.note.body.value;
if (goldenNote === proseNote) { console.log("FAIL — prose-edit fixture is byte-identical; it proves nothing"); fail = 1; }
else if (mint(prose) === mint(golden)) { console.log("ok — C-ETAG.2: a prose-only edit does not move the digest"); pass++; }
else { console.log("FAIL — C-ETAG.2: a prose-only edit moved the digest"); fail = 1; }

const moved = structuredClone(golden);
moved.instant.starts_at = "2026-08-29T19:30:00+12:00";
if (mint(moved) !== mint(golden)) { console.log("ok — C-ETAG.3: a moved start time does move the digest"); pass++; }
else { console.log("FAIL — C-ETAG.3: a moved start time did not move the digest"); fail = 1; }

const repriced = structuredClone(golden);
repriced.offers[0].amount_minor = 2400;
if (mint(repriced) !== mint(golden)) { console.log("ok — C-ETAG.4: a changed price does move the digest"); pass++; }
else { console.log("FAIL — C-ETAG.4: a changed price did not move the digest"); fail = 1; }

const unasserted = structuredClone(golden);
unasserted.substitution.not_substitutable_for = [];
if (mint(unasserted) !== mint(golden)) { console.log("ok — C-ETAG.5: a withdrawn non-substitutability assertion does move the digest"); pass++; }
else { console.log("FAIL — C-ETAG.5: a withdrawn assertion did not move the digest"); fail = 1; }

const restale = structuredClone(golden);
restale.availability.observed_at = "2026-08-29T09:20:41.000+12:00";
restale.availability.seats_available = 209;
restale.revision = 5;
if (mint(restale) === mint(golden)) { console.log("ok — C-ETAG.6: a re-observation and a revision bump do not move the digest"); pass++; }
else { console.log("FAIL — C-ETAG.6: a re-observation moved the digest"); fail = 1; }

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
