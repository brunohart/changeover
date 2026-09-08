// C-PROFILE0. Owner: TEST-006.
//
// §7, the second half of the C-USAGE / C-PROFILE0 row: *"the static file
// validates, serves from a venue-authorised origin, and hold verbs return
// `501`."* C-USAGE is the other half.
//
// **Profile 0 is the claim that any cinema with a website is conformant with no
// software**, and the whole of that claim rests on one file: the capability
// document with its Occasions inline. So "validates" here is not the envelope
// alone — every embedded Occasion goes through `occasion.schema.json` as well,
// because a file whose wrapper validates and whose contents do not is a file an
// Agent cannot read, published by an exhibitor who was told they were done.
//
// **`501`, and the reason it is not `403` or `404`.** A Profile 0 site is not
// refusing this Agent and it is not hiding a Hold; it does not hold seats at
// all, and the honest answer to `hold_seats` is that the capability is not
// implemented here, with `use_book_url` beside it. G1 puts `profile_not_supported`
// first for the same reason — before schema validation, before the Occasion is
// even looked up — so a Profile 0 site cannot leak which of its Occasions exist
// through the *shape* of a refusal it was always going to give.
//
// **The cheap check is the status code, and it is not enough.** A Server that
// answered `501` after taking the seats would pass it. Every refusal below is
// therefore followed by a count over `hold` and `hold_seat`: a Profile 0 site
// must end the run with an empty hold store, because it has no Holds to have.
//
// **What cannot be reached here, stated once.** "Serves from a venue-authorised
// origin" is a property of the fetch. This bench binds both servers to
// 127.0.0.1 on an ephemeral port, so the origin the document arrives from is a
// loopback address and the assertion has no wire to be made on. What IS
// decidable — that the file names an authorised origin, and that every absolute
// URL inside it is same-origin under O1 — is asserted, and the residue is one
// unprovable clause rather than a green tick over a check nobody made.

import { sameOrigin } from "@changeover/core/claim.ts";
import { ROUTES } from "@changeover/http/routes.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { Call, ConformanceBench } from "./_bench.ts";
import { AUTHORISED_ORIGINS, ETAG, OCCASION, TOKEN, VENUE_ORIGIN, absoluteUrls, holdBody, key } from "./_bench.ts";

const CAPABILITY_SCHEMA_ID = "urn:changeover:schema:capability:0.1";
const OCCASION_SCHEMA_ID = "urn:changeover:schema:occasion:0.1";
const VALIDATOR_LIB = "packages/adapter-reference/test/lib/schema-validator.ts";

export const id = "C-PROFILE0";
export const spec_row =
  "The static file validates, serves from a venue-authorised origin, and hold verbs return 501.";

