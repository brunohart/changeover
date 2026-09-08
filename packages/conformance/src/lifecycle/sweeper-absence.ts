/**
 * The sweeper is not running, and this is how that is *observed* rather than
 * configured.
 *
 * Owner: TEST-003 (C-ORPHAN).
 *
 * §4.8: *"Seats remain held until `expires_at` … and are reclaimed by the **next
 * contending transaction**, not a background process … A sweeper **MAY** exist
 * as an optimisation; **correctness MUST NOT rest on it.**"*
 *
 * A test that set `sweeper: false` in a config and then asserted the reclaim
 * would prove nothing at all. It would record what an operator intended, and if
 * a sweeper were quietly running anyway the assertion would pass **for the wrong
 * reason** — the seats would come back, the test would go green, and the actual
 * claim, that lazy reap under L1 is sufficient on its own, would never have been
 * tested once. That is the defect class this repository has already been bitten
 * by twice, and it is green both times.
 *
 * So the absence is established four independent ways, and every one of them is
 * a measurement:
 *
 *  1. **A call count.** {@link Counted} wraps the `Db` seam itself and records
 *     every statement. Across the whole observation window this process issues
 *     zero statements that could free a seat, a slot or a cluster row.
 *  2. **A pid check.** The client that took the Hold was `SIGKILL`ed; its pid no
 *     longer exists, so nothing runs on its behalf. Asserted with
 *     `process.kill(pid, 0)`, which raises `ESRCH` for a pid that is gone.
 *  3. **A backend census.** Every connection to the database is named by
 *     `application_name` (`PGAPPNAME`), so the store itself is asked whether any
 *     backend other than this process's own pool exists, and whether any backend
 *     is executing a statement that frees occupancy. A daemon with a connection
 *     cannot hide from `pg_stat_activity`.
 *  4. **The store, repeatedly.** The strongest of the four, and the one that
 *     needs no cooperation from anybody: an expired Hold's rows are counted
 *     again and again across the window and do not move. Anything at all that
 *     swept — in this process, in another, in the database, on a trigger — would
 *     show up here as a count that fell. It did not fall, so nothing swept.
 *
 * (4) is what makes (1)–(3) more than housekeeping: a sweeper this harness had
 * never heard of would still have to make a row disappear, and rows are counted.
 */

import type { Queryable } from "@changeover/store/db.ts";
import type { Counted } from "./bench.ts";
import { RECLAIMS, occupancyOf, sleep } from "./bench.ts";
import type { Occupancy } from "./bench.ts";

export interface BackendRow extends Record<string, unknown> {
  readonly pid: number;
  readonly application_name: string | null;
  readonly state: string | null;
  readonly query: string | null;
}

export interface SweeperAbsence {
  /** How long the orphan was left entirely alone, in milliseconds. */
  readonly window_ms: number;
  readonly polls: number;
  /** 1 — statements this process issued that could have freed occupancy. */
  readonly reclaim_statements: readonly string[];
  /** 2 — pids `process.kill(pid, 0)` reported gone, and any that answered. */
  readonly dead_pids: readonly number[];
  readonly living_pids: readonly number[];
  /** 1b — scheduled work in this process at the instant the window opened. */
  readonly scheduled_resources: readonly string[];
  /** 3 — backends seen that are neither this process's pool nor the dead client. */
  readonly foreign_backends: readonly BackendRow[];
  /** 3b — backends caught mid-reclaim, whoever they belong to. */
  readonly reclaiming_backends: readonly BackendRow[];
  readonly census_available: boolean;
  /** 4 — the orphan's occupancy at every poll, oldest first. */
  readonly occupancy: readonly Occupancy[];
  /** True where every poll saw the same occupancy as the first. */
  readonly unchanged: boolean;
  /** True where the orphan was already past `expires_at` at the first poll. */
  readonly expired_throughout: boolean;
}

