// The floor measurement. Owner: ADAPT-001.
//
// > **A Server MUST NOT grant a floor it has not measured**; where no
// > measurement exists the refusal is `503 floor_unavailable`. An operator who
// > sets 180000 because a worked example does, above an order whose configured
// > expiry is 120 seconds with an eager reaper, emits a lie with a MUST NOT
// > beside it.  — SPEC.md §7
//
// This module is that sentence, executed. It grants real Holds against the real
// store, watches the seats for the whole of the floor it asked for, and returns
// what it actually saw — `min_observed_retention_ms`, `violations`, and the
// window the observation was taken in. The published ceiling is then
// `min_observed_retention_ms − safety_margin_ms` and never a number above it.
//
// **Why the authoritative adapter measures at all.** Profile 1 owns its store:
// `hold_seat_occupied` makes oversell unrepresentable, so the honest expectation
// is zero violations, every run. That is exactly why it is worth measuring here
// — `floor_evidence` is a REQUIRED member of `capability.schema.json`, so an
// adapter that skips it does not validate, and if the adapter at the top of the
// honesty ladder were exempt then measurement would read as a penalty imposed on
// shims rather than as the price of publishing a warranty. It also catches the
// one thing an index cannot: a reaper, a sweeper or an operator process that
// takes a seat back before the floor it promised.
//
// **What is measured is retention, not expiry.** The trial closes on a probe at
// or after `floor_deadline` that still finds the seat occupied by the Hold that
// was granted it. Retention is the elapsed time to THAT observation — a number
// the clock produced, not the number the request asked for. A trial whose seat
// stops being occupied before its `floor_deadline` is a violation, and at
// `floor_basis: owned_store` one violation is a hard fail (§7 C-FLOOR).

import type { Db } from "@changeover/store/db.ts";
import type { OccasionSeed } from "@changeover/store/fixtures.ts";
import { availableSeatIds, seedEstate } from "@changeover/store/fixtures.ts";
import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";
import {
  HOLD_SCHEMA_MIN_FLOOR_MS,
  atOrAfter,
  elapsedMs,
  serverTime,
} from "@changeover/core/clock.ts";
import { HOLD_COLUMNS, deriveState, occupiesSeat } from "@changeover/core/derived.ts";
import type { HoldRow } from "@changeover/core/derived.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import { releaseHold } from "@changeover/core/release.ts";
import { measurementHouse } from "./estate.ts";
import type { FloorEvidence } from "./adapter.ts";

/* ── 1 · What a measurement is ─────────────────────────────────────────────── */

export interface RetentionTrial {
  readonly hold_id: string;
  readonly seat_id: string;
  readonly granted_at: Rfc3339;
  readonly floor_deadline: Rfc3339;
  /** The floor the Server actually granted, which may be below the one requested. */
  readonly floor_ms: DurationMs;
  /** Elapsed ms from `granted_at` to the last probe that found the seat still held. */
  readonly observed_retention_ms: DurationMs;
  readonly probes: number;
  /** The seat stopped being this Hold's before `floor_deadline`. */
  readonly violated: boolean;
}

export interface RetentionMeasurement {
  readonly evidence: FloorEvidence;
  /**
   * `min_observed_retention_ms − safety_margin_ms`, floored at zero. The
   * largest floor this measurement warrants — and therefore the largest
   * `policy_max_floor_ms` the capability document may publish.
   */
  readonly warrantable_floor_ms: DurationMs;
  readonly trials: readonly RetentionTrial[];
}

export interface MeasureRetentionOptions {
  /** Independent Holds, on distinct seats, observed over one window. Default 5. */
  readonly trials?: number;
  /** The floor each trial requests. Must leave room for the margin above the schema minimum. */
  readonly probe_floor_ms?: DurationMs;
  /** How often the seats are looked at. Default 100ms. */
  readonly probe_interval_ms?: DurationMs;
  /** Subtracted from the minimum observed retention to get the warrantable floor. */
  readonly safety_margin_ms?: DurationMs;
  /** An already-seeded house to measure against. Omitted, one is seeded. */
  readonly occasion?: OccasionSeed;
  readonly agent_id?: string;
  /** Refuse to return an unusable measurement rather than publish one. Default true. */
  readonly require_warrantable?: boolean;
}

/** A measurement that cannot warrant any floor a Hold document would accept. */
export class FloorNotWarranted extends Error {
  readonly evidence: FloorEvidence;
  readonly warrantable_floor_ms: DurationMs;
  constructor(evidence: FloorEvidence, warrantable_floor_ms: DurationMs, message: string) {
    super(message);
    this.name = "FloorNotWarranted";
    this.evidence = evidence;
    this.warrantable_floor_ms = warrantable_floor_ms;
  }
}

