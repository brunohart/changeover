/**
 * C-ATOMIC .1 – .4. Owner: TEST-001.
 *
 * §7: *"Harness profile stated: budgets disabled, `max_seats_per_hold: 1`,
 * fixed seed. 200 concurrent holds on a 100-seat house: exactly 100 succeed,
 * 100 typed `409`, zero oversell, zero partial holds, zero `40P01`. **.2** 50%
 * of the seat set carries rows expiring within ±100ms of harness start — zero
 * `40P01`. **.3** after a claim, a hold naming that seat returns `409` and
 * writes no row. **.4** one valid + one invalid seat writes zero rows."*
 *
 * .1 and .2 are claims about two callers racing and are made **only** against a
 * real multi-connection Postgres. PGlite 0.5.7 is PostgreSQL 18.3 and enforces
 * the partial unique indexes for real, but it is single-connection and
 * in-process: lock contention and `40P01` cannot occur there, so a pass on it
 * would mean nothing. `.3` and `.4` are sequential, need no second connection,
 * and run everywhere.
 */

import type { Db } from "@changeover/store/db.ts";
import { migrate, resetEstate, resetHoldStore } from "@changeover/store/migrate.ts";
import { seedEstate } from "@changeover/store/fixtures.ts";
import type { HoldSeatsOptions } from "@changeover/core/hold-seats.ts";
import { BUDGETS_UNENFORCED } from "@changeover/core/hold-seats.ts";
import { getHold } from "@changeover/core/get-hold.ts";
import { handOff } from "@changeover/core/hand-off.ts";
import { confirmClaim, parseClaimUrl } from "@changeover/core/claim.ts";

import type { AtomicProfile } from "./profile.ts";
import { C_ATOMIC_PROFILE, mulberry32, seedNumber, seededShuffle } from "./profile.ts";
import {
  ATOMIC_SHOWTIME,
  LISTING,
  LISTINGS,
  UNKNOWN_SEAT,
  atomicEstate,
  atomicSeatIds,
  etagFor,
} from "./estate.ts";
import type { Contender, Outcome } from "./contend.ts";
import { ServerVanished, startSampler } from "./sampler.ts";
import {
  AGENT_ID,
  census,
  codeSummary,
  contend,
  occupantsOf,
  physicalOversell,
  raceAll,
  rowsOfHold,
  tally,
} from "./contend.ts";

/**
 * Below this the calls did not overlap and "N concurrent" would be a lie.
 *
 * Deliberately low. The claim is *they raced*, not *they raced this hard*, and
 * a threshold tuned to one machine's timings is a flake waiting for a slower
 * one. Serial execution scores 1.0 by construction; anything at 2 or above had
 * at least two calls in flight for at least half the run.
 */
export const MIN_OVERLAP = 2;

/**
 * The server's own account of the race, and the assertion that makes .1 and .2
 * claims about the boundary rather than about this process's event loop.
 *
 * Client-side overlap counts time spent waiting for a connection, so a pool of
 * one scores well above 1.0 while running strictly one transaction at a time.
 * `pg_stat_activity` cannot be fooled that way: it counts backends, and two
 * backends inside a transaction at one instant is what "concurrent" means.
 */
function reportPeak(report: Reporter, label: string, peak: number | null, profile: AtomicProfile): void {
  if (peak === null) {
    report.bad(`${label} — no sampler could be opened, so nothing observed the server during the race`);
    return;
  }
  peak >= 2
    ? report.ok(
        `${label} — the race is on the SERVER: pg_stat_activity showed up to ${peak} of this harness's ` +
          `backends inside a transaction at one instant, against a pool of ${profile.pool_size}`,
      )
    : report.bad(
        `${label} — the server never had two transactions in flight at once (peak ${peak}): the contenders ` +
          "queued for a connection and every assertion below would hold for a scenario nobody claimed",
      );
}

function reportOverlap(report: Reporter, label: string, r: { span_ms: number; summed_ms: number; overlap: number }, trials: number): void {
  r.overlap >= MIN_OVERLAP
    ? report.ok(
        `${label} — the calls genuinely overlapped: ${trials} contenders spent ${r.summed_ms}ms in flight ` +
          `across ${r.span_ms}ms of wall clock, an overlap of ${r.overlap.toFixed(1)}× (serial is 1.0)`,
      )
    : report.bad(
        `${label} — overlap ${r.overlap.toFixed(2)}×: ${r.summed_ms}ms of calls in ${r.span_ms}ms of wall ` +
          "clock is a queue, not a race, and every assertion below would hold for a scenario nobody claimed",
      );
}

