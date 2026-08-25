/**
 * The access log at the unit and against a real store. Owner: CORE-007.
 *
 * The proofs (`scripts/prove_access_log.sh`, `scripts/prove_pii_ingest.sh`) are
 * the gate; these are here because a regression in P1's digit rule or in the
 * `local_wall` derivation is a customer's phone number in a `DELETE`-denied log
 * or a whole cohort of rows in the wrong partition, and neither announces
 * itself. `npm test` should go red for it on the same commit.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "@changeover/store/db.ts";
import type { Db } from "@changeover/store/db.ts";
import { migrate } from "@changeover/store/migrate.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";

import {
  AccessLogUnavailable,
  DEFAULT_RECORD_SOURCE,
  GRAIN_SQL,
  HMAC_LENGTH,
  INSERT_SQL,
  READ_VERBS,
  WORK_HINT_MAX_LENGTH,
  WRITE_VERBS,
  accessLogRow,
  classifyWorkHint,
  detachLogPartition,
  epochHmac,
  grain,
  isWriteVerb,
  jsonlSink,
  localWallAt,
  localWallSlot,
  longestDigitRun,
  requireValidIntentDigest,
  requireValidWorkHint,
  writeAccessLog,
} from "@changeover/core/access-log.ts";
import type { Invocation } from "@changeover/core/access-log.ts";

const EPOCH = { site_epoch_id: "2026-Q3", key: "a-site-epoch-key-that-is-destroyed-on-rotation" } as const;
const TZ = "Pacific/Auckland";
const OPTIONS = { epoch: EPOCH, timezone: TZ } as const;

/** `assert.throws` returns undefined; the thrown value is the thing under test here. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("nothing was thrown");
}

function invocation(over: Partial<Invocation> = {}): Invocation {
  return {
    verb: "hold_seats",
    outcome: "ok",
    agent_id: "agt_reference",
    principal_scope: "ps_01H8Z",
    ...over,
  } as Invocation;
}

/* ── P1 ─────────────────────────────────────────────────────────────────────── */

test("P1 refuses the email a competent agent would send, and does not strip it", () => {
  const hint = "The Conversation, 35mm, wheelchair space for my mother Ruth, sarah.chen@gmail.com has the booking";
  assert.equal(classifyWorkHint(hint), "at_sign");
  const err = caught(() => requireValidWorkHint(hint));
  assert.ok(isRefusal(err));
  assert.equal((err as { code: string }).code, "hint_rejected");
  // P1: the hint MUST NOT be interpolated into any log line or prose field, and
  // a refusal reason is both. Nothing of the value comes back.
  assert.ok(!(err as { reason: string }).reason.includes("sarah.chen"));
  assert.ok(!(err as { reason: string }).reason.includes("Ruth"));
});

test("P1 refuses phone- and PAN-shaped hints, including a PAN written in groups of four", () => {
  assert.equal(classifyWorkHint("+64 21 555 0199"), "digit_run");
  assert.equal(classifyWorkHint("0212345678"), "digit_run");
  assert.equal(classifyWorkHint("4111111111111111"), "digit_run");
  // The one the normative floor alone would have let through: four runs of four.
  assert.equal(longestDigitRun("4111 1111 1111 1111"), 16);
  assert.equal(classifyWorkHint("4111 1111 1111 1111"), "digit_run");
  assert.equal(classifyWorkHint("4111-1111-1111-1111"), "digit_run");
});

test("P1 refuses a URI scheme without refusing a colon", () => {
  assert.equal(classifyWorkHint("https://evil.example/x"), "uri_scheme");
  assert.equal(classifyWorkHint("mailto:a"), "uri_scheme");
  assert.equal(classifyWorkHint("javascript: alert"), "uri_scheme");
  // A generic [a-z]+: pattern would reject all three of these, and they are films.
  assert.equal(classifyWorkHint("Kill Bill: Vol. 1"), null);
  assert.equal(classifyWorkHint("2001: A Space Odyssey"), null);
  assert.equal(classifyWorkHint("note: a fine film"), null);
});

