# CX-01 — spec, schemas, and an etag fixture frozen before any code exists

**Date** 2026-08-25 · **Commit** the root commit of this repository · **Backlog** `SPEC-001` … `SPEC-006`

A dated artefact in the manner of `cinema-ops-platform`'s field corrections: what was claimed, what the proofs actually
printed, and what the session found wrong with the specification it was implementing.

---

## What this commit contains, and what it deliberately does not

`SPEC.md` v0.1, nine JSON Schemas, the closed projection, the Lock 2 member manifest, the `2026.1` seed class register,
three golden Occasions with frozen digests, and five proof scripts.

**No reference implementation.** Nothing that mints a Hold, takes a lock, evaluates a guard, or serves a route. No
`src/`, no `packages/*/src/`, no `.ts`, no `.sql`. `prove_spec_first.sh` asserts that property **of the root commit**, so
it passes at commit one, keeps passing forever, and can never be satisfied by rearranging a later commit.

### Where the `cinema-ops-platform` precedent was inherited, and where it was moved

That repository's commit one (`4f05bb5`, 2026-07-30) held `ARCHITECTURE.md`, `DECISIONS.md` and toolchain config, and
nothing under `src/`, `dbt/`, `sql/`, `tests/` or `scripts/`.

**The principle is inherited unchanged:** the thing that decides predates the thing that executes, and git adjudicates it
forever. **The file list is not.** That repository's specification was prose, and its schemas lived *inside* the
implementation, so excluding `sql/` and `scripts/` cost it nothing normative. Here the inverse holds: `SPEC.md` §0 states
that schemas are JSON Schema 2020-12, and the etag is *defined* as a digest over a closed JSON-Pointer list that the spec
says lives in the schema package. A schema file here is not implementation — it is the specification's normative text in
the form the specification says it takes. Withholding it would put the spec's own definitions outside the spec's own
first commit.

So the line moved from *"no `schemas/`, no `scripts/`"* to **"no reference implementation"**. The test a moved precedent
must pass is whether moving it increases what git can adjudicate later. It does, by two questions the original line could
not ask: *was the golden digest computed before an implementation existed with an interest in the answer?* and *did the
member manifest ever lag a schema?*

**Where the precedent binds unchanged and did not move an inch:** the harness in `scripts/` does not import project code
and never may. `prove_etag_golden.sh` canonicalises with the third-party `canonicalize` package and digests with
`node:crypto`; the ~30-line projector it drives lives in `scripts/lib/project.mjs` and is not any implementation's
projector. That separation is what makes *"two independent implementations produce byte-identical JCS bytes"* a fact
rather than an assertion.

---

## Three findings against the specification, all fixed in this commit

The most valuable possible outcome of this session was named in advance: `prove_spec_examples.sh` exiting `1`. It did,
on its first run, and two further incoherences surfaced while building the fixtures. All three were bugs that nobody
previously had a mechanism to see.

### Finding 1 — the worked example printed a Hold that failed the spec's own Hold schema

**Severity: blocking.** `SPEC.md` §9's `201 Created` response omitted `occasion_etag`. §2.6 lists it as REQUIRED, and
`hold.schema.json` requires it.

```
FAIL — SPEC.md:697 (http HTTP/1.1 201) validates against hold:0.1: data must have required property 'occasion_etag'
```

**Found by** `scripts/prove_spec_examples.sh`, first run, before any implementation existed.
**Fixed** by adding `occasion_etag` to the printed response, with the correction noted in §9.

This is the finding that justifies the script. A worked example is the part of a specification most people read and least
often check, and an implementer copying that response would have shipped a Hold that fails validation at the boundary it
was copied from.

### Finding 2 — §2.4 contradicted §2.2 about whether the work's title is projected

**Severity: serious.** §2.4 said *every* `prose` value is excluded from `PROJECTION_0_1`. §2.2's ✓ column projects
`work.title.value`, which is a `prose` value. Two conforming implementations reading different sections would compute
different digests for the same Occasion — the precise failure `C-ETAG` exists to detect, written into the specification
itself.

**Found by** building the projection pointer list against the §2.2 table.
**Resolved** in favour of §2.2, which §2.4 itself names as the authority (*"the closed list marked ✓ in §2.2"*). The
title **is** projected: it is the assertion about *which film*, and a silent swap of the work must move the etag. §2.4
now states the exception explicitly, and `schemas/projection-0-1.json` records it.

### Finding 3 — the worked example's substitution edges violated the spec's own origin rule

**Severity: serious.** §9 presented "Embassy" and "Multiplex" as two venues with substitution edges between them. **E1**
requires every edge target to be an Occasion published at the same `venue.origin`, and **E3** scopes `cluster` to
`(venue.origin, cluster)`. As printed, the example's entire antichain argument rested on a cross-origin edge that a
conforming Server **MUST** reject at publish.

**Found by** authoring the golden fixtures, where the origins had to be written down.
**Fixed** by publishing all three Occasions at one origin — one operator running an archival house and a multiplex, the
ordinary shape of a small circuit — and by stating the consequence §9 had left implicit: **cross-exhibitor substitution
is out of scope in v0.1.**

### Two pre-flight decisions, settled before any digest was frozen

