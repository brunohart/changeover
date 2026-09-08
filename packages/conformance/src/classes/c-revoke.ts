// C-REVOKE. Owner: TEST-006.
//
// §7: *"An Override transitions to `revoked`, records a reason, refuses agent
// verbs `409 hold_revoked`, and increments `operator_overrides` without failing
// C-FLOOR."*
//
// T1a (SPEC.md:316) is the rule underneath, and its last clause is the one with
// consequences: an Override is counted in `operator_overrides`, **separately**
// from `floor_violations`, and does **not** fail C-FLOOR. Fold the two together
// and an honest exhibitor who withdrew a row of seats for a safety reason looks
// non-conforming — which pushes operators toward not recording overrides at all,
// and the record of who took the seats back is exactly what a floor warranty is
// worth without.
//
// **So this class counts both from the same store, in one query.** An assertion
// that the counters are "reported separately" is worth nothing if the two are
// derived from different reads: what makes them separable is that the store
// carries `revocation_reason`, and a violation counter that ignored it would
// count this Hold. The negative control is a Hold whose seats stopped being held
// before its floor deadline with **no** revocation reason — a genuine violation,
// planted deliberately, which the same query must count on the other side.
//
// **What is deliberately not asserted here.** §4.9's table gives `revoked | any
// agent verb | hold_revoked`, and the row above it gives `released / expired /
// claimed / revoked | release_hold | 204 (R2)`. The catch-all is therefore
// already known not to be literal, and whether `get_hold` is also carved out of
// it cannot be decided from the text: T1a says later agent verbs are refused,
// while §4.9's own `get_hold` rows are total in every state and CORE-003
// implements that reading. Deciding it here would be this harness legislating,
// so the clause reports unprovable and names the contradiction. What IS asserted
// is the case the specification states twice and both readings agree on:
// `hand_off` against a revoked Hold refuses `409 hold_revoked` carrying
// `detail.book_url`.

import { REVOCATION_REASONS } from "@changeover/schema/refusal.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { Call, ConformanceBench } from "./_bench.ts";
import { CREDENTIAL_A, DELEGATED_ORIGIN, OCCASION, TOKEN, grantHold, key } from "./_bench.ts";

export const id = "C-REVOKE";
export const spec_row =
  "An Override transitions to revoked, records a reason, refuses agent verbs 409 hold_revoked," +
  " and increments operator_overrides without failing C-FLOOR.";

interface HoldShot {
  readonly state_markers: string;
  readonly floor: string;
  readonly seats: string;
}

/** What an Override may move, and what T1a says it may not. */
async function shot(bench: ConformanceBench, hold_id: string): Promise<HoldShot> {
  const hold = await bench.db.query<Record<string, unknown>>(
    "select revoked_at::text as revoked_at, revocation_reason, released_at::text as released_at," +
      " claimed_at::text as claimed_at, handed_off_at::text as handed_off_at," +
      " floor_ms, granted_at::text as granted_at, floor_deadline::text as floor_deadline," +
      " expires_at::text as expires_at" +
      " from hold where hold_id = $1",
    [hold_id],
  );
  const row = hold.rows[0] ?? {};
  const seats = await bench.db.query<Record<string, unknown>>(
    "select seat_id, state from hold_seat where hold_id = $1 order by seat_id",
    [hold_id],
  );
  return {
    state_markers: JSON.stringify({
      revoked_at: row.revoked_at ?? null,
      revocation_reason: row.revocation_reason ?? null,
      released_at: row.released_at ?? null,
      claimed_at: row.claimed_at ?? null,
      handed_off_at: row.handed_off_at ?? null,
    }),
    floor: JSON.stringify({
      floor_ms: row.floor_ms ?? null,
      granted_at: row.granted_at ?? null,
      floor_deadline: row.floor_deadline ?? null,
      expires_at: row.expires_at ?? null,
    }),
    seats: JSON.stringify(seats.rows),
  };
}

/**
 * The two counters a dated report carries, read from the store in one pass.
 *
 * A Hold "stopped holding" before its floor deadline when no seat row of it is
 * still occupying and the deadline has not passed. Split on `revocation_reason`:
 * with one, T1a calls it an Override; without one, nothing in the protocol
 * shortened that floor legitimately and it is a violation. Scoped to one
 * principal, because a bare count over a shared store counts other runs.
 */
async function counters(
  bench: ConformanceBench,
  principal_scope: string,
): Promise<{ operator_overrides: number; floor_violations: number }> {
  const result = await bench.db.query<{ overrides: string; violations: string }>(
    "select" +
      " count(*) filter (where h.revocation_reason is not null)::text as overrides," +
      " count(*) filter (where h.revocation_reason is null)::text as violations" +
      " from hold h" +
      " where h.principal_scope = $1" +
      "   and h.floor_deadline > clock_timestamp()" +
      "   and not exists (select 1 from hold_seat s where s.hold_id = h.hold_id" +
      "                     and s.state in ('live', 'handed_off', 'claimed'))",
    [principal_scope],
  );
  const row = result.rows[0];
  return {
    operator_overrides: Number(row?.overrides ?? 0),
    floor_violations: Number(row?.violations ?? 0),
  };
}

