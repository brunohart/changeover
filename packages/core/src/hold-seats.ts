/**
 * `hold_seats` — the load-bearing verb.
 *
 * Owner: CORE-002.
 *
 * Everything else in this repository is scaffolding around this being correct.
 * It is the only place a seat becomes committed, and the three things that make
 * it correct are carried as **data a proof can read** rather than as control
 * flow a reviewer has to trust:
 *
 *  - the guard order is {@link G1}, a table, and this module is a `for` loop
 *    over it (`./guards.ts`);
 *  - the lock sequence is the array {@link lockSeats} returns, decided
 *    in-process before any SQL is sent (`./locking.ts`);
 *  - the two clocks are two named constants, and the grant reads
 *    {@link GRANT_CLOCK} inside the insert itself (`./clock.ts`).
 *
 * **The shape of the transaction, and why it is this shape.**
 *
 * ```
 *   steps 1–2      from the request alone. No store is opened, so a malformed
 *                  request never costs a connection or a lock. (G1 `phase`.)
 *   ── BEGIN ──                                                          (N1)
 *   steps 3–7      reads. G1: "mutating no store state before the first six
 *                  pass" — and SPEC.md:433 names the draft's failure exactly:
 *                  "took locks and reaped rows before checking the etag."
 *   ── locks ──    lockSeats() over the FULL requested set, ascending C-
 *                  collation byte order, before any reap or insert.      (L1)
 *   ── reap ──     by HOLD, never by seat, under those locks, taking no
 *                  seat locks of its own.                            (L2, §4.8)
 *   steps 8–12     the writes. 8 and 12 are enforced by unique indexes a
 *                  concurrent transaction cannot bypass, never by a count.
 *   ── COMMIT ──
 * ```
 *
 * A refusal is **thrown**, never returned, which is what makes "a refusal MUST
 * NOT be mixed with rows; first failure wins" (§2.7) structural rather than a
 * discipline. A throw out of the transaction callback rolls the whole thing
 * back, so a refusal at step 10 leaves zero rows behind — including the hold
 * row step 8 needed in order to have anything to hang a cluster on.
 *
 * **What this module deliberately does not decide.** Three seams are declared
 * here and implemented elsewhere, because each is owned by another item and a
 * default invented here would be a limit this Server has not published (§2.5:
 * *"A Server MUST NOT enforce a limit it has not published"*):
 *
 *  - {@link BudgetGuard} — G1 step 9's exhaustion ceilings (X1/X3/X4). CORE-006.
 *  - {@link SeatRuleCheck} — W4's `seat_rule_violated`, which §4.6 calls "the
 *    exhibitor's own allocation logic". ADAPT-001.
 *  - {@link AvailabilitySource} — W3's system of record. The default reads the
 *    store, which is what `hold_basis: system_of_record` means at Profile 1;
 *    a Profile 1S shim supplies its CMS here.
 *
 * And one more, for the verb that wraps this one: {@link decisionMembers} is
 * I3's projection D for `hold_seats`, exported so CORE-005 digests the members
 * the specification names rather than re-deriving them from a body.
 */

import type { Db, Queryable, Row } from "@changeover/store/db.ts";
import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";
import { Refusal, refuse } from "@changeover/schema/refusal.ts";
import type { Axis } from "@changeover/semantics/poset.ts";
import { buildPoset, substitutionRefusal } from "@changeover/semantics/poset.ts";
import { candidateFromOccasion } from "@changeover/semantics/antichain.ts";
import { randomBytes } from "node:crypto";

import type { GuardName, HoldPolicyLimits } from "./guards.ts";
import {
  G1,
  G1_FIRST_WRITING_STEP,
  HOLD_POLICY_DEFAULTS,
  SEATS_WIRE_MAX,
  SEAT_ID_MAX_LENGTH,
  classify23505,
  occasionMoved,
  seatContended,
  seatUnavailable,
  unknownSeat,
} from "./guards.ts";
import {
  EXTENDABLE,
  GRANT_CLOCK_SUBQUERY,
  HOLD_SCHEMA_MIN_FLOOR_MS,
  elapsedMs,
  grantedExpiryMs,
  grantedFloorMs,
  rfc3339Column,
  serverTime,
} from "./clock.ts";
import { lockSeats, sortCSeats } from "./locking.ts";
import { requireValidIntentDigest } from "./access-log.ts";

/* ── 1 · The request, the credential, and the Hold ─────────────────────────── */

/** §4.6 W4. Seat choice within one named Occasion is the exhibitor's allocation. */
export interface Selection {
  readonly mode: "best_available";
  readonly quantity: number;
  readonly together?: boolean;
  readonly offer_id?: string;
}

/** §2.3: "the Occasion the customer's expressed intent selected". */
export interface Sought {
  readonly occasion_id: string;
  readonly occasion_etag: string;
}

export interface HoldSeatsRequest {
  readonly occasion_id: string;
  readonly occasion_etag: string;
  readonly sought: Sought;
  /** Exactly one of `seats` / `selection`. */
  readonly seats?: readonly string[];
  readonly selection?: Selection;
  readonly requested_floor_ms: DurationMs;
  /**
   * D4: accepted on input and **never echoed**. This module never reads it —
   * the returned document is assembled from an explicit member list, so there
   * is no path by which it could be. CORE-007 carries it to the access log.
   */
  readonly intent_digest?: string;
}

/**
 * I2/X0: every member is credential-derived and **never read from a body**.
 * That is why it is a separate argument rather than a member of the request.
 */
export interface Credential {
  readonly agent_id: string;
  /** X0. Absence is `403 principal_scope_missing`; an empty string is absence. */
  readonly principal_scope: string;
}

/** §2.6, `urn:changeover:schema:hold:0.1`. */
export interface HoldDocument {
  readonly changeover: "0.1";
  readonly hold_id: string;
  readonly state: "live";
  readonly occasion_id: string;
  readonly occasion_etag: string;
  readonly sought_occasion_id: string;
  readonly seats: readonly string[];
  readonly granted_at: Rfc3339;
  readonly floor_ms: DurationMs;
  readonly floor_deadline: Rfc3339;
  readonly expires_at: Rfc3339;
  readonly extendable: false;
  readonly agent_id: string;
  readonly cluster?: string;
  readonly server_time: Rfc3339;
}

/* ── 2 · The declared seams ────────────────────────────────────────────────── */

