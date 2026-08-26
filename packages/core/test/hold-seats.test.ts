/**
 * `hold_seats` — the grant, and every refusal G1 orders. Owner: CORE-002.
 *
 * The assertions that matter here are about the STORE, not the response: a
 * verb that returns the right refusal and leaves a row behind has oversold a
 * seat and reported it correctly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { G1, G1_CODES_IN_ORDER, G1_READ_ONLY_THROUGH, firstInG1Order } from "@changeover/core/guards.ts";
import type { AvailabilityObservation, AvailabilitySource, HoldSeatsRequest } from "@changeover/core/hold-seats.ts";
import { decisionMembers, holdSeats, newHoldId } from "@changeover/core/hold-seats.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";
import type { RefusalCode } from "@changeover/schema/refusal.ts";

import { bench, etagFor, occasion, record, rowCounts, totalRows } from "./lib/estate.ts";

const AGENT = { agent_id: "agt_reference", principal_scope: "ps_household_1" };
const OTHER = { agent_id: "agt_reference", principal_scope: "ps_household_2" };

const HOUSE = "occ_house";
const PREMIERE = "occ_premiere";     // a second listing of the SAME physical screening
const SIBLING = "occ_sibling";       // same cluster, different screening
const DARK = "occ_dark";             // availability.mode: unknown
const CLOSED = "occ_closed";         // past its sales cutoff
const PARTLY = "occ_partly_sold";    // three seats gone for a reason that is not a Hold

function estate() {
  return [
    occasion({ occasion_id: HOUSE, capacity: 20, cluster: "clu_run" }),
    // showtime_ref maps this Occasion onto the SAME screening as HOUSE: a
    // premiere listing and a standard listing of one 7pm show.
    occasion({ occasion_id: PREMIERE, showtime_id: HOUSE, capacity: 20, cluster: "clu_run" }),
    occasion({ occasion_id: SIBLING, capacity: 20, cluster: "clu_run" }),
    occasion({ occasion_id: DARK, capacity: 20, availability_mode: "unknown" }),
    occasion({ occasion_id: CLOSED, capacity: 20, sales_cutoff_at: "2020-01-01T00:00:00+12:00" }),
    occasion({ occasion_id: PARTLY, capacity: 20, sold: 3 }),
  ];
}

function request(overrides: Partial<HoldSeatsRequest> & { occasion_id?: string } = {}): HoldSeatsRequest {
  const occasion_id = overrides.occasion_id ?? HOUSE;
  return {
    occasion_id,
    occasion_etag: etagFor(occasion_id),
    sought: { occasion_id, occasion_etag: etagFor(occasion_id) },
    seats: ["A:1", "A:2"],
    requested_floor_ms: 120000,
    ...overrides,
  };
}

async function refusalFrom(fn: () => Promise<unknown>): Promise<{ code: RefusalCode; detail?: unknown }> {
  try {
    await fn();
  } catch (err) {
    if (isRefusal(err)) return { code: err.code, detail: err.detail };
    throw err;
  }
  throw new Error("expected a refusal and the call succeeded");
}

/* ── 1 · The grant ─────────────────────────────────────────────────────────── */

test("a grant mints both cue marks from one clock, and floor_deadline is exactly granted_at + floor_ms", async () => {
  const b = await bench(estate());
  try {
    const hold = await holdSeats(b.db, request(), AGENT);

    assert.equal(hold.changeover, "0.1");
    assert.equal(hold.state, "live");
    assert.equal(hold.extendable, false, "T3: there is no extend verb and no server may provide one");
    assert.match(hold.hold_id, /^hold_[0-9A-HJKMNP-TV-Z]{32}$/, "Z2");
    assert.deepEqual(hold.seats, ["A:1", "A:2"]);
    assert.equal(hold.agent_id, AGENT.agent_id);
    assert.equal(hold.cluster, "clu_run");

    const granted = Date.parse(hold.granted_at);
    assert.equal(Date.parse(hold.floor_deadline) - granted, hold.floor_ms, "T1: the floor is granted_at + floor_ms");
    assert.ok(Date.parse(hold.expires_at) >= Date.parse(hold.floor_deadline), "T2");
    assert.ok(Date.parse(hold.server_time) >= granted, "K6");

    const rows = await b.db.query<{ seat_id: string; state: string }>(
      "select seat_id, state from hold_seat order by seat_id",
    );
    assert.deepEqual(rows.rows.map((r) => r.seat_id), ["A:1", "A:2"]);
    assert.ok(rows.rows.every((r) => r.state === "live"));
  } finally {
    await b.close();
  }
});

