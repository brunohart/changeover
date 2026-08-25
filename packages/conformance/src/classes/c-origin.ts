// C-ORIGIN. Owner: TEST-006.
//
// §7: *"Every absolute URL is same-origin with `venue.origin` or a delegated
// origin; a fixture with an off-origin `book_url` is rejected at publish and
// refused by the reference Agent; a cross-origin redirect on the well-known path
// is refused."*
//
// O1 (SPEC.md:255) is the rule and O2 assigns the *checking* of it to the
// consumer, on the ground that the party serving a document cannot constrain
// itself by inspecting it. That is exactly why this class is written the way it
// is: it asserts what the Server EMITS, which is falsifiable, and it refuses to
// dress the consumer half up as proven.
//
// **The off-origin fixture is seeded on purpose and is not excluded from the
// scan.** Excluding it would make the headline assertion "every URL is
// same-origin, except the ones that are not", which is not an assertion. Instead
// the scan runs over everything and the class asserts the exact partition: the
// only document carrying an off-origin URL is the one this bench planted, and it
// carries exactly the URL that was planted. What that demonstrates is O3's
// absence — there is no publish surface in `ROUTES` at all, so nothing in this
// tree can reject an Occasion at publish, and the store hands the boundary
// whatever a fixture loader put in it.
//
// The prefix trap is asserted against the shipped comparator rather than a local
// one. `https://embassy.example.evil.test` passes `startsWith("https://embassy.example")`,
// and a string-prefix origin check is the single most common way this rule is
// implemented wrongly.

import { originOf, sameOrigin } from "@changeover/core/claim.ts";
import { ROUTES } from "@changeover/http/routes.ts";

import type { ClauseOutcome } from "./_contract.ts";
import { Clauses } from "./_contract.ts";
import type { ConformanceBench } from "./_bench.ts";
import {
  AUTHORISED_ORIGINS,
  FOREIGN_ORIGIN,
  OCCASION,
  TOKEN,
  VENUE_ORIGIN,
  absoluteUrls,
  grantHold,
  key,
} from "./_bench.ts";

export const id = "C-ORIGIN";
export const spec_row =
  "Every absolute URL is same-origin with venue.origin or a delegated origin; a fixture with an off-origin book_url is rejected at publish and refused by the reference Agent; a cross-origin redirect on the well-known path is refused.";

/** O1's comparison: the parsed triple, through the comparator the Server ships. */
function authorised(url: string): boolean {
  return AUTHORISED_ORIGINS.some((origin) => sameOrigin(url, origin));
}

/** RFC 3986 userinfo. O1: invalid regardless of host. */
function carriesUserinfo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return true;
  }
}

interface Emission {
  readonly what: string;
  readonly document: unknown;
}

