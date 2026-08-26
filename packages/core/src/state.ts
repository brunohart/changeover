/**
 * The Hold's state, under the name the backlog gives it. Owner: CORE-003.
 *
 * `derived.ts` is where M1 is written, because the migration that forbids the
 * `state` column names that file by path — "the function itself lives in
 * @changeover/core/derived.ts (CORE-003) so that it is written once", and a
 * comment in a migration that points at a file which does not exist is worse
 * than no comment. This module exists so that an importer reaching for the
 * obvious name finds the same function rather than writing a second one.
 *
 * There is nothing here. Everything is re-exported, deliberately: a second
 * implementation of M1 is the failure this whole item is about.
 */

export type { HoldFacts, HoldRow, HoldState } from "./derived.ts";
export {
  HOLD_STATE,
  HOLD_STATES,
  HOLD_COLUMNS,
  SEAT_OCCUPYING_STATES,
  deriveState,
  derivedStateIn,
  derivedStateSql,
  floorRemainingMs,
  heldUntil,
  isTerminal,
  occupiedSeatCount,
  occupiesSeat,
  seatsAsGranted,
} from "./derived.ts";