test("floor_ms is min(requested, policy_max) and the server may return less", async () => {
  const b = await bench(estate());
  try {
    const over = await holdSeats(b.db, request({ requested_floor_ms: 900000 }), AGENT);
    assert.equal(over.floor_ms, 300000, "capped at §2.5's published policy_max_floor_ms");

    await b.reset();
    const under = await holdSeats(b.db, request({ requested_floor_ms: 5000 }), AGENT);
    assert.equal(under.floor_ms, 5000, "a floor inside the cap is granted as asked");

    await b.reset();
    const penalised = await holdSeats(b.db, request({ requested_floor_ms: 100000 }), AGENT, {
      policy: { abandonment_floor_penalty_bp: 2500 },
    });
    assert.equal(penalised.floor_ms, 75000, "X5: the server MAY return less, and it is visible in the number");
  } finally {
    await b.close();
  }
});

test("expires_at is movable upward only and is never below the floor at grant", async () => {
  const b = await bench(estate());
  try {
    const hold = await holdSeats(b.db, request({ requested_floor_ms: 60000 }), AGENT, { expiry_ms: 180000 });
    assert.equal(Date.parse(hold.expires_at) - Date.parse(hold.granted_at), 180000);

    await b.reset();
    const short = await holdSeats(b.db, request({ requested_floor_ms: 60000 }), AGENT, { expiry_ms: 1000 });
    assert.equal(short.expires_at, short.floor_deadline, "T2: an expiry below the floor is raised to it");
  } finally {
    await b.close();
  }
});

test("hold_id carries 160 bits and no two grants share one", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const id = newHoldId();
    assert.match(id, /^hold_[0-9A-HJKMNP-TV-Z]{32}$/);
    assert.equal(seen.has(id), false);
    seen.add(id);
  }
  // I, L, O and U are absent from Crockford base32 and must never appear.
  assert.equal([...seen].some((id) => /[ILOU]/.test(id.slice(5))), false);
});

/* ── 2 · G1, in order ──────────────────────────────────────────────────────── */

const staleSource: AvailabilitySource = {
  async observe(): Promise<AvailabilityObservation> {
    return {
      mode: "seat_map",
      observed_at: "2020-01-01T00:00:00+12:00",
      staleness_basis: "measured",
      max_staleness_ms: 30000,
    };
  },
};

test("four guards fail at once and the first in G1 order wins, four times over", async () => {
  const b = await bench(estate());
  try {
    // Every one of these is true of the same call: the etag is stale (4), the
    // availability observation is older than published (5), the screening is
    // past its cutoff (6) and one named seat does not exist (10).
    const wrong = request({
      occasion_id: CLOSED,
      occasion_etag: etagFor("something else entirely"),
      sought: { occasion_id: CLOSED, occasion_etag: etagFor(CLOSED) },
      seats: ["A:1", "ZZ:99"],
    });

    const four = await refusalFrom(() => holdSeats(b.db, wrong, AGENT, { availability: staleSource }));
    assert.equal(four.code, "occasion_moved", "step 4 precedes 5, 6 and 10");

    const three = await refusalFrom(() =>
      holdSeats(b.db, { ...wrong, occasion_etag: etagFor(CLOSED) }, AGENT, { availability: staleSource }),
    );
    assert.equal(three.code, "availability_stale", "step 5 precedes 6 and 10");

    const two = await refusalFrom(() => holdSeats(b.db, { ...wrong, occasion_etag: etagFor(CLOSED) }, AGENT));
    assert.equal(two.code, "past_sales_cutoff", "step 6 precedes 10");

    const one = await refusalFrom(() =>
      holdSeats(b.db, { ...wrong, occasion_id: HOUSE, occasion_etag: etagFor(HOUSE), sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) } }, AGENT),
    );
    assert.equal(one.code, "unknown_seat", "step 10, once nothing before it fails");

    assert.equal(
      firstInG1Order(["unknown_seat", "past_sales_cutoff", "availability_stale", "occasion_moved"]),
      "occasion_moved",
      "and the table itself agrees, without running the verb at all",
    );
  } finally {
    await b.close();
  }
});

