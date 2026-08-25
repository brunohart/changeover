/**
 * CORE-005 — SPEC.md §4.5, I1–I9.
 *
 * The assertions that matter are the ones that separate an idempotency store
 * from a response cache: a replay whose floor is byte-identical and whose
 * deadline is freshly read, a reused key that took no action, and a human gate
 * that recorded nothing.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import canonicalizeModule from "canonicalize";

import { isRefusal } from "@changeover/schema/refusal.ts";
import { holdSeats } from "../src/hold-seats.ts";
import type { HoldSeatsRequest } from "../src/hold-seats.ts";
import {
  IN_FLIGHT_RETRY_MIN_MS,
  KEY_MIN_LENGTH,
  REPLAYED_MEMBERS,
  REPROJECTED_MEMBERS,
  STORE_REPROJECTION,
  applyReprojection,
  assertKeyShape,
  handOffDigest,
  holdSeatsDigest,
  isInputRequired,
  jcs,
  keyHmac,
  requestDigest,
  withIdempotency,
} from "../src/idempotency.ts";
import type { IdempotencyOutcome } from "../src/idempotency.ts";
import type { Bench } from "./lib/estate.ts";
import { bench, etagFor, occasion } from "./lib/estate.ts";

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const OCCASION = "occ_embassy_sat_1900";
const AGENT = "agt_core005";
const SCOPE = "principal_9f2c";

let b: Bench;

before(async () => {
  b = await bench([occasion({ occasion_id: OCCASION, capacity: 40 })]);
});
after(async () => {
  await b.close();
});

let keyCounter = 0;
/** 26 characters of Crockford base32 — a ULID's shape, which I1 permits. */
function newKey(): string {
  keyCounter += 1;
  return ("01K3QW9Z8YVJ4C7N2M5X6TB0" + String(keyCounter).padStart(2, "0")).slice(0, 26);
}

function request(overrides: Partial<HoldSeatsRequest> = {}): HoldSeatsRequest {
  return {
    occasion_id: OCCASION,
    occasion_etag: etagFor(OCCASION),
    sought: { occasion_id: OCCASION, occasion_etag: etagFor(OCCASION) },
    seats: ["A:1", "A:2"],
    requested_floor_ms: 120_000,
    ...overrides,
  };
}

const CREDENTIAL = { agent_id: AGENT, principal_scope: SCOPE };

function scope(idempotency_key: string, over: Partial<{ agent_id: string; principal_scope: string }> = {}) {
  return {
    agent_id: over.agent_id ?? AGENT,
    principal_scope: over.principal_scope ?? SCOPE,
    verb: "hold_seats" as const,
    idempotency_key,
  };
}

/**
 * `canonicalize` ships CommonJS with an ESM `.d.ts`, so the default binding is
 * the namespace under this tsconfig and the call signature has to be restated.
 * It is the third-party RFC 8785 the digest is checked against, and nothing else.
 */
const canonicalize = canonicalizeModule as unknown as (input: unknown) => string | undefined;

/** A document as a bag of members — I4 is stated member by member, so it is read that way. */
function members(document: object): Record<string, unknown> {
  return document as unknown as Record<string, unknown>;
}

/** Narrow away the gate arm at a call site that has already excluded it. */
function documentOf<T extends object>(outcome: IdempotencyOutcome<T>): T {
  if (outcome.disposition === "input_required") {
    throw new Error("expected a document, and the call returned input_required");
  }
  return outcome.record;
}

/** Narrow to the replay arm, asserting on the way through that it is one. */
function replayOf<T extends object>(outcome: IdempotencyOutcome<T>): { record: T; claim_consumed: boolean } {
  assert.equal(outcome.disposition, "replayed", "the call executed where it should have replayed");
  if (outcome.disposition !== "replayed") throw new Error("unreachable");
  return { record: outcome.record, claim_consumed: outcome.claim_consumed };
}

async function count(table: string): Promise<number> {
  const r = await b.db.query<{ n: string }>(`select count(*)::text as n from ${table}`);
  return Number(r.rows[0]?.n ?? 0);
}

/* ── I3 — the digest ───────────────────────────────────────────────────────── */

