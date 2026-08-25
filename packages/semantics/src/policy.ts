/**
 * changeover.policy.yaml — the authoring form, its vocabulary, and the
 * predicates that decide whether one authored rule speaks about one Occasion.
 *
 * SPEC.md §2.3 is the authority. Edges are authored AS RULES OVER CLASSES,
 * never as pairs over instances: an arthouse writes roughly eight rules once
 * and never touches them again, while a circuit rebuilds thousands of
 * screenings every change-day and every occasion_id is new.
 *
 * The authoring decisions this file encodes — each one load-bearing, each one
 * visible in `changeover lint --explain`:
 *
 *   D1  A rule is a DIRECTED statement between two class expressions.
 *       `not_substitutable_for(S, O)` ranks S above O on an axis, and a
 *       ranking has two faces: for a ∈ S and b ∈ O it publishes the refusal
 *       ¬(a ⪯ b) on a AND the converse permission b ⪯ a on b. That is the
 *       specification's own sentence — "a 70mm print at seven is an acceptable
 *       substitute for a DCP at nine; the DCP is not an acceptable substitute
 *       for the 70mm" — as ONE authored claim, and it is why SPEC.md §2.3 can
 *       say of the dominated cheaper screening that "the remedy is not to
 *       attest the edge".
 *       `accepts_substitute(S, O)` is a GRANT, not a ranking: it publishes
 *       a ⪯ b on a and says nothing about b, so mutual substitutability
 *       remains authorable and no refusal is ever manufactured.
 *
 *   D2  The effective window is evaluated against the Occasion the edge is
 *       PUBLISHED ON, using instant.local_wall's calendar date — never UTC
 *       (SPEC.md §2.8). A rule is in force for a screening on the dates it
 *       covers; the edges it emits are that screening's claims about others.
 *
 *   D3  derived_from.rule_ids names every rule that produced an edge INCIDENT
 *       on this Occasion — outbound, inbound, or contributing to a transitive
 *       hop published here. An Occasion with an empty edge set that names a
 *       rule is saying something true and useful: the policy was evaluated and
 *       the answer was no edge. See derive.ts.
 *
 *   D4  The wire `axis` is derived from the author's own `reason_code`. One
 *       source, no second vocabulary to keep in step.
 *
 *   D8  An `x-` extension class is incomparable to every registered class and
 *       to every other `x-` class (SPEC.md §2.3, register 2026.1 policy note).
 *       A rule naming one would establish domination, so it is an error and
 *       emits nothing.
 *
 * No settlement, no personal data. A policy rule names classes and dates.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as ajvFormats from "ajv-formats";

// ajv and ajv-formats are CommonJS, and tsconfig.json sets neither
// esModuleInterop nor allowSyntheticDefaultImports — deliberately, because the
// runtime is Node stripping types with no bundler underneath it. ajv publishes
// a named export and needs nothing; ajv-formats exports only the plugin
// itself, so the callable is reached through the namespace and typed here
// rather than inferred through an interop shim that does not exist.
const addFormats = ajvFormats.default as unknown as (ajv: Ajv2020, options?: unknown) => void;

export type Relation = "accepts_substitute" | "not_substitutable_for";
export type PolicyStrength = "strict" | "advisory";
export type ReasonCode = "format" | "carrier" | "occasion" | "accessibility" | "language" | "room" | "time";
export type Axis =
  | "instant" | "auditorium" | "presentation_class" | "occasion_class"
  | "price_band" | "seat" | "accessibility";
export type AuthoredBy = "venue" | "programmer";

/** PR: non-load-bearing human text. Never an instruction. */
export interface Prose {
  content_type: "text/plain";
  value: string;
}

export interface RuleScope {
  venue_id?: string;
  work_id?: string;
  cluster_pattern?: string;
}

export interface PolicyRule {
  rule_id: string;
  scope?: RuleScope;
  subject: string;
  relation: Relation;
  object: string;
  policy: PolicyStrength;
  reason_code: ReasonCode;
  detail?: Prose;
  authored_by: AuthoredBy;
  authored_at: string;
  effective_from: string;
  effective_to?: string;
}

export interface SubstitutionPolicy {
  policy_id: string;
  rule_version: string;
  rules: PolicyRule[];
}

/* ------------------------------------------------------------------ wire */

export interface PositiveEdge {
  occasion_id: string;
  axis: Axis;
}

export interface NegativeEdge {
  occasion_id: string;
  axis: Axis;
  reason_code: ReasonCode;
  detail?: Prose;
}

export interface DerivedFrom {
  policy_id: string;
  rule_ids: string[];
  rule_version: string;
}

