// The runner: every §7 class executed, and one honest outcome each. Owner: TEST-007.
//
// `docs/BUILD-CONTRACT.md` §1 says the registry is the filesystem — `run.ts`
// reads `src/classes/` and imports each module, and adding a class is adding a
// file. That is true and it is half the story, because five families of classes
// were built in directories of their own with shapes of their own:
//
//   src/classes/    13 modules  ConformanceClassModule  → ClauseOutcome[]
//   src/lifecycle/   3 classes  cIdempotent/cRelease/cOrphan → ClassResult
//   src/inject/      2 classes  runCInject/runCPiiIngest → Check[]
//   src/budget/      2 classes  sequential/concurrent → budget ClassOutcome
//   src/atomic/      1 class    four assertions driven through a Reporter
//
// Nobody was wrong to do that; five items were writing at once and the harness
// was an empty directory when the first of them started. So this file adapts,
// and never asks a family to change: an adapter that is wrong produces a report
// that is wrong, whereas a rewrite of somebody else's bench produces a class
// that no longer runs at all.
//
// ── The rule the whole file exists to enforce ────────────────────────────────
//
// **A class that was not executed is `unprovable`, never `pass`.** Three ways a
// class fails to execute, and all three land in the same place:
//
//   the module does not exist          → unprovable, naming the path
//   the run was restricted past it     → unprovable, naming the restriction
//   its substrate cannot race          → unprovable, naming CHANGEOVER_PG_URL
//
// and one way it must not: a runner that swallowed a throw and moved on. Every
// adapter here is wrapped, and a throw becomes a **fail** carrying the message —
// except {@link CannotProve}, which is the store saying it was never reached and
// is the one throw that is honestly a 2.
//
// The enumeration is `CONFORMANCE_CLASSES` from `@changeover/adapter-reference`,
// which is §7's twenty-four rows as data with §7's own words attached. Reading
// it here rather than re-typing the list means a class this repository forgot to
// build is *named in the report as unprovable* rather than absent from it — and
// a class absent from a list of twenty-four is indistinguishable from one that
// passed.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { CONFORMANCE_CLASSES } from "@changeover/adapter-reference/classes.ts";
import { CannotProve, openDb } from "@changeover/store/db.ts";
import type { Db } from "@changeover/store/db.ts";
import { serverTime } from "@changeover/core/clock.ts";
import type { Rfc3339 } from "@changeover/schema/scalars.ts";

import type { Binding, CountMeasurement, LatencyMeasurement, ReportClass, ReportClause } from "./report.ts";
import {
  CLASS_STATUS,
  REPO_ROOT,
  latencyNotMeasured,
  notMeasured,
  observedCount,
  observedLatency,
} from "./report.ts";

import { classOutcome } from "./classes/_contract.ts";
import type { ClassOutcome, ConformanceClassModule } from "./classes/_contract.ts";
import { CREDENTIAL_A, TOKEN, conformanceBench, grantHold } from "./classes/_bench.ts";

/* ── 1 · What the caller asks for ──────────────────────────────────────────── */

export interface RunOptions {
  readonly profile: string;
  readonly bindings: readonly Binding[];
  /** Restrict the run. Unselected classes are `unprovable`, never omitted. */
  readonly only: readonly string[] | null;
  /** Release-latency trials. §7 asks for p50/p95/max, which need samples. */
  readonly latency_trials: number;
  /** How long the floor observation watches its own cohort before counting. */
  readonly observe_ms: number;
  readonly log: (line: string) => void;
}

export interface RunResult {
  readonly run_at: Rfc3339;
  readonly classes: readonly ReportClass[];
  readonly trials: number;
  readonly floor_violations: CountMeasurement;
  readonly operator_overrides: CountMeasurement;
  readonly release_latency_ms: LatencyMeasurement;
  readonly oversell_events: CountMeasurement;
  readonly driver: "pglite" | "pg" | "none";
  readonly concurrent: boolean;
}

export const CLASSES_DIR = "packages/conformance/src/classes";

/** The store is genuinely able to race two callers, or it is not. Never assumed. */
export function concurrentSubstrate(): boolean {
  return Boolean(process.env.CHANGEOVER_PG_URL);
}

const NEEDS_POSTGRES =
  "the substrate is PGlite, which is single-connection and in-process: lock contention and 40P01 " +
  "cannot occur there, so a pass would mean nothing. Set CHANGEOVER_PG_URL to a real Postgres " +
  "(docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18)";

/* ── 2 · Turning each family's shape into one ──────────────────────────────── */

