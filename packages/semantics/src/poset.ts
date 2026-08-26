/**
 * poset.ts — the preorder over a candidate set, induced by ATTESTED edges.
 *
 * SPEC.md §2.3. `s ⪯ s'` reads "s' is an acceptable substitute for s".
 * Substitutability is a preorder: reflexive, transitive, deliberately NOT
 * antisymmetric. **The absence of an edge is the absence of permission, never
 * its presence.**
 *
 * Five decisions are recorded here rather than discovered in a failing proof,
 * because the fast path in this file and the deliberately naive oracle in
 * packages/semantics/test/lib/antichain-oracle.ts must agree on them in advance.
 *
 *   A1  REFLEXIVITY is a property of the relation, not a row in it.
 *       `reaches(p, a, a)` is true for every candidate a; self-pairs are never
 *       materialised, matching closure.ts — an Occasion listing itself as its
 *       own substitute is noise on the wire.
 *
 *   A2  This module derives its own reachability rather than importing
 *       closure.ts. §2.3 makes emitting the transitive closure a SERVER
 *       obligation. An Agent receives whatever it receives and MUST NOT assume
 *       the Server discharged that obligation; deriving the preorder on the
 *       Agent side is what keeps the antichain correct against a Server that
 *       under-emitted. The two implementations converge on one fixpoint from
 *       opposite ends, which is the only reason the oracle is comparable.
 *
 *   A3  A pair's axis label is the union over every WALK joining it — the least
 *       fixpoint of the union semiring, matching closure.ts's D5c. A cycle is
 *       two mutually substitutable screenings and a walk through it crosses its
 *       axes.
 *
 *   A4  Only PERMISSIONS compose. A negative edge (`not_substitutable_for`) is
 *       a refusal, never a permission, and it neither creates nor propagates
 *       domination. It is read for exactly two purposes: the axis it names is
 *       surfaced as a distinguishing axis, and it supplies `crossed_axis` on an
 *       S1 refusal.
 *
 *   A5  E2/S3. An edge whose target is absent from the resolved candidate set
 *       is INERT for the antichain — a phantom target is never a candidate, so
 *       it can neither dominate nor be dominated — and is STILL ENFORCED at
 *       commit, so `satisfiesStrictPolicy` reads the whole attested relation
 *       including edges that leave the candidate set.
 *
 * Nothing in this file reads `amount_minor`, `currency`, or any monetary value.
 * §2.3: an Agent "MUST NOT rank across a strict boundary by price". The price
 * facet carried here is the BAND LABEL only — an opaque token compared for
 * equality and never ordered. scripts/prove_antichain.sh asserts that absence
 * mechanically, because a rule that is only a comment is not a rule.
 *
 * The axis vocabulary below is declared locally rather than imported from
 * policy.ts, and is asserted set-equal to `$defs.axis` in schemas/common.schema.json
 * by both the test suite and the proof. A frozen schema is a better single
 * source than another module.
 */

/* ------------------------------------------------------------------ axes */

export const AXES = [
  "instant",
  "auditorium",
  "presentation_class",
  "occasion_class",
  "price_band",
  "seat",
  "accessibility",
] as const;

export type Axis = (typeof AXES)[number];

export type PolicyStrength = "strict" | "advisory";

/* ------------------------------------------------------------ candidates */

/** One entry of `substitution.accepts_substitute[]` or `.not_substitutable_for[]`. */
export interface AttestedEdge {
  occasion_id: string;
  axis: Axis;
}

/**
 * The read-side facets an Agent compares to name a distinguishing axis. Every
 * member here is compared for EQUALITY only. There is no ordering on any of
 * them, and there is deliberately no money.
 */
export interface CandidateFacets {
  /** `instant.starts_at` — RFC 3339 with a mandatory offset. Compared, never ordered. */
  instant?: string;
  /** `auditorium.id` — an opaqueId. Compared, never parsed (Z3). */
  auditorium_id?: string;
  /** `auditorium.seating` — allocated | unallocated | unknown. */
  seating?: string;
  /** `offers[].band.value` — the BAND LABELS. Never an amount. */
  price_bands?: readonly string[];
  /** `manner.accessibility` — the seven yes/no/unknown members. */
  accessibility?: Readonly<Record<string, string>>;
}

