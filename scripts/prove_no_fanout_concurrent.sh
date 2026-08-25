#!/usr/bin/env bash
# C-FANOUT / C-BUDGET, with the callers genuinely simultaneous.
#
# This is the half of the gate that prove_no_fanout.sh cannot reach. Sequential
# assertions show that a ceiling refuses; only concurrent ones show that it is a
# CONSTRAINT and not a read. §4.6 names the failure precisely: "at READ COMMITTED
# two hold_seats three milliseconds apart both count zero live holds in a
# cluster, both pass, both commit — so X2 failed to two concurrent requests."
# A guard implemented as an unlocked SELECT passes every test in the sequential
# script and fails here, which is the only reason this script exists.
#
# It runs at READ COMMITTED deliberately — the level holdSeats itself opens —
# because N1 permits SERIALIZABLE with retry OR constraint-and-lock backing, and
# holding at the weaker level is the evidence that this implementation chose the
# second and actually did it.
#
# PGlite is single-connection and in-process: lock contention and 40P01 cannot
# occur there, so a pass on it would mean nothing. Without a real Postgres this
# exits 2. It never exits 0 for a race it did not run.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

[ -f packages/core/src/budgets.ts ] || { echo "cannot prove — packages/core/src/budgets.ts missing"; exit 2; }
[ -d node_modules/pg ]              || { echo "cannot prove — node-postgres not installed; run npm install at the repository root"; exit 2; }

if [ -z "${CHANGEOVER_PG_URL:-}" ]; then
  echo "cannot prove — C-FANOUT needs true concurrency, and PGlite is single-connection and in-process:"
  echo "                lock contention and 40P01 cannot occur there, so a pass would mean nothing."
  echo "  to make it provable:"
  echo "    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18"
  echo "    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover"
  echo "    bash scripts/prove_no_fanout_concurrent.sh"
  exit 2
fi

node --input-type=module -e '
import { openDb, sqlstate } from "./packages/store/src/db.ts";
import { migrate, resetHoldStore } from "./packages/store/src/migrate.ts";
import { seatGrid, seedEstate } from "./packages/store/src/fixtures.ts";
import { isRefusal } from "./packages/schema/src/refusal.ts";
import { holdSeats } from "./packages/core/src/hold-seats.ts";
import { HOLD_POLICY_PUBLISHED, principalBudgets } from "./packages/core/src/budgets.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const remedy = () => {
  console.log("  to make it provable:");
  console.log("    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18");
  console.log("    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover");
  console.log("    bash scripts/prove_no_fanout_concurrent.sh");
};

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

const occasion = (occasion_id, cluster) => ({
  occasion_id, revision: 1, etag: etagFor(occasion_id),
  origin: "https://embassy.example", source: "reference", showtime_id: occasion_id,
  cluster, seating: "allocated", capacity: 400, availability_mode: "seat_map",
  starts_at: "2026-08-29T19:00:00+12:00", local_wall: "2026-08-29T19:00",
  local_wall_offset: "+12:00", sales_cutoff_at: "2026-12-29T19:15:00+12:00",
  seats: seatGrid({ capacity: 400, per_row: 10 }),
});

const ESTATE = { name: "no-fanout-concurrent", occasions: [
  occasion("occ_slots", null),
  occasion("occ_fri", "clu_35mm_run"),
  occasion("occ_sat", "clu_35mm_run"),
]};

// Every outcome, including the two SQLSTATEs that would mean the ordered locks
// did not do their job. A refusal is an answer; a 40P01 is a design failure.
async function attempt(db, occasion_id, seats, credential) {
  const etag = etagFor(occasion_id);
  try {
    const hold = await holdSeats(db, {
      occasion_id, occasion_etag: etag,
      sought: { occasion_id, occasion_etag: etag },
      seats, requested_floor_ms: 60000,
    }, credential, { budgets: principalBudgets() });
    return { kind: "grant", hold };
  } catch (err) {
    if (isRefusal(err)) return { kind: "refusal", code: err.code, detail: err.detail };
    return { kind: "error", sqlstate: sqlstate(err), message: String(err && err.message ? err.message : err) };
  }
}

const rows = async (db, table) =>
  Number((await db.query(`select count(*)::text as n from ${table}`)).rows[0].n);

let db;
try {
  db = await openDb({ poolSize: 16 });
  if (db.driver !== "pg") {
    console.log("cannot prove — CHANGEOVER_PG_URL is set but openDb returned the " + db.driver + " driver");
    await db.close();
    process.exit(2);
  }
  if (!db.concurrent) {
    console.log("cannot prove — the driver reports concurrent=false, so these assertions cannot race");
    await db.close();
    process.exit(2);
  }
  await db.query("select 1");
} catch (err) {
  console.log("cannot prove — CHANGEOVER_PG_URL is set but the server did not answer: " +
    String(err && err.message ? err.message : err));
  remedy();
  if (db) await db.close().catch(() => {});
  process.exit(2);
}