/**
 * W3's system of record, observed **inside** the hold transaction.
 *
 * §4.6: *"A Server whose hold path consults only its own `hold_seat` table does
 * not conform."* At Profile 1 the store defined here **is** the system of
 * record and {@link STORE_OF_RECORD} is the honest implementation of that. A
 * Profile 1S shim above a CMS supplies its own, and its `observed_at` is then a
 * real observation with a real age — which is the whole point of `staleness_basis`.
 */
export interface AvailabilityObservation {
  readonly mode: "seat_map" | "count" | "unknown";
  readonly observed_at: Rfc3339;
  readonly staleness_basis: "measured" | "configured" | "unknown";
  readonly max_staleness_ms?: DurationMs;
}

export interface AvailabilitySource {
  observe(tx: Queryable, occasion_id: string, server_time: Rfc3339): Promise<AvailabilityObservation>;
}

/**
 * G1 step 9 — X1/X3/X4. CORE-006 owns `budgets.ts` and implements this.
 *
 * `reserve` runs under the seat locks, inside the insert transaction, after the
 * hold row exists. N1 binds it: every ceiling it enforces must be enforced by a
 * **constraint or a lock a concurrent transaction cannot bypass** — the
 * `hold_slot` table exists for exactly that — and never by an unlocked
 * `SELECT count(*)`, which two requests three milliseconds apart both pass.
 */
export interface BudgetGuard {
  reserve(tx: Queryable, grant: BudgetContext): Promise<void>;
  /**
   * OPTIONAL. The read-only halves of G1 steps 8 and 9, for the one path on
   * which no Hold row will be inserted: a `selection: best_available` request
   * the house cannot fill. A guard that does not implement it simply does not
   * contribute to the order on that path, which is what every guard written
   * before 2026-08-26 already did.
   */
  probe?(tx: Queryable, grant: BudgetContext): Promise<void>;
}

/** What a budget guard is entitled to know. No prose, no personal data, no price. */
export interface BudgetContext {
  readonly agent_id: string;
  readonly principal_scope: string;
  readonly hold_id: string;
  readonly occasion_id: string;
  readonly showtime_id: string;
  readonly origin: string;
  readonly cluster: string | null;
  readonly capacity: number;
  readonly seat_ids: readonly string[];
}

/**
 * W4 — `409 seat_rule_violated {rule, suggested_seats}`. ADAPT-001 owns this.
 *
 * §4.6 puts it there in as many words: *"seat choice within one named Occasion
 * is the exhibitor's own allocation logic, which is where the compass wants
 * it."* An orphan-seat or gap policy invented at the boundary would refuse
 * legitimate holds at houses that do not have that policy, so the default
 * evaluates no rule and says so. Returning `null` means no rule was crossed.
 */
export interface SeatRuleCheck {
  check(tx: Queryable, grant: BudgetContext): Promise<Refusal | null>;
}

/**
 * I3's `D` for `hold_seats`: *"`{occasion_id, occasion_etag, sought, seats
 * sorted, selection, requested_floor_ms}`. Gate responses, `intent_digest`,
 * `read_token` and transport metadata including the key itself are excluded."*
 *
 * Exported so CORE-005 digests the members the specification names rather than
 * re-deriving them from a body — and so that MCP and HTTP are digest-identical
 * by construction (I3), because both project through this one function.
 */
export function decisionMembers(request: HoldSeatsRequest): Record<string, unknown> {
  const d: Record<string, unknown> = {
    occasion_id: request.occasion_id,
    occasion_etag: request.occasion_etag,
    sought: { occasion_id: request.sought.occasion_id, occasion_etag: request.sought.occasion_etag },
    requested_floor_ms: request.requested_floor_ms,
  };
  if (request.seats !== undefined) d.seats = sortCSeats(request.seats);
  if (request.selection !== undefined) d.selection = { ...request.selection };
  return d;
}

/* ── 3 · Options ───────────────────────────────────────────────────────────── */

export interface HoldSeatsOptions {
  /** §6.2 capability `profile`. `"0"` implements no hold verbs (G1 step 1). */
  readonly profile?: "0" | "1" | "1S";
  readonly policy?: Partial<HoldPolicyLimits>;
  /** T2: the movable cue mark. `expires_at = max(floor_ms, this)`. Defaults to the floor. */
  readonly expiry_ms?: DurationMs;
  readonly availability?: AvailabilitySource;
  readonly budgets?: BudgetGuard;
  readonly seat_rules?: SeatRuleCheck;
  /** Test seam only. Never a request member — Z2 requires a CSPRNG. */
  readonly hold_id?: () => string;
}

/** Profile 1: the store defined here is the store. */
export const STORE_OF_RECORD: AvailabilitySource = {
  async observe(tx, occasion_id, server_time) {
    const r = await tx.query<{ availability_mode: string }>(
      "select availability_mode from occasion where occasion_id = $1",
      [occasion_id],
    );
    const mode = (r.rows[0]?.availability_mode ?? "unknown") as AvailabilityObservation["mode"];
    // The observation IS this transaction: `occasion_seat` is read under the
    // seat locks a few statements from now. Its age is zero and measured, not
    // configured and not invented (§2.10, "MUST NOT invent a staleness number").
    return { mode, observed_at: server_time, staleness_basis: "measured" };
  },
};

/** CORE-006 replaces this. Named so that "no ceiling was enforced" is legible. */
export const BUDGETS_UNENFORCED: BudgetGuard = {
  async reserve() {
    /* X1/X3/X4 are CORE-006's. This Server publishes no ceiling, so it enforces none. */
  },
};

/** ADAPT-001 replaces this. A house with no authored seat rule crosses none. */
export const NO_SEAT_RULES: SeatRuleCheck = {
  async check() {
    return null;
  },
};

interface Resolved {
  readonly profile: "0" | "1" | "1S";
  readonly policy: HoldPolicyLimits;
  readonly expiry_ms?: DurationMs;
  readonly availability: AvailabilitySource;
  readonly budgets: BudgetGuard;
  readonly seat_rules: SeatRuleCheck;
  readonly hold_id: () => string;
}

function resolveOptions(options: HoldSeatsOptions): Resolved {
  return {
    profile: options.profile ?? "1",
    policy: { ...HOLD_POLICY_DEFAULTS, ...options.policy },
    expiry_ms: options.expiry_ms,
    availability: options.availability ?? STORE_OF_RECORD,
    budgets: options.budgets ?? BUDGETS_UNENFORCED,
    seat_rules: options.seat_rules ?? NO_SEAT_RULES,
    hold_id: options.hold_id ?? newHoldId,
  };
}

