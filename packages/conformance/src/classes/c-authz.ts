// C-AUTHZ. Owner: TEST-006.
//
// §7: *"With two credentials on one site, every verb by B against A's Hold
// returns 404 and the store shows no state change."*
//
// **404, never 403, and the difference is the whole class.** A `403` confirms
// the Hold exists. An attacker holding one valid agent credential can then walk
// the id space and learn which holds are real — a map of who is booking what,
// where and when, assembled without ever reading a single Hold. `404` tells them
// nothing, and the endpoint stops being an enumeration oracle.
//
// The cheaper check is to assert `status === 404` and stop. It would pass on a
// Server that answers `404` after having already released A's seats, and it
// would pass on a Server whose `404` for a real Hold carries a different body
// from its `404` for an id that was never minted — which is the same oracle
// wearing a different status code. So this class asserts three things instead:
// the status, the **indistinguishability** of the two refusals, and the store.
//
// Z1 (SPEC.md:429) is the rule underneath. The operator surface is deliberately
// out of scope here: a credential without the operator surface gets `403
// not_authorised` on `POST /revoke`, and that is correct, because the denial is
// about the SURFACE and is decided before any `hold_id` is looked at. It leaks
// nothing about whether the Hold exists — which this class asserts, by putting a
// hold_id that was never minted through the same call and comparing.

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { Call, ConformanceBench } from "./_bench.ts";
import { TOKEN, grantHold, key } from "./_bench.ts";

const NEVER_MINTED = "hold_00000000000000000000000000000000";

interface StoreShot {
  readonly hold: string;
  readonly seats: string;
}

/**
 * Everything about the Hold that a verb could change, as one comparable string.
 *
 * Read through explicit columns rather than `select *`: `revoked_at`, `released_at`
 * and `claimed_at` are the three markers M1 derives `state` from, and a snapshot
 * that omitted one would compare equal across exactly the transition it exists
 * to notice.
 */
async function shot(bench: ConformanceBench, hold_id: string): Promise<StoreShot> {
  const hold = await bench.db.query(
    "select hold_id, agent_id, principal_scope, seats::text as seats, floor_ms," +
      " granted_at::text as granted_at, floor_deadline::text as floor_deadline," +
      " expires_at::text as expires_at, handed_off_at::text as handed_off_at," +
      " claimed_at::text as claimed_at, released_at::text as released_at," +
      " revoked_at::text as revoked_at, revocation_reason" +
      " from hold where hold_id = $1",
    [hold_id],
  );
  const seats = await bench.db.query(
    "select seat_id, state, held_until::text as held_until from hold_seat" +
      " where hold_id = $1 order by seat_id",
    [hold_id],
  );
  return { hold: JSON.stringify(hold.rows), seats: JSON.stringify(seats.rows) };
}

/** A refusal body with the members that legitimately move on every response removed. */
function refusalShape(call: Call): string {
  const body = { ...(call.json as Record<string, unknown> | null ?? {}) };
  delete body.server_time;
  return JSON.stringify({ status: call.status, body });
}

