/**
 * The MCP binding. Five tools, one credential, no settlement.
 *
 * ## What this file is not
 *
 * It is **not a proxy onto the HTTP binding.** Digest parity would be trivially
 * true if it were, and trivially uninformative: the whole claim under test is
 * that two independently-written projections of `D` agree, and a shim that
 * forwards to the other binding proves that forwarding works. So this file
 * builds its own `HoldSeatsRequest` from the tool-arguments object and calls
 * `@changeover/core` directly, exactly as `packages/http/src/server.ts` builds
 * its own from a JSON body. `holdSeatsDigest` is the one thing both share,
 * because I3 says *"projected from the tool-arguments object by the same
 * rule"* — one rule, two callers, and the proof is what checks they meet.
 *
 * ## Where the credential comes from
 *
 * I2: scope is `(agent_id, principal_scope, verb, key)`, **all
 * credential-derived, never read from a body**. MCP 2026-07-28 removed
 * protocol-level sessions (SEP-2567), so there is no session object to hang a
 * principal on and nothing in a tool call that could carry one: `agent_id` and
 * `principal_scope` appear in no `inputSchema`, and every input schema is
 * `additionalProperties: false`, so a caller has no member to put one in. The
 * credential is supplied **at construction**, by whatever authenticated the
 * transport. One server object, one credential — which is what a stdio MCP
 * server is anyway.
 *
 * ## The protocol version, stated honestly
 *
 * The binding is specified against MCP **2026-07-28**. The installed SDK
 * (`@modelcontextprotocol/sdk` 1.30.0) negotiates at most `2025-11-25` and
 * ships no `CacheableResult` or `InputRequiredResult` type. Rather than
 * pretend, this binding emits both SEP shapes as `_meta` members on the
 * `CallToolResult` — `_meta` is the passthrough the protocol reserves for
 * exactly this — and names the binding version it implements in
 * {@link MCP_BINDING_VERSION}. A conformance report says which was negotiated;
 * it does not say the wire carried a version nothing sent.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { Db } from "@changeover/store/db.ts";
import type { Rfc3339 } from "@changeover/schema/scalars.ts";
import { Refusal, isRefusal, refuse } from "@changeover/schema/refusal.ts";
import type { RefusalDocument } from "@changeover/schema/refusal.ts";
import { serverTime } from "@changeover/core/clock.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import type { Credential, HoldSeatsOptions, HoldSeatsRequest } from "@changeover/core/hold-seats.ts";
import { getHold } from "@changeover/core/get-hold.ts";
import type { GetHoldOptions } from "@changeover/core/get-hold.ts";
import { releaseHold } from "@changeover/core/release.ts";
import { handOff } from "@changeover/core/hand-off.ts";
import type { HandOffOptions } from "@changeover/core/hand-off.ts";
import {
  assertKeyShape,
  handOffDigest,
  holdSeatsDigest,
  releaseHoldDigest,
  withIdempotency,
} from "@changeover/core/idempotency.ts";
import type { IdempotentVerb } from "@changeover/core/idempotency.ts";

import { TOOLS, IDEMPOTENCY_KEY_MAX_LENGTH, toolByName } from "./tools.ts";
import type { ToolDefinition } from "./tools.ts";
import { compileToolValidators } from "./validate.ts";
import type { ToolValidators } from "./validate.ts";
import { cacheable, freshnessOf } from "./freshness.ts";
import type { CacheableResult } from "./freshness.ts";
import { GATE_STAGE, gates, inputRequired } from "./gate.ts";
import type { GateFacts, GateOptions, GateStage } from "./gate.ts";

/** The binding this file implements, whatever the SDK negotiates beneath it. */
export const MCP_BINDING_VERSION = "2026-07-28";

/** `_meta` keys. Namespaced, because `_meta` is shared with the protocol. */
export const META = {
  freshness: "dev.changeover.exhibition/freshness",
  input_required: "dev.changeover.exhibition/input_required",
  refusal: "dev.changeover.exhibition/refusal",
  binding: "dev.changeover.exhibition/binding_version",
} as const;

/* -- Seams ------------------------------------------------------------------ */

/** Where Occasions are read from. Profile 1S serves them from a CMS. */
export interface OccasionReader {
  page(db: Db, limit: number, after?: string): Promise<readonly OccasionRecord[]>;
}

export interface OccasionRecord {
  readonly occasion_id: string;
  readonly starts_at: Rfc3339;
  readonly document: unknown;
}

