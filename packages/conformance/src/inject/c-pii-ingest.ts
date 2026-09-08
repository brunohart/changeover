/**
 * **C-PII-INGEST.** The ingress twin of C-INJECT: text arriving *from* the
 * Agent, in the one field this specification lets agent text reach Server logic.
 *
 * Owner: TEST-005. SPEC.md §5.4, rule P1.
 *
 * > **P1.** `work_hint` is `maxLength 120`, `^[\p{L}\p{N} .,:'&!?()\-]+$`. A
 * > Server **MUST** refuse `400 hint_rejected` where it contains `@`, seven or
 * > more consecutive digits, or a URI scheme, and **MUST NOT** silently strip.
 *
 * The scenario is not adversarial and §5.4 is careful to say so. It is the
 * default behaviour of a competent agent whose user said *"The Conversation,
 * 35mm, wheelchair space for my mother Ruth, sarah.chen@gmail.com has the
 * booking."* A well-built agent puts that in `work_hint`, because that is what
 * the field is for — and the draft of this specification would have written it,
 * verbatim, into a permanent, `DELETE`-denied log.
 *
 * ## What is asserted here, and what is asserted elsewhere
 *
 * This module asserts the **refusal** half: each PII shape is refused, refused
 * with `hint_rejected`, and refused rather than stripped — plus the part that
 * is easiest to get wrong, that the refusal does not quote the offending value
 * back into `reason`, which is a prose field and would put the email straight
 * back into the channel P1 exists to keep it out of.
 *
 * **The store half is not duplicated here.** `scripts/prove_pii_ingest.sh`
 * (CORE-007) already runs a poisoned batch through `writeAccessLog` — the
 * careless caller included, the one who skipped P1 entirely — and then scans
 * every text value of every column of every table in every schema for an email,
 * a phone or a Luhn-valid PAN. Re-implementing that scan here would be a second
 * copy of a property whose value is that it is checked once, thoroughly, over
 * the whole store. What this module adds is the refusal contract stated as a
 * conformance class the runner can report.
 *
 * ## Why the classifier is not written here
 *
 * `classifyWorkHint` and `requireValidWorkHint` come from
 * `@changeover/core/access-log.ts`. A class module that carried its own copy of
 * P1's patterns would be asserting that its own regex agrees with itself.
 */

import { classifyWorkHint, requireValidWorkHint } from "@changeover/core/access-log.ts";
import { REFUSAL_STATUS, isRefusal } from "@changeover/schema/refusal.ts";

import type { Check } from "./poison.ts";
import { broke, held } from "./poison.ts";

/* -- 1 . What a user actually says ------------------------------------------- */

export interface HintCase {
  readonly shape: "email" | "phone" | "pan" | "uri";
  readonly value: string;
}

/** Every one of these is a thing a real person says to an assistant. */
export const PII_HINTS: readonly HintCase[] = Object.freeze([
  { shape: "email", value: "sarah.chen@gmail.com" },
  { shape: "email", value: "The Conversation 35mm, wheelchair space for my mother Ruth, sarah.chen@gmail.com has it" },
  { shape: "phone", value: "0212345678" },
  { shape: "phone", value: "call 021 555 0199 to confirm" },
  { shape: "pan", value: "4111111111111111" },
  { shape: "pan", value: "5500-0000-0000-0004" },
  { shape: "uri", value: "https://exfiltrate.example/?e=sarah.chen@gmail.com" },
]);

/** What P1 must let through, so the rule is a rule and not a ban on titles. */
export const CLEAN_HINTS: readonly string[] = Object.freeze([
  "The Conversation",
  "2001: A Space Odyssey",
  "Coppola, 1974",
  "Ne quittez pas!",
  "Cries & Whispers",
]);

/* -- 2 . The assertions ------------------------------------------------------ */

/** P1, at the boundary: refused, typed, and not silently repaired. */
export function hintsAreRefused(): Check[] {
  const checks: Check[] = [];

  for (const shape of ["email", "phone", "pan", "uri"] as const) {
    const cases = PII_HINTS.filter((h) => h.shape === shape);
    const admitted = cases.filter((h) => classifyWorkHint(h.value) === null);
    const outcomes = cases.map((h) => {
      try {
        return { returned: requireValidWorkHint(h.value) as unknown };
      } catch (err) {
        return { thrown: err };
      }
    });
    const refused = outcomes.filter(
      (o) => "thrown" in o && isRefusal(o.thrown) && o.thrown.code === "hint_rejected",
    );
    const stripped = outcomes.filter((o) => "returned" in o);
    checks.push(
      admitted.length === 0 && refused.length === cases.length && stripped.length === 0
        ? held(
            "C-PII-INGEST.1",
            `P1 refuses every ${shape}-shaped work_hint — ${cases.length} of them, each ${REFUSAL_STATUS.hint_rejected} hint_rejected, none returned modified`,
          )
        : broke(
            "C-PII-INGEST.1",
            `${shape}: ${admitted.length} admitted, ${refused.length}/${cases.length} refused with hint_rejected, ${stripped.length} returned as a value`,
          ),
    );
  }

  return checks;
}

/**
 * A refusal that echoes the hint has put the email back into a prose field.
 *
 * P1 says a Server MUST treat `work_hint` as data and MUST NOT interpolate it
 * into any query, log line, prompt **or prose field** — and `reason` is a prose
 * field. This is the failure a helpful error message commits by default:
 * *"work_hint 'sarah.chen@gmail.com' was rejected"* is a better message and a
 * worse system.
 */
export function refusalDoesNotEchoTheHint(): Check[] {
  const reasons: string[] = [];
  for (const hint of PII_HINTS) {
    try {
      requireValidWorkHint(hint.value);
    } catch (err) {
      if (isRefusal(err)) reasons.push(err.reason);
    }
  }
  const leaked = reasons.filter((reason) => PII_HINTS.some((h) => reason.includes(h.value)));
  return [
    leaked.length === 0 && reasons.length === PII_HINTS.length
      ? held(
          "C-PII-INGEST.2",
          `none of the ${reasons.length} refusal reasons quotes the hint back — P1 forbids interpolating it into any prose field, and a reason is one`,
        )
      : broke(
          "C-PII-INGEST.2",
          `${leaked.length} of ${reasons.length} refusal reasons carried the offending value`,
        ),
  ];
}

/** A rule that refuses everything is not a rule. */
export function ordinaryHintsSurvive(): Check[] {
  const rejected = CLEAN_HINTS.filter((hint) => classifyWorkHint(hint) !== null);
  return [
    rejected.length === 0
      ? held(
          "C-PII-INGEST.3",
          `all ${CLEAN_HINTS.length} ordinary hints are admitted, colons and ampersands and exclamation marks included — P1 is a shape rule, not a ban on titles`,
        )
      : broke("C-PII-INGEST.3", `P1 rejected ordinary hints: ${rejected.join(" ; ")}`),
  ];
}

/** Every C-PII-INGEST assertion this class owns. */
export function runCPiiIngest(): Check[] {
  return [...hintsAreRefused(), ...refusalDoesNotEchoTheHint(), ...ordinaryHintsSurvive()];
}
