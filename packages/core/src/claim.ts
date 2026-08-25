/**
 * The claim. SPEC.md §4.10 (**CL1–CL5**), §4.8 (**R3**), §4.9's `claim confirm`
 * row.
 *
 * Owner: CORE-004.
 *
 * **This is not an agent verb and it is not on the agent's surface.** The nine
 * routes of §6.3 belong to the Agent; this one belongs to the exhibitor and is
 * reached by a browser. That asymmetry is the whole file: there is no
 * `Credential` argument anywhere below, because the party arriving here is the
 * customer and Z1 has nothing to say about them.
 *
 * **CL2 is the design, not a caveat.**
 *
 * > **CL2.** `GET {claim_url}` **MUST** be **prefetch-safe**: it **MUST NOT**
 * > transition `handed_off → claimed` and **MUST NOT** consume the token.
 * > Consumption requires a **non-idempotent confirm**, and the first confirm
 * > binds the claim to that requester (first-touch session or equivalent);
 * > every later presentation from an unbound requester **MUST** fail `409
 * > claim_consumed`. *A messaging app's link scanner fetches that URL before
 * > the human clicks it; consuming on GET burns the customer's seats on their
 * > behalf.*
 *
 * The scanner is not hypothetical and it is not rare: a claim URL sent through
 * any modern chat client is fetched, usually more than once, before a human
 * touches it. A claim endpoint that consumed on GET would therefore burn a
 * customer's seats at the exact rate at which agents deliver links through
 * messaging — silently, and only in the field.
 *
 * So {@link renderClaim} runs inside a **read-only transaction**
 * ({@link CLAIM_RENDER_TX}) and the database itself refuses to let it write.
 * A rule that a future edit could break by adding one `update` is a rule that a
 * future edit will break; a rule the store enforces is not. *A thing that must
 * not happen should not merely be asked not to happen.*
 *
 * **The outcome is returned, never thrown.** Every other module in this package
 * throws a `Refusal`, because a refusal on the agent's surface must not be
 * mixable with rows (§2.7). Here CL3 requires the opposite — *a typed outcome
 * for an expired or consumed claim naming the Occasion and linking `book_url`*,
 * because "landing on an empty cart with no explanation is the exact failure
 * this specification exists to prevent" — and a refusal document is
 * `additionalProperties: false` with no member for either. So the claim surface
 * returns a {@link ClaimOutcome}: the same closed `code` from the same closed
 * taxonomy, with the Occasion and the booking URL beside it.
 *
 * **The residual, stated.** CHANGEOVER cannot bind a Hold to a person and does
 * not try. The exhibitor's first-touch binding below is the only place a person
 * enters, and the property that makes the design privacy-preserving is the same
 * property that makes wrong-party delivery undetectable: if an Agent hands
 * customer A's claim URL to customer B, no signal in this protocol can see it.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db, Queryable, TransactionOptions } from "@changeover/store/db.ts";
import type { Rfc3339 } from "@changeover/schema/scalars.ts";
import type { RefusalCode, Remediation } from "@changeover/schema/refusal.ts";
import { REFUSAL_REMEDIATION, REFUSAL_STATUS, refuse } from "@changeover/schema/refusal.ts";
import { rfc3339Column, serverTime } from "./clock.ts";
import type { HoldRow, HoldState } from "./derived.ts";
import { HOLD_COLUMNS, HOLD_STATE, deriveState, seatsAsGranted } from "./derived.ts";
import { lockSeats } from "./locking.ts";

/* ── 1 · The three binding modes ───────────────────────────────────────────── */

/**
 * §4.10. `claim_binding` is REQUIRED in the capability document, because no
 * major CMS front end publishes a documented way to inject an externally-minted
 * hold into a browser session and this is the hardest integration in the design.
 *
 * - `session_resume` — `GET {claim_url}` sets the exhibitor's own session to a
 *   cart of exactly the held seats. Best, and the most work.
 * - `deep_link` — the URL carries `showtime_id`, `seat_ids[]` and a signed claim
 *   token and lands on the existing seat-select page with those seats
 *   pre-selected. **What most exhibitors can ship in a fortnight, and a
 *   first-class conformance target** — which is why it is the default here.
 * - `manual` — `claim_url` *is* `book_url` and the hold expires unclaimed. An
 *   honest on-ramp that admits the walk is not yet survivable at that site
 *   rather than pretending it is.
 */
