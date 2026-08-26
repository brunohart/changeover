/**
 * Transitive closure of the permission relation.
 *
 * SPEC.md §2.3: "A Server MUST derive the per-Occasion edge set from the
 * policy at publish time, MUST emit the transitive closure ... Transitivity is
 * a Server obligation, not a property asserted of hand-authored data a
 * Publisher can break by omission."
 *
 * Two properties of this closure are decisions, not incidentals:
 *
 *   D5  Only PERMISSIONS compose. `s ⪯ s'` and `s' ⪯ s''` give `s ⪯ s''`.
 *       Refusals do not: ¬(a ⪯ b) and ¬(b ⪯ c) say nothing whatever about
 *       (a, c), and a closure that propagated them would publish assertions
 *       the Publisher never made.
 *
 *   D5b An edge carries the axes it crosses and the rules that produced it,
 *       and a derived edge carries the UNION over every path joining the pair.
 *       The wire allows one axis per entry and dedupes on (occasion_id, axis),
 *       so a two-axis derivation surfaces as two entries — which is what an
 *       Agent needs, since it must present the distinguishing axes.
 *
 *   D5c A pair's label is the union over every WALK joining it, not every
 *       simple path. Two mutually substitutable screenings are a cycle, and a
 *       walk through that cycle crosses its axes. This is the least fixpoint
 *       of the union semiring, which is exactly what a Floyd-Warshall over the
 *       same relation converges to — it is what makes the oracle comparable at
 *       all, and it is stated here because the two implementations must agree
 *       on it in advance rather than discover it in a failing proof.
 *
 * The algorithm is per-source label relaxation with a work queue: each source
 * pushes its label unions outward and re-visits a node whose label grew. It is
 * deliberately NOT the Floyd-Warshall in scripts/lib/closure-oracle.mjs, which
 * the proof compares against — two implementations of one fixpoint, written
 * separately, agreeing in both directions.
 */
import type { Axis } from "./policy.ts";

export interface LabelledEdge {
  from: string;
  to: string;
  axes: readonly Axis[];
  rules: readonly string[];
}

interface Label {
  axes: Set<Axis>;
  rules: Set<string>;
}

const emptyLabel = (): Label => ({ axes: new Set<Axis>(), rules: new Set<string>() });

/** Union `source` into `target`. Returns true when `target` grew. */
function absorb(target: Label, source: Label): boolean {
  let grew = false;
  for (const axis of source.axes) if (!target.axes.has(axis)) { target.axes.add(axis); grew = true; }
  for (const rule of source.rules) if (!target.rules.has(rule)) { target.rules.add(rule); grew = true; }
  return grew;
}

function compose(a: Label, b: Label): Label {
  const out = emptyLabel();
  absorb(out, a);
  absorb(out, b);
  return out;
}

export function sortEdges(edges: readonly LabelledEdge[]): LabelledEdge[] {
  return [...edges].sort((x, y) => (x.from === y.from ? (x.to < y.to ? -1 : x.to > y.to ? 1 : 0) : x.from < y.from ? -1 : 1));
}

/**
 * The reflexive-free transitive closure of a labelled relation.
 * Self-pairs are never emitted: reflexivity is implicit in the preorder and an
 * Occasion listing itself as its own substitute is noise on the wire.
 */
export function transitiveClosure(nodes: readonly string[], edges: readonly LabelledEdge[]): LabelledEdge[] {
  const present = new Set(nodes);
  const adjacency = new Map<string, Map<string, Label>>();
  for (const node of nodes) adjacency.set(node, new Map<string, Label>());

  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (!present.has(edge.from) || !present.has(edge.to)) continue;
    const row = adjacency.get(edge.from)!;
    const label = row.get(edge.to) ?? emptyLabel();
    for (const axis of edge.axes) label.axes.add(axis);
    for (const rule of edge.rules) label.rules.add(rule);
    row.set(edge.to, label);
  }

  const out: LabelledEdge[] = [];
  for (const source of nodes) {
    const reached = new Map<string, Label>();
    const queue: string[] = [];
    for (const [to, label] of adjacency.get(source)!) {
      reached.set(to, compose(emptyLabel(), label));
      queue.push(to);
    }
    while (queue.length > 0) {
      const via = queue.shift()!;
      const soFar = reached.get(via)!;
      for (const [next, step] of adjacency.get(via)!) {
        const candidate = compose(soFar, step);
        const existing = reached.get(next);
        if (!existing) { reached.set(next, candidate); queue.push(next); continue; }
        if (absorb(existing, candidate)) queue.push(next);
      }
    }
    for (const [to, label] of reached) {
      if (to === source) continue;                  // reflexive: implicit, never emitted
      out.push({
        from: source,
        to,
        axes: [...label.axes].sort(),
        rules: [...label.rules].sort(),
      });
    }
  }
  return sortEdges(out);
}

/** Is this relation transitively closed? Returns the first witness that says otherwise. */
export function transitivityWitness(edges: readonly LabelledEdge[]): string | null {
  const index = new Map<string, Set<string>>();
  for (const edge of edges) {
    const row = index.get(edge.from) ?? new Set<string>();
    row.add(edge.to);
    index.set(edge.from, row);
  }
  for (const [a, viaSet] of index) {
    for (const b of viaSet) {
      for (const c of index.get(b) ?? new Set<string>()) {
        if (c === a) continue;
        if (!index.get(a)?.has(c)) return `${a} -> ${b} -> ${c}, but ${a} -> ${c} is absent`;
      }
    }
  }
  return null;
}
