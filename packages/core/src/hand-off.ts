/**
 * `hand_off`. SPEC.md §4.8 (**HO1**, **HO2**), §4.3 (**T4**, **T5**, **T6**,
 * **T7**), §4.9's `live → handed_off` row, §4.10 (**CL4**).
 *
 * Owner: CORE-004.
 *
 * **The changeover.** Two projectors run at once and the audience sees one
 * continuous picture: the agent's reel is ending and the exhibitor's is already
 * up to speed. This verb is that instant. It is the last agent verb — after it,
 * R1 refuses `release_hold` and there is no verb left that can shorten the
 * seats' life — and the seats stop being the agent's while the customer walks
 * from the conversation to the cinema's own checkout with them still there.
 *
 * ### HO1, which is the sharpest correction in §4.8
 *
 * > **HO1.** A Server **MUST** accept `hand_off` on any live Hold whose seats it
 * > still holds, **including after `floor_deadline`** — the guard is
 * > `server_time < expires_at` and `< sales_cutoff_at`. Where the seats are
 * > already reclaimed the refusal is `409 hold_expired {expired_at,
 * > occasion_id}`, retryable after re-resolve — never `hold_not_live`, which
 * > means *wrong verb* and is non-retryable. *The draft refused hand-off on a
 * > Hold whose seats were demonstrably still held, with a code that lied, for up
 * > to three and a half minutes, and raced K2 exactly.*
 *
 * **There is no comparison against `floor_deadline` anywhere in this file, and
 * there must never be one.** The two cue marks are different events: the floor
 * is the immovable number an Agent plans against (ADR-002, T1–T3), and passing
 * it was never the same event as losing the seats. A Hold at `floor + 1ms` with
 * every seat row intact is `live` by M1, and this verb accepts it.
 *
 * The draft's version refused it, with `hold_not_live` — a code whose meaning is
 * *wrong verb* and whose retryability is *no*. So an agent that had done
 * everything right, and whose customer's seats were sitting in the store
 * untouched, was told to give up. And it raced K2: an agent obeying K2 treats a
 * Hold as unusable from `floor_deadline − (clock_guard_ms +
 * max_clock_skew_tolerance_ms)`, so the window in which the agent still tried
 * and the server already refused was exactly the window the guards were sized to
 * cover. Hence HO2:
 *
 * > **HO2.** `clock_guard_ms` binds the **Agent's planning**, not the Server's
 * > acceptance. A Server **MUST NOT** refuse a verb on the basis of
 * > `clock_guard_ms`.
 *
 * `clock_guard_ms` is not read in this file either.
 *
 * ### T5 and T6, which are one write
 *
 * > **T5.** `live → handed_off` **MUST** occur at most once per Hold and **MUST**
 * > set `claim_expires_at = min(handed_off_at + handoff_floor_ms,
 * > instant.sales_cutoff_at)`, where `handed_off_at` is the Server's transaction
 * > time. **No other base is permitted.** It is the only event that may extend a
 * > seat's held-until, and it **MUST** do so.
 * > **T6.** … A Server **MUST** maintain `held_until = expires_at` while `live`
 * > and `= claim_expires_at` while `handed_off` … and **MUST** set it in the
 * > same transaction as the state transition.
 *
 * T5–T7 exist because "may extend" and an undefined `held_until` let a
 * conforming server reap at `expires_at` and strand a customer twenty seconds
 * inside the window its own claim page promised. So the two updates below are in
 * one transaction, and the arithmetic is one SQL expression over one reading of
 * one clock — see {@link HANDOFF_SQL} for why that is not a stylistic
 * preference.
 */

import type { Db, Queryable, Row } from "@changeover/store/db.ts";
import type { DurationMs, Rfc3339 } from "@changeover/schema/scalars.ts";
import type { HoldRevokedDetail } from "@changeover/schema/refusal.ts";
import type { RevocationReason } from "@changeover/schema/scalars.ts";
import { refuse } from "@changeover/schema/refusal.ts";
import type { Credential } from "./hold-seats.ts";
import { atOrAfter, rfc3339Column, serverTime } from "./clock.ts";
import type { HoldRow, HoldState } from "./derived.ts";
import { HOLD_COLUMNS, HOLD_STATE, deriveState, seatsAsGranted } from "./derived.ts";
import type { HoldReadDocument } from "./get-hold.ts";
import { holdDocument, loadHold, requireCredential } from "./get-hold.ts";
import { requireFreshReadToken, READ_TOKEN_TTL_MS } from "./read-token.ts";
import { lockSeats } from "./locking.ts";
import { HOLD_POLICY_PUBLISHED } from "./budgets.ts";
import type { ClaimBinding, ClaimOptions, ClaimPaths, ClaimSite, MintedClaim } from "./claim.ts";
import { loadClaimSite, mintClaim } from "./claim.ts";

