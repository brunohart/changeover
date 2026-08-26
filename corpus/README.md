<!--
  Business Source License 1.1 — see ../LICENSE-BSL.md
  Licensor: designedbybruno · Licensed Work: The CHANGEOVER boundary corpus (corpus/)
  Change Date: 2029-05-03 · Change License: MIT
  This directory is the ONLY part of this repository that is not MIT.
-->

# The boundary corpus

**Licence: Business Source License 1.1 ([../LICENSE-BSL.md](../LICENSE-BSL.md)). Change Date 2029-05-03, Change License MIT.**
Everything else in this repository — the specification, the schemas, the fixtures, the reference implementation, the probe, the conformance suite — is MIT. This directory is not.

## What the licence actually stops you doing, in plain words

You may read this, copy it, change it, publish your changes, build products on it, and run it in production **unless** what you are building sits between an exhibitor and that exhibitor's own customer and takes money from that position. Ticket aggregation, cross-exhibitor marketplaces, routing demand between competing venues, and reselling this corpus to anyone doing those things are the excluded uses. Everything else is granted, now, without asking.

Exhibitors, cinema management system suppliers, distributors, trade bodies, researchers, and anyone integrating against a **single** exhibitor's own boundary are expressly granted use.

On 2029-05-03 the whole thing becomes MIT and this paragraph stops mattering.

The reason the guardrail is in the licence rather than in a promise: a README binds its author and does not bind its author's acquirer. This project's compass is that a solution must be a net positive for the exhibitor and must strengthen the **direct** relationship between an exhibitor and their customer. Putting that in the licence is the difference between an intention and a mechanism.

## Independence, stated once and meant

This work is independent. It is not affiliated with, endorsed by, sponsored by, or connected to any cinema platform vendor, exhibitor, or ticketing company named anywhere in it. Vendors are named because their documentation is public and because a corpus that recorded anonymous behaviours would be useless. **Every claim about a named vendor carries a citation with a URL and the date it was retrieved**, and `scripts/prove_corpus_cited.sh` fails the build if one does not.

Live probing was limited to surfaces the vendor's own public documentation publishes as public entry points, unauthenticated, read-only, at single-request volume. No credential was held, sought, guessed or used. No write path was exercised anywhere. No path was enumerated that the vendor's own documentation does not name.

## Why this directory exists

The specification says what a boundary **should** do. The conformance suite says whether one implementation **does** it. Neither of those is evidence about the world. This corpus is the third thing: a dated, cited record of how real exhibitor boundaries **actually behave**, as against how their documentation says they behave.

It is the only asset here that compounds with use rather than with labour. A specification is worth what it argues; a corpus is worth what it has watched. Real observed floors and release latencies at exhibitor boundaries are numbers nobody in this industry publishes, and a series that begins in 2026 cannot be bought in 2028 at any price.

## The shape of an entry

`entry.schema.json`. One file per entry under `entries/`, named `<id>.json`. The directory is the registry — adding an entry is adding a file, and nobody edits a shared table.

Every entry carries a permanent `id`, the `surface` it belongs to, a `behaviour` stated precisely enough to be testable, the `method` by which it was established, an `observed_at`, a `half_life_days` with a stated `half_life_basis`, a `confidence_at_observation`, and a `citation {url, retrieved_at}`. Ids are never reused and never redefined: correcting an entry means a new id naming the old one in `supersedes`.

### The four methods, and why provenance is the point

| `method` | Means | Evidence |
|---|---|---|
| `probed_live` | A request was sent to the vendor's own API surface and the response observed. | **`evidence` is mandatory** — request line, status, byte count, what it established, and a command to reproduce it. |
| `documented` | Quoted from public vendor documentation describing the published contract. | The quote and its locator. |
| `vendor_stated` | Quoted from a vendor's own words about internal or operational behaviour **that the public surface does not expose for verification** — believed on the vendor's authority alone. | The quote, plus a `verification_gap` saying what access would be needed to check it. |
| `reproduced_in_fixture` | A fixture in this repository reproduces the behaviour and a test asserts it. | The fixture. **Unused at corpus 0.1.0** — no fixture reproduces a recorded behaviour yet, and claiming otherwise would be the exact dishonesty this column exists to prevent. |

A synthetic corpus cannot honestly carry `probed_live`. That is the whole reason the column is there, and it is why the proof script exits 1 — not 2, not a warning — on any `probed_live` entry with no evidence of a live probe.

### The half-life, and how to read it

A claim about a live system is a perishable good. Every entry says by how much and from when:

```
confidence(t) = confidence_at_observation * 2 ** (-(t - observed_at) / half_life_days)
```

The rubric this corpus applies, and each entry restates its own reasoning in `half_life_basis`:

| Kind of claim | Half-life | Why |
|---|---|---|
| Live observation of one deployment | 60–90 days | A deployment changes on any release and nothing announces it. |
| An **absence** (a documented convention that is not there) | 90 days | The most perishable claim available: a vendor closes it in one commit. |
| A vendor statement about internal timing | 120 days | Unverifiable from outside, and quietly tuned. |
| A published contract behaviour | 180 days | Stable across a release, not across a rewrite. |
| Architecture — the shape of the product | 270 days | Changes on a redesign, not on a release. |

Confidence never reaches zero and an expired entry is never deleted. It is re-observed, or superseded, or left standing with its decay visible. Deleting evidence because it aged is how a corpus becomes a brochure.

## What is deliberately not here

- **No personal data**, in any entry, ever: no name, email, phone, loyalty number or payment instrument, and no field in which one could be put. `evidence` is narrowed to status codes, byte counts and repeatable commands precisely because a stored response body is an unbounded channel for exactly that. `evidence.probed_by` is a closed enum with one member and it is not a person.
- **No credentials, no tokens, no tenant identifiers.**
- **No inference presented as observation.** Where something is unverified it says so, in `verification_gap`, in the entry that makes the claim.
- **No settlement.** Nothing here records, models or enables the settling, authorising, capturing, refunding or pricing of anything.

## The fingerprint

`../schemas/fingerprint.schema.json` is the shape `changeover probe` emits: which of these behaviours a particular surface exhibits, with `exhibits` / `does_not_exhibit` / **`indeterminate`** as first-class verdicts. `indeterminate` is never collapsed into either of the others — the difference between *the surface does not do this* and *we could not tell* is the same distinction the conformance suite draws between exit 1 and exit 2, and it is the reason either document can be trusted. `fingerprint-example.json` is a real one, taken from the probes recorded here, and the proof validates it.

The fingerprint schema is a **harness** schema. It is not one of the eight CHANGEOVER document schemas, no Server emits it on a verb's wire, and its member names MUST NOT be added to `schemas/member-manifest.json`.

## Correcting an entry

If an entry here is wrong, it is wrong in public and it should be. Open an issue naming the entry id and the source that contradicts it. A contradicted entry gets `superseded_by` and stays where it is, with its date on it.