export const CLAIM_BINDING = {
  session_resume: "session_resume",
  deep_link: "deep_link",
  manual: "manual",
} as const;

export type ClaimBinding = (typeof CLAIM_BINDING)[keyof typeof CLAIM_BINDING];

export const CLAIM_BINDINGS: readonly ClaimBinding[] = Object.freeze(
  Object.keys(CLAIM_BINDING) as ClaimBinding[],
);

/** The default. §4.10 calls `deep_link` a first-class conformance target. */
export const DEFAULT_CLAIM_BINDING: ClaimBinding = CLAIM_BINDING.deep_link;

/** Where each binding's URL lands on the exhibitor's own origin. */
export interface ClaimPaths {
  readonly session_resume: string;
  readonly deep_link: string;
}

export const CLAIM_PATHS: ClaimPaths = Object.freeze({
  session_resume: "/changeover/claim",
  deep_link: "/tickets/select",
});

/**
 * The two query members a claim URL carries, and their names.
 *
 * `hold` is the Hold's own identifier, not a derivation of the token: see
 * {@link mintClaimToken} for why the two are separate values. `deep_link` adds
 * `showtime_id` and `seat_ids` beside them, exactly as §4.10 describes.
 */
export const CLAIM_PARAM = { hold: "hold", token: "claim" } as const;

/* ── 2 · O1 — same-origin, compared as a parsed triple ─────────────────────── */

/**
 * O1: every absolute URL emitted in any CHANGEOVER document — `book_url`,
 * `seat_map_ref`, **`claim_url`** — MUST be same-origin with `venue.origin`,
 * compared as the parsed `(scheme, host, port)` triple, ASCII-lowercased,
 * default ports normalised. A URL containing userinfo is invalid regardless of
 * host.
 *
 * O2 makes the *Agent* re-derive each origin from the **parsed** URL and never
 * a string prefix, which is the failure this function exists to not commit:
 * `https://tickets.embassy.example.attacker.test/` starts with
 * `https://tickets.embassy.example` and is a different origin.
 */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // "A URL containing userinfo is invalid regardless of host." Not merely
  // ignored — invalid, because `https://tickets.embassy.example@attacker.test/`
  // reads to a human as the first host and resolves to the second.
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // `URL` already lowercases scheme and host and drops the default port.
  return `${parsed.protocol}//${parsed.host}`;
}

/** True where both parse and their `(scheme, host, port)` triples are equal. */
export function sameOrigin(a: string, b: string): boolean {
  const left = originOf(a);
  const right = originOf(b);
  return left !== null && right !== null && left === right;
}

/* ── 3 · The token (CL1) ───────────────────────────────────────────────────── */

/**
 * > **CL1.** `claim_url` MUST be same-origin under O1. Its token MUST carry
 * > ≥128 bits from a CSPRNG, MUST NOT derive from `hold_id`, and MUST NOT be
 * > sequential or timestamp-ordered.
 *
 * 256 bits, from `randomBytes`. Twice the floor because the floor is a floor,
 * and because this value is the only thing standing between a link scanner's
 * URL and a stranger's seats.
 */
export const CLAIM_TOKEN_NONCE_BYTES = 32;

/** `<nonce>.<mac>`: 43 base64url characters, a dot, 43 base64url characters. */
export const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{43}$/;

/**
 * The nonce. **This is the token's entropy and it is all of the token's
 * entropy**: 32 fresh CSPRNG bytes, with no input at all — not `hold_id`, not a
 * counter, not a clock. A caller cannot influence it because there is no
 * parameter with which to try.
 *
 * CL1's three prohibitions are three ways of saying one thing: a claim token
 * must not be *predictable*. A derivation from `hold_id` is predictable to
 * anyone holding a `hold_id`; a sequence is predictable to anyone holding one
 * neighbour; a timestamp ordering is predictable to anyone holding a clock.
 */
export function mintClaimToken(): string {
  return randomBytes(CLAIM_TOKEN_NONCE_BYTES).toString("base64url");
}

