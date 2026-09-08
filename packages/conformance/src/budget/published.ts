/**
 * §2.5's table, read out of the specification at run time.
 *
 * Owner: TEST-002. This module exists for one reason, and it is the reason the
 * whole item exists: **C-BUDGET and C-FANOUT are only worth anything at the
 * numbers the Server publishes.** A fan-out assertion that passes at
 * `max_live_holds_per_cluster: 4` is a statement about a configuration file. So
 * the harness does not take the enforced numbers on trust and it does not hard-
 * code the specification's numbers beside them either — both of those drift
 * silently, and a hard-coded copy drifts in exactly the direction that keeps the
 * suite green.
 *
 * Instead the published defaults are **parsed out of `SPEC.md` §2.5** and
 * compared to `HOLD_POLICY_PUBLISHED`. Editing the specification's table without
 * editing the code turns this red; editing the code without editing the table
 * turns this red; softening a ceiling "just for the harness" turns this red. The
 * document and the server can no longer disagree quietly, which is precisely
 * what §2.5's own sentence demands — *"A Server MUST NOT enforce a limit it has
 * not published here or in the capability document."*
 *
 * The parser is deliberately strict and deliberately noisy. If it cannot find
 * the section it reports that it cannot prove; if it finds the section and
 * recovers fewer members than the document declares, that is a **failure**, not
 * an absence — a table this proof cannot read is a table nobody can check.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { HoldPolicyDocument } from "@changeover/core/budgets.ts";

/** The repository root, four levels above `packages/conformance/src/budget`. */
export const REPO_ROOT: string = join(import.meta.dirname, "..", "..", "..", "..");

/** The authority. Never a copy of it. */
export const SPEC_PATH: string = join(REPO_ROOT, "SPEC.md");

/** One row of §2.5, as the specification states it. */
export interface PublishedLimit {
  readonly member: string;
  /** The stated lower bound, where the cell gives one. */
  readonly min: number | null;
  /** The stated upper bound, where the cell gives one. */
  readonly max: number | null;
  /** The stated default, where the cell gives one. `null` means the cell leaves it open. */
  readonly default_value: number | boolean | null;
  /** `*(platform)*` in the member cell — X3 rather than X1. */
  readonly platform: boolean;
  /** The range cell verbatim, so a failure can print what the table actually says. */
  readonly cell: string;
}

/** Every member §2.5 declares, keyed by name, in the table's own order. */
export type PublishedTable = ReadonlyMap<string, PublishedLimit>;

/** `SPEC.md` §2.5 could not be located. Never a failure — the caller exits 2. */
export class SectionNotFound extends Error {
  constructor(path: string) {
    super(`no "### 2.5 Hold policy" section in ${path}`);
    this.name = "SectionNotFound";
  }
}

const SECTION_HEADING = /^###\s+2\.5\s+Hold policy/;
const ANY_HEADING = /^#{1,6}\s/;

/** Backticked member names in the first cell. A row may name two. */
const MEMBER = /`([a-z_][a-z0-9_]*)`/g;

/** `default 2 · 6` — one value, or a pair matching a pair of members. */
const DEFAULTS = /default\s+(true|false|\d+(?:\.\d+)?)(?:\s*·\s*(true|false|\d+(?:\.\d+)?))?/;

/** `1000 – **300000**`, `1–10000`, `0–1`, `1–**12**`. En dash or hyphen. */
const RANGE = /(\d+(?:\.\d+)?)\s*[–-]\s*\*{0,2}(\d+(?:\.\d+)?)\*{0,2}/;

/** `≥ 1000`, `≥ 0`, `≥ 1`. A lower bound with no upper one. */
const LOWER_ONLY = /≥\s*\*{0,2}(\d+(?:\.\d+)?)\*{0,2}/;

