# CHANGEOVER

**An open commitment boundary for cinema exhibition.** An agent holds the seat for a stated, irrevocable window and
hands the customer back to the exhibitor's own checkout, with the seats still there.

> A changeover is the eight seconds in which two machines run at once so the audience never sees the seam.

[![proofs](https://github.com/brunohart/changeover/actions/workflows/proofs.yml/badge.svg)](https://github.com/brunohart/changeover/actions/workflows/proofs.yml)
[![spec](https://img.shields.io/badge/spec-v0.1-C08B4F?style=flat-square&labelColor=15191F)](SPEC.md)
[![settlement](https://img.shields.io/badge/settlement-absent%2C%20not%20gated-4E8C63?style=flat-square&labelColor=15191F)](DECISIONS.md#adr-001--no-settlement-verb-permanently)
[![implementation](https://img.shields.io/badge/reference%20impl-not%20yet%2C%20on%20purpose-8C97A3?style=flat-square&labelColor=15191F)](docs/2026-08-25-cx-01-spec-first.md)

---

## The gap

An agentic cinema booking is four operations, not one: **intent formation**, **discovery and resolution**,
**commitment**, and **settlement**. Settlement is finished and contested by parties with balance sheets. Discovery is
deployed — Regal Cineworld's ChatGPT app answers showtime questions across 5,386 screens and then directs users to
Regal's own website to complete the purchase (Variety, Boxoffice Pro, 10 Apr 2026).

**What has no contract is the walk between them.** Above the exhibitor, no published stack defines a hold: UCP disclaims
one in normative text — *"recognizing an ID neither reserves inventory nor guarantees eligibility"* — and Edgar Dunn &
Company's cinema reference architecture (3 May 2026) terminates at the payment token. Below the exhibitor, a seat hold
is not an object at all: it is a side effect of an order with a configurable, silently-extendable expiry, released by
background processes that *"may take a few minutes"*, with no documented idempotency convention anywhere.

So the industry's entire agentic surface currently ends in a hyperlink and a hope. The customer walks across the
boundary and arrives at a seat map that moved underneath them.

## The five verbs, and the one that is absent

```
resolve_occasions   hold_seats   get_hold   release_hold   hand_off
```

There is **no settlement verb** — not deferred, not permission-checked. The surface has no such operation, so no
instruction can reach one. An agent is a consumer with no judgement, and a thing it must not do should not be asked not
to do. See [ADR-001](DECISIONS.md#adr-001--no-settlement-verb-permanently).

The central object carries **no quantity**. It is *this work, in this room, at this instant, in this manner* — and it can
state that two screenings are **not substitutable**, so a machine cannot price-route a household off a 70mm print onto a
cheaper DCP on the grounds that it could not tell the difference.

## What is here today

**The specification, its schemas, and a digest nobody can argue with.** There is no reference implementation yet, and
that is deliberate — the thing that decides predates the thing that executes, and git adjudicates it forever.

| | |
|---|---|
| [`SPEC.md`](SPEC.md) | v0.1 — data model, hold state machine, safety model, MCP and HTTP bindings, conformance, worked example |
| [`DECISIONS.md`](DECISIONS.md) | ADR-001 … ADR-008 |
| [`schemas/`](schemas/) | Nine JSON Schemas (2020-12), the closed projection, the Lock 2 member manifest, the five verbs |
| [`register/2026.1.json`](register/2026.1.json) | The seed class register — append-only, 34 ids |
| [`fixtures/golden/`](fixtures/golden/) | Three Occasions whose etags were **frozen before any implementation existed** |
| [`scripts/`](scripts/) | Five proofs |

```bash
npm install && bash scripts/run_proofs.sh
```

Each proof exits `0` (holds), `1` (fails) or **`2` (cannot prove)**. The third matters: a suite that reports green when
it could not reach the thing it tests is worse than no suite.

## Why the digests were frozen first

`C-ETAG` asks **two independent implementations** to agree on a pinned golden fixture. A fixture authored *after* the
first implementation is a fixture fitted to that implementation, and the class then proves only that a program agrees
with itself. The three digests in [`fixtures/golden/EXPECTED.md`](fixtures/golden/EXPECTED.md) were computed by a
third-party RFC 8785 canonicaliser and `node:crypto`, driven by a projector that no implementation may ever import.

That root commit is the one property of this project that cannot be back-filled at any price.

**On its first run, `prove_spec_examples.sh` failed** — the specification's own worked example printed a Hold that did
not validate against the specification's own Hold schema. It found two further incoherences besides. All three are fixed
in this same commit and recorded in [`docs/2026-08-25-cx-01-spec-first.md`](docs/2026-08-25-cx-01-spec-first.md),
because a specification that hides its own review has published a brochure.

## Licence

| | |
|---|---|
| Specification, schemas, fixtures, reference implementation, conformance suite | **MIT** ([LICENSE](LICENSE)) |
| The boundary corpus (`corpus/`, when it exists) | **BSL 1.1**, Change Date 2029-05-03 ([LICENSE-BSL.md](LICENSE-BSL.md)) |

The standard is free. The corpus — measured behaviour at real exhibitor boundaries — carries an Additional Use Grant
that forecloses resale to any party occupying an aggregation seat between an exhibitor and their customer. The guardrail
is in the licence rather than the README, because a promise binds its author and not its author's acquirer.

---

*Independent work. Not affiliated with, endorsed by, or officially connected to any cinema platform vendor. Every vendor
behaviour cited is drawn from public documentation with its retrieval date attached; where a fact could not be
established it is marked unverified.*

*The audience never sees the changeover.*
