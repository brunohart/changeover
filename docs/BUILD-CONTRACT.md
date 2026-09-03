# CHANGEOVER — Build Contract

**Status** Binding for the `build/core-v0.1` increment · **Written** 2026-08-25 · **Owner** CONTRACT-000
**Toolchain verified on** Node v24.13.1 · npm 11.8.0 · TypeScript 5.9.3 · PGlite 0.5.7 (PostgreSQL 18.3, wasm)

---

## 0 · How to use this document

Read **this**, not the specification, unless a section here sends you there. `SPEC.md` is ~15,000 words across 12 sections and reading it end to end is the single largest waste of context available to you. This document exists so that twenty-five agents do not each invent a different convention and then discover, at integration, that the disagreement is unresolvable.

**The specification is still the authority.** Where this contract and `SPEC.md` disagree, the specification wins and the disagreement is a defect in this document — say so in your return and the integrator amends it. Nobody but the integrator edits this file.

### Read only the lines you need

```bash
cd /Users/brunohart/changeover
sed -n '303,336p' SPEC.md            # §4.3 TTL semantics + §4.4 Clock
grep -n '^#\{1,3\} ' SPEC.md         # re-derive the section map
```

| § | Lines | What is there |
|---|---|---|
| 0 Conventions | 12–26 | BCP 14, RFC 3339, integer-ms durations, the rule-letter legend |
| 1 Scope | 27–46 | In scope, permanently out of scope, the gap |
| 2.2 Occasion | 53–91 | The Occasion document, **Z3** |
| 2.3 Non-substitutability | 92–141 | Authored rules, **E1–E3**, **S1–S4** |
| 2.4 PROJECTION_0_1 | 142–153 | The closed projection. Frozen. |
| 2.5 Hold policy | 154–174 | Every published limit and its default |
| 2.6 Hold | 175–200 | The Hold document, **Z2**, **D4** |
| 2.7 Refusal | 201–211 | Refusal shape, `remediation` enum, the `detail` oneOf |
| 2.9 / 2.10 | 220–229 | Capability document, seat map |
| 3.2 Class register | 245–250 | 2026.1, append-only |
| 3.3 Origin authority | 251–262 | **O1–O3**, delegation |
| 4.1 The verbs | 271–283 | Five verbs, and the one that is missing |
| 4.2 Call sequence | 284–302 | The happy path |
| 4.3 TTL semantics | 303–327 | **T1–T7** |
| 4.4 Clock | 328–336 | **K1–K6** |
| 4.5 Idempotency | 337–353 | **I1–I9** |
| 4.6 Contention & locking | 354–400 | **W1–W4**, **L1–L2**, **N1**, **M1–M3** |
| 4.7 Exhaustion | 401–416 | **X0–X6** |
| 4.8 Hand-off / release | 417–426 | **HO1–HO2**, **R1–R3** |
| 4.9 State machine | 427–456 | **Z1**, **G1–G2**, the transition table |
| 4.10 The claim | 457–476 | **CL1–CL5** |
| 5.3 Injection | 496–508 | **PR1–PR3**, **Q1** |
| 5.4 Access log | 509–524 | **P1–P3**, **A1–A4** |
| 5.5 intent_digest | 525–533 | **D1–D3** |
| 6.2 MCP binding | 546–557 | Tools, cacheability, InputRequiredResult |
| 6.3 HTTP binding | 558–622 | Nine routes, header contract, **the refusal code table at 581–613** |
| 7 Conformance | 623–658 | Every class, and the exit-2 doctrine |
| 8 Versioning | 659–671 | **V1–V8** |
| 9 Worked example | 672–753 | A complete run, end to end |

### Every normative rule, indexed to its line

Do not grep for these. They are here.

```
T   T1@315 T2@317 T3@318 T4@319 T5@320 T6@321 T7@322
K   K1@330 K2@331 K3@332 K4@333 K5@334 K6@335
I   I1@341 I2@342 I3@343 I4@344 I5@346 I6@347 I7@348 I8@349 I9@350
L   L1@374 L2@375                 N   N1@376
G   G1@430 G2@431                 M   M1@397 M2@398 M3@399
S   S1@135 S2@136 S3@137 S4@138   E   E1@116 E2@117 E3@118
X   X0@405 X1@406 X2@407 X3@408 X4@409 X5@410 X6@411
Z   Z3@86  Z2@199  Z1@429         O   O1@255 O2@256 O3@257
HO  HO1@419 HO2@420               R   R1@421 R2@422 R3@423
CL  CL1@461 CL2@462 CL3@463 CL4@464 CL5@465
W   W1@358 W2@359 W3@360 W4@361   P   P1@515 P2@516 P3@517
D   D4@197 D1@527 D2@528 D3@529   A   A1@518 A2@519 A3@520 A4@521
PR  PR1@503 PR2@504 PR3@505       Q   Q1@506
V   V1@661 V2@662 V3@663 V4@664 V5@665 V6@666 V7@667 V8@668
```

---

## 1 · The package map

npm **workspaces**, `packages/*`. pnpm is not installed and `pnpm-workspace.yaml` has been deleted. Wherever the backlog says `pnpm test X`, it means `node --test packages/<pkg>/test/X*.test.ts`.

| Package | Directory | Purpose |
|---|---|---|
| `@changeover/schema` | `packages/schema` | Compiled ajv validators for the nine frozen schemas; the wire types; the PROJECTION_0_1 projector and etag minting used **by the implementation**; the closed refusal taxonomy. Everything imports this. |
| `@changeover/store` | `packages/store` | `db.ts` — the `Db` interface and both drivers. The migrations, and nothing else. |
| `@changeover/core` | `packages/core` | The five verbs. Guards, sorted locking, derived state, idempotency, budgets, hand-off, claim, access log. No transport, no HTTP status, no JSON-RPC. |
| `@changeover/semantics` | `packages/semantics` | Policy authoring, transitive closure of substitution edges, `maximalAntichain`. |
| `@changeover/http` | `packages/http` | The HTTP binding over `node:http`. Nine routes, RFC 9457 `application/problem+json`, the header contract. |
| `@changeover/mcp` | `packages/mcp` | The MCP binding (2026-07-28). Exactly five tools. |
| `@changeover/adapter-reference` | `packages/adapter-reference` | The authoritative in-memory reference adapter. Profile 1, `hold_basis: system_of_record`. |
| `@changeover/conformance` | `packages/conformance` | The harness: one module per conformance class, the concurrency rig, the dated JSON report. |
| `changeover` | `packages/cli` | The `changeover` command: `lint`, `derive`, `demo`, `conform`, `probe`. |
| `@changeover/toolchain-check` | `packages/toolchain-check` | Regression guard for the toolchain itself. Do not extend it; do not delete it. |

