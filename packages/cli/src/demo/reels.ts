// The seven reels. Owner: DEMO-001.
//
// Four of them fail, and that is the artefact. A repository whose demo only
// succeeds is a brochure: it shows what the software does when nothing is
// contested, which is the half of the problem nobody needed a protocol for.
// The four refusals are the product — a fan-out that does not happen, a
// price-route that does not happen, an answer that is neither sold out nor
// available, and an ending with no verb after it.
//
// **Every refusal printed here is an object.** Each reel returns the
// `TypedRefusal` that `refusalOf` read off the socket, or `null`. Nothing
// downstream — not the transcript, not `prove_cold_start.sh` — decides what
// happened by matching a string. See `agent.ts` for what `refusalOf` insists on
// before it will call something a refusal.

import type { Db } from "@changeover/store/db.ts";
import { NZ_OCCASION } from "@changeover/store/fixtures.ts";
import type { RefusalCode } from "@changeover/schema/refusal.ts";
import { parseClaimUrl, renderClaim } from "@changeover/core/claim.ts";
import { candidateFromOccasion, maximalAntichain } from "@changeover/semantics/antichain.ts";

import type { Bench, Exhibitor } from "./bench.ts";
import { AGENT_TOKEN, OTHER_TOKEN } from "./bench.ts";
import type { TypedRefusal, Wire } from "./agent.ts";
import { call, idempotencyKey, intentDigest, refusalOf } from "./agent.ts";

/* ── 1 · What a reel is ────────────────────────────────────────────────────── */

export const REEL_IDS = [
  "resolve",
  "hold",
  "cluster_fanout",
  "substitution_refused",
  "availability_unknown",
  "hand_off",
  "hold_expired",
] as const;
export type ReelId = (typeof REEL_IDS)[number];

/**
 * The four codes this run must produce, in reel order.
 *
 * The gate asserts the run's refusals against exactly this list. It is here and
 * not in the proof script so that a reel and its expectation cannot drift apart
 * in two files — the script imports this.
 */
export const EXPECTED_REFUSALS: readonly RefusalCode[] = Object.freeze([
  "cluster_fanout",
  "substitution_refused",
  "availability_unknown",
  "hold_expired",
]);

export interface Beat {
  /** `→` a call · `←` its answer · `·` a note · `?` a gate · `#` a row count · `…` a wait. */
  readonly mark: "→" | "←" | "·" | "?" | "#" | "…";
  readonly text: string;
  /** Real elapsed milliseconds, where this beat took any. */
  readonly ms?: number;
  /** Indented structured evidence, printed verbatim under the beat. */
  readonly block?: readonly string[];
}

export interface Reel {
  readonly n: number;
  readonly id: ReelId;
  readonly title: string;
  /** One line on why this reel is in the demo at all. */
  readonly premise: string;
  readonly outcome: "ok" | "refused";
  readonly refusal: TypedRefusal | null;
  readonly beats: readonly Beat[];
  readonly ms: number;
}

/** Threaded through the seven, because reel 6 hands off what reel 2 held. */
export interface RunState {
  readonly bench: Bench;
  /** Occasion documents as they came back from `resolve_occasions`. */
  occasions: Map<string, Record<string, unknown>>;
  hold_id: string | null;
  hold_seats: readonly string[];
  hold_expires_at: string | null;
  read_token: string | null;
  claim_url: string | null;
  /** The short-floored Hold reel 7 lets run out, held by the second household. */
  doomed_hold_id: string | null;
  doomed_expires_at: string | null;
}

export function newRunState(bench: Bench): RunState {
  return {
    bench,
    occasions: new Map(),
    hold_id: null,
    hold_seats: [],
    hold_expires_at: null,
    read_token: null,
    claim_url: null,
    doomed_hold_id: null,
    doomed_expires_at: null,
  };
}

/* ── 2 · Small shared shapes ───────────────────────────────────────────────── */

const money = (minor: number, currency: string): string =>
  `${currency} ${(minor / 100).toFixed(2)}`;

function answered(wire: Wire): Beat {
  return { mark: "←", text: `${wire.status} · server_time ${wire.server_time ?? "(absent)"}`, ms: wire.ms };
}

