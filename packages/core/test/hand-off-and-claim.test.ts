/**
 * `hand_off` and the claim. CORE-004.
 *
 * The two assertions worth naming before the file starts:
 *
 * 1. **A Hold past its floor with its seats still held hands off.** The draft
 *    refused it for up to three and a half minutes with a code meaning *wrong
 *    verb*. Every other assertion here is about seats; this one is about a lie.
 * 2. **Twenty GETs of a claim URL change nothing.** A messaging app's link
 *    scanner fetches that URL before the human clicks it, so a claim endpoint
 *    that consumed on GET would burn a customer's seats at the exact rate at
 *    which agents deliver links through chat — silently, and only in the field.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Db } from "@changeover/store/db.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";
import type { OccasionSeed } from "@changeover/store/fixtures.ts";
import { bench, house, holdIdFor } from "./lib/hold-fixtures.ts";
import { mintHold } from "./lib/hold-fixtures.ts";
import type { Credential } from "../src/hold-seats.ts";
import { getHold } from "../src/get-hold.ts";
import { releaseHold } from "../src/release.ts";
import { HOLD_STATE, deriveState } from "../src/derived.ts";
import { serverTime } from "../src/clock.ts";
import { handOff, readHoldRow, HANDOFF_WRITES } from "../src/hand-off.ts";
import type { ClaimBinding, PresentedClaim } from "../src/claim.ts";
import {
  CLAIM_BINDING,
  CLAIM_BINDINGS,
  CLAIM_RENDER_TX,
  CLAIM_TOKEN_PATTERN,
  claimToken,
  claimTokenIsValid,
  confirmClaim,
  mintClaimToken,
  originOf,
  parseClaimUrl,
  renderClaim,
  sameOrigin,
} from "../src/claim.ts";

const CREDENTIAL: Credential = { agent_id: "agt_reference", principal_scope: "site_wellington" };
const OTHER: Credential = { agent_id: "agt_other", principal_scope: "site_wellington" };
const BOOK_URL = "https://reference.example/book/embassy-sat-1900";

/** The house, with a `book_url` in its published document — CL3 links it. */
function venue(overrides: Partial<OccasionSeed> = {}): OccasionSeed {
  return { ...house(), document: { book_url: BOOK_URL }, ...overrides };
}

/** A live Hold with a fresh `read_token`, ready to hand off. */
async function readyToHandOff(
  db: Db,
  options: Parameters<typeof mintHold>[1] = {},
): Promise<{ hold_id: string; read_token: string }> {
  const minted = await mintHold(db, { state: HOLD_STATE.live, ...options });
  const read = await getHold(db, minted.hold_id, CREDENTIAL);
  assert.equal(read.state, HOLD_STATE.live);
  assert.ok(typeof read.read_token === "string");
  return { hold_id: minted.hold_id, read_token: read.read_token as string };
}

async function refusalFrom(fn: () => Promise<unknown>): Promise<{ code: string; remediation: string; detail?: unknown }> {
  try {
    await fn();
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return { code: err.code, remediation: err.remediation, detail: err.detail };
  }
  throw new Error("expected a refusal and the call returned");
}

/**
 * The hold store back to empty, and the Occasion back to what `venue()` seeds.
 * Two tests move `sales_cutoff_at` to make T5's clamp and G1 step 6 observable,
 * and a fixture left moved is a fixture that fails the NEXT test.
 */
async function restore(db: Db, reset: () => Promise<void>): Promise<void> {
  await reset();
  await db.query("update occasion set sales_cutoff_at = $1::timestamptz", [venue().sales_cutoff_at]);
}

async function seatRows(db: Db, hold_id: string): Promise<Array<{ state: string; held_until: string }>> {
  const r = await db.query<{ state: string; held_until: string }>(
    "select state, to_json(held_until)#>>'{}' as held_until from hold_seat where hold_id = $1 order by seat_id",
    [hold_id],
  );
  return r.rows;
}

/* ── hand_off ──────────────────────────────────────────────────────────────── */