Non-package trees, at the repository root: `schemas/` (frozen), `fixtures/` (golden frozen, new subdirectories permitted), `register/` (frozen, append-only), `scripts/` (proof scripts), `corpus/` (CORPUS-001), `docs/`.

### How a package imports another package

Every workspace package declares `"exports": { "./*": "./src/*" }`. There are **no barrel files** and there will be none: `src/index.ts` is a shared file, and a shared file across twenty-five agents is a merge conflict with a countdown on it. Import the exact module, with its `.ts` extension:

```ts
import { openDb, sqlstate, SQLSTATE } from "@changeover/store/db.ts";
import { Refusal } from "@changeover/schema/refusal.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
```

Relative imports inside one package also carry `.ts`:

```ts
import { guardOrder } from "./guards.ts";
```

### Where a registry would otherwise be a shared file

Two places need "a list of things" and in both the list is **the filesystem**, discovered at runtime. Adding an entry is adding a file. Nobody edits a table.

- **CLI commands** — `packages/cli/src/bin.ts` dispatches with `await import(\`./commands/${name}.ts\`)`. Add `src/commands/<name>.ts`; touch nothing else.
- **Conformance classes** — `packages/conformance/src/run.ts` reads `src/classes/` and imports each module. Add `src/classes/c-<name>.ts` exporting the class contract in §4; touch nothing else.

---

## 2 · The file ownership table

**One owner per path.** If you need something inside another item's glob, you do not edit it — you state the need in your return and the integrator resolves it. A file edited by two agents is a file that has been destroyed by two agents.

Paths are repository-relative to `/Users/brunohart/changeover`.

| Item | Owns (exclusively) | Must never touch |
|---|---|---|
| **CONTRACT-000** *(done)* | `package.json` · `package-lock.json` · `tsconfig.json` · `.gitignore` · `docs/BUILD-CONTRACT.md` · `packages/*/package.json` · `packages/store/src/db.ts` · `packages/toolchain-check/**` | everything else |
| **CORE-001** | `packages/store/src/migrations/**` · `packages/store/src/migrate.ts` · `scripts/prove_migrations.sh` | `packages/store/src/db.ts` (frozen); anything under `packages/core/` |
| **CORE-008** | `packages/schema/src/**` · `packages/schema/test/**` · `scripts/prove_refusals_closed.sh` | `schemas/**` (frozen) · `scripts/lib/**` |
| **SPEC-007** | `packages/semantics/src/policy.ts` · `src/lint.ts` · `src/derive.ts` · `src/closure.ts` · `packages/cli/src/bin.ts` · `packages/cli/src/commands/lint.ts` · `commands/derive.ts` · `scripts/lib/closure-oracle.mjs` · `fixtures/policy/**` · `scripts/prove_policy_closure.sh` | `scripts/lib/{project,members,extract-json-blocks}.mjs` (frozen) · `packages/semantics/src/antichain.ts` |
| **SPEC-008** | `packages/semantics/src/antichain.ts` · `src/poset.ts` · `packages/semantics/test/**` · `scripts/prove_antichain.sh` | every SPEC-007 file above |
| **CORPUS-001** | `corpus/**` · `scripts/prove_corpus_cited.sh` | everything outside `corpus/` |
| **CORE-002** | `packages/core/src/hold-seats.ts` · `src/guards.ts` · `src/locking.ts` · `src/clock.ts` · `src/reap.ts` · `scripts/prove_guard_order.sh` · `prove_lock_order.sh` · `prove_grant_clock.sh` | every other `packages/core/src/*.ts` |
| **CORE-003** | `packages/core/src/derived.ts` · `src/get-hold.ts` · `src/release.ts` · `src/read-token.ts` · `scripts/prove_derived_state.sh` · `prove_release_total.sh` | `src/hold-seats.ts` · `src/clock.ts` · every other core module |
| **CORE-005** | `packages/core/src/idempotency.ts` · `scripts/prove_idempotent.sh` | every other core module |
| **CORE-006** | `packages/core/src/budgets.ts` · `src/principal.ts` · `scripts/prove_no_fanout.sh` | every other core module |
| **CORE-007** | `packages/core/src/access-log.ts` · `src/hmac.ts` · `scripts/prove_access_log.sh` | every other core module; `packages/store/src/migrations/**` (ask CORE-001 for a column) |
| **CORE-004** | `packages/core/src/handoff.ts` · `src/claim.ts` · `scripts/prove_claim_prefetch_safe.sh` | every other core module |
| **BIND-001** | `packages/http/src/**` · `packages/http/test/**` · `scripts/prove_http_binding.sh` | `packages/core/**` · `packages/schema/**` |
| **BIND-002** | `packages/mcp/src/**` · `packages/mcp/test/**` · `scripts/prove_digest_parity.sh` · `prove_mcp_surface.sh` | `packages/http/**` · `packages/core/**` |
| **ADAPT-001** | `packages/adapter-reference/src/**` · `packages/adapter-reference/test/**` | `packages/core/**` |
| **DEMO-001** | `packages/cli/src/commands/demo.ts` · `packages/cli/src/demo/**` · `fixtures/demo/**` · `scripts/prove_cold_start.sh` | `packages/cli/src/bin.ts` (SPEC-007) · every other command file |
| **TEST-001** | `packages/conformance/src/harness.ts` · `src/concurrency.ts` · `src/classes/c-atomic.ts` · `scripts/prove_no_oversell.sh` | every other `src/classes/*.ts` |
| **TEST-002** | `packages/conformance/src/classes/c-budget.ts` · `c-fanout.ts` | `src/harness.ts` (TEST-001) · every other class module |
| **TEST-003** | `src/classes/c-idempotent.ts` · `c-release.ts` · `c-orphan.ts` · `scripts/prove_expiry_without_sweeper.sh` | `src/harness.ts` · every other class module |
| **TEST-004** | `src/classes/c-absence.ts` · `scripts/prove_write_path_pii_absent.sh` | `schemas/**` · `scripts/prove_no_settlement_verb.sh` (frozen) · `scripts/lib/members.mjs` (frozen) |
| **TEST-005** | `src/classes/c-inject.ts` · `c-pii-ingest.ts` · `fixtures/poisoned/**` · `scripts/prove_injection_fails.sh` · `prove_hint_rejected.sh` | `fixtures/golden/**` and `fixtures/prose-edit/**` (frozen) |
| **TEST-006** | `src/classes/c-subst.ts` · `c-origin.ts` · `c-authz.ts` · `c-refuse.ts` · `c-clock.ts` · `c-log.ts` · `c-seatmap.ts` · `c-claim.ts` · `c-usage.ts` · `c-profile0.ts` · `c-revoke.ts` · `c-floor.ts` · `fixtures/dst/**` | `src/harness.ts` · every other class module |
| **TEST-007** | `packages/conformance/src/run.ts` · `src/report.ts` · `schemas/report.schema.json` · `packages/cli/src/commands/conform.ts` | every `src/classes/*.ts` · the eight document schemas |
| **integrator** | `scripts/run_proofs.sh` · `.github/workflows/**` · all git operations | — |