function clause(name: string, status: ReportClause["status"], note: string): ReportClause {
  return { clause: name, status, note: note.length > 0 ? note : "(the module reported no text)" };
}

/** `.1 — 200 concurrent holds …` → `C-ATOMIC.1`. A clause names which half ran. */
function clauseName(id: string, text: string): string {
  const numbered = /^\s*(\.[0-9A-Za-z]+)\b/.exec(text);
  return numbered === null ? id : `${id}${numbered[1]}`;
}

/** The `_contract.ts` outcome, which is already the shape this report wants. */
function fromClassOutcome(
  outcome: ClassOutcome,
  binding: Binding | null,
  source: string,
  duration_ms: number,
  trials?: number,
): ReportClass {
  const base = {
    class: outcome.class,
    spec_row: outcome.spec_row,
    status: outcome.status,
    binding,
    source,
    duration_ms,
    clauses: outcome.clauses.map((c) =>
      c.missing_path === undefined
        ? clause(c.clause, c.status, c.note)
        : { clause: c.clause, status: c.status, note: c.note, missing_path: c.missing_path },
    ),
  };
  const missing = outcome.clauses.find((c) => c.status === CLASS_STATUS.unprovable && c.missing_path !== undefined);
  const withReason: ReportClass =
    outcome.status === CLASS_STATUS.pass ? base : { ...base, reason: outcome.reason ?? "(no reason was given)" };
  const withPath: ReportClass =
    missing === undefined || missing.missing_path === undefined
      ? withReason
      : { ...withReason, missing_path: missing.missing_path };
  return trials === undefined ? withPath : { ...withPath, trials };
}

/**
 * `pass` is DERIVED from the clauses and never asserted.
 *
 * Any clause failed → fail. Else any clause unproven → unprovable. Else pass.
 * An empty clause list is a fail, because a class that reports nothing looks
 * exactly like a class that passed in a list long enough that nobody counts.
 */
function fromClauses(
  id: string,
  spec_row: string,
  clauses: readonly ReportClause[],
  binding: Binding | null,
  source: string,
  duration_ms: number,
  trials?: number,
): ReportClass {
  const stub: ConformanceClassModule = { id, spec_row, run: async () => [] };
  return fromClassOutcome(classOutcome(stub, clauses), binding, source, duration_ms, trials);
}

/** A class that could not be reached. Carries the reason, and never a clause. */
function unreached(
  id: string,
  spec_row: string,
  reason: string,
  options: { binding?: Binding | null; source?: string; missing_path?: string } = {},
): ReportClass {
  const base: ReportClass = {
    class: id,
    spec_row,
    status: CLASS_STATUS.unprovable,
    reason,
    binding: options.binding ?? null,
    clauses: [],
  };
  const withSource = options.source === undefined ? base : { ...base, source: options.source };
  return options.missing_path === undefined ? withSource : { ...withSource, missing_path: options.missing_path };
}

/** A class whose runner threw. The throw is the failure; it never becomes a pass. */
function threw(id: string, spec_row: string, err: unknown, binding: Binding | null, source: string): ReportClass {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return {
    class: id,
    spec_row,
    status: CLASS_STATUS.fail,
    reason: `the runner threw before it could report: ${message}`,
    binding,
    source,
    clauses: [],
  };
}

/* ── 3 · The `src/classes/` family — the filesystem IS the registry ────────── */

export interface DiscoveredModule {
  readonly id: string;
  readonly file: string;
  readonly module: ConformanceClassModule;
}

/**
 * Every `c-<name>.ts` in `src/classes/` that exports the class contract.
 *
 * The directory is read rather than listed, so a class module added tomorrow is
 * in the report tomorrow with nothing here edited. A file that exports something
 * other than the contract is skipped and NAMED in the returned `skipped` list —
 * silently ignoring it is how a renamed module becomes an unrun class.
 */
