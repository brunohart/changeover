// C-CLOCK. Owner: TEST-006.
//
// §7: *"`server_time` on every response and non-decreasing per hold; no request
// accepts a client timestamp; DST-**fold** and DST-**gap** fixtures."*
//
// **Why the two DST fixtures are the load-bearing half.**
//
// Cinemas run marathons through 2am, and on one night a year 02:30 happens
// twice. The two 02:30s are an hour apart and they are two different screenings
// with two different audiences. A natural key that carries `local_wall` and not
// `local_wall_offset` collides them: `ON CONFLICT DO NOTHING` drops the second
// silently, the measurement series is quietly missing a screening, and nobody
// finds out until somebody tries to back-fill a year that cannot be back-filled.
// The fold clause writes exactly that pair and counts the rows.
//
// On the other night 02:30 does not exist at all. A naive wall-time → instant
// parse either throws or slides an hour without saying so, and an Occasion
// published an hour from where it runs is worse than one that was refused.
// `localWallAt` derives the wall clock FORWARD from an instant, which is total,
// and the gap clause asserts the totality by sweeping the transition minute by
// minute rather than by trusting the direction.
//
// The cheaper check — asserting that `Changeover-Server-Time` matches an RFC
// 3339 regex — is here too, as one clause of nine, and it would not have caught
// either DST failure, K3, or K6.

import { serverTime } from "@changeover/core/clock.ts";
import { localWallAt, localWallSlot, writeAccessLog } from "@changeover/core/access-log.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { ConformanceBench } from "./_bench.ts";
import {
  DST_FOLD_PATH,
  DST_GAP_PATH,
  ETAG,
  OCCASION,
  TOKEN,
  dstFold,
  dstGap,
  grantHold,
  holdBody,
  key,
} from "./_bench.ts";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;
const CONFORMANCE_SOURCE = "changeover.conformance";

