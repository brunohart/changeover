#!/usr/bin/env bash
# C-FANOUT / C-BUDGET, sequentially, at PRODUCTION defaults.
#
# What is asserted: that the published exhaustion ceilings actually bind, that a
# principal cannot fan out across a demand cluster, that two DIFFERENT customers
# of one agent platform are not billed for each other's hedging, and that no
# limit is enforced which the hold policy has not published.
#
# Why the obvious cheaper check would not have caught it: reading the refusal
# code off the response says only that a refusal was rendered. Every assertion
# here also COUNTS ROWS — `hold`, `hold_slot`, `hold_seat` — because the failure
# that matters is a ceiling that refuses the caller and writes the row anyway, or
# one that refuses on an unlocked SELECT and lets a concurrent pair through. The
# second of those is not observable on one connection at all, which is why the
# concurrency half of this gate lives in prove_no_fanout_concurrent.sh and exits
# 2 rather than pretending PGlite is two callers.
#
# These assertions run at HOLD_POLICY_PUBLISHED and at no other numbers. A
# fan-out proof at limits nobody ships is a proof about a configuration file.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/budgets.ts ]      || { echo "cannot prove — packages/core/src/budgets.ts missing"; exit 2; }
[ -f packages/core/src/principal.ts ]    || { echo "cannot prove — packages/core/src/principal.ts missing"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]   || { echo "cannot prove — packages/core/src/hold-seats.ts missing (CORE-002)"; exit 2; }
[ -f schemas/hold-policy.schema.json ]   || { echo "cannot prove — schemas/hold-policy.schema.json missing"; exit 2; }

node --input-type=module -e '
import { readFileSync } from "node:fs";
import { openDb } from "./packages/store/src/db.ts";
import { migrate, resetHoldStore } from "./packages/store/src/migrate.ts";
import { seatGrid, seedEstate } from "./packages/store/src/fixtures.ts";
import { isRefusal } from "./packages/schema/src/refusal.ts";
import { holdSeats } from "./packages/core/src/hold-seats.ts";
import {
  EXHAUSTION,
  EXHAUSTION_LIMIT_NAMES,
  HOLD_POLICY_PUBLISHED,
  budgetLockKeys,
  principalBudgets,
} from "./packages/core/src/budgets.ts";
import { requirePrincipal } from "./packages/core/src/principal.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const AGENT     = "agt_examplebot";
const HOUSEHOLD = { agent_id: AGENT, principal_scope: "ppid_household_a" };
const NEIGHBOUR = { agent_id: AGENT, principal_scope: "ppid_household_b" };

const etagFor = (seed) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "", h = 2166136261;
  for (let i = 0; i < 43; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0;
    out += alphabet[h % alphabet.length];
  }
  return "1:" + out;
};

const occasion = (occasion_id, cluster, document) => ({
  occasion_id,
  revision: 1,
  etag: etagFor(occasion_id),
  origin: "https://embassy.example",
  source: "reference",
  showtime_id: occasion_id,
  cluster,
  seating: "allocated",
  capacity: 400,
  availability_mode: "seat_map",
  starts_at: "2026-08-29T19:00:00+12:00",
  local_wall: "2026-08-29T19:00",
  local_wall_offset: "+12:00",
  sales_cutoff_at: "2026-12-29T19:15:00+12:00",
  document,
  seats: seatGrid({ capacity: 400, per_row: 10 }),
});

// Two Occasions the publisher attested as substitutes for ONE ANOTHER, and did
// not label into a cluster. `hold_cluster_live` cannot see this pair; the
// preorder can.
const mutual = (self, other) => ({
  occasion_id: self,
  substitution: { policy: "advisory", accepts_substitute: [{ occasion_id: other, axis: "instant" }] },
});

const ESTATE = { name: "no-fanout", occasions: [
  occasion("occ_slots", null, undefined),
  occasion("occ_fri",   "clu_35mm_run", undefined),
  occasion("occ_sat",   "clu_35mm_run", undefined),
  occasion("occ_a",     null, mutual("occ_a", "occ_b")),
  occasion("occ_b",     null, mutual("occ_b", "occ_a")),
]};