export async function discoverClassModules(
  root: string = REPO_ROOT,
): Promise<{ found: DiscoveredModule[]; skipped: string[] }> {
  const dir = join(root, CLASSES_DIR);
  const found: DiscoveredModule[] = [];
  const skipped: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_")).sort();
  } catch {
    return { found, skipped };
  }
  for (const file of entries) {
    try {
      const loaded: Record<string, unknown> = await import(pathToFileURL(join(dir, file)).href);
      if (typeof loaded.id === "string" && typeof loaded.spec_row === "string" && typeof loaded.run === "function") {
        found.push({ id: loaded.id, file, module: loaded as unknown as ConformanceClassModule });
      } else {
        skipped.push(`${file} (exports no id/spec_row/run)`);
      }
    } catch (err) {
      skipped.push(`${file} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { found, skipped };
}

/* ── 4 · The families with shapes of their own ─────────────────────────────── */

interface LifecycleCheck {
  readonly held: boolean;
  readonly text: string;
}
interface LifecycleResult {
  readonly id: string;
  readonly checks: readonly LifecycleCheck[];
  readonly notes: readonly string[];
  readonly unprovable?: string;
}

function lifecycleClauses(result: LifecycleResult): ReportClause[] {
  return result.checks.map((c) =>
    clause(clauseName(result.id, c.text), c.held ? CLASS_STATUS.pass : CLASS_STATUS.fail, c.text),
  );
}

interface InjectCheck {
  readonly id: string;
  readonly held: boolean;
  readonly note: string;
}

interface BudgetCheck {
  readonly held: boolean;
  readonly statement: string;
}
interface BudgetOutcome {
  readonly class_id: string;
  readonly verdict: "pass" | "fail" | "unprovable";
  readonly checks: readonly BudgetCheck[];
  readonly trials: number;
}

/**
 * `formatPercentiles` output, read back as numbers.
 *
 * `cRelease` measures the percentiles §7 asks for and prints them into a note,
 * because `ClassResult` predates this file and has no channel for a
 * measurement. Rather than measure the same thing a second time — two rigs
 * disagreeing about one number is worse than not having it — the note is parsed,
 * strictly, and **fails closed**: no match, or more than one, and the report
 * says `not_measured` with the reason. It can never invent a number.
 *
 * The substrate travels with the value, which `latency.ts` asks for by name: an
 * in-process wasm number and a number off a real boundary are not the same
 * measurement and must not read as one.
 */
export function readPercentiles(notes: readonly string[]): LatencyMeasurement {
  const pattern =
    /\bn=(\d+) p50=([0-9.]+|—)ms p95=([0-9.]+|—)ms max=([0-9.]+|—)ms \(min=[^,]*,\s*(.+)\)\s*$/;
  const matches = notes.map((n) => pattern.exec(n)).filter((m): m is RegExpExecArray => m !== null);
  if (matches.length !== 1) {
    return latencyNotMeasured(
      "C-RELEASE",
      matches.length === 0
        ? "C-RELEASE reported no note in the n=/p50=/p95=/max= form its latency rig prints, so no percentile was read " +
            "— a number invented here would be about this parser and not about a boundary"
        : `C-RELEASE reported ${matches.length} notes in the percentile form and there is no way to tell which run they measured`,
    );
  }
  const [, n, p50, p95, max, substrate] = matches[0] as unknown as string[];
  if (p50 === "—" || p95 === "—" || max === "—") {
    return latencyNotMeasured("C-RELEASE", "the latency rig produced no usable samples, so its percentiles are not numbers");
  }
  return observedLatency(
    { n: Number(n), p50: Number(p50), p95: Number(p95), max: Number(max), substrate: String(substrate) },
    "C-RELEASE",
    "release → the same seats granted to a DIFFERENT principal, measured across the boundary rather than inside it",
  );
}

/* ── 5 · The floor observation ─────────────────────────────────────────────── */

/**
 * `floor_violations` and `operator_overrides`, observed rather than assumed.
 *
 * A Hold "stopped holding" before its floor deadline when no seat row of it is
 * still occupying and the deadline has not passed. Split on `revocation_reason`:
 * with one, T1a calls it an Operator Override; without one, nothing in the
 * protocol shortened that floor legitimately and it is a violation. That is
 * C-REVOKE's query, deliberately reused rather than rewritten — two counters
 * read from two statements can agree by accident.
 *
 * **Nothing here induces either event.** C-FLOOR plants a violation on purpose,
 * to prove that `owned_store` hard-fails at one; counting the store after that
 * class would publish the harness's own fixture as the implementation's number.
 * So this runs on a fresh bench, grants a cohort of its own, watches them for
 * `observe_ms`, and counts. A conforming boundary answers zero to both — and
 * that zero is MEASURED, which is the only kind worth publishing. A boundary
 * that reaps inside its own floor answers otherwise, which is the finding.
 */
async function observeFloor(
  options: RunOptions,
): Promise<{ violations: CountMeasurement; overrides: CountMeasurement; trials: number }> {
  const cohort = 6;
  const scope = CREDENTIAL_A.principal_scope;
  let bench: Awaited<ReturnType<typeof conformanceBench>> | null = null;
  try {
    bench = await conformanceBench();
    await bench.reset();
    const seats: string[][] = [];
    for (let i = 0; i < cohort; i++) seats.push([`E:${i + 1}`]);
    let granted = 0;
    for (const pair of seats) {
      const call = await grantHold(bench, TOKEN.a, pair, {}, `observe-${bench.nonce}`);
      if (call.status === 201) granted++;
    }
    if (granted === 0) {
      return {
        violations: notMeasured("floor observation", "the boundary granted none of the observation cohort, so no floor was under observation"),
        overrides: notMeasured("floor observation", "the boundary granted none of the observation cohort, so no floor was under observation"),
        trials: cohort,
      };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, options.observe_ms));

    const counted = await bench.db.query<{ overrides: string; violations: string }>(
      "select" +
        " count(*) filter (where h.revocation_reason is not null)::text as overrides," +
        " count(*) filter (where h.revocation_reason is null)::text as violations" +
        " from hold h" +
        " where h.principal_scope = $1" +
        "   and h.floor_deadline > clock_timestamp()" +
        "   and not exists (select 1 from hold_seat s where s.hold_id = h.hold_id" +
        "                     and s.state in ('live', 'handed_off', 'claimed'))",
      [scope],
    );
    const row = counted.rows[0];
    const where =
      `${granted} Holds granted at this Server's own floor, watched for ${options.observe_ms}ms, ` +
      `counted over principal_scope ${scope} alone so a neighbour's rows are not this run's number`;
    return {
      violations: observedCount(Number(row?.violations ?? 0), "floor observation", where),
      overrides: observedCount(
        Number(row?.overrides ?? 0),
        "floor observation",
        `${where} — nothing here induces an Override; the number is what the operator did during the window`,
      ),
      trials: cohort,
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      violations: notMeasured("floor observation", `the observation could not run: ${why}`),
      overrides: notMeasured("floor observation", `the observation could not run: ${why}`),
      trials: 0,
    };
  } finally {
    if (bench !== null) await bench.close().catch(() => undefined);
  }
}

/* ── 6 · The run ───────────────────────────────────────────────────────────── */

interface Family {
  readonly ids: readonly string[];
  readonly binding: Binding;
  readonly source: string;
  run(options: RunOptions, selected: readonly string[]): Promise<{ classes: ReportClass[]; extra?: Partial<RunResult> }>;
}

const specRowOf = (id: string): string =>
  CONFORMANCE_CLASSES.find((c) => c.id === id)?.spec_row ?? `(no §7 row is registered under ${id})`;

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** The `src/classes/` family, over the HTTP binding, on one shared bench. */
async function runDirectoryFamily(options: RunOptions, selected: readonly string[]): Promise<ReportClass[]> {
  const { found } = await discoverClassModules();
  const wanted = found.filter((m) => selected.includes(m.id));
  if (wanted.length === 0) return [];

  const bench = await conformanceBench();
  const out: ReportClass[] = [];
  try {
    for (const entry of wanted) {
      const source = `${CLASSES_DIR}/${entry.file}`;
      const started = performance.now();
      options.log(`  · ${entry.id}`);
      try {
        const clauses = await entry.module.run(bench);
        out.push(fromClassOutcome(classOutcome(entry.module, clauses), "http", source, performance.now() - started));
      } catch (err) {
        out.push(
          err instanceof CannotProve
            ? unreached(entry.id, entry.module.spec_row, err.message, { binding: "http", source })
            : threw(entry.id, entry.module.spec_row, err, "http", source),
        );
      }
    }
  } finally {
    await bench.close().catch(() => undefined);
  }
  return out;
}

/** C-IDEMPOTENT, C-RELEASE, C-ORPHAN. C-ORPHAN needs a contender to contend with. */
async function runLifecycleFamily(
  options: RunOptions,
  selected: readonly string[],
): Promise<{ classes: ReportClass[]; latency: LatencyMeasurement | null; trials: number }> {
  const source = "packages/conformance/src/lifecycle";
  const out: ReportClass[] = [];
  let latency: LatencyMeasurement | null = null;
  let trials = 0;
  const run = `t7${Date.now().toString(36)}${Math.floor(Math.random() * 1e5).toString(36)}`;

  const drive = async (
    id: string,
    file: string,
    fn: () => Promise<LifecycleResult>,
    after?: (r: LifecycleResult) => void,
  ): Promise<void> => {
    if (!selected.includes(id)) return;
    const started = performance.now();
    options.log(`  · ${id}`);
    try {
      const result = await fn();
      if (result.unprovable !== undefined) {
        out.push(unreached(id, specRowOf(id), result.unprovable, { binding: "in_process", source: `${source}/${file}` }));
        return;
      }
      after?.(result);
      out.push(
        fromClauses(id, specRowOf(id), lifecycleClauses(result), "in_process", `${source}/${file}`, performance.now() - started),
      );
    } catch (err) {
      out.push(
        err instanceof CannotProve
          ? unreached(id, specRowOf(id), err.message, { binding: "in_process", source: `${source}/${file}` })
          : threw(id, specRowOf(id), err, "in_process", `${source}/${file}`),
      );
    }
  };

  const { cIdempotent } = await import("./lifecycle/c-idempotent.ts");
  const { cRelease } = await import("./lifecycle/c-release.ts");
  await drive("C-IDEMPOTENT", "c-idempotent.ts", () => cIdempotent({ run_id: `i${run}` }) as Promise<LifecycleResult>);
  await drive(
    "C-RELEASE",
    "c-release.ts",
    () => cRelease({ run_id: `r${run}`, latency_trials: options.latency_trials }) as Promise<LifecycleResult>,
    (result) => {
      latency = readPercentiles(result.notes);
      trials += options.latency_trials;
    },
  );

  if (selected.includes("C-ORPHAN")) {
    if (!concurrentSubstrate()) {
      out.push(
        unreached(
          "C-ORPHAN",
          specRowOf("C-ORPHAN"),
          `"the next contending transaction" requires a contender and there cannot be one here — ${NEEDS_POSTGRES}`,
          { binding: "in_process", source: `${source}/c-orphan.ts` },
        ),
      );
    } else {
      const { cOrphan } = await import("./lifecycle/c-orphan.ts");
      await drive("C-ORPHAN", "c-orphan.ts", () => cOrphan({ run_id: `o${run}` }) as Promise<LifecycleResult>);
    }
  }
  return { classes: out, latency, trials };
}

/** C-INJECT and C-PII-INGEST, over the etag the harness projector mints. */
async function runInjectFamily(options: RunOptions, selected: readonly string[]): Promise<ReportClass[]> {
  const source = "packages/conformance/src/inject";
  const out: ReportClass[] = [];
  const toClauses = (checks: readonly InjectCheck[]): ReportClause[] =>
    checks.map((c) => clause(c.id, c.held ? CLASS_STATUS.pass : CLASS_STATUS.fail, c.note));

  if (selected.includes("C-PII-INGEST")) {
    const started = performance.now();
    options.log("  · C-PII-INGEST");
    try {
      const { runCPiiIngest } = await import("./inject/c-pii-ingest.ts");
      out.push(
        fromClauses(
          "C-PII-INGEST",
          specRowOf("C-PII-INGEST"),
          toClauses(runCPiiIngest() as readonly InjectCheck[]),
          "in_process",
          `${source}/c-pii-ingest.ts`,
          performance.now() - started,
        ),
      );
    } catch (err) {
      out.push(threw("C-PII-INGEST", specRowOf("C-PII-INGEST"), err, "in_process", `${source}/c-pii-ingest.ts`));
    }
  }

  if (selected.includes("C-INJECT")) {
    const started = performance.now();
    options.log("  · C-INJECT");
    try {
      // The HARNESS projector, deliberately: C-INJECT's claim is that a poisoned
      // document mints the byte-identical etag, and the mint must therefore be
      // the one `prove_etag_golden.sh` pins the goldens with. `@changeover/schema`
      // has no projector yet, which is C-ETAG's blocker and not this one's.
      const projectorPath = join(REPO_ROOT, "scripts", "lib", "project.mjs");
      const projector = (await import(pathToFileURL(projectorPath).href)) as {
        project: (document: unknown, pointers: readonly string[]) => unknown;
      };
      const pointers = (
        JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "projection-0-1.json"), "utf8")) as { pointers: string[] }
      ).pointers;
      // `canonicalize` is CommonJS and this tree does not set `esModuleInterop`,
      // so the default export has to be reached at runtime rather than by a
      // static default import. Version-pinned by the root commit: this is the
      // same RFC 8785 implementation `prove_etag_golden.sh` pins the goldens with.
      const jcs = await import("canonicalize");
      const canonical = ((jcs as { default?: unknown }).default ?? jcs) as (value: unknown) => string;
      const mint = (document: unknown): string =>
        `1:${createHash("sha256")
          .update(Buffer.from(canonical(projector.project(document, pointers)), "utf8"))
          .digest("base64url")}`;
      const { runCInject } = await import("./inject/c-inject.ts");
      const checks = await withDb((db) => runCInject({ db, mint }) as Promise<readonly InjectCheck[]>);
      out.push(
        fromClauses(
          "C-INJECT",
          specRowOf("C-INJECT"),
          toClauses(checks),
          "in_process",
          `${source}/c-inject.ts`,
          performance.now() - started,
        ),
      );
    } catch (err) {
      out.push(
        err instanceof CannotProve
          ? unreached("C-INJECT", specRowOf("C-INJECT"), err.message, { binding: "in_process", source: `${source}/c-inject.ts` })
          : threw("C-INJECT", specRowOf("C-INJECT"), err, "in_process", `${source}/c-inject.ts`),
      );
    }
  }
  return out;
}

