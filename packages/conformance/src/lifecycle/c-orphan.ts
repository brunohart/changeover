/**
 * **C-ORPHAN** — with the sweeper demonstrably not running and the client
 * `SIGKILL`ed, seats *and budgets* return via the next contending transaction; a
 * two-seat hold contended on one seat leaves zero rows.
 *
 * Owner: TEST-003.
 *
 * §4.8: *"No release arrives — `SIGKILL`, a crash, a partition, a model that
 * gave up. Seats remain held until `expires_at`, never earlier than
 * `floor_deadline`, and are reclaimed by the **next contending transaction**,
 * not a background process; derived state (M1) means the budgets return with
 * them. A sweeper **MAY** exist as an optimisation; **correctness MUST NOT rest
 * on it.** This is the direct, testable answer to 'may take a few minutes.'"*
 *
 * Three scenarios, because "budgets" is not one table.
 *
 * | | What disappears | What returns | Through which contention |
 * |---|---|---|---|
 * | 1 | a two-seat Hold | `hold_seat` | four racers for **one** of its two seats |
 * | 2 | two Holds filling `max_live_holds_per_showtime` | `hold_slot` | a grant for **seats nobody contended** |
 * | 3 | a Hold in a cluster | `hold_cluster` | a grant elsewhere in the same cluster |
 *
 * Scenario 2 is the one worth reading twice. The reclaiming grant asks for
 * `C:1, C:2` — seats no orphan ever held and no racer ever wanted. Nothing about
 * seats can explain why it was refused before the orphans expired and granted
 * after, so the **only** thing that changed is the budget. A system that returned
 * the seat and left the slot behind would pass every seat-shaped assertion in
 * this file and still lock its own principal out of that showtime for the rest of
 * the hour, with the seat sitting visibly free — a failure nobody notices until
 * an agent has been silently capped, and one only a test that names both catches.
 *
 * **Why the racers use distinct principals in scenario 1 and one principal in
 * scenario 2.** Budgets bind before seats in G1 (step 9 before step 12), so four
 * racers sharing a principal would be refused by a ceiling before they ever
 * reached the seat they were racing for, and "exactly one won" would be a
 * statement about `hold_slot`. Isolating the property under test is what the
 * harness profile is for, and it is stated in the output rather than left to be
 * inferred.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { Queryable } from "@changeover/store/db.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import { principalBudgets, HOLD_POLICY_PUBLISHED } from "@changeover/core/budgets.ts";

import type { Check, ClassResult } from "./contract.ts";
import { assert, broke } from "./contract.ts";
import type { LifecycleBench } from "./bench.ts";
import {
  ESTATE_VANISHED,
  estateIntact,
  etagFor,
  expiredInStore,
  lifecycleBench,
  lifecycleOccasion,
  occupancyOf,
  runId,
  sleep,
} from "./bench.ts";
import { observeSweeperAbsence } from "./sweeper-absence.ts";
import type { SweeperAbsence } from "./sweeper-absence.ts";
import type { OrphanClientReady } from "./orphan-client.ts";
import { READY_PREFIX } from "./orphan-client.ts";
import { formatPercentiles, percentiles, timed } from "./latency.ts";

const CLIENT = fileURLToPath(new URL("./orphan-client.ts", import.meta.url));

export interface OrphanOptions {
  readonly run_id?: string;
  /** Racers for scenario 1. Four is enough to see a winner and three losers. */
  readonly contenders?: number;
  /** How long the orphan is left strictly alone after it expires. */
  readonly window_ms?: number;
  readonly polls?: number;
  /**
   * The floor each orphan asks for. It is also how long the harness must wait
   * before anything may reclaim, because T1 forbids the Server taking the seats
   * back before `floor_deadline` — the client being dead does not shorten it.
   */
  readonly floor_ms?: number;
  readonly latency_trials?: number;
}

const AGENT = "agt_t003orphan";