/** One `ok — ` line per assertion, which is what `run_proofs.sh` counts. */
export interface Reporter {
  ok(message: string): void;
  bad(message: string): void;
  /** Evidence that is not an assertion. Never counted, never a pass. */
  note(message: string): void;
}

/**
 * Budgets **explicitly** disabled rather than left to the default.
 *
 * `holdSeats` already falls back to `BUDGETS_UNENFORCED`, so passing it changes
 * nothing at runtime — and that is the point: a profile that is stated in prose
 * and achieved by omission is one CORE-006 default away from being false while
 * the report still says "budgets disabled".
 */
export function atomicOptions(max_seats_per_hold: number): HoldSeatsOptions {
  return { profile: "1", budgets: BUDGETS_UNENFORCED, policy: { max_seats_per_hold } };
}

/** Migrate, clear, and seed the two listings. §12: own your estate. */
export async function setUpAtomicEstate(db: Db, profile: AtomicProfile = C_ATOMIC_PROFILE) {
  await migrate(db);
  // Holds first: `hold` references `occasion`, so the estate cannot be cleared
  // out from under a Hold that a previous script left behind.
  await resetHoldStore(db);
  await resetEstate(db);
  const estate = atomicEstate(profile);
  await seedEstate(db, estate);
  return estate;
}

/**
 * The 200 contenders: each of the house's 100 seats sought twice, once at each
 * listing, by a principal of its own — and fired in a seeded shuffle so that
 * the pairs do not arrive in lockstep. Lockstep order is the one arrangement
 * under which a per-listing lock looks correct.
 */
export function contenders(profile: AtomicProfile, tag: string): Contender[] {
  const seats = atomicSeatIds(profile);
  const rand = mulberry32(seedNumber(profile.seed + ":" + tag));
  const all: Contender[] = [];
  for (let i = 0; i < seats.length; i++) {
    const seat = seats[i] as string;
    all.push({ occasion_id: LISTING.premiere, seats: [seat], principal_scope: `ppid_${tag}_p${i}` });
    all.push({ occasion_id: LISTING.standard, seats: [seat], principal_scope: `ppid_${tag}_s${i}` });
  }
  return seededShuffle(all, rand);
}

