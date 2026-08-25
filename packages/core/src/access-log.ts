/**
 * The access log's write path. SPEC.md §5.4 (P1–P3, A1–A4), §5.5 (D1–D4), §2.8.
 *
 * Owner: CORE-007. The table, its CHECKs, its RANGE partitioning by
 * `local_wall_date` and both role grants are `0002_access_log.sql` and
 * `0003_roles_and_grants.sql`, and they are already proved. This module is the
 * writer, and it is the only place in the codebase where an agent's free text
 * meets the database — which makes it an attack surface rather than a
 * convenience.
 *
 * **The threat is not an adversary.** It is the default behaviour of a
 * competent agent whose user said *"The Conversation, 35mm, wheelchair space
 * for my mother Ruth, sarah.chen@gmail.com has the booking."* SPEC.md §5.4 is
 * blunt about it: that is not an adversarial scenario, it is Tuesday. The
 * draft of this specification would have written that string, verbatim, into a
 * permanent, `DELETE`-denied log. Three rules answer it, and they answer it
 * structurally rather than by filtering:
 *
 * | | what it does | why not the obvious thing |
 * |---|---|---|
 * | **P1** | refuses `400 hint_rejected` on `@`, a long digit run, or a URI scheme | silent stripping teaches the caller nothing and leaves the server holding a value it decided to modify |
 * | **P2** | persists `work_hint`, `intent_digest` and `Idempotency-Key` only as `HMAC-SHA256(site_epoch_key, value)`, with `site_epoch_id` naming the key | destroying a retired key makes its rows unlinkable **without any `UPDATE` the grants forbid** — crypto-shredding is how an append-only store honours erasure |
 * | **P3** | the measurement grain is derivable with no P2 column | a metric that needs the raw value does not ship, so nobody ever has a reason to keep one |
 *
 * **A1/A2 are an asymmetry, and the asymmetry is the design.** A write verb
 * whose log row cannot be written fails **closed**. A read verb degrades to a
 * durable secondary sink and **records the degradation as an event** — because
 * an unbounded fail-closed log is an availability weapon: fill it with refused
 * calls and `release_hold` fails too, so seats stay held while the boundary is
 * dark. A degradation that is not itself an event is indistinguishable from a
 * quiet gap, which is the failure mode a log exists to make impossible.
 *
 * **Refusals are logged, at bounded size** (A4: code, verb, agent_id, slot, no
 * body). *A log with only successes cannot show someone probing the boundary,
 * which is the thing you most want to see.*
 *
 * **`local_wall`, never UTC** (§2.8, A3). Partitioning and every derived slot
 * come from the site's wall clock with its offset. UTC migrates a site's whole
 * Sunday-morning cohort into Saturday night once a year and nobody notices for
 * a decade; and cinemas run marathons through 2am on the first Sunday in
 * April, so without `local_wall_offset` in the ingest key two sessions collide
 * on one natural key and the log drops one.
 */