/** One hold_seats call at published ceilings, reported rather than thrown. */
async function attempt(db, occasion_id, seats, credential, guard) {
  const etag = etagFor(occasion_id);
  try {
    const hold = await holdSeats(db, {
      occasion_id, occasion_etag: etag,
      sought: { occasion_id, occasion_etag: etag },
      seats, requested_floor_ms: 60000,
    }, credential, { budgets: guard ?? principalBudgets() });
    return { hold };
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return { code: err.code, detail: err.detail };
  }
}

const count = async (db, sql, params) => Number((await db.query(sql, params)).rows[0].n);
const rows  = (db, table) => count(db, `select count(*)::text as n from ${table}`);

const db = await openDb();
try {
  await migrate(db);
  await seedEstate(db, ESTATE);

  /* ── 1 · X0, and it needs no store at all ───────────────────────────────── */

  for (const [label, credential] of [
    ["absent",       { agent_id: AGENT }],
    ["null",         { agent_id: AGENT, principal_scope: null }],
    ["empty string", { agent_id: AGENT, principal_scope: "" }],
  ]) {
    let code = null;
    try { requirePrincipal(credential); } catch (err) { code = isRefusal(err) ? err.code : String(err); }
    code === "principal_scope_missing"
      ? ok(`X0 · a principal_scope that is ${label} is 403 principal_scope_missing`)
      : bad(`X0 · a principal_scope that is ${label} gave ${code}`);
  }

  /* ── 2 · §2.5 — nothing unpublished is enforced, both directions ────────── */

  const schema = JSON.parse(readFileSync("schemas/hold-policy.schema.json", "utf8"));
  const published = new Set(schema.required);
  const missing = EXHAUSTION_LIMIT_NAMES.filter((n) => !published.has(n));
  missing.length === 0
    ? ok(`§2.5 · all ${EXHAUSTION_LIMIT_NAMES.length} enforceable ceilings are required members of the published hold policy`)
    : bad(`§2.5 · enforced but not published: ${missing.join(", ")}`);

  const unenforced = EXHAUSTION_LIMIT_NAMES.filter((n) => !EXHAUSTION.some((c) => c.limit === n));
  unenforced.length === 0
    ? ok("§2.5 · every ceiling named in the table has an enforcement site, so the table cannot drift from the code")
    : bad(`§2.5 · published as a ceiling and enforced nowhere: ${unenforced.join(", ")}`);

  const backing = EXHAUSTION.filter((c) => c.backed_by !== "constraint" && c.backed_by !== "lock");
  backing.length === 0
    ? ok("N1 · every ceiling declares a constraint or a lock as its backing, never a bare read")
    : bad(`N1 · ceilings with no declared backing: ${backing.map((c) => c.limit).join(", ")}`);

  /* ── 3 · X1 — max+1 sequential holds yield exactly max ──────────────────── */

  await resetHoldStore(db);
  {
    const guard = principalBudgets();
    const max = HOLD_POLICY_PUBLISHED.max_live_holds_per_showtime;
    const outcomes = [];
    for (let i = 0; i < max + 1; i++) {
      outcomes.push(await attempt(db, "occ_slots", [`A:${i + 1}`], HOUSEHOLD, guard));
    }
    const granted = outcomes.filter((o) => o.hold !== undefined).length;
    granted === max
      ? ok(`X1 · ${max + 1} sequential holds at max_live_holds_per_showtime=${max} yielded exactly ${max} grants`)
      : bad(`X1 · ${max + 1} sequential holds yielded ${granted} grants, not ${max}`);

    const last = outcomes[max];
    last.code === "hold_budget_exhausted" && last.detail?.limit === max
      ? ok(`X1 · the (max+1)th is 429 hold_budget_exhausted naming limit ${max}`)
      : bad(`X1 · the (max+1)th gave ${last.code} ${JSON.stringify(last.detail)}`);

    // Against the STORE, not the response: the refused grant left nothing behind.
    const holds = await rows(db, "hold"), slots = await rows(db, "hold_slot"), seats = await rows(db, "hold_seat");
    holds === max && slots === max && seats === max
      ? ok(`X1 · the store carries exactly ${max} holds, ${max} slots and ${max} seat rows — the refusal wrote nothing`)
      : bad(`X1 · store carries ${holds} holds, ${slots} slots, ${seats} seat rows; expected ${max} of each`);
  }

  /* ── 4 · X2 — one principal, one cluster, one hold ──────────────────────── */

  await resetHoldStore(db);
  {
    const first  = await attempt(db, "occ_fri", ["A:1"], HOUSEHOLD);
    const second = await attempt(db, "occ_sat", ["A:1"], HOUSEHOLD);
    first.hold !== undefined && second.code === "cluster_fanout"
      ? ok("X2 · two same-cluster holds for one principal are exactly one grant and one 429 cluster_fanout")
      : bad(`X2 · got ${first.hold ? "grant" : first.code} then ${second.hold ? "grant" : second.code}`);

    second.detail?.conflicting_hold_id === first.hold?.hold_id && second.detail?.cluster === "clu_35mm_run"
      ? ok("X2 · the refusal names the conflicting hold and the cluster, so release_conflicting_hold is actionable")
      : bad(`X2 · the refusal detail was ${JSON.stringify(second.detail)}`);

    const holds = await rows(db, "hold");
    holds === 1 ? ok("X2 · exactly one hold row exists — the refused grant did not commit")
                : bad(`X2 · ${holds} hold rows exist, expected 1`);
  }

  /* ── 5 · X0 — two DIFFERENT principals on ONE platform both succeed ─────── */

  await resetHoldStore(db);
  {
    const household = await attempt(db, "occ_fri", ["A:1"], HOUSEHOLD);
    const neighbour = await attempt(db, "occ_sat", ["A:2"], NEIGHBOUR);
    household.hold !== undefined && neighbour.hold !== undefined
      ? ok("X0 · two DIFFERENT principals on one agent platform both hold in the same cluster")
      : bad(`X0 · household ${household.hold ? "granted" : household.code}, neighbour ${neighbour.hold ? "granted" : neighbour.code}`);

    const distinct = await count(db,
      "select count(distinct principal_scope)::text as n from hold where agent_id = $1", [AGENT]);
    const holds = await rows(db, "hold");
    holds === 2 && distinct === 2
      ? ok("X0 · the store carries two holds under two principal scopes — the budget is per customer, not per platform")
      : bad(`X0 · ${holds} holds under ${distinct} principal scopes`);
  }

  /* ── 6 · X2 — the derived cluster, where no label exists ────────────────── */

  await resetHoldStore(db);
  {
    const first  = await attempt(db, "occ_a", ["A:1"], HOUSEHOLD);
    const second = await attempt(db, "occ_b", ["A:1"], HOUSEHOLD);
    first.hold !== undefined && second.code === "cluster_fanout"
      ? ok("X2 · fan-out across a mutually-substitutable pair is refused with NO cluster label — substitutability is machine-checkable")
      : bad(`X2 · derived fan-out gave ${first.hold ? "grant" : first.code} then ${second.hold ? "grant" : second.code}`);

    const labelled = await count(db, "select count(*)::text as n from hold_cluster");
    labelled === 0
      ? ok("X2 · no hold_cluster row exists, so the index cannot have been what refused it")
      : bad(`X2 · ${labelled} hold_cluster rows exist; the label, not the preorder, may have refused it`);
  }

  /* ── 7 · X2 — `claimed` is outside the predicate ────────────────────────── */

  await resetHoldStore(db);
  {
    const first = await attempt(db, "occ_fri", ["A:1"], HOUSEHOLD);
    await db.query(
      `update hold set handed_off_at = now(), handoff_floor_ms = 120000,
              claim_expires_at = expires_at + interval $$2 minutes$$, claimed_at = now()
        where hold_id = $1`, [first.hold.hold_id]);
    await db.query("update hold_cluster set state = $1 where hold_id = $2", ["claimed", first.hold.hold_id]);
    await db.query("update hold_seat set state = $1 where hold_id = $2", ["claimed", first.hold.hold_id]);

    const second = await attempt(db, "occ_sat", ["A:1"], HOUSEHOLD);
    second.hold !== undefined
      ? ok("X2 · a completed purchase does not block the next one — two purchases in one cluster are not fan-out")
      : bad(`X2 · a second purchase in one cluster was refused ${second.code}`);
  }

  /* ── 8 · X4 and X3 — the seat ceilings, and which one binds ─────────────── */

  await resetHoldStore(db);
  {
    // capacity 400: the principal ceiling is min(6, 5% of 400) = 6 and the
    // platform ceiling is 2% of 400 = 8, so the per-principal half binds first.
    const first  = await attempt(db, "occ_slots", ["A:1","A:2","A:3","A:4","A:5","A:6"], HOUSEHOLD);
    const second = await attempt(db, "occ_slots", ["B:1"], HOUSEHOLD);
    first.hold !== undefined && second.code === "seat_budget_exhausted" && second.detail?.limit === 6
      ? ok("X4 · a principal is capped at min(max_live_seats_per_showtime, bp × capacity) live held seats, and the refusal names it")
      : bad(`X4 · got ${first.hold ? "grant" : first.code} then ${second.code} ${JSON.stringify(second.detail)}`);

    const seats = await rows(db, "hold_seat");
    seats === 6 ? ok("X4 · exactly six seat rows exist — the refused grant wrote none")
                : bad(`X4 · ${seats} seat rows exist, expected 6`);

    const third = await attempt(db, "occ_slots", ["B:1","B:2","B:3"], NEIGHBOUR);
    third.code === "seat_budget_exhausted" && third.detail?.limit === 8
      ? ok("X3 · the platform ceiling counts every principal on one platform and refuses at 2% of the house")
      : bad(`X3 · the ninth seat for a second principal gave ${third.code} ${JSON.stringify(third.detail)}`);
  }

  /* ── 9 · N1 — the locks are taken before anything is counted ────────────── */

  await resetHoldStore(db);
  {
    const keys = budgetLockKeys({
      agent_id: AGENT, principal_scope: "ppid_a", hold_id: "hold_x", occasion_id: "occ",
      showtime_id: "occ_slots", origin: "https://embassy.example", cluster: null,
      capacity: 400, seat_ids: ["A:1"],
    });
    const sorted = [...keys].sort();
    keys.length === 4 && new Set(keys).size === 4 && JSON.stringify(keys) === JSON.stringify(sorted)
      ? ok("N1 · four distinct budget scopes, locked in ascending byte order, so two grants wait rather than deadlock")
      : bad(`N1 · budget lock keys were ${JSON.stringify(keys)}`);

    const other = budgetLockKeys({
      agent_id: AGENT, principal_scope: "ppid_b", hold_id: "hold_y", occasion_id: "occ",
      showtime_id: "occ_slots", origin: "https://embassy.example", cluster: null,
      capacity: 400, seat_ids: ["A:2"],
    });
    keys.filter((k) => other.includes(k)).length === 2
      ? ok("N1 · two principals share exactly the two platform scopes and neither principal scope")
      : bad("N1 · two principals do not share exactly the platform scopes");

    // The real path, watched. Every statement the guard issues is recorded, and
    // the claim under test is that no aggregate is evaluated before the locks
    // that make it stable are held — which is the whole of N1.
    const seen = [];
    const watcher = {
      driver: db.driver, concurrent: db.concurrent,
      query: (sql, params) => { seen.push(sql); return db.query(sql, params); },
      exec: (sql) => db.exec(sql),
      close: () => Promise.resolve(),
      transaction: (fn, options) => db.transaction((tx) => fn({
        query: (sql, params) => { seen.push(sql); return tx.query(sql, params); },
        exec: (sql) => tx.exec(sql),
      }), options),
    };
    const granted = await attempt(watcher, "occ_slots", ["A:1"], HOUSEHOLD);
    const firstBudgetLock = seen.findIndex((s) => s.includes("pg_advisory_xact_lock(hashtextextended($1, 0))"));
    const firstAggregate  = seen.findIndex((s) => /count\(\*\)|sum\(cardinality/.test(s));
    granted.hold !== undefined && firstBudgetLock >= 0 && firstAggregate > firstBudgetLock
      ? ok("N1 · every budget aggregate is evaluated after its lock is held — no ceiling is decided by an unlocked SELECT")
      : bad(`N1 · budget lock at statement ${firstBudgetLock}, first aggregate at ${firstAggregate}`);
  }

  /* ── 10 · §2.5 — what was ACTUALLY enforced, and where it is published ──── */

  await resetHoldStore(db);
  {
    const guard = principalBudgets();
    await attempt(db, "occ_slots", ["A:1"], HOUSEHOLD, guard);
    const consulted = guard.consulted;
    const undisclosed = consulted.filter((n) => !published.has(n));
    consulted.length > 0 && undisclosed.length === 0
      ? ok(`§2.5 · ${consulted.length} limits were observed being enforced and every one is published: ${consulted.join(", ")}`)
      : bad(`§2.5 · enforced and undisclosed: ${undisclosed.join(", ") || "(the guard enforced nothing)"}`);
  }
} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
} finally {
  await db.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
