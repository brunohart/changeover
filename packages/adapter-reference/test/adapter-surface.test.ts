/**
 * The adapter interface, as a contract three implementations must satisfy.
 * Owner: ADAPT-001.
 *
 * ADAPT-002 (Vista-shaped, Profile 1S) and ADAPT-003 (read-only probe, Profile
 * 0) are written against this file and must not need to change it. These are
 * the properties that make that possible, asserted here rather than discovered
 * at integration — where "the interface needs one more method" is a change to
 * every implementation of it at once.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isRefusal } from "@changeover/schema/refusal.ts";
import {
  ADAPTER_METHODS,
  FLOOR_BASIS,
  HOLD_BASIS,
  PROFILES,
  VERBS,
  VERB_METHODS,
  WRITE_METHODS,
  floorUnavailable,
  profileNotSupported,
} from "@changeover/adapter-reference/adapter.ts";

test("the five verbs of schemas/verbs.json each map to exactly one method, and there is no sixth", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const verbs = JSON.parse(await readFile(`${root}schemas/verbs.json`, "utf8")) as
    | { verbs: string[] }
    | string[];
  const published = Array.isArray(verbs) ? verbs : verbs.verbs;

  assert.equal(VERBS.length, 5, "five verbs, and the absent one is absent by construction");
  assert.deepEqual(
    [...VERBS].sort(),
    [...published].sort(),
    "the adapter's verb set and the frozen verbs.json are the same set, both directions",
  );
  for (const verb of VERBS) {
    assert.ok(
      ADAPTER_METHODS.includes(VERB_METHODS[verb]),
      `${verb} maps to ${VERB_METHODS[verb]}, which must be a method on the interface`,
    );
  }
});

test("no name on the surface settles, authorises, captures, refunds or prices", () => {
  // C-ABSENCE.1's own pattern, applied to the adapter surface. It matches
  // substrings, which is why `payload`, `charge` and `capture` are banned as
  // identifiers here even where they would be innocent.
  const settles = /settle|pay|capture|refund|charge/i;
  for (const name of [...ADAPTER_METHODS, ...Object.values(VERB_METHODS)]) {
    assert.doesNotMatch(name, settles, `${name} is a settlement-shaped name on a boundary that settles nothing`);
  }
});

test("the interface is total: a Profile 0 adapter answers every write method rather than omitting it", () => {
  assert.deepEqual([...WRITE_METHODS], ["holdSeats", "getHold", "releaseHold", "handOff"]);
  for (const method of WRITE_METHODS) {
    assert.ok(ADAPTER_METHODS.includes(method), `${method} must be on the interface for Profile 0 to refuse it`);
  }
  // The refusal, not a TypeError. §6.3 gives Profile 0's hold verbs a code
  // precisely so an Agent is told what happened rather than handed a fault.
  assert.throws(
    () => profileNotSupported("0", "hold_seats"),
    (err: unknown) => isRefusal(err) && err.code === "profile_not_supported",
  );
});

test("an unmeasured floor is a refusal with a retry, not a number", () => {
  assert.throws(
    () => floorUnavailable(),
    (err: unknown) =>
      isRefusal(err) && err.code === "floor_unavailable" && err.retry_after_ms === 5000,
  );
  assert.throws(
    () => floorUnavailable(1500),
    (err: unknown) => isRefusal(err) && err.retry_after_ms === 1500,
  );
});

test("the three declarations are closed enums the report is keyed on", () => {
  assert.deepEqual([...PROFILES], ["0", "1", "1S"]);
  assert.deepEqual(Object.values(HOLD_BASIS), ["system_of_record", "shadow"]);
  assert.deepEqual(Object.values(FLOOR_BASIS), ["owned_store", "measured_warranty"]);
});
