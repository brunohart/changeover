#!/usr/bin/env bash
# C-CLOCK / CORE-002. K4 and SPEC.md §4.6: `granted_at` MUST be
# `clock_timestamp()` at the instant the insert succeeds, NOT transaction start.
#
# The cheaper check — "granted_at is a plausible timestamp" — passes a server
# that reads `now()`, and that server is wrong in a way nobody can see from
# outside: a transaction spending 600ms before its insert mints a floor already
# 600ms in the past, and the whole deficit falls on the agent's side, where
# C-FLOOR can never look. So the assertion here is DIFFERENTIAL — it makes real
# time pass inside the transaction and measures granted_at against the
# transaction start it must NOT be.
#
# It needs no second connection to do that: a transaction can spend time on its
# own, and what makes time pass is not the point — the point is that granted_at
# moved and now() did not. Where CHANGEOVER_PG_URL is set the same assertion is
# additionally made with the time spent in a REAL lock wait, which is the case
# §4.6 actually names.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/clock.ts ]        || { echo "cannot prove — packages/core/src/clock.ts missing"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]   || { echo "cannot prove — packages/core/src/hold-seats.ts missing"; exit 2; }

node --input-type=module -e '
import { readFileSync } from "node:fs";
import { GRANT_CLOCK, REAP_CLOCK } from "./packages/core/src/clock.ts";
import { holdSeats } from "./packages/core/src/hold-seats.ts";
import { SEAT_LOCK_SQL } from "./packages/core/src/locking.ts";
import { bench, etagFor, occasion, record } from "./packages/core/test/lib/estate.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const AGENT = { agent_id: "agt_reference", principal_scope: "ps_household_1" };
const HOUSE = "occ_house";
const DELAY_MS = 600;

const b = await bench([occasion({ occasion_id: HOUSE, capacity: 40 })]);

// The delay is injected through the declared availability seam, which runs at
// G1 step 5 — inside the transaction, before the locks and before the grant.
// From the store s point of view this is indistinguishable from 600ms of lock
// waiting: the transaction snapshot is already fixed and now() is frozen.
const slowSource = {
  async observe(tx, occasion_id, server_time) {
    await tx.query("select pg_sleep($1::float8)", [DELAY_MS / 1000]);
    return { mode: "seat_map", observed_at: server_time, staleness_basis: "measured" };
  },
};

const holdOf = (db, seats, options) =>
  holdSeats(
    db,
    {
      occasion_id: HOUSE,
      occasion_etag: etagFor(HOUSE),
      sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) },
      seats,
      requested_floor_ms: 120000,
    },
    AGENT,
    options,
  );

