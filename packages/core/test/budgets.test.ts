/**
 * X1–X5, against the store. Owner: CORE-006.
 *
 * Every assertion that involves a ceiling runs at **production defaults**
 * ({@link HOLD_POLICY_PUBLISHED}) unless it is explicitly about what a different
 * published number would do. A fan-out test at limits nobody ships is a test
 * about a configuration file.
 *
 * These are sequential. PGlite is single-connection, so the true-concurrency
 * half of the gate lives in `scripts/prove_no_fanout_concurrent.sh` and exits 2
 * without `CHANGEOVER_PG_URL` rather than pretending one connection is two.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { Db } from "@changeover/store/db.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";
import type { Candidate } from "@changeover/semantics/poset.ts";

import type { HoldDocument } from "@changeover/core/hold-seats.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import type { HoldPolicyDocument } from "@changeover/core/budgets.ts";
import {
  EXHAUSTION,
  EXHAUSTION_LIMIT_NAMES,
  HOLD_POLICY_PUBLISHED,
  PublishedPolicy,
  UnpublishedLimit,
  budgetLockKeys,
  demandCluster,
  isAntichain,
  platformSeatCeiling,
  principalBudgets,
  seatCeiling,
} from "@changeover/core/budgets.ts";

import { bench, etagFor, occasion } from "./lib/estate.ts";

const AGENT = "agt_examplebot";
const HOUSEHOLD = { agent_id: AGENT, principal_scope: "ppid_household_a" };
const NEIGHBOUR = { agent_id: AGENT, principal_scope: "ppid_household_b" };

interface Attempt {
  readonly hold?: HoldDocument;
  readonly code?: string;
  readonly detail?: Record<string, unknown>;
}

/** One `hold_seats` call at published ceilings, reported as an outcome rather than a throw. */
async function attempt(
  db: Db,
  occasion_id: string,
  seats: readonly string[],
  credential: { agent_id: string; principal_scope: string },
  policy: HoldPolicyDocument = HOLD_POLICY_PUBLISHED,
): Promise<Attempt> {
  const etag = etagFor(occasion_id);
  try {
    const hold = await holdSeats(
      db,
      {
        occasion_id,
        occasion_etag: etag,
        sought: { occasion_id, occasion_etag: etag },
        seats: [...seats],
        requested_floor_ms: 60000,
      },
      credential,
      { budgets: principalBudgets(policy) },
    );
    return { hold };
  } catch (err) {
    if (!isRefusal(err)) throw err;
    const refusal = err as { code: string; detail?: Record<string, unknown> };
    return { code: refusal.code, detail: refusal.detail };
  }
}