export const DEFAULT_TRIALS = 5;
/**
 * The floor each trial asks for. 3000ms, not 1200ms, and the reason is the
 * closing observation: a probe cadence of 100ms means the last instant at which
 * a seat was SEEN held is up to one cadence below the deadline, so the observed
 * retention is a lower bound and the warrantable floor is one cadence tighter
 * again. At 3000ms that leaves ~2350ms of warrantable floor above the 1000ms
 * `hold.schema.json` minimum — headroom enough that a slow machine produces a
 * smaller number rather than an intermittent FloorNotWarranted.
 */
export const DEFAULT_PROBE_FLOOR_MS: DurationMs = 3000;
export const DEFAULT_PROBE_INTERVAL_MS: DurationMs = 100;
export const DEFAULT_SAFETY_MARGIN_MS: DurationMs = 500;

/* ── 2 · The arithmetic §7 states, in one place ────────────────────────────── */

/**
 * `floor_ms MUST NOT exceed min_observed_retention_ms − safety_margin_ms`.
 *
 * A function rather than an inline subtraction at each site, because there are
 * three of them — the measurement, the capability builder and the proof — and
 * three spellings of one inequality is two chances for it to be spelled `+`.
 */
export function warrantableFloorMs(evidence: FloorEvidence): DurationMs {
  if (evidence.observations <= 0) return 0;
  return Math.max(0, evidence.min_observed_retention_ms - evidence.safety_margin_ms);
}

/** True where a published floor is inside what the evidence warrants. */
export function floorIsWarranted(floor_ms: DurationMs, evidence: FloorEvidence): boolean {
  return evidence.observations > 0 && floor_ms <= warrantableFloorMs(evidence);
}

/* ── 3 · The measurement ───────────────────────────────────────────────────── */

interface OpenTrial {
  hold_id: string;
  seat_id: string;
  showtime_id: string;
  granted_at: Rfc3339;
  floor_deadline: Rfc3339;
  floor_ms: DurationMs;
  principal_scope: string;
  last_held_at: Rfc3339;
  probes: number;
  violated: boolean;
  closed: boolean;
}

/**
 * Grant, watch, and report what the store actually did.
 *
 * The trials run in ONE window rather than one after another: `trials` Holds on
 * distinct seats are granted, then every one of them is probed on the same
 * cadence until its floor deadline passes. Five observations therefore cost one
 * floor's worth of wall clock rather than five, and — more to the point — they
 * are five observations of the same interval of the store's life, which is what
 * a retention window is supposed to be.
 */