Both sit inside `PROJECTION_0_1` and therefore inside the etag, so deciding them afterwards would have meant recomputing
every digest — the exact mistake this increment exists to make impossible.

1. **Fixture hostnames.** §9 used `example.nz`, which is a **registrable** second-level domain under `.nz` and is not
   reserved. RFC 6761 reserves `.example`, `.test`, `.invalid`, `.localhost` and `example.com`/`.net`/`.org`. Fixtures
   and §9 now use `embassy.example` and `tickets.embassy.example`.
2. **The printed etags did not reproduce.** §9's three digests were unverified, and (1) guaranteed at least one would
   move. **The fixture is authoritative**, because the fixture is the thing a second implementation can be pointed at.
   §9 was corrected to the computed values in this commit.

---

## The digests, and why they are frozen now

`C-ETAG` asks two independent implementations to agree on a **pinned** golden fixture. A fixture authored after the first
implementation is a fixture fitted to that implementation, and the class then proves only that a program agrees with
itself.

| Fixture | etag |
|---|---|
| `occasion-embassy-sat-1900.json` | `1:XB7PZvK6GJP0BY4IPzKdmuCc-R5RaivznwPz_KDY-04` |
| `occasion-multiplex-sat-2100.json` | `1:ktjR8_5bWWg_lejnE6BqPSaNzXSyCzYynsci_O9_Qr4` |
| `occasion-multiplex-sun-1400.json` | `1:9MokuOSTWVJ-_t1IMbm7cfT61VjN3kfb3yDZtK6UJJ4` |

Intermediate JCS byte hashes, canonicaliser version and Node version are in
[`fixtures/golden/EXPECTED.md`](../fixtures/golden/EXPECTED.md), because two implementations that disagree need to know
**where** they diverged.

This root commit is the single property of the project that cannot be back-filled at any price.

---

## Captured output

Recorded from a clean run of `bash scripts/run_proofs.sh` against this commit's tree. The capture is embedded by amending the same commit, so the file list `prove_spec_first.sh` asserts is byte-identical to the one that produced this output; only this document differs.

```
ok   — prove_spec_first         3 checks
         ok — root commit contains no path under src/, packages/*/src/, adapters/, corpus/, migrations/ or evals/
         ok — root commit contains no .ts and no .sql file
         ok — root commit contains SPEC.md and DECISIONS.md
         PASS=3
ok   — prove_spec_examples      10 checks
         ok — fixtures/golden/occasion-embassy-sat-1900.json validates against occasion:0.1
         ok — fixtures/golden/occasion-multiplex-sat-2100.json validates against occasion:0.1
         ok — fixtures/golden/occasion-multiplex-sun-1400.json validates against occasion:0.1
         ok — fixtures/prose-edit/occasion-embassy-sat-1900.json validates against occasion:0.1
         ok — SPEC.md:697 (http POST /changeover/v0/holds) hold_seats request honours the cross-binding constraints
         ok — SPEC.md:697 (http HTTP/1.1 201) validates against hold:0.1
         ok — SPEC.md:723 (jsonc) validates against refusal:0.1
         ok — SPEC.md:741 (jsonc) validates against hold:0.1 (fragment, required lifted)
         ok — 4 instance payload(s) validated, 2 illustrative schema sketch(es) skipped by design
         ok — all 28 PROJECTION_0_1 pointers resolve against occasion:0.1
         PASS=10
ok   — prove_etag_golden        6 checks
         ok — 3/3 digests reproduce and agree across fixture, EXPECTED.md and SPEC.md
         ok — C-ETAG.2: a prose-only edit does not move the digest
         ok — C-ETAG.3: a moved start time does move the digest
         ok — C-ETAG.4: a changed price does move the digest
         ok — C-ETAG.5: a withdrawn non-substitutability assertion does move the digest
         ok — C-ETAG.6: a re-observation and a revision bump do not move the digest
         PASS=6
ok   — prove_member_manifest    3 checks
         ok — 0 unmanifested members (177 declared across 8 schemas)
         ok — 0 orphan manifest entries
         ok — declared count 177 matches the list length
         PASS=3
ok   — prove_no_settlement_verb 3 checks
         ok — verbs.json declares exactly 5 verbs
         ok — 0 verbs match /settle|pay|capture|refund|charge/
         ok — 0 of 177 manifested members match the settlement pattern
         PASS=3

PASS=5  FAIL=0  UNPROVABLE=0
```

**On exit 2.** Each proof exits `0` (holds), `1` (fails) or `2` (**cannot prove**). Before this commit existed,
`prove_spec_first.sh` returned `2` — *"cannot prove — no commits yet"* — and `run_proofs.sh` reported it as `skip`,
never as a pass. The distinction between *"your server violated the floor"* and *"we could not reach your server"* is
load-bearing throughout `SPEC.md` §7, and a suite that blurred it here would have no standing to demand it there.

---

## What is deliberately absent, said out loud

No store, no migrations, no locks, no HTTP, no MCP, no adapter, no demo, no corpus entries, no probe, no conformance
runner, no repository on GitHub, no npm publish, no domain purchase, no post anywhere. **The npm name `changeover`
returned `E404` on 2026-08-25 and the domain is unverified;** both gate public use and neither is claimed here.

*Independent work. Not affiliated with, endorsed by, or officially connected to any cinema platform vendor.*
