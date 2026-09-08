// The shape of a conformance class module, and the discipline that keeps a
// class from reporting nothing. Owner: TEST-006.
//
// `docs/BUILD-CONTRACT.md` §1 says `run.ts` reads this directory and imports
// each `c-<name>.ts`; the registry is the filesystem and nobody edits a table.
// It does not say what a module exports, because `harness.ts` was an empty
// directory when this was written. This file is that shape, defined where the
// class modules live so that no second author has to guess it, and deliberately
// small: an id, §7's own words, and a function returning clause outcomes.
//
// **A class is a row of §7, and a row is several clauses.** C-CLOCK's row names
// four separate things and one of them — the DST fixtures — is a different kind
// of assertion from the other three. Reporting a whole row as one boolean throws
// away which half was reached, and a row that is nine-tenths provable then has
// to choose between overclaiming and reporting nothing. So the unit here is the
// CLAUSE, and the class status is derived from its clauses by the rule §7 gives:
//
//   any clause failed        -> fail
//   else any clause unproven -> unprovable, naming which one and why
//   else                     -> pass
//
// The derivation is a function, never an assignment. There is no path from a
// throw to a pass and no path from an unreached clause to one either.
//
// **`cannot()` requires a reason and the reason must stay true.** A blocker is
// phrased as a fact about this interface, not about a neighbour's Tuesday, and
// where an absence is the reason it names the absent path so the proof script
// can re-check it. A class blocked on `packages/agent` turns RED the day
// somebody writes one — which is the only mechanism that stops "unprovable"
// from becoming a place to put work.

import type { ConformanceBench } from "./_bench.ts";

/* ── 1 · Outcomes ──────────────────────────────────────────────────────────── */

export const CLASS_STATUS = { pass: "pass", fail: "fail", unprovable: "unprovable" } as const;
export type ClassStatus = (typeof CLASS_STATUS)[keyof typeof CLASS_STATUS];

export interface ClauseOutcome {
  /** `C-AUTHZ.404` — the class id, a dot, and the clause's own short name. */
  readonly clause: string;
  readonly status: ClassStatus;
  /** What held, what did not, or why it could not be reached. Never empty. */
  readonly note: string;
  /** On `unprovable` only: a repository path whose absence is the reason. */
  readonly missing_path?: string;
}

export interface ClassOutcome {
  readonly class: string;
  /** §7's own words for this row, so the report is auditable against the source. */
  readonly spec_row: string;
  readonly status: ClassStatus;
  /** REQUIRED on `fail` and on `unprovable`. Absent only on `pass`. */
  readonly reason?: string;
  readonly clauses: readonly ClauseOutcome[];
}

export interface ConformanceClassModule {
  readonly id: string;
  readonly spec_row: string;
  run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]>;
}

/* ── 2 · Collecting clauses ────────────────────────────────────────────────── */

/**
 * The collector a class runner writes into.
 *
 * Every method takes a clause name so that the report names WHICH part of a §7
 * row was reached. A class that calls nothing produces zero clauses, and
 * {@link classOutcome} turns that into a `fail` rather than a `pass` — a class
 * that reports nothing looks exactly like a class that passed, in a list long
 * enough that nobody counts.
 */
export class Clauses {
  readonly id: string;
  readonly items: ClauseOutcome[];

  constructor(id: string) {
    this.id = id;
    this.items = [];
  }

  private push(clause: string, status: ClassStatus, note: string, missing_path?: string): void {
    const named = clause.startsWith(this.id) ? clause : `${this.id}.${clause}`;
    const entry: ClauseOutcome = missing_path === undefined
      ? { clause: named, status, note }
      : { clause: named, status, note, missing_path };
    this.items.push(entry);
  }

  /** The clause held. */
  ok(clause: string, note: string): void {
    this.push(clause, CLASS_STATUS.pass, note);
  }

  /** The clause did not hold. The class fails. */
  bad(clause: string, note: string): void {
    this.push(clause, CLASS_STATUS.fail, note);
  }

  /** `ok` when the two agree, `bad` naming both when they do not. */
  is(clause: string, actual: unknown, expected: unknown, note: string): boolean {
    const held = Object.is(actual, expected);
    if (held) this.ok(clause, note);
    else {
      this.bad(
        clause,
        `${note} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
      );
    }
    return held;
  }

  /** `ok` on true, `bad` on false. For a predicate that carries its own message. */
  that(clause: string, held: boolean, note: string): boolean {
    if (held) this.ok(clause, note);
    else this.bad(clause, note);
    return held;
  }

  /**
   * The clause could not be reached. **Not a pass, and not a failure.**
   *
   * `reason` names the thing that is missing in terms of this interface, so that
   * it is still true when it is read. `missing_path`, where an absence is the
   * reason, is re-checked by the proof script: if the path appears, the blocker
   * is stale and the suite says so.
   */
  cannot(clause: string, reason: string, missing_path?: string): void {
    if (reason.trim().length === 0) {
      throw new Error(`${this.id}: clause ${clause} is unprovable for no stated reason`);
    }
    this.push(clause, CLASS_STATUS.unprovable, reason, missing_path);
  }
}

/* ── 3 · Deriving the class status ─────────────────────────────────────────── */

/** Every clause that did not hold, then every clause that could not be reached. */
export function classOutcome(
  module: ConformanceClassModule,
  clauses: readonly ClauseOutcome[],
): ClassOutcome {
  const base = { class: module.id, spec_row: module.spec_row, clauses };

  if (clauses.length === 0) {
    return {
      ...base,
      status: CLASS_STATUS.fail,
      reason: "the class ran and asserted nothing — a silent skip, which §7 counts as a failure",
    };
  }

  const failed = clauses.filter((c) => c.status === CLASS_STATUS.fail);
  if (failed.length > 0) {
    return {
      ...base,
      status: CLASS_STATUS.fail,
      reason: failed.map((c) => `${c.clause}: ${c.note}`).join(" · "),
    };
  }

  const unproven = clauses.filter((c) => c.status === CLASS_STATUS.unprovable);
  if (unproven.length > 0) {
    return {
      ...base,
      status: CLASS_STATUS.unprovable,
      reason: unproven.map((c) => `${c.clause}: ${c.note}`).join(" · "),
    };
  }

  return { ...base, status: CLASS_STATUS.pass };
}

/** A class whose runner threw. The throw is the failure; it never becomes a pass. */
export function classThrew(module: ConformanceClassModule, err: unknown): ClassOutcome {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return {
    class: module.id,
    spec_row: module.spec_row,
    status: CLASS_STATUS.fail,
    reason: `the runner threw before it could report: ${message}`,
    clauses: [],
  };
}

/* ── 4 · The twelve this item owns ─────────────────────────────────────────── */

/**
 * TEST-006's row of the backlog, as data.
 *
 * Enumerated because the gate is "none silently skipped": a class module that is
 * deleted, renamed or never written must turn the suite red, and the only way to
 * notice a missing file is to hold a list of what should be there. The register
 * of ALL classes is `register/2026.1.json` and TEST-007's `run.ts`; this is the
 * subset one item is answerable for.
 */
export const TEST_006_CLASSES: readonly string[] = Object.freeze([
  "C-SUBST",
  "C-ORIGIN",
  "C-AUTHZ",
  "C-REFUSE",
  "C-CLOCK",
  "C-LOG",
  "C-SEATMAP",
  "C-CLAIM",
  "C-USAGE",
  "C-PROFILE0",
  "C-REVOKE",
  "C-FLOOR",
]);