async function seatsWithExactlyOneOccupant(db: Db): Promise<number> {
  const r = await db.query<{ n: string }>(
    `select count(*)::text as n from (
       select seat_id from hold_seat
        where showtime_id = $1 and state in ('live','handed_off','claimed')
        group by seat_id having count(*) = 1) d`,
    [ATOMIC_SHOWTIME],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/* ── .1 · 200 concurrent holds on a 100-seat house ─────────────────────────── */

export async function raceHouse(
  db: Db,
  report: Reporter,
  profile: AtomicProfile = C_ATOMIC_PROFILE,
): Promise<void> {
  await resetHoldStore(db);
  const options = atomicOptions(profile.max_seats_per_hold);
  const who = contenders(profile, "race");

  const sampler = await startSampler();
  const race = await raceAll(db, who, options, profile.requested_floor_ms);
  const peak = sampler === null ? null : await sampler.stop();
  const outcomes: Outcome[] = race.outcomes;
  const t = tally(outcomes);
  const c = await census(db);

  if (t.unreachable > 0) throw new ServerVanished(".1");

  reportOverlap(report, ".1", race, profile.trials);
  reportPeak(report, ".1", peak, profile);

  t.grants === profile.house_capacity
    ? report.ok(
        `.1 — ${profile.trials} concurrent holds on a ${profile.house_capacity}-seat house: exactly ` +
          `${t.grants} succeeded`,
      )
    : report.bad(`.1 — ${t.grants} of ${profile.trials} succeeded, expected exactly ${profile.house_capacity}`);

  const contendedRefusals = t.codes["seat_contended"] ?? 0;
  contendedRefusals === profile.house_capacity && t.refusals === profile.house_capacity
    ? report.ok(
        `.1 — the other ${t.refusals} are typed 409 seat_contended, every one of them, and not one is an ` +
          `untyped failure`,
      )
    : report.bad(`.1 — refusals were ${codeSummary(t)}, expected ${profile.house_capacity}×seat_contended`);

  t.faults === 0
    ? report.ok(".1 — zero unclassified faults: every caller got a Hold or a refusal from the closed taxonomy")
    : report.bad(`.1 — ${t.faults} faults: ${t.fault_detail.slice(0, 4).join(" | ")}`);

  t.deadlocks === 0
    ? report.ok(".1 — zero 40P01: the seat locks are taken in one total order, so contenders wait rather than cycle")
    : report.bad(`.1 — ${t.deadlocks} deadlocks detected; the lock order is not total`);

  c.oversold === 0
    ? report.ok(
        ".1 — zero oversell, read from the store: no (showtime_id, seat_id) is carried by two occupying rows",
      )
    : report.bad(`.1 — ${c.oversold} seats are held twice at one showtime — the house sold a seat twice`);

  const physical = await physicalOversell(db, LISTINGS);
  physical === 0
    ? report.ok(
        ".1 — and zero oversell of the PHYSICAL auditorium, counted without consulting showtime_id at all: " +
          "no seat of the one screening is held by two Holds across its two listings",
      )
    : report.bad(
        `.1 — ${physical} seats of the one physical screening are held twice across its two listings — the ` +
          "floor is keyed on the listing, so the house sold each of them once at each price band",
      );

  c.partial === 0
    ? report.ok(".1 — zero partial holds: no Hold carries some of its granted seats and not the rest")
    : report.bad(`.1 — ${c.partial} Holds carry a strict subset of their granted seats`);

  c.holds === profile.house_capacity && c.occupied === profile.house_capacity
    ? report.ok(
        `.1 — the store agrees with the responses: ${c.holds} hold rows and ${c.occupied} occupying seat rows`,
      )
    : report.bad(
        `.1 — the store carries ${c.holds} holds and ${c.occupied} occupying seat rows, expected ` +
          `${profile.house_capacity} of each`,
      );

  const singly = await seatsWithExactlyOneOccupant(db);
  singly === profile.house_capacity
    ? report.ok(`.1 — every one of the ${profile.house_capacity} seats is held exactly once`)
    : report.bad(`.1 — ${singly} of ${profile.house_capacity} seats are held exactly once`);

  c.slots === 0 && c.cluster_rows === 0
    ? report.ok(
        ".1 — the profile is what it says it is: zero hold_slot and zero hold_cluster rows, so no ceiling and " +
          "no fan-out index could have refused a caller in place of the seat index",
      )
    : report.bad(
        `.1 — budgets were not disabled after all: ${c.slots} slot rows, ${c.cluster_rows} cluster rows`,
      );
}

/* ── .2 · half the seat set expiring within ±100ms of the moment they fire ─── */

/**
 * Age `hold_ids` so each Hold's `expires_at` lands `jitter_ms` from **one**
 * clock read.
 *
 * Every deadline column shifts by the same interval, which preserves
 * `hold_floor_derived` (`floor_deadline = granted_at + floor_ms`) and
 * `hold_expiry_not_before_floor` by construction rather than by arithmetic. The
 * anchor is `now()` — transaction start, `STABLE` — and not `clock_timestamp()`,
 * which is `VOLATILE` and re-evaluated at every occurrence: two reads, two
 * different microseconds, and `23514 hold_floor_derived`. That form has bitten
 * this build at four separate sites.
 */
async function ageToBoundary(db: Db, hold_ids: readonly string[], jitter_ms: readonly number[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `with j as (select * from unnest($1::text[], $2::int[]) as t(hold_id, jitter_ms)),
            d as (select h.hold_id,
                         h.expires_at - (now() + (j.jitter_ms * interval '1 millisecond')) as delta
                    from hold h join j on j.hold_id = h.hold_id)
       update hold h
          set granted_at     = h.granted_at     - d.delta,
              floor_deadline = h.floor_deadline - d.delta,
              expires_at     = h.expires_at     - d.delta
         from d
        where d.hold_id = h.hold_id`,
      [hold_ids, jitter_ms],
    );
    // T6: held_until = expires_at while live. The reap reads this column.
    await tx.query(
      `update hold_seat s set held_until = h.expires_at
         from hold h where h.hold_id = s.hold_id and s.hold_id = any($1::text[])`,
      [hold_ids],
    );
  });
}

