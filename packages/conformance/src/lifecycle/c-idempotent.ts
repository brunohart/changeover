/**
 * **C-IDEMPOTENT** — replays carry identical identity and floor members with
 * freshly projected time members; a different digest refuses and does not act,
 * verified in the store; `input_required` records no entry; a `hand_off` replay
 * after `claim_expires_at` yields no `claim_url`.
 *
 * Owner: TEST-003.
 *
 * **The replay is asserted after the Hold has expired, and that is the whole
 * class.** A replay taken one millisecond after the grant agrees with the stored
 * document about everything, so it cannot tell a correct implementation from a
 * response cache wearing an idempotency layer's name. I4 exists because
 * *"byte-identical replay of a time-bearing object is a lie with a 24-hour shelf
 * life: a body asserting `state: live` over a floor 40 seconds past makes an
 * agent obeying K1 exactly compute 180 seconds of runway when it has 140."* So
 * this file lets the floor run out against the store's own clock and then
 * replays: `hold_id`, `seats`, `granted_at`, `floor_ms` and `floor_deadline`
 * must be exactly what they were, and `state` must say `expired`.
 *
 * **I5 is asserted in the store, not in the response.** "No action taken" is a
 * claim about rows. A boundary that returned `422` after granting a Hold would
 * satisfy every response-shaped assertion and would be the double-book I5
 * exists to prevent, so the seats named by the refused request are counted, and
 * then offered to somebody else.
 *
 * **I6 is not here.** The in-flight branch needs two callers in the air at once
 * and is proven under true concurrency by `scripts/prove_idempotent_race.sh`.
 * Restating it on one connection would be a statement about ordering, and I6 is
 * entirely about contention.
 */

import type { Db } from "@changeover/store/db.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import { getHold } from "@changeover/core/get-hold.ts";
import { handOff } from "@changeover/core/hand-off.ts";
import {
  REPLAYED_MEMBERS,
  handOffDigest,
  holdSeatsDigest,
  keyHmac,
  withIdempotency,
} from "@changeover/core/idempotency.ts";
import type { IdempotencyScope } from "@changeover/core/idempotency.ts";

import type { Check, ClassResult } from "./contract.ts";
import { assert, broke } from "./contract.ts";
import type { LifecycleBench } from "./bench.ts";
import { etagFor, expiredInStore, lifecycleBench, lifecycleOccasion, runId, sleep } from "./bench.ts";

const AGENT = "agt_t003idem";
const GRANT_FLOOR_MS = 1500;

export interface IdempotentOptions {
  readonly run_id?: string;
}