### What Gate 1 actually created outside those globs, and who owns it now

Recorded at the Gate 1 integration so the next wave does not collide with it. Every one of these was a reasonable thing to write and none of them collided — but they are not in the table above, which means nothing was stopping a second author from writing the same path.

| Path | Created by | Now owned by | Why it exists |
|---|---|---|---|
| `scripts/prove_lock_order.sh` *(in table)* · `scripts/prove_idempotent_race.sh` · `scripts/prove_no_fanout_concurrent.sh` | CORE-002 · CORE-005 · CORE-006 | same item as its sibling | The **concurrency half** of a gate, split out so the provable half can exit 0 while the half that needs two connections exits 2. This split is correct and should be the pattern: one script per gate that can be proven here, one per gate that cannot. |
| `scripts/prove_pii_ingest.sh` | CORE-007 | **CORE-007** | P1 ingest refusal, proven at the boundary. **TEST-005 must not write this path** — its C-PII-INGEST class module is `packages/conformance/src/classes/c-pii-ingest.ts`, and its two proof scripts are `prove_injection_fails.sh` and `prove_hint_rejected.sh`. Extend this one or add a differently-named one. |
| `packages/core/src/state.ts` · `packages/core/src/release-hold.ts` | CORE-003 | CORE-003 | Re-export shims under the names the backlog used. No second implementation — both forward to `derived.ts` / `release.ts`. |
| `packages/core/test/lib/hold-fixtures.ts` | CORE-003 | CORE-003 | `mintHold()` puts a Hold directly into any of the six derived states, including *expired with nothing reaped*, which the grant verb cannot produce. **Now a shared dependency**: `prove_release_total.sh` names it as a precondition and other items will. Treat its signature as a contract. |
| `scripts/prove_composition.sh` | integrator | integrator | The seams between modules, which no single item's proof can see. See §11. |

### The seam Gate 1 left open

**`packages/core/src/hmac.ts` was never written.** It is in CORE-007's glob and CORE-007 built only `access-log.ts`. Two modules independently hash under P2 and they are **not wired to the same key**:

- `idempotency.ts` (CORE-005) hashes the Idempotency-Key with `keyHmac()` → `siteEpochKey()`, which reads `CHANGEOVER_HMAC_KEY` and **mints a per-process random when it is unset**.
- `access-log.ts` (CORE-007) hashes the same key with `epochHmac(epoch, …)`, where `epoch: SiteEpoch {site_epoch_id, key}` is supplied **by the caller**.

Measured: with `CHANGEOVER_HMAC_KEY` set and `SiteEpoch.key` built from it, the two agree exactly. With it unset they can never agree, and nothing in the tree says so. Two consequences an operator would find the hard way: an access-log row cannot be correlated to the idempotency record it belongs to, and the `idempotency` table carries no `site_epoch_id`, so crypto-shredding an epoch — which is the entire mechanism P2 names — shreds the log and leaves the idempotency digests hashed under a key nothing names.

**Whoever writes `hmac.ts` owns resolving this**, and `prove_composition.sh` asserts the agreement so it cannot silently drift while they do. Until then, a binding MUST construct `SiteEpoch.key` from `CHANGEOVER_HMAC_KEY`.

### Files nobody may touch, for any reason

```
SPEC.md                    DECISIONS.md               LICENSE  LICENSE-BSL.md  NOTICE
schemas/*.schema.json      schemas/verbs.json         schemas/projection-0-1.json
schemas/member-manifest.json                          register/2026.1.json
fixtures/golden/**         fixtures/prose-edit/**
scripts/lib/project.mjs    scripts/lib/members.mjs    scripts/lib/extract-json-blocks.mjs
scripts/prove_spec_first.sh  prove_spec_examples.sh   prove_etag_golden.sh
scripts/prove_member_manifest.sh                      prove_no_settlement_verb.sh
packages/store/src/db.ts
```

Two of those need a word.

- **`scripts/lib/project.mjs` is the harness projector and no CHANGEOVER implementation may import it.** C-ETAG's whole claim is that two *independent* implementations agree. `@changeover/schema` must contain its own projector, written from `schemas/projection-0-1.json`. Importing the harness one turns the proof into a tautology.
- **`scripts/lib/members.mjs` holds `DOCUMENT_SCHEMAS`, a fixed list of eight.** TEST-007 adds `schemas/report.schema.json`; it is a **harness** schema, not a document schema, and it **MUST NOT** be added to that list. Adding it would drag the report's member names into the Lock 2 set-equality check and break `prove_member_manifest.sh` for reasons nobody would find quickly.

---

## 3 · The database contract

`packages/store/src/db.ts` is written, verified and frozen. Its full signature:

```ts
export type Row = Record<string, unknown>;

export interface QueryResult<T extends Row = Row> {
  readonly rows: T[];
  readonly rowCount: number;          // rows returned, or rows affected
}

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;   // multi-statement, no params. DDL only.
}

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  readonly isolation?: IsolationLevel;   // default: read committed
  readonly readOnly?: boolean;
  readonly role?: string;                // SET LOCAL ROLE, /^[a-z_][a-z0-9_]{0,62}$/
}

export type DriverName = "pglite" | "pg";

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T>;
  readonly driver: DriverName;
  readonly concurrent: boolean;          // false for PGlite. Always.
  close(): Promise<void>;
}

export interface OpenOptions {
  readonly dataDir?: string;             // PGlite only; omit for in-memory
  readonly driver?: DriverName;
  readonly url?: string;
  readonly poolSize?: number;            // pg only, default 8
}

export function openDb(options?: OpenOptions): Promise<Db>;
export function openPglite(dataDir?: string): Promise<Db>;
export function openPg(url: string, poolSize?: number): Promise<Db>;
export function requireConcurrentDb(): Promise<Db>;      // throws CannotProve

export function sqlstate(err: unknown): string | undefined;
export function constraintName(err: unknown): string | undefined;
export function isSerializationFailure(err: unknown): boolean;

export declare const SQLSTATE: {
  readonly unique_violation: "23505";        readonly check_violation: "23514";
  readonly foreign_key_violation: "23503";   readonly not_null_violation: "23502";
  readonly serialization_failure: "40001";   readonly deadlock_detected: "40P01";
  readonly insufficient_privilege: "42501";  readonly undefined_table: "42P01";
  readonly lock_not_available: "55P03";
};

export const EXIT_CANNOT_PROVE = 2;
export class CannotProve extends Error { readonly remedy: string; }
```

