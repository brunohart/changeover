# `@changeover/store`

The `Db` interface, its two drivers, and the schema.

`src/db.ts` is frozen and owned by CONTRACT-000. Everything else here is CORE-001's, and this file is the handover: what the migrations create, what the grants forbid, and the three places the schema and `SPEC.md` do not agree.

---

## Applying it

```ts
import { openDb } from "@changeover/store/db.ts";
import { migrate } from "@changeover/store/migrate.ts";
import { seedEstate, HUNDRED_SEAT_HOUSE } from "@changeover/store/fixtures.ts";

const db = await openDb();              // PGlite, or pg when CHANGEOVER_PG_URL is set
await migrate(db);                      // idempotent; a second call applies nothing
await seedEstate(db, HUNDRED_SEAT_HOUSE);
```

`migrate(db, options)` applies `src/migrations/*.sql` in lexical order, one transaction per file with its ledger row, and records each in `schema_migration`. **An applied migration whose file has since changed is a `MigrationDrift`, thrown, never swallowed** — a constraint present in the repository and absent from the database is the exact shape of a boundary reporting a property it does not have.

| Option | Default | Why you would change it |
|---|---|---|
| `withRoles` | `true` | `false` where the migrating user cannot `CREATE ROLE`. The append-only log and the immovable floor are **both** carried by `0003`'s grants, so provision them out of band or lose both. |
| `dir` | `MIGRATIONS_DIR` | tests, forks |
| `logPartitionsFrom` / `logPartitionMonths` | now / 3 | pre-create month partitions further ahead |

The migrating role must be a superuser or a member of `changeover_retention`, because `0003` transfers ownership of the log to it.

---

## The tables

Hold store, in `public`. Access log, in `changeover_log`, under separate ownership.

| Table | What a row is | Notes |
|---|---|---|
| `occasion` | one published Occasion | the exhibitor's record (W3). Read-only to `changeover_agent`. |
| `occasion_seat` | one seat in that auditorium | the inventory W1 validates against; `status` is the exhibitor's own (§2.10) |
| `hold` | one Hold, for the life of the record | **no `state` column, ever** |
| `hold_seat` | **a seat is occupied** | deleted by the next contender's reap (ADR-006) |
| `hold_cluster` | **a cluster slot is occupied** | X2's fan-out guard |
| `hold_slot` | **a budget slot is taken** | X1, per `(agent_id, principal_scope, showtime_id)` |
| `idempotency` | one key in scope `(agent_id, principal_scope, verb, key)` | I2, I5, I6, I9 |
| `changeover_log.access_log` | one invocation — ok, refused, error | partitioned by `local_wall_date` (A3) |

**Occupancy is a row, and expiry is not a column.** `hold_seat`, `hold_cluster` and `hold_slot` all work the same way: the row exists while the thing is held, and the next transaction that wants it deletes it under its own locks (L1, L2). Nothing depends on a sweeper. That is why the Hold's own `state` can be derived at every read (M1) and why a Hold past its `expires_at` reports `expired` with no reaper having run.

**`state` on `hold_seat` and `hold_cluster` is seat/cluster occupancy, not the Hold's state.** It is the one discriminator a partial index predicate can be built from, because a predicate must be `IMMUTABLE` and `held_until > now()` is not.

---

## The constraint names, and the one that could not keep its name

`SPEC.md:393` maps a `23505` to a refusal **by constraint name**, and "any other `23505` **MUST NOT** be reported as `seat_contended`". Import the names; do not retype them.

```ts
import { CONSTRAINT } from "@changeover/store/schema.ts";

switch (constraintName(err)) {
  case CONSTRAINT.hold_seat_occupied: /* 409 seat_contended        */ break;
  case CONSTRAINT.hold_cluster_live:  /* 429 cluster_fanout        */ break;
  case CONSTRAINT.hold_slot:          /* 429 hold_budget_exhausted */ break;
  default: throw err;
}
```

> **`CONSTRAINT.hold_slot` is `"hold_slot_taken"`, not `"hold_slot"`.** Postgres puts tables and indexes in one namespace, so a constraint named `hold_slot` on a table named `hold_slot` is `42P07 relation "hold_slot" already exists`. The table keeps the specification's name. **A `switch` written against the literal `"hold_slot"` falls through to `default` and turns a `429 hold_budget_exhausted` into a `500`.**

> **Do not branch on `access_log_ingest` either.** On a partitioned table a unique violation names the *partition's* index (`access_log_2026_08_local_wall_date_record_…`), never the parent constraint, so an equality check silently never matches. Use `isLogIngestConflict(err)`, or write `on conflict (local_wall_date, record_source, natural_key, local_wall_offset) do nothing` and catch nothing at all.

---

## What the grants forbid, and why that is the point

Two `NOLOGIN` roles. An application login role is a member of `changeover_agent`; nothing is a member of `changeover_retention` but the operator who runs retention.

`changeover_agent`:

