#!/usr/bin/env bash
# C-REFUSE / CORE-002. G1's order is part of the wire contract, so this asserts
# two different things about it: that the TABLE in packages/core/src/guards.ts
# reproduces SPEC.md:430 exactly, and that the VERB actually returns the first
# failure in that order when four guards fail at once.
#
# The cheaper check — "the refusal was one of the four" — would have passed a
# server that reported seat_contended for a request whose etag had also moved,
# sending the agent back to re-resolve seats it will be refused again for a
# reason it was never told. Which failure is reported first decides what the
# agent does next, and that is why it is normative rather than tasteful.
#
# It needs no concurrency: every assertion here is observable on one connection,
# which is why it can exit 0 honestly against PGlite.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f SPEC.md ]                           || { echo "cannot prove — SPEC.md missing"; exit 2; }
[ -f packages/core/src/guards.ts ]       || { echo "cannot prove — packages/core/src/guards.ts missing"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]   || { echo "cannot prove — packages/core/src/hold-seats.ts missing"; exit 2; }

node --input-type=module -e '
import { readFileSync } from "node:fs";
import { G1, G1_CODES_IN_ORDER, G1_READ_ONLY_THROUGH, firstInG1Order } from "./packages/core/src/guards.ts";
import { holdSeats } from "./packages/core/src/hold-seats.ts";
import { isRefusal } from "./packages/schema/src/refusal.ts";
import { bench, etagFor, occasion, record, rowCounts, totalRows } from "./packages/core/test/lib/estate.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

/* ---- 1. The table reproduces the specification, not the other way round ---- */

// SPEC.md:430 is the authority. Parsing it here means a reordering of the
// specification turns this proof red rather than quietly agreeing with
// whatever guards.ts happens to say.
const spec = readFileSync("SPEC.md", "utf8").split("\n");
const line = spec.find((l) => l.includes("**G1.**"));
if (!line) {
  console.log("cannot prove — SPEC.md carries no G1 rule to parse");
  process.exit(2);
}

