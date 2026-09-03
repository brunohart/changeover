// What this adapter can and cannot prove about itself. Owner: ADAPT-001.
//
// §7 gives twenty-four conformance classes and three outcomes — `0` holds, `1`
// fails, **`2` cannot prove** — and says why the third exists: *the difference
// between "your server violated the floor" and "we could not reach your
// server."* This module is that distinction applied to the adapter's own
// surface, and it has exactly one rule:
//
//   **A class reports `pass` only when EVERY clause of its §7 row was executed
//   here.** Not most of it, not the interesting part of it. A class whose row
//   names a transport, a second independent implementation, a concurrent
//   writer, a dated report or a binding that is an empty directory reports
//   `unprovable`, names the missing thing, and — where the assertion already
//   lives somewhere in this repository — names that too.
//
// The rule costs something, and paying it is the point. On this tree the
// bindings, the harness and the reference Agent are empty directories, so almost
// every row is unprovable and the report says so twenty-three times. A report
// that instead passed the halves it could reach would be a green wall meaning
// "we could not get to most of this", which §7 calls worse than no suite.
//
// Two things keep "unprovable" from becoming a place to put work.
//
//   `blocked_by.asserted_by` names the proof script that already asserts the
//   part of the row that IS reachable, so a reader can tell "nobody has done
//   this" from "this is done, elsewhere, and the class needs a transport to see
//   it." `blocked_by.missing_path` names the artefact whose absence is the
//   reason, where the reason is an absence at all.
//
//   A blocker is phrased so that it stays TRUE. "The HTTP binding is an empty
//   directory" is a fact about a neighbour's Tuesday; "the origin a document is
//   served from is a property of a transport, and this adapter returns an
//   object" is a fact about this interface. Twenty-five agents are writing at
//   once, and a reason that expires when somebody else commits is a reason that
//   will be wrong before it is read.

import { readdirSync, statSync } from "node:fs";

import { isRefusal } from "@changeover/schema/refusal.ts";
import type { Rfc3339 } from "@changeover/schema/scalars.ts";
import { serverTime } from "@changeover/core/clock.ts";
import { HOLD_COLUMNS } from "@changeover/core/derived.ts";
import type { HoldRow } from "@changeover/core/derived.ts";
import type { ReferenceAdapter } from "./reference.ts";

/* ── 1 · The shape of an outcome ───────────────────────────────────────────── */

export const CLASS_STATUS = { pass: "pass", fail: "fail", unprovable: "unprovable" } as const;
export type ClassStatus = (typeof CLASS_STATUS)[keyof typeof CLASS_STATUS];

export interface ClassBlocker {
  /** Why this cannot be reached here. Never "not implemented"; name the thing. */
  readonly reason: string;
  /** A repository path whose absence or emptiness the proof re-checks. */
  readonly missing_path?: string;
  /** Where the assertion already lives, for the part of the row that is provable. */
  readonly asserted_by?: string;
}

export interface ConformanceClass {
  readonly id: string;
  /** §7's own words for this row, so the report is auditable against the source. */
  readonly spec_row: string;
  readonly blocked_by?: ClassBlocker;
  /** Returns the assertions that held. Throws to fail the class. */
  readonly run?: (adapter: ReferenceAdapter) => Promise<readonly string[]>;
}

export interface ClassReport {
  readonly class: string;
  readonly status: ClassStatus;
  /** REQUIRED on `unprovable` and on `fail`. Absent only on `pass`. */
  readonly reason?: string;
  readonly missing_path?: string;
  readonly asserted_by?: string;
  readonly assertions: readonly string[];
}

export interface AdapterConformanceReport {
  readonly changeover: "0.1";
  readonly profile: string;
  readonly hold_basis: string;
  readonly floor_basis: string;
  readonly run_at: Rfc3339;
  readonly classes: readonly ClassReport[];
  readonly counts: { readonly pass: number; readonly fail: number; readonly unprovable: number };
}

/* ── 2 · The register of classes ───────────────────────────────────────────── */

/** The dated report and the class modules of §7 live here, and it is empty. */
const NO_HARNESS = "packages/conformance/src";

