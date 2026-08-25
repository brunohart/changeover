// `changeover conform` — run every §7 class and emit a dated JSON report.
// Owner: TEST-007.
//
//   changeover conform --profile 1 --bindings http,mcp --out report.json
//
// Exit is the house meaning, and it is the whole point of the command:
//
//   0  every class passed
//   1  a class FAILED — your server did something §7 says it must not
//   2  a class could not be PROVEN — we could not reach it, or this substrate
//      cannot race, or nobody has built the module that would run it
//
// Two codes cannot carry three answers. A runner that collapsed `unprovable`
// into `fail` would publish an accusation about an implementation it never
// contacted; one that collapsed it into `pass` would make the document
// worthless, and that is the likelier direction, because it is the one that
// produces a green badge. So the third outcome is a value in the report schema's
// per-class enum, a named count in the summary line, and its own exit code, and
// nothing here derives any of the three from the other two.
//
// `scripts/run_proofs.sh` already encodes this discipline and this command
// mirrors it rather than forking it: `--allow-unprovable` maps a whole-suite 2
// to 0 for CI only, where no Postgres and no Docker daemon exist; it never hides
// a failure, and it prints the unprovable inventory loudly. The same flag is
// here for the same reason and with the same limit — it cannot turn a 1 into a 0.

import { writeFileSync } from "node:fs";

import { CONFORMANCE_CLASSES } from "@changeover/adapter-reference/classes.ts";
import { bindingCoverage, runConformance } from "@changeover/conformance/run.ts";
import type { Binding, ConformanceReport } from "@changeover/conformance/report.ts";
import {
  BINDINGS,
  ReportRestated,
  buildReport,
  harnessProvenance,
  versions,
} from "@changeover/conformance/report.ts";

const PROFILES = ["0", "1", "1S"] as const;
const HOLD_BASES = ["system_of_record", "shadow"] as const;
const FLOOR_BASES = ["owned_store", "measured_warranty"] as const;

const USAGE = [
  "changeover conform — run every §7 conformance class and write a dated report",
  "",
  "usage: changeover conform [options]",
  "",
  "  --profile <0|1|1S>          the profile asserted against (default 1)",
  "  --bindings <a,b>            http, mcp, in_process (default http,in_process)",
  "  --hold-basis <b>            system_of_record | shadow (default system_of_record)",
  "  --floor-basis <b>           owned_store | measured_warranty (default owned_store)",
  "  --implementation <name>     what was under test (default changeover-reference)",
  "  --implementation-version <v>",
  "  --origin <url>              where it was reached, when over a network",
  "  --only <C-X,C-Y>            restrict the run; every unselected class is",
  "                              unprovable, naming the restriction, never omitted",
  "  --latency-trials <n>        release-latency samples (default 20)",
  "  --observe-ms <n>            how long the floor observation watches (default 1000)",
  "  --reports-dir <dir>         the series root (default reports)",
  "  --out <path>                an additional copy at an exact path",
  "  --no-write                  run and print; write nothing",
  "  --allow-unprovable          map a whole-run 2 to 0. Never a 1 to a 0.",
  "  --quiet                     the summary only",
  "",
  "exit: 0 all-pass · 1 any-fail · 2 any-unprovable-and-no-fail",
  "",
  "Reports are never restated (V8). A second run at the same",
  "(spec_version, register_version, run_at) is refused, not merged.",
].join("\n");

interface Parsed {
  readonly help: boolean;
  readonly profile: string;
  readonly bindings: readonly Binding[];
  readonly hold_basis: string;
  readonly floor_basis: string;
  readonly implementation: string;
  readonly implementation_version: string;
  readonly origin?: string;
  readonly only: readonly string[] | null;
  readonly latency_trials: number;
  readonly observe_ms: number;
  readonly reports_dir: string;
  readonly out?: string;
  readonly write: boolean;
  readonly allow_unprovable: boolean;
  readonly quiet: boolean;
}

class BadArgument extends Error {}

function integer(name: string, raw: string | undefined, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new BadArgument(`${name} takes an integer of at least ${min}, not ${JSON.stringify(raw)}`);
  }
  return value;
}

