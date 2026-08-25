/**
 * C-ABSENCE.4 — the outbound byte canary's *source*: every response body both
 * bindings can be made to emit, as bytes, on the way out.
 * Owner: TEST-004.
 *
 * Two rules shape this file.
 *
 * **Bytes, not objects.** The canary asks what left the boundary. Scanning the
 * object a handler returned would miss anything a serialiser adds, and would
 * pass under an adapter that dropped the body entirely. Everything here is the
 * response text off a socket, or the JSON-RPC result as it was serialised.
 *
 * **Personal data is fed IN.** A canary over the happy path alone proves that
 * documents nobody poisoned carry nothing personal, which was never in doubt.
 * The interesting question on a **write** path is what happens to a personal
 * value an agent supplies: `intent_digest` shaped like an address, an
 * `Idempotency-Key` carrying one, a seat id that is one. Each is refused — and
 * the refusal is a prose channel back to a consumer with no judgement, which is
 * exactly where an echoed value would appear. The canary reads those bodies too.
 *
 * The poison strings are synthetic, they are never written to the store, and
 * they exist only inside this process. `4111111111111111` is the published test
 * value every card network reserves for exactly this purpose.
 *
 * The HTTP bench is BIND-001's and is reached by relative path because the
 * package's `exports` map covers `./src/*` only, which is right: a bench is not
 * part of a published surface. `scripts/prove_http_binding.sh` reaches it the
 * same way.
 */

import {
  AGENT_TOKEN,
  OCCASION_A,
  OPERATOR_TOKEN,
  call,
  holdBody,
  httpBench,
  key,
  siteConfig,
} from "../../../http/test/lib/http-bench.ts";

export interface Body {
  /** Where these bytes came from, precise enough to act on a hit. */
  readonly label: string;
  readonly text: string;
}

/**
 * The synthetic personal values the canary is fed and the canary is tested with.
 * Not read from anywhere, not written anywhere, and each one is a published
 * test value or an obviously invented one.
 */
export const POISON = Object.freeze({
  email: "sarah.chen@example.com",
  e164: "+6421555123456",
  pan: "4111111111111111",
  pan_spaced: "4111 1111 1111 1111",
  pan_dashed: "4111-1111-1111-1111",
});

const STALE_ETAG = "1:0000000000000000000000000000000000000000000";
const ABSENT_HOLD = "hold_00000000000000000000000000000000";

/**
 * Every HTTP response body this binding will emit for us: the nine routes on
 * their happy path, six typed refusals, three poisoned requests, and two
 * settlement-shaped paths that must simply not be there.
 */
export const CAPABILITY_LABEL = "GET /.well-known/changeover";