/* ── 4 · Z2 — the hold id ──────────────────────────────────────────────────── */

/** Crockford base32: I, L, O and U are absent, which is what the pattern says. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * `^hold_[0-9A-HJKMNP-TV-Z]{32}$` — 160 bits from a CSPRNG, encoded exactly.
 *
 * Z2: *"ULID and UUIDv7 are NOT acceptable generators for this field"*, because
 * both leak and order by time, and this handle is the identifier for every
 * write verb. 20 bytes is 160 bits is 32 characters of 5 bits, with no padding
 * and no truncation to argue about.
 */
export function newHoldId(): string {
  const bytes = randomBytes(20);
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31];
    }
  }
  return "hold_" + out;
}

/* ── 5 · The context the table's runners share ─────────────────────────────── */

interface OccasionRow extends Row {
  occasion_id: string;
  etag: string;
  origin: string;
  showtime_id: string;
  cluster: string | null;
  capacity: number;
  availability_mode: string;
  sales_cutoff_at: string | null;
  withdrawn: boolean;
  document: unknown;
}

interface GrantContext {
  readonly request: HoldSeatsRequest;
  readonly credential: Credential;
  readonly options: Resolved;
  tx: Queryable | null;
  server_time: Rfc3339;
  occasion: OccasionRow | null;
  sought_occasion: OccasionRow | null;
  /** The full requested seat set, C-sorted. Set by step 2, or by `best_available`. */
  seat_ids: string[];
  hold_id: string;
  floor_ms: DurationMs;
  granted: GrantedRow | null;
  /** W1's answer, handed from step 10 to step 11 so the inventory is read once. */
  statuses: ReadonlyMap<string, string>;
  /**
   * A refusal seat SELECTION reached before G1's order said it could be raised.
   * `best_available` runs inside `lockAndReap`, immediately before the first
   * writing step, so a throw from there jumps steps 8 through 11. Recorded here
   * and raised by the loop instead.
   */
  deferred: Refusal | null;
}

interface GrantedRow extends Row {
  hold_id: string;
  /** What the store settled the floor at, after the sale-window clamp. */
  floor_ms: number | string;
  granted_at: string;
  floor_deadline: string;
  expires_at: string;
}

function tx(ctx: GrantContext): Queryable {
  if (ctx.tx === null) throw new Error("hold_seats: a transaction-phase guard ran outside a transaction");
  return ctx.tx;
}

/* ── 6 · The twelve runners, keyed by the table's own names ────────────────── */

type GuardRunner = (ctx: GrantContext) => Promise<void>;

const OCCASION_COLUMNS = `occasion_id, etag, origin, showtime_id, cluster, capacity,
  availability_mode, ${rfc3339Column("sales_cutoff_at")}, withdrawn, document`;

async function readOccasion(q: Queryable, occasion_id: string): Promise<OccasionRow | null> {
  const r = await q.query<OccasionRow>(
    `select ${OCCASION_COLUMNS} from occasion where occasion_id = $1`,
    [occasion_id],
  );
  return r.rows[0] ?? null;
}

/**
 * G1 step 2, as a function a **binding** can call before it touches the request
 * for any other purpose.
 *
 * It lives in core, not in `packages/http`, for the reason §6.2 gives: every
 * constraint MUST be identical across the bindings, and a rule with two
 * implementations is a rule with two behaviours. MCP inherited its validation
 * from the tool `inputSchema` and HTTP inherited none, so until 2026-08-26 the
 * same malformed call was `400 schema_validation` over MCP and `503
 * upstream_unavailable` over HTTP — a false statement about the exhibitor's
 * system, with a five-second retry instruction attached to a request that could
 * never succeed. That is the `KEY_MAX_LENGTH` divergence this repository found
 * and fixed at Gate 2, wearing a different member.
 *
 * `RUNNERS.schema` still calls it, so G1 step 2 runs unchanged for a core
 * caller that never went through a binding.
 */
export function assertHoldSeatsShape(value: unknown): asserts value is HoldSeatsRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw refuse("schema_validation", "A hold_seats request is a JSON object.");
  }
  const request = value as HoldSeatsRequest;
    const bad = (why: string): never => {
      throw refuse("schema_validation", why);
    };

    if (typeof request.occasion_id !== "string" || request.occasion_id.length === 0) {
      bad("occasion_id is required.");
    }
    if (!/^1:[A-Za-z0-9_-]{43}$/.test(request.occasion_etag ?? "")) {
      bad("occasion_etag must be the etag this Server published.");
    }
    if (typeof request.sought?.occasion_id !== "string" || request.sought.occasion_id.length === 0) {
      bad("sought.occasion_id is required: without it every hold is trivially a hold of itself.");
    }
    if (!/^1:[A-Za-z0-9_-]{43}$/.test(request.sought?.occasion_etag ?? "")) {
      bad("sought.occasion_etag must be the etag this Server published.");
    }

    const hasSeats = request.seats !== undefined;
    const hasSelection = request.selection !== undefined;
    if (hasSeats === hasSelection) {
      bad("exactly one of seats or selection is required.");
    }

    if (hasSeats) {
      const seats = request.seats as readonly string[];
      if (!Array.isArray(seats) || seats.length < 1 || seats.length > SEATS_WIRE_MAX) {
        bad(`seats must carry between 1 and ${SEATS_WIRE_MAX} identifiers.`);
      }
      for (const seat_id of seats) {
        if (typeof seat_id !== "string" || seat_id.length === 0 || seat_id.length > SEAT_ID_MAX_LENGTH) {
          bad("every seat identifier must be a string of 1 to 64 characters.");
        }
      }
      // W2, and it is not a nicety: the refusal it prevents is unactionable.
      if (new Set(seats).size !== seats.length) {
        bad("seats must be unique; a repeated identifier is not a second seat.");
      }
    } else {
      const selection = request.selection as Selection;
      if (selection.mode !== "best_available") {
        bad("selection.mode must be best_available.");
      }
      if (!Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > SEATS_WIRE_MAX) {
        bad(`selection.quantity must be an integer between 1 and ${SEATS_WIRE_MAX}.`);
      }
    }

    if (!Number.isInteger(request.requested_floor_ms) || request.requested_floor_ms < HOLD_SCHEMA_MIN_FLOOR_MS) {
      bad(`requested_floor_ms must be an integer of at least ${HOLD_SCHEMA_MIN_FLOOR_MS} milliseconds.`);
    }

  // D3, and it belongs here rather than in a binding for the reason D3 itself
  // gives: it holds "in both bindings". `requireValidIntentDigest` was written
  // at CORE-007, is correct, and until 2026-08-26 had exactly one caller in the
  // tree — its own unit test. MCP was protected by INTENT_DIGEST_SCHEMA in the
  // tool's inputSchema; HTTP was protected by nothing, so
  // `intent_digest: "sarah.chen@gmail.com"` was refused over one binding and
  // granted a Hold over the other. §6.2 names that exact failure as its worked
  // example. One implementation, both bindings, one behaviour.
  if (request.intent_digest !== undefined) {
    requireValidIntentDigest(request.intent_digest as string);
  }
}


