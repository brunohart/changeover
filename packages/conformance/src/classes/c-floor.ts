// C-FLOOR. Owner: TEST-006.
//
// §7: *"`owned_store` hard-fails at one violation; `measured_warranty` **reports**
// `floor_violations` as a rate against a published threshold and does not
// hard-fail below it. `floor_ms` never increases post-grant; `expires_at ≥
// floor_deadline`; `operator_overrides` reported separately."*
//
// **The floor is a warranty, not an assertion**, and the arithmetic that makes it
// one is published in the document itself: `floor_ms` MUST NOT exceed
// `min_observed_retention_ms − safety_margin_ms`, both members of
// `floor_evidence`. So the first thing this class does is read what the Server
// published and ask whether the Server could keep it — not whether it did on one
// happy request, but whether the *ceiling it advertises* is inside its own
// evidence. That is the lie §7's closing note describes: an operator who sets a
// floor because a worked example does, above a store that will not hold it.
//
// **This assertion has already fired once, on this bench.** Before the clamp in
// `_bench.ts`, the site published `floor_evidence` warranting 270000ms and a
// `policy_max_floor_ms` of 300000ms, and `requested_floor_ms: 300000` was
// granted in full. Nothing about the boundary was wrong; the *configuration*
// emitted a floor nothing had measured, which is exactly the failure a
// conformance class is for. The negative control below carries the unclamped
// default so the clause cannot go quiet again.
//
// **The two inequalities are asserted twice each, and the second time is the one
// that matters.** Over the rows this run produced, and against the CHECK
// constraints in the store — `hold_floor_derived` and
// `hold_expiry_not_before_floor` — because a property that holds of today's rows
// is a measurement and a property the database refuses to break is a guarantee.
// Same for "`floor_ms` never increases post-grant": the column is absent from
// the agent role's UPDATE grant, so the increase is not merely unwritten but
// unwritable, and there is no extend verb for it to be written through.

import { warrantableFloorMs, floorIsWarranted } from "@changeover/adapter-reference/floor.ts";
import { HOLD_POLICY_PUBLISHED } from "@changeover/core/budgets.ts";
import { ROUTES } from "@changeover/http/routes.ts";
import { SQLSTATE, constraintName, sqlstate } from "@changeover/store/db.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { ConformanceBench } from "./_bench.ts";
import { CREDENTIAL_A, TOKEN, grantHold, key } from "./_bench.ts";

export const id = "C-FLOOR";
export const spec_row =
  "owned_store hard-fails at one violation; measured_warranty reports floor_violations as a rate against" +
  " a published threshold and does not hard-fail below it. floor_ms never increases post-grant;" +
  " expires_at >= floor_deadline; operator_overrides reported separately.";

interface FloorEvidenceDocument {
  readonly observations: number;
  readonly min_observed_retention_ms: number;
  readonly safety_margin_ms: number;
  readonly violations: number;
}

