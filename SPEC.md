# CHANGEOVER — Technical Specification

**Version** 0.1 · **Status** Working draft, revised after adversarial review · **Date** 2026-08-25
**Editor** designedbybruno · **Specification** MIT · **Reference implementation** MIT · **Boundary corpus** BSL 1.1, Change Date 2029-05-03

> A changeover is the eight seconds in which two machines run at once so the audience never sees the seam.

*Independent work. Not affiliated with, endorsed by, or officially connected to any cinema platform vendor. Vendor behaviour is cited from public documentation with its retrieval date; anything unestablished is marked **unverified**.*

---

## 0 · Conventions

BCP 14 key words apply when capitalised. Schemas are JSON Schema 2020-12. Timestamps are RFC 3339 with a mandatory offset. Durations an implementation reasons about are **integers in milliseconds** — a duration subtracted from a deadline should not need a parser.

| Target | Definition |
|---|---|
| **Server** | Software run by, or for, an exhibitor at an origin that exhibitor authorises. |
| **Agent** | An autonomous consumer with no human watching its clock. |
| **Publisher** | The party authoring Occasions. Normally the exhibitor; in repertory, whoever programmes the season. |
| **Operator** | A human at the exhibitor's own console. Not a protocol participant; §4.3 gives them authority over it. |

Normative rules are lettered by concern: **T** time · **K** clock · **I** idempotency · **L** locking · **N** isolation · **G** guard order · **M** derived state · **S** substitution · **E** edges · **X** exhaustion · **Z** authorisation · **O** origin · **HO** hand-off · **CL** claim · **R** release · **W** seats · **P** inbound text · **D** intent digest · **A** access log · **PR** prose · **Q** volume · **V** versioning.

---

## 1 · Scope

### 1.1 Normatively covered

