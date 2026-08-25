#!/usr/bin/env bash
# CORE-003 · M1, M2, M3. The Hold has no `state` column, a Hold past its
# deadline reports `expired` with nothing having reaped it, and `seats` is the
# grant in every state including after a reap.
#
# The cheaper check — call get_hold on an expired Hold and read the answer —
# would not have caught any of it. A stored `state` column written correctly at
# grant returns the right answer for as long as nobody contends the seats, and
# under ADR-006 nobody ever does: no sweeper runs, so an abandoned Hold reports
# `live` forever and the budget it holds never comes back. So this asserts the
# ABSENCE of the column against information_schema, and asserts that the read
# path never calls a reaper, by grepping the modules for the call rather than by
# trusting a configuration flag that a deployment could flip.
#
# Single-connection is sufficient here and that is not a concession: every rule
# under test is a property of one read of one row. Nothing in M1, M2 or the
# get_hold path depends on two callers racing, so PGlite proves it exactly.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ]        || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/derived.ts ]             || { echo "cannot prove — packages/core/src/derived.ts missing"; exit 2; }
[ -f packages/core/src/get-hold.ts ]            || { echo "cannot prove — packages/core/src/get-hold.ts missing"; exit 2; }
[ -f packages/core/test/lib/hold-fixtures.ts ]  || { echo "cannot prove — packages/core/test/lib/hold-fixtures.ts missing"; exit 2; }
[ -d packages/store/src/migrations ]            || { echo "cannot prove — packages/store/src/migrations/ missing"; exit 2; }

# --- the read path calls no reaper. Absence of a CALL, not of a config. ------
# grep -l lists files that match; an empty result is what must hold. reap.ts is
# CORE-002's and may not exist yet, which is why the pattern is the call and not
# the file.
REAPERS=$(grep -lE "reap\(|reapSeats|from \"\./reap\.ts\"" packages/core/src/derived.ts packages/core/src/get-hold.ts packages/core/src/read-token.ts 2>/dev/null)
if [ -n "$REAPERS" ]; then
  echo "FAIL — the read path calls a reaper: $REAPERS"
  echo "PASS=0"
  exit 1
fi
echo "ok — no module on the get_hold read path calls a reaper at all"

node --input-type=module -e '
import { openDb } from "./packages/store/src/db.ts";
import { migrate } from "./packages/store/src/migrate.ts";
import { seedEstate } from "./packages/store/src/fixtures.ts";
import { HOLD_STATE, deriveState, derivedStateSql } from "./packages/core/src/derived.ts";
import { getHold } from "./packages/core/src/get-hold.ts";
import { EVERY_STATE, house, mintHold } from "./packages/core/test/lib/hold-fixtures.ts";

let fail = 0, pass = 1;   // the reaper-absence check above already held
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const CREDENTIAL = { agent_id: "agt_reference", principal_scope: "site_wellington" };

