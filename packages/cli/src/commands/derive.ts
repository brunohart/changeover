/**
 * `changeover derive` — expand the policy over a corpus of Occasions and emit
 * each one's substitution block, transitively closed.
 *
 *   changeover derive [--policy <file>] --corpus <path>... [--out <dir>] [--edges] [--json]
 *
 * Default output is the derived blocks, keyed by occasion_id, on stdout. With
 * --out, each Occasion document is rewritten into that directory with its
 * derived block in place and everything else untouched; `cluster` is authored
 * and survives, because the grouping is the Publisher's, not the tool's.
 *
 * Exit 0 the derivation holds, exit 1 the policy has errors (a cross-origin
 * target, a contradiction, an edge set over the wire cap) and nothing should be
 * published until they are fixed, exit 2 the inputs could not be read.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadCorpusFiles, loadPolicyFile } from "@changeover/semantics/policy.ts";
import { applySubstitution, deriveSubstitutions } from "@changeover/semantics/derive.ts";
import { formatDiagnostic } from "@changeover/semantics/lint.ts";

interface Options {
  policy: string;
  corpus: string[];
  out: string | null;
  edges: boolean;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options | string {
  const options: Options = { policy: "changeover.policy.yaml", corpus: [], out: null, edges: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--policy" || arg === "-p") { const next = argv[++i]; if (next === undefined) return "--policy needs a path"; options.policy = next; }
    else if (arg === "--corpus" || arg === "-c") { const next = argv[++i]; if (next === undefined) return "--corpus needs a path"; options.corpus.push(next); }
    else if (arg === "--out" || arg === "-o") { const next = argv[++i]; if (next === undefined) return "--out needs a directory"; options.out = next; }
    else if (arg === "--edges") options.edges = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") return "usage: changeover derive [--policy <file>] --corpus <path>... [--out <dir>] [--edges]";
    else if (arg.startsWith("-")) return `unknown option: ${arg}`;
    else options.policy = arg;
  }
  if (options.corpus.length === 0) return "derive needs --corpus: rules are authored over classes and expand over instances";
  return options;
}

function expandCorpus(paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`corpus path does not exist: ${path}`);
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) if (entry.endsWith(".json")) files.push(join(path, entry));
    } else {
      files.push(path);
    }
  }
  return files;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") { console.error(parsed); return 2; }

  if (!existsSync(parsed.policy)) {
    console.error(`cannot read policy: ${parsed.policy}`);
    return 2;
  }
  const load = loadPolicyFile(parsed.policy);
  if (load.schema_error !== null || load.policy === null) {
    console.error(`${parsed.policy} does not validate against substitution-policy.schema.json: ${load.schema_error}`);
    return 1;
  }

  let files: string[];
  try {
    files = expandCorpus(parsed.corpus);
  } catch (err) {
    console.error(`cannot read corpus: ${(err as Error).message}`);
    return 2;
  }
  const corpus = loadCorpusFiles(files);
  const derived = deriveSubstitutions(load.policy, corpus);
  const errors = derived.diagnostics.filter((d) => d.severity === "error");

  if (parsed.edges) {
    const relation = {
      base: derived.base.map((e) => ({ kind: e.kind, from: e.from, to: e.to, axis: e.axis, rule_id: e.rule_id, converse: e.converse })),
      closed: derived.closed,
    };
    console.log(JSON.stringify(relation, null, 2));
  } else if (parsed.out !== null) {
    mkdirSync(parsed.out, { recursive: true });
    for (const file of files) {
      const document = JSON.parse(readFileSync(file, "utf8")) as { occasion_id?: string };
      const id = typeof document.occasion_id === "string" ? document.occasion_id : "";
      const block = derived.blocks.get(id);
      if (!block) continue;
      writeFileSync(join(parsed.out, basename(file)), `${JSON.stringify(applySubstitution(document, block), null, 2)}\n`, "utf8");
    }
    console.log(`${files.length} Occasion${files.length === 1 ? "" : "s"} written to ${parsed.out}`);
  } else {
    const out: Record<string, unknown> = {};
    for (const [occasion_id, block] of derived.blocks) out[occasion_id] = block;
    console.log(JSON.stringify(out, null, 2));
  }

  for (const diagnostic of derived.diagnostics) console.error(formatDiagnostic(diagnostic));
  if (errors.length > 0) {
    console.error(`${errors.length} error${errors.length === 1 ? "" : "s"} — nothing here is publishable until the policy is fixed`);
    return 1;
  }
  return 0;
}