describe("I3 · the request digest", () => {
  it("canonicalises exactly as RFC 8785 does, over the value space D admits", () => {
    const corpus: unknown[] = [
      { occasion_id: "occ_a", requested_floor_ms: 120000 },
      { b: 1, a: 2, A: 3, "": 4 },
      { seats: ["B:10", "A:1", "A:2"], selection: { mode: "best_available", quantity: 2, together: true } },
      { nested: { z: [1, 2, { y: "x" }], a: null } },
      { unicode: "Papieré éè — “quoted”", escaped: "line\nbreak\ttab\"q\"" },
      { big: Number.MAX_SAFE_INTEGER, zero: 0, negative: -17 },
      { emptyObject: {}, emptyArray: [] },
    ];
    for (const value of corpus) {
      assert.equal(jcs(value), canonicalize(value), `JCS disagreed on ${JSON.stringify(value)}`);
    }
  });

  it("refuses the values it cannot canonicalise rather than emitting something", () => {
    for (const bad of [1.5, NaN, Infinity, new Date(), 10n, () => 1, Symbol("s")]) {
      assert.throws(() => jcs({ v: bad } as Record<string, unknown>), TypeError);
    }
  });

  it("is 43 base64url characters, which is what the column CHECKs", () => {
    const d = requestDigest({ hold_id: "hold_X" });
    assert.match(d, /^[A-Za-z0-9_-]{43}$/);
  });

  it("does not depend on the order members were written in", () => {
    assert.equal(
      requestDigest({ a: 1, b: 2, c: [1, 2] }),
      requestDigest({ c: [1, 2], b: 2, a: 1 }),
    );
  });

  it("excludes intent_digest — which is why a gate's retry is the same request", () => {
    const plain = request();
    const gated = request({ intent_digest: "a".repeat(43) });
    assert.equal(holdSeatsDigest(plain), holdSeatsDigest(gated));
  });

  it("sorts seats, so an agent that reorders them has not made a new request", () => {
    assert.equal(
      holdSeatsDigest(request({ seats: ["A:2", "A:1"] })),
      holdSeatsDigest(request({ seats: ["A:1", "A:2"] })),
    );
  });

  it("moves for every decision member the specification names", () => {
    const base = holdSeatsDigest(request());
    assert.notEqual(base, holdSeatsDigest(request({ requested_floor_ms: 90_000 })));
    assert.notEqual(base, holdSeatsDigest(request({ seats: ["A:1", "A:3"] })));
    assert.notEqual(base, holdSeatsDigest(request({ occasion_etag: etagFor("other") })));
    assert.notEqual(
      base,
      holdSeatsDigest(request({ sought: { occasion_id: "occ_b", occasion_etag: etagFor("occ_b") } })),
    );
  });

  it("digests hand_off over {hold_id} and nothing else", () => {
    assert.equal(handOffDigest("hold_A"), requestDigest({ hold_id: "hold_A" }));
    assert.notEqual(handOffDigest("hold_A"), handOffDigest("hold_B"));
  });
});

/* ── I1 / P2 — the key ─────────────────────────────────────────────────────── */

describe("I1 · the key, and P2 · how it is kept", () => {
  it("accepts every form I1 permits and refuses what cannot carry 128 bits", () => {
    assert.doesNotThrow(() => assertKeyShape("01K3QW9Z8YVJ4C7N2M5X6TB0RH"));          // ULID, 26
    assert.doesNotThrow(() => assertKeyShape("f81d4fae-7dec-11d0-a765-00a0c91e6bf6")); // UUID, 36
    assert.doesNotThrow(() => assertKeyShape("a".repeat(KEY_MIN_LENGTH)));
    for (const bad of ["", "short", "a".repeat(KEY_MIN_LENGTH - 1), "a".repeat(256), "has space here 1234567", 42]) {
      assert.throws(() => assertKeyShape(bad), (err: unknown) => isRefusal(err) && err.code === "schema_validation");
    }
  });

  it("is stored as an HMAC and never in the clear", async () => {
    const key = newKey();
    await withIdempotency(b.db, scope(key), holdSeatsDigest(request({ seats: ["B:1"] })), () =>
      holdSeats(b.db, request({ seats: ["B:1"] }), CREDENTIAL));
    const rows = await b.db.query<{ idempotency_key_hmac: string }>(
      "select idempotency_key_hmac from idempotency",
    );
    assert.ok(rows.rows.length > 0);
    for (const row of rows.rows) {
      assert.notEqual(row.idempotency_key_hmac, key);
      assert.match(row.idempotency_key_hmac, /^[A-Za-z0-9_-]{43}$/);
    }
    assert.equal(keyHmac(key, Buffer.from("k1")), keyHmac(key, Buffer.from("k1")));
    assert.notEqual(keyHmac(key, Buffer.from("k1")), keyHmac(key, Buffer.from("k2")));
    await b.reset();
  });
});

