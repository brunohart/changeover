/**
 * The five tools. `inputSchema` and `outputSchema` are full JSON Schema
 * 2020-12 (SEP-2106), self-contained, and constrained **identically to the
 * HTTP binding**.
 *
 * §6.2 names the reason in one sentence: *"The draft left `intent_digest`
 * unconstrained here, so a Server accepting `\"sarah.chen@gmail.com\"` and
 * echoing it emitted a Hold failing its own schema."* A binding that relaxes a
 * constraint the other enforces does not produce a laxer server — it produces
 * a server that emits documents the specification rejects while believing it
 * conforms, and it does so along the one path that carries personal data into
 * a system whose entire privacy posture (§5.6, D1) is that none arrives.
 *
 * So every constraint below is sourced rather than typed: the seat array is
 * `schemas/hold.schema.json`'s own `seats`, the etag pattern is
 * `common.schema.json`'s own `$defs/etag`, and the output schemas are the
 * frozen documents, bundled. What is written by hand here is only what no
 * frozen schema covers — the request members, which are not documents.
 *
 * **`hold_id` is server-minted (SEP-2567).** MCP removed protocol-level
 * sessions; the prescribed replacement is *"explicit, server-minted handles
 * passed as ordinary tool arguments."* So `hold_id` is required on the three
 * tools that address a Hold and **absent from `hold_seats`'s input** — an
 * Agent has no member to put a synthesised one in. Z2 requires a CSPRNG and an
 * agent-chosen id would be both guessable and a way to address another
 * principal's Hold by construction.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DIALECT_2020_12, SCHEMA_DIR, SCHEMA_IRI, bundle } from "./bundle.ts";

type JsonObject = Record<string, unknown>;

function frozen(file: string): JsonObject {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as JsonObject;
}

const HOLD_SCHEMA = frozen("hold.schema.json");
const COMMON_SCHEMA = frozen("common.schema.json");

const commonDefs = COMMON_SCHEMA.$defs as JsonObject;
const holdProperties = HOLD_SCHEMA.properties as JsonObject;

/* -- The constraints, taken from where they are already frozen ------------- */

/**
 * §4.6 W2: `uniqueItems`, *"refused `400 schema_validation` before any lock is
 * taken"* — otherwise `["F:11","F:11"]` trips the primary key, is reported as
 * `seat_contended`, and the Agent loops forever re-resolving a free seat. The
 * schema is the Hold document's own, so the array a caller may send and the
 * array a Hold may carry cannot come apart.
 */
export const SEATS_SCHEMA: JsonObject = holdProperties.seats as JsonObject;

/** `^1:[A-Za-z0-9_-]{43}$`, unquoted — §6.3's wire form, unaffected by transport. */
export const ETAG_SCHEMA: JsonObject = commonDefs.etag as JsonObject;

/** Z3: opaque. 1–128 characters, not parsed, not ordered, not enumerable. */
export const OPAQUE_ID_SCHEMA: JsonObject = commonDefs.opaqueId as JsonObject;

/**
 * §5.5 / D4. 43 characters of base64url — a SHA-256, and nothing that is not
 * one. This is the constraint the draft omitted here, and the pattern is what
 * makes an email address a `schema_validation` refusal at the boundary rather
 * than a member of a Hold.
 */
export const INTENT_DIGEST_SCHEMA: JsonObject = {
  type: "string",
  pattern: "^[A-Za-z0-9_-]{43}$",
  description:
    "D4: SHA-256 base64url over the customer's expressed intent. Accepted and never echoed. Not a place to put text.",
};