export const CONFORMANCE_CLASSES: readonly ConformanceClass[] = Object.freeze([
  {
    id: "C-SCHEMA",
    spec_row:
      "Every emitted document validates; unknown members rejected on write, ignored on read.",
    blocked_by: {
      reason:
        "the write half — rejecting an unknown member in a REQUEST BODY — happens where bodies are parsed; this adapter is handed typed objects and never a body",
      asserted_by: "scripts/prove_spec_examples.sh, for the documents the specification itself prints",
    },
  },
  {
    id: "C-CAPABILITY",
    spec_row:
      "The document validates, is served from a venue-authorised origin, and no limit observed at runtime is absent from it.",
    blocked_by: {
      reason:
        "the origin a document is SERVED from is a property of a fetch; this adapter returns an object and there is no origin on it to check",
      asserted_by: "scripts/prove_reference_adapter.sh, for validation and for the unpublished-limit half",
    },
  },
  {
    id: "C-ETAG",
    spec_row:
      "Two independent implementations produce byte-identical JCS bytes and digest for a pinned golden fixture.",
    blocked_by: {
      reason:
        "the claim is that TWO independent implementations agree, and @changeover/schema has no projector, so only the harness one exists",
      missing_path: "packages/schema/src/project.ts",
      asserted_by: "scripts/prove_etag_golden.sh, against the harness projector alone",
    },
  },
  {
    id: "C-FLOOR",
    spec_row:
      "owned_store hard-fails at one violation; floor_ms never increases post-grant; expires_at ≥ floor_deadline; operator_overrides reported separately.",
    blocked_by: {
      reason:
        "the last clause needs an Operator Override to count and a dated report to count it in; neither the revoke surface nor the harness exists",
      missing_path: NO_HARNESS,
      asserted_by: "scripts/prove_reference_adapter.sh, for the warranty and the two inequalities",
    },
  },
  {
    id: "C-ATOMIC",
    spec_row:
      "200 concurrent holds on a 100-seat house: exactly 100 succeed, 100 typed 409, zero oversell, zero partial holds, zero 40P01.",
    blocked_by: {
      reason:
        "PGlite is single-connection and in-process, so contention and 40P01 cannot occur there and a pass would mean nothing; set CHANGEOVER_PG_URL",
      asserted_by: "scripts/prove_lock_order.sh, which exits 2 here for the same reason",
    },
  },
  {
    id: "C-BUDGET",
    spec_row: "max+1 concurrent holds at production defaults → exactly max succeed. Budgets bind in-transaction.",
    blocked_by: {
      reason: "'concurrent' is the whole assertion, and PGlite cannot produce two callers",
      asserted_by: "scripts/prove_no_fanout.sh and prove_no_fanout_concurrent.sh",
    },
  },
  {
    id: "C-FANOUT",
    spec_row:
      "Two concurrent same-cluster holds for one principal → exactly one; two principals on one platform → both.",
    blocked_by: {
      reason: "'concurrent' is the whole assertion, and PGlite cannot produce two callers",
      asserted_by: "scripts/prove_no_fanout_concurrent.sh",
    },
  },
  {
    id: "C-IDEMPOTENT",
    spec_row:
      "Replays carry identical identity and floor members with freshly projected time members; a different digest refuses and does not act.",
    blocked_by: {
      reason:
        "Idempotency-Key is a transport header and idempotency wraps a verb in the envelope around it; this adapter exposes the verbs, not the envelope",
      asserted_by: "scripts/prove_idempotent.sh",
    },
  },
  {
    id: "C-RELEASE",
    spec_row:
      "Total and idempotent in every state except handed_off, where it returns 409 handoff_consumed and does not free the seat; seats re-holdable within a measured bound.",
    blocked_by: {
      reason:
        "'every state' includes revoked, and no Operator Override surface exists in packages/core/src to produce one",
      missing_path: "packages/core/src/revoke.ts",
      asserted_by: "scripts/prove_release_total.sh, over the states a fixture can mint",
    },
  },
  {
    id: "C-ORPHAN",
    spec_row:
      "With the sweeper disabled and the client SIGKILLed, seats and budgets return via the next contending transaction.",
    blocked_by: {
      reason: "'the next CONTENDING transaction' is a second connection, which PGlite does not have",
      asserted_by: "scripts/prove_expiry_without_sweeper.sh (TEST-003, not yet written)",
    },
  },
  {
    id: "C-REVOKE",
    spec_row:
      "An Override transitions to revoked, records a reason, refuses agent verbs 409 hold_revoked, and increments operator_overrides.",
    blocked_by: {
      reason: "the Operator Override surface is not built",
      missing_path: "packages/core/src/revoke.ts",
    },
  },
  {
    id: "C-SUBST",
    spec_row:
      "The Server emits the transitive closure of the authored rules; maximalAntichain matches a reference oracle; a hold crossing a strict boundary returns 412 and writes no hold_seat row.",
    blocked_by: {
      reason:
        "this adapter publishes no substitution policy, so there is no strict boundary in its estate for a hold to cross",
      asserted_by: "scripts/prove_antichain.sh and prove_policy_derive.sh",
    },
  },
  {
    id: "C-SEATMAP",
    spec_row:
      "The seat map validates, is same-origin, is credentialed, and its ids are accepted by hold_seats.",
    blocked_by: {
      reason:
        "'same-origin' is a property of the URL a seat map was fetched from, and this adapter returns an object rather than serving one",
      asserted_by: "scripts/prove_reference_adapter.sh, for validation and for the id agreement",
    },
  },
  {
    id: "C-CLAIM",
    spec_row:
      "GET {claim_url} is prefetch-safe and does not consume; a second confirm returns claim_consumed; an expired claim renders a typed outcome naming the Occasion.",
    blocked_by: {
      reason:
        "the claim endpoint is the exhibitor's own surface and is deliberately not an adapter verb — there is nothing here to drive it through",
      asserted_by: "scripts/prove_claim_prefetch_safe.sh and prove_claim_confirm_race.sh",
    },
  },
  {
    id: "C-ORIGIN",
    spec_row:
      "Every absolute URL is same-origin with venue.origin or a delegated origin; a cross-origin redirect on the well-known path is refused.",
    blocked_by: {
      reason: "'a cross-origin redirect on the well-known path' is a transport event, and an in-process call cannot redirect",
      asserted_by: "scripts/prove_reference_adapter.sh, for the same-origin half over emitted documents",
    },
  },
  {
    id: "C-AUTHZ",
    spec_row:
      "With two credentials on one site, every verb by B against A's Hold returns 404 and the store shows no state change.",
    run: runAuthz,
  },
  {
    id: "C-ABSENCE",
    spec_row:
      ".1 no settlement verb anywhere. .2 member manifest set equality. .3 the SET LOCAL ROLE kill test raises insufficient_privilege. .4 outbound byte canary.",
    blocked_by: {
      reason:
        ".2 is member-manifest set equality against the eight document schemas, which the frozen scripts/prove_member_manifest.sh owns and this adapter does not re-implement",
      asserted_by: "scripts/prove_no_settlement_verb.sh, prove_member_manifest.sh, and prove_reference_adapter.sh for .1 and .4",
    },
  },
  {
    id: "C-PII-INGEST",
    spec_row:
      "Email-, phone- and PAN-shaped work_hint are each refused, and a full scan of the access log after a poisoned run matches none of those patterns.",
    blocked_by: {
      reason:
        "work_hint arrives on the access-log path, which this adapter does not sit in front of; P1 ingest is refused at the boundary CORE-007 owns",
      asserted_by: "scripts/prove_pii_ingest.sh",
    },
  },
  {
    id: "C-INJECT",
    spec_row:
      ".1 every URL in every emitted document is same-origin. .2 with poisoned prose the etag is byte-identical to the unpoisoned run. .3 prose bytes are within Q1.",
    blocked_by: {
      reason: ".2 needs a poisoned fixture pair and fixtures/poisoned/ has not been written",
      missing_path: "fixtures/poisoned",
      asserted_by: "scripts/prove_etag_golden.sh, for the prose-only-edit half",
    },
  },
  {
    id: "C-REFUSE",
    spec_row:
      "Refusals never mixed with rows; guard order per G1; every refusal validates against its code's closed detail branch; a refusal carrying an extra member is rejected by the reference Agent.",
    blocked_by: {
      reason: "the last clause names a reference Agent, and no Agent has been written",
      missing_path: "packages/agent",
      asserted_by: "scripts/prove_guard_order.sh and prove_refusals_closed.sh",
    },
  },
  {
    id: "C-CLOCK",
    spec_row:
      "server_time on every response and non-decreasing per hold; no request accepts a client timestamp; DST-fold and DST-gap fixtures.",
    blocked_by: {
      reason: "the DST fold and gap fixtures have not been written",
      missing_path: "fixtures/dst",
      asserted_by: "scripts/prove_grant_clock.sh",
    },
  },
  {
    id: "C-LOG",
    spec_row:
      "One row per invocation including refusals; fail-closed on writes; UPDATE/DELETE denied to the agent role; partition detach permitted only to changeover_retention.",
    blocked_by: {
      reason:
        "'one row per INVOCATION' counts arrivals at a boundary, and an in-process method call is not an arrival",
      asserted_by: "scripts/prove_access_log.sh",
    },
  },
  {
    id: "C-USAGE",
    spec_row: "usage_policy present and honoured by the reference Agent.",
    blocked_by: {
      reason: "'honoured by' is a property of an Agent, and no Agent has been written",
      missing_path: "packages/agent",
      asserted_by: "scripts/prove_reference_adapter.sh, for the presence half",
    },
  },
  {
    id: "C-PROFILE0",
    spec_row:
      "The static file validates, serves from a venue-authorised origin, and hold verbs return 501.",
    blocked_by: {
      reason:
        "this adapter is Profile 1; the class is about a Profile 0 publication and ADAPT-003 has not been built",
      missing_path: "packages/adapter-probe",
    },
  },
]);

