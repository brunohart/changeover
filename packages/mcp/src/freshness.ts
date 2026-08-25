/**
 * SEP-2549 freshness, on `resolve_occasions`.
 *
 * §6.2: *"`CacheableResult.ttlMs` on `resolve_occasions` MUST be
 * `min(max_staleness_ms, ms_to_sales_cutoff, 30000)`; `cacheScope` MUST be
 * `session`."*
 *
 * Each of the three terms answers a different way a cached listing goes wrong.
 * `max_staleness_ms` is the exhibitor's own statement of how long an
 * observation is worth anything. `ms_to_sales_cutoff` is the moment the
 * screening stops selling — a cached page that outlives it sends an agent to
 * hold seats at a house that has closed, and the refusal it earns
 * (`past_sales_cutoff`) is not retryable, so the agent has nothing to do with
 * the answer. 30000 is the ceiling this boundary will not exceed whatever a
 * publisher writes, because seat availability at a popular screening moves
 * faster than any publisher's optimism about it.
 *
 * **The minimum is taken across the whole page, not per Occasion.** A
 * `CacheableResult` caches one result, and one result containing a screening
 * that closes in five seconds is a result that is stale in five seconds. Taking
 * the per-Occasion minimum and publishing the page's *maximum* would be the
 * arithmetic that makes exactly the wrong screening the one served stale.
 *
 * `cacheScope: "session"` and not `"global"`: what an Occasion says is scoped
 * to the credential that asked. Two principals do not share a cache entry here,
 * and a cross-principal cache would leak which screenings another agent was
 * looking at — a read side-channel on a surface whose entire privacy posture is
 * that it carries nothing about anybody.
 */

import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";

/** §6.2's third term. The ceiling, whatever a publisher wrote. */
export const FRESHNESS_CEILING_MS: DurationMs = 30000;

/** SEP-2549's two members, as this binding emits them. */
export interface CacheableResult {
  readonly ttlMs: DurationMs;
  readonly cacheScope: "session";
}

export const CACHE_SCOPE: "session" = "session";

/** What one Occasion contributes to the page's freshness. */
export interface FreshnessInput {
  /** `availability.max_staleness_ms`, where the publisher stated one. */
  readonly max_staleness_ms?: DurationMs | null;
  /** `instant.sales_cutoff_at`. */
  readonly sales_cutoff_at?: Rfc3339 | null;
}

function msToCutoff(sales_cutoff_at: Rfc3339 | null | undefined, now: Rfc3339): DurationMs | null {
  if (typeof sales_cutoff_at !== "string" || sales_cutoff_at.length === 0) return null;
  const cutoff = Date.parse(sales_cutoff_at);
  const at = Date.parse(now);
  if (!Number.isFinite(cutoff) || !Number.isFinite(at)) return null;
  // Never negative. A screening already past its cutoff contributes zero, which
  // makes the whole page uncacheable — which is correct, and is what a caller
  // needs to be told rather than a small positive number that reads as fine.
  return Math.max(0, cutoff - at);
}

/**
 * `min(max_staleness_ms, ms_to_sales_cutoff, 30000)` over a page.
 *
 * An empty page still carries a ttl: the answer *"there is nothing here"* has
 * the same shelf life as the answer that lists something, because a screening
 * can be published in the next thirty seconds.
 */
export function pageTtlMs(occasions: readonly FreshnessInput[], now: Rfc3339): DurationMs {
  let ttl = FRESHNESS_CEILING_MS;
  for (const occasion of occasions) {
    const staleness = occasion.max_staleness_ms;
    if (typeof staleness === "number" && Number.isFinite(staleness)) {
      ttl = Math.min(ttl, Math.max(0, Math.floor(staleness)));
    }
    const cutoff = msToCutoff(occasion.sales_cutoff_at, now);
    if (cutoff !== null) ttl = Math.min(ttl, cutoff);
  }
  return ttl;
}

export function cacheable(occasions: readonly FreshnessInput[], now: Rfc3339): CacheableResult {
  return { ttlMs: pageTtlMs(occasions, now), cacheScope: CACHE_SCOPE };
}

/** Pull the two freshness terms out of a published Occasion document. */
export function freshnessOf(document: unknown): FreshnessInput {
  if (typeof document !== "object" || document === null) return {};
  const record = document as Record<string, unknown>;
  const availability = record.availability as Record<string, unknown> | undefined;
  const instant = record.instant as Record<string, unknown> | undefined;
  const max_staleness_ms = availability?.max_staleness_ms;
  const sales_cutoff_at = instant?.sales_cutoff_at;
  return {
    max_staleness_ms: typeof max_staleness_ms === "number" ? max_staleness_ms : null,
    sales_cutoff_at: typeof sales_cutoff_at === "string" ? sales_cutoff_at : null,
  };
}