const RUNNERS: Readonly<Record<GuardName, GuardRunner>> = {
  /* 1 · Does this Server implement the operation at all? §6.3: "e.g. a hold
   *     verb against Profile 0." Decided from the deployment, before the store. */
  async profile(ctx) {
    if (ctx.options.profile === "0") {
      throw refuse(
        "profile_not_supported",
        "This venue publishes its screenings but does not hold seats.",
      );
    }
  },

  /* 2 · Request shape, including W2 — and W2's whole point is that it lands
   *     HERE, before any lock is taken. Otherwise ["F:11","F:11"] trips the
   *     primary key, is reported as seat_contended, and the Agent loops forever
   *     re-resolving a seat that was free the entire time. */
  async schema(ctx) {
    assertHoldSeatsShape(ctx.request);
    // Seat ORDER is the runner's business, not the shape check's: C-sorting is
    // what L1 locks in and what I3 digests, and both are properties of this
    // call rather than of the document's validity.
    if (ctx.request.seats !== undefined) ctx.seat_ids = sortCSeats(ctx.request.seats);
  },

  /* 3 · Is the Occasion published at this origin right now? A withdrawn
   *     Occasion is not found, not refused for some richer reason: §2.7 forbids
   *     an existence oracle and there is nothing an Agent could do with the
   *     difference except infer. The `sought` Occasion is resolved here too —
   *     S3 requires the commit-time check to run against an Occasion the Agent
   *     may never have seen, so it must be loadable. */
  async occasion(ctx) {
    const q = tx(ctx);
    const held = await readOccasion(q, ctx.request.occasion_id);
    if (held === null || held.withdrawn) {
      throw refuse("occasion_not_found", "That screening is not published here.");
    }
    ctx.occasion = held;

    if (ctx.request.sought.occasion_id === held.occasion_id) {
      ctx.sought_occasion = held;
      return;
    }
    const sought = await readOccasion(q, ctx.request.sought.occasion_id);
    if (sought === null || sought.withdrawn) {
      throw refuse("occasion_not_found", "The screening the customer chose is not published here.");
    }
    ctx.sought_occasion = sought;
  },

  /* 4 · Are the assertions the Agent presented to a human still the assertions?
   *     Two rules land on one code so that the same fact cannot yield a
   *     retryable code from one server and a non-retryable one from another:
   *     S2 (a stale `sought` etag) and G2 (a changed availability.mode, which is
   *     inside PROJECTION_0_1 and therefore moves the etag by construction). */
  async etag(ctx) {
    const held = ctx.occasion as OccasionRow;
    if (held.etag !== ctx.request.occasion_etag) {
      throw occasionMoved(changedPaths());
    }
    const sought = ctx.sought_occasion as OccasionRow;
    if (sought.etag !== ctx.request.sought.occasion_etag) {
      throw occasionMoved(changedPaths());
    }
  },

  /* 5 · Is availability knowable and fresh? Never sold out, never available,
   *     and never silently re-observed. G2 has already run: reaching here means
   *     the etag matched, which is the only state in which `availability_unknown`
   *     is the right code. */
  async availability(ctx) {
    const observation = await ctx.options.availability.observe(
      tx(ctx),
      (ctx.occasion as OccasionRow).occasion_id,
      ctx.server_time,
    );
    if (observation.mode === "unknown" || observation.staleness_basis === "unknown") {
      // §2.9: an Agent MUST NOT read this as sold out OR as available. The code
      // is neither, which is the entire reason it exists as its own member of
      // the taxonomy rather than as a 404 or a `sold_out: true`.
      throw refuse(
        "availability_unknown",
        "This venue does not publish seat availability for that screening.",
      );
    }
    const max = observation.max_staleness_ms;
    if (max !== undefined && elapsedMs(observation.observed_at, ctx.server_time) > max) {
      // §2.10: refuse "rather than silently re-observing". A re-observation here
      // would hand the Agent a hold against a seat map the human never saw.
      throw refuse("availability_stale", "The seat availability we hold is older than we publish.");
    }
  },

  /* 6 · Is the exhibitor still selling this screening? Compared against the
   *     store's clock, not the process's: K4 permits one time source and this
   *     is the same one `granted_at` will read. */
  async cutoff(ctx) {
    const held = ctx.occasion as OccasionRow;
    const r = await tx(ctx).query<{ past: boolean }>(
      `select (sales_cutoff_at is not null and clock_timestamp() >= sales_cutoff_at) as past
         from occasion where occasion_id = $1`,
      [held.occasion_id],
    );
    if (r.rows[0]?.past === true) {
      throw refuse("past_sales_cutoff", "Sales for that screening have closed.");
    }
  },

  /* 7 · S1 at commit. The last read, and the last step before anything is
   *     locked or written. A missing edge is the absence of permission, so an
   *     Occasion whose publisher attested nothing substitutes for nothing —
   *     the failure-safe direction, and the expensive one. */
  async substitution(ctx) {
    const held = ctx.occasion as OccasionRow;
    const sought = ctx.sought_occasion as OccasionRow;
    if (sought.occasion_id === held.occasion_id) return;

    const poset = buildPoset([
      candidateFromOccasion(occasionLike(sought)),
      candidateFromOccasion(occasionLike(held)),
    ]);
    const detail = substitutionRefusal(poset, sought.occasion_id, held.occasion_id);
    if (detail !== null) {
      // S3: "such a refusal MUST name the unseen occasion with remediation:
      // re_resolve" — which is `substitution_refused`'s default remediation and
      // `from_occasion_id` is the naming.
      throw refuse("substitution_refused", "That screening is not an attested substitute for the one chosen.", {
        detail: { from_occasion_id: detail.from_occasion_id, crossed_axis: detail.crossed_axis as Axis },
      });
    }
  },

  /* 8 · X2, enforced by the hold_cluster_live index and never by a count: at
   *     READ COMMITTED two hold_seats three milliseconds apart both count zero
   *     live holds in a cluster, both pass, and both commit. The hold row is
   *     inserted here because hold_cluster references it — and because this is
   *     the latest point at which it can be, which is what K4 wants: granted_at
   *     is minted after every lock wait this transaction is going to do. */
  async cluster(ctx) {
    await insertHold(ctx);
    const held = ctx.occasion as OccasionRow;
    if (held.cluster === null) return;

    const q = tx(ctx);
    const key = [ctx.credential.agent_id, ctx.credential.principal_scope, held.origin, held.cluster];

    // The cluster row of an already-expired Hold is stale bookkeeping for a Hold
    // that M1 already reports as `expired`; leaving it would refuse a principal
    // their own next hold forever. It is reaped by HOLD (whole row, one hold)
    // on the exact index key this insert is about to contend on, and on no
    // other — its seat rows belong to whoever contends for those seats next,
    // under those seats' locks, which is ADR-006 exactly.
    await q.query(
      `delete from hold_cluster
        where agent_id = $1 and principal_scope = $2 and origin = $3 and cluster = $4
          and held_until <= now() and state in ('live', 'handed_off')`,
      key,
    );

    // Assembled BEFORE the insert, under the locks: the transaction is aborted
    // the instant 23505 is raised and a query for the detail then gets 25P02.
    const conflict = await q.query<{ hold_id: string }>(
      `select hold_id from hold_cluster
        where agent_id = $1 and principal_scope = $2 and origin = $3 and cluster = $4
          and state in ('live', 'handed_off')
        limit 1`,
      key,
    );
    const conflicting_hold_id = conflict.rows[0]?.hold_id;

    try {
      await q.query(
        `insert into hold_cluster (hold_id, agent_id, principal_scope, origin, cluster, state, held_until)
         select h.hold_id, $2, $3, $4, $5, 'live', h.expires_at from hold h where h.hold_id = $1`,
        [ctx.hold_id, ...key],
      );
    } catch (err) {
      throw clusterOrRethrow(err, conflicting_hold_id, held.cluster);
    }
  },

  /* 9 · X1/X3/X4. The published ceilings are CORE-006's; the per-hold seat cap
   *     is §2.5's own number and is read from HoldPolicyLimits, so this module
   *     cannot enforce a limit that is not published there. */
  async budget(ctx) {
    const limit = ctx.options.policy.max_seats_per_hold;
    if (ctx.seat_ids.length > limit) {
      throw refuse("seat_budget_exhausted", "That is more seats than this venue holds at once.", {
        detail: { limit },
      });
    }
    await ctx.options.budgets.reserve(tx(ctx), budgetContext(ctx));
  },

  /* 10 · W1. Every seat id validated against the auditorium's own inventory,
   *      inside the hold transaction. Unvalidated ids otherwise become
   *      permanent rows nothing will reap, and let an attacker pre-claim ids
   *      that do not exist yet. */
  async seat_known(ctx) {
    const held = ctx.occasion as OccasionRow;
    const r = await tx(ctx).query<{ seat_id: string; status: string }>(
      `select seat_id, status from occasion_seat
        where occasion_id = $1 and seat_id = any($2::text[])`,
      [held.occasion_id, ctx.seat_ids],
    );
    const known = new Map(r.rows.map((row) => [row.seat_id, row.status]));
    const unknown = ctx.seat_ids.filter((seat_id) => !known.has(seat_id));
    if (unknown.length > 0) throw unknownSeat(unknown);
    ctx.statuses = known;
  },

  /* 11 · W3 then W4. W3 is the exhibitor's fact — sold, blocked, house seat,
   *      accessibility hold — and is NOT a CHANGEOVER Hold, which is step 12
   *      and a different code with different retry semantics. W4 is the
   *      combination, and it is the exhibitor's own allocation logic. */
  async seat_available(ctx) {
    const statuses = ctx.statuses as ReadonlyMap<string, string>;
    const unavailable = ctx.seat_ids.filter((seat_id) => statuses.get(seat_id) !== "available");
    if (unavailable.length > 0) throw seatUnavailable(unavailable);

    const violated = await ctx.options.seat_rules.check(tx(ctx), budgetContext(ctx));
    if (violated !== null) throw violated;
  },

  /* 12 · Last, because it alone requires locks — which this transaction has
   *      held over the FULL requested set since before the reap ran. */
  async seat_contended(ctx) {
    const held = ctx.occasion as OccasionRow;
    const q = tx(ctx);

    // Under the locks, after the reap, this read is stable: no conforming
    // writer can insert one of these seats while we hold its lock. It exists so
    // the refusal can NAME the seats, because after the insert raises there is
    // no transaction left to ask.
    const occupied = await q.query<{ seat_id: string }>(
      `select seat_id from hold_seat
        where showtime_id = $1 and seat_id = any($2::text[])
          and state in ('live', 'handed_off', 'claimed')
        order by seat_id`,
      [held.showtime_id, ctx.seat_ids],
    );
    if (occupied.rows.length > 0) {
      throw seatContended(occupied.rows.map((row) => row.seat_id));
    }

    try {
      const inserted = await q.query(
        `insert into hold_seat (hold_id, occasion_id, showtime_id, seat_id, state, held_until)
         select h.hold_id, $2, $3, s, 'live', h.expires_at
           from hold h cross join unnest($4::text[]) as s
          where h.hold_id = $1`,
        [ctx.hold_id, held.occasion_id, held.showtime_id, ctx.seat_ids],
      );
      // M2 makes the Hold report its seats for the life of the record, so a
      // grant that wrote fewer rows than it promised is a Hold asserting
      // occupancy it does not have. That is a fault, not a refusal: it must
      // surface as a 500 and take the transaction with it.
      if (inserted.rowCount !== ctx.seat_ids.length) {
        throw new Error(
          `hold_seats: granted ${ctx.seat_ids.length} seats and wrote ${inserted.rowCount} rows`,
        );
      }
    } catch (err) {
      // A 23505 here means a writer took one of these seats without taking its
      // lock — a non-conforming writer, or a defect. The seat set is the
      // honest superset: the transaction is aborted, so the exact seat can no
      // longer be read, and inventing one would be a false statement to a
      // consumer with no judgement.
      const classified = classify23505(err);
      if (classified?.code === "seat_contended") throw seatContended(ctx.seat_ids);
      throw err;
    }
  },
};