function revoke(bench: ConformanceBench, hold_id: string, reason: string): Promise<Call> {
  return bench.call("POST", `/changeover/v0/holds/${hold_id}/revoke`, {
    token: TOKEN.operator,
    body: { revocation_reason: reason },
  });
}

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  /* ── 1 · A live Hold, and the Override that takes it ──────────────────── */

  const granted = await grantHold(bench, TOKEN.a, ["A:1", "A:2"], {}, `revoke-${bench.nonce}`);
  if (granted.status !== 201) {
    c.bad("fixture", `no live Hold to override: ${granted.status} ${granted.text.slice(0, 200)}`);
    return c.items;
  }
  const hold_id = String((granted.json as { hold_id: string }).hold_id);
  const before = await shot(bench, hold_id);
  c.ok("fixture", `${hold_id} is live over two seats at ${OCCASION.main}`);

  const override = await revoke(bench, hold_id, "safety");
  c.is("override_status", override.status, 200, "the operator's Override is accepted at the operator surface");
  c.is(
    "override_state",
    (override.json as { state?: string } | null)?.state,
    "revoked",
    "and it answers with the state it produced, which §4.9 gives as live → revoked",
  );

  const after = await shot(bench, hold_id);
  const marks = JSON.parse(after.state_markers) as Record<string, string | null>;
  c.that(
    "transitions_in_store",
    marks.revoked_at !== null,
    `and the store carries revoked_at, so the transition is a fact about the Hold rather than a member of a response (${String(marks.revoked_at).slice(0, 32)})`,
  );
  c.is(
    "records_reason",
    marks.revocation_reason,
    "safety",
    "with the reason recorded beside it — an override with no reason is indistinguishable from a bug in the exhibitor's console",
  );
  c.that(
    "reason_closed",
    REVOCATION_REASONS.includes(marks.revocation_reason as never),
    `and the reason is one of the closed enum (${REVOCATION_REASONS.join(", ")})`,
  );

  const bad_reason = await revoke(bench, hold_id, "we needed the seats");
  c.that(
    "reason_enum_enforced",
    bad_reason.status === 400 && (bad_reason.json as { code?: string } | null)?.code === "schema_validation",
    `a reason outside that enum is refused schema_validation (got ${bad_reason.status}), so the closed set is enforced and not merely documented`,
  );

  /* ── 2 · T1a: no other mechanism may shorten a floor ──────────────────── */

  c.is(
    "floor_untouched",
    after.floor,
    before.floor,
    "the Override took the seats and left the warranty alone: floor_ms, granted_at, floor_deadline and expires_at are byte-identical to the granted values",
  );

  /* ── 3 · The seats, voided, and immediately re-holdable ───────────────── */
  //
  // `revocation_voids_holds: true` is published, so the marked rows leave the
  // occupancy predicate. The rows are MARKED and not deleted, which is what
  // keeps the record of which seats this Hold held.

  const seat_states = (JSON.parse(after.seats) as { seat_id: string; state: string }[]).map((s) => s.state);
  c.that(
    "seats_voided",
    seat_states.length === 2 && seat_states.every((s) => s === "revoked"),
    `both seat rows are marked revoked rather than deleted (${seat_states.join(", ")}), so the seats stop occupying and the record of which seats the Hold held survives`,
  );
  const reheld = await grantHold(bench, TOKEN.b, ["A:1", "A:2"], {}, `revoke-re-${bench.nonce}`);
  c.is(
    "seats_reholdable",
    reheld.status,
    201,
    "and a second agent can hold exactly those seats immediately afterwards, which is what voiding a Hold has to mean at the seat index",
  );

  /* ── 4 · Later agent verbs ────────────────────────────────────────────── */

  const victim = await grantHold(bench, TOKEN.a, ["C:1"], {}, `revoke-verbs-${bench.nonce}`);
  const victim_id = String((victim.json as { hold_id: string }).hold_id);
  const victim_read = await bench.call("GET", `/changeover/v0/holds/${victim_id}`, { token: TOKEN.a });
  const read_token = String((victim_read.json as { read_token?: string } | null)?.read_token ?? "");
  await revoke(bench, victim_id, "session_cancelled");

  const handed = await bench.call("POST", `/changeover/v0/holds/${victim_id}/hand-off`, {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`revoke-off-${bench.nonce}`) },
    body: { read_token },
  });
  const refusal = (handed.json ?? {}) as { code?: string; detail?: { book_url?: string; revocation_reason?: string } };
  c.that(
    "hand_off_refused",
    handed.status === 409 && refusal.code === "hold_revoked",
    `hand_off against the revoked Hold refuses 409 hold_revoked (got ${handed.status} ${refusal.code ?? "no code"})`,
  );
  c.that(
    "refusal_carries_book_url",
    typeof refusal.detail?.book_url === "string" && refusal.detail.book_url.startsWith(DELEGATED_ORIGIN),
    `and it carries detail.book_url (${refusal.detail?.book_url ?? "absent"}) — an operator who took these seats back owes the customer a route to the ones that are left`,
  );
  c.is(
    "refusal_carries_reason",
    refusal.detail?.revocation_reason,
    "session_cancelled",
    "and the venue's own reason, so the agent can tell a withdrawn screening from a withdrawn seat",
  );

  // R2's own row of §4.9 carves release_hold out of the catch-all: release is
  // total in released / expired / claimed / revoked, and answers 204.
  const released = await bench.call("DELETE", `/changeover/v0/holds/${victim_id}`, { token: TOKEN.a });
  c.is(
    "release_still_total",
    released.status,
    204,
    "release_hold against the revoked Hold is still 204 (R2), which is the exception §4.9 states in the row above the catch-all",
  );

  /* ── 5 · Terminal ─────────────────────────────────────────────────────── */

  const before_second = await shot(bench, victim_id);
  const second = await revoke(bench, victim_id, "venue_operations");
  const after_second = await shot(bench, victim_id);
  c.is(
    "second_override_no_change",
    after_second.state_markers,
    before_second.state_markers,
    `a second Override moves nothing — revoked is terminal, and the first reason is the one recorded (${second.status})`,
  );
  c.is(
    "second_override_frees_nothing",
    (second.json as { seats_freed?: number } | null)?.seats_freed,
    0,
    "and it reports freeing no seats, because the first one already did",
  );

  /* ── 6 · From handed_off, which §4.9 also permits ─────────────────────── */

  const off_hold = await grantHold(bench, TOKEN.a, ["D:1"], {}, `revoke-off-src-${bench.nonce}`);
  const off_id = String((off_hold.json as { hold_id: string }).hold_id);
  const off_read = await bench.call("GET", `/changeover/v0/holds/${off_id}`, { token: TOKEN.a });
  const off_handed = await bench.call("POST", `/changeover/v0/holds/${off_id}/hand-off`, {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`revoke-handed-${bench.nonce}`) },
    body: { read_token: (off_read.json as { read_token?: string } | null)?.read_token },
  });
  const from_handed = await revoke(bench, off_id, "seat_withdrawn");
  c.that(
    "override_from_handed_off",
    off_handed.status === 200 && from_handed.status === 200 &&
      (from_handed.json as { state?: string } | null)?.state === "revoked",
    `§4.9 gives operator_override two sources, live and handed_off; a handed-off Hold overrides to revoked (${from_handed.status})`,
  );

  /* ── 7 · The two counters, from one query over one store ──────────────── */

  const overrides_only = await counters(bench, CREDENTIAL_A.principal_scope);
  c.is(
    "overrides_counted",
    overrides_only.operator_overrides,
    3,
    "three Holds of this principal stopped holding before their floor deadline carrying a revocation_reason, and the counter finds exactly three",
  );
  c.is(
    "no_violations_yet",
    overrides_only.floor_violations,
    0,
    "and the same query, on the other side of the same split, finds no floor violation — an Override is not one",
  );

  // The negative control. Without it, "zero violations" is a constant.
  const planted = await grantHold(bench, TOKEN.a, ["E:1"], {}, `revoke-violation-${bench.nonce}`);
  const planted_id = String((planted.json as { hold_id: string }).hold_id);
  await bench.db.query(
    "update hold_seat set state = 'released' where hold_id = $1",
    [planted_id],
  );
  const both = await counters(bench, CREDENTIAL_A.principal_scope);
  c.is(
    "violation_detectable",
    both.floor_violations,
    1,
    "a Hold whose seats stopped holding before its floor deadline with NO revocation_reason is counted as a violation by that same query, so the zero above was measured and not assumed",
  );
  c.is(
    "counters_separate",
    both.operator_overrides,
    3,
    "and planting it did not move operator_overrides, which is what 'reported separately' has to mean when both numbers come off one store",
  );

  /* ── 8 · The clause the specification contradicts itself on ───────────── */

  const read_after = await bench.call("GET", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.a });
  c.cannot(
    "get_hold_after_override",
    `§4.9's table gives 'revoked | any agent verb | hold_revoked' and T1a says later agent verbs are refused 409 hold_revoked carrying detail.book_url — but the row immediately above it carves release_hold out at 204 (R2), so the catch-all is already known not to be literal, and §4.9's own get_hold rows are total in every state. This binding answers ${read_after.status} with state=${String((read_after.json as { state?: string } | null)?.state)} and the revocation_reason beside it, on the documented reading that an Agent whose Hold has gone needs to be told what happened to it. Both readings are available from the text and deciding between them here would be this harness legislating; it needs a specification amendment`,
  );

  return c.items;
}
