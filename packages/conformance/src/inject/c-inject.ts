/**
 * **C-INJECT.** Poisoned prose changes nothing that decides anything.
 *
 * Owner: TEST-005. SPEC.md §5.2-5.3, §2.4, rules PR1-PR3 and Q1.
 *
 * SPEC.md:645 states the class:
 *
 * > **.1** every URL in every emitted document is same-origin. **.2** with
 * > poisoned prose the etag is byte-identical to the unpoisoned run and a hold
 * > across a strict boundary still returns `412`. **.3** prose bytes are within
 * > Q1. *(The draft asserted that "a deliberately compromised agent" changes no
 * > boundary behaviour — true by construction, since the agent is not the
 * > boundary. An agent you wrote cannot falsify your claim.)*
 *
 * The parenthesis is the specification deleting an assertion from its own
 * conformance class, and this module honours that deletion: **no agent appears
 * here.** See the long note at the top of `poison.ts`.
 *
 * ## Why each assertion is made the way it is
 *
 * **.2 is the load-bearing one, and it is asserted byte-for-byte on purpose.**
 * "The etag did not change materially" is not a claim. `PROJECTION_0_1` is a
 * closed list of JSON Pointers; if a single byte of injected synopsis reached
 * the canonical bytes the digest would move, and the entire quarantine argument
 * of §5.3 — *prose is outside the etag, assertions are inside it* — would be
 * void. So the comparison is equality against the frozen fixture's own `etag`,
 * which `prove_etag_golden.sh` independently ties to `EXPECTED.md` and to
 * SPEC.md.
 *
 * A digest function that ignored its input would satisfy that trivially, so .2
 * carries its own negative control: the same minter over the same poisoned
 * document with one **projected** member moved must produce a different digest.
 * Invariance is only interesting from something that is otherwise sensitive.
 *
 * **The boundary half is asserted against the store, not the response.** A
 * `hold_seats` that returns `412` and leaves a `hold_seat` row behind has sold
 * a seat and reported it correctly, which is the failure S1 exists to prevent.
 * And it carries a positive control in the other direction: under exactly the
 * same poisoning, the substitution the publisher *did* attest still succeeds.
 * Poison that broke the poset outright would make the refusal meaningless — a
 * server that refuses everything conforms to nothing.
 *
 * **.1 separates two different failures.** A URL in a document *member* is one
 * an Agent may act on, and O1 governs it. A URL inside a *prose envelope* is
 * one PR1 forbids the Agent to touch and PR2 forbids the Server to publish at
 * all. The navigable half of the corpus exists to prove the second detector is
 * awake; the first is asserted over documents the plain half poisoned, because
 * that is what a conforming Server can actually emit.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { holdSeats } from "@changeover/core/hold-seats.ts";
import { containsUri } from "@changeover/core/principal.ts";
import { PROSE_BYTES_PER_RESPONSE, fitToProseBudget, proseBytes } from "@changeover/http/occasions.ts";
import { REFUSAL_STATUS, isRefusal, refuse } from "@changeover/schema/refusal.ts";
import type { Db } from "@changeover/store/db.ts";
import { availableSeatIds, occasionSeedFromDocument, seedEstate } from "@changeover/store/fixtures.ts";
import { migrate, resetHoldStore } from "@changeover/store/migrate.ts";

import type { Check } from "./poison.ts";
import {
  ALL_POISON,
  NAVIGABLE_POISON,
  PLAIN_POISON,
  PROSE_VALUE_MAX_LENGTH,
  Q1_PROSE_BYTES_PER_OCCASION,
  broke,
  held,
  poisonOccasion,
  poisonOccasionNavigably,
  poisonProjectedEdgeDetail,
  poisonedRefusalReason,
  proseHits,
} from "./poison.ts";
import { auditOrigins, authorityFrom, permittedByO1 } from "./origin.ts";

/* -- 0 . The fixtures, read rather than restated ----------------------------- */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

