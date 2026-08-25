# Decisions

Architecture decision records for CHANGEOVER. Each is Status / Context / Decision / Consequences, dated. A decision is
recorded when it forecloses something — an ADR that rules nothing out is a note.

The order of this file and `SPEC.md` relative to any implementation is itself a claim, and
[`scripts/prove_spec_first.sh`](scripts/prove_spec_first.sh) asserts it against the root commit, forever.

---

## ADR-001 — No settlement verb. Permanently.

**Status** Accepted, 2026-08-25.

**Context.** Settlement is finished and contested by parties with balance sheets — AP2, ACP, UCP, Mastercard Agent Pay,
Visa Intelligent Commerce. Discovery is deployed: Regal Cineworld's ChatGPT app answers showtime questions across 5,386
screens and then directs users to Regal's own website to complete the purchase (Variety, Boxoffice Pro, 10 Apr 2026).
The gap is neither of those. It is the walk between them.

An agent is a consumer with no judgement. Its instructions can be rewritten by text it met somewhere else entirely — a
synopsis field, a programme note, a free-text column in a file someone else produced. There is no version of *the agent
knows not to charge the card.*

**Decision.** A conforming Server exposes **no operation that settles, authorises, captures, refunds, or prices a
transaction.** Not deferred. Not permission-checked. Not behind a scope. **Absent from the surface**, so that no
instruction can reach one. `tools/list` MUST NOT contain any tool matching `settle|pay|capture|refund|charge`.

**Consequences.** The customer is handed back to the exhibitor's own checkout, on the exhibitor's own domain, with the
F&B upsell exactly where the exhibitor already put it — and the Server never learns whether the order completed. The
grain is therefore *formed intent*, never conversion. That is a real analytical loss, accepted deliberately: a thing an
agent must not do should not be asked not to do. `prove_no_settlement_verb.sh` asserts the absence, and asserts it over
the member manifest as well as the verb list. The pattern deliberately omits `price` — `price_disclosure`,
`price_basis` and `price_band` are legitimate read-side members, and a check that fails on them is a check somebody
disables.

---

## ADR-002 — Two cue marks: `floor_ms` immovable, `expires_at` upward only.

**Status** Accepted, 2026-08-25.

**Context.** In changeover projection there are two cue marks, seven or eight seconds apart: the motor cue starts the
second projector, the changeover cue throws the dowser. Two marks, one deadline. A hold has the same geometry and every
published surface collapses it to one number — and then moves that number. Vista's documented order expiry is
configured at two independent points plus a grace period, is automatically extended by any endpoint that mutates the
order, can be extended *"by a separate tab or window"*, and releases through background processes that *"may take a few
minutes"* (developer.vista.co, retrieved 2026-08-24). Sane for a browser with a human watching a countdown.
Unstated for an autonomous consumer.

A single immovable TTL is honest at a reference implementation that owns its own store, and **unenforceable** above an
incumbent sweeper nobody controls.

**Decision.** Two typed deadlines. **`floor_ms`** is merchant-set, may be shortened at grant, is **never** lengthened by
a read and **never** moved by a concurrent session, and is the only value an Agent may plan against.
**`expires_at`** is a movable merchant intention, upward only, reported on every read, always `>= floor_deadline`.
`extendable` is `const false`.

**Consequences.** An Agent gets a number it can subtract from a clock. An exhibitor keeps the right to be generous.
The floor is a **warranty, not an assertion**: `floor_ms` MUST NOT exceed `min_observed_retention_ms - safety_margin_ms`,
both published in `floor_evidence`, and where no measurement exists the refusal is `503 floor_unavailable`. An operator
who sets 180000 because a worked example does, above an order whose configured expiry is 120 seconds with an eager
reaper, emits a lie with a MUST NOT beside it.

---

## ADR-003 — Substitutability is a directional preorder, authored as rules, enforced at commit.

**Status** Accepted, 2026-08-25.