/* ── 7 · Load-time invariant: the table and the runners are the same set ───── */
//
// Asserted at import rather than tested, because the failure mode is a guard
// that silently does not run. A step added to G1 with no runner would otherwise
// be a hole in the wire contract that nothing observes until a conformance run.

for (const step of G1) {
  if (typeof RUNNERS[step.name] !== "function") {
    throw new Error(`hold_seats: G1 step ${step.step} (${step.name}) has no runner`);
  }
}
for (const name of Object.keys(RUNNERS)) {
  if (!G1.some((step) => step.name === name)) {
    throw new Error(`hold_seats: runner ${name} is not a G1 step`);
  }
}

/* ── 8 · The verb ──────────────────────────────────────────────────────────── */

/**
 * Grant a Hold, or throw the first refusal G1 orders.
 *
 * Never returns a partial result and never mixes a refusal with rows: the
 * refusal leaves by `throw`, out of the transaction callback, and the store is
 * as it was.
 */
export async function holdSeats(
  db: Db,
  request: HoldSeatsRequest,
  credential: Credential,
  options: HoldSeatsOptions = {},
): Promise<HoldDocument> {
  // X0, and it is not a G1 step: a credential with no principal_scope never
  // becomes a request. Scoping budgets to agent_id alone would mean one
  // Wellington household holding the Friday 35mm locks out every other customer
  // of that platform anywhere.
  if (typeof credential.principal_scope !== "string" || credential.principal_scope.length === 0) {
    throw refuse("principal_scope_missing", "This credential carries no principal scope.");
  }
  if (!/^agt_[A-Za-z0-9_-]{1,40}$/.test(credential.agent_id ?? "")) {
    throw refuse("not_authorised", "This credential carries no agent identity.");
  }

  const ctx: GrantContext = {
    request,
    credential,
    options: resolveOptions(options),
    tx: null,
    server_time: "",
    occasion: null,
    sought_occasion: null,
    seat_ids: [],
    hold_id: "",
    floor_ms: 0,
    granted: null,
    statuses: new Map(),
    deferred: null,
  };

  // Phase one. G1's `phase` column asserts at load that the request-only steps
  // are a PREFIX of the order, which is what lets this be a `break` rather than
  // a filter — the loop still walks one table in one direction.
  for (const step of G1) {
    if (step.phase !== "request") break;
    await RUNNERS[step.name](ctx);
  }

  // N1: one transaction. Read Committed, with every aggregate guard enforced by
  // a constraint or a lock a concurrent transaction cannot bypass — the second
  // of N1's two permitted answers, and the one this store is built for.
  return db.transaction(async (transaction) => {
    ctx.tx = transaction;
    ctx.server_time = await serverTime(transaction);

    for (const step of G1) {
      if (step.phase === "request") continue;
      // L1: before ANY reap or insert, and therefore immediately before the
      // first step G1 marks as writing — whichever step that becomes.
      if (step.step === G1_FIRST_WRITING_STEP) {
        await lockAndReap(ctx);
        if (ctx.deferred !== null) {
          // G1: the FIRST failure in the stated order, whichever request form
          // asked. A `best_available` request the house cannot fill still owes
          // the Agent `cluster_fanout` or `hold_budget_exhausted` where either
          // binds — the same code the same facts produce for a request that
          // named its seats. Only the halves that do not need a Hold row can
          // run, because on this path there will be no Hold; that is exactly
          // steps 8 and 9's subject, which is what the principal ALREADY holds.
          await refuseLabelledFanout(ctx);
          await ctx.options.budgets.probe?.(tx(ctx), budgetContext(ctx));
          throw ctx.deferred;
        }
      }
      await RUNNERS[step.name](ctx);
    }

    const granted = ctx.granted as GrantedRow;
    const held = ctx.occasion as OccasionRow;
    // K6: read after the last write, so a second response about this hold_id
    // cannot carry an earlier server_time than this one.
    const server_time = await serverTime(transaction);

    const document: HoldDocument = {
      changeover: "0.1",
      hold_id: granted.hold_id,
      state: "live",
      occasion_id: held.occasion_id,
      occasion_etag: held.etag,
      sought_occasion_id: (ctx.sought_occasion as OccasionRow).occasion_id,
      seats: [...ctx.seat_ids],
      granted_at: granted.granted_at,
      floor_ms: ctx.floor_ms,
      floor_deadline: granted.floor_deadline,
      expires_at: granted.expires_at,
      // T3: there is no extend verb and a Server MUST NOT provide one. The
      // member is a constant so that "false" is not a decision anyone can make.
      extendable: EXTENDABLE,
      agent_id: credential.agent_id,
      server_time,
    };
    return held.cluster === null ? document : { ...document, cluster: held.cluster };
  }, { isolation: "read committed" });
}

