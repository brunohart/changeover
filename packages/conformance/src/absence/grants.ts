/**
 * C-ABSENCE.3 — Lock 3, the kill test. Run, never read.
 * Owner: TEST-004.
 *
 * `cinema-ops-platform` proves absence-not-redaction on a **read** path and
 * leaves an open question in its own documentation: does the triple lock
 * generalise to a **write** path? This module is the answer, and it only counts
 * because it is executed. An assertion lifted out of `0003_roles_and_grants.sql`
 * would prove what somebody wrote; the gap between the `GRANT` a migration
 * declares and the privilege a live cluster enforces is where every privilege
 * bug this class exists to catch actually lives.
 *
 * SPEC.md §5.1 phrases Lock 3 as "no `INSERT` on payment tables, no `SELECT` on
 * customer tables". **There are no payment tables and no customer tables** — the
 * strongest possible form of that requirement, and one a kill test cannot
 * execute against. So the claim is made in two halves, and both are needed:
 *
 *   1. `noSuchTable` — the physical schema declares no table or column named for
 *      settlement or for a person. Absence by construction.
 *   2. `KILL_TESTS` — every write the boundary must not make against the tables
 *      that *do* exist is attempted for real, under `SET LOCAL ROLE`, and must
 *      raise `42501 insufficient_privilege`.
 *
 * Every attempt runs inside a transaction that is **always rolled back**, by
 * throwing after a statement that unexpectedly succeeded. A kill test whose
 * failure mode is to leave the row it was not supposed to write is a kill test
 * that damages the thing it audits.
 */

import type { Db, Queryable } from "@changeover/store/db.ts";
import { SQLSTATE, sqlstate } from "@changeover/store/db.ts";
import { PERSONAL_COLUMN, SETTLEMENT_MEMBER } from "./patterns.ts";

export interface KillTest {
  /** Stable id, so a failure names one attempt rather than a line number. */
  readonly id: string;
  readonly role: string;
  readonly sql: string;
  /** The rule this attempt would break if the database let it through. */
  readonly why: string;
}

/**
 * The writes the boundary must be unable to make. Chosen so that each one, if it
 * succeeded, would falsify a stated property rather than merely be untidy.
 */
export const KILL_TESTS: readonly KillTest[] = Object.freeze([
  {
    id: "insert_occasion",
    role: "changeover_agent",
    sql: "insert into occasion (occasion_id) values ('occ_kill_test')",
    why: "W3 — the estate is the exhibitor's system of record; a boundary that can write it can manufacture the availability it then reports",
  },
  {
    id: "insert_occasion_seat",
    role: "changeover_agent",
    sql: "insert into occasion_seat (occasion_id, seat_id) values ('occ_kill_test', 'A:1')",
    why: "W3 — the same, one level down: the seat inventory is not the boundary's to invent",
  },
  {
    id: "update_occasion",
    role: "changeover_agent",
    sql: "update occasion set occasion_id = occasion_id",
    why: "W3 — the boundary cannot withdraw or rewrite a screening it did not publish",
  },
  {
    id: "delete_hold",
    role: "changeover_agent",
    sql: "delete from hold",
    why: "M2 — a Hold reports its seats as granted for the life of the record, so the boundary cannot end that life",
  },
  {
    id: "update_hold_floor_ms",
    role: "changeover_agent",
    sql: "update hold set floor_ms = 1",
    why: "T1/T3 — the floor is immovable by grant, not by the absence of a code path that moves it",
  },
  {
    id: "update_hold_granted_at",
    role: "changeover_agent",
    sql: "update hold set granted_at = clock_timestamp()",
    why: "T3 — a movable grant instant is a movable floor wearing a different column name",
  },
  {
    id: "update_hold_agent_id",
    role: "changeover_agent",
    sql: "update hold set agent_id = 'agent_someone_else'",
    why: "C-AUTHZ — a Hold that can change hands by UPDATE has no owner",
  },
  {
    id: "update_access_log",
    role: "changeover_agent",
    sql: "update changeover_log.access_log set outcome = 'ok'",
    why: "A3 — the log is append-only by grant; a refusal that can be rewritten to a success is not evidence",
  },
  {
    id: "delete_access_log",
    role: "changeover_agent",
    sql: "delete from changeover_log.access_log",
    why: "P2/A3 — erasure is honoured by destroying the site epoch key and detaching the partition, never by deleting a row",
  },
  {
    id: "retention_reads_hold",
    role: "changeover_retention",
    sql: "select hold_id from hold",
    why: "A3 — the role that can destroy the record of the boundary holds nothing else, so it cannot read the boundary either",
  },
  {
    id: "retention_reads_occasion",
    role: "changeover_retention",
    sql: "select occasion_id from occasion",
    why: "A3 — the same, stated of the estate: USAGE on schema public is closed and re-opened to exactly one role",
  },
]);

