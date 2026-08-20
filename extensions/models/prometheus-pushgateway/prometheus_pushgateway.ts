/**
 * Push metrics from a scheduled swamp method into a Prometheus Pushgateway.
 *
 * Scheduled swamp jobs produce exactly the shape Pushgateway exists for: a
 * batch that runs, computes some numbers, and exits before any scrape could
 * reach it. Rather than each model growing its own HTTP code, this model takes
 * a flat `{name, value, labels}` series — the shape several models already emit
 * alongside their verdicts — and forwards it.
 *
 * ## Replace, don't accumulate
 *
 * The default method is `PUT`, which replaces **every** metric in the grouping
 * key. That is almost always what a state snapshot wants: if a device drops out
 * of a declaration, its series should disappear rather than linger at its last
 * value forever. `POST` only replaces series of the same name within the group,
 * so a removed series would persist indefinitely and keep being scraped as
 * though it were current. Set `replace: false` only when several independent
 * writers share one grouping key.
 *
 * ## Pushed metrics go stale silently
 *
 * This is the trap that matters. Pushgateway holds whatever it was last given,
 * forever, and keeps serving it to every scrape. If the job that pushes stops
 * running — crashed, unscheduled, credential expired — the metrics do not
 * disappear and do not go stale in any way Prometheus notices. They simply sit
 * there reporting the last known-good value, and every dashboard stays green
 * while nothing is actually being checked.
 *
 * Alert on the age of the push, not only on its values. Pushgateway adds
 * `push_time_seconds` to every group automatically:
 *
 * ```yaml
 * - alert: PushedMetricsStale
 *   expr: time() - push_time_seconds{job="unifi-fabric"} > 3600
 *   for: 15m
 * ```
 *
 * Without that rule, this model converts a loud failure (job stopped) into a
 * silent one (dashboard frozen). See also the `heartbeat` argument, which emits
 * a run counter you can alert on with `increase()` if you would rather key off
 * the series itself.
 *
 * @module
 */

import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  url: z.string().describe(
    "Pushgateway base URL, e.g. http://192.0.2.10:9091 (no trailing path).",
  ),
  job: z.string().describe(
    "Default `job` label for the grouping key. Overridable per push.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const MetricSchema = z.object({
  name: z.string().describe(
    "Metric name. Must match [a-zA-Z_:][a-zA-Z0-9_:]* .",
  ),
  value: z.number().describe("Sample value."),
  labels: z.record(z.string(), z.string()).default({}).describe(
    "Label set. Names must match [a-zA-Z_][a-zA-Z0-9_]* .",
  ),
  help: z.string().optional().describe(
    "HELP text. The first help seen for a name wins.",
  ),
  type: z.enum(["gauge", "counter", "untyped"]).optional().describe(
    "TYPE, defaulting to gauge.",
  ),
});

const PushResultSchema = z.object({
  pushedAt: z.string(),
  url: z.string().describe("Full grouping-key URL written to."),
  job: z.string(),
  seriesCount: z.number(),
  replaced: z.boolean().describe("True when PUT was used."),
  status: z.number().describe("HTTP status returned by the Pushgateway."),
  bytes: z.number().describe("Size of the exposition body sent."),
});

type Metric = z.infer<typeof MetricSchema>;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Escape a label value per the text exposition format. */
export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Render a flat metric list as Prometheus text exposition format.
 *
 * Pure and exported so the whole formatting surface — escaping, name
 * validation, HELP/TYPE emission, the mandatory trailing newline — is testable
 * without a Pushgateway.
 *
 * Throws on an invalid metric or label name rather than sending it: the
 * Pushgateway answers 400 with a body that does not say which series was at
 * fault, which is a genuinely unpleasant thing to debug from a scheduled job.
 */
export function formatExposition(metrics: Metric[]): string {
  const lines: string[] = [];
  const declared = new Set<string>();

  for (const m of metrics) {
    if (!METRIC_NAME.test(m.name)) {
      throw new Error(
        `invalid metric name ${
          JSON.stringify(m.name)
        } — must match ${METRIC_NAME}`,
      );
    }
    if (!Number.isFinite(m.value)) {
      throw new Error(
        `metric ${m.name} has non-finite value ${m.value}; Pushgateway rejects the batch`,
      );
    }
    if (!declared.has(m.name)) {
      if (m.help) lines.push(`# HELP ${m.name} ${m.help.replace(/\n/g, " ")}`);
      lines.push(`# TYPE ${m.name} ${m.type ?? "gauge"}`);
      declared.add(m.name);
    }
    const labels = Object.entries(m.labels ?? {});
    for (const [k] of labels) {
      if (!LABEL_NAME.test(k)) {
        throw new Error(
          `invalid label name ${
            JSON.stringify(k)
          } on ${m.name} — must match ${LABEL_NAME}`,
        );
      }
    }
    const rendered = labels.length
      ? `{${labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",")}}`
      : "";
    lines.push(`${m.name}${rendered} ${m.value}`);
  }

  // The trailing newline is mandatory. Pushgateway rejects a body without one
  // as "text format parsing error", which reads like a formatting bug in the
  // series rather than a missing final byte.
  return lines.join("\n") + "\n";
}

