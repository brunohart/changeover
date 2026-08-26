// DESTRUCTIVE. For a scratch database only. Owner: CORE-001.
//
// This module writes probe rows, provokes constraint violations and detaches a
// log partition. Never point it at a database anyone cares about.
//
// It exists so that `scripts/prove_migrations.sh` (PGlite, always available)
// and `scripts/prove_migrations_pg.sh` (real Postgres, gated on
// CHANGEOVER_PG_URL) assert exactly the same things. Two scripts that were
// meant to be the same assertion set and were maintained as two copies would
// diverge, and the copy that mattered would be the one nobody ran.
//
// Every assertion here is a property of the SCHEMA, so all of them are
// observable on one connection. Nothing in this file claims anything about
// concurrency: the floor holding under 200 simultaneous callers is C-ATOMIC's
// claim, it needs a server PGlite cannot be, and TEST-001 exits 2 rather than
// pretend otherwise.

import type { Db } from "./db.ts";
import { constraintName, SQLSTATE, sqlstate } from "./db.ts";
import { migrate } from "./migrate.ts";
import { HUNDRED_SEAT_HOUSE, seedEstate } from "./fixtures.ts";

export interface AuditResult {
  /** One line per assertion that held, in the order they were checked. */
  readonly held: readonly string[];
  /** One line per assertion that did not. Empty means the floor is intact. */
  readonly failed: readonly string[];
}

const QUOTE = String.fromCharCode(39);
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXY";
const AGENT = "agt_schema_audit";
const PRINCIPAL = "ppid_schema_audit";
const OCCASION = HUNDRED_SEAT_HOUSE.occasions[0]!;

/** hold_ plus 32 Crockford base32 characters — the shape Z2 requires. */
function holdId(tail: string): string {
  return "hold_" + ALPHABET + tail;
}

/**
 * Migrate a scratch database, then assert every property of the floor that a
 * single connection can observe.
 */
export async function auditSchema(db: Db): Promise<AuditResult> {
  const held: string[] = [];
  const failed: string[] = [];
  const ok = (m: string): void => void held.push(m);
  const bad = (m: string): void => void failed.push(m);

  await migrate(db);
  await seedEstate(db, HUNDRED_SEAT_HOUSE);

  await insertHold(db, holdId("2"), OCCASION.cluster);
  await insertHold(db, holdId("3"), null);

  await auditSeatFloor(db, ok, bad);
  await auditClusterFanout(db, ok, bad);
  await auditBudgetSlot(db, ok, bad);
  await auditLogPartitioning(db, ok, bad);
  await auditDerivedState(db, ok, bad);
  // Order matters: auditGrants ends by DETACHING the log's default partition,
  // after which a row for a month with no partition has nowhere to land.
  await auditLogReason(db, ok, bad);
  await auditGrants(db, ok, bad);
  await auditAbsences(db, ok, bad);

  return { held, failed };
}

type Say = (message: string) => void;

async function insertHold(db: Db, id: string, cluster: string | null): Promise<void> {
  await db.query(
    "insert into hold (hold_id, agent_id, principal_scope, origin, cluster, occasion_id, occasion_etag," +
      " sought_occasion_id, showtime_id, seats, granted_at, floor_ms, floor_deadline, expires_at)" +
      " select $1, $2, $3, $4, $5, $6, $7, $6, $6, $8, g, $9::int," +
      "        g + make_interval(secs => $9::int / 1000.0), g + make_interval(secs => 600)" +
      " from (select clock_timestamp() as g) t",
    [id, AGENT, PRINCIPAL, OCCASION.origin, cluster, OCCASION.occasion_id, OCCASION.etag, ["A:1"], 120000],
  );
}

async function indexdef(db: Db, name: string): Promise<string> {
  const r = await db.query<{ indexdef: string }>(
    "select indexdef from pg_indexes where schemaname = $1 and indexname = $2",
    ["public", name],
  );
  return String(r.rows[0]?.indexdef ?? "");
}

function predicateOf(def: string): string {
  const at = def.search(/\bWHERE\b/);
  return at < 0 ? "" : def.slice(at);
}

