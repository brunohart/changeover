// resolve_occasions pages in the order its cursor compares. Owner: BIND-001.
//
// The keyset predicate compares instants, so the ORDER BY must too. Named bare,
// `starts_at` in ORDER BY resolves to the select list's RFC 3339 text, and
// across a DST fold text order is not time order: 02:15+12:00 sorts before the
// 02:30+13:00 screening it follows. A caller paging one Occasion at a time was
// served the later one, handed a cursor past the earlier one, and never saw it.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { openDb } from "@changeover/store/db.ts";
import type { Db, QueryResult, Queryable, Row } from "@changeover/store/db.ts";
import { migrate } from "@changeover/store/migrate.ts";
import type { Rfc3339 } from "@changeover/schema/refusal.ts";

import { STORE_OCCASIONS } from "../src/occasions.ts";
import type { Cursor } from "../src/occasions.ts";

const db: Db = await openDb({ driver: "pglite" });
await migrate(db);
after(() => db.close());

test("resolve_occasions serves every Occasion across a DST fold, in time order", async () => {
  // New Zealand leaves daylight time at 03:00 NZDT on 4 April 2027, so 02:00-03:00
  // happens twice. The zone is a POSIX rule, not a tzdata name, so the test
  // needs nothing the substrate might not ship.
  await db.query("set timezone = 'NZST-12NZDT,M9.5.0,M4.1.0/3'");
  const row = (id: string, starts_at: string, wall: string, offset: string) =>
    db.query(
      `insert into occasion (occasion_id, revision, etag, origin, source, showtime_id, seating,
         capacity, availability_mode, starts_at, local_wall, local_wall_offset, document)
       values ($1, 1, $2, 'https://fold.example', 'test', $1, 'allocated', 100, 'count',
         $3::timestamptz, $4, $5, '{}'::jsonb)`,
      [id, "1:" + "A".repeat(43), starts_at, wall, offset],
    );
  await row("occ_fold_nzdt", "2027-04-04T02:30:00+13:00", "2027-04-04T02:30", "+13:00");
  await row("occ_fold_nzst", "2027-04-04T02:15:00+12:00", "2027-04-04T02:15", "+12:00");

  const served: string[] = [];
  let cursor: Cursor | undefined;
  for (let page = 0; page < 5; page++) {
    const rows = await STORE_OCCASIONS.page(db, { limit: 1, after: cursor });
    if (rows.length === 0) break;
    served.push(rows[0]!.occasion_id);
    cursor = { starts_at: rows[0]!.starts_at, occasion_id: rows[0]!.occasion_id };
  }
  assert.deepEqual(served, ["occ_fold_nzdt", "occ_fold_nzst"]);
});

test("a page is read off occasion_page_idx, not sorted out of every Occasion", async () => {
  // The statement STORE_OCCASIONS.page actually sends, captured and explained.
  const sent: { sql: string; params: readonly unknown[] }[] = [];
  const spy: Queryable = {
    query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      sent.push({ sql, params: params ?? [] });
      return db.query<T>(sql, params);
    },
    exec: (sql: string) => db.exec(sql),
  };
  await STORE_OCCASIONS.page(spy, { limit: 201, from: "2027-01-01T00:00:00Z" as Rfc3339 });
  assert.equal(sent.length, 1);

  // Two rows are cheaper to sort than to walk an index, so the planner is asked
  // what it would do at scale: with scans that return rows unordered and sorts
  // both priced out, a Sort survives only where no index yields the order.
  const priced = ["enable_seqscan", "enable_bitmapscan", "enable_sort"];
  for (const g of priced) await db.query(`set ${g} = off`);
  try {
    const plan = await db.query<{ "QUERY PLAN": string }>("explain " + sent[0]!.sql, sent[0]!.params);
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(text, /occasion_page_idx/);
    assert.doesNotMatch(text, /\bSort\b/, text);
  } finally {
    for (const g of priced) await db.query(`reset ${g}`);
  }
});