test("P1 admits non-Latin titles and refuses characters outside the allowlist", () => {
  assert.equal(classifyWorkHint("万引き家族"), null);
  assert.equal(classifyWorkHint("Аритмия"), null);
  assert.equal(classifyWorkHint("The 39 Steps 1935"), null);
  assert.equal(classifyWorkHint("Se7en"), null);
  assert.equal(classifyWorkHint("a/b"), "charset");
  assert.equal(classifyWorkHint("a_b"), "charset");
  assert.equal(classifyWorkHint(""), "empty");
  assert.equal(classifyWorkHint("x".repeat(WORK_HINT_MAX_LENGTH + 1)), "too_long");
  assert.equal(requireValidWorkHint("The Conversation"), "The Conversation");
});

/* ── P2 / D3 ────────────────────────────────────────────────────────────────── */

test("P2 stores an HMAC of the right shape, and a rotation changes every row's digest", () => {
  const a = epochHmac(EPOCH, "The Conversation");
  assert.equal(a.length, HMAC_LENGTH);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a, epochHmac(EPOCH, "The Conversation"));
  const rotated = { site_epoch_id: "2026-Q4", key: "the-next-key" };
  assert.notEqual(a, epochHmac(rotated, "The Conversation"));
});

test("P2 puts no raw value on the row, and the row names the epoch that made it", () => {
  const row = accessLogRow(
    invocation({
      work_hint: "The Conversation",
      intent_digest: "A".repeat(43),
      idempotency_key: "idem-0001",
      occasion_id: "occ_embassy_sat_1900",
    }),
    "2026-08-31T13:00:00.000000+00:00",
    OPTIONS,
  );
  const serialised = JSON.stringify(row);
  assert.ok(!serialised.includes("The Conversation"));
  assert.ok(!serialised.includes("idem-0001"));
  assert.ok(!serialised.includes("A".repeat(43)));
  assert.equal(row.site_epoch_id, "2026-Q3");
  assert.equal(row.work_hint_hmac, epochHmac(EPOCH, "The Conversation"));
  assert.equal(row.record_source, DEFAULT_RECORD_SOURCE);
  assert.equal(row.degraded, false);
  // No member of the row is the raw input under any name.
  for (const key of Object.keys(row)) {
    assert.ok(!["work_hint", "intent_digest", "idempotency_key"].includes(key), `${key} is on the row`);
  }
});

test("D3 rejects an intent_digest that is not 43 base64url characters", () => {
  assert.equal(requireValidIntentDigest("B".repeat(43)), "B".repeat(43));
  for (const bad of ["", "B".repeat(42), "B".repeat(44), "B".repeat(42) + "+"]) {
    const err = caught(() => requireValidIntentDigest(bad));
    assert.ok(isRefusal(err));
    assert.equal((err as { code: string }).code, "schema_validation");
  }
});

test("the CHECK's rule is enforced before the CHECK sees it, in both directions", () => {
  assert.throws(() => accessLogRow(invocation({ outcome: "refused" }), "2026-08-31T13:00:00+00:00", OPTIONS));
  assert.throws(
    () => accessLogRow(invocation({ outcome: "ok", refusal_code: "seat_contended" }), "2026-08-31T13:00:00+00:00", OPTIONS),
  );
  assert.doesNotThrow(
    () => accessLogRow(invocation({ outcome: "refused", refusal_code: "hint_rejected" }), "2026-08-31T13:00:00+00:00", OPTIONS),
  );
  assert.doesNotThrow(() => accessLogRow(invocation({ outcome: "error" }), "2026-08-31T13:00:00+00:00", OPTIONS));
});

/* ── §2.8 local_wall ────────────────────────────────────────────────────────── */

test("local_wall crosses a month boundary that UTC does not", () => {
  const wall = localWallAt("2026-08-31T13:00:00Z", TZ);
  assert.equal(wall.local_wall, "2026-09-01T01:00");
  assert.equal(wall.local_wall_date, "2026-09-01");
  assert.equal(wall.local_wall_offset, "+12:00");
  assert.equal(localWallSlot(wall), 1);
});