export const GOLDEN_FILES: readonly string[] = Object.freeze([
  "occasion-embassy-sat-1900.json",
  "occasion-multiplex-sat-2100.json",
  "occasion-multiplex-sun-1400.json",
]);

const readGolden = (name: string): unknown =>
  JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "golden", name), "utf8"));

export interface GoldenCase {
  readonly name: string;
  readonly clean: unknown;
  readonly poisoned: unknown;
  /** The frozen etag the fixture carries, which EXPECTED.md and SPEC.md also carry. */
  readonly frozen_etag: string;
}

/** The golden three, each beside its poisoned twin. */
export function goldenCases(): GoldenCase[] {
  return GOLDEN_FILES.map((name) => {
    const clean = readGolden(name);
    return {
      name,
      clean,
      poisoned: poisonOccasion(clean),
      frozen_etag: String((clean as { etag?: unknown }).etag),
    };
  });
}

export const VENUE_ORIGIN = "https://embassy.example";
export const GOLDEN_CLUSTER = "the-conversation-wlg-2026-w35";
const EMBASSY = "occ_embassy_20260829T1900_s1";
const MULTIPLEX_SAT = "occ_multiplex_20260829T2100_s4";

const delegationRecord = (): unknown =>
  JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "golden", "delegation.json"), "utf8"));

/* -- 1 . The control. A poison that is inert proves nothing. ----------------- */

/**
 * Before any invariance is claimed, the poison has to be real: present in the
 * document, different from what was there, imperative in form, and — crucially
 * — **still a conforming document**, because an injection that only lands by
 * violating the schema is caught by the validator and is not this threat.
 */
export function poisonIsReal(cases: readonly GoldenCase[]): Check[] {
  const checks: Check[] = [];

  const moved = cases.filter((c) => {
    const before = proseHits(c.clean).map((h) => h.value).join(" ");
    const after = proseHits(c.poisoned).map((h) => h.value).join(" ");
    return before !== after;
  });
  checks.push(
    moved.length === cases.length
      ? held("C-INJECT.0a", `the poison changed prose in all ${cases.length} golden Occasions`)
      : broke(
          "C-INJECT.0a",
          `${cases.length - moved.length} Occasions were byte-identical after poisoning; the corpus is inert`,
        ),
  );

  const documentSurfaces = PLAIN_POISON.filter(
    (p) => p.surface !== "refusal.reason" && p.in_projection !== true,
  );
  const embassy = cases.find((c) => c.name === GOLDEN_FILES[0]);
  const poisonedValues = embassy === undefined ? [] : proseHits(embassy.poisoned).map((h) => h.value);
  const landed = documentSurfaces.filter((p) => poisonedValues.includes(p.value));
  checks.push(
    landed.length === documentSurfaces.length
      ? held(
          "C-INJECT.0b",
          `all ${landed.length} document surfaces §5.2 names carry their imperative text verbatim`,
        )
      : broke("C-INJECT.0b", `only ${landed.length} of ${documentSurfaces.length} named surfaces were poisoned`),
  );

  const oversize = ALL_POISON.filter((p) => p.value.length > PROSE_VALUE_MAX_LENGTH);
  checks.push(
    oversize.length === 0
      ? held(
          "C-INJECT.0c",
          `every poison value fits the schema's ${PROSE_VALUE_MAX_LENGTH}-character prose envelope, so each one is publishable`,
        )
      : broke(
          "C-INJECT.0c",
          `${oversize.length} poison values exceed maxLength ${PROSE_VALUE_MAX_LENGTH} and would be refused by the validator, not by this rule`,
        ),
  );

  const plainCarryingLinks = PLAIN_POISON.filter((p) => containsUri(p.value));
  const navigableWithoutLinks = NAVIGABLE_POISON.filter((p) => !containsUri(p.value));
  checks.push(
    plainCarryingLinks.length === 0 && navigableWithoutLinks.length === 0
      ? held(
          "C-INJECT.0d",
          `the corpus splits as declared: ${PLAIN_POISON.length} link-free values a conforming Server may publish, ${NAVIGABLE_POISON.length} PR2 forbids`,
        )
      : broke(
          "C-INJECT.0d",
          `${plainCarryingLinks.length} plain values carry a link and ${navigableWithoutLinks.length} navigable values do not`,
        ),
  );

  return checks;
}

