// C-LOG. Owner: TEST-006.
//
// §7: *"One row per invocation including refusals; fail-closed on writes;
// `UPDATE`/`DELETE` denied to the agent role; partition detach permitted only to
// `changeover_retention`."*
//
// **The denials are asserted with a negative control beside them.** "The agent
// role cannot UPDATE the log" passes trivially against a role holding no grants
// at all, or against a table that does not exist, or against a connection that
// never took the role. So every denial below is paired with something the same
// role, in the same transaction shape, *can* do — and the pair is what makes the
// denial mean "this privilege was withheld" rather than "nothing worked."
//
// **Nothing here truncates the access log.** It is append-only and that is a
// property this repository asserts; a helper that quietly emptied it would be
// the first crack in it. Rows this run writes carry a per-run `natural_key`, and
// every count is scoped to them. The partition clause creates a partition of its
// own, far outside any date this suite writes into, and drops it again — so the
// proof is repeatable against a durable Postgres instead of reporting its own
// leftovers as a privilege failure on the second run.
//
// **Fail-closed is asserted through a READ ONLY transaction**, not by breaking
// the table. `SET TRANSACTION READ ONLY` makes Postgres refuse the insert with
// `25006`, which is a real failure of a real write on a real table, and it
// leaves nothing behind to restore.

import {
  AccessLogUnavailable,
  INSUFFICIENT_PRIVILEGE,
  writeAccessLog,
} from "@changeover/core/access-log.ts";
import type { AccessLogRow, DegradationEvent, SecondarySink } from "@changeover/core/access-log.ts";
import { serverTime } from "@changeover/core/clock.ts";
import { SQLSTATE, sqlstate } from "@changeover/store/db.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { ConformanceBench } from "./_bench.ts";
import { OCCASION, TOKEN, grantHold, holdBody, key } from "./_bench.ts";

const LOG_TABLE = "changeover_log.access_log";
const AGENT_ROLE = "changeover_agent";
const RETENTION_ROLE = "changeover_retention";
const CONFORMANCE_SOURCE = "changeover.conformance";

export const id = "C-LOG";
export const spec_row =
  "One row per invocation including refusals; fail-closed on writes; UPDATE/DELETE denied to the agent role; partition detach permitted only to changeover_retention.";

/** The SQLSTATE a statement raised, or `"ok"` where it did not raise. */
async function attempt(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (err) {
    return sqlstate(err) ?? (err instanceof Error ? err.name : String(err));
  }
}

