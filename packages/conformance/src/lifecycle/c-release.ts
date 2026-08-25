/**
 * **C-RELEASE** — total and idempotent in every state except `handed_off`,
 * where it returns `409 handoff_consumed` and does **not** free the seat; seats
 * re-holdable within a measured bound.
 *
 * Owner: TEST-003.
 *
 * > **R1.** `release_hold` on a `handed_off` Hold **MUST** be refused `409
 * > handoff_consumed`. *Hand-off is agent-terminal: once a claim URL is minted,
 * > the Hold's disposition belongs to the customer and the exhibitor.*
 * > **R2.** Otherwise `release_hold` is **total**: `204` for every Hold the
 * > credential may address, in `live`, `released`, `expired`, `claimed` or
 * > `revoked`, and it **MUST NOT** refuse.
 *
 * **The one exception is the whole point of the class.** R1's refusal is the
 * only one this verb makes, and a system that got it backwards would be a remote
 * kill switch on a customer standing at a checkout — which is precisely what an
 * injected instruction asks for. So the `handed_off` case is asserted twice: the
 * code that came back, *and* the seat rows that did not move. A boundary that
 * refused with the right code and freed the seat anyway would pass the first
 * assertion and be exactly the failure R1 exists to prevent.
 *
 * **Every state is reached through the real verbs, not minted.** `handed_off`
 * comes from `get_hold` + `hand_off`; `claimed` from confirming the claim URL
 * that hand-off minted; `expired` from a real floor running out against the
 * store's own clock. Writing the columns directly would test this file's idea of
 * what those states look like. The one exception is `revoked`, which has no
 * agent verb by design — an Operator Override is an operator's act, so the
 * harness performs it as one.
 *
 * **R2 is asserted as totality, not as five separate happy paths.** The failure
 * that matters is a cleanup path treating non-2xx as an error and logging false
 * alarms at a rate proportional to abandonment — which is the common case. So
 * every state is released, and the assertion is that none of the five refused.
 */

import type { Db, Queryable } from "@changeover/store/db.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import { getHold } from "@changeover/core/get-hold.ts";
import { handOff } from "@changeover/core/hand-off.ts";
import { confirmClaim, parseClaimUrl } from "@changeover/core/claim.ts";
import { releaseHold } from "@changeover/core/release.ts";
import type { ReleaseOutcome } from "@changeover/core/release.ts";
import { HOLD_STATE } from "@changeover/core/derived.ts";
import type { HoldState } from "@changeover/core/derived.ts";

import type { Check, ClassResult } from "./contract.ts";
import { assert, broke } from "./contract.ts";
import type { LifecycleBench } from "./bench.ts";
import { etagFor, expiredInStore, lifecycleBench, lifecycleOccasion, occupancyOf, runId, sleep } from "./bench.ts";
import { formatPercentiles, percentiles, timed } from "./latency.ts";

const AGENT = "agt_t003release";
const EXPIRING_FLOOR_MS = 1000;

export interface ReleaseOptions {
  readonly run_id?: string;
  readonly latency_trials?: number;
}