/**
 * The house, and why it is this big.
 *
 * X3's `max_held_fraction_per_showtime` is 2% of capacity and X4's
 * `max_held_seat_fraction_bp` is 5%, both floored at one seat — so a 40-seat
 * house lets this agent platform hold **one** seat at a screening, and every
 * two-seat orphan in this file is refused `seat_budget_exhausted` before it can
 * become an orphan at all. That refusal is the published policy working
 * correctly; it is the fixture that was wrong. 200 seats gives the platform 4
 * and the principal 6, which is the peak either reaches here.
 */
const HOUSE = 200;

/* ── Spawning, and killing, a client ───────────────────────────────────────── */

export interface Orphan {
  readonly ready: OrphanClientReady;
  readonly child: ChildProcess;
  readonly application_name: string;
}

interface SpawnConfig {
  readonly occasion_id: string;
  readonly seats: readonly string[];
  readonly requested_floor_ms: number;
  readonly principal_scope: string;
  readonly application_name: string;
  readonly budgets?: boolean;
}

/**
 * Start a client, wait for it to say it holds seats, and hand back the process.
 *
 * The wait is for the `READY` line and not for a timer: `holdSeats` resolves
 * after COMMIT, so a parent holding this line knows the Hold is durable and can
 * kill the child with no race against the write it is about to assert on.
 */
async function spawnOrphan(config: SpawnConfig): Promise<Orphan> {
  const child = spawn(
    process.execPath,
    [
      CLIENT,
      JSON.stringify({
        occasion_id: config.occasion_id,
        occasion_etag: etagFor(config.occasion_id),
        seats: config.seats,
        requested_floor_ms: config.requested_floor_ms,
        agent_id: AGENT,
        principal_scope: config.principal_scope,
        policy: config.budgets === false ? { max_live_holds_per_showtime: 1000 } : {},
      }),
    ],
    { env: { ...process.env, PGAPPNAME: config.application_name }, stdio: ["ignore", "pipe", "pipe"] },
  );

  return new Promise<Orphan>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const line = out.split("\n").find((l) => l.startsWith(READY_PREFIX));
      if (line !== undefined) {
        resolve({
          ready: JSON.parse(line.slice(READY_PREFIX.length)) as OrphanClientReady,
          child,
          application_name: config.application_name,
        });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      reject(new Error("orphan client exited " + code + " before holding seats: " + (err || out)));
    });
    child.on("error", reject);
  });
}

/** SIGKILL, and wait for the operating system to agree it happened. */
async function kill(orphan: Orphan): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    orphan.child.on("exit", () => resolve());
  });
  orphan.child.removeAllListeners("exit");
  orphan.child.on("exit", () => {});
  orphan.child.kill("SIGKILL");
  await Promise.race([exited, sleep(2000)]);
}

/**
 * Wait until the store itself says the Hold is past `expires_at`.
 *
 * Deliberately not `setTimeout(expires_at − Date.now())`. K4 permits one time
 * source and it is the database's; a harness that waited on the process clock
 * would be asserting against a second one, and the two disagree by however much
 * this machine's NTP is out. Under a slow shared Postgres that difference is
 * exactly the size of a flake.
 */
async function waitUntilExpired(q: Queryable, hold_id: string, ceiling_ms: number): Promise<boolean> {
  const until = Date.now() + ceiling_ms;
  for (;;) {
    if (await expiredInStore(q, hold_id)) return true;
    if (Date.now() > until) return false;
    await sleep(25);
  }
}

/* ── The class ─────────────────────────────────────────────────────────────── */