/** Profile 1: the store defined here is the store. */
export const STORE_OCCASION_READER: OccasionReader = {
  async page(db, limit, after) {
    const params: unknown[] = [];
    let where = "withdrawn = false and document is not null";
    if (after !== undefined) {
      params.push(after);
      where += ` and occasion_id > $${params.length}`;
    }
    params.push(limit);
    const r = await db.query<{ occasion_id: string; starts_at: string; document: unknown }>(
      `select occasion_id, to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as starts_at, document` +
        ` from occasion where ${where} order by occasion_id limit $${params.length}`,
      params,
    );
    return r.rows;
  },
};

export interface McpServerOptions {
  readonly db: Db;
  /** I2/X0. Never a tool argument; supplied by whatever authenticated the transport. */
  readonly credential: Credential;
  /** X6a's `venue_name`, from the site this server speaks for. */
  readonly venue_name: string;
  readonly gate?: GateOptions;
  readonly occasions?: OccasionReader;
  readonly hold_seats?: HoldSeatsOptions;
  readonly get_hold?: GetHoldOptions;
  readonly hand_off?: HandOffOptions;
  readonly max_page_size?: number;
}

export const DEFAULT_MAX_PAGE_SIZE = 200;

/* -- The result shape ------------------------------------------------------- */

export interface ToolOutcome {
  readonly structuredContent?: Record<string, unknown>;
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly isError?: boolean;
  readonly _meta?: Record<string, unknown>;
}

function outcome(
  structuredContent: Record<string, unknown>,
  meta?: Record<string, unknown>,
): ToolOutcome {
  const result: ToolOutcome = {
    structuredContent,
    // A model with no structured-output support still needs the answer, and a
    // second, prose, rendering of it would be a second source of truth. This is
    // the same bytes.
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  };
  if (meta === undefined) return result;
  return { ...result, _meta: { [META.binding]: MCP_BINDING_VERSION, ...meta } };
}

/**
 * A refusal, rendered — and deliberately **not** in `structuredContent`.
 *
 * `structuredContent` is the member `outputSchema` governs, and a Refusal is
 * not a Hold. Putting one there would mean either emitting a document that
 * fails the tool's own declared schema — measured: SDK 1.30.0 validates
 * `structuredContent` even when `isError` is set, and answers `-32602` — or
 * widening every `outputSchema` with a refusal branch, which would say that
 * refusing is one of the things `hold_seats` returns *successfully*. It is
 * not. `isError: true` is the protocol's word for this, and the closed-taxonomy
 * document travels in `_meta`, whole, so a caller with no eyes still gets a
 * **code** and not a sentence.
 */
function refusalOutcome(document: RefusalDocument): ToolOutcome {
  return {
    content: [{ type: "text", text: JSON.stringify(document) }],
    isError: true,
    _meta: {
      [META.binding]: MCP_BINDING_VERSION,
      [META.refusal]: document,
    },
  };
}

/* -- The binding ------------------------------------------------------------ */

export class ChangeoverMcp {
  readonly options: McpServerOptions;
  private readonly validators: ToolValidators;

  constructor(options: McpServerOptions) {
    this.options = options;
    this.validators = compileToolValidators();
  }

  /** `tools/list`, as the model sees it. Five, and no sixth. */
  listTools(): readonly ToolDefinition[] {
    return TOOLS;
  }