export const id = "C-AUTHZ";
export const spec_row =
  "With two credentials on one site, every verb by B against A's Hold returns 404 and the store shows no state change.";

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  // A's Hold. Two seats, so a partial release would be visible as well as a total one.
  const granted = await grantHold(bench, TOKEN.a, ["A:1", "A:2"], {}, `authz-${bench.nonce}`);
  if (granted.status !== 201) {
    c.bad("fixture", `A could not be granted a Hold to defend: ${granted.status} ${granted.text.slice(0, 200)}`);
    return c.items;
  }
  const hold_id = String((granted.json as { hold_id: string }).hold_id);
  c.ok("fixture", `A holds ${hold_id} over two seats, granted through the wire`);

  const before = await shot(bench, hold_id);

  // The read_token B would need for hand_off. A mints it, because a B that
  // cannot even get a token would be refused for the wrong reason — and the
  // class is about B holding everything except the right to this Hold.
  const a_read = await bench.call("GET", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.a });
  const read_token = String((a_read.json as { read_token?: string }).read_token ?? "");

  /* ── 1 · Every agent verb by B, against A's Hold ──────────────────────── */

  const attempts: { verb: string; run: () => Promise<Call> }[] = [
    {
      verb: "get_hold",
      run: () => bench.call("GET", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.b }),
    },
    {
      verb: "release_hold",
      run: () => bench.call("DELETE", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.b }),
    },
    {
      verb: "hand_off",
      run: () =>
        bench.call("POST", `/changeover/v0/holds/${hold_id}/hand-off`, {
          token: TOKEN.b,
          headers: { "Idempotency-Key": key(`authz-off-${bench.nonce}`) },
          body: { read_token },
        }),
    },
  ];

  const seen: Record<string, Call> = {};
  let four_oh_four = 0;
  let three_oh_three = 0;
  for (const attempt of attempts) {
    const response = await attempt.run();
    seen[attempt.verb] = response;
    if (response.status === 404) four_oh_four++;
    if (response.status === 403) three_oh_three++;
  }

  c.is("404", four_oh_four, attempts.length, "every agent verb by B against A's Hold answers 404");
  c.is(
    "never_403",
    three_oh_three,
    0,
    "none of them answers 403 — a 403 confirms the Hold exists and turns the id space into an enumeration oracle",
  );

  for (const [verb, response] of Object.entries(seen)) {
    const code = (response.json as { code?: string } | null)?.code;
    c.is(
      `code.${verb}`,
      code,
      "hold_not_found",
      `${verb} by B refuses hold_not_found, which is the same code an id that was never minted gets`,
    );
  }

  /* ── 2 · The refusal for a real Hold is byte-identical to one for a
        hold_id that was never minted ─────────────────────────────────────── */

  const phantom: { verb: string; run: () => Promise<Call> }[] = [
    {
      verb: "get_hold",
      run: () => bench.call("GET", `/changeover/v0/holds/${NEVER_MINTED}`, { token: TOKEN.b }),
    },
    {
      verb: "release_hold",
      run: () => bench.call("DELETE", `/changeover/v0/holds/${NEVER_MINTED}`, { token: TOKEN.b }),
    },
    {
      verb: "hand_off",
      run: () =>
        bench.call("POST", `/changeover/v0/holds/${NEVER_MINTED}/hand-off`, {
          token: TOKEN.b,
          headers: { "Idempotency-Key": key(`authz-phantom-${bench.nonce}`) },
          body: { read_token },
        }),
    },
  ];

  let indistinguishable = 0;
  for (const attempt of phantom) {
    const response = await attempt.run();
    const real = seen[attempt.verb] as Call;
    if (refusalShape(response) === refusalShape(real)) indistinguishable++;
    else {
      c.bad(
        `oracle.${attempt.verb}`,
        `B can tell A's Hold from an id that was never minted: real=${refusalShape(real).slice(0, 200)} phantom=${refusalShape(response).slice(0, 200)}`,
      );
    }
  }
  if (indistinguishable === phantom.length) {
    c.ok(
      "oracle",
      "for all three verbs B's refusal for A's real Hold is byte-identical, `server_time` aside, to its refusal for a hold_id that was never minted",
    );
  }

  /* ── 3 · The operator surface denies before it looks ──────────────────── */

  const revoke_real = await bench.call("POST", `/changeover/v0/holds/${hold_id}/revoke`, {
    token: TOKEN.b,
    body: { revocation_reason: "venue_operations" },
  });
  const revoke_phantom = await bench.call("POST", `/changeover/v0/holds/${NEVER_MINTED}/revoke`, {
    token: TOKEN.b,
    body: { revocation_reason: "venue_operations" },
  });
  c.that(
    "operator_surface",
    revoke_real.status === 403 &&
      (revoke_real.json as { code?: string } | null)?.code === "not_authorised",
    `an agent credential on the operator route is refused 403 not_authorised, which is a fact about the SURFACE and not about the Hold (got ${revoke_real.status})`,
  );
  c.is(
    "operator_surface_leaks_nothing",
    refusalShape(revoke_phantom),
    refusalShape(revoke_real),
    "and that 403 is identical for a hold_id that was never minted, so the surface denial is not an oracle either",
  );

  /* ── 4 · The store ────────────────────────────────────────────────────── */

  const after = await shot(bench, hold_id);
  c.is("no_state_change.hold", after.hold, before.hold, "after seven refused calls by B the hold row is unchanged, column for column");
  c.is("no_state_change.seats", after.seats, before.seats, "and both hold_seat rows are unchanged, including held_until");

  /* ── 5 · A still owns it ──────────────────────────────────────────────── */
  //
  // Without this, a Server that had simply broken every hold verb would pass
  // every assertion above.

  const a_after = await bench.call("GET", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.a });
  c.that(
    "a_unaffected",
    a_after.status === 200 && (a_after.json as { state?: string }).state === "live",
    `A reads its own Hold back live afterwards, so the 404s were Z1 and not a broken verb (got ${a_after.status})`,
  );

  return c.items;
}
