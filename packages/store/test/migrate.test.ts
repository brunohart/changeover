// The migration runner. Owner: CORE-001.

import assert from "node:assert/strict";
import { cp, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDb } from "@changeover/store/db.ts";
import {
  MIGRATIONS_DIR,
  MigrationDrift,
  appliedVersions,
  ensureLogPartitions,
  loadMigrations,
  migrate,
  resetHoldStore,
} from "@changeover/store/migrate.ts";
import { HUNDRED_SEAT_HOUSE, seedEstate } from "@changeover/store/fixtures.ts";

async function scratch() {
  return openDb({ driver: "pglite" });
}

test("every migration on disk loads, in lexical order, with a checksum", async () => {
  const migrations = await loadMigrations();
  assert.ok(migrations.length >= 3, "expected at least three migrations");
  assert.deepEqual(
    migrations.map((m) => m.version),
    [...migrations.map((m) => m.version)].sort(),
    "migrations must apply in lexical order",
  );
  for (const m of migrations) {
    assert.match(m.checksum, /^[A-Za-z0-9_-]{43}$/, `${m.version} checksum is not base64url sha256`);
    assert.ok(m.sql.length > 0, `${m.version} is empty`);
  }
});

test("a fresh database reaches head, and a second run applies nothing", async () => {
  const db = await scratch();
  try {
    const first = await migrate(db);
    assert.ok(first.applied.includes("0001_hold_store"));
    assert.ok(first.applied.includes("0002_access_log"));
    assert.ok(first.applied.includes("0003_roles_and_grants"));
    assert.deepEqual(first.alreadyApplied, []);

    const second = await migrate(db);
    assert.deepEqual(second.applied, [], "a second migrate must be a no-op");
    assert.deepEqual(second.alreadyApplied, first.applied);
    assert.deepEqual(await appliedVersions(db), first.applied.slice().sort());
  } finally {
    await db.close();
  }
});

test("an applied migration that has been EDITED is a hard failure, never a shrug", async () => {
  const dir = await mkdtemp(join(tmpdir(), "changeover-migrations-"));
  await cp(MIGRATIONS_DIR, dir, { recursive: true });
  const db = await scratch();
  try {
    await migrate(db, { dir });
    const target = join(dir, "0001_hold_store.sql");
    await writeFile(target, (await readFile(target, "utf8")) + "\n-- a later hand\n");
    await assert.rejects(() => migrate(db, { dir }), MigrationDrift);
  } finally {
    await db.close();
  }
});

test("withRoles: false skips the grants, and says so by leaving the role absent", async () => {
  const db = await scratch();
  try {
    const result = await migrate(db, { withRoles: false });
    assert.ok(result.applied.includes("0001_hold_store"));
    assert.ok(!result.applied.includes("0003_roles_and_grants"), "0003 must be skipped");
    const roles = await db.query<{ n: string }>(
      "select count(*)::text as n from pg_roles where rolname = $1",
      ["changeover_agent"],
    );
    assert.equal(Number(roles.rows[0]?.n), 0, "no role should exist when roles were skipped");
  } finally {
    await db.close();
  }
});

test("the log has month partitions ahead of it, and ensuring them twice creates nothing", async () => {
  const db = await scratch();
  try {
    const from = new Date(Date.UTC(2027, 0, 15));
    await migrate(db, { logPartitionsFrom: from, logPartitionMonths: 2 });
    const again = await ensureLogPartitions(db, from, 2);
    assert.deepEqual(again.created, [], "partitions must not be recreated");
    assert.deepEqual(again.existing, ["access_log_2027_01", "access_log_2027_02"]);

    const parts = await db.query<{ relname: string }>(
      "select c.relname from pg_class c join pg_inherits i on i.inhrelid = c.oid" +
        " join pg_class p on p.oid = i.inhparent where p.relname = $1 order by c.relname",
      ["access_log"],
    );
    const names = parts.rows.map((r) => r.relname);
    assert.ok(names.includes("access_log_default"), "a DEFAULT partition must always exist");
    assert.ok(names.includes("access_log_2027_01"));
  } finally {
    await db.close();
  }
});

test("a partition created by the runner is owned by changeover_retention, not by the migrator", async () => {
  const db = await scratch();
  try {
    await migrate(db, { logPartitionsFrom: new Date(Date.UTC(2027, 5, 1)), logPartitionMonths: 1 });
    const owner = await db.query<{ owner: string }>(
      "select pg_get_userbyid(c.relowner) as owner from pg_class c" +
        " join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2",
      ["changeover_log", "access_log_2027_06"],
    );
    assert.equal(owner.rows[0]?.owner, "changeover_retention", "the role that may drop it must own it");
  } finally {
    await db.close();
  }
});

test("resetHoldStore empties the hold store and leaves the append-only log alone", async () => {
  const db = await scratch();
  try {
    await migrate(db);
    await seedEstate(db, HUNDRED_SEAT_HOUSE);
    await db.query(
      "insert into changeover_log.access_log (local_wall_date, local_wall, local_wall_offset, observed_at," +
        " agent_id, principal_scope, verb, outcome, site_epoch_id, record_source, natural_key, input_watermark)" +
        " values ($1::date, $1 || $2, $3, clock_timestamp(), $4, $5, $6, $7, $8, $9, $10, clock_timestamp())",
      [
        new Date().toISOString().slice(0, 10),
        "T19:00",
        "+12:00",
        "agt_reset_test",
        "ppid_reset_test",
        "get_hold",
        "ok",
        "epoch_1",
        "boundary",
        "nk-reset-1",
      ],
    );

    await resetHoldStore(db);

    const holds = await db.query<{ n: string }>("select count(*)::text as n from hold");
    assert.equal(Number(holds.rows[0]?.n), 0);
    const estate = await db.query<{ n: string }>("select count(*)::text as n from occasion_seat");
    assert.equal(Number(estate.rows[0]?.n), 100, "the estate is not the hold store and must survive");
    const log = await db.query<{ n: string }>("select count(*)::text as n from changeover_log.access_log");
    assert.equal(Number(log.rows[0]?.n), 1, "a test helper must never quietly empty an append-only log");
  } finally {
    await db.close();
  }
});