test("guards 1 to 6 write nothing — not a row, and not a lock", async () => {
  const b = await bench(estate());
  const rec = record(b.db);
  try {
    const cases: { why: string; run: () => Promise<unknown> }[] = [
      { why: "1 profile", run: () => holdSeats(rec.db, request(), AGENT, { profile: "0" }) },
      { why: "2 schema (W2 duplicate)", run: () => holdSeats(rec.db, request({ seats: ["A:1", "A:1"] }), AGENT) },
      { why: "3 occasion", run: () => holdSeats(rec.db, request({ occasion_id: "occ_nowhere", occasion_etag: etagFor("x"), sought: { occasion_id: "occ_nowhere", occasion_etag: etagFor("x") } }), AGENT) },
      { why: "4 etag", run: () => holdSeats(rec.db, request({ occasion_etag: etagFor("moved") }), AGENT) },
      { why: "5 availability", run: () => holdSeats(rec.db, request({ occasion_id: DARK, occasion_etag: etagFor(DARK), sought: { occasion_id: DARK, occasion_etag: etagFor(DARK) } }), AGENT) },
      { why: "6 cutoff", run: () => holdSeats(rec.db, request({ occasion_id: CLOSED, occasion_etag: etagFor(CLOSED), sought: { occasion_id: CLOSED, occasion_etag: etagFor(CLOSED) } }), AGENT) },
    ];

    for (const { why, run } of cases) {
      rec.clear();
      const refusal = await refusalFrom(run);
      const step = G1.find((s) => s.codes.includes(refusal.code));
      assert.ok(step, `${why}: ${refusal.code} is a code G1 orders`);
      assert.ok(step.step <= G1_READ_ONLY_THROUGH, `${why}: refused at step ${step.step}`);
      assert.deepEqual(rec.writes(), [], `${why}: took a lock or wrote a row before the first six passed`);
      assert.equal(totalRows(await rowCounts(b.db)), 0, `${why}: left a row behind`);
    }

    // Steps 1 and 2 decide from the request alone, so they say nothing at all.
    rec.clear();
    await refusalFrom(() => holdSeats(rec.db, request(), AGENT, { profile: "0" }));
    assert.deepEqual(rec.statements, [], "a malformed request never opens a transaction");
  } finally {
    await b.close();
  }
});

test("the G1 table and the module's own runners are the same twelve steps", () => {
  assert.equal(G1.length, 12);
  assert.equal(G1_CODES_IN_ORDER[0], "profile_not_supported");
  assert.equal(G1_CODES_IN_ORDER[G1_CODES_IN_ORDER.length - 1], "seat_contended");
  // The load-time invariant in hold-seats.ts throws on import if a step has no
  // runner, so reaching this line at all is the assertion.
  assert.equal(typeof holdSeats, "function");
});

/* ── 3 · W1–W4, and the seats ──────────────────────────────────────────────── */

test("a duplicate-bearing seats array is refused before any lock, never as seat_contended", async () => {
  const b = await bench(estate());
  try {
    const refusal = await refusalFrom(() => holdSeats(b.db, request({ seats: ["A:1", "A:1"] }), AGENT));
    assert.equal(refusal.code, "schema_validation", "W2: seat_contended here loops the agent forever");
    assert.equal(totalRows(await rowCounts(b.db)), 0);
  } finally {
    await b.close();
  }
});

test("an unknown seat names itself and writes zero rows, valid seats included", async () => {
  const b = await bench(estate());
  try {
    const refusal = await refusalFrom(() => holdSeats(b.db, request({ seats: ["A:1", "ZZ:99"] }), AGENT));
    assert.equal(refusal.code, "unknown_seat");
    assert.deepEqual((refusal.detail as { seat_ids: string[] }).seat_ids, ["ZZ:99"]);
    assert.equal(totalRows(await rowCounts(b.db)), 0, "C-ATOMIC.4: one valid + one invalid writes zero rows");
  } finally {
    await b.close();
  }
});

