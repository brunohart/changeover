/**
 * The client that disappears.
 *
 * Owner: TEST-003 (C-ORPHAN).
 *
 * Run as its own OS process — `node packages/conformance/src/lifecycle/orphan-client.ts '<json>'`
 * — because §4.8's scenario is *"No release arrives — `SIGKILL`, a crash, a
 * partition, a model that gave up"*, and a client you can kill has to be a
 * process you can kill. Simulating disappearance inside the harness by simply
 * not calling `release_hold` proves the reclaim works when the caller is polite
 * about being rude. This one is genuinely gone: it holds seats, says so, and
 * then waits forever for a signal it will never handle.
 *
 * It **grants and then commits before it announces**. `holdSeats` resolves only
 * after its transaction commits, so a parent that has read the `READY` line
 * knows the Hold is durable and can kill the process with no race against the
 * write it is about to assert on.
 *
 * It **never resets the store**. A child that called `resetHoldStore` would
 * delete the fixtures its parent is mid-assertion about, and the failure would
 * read as a boundary defect rather than as the harness defect it is.
 */

import { openDb } from "@changeover/store/db.ts";
import { holdSeats } from "@changeover/core/hold-seats.ts";
import { principalBudgets, HOLD_POLICY_PUBLISHED } from "@changeover/core/budgets.ts";
import type { HoldPolicyDocument } from "@changeover/core/budgets.ts";

export interface OrphanClientConfig {
  readonly occasion_id: string;
  readonly occasion_etag: string;
  readonly seats: readonly string[];
  readonly requested_floor_ms: number;
  readonly agent_id: string;
  readonly principal_scope: string;
  /** Harness profile, stated: the ceilings this run enforces. */
  readonly policy?: Partial<HoldPolicyDocument>;
}

/** What the parent needs in order to assert on the store after the kill. */
export interface OrphanClientReady {
  readonly hold_id: string;
  readonly seats: readonly string[];
  readonly granted_at: string;
  readonly expires_at: string;
  readonly floor_ms: number;
  readonly pid: number;
  readonly application_name: string;
}

export const READY_PREFIX = "READY ";

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "{}") as OrphanClientConfig;
  const db = await openDb();

  const held = await holdSeats(
    db,
    {
      occasion_id: config.occasion_id,
      occasion_etag: config.occasion_etag,
      sought: { occasion_id: config.occasion_id, occasion_etag: config.occasion_etag },
      seats: [...config.seats],
      requested_floor_ms: config.requested_floor_ms,
    },
    { agent_id: config.agent_id, principal_scope: config.principal_scope },
    { budgets: principalBudgets({ ...HOLD_POLICY_PUBLISHED, ...(config.policy ?? {}) }) },
  );

  const ready: OrphanClientReady = {
    hold_id: held.hold_id,
    seats: held.seats,
    granted_at: held.granted_at,
    expires_at: held.expires_at,
    floor_ms: held.floor_ms,
    pid: process.pid,
    application_name: process.env.PGAPPNAME ?? "",
  };
  process.stdout.write(READY_PREFIX + JSON.stringify(ready) + "\n");

  // Alive, holding, and never releasing. The connection stays open too: a client
  // that tidily closed its pool before dying would be a kinder failure than the
  // one §4.8 describes, and the reclaim must not need the kindness.
  setInterval(() => {}, 3_600_000);
}

main().catch((err) => {
  process.stderr.write("orphan-client: " + String(err && (err as Error).stack ? (err as Error).stack : err) + "\n");
  process.exit(1);
});