const ABSENT_HOLD = "hold_00000000000000000000000000000000";

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  /* ── 1 · The file ─────────────────────────────────────────────────────── */

  const served = await bench.call0("GET", "/.well-known/changeover");
  const file = (served.json ?? {}) as {
    profile?: string;
    occasions?: unknown[];
    occasions_url?: string;
    venue?: { origin?: string };
    authorised_origins?: string[];
  };
  c.is("served", served.status, 200, "the Profile 0 site answers its well-known path");
  c.is("profile", file.profile, "0", "and publishes profile 0, which is what makes the rest of this class the right questions to ask");

  const occasions = Array.isArray(file.occasions) ? file.occasions : [];
  c.that(
    "occasions_inline",
    occasions.length > 0,
    `the Occasions are in the file itself (${occasions.length} of them), so the capability document plus the Occasions IS the static file an exhibitor publishes — not a pointer to a service they would have to run`,
  );

  /* ── 2 · Validates, wrapper and contents ──────────────────────────────── */

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
    c.cannot(
      "occasions_validate",
      "same validator, same reason: the embedded Occasions cannot be checked against occasion.schema.json without it",
      VALIDATOR_LIB,
    );
  } else {
    c.is(
      "validates",
      validator(CAPABILITY_SCHEMA_ID, served.json),
      null,
      "the file validates against the frozen capability.schema.json",
    );

    const failures: string[] = [];
    for (const occasion of occasions) {
      const error = validator(OCCASION_SCHEMA_ID, occasion);
      if (error !== null) {
        const named = (occasion as { occasion_id?: string } | null)?.occasion_id ?? "unnamed";
        failures.push(`${named}: ${error.slice(0, 120)}`);
      }
    }
    c.is(
      "occasions_validate",
      failures.join(" · ") || "none",
      "none",
      `and every one of the ${occasions.length} Occasions inside it validates against occasion.schema.json — a wrapper that validates over contents that do not is a file an Agent cannot read`,
    );
  }

  /* ── 3 · Venue-authorised origin, as far as this bench can decide it ──── */

  c.that(
    "names_authorised_origin",
    typeof file.venue?.origin === "string" &&
      AUTHORISED_ORIGINS.some((origin) => sameOrigin(file.venue?.origin ?? "", origin)) &&
      Array.isArray(file.authorised_origins) &&
      file.authorised_origins.length > 0,
    `the file names its venue origin (${file.venue?.origin ?? "none"}) and the origins authorised under O3 (${(file.authorised_origins ?? []).join(", ")})`,
  );

  const off_origin = absoluteUrls(served.json)
    .filter(({ url }) => !AUTHORISED_ORIGINS.some((origin) => sameOrigin(url, origin)))
    .map(({ pointer, url }) => `${pointer}=${url}`);
  const planted = off_origin.filter((entry) => entry.includes(OCCASION.off_origin));
  c.is(
    "urls_same_origin",
    off_origin.filter((entry) => !entry.includes(OCCASION.off_origin)).join(" · ") || "none",
    "none",
    `every absolute URL in the static file is same-origin with venue.origin or a delegated origin under O1, except the ${planted.length} carried by the off-origin fixture this bench plants on purpose`,
  );

  /* ── 4 · Hold verbs return 501, and write nothing ─────────────────────── */

  const before = await bench.db.query<{ n: string }>("select count(*)::text as n from hold");
  const attempts: { verb: string; call: () => Promise<Call> }[] = [
    {
      verb: "hold_seats",
      call: () =>
        bench.call0("POST", "/changeover/v0/holds", {
          token: TOKEN.a,
          headers: { "Idempotency-Key": key(`p0-hold-${bench.nonce}`) },
          body: holdBody(["A:1"]),
        }),
    },
    { verb: "get_hold", call: () => bench.call0("GET", `/changeover/v0/holds/${ABSENT_HOLD}`, { token: TOKEN.a }) },
    { verb: "release_hold", call: () => bench.call0("DELETE", `/changeover/v0/holds/${ABSENT_HOLD}`, { token: TOKEN.a }) },
    {
      verb: "hand_off",
      call: () =>
        bench.call0("POST", `/changeover/v0/holds/${ABSENT_HOLD}/hand-off`, {
          token: TOKEN.a,
          headers: { "Idempotency-Key": key(`p0-off-${bench.nonce}`) },
          body: { read_token: "not-a-token" },
        }),
    },
    {
      verb: "revoke",
      call: () =>
        bench.call0("POST", `/changeover/v0/holds/${ABSENT_HOLD}/revoke`, {
          token: TOKEN.operator,
          body: { revocation_reason: "safety" },
        }),
    },
  ];

  const answers: string[] = [];
  let all_501 = true;
  let all_typed = true;
  for (const attempt of attempts) {
    const answer = await attempt.call();
    const code = (answer.json as { code?: string; remediation?: string } | null)?.code;
    answers.push(`${attempt.verb} → ${answer.status} ${code ?? "no code"}`);
    if (answer.status !== 501) all_501 = false;
    if (code !== "profile_not_supported") all_typed = false;
  }
  c.that("hold_verbs_501", all_501, `every hold verb answers 501 (${answers.join(" · ")})`);
  c.that(
    "hold_verbs_typed",
    all_typed,
    "and every one of them carries the code profile_not_supported rather than a bare status, so an Agent can switch on it and fall back to book_url without parsing prose",
  );

  const hold_verbs = ROUTES.filter((r) => r.hold_verb);
  c.is(
    "every_hold_verb_covered",
    attempts.length,
    hold_verbs.length,
    `and the ${hold_verbs.length} routes the binding marks as hold verbs (${hold_verbs.map((r) => r.name).join(", ")}) are exactly the ones put through above — a route added to that table and not to this class would be an untested surface`,
  );

  const after = await bench.db.query<{ n: string }>("select count(*)::text as n from hold");
  const seats = await bench.db.query<{ n: string }>("select count(*)::text as n from hold_seat");
  c.is(
    "wrote_nothing",
    `${after.rows[0]?.n ?? "?"}/${seats.rows[0]?.n ?? "?"}`,
    `${before.rows[0]?.n ?? "?"}/0`,
    "and the hold store is untouched afterwards — a 501 returned after taking the seats would have passed every clause above",
  );

  const idempotency = await bench.db.query<{ n: string }>(
    "select count(*)::text as n from idempotency where idempotency_key_hmac is not null",
  );
  c.is(
    "no_idempotency_record",
    Number(idempotency.rows[0]?.n ?? -1),
    0,
    "and no idempotency record was written either: G1 puts profile_not_supported first, before the envelope that would have recorded the attempt",
  );

  /* ── 5 · Legible, not switched off ────────────────────────────────────── */

  const page = await bench.call0("GET", "/changeover/v0/occasions", { token: TOKEN.a });
  const listed = ((page.json as { occasions?: unknown[] } | null)?.occasions ?? []).length;
  c.that(
    "reads_still_answer",
    page.status === 200 && listed === occasions.length,
    `the read surface still answers at Profile 0 (${page.status}, ${listed} Occasions) — the profile publishes rather than holds, and a site that refused reads too would be conformant with nothing`,
  );

  const single = await bench.call0("GET", `/changeover/v0/occasions/${OCCASION.main}`, {
    token: TOKEN.a,
    headers: { "If-Match": `"${ETAG[OCCASION.main]}"` },
  });
  c.is(
    "occasion_readable",
    single.status,
    200,
    "and one Occasion reads back on its own path, which is the surface an Agent walks before it discovers there is nothing to hold",
  );

  /* ── 6 · The origin this harness cannot serve from ────────────────────── */

  c.cannot(
    "served_from_venue_origin",
    `"serves from a venue-authorised origin" is a property of the fetch, and both servers on this bench bind to 127.0.0.1 on an ephemeral port: the document above arrived from ${bench.origin0}, which is same-origin with nothing the file names. What the file DECLARES is asserted in names_authorised_origin and urls_same_origin; what it was SERVED from cannot be observed until a run has a venue-controlled host to fetch from, and a bench that pointed venue.origin at its own loopback port would prove only that a string can be edited`,
  );

  return c.items;
}