export async function cIdempotent(options: IdempotentOptions = {}): Promise<ClassResult> {
  const run = options.run_id ?? runId();
  const OCC = "occ_idem_" + run;
  const checks: Check[] = [];
  const notes: string[] = [
    "harness profile — agent " + AGENT + ", budgets unenforced; I6 (in-flight) is proven under " +
      "concurrency by scripts/prove_idempotent_race.sh and is deliberately not restated here",
  ];

  let b: LifecycleBench;
  try {
    b = await lifecycleBench(run, {
      occasions: [lifecycleOccasion({ occasion_id: OCC, capacity: 40 })],
    });
  } catch (err) {
    return { id: "C-IDEMPOTENT", checks: [], notes, unprovable: "the store did not answer: " + message(err) };
  }

  try {
    /* ── I4 · the replay, before and after the floor runs out ───────────── */

    const P = "principal_idem_" + run;
    const key = idempotencyKey("GRANT", run);
    const scope = scopeFor(P, "hold_seats", key);
    const request = req(OCC, ["A:1", "A:2"], GRANT_FLOOR_MS);
    const digest = holdSeatsDigest(request);

    const first = await withIdempotency(b.db, scope, digest, () =>
      holdSeats(b.db, request, cred(P)));
    checks.push(assert(
      first.disposition === "executed",
      "the first call under a fresh key executed and stored its record",
      "the first call was " + first.disposition + " rather than an execution",
    ));
    const granted = record(first);

    const live = await withIdempotency(b.db, scope, digest, () => {
      throw new Error("I8: the verb must not run on a replay");
    });
    checks.push(assert(
      live.disposition === "replayed",
      "I8 — the same key and digest replays without the verb running at all: no guard, no lock, no reap",
      "the replay was " + live.disposition,
    ));
    const liveRecord = record(live);
    checks.push(...identityChecks("while live", granted, liveRecord));
    checks.push(assert(
      liveRecord.state === "live" && String(liveRecord.server_time) > String(granted.server_time),
      "I4 — the live replay re-projects state (live) and carries a server_time later than the grant's",
      "the live replay reported state " + String(liveRecord.state) + " at " + String(liveRecord.server_time),
    ));

    // The floor runs out. Against the store's own clock, because K4 permits one
    // time source and a harness waiting on the process clock would be asserting
    // against a second one.
    await waitUntilExpired(b.db, granted.hold_id as string, GRANT_FLOOR_MS + 5000);

    const stale = await withIdempotency(b.db, scope, digest, () => {
      throw new Error("I8: the verb must not run on a replay");
    });
    checks.push(assert(
      stale.disposition === "replayed",
      "I8 — idempotency is evaluated BEFORE state guards: the expired Hold replays rather than refusing hold_not_live",
      "the replay of an expired Hold was " + stale.disposition,
    ));
    const staleRecord = record(stale);
    checks.push(...identityChecks("after the floor ran out", granted, staleRecord));
    checks.push(assert(
      staleRecord.state === "expired",
      "I4 — and the replayed state is freshly projected as expired: the cached document would have said live",
      "the replay of an expired Hold reported state " + String(staleRecord.state),
    ));
    checks.push(assert(
      staleRecord.expires_at === granted.expires_at && staleRecord.server_time !== granted.server_time,
      "I4 — expires_at is re-read (unmoved, because there is no extend verb) while server_time is not the stored one",
      "the re-projected time members did not behave as I4 requires",
    ));

    /* ── I5 · same key, different digest ────────────────────────────────── */

    const otherRequest = req(OCC, ["B:1", "B:2"], GRANT_FLOOR_MS);
    let reusedCode: string | null = null;
    try {
      await withIdempotency(b.db, scope, holdSeatsDigest(otherRequest), () =>
        holdSeats(b.db, otherRequest, cred(P)));
    } catch (err) {
      reusedCode = codeOf(err);
    }
    checks.push(assert(
      reusedCode === "idempotency_key_reused",
      "I5 — the same key under a different digest is refused idempotency_key_reused",
      "reusing the key under a different digest gave " + (reusedCode ?? "a grant"),
    ));
    const seatRows = await b.db.query<{ n: string }>(
      "select count(*)::text as n from hold_seat where occasion_id = $1 and seat_id = any($2::text[])",
      [OCC, ["B:1", "B:2"]],
    );
    checks.push(assert(
      Number(seatRows.rows[0]?.n ?? -1) === 0,
      "I5 — verified in the store: the refused request wrote zero hold_seat rows. No action taken means no rows.",
      "the refused request left " + seatRows.rows[0]?.n + " hold_seat rows behind",
    ));
    const someoneElse = await holdSeats(b.db, otherRequest, cred("principal_other_" + run));
    checks.push(assert(
      someoneElse.seats.join(",") === "B:1,B:2",
      "I5 — and those seats were still free to another caller, which is what 'no action taken' means to a customer",
      "the seats named by the refused request were not free afterwards",
    ));

    /* ── I7 · input_required is not an operation ────────────────────────── */

    const gateKey = idempotencyKey("GATE0", run);
    const gateScope = scopeFor(P, "hold_seats", gateKey);
    const gateRequest = req(OCC, ["C:1", "C:2"], GRANT_FLOOR_MS);
    const gateDigest = holdSeatsDigest(gateRequest);

    const gated = await withIdempotency(b.db, gateScope, gateDigest, async () => ({ input_required: true as const }));
    checks.push(assert(
      gated.disposition === "input_required",
      "the gate-returning call reported input_required rather than an execution",
      "the gated call was " + gated.disposition,
    ));
    const entries = await b.db.query<{ n: string }>(
      "select count(*)::text as n from idempotency where agent_id = $1 and principal_scope = $2 and verb = $3 and idempotency_key_hmac = $4",
      [AGENT, P, "hold_seats", keyHmac(gateKey)],
    );
    checks.push(assert(
      Number(entries.rows[0]?.n ?? -1) === 0,
      "I7 — verified in the store: an input_required call recorded no idempotency entry at all",
      "the gated call left " + entries.rows[0]?.n + " idempotency rows behind",
    ));
    const retried = await withIdempotency(b.db, gateScope, gateDigest, () =>
      holdSeats(b.db, gateRequest, cred(P)));
    checks.push(assert(
      retried.disposition === "executed",
      "I7 — the same key is accepted on the gate-satisfying retry, so a human gate does not cost the Agent its key",
      "the gate-satisfying retry was " + retried.disposition,
    ));

    /* ── I9 · a hand_off replay after the claim window ──────────────────── */

    const P9 = "principal_i9_" + run;
    const handed = await holdSeats(b.db, req(OCC, ["D:1", "D:2"], GRANT_FLOOR_MS), cred(P9));
    const read = await getHold(b.db, handed.hold_id, cred(P9));
    const handKey = idempotencyKey("HANDOFF", run);
    const handScope = scopeFor(P9, "hand_off", handKey);

    const handedOff = await withIdempotency(b.db, handScope, handOffDigest(handed.hold_id), async () => {
      const result = await handOff(
        b.db,
        { hold_id: handed.hold_id, read_token: read.read_token as string },
        cred(P9),
        // The published window is two minutes. T6 clamps this up to expires_at
        // anyway, so the claim closes with the floor and the wait is a second
        // rather than the harness sleeping for two minutes to observe an arithmetic.
        { handoff_floor_ms: 1000 },
      );
      return result.hold as unknown as Record<string, unknown>;
    });
    const handoffRecord = record(handedOff);
    checks.push(assert(
      typeof (handoffRecord.handoff as { claim_url?: unknown } | undefined)?.claim_url === "string",
      "the hand-off itself minted a claim_url, once, on the response that delivers it",
      "hand_off returned no claim_url to replay against",
    ));

    await waitUntilExpired(b.db, handed.hold_id, GRANT_FLOOR_MS + 5000);
    await sleep(150);

    const replayed9 = await withIdempotency(b.db, handScope, handOffDigest(handed.hold_id), () => {
      throw new Error("I8: the verb must not run on a replay");
    });
    const replayed9Record = record(replayed9);
    checks.push(assert(
      replayed9.disposition === "replayed" &&
        (replayed9 as { claim_consumed?: boolean }).claim_consumed === true,
      "I9 — after claim_expires_at the hand_off replay reports the claim spent",
      "the post-window hand_off replay was " + replayed9.disposition + " with claim_consumed " +
        String((replayed9 as { claim_consumed?: boolean }).claim_consumed),
    ));
    checks.push(assert(
      replayed9Record.handoff === undefined,
      "I9 — and it yields NO claim_url: the credential is spent and a replay must not re-emit it (CL5)",
      "the post-window replay still carried " + JSON.stringify(replayed9Record.handoff),
    ));
    checks.push(assert(
      replayed9Record.hold_id === handed.hold_id && replayed9Record.state === "expired",
      "I9 — the replay still answers about the right Hold, with current state, which is the point of the departure",
      "the post-window replay named " + String(replayed9Record.hold_id) + " in state " +
        String(replayed9Record.state),
    ));
  } catch (err) {
    checks.push(broke("the scenario did not complete: " + message(err)));
  } finally {
    await b.close();
  }

  return { id: "C-IDEMPOTENT", checks, notes };
}

