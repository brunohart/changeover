// C-SEATMAP. Owner: TEST-006.
//
// §7: *"The seat map validates, is same-origin, is credentialed, and its ids are
// accepted by `hold_seats`."*
//
// **"Its ids are accepted by `hold_seats`" is the clause with consequences.**
// §2.10 makes the seat map's ids *normatively* the ids `hold_seats` takes, and
// the failure it exists to prevent is quiet: a Server whose seat map says `F:11`
// and whose hold verb wants `F11` refuses every hold an Agent constructs from
// the document the Server itself published, with `unknown_seat` — a code that
// reads as the Agent's mistake. So this class does not compare two id formats
// for plausibility; it takes ids out of the seat map and puts them through the
// wire, and asserts the seats granted are byte-identical to the ids asked for.
//
// The map is obtained through the reference adapter, whose `seatMap` takes a
// credential as a parameter — which is what makes the "credentialed" clause
// assertable at all. The clause §2.10 states that this repository *cannot*
// answer is "served at `availability.seat_map_ref`": §6.3's binding has nine
// routes and none of them is a seat map, so the URL every Occasion publishes
// points at a path the Server does not answer. That is recorded as an
// unprovable clause naming the gap, and it is re-checked mechanically against
// the route table so that it turns red the day a tenth route appears.

import { createReferenceAdapter } from "@changeover/adapter-reference/reference.ts";
import { sameOrigin } from "@changeover/core/claim.ts";
import { ROUTES } from "@changeover/http/routes.ts";
import { isRefusal } from "@changeover/schema/refusal.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { ConformanceBench } from "./_bench.ts";
import { AUTHORISED_ORIGINS, OCCASION, TOKEN, grantHold, holdBody, key } from "./_bench.ts";

const SEATMAP_SCHEMA_ID = "urn:changeover:schema:seatmap:0.1";
const VALIDATOR_LIB = "packages/adapter-reference/test/lib/schema-validator.ts";

export const id = "C-SEATMAP";
export const spec_row =
  "The seat map validates, is same-origin, is credentialed, and its ids are accepted by hold_seats.";

