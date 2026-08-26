/**
 * antichain.ts — the selection algorithm, and the argument this whole project
 * makes, in code.
 *
 * SPEC.md §2.3:
 *
 *     maximalAntichain(C, E):
 *       P ← preorder over C induced by attested edges E     # missing edge ⇒ no permission
 *       drop s ∈ C where ∃ s' ∈ C with s ≺ s' strictly      # dominated by an attested upgrade
 *       return remaining, each annotated with its distinguishing axes
 *
 * "Where the customer's intent touches any axis in the candidate set, an Agent
 * MUST return the maximal antichain — every non-dominated option with its
 * distinguishing axes — rather than a single optimum, and MUST NOT rank across
 * a strict boundary by price."
 *
 * Four things this function refuses to do, each of them the point:
 *
 *   B1  It never returns a winner. The return is a SET of non-dominated
 *       options. An agent that wants one answer has to choose, and choosing is
 *       the human's job. "The cheapest is $14" is not an available output.
 *
 *   B2  It never orders by price, and never reads a price. Members come back in
 *       the order the candidates were resolved — DOCUMENT ORDER — because any
 *       other order is a ranking, and Z3 forbids ordering an opaqueId as well.
 *       No money enters this module or poset.ts; the proof asserts the absence.
 *
 *   B3  It never invents an edge. Domination requires an ATTESTED upgrade. A
 *       missing edge is an absent permission, so a candidate nobody vouched for
 *       survives — which is the failure-safe direction and the expensive one.
 *
 *   B4  An `x-` extension class blocks domination in BOTH directions and is
 *       surfaced as a distinguishing axis. A Publisher who moves real semantics
 *       into an `x-` id gets an option that cannot be dropped and cannot
 *       satisfy a strict policy, rather than a blocking distinction treated as
 *       noise.
 *
 * The worked example (§9) is the frozen case: three Occasions in one cluster,
 * the Saturday DCP attests it accepts the Embassy 35mm as a substitute, so it
 * is DOMINATED and dropped though it costs less; the Sunday matinee is
 * INCOMPARABLE — a different night, no attested edge — and survives with
 * `accessibility` among its distinguishing axes. Two options, not one price.
 *
 * A second, deliberately naive oracle lives at
 * packages/semantics/test/lib/antichain-oracle.ts. It shares no code with this
 * file — no import, no helper, no type — and the property tests compare the two
 * over generated posets. That is the only honest way to test an algorithm whose
 * whole value is that it is right.
 */

import type { Axis, Candidate, Poset } from "./poset.ts";
import {
  AXES,
  buildPoset,
  differingAxes,
  extensionBlock,
  axisForExtensionToken,
  reachAxes,
  refusedAxes,
  strictlyDominates,
} from "./poset.ts";

/** One non-dominated option, with what makes it itself. */
export interface AntichainMember {
  occasion_id: string;
  /**
   * The axes on which this option differs from the other candidates that were
   * resolved alongside it, in the schema's axis order. Never a ranking.
   */
  distinguishing_axes: Axis[];
  /** The `x-` extension tokens that make this option incomparable to another candidate. */
  extension_classes: string[];
  /** Candidates this option strictly dominates, in document order, with the axes crossed. */
  supersedes: { occasion_id: string; axes: Axis[] }[];
}

/** One dropped option, and the attested upgrade that dropped it. */
export interface DroppedCandidate {
  occasion_id: string;
  /** The candidates that strictly dominate it, in document order. */
  dominated_by: string[];
  /** The axes crossed by the attested edge that established domination. */
  axes: Axis[];
}

export interface AntichainResult {
  /** The maximal antichain, in document order. A set, not a ranking (B1, B2). */
  members: AntichainMember[];
  /** What was dropped and why. Present so a refusal to show an option is auditable. */
  dropped: DroppedCandidate[];
  /** The preorder the selection was made against. */
  poset: Poset;
}

function union(into: Set<Axis>, axes: readonly Axis[]): void {
  for (const axis of axes) into.add(axis);
}

function orderAxes(axes: Iterable<Axis>): Axis[] {
  const present = new Set(axes);
  return AXES.filter((axis) => present.has(axis));
}

/**
 * Every non-dominated option, annotated with its distinguishing axes.
 *
 * `candidates` is the resolved set C, in the order it was resolved. Edges whose
 * target is absent from C are INERT here (E2/S3): a phantom cannot dominate and
 * cannot be dominated. They remain enforced at commit — see
 * `satisfiesStrictPolicy` in poset.ts.
 *
 * Distinguishing axes are computed against every other CANDIDATE, not only
 * against the survivors, so a lone survivor still carries the axes that make it
 * the one option. A single-candidate set is the honest boundary: nothing
 * distinguishes a lone option from nothing, and the annotation is empty. Two
 * Occasions in one cluster always differ on at least `instant` or `auditorium`,
 * because that is what makes them two screenings rather than one (§2.1).
 */