test("a seat sold by the exhibitor is seat_unavailable, which is not seat_contended", async () => {
  const b = await bench(estate());
  try {
    const sold = await b.db.query<{ seat_id: string }>(
      "select seat_id from occasion_seat where occasion_id = $1 and status = 'sold' order by seat_id limit 1",
      [PARTLY],
    );
    const seat = sold.rows[0].seat_id;
    const refusal = await refusalFrom(() =>
      holdSeats(
        b.db,
        request({ occasion_id: PARTLY, occasion_etag: etagFor(PARTLY), sought: { occasion_id: PARTLY, occasion_etag: etagFor(PARTLY) }, seats: [seat] }),
        AGENT,
      ),
    );
    assert.equal(refusal.code, "seat_unavailable", "W3: gone for a reason that is not a CHANGEOVER Hold");
    assert.deepEqual((refusal.detail as { seat_ids: string[] }).seat_ids, [seat]);
  } finally {
    await b.close();
  }
});

test("best_available chooses seats, and `together` chooses a run in one row", async () => {
  const b = await bench(estate());
  try {
    const any = await holdSeats(
      b.db,
      request({ seats: undefined, selection: { mode: "best_available", quantity: 3 } }),
      AGENT,
    );
    assert.equal(any.seats.length, 3);

    await b.reset();
    const together = await holdSeats(
      b.db,
      request({ seats: undefined, selection: { mode: "best_available", quantity: 3, together: true } }),
      AGENT,
    );
    const numbers = together.seats.map((s) => Number(s.split(":")[1])).sort((x, y) => x - y);
    const rows = new Set(together.seats.map((s) => s.split(":")[0]));
    assert.equal(rows.size, 1, "one row");
    assert.deepEqual(numbers, [numbers[0], numbers[0] + 1, numbers[0] + 2], "contiguous");
  } finally {
    await b.close();
  }
});

/* ── 4 · Contention, and the index that makes oversell unrepresentable ─────── */

test("a live hold makes its seats seat_contended, and the refusal names them", async () => {
  const b = await bench(estate());
  try {
    await holdSeats(b.db, request({ seats: ["A:1", "A:2"] }), AGENT);
    const refusal = await refusalFrom(() => holdSeats(b.db, request({ seats: ["A:2", "A:3"] }), OTHER));
    assert.equal(refusal.code, "seat_contended");
    assert.deepEqual((refusal.detail as { seat_ids: string[] }).seat_ids, ["A:2"]);

    const counts = await rowCounts(b.db);
    assert.equal(counts.hold_seat, 2, "the refused hold wrote no seat row — there are no partial holds");
    assert.equal(counts.hold, 1);
  } finally {
    await b.close();
  }
});

test("two Occasions mapped onto one physical screening cannot both hold a seat", async () => {
  const b = await bench(estate());
  try {
    await holdSeats(b.db, request({ occasion_id: HOUSE, seats: ["A:5"] }), AGENT);
    // PREMIERE is a different listing with the same showtime_ref. Keyed on
    // occasion_id the index would see two distinct keys and the house would
    // sell A:5 twice; keyed on the screening it cannot.
    const refusal = await refusalFrom(() =>
      holdSeats(
        b.db,
        request({ occasion_id: PREMIERE, occasion_etag: etagFor(PREMIERE), sought: { occasion_id: PREMIERE, occasion_etag: etagFor(PREMIERE) }, seats: ["A:5"] }),
        OTHER,
      ),
    );
    assert.equal(refusal.code, "seat_contended");
    assert.equal((await rowCounts(b.db)).hold_seat, 1);
  } finally {
    await b.close();
  }
});

/* ── 5 · The lazy reap ─────────────────────────────────────────────────────── */