/* ── 1 · The request ───────────────────────────────────────────────────────── */

export interface HandOffRequest {
  readonly hold_id: string;
  /**
   * T4's mechanism. `hand_off` **REQUIRES** the `read_token` that `get_hold`
   * minted and refuses `409 stale_read` without it.
   *
   * *A thing an agent must not do should not merely be asked.* Every other
   * protocol in this space writes "clients SHOULD re-read before committing"
   * into prose and finds out, in the field, that a model under time pressure
   * does not.
   */
  readonly read_token: string;
}

export interface HandOffOptions {
  /** Which of §4.10's three modes this site publishes. Default `deep_link`. */
  readonly claim_binding?: ClaimBinding;
  readonly claim_paths?: ClaimPaths;
  readonly claim_secret?: string;
  /**
   * T5's `handoff_floor_ms`. Defaults to the published policy — 120 000 ms, two
   * minutes to claim — because a Server MUST NOT enforce a limit it has not
   * published (§2.5) and a hand-off window is exactly such a limit.
   */
  readonly handoff_floor_ms?: DurationMs;
  readonly read_token_ttl_ms?: DurationMs;
  readonly read_token_secret?: string;
}

/**
 * What the verb returns: a Hold document in `handed_off`, with the `handoff`
 * object populated — `handed_off_at`, `handoff_floor_ms`, `claim_url`,
 * `claim_expires_at`, all four or none.
 *
 * `claim_url` appears **here and nowhere else, once**. CL5: the Server logs the
 * *fact* of hand-off and MUST NOT log the token; nothing stores it, so no later
 * read can re-emit it and no I9 replay can carry it.
 */
export interface HandOffResult {
  readonly hold: HoldReadDocument;
  /** Which of the three modes minted this URL, for the capability document. */
  readonly claim_binding: ClaimBinding;
}

/* ── 2 · The one write, and why it is one statement ────────────────────────── */

/**
 * T5 and T6, in one statement, over one reading of one clock.
 *
 * `$2` is `server_time` — read once, above, from `clock_timestamp()` — and it is
 * `handed_off_at`, the base of `claim_expires_at`, and the document's own
 * `server_time`. **Passing the clock in as a parameter rather than reading it
 * again here is load-bearing.** `clock_timestamp()` is VOLATILE and
 * re-evaluated at *every occurrence*, so a statement naming it twice writes two
 * different microseconds into two columns that a CHECK requires to agree — a
 * failure that shows up in roughly one whole-suite run in twelve and is green
 * the other eleven.
 *
 * **The operators, and why they are this way round.** T5 is a ceiling —
 * `claim_expires_at = min(handed_off_at + handoff_floor_ms, sales_cutoff_at)` —
 * and T6 is a floor: `claim_expires_at ≥ expires_at` for the life of the Hold,
 * because hand-off "is the only event that may extend a seat's held-until, and
 * it **MUST** do so". So the shape is CL4's ceiling with T6's floor applied
 * **inside** it: `least(cutoff, greatest(expires_at, handed_off_at + floor))`.
 *
 * Until 2026-08-26 it was written the other way round — `greatest(expires_at,
 * least(…, cutoff))` — and the outer `greatest` defeated the clamp whenever
 * `expires_at > sales_cutoff_at`. This module argued, in a paragraph that has
 * been deleted, that T5's `min()` may be overridden to keep T6. It cannot, and
 * it does not have to: the state that made the two unsatisfiable was
 * `expires_at` running past the cutoff, and `insertHold` no longer mints one.
 * With `expires_at ≤ sales_cutoff_at` true at grant by construction, this
 * expression satisfies both rules for every Hold this Server can produce, and
 * `hold_claim_not_before_expiry` is satisfied by arithmetic rather than by
 * argument.
 *
 * `coalesce` on `$4` handles an Occasion with no published `sales_cutoff_at`:
 * no cutoff is no clamp, not a clamp to null.
 */
