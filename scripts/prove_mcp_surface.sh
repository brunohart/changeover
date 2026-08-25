#!/usr/bin/env bash
# C-ABSENCE.1 and SEP-2106/2549/2322/2567, at the MCP boundary. Asserts that
# tools/list returns exactly five tools, that no listed tool name matches the
# settlement pattern, that every inputSchema and outputSchema compiles under
# ajv 2020-12 strict, and that the three version-specific SEP rules hold on a
# live call.
#
# The cheaper check is to import TOOLS and read it. That would pass with a
# server whose handler never returned it, or whose transport dropped
# outputSchema on the way out, or whose SDK rejected a schema at listing time
# and left the surface empty — all three of which happened while this was being
# written, and none of which an in-process read would have shown. Everything
# below goes through a connected MCP client, so every schema asserted is a
# schema that arrived over the wire.
#
# Two assertions count ROWS rather than responses, because the response is the
# thing under test: a gate that recorded an idempotency entry answers
# input_required either way, and a gate that locked seats first answers
# input_required either way too.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/@modelcontextprotocol/sdk ] || { echo "cannot prove — @modelcontextprotocol/sdk not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/ajv/dist ] || { echo "cannot prove — ajv not installed; run npm install at the repository root"; exit 2; }
[ -f packages/mcp/src/server.ts ] || { echo "cannot prove — packages/mcp/src/server.ts missing"; exit 2; }
[ -f packages/mcp/test/lib/mcp-bench.ts ] || { echo "cannot prove — packages/mcp/test/lib/mcp-bench.ts missing; it seeds the estate this proof reads"; exit 2; }
[ -f schemas/verbs.json ] || { echo "cannot prove — schemas/verbs.json missing"; exit 2; }

node --input-type=module -e '
import { readFileSync } from "node:fs";
import { ajv2020 } from "./packages/mcp/src/validate.ts";
import { FRESHNESS_CEILING_MS } from "./packages/mcp/src/freshness.ts";
import { containsUri } from "./packages/mcp/src/gate.ts";
import {
  callTool, holdArgs, key, listTools, mcpBench,
} from "./packages/mcp/test/lib/mcp-bench.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };
const is  = (actual, expected, m) =>
  actual === expected ? ok(m) : bad(m + " (expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual) + ")");

// C-ABSENCE.1. Kept here and not in packages/mcp/src, so that a future
// extension of the pattern finds no source line arguing with it. `price` is
// deliberately omitted: price_disclosure and price_basis are legitimate
// read-side members and a check that fails on them is a check somebody disables.
const SETTLEMENT = /settle|pay|capture|refund|charge/i;
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

const bench = await mcpBench();
let gated = null;

