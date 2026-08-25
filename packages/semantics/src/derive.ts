/**
 * `changeover derive` — expand authored rules over CLASSES into per-Occasion
 * edge sets over INSTANCES, and emit the transitive closure.
 *
 * This is the moat in mechanical form. The arthouse authors roughly eight
 * rules once; this file rebuilds every screening's edge set on every
 * change-day, at O(rules x cluster^2) rather than O(cluster^2) of human
 * attention.
 *
 * Emission order is normative. `substitution` is inside PROJECTION_0_1, arrays
 * project in document order, so a non-deterministic order would move an etag
 * for no assertion change and invalidate every in-flight resolution across an
 * estate. Edges sort by occasion_id, then axis, then reason_code.
 */
import type {
  Axis, Corpus, NegativeEdge, OccasionDocument, OccasionRecord, PolicyRule,
  PolicyStrength, PositiveEdge, Prose, Substitution, SubstitutionPolicy,
} from "./policy.ts";
import {
  axisForReason, expressionMatchesOccasion, inEffect, namesExtensionClass, scopeMatches,
} from "./policy.ts";
import type { LabelledEdge } from "./closure.ts";
import { transitiveClosure } from "./closure.ts";

export type DiagnosticCode =
  | "SCHEMA_INVALID"
  | "DUPLICATE_RULE_ID"
  | "EFFECTIVE_WINDOW_INVERTED"
  | "UNKNOWN_CLASS"
  | "MALFORMED_EXPRESSION"
  | "UNSUPPORTED_AXIS_SUBJECT"
  | "X_CLASS_NOT_COMPARABLE"
  | "E1_CROSS_ORIGIN"
  | "CONTRADICTION"
  | "EDGE_CAP_EXCEEDED"
  | "RULE_NEVER_FIRES"
  | "WORK_ID_UNRESOLVABLE"
  | "CLUSTER_MISSING"
  | "SELF_RANKING";

export type Severity = "error" | "warning";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  rule_id?: string;
  occasion_id?: string;
  target_occasion_id?: string;
}

/** One direct expansion of one rule onto one ordered pair, before closure. */
export interface BaseEdge {
  kind: "permission" | "refusal";
  /** The Occasion the edge is published on. */
  from: string;
  to: string;
  axis: Axis;
  reason_code: PolicyRule["reason_code"];
  detail?: Prose;
  rule_id: string;
  policy: PolicyStrength;
  /** True where this permission is the converse face of a ranking (D1). */
  converse: boolean;
}

export interface DeriveResult {
  /** occasion_id -> the derived substitution block. */
  blocks: Map<string, Substitution>;
  /** The direct expansion, before closure. The proof feeds this to the oracle. */
  base: BaseEdge[];
  /** The closed permission relation, cluster by cluster. */
  closed: LabelledEdge[];
  diagnostics: Diagnostic[];
}

/** The wire arrays cap at 64 entries (substitution.schema.json). */
export const EDGE_CAP = 64;

const byOccasionThenAxis = (a: PositiveEdge, b: PositiveEdge): number =>
  a.occasion_id === b.occasion_id ? (a.axis < b.axis ? -1 : a.axis > b.axis ? 1 : 0)
    : a.occasion_id < b.occasion_id ? -1 : 1;

const byOccasionAxisReason = (a: NegativeEdge, b: NegativeEdge): number => {
  const first = byOccasionThenAxis(a, b);
  if (first !== 0) return first;
  return a.reason_code < b.reason_code ? -1 : a.reason_code > b.reason_code ? 1 : 0;
};

/**
 * The direct expansion. No closure, no contradiction resolution — those are
 * separate steps so that each can be checked separately, and so that the
 * closure proof has an independent input to hand the oracle.
 */
