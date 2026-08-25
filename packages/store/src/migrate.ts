// The migration runner. Owner: CORE-001.
//
// It codes against `Db` and nothing below it, so the same migrations apply to
// PGlite on a clean clone and to a real Postgres the moment CHANGEOVER_PG_URL
// is set — which matters more here than in most projects, because half of this
// repository's assertions are only meaningful against a server that can hold
// two connections open at once.
//
// Three properties, in order of how much trouble their absence causes:
//
//   1. A migration is applied exactly once. The ledger is a table, not a file.
//   2. A migration that has been applied and then EDITED is a hard failure, not
//      a shrug. The floor of this design is a set of constraints; a constraint
//      that is present in the repository and absent from the database is the
//      exact shape of a boundary that reports a property it does not have.
//   3. Roles can be skipped, but only by asking. `withRoles: false` is a
//      deliberate act for a deployment whose migrating user cannot CREATE ROLE.
//      There is no fallback that catches the privilege error and carries on.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Db, Queryable } from "./db.ts";

export const MIGRATIONS_DIR: string = join(import.meta.dirname, "migrations");

/** One migration file, as it sits on disk. */
export interface Migration {
  /** The filename without `.sql` — `0001_hold_store`. Sorts lexically. */
  readonly version: string;
  readonly file: string;
  readonly sql: string;
  /** base64url SHA-256 of the file's bytes. Drift detection, not security. */
  readonly checksum: string;
}

export interface MigrateOptions {
  /** Where the .sql files live. Default MIGRATIONS_DIR. For tests and forks. */
  readonly dir?: string;
  /**
   * Apply `0003_roles_and_grants.sql`. Default true. Set false only where the
   * migrating user cannot CREATE ROLE and the two roles are provisioned out of
   * band — and know that the append-only property of the access log and the
   * immovability of the floor are BOTH carried by that file's grants.
   */
  readonly withRoles?: boolean;
  /**
   * Pre-create month partitions for the access log, starting at this instant.
   * Default: the current month. A3 partitions by local_wall date; a row must
   * always have somewhere to land, so a DEFAULT partition exists regardless.
   */
  readonly logPartitionsFrom?: Date;
  /** How many month partitions to ensure. Default 3. */
  readonly logPartitionMonths?: number;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
  readonly logPartitions: PartitionResult;
}

export interface PartitionResult {
  readonly created: readonly string[];
  readonly existing: readonly string[];
  /**
   * Partitions that could not be attached because the DEFAULT partition already
   * holds rows in their range. Reported rather than thrown: it is an
   * operational fact about a live log, not a broken migration.
   */
  readonly blocked: readonly string[];
}

/** Thrown when a file's checksum does not match the ledger. Never swallowed. */
export class MigrationDrift extends Error {
  readonly version: string;
  readonly applied_checksum: string;
  readonly file_checksum: string;
  constructor(version: string, appliedChecksum: string, fileChecksum: string) {
    super(
      `migration ${version} has changed since it was applied ` +
        `(ledger ${appliedChecksum}, file ${fileChecksum}). ` +
        `A constraint present in the repository and absent from the database is a boundary ` +
        `reporting a property it does not have. Roll the change forward as a new migration.`,
    );
    this.name = "MigrationDrift";
    this.version = version;
    this.applied_checksum = appliedChecksum;
    this.file_checksum = fileChecksum;
  }
}

const LEDGER_DDL = `
create table if not exists schema_migration (
  version    text primary key,
  checksum   text not null,
  applied_at timestamptz not null default clock_timestamp()
)`;

/** Every migration on disk, in application order. */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  const out: Migration[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const sql = await readFile(file, "utf8");
    out.push({
      version: name.slice(0, -4),
      file,
      sql,
      checksum: createHash("sha256").update(sql, "utf8").digest("base64url"),
    });
  }
  return out;
}

/** The versions the ledger says are applied, in order. */
export async function appliedVersions(db: Queryable): Promise<string[]> {
  await db.exec(LEDGER_DDL);
  const r = await db.query<{ version: string }>("select version from schema_migration order by version");
  return r.rows.map((row) => row.version);
}