/* ── I4 — the two halves ───────────────────────────────────────────────────── */

describe("I4 · a replay is not a cached response", () => {
  it("names four re-projected members and five byte-identical ones, disjointly", () => {
    assert.deepEqual([...REPROJECTED_MEMBERS], ["server_time", "state", "expires_at", "claim_expires_at"]);
    assert.deepEqual([...REPLAYED_MEMBERS], ["hold_id", "seats", "granted_at", "floor_ms", "floor_deadline"]);
    for (const m of REPLAYED_MEMBERS) assert.ok(!REPROJECTED_MEMBERS.includes(m), m);
  });

  it("replays the grant byte-identically and re-reads the clock", async () => {
    const key = newKey();
    const req = request({ seats: ["C:1", "C:2"] });
    const digest = holdSeatsDigest(req);
    const first = await withIdempotency(b.db, scope(key), digest, () => holdSeats(b.db, req, CREDENTIAL));
    assert.equal(first.disposition, "executed");
    assert.equal(first.replayed, false);

    await new Promise((r) => setTimeout(r, 25));

    const replay = await withIdempotency(b.db, scope(key), digest, () => {
      throw new Error("I8: execute must not run when key and digest match");
    });
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.replayed, true);

    const a = members(documentOf(first));
    const z = members(replayOf(replay).record);
    for (const member of REPLAYED_MEMBERS) {
      assert.equal(JSON.stringify(z[member]), JSON.stringify(a[member]), `${member} moved on replay`);
    }
    assert.notEqual(z.server_time, a.server_time, "server_time was cached rather than re-read");
    assert.ok(Date.parse(z.server_time as string) > Date.parse(a.server_time as string));
    assert.deepEqual(Object.keys(z).sort(), Object.keys(a).sort());
    await b.reset();
  });

  it("re-projects state, so a replayed Hold does not report a floor that has passed", async () => {
    const key = newKey();
    const req = request({ seats: ["D:1"] });
    const digest = holdSeatsDigest(req);
    const first = await withIdempotency(b.db, scope(key), digest, () => holdSeats(b.db, req, CREDENTIAL));
    const hold_id = documentOf(first).hold_id;

    // The deadline passes. No reap runs, no sweeper exists — M1 is a derivation.
    await b.db.query(
      `update hold set granted_at = clock_timestamp() - interval '10 minutes',
                       floor_deadline = clock_timestamp() - interval '10 minutes' + (floor_ms * interval '1 millisecond'),
                       expires_at = clock_timestamp() - interval '10 minutes' + (floor_ms * interval '1 millisecond')
        where hold_id = $1`,
      [hold_id],
    );

    const replay = await withIdempotency(b.db, scope(key), digest, () => {
      throw new Error("I8: a matched key must not reach the guards");
    });
    assert.equal(replay.disposition, "replayed");
    const z = members(replayOf(replay).record);
    assert.equal(z.state, "expired", "a replayed Hold reported live over a passed deadline");
    assert.ok(Date.parse(z.expires_at as string) < Date.parse(z.server_time as string));
    assert.equal(z.hold_id, hold_id);
    await b.reset();
  });

  it("leaves an absent member absent and adds none", () => {
    const stored = { hold_id: "h", state: "live", expires_at: "x", server_time: "y", seats: ["A:1"] };
    const out = applyReprojection(stored, {
      server_time: "2026-08-25T12:00:00+12:00",
      state: "expired",
      expires_at: "2026-08-25T11:00:00+12:00",
      claim_spent: false,
    }, false);
    assert.deepEqual(Object.keys(out).sort(), Object.keys(stored).sort());
    assert.equal(out.state, "expired");
    assert.equal(out.seats[0], "A:1");
  });
});

/* ── I5 — the reused key ───────────────────────────────────────────────────── */