/* ── I4's five identity members, one check each ────────────────────────────── */

/**
 * *"`hold_id`, `seats`, `granted_at`, `floor_ms` and `floor_deadline` MUST be
 * byte-identical."*
 *
 * The list is read from {@link REPLAYED_MEMBERS} rather than written out here,
 * so a member added to the implementation's table and not to the specification's
 * — or the reverse — cannot pass this by being invisible to it.
 */
function identityChecks(when: string, granted: Record<string, unknown>, replayed: Record<string, unknown>): Check[] {
  const differing = REPLAYED_MEMBERS.filter(
    (member) => JSON.stringify(granted[member]) !== JSON.stringify(replayed[member]),
  );
  return [
    assert(
      differing.length === 0,
      "I4 — " + when + ", all five of " + REPLAYED_MEMBERS.join(", ") + " replay byte-identical",
      "I4 — " + when + ", these members moved across a replay: " + differing.join(", "),
    ),
  ];
}

/* ── Small things ──────────────────────────────────────────────────────────── */

function record(outcome: unknown): Record<string, unknown> {
  return ((outcome as { record?: unknown }).record ?? {}) as Record<string, unknown>;
}

/** ≥128 bits of shape, and inside `KEY_PATTERN`'s 22–128 characters. */
function idempotencyKey(label: string, run: string): string {
  return ("01K" + label + run.toUpperCase().replace(/[^A-Z0-9]/g, "0")).padEnd(26, "0").slice(0, 60);
}

function scopeFor(principal_scope: string, verb: "hold_seats" | "hand_off", idempotency_key: string): IdempotencyScope {
  return { agent_id: AGENT, principal_scope, verb, idempotency_key };
}

function cred(principal_scope: string) {
  return { agent_id: AGENT, principal_scope };
}

function req(occasion_id: string, seats: readonly string[], floor: number) {
  const etag = etagFor(occasion_id);
  return {
    occasion_id,
    occasion_etag: etag,
    sought: { occasion_id, occasion_etag: etag },
    seats: [...seats],
    requested_floor_ms: floor,
  };
}

async function waitUntilExpired(db: Db, hold_id: string, ceiling_ms: number): Promise<boolean> {
  const until = Date.now() + ceiling_ms;
  for (;;) {
    if (await expiredInStore(db, hold_id)) return true;
    if (Date.now() > until) return false;
    await sleep(25);
  }
}

function codeOf(err: unknown): string {
  return isRefusal(err) ? (err as { code: string }).code : "non-refusal: " + message(err);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
