// The dated JSON report, and the two refusals that make V8 a property of the
// tool rather than a policy in a document. Owner: TEST-007.
//
// §7 ends with one paragraph and one sentence, and the sentence is the harder
// half: *"**Reports are never restated.** A later run is a new report."* V8
// keys reports on `(spec_version, register_version)` — a spec change does not
// invalidate an old report, it makes it an old report.
//
// A stated policy is a thing somebody quietly improves after a bad run, and once
// one entry in a series can be silently revised, no entry in it can be trusted.
// That trust is the whole asset: real observed floors and release latencies at
// exhibitor boundaries are numbers nobody in this industry publishes, and a
// series beginning in 2026 cannot be bought in 2028 at any price. It survives
// only if the early entries are honest — including, and especially, when the
// numbers come back bad.
//
// So the writer refuses, twice:
//
//   **R1** the target path must not already exist, and
//   **R2** no report already in the series may carry this
//          `(spec_version, register_version, run_at)`.
//
// R1 alone is defeated by writing to a new filename. R2 alone is defeated by
// writing a *different* triple over a file that already holds one. Together
// there is no overwrite: a later run is a new file, and a rerun at the same
// instant is refused rather than merged.
//
// The series layout carries the key in the filesystem rather than inside the
// documents, so `ls` answers V8's question:
//
//   reports/<spec_version>/<register_version>/<run_at>.json
//
// ── `unprovable` is first-class in three places at once ──────────────────────
//
// A runner that collapses `unprovable` into `fail` publishes an accusation about
// an implementation it never contacted. A runner that collapses it into `pass`
// makes the document worthless — and that is the likelier direction, because it
// is the one that produces a green badge. So the third outcome is a value in
// {@link ClassStatus}, a named count in {@link summaryLine}, and its own process
// exit code in {@link exitCodeFor}. Any one of the three missing and the
// property leaks away, which is why nothing here derives one from the other two.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Rfc3339 } from "@changeover/schema/scalars.ts";

/* ── 1 · The shapes ────────────────────────────────────────────────────────── */

export const CLASS_STATUS = { pass: "pass", fail: "fail", unprovable: "unprovable" } as const;
export type ClassStatus = (typeof CLASS_STATUS)[keyof typeof CLASS_STATUS];

export const BINDING = { http: "http", mcp: "mcp", in_process: "in_process" } as const;
export type Binding = (typeof BINDING)[keyof typeof BINDING];
export const BINDINGS: readonly Binding[] = Object.freeze(Object.values(BINDING));

export interface ReportClause {
  readonly clause: string;
  readonly status: ClassStatus;
  readonly note: string;
  readonly missing_path?: string;
}

export interface ReportClass {
  readonly class: string;
  readonly spec_row: string;
  readonly status: ClassStatus;
  /** REQUIRED on `fail` and `unprovable`; forbidden on `pass`. */
  readonly reason?: string;
  readonly missing_path?: string;
  readonly binding: Binding | null;
  readonly source?: string;
  readonly trials?: number;
  readonly duration_ms?: number;
  readonly clauses: readonly ReportClause[];
}

export type MeasurementBasis = "observed" | "not_measured";

export interface CountMeasurement {
  readonly value: number | null;
  readonly basis: MeasurementBasis;
  readonly measured_by: string;
  readonly note?: string;
}

export interface LatencyValue {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly substrate: string;
}

export interface LatencyMeasurement {
  readonly value: LatencyValue | null;
  readonly basis: MeasurementBasis;
  readonly measured_by: string;
  readonly note?: string;
}

export interface BindingCoverage {
  readonly binding: Binding;
  readonly exercised: boolean;
  readonly classes: readonly string[];
  readonly reason?: string;
}

export interface HarnessProvenance {
  readonly commit: string | null;
  readonly dirty: boolean | null;
  readonly node: string;
  readonly driver: "pglite" | "pg" | "none";
  readonly concurrent: boolean;
}

export interface ReportSummary {
  readonly pass: number;
  readonly fail: number;
  readonly unprovable: number;
  readonly exit_code: 0 | 1 | 2;
  readonly line: string;
}

