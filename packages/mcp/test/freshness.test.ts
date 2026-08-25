/**
 * SEP-2549's arithmetic, as arithmetic. An off-by-one in a `min()` is cheapest
 * to find here and most expensive to find as an agent holding seats at a house
 * that closed forty seconds ago.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CACHE_SCOPE,
  FRESHNESS_CEILING_MS,
  cacheable,
  freshnessOf,
  pageTtlMs,
} from "../src/freshness.ts";
import { containsUri, gatePrompt, gates, inputRequired } from "../src/gate.ts";

const NOW = "2026-08-29T19:00:00+12:00";
const at = (minutes: number) =>
  new Date(Date.parse(NOW) + minutes * 60000).toISOString().replace("Z", "+00:00");

test("an empty page still carries a ttl, because a screening can be published in the next thirty seconds", () => {
  assert.equal(pageTtlMs([], NOW), FRESHNESS_CEILING_MS);
});

test("the ceiling binds whatever a publisher writes", () => {
  assert.equal(pageTtlMs([{ max_staleness_ms: 3600000, sales_cutoff_at: at(600) }], NOW), 30000);
});

test("a published max_staleness_ms below the ceiling is what sets the ttl", () => {
  assert.equal(pageTtlMs([{ max_staleness_ms: 5000, sales_cutoff_at: at(600) }], NOW), 5000);
});

test("the cutoff wins where the screening closes sooner than the staleness budget", () => {
  // Ten seconds to the cutoff, against a thirty-second staleness budget.
  const soon = new Date(Date.parse(NOW) + 10000).toISOString().replace("Z", "+00:00");
  assert.equal(pageTtlMs([{ max_staleness_ms: 30000, sales_cutoff_at: soon }], NOW), 10000);
});

test("the minimum is taken across the whole page, because one result is one cache entry", () => {
  const page = [
    { max_staleness_ms: 30000, sales_cutoff_at: at(600) },
    { max_staleness_ms: 5000, sales_cutoff_at: at(600) },
  ];
  // The page's MAXIMUM would be 30000 and would serve the five-second screening
  // stale — the arithmetic that picks exactly the wrong one.
  assert.equal(pageTtlMs(page, NOW), 5000);
});

test("a screening already past its cutoff makes the page uncacheable rather than briefly fresh", () => {
  assert.equal(pageTtlMs([{ max_staleness_ms: 30000, sales_cutoff_at: at(-5) }], NOW), 0);
});

test("an Occasion publishing neither term contributes nothing but does not break the min()", () => {
  assert.equal(pageTtlMs([{}, { max_staleness_ms: 12000 }], NOW), 12000);
});

test("cacheScope is session, so two principals never share an entry", () => {
  assert.equal(cacheable([], NOW).cacheScope, CACHE_SCOPE);
  assert.equal(CACHE_SCOPE, "session");
});

test("the two terms are read out of a published Occasion, and a malformed one yields nulls", () => {
  const document = {
    availability: { max_staleness_ms: 5000 },
    instant: { sales_cutoff_at: at(15) },
  };
  assert.deepEqual(freshnessOf(document), {
    max_staleness_ms: 5000,
    sales_cutoff_at: at(15),
  });
  assert.deepEqual(freshnessOf(null), {});
  assert.deepEqual(freshnessOf({}), { max_staleness_ms: null, sales_cutoff_at: null });
});

/* -- X6 / X6a --------------------------------------------------------------- */

const FACTS = {
  seat_count: 2,
  venue_name: "Embassy Theatre",
  local_wall: "2026-08-29T19:00",
  presentation_classes: ["carrier:35mm"],
  amount_minor: 2400,
  currency: "NZD",
};

test("X6 — absence of an attended grant means the gate fires, not that it is skipped", () => {
  assert.equal(gates("hold_seats", {}), true);
  assert.equal(gates("hold_seats", { attended: true }), false);
  // A Server that gated only when told to would gate never.
  assert.equal(gates("hold_seats", { attended: false }), true);
});

test("the gate fires at the stage gate_stage names, and at no other", () => {
  assert.equal(gates("hold_seats", { gate_stage: "hold" }), true);
  assert.equal(gates("hand_off", { gate_stage: "hold" }), false);
  assert.equal(gates("hand_off", { gate_stage: "handoff" }), true);
  assert.equal(gates("hold_seats", { gate_stage: "handoff" }), false);
  assert.equal(gates("hold_seats", { gate_stage: "none" }), false);
});

test("X6a — the prompt is a prose envelope carrying no URI", () => {
  const prompt = gatePrompt(FACTS);
  assert.equal(prompt.content_type, "text/plain");
  assert.equal(containsUri(prompt.value), false);
  assert.match(prompt.value, /2 seats/);
  assert.match(prompt.value, /Embassy Theatre/);
});

test("one seat reads as one seat, because a dialog a human reads is read by a human", () => {
  assert.match(gatePrompt({ ...FACTS, seat_count: 1 }).value, /1 seat\b/);
});

test("the URI check catches what renders as a link, not only what parses as a URI", () => {
  assert.equal(containsUri("https://tickets.example/claim"), true);
  assert.equal(containsUri("visit www.embassy.example now"), true);
  assert.equal(containsUri("mailto:boxoffice@embassy.example"), true);
  assert.equal(containsUri("embassy.example"), true);
  assert.equal(containsUri("Hold 2 seats at Embassy Theatre on 2026-08-29T19:00?"), false);
  // Case-sensitive on the bare-authority rule: a sentence is not a hostname,
  // and a gate that refused St.James would be a rule somebody turns off.
  assert.equal(containsUri("Hold 2 seats at St.James on 2026-08-29T19:00?"), false);
});

test("a venue name carrying a link is refused rather than rendered into the dialog", () => {
  assert.throws(
    () => gatePrompt({ ...FACTS, venue_name: "Embassy https://evil.example" }),
    /X6a/,
  );
});

test("the InputRequiredResult carries I7 marker and all six structured members", () => {
  const gate = inputRequired("hold", FACTS);
  assert.equal(gate.input_required, true);
  assert.equal(gate.stage, "hold");
  assert.equal(gate.inputRequests.length, 1);
  for (const member of Object.keys(FACTS)) {
    assert.ok(Object.hasOwn(gate.inputRequests[0]!, member), member);
  }
});

test("at price_disclosure at_checkout the gate says it has no number rather than inventing one", () => {
  const gate = inputRequired("hold", { ...FACTS, amount_minor: null, currency: null });
  assert.equal(gate.inputRequests[0]!.amount_minor, null);
  assert.equal(gate.inputRequests[0]!.currency, null);
});