function oneOf<T extends string>(name: string, raw: string | undefined, allowed: readonly T[]): T {
  if (raw === undefined || !allowed.includes(raw as T)) {
    throw new BadArgument(`${name} takes one of ${allowed.join(", ")}, not ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

/**
 * An unknown class id in `--only` is refused rather than ignored.
 *
 * A typo that silently selected nothing would produce a report in which every
 * class is unprovable and the summary is a wall of honest-looking 2s. That is
 * the shape of a report nobody reads twice, and it would be nobody's fault.
 */
function parse(argv: readonly string[]): Parsed {
  let profile = "1";
  let bindings: Binding[] = ["http", "in_process"];
  let hold_basis = "system_of_record";
  let floor_basis = "owned_store";
  let implementation = "changeover-reference";
  let implementation_version = "0.1.0";
  let origin: string | undefined;
  let only: string[] | null = null;
  let latency_trials = 20;
  let observe_ms = 1000;
  let reports_dir = "reports";
  let out: string | undefined;
  let write = true;
  let allow_unprovable = false;
  let quiet = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--profile":
        profile = oneOf("--profile", value, PROFILES);
        i++;
        break;
      case "--bindings": {
        if (value === undefined) throw new BadArgument("--bindings takes a comma-separated list");
        const parts = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        if (parts.length === 0) throw new BadArgument("--bindings takes at least one binding");
        for (const part of parts) {
          if (!BINDINGS.includes(part as Binding)) {
            throw new BadArgument(`--bindings does not know ${JSON.stringify(part)}; it takes ${BINDINGS.join(", ")}`);
          }
        }
        bindings = [...new Set(parts)] as Binding[];
        i++;
        break;
      }
      case "--hold-basis":
        hold_basis = oneOf("--hold-basis", value, HOLD_BASES);
        i++;
        break;
      case "--floor-basis":
        floor_basis = oneOf("--floor-basis", value, FLOOR_BASES);
        i++;
        break;
      case "--implementation":
        if (value === undefined || value.length === 0) throw new BadArgument("--implementation takes a name");
        implementation = value;
        i++;
        break;
      case "--implementation-version":
        if (value === undefined || value.length === 0) throw new BadArgument("--implementation-version takes a version");
        implementation_version = value;
        i++;
        break;
      case "--origin":
        if (value === undefined) throw new BadArgument("--origin takes a URL");
        origin = value;
        i++;
        break;
      case "--only": {
        if (value === undefined) throw new BadArgument("--only takes a comma-separated list of class ids");
        const parts = value.split(",").map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);
        const registered = CONFORMANCE_CLASSES.map((c) => c.id);
        const unknown = parts.filter((p) => !registered.includes(p));
        if (unknown.length > 0) {
          throw new BadArgument(
            `--only names ${unknown.join(", ")}, which §7 does not register. A typo here selects nothing and ` +
              `produces a report of honest-looking 2s, so it is refused. Registered: ${registered.join(", ")}`,
          );
        }
        if (parts.length === 0) throw new BadArgument("--only takes at least one class id");
        only = parts;
        i++;
        break;
      }
      case "--latency-trials":
        latency_trials = integer("--latency-trials", value, 1);
        i++;
        break;
      case "--observe-ms":
        observe_ms = integer("--observe-ms", value, 0);
        i++;
        break;
      case "--reports-dir":
        if (value === undefined) throw new BadArgument("--reports-dir takes a directory");
        reports_dir = value;
        i++;
        break;
      case "--out":
        if (value === undefined) throw new BadArgument("--out takes a path");
        out = value;
        i++;
        break;
      case "--no-write":
        write = false;
        break;
      case "--allow-unprovable":
        allow_unprovable = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      default:
        throw new BadArgument(`unknown option ${JSON.stringify(flag)}`);
    }
  }

  return {
    help,
    profile,
    bindings,
    hold_basis,
    floor_basis,
    implementation,
    implementation_version,
    ...(origin === undefined ? {} : { origin }),
    only,
    latency_trials,
    observe_ms,
    reports_dir,
    ...(out === undefined ? {} : { out }),
    write,
    allow_unprovable,
    quiet,
  };
}

/** The inventory, printed loudly. An unprovable nobody reads becomes a pass. */
function printOutcome(report: ConformanceReport, quiet: boolean): void {
  if (!quiet) {
    console.log("");
    for (const entry of report.classes) {
      const clauses = entry.clauses.filter((c) => c.status === "pass").length;
      console.log(
        `  ${entry.status.padEnd(10)} ${entry.class.padEnd(14)} ${clauses}/${entry.clauses.length} clauses held`,
      );
    }
  }

  const unprovable = report.classes.filter((c) => c.status === "unprovable");
  const failed = report.classes.filter((c) => c.status === "fail");

  if (failed.length > 0) {
    console.log("");
    console.log("  FAILED — the implementation did something §7 says it must not:");
    for (const entry of failed) console.log(`    ${entry.class}: ${entry.reason ?? ""}`);
  }
  if (unprovable.length > 0) {
    console.log("");
    console.log("  cannot prove — these classes did NOT fail. They were not reached, and each says why:");
    for (const entry of unprovable) console.log(`    ${entry.class}: ${entry.reason ?? ""}`);
  }
  for (const coverage of report.binding_coverage.filter((b) => !b.exercised)) {
    console.log(`    binding ${coverage.binding}: ${coverage.reason ?? ""}`);
  }

  console.log("");
  console.log(`  ${report.summary.line}`);
  const m = report.floor_violations;
  const o = report.operator_overrides;
  const s = report.oversell_events;
  const l = report.release_latency_ms;
  const shown = (value: number | null): string => (value === null ? "not measured" : String(value));
  console.log(`  floor_violations ${shown(m.value)} · operator_overrides ${shown(o.value)} · oversell_events ${shown(s.value)}`);
  console.log(
    l.value === null
      ? "  release_latency_ms not measured"
      : `  release_latency_ms p50=${l.value.p50.toFixed(2)} p95=${l.value.p95.toFixed(2)} max=${l.value.max.toFixed(2)} (n=${l.value.n}, ${l.value.substrate})`,
  );
  console.log(`  harness ${report.harness.commit ?? "not a repository"}${report.harness.dirty === true ? " (working tree DIRTY)" : ""}`);
}

export async function run(argv: string[]): Promise<number> {
  let options: Parsed;
  try {
    options = parse(argv);
  } catch (err) {
    console.error(`changeover conform: ${err instanceof Error ? err.message : String(err)}`);
    console.error("");
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const log = (line: string): void => {
    if (!options.quiet) console.log(line);
  };

  const { spec_version, register_version } = versions();
  const result = await runConformance({
    profile: options.profile,
    bindings: options.bindings,
    only: options.only,
    latency_trials: options.latency_trials,
    observe_ms: options.observe_ms,
    log,
  });

  const report = buildReport({
    spec_version,
    register_version,
    profile: options.profile,
    hold_basis: options.hold_basis,
    floor_basis: options.floor_basis,
    implementation: {
      name: options.implementation,
      version: options.implementation_version,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    bindings: options.bindings,
    binding_coverage: bindingCoverage(options.bindings, result.classes),
    run_at: result.run_at,
    trials: result.trials,
    selection: { only: options.only },
    classes: result.classes,
    floor_violations: result.floor_violations,
    operator_overrides: result.operator_overrides,
    release_latency_ms: result.release_latency_ms,
    oversell_events: result.oversell_events,
    harness: harnessProvenance({ driver: result.driver, concurrent: result.concurrent }),
  });

  printOutcome(report, options.quiet);

  if (options.write) {
    const { writeReport } = await import("@changeover/conformance/report.ts");
    try {
      const written = writeReport(report, {
        series_dir: options.reports_dir,
        ...(options.out === undefined ? {} : { out: options.out }),
      });
      console.log("");
      console.log(`  wrote ${written.path}${written.out === undefined ? "" : ` and ${written.out}`} (${written.bytes} bytes)`);
    } catch (err) {
      if (err instanceof ReportRestated) {
        console.error("");
        console.error(`changeover conform: ${err.message}`);
        // 2, not 1. The implementation did not fail; the report was not written.
        // Reporting a refusal to restate as a conformance failure would be the
        // same collapse this command exists to prevent, pointed the other way.
        return 2;
      }
      throw err;
    }
  } else if (options.out !== undefined) {
    // --no-write and --out together: honour the explicit path, still never over
    // an existing file. `wx` is the refusal, enforced by the filesystem.
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log("");
    console.log(`  wrote ${options.out}`);
  }

  const code = report.summary.exit_code;
  if (code === 2 && options.allow_unprovable) {
    console.log("");
    console.log("  --allow-unprovable: exiting 0. Nothing above was hidden and no failure was mapped;");
    console.log("  the inventory is printed in full and every entry of it is in the report.");
    return 0;
  }
  return code;
}