**No package outside `packages/store/src/db.ts` imports `@electric-sql/pglite` or `pg`.** Ever. That is the whole point of the file.

### Which driver you get

`openDb()` returns PGlite when `CHANGEOVER_PG_URL` is unset, node-postgres when it is set. Everything that does not need true concurrency therefore runs on a clean clone with no container, no daemon and no credentials — and the same code runs against real Postgres the moment one exists.

### Opening a transaction, and setting isolation

```ts
const hold = await db.transaction(async (tx) => {
  const r = await tx.query<{ hold_id: string }>(
    "insert into hold (hold_id, agent_id) values ($1, $2) returning hold_id",
    [holdId, agentId],
  );
  return r.rows[0];
}, { isolation: "read committed" });
```

Isolation is issued as `SET TRANSACTION ISOLATION LEVEL …` immediately after `BEGIN`, under both drivers — not as `BEGIN ISOLATION LEVEL …`, because PGlite issues its own `BEGIN` and there is no seam to put it in. The two spellings are equivalent to Postgres; only one is available to both drivers.

`{ role: "changeover_agent" }` issues `SET LOCAL ROLE changeover_agent` inside the transaction. The identifier is regex-validated and rejected otherwise; this is the one place a name reaches SQL where a parameter cannot carry it. **This is verified working on PGlite 0.5.7**: `CREATE ROLE` + `SET LOCAL ROLE` + grants genuinely raise `42501 permission denied for table`, so TEST-004's kill test is provable here.

### Reading a SQLSTATE — the drivers differ, and it has bitten this build

Measured on this machine, 2026-08-25:

| | node-postgres 8.23.0 | PGlite 0.5.7 |
|---|---|---|
| thrown class | `DatabaseError`, exported from `pg-protocol` | a **minified local class** (`N` in this build). Not exported. Not `instanceof`-able. |
| SQLSTATE | own property `code` | own property `code` |
| constraint | own property `constraint` | own property `constraint` |
| `cause` chain | may be present | absent on this path |

So:

```ts
// CORRECT — works under both drivers
import { sqlstate, constraintName, SQLSTATE } from "@changeover/store/db.ts";

try { await tx.query(insertSeatRows, params); }
catch (err) {
  if (sqlstate(err) === SQLSTATE.unique_violation) {
    switch (constraintName(err)) {
      case "hold_seat_occupied": throw new Refusal("seat_contended", "re_resolve", …);
      case "hold_cluster_live":  throw new Refusal("cluster_fanout",  "release_conflicting_hold", …);
      default: throw err;
    }
  }
  throw err;
}
```

```ts
// WRONG — three ways, all of which pass a local test and fail in the field
if (err instanceof DatabaseError) …           // false under PGlite: the class is minified
if ((err as any).code === "23505") …          // misses a nested cause, and matches Node's own errno strings
if (String(err).includes("duplicate key")) …  // passes in English; fails in the field
```

**Branch on the constraint name, never on the bare `23505`.** Two partial unique indexes both raise `23505` and they mean entirely different refusals. `sqlstate()` shape-checks against `/^[0-9A-Z]{5}$/` precisely so that `ENOENT` on `err.code` cannot be mistaken for a SQLSTATE.

### `clock_timestamp()` is VOLATILE — read it once, and it has bitten this build

`clock_timestamp()` is re-evaluated at **every occurrence**, not once per statement. `now()` is `STABLE` and is transaction start, so repeated reads of *it* are identical — which is exactly why the trap is invisible until you use the other one.

The `hold` table's own CHECK is an equality:

```sql
constraint hold_floor_derived
  check (floor_deadline = granted_at + (floor_ms * interval '1 millisecond'))
```

So a fixture that ages a Hold like this **cannot satisfy it**:

```sql
-- WRONG. Two reads, two different microseconds, and 23514 hold_floor_derived.
update hold set granted_at     = clock_timestamp() - interval '10 minutes',
                floor_deadline = clock_timestamp() - interval '10 minutes' + (floor_ms * interval '1 millisecond')
 where hold_id = $1
```

```sql
-- RIGHT. One read, joined in, used as many times as you like.
update hold set granted_at     = t.g - interval '10 minutes',
                floor_deadline = t.g - interval '10 minutes' + (floor_ms * interval '1 millisecond')
  from (select clock_timestamp() as g) t
 where hold_id = $1
```

**This is not hypothetical.** Four sites across CORE-005's test file and proof script carried the wrong form. It failed roughly **one whole-suite run in twelve** — often enough to be real, rarely enough that every agent who ran it saw green and reported green. `packages/store/test/schema.test.ts` already had the right idiom; the drift went the other way.

Two ways to stay out of it:

- Ageing an existing Hold? Shift the columns **relative to themselves** — `granted_at = granted_at - interval '10 minutes'` — which preserves every derived equality by construction and reads no clock at all. `prove_lock_order.sh` does this.
- Setting them fresh? Use `GRANT_CLOCK_SUBQUERY` from `packages/core/src/clock.ts`, which is documented as *"the single-evaluation form of `GRANT_CLOCK`. Join it into a statement's FROM"* and exists for precisely this.

A corollary for anyone writing a repeated measurement: **an intermittent failure is a failure.** If a run is green, run it ten more times before you report a number.

### What PGlite cannot do, and what you must do about it

PGlite is **single-connection and in-process**. True multi-connection concurrency, lock contention and `40P01` deadlock detection are **not reproducible on it**. Docker's daemon is not running on this machine and `psql` is not installed, so there is no real multi-connection Postgres available right now.