test("an expired hold is reclaimed by the next contending transaction, with no sweeper", async () => {
  const b = await bench(estate());
  try {
    const dying = await holdSeats(b.db, request({ seats: ["A:1", "A:2", "A:3"], requested_floor_ms: 1000 }), AGENT);

    // Move the whole Hold into the past — all three cue marks together, so the
    // store's own derivation checks still hold and the row is exactly what an
    // abandoned hold looks like ten minutes later. Nothing sweeps; nothing is
    // scheduled; no process is coming.
    await b.db.query(
      `update hold set granted_at = granted_at - interval '10 minutes',
                       floor_deadline = floor_deadline - interval '10 minutes',
                       expires_at = expires_at - interval '10 minutes'
        where hold_id = $1`,
      [dying.hold_id],
    );
    await b.db.query(
      `update hold_seat set held_until = held_until - interval '10 minutes' where hold_id = $1`,
      [dying.hold_id],
    );
    assert.equal((await rowCounts(b.db)).hold_seat, 3, "still sitting there — no process is coming");

    // Contend on ONE of its three seats.
    const taken = await holdSeats(b.db, request({ seats: ["A:1"] }), OTHER);
    assert.deepEqual(taken.seats, ["A:1"]);

    const left = await b.db.query<{ hold_id: string; seat_id: string }>(
      "select hold_id, seat_id from hold_seat order by seat_id",
    );
    assert.equal(left.rows.length, 1, "a Hold is never partially expired: all three seats went, not just A:1");
    assert.equal(left.rows[0].hold_id, taken.hold_id);
  } finally {
    await b.close();
  }
});

test("a claimed seat is never reaped, however long ago its deadline passed", async () => {
  const b = await bench(estate());
  try {
    const sold = await holdSeats(b.db, request({ seats: ["A:7"] }), AGENT);
    await b.db.query(
      `update hold_seat set state = 'claimed', held_until = now() - interval '10 days' where hold_id = $1`,
      [sold.hold_id],
    );
    const refusal = await refusalFrom(() => holdSeats(b.db, request({ seats: ["A:7"] }), OTHER));
    assert.equal(refusal.code, "seat_contended", "claimed occupies its seat for the life of the screening");
    assert.equal((await rowCounts(b.db)).hold_seat, 1);
  } finally {
    await b.close();
  }
});

/* ── 6 · X2, the cluster ───────────────────────────────────────────────────── */

test("a second live hold in one cluster is cluster_fanout, and a second household is not", async () => {
  const first = await bench(estate());
  try {
    const held = await holdSeats(first.db, request({ occasion_id: HOUSE, seats: ["A:1"] }), AGENT);

    const refusal = await refusalFrom(() =>
      holdSeats(
        first.db,
        request({ occasion_id: SIBLING, occasion_etag: etagFor(SIBLING), sought: { occasion_id: SIBLING, occasion_etag: etagFor(SIBLING) }, seats: ["A:1"] }),
        AGENT,
      ),
    );
    assert.equal(refusal.code, "cluster_fanout");
    assert.equal((refusal.detail as { conflicting_hold_id: string }).conflicting_hold_id, held.hold_id);
    assert.equal((refusal.detail as { cluster: string }).cluster, "clu_run");

    // X2: "Friday night for the couple and the Sunday matinee for the
    // grandparents is a normal transaction." A different principal, same cluster.
    const grandparents = await holdSeats(
      first.db,
      request({ occasion_id: SIBLING, occasion_etag: etagFor(SIBLING), sought: { occasion_id: SIBLING, occasion_etag: etagFor(SIBLING) }, seats: ["A:2"] }),
      OTHER,
    );
    assert.equal(grandparents.state, "live");
  } finally {
    await first.close();
  }
});

test("an expired cluster row does not lock a principal out of their own next hold", async () => {
  const b = await bench(estate());
  try {
    const abandoned = await holdSeats(b.db, request({ occasion_id: HOUSE, seats: ["A:1"] }), AGENT);
    await b.db.query(`update hold_cluster set held_until = now() - interval '1 hour' where hold_id = $1`, [
      abandoned.hold_id,
    ]);
    const next = await holdSeats(
      b.db,
      request({ occasion_id: SIBLING, occasion_etag: etagFor(SIBLING), sought: { occasion_id: SIBLING, occasion_etag: etagFor(SIBLING) }, seats: ["A:2"] }),
      AGENT,
    );
    assert.equal(next.state, "live", "M3: a cluster predicate is evaluated against derived state");
  } finally {
    await b.close();
  }
});