/** What `maximalAntichain` needs from a resolved Occasion, and nothing more. */
export interface Candidate {
  occasion_id: string;
  /** `substitution.policy`. */
  policy: PolicyStrength;
  presentation_classes?: readonly string[];
  occasion_classes?: readonly string[];
  /** `substitution.accepts_substitute[]` — this ⪯ target. */
  accepts_substitute?: readonly AttestedEdge[];
  /** `substitution.not_substitutable_for[]` — a refusal. Never a permission (A4). */
  not_substitutable_for?: readonly AttestedEdge[];
  facets?: CandidateFacets;
}

/* ---------------------------------------------------------------- poset */

export interface Poset {
  /** Candidate ids in DOCUMENT ORDER. Never sorted: Z3 forbids ordering an opaqueId. */
  readonly ids: readonly string[];
  readonly candidates: ReadonlyMap<string, Candidate>;
  /** One-step attested permission edges, including edges that leave the candidate set (A5). */
  readonly attested: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<Axis>>>;
  /** Attested refusals, both directions indexed. Never a permission (A4). */
  readonly refused: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<Axis>>>;
  /** Irreflexive transitive closure of `attested`, labelled by union over walks (A3). */
  readonly reach: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<Axis>>>;
  /** The `x-` extension class tokens each candidate carries. */
  readonly extensions: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * `x-` is the extension namespace of the 2026.1 register. The one-line test is
 * duplicated from policy.ts's `isExtensionClass` on purpose: this module must
 * stay free of the authoring side, which pulls in ajv, yaml and the filesystem.
 */
export function isExtensionClassToken(token: string): boolean {
  return token.startsWith("x-");
}

function classesOf(candidate: Candidate): string[] {
  return [...(candidate.presentation_classes ?? []), ...(candidate.occasion_classes ?? [])];
}

export function extensionClassesOf(candidate: Candidate): Set<string> {
  const out = new Set<string>();
  for (const token of classesOf(candidate)) if (isExtensionClassToken(token)) out.add(token);
  return out;
}

function indexEdges(
  candidates: readonly Candidate[],
  pick: (c: Candidate) => readonly AttestedEdge[] | undefined,
): Map<string, Map<string, Set<Axis>>> {
  const index = new Map<string, Map<string, Set<Axis>>>();
  for (const candidate of candidates) {
    const row = new Map<string, Set<Axis>>();
    for (const edge of pick(candidate) ?? []) {
      if (edge.occasion_id === candidate.occasion_id) continue; // reflexive: implicit (A1)
      const axes = row.get(edge.occasion_id) ?? new Set<Axis>();
      axes.add(edge.axis);
      row.set(edge.occasion_id, axes);
    }
    index.set(candidate.occasion_id, row);
  }
  return index;
}

/**
 * The transitive closure of the attested permission relation, computed per
 * source with a work queue that re-visits a node whose label grew. Deliberately
 * NOT the all-pairs relaxation the oracle uses.
 */
function closeOver(
  nodes: readonly string[],
  attested: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<Axis>>>,
): Map<string, Map<string, Set<Axis>>> {
  const empty: ReadonlyMap<string, ReadonlySet<Axis>> = new Map();
  const reach = new Map<string, Map<string, Set<Axis>>>();

  for (const source of nodes) {
    const reached = new Map<string, Set<Axis>>();
    const queue: string[] = [];
    for (const [to, axes] of attested.get(source) ?? empty) {
      reached.set(to, new Set(axes));
      queue.push(to);
    }
    while (queue.length > 0) {
      const via = queue.shift() as string;
      const soFar = reached.get(via) as Set<Axis>;
      for (const [next, step] of attested.get(via) ?? empty) {
        const existing = reached.get(next);
        if (!existing) {
          const grown = new Set<Axis>(soFar);
          for (const axis of step) grown.add(axis);
          reached.set(next, grown);
          queue.push(next);
          continue;
        }
        let grew = false;
        for (const axis of soFar) if (!existing.has(axis)) { existing.add(axis); grew = true; }
        for (const axis of step) if (!existing.has(axis)) { existing.add(axis); grew = true; }
        if (grew) queue.push(next);
      }
    }
    reached.delete(source); // A1: reflexivity is a property, not a row
    reach.set(source, reached);
  }
  return reach;
}

export function buildPoset(candidates: readonly Candidate[]): Poset {
  const map = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (map.has(candidate.occasion_id)) {
      throw new Error(`duplicate occasion_id in candidate set: ${candidate.occasion_id}`);
    }
    map.set(candidate.occasion_id, candidate);
  }

  const attested = indexEdges(candidates, (c) => c.accepts_substitute);
  const refused = indexEdges(candidates, (c) => c.not_substitutable_for);