function requested(wire: Wire): Beat {
  return { mark: "→", text: `${wire.method} ${wire.path}` };
}

function refusalBeats(refusal: TypedRefusal): Beat[] {
  const block = [
    `code         ${refusal.code}`,
    `status       ${refusal.status}`,
    `remediation  ${refusal.remediation}`,
    ...(refusal.retry_after_ms === null ? [] : [`retry_after  ${refusal.retry_after_ms}ms`]),
    ...(refusal.detail === null
      ? []
      : Object.entries(refusal.detail).map(
        ([k, v]) => `detail.${k.padEnd(12)} ${typeof v === "string" ? v : JSON.stringify(v)}`,
      )),
  ];
  return [
    { mark: "·", text: "the next action comes from code and remediation, not from the sentence", block },
    { mark: "·", text: `reason (prose, non-load-bearing): "${refusal.reason}"` },
  ];
}

/** The Occasion document this reel is about, as `resolve_occasions` returned it. */
function documentOf(state: RunState, occasion_id: string): Record<string, unknown> {
  const found = state.occasions.get(occasion_id);
  if (found === undefined) {
    throw new Error(`demo: ${occasion_id} was not returned by resolve_occasions`);
  }
  return found;
}

const etagOf = (document: Record<string, unknown>): string => String(document.etag);
const wallOf = (document: Record<string, unknown>): string =>
  String((document.instant as Record<string, unknown>).local_wall);
const venueOf = (document: Record<string, unknown>): string =>
  String(((document.venue as Record<string, unknown>).name as Record<string, unknown>).value);
const classesOf = (document: Record<string, unknown>): string[] =>
  ((document.manner as Record<string, unknown>).presentation_classes as string[]) ?? [];
const offerOf = (document: Record<string, unknown>): Record<string, unknown> =>
  ((document.offers as Record<string, unknown>[]) ?? [])[0] ?? {};

/** A `hold_seats` body against one Occasion, sought = held unless told otherwise. */
function holdBody(
  held: Record<string, unknown>,
  quantity: number,
  sought?: Record<string, unknown>,
): Record<string, unknown> {
  const target = sought ?? held;
  return {
    occasion_id: held.occasion_id,
    occasion_etag: etagOf(held),
    // §2.3: "the Occasion the customer's expressed intent selected". Where it
    // differs from `occasion_id`, S1 decides at commit whether that is allowed.
    sought: { occasion_id: target.occasion_id, occasion_etag: etagOf(target) },
    // W4: seat choice within one named Occasion is the exhibitor's own
    // allocation. The boundary asks for two together and the house decides which.
    selection: { mode: "best_available", quantity, together: true },
    requested_floor_ms: 120000,
    intent_digest: intentDigest(),
  };
}

/* ── 3 · Reel 1 — resolve, and the antichain ───────────────────────────────── */

async function resolveOne(
  state: RunState,
  exhibitor: Exhibitor,
  beats: Beat[],
): Promise<void> {
  const wire = await call(exhibitor, "GET", "/changeover/v0/occasions", { token: AGENT_TOKEN });
  beats.push(requested(wire), answered(wire));
  const body = wire.body as { occasions?: Record<string, unknown>[] };
  for (const document of body.occasions ?? []) {
    state.occasions.set(String(document.occasion_id), document);
  }
  const n = (body.occasions ?? []).length;
  beats.push({
    mark: "·",
    text: `${exhibitor.venue_name} (${exhibitor.origin}) published ${n} occasion${n === 1 ? "" : "s"}`,
  });
}