/* -- 2 . C-INJECT.1 — every emitted URL is same-origin ----------------------- */

export function sameOriginUnderPoison(cases: readonly GoldenCase[]): Check[] {
  const checks: Check[] = [];
  const authority = authorityFrom(VENUE_ORIGIN, delegationRecord());

  const emitted = cases.map((c) => c.poisoned);
  const audit = auditOrigins(emitted, authority);

  checks.push(
    audit.members >= 6
      ? held(
          "C-INJECT.1a",
          `the audit reached ${audit.members} URL members across ${emitted.length} poisoned Occasions — an audit that visits nothing also finds nothing`,
        )
      : broke(
          "C-INJECT.1a",
          `the audit found only ${audit.members} URL members; it did not reach book_url and seat_map_ref`,
        ),
  );

  checks.push(
    audit.offOrigin.length === 0
      ? held(
          "C-INJECT.1b",
          `every URL member is O1-permitted against ${VENUE_ORIGIN} or its apex delegation record`,
        )
      : broke(
          "C-INJECT.1b",
          `${audit.offOrigin.length} URL members are off-origin: ${audit.offOrigin.map((f) => f.pointer + " " + f.url).join(" ; ")}`,
        ),
  );

  checks.push(
    audit.proseLinks.length === 0
      ? held(
          "C-INJECT.1c",
          "no navigable link survives inside a prose envelope — PR2 is what keeps the injected destination out of the document",
        )
      : broke(
          "C-INJECT.1c",
          `${audit.proseLinks.length} prose values carry a link: ${audit.proseLinks.map((f) => f.pointer).join(", ")}`,
        ),
  );

  // The detector, proven awake. If PR2's check were asleep this is the document
  // that would sail through, and .1c above would be silently vacuous.
  const navigable = poisonOccasionNavigably(cases[0]?.clean);
  const navigableAudit = auditOrigins([navigable], authority);
  checks.push(
    navigableAudit.proseLinks.length === 1 && containsUri(NAVIGABLE_POISON[0]?.value ?? "")
      ? held(
          "C-INJECT.1d",
          "a synopsis carrying an attacker host is detected as a prose link, so .1c is a fact and not an absence of looking",
        )
      : broke(
          "C-INJECT.1d",
          `the navigable poison was not detected: ${navigableAudit.proseLinks.length} prose links found`,
        ),
  );

  // O1 compared as a parsed triple, not a string prefix. Every one of these is a
  // URL a human reads as the venue's and a parser does not.
  const traps: ReadonlyArray<readonly [string, boolean, string]> = [
    ["https://tickets.embassy.example/session/x", true, "the delegated ticketing host"],
    ["https://embassy.example/changeover/v0/occasions", true, "the venue's own origin"],
    ["https://embassy.example:443/x", true, "the default port, normalised"],
    ["https://TICKETS.EMBASSY.EXAMPLE/x", true, "an ASCII-uppercased host, lowercased before comparison"],
    ["https://tickets.embassy.example.attacker.test/x", false, "the prefix trap O2 names explicitly"],
    ["https://tickets.embassy.example@attacker.test/x", false, "userinfo, invalid regardless of host"],
    ["http://embassy.example/x", false, "a different scheme"],
    ["https://embassy.example:8443/x", false, "a different port"],
    ["https://attacker.test/session/x", false, "a different host entirely"],
  ];
  const wrong = traps.filter(([url, expected]) => permittedByO1(url, authority) !== expected);
  checks.push(
    wrong.length === 0
      ? held(
          "C-INJECT.1e",
          `O1 decides all ${traps.length} trap URLs correctly, including the prefix trap and the userinfo trap — the comparison is a parsed triple`,
        )
      : broke(
          "C-INJECT.1e",
          `O1 mis-decided ${wrong.length}: ${wrong.map(([u, , why]) => u + " (" + why + ")").join(" ; ")}`,
        ),
  );

  return checks;
}