`db.concurrent` is `false` on PGlite and it never lies about that. Any assertion whose meaning depends on two callers racing calls `requireConcurrentDb()`, which throws `CannotProve` when `CHANGEOVER_PG_URL` is unset. See §7.

---

## 4 · The proof-script contract

Every gate in the backlog is already written as a command. Each is a `scripts/prove_<thing>.sh`, owned by exactly one item, with exactly this shape.

**Three exit codes, deliberately distinct.** `0` holds · `1` FAILS · `2` cannot prove. A precondition that is missing is not a pass. Deleting an assertion to make a suite green is the worst outcome available to you.

### The template — copy this

```bash
#!/usr/bin/env bash
# C-<CLASS>. One sentence on what is being asserted, and one on why the
# obvious cheaper check would not have caught it.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f schemas/hold.schema.json ]          || { echo "cannot prove — schemas/hold.schema.json missing"; exit 2; }

node --input-type=module -e '
import { openDb } from "./packages/store/src/db.ts";

let fail = 0, pass = 0;
const ok   = (m) => { console.log("ok — " + m); pass++; };
const bad  = (m) => { console.log("FAIL — " + m); fail = 1; };

const db = await openDb();
try {
  const r = await db.query("select 1 as one");
  r.rows[0].one === 1 ? ok("the store answers") : bad("the store did not answer");
} finally {
  await db.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
```

Rules, all of them load-bearing:

1. `#!/usr/bin/env bash` and `set -uo pipefail`. **Not** `set -e` — the existing house style captures exit codes deliberately and `-e` swallows them.
2. `cd "$(dirname "$0")/.." || exit 2` on line four. Every path after it is repository-relative.
3. **Preconditions come first and each exits `2`**, printing `cannot prove — <reason>` and the exact command that would satisfy it. Never `exit 1` for a missing precondition.
4. One line per check: `ok — <what held>` or `FAIL — <what did not>`. `run_proofs.sh` counts the `ok — ` lines and prints the count, so one line means one assertion.
5. The last line printed is `PASS=<n>`, where `n` is the number of checks that held, or `0` if any failed.
6. `exit 0` only when every check held. `exit 1` on any failure. `exit 2` when you could not reach the thing under test.
7. **Assert against the store, not the response**, wherever the backlog says so — and it says so a lot. `C-ATOMIC`, `C-ORPHAN`, `C-IDEMPOTENT` and `C-PII-INGEST` all count rows.
8. `node --input-type=module -e '…'` inside single quotes: no `$` interpolation, no backticks that bash will eat. Template literals inside are fine because bash is not expanding them.

### Registering a proof

**There is nothing to register.** `scripts/run_proofs.sh` **discovers** `scripts/prove_*.sh` with `find … | sort`. Dropping your script into `scripts/` puts it in the suite on the next run — no array to edit, no shared registry file for twenty-five authors to contend on, and no way to write a proof and then forget to wire it up. A proof that is broken on arrival turns the suite red immediately, which is the point.

The corollary is that a half-written proof in `scripts/` is already gating everyone. Verify it standalone before you leave it there.

**Do not edit `run_proofs.sh`** — it is the integrator's, and there is now no reason to want to.

The five root-commit proofs must still exit 0 when you are done: `prove_spec_first`, `prove_spec_examples`, `prove_etag_golden`, `prove_member_manifest`, `prove_no_settlement_verb`. Run `npm run check` before you return — it is `typecheck && test && proofs`, and the first two catch a broken seam in seconds where the third catches it in a stack trace.

*Measured at the Gate 1 integration, 2026-08-25:* `npm run check` → tsc exit 0 · `node --test` 328 pass / 0 fail · `run_proofs.sh` PASS=19 FAIL=0 UNPROVABLE=4, exit 2. The four unprovable are `prove_lock_order`, `prove_idempotent_race`, `prove_no_fanout_concurrent` and `prove_migrations_pg` — every one of them concurrency-gated on `CHANGEOVER_PG_URL`, and every one correct to exit 2 here.

---

## 5 · TypeScript rules

Node 24 runs `.ts` natively by **type stripping only**. There is no bundler, no `tsx`, no build step, and there will not be one. Stripping erases types; it cannot *generate* code. So:

| Banned | Because | Write instead |
|---|---|---|
| `enum` | generates a runtime object | `as const` object + union type |
| `namespace` | generates a runtime object | a module |
| decorators | generate runtime calls | a plain function |
| parameter properties (`constructor(private x: T)`) | generate assignments | an explicit field |
| relative import without `.ts` | Node will not resolve it | `"./guards.ts"` |
| `import { SomeType }` for a type | stripping cannot tell it is type-only | `import type { SomeType }` |

`tsconfig.json` sets **`erasableSyntaxOnly: true`** and **`verbatimModuleSyntax: true`**, so all six are compile errors rather than review notes. `npx tsc --noEmit -p tsconfig.json` exits 0 today; keep it that way.

A correct ten lines:

```ts
import type { Db, Queryable } from "@changeover/store/db.ts";
import { SQLSTATE, sqlstate } from "@changeover/store/db.ts";

export const HOLD_STATE = { live: "live", handed_off: "handed_off", claimed: "claimed",
                            released: "released", expired: "expired", revoked: "revoked" } as const;
export type HoldState = (typeof HOLD_STATE)[keyof typeof HOLD_STATE];

export async function countLiveSeats(tx: Queryable, occasion_id: string): Promise<number> {
  const r = await tx.query<{ n: string }>("select count(*)::text as n from hold_seat where occasion_id = $1", [occasion_id]);
  return Number(r.rows[0]?.n ?? 0);
}
```

Note `count(*)::text` — Postgres `bigint` arrives as a string under node-postgres and as a `number` or `bigint` under PGlite depending on the path. Cast in SQL and convert in TS, and the two drivers stop disagreeing.

**Tests** are `node:test` + `node:assert/strict`, in `packages/<pkg>/test/<name>.test.ts`. `npm test` at the root runs `node --test`, which discovers them with no configuration. **No jest, no vitest, no mocha.**

**Do not run `npm install`.** Everything the build needs was installed once, up front (§9). If something is genuinely missing, declare it in your return and make the affected assertion `exit 2`. Concurrent writes to `node_modules` corrupt the tree.

---

## 6 · Naming and error conventions

### snake_case on the wire, and in the code that carries the wire

**One casing, no mapper.** Anything that is a wire shape or a database shape is `snake_case` **in TypeScript too**: `hold.floor_ms`, `row.occasion_etag`, `refusal.retry_after_ms`. Functions, local variables and internal non-wire types are `camelCase`: `holdSeats()`, `const seatIds`, `interface GuardContext`.

