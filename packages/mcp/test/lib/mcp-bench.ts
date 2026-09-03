/**
 * A migrated store, the same two published Occasions the HTTP bench serves, and
 * a connected MCP client/server pair over an in-memory transport.
 *
 * Owner: BIND-002. Not a `.test.ts` file, so `node --test` does not run it.
 *
 * **The estate is imported from `packages/http/test/lib/http-bench.ts` rather
 * than rebuilt here, and that is the whole point.** `occasion_id` and
 * `occasion_etag` are *decision members* under I3 — they are two of the six
 * things the request digest is computed over. Two hand-built estates would
 * differ in precisely the members the parity proof exists to compare, and the
 * proof would then fail, or pass, for reasons that have nothing to do with
 * whether the two bindings project `D` by the same rule. One estate, two
 * stores, two transports.
 *
 * Two stores and not one: PGlite is single-connection and in-process, and both
 * bindings issuing the same logical `hold_seats` against one store would put
 * the second call in contention with the first for the same seats. Contention
 * is a real thing to test and it is not what this bench is for.
 */

import type { AddressInfo } from "node:net";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { Db } from "@changeover/store/db.ts";
import { openDb } from "@changeover/store/db.ts";
import { migrate } from "@changeover/store/migrate.ts";
import { seedEstate } from "@changeover/store/fixtures.ts";
import { resetEstate, resetHoldStore } from "@changeover/store/migrate.ts";
import { HOLD_POLICY_PUBLISHED, principalBudgets } from "@changeover/core/budgets.ts";
import type { Credential } from "@changeover/core/hold-seats.ts";

import { createMcpServer } from "../../src/server.ts";
import type { McpServerOptions } from "../../src/server.ts";
import { GATE_STAGE } from "../../src/gate.ts";
import type { GateOptions } from "../../src/gate.ts";

import {
  AGENT,
  ETAG_A,
  OCCASION_A,
  estate,
  siteConfig,
} from "../../../http/test/lib/http-bench.ts";

export { AGENT, ETAG_A, OCCASION_A, siteConfig };

/**
 * The HTTP bench's estate, with one member put back.
 *
 * `http-bench.occasionDocument()` replaces the golden fixture's `substitution`
 * wholesale — correctly, since the golden one asserts a `strict` boundary
 * against two Occasions that are not in this estate — but the replacement omits
 * `derived_from`, which `substitution.schema.json` **requires**. The documents
 * it publishes are therefore not valid Occasions.
 *
 * Nothing on the HTTP side notices, because nothing there validates a served
 * Occasion against its own schema. The MCP client does, the moment
 * `resolve_occasions` declares an `outputSchema` — which is SEP-2106 earning
 * its place on the first call rather than in a review. Repaired here rather
 * than there because `packages/http/**` belongs to BIND-001; reported in the
 * return so the owner can fix the source.
 *
 * `derived_from` is `@changeover/semantics`' provenance for a machine-derived
 * edge set (§3.1). An empty rule list under the estate's own policy id is the
 * honest value for a `substitution` that asserts no edges.
 */
export function publishableEstate() {
  const source = estate();
  return {
    ...source,
    occasions: source.occasions.map((seed) => {
      const document = seed.document as Record<string, unknown> | undefined;
      if (document === undefined) return seed;
      const substitution = document.substitution as Record<string, unknown>;
      if (substitution?.derived_from !== undefined) return seed;
      return {
        ...seed,
        document: {
          ...document,
          substitution: {
            ...substitution,
            derived_from: { policy_id: "pol_mcp_bench", rule_ids: [], rule_version: "2026.1" },
          },
        },
      };
    }),
  };
}

/** I2: credential-derived, never a tool argument. The HTTP bench's own agent. */
export const CREDENTIAL: Credential = {
  agent_id: AGENT.agent_id,
  principal_scope: AGENT.principal_scope,
};

/**
 * The gate is OFF by default in this bench.
 *
 * X6's default is the opposite — absence of an `attended` grant means the gate
 * fires — and that is correct for a Server. But a bench whose every
 * `hold_seats` returned `input_required` could not exercise a single verb, so
 * this one carries the exhibitor-issued grant X6 names. Tests that are about
 * the gate ask for it explicitly.
 */
