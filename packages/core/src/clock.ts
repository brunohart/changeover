/**
 * The clock. SPEC.md §4.4 (K1–K6) and the arithmetic of §4.3 (T1–T7).
 *
 * Owner: CORE-002.
 *
 * **K4 is the rule this module exists to make unbreakable.** Every timestamp a
 * Hold is built from — `granted_at`, `floor_deadline`, `expires_at`,
 * `claim_expires_at`, every `server_time`, and the reap's evaluation instant —
 * comes from ONE time source, and that source is the database. Not
 * `Date.now()`, not a node's wall clock, not a value a request carried. *"An
 * API node whose clock leads the database by 400ms violates T1 by construction,
 * silently."* There is no `Date` anywhere in the grant path and there must not
 * be one: the moment a JavaScript clock enters the arithmetic, K4 is a comment.
 *
 * **Two clocks, and choosing the wrong one is invisible.** Postgres has two,
 * and SPEC.md §4.6 assigns them by hand:
 *
 * | | what it returns | what it is for |
 * |---|---|---|
 * | `now()` / `transaction_timestamp()` | the instant the transaction began | the **reap** — it cannot reap a seat that was live when the transaction started |
 * | `clock_timestamp()` | the instant the expression is evaluated | the **grant** — `granted_at` is the instant the insert succeeds |
 *
 * *"A transaction spending 600ms in lock waits otherwise mints a floor already
 * 600ms in the past — a deficit falling entirely on the Agent's side, where
 * C-FLOOR can never see it."* That is the whole reason `GRANT_CLOCK` and
 * `REAP_CLOCK` are two named constants rather than one habit: a grep for
 * `now()` in the grant path has an answer, and `scripts/prove_grant_clock.sh`
 * asserts the difference is real by spending measurable time in the transaction
 * before the insert and watching `granted_at` move with it.
 *
 * **Reading a timestamp back.** Never through a `Date`. Postgres `timestamptz`
 * carries microseconds; a JavaScript `Date` carries milliseconds, so a
 * round-trip through one silently truncates `granted_at` — and then
 * `floor_deadline = granted_at + floor_ms` stops being true of the values the
 * wire carries, while remaining true of the values the CHECK constraint saw.
 * `rfc3339Sql()` renders the column to text **inside the query**, in RFC 3339
 * with a mandatory offset, at full stored precision.
 */

import type { Queryable } from "@changeover/store/db.ts";
import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";

/* ── 1 · The two clocks, named ─────────────────────────────────────────────── */

/**
 * The grant clock. SPEC.md §4.6: `granted_at` **MUST** be `clock_timestamp()`
 * at the instant the insert succeeds, with `floor_deadline` and `held_until`
 * derived from it.
 *
 * Evaluate it **once** per statement, in a `FROM (select clock_timestamp() …)`
 * subquery, and reference the resulting column. `clock_timestamp()` is VOLATILE:
 * two bare calls in one statement are two readings of the clock, and
 * `hold_floor_derived` — `floor_deadline = granted_at + floor_ms` — is a CHECK,
 * so two readings that differ by a microsecond are a `23514` on the grant path.
 * See {@link GRANT_CLOCK_SUBQUERY}.
 */
export const GRANT_CLOCK = "clock_timestamp()";

/**
 * The reap clock. SPEC.md §4.6: `now()` — transaction-start — is correct for
 * the reap, "which then cannot reap a seat that was live when the transaction
 * began". Using `clock_timestamp()` here would let a long transaction reap a
 * seat that outlived its own snapshot.
 */
export const REAP_CLOCK = "now()";

/**
 * The single-evaluation form of {@link GRANT_CLOCK}. Join it into a statement's
 * `FROM` and reference `changeover_grant_clock.now`; every reference is then a
 * column reference to one reading, not a second call.
 */
export const GRANT_CLOCK_SUBQUERY = `(select ${GRANT_CLOCK} as now) changeover_grant_clock`;

/* ── 2 · Rendering a stored instant onto the wire ──────────────────────────── */

/**
 * Wrap an SQL expression so it comes back as RFC 3339 text with a mandatory
 * offset, at the full precision Postgres stored — `2026-08-29T19:30:00.123456+12:00`.
 *
 * `to_json` on a `timestamptz` is Postgres's own ISO 8601 rendering and it always
 * carries the offset. `::text` does not: it emits a space separator and a
 * two-digit offset, which is not RFC 3339 and which an `ajv` `date-time` format
 * check rejects.
 *
 * `expression` is **always a compile-time constant** at every call site in this
 * package — a column name or a literal SQL fragment. Nothing user-influenced
 * reaches it, and nothing user-influenced may be made to: that is what `$1`
 * parameters are for.
 */
export function rfc3339Sql(expression: string): string {
  return `to_json(${expression})#>>'{}'`;
}