export async function cOrphan(options: OrphanOptions = {}): Promise<ClassResult> {
  const run = options.run_id ?? runId();
  const contenders = options.contenders ?? 4;
  const window_ms = options.window_ms ?? 1200;
  const polls = options.polls ?? 6;
  const floor_ms = options.floor_ms ?? 3000;
  const trials = options.latency_trials ?? 12;

  const S1 = "occ_orph_seats_" + run;
  const S2 = "occ_orph_budget_" + run;
  const S3A = "occ_orph_cluster_a_" + run;
  const S3B = "occ_orph_cluster_b_" + run;
  const S4 = "occ_orph_latency_" + run;
  const CLUSTER = "cl_orph_" + run;
  const PARENT_APP = "changeover_t003_parent_" + run;

  process.env.PGAPPNAME = PARENT_APP;

  const checks: Check[] = [];
  const notes: string[] = [
    "harness profile — agent " + AGENT + ", floor_ms " + floor_ms +
      ", scenario 1 budgets unenforced (distinct principals), scenarios 2–3 at published defaults",
  ];

  let b: LifecycleBench;
  try {
    b = await lifecycleBench(run, {
      occasions: [
        lifecycleOccasion({ occasion_id: S1, capacity: HOUSE }),
        lifecycleOccasion({ occasion_id: S2, capacity: HOUSE }),
        lifecycleOccasion({ occasion_id: S3A, capacity: HOUSE, cluster: CLUSTER }),
        lifecycleOccasion({ occasion_id: S3B, capacity: HOUSE, cluster: CLUSTER }),
        lifecycleOccasion({ occasion_id: S4, capacity: 40 }),
      ],
    });
  } catch (err) {
    return {
      id: "C-ORPHAN",
      checks: [],
      notes,
      unprovable: "the store did not answer: " + message(err),
    };
  }

  if (b.db.concurrent !== true) {
    await b.close();
    return {
      id: "C-ORPHAN",
      checks: [],
      notes,
      unprovable:
        "openDb returned the " + b.db.driver + " driver with concurrent=" + b.db.concurrent +
        "; the next contending transaction needs a second connection",
    };
  }
  checks.push(assert(true, "the store is node-postgres and reports concurrent=true", ""));

  try {
    /* ── Scenario 1 · the seats ─────────────────────────────────────────── */

    const o1 = await spawnOrphan({
      occasion_id: S1,
      seats: ["A:1", "A:2"],
      requested_floor_ms: floor_ms,
      principal_scope: "principal_orphan_" + run,
      application_name: "changeover_t003_orphan1_" + run,
      budgets: false,
    });
    notes.push("scenario 1 — client pid " + o1.ready.pid + " holds " + o1.ready.seats.join(", ") +
      " on " + S1 + " until " + o1.ready.expires_at);

    const before = await occupancyOf(b.db, o1.ready.hold_id);
    checks.push(assert(
      before.occupying_seat_rows === 2,
      "the killed-to-be client left 2 occupying hold_seat rows in the store",
      "the client's Hold occupies " + before.occupying_seat_rows + " seat rows, not 2",
    ));

    await kill(o1);
    checks.push(assert(
      pidGone(o1.ready.pid),
      "the client is gone: pid " + o1.ready.pid + " no longer exists, so nothing runs on its behalf",
      "pid " + o1.ready.pid + " still answers after SIGKILL — the client is not gone",
    ));

    // T1 before anything else: a dead client does not shorten its own floor. If
    // the seats came back here, every assertion below would be about a boundary
    // that had already broken its one warranty.
    const duringFloor = await refusalOf(() =>
      holdSeats(b.db, request(S1, ["A:1"], 60000), credential("principal_floorprobe_" + run)));
    checks.push(assert(
      duringFloor === "seat_contended",
      "T1 — inside the floor the dead client's seats are still held: a contender is refused seat_contended",
      "inside the floor a contender got " + (duringFloor ?? "a grant") + " rather than seat_contended",
    ));

    const expired = await waitUntilExpired(b.db, o1.ready.hold_id, floor_ms + 5000);
    checks.push(assert(
      expired,
      "the store's own clock now reports the orphan past expires_at",
      "the orphan was still live " + (floor_ms + 5000) + "ms after it was granted",
    ));

    const absence = await observeSweeperAbsence(b.db, b.counter, {
      hold_id: o1.ready.hold_id,
      window_ms,
      polls,
      killed_pids: [o1.ready.pid],
      own_application_names: [PARENT_APP],
    });
    checks.push(...sweeperChecks(absence));
    notes.push("scenario 1 — occupancy across the window: " +
      absence.occupancy.map((o) => o.occupying_seat_rows).join(","));

    // The contention itself: N racers, distinct principals, all asking for ONE
    // of the orphan's two seats. Started together and awaited together, on N
    // pooled connections, so the reclaim happens inside somebody's transaction
    // and not between two of them.
    const raced = await Promise.allSettled(
      Array.from({ length: contenders }, (_, i) =>
        holdSeats(b.db, request(S1, ["A:1"], 60000), credential("principal_racer" + i + "_" + run))),
    );
    const winners = raced.filter((r) => r.status === "fulfilled");
    const losers = raced.filter((r) => r.status === "rejected");
    checks.push(assert(
      winners.length === 1,
      "exactly one of " + contenders + " concurrent contenders reclaimed the orphan's seat and was granted it",
      winners.length + " of " + contenders + " contenders were granted A:1 — the reclaim oversold",
    ));
    checks.push(assert(
      losers.every((r) => isRefusal((r as PromiseRejectedResult).reason) &&
        ((r as PromiseRejectedResult).reason as { code: string }).code === "seat_contended"),
      "the other " + losers.length + " were refused seat_contended, not a fault and not a deadlock",
      "a losing contender failed with something other than seat_contended: " +
        losers.map((r) => codeOf((r as PromiseRejectedResult).reason)).join(", "),
    ));

    const after = await occupancyOf(b.db, o1.ready.hold_id);
    checks.push(assert(
      after.seat_rows === 0,
      "the two-seat Hold contended on ONE seat left ZERO rows: the reap is by hold, never by seat",
      "the orphan still has " + after.seat_rows + " hold_seat rows after one of its two seats was contended",
    ));

    const free = await holdSeats(b.db, request(S1, ["A:2"], 60000), credential("principal_second_" + run));
    checks.push(assert(
      free.seats.length === 1,
      "the orphan's OTHER seat was free to the next caller too, having come back with the first",
      "A:2 did not come back with A:1",
    ));

    /* ── Scenario 2 · the budgets ───────────────────────────────────────── */

    const P2 = "principal_budget_" + run;
    const b1 = await spawnOrphan({
      occasion_id: S2, seats: ["A:1", "A:2"], requested_floor_ms: floor_ms,
      principal_scope: P2, application_name: "changeover_t003_orphan2a_" + run,
    });
    const b2 = await spawnOrphan({
      occasion_id: S2, seats: ["B:1", "B:2"], requested_floor_ms: floor_ms,
      principal_scope: P2, application_name: "changeover_t003_orphan2b_" + run,
    });

    const slotsHeld = await slotCount(b.db, P2, S2);
    checks.push(assert(
      slotsHeld === 2,
      "the two clients filled max_live_holds_per_showtime: 2 hold_slot rows, the published ceiling",
      "the two clients hold " + slotsHeld + " hold_slot rows rather than the published ceiling of 2",
    ));

    // Seats nobody has touched. The only thing that can refuse this is a budget.
    const uncontended = () =>
      holdSeats(b.db, request(S2, ["C:1", "C:2"], 60000), credential(P2), {
        budgets: principalBudgets(HOLD_POLICY_PUBLISHED),
      });
    const exhausted = await refusalOf(uncontended);
    checks.push(assert(
      exhausted === "hold_budget_exhausted",
      "while the clients live, a grant for seats NOBODY contended is refused hold_budget_exhausted",
      "the budget was not exhausted while both Holds were live: got " + (exhausted ?? "a grant"),
    ));

    await kill(b1);
    await kill(b2);
    checks.push(assert(
      pidGone(b1.ready.pid) && pidGone(b2.ready.pid),
      "both budget-holding clients are gone: pids " + b1.ready.pid + " and " + b2.ready.pid,
      "a budget-holding client survived SIGKILL",
    ));

    await waitUntilExpired(b.db, b1.ready.hold_id, floor_ms + 5000);
    await waitUntilExpired(b.db, b2.ready.hold_id, floor_ms + 5000);
    const budgetAbsence = await observeSweeperAbsence(b.db, b.counter, {
      hold_id: b1.ready.hold_id,
      window_ms,
      polls,
      killed_pids: [b1.ready.pid, b2.ready.pid],
      own_application_names: [PARENT_APP],
    });
    checks.push(assert(
      budgetAbsence.occupancy.every((o) => o.slot_rows === 1),
      "across " + polls + " polls of the window the expired Hold's hold_slot row did not move: nothing swept the budget",
      "the orphan's hold_slot row changed with no contender: " +
        budgetAbsence.occupancy.map((o) => o.slot_rows).join(","),
    ));

    const returned = await uncontended();
    checks.push(assert(
      returned.seats.join(",") === "C:1,C:2",
      "the same grant now succeeds — the budget returned through the contending transaction, not through time",
      "the grant that only a budget could refuse still did not succeed after expiry",
    ));
    const orphanSlots = (await occupancyOf(b.db, b1.ready.hold_id)).slot_rows +
      (await occupancyOf(b.db, b2.ready.hold_id)).slot_rows;
    checks.push(assert(
      orphanSlots === 0 && (await slotCount(b.db, P2, S2)) === 1,
      "both orphaned hold_slot rows are gone and the reclaiming Hold holds the one slot in their place",
      "hold_slot did not settle: " + orphanSlots + " orphan rows remain, scope holds " +
        (await slotCount(b.db, P2, S2)),
    ));

    /* ── Scenario 3 · the cluster row ───────────────────────────────────── */

    const P3 = "principal_cluster_" + run;
    const c1 = await spawnOrphan({
      occasion_id: S3A, seats: ["A:1", "A:2"], requested_floor_ms: floor_ms,
      principal_scope: P3, application_name: "changeover_t003_orphan3_" + run,
    });
    checks.push(assert(
      (await occupancyOf(b.db, c1.ready.hold_id)).cluster_rows === 1,
      "the client's Hold occupies a hold_cluster row for " + CLUSTER,
      "the Hold in a cluster left no hold_cluster row",
    ));

    const elsewhere = () =>
      holdSeats(b.db, request(S3B, ["A:1", "A:2"], 60000), credential(P3), {
        budgets: principalBudgets(HOLD_POLICY_PUBLISHED),
      });
    const fannedOut = await refusalOf(elsewhere);
    checks.push(assert(
      fannedOut === "cluster_fanout",
      "while the client lives, a second Occasion in the same cluster is refused cluster_fanout",
      "the cluster was not held against a second Occasion: got " + (fannedOut ?? "a grant"),
    ));

    await kill(c1);
    await waitUntilExpired(b.db, c1.ready.hold_id, floor_ms + 5000);
    const clusterAbsence = await observeSweeperAbsence(b.db, b.counter, {
      hold_id: c1.ready.hold_id, window_ms, polls,
      killed_pids: [c1.ready.pid], own_application_names: [PARENT_APP],
    });
    checks.push(assert(
      clusterAbsence.occupancy.every((o) => o.cluster_rows === 1),
      "across the window the expired Hold's hold_cluster row did not move either",
      "the orphan's hold_cluster row changed with no contender: " +
        clusterAbsence.occupancy.map((o) => o.cluster_rows).join(","),
    ));

    await elsewhere();
    checks.push(assert(
      (await occupancyOf(b.db, c1.ready.hold_id)).cluster_rows === 0,
      "the contending grant in the same cluster reaped the orphan's hold_cluster row and took its place",
      "the orphan's hold_cluster row survived a contending grant in its own cluster",
    ));

    /* ── The numbers ────────────────────────────────────────────────────── */

    const latency = await reclaimLatency(b, S4, run, trials);
    notes.push(formatPercentiles("orphan reclaim latency —", latency));
    checks.push(assert(
      latency.n === trials && Number.isFinite(latency.p95),
      "orphan reclaim latency measured over " + trials + " trials and reported as p50/p95/max",
      "reclaim latency produced " + latency.n + " usable samples of " + trials,
    ));
  } catch (err) {
    // §12 first, before anything is called a defect: on a shared store another
    // process's reset takes the Occasion, and every downstream symptom then
    // looks like a boundary failure. A missing Occasion is cannot-prove; a
    // missing row under a standing Occasion is a failure.
    if (!(await estateIntact(b.db, b.estate.occasions.map((o) => o.occasion_id)))) {
      await b.close();
      return { id: "C-ORPHAN", checks: [], notes, unprovable: ESTATE_VANISHED };
    }
    checks.push(broke("the scenario did not complete: " + message(err)));
  } finally {
    await b.close();
  }

  return { id: "C-ORPHAN", checks, notes };
}

