#!/usr/bin/env bash
# C-CLAIM / CORE-004, the concurrency half. R3: the claim transaction MUST take
# an exclusive lock on the Hold and re-read its state inside that transaction.
#
# The cheaper check — "two confirms in a row, and the second is claim_consumed"
# — is already asserted by prove_claim_prefetch_safe.sh and it does not test R3
# at all. Sequentially, the second confirm reads a row the first has already
# committed and any implementation refuses it. R3 exists for the case where the
# two confirms OVERLAP: a customer double-clicking, a browser retrying a POST, a
# link opened at once on a phone and a laptop. Without the lock both transactions
# read `handed_off`, both decide to claim, and one customer gets a receipt for
# seats that were never theirs.
#
# WHY THIS SCRIPT PRINTS ok LINES AND THEN EXITS 2 WITHOUT A POSTGRES.
# R3 has two halves. WHICH statement is issued, in WHAT order, and whether the
# lock clause is present at all is decided in-process and is observable on one
# connection: the assertions below record every statement the two claim paths
# send and read the order back. What one connection cannot show is that a second
# confirm BLOCKS on the lock the first holds — PGlite is single-connection and
# in-process, so mutual exclusion cannot occur there and a pass would mean
# nothing. That half needs CHANGEOVER_PG_URL. The lines already proven are
# printed either way, because discarding real evidence is not honesty either.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/claim.ts ]        || { echo "cannot prove — packages/core/src/claim.ts missing (CORE-004)"; exit 2; }
[ -f packages/core/src/hand-off.ts ]     || { echo "cannot prove — packages/core/src/hand-off.ts missing (CORE-004)"; exit 2; }
[ -f packages/core/test/lib/hold-fixtures.ts ] || { echo "cannot prove — packages/core/test/lib/hold-fixtures.ts missing (CORE-003)"; exit 2; }

node --input-type=module -e '
import { requireConcurrentDb, CannotProve, EXIT_CANNOT_PROVE } from "./packages/store/src/db.ts";
import { bench, holdIdFor, house, mintHold } from "./packages/core/test/lib/hold-fixtures.ts";
import { HOLD_STATE } from "./packages/core/src/derived.ts";
import { getHold } from "./packages/core/src/get-hold.ts";
import { handOff } from "./packages/core/src/hand-off.ts";
import { confirmClaim, parseClaimUrl, renderClaim } from "./packages/core/src/claim.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const ORIGIN = "https://reference.example";
const CREDENTIAL = { agent_id: "agt_reference", principal_scope: "site_wellington" };
const VENUE = { ...house(), document: { book_url: ORIGIN + "/book/embassy" } };

/**
 * A Db that records every statement it is asked for, and every transaction it
 * opens with the options it was opened with. Nothing is intercepted or altered;
 * the recorder is a tee, so what the assertions read is what the store ran.
 */
function recording(db) {
  const log = [];
  const tee = (q) => ({
    query: (sql, params) => { log.push({ kind: "query", sql, params }); return q.query(sql, params); },
    exec: (sql) => { log.push({ kind: "exec", sql }); return q.exec(sql); },
  });
  return {
    log,
    db: {
      ...tee(db),
      driver: db.driver,
      concurrent: db.concurrent,
      transaction: (fn, options) => {
        log.push({ kind: "begin", sql: "BEGIN", options });
        return db.transaction((tx) => fn(tee(tx)), options);
      },
      close: () => db.close(),
    },
  };
}

const WRITES = /^\s*(insert|update|delete|truncate|copy)\b/i;
const index = (log, re) => log.findIndex((s) => typeof s.sql === "string" && re.test(s.sql));