/* ── 7 · S1 at commit ──────────────────────────────────────────────────────── */

test("holding a screening the customer did not choose crosses a strict boundary and writes nothing", async () => {
  const b = await bench(estate());
  try {
    const refusal = await refusalFrom(() =>
      holdSeats(
        b.db,
        request({
          occasion_id: SIBLING,
          occasion_etag: etagFor(SIBLING),
          sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) },
          seats: ["A:1"],
        }),
        AGENT,
      ),
    );
    assert.equal(refusal.code, "substitution_refused", "a missing edge is the absence of permission");
    assert.equal((refusal.detail as { from_occasion_id: string }).from_occasion_id, HOUSE);
    assert.equal(totalRows(await rowCounts(b.db)), 0, "S1: MUST NOT create the Hold");
  } finally {
    await b.close();
  }
});

test("an attested edge permits the substitution the publisher chose to permit", async () => {
  const permitted = [
    occasion({
      occasion_id: HOUSE,
      capacity: 20,
      document: {
        occasion_id: HOUSE,
        substitution: {
          policy: "strict",
          accepts_substitute: [{ occasion_id: SIBLING, axis: "instant" }],
          not_substitutable_for: [],
        },
      },
    }),
    occasion({ occasion_id: SIBLING, capacity: 20, document: { occasion_id: SIBLING, substitution: { policy: "strict", accepts_substitute: [], not_substitutable_for: [] } } }),
  ];
  const b = await bench(permitted);
  try {
    const hold = await holdSeats(
      b.db,
      request({
        occasion_id: SIBLING,
        occasion_etag: etagFor(SIBLING),
        sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) },
        seats: ["A:1"],
      }),
      AGENT,
    );
    assert.equal(hold.sought_occasion_id, HOUSE, "S4: recorded against a revocable credential");
    assert.equal(hold.occasion_id, SIBLING);
  } finally {
    await b.close();
  }
});

test("a stale sought etag is occasion_moved, not substitution_refused", async () => {
  const b = await bench(estate());
  try {
    const refusal = await refusalFrom(() =>
      holdSeats(b.db, request({ sought: { occasion_id: HOUSE, occasion_etag: etagFor("moved") } }), AGENT),
    );
    assert.equal(refusal.code, "occasion_moved", "S2");
  } finally {
    await b.close();
  }
});

/* ── 8 · Availability, the cutoff, and the credential ──────────────────────── */

test("availability.mode unknown is neither sold out nor available", async () => {
  const b = await bench(estate());
  try {
    const refusal = await refusalFrom(() =>
      holdSeats(b.db, request({ occasion_id: DARK, occasion_etag: etagFor(DARK), sought: { occasion_id: DARK, occasion_etag: etagFor(DARK) } }), AGENT),
    );
    assert.equal(refusal.code, "availability_unknown");
    assert.equal(refusal.detail, undefined, "the taxonomy declares no detail for it, and none is invented");
  } finally {
    await b.close();
  }
});

test("staleness_basis unknown has the same consequence, and no staleness number is invented", async () => {
  const b = await bench(estate());
  const unknowable: AvailabilitySource = {
    async observe(_tx, _id, server_time) {
      return { mode: "seat_map", observed_at: server_time, staleness_basis: "unknown" };
    },
  };
  try {
    const refusal = await refusalFrom(() => holdSeats(b.db, request(), AGENT, { availability: unknowable }));
    assert.equal(refusal.code, "availability_unknown");
  } finally {
    await b.close();
  }
});

test("past the sales cutoff the exhibitor is no longer selling", async () => {
  const b = await bench(estate());
  try {
    const refusal = await refusalFrom(() =>
      holdSeats(b.db, request({ occasion_id: CLOSED, occasion_etag: etagFor(CLOSED), sought: { occasion_id: CLOSED, occasion_etag: etagFor(CLOSED) } }), AGENT),
    );
    assert.equal(refusal.code, "past_sales_cutoff");
  } finally {
    await b.close();
  }
});