  async callTool(name: string, args: unknown): Promise<ToolOutcome> {
    const now = await serverTime(this.options.db);
    try {
      const tool = toolByName(name);
      if (tool === undefined) {
        // Not `not_authorised`: an unlisted name is not a permission question,
        // and answering as though it were would tell a caller that persisting
        // might help.
        throw refuse("schema_validation", `No such tool: ${name}`);
      }
      const problems = this.validators.validateInput(name, args);
      if (problems !== null) {
        throw refuse("schema_validation", `Arguments failed ${name}.inputSchema: ${problems}`);
      }
      return await this.dispatch(name, (args ?? {}) as Record<string, unknown>, now);
    } catch (err) {
      if (isRefusal(err)) return refusalOutcome(err.toDocument(now));
      throw err;
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
    now: Rfc3339,
  ): Promise<ToolOutcome> {
    switch (name) {
      case "resolve_occasions":
        return this.resolveOccasions(args, now);
      case "hold_seats":
        return this.holdSeats(args);
      case "get_hold":
        return this.getHold(args);
      case "release_hold":
        return this.releaseHold(args);
      case "hand_off":
        return this.handOff(args);
      default:
        throw refuse("schema_validation", `No such tool: ${name}`);
    }
  }

  /* -- resolve_occasions --------------------------------------------------- */

  private async resolveOccasions(
    args: Record<string, unknown>,
    now: Rfc3339,
  ): Promise<ToolOutcome> {
    const ceiling = this.options.max_page_size ?? DEFAULT_MAX_PAGE_SIZE;
    const asked = typeof args.page_size === "number" ? args.page_size : ceiling;
    const limit = Math.min(Math.max(1, Math.floor(asked)), ceiling);
    const reader = this.options.occasions ?? STORE_OCCASION_READER;

    // One more than asked, so "there is a next page" is observed rather than guessed.
    const rows = await reader.page(this.options.db, limit + 1, args.cursor as string | undefined);
    const page = rows.slice(0, limit);
    const next_cursor = rows.length > limit ? (page[page.length - 1]?.occasion_id ?? null) : null;

    const freshness: CacheableResult = cacheable(
      page.map((row) => freshnessOf(row.document)),
      now,
    );

    return outcome(
      {
        changeover: "0.1",
        occasions: page.map((row) => row.document),
        next_cursor,
        server_time: now,
      },
      { [META.freshness]: freshness },
    );
  }

  /* -- hold_seats ---------------------------------------------------------- */

  /**
   * I3's `D`, projected from the tool-arguments object. The projection is the
   * member list and nothing else — `idempotency_key` and `intent_digest` are
   * present in the arguments and absent from the request this digests, which
   * is what makes I7's gate-satisfying retry the *same* request rather than a
   * `422` at the worst possible moment.
   */
  private static holdRequest(args: Record<string, unknown>): HoldSeatsRequest {
    const request: Record<string, unknown> = {
      occasion_id: args.occasion_id,
      occasion_etag: args.occasion_etag,
      sought: args.sought,
      requested_floor_ms: args.requested_floor_ms,
    };
    if (args.seats !== undefined) request.seats = args.seats;
    if (args.selection !== undefined) request.selection = args.selection;
    if (args.intent_digest !== undefined) request.intent_digest = args.intent_digest;
    return request as unknown as HoldSeatsRequest;
  }

  private gateStage(): GateStage {
    return this.options.gate?.gate_stage ?? GATE_STAGE.hold;
  }

  private async gateFacts(args: Record<string, unknown>): Promise<GateFacts> {
    const occasion_id = String(args.occasion_id ?? "");
    const r = await this.options.db.query<{ document: unknown }>(
      "select document from occasion where occasion_id = $1",
      [occasion_id],
    );
    const document = (r.rows[0]?.document ?? null) as Record<string, unknown> | null;
    const manner = document?.manner as { presentation_classes?: string[] } | undefined;
    const instant = document?.instant as { local_wall?: string } | undefined;
    const offers = (document?.offers ?? []) as Array<{ amount_minor?: number; currency?: string }>;
    const seats = Array.isArray(args.seats) ? args.seats.length : 0;
    const selection = args.selection as { quantity?: number } | undefined;
    const offer = offers[0];
    return {
      seat_count: seats > 0 ? seats : (selection?.quantity ?? 0),
      venue_name: this.options.venue_name,
      local_wall: instant?.local_wall ?? "",
      presentation_classes: manner?.presentation_classes ?? [],
      // `price_disclosure: at_checkout` publishes no offer, and a gate that
      // invented a number for the dialog would be quoting one.
      amount_minor: typeof offer?.amount_minor === "number" ? offer.amount_minor : null,
      currency: typeof offer?.currency === "string" ? offer.currency : null,
    };
  }

  private async holdSeats(args: Record<string, unknown>): Promise<ToolOutcome> {
    const key = this.keyOf(args, "hold_seats", true) as string;
    const request = ChangeoverMcp.holdRequest(args);

    // X6, before anything is locked. I7 makes this cheap: no idempotency entry
    // is recorded, so the retry that satisfies the gate reuses the same key.
    if (gates("hold_seats", this.options.gate ?? {})) {
      const gate = inputRequired(this.gateStage(), await this.gateFacts(args));
      return outcome(gate as unknown as Record<string, unknown>, {
        [META.input_required]: { stage: gate.stage, inputRequests: gate.inputRequests },
      });
    }

    const document = await this.idempotent("hold_seats", key, holdSeatsDigest(request), () =>
      holdSeats(this.options.db, request, this.options.credential, this.options.hold_seats ?? {}),
    );
    return outcome(document as unknown as Record<string, unknown>);
  }

  /* -- get_hold / release_hold / hand_off ---------------------------------- */

  private async getHold(args: Record<string, unknown>): Promise<ToolOutcome> {
    const document = await getHold(
      this.options.db,
      String(args.hold_id),
      this.options.credential,
      this.options.get_hold ?? {},
    );
    return outcome(document as unknown as Record<string, unknown>);
  }

  private async releaseHold(args: Record<string, unknown>): Promise<ToolOutcome> {
    const hold_id = String(args.hold_id);
    const key = this.keyOf(args, "release_hold", false);
    const run = () => releaseHold(this.options.db, hold_id, this.options.credential);
    const result =
      key === undefined
        ? await run()
        : await this.idempotent("release_hold", key, releaseHoldDigest(hold_id), run);
    return outcome({
      changeover: "0.1",
      hold_id: result.hold_id,
      state: result.state,
      released_at: result.released_at,
      seats_freed: result.seats_freed,
      server_time: result.server_time,
    });
  }

  private async handOff(args: Record<string, unknown>): Promise<ToolOutcome> {
    const hold_id = String(args.hold_id);
    const read_token = String(args.read_token);
    const key = this.keyOf(args, "hand_off", true) as string;

    if (gates("hand_off", this.options.gate ?? {})) {
      const facts = await this.handOffGateFacts(hold_id);
      const gate = inputRequired(this.gateStage(), facts);
      return outcome(gate as unknown as Record<string, unknown>, {
        [META.input_required]: { stage: gate.stage, inputRequests: gate.inputRequests },
      });
    }

    const document = await this.idempotent(
      "hand_off",
      key,
      handOffDigest(hold_id),
      async () =>
        (
          await handOff(
            this.options.db,
            { hold_id, read_token },
            this.options.credential,
            this.options.hand_off ?? {},
          )
        ).hold,
    );
    return outcome(document as unknown as Record<string, unknown>);
  }

  private async handOffGateFacts(hold_id: string): Promise<GateFacts> {
    const r = await this.options.db.query<{ occasion_id: string; seats: number }>(
      "select h.occasion_id as occasion_id, count(s.seat_id)::int as seats" +
        " from hold h left join hold_seat s on s.hold_id = h.hold_id" +
        " where h.hold_id = $1 group by h.occasion_id",
      [hold_id],
    );
    const row = r.rows[0];
    if (row === undefined) throw refuse("hold_not_found", "No such Hold for this principal.");
    return this.gateFacts({ occasion_id: row.occasion_id, seats: new Array(row.seats).fill("") });
  }

  /* -- Shared plumbing ------------------------------------------------------ */

  private keyOf(
    args: Record<string, unknown>,
    verb: IdempotentVerb,
    required: boolean,
  ): string | undefined {
    const key = args.idempotency_key;
    if (key === undefined) {
      if (required) throw refuse("schema_validation", `${verb} requires an idempotency_key.`);
      return undefined;
    }
    // The schema already bounds this, and asserting again is not redundancy:
    // `assertKeyShape` is CORE-005's own predicate and is what the store was
    // built against. §6.2's ceiling is the tighter of the two and is enforced
    // by the schema above; this catches the shape.
    assertKeyShape(key);
    if (String(key).length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw refuse("schema_validation", "idempotency_key exceeds the published maxLength of 128.");
    }
    return key as string;
  }

  private async idempotent<T extends object>(
    verb: IdempotentVerb,
    key: string,
    digest: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    const result = await withIdempotency(
      this.options.db,
      {
        agent_id: this.options.credential.agent_id,
        principal_scope: this.options.credential.principal_scope,
        verb,
        idempotency_key: key,
      },
      digest,
      execute,
    );
    if (result.disposition === "input_required") {
      // Unreachable: the gate is decided above, before the key is claimed. If
      // it were reachable, inventing a document here would be inventing a Hold.
      throw new Error(`${verb} returned an InputRequiredResult inside the idempotency layer`);
    }
    return result.record;
  }
}

/* -- The MCP Server object -------------------------------------------------- */

/**
 * The SDK `Server` with the two handlers bound. Low-level rather than
 * `McpServer.registerTool`, because `registerTool` takes Zod shapes and
 * generates JSON Schema from them — and SEP-2106 asks for a schema, not for a
 * schema-shaped rendering of a validator. These schemas are the frozen ones
 * (`tools.ts`), and going through a generator is how a `uniqueItems` quietly
 * stops being emitted.
 */
export function createMcpServer(options: McpServerOptions): {
  readonly server: Server;
  readonly binding: ChangeoverMcp;
} {
  const binding = new ChangeoverMcp(options);
  const server = new Server(
    { name: "changeover", version: "0.1.0" },
    // No sampling, no roots, no logging: all three are deprecated in
    // 2026-07-28 and a conforming Server MUST NOT depend on them. Declaring a
    // capability is how depending on one starts.
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: binding.listTools().map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    })),
    _meta: { [META.binding]: MCP_BINDING_VERSION },
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await binding.callTool(request.params.name, request.params.arguments);
    return result as unknown as Record<string, unknown>;
  });

  return { server, binding };
}

export { Refusal, TOOLS };
