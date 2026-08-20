# @sntxrr/prometheus-pushgateway

Push metrics from a scheduled swamp method into a Prometheus Pushgateway.

## Why

Scheduled swamp jobs are exactly the shape Pushgateway exists for: a batch that
runs, computes some numbers, and exits long before any scrape could reach it.

Rather than every model growing its own HTTP code, this takes a flat
`{name, value, labels}` series — the shape several models already emit alongside
their verdicts — and forwards it.

## Usage

```bash
swamp model create @sntxrr/prometheus/pushgateway metrics-sink
swamp model @sntxrr/prometheus/pushgateway method run push metrics-sink \
  --input-file series.json
```

```yaml
globalArguments:
  url: http://192.0.2.10:9091
  job: my-batch-job
```

Wired to another model's output in a workflow, which is the intended shape:

```yaml
- name: push-metrics
  type: model_method
  model: metrics-sink
  method: push
  arguments:
    job: fabric-health
    metrics: ${{ data.latest('fabric-check', 'fabric').attributes.metrics }}
```

## Replace, don't accumulate

`push` defaults to **PUT**, which replaces every series in the grouping key.
That is almost always what a state snapshot wants: if a device drops out of a
declaration, its series should disappear rather than linger at its last value
forever.

`POST` (`replace: false`) only replaces series of the same name within the
group, so a removed series persists indefinitely and keeps being scraped as
though it were current. Use it only when several independent writers share one
grouping key.

## Pushed metrics go stale silently

This is the trap worth understanding before you rely on this.

Pushgateway holds whatever it was last given, **forever**, and serves it to
every scrape. If the job that pushes stops running — crashed, unscheduled,
credential expired — the metrics do not disappear and do not go stale in any way
Prometheus notices. They sit there reporting the last known-good value, and
every dashboard stays green while nothing is actually being checked.

So this model can convert a loud failure (job stopped) into a silent one
(dashboard frozen) unless you alert on push age. Pushgateway adds
`push_time_seconds` to every group automatically:

```yaml
- alert: PushedMetricsStale
  expr: time() - push_time_seconds{job="fabric-health"} > 3600
  for: 15m
  annotations:
    summary: "fabric-health has not pushed in over an hour"
```

`push` also emits `swamp_push_heartbeat_total` by default if you would rather
key off the series itself:

```yaml
- alert: FabricCheckNotRunning
  expr: increase(swamp_push_heartbeat_total{job="fabric-health"}[2h]) == 0
```

Set `heartbeat: false` to suppress it.

## Validation before sending

Metric names, label names and values are checked before the request goes out:

| Rejected | Why |
| --- | --- |
| Metric name not matching `[a-zA-Z_:][a-zA-Z0-9_:]*` | Pushgateway answers 400 without naming the offending series |
| Label name not matching `[a-zA-Z_][a-zA-Z0-9_]*` | same |
| `NaN` / `Infinity` | a single non-finite value makes Pushgateway discard the **entire** batch, silently losing every other series with it |

Label values are escaped for quotes, backslashes and newlines. The body always
ends with a trailing newline, which is mandatory — without it Pushgateway
reports a "text format parsing error" that reads like a bug in your series
rather than a missing final byte.

## Grouping keys

The path is `/metrics/job/<job>{/<label>/<value>}`. Two cases need the
Pushgateway base64 escape, and both are handled rather than rejected:

- a value containing `/`, which cannot be expressed in a path segment
- an empty value, which would collapse the segment and silently shift every
  later label onto the wrong value