async function occupySeat(db: Db, id: string, state: string): Promise<void> {
  await db.query(
    "insert into hold_seat (hold_id, occasion_id, showtime_id, seat_id, state, held_until)" +
      " values ($1, $2, $3, $4, $5, clock_timestamp() + make_interval(secs => 600))",
    [id, OCCASION.occasion_id, OCCASION.showtime_id, "A:1", state],
  );
}

// --- the floor --------------------------------------------------------------

async function auditSeatFloor(db: Db, ok: Say, bad: Say): Promise<void> {
  const def = await indexdef(db, "hold_seat_occupied");
  // The KEY is asserted, not only the predicate. Corrected 2026-08-25: this
  // read `(occasion_id, seat_id)`, and asserting only the predicate is what let
  // the wrong key survive review. The scarce thing is a seat at a PHYSICAL
  // SCREENING; `showtime_ref` exists so several Occasions may map to one
  // screening, and keyed on occasion_id two of them can each hold seat F11 and
  // both commit — oversell arriving through the constraint written to forbid it.
  // The two keys are identical only while showtime_ref is absent, which is true
  // of every golden fixture. SPEC.md §4.6 and §2.2 are authoritative; ADR-005
  // was corrected to match them.
  if (/CREATE UNIQUE INDEX/i.test(def) && /\(showtime_id, seat_id\)/.test(def)) {
    ok("hold_seat_occupied is a UNIQUE index on hold_seat (showtime_id, seat_id) — the physical screening, not the listing");
  } else {
    bad("hold_seat_occupied is not a unique index on (showtime_id, seat_id): " + (def || "absent"));
  }
  if (/\(occasion_id, seat_id\)/.test(def)) {
    bad("hold_seat_occupied is keyed on occasion_id: two Occasions sharing one showtime_ref can each hold the same seat");
  }

  const predicate = predicateOf(def);
  const missing = ["live", "handed_off", "claimed"].filter((s) => !predicate.includes(QUOTE + s + QUOTE));
  if (predicate !== "" && missing.length === 0) {
    ok("its predicate admits every seat-occupying state — live, handed_off AND claimed (ADR-005)");
  } else {
    bad("predicate omits " + (missing.join(", ") || "a WHERE clause entirely") + ": " + predicate);
  }

  // Reading the predicate is not the same as watching it fire. A predicate can
  // be spelled correctly over a column nothing ever sets.
  await occupySeat(db, holdId("2"), "claimed");
  try {
    await occupySeat(db, holdId("3"), "live");
    bad("a seat already CLAIMED was re-held — the draft defect ADR-005 exists to close");
  } catch (err) {
    if (sqlstate(err) === SQLSTATE.unique_violation && constraintName(err) === "hold_seat_occupied") {
      ok("re-holding a claimed seat raises 23505 on hold_seat_occupied → 409 seat_contended");
    } else {
      bad("re-holding a claimed seat gave " + sqlstate(err) + "/" + constraintName(err) + ", not hold_seat_occupied");
    }
  }

  // The case the wrong key made reachable, asserted behaviourally rather than
  // by reading the index definition. Two DIFFERENT Occasions that share one
  // showtime_ref are two listings of one physical screening — a premiere and a
  // standard listing of the same 7pm show, or two price bands. Keyed on
  // occasion_id these are distinct index entries and both inserts commit,
  // selling one seat twice. Keyed on showtime_id the second raises 23505.
  const SHARED_SHOWTIME = OCCASION.showtime_id;
  const seat = "A:2";
  await db.query(
    "insert into hold_seat (hold_id, occasion_id, showtime_id, seat_id, state, held_until)" +
      " values ($1, $2, $3, $4, 'live', clock_timestamp() + make_interval(secs => 600))",
    [holdId("2"), "occ_premiere_listing", SHARED_SHOWTIME, seat],
  );
  try {
    await db.query(
      "insert into hold_seat (hold_id, occasion_id, showtime_id, seat_id, state, held_until)" +
        " values ($1, $2, $3, $4, 'live', clock_timestamp() + make_interval(secs => 600))",
      [holdId("3"), "occ_standard_listing", SHARED_SHOWTIME, seat],
    );
    bad("two Occasions sharing one showtime_ref each held seat " + seat + " — the house sold one seat twice");
  } catch (err) {
    if (sqlstate(err) === SQLSTATE.unique_violation && constraintName(err) === "hold_seat_occupied") {
      ok("two Occasions on one showtime_ref cannot both hold a seat — oversell across listings raises 23505");
    } else {
      bad("cross-listing oversell gave " + sqlstate(err) + "/" + constraintName(err) + ", not hold_seat_occupied");
    }
  }
}