  // Phantom targets (A5) are nodes of the relation but never candidates.
  const nodes: string[] = candidates.map((c) => c.occasion_id);
  const seen = new Set(nodes);
  for (const row of attested.values()) {
    for (const to of row.keys()) if (!seen.has(to)) { seen.add(to); nodes.push(to); }
  }
  for (const node of nodes) if (!attested.has(node)) attested.set(node, new Map());

  const extensions = new Map<string, ReadonlySet<string>>();
  for (const candidate of candidates) extensions.set(candidate.occasion_id, extensionClassesOf(candidate));

  return {
    ids: candidates.map((c) => c.occasion_id),
    candidates: map,
    attested,
    refused,
    reach: closeOver(nodes, attested),
    extensions,
  };
}

/* ------------------------------------------------------------- relation */

/** `a ⪯ b` — is b an acceptable substitute for a? Reflexive (A1). */
export function reaches(poset: Poset, a: string, b: string): boolean {
  if (a === b) return true;
  return poset.reach.get(a)?.has(b) === true;
}

/** The axes crossed by `a ⪯ b`, union over every walk (A3). Empty for a === b. */
export function reachAxes(poset: Poset, a: string, b: string): Axis[] {
  if (a === b) return [];
  return orderAxes(poset.reach.get(a)?.get(b) ?? new Set<Axis>());
}

/**
 * The `x-` extension classes that make a and b INCOMPARABLE, sorted.
 *
 * §2.3 / register 2026.1: "An x- extension class is INCOMPARABLE to every
 * registered class and to every other x- class." Two candidates carrying the
 * SAME x- token are not distinguished by it; a token present on one and absent
 * on the other is an unresolvable distinction, so the symmetric difference is
 * exactly the blocking set. Empty means nothing blocks.
 */
export function extensionBlock(poset: Poset, a: string, b: string): string[] {
  const left = poset.extensions.get(a) ?? new Set<string>();
  const right = poset.extensions.get(b) ?? new Set<string>();
  const out: string[] = [];
  for (const token of left) if (!right.has(token)) out.push(token);
  for (const token of right) if (!left.has(token)) out.push(token);
  return out.sort();
}

/**
 * Does `superior` STRICTLY dominate `inferior`?
 *
 * `inferior ⪯ superior` by an attested edge, and no attested edge back. An
 * `x-` block establishes domination in NEITHER direction, so it voids this
 * regardless of what is attested — otherwise the antichain treats a blocking
 * distinction as noise.
 */
export function strictlyDominates(poset: Poset, superior: string, inferior: string): boolean {
  if (superior === inferior) return false;
  if (!reaches(poset, inferior, superior)) return false;
  if (reaches(poset, superior, inferior)) return false;
  return extensionBlock(poset, superior, inferior).length === 0;
}

/** Neither dominates the other: a different night, no attested edge. */
export function incomparable(poset: Poset, a: string, b: string): boolean {
  if (a === b) return false;
  return !strictlyDominates(poset, a, b) && !strictlyDominates(poset, b, a);
}

/* ---------------------------------------------------- distinguishing axes */

function orderAxes(axes: Iterable<Axis>): Axis[] {
  const present = new Set(axes);
  return AXES.filter((axis) => present.has(axis));
}

function sameTokenSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  if (left.size !== right.size) return false;
  for (const token of left) if (!right.has(token)) return false;
  return true;
}

