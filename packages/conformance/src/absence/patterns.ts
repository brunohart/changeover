/**
 * C-ABSENCE — the patterns, and only the patterns.
 * Owner: TEST-004.
 *
 * Two families live here and they are deliberately not the same regex.
 *
 *  - **Name patterns** (Lock 1) ask whether a *surface* exists: a tool, a route
 *    segment, a table, a column. SPEC.md §6.2 writes the `tools/list` rule with
 *    `price` in it and `scripts/prove_no_settlement_verb.sh` writes the member
 *    rule without it, for a stated reason: `price_disclosure`, `price_basis` and
 *    `price_band` are legitimate read-side vocabulary, while a *tool* or *route*
 *    named for a price on a boundary that does not price would be a lie whatever
 *    it did. Both spellings are exported so neither is applied by accident.
 *
 *  - **Value patterns** (Lock 4) ask whether a *value* is personal data. They run
 *    over bytes that have already left the boundary, and they exist to fail the
 *    build, not to clean the byte. A filter is behaviour that has to be right on
 *    every code path nobody has written yet; a red build is a design defect being
 *    reported once, at the moment it is cheapest to fix.
 *
 * Nothing here strips, redacts, masks or rewrites. There is no such function in
 * this module and adding one would falsify the claim the module exists to make.
 */

/** Lock 1, surfaces a model can select: SPEC.md §6.2, `price` included. */
export const SETTLEMENT_SURFACE = /settle|pay|capture|refund|charge|price/i;

/**
 * Lock 1, member and identifier names: `price` omitted, per
 * `scripts/prove_no_settlement_verb.sh`'s own stated reason.
 */
export const SETTLEMENT_MEMBER = /settle|pay|capture|refund|charge/i;

/**
 * Column and table names that would carry a person rather than a seat.
 * Narrow and word-anchored on purpose: this is a tripwire on the physical
 * schema, and a tripwire that fires on `hold_seat` is a tripwire somebody
 * disables. It is not a substitute for Lock 2, which is set equality over an
 * allowlist and cannot be defeated by a synonym; it is the same question asked
 * of the tables, where no manifest exists.
 */
export const PERSONAL_COLUMN =
  /(^|_)(email|e_?mail|phone|msisdn|mobile|card|pan|cvv|iban|bic|customer|patron|booker|surname|forename|given_name|family_name|full_name|loyalty|dob|birthdate|birth_date|passport|nhi|ssn)($|_)/i;

/* -- Lock 4 · value detectors ---------------------------------------------- */

/**
 * An address-shaped run. Deliberately looser than RFC 5322 — the question is
 * "could this be somebody's address", and a detector that only fires on
 * addresses a parser would accept is a detector that misses the ones a human
 * would recognise.
 */
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * E.164: a leading `+`, a non-zero country digit, then 7–14 more, and no digit
 * immediately after. The trailing guard is what keeps a 20-digit counter from
 * matching its own first fifteen characters.
 */
export const E164 = /\+[1-9][0-9]{7,14}(?![0-9])/g;

/** Runs of digits with the separators a human writes a card number in. */
const DIGIT_RUN = /[0-9][0-9 \-]*[0-9]|[0-9]/g;

export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/**
 * Every Luhn-valid 13–19 digit run in `text`.
 *
 * Two things the obvious version gets wrong. It anchors on the whole digit run,
 * so a 16-digit PAN sitting inside a 20-digit identifier is missed — this walks
 * every window of every admissible length instead. And it reads only unbroken
 * digits, so `4111-1111-1111-1111` passes untouched — this folds spaces and
 * hyphens out first, which is how a card number is actually written down.
 */
export function luhnRuns(text: string): string[] {
  const hits: string[] = [];
  DIGIT_RUN.lastIndex = 0;
  for (const match of text.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/[^0-9]/g, "");
    if (digits.length < 13) continue;
    for (let len = 13; len <= 19; len++) {
      for (let at = 0; at + len <= digits.length; at++) {
        const window = digits.slice(at, at + len);
        if (luhn(window)) hits.push(window);
      }
    }
  }
  return [...new Set(hits)];
}

export type ValueHitKind = "email" | "e164" | "luhn";

export interface ValueHit {
  readonly kind: ValueHitKind;
  readonly match: string;
}

/** Every Lock 4 hit in one body. Empty means the body is clean. */
export function valueHits(text: string): ValueHit[] {
  const hits: ValueHit[] = [];
  for (const m of text.matchAll(EMAIL)) hits.push({ kind: "email", match: m[0] });
  for (const m of text.matchAll(E164)) hits.push({ kind: "e164", match: m[0] });
  for (const run of luhnRuns(text)) hits.push({ kind: "luhn", match: run });
  return hits;
}