/** `sqlstate` for a statement that was expected to be refused. */
async function refusedBy(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "no error";
  } catch (err) {
    const state = sqlstate(err);
    if (state === undefined) return "threw";
    const constraint = constraintName(err);
    return constraint === undefined ? state : `${state} ${constraint}`;
  }
}

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  /* ── 1 · What the Server published about its own floor ────────────────── */

  const capability = await bench.call("GET", "/.well-known/changeover");
  const document = (capability.json ?? {}) as {
    floor_basis?: string;
    floor_evidence?: FloorEvidenceDocument;
    hold_policy?: { policy_max_floor_ms?: number };
  };
  const evidence = document.floor_evidence;
  if (evidence === undefined || document.hold_policy === undefined) {
    c.bad("published", `the capability document carries no floor_evidence or no hold_policy (${capability.status})`);
    return c.items;
  }
  const warrantable = warrantableFloorMs(evidence);
  const ceiling = Number(document.hold_policy.policy_max_floor_ms ?? 0);
  c.ok(
    "published",
    `floor_basis ${document.floor_basis}, ${evidence.observations} observations, min retention ${evidence.min_observed_retention_ms}ms less ${evidence.safety_margin_ms}ms margin — warranting ${warrantable}ms`,
  );

  c.that(
    "ceiling_warranted",
    ceiling > 0 && ceiling <= warrantable,
    `the ceiling this Server advertises (policy_max_floor_ms ${ceiling}ms) is inside what its own evidence warrants (${warrantable}ms) — a Server MUST NOT grant a floor it has not measured, and the ceiling is the largest floor it offers to grant`,
  );
  c.that(
    "ceiling_control",
    !floorIsWarranted(HOLD_POLICY_PUBLISHED.policy_max_floor_ms, evidence as never),
    `and the unclamped default ceiling (${HOLD_POLICY_PUBLISHED.policy_max_floor_ms}ms) is NOT warranted by this evidence, so the clause above is a measurement rather than a constant — a site publishing the default unchanged fails it`,
  );

  /* ── 2 · Every floor this run was granted ─────────────────────────────── */

  const asked = [1000, 60000, 120000, warrantable, ceiling + 60000];
  const granted: { requested: number; floor_ms: number }[] = [];
  for (const requested of asked) {
    await bench.reset();
    const hold = await grantHold(bench, TOKEN.a, ["A:1"], { requested_floor_ms: requested }, `floor-${requested}`);
    if (hold.status !== 201) {
      c.bad("granted", `requested_floor_ms ${requested} was refused ${hold.status} ${hold.text.slice(0, 140)}`);
      return c.items;
    }
    granted.push({ requested, floor_ms: Number((hold.json as { floor_ms: number }).floor_ms) });
  }
  const unwarranted = granted.filter((g) => !floorIsWarranted(g.floor_ms, evidence as never));
  c.is(
    "granted_warranted",
    unwarranted.length,
    0,
    `${granted.length} floors granted across the published range (${granted.map((g) => `${g.requested}→${g.floor_ms}`).join(", ")}), every one of them inside the evidence`,
  );
  const over_ceiling = granted.find((g) => g.requested > ceiling);
  c.that(
    "clamped_not_refused",
    over_ceiling !== undefined && over_ceiling.floor_ms === ceiling,
    `a request above the ceiling is granted AT the ceiling (${over_ceiling?.requested ?? 0} → ${over_ceiling?.floor_ms ?? 0}), which is the published limit doing its job rather than a refusal an agent cannot act on`,
  );

  /* ── 3 · floor_ms never increases post-grant ──────────────────────────── */

  await bench.reset();
  const subject = await grantHold(bench, TOKEN.a, ["A:1", "A:2"], {}, `floor-life-${bench.nonce}`);
  const hold_id = String((subject.json as { hold_id: string }).hold_id);
  const at_grant = Number((subject.json as { floor_ms: number }).floor_ms);

  const reads: number[] = [];
  for (let i = 0; i < 5; i++) {
    const read = await bench.call("GET", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.a });
    reads.push(Number((read.json as { floor_ms: number }).floor_ms));
  }
  const replay = await grantHold(bench, TOKEN.a, ["A:1", "A:2"], {}, `floor-life-${bench.nonce}`);
  const on_replay = Number((replay.json as { floor_ms: number }).floor_ms);
  const handed_read = await bench.call("GET", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.a });
  const handed = await bench.call("POST", `/changeover/v0/holds/${hold_id}/hand-off`, {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`floor-off-${bench.nonce}`) },
    body: { read_token: (handed_read.json as { read_token?: string } | null)?.read_token },
  });
  const after_handoff = Number((handed.json as { floor_ms: number }).floor_ms);

  const observed = [at_grant, ...reads, on_replay, after_handoff];
  c.that(
    "floor_never_increases",
    observed.every((f) => f <= at_grant),
    `floor_ms observed ${observed.length} times across five reads, an idempotent replay and a hand-off, never above the granted ${at_grant}ms (${[...new Set(observed)].join(", ")})`,
  );
  c.is(
    "floor_replay_identical",
    on_replay,
    at_grant,
    "and the replay carries the identical floor member rather than a freshly computed one, which is what makes a retry safe to trust",
  );

  const stored = await bench.db.query<{ floor_ms: number }>(
    "select floor_ms from hold where hold_id = $1",
    [hold_id],
  );
  c.is(
    "floor_store",
    Number(stored.rows[0]?.floor_ms ?? -1),
    at_grant,
    "and the store holds the same number, so the constancy is the Hold's and not the projection's",
  );

  /* ── 4 · The increase is unwritable, not merely unwritten ─────────────── */

  const by_agent = await refusedBy(() =>
    bench.db.transaction(
      (tx) => tx.query("update hold set floor_ms = floor_ms + 60000 where hold_id = $1", [hold_id]),
      { role: "changeover_agent" },
    ),
  );
  c.that(
    "floor_ms_ungrantable",
    by_agent.startsWith(SQLSTATE.insufficient_privilege),
    `the agent role cannot write floor_ms at all (${by_agent}): the column is absent from its UPDATE grant, so T1's immovability does not depend on no code trying`,
  );

  // BACKWARDS, deliberately. Pushing floor_deadline forward trips
  // `hold_expiry_not_before_floor` first — expires_at would be inside the new
  // deadline — and the clause would then pass while asserting a different
  // constraint from the one it names.
  const derived = await refusedBy(() =>
    bench.db.query(
      "update hold set floor_deadline = floor_deadline - interval '1 minute' where hold_id = $1",
      [hold_id],
    ),
  );
  c.that(
    "floor_derived_enforced",
    derived.startsWith(SQLSTATE.check_violation) && derived.includes("hold_floor_derived"),
    `and moving floor_deadline away from granted_at + floor_ms is refused by the store even as its owner (${derived})`,
  );

  const extend_routes = ROUTES.filter((r) => /extend|renew|prolong/i.test(r.pattern) || /extend|renew/i.test(r.name));
  c.is(
    "no_extend_verb",
    extend_routes.length,
    0,
    `and §6.3 declares ${ROUTES.length} routes of which none extends a Hold — there is no extend verb for a floor to grow through, which is the third independent reason this holds`,
  );

  /* ── 5 · expires_at >= floor_deadline, always ─────────────────────────── */

  const shortened = await refusedBy(() =>
    bench.db.query(
      "update hold set expires_at = floor_deadline - interval '1 second' where hold_id = $1",
      [hold_id],
    ),
  );
  c.that(
    "expiry_check_enforced",
    shortened.startsWith(SQLSTATE.check_violation) && shortened.includes("hold_expiry_not_before_floor"),
    `and an UPDATE that would put expires_at one second inside the floor is refused by the store (${shortened}), so T2 is a constraint and not a convention`,
  );

  /* ── 6 · owned_store hard-fails at ONE violation ──────────────────────── */
  //
  // The verdict is §7's own sentence, applied to a number this class measured:
  // under `owned_store` a single violation fails, and there is no rate to hide
  // it in. Counted the way C-REVOKE counts it — a Hold that stopped holding
  // before its floor deadline with no revocation_reason — so the two classes
  // cannot disagree about what a violation is.

  const count = async (): Promise<{ violations: number; overrides: number }> => {
    const result = await bench.db.query<{ violations: string; overrides: string }>(
      "select count(*) filter (where h.revocation_reason is null)::text as violations," +
        " count(*) filter (where h.revocation_reason is not null)::text as overrides" +
        " from hold h where h.principal_scope = $1" +
        "   and h.floor_deadline > clock_timestamp()" +
        "   and not exists (select 1 from hold_seat s where s.hold_id = h.hold_id" +
        "                     and s.state in ('live', 'handed_off', 'claimed'))",
      [CREDENTIAL_A.principal_scope],
    );
    return {
      violations: Number(result.rows[0]?.violations ?? 0),
      overrides: Number(result.rows[0]?.overrides ?? 0),
    };
  };

  const clean = await count();
  const verdict = (basis: string, n: number): string =>
    basis === "owned_store" ? (n === 0 ? "pass" : "fail") : "reported as a rate";
  c.is(
    "owned_store_clean",
    verdict(String(document.floor_basis), clean.violations),
    "pass",
    `this Server publishes floor_basis ${document.floor_basis} and ${clean.violations} of its Holds stopped holding inside their floor, so the class passes on the evidence rather than by default`,
  );

  await bench.db.query(
    "update hold_seat set state = 'released' where hold_id = $1",
    [hold_id],
  );
  const dirty = await count();
  c.is(
    "owned_store_hard_fails",
    verdict(String(document.floor_basis), dirty.violations),
    "fail",
    `one Hold whose seats stopped holding ${Math.round((at_grant) / 1000)}s inside its floor is enough: under owned_store there is no rate for a single violation to be small in (${dirty.violations} counted)`,
  );

  /* ── 7 · operator_overrides, on the other side of the same split ──────── */

  const overridden = await grantHold(bench, TOKEN.a, ["F:1"], {}, `floor-override-${bench.nonce}`);
  const overridden_id = String((overridden.json as { hold_id: string }).hold_id);
  const override = await bench.call("POST", `/changeover/v0/holds/${overridden_id}/revoke`, {
    token: TOKEN.operator,
    body: { revocation_reason: "safety" },
  });
  const after_override = await count();
  c.that(
    "override_not_a_violation",
    override.status === 200 && after_override.violations === dirty.violations,
    `an Operator Override took a Hold's seats inside its floor and floor_violations did not move (${dirty.violations} → ${after_override.violations}) — T1a counts it separately and it does not fail this class`,
  );
  c.is(
    "override_counted",
    after_override.overrides,
    1,
    "while operator_overrides did move, which is the whole point of keeping the two numbers apart: an honest exhibitor withdrawing seats must not read as non-conforming",
  );

  /* ── 8 · The data sweep, last, over every state this run produced ─────── */
  //
  // Run at the end rather than beside the constraint above, because by here the
  // store holds this principal's Holds in five different states — live, handed
  // off, replayed, seat-released and revoked — and the inequality is claimed of
  // all of them.

  const swept = await bench.db.query<{ n: string; bad: string; states: string }>(
    "select count(*)::text as n," +
      " count(*) filter (where expires_at < floor_deadline)::text as bad," +
      " count(*) filter (where handed_off_at is not null)::text as states" +
      " from hold where principal_scope = $1",
    [CREDENTIAL_A.principal_scope],
  );
  c.is(
    "expiry_not_before_floor",
    Number(swept.rows[0]?.bad ?? -1),
    0,
    `across every one of this principal's ${Number(swept.rows[0]?.n ?? 0)} Holds in the store, ${Number(swept.rows[0]?.states ?? 0)} of them handed off, not one carries expires_at below floor_deadline`,
  );

  /* ── 9 · The branch this specification cannot express ─────────────────── */

  c.cannot(
    "measured_warranty_rate",
    `§7 and T1a both require measured_warranty to report floor_violations as a rate "against a published threshold", and no member of the eight frozen document schemas publishes one: capability.schema.json carries floor_evidence.violations (a count from the measurement window, not a tolerance) and hold-policy.schema.json carries abandonment_floor_penalty_bp (X5's, about an agent's abandonment rate, not the Server's floor). With no publishable threshold there is nothing for a rate to be below, so the branch cannot be decided by any harness — including against a site that published measured_warranty, which this one does not`,
  );

  return c.items;
}