export interface ConformanceReport {
  readonly report_schema: "0.1";
  readonly spec_version: string;
  readonly register_version: string;
  readonly profile: string;
  readonly hold_basis: string;
  readonly floor_basis: string;
  readonly implementation: { readonly name: string; readonly version: string; readonly origin?: string };
  readonly bindings: readonly Binding[];
  readonly binding_coverage: readonly BindingCoverage[];
  readonly run_at: Rfc3339;
  readonly trials: number;
  readonly selection: { readonly only: readonly string[] | null };
  readonly classes: readonly ReportClass[];
  readonly floor_violations: CountMeasurement;
  readonly operator_overrides: CountMeasurement;
  readonly release_latency_ms: LatencyMeasurement;
  readonly oversell_events: CountMeasurement;
  readonly harness: HarnessProvenance;
  readonly summary: ReportSummary;
}

/* ── 2 · The versions, from the frozen file that carries both ──────────────── */

export const REPO_ROOT: string = join(import.meta.dirname, "..", "..", "..");

/** The report's own shape version. Moves for its own reasons; not the protocol's. */
export const REPORT_SCHEMA_VERSION = "0.1";

export interface Versions {
  readonly spec_version: string;
  readonly register_version: string;
}

/**
 * Both halves of V8's key, read from `register/2026.1.json`.
 *
 * Deliberately one file rather than two constants: a report whose two version
 * members came from two places can carry a pair that never existed together,
 * and that pair is the key the whole series is filed under.
 */
export function versions(root: string = REPO_ROOT): Versions {
  const registerDir = join(root, "register");
  const files = readdirSync(registerDir).filter((f) => f.endsWith(".json")).sort();
  const latest = files[files.length - 1];
  if (latest === undefined) throw new Error(`no register file under ${registerDir}`);
  const parsed: unknown = JSON.parse(readFileSync(join(registerDir, latest), "utf8"));
  const record = parsed as { changeover?: unknown; register_version?: unknown };
  if (typeof record.changeover !== "string" || typeof record.register_version !== "string") {
    throw new Error(`${latest} carries no changeover / register_version pair`);
  }
  return { spec_version: record.changeover, register_version: record.register_version };
}

/* ── 3 · Provenance ────────────────────────────────────────────────────────── */

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * The harness commit, and whether the tree that produced the number was clean.
 *
 * §7 asks for the commit hash and the reason is not bookkeeping: a floor
 * measurement without the code that measured it is an anecdote. `dirty` is here
 * because a hash printed beside uncommitted changes IMPLIES that hash is the
 * code that ran, and that implication is the easiest lie in the document to
 * tell by accident. Both are `null` where the tree is not a repository, which is
 * an honest absence and never a guess.
 */
export function harnessProvenance(
  store: { driver: "pglite" | "pg" | "none"; concurrent: boolean },
  root: string = REPO_ROOT,
): HarnessProvenance {
  const commit = git(root, ["rev-parse", "HEAD"]);
  const status = commit === null ? null : git(root, ["status", "--porcelain"]);
  return {
    commit: commit !== null && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    dirty: status === null ? null : status.length > 0,
    node: process.version,
    driver: store.driver,
    concurrent: store.concurrent,
  };
}

/* ── 4 · Measurements ──────────────────────────────────────────────────────── */

export function observedCount(value: number, measured_by: string, note?: string): CountMeasurement {
  return note === undefined
    ? { value, basis: "observed", measured_by }
    : { value, basis: "observed", measured_by, note };
}

/**
 * A number that was not obtained.
 *
 * `value` is `null` and never `0`. A zero that means "we did not look" and a
 * zero that means "we looked and there were none" are the same byte, and the
 * second is the finding this repository exists to publish.
 */
export function notMeasured(measured_by: string, note: string): CountMeasurement {
  return { value: null, basis: "not_measured", measured_by, note };
}

export function observedLatency(value: LatencyValue, measured_by: string, note?: string): LatencyMeasurement {
  return note === undefined
    ? { value, basis: "observed", measured_by }
    : { value, basis: "observed", measured_by, note };
}

export function latencyNotMeasured(measured_by: string, note: string): LatencyMeasurement {
  return { value: null, basis: "not_measured", measured_by, note };
}

