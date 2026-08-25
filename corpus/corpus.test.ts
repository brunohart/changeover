// The boundary corpus, tested for the properties that make it evidence rather
// than assertion. These are negative tests as much as positive ones: a schema
// that accepts everything proves nothing, so each case here mutates a real
// entry into a dishonest one and asserts the schema catches it.
//
// Licensed under ../LICENSE-BSL.md with the rest of corpus/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

type Entry = Record<string, unknown>;

const ROOT = new URL("../", import.meta.url).pathname;
const read = (p: string) => JSON.parse(readFileSync(ROOT + p, "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateEntry = ajv.compile(read("corpus/entry.schema.json"));

const fpAjv = new Ajv2020({ strict: true, allErrors: true });
addFormats(fpAjv);
const validateFingerprint = fpAjv.compile(read("schemas/fingerprint.schema.json"));

const files = readdirSync(ROOT + "corpus/entries").filter((f) => f.endsWith(".json")).sort();
const entries: Entry[] = files.map((f) => read("corpus/entries/" + f));
const clone = (e: Entry): Entry => structuredClone(e);
const aDocumented = () => clone(entries.find((e) => e.method === "documented") as Entry);
const aProbe = () => clone(entries.find((e) => e.method === "probed_live") as Entry);

test("every corpus entry validates against entry.schema.json", () => {
  for (const [i, e] of entries.entries()) {
    assert.ok(validateEntry(e), files[i] + ": " + ajv.errorsText(validateEntry.errors, { separator: "; " }));
  }
});

test("the corpus carries at least twelve entries", () => {
  assert.ok(entries.length >= 12, "expected >= 12 entries, found " + entries.length);
});

test("provenance is spread across methods and includes a live probe", () => {
  const methods = new Set(entries.map((e) => e.method));
  assert.ok(methods.size >= 2, "a corpus with one method has one source");
  assert.ok(methods.has("probed_live"), "no entry was established by touching a live surface");
});

test("entry ids are unique and each file is named for its id", () => {
  const ids = entries.map((e) => e.id as string);
  assert.equal(new Set(ids).size, ids.length, "duplicate entry id");
  for (const [i, e] of entries.entries()) assert.equal(files[i], e.id + ".json");
});

test("the schema rejects probed_live with no evidence", () => {
  const e = aProbe();
  delete e.evidence;
  assert.ok(!validateEntry(e), "a probed_live entry with no evidence must not validate");
});

test("the schema accepts a documented entry with no evidence", () => {
  const e = aDocumented();
  assert.ok(!("evidence" in e), "fixture assumption: the documented entry carries no evidence");
  assert.ok(validateEntry(e), "evidence is required only of probed_live");
});

test("the schema rejects a citation URL that is not https", () => {
  const e = aDocumented();
  (e.citation as Record<string, unknown>).url = "http://developer.example.com/page";
  assert.ok(!validateEntry(e));
});

test("the schema rejects an entry with no citation at all", () => {
  const e = aDocumented();
  delete e.citation;
  assert.ok(!validateEntry(e), "an uncited claim about somebody else's system must not validate");
});

test("the schema rejects a retrieved_at that is not a timestamp", () => {
  const e = aDocumented();
  (e.citation as Record<string, unknown>).retrieved_at = "last Tuesday";
  assert.ok(!validateEntry(e));
});

test("the schema rejects a method outside the closed set", () => {
  const e = aDocumented();
  e.method = "seemed_plausible";
  assert.ok(!validateEntry(e));
});

test("the schema rejects a half_life_days of zero and a missing basis", () => {
  const zero = aDocumented();
  zero.half_life_days = 0;
  assert.ok(!validateEntry(zero), "a claim that never decays is not a claim about a live system");
  const noBasis = aDocumented();
  delete noBasis.half_life_basis;
  assert.ok(!validateEntry(noBasis), "a half-life with no stated basis is a decoration");
});

test("the schema rejects an unknown member, including a personal one", () => {
  const e = aDocumented();
  (e.surface as Record<string, unknown>).contact_email = "someone@example.com";
  assert.ok(!validateEntry(e), "additionalProperties:false is what keeps personal data out by construction");
});

test("the schema rejects a response body smuggled into evidence", () => {
  const e = aProbe();
  (e.evidence as Record<string, unknown>).response_body = "{...}";
  assert.ok(!validateEntry(e), "a stored response body is an unbounded channel for personal data");
});

test("the fingerprint schema validates the example fingerprint", () => {
  const fp = read("corpus/fingerprint-example.json");
  assert.ok(validateFingerprint(fp), fpAjv.errorsText(validateFingerprint.errors, { separator: "; " }));
});

test("every entry_id in the example fingerprint resolves to an entry", () => {
  const fp = read("corpus/fingerprint-example.json") as { observations: { entry_id: string }[] };
  const known = new Set(entries.map((e) => e.id as string));
  for (const o of fp.observations) assert.ok(known.has(o.entry_id), "dangling entry_id " + o.entry_id);
});

test("the fingerprint schema rejects a verdict outside the closed set", () => {
  const fp = read("corpus/fingerprint-example.json");
  fp.observations[0].verdict = "probably";
  assert.ok(!validateFingerprint(fp), "indeterminate is the only permitted uncertainty");
});

test("the fingerprint schema rejects an observation with no method", () => {
  const fp = read("corpus/fingerprint-example.json");
  delete fp.observations[0].method;
  assert.ok(!validateFingerprint(fp));
});

test("no file in corpus/ carries an email-, E.164- or Luhn-shaped string", () => {
  const luhn = (s: string) => {
    let sum = 0;
    let alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
      let n = s.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  };
  const targets = files.map((f) => "corpus/entries/" + f).concat(["corpus/README.md", "corpus/version.json", "corpus/fingerprint-example.json", "corpus/entry.schema.json"]);
  for (const t of targets) {
    const text = readFileSync(ROOT + t, "utf8");
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), t + " carries an email-shaped string");
    assert.ok(!/\+[1-9]\d{7,14}(?!\d)/.test(text), t + " carries an E.164-shaped string");
    for (const run of text.match(/\d{13,19}/g) ?? []) assert.ok(!luhn(run), t + " carries a Luhn-valid digit run");
  }
});