describe("hand_off", () => {
  let db: Db;
  let close: () => Promise<void>;
  let reset: () => Promise<void>;

  before(async () => {
    const b = await bench([venue()]);
    db = b.db;
    close = b.close;
    reset = b.reset;
  });
  after(async () => {
    await close();
  });

  it("HO1 · succeeds on a Hold whose floor has passed but whose seats are still held", async () => {
    await restore(db, reset);
    // floor_deadline = granted + 1s, five seconds ago. expires_at = granted +
    // 60s, fifty-five seconds away. The seats are demonstrably still there.
    const { hold_id, read_token } = await readyToHandOff(db, {
      occasion: venue(),
      floor_ms: 1000,
      lifetime_ms: 60_000,
      granted_ago_ms: 5_000,
    });

    const before_row = await readHoldRow(db, hold_id);
    const now = await serverTime(db);
    assert.ok(Date.parse(before_row!.floor_deadline) < Date.parse(now), "the floor has passed");
    assert.ok(Date.parse(before_row!.expires_at) > Date.parse(now), "the Hold is still live");
    assert.equal(deriveState(before_row!, now), HOLD_STATE.live);

    const result = await handOff(db, { hold_id, read_token }, CREDENTIAL);
    assert.equal(result.hold.state, HOLD_STATE.handed_off);
    assert.ok(result.hold.handoff, "the handoff object is present");
  });

  it("HO1 · refuses hold_expired — never hold_not_live — where the seats have gone", async () => {
    await restore(db, reset);
    const minted = await mintHold(db, { occasion: venue(), state: HOLD_STATE.expired });
    const read = await getHold(db, minted.hold_id, CREDENTIAL);
    const refusal = await refusalFrom(() =>
      handOff(db, { hold_id: minted.hold_id, read_token: read.read_token as string }, CREDENTIAL),
    );
    assert.equal(refusal.code, "hold_expired");
    assert.equal(refusal.remediation, "re_resolve");
    const detail = refusal.detail as { expired_at: string; occasion_id: string };
    assert.equal(typeof detail.expired_at, "string");
    assert.equal(detail.occasion_id, minted.occasion_id);
  });

  it("T5/CL4 · claim_expires_at = handed_off_at + handoff_floor_ms", async () => {
    await restore(db, reset);
    const { hold_id, read_token } = await readyToHandOff(db, { occasion: venue() });
    const result = await handOff(db, { hold_id, read_token }, CREDENTIAL, { handoff_floor_ms: 120_000 });
    const h = result.hold.handoff!;
    assert.equal(h.handoff_floor_ms, 120_000);
    assert.equal(Date.parse(h.claim_expires_at) - Date.parse(h.handed_off_at), 120_000);
  });

  it("T5 · clamps to sales_cutoff_at, and never below expires_at (T6)", async () => {
    await restore(db, reset);
    // A cutoff eight seconds out. T5's min() bites; T6's floor does not.
    const cutoff = new Date(Date.parse(await serverTime(db)) + 8_000).toISOString();
    await db.query("update occasion set sales_cutoff_at = $1::timestamptz", [cutoff]);
    const { hold_id, read_token } = await readyToHandOff(db, {
      occasion: venue(),
      floor_ms: 1000,
      lifetime_ms: 2000,
    });
    const result = await handOff(db, { hold_id, read_token }, CREDENTIAL, { handoff_floor_ms: 120_000 });
    const h = result.hold.handoff!;
    assert.ok(
      Math.abs(Date.parse(h.claim_expires_at) - Date.parse(cutoff)) < 50,
      `claim_expires_at ${h.claim_expires_at} should be the cutoff ${cutoff}`,
    );
    assert.ok(Date.parse(h.claim_expires_at) >= Date.parse(result.hold.expires_at), "T6");
  });

  it("T6 · claim_expires_at is never below expires_at, even for a Hold with more life than the window", async () => {
    await restore(db, reset);
    // A five-minute Hold handed off with a two-minute window: T5's base lands
    // BELOW expires_at, and T6 says the seats' life may only be extended.
    const { hold_id, read_token } = await readyToHandOff(db, {
      occasion: venue(),
      floor_ms: 300_000,
      lifetime_ms: 300_000,
    });
    const result = await handOff(db, { hold_id, read_token }, CREDENTIAL, { handoff_floor_ms: 120_000 });
    const h = result.hold.handoff!;
    assert.equal(h.claim_expires_at, result.hold.expires_at, "clamped up to expires_at, not down past it");
  });

  it("T6 · held_until moves to claim_expires_at in the same transaction as the transition", async () => {
    await restore(db, reset);
    const { hold_id, read_token } = await readyToHandOff(db, { occasion: venue() });
    const before_rows = await seatRows(db, hold_id);
    assert.ok(before_rows.every((r) => r.state === "live"));

    const result = await handOff(db, { hold_id, read_token }, CREDENTIAL);
    const rows = await seatRows(db, hold_id);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.state, "handed_off");
      assert.equal(row.held_until, result.hold.handoff!.claim_expires_at);
    }
  });

  it("T4 · refuses stale_read without a fresh read_token, and does not write", async () => {
    await restore(db, reset);
    const minted = await mintHold(db, { occasion: venue(), state: HOLD_STATE.live });
    const refusal = await refusalFrom(() =>
      handOff(db, { hold_id: minted.hold_id, read_token: "a".repeat(43) }, CREDENTIAL),
    );
    assert.equal(refusal.code, "stale_read");
    assert.equal(refusal.remediation, "re_read");
    const row = await readHoldRow(db, minted.hold_id);
    assert.equal(row!.handed_off_at, null, "a refused hand-off wrote nothing");
  });

  it("Z1 · another credential gets 404 hold_not_found, never 403", async () => {
    await restore(db, reset);
    const { hold_id, read_token } = await readyToHandOff(db, { occasion: venue() });
    const refusal = await refusalFrom(() => handOff(db, { hold_id, read_token }, OTHER));
    assert.equal(refusal.code, "hold_not_found");
  });

  it("T5 · at most once per Hold — a second hand_off is handoff_consumed", async () => {
    await restore(db, reset);
    const { hold_id, read_token } = await readyToHandOff(db, { occasion: venue() });
    const first = await handOff(db, { hold_id, read_token }, CREDENTIAL);
    const re_read = await getHold(db, hold_id, CREDENTIAL);
    const refusal = await refusalFrom(() =>
      handOff(db, { hold_id, read_token: re_read.read_token as string }, CREDENTIAL),
    );
    assert.equal(refusal.code, "handoff_consumed");
    const row = await readHoldRow(db, hold_id);
    assert.equal(row!.claim_expires_at, first.hold.handoff!.claim_expires_at, "unchanged");
  });

  it("R1 · release_hold after hand-off is refused and the seat stays occupied", async () => {
    await restore(db, reset);
    const { hold_id, read_token } = await readyToHandOff(db, { occasion: venue() });
    await handOff(db, { hold_id, read_token }, CREDENTIAL);
    const refusal = await refusalFrom(() => releaseHold(db, hold_id, CREDENTIAL));
    assert.equal(refusal.code, "handoff_consumed");
    const rows = await seatRows(db, hold_id);
    assert.ok(rows.every((r) => r.state === "handed_off"), "the seats are still the customer's");
  });

  it("§4.9 · past_sales_cutoff once the screening has stopped selling", async () => {
    await restore(db, reset);
    const { hold_id, read_token } = await readyToHandOff(db, { occasion: venue() });
    await db.query("update occasion set sales_cutoff_at = clock_timestamp() - interval '1 minute'");
    const refusal = await refusalFrom(() => handOff(db, { hold_id, read_token }, CREDENTIAL));
    assert.equal(refusal.code, "past_sales_cutoff");
  });

  it("T1a · a revoked Hold refuses hold_revoked, carrying the reason and book_url", async () => {
    await restore(db, reset);
    const minted = await mintHold(db, { occasion: venue(), state: HOLD_STATE.revoked });
    const read = await getHold(db, minted.hold_id, CREDENTIAL);
    const refusal = await refusalFrom(() =>
      handOff(db, { hold_id: minted.hold_id, read_token: read.read_token as string }, CREDENTIAL),
    );
    assert.equal(refusal.code, "hold_revoked");
    const detail = refusal.detail as { revocation_reason: string; book_url?: string };
    assert.equal(detail.revocation_reason, "venue_operations");
    assert.equal(detail.book_url, BOOK_URL);
  });

  it("writes exactly seven columns, and none of the immovable ones", () => {
    // T3 and T7, and 0003's column-level UPDATE grant, which omits all five.
    // `hold.handoff_floor_ms` is deliberately not on this list: it is written
    // ONCE, at the hand-off, and `hold_handoff_complete` ties it to the other two.
    const immovable = [
      "hold.granted_at",
      "hold.floor_ms",
      "hold.floor_deadline",
      "hold.expires_at",
      "hold.seats",
    ];
    for (const column of immovable) assert.ok(!HANDOFF_WRITES.includes(column), column);
    assert.equal(HANDOFF_WRITES.length, 7);
  });
});