/**
 * The authenticator, over the hand-off facts this token is good for.
 *
 * **Why a keyed MAC rather than a stored digest.** `read_token_hmac` has a
 * column on `hold` and this does not; adding one belongs to CORE-001 and is
 * named as a want in this item's return. Until it exists, the token
 * authenticates *itself*: the server recomputes the MAC from the row it is
 * presented against and compares in constant time. Nothing is stored, so
 * nothing can leak, and there is no second place for the two to drift apart.
 *
 * **This is not the derivation CL1 forbids.** A derivation is a function of
 * `hold_id` that anyone holding a `hold_id` can compute. A MAC under a secret
 * key is the opposite: it is a function nobody without the key can compute, and
 * it carries no entropy of its own — the entropy is the nonce, and the nonce
 * has no inputs. Binding the MAC to `(hold_id, handed_off_at,
 * claim_expires_at)` is what makes a token minted for one Hold worthless
 * against another, and what makes a token minted for an earlier hand-off
 * worthless after a re-date.
 */
export function claimTokenMac(
  hold_id: string,
  handed_off_at: Rfc3339,
  claim_expires_at: Rfc3339,
  nonce: string,
  secret?: string,
): string {
  const key = typeof secret === "string" && secret.length > 0 ? Buffer.from(secret, "utf8") : processKey();
  return createHmac("sha256", key)
    .update(`claim\n${hold_id}\n${handed_off_at}\n${claim_expires_at}\n${nonce}`, "utf8")
    .digest("base64url");
}

/** `<nonce>.<mac>`. The value that travels in the URL and nowhere else (CL5). */
export function claimToken(
  hold_id: string,
  handed_off_at: Rfc3339,
  claim_expires_at: Rfc3339,
  secret?: string,
): string {
  const nonce = mintClaimToken();
  return `${nonce}.${claimTokenMac(hold_id, handed_off_at, claim_expires_at, nonce, secret)}`;
}

/**
 * True where `presented` is a token this server minted for exactly this Hold's
 * current hand-off. Constant-time, and false for every malformed input rather
 * than throwing: a claim endpoint is reachable by anyone with the URL, so every
 * shape of garbage arrives here eventually and none of it is exceptional.
 */
export function claimTokenIsValid(
  hold_id: string,
  handed_off_at: Rfc3339 | null,
  claim_expires_at: Rfc3339 | null,
  presented: string | null | undefined,
  secret?: string,
): boolean {
  if (handed_off_at === null || claim_expires_at === null) return false;
  if (typeof presented !== "string" || !CLAIM_TOKEN_PATTERN.test(presented)) return false;
  const dot = presented.lastIndexOf(".");
  const nonce = presented.slice(0, dot);
  const mac = presented.slice(dot + 1);
  const expected = Buffer.from(
    claimTokenMac(hold_id, handed_off_at, claim_expires_at, nonce, secret),
    "utf8",
  );
  const supplied = Buffer.from(mac, "utf8");
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(expected, supplied);
}

/**
 * The MAC key. `CHANGEOVER_CLAIM_SECRET` where a deployment sets one; otherwise
 * 32 fresh bytes, once, for the life of this process.
 *
 * The fallback fails **closed** and loudly: a restart invalidates every
 * outstanding claim URL, which renders as `404 hold_not_found` on the claim
 * page rather than as a stranger's seats opening for someone. A multi-node
 * deployment that does not set the variable discovers it on its first
 * cross-node claim, immediately, instead of discovering it never.
 */
function processKey(): Buffer {
  const configured = process.env.CHANGEOVER_CLAIM_SECRET;
  if (typeof configured === "string" && configured.length > 0) {
    return Buffer.from(configured, "utf8");
  }
  EPHEMERAL_KEY ??= randomBytes(32);
  return EPHEMERAL_KEY;
}

let EPHEMERAL_KEY: Buffer | null = null;

/* ── 4 · Minting the URL ───────────────────────────────────────────────────── */

/** What the Occasion contributes: its O1 origin, and where a customer books. */
export interface ClaimSite {
  /** `venue.origin` as an O1 bare origin — the `occasion.origin` column. */
  readonly origin: string;
  /** The Occasion's `book_url`, or `null` where it publishes none. */
  readonly book_url: string | null;
  /** G1 step 6's cutoff, and T5's clamp. */
  readonly sales_cutoff_at: Rfc3339 | null;
}

