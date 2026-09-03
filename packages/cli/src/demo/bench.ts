// The demo's two exhibitors. Owner: DEMO-001.
//
// **Two Servers, because there are two exhibitors.** §6.3's credential is
// issued per site, and `capability.ts` says it in as many words: *one server
// instance serves one site, because a process serving two sites would have to
// decide which site an unauthenticated `/.well-known/changeover` request meant,
// and every answer to that is a guess.* The estate spans four venues at two
// origins, so it is served by two processes' worth of Server with a store each.
//
// That is not staging. It is the constraint the substitution reel is about: E1
// requires every substitution edge to target an Occasion at the same
// `venue.origin` and E3 scopes `cluster` to `(venue.origin, cluster)`, so the
// three rooms that argue about what substitutes for what MUST be one operator,
// and the fourth site MUST be someone else. An estate that hid this behind one
// process would let a reader believe cross-exhibitor substitution was merely
// unimplemented rather than out of scope.
//
// **Every Server measures its own floor before it publishes one.** §7: *a
// Server MUST NOT grant a floor it has not measured.* `measureRetention` is
// ADAPT-001's, it grants real Holds against a house of its own and watches when
// the seats come back, and the number it returns is what caps
// `policy_max_floor_ms` here. The demo therefore cannot print a floor nobody
// observed — which is the difference between a warranty and a constant.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import type { Db } from "@changeover/store/db.ts";
import { openDb } from "@changeover/store/db.ts";
import { migrate } from "@changeover/store/migrate.ts";
import type { Estate } from "@changeover/store/fixtures.ts";
import {
  NZ_FOUR_SITE,
  NZ_ORIGIN_CIRCUIT,
  NZ_ORIGIN_INDEPENDENT,
  occasionsAtOrigin,
  seedEstate,
} from "@changeover/store/fixtures.ts";
import type { HoldPolicyDocument } from "@changeover/core/budgets.ts";
import { HOLD_POLICY_PUBLISHED, principalBudgets } from "@changeover/core/budgets.ts";
import type { RetentionMeasurement } from "@changeover/adapter-reference/floor.ts";
import { measureRetention } from "@changeover/adapter-reference/floor.ts";
import { warrantedPolicy } from "@changeover/adapter-reference/capability.ts";
import type { SiteConfig } from "@changeover/http/capability.ts";
import type { SiteCredential } from "@changeover/http/credential.ts";
import { tokenDirectory } from "@changeover/http/credential.ts";
import { createServer } from "@changeover/http/server.ts";

/* ── 1 · Who is calling ────────────────────────────────────────────────────── */

/**
 * Two households on one platform, and an operator.
 *
 * The second household exists to make X2 legible: `hold_cluster_live` is keyed
 * on `(agent_id, principal_scope, origin, cluster)`, so a fan-out refusal for
 * one principal says nothing about another. A demo with one principal could not
 * tell "this Server refuses a second hold in a cluster" apart from "this Server
 * refuses a second hold".
 */
export const AGENT_TOKEN = "tok_demo_agent_wellington";
export const OTHER_TOKEN = "tok_demo_agent_second_household";

export const DEMO_AGENT_ID = "agt_demo";

function credential(site_id: string, principal_scope: string): SiteCredential {
  return { agent_id: DEMO_AGENT_ID, principal_scope, site_id, surfaces: ["agent"] };
}

/* ── 2 · One exhibitor ─────────────────────────────────────────────────────── */

export interface ExhibitorOptions {
  readonly site_id: string;
  readonly origin: string;
  readonly venue_id: string;
  readonly venue_name: string;
  readonly locality: string;
  readonly contact: string;
  /** Trials × probe floor is most of this Server's boot time. See the note above. */
  readonly floor_trials: number;
  readonly probe_floor_ms: number;
  /** Keys the claim-token MAC. Explicit so the link-scanner reel can present one. */
  readonly claim_secret: string;
}

export interface Exhibitor {
  readonly site_id: string;
  readonly origin: string;
  readonly venue_name: string;
  readonly db: Db;
  readonly server: Server;
  /** `http://127.0.0.1:<port>` — where the reels actually send bytes. */
  readonly base: string;
  readonly estate: Estate;
  readonly measurement: RetentionMeasurement;
  /** The policy this Server both enforces and publishes. One object (§2.5). */
  readonly policy: HoldPolicyDocument;
  readonly claim_secret: string;
  close(): Promise<void>;
}

const SAFETY_MARGIN_MS = 500;

