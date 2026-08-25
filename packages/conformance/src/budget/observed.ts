/**
 * The observed-beside-published ledger.
 *
 * Owner: TEST-002. §2.5 ends with a sentence that is really two rules facing
 * each other: *"A Server MUST NOT enforce a limit it has not published here or
 * in the capability document, and C-CAPABILITY asserts the converse: no limit
 * observed at runtime may be absent from the document."* An assertion can prove
 * the first. Only a **print-out** proves the second to a human, because the
 * question a reader is actually asking is *"is this server refusing me at the
 * numbers its own document gives?"* — and the honest answer to that is two
 * columns side by side, not a green tick.
 *
 * *"An undisclosed limit is indistinguishable from a bug to a caller with no
 * eyes, and one incumbent surface documents exactly that failure: exceeding an
 * undocumented held-seat cap returns an invalid-request error with no details."*
 * This file is the eyes.
 *
 * Every observation carries where the number came from: the ceiling **published**
 * in the hold policy, the ceiling **named in the refusal itself** (`detail.limit`
 * — the only number the caller ever sees), and the count actually **observed**
 * in the store. Three sources that must agree, printed so that they visibly do.
 */

import type { Check } from "./published.ts";

export type { Check } from "./published.ts";

/** One measurement: a published ceiling, and what the Server actually allowed. */
export interface Observation {
  /** The §4.7 rule this measurement discharges. */
  readonly rule: string;
  /** The §2.5 member, or a derived ceiling written as its arithmetic. */
  readonly member: string;
  /** What §2.5 publishes, rendered. */
  readonly published: string;
  /** What the store carried when the ceiling bound. */
  readonly observed: string;
  /** `detail.limit` off the refusal the caller received, where one was refused. */
  readonly refused_with: string;
  /** Whether the callers were genuinely simultaneous. */
  readonly concurrent: boolean;
  /** What was counted, in words a reader can check against the document. */
  readonly counting: string;
}

/** What a class module returns. Verdicts are the three the specification names. */
export interface ClassOutcome {
  readonly class_id: string;
  readonly verdict: "pass" | "fail" | "unprovable";
  readonly checks: readonly Check[];
  readonly observations: readonly Observation[];
  /** §7's report member: how many holds were attempted to reach this verdict. */
  readonly trials: number;
}

/** `pass` unless something did not hold. An empty class is not a passing class. */
export function verdictOf(checks: readonly Check[]): "pass" | "fail" {
  if (checks.length === 0) return "fail";
  return checks.every((check) => check.held) ? "pass" : "fail";
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

const HEADERS = ["rule", "limit", "published", "observed", "refusal names", "callers"] as const;

/**
 * The table, aligned, one row per ceiling.
 *
 * Deliberately plain text on stdout rather than a JSON blob: the reader this is
 * for has the capability document open in another window and is checking one
 * column against it by eye. §7's dated JSON report is TEST-007's, and it carries
 * the same numbers for machines.
 */
export function renderObservations(observations: readonly Observation[]): string {
  if (observations.length === 0) return "  (no ceilings were observed binding)";

  const rows = observations.map((o) => [
    o.rule,
    o.member,
    o.published,
    o.observed,
    o.refused_with,
    o.concurrent ? "concurrent" : "sequential",
  ]);

  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );

  const line = (cells: readonly string[]): string =>
    "  " + cells.map((cell, column) => pad(cell, widths[column] ?? 0)).join("  ").trimEnd();

  const out: string[] = [];
  out.push(line(HEADERS));
  out.push("  " + widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) out.push(line(row));
  out.push("");
  for (const o of observations) {
    out.push(`  ${o.rule} · ${o.member}: ${o.counting}`);
  }
  return out.join("\n");
}