export interface Substitution {
  cluster: string;
  policy: PolicyStrength;
  accepts_substitute: PositiveEdge[];
  not_substitutable_for: NegativeEdge[];
  derived_from: DerivedFrom;
}

/* -------------------------------------------------------------- corpus */

/**
 * What derivation needs from an Occasion. Everything here is read from a
 * published Occasion document; nothing here is personal data, and `cluster`
 * is AUTHORED (the Publisher's own grouping) rather than derived.
 */
export interface OccasionRecord {
  occasion_id: string;
  venue_id: string;
  origin: string;
  cluster: string;
  /** YYYY-MM-DD, read from instant.local_wall. Never UTC (SPEC.md §2.8). */
  local_date: string;
  presentation_classes: string[];
  occasion_classes: string[];
  /** work.eidr / work.isan — the only work identifiers an Occasion carries. */
  work_ids: string[];
  source_path?: string;
}

export const AXIS_FOR_REASON: Readonly<Record<ReasonCode, Axis>> = {
  format: "presentation_class",
  carrier: "presentation_class",
  language: "presentation_class",
  occasion: "occasion_class",
  accessibility: "accessibility",
  room: "auditorium",
  time: "instant",
};

export const AXIS_TOKENS: readonly Axis[] = [
  "instant", "auditorium", "presentation_class", "occasion_class",
  "price_band", "seat", "accessibility",
];

export function axisForReason(reason_code: ReasonCode): Axis {
  return AXIS_FOR_REASON[reason_code];
}

/** The repository root, from this file's own location. */
export function repoRoot(): string {
  return join(import.meta.dirname, "..", "..", "..");
}

/* ------------------------------------------------------------- register */

export interface RegisterClass {
  id: string;
  axis: string;
  label: string;
  retired_at?: string;
}

const REGISTER_CACHE = new Map<string, Map<string, RegisterClass>>();

/** The 2026.1 class register: the hand-authored vocabulary of which differences are differences. */
export function registerClasses(root: string = repoRoot()): Map<string, RegisterClass> {
  const cached = REGISTER_CACHE.get(root);
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(join(root, "register", "2026.1.json"), "utf8")) as { classes: RegisterClass[] };
  const map = new Map<string, RegisterClass>();
  for (const cls of raw.classes) map.set(cls.id, cls);
  REGISTER_CACHE.set(root, map);
  return map;
}

export function isExtensionClass(token: string): boolean {
  return token.startsWith("x-");
}

export function isAxisToken(token: string): boolean {
  return (AXIS_TOKENS as readonly string[]).includes(token);
}

export function isGlob(token: string): boolean {
  return token.includes("*");
}

export function isClassToken(token: string): boolean {
  return /^(pres:[a-z0-9*-]+|occ:[a-z0-9*-]+|x-[a-z0-9*-]+)$/.test(token);
}

/* ------------------------------------------------------------ matching */

const GLOB_CACHE = new Map<string, RegExp>();

/** A class expression is a class id or a `*` glob over class ids. Nothing else. */
export function globToRegExp(expression: string): RegExp {
  const cached = GLOB_CACHE.get(expression);
  if (cached) return cached;
  const escaped = expression.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp(`^${escaped}$`);
  GLOB_CACHE.set(expression, re);
  return re;
}

export function expressionMatchesClass(expression: string, class_id: string): boolean {
  return globToRegExp(expression).test(class_id);
}

/** Does this Occasion carry a class the expression names? An axis token matches nothing (see lint's UNSUPPORTED_AXIS_SUBJECT). */
export function expressionMatchesOccasion(expression: string, record: OccasionRecord): boolean {
  if (isAxisToken(expression)) return false;
  const re = globToRegExp(expression);
  for (const c of record.presentation_classes) if (re.test(c)) return true;
  for (const c of record.occasion_classes) if (re.test(c)) return true;
  return false;
}

export function scopeMatches(rule: PolicyRule, record: OccasionRecord): boolean {
  const scope = rule.scope;
  if (!scope) return true;
  if (scope.venue_id !== undefined && scope.venue_id !== record.venue_id) return false;
  if (scope.work_id !== undefined && !record.work_ids.includes(scope.work_id)) return false;
  if (scope.cluster_pattern !== undefined && !globToRegExp(scope.cluster_pattern).test(record.cluster)) return false;
  return true;
}

/** D2: in force for the Occasion the edge is published on, by local calendar date. */
export function inEffect(rule: PolicyRule, record: OccasionRecord): boolean {
  if (record.local_date < rule.effective_from) return false;
  if (rule.effective_to !== undefined && record.local_date > rule.effective_to) return false;
  return true;
}

/** A rule that would establish domination for an incomparable `x-` class (D8). */
export function namesExtensionClass(rule: PolicyRule): boolean {
  return isExtensionClass(rule.subject) || isExtensionClass(rule.object);
}