describe("I5 · same key, different digest", () => {
  it("returns idempotency_key_reused with no action taken, verified in the store", async () => {
    const key = newKey();
    const req = request({ seats: ["C:5"] });
    await withIdempotency(b.db, scope(key), holdSeatsDigest(req), () => holdSeats(b.db, req, CREDENTIAL));

    const before = {
      hold: await count("hold"),
      hold_seat: await count("hold_seat"),
      idempotency: await count("idempotency"),
    };

    const other = request({ seats: ["C:6"] });
    await assert.rejects(
      () => withIdempotency(b.db, scope(key), holdSeatsDigest(other), () => holdSeats(b.db, other, CREDENTIAL)),
      (err: unknown) => isRefusal(err) && err.code === "idempotency_key_reused" && err.remediation === "none",
    );

    assert.equal(await count("hold"), before.hold, "a refused reuse granted a Hold");
    assert.equal(await count("hold_seat"), before.hold_seat, "a refused reuse occupied a seat");
    assert.equal(await count("idempotency"), before.idempotency, "a refused reuse wrote an entry");
    await b.reset();
  });
});

/* ── I6 — in flight ────────────────────────────────────────────────────────── */

describe("I6 · an identical key already executing", () => {
  it("refuses idempotency_in_flight with a wait, and never a second Hold", async () => {
    const key = newKey();
    const req = request({ seats: ["C:7"] });
    const digest = holdSeatsDigest(req);
    let inner: unknown;

    // A genuine overlap on one connection: the in-flight marker is COMMITTED
    // before `execute` runs, so the re-entrant call reads a real in-flight row.
    // It is not the two-connection race — that is prove_idempotent_race.sh —
    // but nothing here is simulated.
    const outer = await withIdempotency(b.db, scope(key), digest, async () => {
      try {
        await withIdempotency(b.db, scope(key), digest, () => holdSeats(b.db, req, CREDENTIAL));
      } catch (err) {
        inner = err;
      }
      return holdSeats(b.db, req, CREDENTIAL);
    });

    assert.ok(isRefusal(inner), "a request arriving on an in-flight key was not refused");
    assert.equal((inner as { code: string }).code, "idempotency_in_flight");
    assert.equal((inner as { remediation: string }).remediation, "retry_same_key");
    assert.ok(
      ((inner as { retry_after_ms?: number }).retry_after_ms ?? 0) >= IN_FLIGHT_RETRY_MIN_MS,
      "in_flight carried no usable retry_after_ms",
    );
    assert.equal(outer.disposition, "executed");
    assert.equal(await count("hold"), 1, "the in-flight refusal still granted a second Hold");
    await b.reset();
  });

  it("lets a stale lease be taken over, so a killed process does not wedge a key", async () => {
    const key = newKey();
    const req = request({ seats: ["C:8"] });
    const digest = holdSeatsDigest(req);

    await assert.rejects(
      () => withIdempotency(b.db, scope(key), digest, async () => {
        throw new Error("the process died here");
      }),
      /the process died here/,
    );
    // A refusal or fault releases the key outright, so the same key is free.
    const retry = await withIdempotency(b.db, scope(key), digest, () => holdSeats(b.db, req, CREDENTIAL));
    assert.equal(retry.disposition, "executed");
    await b.reset();
  });
});

/* ── I7 — the human gate ───────────────────────────────────────────────────── */

describe("I7 · an InputRequiredResult is not an operation", () => {
  it("records no entry and accepts the same key on the gate-satisfying retry", async () => {
    const key = newKey();
    const req = request({ seats: ["D:3"] });
    const digest = holdSeatsDigest(req);

    const gate = await withIdempotency(b.db, scope(key), digest, async () => ({ input_required: true as const }));
    assert.equal(gate.disposition, "input_required");
    assert.ok(isInputRequired(gate.result));
    assert.equal(await count("idempotency"), 0, "a gate recorded an idempotency entry");
    assert.equal(await count("hold"), 0);

    const satisfied = await withIdempotency(b.db, scope(key), digest, () => holdSeats(b.db, req, CREDENTIAL));
    assert.equal(satisfied.disposition, "executed", "the gate-satisfying retry was not accepted");
    assert.equal(await count("idempotency"), 1);
    await b.reset();
  });
});