/**
 * §6.2, in as many words: `idempotency_key` `maxLength 128`. I1's *"MUST carry
 * >=128 bits from a CSPRNG"* is entropy, not length; a 22-character base64url
 * string already carries 132 bits, so the ceiling costs no legitimate caller
 * anything and stops a body being smuggled through a header-shaped member.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export const IDEMPOTENCY_KEY_SCHEMA: JsonObject = {
  type: "string",
  minLength: 22,
  maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
  pattern: "^[A-Za-z0-9._~:@!$'()*+,;=-]{22,128}$",
  description:
    "I1: >=128 bits from a CSPRNG. MUST NOT be derived from an order reference, a conversation id, or any predictable value.",
};

const SOUGHT_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["occasion_id", "occasion_etag"],
  properties: { occasion_id: OPAQUE_ID_SCHEMA, occasion_etag: ETAG_SCHEMA },
  description:
    "§2.3: the Occasion the customer's expressed intent selected. Where it differs from occasion_id, S1 decides whether the crossing is permitted.",
};

const SELECTION_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "quantity"],
  properties: {
    mode: { const: "best_available" },
    quantity: { type: "integer", minimum: 1, maximum: 12 },
    together: { type: "boolean" },
    offer_id: OPAQUE_ID_SCHEMA,
  },
};

const DURATION_MS_SCHEMA: JsonObject = { type: "integer", minimum: 0 };

const RFC3339_SCHEMA: JsonObject = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?([+-]\\d{2}:\\d{2}|Z)$",
};

/* -- The five input schemas ------------------------------------------------ */

const RESOLVE_OCCASIONS_INPUT: JsonObject = {
  $schema: DIALECT_2020_12,
  type: "object",
  additionalProperties: false,
  properties: {
    from: RFC3339_SCHEMA,
    to: RFC3339_SCHEMA,
    page_size: { type: "integer", minimum: 1, maximum: 200 },
    cursor: { type: "string", maxLength: 512 },
  },
};

const HOLD_SEATS_INPUT: JsonObject = {
  $schema: DIALECT_2020_12,
  type: "object",
  additionalProperties: false,
  required: ["occasion_id", "occasion_etag", "sought", "requested_floor_ms", "idempotency_key"],
  // Exactly one of seats / selection. Expressed structurally rather than in
  // prose, because a caller sending both is asking for two different holds and
  // a Server that picked one would grant seats nobody named. `false` as a
  // subschema is 2020-12's "this member may not appear" — written that way
  // rather than as `not: { required: [...] }` so that every name a branch
  // requires is a name that branch also declares, which is what a strict
  // validator checks and what a reader needs.
  oneOf: [
    { required: ["seats"], properties: { seats: true, selection: false } },
    { required: ["selection"], properties: { seats: false, selection: true } },
  ],
  properties: {
    occasion_id: OPAQUE_ID_SCHEMA,
    occasion_etag: ETAG_SCHEMA,
    sought: SOUGHT_SCHEMA,
    seats: SEATS_SCHEMA,
    selection: SELECTION_SCHEMA,
    requested_floor_ms: DURATION_MS_SCHEMA,
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
    intent_digest: INTENT_DIGEST_SCHEMA,
  },
};

/** SEP-2567: the handle the Server minted, passed back as an ordinary argument. */
const HOLD_ID_ONLY: JsonObject = {
  $schema: DIALECT_2020_12,
  type: "object",
  additionalProperties: false,
  required: ["hold_id"],
  properties: { hold_id: OPAQUE_ID_SCHEMA },
};

const RELEASE_HOLD_INPUT: JsonObject = {
  $schema: DIALECT_2020_12,
  type: "object",
  additionalProperties: false,
  required: ["hold_id"],
  properties: { hold_id: OPAQUE_ID_SCHEMA, idempotency_key: IDEMPOTENCY_KEY_SCHEMA },
};

const HAND_OFF_INPUT: JsonObject = {
  $schema: DIALECT_2020_12,
  type: "object",
  additionalProperties: false,
  required: ["hold_id", "read_token", "idempotency_key"],
  properties: {
    hold_id: OPAQUE_ID_SCHEMA,
    // T4. The token get_hold minted, and the reason hand_off is guarded on
    // freshness rather than on state: a thing an agent must not do should not
    // merely be asked not to do.
    read_token: { type: "string", minLength: 1, maxLength: 512 },
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
  },
};

/* -- The five output schemas ----------------------------------------------- */

const OCCASION_BUNDLE = bundle(SCHEMA_IRI.occasion);
const HOLD_BUNDLE = bundle(SCHEMA_IRI.hold);