try {
  const tools = await listTools(bench);

  /* 1 — the surface a model actually reads -------------------------------- */

  is(tools.length, 5, "tools/list returns exactly five tools");

  const listed = tools.map((tool) => tool.name).sort();
  const verbs = [...JSON.parse(readFileSync("schemas/verbs.json", "utf8")).verbs].sort();
  is(JSON.stringify(listed), JSON.stringify(verbs),
     "the five listed tools are exactly the five verbs of schemas/verbs.json");

  const settling = tools.filter((tool) => SETTLEMENT.test(tool.name));
  is(settling.length, 0,
     "0 listed tool names match /settle|pay|capture|refund|charge/ (C-ABSENCE.1)");

  // The other surface a model can fill in. A tool named innocently whose input
  // took a `payment_method` would be a settlement verb with a different sign.
  const inputMembers = tools.flatMap((tool) => Object.keys(tool.inputSchema?.properties ?? {}));
  const settlingMembers = inputMembers.filter((name) => SETTLEMENT.test(name));
  is(settlingMembers.length, 0,
     "0 of " + inputMembers.length + " tool-input members match the settlement pattern");

  /* 2 — SEP-2106: both schemas, full 2020-12, compiled --------------------- */

  let compiled = 0;
  for (const tool of tools) {
    for (const which of ["inputSchema", "outputSchema"]) {
      const schema = tool[which];
      if (schema === undefined) { bad(tool.name + " published no " + which); continue; }
      if (schema.$schema !== DIALECT) {
        bad(tool.name + "." + which + " declares dialect " + JSON.stringify(schema.$schema));
        continue;
      }
      try { ajv2020().compile(schema); compiled++; }
      catch (err) { bad(tool.name + "." + which + " does not compile: " + String(err).slice(0, 200)); }
    }
  }
  is(compiled, 10,
     "all ten inputSchema/outputSchema documents declare 2020-12 and compile under ajv strict");

  /* 3 — the constraints §6.2 requires to be identical to HTTP -------------- */

  const holdInput = tools.find((tool) => tool.name === "hold_seats").inputSchema;
  const seats = holdInput.properties.seats;
  is(seats.uniqueItems, true, "hold_seats.seats is uniqueItems (W2), identically to the HTTP binding");
  is(seats.maxItems, 12, "hold_seats.seats is maxItems 12, identically to the HTTP binding");
  is(holdInput.properties.intent_digest.pattern, "^[A-Za-z0-9_-]{43}$",
     "hold_seats.intent_digest carries the 43-character base64url pattern the draft omitted here");
  is(holdInput.properties.idempotency_key.maxLength, 128,
     "hold_seats.idempotency_key is maxLength 128 (SPEC.md 6.2)");

  /* 4 — SEP-2567: the handle is server-minted ------------------------------ */

  Object.hasOwn(holdInput.properties, "hold_id")
    ? bad("hold_seats.inputSchema exposes hold_id, so an Agent could synthesise one")
    : ok("hold_seats.inputSchema has no hold_id member, so an Agent cannot synthesise one (SEP-2567)");
  const addressing = ["get_hold", "release_hold", "hand_off"]
    .map((name) => tools.find((tool) => tool.name === name).inputSchema)
    .every((schema) => (schema.required ?? []).includes("hold_id"));
  is(addressing, true,
     "the three tools that address a Hold require the server-minted hold_id as an ordinary argument");

  // I2/X0: scope is credential-derived and never read from a body. There is no
  // member to put it in, and additionalProperties is false, so there is no
  // member to invent either.
  const scopeBearing = inputMembers.filter((name) => name === "agent_id" || name === "principal_scope");
  is(scopeBearing.length, 0, "no tool input accepts agent_id or principal_scope (I2)");
  const closed = tools.every((tool) => tool.inputSchema.additionalProperties === false);
  is(closed, true, "every inputSchema is additionalProperties false, so an unknown member is refused rather than ignored");

  /* 5 — SEP-2549: freshness, computed against the estate own numbers ------ */

  const resolved = await callTool(bench, "resolve_occasions", {});
  const freshness = resolved.meta["dev.changeover.exhibition/freshness"];
  is(freshness?.cacheScope, "session", "resolve_occasions carries cacheScope session (SEP-2549)");

  // Recomputed here from the served documents, with this script arithmetic and
  // not the binding own. Anchored on the response server_time, so the two are
  // reading one clock.
  const now = Date.parse(resolved.structured.server_time);
  let expected = FRESHNESS_CEILING_MS;
  for (const occasion of resolved.structured.occasions) {
    const stale = occasion.availability?.max_staleness_ms;
    if (typeof stale === "number") expected = Math.min(expected, stale);
    const cutoff = occasion.instant?.sales_cutoff_at;
    if (typeof cutoff === "string") expected = Math.min(expected, Math.max(0, Date.parse(cutoff) - now));
  }
  is(freshness?.ttlMs, expected,
     "ttlMs is min(max_staleness_ms, ms_to_sales_cutoff, 30000) over the page (SEP-2549)");
  expected < FRESHNESS_CEILING_MS
    ? ok("the minimum bites: a published max_staleness_ms below the ceiling is what set the ttl")
    : bad("every term equalled the 30000 ceiling, so the min() is untested by this estate");

  /* 6 — SEP-2322: the gate, at the stage gate_stage names ------------------ */

  gated = await mcpBench({ gate: { gate_stage: "hold" } });
  const gateCall = await callTool(gated, "hold_seats", {
    ...holdArgs(["A:4", "A:5"]),
    idempotency_key: key("surface-gate"),
  });
  is(gateCall.structured?.input_required, true, "hold_seats returns an InputRequiredResult at gate_stage hold");
  is(gateCall.structured?.stage, "hold", "the result names the stage the capability document publishes");

  const request = gateCall.structured?.inputRequests?.[0];
  is(request?.prompt?.content_type, "text/plain", "the prompt travels in a prose envelope (X6a)");
  containsUri(String(request?.prompt?.value ?? ""))
    ? bad("the gate prompt contains a URI: " + request?.prompt?.value)
    : ok("the gate prompt contains no URI (X6a), so the dialog cannot carry a link somewhere else");
  const structuredMembers = ["seat_count", "venue_name", "local_wall", "presentation_classes", "amount_minor", "currency"];
  const missing = structuredMembers.filter((name) => !Object.hasOwn(request ?? {}, name));
  is(missing.length, 0,
     "the gate carries all six structured members, so an Agent renders from structure and not from the caption (X6a)");
  is(request?.seat_count, 2, "the structured seat_count is the count actually asked for");

  // Counted in the store. The response is input_required either way.
  const rows = await gated.db.query("select count(*)::text as n from idempotency");
  is(rows.rows[0]?.n, "0", "the gated call recorded no idempotency row (I7)");
  const held = await gated.db.query("select count(*)::text as n from hold_seat");
  is(held.rows[0]?.n, "0", "the gated call locked no seat, which is the whole point of gating at hold");

  /* 7 — no dependency on the three deprecated features --------------------- */

  // Sampling, Roots and Logging are deprecated in 2026-07-28 and a conforming
  // Server MUST NOT depend on them. Declaring a capability is how depending on
  // one starts, so the assertion is on what the client saw the server declare.
  const declared = bench.client.getServerCapabilities() ?? {};
  const deprecated = ["sampling", "roots", "logging"].filter((name) => Object.hasOwn(declared, name));
  is(deprecated.length, 0,
     "the Server declares none of sampling, roots or logging, all three deprecated in 2026-07-28");
} finally {
  if (gated !== null) await gated.close();
  await bench.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