/** `select` list item rendering `column` as RFC 3339 text under its own name. */
export function rfc3339Column(column: string): string {
  return `${rfc3339Sql(column)} as ${column}`;
}

/**
 * The server's current instant, from the database, as RFC 3339.
 *
 * K4: one time source. Call this — never `new Date().toISOString()`. Inside a
 * transaction it reads the *grant* clock, so a `server_time` minted late in a
 * long transaction is the real instant and not the instant the transaction
 * began; K6 (non-decreasing across responses about one `hold_id`) then follows
 * from the database's own monotonic wall clock rather than from a promise.
 */
export async function serverTime(q: Queryable): Promise<Rfc3339> {
  const result = await q.query<{ server_time: string }>(
    `select ${rfc3339Sql(GRANT_CLOCK)} as server_time`,
  );
  const value = result.rows[0]?.server_time;
  if (typeof value !== "string") {
    throw new Error("clock: the store did not return a server_time");
  }
  return value;
}

/**
 * Milliseconds between two RFC 3339 instants, `b − a`.
 *
 * Millisecond resolution is deliberate and sufficient: every duration this
 * protocol reasons about is an integer of milliseconds, and the only comparisons
 * that use this helper are staleness and cutoff windows measured in seconds.
 * Nothing that must be exact — `floor_deadline`, `expires_at` — is ever computed
 * here; those are computed by the database, in one expression, from one reading.
 */
export function elapsedMs(a: Rfc3339, b: Rfc3339): DurationMs {
  const from = Date.parse(a);
  const to = Date.parse(b);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error("clock: an instant that is not RFC 3339 reached elapsedMs");
  }
  return to - from;
}

/** True where `instant` is at or before `reference`. Both RFC 3339. */
export function atOrAfter(instant: Rfc3339, reference: Rfc3339): boolean {
  return elapsedMs(instant, reference) >= 0;
}

/* ── 3 · The floor, and the two cue marks (T1–T3, X5) ──────────────────────── */

/**
 * The floor arithmetic of §4.3, in one place.
 *
 * `floor_ms = min(requested_floor_ms, policy_max_floor_ms)` and the Server
 * **MAY** return less — X5's `abandonment_floor_penalty_bp` is the one published
 * mechanism by which it does, and it is visible precisely because the granted
 * `floor_ms` is already returned and the policy is already published.
 *
 * Returns `null` where no floor of at least `HOLD_SCHEMA_MIN_FLOOR_MS` can be
 * minted. The caller refuses `503 floor_unavailable`: a Server that cannot honour
 * the minimum floor its own schema declares has no business granting a Hold, and
 * a Hold with `floor_ms` below 1000 is not a document `hold.schema.json` accepts.
 */
export function grantedFloorMs(
  requested_floor_ms: DurationMs,
  policy_max_floor_ms: DurationMs,
  abandonment_floor_penalty_bp: number = 0,
): DurationMs | null {
  const capped = Math.min(requested_floor_ms, policy_max_floor_ms);
  const penalised = Math.floor((capped * (10000 - clampBp(abandonment_floor_penalty_bp))) / 10000);
  if (!Number.isFinite(penalised) || penalised < HOLD_SCHEMA_MIN_FLOOR_MS) return null;
  return penalised;
}

function clampBp(bp: number): number {
  if (!Number.isFinite(bp)) return 0;
  return Math.min(10000, Math.max(0, Math.trunc(bp)));
}

/** `hold.schema.json`: `floor_ms` is an integer ≥ 1000. Also the store's CHECK. */
export const HOLD_SCHEMA_MIN_FLOOR_MS = 1000;

/**
 * `expires_at` at grant. T2: `expires_at ≥ floor_deadline`, always — at grant
 * and for the life of the Hold.
 *
 * The reference implementation grants them equal by default: the floor is the
 * commitment and everything above it is a merchant intention the Server may
 * raise later (T7, upward only) and an Agent may not plan against (T4). A
 * deployment that wants a longer soft expiry passes one; a value below the floor
 * is raised to it rather than refused, because T2 is the Server's obligation and
 * not the caller's.
 */
export function grantedExpiryMs(floor_ms: DurationMs, expiry_ms?: DurationMs): DurationMs {
  if (expiry_ms === undefined || !Number.isFinite(expiry_ms)) return floor_ms;
  return Math.max(floor_ms, Math.trunc(expiry_ms));
}

/**
 * `extendable` is `false`. Always, on every Hold, in every state.
 *
 * T3: a Server **MUST NOT** increase `floor_ms` or move `floor_deadline` after
 * grant by any mechanism; there is no `extend` verb and a Server **MUST NOT**
 * provide one. The member is a constant rather than a computation so that there
 * is no expression anywhere in this codebase that could evaluate to `true`.
 */
export const EXTENDABLE = false;
