#!/usr/bin/env bash
# C-REFUSE, at its root: the refusal taxonomy in @changeover/schema is CLOSED and is
# the same closed set as the one SPEC.md §6.3 tables and schemas/refusal.schema.json
# declares — asserted as SET EQUALITY IN BOTH DIRECTIONS, with the specification table
# PARSED OUT OF THE MARKDOWN rather than hand-copied here.
#
# The obvious cheaper check would be "does every refusal the implementation emits
# validate against refusal.schema.json". It does not catch the failure that matters:
# a code the specification tables and the module never emits is invisible to it, and
# so is a code the module invents. Both are orphans, both survive a green validator,
# and both are exactly the divergence two conforming implementations do not survive.
#
# It also asserts the detail binding, per code, in both directions: every branch the
# frozen schema declares is constructible, every constructed refusal validates against
# its OWN branch, the 21 codes declaring "detail": false emit none and are rejected if
# they carry one, and any extra member — top level or inside a branch — is rejected.
# Finally it asserts that an illegal detail is a TYPESCRIPT error, by compiling four
# illegal constructions against a compiling positive control.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -f SPEC.md ]                                  || { echo "cannot prove — SPEC.md missing"; exit 2; }
[ -f schemas/refusal.schema.json ]              || { echo "cannot prove — schemas/refusal.schema.json missing"; exit 2; }
[ -f schemas/common.schema.json ]               || { echo "cannot prove — schemas/common.schema.json missing"; exit 2; }
[ -f packages/schema/src/refusal.ts ]           || { echo "cannot prove — packages/schema/src/refusal.ts missing (CORE-008 not landed)"; exit 2; }
[ -d node_modules/ajv ]                         || { echo "cannot prove — ajv not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/ajv-formats ]                 || { echo "cannot prove — ajv-formats not installed; run npm install at the repository root"; exit 2; }
[ -f node_modules/typescript/bin/tsc ]          || { echo "cannot prove — typescript not installed, so the type-error assertions cannot run; run npm install at the repository root"; exit 2; }

node --input-type=module -e '
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as R from "./packages/schema/src/refusal.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };
const setOf = (xs) => new Set(xs);
const missing = (a, b) => [...a].filter((x) => !b.has(x)).sort();

/* ── 0 · the three sources ─────────────────────────────────────────────────── */

const REFUSAL_SCHEMA = JSON.parse(readFileSync("schemas/refusal.schema.json", "utf8"));
const COMMON_SCHEMA  = JSON.parse(readFileSync("schemas/common.schema.json", "utf8"));

// Parse SPEC.md §6.3s code table out of the markdown. Never hand-copied.
const specLines = readFileSync("SPEC.md", "utf8").split("\n");
const secStart = specLines.findIndex((l) => l.startsWith("### 6.3 "));
let secEnd = specLines.findIndex((l, i) => i > secStart && /^#{1,3} /.test(l));
if (secEnd < 0) secEnd = specLines.length;
const region = specLines.slice(secStart, secEnd);
const hdr = region.findIndex((l) => /^\|\s*Code\s*\|\s*HTTP\s*\|\s*Retryable\s*\|/.test(l));
const specTable = new Map();
let specRows = 0, specDup = 0;
if (secStart >= 0 && hdr >= 0) {
  for (let i = hdr + 2; i < region.length; i++) {
    const line = region[i];
    if (!line.trim().startsWith("|")) break;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => s.trim());
    const codes = [...cells[0].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    if (codes.length === 0) continue;
    specRows++;
    for (const c of codes) {
      if (specTable.has(c)) specDup++;
      specTable.set(c, { status: Number(cells[1]), retry: cells[2] });
    }
  }
}

// The one thing written by hand here is the SPELLING of the retryability column,
// not the mapping of code to value. The codes and their values are read from the file.
const RETRY_SPELLING = new Map([
  ["no", "no"],
  ["after re-resolve", "after_re_resolve"],
  ["after get_hold", "after_get_hold"],
  ["after release", "after_release"],
  ["retry_after_ms", "retry_after_ms"],
  ["same key, retry_after_ms", "same_key"],
]);
const normaliseRetry = (cell) => RETRY_SPELLING.get(cell.replace(/[`*]/g, "").trim().toLowerCase());

if (secStart < 0 || hdr < 0) { bad("SPEC.md §6.3 code table not found — nothing was parsed, so nothing below means anything"); }
else if (specTable.size < 20 || specDup > 0 || [...specTable.values()].some((v) => !Number.isInteger(v.status))) {
  bad(`SPEC.md §6.3 table parsed badly: ${specRows} rows, ${specTable.size} codes, ${specDup} duplicates`);
} else {
  ok(`SPEC.md §6.3 code table parsed from the markdown: ${specRows} rows, ${specTable.size} distinct codes, no duplicates`);
}

const specCodes   = setOf(specTable.keys());
const schemaCodes = setOf(REFUSAL_SCHEMA.properties.code.enum);
const moduleCodes = setOf(R.REFUSAL_CODES);

/* ── 1 · set equality, both directions, module ↔ SPEC.md §6.3 ─────────────── */

{
  const m = missing(specCodes, moduleCodes);
  m.length ? bad(`codes tabled in SPEC.md §6.3 but absent from the module: ${m.join(", ")}`)
           : ok(`every one of the ${specCodes.size} codes in SPEC.md §6.3 is in the module`);
}
{
  const m = missing(moduleCodes, specCodes);
  m.length ? bad(`codes in the module but not tabled in SPEC.md §6.3: ${m.join(", ")}`)
           : ok(`every one of the ${moduleCodes.size} codes in the module is tabled in SPEC.md §6.3 — the set is closed, both directions`);
}

/* ── 2 · set equality, both directions, module ↔ the frozen schema ────────── */

{
  const m = missing(schemaCodes, moduleCodes);
  m.length ? bad(`codes in schemas/refusal.schema.json but absent from the module: ${m.join(", ")}`)
           : ok(`every code in schemas/refusal.schema.json is in the module`);
}
{
  const m = missing(moduleCodes, schemaCodes);
  m.length ? bad(`codes in the module but absent from schemas/refusal.schema.json: ${m.join(", ")}`)
           : ok(`every code in the module is in schemas/refusal.schema.json — the set is closed, both directions`);
}
{
  const drift = Object.entries(R.REFUSAL_CODE).filter(([k, v]) => k !== v).map(([k]) => k);
  drift.length ? bad(`REFUSAL_CODE is not an identity map at: ${drift.join(", ")}`)
               : ok("REFUSAL_CODE keys and values are identical — no key can name a different wire code");
}

/* ── 3 · status and retryability transcribed faithfully ───────────────────── */

{
  const wrong = [...specTable].filter(([c, row]) => R.REFUSAL_STATUS[c] !== row.status)
    .map(([c, row]) => `${c}: module ${R.REFUSAL_STATUS[c]} vs SPEC ${row.status}`);
  wrong.length ? bad(`REFUSAL_STATUS disagrees with SPEC.md §6.3: ${wrong.join("; ")}`)
               : ok(`REFUSAL_STATUS equals the HTTP column of SPEC.md §6.3 for all ${specTable.size} codes`);
}
{
  const wrong = [], unspelt = [];
  for (const [c, row] of specTable) {
    const want = normaliseRetry(row.retry);
    if (want === undefined) { unspelt.push(`${c}: ${JSON.stringify(row.retry)}`); continue; }
    if (R.REFUSAL_RETRYABILITY[c] !== want) wrong.push(`${c}: module ${R.REFUSAL_RETRYABILITY[c]} vs SPEC ${want}`);
  }
  if (unspelt.length) bad(`SPEC.md §6.3 retryability spellings this proof does not recognise — it cannot be checked, so it is not a pass: ${unspelt.join("; ")}`);
  else if (wrong.length) bad(`REFUSAL_RETRYABILITY disagrees with SPEC.md §6.3: ${wrong.join("; ")}`);
  else ok(`REFUSAL_RETRYABILITY equals the Retryable column of SPEC.md §6.3 for all ${specTable.size} codes`);
}

/* ── 4 · the remediation set, and the defaults ────────────────────────────── */

{
  const schemaRem = setOf(REFUSAL_SCHEMA.properties.remediation.enum);
  const moduleRem = setOf(R.REMEDIATIONS);
  const a = missing(schemaRem, moduleRem), b = missing(moduleRem, schemaRem);
  (a.length || b.length) ? bad(`remediation set differs — schema-only: ${a.join(", ") || "none"}; module-only: ${b.join(", ") || "none"}`)
                         : ok(`the remediation set is set-equal with the schema, both directions (${moduleRem.size} members)`);
}
{
  const moduleRem = setOf(R.REMEDIATIONS);
  const holes = R.REFUSAL_CODES.filter((c) => !moduleRem.has(R.REFUSAL_REMEDIATION[c]));
  holes.length ? bad(`REFUSAL_REMEDIATION default is not a member of the closed set for: ${holes.join(", ")}`)
               : ok(`every code has a default remediation drawn from the closed set (${R.REFUSAL_CODES.length} codes, total)`);
}
{
  // The direction the table actually fixes. A "no" row must never default to a retry.
  const forced = new Map([
    ["after_re_resolve", "re_resolve"],
    ["after_get_hold", "re_read"],
    ["after_release", "release_conflicting_hold"],
    ["same_key", "retry_same_key"],
    ["retry_after_ms", "retry_after"],
  ]);
  const wrong = [];
  for (const [c, row] of specTable) {
    const kind = normaliseRetry(row.retry);
    const got = R.REFUSAL_REMEDIATION[c];
    if (kind === "no") { if (got === "retry_after" || got === "retry_same_key") wrong.push(`${c} is non-retryable but defaults to ${got}`); }
    else if (forced.get(kind) !== got) wrong.push(`${c} is ${kind} but defaults to ${got}`);
  }
  wrong.length ? bad(`remediation defaults contradict SPEC.md §6.3: ${wrong.join("; ")}`)
               : ok("every remediation default agrees with the retryability SPEC.md §6.3 fixes for that code");
}

/* ── 5 · the detail partition, both directions ────────────────────────────── */

// Pull the per-code detail branches straight out of the frozen schema.
const branchOf = new Map();
const detailFalse = new Set();
for (const clause of REFUSAL_SCHEMA.allOf ?? []) {
  const codeCond = clause?.if?.properties?.code;
  if (!codeCond) continue;
  const codes = codeCond.enum ?? (codeCond.const !== undefined ? [codeCond.const] : []);
  const branch = clause?.then?.properties?.detail;
  for (const c of codes) { if (branch === false) detailFalse.add(c); else if (branch) branchOf.set(c, branch); }
}

{
  const schemaBearing = setOf(branchOf.keys());
  const moduleBearing = setOf(R.DETAIL_BEARING_CODES);
  const a = missing(schemaBearing, moduleBearing), b = missing(moduleBearing, schemaBearing);
  (a.length || b.length) ? bad(`detail-bearing codes differ — schema-only: ${a.join(", ") || "none"}; module-only: ${b.join(", ") || "none"}`)
                         : ok(`the ${moduleBearing.size} detail-bearing codes are set-equal with the schema branches, both directions`);
}
{
  const moduleFree = setOf(R.DETAIL_FREE_CODES);
  const a = missing(detailFalse, moduleFree), b = missing(moduleFree, detailFalse);
  (a.length || b.length) ? bad(`detail-free codes differ — schema-only: ${a.join(", ") || "none"}; module-only: ${b.join(", ") || "none"}`)
                         : ok(`the ${moduleFree.size} codes declaring "detail": false are set-equal with the schema, both directions`);
}
{
  const overlap = R.DETAIL_BEARING_CODES.filter((c) => detailFalse.has(c));
  const uncovered = R.REFUSAL_CODES.filter((c) => !branchOf.has(c) && !detailFalse.has(c));
  (overlap.length || uncovered.length)
    ? bad(`the schema detail partition is not total and disjoint — both: ${overlap.join(", ") || "none"}; neither: ${uncovered.join(", ") || "none"}`)
    : ok("every code is either detail-bearing or declares detail: false — the partition is total and disjoint");
}
{
  const wrong = [];
  for (const [c, branch] of branchOf) {
    const shape = R.REFUSAL_DETAIL_SHAPE[c];
    if (!shape) { wrong.push(`${c}: no shape in the module`); continue; }
    const schemaReq = setOf(branch.required ?? []);
    const schemaAll = setOf(Object.keys(branch.properties ?? {}));
    const modReq = setOf(shape.required);
    const modAll = setOf([...shape.required, ...shape.optional]);
    const d = (x, y) => missing(x, y).concat(missing(y, x));
    if (d(schemaReq, modReq).length) wrong.push(`${c}: required differs at ${d(schemaReq, modReq).join(",")}`);
    if (d(schemaAll, modAll).length) wrong.push(`${c}: permitted members differ at ${d(schemaAll, modAll).join(",")}`);
  }
  wrong.length ? bad(`REFUSAL_DETAIL_SHAPE disagrees with the frozen branches: ${wrong.join("; ")}`)
               : ok(`REFUSAL_DETAIL_SHAPE reproduces every branch of the frozen schema, member for member (${branchOf.size} branches)`);
}

/* ── 6 · ajv, and one specimen per code SYNTHESISED FROM THE SCHEMA ───────── */

const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(COMMON_SCHEMA);
ajv.addSchema(REFUSAL_SCHEMA);
const validateRefusal = ajv.getSchema("urn:changeover:schema:refusal:0.1");

const CANDIDATES = [
  "hold_4ZZQCSHNJ2NN5ZRJW94NRCWHXYCWBW1P",
  "occ_embassy_20260829T1900_s1",
  "the-conversation-wlg-2026-w35",
  "no_singleton_gap",
  "F:11",
  "/screening/starts_at",
  "https://tickets.embassy.example/claim/abc",
  "2026-08-29T09:20:04.887Z",
];
const deref = (node) => {
  if (node && typeof node.$ref === "string") {
    const m = node.$ref.match(/^urn:changeover:schema:common:0\.1#\/\$defs\/(.+)$/);
    if (m) return COMMON_SCHEMA.$defs[m[1]];
    throw new Error("unresolvable $ref " + node.$ref);
  }
  return node;
};
const synth = (raw) => {
  const node = deref(raw);
  if (node.const !== undefined) return node.const;
  if (Array.isArray(node.enum)) return node.enum[0];
  const type = node.type;
  if (type === "array") return [synth(node.items)];
  if (type === "integer" || type === "number") return node.minimum ?? 1;
  if (type === "boolean") return true;
  if (type === "string" || type === undefined) {
    if (node.format === "date-time") return "2026-08-29T09:20:04.887Z";
    if (node.format === "uri") return "https://tickets.embassy.example/claim/abc";
    const re = node.pattern ? new RegExp(node.pattern) : null;
    for (const c of CANDIDATES) {
      if (re && !re.test(c)) continue;
      if (node.maxLength !== undefined && c.length > node.maxLength) continue;
      if (node.minLength !== undefined && c.length < node.minLength) continue;
      return c;
    }
    throw new Error("no candidate satisfies " + JSON.stringify(node));
  }
  throw new Error("cannot synthesise " + JSON.stringify(node));
};

const SERVER_TIME = "2026-08-29T09:20:04.887Z";
const specimens = new Map();
let synthError = null;
try {
  for (const code of R.REFUSAL_CODES) {
    const branch = branchOf.get(code);
    const extra = {};
    if (branch) {
      const detail = {};
      for (const member of Object.keys(branch.properties ?? {})) detail[member] = synth(branch.properties[member]);
      extra.detail = detail;
    }
    if (R.wantsRetryAfterMs(code)) extra.retry_after_ms = 400;
    specimens.set(code, new R.Refusal(code, R.REFUSAL_REMEDIATION[code], "A refusal, in prose nothing branches on.", extra));
  }
} catch (err) { synthError = err; }

const haveSpecimens = !synthError && specimens.size === R.REFUSAL_CODES.length;
if (!haveSpecimens) bad(`could not construct one specimen per code from the frozen schema: ${synthError ? synthError.message : "only " + specimens.size + " of " + R.REFUSAL_CODES.length + " built"}`);
else ok(`one refusal per code constructed, every detail SYNTHESISED FROM the frozen branch (${specimens.size} specimens)`);

// Everything from here to §9 reads those specimens. If they could not be built the
// checks are NOT skipped quietly — each is reported as a failure, because an assertion
// that did not run is not an assertion that held.
const needSpecimens = (what) => { bad(`${what} — not checked: the specimens could not be built`); };

if (!haveSpecimens) needSpecimens("every constructed refusal validates against refusal:0.1"); else {
  const wrong = [];
  for (const [code, r] of specimens) {
    const doc = r.toDocument(SERVER_TIME);
    if (!validateRefusal(doc)) wrong.push(`${code}: ${ajv.errorsText(validateRefusal.errors, { separator: ", " })}`);
  }
  wrong.length ? bad(`a constructed refusal does not validate against refusal:0.1: ${wrong.join("; ")}`)
               : ok(`every constructed refusal validates against urn:changeover:schema:refusal:0.1 (${specimens.size} documents)`);
}
if (!haveSpecimens) needSpecimens("every constructed detail validates against its own branch"); else {
  // Against its OWN branch, not merely the document. A document-level pass would still
  // hold if the if/then key had drifted, because a non-matching if simply does nothing.
  const wrong = [];
  let n = 0;
  for (const [code, branch] of branchOf) {
    const id = `urn:changeover:harness:refusal-branch:${code}`;
    if (!ajv.getSchema(id)) ajv.addSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: id, ...branch });
    const v = ajv.getSchema(id);
    const detail = specimens.get(code)?.toDocument(SERVER_TIME).detail;
    if (detail === undefined) { wrong.push(`${code}: no detail emitted`); continue; }
    if (!v(detail)) wrong.push(`${code}: ${ajv.errorsText(v.errors, { separator: ", " })}`);
    n++;
  }
  wrong.length ? bad(`a constructed detail does not validate against its own branch: ${wrong.join("; ")}`)
               : ok(`every constructed detail validates against the branch its OWN code keys (${n} branches)`);
}

/* ── 7 · the 21 codes that must emit no detail ────────────────────────────── */

if (!haveSpecimens) needSpecimens("detail: false codes emit no detail member"); else {
  const wrong = R.DETAIL_FREE_CODES.filter((c) => "detail" in specimens.get(c).toDocument(SERVER_TIME));
  wrong.length ? bad(`codes declaring detail: false emitted a detail member: ${wrong.join(", ")}`)
               : ok(`all ${R.DETAIL_FREE_CODES.length} codes declaring "detail": false emit no detail member at all`);
}
if (!haveSpecimens) needSpecimens("a forged detail on a detail: false code is rejected"); else {
  const survived = [];
  for (const c of R.DETAIL_FREE_CODES) {
    const doc = specimens.get(c).toDocument(SERVER_TIME);
    doc.detail = { seat_ids: ["F:11"] };
    if (validateRefusal(doc)) survived.push(c);
  }
  survived.length ? bad(`a forged detail on a detail: false code was accepted by the schema: ${survived.join(", ")}`)
                  : ok(`a forged detail on any of the ${R.DETAIL_FREE_CODES.length} detail: false codes is rejected by the schema`);
}
{
  const accepted = [];
  for (const c of R.DETAIL_FREE_CODES) {
    try { new R.Refusal(c, R.REFUSAL_REMEDIATION[c], "x", { detail: { seat_ids: ["F:11"] } }); accepted.push(c); }
    catch (err) { if (!(err instanceof R.RefusalShapeError)) accepted.push(`${c} (threw ${err?.name})`); }
  }
  accepted.length ? bad(`the module constructed a refusal carrying a forbidden detail: ${accepted.join(", ")}`)
                  : ok("the module refuses to CONSTRUCT a detail on any code declaring detail: false");
}
{
  const accepted = [];
  for (const c of R.DETAIL_BEARING_CODES) {
    try { new R.Refusal(c, R.REFUSAL_REMEDIATION[c], "x", {}); accepted.push(c); }
    catch (err) { if (!(err instanceof R.RefusalShapeError)) accepted.push(`${c} (threw ${err?.name})`); }
  }
  accepted.length ? bad(`the module constructed a detail-bearing refusal with no detail: ${accepted.join(", ")}`)
                  : ok("the module refuses to CONSTRUCT a detail-bearing code with its detail omitted");
}
if (!haveSpecimens) needSpecimens("a detail carrying a member outside its branch is refused at construction"); else {
  const accepted = [];
  for (const c of R.DETAIL_BEARING_CODES) {
    const good = specimens.get(c).toDocument(SERVER_TIME).detail;
    try { new R.Refusal(c, R.REFUSAL_REMEDIATION[c], "x", { detail: { ...good, suggestion: "just buy it" } }); accepted.push(c); }
    catch (err) { if (!(err instanceof R.RefusalShapeError)) accepted.push(`${c} (threw ${err?.name})`); }
  }
  accepted.length ? bad(`the module constructed a detail carrying a member outside its branch: ${accepted.join(", ")}`)
                  : ok("the module refuses to CONSTRUCT a detail carrying any member outside its own branch");
}

/* ── 8 · additionalProperties: false, top level and inside a branch ───────── */

if (!haveSpecimens) needSpecimens("an extra top-level member is rejected"); else {
  const survived = [];
  for (const extra of ["suggestion", "hint", "instruction", "email", "agent_id", "settled"]) {
    const doc = specimens.get("hold_not_live").toDocument(SERVER_TIME);
    doc[extra] = "x";
    if (validateRefusal(doc)) survived.push(extra);
  }
  survived.length ? bad(`a refusal carrying an extra top-level member was accepted: ${survived.join(", ")}`)
                  : ok("a refusal carrying any extra top-level member is rejected — including suggestion, the free-text instruction channel SPEC.md §2.7 deletes");
}
if (!haveSpecimens) needSpecimens("an extra member inside a branch is rejected"); else {
  const survived = [];
  for (const c of R.DETAIL_BEARING_CODES) {
    const doc = specimens.get(c).toDocument(SERVER_TIME);
    doc.detail = { ...doc.detail, suggestion: "just buy it" };
    if (validateRefusal(doc)) survived.push(c);
  }
  survived.length ? bad(`a detail carrying an extra member was accepted by the schema: ${survived.join(", ")}`)
                  : ok(`a detail carrying any extra member is rejected by every one of the ${R.DETAIL_BEARING_CODES.length} branches`);
}
if (!haveSpecimens) needSpecimens("reason is a clamped prose envelope"); else {
  const doc = specimens.get("hold_not_live").toDocument(SERVER_TIME);
  const reasonIsProse = doc.reason && doc.reason.content_type === "text/plain" && typeof doc.reason.value === "string";
  const long = new R.Refusal("hold_not_live", "none", "x".repeat(5000)).toDocument(SERVER_TIME);
  const clamped = long.reason.value.length === R.PROSE_MAX_LENGTH && validateRefusal(long);
  (reasonIsProse && clamped)
    ? ok("reason is carried as a prose envelope and clamped to the schema bound — prose can never invalidate a refusal")
    : bad(`reason is not a well-formed clamped prose envelope (prose=${reasonIsProse}, clamped=${clamped})`);
}
if (!haveSpecimens) needSpecimens("server_time is projected at render time"); else {
  const r = specimens.get("hold_not_live");
  const a = r.toDocument("2026-08-29T09:20:04.887Z"), b = r.toDocument("2026-08-29T09:25:00.000Z");
  const onlyTimeMoved = a.server_time !== b.server_time &&
    JSON.stringify({ ...a, server_time: null }) === JSON.stringify({ ...b, server_time: null });
  onlyTimeMoved ? ok("server_time is projected at render time, not captured at construction (C-CLOCK)")
                : bad("server_time is not projected at render time");
}
{
  const surface = readFileSync("packages/schema/src/refusal.ts", "utf8");
  const hits = [...surface.matchAll(/^\s*export\s+(?:const|function|class|type|interface)\s+([A-Za-z0-9_]+)/gm)]
    .map((m) => m[1]).filter((n) => /settle|pay|capture|refund|charge/i.test(n));
  hits.length ? bad(`an exported identifier matches the C-ABSENCE.1 pattern: ${hits.join(", ")}`)
              : ok("no exported identifier in the taxonomy matches /settle|pay|capture|refund|charge/i (C-ABSENCE.1 catches substrings)");
}

/* ── 9 · an illegal detail is a TYPESCRIPT error ──────────────────────────── */

{
  const dir = mkdtempSync(join(tmpdir(), "changeover-refusal-types-"));
  const modulePath = join(process.cwd(), "packages/schema/src/refusal.ts");
  const imp = (names) => `import { ${names} } from ${JSON.stringify(modulePath)};`;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const cases = {
    "pos.ts": [imp("Refusal, refuse"),
      `export const a = refuse("hold_not_live", "ended");`,
      `export const b = refuse("seat_contended", "gone", { detail: { seat_ids: ["F:11"] } });`,
      `export const c = new Refusal("upstream_unavailable", "retry_after", "down", { retry_after_ms: 5000 });`,
      `export const d = refuse("hold_revoked", "override", { detail: { revocation_reason: "safety" } });`].join("\n"),
    "n1.ts": [imp("Refusal"), `export const x = new Refusal("seat_contended", "re_resolve", "gone");`].join("\n"),
    "n2.ts": [imp("refuse"), `export const x = refuse("hold_not_live", "ended", { detail: { seat_ids: ["F:11"] } });`].join("\n"),
    "n3.ts": [imp("refuse"), `export const x = refuse("seat_contended", "gone", { detail: { rule: "no_singleton_gap" } });`].join("\n"),
    "n4.ts": [imp("refuse"), `export const x = refuse("definitely_not_a_code", "hm");`].join("\n"),
  };
  for (const [name, body] of Object.entries(cases)) writeFileSync(join(dir, name), body + "\n");
  const compile = (name) => {
    try {
      execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict",
        "--target", "es2024", "--module", "nodenext", "--moduleResolution", "nodenext",
        "--allowImportingTsExtensions", "--erasableSyntaxOnly", "--verbatimModuleSyntax",
        "--skipLibCheck", "--types", "node", join(dir, name)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out: "" };
    } catch (err) { return { code: err.status ?? 1, out: String(err.stdout ?? "") + String(err.stderr ?? "") }; }
  };
  const posResult = compile("pos.ts");
  posResult.code === 0
    ? ok("the positive control compiles clean — the type harness is measuring the constructions, not its own setup")
    : bad(`the positive control did not compile, so the negative cases prove nothing: ${posResult.out.split("\n").slice(0, 3).join(" | ")}`);

  const wants = { "n1.ts": "a detail-bearing code with no detail", "n2.ts": "a detail on a detail: false code",
                  "n3.ts": "the wrong branch shape for the code", "n4.ts": "a code outside the closed set" };
  const slipped = [];
  for (const [name, what] of Object.entries(wants)) {
    const r = compile(name);
    const onLine2 = /\.ts\(2,\d+\): error TS\d+/.test(r.out);
    if (r.code === 0 || !onLine2) slipped.push(`${what} (${name}: exit ${r.code})`);
  }
  slipped.length ? bad(`TypeScript accepted an illegal construction: ${slipped.join("; ")}`)
                 : ok("all four illegal constructions are TYPE errors at the construction site: " + Object.values(wants).join(", "));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
