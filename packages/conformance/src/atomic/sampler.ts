/**
 * Evidence that the race happened **on the server**. Owner: TEST-001.
 *
 * `raceAll` measures overlap from the client: two hundred calls in flight
 * across a hundred milliseconds of wall clock. That is a fact about this
 * process's event loop, and it stays true whether the server ran two hundred
 * transactions at once or a pool of one ran them end to end while the other
 * hundred and ninety-nine waited their turn — the calls overlap either way,
 * because waiting for a connection is time in flight.
 *
 * Every assertion in .1 would hold under that queue. They would hold for a
 * scenario nobody claimed, and "200 concurrent holds" would be a sentence about
 * the harness rather than about the boundary. So this module asks Postgres
 * itself, from a connection outside the pool under test: how many backends were
 * inside a transaction at the same instant?
 *
 * The race's own pool is tagged with an `application_name` and the sampler
 * counts only that tag. Without it the count would include every other agent's
 * proof script running against the same shared database — the §12 defect class,
 * where a number that is true under PGlite's private cluster becomes somebody
 * else's rows the moment `CHANGEOVER_PG_URL` is set.
 */

import type { Db } from "@changeover/store/db.ts";
import { openDb } from "@changeover/store/db.ts";

export const RACE_APPLICATION_NAME = "changeover_c_atomic";

/** The same URL, tagged, so the sampler can tell this harness's backends from anyone else's. */
export function taggedUrl(url: string, application_name: string = RACE_APPLICATION_NAME): string {
  const separator = url.includes("?") ? "&" : "?";
  return url + separator + "application_name=" + encodeURIComponent(application_name);
}

/** Open the pool the race runs on: tagged under node-postgres, ordinary PGlite otherwise. */
export async function openRaceStore(poolSize: number): Promise<Db> {
  const url = process.env.CHANGEOVER_PG_URL;
  if (url === undefined || url === "") return openDb();
  return openDb({ driver: "pg", url: taggedUrl(url), poolSize });
}

export interface Sampler {
  /** Stop sampling and return the peak number of this harness's backends in a transaction at once. */
  stop(): Promise<number>;
}

/**
 * Poll `pg_stat_activity` until stopped. Returns `null` where there is no
 * second connection to poll from, which is every PGlite run.
 *
 * A backend blocked on a lock is `active` with a `Lock` wait event, so the
 * count includes the contenders that are waiting — which is the interesting
 * half. The sampler swallows its own errors on purpose: a measurement that
 * could fail the assertion it is describing would be a harness defect reported
 * as a boundary defect, and that is the class this repository hunts first.
 */
export async function startSampler(interval_ms = 2): Promise<Sampler | null> {
  const url = process.env.CHANGEOVER_PG_URL;
  if (url === undefined || url === "") return null;
  // Untagged, so the sampler never counts itself.
  const probe = await openDb({ driver: "pg", url, poolSize: 2 });
  let peak = 0;
  let done = false;
  const loop = (async () => {
    while (!done) {
      try {
        const r = await probe.query<{ n: string }>(
          `select count(*)::text as n from pg_stat_activity
            where datname = current_database()
              and application_name = $1
              and state in ('active', 'idle in transaction')`,
          [RACE_APPLICATION_NAME],
        );
        const n = Number(r.rows[0]?.n ?? 0);
        if (n > peak) peak = n;
      } catch {
        /* see the note above */
      }
      await new Promise((resolve) => setTimeout(resolve, interval_ms));
    }
  })();
  return {
    async stop(): Promise<number> {
      done = true;
      await loop;
      await probe.close();
      return peak;
    },
  };
}

/* ── An unreachable server is not a failed floor ───────────────────────────── */

const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  // 57P01 admin shutdown, 57P03 cannot connect now, 53300 too many clients.
  "57P01",
  "57P03",
  "53300",
  "08006",
  "08003",
  "08001",
]);

/**
 * Did this error mean *we could not reach your server*, rather than *your
 * server violated the floor*?
 *
 * Found the hard way, and it was a defect in this harness rather than in the
 * boundary. The `postgres:18` container was started with `--rm`; when it went
 * away mid-suite, every contender came back `ECONNREFUSED`, the tally counted
 * two hundred unclassified faults, and `prove_no_oversell.sh` exited **1**. It
 * reported that CHANGEOVER had overselled a house it had never been asked
 * about. That is the precise inversion the three exit codes exist to prevent,
 * and a red suite that sends someone hunting a race in correct code is worse
 * than an honest `cannot prove`.
 */
export function isUnreachable(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = err;
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const e = cursor as { code?: unknown; errors?: unknown; cause?: unknown };
    if (typeof e.code === "string" && UNREACHABLE.has(e.code)) return true;
    if (Array.isArray(e.errors) && e.errors.some((inner) => isUnreachable(inner))) return true;
    cursor = e.cause;
  }
  return false;
}

export class ServerVanished extends Error {
  constructor(where: string) {
    super(
      `the Postgres at CHANGEOVER_PG_URL stopped answering during ${where}, so nothing was measured`,
    );
    this.name = "ServerVanished";
  }
}

/**
 * Open the race pool and make it prove it is there.
 *
 * `pg.Pool` connects lazily, so a successful `openDb` against a dead server is
 * a handle that will fail at the first statement — several assertions later,
 * dressed as a product failure.
 */
export async function openLiveRaceStore(poolSize: number): Promise<Db> {
  const db = await openRaceStore(poolSize);
  await db.query("select 1");
  return db;
}