async function auditClusterFanout(db: Db, ok: Say, bad: Say): Promise<void> {
  const def = await indexdef(db, "hold_cluster_live");
  if (/CREATE UNIQUE INDEX/i.test(def) && /\(agent_id, principal_scope, origin, cluster\)/.test(def)) {
    ok("hold_cluster_live is a UNIQUE index on (agent_id, principal_scope, origin, cluster)");
  } else {
    bad("hold_cluster_live is not a unique index on that key: " + (def || "absent"));
  }

  const predicate = predicateOf(def);
  const covers = predicate.includes(QUOTE + "live" + QUOTE) && predicate.includes(QUOTE + "handed_off" + QUOTE);
  if (covers && !predicate.includes(QUOTE + "claimed" + QUOTE)) {
    ok("its predicate covers live and handed_off and deliberately NOT claimed — two purchases in one cluster are not fan-out (X2)");
  } else {
    bad("hold_cluster_live predicate is wrong: " + predicate);
  }

  const occupyCluster = (id: string): Promise<unknown> =>
    db.query(
      "insert into hold_cluster (hold_id, agent_id, principal_scope, origin, cluster, state, held_until)" +
        " values ($1, $2, $3, $4, $5, $6, clock_timestamp() + make_interval(secs => 600))",
      [id, AGENT, PRINCIPAL, OCCASION.origin, OCCASION.cluster, "live"],
    );
  await occupyCluster(holdId("2"));
  try {
    await occupyCluster(holdId("3"));
    bad("a second live hold in one (origin, cluster) for one principal was accepted (X2)");
  } catch (err) {
    if (constraintName(err) === "hold_cluster_live") {
      ok("a second live hold in one cluster raises 23505 on hold_cluster_live → 429 cluster_fanout");
    } else {
      bad("cluster fan-out gave constraint " + constraintName(err) + ", not hold_cluster_live");
    }
  }
}

async function auditBudgetSlot(db: Db, ok: Say, bad: Say): Promise<void> {
  const take = (id: string, slot: number): Promise<unknown> =>
    db.query(
      "insert into hold_slot (agent_id, principal_scope, showtime_id, slot, hold_id) values ($1, $2, $3, $4, $5)",
      [AGENT, PRINCIPAL, OCCASION.showtime_id, slot, id],
    );
  await take(holdId("2"), 0);
  try {
    await take(holdId("3"), 0);
    bad("two holds took the same budget slot (X1)");
  } catch (err) {
    // SPEC.md:393 spells this constraint `hold_slot`; Postgres cannot carry a
    // constraint whose name collides with its own table, so it is
    // `hold_slot_taken`. What matters normatively is that it is NOT
    // hold_seat_occupied: "any other 23505 MUST NOT be reported as
    // seat_contended".
    const name = constraintName(err);
    if (sqlstate(err) === SQLSTATE.unique_violation && name === "hold_slot_taken") {
      ok("a taken budget slot raises 23505 on hold_slot_taken → 429 hold_budget_exhausted, distinguishable from seat_contended");
    } else {
      bad("budget-slot contention gave " + sqlstate(err) + "/" + name + ", not hold_slot_taken");
    }
  }
}

async function auditLogPartitioning(db: Db, ok: Say, bad: Say): Promise<void> {
  const r = await db.query<{ relkind: string; partstrat: string; keydef: string }>(
    "select c.relkind, p.partstrat, pg_get_partkeydef(c.oid) as keydef" +
      " from pg_class c join pg_namespace n on n.oid = c.relnamespace" +
      " left join pg_partitioned_table p on p.partrelid = c.oid" +
      " where n.nspname = $1 and c.relname = $2",
    ["changeover_log", "access_log"],
  );
  const row = r.rows[0];
  if (row && row.relkind === "p" && row.partstrat === "r" && String(row.keydef).includes("local_wall_date")) {
    ok("changeover_log.access_log is RANGE partitioned by local_wall_date (A3), not by UTC");
  } else {
    bad("access_log is not range-partitioned by local_wall_date: " + JSON.stringify(row ?? null));
  }
}

