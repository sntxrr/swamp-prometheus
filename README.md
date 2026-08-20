# swamp-prometheus

A [swamp](https://swamp-club.com) extension repo for **Prometheus**, using only
Deno's built-in `fetch` — no vendor SDK.

## Extensions

### [`@sntxrr/prometheus-pushgateway`](./extensions/models/prometheus-pushgateway/README.md)

Push metrics from a scheduled swamp method into a Prometheus Pushgateway.

| Method | Writes? | What it does                                                       |
| ------ | ------- | ------------------------------------------------------------------ |
| `push` | **yes** | Render a flat metric series as text exposition and write it to a grouping key |

Scheduled swamp jobs are exactly the shape Pushgateway exists for: a batch that
runs, computes some numbers, and exits long before any scrape could reach it.
Rather than every model growing its own HTTP code, `push` takes a flat
`{name, value, labels}` series — the shape several models already emit alongside
their verdicts — and forwards it.

Full usage, arguments and alerting guidance are in the
[extension README](./extensions/models/prometheus-pushgateway/README.md).

## Design premise

**Pushed metrics go stale silently, so this repo treats liveness as part of the
contract rather than an afterthought.**

Pushgateway holds whatever it was last given, forever, and serves it to every
scrape. If the job that pushes stops running — crashed, unscheduled, credential
expired — the metrics do not disappear and do not go stale in any way Prometheus
notices. They sit there reporting the last known-good value while every
dashboard stays green and nothing is actually being checked.

That turns a loud failure (job stopped) into a silent one (dashboard frozen),
which is strictly worse than having no dashboard at all. So:

- `push` emits `swamp_push_heartbeat_total` by default, alertable with
  `increase(...) == 0`.
- The extension README leads with the `push_time_seconds` staleness rule rather
  than burying it in a footnote.
- Every usage example pairs the metric with its liveness alert.

Two further decisions follow from the same posture:

- **PUT by default.** Replacing the whole grouping key means a series that
  disappears from the source disappears from the gateway. `POST` only replaces
  same-named series, so a removed one lingers at its last value forever and
  keeps being scraped as though it were current.
- **Validate before sending.** Metric names, label names and non-finite values
  are rejected locally, because Pushgateway answers `400` without naming the
  offending series — and a single `NaN` makes it discard the entire batch,
  silently losing every other metric with it.

## Quick start

```bash
swamp model create @sntxrr/prometheus/pushgateway metrics-sink
```

```yaml
globalArguments:
  url: http://192.0.2.10:9091
  job: my-batch-job
```

```bash
swamp model @sntxrr/prometheus/pushgateway method run push metrics-sink \
  --input-file series.json
```

The intended shape is wiring it to another model's output in a workflow, so the
producing model never needs to know Prometheus exists:

```yaml
- name: push-metrics
  type: model_method
  model: metrics-sink
  method: push
  arguments:
    job: fabric-health
    metrics: ${{ data.latest('fabric-check', 'fabric').attributes.metrics }}
```

Then close the loop in Prometheus, without which none of the above can be
trusted:

```yaml
- alert: PushedMetricsStale
  expr: time() - push_time_seconds{job="fabric-health"} > 3600
  for: 15m
```

## Development

```bash
~/.swamp/deno/deno test extensions/models/prometheus-pushgateway/
swamp extension quality extensions/models/prometheus-pushgateway/manifest.yaml --json
```

Site-specific files (`models/`, `vaults/`, `grants/`, `.swamp.yaml`) are
gitignored — this repo is public and holds only the publishable extension.

## Licence

MIT. See [LICENSE.md](./extensions/models/prometheus-pushgateway/LICENSE.md).
