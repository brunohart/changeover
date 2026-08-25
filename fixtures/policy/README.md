# Policy fixtures

Two `changeover.policy.yaml` documents and the corpus one of them fails against.

| File | What it is | What it is for |
|---|---|---|
| `arthouse.yaml` | A whole small exhibitor's non-substitutability policy: eight rules, no `occasion_id` anywhere in it | Deriving it over `../golden/` reproduces the three frozen edge sets **byte for byte**, so the three frozen etags do not move |
| `cross-origin/policy.yaml` | One rule, authored across two origins by accident | `changeover lint` exits **1** on it, naming `E1_CROSS_ORIGIN` |
| `cross-origin/corpus/*.json` | Two Occasions, one cluster string, two `venue.origin` values | The realistic shape of the E1 mistake: a circuit whose ticketing sits on a second hostname |

```bash
changeover lint   --policy fixtures/policy/arthouse.yaml --corpus fixtures/golden           # 0
changeover lint   --policy fixtures/policy/cross-origin/policy.yaml \
                  --corpus fixtures/policy/cross-origin/corpus                              # 1
changeover derive --policy fixtures/policy/arthouse.yaml --corpus fixtures/golden --out /tmp/out
bash scripts/prove_policy_derive.sh
bash scripts/prove_policy_lint.sh
```

## How eight rules become an edge set

`SPEC.md` §2.3 fixes the authoring form and leaves the expansion to the Server. These are the decisions this
implementation makes, all of them visible in `changeover lint --explain` and all of them pinned by
`scripts/prove_policy_derive.sh`.

**D1 · A rule is a directed statement between two class expressions.**
`not_substitutable_for(S, O)` ranks `S` above `O` on an axis, and a ranking has two faces: for `a ∈ S` and `b ∈ O` it
publishes the refusal on `a` **and the converse permission on `b`**. That is the specification's own sentence — *"a
70mm print at seven is an acceptable substitute for a DCP at nine; the DCP is not an acceptable substitute for the
70mm"* — as one authored claim, and it is what lets §2.3 say of the dominated cheaper screening that *"the remedy is
not to attest the edge."* `accepts_substitute(S, O)` is a grant rather than a ranking: it publishes one direction and
says nothing about the reverse, so mutual substitutability stays authorable and no refusal is ever manufactured.

**D2 · The effective window is evaluated against the Occasion the edge is published on**, by `instant.local_wall`'s
calendar date — never UTC. `r-35mm-carrier` runs `2026-08-01 .. 2026-08-29` because the print goes back to the vault
after the Saturday night show (`occ:final-run`). That is exactly why the Sunday matinee is *incomparable — a different
night, no attested edge* (§9), while the Saturday DCP is dominated and dropped.

**D3 · `derived_from.rule_ids` names every rule that produced an edge incident on this Occasion** — outbound, inbound,
or contributing a transitive hop published here. All three golden Occasions cite `["r-35mm-carrier"]`, including the
Sunday matinee whose edge set is empty: an empty edge set that names a rule is saying something true and useful, which
is that the policy was evaluated and the answer was no edge. The other seven rules are cited by nobody, because they
touched nobody.

**D4 · The wire `axis` derives from the author's own `reason_code`** — `carrier`/`format`/`language` →
`presentation_class`, `occasion` → `occasion_class`, `accessibility` → `accessibility`, `room` → `auditorium`,
`time` → `instant`. One vocabulary, no second one to keep in step.

**D5 · Only permissions compose.** Refusals do not: `¬(a ⪯ b)` and `¬(b ⪯ c)` say nothing whatever about `(a, c)`. A
derived permission carries the union of the axes crossed and the rules used over every walk joining the pair, so a
two-axis derivation surfaces as two entries — an Agent must present the distinguishing axes, and one of them is not
enough.

**D6 · A permission the Publisher explicitly refused is never published**, whether authored directly or implied by
transitivity. The refusal stands, the contradiction is an error, and `changeover derive` exits non-zero so the policy
is fixed rather than shipped.

**D7 · No edge crosses an origin.** E1 and E3 are enforced at derivation, not at review: a candidate at another origin
is refused and reported. `changeover derive` cannot emit one.

**D8 · A rule naming an `x-` extension class is refused.** An `x-` class is incomparable to every registered class and
to every other `x-` class; a rule over one would establish domination, which is the mechanism by which a Publisher
would move real semantics into `x-` ids and leave the antichain treating a blocking distinction as noise.

## What may never change

`arthouse.yaml` is pinned as tightly as `../golden/` is. `substitution` is inside `PROJECTION_0_1`, so a change to
`r-35mm-carrier` — its classes, its `reason_code`, its `detail` prose, its effective window — moves a derived edge set,
and a moved edge set moves a frozen etag. `scripts/prove_policy_derive.sh` fails on the byte comparison and again on
the digest. If a change moves one of them, the change is wrong, not the fixture.

The other seven rules are free in one specific sense: they may be edited as long as they stay **inert over
`../golden/`**. Any rule that produces an edge incident on one of those three Occasions adds its `rule_id` to that
Occasion's `derived_from`, and the frozen provenance is `["r-35mm-carrier"]` exactly.