async function reelResolve(state: RunState): Promise<Reel> {
  const started = Date.now();
  const beats: Beat[] = [];

  beats.push({
    mark: "·",
    text: '"Find me a good way to see The Conversation this weekend." Two exhibitors answer.',
  });
  await resolveOne(state, state.bench.circuit, beats);
  await resolveOne(state, state.bench.independent, beats);

  const documents = [...state.occasions.values()];
  const result = maximalAntichain(documents.map((d) => candidateFromOccasion(d)));

  const rows: string[] = [];
  for (const member of result.members) {
    const document = documentOf(state, member.occasion_id);
    const offer = offerOf(document);
    const manner = document.manner as Record<string, unknown>;
    const access = (manner.accessibility ?? {}) as Record<string, unknown>;
    const availability = document.availability as Record<string, unknown>;
    rows.push(
      `${venueOf(document)} · ${wallOf(document)} · ${classesOf(document)[0]} · ` +
        `${money(Number(offer.amount_minor ?? 0), String(offer.currency ?? "NZD"))}`,
    );
    rows.push(`    axes        ${member.distinguishing_axes.join(", ") || "(none)"}`);
    // The axes are the protocol's answer and they are a union over every other
    // candidate, so on a set this small they are the same list three times. The
    // values underneath them are what a human is actually choosing between, and
    // printing only the axis names would be the "distinguished, somehow" that
    // §2.3 exists to replace.
    rows.push(
      `    reads as    open_captions ${String(access.open_captions)} · ` +
        `${String(availability.mode) === "unknown" ? "availability unknown" : `${String(availability.seats_available)} seats free`}` +
        `${member.supersedes.length === 0 ? "" : ` · supersedes ${member.supersedes.map((s) => s.occasion_id).join(", ")}`}`,
    );
  }
  beats.push({
    mark: "·",
    text: `the maximal antichain: ${result.members.length} options, and they are a set, not a ranking`,
    block: rows,
  });

  for (const dropped of result.dropped) {
    const document = documentOf(state, dropped.occasion_id);
    beats.push({
      mark: "·",
      text:
        `dropped ${venueOf(document)} ${wallOf(document)} — it attests that ` +
        `${dropped.dominated_by.join(", ")} is an acceptable substitute FOR IT, across ` +
        `${dropped.axes.join(", ")}. The edge does not run the other way.`,
    });
  }
  beats.push({
    mark: "·",
    text:
      "what the Agent does NOT say is \"the cheapest is NZD 12.00\". It says: here are the " +
      "options nothing else supersedes, and here is what makes each of them itself.",
  });
  beats.push({
    mark: "·",
    text:
      "note that a surviving option is not a bookable one. The Whitcombe publishes no seat map, " +
      "so it is an honest option with an unknown answer — reel 5 goes and asks.",
  });

  return {
    n: 1,
    id: "resolve",
    title: "Resolve — the maximal antichain, with axes",
    premise: "An ordering across a strict boundary is a lie an Agent tells confidently.",
    outcome: "ok",
    refusal: null,
    beats,
    ms: Date.now() - started,
  };
}

/* ── 4 · Reel 2 — the gate fires first, from structure ─────────────────────── */

