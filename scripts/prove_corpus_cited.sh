#!/usr/bin/env bash
# CORPUS-001. Every entry in the boundary corpus is cited, dated, decaying and
# honest about its own provenance. The cheaper check — "does the JSON parse" —
# would not have caught the failure that actually matters here: an entry that
# claims a named vendor behaves a certain way on nobody's authority, or one
# that claims `probed_live` without ever having touched a live surface. A
# corpus that cannot be audited is a rumour with a schema.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/ajv ]            || { echo "cannot prove — ajv not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/ajv-formats ]    || { echo "cannot prove — ajv-formats not installed; run npm install at the repository root"; exit 2; }
[ -f corpus/entry.schema.json ]    || { echo "cannot prove — corpus/entry.schema.json missing"; exit 2; }
[ -d corpus/entries ]              || { echo "cannot prove — corpus/entries/ missing"; exit 2; }
[ -f corpus/README.md ]            || { echo "cannot prove — corpus/README.md missing"; exit 2; }
[ -f corpus/version.json ]         || { echo "cannot prove — corpus/version.json missing"; exit 2; }
[ -f schemas/fingerprint.schema.json ] || { echo "cannot prove — schemas/fingerprint.schema.json missing"; exit 2; }
[ -f LICENSE-BSL.md ]              || { echo "cannot prove — LICENSE-BSL.md missing"; exit 2; }

node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const METHODS = ["probed_live", "documented", "vendor_stated", "reproduced_in_fixture"];
const MIN_ENTRIES = 12;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const NOW = Date.now();

// ---- load -----------------------------------------------------------------
const files = readdirSync("corpus/entries").filter((f) => f.endsWith(".json")).sort();
const entries = [];
for (const f of files) {
  try { entries.push({ f, d: JSON.parse(readFileSync("corpus/entries/" + f, "utf8")) }); }
  catch (e) { console.log("cannot prove — corpus/entries/" + f + " is unparseable: " + e.message); process.exit(2); }
}

if (entries.length >= MIN_ENTRIES) ok(entries.length + " corpus entries present (floor is " + MIN_ENTRIES + ")");
else bad(entries.length + " corpus entries present; the gate is " + MIN_ENTRIES);

// ---- 1. every entry validates against the entry schema ---------------------
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
let validate;
try { validate = ajv.compile(JSON.parse(readFileSync("corpus/entry.schema.json", "utf8"))); }
catch (e) { console.log("cannot prove — corpus/entry.schema.json does not compile: " + e.message); process.exit(2); }

const invalid = entries.filter(({ d }) => !validate(d)).map(({ f }) => {
  validate(entries.find((e) => e.f === f).d);
  return f + " (" + ajv.errorsText(validate.errors, { separator: "; " }) + ")";
});
if (!invalid.length) ok(entries.length + "/" + entries.length + " entries validate against corpus/entry.schema.json");
else bad(invalid.length + " entr(ies) do not validate: " + invalid.join(" | "));

