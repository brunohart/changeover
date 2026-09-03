// The transcript. Owner: DEMO-001.
//
// A senior engineer reads this once, in a terminal, and knows what the protocol
// is for. So it is plain text with a fixed left gutter, real elapsed times taken
// around real calls, and no colour: colour is the first thing a pipe eats, and
// this is meant to survive being pasted into an issue.
//
// The marks in the gutter are the whole legend:
//
//   →  a call went out          ·  a note about what just happened
//   ←  an answer came back      ?  a gate shown to the human, from structure
//   #  a count taken from the store, not from a response
//   …  a wait, and how long it really was

import type { Bench, Exhibitor } from "./bench.ts";
import type { Beat, Reel } from "./reels.ts";
import type { DemoResult, Verdict } from "./run.ts";

const RULE = "─".repeat(78);

function ms(value: number | undefined): string {
  return value === undefined ? "" : `  ${value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`}`;
}

function beatLines(beat: Beat): string[] {
  const lines = [`  ${beat.mark} ${beat.text}${ms(beat.ms)}`];
  for (const line of beat.block ?? []) lines.push(`      ${line}`);
  return lines;
}

export function reelLines(reel: Reel): string[] {
  const badge = reel.outcome === "refused" ? `REFUSED ${reel.refusal?.code ?? ""}` : "ok";
  return [
    "",
    `REEL ${reel.n}/7 · ${reel.title}`,
    `         ${reel.premise}`,
    `         [${badge}]${ms(reel.ms)}`,
    "",
    ...reel.beats.flatMap(beatLines),
  ];
}

export function headerLines(): string[] {
  return [
    RULE,
    "CHANGEOVER · an open commitment boundary for cinema exhibition",
    "",
    "An agent holds a seat for a stated, irrevocable window and hands the customer",
    "back to the exhibitor's own checkout with the seats still there. There is no",
    "settlement verb. Seven reels follow, and four of them fail on purpose.",
    "",
    "  →  a call        ←  its answer     ·  a note",
    "  ?  a gate        #  a store count   …  a real wait",
    RULE,
  ];
}

/**
 * What is happening during the silence before reel 1.
 *
 * Printed rather than waited through, because the wait IS the claim: §7 forbids
 * a Server to grant a floor it has not measured, and measuring one means
 * holding real seats and watching when they come back. A demo that hid this
 * behind a spinner would be hiding the most expensive promise in the protocol.
 */
export function bootingLines(probe_floor_ms: number): string[] {
  // The trials inside one measurement run concurrently, so the window is about
  // one probe floor regardless of how many observations are taken.
  const about = Math.round(probe_floor_ms / 1000);
  return [
    "",
    "· booting two exhibitors over PGlite, in this process, on loopback.",
    "· each one measures its own seat retention before it publishes a floor —",
    `  §7 forbids granting one that was not measured, so this takes ~${about}s on purpose.`,
  ];
}

export function bootedLines(bench: Bench): string[] {
  const line = (exhibitor: Exhibitor): string => {
    const evidence = exhibitor.measurement.evidence;
    return (
      `  ${exhibitor.venue_name.padEnd(14)} ${exhibitor.base.padEnd(22)} ` +
      `floor ${String(exhibitor.policy.policy_max_floor_ms).padStart(6)}ms  ` +
      `= ${evidence.min_observed_retention_ms}ms observed − ${evidence.safety_margin_ms}ms margin ` +
      `over ${evidence.observations} observation${evidence.observations === 1 ? "" : "s"}, ` +
      `${evidence.violations} violations`
    );
  };
  return ["", `· up in ${(bench.boot_ms / 1000).toFixed(1)}s:`, line(bench.circuit), line(bench.independent)];
}

export function summaryLines(result: DemoResult, verdict: Verdict): string[] {
  const lines = [
    "",
    RULE,
    "SUMMARY",
    "",
    `  boot            ${(result.boot_ms / 1000).toFixed(1)}s   two Servers, two stores, two floor measurements`,
    `  seven reels     ${(result.reels_ms / 1000).toFixed(1)}s`,
    `  total           ${(result.total_ms / 1000).toFixed(1)}s`,
    "",
    `  floor published ${result.floor.circuit_policy_max_floor_ms}ms, warranted by ` +
      `${result.floor.observations} observations of ${result.floor.min_observed_retention_ms}ms ` +
      `less a ${result.floor.safety_margin_ms}ms margin, ${result.floor.violations} violations`,
    "",
    `  refusals        ${result.refusals.length}`,
  ];
  for (const refusal of result.refusals) {
    lines.push(
      `    ${String(refusal.status).padEnd(4)}${refusal.code.padEnd(24)}${refusal.remediation.padEnd(26)}` +
        `${refusal.method} ${refusal.path}`,
    );
  }
  lines.push("", `  fingerprint     ${result.fingerprint}`, "", "GATE");
  for (const check of verdict.checks) {
    lines.push(`  ${check.ok ? "ok  " : "FAIL"} ${check.text}`);
  }
  lines.push(
    "",
    verdict.held
      ? "  the gate holds."
      : "  the gate does NOT hold. Nothing above is a pass.",
    RULE,
  );
  return lines;
}

export function transcript(result: DemoResult, verdict: Verdict): string {
  return [
    ...headerLines(),
    ...result.reels.flatMap(reelLines),
    ...summaryLines(result, verdict),
  ].join("\n");
}
