// The database contract. Every CHANGEOVER package codes against `Db` and
// nothing below it: no package outside this file imports `@electric-sql/pglite`
// or `pg` directly, because the two drivers disagree — about how a SQLSTATE
// reaches you, about how many connections exist, and about whether the word
// "concurrent" means anything at all — and that disagreement is exactly what a
// commitment boundary must not be built on top of.
//
// Owner: CONTRACT-000. This file is frozen. If you need something it does not
// expose, say so in your return; do not edit it.

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One row, keyed by column name. Values arrive driver-typed; narrow at the edge. */
export type Row = Record<string, unknown>;

export interface QueryResult<T extends Row = Row> {
  readonly rows: T[];
  /** Rows returned by a SELECT, or rows affected by an INSERT/UPDATE/DELETE. */
  readonly rowCount: number;
}

/** Anything you can run a statement against: a `Db`, or a transaction handle. */
export interface Queryable {
  /**
   * One parameterised statement. `$1`-style placeholders under both drivers.
   * Never interpolate a value into `sql`; never send more than one statement.
   */
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /**
   * One or more statements, no parameters, results discarded. Migrations and
   * DDL only. `exec` is where a semicolon-separated script belongs; `query` is
   * where user-influenced input belongs. They are not interchangeable.
   */
  exec(sql: string): Promise<void>;
}

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  /** Default "read committed" — Postgres's own default, stated rather than assumed. */
  readonly isolation?: IsolationLevel;
  readonly readOnly?: boolean;
  /**
   * `SET LOCAL ROLE` for the life of the transaction. The identifier is
   * validated against /^[a-z_][a-z0-9_]{0,62}$/ and rejected otherwise: this is
   * the one place a name reaches SQL uninterpolatable-by-parameter, so it is
   * the one place that has to be paranoid.
   */
  readonly role?: string;
}

export type DriverName = "pglite" | "pg";