interface SeatMapSeat {
  readonly seat_id: string;
  readonly status: string;
}

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  /* ── 1 · Same-origin, on the wire ─────────────────────────────────────── */

  const served = await bench.call("GET", `/changeover/v0/occasions/${OCCASION.main}`, { token: TOKEN.a });
  const seat_map_ref = String(
    (served.json as { availability?: { seat_map_ref?: string } } | null)?.availability?.seat_map_ref ?? "",
  );
  c.that(
    "published",
    seat_map_ref.length > 0,
    `the Occasion publishes availability.seat_map_ref (${seat_map_ref})`,
  );
  c.that(
    "same_origin",
    AUTHORISED_ORIGINS.some((origin) => sameOrigin(seat_map_ref, origin)),
    "and it is same-origin with venue.origin or a delegated origin, compared as a parsed triple (O1)",
  );

  /* ── 2 · The map itself, through the adapter that takes a credential ──── */
  //
  // Attached to THIS store, and seeding nothing: an adapter that opened its own
  // store would clear the estate, and under a real Postgres "its own store" is
  // this one.

  const adapter = await createReferenceAdapter({
    db: bench.db,
    migrated: true,
    seed_published: false,
    seed_measurement_house: false,
    measure_floor: false,
  });

  let map: Record<string, unknown> | null = null;
  try {
    map = (await adapter.seatMap(OCCASION.main, {
      agent_id: "agt_conf_a",
      principal_scope: "prin_conf_wellington",
    })) as Record<string, unknown>;
    c.ok("obtained", `the seat map for ${OCCASION.main} was obtained with a read credential`);
  } catch (err) {
    c.bad("obtained", `the seat map could not be obtained: ${isRefusal(err) ? err.code : String(err)}`);
  }

  /* ── 3 · Credentialed ─────────────────────────────────────────────────── */

  let uncredentialed = "granted";
  try {
    await adapter.seatMap(OCCASION.main, { agent_id: "", principal_scope: "" });
  } catch (err) {
    uncredentialed = isRefusal(err) ? err.code : "threw";
  }
  c.that(
    "credentialed",
    uncredentialed !== "granted",
    `a seat map requested without a credential is refused (${uncredentialed}) — §2.10: an unauthenticated seat map is an unbounded enumeration of the house layout`,
  );

  /* ── 4 · Validates ────────────────────────────────────────────────────── */

  let validator: ((schema_id: string, value: unknown) => string | null) | null = null;
  try {
    const lib = (await import("../../../adapter-reference/test/lib/schema-validator.ts")) as {
      schemaValidator: () => (schema_id: string, value: unknown) => string | null;
    };
    validator = lib.schemaValidator();
  } catch {
    validator = null;
  }

  if (validator === null) {
    c.cannot(
      "validates",
      "the compiled ajv validator over the frozen schemas could not be loaded, and eyeballing the members here would assert this file against itself",
      VALIDATOR_LIB,
    );
  } else if (map !== null) {
    const error = validator(SEATMAP_SCHEMA_ID, map);
    c.is("validates", error, null, "the seat map validates against the frozen seatmap.schema.json, additionalProperties and all");
  }

  /* ── 5 · Its ids are accepted by hold_seats ───────────────────────────── */

  const seats = ((map?.seats ?? []) as SeatMapSeat[]).filter((s) => s.status === "available");
  c.that("seats_listed", seats.length >= 3, `${seats.length} seats read back as available from the map`);

  const asked = seats.slice(0, 3).map((s) => s.seat_id);
  const held = await bench.call("POST", "/changeover/v0/holds", {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`seatmap-${bench.nonce}`) },
    body: holdBody(asked),
  });
  c.that(
    "ids_accepted",
    held.status === 201,
    `hold_seats accepts the ids the seat map published, unmodified: [${asked.join(", ")}] → ${held.status}`,
  );
  const granted = ((held.json as { seats?: string[] } | null)?.seats ?? []).join(",");
  c.is(
    "ids_identical",
    granted,
    asked.join(","),
    "and the seats it grants are byte-identical to the ids asked for — no normalisation between the document and the verb",
  );

  const stored = await bench.db.query<{ seat_id: string }>(
    "select seat_id from hold_seat where hold_id = $1 order by seat_id",
    [String((held.json as { hold_id?: string } | null)?.hold_id ?? "")],
  );
  c.is(
    "ids_in_store",
    stored.rows.map((r) => r.seat_id).sort().join(","),
    [...asked].sort().join(","),
    "and the same ids are what the store holds, so the agreement survives the write and is not a projection",
  );

  /* ── 6 · An id the map does not publish ───────────────────────────────── */
  //
  // The negative control. Without it, a Server that accepted every string would
  // pass every assertion above.

  const invented = await bench.call("POST", "/changeover/v0/holds", {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`seatmap-bad-${bench.nonce}`) },
    body: holdBody(["QQ:404"]),
  });
  c.that(
    "unknown_seat",
    invented.status === 400 && (invented.json as { code?: string } | null)?.code === "unknown_seat",
    `a seat id the map does not publish is refused unknown_seat, so the acceptance above is the map's ids and not any string (got ${invented.status})`,
  );

  /* ── 7 · Held seats read back as held ─────────────────────────────────── */

  const after = (await adapter.seatMap(OCCASION.main, {
    agent_id: "agt_conf_a",
    principal_scope: "prin_conf_wellington",
  })) as { seats: SeatMapSeat[] };
  const now_held = after.seats.filter((s) => asked.includes(s.seat_id));
  c.that(
    "held_reads_back",
    now_held.length === asked.length && now_held.every((s) => s.status === "held"),
    `the three seats this run holds read back as \`held\` in the next map, so the document a second Agent resolves reflects the boundary's own Holds (${now_held.map((s) => s.status).join(", ")})`,
  );

  await adapter.close();

  /* ── 8 · What §6.3 does not serve ─────────────────────────────────────── */

  const seat_routes = ROUTES.filter((r) => r.pattern.endsWith("/seats") || r.name.includes("seat_map"));
  c.cannot(
    "served",
    `§2.10 says the seat map is SERVED at availability.seat_map_ref, and §6.3's binding declares ${ROUTES.length} routes of which ${seat_routes.length} serve one. Every Occasion this Server publishes therefore names a URL the Server does not answer, and "served from a venue-authorised origin" has no wire to be observed on. The map above was obtained through the adapter method, which is an in-process call and has no origin`,
    "packages/http/src/routes.ts",
  );

  return c.items;
}
