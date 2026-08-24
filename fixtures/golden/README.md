# Golden fixtures

Three Occasions and one delegation record. They exist so that `C-ETAG` — *two independent implementations produce
byte-identical JCS bytes and digest for a pinned golden fixture* — is a fact rather than an assertion.

| File | What it is | What it is for |
|---|---|---|
| `occasion-embassy-sat-1900.json` | 35mm archival print, final run, allocated seating, NZD 26.00 fees and tax included | The Occasion nothing substitutes for. Its `not_substitutable_for` edges are the thesis in data. |
| `occasion-multiplex-sat-2100.json` | DCP, same night, NZD 14.00 | Attests `⪯ embassy1900`, so it is **dominated and dropped** from the antichain — the cheaper option removed by the Publisher's own attestation. |
| `occasion-multiplex-sun-1400.json` | DCP matinee, open captions, NZD 12.00 | **Incomparable**: a different night, no attested edge. Survives the antichain with `open_captions: yes` as its distinguishing axis. |
| `delegation.json` | Apex record naming `tickets.embassy.example` | O1. Delegation is the only origin-authority mechanism in v0.1; signing was removed rather than half-specified. |

All three publish at **one** `venue.origin` — `https://embassy.example` — because **E1** requires every substitution
edge to target an Occasion at the same origin and **E3** scopes `cluster` to `(venue.origin, cluster)`. One operator
running an archival house and a multiplex is the ordinary shape of a small circuit. Cross-exhibitor substitution is out
of scope in v0.1.

Hostnames use `.example`, reserved by **RFC 6761**. `example.nz` — which an earlier draft of §9 used — is a registrable
second-level domain under `.nz` and is *not* reserved.

## What may never change

The **projected** members. Every digest in `EXPECTED.md` is computed over them, and moving one invalidates every
conformance report that cited it (V8).

## What must be free to change

Everything outside `PROJECTION_0_1`. `../prose-edit/occasion-embassy-sat-1900.json` is this fixture with exactly one
prose value altered — *"vaults"* to *"vault"* — and it **must** digest identically. That is `C-ETAG.2`, and it is the
property that lets a Publisher fix a typo without invalidating every in-flight resolution across an estate.

`prove_etag_golden.sh` asserts both directions: the prose edit does not move the digest; a moved start time, a changed
price, and a withdrawn non-substitutability assertion each do.
