#!/usr/bin/env bash
# C-CLAIM. The changeover: hand_off on a Hold past its floor with its seats still
# held SUCCEEDS (HO1), and the claim URL it mints survives being fetched by a
# machine that is not the customer (CL2, CL3, CL5).
#
# The obvious cheaper check would be to call the claim endpoint once and assert a
# 200. It would not have caught either failure this script exists for. A GET that
# consumed the token would still answer 200 the FIRST time — the burn is only
# visible on the second call, or in the store, which is why every assertion below
# reads `hold.claimed_at` and `hold_seat.state` rather than the response. And a
# hand-off refused for being past its floor looks like a correct refusal in every
# log a server keeps: the code was `hold_not_live`, its meaning was "wrong verb",
# and the customer's seats were sitting in the store untouched the whole time.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/core/src/hand-off.ts ]     || { echo "cannot prove — packages/core/src/hand-off.ts missing (CORE-004)"; exit 2; }
[ -f packages/core/src/claim.ts ]        || { echo "cannot prove — packages/core/src/claim.ts missing (CORE-004)"; exit 2; }
[ -f packages/core/src/get-hold.ts ]     || { echo "cannot prove — packages/core/src/get-hold.ts missing (CORE-003 mints the read_token hand_off requires)"; exit 2; }
[ -f packages/core/test/lib/hold-fixtures.ts ] || { echo "cannot prove — packages/core/test/lib/hold-fixtures.ts missing (CORE-003 owns the shared Hold fixture; this proof mints through it rather than hand-rolling a second one)"; exit 2; }
[ -f packages/store/src/migrations/0002_access_log.sql ] || { echo "cannot prove — the access log migration is missing (CORE-001); CL5 cannot be asserted without a log to search"; exit 2; }

node --input-type=module -e '
import { sqlstate } from "./packages/store/src/db.ts";
import { isRefusal } from "./packages/schema/src/refusal.ts";
import { bench, holdIdFor, house, mintHold } from "./packages/core/test/lib/hold-fixtures.ts";
import { rfc3339Column, serverTime } from "./packages/core/src/clock.ts";
import { HOLD_STATE, deriveState } from "./packages/core/src/derived.ts";
import { getHold } from "./packages/core/src/get-hold.ts";
import { releaseHold } from "./packages/core/src/release.ts";
import { handOff, readHoldRow } from "./packages/core/src/hand-off.ts";
import {
  CLAIM_BINDING, CLAIM_RENDER_TX, CLAIM_TOKEN_PATTERN,
  claimToken, claimTokenIsValid, confirmClaim, originOf, parseClaimUrl, renderClaim, sameOrigin,
} from "./packages/core/src/claim.ts";
import { writeAccessLog } from "./packages/core/src/access-log.ts";
import { readFileSync } from "node:fs";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const ORIGIN = "https://reference.example";
const BOOK_URL = ORIGIN + "/book/embassy-sat-1900";
const CREDENTIAL = { agent_id: "agt_reference", principal_scope: "site_wellington" };
const LOG = { epoch: { site_epoch_id: "epoch_claim_proof", key: "a-key-that-is-never-the-token" }, timezone: "Pacific/Auckland" };

// The house, with a book_url in its published document. CL3 links it on every
// outcome, so a customer who lands on a consumed or expired claim is told where
// the seats for this screening are rather than shown an empty cart.
const VENUE = { ...house(), document: { book_url: BOOK_URL } };

/** A live Hold with a fresh read_token, minted through CORE-003s shared fixture. */
async function ready(db, options = {}) {
  const minted = await mintHold(db, { occasion: VENUE, state: HOLD_STATE.live, ...options });
  const read = await getHold(db, minted.hold_id, CREDENTIAL);
  return { hold_id: minted.hold_id, read_token: read.read_token, seats: minted.seats };
}

async function seatStates(db, hold_id) {
  const r = await db.query(
    "select state, " + rfc3339Column("held_until") + " from hold_seat where hold_id = $1 order by seat_id",
    [hold_id],
  );
  return r.rows;
}