/* ── 5 · The three counts, the line, and the exit code ─────────────────────── */

export interface Counts {
  readonly pass: number;
  readonly fail: number;
  readonly unprovable: number;
}

export function countStatuses(classes: readonly ReportClass[]): Counts {
  const of = (s: ClassStatus): number => classes.filter((c) => c.status === s).length;
  return { pass: of(CLASS_STATUS.pass), fail: of(CLASS_STATUS.fail), unprovable: of(CLASS_STATUS.unprovable) };
}

/**
 * `0` all-pass · `1` any-fail · `2` any-unprovable-and-no-fail.
 *
 * 1 beats 2 because a failure is news and a gap is not — the same rule
 * `scripts/run_proofs.sh` already encodes, mirrored rather than forked. A
 * requested binding no class drove is a gap of exactly the same kind: the report
 * may not claim conformance over a transport it never spoke, so it is a 2 and
 * not a 0.
 */
export function exitCodeFor(counts: Counts, unexercised_bindings = 0): 0 | 1 | 2 {
  if (counts.fail > 0) return 1;
  if (counts.unprovable > 0 || unexercised_bindings > 0) return 2;
  return 0;
}

/** `24 classes: 21 pass · 0 fail · 3 unprovable`. Never two numbers. */
export function summaryLine(counts: Counts, unexercised_bindings = 0): string {
  const total = counts.pass + counts.fail + counts.unprovable;
  const base =
    `${total} classes: ${counts.pass} pass · ${counts.fail} fail · ${counts.unprovable} unprovable`;
  return unexercised_bindings > 0
    ? `${base} · ${unexercised_bindings} requested binding${unexercised_bindings === 1 ? "" : "s"} never exercised`
    : base;
}

/* ── 6 · Assembling one ────────────────────────────────────────────────────── */

export interface BuildReportInput {
  readonly spec_version: string;
  readonly register_version: string;
  readonly profile: string;
  readonly hold_basis: string;
  readonly floor_basis: string;
  readonly implementation: { readonly name: string; readonly version: string; readonly origin?: string };
  readonly bindings: readonly Binding[];
  readonly binding_coverage: readonly BindingCoverage[];
  readonly run_at: Rfc3339;
  readonly trials: number;
  readonly selection: { readonly only: readonly string[] | null };
  readonly classes: readonly ReportClass[];
  readonly floor_violations: CountMeasurement;
  readonly operator_overrides: CountMeasurement;
  readonly release_latency_ms: LatencyMeasurement;
  readonly oversell_events: CountMeasurement;
  readonly harness: HarnessProvenance;
}

/**
 * The summary is DERIVED here and never supplied.
 *
 * Handing a caller a `summary` field to fill in is handing them the one place a
 * green badge can be written without the classes agreeing. The counts, the line
 * and the exit code all come off `classes`, so a report that says `0 fail` says
 * it because no class failed.
 */
export function buildReport(input: BuildReportInput): ConformanceReport {
  const counts = countStatuses(input.classes);
  const unexercised = input.binding_coverage.filter((b) => !b.exercised).length;
  return {
    report_schema: REPORT_SCHEMA_VERSION,
    spec_version: input.spec_version,
    register_version: input.register_version,
    profile: input.profile,
    hold_basis: input.hold_basis,
    floor_basis: input.floor_basis,
    implementation: input.implementation,
    bindings: input.bindings,
    binding_coverage: input.binding_coverage,
    run_at: input.run_at,
    trials: input.trials,
    selection: input.selection,
    classes: input.classes,
    floor_violations: input.floor_violations,
    operator_overrides: input.operator_overrides,
    release_latency_ms: input.release_latency_ms,
    oversell_events: input.oversell_events,
    harness: input.harness,
    summary: {
      pass: counts.pass,
      fail: counts.fail,
      unprovable: counts.unprovable,
      exit_code: exitCodeFor(counts, unexercised),
      line: summaryLine(counts, unexercised),
    },
  };
}

/* ── 7 · The series, and the two refusals ──────────────────────────────────── */