**Context.** Every published agentic-commerce schema models a catalogue as fungible, quantity-counted, shippable stock.
UCP's `item.json` is six fields with no time, place, format or duration. ACP's `variant_options` models interchangeable
choices *within* a product: a 70mm print at seven becomes a variant of the film the way a shoe comes in blue. An agent
optimising a fungible catalogue treats format and start time as price-comparable attributes and routes to the cheapest —
inverting the economics an industry runs on where under 1% of screens take roughly 20% of global box office.

Substitutability is **not symmetric**. A 70mm print is an acceptable substitute for a DCP; the DCP is not an acceptable
substitute for the 70mm.

**Decision.** A **preorder** — reflexive, transitive, deliberately not antisymmetric. **The absence of an edge is the
absence of permission, never its presence.** Edges are authored as **rules over classes**, never pairs over instances;
the Server derives the per-Occasion edge set at publish and MUST emit the transitive closure. An Agent returns the
**maximal antichain**, not an argmax, and MUST NOT rank across a strict boundary by price. At commit, `hold_seats`
carries a REQUIRED `sought`, and crossing a strict boundary is `412 substitution_refused` with no row written.

**Consequences.** A merchant *preference* becomes a merchant *right*, because a mechanism can now refuse. An arthouse
authors roughly eight rules once and never touches them again, which is the only version a circuit rebuilding thousands
of screenings every change-day would ever adopt. One sharp edge, named: domination can drop a cheaper option, and the
remedy is not to attest the edge. The right is exercisable in one direction, by one party, and it is the party whose
room it is. And `sought` is **Agent-asserted and unverifiable** — a liability rule recorded against a revocable
credential, not an interlock. That is the one blocking review finding not fully closed (SPEC.md §10.1).

---

## ADR-004 — `PROJECTION_0_1` is closed; prose is outside it, assertions are inside it.

**Status** Accepted, 2026-08-25.

**Context.** An etag over the whole document moves when an availability counter ticks, which is every few seconds, and
every in-flight resolution across an estate dies with it. An etag over too little silently tolerates a moved start time.

**Decision.** `etag = "1:" || base64url_unpadded(SHA-256(JCS(project(occasion, PROJECTION_0_1))))`. The projection is a
**closed** list of JSON Pointers. A member not named is **excluded**. Adding one is a **major** under V2. RFC 8785; the
`1:` prefix is algorithm agility; truncation is not permitted.

**Consequences.** The digest catches exactly the failures that matter — a moved start time, a changed price or price
basis, a changed format, a changed access provision, a changed hold policy, a withdrawn or added non-substitutability
assertion, and a swapped work. A typo fix in a programme note does not. **One correction, made in this commit:** SPEC.md
§2.4 read *"every prose value"* is excluded, which contradicted §2.2's ✓ column projecting `work.title.value`. §2.2 is
authoritative — a title is the assertion about *which film*. See `docs/2026-08-25-cx-01-spec-first.md`.

---

## ADR-005 — Oversell is made unrepresentable, not prevented.

**Status** Accepted, 2026-08-25. **No code in this commit implements it; the decision precedes the implementation.**

**Context.** Application logic that checks before writing is a race with extra steps.

**Decision.** A **partial unique index** on `(showtime_id, seat_id)` whose predicate includes every seat-occupying
state — `live`, `handed_off`, **and `claimed`**. The draft omitted `claimed`, which let a seat be re-held after a claim.

**Corrected 2026-08-25.** This ADR originally wrote the index over `(occasion_id, seat_id)`, contradicting SPEC.md §4.6
and §2.2 — which labels `showtime_ref` *"the index key of §4.6"*. The specification is right and this record was wrong.
The scarce thing is a seat at a **physical screening**, and `showtime_ref` exists precisely so a publisher can map
several Occasions onto one screening: a premiere and a standard listing of the same 7pm show, or two price bands sold
as separate Occasions. Keyed on `occasion_id`, two such Occasions can each hold seat F11 and both commit — the index
sees two distinct keys and the house sells one seat twice. That is oversell arriving *through* the constraint written
to make it unrepresentable. The two keys are identical only while `showtime_ref` is absent, which is true of every
golden fixture, which is why the divergence survived review. Found while decomposing the build into issues; the
migration and `prove_migrations.sh` now assert the key as well as the predicate.

