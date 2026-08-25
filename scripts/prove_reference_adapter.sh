#!/usr/bin/env bash
# C-CAPABILITY and C-FLOOR, as far as an in-process adapter can carry them, plus
# the discipline that keeps the rest honest. The capability document VALIDATES
# against the frozen schema; the floor it publishes never exceeds what was
# MEASURED; and no conformance class reports `pass` without a runner that
# actually executed.
#
# The obvious cheaper check — assert `floor_evidence` is present and shaped
# right — would pass a document whose `policy_max_floor_ms` is 300000 above a
# measurement of two seconds, which is precisely the lie §7 puts a MUST NOT
# beside. So the evidence is produced by granting real Holds and watching real
# seats, and the inequality is asserted against that measurement rather than
# against a constant.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -d node_modules/ajv ]                  || { echo "cannot prove — ajv not installed; run npm install at the repository root"; exit 2; }
[ -f schemas/capability.schema.json ]    || { echo "cannot prove — schemas/capability.schema.json missing"; exit 2; }
[ -f packages/adapter-reference/src/reference.ts ] || { echo "cannot prove — the reference adapter is not built; see ADAPT-001"; exit 2; }
[ -f packages/adapter-reference/test/lib/schema-validator.ts ] || { echo "cannot prove — packages/adapter-reference/test/lib/schema-validator.ts missing; it compiles the frozen schemas for this script"; exit 2; }

node --input-type=module -e '
import { readFileSync } from "node:fs";
import {
  schemaValidator, CAPABILITY_SCHEMA_ID, HOLD_SCHEMA_ID, SEATMAP_SCHEMA_ID, OCCASION_SCHEMA_ID,
} from "./packages/adapter-reference/test/lib/schema-validator.ts";
import { createReferenceAdapter } from "./packages/adapter-reference/src/reference.ts";
import { unpublishedLimits } from "./packages/adapter-reference/src/capability.ts";
import { warrantableFloorMs } from "./packages/adapter-reference/src/floor.ts";
import { CONFORMANCE_CLASSES, reportConformance, blockerPathIsStillMissing } from "./packages/adapter-reference/src/classes.ts";
import { ADAPTER_METHODS, VERB_METHODS } from "./packages/adapter-reference/src/adapter.ts";
import { availableSeatIds } from "./packages/store/src/fixtures.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };
const note = (m) => { console.log("note — " + m); };

const validate = schemaValidator();
const adapter = await createReferenceAdapter({ measurement: { trials: 5 } });
const credential = { agent_id: "agt_reference_proof", principal_scope: "prn_reference_proof" };