export async function bootExhibitor(options: ExhibitorOptions): Promise<Exhibitor> {
  const db = await openDb();
  await migrate(db);

  const estate = occasionsAtOrigin(NZ_FOUR_SITE, options.origin);
  await seedEstate(db, estate);

  // §7, on the way up rather than at the first request: a Server that cannot
  // warrant a floor should find out while it is starting, not while a customer
  // is waiting. `require_warrantable` defaults true, so a machine too slow to
  // warrant anything usable throws here instead of publishing a number.
  const measurement = await measureRetention(db, {
    trials: options.floor_trials,
    probe_floor_ms: options.probe_floor_ms,
    safety_margin_ms: SAFETY_MARGIN_MS,
    agent_id: "agt_demo_floor_probe",
  });

  // The enforced policy IS the published policy, clamped once, handed to the
  // guard and to the capability document. `policy_max_floor_ms` cannot exceed
  // what the measurement above warrants.
  const policy = warrantedPolicy(HOLD_POLICY_PUBLISHED, measurement.evidence);

  const site: SiteConfig = {
    site_id: options.site_id,
    profile: "1",
    venue: {
      id: options.venue_id,
      name: { content_type: "text/plain", value: options.venue_name },
      origin: options.origin,
      timezone: "Pacific/Auckland",
      locality: options.locality,
    },
    authorised_origins: [options.origin],
    apex: true,
    hold_policy: policy,
    claim_binding: "deep_link",
    // §9's gate: the human confirms BEFORE a seat is locked.
    gate_stage: "hold",
    hold_basis: "system_of_record",
    floor_basis: "owned_store",
    floor_evidence: measurement.evidence,
    usage_policy: {
      redistribution: "forbidden",
      cache_max_age_ms: 30000,
      contact: options.contact,
    },
    occasions_url: `${options.origin}/changeover/v0/occasions`,
  };

  const server = createServer({
    db,
    site,
    tokens: tokenDirectory({
      [AGENT_TOKEN]: credential(options.site_id, "prin_demo_household"),
      [OTHER_TOKEN]: credential(options.site_id, "prin_demo_second_household"),
    }),
    hold_seats: {
      profile: "1",
      policy,
      // X1/X3/X4 at the numbers this Server publishes. There is no softened
      // demo profile: a transcript produced at ceilings nobody ships is a
      // transcript about a configuration file.
      budgets: principalBudgets(policy),
    },
    hand_off: { claim_secret: options.claim_secret },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    site_id: options.site_id,
    origin: options.origin,
    venue_name: options.venue_name,
    db,
    server,
    base: `http://127.0.0.1:${address.port}`,
    estate,
    measurement,
    policy,
    claim_secret: options.claim_secret,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

/* ── 3 · Both of them ──────────────────────────────────────────────────────── */

export interface Bench {
  /** The circuit: three rooms, one operator, one cluster, the substitution edges. */
  readonly circuit: Exhibitor;
  /** The independent: one room, another origin, and no seat map to publish. */
  readonly independent: Exhibitor;
  readonly boot_ms: number;
  close(): Promise<void>;
}

export interface BenchOptions {
  /** Trials the circuit's floor measurement takes. Its Holds are the ones granted. */
  readonly floor_trials?: number;
  readonly probe_floor_ms?: number;
}

export async function bootBench(options: BenchOptions = {}): Promise<Bench> {
  const started = Date.now();
  // Concurrently, because the two are independent stores and the measurement is
  // mostly waiting: booting them in series would spend the sum of two windows
  // to learn two unrelated facts.
  const [circuit, independent] = await Promise.all([
    bootExhibitor({
      site_id: "site_aro_circuit",
      origin: NZ_ORIGIN_CIRCUIT,
      venue_id: "ven_kereru",
      venue_name: "Aro Circuit",
      locality: "Wellington",
      contact: "boxoffice@aro-circuit.example",
      floor_trials: options.floor_trials ?? 2,
      probe_floor_ms: options.probe_floor_ms ?? 15000,
      claim_secret: "demo-claim-key-aro-circuit",
    }),
    bootExhibitor({
      site_id: "site_whitcombe",
      origin: NZ_ORIGIN_INDEPENDENT,
      venue_id: "ven_whitcombe",
      venue_name: "The Whitcombe",
      locality: "Ōtautahi Christchurch",
      contact: "boxoffice@whitcombe.example",
      // This Server grants nothing in this run — its only reel is refused at G1
      // step 5, three steps before a floor is minted. It measures anyway,
      // because §7 addresses Servers and not the ones that happen to be busy.
      floor_trials: 1,
      probe_floor_ms: 4000,
      claim_secret: "demo-claim-key-whitcombe",
    }),
  ]);

  return {
    circuit,
    independent,
    boot_ms: Date.now() - started,
    async close() {
      await Promise.all([circuit.close(), independent.close()]);
    },
  };
}
