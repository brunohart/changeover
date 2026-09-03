// The calling side. Owner: DEMO-001.
//
// An Agent, over a real loopback socket, holding exactly the credential §6.3
// issues and nothing else. Every reel's evidence is a `Wire` returned from here.
//
// **Why this reads the body and not the printout.** A demo that decided what
// happened by looking at what it had printed would be asserting that its own
// formatter works. `refusalOf` reads the parsed JSON that came back over the
// socket and admits it as a refusal only when four independent things agree:
// the body says `refused: true`, its `code` is a member of the closed
// thirty-two, RFC 9457's `type` is that same code's URN, and the HTTP status is
// the one `REFUSAL_STATUS` fixes for it. A printed sentence satisfies none of
// those, and neither does a body a well-meaning handler assembled by hand.

import { randomBytes } from "node:crypto";

import type { RefusalCode, Remediation } from "@changeover/schema/refusal.ts";
import { REFUSAL_STATUS, isRefusalCode } from "@changeover/schema/refusal.ts";
import { codeOfUrn } from "@changeover/http/problem.ts";

import type { Exhibitor } from "./bench.ts";

/* ── 1 · One call ──────────────────────────────────────────────────────────── */

export interface Wire {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Real elapsed milliseconds, measured around `fetch`. */
  readonly ms: number;
  readonly body: unknown;
  readonly content_type: string | null;
  readonly server_time: string | null;
  /** The intermediary's header, in seconds. `retry_after_ms` stays normative. */
  readonly retry_after: string | null;
}

export interface CallOptions {
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export async function call(
  exhibitor: Exhibitor,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Wire> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }

  const started = process.hrtime.bigint();
  const response = await fetch(exhibitor.base + path, { method, headers, body });
  const text = await response.text();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  return {
    method,
    path,
    status: response.status,
    ms: Math.round(ms * 10) / 10,
    body: parsed,
    content_type: response.headers.get("content-type"),
    server_time: response.headers.get("changeover-server-time"),
    retry_after: response.headers.get("retry-after"),
  };
}

/* ── 2 · Reading a refusal off the wire ────────────────────────────────────── */

/** What a reel reports, and what the gate counts. Never assembled by hand. */
export interface TypedRefusal {
  readonly code: RefusalCode;
  readonly remediation: Remediation;
  readonly status: number;
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly retry_after_ms: number | null;
  /** Where it came from, so a reader can go and make the same call. */
  readonly method: string;
  readonly path: string;
}

interface RefusalBodyLike {
  refused?: unknown;
  code?: unknown;
  remediation?: unknown;
  reason?: { value?: unknown };
  detail?: unknown;
  retry_after_ms?: unknown;
  type?: unknown;
}

/**
 * The refusal this response carries, or `null` if it does not carry one.
 *
 * `null` for a 2xx, and `null` for a body that merely looks unhappy. There is
 * no third answer and no "probably": a value that is not a member of the closed
 * taxonomy is not a refusal this protocol has, and treating it as one would let
 * a demo count something the schema does not admit.
 */
export function refusalOf(wire: Wire): TypedRefusal | null {
  const body = wire.body as RefusalBodyLike | undefined;
  if (body === undefined || body === null || typeof body !== "object") return null;
  if (body.refused !== true) return null;
  const code = body.code;
  if (typeof code !== "string" || !isRefusalCode(code)) return null;
  // §6.3 fixes one status per code. A body naming a code the status contradicts
  // is not a refusal — it is a binding disagreeing with itself.
  if (wire.status !== REFUSAL_STATUS[code]) return null;
  if (typeof body.type === "string" && codeOfUrn(body.type) !== code) return null;

  return {
    code,
    remediation: body.remediation as Remediation,
    status: wire.status,
    reason: typeof body.reason?.value === "string" ? body.reason.value : "",
    detail:
      typeof body.detail === "object" && body.detail !== null
        ? (body.detail as Record<string, unknown>)
        : null,
    retry_after_ms: typeof body.retry_after_ms === "number" ? body.retry_after_ms : null,
    method: wire.method,
    path: wire.path,
  };
}

/* ── 3 · The two things an Agent mints ─────────────────────────────────────── */

/**
 * I1's key. 32 characters from the alphabet the specification names, from a
 * CSPRNG — a key an Agent derived from the request would collide across two
 * customers who wanted the same two seats.
 */
export function idempotencyKey(): string {
  return randomBytes(24).toString("base64url").slice(0, 32);
}

/**
 * D2/D3's `intent_digest`: 43 base64url characters, **random**, per customer
 * intent, discarded when the intent ends.
 *
 * Not a hash of anything about the customer, and this is the one line of the
 * demo where that is a decision rather than an omission. A field shaped like a
 * SHA-256 and described as a correlation key gets filled with
 * `SHA-256(customer_email)` because durable cross-session correlation is the
 * only reason to want one — and an unsalted email hash is a stable cross-site
 * join key, reversible against any breach corpus. D2 forbids it; this mints
 * from `randomBytes` so there is nothing to reverse.
 */
export function intentDigest(): string {
  return randomBytes(32).toString("base64url");
}