/** C-BUDGET and C-FANOUT, at the PUBLISHED defaults, on a database of their own. */
async function runBudgetFamily(
  options: RunOptions,
  selected: readonly string[],
): Promise<{ classes: ReportClass[]; trials: number }> {
  const source = "packages/conformance/src/budget";
  const ids = ["C-BUDGET", "C-FANOUT"].filter((id) => selected.includes(id));
  if (ids.length === 0) return { classes: [], trials: 0 };

  const out: ReportClass[] = [];
  let trials = 0;
  let db: Db | null = null;
  try {
    const { bootBudgetBench, privateBenchUrl } = await import("./budget/estate.ts");
    const { parsePublishedTable } = await import("./budget/published.ts");
    const { migrate } = await import("@changeover/store/migrate.ts");
    const table = parsePublishedTable();
    // §12: two benches assumed to be two stores is the dangerous mistake,
    // because it is green. On a shared CHANGEOVER_PG_URL every bench in this
    // repository calls resetEstate, and those calls delete each other's
    // fixtures — so this family takes a database of its own where it can.
    const base = process.env.CHANGEOVER_PG_URL;
    const url = base === undefined ? undefined : await privateBenchUrl(base, "changeover_bench_budget");
    db = await openDb(url === undefined ? {} : { url });
    await migrate(db);
    const bench = await bootBudgetBench(db);

    for (const id of ids) {
      const file = id === "C-BUDGET" ? "c-budget.ts" : "c-fanout.ts";
      const started = performance.now();
      options.log(`  · ${id}`);
      try {
        const module = (await import(`./budget/${file}`)) as {
          sequential: (b: unknown, t: unknown) => Promise<BudgetOutcome>;
          concurrent: (b: unknown, t: unknown) => Promise<BudgetOutcome>;
        };
        const sequential = await module.sequential(bench, table);
        trials += sequential.trials;
        const clauses: ReportClause[] = sequential.checks.map((c) =>
          clause(clauseName(id, c.statement), c.held ? CLASS_STATUS.pass : CLASS_STATUS.fail, c.statement),
        );
        if (!concurrentSubstrate()) {
          clauses.push(
            clause(
              `${id}.concurrent`,
              CLASS_STATUS.unprovable,
              `§7 says "max+1 CONCURRENT holds" and "budgets bind in-transaction", and neither is reachable here — ${NEEDS_POSTGRES}`,
            ),
          );
        } else {
          const raced = await module.concurrent(bench, table);
          trials += raced.trials;
          for (const c of raced.checks) {
            clauses.push(clause(clauseName(id, c.statement), c.held ? CLASS_STATUS.pass : CLASS_STATUS.fail, c.statement));
          }
          if (raced.verdict === "unprovable" && raced.checks.length === 0) {
            clauses.push(clause(`${id}.concurrent`, CLASS_STATUS.unprovable, "the concurrent half reported no check"));
          }
        }
        out.push(fromClauses(id, specRowOf(id), clauses, "in_process", `${source}/${file}`, performance.now() - started, sequential.trials));
      } catch (err) {
        out.push(
          err instanceof CannotProve
            ? unreached(id, specRowOf(id), err.message, { binding: "in_process", source: `${source}/${file}` })
            : threw(id, specRowOf(id), err, "in_process", `${source}/${file}`),
        );
      }
    }
  } catch (err) {
    for (const id of ids) {
      out.push(
        err instanceof CannotProve
          ? unreached(id, specRowOf(id), err.message, { binding: "in_process", source })
          : threw(id, specRowOf(id), err, "in_process", source),
      );
    }
  } finally {
    if (db !== null) await db.close().catch(() => undefined);
  }
  return { classes: out, trials };
}

