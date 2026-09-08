// C-SUBST. Owner: TEST-006.
//
// §7: *"The Server emits the transitive closure of the authored rules;
// `maximalAntichain` matches a reference oracle over generated posets including
// `x-` members; a hold whose `sought` crosses a strict boundary returns `412`
// and writes no `hold_seat` row; a cross-origin edge is rejected at publish and
// ignored by the reference Agent."*
//
// Four clauses, and the third is the one with teeth. *"Returns 412"* is cheap —
// any refusal path returns something. **"And writes no `hold_seat` row"** is the
// assertion, because a Server that took the seats and then refused has sold the
// customer nothing and taken the seat off the wall anyway: the refusal is
// correct, the estate is wrong, and no response-shaped test can see it. Every
// count below is over the store.
//
// The antichain clause runs the property against `packages/semantics/test/lib/
// antichain-oracle.ts`, which is a second implementation written from §2.3
// rather than from `antichain.ts`. Comparing an implementation with itself
// proves that it is deterministic and nothing else. The generated posets include
// `x-` extension classes on purpose: an `x-` class MUST NOT satisfy a strict
// policy, so an attested edge across one is not enough, and that is exactly the
// rule an optimiser deletes first.

import { readFileSync } from "node:fs";

import { buildPoset, transitivityWitness, reflexivityWitness, substitutionRefusal } from "@changeover/semantics/poset.ts";
import type { Candidate } from "@changeover/semantics/poset.ts";
import { candidateFromOccasion, maximalAntichain } from "@changeover/semantics/antichain.ts";
import { deriveSubstitutions } from "@changeover/semantics/derive.ts";
import { loadCorpusFiles, loadPolicyFile } from "@changeover/semantics/policy.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { ConformanceBench } from "./_bench.ts";
import { ETAG, OCCASION, TOKEN, holdBody, key, repoFile } from "./_bench.ts";

const CROSS_ORIGIN_POLICY = "fixtures/policy/cross-origin/policy.yaml";
// BOTH files. The rule cannot fire against one origin, and a corpus holding
// only the roxy would have reported "no E1 diagnostic" — a green-adjacent
// failure blaming derive.ts for a fixture this proof never handed it.
const CROSS_ORIGIN_CORPUS = [
  "fixtures/policy/cross-origin/corpus/occasion-roxy-sat-1900.json",
  "fixtures/policy/cross-origin/corpus/occasion-tickets-sat-2100.json",
];
const ORACLE_LIB = "packages/semantics/test/lib/antichain-oracle.ts";

export const id = "C-SUBST";
export const spec_row =
  "The Server emits the transitive closure of the authored rules; maximalAntichain matches a reference oracle over generated posets including x- members; a hold whose sought crosses a strict boundary returns 412 and writes no hold_seat row; a cross-origin edge is rejected at publish and ignored by the reference Agent.";