test("a credential with no principal_scope never becomes a request", async () => {
  const b = await bench(estate());
  const rec = record(b.db);
  try {
    const refusal = await refusalFrom(() =>
      holdSeats(rec.db, request(), { agent_id: "agt_reference", principal_scope: "" }),
    );
    assert.equal(refusal.code, "principal_scope_missing", "X0");
    assert.deepEqual(rec.statements, [], "the store is never opened");
  } finally {
    await b.close();
  }
});

test("Profile 0 implements no hold verb, and says so before anything else", async () => {
  const b = await bench(estate());
  try {
    const refusal = await refusalFrom(() => holdSeats(b.db, request({ seats: ["A:1", "A:1"] }), AGENT, { profile: "0" }));
    assert.equal(refusal.code, "profile_not_supported", "step 1 precedes step 2, even with a malformed request");
  } finally {
    await b.close();
  }
});

test("more seats than the venue holds at once is a published ceiling, not a schema error", async () => {
  const b = await bench(estate());
  try {
    const refusal = await refusalFrom(() =>
      holdSeats(b.db, request({ seats: ["A:1", "A:2", "A:3", "A:4", "A:5", "A:6", "A:7"] }), AGENT),
    );
    assert.equal(refusal.code, "seat_budget_exhausted");
    assert.equal((refusal.detail as { limit: number }).limit, 6, "§2.5's own default, published");
    assert.equal(totalRows(await rowCounts(b.db)), 0);
  } finally {
    await b.close();
  }
});

/* ── 9 · The seams ─────────────────────────────────────────────────────────── */

test("I3's decision members exclude intent_digest and sort the seats", () => {
  const d = decisionMembers({
    occasion_id: HOUSE,
    occasion_etag: etagFor(HOUSE),
    sought: { occasion_id: HOUSE, occasion_etag: etagFor(HOUSE) },
    seats: ["B:2", "A:10", "A:2"],
    requested_floor_ms: 120000,
    intent_digest: "sha256:whatever",
  });
  assert.deepEqual(d.seats, ["A:10", "A:2", "B:2"], "C collation: A:10 before A:2");
  assert.equal("intent_digest" in d, false, "I3 excludes it; D4 forbids echoing it");
  assert.equal("selection" in d, false, "an absent member is absent, not null");
});

test("a granted Hold never carries the intent digest it was given", async () => {
  const b = await bench(estate());
  try {
    const hold = await holdSeats(b.db, request({ intent_digest: "sha256:the-customer-said-so" }), AGENT);
    assert.equal(JSON.stringify(hold).includes("the-customer-said-so"), false, "D4");
  } finally {
    await b.close();
  }
});

test("a budget guard runs under the locks, after the hold row exists, and can refuse", async () => {
  const b = await bench(estate());
  let sawHoldId = "";
  try {
    const refusal = await refusalFrom(() =>
      holdSeats(b.db, request(), AGENT, {
        budgets: {
          async reserve(_tx, grant) {
            sawHoldId = grant.hold_id;
            const { refuse } = await import("@changeover/schema/refusal.ts");
            throw refuse("hold_budget_exhausted", "That is enough holds for now.", {
              detail: { limit: 6, window_ms: 3600000 },
            });
          },
        },
      }),
    );
    assert.equal(refusal.code, "hold_budget_exhausted");
    assert.match(sawHoldId, /^hold_/, "the seam sees the hold it is deciding about");
    assert.equal(totalRows(await rowCounts(b.db)), 0, "and its refusal takes the whole transaction with it");
  } finally {
    await b.close();
  }
});

test("a seat rule check refuses the chosen set at step 11, before any seat row is written", async () => {
  const b = await bench(estate());
  try {
    const refusal = await refusalFrom(() =>
      holdSeats(b.db, request(), AGENT, {
        seat_rules: {
          async check() {
            const { refuse } = await import("@changeover/schema/refusal.ts");
            return refuse("seat_rule_violated", "That would strand a single seat.", {
              detail: { rule: "orphan_seat", suggested_seats: ["A:3", "A:4"] },
            });
          },
        },
      }),
    );
    assert.equal(refusal.code, "seat_rule_violated");
    assert.equal((await rowCounts(b.db)).hold_seat, 0);
  } finally {
    await b.close();
  }
});
