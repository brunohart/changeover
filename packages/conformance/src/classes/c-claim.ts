// C-CLAIM. Owner: TEST-006.
//
// §7, the half of the C-SEATMAP / C-CLAIM row that is about the claim: *"`GET
// {claim_url}` is prefetch-safe and does not consume; a second confirm returns
// `claim_consumed`; an expired claim renders a typed outcome naming the
// Occasion."*
//
// **The cheap check is to call the render twice and see the same document
// back.** It would pass on a Server that transitions `handed_off → claimed` on
// the first GET and then keeps answering happily, because the *document* a
// claimed Hold renders is very nearly the document a handed-off one renders.
// What separates them is `hold.claimed_at`, in the store. So every prefetch
// assertion below reads the store afterwards, and the class asserts the
// mechanism as well as the effect: `CLAIM_RENDER_TX` is `readOnly`, and the
// database — not this file, and not the current contents of `claim.ts` — is
// what refuses the write. A rule a future edit could break by adding one
// `update` is a rule a future edit will break.
//
// **The scanner is the whole reason.** A claim URL delivered through any modern
// chat client is fetched, usually more than once, before a human touches it. So
// the prefetch clause here fetches twenty times, from nothing that could be
// called a session, and then asks the store whether anything moved.
//
// **How the expired fixture is built, and why that is honest.** The claim token
// is a MAC over `(hold_id, handed_off_at, claim_expires_at)`, so a fixture that
// ages those columns invalidates the token the hand-off minted and the endpoint
// would answer `404` — the right answer to a forged token, and the wrong
// fixture for CL3. The Hold is therefore aged by shifting every timestamp
// **relative to itself** by one interval, which preserves `hold_floor_derived`
// and `hold_expiry_not_before_floor` by construction, and the token is re-minted
// from the aged facts: exactly the token a customer would be holding in a world
// where those two minutes had passed. Nothing here waits two minutes, and
// nothing here weakens what is being asserted.

import type { Rfc3339 } from "@changeover/schema/scalars.ts";
import {
  CLAIM_RENDER_TX,
  claimToken,
  confirmClaim,
  parseClaimUrl,
  renderClaim,
} from "@changeover/core/claim.ts";
import type { ClaimOutcome, PresentedClaim } from "@changeover/core/claim.ts";
import { rfc3339Column } from "@changeover/core/clock.ts";
import { ROUTES } from "@changeover/http/routes.ts";
import { sqlstate } from "@changeover/store/db.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { ConformanceBench } from "./_bench.ts";
import { CLAIM_SECRET, TOKEN, grantHold, key } from "./_bench.ts";

export const id = "C-CLAIM";
export const spec_row =
  "GET {claim_url} is prefetch-safe and does not consume; a second confirm returns claim_consumed;" +
  " an expired claim renders a typed outcome naming the Occasion.";

/** How many times a link scanner is assumed to fetch before a human clicks. */
const SCANS = 20;

interface HandedOff {
  readonly hold_id: string;
  readonly presented: PresentedClaim;
  readonly claim_url: string;
}

/** Grant a Hold over `seats` and hand it off, returning what the customer holds. */
async function handOff(
  bench: ConformanceBench,
  seats: readonly string[],
  label: string,
): Promise<HandedOff | string> {
  const granted = await grantHold(bench, TOKEN.a, seats, {}, `${label}-${bench.nonce}`);
  if (granted.status !== 201) return `grant ${granted.status} ${granted.text.slice(0, 160)}`;
  const hold_id = String((granted.json as { hold_id: string }).hold_id);

  const read = await bench.call("GET", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.a });
  const handed = await bench.call("POST", `/changeover/v0/holds/${hold_id}/hand-off`, {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`${label}-off-${bench.nonce}`) },
    body: { read_token: (read.json as { read_token?: string } | null)?.read_token },
  });
  if (handed.status !== 200) return `hand_off ${handed.status} ${handed.text.slice(0, 160)}`;

  const claim_url = String(
    (handed.json as { handoff?: { claim_url?: string } } | null)?.handoff?.claim_url ?? "",
  );
  const presented = parseClaimUrl(claim_url);
  if (presented === null) return `the hand-off carried no claim_url that parses (${claim_url.slice(0, 80)})`;
  return { hold_id, presented, claim_url };
}

