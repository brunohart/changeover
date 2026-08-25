#!/usr/bin/env bash
# C-ATOMIC / CORE-002. L1: an exclusive lock per (showtime_id, seat_id), in
# ascending byte order of seat_id under the C collation, over the FULL requested
# seat set, irrespective of whether a hold row exists, in the same transaction
# as the insert.
#
# The cheaper check — "the transaction sorted the seats it locked" — is exactly
# what SPEC.md §4.6 says is not enough: "the reap can only lock rows that exist
# and are doomed at its own start, and a free seat has no row, so two
# transactions over one seat set compute different lock sequences and deadlock
# across an expiry boundary while obeying the rule exactly." So the assertion
# that matters is over the FULL set, with rows present and with rows absent, and
# it compares the two sequences byte for byte.
#
# WHY THIS SCRIPT PRINTS ok LINES AND THEN EXITS 2 WITHOUT A POSTGRES.
# L1 has two halves. Everything about WHICH locks are taken and in WHAT ORDER is
# decided in-process before any SQL is sent, so it is observable on one
# connection and is asserted below — including a pg_locks capture confirming the
# locks are really held, and a C-collation cross-check against Postgres own
# ORDER BY. What one connection cannot show is that a second caller BLOCKS on
# those locks: PGlite is single-connection and in-process, so mutual exclusion
# and 40P01 cannot occur there and a pass would mean nothing. That half needs
# CHANGEOVER_PG_URL, and until it has one this script exits 2 rather than
# claiming L1 whole. The lines it did prove are printed either way, because
# discarding real evidence is not honesty either.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

[ -d node_modules/@electric-sql/pglite ]  || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/locking.ts ]       || { echo "cannot prove — packages/core/src/locking.ts missing"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]    || { echo "cannot prove — packages/core/src/hold-seats.ts missing"; exit 2; }

node --input-type=module -e '
import { requireConcurrentDb, CannotProve, EXIT_CANNOT_PROVE } from "./packages/store/src/db.ts";
import { SEAT_LOCK_SQL, sortCSeats } from "./packages/core/src/locking.ts";
import { holdSeats } from "./packages/core/src/hold-seats.ts";
import { bench, etagFor, occasion, record } from "./packages/core/test/lib/estate.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const AGENT = { agent_id: "agt_reference", principal_scope: "ps_household_1" };
const OTHER = { agent_id: "agt_reference", principal_scope: "ps_household_2" };
const HOUSE = "occ_house";

// Deliberately adversarial: A:10 sorts BEFORE A:2 under C and AFTER it under
// most locales, which is the divergence that deadlocks two nodes with different
// lc_collate against each other. B:1 and a lower-case row exercise the byte
// order above and below the ASCII letter block.
const REQUESTED = ["A:2", "A:10", "B:1", "A:9", "A:1"];

const b = await bench([occasion({ occasion_id: HOUSE, capacity: 40 })]);

const lockParams = (statements) =>
  statements.filter((s) => s.sql === SEAT_LOCK_SQL).map((s) => [s.params[0], s.params[1]]);

const holdOf = async (db, seats, credential) =>
  holdSeats(
    db,
    {
      occasion_id: HOUSE,
      occasion_etag: etagFor(HOUSE),
      sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) },
      seats,
      requested_floor_ms: 120000,
    },
    credential,
  );