export async function cRelease(options: ReleaseOptions = {}): Promise<ClassResult> {
  const run = options.run_id ?? runId();
  const trials = options.latency_trials ?? 20;
  const OCC = "occ_release_" + run;

  const checks: Check[] = [];
  const notes: string[] = ["harness profile — agent " + AGENT + ", budgets unenforced, one 60-seat house"];

  let b: LifecycleBench;
  try {
    b = await lifecycleBench(run, {
      occasions: [lifecycleOccasion({ occasion_id: OCC, capacity: 60 })],
    });
  } catch (err) {
    return { id: "C-RELEASE", checks: [], notes, unprovable: "the store did not answer: " + message(err) };
  }

  try {
    const seats = seatPairs(20);
    let next = 0;
    const pair = (): string[] => seats[next++];

    /* ── R2 · live ──────────────────────────────────────────────────────── */

    const live = await grant(b.db, OCC, pair(), "principal_live_" + run, 60000);
    const releasedLive = await releaseHold(b.db, live.hold_id, cred("principal_live_" + run));
    checks.push(assert(
      releasedLive.status === 204 && releasedLive.state_before === HOLD_STATE.live &&
        releasedLive.state === HOLD_STATE.released && releasedLive.seats_freed === 2,
      "R2 — releasing a live Hold answers 204, transitions live → released and frees both seats",
      "releasing a live Hold gave " + describe(releasedLive),
    ));
    const afterLive = await occupancyOf(b.db, live.hold_id);
    checks.push(assert(
      afterLive.occupying_seat_rows === 0 && afterLive.seat_rows === 2 && afterLive.slot_rows === 0,
      "the seat rows were MARKED, not deleted — 2 rows survive, 0 occupy — and the budget slot is gone",
      "after a release the store shows " + JSON.stringify(afterLive),
    ));

    const again = await releaseHold(b.db, live.hold_id, cred("principal_live_" + run));
    checks.push(assert(
      again.status === 204 && again.state_before === HOLD_STATE.released && again.seats_freed === 0,
      "R2 — the second release of the same Hold is 204 with 0 seats freed: idempotent, not merely tolerated",
      "the repeat release gave " + describe(again),
    ));

    /* ── R2 · expired ───────────────────────────────────────────────────── */

    const expiring = await grant(b.db, OCC, pair(), "principal_expired_" + run, EXPIRING_FLOOR_MS);
    await waitUntilExpired(b.db, expiring.hold_id, EXPIRING_FLOOR_MS + 5000);
    const releasedExpired = await releaseHold(b.db, expiring.hold_id, cred("principal_expired_" + run));
    checks.push(assert(
      releasedExpired.status === 204 && releasedExpired.state_before === HOLD_STATE.expired &&
        releasedExpired.state === HOLD_STATE.expired && releasedExpired.seats_freed === 2,
      "R2 — releasing an expired Hold is 204, frees its seats, and leaves it expired rather than making it released",
      "releasing an expired Hold gave " + describe(releasedExpired),
    ));
    const expiredRepeat = await releaseHold(b.db, expiring.hold_id, cred("principal_expired_" + run));
    checks.push(assert(
      expiredRepeat.status === 204 && expiredRepeat.seats_freed === 0,
      "R2 — releasing it a second time is 204 with nothing left to free",
      "the repeat release of an expired Hold gave " + describe(expiredRepeat),
    ));

    /* ── R1 · handed_off ────────────────────────────────────────────────── */

    const P_HANDOFF = "principal_handoff_" + run;
    const handedSeats = pair();
    const handed = await grant(b.db, OCC, handedSeats, P_HANDOFF, 60000);
    const read = await getHold(b.db, handed.hold_id, cred(P_HANDOFF));
    const handOffResult = await handOff(
      b.db, { hold_id: handed.hold_id, read_token: read.read_token as string }, cred(P_HANDOFF),
    );
    const beforeRefusal = await occupancyOf(b.db, handed.hold_id);
    let refusedCode: string | null = null;
    try {
      await releaseHold(b.db, handed.hold_id, cred(P_HANDOFF));
    } catch (err) {
      refusedCode = isRefusal(err) ? (err as { code: string }).code : "non-refusal: " + message(err);
    }
    checks.push(assert(
      refusedCode === "handoff_consumed",
      "R1 — release_hold on a handed_off Hold is refused 409 handoff_consumed, the verb's only refusal",
      "releasing a handed_off Hold gave " + (refusedCode ?? "204") + " rather than handoff_consumed",
    ));
    const afterRefusal = await occupancyOf(b.db, handed.hold_id);
    checks.push(assert(
      afterRefusal.occupying_seat_rows === beforeRefusal.occupying_seat_rows &&
        afterRefusal.occupying_seat_rows === 2,
      "R1 — and the seats did NOT come back: the refusal is a refusal, not a release wearing a 409",
      "the handed_off Hold's occupancy moved from " + beforeRefusal.occupying_seat_rows +
        " to " + afterRefusal.occupying_seat_rows + " across a refused release",
    ));
    const stillHeld = await refusalOf(() =>
      grant(b.db, OCC, handedSeats, "principal_probe_" + run, 60000));
    checks.push(assert(
      stillHeld === "seat_contended",
      "R1 — a third party still cannot take those seats, which is what 'did not free the seat' means to a customer",
      "after the refused release the handed-off seats were " + (stillHeld ?? "grantable"),
    ));

    /* ── R2 · claimed ───────────────────────────────────────────────────── */

    const presented = parseClaimUrl(handOffResult.hold.handoff?.claim_url as string);
    const claimed = presented === null
      ? null
      : await confirmClaim(b.db, presented, { binding_ref: "sess_" + run });
    checks.push(assert(
      claimed !== null && claimed.ok === true && claimed.consumed === true,
      "the claim was confirmed, so the Hold is now claimed — the terminal state that keeps its seat",
      "the claim could not be confirmed: " + JSON.stringify(claimed),
    ));
    const releasedClaimed = await releaseHold(b.db, handed.hold_id, cred(P_HANDOFF));
    checks.push(assert(
      releasedClaimed.status === 204 && releasedClaimed.state_before === HOLD_STATE.claimed &&
        releasedClaimed.seats_freed === 0,
      "R2 — releasing a claimed Hold is 204 and frees nothing: claimed occupies its seat for the life of the screening",
      "releasing a claimed Hold gave " + describe(releasedClaimed),
    ));
    checks.push(assert(
      (await occupancyOf(b.db, handed.hold_id)).occupying_seat_rows === 2,
      "the claimed Hold still occupies both seats after a release that answered 204",
      "a release freed a claimed Hold's seats",
    ));

    /* ── R2 · revoked ───────────────────────────────────────────────────── */

    const P_REVOKED = "principal_revoked_" + run;
    const revoked = await grant(b.db, OCC, pair(), P_REVOKED, 60000);
    // An Operator Override. There is no agent verb for this and there must not
    // be one, so the harness acts as the operator rather than pretending a verb.
    await b.db.query(
      "update hold set revoked_at = clock_timestamp(), revocation_reason = $2 where hold_id = $1",
      [revoked.hold_id, "venue_operations"],
    );
    const releasedRevoked = await releaseHold(b.db, revoked.hold_id, cred(P_REVOKED));
    checks.push(assert(
      releasedRevoked.status === 204 && releasedRevoked.state_before === HOLD_STATE.revoked &&
        releasedRevoked.state === HOLD_STATE.revoked && releasedRevoked.seats_freed === 0,
      "R2 — releasing a revoked Hold is 204 and leaves it revoked: the operator's record is not overwritten by cleanup",
      "releasing a revoked Hold gave " + describe(releasedRevoked),
    ));

    /* ── R2 · totality, as one statement ────────────────────────────────── */

    const totals: HoldState[] = [
      releasedLive.state_before, again.state_before, releasedExpired.state_before,
      releasedClaimed.state_before, releasedRevoked.state_before,
    ];
    const wanted: HoldState[] = [
      HOLD_STATE.live, HOLD_STATE.released, HOLD_STATE.expired, HOLD_STATE.claimed, HOLD_STATE.revoked,
    ];
    checks.push(assert(
      wanted.every((state) => totals.includes(state)),
      "R2 — the verb answered 204 in all five of live, released, expired, claimed and revoked, and refused in none",
      "R2's five states were not all exercised: " + totals.join(", "),
    ));

    /* ── The measured bound ─────────────────────────────────────────────── */

    const latency = await releaseLatency(b, OCC, run, trials);
    notes.push(formatPercentiles("release latency (release → seats re-granted) —", latency));
    checks.push(assert(
      latency.n === trials && Number.isFinite(latency.p95),
      "seats re-holdable within a MEASURED bound: " + trials +
        " trials reported as p50/p95/max rather than as an adjective",
      "release latency produced " + latency.n + " usable samples of " + trials,
    ));
  } catch (err) {
    checks.push(broke("the scenario did not complete: " + message(err)));
  } finally {
    await b.close();
  }

  return { id: "C-RELEASE", checks, notes };
}