async function auditDerivedState(db: Db, ok: Say, bad: Say): Promise<void> {
  const r = await db.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = $1 and table_name = $2",
    ["public", "hold"],
  );
  const names = r.rows.map((row) => String(row.column_name));
  if (names.length > 0 && !names.includes("state")) {
    ok("information_schema shows NO state column on hold — state is derived at every read (M1–M3)");
  } else if (names.length === 0) {
    bad("the hold table does not exist");
  } else {
    bad("hold carries a state column, which is a lie the moment a reap runs elsewhere");
  }
}

// --- the grants -------------------------------------------------------------

async function auditGrants(db: Db, ok: Say, bad: Say): Promise<void> {
  const asAgent = (sql: string, params: readonly unknown[]): Promise<unknown> =>
    db.transaction((tx) => tx.query(sql, params), { role: "changeover_agent" });

  const denied = async (label: string, sql: string, params: readonly unknown[]): Promise<void> => {
    try {
      await asAgent(sql, params);
      bad(label + " was PERMITTED to changeover_agent");
    } catch (err) {
      if (sqlstate(err) === SQLSTATE.insufficient_privilege) {
        ok(label + " is denied to changeover_agent by grant (42501)");
      } else {
        bad(label + " failed with " + sqlstate(err) + ", not 42501: " + message(err));
      }
    }
  };

  // The control. Without it every denial below is satisfied by a role that
  // cannot see the table at all, which proves nothing about append-only.
  try {
    await asAgent(logInsert(), logRow("ok", null, "nk-audit-1"));
    ok("changeover_agent CAN append to the access log — the control, without which the denials below are vacuous");
  } catch (err) {
    bad("changeover_agent cannot write the access log at all: " + sqlstate(err) + " " + message(err));
  }

  await denied("UPDATE on changeover_log.access_log", "update changeover_log.access_log set outcome = $1", ["refused"]);
  await denied("DELETE on changeover_log.access_log", "delete from changeover_log.access_log", []);
  await denied("DELETE on hold", "delete from hold where hold_id = $1", [holdId("2")]);
  await denied("UPDATE of floor_deadline on hold", "update hold set floor_deadline = clock_timestamp()", []);
  await denied("UPDATE of seats on hold", "update hold set seats = $1", [["Z:1"]]);
  await denied(
    "INSERT on occasion_seat",
    "insert into occasion_seat (occasion_id, seat_id, status) values ($1, $2, $3)",
    [OCCASION.occasion_id, "ZZ:1", "available"],
  );

  try {
    await asAgent("update hold set expires_at = expires_at + make_interval(secs => 60) where hold_id = $1", [holdId("2")]);
    ok("changeover_agent CAN move expires_at upward — the floor is immovable, the merchant intention is not (T2, T3, T7)");
  } catch (err) {
    bad("changeover_agent cannot move expires_at: " + sqlstate(err) + " " + message(err));
  }

  // Schema-qualified deliberately: unqualified, the answer is 42P01 "relation
  // hold does not exist", because search_path silently skips a schema the role
  // has no USAGE on. A stronger outcome, but a weaker proof — indistinguishable
  // from a table that was never created.
  try {
    await db.transaction((tx) => tx.query("select count(*) from public.hold"), { role: "changeover_retention" });
    bad("changeover_retention can read the hold store — it is meant to hold the DROP capability and nothing else");
  } catch (err) {
    if (sqlstate(err) === SQLSTATE.insufficient_privilege) {
      ok("changeover_retention cannot reach the hold store at all (A3: it holds nothing else)");
    } else {
      bad("changeover_retention reached the hold store with " + sqlstate(err));
    }
  }

  try {
    await db.transaction(
      (tx) => tx.query("alter table changeover_log.access_log detach partition changeover_log.access_log_default"),
      { role: "changeover_retention" },
    );
    ok("changeover_retention CAN detach a log partition — erasure without an UPDATE or a DELETE (A3)");
  } catch (err) {
    bad("changeover_retention cannot detach a partition: " + sqlstate(err) + " " + message(err));
  }
}

