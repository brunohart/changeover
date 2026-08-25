#!/usr/bin/env bash
# C-IDEMPOTENT, I6. CORE-005.
#
# The half of I6 that scripts/prove_idempotent.sh cannot reach: two callers
# arriving on one Idempotency-Key **at the same time**, separated by the primary
# key rather than by a read.
#
# The sequential version — commit the in-flight marker, then call again — is a
# real assertion and it is made in the sibling script. It is not this one. What
# is only observable with two connections is that the separation is done by the
# database: two INSERTs racing for `idempotency_scope`, one winning, the other
# taking the conflict branch. On one connection the second call cannot even be
# in the air while the first is, so a pass would be a statement about ordering
# and not about contention, and I6 is entirely about contention — it is the rule
# that stops a retry becoming a double-book.
#
# PGlite is PostgreSQL 18.3 compiled to wasm, single-connection and in-process.
# It cannot host this. So without CHANGEOVER_PG_URL this exits 2, and it never
# exits 0 on a simulation.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

[ -f packages/core/src/idempotency.ts ] || { echo "cannot prove — packages/core/src/idempotency.ts missing (CORE-005)"; exit 2; }
[ -f packages/core/src/hold-seats.ts ]  || { echo "cannot prove — packages/core/src/hold-seats.ts missing (CORE-002)"; exit 2; }
[ -d node_modules/pg ]                  || { echo "cannot prove — node-postgres not installed; run npm install at the repository root"; exit 2; }

if [ -z "${CHANGEOVER_PG_URL:-}" ]; then
  echo "cannot prove — I6 needs true concurrency, and PGlite is single-connection and in-process:"
  echo "                two callers cannot race one idempotency key there, so a pass would mean nothing."
  echo "  to make it provable:"
  echo "    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18"
  echo "    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover"
  echo "    bash scripts/prove_idempotent_race.sh"
  exit 2
fi

node --input-type=module -e '
import { isRefusal, REFUSAL_STATUS } from "@changeover/schema/refusal.ts";
import { holdSeats } from "./packages/core/src/hold-seats.ts";
import { holdSeatsDigest, withIdempotency } from "./packages/core/src/idempotency.ts";
import { bench, etagFor, occasion } from "./packages/core/test/lib/estate.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const remedy = () => {
  console.log("  to make it provable:");
  console.log("    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18");
  console.log("    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover");
  console.log("    bash scripts/prove_idempotent_race.sh");
};

// A fresh Occasion per run, so a second run neither collides with the first nor
// inherits its rows. node-postgres builds its pool lazily, so everything up to
// and including the first query is "could not reach the server" and is a 2.
const OCCASION = "occ_race_" + Date.now().toString(36);
let b;
try {
  b = await bench([occasion({ occasion_id: OCCASION, capacity: 40 })]);
} catch (err) {
  console.log("cannot prove — the store at CHANGEOVER_PG_URL did not answer: " + String(err && err.message ? err.message : err));
  remedy();
  process.exit(2);
}

if (b.db.driver !== "pg" || b.db.concurrent !== true) {
  console.log("cannot prove — CHANGEOVER_PG_URL is set but openDb returned the " + b.db.driver + " driver, concurrent=" + b.db.concurrent);
  await b.close();
  process.exit(2);
}

const AGENT = "agt_core005race";
const SCOPE = "principal_race";
const CREDENTIAL = { agent_id: AGENT, principal_scope: SCOPE };
const KEY = "01K3RACE" + Date.now().toString(36).toUpperCase().padEnd(18, "0");
const request = {
  occasion_id: OCCASION,
  occasion_etag: etagFor(OCCASION),
  sought: { occasion_id: OCCASION, occasion_etag: etagFor(OCCASION) },
  seats: ["A:1", "A:2"],
  requested_floor_ms: 120000,
};
const scope = { agent_id: AGENT, principal_scope: SCOPE, verb: "hold_seats", idempotency_key: KEY };
const digest = holdSeatsDigest(request);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  ok("the store at CHANGEOVER_PG_URL is node-postgres and reports concurrent=true");

  const marks = {};
  // A holds the key for 1500ms. B arrives 200ms in — genuinely inside As window,
  // on a second pooled connection, with neither call having finished.
  const a = withIdempotency(b.db, scope, digest, async () => {
    marks.a_started = Date.now();
    await sleep(1500);
    const held = await holdSeats(b.db, request, CREDENTIAL);
    marks.a_finished = Date.now();
    return held;
  });

  await sleep(200);
  let refusal = null;
  let second = null;
  try {
    second = await withIdempotency(b.db, scope, digest, () => holdSeats(b.db, request, CREDENTIAL));
  } catch (err) {
    refusal = err;
    marks.b_refused = Date.now();
  }
  const first = await a;

  const code = isRefusal(refusal) ? refusal.code : null;
  code === "idempotency_in_flight" && REFUSAL_STATUS.idempotency_in_flight === 409
    ? ok("I6 — a second caller arriving on an in-flight key is refused 409 idempotency_in_flight")
    : bad("I6 — expected 409 idempotency_in_flight and got " + (code ?? String(second && second.disposition)));

  isRefusal(refusal) && Number.isInteger(refusal.retry_after_ms) && refusal.retry_after_ms > 0 && refusal.remediation === "retry_same_key"
    ? ok("I6 — it carries retry_after_ms " + refusal.retry_after_ms + " and remediation retry_same_key")
    : bad("I6 — the in-flight refusal carried no usable retry_after_ms or the wrong remediation");

  marks.b_refused > marks.a_started && marks.b_refused < marks.a_finished
    ? ok("the refusal landed strictly inside the first callers window, so this was contention and not a sequence")
    : bad("the two calls did not overlap: a_started=" + marks.a_started + " b_refused=" + marks.b_refused + " a_finished=" + marks.a_finished);

  first.disposition === "executed"
    ? ok("the caller that took the key completed and stored its record")
    : bad("the first caller was " + first.disposition + " rather than an execution");

  const held = await b.db.query("select count(*)::text as n from hold where occasion_id = $1", [OCCASION]);
  Number(held.rows[0].n) === 1
    ? ok("exactly one Hold exists: the refused retry did not become a second grant")
    : bad("the store holds " + held.rows[0].n + " Holds for this Occasion — the retry double-booked");

  const retry = await withIdempotency(b.db, scope, digest, () => { throw new Error("I8: the verb must not run on a replay"); });
  retry.disposition === "replayed" && retry.record.hold_id === first.record.hold_id
    ? ok("retrying the same key after the holder finished replays the first callers Hold, per I6 and I4")
    : bad("the same-key retry did not replay the first callers Hold");
} finally {
  await b.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
