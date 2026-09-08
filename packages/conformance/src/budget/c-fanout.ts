/**
 * **C-FANOUT** — one live Hold per demand cluster per principal, and *not* per
 * platform.
 *
 * Owner: TEST-002. §7: *"two concurrent same-cluster holds for one principal →
 * exactly one; two principals on one platform → both."* The second half is the
 * assertion that matters most and is the easiest to leave out, because a server
 * that refuses everything passes the first half perfectly. §4.7 names the bug it
 * guards against in as many words: the draft scoped these limits to `agent_id`,
 * *"an entire agent platform serving millions"*, so that *"while one Wellington
 * household holds the Friday 35mm, every other customer of that platform
 * anywhere is refused the same film that week."*
 *
 * X2's own qualification is the third scenario here: *"Two purchases in one
 * cluster by one household are legitimate and are not fan-out — Friday night for
 * the couple and the Sunday matinee for the grandparents is a normal
 * transaction."* A ceiling that counted Holds rather than **occupying** Holds
 * would refuse the grandparents, and it would do so silently, forever, off one
 * abandoned hold. That is M3, and it is why the count reads derived state.
 */

import type { ClassOutcome, Check, Observation } from "./observed.ts";
import { verdictOf } from "./observed.ts";
import type { PublishedTable } from "./published.ts";
import { statedAs } from "./published.ts";
import type { Attempt, Bench } from "./estate.ts";
import {
  CLUSTER,
  attempt,
  deadlocks,
  detailLimit,
  faults,
  freshHolds,
  grants,
  holdRows,
  household,
  liveHoldsInCluster,
  refusals,
  release,
} from "./estate.ts";

export const C_FANOUT = {
  class_id: "C-FANOUT",
  asserts:
    "one live Hold per (origin, cluster) per PRINCIPAL at the published default, " +
    "two principals of one platform unaffected by each other, and a hold that stopped occupying stops counting",
} as const;

const assert = (condition: boolean, whenHeld: string, whenNot: string): Check =>
  condition ? { held: true, statement: whenHeld } : { held: false, statement: whenNot };

function refusedWith(outcome: Attempt | undefined): string {
  if (outcome === undefined || outcome.kind !== "refusal") return "—";
  const limit = detailLimit(outcome);
  return `${outcome.code} (limit ${limit === null ? "absent" : String(limit)})`;
}

/** `conflicting_hold_id` and `cluster` — what makes `release_conflicting_hold` actionable. */
function namesConflict(outcome: Attempt | undefined): boolean {
  if (outcome === undefined || outcome.kind !== "refusal") return false;
  const detail = outcome.detail;
  if (detail === null || typeof detail !== "object") return false;
  const record = detail as Record<string, unknown>;
  return typeof record.conflicting_hold_id === "string" && record.cluster === CLUSTER;
}