/**
 * Bring the database to the head of `MIGRATIONS_DIR`.
 *
 * Each migration runs inside one transaction with its ledger row, so a failure
 * leaves neither the schema nor the ledger half-written. Postgres DDL is
 * transactional and this is the reason to care that it is.
 */
export async function migrate(db: Db, options: MigrateOptions = {}): Promise<MigrateResult> {
  const withRoles = options.withRoles ?? true;
  const all = await loadMigrations(options.dir);
  const wanted = all.filter((m) => withRoles || !m.version.includes("roles"));

  await db.exec(LEDGER_DDL);
  const ledger = await db.query<{ version: string; checksum: string }>(
    "select version, checksum from schema_migration",
  );
  const seen = new Map(ledger.rows.map((r) => [r.version, r.checksum]));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const m of wanted) {
    const previous = seen.get(m.version);
    if (previous !== undefined) {
      if (previous !== m.checksum) throw new MigrationDrift(m.version, previous, m.checksum);
      alreadyApplied.push(m.version);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query("insert into schema_migration (version, checksum, applied_at) values ($1, $2, clock_timestamp())", [
        m.version,
        m.checksum,
      ]);
    });
    applied.push(m.version);
  }

  const logPartitions = (await hasAccessLog(db))
    ? await ensureLogPartitions(db, options.logPartitionsFrom, options.logPartitionMonths)
    : { created: [], existing: [], blocked: [] };

  return { applied, alreadyApplied, logPartitions };
}

async function hasAccessLog(db: Queryable): Promise<boolean> {
  const r = await db.query<{ n: string }>(
    "select count(*)::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace " +
      "where n.nspname = 'changeover_log' and c.relname = 'access_log'",
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}

/**
 * Create month partitions for the access log ahead of the rows that need them.
 *
 * A3 partitions by local_wall date and retires whole partitions rather than
 * deleting rows. The DEFAULT partition in 0002 guarantees a write always lands
 * — A2 makes the log fail-closed for write verbs, so a missing partition would
 * deny `release_hold` and strand seats — but a default partition holding a
 * month's rows is a month that cannot be detached, so real deployments call
 * this ahead of time.
 *
 * The partition is owned by `changeover_retention` on creation, because the
 * role that may drop it must be the role that owns it.
 */
export async function ensureLogPartitions(
  db: Db,
  from: Date = new Date(),
  months = 3,
): Promise<PartitionResult> {
  const created: string[] = [];
  const existing: string[] = [];
  const blocked: string[] = [];
  const retention = await roleExists(db, "changeover_retention");

  for (let i = 0; i < months; i++) {
    const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    const end = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i + 1, 1));
    const name = `access_log_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
    const present = await db.query<{ n: string }>(
      "select count(*)::text as n from pg_class c join pg_namespace s on s.oid = c.relnamespace " +
        "where s.nspname = 'changeover_log' and c.relname = $1",
      [name],
    );
    if (Number(present.rows[0]?.n ?? 0) > 0) {
      existing.push(name);
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        await tx.exec(
          `create table changeover_log.${name} partition of changeover_log.access_log ` +
            `for values from ('${iso(start)}') to ('${iso(end)}')` +
            (retention ? `; alter table changeover_log.${name} owner to changeover_retention` : ""),
        );
      });
      created.push(name);
    } catch {
      // The DEFAULT partition already holds rows in this range. Postgres will
      // not attach over them and neither will this: the rows are real.
      blocked.push(name);
    }
  }
  return { created, existing, blocked };
}

async function roleExists(db: Queryable, name: string): Promise<boolean> {
  const r = await db.query<{ n: string }>("select count(*)::text as n from pg_roles where rolname = $1", [name]);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Empty the hold store, leaving the estate and the schema in place.
 *
 * For tests and for `changeover demo`, never for a deployment: it is a TRUNCATE
 * and it requires ownership, which `changeover_agent` deliberately does not
 * have. The access log is NOT touched — it is append-only, and a test helper
 * that quietly emptied it would be the first crack in the property this
 * repository is asserting.
 */
export async function resetHoldStore(db: Queryable): Promise<void> {
  await db.exec("truncate table hold, hold_seat, hold_cluster, hold_slot, idempotency restart identity cascade");
}
