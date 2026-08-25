/**
 * `changeover lint` — read the policy the way the Server will, and say what is
 * wrong with it before a single Occasion is published.
 *
 * The three checks the backlog names, and what each is actually protecting:
 *
 *   E1  An edge whose target is not resolvable at the venue's OWN origin is an
 *       error, not a warning. E1 is what turns SPEC.md §3.3's authoring
 *       prohibition into a mechanism: without it a Publisher can attest a
 *       defamatory claim about a competitor's room inside a 2000-character
 *       field served from an origin the specification declares authoritative.
 *       The realistic shape of the mistake is a circuit whose ticketing sits
 *       on a second hostname authoring one cluster across both; E3 scopes the
 *       cluster to (venue.origin, cluster), so those edges would silently
 *       vanish. Lint says why.
 *
 *   Cross-origin edges are refused at derivation, so `changeover derive` can
 *       never emit one — absent by construction, then reported.
 *
 *   A rule that can never fire is a warning, because a policy is authored once
 *       and read for years: `pres:35mm-4-perf` for `pres:35mm-4perf` is a rule
 *       that silently protects nothing, and nothing else in the system will
 *       ever mention it again.
 *
 * Exit codes are the CLI's, not this module's: 0 clean (warnings allowed),
 * 1 errors found, 2 could not read the inputs.
 */
import type { Corpus, PolicyLoad, PolicyRule, SubstitutionPolicy } from "./policy.ts";
import {
  expressionMatchesClass, expressionMatchesOccasion, inEffect, isAxisToken,
  isClassToken, isExtensionClass, isGlob, registerClasses, scopeMatches,
} from "./policy.ts";
import type { Diagnostic } from "./derive.ts";
import { deriveSubstitutions } from "./derive.ts";

export type { Diagnostic } from "./derive.ts";

function checkExpression(
  rule: PolicyRule, side: "subject" | "object", expression: string, out: Diagnostic[], root?: string,
): void {
  if (isAxisToken(expression)) {
    out.push({
      code: "UNSUPPORTED_AXIS_SUBJECT", severity: "warning", rule_id: rule.rule_id,
      message: `${rule.rule_id}: ${side} "${expression}" names an axis rather than a class. Axis-level rules are not derivable in v0.1 authoring — name the classes — and this rule emits nothing`,
    });
    return;
  }
  if (!isClassToken(expression)) {
    out.push({
      code: "MALFORMED_EXPRESSION", severity: "error", rule_id: rule.rule_id,
      message: `${rule.rule_id}: ${side} "${expression}" is not a class id, a class glob, or an axis`,
    });
    return;
  }
  if (isExtensionClass(expression)) {
    out.push({
      code: "X_CLASS_NOT_COMPARABLE", severity: "error", rule_id: rule.rule_id,
      message: `${rule.rule_id}: ${side} "${expression}" is an x- extension class, which is incomparable to every registered class and to every other x- class. It establishes domination in neither direction and MUST NOT satisfy a strict policy (SPEC.md 2.3), so this rule may not be authored`,
    });
    return;
  }
  if (isGlob(expression)) return;                      // a glob is checked against the corpus, not the register
  const register = registerClasses(root);
  if (!register.has(expression)) {
    let near = "";
    for (const id of register.keys()) {
      if (id.replace(/-/g, "") === expression.replace(/-/g, "")) { near = ` — did you mean "${id}"?`; break; }
    }
    out.push({
      code: "UNKNOWN_CLASS", severity: "error", rule_id: rule.rule_id,
      message: `${rule.rule_id}: ${side} "${expression}" is not in the 2026.1 class register${near}`,
    });
  }
}

/** Checks that need only the policy. */
export function lintRules(policy: SubstitutionPolicy, root?: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();

  for (const rule of policy.rules) {
    if (seen.has(rule.rule_id)) {
      out.push({
        code: "DUPLICATE_RULE_ID", severity: "error", rule_id: rule.rule_id,
        message: `rule_id "${rule.rule_id}" is used twice; derived_from.rule_ids would name one rule and mean two`,
      });
    }
    seen.add(rule.rule_id);

    if (rule.effective_to !== undefined && rule.effective_to < rule.effective_from) {
      out.push({
        code: "EFFECTIVE_WINDOW_INVERTED", severity: "error", rule_id: rule.rule_id,
        message: `${rule.rule_id}: effective_to ${rule.effective_to} precedes effective_from ${rule.effective_from}, so the rule is in force on no date at all`,
      });
    }

    checkExpression(rule, "subject", rule.subject, out, root);
    checkExpression(rule, "object", rule.object, out, root);

    if (expressionMatchesClass(rule.object, rule.subject) || expressionMatchesClass(rule.subject, rule.object)) {
      out.push({
        code: "SELF_RANKING", severity: "warning", rule_id: rule.rule_id,
        message: `${rule.rule_id}: subject "${rule.subject}" and object "${rule.object}" name overlapping classes, so a screening carrying both sides would refuse and permit the same pair`,
      });
    }
  }
  return out;
}