export const ATTENDED: GateOptions = { attended: true, gate_stage: GATE_STAGE.hold };

export interface McpBench {
  readonly db: Db;
  readonly client: Client;
  close(): Promise<void>;
}

export interface McpBenchOptions {
  readonly gate?: GateOptions;
  readonly overrides?: Partial<McpServerOptions>;
  /**
   * Attach a second server to a store that is already migrated and seeded.
   *
   * I7's second half needs exactly this: *"MUST accept the same key on the
   * gate-satisfying retry."* The retry is a different Server — the human has
   * answered, so the credential now carries the `attended` grant — against the
   * **same** idempotency table. A fresh store would make the retry trivially
   * accepted, which is not the claim.
   */
  readonly db?: Db;
}

export async function mcpBench(options: McpBenchOptions = {}): Promise<McpBench> {
  const attached = options.db !== undefined;
  const db = options.db ?? (await openDb());
  if (!attached) {
    await migrate(db);
    // Shared-store isolation: see the note in packages/core/test/lib/estate.ts.
    // PGlite gives each script a fresh database; a real Postgres does not.
    await resetHoldStore(db);
    // And the estate too: seedEstate upserts what it names and leaves foreign
    // Occasions in place, which resolve_occasions then answers with.
    await resetEstate(db);
    await seedEstate(db, publishableEstate());
  }

  const site = siteConfig("1");
  const { server } = createMcpServer({
    db,
    credential: CREDENTIAL,
    venue_name: site.venue.name.value,
    gate: options.gate ?? ATTENDED,
    // The published policy and the enforced guard are one value, read once —
    // §2.5's "a Server MUST NOT enforce a limit it has not published", and X1's
    // converse, which is that these MUST be enforced.
    hold_seats: {
      profile: "1",
      policy: {
        policy_max_floor_ms: HOLD_POLICY_PUBLISHED.policy_max_floor_ms,
        max_seats_per_hold: HOLD_POLICY_PUBLISHED.max_seats_per_hold,
        abandonment_floor_penalty_bp: HOLD_POLICY_PUBLISHED.abandonment_floor_penalty_bp,
      },
      budgets: principalBudgets(HOLD_POLICY_PUBLISHED),
    },
    ...(options.overrides ?? {}),
  });

  const client = new Client({ name: "changeover-bench", version: "0.1.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    db,
    client,
    async close() {
      await client.close();
      await server.close();
      // A bench that borrowed its store does not close it: the lender is still
      // using it, and PGlite has exactly one connection to lose.
      if (!attached) await db.close();
    },
  };
}

/* -- Calling it ------------------------------------------------------------- */

export interface ToolCall {
  readonly isError: boolean;
  readonly structured: any;
  readonly meta: Record<string, any>;
  /** The closed-taxonomy Refusal, which travels in `_meta` and never in `structuredContent`. */
  readonly refusal: any;
}

export async function callTool(
  bench: McpBench,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCall> {
  const result: any = await bench.client.callTool({ name, arguments: args });
  const meta = (result._meta ?? {}) as Record<string, any>;
  return {
    isError: result.isError === true,
    structured: result.structuredContent,
    meta,
    refusal: meta["dev.changeover.exhibition/refusal"],
  };
}

export async function listTools(bench: McpBench): Promise<readonly any[]> {
  const result: any = await bench.client.listTools();
  return result.tools;
}

/** A well-formed idempotency key: 22+ characters from I1's alphabet, under 128. */
export function key(seed: string): string {
  return (seed + "0123456789abcdefghijklmnopqrstuv").slice(0, 32);
}

/** The same logical hold the HTTP bench's `holdBody` describes. */
export function holdArgs(
  seats: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    occasion_id: OCCASION_A,
    occasion_etag: ETAG_A,
    sought: { occasion_id: OCCASION_A, occasion_etag: ETAG_A },
    seats: [...seats],
    requested_floor_ms: 120000,
    ...overrides,
  };
}

export type { AddressInfo };