export async function measureRetention(
  db: Db,
  options: MeasureRetentionOptions = {},
): Promise<RetentionMeasurement> {
  const trials = Math.max(1, Math.trunc(options.trials ?? DEFAULT_TRIALS));
  const probe_floor_ms = options.probe_floor_ms ?? DEFAULT_PROBE_FLOOR_MS;
  const probe_interval_ms = options.probe_interval_ms ?? DEFAULT_PROBE_INTERVAL_MS;
  const safety_margin_ms = options.safety_margin_ms ?? DEFAULT_SAFETY_MARGIN_MS;
  const agent_id = options.agent_id ?? "agt_reference_floor_probe";
  const require_warrantable = options.require_warrantable ?? true;

  const window_start = await serverTime(db);

  let occasion = options.occasion;
  if (occasion === undefined) {
    const house = measurementHouse(window_start, { capacity: Math.max(10, trials * 2) });
    await seedEstate(db, house.estate);
    occasion = house.occasion;
  }

  const seat_ids = availableSeatIds(occasion, trials);
  if (seat_ids.length < trials) {
    throw new Error(
      `adapter-reference: the measurement house offers ${seat_ids.length} available seats, ${trials} were asked for`,
    );
  }

  // Phase one — grant. Each trial carries its own principal_scope: X2's cluster
  // ceiling and X1's per-showtime ceiling are real limits, and a measurement
  // that tripped one would be measuring the ceiling instead of the floor.
  const open: OpenTrial[] = [];
  for (let i = 0; i < trials; i++) {
    const seat_id = seat_ids[i] as string;
    const principal_scope = `prn_floor_probe_${i}`;
    const hold = await holdSeats(
      db,
      {
        occasion_id: occasion.occasion_id,
        occasion_etag: occasion.etag,
        sought: { occasion_id: occasion.occasion_id, occasion_etag: occasion.etag },
        seats: [seat_id],
        requested_floor_ms: probe_floor_ms,
      },
      { agent_id, principal_scope },
    );
    open.push({
      hold_id: hold.hold_id,
      seat_id,
      showtime_id: occasion.showtime_id,
      granted_at: hold.granted_at,
      floor_deadline: hold.floor_deadline,
      floor_ms: hold.floor_ms,
      principal_scope,
      last_held_at: hold.granted_at,
      probes: 0,
      violated: false,
      closed: false,
    });
  }

  // Phase two — watch. One clock read per probe pass, and every trial is judged
  // against that one instant (K4).
  while (open.some((t) => !t.closed)) {
    await sleep(probe_interval_ms);
    const now = await serverTime(db);
    for (const trial of open) {
      if (trial.closed) continue;
      trial.probes++;
      const held = await seatStillHeld(db, trial, now);
      if (held) {
        trial.last_held_at = now;
        // Where `expires_at` is exactly `floor_deadline` — this Server's
        // default (T2) — this branch never fires: the Hold has already stopped
        // occupying by the time a probe lands past the deadline, and the trial
        // closes below as retention-satisfied-and-ended. It fires for a
        // deployment that grants a soft expiry above its floor.
        // The closing probe is the first one at or after the deadline that
        // still finds the seat held. Retention is measured to THIS instant.
        if (atOrAfter(trial.floor_deadline, now)) trial.closed = true;
      } else {
        // Lost the seat. Before its own floor deadline, that is a violation of
        // the warranty; at or after it, it is the Hold ending as promised.
        if (!atOrAfter(trial.floor_deadline, now)) trial.violated = true;
        trial.closed = true;
      }
    }
  }

  const window_end = await serverTime(db);

  // Phase three — give the seats back. A measurement that left forty Holds
  // standing would make the next measurement a measurement of contention.
  for (const trial of open) {
    try {
      await releaseHold(db, trial.hold_id, { agent_id, principal_scope: trial.principal_scope });
    } catch {
      // A trial that already lost its seat cannot release it, and the failure
      // to clean up is not itself evidence about the floor.
    }
  }

  const finished: RetentionTrial[] = open.map((t) => ({
    hold_id: t.hold_id,
    seat_id: t.seat_id,
    granted_at: t.granted_at,
    floor_deadline: t.floor_deadline,
    floor_ms: t.floor_ms,
    observed_retention_ms: Math.max(0, elapsedMs(t.granted_at, t.last_held_at)),
    probes: t.probes,
    violated: t.violated,
  }));

  const evidence: FloorEvidence = {
    observations: finished.length,
    window_start,
    window_end,
    min_observed_retention_ms: minRetentionMs(finished),
    safety_margin_ms,
    violations: finished.filter((t) => t.violated).length,
  };
  const warrantable_floor_ms = warrantableFloorMs(evidence);

  if (require_warrantable && warrantable_floor_ms < HOLD_SCHEMA_MIN_FLOOR_MS) {
    throw new FloorNotWarranted(
      evidence,
      warrantable_floor_ms,
      `this measurement warrants ${warrantable_floor_ms}ms, below the ${HOLD_SCHEMA_MIN_FLOOR_MS}ms floor ` +
        "hold.schema.json requires; probe for longer, or publish no floor and refuse 503 floor_unavailable",
    );
  }

  return { evidence, warrantable_floor_ms, trials: finished };
}

/* ── 4 · The probe ─────────────────────────────────────────────────────────── */

/**
 * Is this seat still occupied **by this Hold**, at this instant?
 *
 * Two conditions, and both are load-bearing. The `hold_seat` row must still be
 * there — a reap deletes it — and the Hold's derived state must still be one
 * that occupies a seat (M1: `live`, `handed_off`, `claimed`). Checking only the
 * row would call an expired-but-unreaped Hold retention, which is precisely the
 * lie the measurement exists to catch; checking only the state would miss a
 * reaper that took the row while the Hold still looked live.
 */
async function seatStillHeld(db: Db, trial: OpenTrial, now: Rfc3339): Promise<boolean> {
  return db.transaction(
    async (tx) => {
      const seat = await tx.query<{ n: string }>(
        "select count(*)::text as n from hold_seat where hold_id = $1 and seat_id = $2",
        [trial.hold_id, trial.seat_id],
      );
      if (Number(seat.rows[0]?.n ?? 0) === 0) return false;
      const hold = await tx.query<HoldRow>(`select ${HOLD_COLUMNS} from hold where hold_id = $1`, [
        trial.hold_id,
      ]);
      const row = hold.rows[0];
      if (row === undefined) return false;
      return occupiesSeat(deriveState(row, now));
    },
    { readOnly: true },
  );
}

/** Zero observations warrant zero, and `Math.min()` of nothing is `Infinity`. */
function minRetentionMs(trials: readonly RetentionTrial[]): DurationMs {
  if (trials.length === 0) return 0;
  return trials.reduce((min, t) => Math.min(min, t.observed_retention_ms), trials[0]!.observed_retention_ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
