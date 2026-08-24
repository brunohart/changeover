#!/usr/bin/env bash
# C-SCHEMA, in its sharpest form: every JSON payload PRINTED IN THE
# SPECIFICATION validates against the SPECIFICATION'S OWN SCHEMAS. A document
# whose examples do not satisfy its own definitions has a bug that nobody
# previously had a mechanism to see. Also folds in the projection check: every
# JSON Pointer in PROJECTION_0_1 must resolve against occasion.schema.json.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
[ -d node_modules/ajv ] || { echo "cannot prove — ajv not installed (npm install)"; exit 2; }
[ -f SPEC.md ] || { echo "cannot prove — SPEC.md missing"; exit 2; }
node --input-type=module -e '
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { extractJsonBlocks } from "./scripts/lib/extract-json-blocks.mjs";
import { tokens } from "./scripts/lib/project.mjs";

const SCHEMAS = ["common","occasion","substitution","substitution-policy","hold-policy","hold","refusal","capability","seatmap"]
  .map(n => JSON.parse(readFileSync(`schemas/${n}.schema.json`, "utf8")));
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
for (const s of SCHEMAS) ajv.addSchema(s);

const validate = (id, value) => {
  const v = ajv.getSchema(id);
  if (!v) throw new Error(`no compiled schema for ${id}`);
  return v(value) ? null : ajv.errorsText(v.errors, { separator: "; " });
};
const relaxed = base => {
  const clone = structuredClone(base);
  clone.$id = "urn:changeover:harness:hold-fragment:0.1";
  const strip = n => { if (n && typeof n === "object") { delete n.required; for (const v of Object.values(n)) strip(v); } };
  strip(clone);
  ajv.addSchema(clone);
  return clone.$id;
};

let fail = 0, pass = 0;
const report = (label, error) => {
  if (error) { console.log(`FAIL — ${label}: ${error}`); fail = 1; }
  else { console.log(`ok — ${label}`); pass++; }
};

// 1 · The three golden Occasions, in full.
for (const f of ["occasion-embassy-sat-1900","occasion-multiplex-sat-2100","occasion-multiplex-sun-1400"]) {
  report(`fixtures/golden/${f}.json validates against occasion:0.1`,
    validate("urn:changeover:schema:occasion:0.1", JSON.parse(readFileSync(`fixtures/golden/${f}.json`, "utf8"))));
}
report("fixtures/prose-edit/occasion-embassy-sat-1900.json validates against occasion:0.1",
  validate("urn:changeover:schema:occasion:0.1", JSON.parse(readFileSync("fixtures/prose-edit/occasion-embassy-sat-1900.json", "utf8"))));

// 2 · Every payload printed in SPEC.md.
const blocks = extractJsonBlocks("SPEC.md");
const isSketch = b => b.value && typeof b.value === "object" &&
  (Object.keys(b.value).some(k => k.includes("|") || k.endsWith("[]")) ||
   (typeof b.value.$id === "string" && b.value.$id.startsWith("urn:changeover:schema:")));
const holdRelaxed = relaxed(SCHEMAS.find(s => s.$id === "urn:changeover:schema:hold:0.1"));

let sketches = 0, validated = 0;
for (const b of blocks) {
  const where = `SPEC.md:${b.line} (${b.lang}${b.http ? " " + b.http.split(/\s+/).slice(0,2).join(" ") : ""})`;
  if (b.parseError) { console.log(`FAIL — ${where}: unparseable: ${b.parseError}`); fail = 1; continue; }
  if (isSketch(b)) { sketches++; continue; }
  const v = b.value;
  if (v && v.refused === true) { report(`${where} validates against refusal:0.1`, validate("urn:changeover:schema:refusal:0.1", v)); validated++; continue; }
  if (v && typeof v.hold_id === "string" && v.changeover) { report(`${where} validates against hold:0.1`, validate("urn:changeover:schema:hold:0.1", v)); validated++; continue; }
  if (v && (v.state || v.handoff)) { report(`${where} validates against hold:0.1 (fragment, required lifted)`, validate(holdRelaxed, v)); validated++; continue; }
  if (v && v.sought && Array.isArray(v.seats)) {
    // A hold_seats REQUEST. §6.2: every constraint identical to the HTTP
    // binding. The draft left intent_digest unconstrained in the MCP binding,
    // so a Server accepting an email address and echoing it emitted a Hold
    // failing its own schema. Asserted here on the printed example.
    const errs = [];
    if (new Set(v.seats).size !== v.seats.length) errs.push("seats not uniqueItems");
    if (v.seats.length > 12) errs.push("seats exceeds maxItems 12");
    if (v.intent_digest !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(v.intent_digest)) errs.push("intent_digest does not match ^[A-Za-z0-9_-]{43}$");
    if (v.idempotency_key !== undefined && v.idempotency_key.length > 128) errs.push("idempotency_key exceeds 128");
    for (const [k, tag] of [["occasion_etag", "occasion_etag"], ["sought.occasion_etag", "sought.occasion_etag"]]) {
      const val = k.includes(".") ? v.sought?.occasion_etag : v[k];
      if (val !== undefined && !/^1:[A-Za-z0-9_-]{43}$/.test(val)) errs.push(`${tag} does not match ^1:[A-Za-z0-9_-]{43}$`);
    }
    report(`${where} hold_seats request honours the cross-binding constraints`, errs.length ? errs.join("; ") : null);
    validated++; continue;
  }
  console.log(`FAIL — ${where}: printed payload matches no known document shape`); fail = 1;
}
console.log(`ok — ${validated} instance payload(s) validated, ${sketches} illustrative schema sketch(es) skipped by design`);
pass++;

// 3 · Every projection pointer resolves against occasion.schema.json.
const occasionSchema = SCHEMAS.find(s => s.$id === "urn:changeover:schema:occasion:0.1");
const commonSchema = SCHEMAS.find(s => s.$id === "urn:changeover:schema:common:0.1");
const byId = Object.fromEntries(SCHEMAS.map(s => [s.$id, s]));
const deref = node => {
  let guard = 0;
  while (node && node.$ref && guard++ < 16) {
    const [id, frag] = node.$ref.split("#");
    let target = id ? byId[id] : occasionSchema;
    if (frag) for (const t of frag.split("/").filter(Boolean)) target = target?.[t.replace(/~1/g,"/").replace(/~0/g,"~")];
    node = target;
  }
  return node;
};
const POINTERS = JSON.parse(readFileSync("schemas/projection-0-1.json", "utf8")).pointers;
const unresolved = [];
for (const pointer of POINTERS) {
  let node = occasionSchema;
  for (const t of tokens(pointer)) {
    node = deref(node);
    if (t === "-") { node = deref(node?.items); continue; }
    node = deref(node)?.properties?.[t];
    if (!node) break;
  }
  if (!deref(node)) unresolved.push(pointer);
}
report(`all ${POINTERS.length} PROJECTION_0_1 pointers resolve against occasion:0.1`,
  unresolved.length ? `unresolved: ${unresolved.join(", ")}` : null);

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