/** The three markers M1 derives state from, as the store holds them. */
async function markers(
  bench: ConformanceBench,
  hold_id: string,
): Promise<{ claimed_at: string | null; released_at: string | null; seats: string }> {
  const hold = await bench.db.query<{ claimed_at: string | null; released_at: string | null }>(
    "select claimed_at::text as claimed_at, released_at::text as released_at from hold where hold_id = $1",
    [hold_id],
  );
  const seats = await bench.db.query<{ seat_id: string; state: string }>(
    "select seat_id, state from hold_seat where hold_id = $1 order by seat_id",
    [hold_id],
  );
  return {
    claimed_at: hold.rows[0]?.claimed_at ?? null,
    released_at: hold.rows[0]?.released_at ?? null,
    seats: JSON.stringify(seats.rows),
  };
}

function refusedCode(outcome: ClaimOutcome): string {
  return outcome.ok ? `ok:${outcome.state}` : outcome.code;
}

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  /* ── 1 · A Hold in the one state a claim can be presented against ─────── */

  const off = await handOff(bench, ["A:1", "A:2"], "claim");
  if (typeof off === "string") {
    c.bad("fixture", `no handed-off Hold to claim: ${off}`);
    return c.items;
  }
  c.ok("fixture", `${off.hold_id} is handed off and the customer holds a claim URL for two seats`);

  /* ── 2 · Prefetch-safety, asserted on the store ───────────────────────── */

  let rendered_ok = 0;
  let consumed_on_get = 0;
  for (let i = 0; i < SCANS; i++) {
    const outcome = await renderClaim(bench.db, off.presented, { secret: CLAIM_SECRET });
    if (outcome.ok && outcome.state === "handed_off") rendered_ok++;
    if (outcome.ok && outcome.consumed) consumed_on_get++;
  }
  c.is(
    "prefetch_renders",
    rendered_ok,
    SCANS,
    `${SCANS} GETs of the claim URL — a messaging app's link scanner, before any human — each rendered the handed-off Hold`,
  );
  c.is(
    "prefetch_says_unconsumed",
    consumed_on_get,
    0,
    "and not one of them reported `consumed`, which is CL2 in the one member a customer's front end reads",
  );

  const after_scans = await markers(bench, off.hold_id);
  c.is(
    "prefetch_store",
    after_scans.claimed_at,
    null,
    `and the store agrees: hold.claimed_at is still null after ${SCANS} renders, so nothing transitioned handed_off → claimed behind an unchanged-looking document`,
  );

  /* ── 3 · The mechanism, not the current contents of claim.ts ──────────── */

  c.that(
    "render_tx_read_only",
    CLAIM_RENDER_TX.readOnly === true,
    "the transaction options renderClaim opens with are exported as data and say readOnly, so the guarantee can be read rather than inferred from behaviour",
  );

  let write_in_render_tx = "no error";
  try {
    await bench.db.transaction(
      (tx) => tx.query("update hold set expires_at = expires_at where hold_id = $1", [off.hold_id]),
      CLAIM_RENDER_TX,
    );
  } catch (err) {
    write_in_render_tx = sqlstate(err) ?? "threw";
  }
  c.is(
    "render_tx_enforced",
    write_in_render_tx,
    "25006",
    "and the database refuses an UPDATE inside that transaction (read_only_sql_transaction) — CL2 is a property of the store, so an edit that added one write to renderClaim would fail there rather than burn a customer's seats in the field",
  );

  /* ── 4 · The confirm consumes, once ───────────────────────────────────── */

  const first = await confirmClaim(bench.db, off.presented, { binding_ref: "sess-first-touch" }, { secret: CLAIM_SECRET });
  c.that(
    "confirm_consumes",
    first.ok && first.state === "claimed" && first.consumed,
    `the non-idempotent confirm transitions to claimed and says consumed (${refusedCode(first)})`,
  );
  const receipt = first.ok ? first.claim_receipt : undefined;
  c.that(
    "confirm_receipt",
    typeof receipt === "string" && receipt.length > 0,
    "and it hands the requester a receipt, which is the first-touch binding CL2 requires and the only thing that makes a later presentation distinguishable",
  );

  const after_confirm = await markers(bench, off.hold_id);
  c.that(
    "confirm_store",
    after_confirm.claimed_at !== null,
    `and the store carries claimed_at, so the transition is a fact about the Hold and not a member of a response (${String(after_confirm.claimed_at).slice(0, 32)})`,
  );

  const again = await confirmClaim(
    bench.db,
    off.presented,
    { binding_ref: "sess-first-touch", claim_receipt: receipt },
    { secret: CLAIM_SECRET },
  );
  c.that(
    "receipt_binds",
    again.ok && again.state === "claimed",
    `the same requester presenting its receipt is answered rather than refused (${refusedCode(again)}) — a customer who reloads the page they were sent to must not be locked out of their own claim`,
  );

  /* ── 5 · A second confirm, from anybody else ──────────────────────────── */

  const stranger = await confirmClaim(bench.db, off.presented, { binding_ref: "sess-someone-else" }, { secret: CLAIM_SECRET });
  c.is(
    "second_confirm",
    refusedCode(stranger),
    "claim_consumed",
    "a later presentation from an unbound requester fails claim_consumed",
  );
  c.is(
    "second_confirm_status",
    stranger.ok ? 0 : stranger.status,
    409,
    "and it is a 409, which is what the closed taxonomy maps that code to",
  );
  const consumed_subject = stranger.ok ? null : stranger.subject;
  c.that(
    "consumed_names_occasion",
    consumed_subject !== null &&
      consumed_subject.occasion_id === "occ_conf_main" &&
      typeof consumed_subject.book_url === "string" &&
      consumed_subject.book_url.length > 0,
    `and CL3's typed outcome names the Occasion and links book_url (${consumed_subject?.occasion_id ?? "no subject"} → ${consumed_subject?.book_url ?? "no book_url"}) — landing on an empty cart with no explanation is the exact failure this is here to prevent`,
  );

  const after_stranger = await markers(bench, off.hold_id);
  c.is(
    "second_confirm_store",
    after_stranger.claimed_at,
    after_confirm.claimed_at,
    "and the refused confirm moved nothing: claimed_at is the instant the first one stamped, unchanged",
  );

  /* ── 6 · CL3 — no parameter that alters the Hold ──────────────────────── */
  //
  // The deep link carries `showtime_id` and `seat_ids` for the exhibitor's own
  // seat-select page. A customer who edits them in the address bar changes what
  // their front end pre-selects and must change nothing about the Hold.

  const tampered = off.claim_url
    .replace(/seat_ids=[^&]*/, "seat_ids=Z%3A99%2CZ%3A98")
    .replace(/showtime_id=[^&]*/, "showtime_id=occ_conf_sought");
  const tampered_presented = parseClaimUrl(tampered);
  c.that(
    "no_altering_param",
    tampered_presented !== null &&
      tampered_presented.hold_id === off.presented.hold_id &&
      tampered_presented.claim_token === off.presented.claim_token,
    "a claim URL with edited seat_ids and showtime_id parses to exactly the two members the endpoint reads — there is nowhere to put a third",
  );

  const before_tamper = await markers(bench, off.hold_id);
  await renderClaim(bench.db, tampered_presented ?? off.presented, { secret: CLAIM_SECRET });
  await confirmClaim(bench.db, tampered_presented ?? off.presented, { binding_ref: "sess-tamperer" }, { secret: CLAIM_SECRET });
  const after_tamper = await markers(bench, off.hold_id);
  c.is(
    "tamper_store",
    JSON.stringify(after_tamper),
    JSON.stringify(before_tamper),
    "and putting the tampered URL through both surfaces left the Hold and every one of its seat rows byte-identical in the store",
  );

  /* ── 7 · The expired claim (CL3, the other typed outcome) ─────────────── */

  const stale = await handOff(bench, ["B:1"], "claim-stale");
  if (typeof stale === "string") {
    c.bad("expired_fixture", `no second handed-off Hold to age: ${stale}`);
    return c.items;
  }

  // Every timestamp shifted by ONE interval, relative to itself: the derived
  // equalities the CHECK constraints hold survive by construction, and no clock
  // is read twice. `clock_timestamp()` here would raise 23514 instead.
  const aged = await bench.db.query<{ handed_off_at: Rfc3339; claim_expires_at: Rfc3339 }>(
    "update hold set granted_at = granted_at - interval '10 minutes'," +
      " floor_deadline = floor_deadline - interval '10 minutes'," +
      " expires_at = expires_at - interval '10 minutes'," +
      " handed_off_at = handed_off_at - interval '10 minutes'," +
      " claim_expires_at = claim_expires_at - interval '10 minutes'" +
      " where hold_id = $1" +
      // The SAME projection the claim loader reads these columns through. A
      // hand-rolled to_char here would mint a MAC over a string the loader never
      // produces, and the endpoint would answer 404 — the right answer to a
      // forged token, and a fixture that quietly stopped testing CL3.
      ` returning ${rfc3339Column("handed_off_at")}, ${rfc3339Column("claim_expires_at")}`,
    [stale.hold_id],
  );
  await bench.db.query(
    "update hold_seat set held_until = held_until - interval '10 minutes' where hold_id = $1",
    [stale.hold_id],
  );
  const facts = aged.rows[0];

  if (facts === undefined) {
    c.bad("expired_fixture", "the Hold could not be aged, so no expired claim exists to render");
    return c.items;
  }
  c.ok(
    "expired_fixture",
    `${stale.hold_id} aged ten minutes relative to itself; its claim window closed at ${facts.claim_expires_at}`,
  );

  // Re-minted from the aged facts, because the MAC binds them. This is the token
  // a customer would be holding in a world where those minutes had passed, not a
  // weaker token: `claimTokenIsValid` still has to accept it.
  const expired_presented: PresentedClaim = {
    hold_id: stale.hold_id,
    claim_token: claimToken(stale.hold_id, facts.handed_off_at, facts.claim_expires_at, CLAIM_SECRET),
  };

  const expired = await renderClaim(bench.db, expired_presented, { secret: CLAIM_SECRET });
  c.is("expired_code", refusedCode(expired), "claim_expired", "a claim presented after its window renders claim_expired");
  c.is("expired_status", expired.ok ? 0 : expired.status, 410, "as a 410 — gone, and not retryable");
  const expired_subject = expired.ok ? null : expired.subject;
  c.that(
    "expired_names_occasion",
    expired_subject !== null &&
      expired_subject.occasion_id === "occ_conf_main" &&
      typeof expired_subject.book_url === "string" &&
      expired_subject.book_url.length > 0,
    `and it names the Occasion and links book_url (${expired_subject?.occasion_id ?? "no subject"} → ${expired_subject?.book_url ?? "no book_url"}), which is the difference between a customer who can still buy a ticket and one who cannot`,
  );

  const expired_confirm = await confirmClaim(bench.db, expired_presented, { binding_ref: "sess-late" }, { secret: CLAIM_SECRET });
  c.is(
    "expired_confirm",
    refusedCode(expired_confirm),
    "claim_expired",
    "and the confirm refuses it too, so the window is not a rendering courtesy that a POST walks past",
  );
  const after_expired = await markers(bench, stale.hold_id);
  c.is(
    "expired_store",
    after_expired.claimed_at,
    null,
    "with claimed_at still null in the store — an expired claim consumed nothing",
  );

  /* ── 8 · What this repository has no server for ───────────────────────── */

  const claim_routes = ROUTES.filter((r) => r.pattern.includes("claim") || r.pattern.includes("tickets"));
  c.cannot(
    "fetched_over_the_wire",
    `§7 says GET {claim_url}, and the URL minted here lands at the venue's own seat-select page — deep_link is defined as landing on the exhibitor's EXISTING front end, and §6.3 declares ${ROUTES.length} routes of which ${claim_routes.length} serve a claim. So the render above is renderClaim, the function that endpoint would call, exercised in-process: the store effects are asserted exactly, and the wire behaviour of a page this repository does not contain is not`,
    "packages/http/src/routes.ts",
  );

  return c.items;
}