export function expandRules(
  policy: SubstitutionPolicy,
  records: readonly OccasionRecord[],
  diagnostics: Diagnostic[],
): BaseEdge[] {
  const clusters = new Map<string, OccasionRecord[]>();
  for (const record of records) {
    if (!record.cluster) {
      diagnostics.push({
        code: "CLUSTER_MISSING", severity: "warning", occasion_id: record.occasion_id,
        message: `${record.occasion_id} carries no substitution.cluster, so no rule can reach it`,
      });
      continue;
    }
    const group = clusters.get(record.cluster) ?? [];
    group.push(record);
    clusters.set(record.cluster, group);
  }

  const edges: BaseEdge[] = [];
  const seenCrossOrigin = new Set<string>();

  const emit = (
    kind: BaseEdge["kind"], rule: PolicyRule, from: OccasionRecord, to: OccasionRecord, converse: boolean,
  ): void => {
    if (from.occasion_id === to.occasion_id) return;
    // E1 / E3. Every edge target MUST identify an Occasion published at the
    // SAME venue.origin, and `cluster` is scoped (venue.origin, cluster). One
    // cluster string used at two origins is two clusters, and an edge across
    // that boundary is refused at publish rather than silently dropped.
    if (from.origin !== to.origin) {
      const key = `${rule.rule_id}|${from.occasion_id}|${to.occasion_id}`;
      if (!seenCrossOrigin.has(key)) {
        seenCrossOrigin.add(key);
        diagnostics.push({
          code: "E1_CROSS_ORIGIN", severity: "error", rule_id: rule.rule_id,
          occasion_id: from.occasion_id, target_occasion_id: to.occasion_id,
          message: `E1: rule ${rule.rule_id} would target ${to.occasion_id} at ${to.origin} from ${from.occasion_id} at ${from.origin}; an edge MUST target an Occasion at the same venue.origin, and cluster "${from.cluster}" is scoped (origin, cluster)`,
        });
      }
      return;
    }
    edges.push({
      kind,
      from: from.occasion_id,
      to: to.occasion_id,
      axis: axisForReason(rule.reason_code),
      reason_code: rule.reason_code,
      detail: rule.detail,
      rule_id: rule.rule_id,
      policy: rule.policy,
      converse,
    });
  };

  for (const group of clusters.values()) {
    for (const subject of group) {
      for (const rule of policy.rules) {
        if (namesExtensionClass(rule)) continue;           // D8, reported by lint
        if (!scopeMatches(rule, subject)) continue;
        if (!inEffect(rule, subject)) continue;            // D2

        const isSubject = expressionMatchesOccasion(rule.subject, subject);
        const isObject = expressionMatchesOccasion(rule.object, subject);

        if (rule.relation === "not_substitutable_for") {
          // The ranking's near face: the refusal, published on the screening
          // that is ranked above.
          if (isSubject) {
            for (const other of group) {
              if (expressionMatchesOccasion(rule.object, other)) emit("refusal", rule, subject, other, false);
            }
          }
          // D1, the converse face: the screening ranked above IS an acceptable
          // substitute for the one below it, published on the one below.
          if (isObject) {
            for (const other of group) {
              if (expressionMatchesOccasion(rule.subject, other)) emit("permission", rule, subject, other, true);
            }
          }
        } else if (isSubject) {
          // A grant. One direction only: silence about the reverse is the
          // absence of permission, never its presence.
          for (const other of group) {
            if (expressionMatchesOccasion(rule.object, other)) emit("permission", rule, subject, other, false);
          }
        }
      }
    }
  }
  return edges;
}

const pairKey = (from: string, to: string): string => `${from} ${to}`;

/**
 * Derive every Occasion's edge set from the policy.
 *
 * D6. A permission the Publisher explicitly refused is NEVER emitted, whether
 * it was authored directly or implied by transitivity. Publishing a permission
 * over the top of an authored refusal would be the one failure this whole
 * mechanism exists to make impossible, so the refusal wins and the
 * contradiction is reported as an error — `changeover derive` exits non-zero
 * and the policy is fixed rather than published.
 */