/* -- 3 . C-INJECT.2 — the digest does not move ------------------------------- */

export type Mint = (document: unknown) => string;

/**
 * The one that carries the argument.
 *
 * `mint` is supplied by the caller and is the **harness** projector —
 * `scripts/lib/project.mjs`, RFC 8785 canonicalisation from a third-party
 * package, and `node:crypto`. It is deliberately not a CHANGEOVER
 * implementation: the question here is whether the *specification's* projection
 * leaks prose, and asking a CHANGEOVER package would be asking the accused.
 */
export function etagSurvivesPoison(cases: readonly GoldenCase[], mint: Mint): Check[] {
  const checks: Check[] = [];

  for (const c of cases) {
    const clean = mint(c.clean);
    const poisoned = mint(c.poisoned);
    if (clean !== c.frozen_etag) {
      checks.push(
        broke(
          "C-INJECT.2a",
          `${c.name}: the minter does not reproduce the frozen etag (${clean} vs ${c.frozen_etag}); nothing below it means anything`,
        ),
      );
      continue;
    }
    const identical = Buffer.compare(Buffer.from(poisoned, "utf8"), Buffer.from(clean, "utf8")) === 0;
    checks.push(
      identical
        ? held(
            "C-INJECT.2a",
            `${c.name}: the poisoned digest is byte-identical to the unpoisoned run and to the frozen ${clean}`,
          )
        : broke(
            "C-INJECT.2a",
            `${c.name}: poisoning moved the digest — ${clean} became ${poisoned}; PROJECTION_0_1 is leaking prose`,
          ),
    );
  }

  // Invariance from a function that cannot vary is not invariance.
  const subject = cases[0];
  if (subject !== undefined) {
    const movedStart = structuredClone(subject.poisoned) as { instant: { starts_at: string } };
    movedStart.instant.starts_at = "2026-08-29T19:30:00+12:00";
    const movedTitle = structuredClone(subject.poisoned) as { work: { title: { value: string } } };
    movedTitle.work.title.value = "The Conformist";
    const startMoved = mint(movedStart) !== mint(subject.poisoned);
    const titleMoved = mint(movedTitle) !== mint(subject.poisoned);
    checks.push(
      startMoved && titleMoved
        ? held(
            "C-INJECT.2b",
            "the same minter over the same poisoned document moves for a changed start time and for a swapped work — the invariance above is prose-specific, not a constant",
          )
        : broke(
            "C-INJECT.2b",
            `the minter is insensitive: starts_at moved it=${startMoved}, work.title moved it=${titleMoved}`,
          ),
    );
  }

  // The scope of the claim, stated rather than assumed. §2.4 says the
  // projection excludes "every prose value except work.title.value" — one
  // exception — but §2.2 projects `substitution` WHOLE, and
  // `not_substitutable_for[].detail` is a prose value. So there are two, and
  // editing that one DOES move the digest. This is asserted in the direction it
  // runs, because a byte-identity headline that had silently skipped the one
  // counter-example would be the more comfortable kind of wrong.
  if (subject !== undefined) {
    const edgeEdited = poisonProjectedEdgeDetail(subject.clean);
    const before = mint(subject.clean);
    const afterEdit = mint(edgeEdited);
    const edges = (subject.clean as { substitution?: { not_substitutable_for?: unknown[] } }).substitution
      ?.not_substitutable_for;
    const hasEdges = Array.isArray(edges) && edges.length > 0;
    checks.push(
      hasEdges && afterEdit !== before
        ? held(
            "C-INJECT.2h",
            "a substitution edge's `detail` is prose INSIDE the projection (§2.2 projects /substitution whole), so editing it moves the digest — §2.4 and projection-0-1.json both say ONE prose exception and there are two; not a §5.2 surface, because edges are derived from the venue's own authored policy",
          )
        : broke(
            "C-INJECT.2h",
            hasEdges
              ? "an edit to a projected prose value did NOT move the digest; /substitution is not being projected whole"
              : "the subject fixture carries no not_substitutable_for edge, so the projected-prose case was not reached",
          ),
    );
  }

  // PR3. An upstream vendor's string reaching `reason` is a Server defect, and
  // the point of the closed taxonomy is that it changes nothing anyway: the
  // code, the remediation and the status are decided by type, not by text.
  const poisonedRefusal = refuse("substitution_refused", poisonedRefusalReason(), {
    detail: { from_occasion_id: EMBASSY, crossed_axis: "presentation_class" },
  });
  const document = poisonedRefusal.toDocument("2026-08-29T09:20:00.412+12:00");
  const typedStill =
    document.code === "substitution_refused" &&
    document.remediation === "re_resolve" &&
    REFUSAL_STATUS[document.code] === 412 &&
    document.refused === true;
  checks.push(
    typedStill
      ? held(
          "C-INJECT.2c",
          "a refusal whose reason carries the vendor's poisoned text still renders code=substitution_refused, remediation=re_resolve, status 412 — the decision is typed and the prose is an envelope",
        )
      : broke(
          "C-INJECT.2c",
          `the poisoned reason moved the typed refusal: ${JSON.stringify({ code: document.code, remediation: document.remediation })}`,
        ),
  );

  return checks;
}