/* ── 9 · L1 and L2 — the locks, then the reap, then nothing else ───────────── */

/**
 * L1, then L2, in that order and with nothing between them.
 *
 * The lock is over the **full requested seat set**, irrespective of whether a
 * row exists, because ordering the seats a transaction locks is not enough:
 * *"the reap can only lock rows that exist and are doomed at its own start, and
 * a free seat has no row, so two transactions over one seat set compute
 * different lock sequences and deadlock across an expiry boundary while obeying
 * the rule exactly."* Which is why this takes `pg_advisory_xact_lock` and not
 * `SELECT … FOR UPDATE`: a free seat is the one being raced for and it has no
 * row to lock.
 *
 * `best_available` is resolved here, before the locks, because until the Server
 * has chosen the seats there is no requested set to lock. The choice is racy by
 * construction and is re-validated under the locks by steps 10–12 — a race just
 * becomes `seat_contended`, which is what that code is for.
 */
async function lockAndReap(ctx: GrantContext): Promise<void> {
  const q = tx(ctx);
  const held = ctx.occasion as OccasionRow;

  if (ctx.request.selection !== undefined) {
    const chosen = await chooseBestAvailable(q, held, ctx.request.selection);
    ctx.seat_ids = chosen.seats;
    if (chosen.short) {
      // Recorded, not thrown. L1 is still satisfied — the locked set below is
      // the full set this transaction will touch — and the refusal is raised by
      // the loop, after the steps G1 puts ahead of it have had their turn.
      ctx.deferred = seatContended([]);
    }
  }

  await lockSeats(q, held.showtime_id, ctx.seat_ids);

  // Reap by HOLD, never by seat: a Hold is never partially expired, and a reap
  // triggered by contention on any seat of a Hold MUST reap EVERY seat of it.
  // `now()` — transaction start — so this cannot reap a seat that was live when
  // the transaction began. `claimed` is absent from the predicate: it is
  // terminal and occupies its seat for the life of the screening.
  await q.query(
    `with doomed as (
       select distinct hold_id from hold_seat
        where showtime_id = $1 and seat_id = any($2::text[])
          and held_until <= now() and state in ('live', 'handed_off')
     )
     delete from hold_seat h using doomed d where h.hold_id = d.hold_id`,
    [held.showtime_id, ctx.seat_ids],
  );
}

