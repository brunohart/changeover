#!/usr/bin/env bash
# C-IDEMPOTENT, across bindings. I3: "In MCP, D is projected from the
# tool-arguments object by the same rule, so a call is digest-identical across
# bindings." This asserts that by issuing the SAME logical hold_seats over the
# HTTP binding and over the MCP binding, for real, and comparing the
# request_digest each one WROTE TO ITS OWN STORE.
#
# The obvious cheaper check is to call holdSeatsDigest() twice and compare. That
# proves a pure function is deterministic, which nobody doubted, and it would
# pass unchanged on the day the MCP binding started digesting its whole
# arguments object — which is the exact defect I3 and I7 exist to prevent, and
# whose symptom is a 422 idempotency_key_reused returned to a customer who has
# just answered the human gate. So neither digest below is computed here: both
# are SELECTed out of the idempotency table each binding wrote.
#
# The two calls are deliberately NOT byte-identical on the wire. The seat array
# arrives in opposite order, only one side sends an intent_digest, and the two
# idempotency keys differ — because I3 excludes the key and intent_digest from D
# and sorts the seats. A parity proof over two identical payloads would hold for
# a binding that digested the raw body.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/@modelcontextprotocol/sdk ] || { echo "cannot prove — @modelcontextprotocol/sdk not installed; run npm install at the repository root"; exit 2; }
[ -f packages/mcp/src/server.ts ] || { echo "cannot prove — packages/mcp/src/server.ts missing"; exit 2; }
[ -f packages/http/src/server.ts ] || { echo "cannot prove — packages/http/src/server.ts missing; BIND-002's parity gate needs a live HTTP binding to compare against"; exit 2; }
[ -f packages/http/test/lib/http-bench.ts ] || { echo "cannot prove — packages/http/test/lib/http-bench.ts missing; both benches publish their estate from it"; exit 2; }
[ -f packages/mcp/test/lib/mcp-bench.ts ] || { echo "cannot prove — packages/mcp/test/lib/mcp-bench.ts missing"; exit 2; }

node --input-type=module -e '
import { AGENT_TOKEN, call, holdBody, httpBench, key as httpKey }
  from "./packages/http/test/lib/http-bench.ts";
import { callTool, holdArgs, key as mcpKey, mcpBench }
  from "./packages/mcp/test/lib/mcp-bench.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };
const is  = (actual, expected, m) =>
  actual === expected ? ok(m) : bad(m + " (expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual) + ")");

// The digest as the binding stored it. Never as this script computed it.
const storedDigest = async (db, verb) => {
  const r = await db.query(
    "select request_digest, idempotency_key_hmac from idempotency where verb = $1 order by created_at",
    [verb],
  );
  return r.rows;
};

const http = await httpBench();
const mcp  = await mcpBench();

/**
 * Do these two handles reach the same physical cluster?
 *
 * Asked by holding a transaction-scoped advisory lock on one and trying for the
 * same lock on the other, rather than by reading db.driver — the question is
 * whether the two benches share STATE, and a behavioural answer cannot drift
 * from the thing it answers. The lock is xact-scoped so a pooled connection
 * cannot leak it: it is released by the commit that ends the probe.
 */
async function sharesAStore(a, b) {
  const KEY = "7301293811";
  return await a.transaction(async (tx) => {
    const mine = await tx.query("select pg_try_advisory_xact_lock($1::bigint) as got", [KEY]);
    if (mine.rows[0]?.got !== true) return true;
    const theirs = await b.transaction(async (tx2) => {
      const r = await tx2.query("select pg_try_advisory_xact_lock($1::bigint) as got", [KEY]);
      return r.rows[0]?.got === true;
    });
    return theirs === false;
  });
}

// This proof compares the digest each binding wrote TO ITS OWN STORE. Two
// separate stores is not a convenience here, it is the entire method — and
// openDb() reads one CHANGEOVER_PG_URL, so under a real Postgres both benches
// land in one database and every assertion below quietly changes meaning:
//
//   · the HTTP call takes A:1/A:2, so the MCP call is refused seat_contended —
//     which at least fails loudly;
//   · "the HTTP store holds exactly one row" and "the MCP store holds exactly
//     one row" BOTH pass, on a single shared row, because each counts whatever
//     handle it was given;
//   · and the headline — "the same logical hold_seats is digest-identical
//     across the MCP and HTTP bindings" — passes by comparing one row to
//     itself. A vacuous green on the assertion the whole script exists for.
//
// Measured on postgres:18, 2026-08-25. The parity claim genuinely cannot be
// made when the two bindings share a store, so this is a 2, never a 0.
if (await sharesAStore(http.db, mcp.db)) {
  console.log("cannot prove — the HTTP and MCP benches opened the SAME store, so I3 parity would compare a row to itself:");
  console.log("                openDb() resolves one CHANGEOVER_PG_URL, and this proof needs each binding to write its own.");
  console.log("  to make it provable:");
  console.log("    unset CHANGEOVER_PG_URL   # PGlite gives each bench its own in-process cluster");
  console.log("    bash scripts/prove_digest_parity.sh");
  await mcp.close();
  await http.close();
  process.exit(2);
}

