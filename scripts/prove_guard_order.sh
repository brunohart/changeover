#!/usr/bin/env bash
# C-REFUSE / CORE-002. G1's order is part of the wire contract, so this asserts
# three things about it: that the TABLE in packages/core/src/guards.ts
# reproduces SPEC.md:430 exactly; that the VERB returns the first failure in
# that order when four READ guards fail at once; and — section 5, added
# 2026-08-26 — that a WRITING guard wins over a later one, for BOTH request
# forms.
#
# Section 5 exists because its absence hid a real defect. Until this file
# carried it, no run anywhere in the script made a step-8-to-12 guard the
# winner, and no run anywhere sent a `selection` at all: the whole write-phase
# half of G1 was asserted only as a static property of the table in guards.ts,
# never as a property of the verb. The verb was meanwhile returning
# `seat_contended` where G1 requires `cluster_fanout`, because
# `chooseBestAvailable` threw from inside `lockAndReap` — which runs immediately
# BEFORE the first writing step. The same fact answered `429 hold_budget_exhausted
# / retry_after` to a request naming its seats and `409 seat_contended /
# re_resolve` to a request that let the Server choose, and `re_resolve` for a
# ceiling the agent cannot clear is the forever-loop §4.6 names.
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
import { principalBudgets } from "./packages/core/src/budgets.ts";
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

const SIB_A = "occ_run_a", SIB_B = "occ_run_b", SMALL = "occ_small";

const b = await bench([
  occasion({ occasion_id: HOUSE, capacity: 20 }),
  occasion({ occasion_id: DARK, capacity: 20, availability_mode: "unknown" }),
  occasion({ occasion_id: CLOSED, capacity: 20, sales_cutoff_at: "2020-01-01T00:00:00+12:00" }),
  // Two listings in ONE cluster, so a principal already holding in the cluster
  // meets step 8 on the other. Separate showtimes, so step 9 is not what binds.
  occasion({ occasion_id: SIB_A, capacity: 20, cluster: "clu_run" }),
  occasion({ occasion_id: SIB_B, capacity: 20, cluster: "clu_run" }),
  // The two houses section 5 empties. Seats are emptied by marking them SOLD —
  // an exhibitor fact — rather than by giving them to rival principals: at
  // max_held_fraction_per_showtime 0.02 a fixture that held a whole small house
  // trips the PLATFORM ceiling during setup and never reaches the assertion.
  // 200 seats, because max_held_fraction_per_showtime is 0.02: a principal may
  // hold 2% of a screening, so a twenty-seat house caps them at ONE seat and
  // they can never reach max_live_holds_per_showtime = 2 for step 9 to bind.
  occasion({ occasion_id: SMALL, capacity: 200 }),
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

  /* ---- 5. A WRITING guard wins, and both request forms agree on which ----- */

  const OTHER = { agent_id: "agt_reference", principal_scope: "ps_household_2" };
  const hold = (occasion_id, seats, over = {}) => ({
    occasion_id,
    occasion_etag: etagFor(occasion_id),
    sought: { occasion_id, occasion_etag: etagFor(occasion_id) },
    seats,
    requested_floor_ms: 120000,
    ...over,
  });
  const pick = (occasion_id, quantity) => {
    const r = hold(occasion_id, undefined, { selection: { mode: "best_available", quantity } });
    delete r.seats;
    return r;
  };

  // (a) step 8 beats step 12: the principal already holds in this (origin,
  //     cluster), AND every seat in the target Occasion is held by somebody
  //     else. G1 says cluster_fanout. Both forms must say it.
  const BUDGETS = { budgets: principalBudgets() };
  const SOLD_OUT = "update occasion_seat set status = \x27sold\x27 where occasion_id = $1";
  const clusterCase = async (request) => {
    await b.reset();
    await b.db.query(SOLD_OUT, [SIB_B]);
    await holdSeats(b.db, hold(SIB_A, ["A:1"]), AGENT, BUDGETS);
    return refusalOf(() => holdSeats(b.db, request, AGENT, BUDGETS));
  };
  const clusterNamed = await clusterCase(hold(SIB_B, ["A:1"]));
  const clusterChosen = await clusterCase(pick(SIB_B, 1));

  clusterNamed !== null && clusterNamed.code === "cluster_fanout"
    ? ok("step 8 beats step 12 for a request that NAMES its seats: cluster_fanout, not seat_contended")
    : bad("naming the seats gave " + (clusterNamed === null ? "SUCCESS" : clusterNamed.code) + " where cluster_fanout was required");

  clusterChosen !== null && clusterChosen.code === "cluster_fanout"
    ? ok("and the same for a request that lets the Server CHOOSE, over a house it cannot fill: best_available answers cluster_fanout too")
    : bad("best_available gave " + (clusterChosen === null ? "SUCCESS" : clusterChosen.code) + " where cluster_fanout was required");

  // (b) step 9 beats step 12: the principal is at max_live_holds_per_showtime,
  //     AND every seat left is held by others. G1 says the step-9 code.
  const budgetCase = async (request) => {
    await b.reset();
    await holdSeats(b.db, hold(SMALL, ["A:1"]), AGENT, BUDGETS);
    await holdSeats(b.db, hold(SMALL, ["A:2"]), AGENT, BUDGETS);
    await b.db.query(
      "update occasion_seat set status = \x27sold\x27 where occasion_id = $1 and seat_id <> all($2::text[])",
      [SMALL, ["A:1", "A:2"]]);
    return refusalOf(() => holdSeats(b.db, request, AGENT, BUDGETS));
  };
  const budgetNamed = await budgetCase(hold(SMALL, ["A:3"]));
  const budgetChosen = await budgetCase(pick(SMALL, 1));

  const BUDGET_CODES = ["hold_budget_exhausted", "seat_budget_exhausted"];
  budgetNamed !== null && BUDGET_CODES.includes(budgetNamed.code)
    ? ok("step 9 beats step 12 for a request that NAMES its seats: " + budgetNamed.code)
    : bad("naming the seats gave " + (budgetNamed === null ? "SUCCESS" : budgetNamed.code) + " where a step-9 code was required");

  budgetChosen !== null && budgetNamed !== null && budgetChosen.code === budgetNamed.code
    ? ok("and best_available answers the SAME code — the request form does not decide what the agent is told")
    : bad("best_available gave " + (budgetChosen === null ? "SUCCESS" : budgetChosen.code) +
          " where naming the seats gave " + (budgetNamed === null ? "SUCCESS" : budgetNamed.code));

  // (c) step 11 beats step 12: a seat the exhibitor sold AND another live Hold
  //     covers. seat_unavailable is the exhibitor fact; seat_contended is not.
  await b.reset();
  await b.db.query("update occasion_seat set status = \x27sold\x27 where occasion_id = $1 and seat_id = $2", [HOUSE, "A:9"]);
  const rival = await refusalOf(() => holdSeats(b.db, hold(HOUSE, ["A:9"]), OTHER));
  const soldAndHeld = await refusalOf(() => holdSeats(b.db, hold(HOUSE, ["A:9"]), AGENT));
  soldAndHeld !== null && soldAndHeld.code === "seat_unavailable"
    ? ok("step 11 beats step 12: a seat the exhibitor sold is seat_unavailable, whatever else is true of it")
    : bad("a sold seat answered " + (soldAndHeld === null ? "SUCCESS" : soldAndHeld.code));
  rival === null || rival.code === "seat_unavailable"
    ? ok("and it answers the same to every principal, because it is the exhibitor\x27s fact and not a contention")
    : bad("the same sold seat answered " + rival.code + " to a second principal");
} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err));
} finally {
  await b.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