test("the autumn fold gives one local_wall two offsets, which is why neither row is dropped", () => {
  const first = localWallAt("2026-04-04T13:30:00Z", TZ);
  const second = localWallAt("2026-04-04T14:30:00Z", TZ);
  assert.equal(first.local_wall, "2026-04-05T02:30");
  assert.equal(second.local_wall, "2026-04-05T02:30");
  assert.equal(first.local_wall_offset, "+13:00");
  assert.equal(second.local_wall_offset, "+12:00");
  assert.equal(first.local_wall_date, second.local_wall_date);
});

test("the spring gap is never emitted, because the derivation only runs forward", () => {
  assert.equal(localWallAt("2026-09-26T13:59:00Z", TZ).local_wall, "2026-09-27T01:59");
  assert.equal(localWallAt("2026-09-26T14:00:00Z", TZ).local_wall, "2026-09-27T03:00");
  assert.equal(localWallAt("2026-09-26T14:00:00Z", TZ).local_wall_offset, "+13:00");
});

test("a fractional-hour zone keeps its minutes", () => {
  assert.equal(localWallAt("2026-08-31T13:00:00Z", "Pacific/Chatham").local_wall_offset, "+12:45");
  assert.equal(localWallAt("2026-01-31T13:00:00Z", "America/St_Johns").local_wall_offset, "-03:30");
  assert.equal(localWallAt("2026-08-31T13:00:00Z", "UTC").local_wall_offset, "+00:00");
});

/* ── A2 · the asymmetry ─────────────────────────────────────────────────────── */

test("A2 divides the verbs, and the division covers the closed verb set", () => {
  assert.deepEqual([...WRITE_VERBS], ["hold_seats", "release_hold", "hand_off", "claim_confirm"]);
  assert.deepEqual([...READ_VERBS], ["resolve_occasions", "get_hold", "claim_render"]);
  assert.equal(WRITE_VERBS.length + READ_VERBS.length, 7);
  assert.ok(isWriteVerb("release_hold"));
  assert.ok(!isWriteVerb("get_hold"));
});

/* ── P3 ─────────────────────────────────────────────────────────────────────── */

