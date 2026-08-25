/**
 * Release latency, as a distribution rather than as a sentence.
 *
 * Owner: TEST-003.
 *
 * §7's report format names `release_latency_ms {p50, p95, max}` and this is
 * where those three numbers come from. The industry's standard answer to *when
 * does a held seat come back* is "it may take a few minutes"; a measured
 * distribution against a running boundary is the direct, testable reply, and it
 * is one of the two numbers nobody in this space publishes.
 *
 * **Nearest-rank, and stated as such.** There are seven defensible definitions
 * of a percentile and they disagree on small samples, which is the only size
 * this harness ever has. Nearest-rank — `sorted[ceil(p·n) − 1]` — always returns
 * an **observed** sample rather than an interpolation between two of them, so
 * every number printed is a latency that actually happened. A p95 that no trial
 * measured is a number about the estimator, not about the boundary.
 *
 * **A single-connection run must not publish these.** Measured against PGlite
 * the contending transaction never waits on a lock, because there is nothing to
 * wait for, so the distribution is a statement about wasm and not about a
 * release. {@link Percentiles.substrate} carries the driver so the report cannot
 * quietly attribute an in-process number to a boundary.
 */

export interface Percentiles {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
  readonly substrate: string;
}

/** Nearest-rank. `p` in `(0, 1]`. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function percentiles(samples: readonly number[], substrate: string): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    min: n === 0 ? Number.NaN : sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: n === 0 ? Number.NaN : sorted[n - 1],
    mean: n === 0 ? Number.NaN : sorted.reduce((a, b) => a + b, 0) / n,
    substrate,
  };
}

/** Two decimals of a millisecond; `hrtime` resolves far finer than that. */
export function ms(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

/** One line, in the order §7 prints them, with the substrate attached. */
export function formatPercentiles(label: string, p: Percentiles): string {
  return (
    label +
    " n=" + p.n +
    " p50=" + ms(p.p50) + "ms" +
    " p95=" + ms(p.p95) + "ms" +
    " max=" + ms(p.max) + "ms" +
    " (min=" + ms(p.min) + "ms mean=" + ms(p.mean) + "ms, " + p.substrate + ")"
  );
}

/** Wall-clock milliseconds around one awaited call, at `hrtime` resolution. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}