function memorySink(): SecondarySink & { rows: AccessLogRow[]; events: DegradationEvent[] } {
  const rows: AccessLogRow[] = [];
  const events: DegradationEvent[] = [];
  return {
    rows,
    events,
    async record(row) {
      rows.push(row);
    },
    async degradation(event) {
      events.push(event);
    },
  };
}

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  const epoch = { site_epoch_id: `epoch-clog-${bench.nonce}`, key: "a-conformance-key-that-is-not-a-credential" };
  const options = { epoch, timezone: "Pacific/Auckland", record_source: CONFORMANCE_SOURCE };
  const natural = (suffix: string) => `conf-log-${bench.nonce}-${suffix}`;

  /* ── 1 · The log exists, and lives in a schema of its own (A1) ────────── */

  const placed = await bench.db.query<{ n: string }>(
    "select count(*)::text as n from information_schema.tables" +
      " where table_schema = 'changeover_log' and table_name = 'access_log'",
  );
  c.is("a1_separate_schema", placed.rows[0]?.n, "1", "the access log lives in changeover_log, a schema the hold store does not share");

  const observed = await serverTime(bench.db);
  const seeded = await writeAccessLog(
    bench.db,
    {
      verb: "hold_seats",
      outcome: "ok",
      agent_id: "agt_conf_a",
      principal_scope: "prin_conf_wellington",
      occasion_id: OCCASION.main,
      idempotency_key: "an-idempotency-key-this-run-invented",
      natural_key: natural("seed"),
      record_source: CONFORMANCE_SOURCE,
    },
    observed,
    options,
  );
  c.that(
    "seeded",
    seeded.sink === "primary" && seeded.row.natural_key === natural("seed"),
    "one row of this run's own, written to the primary, so every count below can be scoped to it",
  );
  c.that(
    "p2_hashed",
    seeded.row.idempotency_key_hmac !== null &&
      seeded.row.idempotency_key_hmac.length === 43 &&
      seeded.row.idempotency_key_hmac !== "an-idempotency-key-this-run-invented",
    "and the idempotency key reached the row as a 43-character HMAC, never as the value the caller passed",
  );

  /* ── 2 · UPDATE and DELETE denied to the agent role, with a control ───── */

  const agent_insert = await attempt(() =>
    bench.db.transaction(
      (tx) =>
        writeAccessLog(
          tx,
          {
            verb: "resolve_occasions",
            outcome: "ok",
            agent_id: "agt_conf_a",
            principal_scope: "prin_conf_wellington",
            natural_key: natural("as-agent"),
            record_source: CONFORMANCE_SOURCE,
          },
          observed,
          options,
        ),
      { role: AGENT_ROLE },
    ),
  );
  c.is(
    "agent_can_insert",
    agent_insert,
    "ok",
    `${AGENT_ROLE} can INSERT into the log — the control, without which the two denials below would pass against a role holding nothing`,
  );

  const agent_select = await attempt(() =>
    bench.db.transaction(
      (tx) => tx.query(`select count(*) from ${LOG_TABLE} where natural_key = $1`, [natural("seed")]),
      { role: AGENT_ROLE },
    ),
  );
  c.is("agent_can_select", agent_select, "ok", `and it can SELECT, so it can read what it wrote`);

  const agent_update = await attempt(() =>
    bench.db.transaction(
      (tx) => tx.query(`update ${LOG_TABLE} set outcome = 'error' where natural_key = $1`, [natural("seed")]),
      { role: AGENT_ROLE },
    ),
  );
  c.is(
    "update_denied",
    agent_update,
    INSUFFICIENT_PRIVILEGE,
    `UPDATE on the log is denied to ${AGENT_ROLE} with ${SQLSTATE.insufficient_privilege} — append-only is a grant, not a convention the code observes`,
  );

  const agent_delete = await attempt(() =>
    bench.db.transaction(
      (tx) => tx.query(`delete from ${LOG_TABLE} where natural_key = $1`, [natural("seed")]),
      { role: AGENT_ROLE },
    ),
  );
  c.is("delete_denied", agent_delete, INSUFFICIENT_PRIVILEGE, `and so is DELETE`);

  const still_there = await bench.db.query<{ n: string; outcome: string }>(
    `select count(*)::text as n, min(outcome) as outcome from ${LOG_TABLE} where natural_key = $1`,
    [natural("seed")],
  );
  c.that(
    "row_survives",
    still_there.rows[0]?.n === "1" && still_there.rows[0]?.outcome === "ok",
    "and the row is still there, still saying `ok` — the denials were denials and not silent no-ops",
  );

  /* ── 3 · A1's other half: retention cannot reach the hold store ───────── */

  const retention_reads_holds = await attempt(() =>
    bench.db.transaction((tx) => tx.query("select count(*) from hold"), { role: RETENTION_ROLE }),
  );
  c.that(
    "a1_retention_isolated",
    retention_reads_holds !== "ok",
    `${RETENTION_ROLE} — the only role that may DROP — cannot so much as name the hold table (${retention_reads_holds}); it fails at the schema, before any table grant is consulted`,
  );

  /* ── 4 · Partition detach, permitted only to changeover_retention ─────── */

  const partition = `access_log_conf_${bench.nonce.replace(/[^a-z0-9]/g, "").slice(0, 24)}`;
  await bench.db.exec(`drop table if exists changeover_log.${partition}`);
  const created = await attempt(() =>
    bench.db.exec(
      `create table changeover_log.${partition} partition of ${LOG_TABLE}` +
        ` for values from ('2099-01-01') to ('2099-02-01');` +
        ` alter table changeover_log.${partition} owner to ${RETENTION_ROLE}`,
    ),
  );
  if (created !== "ok") {
    c.cannot(
      "detach",
      `a partition of the log could not be created to detach: ${created}. Detaching a partition the suite did not create would destroy a fixture another proof depends on`,
    );
  } else {
    const by_agent = await attempt(() =>
      bench.db.transaction(
        (tx) => tx.query(`alter table ${LOG_TABLE} detach partition changeover_log.${partition}`),
        { role: AGENT_ROLE },
      ),
    );
    c.is(
      "detach_denied_to_agent",
      by_agent,
      INSUFFICIENT_PRIVILEGE,
      `${AGENT_ROLE} cannot DETACH a partition — retention is a DROP and the capability lives in a role holding nothing else`,
    );

    const by_retention = await attempt(() =>
      bench.db.transaction(
        (tx) => tx.query(`alter table ${LOG_TABLE} detach partition changeover_log.${partition}`),
        { role: RETENTION_ROLE },
      ),
    );
    c.is(
      "detach_allowed_to_retention",
      by_retention,
      "ok",
      `${RETENTION_ROLE} can — A3's retention is a DETACH and a DROP, which is not an UPDATE or a DELETE on a row and therefore does not violate append-only`,
    );

    const detached = await bench.db.query<{ n: string }>(
      "select count(*)::text as n from pg_inherits i join pg_class c on c.oid = i.inhrelid" +
        " join pg_namespace s on s.oid = c.relnamespace" +
        " where s.nspname = 'changeover_log' and c.relname = $1",
      [partition],
    );
    c.is("detach_took_effect", detached.rows[0]?.n, "0", "and the partition is genuinely no longer attached, read back from the catalogue");

    // Restore. A proof that leaves the estate changed is a one-shot.
    await bench.db.exec(`drop table if exists changeover_log.${partition}`);
    c.ok("detach_restored", "the partition this clause created is dropped again, so a second run against the same database asserts the same thing");
  }

  /* ── 5 · Fail-closed on a write verb; degrade on a read verb ──────────── */

  const write_closed = await bench.db
    .transaction(
      async (tx) =>
        writeAccessLog(
          tx,
          {
            verb: "hold_seats",
            outcome: "ok",
            agent_id: "agt_conf_a",
            principal_scope: "prin_conf_wellington",
            natural_key: natural("fail-closed"),
            record_source: CONFORMANCE_SOURCE,
          },
          observed,
          options,
        ),
      { readOnly: true },
    )
    .then(() => null)
    .catch((err: unknown) => err);

  c.that(
    "fail_closed",
    write_closed instanceof AccessLogUnavailable && (write_closed as AccessLogUnavailable).verb === "hold_seats",
    `a write verb whose log row cannot be stored throws AccessLogUnavailable and the verb fails CLOSED — never acting unlogged (${write_closed instanceof Error ? write_closed.name : String(write_closed)})`,
  );
  const unlogged = await bench.db.query<{ n: string }>(
    `select count(*)::text as n from ${LOG_TABLE} where natural_key = $1`,
    [natural("fail-closed")],
  );
  c.is("fail_closed_no_row", unlogged.rows[0]?.n, "0", "and no row was written, so the failure is honest in both directions");

  const sink = memorySink();
  const degraded = await bench.db.transaction(
    (tx) =>
      writeAccessLog(
        tx,
        {
          verb: "resolve_occasions",
          outcome: "ok",
          agent_id: "agt_conf_a",
          principal_scope: "prin_conf_wellington",
          natural_key: natural("degrade"),
          record_source: CONFORMANCE_SOURCE,
        },
        observed,
        { ...options, secondary: sink },
      ),
    { readOnly: true },
  );
  c.that(
    "degrade_read",
    degraded.sink === "secondary" && degraded.degraded && sink.rows.length === 1,
    "a READ verb with a durable secondary degrades to it instead of failing the read (A2), and the row lands there",
  );
  c.that(
    "degrade_event",
    sink.events.length === 1 && sink.events[0]?.event === "access_log_degraded" && sink.events[0]?.cause_token === "25006",
    `and a degradation EVENT lands beside it naming the SQLSTATE, so a degradation is a fact rather than a gap (${sink.events[0]?.cause_token})`,
  );

  /* ── 6 · One row per invocation — the seam, and why it is not a row ───── */

  bench.log.clear();
  const refused = await bench.call("GET", "/changeover/v0/holds/hold_00000000000000000000000000000000", {
    token: TOKEN.a,
  });
  const granted = await grantHold(bench, TOKEN.a, ["A:1"], {}, `log-${bench.nonce}`);
  const bad_body = await bench.call("POST", "/changeover/v0/holds", {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`log-bad-${bench.nonce}`) },
    body: holdBody(["ZZ:9"]),
  });
  const invocations = [refused, granted, bad_body];

  c.that(
    "invocations_happened",
    refused.status === 404 && granted.status === 201 && bad_body.status === 400,
    `three invocations across the boundary — one refused, one granted, one refused again (${invocations.map((r) => r.status).join(", ")})`,
  );
  // §5.4: one row per invocation — ok, refused and error alike. Until
  // 2026-08-26 this was an honest `cannot`: the binding called its seam on
  // exactly one path (the unknown-route fault) and the seam's shape carried
  // neither `agent_id` nor `principal_scope`, both NOT NULL on the table. Both
  // are fixed, so this is now an assertion.
  const logged = bench.log.entries;
  c.that(
    "per_invocation",
    logged.length === invocations.length,
    `one row per invocation — ${invocations.length} calls across the boundary, ${logged.length} reached the access-log seam, the two refusals included`,
  );
  c.that(
    "invocation_identity",
    logged.length > 0 &&
      logged.every((e) => e.invocation.agent_id.length > 0 && e.invocation.principal_scope.length > 0),
    `every logged invocation carries the agent_id and principal_scope §5.4 requires and the table declares NOT NULL (${logged
      .map((e) => `${e.invocation.verb}/${e.invocation.outcome}`)
      .join(", ")})`,
  );
  c.that(
    "refusals_carry_their_code",
    logged
      .filter((e) => e.invocation.outcome === "refused")
      .every((e) => typeof e.invocation.refusal_code === "string"),
    "a refused invocation is logged with its closed code — a log of only successes cannot show someone probing the boundary",
  );
  // A2's fail-closed half is NOT satisfied at this binding and the class says
  // so rather than leaving the reader to infer it from an assertion that is not
  // there. It is a specification tension, not an omission: A2 wants the row
  // written or the write verb refused, and A1 wants the log on storage the hold
  // store cannot reach — so by the time a binding knows the outcome, the grant
  // has committed and refusing it would strand the seats AND lose the answer.
  c.cannot(
    "fail_closed_write_verb",
    "A2 requires a write verb whose log row cannot be written to fail closed. This binding logs after the outcome exists, so the Hold has already committed and there is nothing left to refuse; honouring A2 means writing the row inside the verb's transaction, which A1 forbids in the same breath. Reported against SPEC.md §5.4 rather than resolved here",
    "packages/core/src/hmac.ts",
  );

  return c.items;
}