/* ── 3 · Load-time invariant: exactly one of run / blocked_by ──────────────── */
//
// Asserted at import rather than in a test, because the failure it prevents is a
// class that silently reports nothing — and a class that reports nothing looks
// exactly like a class that passed, in a list long enough that nobody counts.

for (const entry of CONFORMANCE_CLASSES) {
  const has_run = typeof entry.run === "function";
  const has_blocker = entry.blocked_by !== undefined;
  if (has_run === has_blocker) {
    throw new Error(
      `adapter-reference: conformance class ${entry.id} must have EXACTLY one of run / blocked_by`,
    );
  }
  if (has_blocker && (entry.blocked_by as ClassBlocker).reason.trim().length === 0) {
    throw new Error(`adapter-reference: conformance class ${entry.id} is blocked for no stated reason`);
  }
}

/* ── 4 · Running the report ────────────────────────────────────────────────── */

/**
 * Run every class this adapter can run, and report the rest as unprovable.
 *
 * A runner that throws produces `fail`, with the thrown message as the reason.
 * There is no path from a throw to a `pass` and no path from a blocker to one
 * either: `status` is derived from which of the two branches produced the entry,
 * never assigned.
 */
export async function reportConformance(
  adapter: ReferenceAdapter,
): Promise<AdapterConformanceReport> {
  const run_at = await serverTime(adapter.db);
  const classes: ClassReport[] = [];

  for (const entry of CONFORMANCE_CLASSES) {
    if (entry.blocked_by !== undefined) {
      classes.push({
        class: entry.id,
        status: CLASS_STATUS.unprovable,
        reason: entry.blocked_by.reason,
        ...(entry.blocked_by.missing_path === undefined
          ? {}
          : { missing_path: entry.blocked_by.missing_path }),
        ...(entry.blocked_by.asserted_by === undefined
          ? {}
          : { asserted_by: entry.blocked_by.asserted_by }),
        assertions: [],
      });
      continue;
    }
    try {
      const assertions = await (entry.run as NonNullable<ConformanceClass["run"]>)(adapter);
      classes.push({ class: entry.id, status: CLASS_STATUS.pass, assertions: [...assertions] });
    } catch (err) {
      classes.push({
        class: entry.id,
        status: CLASS_STATUS.fail,
        reason: err instanceof Error ? err.message : String(err),
        assertions: [],
      });
    }
  }

  return {
    changeover: "0.1",
    profile: adapter.profile,
    hold_basis: adapter.hold_basis,
    floor_basis: adapter.floor_basis,
    run_at,
    classes,
    counts: {
      pass: classes.filter((c) => c.status === CLASS_STATUS.pass).length,
      fail: classes.filter((c) => c.status === CLASS_STATUS.fail).length,
      unprovable: classes.filter((c) => c.status === CLASS_STATUS.unprovable).length,
    },
  };
}