/** Thrown to force a rollback when a statement that should have been denied succeeded. */
const ROLLBACK_SENTINEL = "changeover:c-absence:rollback";

export interface KillOutcome {
  readonly id: string;
  /** The SQLSTATE the cluster raised, or `undefined` when the statement succeeded. */
  readonly sqlstate: string | undefined;
  /** True only when the cluster raised 42501. */
  readonly denied: boolean;
  /** True when the statement was allowed through — the failure this class exists to catch. */
  readonly allowed: boolean;
  readonly note: string;
}

export async function runKillTest(db: Db, test: KillTest): Promise<KillOutcome> {
  try {
    await db.transaction(
      async (tx: Queryable) => {
        await tx.query(test.sql);
        // It went through. Roll the transaction back before saying so.
        throw new Error(ROLLBACK_SENTINEL);
      },
      { role: test.role },
    );
  } catch (err) {
    if (err instanceof Error && err.message === ROLLBACK_SENTINEL) {
      return {
        id: test.id,
        sqlstate: undefined,
        denied: false,
        allowed: true,
        note: "the statement was permitted and has been rolled back",
      };
    }
    const state = sqlstate(err);
    return {
      id: test.id,
      sqlstate: state,
      denied: state === SQLSTATE.insufficient_privilege,
      allowed: false,
      note: state === undefined ? String((err as Error).message ?? err) : "",
    };
  }
  /* c8 ignore next */
  return { id: test.id, sqlstate: undefined, denied: false, allowed: true, note: "committed" };
}

export interface SchemaName {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string | null;
}

/**
 * Every table and column the boundary's own schemas carry, so that "there is no
 * payment table" is a query rather than a memory.
 */
export async function physicalNames(db: Db): Promise<SchemaName[]> {
  const tables = await db.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name from information_schema.tables
      where table_schema in ('public', 'changeover_log')`,
  );
  const columns = await db.query<{ table_schema: string; table_name: string; column_name: string }>(
    `select table_schema, table_name, column_name from information_schema.columns
      where table_schema in ('public', 'changeover_log')`,
  );
  return [
    ...tables.rows.map((r) => ({ ...r, column_name: null })),
    ...columns.rows.map((r) => ({ ...r })),
  ];
}

export interface NameHit {
  readonly where: string;
  readonly lock: "settlement" | "personal";
}

/** Names that would falsify absence-by-construction. Empty is the whole claim. */
export function nameHits(names: readonly SchemaName[]): NameHit[] {
  const hits: NameHit[] = [];
  for (const n of names) {
    const where =
      n.column_name === null
        ? `${n.table_schema}.${n.table_name}`
        : `${n.table_schema}.${n.table_name}.${n.column_name}`;
    const leaf = n.column_name ?? n.table_name;
    if (SETTLEMENT_MEMBER.test(leaf)) hits.push({ where, lock: "settlement" });
    if (PERSONAL_COLUMN.test(leaf)) hits.push({ where, lock: "personal" });
  }
  return hits;
}