/**
 * W4's `best_available`. Deterministic: C-collation order, and where `together`
 * is asked for, a contiguous run inside one row of the seat map.
 *
 * A Server MUST NOT return seats spanning a violation — so where a house has
 * authored seat rules, {@link SeatRuleCheck} refuses the chosen set at step 11
 * rather than this function silently choosing around a rule it does not know.
 */
/**
 * Step 8's LABELLED half, read-only, for the deferred path.
 *
 * The `cluster` runner enforces X2's labelled case with the `hold_cluster_live`
 * index — which only fires on an INSERT, and the deferred path inserts nothing.
 * The derived half (`refuseDerivedFanout`, inside the budget guard's `probe`)
 * catches Occasions attested as mutual substitutes; it explicitly does not
 * catch the publisher's own `cluster` label, because the index already did.
 * Without this, a `best_available` request the house cannot fill would answer
 * `seat_contended` to a principal whose real obstacle is a cluster they already
 * hold in — the exact request-form divergence this branch exists to close.
 *
 * The reap is the same one the runner performs, on the same key, for the same
 * reason: a stale cluster row belongs to a Hold M1 already reports as expired,
 * and leaving it would refuse a principal their own next hold forever.
 */
async function refuseLabelledFanout(ctx: GrantContext): Promise<void> {
  const held = ctx.occasion as OccasionRow;
  if (held.cluster === null) return;
  const q = tx(ctx);
  const key = [ctx.credential.agent_id, ctx.credential.principal_scope, held.origin, held.cluster];

  await q.query(
    `delete from hold_cluster
      where agent_id = $1 and principal_scope = $2 and origin = $3 and cluster = $4
        and held_until <= now() and state in ('live', 'handed_off')`,
    key,
  );
  const conflict = await q.query<{ hold_id: string }>(
    `select hold_id from hold_cluster
      where agent_id = $1 and principal_scope = $2 and origin = $3 and cluster = $4
        and state in ('live', 'handed_off')
      limit 1`,
    key,
  );
  const conflicting_hold_id = conflict.rows[0]?.hold_id;
  if (conflicting_hold_id === undefined) return;
  throw refuse("cluster_fanout", "You already hold seats for that run of screenings.", {
    detail: { conflicting_hold_id, cluster: held.cluster, limit: 1 },
  });
}

interface Chosen {
  readonly seats: string[];
  /** True where the house could not fill the request. Never a refusal here. */
  readonly short: boolean;
}

async function chooseBestAvailable(
  q: Queryable,
  occasion: OccasionRow,
  selection: Selection,
): Promise<Chosen> {
  const r = await q.query<{ seat_id: string; seat_row: string | null; seat_number: number | null }>(
    `select s.seat_id, s.seat_row, s.seat_number
       from occasion_seat s
      where s.occasion_id = $1 and s.status = 'available'
        and not exists (
          select 1 from hold_seat h
           where h.showtime_id = $2 and h.seat_id = s.seat_id
             and h.state in ('live', 'handed_off', 'claimed')
             and (h.state = 'claimed' or h.held_until > now())
        )
      order by s.seat_row, s.seat_number, s.seat_id`,
    [occasion.occasion_id, occasion.showtime_id],
  );

  const rows = r.rows;
  if (selection.together === true) {
    for (let i = 0; i + selection.quantity <= rows.length; i++) {
      const run = rows.slice(i, i + selection.quantity);
      const sameRow = run.every((seat) => seat.seat_row === run[0].seat_row);
      const contiguous = run.every(
        (seat, k) =>
          k === 0 ||
          (typeof seat.seat_number === "number" &&
            typeof run[k - 1].seat_number === "number" &&
            seat.seat_number === (run[k - 1].seat_number as number) + 1),
      );
      if (sameRow && contiguous) return { seats: sortCSeats(run.map((seat) => seat.seat_id)), short: false };
    }
    // NOT a throw. This function runs inside `lockAndReap`, which runs
    // immediately before G1's first WRITING step, so a refusal raised here
    // pre-empts steps 8 through 11 and the Agent is handed a code out of G1's
    // order. What it returns instead is what it found; the caller records the
    // refusal and evaluates the earlier steps before raising it.
    return { seats: [], short: true };
  }

  if (rows.length < selection.quantity) {
    return { seats: sortCSeats(rows.map((seat) => seat.seat_id)), short: true };
  }
  return { seats: sortCSeats(rows.slice(0, selection.quantity).map((seat) => seat.seat_id)), short: false };
}

/* ── 10 · The grant itself ─────────────────────────────────────────────────── */

/**
 * The one insert that mints both cue marks, from **one** read of
 * {@link GRANT_CLOCK} — `clock_timestamp()`, not `now()`.
 *
 * K4 in one statement: `granted_at`, `floor_deadline` and `expires_at` all
 * derive from `changeover_grant_clock.now`, so the store's own
 * `hold_floor_derived` check is satisfied by construction rather than by
 * arithmetic agreeing across two clocks. There is no JavaScript `Date` anywhere
 * on this path; the moment one enters, K4 is a comment. A transaction that
 * spent 600ms in lock waits would otherwise mint a floor already 600ms in the
 * past, and the deficit falls entirely on the Agent's side, where C-FLOOR can
 * never see it.
 */