/* ── The measurement ───────────────────────────────────────────────────────── */

/**
 * How long the transaction that reclaims an orphan takes, measured end to end.
 *
 * Each trial's grant **is** the next trial's orphan: one seat pair, held at the
 * schema's minimum floor, abandoned, and then taken by the next caller. So every
 * sample but the first is a grant that had to reap before it could insert, which
 * is the number "may take a few minutes" is the industry's answer to.
 *
 * The first trial is discarded: it reclaims nothing, and a sample of a grant onto
 * free seats does not belong in a distribution about reclaiming.
 */
async function reclaimLatency(
  b: LifecycleBench,
  occasion_id: string,
  run: string,
  trials: number,
) {
  const samples: number[] = [];
  const seats = ["A:1", "A:2"];
  let previous: string | null = null;

  for (let i = 0; i <= trials; i++) {
    if (previous !== null) await waitUntilExpired(b.db, previous, 4000);
    const { value, ms } = await timed(() =>
      holdSeats(b.db, request(occasion_id, seats, 1000), credential("principal_lat" + i + "_" + run)));
    if (previous !== null) samples.push(ms);
    previous = value.hold_id;
  }

  return percentiles(samples, b.db.driver + " · reclaiming grant, floor_ms 1000, sequential");
}

/* ── Small things ──────────────────────────────────────────────────────────── */