/* ---------------------------------------------------------- validation */

const AJV_CACHE = new Map<string, (value: unknown) => string | null>();

/**
 * ajv over the FROZEN schema files. `@changeover/schema` is written by another
 * item and may not exist yet; the schemas themselves are in the root commit,
 * so authoring validates against those directly.
 */
export function policyValidator(root: string = repoRoot()): (value: unknown) => string | null {
  const cached = AJV_CACHE.get(root);
  if (cached) return cached;
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const name of ["common", "substitution-policy", "substitution"]) {
    ajv.addSchema(JSON.parse(readFileSync(join(root, "schemas", `${name}.schema.json`), "utf8")));
  }
  const compiled = ajv.getSchema("urn:changeover:schema:substitution-policy:0.1");
  if (!compiled) throw new Error("substitution-policy schema did not compile");
  const validate = (value: unknown): string | null =>
    compiled(value) ? null : ajv.errorsText(compiled.errors, { separator: "; " });
  AJV_CACHE.set(root, validate);
  return validate;
}

export function substitutionValidator(root: string = repoRoot()): (value: unknown) => string | null {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const name of ["common", "substitution"]) {
    ajv.addSchema(JSON.parse(readFileSync(join(root, "schemas", `${name}.schema.json`), "utf8")));
  }
  const compiled = ajv.getSchema("urn:changeover:schema:substitution:0.1");
  if (!compiled) throw new Error("substitution schema did not compile");
  return (value: unknown): string | null =>
    compiled(value) ? null : ajv.errorsText(compiled.errors, { separator: "; " });
}

export interface PolicyLoad {
  policy: SubstitutionPolicy | null;
  schema_error: string | null;
  source_path: string;
}

/** Parse `changeover.policy.yaml` (or the same document as JSON) and validate it. */
export function parsePolicy(text: string, source_path: string, root: string = repoRoot()): PolicyLoad {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { version: "1.2" });
  } catch (err) {
    return { policy: null, schema_error: `not parseable as YAML: ${(err as Error).message}`, source_path };
  }
  const error = policyValidator(root)(parsed);
  if (error) return { policy: null, schema_error: error, source_path };
  return { policy: parsed as SubstitutionPolicy, schema_error: null, source_path };
}

export function loadPolicyFile(path: string, root: string = repoRoot()): PolicyLoad {
  return parsePolicy(readFileSync(path, "utf8"), path, root);
}

/* --------------------------------------------------------- corpus read */

export interface OccasionDocument {
  occasion_id?: unknown;
  venue?: { id?: unknown; origin?: unknown };
  work?: { eidr?: unknown; isan?: unknown };
  instant?: { local_wall?: unknown };
  manner?: { presentation_classes?: unknown; occasion_classes?: unknown };
  substitution?: { cluster?: unknown };
  [key: string]: unknown;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Read the derivation-relevant projection of a published Occasion. */
export function occasionRecord(document: OccasionDocument, source_path?: string): OccasionRecord {
  const work_ids: string[] = [];
  const eidr = asString(document.work?.eidr);
  const isan = asString(document.work?.isan);
  if (eidr) work_ids.push(eidr);
  if (isan) work_ids.push(isan);
  return {
    occasion_id: asString(document.occasion_id),
    venue_id: asString(document.venue?.id),
    origin: asString(document.venue?.origin),
    cluster: asString(document.substitution?.cluster),
    local_date: asString(document.instant?.local_wall).slice(0, 10),
    presentation_classes: asStrings(document.manner?.presentation_classes),
    occasion_classes: asStrings(document.manner?.occasion_classes),
    work_ids,
    source_path,
  };
}

export interface Corpus {
  records: OccasionRecord[];
  documents: Map<string, OccasionDocument>;
  /** Files that are not Occasion documents at all — a delegation record, a seat map. */
  skipped: string[];
}

export function corpusFromDocuments(entries: readonly { document: OccasionDocument; path?: string }[]): Corpus {
  const records: OccasionRecord[] = [];
  const documents = new Map<string, OccasionDocument>();
  const skipped: string[] = [];
  for (const entry of entries) {
    const record = occasionRecord(entry.document, entry.path);
    if (!record.occasion_id) { skipped.push(entry.path ?? "<inline>"); continue; }
    records.push(record);
    documents.set(record.occasion_id, entry.document);
  }
  return { records, documents, skipped };
}

export function loadCorpusFiles(paths: readonly string[]): Corpus {
  return corpusFromDocuments(
    paths.map((path) => ({ document: JSON.parse(readFileSync(path, "utf8")) as OccasionDocument, path })),
  );
}