export async function run(bench: ConformanceBench): Promise<readonly ClauseOutcome[]> {
  const c = new Clauses(id);
  await bench.reset();

  /* ── 1 · Collect every document this boundary emits ───────────────────── */

  const emissions: Emission[] = [];
  const capability = await bench.call("GET", "/.well-known/changeover");
  emissions.push({ what: "capability", document: capability.json });
  const delegation = await bench.call("GET", "/.well-known/changeover/delegation.json");
  emissions.push({ what: "delegation", document: delegation.json });

  const page = await bench.call("GET", "/changeover/v0/occasions", { token: TOKEN.a });
  const occasions = ((page.json as { occasions?: unknown[] } | null)?.occasions ?? []) as Record<string, unknown>[];
  for (const document of occasions) {
    emissions.push({ what: `occasion:${String(document.occasion_id)}`, document });
  }

  const held = await grantHold(bench, TOKEN.a, ["A:1"], {}, `origin-${bench.nonce}`);
  emissions.push({ what: "hold", document: held.json });
  const hold_id = String((held.json as { hold_id?: string } | null)?.hold_id ?? "");
  const read = await bench.call("GET", `/changeover/v0/holds/${hold_id}`, { token: TOKEN.a });
  emissions.push({ what: "get_hold", document: read.json });
  const handed = await bench.call("POST", `/changeover/v0/holds/${hold_id}/hand-off`, {
    token: TOKEN.a,
    headers: { "Idempotency-Key": key(`origin-off-${bench.nonce}`) },
    body: { read_token: (read.json as { read_token?: string } | null)?.read_token },
  });
  emissions.push({ what: "hand_off", document: handed.json });

  c.that(
    "surface",
    emissions.length >= 10 && handed.status === 200,
    `${emissions.length} emitted documents collected across the bootstrap, read and hold surfaces, hand-off included (hand_off ${handed.status})`,
  );

  /* ── 2 · The scan, and the exact partition it produces ────────────────── */

  const offenders = new Map<string, string[]>();
  let scanned = 0;
  for (const emission of emissions) {
    for (const { pointer, url } of absoluteUrls(emission.document)) {
      scanned++;
      if (!authorised(url)) {
        const list = offenders.get(emission.what) ?? [];
        list.push(`${pointer}=${url}`);
        offenders.set(emission.what, list);
      }
    }
  }
  c.that("scanned", scanned >= 15, `${scanned} absolute URLs walked across those documents`);

  const offending = [...offenders.keys()].sort();
  const expected_offender = `occasion:${OCCASION.off_origin}`;
  c.is(
    "o1_partition",
    offending.join(","),
    expected_offender,
    "exactly one emitted document carries an off-origin URL, and it is the fixture this bench planted; every other absolute URL is same-origin with venue.origin or with the delegated origin",
  );
  c.is(
    "o1_planted",
    (offenders.get(expected_offender) ?? []).join(","),
    `/book_url=${FOREIGN_ORIGIN}/book/${OCCASION.off_origin}`,
    "and the one it carries is exactly the planted `book_url`, unchanged — nothing between the fixture loader and the wire looked at it",
  );

  /* ── 3 · userinfo, and the prefix trap ────────────────────────────────── */

  const with_userinfo: string[] = [];
  for (const emission of emissions) {
    for (const { pointer, url } of absoluteUrls(emission.document)) {
      if (carriesUserinfo(url)) with_userinfo.push(`${emission.what}${pointer}`);
    }
  }
  c.is("userinfo", with_userinfo.length, 0, "no emitted URL carries userinfo, which O1 makes invalid regardless of host");

  const trap = `${VENUE_ORIGIN}.evil.test/changeover/v0/occasions`;
  c.that(
    "parsed_triple",
    trap.startsWith(VENUE_ORIGIN) && !sameOrigin(trap, VENUE_ORIGIN),
    `the comparator the Server ships rejects ${trap}, which passes a string-prefix test against ${VENUE_ORIGIN} — O1 is a parsed (scheme, host, port) triple and a prefix check is the usual way it is got wrong`,
  );
  c.is(
    "normalised",
    originOf("HTTPS://EMBASSY.EXAMPLE:443/x"),
    VENUE_ORIGIN,
    "and it ASCII-lowercases the host and normalises the default port, so one origin has one spelling",
  );

  /* ── 4 · The claim URL ────────────────────────────────────────────────── */

  const claim_url = String(
    (handed.json as { handoff?: { claim_url?: string } } | null)?.handoff?.claim_url ?? "",
  );
  c.that(
    "claim_url",
    claim_url.length > 0 && sameOrigin(claim_url, VENUE_ORIGIN),
    `the claim_url minted at hand-off is same-origin with venue.origin (${claim_url.slice(0, 60)})`,
  );

  /* ── 5 · The well-known path does not redirect ────────────────────────── */

  const manual = await bench.call("GET", "/.well-known/changeover", { redirect: "manual" });
  c.that(
    "no_redirect",
    manual.status < 300 || manual.status >= 400,
    `GET /.well-known/changeover answers ${manual.status} with the redirect unfollowed — the Server emits no hop for a consumer to follow off-origin`,
  );
  c.that(
    "no_location",
    manual.headers.get("location") === null,
    "and carries no Location header",
  );

  /* ── 6 · What cannot be reached from here ─────────────────────────────── */

  // The blocker re-checks itself against the route table rather than against a
  // path: `packages/http/src/routes.ts` exists, so naming it as a `missing_path`
  // would be a blocker that could never go stale. What is absent is a ROUTE, and
  // the day one appears this clause must stop being unprovable — so it turns
  // into a failure that says so, rather than staying quietly grey.
  const publish_routes = ROUTES.filter((r) => r.method === "POST" && r.verb === null && r.name !== "revoke");
  if (publish_routes.length > 0) {
    c.bad(
      "o3_publish",
      `this clause has been unprovable because no route accepts an Occasion, and ${publish_routes.length} now does (${publish_routes.map((r) => r.name).join(", ")}). O3's publish-time rejection is reachable and must be asserted here rather than skipped`,
    );
  } else {
    c.cannot(
      "o3_publish",
      `O3 requires a Server reject an Occasion violating O1 at publish with 400 schema_validation, and there is no publish surface: ROUTES declares ${ROUTES.length} routes and ${publish_routes.length} of them accept an Occasion. The store is loaded by a fixture seeder, and clause o1_planted above shows what the boundary then emits — so the rule has nowhere to be enforced rather than somewhere it is enforced wrongly`,
    );
  }
  c.cannot(
    "agent_refuses",
    "O2 assigns the refusal to the consumer — an Agent MUST NOT present, navigate to, or pass on a URL failing O1, and MUST NOT follow a cross-origin redirect. There is no Agent in this repository, and an Agent written here could not falsify the claim anyway",
    "packages/agent",
  );

  return c.items;
}