The **Occasion** (a read model for one screening: work, room, instant, manner, access, availability, price, and the exhibitor's assertions about it); the **Hold** (a server-minted, single-consumption, non-extendable seat lease with typed deadlines); **five verbs** — `resolve_occasions`, `hold_seats`, `get_hold`, `release_hold`, `hand_off` — and **the claim endpoint** the last addresses; one **closed refusal taxonomy**; the **substitution preorder**, authored as rules and enforced at commit; **three profiles** (0 Legible, 1 Held, 1S Shadow); **two bindings** (MCP 2026-07-28, HTTP/1.1+); and **conformance**.

### 1.2 Out of scope, permanently

A conforming Server **MUST NOT** expose, and this specification does not define, any operation that settles, authorises, captures, refunds, or prices a transaction. There is **no settlement verb** — not deferred, not permission-checked; the surface has no such operation, so no instruction can reach one. Also out of scope: customer identity, accounts, loyalty, F&B, dynamic pricing, discovery ranking, cross-exhibitor aggregation, distribution rights, and any hosted endpoint operated by this specification's author in the transaction path. A Server **MAY** operate all of those. It **MUST NOT** operate them through this surface.

*Settlement is finished and contested by parties with balance sheets. Discovery is deployed: Regal Cineworld's ChatGPT app answers showtime questions across 5,386 screens and then "users are then directed to Regal's website to complete ticket purchases" (Variety, Boxoffice Pro, 10 Apr 2026). What has no contract is the walk between them.*

### 1.3 Where the gap is, in the specifications' own words

Above the exhibitor, no stack defines a hold. UCP disclaims one in normative text — *"recognizing an ID neither reserves inventory nor guarantees eligibility"* (`fulfillment.md` L367, HEAD verified 2026-08-22); AP2 names inventory once and assigns it to the merchant (`docs/ap2/specification.md` L44); ACP's 2026-04-17 checkout OpenAPI returns one hit for `reserv|hold|inventory`, and it is the word *preserves*; Edgar Dunn & Company's cinema reference architecture (3 May 2026) terminates at the payment token.

Below the exhibitor the contract is ambiguous, and the documentation is candid: order expiry is configured at two independent points plus a grace period, is **automatically extended by any endpoint that mutates the order**, can be extended *"by a separate tab or window"*, and releases through background processes that *"may take a few minutes"* (developer.vista.co, Order expiry, retrieved 2026-08-24). No idempotency convention appears on the public Conventions page. Veezi publishes `SeatsHeld` as a count with no hold object (api.us.veezi.com/help, retrieved 2026-08-24). A sane contract for a browser with a human watching a countdown; an unstated one for an autonomous consumer.

---

## 2 · The data model

### 2.1 Why a screening is not an item

Every published agentic-commerce schema models a catalogue as fungible, quantity-counted, shippable stock. UCP's `item.json` is six fields — `id, title, price, quantity_unit, unit_price, image_url` — with no time, place, format or duration. ACP's `variant_options` models interchangeable choices *within* a product: a 70mm print at seven becomes a variant of the film the way a shoe comes in blue. An agent optimising a fungible catalogue treats format and start time as price-comparable attributes and routes to the cheapest, inverting the economics the industry runs on, where under 1% of screens take roughly 20% of global box office. The central object here carries **no quantity**. It is *this work, in this room, at this instant, in this manner*.

### 2.2 Occasion — `urn:changeover:schema:occasion:0.1`

`additionalProperties: false` throughout. **P** = in PROJECTION_0_1 (§2.4).

| Member | Type / constraint | Req | P |
|---|---|---|---|
| `changeover` | `const "0.1"` | ✓ | ✓ |
| `occasion_id` | `opaqueId` | ✓ | ✓ |
| `revision` | integer ≥ 1, strictly increasing per publish | ✓ | — |
| `etag` | `^1:[A-Za-z0-9_-]{43}$` | ✓ | — |
| `showtime_ref` | `{source ≤32, showtime_id: opaqueId}` — the index key of §4.6 | — | — |
| `venue` | `{id, name: prose, origin, timezone, locality?}` | ✓ | id, origin, timezone |
| `venue.origin` | `^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$` — a **bare origin**: no userinfo, path, query or fragment | ✓ | ✓ |
| `auditorium` | `{id, seating: allocated\|unallocated\|unknown, name?, capacity?, why_this_room?}` | ✓ | id, seating, capacity |
| `work` | `{title: prose, eidr?, isan?, year?, runtime_minutes?, synopsis?, release_date_local?}` | ✓ | eidr, title.value, year, runtime_minutes |
| `instant` | `{starts_at, local_wall, local_wall_offset, doors_at?, feature_at?, ends_at?, sales_cutoff_at?}` | ✓ | starts_at, local_wall, local_wall_offset, sales_cutoff_at |
| `instant.local_wall` | `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` · `local_wall_offset` `^[+-]\d{2}:\d{2}$` | ✓ | ✓ |
| `manner.presentation_classes` | array, 1–16, `^(pres:[a-z0-9-]+\|x-[a-z0-9-]+)$` | ✓ | ✓ |
| `manner.occasion_classes` | array ≤ 8, `^(occ:…\|x-…)$` | — | ✓ |
| `manner.register_version` | `^\d{4}\.\d+$` | ✓ | ✓ |
| `manner.accessibility` | `{open_captions, captioning_devices, audio_description, assistive_listening, wheelchair_spaces, relaxed_environment, sensory_adjusted}`, each `yes\|no\|unknown` | ✓ | ✓ |
| `manner.note` | `{body: prose, authored_by: venue\|programmer, authored_at}` | — | — |
| `availability` | `{mode: seat_map\|count\|unknown, observed_at, staleness_basis: measured\|configured\|unknown, sold_out?, seats_available?, seat_map_ref?, max_staleness_ms? ≤ 3600000}` | ✓ | **mode only** |
| `price_disclosure` | `published \| at_checkout \| member_dependent` | ✓ | ✓ |
| `offers` | array 0–64, sorted by `offer_id` (C collation), each `{offer_id, band: prose, currency ^[A-Z]{3}$, amount_minor ≥ 0, price_basis, total_at_checkout_minor?, eligibility_note?}` | ✓ | offer_id, currency, amount_minor, price_basis |
| `offers[].price_basis` | `{includes_mandatory_fees: bool, includes_tax: bool, tax_note?}` | ✓ | ✓ |
| `substitution` | `urn:changeover:schema:substitution:0.1` | ✓ | ✓ (whole) |
| `hold_policy` | `urn:changeover:schema:hold-policy:0.1` — REQUIRED at Profile 1/1S, absent at Profile 0 | cond | ✓ (whole) |
| `book_url` | `https` URI, same-origin under O1 | — | — |
| `server_time` | date-time | ✓ | — |

`$defs`: `opaqueId` = string 1–128; `prose` = `{content_type: enum ["text/plain"], value ≤ 2000}`.

> **Z3.** An Agent **MUST NOT** parse, order, or derive meaning from an `opaqueId`, and a Server **MUST NOT** make one enumerable: `occasion_id`, `venue.id`, `auditorium.id`, `offer_id`, seat ids and the claim token **MUST NOT** be sequential, timestamp-ordered, or derived from a database key.

**Price honesty.** An Agent **MUST NOT** present `amount_minor` as the price payable unless `includes_mandatory_fees` and `includes_tax` are both true; otherwise it **MUST** present a from-price and state that fees apply, or present `total_at_checkout_minor`. **A Hold does not fix price**, and an Agent **MUST NOT** represent a quote as guaranteed. `price_disclosure: at_checkout` with an empty `offers` array is fully conformant: an exhibitor whose price depends on membership, day or promotion is not required to publish a number they know to be wrong.

**Access.** `manner.accessibility` is REQUIRED and inside the projection. **Where an Agent's expressed intent touches any accessibility axis it MUST NOT return an Occasion whose corresponding member is `no`, and MUST mark `unknown` as unconfirmed rather than satisfied.** A surface that expresses price and format but not access routes discriminatorily by omission, and the complaint names the exhibitor (28 CFR §36.303(g), effective 2017; NZ Human Rights Act 1993 s.44).

### 2.3 Non-substitutability, authored as rules

Substitutability is **not symmetric**. A 70mm print at seven is an acceptable substitute for a DCP at nine; the DCP is not an acceptable substitute for the 70mm. CHANGEOVER models it as a **preorder** — reflexive, transitive, deliberately not antisymmetric. `s ⪯ s'` reads *"s′ is an acceptable substitute for s."* **The absence of an edge is the absence of permission, never its presence.**

Edges are authored **as rules over classes, never as pairs over instances**. A circuit rebuilds thousands of screenings every change-day and every `occasion_id` is new; a graph re-authored weekly at O(n²) in the cluster is a graph nobody authors twice.

```jsonc
{ "$id": "urn:changeover:schema:substitution-policy:0.1",
  "required": ["policy_id","rule_version","rules"],
  "rules[]": { "required": ["rule_id","subject","relation","object","policy",
                            "reason_code","authored_by","authored_at","effective_from"],
    "scope":    { "venue_id?": "", "work_id?": "", "cluster_pattern?": "" },
    "subject":  "presentation_class | occasion_class | axis",
    "relation": ["accepts_substitute","not_substitutable_for"],
    "object":   "presentation_class | occasion_class | axis",
    "policy":   ["strict","advisory"],
    "reason_code": ["format","carrier","occasion","accessibility","language","room","time"],
    "detail":   "prose?", "effective_to": "date?" } }
```

An arthouse writes roughly eight of these once — *"`pres:35mm-4perf` is not substituted by any `pres:dcp-*` — carrier — strict"* — and never touches them again. **A Server MUST derive the per-Occasion edge set from the policy at publish time, MUST emit the transitive closure, and MUST emit `substitution.derived_from {policy_id, rule_ids[], rule_version}`.** Transitivity is a Server obligation, not a property asserted of hand-authored data a Publisher can break by omission.

The wire form, `urn:changeover:schema:substitution:0.1`, REQUIRED `{cluster ≤128, policy: strict|advisory, accepts_substitute[], not_substitutable_for[], derived_from}`. Each edge is `{occasion_id: opaqueId, axis: instant|auditorium|presentation_class|occasion_class|price_band|seat|accessibility}`, with `reason_code` and optional `detail: prose` additionally REQUIRED on negative edges. Both arrays cap at 64 entries.

> **E1.** Every edge target **MUST** identify an Occasion published at the same `venue.origin`. A Server **MUST** reject at publish (`400 schema_validation`) any edge whose target is not resolvable at its own origin.
> **E2.** An Agent **MUST** discard any edge whose target is absent from the same origin's resolved set; a discarded edge is treated as absent.
> **E3.** `cluster` is scoped `(venue.origin, cluster)`. Two Publishers using one string have made no claim about each other, and §4.7's fan-out rule operates within one origin only.

E1 is what turns §3.3's authoring prohibition into a mechanism: without it a Publisher can attest a defamatory claim about a competitor's room inside a 2000-character field served from an origin this specification declares authoritative.

**The agent-facing rule:** an Agent **MUST NOT** present, select, or hold `s′` in place of `s` where `s` declares `policy: strict` and no edge `s ⪯ s′` is attested. Where the customer's intent touches any axis in the candidate set, an Agent **MUST** return the **maximal antichain** — every non-dominated option with its distinguishing axes — rather than a single optimum, and **MUST NOT** rank across a strict boundary by price.

```
maximalAntichain(C, E):
  P ← preorder over C induced by attested edges E     # missing edge ⇒ no permission
  drop s ∈ C where ∃ s' ∈ C with s ≺ s' strictly      # dominated by an attested upgrade
  return remaining, each annotated with its distinguishing axes
```

An `x-` extension class is **incomparable** to every registered class and to every other `x-` class: it establishes domination in neither direction, **MUST** be surfaced as a distinguishing axis, and **MUST NOT** satisfy a `strict` policy — otherwise a Publisher moves real semantics into `x-` ids and the antichain treats a blocking distinction as noise.

**Enforcement at commit.** `hold_seats` carries a REQUIRED `sought: {occasion_id, occasion_etag}` — the Occasion the customer's expressed intent selected, equal to `occasion_id` where the Agent holds what was asked for. Without it `s ⪯ s′` has no `s`, the preorder is reflexive, and every hold is trivially a hold of an acceptable substitute for itself.

> **S1.** Where `sought.occasion_id ≠ occasion_id`, `sought`'s policy is `strict`, and no edge `sought ⪯ occasion_id` is attested, a Server **MUST** refuse `412 substitution_refused {from_occasion_id, crossed_axis}` and **MUST NOT** create the Hold.
> **S2.** A stale `sought.occasion_etag` is refused `412 occasion_moved`.
> **S3.** An edge naming an `occasion_id` absent from the Agent's resolved set is **inert** for `maximalAntichain` and **still enforced** at commit; such a refusal **MUST** name the unseen occasion with `remediation: re_resolve`.
> **S4.** `sought` is Agent-asserted and **unverifiable**. An Agent that misreports it is indistinguishable from an honest one at the moment of the call. Its value is that the misreport is a false statement recorded against a revocable credential — a liability, not an interlock. §10.1 keeps this open.

*One sharp edge, named. Domination can drop a cheaper option: if a Publisher attests that the 35mm substitutes for the DCP, the DCP falls out of the antichain though it costs less. That is the Publisher choosing which of their own screenings they would rather sell, and the remedy is not to attest the edge. The right is exercisable in one direction, by one party, and it is the party whose room it is.*

### 2.4 PROJECTION_0_1 — the closed assertion projection

```
etag = "1:" || base64url_unpadded( SHA-256( JCS( project(occasion, PROJECTION_0_1) ) ) )
```

JCS is RFC 8785; the `1:` prefix is algorithm agility; truncation is **NOT** permitted. The projection is the **closed** list marked ✓ in §2.2, enumerated as JSON Pointers in the schema package. **A member not named there is excluded.** A future version adding a member **MUST** name it in the projection or it is excluded by default, and adding one is a **major** under V2. Arrays project in document order, which is why `offers` must be emitted sorted.

Excluded, and why: every `prose` value **except `work.title.value`**, so a typo fix cannot invalidate an estate's in-flight resolutions. *(Correction, 2026-08-25: this sentence originally read "every `prose` value" and contradicted the ✓ column in §2.2, which projects `work.title.value`. §2.2 is authoritative — the title is the assertion about **which film**, and a silent swap of the work must move the etag. Found by building the golden fixtures; recorded in `docs/2026-08-25-cx-01-spec-first.md`.)* Also excluded: `availability` counts and `observed_at`, which change every few seconds; `revision`, `showtime_ref`, `server_time`, `book_url`; and `instant.feature_at` / `.ends_at`, which are policy arithmetic over an ad reel and a runtime, drifting for reasons that are not assertions about the screening. `hold_policy` is **inside**, because an Agent plans against those numbers. `revision` **MUST** increase strictly monotonically on every publish, and an Agent **MUST NOT** infer an assertion change from it — only `etag` carries that.

The projection catches exactly the failures that matter: a moved start time, a changed price or price basis, a changed format, a changed access provision, a changed hold policy, and a withdrawn or added non-substitutability assertion.

### 2.5 Hold policy — `urn:changeover:schema:hold-policy:0.1`

All members REQUIRED. Per **principal** (§4.7) unless marked *platform*.

| Member | Range / default |
|---|---|
| `policy_max_floor_ms` | 1000 – **300000** |
| `handoff_floor_ms` | ≥ 1000 |
| `clock_guard_ms` | ≥ 0, default 2000 |
| `max_clock_skew_tolerance_ms` | ≥ 0, default 1000 |
| `max_seats_per_hold` | 1–**12** (the wire cap on `seats`), default 6 |
| `max_live_holds_per_showtime` · `max_holds_per_site_per_hour` | default 2 · 6 |
| `max_live_holds_per_cluster` · `max_live_seats_per_showtime` | default 1 · 6 |
| `max_held_seat_fraction_bp` | 1–10000, default 500 |
| `max_held_fraction_per_showtime` *(platform)* | 0–1, default 0.02 |
| `max_live_holds_per_site` *(platform)* | ≥ 1 |
| `revocation_voids_holds` | boolean, default true |
| `abandonment_floor_penalty_bp` | 0–10000, default 0 |

**A Server MUST NOT enforce a limit it has not published here or in the capability document, and C-CAPABILITY asserts the converse: no limit observed at runtime may be absent from the document.** *An undisclosed limit is indistinguishable from a bug to a caller with no eyes, and one incumbent surface documents exactly that failure: exceeding an undocumented held-seat cap "returns an invalid request error without specific details."*

### 2.6 Hold — `urn:changeover:schema:hold:0.1`

```jsonc
{ "required": ["changeover","hold_id","state","occasion_id","occasion_etag",
    "sought_occasion_id","seats","granted_at","floor_ms","floor_deadline",
    "expires_at","extendable","agent_id","server_time"],
  "additionalProperties": false,
  "hold_id":   "^hold_[0-9A-HJKMNP-TV-Z]{32}$",   // ≥160 bits CSPRNG
  "state":     ["live","handed_off","claimed","released","expired","revoked"],
  "occasion_id | sought_occasion_id": "opaqueId",
  "occasion_etag": "^1:[A-Za-z0-9_-]{43}$",
  "seats":     { "array": "1..12, uniqueItems, items string ≤64" },
  "granted_at | floor_deadline | expires_at | server_time": "date-time",
  "floor_ms":  "integer ≥ 1000",  "extendable": false,
  "agent_id":  "^agt_[A-Za-z0-9_-]{1,40}$",       // server-assigned at credential issue
  "cluster":   "string ≤128",  "read_token": "^[A-Za-z0-9_-]{22,}$",
  "revocation_reason": ["session_cancelled","session_moved","seat_withdrawn",
                        "safety","venue_operations","credential_revoked"],
  "handoff":   { "required": ["handed_off_at","handoff_floor_ms",
                              "claim_url","claim_expires_at"] } }
```

**There is no field for a name, email, phone number, loyalty number, payment instrument, or a token standing for any of them — in this object or in any request that produces it.** `intent_digest` is accepted on input and never echoed (**D4**).

> **Z2.** `hold_id` **MUST** carry ≥160 bits from a CSPRNG. **ULID and UUIDv7 are NOT acceptable generators for this field**, because both leak and order by time; the draft's 26-character ULID pattern made a monotonic, guessable handle the identifier for every write verb.

### 2.7 Refusal — `urn:changeover:schema:refusal:0.1`

REQUIRED `{refused: true, code, remediation, reason, server_time}`, OPTIONAL `{retry_after_ms, detail}`, `additionalProperties: false`.

- `code` — the closed enum of §6.3.
- `remediation` — closed enum `re_resolve · re_read · release_conflicting_hold · retry_same_key · retry_after · hand_off_existing · use_book_url · contact_venue · none`.
- `reason` — a **prose envelope**, explicitly non-load-bearing, never an instruction.
- `detail` — a `oneOf` keyed on `code`, every branch `additionalProperties: false`; codes with no detail declare `"detail": false`. Branches: `seat_contended|unknown_seat|seat_unavailable {seat_ids}` · `seat_rule_violated {rule, suggested_seats}` · `occasion_moved {changed_paths}` · `substitution_refused {from_occasion_id, crossed_axis}` · `cluster_fanout {conflicting_hold_id, cluster, limit}` · `hold_budget_exhausted {limit, window_ms}` · `seat_budget_exhausted {limit}` · `hold_expired {expired_at, occasion_id}` · `hold_revoked {revocation_reason, book_url}`.

**An Agent MUST derive its next action from `code` and `remediation` only.** The draft's free-text `suggestion` is deleted: it was an instruction channel to a consumer with no judgement, in a document claiming no decision depends on parsing free text. A refusal **MUST NOT** be mixed with rows; first failure wins; a Server **MUST NOT** return a partially satisfied result, and an unmatched identifier returns `found: false`, never a confident zero.

### 2.8 Three modelling decisions that look small

**`availability.mode: "unknown"` is first-class.** An Agent **MUST NOT** read it as sold out or as available; it **MUST** treat the Occasion as not holdable and **MAY** present it with `book_url`. `staleness_basis: unknown` has the same consequence: a Server reading through a vendor cache with no age header **MUST NOT** invent a staleness number. This is what makes the protocol implementable by the 67% of US theatre locations that are independent and the ~25% running one or two screens (Cinema Alliance, 19 May 2026).

**`local_wall` is load-bearing, and it has a fold.** Any slot or daypart derived downstream **MUST** derive from `local_wall`, never UTC — UTC migrates a site's whole Sunday-morning cohort into Saturday night once a year and nobody notices for a decade. `local_wall` **MUST** render `starts_at` in `venue.timezone`, **MUST** carry `local_wall_offset`, and a Publisher **MUST NOT** emit a `local_wall` that does not exist in that zone. Cinemas run marathons through 2am on the first Sunday in April; without the offset two sessions collide on one natural key and the log drops one.

**Staleness is enforced.** An Agent **MUST NOT** call `hold_seats` where `server_time − observed_at > max_staleness_ms`; a Server **MUST** refuse `409 availability_stale` rather than silently re-observing.

### 2.9 The capability document — `urn:changeover:schema:capability:0.1`

`GET /.well-known/changeover`, `additionalProperties: false`. This is the file the protocol bootstraps from. **REQUIRED:** `changeover` · `supported_versions[]` · `profile` (`0|1|1S`) · `venue` · `authorised_origins[]` · `hold_policy` · `register_version` · `claim_binding` (`session_resume|deep_link|manual`) · `gate_stage` (`hold|handoff|none`) · `handoff_gate_budget_ms` (default 120000) · `hold_basis` (`system_of_record|shadow`) · `floor_basis` (`owned_store|measured_warranty`) · `floor_evidence {observations, window_start, window_end, min_observed_retention_ms, safety_margin_ms, violations}` · `usage_policy {redistribution: forbidden|attributed|allowed, cache_max_age_ms, attribution_text?, terms_url?, contact}` · `max_window_ms` (RECOMMENDED 1209600000) · `max_page_size` (RECOMMENDED 200) · `read_rate_limit_per_hour` · `log_retention_days` (default 90) · `occasions_url` **or** inline `occasions[]` · `generated_at` · `max_document_age_ms`.

### 2.10 The seat map — `urn:changeover:schema:seatmap:0.1`

`hold_seats` requires seat ids, so the read path producing them is normative. Served at `availability.seat_map_ref`: `{observed_at, max_staleness_ms, staleness_basis, seats: [{seat_id, section, row, number, status: available|held|sold|blocked|companion|wheelchair, offer_ids[], adjacency_group}]}`. **Its ids are normatively the ids `hold_seats` accepts.** `seat_map_ref` **MUST** be same-origin under O1 and **MUST** require the same credential as `resolve_occasions`; an unauthenticated seat map is an unbounded enumeration of the house layout.

---

## 3 · The semantics layer

### 3.1 What is machine-derived and what is authored

| Field | Origin | Synthesisable? |
|---|---|---|
| `instant.*`, `availability.*`, `offers[].amount_minor` | the exhibitor's own system | yes, and it should — these are facts |
| `manner.accessibility` | the exhibitor's provision record | yes where recorded; `unknown` otherwise |
| `manner.presentation_classes` | the **class register**, by stable id | no |
| `manner.occasion_classes` | Publisher-authored, budgeted | no |
| `substitution` rules | Publisher-authored | **categorically not** |
| prose | Publisher-authored | plausibly, and worthlessly |

The draft's `run_position` sat in the derived row as *"arithmetic over dates."* **It is not, and the field is deleted.** `opening_weekend` needs a territory release date the session record does not carry; `holdover` is a contract term in a film licence agreement; `rerelease` versus `repertory` is a booking judgement no arithmetic separates; a title that plays, pulls and returns breaks `week_n` outright. These are Publisher assertions, so they live where assertions live — `occ:opening-weekend`, `occ:holdover`, `occ:repertory`, `occ:rerelease` in the register.

### 3.2 The class register

**v0.1 ships a seed register of approximately thirty ids** — carrier, resolution and aspect, sound, seating, caption and audio description, and occasion — versioned `2026.1`, append-only, extended by `x-` prefix under V4. Thirty ids describes the entire New Zealand exhibition estate and is a weekend's work; the draft's "several hundred" is a standards-body deliverable and was a REQUIRED field with no producer.

The register is the hand-authored vocabulary saying **which differences are differences**. `pres:70mm-5perf` is not satisfied by `pres:dcp-2k-scope`; `pres:open-caption` is never satisfied by *"subtitles on request"*; `occ:director-qa` is not the 9:40 of the same film. Facts are free — showtimes, seat maps, TMDB, Wikidata, `schema.org/ScreeningEvent`. Nothing anywhere records that two rows in a listings feed are not the same object.

### 3.3 Origin authority, delegation, and who must check

`not_substitutable_for` is not a description of the world that could be true independently of who says it. It is the exhibitor exercising a right — a speech act, the way a signature is. A model can generate a fluent, well-formed assertion that the 35mm is not substitutable for the DCP. What it cannot generate is *the exhibitor having asserted it*. The draft assigned the origin check to the Server, which is the party serving the document — a tautology constraining nobody. It belongs to the consumer.

> **O1.** Every absolute URL emitted in any CHANGEOVER document — `book_url`, `seat_map_ref`, `claim_url` — **MUST** be same-origin with `venue.origin` or with an origin in that venue's delegation record, compared as the parsed `(scheme, host, port)` triple, ASCII-lowercased, default ports normalised. A URL containing userinfo is invalid regardless of host.
> **O2.** An Agent **MUST** re-derive each origin from the **parsed** URL — never a string prefix — and **MUST** refuse to present, navigate to, or pass to any other tool a URL failing O1. An Agent **MUST** reject any Occasion whose `venue.origin` is neither the serving origin nor a delegated one, and **MUST NOT** follow a cross-origin redirect when retrieving `/.well-known/changeover`, `/changeover/v0/occasions`, or any URL in an Occasion: a cross-origin redirect is a refusal, not a hop.
> **O3.** A Server **MUST** reject at publish (`400 schema_validation`) any Occasion violating O1.

**Delegation.** Real circuits split marketing and ticketing across origins: the brochure site at the apex where `/.well-known/` must live, ticketing at a vendor host where the hold endpoint must live. `https://{venue.origin}/.well-known/changeover/delegation.json` lists origins permitted to serve on the venue's behalf, with a `max_age`. **Delegation is asserted by the venue at the venue's own apex, so no party can add itself and the anti-aggregation property survives.** A rule written to exclude aggregators that instead excludes the exhibitor's own infrastructure is a rule nobody deploys.

The draft's alternative — *"or signed by a key published at `{origin}/.well-known/changeover/keys.json`"* — is **deleted from v0.1**: it named no key format, algorithm, envelope, rotation, revocation, or canonicalisation, and a half-specified signature scheme is worse than none, because it will be implemented. §7 likewise now says *dated* rather than *signed*.

### 3.4 The occasion-inflation failure mode

If every screening is an occasion, `occasion_classes` is noise. This specification does not police that and **MUST NOT** be read as validating any claim's truth. It makes over-claim *visible*: scarce classes (`occ:premiere`, `occ:final-run`, `occ:archival-print`, `occ:presenter-present`, `occ:format-singular`) carry a per-auditorium per-quarter budget in the conformance rules, and because the feed is self-published and append-only, any third party can diff a Publisher's history and compute their over-claim rate. Reputation, not permission. Expiry is absence, not falsity: past a claim's window the field is **absent** with `expired_at` reported, never present-and-false.

---

## 4 · The operations

### 4.1 The verbs, and the one that is missing

```
resolve_occasions   read   → occasions, the preorder over them, and a cursor
hold_seats          write  → a server-minted, single-consumption handle
get_hold            read   → REQUIRED before hand_off; returns a read_token
release_hold        write  → MANDATORY, total, idempotent
hand_off            write  → a one-time claim URL on a venue-authorised origin

// Deliberately absent: settle, pay, capture, confirm_payment, refund, price, upsell.
// Not disabled. Not permission-checked. Absent.
```

### 4.2 Call sequence

```
GET /.well-known/changeover → profile, hold_policy, claim_binding, gate_stage, floor_basis
resolve_occasions(site_id, window_start, window_end, cursor?, page_size?)
   → [Occasion × n] + antichain + next_cursor
   ↓ agent computes maximalAntichain, presents, human chooses
  (gate_stage="hold" → InputRequiredResult HERE, before any seat is locked)
hold_seats(occasion_id, occasion_etag, sought{…}, seats[] | selection{best_available},
           requested_floor_ms, Idempotency-Key, intent_digest?)
   → 201 Hold{live, floor_ms, floor_deadline, expires_at} | a typed refusal in G1 order
get_hold(hold_id) → Hold{expires_at possibly moved; floor_deadline never; read_token}
hand_off(hold_id, read_token, Idempotency-Key)
   → 200 Hold{handed_off, claim_url, claim_expires_at}
   ↓ the customer's browser, on the exhibitor's own domain, seats still warm
```

There is nothing after that arrow inside this specification. The agent's transcript ends with it unable to continue, because there is no verb.

### 4.3 TTL semantics — two cue marks, and who owns the house

The incumbent problem is not that seat holds are short. It is that `expiresAt` extends on any mutating call, moves under you from a concurrent session, and is enforced by a sweeper that lags minutes. It is a *hint*, and an autonomous consumer cannot plan against a hint.

| | `floor_ms` → `floor_deadline` | `expires_at` |
|---|---|---|
| Set by | Server, at grant | Server, any time |
| Agent may request | yes, as `requested_floor_ms` | no |
| Server returns | `min(requested, policy_max)`, **MAY** return less | ≥ `floor_deadline`, always |
| After grant | **immovable** | movable **upward only**, reported on every read |
| An Agent may plan against it | **yes — this and nothing else** | **no** |

> **T1.** A Server **MUST NOT** release, revoke, reap or reassign any seat in a Hold before `floor_deadline = granted_at + floor_ms`, **except under an Operator Override**.
> **T1a.** An **Operator Override** is a human-initiated action at the exhibitor's own console, or the voiding of Holds minted by a revoked credential where `revocation_voids_holds: true` is published. The Server **MUST** transition the Hold to `revoked`, **MUST** record `revocation_reason` from the closed enum, **MUST** refuse later agent verbs `409 hold_revoked` carrying `detail.book_url`, and **MUST** count it in the report's `operator_overrides`, reported **separately** from `floor_violations` and **not** failing C-FLOOR. An Override **MUST NOT** be used for ordinary contention or reallocation; a rate above the published threshold fails C-FLOOR. No other mechanism may shorten a floor.
> **T2.** `expires_at ≥ floor_deadline` at grant and for the life of the Hold.
> **T3.** A Server **MUST NOT** increase `floor_ms` or move `floor_deadline` after grant by any mechanism. There is no `extend` verb and a Server **MUST NOT** provide one.
> **T4.** An Agent **MUST NOT** treat `expires_at` as a guarantee, **MUST** call `get_hold` before `hand_off`, and **MUST** compute remaining time from `server_time`. The re-read has a mechanism rather than a request: `get_hold` returns an opaque `read_token` bound to `(hold_id, that read's server_time)`, valid for a published window; `hand_off` **REQUIRES** it and refuses `409 stale_read` otherwise. *A thing an agent must not do should not merely be asked.*
> **T5.** `live → handed_off` **MUST** occur at most once per Hold and **MUST** set `claim_expires_at = min(handed_off_at + handoff_floor_ms, instant.sales_cutoff_at)`, where `handed_off_at` is the Server's transaction time. **No other base is permitted.** It is the only event that may extend a seat's held-until, and it **MUST** do so.
> **T6.** `held_until` is a Server-internal projection of the seat's effective deadline. A Server **MUST** maintain `held_until = expires_at` while `live` and `= claim_expires_at` while `handed_off`, **MUST** maintain `claim_expires_at ≥ expires_at ≥ floor_deadline` for the life of the Hold, and **MUST** set it in the same transaction as the state transition.
> **T7.** `expires_at` **MUST NOT** be reduced below a previously reported value.

*T5–T7 exist because "may extend" and an undefined `held_until` let a conforming server reap at `expires_at` and strand a customer twenty seconds inside the window its own claim page promised. T1a exists because the draft's T1 told a duty manager they may not sell their own seats: a KDM fails and the 19:00 is cancelled, a wheelchair party needs row F, a customer stands at the box office with cash. A protocol that forbids the operator to manage their own house fails the compass in the first operations meeting — and is unenforceable anyway, because the POS writes to the CMS and knows nothing about CHANGEOVER.*

Precedent, and the inversion. Google's Maps Booking `Lease` gets the geometry right — the merchant may shorten it, and `CreateBooking` *"consumes the lease and renders it invalid for any further bookings"* — and the power wrong, because it exists so Google's surface can hold a merchant's slot. IATA NDC's Payment Time Limit is the same primitive again. CHANGEOVER copies the mechanism and inverts the ownership.

### 4.4 Clock

> **K1.** An Agent **MUST** compute `remaining_ms` as `floor_deadline − (server_time_at_last_read + monotonic_elapsed_since_that_read)`, never from `Date.now()`.
> **K2.** An Agent **MUST** treat a Hold as unusable from `floor_deadline − (clock_guard_ms + max_clock_skew_tolerance_ms)`. This is the only consumer of the second field, which the draft required and nothing read.
> **K3.** A Server **MUST NOT** reject a request on the basis of client clock state; no request body carries a client timestamp, so there is none to reject.
> **K4.** A Server **MUST** derive `granted_at`, `floor_deadline`, `expires_at`, `claim_expires_at`, every `server_time` and the reap's evaluation instant from **one** time source, and **MUST NOT** compare a timestamp minted on one node against a clock on another. An API node whose clock leads the database by 400ms violates T1 by construction, silently.
> **K5.** An Agent **MUST** subtract its measured round-trip time from `remaining_ms`, or subtract `clock_guard_ms` a second time where it cannot measure one. `server_time` is stamped at response generation and the Agent's monotonic clock starts on arrival, so without K5 every K1 computation over-estimates in the unsafe direction.
> **K6.** `server_time` **MUST** be non-decreasing across successive responses concerning one `hold_id`.

### 4.5 Idempotency

No public exhibitor surface examined publishes an idempotency convention, so the boundary supplies one.

> **I1.** `Idempotency-Key` is **REQUIRED** on `hold_seats` and `hand_off`, **RECOMMENDED** on `release_hold`, and **MUST** carry ≥128 bits from a CSPRNG. ULID and UUIDv7 are permitted forms, but their time prefix is not entropy; an implementation **MUST NOT** derive a key from an order reference, a conversation id, or any predictable value.
> **I2.** Scope is `(agent_id, principal_scope, verb, key)`, all credential-derived, never read from a body.
> **I3.** `request_digest = SHA-256(JCS(D))` where `D` is the request's **decision members only** — `hold_seats`: `{occasion_id, occasion_etag, sought, seats sorted, selection, requested_floor_ms}`; `hand_off`: `{hold_id}`. Gate responses, `intent_digest`, `read_token` and transport metadata including the key itself are **excluded**. In MCP, `D` is projected from the tool-arguments object by the same rule, so **a call is digest-identical across bindings**.
> **I4.** Same key + same digest **MUST** replay the stored response with `Idempotency-Replayed: true`, identical in every member **except** `server_time`, `state`, `expires_at` and `claim_expires_at`, which **MUST** be re-projected from current state at replay. `hold_id`, `seats`, `granted_at`, `floor_ms` and `floor_deadline` **MUST** be byte-identical, and the HTTP binding **MUST** carry a current `Changeover-Server-Time`.
> **I4a.** An Agent **MUST** anchor K1 on the response's own `server_time`, **MUST NOT** treat a replayed state as current if older than it, and **MUST NOT** attempt hand-off where a replay returns `state ≠ live`.
> **I5.** Same key + different digest **MUST** return `422 idempotency_key_reused` with **no action taken**.
> **I6.** A request arriving while an identical key is in flight **MUST** return `409 idempotency_in_flight` with `retry_after_ms`. **An Agent MUST retry the same key; re-resolving on this code is an Agent conformance failure** — it is how a retry becomes a double-book.
> **I7.** An `InputRequiredResult` is **not an operation**. A Server **MUST NOT** record an idempotency entry for a call returning `input_required`, and **MUST** accept the same key on the gate-satisfying retry.
> **I8.** Idempotency is evaluated **before** state guards. A key-and-digest match replays under I4 regardless of current state; the freshly-projected `state` is what tells the Agent the result is stale. A Server **MUST NOT** return a state-guard refusal for a request matching a stored entry.
> **I9.** For `hand_off` the retention window is `min(24 hours, claim_expires_at)`. After that, or once the claim is consumed, a replay **MUST** return current state with `claim_url` **absent** and `handoff_consumed` in `detail` — the one permitted departure from I4. A stored response **MUST** be returned only to the `(agent_id, principal_scope)` that stored it.

*I3 and I7 exist because digesting the whole body made the human gate's retry a different request, which I5 refuses with no action taken — the draft's own worked example returned `422`. I4 exists because byte-identical replay of a time-bearing object is a lie with a 24-hour shelf life: a body asserting `state: live` over a floor 40 seconds past makes an agent obeying K1 exactly compute 180 seconds of runway when it has 140.*

### 4.6 Contention, oversell, locking and isolation

**All or nothing.** A `hold_seats` naming any contended, unknown, or unavailable seat **MUST** fail atomically and wholly. There are no partial holds, and no row is written for an unvalidated seat.

> **W1.** A Server **MUST** validate every `seat_id` against the auditorium's own seat inventory **inside** the hold transaction and refuse `400 unknown_seat {seat_ids}` where any is unknown. Unvalidated ids otherwise become permanent rows nothing will reap, and let an attacker pre-claim ids that do not exist yet.
> **W2.** `seats` **MUST** be `uniqueItems`; a duplicate-bearing array is refused `400 schema_validation` **before any lock is taken**. Otherwise `["F:11","F:11"]` trips the primary key, is reported as `seat_contended`, and the Agent loops forever re-resolving a free seat.
> **W3.** A Server **MUST** verify availability **against the exhibitor's system of record** inside the hold transaction. A Server whose hold path consults only its own `hold_seat` table does not conform. A seat unavailable for a reason other than a CHANGEOVER Hold — sold, blocked, house seat, accessibility hold — is `409 seat_unavailable {seat_ids}`.
> **W4.** An Agent **MUST NOT** supply a `seat_id` it did not obtain from that Server for that Occasion in the current resolution. Where it cannot reason over a seat map — the commonest request is *"two together, not the front row"* — it **MUST** use `selection: {mode: "best_available", quantity, together, offer_id}` and the Server chooses. **This is not the rejected fungible-quantity model**: that rejection is of quantity at the *Occasion* level, and seat choice within one named Occasion is the exhibitor's own allocation logic, which is where the compass wants it. Under `best_available` a Server **MUST NOT** return seats spanning a violation; an explicit `seats[]` that does is `409 seat_rule_violated {rule ∈ {orphan_seat, gap_policy, companion_pairing, accessibility_reserved, zone_mismatch}, suggested_seats[]}`.

**Oversell is made unrepresentable rather than prevented** — inside the store this specification defines. The invariant: **no two Holds in a seat-occupying state may cover the same `(showtime_id, seat_id)`; the seat-occupying states are `live`, `handed_off` and `claimed`.** `claimed` is terminal and occupies its seat for the life of the screening, and a Server **MUST NOT** reap a `claimed` row. The draft's index excluded `claimed`, so a sold seat left the uniqueness predicate the instant the order was written and was immediately re-holdable with a `201 Created`.

```sql
CREATE UNIQUE INDEX hold_seat_occupied ON hold_seat (showtime_id, seat_id)
  WHERE state IN ('live','handed_off','claimed');   -- 'claimed' deliberately included
CREATE UNIQUE INDEX hold_cluster_live ON hold (agent_id, principal_scope, origin, cluster)
  WHERE state IN ('live','handed_off');
CREATE TABLE hold_slot (agent_id text, principal_scope text, showtime_id text, slot int,
  PRIMARY KEY (agent_id, principal_scope, showtime_id, slot));  -- slot ∈ [0, max)
```

> **L1.** Before any reap or insert a Server **MUST** acquire an exclusive lock per `(showtime_id, seat_id)` in ascending byte order of `seat_id` under the **C** collation, over the **full requested seat set**, irrespective of whether a hold row exists for that seat, in the same transaction as the insert.
> **L2.** The reap and insert **MUST** execute under those locks and **MUST NOT** acquire seat locks of their own.
> **N1.** Every write verb **MUST** execute in a single database transaction, and a Server **MUST** either run at **SERIALIZABLE** with transparent `40001` retry to a published bound, or enforce every aggregate guard (X1, X2, X4) with a constraint or lock a concurrent transaction cannot bypass. **Aggregate guards evaluated by an unlocked `SELECT` under a snapshot isolation level do not conform.**

```sql
-- L1, before anything else in the transaction:
SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || s, 0))
  FROM unnest($2::text[]) AS s ORDER BY s COLLATE "C";
-- reap by HOLD, never by seat: a Hold is never partially expired
WITH doomed AS (SELECT DISTINCT hold_id FROM hold_seat
                 WHERE showtime_id=$1 AND seat_id = ANY($2) AND held_until <= now()
                   AND state IN ('live','handed_off'))
DELETE FROM hold_seat h USING doomed d WHERE h.hold_id = d.hold_id;
```

*Ordering the seats a transaction locks is not enough: the reap can only lock rows that exist and are doomed at its own start, and a free seat has no row, so two transactions over one seat set compute different lock sequences and deadlock across an expiry boundary while obeying the rule exactly. And at READ COMMITTED two `hold_seats` three milliseconds apart both count zero live holds in a cluster, both pass, both commit — so X2 failed to two concurrent requests.*

A reap triggered by contention on any seat of a Hold **MUST** reap **every** seat of that Hold. `now()` — transaction-start — is correct for the **reap**, which then cannot reap a seat that was live when the transaction began, and **wrong for the grant**: `granted_at` **MUST** be `clock_timestamp()` at the instant the insert succeeds, with `floor_deadline` and `held_until` derived from it. A transaction spending 600ms in lock waits otherwise mints a floor already 600ms in the past — a deficit falling entirely on the Agent's side, where C-FLOOR can never see it.

`23505` **MUST** be mapped **by constraint name**: `hold_seat_occupied → 409 seat_contended` · `hold_cluster_live → 429 cluster_fanout` · `hold_slot → 429 hold_budget_exhausted`. **Any other `23505` MUST NOT be reported as `seat_contended`.**

**Derived state.** The reap deletes seat rows; it does not transition the Hold, so a stored `state` column is a lie the moment a reap runs elsewhere.

> **M1.** `state` is **derived at every read**: `revoked` if an override is recorded; `released` if a release is; `claimed` if a claim is; `handed_off` if handed off and `server_time < claim_expires_at`; `live` if `server_time < expires_at`; else `expired`. **A Server MUST NOT report `live` for a Hold whose `expires_at` has passed, regardless of whether any reap has run.**
> **M2.** A Hold **MUST** report the seat identifiers **as granted** for the life of the record, in every state. `seats` is the grant, not current occupancy — otherwise `minItems: 1` has no legal value after a reap.
> **M3.** Every budget and cluster predicate **MUST** be evaluated against derived state. A `count(*) WHERE state='live'` over a stored column counts expired holds forever and locks an Agent out of a showtime after two abandoned holds.

### 4.7 Exhaustion safety, and the principal problem

A hold API that ships without exhaustion limits ships a weapon — and the draft's limits were scoped to `agent_id`, which is an entire agent platform serving millions. Six holds an hour across a whole site for a platform's global customer base is unusable, and one live hold per cluster means that while one Wellington household holds the Friday 35mm, every other customer of that platform anywhere is refused the same film that week.

> **X0.** A credential **MUST** carry `principal_scope`: an opaque, platform-minted, pairwise-pseudonymous subject id (OIDC PPID shape), scoped to `(agent_platform, site)` and rotated per customer session. It is credential-derived, never a request field, so I2 holds and D1 stands. Absence is `403 principal_scope_missing`.
> **X1.** `max_live_holds_per_showtime`, `max_holds_per_site_per_hour`, `max_live_holds_per_cluster` and `max_live_seats_per_showtime` are **per `(agent_id, principal_scope)`** and **MUST** be enforced inside the insert transaction, by constraint or lock (N1).
> **X2.** A Server **MUST** refuse `429 cluster_fanout` on a second live Hold in one `(origin, cluster)` for one principal. **Two purchases in one cluster by one household are legitimate and are not fan-out** — Friday night for the couple and the Sunday matinee for the grandparents is a normal transaction.
> **X3.** Platform-wide ceilings `max_held_fraction_per_showtime` and `max_live_holds_per_site` are per `agent_id`, enforced in the same transaction and published.
> **X4.** A Server **MUST** refuse `429 seat_budget_exhausted` where the grant would take a principal's live held seats on one `showtime_id` above `min(max_live_seats_per_showtime, max_held_seat_fraction_bp × auditorium.capacity / 10000)`. *On the draft's defaults — six holds × twelve seats × fifteen minutes, the Server forbidden to reclaim — one credential that never released took 36% of a 200-seat premiere, and twenty-four immovable seats on an archival 35mm print is the sell-out.*
> **X5.** A Server **MAY** reduce granted `floor_ms` by up to `abandonment_floor_penalty_bp` for a principal whose expired-without-hand-off rate exceeds the published threshold. This is visible: granted `floor_ms` is already returned and the policy is already published.
> **X6.** A Server **MUST** return an `InputRequiredResult` at the stage named by `gate_stage` unless the credential carries an exhibitor-issued `attended: true` grant; **absence means false**. `gate_stage: "hold"` is **RECOMMENDED**: *"Hold two seats at the Embassy?"* is the decision a human wants to make and it spends human latency **before** a seat is locked, where *"hand off the hold you already made?"* is a dialog nobody understands. Where `gate_stage: "handoff"`, a Server **MUST** publish `handoff_gate_budget_ms` (default 120000) and **MUST NOT** set `policy_max_floor_ms` below `handoff_gate_budget_ms + clock_guard_ms + 30000` — a human who has gone to ask their partner about Saturday takes longer than 180 seconds.
> **X6a.** `inputRequests[].prompt` **MUST** travel in a prose envelope, **MUST NOT** contain a URI, and **MUST** be accompanied by structured members — `seat_count`, `venue_name`, `local_wall`, `presentation_classes`, `amount_minor`, `currency` — so a conforming Agent renders from the structure and the free text is a caption, not the contract.
> **X6b.** Stated plainly: **the Agent renders the gate.** A gate proves the Server demanded a human decision; it does not prove a human made one. It is a speed bump against unattended fan-out, not consent. The draft's `principal_present` was a static credential claim about a dynamic fact; `attended` is no more verifiable, and X6b is what carries the weight, not the grant.

*X2 remains the design's tightest coupling: anti-exhaustion is enforceable here **because** substitutability is machine-checkable. The same merchant-authored structure pays rent twice — as customer protection against price-routing, and as defence against speculative fan-out across interchangeable inventory.*

### 4.8 Hand-off, release, disappearance

> **HO1.** A Server **MUST** accept `hand_off` on any live Hold whose seats it still holds, **including after `floor_deadline`** — the guard is `server_time < expires_at` and `< sales_cutoff_at`. Where the seats are already reclaimed the refusal is `409 hold_expired {expired_at, occasion_id}`, retryable after re-resolve — never `hold_not_live`, which means *wrong verb* and is non-retryable. The draft refused hand-off on a Hold whose seats were demonstrably still held, with a code that lied, for up to three and a half minutes, and raced K2 exactly.
> **HO2.** `clock_guard_ms` binds the **Agent's planning**, not the Server's acceptance. A Server **MUST NOT** refuse a verb on the basis of `clock_guard_ms`.
> **R1.** `release_hold` on a `handed_off` Hold **MUST** be refused `409 handoff_consumed`. **Hand-off is agent-terminal: once a claim URL is minted, the Hold's disposition belongs to the customer and the exhibitor. No Agent verb can shorten the seats' life. The Hold ends at `claim_expires_at` or at the claim, and both are the Server's.** The draft's guard-free `handed_off → released` row was a remote kill switch on a customer mid-checkout, and is exactly what an injected instruction asks for.
> **R2.** Otherwise `release_hold` is **total**: `204` for every Hold the credential may address, in `live`, `released`, `expired`, `claimed` or `revoked`, and it **MUST NOT** refuse. A cleanup path treating non-2xx as an error otherwise logs false alarms at a rate proportional to abandonment, which is the common case.
> **R3.** The claim transaction **MUST** take an exclusive lock on the Hold and re-read its state inside that transaction; a claim against a Hold not in `handed_off` **MUST** fail.

**Client disappearance.** No release arrives — `SIGKILL`, a crash, a partition, a model that gave up. Seats remain held until `expires_at`, never earlier than `floor_deadline`, and are reclaimed by the **next contending transaction**, not a background process; derived state (M1) means the budgets return with them. A sweeper **MAY** exist as an optimisation; **correctness MUST NOT rest on it.** This is the direct, testable answer to *"may take a few minutes."*

### 4.9 The state machine

> **Z1.** For every verb addressing a `hold_id`, a Server **MUST** verify the Hold's `(agent_id, principal_scope)` equals the credential's, and on mismatch **MUST** return `404 hold_not_found` — **never `403`**, so the surface is not an existence oracle. Object-level authorisation was absent from the draft: its only 403 was verb-level, so a second agent at the same site could release a first agent's seats and take them.
> **G1.** A Server **MUST** evaluate `hold_seats` guards in exactly this order, returning the first failure and mutating no store state before the first six pass: `(1) profile_not_supported · (2) schema_validation (incl. W2) · (3) occasion_not_found · (4) occasion_moved · (5) availability_unknown / availability_stale · (6) past_sales_cutoff · (7) substitution_refused · (8) cluster_fanout · (9) hold_budget_exhausted / seat_budget_exhausted · (10) unknown_seat · (11) seat_unavailable / seat_rule_violated · (12) seat_contended` — last, because it alone requires locks.
> **G2.** Where `availability.mode` changed between the supplied etag and current state, the refusal is `occasion_moved`, not `availability_unknown`; the latter is returned only when the etag matches. The same fact **MUST NOT** yield a retryable code from one server and a non-retryable one from another.

*Guard order is part of the wire contract because every code carries different retry semantics: with a moved start time **and** lost seats, one server costs the agent two round trips and a stale presentation and another costs one, and both conformed. The draft's implied order also took locks and reaped rows before checking the etag — mutating the store for a request it then refuses.*

| Current | Event | Guard | Next | Refusal |
|---|---|---|---|---|
| *(none)* | `hold_seats` | G1, in order | `live` | per G1 |
| *(none)* | `hold_seats` replay | I8: key + digest | *(unchanged)* | `idempotency_key_reused` · `idempotency_in_flight` |
| `live` | `get_hold` | Z1 | `live` | `hold_not_found` |
| `live` | `release_hold` | Z1 | `released` | `hold_not_found` |
| `live` | `hand_off` | Z1; `< expires_at`; `< sales_cutoff_at`; fresh `read_token`; gate satisfied | `handed_off` | `hold_expired` · `past_sales_cutoff` · `stale_read` |
| `live` | `deadline_passes` | `server_time ≥ expires_at` | `expired` | — |
| `live` | `contended_reap` | `held_until ≤ now` at another writer's insert | `expired` | — |
| `live` / `handed_off` | `operator_override` | T1a | `revoked` | — |
| `handed_off` | `get_hold` | Z1 | `handed_off` | — |
| `handed_off` | `hand_off` | Z1 | *(no change)* | `handoff_consumed` |
| `handed_off` | `release_hold` | Z1 | *(no change)* | `handoff_consumed` (R1) |
| `handed_off` | `claim confirm` (§4.10) | CL2, R3 | `claimed` | `claim_consumed` · `claim_expired` |
| `handed_off` | `deadline_passes` | `now ≥ claim_expires_at` | `expired` | — |
| `claimed` | any agent verb **except** `release_hold` | — | *(no change)* | `hold_not_live` |
| `released`/`expired`/`claimed`/`revoked` | `release_hold` | Z1 | *(no change)* | — *(204, R2)* |
| `released` / `expired` | `hand_off` | — | *(no change)* | `hold_not_live` |
| `revoked` | any agent verb | — | *(no change)* | `hold_revoked` |

`claimed` and `revoked` are terminal. **The Server never learns whether the order completed**, because there is no verb that would tell it. The instrument's grain is formed intent, not conversion — a deliberate limit, and §10 says what it costs.

### 4.10 The claim

The draft put the terminus of the whole protocol in a parenthesis. The claim is where the person enters, so it is normative here.

> **CL1.** `claim_url` **MUST** be same-origin under O1. Its token **MUST** carry ≥128 bits from a CSPRNG, **MUST NOT** derive from `hold_id`, and **MUST NOT** be sequential or timestamp-ordered.
> **CL2.** `GET {claim_url}` **MUST** be **prefetch-safe**: it **MUST NOT** transition `handed_off → claimed` and **MUST NOT** consume the token. Consumption requires a **non-idempotent confirm**, and the first confirm binds the claim to that requester (first-touch session or equivalent); every later presentation from an unbound requester **MUST** fail `409 claim_consumed`. *A messaging app's link scanner fetches that URL before the human clicks it; consuming on GET burns the customer's seats on their behalf.*
> **CL3.** The claim endpoint **MUST NOT** accept any parameter that alters the Hold, and **MUST** render a typed outcome for an expired or consumed claim naming the Occasion and linking `book_url` — `410 claim_expired`, `409 claim_consumed`. Landing on an empty cart with no explanation is the exact failure this specification exists to prevent.
> **CL4.** `claim_expires_at = min(handed_off_at + handoff_floor_ms, sales_cutoff_at)` (T5).
> **CL5.** An Agent **MUST** treat `claim_url` as a credential: **MUST NOT** fetch it, **MUST NOT** log it, **MUST NOT** emit it anywhere but the surface delivering it to the customer who formed the intent. The Server logs the *fact* of hand-off and **MUST NOT** log the token. The exhibitor **MUST NOT** persist the token in the order record beyond `claim_expires_at`.

**`claim_binding` is REQUIRED in the capability document**, because no major CMS front end publishes a documented way to inject an externally-minted hold into a browser session and this is the hardest integration in the design:

- **`session_resume`** — `GET {claim_url}` sets the exhibitor's own session to a cart of exactly the held seats. Best, and the most work.
- **`deep_link`** — `claim_url` carries `showtime_id`, `seat_ids[]` and a signed claim token and lands on the existing seat-select page with those seats pre-selected. **This is what most exhibitors can ship in a fortnight and is a first-class conformance target.**
- **`manual`** — `claim_url` is `book_url` and the hold expires unclaimed. An honest on-ramp that admits the walk is not yet survivable at that site rather than pretending it is.

**Residual, stated:** CHANGEOVER cannot bind a Hold to a person and does not try. The exhibitor's first-touch binding at CL2 is the only place a person enters. The property that makes the design privacy-preserving is the same property that makes wrong-party delivery undetectable: if an Agent hands customer A's claim URL to customer B, no signal in this protocol can see it.

---

## 5 · The safety model

### 5.1 Four locks, structural not behavioural

`cinema-ops-platform` proves absence-not-redaction on a **read** path and leaves an open question in its own documentation: does the triple lock generalise to a **write** path? It does, with a fourth lock the write path requires, because a write path takes values *in* and the draft's locks were asserted over member *names*.

| Lock | Requirement | Falsified by |
|---|---|---|
| **1 · Surface** | No settlement, payment, refund, capture or pricing verb exists. | `tools/list` or any HTTP path matching `settle\|pay\|capture\|refund\|charge\|price`. |
| **2 · Type** | `schemas/member-manifest.json` is an **allowlist** of every leaf member name across all agent-facing schemas; C-ABSENCE.2 asserts **set equality**. | Any schema member absent from the manifest — fails CI, requiring a human to add the name in the same commit. |
| **3 · Grant** | The agent role holds no `INSERT` on payment tables, no `SELECT` on customer tables. | A live `SET LOCAL ROLE` kill test that does not raise `insufficient_privilege`. |
| **4 · Value** | At publish and at log-write, no field value matches an email, an E.164 string, a Luhn-valid 13–19 digit run, or a national-id pattern. Fail **closed**; do not filter. | Any match. |

Lock 2 was a **denylist of nine English words** in the draft — the epistemology of the injection filters §5.3 correctly refuses, defeated by `patron_ref`, `booker` or `contact_handle`, and colliding with `venue.name` on the first run. An allowlist is falsifiable and undefeatable by synonym.

### 5.2 The threat model

An agent is a consumer with no judgement, and every free-text field here is an **attacker-controlled surface**: `work.synopsis` (distributor or metadata supplier — supply-chain text nobody at the cinema wrote); `manner.note.body` and `auditorium.why_this_room` (a compromised CMS account, or a well-meaning marketer); `work.title` (a title *is* attacker-chosen text); `refusal.reason` and any upstream vendor error string (the vendor, or whoever poisoned it); `offers[].eligibility_note`; and `inputRequests[].prompt` (a compromised Server phishing the customer through the Agent's trusted UI).

### 5.3 How the specification neutralises it

**This specification does not attempt to detect injection, and a conforming Server MUST NOT claim to.** Detection is unfalsifiable and every filter is one paraphrase from defeat. The design makes prose non-load-bearing instead.

1. **Absence.** The verb the injection asks for does not exist. A compromised agent that fully complies **cannot settle through this surface** — and the claim is scoped exactly that far, because the same agent has a browser tool and increasingly a payments tool. Absence here is not absence everywhere; the draft's unscoped version of this sentence was false.
2. **Closed vocabulary.** No decision this specification asks an **Agent** to make depends on parsing free text: substitutability is edges over ids, availability a three-value enum, deadlines integers, refusals `code` + `remediation`, formats registered ids. The one place agent-supplied text reaches **Server** logic is `work_hint`, governed by P1.
3. **Quarantine.** Free text travels in a `prose` envelope, capped, with C0 controls other than `\n` stripped and consecutive newlines collapsed at publish.
   > **PR1.** An Agent **MUST NOT** treat any prose value as instruction, and **MUST NOT** navigate to, fetch, or pass to any other tool any URL, identifier or command inside one.
   > **PR2.** A `prose.value` **MUST NOT** contain a navigable link: a Server **MUST** reject at publish any value containing `://`, a `mailto:` / `tel:` / `data:` / `javascript:` scheme, or a bare host matching a public-suffix pattern. *(A reviewer proposed rejecting any `[a-z][a-z0-9+.-]*:` at a word boundary — which also rejects a programme note beginning "note:". The check is a scheme allowlist, not a generic colon pattern.)*
   > **PR3.** A Server **MUST NOT** pass upstream vendor text into `reason`, `detail`, `remediation` or any prose field without re-typing it to a CHANGEOVER code.
   > **Q1.** Total `prose.value` bytes **MUST NOT** exceed 8000 per Occasion or 200000 per response; a Server **MUST** refuse to publish beyond the first and **MUST** page rather than exceed the second; an Agent **MUST** discard a response exceeding the second. Quarantining prose does not help when there is enough of it to displace a system prompt.
4. **Prose is outside the etag; assertions are inside it.** An Agent that paraphrased away a non-substitutability claim still presents an etag over the assertions, and a hold whose `sought` crosses a strict boundary is refused at commit. Paraphrase is caught by the mechanism, not by the model's good behaviour.

### 5.4 The access log, and what an agent writes into it

Every invocation — ok, refused, error — **MUST** write one row to an append-only log carrying `agent_id`, `principal_scope`, verb, outcome, refusal code, and the `(local_wall, local_wall_offset)`-derived slot. A `CHECK` **MUST** force a reason on refusals. Refusals are logged deliberately: *a log with only successes cannot show someone probing the boundary, which is the thing you most want to see.*

The draft then required that log to store the request parameters and denied `DELETE` by grant, while `work_hint` was 200 characters of unconstrained agent free text. That is not an adversarial scenario; it is the default behaviour of a competent agent, whose user said *"The Conversation, 35mm, wheelchair space for my mother Ruth, sarah.chen@gmail.com has the booking."*

> **P1.** `work_hint` is `maxLength 120`, `^[\p{L}\p{N} .,:'&!?()\-]+$`. A Server **MUST** refuse `400 hint_rejected` where it contains `@`, seven or more consecutive digits, or a URI scheme, and **MUST NOT** silently strip. An OPTIONAL `work_ref {eidr|isan|work_id}` is preferred. A Server **MUST** treat `work_hint` as data: **MUST NOT** interpolate it into any query, log line, prompt or prose field, and **MUST NOT** let it affect any member of a returned Occasion.
> **P2.** The log **MUST** store `work_hint`, `intent_digest` and `Idempotency-Key` only as `HMAC-SHA256(site_epoch_key, value)`; raw values **MUST NOT** be persisted; `site_epoch_key` **MUST** rotate on a published interval (RECOMMENDED 90 days) and the retired key **MUST** be destroyed. **Crypto-shredding is how an append-only store honours erasure without a `DELETE`.**
> **P3.** The measurement grain **MUST** be derivable without any P2 field. A metric that needs the raw value does not ship.
> **A1.** The log **MUST** sit on storage independent of the hold store; exhaustion of one **MUST NOT** deny writes to the other.
> **A2.** Fail-closed applies to **write** verbs. For reads a Server **MAY** degrade to a durable secondary sink and **MUST** record the degradation as an event. An unbounded fail-closed log is otherwise an availability weapon: fill it with refused calls and `release_hold` fails too, so seats stay held while the boundary is dark.
> **A3.** The log **MUST** be partitioned by `local_wall` date. Rows **MUST NOT** be retained beyond `log_retention_days` (default 90, published), after which the partition is **detached** and replaced by a rollup carrying no `agent_id`, no `principal_scope`, no digest and no seat ids. Detaching a partition is not an `UPDATE` or `DELETE` on a row and does not violate C-LOG; the `DROP` grant belongs to a separate `changeover_retention` role holding nothing else.
> **A4.** Refusals **MUST** be logged at bounded size — code, verb, agent_id, slot, no payload.

Four measurement failure modes are designed in from the first migration, because a series cannot be back-filled: slot derived from local wall time with its offset, never UTC; idempotent ingest on `unique(_source, natural_key)` including `local_wall_offset`; append-only records versioned on `input_watermark`, with a `window_not_settled` refusal rather than a silently revised number; and `attribution_rate` published beside any figure. **No estimator ships in v0.1.** The grain ships; the number does not.

### 5.5 `intent_digest`

> **D1.** A Server **MUST NOT** use it for authorisation, rate limiting, or any security decision. It is a correlation aid for the access log and nothing else.
> **D2.** An Agent **MUST NOT** derive it from any personal identifier — hashed, salted, truncated or otherwise. It **MUST** be random per customer intent and discarded when the intent ends.
> **D3.** A Server **MUST** reject `400 schema_validation` any value not matching `^[A-Za-z0-9_-]{43}$` **in both bindings**, and **MUST** store only its HMAC under P2.
> **D4.** It **MUST NOT** be echoed in any response body.

*A field shaped exactly like a SHA-256 and described as a stable correlation key for one customer's intent will be filled with `SHA-256(customer_email)`, because durable cross-session correlation is the only reason to want one. An unsalted email hash is not pseudonymous — it is reversible against any breach corpus and is a stable cross-site join key — and the draft would have written it into a permanent, `DELETE`-denied log.*

### 5.6 Privacy posture

**Pseudonymity here is a property of the schema, not a legal conclusion.** The Hold carries site, auditorium, showtime, seat numbers, timestamps, `agent_id` and `principal_scope`; the claim lands the customer in the exhibitor's checkout where they identify and pay. The exhibitor can join a claim to a named order, at which point the CHANGEOVER trail is personal data under GDPR Art 4(1)/Recital 26 and the NZ Privacy Act 2020 IPPs. That is why A3 exists, why P2 exists, and why CL5 forbids persisting the token. **`principal_scope` is a per-customer-session correlator minted by the agent platform**: the security model needs it and the privacy model pays for it. It is opaque, credential-only, rotated per session, never in a request or response body — an honest cost, not a solved problem.

---

## 6 · Transport bindings

### 6.1 Why both

MCP is how an agent reaches a tool with a freshness contract and a server-enforced human gate. HTTP is how everything else reaches it — the cinema's own front end, a partner ticketer, a conformance harness, `curl`. Neither subsumes the other, so **the refusal taxonomy is normative once and mapped twice**, and the report names which bindings passed.

### 6.2 MCP binding (2026-07-28)

Five tools; `inputSchema` and `outputSchema` are full JSON Schema 2020-12 (SEP-2106). `changeover.hold_seats` takes `{occasion_id, occasion_etag, sought{occasion_id, occasion_etag}, seats[] | selection{}, requested_floor_ms, idempotency_key, intent_digest}` with **every constraint identical to the HTTP binding** — `seats` `uniqueItems` and `maxItems: 12`, `intent_digest` `^[A-Za-z0-9_-]{43}$`, `idempotency_key` `maxLength 128`. The draft left `intent_digest` unconstrained here, so a Server accepting `"sarah.chen@gmail.com"` and echoing it emitted a Hold failing its own schema.

- **Server-minted handles (SEP-2567).** MCP removed protocol-level sessions; the prescribed replacement is *"explicit, server-minted handles passed as ordinary tool arguments."* `hold_id` **is** that handle; an Agent **MUST NOT** synthesise one.
- **Freshness (SEP-2549).** `CacheableResult.ttlMs` on `resolve_occasions` **MUST** be `min(max_staleness_ms, ms_to_sales_cutoff, 30000)`; `cacheScope` **MUST** be `session`.
- **Human gate (SEP-2322).** `InputRequiredResult` at the stage named by `gate_stage`, subject to X6/X6a/X6b.
- Sampling, Roots and Logging are deprecated; a conforming Server **MUST NOT** depend on them.
- `tools/list` **MUST NOT** contain any tool matching `settle|pay|capture|refund|charge|price`. One line, and it is `C-ABSENCE.1`.

**UCP.** CHANGEOVER binds as a **merchant-authored extension**, `dev.changeover.exhibition.*` — authored on the *merchant's* side of the boundary, the only geometry that passes the governing compass. *Whether a third party may register a UCP extension, or whether registration must be merchant-scoped, is **unverified** (§10.5).*

### 6.3 HTTP binding

```
GET     /.well-known/changeover                    capability document (+ Profile 0 occasions)
GET     /.well-known/changeover/delegation.json    authorised origins (apex only)
GET     /changeover/v0/occasions                   resolve_occasions (cursor, page_size)
GET     /changeover/v0/occasions/{occasion_id}     If-Match valid here
POST    /changeover/v0/holds                       hold_seats
GET     /changeover/v0/holds/{hold_id}             get_hold
DELETE  /changeover/v0/holds/{hold_id}             release_hold
POST    /changeover/v0/holds/{hold_id}/hand-off    hand_off
POST    /changeover/v0/holds/{hold_id}/revoke      Operator Override — operator surface only
```

Requests: `Authorization: Bearer`, `Idempotency-Key`, `Changeover-Version`, optional `Changeover-Occasion-ETag`. Responses: `Changeover-Server-Time`, `Idempotency-Replayed`, `Retry-After`, `ETag`, `Cache-Control`.

- **`If-Match` is removed from `POST /changeover/v0/holds`.** RFC 9110 §13.1.1 evaluates it against the **target** resource — here the hold collection — not a different resource named in the body, so any correct intermediary evaluates the condition against the wrong entity. The body's `occasion_etag` is normative; `Changeover-Occasion-ETag` is an optional echo and a disagreement is `400 schema_validation`. *(One reviewer proposed the opposite — header authoritative, body absent. The header cannot be right here: borrowing a conditional's spelling while changing its referent is exactly the divergence two conforming implementations will not survive.)*
- The wire etag is the unquoted `1:…` form; `ETag` and `If-Match` carry it as a **quoted** strong entity-tag and a Server **MUST** strip quotes before comparison.
- Where both are present **`retry_after_ms` is normative**; `Retry-After` **MUST** be `ceil(retry_after_ms / 1000)` and exists for intermediaries. A 400ms backoff otherwise becomes either a hammer or a 2.5× overwait, differently per implementation.
- `Cache-Control` on an Occasion **MUST** be `max-age = min(max_staleness_ms/1000, 30)`, so the bindings cannot disagree about cache life.

**Auth.** Bearer token, issued per site by the exhibitor and revocable by them. `agent_id`, `principal_scope`, site scope and permitted profile derive **from the credential**; `agent_id` is server-assigned at issue and never echoed from the caller. Any scope-bearing field in a request body **MUST** be deleted from caller input and refilled from the token, never merged. Errors are RFC 9457 `application/problem+json` with `type` as a URN — `urn:changeover:refusal:seat_contended` — because a URL type implies a domain that must resolve, and this project's domain is unverified.

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `schema_validation` | 400 | no | Failed validation, including duplicate seats. |
| `hint_rejected` | 400 | no | `work_hint` carries an identifier shape. |
| `unknown_seat` | 400 | no | Seat id not in this auditorium. |
| `window_too_wide` | 400 | no | Beyond `max_window_ms`. |
| `not_authorised` | 403 | no | Credential lacks the site, profile, or verb. |
| `principal_scope_missing` | 403 | no | Credential carries no principal. |
| `occasion_not_found` / `hold_not_found` | 404 | no | Unknown id, or not this principal's Hold (Z1). |
| `seat_contended` | 409 | after re-resolve | Named seats lost to another Hold. |
| `seat_unavailable` | 409 | after re-resolve | Unavailable in the system of record. |
| `seat_rule_violated` | 409 | after re-resolve | `detail.rule`, `detail.suggested_seats`. |
| `availability_unknown` | 409 | no | `mode: unknown`. Not sold out. Not available. |
| `availability_stale` | 409 | after re-resolve | Observation older than `max_staleness_ms`. |
| `past_sales_cutoff` | 409 | no | The screening has closed for sale. |
| `hold_not_live` | 409 | no | Verb attempted on a terminal Hold. |
| `hold_expired` | 409 | after re-resolve | The Hold ran out. |
| `hold_revoked` | 409 | no | Operator Override. |
| `handoff_consumed` | 409 | no | Hand-off is single-consumption and agent-terminal. |
| `stale_read` | 409 | after `get_hold` | `read_token` missing or stale (T4). |
| `idempotency_in_flight` | 409 | **same key**, `retry_after_ms` | Identical key executing. Not duplicated. |
| `claim_consumed` | 409 | no | Claim endpoint; already bound. |
| `claim_expired` | 410 | no | Claim endpoint; past `claim_expires_at`. |
| `occasion_moved` | 412 | after re-resolve | Etag mismatch. `detail.changed_paths`. |
| `substitution_refused` | 412 | no | The hold crosses a `strict` boundary (S1). |
| `idempotency_key_reused` | 422 | no | Same key, different digest. **No action taken.** |
| `hold_budget_exhausted` | 429 | `retry_after_ms` | Per-showtime or per-hour hold budget. |
| `seat_budget_exhausted` | 429 | `retry_after_ms` | Per-showtime seat budget (X4). |
| `cluster_fanout` | 429 | after release | A live Hold exists in this cluster for this principal. |
| `rate_limited` | 429 | `retry_after_ms` | Transport-level. |
| `profile_not_supported` | 501 | no | e.g. a hold verb against Profile 0. |
| `floor_unavailable` | 503 | `retry_after_ms` | No measurement exists to warrant a floor (§7). |
| `upstream_unavailable` | 503 | `retry_after_ms` | The exhibitor's own system is down. Never a guess. |

**Profiles.** **0 (Legible)** — a static JSON file: capability document plus Occasions with `mode` typically `unknown`, `book_url` set, no hold verbs. Any cinema with a website is conformant with no software, and **a Server MAY require authentication at Profile 0 and remains conformant**: publication is a choice; the schema is the standard. **1 (Held)** — `hold_basis: system_of_record`; the store defined here is the store. **1S (Shadow)** — `hold_basis: shadow`, a shim above a CMS, which is what every real deployment is. A 1S Server **MAY** mint Holds, **MUST NOT** be advertised as Profile 1, **MUST** publish its measured `oversell_rate`, and its `C-ATOMIC` **MUST** run against the composite system with a concurrent POS writer. *The unique index makes oversell unrepresentable in CHANGEOVER's own table, which is worth nothing while authoritative seat state lives in a CMS written by the box office, kiosks, the app and the phone room. 1S is the honest name for that, and W3 is what makes it more than a name.*

> **Usage.** An Agent **MUST NOT** persist, republish, or serve to a third party any Occasion where `usage_policy.redistribution` is `forbidden`, and **MUST NOT** retain one beyond `cache_max_age_ms`. **Conformance at any profile confers no redistribution right.**

*Said out loud, because an exhibitor spots it in thirty seconds: a standardised machine-readable showtime-and-price feed at a predictable path is the most useful artefact a listings aggregator could be handed, and today they pay for per-circuit scrapers that break monthly. The answer is not that Profile 0 is harmless. It is that the file is published by the exhibitor, at the exhibitor's own origin, under terms the exhibitor states, with authentication available — the opposite of being scraped, and a materially different power position from one where the aggregator sets the format.*

---

## 7 · Conformance

An implementation conforms at a profile when every class passes on a clean clone. Each assertion exits `0` (holds), `1` (fails), or **`2` (cannot prove)** — the difference between "your server violated the floor" and "we could not reach your server."

| Class | Asserts |
|---|---|
| **C-SCHEMA** | Every emitted document validates; unknown members rejected on write, ignored on read. **Every JSON payload printed in this specification validates against this specification's own schemas.** |
| **C-CAPABILITY** | The document validates, is served from a venue-authorised origin, and **no limit observed at runtime is absent from it**. |
| **C-ETAG** | Two independent implementations produce byte-identical JCS bytes and digest for a **pinned golden fixture**; a prose-only edit does not move the etag; each projected class of edit does. |
| **C-FLOOR** | `owned_store` hard-fails at one violation; `measured_warranty` **reports** `floor_violations` as a rate against a published threshold and does not hard-fail below it. `floor_ms` never increases post-grant; `expires_at ≥ floor_deadline`; `operator_overrides` reported separately. |
| **C-ATOMIC** | Harness profile stated: budgets disabled, `max_seats_per_hold: 1`, fixed seed. 200 concurrent holds on a 100-seat house: exactly 100 succeed, 100 typed `409`, zero oversell, zero partial holds, zero `40P01`. **.2** 50% of the seat set carries rows expiring within ±100ms of harness start — zero `40P01`. **.3** after a claim, a hold naming that seat returns `409` and writes no row. **.4** one valid + one invalid seat writes zero rows. Profile 1S runs all four against the composite system with a concurrent POS writer. |
| **C-BUDGET / C-FANOUT** | The same scenario at **production defaults**: `max+1` concurrent holds → exactly `max` succeed; two concurrent same-cluster holds for one principal → exactly one; two principals on one platform → both. Budgets bind in-transaction. |
| **C-IDEMPOTENT** | Replays carry identical identity and floor members with freshly projected time members; a different digest refuses and does not act, verified in the store; `input_required` records no entry; a `hand_off` replay after `claim_expires_at` yields no `claim_url`. |
| **C-RELEASE** | Total and idempotent in every state except `handed_off`, where it returns `409 handoff_consumed` and does **not** free the seat; seats re-holdable within a measured bound. |
| **C-ORPHAN** | With the sweeper disabled and the client `SIGKILL`ed, seats **and budgets** return via the next contending transaction; a two-seat hold contended on one seat leaves zero rows. |
| **C-REVOKE** | An Override transitions to `revoked`, records a reason, refuses agent verbs `409 hold_revoked`, and increments `operator_overrides` without failing C-FLOOR. |
| **C-SUBST** | The Server emits the transitive closure of the authored rules; `maximalAntichain` matches a reference oracle over generated posets including `x-` members; a hold whose `sought` crosses a strict boundary returns `412` **and writes no `hold_seat` row**; a cross-origin edge is rejected at publish and ignored by the reference Agent. |
| **C-SEATMAP / C-CLAIM** | The seat map validates, is same-origin, is credentialed, and its ids are accepted by `hold_seats`. `GET {claim_url}` is prefetch-safe and does not consume; a second confirm returns `claim_consumed`; an expired claim renders a typed outcome naming the Occasion. |
| **C-ORIGIN** | Every absolute URL is same-origin with `venue.origin` or a delegated origin; a fixture with an off-origin `book_url` is rejected at publish and refused by the reference Agent; a cross-origin redirect on the well-known path is refused. |
| **C-AUTHZ** | With two credentials on one site, every verb by B against A's Hold returns `404` and the store shows no state change. |
| **C-ABSENCE** | **.1** no settlement verb anywhere. **.2** member manifest **set equality**. **.3** the `SET LOCAL ROLE` kill test raises `insufficient_privilege`. **.4** outbound byte canary: no response body matches an email, a Luhn-valid 13–19 digit run, or an E.164 string — **fail the build, do not filter the response**. |
| **C-PII-INGEST** | Email-, phone- and PAN-shaped `work_hint` are each refused, and a full scan of the access log after a poisoned run matches none of those patterns — **asserted on the store, not the response**. |
| **C-INJECT** | **.1** every URL in every emitted document is same-origin. **.2** with poisoned prose the etag is byte-identical to the unpoisoned run and a hold across a strict boundary still returns `412`. **.3** prose bytes are within Q1. *(The draft asserted that "a deliberately compromised agent" changes no boundary behaviour — true by construction, since the agent is not the boundary. An agent you wrote cannot falsify your claim.)* |
| **C-REFUSE** | Refusals never mixed with rows; guard order per G1 against a fixture failing four guards at once; every refusal validates against its code's closed `detail` branch; a refusal carrying an extra member is rejected by the reference Agent. |
| **C-CLOCK** | `server_time` on every response and non-decreasing per hold; no request accepts a client timestamp; DST-**fold** and DST-**gap** fixtures. |
| **C-LOG** | One row per invocation including refusals; fail-closed on writes; `UPDATE`/`DELETE` denied to the agent role; partition detach permitted only to `changeover_retention`. |
| **C-USAGE / C-PROFILE0** | `usage_policy` present and honoured by the reference Agent; the static file validates, serves from a venue-authorised origin, and hold verbs return `501`. |

**Report format.** A dated JSON report: `spec_version`, `register_version`, `profile`, `hold_basis`, `floor_basis`, `implementation`, `bindings`, `run_at`, `trials`, per-class `{pass|fail|unprovable}`, `floor_violations`, `operator_overrides`, `release_latency_ms {p50,p95,max}`, `oversell_events`, harness commit hash. **Reports are never restated.** A later run is a new report.

> **The floor is a warranty, not an assertion.** `floor_ms` **MUST NOT** exceed `min_observed_retention_ms − safety_margin_ms`, both published in `floor_evidence`. **A Server MUST NOT grant a floor it has not measured**; where no measurement exists the refusal is `503 floor_unavailable`. An operator who sets 180000 because a worked example does, above an order whose configured expiry is 120 seconds with an eager reaper, emits a lie with a MUST NOT beside it.

*Real observed floors and release latencies at exhibitor boundaries are numbers nobody in this industry publishes, and a series beginning in 2026 cannot be bought in 2028 at any price.*

---

## 8 · Versioning

> **V1.** Every document and request carries `changeover`. A Server **MUST** reject a request whose declared version is absent from `supported_versions`.
> **V2.** A change no conforming implementation can fail is a **minor**; a change that could cause a previously conforming implementation to fail any §7 class is a **major**. No third category, no exceptions for "obvious" fixes. Adding a member to PROJECTION_0_1 is a major.
> **V3.** Read liberally, write strictly. An Agent **MUST** ignore unknown members in documents it reads; a Server **MUST** reject unknown members in write bodies — a silently ignored write field is a correctness hazard wearing tolerance's clothes.
> **V4.** Enums are closed; extensions are `x-` prefixed. An Agent encountering an unrecognised enum value **MUST** refuse rather than guess, including `availability.mode`, and **MUST** render any prose value as plain text regardless of `content_type`.
> **V5.** A field never changes meaning. A changed meaning gets a new name; the old is deprecated, not removed.
> **V6.** The class register versions independently and is **append-only**. A class id is never reused or redefined; retirement sets `retired_at` and the class resolves forever, because an Occasion published in 2026 must still parse in 2031.
> **V7.** Two adjacent versions run concurrently for at least **twelve months**, matching MCP's own deprecation window.
> **V8.** Reports are keyed on `(spec_version, register_version)`. A spec change does not invalidate an old report; it makes it an old report.

---

## 9 · Worked example

*"Find me a good way to see* The Conversation *this weekend in Wellington."*

**1 · Resolve.** Three Occasions in one cluster, `the-conversation-wlg-2026-w35`, all `policy: strict`:

> **All three are published at one `venue.origin`** — `https://embassy.example` — by one operator running both an archival house and a multiplex, which is the ordinary shape of a small circuit. This is not decoration. **E1** requires every substitution edge to target an Occasion published at the same origin, and **E3** scopes `cluster` to `(venue.origin, cluster)`; a version of this example spanning two independent exhibitors would author cross-origin edges that a conforming Server **MUST** reject at publish. **Cross-exhibitor substitution is therefore out of scope in v0.1** — a consequence of E1/E3 that this section previously left implicit. *(Correction, 2026-08-25: the worked example originally implied two unrelated venues. Found by building the golden fixtures; recorded in `docs/2026-08-25-cx-01-spec-first.md`.)*

| | Embassy, Sat 19:00 | Multiplex, Sat 21:00 | Multiplex, Sun 14:00 |
|---|---|---|---|
| `occasion_id` | `occ_embassy_…T1900_s1` | `occ_multiplex_…T2100_s4` | `occ_multiplex_…T1400_s4` |
| `etag` | `1:XB7PZvK6GJP0BY4IPzKdmuCc-R5RaivznwPz_KDY-04` | `1:ktjR8_5bWWg_lejnE6BqPSaNzXSyCzYynsci_O9_Qr4` | `1:9MokuOSTWVJ-_t1IMbm7cfT61VjN3kfb3yDZtK6UJJ4` |
| `presentation_classes` | `pres:35mm-4perf`, `pres:reserved-seating` | `pres:dcp-2k-flat` | `pres:dcp-2k-flat` |
| `occasion_classes` | `occ:archival-print`, `occ:final-run` | — | — |
| `accessibility.open_captions` | `no` | `no` | **`yes`** |
| price | NZD 2600, fees + tax included | NZD 1400 | NZD 1200 |
| `accepts_substitute` | *(empty)* | → Embassy 19:00, axis `presentation_class` | *(empty)* |
| `derived_from` | `r-35mm-carrier`, rules `2026.1` | same policy | same policy |

**2 · The antichain.** The DCP at 21:00 attests `⪯ embassy1900`; the Embassy attests nothing inbound. So `dcp2100 ≺ embassy1900` strictly and the 21:00 is **dominated and dropped**. The Sunday matinee is incomparable — a different night, no attested edge — and survives, with `open_captions: yes` as a distinguishing axis. The Agent returns two options with their axes and **does not** return *"the cheapest is $14."* The human chooses the 35mm.

**2a · The typo.** The Publisher fixes "vaults" to "vault" in the programme note. It is outside PROJECTION_0_1, the etag does not move, every in-flight resolution across the estate stays valid. This is `C-ETAG.2`.

**3 · The gate, then the hold.** `gate_stage: "hold"`, so the human confirms *before* a seat is locked, from structure — `{seat_count: 2, venue_name: "Embassy Theatre", local_wall: "2026-08-29T19:00", presentation_classes: ["pres:35mm-4perf"], amount_minor: 5200, currency: "NZD"}` — with a prose caption.

```http
POST /changeover/v0/holds     Idempotency-Key: 01K3QW9Z8YVJ4C7N2M5X6TB0RH
{ "occasion_id": "occ_embassy_20260829T1900_s1",
  "occasion_etag": "1:XB7PZvK6GJP0BY4IPzKdmuCc-R5RaivznwPz_KDY-04",
  "sought": { "occasion_id": "occ_embassy_20260829T1900_s1",
              "occasion_etag": "1:XB7PZvK6GJP0BY4IPzKdmuCc-R5RaivznwPz_KDY-04" },
  "seats": ["stalls:F:11","stalls:F:12"], "requested_floor_ms": 300000,
  "intent_digest": "AmIbmQY4d3U7tZEunRsQ7p8oUa_Wr7PR_QszONdr-vk" }

HTTP/1.1 201 Created          Changeover-Server-Time: 2026-08-29T09:20:00.412Z
{ "changeover":"0.1", "hold_id":"hold_4ZZQCSHNJ2NN5ZRJW94NRCWHXYCWBW1P", "state":"live",
  "occasion_id":"occ_embassy_20260829T1900_s1",
  "occasion_etag":"1:XB7PZvK6GJP0BY4IPzKdmuCc-R5RaivznwPz_KDY-04",
  "sought_occasion_id":"occ_embassy_20260829T1900_s1",
  "seats":["stalls:F:11","stalls:F:12"], "granted_at":"2026-08-29T09:20:00.400Z",
  "floor_ms":180000, "floor_deadline":"2026-08-29T09:23:00.400Z",
  "expires_at":"2026-08-29T09:25:00.400Z", "extendable":false, "agent_id":"agt_9f2c",
  "cluster":"the-conversation-wlg-2026-w35", "server_time":"2026-08-29T09:20:00.412Z" }
```

*(Correction, 2026-08-25: this response originally omitted `occasion_etag`, which §2.6 makes REQUIRED — the printed Hold did not validate against this specification's own Hold schema. Found by `scripts/prove_spec_examples.sh` on its first run, before any implementation existed; recorded in `docs/2026-08-25-cx-01-spec-first.md`.)*

The Agent asked for 300000 and got 180000 — `min(requested, policy_max)`, and the Server **may** return less. `intent_digest` is not echoed (D4). That floor, and nothing else, is what the Agent may plan against.

**4 · Fan-out, refused.** The Agent hedges and tries to also hold the cheap Sunday matinee for the same principal:

```jsonc
HTTP/1.1 429  { "refused": true, "code": "cluster_fanout",
  "remediation": "release_conflicting_hold",
  "reason": { "content_type":"text/plain",
              "value":"A live hold already exists in this demand cluster." },
  "detail": { "conflicting_hold_id":"hold_4ZZQCSHNJ2NN5ZRJW94NRCWHXYCWBW1P",
              "cluster":"the-conversation-wlg-2026-w35", "limit":1 },
  "retry_after_ms": 0, "server_time":"2026-08-29T09:20:04.887Z" }
```

The next action comes from `code` and `remediation`. Nothing held, nothing oversold, and the Friday seats are still the customer's rather than one of four speculative holds an agent abandons in ninety seconds. A second household on the same platform, different `principal_scope`, is unaffected.

**5 · A price-route, refused.** On another run the Agent tries to hold the 21:00 DCP while `sought` names the Embassy 35mm: `412 substitution_refused`, `remediation: re_resolve`, `detail {from_occasion_id: "occ_embassy_20260829T1900_s1", crossed_axis: "presentation_class"}`, and no `hold_seat` row exists (`C-SUBST`). This is the thesis line, and it is a mechanism because `sought` exists. It is also the honest limit: an Agent that sets `sought = occasion_id` and lies is indistinguishable from one whose customer asked for the DCP (S4).

**6 · The failure a brochure would omit.** The customer goes to ask their partner about Saturday. The floor passes at 09:23:00.400 but the seats are held to 09:25:00.400, so `hand_off` **succeeds** under HO1 — the draft would have refused it for three and a half minutes with a code meaning *wrong verb*. Had the seats gone, the refusal is `409 hold_expired {expired_at, occasion_id}` with `remediation: re_resolve`: a sentence the Agent can say to a human — *the hold ran out while you were deciding, and these are the seats now.*

**7 · Re-read, then hand off.** `get_hold` returns `expires_at` moved to 09:26:30.000 (upward only, T7), `floor_deadline` unmoved, and a `read_token`. `hand_off` carries it:

```jsonc
{ "state":"handed_off",
  "handoff": { "handed_off_at":"2026-08-29T09:24:05.220Z", "handoff_floor_ms":300000,
    "claim_url":"https://tickets.embassy.example/claim/KSeuLv3jX9x3fJ9QEeEXRYRILZ9iK1F0",
    "claim_expires_at":"2026-08-29T09:29:05.220Z" } }
```

`claim_expires_at = handed_off_at + handoff_floor_ms`, clamped to `sales_cutoff_at` (T5), and `held_until` moves with it in the same transaction (T6). `tickets.embassy.example` is not `venue.origin` and is legal because the venue's own apex delegation record names it (O1). A link scanner prefetching that URL does not consume it (CL2). `release_hold` is now refused (R1): the seats belong to the customer and the exhibitor.

Both projectors are running. The customer opens a page **on the cinema's own domain**, seats warm, with the F&B upsell exactly where the exhibitor already put it. The Agent's transcript ends here, unable to continue, because there is no verb. The log has five rows and never learns whether the tickets were bought.

---

## 10 · Open questions

1. **`sought` is unverifiable, so the substitution right is a liability rule, not an interlock (S4).** A Server can refuse a *declared* crossing; it cannot detect an undeclared one. A partial mitigation exists — where `sought` is absent and the held Occasion shares a cluster with one the same principal resolved this session, a Server **MAY** refuse — and it is a heuristic. **This is the one blocking finding not fully closed, stated here rather than dropped.** *Closed by:* an attested resolution receipt binding a hold to the antichain the Agent was served — deferred, because it needs signing, which §3.3 removed from v0.1 for good reason.
2. **Is `floor_ms` enforceable above an incumbent sweeper?** Profile 1S and `measured_warranty` are the honest answer. *Closed by:* running C-FLOOR against a real deployment and publishing the result, including a bad one.
3. **What is the right `handoff_floor_ms`?** 300000 everywhere here is a placeholder with no evidence. *Closed by:* the measured distribution of hand-off-to-claim.
4. **Unallocated seating.** `mode: count` has no seat ids, so `hold_seats` has nothing to name and `best_available` nothing to choose from. Count-mode houses are **Profile 0 only** in v0.1, reluctantly, because the alternative reintroduces the fungible-quantity model this specification exists to reject.
5. **May a third party register a UCP extension, or must it be merchant-scoped? Unverified.**
6. **Does Spektrix sanction writes against their public `apitesting` client?** Read access verified live and unauthenticated 2026-08-24. **Write is unverified and must be asked before any conformance run touches it.**
7. **Real deployment expiry defaults, and whether any CMS front end can consume a `deep_link` claim.** Published nowhere. *Closed by:* one conversation with one operator — the cheapest unblocking action in this document, and the one that should precede writing any more of it.
8. **Does `intent_digest` earn its place?** With D2–D4 and P2 it is safe; the question is no longer whether it is useful but whether a field shaped like a SHA-256 makes an unsalted email hash the path of least resistance for the median implementer. It does.
9. **Is the cluster the right fan-out unit, or should it be the preorder?** *Closed by:* the first real integration that finds the cluster rule too blunt.
10. **The habit instrument publishes no number in v0.1** — the largest deliberate omission. The grain ships: held-then-abandoned, held-then-handed-off, return interval between hand-offs at a site. No estimate, because the headline estimator has no canonical decomposition and any slot taxonomy beneath it competes with a latent variable its own estimator would learn. *Closed by:* enough dated grain to fit against, and a decomposition someone can check.
11. **Whether the redirect is permanent by design.** Today agents redirect, and a redirect is free, correct, and already shipped at 5,386 screens. This specification does not bet against that — it makes the redirect terminal and fixes the one thing a redirect cannot do, which is survive the walk. *Closed by:* the market, over years, and not by this document.

---

## 11 · Review record

Three adversarial reviews attacked v0.1 on 2026-08-25: **K1** (concurrency, 22 findings), **K2** (security, 21), **K3** (deployment reality, 20). Recorded here in the posture of `cinema-ops-platform`'s Field Corrections: a specification that hides its own review has published a brochure.

**Blocking, fixed in text.** `substitution_refused` had no premise → `sought`, S1–S4. Four deadlines, one invariant → T5–T7 with `held_until` bound to state. The gate returned `422` under the spec's own I5 → I3 digests decision members, I7 exempts gates. `claimed` outside the uniqueness index → seat-occupying states. Deadlock survived L1 → unconditional sorted locks over the full requested set. No isolation level → N1 with constraint-backed budgets. Five guards, no order → G1/G2. Byte-identical replay of a time-bearing Hold → I4/I4a. No same-origin rule on any URL → O1–O3 and a bare-origin pattern. `claim_url` an unbound bearer capability with its endpoint out of scope → §4.10, CL1–CL5, `claim_binding`. No object-level authorisation, monotonic ULID `hold_id` → Z1–Z3, 160-bit non-monotonic ids. `release_hold` on a handed-off Hold → deleted, R1. Agent free text into a `DELETE`-denied log → P1–P3, crypto-shredding. T1 plus published budgets as an exhaustion weapon → X4/X5, `policy_max_floor_ms` capped at 300000. Budgets scoped to a whole agent platform → `principal_scope`, X0–X3. T1 forbidding the operator to manage their own house → Operator Override, `revoked`, C-REVOKE. Capability document required eight times, never defined → §2.9. Seat ids unobtainable, no best-available → §2.10, W1–W4. Projection not closed → PROJECTION_0_1, and §9's etags regenerated as real 43-character digests. No honest target above a CMS → Profile 1S, `hold_basis`, `floor_basis`, W3. Substitution corpus re-authored weekly over instance ids → rule-based authoring with server-side derivation and closure.

**Serious, fixed.** Reap that never transitions the Hold (M1–M3) · partial reap · `hand_off` refused on a live Hold with a lying code (HO1/HO2, `hold_expired`) · release/claim race (R1–R3) · no code for unknown or sold seats, blanket `23505`, no `uniqueItems` (W1–W3) · `idempotency_in_flight` · replay-versus-guard precedence (I8) · unpublished cluster limit and the `max_seats_per_hold` contradiction · `If-Match` on the wrong resource · RTT and fleet skew (K4–K6) · transaction-start `now()` shortening the floor · `suggestion` as an instruction channel (`remediation`) · no pagination or array caps (Q1) · the human gate as a MAY (X6) · C-ABSENCE denylist and C-INJECT tautology · `intent_digest` as an email-hash slot (D2–D4) · unscoped edge targets (E1–E3) · unvalidated seat ids · the origin rule as a self-check · replay re-vending a consumed claim (I9) · the log as an availability weapon (A1–A4) · price basis and consumer law · Profile 0 terms · log erasure (A3, §5.6) · accessibility in the projection · the gate inside the floor window · `run_position` deleted · register reduced to a ~30-id seed · origin binding versus real circuits.

**All eighteen minor findings fixed**, including `revision` monotonicity, total `release_hold`, `Retry-After` rounding, `intent_digest` parity across bindings, `hold_policy` required at Profile 1/1S, T4 given a mechanism (`read_token`), `sales_cutoff_at` guards, staleness enforcement, `x-` incomparability, the five schema incoherences, the scoped mechanism-1 claim, DST fold and gap, `feature_at`/`ends_at` out of the projection, C-ATOMIC's harness profile, `staleness_basis`, `work_ref`, and `content_type` as a one-member enum.

**Where reviewers were overruled.** *(1)* K1 and K3 proposed opposite `If-Match` resolutions; the header is removed rather than made authoritative, because RFC 9110 evaluates it against the request target and the condition here concerns a different resource. *(2)* K2's prose rule — reject any `[a-z][a-z0-9+.-]*:` at a word boundary — also rejects a programme note beginning "note:"; PR2 uses a scheme allowlist. *(3)* K2's claim binding at first `GET` is incompatible with K3's prefetch finding; CL2 binds at a non-idempotent confirm, satisfying both. *(4)* K3's framing of Profile 0 as a compass violation is rejected: a file an exhibitor chooses to publish at their own origin under stated terms, with authentication available, is the opposite of being scraped — the defect was the missing terms, which `usage_policy` supplies. *(5)* K2's implied remedy for a "scrapeable" moat is declined: caps and pagination ship, but published edges are public by construction, and the moat is the authoring and the freshness, not secrecy about what was authored. *(6)* K2 objected that `principal_present` should not appear in a request; it never did — it was a credential claim, and the real defect is that `attended` is no more verifiable, which X6b now says outright instead of pretending the grant fixes it.

**Accepted as known limitations.** `sought` is unverifiable (§10.1) — the one blocking finding not fully closed. `principal_scope` introduces a per-customer-session correlator to make the security model workable, and the privacy model pays for it (§5.6). Count-mode houses remain Profile 0 only (§10.4). The Server never learns whether an order completed, so the grain is formed intent and never conversion (§4.9). Signing is removed rather than half-specified, leaving delegation as the only origin-authority mechanism in v0.1 (§3.3). And the seed register, the authoring tool (`changeover.policy.yaml`, `changeover lint`, `changeover derive`) and the claim binding become the first three items of work — paid for, in the build plan, by cutting the third adapter: two independently-shaped surfaces prove the contract, and the third proves stamina.

---

*The audience never sees the changeover.*