import { createHmac, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";

import type { Db, Queryable } from "@changeover/store/db.ts";
import { SQLSTATE, sqlstate } from "@changeover/store/db.ts";
import type { AccessLogOutcome, AccessLogVerb } from "@changeover/store/schema.ts";
import { ACCESS_LOG_VERBS, LOG_INGEST_KEY, LOG_TABLE } from "@changeover/store/schema.ts";
import type { RefusalCode, Rfc3339 } from "@changeover/schema/refusal.ts";
import { refuse } from "@changeover/schema/refusal.ts";

/* ── 1 · P1 · the one place agent-supplied text reaches Server logic ────────── */

/** `work_hint` is `maxLength 120` (P1). */
export const WORK_HINT_MAX_LENGTH = 120;

/**
 * P1's allowlist, verbatim: `^[\p{L}\p{N} .,:'&!?()\-]+$`.
 *
 * An allowlist rather than a denylist for the reason Lock 2 is an allowlist: a
 * denylist of nine English words is defeated by `patron_ref`, and a denylist of
 * characters is defeated by a homoglyph. This one admits every letter and digit
 * in every script — `万引き家族` and `Аритмия` are film titles — and eight
 * punctuation marks a title actually uses. It admits no `@`, no `/`, no `+`, no
 * `_`, no `#`, no digit separator other than `.`, `,` and `-`.
 *
 * It is a narrow allowlist and it refuses some real titles: `パーフェクト・デイズ`
 * carries U+30FB, which is punctuation and not `\p{L}`. That is the specification's
 * pattern verbatim and this module does not widen it — the remedy P1 names is
 * `work_ref {eidr|isan|work_id}`, which is an identifier and cannot carry a
 * customer's email in the first place.
 */
export const WORK_HINT_PATTERN: RegExp = /^[\p{L}\p{N} .,:'&!?()\-]+$/u;

/**
 * P1's normative digit floor: seven or more **consecutive** digits.
 *
 * Seven is not arbitrary — it is the shortest thing that is a phone number
 * anywhere.
 */
export const DIGIT_RUN_FLOOR = 7;

/**
 * Schemes that make a hint navigable. P1 says "a URI scheme"; §5.3's PR2 note
 * records why the check is a scheme **allowlist** and not a generic
 * `[a-z][a-z0-9+.-]*:` pattern — that rejects a programme note beginning
 * "note:", and here it would reject *Kill Bill: Vol. 1*, which is a film.
 *
 * `://` on its own is included because it is a scheme separator whatever
 * precedes it.
 */
export const URI_SCHEMES: readonly string[] = Object.freeze([
  "http", "https", "ftp", "ftps", "file", "ws", "wss", "mailto", "tel", "sms",
  "data", "blob", "javascript", "vbscript", "about", "urn", "view-source",
  "intent", "market", "chrome", "chrome-extension", "resource",
]);

const URI_SCHEME_PATTERN = new RegExp(`(^|[^\\p{L}\\p{N}])(${URI_SCHEMES.join("|")})\\s*:`, "iu");

/**
 * The reason a hint was refused, as a token. Never the hint.
 *
 * P1: a Server **MUST** treat `work_hint` as data — **MUST NOT** interpolate it
 * into any query, log line, prompt or prose field. A refusal whose `reason`
 * quoted the offending hint back would be exactly that interpolation, and it
 * would put the value the rule exists to keep out of the log straight into the
 * log's own error path. So the caller is told *which rule*, and never *which
 * characters*.
 */
export const HINT_REJECTION = {
  too_long: "too_long",
  charset: "charset",
  at_sign: "at_sign",
  digit_run: "digit_run",
  uri_scheme: "uri_scheme",
  empty: "empty",
} as const;
export type HintRejection = (typeof HINT_REJECTION)[keyof typeof HINT_REJECTION];

/**
 * Which rule a hint breaks, or `null` where it breaks none.
 *
 * Total, pure, and it never returns a modified hint — there is no return path
 * from this function carrying a *stripped* value, because P1 forbids one and a
 * function that could return one would eventually be called by somebody who
 * wanted it to.
 */
export function classifyWorkHint(hint: string): HintRejection | null {
  if (hint.length === 0) return HINT_REJECTION.empty;
  if (hint.length > WORK_HINT_MAX_LENGTH) return HINT_REJECTION.too_long;
  if (hint.includes("@")) return HINT_REJECTION.at_sign;
  if (URI_SCHEME_PATTERN.test(hint)) return HINT_REJECTION.uri_scheme;
  if (longestDigitRun(hint) >= DIGIT_RUN_FLOOR) return HINT_REJECTION.digit_run;
  if (!WORK_HINT_PATTERN.test(hint)) return HINT_REJECTION.charset;
  return null;
}

/**
 * The longest digit run, counting a run **through** the separators a human puts
 * inside a number.
 *
 * P1's floor is "seven or more consecutive digits" and this is deliberately
 * stricter, because the floor alone does not catch the thing it is plainly
 * aimed at: `4111 1111 1111 1111` is a primary account number, it is four runs
 * of four, and every character in it is inside P1's allowlist. A rule that
 * admits a spaced PAN into a permanent, `DELETE`-denied log has failed at the
 * only job it has.
 *
 * A separator only joins two runs when a digit sits on each side of it, so
 * *The 39 Steps 1935* stays two runs of two and four, and *2001: A Space
 * Odyssey* stays one run of four. The strictness is a superset of the
 * normative rule, which is the permitted direction: P1 is a floor on what a
 * Server MUST refuse, not a ceiling on what it MAY.
 */
export function longestDigitRun(hint: string): number {
  const joined = hint.replace(/(?<=\p{Nd})[ .\- ](?=\p{Nd})/gu, "");
  let best = 0;
  let run = 0;
  for (const ch of joined) {
    if (/\p{Nd}/u.test(ch)) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * P1, as a guard. Returns the hint unchanged or throws `400 hint_rejected`.
 *
 * It returns the **same string it was given**. There is no normalisation, no
 * trimming and no stripping anywhere on this path: the value a Server holds is
 * the value the Agent sent, or the Server holds nothing.
 */
export function requireValidWorkHint(hint: string): string {
  const rejection = classifyWorkHint(hint);
  if (rejection === null) return hint;
  throw refuse(
    "hint_rejected",
    `The work_hint was refused (${rejection}) and has not been stored, ` +
      `modified, or interpreted. Send work_ref {eidr|isan|work_id} instead, ` +
      `or a title of at most ${WORK_HINT_MAX_LENGTH} letters, digits and . , : ' & ! ? ( ) -`,
  );
}

/* ── 2 · P2 · the site epoch, and why a rotation is representable ───────────── */

/**
 * One HMAC key and the id that names it.
 *
 * P2: `site_epoch_key` **MUST** rotate on a published interval (RECOMMENDED 90
 * days) and the retired key **MUST** be destroyed. The id is written on every
 * row, so a row from a destroyed epoch is unlinkable to any input while still
 * being counted — and nothing had to be `UPDATE`d or `DELETE`d, which is exactly
 * as well, because the grants forbid both.
 */
export interface SiteEpoch {
  /** Written to `site_epoch_id`. 1–64 characters. Names the key, never contains it. */
  readonly site_epoch_id: string;
  /** The secret. Never persisted, never logged, never rendered. */
  readonly key: Uint8Array | string;
}

/** 43 base64url characters — 32 bytes, unpadded. The column's CHECK. */
export const HMAC_LENGTH = 43;

/**
 * `HMAC-SHA256(site_epoch_key, value)`, base64url, unpadded.
 *
 * Keyed, not plain. A bare SHA-256 of a short value from a known space — a film
 * title, an email — is a rainbow-table lookup, and the whole point of P2 is that
 * the stored form survives a disclosure of the store. It is the destruction of
 * the key, not the strength of the digest, that does the work.
 */
export function epochHmac(epoch: SiteEpoch, value: string): string {
  return createHmac("sha256", epoch.key).update(value, "utf8").digest("base64url");
}

/** D3: `intent_digest` is `^[A-Za-z0-9_-]{43}$` in **both** bindings, or `400 schema_validation`. */
export const INTENT_DIGEST_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;

/**
 * D3, as a guard.
 *
 * D1 is the reason nothing downstream of this ever branches on the value: it is
 * a correlation aid for the access log and **nothing else** — not
 * authorisation, not rate limiting, not any security decision. D2 makes it the
 * Agent's obligation to mint it at random per intent; a Server cannot verify
 * that and this module does not pretend to. D4 keeps it out of every response
 * body, which is a property of the response assemblers, not of this file.
 */
export function requireValidIntentDigest(intent_digest: string): string {
  if (!INTENT_DIGEST_PATTERN.test(intent_digest)) {
    throw refuse(
      "schema_validation",
      "intent_digest must match ^[A-Za-z0-9_-]{43}$ and must be random per customer intent, " +
        "never derived from any personal identifier — hashed, salted, truncated or otherwise.",
    );
  }
  return intent_digest;
}

/* ── 3 · §2.8 · local_wall, and the fold ───────────────────────────────────── */

/** A site's wall clock at one instant, with the offset that disambiguates it. */
export interface LocalWall {
  /** `YYYY-MM-DDTHH:MM`. The column's CHECK; minute precision, no seconds. */
  readonly local_wall: string;
  /** `+HH:MM` or `-HH:MM`. The fold's disambiguator, and part of the ingest key. */
  readonly local_wall_offset: string;
  /** `YYYY-MM-DD`. The RANGE partition key. */
  readonly local_wall_date: string;
}

const WALL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = WALL_FORMATTERS.get(timezone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "longOffset",
    });
    WALL_FORMATTERS.set(timezone, fmt);
  }
  return fmt;
}

/**
 * The site's wall clock at an absolute instant.
 *
 * **The direction matters, and it is the whole reason this is safe.** Wall time
 * → instant is ambiguous at the fold (02:30 happens twice) and undefined in the
 * gap (02:30 never happens); instant → wall time is total, and the offset comes
 * back with it. So the log never has to guess: it starts from the server's own
 * `timestamptz` and derives the wall clock, and the two 02:30s that a marathon
 * screening actually runs through arrive as two rows with the same
 * `local_wall` and different `local_wall_offset` — distinct on the ingest key,
 * which is why neither is dropped.
 *
 * A Publisher **MUST NOT** emit a `local_wall` that does not exist in the zone
 * (§2.8). Deriving forward from an instant cannot produce one, so this function
 * satisfies that rule by construction rather than by checking it.
 */
export function localWallAt(instant: Date | Rfc3339, timezone: string): LocalWall {
  const at = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(at.getTime())) {
    throw new TypeError("access-log: an instant that is not a valid time reached localWallAt");
  }
  const parts = new Map<string, string>();
  for (const part of wallFormatter(timezone).formatToParts(at)) parts.set(part.type, part.value);
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  const zone = parts.get("timeZoneName");
  if (!year || !month || !day || !hour || !minute || zone === undefined) {
    throw new TypeError(`access-log: the runtime could not render a wall clock for "${timezone}"`);
  }
  const local_wall_date = `${year}-${month}-${day}`;
  return {
    local_wall_date,
    local_wall: `${local_wall_date}T${hour === "24" ? "00" : hour}:${minute}`,
    local_wall_offset: normaliseOffset(zone),
  };
}

