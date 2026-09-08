import { afterAll, describe, expect, it, vi } from "vitest";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TelemetryRuntime } from "../adapters/telemetry-runtime.js";
import { diagnostic, withSpan, withSpanSync } from "../src/telemetry.js";

const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
afterAll(() => {
  context.disable();
  manager.disable();
});
describe("SDK export lifecycle", () => {
  it("exports real metrics with explicit buckets and correlated logs, including async completion", async () => {
    const sent: { url: string; body: string }[] = [];
    const runtime = new TelemetryRuntime({
      service: "test",
      version: "1",
      environment: "test",
      endpoint: "https://collector.test",
      fetch: async (url, init) => {
        sent.push({
          url: url instanceof Request ? url.url : url.toString(),
          body: await new Response(init?.body).text(),
        });
        return new Response("{}");
      },
    });
    await runtime.run(() =>
      withSpan("operation", {}, async () => {
        await Promise.resolve();
        diagnostic("decision", { "eve.input.page": 2 });
        withSpanSync("calculation", () => 1, { "eve.input.limit": 3 });
      }),
    );
    await runtime.shutdown();
    expect(sent.map((s) => new URL(s.url).pathname).sort()).toEqual([
      "/v1/logs",
      "/v1/metrics",
      "/v1/traces",
    ]);
    const metrics = sent.find((s) => s.url.endsWith("metrics"))?.body ?? "";
    expect(metrics).toContain("eve.operation.calls");
    expect(metrics).toContain("explicitBounds");
    expect(metrics).toContain('"aggregationTemporality":1');
    expect(metrics).not.toContain("eve.input.page");
    const logs = sent.find((s) => s.url.endsWith("logs"))?.body ?? "";
    expect(logs).toContain("decision");
    expect(logs).toContain("traceId");
    expect(logs).toContain("spanId");
  });
  it("reports partial success without duplicating a partially accepted batch, and isolates export failures", async () => {
    const rejected = vi.fn<(reason: string) => void>();
    const fetcher = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        (url instanceof Request ? url.url : url.toString()).endsWith("traces")
          ? new Response(
              '{"partialSuccess":{"rejectedSpans":"1","errorMessage":"private-canary"}}',
            )
          : new Response("{}"),
      ),
    );
    const runtime = new TelemetryRuntime({
      service: "test",
      version: "1",
      environment: "test",
      endpoint: "https://collector.test",
      fetch: fetcher,
      failure: rejected,
    });
    expect(await runtime.run(() => withSpan("safe", {}, () => 42))).toBe(42);
    await runtime.shutdown();
    expect(rejected).toHaveBeenCalledWith("partial_success");
    expect(
      fetcher.mock.calls.filter(([url]) =>
        (url instanceof Request ? url.url : url.toString()).endsWith("traces"),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(rejected.mock.calls)).not.toContain("private-canary");
    const failed = new TelemetryRuntime({
      service: "test",
      version: "1",
      environment: "test",
      endpoint: "http://insecure.test",
      failure: rejected,
    });
    expect(await failed.run(() => withSpan("safe", {}, () => 7))).toBe(7);
    await failed.shutdown();
    expect(rejected).toHaveBeenCalledWith("export_failed");
  });
  it("bounds export buffers without losing the late-ending root and reports dropped records", async () => {
    const sent: string[] = [],
      failures: string[] = [];
    const runtime = new TelemetryRuntime({
      service: "test",
      version: "1",
      environment: "test",
      endpoint: "https://collector.test",
      fetch: async (_url, init) => {
        sent.push(await new Response(init?.body).text());
        return new Response("{}");
      },
      failure: (reason) => {
        failures.push(reason);
      },
    });
    await runtime.run(() =>
      withSpan("late.root", {}, () => {
        for (let i = 0; i < 1600; i++)
          withSpanSync("child", () => 1, { "eve.input.page": i });
      }),
    );
    await runtime.shutdown();
    expect(failures).toContain("capture_limit");
    expect(sent.join("")).toContain("late.root");
    expect(sent.join("")).toContain("eve.telemetry.dropped");
    expect(
      sent.every(
        (body) => new TextEncoder().encode(body).byteLength <= 256 * 1024,
      ),
    ).toBe(true);
  });
});
