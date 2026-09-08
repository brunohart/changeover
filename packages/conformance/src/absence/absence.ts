/**
 * C-ABSENCE — the four locks of SPEC.md §5.1, run.
 * Owner: TEST-004.
 *
 * §7's row: **.1** no settlement verb anywhere. **.2** member manifest set
 * equality. **.3** the `SET LOCAL ROLE` kill test raises `insufficient_privilege`.
 * **.4** outbound byte canary: no response body matches an email, a Luhn-valid
 * 13–19 digit run, or an E.164 string — *fail the build, do not filter the
 * response*.
 *
 * Each function returns clause results rather than printing them, so the same
 * four assertions serve `scripts/prove_write_path_pii_absent.sh` and, when
 * `packages/conformance/src/classes/_bench.ts` exists, a class module that maps
 * these onto `ClauseOutcome`. The mapping is one line per clause; the shape is
 * kept local deliberately, because a proof that cannot run until a neighbour's
 * interface compiles is a proof that reports nothing on the day it is needed.
 */

import { readFileSync } from "node:fs";

import { ROUTES } from "@changeover/http/routes.ts";
import { TOOLS } from "@changeover/mcp/tools.ts";

import type { Body, SettlementCall } from "./bodies.ts";
import { CAPABILITY_LABEL, POISON, httpBodies, mcpBodies } from "./bodies.ts";
import type { Db } from "@changeover/store/db.ts";
import {
  KILL_TESTS,
  NEGATIVE_CONTROLS,
  loginRole,
  nameHits,
  physicalNames,
  runKillTest,
} from "./grants.ts";
import { DOCUMENT_SCHEMAS, declaredMembers, setEquality } from "./manifest.ts";
import { SETTLEMENT_SURFACE, valueHits } from "./patterns.ts";

export interface Clause {
  /** `C-ABSENCE.3/insert_occasion` — the lock, then what was attempted. */
  readonly clause: string;
  readonly ok: boolean;
  readonly note: string;
}

const held = (clause: string, note: string): Clause => ({ clause, ok: true, note });
const broke = (clause: string, note: string): Clause => ({ clause, ok: false, note });

/* ── .1 · Surface ─────────────────────────────────────────────────────────── */

/**
 * `tools/list` and every HTTP route, against §6.2's pattern — which carries
 * `price`, unlike the member pattern, for the reason
 * `scripts/prove_no_settlement_verb.sh` states.
 *
 * The declared halves are asserted over the tables, and then asserted again over
 * a socket and a connected client. A route table is a claim about a router; a
 * `404` is the router answering. The two can disagree, and a hand-written branch
 * that never reached the table is precisely how they would.
 */
