/**
 * antichain-oracle.ts — a SECOND, deliberately naive implementation of
 * SPEC.md §2.3's `maximalAntichain`, written to disagree with the fast one.
 *
 * It shares nothing with packages/semantics/src/antichain.ts or
 * packages/semantics/src/poset.ts: no import, no helper, no type, no constant.
 * Its input interfaces are declared here, from the specification, and
 * structural typing is the only thing the two implementations have in common.
 * That is the whole point — an oracle that imports the implementation proves
 * only that the implementation equals itself.
 *
 * Where the fast path is maps, sets and a per-source work queue, this is
 * index-based boolean matrices relaxed over all triples until nothing changes.
 * It is roughly O(n^4) and would be unusable on a real cluster of 128. It does
 * not have to be usable. It has to be OBVIOUSLY RIGHT.
 *
 * The specification it implements, in five lines:
 *   1. `s <= s'` is attested by s listing s' in `accepts_substitute`.
 *   2. The relation is reflexive and transitive; the absence of an edge is the
 *      absence of permission, never its presence.
 *   3. s' strictly dominates s when `s <= s'` and not `s' <= s`.
 *   4. An `x-` class carried by one and not the other blocks domination in
 *      BOTH directions.
 *   5. Drop every dominated candidate. Annotate what remains with the axes on
 *      which it differs from the other candidates.
 */

export type OracleAxis =
  | "instant" | "auditorium" | "presentation_class" | "occasion_class"
  | "price_band" | "seat" | "accessibility";

const ORACLE_AXIS_ORDER: OracleAxis[] = [
  "instant", "auditorium", "presentation_class", "occasion_class",
  "price_band", "seat", "accessibility",
];

export interface OracleEdge {
  occasion_id: string;
  axis: OracleAxis;
}

export interface OracleCandidate {
  occasion_id: string;
  policy?: string;
  presentation_classes?: readonly string[];
  occasion_classes?: readonly string[];
  accepts_substitute?: readonly OracleEdge[];
  not_substitutable_for?: readonly OracleEdge[];
  facets?: {
    instant?: string;
    auditorium_id?: string;
    seating?: string;
    price_bands?: readonly string[];
    accessibility?: Readonly<Record<string, string>>;
  };
}

export interface OracleMember {
  occasion_id: string;
  distinguishing_axes: OracleAxis[];
  extension_classes: string[];
  supersedes: { occasion_id: string; axes: OracleAxis[] }[];
}

export interface OracleDropped {
  occasion_id: string;
  dominated_by: string[];
  axes: OracleAxis[];
}

export interface OracleResult {
  members: OracleMember[];
  dropped: OracleDropped[];
}

/* --------------------------------------------------- comparison helpers */

function bag(values: readonly string[] | undefined): string {
  const unique: string[] = [];
  for (const value of values ?? []) if (unique.indexOf(value) < 0) unique.push(value);
  unique.sort();
  return JSON.stringify(unique);
}

function scalar(value: string | undefined): string {
  return value === undefined || value === null ? "<absent>" : value;
}