/**
 * `GMT+12:00` → `+12:00`, `GMT-03:30` → `-03:30`, bare `GMT` → `+00:00`.
 *
 * `longOffset` is the only `timeZoneName` style guaranteed to carry minutes,
 * which Chatham (+12:45), Kathmandu (+05:45) and Newfoundland (−03:30) all
 * need and `shortOffset` drops for whole hours.
 */
function normaliseOffset(timeZoneName: string): string {
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(timeZoneName);
  if (m === null) return "+00:00";
  return `${m[1]}${m[2]!.padStart(2, "0")}:${m[3] ?? "00"}`;
}

/** The measurement slot: hour of the local wall day. Derived in SQL too; kept in step here. */
export function localWallSlot(wall: LocalWall): number {
  return Number(wall.local_wall.slice(11, 13));
}

/* ── 4 · A1/A2 · what a write verb does when the log is gone ────────────────── */

/** §5.4/§4.1 write verbs. A log failure on one of these fails the verb CLOSED (A2). */
export const WRITE_VERBS: readonly AccessLogVerb[] = Object.freeze([
  "hold_seats", "release_hold", "hand_off", "claim_confirm",
]);

/** Read verbs. A log failure on one of these MAY degrade (A2), and must say so. */
export const READ_VERBS: readonly AccessLogVerb[] = Object.freeze(
  ACCESS_LOG_VERBS.filter((v) => !WRITE_VERBS.includes(v)),
);

