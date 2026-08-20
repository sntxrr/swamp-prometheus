import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  escapeLabelValue,
  formatExposition,
  groupingPath,
} from "./prometheus_pushgateway.ts";

/**
 * The formatting surface is where this model can fail silently or produce a 400
 * whose body does not say which series was at fault, so it is covered
 * exhaustively here rather than discovered from a scheduled job's logs.
 */

Deno.test("renders TYPE once per metric name, then samples", () => {
  const out = formatExposition([
    { name: "up", value: 1, labels: { host: "a" } },
    { name: "up", value: 0, labels: { host: "b" } },
  ]);
  assertEquals(out, [
    "# TYPE up gauge",
    'up{host="a"} 1',
    'up{host="b"} 0',
    "",
  ].join("\n"));
});

Deno.test("emits HELP when given, and only for the first sample", () => {
  const out = formatExposition([
    { name: "up", value: 1, labels: {}, help: "is it up" },
    { name: "up", value: 0, labels: {} },
  ]);
  assertEquals(out.split("\n").filter((l) => l.startsWith("# HELP")).length, 1);
  assertEquals(out.startsWith("# HELP up is it up\n# TYPE up gauge\n"), true);
});

Deno.test("honours an explicit metric type", () => {
  const out = formatExposition([
    { name: "runs_total", value: 3, labels: {}, type: "counter" },
  ]);
  assertEquals(out.includes("# TYPE runs_total counter"), true);
});

Deno.test("a metric with no labels renders without braces", () => {
  assertEquals(
    formatExposition([{ name: "in_sync", value: 1, labels: {} }]),
    "# TYPE in_sync gauge\nin_sync 1\n",
  );
});

Deno.test("the body always ends with a newline", () => {
  // Pushgateway rejects a body without a trailing newline as a "text format
  // parsing error", which reads like a bug in the series rather than a missing
  // final byte.
  const out = formatExposition([{ name: "x", value: 1, labels: {} }]);
  assertEquals(out.endsWith("\n"), true);
});

Deno.test("label values are escaped", () => {
  assertEquals(escapeLabelValue('a"b'), 'a\\"b');
  assertEquals(escapeLabelValue("a\\b"), "a\\\\b");
  assertEquals(escapeLabelValue("a\nb"), "a\\nb");
  const out = formatExposition([
    { name: "x", value: 1, labels: { note: 'he said "hi"\nthen left' } },
  ]);
  assertEquals(out.includes('note="he said \\"hi\\"\\nthen left"'), true);
});

Deno.test("an invalid metric name throws rather than being sent", () => {
  assertThrows(
    () => formatExposition([{ name: "has-a-dash", value: 1, labels: {} }]),
    Error,
    "invalid metric name",
  );
});

Deno.test("an invalid label name throws rather than being sent", () => {
  assertThrows(
    () => formatExposition([{ name: "x", value: 1, labels: { "a-b": "c" } }]),
    Error,
    "invalid label name",
  );
});

Deno.test("a non-finite value throws rather than poisoning the batch", () => {
  // A single NaN makes Pushgateway reject the entire push, so every other
  // series in the batch would be silently lost too.
  assertThrows(
    () => formatExposition([{ name: "x", value: NaN, labels: {} }]),
    Error,
    "non-finite",
  );
  assertThrows(
    () => formatExposition([{ name: "x", value: Infinity, labels: {} }]),
    Error,
    "non-finite",
  );
});

Deno.test("colons are legal in metric names", () => {
  const out = formatExposition([{ name: "job:rate5m", value: 1, labels: {} }]);
  assertEquals(out.includes("job:rate5m 1"), true);
});

Deno.test("grouping path puts job first", () => {
  assertEquals(groupingPath("unifi-fabric"), "/metrics/job/unifi-fabric");
});

Deno.test("extra grouping labels are appended", () => {
  assertEquals(
    groupingPath("fab", { instance: "site-a" }),
    "/metrics/job/fab/instance/site-a",
  );
});

Deno.test("a duplicate job in grouping is not emitted twice", () => {
  assertEquals(
    groupingPath("fab", { job: "other", instance: "a" }),
    "/metrics/job/fab/instance/a",
  );
});

Deno.test("grouping values are URL-encoded", () => {
  assertEquals(
    groupingPath("fab", { instance: "a b" }),
    "/metrics/job/fab/instance/a%20b",
  );
});

Deno.test("a value containing a slash uses the base64 escape hatch", () => {
  // A path segment cannot express a slash, so Pushgateway defines
  // <label>@base64/<url-safe-unpadded>. Corrupting the value silently would be
  // worse than encoding it.
  const p = groupingPath("fab", { path: "/volume1/media" });
  assertEquals(p.startsWith("/metrics/job/fab/path@base64/"), true);
  assertEquals(p.includes("%2F"), false);
});

Deno.test("an empty grouping value uses base64 rather than collapsing", () => {
  // An empty path segment would collapse and shift every later segment,
  // silently reassigning label names to the wrong values.
  assertEquals(
    groupingPath("fab", { instance: "" }),
    "/metrics/job/fab/instance@base64/=",
  );
});