export function maximalAntichain(candidates: readonly Candidate[]): AntichainResult {
  const poset = buildPoset(candidates);
  const ids = poset.ids;

  const dominators = new Map<string, string[]>();
  for (const inferior of ids) {
    const found: string[] = [];
    for (const superior of ids) {
      if (strictlyDominates(poset, superior, inferior)) found.push(superior);
    }
    dominators.set(inferior, found);
  }

  const members: AntichainMember[] = [];
  const dropped: DroppedCandidate[] = [];

  for (const id of ids) {
    const found = dominators.get(id) as string[];
    if (found.length > 0) {
      const axes = new Set<Axis>();
      for (const superior of found) union(axes, reachAxes(poset, id, superior));
      dropped.push({ occasion_id: id, dominated_by: found, axes: orderAxes(axes) });
      continue;
    }

    const self = poset.candidates.get(id) as Candidate;
    const axes = new Set<Axis>();
    const extension_classes = new Set<string>();

    for (const other of ids) {
      if (other === id) continue;
      const peer = poset.candidates.get(other) as Candidate;

      // The facets on which the two options genuinely differ.
      union(axes, differingAxes(self, peer));

      // A Publisher's own authored refusal names its axis; surface their word.
      union(axes, refusedAxes(poset, id, other));

      // B4: an x- class MUST be surfaced as a distinguishing axis.
      const blocking = extensionBlock(poset, id, other);
      for (const token of blocking) {
        extension_classes.add(token);
        axes.add(axisForExtensionToken(poset, token, [id, other]));
      }
    }

    const supersedes: { occasion_id: string; axes: Axis[] }[] = [];
    for (const other of ids) {
      if (other === id) continue;
      if (strictlyDominates(poset, id, other)) {
        supersedes.push({ occasion_id: other, axes: reachAxes(poset, other, id) });
      }
    }

    members.push({
      occasion_id: id,
      distinguishing_axes: orderAxes(axes),
      extension_classes: [...extension_classes].sort(),
      supersedes,
    });
  }

  return { members, dropped, poset };
}

/** The member ids of the maximal antichain, in document order. Convenience for callers. */
export function antichainIds(candidates: readonly Candidate[]): string[] {
  return maximalAntichain(candidates).members.map((member) => member.occasion_id);
}

/* --------------------------------------------------- reading an Occasion */

interface ProseLike {
  value?: unknown;
}

interface OfferLike {
  band?: ProseLike;
}

/** The shape `candidateFromOccasion` reads. Every member is optional: a partial document is a partial candidate, never a throw. */
export interface OccasionLike {
  occasion_id?: unknown;
  auditorium?: { id?: unknown; seating?: unknown };
  instant?: { starts_at?: unknown };
  manner?: {
    presentation_classes?: unknown;
    occasion_classes?: unknown;
    accessibility?: unknown;
  };
  offers?: unknown;
  substitution?: {
    policy?: unknown;
    accepts_substitute?: unknown;
    not_substitutable_for?: unknown;
  };
  [key: string]: unknown;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function asEdges(value: unknown): { occasion_id: string; axis: Axis }[] {
  if (!Array.isArray(value)) return [];
  const out: { occasion_id: string; axis: Axis }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { occasion_id?: unknown; axis?: unknown };
    const occasion_id = asString(record.occasion_id);
    const axis = asString(record.axis) as Axis;
    if (!occasion_id) continue;
    if (!(AXES as readonly string[]).includes(axis)) continue;
    out.push({ occasion_id, axis });
  }
  return out;
}

function asBands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const band = asString((entry as OfferLike).band?.value);
    if (band) out.push(band);
  }
  return out.sort();
}

function asAccessibility(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/**
 * Read the antichain-relevant projection of a published Occasion.
 *
 * `offers[].amount_minor` is DELIBERATELY not read. The price facet is the band
 * LABEL, which is compared for equality and never ordered — §2.3 forbids
 * ranking across a strict boundary by price, and the surest way to honour that
 * is for the number never to arrive.
 */
export function candidateFromOccasion(document: OccasionLike): Candidate {
  const policy = asString(document.substitution?.policy) === "advisory" ? "advisory" : "strict";
  return {
    occasion_id: asString(document.occasion_id),
    policy,
    presentation_classes: asStrings(document.manner?.presentation_classes),
    occasion_classes: asStrings(document.manner?.occasion_classes),
    accepts_substitute: asEdges(document.substitution?.accepts_substitute),
    not_substitutable_for: asEdges(document.substitution?.not_substitutable_for),
    facets: {
      instant: asString(document.instant?.starts_at),
      auditorium_id: asString(document.auditorium?.id),
      seating: asString(document.auditorium?.seating),
      price_bands: asBands(document.offers),
      accessibility: asAccessibility(document.manner?.accessibility),
    },
  };
}