export async function raceExpiryBoundary(
  db: Db,
  report: Reporter,
  profile: AtomicProfile = C_ATOMIC_PROFILE,
): Promise<void> {
  await resetHoldStore(db);
  const seats = atomicSeatIds(profile);
  const doomedSeatCount = Math.round(seats.length * profile.doomed_fraction);
  const width = profile.doomed_hold_seats;

  // The fixture Holds. Granted through the verb — a Hold hand-written into the
  // store is a Hold no guard ever saw, and the reap would then be reaping
  // something the grant path could not have produced.
  const seeding = atomicOptions(width);
  const doomed: string[] = [];
  for (let i = 0; i < doomedSeatCount; i += width) {
    const group = seats.slice(i, i + width);
    const outcome = await contend(
      db,
      { occasion_id: LISTING.premiere, seats: group, principal_scope: `ppid_incumbent_${i}` },
      seeding,
      profile.requested_floor_ms,
    );
    if (outcome.kind !== "grant") {
      report.bad(`.2 — the fixture could not be seeded: ${JSON.stringify(outcome).slice(0, 160)}`);
      return;
    }
    doomed.push(outcome.hold_id);
  }

  const rand = mulberry32(seedNumber(profile.seed + ":boundary"));
  const jitter = doomed.map(() => Math.round((rand() * 2 - 1) * profile.expiry_window_ms));

  doomed.length === Math.ceil(doomedSeatCount / width)
    ? report.ok(
        `.2 — ${doomed.length} fixture Holds ${width} seats wide cover ${doomedSeatCount} of ` +
          `${seats.length} seats; the other ${seats.length - doomedSeatCount} are free and have no row to lock`,
      )
    : report.bad(`.2 — seeded ${doomed.length} fixture Holds, expected ${Math.ceil(doomedSeatCount / width)}`);

  await ageToBoundary(db, doomed, jitter);
  const past = jitter.filter((j) => j <= 0).length;
  report.note(
    `.2 — the boundary is real: ${past} of ${doomed.length} fixture Holds expire at or before the fire ` +
      `instant and ${doomed.length - past} just after it, spread over ±${profile.expiry_window_ms}ms`,
  );

  const options = atomicOptions(profile.max_seats_per_hold);
  const who = contenders(profile, "boundary");
  const sampler = await startSampler();
  const race = await raceAll(db, who, options, profile.requested_floor_ms);
  const peak = sampler === null ? null : await sampler.stop();
  const outcomes: Outcome[] = race.outcomes;
  const t = tally(outcomes);
  const c = await census(db);

  if (t.unreachable > 0) throw new ServerVanished(".2");

  reportOverlap(report, ".2", race, profile.trials);
  reportPeak(report, ".2", peak, profile);

  t.deadlocks === 0
    ? report.ok(
        `.2 — zero 40P01 across an expiry boundary: ${profile.trials} single-seat contenders raced ` +
          `${doomed.length} reapable multi-seat Holds and none deadlocked. L1 locks the FULL requested set ` +
          "irrespective of whether a row exists, so the free seats and the doomed ones are one sequence",
      )
    : report.bad(
        `.2 — ${t.deadlocks} × 40P01: the reap and the grant computed different lock sequences across the ` +
          "expiry boundary, which is what an L1 that only locks existing rows does",
      );

  t.faults === 0
    ? report.ok(".2 — zero unclassified faults: every contender ended in a grant or a typed refusal")
    : report.bad(`.2 — ${t.faults} faults: ${t.fault_detail.slice(0, 4).join(" | ")}`);

  t.grants + t.refusals === profile.trials
    ? report.ok(`.2 — all ${profile.trials} contenders were answered (${t.grants} grants, ${codeSummary(t)})`)
    : report.bad(`.2 — ${t.grants + t.refusals} of ${profile.trials} contenders were answered`);

  c.oversold === 0 && (await physicalOversell(db, LISTINGS)) === 0
    ? report.ok(
        ".2 — zero oversell across the boundary, by (showtime_id, seat_id) and by physical seat alike: a " +
          "reaped seat was re-held once, never twice",
      )
    : report.bad(`.2 — ${c.oversold} seats carried two occupying rows after the boundary race`);

  c.partial === 0
    ? report.ok(
        ".2 — zero partial holds: the reap ran by HOLD and not by seat, so no fixture Hold lost one seat and " +
          "kept the other",
      )
    : report.bad(`.2 — ${c.partial} Holds carry a strict subset of their granted seats`);

  c.occupied <= profile.house_capacity
    ? report.ok(
        `.2 — the store carries ${c.occupied} occupying rows for a ${profile.house_capacity}-seat house, ` +
          "which is the ceiling the physical auditorium has",
      )
    : report.bad(`.2 — ${c.occupied} occupying rows in a ${profile.house_capacity}-seat house`);

  const survivors = await db.query<{ n: string }>(
    "select count(*)::text as n from hold_seat where hold_id = any($1::text[])",
    [doomed],
  );
  report.note(
    `.2 — ${Number(survivors.rows[0]?.n ?? 0)} fixture seat rows survived; the rest were reaped by the ` +
      "contention they met, on no sweeper's schedule",
  );
}

