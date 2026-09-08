# Conformance reports

A dated series. Each entry is one run of `changeover conform` against one implementation, validating against [`schemas/report.schema.json`](../schemas/report.schema.json).

```
reports/<spec_version>/<register_version>/<run_at>.json
```

The directory **is** V8's key. A spec change makes a new directory beside the old one, which is what *"a spec change does not invalidate an old report; it makes it an old report"* looks like on a disk.

## Reports are never restated

A later run is a **new report**. The writer refuses twice, and neither refusal has a `--force`:

- the target path must not already exist, and
- no report already in the series may carry this `(spec_version, register_version, run_at)`.

The first alone is defeated by writing to a new filename; the second alone is defeated by writing a *different* triple over a file that already holds one. Together there is no overwrite.

That is not bookkeeping. An overwritable report is a report somebody will quietly improve after a bad run, and once one entry in a series can be silently revised, no entry in it can be trusted. The trust is the whole asset: real observed floors and release latencies at exhibitor boundaries are numbers nobody in this industry publishes, and a series beginning in 2026 cannot be bought in 2028 at any price. It survives only if the early entries are honest — including, and especially, when the numbers come back bad.

## Three outcomes, never two

Every class is `pass`, `fail`, or **`unprovable`**, and the process exits `0`, `1`, or `2` to match. `unprovable` is the difference between *your server violated the floor* and *we could not reach your server*, and it is first-class in three places at once — a value in the schema's per-class enum, a named count in the summary line, and its own exit code. A runner that folded it into either neighbour would destroy the only property that makes these reports worth publishing, and the likelier direction is `pass`, because that is the one that produces a green badge.

The same discipline applies to the numbers. Each measurement carries a `basis`:

- `observed` — it was measured, and `value` is what came back.
- `not_measured` — `value` is `null` and `note` says why.

Never `0`. A zero meaning *we did not look* and a zero meaning *we looked and there were none* are the same byte, and only the second is a finding.

## Reading an entry

| Member | What it is |
|---|---|
| `classes[]` | One row per §7 class, carrying §7's own words, the clauses that ran, and a `reason` on anything that did not pass |
| `floor_violations` | Holds that stopped holding inside their own floor with no `revocation_reason` |
| `operator_overrides` | The same event **with** one — counted separately, because an honest exhibitor withdrawing seats must not read as non-conforming |
| `release_latency_ms` | Release → the same seats granted to a *different* principal, with the `substrate` attached so an in-process number cannot read as one off a real boundary |
| `oversell_events` | Physical seats carrying more than one occupying row. The number this whole protocol exists to keep at zero |
| `harness` | The commit that measured it, and whether that tree was clean. A number without the code that produced it is an anecdote |
| `binding_coverage` | Whether any class actually drove each requested binding. A report may not claim conformance over a transport it never spoke |

## Producing one

```bash
changeover conform --profile 1 --bindings http,in_process --reports-dir reports
```

Under PGlite — the default, and what CI runs — the concurrency classes come back `unprovable` and say so, because PGlite is single-connection and in-process. Set `CHANGEOVER_PG_URL` to a real multi-connection Postgres and C-ATOMIC, C-BUDGET, C-FANOUT and C-ORPHAN become genuine passes rather than gaps:

```bash
docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=changeover -e POSTGRES_DB=changeover postgres:18
export CHANGEOVER_PG_URL=postgres://postgres:changeover@localhost:5433/changeover
```

The gate on the runner itself is `scripts/prove_conform_report.sh`.