/* -- 4 . C-INJECT.2 — the strict boundary still refuses ---------------------- */

const credential = (scope: string) => ({ agent_id: "agt_reference", principal_scope: scope });

async function rowsOutstanding(db: Db): Promise<number> {
  let total = 0;
  for (const table of ["hold", "hold_seat", "hold_cluster", "hold_slot"]) {
    const r = await db.query<{ n: string }>(`select count(*)::text as n from ${table}`);
    total += Number(r.rows[0]?.n ?? 0);
  }
  return total;
}

/**
 * Seed the poisoned estate and try to cross the boundary the Embassy asserted.
 *
 * The estate is the golden three, every prose surface poisoned and every
 * projected member and every substitution edge untouched. The Embassy's
 * `not_substitutable_for` names both multiplex screenings; the injected text
 * says, in the synopsis and in the programme note and in the edge's own
 * `detail`, that the assertion has been withdrawn and that agents may hold
 * either screening. It has not been withdrawn, and they may not.
 */
export async function strictBoundarySurvivesPoison(
  db: Db,
  cases: readonly GoldenCase[],
): Promise<Check[]> {
  const checks: Check[] = [];

  await migrate(db);
  await resetHoldStore(db);
  const seeds = cases.map((c) => occasionSeedFromDocument(c.poisoned, { cluster: GOLDEN_CLUSTER }));
  await seedEstate(db, { name: "c-inject-poisoned", occasions: seeds });

  const seedOf = (occasion_id: string) => {
    const seed = seeds.find((s) => s.occasion_id === occasion_id);
    if (seed === undefined) throw new Error(`the poisoned estate has no ${occasion_id}`);
    return seed;
  };

  const embassy = seedOf(EMBASSY);
  const multiplex = seedOf(MULTIPLEX_SAT);

  const before = await rowsOutstanding(db);

  // The customer chose the 35mm print. The agent offers the DCP.
  let refusalReason = "";
  try {
    await holdSeats(
      db,
      {
        occasion_id: multiplex.occasion_id,
        occasion_etag: multiplex.etag,
        sought: { occasion_id: embassy.occasion_id, occasion_etag: embassy.etag },
        seats: availableSeatIds(multiplex, 1),
        requested_floor_ms: 120000,
      },
      credential("ps_crossing"),
    );
    checks.push(broke("C-INJECT.2d", "the hold across the strict boundary was GRANTED under poisoned prose"));
  } catch (err) {
    if (!isRefusal(err)) throw err;
    refusalReason = err.reason;
    const status = REFUSAL_STATUS[err.code];
    const named = String((err.detail as { from_occasion_id?: unknown } | undefined)?.from_occasion_id ?? "");
    checks.push(
      err.code === "substitution_refused" && status === 412 && named === EMBASSY
        ? held(
            "C-INJECT.2d",
            `a hold across the strict boundary still returns 412 substitution_refused naming ${named}, with the withdrawal notice sitting in three prose fields of the same document`,
          )
        : broke(
            "C-INJECT.2d",
            `expected 412 substitution_refused naming ${EMBASSY}, got ${status} ${err.code} naming ${named || "nothing"}`,
          ),
    );
  }

  const after = await rowsOutstanding(db);
  checks.push(
    after === before
      ? held(
          "C-INJECT.2e",
          `the refused hold wrote nothing — ${after} rows across hold, hold_seat, hold_cluster and hold_slot, unchanged (S1)`,
        )
      : broke(
          "C-INJECT.2e",
          `the refused hold left ${after - before} rows behind; a 412 that writes a hold_seat row has sold the seat and reported it correctly`,
        ),
  );

  // PR3, on the refusal the boundary actually threw: the reason is CHANGEOVER's
  // own sentence, not any of the text sitting in the poisoned document.
  const quoted = ALL_POISON.filter((p) => refusalReason.includes(p.value.slice(0, 40)));
  checks.push(
    refusalReason.length > 0 && quoted.length === 0 && !containsUri(refusalReason)
      ? held(
          "C-INJECT.2f",
          "the refusal's reason is re-typed CHANGEOVER prose and quotes none of the poison back — PR3 in force at the one place vendor text reaches an Agent",
        )
      : broke(
          "C-INJECT.2f",
          `the refusal reason carried ${quoted.length} poison fragments: ${refusalReason.slice(0, 120)}`,
        ),
  );

  // The positive control. Under the SAME poisoning, the substitution the
  // publisher did attest is still granted. A boundary that refuses everything
  // has not survived the poison; it has been broken by it.
  const attested = await holdSeats(
    db,
    {
      occasion_id: embassy.occasion_id,
      occasion_etag: embassy.etag,
      sought: { occasion_id: multiplex.occasion_id, occasion_etag: multiplex.etag },
      seats: availableSeatIds(embassy, 1),
      requested_floor_ms: 120000,
    },
    credential("ps_attested"),
  );
  checks.push(
    attested.state === "live"
      ? held(
          "C-INJECT.2g",
          "the substitution the publisher attested is still granted under the same poison — the refusal above is the poset deciding, not the poison breaking it",
        )
      : broke("C-INJECT.2g", `the attested substitution returned state ${attested.state}`),
  );

  return checks;
}