export interface Db extends Queryable {
  /**
   * Runs `fn` inside one transaction. Commits on return, rolls back on throw,
   * and rethrows. The handle passed to `fn` is valid only for that call — do
   * not close over it, do not return it.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T>;
  readonly driver: DriverName;
  /**
   * True only when this Db can hold more than one connection open at once.
   * FALSE for PGlite, which is single-connection and in-process: lock
   * contention, 40P01 deadlock detection and any "N concurrent callers" claim
   * are NOT observable there. A proof that needs true concurrency checks this
   * and exits 2 when it is false. It does not simulate.
   */
  readonly concurrent: boolean;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Reading a failure
// ---------------------------------------------------------------------------

/**
 * The SQLSTATE of a thrown database error, or undefined if it carries none.
 *
 * The drivers differ and the difference has already cost this build once:
 *   - node-postgres throws a `DatabaseError` with `code` on the error itself.
 *   - PGlite throws an error whose SQLSTATE may sit on `code`, or nested under
 *     `cause`, depending on where in the wasm boundary the failure surfaced.
 * Read it through this function. Never through `err.code`, and never by
 * matching on a message: `String(err).includes("duplicate key")` is a check
 * that passes in English and fails in the field.
 */
export function sqlstate(err: unknown): string | undefined {
  for (const candidate of unwind(err)) {
    const code = (candidate as { code?: unknown }).code;
    // A SQLSTATE is exactly five characters from [0-9A-Z]. Node's own errno
    // strings (ENOENT, ECONNREFUSED) also land on `code`, so shape-check it.
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/**
 * The constraint name behind an integrity failure, or undefined.
 * CORE-002 branches on the CONSTRAINT, never on the bare 23505: two partial
 * unique indexes both raise 23505 and they mean entirely different refusals.
 */
export function constraintName(err: unknown): string | undefined {
  for (const candidate of unwind(err)) {
    const name = (candidate as { constraint?: unknown }).constraint;
    if (typeof name === "string" && name.length > 0) return name;
    // PGlite surfaces the field under its wire-protocol letter in some paths.
    const detail = (candidate as { constraintName?: unknown }).constraintName;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return undefined;
}

/** True when `err` is a serialization failure or a deadlock — 40001 / 40P01. */
export function isSerializationFailure(err: unknown): boolean {
  const code = sqlstate(err);
  return code === "40001" || code === "40P01";
}

export const SQLSTATE = {
  unique_violation: "23505",
  check_violation: "23514",
  foreign_key_violation: "23503",
  not_null_violation: "23502",
  serialization_failure: "40001",
  deadlock_detected: "40P01",
  insufficient_privilege: "42501",
  undefined_table: "42P01",
  lock_not_available: "55P03",
} as const;

function* unwind(err: unknown): Generator<object> {
  let node: unknown = err;
  for (let depth = 0; depth < 8; depth++) {
    if (node === null || typeof node !== "object") return;
    yield node as object;
    node = (node as { cause?: unknown }).cause;
  }
}

// ---------------------------------------------------------------------------
// Cannot prove
// ---------------------------------------------------------------------------

/** The exit code that means "we could not reach the thing under test". */
export const EXIT_CANNOT_PROVE = 2;

export class CannotProve extends Error {
  readonly remedy: string;
  constructor(reason: string, remedy: string) {
    super(reason);
    this.name = "CannotProve";
    this.remedy = remedy;
  }
}

/**
 * For any assertion that needs true concurrency. Returns a multi-connection Db
 * or throws `CannotProve`. There is no third branch, and in particular there is
 * no branch that runs the scenario on one connection and reports a pass.
 */
export async function requireConcurrentDb(): Promise<Db> {
  const url = process.env["CHANGEOVER_PG_URL"];
  if (!url) {
    throw new CannotProve(
      "true concurrency is not observable on PGlite — it is single-connection and in-process, so lock contention and 40P01 cannot occur",
      "set CHANGEOVER_PG_URL to a running Postgres, e.g.\n" +
        "  docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18\n" +
        "  export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover",
    );
  }
  const db = await openPg(url);
  if (!db.concurrent) {
    await db.close();
    throw new CannotProve("CHANGEOVER_PG_URL resolved to a driver that is not multi-connection", "use a real Postgres URL");
  }
  return db;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export interface OpenOptions {
  /** PGlite only. Omit for an in-memory database. */
  readonly dataDir?: string;
  /** Force a driver. Default: pg when CHANGEOVER_PG_URL is set, else pglite. */
  readonly driver?: DriverName;
  readonly url?: string;
  /** pg only. Default 8 — enough for a 200-caller harness with batching. */
  readonly poolSize?: number;
}

/**
 * The default door. PGlite unless CHANGEOVER_PG_URL is set, so every proof that
 * does not need concurrency runs on a clean clone with no container, no daemon
 * and no credentials — and the same code runs against real Postgres the moment
 * one exists.
 */
export async function openDb(options: OpenOptions = {}): Promise<Db> {
  const url = options.url ?? process.env["CHANGEOVER_PG_URL"];
  const driver = options.driver ?? (url ? "pg" : "pglite");
  if (driver === "pg") {
    if (!url) throw new Error("openDb: driver 'pg' requires a url or CHANGEOVER_PG_URL");
    return openPg(url, options.poolSize);
  }
  return openPglite(options.dataDir);
}

const ROLE_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

function beginPrelude(options: TransactionOptions | undefined): string[] {
  const statements: string[] = [];
  if (options?.isolation) statements.push(`SET TRANSACTION ISOLATION LEVEL ${isolationSql(options.isolation)}`);
  if (options?.readOnly) statements.push("SET TRANSACTION READ ONLY");
  if (options?.role !== undefined) {
    if (!ROLE_IDENT.test(options.role)) throw new Error(`openDb: refusing unsafe role identifier ${JSON.stringify(options.role)}`);
    statements.push(`SET LOCAL ROLE ${options.role}`);
  }
  return statements;
}

function isolationSql(level: IsolationLevel): string {
  if (level === "read committed") return "READ COMMITTED";
  if (level === "repeatable read") return "REPEATABLE READ";
  return "SERIALIZABLE";
}

// --- PGlite -----------------------------------------------------------------

export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;

  const wrap = (target: { query: (sql: string, params?: unknown[]) => Promise<unknown>; exec: (sql: string) => Promise<unknown> }): Queryable => ({
    async query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      const result = (await target.query(sql, params ? [...params] : undefined)) as {
        rows?: T[];
        affectedRows?: number;
      };
      const rows = result.rows ?? [];
      return { rows, rowCount: result.affectedRows ?? rows.length };
    },
    async exec(sql: string): Promise<void> {
      await target.exec(sql);
    },
  });

  const top = wrap(pg);
  return {
    driver: "pglite",
    concurrent: false,
    query: top.query,
    exec: top.exec,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T> {
      const prelude = beginPrelude(options);
      const out = await pg.transaction(async (tx) => {
        for (const statement of prelude) await tx.exec(statement);
        return fn(wrap(tx));
      });
      return out as T;
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

// --- node-postgres ----------------------------------------------------------

export async function openPg(url: string, poolSize = 8): Promise<Db> {
  const pgModule = await import("pg");
  const Pool = pgModule.default?.Pool ?? pgModule.Pool;
  const pool = new Pool({ connectionString: url, max: poolSize });

  const wrap = (target: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }): Queryable => ({
    async query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      const result = await target.query(sql, params ? [...params] : undefined);
      const rows = result.rows as T[];
      return { rows, rowCount: result.rowCount ?? rows.length };
    },
    async exec(sql: string): Promise<void> {
      await target.query(sql);
    },
  });

  return {
    driver: "pg",
    concurrent: true,
    query: (sql, params) => wrap(pool).query(sql, params),
    exec: (sql) => wrap(pool).exec(sql),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T> {
      const prelude = beginPrelude(options);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const statement of prelude) await client.query(statement);
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* the original failure is the one that matters */
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