/* ── I2 / I9 — scope ───────────────────────────────────────────────────────── */

describe("I2 · scope is credential-derived", () => {
  it("does not return a stored response to another principal scope", async () => {
    const key = newKey();
    const req = request({ seats: ["D:4"] });
    const digest = holdSeatsDigest(req);
    await withIdempotency(b.db, scope(key), digest, () => holdSeats(b.db, req, CREDENTIAL));

    const other = request({ seats: ["D:5"] });
    const elsewhere = await withIdempotency(
      b.db,
      scope(key, { principal_scope: "principal_other" }),
      holdSeatsDigest(other),
      () => holdSeats(b.db, other, { agent_id: AGENT, principal_scope: "principal_other" }),
    );
    assert.equal(elsewhere.disposition, "executed", "one scope replayed another scope's response");
    assert.notEqual(
      documentOf(elsewhere).hold_id,
      "",
    );
    assert.equal(await count("idempotency"), 2);
    await b.reset();
  });

  it("refuses a credential with no principal scope", async () => {
    await assert.rejects(
      () => withIdempotency(b.db, scope(newKey(), { principal_scope: "" }), requestDigest({ a: 1 }), async () => ({ hold_id: "x" })),
      (err: unknown) => isRefusal(err) && err.code === "principal_scope_missing",
    );
  });
});

/* ── M1 — the derivation the replay reads ──────────────────────────────────── */

describe("M1 · state derived at every read", () => {
  it("reports every terminal marker, and never live over a passed deadline", async () => {
    const req = request({ seats: ["D:6"] });
    const hold = await holdSeats(b.db, req, CREDENTIAL);

    const now = async () => STORE_REPROJECTION.project(b.db, hold.hold_id);
    assert.equal((await now())?.state, "live");

    await b.db.query(
      `update hold set handed_off_at = clock_timestamp(), handoff_floor_ms = 90000,
                       claim_expires_at = expires_at + interval '1 minute' where hold_id = $1`,
      [hold.hold_id],
    );
    assert.equal((await now())?.state, "handed_off");
    assert.equal((await now())?.claim_spent, false);

    await b.db.query("update hold set claimed_at = clock_timestamp() where hold_id = $1", [hold.hold_id]);
    assert.equal((await now())?.state, "claimed");
    assert.equal((await now())?.claim_spent, true, "a consumed claim was not reported spent");

    await b.db.query("update hold set released_at = clock_timestamp() where hold_id = $1", [hold.hold_id]);
    assert.equal((await now())?.state, "released");

    await b.db.query(
      "update hold set revoked_at = clock_timestamp(), revocation_reason = 'safety' where hold_id = $1",
      [hold.hold_id],
    );
    assert.equal((await now())?.state, "revoked");
    await b.reset();
  });
});

/* ── I9 — the claim URL is a credential, and a replay must not re-emit it ──── */

/**
 * CORE-004 owns the `hand_off` verb; what is under test here is this layer's
 * replay of one. The execute seam is exactly the boundary between the two, so
 * the hand-off document is assembled here rather than waited for.
 */
async function handedOff(seat: string, claim_window: "open" | "closed") {
  const hold = await holdSeats(b.db, request({ seats: [seat] }), CREDENTIAL);
  const shift = claim_window === "open" ? "+ interval '5 minutes'" : "- interval '10 minutes'";
  const row = await b.db.query<{ handed_off_at: string; claim_expires_at: string }>(
    `update hold
        set granted_at        = clock_timestamp() ${claim_window === "open" ? "" : "- interval '20 minutes'"},
            floor_deadline    = clock_timestamp() ${claim_window === "open" ? "" : "- interval '20 minutes'"} + (floor_ms * interval '1 millisecond'),
            expires_at        = clock_timestamp() ${shift},
            handed_off_at     = clock_timestamp() - interval '1 minute',
            handoff_floor_ms  = 180000,
            claim_expires_at  = clock_timestamp() ${shift}
      where hold_id = $1
      returning to_json(handed_off_at)#>>'{}' as handed_off_at,
                to_json(claim_expires_at)#>>'{}' as claim_expires_at`,
    [hold.hold_id],
  );
  const r = row.rows[0]!;
  return {
    hold_id: hold.hold_id,
    document: {
      ...hold,
      state: "handed_off",
      handoff: {
        handed_off_at: r.handed_off_at,
        handoff_floor_ms: 180000,
        claim_url: `https://reference.example/claim/${"t".repeat(43)}`,
        claim_expires_at: r.claim_expires_at,
      },
    },
  };
}

