# EXPECTED — the frozen digests

**Frozen** 2026-08-25, in the root commit of this repository, **before any CHANGEOVER implementation existed.**

`C-ETAG` asks two independent implementations to agree on a pinned golden fixture. A fixture authored *after* the first
implementation is a fixture fitted to that implementation, and the class then proves only that a program agrees with
itself. These three digests were computed by a third-party RFC 8785 canonicaliser and `node:crypto`, driven by the
~30-line harness projector in [`scripts/lib/project.mjs`](../../scripts/lib/project.mjs) — which no CHANGEOVER
implementation may ever import. They are a target the reference implementation cannot argue with, and neither can
anyone else's.

```
etag = "1:" || base64url_unpadded( SHA-256( JCS( project(occasion, PROJECTION_0_1) ) ) )
```

## The digests

### `occasion-embassy-sat-1900.json`

| | |
|---|---|
| `occasion_id` | `occ_embassy_20260829T1900_s1` |
| **etag** | `1:XB7PZvK6GJP0BY4IPzKdmuCc-R5RaivznwPz_KDY-04` |
| SHA-256 of the JCS bytes | `5c1ecf66f2ba1893f4058e083f329d9ae09cf91e516a2bf39f03f3fca0d8fb4e` |
| SHA-256 of `JSON.stringify(projected)` | `34be5e0dd03a1cca2887424a765cc24cdbfdfb9fe2adf5590da8d217cc02cd78` |
| JCS byte length | 2149 |

### `occasion-multiplex-sat-2100.json`

| | |
|---|---|
| `occasion_id` | `occ_multiplex_20260829T2100_s4` |
| **etag** | `1:ktjR8_5bWWg_lejnE6BqPSaNzXSyCzYynsci_O9_Qr4` |
| SHA-256 of the JCS bytes | `92d8d1f3fe5b59683f95e8e713a06a3d268dcd74b20b36329ec722fcef7f42be` |
| SHA-256 of `JSON.stringify(projected)` | `1d3891b03e089cc9e800d86669637af4d498eb9e25b5a595a27ece6c9575cdb5` |
| JCS byte length | 1756 |

### `occasion-multiplex-sun-1400.json`

| | |
|---|---|
| `occasion_id` | `occ_multiplex_20260830T1400_s4` |
| **etag** | `1:9MokuOSTWVJ-_t1IMbm7cfT61VjN3kfb3yDZtK6UJJ4` |
| SHA-256 of the JCS bytes | `f4ca24b8e49359527efedd4831b9bb71f4fad558cdde47dbdf20d9b4ae94249e` |
| SHA-256 of `JSON.stringify(projected)` | `d33ec7273775333187d5f88c3ad01b75b1f0f7f1f091ebb5a8053d7c3feda5a4` |
| JCS byte length | 1706 |

## Why the intermediate hashes are here

Two implementations that disagree need to know **where** they diverged, and *"the etag differs"* does not tell them.
If the JCS SHA-256 matches and the etag does not, the digest step is wrong. If the JCS SHA-256 differs but the
`JSON.stringify` SHA-256 matches, the canonicaliser is wrong — most likely on key ordering or number formatting.
If both differ, the projection is wrong, and the pointer list in
[`schemas/projection-0-1.json`](../../schemas/projection-0-1.json) is the authority.

## Reproduce

```bash
npm install
bash scripts/prove_etag_golden.sh
```

| | |
|---|---|
| Canonicaliser | `canonicalize` 2.1.0 (RFC 8785) |
| Digest | `node:crypto` SHA-256, `base64url` (unpadded) |
| Node | v24.13.1 |
| Projector | `scripts/lib/project.mjs` — harness only, never imported by an implementation |
| Projection | `PROJECTION_0_1`, 28 JSON Pointers, closed |

## What may never change

These files are **pinned**. A change to any projected member of any of them invalidates every conformance report that
cited these digests, and is a **major** version event under V8. A change to a member *outside* the projection — a
programme note, an availability count, a `revision` bump — must leave every digest here byte-identical, and
`prove_etag_golden.sh` asserts exactly that against
[`../prose-edit/`](../prose-edit/occasion-embassy-sat-1900.json).

*Reports are never restated. A later run is a new report.*
