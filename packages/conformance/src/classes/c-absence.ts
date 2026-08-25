// C-ABSENCE — the four locks of SPEC.md §5.1, as a conformance class.
// Owner: TEST-004.
//
// The assertions themselves live in `../absence/`, are written against nothing
// but `Db` and the two bindings, and are executed by
// `scripts/prove_write_path_pii_absent.sh`. This module is the thin mapping onto
// `_contract.ts`'s `ClauseOutcome` so the class appears in the dated report
// rather than only in the proof suite. **A class proven by a script and absent
// from the report reads, in the report, exactly like a class nobody wrote.**
//
// The mapping is deliberately one line per clause and carries no assertion of
// its own. Two definitions of what Lock 3 means is one of them drifting.
//
// ## Why this module restores the bench when it is finished
//
// `runAbsence` stands up BIND-001's HTTP bench and BIND-002's MCP bench, and
// each of those truncates and re-seeds the hold store to get a known estate.
// Against PGlite that is invisible — every `openDb()` is a fresh database. On a
// shared Postgres it is not: the store those benches truncate is the store the
// bench passed to this function is still using, so a class that ran before this
// one has had its estate deleted by the time the next class reads it. That is
// the same defect that made fixture benches collide on a shared cluster, and it
// is silent, so this module ends by calling `bench.reset()` — which is exactly
// "truncate the hold store, re-seed the estate, clear the recorder" — whether it
// succeeded, failed or threw.
//
// The access log is deliberately NOT cleared by hand here. It is append-only and
// a helper that quietly emptied it would be the first crack in the property this
// repository asserts; `bench.reset()` clears the in-process recorder, which is a
// different object with a different meaning.

import { fileURLToPath } from "node:url";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { ConformanceBench } from "./_bench.ts";
import { runAbsence } from "../absence/absence.ts";

/** The repository root, four levels up from `packages/conformance/src/classes/`. */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");

export const id = "C-ABSENCE";

export const spec_row =
  "**.1** no settlement verb anywhere. **.2** member manifest **set equality**. " +
  "**.3** the `SET LOCAL ROLE` kill test raises `insufficient_privilege`. " +
  "**.4** outbound byte canary: no response body matches an email, a Luhn-valid " +
  "13–19 digit run, or an E.164 string — **fail the build, do not filter the response**.";

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  try {
    const absence = await runAbsence(bench.db, ROOT);
    for (const clause of absence.clauses) c.that(clause.clause, clause.ok, clause.note);
    c.ok(
      "bodies_scanned",
      `${absence.http} HTTP and ${absence.mcp} MCP response bodies left the boundary as bytes and every one was scanned whole; none was filtered, masked or redacted, and there is no function in packages/conformance/src/absence that could`,
    );
  } finally {
    // See the note above: the two bindings' benches truncate the store this
    // bench is seeded into, and on a shared cluster that is the next class's
    // missing estate.
    await bench.reset();
  }
  return c.items;
}