export function deriveSubstitutions(policy: SubstitutionPolicy, corpus: Corpus): DeriveResult {
  const diagnostics: Diagnostic[] = [];
  const base = expandRules(policy, corpus.records, diagnostics);

  const refusalPairs = new Set<string>();
  for (const edge of base) if (edge.kind === "refusal") refusalPairs.add(pairKey(edge.from, edge.to));

  const permissions: LabelledEdge[] = [];
  for (const edge of base) {
    if (edge.kind !== "permission") continue;
    if (refusalPairs.has(pairKey(edge.from, edge.to))) {
      diagnostics.push({
        code: "CONTRADICTION", severity: "error", rule_id: edge.rule_id,
        occasion_id: edge.from, target_occasion_id: edge.to,
        message: `the policy both permits and refuses ${edge.from} -> ${edge.to}; the refusal stands and the permission is not published`,
      });
      continue;
    }
    permissions.push({ from: edge.from, to: edge.to, axes: [edge.axis], rules: [edge.rule_id] });
  }

  // Closure runs cluster by cluster: E3 scopes the cluster to one origin, so a
  // path may never be completed through a screening in another grouping.
  const byCluster = new Map<string, OccasionRecord[]>();
  for (const record of corpus.records) {
    if (!record.cluster) continue;
    const group = byCluster.get(record.cluster) ?? [];
    group.push(record);
    byCluster.set(record.cluster, group);
  }

  const closed: LabelledEdge[] = [];
  for (const group of byCluster.values()) {
    const ids = group.map((r) => r.occasion_id);
    const inside = new Set(ids);
    const slice = permissions.filter((e) => inside.has(e.from) && inside.has(e.to));
    for (const edge of transitiveClosure(ids, slice)) {
      if (refusalPairs.has(pairKey(edge.from, edge.to))) {
        diagnostics.push({
          code: "CONTRADICTION", severity: "error",
          occasion_id: edge.from, target_occasion_id: edge.to,
          rule_id: edge.rules.join(","),
          message: `transitivity implies ${edge.from} is substitutable by ${edge.to} (via ${edge.rules.join(", ")}), which the policy explicitly refuses; the refusal stands and the implied permission is not published`,
        });
        continue;
      }
      closed.push(edge);
    }
  }

  // derived_from.rule_ids: every rule that produced an edge INCIDENT on this
  // Occasion — outbound, inbound, or contributing a hop published here (D3).
  const incidentRules = new Map<string, Set<string>>();
  const incidentStrength = new Map<string, PolicyStrength[]>();
  const touch = (occasion_id: string, rule_id: string, strength?: PolicyStrength): void => {
    const rules = incidentRules.get(occasion_id) ?? new Set<string>();
    rules.add(rule_id);
    incidentRules.set(occasion_id, rules);
    if (strength) {
      const list = incidentStrength.get(occasion_id) ?? [];
      list.push(strength);
      incidentStrength.set(occasion_id, list);
    }
  };
  for (const edge of base) {
    if (edge.kind === "permission" && refusalPairs.has(pairKey(edge.from, edge.to))) continue;
    touch(edge.from, edge.rule_id, edge.policy);
    touch(edge.to, edge.rule_id, edge.policy);
  }
  for (const edge of closed) for (const rule_id of edge.rules) touch(edge.from, rule_id);

  const positives = new Map<string, Map<string, PositiveEdge>>();
  for (const edge of closed) {
    const row = positives.get(edge.from) ?? new Map<string, PositiveEdge>();
    for (const axis of edge.axes) row.set(`${edge.to}|${axis}`, { occasion_id: edge.to, axis });
    positives.set(edge.from, row);
  }

  const negatives = new Map<string, Map<string, NegativeEdge>>();
  for (const edge of base) {
    if (edge.kind !== "refusal") continue;
    const row = negatives.get(edge.from) ?? new Map<string, NegativeEdge>();
    const key = `${edge.to}|${edge.axis}|${edge.reason_code}`;
    if (!row.has(key)) {
      const negative: NegativeEdge = { occasion_id: edge.to, axis: edge.axis, reason_code: edge.reason_code };
      if (edge.detail) negative.detail = edge.detail;
      row.set(key, negative);
    }
    negatives.set(edge.from, row);
  }

  const blocks = new Map<string, Substitution>();
  for (const record of corpus.records) {
    if (!record.cluster) continue;
    const accepts = [...(positives.get(record.occasion_id)?.values() ?? [])].sort(byOccasionThenAxis);
    const refuses = [...(negatives.get(record.occasion_id)?.values() ?? [])].sort(byOccasionAxisReason);
    const strengths = incidentStrength.get(record.occasion_id) ?? [];
    const strength: PolicyStrength =
      strengths.length > 0 && strengths.every((s) => s === "advisory") ? "advisory" : "strict";

    const counted: readonly (readonly [string, number])[] = [
      ["accepts_substitute", accepts.length],
      ["not_substitutable_for", refuses.length],
    ];
    for (const [label, count] of counted) {
      if (count > EDGE_CAP) {
        diagnostics.push({
          code: "EDGE_CAP_EXCEEDED", severity: "error", occasion_id: record.occasion_id,
          message: `${record.occasion_id}.${label} derives ${count} edges; the wire caps at ${EDGE_CAP}`,
        });
      }
    }

    blocks.set(record.occasion_id, {
      cluster: record.cluster,
      policy: strength,
      accepts_substitute: accepts,
      not_substitutable_for: refuses,
      derived_from: {
        policy_id: policy.policy_id,
        rule_ids: [...(incidentRules.get(record.occasion_id) ?? new Set<string>())].sort(),
        rule_version: policy.rule_version,
      },
    });
  }

  return { blocks, base, closed, diagnostics };
}

/** The published Occasion with its derived substitution block in place. `cluster` is authored and survives. */
export function applySubstitution(document: OccasionDocument, block: Substitution): OccasionDocument {
  return { ...document, substitution: block };
}
