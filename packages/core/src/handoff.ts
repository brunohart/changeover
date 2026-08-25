/**
 * A re-export shim, and nothing else. Owner: CORE-004.
 *
 * `docs/BUILD-CONTRACT.md` §2 names this item's module `packages/core/src/handoff.ts`
 * and the backlog names it `hand-off.ts`. Both spellings are already written
 * down in places other agents are told to read, so both resolve — and exactly
 * one of them contains an implementation.
 *
 * **There is no second implementation here and there must never be one.** Two
 * files that both hand a customer to a checkout are two chances to disagree
 * about `claim_expires_at`, which is the number a customer is standing inside.
 * This is the same shape CORE-003 used for `state.ts` and `release-hold.ts`.
 */

export type {
  HandOffOptions,
  HandOffRequest,
  HandOffResult,
} from "./hand-off.ts";

export {
  HANDOFF_READS_NEITHER_FLOOR_NOR_GUARD,
  HANDOFF_SQL,
  HANDOFF_WRITES,
  handOff,
  readHoldRow,
} from "./hand-off.ts";