export const HANDOFF_SQL: string =
  "update hold set handed_off_at = $2::timestamptz," +
  " handoff_floor_ms = $3::int," +
  " claim_expires_at = least(" +
  "   coalesce($4::timestamptz, 'infinity'::timestamptz)," +
  "   greatest(expires_at, $2::timestamptz + ($3::int * interval '1 millisecond')))" +
  " where hold_id = $1 and handed_off_at is null" +
  ` returning ${rfc3339Column("handed_off_at")}, handoff_floor_ms, ${rfc3339Column("claim_expires_at")}`;

/* ── 3 · The verb ──────────────────────────────────────────────────────────── */

/**
 * Hand the customer, and the seats, to the exhibitor.
 *
 * Guards in §4.9's order for this row — `Z1`; `< expires_at`; `< sales_cutoff_at`;
 * fresh `read_token` — and each one is a distinct code with distinct retry
 * semantics, which is the entire reason the order is part of the wire contract.
 */
export async function handOff(
  db: Db,
  request: HandOffRequest,
  credential: Credential,
  options: HandOffOptions = {},
): Promise<HandOffResult> {
  requireCredential(credential);
  const handoff_floor_ms = options.handoff_floor_ms ?? HOLD_POLICY_PUBLISHED.handoff_floor_ms;

  return db.transaction(async (tx) => {
    // K4: one time source, and it is the database. Read before the row, so the
    // instant every guard below is decided at is one instant and not four.
    const server_time = await serverTime(tx);

    // Z1: the Hold this credential may address, or `404 hold_not_found` —
    // never `403`, so the surface is not an existence oracle. `for update` is
    // the row lock the two writes below run under, and it is taken before the
    // state is read so that the state cannot change between reading and writing.
    const row = await loadHold(tx, request.hold_id, credential, { for_update: true });
    const state = deriveState(row, server_time);

    // Read before the guards, because `hold_revoked` MUST carry `book_url` and a
    // guard that had to refuse before it could name the alternative would be the
    // empty-cart failure CL3 exists to prevent, one screen earlier.
    const site = await loadClaimSite(tx, row.occasion_id);
    if (site === null) {
      // The Occasion behind a granted Hold cannot vanish: `hold.occasion_id`
      // references it. If it has, this Server's own store is inconsistent and
      // saying so beats inventing an origin to mint a URL on.
      throw refuse("upstream_unavailable", "The exhibitor's own system did not answer.", {
        retry_after_ms: 5000,
      });
    }

    guardState(row, state, site);
    guardSalesCutoff(site, server_time);

    // T4, last of the four: the Hold is live, the sale is open, and the only
    // remaining question is whether the Agent looked before it leapt. `409
    // stale_read`, remediation `re_read` — the one refusal here that costs the
    // Agent a round trip and nothing else.
    requireFreshReadToken(
      {
        hold_id: row.hold_id,
        read_token: request.read_token,
        stored_hmac: row.read_token_hmac,
        read_token_at: row.read_token_at,
        server_time,
      },
      options.read_token_ttl_ms ?? READ_TOKEN_TTL_MS,
      options.read_token_secret,
    );

    // T5 and T6, in one transaction. `where handed_off_at is null` is "at most
    // once per Hold" as a property of the statement rather than of the lock
    // having been taken correctly above.
    const written = await tx.query<HandoffColumns>(HANDOFF_SQL, [
      row.hold_id,
      server_time,
      handoff_floor_ms,
      site.sales_cutoff_at,
    ]);
    const handoff = written.rows[0];
    if (handoff === undefined) {
      // Lost a race with another hand-off of the same Hold. Under the row lock
      // this is unreachable; it is here because the alternative to checking is
      // minting a second claim URL for seats that already have one.
      throw refuse("handoff_consumed", "These seats have already been handed off to the customer.");
    }

    // L1: an exclusive lock per (showtime_id, seat_id), in ascending byte order
    // under the C collation, over the FULL granted seat set, in the same
    // transaction as the write. The same locks in the same order as `hold_seats`
    // and `release_hold`, because a writer that took a different order would
    // deadlock against them only under load.
    await lockSeats(tx, row.showtime_id, seatsAsGranted(row));

    // T6: `held_until = claim_expires_at` while `handed_off`, set in the SAME
    // transaction as the transition. This is the column the lazy reap of §4.6
    // reads, so this update is what stops the next contending transaction
    // reclaiming a customer's seats mid-checkout. Without it a conforming server
    // reaps at `expires_at` and strands them inside the window its own claim
    // page promised.
    await tx.query(
      "update hold_seat set state = 'handed_off', held_until = $2::timestamptz" +
        " where hold_id = $1 and state = 'live'",
      [row.hold_id, handoff.claim_expires_at],
    );
    await tx.query(
      "update hold_cluster set state = 'handed_off', held_until = $2::timestamptz" +
        " where hold_id = $1 and state = 'live'",
      [row.hold_id, handoff.claim_expires_at],
    );

    // CL1/CL4/O1. Minted last, after every write has succeeded: a claim URL
    // handed out beside a transaction that then rolls back is a credential for
    // seats nobody holds.
    const claim_options: ClaimOptions = {
      binding: options.claim_binding,
      paths: options.claim_paths,
      secret: options.claim_secret,
    };
    const minted: MintedClaim = mintClaim(
      site,
      {
        hold_id: row.hold_id,
        showtime_id: row.showtime_id,
        seats: seatsAsGranted(row),
        handed_off_at: handoff.handed_off_at,
        claim_expires_at: handoff.claim_expires_at,
      },
      claim_options,
    );

    const after: HoldRow = {
      ...row,
      handed_off_at: handoff.handed_off_at,
      handoff_floor_ms: handoff.handoff_floor_ms,
      claim_expires_at: handoff.claim_expires_at,
    };
    return {
      hold: holdDocument(after, HOLD_STATE.handed_off, server_time, undefined, minted.claim_url),
      claim_binding: minted.claim_binding,
    };
  });
}