/**
 * How long a released seat takes to become somebody else's, measured across the
 * boundary rather than inside it.
 *
 * The clock starts before `release_hold` is called and stops when a *different*
 * principal's `hold_seats` for the same seats has returned a Hold. That span is
 * the whole of what an exhibitor means by "when does the seat come back", and it
 * is deliberately not the duration of the release transaction: a boundary that
 * committed its release quickly and left the seat unavailable for another second
 * would look excellent by the narrower measurement and be wrong.
 */
async function releaseLatency(b: LifecycleBench, occasion_id: string, run: string, trials: number) {
  const samples: number[] = [];
  // Row F is untouched by seatPairs(), which allocates A–D. A latency trial that
  // contended with a scenario above would be measuring the wrong thing.
  const seats = ["F:1", "F:2"];

  for (let i = 0; i < trials; i++) {
    const held = await grant(b.db, occasion_id, seats, "principal_rel" + i + "_" + run, 60000);
    const { ms } = await timed(async () => {
      await releaseHold(b.db, held.hold_id, cred("principal_rel" + i + "_" + run));
      return grant(b.db, occasion_id, seats, "principal_reg" + i + "_" + run, 60000);
    });
    samples.push(ms);
    // Tidy up the re-grant so the next trial starts from the same place. It is
    // released rather than left to expire: an orphan here would make trial i+1
    // measure a reap, which is C-ORPHAN's number and not this one.
    const regranted = await b.db.query<{ hold_id: string }>(
      "select hold_id from hold where occasion_id = $1 and principal_scope = $2",
      [occasion_id, "principal_reg" + i + "_" + run],
    );
    for (const row of regranted.rows) {
      await releaseHold(b.db, row.hold_id, cred("principal_reg" + i + "_" + run));
    }
  }

  return percentiles(samples, b.db.driver + " · release then re-grant, sequential");
}