/* ── the claim ─────────────────────────────────────────────────────────────── */

describe("the claim", () => {
  let db: Db;
  let close: () => Promise<void>;
  let reset: () => Promise<void>;

  before(async () => {
    const b = await bench([venue()]);
    db = b.db;
    close = b.close;
    reset = b.reset;
  });
  after(async () => {
    await close();
  });

  async function handedOff(
    binding: ClaimBinding = CLAIM_BINDING.deep_link,
  ): Promise<{ hold_id: string; claim_url: string; presented: PresentedClaim | null }> {
    const { hold_id, read_token } = await readyToHandOff(db, { occasion: venue() });
    const result = await handOff(db, { hold_id, read_token }, CREDENTIAL, { claim_binding: binding });
    const claim_url = result.hold.handoff!.claim_url;
    return { hold_id, claim_url, presented: parseClaimUrl(claim_url) };
  }

  it("CL1 · the token carries CSPRNG entropy, is not sequential and is not timestamp-ordered", () => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (let i = 0; i < 500; i++) {
      const nonce = mintClaimToken();
      assert.equal(nonce.length, 43, "32 bytes base64url — 256 bits, twice CL1's floor");
      seen.add(nonce);
      order.push(nonce);
    }
    assert.equal(seen.size, 500, "500 mints, 500 distinct values");
    const sorted = [...order].sort();
    assert.notDeepEqual(sorted, order, "mint order is not lexical order — not sequential, not time-ordered");
    // Not derived from anything: consecutive mints share no leading run.
    for (let i = 1; i < order.length; i++) {
      assert.notEqual(order[i]!.slice(0, 8), order[i - 1]!.slice(0, 8));
    }
  });

  it("CL1 · a token is worthless against another Hold, and against a re-dated hand-off", () => {
    const a = holdIdFor("claim-a");
    const b = holdIdFor("claim-b");
    const handed = "2026-08-29T19:00:00+12:00";
    const expires = "2026-08-29T19:02:00+12:00";
    const token = claimToken(a, handed, expires);
    assert.ok(CLAIM_TOKEN_PATTERN.test(token));
    assert.ok(claimTokenIsValid(a, handed, expires, token));
    assert.ok(!claimTokenIsValid(b, handed, expires, token), "another Hold");
    assert.ok(!claimTokenIsValid(a, "2026-08-29T19:00:01+12:00", expires, token), "a re-dated hand-off");
    assert.ok(!claimTokenIsValid(a, handed, "2026-08-29T19:05:00+12:00", token), "a moved claim window");
    // Genuinely flipped: `replace(/.$/, "A")` is a no-op once in sixty-four,
    // and a test that passes sixty-three times in sixty-four is a test that
    // reports green for a reason nobody will find.
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    assert.notEqual(flipped, token);
    assert.ok(!claimTokenIsValid(a, handed, expires, flipped), "a flipped byte");
    assert.ok(!token.includes(a), "the token does not carry the hold_id");
  });

  it("O1 · the claim URL is same-origin with the venue", async () => {
    await restore(db, reset);
    const { claim_url } = await handedOff();
    assert.equal(originOf(claim_url), "https://reference.example");
    assert.ok(sameOrigin(claim_url, "https://reference.example"));
    // O2: parsed, never a string prefix.
    assert.ok(!sameOrigin("https://reference.example.attacker.test/x", "https://reference.example"));
    assert.equal(originOf("https://reference.example@attacker.test/x"), null, "userinfo is invalid");
  });

  it("CL2 · twenty GETs leave the Hold handed_off with the token unconsumed", async () => {
    await restore(db, reset);
    const { hold_id, presented } = await handedOff();
    assert.ok(presented);
    for (let i = 0; i < 20; i++) {
      const outcome = await renderClaim(db, presented!);
      assert.equal(outcome.ok, true, `GET ${i + 1}`);
      assert.equal(outcome.status, 200);
      if (outcome.ok) {
        assert.equal(outcome.state, HOLD_STATE.handed_off);
        assert.equal(outcome.consumed, false);
        assert.equal(outcome.subject.book_url, BOOK_URL);
      }
      const row = await readHoldRow(db, hold_id);
      assert.equal(row!.claimed_at, null, `claimed_at is still null after GET ${i + 1}`);
    }
    const rows = await seatRows(db, hold_id);
    assert.ok(rows.every((r) => r.state === "handed_off"));
    // The confirm still works afterwards: the token was not consumed.
    const confirmed = await confirmClaim(db, presented!, { binding_ref: "sess_first" });
    assert.equal(confirmed.ok, true);
  });

  it("CL2 · the GET path is read-only by construction, not by discipline", async () => {
    assert.deepEqual(CLAIM_RENDER_TX, { readOnly: true });
    // And the store means it.
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query("update hold set claimed_at = clock_timestamp()");
      }, CLAIM_RENDER_TX),
      (err: unknown) => (err as { code?: string }).code === "25006",
    );
  });

  it("CL2 · the first confirm binds; a later one from an unbound requester is claim_consumed", async () => {
    await restore(db, reset);
    const { hold_id, presented } = await handedOff();
    const first = await confirmClaim(db, presented!, { binding_ref: "sess_first" });
    assert.equal(first.ok, true);
    assert.equal(first.status, 200);
    let receipt = "";
    if (first.ok) {
      assert.equal(first.state, HOLD_STATE.claimed);
      assert.equal(first.consumed, true);
      assert.ok(typeof first.claim_receipt === "string" && first.claim_receipt.length > 0);
      receipt = first.claim_receipt!;
    }
    const row = await readHoldRow(db, hold_id);
    assert.notEqual(row!.claimed_at, null);
    assert.equal(deriveState(row!, await serverTime(db)), HOLD_STATE.claimed);

    // An unbound requester — a second browser, a forwarded link, a scanner.
    const second = await confirmClaim(db, presented!, { binding_ref: "sess_stranger" });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.code, "claim_consumed");
      assert.equal(second.status, 409);
      assert.equal(second.subject!.occasion_id, "occ_derived_state");
      assert.equal(second.subject!.book_url, BOOK_URL);
    }

    // A stranger holding the right session id but no receipt is still unbound.
    const forged = await confirmClaim(db, presented!, { binding_ref: "sess_first" });
    assert.equal(forged.ok, false);

    // The requester that established the binding may come back — a back button
    // is not a second customer.
    const again = await confirmClaim(db, presented!, { binding_ref: "sess_first", claim_receipt: receipt });
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.state, HOLD_STATE.claimed);
  });

  it("CL2 · a receipt is worthless with the wrong binding_ref", async () => {
    await restore(db, reset);
    const { presented } = await handedOff();
    const first = await confirmClaim(db, presented!, { binding_ref: "sess_first" });
    assert.ok(first.ok);
    const receipt = first.ok ? first.claim_receipt! : "";
    const wrong = await confirmClaim(db, presented!, { binding_ref: "sess_other", claim_receipt: receipt });
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.code, "claim_consumed");
  });

  it("a claim marks the seats claimed, frees the cluster and returns the budget slot", async () => {
    await restore(db, reset);
    const { hold_id, presented } = await handedOff();
    await db.query(
      "insert into hold_slot (agent_id, principal_scope, showtime_id, slot, hold_id)" +
        " values ($1, $2, (select showtime_id from hold where hold_id = $3), 0, $3)",
      [CREDENTIAL.agent_id, CREDENTIAL.principal_scope, hold_id],
    );
    await confirmClaim(db, presented!, { binding_ref: "sess_first" });
    const rows = await seatRows(db, hold_id);
    assert.ok(rows.every((r) => r.state === "claimed"), "terminal, and still occupying the seat");
    const slots = await db.query("select 1 from hold_slot where hold_id = $1", [hold_id]);
    assert.equal(slots.rowCount, 0, "X1's slot returns with the Hold that stopped being live");
  });

  it("CL3 · an expired claim renders 410, names the Occasion and links book_url", async () => {
    await restore(db, reset);
    const minted = await mintHold(db, {
      occasion: venue(),
      state: HOLD_STATE.handed_off,
      lifetime_ms: 60_000,
      handoff_floor_ms: 120_000,
      granted_ago_ms: 400_000,
    });
    const row = await readHoldRow(db, minted.hold_id);
    assert.ok(row!.handed_off_at !== null && row!.claim_expires_at !== null);
    assert.equal(deriveState(row!, await serverTime(db)), HOLD_STATE.expired);
    const token = claimToken(row!.hold_id, row!.handed_off_at!, row!.claim_expires_at!);
    const presented: PresentedClaim = { hold_id: row!.hold_id, claim_token: token };

    for (const outcome of [await renderClaim(db, presented), await confirmClaim(db, presented, { binding_ref: "s" })]) {
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.code, "claim_expired");
        assert.equal(outcome.status, 410);
        assert.equal(outcome.remediation, "use_book_url");
        assert.equal(outcome.subject!.occasion_id, minted.occasion_id);
        assert.deepEqual([...outcome.subject!.seats], [...minted.seats]);
        assert.equal(outcome.subject!.book_url, BOOK_URL);
      }
    }
    const after_row = await readHoldRow(db, minted.hold_id);
    assert.equal(after_row!.claimed_at, null, "an expired claim consumed nothing");
  });

  it("CL3 · accepts no parameter that alters the Hold", async () => {
    await restore(db, reset);
    const { hold_id, claim_url } = await handedOff(CLAIM_BINDING.deep_link);
    const tampered = new URL(claim_url);
    tampered.searchParams.set("seat_ids", "Z:99");
    tampered.searchParams.set("showtime_id", "somewhere_else");
    tampered.searchParams.set("claim_expires_at", "2099-01-01T00:00:00+00:00");
    const presented = parseClaimUrl(tampered.toString());
    assert.deepEqual(Object.keys(presented!).sort(), ["claim_token", "hold_id"]);
    const outcome = await renderClaim(db, presented!);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.subject.showtime_id, "occ_derived_state", "read from the store, not the URL");
      assert.ok(!outcome.subject.seats.includes("Z:99"));
    }
    const row = await readHoldRow(db, hold_id);
    assert.equal(row!.claimed_at, null);
  });

  it("an unrecognised presentation is hold_not_found, and says nothing else", async () => {
    await restore(db, reset);
    const { presented } = await handedOff();
    const other = await mintHold(db, {
      occasion: venue(),
      hold_id: holdIdFor("second-hold"),
      state: HOLD_STATE.live,
      seats: ["A:9", "A:10"],
    });
    for (const bad of [
      { hold_id: presented!.hold_id, claim_token: claimToken(presented!.hold_id, "x", "y") },
      { hold_id: other.hold_id, claim_token: presented!.claim_token },
      { hold_id: holdIdFor("nobody"), claim_token: presented!.claim_token },
      { hold_id: presented!.hold_id, claim_token: "not-a-token" },
    ]) {
      const outcome = await renderClaim(db, bad);
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.code, "hold_not_found");
        assert.equal(outcome.subject, null, "no Occasion is named to someone who guessed");
      }
    }
  });

  it("three binding modes, each exercised against the fixture", async () => {
    assert.deepEqual([...CLAIM_BINDINGS].sort(), ["deep_link", "manual", "session_resume"]);

    await restore(db, reset);
    const session = await handedOff(CLAIM_BINDING.session_resume);
    const session_url = new URL(session.claim_url);
    assert.equal(session_url.pathname, "/changeover/claim");
    assert.equal(session_url.searchParams.get("seat_ids"), null, "session_resume carries no seat list");
    assert.ok(session.presented);
    assert.equal((await renderClaim(db, session.presented!)).ok, true);

    await restore(db, reset);
    const deep = await handedOff(CLAIM_BINDING.deep_link);
    const deep_url = new URL(deep.claim_url);
    assert.equal(deep_url.pathname, "/tickets/select");
    assert.equal(deep_url.searchParams.get("showtime_id"), "occ_derived_state");
    assert.ok((deep_url.searchParams.get("seat_ids") ?? "").includes(","), "seat_ids[] rides along");
    assert.ok(CLAIM_TOKEN_PATTERN.test(deep_url.searchParams.get("claim") ?? ""));
    assert.equal((await renderClaim(db, deep.presented!)).ok, true);

    await restore(db, reset);
    const manual = await handedOff(CLAIM_BINDING.manual);
    assert.equal(manual.claim_url, BOOK_URL, "claim_url IS book_url");
    assert.equal(manual.presented, null, "no token: the Hold expires unclaimed");
    const row = await readHoldRow(db, manual.hold_id);
    assert.notEqual(row!.claim_expires_at, null, "and it is still a hand-off, with a window");
  });

  it("manual · a site with no book_url on its own origin cannot pretend", async () => {
    const b = await bench([house()]); // no `document`, so no book_url
    try {
      const { hold_id, read_token } = await readyToHandOff(b.db, { occasion: house() });
      const refusal = await refusalFrom(() =>
        handOff(b.db, { hold_id, read_token }, CREDENTIAL, { claim_binding: CLAIM_BINDING.manual }),
      );
      assert.equal(refusal.code, "upstream_unavailable");
      const row = await readHoldRow(b.db, hold_id);
      assert.equal(row!.handed_off_at, null, "the transaction rolled back with the mint");
    } finally {
      await b.close();
    }
  });
});