interface HandoffColumns extends Row {
  readonly handed_off_at: Rfc3339;
  readonly handoff_floor_ms: DurationMs;
  readonly claim_expires_at: Rfc3339;
}

/* ── 4 · The guards, in §4.9's order ───────────────────────────────────────── */

/**
 * Everything §4.9's transition table says about a `hand_off` that will not
 * happen, and **nothing it does not say**.
 *
 * The order matters because the codes differ in retryability: `hold_expired` is
 * retryable after re-resolve, `hold_not_live` is not retryable at all, and
 * `hold_revoked` carries the venue's own reason. A server that returned the
 * wrong one of those would cost a conforming agent either a wasted round trip or
 * a customer told to give up on seats that were still there.
 */
function guardState(row: HoldRow, state: HoldState, site: ClaimSite): void {
  // §4.9: `revoked` | any agent verb | *(no change)* | `hold_revoked`. First,
  // because T1a's override is the one mechanism that outranks everything else,
  // and it MUST carry `detail.book_url`: an operator who took these seats back
  // owes the customer a way to the ones that are left.
  if (state === HOLD_STATE.revoked) {
    const detail: HoldRevokedDetail = {
      revocation_reason: (row.revocation_reason ?? "venue_operations") as RevocationReason,
    };
    if (site.book_url !== null) detail.book_url = site.book_url;
    throw refuse("hold_revoked", "The venue withdrew these seats.", { detail });
  }

  // §4.9: `handed_off` | `hand_off` | *(no change)* | `handoff_consumed`. T5's
  // "at most once per Hold", as a refusal rather than a second claim URL.
  if (state === HOLD_STATE.handed_off) {
    throw refuse("handoff_consumed", "These seats have already been handed off to the customer.");
  }

  // §4.9: `claimed` | any agent verb except `release_hold` | `hold_not_live`;
  // and `released` | `hand_off` | `hold_not_live`. Here the code is honest —
  // these really are the wrong verb, and re-resolving really will not help.
  if (state === HOLD_STATE.claimed || state === HOLD_STATE.released) {
    throw refuse("hold_not_live", "This hold is no longer live and cannot be handed off.");
  }

  // HO1. The guard is `server_time < expires_at` — and that is the WHOLE
  // guard. A Hold past its floor with its seats still held is `live` by M1 and
  // does not reach this line.
  if (state === HOLD_STATE.expired) {
    throw refuse(
      "hold_expired",
      "The hold ran out while the customer was deciding. Re-resolve the occasion for what is available now.",
      { detail: { expired_at: row.expires_at, occasion_id: row.occasion_id } },
    );
  }

  // Unreachable: M1's six states are exhausted above and by `live`. It exists so
  // that a seventh state added later fails loudly here rather than being handed
  // off by omission.
  if (state !== HOLD_STATE.live) {
    throw refuse("hold_not_live", "This hold is no longer live and cannot be handed off.");
  }
}