export async function httpBodies(): Promise<{
  bodies: Body[];
  settlement: number[];
  /**
   * The operator address the site publishes at `usage_policy.contact`, read from
   * the configuration rather than from the response. The canary compares the one
   * email it is willing to account for against what the exhibitor declared; an
   * address that appeared in a body without appearing here would be a leak
   * wearing the shape of a policy member.
   */
  operator_contact: string;
}> {
  const bench = await httpBench();
  const bodies: Body[] = [];
  const settlement: number[] = [];
  const add = (label: string, r: { text: string }) => bodies.push({ label, text: r.text });

  try {
    const held = await call(bench, "POST", "/changeover/v0/holds", {
      token: AGENT_TOKEN,
      headers: { "Idempotency-Key": key("canary-grant") },
      body: holdBody(["A:1", "A:2"]),
    });
    add("POST /holds", held);
    const hold_id = (held.json as { hold_id?: string } | undefined)?.hold_id ?? ABSENT_HOLD;

    const read = await call(bench, "GET", "/changeover/v0/holds/" + hold_id, { token: AGENT_TOKEN });
    add("GET /holds/{id}", read);

    add(CAPABILITY_LABEL, await call(bench, "GET", "/.well-known/changeover"));
    add(
      "GET /.well-known/changeover/delegation.json",
      await call(bench, "GET", "/.well-known/changeover/delegation.json"),
    );
    add(
      "GET /occasions",
      await call(bench, "GET", "/changeover/v0/occasions", { token: AGENT_TOKEN }),
    );
    add(
      "GET /occasions/{id}",
      await call(bench, "GET", "/changeover/v0/occasions/" + OCCASION_A, { token: AGENT_TOKEN }),
    );
    add(
      "POST /holds/{id}/hand-off",
      await call(bench, "POST", "/changeover/v0/holds/" + hold_id + "/hand-off", {
        token: AGENT_TOKEN,
        headers: { "Idempotency-Key": key("canary-off") },
        body: { read_token: (read.json as { read_token?: string } | undefined)?.read_token },
      }),
    );
    add(
      "POST /holds/{id}/revoke",
      await call(bench, "POST", "/changeover/v0/holds/" + hold_id + "/revoke", {
        token: OPERATOR_TOKEN,
        body: { revocation_reason: "venue_operations" },
      }),
    );
    add(
      "DELETE /holds/{id}",
      await call(bench, "DELETE", "/changeover/v0/holds/" + hold_id, { token: AGENT_TOKEN }),
    );

    /* -- typed refusals: prose channels back to a consumer with no judgement -- */

    add("no credential", await call(bench, "GET", "/changeover/v0/occasions"));
    add(
      "unknown Occasion",
      await call(bench, "GET", "/changeover/v0/occasions/occ_nope", { token: AGENT_TOKEN }),
    );
    add(
      "unknown Hold",
      await call(bench, "GET", "/changeover/v0/holds/" + ABSENT_HOLD, { token: AGENT_TOKEN }),
    );
    add(
      "stale conditional",
      await call(bench, "GET", "/changeover/v0/occasions/" + OCCASION_A, {
        token: AGENT_TOKEN,
        headers: { "If-Match": JSON.stringify(STALE_ETAG) },
      }),
    );
    add(
      "malformed body",
      await call(bench, "POST", "/changeover/v0/holds", {
        token: AGENT_TOKEN,
        headers: { "Idempotency-Key": key("canary-bad") },
        body: { occasion_id: 7 },
      }),
    );

    /* -- poisoned inbound values, refused, and read on the way back out ------ */

    add(
      "poisoned intent_digest",
      await call(bench, "POST", "/changeover/v0/holds", {
        token: AGENT_TOKEN,
        headers: { "Idempotency-Key": key("canary-digest") },
        body: holdBody(["A:5"], { intent_digest: POISON.email }),
      }),
    );
    add(
      "poisoned Idempotency-Key",
      await call(bench, "POST", "/changeover/v0/holds", {
        token: AGENT_TOKEN,
        headers: { "Idempotency-Key": POISON.email + POISON.pan },
        body: holdBody(["A:6"]),
      }),
    );
    add(
      "poisoned seat id",
      await call(bench, "POST", "/changeover/v0/holds", {
        token: AGENT_TOKEN,
        headers: { "Idempotency-Key": key("canary-seat") },
        body: holdBody([POISON.email]),
      }),
    );
    add(
      "poisoned path segment",
      await call(bench, "GET", "/changeover/v0/occasions/" + encodeURIComponent(POISON.email), {
        token: AGENT_TOKEN,
      }),
    );

    /* -- Lock 1, over a socket: the settlement routes are simply not there --- */

    for (const path of [
      "/changeover/v0/holds/" + hold_id + "/settle",
      "/changeover/v0/holds/" + hold_id + "/pay",
      "/changeover/v0/holds/" + hold_id + "/capture",
      "/changeover/v0/payments",
      "/changeover/v0/refunds",
    ]) {
      const r = await call(bench, "POST", path, {
        token: AGENT_TOKEN,
        headers: { "Idempotency-Key": key("canary-settle") },
        body: {},
      });
      settlement.push(r.status);
      add("POST " + path, r);
    }
  } finally {
    await bench.close();
  }

  return { bodies, settlement, operator_contact: siteConfig().usage_policy.contact };
}