export interface ObserveOptions {
  readonly hold_id: string;
  /** Total time to leave the orphan alone. */
  readonly window_ms: number;
  readonly polls: number;
  /** Pids that were `SIGKILL`ed and must be gone. */
  readonly killed_pids: readonly number[];
  /** `application_name`s belonging to this harness, so a census can exclude them. */
  readonly own_application_names: readonly string[];
}

/**
 * A pid that is gone, checked the way the operating system answers it.
 *
 * `process.kill(pid, 0)` sends no signal; it asks whether the pid is
 * addressable. `ESRCH` is *no such process* and is the only answer that proves
 * absence — `EPERM` means the process exists and belongs to somebody else, which
 * is emphatically not what this needs to establish.
 */
export function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Every backend in this database, or `null` where the substrate will not say. */
export async function census(q: Queryable): Promise<BackendRow[] | null> {
  try {
    const r = await q.query<BackendRow>(
      `select pid, application_name, state, query
         from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()`,
    );
    return [...r.rows];
  } catch {
    return null;
  }
}

/**
 * Leave the orphan strictly alone for `window_ms`, watching everything that
 * could disturb it, and report what was observed.
 *
 * Nothing here writes. The counter is cleared at the top so that the count
 * reported is the count for **this window** and not for the setup that preceded
 * it — a count over the whole run would include the grant's own statements and
 * would be a number about the fixture rather than about the window.
 */
export async function observeSweeperAbsence(
  q: Queryable,
  counter: Counted,
  options: ObserveOptions,
): Promise<SweeperAbsence> {
  counter.clear();

  // Sampled here, before this function creates a single timer of its own, so a
  // `Timeout` in the list is somebody else's scheduled work and not the sleep on
  // the next line.
  const scheduled_resources = process
    .getActiveResourcesInfo()
    .filter((name) => name === "Timeout" || name === "Immediate");

  const occupancy: Occupancy[] = [];
  const foreign: BackendRow[] = [];
  const reclaiming: BackendRow[] = [];
  let census_available = false;
  const own = new Set(options.own_application_names);

  const interval = Math.max(1, Math.floor(options.window_ms / Math.max(1, options.polls)));
  let expired_throughout = true;

  for (let i = 0; i < options.polls; i++) {
    await sleep(interval);
    occupancy.push(await occupancyOf(q, options.hold_id));

    const expired = await q.query<{ past: boolean }>(
      "select (expires_at <= clock_timestamp()) as past from hold where hold_id = $1",
      [options.hold_id],
    );
    if (expired.rows[0]?.past !== true) expired_throughout = false;

    const backends = await census(q);
    if (backends !== null) {
      census_available = true;
      for (const row of backends) {
        const name = row.application_name ?? "";
        if (!own.has(name)) foreign.push(row);
        if (typeof row.query === "string" && RECLAIMS.test(row.query)) reclaiming.push(row);
      }
    }
  }

  const first = occupancy[0];
  const unchanged =
    first !== undefined &&
    occupancy.every(
      (o) =>
        o.seat_rows === first.seat_rows &&
        o.occupying_seat_rows === first.occupying_seat_rows &&
        o.slot_rows === first.slot_rows &&
        o.cluster_rows === first.cluster_rows,
    );

  const dead_pids: number[] = [];
  const living_pids: number[] = [];
  for (const pid of options.killed_pids) (pidIsGone(pid) ? dead_pids : living_pids).push(pid);

  return {
    window_ms: interval * options.polls,
    polls: options.polls,
    // The counter watches the seam every statement in this package goes through,
    // so "the SELECTs above are not reclaims" is asserted rather than assumed.
    reclaim_statements: counter.reclaims(),
    dead_pids,
    living_pids,
    scheduled_resources,
    foreign_backends: foreign,
    reclaiming_backends: reclaiming,
    census_available,
    occupancy,
    unchanged,
    expired_throughout,
  };
}
