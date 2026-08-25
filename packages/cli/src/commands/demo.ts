// `changeover demo`. Owner: DEMO-001.
//
// Sixty seconds, a clean clone, no credentials, no container, no network beyond
// the registry that installed the tree. It boots two Servers over PGlite in
// this process, plays seven reels against them over a real loopback socket, and
// prints what happened.
//
// Exit codes are the house's: 0 the gate held · 1 it did not · 2 the thing under
// test could not be reached.
//
//   changeover demo                 the transcript
//   changeover demo --json          the result object, for a proof or a pipe
//   changeover demo --quiet         the summary only
//   changeover demo --fast          a shorter floor measurement; a shorter floor

import { runDemo, verdictOf } from "../demo/run.ts";
import { bootedLines, bootingLines, headerLines, reelLines, summaryLines } from "../demo/transcript.ts";

/** The gate's own budget, and the number `prove_cold_start.sh` asserts against. */
export const BUDGET_MS = 300000;

export interface DemoFlags {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly fast: boolean;
}

export function parseFlags(argv: readonly string[]): DemoFlags {
  return {
    json: argv.includes("--json"),
    quiet: argv.includes("--quiet"),
    fast: argv.includes("--fast"),
  };
}

/** The published default, and the one `prove_cold_start.sh` times. */
export const DEFAULT_PROBE_FLOOR_MS = 15000;
/** `--fast`: a shorter window warrants a shorter floor. Never the default. */
export const FAST_PROBE_FLOOR_MS = 8000;

export async function run(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const streaming = !flags.json && !flags.quiet;
  const probe_floor_ms = flags.fast ? FAST_PROBE_FLOOR_MS : DEFAULT_PROBE_FLOOR_MS;

  if (streaming) console.log([...headerLines(), ...bootingLines(probe_floor_ms)].join("\n"));

  const result = await runDemo({
    // Offered because a cold CI box sometimes wants it, and NOT the default,
    // because the default should be the numbers a reader would get.
    probe_floor_ms,
    ...(flags.fast ? { floor_trials: 1 } : {}),
    onBoot: streaming ? (bench) => console.log(bootedLines(bench).join("\n")) : undefined,
    onReel: streaming ? (reel) => console.log(reelLines(reel).join("\n")) : undefined,
  });

  const verdict = verdictOf(result, BUDGET_MS);

  // A transcript that printed itself and then said nothing about whether it was
  // right would be a screenshot. The summary is not optional.
  if (flags.json) {
    console.log(JSON.stringify({ ...result, verdict }, null, 2));
  } else {
    console.log(summaryLines(result, verdict).join("\n"));
  }

  return verdict.held ? 0 : 1;
}