try {
  /* 1 — the same logical call, over two transports, spelled differently ---- */

  const HTTP_KEY = httpKey("parity-http");
  const MCP_KEY  = mcpKey("parity-mcp");

  // Seats reversed. I3 sorts them into D, so reversing is a wire difference and
  // not a decision difference — and a binding that digested the array as sent
  // fails here and only here.
  const httpCall = await call(http, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": HTTP_KEY },
    body: holdBody(["A:2", "A:1"]),
  });
  is(httpCall.status, 201, "the HTTP binding granted the Hold this proof compares");
  if (httpCall.status !== 201) console.log("      " + httpCall.text.slice(0, 300));

  // The same decision members, plus an intent_digest the HTTP call did not
  // send. I3 excludes it from D; if the MCP binding digested its arguments
  // object this member alone would move the digest.
  const mcpCall = await callTool(mcp, "hold_seats", {
    ...holdArgs(["A:1", "A:2"]),
    idempotency_key: MCP_KEY,
    intent_digest: "cVR3ZmFrZUludGVudERpZ2VzdEZvclBhcml0eVByb28",
  });
  is(mcpCall.isError, false, "the MCP binding granted the Hold this proof compares");
  if (mcpCall.isError) console.log("      " + JSON.stringify(mcpCall.refusal).slice(0, 300));

  /* 2 — two stores, each written by exactly one binding ------------------- */

  const httpRows = await storedDigest(http.db, "hold_seats");
  const mcpRows  = await storedDigest(mcp.db, "hold_seats");

  is(httpRows.length, 1, "the HTTP store holds exactly one hold_seats idempotency row, written by the HTTP binding");
  is(mcpRows.length, 1, "the MCP store holds exactly one hold_seats idempotency row, written by the MCP binding");

  const httpDigest = httpRows[0]?.request_digest;
  const mcpDigest  = mcpRows[0]?.request_digest;

  // Without this the parity assertion could hold vacuously on two undefineds.
  /^[A-Za-z0-9_-]{43}$/.test(String(httpDigest))
    ? ok("the HTTP binding stored a 43-character base64url digest (I3)")
    : bad("the HTTP binding stored no well-formed digest: " + JSON.stringify(httpDigest));
  /^[A-Za-z0-9_-]{43}$/.test(String(mcpDigest))
    ? ok("the MCP binding stored a 43-character base64url digest (I3)")
    : bad("the MCP binding stored no well-formed digest: " + JSON.stringify(mcpDigest));

  // The keys differ, so a digest that included the key could not match below.
  httpRows[0]?.idempotency_key_hmac !== mcpRows[0]?.idempotency_key_hmac
    ? ok("the two calls carried different idempotency keys, which I3 excludes from D")
    : bad("the two calls hashed to the same key, so the exclusion of the key is untested");

  /* 3 — the assertion this script exists for ------------------------------ */

  is(mcpDigest, httpDigest,
     "the same logical hold_seats is digest-identical across the MCP and HTTP bindings (I3)");

  /* 4 — the negative control ---------------------------------------------- */

  // If every call digested to the same value, part 3 would hold and mean
  // nothing. A different DECISION member must move it.
  const other = await callTool(mcp, "hold_seats", {
    ...holdArgs(["A:3", "A:4"], { requested_floor_ms: 90000 }),
    idempotency_key: mcpKey("parity-control"),
  });
  is(other.isError, false, "the control call granted a Hold to compare against");
  const afterRows = await storedDigest(mcp.db, "hold_seats");
  const controlDigest = afterRows.find((row) => row.request_digest !== mcpDigest)?.request_digest;
  controlDigest !== undefined
    ? ok("a call differing in a decision member digests differently, so parity is not vacuous")
    : bad("a different requested_floor_ms and seat set produced the same digest");

  /* 5 — I7, the reason the exclusions are load-bearing -------------------- */

  // A gated call records no idempotency entry, so the gate-satisfying retry
  // reuses the key rather than meeting 422 idempotency_key_reused. Counted in
  // the store, because the response is 200-shaped either way.
  const gated = await mcpBench({ gate: { gate_stage: "hold" } });
  try {
    const GATE_KEY = mcpKey("parity-gate");
    const first = await callTool(gated, "hold_seats", {
      ...holdArgs(["A:7", "A:8"]),
      idempotency_key: GATE_KEY,
    });
    is(first.structured?.input_required, true, "the gate fired at gate_stage before anything was held");
    const rowsAfterGate = await storedDigest(gated.db, "hold_seats");
    is(rowsAfterGate.length, 0, "the gated call recorded NO idempotency row (I7: a gate is not an operation)");

    const seats = await gated.db.query("select count(*)::text as n from hold_seat");
    is(seats.rows[0]?.n, "0", "the gated call locked no seat, which is why gate_stage hold spends human latency first");

    // The other half of I7, and the half that is actually load-bearing: the
    // human answered, so the retry carries the attended grant and THE SAME KEY.
    // Against the same store. A 422 idempotency_key_reused here is the
    // draft own worked example, returned to a customer who has just said yes.
    const answered = await mcpBench({ db: gated.db, gate: { attended: true } });
    try {
      const retry = await callTool(answered, "hold_seats", {
        ...holdArgs(["A:7", "A:8"]),
        idempotency_key: GATE_KEY,
      });
      is(retry.isError, false,
         "the gate-satisfying retry with the SAME key is accepted, not refused idempotency_key_reused (I7)");
      if (retry.isError) console.log("      " + JSON.stringify(retry.refusal).slice(0, 300));
      typeof retry.structured?.hold_id === "string"
        ? ok("the retry granted the Hold the gate had deferred")
        : bad("the retry returned no Hold: " + JSON.stringify(retry.structured).slice(0, 200));
    } finally {
      await answered.close();
    }
  } finally {
    await gated.close();
  }
} finally {
  await mcp.close();
  await http.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