async function reelHold(state: RunState): Promise<Reel> {
  const started = Date.now();
  const beats: Beat[] = [];
  const document = documentOf(state, NZ_OCCASION.kereru);
  const offer = offerOf(document);
  const quantity = 2;

  // §9's gate, and every member of it is read from the published document. A
  // gate assembled from a sentence the Server sent would be a gate the Server
  // could write; this one an Agent can render with the network unplugged.
  beats.push({
    mark: "?",
    text: "gate_stage is \"hold\", so the human confirms BEFORE a seat is locked — from structure",
    block: [
      `seat_count            ${quantity}`,
      `venue_name            ${venueOf(document)}`,
      `local_wall            ${wallOf(document)}`,
      `presentation_classes  ${JSON.stringify(classesOf(document))}`,
      `amount_minor          ${Number(offer.amount_minor ?? 0) * quantity}`,
      `currency              ${String(offer.currency ?? "NZD")}`,
    ],
  });
  beats.push({
    mark: "·",
    text:
      `caption (prose, and nothing decides on it): "Two seats for The Conversation on 35mm at ` +
      `${venueOf(document)}, ${wallOf(document)}, ` +
      `${money(Number(offer.amount_minor ?? 0) * quantity, String(offer.currency ?? "NZD"))}."`,
  });
  beats.push({ mark: "·", text: "the human says yes." });

  const wire = await call(state.bench.circuit, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": idempotencyKey() },
    body: holdBody(document, quantity),
  });
  beats.push(requested(wire), answered(wire));

  const hold = wire.body as Record<string, unknown>;
  const refusal = refusalOf(wire);
  if (refusal !== null) {
    return {
      n: 2,
      id: "hold",
      title: "Hold two seats",
      premise: "The gate fires before the lock, and the floor is a number the Server measured.",
      outcome: "refused",
      refusal,
      beats: [...beats, ...refusalBeats(refusal)],
      ms: Date.now() - started,
    };
  }

  state.hold_id = String(hold.hold_id);
  state.hold_seats = (hold.seats as string[]) ?? [];
  state.hold_expires_at = String(hold.expires_at);

  beats.push({
    mark: "·",
    text: "the house chose the seats, because W4 says seat choice inside one Occasion is its allocation",
    block: [
      `hold_id        ${hold.hold_id}`,
      `state          ${hold.state}`,
      `seats          ${JSON.stringify(hold.seats)}`,
      `granted_at     ${hold.granted_at}`,
      `floor_ms       ${hold.floor_ms}   (asked for 120000)`,
      `floor_deadline ${hold.floor_deadline}`,
      `expires_at     ${hold.expires_at}`,
      `extendable     ${hold.extendable}`,
      `cluster        ${hold.cluster ?? "(none)"}`,
    ],
  });
  beats.push({
    mark: "·",
    text:
      `floor_ms is min(requested, policy_max) and the Server may return less. ` +
      `This one publishes ${state.bench.circuit.policy.policy_max_floor_ms}ms because that is ` +
      `${state.bench.circuit.measurement.evidence.min_observed_retention_ms}ms of observed retention ` +
      `minus a ${state.bench.circuit.measurement.evidence.safety_margin_ms}ms margin, measured ` +
      `on the way up. That number, and nothing else, is what the Agent may plan against.`,
  });
  beats.push({ mark: "·", text: "intent_digest was accepted and is not echoed anywhere in that document (D4)." });

  return {
    n: 2,
    id: "hold",
    title: "Hold two seats",
    premise: "The gate fires before the lock, and the floor is a number the Server measured.",
    outcome: "ok",
    refusal: null,
    beats,
    ms: Date.now() - started,
  };
}

/* ── 5 · Reel 3 — the hedge, refused ───────────────────────────────────────── */

async function reelClusterFanout(state: RunState): Promise<Reel> {
  const started = Date.now();
  const beats: Beat[] = [
    {
      mark: "·",
      text:
        "the Agent hedges: it also wants the Sunday matinee, in case the human changes their mind. " +
        "Same household, same demand cluster.",
    },
  ];
  const document = documentOf(state, NZ_OCCASION.totara_2);
  const wire = await call(state.bench.circuit, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": idempotencyKey() },
    body: holdBody(document, 2),
  });
  beats.push(requested(wire), answered(wire));

  const refusal = refusalOf(wire);
  if (refusal !== null) beats.push(...refusalBeats(refusal));
  beats.push({
    mark: "·",
    text:
      "enforced by a unique index on (agent_id, principal_scope, origin, cluster), not by a count: " +
      "at READ COMMITTED two requests three milliseconds apart both count zero and both commit.",
  });
  beats.push({
    mark: "·",
    text:
      "so the Friday seats are still the customer's, rather than one of four speculative holds " +
      "an Agent abandons in ninety seconds. A second household at a different principal_scope is unaffected — reel 7 is one.",
  });

  return {
    n: 3,
    id: "cluster_fanout",
    title: "The hedge — refused",
    premise: "Fan-out is how an agent turns a boundary into an outage for everyone else.",
    outcome: refusal === null ? "ok" : "refused",
    refusal,
    beats,
    ms: Date.now() - started,
  };
}

/* ── 6 · Reel 4 — the price-route, refused. The thesis. ────────────────────── */