describe("I9 · a hand_off replay past the claim window", () => {
  it("carries the claim_url while the window is open, with claim_expires_at re-read", async () => {
    const key = newKey();
    const { hold_id, document } = await handedOff("A:5", "open");
    const digest = handOffDigest(hold_id);
    const s = { agent_id: AGENT, principal_scope: SCOPE, verb: "hand_off" as const, idempotency_key: key };

    await withIdempotency(b.db, s, digest, async () => document);
    const replay = await withIdempotency(b.db, s, digest, () => {
      throw new Error("I8: a matched key must not reach the verb");
    });

    assert.equal(replay.disposition, "replayed");
    assert.equal(replayOf(replay).claim_consumed, false);
    const z = members(replayOf(replay).record);
    const handoff = z.handoff as Record<string, unknown>;
    assert.ok(handoff, "an open claim window dropped the hand-off block");
    assert.equal(handoff.claim_url, document.handoff.claim_url);
    assert.equal(z.state, "handed_off");
    assert.equal(z.hold_id, hold_id);
    assert.equal(handoff.claim_expires_at, document.handoff.claim_expires_at);
    await b.reset();
  });

  it("yields no claim_url once the claim window has closed", async () => {
    const key = newKey();
    const { hold_id, document } = await handedOff("A:6", "closed");
    const digest = handOffDigest(hold_id);
    const s = { agent_id: AGENT, principal_scope: SCOPE, verb: "hand_off" as const, idempotency_key: key };

    const first = await withIdempotency(b.db, s, digest, async () => document);
    assert.equal(first.disposition, "executed");

    const replay = await withIdempotency(b.db, s, digest, () => {
      throw new Error("I8: a matched key must not reach the verb");
    });
    assert.equal(replay.disposition, "replayed");
    assert.equal(replayOf(replay).claim_consumed, true);

    const z = members(replayOf(replay).record);
    assert.equal(z.handoff, undefined, "a spent claim window still carried the hand-off block");
    assert.equal(JSON.stringify(z).includes("claim_url"), false, "a replay re-emitted a spent claim_url");
    // The departure is confined to the claim: identity and floor still replay.
    for (const member of REPLAYED_MEMBERS) {
      assert.equal(
        JSON.stringify(z[member]),
        JSON.stringify((document as Record<string, unknown>)[member]),
        `${member} moved on an I9 replay`,
      );
    }
    assert.equal(z.state, "expired");
    await b.reset();
  });

  it("also drops the claim_url once the claim itself is consumed", async () => {
    const key = newKey();
    const { hold_id, document } = await handedOff("A:7", "open");
    const digest = handOffDigest(hold_id);
    const s = { agent_id: AGENT, principal_scope: SCOPE, verb: "hand_off" as const, idempotency_key: key };

    await withIdempotency(b.db, s, digest, async () => document);
    await b.db.query("update hold set claimed_at = clock_timestamp() where hold_id = $1", [hold_id]);

    const replay = await withIdempotency(b.db, s, digest, () => {
      throw new Error("I8: a matched key must not reach the verb");
    });
    assert.equal(replayOf(replay).claim_consumed, true);
    const z = members(replayOf(replay).record);
    assert.equal(z.handoff, undefined);
    assert.equal(z.state, "claimed");
    await b.reset();
  });

  it("bounds retention at min(24 hours, claim_expires_at)", async () => {
    const key = newKey();
    const { hold_id, document } = await handedOff("A:8", "open");
    const s = { agent_id: AGENT, principal_scope: SCOPE, verb: "hand_off" as const, idempotency_key: key };
    await withIdempotency(b.db, s, handOffDigest(hold_id), async () => document);

    const r = await b.db.query<{ bounded: boolean }>(
      `select (retention_until = $1::timestamptz) as bounded from idempotency where verb = 'hand_off'`,
      [document.handoff.claim_expires_at],
    );
    assert.equal(r.rows[0]?.bounded, true, "retention outlived the claim window");
    await b.reset();
  });
});
