/**
 * SEP-2322, the human gate — X6, X6a, X6b.
 *
 * X6: *"A Server MUST return an `InputRequiredResult` at the stage named by
 * `gate_stage` unless the credential carries an exhibitor-issued `attended:
 * true` grant; **absence means false**."*
 *
 * Three things this module refuses to pretend.
 *
 * **X6b — the Agent renders the gate.** A gate proves the Server demanded a
 * human decision. It does not prove a human made one. It is a speed bump
 * against unattended fan-out, not consent, and the honest place to say so is
 * next to the code that builds one.
 *
 * **X6a — the prompt is a caption, not the contract.** `prompt` travels in a
 * prose envelope, carries no URI, and is *accompanied* by structured members —
 * `seat_count`, `venue_name`, `local_wall`, `presentation_classes`,
 * `amount_minor`, `currency` — so a conforming Agent renders from the
 * structure. A gate whose only content is a sentence is a gate an injected
 * instruction can write, and the no-URI rule is what stops the dialog a human
 * is about to approve from carrying a link somewhere else.
 *
 * **I7 — a gate is not an operation.** A call returning `input_required`
 * records no idempotency entry and the same key MUST be accepted on the
 * gate-satisfying retry. That is enforced structurally in `withIdempotency`,
 * which releases the key for anything carrying `input_required: true`; this
 * module's job is only to return a shape that satisfies `isInputRequired`.
 */

import type { InputRequiredResult } from "@changeover/core/idempotency.ts";
import type { GateStage } from "@changeover/core/principal.ts";
import { GATE_STAGE } from "@changeover/core/principal.ts";
import type { Prose } from "@changeover/schema/scalars.ts";
import { prose } from "@changeover/schema/scalars.ts";

/**
 * X6a's structured members. Every one is rendered by the Agent; the prose is
 * a caption over them.
 */
export interface GateFacts {
  readonly seat_count: number;
  readonly venue_name: string;
  readonly local_wall: string;
  readonly presentation_classes: readonly string[];
  /** Where the Occasion publishes an offer. `null` at `price_disclosure: at_checkout`. */
  readonly amount_minor: number | null;
  readonly currency: string | null;
}

export interface InputRequest extends GateFacts {
  readonly prompt: Prose;
}

/** SEP-2322's result, carrying I7's marker so the idempotency layer sees it. */
export interface GateResult extends InputRequiredResult {
  readonly input_required: true;
  readonly stage: GateStage;
  readonly inputRequests: readonly InputRequest[];
}

/**
 * X6a: *"MUST NOT contain a URI."* Deliberately broader than `https://` — a
 * bare `www.` or a naked authority renders as a link in most clients, and the
 * rule is about what a human is invited to click, not about what parses as an
 * RFC 3986 URI.
 */
const SCHEME_SHAPED = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.[a-z0-9-]|\bmailto:|\bdata:/i;

/**
 * A bare authority — `embassy.example` — with **no `i` flag, deliberately.**
 * A case-insensitive version of this rule matches `St.James`, and a gate that
 * refused to render a legitimate venue name would be a rule somebody turns
 * off. Hostnames are conventionally lowercase and every link a client
 * auto-detects is; a capitalised word after a full stop is a sentence.
 */
const BARE_AUTHORITY = /\b[a-z0-9][a-z0-9-]*\.[a-z]{2,24}\b/;

export function containsUri(text: string): boolean {
  return SCHEME_SHAPED.test(text) || BARE_AUTHORITY.test(text);
}

export class GatePromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatePromptError";
  }
}

/**
 * The default caption. Built from the facts rather than concatenated from
 * anything a publisher wrote, because the one string a human reads before
 * approving is the last place to interpolate untrusted text — P3's whole
 * subject. The venue name arrives from an Occasion, so it is checked, not
 * trusted.
 */
export function gatePrompt(facts: GateFacts): Prose {
  const seats = facts.seat_count === 1 ? "1 seat" : `${facts.seat_count} seats`;
  const text = `Hold ${seats} at ${facts.venue_name} on ${facts.local_wall}?`;
  if (containsUri(text)) {
    throw new GatePromptError("X6a: an inputRequest prompt MUST NOT contain a URI");
  }
  return prose(text);
}

/**
 * X6's `InputRequiredResult`, at the stage the capability document names.
 *
 * `gate_stage: "hold"` is RECOMMENDED and is what this binding defaults to:
 * *"Hold two seats at the Embassy?"* is the decision a human wants to make and
 * it spends human latency **before** a seat is locked, where *"hand off the
 * hold you already made?"* is a dialog nobody understands.
 */
export function inputRequired(stage: GateStage, facts: GateFacts): GateResult {
  return {
    input_required: true,
    stage,
    inputRequests: [{ prompt: gatePrompt(facts), ...facts }],
  };
}

export interface GateOptions {
  /** The stage this site publishes. Default `hold`, which X6 RECOMMENDS. */
  readonly gate_stage?: GateStage;
  /**
   * X6: *"unless the credential carries an exhibitor-issued `attended: true`
   * grant; **absence means false**."* The default is therefore `false` and not
   * a permissive one — a Server that gated only when told to would gate never.
   */
  readonly attended?: boolean;
}

/** Whether this verb, at this stage, must return a gate before doing anything. */
export function gates(verb: "hold_seats" | "hand_off", options: GateOptions): boolean {
  if (options.attended === true) return false;
  const stage = options.gate_stage ?? GATE_STAGE.hold;
  if (stage === GATE_STAGE.none) return false;
  return stage === GATE_STAGE.hold ? verb === "hold_seats" : verb === "hand_off";
}

export { GATE_STAGE };
export type { GateStage };
