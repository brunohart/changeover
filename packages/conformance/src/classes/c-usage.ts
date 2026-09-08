// C-USAGE. Owner: TEST-006.
//
// §7, the first half of the C-USAGE / C-PROFILE0 row: *"`usage_policy` present
// and honoured by the reference Agent."* C-PROFILE0 is the other half.
//
// **Why the terms matter more here than anywhere else in the document.** §10
// records a reviewer overruled: Profile 0 was called a compass violation because
// a file an exhibitor publishes is a file anyone can take. The ruling was that a
// file published at your own origin, under stated terms, with authentication
// available, is the opposite of being scraped — *and that the defect was the
// missing terms, which `usage_policy` supplies*. That makes this member the
// thing standing between a published Occasion and an unbounded harvest, so
// "present" is not a formality: an absent or malformed `usage_policy` removes
// the answer to the objection the whole profile survives on.
//
// **The obvious cheap check is `typeof document.usage_policy === "object"`.** It
// would pass on a policy with a `redistribution` value outside the closed enum,
// which an Agent's switch statement would fall through — silently choosing the
// permissive branch, because nobody writes a default case that refuses. So the
// document goes through the compiled ajv validator, where the enum and
// `additionalProperties: false` bind, and the closed set is then compared with
// the value that arrived.
//
// **`cache_max_age_ms` is asserted against the wire, not against itself.** §6.3
// tells an Agent it MUST NOT retain an Occasion beyond that number. A Server
// that then serves its Occasions with a longer `Cache-Control` has instructed
// every intermediary between it and that Agent to do what it just told the Agent
// not to — no rule names this, which is precisely why nothing else in the tree
// would notice it. The clause is one-sided (`≤`), so a Server that caches for
// less, or not at all, is not failed for being conservative.
//
// **`contact` and the outbound canary.** C-ABSENCE.4 fails the build on any
// response body matching an email, and TEST-004 resolved the collision
// deliberately: the operator address is read from the configuration and
// accounted for, because a venue's own published contact is not a person's
// data. That ruling is honoured rather than relitigated here — and it has a
// condition attached which nothing was checking, that the declared address is
// the ONLY email-shaped string in the document. An operator's address arriving
// through `attribution_text` or a venue name would otherwise be a leak wearing
// the shape of a policy member.

import { EMAIL, E164, luhnRuns } from "../absence/patterns.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { ConformanceBench } from "./_bench.ts";
import { OCCASION, TOKEN } from "./_bench.ts";

const CAPABILITY_SCHEMA_ID = "urn:changeover:schema:capability:0.1";
const VALIDATOR_LIB = "packages/adapter-reference/test/lib/schema-validator.ts";

/** `usage_policy.redistribution`, as the frozen schema closes it. */
const REDISTRIBUTION: readonly string[] = Object.freeze(["forbidden", "attributed", "allowed"]);

export const id = "C-USAGE";
export const spec_row = "usage_policy present and honoured by the reference Agent.";

interface UsagePolicy {
  readonly redistribution?: unknown;
  readonly cache_max_age_ms?: unknown;
  readonly attribution_text?: { readonly value?: unknown };
  readonly terms_url?: unknown;
  readonly contact?: unknown;
}