/* ── .3 · after a claim, a hold naming that seat returns 409 and writes no row ─ */

export async function claimedSeatIsUnholdable(
  db: Db,
  report: Reporter,
  profile: AtomicProfile = C_ATOMIC_PROFILE,
): Promise<void> {
  await resetHoldStore(db);
  const options = atomicOptions(profile.max_seats_per_hold);
  const seat = atomicSeatIds(profile)[0] as string;
  const credential = { agent_id: AGENT_ID, principal_scope: "ppid_buyer" };

  const granted = await contend(
    db,
    { occasion_id: LISTING.premiere, seats: [seat], principal_scope: credential.principal_scope },
    options,
    profile.requested_floor_ms,
  );
  if (granted.kind !== "grant") {
    report.bad(`.3 — could not grant the Hold to claim: ${JSON.stringify(granted).slice(0, 160)}`);
    return;
  }

  const read = await getHold(db, granted.hold_id, credential);
  if (read.read_token === undefined) {
    report.bad(".3 — get_hold minted no read_token, so the hand-off T4 requires cannot be made");
    return;
  }
  const handed = await handOff(db, { hold_id: granted.hold_id, read_token: read.read_token }, credential);
  // CL5: minted once, at hand-off, and never re-derivable. If it is absent the
  // Hold cannot be claimed at all and .3 has no claim to test against.
  const claim_url = handed.hold.handoff?.claim_url;
  const presented = claim_url === undefined ? null : parseClaimUrl(claim_url);
  if (presented === null) {
    report.bad(".3 — the hand-off carried no claim_url that parses");
    return;
  }
  const claimed = await confirmClaim(db, presented, { binding_ref: "sess_first_touch" });
  claimed.ok === true
    ? report.ok(`.3 — seat ${seat} is claimed: the customer completed at the exhibitor's own checkout`)
    : report.bad(`.3 — the claim did not confirm: ${JSON.stringify(claimed).slice(0, 160)}`);

  const before = await census(db);

  // Same listing, and then the sibling listing of the same physical screening.
  // The second is the one that matters: `hold_seat_occupied` is keyed on
  // showtime_id, so a Server keyed on occasion_id answers 201 here and the seat
  // is sold twice — once by the box office and once by an agent.
  for (const [label, occasion_id] of [
    ["the same listing", LISTING.premiere],
    ["the sibling listing of the same screening", LISTING.standard],
  ] as const) {
    const after = await contend(
      db,
      { occasion_id, seats: [seat], principal_scope: "ppid_latecomer_" + occasion_id },
      options,
      profile.requested_floor_ms,
    );
    after.kind === "refusal" && after.status === 409
      ? report.ok(
          `.3 — a hold naming the claimed seat from ${label} returns 409 ${after.code}: ` +
            "`claimed` is in the uniqueness predicate, so a sold seat never becomes re-holdable",
        )
      : report.bad(`.3 — from ${label} the answer was ${JSON.stringify(after).slice(0, 200)}, expected a 409`);
  }

  const now = await census(db);
  now.holds === before.holds && now.seat_rows === before.seat_rows
    ? report.ok(
        `.3 — and wrote no row: ${before.holds} hold rows and ${before.seat_rows} seat rows before the two ` +
          "refusals, the same after",
      )
    : report.bad(
        `.3 — the refusals wrote rows: holds ${before.holds}→${now.holds}, seat rows ` +
          `${before.seat_rows}→${now.seat_rows}`,
      );

  (await occupantsOf(db, ATOMIC_SHOWTIME, seat)) === 1
    ? report.ok(`.3 — seat ${seat} is still occupied exactly once, by the claim`)
    : report.bad(`.3 — seat ${seat} is occupied ${await occupantsOf(db, ATOMIC_SHOWTIME, seat)} times`);
}