/** The hand-off facts a claim URL is minted from. */
export interface ClaimFacts {
  readonly hold_id: string;
  readonly showtime_id: string;
  readonly seats: readonly string[];
  readonly handed_off_at: Rfc3339;
  readonly claim_expires_at: Rfc3339;
}

export interface MintedClaim {
  readonly claim_url: string;
  readonly claim_binding: ClaimBinding;
  /** `null` in `manual`: there is no token, and the Hold expires unclaimed. */
  readonly claim_token: string | null;
}

export interface ClaimOptions {
  readonly binding?: ClaimBinding;
  readonly paths?: ClaimPaths;
  readonly secret?: string;
}

/**
 * Mint the one claim URL this Hold will ever have.
 *
 * **Minted once, at hand-off, and never re-derivable.** Nothing is stored, so
 * `get_hold` on a handed-off Hold cannot produce it again — which is why this
 * module deliberately publishes no `ClaimUrlSource` for CORE-003's seam. That
 * is CL5 made structural rather than promised: *"MUST NOT emit it anywhere but
 * the surface delivering it to the customer who formed the intent."* A server
 * that could re-emit the credential on any subsequent read would be one
 * mis-scoped read away from emitting it to the wrong reader, and an I9 replay
 * would carry it too.
 */
export function mintClaim(site: ClaimSite, facts: ClaimFacts, options: ClaimOptions = {}): MintedClaim {
  const binding = options.binding ?? DEFAULT_CLAIM_BINDING;
  const paths = options.paths ?? CLAIM_PATHS;

  if (binding === CLAIM_BINDING.manual) {
    // `claim_url` IS `book_url`, there is no token, and the Hold expires
    // unclaimed. Honest, and it still satisfies `hold.schema.json`, which
    // requires a `claim_url` and does not require it to be single-use.
    const book_url = site.book_url;
    if (book_url === null || !sameOrigin(book_url, site.origin)) {
      throw refuse(
        "upstream_unavailable",
        "This site publishes no booking URL on its own origin to hand the customer to.",
        { retry_after_ms: 5000 },
      );
    }
    return { claim_url: book_url, claim_binding: binding, claim_token: null };
  }

  const token = claimToken(facts.hold_id, facts.handed_off_at, facts.claim_expires_at, options.secret);
  const path = binding === CLAIM_BINDING.session_resume ? paths.session_resume : paths.deep_link;
  const url = new URL(path, site.origin);
  if (binding === CLAIM_BINDING.deep_link) {
    // §4.10: "carries `showtime_id`, `seat_ids[]` and a signed claim token and
    // lands on the existing seat-select page with those seats pre-selected".
    url.searchParams.set("showtime_id", facts.showtime_id);
    url.searchParams.set("seat_ids", facts.seats.join(","));
  }
  url.searchParams.set(CLAIM_PARAM.hold, facts.hold_id);
  url.searchParams.set(CLAIM_PARAM.token, token);

  const claim_url = url.toString();
  // O1, asserted rather than assumed. `new URL(path, origin)` cannot leave the
  // origin for a path-shaped `path`, but a `path` of `//attacker.test/x` is a
  // protocol-relative URL and does exactly that.
  if (!sameOrigin(claim_url, site.origin)) {
    throw refuse(
      "upstream_unavailable",
      "This site's configured claim path does not resolve on its own origin.",
      { retry_after_ms: 5000 },
    );
  }
  return { claim_url, claim_binding: binding, claim_token: token };
}

/* ── 5 · The presentation ──────────────────────────────────────────────────── */

/** What a browser presents at the claim endpoint. Nothing else is read (CL3). */
export interface PresentedClaim {
  readonly hold_id: string;
  readonly claim_token: string;
}

/**
 * Read a presentation out of a claim URL.
 *
 * > **CL3.** The claim endpoint MUST NOT accept any parameter that alters the
 * > Hold.
 *
 * Which is why this returns exactly two members and there is nowhere to put a
 * third. `seat_ids` and `showtime_id` ride along in `deep_link` for the
 * exhibitor's own seat-select page to read; **this module never reads them**,
 * so a customer who edits them in the address bar changes what their own front
 * end pre-selects and changes nothing at all about the Hold.
 */
