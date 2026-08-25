/**
 * The read side: `resolve_occasions`, and one Occasion by id.
 *
 * The store holds the Occasion **exactly as published**, in `occasion.document`
 * — a read-side-only column that nothing in the hold path branches on. This
 * module serves that document and never synthesises one. A Server that assembled
 * an Occasion from its own columns would be publishing a document no publisher
 * authored, with a `venue.name` and a `manner.note` it made up, which is the
 * failure §3.3 is about: an assertion is a speech act and only its author can
 * make it.
 *
 * An Occasion row with no published document is therefore **not publishable**,
 * and this module says so with `404 occasion_not_found` rather than inventing
 * one. That is a true statement about the read surface: there is no Occasion
 * here to resolve. The hold path can still address the row, because a Hold is
 * keyed on `occasion_id` and not on a document.
 */

import type { Queryable } from "@changeover/store/db.ts";
import type { DurationMs, Rfc3339 } from "@changeover/schema/refusal.ts";
import { refuse } from "@changeover/schema/refusal.ts";
import { rfc3339Column } from "@changeover/core/clock.ts";

/* -- Rows ------------------------------------------------------------------- */

export interface OccasionRow {
  readonly occasion_id: string;
  readonly etag: string;
  readonly starts_at: Rfc3339;
  readonly withdrawn: boolean;
  /** The Occasion exactly as published, or null where none was. */
  readonly document: unknown;
}

const COLUMNS = `occasion_id, etag, ${rfc3339Column("starts_at")}, withdrawn, document`;

/**
 * Where Occasions are read from. A seam, because Profile 1S serves them out of a
 * CMS and only Profile 1's store is the store.
 */
export interface OccasionSource {
  read(q: Queryable, occasion_id: string): Promise<OccasionRow | null>;
  page(q: Queryable, query: OccasionPage): Promise<OccasionRow[]>;
}

export interface OccasionPage {
  readonly from?: Rfc3339;
  readonly to?: Rfc3339;
  readonly after?: Cursor;
  /** One more than the caller asked for, so the caller can tell there is a next page. */
  readonly limit: number;
}

export const STORE_OCCASIONS: OccasionSource = {
  async read(q, occasion_id) {
    const r = await q.query<OccasionRow & Record<string, unknown>>(
      `select ${COLUMNS} from occasion where occasion_id = $1 and withdrawn = false`,
      [occasion_id],
    );
    return r.rows[0] ?? null;
  },

  async page(q, query) {
    // Ordered by (starts_at, occasion_id) - a total order, which is what makes a
    // cursor stable. Ordering by starts_at alone would let two Occasions at one
    // instant swap between pages, and a caller paging a Saturday evening would
    // see one twice and the other never.
    const params: unknown[] = [];
    const where: string[] = ["withdrawn = false", "document is not null"];
    if (query.from !== undefined) {
      params.push(query.from);
      where.push(`starts_at >= $${params.length}::timestamptz`);
    }
    if (query.to !== undefined) {
      params.push(query.to);
      where.push(`starts_at < $${params.length}::timestamptz`);
    }
    if (query.after !== undefined) {
      params.push(query.after.starts_at);
      params.push(query.after.occasion_id);
      where.push(
        `(starts_at, occasion_id) > ($${params.length - 1}::timestamptz, $${params.length})`,
      );
    }
    params.push(query.limit);
    const r = await q.query<OccasionRow & Record<string, unknown>>(
      `select ${COLUMNS} from occasion where ${where.join(" and ")}` +
        ` order by starts_at, occasion_id limit $${params.length}`,
      params,
    );
    return r.rows;
  },
};

/* -- The cursor ------------------------------------------------------------- */

export interface Cursor {
  readonly starts_at: Rfc3339;
  readonly occasion_id: string;
}

const CURSOR_SEPARATOR = " ";

/**
 * An opaque continuation, and opaque is the point: it encodes the sort key, so
 * a caller cannot page by offset and cannot be made to skip a row by an
 * insertion between two of its requests.
 */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(cursor.starts_at + CURSOR_SEPARATOR + cursor.occasion_id, "utf8")
    .toString("base64url");
}

/** A malformed cursor is `400 schema_validation`; it is a request member. */
export function decodeCursor(value: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw refuse("schema_validation", "That cursor is not a cursor this Server minted.");
  }
  const at = decoded.indexOf(CURSOR_SEPARATOR);
  if (at < 1 || at === decoded.length - 1) {
    throw refuse("schema_validation", "That cursor is not a cursor this Server minted.");
  }
  return { starts_at: decoded.slice(0, at), occasion_id: decoded.slice(at + 1) };
}

/* -- Freshness -------------------------------------------------------------- */

/**
 * `availability.max_staleness_ms`, or `null` where the publisher declared none.
 *
 * `null` is not zero-with-a-different-name: it means this document carries no
 * staleness budget, and §2.10 forbids a Server to *invent* a staleness number.
 * The binding turns it into `max-age=0` - no cache licence - rather than into a
 * default nobody published.
 */
export function maxStalenessMs(document: unknown): DurationMs | null {
  if (typeof document !== "object" || document === null) return null;
  const availability = (document as Record<string, unknown>).availability;
  if (typeof availability !== "object" || availability === null) return null;
  const value = (availability as Record<string, unknown>).max_staleness_ms;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/* -- occasion_moved --------------------------------------------------------- */

/**
 * Which paths changed between the etag a caller held and the current document.
 *
 * A Server that retains revisions can diff them. This one does not, so the
 * default names the **whole document** - JSON Pointer `""` (RFC 6901 §5: the
 * empty string points at the whole document) - which is an honest superset. It
 * is the same choice `hold-seats.ts` makes when it refuses `seat_contended`
 * after an aborted transaction: name a true superset rather than a specific set
 * that would be a false statement to a consumer with no judgement.
 */
export interface ChangedPathsSource {
  changedPaths(current: OccasionRow, presented_etag: string): readonly string[];
}

export const WHOLE_DOCUMENT_CHANGED: ChangedPathsSource = {
  changedPaths() {
    return [""];
  },
};