/** A2's dividing line, as a predicate rather than as a memory. */
export function isWriteVerb(verb: AccessLogVerb): boolean {
  return WRITE_VERBS.includes(verb);
}

/**
 * Thrown when a **write** verb's log row could not be written.
 *
 * It must reach the caller and the caller must not swallow it: A2's fail-closed
 * half is the reason the log is worth anything at all. A boundary that grants
 * seats it cannot account for is a boundary reporting a property it does not
 * have.
 *
 * It carries a SQLSTATE or an error *name*, never a driver message. A Postgres
 * error string routinely quotes the offending row — `Key (record_source,
 * natural_key)=(…)` — so a message copied into a durable sink is a second,
 * unaudited copy of the very values P2 exists to keep out of storage.
 */
export class AccessLogUnavailable extends Error {
  readonly verb: AccessLogVerb;
  readonly sqlstate?: string;
  constructor(verb: AccessLogVerb, cause_token: string, state?: string) {
    super(
      `access log unavailable for write verb "${verb}" (${cause_token}); ` +
        `the verb fails closed rather than acting unlogged (SPEC.md §5.4 A2)`,
    );
    this.name = "AccessLogUnavailable";
    this.verb = verb;
    if (state !== undefined) this.sqlstate = state;
  }
}

/** A2: the degradation is an event, not a gap. */
export interface DegradationEvent {
  readonly event: "access_log_degraded";
  readonly verb: AccessLogVerb;
  readonly local_wall: string;
  readonly local_wall_offset: string;
  readonly observed_at: Rfc3339;
  /** A SQLSTATE, or an error name. Never a driver message — see {@link AccessLogUnavailable}. */
  readonly cause_token: string;
}