export function parseClaimUrl(url: string): PresentedClaim | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hold_id = parsed.searchParams.get(CLAIM_PARAM.hold);
  const claim_token = parsed.searchParams.get(CLAIM_PARAM.token);
  if (hold_id === null || claim_token === null) return null;
  return { hold_id, claim_token };
}

/** The exhibitor's own first-touch identity for the party at the endpoint. */
export interface ClaimRequester {
  /**
   * An opaque first-touch value minted by the exhibitor's front end — a session
   * id, or whatever that front end already uses to tell one browser from
   * another. **Never persisted**: only a MAC over it leaves this function, and
   * only to the requester it describes.
   */
  readonly binding_ref: string;
  /** The receipt a previous confirm handed this requester, where it has one. */
  readonly claim_receipt?: string;
}

/* ── 6 · The outcome (CL3) ─────────────────────────────────────────────────── */

/** CL3: enough to name the Occasion and link `book_url` on every outcome. */
export interface ClaimSubject {
  readonly hold_id: string;
  readonly occasion_id: string;
  readonly showtime_id: string;
  /** M2: the seats **as granted**, from `hold`. Never a count over `hold_seat`. */
  readonly seats: readonly string[];
  readonly book_url: string | null;
  readonly claim_expires_at: Rfc3339 | null;
}

export interface ClaimOk {
  readonly ok: true;
  readonly status: 200;
  readonly state: "handed_off" | "claimed";
  readonly subject: ClaimSubject;
  /** `false` on every GET (CL2). `true` only after a confirm. */
  readonly consumed: boolean;
  /** The first-touch binding, handed to the requester that established it. */
  readonly claim_receipt?: string;
  readonly server_time: Rfc3339;
}

export interface ClaimRefused {
  readonly ok: false;
  /** `REFUSAL_STATUS[code]` — 404, 409 or 410. */
  readonly status: number;
  readonly code: RefusalCode;
  readonly remediation: Remediation;
  /** A prose envelope. Non-load-bearing, never an instruction (§2.7). */
  readonly reason: string;
  /** CL3. `null` only where no Hold was found to name one. */
  readonly subject: ClaimSubject | null;
  readonly state: HoldState | null;
  readonly revocation_reason?: string;
  readonly server_time: Rfc3339;
}

export type ClaimOutcome = ClaimOk | ClaimRefused;

/* ── 7 · GET — prefetch-safe by construction (CL2) ─────────────────────────── */

/**
 * The transaction options {@link renderClaim} opens with, exported as **data**
 * so a proof can read the guarantee rather than infer it from behaviour.
 *
 * `readOnly: true` becomes `SET TRANSACTION READ ONLY`, and Postgres then
 * refuses every `insert`, `update` and `delete` in the transaction with `25006
 * read_only_sql_transaction`. CL2 stops being a property of this file's current
 * contents and becomes a property of the store.
 */
export const CLAIM_RENDER_TX: TransactionOptions = Object.freeze({ readOnly: true });

/**
 * `GET {claim_url}`. Renders what the customer is about to claim, and consumes
 * nothing.
 *
 * Safe to call any number of times, by anyone, including a link scanner that
 * fetches the URL twenty times before a human sees it. The Hold is still
 * `handed_off` afterwards, the token is still good, and the seats are still
 * there.
 */
export async function renderClaim(
  db: Db,
  presented: PresentedClaim,
  options: ClaimOptions = {},
): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    // K4: one time source, and it is the database.
    const server_time = await serverTime(tx);
    const found = await loadClaimTarget(tx, presented.hold_id);
    if (found === null) return unknownClaim(server_time);
    if (!claimTokenIsValid(
      found.row.hold_id,
      found.row.handed_off_at,
      found.row.claim_expires_at,
      presented.claim_token,
      options.secret,
    )) {
      return unknownClaim(server_time);
    }

    const state = deriveState(found.row, server_time);
    const subject = subjectOf(found);
    const blocked = blockingOutcome(state, subject, found.row, server_time);
    if (blocked !== null) return blocked;

    return {
      ok: true,
      status: 200,
      state: HOLD_STATE.handed_off,
      subject,
      // CL2, in one member. A GET has consumed nothing and says so.
      consumed: false,
      server_time,
    };
  }, CLAIM_RENDER_TX);
}