function sweeperChecks(absence: SweeperAbsence): Check[] {
  return [
    assert(
      absence.reclaim_statements.length === 0,
      "call count — this process issued 0 statements that could free a seat, slot or cluster row across the " +
        absence.window_ms + "ms window",
      "this process issued " + absence.reclaim_statements.length + " reclaiming statements during the window",
    ),
    assert(
      absence.living_pids.length === 0,
      "pid check — every SIGKILLed client pid is gone (ESRCH), so no process is sweeping on its behalf",
      "pids still alive after SIGKILL: " + absence.living_pids.join(", "),
    ),
    assert(
      absence.scheduled_resources.length === 0,
      "no timer was scheduled in this process when the window opened: nothing here runs on a clock",
      "scheduled work found in this process: " + absence.scheduled_resources.join(", "),
    ),
    assert(
      absence.census_available && absence.reclaiming_backends.length === 0,
      "backend census — pg_stat_activity was read and NO backend was executing a statement that frees " +
        "occupancy" + (absence.foreign_backends.length === 0
          ? "; this harness held the only connections"
          : " (" + absence.foreign_backends.length + " foreign connections seen, none of them reclaiming)"),
      absence.census_available
        ? "a backend was caught mid-reclaim: " +
          absence.reclaiming_backends.map((r) => r.pid + "/" + (r.application_name ?? "?")).join(", ")
        : "pg_stat_activity could not be read, so the census proves nothing",
    ),
    assert(
      absence.expired_throughout && absence.unchanged && absence.occupancy.length === absence.polls,
      "the store itself — " + absence.polls + " polls across " + absence.window_ms +
        "ms of an EXPIRED Hold and its occupancy never moved: nothing, anywhere, swept it",
      "the expired Hold's occupancy changed with no contender in sight: " +
        absence.occupancy.map((o) => o.occupying_seat_rows + "/" + o.slot_rows).join(" "),
    ),
  ];
}

function request(occasion_id: string, seats: readonly string[], floor: number) {
  const etag = etagFor(occasion_id);
  return {
    occasion_id,
    occasion_etag: etag,
    sought: { occasion_id, occasion_etag: etag },
    seats: [...seats],
    requested_floor_ms: floor,
  };
}

function credential(principal_scope: string) {
  return { agent_id: AGENT, principal_scope };
}

async function slotCount(q: Queryable, principal_scope: string, showtime_id: string): Promise<number> {
  const r = await q.query<{ n: string }>(
    "select count(*)::text as n from hold_slot where agent_id = $1 and principal_scope = $2 and showtime_id = $3",
    [AGENT, principal_scope, showtime_id],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** The refusal code a call produced, or `null` where it was granted. */
async function refusalOf(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (err) {
    return codeOf(err);
  }
}

function codeOf(err: unknown): string {
  return isRefusal(err) ? (err as { code: string }).code : "non-refusal: " + message(err);
}

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