async function auditLogReason(db: Db, ok: Say, bad: Say): Promise<void> {
  try {
    await db.query(logInsert(), logRow("refused", null, "nk-audit-2"));
    bad("a refusal was logged with no reason — the CHECK of §5.4 is absent");
  } catch (err) {
    if (sqlstate(err) === SQLSTATE.check_violation) {
      ok("a refusal logged without a refusal code is a 23514 — §5.4 forces a reason on refusals");
    } else {
      bad("logging a reasonless refusal gave " + sqlstate(err) + ", not 23514");
    }
  }
  try {
    await db.query(logInsert(), logRow("refused", "seat_contended", "nk-audit-3"));
    ok("a refusal WITH its closed code is accepted — refusals are logged deliberately, at bounded size (A4)");
  } catch (err) {
    bad("a well-formed refusal could not be logged: " + sqlstate(err) + " " + message(err));
  }
}

// --- the absences -----------------------------------------------------------

async function auditAbsences(db: Db, ok: Say, bad: Say): Promise<void> {
  const r = await db.query<{ table_name: string; column_name: string }>(
    "select table_name, column_name from information_schema.columns where table_schema in ($1, $2)",
    ["public", "changeover_log"],
  );
  const PERSONAL =
    /(^|_)(name|email|e_mail|phone|mobile|surname|given|family|dob|birth|address|postcode|loyalty|member_no|card|pan|iban|ssn|nhi)($|_)/i;
  const ABSENT_PATTERN = /settle|pay|capture|refund|charge/i;

  const personal = r.rows.filter((row) => PERSONAL.test(String(row.column_name)));
  if (r.rows.length > 20 && personal.length === 0) {
    ok("no column in either schema is a field for a person — " + r.rows.length + " columns scanned");
  } else if (r.rows.length <= 20) {
    bad("the scan found only " + r.rows.length + " columns, so it did not run against a migrated database");
  } else {
    bad("a personal-data column exists: " + personal.map((row) => row.table_name + "." + row.column_name).join(", "));
  }

  const hits = r.rows.filter(
    (row) => ABSENT_PATTERN.test(String(row.column_name)) || ABSENT_PATTERN.test(String(row.table_name)),
  );
  if (hits.length === 0) {
    ok("no table or column settles, authorises, captures, refunds or charges (ADR-001)");
  } else {
    bad("a settlement-shaped identifier exists: " + hits.map((row) => row.table_name + "." + row.column_name).join(", "));
  }
}

// --- helpers ----------------------------------------------------------------

function logInsert(): string {
  return (
    "insert into changeover_log.access_log (local_wall_date, local_wall, local_wall_offset, observed_at," +
    " agent_id, principal_scope, verb, outcome, refusal_code, site_epoch_id, record_source, natural_key, input_watermark)" +
    " values ($1::date, $1 || $2, $3, clock_timestamp(), $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp())"
  );
}

/**
 * Today, as a local wall date.
 *
 * Not a fixed date: migrate() pre-creates month partitions from the current
 * month forward, so a hard-coded August would land in the DEFAULT partition
 * every month but one — and the default partition is the one this audit
 * detaches. An assertion that quietly starts testing the default partition's
 * absence instead of the CHECK it names is the exact class of rot the three
 * exit codes exist to prevent.
 */
function todayLocalWallDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function logRow(outcome: string, refusalCode: string | null, naturalKey: string): unknown[] {
  return [
    todayLocalWallDate(),
    "T19:00",
    "+12:00",
    AGENT,
    PRINCIPAL,
    "hold_seats",
    outcome,
    refusalCode,
    "epoch_1",
    "boundary",
    naturalKey,
  ];
}

function message(err: unknown): string {
  return String((err as { message?: unknown })?.message ?? err).slice(0, 140);
}