/**
 * Somewhere durable that is not the primary log and not the hold store (A1).
 *
 * A2 permits a read to degrade **to a durable secondary sink**. Degrading to
 * nowhere is not degrading; it is dropping. So a Server that has not configured
 * one has not implemented A2, and this module fails its reads closed rather
 * than pretending — which is conforming (A2 says MAY), merely less available.
 */
export interface SecondarySink {
  /** The same row the primary would have taken. Already hashed; never raw. */
  record(row: AccessLogRow): Promise<void>;
  /** A2's second half, and the reason a degradation is not a silent gap. */
  degradation(event: DegradationEvent): Promise<void>;
}

/**
 * A JSON-lines sink that is durable in the sense the word is usually meant:
 * the bytes are `fdatasync`'d before the promise resolves.
 *
 * A reference implementation, not a recommendation. A deployment substitutes
 * its own — and A1 wants it on storage independent of the hold store, which a
 * file on the same volume is not. It is honest about carrying only what the
 * primary would have carried: every P2 value arrives already HMAC'd, and there
 * is no member here that the table does not have.
 */
export function jsonlSink(path: string): SecondarySink {
  const append = async (line: unknown): Promise<void> => {
    const handle = await open(path, "a");
    try {
      await handle.writeFile(JSON.stringify(line) + "\n", "utf8");
      await handle.datasync();
    } finally {
      await handle.close();
    }
  };
  return {
    record: (row) => append({ kind: "access_log_row", ...row }),
    degradation: (event) => append(event),
  };
}

/* ── 5 · The row, and the invocation it is written from ─────────────────────── */

/**
 * One invocation, as the caller knows it — **including raw values**.
 *
 * `work_hint`, `intent_digest` and `idempotency_key` are the raw inputs and
 * they are hashed inside {@link writeAccessLog}. They exist on this interface
 * and nowhere else: no other type in this package carries them, nothing returns
 * them, and the row that leaves this module has only their HMACs. That is the
 * only place the boundary between "a value in memory for the length of one
 * request" and "a value in a permanent store" can be drawn, so it is drawn
 * here, once, in a file whose entire job is to draw it.
 */
export interface Invocation {
  readonly verb: AccessLogVerb;
  readonly outcome: AccessLogOutcome;
  /** §5.4's CHECK: present exactly when `outcome === "refused"`. */
  readonly refusal_code?: RefusalCode | null;
  readonly agent_id: string;
  /** X0/§5.6: a per-customer-session correlator minted by the agent platform. */
  readonly principal_scope: string;
  /** Server-minted. The claim token is NOT here and never will be (CL5). */
  readonly hold_id?: string | null;
  readonly occasion_id?: string | null;

  /** RAW. Hashed under P2 before it touches the store. Never persisted as given. */
  readonly work_hint?: string | null;
  /** RAW. Hashed under P2. D4 keeps it out of every response body. */
  readonly intent_digest?: string | null;
  /** RAW. Hashed under P2, and it is the same value I2 keys idempotency on. */
  readonly idempotency_key?: string | null;

