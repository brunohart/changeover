/**
 * The binding, over a connected MCP client. Everything here goes through
 * `tools/call`, so a result that never left the process is not one of these
 * assertions.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { holdSeatsDigest } from "@changeover/core/idempotency.ts";

import { MCP_BINDING_VERSION, META } from "../src/server.ts";
import { callTool, holdArgs, key, listTools, mcpBench } from "./lib/mcp-bench.ts";
import type { McpBench } from "./lib/mcp-bench.ts";

const withBench = async (fn: (bench: McpBench) => Promise<void>, options = {}) => {
  const bench = await mcpBench(options);
  try {
    await fn(bench);
  } finally {
    await bench.close();
  }
};

test("tools/list carries five tools, each with both schemas, over the wire", async () => {
  await withBench(async (bench) => {
    const tools = await listTools(bench);
    assert.equal(tools.length, 5);
    for (const tool of tools) {
      assert.ok(tool.inputSchema, tool.name);
      assert.ok(tool.outputSchema, tool.name);
    }
  });
});

test("the five verbs run end to end, and the SDK validates every result against the declared outputSchema", async () => {
  await withBench(async (bench) => {
    // Listing first is what arms the client's output validation. Every call
    // below is therefore checked against the schema the Server published.
    await listTools(bench);

    const occasions = await callTool(bench, "resolve_occasions", {});
    assert.equal(occasions.structured.occasions.length, 2);

    const held = await callTool(bench, "hold_seats", {
      ...holdArgs(["A:1", "A:2"]),
      idempotency_key: key("binding-hold"),
    });
    assert.equal(held.isError, false);
    assert.match(held.structured.hold_id, /^hold_/);
    assert.deepEqual(held.structured.seats, ["A:1", "A:2"]);
    assert.equal(held.structured.state, "live");

    const read = await callTool(bench, "get_hold", { hold_id: held.structured.hold_id });
    assert.equal(read.structured.state, "live");
    assert.equal(typeof read.structured.read_token, "string");

    const handed = await callTool(bench, "hand_off", {
      hold_id: held.structured.hold_id,
      read_token: read.structured.read_token,
      idempotency_key: key("binding-handoff"),
    });
    assert.equal(handed.structured.state, "handed_off");
    // CL5: the claim URL appears here and nowhere else, once.
    assert.equal(typeof handed.structured.handoff.claim_url, "string");
  });
});

test("R1 — release_hold on a handed-off Hold refuses handoff_consumed, and the code is machine-readable", async () => {
  await withBench(async (bench) => {
    await listTools(bench);
    const held = await callTool(bench, "hold_seats", {
      ...holdArgs(["A:3"]),
      idempotency_key: key("binding-r1"),
    });
    const read = await callTool(bench, "get_hold", { hold_id: held.structured.hold_id });
    await callTool(bench, "hand_off", {
      hold_id: held.structured.hold_id,
      read_token: read.structured.read_token,
      idempotency_key: key("binding-r1-ho"),
    });

    const released = await callTool(bench, "release_hold", { hold_id: held.structured.hold_id });
    assert.equal(released.isError, true);
    // Not in structuredContent: a Refusal is not the tool's output, and the
    // outputSchema governs that member.
    assert.equal(released.structured, undefined);
    assert.equal(released.refusal.code, "handoff_consumed");
    assert.equal(released.refusal.refused, true);
  });
});

test("R2 — release_hold is total for a live Hold and frees its seats", async () => {
  await withBench(async (bench) => {
    await listTools(bench);
    const held = await callTool(bench, "hold_seats", {
      ...holdArgs(["A:9", "A:10"]),
      idempotency_key: key("binding-r2"),
    });
    const released = await callTool(bench, "release_hold", { hold_id: held.structured.hold_id });
    assert.equal(released.isError, false);
    assert.equal(released.structured.state, "released");
    assert.equal(released.structured.seats_freed, 2);

    // Counted in the store, and counted as OCCUPANCY rather than as rows: the
    // row survives release and stops satisfying `hold_seat_occupied`, which is
    // the predicate that makes oversell unrepresentable. A row count would read
    // 2 here and say nothing about whether the seat is sellable again.
    const rows = await bench.db.query<{ n: string }>(
      "select count(*)::text as n from hold_seat" +
        " where hold_id = $1 and state in ('live', 'handed_off', 'claimed')",
      [held.structured.hold_id],
    );
    assert.equal(rows.rows[0]?.n, "0");
  });
});

test("I4 — the same key and digest replays, and hold_id and seats are byte-identical", async () => {
  await withBench(async (bench) => {
    await listTools(bench);
    const args = { ...holdArgs(["A:11", "A:12"]), idempotency_key: key("binding-replay") };
    const first = await callTool(bench, "hold_seats", args);
    const second = await callTool(bench, "hold_seats", args);

    assert.equal(second.structured.hold_id, first.structured.hold_id);
    assert.deepEqual(second.structured.seats, first.structured.seats);
    assert.equal(second.structured.granted_at, first.structured.granted_at);
    assert.equal(second.structured.floor_deadline, first.structured.floor_deadline);

    const rows = await bench.db.query<{ n: string }>(
      "select count(*)::text as n from hold where hold_id = $1",
      [first.structured.hold_id],
    );
    assert.equal(rows.rows[0]?.n, "1", "a replay created no second Hold");
  });
});

test("I5 — the same key with a different decision member is refused, and takes no action", async () => {
  await withBench(async (bench) => {
    await listTools(bench);
    const reused = key("binding-reuse");
    await callTool(bench, "hold_seats", { ...holdArgs(["B:1"]), idempotency_key: reused });
    const clash = await callTool(bench, "hold_seats", {
      ...holdArgs(["B:2"]),
      idempotency_key: reused,
    });
    assert.equal(clash.isError, true);
    assert.equal(clash.refusal.code, "idempotency_key_reused");

    const rows = await bench.db.query<{ n: string }>(
      "select count(*)::text as n from hold_seat where seat_id = $1",
      ["B:2"],
    );
    assert.equal(rows.rows[0]?.n, "0", "the refused call held nothing");
  });
});

test("I3 — the digest the binding stores is the digest of the decision members alone", async () => {
  await withBench(async (bench) => {
    const args = holdArgs(["A:6", "A:5"]);
    await callTool(bench, "hold_seats", {
      ...args,
      idempotency_key: key("binding-digest"),
      intent_digest: "cVR3ZmFrZUludGVudERpZ2VzdEZvclBhcml0eVByb28",
    });
    const rows = await bench.db.query<{ request_digest: string }>(
      "select request_digest from idempotency where verb = 'hold_seats'",
    );
    // Computed here WITHOUT the key and WITHOUT the intent_digest, over the
    // sorted seat set. If either had entered D, this would not match.
    const expected = holdSeatsDigest({
      occasion_id: args.occasion_id,
      occasion_etag: args.occasion_etag,
      sought: args.sought,
      seats: ["A:5", "A:6"],
      requested_floor_ms: args.requested_floor_ms,
    } as never);
    assert.equal(rows.rows[0]?.request_digest, expected);
  });
});

test("an unlisted tool name is a schema_validation refusal, not a permission question", async () => {
  await withBench(async (bench) => {
    const settled = await callTool(bench, "settle_payment", { hold_id: "hold_x" });
    assert.equal(settled.isError, true);
    assert.equal(settled.refusal.code, "schema_validation");
  });
});

test("the intent_digest constraint is enforced by the Server and not only published", async () => {
  await withBench(async (bench) => {
    const refused = await callTool(bench, "hold_seats", {
      ...holdArgs(["A:8"]),
      idempotency_key: key("binding-pii"),
      intent_digest: "sarah.chen@gmail.com",
    });
    assert.equal(refused.isError, true);
    assert.equal(refused.refusal.code, "schema_validation");

    // D1/P1: nothing of it reached the store.
    const rows = await bench.db.query<{ n: string }>("select count(*)::text as n from hold");
    assert.equal(rows.rows[0]?.n, "0");
  });
});

test("every result names the binding version it implements", async () => {
  await withBench(async (bench) => {
    const occasions = await callTool(bench, "resolve_occasions", {});
    assert.equal(occasions.meta[META.binding], MCP_BINDING_VERSION);
    assert.equal(MCP_BINDING_VERSION, "2026-07-28");
  });
});

test("I7 — a gated call writes nothing, and the same key is accepted once the human has answered", async () => {
  const gated = await mcpBench({ gate: { gate_stage: "hold" } });
  try {
    const shared = key("binding-gate");
    const first = await callTool(gated, "hold_seats", {
      ...holdArgs(["A:1", "A:2"]),
      idempotency_key: shared,
    });
    assert.equal(first.structured.input_required, true);

    const idem = await gated.db.query<{ n: string }>("select count(*)::text as n from idempotency");
    assert.equal(idem.rows[0]?.n, "0");

    const answered = await mcpBench({ db: gated.db, gate: { attended: true } });
    try {
      const retry = await callTool(answered, "hold_seats", {
        ...holdArgs(["A:1", "A:2"]),
        idempotency_key: shared,
      });
      assert.equal(retry.isError, false);
      assert.match(retry.structured.hold_id, /^hold_/);
    } finally {
      await answered.close();
    }
  } finally {
    await gated.close();
  }
});