/* ── 8 · The confirm — non-idempotent, and it binds (CL2, R3) ──────────────── */

/**
 * The confirm. **Not idempotent, by design**: this is the one call that
 * transitions `handed_off → claimed`, and CL2 requires that it be reachable only
 * by an action a link scanner does not take.
 *
 * > **R3.** The claim transaction MUST take an exclusive lock on the Hold and
 * > re-read its state inside that transaction; a claim against a Hold not in
 * > `handed_off` MUST fail.
 *
 * Both halves are below and neither is optional: the `for update` is what makes
 * two simultaneous confirms serialise, and the re-read inside the lock is what
 * makes the state the transition is decided on the state at the moment of the
 * transition rather than the state a moment before it.
 *
 * **First-touch binding.** The first confirm stamps `claimed_at` and returns a
 * {@link ClaimRequester.claim_receipt} — a MAC over `(hold_id, claimed_at,
 * binding_ref)`. A later confirm from that same requester presents the receipt
 * and is answered; a later confirm from anyone else is `409 claim_consumed`.
 * The receipt is the binding: unforgeable without the key, worthless against
 * another Hold, and stored nowhere, so there is no record of who claimed and no
 * way for this protocol to learn.
 */
export async function confirmClaim(
  db: Db,
  presented: PresentedClaim,
  requester: ClaimRequester,
  options: ClaimOptions = {},
): Promise<ClaimOutcome> {
  if (typeof requester?.binding_ref !== "string" || requester.binding_ref.length === 0) {
    // CL2's "first-touch session or equivalent". A confirm that cannot say who
    // is confirming cannot bind, and an unbindable claim is one anybody may
    // replay — which is the failure the binding exists to prevent.
    throw refuse("schema_validation", "A claim confirm must carry the first-touch binding of the requester.");
  }

  return db.transaction(async (tx) => {
    const server_time = await serverTime(tx);
    // R3, first half: the exclusive lock, taken before the state is read.
    const found = await loadClaimTarget(tx, presented.hold_id, { for_update: true });
    if (found === null) return unknownClaim(server_time);
    if (!claimTokenIsValid(
      found.row.hold_id,
      found.row.handed_off_at,
      found.row.claim_expires_at,
      presented.claim_token,
      options.secret,
    )) {
      return unknownClaim(server_time);
    }

    // R3, second half: the state is derived from the row this transaction is
    // holding, at this transaction's own instant.
    const state = deriveState(found.row, server_time);
    const subject = subjectOf(found);

    if (state === HOLD_STATE.claimed) {
      // CL2: "every later presentation FROM AN UNBOUND REQUESTER MUST fail".
      // The requester that established the binding is not unbound, and telling
      // it `claim_consumed` would be telling the customer their own successful
      // claim failed — on a browser back button, which is not a rare event.
      if (receiptBinds(found.row, requester, options.secret)) {
        return {
          ok: true,
          status: 200,
          state: HOLD_STATE.claimed,
          subject,
          consumed: true,
          claim_receipt: requester.claim_receipt,
          server_time,
        };
      }
      return claimConsumed(subject, state, server_time);
    }

    const blocked = blockingOutcome(state, subject, found.row, server_time);
    if (blocked !== null) return blocked;

    // The transition. `claimed_at is null` under the row lock is belt and
    // braces, and it is free: it makes "at most once" a property of the
    // statement rather than of the lock having been taken correctly above.
    const claimed = await tx.query<{ claimed_at: Rfc3339 }>(
      "update hold set claimed_at = $2::timestamptz" +
        " where hold_id = $1 and claimed_at is null and handed_off_at is not null" +
        ` returning ${rfc3339Column("claimed_at")}`,
      [found.row.hold_id, server_time],
    );
    const claimed_at = claimed.rows[0]?.claimed_at;
    if (claimed_at === undefined) return claimConsumed(subject, HOLD_STATE.claimed, server_time);

    // L1: the same seat locks, in the same order, as every other writer. A
    // claim writes the rows a contending `hold_seats` reaps and inserts, so it
    // takes the same locks; skipping them would deadlock against the grant path
    // only under load, which is the one place it would never be found.
    await lockSeats(tx, found.row.showtime_id, seatsAsGranted(found.row));

    // `claimed` is terminal, occupies its seat for the life of the screening and
    // MUST NOT be reaped. `held_until` is deliberately left where hand-off put
    // it: `hold_seat_reap_idx` is partial on `state in ('live','handed_off')`,
    // so a claimed row leaves the reap index altogether and its deadline stops
    // meaning anything. `hold_seat_occupied` still covers it, which is the whole
    // of ADR-005's correction — the draft's index dropped `claimed` and a sold
    // seat became immediately re-holdable with a 201 Created.
    await tx.query(
      "update hold_seat set state = 'claimed' where hold_id = $1 and state in ('live', 'handed_off')",
      [found.row.hold_id],
    );
    // X2's predicate deliberately excludes `claimed`: "two purchases in one
    // cluster by one household are legitimate and are not fan-out". Marking the
    // row is what releases the cluster slot.
    await tx.query(
      "update hold_cluster set state = 'claimed' where hold_id = $1 and state in ('live', 'handed_off')",
      [found.row.hold_id],
    );
    // X1's slot is taken by a LIVE Hold and returns with it. A claimed Hold is
    // not live — the purchase is done — so the household's next hold on this
    // showtime must not be refused for a Hold that has already become a ticket.
    await tx.query("delete from hold_slot where hold_id = $1", [found.row.hold_id]);

    return {
      ok: true,
      status: 200,
      state: HOLD_STATE.claimed,
      subject: { ...subject, claim_expires_at: found.row.claim_expires_at },
      consumed: true,
      claim_receipt: claimReceipt(found.row.hold_id, claimed_at, requester.binding_ref, options.secret),
      server_time,
    };
  });
}