/**
 * Build the grouping-key path: /metrics/job/<job>{/<label>/<value>}.
 *
 * A value containing a slash cannot be expressed in a path segment, so
 * Pushgateway defines a base64 escape hatch: `<label>@base64/<encoded>`. Values
 * needing it are encoded rather than rejected, because a label like a filesystem
 * path is a reasonable grouping key and silently corrupting it would be worse.
 */
export function groupingPath(
  job: string,
  grouping: Record<string, string> = {},
): string {
  const seg = (label: string, value: string): string => {
    if (value.includes("/")) {
      // URL-safe base64, unpadded, as Pushgateway expects.
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(value)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return `${encodeURIComponent(label)}@base64/${b64}`;
    }
    // An empty value also needs the base64 form: an empty path segment would
    // collapse and shift every later segment.
    if (value === "") return `${encodeURIComponent(label)}@base64/=`;
    return `${encodeURIComponent(label)}/${encodeURIComponent(value)}`;
  };

  const parts = ["metrics", seg("job", job)];
  for (const [k, v] of Object.entries(grouping)) {
    // `job` comes from its own argument; a duplicate here would emit the
    // segment twice and Pushgateway would treat the second as a normal label.
    if (k === "job") continue;
    parts.push(seg(k, v));
  }
  return "/" + parts.join("/");
}

interface Context {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<unknown>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
}

/**
 * The `@sntxrr/prometheus/pushgateway` model.
 *
 * Exposes a single `push` method that renders a flat metric series as text
 * exposition format and writes it to a Pushgateway grouping key.
 */
export const model = {
  type: "@sntxrr/prometheus/pushgateway",
  version: "2026.08.20.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    push_result: {
      description: "Outcome of one push to a Pushgateway grouping key.",
      schema: PushResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    push: {
      description:
        "Render a flat metric series as Prometheus text exposition format and write it to a Pushgateway grouping key. Defaults to PUT, which replaces every series in the group so removed series disappear rather than lingering at their last value.",
      arguments: z.object({
        metrics: z.array(MetricSchema).describe(
          "The series to push. Typically taken straight from another model's " +
            "`metrics` output via a CEL expression.",
        ),
        job: z.string().optional().describe(
          "Override the model's default `job` label.",
        ),
        grouping: z.record(z.string(), z.string()).default({}).describe(
          "Extra grouping-key labels beyond `job`, e.g. {instance: 'site-a'}.",
        ),
        replace: z.boolean().default(true).describe(
          "PUT (replace the whole group) when true; POST when false. Leave " +
            "true for state snapshots so removed series vanish.",
        ),
        heartbeat: z.boolean().default(true).describe(
          "Also emit `swamp_push_heartbeat_total`, so staleness can be alerted " +
            "on with increase() as well as via push_time_seconds.",
        ),
      }),
      execute: async (
        args: {
          metrics: Metric[];
          job?: string;
          grouping: Record<string, string>;
          replace: boolean;
          heartbeat: boolean;
        },
        context: Context,
      ): Promise<{ dataHandles: unknown[] }> => {
        const job = args.job ?? context.globalArgs.job;
        const series = [...args.metrics];
        if (args.heartbeat) {
          series.push({
            name: "swamp_push_heartbeat_total",
            value: 1,
            labels: {},
            help:
              "Incremented each time this job pushed. Alert on increase() == 0 to catch a job that stopped running.",
            type: "counter",
          });
        }

        const body = formatExposition(series);
        const base = context.globalArgs.url.replace(/\/+$/, "");
        const url = base + groupingPath(job, args.grouping);

        context.logger.info(
          "Pushing {n} series to {url} ({method})",
          { n: series.length, url, method: args.replace ? "PUT" : "POST" },
        );

        const res = await fetch(url, {
          method: args.replace ? "PUT" : "POST",
          headers: { "Content-Type": "text/plain; version=0.0.4" },
          body,
        });
        // Drain the body so the connection can be reused and Deno does not warn
        // about a leaked resource in a short-lived method process.
        const text = await res.text();

        if (!res.ok) {
          throw new Error(
            `Pushgateway returned ${res.status}: ${text.slice(0, 300)}`,
          );
        }
        context.logger.info("Pushed {n} series to job {job}", {
          n: series.length,
          job,
        });

        const handle = await context.writeResource(
          "push_result",
          "push_result",
          {
            pushedAt: new Date().toISOString(),
            url,
            job,
            seriesCount: series.length,
            replaced: args.replace,
            status: res.status,
            bytes: new TextEncoder().encode(body).length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