function scalar(raw: string | undefined): number | boolean | null {
  if (raw === undefined) return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The lines of §2.5, from its heading to the next heading of any level. */
export function holdPolicySection(specPath: string = SPEC_PATH): string[] {
  const lines = readFileSync(specPath, "utf8").split("\n");
  const start = lines.findIndex((line) => SECTION_HEADING.test(line));
  if (start < 0) throw new SectionNotFound(specPath);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => ANY_HEADING.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Parse §2.5's table into the members it declares.
 *
 * Two members to a row is the table's own compression — `max_live_holds_per_showtime
 * · max_holds_per_site_per_hour` against `default 2 · 6` — and the pairing is
 * positional, which is why the defaults are captured as a pair rather than
 * matched greedily. Getting that wrong would publish 6 as the per-showtime
 * ceiling, which is a number the code does not enforce, and the parity check
 * below would then fail loudly rather than agree by accident.
 */
export function parsePublishedTable(specPath: string = SPEC_PATH): PublishedTable {
  const table = new Map<string, PublishedLimit>();

  for (const line of holdPolicySection(specPath)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    if (/^-+$/.test(cells[0]?.replace(/[\s:]/g, "") ?? "")) continue;

    const [nameCell = "", rangeCell = ""] = cells;
    MEMBER.lastIndex = 0;
    const members = [...nameCell.matchAll(MEMBER)].map((m) => m[1] as string);
    if (members.length === 0) continue;

    const platform = /\*\(platform\)\*/.test(nameCell);
    const defaults = DEFAULTS.exec(rangeCell);
    const range = RANGE.exec(rangeCell);
    const lower = range ? null : LOWER_ONLY.exec(rangeCell);

    members.forEach((member, index) => {
      table.set(member, {
        member,
        min: range ? Number(range[1]) : lower ? Number(lower[1]) : null,
        max: range ? Number(range[2]) : null,
        default_value: scalar(defaults?.[index + 1]),
        platform,
        cell: rangeCell,
      });
    });
  }

  return table;
}

/** One assertion, in the form every class module in this directory returns. */
export interface Check {
  readonly held: boolean;
  readonly statement: string;
}

const held = (statement: string): Check => ({ held: true, statement });
const broke = (statement: string): Check => ({ held: false, statement });

/**
 * The parity gate: the numbers this Server enforces **are** §2.5's published
 * defaults, and every one of them sits inside §2.5's published range.
 *
 * This is what makes the rest of the item's assertions mean anything. Every
 * scenario below runs against `HOLD_POLICY_PUBLISHED`; these checks are the
 * reason a reader may believe that object is the production document and not a
 * softened harness profile with the same name.
 */
export function parityChecks(
  policy: HoldPolicyDocument,
  table: PublishedTable,
): Check[] {
  const checks: Check[] = [];
  const enforced = policy as unknown as Record<string, number | boolean>;
  const members = Object.keys(enforced);

  const missing = members.filter((member) => !table.has(member));
  checks.push(
    missing.length === 0
      ? held(`§2.5 · all ${members.length} enforced policy members are declared in the specification's own table`)
      : broke(`§2.5 · ${missing.join(", ")} is enforced and the specification's table does not declare it`),
  );

  const undeclared = [...table.keys()].filter((member) => !Object.hasOwn(enforced, member));
  checks.push(
    undeclared.length === 0
      ? held("§2.5 · every member the table declares is carried by the published document — the table cannot outgrow the code")
      : broke(`§2.5 · the table declares ${undeclared.join(", ")} and the published document carries no such member`),
  );

  const withDefaults = [...table.values()].filter((limit) => limit.default_value !== null);
  const disagreed = withDefaults.filter((limit) => enforced[limit.member] !== limit.default_value);
  checks.push(
    disagreed.length === 0
      ? held(
          `§2.5 · every one of the ${withDefaults.length} published defaults is the number this Server enforces — ` +
            "these scenarios run at production defaults, not a harness profile",
        )
      : broke(
          "§2.5 · " +
            disagreed
              .map((limit) => `${limit.member} is published as ${String(limit.default_value)} and enforced as ${String(enforced[limit.member])}`)
              .join("; "),
        ),
  );

  const outOfRange = [...table.values()].filter((limit) => {
    const value = enforced[limit.member];
    if (typeof value !== "number") return false;
    if (limit.min !== null && value < limit.min) return true;
    return limit.max !== null && value > limit.max;
  });
  const ranged = [...table.values()].filter((limit) => limit.min !== null || limit.max !== null);
  checks.push(
    outOfRange.length === 0
      ? held(`§2.5 · all ${ranged.length} members carrying a stated range are enforced inside it`)
      : broke(
          "§2.5 · " +
            outOfRange
              .map((limit) => `${limit.member}=${String(enforced[limit.member])} is outside the table's "${limit.cell}"`)
              .join("; "),
        ),
  );

  return checks;
}

/** How the table states a member, for the observed-beside-published print-out. */
export function statedAs(table: PublishedTable, member: string): string {
  const limit = table.get(member);
  if (limit === undefined) return "(not in §2.5)";
  if (limit.default_value !== null) return `default ${String(limit.default_value)}`;
  return limit.cell;
}