**Consequences.** Two concurrent holds on one seat cannot both commit, because the second violates a constraint rather
than losing an argument. `C-ATOMIC` asserts it at 200 concurrent holds on a 100-seat house: exactly 100 succeed, 100
typed `409`, zero oversell, zero partial holds, zero deadlocks. And it is worth **nothing** while authoritative seat
state lives in a CMS written by the box office, kiosks, the app and the phone room — which is what ADR-008 exists to say
out loud.

---

## ADR-006 — Correctness never rests on a sweeper.

**Status** Accepted, 2026-08-25.

**Context.** A background reaper is an availability mechanism dressed as a correctness one. It runs late, it runs twice,
it does not run because the process died, and the documented incumbent behaviour is that release *"may take a few
minutes"*.

**Decision.** Reclaim happens in the **next contending transaction**. An expired row is reclaimed by whoever next wants
the seat, in the same transaction that wants it. A sweeper may exist; nothing may depend on it.

**Consequences.** `C-ORPHAN` runs with the sweeper **disabled** and the client `SIGKILL`ed, and asserts that seats *and
budgets* return via the next contender. A two-seat hold contended on one seat leaves zero rows.

---

## ADR-007 — Lock 2 is an allowlist with asserted set equality, never a denylist of words.

**Status** Accepted, 2026-08-25.

**Context.** cinema-ops-platform's transferable invention is not the medallion stack; it is a governance pattern
expressed three times in three substrates — the query never selects it, the response type has no field for it, the role
holds no grant on it. **PII is absent from the response shape, not redacted from it.** A filter is behaviour that must
run correctly every time; a missing field is structure. The draft of this repository proposed a denylist of nine English
words, which is defeated by `patron_ref`, `booker` or `contact_handle`, and which collides with `venue.name` on its
first run.

**Decision.** A manifest of **every member name declared across the eight document schemas** — the keys of every
`properties` object, at every depth — asserted by **set equality in both directions**.

**Consequences.** The day someone adds a member, CI fails until a human writes that name into the manifest **in the same
diff**. Adding a personal-data field becomes an act a person must perform deliberately, in public, in the diff. It is
live from the root commit, before there is anything to leak. Scope is deliberately a **superset** of leaf members:
container names are members too, and a manifest that ignored them would let `patron { name, email }` arrive with only
its leaves scrutinised.

---

## ADR-008 — Profile 1S and `measured_warranty` are the honest names for a shim above a CMS.

**Status** Accepted, 2026-08-25.

**Context.** The unique index of ADR-005 makes oversell unrepresentable in CHANGEOVER's own table. Every real deployment
is a shim above a cinema management system whose seat state is written by four other channels. Claiming Profile 1 above
one would be a lie with a schema around it.

**Decision.** Three profiles. **0 (Legible)** — a static JSON file at a well-known URL; any cinema with a website is
conformant with no software, and `availability.mode: "unknown"` is first-class, meaning *not sold out and not available*.
**1 (Held)** — `hold_basis: system_of_record`; the store defined here is the store. **1S (Shadow)** —
`hold_basis: shadow`, `floor_basis: measured_warranty`; MAY mint Holds, MUST NOT be advertised as Profile 1, MUST publish
its measured `oversell_rate`, and MUST run `C-ATOMIC` against the composite system with a concurrent POS writer.

**Consequences.** Profile 0 makes the ~67% of US theatre locations that are independent, and the ~25% running one or two
screens, addressable on their own domain rather than excluded (Cinema Alliance, 19 May 2026). Profile 1S means the
honest answer to *"is this real above a CMS?"* is a published measurement rather than a claim — including a bad one.