async function insertHold(ctx: GrantContext): Promise<void> {
  const held = ctx.occasion as OccasionRow;
  const sought = ctx.sought_occasion as OccasionRow;

  const floor_ms = grantedFloorMs(
    ctx.request.requested_floor_ms,
    ctx.options.policy.policy_max_floor_ms,
    ctx.options.policy.abandonment_floor_penalty_bp,
  );
  if (floor_ms === null) {
    // X5 may reduce a floor; it may not reduce it below the schema's own
    // minimum. A floor this Server cannot honour is a 503, never a short floor
    // granted quietly — the number is the only thing an Agent may plan against.
    throw refuse("floor_unavailable", "This venue cannot guarantee a hold that long right now.", {
      retry_after_ms: 5000,
    });
  }
  // T2: movable upward only, and never below the floor at grant.
  const expiry_ms = grantedExpiryMs(floor_ms, ctx.options.expiry_ms);
  ctx.hold_id = ctx.options.hold_id();

  // The grant is clamped to the sale window, and the clamp is in SQL because
  // the only clock this path may read is the store's (K4).
  //
  // G1 step 6 checks that `sales_cutoff_at` has not ALREADY passed. It never
  // checked that the grant fits *inside* it, so a 300-second floor requested
  // twenty seconds before the cutoff was granted an `expires_at` 280 seconds
  // past the close of sale. T5 and CL4 then had no satisfiable reading —
  // `min(handed_off_at + handoff_floor_ms, sales_cutoff_at)` is BELOW
  // `expires_at`, T6 requires `claim_expires_at >= expires_at`, and
  // `hold_claim_not_before_expiry` is a CHECK. `hand-off.ts` resolved the
  // contradiction with `greatest(expires_at, …)`, which honoured T6 by
  // defeating T5's clamp: measured against real Postgres, a claim window
  // running 280,083 ms past the cutoff, a `confirm` answering 200 `claimed`
  // after the sale had closed, and — because `claimed` is terminal and §4.6
  // forbids reaping it — a seat gone from the house for the life of the
  // screening on a claim CL3 says should have been `410 claim_expired`.
  //
  // The contradiction is removable at the grant, not at the hand-off. Clamp
  // here and T5's `min()` and T6's `>=` are simultaneously satisfiable for
  // every Hold this Server can mint.
  //
  // `where floor_ms >= HOLD_SCHEMA_MIN_FLOOR_MS` is how a hold requested inside
  // the last second of the sale becomes `503 floor_unavailable`: the select
  // yields no row, nothing is inserted, and the refusal below is the same one a
  // floor the venue cannot warrant has always produced. A short floor granted
  // quietly would be worse — the number is the only thing an Agent may plan
  // against.
  const r = await tx(ctx).query<GrantedRow>(
    `insert into hold (hold_id, agent_id, principal_scope, origin, cluster, occasion_id,
                       occasion_etag, sought_occasion_id, showtime_id, seats,
                       granted_at, floor_ms, floor_deadline, expires_at)
     select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[],
            g.now,
            g.floor_ms,
            g.now + (g.floor_ms * interval '1 millisecond'),
            greatest(
              g.now + (g.floor_ms * interval '1 millisecond'),
              least(g.now + ($12::int * interval '1 millisecond'),
                    coalesce($13::timestamptz, 'infinity'::timestamptz)))
       from (select changeover_grant_clock.now,
                    least($11::bigint,
                          case when $13::timestamptz is null then $11::bigint
                               else floor(extract(epoch from
                                      ($13::timestamptz - changeover_grant_clock.now)) * 1000)::bigint
                          end)::int as floor_ms
               from ${GRANT_CLOCK_SUBQUERY}) g
      where g.floor_ms >= ${HOLD_SCHEMA_MIN_FLOOR_MS}
     returning hold_id, floor_ms, ${rfc3339Column("granted_at")}, ${rfc3339Column("floor_deadline")},
               ${rfc3339Column("expires_at")}`,
    [
      ctx.hold_id,
      ctx.credential.agent_id,
      ctx.credential.principal_scope,
      held.origin,
      held.cluster,
      held.occasion_id,
      held.etag,
      sought.occasion_id,
      held.showtime_id,
      ctx.seat_ids,
      floor_ms,
      expiry_ms,
      held.sales_cutoff_at,
    ],
  );
  ctx.granted = r.rows[0] ?? null;
  if (ctx.granted === null) {
    throw refuse("floor_unavailable", "This venue cannot guarantee a hold that long right now.", {
      retry_after_ms: 5000,
    });
  }
  // The store, not the caller, settled what the floor is. Everything downstream
  // — the returned document, X5's report, C-FLOOR's cohort — reads this.
  ctx.floor_ms = Number(ctx.granted.floor_ms);
}

/* ── 11 · Small things, kept out of the runners ────────────────────────────── */

function budgetContext(ctx: GrantContext): BudgetContext {
  const held = ctx.occasion as OccasionRow;
  return {
    agent_id: ctx.credential.agent_id,
    principal_scope: ctx.credential.principal_scope,
    hold_id: ctx.hold_id,
    occasion_id: held.occasion_id,
    showtime_id: held.showtime_id,
    origin: held.origin,
    cluster: held.cluster,
    capacity: held.capacity,
    seat_ids: ctx.seat_ids,
  };
}

function clusterOrRethrow(err: unknown, conflicting_hold_id: string | undefined, cluster: string): unknown {
  const classified = classify23505(err);
  if (classified?.code !== "cluster_fanout") return err;
  // X2: two purchases in one cluster by one household are legitimate and are
  // NOT fan-out — Friday night for the couple and the Sunday matinee for the
  // grandparents. What is refused is a SECOND LIVE hold, which is why the
  // remediation is hand_off_existing and not "wait".
  return refuse("cluster_fanout", "You already hold seats for that run of screenings.", {
    detail: { conflicting_hold_id: conflicting_hold_id ?? "", cluster, limit: 1 },
  });
}

/**
 * `occasion_moved`'s `changed_paths`, or an empty array where the Server cannot
 * name them.
 *
 * The store retains the current published Occasion and no earlier one, so there
 * is nothing to diff a stale etag against. Naming pointers we cannot establish
 * would be a false statement to a consumer that derives its next action from
 * `code` and `remediation` only — the detail is an aid, and an invented aid is
 * worse than none. The schema permits the empty array precisely here.
 */
const CHANGED_PATHS_UNKNOWABLE: readonly string[] = Object.freeze([]);

function changedPaths(): string[] {
  return [...CHANGED_PATHS_UNKNOWABLE];
}

/** The subset of the published document the substitution preorder reads. */
function occasionLike(row: OccasionRow): Record<string, unknown> {
  const document = row.document;
  if (document !== null && typeof document === "object") {
    return { ...(document as Record<string, unknown>), occasion_id: row.occasion_id };
  }
  // No published document means no attested edge, and a missing edge is the
  // absence of permission (§2.3). `strict` is the failure-safe default and is
  // what `candidateFromOccasion` assumes for the same reason.
  return { occasion_id: row.occasion_id };
}

/** Re-exported so a binding can tell a refusal from a fault without a second import. */
export { Refusal };