/** Checks that need a corpus: E1, contradictions, the wire cap, and rules that can never fire. */
export function lintAgainstCorpus(policy: SubstitutionPolicy, corpus: Corpus): Diagnostic[] {
  const derived = deriveSubstitutions(policy, corpus);
  const out: Diagnostic[] = [...derived.diagnostics];

  const fired = new Set<string>();
  for (const edge of derived.base) fired.add(edge.rule_id);
  for (const diagnostic of derived.diagnostics) {
    if (diagnostic.code === "E1_CROSS_ORIGIN" && diagnostic.rule_id) fired.add(diagnostic.rule_id);
  }

  const anyWorkIds = corpus.records.some((record) => record.work_ids.length > 0);

  for (const rule of policy.rules) {
    if (rule.scope?.work_id !== undefined && !anyWorkIds) {
      out.push({
        code: "WORK_ID_UNRESOLVABLE", severity: "warning", rule_id: rule.rule_id,
        message: `${rule.rule_id}: scope.work_id "${rule.scope.work_id}" cannot resolve — no Occasion in the corpus carries work.eidr or work.isan, the only work identifiers an Occasion document has`,
      });
    }
    if (fired.has(rule.rule_id)) continue;

    const scoped = corpus.records.filter((record) => scopeMatches(rule, record));
    const subjects = scoped.filter((record) => expressionMatchesOccasion(rule.subject, record));
    const objects = scoped.filter((record) => expressionMatchesOccasion(rule.object, record));
    const live = [...subjects, ...objects].filter((record) => inEffect(rule, record));

    let why: string;
    if (scoped.length === 0) why = "its scope matches no Occasion in the corpus";
    else if (subjects.length === 0 && objects.length === 0) why = `neither "${rule.subject}" nor "${rule.object}" matches a class carried by any Occasion in scope`;
    else if (subjects.length === 0) why = `no Occasion in scope carries "${rule.subject}"`;
    else if (objects.length === 0) why = `no Occasion in scope carries "${rule.object}"`;
    else if (live.length === 0) why = `no matching Occasion falls inside ${rule.effective_from}..${rule.effective_to ?? "open"}`;
    else why = "the two sides never meet inside one cluster";

    out.push({
      code: "RULE_NEVER_FIRES", severity: "warning", rule_id: rule.rule_id,
      message: `${rule.rule_id} produced no edge over this corpus: ${why}`,
    });
  }
  return out;
}

export interface LintResult {
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
}

export function lint(load: PolicyLoad, corpus?: Corpus, root?: string): LintResult {
  const diagnostics: Diagnostic[] = [];
  if (load.schema_error !== null || load.policy === null) {
    diagnostics.push({
      code: "SCHEMA_INVALID", severity: "error",
      message: `${load.source_path} does not validate against substitution-policy.schema.json: ${load.schema_error ?? "unreadable"}`,
    });
    return summarise(diagnostics);
  }
  diagnostics.push(...lintRules(load.policy, root));
  if (corpus) diagnostics.push(...lintAgainstCorpus(load.policy, corpus));
  return summarise(diagnostics);
}

function summarise(diagnostics: Diagnostic[]): LintResult {
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") errors++;
    else warnings++;
  }
  return { diagnostics, errors, warnings };
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const where = diagnostic.occasion_id ? ` [${diagnostic.occasion_id}]` : "";
  return `${diagnostic.severity === "error" ? "error" : "warn "} ${diagnostic.code}${where}: ${diagnostic.message}`;
}

/**
 * What a rule will do, in the author's terms. `lint --explain` prints this,
 * because the converse face of a ranking (D1) is the one part of the model an
 * author cannot see in what they typed.
 */
export function explainRule(rule: PolicyRule): string {
  if (rule.relation === "not_substitutable_for") {
    return [
      `${rule.rule_id}: ranks ${rule.subject} above ${rule.object} on ${rule.reason_code} (${rule.policy})`,
      `  refuses    — every ${rule.subject} screening publishes "not substitutable for" each ${rule.object} screening in its cluster`,
      `  permits    — every ${rule.object} screening publishes that a ${rule.subject} screening IS an acceptable substitute for it`,
      `  in force   — for screenings whose local date is ${rule.effective_from}..${rule.effective_to ?? "open"}`,
    ].join("\n");
  }
  return [
    `${rule.rule_id}: grants ${rule.object} as a substitute for ${rule.subject} on ${rule.reason_code} (${rule.policy})`,
    `  permits    — every ${rule.subject} screening publishes that a ${rule.object} screening is an acceptable substitute for it`,
    `  says nothing about the reverse: absence of an edge is absence of permission`,
    `  in force   — for screenings whose local date is ${rule.effective_from}..${rule.effective_to ?? "open"}`,
  ].join("\n");
}