/**
 * G1 step 6, at the second of the two moments it binds.
 *
 * §4.9's `live → hand_off` row names `< sales_cutoff_at` alongside `<
 * expires_at`, and it is a different fact from the one `hold_seats` checked: a
 * Hold granted three minutes before the cutoff can reach hand-off after it.
 * Handing a customer a claim URL for a screening that has stopped selling puts
 * them in front of a checkout that will refuse them, which is the failure CL3
 * exists to prevent one screen later.
 */
function guardSalesCutoff(site: ClaimSite, server_time: Rfc3339): void {
  const cutoff = site.sales_cutoff_at;
  if (cutoff === null) return;
  // `atOrAfter(cutoff, server_time)` is "the cutoff is at or before now". Read
  // through clock.ts rather than compared with a bare `Date.parse` pair, because
  // that helper throws on an instant that is not RFC 3339 where a bare parse
  // yields NaN, and `NaN >= NaN` is false — which is a sales cutoff silently
  // not applying.
  if (atOrAfter(cutoff, server_time)) {
    throw refuse("past_sales_cutoff", "This screening has stopped selling.");
  }
}

/* ── 5 · What is deliberately absent ───────────────────────────────────────── */

/**
 * Two things this module does not read, recorded here so that a future edit has
 * to delete a sentence to add them.
 *
 * - **`floor_deadline`** (HO1). The floor is the Agent's planning number and
 *   passing it is not the same event as losing the seats. Grep this file: the
 *   identifier appears in prose and in nothing that executes.
 * - **`clock_guard_ms`** (HO2). It binds the Agent's planning, and a Server MUST
 *   NOT refuse a verb on the basis of it.
 *
 * And one thing that does not exist at all: there is no verb, and no branch
 * here, that learns whether the tickets were bought. `claimed` and `revoked` are
 * terminal, the agent's transcript ends at this call, and the instrument's grain
 * is formed intent rather than conversion — a deliberate limit, and §10 says
 * what it costs.
 *
 * `prove_claim_prefetch_safe.sh` strips this file of its comments and asserts
 * that neither identifier survives, so the absence is checked rather than
 * promised. A constant here that said `true` would have asserted nothing but its
 * own literal.
 */

/**
 * Every column this verb writes, as data, so a proof can read the claim rather
 * than trust the prose. Nothing outside this list is touched on the hand-off
 * path — in particular not `granted_at`, `floor_ms`, `floor_deadline` or
 * `expires_at`, which T3 and T7 make immovable and which 0003's column-level
 * UPDATE grant does not include.
 */
export const HANDOFF_WRITES: readonly string[] = Object.freeze([
  "hold.handed_off_at",
  "hold.handoff_floor_ms",
  "hold.claim_expires_at",
  "hold_seat.state",
  "hold_seat.held_until",
  "hold_cluster.state",
  "hold_cluster.held_until",
]);

/**
 * A convenience for the bindings: the whole Hold row after a hand-off, read
 * back through CORE-003's `HOLD_COLUMNS` so every timestamp is RFC 3339.
 *
 * Exists because `deriveState()` declares `expires_at` as a **string** and a
 * bare `select * from hold` hands it a `Date`, which then silently derives
 * `expired` for a live Hold. `Row` is `Record<string, unknown>`, so nothing
 * catches it.
 */
export async function readHoldRow(tx: Queryable, hold_id: string): Promise<HoldRow | null> {
  const result = await tx.query<HoldRow>(`select ${HOLD_COLUMNS} from hold where hold_id = $1`, [hold_id]);
  return result.rows[0] ?? null;
}
