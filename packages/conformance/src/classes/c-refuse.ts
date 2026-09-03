// C-REFUSE. Owner: TEST-006.
//
// §7: *"Refusals never mixed with rows; guard order per G1 against a fixture
// failing four guards at once; every refusal validates against its code's closed
// `detail` branch; a refusal carrying an extra member is rejected by the
// reference Agent."*
//
// **The four-guard fixture is peeled, not merely asserted.** A single request
// failing four guards proves only that *something* answered first, and a Server
// that always answered `schema_validation` would pass it. So the request is sent
// four times, each time with one failure repaired, and the codes must come back
// in G1's own order: `schema_validation`, then `occasion_moved`, then
// `substitution_refused`, then `unknown_seat`. Each step is a different
// remediation with different retry semantics — re-read, re-resolve, re-resolve,
// fix your input — which is the entire reason the order is part of the wire
// contract and not an implementation detail.
//
// G1 step 1 is asserted against the Profile 0 server, because `profile` is the
// only guard that precedes `schema`: a body that fails validation still answers
// `501 profile_not_supported` where the site publishes no hold verbs, and a
// Server that validated first would leak that the surface exists.
//
// **The `detail` branch is validated against the frozen schema**, not against a
// list retyped here, with `type`/`status`/`title` removed first — the three RFC
// 9457 members BUILD-CONTRACT §6's default ruling adds to the HTTP body over and
// above the refusal document, which is `additionalProperties: false`.

import { G1, G1_CODES_IN_ORDER, G1_READ_ONLY_THROUGH, firstInG1Order, g1StepOf } from "@changeover/core/guards.ts";
import { REFUSAL_STATUS } from "@changeover/schema/refusal.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { Call, ConformanceBench } from "./_bench.ts";
import { ETAG, OCCASION, TOKEN, holdBody, key } from "./_bench.ts";

const REFUSAL_SCHEMA_ID = "urn:changeover:schema:refusal:0.1";
const VALIDATOR_LIB = "packages/adapter-reference/test/lib/schema-validator.ts";

/** The three members RFC 9457 adds over the refusal document (BUILD-CONTRACT §6). */
const PROBLEM_MEMBERS: readonly string[] = Object.freeze(["type", "status", "title"]);

/** Members that only ever appear on a granted Hold. A refusal carrying one is mixed. */
const ROW_MEMBERS: readonly string[] = Object.freeze([
  "hold_id",
  "seats",
  "granted_at",
  "floor_ms",
  "floor_deadline",
  "expires_at",
  "state",
  "read_token",
  "handoff",
  "occasions",
]);

export const id = "C-REFUSE";
export const spec_row =
  "Refusals never mixed with rows; guard order per G1 against a fixture failing four guards at once; every refusal validates against its code's closed detail branch; a refusal carrying an extra member is rejected by the reference Agent.";