/* -- The MCP binding -------------------------------------------------------- */

/**
 * The same walk over JSON-RPC. The result object is stringified whole —
 * `structuredContent`, `content` and `_meta` together — because a refusal
 * travels in `_meta` on this binding and a canary that read only the structured
 * half would be blind to exactly the channel that carries prose.
 */
export interface SettlementCall {
  readonly name: string;
  /** True when the surface refused to select it at all. */
  readonly refused: boolean;
  readonly note: string;
}

export async function mcpBodies(): Promise<{
  bodies: Body[];
  tools: string[];
  settlementCalls: SettlementCall[];
}> {
  const { holdArgs, key: mcpKey, mcpBench } = await import("../../../mcp/test/lib/mcp-bench.ts");
  const bench = await mcpBench();
  const bodies: Body[] = [];
  const add = (label: string, value: unknown) =>
    bodies.push({ label, text: JSON.stringify(value) });

  let tools: string[] = [];
  const settlementCalls: SettlementCall[] = [];
  try {
    const listed = (await bench.client.listTools()) as { tools: { name: string }[] };
    tools = listed.tools.map((t) => t.name);
    add("tools/list", listed);

    const invoke = async (label: string, name: string, args: Record<string, unknown>) => {
      try {
        add(label, await bench.client.callTool({ name, arguments: args }));
      } catch (err) {
        // A protocol-level rejection is a body too: it is what the agent sees.
        add(label + " (protocol error)", { message: (err as Error).message });
      }
    };

    await invoke("resolve_occasions", "resolve_occasions", {});
    const granted = (await bench.client.callTool({
      name: "hold_seats",
      arguments: holdArgs(["A:1", "A:2"], { idempotency_key: mcpKey("canary-mcp-grant") }),
    })) as { structuredContent?: { hold_id?: string } };
    add("hold_seats", granted);
    const hold_id = granted.structuredContent?.hold_id ?? ABSENT_HOLD;

    const read = (await bench.client.callTool({
      name: "get_hold",
      arguments: { hold_id },
    })) as { structuredContent?: { read_token?: string } };
    add("get_hold", read);

    await invoke("hand_off", "hand_off", {
      hold_id,
      read_token: read.structuredContent?.read_token ?? "",
      idempotency_key: mcpKey("canary-mcp-off"),
    });
    await invoke("release_hold", "release_hold", { hold_id });

    /* -- refusals, and the poisoned values that produce them ---------------- */

    await invoke("unknown hold", "get_hold", { hold_id: ABSENT_HOLD });
    await invoke("poisoned intent_digest", "hold_seats", {
      ...holdArgs(["A:5"], { idempotency_key: mcpKey("canary-mcp-digest") }),
      intent_digest: POISON.email,
    });
    await invoke("poisoned idempotency_key", "hold_seats", {
      ...holdArgs(["A:6"]),
      idempotency_key: POISON.email + POISON.pan,
    });
    await invoke("poisoned seat id", "hold_seats", {
      ...holdArgs([POISON.email], { idempotency_key: mcpKey("canary-mcp-seat") }),
    });

    /* -- Lock 1: a settlement tool cannot be called because it is not there -- */

    for (const name of ["settle", "settle_hold", "capture_payment", "refund", "charge_card"]) {
      const label = "tools/call " + name;
      try {
        const result = (await bench.client.callTool({ name, arguments: { hold_id } })) as {
          isError?: boolean;
          structuredContent?: unknown;
        };
        add(label, result);
        settlementCalls.push({
          name,
          refused: result.isError === true && result.structuredContent === undefined,
          note:
            result.isError === true
              ? "refused, and carried no structuredContent"
              : "ANSWERED: isError " + String(result.isError),
        });
      } catch (err) {
        // A protocol-level rejection is a body too: it is what the agent sees.
        add(label + " (protocol error)", { message: (err as Error).message });
        settlementCalls.push({ name, refused: true, note: "rejected at the protocol" });
      }
    }
  } finally {
    await bench.close();
  }

  return { bodies, tools, settlementCalls };
}