/** A rerun at the same `(spec_version, register_version, run_at)`, or over a file. */
export class ReportRestated extends Error {
  readonly existing: string;
  constructor(message: string, existing: string) {
    super(message);
    this.name = "ReportRestated";
    this.existing = existing;
  }
}

export interface SeriesKey {
  readonly spec_version: string;
  readonly register_version: string;
  readonly run_at: string;
}

/** `run_at` as a filename. `:` is legal on POSIX and unreadable in a Finder. */
export function runAtSlug(run_at: string): string {
  return run_at.replace(/:/g, "-");
}

/**
 * `reports/<spec_version>/<register_version>/<run_at>.json`.
 *
 * The key V8 names is the DIRECTORY, so `ls reports/0.1/2026.1` is the series
 * and nothing has to be opened to know what is in it. A spec change makes a new
 * directory beside the old one, which is what "it makes it an old report" looks
 * like on a disk.
 */
export function reportPath(series_dir: string, key: SeriesKey): string {
  return join(series_dir, key.spec_version, key.register_version, `${runAtSlug(key.run_at)}.json`);
}

export interface SeriesEntry {
  readonly path: string;
  readonly key: SeriesKey;
}

/** Every report already in the series, by triple. Unreadable files are skipped. */
export function readSeries(series_dir: string): SeriesEntry[] {
  const found: SeriesEntry[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let parsed: unknown;
      if (!name.endsWith(".json")) {
        walk(full);
        continue;
      }
      try {
        parsed = JSON.parse(readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      const record = parsed as Partial<SeriesKey>;
      if (
        typeof record.spec_version === "string" &&
        typeof record.register_version === "string" &&
        typeof record.run_at === "string"
      ) {
        found.push({
          path: full,
          key: {
            spec_version: record.spec_version,
            register_version: record.register_version,
            run_at: record.run_at,
          },
        });
      }
    }
  };
  walk(series_dir);
  return found;
}

export interface WriteOptions {
  /** The series root. Default `reports/`. */
  readonly series_dir: string;
  /** An additional copy at an exact path, for `--out`. Also never overwritten. */
  readonly out?: string;
}

export interface WriteResult {
  readonly path: string;
  readonly out?: string;
  readonly bytes: number;
}

/**
 * Write the report, or refuse.
 *
 * Both refusals throw {@link ReportRestated} naming the file that already exists.
 * Neither is a flag, an option or a `--force`: an overwritable report is a
 * report somebody will quietly improve after a bad run, and a `--force` is the
 * same thing with a keystroke in front of it.
 */
export function writeReport(report: ConformanceReport, options: WriteOptions): WriteResult {
  const key: SeriesKey = {
    spec_version: report.spec_version,
    register_version: report.register_version,
    run_at: report.run_at,
  };
  const path = reportPath(options.series_dir, key);

  // R2 first: the series is the thing V8 protects, and a path that happens to be
  // free tells you nothing about whether this triple has already been published
  // under a different name.
  const restated = readSeries(options.series_dir).find(
    (e) =>
      e.key.spec_version === key.spec_version &&
      e.key.register_version === key.register_version &&
      e.key.run_at === key.run_at,
  );
  if (restated !== undefined) {
    throw new ReportRestated(
      `a report for (${key.spec_version}, ${key.register_version}, ${key.run_at}) already exists at ` +
        `${restated.path} — reports are never restated (V8); a later run is a NEW report, at a later run_at`,
      restated.path,
    );
  }

  // R1: never write over a file, whatever is in it. A different triple landing on
  // an existing path destroys a report just as thoroughly as the same one.
  if (existsSync(path)) {
    throw new ReportRestated(`${path} already exists and would be overwritten — reports are never restated (V8)`, path);
  }
  if (options.out !== undefined && existsSync(options.out)) {
    throw new ReportRestated(
      `${options.out} already exists and would be overwritten — reports are never restated (V8)`,
      options.out,
    );
  }

  const body = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { encoding: "utf8", flag: "wx" });
  if (options.out !== undefined) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, body, { encoding: "utf8", flag: "wx" });
  }
  return options.out === undefined
    ? { path, bytes: Buffer.byteLength(body) }
    : { path, out: options.out, bytes: Buffer.byteLength(body) };
}