export function surfaceClauses(
  listedTools: readonly string[],
  settlementStatuses: readonly number[],
  settlementCalls: readonly SettlementCall[],
): Clause[] {
  const out: Clause[] = [];

  out.push(
    listedTools.length === 5
      ? held("C-ABSENCE.1/tool_count", "tools/list carries exactly 5 tools: " + listedTools.join(", "))
      : broke("C-ABSENCE.1/tool_count", `tools/list carries ${listedTools.length} tools, expected 5`),
  );

  const badTools = listedTools.filter((n) => SETTLEMENT_SURFACE.test(n));
  out.push(
    badTools.length === 0
      ? held("C-ABSENCE.1/tool_names", "0 listed tool names match /settle|pay|capture|refund|charge|price/")
      : broke("C-ABSENCE.1/tool_names", "settlement tool listed: " + badTools.join(", ")),
  );

  const declaredNames = TOOLS.map((t) => t.name);
  out.push(
    declaredNames.join(",") === [...listedTools].join(",")
      ? held("C-ABSENCE.1/tool_table", "the declared tool table and the served tools/list are the same five, in order")
      : broke(
          "C-ABSENCE.1/tool_table",
          `the table declares [${declaredNames.join(", ")}] and tools/list served [${listedTools.join(", ")}]`,
        ),
  );

  const segments = ROUTES.flatMap((r) =>
    r.pattern.split("/").filter((s) => s.length > 0 && !s.startsWith("{")),
  );
  const badSegments = segments.filter((s) => SETTLEMENT_SURFACE.test(s));
  out.push(
    badSegments.length === 0
      ? held("C-ABSENCE.1/route_segments", `0 of ${segments.length} route segments across ${ROUTES.length} routes match the settlement pattern`)
      : broke("C-ABSENCE.1/route_segments", "settlement route segment: " + badSegments.join(", ")),
  );

  const notFound = settlementStatuses.filter((s) => s === 404).length;
  out.push(
    notFound === settlementStatuses.length && settlementStatuses.length > 0
      ? held("C-ABSENCE.1/route_unreachable", `all ${settlementStatuses.length} settlement-shaped paths answer 404 over a socket — absent, not forbidden and not unimplemented`)
      : broke("C-ABSENCE.1/route_unreachable", `settlement-shaped paths answered [${settlementStatuses.join(", ")}]; every one must be 404`),
  );

  const answered = settlementCalls.filter((c) => !c.refused);
  out.push(
    answered.length === 0 && settlementCalls.length > 0
      ? held("C-ABSENCE.1/tool_uncallable", `all ${settlementCalls.length} settlement-named tools/call attempts were refused and none carried structuredContent — the tool is absent, not disabled and not permission-checked`)
      : broke("C-ABSENCE.1/tool_uncallable", "a settlement-named tool was answered: " + answered.map((c) => c.name + " (" + c.note + ")").join(", ")),
  );

  return out;
}

/* ── .2 · Type ────────────────────────────────────────────────────────────── */

export function manifestClauses(root: string): Clause[] {
  const out: Clause[] = [];
  const declared = new Set<string>();
  for (const file of DOCUMENT_SCHEMAS) {
    const parsed: unknown = JSON.parse(readFileSync(root + "/" + file, "utf8"));
    for (const member of declaredMembers(parsed)) declared.add(member);
  }
  const manifest = JSON.parse(readFileSync(root + "/schemas/member-manifest.json", "utf8")) as {
    members: string[];
    count: number;
  };
  const listed = new Set(manifest.members);
  const equality = setEquality(declared, listed);

  out.push(
    equality.unmanifested.length === 0
      ? held("C-ABSENCE.2/no_unmanifested", `0 unmanifested members — ${equality.declared} declared across ${DOCUMENT_SCHEMAS.length} document schemas, independently collected`)
      : broke("C-ABSENCE.2/no_unmanifested", `${equality.unmanifested.length} member(s) declared but not manifested: ${equality.unmanifested.join(", ")}`),
  );
  out.push(
    equality.orphans.length === 0
      ? held("C-ABSENCE.2/no_orphans", `0 orphan manifest entries across ${equality.listed} listed members`)
      : broke("C-ABSENCE.2/no_orphans", `${equality.orphans.length} manifest entr(ies) declared by no schema: ${equality.orphans.join(", ")}`),
  );
  out.push(
    manifest.count === listed.size
      ? held("C-ABSENCE.2/count", `the manifest's declared count ${manifest.count} matches its own list length`)
      : broke("C-ABSENCE.2/count", `count ${manifest.count} does not match list length ${listed.size}`),
  );
  return out;
}

/* ── .3 · Grant ───────────────────────────────────────────────────────────── */

