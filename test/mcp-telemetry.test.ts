import { afterAll, expect, it, vi } from "vitest";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { ObservedMcpServer } from "../src/mcp-telemetry.js";
import { withTracer, withSpan, cancellationSignal } from "../src/telemetry.js";

const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
afterAll(() => {
  context.disable();
  manager.disable();
});
it.each(["delayed_send", "failed_send", "cancelled", "validation"] as const)(
  "finishes MCP spans correctly for %s",
  async (mode) => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const server = new ObservedMcpServer({ name: "test", version: "1" });
    server.protocolVersionHint = "2025-11-25";
    let started = false,
      sending = false;
    let release = () => {
      /* assigned below */
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.registerTool(
      "get_market_snapshot",
      { inputSchema: z.object({ regionId: z.number() }) },
      () =>
        withSpan("eve.fixture.domain", {}, async () => {
          started = true;
          if (mode === "cancelled")
            await new Promise<void>((_resolve, reject) => {
              const signal = cancellationSignal();
              if (!signal) throw new Error("Missing cancellation signal");
              signal.addEventListener(
                "abort",
                () => {
                  reject(new DOMException("private-canary", "AbortError"));
                },
                { once: true },
              );
            });
          return {
            content: [{ type: "text" as const, text: "{}" }],
            structuredContent: { complete: true },
          };
        }),
    );
    const [outbound, inbound] = InMemoryTransport.createLinkedPair();
    const send = inbound.send.bind(inbound);
    inbound.send = async (message, options) => {
      if ("id" in message && message.id === 500) {
        sending = true;
        if (mode === "delayed_send") await gate;
        if (mode === "failed_send") throw new Error("private-canary");
      }
      return send(message, options);
    };
    await withTracer(provider.getTracer("test"), () => server.connect(inbound));
    const client = new Client({ name: "test", version: "1" });
    try {
      await client.connect(outbound);
      const roots = () =>
        exporter
          .getFinishedSpans()
          .filter((s) => s.name === "tools/call get_market_snapshot");
      await outbound.send({
        jsonrpc: "2.0",
        id: 500,
        method: "tools/call",
        params: {
          name: "get_market_snapshot",
          arguments: {
            regionId: mode === "validation" ? "private-canary" : 10000002,
          },
        },
      });
      if (mode === "cancelled") {
        await vi.waitFor(() => {
          expect(started).toBe(true);
        });
        await outbound.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 500 },
        });
      }
      if (mode === "delayed_send") {
        await vi.waitFor(() => {
          expect(sending).toBe(true);
        });
        expect(roots()).toHaveLength(0);
        release();
      }
      await vi.waitFor(() => {
        expect(roots()).toHaveLength(1);
      });
      const root = roots()[0];
      if (!root) throw new Error("Missing root span");
      expect(root.attributes["eve.outcome"]).toBe(
        mode === "cancelled"
          ? "cancelled"
          : mode === "validation" || mode === "failed_send"
            ? "error"
            : "success",
      );
      expect(root.status.code).toBe(
        mode === "failed_send" || mode === "validation"
          ? SpanStatusCode.ERROR
          : SpanStatusCode.UNSET,
      );
      expect(
        JSON.stringify(
          exporter.getFinishedSpans().map((s) => ({
            attributes: s.attributes,
            events: s.events,
            status: s.status,
          })),
        ),
      ).not.toContain("private-canary");
    } finally {
      release();
      await client.close();
      await server.close();
      await provider.shutdown();
    }
  },
);