- **cannot `UPDATE` or `DELETE` the access log.** Not by trigger, not by convention — the privileges are absent, so both are `42501`. Erasure is honoured by destroying the site epoch key (P2) and by detaching the partition (A3).
- **cannot `DELETE` from `hold`.** M2 requires a Hold to report its seats as granted for the life of the record, so the boundary cannot end that life.
- **cannot `UPDATE` `granted_at`, `floor_ms`, `floor_deadline`, `seats`, or any credential column.** The `UPDATE` grant on `hold` is column-level and lists exactly the movable members (`HOLD_UPDATABLE_COLUMNS` in `schema.ts`). There is no extend verb and there is also no `UPDATE` statement that would implement one (T3).
- **cannot write `occasion` or `occasion_seat`.** It reads the exhibitor's record and cannot manufacture the availability it then reports (W3).

`changeover_retention` owns `changeover_log.access_log` and its partitions, so `DETACH PARTITION` and `DROP` are available to it — and has no privilege of any kind on the hold store, so the role that can destroy the record of the boundary cannot operate the boundary. `USAGE` on schema `public` is revoked from `PUBLIC` and granted to `changeover_agent` alone, which is what makes "holding nothing else" true rather than nominal.

`scripts/prove_migrations.sh` attempts every one of those and asserts the `42501`, plus the controls (the agent *can* append to the log, *can* move `expires_at` upward) without which a denial proves only that the role cannot see the table.

---

## The estate

`src/fixtures.ts`. One place an estate comes from, so that the demo, the harness and every `C-*` class contend over the same seats.

```ts
export function seatGrid(options: SeatGridOptions): SeatSeed[];
export function occasionSeedFromDocument(document: unknown, extra?: { cluster?: string | null; seats?: readonly SeatSeed[] }): OccasionSeed;
export function seedEstate(db: Db, estate: Estate): Promise<{ occasions: number; seats: number }>;
export function clearEstate(db: Queryable, estate: Estate): Promise<void>;
export function availableSeatIds(occasion: OccasionSeed, count: number): string[];

export const GOLDEN_ESTATE: Estate;        // the three golden Occasions, ids and etags included
export const HUNDRED_SEAT_HOUSE: Estate;   // ADR-005's own scenario: 100 seats, all free
export const ESTATES: Readonly<Record<string, Estate>>;
```

`seatGrid` is deterministic — an estate that is not makes C-ATOMIC's "exactly 100 succeed" a statement about a coin. `occasionSeedFromDocument` turns `fixtures/golden/*.json` into a seedable estate without this package taking a dependency on the repository's layout; a test asserts `GOLDEN_ESTATE` still agrees with those files, member for member.

`resetHoldStore(db)` empties the hold store for a test and **leaves the access log alone**. A helper that quietly emptied an append-only log would be the first crack in the property this repository asserts.

---

## Where the schema and the specification do not agree

Reported rather than resolved quietly. Each is a defect in `SPEC.md`, not in the implementation, and each needs a ruling.

1. **The seat index key.** `SPEC.md:366` writes `hold_seat_occupied` over `(showtime_id, seat_id)`; `DECISIONS.md` ADR-005 writes it over `(occasion_id, seat_id)`. The index is built on `(occasion_id, seat_id)` — ADR-005's key, the backlog gate's key, and the key `hold_seats` carries on the wire. Where `showtime_ref` is absent, which is every golden fixture, `showtime_id` **is** `occasion_id` and the two spellings are one index. Where a publisher supplies `showtime_ref` and maps several Occasions onto one physical screening they are not, and the specification must say which one the floor is over. Both columns are carried on `hold_seat` and `hold` so either ruling is a one-line migration.

2. **The cluster index cannot live where the specification puts it.** `SPEC.md:367` writes `hold_cluster_live` `ON hold (…) WHERE state IN (…)`. Three lines later, M1–M3 forbid `hold` a `state` column, and a partial index predicate cannot be a function of `now()`. The resolution is the one the specification already uses for `hold_slot`: occupancy is a row, in `hold_cluster`, deleted by the next contending transaction. The index keeps the name `SPEC.md:393` maps to a refusal, so the constraint-name mapping is satisfied verbatim.

3. **`hold_slot` cannot be both a table and a constraint.** As above: `42P07`. The constraint is `hold_slot_taken`.

---

## What this schema does not prove

- **A1 — storage independent of the hold store.** Within one database the strongest available form is a separate schema under separate ownership, which is what `0002` and `0003` build. That exhaustion of one cannot deny writes to the other is a **deployment** property: the log belongs on its own tablespace or its own cluster. No assertion here claims it, and none should — it would need a second connection string and a way to fill one volume, which is an operations test, not a migration test.
- **The floor under concurrency.** Every assertion in `scripts/prove_migrations.sh` is observable on one connection, which is exactly why it can run on PGlite and exit `0` honestly. That `hold_seat_occupied` holds when 200 callers race for 100 seats is C-ATOMIC's claim, it needs a server PGlite cannot be, and TEST-001 exits `2` rather than pretend otherwise.
- **Identical behaviour on a real Postgres.** `scripts/prove_migrations_pg.sh` runs the same assertion set — the same `auditSchema()` function, so the two cannot drift — against Postgres 16+, and exits `2` when `CHANGEOVER_PG_URL` is unset.

One measured note for CORE-002, since it costs a whole PGlite boot to find out: **`clock_timestamp()` advances inside a transaction on PGlite and `now()` stays frozen at transaction start, and `pg_sleep` really sleeps.** So §4.6's distinction — `now()` for the reap, `clock_timestamp()` for the grant — is observable there. What is not observable there is the 600ms of lock waiting that makes it matter.