/** True where a named blocker path is genuinely absent or an empty directory. */
export function blockerPathIsStillMissing(repo_root: string, path: string): boolean {
  const full = `${repo_root.replace(/\/$/, "")}/${path}`;
  try {
    const stat = statSync(full);
    if (!stat.isDirectory()) return false;
    return readdirSync(full).length === 0;
  } catch {
    return true;
  }
}

/* ── 5 · The one class this adapter can run end to end ─────────────────────── */

/**
 * C-AUTHZ — Z1, over every verb that addresses a `hold_id`.
 *
 * > For every verb addressing a `hold_id`, a Server MUST verify the Hold's
 * > `(agent_id, principal_scope)` equals the credential's, and on mismatch MUST
 * > return `404 hold_not_found` — **never `403`**, so the surface is not an
 * > existence oracle.
 *
 * The store snapshot on either side is the half a response-shaped assertion
 * cannot make: a Server that refused correctly and released the seats anyway
 * would satisfy every check about the 404 and none of the ones that matter.
 */
async function runAuthz(adapter: ReferenceAdapter): Promise<readonly string[]> {
  const house = adapter.house;
  if (house === null) {
    throw new Error("C-AUTHZ needs a house to hold seats in and this adapter seeded none");
  }
  const a = { agent_id: "agt_authz_a", principal_scope: "prn_authz_a" };
  const b = { agent_id: "agt_authz_b", principal_scope: "prn_authz_b" };
  const held: string[] = [];

  const seats = await freeSeat(adapter, house.occasion_id);
  const hold = await adapter.holdSeats(
    {
      occasion_id: house.occasion_id,
      occasion_etag: house.etag,
      sought: { occasion_id: house.occasion_id, occasion_etag: house.etag },
      seats,
      requested_floor_ms: 60000,
    },
    a,
  );
  const read = await adapter.getHold(hold.hold_id, a);
  const before = await holdSnapshot(adapter, hold.hold_id);
  held.push("A holds a seat and can read it back");

  // Every verb addressing a hold_id, by B. `hand_off` carries A's read_token
  // deliberately: a valid token must not make an unowned Hold addressable, and
  // a `409 stale_read` here would mean Z1 ran second.
  const attempts: { verb: string; call: () => Promise<unknown> }[] = [
    { verb: "get_hold", call: () => adapter.getHold(hold.hold_id, b) },
    { verb: "release_hold", call: () => adapter.releaseHold(hold.hold_id, b) },
    {
      verb: "hand_off",
      call: () => adapter.handOff({ hold_id: hold.hold_id, read_token: read.read_token as string }, b),
    },
  ];

  for (const attempt of attempts) {
    let code: string | null = null;
    try {
      await attempt.call();
    } catch (err) {
      if (!isRefusal(err)) throw err;
      code = err.code;
    }
    if (code === null) throw new Error(`C-AUTHZ: ${attempt.verb} by B against A's Hold did not refuse`);
    if (code !== "hold_not_found") {
      throw new Error(
        `C-AUTHZ: ${attempt.verb} by B refused ${code}; Z1 requires hold_not_found so the surface is not an existence oracle`,
      );
    }
    held.push(`${attempt.verb} by B against A's Hold refuses 404 hold_not_found`);
  }

  const after = await holdSnapshot(adapter, hold.hold_id);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("C-AUTHZ: the store changed under a refused verb");
  }
  held.push("the hold row is byte-identical before and after all three refusals");

  const seat_rows = await adapter.db.query<{ n: string }>(
    "select count(*)::text as n from hold_seat where hold_id = $1 and state in ('live','handed_off','claimed')",
    [hold.hold_id],
  );
  if (Number(seat_rows.rows[0]?.n ?? 0) !== seats.length) {
    throw new Error("C-AUTHZ: A's seats did not survive B's release attempt");
  }
  held.push("A's seats are still A's");

  await adapter.releaseHold(hold.hold_id, a);
  return held;
}