/* ── Small things ──────────────────────────────────────────────────────────── */

function seatPairs(count: number): string[][] {
  const pairs: string[][] = [];
  const rows = "ABCDEFGHIJKLMNOP".split("");
  for (let i = 0; i < count; i++) {
    const row = rows[Math.floor(i / 5)];
    const base = (i % 5) * 2 + 1;
    pairs.push([row + ":" + base, row + ":" + (base + 1)]);
  }
  return pairs;
}

function cred(principal_scope: string) {
  return { agent_id: AGENT, principal_scope };
}

function grant(db: Db, occasion_id: string, seats: readonly string[], principal_scope: string, floor: number) {
  const etag = etagFor(occasion_id);
  return holdSeats(
    db,
    {
      occasion_id,
      occasion_etag: etag,
      sought: { occasion_id, occasion_etag: etag },
      seats: [...seats],
      requested_floor_ms: floor,
    },
    cred(principal_scope),
  );
}

async function waitUntilExpired(q: Queryable, hold_id: string, ceiling_ms: number): Promise<boolean> {
  const until = Date.now() + ceiling_ms;
  for (;;) {
    if (await expiredInStore(q, hold_id)) return true;
    if (Date.now() > until) return false;
    await sleep(25);
  }
}

async function refusalOf(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (err) {
    return isRefusal(err) ? (err as { code: string }).code : "non-refusal: " + message(err);
  }
}

function describe(outcome: ReleaseOutcome): string {
  return outcome.status + " " + outcome.state_before + "→" + outcome.state +
    " freed=" + outcome.seats_freed;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