/** `max-age` in seconds from a Cache-Control header, or null where it names none. */
function maxAgeSeconds(header: string | null): number | null {
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(header ?? "");
  return match === null ? null : Number(match[1]);
}

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  /* ── 1 · Present, on the document the protocol bootstraps from ────────── */

  const capability = await bench.call("GET", "/.well-known/changeover");
  const document = (capability.json ?? {}) as { usage_policy?: UsagePolicy };
  const policy = document.usage_policy;
  if (policy === undefined || policy === null || typeof policy !== "object") {
    c.bad("present", `the capability document carries no usage_policy (${capability.status})`);
    return c.items;
  }
  c.ok(
    "present",
    `GET /.well-known/changeover carries usage_policy with ${Object.keys(policy).length} members`,
  );

  const required = ["redistribution", "cache_max_age_ms", "contact"] as const;
  const missing = required.filter((member) => policy[member] === undefined);
  c.is(
    "required_members",
    missing.join(",") || "none missing",
    "none missing",
    `its three REQUIRED members are all there (${required.join(", ")})`,
  );

  /* ── 2 · Validates, where the closed enum actually binds ──────────────── */

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
      "validates",
      "the compiled ajv validator over the frozen schemas could not be loaded, and checking the members against a list retyped here would assert this file against itself",
      VALIDATOR_LIB,
    );
  } else {
    const error = validator(CAPABILITY_SCHEMA_ID, capability.json);
    c.is(
      "validates",
      error,
      null,
      "the document carrying it validates against the frozen capability.schema.json, where usage_policy is additionalProperties: false and redistribution is a closed enum",
    );

    const widened = {
      ...(capability.json as Record<string, unknown>),
      usage_policy: { ...policy, redistribution: "negotiable" },
    };
    c.that(
      "validates_control",
      validator(CAPABILITY_SCHEMA_ID, widened) !== null,
      "and a fourth redistribution value is rejected by that same validator, so the clause above is the schema binding and not the validator waving everything through",
    );
  }

  c.that(
    "redistribution_closed",
    typeof policy.redistribution === "string" && REDISTRIBUTION.includes(policy.redistribution),
    `redistribution is one of the three the schema permits and this site publishes ${String(policy.redistribution)} — the value §6.3 attaches its strongest MUST NOT to`,
  );

  /* ── 3 · The retention bound, against what the wire actually says ─────── */

  const cache_max_age_ms = Number(policy.cache_max_age_ms);
  c.that(
    "retention_bound_stated",
    Number.isInteger(cache_max_age_ms) && cache_max_age_ms >= 0,
    `cache_max_age_ms is an integer of milliseconds (${cache_max_age_ms}) — the bound §6.3 forbids an Agent to retain an Occasion beyond`,
  );

  const bearers: { label: string; header: string | null }[] = [];
  const page = await bench.call("GET", "/changeover/v0/occasions", { token: TOKEN.a });
  bearers.push({ label: "GET /occasions", header: page.headers.get("cache-control") });
  const one = await bench.call("GET", `/changeover/v0/occasions/${OCCASION.main}`, { token: TOKEN.a });
  bearers.push({ label: "GET /occasions/{id}", header: one.headers.get("cache-control") });
  const static_file = await bench.call0("GET", "/.well-known/changeover");
  bearers.push({ label: "GET /.well-known/changeover (Profile 0, Occasions inline)", header: static_file.headers.get("cache-control") });

  const over: string[] = [];
  for (const bearer of bearers) {
    const seconds = maxAgeSeconds(bearer.header);
    if (seconds !== null && seconds * 1000 > cache_max_age_ms) {
      over.push(`${bearer.label}=${bearer.header ?? "no header"}`);
    }
  }
  c.is(
    "retention_bound_honoured_on_the_wire",
    over.join(" · ") || "none",
    "none",
    `no response carrying an Occasion instructs a cache to keep it longer than the policy permits an Agent to (${bearers.map((b) => `${b.label} → ${b.header ?? "no cache-control"}`).join(" · ")})`,
  );

  /* ── 4 · Nothing in the terms is a person ─────────────────────────────── */

  const body = capability.text;
  const emails = [...new Set(body.match(EMAIL) ?? [])];
  const declared = typeof policy.contact === "string" ? policy.contact : "";
  const undeclared = emails.filter((address) => address !== declared);
  c.is(
    "contact_accounted_for",
    undeclared.join(", ") || "none",
    "none",
    `every email-shaped string in the served document is the operator address the site declares at usage_policy.contact (${declared || "none declared"}), which is the accounting C-ABSENCE.4's canary is built on`,
  );
  c.that(
    "contact_control",
    (("boxoffice@embassy.example".match(EMAIL) ?? []).length === 1),
    "and that pattern does match an address, so the clause above is an accounting and not a regex that never fires",
  );

  const phones = [...new Set(body.match(E164) ?? [])];
  const cards = luhnRuns(body);
  c.is(
    "no_other_personal_shape",
    [...phones, ...cards].join(", ") || "none",
    "none",
    "and the terms carry no E.164 string and no Luhn-valid digit run — the attribution text and the venue name are the two members an operator is most likely to put one in",
  );

  /* ── 5 · Honoured by the reference Agent ──────────────────────────────── */

  c.cannot(
    "agent_honours",
    "§6.3's Usage rule binds an AGENT — MUST NOT persist, republish or serve to a third party an Occasion whose redistribution is forbidden, and MUST NOT retain one beyond cache_max_age_ms — and no Agent exists in this repository. The Server half is asserted above, on the document and on the wire; what an Agent does with a document it has already been given is not observable at the boundary that gave it, and an Agent written here could not falsify the claim",
    "packages/agent",
  );

  return c.items;
}
