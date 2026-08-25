/**
 * Derived state. SPEC.md §4.6 (M1–M3) and the transition table of §4.9.
 *
 * Owner: CORE-003.
 *
 * **There is no `state` column on `hold`, and this module is why there does not
 * need to be one.** The reap of §4.6 deletes seat rows in whichever transaction
 * next contends for them; it does not transition the Hold. *"A stored `state`
 * column is a lie the moment a reap runs elsewhere."* Worse, under ADR-006 no
 * sweeper runs at all, so for an abandoned Hold — the common case — nobody
 * contends the seats and nobody ever writes the transition. A stored column
 * would report `live` for as long as that lasts, which is precisely what M1
 * forbids:
 *
 * > **M1.** `state` is derived at every read … **A Server MUST NOT report
 * > `live` for a Hold whose `expires_at` has passed, regardless of whether any
 * > reap has run.**
 *
 * So the derivation is a pure function of six columns and one instant, and the
 * absence of the column is what makes the alternative *unavailable* rather than
 * merely discouraged. `scripts/prove_derived_state.sh` asserts that absence
 * against `information_schema.columns`, not against behaviour: behaviour can be
 * correct today and a migration can add the column tomorrow.
 *
 * **M2 — `seats` is the grant, not current occupancy.** A Hold reports the seat
 * identifiers *as granted* for the life of the record, in every state, and they
 * come from `hold.seats` — never from a count over `hold_seat`. After a reap
 * there are no `hold_seat` rows at all, and `hold.schema.json` says `seats` is
 * `minItems: 1`: report occupancy and the document becomes unrepresentable at
 * exactly the moment an Agent most needs to read it.
 *
 * **M3 — the expensive half.** Every budget and cluster predicate is evaluated
 * against derived state. *"A `count(*) WHERE state='live'` over a stored column
 * counts expired holds forever and locks an Agent out of a showtime after two
 * abandoned holds."* {@link derivedStateSql} is the same derivation as
 * {@link deriveState}, written once as SQL, so a guard counting in the database
 * and a document rendered in TypeScript cannot disagree about what `live` means.
 */

import type { Queryable, Row } from "@changeover/store/db.ts";
import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";
import { REAP_CLOCK, rfc3339Column } from "./clock.ts";

/* ── 1 · The six states ────────────────────────────────────────────────────── */

/**
 * `hold.schema.json`'s `state` enum, and the rows of §4.9's transition table.
 * `claimed` and `revoked` are terminal.
 */
export const HOLD_STATE = {
  live: "live",
  handed_off: "handed_off",
  claimed: "claimed",
  released: "released",
  expired: "expired",
  revoked: "revoked",
} as const;

export type HoldState = (typeof HOLD_STATE)[keyof typeof HOLD_STATE];

/** The enum, in the schema's own order. */
export const HOLD_STATES: readonly HoldState[] = Object.freeze(
  Object.keys(HOLD_STATE) as HoldState[],
);

/**
 * The states that occupy a seat, §4.6. `claimed` is in the set deliberately: it
 * is terminal, it occupies its seat for the life of the screening, and a Server
 * **MUST NOT** reap it. This is the predicate of `hold_seat_occupied`.
 */
export const SEAT_OCCUPYING_STATES: readonly HoldState[] = Object.freeze([
  HOLD_STATE.live,
  HOLD_STATE.handed_off,
  HOLD_STATE.claimed,
]);

export function occupiesSeat(state: HoldState): boolean {
  return SEAT_OCCUPYING_STATES.includes(state);
}

/** §4.9: `claimed` and `revoked` are terminal — no event moves them anywhere. */
export function isTerminal(state: HoldState): boolean {
  return state === HOLD_STATE.claimed || state === HOLD_STATE.revoked;
}

/* ── 2 · M1, as a function of columns and one instant ──────────────────────── */

/**
 * Every input M1 names, and nothing else. All six are columns on `hold`; none
 * of them is a `state`. `null` and `undefined` are both read as absence, so a
 * row from either driver can be handed here without a shim.
 */
export interface HoldFacts {
  readonly expires_at: Rfc3339;
  readonly claim_expires_at?: Rfc3339 | null;
  readonly handed_off_at?: Rfc3339 | null;
  readonly released_at?: Rfc3339 | null;
  readonly claimed_at?: Rfc3339 | null;
  readonly revoked_at?: Rfc3339 | null;
}