const b = await bench([VENUE]);
const db = b.db;
try {
  /* ── HO1 — the sharpest correction in section 4.8 ─────────────────────── */

  // floor_deadline five seconds in the past; expires_at fifty-five seconds out;
  // both seat rows still there. This is exactly the case the draft refused.
  const first = await ready(db, { floor_ms: 1000, lifetime_ms: 60000, granted_ago_ms: 5000 });
  const before_row = await readHoldRow(db, first.hold_id);
  const t0 = await serverTime(db);
  const floor_passed = Date.parse(before_row.floor_deadline) < Date.parse(t0);
  const still_live = deriveState(before_row, t0) === HOLD_STATE.live;
  const held = (await seatStates(db, first.hold_id)).filter((r) => r.state === "live").length;
  floor_passed && still_live && held === 2
    ? ok("the fixture is the case HO1 is about — a Hold whose floor has passed, whose expiry has not, and whose two seat rows are untouched")
    : bad("the fixture is not that case: floor_passed=" + floor_passed + " live=" + still_live + " seats=" + held);

  let handed = null;
  try {
    handed = await handOff(db, { hold_id: first.hold_id, read_token: first.read_token }, CREDENTIAL);
    handed.hold.state === HOLD_STATE.handed_off
      ? ok("HO1 — hand_off on a floor-passed-but-seats-held Hold SUCCEEDS: the guard is expires_at, and never the floor")
      : bad("hand_off returned state " + handed.hold.state);
  } catch (err) {
    bad("HO1 — hand_off refused a Hold whose seats were still held: " + (isRefusal(err) ? err.code : String(err)));
  }

  const claim_url = handed && handed.hold.handoff ? handed.hold.handoff.claim_url : null;
  typeof claim_url === "string" && claim_url.length > 0
    ? ok("the hand-off document carries a claim_url, and this is the one surface that ever emits one (CL5)")
    : bad("the hand-off document carries no claim_url");

  sameOrigin(claim_url || "", ORIGIN) && originOf(claim_url || "") === ORIGIN
    ? ok("CL1/O1 — the claim_url is same-origin with venue.origin, compared as a parsed triple and not a string prefix")
    : bad("the claim_url is not same-origin with " + ORIGIN + ": " + claim_url);

  const h = handed.hold.handoff;
  Date.parse(h.claim_expires_at) - Date.parse(h.handed_off_at) === 120000
    ? ok("T5/CL4 — claim_expires_at = handed_off_at + handoff_floor_ms, and no other base is permitted")
    : bad("claim_expires_at is not handed_off_at + handoff_floor_ms: " + h.handed_off_at + " -> " + h.claim_expires_at);

  const moved = await seatStates(db, first.hold_id);
  moved.length === 2 && moved.every((r) => r.state === "handed_off" && r.held_until === h.claim_expires_at)
    ? ok("T6 — every seat row moved to handed_off with held_until = claim_expires_at, in the same transaction as the transition")
    : bad("held_until did not follow the hand-off: " + JSON.stringify(moved));

  // HO2, and the other half of HO1, asserted structurally rather than promised.
  // The behavioural assertion above says this hand-off accepted a floor-passed
  // Hold; this one says no future edit can quietly reintroduce the guard that
  // refused it. Comments are stripped first, because the prose ABOUT the floor
  // is the whole reason the file mentions it at all.
  const source = readFileSync("packages/core/src/hand-off.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const forbidden = ["floor_deadline", "clock_guard"].filter((id) => source.includes(id));
  forbidden.length === 0
    ? ok("HO1/HO2 — with its comments stripped, hand-off.ts names neither floor_deadline nor clock_guard: the guard that lied cannot come back by accident")
    : bad("hand-off.ts still reads " + forbidden.join(" and ") + " outside a comment");

  /* ── CL2 — the whole point of the endpoint ────────────────────────────── */

  const presented = parseClaimUrl(claim_url);
  let rendered = 0, unchanged = 0;
  for (let i = 0; i < 20; i++) {
    const outcome = await renderClaim(db, presented);
    if (outcome.ok === true && outcome.status === 200 && outcome.state === HOLD_STATE.handed_off && outcome.consumed === false) rendered++;
    const row = await readHoldRow(db, first.hold_id);
    if (row.claimed_at === null && deriveState(row, await serverTime(db)) === HOLD_STATE.handed_off) unchanged++;
  }
  rendered === 20 && unchanged === 20
    ? ok("CL2 — twenty GETs of the claim_url leave the Hold handed_off with claimed_at null, read back from the store after every one")
    : bad("twenty GETs did not leave the store alone: rendered=" + rendered + " unchanged=" + unchanged);

  const after_gets = await readHoldRow(db, first.hold_id);
  claimTokenIsValid(first.hold_id, after_gets.handed_off_at, after_gets.claim_expires_at, presented.claim_token)
    ? ok("CL2 — the token is still unconsumed after twenty fetches: a link scanner did not burn the customer seats on their behalf")
    : bad("the token stopped verifying after twenty GETs");

  let read_only = false;
  try {
    await db.transaction(async (tx) => { await tx.query("update hold set claimed_at = clock_timestamp()"); }, CLAIM_RENDER_TX);
  } catch (err) {
    read_only = sqlstate(err) === "25006";
  }
  read_only && CLAIM_RENDER_TX.readOnly === true
    ? ok("CL2 — the GET path opens a read-only transaction and the store raises 25006 on any write in it: prefetch safety is structural, not a discipline")
    : bad("the render transaction is not read-only, so CL2 rests on nobody ever adding an update to that path");

  /* ── the confirm, and the first-touch binding ─────────────────────────── */

  const confirmed = await confirmClaim(db, presented, { binding_ref: "sess_first_touch" });
  const claimed_row = await readHoldRow(db, first.hold_id);
  confirmed.ok === true && claimed_row.claimed_at !== null
    && deriveState(claimed_row, await serverTime(db)) === HOLD_STATE.claimed
    ? ok("CL2 — the first non-idempotent confirm transitions handed_off to claimed, and the store agrees")
    : bad("the first confirm did not claim: ok=" + confirmed.ok + " claimed_at=" + claimed_row.claimed_at);

  const receipt = confirmed.ok === true ? confirmed.claim_receipt : "";
  typeof receipt === "string" && receipt.length > 0
    ? ok("CL2 — the confirm binds the claim to that requester, and hands it the only proof of the binding that exists")
    : bad("the confirm returned no binding");

  const stranger = await confirmClaim(db, presented, { binding_ref: "sess_stranger" });
  const after_stranger = await readHoldRow(db, first.hold_id);
  stranger.ok === false && stranger.code === "claim_consumed" && stranger.status === 409
    && after_stranger.claimed_at === claimed_row.claimed_at
    ? ok("CL2 — a second confirm from an unbound requester is 409 claim_consumed, and does not re-date the first claim")
    : bad("a second confirm from an unbound requester returned " + JSON.stringify(stranger).slice(0, 160));

  stranger.ok === false && stranger.subject && stranger.subject.occasion_id === VENUE.occasion_id
    && stranger.subject.book_url === BOOK_URL
    ? ok("CL3 — the consumed outcome names the Occasion and links book_url, rather than leaving somebody on an empty cart with no explanation")
    : bad("the claim_consumed outcome named no Occasion");

  const bound_again = await confirmClaim(db, presented, { binding_ref: "sess_first_touch", claim_receipt: receipt });
  bound_again.ok === true
    ? ok("CL2 — the requester that established the binding may come back: a back button is not a second customer")
    : bad("the bound requester was refused its own claim");

  const claimed_seats = (await seatStates(db, first.hold_id)).filter((r) => r.state === "claimed").length;
  claimed_seats === 2
    ? ok("ADR-005 — the claimed seat rows stay inside hold_seat_occupied, so a sold seat is not immediately re-holdable with a 201")
    : bad("the seats did not become claimed: " + claimed_seats);

  /* ── CL3 — the expired claim ──────────────────────────────────────────── */

  const stale = await mintHold(db, {
    occasion: VENUE, hold_id: holdIdFor("stale-claim"),
    state: HOLD_STATE.handed_off, seats: ["B:1"],
    lifetime_ms: 60000, handoff_floor_ms: 120000, granted_ago_ms: 400000,
  });
  const stale_row = await readHoldRow(db, stale.hold_id);
  const stale_presented = {
    hold_id: stale.hold_id,
    claim_token: claimToken(stale.hold_id, stale_row.handed_off_at, stale_row.claim_expires_at),
  };
  const stale_render = await renderClaim(db, stale_presented);
  stale_render.ok === false && stale_render.status === 410 && stale_render.code === "claim_expired"
    && stale_render.subject && stale_render.subject.occasion_id === VENUE.occasion_id
    && stale_render.subject.book_url === BOOK_URL
    ? ok("CL3 — an expired claim renders a typed 410 claim_expired naming the Occasion and linking book_url")
    : bad("an expired claim rendered " + JSON.stringify(stale_render).slice(0, 220));

  const stale_confirm = await confirmClaim(db, stale_presented, { binding_ref: "sess_late" });
  const stale_after = await readHoldRow(db, stale.hold_id);
  stale_confirm.ok === false && stale_confirm.code === "claim_expired" && stale_after.claimed_at === null
    ? ok("R3 — the confirm re-reads state inside its own transaction, so a claim against a Hold not in handed_off fails and consumes nothing")
    : bad("a confirm on an expired claim did something: " + JSON.stringify(stale_confirm).slice(0, 160));

  /* ── R1 — hand-off is agent-terminal ──────────────────────────────────── */

  const terminal = await ready(db, { hold_id: holdIdFor("r1-terminal"), seats: ["C:1", "C:2"] });
  await handOff(db, { hold_id: terminal.hold_id, read_token: terminal.read_token }, CREDENTIAL);
  let released = null;
  try { await releaseHold(db, terminal.hold_id, CREDENTIAL); }
  catch (err) { released = isRefusal(err) ? err.code : String(err); }
  const still_handed = (await seatStates(db, terminal.hold_id)).filter((r) => r.state === "handed_off").length;
  released === "handoff_consumed" && still_handed === 2
    ? ok("R1 — release_hold after hand-off is refused and the seats are untouched: no agent verb can shorten a customer seats life")
    : bad("release_hold after hand-off gave " + released + " and left " + still_handed + " handed-off seats");

  /* ── CL5 — the log learns the fact and never the token ────────────────── */

  const observed_at = await serverTime(db);
  for (const verb of ["hand_off", "claim_render", "claim_confirm"]) {
    await writeAccessLog(db, {
      verb, outcome: "ok",
      agent_id: CREDENTIAL.agent_id, principal_scope: CREDENTIAL.principal_scope,
      hold_id: first.hold_id, occasion_id: VENUE.occasion_id,
      natural_key: "claim-proof-" + verb,
    }, observed_at, LOG);
  }
  const nonce = presented.claim_token.split(".")[0];
  const log_rows = (await db.query("select row_to_json(t)::text as row from changeover_log.access_log t")).rows;
  const leaked_log = log_rows.filter((r) => r.row.includes(presented.claim_token) || r.row.includes(nonce)).length;
  log_rows.length === 3 && leaked_log === 0
    ? ok("CL5 — three invocations are in the access log, including the hand-off and both claim calls, and the token appears in none of them")
    : bad("the access log has " + log_rows.length + " rows and " + leaked_log + " carrying the token");

  let leaked_store = 0;
  for (const table of ["hold", "hold_seat", "hold_cluster", "hold_slot", "idempotency", "occasion"]) {
    const rows = (await db.query("select row_to_json(t)::text as row from " + table + " t")).rows;
    for (const r of rows) if (r.row.includes(presented.claim_token) || r.row.includes(nonce)) leaked_store++;
  }
  leaked_store === 0
    ? ok("CL5 — the token is in no table either: nothing persists it, so no later read and no I9 replay can re-emit a credential")
    : bad(leaked_store + " store rows carry the claim token");

  /* ── the three binding modes, against the fixture ─────────────────────── */

  await b.reset();
  const session = await ready(db, { seats: ["D:1"] });
  const session_out = await handOff(db, { hold_id: session.hold_id, read_token: session.read_token }, CREDENTIAL, { claim_binding: CLAIM_BINDING.session_resume });
  const session_url = new URL(session_out.hold.handoff.claim_url);
  const session_render = await renderClaim(db, parseClaimUrl(session_url.toString()));
  session_out.claim_binding === "session_resume" && session_url.pathname === "/changeover/claim"
    && session_url.searchParams.get("seat_ids") === null && session_render.ok === true
    ? ok("session_resume — a same-origin URL carrying the token and no seat list, rendering the cart the exhibitor session is to be set to")
    : bad("session_resume minted " + session_url.toString());

  await b.reset();
  const deep = await ready(db, { seats: ["E:1", "E:2"] });
  const deep_out = await handOff(db, { hold_id: deep.hold_id, read_token: deep.read_token }, CREDENTIAL, { claim_binding: CLAIM_BINDING.deep_link });
  const deep_url = new URL(deep_out.hold.handoff.claim_url);
  deep_out.claim_binding === "deep_link" && deep_url.searchParams.get("showtime_id") === VENUE.showtime_id
    && deep_url.searchParams.get("seat_ids") === "E:1,E:2"
    && CLAIM_TOKEN_PATTERN.test(deep_url.searchParams.get("claim") || "")
    ? ok("deep_link — showtime_id, seat_ids[] and a signed claim token landing on the existing seat-select page: a first-class conformance target")
    : bad("deep_link minted " + deep_url.toString());

  await b.reset();
  const manual = await ready(db, { seats: ["F:1"] });
  const manual_out = await handOff(db, { hold_id: manual.hold_id, read_token: manual.read_token }, CREDENTIAL, { claim_binding: CLAIM_BINDING.manual });
  const manual_row = await readHoldRow(db, manual.hold_id);
  manual_out.claim_binding === "manual" && manual_out.hold.handoff.claim_url === BOOK_URL
    && parseClaimUrl(manual_out.hold.handoff.claim_url) === null && manual_row.claim_expires_at !== null
    ? ok("manual — claim_url IS book_url and there is no token: an honest on-ramp that admits the walk is not yet survivable at that site")
    : bad("manual minted " + manual_out.hold.handoff.claim_url);

} catch (err) {
  // An unexpected throw is a failed assertion, not a stack trace: PGlite is
  // bundled minified and its dump is four thousand columns of nothing.
  bad("unexpected — " + (err && err.message ? err.message : String(err)));
} finally {
  await b.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