const steps = [];
for (const m of line.matchAll(/\((\d+)\)\s*([^·`]+)/g)) {
  const codes = m[2]
    .replace(/\(incl\.[^)]*\)/g, "")
    .split("/")
    .map((c) => c.trim())
    .filter((c) => /^[a-z_]+$/.test(c));
  steps.push({ step: Number(m[1]), codes });
}

steps.length === 12
  ? ok("SPEC.md:430 declares twelve guard steps, and twelve were parsed out of it")
  : bad("parsed " + steps.length + " steps out of SPEC.md:430, not twelve");

const specOrder = steps.flatMap((s) => s.codes).join(" ");
const tableOrder = [...G1_CODES_IN_ORDER].join(" ");
specOrder === tableOrder
  ? ok("the G1 table reproduces the order and the membership SPEC.md:430 fixes, exactly")
  : bad("G1 diverges from SPEC.md:430\n    spec:  " + specOrder + "\n    table: " + tableOrder);

const stepsMatch = steps.every((s, i) => G1[i] && G1[i].step === s.step && G1[i].codes.join("/") === s.codes.join("/"));
stepsMatch
  ? ok("every step number and its codes match the specification, step by step")
  : bad("a step number or its code set diverges from SPEC.md:430");

/* ---- 2. Two properties the table carries so the verb need not remember ----- */

const phases = G1.map((s) => s.phase);
const firstTx = phases.indexOf("transaction");
phases.slice(0, firstTx).every((p) => p === "request") && !phases.slice(firstTx).includes("request")
  ? ok("the request-only steps are a PREFIX, so a malformed request never opens a transaction")
  : bad("the request-phase steps are not a prefix of G1");

G1.filter((s) => s.step <= G1_READ_ONLY_THROUGH).every((s) => s.writes === false)
  ? ok("no step at or below " + G1_READ_ONLY_THROUGH + " is marked as writing — G1 permits no mutation before the first six pass")
  : bad("a step at or below " + G1_READ_ONLY_THROUGH + " is marked as writing");

/* ---- 3. The verb returns the FIRST failure, over four independent runs ----- */

const AGENT = { agent_id: "agt_reference", principal_scope: "ps_household_1" };
const HOUSE = "occ_house", DARK = "occ_dark", CLOSED = "occ_closed";

const stale = {
  async observe() {
    return { mode: "seat_map", observed_at: "2020-01-01T00:00:00+12:00", staleness_basis: "measured", max_staleness_ms: 30000 };
  },
};

const b = await bench([
  occasion({ occasion_id: HOUSE, capacity: 20 }),
  occasion({ occasion_id: DARK, capacity: 20, availability_mode: "unknown" }),
  occasion({ occasion_id: CLOSED, capacity: 20, sales_cutoff_at: "2020-01-01T00:00:00+12:00" }),
]);

const refusalOf = async (fn) => {
  try { await fn(); } catch (err) { if (isRefusal(err)) return err; throw err; }
  return null;
};

try {
  // One fixture, four guards failing simultaneously: the etag is stale (4), the
  // availability observation is older than published (5), the screening is past
  // its sales cutoff (6), and one named seat is not in the auditorium (10).
  const base = {
    occasion_id: CLOSED,
    occasion_etag: etagFor("something else entirely"),
    sought: { occasion_id: CLOSED, occasion_etag: etagFor(CLOSED) },
    seats: ["A:1", "ZZ:99"],
    requested_floor_ms: 120000,
  };

  const runs = [
    { why: "all four failing", request: base, options: { availability: stale }, expect: "occasion_moved" },
    { why: "the etag corrected", request: { ...base, occasion_etag: etagFor(CLOSED) }, options: { availability: stale }, expect: "availability_stale" },
    { why: "availability corrected", request: { ...base, occasion_etag: etagFor(CLOSED) }, options: {}, expect: "past_sales_cutoff" },
    {
      why: "the cutoff corrected",
      request: { ...base, occasion_id: HOUSE, occasion_etag: etagFor(HOUSE), sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) } },
      options: {},
      expect: "unknown_seat",
    },
  ];

  const observed = [];
  for (const run of runs) {
    await b.reset();
    const refusal = await refusalOf(() => holdSeats(b.db, run.request, AGENT, run.options));
    if (refusal === null) { bad(run.why + ": the call succeeded where a refusal was required"); continue; }
    observed.push(refusal.code);
    refusal.code === run.expect
      ? ok("with " + run.why + ", the first failure in G1 order is returned: " + refusal.code)
      : bad("with " + run.why + ", expected " + run.expect + " and got " + refusal.code);
  }

  // The same prediction, made by the table alone rather than by the verb.
  firstInG1Order(["unknown_seat", "past_sales_cutoff", "availability_stale", "occasion_moved"]) === observed[0]
    ? ok("and the table predicts the same winner without the verb being run at all")
    : bad("firstInG1Order disagrees with what the verb returned");

  /* ---- 4. Guards 1 to 6 write nothing — not a row, and not a lock --------- */

  const rec = record(b.db);
  const readOnly = [
    { why: "1 profile_not_supported", request: { ...base, occasion_id: HOUSE, occasion_etag: etagFor(HOUSE), sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) }, seats: ["A:1"] }, options: { profile: "0" } },
    { why: "2 schema_validation (W2)", request: { ...base, occasion_id: HOUSE, occasion_etag: etagFor(HOUSE), sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) }, seats: ["A:1", "A:1"] }, options: {} },
    { why: "3 occasion_not_found", request: { ...base, occasion_id: "occ_nowhere", occasion_etag: etagFor("x"), sought: { occasion_id: "occ_nowhere", occasion_etag: etagFor("x") }, seats: ["A:1"] }, options: {} },
    { why: "4 occasion_moved", request: { ...base, occasion_id: HOUSE, occasion_etag: etagFor("moved"), sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) }, seats: ["A:1"] }, options: {} },
    { why: "5 availability_unknown", request: { ...base, occasion_id: DARK, occasion_etag: etagFor(DARK), sought: { occasion_id: DARK, occasion_etag: etagFor(DARK) }, seats: ["A:1"] }, options: {} },
    { why: "6 past_sales_cutoff", request: { ...base, occasion_id: CLOSED, occasion_etag: etagFor(CLOSED), sought: { occasion_id: CLOSED, occasion_etag: etagFor(CLOSED) }, seats: ["A:1"] }, options: {} },
  ];

  let clean = true;
  for (const run of readOnly) {
    await b.reset();
    rec.clear();
    const refusal = await refusalOf(() => holdSeats(rec.db, run.request, AGENT, run.options));
    if (refusal === null) { bad(run.why + ": the call succeeded where a refusal was required"); clean = false; continue; }
    const step = G1.find((s) => s.codes.includes(refusal.code));
    if (!step || step.step > G1_READ_ONLY_THROUGH) { bad(run.why + ": refused with " + refusal.code + ", which G1 does not order at or below " + G1_READ_ONLY_THROUGH); clean = false; continue; }
    const writes = rec.writes();
    if (writes.length > 0) { bad(run.why + ": issued " + writes.length + " writing statement(s) before the first six passed, first: " + writes[0].sql.trim().split("\n")[0]); clean = false; }
    const rows = totalRows(await rowCounts(b.db));
    if (rows !== 0) { bad(run.why + ": left " + rows + " row(s) in the store"); clean = false; }
  }
  clean
    ? ok("each of the six read-only guards refused having issued no insert, update, delete or advisory lock, and left zero rows")
    : bad("a read-only guard mutated the store");

  await b.reset();
  rec.clear();
  await refusalOf(() => holdSeats(rec.db, { ...base, occasion_id: HOUSE, occasion_etag: etagFor(HOUSE), sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) }, seats: ["A:1"] }, AGENT, { profile: "0" }));
  rec.statements.length === 0
    ? ok("a step-1 refusal issues no statement of any kind: the store is never opened")
    : bad("a step-1 refusal issued " + rec.statements.length + " statement(s)");

  await b.reset();
  rec.clear();
  await refusalOf(() => holdSeats(rec.db, { ...base, occasion_id: HOUSE, occasion_etag: etagFor(HOUSE), sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) }, seats: ["A:1", "A:1"] }, AGENT));
  rec.statements.length === 0
    ? ok("W2: a duplicate-bearing seats array is refused before any lock is taken, and before any transaction is opened")
    : bad("W2: a duplicate-bearing seats array issued " + rec.statements.length + " statement(s)");
} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err));
} finally {
  await b.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