/* ── .4 · one valid + one invalid seat writes ZERO rows ────────────────────── */

export async function allOrNothing(
  db: Db,
  report: Reporter,
  profile: AtomicProfile = C_ATOMIC_PROFILE,
): Promise<void> {
  await resetHoldStore(db);
  const options = atomicOptions(profile.max_seats_per_hold_all_or_nothing);
  const seats = atomicSeatIds(profile);
  const valid = seats[0] as string;
  const taken = seats[1] as string;

  /* (a) valid + unknown. W1: refused 400 unknown_seat, inside the transaction. */
  const empty = await census(db);
  const unknown = await contend(
    db,
    { occasion_id: LISTING.premiere, seats: [valid, UNKNOWN_SEAT], principal_scope: "ppid_typo" },
    options,
    profile.requested_floor_ms,
  );
  unknown.kind === "refusal" && unknown.code === "unknown_seat"
    ? report.ok(`.4 — [${valid}, ${UNKNOWN_SEAT}] is refused 400 unknown_seat, not held in part`)
    : report.bad(`.4 — valid + unknown answered ${JSON.stringify(unknown).slice(0, 200)}`);

  let after = await census(db);
  after.holds === empty.holds && after.seat_rows === empty.seat_rows
    ? report.ok(
        ".4 — and wrote ZERO rows: an unvalidated seat id never becomes a permanent row nothing will reap",
      )
    : report.bad(`.4 — valid + unknown wrote ${after.seat_rows - empty.seat_rows} seat rows`);

  /* (b) valid + contended. The sharper half: this one fails at the INSERT. */
  const incumbent = await contend(
    db,
    { occasion_id: LISTING.premiere, seats: [taken], principal_scope: "ppid_incumbent" },
    atomicOptions(1),
    profile.requested_floor_ms,
  );
  if (incumbent.kind !== "grant") {
    report.bad(`.4 — could not seed the contended seat: ${JSON.stringify(incumbent).slice(0, 160)}`);
    return;
  }
  const held = await census(db);

  const mixed = await contend(
    db,
    // The sibling listing again, so the collision is the cross-listing one.
    { occasion_id: LISTING.standard, seats: [valid, taken], principal_scope: "ppid_greedy" },
    options,
    profile.requested_floor_ms,
  );
  mixed.kind === "refusal" && mixed.status === 409
    ? report.ok(
        `.4 — [${valid} free, ${taken} held] is refused 409 ${mixed.code} — a refusal is thrown, never mixed ` +
          "with rows, and first failure wins",
      )
    : report.bad(`.4 — free + contended answered ${JSON.stringify(mixed).slice(0, 200)}`);

  after = await census(db);
  after.holds === held.holds && after.seat_rows === held.seat_rows
    ? report.ok(
        `.4 — and wrote ZERO rows: still ${held.holds} hold row and ${held.seat_rows} seat row, so the hold ` +
          "row the insert needed in order to have anything to hang a seat on was rolled back with it",
      )
    : report.bad(
        `.4 — free + contended left holds ${held.holds}→${after.holds}, seat rows ` +
          `${held.seat_rows}→${after.seat_rows}`,
      );

  (await occupantsOf(db, ATOMIC_SHOWTIME, valid)) === 0
    ? report.ok(`.4 — seat ${valid} is still free: there is no such thing as a partial hold`)
    : report.bad(`.4 — seat ${valid} was held by a request that was refused`);

  const rows = await rowsOfHold(db, incumbent.hold_id);
  rows.length === 1 && rows[0] === taken
    ? report.ok(`.4 — the incumbent Hold is untouched and still carries exactly [${taken}]`)
    : report.bad(`.4 — the incumbent Hold now carries [${rows.join(", ")}]`);
}

/** Exported so a report can name the etag the contenders presented. */
export { etagFor };