function record(value: Readonly<Record<string, string>> | undefined): string {
  const pairs: [string, string][] = [];
  const source = (value ?? {}) as Record<string, string>;
  for (const key of Object.keys(source)) pairs.push([key, source[key]]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(pairs);
}

function extensionTokens(candidate: OracleCandidate): string[] {
  const all = [...(candidate.presentation_classes ?? []), ...(candidate.occasion_classes ?? [])];
  const out: string[] = [];
  for (const token of all) {
    if (token.slice(0, 2) !== "x-") continue;
    if (out.indexOf(token) < 0) out.push(token);
  }
  return out;
}

function blockingTokens(a: OracleCandidate, b: OracleCandidate): string[] {
  const left = extensionTokens(a);
  const right = extensionTokens(b);
  const out: string[] = [];
  for (const token of left) if (right.indexOf(token) < 0 && out.indexOf(token) < 0) out.push(token);
  for (const token of right) if (left.indexOf(token) < 0 && out.indexOf(token) < 0) out.push(token);
  out.sort();
  return out;
}

function tokenAxis(token: string, a: OracleCandidate, b: OracleCandidate): OracleAxis {
  for (const candidate of [a, b]) {
    if ((candidate.occasion_classes ?? []).indexOf(token) >= 0) return "occasion_class";
    if ((candidate.presentation_classes ?? []).indexOf(token) >= 0) return "presentation_class";
  }
  return "presentation_class";
}

function differing(a: OracleCandidate, b: OracleCandidate): OracleAxis[] {
  const out: OracleAxis[] = [];
  if (scalar(a.facets?.instant) !== scalar(b.facets?.instant)) out.push("instant");
  if (scalar(a.facets?.auditorium_id) !== scalar(b.facets?.auditorium_id)) out.push("auditorium");
  if (bag(a.presentation_classes) !== bag(b.presentation_classes)) out.push("presentation_class");
  if (bag(a.occasion_classes) !== bag(b.occasion_classes)) out.push("occasion_class");
  if (bag(a.facets?.price_bands) !== bag(b.facets?.price_bands)) out.push("price_band");
  if (scalar(a.facets?.seating) !== scalar(b.facets?.seating)) out.push("seat");
  if (record(a.facets?.accessibility) !== record(b.facets?.accessibility)) out.push("accessibility");
  return out;
}

function inAxisOrder(axes: readonly OracleAxis[]): OracleAxis[] {
  const out: OracleAxis[] = [];
  for (const axis of ORACLE_AXIS_ORDER) if (axes.indexOf(axis) >= 0) out.push(axis);
  return out;
}

/* ------------------------------------------------------------- the oracle */

export function maximalAntichainOracle(candidates: readonly OracleCandidate[]): OracleResult {
  // Every node of the relation: the candidates, then every edge target that is
  // not one. A phantom is a node and never a candidate (E2 / S3).
  const nodes: string[] = [];
  for (const candidate of candidates) {
    if (nodes.indexOf(candidate.occasion_id) >= 0) throw new Error("duplicate occasion_id");
    nodes.push(candidate.occasion_id);
  }
  const candidateCount = nodes.length;
  for (const candidate of candidates) {
    for (const edge of candidate.accepts_substitute ?? []) {
      if (nodes.indexOf(edge.occasion_id) < 0) nodes.push(edge.occasion_id);
    }
  }
  const size = nodes.length;

  // One-step permission as a boolean matrix, with an axis-label matrix beside it.
  const reach: boolean[][] = [];
  const label: OracleAxis[][][] = [];
  for (let i = 0; i < size; i++) {
    reach.push(new Array<boolean>(size).fill(false));
    const row: OracleAxis[][] = [];
    for (let j = 0; j < size; j++) row.push([]);
    label.push(row);
  }

  const addAxis = (i: number, j: number, axis: OracleAxis): boolean => {
    if (label[i][j].indexOf(axis) >= 0) return false;
    label[i][j].push(axis);
    return true;
  };

  for (let i = 0; i < candidateCount; i++) {
    for (const edge of candidates[i].accepts_substitute ?? []) {
      const j = nodes.indexOf(edge.occasion_id);
      if (j === i) continue; // reflexivity is a property of the relation, not a row in it
      reach[i][j] = true;
      addAxis(i, j, edge.axis);
    }
  }

  // Transitive closure, the slow way: relax every triple until nothing changes.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < size; i++) {
      for (let k = 0; k < size; k++) {
        if (!reach[i][k]) continue;
        for (let j = 0; j < size; j++) {
          if (!reach[k][j]) continue;
          if (i === j) continue; // never materialise a self-pair
          if (!reach[i][j]) { reach[i][j] = true; changed = true; }
          for (const axis of label[i][k]) if (addAxis(i, j, axis)) changed = true;
          for (const axis of label[k][j]) if (addAxis(i, j, axis)) changed = true;
        }
      }
    }
  }

  const permits = (i: number, j: number): boolean => (i === j ? true : reach[i][j]);

  // Domination, over every ordered pair of candidates.
  const dominates: boolean[][] = [];
  for (let i = 0; i < candidateCount; i++) dominates.push(new Array<boolean>(candidateCount).fill(false));
  for (let superior = 0; superior < candidateCount; superior++) {
    for (let inferior = 0; inferior < candidateCount; inferior++) {
      if (superior === inferior) continue;
      if (!permits(inferior, superior)) continue;
      if (permits(superior, inferior)) continue;
      if (blockingTokens(candidates[superior], candidates[inferior]).length > 0) continue;
      dominates[superior][inferior] = true;
    }
  }

  const members: OracleMember[] = [];
  const dropped: OracleDropped[] = [];

  for (let i = 0; i < candidateCount; i++) {
    const dominated_by: string[] = [];
    for (let j = 0; j < candidateCount; j++) if (dominates[j][i]) dominated_by.push(nodes[j]);

    if (dominated_by.length > 0) {
      const axes: OracleAxis[] = [];
      for (let j = 0; j < candidateCount; j++) {
        if (!dominates[j][i]) continue;
        for (const axis of label[i][j]) if (axes.indexOf(axis) < 0) axes.push(axis);
      }
      dropped.push({ occasion_id: nodes[i], dominated_by, axes: inAxisOrder(axes) });
      continue;
    }

    const axes: OracleAxis[] = [];
    const extension_classes: string[] = [];
    for (let j = 0; j < candidateCount; j++) {
      if (j === i) continue;
      for (const axis of differing(candidates[i], candidates[j])) {
        if (axes.indexOf(axis) < 0) axes.push(axis);
      }
      for (const edge of candidates[i].not_substitutable_for ?? []) {
        if (edge.occasion_id === nodes[j] && axes.indexOf(edge.axis) < 0) axes.push(edge.axis);
      }
      for (const edge of candidates[j].not_substitutable_for ?? []) {
        if (edge.occasion_id === nodes[i] && axes.indexOf(edge.axis) < 0) axes.push(edge.axis);
      }
      for (const token of blockingTokens(candidates[i], candidates[j])) {
        if (extension_classes.indexOf(token) < 0) extension_classes.push(token);
        const axis = tokenAxis(token, candidates[i], candidates[j]);
        if (axes.indexOf(axis) < 0) axes.push(axis);
      }
    }

    const supersedes: { occasion_id: string; axes: OracleAxis[] }[] = [];
    for (let j = 0; j < candidateCount; j++) {
      if (j === i) continue;
      if (!dominates[i][j]) continue;
      supersedes.push({ occasion_id: nodes[j], axes: inAxisOrder(label[j][i]) });
    }

    extension_classes.sort();
    members.push({
      occasion_id: nodes[i],
      distinguishing_axes: inAxisOrder(axes),
      extension_classes,
      supersedes,
    });
  }

  return { members, dropped };
}