try {
  /* ---- 1. C collation, checked against Postgres own ORDER BY -------------- */

  // compareC is Buffer.compare over UTF-8, which is what COLLATE "C" means.
  // Array.sort() compares UTF-16 code units and disagrees above the BMP, so the
  // oracle here is the database itself rather than another JavaScript sort.
  const messy = [...REQUESTED, "a:1", "A:100", "AA:1", "Z:9", "A:2a"];
  const oracle = await b.db.query(
    "select s from unnest($1::text[]) as s order by s collate \"C\"",
    [messy],
  );
  const fromPostgres = oracle.rows.map((r) => r.s);
  const fromCompareC = sortCSeats(messy);
  JSON.stringify(fromPostgres) === JSON.stringify(fromCompareC)
    ? ok("compareC reproduces Postgres own ORDER BY ... COLLATE \"C\" over an adversarial seat set")
    : bad("compareC disagrees with COLLATE \"C\"\n    postgres: " + fromPostgres.join(" ") + "\n    compareC: " + fromCompareC.join(" "));

  fromCompareC.indexOf("A:10") < fromCompareC.indexOf("A:2")
    ? ok("A:10 sorts before A:2, which is byte order and is not what most locales do")
    : bad("A:10 did not sort before A:2 — this is not the C collation");

  /* ---- 2. The full set, in order, when NO row exists for any seat --------- */

  await b.reset();
  const empty = record(b.db);
  const first = await holdOf(empty.db, REQUESTED, AGENT);
  const emptyLocks = lockParams(empty.statements);

  const expected = sortCSeats(REQUESTED);
  JSON.stringify(emptyLocks.map((p) => p[1])) === JSON.stringify(expected)
    ? ok("with no hold row in existence, all five requested seats are locked, in ascending C order")
    : bad("lock sequence over a free house was " + JSON.stringify(emptyLocks.map((p) => p[1])) + ", expected " + JSON.stringify(expected));

  emptyLocks.every((p) => p[0] === HOUSE)
    ? ok("every lock is keyed on (showtime_id, seat_id) — the physical screening, not the listing")
    : bad("a lock was keyed on something other than the showtime");

  emptyLocks.length === REQUESTED.length
    ? ok("exactly one lock per requested seat: no early return, and no only_contended path to shorten the sequence")
    : bad("took " + emptyLocks.length + " locks for " + REQUESTED.length + " seats");

  /* ---- 3. The same sequence when rows DO exist, and across an expiry ------ */

  // Age the granted hold so its seats are doomed at the next transaction s
  // start. This is the boundary the rule exists for: a lazily-locking server
  // computes one sequence over the rows that exist and another over the rows
  // that are about to stop existing, and the two deadlock against each other.
  await b.db.query(
    "update hold set granted_at = granted_at - interval \x2710 minutes\x27, floor_deadline = floor_deadline - interval \x2710 minutes\x27, expires_at = expires_at - interval \x2710 minutes\x27 where hold_id = $1",
    [first.hold_id],
  );
  await b.db.query("update hold_seat set held_until = held_until - interval \x2710 minutes\x27 where hold_id = $1", [first.hold_id]);

  const aged = record(b.db);
  await holdOf(aged.db, REQUESTED, OTHER);
  const agedLocks = lockParams(aged.statements);

  JSON.stringify(agedLocks) === JSON.stringify(emptyLocks)
    ? ok("with a row for every seat, expiring, the lock sequence is byte-identical to the free-house one")
    : bad("the lock sequence changed when rows existed: " + JSON.stringify(agedLocks.map((p) => p[1])));

  /* ---- 4. Locks precede the reap and the insert, in the same transaction -- */

  const order = aged.statements.map((s, i) => ({ i, sql: s.sql }));
  const lastLock = Math.max(...order.filter((s) => s.sql === SEAT_LOCK_SQL).map((s) => s.i));
  const firstReap = order.find((s) => /delete\s+from\s+hold_seat/i.test(s.sql));
  const firstInsert = order.find((s) => /insert\s+into\s+hold\b/i.test(s.sql));

  firstReap && lastLock < firstReap.i
    ? ok("every lock is taken before the reap runs — L1 is before ANY reap, not before the contended ones")
    : bad("the reap ran before the last lock was taken");

  firstInsert && lastLock < firstInsert.i
    ? ok("every lock is taken before the grant is inserted, in the same transaction as it")
    : bad("the insert ran before the last lock was taken");

  /* ---- 5. pg_locks: the locks are not merely requested, they are held ----- */

  // pg_advisory_xact_lock(bigint) splits its key across (classid, objid) as the
  // high and low 32 bits. Reconstructing it is what lets this assert the SET of
  // locks actually held, including for seats that have no row to lock — which
  // is the clause of L1 that a FOR UPDATE implementation silently fails.
  await b.reset();
  const seats = sortCSeats(REQUESTED);
  const held = await b.db.transaction(async (tx) => {
    for (const seat_id of seats) await tx.query(SEAT_LOCK_SQL, [HOUSE, seat_id]);
    const locks = await tx.query(
      "select classid, objid, mode, granted from pg_locks where locktype = \x27advisory\x27",
    );
    const keys = await tx.query(
      "select s, hashtextextended($1 || \x27:\x27 || s, 0) as key from unnest($2::text[]) as s",
      [HOUSE, seats],
    );
    return { locks: locks.rows, keys: keys.rows };
  });

  if (held.locks.length === 0) {
    console.log("cannot prove — pg_locks reported no advisory lock, so nothing about L1 can be observed here");
    console.log("  to make it provable:");
    console.log("    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover");
    await b.close();
    process.exit(EXIT_CANNOT_PROVE);
  }

  // pg_advisory_xact_lock(bigint) splits the key: classid is the high 32 bits,
  // objid the low. Reassembling in JS rather than in SQL because the product
  // overflows bigint before the addition wraps it back into range.
  const norm = (v) => BigInt.asIntN(64, BigInt(v)).toString();
  const rejoin = (classid, objid) => norm((BigInt(classid) << 32n) | BigInt(objid));
  const heldKeys = new Set(held.locks.map((r) => rejoin(r.classid, r.objid)));
  const wanted = held.keys.map((r) => ({ seat: r.s, key: norm(r.key) }));
  const missing = wanted.filter((w) => !heldKeys.has(w.key));

  missing.length === 0
    ? ok("pg_locks confirms an advisory lock is HELD for every one of the five seats, none of which has a row")
    : bad("pg_locks shows no lock for " + missing.map((m) => m.seat).join(", "));

  held.locks.every((r) => r.mode === "ExclusiveLock" && r.granted === true)
    ? ok("every one of them is an ExclusiveLock and is granted, not merely awaited")
    : bad("a held advisory lock was not a granted ExclusiveLock");

  /* ---- 6. And the thing one connection cannot show --------------------- */

  const db = await requireConcurrentDb();
  try {
    // Two real connections. The second must BLOCK on a lock the first holds,
    // and pg_locks must show it waiting rather than granted. Only a server with
    // more than one backend can exhibit this at all.
    const seat = seats[0];
    const holder = db.transaction(async (tx) => {
      await tx.query(SEAT_LOCK_SQL, [HOUSE, seat]);
      await tx.query("select pg_sleep(1.5)");
      return "released";
    });
    await db.query("select pg_sleep(0.2)");
    const started = Date.now();
    const waiter = db.transaction(async (tx) => {
      await tx.query(SEAT_LOCK_SQL, [HOUSE, seat]);
      return Date.now() - started;
    });
    const waited = await waiter;
    await holder;
    waited > 500
      ? ok("a second connection blocked " + waited + "ms on the lock the first held: the exclusion is real")
      : bad("a second connection acquired the same seat lock after only " + waited + "ms");
  } finally {
    await db.close();
  }
} catch (err) {
  if (err instanceof CannotProve) {
    console.log("cannot prove — " + err.message);
    console.log("  to make it provable:\n" + err.remedy.split("\n").map((l) => "    " + l).join("\n"));
    console.log("    bash scripts/prove_lock_order.sh");
    await b.close();
    process.exit(EXIT_CANNOT_PROVE);
  }
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err));
} finally {
  await b.close().catch(() => {});
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