try {
  await migrate(db);
  await seedEstate(db, ESTATE);

  const level = (await db.query("show default_transaction_isolation")).rows[0];
  ok(`a real Postgres answered, driver ${db.driver}, concurrent ${db.concurrent}, default isolation ${Object.values(level)[0]}`);

  /* ── 1 · X1 — N concurrent holds on one showtime yield exactly max ──────── */

  await resetHoldStore(db);
  {
    const max = HOLD_POLICY_PUBLISHED.max_live_holds_per_showtime;
    const N = 8;
    const outcomes = await Promise.all(
      Array.from({ length: N }, (_, i) => attempt(db, "occ_slots", [`A:${i + 1}`], HOUSEHOLD)),
    );
    const grants   = outcomes.filter((o) => o.kind === "grant").length;
    const refusals = outcomes.filter((o) => o.kind === "refusal" && o.code === "hold_budget_exhausted").length;
    const errors   = outcomes.filter((o) => o.kind === "error");

    grants === max
      ? ok(`X1 · ${N} CONCURRENT holds at max_live_holds_per_showtime=${max} yielded exactly ${max} grants`)
      : bad(`X1 · ${N} concurrent holds yielded ${grants} grants, not ${max} — the ceiling is a read, not a constraint`);
    grants + refusals === N
      ? ok(`X1 · every other caller got 429 hold_budget_exhausted — no caller got an unclassified fault`)
      : bad(`X1 · ${errors.length} callers faulted: ${errors.map((e) => e.sqlstate + " " + e.message).join(" | ")}`);

    const deadlocks = errors.filter((e) => e.sqlstate === "40P01").length;
    deadlocks === 0
      ? ok("X1 · zero 40P01 — the budget scopes are locked in one byte order, so concurrent grants wait rather than cycle")
      : bad(`X1 · ${deadlocks} deadlocks detected; the lock order is not total`);

    const slots = await rows(db, "hold_slot"), holds = await rows(db, "hold");
    slots === max && holds === max
      ? ok(`X1 · the store carries exactly ${max} slots and ${max} holds after ${N} concurrent attempts`)
      : bad(`X1 · store carries ${holds} holds and ${slots} slots after ${N} concurrent attempts`);
  }

  /* ── 2 · X2 — two CONCURRENT same-cluster holds, one principal ──────────── */

  await resetHoldStore(db);
  {
    const [a, b] = await Promise.all([
      attempt(db, "occ_fri", ["A:1"], HOUSEHOLD),
      attempt(db, "occ_sat", ["A:1"], HOUSEHOLD),
    ]);
    const grants   = [a, b].filter((o) => o.kind === "grant").length;
    const fanouts  = [a, b].filter((o) => o.kind === "refusal" && o.code === "cluster_fanout").length;
    grants === 1 && fanouts === 1
      ? ok("X2 · two CONCURRENT same-cluster holds for one principal are exactly one grant and one 429 cluster_fanout")
      : bad(`X2 · concurrent same-cluster holds gave ${grants} grants and ${fanouts} cluster_fanouts — both counted zero and both committed`);

    const holds = await rows(db, "hold");
    holds === 1 ? ok("X2 · exactly one hold row survived the race")
                : bad(`X2 · ${holds} hold rows survived the race, expected 1`);
  }

  /* ── 3 · X0 — two DIFFERENT principals, concurrently, both succeed ──────── */

  await resetHoldStore(db);
  {
    const [a, b] = await Promise.all([
      attempt(db, "occ_fri", ["A:1"], HOUSEHOLD),
      attempt(db, "occ_sat", ["A:2"], NEIGHBOUR),
    ]);
    a.kind === "grant" && b.kind === "grant"
      ? ok("X0 · two DIFFERENT principals on one platform both hold concurrently — the lock scopes do not collide")
      : bad(`X0 · household ${a.kind === "grant" ? "granted" : a.code ?? a.sqlstate}, neighbour ${b.kind === "grant" ? "granted" : b.code ?? b.sqlstate}`);

    const holds = await rows(db, "hold");
    holds === 2 ? ok("X0 · both holds committed — one household hedging cannot deny every other customer of that platform")
                : bad(`X0 · ${holds} hold rows exist, expected 2`);
  }

  /* ── 4 · X4 — concurrent seat grabs cannot exceed the ceiling ───────────── */

  await resetHoldStore(db);
  {
    // Six concurrent single-seat holds for one principal on one showtime. The
    // slot ceiling caps this at 2 holds; what is under test is that the seat
    // ceiling never lets the committed seat total exceed min(6, 5% of 400) = 6.
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) => attempt(db, "occ_slots", [`A:${i + 1}`, `B:${i + 1}`], HOUSEHOLD)),
    );
    const held = Number((await db.query(
      "select coalesce(sum(cardinality(seats)), 0)::text as n from hold where released_at is null")).rows[0].n);
    held <= 6
      ? ok(`X4 · after six concurrent multi-seat attempts the principal holds ${held} seats, within the published ceiling of 6`)
      : bad(`X4 · the principal holds ${held} seats, above the ceiling of 6 — the seat ceiling is not lock-backed`);

    const faults = outcomes.filter((o) => o.kind === "error");
    faults.length === 0
      ? ok("X4 · every concurrent attempt ended as a grant or a typed refusal, none as a fault")
      : bad(`X4 · ${faults.length} faults: ${faults.map((e) => e.sqlstate).join(", ")}`);
  }
} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
} finally {
  await db.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