export async function sequential(bench: Bench, table: PublishedTable): Promise<ClassOutcome> {
  const checks: Check[] = [];
  const observations: Observation[] = [];
  const max = bench.policy.max_live_holds_per_cluster;
  let trials = 0;

  /* 1 · X2 · one principal, two Occasions of one cluster. */
  {
    await freshHolds(bench.db);
    const who = household("cluster_seq");
    const friday = await attempt(bench, "occ_fri", ["A:1"], who);
    const sunday = await attempt(bench, "occ_sat", ["A:1"], who);
    trials += 2;
    const observed = await liveHoldsInCluster(bench.db, who);

    checks.push(
      assert(
        friday.kind === "grant" && sunday.kind === "refusal" && sunday.code === "cluster_fanout" && observed === max,
        `X2 · at the published max_live_holds_per_cluster=${max}, one principal holds exactly ${observed} Occasion of the cluster and the second is 429 cluster_fanout`,
        `X2 · friday ${friday.kind}, sunday ${refusedWith(sunday)}, ${observed} live in the cluster against a published ${max}`,
      ),
    );
    checks.push(
      assert(
        detailLimit(sunday) === max,
        `X2 · the refusal names limit ${max} — the caller is told the published number rather than left to infer it`,
        `X2 · the refusal named limit ${String(detailLimit(sunday))}, published ${max}`,
      ),
    );
    checks.push(
      assert(
        namesConflict(sunday),
        "X2 · the refusal names the conflicting hold and the cluster, so release_conflicting_hold is a remediation the caller can actually perform",
        "X2 · the refusal named no conflicting hold, so the remediation is not actionable",
      ),
    );
    checks.push(
      assert(
        (await holdRows(bench.db)) === 1,
        "X2 · exactly one hold row exists — the refused grant did not commit",
        `X2 · ${await holdRows(bench.db)} hold rows exist, expected 1`,
      ),
    );

    observations.push({
      rule: "X2",
      member: "max_live_holds_per_cluster",
      published: `${statedAs(table, "max_live_holds_per_cluster")} (= ${max})`,
      observed: `${observed} live holds in the cluster`,
      refused_with: refusedWith(sunday),
      concurrent: false,
      counting: `live Holds one principal carries in one (origin, cluster), by the publisher's label via the hold_cluster_live index`,
    });
  }

  /* 2 · X0 · two households of one platform, in the same cluster. */
  {
    await freshHolds(bench.db);
    const wellington = household("household_a_seq");
    const auckland = household("household_b_seq");
    const first = await attempt(bench, "occ_fri", ["A:1"], wellington);
    const second = await attempt(bench, "occ_sat", ["A:1"], auckland);
    trials += 2;
    const mine = await liveHoldsInCluster(bench.db, wellington);
    const theirs = await liveHoldsInCluster(bench.db, auckland);

    checks.push(
      assert(
        first.kind === "grant" && second.kind === "grant",
        "X0 · two DIFFERENT customers of one agent platform both hold inside the same cluster — the ceiling is per customer session, not per platform",
        `X0 · wellington ${first.kind === "grant" ? "granted" : refusedWith(first)}, auckland ${second.kind === "grant" ? "granted" : refusedWith(second)}`,
      ),
    );
    checks.push(
      assert(
        mine === max && theirs === max && (await holdRows(bench.db)) === 2,
        `X0 · each principal carries ${max} live hold in the cluster and the store carries two — one Wellington household cannot lock out every other customer of that platform`,
        `X0 · ${mine} and ${theirs} live holds under two principal scopes, ${await holdRows(bench.db)} rows`,
      ),
    );

    observations.push({
      rule: "X0",
      member: "max_live_holds_per_cluster",
      published: `${statedAs(table, "max_live_holds_per_cluster")} per (agent_id, principal_scope)`,
      observed: `${mine} + ${theirs} live holds, 2 principals`,
      refused_with: "—",
      concurrent: false,
      counting: "the same cluster ceiling applied to two customer sessions of one agent platform",
    });
  }

  /* 3 · X2 · a Hold that stopped occupying stops counting. M3. */
  {
    await freshHolds(bench.db);
    const who = household("grandparents_seq");
    const couple = await attempt(bench, "occ_fri", ["A:1"], who);
    trials++;
    if (couple.kind === "grant") await release(bench, couple.hold.hold_id, who);
    const matinee = await attempt(bench, "occ_sat", ["A:1"], who);
    trials++;
    const observed = await liveHoldsInCluster(bench.db, who);

    checks.push(
      assert(
        matinee.kind === "grant" && observed === max,
        "X2 · a Hold that is no longer occupying stops counting against the cluster — Friday night for the couple and the Sunday matinee for the grandparents is a normal transaction, not fan-out",
        `X2 · the second purchase in the cluster was ${matinee.kind === "grant" ? "granted" : refusedWith(matinee)}, ${observed} live`,
      ),
    );
    checks.push(
      assert(
        bench.policy.revocation_voids_holds === true,
        "§2.5 · the count reads derived state and the policy publishing that is the same document these ceilings are read from",
        "§2.5 · the published document disagrees with itself about what voids a hold",
      ),
    );
  }

  return { class_id: C_FANOUT.class_id, verdict: verdictOf(checks), checks, observations, trials };
}

/**
 * The half §4.6 says a sequential run cannot reach.
 *
 * *"At READ COMMITTED two `hold_seats` three milliseconds apart both count zero
 * live holds in a cluster, both pass, both commit — so X2 failed to two
 * concurrent requests."* The labelled half of X2 is carried by the
 * `hold_cluster_live` partial unique index, so the loser here should be a `23505`
 * translated into `cluster_fanout` and never a raw fault.
 */