const db = await openDb();
try {
  await migrate(db);
  const seed = house();
  await seedEstate(db, { name: "core-003-proof", occasions: [seed] });

  /* 1 · M1 — the column is not there, and its inputs are. ------------------ */
  const columns = await db.query(
    "select column_name from information_schema.columns where table_schema = $1 and table_name = $2",
    ["public", "hold"],
  );
  const names = new Set(columns.rows.map((r) => r.column_name));
  names.has("state")
    ? bad("the hold table carries a state column, so a stored state is representable")
    : ok("information_schema shows no state column on hold");

  const inputs = ["expires_at", "claim_expires_at", "handed_off_at", "released_at", "claimed_at", "revoked_at"];
  const missing = inputs.filter((c) => !names.has(c));
  missing.length === 0
    ? ok("every input M1 derives from is a column on hold: " + inputs.join(", "))
    : bad("M1 cannot be derived — these columns are absent: " + missing.join(", "));

  /* 2 · A Hold past expires_at, with nothing having reaped it. ------------- */
  const expired = await mintHold(db, { state: HOLD_STATE.expired, occasion: seed, seats: ["A:1", "A:2"] });

  const beforeRead = await db.query(
    "select seat_id, state from hold_seat where hold_id = $1 order by seat_id", [expired.hold_id]);
  const stillLive = beforeRead.rows.length === expired.seats.length
    && beforeRead.rows.every((r) => r.state === "live");
  stillLive
    ? ok("the expired Hold still has every seat row, and every one of them still says live")
    : bad("the fixture had already been reaped, so the assertion below would prove nothing");

  const document = await getHold(db, expired.hold_id, CREDENTIAL);
  document.state === HOLD_STATE.expired
    ? ok("a Hold past expires_at reports expired, with no reaper having run")
    : bad("a Hold past expires_at reported " + document.state);

  const afterRead = await db.query(
    "select seat_id, state from hold_seat where hold_id = $1 order by seat_id", [expired.hold_id]);
  const untouched = afterRead.rows.length === beforeRead.rows.length
    && afterRead.rows.every((r, i) => r.state === beforeRead.rows[i].state);
  untouched
    ? ok("and the read reaped nothing itself — the same rows, in the same states, afterwards")
    : bad("the read mutated hold_seat, so the expired answer came from a reap and not from M1");

  /* 3 · M2 — seats are the grant, in every state and after a reap. --------- */
  for (const state of EVERY_STATE) {
    for (const reaped of [false, true]) {
      await db.query("delete from hold");
      const minted = await mintHold(db, { state, reaped, occasion: seed, seats: ["A:1", "A:2"] });
      const rows = await db.query("select seat_id from hold_seat where hold_id = $1", [minted.hold_id]);
      if (reaped && rows.rows.length !== 0) {
        bad("the reaped fixture left seat rows behind, so the M2 assertion below is not testing M2");
        continue;
      }
      const read = await getHold(db, minted.hold_id, CREDENTIAL);
      const same = read.seats.length === minted.seats.length
        && read.seats.every((s, i) => s === minted.seats[i]);
      const where = state + (reaped ? ", after a reap" : "");
      same && read.seats.length >= 1
        ? ok("seats reports the grant in " + where)
        : bad("seats was " + JSON.stringify(read.seats) + " in " + where);
    }
  }

  /* 4 · M3 — the SQL derivation is the same derivation. -------------------- */
  await db.query("delete from hold");
  const expect = new Map();
  let index = 0;
  for (const state of EVERY_STATE) {
    const seats = seed.seats.slice(index * 2, index * 2 + 2).map((s) => s.seat_id);
    const minted = await mintHold(db, { state, occasion: seed, seats });
    expect.set(minted.hold_id, state);
    index++;
  }
  const derived = await db.query("select hold_id, " + derivedStateSql("hold") + " as sql_state from hold");
  const disagreed = derived.rows.filter((r) => r.sql_state !== expect.get(r.hold_id));
  derived.rows.length === expect.size && disagreed.length === 0
    ? ok("the SQL derivation agrees with deriveState on all six states, row for row")
    : bad("the SQL derivation disagreed on " + disagreed.length + " of " + derived.rows.length + " rows");

  const counted = await db.query(
    "select count(*)::text as n from hold where (" + derivedStateSql("hold") + ") = $1", ["live"]);
  Number(counted.rows[0].n) === 1
    ? ok("a budget count over derived state counts one live Hold, not the five that are not")
    : bad("a budget count over derived state counted " + counted.rows[0].n + " live Holds where one is live");

  /* 5 · The cue marks. A read reports them and moves neither. -------------- */
  await db.query("delete from hold");
  const live = await mintHold(db, { state: HOLD_STATE.live, occasion: seed, seats: ["A:1", "A:2"] });
  const first = await getHold(db, live.hold_id, CREDENTIAL);
  const second = await getHold(db, live.hold_id, CREDENTIAL);
  second.floor_deadline === first.floor_deadline
    ? ok("floor_deadline is identical across two reads — T3, immovable by any mechanism")
    : bad("floor_deadline moved between two reads");
  second.expires_at === first.expires_at
    ? ok("expires_at is reported as it stands and a read does not extend it")
    : bad("a read moved expires_at from " + first.expires_at + " to " + second.expires_at);
  typeof second.read_token === "string" && second.read_token.length >= 22
    ? ok("get_hold returns a read_token, so T4 is a mechanism rather than a request")
    : bad("get_hold returned no read_token");
  deriveState(live, first.server_time);   // the pure function is reachable from a proof
} catch (err) {
  bad("unexpected: " + String(err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err));
} finally {
  await db.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