/**
 * M1, in the specification's own precedence, evaluated against a `server_time`
 * the caller took from the database (K4 — one time source, and it is not this
 * process's wall clock).
 *
 *   revoked → released → claimed → handed_off (while `server_time <
 *   claim_expires_at`) → live (while `server_time < expires_at`) → expired
 *
 * The order is not a style choice. A Hold that was handed off and then revoked
 * by an Operator Override is `revoked` and refuses every agent verb `409
 * hold_revoked`; read the deadlines first and it would report `handed_off` and
 * accept a claim against seats the duty manager has already sold from the box
 * office.
 *
 * The fall-through at the end is what M1's last clause makes mandatory: a
 * `handed_off` Hold past `claim_expires_at` is `expired`, and since T6 holds
 * `claim_expires_at ≥ expires_at` for the life of the record, it cannot fall
 * back into `live` on the way there.
 */
export function deriveState(facts: HoldFacts, server_time: Rfc3339): HoldState {
  if (present(facts.revoked_at)) return HOLD_STATE.revoked;
  if (present(facts.released_at)) return HOLD_STATE.released;
  if (present(facts.claimed_at)) return HOLD_STATE.claimed;
  if (present(facts.handed_off_at) && before(server_time, facts.claim_expires_at)) {
    return HOLD_STATE.handed_off;
  }
  if (before(server_time, facts.expires_at)) return HOLD_STATE.live;
  return HOLD_STATE.expired;
}

/**
 * T6's projection of the seat's effective deadline: `expires_at` while `live`,
 * `claim_expires_at` while `handed_off`. It is a column on `hold_seat` because
 * a partial index predicate must be IMMUTABLE and `held_until > now()` is not —
 * but the value it must carry is this one, and the Server sets it in the same
 * transaction as the transition.
 */
export function heldUntil(facts: HoldFacts, server_time: Rfc3339): Rfc3339 {
  return deriveState(facts, server_time) === HOLD_STATE.handed_off && present(facts.claim_expires_at)
    ? (facts.claim_expires_at as Rfc3339)
    : facts.expires_at;
}

/**
 * Milliseconds of floor remaining at `server_time`, never negative.
 *
 * K1 belongs to the Agent and this is not it: the Agent computes remaining time
 * from `server_time` plus its own monotonic elapsed, because a value the Server
 * computes is already stale when it arrives. This exists for the Server's own
 * guards and for tests, and takes `floor_deadline` rather than `expires_at`
 * because the floor is the only cue mark anyone may plan against (T4).
 */
export function floorRemainingMs(floor_deadline: Rfc3339, server_time: Rfc3339): DurationMs {
  const remaining = Date.parse(floor_deadline) - Date.parse(server_time);
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
}

function present(value: Rfc3339 | null | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

/** True where `instant` is strictly before `reference`; absence is never before. */
function before(instant: Rfc3339, reference: Rfc3339 | null | undefined): boolean {
  if (!present(reference)) return false;
  const a = Date.parse(instant);
  const b = Date.parse(reference as string);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new Error("derived: an instant that is not RFC 3339 reached deriveState");
  }
  return a < b;
}

/* ── 3 · M3, as SQL, so a guard and a document agree ───────────────────────── */

/**
 * The same six-branch precedence as {@link deriveState}, as an SQL expression
 * over a `hold` row.
 *
 * M3 requires every budget and cluster predicate to be evaluated against
 * derived state, and the only way to do that inside the transaction that must
 * enforce it (N1) is to compute it in the statement. Written twice by hand it
 * would drift; written here once, `prove_derived_state.sh` asserts the two
 * agree on the same rows.
 *
 * `alias` and `clock` are compile-time constants at every call site — a table
 * alias and one of `clock.ts`'s two named clocks. Nothing user-influenced
 * reaches either, and nothing user-influenced may be made to: that is what `$1`
 * is for. `clock` defaults to the **reap clock** (`now()`, transaction start),
 * so a guard counting live Holds and the reap that frees their seats evaluate
 * against exactly one instant and cannot disagree about a Hold on the boundary.
 */
export function derivedStateSql(alias: string = "hold", clock: string = REAP_CLOCK): string {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return (
    "case" +
    ` when ${column("revoked_at")} is not null then 'revoked'` +
    ` when ${column("released_at")} is not null then 'released'` +
    ` when ${column("claimed_at")} is not null then 'claimed'` +
    ` when ${column("handed_off_at")} is not null and ${clock} < ${column("claim_expires_at")} then 'handed_off'` +
    ` when ${clock} < ${column("expires_at")} then 'live'` +
    " else 'expired' end"
  );
}