async function seatRowsFor(db: Db, showtime_id: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    "select count(*)::text as n from hold_seat where showtime_id = $1",
    [showtime_id],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function reelSubstitutionRefused(state: RunState): Promise<Reel> {
  const started = Date.now();
  const held = documentOf(state, NZ_OCCASION.totara_4);
  const sought = documentOf(state, NZ_OCCASION.kereru);

  const before = await seatRowsFor(state.bench.circuit.db, NZ_OCCASION.totara_4);
  const held_elsewhere = await seatRowsFor(state.bench.circuit.db, NZ_OCCASION.kereru);
  const beats: Beat[] = [
    {
      mark: "·",
      text:
        "the Agent notices the same film is NZD 9.00 cheaper at 21:15 on a DCP, and routes the " +
        "customer onto it. `sought` still names the 35mm print, because that is what the human chose.",
    },
    {
      mark: "#",
      // Both counts, because a zero on one showtime is only evidence if the same
      // query returns a non-zero on another: an empty table and a broken
      // predicate print the same digit.
      text:
        `hold_seat rows before — ${NZ_OCCASION.totara_4}: ${before} · ` +
        `${NZ_OCCASION.kereru}: ${held_elsewhere} (reel 2's two seats, by the same query)`,
    },
  ];

  const wire = await call(state.bench.circuit, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": idempotencyKey() },
    body: holdBody(held, 2, sought),
  });
  beats.push(requested(wire), answered(wire));

  const refusal = refusalOf(wire);
  if (refusal !== null) beats.push(...refusalBeats(refusal));

  const after = await seatRowsFor(state.bench.circuit.db, NZ_OCCASION.totara_4);
  const still_held = await seatRowsFor(state.bench.circuit.db, NZ_OCCASION.kereru);
  beats.push({
    mark: "#",
    text:
      `hold_seat rows after — ${NZ_OCCASION.totara_4}: ${after} · ${NZ_OCCASION.kereru}: ${still_held}. ` +
      "Asserted against the store, because the response would read the same either way.",
  });
  beats.push({
    mark: "·",
    text:
      "G1 step 7 decided this. The Agent also has a live hold in this cluster, so step 8 would have " +
      "refused it too — the guard order is a table, and the earlier step wins.",
  });
  beats.push({
    mark: "·",
    text:
      "this is the whole product in one refusal, and it is a mechanism rather than a promise only " +
      "because `sought` exists. It is also the honest limit: an Agent that sets sought = occasion_id " +
      "and lies is indistinguishable from one whose customer asked for the DCP (S4).",
  });

  return {
    n: 4,
    id: "substitution_refused",
    title: "The price-route — refused, 412",
    premise: "A cheaper screening of the same film is a different thing, and the publisher said so.",
    outcome: refusal === null ? "ok" : "refused",
    refusal,
    beats,
    ms: Date.now() - started,
  };
}

/* ── 7 · Reel 5 — neither sold out nor available ───────────────────────────── */

async function reelAvailabilityUnknown(state: RunState): Promise<Reel> {
  const started = Date.now();
  const document = documentOf(state, NZ_OCCASION.whitcombe);
  const availability = document.availability as Record<string, unknown>;
  const beats: Beat[] = [
    {
      mark: "·",
      text: "a different exhibitor, a different origin, and a house that publishes no seat map at all",
      block: [
        `availability.mode             ${String(availability.mode)}`,
        `availability.staleness_basis  ${String(availability.staleness_basis)}`,
        `availability.sold_out         ${"sold_out" in availability ? String(availability.sold_out) : "(absent)"}`,
        `availability.seats_available  ${"seats_available" in availability ? String(availability.seats_available) : "(absent)"}`,
      ],
    },
  ];

  const wire = await call(state.bench.independent, "POST", "/changeover/v0/holds", {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": idempotencyKey() },
    body: holdBody(document, 2),
  });
  beats.push(requested(wire), answered(wire));

  const refusal = refusalOf(wire);
  if (refusal !== null) beats.push(...refusalBeats(refusal));
  beats.push({
    mark: "·",
    text:
      "an Agent MUST NOT read this as sold out and MUST NOT read it as available. That is why it is " +
      "its own member of the taxonomy rather than a 404 or a sold_out: true — both of which would " +
      "have been a confident answer to a question nobody could answer.",
  });

  return {
    n: 5,
    id: "availability_unknown",
    title: "Neither sold out nor available",
    premise: "The refusal a system without this code has to fake.",
    outcome: refusal === null ? "ok" : "refused",
    refusal,
    beats,
    ms: Date.now() - started,
  };
}

