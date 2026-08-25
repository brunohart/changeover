// The run. Owner: DEMO-001.
//
// Boots the two exhibitors, plays the seven reels in order, and returns a typed
// result. It prints nothing — `transcript.ts` renders and `commands/demo.ts`
// decides where the bytes go — so that the gate and the reader are looking at
// the same object rather than at two renderings of one.

import type { RefusalCode } from "@changeover/schema/refusal.ts";

import type { Bench, BenchOptions } from "./bench.ts";
import { bootBench } from "./bench.ts";
import type { Reel, ReelId, RunState } from "./reels.ts";
import { EXPECTED_REFUSALS, REELS, REEL_IDS, newRunState } from "./reels.ts";
import type { TypedRefusal } from "./agent.ts";

export interface DemoResult {
  readonly reels: readonly Reel[];
  /** Every typed refusal the run produced, in reel order. The gate counts these. */
  readonly refusals: readonly TypedRefusal[];
  /** Their codes, for the equality the gate asserts against {@link EXPECTED_REFUSALS}. */
  readonly codes: readonly RefusalCode[];
  readonly boot_ms: number;
  readonly reels_ms: number;
  readonly total_ms: number;
  readonly floor: {
    readonly circuit_policy_max_floor_ms: number;
    readonly observations: number;
    readonly min_observed_retention_ms: number;
    readonly safety_margin_ms: number;
    readonly violations: number;
  };
  /**
   * A structural digest of the run: reel ids, outcomes, refusal codes,
   * remediations and statuses, in order. Deterministic across runs.
   *
   * Deliberately NOT a digest of the transcript. The transcript carries real
   * elapsed times, a CSPRNG hold id and a random `intent_digest`, none of which
   * can repeat and none of which should — a demo whose bytes were identical run
   * to run would be one that had stopped measuring anything. What must not move
   * is the SHAPE, and this is the shape.
   */
  readonly fingerprint: string;
}

export interface RunOptions extends BenchOptions {
  /** Called as each reel finishes, so a terminal can print while the run continues. */
  readonly onReel?: (reel: Reel) => void;
}

export async function runDemo(options: RunOptions = {}): Promise<DemoResult> {
  const started = Date.now();
  const bench: Bench = await bootBench(options);
  const state: RunState = newRunState(bench);

  const reels: Reel[] = [];
  const reels_started = Date.now();
  try {
    for (const reel of REELS) {
      const played = await reel(state);
      reels.push(played);
      options.onReel?.(played);
    }
  } finally {
    await bench.close();
  }
  const reels_ms = Date.now() - reels_started;

  const refusals = reels
    .map((reel) => reel.refusal)
    .filter((refusal): refusal is TypedRefusal => refusal !== null);

  const evidence = bench.circuit.measurement.evidence;

  return {
    reels,
    refusals,
    codes: refusals.map((refusal) => refusal.code),
    boot_ms: bench.boot_ms,
    reels_ms,
    total_ms: Date.now() - started,
    floor: {
      circuit_policy_max_floor_ms: bench.circuit.policy.policy_max_floor_ms,
      observations: evidence.observations,
      min_observed_retention_ms: evidence.min_observed_retention_ms,
      safety_margin_ms: evidence.safety_margin_ms,
      violations: evidence.violations,
    },
    fingerprint: fingerprintOf(reels),
  };
}

/* ── The shape, as one line ────────────────────────────────────────────────── */

export function fingerprintOf(reels: readonly Reel[]): string {
  return reels
    .map((reel) => {
      const refusal = reel.refusal;
      return refusal === null
        ? `${reel.n}:${reel.id}:${reel.outcome}`
        : `${reel.n}:${reel.id}:${reel.outcome}:${refusal.code}:${refusal.status}:${refusal.remediation}`;
    })
    .join("|");
}

/* ── What "it held" means, as a function rather than a paragraph ───────────── */

export interface Verdict {
  readonly held: boolean;
  readonly checks: readonly { readonly ok: boolean; readonly text: string }[];
}

/**
 * The gate, computed from the result object.
 *
 * Exported so `prove_cold_start.sh` asserts the same seven things the command
 * asserts, out of one definition. A proof that re-stated them would be a second
 * opinion about what the demo is for.
 */
export function verdictOf(result: DemoResult, budget_ms: number): Verdict {
  const ids = result.reels.map((reel) => reel.id);
  const expected: readonly ReelId[] = REEL_IDS;
  const checks = [
    {
      ok: result.reels.length === 7,
      text: `seven reels played (${result.reels.length})`,
    },
    {
      ok: ids.length === expected.length && ids.every((id, i) => id === expected[i]),
      text: `the reels ran in order (${ids.join(", ")})`,
    },
    {
      ok: result.refusals.length === EXPECTED_REFUSALS.length,
      text: `exactly ${EXPECTED_REFUSALS.length} typed refusals (${result.refusals.length})`,
    },
    {
      ok:
        result.codes.length === EXPECTED_REFUSALS.length &&
        result.codes.every((code, i) => code === EXPECTED_REFUSALS[i]),
      text: `their codes, in order, are ${EXPECTED_REFUSALS.join(", ")} (${result.codes.join(", ") || "none"})`,
    },
    {
      ok: result.refusals.every((refusal) => refusal.detail !== null || refusal.code === "availability_unknown"),
      text: "every refusal that has a detail branch carried one",
    },
    {
      ok: result.floor.violations === 0 && result.floor.observations > 0,
      text: `the floor was measured, not asserted (${result.floor.observations} observations, ${result.floor.violations} violations)`,
    },
    {
      ok: result.total_ms < budget_ms,
      text: `the whole run took ${(result.total_ms / 1000).toFixed(1)}s, under the ${budget_ms / 1000}s budget`,
    },
  ];
  return { held: checks.every((check) => check.ok), checks };
}