export const id = "C-CLOCK";
export const spec_row =
  "server_time on every response and non-decreasing per hold; no request accepts a client timestamp; DST-fold and DST-gap fixtures.";

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  const fold = dstFold();
  const gap = dstGap();
  c.that(
    "fixtures_present",
    fold.sessions.length === 2 && typeof gap.absent_local_wall === "string",
    `both DST fixtures load: ${DST_FOLD_PATH} names two sessions at ${fold.local_wall}, ${DST_GAP_PATH} names ${gap.absent_local_wall} as absent`,
  );

  /* ── 1 · server_time on every response ────────────────────────────────── */

  const held = await grantHold(bench, TOKEN.a, ["A:1", "A:2"], {}, `clock-${bench.nonce}`);
  const hold_id = String((held.json as { hold_id?: string } | null)?.hold_id ?? "");

  const walk = [
    await bench.call("GET", "/.well-known/changeover"),
    await bench.call("GET", "/.well-known/changeover/delegation.json"),
    await bench.call("GET", "/changeover/v0/occasions", { token: TOKEN.a }),
    await bench.call("GET", `/changeover/v0/occasions/${OCCASION.main}`, { token: TOKEN.a }),
    held,
    await bench.call("GET", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.a }),
    await bench.call("GET", "/changeover/v0/holds/hold_00000000000000000000000000000000", { token: TOKEN.a }),
    await bench.call("GET", "/changeover/v0/occasions", {}),
  ];
  const stamped = walk.filter((r) => RFC3339.test(r.headers.get("changeover-server-time") ?? ""));
  c.is(
    "header",
    stamped.length,
    walk.length,
    `all ${walk.length} responses carry Changeover-Server-Time as RFC 3339 with a mandatory offset — including the two refusals, where an Agent needs it most`,
  );

  /* ── 2 · K6 — non-decreasing across successive responses for one hold ─── */

  const times: string[] = [];
  for (let i = 0; i < 8; i++) {
    const read = await bench.call("GET", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.a });
    times.push(String((read.json as { server_time?: string } | null)?.server_time ?? ""));
  }
  const ordered = times.every((t, i) => i === 0 || Date.parse(t) >= Date.parse(times[i - 1] as string));
  const moved = Date.parse(times[times.length - 1] as string) > Date.parse(times[0] as string);
  c.that(
    "k6",
    ordered,
    `server_time is non-decreasing across eight successive get_hold responses for one hold_id (${times[0]} … ${times[times.length - 1]})`,
  );
  c.that(
    "k6_live",
    moved,
    "and it advances rather than being frozen, so the monotonicity is a clock and not a constant",
  );

  /* ── 3 · K4 — one time source, and it is the database ─────────────────── */

  const document = held.json as { granted_at: string; floor_ms: number; floor_deadline: string; expires_at: string };
  const derived = Date.parse(document.granted_at) + document.floor_ms;
  c.is(
    "k4_derived",
    Date.parse(document.floor_deadline),
    derived,
    "floor_deadline is granted_at + floor_ms to the millisecond, which the hold_floor_derived CHECK makes unwritable otherwise",
  );
  const db_now = await serverTime(bench.db);
  const drift = Math.abs(Date.parse(db_now) - Date.parse(document.granted_at));
  c.that(
    "k4_one_source",
    drift < 60000,
    `granted_at sits within ${drift}ms of the database's own clock, so it was read there and not on an API node whose clock may lead it`,
  );

  /* ── 4 · K3 — no request accepts a client timestamp ───────────────────── */

  const before = await bench.db.query<{ n: string }>("select count(*)::text as n from hold");
  const client_clock: [string, Record<string, unknown>][] = [
    ["server_time", { server_time: "2020-01-01T00:00:00+12:00" }],
    ["granted_at", { granted_at: "2020-01-01T00:00:00+12:00" }],
    ["expires_at", { expires_at: "2099-01-01T00:00:00+12:00" }],
    ["floor_deadline", { floor_deadline: "2099-01-01T00:00:00+12:00" }],
  ];
  let refused = 0;
  for (const [member, extra] of client_clock) {
    const response = await bench.call("POST", "/changeover/v0/holds", {
      token: TOKEN.a,
      headers: { "Idempotency-Key": key(`clock-${member}-${bench.nonce}`) },
      body: holdBody(["C:1"], extra),
    });
    if (response.status === 400 && (response.json as { code?: string } | null)?.code === "schema_validation") {
      refused++;
    } else {
      c.bad("k3", `a hold request carrying a client ${member} was not refused 400 schema_validation: ${response.status}`);
    }
  }
  if (refused === client_clock.length) {
    c.ok(
      "k3",
      "all four client-supplied time members are refused 400 schema_validation — K3 holds because no request body carries one, not because one is checked",
    );
  }
  const after = await bench.db.query<{ n: string }>("select count(*)::text as n from hold");
  c.is("k3_no_write", after.rows[0]?.n, before.rows[0]?.n, "and none of the four wrote a hold row on its way to being refused");

  /* ── 5 · The FOLD ─────────────────────────────────────────────────────── */

  const early = fold.sessions[0]!;
  const late = fold.sessions[1]!;

  // The zone itself, before anything about this Server. If the runtime's tzdata
  // disagrees, every clause below is measuring the wrong night.
  const early_wall = localWallAt(early.instant_utc, fold.timezone);
  const late_wall = localWallAt(late.instant_utc, fold.timezone);
  c.that(
    "fold_zone",
    early_wall.local_wall === fold.local_wall &&
      late_wall.local_wall === fold.local_wall &&
      early_wall.local_wall_offset === early.local_wall_offset &&
      late_wall.local_wall_offset === late.local_wall_offset,
    `${fold.local_wall} happens twice in ${fold.timezone}: once at ${early_wall.local_wall_offset} and once at ${late_wall.local_wall_offset}`,
  );
  c.is(
    "fold_separation",
    Date.parse(late.instant_utc) - Date.parse(early.instant_utc),
    fold.separation_ms,
    "and the two are exactly an hour apart, which is what makes them two screenings rather than one written down twice",
  );

  // The estate carries both, and the boundary resolves them as two Occasions.
  const page = await bench.call("GET", "/changeover/v0/occasions", { token: TOKEN.a });
  const resolved = ((page.json as { occasions?: Record<string, any>[] } | null)?.occasions ?? []).filter(
    (o) => o.occasion_id === OCCASION.fold_nzdt || o.occasion_id === OCCASION.fold_nzst,
  );
  c.is("fold_resolved", resolved.length, 2, "resolve_occasions answers with both sessions of the fold, not one");
  c.that(
    "fold_offsets",
    resolved.every((o) => o.instant.local_wall === fold.local_wall) &&
      new Set(resolved.map((o) => o.instant.local_wall_offset)).size === 2,
    "both carry the same instant.local_wall and different instant.local_wall_offset — the offset is the disambiguator, and it is on the wire",
  );

  const stored = await bench.db.query<{ occasion_id: string; local_wall: string; local_wall_offset: string; starts_at: string }>(
    "select occasion_id, local_wall, local_wall_offset, starts_at::text as starts_at from occasion" +
      " where occasion_id in ($1, $2) order by starts_at",
    [OCCASION.fold_nzdt, OCCASION.fold_nzst],
  );
  c.is(
    "fold_store",
    stored.rows.length,
    2,
    "and the store holds two rows: local_wall is not the key, so the second did not overwrite the first",
  );

  // The access log's ingest key. THIS is the assertion the fixture exists for.
  const natural_key = `conf-fold-${bench.nonce}`;
  const epoch = { site_epoch_id: `epoch-conf-${bench.nonce}`, key: "a-conformance-key-that-is-not-a-credential" };
  const observed = await serverTime(bench.db);
  const logOne = (offset: string, instant: string) =>
    writeAccessLog(
      bench.db,
      {
        verb: "resolve_occasions",
        outcome: "ok",
        agent_id: "agt_conf_a",
        principal_scope: "prin_conf_wellington",
        natural_key,
        record_source: CONFORMANCE_SOURCE,
        input_watermark: instant,
      },
      instant,
      { epoch, timezone: fold.timezone, record_source: CONFORMANCE_SOURCE },
    );

  const first = await logOne(early.local_wall_offset, early.instant_utc);
  const second = await logOne(late.local_wall_offset, late.instant_utc);
  const replay = await logOne(early.local_wall_offset, early.instant_utc);

  c.that(
    "fold_row_offsets",
    first.row.local_wall_offset === early.local_wall_offset &&
      second.row.local_wall_offset === late.local_wall_offset &&
      first.row.local_wall === second.row.local_wall,
    `two log rows derived from the two instants share local_wall ${first.row.local_wall} and differ only on local_wall_offset`,
  );

  // Scoped to THIS run's natural_key. The log is append-only and shared, and a
  // count over the whole table would be counting every earlier script's rows.
  const mine = await bench.db.query<{ n: string; offsets: string }>(
    "select count(*)::text as n, string_agg(distinct local_wall_offset, ',' order by local_wall_offset) as offsets" +
      " from changeover_log.access_log where record_source = $1 and natural_key = $2",
    [CONFORMANCE_SOURCE, natural_key],
  );
  c.is(
    "fold_natural_key",
    mine.rows[0]?.n,
    "2",
    "both survive: the ingest key carries local_wall_offset, so two sessions at one local_wall are two facts and ON CONFLICT DO NOTHING drops neither",
  );
  c.is(
    "fold_both_offsets",
    mine.rows[0]?.offsets,
    `${late.local_wall_offset},${early.local_wall_offset}`,
    "and the two rows are the two offsets, so the surviving pair is the pair that was written",
  );
  c.that(
    "fold_idempotent",
    replay.row.local_wall_offset === early.local_wall_offset && mine.rows[0]?.n === "2",
    "a third write repeating the first instant adds no row — idempotent ingest still holds, which is what makes the surviving second row a fact about the offset and not about the key being unique enough by accident",
  );
  c.is(
    "fold_slot",
    localWallSlot(first.row),
    2,
    "and the measurement slot derives from local wall time, so a marathon's 2am cohort stays on the Sunday instead of migrating into Saturday night once a year",
  );

  /* ── 6 · The GAP ──────────────────────────────────────────────────────── */

  const before_edge = localWallAt(gap.before.instant_utc, gap.timezone);
  const after_edge = localWallAt(gap.after.instant_utc, gap.timezone);
  c.that(
    "gap_edges",
    before_edge.local_wall === gap.before.local_wall &&
      after_edge.local_wall === gap.after.local_wall &&
      before_edge.local_wall_offset === gap.before.local_wall_offset &&
      after_edge.local_wall_offset === gap.after.local_wall_offset,
    `the clocks jump from ${before_edge.local_wall}${before_edge.local_wall_offset} straight to ${after_edge.local_wall}${after_edge.local_wall_offset}`,
  );

  // Minute by minute across the transition. The direction is the guarantee, so
  // the sweep asserts it rather than the comment asserting it.
  const start = Date.parse(gap.before.instant_utc) - 3600000;
  const absent_hour = gap.absent_local_wall.slice(0, 13);
  let swept = 0;
  let landed_in_gap = 0;
  for (let ms = start; ms <= start + 4 * 3600000; ms += 60000) {
    const wall = localWallAt(new Date(ms), gap.timezone);
    swept++;
    if (wall.local_wall.startsWith(absent_hour)) landed_in_gap++;
  }
  c.is(
    "gap_absent",
    landed_in_gap,
    0,
    `sweeping ${swept} consecutive minutes across the transition, no instant renders a local_wall in the ${absent_hour}:xx hour — deriving forward from an instant cannot produce a time the zone does not have`,
  );

  const error = gap.publisher_error;
  const actual = localWallAt(error.starts_at, gap.timezone);
  c.that(
    "gap_publisher_error",
    actual.local_wall === error.actual_local_wall &&
      actual.local_wall_offset === error.actual_local_wall_offset &&
      actual.local_wall !== error.claimed_local_wall,
    `an Occasion published as ${error.claimed_local_wall}${error.claimed_local_wall_offset} actually runs at ${actual.local_wall}${actual.local_wall_offset} — an hour out, silently, and §2.8 is why a Publisher MUST NOT emit a local_wall the zone does not have`,
  );

  // And the boundary can be asked about it: a hold naming a stale etag for one
  // of the two fold sessions must not resolve against the other.
  const crossed = await bench.call("POST", "/changeover/v0/holds", {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`clock-fold-${bench.nonce}`) },
    body: holdBody(["A:1"], {
      occasion_id: OCCASION.fold_nzdt,
      occasion_etag: ETAG[OCCASION.fold_nzst],
      sought: { occasion_id: OCCASION.fold_nzdt, occasion_etag: ETAG[OCCASION.fold_nzst] },
    }),
  });
  c.that(
    "fold_not_interchangeable",
    crossed.status === 412 || crossed.status === 409,
    `presenting the late session's etag against the early session is refused ${crossed.status} — the two 02:30s are not interchangeable at the boundary either`,
  );

  /* ── 7 · What this class deliberately does not claim ──────────────────── */

  c.cannot(
    "occasion_document_server_time",
    "§2.2 makes `server_time` REQUIRED on the Occasion document and K4 requires every server_time be derived from the Server's own time source, but the specification never says whether a STORED Occasion's server_time is re-projected at render. Both implementations in this tree serve the stored value verbatim while re-projecting the response envelope and the Changeover-Server-Time header, and §7's own C-CLOCK row is satisfied by those. The clause cannot be decided without a specification amendment, and deciding it here would be this harness legislating",
  );

  return c.items;
}