/** C-ATOMIC. `.3` and `.4` run everywhere; `.1` and `.2` are the race itself. */
async function runAtomicFamily(
  options: RunOptions,
  selected: readonly string[],
): Promise<{ classes: ReportClass[]; oversell: CountMeasurement; trials: number }> {
  const source = "packages/conformance/src/atomic/assertions.ts";
  const id = "C-ATOMIC";
  if (!selected.includes(id)) {
    return {
      classes: [],
      oversell: notMeasured(id, "C-ATOMIC was not selected in this run, and it is the class that counts oversell"),
      trials: 0,
    };
  }

  const started = performance.now();
  options.log(`  · ${id}`);
  const clauses: ReportClause[] = [];
  const reporter = {
    ok: (m: string) => clauses.push(clause(clauseName(id, m), CLASS_STATUS.pass, m)),
    bad: (m: string) => clauses.push(clause(clauseName(id, m), CLASS_STATUS.fail, m)),
    note: () => undefined,
  };

  let db: Db | null = null;
  let oversell: CountMeasurement = notMeasured(id, "the race did not run, so no seat was counted for a second occupant");
  let trials = 0;
  try {
    const { openLiveRaceStore, ServerVanished, isUnreachable } = await import("./atomic/sampler.ts");
    const { C_ATOMIC_PROFILE } = await import("./atomic/profile.ts");
    const assertions = await import("./atomic/assertions.ts");
    const { LISTINGS } = await import("./atomic/estate.ts");
    const { physicalOversell } = await import("./atomic/contend.ts");

    db = await openLiveRaceStore(C_ATOMIC_PROFILE.pool_size);
    await assertions.setUpAtomicEstate(db);

    // .3 and .4 are sequential and they run on every substrate. Reporting the
    // whole class unprovable because .1 needs two connections would throw away
    // two assertions that genuinely held.
    await assertions.claimedSeatIsUnholdable(db, reporter);
    await assertions.allOrNothing(db, reporter);

    if (!concurrentSubstrate() || !db.concurrent) {
      clauses.push(
        clause(
          `${id}.1`,
          CLASS_STATUS.unprovable,
          `.1 and .2 are the whole of the atomicity claim and they need two connections — ${NEEDS_POSTGRES}`,
        ),
      );
      oversell = notMeasured(
        id,
        "oversell is counted after 200 contenders race one house, and this substrate cannot race — a zero here would " +
          "mean 'nobody tried', which is the reading this report exists to prevent",
      );
    } else {
      try {
        await assertions.raceHouse(db, reporter, C_ATOMIC_PROFILE);
        await assertions.raceExpiryBoundary(db, reporter, C_ATOMIC_PROFILE);
        trials = C_ATOMIC_PROFILE.trials * 2;
        oversell = observedCount(
          await physicalOversell(db, LISTINGS),
          id,
          `physical seats carrying more than one occupying row after ${C_ATOMIC_PROFILE.trials} contenders raced a ` +
            `${C_ATOMIC_PROFILE.house_capacity}-seat house across ${LISTINGS.length} listings, on ${db.driver} with ` +
            `${C_ATOMIC_PROFILE.pool_size} connections`,
        );
      } catch (err) {
        // The container this suite runs against is started with --rm. When it
        // goes away mid-race every contender returns ECONNREFUSED, and reporting
        // that as an oversell would send someone hunting a race in correct code.
        if (err instanceof ServerVanished || isUnreachable(err)) {
          clauses.push(clause(`${id}.race`, CLASS_STATUS.unprovable, `the store stopped answering mid-race: ${String(err)}`));
          oversell = notMeasured(id, "the store stopped answering mid-race, so nothing was counted");
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    if (err instanceof CannotProve) {
      return { classes: [unreached(id, specRowOf(id), err.message, { binding: "in_process", source })], oversell, trials };
    }
    return { classes: [threw(id, specRowOf(id), err, "in_process", source)], oversell, trials };
  } finally {
    if (db !== null) await db.close().catch(() => undefined);
  }

  return {
    classes: [fromClauses(id, specRowOf(id), clauses, "in_process", source, performance.now() - started, trials)],
    oversell,
    trials,
  };
}

/* ── 7 · Everything, in order, once ────────────────────────────────────────── */

/** Which family runs a class. A class in no family is a class nobody built. */
export const FAMILY_OF: Readonly<Record<string, string>> = Object.freeze({
  "C-IDEMPOTENT": "lifecycle",
  "C-RELEASE": "lifecycle",
  "C-ORPHAN": "lifecycle",
  "C-INJECT": "inject",
  "C-PII-INGEST": "inject",
  "C-BUDGET": "budget",
  "C-FANOUT": "budget",
  "C-ATOMIC": "atomic",
});

/**
 * Run everything, once, sequentially.
 *
 * Sequentially and never in parallel: every family in this repository resets its
 * own estate at setup, and against one `CHANGEOVER_PG_URL` two of them running
 * at once truncate each other's fixtures. §12 records that exact failure, and it
 * arrives looking like a boundary defect.
 */
export async function runConformance(options: RunOptions): Promise<RunResult> {
  const registered = CONFORMANCE_CLASSES.map((c) => c.id);
  const selected = options.only === null ? registered : registered.filter((id) => options.only?.includes(id));
  const results = new Map<string, ReportClass>();
  let trials = 0;

  options.log("running the conformance classes");
  for (const entry of await runDirectoryFamily(options, selected)) results.set(entry.class, entry);

  const lifecycle = await runLifecycleFamily(options, selected);
  for (const entry of lifecycle.classes) results.set(entry.class, entry);
  trials += lifecycle.trials;

  for (const entry of await runInjectFamily(options, selected)) results.set(entry.class, entry);

  const budget = await runBudgetFamily(options, selected);
  for (const entry of budget.classes) results.set(entry.class, entry);
  trials += budget.trials;

  const atomic = await runAtomicFamily(options, selected);
  for (const entry of atomic.classes) results.set(entry.class, entry);
  trials += atomic.trials;

  options.log("observing the floor");
  const floor = await observeFloor(options);
  trials += floor.trials;

  // Every registered class appears, whichever way it went. A class absent from a
  // list of twenty-four is indistinguishable from a class that passed.
  const classes: ReportClass[] = [];
  for (const id of registered) {
    const ran = results.get(id);
    if (ran !== undefined) {
      classes.push(ran);
      continue;
    }
    if (!selected.includes(id)) {
      classes.push(
        unreached(id, specRowOf(id), `not selected: this run was restricted to ${(options.only ?? []).join(", ")}`),
      );
      continue;
    }
    const family = FAMILY_OF[id];
    const expected =
      family === undefined
        ? `${CLASSES_DIR}/${id.toLowerCase()}.ts`
        : `packages/conformance/src/${family}`;
    classes.push(
      unreached(
        id,
        specRowOf(id),
        `no module in this repository runs ${id}: the harness has nothing to import, so the class was not executed. ` +
          `A module at ${expected} exporting the contract in ${CLASSES_DIR}/_contract.ts would put it in this report`,
        { missing_path: expected },
      ),
    );
  }

  const run_at = await withDb((db) => serverTime(db));
  const store = await openDb();
  const driver = store.driver;
  const concurrent = store.concurrent;
  await store.close();

  return {
    run_at,
    classes,
    trials,
    floor_violations: floor.violations,
    operator_overrides: floor.overrides,
    release_latency_ms:
      lifecycle.latency ??
      latencyNotMeasured("C-RELEASE", "C-RELEASE did not run in this selection, and it is the class that measures release latency"),
    oversell_events: atomic.oversell,
    driver,
    concurrent,
  };
}

/* ── 8 · Binding coverage ──────────────────────────────────────────────────── */

/**
 * Which requested bindings any class actually drove.
 *
 * A run asked for `http,mcp` and given twenty-four classes over HTTP has not
 * tested MCP, and a report that listed both bindings beside twenty-four passes
 * would say it had. So an unexercised binding is recorded as unexercised, with a
 * reason, and it costs the run its exit 0 — the same way an unprovable class
 * does, because it is the same kind of gap.
 */
export function bindingCoverage(
  requested: readonly Binding[],
  classes: readonly ReportClass[],
): { binding: Binding; exercised: boolean; classes: string[]; reason?: string }[] {
  return requested.map((binding) => {
    const drove = classes.filter((c) => c.binding === binding && c.clauses.length > 0).map((c) => c.class);
    if (drove.length > 0) return { binding, exercised: true, classes: drove };
    return {
      binding,
      exercised: false,
      classes: [],
      reason:
        `no class in this run drove the ${binding} binding, so this report asserts nothing about it — ` +
        `a class needing a binding the harness does not speak reports unprovable, never pass`,
    };
  });
}

/** `packages/conformance/src/classes` exists, so a stale blocker can be spotted. */
export function pathStillMissing(path: string, root: string = REPO_ROOT): boolean {
  return !existsSync(join(root, path));
}