  /**
   * Idempotent ingest (§5.4). One invocation is one fact: a caller that retries
   * under one `Idempotency-Key` passes one `natural_key` and gets one row, not
   * two. Defaults to a fresh id, which makes every call its own fact.
   */
  readonly natural_key?: string;
  readonly record_source?: string;
  /** Append-only records are versioned on this. Defaults to `observed_at`. */
  readonly input_watermark?: Rfc3339;
}

/** The row as the table takes it. Every P2 value here is already an HMAC. */
export interface AccessLogRow {
  readonly local_wall_date: string;
  readonly local_wall: string;
  readonly local_wall_offset: string;
  readonly observed_at: Rfc3339;
  readonly agent_id: string;
  readonly principal_scope: string;
  readonly verb: AccessLogVerb;
  readonly outcome: AccessLogOutcome;
  readonly refusal_code: string | null;
  readonly hold_id: string | null;
  readonly occasion_id: string | null;
  readonly site_epoch_id: string;
  readonly work_hint_hmac: string | null;
  readonly intent_digest_hmac: string | null;
  readonly idempotency_key_hmac: string | null;
  readonly record_source: string;
  readonly natural_key: string;
  readonly input_watermark: Rfc3339;
  readonly degraded: boolean;
}

export interface AccessLogOptions {
  readonly epoch: SiteEpoch;
  /** IANA zone for the site whose wall clock partitions this row. Never UTC by habit. */
  readonly timezone: string;
  /** A2. Absent means reads fail closed too — see {@link SecondarySink}. */
  readonly secondary?: SecondarySink;
  readonly record_source?: string;
}

export const DEFAULT_RECORD_SOURCE = "changeover.core";

/**
 * Build the row. Pure, apart from the default `natural_key`.
 *
 * Exported because a proof that wants to know what would have been stored
 * should not have to store it, and because the P2 property — no raw value on
 * any member — is then assertable on a value rather than inferred from a table
 * scan. The table scan happens anyway; both are cheap and they fail
 * differently.
 */
export function accessLogRow(
  invocation: Invocation,
  observed_at: Rfc3339,
  options: AccessLogOptions,
): AccessLogRow {
  const refused = invocation.outcome === "refused";
  const code = invocation.refusal_code ?? null;
  if (refused !== (code !== null)) {
    // The CHECK is the floor and it will reject this too. Refusing here as well
    // means the caller gets a diagnosable error instead of a 23514 that the
    // fail-closed path then converts into a failed verb.
    throw new TypeError(
      `access-log: outcome "${invocation.outcome}" and refusal_code ${code === null ? "absent" : "present"} ` +
        `disagree; §5.4 requires a CHECK forcing a reason on refusals, and only on refusals`,
    );
  }
  const wall = localWallAt(observed_at, options.timezone);
  const epoch = options.epoch;
  return {
    local_wall_date: wall.local_wall_date,
    local_wall: wall.local_wall,
    local_wall_offset: wall.local_wall_offset,
    observed_at,
    agent_id: invocation.agent_id,
    principal_scope: invocation.principal_scope,
    verb: invocation.verb,
    outcome: invocation.outcome,
    refusal_code: code,
    hold_id: invocation.hold_id ?? null,
    occasion_id: invocation.occasion_id ?? null,
    site_epoch_id: epoch.site_epoch_id,
    work_hint_hmac: hashOrNull(epoch, invocation.work_hint),
    intent_digest_hmac: hashOrNull(epoch, invocation.intent_digest),
    idempotency_key_hmac: hashOrNull(epoch, invocation.idempotency_key),
    record_source: invocation.record_source ?? options.record_source ?? DEFAULT_RECORD_SOURCE,
    natural_key: invocation.natural_key ?? randomUUID(),
    input_watermark: invocation.input_watermark ?? observed_at,
    degraded: false,
  };
}

function hashOrNull(epoch: SiteEpoch, value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  return epochHmac(epoch, value);
}

/* ── 6 · The insert ────────────────────────────────────────────────────────── */