/**
 * A predicate over the derived state, for the `where` clause of a budget count.
 *
 * `countLiveHolds()` written as `where state = 'live'` is the mistake M3 names.
 * Written as `where ${derivedStateIn(["live"])}` it is the same length and
 * cannot count an expired Hold, because there is no column that could hold a
 * stale answer.
 *
 * The states are validated against the closed set rather than interpolated on
 * trust: this is a string reaching SQL, and the one discipline that makes that
 * safe is that it can only ever be one of six literals.
 */
export function derivedStateIn(
  states: readonly HoldState[],
  alias: string = "hold",
  clock: string = REAP_CLOCK,
): string {
  if (states.length === 0) return "false";
  const literals = states.map((state) => {
    if (!HOLD_STATES.includes(state)) {
      throw new Error(`derived: ${JSON.stringify(state)} is not one of the six states`);
    }
    return `'${state}'`;
  });
  return `(${derivedStateSql(alias, clock)}) in (${literals.join(", ")})`;
}

/* ── 4 · Reading a Hold back, once, in one shape ───────────────────────────── */

/**
 * A `hold` row with every instant already rendered as RFC 3339 text.
 *
 * Never through a `Date`: Postgres `timestamptz` carries microseconds and a
 * JavaScript `Date` carries milliseconds, so a round trip truncates
 * `granted_at` and `floor_deadline = granted_at + floor_ms` stops being true of
 * the values the wire carries while remaining true of the values the CHECK
 * saw. `clock.ts`'s `rfc3339Column` renders inside the query instead.
 */
export interface HoldRow extends Row {
  hold_id: string;
  agent_id: string;
  principal_scope: string;
  origin: string;
  cluster: string | null;
  occasion_id: string;
  occasion_etag: string;
  sought_occasion_id: string;
  showtime_id: string;
  seats: string[];
  granted_at: Rfc3339;
  floor_ms: number;
  floor_deadline: Rfc3339;
  expires_at: Rfc3339;
  handed_off_at: Rfc3339 | null;
  handoff_floor_ms: number | null;
  claim_expires_at: Rfc3339 | null;
  released_at: Rfc3339 | null;
  claimed_at: Rfc3339 | null;
  revoked_at: Rfc3339 | null;
  revocation_reason: string | null;
  read_token_hmac: string | null;
  read_token_at: Rfc3339 | null;
}

/** Every column of `hold`, with the eleven instants rendered as RFC 3339 text. */
export const HOLD_COLUMNS: string = [
  "hold_id",
  "agent_id",
  "principal_scope",
  "origin",
  "cluster",
  "occasion_id",
  "occasion_etag",
  "sought_occasion_id",
  "showtime_id",
  "seats",
  rfc3339Column("granted_at"),
  "floor_ms",
  rfc3339Column("floor_deadline"),
  rfc3339Column("expires_at"),
  rfc3339Column("handed_off_at"),
  "handoff_floor_ms",
  rfc3339Column("claim_expires_at"),
  rfc3339Column("released_at"),
  rfc3339Column("claimed_at"),
  rfc3339Column("revoked_at"),
  "revocation_reason",
  "read_token_hmac",
  rfc3339Column("read_token_at"),
].join(", ");

/**
 * M2: the seats **as granted**, from the `hold` row, for the life of the record.
 *
 * A one-line function rather than a property access, because the mistake it
 * exists to prevent is not a typo — it is the entirely reasonable-looking
 * `select seat_id from hold_seat where hold_id = $1`, which returns an empty
 * array after a reap and produces a Hold document that its own schema rejects.
 * Nothing in this package reads seats from `hold_seat`, and a grep for
 * `seatsAsGranted` says where they are read from instead.
 */
export function seatsAsGranted(row: Pick<HoldRow, "seats">): readonly string[] {
  return Object.freeze([...row.seats]);
}

/**
 * How many seat rows this Hold still occupies. Diagnostic only — never the
 * source of `seats` (M2), and never the source of `state` (M1).
 */
export async function occupiedSeatCount(tx: Queryable, hold_id: string): Promise<number> {
  const result = await tx.query<{ n: string }>(
    "select count(*)::text as n from hold_seat where hold_id = $1 and state in ('live', 'handed_off', 'claimed')",
    [hold_id],
  );
  return Number(result.rows[0]?.n ?? 0);
}