There is no camelCase↔snake_case mapping layer and there will not be one. A mapper between twenty-five agents is a bug farm, and every bug in it is a silently dropped protocol member — exactly the class of failure `additionalProperties: false` exists to make impossible.

SQL identifiers are `snake_case` and unquoted. Table and column names match the wire member they carry wherever one exists.

### Timestamps and durations

- **Every timestamp on a wire or in a document is an RFC 3339 string with a mandatory offset.** `"2026-08-29T19:30:00+12:00"`. Never a `Date`, never epoch millis, never a bare `Z`-less string.
- In SQL, `timestamptz`. Never `timestamp`.
- **Every duration an implementation reasons about is an integer of milliseconds** (`floor_ms`, `retry_after_ms`, `handoff_floor_ms`). A duration subtracted from a deadline should not need a parser. Never an ISO 8601 duration, never seconds, never a float.
- The one place seconds appear is HTTP `Retry-After`, which is `ceil(retry_after_ms / 1000)` and exists for intermediaries. `retry_after_ms` is normative where both are present.
- Wall-clock time comes from the server, per **K1–K6** (SPEC.md:330–335). No request accepts a client timestamp. `granted_at` derives from `clock_timestamp()`, not transaction start — see CORE-002.

Type aliases, exported from `@changeover/schema`:

```ts
export type Rfc3339 = string;   // RFC 3339 with a mandatory offset
export type DurationMs = number; // integer milliseconds
```

### How a refusal is thrown, and how it is caught

A refusal is **thrown**, never returned. Throwing is what makes "a refusal MUST NOT be mixed with rows; first failure wins" (§2.7) structural rather than a discipline: a guard cascade that throws cannot accidentally accumulate a partial result alongside an error.

`@changeover/schema/refusal.ts` (CORE-008) exports:

```ts
export type RefusalCode = /* the closed 32-member union, below */;
export type Remediation = "re_resolve" | "re_read" | "release_conflicting_hold" | "retry_same_key"
                        | "retry_after" | "hand_off_existing" | "use_book_url" | "contact_venue" | "none";

export class Refusal extends Error {
  readonly code: RefusalCode;
  readonly remediation: Remediation;
  readonly reason: string;            // prose envelope. Non-load-bearing. Never an instruction.
  readonly detail?: RefusalDetail;    // the closed oneOf branch for this code, or absent
  readonly retry_after_ms?: DurationMs;
  constructor(code: RefusalCode, remediation: Remediation, reason: string, extra?: {
    detail?: RefusalDetail; retry_after_ms?: DurationMs;
  });
  /** The wire document. `server_time` is projected HERE, at render time, per C-CLOCK. */
  toDocument(server_time: Rfc3339): RefusalDocument;
}

export const REFUSAL_STATUS: Readonly<Record<RefusalCode, number>>;
export function isRefusal(err: unknown): err is Refusal;
```

Core throws. A binding catches **exactly `Refusal`** and renders it. Anything else is an unexpected fault, is a 500, and **must never reach the wire with its message**: an internal error string is an uncontrolled prose channel to a consumer with no judgement, which is the thing §5.3 exists to prevent.

```ts
try {
  const hold = await holdSeats(db, request, credential);
  respond(201, hold);
} catch (err) {
  const server_time = nowRfc3339();
  if (isRefusal(err)) return respondRefusal(REFUSAL_STATUS[err.code], err.toDocument(server_time));
  logInternal(err);
  return respondRefusal(503, new Refusal("upstream_unavailable", "retry_after",
    "The exhibitor's own system did not answer.", { retry_after_ms: 5000 }).toDocument(server_time));
}
```

### Code → HTTP status

Extracted from SPEC.md §6.3 (lines 581–613) and **verified set-equal, both directions, against the `code` enum in `schemas/refusal.schema.json`: 32 codes, no orphans on either side.** CORE-008 must reproduce this exactly and `prove_refusals_closed.sh` must assert the equality mechanically rather than trusting this table.

```ts
export const REFUSAL_STATUS = {
  schema_validation: 400,       hint_rejected: 400,          unknown_seat: 400,
  window_too_wide: 400,         not_authorised: 403,         principal_scope_missing: 403,
  occasion_not_found: 404,      hold_not_found: 404,         seat_contended: 409,
  seat_unavailable: 409,        seat_rule_violated: 409,     availability_unknown: 409,
  availability_stale: 409,      past_sales_cutoff: 409,      hold_not_live: 409,
  hold_expired: 409,            hold_revoked: 409,           handoff_consumed: 409,
  stale_read: 409,              idempotency_in_flight: 409,  claim_consumed: 409,
  claim_expired: 410,           occasion_moved: 412,         substitution_refused: 412,
  idempotency_key_reused: 422,  hold_budget_exhausted: 429,  seat_budget_exhausted: 429,
  cluster_fanout: 429,          rate_limited: 429,           profile_not_supported: 501,
  floor_unavailable: 503,       upstream_unavailable: 503,
} as const;
```

Over HTTP the body is RFC 9457 `application/problem+json` with `type: "urn:changeover:refusal:<code>"` — a URN, not a URL, because a URL type implies a domain that must resolve and this project's domain is unverified.

> **Named contract question for BIND-001.** `refusal.schema.json` is `additionalProperties: false`, so an RFC 9457 body carrying `type`/`status`/`title` alongside the refusal members does not itself validate against the refusal schema. **Default ruling, in force unless BIND-001 finds the specification settles it otherwise:** the HTTP body is the refusal document plus exactly those three RFC 9457 members, and C-REFUSE validates the document obtained by removing exactly those three. The MCP binding carries the refusal document unmodified. If BIND-001 concludes differently, say so in the return — do not quietly diverge, because the two bindings must agree.

### Names to avoid, and why

`C-ABSENCE.1` matches `/settle|pay|capture|refund|charge/i`. Today `prove_no_settlement_verb.sh` applies it to `verbs.json` and the member manifest only; TEST-004 extends it to `tools/list` names and HTTP route segments. It is not applied to arbitrary source, and it must not be — but the pattern catches substrings, so **do not name an exported identifier, tool, route segment, table or column** `payload`, `capture`, `charge` or anything containing them. Use `body`, `record`, `snapshot`. `price_disclosure`, `price_basis` and `price_band` are legitimate read-side members and the pattern deliberately omits `price`.

**No settlement, ever** — no verb, route, tool, column or field that settles, authorises, captures, refunds or prices. It is absent by construction, not gated.