const COLUMNS: readonly (keyof AccessLogRow)[] = Object.freeze([
  "local_wall_date", "local_wall", "local_wall_offset", "observed_at",
  "agent_id", "principal_scope", "verb", "outcome", "refusal_code",
  "hold_id", "occasion_id", "site_epoch_id",
  "work_hint_hmac", "intent_digest_hmac", "idempotency_key_hmac",
  "record_source", "natural_key", "input_watermark", "degraded",
]);

/**
 * The statement, built once from a compile-time column list.
 *
 * `ON CONFLICT DO NOTHING` on the ingest key rather than a caught `23505`,
 * because on a PARTITIONED table the violation names the partition's own
 * auto-generated index and never the parent constraint — an equality check
 * against `access_log_ingest` silently never matches. `packages/store/src/
 * schema.ts` says so at the constant; this is the path that takes its advice.
 */
export const INSERT_SQL: string =
  `insert into ${LOG_TABLE} (${COLUMNS.join(", ")}) ` +
  `values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")}) ` +
  `on conflict (${LOG_INGEST_KEY.join(", ")}) do nothing`;

export interface AccessLogWriteResult {
  readonly row: AccessLogRow;
  /** Where it landed. `"secondary"` only ever follows a read verb (A2). */
  readonly sink: "primary" | "secondary";
  readonly degraded: boolean;
  /** Present when `sink === "secondary"`. The event A2 requires be recorded. */
  readonly degradation?: DegradationEvent;
}

/**
 * Write one row for one invocation — ok, refused or error alike (§5.4).
 *
 * Fails a **write** verb closed and degrades a **read** verb (A2). Never
 * silently drops: the only three outcomes are a row in the primary, a row in a
 * durable secondary with a degradation event beside it, or a thrown
 * {@link AccessLogUnavailable}.
 *
 * `observed_at` comes from the database (K4) — `serverTime(tx)` in `clock.ts`,
 * never `new Date()`. It is a parameter rather than a call so that a verb which
 * already minted its `server_time` logs *that* instant and not a later one.
 */
export async function writeAccessLog(
  q: Queryable,
  invocation: Invocation,
  observed_at: Rfc3339,
  options: AccessLogOptions,
): Promise<AccessLogWriteResult> {
  const row = accessLogRow(invocation, observed_at, options);
  try {
    await q.query(INSERT_SQL, COLUMNS.map((c) => row[c]));
    return { row, sink: "primary", degraded: false };
  } catch (err) {
    const state = sqlstate(err);
    const token = state ?? errorName(err);

    if (isWriteVerb(invocation.verb) || options.secondary === undefined) {
      throw new AccessLogUnavailable(invocation.verb, token, state);
    }

    const degraded_row: AccessLogRow = { ...row, degraded: true };
    const degradation: DegradationEvent = {
      event: "access_log_degraded",
      verb: invocation.verb,
      local_wall: row.local_wall,
      local_wall_offset: row.local_wall_offset,
      observed_at,
      cause_token: token,
    };
    // The row first, then the event: a sink that dies between the two leaves the
    // row without its explanation, which is recoverable. The other order leaves
    // an explanation with nothing to explain, which reads as a lost row.
    await options.secondary.record(degraded_row);
    await options.secondary.degradation(degradation);
    return { row: degraded_row, sink: "secondary", degraded: true, degradation };
  }
}

/**
 * The name of a thrown thing, for a token. Never its message.
 *
 * A driver message quotes row values; a name does not. `sqlstate()` already
 * shape-checks `/^[0-9A-Z]{5}$/`, so `ENOENT` on `err.code` cannot arrive here
 * dressed as a SQLSTATE.
 */
function errorName(err: unknown): string {
  if (err instanceof Error && typeof err.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name)) {
    return err.name;
  }
  return "unknown_error";
}

/* ── 7 · P3 · the grain, and what it deliberately cannot see ────────────────── */