function refusalDocument(call: Call): Record<string, unknown> {
  const body = { ...(call.json as Record<string, unknown> | null ?? {}) };
  for (const member of PROBLEM_MEMBERS) delete body[member];
  return body;
}

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  /* ── 1 · The four-guard fixture, peeled one repair at a time ──────────── */
  //
  // Every variant below fails EVERY guard the ones after it fail. Repairing one
  // failure therefore reveals exactly the next code in G1 order, and nothing
  // else changes between calls.

  const crossing = { occasion_id: OCCASION.sought, occasion_etag: ETAG[OCCASION.sought] };
  const stale_etag = "1:0000000000000000000000000000000000000000000";
  const unknown_seat = "ZZ:999";

  const variants: { repaired: string; expect: string; body: Record<string, unknown> }[] = [
    {
      repaired: "nothing",
      expect: "schema_validation",
      body: holdBody([unknown_seat], {
        occasion_etag: stale_etag,
        sought: crossing,
        not_a_member_of_this_schema: true,
      }),
    },
    {
      repaired: "the unknown member",
      expect: "occasion_moved",
      body: holdBody([unknown_seat], { occasion_etag: stale_etag, sought: crossing }),
    },
    {
      repaired: "and the etag",
      expect: "substitution_refused",
      body: holdBody([unknown_seat], { sought: crossing }),
    },
    {
      repaired: "and the sought",
      expect: "unknown_seat",
      body: holdBody([unknown_seat]),
    },
  ];

  const rows_before = await bench.db.query<{ n: string }>(
    "select (select count(*) from hold)::text || '/' || (select count(*) from hold_seat)::text as n",
  );

  const answered: string[] = [];
  const refusals: Call[] = [];
  for (const variant of variants) {
    const response = await bench.call("POST", "/changeover/v0/holds", {
      token: TOKEN.a,
      headers: { "Idempotency-Key": key(`refuse-${variant.expect}-${bench.nonce}`) },
      body: variant.body,
    });
    refusals.push(response);
    answered.push(String((response.json as { code?: string } | null)?.code ?? `HTTP ${response.status}`));
  }

  c.is(
    "g1_order",
    answered.join(" → "),
    variants.map((v) => v.expect).join(" → "),
    "one request failing four guards at once answers the FIRST in G1 order, and repairing one failure at a time reveals the next — four distinct codes with four distinct remediations",
  );

  const steps = answered.map((code) => g1StepOf(code as never));
  c.that(
    "g1_ascending",
    steps.every((s, i) => s !== undefined && (i === 0 || (s as number) > (steps[i - 1] as number))),
    `and the G1 steps those codes sit at are strictly ascending: ${steps.join(", ")}`,
  );

  const rows_after = await bench.db.query<{ n: string }>(
    "select (select count(*) from hold)::text || '/' || (select count(*) from hold_seat)::text as n",
  );
  c.is(
    "g1_read_only",
    rows_after.rows[0]?.n,
    rows_before.rows[0]?.n,
    `none of the four wrote a hold or hold_seat row — G1 is read-only through step ${G1_READ_ONLY_THROUGH} and every step these four sit at is declared writes: false`,
  );

  /* ── 2 · Step 1 precedes step 2 ───────────────────────────────────────── */

  const profile_first = await bench.call0("POST", "/changeover/v0/holds", {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`refuse-profile-${bench.nonce}`) },
    body: variants[0]!.body,
  });
  c.that(
    "g1_step1",
    profile_first.status === 501 &&
      (profile_first.json as { code?: string } | null)?.code === "profile_not_supported",
    `the SAME body that answers schema_validation at Profile 1 answers 501 profile_not_supported at Profile 0, so the profile guard runs before validation and a site publishing no hold verbs does not leak that the surface parses (got ${profile_first.status})`,
  );

  /* ── 3 · Never mixed with rows ────────────────────────────────────────── */

  let mixed = 0;
  for (const response of [...refusals, profile_first]) {
    const body = (response.json as Record<string, unknown> | null) ?? {};
    if (body.refused !== true) {
      c.bad("refused_flag", `a refusal body did not carry refused: true — ${JSON.stringify(body).slice(0, 160)}`);
    }
    for (const member of ROW_MEMBERS) {
      if (member in body) {
        mixed++;
        c.bad("never_mixed", `a refusal carried the row member ${member}: ${JSON.stringify(body).slice(0, 160)}`);
      }
    }
  }
  if (mixed === 0) {
    c.ok(
      "never_mixed",
      "no refusal carries a hold, a seat list, a read_token or a page of Occasions — first failure wins and there is no partial result beside it",
    );
  }

  /* ── 4 · Status agrees with the code, in both directions ──────────────── */

  let status_ok = 0;
  for (const response of [...refusals, profile_first]) {
    const code = (response.json as { code?: keyof typeof REFUSAL_STATUS } | null)?.code;
    if (code !== undefined && REFUSAL_STATUS[code] === response.status) status_ok++;
    else c.bad("status", `code ${String(code)} answered HTTP ${response.status}, and REFUSAL_STATUS says ${String(code && REFUSAL_STATUS[code])}`);
  }
  if (status_ok === refusals.length + 1) {
    c.ok("status", `every refusal's HTTP status is REFUSAL_STATUS[code] — ${status_ok} of ${status_ok}`);
  }

  /* ── 5 · Every refusal validates against its code's closed detail branch ─ */

  let validator: ((schema_id: string, value: unknown) => string | null) | null = null;
  try {
    const lib = (await import("../../../adapter-reference/test/lib/schema-validator.ts")) as {
      schemaValidator: () => (schema_id: string, value: unknown) => string | null;
    };
    validator = lib.schemaValidator();
  } catch {
    validator = null;
  }

  if (validator === null) {
    c.cannot(
      "detail_branch",
      "the compiled ajv validator over the frozen schemas could not be loaded, and validating a refusal against a list of members retyped here would assert this file against itself",
      VALIDATOR_LIB,
    );
  } else {
    let validated = 0;
    for (const response of [...refusals, profile_first]) {
      const document = refusalDocument(response);
      const error = validator(REFUSAL_SCHEMA_ID, document);
      if (error === null) validated++;
      else {
        c.bad(
          "detail_branch",
          `a ${String(document.code)} refusal does not validate against refusal.schema.json: ${error}`,
        );
      }
    }
    if (validated === refusals.length + 1) {
      c.ok(
        "detail_branch",
        `all ${validated} refusals validate against the frozen refusal schema once the three RFC 9457 members are removed — each detail against its own code's closed oneOf branch`,
      );
    }

    // The other direction: the schema must actually reject an extra member.
    // Without this the clause above would pass against a schema someone had
    // relaxed to additionalProperties: true.
    const poisoned = { ...refusalDocument(refusals[1] as Call), an_extra_member: "instruction" };
    c.that(
      "extra_member_invalid",
      validator(REFUSAL_SCHEMA_ID, poisoned) !== null,
      "and a refusal carrying one extra member fails that same validation, so the branch is closed rather than merely satisfied",
    );

    // And the RFC 9457 members are present on the wire, since the ruling above
    // is what makes removing them legitimate rather than convenient.
    const wire = (refusals[1] as Call).json as Record<string, unknown>;
    c.that(
      "problem_json",
      PROBLEM_MEMBERS.every((m) => m in wire) && String(wire.type).startsWith("urn:changeover:refusal:"),
      `the HTTP body carries exactly type/status/title over the refusal document, and type is a URN naming the code (${String(wire.type)})`,
    );
  }

  /* ── 6 · The table this is asserted against ───────────────────────────── */

  c.is(
    "g1_table",
    G1.length,
    12,
    `G1 is ${G1.length} steps over ${G1_CODES_IN_ORDER.length} codes, and firstInG1Order picks ${String(firstInG1Order(["unknown_seat", "occasion_moved", "schema_validation"]))} out of an unordered set`,
  );

  /* ── 7 · The consumer half ────────────────────────────────────────────── */

  c.cannot(
    "agent_rejects_extra",
    "'rejected by the reference Agent' is a property of an Agent, and no Agent exists in this repository. The structural half is asserted above — refusal.schema.json is additionalProperties: false and a poisoned document fails it — but an Agent's refusal to act on one cannot be observed without an Agent, and one written here could not falsify the claim",
    "packages/agent",
  );

  return c.items;
}