**No personal data** — no field for a name, email, phone, loyalty number or payment instrument, in any schema, table, request, response or log. Adding a member to a document schema requires adding its name to `schemas/member-manifest.json` in the same change (177 members today), or CI fails.

**Independence** — never claim or imply affiliation with any cinema platform vendor. Vendor behaviour is cited only from public documentation, with a retrieval date. That is CORPUS-001's whole discipline and it applies in code comments too.

---

## 7 · The exit-2 rule

> Anything whose proof requires true concurrency **MUST** run against a real Postgres via `CHANGEOVER_PG_URL`. When that variable is unset the script **MUST exit 2**, printing the reason and the exact command that would make it provable. It **MUST NOT** exit 0. It **MUST NOT** simulate concurrency on one connection and call that a pass.

The repository's whole credibility rests on the difference between *your server violated the floor* and *we could not reach your server*. A suite that reports green when it could not reach the thing it tests is worse than no suite.

This binds at minimum: **TEST-001** (C-ATOMIC .1–.4), **TEST-002** (C-BUDGET, C-FANOUT), **TEST-003** (C-ORPHAN), **CORE-002** (`prove_lock_order.sh`, `prove_grant_clock.sh`), and any assertion mentioning `40P01`, contention, or "N concurrent".

Exact message format — copy it verbatim so twenty-five scripts print one thing:

```bash
if [ -z "${CHANGEOVER_PG_URL:-}" ]; then
  echo "cannot prove — C-ATOMIC needs true concurrency, and PGlite is single-connection and in-process:"
  echo "                lock contention and 40P01 cannot occur there, so a pass would mean nothing."
  echo "  to make it provable:"
  echo "    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18"
  echo "    export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover"
  echo "    bash scripts/prove_no_oversell.sh"
  exit 2
fi
```

From TypeScript, use `requireConcurrentDb()` and let `CannotProve` reach the top:

```ts
import { requireConcurrentDb, CannotProve, EXIT_CANNOT_PROVE } from "@changeover/store/db.ts";
try {
  const db = await requireConcurrentDb();
  /* … the racing scenario … */
} catch (err) {
  if (err instanceof CannotProve) {
    console.log("cannot prove — " + err.message);
    console.log("  to make it provable:\n" + err.remedy.split("\n").map((l) => "    " + l).join("\n"));
    process.exit(EXIT_CANNOT_PROVE);
  }
  throw err;
}
```

`run_proofs.sh` already distinguishes the three outcomes: it prints `skip — <name> cannot prove`, lists them, and exits `2` if any script could not prove and none failed. That is correct and intended. **A `2` is an honest result. A `0` you did not earn is not.**

**Docker's daemon is not running on this machine and `psql` is not installed.** Expect `2` locally for every concurrency proof. Write the script so that it turns into a real `0` or `1` the instant a server exists, and never sooner.

---

## 8 · What is frozen and must never move

**The three golden etags.** In `fixtures/golden/`, cross-checked against `EXPECTED.md` and against `SPEC.md` by `prove_etag_golden.sh`:

```
fixtures/golden/occasion-embassy-sat-1900.json
fixtures/golden/occasion-multiplex-sat-2100.json
fixtures/golden/occasion-multiplex-sun-1400.json
```

Each carries an `etag` of the form `1:<43 base64url chars>` that appears identically in three places. If a change moves one of them, the change is wrong — not the fixture. C-ETAG also pins the *behaviour*: a prose-only edit does not move the digest; a moved start time, a changed price, and a withdrawn non-substitutability assertion each do; a re-observation and a revision bump do not.

**PROJECTION_0_1** — `schemas/projection-0-1.json`. The closed list of JSON Pointers that the etag is computed over. Adding a member to it is a **major** version change (V2, SPEC.md:662). Not a fix. Not obvious. Major.

**The member manifest** — `schemas/member-manifest.json`, Lock 2, **177 members**, asserted set-equal in both directions against every member name declared across the **eight** document schemas. It is an allowlist, never a denylist. Adding a member to a document schema means adding its name here in the same change.

**The five verbs** — `schemas/verbs.json`:

```
resolve_occasions · hold_seats · get_hold · release_hold · hand_off
```

Exactly five. There is no sixth, and there is no settlement verb — not deferred, not permission-checked. The surface has no such operation, so no instruction can reach one (ADR-001).

**The root commit's file list.** `prove_spec_first.sh` asserts a property of `git rev-list --max-parents=0`: the root commit contains `SPEC.md` and `DECISIONS.md`, contains no `.ts` and no `.sql` file, and contains no path under `src/`, `packages/*/src/`, `adapters/`, `corpus/`, `migrations/` or `evals/`. It passes at commit one, keeps passing forever, and can never be satisfied by rearranging a later commit. **Never rebase, amend or graft the root commit.**

**The 2026.1 class register** — `register/2026.1.json`. Append-only. A class id is never reused or redefined; retirement sets `retired_at` and the class resolves forever (V6).

---

## 9 · What is installed

One `npm install` ran, once, at the repository root. **Nobody else installs anything.**

| Package | Version | For |
|---|---|---|
| `typescript` | 5.9.3 | `npx tsc --noEmit`. 5.9 for `erasableSyntaxOnly` + `allowImportingTsExtensions`. |
| `@types/node` | 24.13.3 | matched to the Node 24.13.1 runtime |
| `@types/pg` | 8.23.1 | node-postgres typings |
| `@electric-sql/pglite` | 0.5.7 | PostgreSQL 18.3 in wasm. The default store. |
| `pg` | 8.23.0 | node-postgres, used when `CHANGEOVER_PG_URL` is set |
| `ajv` | 8.17.1 | JSON Schema 2020-12 validation |
| `ajv-formats` | 3.0.1 | `date-time`, `uri`, `email` formats |
| `canonicalize` | 2.1.0 | third-party RFC 8785 JCS, used by the etag proof |
| `yaml` | 2.9.0 | `changeover.policy.yaml` (SPEC-007) |
| `fast-check` | 4.9.0 | property tests (SPEC-008) |
| `@modelcontextprotocol/sdk` | 1.30.0 | BIND-002. **Its support for protocol revision 2026-07-28 is unverified** — verify before depending on it, or hand-roll JSON-RPC over stdio, which is a small amount of code and avoids the coupling. |

`ajv`, `ajv-formats` and `canonicalize` were pinned by the root commit and `prove_etag_golden.sh` and `prove_spec_examples.sh` depend on them. **Do not move those three versions.**