/* ── 8 · Reel 6 — hand off, and a link scanner that consumes nothing ───────── */

async function reelHandOff(state: RunState): Promise<Reel> {
  const started = Date.now();
  const beats: Beat[] = [];
  const hold_id = state.hold_id;
  if (hold_id === null) throw new Error("demo: reel 6 has no Hold to hand off");

  const read = await call(state.bench.circuit, "GET", `/changeover/v0/holds/${hold_id}`, {
    token: AGENT_TOKEN,
  });
  beats.push(requested(read), answered(read));
  const held = read.body as Record<string, unknown>;
  state.read_token = String(held.read_token);
  beats.push({
    mark: "·",
    text: "expires_at may move, upward only (T7). floor_deadline never moves (T3).",
    block: [
      `state          ${held.state}`,
      `expires_at     ${held.expires_at}${held.expires_at === state.hold_expires_at ? "  (unmoved)" : "  (moved up)"}`,
      `floor_deadline ${held.floor_deadline}`,
      `read_token     ${String(held.read_token).slice(0, 12)}…  (T4: proof the Agent looked before it leapt)`,
    ],
  });

  const wire = await call(state.bench.circuit, "POST", `/changeover/v0/holds/${hold_id}/hand-off`, {
    token: AGENT_TOKEN,
    headers: { "Idempotency-Key": idempotencyKey() },
    body: { read_token: state.read_token },
  });
  beats.push(requested(wire), answered(wire));

  const body = wire.body as Record<string, unknown>;
  const handoff = (body.handoff ?? {}) as Record<string, unknown>;
  state.claim_url = String(handoff.claim_url);
  const claim_origin = new URL(state.claim_url).origin;

  beats.push({
    mark: "·",
    text: `the claim URL is on the exhibitor's own domain — O1, compared as a parsed (scheme, host, port) triple`,
    block: [
      `state              ${body.state}`,
      `handed_off_at      ${handoff.handed_off_at}`,
      `handoff_floor_ms   ${handoff.handoff_floor_ms}`,
      `claim_url          ${state.claim_url}`,
      `claim_expires_at   ${handoff.claim_expires_at}`,
      `claim origin       ${claim_origin}  ${claim_origin === state.bench.circuit.origin ? "= venue.origin" : "≠ venue.origin"}`,
    ],
  });

  // CL2, exercised rather than asserted: a GET renders and consumes nothing.
  // `renderClaim` opens `SET TRANSACTION READ ONLY`, so this is a property of
  // the store and not of this file's current contents.
  const presented = parseClaimUrl(state.claim_url);
  if (presented === null) throw new Error("demo: the claim URL did not parse");
  const scans: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const outcome = await renderClaim(state.bench.circuit.db, presented, {
      secret: state.bench.circuit.claim_secret,
    });
    scans.push(
      `GET #${i}  ok=${outcome.ok}  state=${outcome.state ?? "-"}  ` +
        `consumed=${outcome.ok ? String(outcome.consumed) : "-"}`,
    );
  }
  beats.push({
    mark: "·",
    text: "a link scanner fetches the URL three times before a human ever sees it",
    block: scans,
  });

  const after = await call(state.bench.circuit, "GET", `/changeover/v0/holds/${hold_id}`, {
    token: AGENT_TOKEN,
  });
  beats.push(requested(after), answered(after));
  const still = after.body as Record<string, unknown>;
  beats.push({
    mark: "·",
    text: `the Hold is still ${still.state} and the seats are still ${JSON.stringify(still.seats)}`,
  });
  beats.push({
    mark: "·",
    text:
      "release_hold is refused from here on (R1) — the seats belong to the customer and the " +
      "exhibitor now, not to the Agent that fetched them. It is not called, because this run " +
      "refuses exactly four times and each of those four is a thing worth showing.",
  });
  beats.push({
    mark: "·",
    text:
      "the customer opens a page on the cinema's own domain, seats warm, with the F&B upsell " +
      "exactly where the exhibitor already put it. Both projectors are running.",
  });

  return {
    n: 6,
    id: "hand_off",
    title: "Hand off — the customer's own cinema, seats still there",
    premise: "The boundary ends at the exhibitor's checkout, and a prefetch does not spend it.",
    outcome: "ok",
    refusal: null,
    beats,
    ms: Date.now() - started,
  };
}

