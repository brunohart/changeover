/**
 * `changeover lint` — check a policy before a single Occasion is published.
 *
 *   changeover lint [--policy <file>] [--corpus <path>...] [--explain] [--json]
 *
 * Exit 0 the policy holds (warnings are allowed and are still printed),
 * exit 1 the policy has errors, exit 2 the inputs could not be read.
 *
 * E1 is an error: an edge whose target is not resolvable at the venue's own
 * origin is refused at publish, so lint refuses it here, where it is cheap.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadCorpusFiles, loadPolicyFile } from "@changeover/semantics/policy.ts";
import { explainRule, formatDiagnostic, lint } from "@changeover/semantics/lint.ts";

interface Options {
  policy: string;
  corpus: string[];
  explain: boolean;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options | string {
  const options: Options = { policy: "changeover.policy.yaml", corpus: [], explain: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--policy" || arg === "-p") { const next = argv[++i]; if (next === undefined) return "--policy needs a path"; options.policy = next; }
    else if (arg === "--corpus" || arg === "-c") { const next = argv[++i]; if (next === undefined) return "--corpus needs a path"; options.corpus.push(next); }
    else if (arg === "--explain") options.explain = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") return "usage: changeover lint [--policy <file>] [--corpus <path>...] [--explain] [--json]";
    else if (arg.startsWith("-")) return `unknown option: ${arg}`;
    else options.policy = arg;
  }
  return options;
}

/** A path is a file, or a directory of *.json Occasion documents. */
export function expandCorpus(paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`corpus path does not exist: ${path}`);
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (entry.endsWith(".json")) files.push(join(path, entry));
      }
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
    console.error("  usage: changeover lint --policy <changeover.policy.yaml> [--corpus <dir>]");
    return 2;
  }

  const load = loadPolicyFile(parsed.policy);

  let corpus;
  let files: string[] = [];
  if (parsed.corpus.length > 0) {
    try {
      files = expandCorpus(parsed.corpus);
      corpus = loadCorpusFiles(files);
    } catch (err) {
      console.error(`cannot read corpus: ${(err as Error).message}`);
      return 2;
    }
  }

  const result = lint(load, corpus);
  if (corpus && corpus.skipped.length > 0) {
    console.log(`note  ${corpus.skipped.length} file${corpus.skipped.length === 1 ? "" : "s"} in the corpus carry no occasion_id and are not Occasion documents: ${corpus.skipped.map((p) => p.split("/").pop()).join(", ")}`);
  }

  if (parsed.json) {
    console.log(JSON.stringify({
      policy: parsed.policy,
      corpus: files,
      errors: result.errors,
      warnings: result.warnings,
      diagnostics: result.diagnostics,
    }, null, 2));
    return result.errors > 0 ? 1 : 0;
  }

  if (parsed.explain && load.policy) {
    for (const rule of load.policy.rules) console.log(explainRule(rule));
    console.log("");
  }

  for (const diagnostic of result.diagnostics) {
    const line = formatDiagnostic(diagnostic);
    if (diagnostic.severity === "error") console.error(line);
    else console.log(line);
  }

  const rules = load.policy ? load.policy.rules.length : 0;
  const counted = corpus ? corpus.records.length : 0;
  const scope = counted > 0 ? ` over ${counted} Occasion${counted === 1 ? "" : "s"}` : "";
  console.log(`${parsed.policy}: ${rules} rule${rules === 1 ? "" : "s"}${scope} — ${result.errors} error${result.errors === 1 ? "" : "s"}, ${result.warnings} warning${result.warnings === 1 ? "" : "s"}`);
  return result.errors > 0 ? 1 : 0;
}