/* ------------------------------------------------------------------- S1 */

function closureFor(candidates: readonly OracleCandidate[]): (a: string, b: string) => boolean {
  const nodes: string[] = candidates.map((c) => c.occasion_id);
  for (const candidate of candidates) {
    for (const edge of candidate.accepts_substitute ?? []) {
      if (nodes.indexOf(edge.occasion_id) < 0) nodes.push(edge.occasion_id);
    }
  }
  const size = nodes.length;
  const reach: boolean[][] = [];
  for (let i = 0; i < size; i++) reach.push(new Array<boolean>(size).fill(false));
  for (const candidate of candidates) {
    const i = nodes.indexOf(candidate.occasion_id);
    for (const edge of candidate.accepts_substitute ?? []) {
      const j = nodes.indexOf(edge.occasion_id);
      if (i !== j) reach[i][j] = true;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < size; i++) {
      for (let k = 0; k < size; k++) {
        if (!reach[i][k]) continue;
        for (let j = 0; j < size; j++) {
          if (i !== j && reach[k][j] && !reach[i][j]) { reach[i][j] = true; changed = true; }
        }
      }
    }
  }
  return (a: string, b: string): boolean => {
    if (a === b) return true;
    const i = nodes.indexOf(a);
    const j = nodes.indexOf(b);
    return i >= 0 && j >= 0 && reach[i][j];
  };
}

/** Does `offered` satisfy a strict assertion by `sought`? The naive reading of S1. */
export function satisfiesStrictPolicyOracle(
  candidates: readonly OracleCandidate[],
  sought_id: string,
  offered_id: string,
): boolean {
  if (sought_id === offered_id) return true;
  const permits = closureFor(candidates);
  if (!permits(sought_id, offered_id)) return false;
  const sought = candidates.find((c) => c.occasion_id === sought_id);
  const offered = candidates.find((c) => c.occasion_id === offered_id);
  if (!sought || !offered) return true;
  return blockingTokens(sought, offered).length === 0;
}