/* ── 9 · Reel 7 — the ending with no verb after it ─────────────────────────── */

const EXPIRY_MARGIN_MS = 400;

async function reelHoldExpired(state: RunState): Promise<Reel> {
  const started = Date.now();
  const beats: Beat[] = [
    {
      mark: "·",
      text:
        "a second household, on the same platform, at a different principal_scope. Reel 3's " +
        "fan-out refusal said nothing about them, and here is that being true.",
    },
  ];
  const document = documentOf(state, NZ_OCCASION.totara_2);

  const granted = await call(state.bench.circuit, "POST", "/changeover/v0/holds", {
    token: OTHER_TOKEN,
    headers: { "Idempotency-Key": idempotencyKey() },
    // The schema minimum. A real Server publishes minutes; one second is what
    // lets this reel end by WAITING rather than by moving a clock, and a demo
    // that moved the clock would be demonstrating its own fixture.
    body: { ...holdBody(document, 2), requested_floor_ms: 1000 },
  });
  beats.push(requested(granted), answered(granted));

  const hold = granted.body as Record<string, unknown>;
  const hold_id = String(hold.hold_id);
  state.doomed_hold_id = hold_id;
  state.doomed_expires_at = String(hold.expires_at);
  beats.push({
    mark: "·",
    text: "granted, in the same cluster reel 3 was refused in, because the household is a different one",
    block: [
      `hold_id     ${hold_id}`,
      `seats       ${JSON.stringify(hold.seats)}`,
      `floor_ms    ${hold.floor_ms}`,
      `expires_at  ${hold.expires_at}`,
    ],
  });

  const read = await call(state.bench.circuit, "GET", `/changeover/v0/holds/${hold_id}`, {
    token: OTHER_TOKEN,
  });
  beats.push(requested(read), answered(read));
  const read_token = String((read.body as Record<string, unknown>).read_token);

  // Waited out against the Server's own `expires_at`, not against a local
  // stopwatch: K4 says there is one clock and it is the store's.
  const wait_ms = Math.max(0, Date.parse(String(hold.expires_at)) - Date.now()) + EXPIRY_MARGIN_MS;
  const waited = Date.now();
  await new Promise<void>((resolve) => setTimeout(resolve, wait_ms));
  beats.push({
    mark: "…",
    text: "the customer goes to ask their partner about Saturday",
    ms: Date.now() - waited,
  });

  const wire = await call(state.bench.circuit, "POST", `/changeover/v0/holds/${hold_id}/hand-off`, {
    token: OTHER_TOKEN,
    headers: { "Idempotency-Key": idempotencyKey() },
    body: { read_token },
  });
  beats.push(requested(wire), answered(wire));

  const refusal = refusalOf(wire);
  if (refusal !== null) beats.push(...refusalBeats(refusal));
  beats.push({
    mark: "·",
    text:
      "a sentence an Agent can say to a human: the hold ran out while you were deciding, and " +
      "these are the seats now. Not an error page.",
  });
  beats.push({
    mark: "·",
    text:
      "and the transcript ends here. There is no settlement verb — not deferred, not " +
      "permission-checked, absent — so the Agent cannot continue, and the log never learns " +
      "whether the tickets were bought.",
  });

  return {
    n: 7,
    id: "hold_expired",
    title: "The hold ran out — and there is nothing after it",
    premise: "The failure a brochure omits, and the ending the protocol is designed to have.",
    outcome: refusal === null ? "ok" : "refused",
    refusal,
    beats,
    ms: Date.now() - started,
  };
}

/* ── 10 · The seven, in order ──────────────────────────────────────────────── */

export const REELS: readonly ((state: RunState) => Promise<Reel>)[] = Object.freeze([
  reelResolve,
  reelHold,
  reelClusterFanout,
  reelSubstitutionRefused,
  reelAvailabilityUnknown,
  reelHandOff,
  reelHoldExpired,
]);