/** A deterministic little poset generator, seeded, including `x-` members. */
function generatedCandidates(seed: number, n: number): Candidate[] {
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) >>> 0;
    return s / 4294967296;
  };
  const ids = Array.from({ length: n }, (_, i) => `occ_gen_${seed}_${i}`);
  const candidates: Candidate[] = ids.map((occasion_id, i) => ({
    occasion_id,
    policy: next() < 0.6 ? "strict" : "advisory",
    presentation_classes: next() < 0.35 ? ["pres:35mm-4perf", `x-house-${i % 2}`] : ["pres:dcp-2k"],
    occasion_classes: next() < 0.25 ? [`x-season-${i % 3}`] : ["occ:regular"],
    accepts_substitute: [],
    not_substitutable_for: [],
    facets: {
      instant: `2026-09-0${(i % 8) + 1}T19:00:00+12:00`,
      auditorium_id: `aud_${i % 3}`,
      seating: "allocated",
      price_bands: [`band_${i % 2}`],
      accessibility: { open_captions: i % 4 === 0 ? "yes" : "no" },
    },
  }));
  // A sparse acyclic edge set: i ⪯ j only for i < j, so no cycle can be authored.
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (next() < 0.28) {
        (candidates[i] as unknown as { accepts_substitute: unknown[] }).accepts_substitute.push({
          occasion_id: ids[j],
          axis: "instant",
        });
      } else if (next() < 0.12) {
        (candidates[i] as unknown as { not_substitutable_for: unknown[] }).not_substitutable_for.push({
          occasion_id: ids[j],
          axis: "presentation_class",
        });
      }
    }
  }
  return candidates;
}

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  /* ── 1 · The Server emits a transitively closed relation ──────────────── */
  //
  // Read off the wire, not off the fixture: the assertion is about what this
  // Server EMITS, and a document that was closed when it was written and is
  // served through a projection that drops an edge is exactly the failure.

  const page = await bench.call("GET", "/changeover/v0/occasions", { token: TOKEN.a });
  const occasions = ((page.json as { occasions?: unknown[] } | null)?.occasions ?? []) as Record<string, unknown>[];
  c.that("emitted", occasions.length >= 4, `resolve_occasions answered with ${occasions.length} Occasions to build a poset from`);

  const emitted = buildPoset(occasions.map((document) => candidateFromOccasion(document)));
  const witness = transitivityWitness(emitted);
  c.is(
    "closure",
    witness,
    null,
    "the relation the Server emits is transitively closed — no pair a ⪯ b ⪯ c is emitted without a ⪯ c",
  );
  c.is(
    "irreflexive",
    reflexivityWitness(emitted),
    null,
    "and irreflexive: nothing is emitted as a substitute for itself, which would make every strict boundary satisfiable by restating it",
  );

  /* ── 2 · maximalAntichain against an independent oracle ───────────────── */

  // A relative specifier, because SPEC-008's oracle sits in `test/` and the
  // package's export map is `"./*": "./src/*"` — there is no package specifier
  // that reaches it, and inventing one would mean editing a package.json that
  // CONTRACT-000 owns.
  let oracle: {
    maximalAntichainOracle: (candidates: readonly unknown[]) => { members: { occasion_id: string }[] };
  } | null = null;
  try {
    oracle = (await import("../../../semantics/test/lib/antichain-oracle.ts")) as never;
  } catch {
    oracle = null;
  }

  if (oracle === null) {
    c.cannot(
      "antichain",
      "the independent oracle is SPEC-008's and lives outside any package export map, so it cannot be imported from here; comparing maximalAntichain with itself would prove only that it is deterministic",
      ORACLE_LIB,
    );
  } else {
    let agreed = 0;
    let compared = 0;
    let x_seen = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const candidates = generatedCandidates(seed * 7919, 5 + (seed % 4));
      if (candidates.some((k) => (k.presentation_classes ?? []).concat(k.occasion_classes ?? []).some((t) => t.startsWith("x-")))) {
        x_seen++;
      }
      const mine = maximalAntichain(candidates).members.map((m) => m.occasion_id).sort().join(",");
      const theirs = oracle
        .maximalAntichainOracle(candidates as readonly unknown[])
        .members.map((m) => m.occasion_id)
        .sort()
        .join(",");
      compared++;
      if (mine === theirs) agreed++;
      else {
        c.bad(
          "antichain",
          `maximalAntichain and the oracle disagree on generated poset ${seed}: mine=[${mine}] oracle=[${theirs}]`,
        );
        break;
      }
    }
    if (agreed === compared) {
      c.ok(
        "antichain",
        `maximalAntichain matches the independent oracle on all ${compared} generated posets, ${x_seen} of which carry x- extension classes`,
      );
    }
  }

  /* ── 3 · A hold crossing a strict boundary — 412, AND no seat row ─────── */

  const seats_before = await bench.db.query<{ n: string }>(
    "select count(*)::text as n from hold_seat",
  );
  const holds_before = await bench.db.query<{ n: string }>("select count(*)::text as n from hold");

  const crossed = await bench.call("POST", "/changeover/v0/holds", {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`subst-${bench.nonce}`) },
    body: holdBody(["B:1", "B:2"], {
      sought: { occasion_id: OCCASION.sought, occasion_etag: ETAG[OCCASION.sought] },
    }),
  });

  c.is("412", crossed.status, 412, "a hold on an Occasion its `sought` refuses is 412, not 409 and not 400");
  const body = crossed.json as { code?: string; detail?: { from_occasion_id?: string; crossed_axis?: string } } | null;
  c.is("code", body?.code, "substitution_refused", "the code is substitution_refused");
  c.is(
    "detail.from",
    body?.detail?.from_occasion_id,
    OCCASION.sought,
    "S1's detail names the Occasion that refused, so an Agent knows which end of the pair to re-resolve",
  );
  c.that(
    "detail.axis",
    body?.detail?.crossed_axis === "presentation_class",
    `and names the axis the Publisher itself authored, not a guess (got ${JSON.stringify(body?.detail?.crossed_axis)})`,
  );

  const seats_after = await bench.db.query<{ n: string }>("select count(*)::text as n from hold_seat");
  const holds_after = await bench.db.query<{ n: string }>("select count(*)::text as n from hold");
  c.is(
    "no_seat_row",
    seats_after.rows[0]?.n,
    seats_before.rows[0]?.n,
    "and it writes NO hold_seat row — the refusal did not take the seats off the wall on its way out",
  );
  c.is(
    "no_hold_row",
    holds_after.rows[0]?.n,
    holds_before.rows[0]?.n,
    "nor a hold row, so nothing later reaps a Hold that was never granted",
  );

  // The negative control. Without it, a Server that refused every hold would
  // pass every assertion above.
  const permitted = await bench.call("POST", "/changeover/v0/holds", {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`subst-ok-${bench.nonce}`) },
    body: holdBody(["A:3"], {
      occasion_id: OCCASION.permitted,
      occasion_etag: ETAG[OCCASION.permitted],
      sought: { occasion_id: OCCASION.edge_from, occasion_etag: ETAG[OCCASION.edge_from] },
    }),
  });
  c.that(
    "attested_edge_grants",
    permitted.status === 201,
    `a hold whose sought attests ⪯ offered is GRANTED, so the guard is the poset and not a blanket refusal (got ${permitted.status} ${permitted.text.slice(0, 160)})`,
  );

  // And the poset agrees with the wire about why.
  const refusal = substitutionRefusal(emitted, OCCASION.sought, OCCASION.main);
  c.that(
    "poset_agrees",
    refusal !== null && refusal.crossed_axis === body?.detail?.crossed_axis,
    "the axis the boundary refused on is the axis substitutionRefusal names over the emitted poset — the wire and the semantics are one derivation",
  );

  /* ── 4 · A cross-origin edge is rejected at publish ───────────────────── */

  let policy_present = true;
  try {
    readFileSync(repoFile(CROSS_ORIGIN_POLICY), "utf8");
  } catch {
    policy_present = false;
  }

  if (!policy_present) {
    c.cannot(
      "e1_cross_origin",
      "the cross-origin policy fixture is absent, and an edge that leaves the venue's own origin cannot be authored without one",
      CROSS_ORIGIN_POLICY,
    );
  } else {
    const load = loadPolicyFile(repoFile(CROSS_ORIGIN_POLICY));
    const corpus = loadCorpusFiles(CROSS_ORIGIN_CORPUS.map((p) => repoFile(p)));
    const derived = load.policy === null ? null : deriveSubstitutions(load.policy, corpus);
    const errors = (derived?.diagnostics ?? []).filter((d) => d.severity === "error");
    c.that(
      "e1_cross_origin",
      errors.some((d) => d.code === "E1_CROSS_ORIGIN"),
      `deriving an edge whose target sits at another venue.origin raises E1_CROSS_ORIGIN as an error, so a publish pipeline branches on a code rather than on prose (got ${JSON.stringify(errors.map((d) => d.code))})`,
    );
    const crossed_edges = (derived?.base ?? []).filter((e) => e.kind === "permission");
    c.is(
      "e1_no_edge_emitted",
      crossed_edges.length,
      0,
      "and no permission edge survives derivation — E3 scopes a cluster to (venue.origin, cluster), so an edge across origins is not a weaker permission, it is none",
    );
  }

  /* ── 5 · Ignored by the reference Agent ───────────────────────────────── */

  c.cannot(
    "agent_ignores",
    "'ignored by the reference Agent' is a property of an Agent, and O2 assigns the origin check to the consumer precisely because the Server checking its own document constrains nobody; no Agent exists in this repository to be handed one",
    "packages/agent",
  );

  return c.items;
}