/* -- 5 . C-INJECT.3 — prose volume is capped --------------------------------- */

/**
 * Q1 has two halves, they live in different places, and the difference is stated
 * rather than blurred.
 *
 * The **per-response** half (200000) is implemented in
 * `@changeover/http/occasions.ts` as `fitToProseBudget`, and is asserted against
 * that implementation with a flood large enough to force paging.
 *
 * The **per-Occasion** half (8000) is a publish-time refusal, and **no publish
 * path in this repository implements it yet.** What is asserted here is
 * therefore the measurement — every poisoned Occasion this item emits is inside
 * the cap — plus a control showing the measurement can tell the difference.
 * Asserting that a filter this item wrote refuses a document this item wrote
 * would be a tautology, and saying so is cheaper than discovering it later.
 */
export function proseVolumeWithinQ1(cases: readonly GoldenCase[]): Check[] {
  const checks: Check[] = [];

  const measured = cases.map((c) => ({ name: c.name, bytes: proseBytes(c.poisoned) }));
  const over = measured.filter((m) => m.bytes > Q1_PROSE_BYTES_PER_OCCASION);
  const largest = measured.reduce((a, b) => (b.bytes > a.bytes ? b : a), { name: "-", bytes: 0 });
  checks.push(
    over.length === 0
      ? held(
          "C-INJECT.3a",
          `every poisoned Occasion is within Q1's ${Q1_PROSE_BYTES_PER_OCCASION}-byte per-Occasion cap; the largest is ${largest.name} at ${largest.bytes}`,
        )
      : broke(
          "C-INJECT.3a",
          `${over.length} poisoned Occasions exceed ${Q1_PROSE_BYTES_PER_OCCASION} bytes of prose: ${over.map((m) => m.name + " " + m.bytes).join(", ")}`,
        ),
  );

  // The measurement, shown to be capable of failing.
  const cleanBytes = proseBytes(cases[0]?.clean);
  const flooded = structuredClone(cases[0]?.clean) as {
    manner: { note: { body: { value: string } } };
    work: Record<string, unknown>;
  };
  flooded.manner.note.body.value = "A".repeat(PROSE_VALUE_MAX_LENGTH);
  flooded.work["synopsis"] = { content_type: "text/plain", value: "B".repeat(PROSE_VALUE_MAX_LENGTH) };
  const floodBytes = proseBytes(flooded);
  checks.push(
    floodBytes > cleanBytes
      ? held(
          "C-INJECT.3b",
          `the byte count is a real measurement: two maximal prose envelopes take the same Occasion from ${cleanBytes} to ${floodBytes} bytes`,
        )
      : broke("C-INJECT.3b", `flooding two prose values did not move the count (${floodBytes})`),
  );

  // The per-response half, against the implementation that enforces it.
  const heavy = structuredClone(cases[0]?.poisoned) as {
    manner: { note: { body: { value: string } } };
    work: Record<string, unknown>;
  };
  heavy.manner.note.body.value = "C".repeat(PROSE_VALUE_MAX_LENGTH);
  heavy.work["synopsis"] = { content_type: "text/plain", value: "D".repeat(PROSE_VALUE_MAX_LENGTH) };
  const heavyBytes = proseBytes(heavy);
  const count = Math.ceil((PROSE_BYTES_PER_RESPONSE / heavyBytes) * 3);
  const page: unknown[] = [];
  for (let i = 0; i < count; i++) page.push(heavy);
  const fitted = fitToProseBudget(page);
  let fittedBytes = 0;
  for (const document of page.slice(0, fitted)) fittedBytes += proseBytes(document);
  checks.push(
    fitted < page.length && fittedBytes <= PROSE_BYTES_PER_RESPONSE
      ? held(
          "C-INJECT.3c",
          `a ${page.length}-Occasion flood of ${heavyBytes}-byte documents is paged to ${fitted} at ${fittedBytes} bytes — under Q1's ${PROSE_BYTES_PER_RESPONSE}, and paged rather than exceeded`,
        )
      : broke(
          "C-INJECT.3c",
          `Q1's per-response cap was not enforced: ${fitted}/${page.length} documents, ${fittedBytes} bytes`,
        ),
  );

  return checks;
}

/* -- 6 . The class ----------------------------------------------------------- */

export interface CInjectOptions {
  readonly db: Db;
  readonly mint: Mint;
}

/** Every C-INJECT assertion, in the order SPEC.md:645 states them. */
export async function runCInject(options: CInjectOptions): Promise<Check[]> {
  const cases = goldenCases();
  return [
    ...poisonIsReal(cases),
    ...sameOriginUnderPoison(cases),
    ...etagSurvivesPoison(cases, options.mint),
    ...(await strictBoundarySurvivesPoison(options.db, cases)),
    ...proseVolumeWithinQ1(cases),
  ];
}