const b = await bench([VENUE]);
try {
  const minted = await mintHold(b.db, { occasion: VENUE, hold_id: holdIdFor("race"), state: HOLD_STATE.live });
  const read = await getHold(b.db, minted.hold_id, CREDENTIAL);
  const handed = await handOff(b.db, { hold_id: minted.hold_id, read_token: read.read_token }, CREDENTIAL);
  const presented = parseClaimUrl(handed.hold.handoff.claim_url);

  /* ---- 1. The GET issues no write statement, at all --------------------- */

  const render = recording(b.db);
  await renderClaim(render.db, presented);
  const render_begin = render.log.find((s) => s.kind === "begin");
  const render_writes = render.log.filter((s) => typeof s.sql === "string" && WRITES.test(s.sql));

  render_begin && render_begin.options && render_begin.options.readOnly === true
    ? ok("CL2 — the GET opens its transaction with readOnly: true, so the store itself would refuse a write on that path")
    : bad("the GET did not open a read-only transaction: " + JSON.stringify(render_begin));

  render_writes.length === 0
    ? ok("CL2 — the GET sent " + render.log.length + " statements and not one of them was an insert, update or delete")
    : bad("the GET sent a write: " + render_writes.map((s) => s.sql).join(" | "));

  render.log.some((s) => typeof s.sql === "string" && /for\s+update/i.test(s.sql))
    ? bad("the GET took a row lock, which is a write intention on a path CL2 requires be prefetch-safe")
    : ok("CL2 — the GET takes no row lock either: a link scanner does not queue behind a customer mid-checkout");

  /* ---- 2. The confirm locks the Hold, then reads state inside the lock --- */

  const confirm = recording(b.db);
  const outcome = await confirmClaim(confirm.db, presented, { binding_ref: "sess_first_touch" });
  outcome.ok === true
    ? ok("the recorded confirm is a real one: it claimed the Hold")
    : bad("the recorded confirm did not claim: " + JSON.stringify(outcome).slice(0, 160));

  const lock_at = index(confirm.log, /from\s+hold\s+where\s+hold_id\s*=\s*\$1\s+for\s+update/i);
  const claim_at = index(confirm.log, /update\s+hold\s+set\s+claimed_at/i);
  const seat_lock_at = index(confirm.log, /pg_advisory_xact_lock/i);
  const seat_write_at = index(confirm.log, /update\s+hold_seat\s+set\s+state/i);

  lock_at >= 0
    ? ok("R3 — the confirm loads the Hold FOR UPDATE: the exclusive lock is taken, not assumed")
    : bad("the confirm never issued a FOR UPDATE on hold");

  lock_at >= 0 && claim_at > lock_at
    ? ok("R3 — the state the transition is decided on is re-read inside that lock, and the write follows it")
    : bad("the claim write did not follow the lock: lock@" + lock_at + " claim@" + claim_at);

  seat_lock_at >= 0 && seat_write_at > seat_lock_at
    ? ok("L1 — the seat rows are locked before they are written, in the same order every other writer uses")
    : bad("the seat write did not follow a seat lock: lock@" + seat_lock_at + " write@" + seat_write_at);

  /* ---- 3. And the thing one connection cannot show ---------------------- */

  const db = await requireConcurrentDb();
  try {
    // A FRESH Hold for the race, and the reason is worth stating: section 2
    // above confirms `presented` in order to record the statements the confirm
    // issues, which CLAIMS it. Racing that same Hold would race a consumed
    // claim, both racers would correctly answer `claim_consumed`, and the
    // assertion below could never hold — the proof would report a product
    // failure that was its own setup error, which is worse than no proof at
    // all. Found on 2026-08-25, the first time this script ran against a real
    // multi-connection Postgres; it had never been reachable on PGlite.
    const contended = await mintHold(db, {
      occasion: VENUE,
      hold_id: holdIdFor("race-contended"),
      state: HOLD_STATE.live,
      // Distinct seats, because `hold_seat_occupied` is keyed on
      // (showtime_id, seat_id) and the Hold above already occupies the first
      // two at this showtime. Reusing them would raise 23505 from the index
      // rather than from the race — the constraint doing exactly its job, on
      // the wrong question.
      seats: VENUE.seats.slice(2, 4).map((seat) => seat.seat_id),
    });
    const contended_read = await getHold(db, contended.hold_id, CREDENTIAL);
    const contended_handed = await handOff(
      db,
      { hold_id: contended.hold_id, read_token: contended_read.read_token },
      CREDENTIAL,
    );
    const contested = parseClaimUrl(contended_handed.hold.handoff.claim_url);

    // Two real backends confirming the same claim at once. Exactly one may end
    // in `claimed`; the other must be 409 claim_consumed, and the store must
    // carry one claimed_at rather than two.
    const both = await Promise.all([
      confirmClaim(db, contested, { binding_ref: "sess_phone" }),
      confirmClaim(db, contested, { binding_ref: "sess_laptop" }),
    ]);
    const winners = both.filter((o) => o.ok === true).length;
    const consumed = both.filter((o) => o.ok === false && o.code === "claim_consumed").length;
    winners === 1 && consumed === 1
      ? ok("R3 — two simultaneous confirms, one claim: the second blocked on the lock and then found the Hold already claimed")
      : bad("two simultaneous confirms produced " + winners + " winners and " + consumed + " claim_consumed");
  } finally {
    await db.close();
  }
} catch (err) {
  if (err instanceof CannotProve) {
    console.log("cannot prove — R3 needs true concurrency, and PGlite is single-connection and in-process:");
    console.log("                two confirms cannot overlap there, so a pass would mean nothing.");
    console.log("  to make it provable:");
    console.log("    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18");
    console.log("    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover");
    console.log("    bash scripts/prove_claim_confirm_race.sh");
    console.log(`PASS=${fail ? 0 : pass}`);
    await b.close();
    // 1 beats 2. Sections 1 and 2 are six sequential CL2/R3 assertions that run
    // on EVERY substrate, and `bad()` sets `fail` without throwing. Exiting 2
    // unguarded here would file every one of those failures as "cannot prove"
    // on the one path CI actually takes, because CHANGEOVER_PG_URL is unset
    // there on every single run.
    process.exit(fail ? 1 : EXIT_CANNOT_PROVE);
  }
  bad("unexpected — " + (err && err.message ? err.message : String(err)));
} finally {
  await b.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
