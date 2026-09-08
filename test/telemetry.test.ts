import { afterAll, describe, expect, it } from "vitest";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withSpan, withSpanSync, withTracer } from "../src/telemetry.js";

describe("runtime-neutral telemetry", () => {
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  afterAll(() => {
    context.disable();
    manager.disable();
  });
  it("keeps concurrent host tracers isolated and omits exception contents", async () => {
    const exporters = [new InMemorySpanExporter(), new InMemorySpanExporter()];
    const providers = exporters.map(
      (exporter) =>
        new BasicTracerProvider({
          spanProcessors: [new SimpleSpanProcessor(exporter)],
        }),
    );
    await Promise.all(
      providers.map(async (provider, index) =>
        withTracer(provider.getTracer(String(index)), async () => {
          await withSpan("parent", {}, async () => {
            await Promise.resolve();
            await withSpan("child", {}, () => ({ isError: true }));
            expect(() =>
              withSpanSync("failure", () => {
                throw new Error("credential must not be exported");
              }),
            ).toThrow();
          });
        }),
      ),
    );
    for (const [index, exporter] of exporters.entries()) {
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(3);
      expect(
        spans.every((s) => s.instrumentationScope.name === String(index)),
      ).toBe(true);
      const parent = spans.find((s) => s.name === "parent");
      if (!parent) throw new Error("Missing parent span");
      expect(
        spans.find((s) => s.name === "child")?.parentSpanContext?.spanId,
      ).toBe(parent.spanContext().spanId);
      expect(spans.find((s) => s.name === "child")?.status.code).toBe(
        SpanStatusCode.ERROR,
      );
      expect(
        JSON.stringify(
          spans.map((s) => ({
            attributes: s.attributes,
            events: s.events,
            status: s.status,
          })),
        ),
      ).not.toContain("credential");
    }
    await Promise.all(providers.map((p) => p.shutdown()));
  });
});