export async function grantClauses(db: Db): Promise<Clause[]> {
  const out: Clause[] = [];

  for (const test of KILL_TESTS) {
    const outcome = await runKillTest(db, test);
    const expected = test.expect === "42501" ? "42501 insufficient_privilege" : test.expect + " undefined_table";
    if (outcome.denied) {
      out.push(held(
        `C-ABSENCE.3/${test.id}`,
        `denied to ${test.role} — attempted under SET LOCAL ROLE, ${expected}` +
          (test.expect_why ? ` (${test.expect_why})` : "") + ` · ${test.why}`,
      ));
    } else if (outcome.allowed) {
      out.push(broke(`C-ABSENCE.3/${test.id}`, `PERMITTED to ${test.role} and rolled back — ${test.why}`));
    } else {
      out.push(broke(`C-ABSENCE.3/${test.id}`, `raised [${outcome.sqlstate ?? "no SQLSTATE"}] where ${expected} was due${outcome.note ? " — " + outcome.note : ""}`));
    }
  }

  // The control. Without it, eleven denials are eleven denials for reasons
  // unknown: a role that never switched, a statement a constraint stopped first
  // and a grant doing its job are indistinguishable in the output above.
  const login = await loginRole(db);
  for (const id of NEGATIVE_CONTROLS) {
    const test = KILL_TESTS.find((t) => t.id === id)!;
    const outcome = await runKillTest(db, { ...test, role: login });
    out.push(
      outcome.allowed
        ? held(
            `C-ABSENCE.3/control_${id}`,
            `the SAME statement was PERMITTED to the login role ${login} and rolled back — so the denial above is the grant, not a role that never switched, a typo or a constraint arriving first`,
          )
        : broke(
            `C-ABSENCE.3/control_${id}`,
            `the control failed: ${login} owns every table and must be able to run this, but it raised [${outcome.sqlstate ?? "no SQLSTATE"}]${outcome.note ? " — " + outcome.note : ""}. Until this holds, every denial above is unexplained rather than proven`,
          ),
    );
  }

  const names = await physicalNames(db);
  const hits = nameHits(names);
  const settlement = hits.filter((h) => h.lock === "settlement");
  const personal = hits.filter((h) => h.lock === "personal");
  out.push(
    settlement.length === 0
      ? held("C-ABSENCE.3/no_payment_table", `0 of ${names.length} table and column names match the settlement pattern — SPEC.md §5.1's "no INSERT on payment tables" holds because there is no payment table to hold an INSERT on`)
      : broke("C-ABSENCE.3/no_payment_table", "settlement-named relation: " + settlement.map((h) => h.where).join(", ")),
  );
  out.push(
    personal.length === 0
      ? held("C-ABSENCE.3/no_customer_table", `0 of ${names.length} table and column names carry a person rather than a seat`)
      : broke("C-ABSENCE.3/no_customer_table", "person-named relation: " + personal.map((h) => h.where).join(", ")),
  );

  return out;
}

/* ── .4 · Value ───────────────────────────────────────────────────────────── */

/**
 * The canary, tested before it is trusted.
 *
 * A detector that matches nothing reports every body clean, and reports it in
 * exactly the words a working detector uses. This is the one place in the class
 * where the assertion is that something IS found, and it is the reason the
 * `PASS=` line above it can be believed.
 */
export function canarySelfTest(): Clause[] {
  const out: Clause[] = [];
  const vectors: [string, string, string][] = [
    ["email", POISON.email, "email"],
    ["e164", POISON.e164, "e164"],
    ["pan", POISON.pan, "luhn"],
    ["pan_spaced", POISON.pan_spaced, "luhn"],
    ["pan_dashed", POISON.pan_dashed, "luhn"],
    ["pan_embedded", `{"note":"ref 99${POISON.pan}77"}`, "luhn"],
  ];
  for (const [name, sample, kind] of vectors) {
    const hits = valueHits(sample);
    out.push(
      hits.some((h) => h.kind === kind)
        ? held(`C-ABSENCE.4/detects_${name}`, `the canary fires on a ${kind}-shaped value it was handed directly`)
        : broke(`C-ABSENCE.4/detects_${name}`, `the canary did NOT fire on ${name} — every clean body below is meaningless`),
    );
  }

  const benign = JSON.stringify({
    hold_id: "hold_0f3a9c1e7b5d4a2f8c6e0b1d3a5f7c9e",
    seats: ["A:1", "F:10"],
    granted_at: "2026-08-29T19:30:00+12:00",
    floor_ms: 120000,
    expires_at: "2026-08-29T19:33:00+12:00",
    retry_after_ms: 5000,
    occasion_etag: "1:aBcD1234567890eFgH1234567890iJkL1234567890mN",
  });
  const noise = valueHits(benign);
  out.push(
    noise.length === 0
      ? held("C-ABSENCE.4/no_false_positive", "the canary is silent on a Hold-shaped body of ids, seats, RFC 3339 instants and integer durations")
      : broke("C-ABSENCE.4/no_false_positive", "the canary fired on a benign control body: " + noise.map((h) => `${h.kind} ${h.match}`).join(", ")),
  );
  return out;
}