/* ── 9 · The receipt ───────────────────────────────────────────────────────── */

/**
 * The first-touch binding, as a bearer proof rather than a stored row.
 *
 * Bound to `claimed_at` as well as to `hold_id`, so a receipt cannot outlive the
 * claim it describes: were a claim ever re-dated, every receipt for it would
 * stop verifying at once.
 */
export function claimReceipt(
  hold_id: string,
  claimed_at: Rfc3339,
  binding_ref: string,
  secret?: string,
): string {
  const key = typeof secret === "string" && secret.length > 0 ? Buffer.from(secret, "utf8") : processKey();
  return createHmac("sha256", key)
    .update(`receipt\n${hold_id}\n${claimed_at}\n${binding_ref}`, "utf8")
    .digest("base64url");
}

function receiptBinds(row: HoldRow, requester: ClaimRequester, secret?: string): boolean {
  const presented = requester.claim_receipt;
  if (typeof presented !== "string" || presented.length === 0) return false;
  if (row.claimed_at === null) return false;
  const expected = Buffer.from(
    claimReceipt(row.hold_id, row.claimed_at, requester.binding_ref, secret),
    "utf8",
  );
  const supplied = Buffer.from(presented, "utf8");
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(expected, supplied);
}

/* ── 10 · Loading, and the outcomes both surfaces share ────────────────────── */

interface ClaimTarget {
  readonly row: HoldRow;
  readonly site: ClaimSite;
}

interface LoadOptions {
  readonly for_update?: boolean;
}

/**
 * The Hold and its Occasion, **without a credential**.
 *
 * There is no Z1 here and there must not be: Z1 governs verbs *addressing a
 * `hold_id`* on the agent's surface, and the party at this endpoint is the
 * customer, who has no `agent_id`. What stands in its place is the token, which
 * is checked before anything is done with what this returns.
 *
 * Two statements rather than a join: `HOLD_COLUMNS` is CORE-003's unqualified
 * column list and `occasion` carries four columns of the same names, so a join
 * would be ambiguous the moment either side gained a column.
 */
async function loadClaimTarget(
  tx: Queryable,
  hold_id: string,
  options: LoadOptions = {},
): Promise<ClaimTarget | null> {
  const held = await tx.query<HoldRow>(
    `select ${HOLD_COLUMNS} from hold where hold_id = $1` + (options.for_update ? " for update" : ""),
    [hold_id],
  );
  const row = held.rows[0];
  if (row === undefined) return null;
  const site = await loadClaimSite(tx, row.occasion_id);
  if (site === null) return null;
  return { row, site };
}