try {
  /* ---- 1. The two clocks are two constants, and they are the right two ---- */

  GRANT_CLOCK === "clock_timestamp()"
    ? ok("GRANT_CLOCK is clock_timestamp() — the statement clock, which advances inside a transaction")
    : bad("GRANT_CLOCK is " + GRANT_CLOCK + ", not clock_timestamp()");

  REAP_CLOCK === "now()"
    ? ok("REAP_CLOCK is now() — transaction start, so a reap cannot take a seat that was live when it began")
    : bad("REAP_CLOCK is " + REAP_CLOCK + ", not now()");

  /* ---- 2. No JavaScript clock anywhere on the grant path ------------------ */

  // K4 admits ONE time source. The moment a JS clock enters the arithmetic the
  // rule is a comment, and an API node whose clock leads the database by 400ms
  // violates T1 by construction and silently.
  const source = readFileSync("packages/core/src/hold-seats.ts", "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  const jsClock = source.match(/\b(Date\.now|new Date|performance\.now|Date\.UTC)\b/g);
  jsClock === null
    ? ok("hold-seats.ts reads no JavaScript clock at all: not Date.now, not new Date, not performance.now")
    : bad("hold-seats.ts reads a JavaScript clock: " + jsClock.join(", "));

  /* ---- 3. The insert reads the statement clock, and the reap does not ----- */

  await b.reset();
  const rec = record(b.db);
  const baseline = await holdOf(rec.db, ["A:1"], {});
  const insert = rec.statements.find((s) => /insert\s+into\s+hold\b/i.test(s.sql));
  const reap = rec.statements.find((s) => /delete\s+from\s+hold_seat/i.test(s.sql));

  insert && insert.sql.includes("clock_timestamp()") && !/\bnow\(\)/.test(insert.sql)
    ? ok("the grant insert reads clock_timestamp() and never now()")
    : bad("the grant insert does not read clock_timestamp(), or also reads now()");

  reap && /\bnow\(\)/.test(reap.sql) && !reap.sql.includes("clock_timestamp()")
    ? ok("the reap reads now() and never clock_timestamp(): it cannot reap a seat that was live at transaction start")
    : bad("the reap does not read now(), or reads clock_timestamp()");

  Date.parse(baseline.floor_deadline) - Date.parse(baseline.granted_at) === baseline.floor_ms
    ? ok("floor_deadline is exactly granted_at + floor_ms, because both derive from ONE read of that clock")
    : bad("floor_deadline - granted_at is " + (Date.parse(baseline.floor_deadline) - Date.parse(baseline.granted_at)) + "ms, not floor_ms");

  /* ---- 4. The differential: 600ms passes, and granted_at moves with it ---- */

  await b.reset();
  const slow = record(b.db);
  const before = Date.now();
  const hold = await holdOf(slow.db, ["A:2"], { availability: slowSource });
  const wall = Date.now() - before;

  // now() is frozen at BEGIN. A server deriving granted_at from it would mint a
  // floor whose deadline had already lost the 600ms this transaction spent.
  const txStart = await b.db.query(
    "select to_json(granted_at)#>>\x27{}\x27 as granted_at from hold where hold_id = $1",
    [hold.hold_id],
  );
  const stamped = Date.parse(txStart.rows[0].granted_at);

  wall >= DELAY_MS
    ? ok("the transaction genuinely spent " + wall + "ms before its insert, at least " + DELAY_MS + " of it inside the transaction")
    : bad("the transaction only took " + wall + "ms; the delay was not injected");

  // The transaction began at most `wall` ms before it ended, and granted_at was
  // stamped after the sleep. If granted_at were transaction start it would sit
  // at least DELAY_MS earlier than the moment the call returned.
  const lag = Date.now() - stamped;
  lag < wall - DELAY_MS + 250
    ? ok("granted_at was stamped AFTER the " + DELAY_MS + "ms was spent (" + lag + "ms before the call returned), so it is not transaction start")
    : bad("granted_at is " + lag + "ms old on return: it looks like transaction start, not clock_timestamp()");

  const remaining = Date.parse(hold.floor_deadline) - Date.parse(hold.server_time);
  remaining > hold.floor_ms - 250
    ? ok("the agent receives " + remaining + "ms of runway against a floor of " + hold.floor_ms + "ms: the wait was not billed to the agent")
    : bad("the agent receives only " + remaining + "ms against a floor of " + hold.floor_ms + "ms — the wait was billed to the agent");

  /* ---- 5. Directly: clock_timestamp advances inside a transaction and now() does not */

  const witness = await b.db.transaction(async (tx) => {
    const a = await tx.query("select to_json(now())#>>\x27{}\x27 as t, to_json(clock_timestamp())#>>\x27{}\x27 as c");
    await tx.query("select pg_sleep($1::float8)", [DELAY_MS / 1000]);
    const z = await tx.query("select to_json(now())#>>\x27{}\x27 as t, to_json(clock_timestamp())#>>\x27{}\x27 as c");
    return { nowMoved: Date.parse(z.rows[0].t) - Date.parse(a.rows[0].t), clockMoved: Date.parse(z.rows[0].c) - Date.parse(a.rows[0].c) };
  });
  witness.nowMoved === 0 && witness.clockMoved >= DELAY_MS - 50
    ? ok("in this store now() did not move across " + DELAY_MS + "ms and clock_timestamp() moved " + witness.clockMoved + "ms: the two clocks are genuinely different")
    : bad("now() moved " + witness.nowMoved + "ms and clock_timestamp() moved " + witness.clockMoved + "ms");

  /* ---- 6. The same assertion, with the time spent in a REAL lock wait ----- */

  if (!process.env.CHANGEOVER_PG_URL) {
    console.log("note — the 600ms above was spent in pg_sleep, not in a lock wait, because PGlite is");
    console.log("       single-connection and no second caller can hold a lock against it. The rule under");
    console.log("       test does not care what consumed the time, so the assertion above stands; the");
    console.log("       lock-wait rehearsal of it needs:");
    console.log("         docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18");
    console.log("         export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover");
    console.log("         bash scripts/prove_grant_clock.sh");
  } else {
    const { requireConcurrentDb } = await import("./packages/store/src/db.ts");
    const db = await requireConcurrentDb();
    try {
      await b.reset();
      const seat = "A:3";
      const blocker = db.transaction(async (tx) => {
        await tx.query(SEAT_LOCK_SQL, [HOUSE, seat]);
        await tx.query("select pg_sleep($1::float8)", [DELAY_MS / 1000]);
      });
      await db.query("select pg_sleep(0.05)");
      const started = Date.now();
      const waited = await holdSeats(
        db,
        { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE), sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) }, seats: [seat], requested_floor_ms: 120000 },
        AGENT,
      );
      await blocker;
      const elapsed = Date.now() - started;
      const runway = Date.parse(waited.floor_deadline) - Date.parse(waited.server_time);
      elapsed >= DELAY_MS / 2 && runway > waited.floor_ms - 250
        ? ok("after " + elapsed + "ms of REAL lock waiting the agent still receives " + runway + "ms against a " + waited.floor_ms + "ms floor")
        : bad("after " + elapsed + "ms of real lock waiting the agent receives only " + runway + "ms against a " + waited.floor_ms + "ms floor");
    } finally {
      await db.close();
    }
  }
} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err));
} finally {
  await b.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