Deliberately **not** installed, and not to be: any HTTP framework (`node:http` is enough for nine routes), any test runner (`node --test`), any bundler, any ORM or query builder, any seeded-PRNG package (DEMO-001 hand-rolls a mulberry32 in ~6 lines rather than take a dependency into the cold-start path).

### The commands

```bash
npm test          # node --test — every packages/*/test/*.test.ts
npm run typecheck # npx tsc --noEmit -p tsconfig.json
npm run proofs    # bash scripts/run_proofs.sh
npm run check     # all three, in that order
node packages/cli/src/bin.ts <cmd>   # the CLI, locally
```

**A known follow-up for the integrator.** `packages/cli/package.json` declares `"bin": { "changeover": "./src/bin.ts" }`, but `src/bin.ts` did not exist when `npm install` ran, so npm created no `node_modules/.bin/changeover` link. After SPEC-007 lands `bin.ts`, the integrator re-runs `npm install` once and `npx changeover …` starts working locally. Until then the canonical local invocation is `node packages/cli/src/bin.ts <cmd>`, and **DEMO-001's `prove_cold_start.sh` should read the entrypoint from `${CHANGEOVER_CLI:-node packages/cli/src/bin.ts}`** so the same script exercises the published `npx changeover demo` path when one exists.

---

## 10 · The four rules that override everything here

1. **You never run git directly** — no `add`, `commit`, `checkout`, `stash`, `push`, `rebase`. Concurrent agents sharing one git index corrupt it. You commit *continuously*, in small coherent units, through the mutex helper, which serialises `.git/index.lock` and restricts each commit to a pathspec so you cannot sweep up a neighbour's half-written file:

   ```bash
   bash scripts/dev/micro-commit.sh "<subject>" <path> [<path> ...]
   ```

   Exit codes: `0` committed · `1` nothing to commit (fine) · `2` lock timeout · `3` refused. Commit when a unit becomes **true** — a module, a migration, a proof script, a test file, a fix — not when your item ends. Pass explicit paths, never a bare `.` and never `-A`. Match the subject style already in `git log --oneline`: lowercase after the area prefix, saying what became true and, where there is room, why it matters. No conventional-commit prefixes; the helper refuses them.
2. **You write only inside the globs §2 gives you.** Another agent owns every other path and is writing to it right now.
3. **You do not run `npm install`.** Declare what is missing; make the affected assertion `exit 2`.
4. **Never fake a pass.** `0` holds, `1` fails, `2` cannot prove. Deleting an assertion to make a suite green is the worst outcome available to you.

---

## 11 · The composition gate

`scripts/prove_composition.sh` — 22 checks, exit 0, added at the Gate 1 integration.

Every other proof in `scripts/` is written by the agent that owns the module under test, and each is honest about its own module. None of them can be honest about the **join**. CORE-005 wraps a verb it does not own; CORE-006 plugs a guard into a seam it did not declare; CORE-003 reads rows CORE-002 wrote; CORE-007 hashes a value CORE-005 also hashes. Each of those is a pair of files that typecheck independently and can still disagree at runtime — and nothing in the tree calls them together, because the two bindings that eventually will are still empty directories.

`npx tsc --noEmit` passes on every one of those seams. A type is a claim about shape; these are claims about **values agreeing**: one digest projection, one seat order, one set of published numbers, one epoch key, one M1. The only way to see those is to run the stack.

What it asserts, and why each one is a seam rather than a rule:

| Assertion | The seam |
|---|---|
| The enforced policy and the published policy agree on every shared member; nothing enforced is unpublished | `guards.ts` clamps with `HOLD_POLICY_DEFAULTS`, `budgets.ts` publishes `HOLD_POLICY_PUBLISHED`. `budgets.ts` already refuses to load on drift — this makes the property legible instead of arriving as a module-init crash |
| The published policy funds X6 at its own numbers | A `policy_max_floor_ms` below `handoff_gate_budget_ms + clock_guard_ms + headroom` makes a hand-off gate unsatisfiable at the numbers this Server actually ships |
| `holdSeatsDigest(r) === requestDigest(decisionMembers(r))` | I3's binding parity is structural only while CORE-005 projects through CORE-002's exported `decisionMembers()`. If it ever re-derives `D` from a body, both bindings still work and they disagree |
| Seats sort identically in `D`, in the lock order and in the granted document — asserted with `F:2, F:10`, where byte order and human order differ | Three modules hold an opinion about seat order. Handing them an already-sorted array asserts nothing |
| The budget guard's `hold_slot` row exists after the grant | A guard that typechecks and no-ops passes every response-shaped assertion above it |
| The replayed state, the `get_hold` state and `deriveState()` on the row are all one derivation | I4 re-projects state at replay; two M1s disagree the first time one of them learns a new marker |
| `keyHmac(key) === epochHmac(epoch, key)`, and the raw key is nowhere in the log | The P2 seam of §2. Asserts the agreement so it cannot silently drift while `hmac.ts` is still unwritten |
| Release frees exactly the seats the grant took, returns the budget slot, and the seats grant again | The loop closes — which is the whole product |

It is single-connection and that is not a concession: every assertion is a property of one call through several modules. The concurrency assertions live in `prove_lock_order.sh`, `prove_idempotent_race.sh`, `prove_no_fanout_concurrent.sh` and `prove_migrations_pg.sh` and correctly exit 2 here.

**When a binding lands, extend this file rather than writing a second one.** BIND-001 and BIND-002 both claim digest parity with core; this is where that claim becomes an assertion over one running stack.

### One sharp edge it documents

`deriveState()` declares `HoldFacts.expires_at` as an RFC 3339 **string**. A bare `select * from hold` hands it a `Date`, and the comparison then **silently returns `expired` for a live Hold** — no throw, because `Row` is `Record<string, unknown>` and the cast is unchecked. That is the exact failure M1 exists to prevent, arriving through the one seam the type system cannot see. Read the hold table through **`HOLD_COLUMNS`**, which CORE-003 exports for this and which renders every timestamp as RFC 3339. Every binding that touches the table directly must go through it.

### A follow-up that is still open

`packages/cli/src/bin.ts` now exists, so `packages/cli/package.json`'s `"bin": { "changeover": "./src/bin.ts" }` would link on the next `npm install` — but no agent may run one, so `node_modules/.bin/changeover` is still absent. The canonical local invocation remains `node packages/cli/src/bin.ts <cmd>`, which works today and prints `derive` and `lint`.