/**
 * The measurement grain, in SQL, referencing **no P2 column**.
 *
 * P3: *a metric that needs the raw value does not ship.* This is that rule made
 * executable — `scripts/prove_access_log.sh` matches this constant against
 * `work_hint_hmac|intent_digest_hmac|idempotency_key_hmac` and fails if any
 * appears. The point is not that the HMAC would leak anything; it is that a
 * grain which correlates on a P2 column creates a permanent reason to keep the
 * key, and P2 only works if the key can be destroyed.
 *
 * The slot is `local_wall_slot`, which the table generates from `local_wall` —
 * so no writer can supply a UTC-derived one by accident (§2.8, A3).
 *
 * `attribution_rate` is published beside the figure, per §5.4's fourth
 * measurement failure mode, and it is defined on `occasion_id` — a non-P2,
 * server-minted column — precisely so that publishing it does not require a
 * key. **No estimator ships in v0.1.** This is a count and a ratio of counts.
 */
export const GRAIN_SQL: string = `
  select local_wall_date::text        as local_wall_date,
         local_wall_slot              as local_wall_slot,
         verb                         as verb,
         outcome                      as outcome,
         coalesce(refusal_code, '')   as refusal_code,
         count(*)::text               as invocations,
         count(distinct agent_id)::text as agents,
         (count(*) filter (where occasion_id is not null))::text as attributed
    from ${LOG_TABLE}
   where local_wall_date between $1::date and $2::date
   group by local_wall_date, local_wall_slot, verb, outcome, coalesce(refusal_code, '')
   order by local_wall_date, local_wall_slot, verb, outcome, coalesce(refusal_code, '')`;

export interface GrainRow {
  readonly local_wall_date: string;
  readonly local_wall_slot: number;
  readonly verb: AccessLogVerb;
  readonly outcome: AccessLogOutcome;
  /** `""` where the outcome is not a refusal. The CHECK guarantees that pairing. */
  readonly refusal_code: string;
  readonly invocations: number;
  readonly agents: number;
  /** §5.4: published beside the figure, never instead of it. */
  readonly attribution_rate: number;
}

/** Run {@link GRAIN_SQL} over an inclusive range of local wall dates. */
export async function grain(q: Queryable, from: string, to: string): Promise<GrainRow[]> {
  const r = await q.query<Record<string, string | number>>(GRAIN_SQL, [from, to]);
  return r.rows.map((row) => {
    const invocations = Number(row.invocations);
    const attributed = Number(row.attributed);
    return {
      local_wall_date: String(row.local_wall_date).slice(0, 10),
      local_wall_slot: Number(row.local_wall_slot),
      verb: row.verb as AccessLogVerb,
      outcome: row.outcome as AccessLogOutcome,
      refusal_code: String(row.refusal_code),
      invocations,
      agents: Number(row.agents),
      attribution_rate: invocations === 0 ? 0 : attributed / invocations,
    };
  });
}

/* ── 8 · A3 · retention, which is a DROP and never a DELETE ─────────────────── */

/**
 * Detach one local-wall-date partition, as `changeover_retention`.
 *
 * A3: rows **MUST NOT** be retained beyond `log_retention_days` (default 90,
 * published), after which the partition is **detached** and replaced by a
 * rollup carrying no `agent_id`, no `principal_scope`, no digest and no seat
 * ids. *Detaching a partition is not an `UPDATE` or `DELETE` on a row and does
 * not violate C-LOG* — which is the only reason an append-only log can honour
 * retention at all, and it is why the `DROP` capability lives in a separate
 * role holding nothing else.
 *
 * The partition name is validated against `/^[a-z_][a-z0-9_]{0,62}$/` because
 * it is an identifier and identifiers cannot be parameters. Nothing
 * user-influenced reaches it; the regex is there so that nothing ever can.
 */
export async function detachLogPartition(db: Db, partition: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(partition)) {
    throw new TypeError(`access-log: "${partition}" is not a partition identifier`);
  }
  await db.transaction(
    async (tx) => {
      await tx.query(`alter table ${LOG_TABLE} detach partition changeover_log.${partition}`);
    },
    { role: "changeover_retention" },
  );
}

/** The SQLSTATE a grant denial arrives as. Re-exported so a caller need not retype it. */
export const INSUFFICIENT_PRIVILEGE: string = SQLSTATE.insufficient_privilege;