/** `A:1 … A:10, B:1 …` — the seat ids `seatGrid` mints, taken n at a time. */
function seatsFrom(row: string, first: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${row}:${first + i}`);
}

/* ── 1 · The table and the published document ──────────────────────────────── */

test("§2.5 · every ceiling this module enforces is a member of the published hold policy", () => {
  for (const ceiling of EXHAUSTION) {
    assert.ok(
      Object.hasOwn(HOLD_POLICY_PUBLISHED, ceiling.limit),
      `${ceiling.limit} is enforced and not published`,
    );
  }
  const enforced = new Set(EXHAUSTION.map((c) => c.limit));
  for (const name of EXHAUSTION_LIMIT_NAMES) {
    assert.ok(enforced.has(name), `${name} is published as a ceiling and nothing enforces it`);
  }
});

test("§2.5 · a limit the document does not carry cannot be read, so it cannot be enforced", () => {
  const partial = { max_live_holds_per_showtime: 2 } as unknown as HoldPolicyDocument;
  const policy = new PublishedPolicy(partial);
  assert.equal(policy.value("max_live_holds_per_showtime"), 2);
  assert.throws(() => policy.value("max_live_holds_per_site"), UnpublishedLimit);
  // An UnpublishedLimit is a server defect, not a refusal: a binding must render
  // it as a 500 rather than hand a caller a code for a limit it was never told.
  try {
    policy.value("max_holds_per_site_per_hour");
    assert.fail("expected UnpublishedLimit");
  } catch (err) {
    assert.equal(isRefusal(err), false);
  }
});

test("§2.5 · every limit consulted during a real grant is present in the published document", async () => {
  const b = await bench([occasion({ occasion_id: "occ_pub", capacity: 400 })]);
  try {
    const guard = principalBudgets();
    const etag = etagFor("occ_pub");
    await holdSeats(
      b.db,
      {
        occasion_id: "occ_pub",
        occasion_etag: etag,
        sought: { occasion_id: "occ_pub", occasion_etag: etag },
        seats: ["A:1"],
        requested_floor_ms: 60000,
      },
      HOUSEHOLD,
      { budgets: guard },
    );
    assert.ok(guard.consulted.length > 0, "the guard enforced nothing at all");
    for (const name of guard.consulted) {
      assert.ok(Object.hasOwn(HOLD_POLICY_PUBLISHED, name), `${name} was enforced and is unpublished`);
    }
  } finally {
    await b.close();
  }
});

/* ── 2 · X4's arithmetic ───────────────────────────────────────────────────── */

test("X4 · the ceiling is the min of the absolute and the proportional half, floored at one seat", () => {
  const policy = new PublishedPolicy();
  // A large house: the absolute half binds.
  assert.equal(seatCeiling(policy, 400), 6);
  // A small house: 5% of 60 is three seats, and three is what a principal gets.
  assert.equal(seatCeiling(policy, 60), 3);
  // A fraction that rounds to zero would make a house unholdable by anyone,
  // which is an outage rather than a ceiling. `seats` is minItems 1 on the wire.
  assert.equal(seatCeiling(policy, 10), 1);
  assert.equal(platformSeatCeiling(policy, 400), 8);
  assert.equal(platformSeatCeiling(policy, 10), 1);
});

/* ── 3 · X1 — max_live_holds_per_showtime, carried by a primary key ────────── */

test("X1 · max+1 sequential holds on one showtime yield exactly max, at published defaults", async () => {
  const b = await bench([occasion({ occasion_id: "occ_slots", capacity: 400 })]);
  try {
    const max = HOLD_POLICY_PUBLISHED.max_live_holds_per_showtime;
    const outcomes: Attempt[] = [];
    for (let i = 0; i < max + 1; i++) {
      outcomes.push(await attempt(b.db, "occ_slots", [`A:${i + 1}`], HOUSEHOLD));
    }

    const granted = outcomes.filter((o) => o.hold !== undefined);
    assert.equal(granted.length, max, `expected exactly ${max} grants`);
    const refused = outcomes[max];
    assert.equal(refused.code, "hold_budget_exhausted");
    assert.deepEqual(refused.detail, { limit: max, window_ms: 0 });

    // Assert against the STORE, not the response: exactly max slots are taken.
    const slots = await b.db.query<{ n: string }>("select count(*)::text as n from hold_slot");
    assert.equal(Number(slots.rows[0].n), max);
  } finally {
    await b.close();
  }
});

test("M3 · an abandoned hold stops counting when it expires, not when someone contends it", async () => {
  const b = await bench([occasion({ occasion_id: "occ_m3", capacity: 400 })]);
  try {
    const max = HOLD_POLICY_PUBLISHED.max_live_holds_per_showtime;
    for (let i = 0; i < max; i++) await attempt(b.db, "occ_m3", [`A:${i + 1}`], HOUSEHOLD);
    assert.equal((await attempt(b.db, "occ_m3", ["B:1"], HOUSEHOLD)).code, "hold_budget_exhausted");

    // Time passes. Nothing reaps, because ADR-006 has no sweeper — and the
    // budget must nonetheless stop counting these.
    await b.db.query("update hold set expires_at = now() - interval '1 second', floor_ms = 1000, " +
      "granted_at = now() - interval '2 seconds', floor_deadline = now() - interval '1 second'");

    const after = await attempt(b.db, "occ_m3", ["B:1"], HOUSEHOLD);
    assert.ok(after.hold !== undefined, `expected a grant, got ${after.code}`);
    const slots = await b.db.query<{ n: string }>("select count(*)::text as n from hold_slot");
    assert.equal(Number(slots.rows[0].n), 1, "the stale slots were not reaped by the contending grant");
  } finally {
    await b.close();
  }
});

/* ── 4 · X2 — the cluster, labelled and derived ────────────────────────────── */

test("X2 · two same-cluster holds for one principal yield exactly one grant and one cluster_fanout", async () => {
  const b = await bench([
    occasion({ occasion_id: "occ_fri", cluster: "clu_35mm_run", capacity: 400 }),
    occasion({ occasion_id: "occ_sat", cluster: "clu_35mm_run", capacity: 400 }),
  ]);
  try {
    const first = await attempt(b.db, "occ_fri", ["A:1"], HOUSEHOLD);
    const second = await attempt(b.db, "occ_sat", ["A:1"], HOUSEHOLD);

    assert.ok(first.hold !== undefined, `expected a grant, got ${first.code}`);
    assert.equal(second.code, "cluster_fanout");
    assert.equal(second.detail?.cluster, "clu_35mm_run");
    assert.equal(second.detail?.conflicting_hold_id, first.hold.hold_id);
    assert.equal(second.detail?.limit, HOLD_POLICY_PUBLISHED.max_live_holds_per_cluster);

    const holds = await b.db.query<{ n: string }>("select count(*)::text as n from hold");
    assert.equal(Number(holds.rows[0].n), 1, "the refused grant left a row behind");
  } finally {
    await b.close();
  }
});

test("X0 · two DIFFERENT principals on one platform both succeed in one cluster", async () => {
  const b = await bench([
    occasion({ occasion_id: "occ_fri2", cluster: "clu_35mm_run", capacity: 400 }),
    occasion({ occasion_id: "occ_sat2", cluster: "clu_35mm_run", capacity: 400 }),
  ]);
  try {
    // The failure this asserts against: one Wellington household holding the
    // Friday 35mm locking out every other customer of that platform anywhere.
    const household = await attempt(b.db, "occ_fri2", ["A:1"], HOUSEHOLD);
    const neighbour = await attempt(b.db, "occ_sat2", ["A:2"], NEIGHBOUR);

    assert.ok(household.hold !== undefined, `household refused: ${household.code}`);
    assert.ok(neighbour.hold !== undefined, `neighbour refused: ${neighbour.code}`);
    assert.notEqual(household.hold.hold_id, neighbour.hold.hold_id);

    const holds = await b.db.query<{ n: string }>("select count(*)::text as n from hold");
    assert.equal(Number(holds.rows[0].n), 2);
  } finally {
    await b.close();
  }
});

test("X2 · fan-out across an ATTESTED mutual substitution is refused even with no cluster label", async () => {
  // Neither Occasion carries a `cluster`, so `hold_cluster_live` never fires.
  // The publisher nonetheless attested that each is a substitute for the other,
  // and that attestation is what makes them one demand cluster.
  const mutual = (self: string, other: string) => ({
    substitution: {
      policy: "advisory",
      accepts_substitute: [{ occasion_id: other, axis: "instant" }],
    },
    occasion_id: self,
  });
  const b = await bench([
    occasion({ occasion_id: "occ_a", cluster: null, capacity: 400, document: mutual("occ_a", "occ_b") }),
    occasion({ occasion_id: "occ_b", cluster: null, capacity: 400, document: mutual("occ_b", "occ_a") }),
  ]);
  try {
    const first = await attempt(b.db, "occ_a", ["A:1"], HOUSEHOLD);
    const second = await attempt(b.db, "occ_b", ["A:1"], HOUSEHOLD);

    assert.ok(first.hold !== undefined, `expected a grant, got ${first.code}`);
    assert.equal(second.code, "cluster_fanout");
    assert.equal(second.detail?.conflicting_hold_id, first.hold.hold_id);
    // No publisher label, so the cluster is named by its C-least member.
    assert.equal(second.detail?.cluster, "occ_a");
  } finally {
    await b.close();
  }
});

test("X2 · a ONE-WAY attested edge is not a demand cluster, and does not refuse", async () => {
  // `occ_c ⪯ occ_d` says an upgrade will do instead; it does not say a customer
  // offered the upgrade would take the downgrade. Absence of an edge is absence
  // of permission, and so absence of a fan-out claim.
  const b = await bench([
    occasion({
      occasion_id: "occ_c",
      cluster: null,
      capacity: 400,
      document: {
        occasion_id: "occ_c",
        substitution: { policy: "advisory", accepts_substitute: [{ occasion_id: "occ_d", axis: "instant" }] },
      },
    }),
    occasion({ occasion_id: "occ_d", cluster: null, capacity: 400 }),
  ]);
  try {
    const first = await attempt(b.db, "occ_c", ["A:1"], HOUSEHOLD);
    const second = await attempt(b.db, "occ_d", ["A:1"], HOUSEHOLD);
    assert.ok(first.hold !== undefined, `first refused: ${first.code}`);
    assert.ok(second.hold !== undefined, `second refused: ${second.code}`);
  } finally {
    await b.close();
  }
});

test("X2 · `claimed` is outside the predicate — two purchases in one cluster are not fan-out", async () => {
  const b = await bench([
    occasion({ occasion_id: "occ_p1", cluster: "clu_run", capacity: 400 }),
    occasion({ occasion_id: "occ_p2", cluster: "clu_run", capacity: 400 }),
  ]);
  try {
    const first = await attempt(b.db, "occ_p1", ["A:1"], HOUSEHOLD);
    assert.ok(first.hold !== undefined);

    // A conforming hand-off then claim. Friday night for the couple is bought;
    // the Sunday matinee for the grandparents is a normal second transaction.
    await b.db.query(
      `update hold set handed_off_at = now(), handoff_floor_ms = 120000,
              claim_expires_at = expires_at + interval '2 minutes', claimed_at = now()
        where hold_id = $1`,
      [first.hold.hold_id],
    );
    await b.db.query("update hold_cluster set state = 'claimed' where hold_id = $1", [first.hold.hold_id]);
    await b.db.query("update hold_seat set state = 'claimed' where hold_id = $1", [first.hold.hold_id]);

    const second = await attempt(b.db, "occ_p2", ["A:2"], HOUSEHOLD);
    assert.ok(second.hold !== undefined, `a second purchase was refused as fan-out: ${second.code}`);
  } finally {
    await b.close();
  }
});

/* ── 5 · X4 and X3 — the seat ceilings ─────────────────────────────────────── */

test("X4 · a principal's live held seats on one showtime are capped, and the refusal names the cap", async () => {
  // capacity 400: the principal ceiling is min(6, 20) = 6, and the platform
  // ceiling is 8 — so the per-principal half is the one that binds here.
  const b = await bench([occasion({ occasion_id: "occ_seats", capacity: 400 })]);
  try {
    const first = await attempt(b.db, "occ_seats", seatsFrom("A", 1, 6), HOUSEHOLD);
    assert.ok(first.hold !== undefined, `expected a grant, got ${first.code}`);

    const second = await attempt(b.db, "occ_seats", ["B:1"], HOUSEHOLD);
    assert.equal(second.code, "seat_budget_exhausted");
    assert.deepEqual(second.detail, { limit: 6 });

    const seats = await b.db.query<{ n: string }>("select count(*)::text as n from hold_seat");
    assert.equal(Number(seats.rows[0].n), 6, "the refused grant wrote seat rows");
  } finally {
    await b.close();
  }
});

test("X4 · the proportional half binds in a small house, where six seats would be a tenth of the room", async () => {
  // Published, and different: this Server declines to publish the platform
  // fraction as a ceiling below its per-principal one, so that X4's own
  // proportional half is the binding number. Every limit read is still read from
  // the published document.
  const policy: HoldPolicyDocument = { ...HOLD_POLICY_PUBLISHED, max_held_fraction_per_showtime: 1 };
  const b = await bench([occasion({ occasion_id: "occ_small", capacity: 60 })]);
  try {
    // 5% of 60 is three seats.
    const first = await attempt(b.db, "occ_small", seatsFrom("A", 1, 3), HOUSEHOLD, policy);
    assert.ok(first.hold !== undefined, `expected a grant, got ${first.code}`);
    const second = await attempt(b.db, "occ_small", ["B:1"], HOUSEHOLD, policy);
    assert.equal(second.code, "seat_budget_exhausted");
    assert.deepEqual(second.detail, { limit: 3 });
  } finally {
    await b.close();
  }
});

test("X3 · the platform ceiling counts every principal on one platform, and refuses the platform", async () => {
  // capacity 400: platform ceiling 8, principal ceiling 6. Two households of one
  // platform take six and then three; the ninth seat is the platform's, not
  // either household's.
  const b = await bench([occasion({ occasion_id: "occ_plat", capacity: 400 })]);
  try {
    const one = await attempt(b.db, "occ_plat", seatsFrom("A", 1, 6), HOUSEHOLD);
    assert.ok(one.hold !== undefined, `expected a grant, got ${one.code}`);
    const two = await attempt(b.db, "occ_plat", seatsFrom("B", 1, 2), NEIGHBOUR);
    assert.ok(two.hold !== undefined, `expected a grant, got ${two.code}`);

    const three = await attempt(b.db, "occ_plat", ["C:1"], NEIGHBOUR);
    assert.equal(three.code, "seat_budget_exhausted");
    assert.deepEqual(three.detail, { limit: 8 });
  } finally {
    await b.close();
  }
});

/* ── 6 · X1's hourly rate ──────────────────────────────────────────────────── */

test("X1 · the hourly site rate counts holds GRANTED, so releasing one does not buy another", async () => {
  // Six unclustered showtimes at one origin, two holds each would trip the slot
  // ceiling first — so one hold each, and the seventh grant is the rate's.
  const occasions = Array.from({ length: 8 }, (_, i) =>
    occasion({ occasion_id: `occ_rate_${i}`, capacity: 400 }),
  );
  const b = await bench(occasions);
  try {
    const limit = HOLD_POLICY_PUBLISHED.max_holds_per_site_per_hour;
    for (let i = 0; i < limit; i++) {
      const outcome = await attempt(b.db, `occ_rate_${i}`, ["A:1"], HOUSEHOLD);
      assert.ok(outcome.hold !== undefined, `grant ${i} refused: ${outcome.code}`);
    }
    // Release every one of them. A rate limit that a release resets is a
    // concurrency ceiling wearing a rate limit's name.
    await b.db.query("update hold set released_at = now()");
    await b.db.query("delete from hold_cluster");

    const over = await attempt(b.db, `occ_rate_${limit}`, ["A:1"], HOUSEHOLD);
    assert.equal(over.code, "hold_budget_exhausted");
    assert.deepEqual(over.detail, { limit, window_ms: 3600000 });
  } finally {
    await b.close();
  }
});

/* ── 7 · The locks, and the semantics ──────────────────────────────────────── */

test("N1 · four budget scopes are locked, in one byte order, before any aggregate is counted", () => {
  const grant = {
    agent_id: AGENT,
    principal_scope: "ppid_a",
    hold_id: "hold_X",
    occasion_id: "occ",
    showtime_id: "show",
    origin: "https://embassy.example",
    cluster: null,
    capacity: 100,
    seat_ids: ["A:1"],
  };
  const keys = budgetLockKeys(grant);
  assert.equal(keys.length, 4);
  assert.deepEqual(keys, [...keys].sort(), "the lock sequence is not in ascending byte order");
  assert.equal(new Set(keys).size, 4, "two scopes hash to one key");

  // Two principals on one platform share the platform scopes and share neither
  // principal scope — which is what "both succeed" rests on.
  const other = budgetLockKeys({ ...grant, principal_scope: "ppid_b" });
  const shared = keys.filter((k) => other.includes(k));
  assert.equal(shared.length, 2, "the two principals do not share exactly the platform scopes");
});

test("X2 · a demand cluster is a mutual-substitution class, and it is an antichain", () => {
  const candidates: Candidate[] = [
    {
      occasion_id: "occ_a",
      policy: "advisory",
      accepts_substitute: [{ occasion_id: "occ_b", axis: "instant" }],
    },
    {
      occasion_id: "occ_b",
      policy: "advisory",
      accepts_substitute: [{ occasion_id: "occ_a", axis: "instant" }],
    },
    // Reachable one way only: an upgrade will do instead of occ_a, and that is
    // not a claim that occ_a will do instead of it.
    { occasion_id: "occ_up", policy: "advisory" },
    { occasion_id: "occ_alone", policy: "strict" },
  ];

  const cluster = demandCluster(candidates, "occ_a");
  assert.deepEqual([...cluster.members].sort(), ["occ_a", "occ_b"]);
  assert.equal(cluster.representative, "occ_a");
  assert.ok(isAntichain(candidates, cluster.members), "a mutual class contained a domination");

  const alone = demandCluster(candidates, "occ_alone");
  assert.deepEqual(alone.members, ["occ_alone"]);
  assert.equal(alone.representative, "occ_alone");
});

test("X2 · a one-way attested edge makes a domination, and the pair is NOT one demand cluster", () => {
  const candidates: Candidate[] = [
    { occasion_id: "occ_std", policy: "advisory", accepts_substitute: [{ occasion_id: "occ_imax", axis: "presentation_class" }] },
    { occasion_id: "occ_imax", policy: "advisory" },
  ];
  assert.deepEqual(demandCluster(candidates, "occ_std").members, ["occ_std"]);
  // The very thing that keeps them out of one cluster: one dominates the other.
  assert.equal(isAntichain(candidates, ["occ_std", "occ_imax"]), false);
});
