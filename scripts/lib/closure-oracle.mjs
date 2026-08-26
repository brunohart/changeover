// Transitive closure — HARNESS ONLY, and INDEPENDENT of the implementation.
//
// scripts/prove_policy_derive.sh asserts that the closure `changeover derive`
// emits equals the closure computed here, in both directions. That assertion
// is worth something only because this file shares no line of code with
// packages/semantics/src/closure.ts: it must never import it, and it must
// never be imported BY it. Two implementations of one fixpoint, written
// separately. This is the same discipline as scripts/lib/project.mjs, and for
// the same reason — a proof in which a program agrees with itself proves
// nothing at all.
//
// The relation being closed:
//
//   Edges are `{ from, to, axes[], rules[] }` over a fixed node set. Only
//   PERMISSIONS compose — refusals do not propagate and never reach this file.
//   A derived pair carries the UNION of the axes crossed and the rules used
//   over every walk joining it, which is the least fixpoint of the union
//   semiring (idempotent, commutative, associative: sum = union, product =
//   union). Cycles are ordinary — two mutually substitutable screenings are a
//   cycle — so walks, not simple paths, are the right quantifier.
//
//   Self-pairs are never emitted. Reflexivity is implicit in a preorder, and
//   an Occasion listing itself as its own substitute is noise on the wire.
//
// The algorithm is Floyd-Warshall over an index matrix. It is O(n^3) and it is
// chosen precisely because it is the textbook shape, arrived at from the
// definition rather than from the implementation's control flow.

/** @typedef {{ from: string, to: string, axes: string[], rules: string[] }} LabelledEdge */

/**
 * @param {readonly string[]} nodes
 * @param {readonly LabelledEdge[]} edges
 * @returns {LabelledEdge[]} the reflexive-free transitive closure, sorted by (from, to)
 */
export function closure(nodes, edges) {
  const index = new Map();
  nodes.forEach((node, i) => index.set(node, i));
  const n = nodes.length;

  // matrix[i][j] is null, or a { axes: Set, rules: Set } label.
  const matrix = Array.from({ length: n }, () => Array.from({ length: n }, () => null));

  const label = (i, j) => {
    if (matrix[i][j] === null) matrix[i][j] = { axes: new Set(), rules: new Set() };
    return matrix[i][j];
  };

  for (const edge of edges) {
    const i = index.get(edge.from);
    const j = index.get(edge.to);
    if (i === undefined || j === undefined) continue;
    if (i === j) continue;
    const cell = label(i, j);
    for (const axis of edge.axes ?? []) cell.axes.add(axis);
    for (const rule of edge.rules ?? []) cell.rules.add(rule);
  }

  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (matrix[i][k] === null) continue;
      for (let j = 0; j < n; j++) {
        if (matrix[k][j] === null) continue;
        const cell = label(i, j);
        for (const axis of matrix[i][k].axes) cell.axes.add(axis);
        for (const axis of matrix[k][j].axes) cell.axes.add(axis);
        for (const rule of matrix[i][k].rules) cell.rules.add(rule);
        for (const rule of matrix[k][j].rules) cell.rules.add(rule);
      }
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const cell = matrix[i][j];
      if (cell === null) continue;
      out.push({
        from: nodes[i],
        to: nodes[j],
        axes: [...cell.axes].sort(),
        rules: [...cell.rules].sort(),
      });
    }
  }
  out.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1));
  return out;
}

/** A stable, comparable rendering of one edge set. Two closures are equal iff these strings are. */
export function fingerprint(edges) {
  return edges
    .map((e) => `${e.from} -> ${e.to} [${[...(e.axes ?? [])].sort().join(",")}] {${[...(e.rules ?? [])].sort().join(",")}}`)
    .sort()
    .join("\n");
}

/**
 * Every pair the closure claims, verified against the definition directly:
 * a -> c is present iff some walk joins them. Breadth-first reachability, which
 * shares nothing with either closure implementation.
 * @returns {string|null} the first pair on which the claim and the definition disagree
 */
export function reachabilityWitness(nodes, edges, closed) {
  const adjacency = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from).push(edge.to);
  }
  const claimed = new Set(closed.map((e) => `${e.from} -> ${e.to}`));
  for (const source of nodes) {
    const seen = new Set();
    const queue = [...adjacency.get(source)];
    while (queue.length > 0) {
      const here = queue.shift();
      if (seen.has(here)) continue;
      seen.add(here);
      for (const next of adjacency.get(here)) queue.push(next);
    }
    for (const target of nodes) {
      if (target === source) continue;
      const reachable = seen.has(target);
      const isClaimed = claimed.has(`${source} -> ${target}`);
      if (reachable && !isClaimed) return `${source} -> ${target} is reachable and absent from the closure`;
      if (!reachable && isClaimed) return `${source} -> ${target} is claimed by the closure and not reachable`;
    }
  }
  return null;
}