export async function concurrent(bench: Bench, table: PublishedTable): Promise<ClassOutcome> {
  const checks: Check[] = [];
  const observations: Observation[] = [];
  const max = bench.policy.max_live_holds_per_cluster;
  let trials = 0;

  /* 1 · X2 · two SIMULTANEOUS same-cluster holds for one principal. */
  {
    await freshHolds(bench.db);
    const who = household("cluster_race");
    const outcomes = await Promise.all([
      attempt(bench, "occ_fri", ["A:1"], who),
      attempt(bench, "occ_sat", ["A:1"], who),
    ]);
    trials += 2;
    const observed = await liveHoldsInCluster(bench.db, who);

    checks.push(
      assert(
        grants(outcomes) === max && refusals(outcomes, "cluster_fanout") === 1,
        `X2 · two SIMULTANEOUS same-cluster holds for one principal are exactly ${max} grant and one 429 cluster_fanout`,
        `X2 · ${grants(outcomes)} grants and ${refusals(outcomes, "cluster_fanout")} cluster_fanouts — both counted zero and both committed`,
      ),
    );
    checks.push(
      assert(
        observed === max && (await holdRows(bench.db)) === max,
        `X2 · exactly ${max} hold row survived the race`,
        `X2 · ${observed} live in the cluster and ${await holdRows(bench.db)} rows in the store`,
      ),
    );
    checks.push(
      assert(
        faults(outcomes).length === 0,
        "X2 · the loser received cluster_fanout and not a raw 23505 — the index did the work and the boundary translated it",
        `X2 · faults: ${faults(outcomes).map((f) => `${f.sqlstate ?? "?"} ${f.message}`).join(" | ")}`,
      ),
    );

    observations.push({
      rule: "X2",
      member: "max_live_holds_per_cluster",
      published: `${statedAs(table, "max_live_holds_per_cluster")} (= ${max})`,
      observed: `${observed} live holds from 2 simultaneous callers`,
      refused_with: refusedWith(outcomes.find((o) => o.kind === "refusal")),
      concurrent: true,
      counting: "live Holds one principal carries in one (origin, cluster), under the hold_cluster_live partial unique index",
    });
  }

  /* 2 · X0 · two principals, simultaneously, both granted. */
  {
    await freshHolds(bench.db);
    const wellington = household("household_a_race");
    const auckland = household("household_b_race");
    const outcomes = await Promise.all([
      attempt(bench, "occ_fri", ["A:1"], wellington),
      attempt(bench, "occ_sat", ["A:2"], auckland),
    ]);
    trials += 2;
    const mine = await liveHoldsInCluster(bench.db, wellington);
    const theirs = await liveHoldsInCluster(bench.db, auckland);

    checks.push(
      assert(
        grants(outcomes) === 2 && mine === max && theirs === max,
        "X0 · two DIFFERENT principals hold in one cluster SIMULTANEOUSLY — the cluster lock is scoped to the customer session and two of them do not collide",
        `X0 · ${grants(outcomes)} grants, ${mine} and ${theirs} live holds; faults: ${faults(outcomes).map((f) => f.sqlstate ?? "?").join(", ")}`,
      ),
    );
    checks.push(
      assert(
        deadlocks(outcomes) === 0 && faults(outcomes).length === 0,
        "X0 · neither principal faulted or deadlocked against the other",
        `X0 · ${deadlocks(outcomes)} deadlocks, ${faults(outcomes).length} faults`,
      ),
    );

    observations.push({
      rule: "X0",
      member: "max_live_holds_per_cluster",
      published: `${statedAs(table, "max_live_holds_per_cluster")} per (agent_id, principal_scope)`,
      observed: `${mine} + ${theirs} live holds, 2 simultaneous principals`,
      refused_with: "—",
      concurrent: true,
      counting: "the same cluster ceiling applied to two customer sessions racing on one agent platform",
    });
  }

  return { class_id: C_FANOUT.class_id, verdict: verdictOf(checks), checks, observations, trials };
}