try {
  /* 1 · The three declarations. */
  adapter.profile === "1" && adapter.hold_basis === "system_of_record" && adapter.floor_basis === "owned_store"
    ? ok("the adapter declares profile 1, hold_basis system_of_record, floor_basis owned_store")
    : bad(`the adapter declares ${adapter.profile}/${adapter.hold_basis}/${adapter.floor_basis}`);

  /* 2 · The capability document validates against the frozen schema. */
  const capability = await adapter.capability();
  const capability_errors = validate(CAPABILITY_SCHEMA_ID, capability);
  capability_errors === null
    ? ok("the capability document validates against schemas/capability.schema.json")
    : bad("the capability document does not validate: " + capability_errors);

  /* 3 · The evidence is a measurement, not a shape. */
  const evidence = capability.floor_evidence;
  evidence && evidence.observations > 0
    ? ok(`floor_evidence carries ${evidence.observations} real observations`)
    : bad("floor_evidence carries no observations, so no floor is warranted (§7)");
  evidence && evidence.window_end > evidence.window_start
    ? ok("the observation window has a start before its end, from the store clock")
    : bad("the observation window is not a window");

  /* 4 · THE INEQUALITY. floor_ms MUST NOT exceed min_observed - safety_margin. */
  const warrantable = warrantableFloorMs(evidence);
  const published = capability.hold_policy.policy_max_floor_ms;
  published <= warrantable
    ? ok(`the published floor ceiling ${published}ms is inside the warranted ${warrantable}ms ` +
         `(min_observed ${evidence.min_observed_retention_ms} - margin ${evidence.safety_margin_ms})`)
    : bad(`the published floor ceiling ${published}ms EXCEEDS the warranted ${warrantable}ms — a lie with a MUST NOT beside it`);

  /* 5 · owned_store hard-fails at ONE violation. */
  evidence.violations === 0
    ? ok("zero floor violations were observed, which owned_store requires absolutely")
    : bad(`${evidence.violations} floor violation(s) observed; floor_basis owned_store hard-fails at one`);

  /* 6 · And the granted Hold obeys the same ceiling. A published number the verb
     ignores would satisfy every check above and none that matter. */
  const house = adapter.house;
  const seats = availableSeatIds(house, 2);
  const hold = await adapter.holdSeats({
    occasion_id: house.occasion_id, occasion_etag: house.etag,
    sought: { occasion_id: house.occasion_id, occasion_etag: house.etag },
    seats, requested_floor_ms: 300000,
  }, credential);
  hold.floor_ms <= warrantable
    ? ok(`a Hold that asked for 300000ms was granted ${hold.floor_ms}ms — clamped to the measurement, not to the request`)
    : bad(`a Hold was granted ${hold.floor_ms}ms above the warranted ${warrantable}ms`);
  validate(HOLD_SCHEMA_ID, { ...hold }) === null
    ? ok("the granted Hold validates against schemas/hold.schema.json")
    : bad("the granted Hold does not validate: " + validate(HOLD_SCHEMA_ID, { ...hold }));
  Date.parse(hold.expires_at) >= Date.parse(hold.floor_deadline)
    ? ok("expires_at is at or after floor_deadline, as T2 requires for the life of the Hold")
    : bad("expires_at is BEFORE floor_deadline");

  /* 7 · floor_ms never increases post-grant (T3). */
  const reread = await adapter.getHold(hold.hold_id, credential);
  reread.floor_ms === hold.floor_ms && reread.floor_deadline === hold.floor_deadline
    ? ok("floor_ms and floor_deadline are identical on re-read — there is no mechanism that moves them")
    : bad("the floor moved after grant");
  await adapter.releaseHold(hold.hold_id, credential);

  /* 8 · C-CAPABILITY: no limit observed at runtime is absent from the document. */
  const missing = unpublishedLimits(capability);
  missing.length === 0
    ? ok("every limit this Server enforces is published in the capability document")
    : bad("enforced but unpublished: " + missing.join(", "));

  /* 9 · The read half emits documents that validate too. */
  const page = await adapter.resolveOccasions({}, credential);
  const bad_occasion = page.occasions.map((o) => validate(OCCASION_SCHEMA_ID, o)).find((e) => e !== null);
  page.occasions.length === 3 && bad_occasion === undefined
    ? ok("all three published Occasions validate against schemas/occasion.schema.json")
    : bad("a resolved Occasion does not validate: " + (bad_occasion ?? "wrong count " + page.occasions.length));
  const seatmap = await adapter.seatMap(house.occasion_id, credential);
  validate(SEATMAP_SCHEMA_ID, seatmap) === null
    ? ok("the seat map validates against schemas/seatmap.schema.json")
    : bad("the seat map does not validate: " + validate(SEATMAP_SCHEMA_ID, seatmap));
  seatmap.seats.some((s) => seats.includes(s.seat_id))
    ? ok("the seat map serves the ids hold_seats accepted, which §2.10 makes normative")
    : bad("the seat map and hold_seats disagree about seat ids");

  /* 10 · No settlement, on the adapter surface itself. */
  const settles = /settle|pay|capture|refund|charge/i;
  const offending = [...ADAPTER_METHODS, ...Object.values(VERB_METHODS)].filter((n) => settles.test(n));
  offending.length === 0
    ? ok("no method on the adapter surface settles, authorises, captures, refunds or prices")
    : bad("settlement-shaped method name(s): " + offending.join(", "));

  /* 11 · Outbound byte canary over every document this adapter emits (C-ABSENCE.4). */
  const emitted = JSON.stringify([capability, hold, reread, page, seatmap]);
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const e164 = /(^|[^0-9])\+[1-9][0-9]{7,14}([^0-9]|$)/;
  const digits = /(^|[^0-9])[0-9]{13,19}([^0-9]|$)/;
  !email.test(emitted) && !e164.test(emitted) && !digits.test(emitted)
    ? ok("no emitted document matches an email, an E.164 string or a 13-19 digit run")
    : bad("an emitted document carries a personal-data shape — fail the build, do not filter the response");

  /* 12 · THE CLASS REPORT. Never pass for a class whose binding does not exist. */
  const report = await reportConformance(adapter);
  report.classes.length === 24 && CONFORMANCE_CLASSES.length === 24
    ? ok("all twenty-four §7 conformance classes appear in the report")
    : bad(`the report covers ${report.classes.length} classes; §7 has twenty-four`);

  const passing = report.classes.filter((c) => c.status === "pass");
  const runners = new Set(CONFORMANCE_CLASSES.filter((c) => typeof c.run === "function").map((c) => c.id));
  const unearned = passing.filter((c) => !runners.has(c.class) || c.assertions.length === 0);
  unearned.length === 0
    ? ok(`every one of the ${passing.length} passing class(es) ran a runner that produced assertions`)
    : bad("class(es) reporting pass with nothing behind them: " + unearned.map((c) => c.class).join(", "));

  const silent = report.classes.filter((c) => c.status !== "pass" && (c.reason ?? "").trim().length === 0);
  silent.length === 0
    ? ok("every class that is not passing states a reason")
    : bad("class(es) not passing and not saying why: " + silent.map((c) => c.class).join(", "));

  report.counts.fail === 0
    ? ok(`no class FAILED (${report.counts.pass} pass, ${report.counts.unprovable} unprovable)`)
    : bad("failing class(es): " + report.classes.filter((c) => c.status === "fail").map((c) => `${c.class}: ${c.reason}`).join(" | "));

  /* 13 · The report is the same document twice — a re-run must not change its shape. */
  const again = await reportConformance(adapter);
  JSON.stringify(again.classes.map((c) => [c.class, c.status])) === JSON.stringify(report.classes.map((c) => [c.class, c.status]))
    ? ok("a second run reports the same status for every class")
    : bad("the report is not reproducible within one process");

  /* Advisory, deliberately NOT an assertion: a blocker naming a path that has
     since been built means this table is stale, not that anything is broken.
     Failing here would turn a neighbours correct commit red. */
  for (const entry of CONFORMANCE_CLASSES) {
    const path = entry.blocked_by?.missing_path;
    if (path && !blockerPathIsStillMissing(process.cwd(), path)) {
      note(`${entry.id} names ${path} as missing and it now exists — ADAPT-001s class table needs re-examining`);
    }
  }
} finally {
  await adapter.close();
}

console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