// ---- 2. identity: unique ids, and the file is named for its id -------------
const ids = entries.map(({ d }) => d.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
const misnamed = entries.filter(({ f, d }) => f !== d.id + ".json").map(({ f }) => f);
if (!dupes.length && !misnamed.length) ok("every entry id is unique and every file is named <id>.json");
else bad("id problems — duplicates: [" + [...new Set(dupes)].join(", ") + "] misnamed: [" + misnamed.join(", ") + "]");

// ---- 3. method is in the closed set ---------------------------------------
const badMethod = entries.filter(({ d }) => !METHODS.includes(d.method)).map(({ d }) => d.id + "=" + d.method);
if (!badMethod.length) ok("every method is one of " + METHODS.join(" | "));
else bad("method outside the closed set: " + badMethod.join(", "));

// ---- 4. citation.url is present, non-empty and well-formed ----------------
const badUrl = [];
for (const { d } of entries) {
  const u = d.citation && d.citation.url;
  if (typeof u !== "string" || u.trim() === "") { badUrl.push(d.id + " (empty)"); continue; }
  let parsed;
  try { parsed = new URL(u); } catch { badUrl.push(d.id + " (unparseable: " + u + ")"); continue; }
  if (parsed.protocol !== "https:") badUrl.push(d.id + " (not https: " + u + ")");
  else if (!parsed.hostname.includes(".")) badUrl.push(d.id + " (no dotted host: " + u + ")");
}
if (!badUrl.length) ok(entries.length + "/" + entries.length + " citation URLs are non-empty, parse as URLs, and are https with a dotted host");
else bad("malformed citation URL: " + badUrl.join(", "));

// ---- 5. citation.retrieved_at and observed_at: RFC 3339, offset, not future
const badTime = [];
for (const { d } of entries) {
  for (const [label, value] of [["observed_at", d.observed_at], ["citation.retrieved_at", d.citation && d.citation.retrieved_at]]) {
    if (typeof value !== "string" || !RFC3339.test(value)) { badTime.push(d.id + "." + label + "=" + value); continue; }
    const t = Date.parse(value);
    if (Number.isNaN(t)) badTime.push(d.id + "." + label + " does not parse");
    else if (t > NOW + 60000) badTime.push(d.id + "." + label + " is in the future");
  }
}
if (!badTime.length) ok("every observed_at and citation.retrieved_at is RFC 3339 with an offset and is not in the future");
else bad("timestamp problems: " + badTime.join(", "));

// ---- 6. probed_live carries evidence of an actual live probe ---------------
// This is the assertion the whole method column exists for. A synthetic corpus
// cannot honestly carry probed_live, so this exits 1 — not 2, not a warning.
const noEvidence = [];
for (const { d } of entries) {
  if (d.method !== "probed_live") continue;
  const e = d.evidence;
  if (!e || typeof e !== "object") { noEvidence.push(d.id + " (no evidence member)"); continue; }
  const missing = ["probe_request", "response_status", "assertion", "reproduce"].filter((k) => e[k] === undefined || e[k] === "");
  if (missing.length) { noEvidence.push(d.id + " (evidence missing " + missing.join("/") + ")"); continue; }
  if (!Number.isInteger(e.response_status) || e.response_status < 100 || e.response_status > 599) noEvidence.push(d.id + " (response_status is not an HTTP status)");
  else if (!/^(GET|HEAD)\s+https:\/\//.test(e.probe_request)) noEvidence.push(d.id + " (probe_request is not a read against an https URL)");
}
const probed = entries.filter(({ d }) => d.method === "probed_live").length;
if (!noEvidence.length) ok(probed + " probed_live entr(ies) each carry a probe request, an observed HTTP status and a reproduction command");
else bad("probed_live without evidence of a live probe: " + noEvidence.join(", "));

// ---- 7. no entry claims a behaviour of a named vendor without a citation ---
const vendors = [...new Set(entries.map(({ d }) => d.surface && d.surface.vendor).filter(Boolean))];
const uncited = [];
for (const { d } of entries) {
  const text = JSON.stringify({ surface: d.surface, behaviour: d.behaviour, notes: d.notes, verification_gap: d.verification_gap });
  const names = vendors.filter((v) => text.toLowerCase().includes(v.toLowerCase()));
  if (!names.length) continue;
  const c = d.citation;
  const cited = c && typeof c.url === "string" && c.url.trim() !== "" && typeof c.retrieved_at === "string" && RFC3339.test(c.retrieved_at);
  if (!cited) uncited.push(d.id + " names [" + names.join(", ") + "]");
}
if (!uncited.length) ok(entries.length + "/" + entries.length + " entries naming one of " + vendors.length + " vendors carry a dated https citation");
else bad("vendor behaviour claimed without a citation: " + uncited.join(", "));

// ---- 8. the half-life is real, and its basis is stated --------------------
const badHalf = entries.filter(({ d }) => !Number.isInteger(d.half_life_days) || d.half_life_days < 1
  || typeof d.half_life_basis !== "string" || d.half_life_basis.trim().length < 20
  || typeof d.confidence_at_observation !== "number").map(({ d }) => d.id);
if (!badHalf.length) ok("every entry carries an integer half_life_days, a stated basis and a confidence at observation");
else bad("half-life problems: " + badHalf.join(", "));

// ---- 9. provenance is spread, not uniform ---------------------------------
// A corpus whose entries all share one method is a corpus with one source.
const byMethod = {};
for (const { d } of entries) byMethod[d.method] = (byMethod[d.method] || 0) + 1;
const kinds = Object.keys(byMethod).length;
if (kinds >= 2 && (byMethod.probed_live || 0) >= 1) ok("provenance spans " + kinds + " methods: " + Object.entries(byMethod).map(([k, v]) => k + "=" + v).join(", "));
else bad("provenance is not spread: " + JSON.stringify(byMethod));

// ---- 10. no personal data anywhere in the corpus --------------------------
// Same discipline as C-ABSENCE.4, applied to the one directory that quotes the
// outside world: fail the build, never filter the content.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const E164 = /\+[1-9]\d{7,14}(?!\d)/;
const luhn = (s) => { let sum = 0, alt = false; for (let i = s.length - 1; i >= 0; i--) { let n = s.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return sum % 10 === 0; };
const pii = [];
for (const f of [...files.map((x) => "corpus/entries/" + x), "corpus/README.md", "corpus/version.json", "corpus/fingerprint-example.json", "corpus/entry.schema.json"]) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  if (EMAIL.test(text)) pii.push(f + " (email-shaped)");
  if (E164.test(text)) pii.push(f + " (E.164-shaped)");
  for (const run of text.match(/\d{13,19}/g) || []) if (luhn(run)) pii.push(f + " (Luhn-valid digit run)");
}
if (!pii.length) ok("no email-, E.164- or Luhn-shaped string anywhere in corpus/");
else bad("personal-data-shaped content in the corpus: " + pii.join(", "));

// ---- 11. no credential ever recorded in an evidence line ------------------
const leaks = [];
for (const { d } of entries) {
  const e = d.evidence; if (!e) continue;
  for (const [k, v] of Object.entries(e)) if (typeof v === "string" && /(token|secret|apikey|api_key|password)\s*=/i.test(v)) leaks.push(d.id + "." + k);
}
if (!leaks.length) ok("no evidence line records a token, key or secret");
else bad("credential recorded in evidence: " + leaks.join(", "));

// ---- 12. the fingerprint schema compiles and its example validates --------
try {
  const fpAjv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(fpAjv);
  const fp = fpAjv.compile(JSON.parse(readFileSync("schemas/fingerprint.schema.json", "utf8")));
  const example = JSON.parse(readFileSync("corpus/fingerprint-example.json", "utf8"));
  if (fp(example)) ok("schemas/fingerprint.schema.json compiles and corpus/fingerprint-example.json validates against it");
  else bad("the example fingerprint does not validate: " + fpAjv.errorsText(fp.errors, { separator: "; " }));
} catch (e) { bad("fingerprint schema problem: " + e.message); }

// ---- 13. every entry_id in the example fingerprint resolves ---------------
try {
  const example = JSON.parse(readFileSync("corpus/fingerprint-example.json", "utf8"));
  const known = new Set(ids);
  const dangling = example.observations.map((o) => o.entry_id).filter((x) => !known.has(x));
  if (!dangling.length) ok("every entry_id in the example fingerprint resolves to a corpus entry");
  else bad("fingerprint names entries that do not exist: " + dangling.join(", "));
} catch (e) { bad("could not read the example fingerprint: " + e.message); }

// ---- 14. the corpus states its licence, and states it plainly ------------
const readme = readFileSync("corpus/README.md", "utf8");
const licenceOk = /Business Source License 1\.1/.test(readme)
  && /LICENSE-BSL\.md/.test(readme)
  && /2029-05-03/.test(readme)
  && /Additional Use Grant|takes money from that position|between an exhibitor and that exhibitor/i.test(readme);
if (licenceOk) ok("corpus/README.md carries the BSL 1.1 header, the Change Date and the effect of the Additional Use Grant in plain words");
else bad("corpus/README.md does not carry the BSL header, the Change Date and the Additional Use Grant effect");

const independenceOk = /not affiliated with/i.test(readme) && /retriev/i.test(readme);
if (independenceOk) ok("corpus/README.md states independence from every named vendor and the retrieval discipline");
else bad("corpus/README.md does not state independence and the retrieval discipline");

// ---- 15. the corpus declares a version a fingerprint can name ------------
const version = JSON.parse(readFileSync("corpus/version.json", "utf8"));
if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version.corpus_version || "") && version.entry_schema === "urn:changeover:schema:corpus-entry:0.1")
  ok("corpus/version.json declares corpus_version " + version.corpus_version + " against the 0.1 entry schema");
else bad("corpus/version.json does not declare a semver corpus_version against the 0.1 entry schema");

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