function sameRecord(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i++) {
    const key = leftKeys[i];
    if (key !== rightKeys[i]) return false;
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * The axes on which two candidates differ, in AXES order.
 *
 * Every comparison is an EQUALITY. `price_band` compares band labels; the
 * amount never enters this module (§2.3, "MUST NOT rank across a strict
 * boundary by price"). An axis appears because the two options genuinely
 * differ there, which is the thing a human is being asked to choose between.
 */
export function differingAxes(a: Candidate, b: Candidate): Axis[] {
  const out = new Set<Axis>();
  if ((a.facets?.instant ?? null) !== (b.facets?.instant ?? null)) out.add("instant");
  if ((a.facets?.auditorium_id ?? null) !== (b.facets?.auditorium_id ?? null)) out.add("auditorium");
  if (!sameTokenSet(a.presentation_classes, b.presentation_classes)) out.add("presentation_class");
  if (!sameTokenSet(a.occasion_classes, b.occasion_classes)) out.add("occasion_class");
  if (!sameTokenSet(a.facets?.price_bands, b.facets?.price_bands)) out.add("price_band");
  if ((a.facets?.seating ?? null) !== (b.facets?.seating ?? null)) out.add("seat");
  if (!sameRecord(a.facets?.accessibility, b.facets?.accessibility)) out.add("accessibility");
  return orderAxes(out);
}

/** The axis an `x-` token is surfaced on: the array of the candidate that carries it. */
export function axisForExtensionToken(poset: Poset, token: string, ids: readonly string[]): Axis {
  for (const id of ids) {
    const candidate = poset.candidates.get(id);
    if (!candidate) continue;
    if ((candidate.occasion_classes ?? []).includes(token)) return "occasion_class";
    if ((candidate.presentation_classes ?? []).includes(token)) return "presentation_class";
  }
  return "presentation_class";
}

/** Axes attested as refusals between two candidates, either direction (A4). */
export function refusedAxes(poset: Poset, a: string, b: string): Axis[] {
  const out = new Set<Axis>();
  for (const axis of poset.refused.get(a)?.get(b) ?? new Set<Axis>()) out.add(axis);
  for (const axis of poset.refused.get(b)?.get(a) ?? new Set<Axis>()) out.add(axis);
  return orderAxes(out);
}

/* ---------------------------------------------------------------- S1 */

/**
 * Does `offered` satisfy a `strict` non-substitutability assertion made by
 * `sought`? Pure boundary test; the caller decides whether the boundary binds.
 *
 * True when they are the same Occasion (the Agent held what was asked for),
 * or when `sought ⪯ offered` is attested AND no `x-` class blocks it. An `x-`
 * class MUST NOT satisfy a strict policy (§2.3, register 2026.1) — so an
 * attested edge across an `x-` boundary is not enough.
 *
 * Reads the WHOLE attested relation, including edges leaving the candidate set:
 * such an edge is inert for the antichain and still enforced here (S3, A5).
 */
export function satisfiesStrictPolicy(poset: Poset, sought_id: string, offered_id: string): boolean {
  if (sought_id === offered_id) return true;
  if (!reaches(poset, sought_id, offered_id)) return false;
  return extensionBlock(poset, sought_id, offered_id).length === 0;
}

export interface SubstitutionRefusalDetail {
  from_occasion_id: string;
  crossed_axis: Axis;
}

/**
 * S1. Where `sought ≠ offered`, sought's policy is `strict`, and no edge
 * `sought ⪯ offered` is attested, a Server MUST refuse `412 substitution_refused
 * {from_occasion_id, crossed_axis}`. Returns that detail, or null where the
 * substitution is permitted or the policy is advisory.
 *
 * The crossed axis is the Publisher's own word where they authored one: an
 * attested refusal names its axis. Otherwise it is the blocking `x-` class's
 * axis, and otherwise the first axis on which the two genuinely differ.
 */
export function substitutionRefusal(
  poset: Poset,
  sought_id: string,
  offered_id: string,
): SubstitutionRefusalDetail | null {
  if (sought_id === offered_id) return null;
  const sought = poset.candidates.get(sought_id);
  if (!sought || sought.policy !== "strict") return null;
  if (satisfiesStrictPolicy(poset, sought_id, offered_id)) return null;

  const authored = refusedAxes(poset, sought_id, offered_id);
  if (authored.length > 0) return { from_occasion_id: sought_id, crossed_axis: authored[0] };

  const blocking = extensionBlock(poset, sought_id, offered_id);
  if (blocking.length > 0) {
    return {
      from_occasion_id: sought_id,
      crossed_axis: axisForExtensionToken(poset, blocking[0], [sought_id, offered_id]),
    };
  }

  const offered = poset.candidates.get(offered_id);
  const differing = offered ? differingAxes(sought, offered) : [];
  return { from_occasion_id: sought_id, crossed_axis: differing[0] ?? "presentation_class" };
}

/* ------------------------------------------------------------ properties */

/** Is the derived relation transitively closed? Returns the first witness that says otherwise. */
export function transitivityWitness(poset: Poset): string | null {
  for (const [a, row] of poset.reach) {
    for (const b of row.keys()) {
      for (const c of poset.reach.get(b)?.keys() ?? []) {
        if (c === a) continue;
        if (!reaches(poset, a, c)) return `${a} -> ${b} -> ${c}, but ${a} -> ${c} is absent`;
      }
    }
  }
  return null;
}

/** Is the relation reflexive over every candidate? Returns the first witness that says otherwise. */
export function reflexivityWitness(poset: Poset): string | null {
  for (const id of poset.ids) if (!reaches(poset, id, id)) return `${id} is not ⪯ itself`;
  return null;
}