/** Shapes that only exist inside the process: a stack frame, a path, an error class. */
const INTERNAL_LEAK =
  /(TypeError|ReferenceError|SyntaxError|RangeError)\b|\bat [A-Za-z$_][\w$]* \(|file:\/\/|\/Users\/|node:internal/;

/** Literal fragments of the poisoned inputs, which a partial echo would carry. */
const ECHO_FRAGMENTS = Object.freeze([
  POISON.email,
  POISON.email.split("@")[0]!,
  POISON.e164,
  POISON.pan,
]);

/**
 * The one value the canary accounts for instead of failing on, and the reason it
 * is an assertion rather than a hole in the check.
 *
 * `usage_policy.contact` is **required** by `schemas/capability.schema.json` and
 * is one of the manifest's 177 members. It is the exhibitor's own box-office
 * address, published in a public bootstrap document that names no customer, and
 * it exists so that a redistribution question has somewhere to go. Lock 4 as
 * SPEC.md §5.1 words it — "no field value matches an email" — forbids a value
 * the specification's own frozen schema requires. That tension is a specification
 * defect and is reported as one; it is not resolved by deleting the check.
 *
 * So the exemption is made structurally and narrowly, and it is *more* work than
 * failing would be. The capability body is re-parsed, exactly the member at
 * `/usage_policy/contact` is removed, and the remainder must scan clean; the one
 * removed value must be the only hit in the body; and it must equal the address
 * the site configuration declares. An address that leaked into the capability
 * document from anywhere else fails all three.
 */
export const EXEMPT_POINTER = "/usage_policy/contact";

interface CapabilityScan {
  readonly clause: Clause;
  /** Hits that remain the canary's business after the contact member is removed. */
  readonly residual: string[];
}

function scanCapability(body: Body, published: string): CapabilityScan {
  const hits = valueHits(body.text);
  let parsed: { usage_policy?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(body.text) as { usage_policy?: Record<string, unknown> };
  } catch {
    parsed = null;
  }
  const contact = parsed?.usage_policy?.contact;
  if (parsed === null || typeof contact !== "string") {
    return {
      clause: broke("C-ABSENCE.4/capability_contact", `the capability body carries no string at ${EXEMPT_POINTER}, so the canary cannot account for anything in it`),
      residual: hits.map((h) => `${body.label}: ${h.kind}`),
    };
  }
  delete parsed.usage_policy!.contact;
  const residual = valueHits(JSON.stringify(parsed));
  const accountedFor = hits.every((h) => contact.includes(h.match));

  if (contact !== published) {
    return {
      clause: broke("C-ABSENCE.4/capability_contact", `the published contact and the served contact differ, so an address reached the wire that the exhibitor did not declare`),
      residual: hits.map((h) => `${body.label}: ${h.kind}`),
    };
  }
  if (residual.length > 0 || !accountedFor) {
    return {
      clause: broke("C-ABSENCE.4/capability_contact", `the capability body carries ${residual.length} personal-data hit(s) beyond the declared operator contact`),
      residual: residual.map((h) => `${body.label}: ${h.kind} in ${JSON.stringify(h.match.slice(0, 6) + "…")}`),
    };
  }
  return {
    clause: held("C-ABSENCE.4/capability_contact", `the only email leaving the boundary is the operator address the capability document is REQUIRED to publish at ${EXEMPT_POINTER}; removing that one member leaves the body clean, and it equals the address the site declared (SPEC.md §5.1 Lock 4 and schemas/capability.schema.json disagree here — reported, not filtered)`),
    residual: [],
  };
}

export function canaryClauses(
  binding: string,
  bodies: readonly Body[],
  publishedContact?: string,
): Clause[] {
  const out: Clause[] = [];
  const dirty: string[] = [];
  for (const body of bodies) {
    if (body.label === CAPABILITY_LABEL && publishedContact !== undefined) {
      const scan = scanCapability(body, publishedContact);
      out.push(scan.clause);
      dirty.push(...scan.residual);
      continue;
    }
    for (const hit of valueHits(body.text)) {
      dirty.push(`${body.label}: ${hit.kind} in ${JSON.stringify(hit.match.slice(0, 6) + "…")}`);
    }
  }
  out.push(
    dirty.length === 0
      ? held(`C-ABSENCE.4/${binding}_canary`, `${bodies.length} ${binding} response bodies carry no email, no E.164 string and no Luhn-valid 13–19 digit run`)
      : broke(`C-ABSENCE.4/${binding}_canary`, `PII reached the wire and the build fails rather than filtering it — ${dirty.join(" · ")}`),
  );

  // An internal error string on the wire is an uncontrolled prose channel to a
  // consumer with no judgement — the thing §5.3 exists to prevent — and it is
  // also how a value from inside the process reaches the outside without ever
  // being a member of any document. This corpus deliberately includes a request
  // that faults the handler, so the path is exercised rather than assumed.
  const internals: string[] = [];
  for (const body of bodies) {
    if (INTERNAL_LEAK.test(body.text)) internals.push(body.label);
  }
  out.push(
    internals.length === 0
      ? held(`C-ABSENCE.4/${binding}_no_internals`, `no ${binding} body carries a stack frame, a filesystem path or a JavaScript error class name`)
      : broke(`C-ABSENCE.4/${binding}_no_internals`, "an internal error string reached the wire: " + internals.join(" · ")),
  );

  const echoed: string[] = [];
  for (const body of bodies) {
    for (const fragment of ECHO_FRAGMENTS) {
      if (body.text.includes(fragment)) echoed.push(`${body.label}: ${fragment.slice(0, 6)}…`);
    }
  }
  out.push(
    echoed.length === 0
      ? held(`C-ABSENCE.4/${binding}_no_echo`, `no ${binding} refusal echoes the personal value that produced it, whole or in part`)
      : broke(`C-ABSENCE.4/${binding}_no_echo`, "a refused personal value came back out: " + echoed.join(" · ")),
  );

  return out;
}

/* ── The class ────────────────────────────────────────────────────────────── */

export interface AbsenceRun {
  readonly clauses: Clause[];
  readonly http: number;
  readonly mcp: number;
}

/**
 * All four locks, in order, against one store and both bindings.
 *
 * `db` is used only by .3 and is never the bench's store: the kill test asks
 * what a role may do, and a handle already inside a bench's transaction would
 * answer for the bench's login role instead.
 */
export async function runAbsence(db: Db, root: string): Promise<AbsenceRun> {
  const clauses: Clause[] = [];

  const http = await httpBodies();
  const mcp = await mcpBodies();

  clauses.push(...surfaceClauses(mcp.tools, http.settlement, mcp.settlementCalls));
  clauses.push(...manifestClauses(root));
  clauses.push(...(await grantClauses(db)));
  clauses.push(...canarySelfTest());
  clauses.push(...canaryClauses("HTTP", http.bodies, http.operator_contact));
  clauses.push(...canaryClauses("MCP", mcp.bodies));

  return { clauses, http: http.bodies.length, mcp: mcp.bodies.length };
}