/**
 * The Occasion's contribution to a hand-off and to a claim: its O1 origin, its
 * `book_url`, and G1 step 6's cutoff.
 *
 * Exported because `hand_off` needs exactly these three and a second hand-rolled
 * `select` would be a second chance to reach for `occasion.showtime_id` when the
 * Hold's own `showtime_id` is the one the seat index is keyed on.
 */
export async function loadClaimSite(tx: Queryable, occasion_id: string): Promise<ClaimSite | null> {
  const result = await tx.query<{ origin: string; book_url: string | null; sales_cutoff_at: Rfc3339 | null }>(
    "select origin, document->>'book_url' as book_url," +
      ` ${rfc3339Column("sales_cutoff_at")} from occasion where occasion_id = $1`,
    [occasion_id],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { origin: row.origin, book_url: row.book_url, sales_cutoff_at: row.sales_cutoff_at };
}

function subjectOf(found: ClaimTarget): ClaimSubject {
  return {
    hold_id: found.row.hold_id,
    occasion_id: found.row.occasion_id,
    showtime_id: found.row.showtime_id,
    // M2. Not a count over `hold_seat`, in any state, ever.
    seats: seatsAsGranted(found.row),
    book_url: found.site.book_url,
    claim_expires_at: found.row.claim_expires_at,
  };
}

/**
 * Every state that is not `handed_off`, as the outcome CL3 requires — typed,
 * naming the Occasion, linking `book_url`.
 *
 * Returns `null` for `handed_off`, which is the one state in which there is
 * nothing to say and the caller carries on.
 */
function blockingOutcome(
  state: HoldState,
  subject: ClaimSubject,
  row: HoldRow,
  server_time: Rfc3339,
): ClaimRefused | null {
  if (state === HOLD_STATE.handed_off) return null;
  if (state === HOLD_STATE.claimed) return claimConsumed(subject, state, server_time);
  if (state === HOLD_STATE.revoked) {
    return refused(
      "hold_revoked",
      "The venue withdrew these seats. The booking page below is the way to seats for this screening.",
      subject,
      state,
      server_time,
      row.revocation_reason ?? undefined,
    );
  }
  if (state === HOLD_STATE.expired) {
    // A handed-off Hold that ran out is `claim_expired` — 410, remediation
    // `use_book_url`, which is why `book_url` is on the subject. A Hold that was
    // never handed off cannot reach here: its token could not have verified.
    return refused(
      "claim_expired",
      "The window to claim these seats has closed. They are back on sale at the booking page below.",
      subject,
      state,
      server_time,
    );
  }
  // `live` and `released` are both unreachable with a valid token — `live` has
  // no `handed_off_at` to sign, and R1 forbids releasing a handed-off Hold — so
  // this is the branch that exists to be honest if either ever becomes reachable.
  return refused(
    "hold_not_live",
    "These seats are not in a state that can be claimed.",
    subject,
    state,
    server_time,
  );
}

function claimConsumed(subject: ClaimSubject, state: HoldState, server_time: Rfc3339): ClaimRefused {
  return refused(
    "claim_consumed",
    "These seats have already been claimed. If that was not you, the booking page below has seats for this screening.",
    subject,
    state,
    server_time,
  );
}

/**
 * An unrecognised or unparseable presentation.
 *
 * `hold_not_found`, and deliberately the same answer for "no such Hold", "not a
 * token this server minted" and "a token for an earlier hand-off". Three
 * answers would tell whoever is guessing which guess was closer.
 */
function unknownClaim(server_time: Rfc3339): ClaimRefused {
  return refused(
    "hold_not_found",
    "This claim link is not one this site recognises.",
    null,
    null,
    server_time,
  );
}

function refused(
  code: RefusalCode,
  reason: string,
  subject: ClaimSubject | null,
  state: HoldState | null,
  server_time: Rfc3339,
  revocation_reason?: string,
): ClaimRefused {
  const outcome: ClaimRefused = {
    ok: false,
    status: REFUSAL_STATUS[code],
    code,
    remediation: REFUSAL_REMEDIATION[code],
    reason,
    subject,
    state,
    server_time,
  };
  return revocation_reason === undefined ? outcome : { ...outcome, revocation_reason };
}