test("P3: the grain query names no P2 column", () => {
  for (const column of ["work_hint_hmac", "intent_digest_hmac", "idempotency_key_hmac"]) {
    assert.ok(!GRAIN_SQL.includes(column), `${column} appears in GRAIN_SQL`);
  }
  assert.ok(GRAIN_SQL.includes("local_wall_slot"));
  assert.ok(!/\bdate_trunc\s*\(\s*'[a-z]+'\s*,\s*observed_at/.test(GRAIN_SQL), "the grain fell back to UTC");
});

/* ── Against a real store ───────────────────────────────────────────────────── */

async function store(): Promise<Db> {
  const db = await openDb({ driver: "pglite" });
  await migrate(db, { logPartitionsFrom: new Date(Date.UTC(2026, 3, 1)), logPartitionMonths: 6 });
  return db;
}

test("every invocation writes one row, refusals included, and the row carries no raw value", async (t) => {
  const db = await store();
  t.after(() => db.close());

  const at = "2026-08-31T13:00:00.000000+00:00";
  await writeAccessLog(db, invocation({ natural_key: "k1", work_hint: "The Conversation" }), at, OPTIONS);
  await writeAccessLog(
    db,
    invocation({ verb: "get_hold", outcome: "refused", refusal_code: "hold_not_found", natural_key: "k2" }),
    at,
    OPTIONS,
  );
  await writeAccessLog(db, invocation({ verb: "release_hold", outcome: "error", natural_key: "k3" }), at, OPTIONS);

  const r = await db.query<{ n: string }>("select count(*)::text as n from changeover_log.access_log");
  assert.equal(Number(r.rows[0]!.n), 3);

  const refused = await db.query<{ refusal_code: string }>(
    "select refusal_code from changeover_log.access_log where outcome = 'refused'",
  );
  assert.equal(refused.rows.length, 1);
  assert.equal(refused.rows[0]!.refusal_code, "hold_not_found");

  const hint = await db.query<{ work_hint_hmac: string | null }>(
    "select work_hint_hmac from changeover_log.access_log where natural_key = 'k1'",
  );
  assert.equal(hint.rows[0]!.work_hint_hmac, epochHmac(EPOCH, "The Conversation"));
});

test("the CHECK forces a reason on refusals even when the writer is bypassed", async (t) => {
  const db = await store();
  t.after(() => db.close());
  await assert.rejects(
    db.query(INSERT_SQL, [
      "2026-08-31", "2026-08-31T20:00", "+12:00", "2026-08-31T08:00:00+00:00",
      "agt_x", "ps_x", "hold_seats", "refused", null, null, null, "2026-Q3",
      null, null, null, "s", "nk-check", "2026-08-31T08:00:00+00:00", false,
    ]),
    (err: unknown) => (err as { code?: string }).code === "23514",
  );
});

test("the fold's two rows both land, and in the local_wall partition", async (t) => {
  const db = await store();
  t.after(() => db.close());

  for (const at of ["2026-04-04T13:30:00.000000+00:00", "2026-04-04T14:30:00.000000+00:00"]) {
    await writeAccessLog(db, invocation({ verb: "get_hold", natural_key: "marathon" }), at, OPTIONS);
  }
  const r = await db.query<{ local_wall_offset: string; part: string }>(
    "select local_wall_offset, tableoid::regclass::text as part from changeover_log.access_log " +
      "where natural_key = 'marathon' order by local_wall_offset",
  );
  assert.equal(r.rows.length, 2, "one of the marathon's two 02:30s was dropped");
  assert.deepEqual(r.rows.map((x) => x.local_wall_offset), ["+12:00", "+13:00"]);
  for (const row of r.rows) assert.match(row.part, /access_log_2026_04$/);
});

test("a row whose UTC month is August lands in the September partition", async (t) => {
  const db = await store();
  t.after(() => db.close());
  await writeAccessLog(db, invocation({ natural_key: "boundary" }), "2026-08-31T13:00:00.000000+00:00", OPTIONS);
  const r = await db.query<{ part: string; d: string; slot: number }>(
    "select tableoid::regclass::text as part, local_wall_date::text as d, local_wall_slot as slot " +
      "from changeover_log.access_log where natural_key = 'boundary'",
  );
  assert.match(r.rows[0]!.part, /access_log_2026_09$/);
  assert.equal(r.rows[0]!.d, "2026-09-01");
  assert.equal(Number(r.rows[0]!.slot), 1);
});

test("the ingest key makes a retry one fact and not two", async (t) => {
  const db = await store();
  t.after(() => db.close());
  const at = "2026-08-31T13:00:00.000000+00:00";
  await writeAccessLog(db, invocation({ natural_key: "same" }), at, OPTIONS);
  await writeAccessLog(db, invocation({ natural_key: "same" }), at, OPTIONS);
  const r = await db.query<{ n: string }>(
    "select count(*)::text as n from changeover_log.access_log where natural_key = 'same'",
  );
  assert.equal(Number(r.rows[0]!.n), 1);
});

test("UPDATE and DELETE are denied to the agent role, and INSERT is not", async (t) => {
  const db = await store();
  t.after(() => db.close());

  const denied = async (sql: string): Promise<string | undefined> => {
    try {
      await db.transaction(async (tx) => { await tx.query(sql); }, { role: "changeover_agent" });
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    }
  };
  assert.equal(await denied("update changeover_log.access_log set outcome = 'ok'"), "42501");
  assert.equal(await denied("delete from changeover_log.access_log"), "42501");
  // The positive control: without it, a typo in the schema name would pass both.
  await db.transaction(
    async (tx) => {
      await writeAccessLog(tx, invocation({ natural_key: "as-agent" }), "2026-08-31T13:00:00.000000+00:00", OPTIONS);
    },
    { role: "changeover_agent" },
  );
  const r = await db.query<{ n: string }>(
    "select count(*)::text as n from changeover_log.access_log where natural_key = 'as-agent'",
  );
  assert.equal(Number(r.rows[0]!.n), 1);
});

test("A3: only changeover_retention may detach a partition", async (t) => {
  const db = await store();
  t.after(() => db.close());

  await assert.rejects(
    db.transaction(
      async (tx) => { await tx.query("alter table changeover_log.access_log detach partition changeover_log.access_log_2026_05"); },
      { role: "changeover_agent" },
    ),
  );
  await detachLogPartition(db, "access_log_2026_05");
  const r = await db.query<{ n: string }>(
    "select count(*)::text as n from pg_inherits i join pg_class c on c.oid = i.inhrelid " +
      "where c.relname = 'access_log_2026_05'",
  );
  assert.equal(Number(r.rows[0]!.n), 0);
  await assert.rejects(detachLogPartition(db, "access_log; drop table hold"), TypeError);
});

test("a write verb fails closed and a read verb degrades to a durable sink", async (t) => {
  const db = await store();
  const dir = await mkdtemp(join(tmpdir(), "changeover-log-"));
  const path = join(dir, "secondary.jsonl");
  t.after(async () => { await db.close(); await rm(dir, { recursive: true, force: true }); });

  // A real store failure, not a mock: drop every partition a row could land in.
  // This is A2's own scenario — the log is gone and the verbs must diverge.
  await db.transaction(async (tx) => {
    await tx.query("drop table changeover_log.access_log_default");
  }, { role: "changeover_retention" });
  for (const m of ["04", "05", "06", "07", "08", "09"]) {
    await detachLogPartition(db, `access_log_2026_${m}`).catch(() => undefined);
  }

  const at = "2026-08-31T13:00:00.000000+00:00";
  const sink = jsonlSink(path);
  const options = { ...OPTIONS, secondary: sink };

  await assert.rejects(
    writeAccessLog(db, invocation({ verb: "hold_seats", natural_key: "w1" }), at, options),
    (err: unknown) => err instanceof AccessLogUnavailable && err.verb === "hold_seats",
  );

  const read = await writeAccessLog(
    db,
    invocation({ verb: "get_hold", natural_key: "r1", work_hint: "The Conversation" }),
    at,
    options,
  );
  assert.equal(read.sink, "secondary");
  assert.equal(read.degraded, true);
  assert.equal(read.row.degraded, true);
  assert.equal(read.degradation?.event, "access_log_degraded");

  const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 2, "the degradation was not recorded as an event beside the row");
  assert.equal(lines[0]!.kind, "access_log_row");
  assert.equal(lines[0]!.degraded, true);
  assert.equal(lines[1]!.event, "access_log_degraded");
  // The sink is durable storage too. No raw value reaches it, and no driver message.
  const text = await readFile(path, "utf8");
  assert.ok(!text.includes("The Conversation"));
  assert.ok(!/duplicate key|violates|Key \(/.test(text));
});

test("a read verb with no secondary sink fails closed rather than dropping the row", async (t) => {
  const db = await store();
  t.after(() => db.close());
  await db.transaction(async (tx) => {
    await tx.query("drop table changeover_log.access_log_default");
  }, { role: "changeover_retention" });
  for (const m of ["04", "05", "06", "07", "08", "09"]) {
    await detachLogPartition(db, `access_log_2026_${m}`).catch(() => undefined);
  }
  await assert.rejects(
    writeAccessLog(db, invocation({ verb: "get_hold", natural_key: "r2" }), "2026-08-31T13:00:00.000000+00:00", OPTIONS),
    (err: unknown) => err instanceof AccessLogUnavailable,
  );
});

test("P3: the grain counts what happened, with attribution beside it", async (t) => {
  const db = await store();
  t.after(() => db.close());
  const at = "2026-08-31T13:00:00.000000+00:00";
  await writeAccessLog(db, invocation({ natural_key: "g1", occasion_id: "occ_a" }), at, OPTIONS);
  await writeAccessLog(db, invocation({ natural_key: "g2" }), at, OPTIONS);
  await writeAccessLog(
    db,
    invocation({ natural_key: "g3", outcome: "refused", refusal_code: "hint_rejected", agent_id: "agt_other" }),
    at,
    OPTIONS,
  );

  const rows = await grain(db, "2026-09-01", "2026-09-01");
  const ok = rows.find((r) => r.outcome === "ok")!;
  assert.equal(ok.invocations, 2);
  assert.equal(ok.agents, 1);
  assert.equal(ok.attribution_rate, 0.5);
  assert.equal(ok.local_wall_slot, 1);
  const refused = rows.find((r) => r.outcome === "refused")!;
  assert.equal(refused.refusal_code, "hint_rejected");
  assert.equal(refused.invocations, 1);
});
