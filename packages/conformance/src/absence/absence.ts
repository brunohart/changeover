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

import type { Body } from "./bodies.ts";
import { POISON, httpBodies, mcpBodies } from "./bodies.ts";
import type { Db } from "@changeover/store/db.ts";
import { KILL_TESTS, nameHits, physicalNames, runKillTest } from "./grants.ts";
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
  settlementToolBodies: readonly Body[],
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

  const selectable = settlementToolBodies.filter((b) => !/protocol error/.test(b.label));
  out.push(
    selectable.length === 0
      ? held("C-ABSENCE.1/tool_uncallable", `all ${settlementToolBodies.length} settlement-named tools/call attempts were rejected at the protocol, not answered`)
      : broke("C-ABSENCE.1/tool_uncallable", "a settlement-named tool was answered: " + selectable.map((b) => b.label).join(", ")),
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
    if (outcome.denied) {
      out.push(held(`C-ABSENCE.3/${test.id}`, `denied to ${test.role} — attempted under SET LOCAL ROLE, 42501 insufficient_privilege · ${test.why}`));
    } else if (outcome.allowed) {
      out.push(broke(`C-ABSENCE.3/${test.id}`, `PERMITTED to ${test.role} and rolled back — ${test.why}`));
    } else {
      out.push(broke(`C-ABSENCE.3/${test.id}`, `raised [${outcome.sqlstate ?? "no SQLSTATE"}] where 42501 was due${outcome.note ? " — " + outcome.note : ""}`));
    }
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

/** Literal fragments of the poisoned inputs, which a partial echo would carry. */
const ECHO_FRAGMENTS = Object.freeze([
  POISON.email,
  POISON.email.split("@")[0]!,
  POISON.e164,
  POISON.pan,
]);

export function canaryClauses(binding: string, bodies: readonly Body[]): Clause[] {
  const out: Clause[] = [];
  const dirty: string[] = [];
  for (const body of bodies) {
    for (const hit of valueHits(body.text)) {
      dirty.push(`${body.label}: ${hit.kind} in ${JSON.stringify(hit.match.slice(0, 6) + "…")}`);
    }
  }
  out.push(
    dirty.length === 0
      ? held(`C-ABSENCE.4/${binding}_canary`, `${bodies.length} ${binding} response bodies carry no email, no E.164 string and no Luhn-valid 13–19 digit run`)
      : broke(`C-ABSENCE.4/${binding}_canary`, `PII reached the wire and the build fails rather than filtering it — ${dirty.join(" · ")}`),
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

  const settlementTools = mcp.bodies.filter((b) => b.label.startsWith("tools/call "));
  clauses.push(...surfaceClauses(mcp.tools, http.settlement, settlementTools));
  clauses.push(...manifestClauses(root));
  clauses.push(...(await grantClauses(db)));
  clauses.push(...canarySelfTest());
  clauses.push(...canaryClauses("HTTP", http.bodies));
  clauses.push(...canaryClauses("MCP", mcp.bodies));

  return { clauses, http: http.bodies.length, mcp: mcp.bodies.length };
}