/**
 * A seat that is free **right now**, asked of the store rather than of the seed.
 *
 * `availableSeatIds(seed, 1)` returns the exhibitor's first available seat,
 * which is the right question for a fresh house and the wrong one for an
 * adapter something else has already held against. A class that failed because
 * an earlier caller took A:1 would be a class reporting a bug in its own setup
 * as a bug in Z1.
 */
async function freeSeat(adapter: ReferenceAdapter, occasion_id: string): Promise<string[]> {
  const r = await adapter.db.query<{ seat_id: string }>(
    "select s.seat_id from occasion_seat s join occasion o on o.occasion_id = s.occasion_id" +
      " where s.occasion_id = $1 and s.status = 'available'" +
      " and not exists (select 1 from hold_seat hs where hs.showtime_id = o.showtime_id" +
      "   and hs.seat_id = s.seat_id and hs.state in ('live','handed_off','claimed'))" +
      " order by s.seat_id asc limit 1",
    [occasion_id],
  );
  const seat_id = r.rows[0]?.seat_id;
  if (seat_id === undefined) throw new Error(`C-AUTHZ: no free seat remains in ${occasion_id}`);
  return [seat_id];
}

async function holdSnapshot(adapter: ReferenceAdapter, hold_id: string): Promise<HoldRow | null> {
  const r = await adapter.db.query<HoldRow>(`select ${HOLD_COLUMNS} from hold where hold_id = $1`, [
    hold_id,
  ]);
  return r.rows[0] ?? null;
}
