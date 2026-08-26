// STEP 2 of the build contract, kept as a permanent regression guard.
// Asserts the four things every other agent's work assumes:
//   1. node --test discovers and runs a .ts test with no build step
//   2. a cross-package import resolves through npm workspaces
//   3. `import type` and `as const` unions survive type stripping
//   4. the default Db driver opens, runs SQL, and reports itself honestly
//
// Owner: CONTRACT-000.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CUE, frame } from "@changeover/toolchain-check/probe.ts";
import type { Frame } from "@changeover/toolchain-check/probe.ts";
import { openDb, sqlstate, constraintName, SQLSTATE, requireConcurrentDb, CannotProve } from "@changeover/store/db.ts";

test("a .ts test runs under node --test with no build step", () => {
  const f: Frame = frame(CUE.changeover, 8000);
  assert.equal(f.cue, "changeover");
  assert.equal(f.at_ms, 8000);
});

test("a cross-package import resolves through npm workspaces", async () => {
  const db = await openDb();
  try {
    assert.equal(db.driver, process.env["CHANGEOVER_PG_URL"] ? "pg" : "pglite");
  } finally {
    await db.close();
  }
});

test("the default driver runs SQL and reports its own concurrency honestly", async () => {
  const db = await openDb();
  try {
    const r = await db.query<{ n: number }>("select $1::int as n", [8]);
    assert.equal(r.rows[0]?.n, 8);
    if (db.driver === "pglite") assert.equal(db.concurrent, false, "PGlite must never claim to be concurrent");
    else assert.equal(db.concurrent, true);
  } finally {
    await db.close();
  }
});

test("a unique violation reaches sqlstate() and constraintName() under this driver", async () => {
  const db = await openDb();
  try {
    await db.exec(`
      create table t_probe (k text not null);
      create unique index t_probe_k_uq on t_probe (k);
      insert into t_probe (k) values ('a');
    `);
    await assert.rejects(
      () => db.query("insert into t_probe (k) values ($1)", ["a"]),
      (err: unknown) => {
        assert.equal(sqlstate(err), SQLSTATE.unique_violation, "SQLSTATE must be readable through sqlstate()");
        assert.equal(constraintName(err), "t_probe_k_uq", "the constraint name must be readable — 23505 alone is not a refusal");
        return true;
      },
    );
  } finally {
    await db.close();
  }
});

test("a proof needing true concurrency cannot silently pass on PGlite", async (t) => {
  if (process.env["CHANGEOVER_PG_URL"]) return t.skip("CHANGEOVER_PG_URL is set — concurrency is reachable here");
  await assert.rejects(() => requireConcurrentDb(), (err: unknown) => {
    assert.ok(err instanceof CannotProve);
    assert.match(err.remedy, /CHANGEOVER_PG_URL/);
    return true;
  });
});