/**
 * Embedding a bundle inside another schema means hoisting its `$defs` to the
 * new root: a `$ref` of `#/$defs/common_0_1/...` is resolved against the
 * **document root**, so an occasion bundle sitting under
 * `properties.occasions.items` with its `$defs` still attached to itself
 * resolves nothing. Measured, not reasoned about — ajv refuses to compile it.
 */
function embed(bundled: JsonObject): { readonly schema: JsonObject; readonly defs: JsonObject } {
  const { $schema: _dialect, $defs, ...rest } = bundled;
  return { schema: rest as JsonObject, defs: ($defs ?? {}) as JsonObject };
}

const OCCASION_EMBEDDED = embed(OCCASION_BUNDLE);

const RESOLVE_OCCASIONS_OUTPUT: JsonObject = {
  $schema: DIALECT_2020_12,
  type: "object",
  additionalProperties: false,
  required: ["changeover", "occasions", "server_time"],
  properties: {
    changeover: { const: "0.1" },
    occasions: { type: "array", items: OCCASION_EMBEDDED.schema },
    next_cursor: { type: ["string", "null"], maxLength: 512 },
    server_time: RFC3339_SCHEMA,
  },
  $defs: OCCASION_EMBEDDED.defs,
};

const HOLD_OUTPUT: JsonObject = HOLD_BUNDLE;

const RELEASE_HOLD_OUTPUT: JsonObject = {
  $schema: DIALECT_2020_12,
  type: "object",
  additionalProperties: false,
  required: ["changeover", "hold_id", "state", "seats_freed", "server_time"],
  properties: {
    changeover: { const: "0.1" },
    hold_id: OPAQUE_ID_SCHEMA,
    // R2: release_hold is total. Every one of these five is a 204, and the
    // state is what happened rather than whether it worked.
    state: { enum: ["live", "released", "expired", "claimed", "revoked"] },
    released_at: { anyOf: [RFC3339_SCHEMA, { type: "null" }] },
    seats_freed: { type: "integer", minimum: 0 },
    server_time: RFC3339_SCHEMA,
  },
};

/* -- The table ------------------------------------------------------------- */

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
}

/**
 * Five, and the count is the assertion. `C-ABSENCE.1` reads this list: a tool
 * that does not appear in `tools/list` cannot be selected by a model, so the
 * absence of settlement is enforced at the only surface a model looks at.
 * There is no sixth entry to add, disabled or permission-checked or deferred.
 */
export const TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: "resolve_occasions",
    title: "Resolve occasions",
    description:
      "List the screenings this site publishes, each as a complete Occasion document with its own etag. Read-only. The result carries a freshness contract: do not reuse it past its ttl.",
    inputSchema: RESOLVE_OCCASIONS_INPUT,
    outputSchema: RESOLVE_OCCASIONS_OUTPUT,
  },
  {
    name: "hold_seats",
    title: "Hold seats",
    description:
      "Hold named seats for a stated, irrevocable window, then hand the customer back to the exhibitor's own checkout with the seats still there. Grants nothing else: this boundary does not settle, and holding is not buying.",
    inputSchema: HOLD_SEATS_INPUT,
    outputSchema: HOLD_OUTPUT,
  },
  {
    name: "get_hold",
    title: "Get hold",
    description:
      "Read one Hold and mint the read_token hand_off requires. Total: an expired or revoked Hold reads back with what happened to it, never as absent.",
    inputSchema: HOLD_ID_ONLY,
    outputSchema: HOLD_OUTPUT,
  },
  {
    name: "release_hold",
    title: "Release hold",
    description:
      "Give the seats back before the window ends. Total for every Hold you may address, except one already handed off — a hand-off is agent-terminal and the seats then belong to the customer.",
    inputSchema: RELEASE_HOLD_INPUT,
    outputSchema: RELEASE_HOLD_OUTPUT,
  },
  {
    name: "hand_off",
    title: "Hand off",
    description:
      "End the agent's part: mint a single-consumption claim URL for the customer to open in the exhibitor's own checkout, with the seats still held. Requires the read_token from a fresh get_hold.",
    inputSchema: HAND_OFF_INPUT,
    outputSchema: HOLD_OUTPUT,
  },
]);

export const TOOL_NAMES: readonly string[] = Object.freeze(TOOLS.map((tool) => tool.name));

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
