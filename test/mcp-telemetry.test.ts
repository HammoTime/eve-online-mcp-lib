import { afterAll, expect, it, vi } from "vitest";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, type Transport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ObservedMcpServer } from "../src/mcp-telemetry.js";
import {
  withTracer,
  withTelemetry,
  withSpan,
  cancellationSignal,
} from "../src/telemetry.js";
import { withCaptureOptions, type ReplayManifest } from "../src/diagnostics.js";

const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
function deferred() {
  let resolve = () => {
    /* Assigned synchronously by the Promise executor. */
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function modernRequest(
  id: number,
  signal?: AbortSignal,
  name = "get_market_snapshot",
) {
  return new Request("https://example.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
        name,
        arguments: {},
      },
    }),
    ...(signal ? { signal } : {}),
  });
}
afterAll(() => {
  context.disable();
  manager.disable();
});
it.each(["json", "sse"] as const)(
  "classifies real modern %s terminal sends before normal close cleanup",
  async (responseMode) => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const completions: Promise<void>[] = [];
    const handler = createMcpHandler(
      () => {
        const server = new ObservedMcpServer({ name: "test", version: "1" });
        server.registerTool("get_market_snapshot", {}, () => ({
          content: [{ type: "text", text: "private-canary" }],
          structuredContent: { complete: true, secret: "private-canary" },
        }));
        return server;
      },
      { responseMode, keepAliveMs: 0 },
    );
    try {
      await withTelemetry(
        {
          tracer: provider.getTracer("test"),
          trackCompletion: (completion) => completions.push(completion),
        },
        () =>
          Promise.all(
            Array.from({ length: 14 }, async (_, id) => {
              const response = await handler.fetch(modernRequest(id));
              const body = await response.text();
              expect(response.status, body).toBe(200);
              expect(response.headers.get("content-type")).toContain(
                responseMode === "json"
                  ? "application/json"
                  : "text/event-stream",
              );
              const message = JSON.parse(
                responseMode === "json"
                  ? body
                  : (body
                      .split("\n")
                      .find((line) => line.startsWith("data: "))
                      ?.slice(6) ?? ""),
              ) as {
                id: number;
                result: { structuredContent: { complete: boolean } };
              };
              expect(message.id).toBe(id);
              expect(message.result.structuredContent.complete).toBe(true);
            }),
          ),
      );
      await Promise.all(completions);
      const roots = exporter.getFinishedSpans();
      expect(completions).toHaveLength(14);
      expect(roots).toHaveLength(14);
      expect(roots.map((span) => span.attributes["eve.outcome"])).toEqual(
        Array.from({ length: 14 }, () => "success"),
      );
      for (const root of roots) {
        expect(root.attributes["mcp.protocol.version"]).toBe("2026-07-28");
        expect(root.status.code).toBe(SpanStatusCode.UNSET);
        expect(root.attributes["eve.error.code"]).toBeUndefined();
      }
      expect(
        JSON.stringify(
          roots.map(({ attributes, events, status }) => ({
            attributes,
            events,
            status,
          })),
        ),
      ).not.toContain("private-canary");
    } finally {
      await handler.close();
      await provider.shutdown();
    }
  },
);
it.each(["json", "sse"] as const)(
  "preserves real modern %s failures, cancellation, protocol gates and diagnostic writes",
  async (responseMode) => {
    for (const mode of [
      "partial",
      "tool_error",
      "rejected",
      "write_rejection",
      "shutdown",
      "abort",
      "batch",
    ] as const) {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const completions: Promise<void>[] = [];
      const writes: Promise<void>[] = [];
      const manifests: ReplayManifest[] = [];
      const gate = deferred();
      const started = deferred();
      const upload = deferred();
      const abort = new AbortController();
      let uploaded = false;
      const handler = createMcpHandler(
        () => {
          const server = new ObservedMcpServer({ name: "test", version: "1" });
          server.registerTool("get_market_snapshot", {}, async () => {
            started.resolve();
            if (mode === "shutdown" || mode === "abort") await gate.promise;
            return {
              content: [{ type: "text", text: "private-canary" }],
              ...(mode === "tool_error" ? { isError: true } : {}),
              structuredContent: {
                complete: mode !== "partial",
                secret: "private-canary",
              },
            };
          });
          if (mode === "write_rejection") {
            const connect = server.connect.bind(server);
            server.connect = (transport) => {
              const send = transport.send.bind(transport);
              transport.send = (message, options) =>
                send(
                  "result" in message
                    ? {
                        ...message,
                        result: {
                          toJSON() {
                            throw new Error("private-canary");
                          },
                        },
                      }
                    : message,
                  options,
                );
              return connect(transport);
            };
          }
          return server;
        },
        { responseMode, keepAliveMs: 0 },
      );
      try {
        const request = modernRequest(
          500,
          abort.signal,
          mode === "rejected" ? "unknown" : undefined,
        );
        const body =
          mode === "batch" ? [await request.clone().json()] : undefined;
        const responsePromise = withTelemetry(
          {
            tracer: provider.getTracer("test"),
            trackCompletion: (completion) => completions.push(completion),
          },
          () =>
            withCaptureOptions(
              {
                versions: {},
                save: (manifest) => {
                  manifests.push(manifest);
                  writes.push(
                    upload.promise.then(() => {
                      uploaded = true;
                    }),
                  );
                },
              },
              () =>
                handler.fetch(
                  body
                    ? new Request(request, { body: JSON.stringify(body) })
                    : request,
                ),
            ),
        );
        if (
          mode === "shutdown" ||
          mode === "abort" ||
          mode === "write_rejection"
        ) {
          await started.promise;
          if (mode === "abort") abort.abort();
          if (mode === "write_rejection")
            await vi.waitFor(() => {
              expect(exporter.getFinishedSpans()).toHaveLength(1);
            });
          await handler.close();
        }
        const response = await responsePromise;
        const responseText = await response.text();
        if (mode === "batch") {
          expect(response.status).toBe(400);
          expect(completions).toHaveLength(0);
          expect(exporter.getFinishedSpans()).toHaveLength(0);
          continue;
        }
        if (["partial", "tool_error", "rejected"].includes(mode))
          expect(response.status).toBe(200);
        if (mode === "write_rejection")
          expect(responseText).not.toContain('"result"');
        await Promise.all(completions);
        const roots = exporter.getFinishedSpans();
        expect(roots).toHaveLength(1);
        expect(roots[0]?.attributes["eve.outcome"]).toBe(
          mode === "partial"
            ? "partial"
            : mode === "abort"
              ? "cancelled"
              : mode === "rejected"
                ? "rejected"
                : "error",
        );
        expect(roots[0]?.attributes["error.type"]).toBe(
          mode === "tool_error"
            ? "tool_error"
            : mode === "shutdown" || mode === "write_rejection"
              ? "INTERNAL_ERROR"
              : undefined,
        );
        expect(manifests).toHaveLength(1);
        // Hosted waitUntil snapshots completions first, then diagnostic writes.
        // Neither returning HTTP nor finishing a span means uploads are done.
        let drained = false;
        const waitUntil = Promise.all(completions)
          .then(() => Promise.all(writes))
          .then(() => {
            drained = true;
          });
        await Promise.resolve();
        expect(uploaded).toBe(false);
        expect(drained).toBe(false);
        upload.resolve();
        await waitUntil;
        expect(uploaded).toBe(true);
        expect(drained).toBe(true);
        expect(
          JSON.stringify({
            manifests,
            spans: roots.map(({ attributes, events, status }) => ({
              attributes,
              events,
              status,
            })),
          }),
        ).not.toContain("private-canary");
        await handler.close();
        gate.resolve();
        await Promise.resolve();
        expect(exporter.getFinishedSpans()).toHaveLength(1);
        expect(manifests).toHaveLength(1);
      } finally {
        await handler.close();
        gate.resolve();
        upload.resolve();
        await provider.shutdown();
      }
    }
  },
);
it.each([
  "sync_close",
  "microtask_close",
  "nested_microtasks",
  "write_rejection",
  "sync_rejection",
  "falsy_rejection",
  "external_shutdown",
  "explicit_shutdown",
  "never_resolving",
  "abandoned",
  "request_abort",
] as const)(
  "bounds transport completion and preserves ordering for %s",
  async (mode) => {
    vi.useFakeTimers();
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const completions: Promise<void>[] = [];
    const manifests: ReplayManifest[] = [];
    const order: string[] = [];
    const gate = deferred();
    const requestAbort = new AbortController();
    const removeListener = vi.spyOn(requestAbort.signal, "removeEventListener");
    const server = new ObservedMcpServer({ name: "test", version: "1" });
    server.protocolVersionHint = "2026-07-28";
    server.server.onclose = () => order.push("close");
    const transport: Transport = {
      start: () => Promise.resolve(),
      close: () => {
        transport.onclose?.();
        return Promise.resolve();
      },
      send: () => {
        order.push("send");
        if (mode === "sync_rejection") {
          transport.onclose?.();
          throw new Error("private-canary");
        }
        if (
          [
            "external_shutdown",
            "explicit_shutdown",
            "never_resolving",
          ].includes(mode)
        )
          return gate.promise;
        if (mode === "sync_close") transport.onclose?.();
        else queueMicrotask(() => transport.onclose?.());
        if (mode === "write_rejection")
          return Promise.reject(new Error("private-canary"));
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Exercise a transport rejecting with a falsy non-Error value.
        if (mode === "falsy_rejection") return Promise.reject(false);
        return (async () => {
          if (mode === "nested_microtasks")
            for (let index = 0; index < 20; index++) await Promise.resolve();
          order.push("sent");
        })();
      },
    };
    // Drive the decorator's public transport directly so the send promise and
    // close callback can be ordered independently of application handler work.
    server.registerTool("get_market_snapshot", {}, () =>
      gate.promise.then(() => ({ content: [] })),
    );
    try {
      await withTelemetry(
        {
          tracer: provider.getTracer("test"),
          trackCompletion: (completion) => {
            completions.push(completion);
            void completion.then(() => order.push("complete"));
          },
        },
        () =>
          withCaptureOptions(
            {
              versions: {},
              save: (manifest) => {
                manifests.push(manifest);
                order.push("capture");
              },
            },
            () => server.connect(transport),
          ),
      );
      const observed = server.server.transport;
      if (!observed) throw new Error("Missing observed transport");
      transport.onmessage?.(
        {
          jsonrpc: "2.0",
          id: 500,
          method: "tools/call",
          params: {
            name: "get_market_snapshot",
            arguments: { secret: "private-canary" },
          },
        },
        { request: { signal: requestAbort.signal } as Request },
      );
      let sending: Promise<void> | undefined;
      if (mode === "abandoned" || mode === "request_abort") {
        if (mode === "request_abort") requestAbort.abort();
        transport.onclose?.();
      } else {
        sending = observed.send({
          jsonrpc: "2.0",
          id: 500,
          result: {
            structuredContent: { complete: true, secret: "private-canary" },
          },
        });
        // Attach a rejection handler immediately; the original rejection is still
        // observable by the caller and must not become an unhandled diagnostic.
        void sending.catch(() => {
          /* Assert the original rejection below. */
        });
        if (["external_shutdown", "never_resolving"].includes(mode))
          transport.onclose?.();
        if (mode === "explicit_shutdown") await server.close();
      }
      if (["external_shutdown", "never_resolving"].includes(mode)) {
        expect(exporter.getFinishedSpans()).toHaveLength(0);
        expect(order).toEqual(["send", "close"]);
        expect(vi.getTimerCount()).toBe(1);
      }
      await vi.runAllTimersAsync();
      await Promise.all(completions);
      const success = [
        "sync_close",
        "microtask_close",
        "nested_microtasks",
      ].includes(mode);
      const roots = exporter.getFinishedSpans();
      expect(roots).toHaveLength(1);
      expect(roots[0]?.attributes["eve.outcome"]).toBe(
        success ? "success" : mode === "request_abort" ? "cancelled" : "error",
      );
      expect(roots[0]?.status.code).toBe(
        success || mode === "request_abort"
          ? SpanStatusCode.UNSET
          : SpanStatusCode.ERROR,
      );
      expect(completions).toHaveLength(1);
      expect(manifests).toHaveLength(1);
      expect(order.filter((event) => event === "complete")).toHaveLength(1);
      expect(order.indexOf("capture")).toBeLessThan(order.indexOf("complete"));
      if (success)
        expect(order.indexOf("sent")).toBeLessThan(order.indexOf("capture"));
      if (mode === "nested_microtasks")
        expect(order.indexOf("close")).toBeLessThan(order.indexOf("sent"));
      expect(vi.getTimerCount()).toBe(0);
      expect(removeListener).toHaveBeenCalledWith(
        "abort",
        expect.any(Function),
      );
      expect(
        JSON.stringify({
          manifests,
          spans: roots.map(({ attributes, events, status }) => ({
            attributes,
            events,
            status,
          })),
        }),
      ).not.toContain("private-canary");
      if (["write_rejection", "sync_rejection"].includes(mode))
        await expect(sending).rejects.toThrow("private-canary");
      if (mode === "falsy_rejection") await expect(sending).rejects.toBe(false);
      // Late settlement, repeated close and messages after shutdown must not
      // resurrect a capture, retain another request or notify completion twice.
      transport.onclose?.();
      transport.onmessage?.({ jsonrpc: "2.0", id: 500, method: "ping" });
      if (mode !== "never_resolving") gate.resolve();
      await vi.runAllTimersAsync();
      expect(exporter.getFinishedSpans()).toHaveLength(1);
      expect(completions).toHaveLength(1);
      expect(manifests).toHaveLength(1);
      expect(order.filter((event) => event === "close")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await server.close();
      vi.useRealTimers();
      await provider.shutdown();
    }
  },
);
it("isolates concurrent requests and reused IDs from cancelled sends settling late", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const server = new ObservedMcpServer({ name: "test", version: "1" });
  server.protocolVersionHint = "2025-11-25";
  const handlerGate = deferred();
  const sends = [deferred(), deferred(), deferred()] as const;
  let index = 0;
  const completions: Promise<void>[] = [];
  const transport: Transport = {
    start: () => Promise.resolve(),
    close: () => {
      transport.onclose?.();
      return Promise.resolve();
    },
    send: () => {
      const gate = sends[index++];
      if (!gate) throw new Error("Unexpected send");
      return gate.promise;
    },
  };
  server.registerTool("get_market_snapshot", {}, () =>
    handlerGate.promise.then(() => ({ content: [] })),
  );
  try {
    await withTelemetry(
      {
        tracer: provider.getTracer("test"),
        trackCompletion: (completion) => completions.push(completion),
      },
      () => server.connect(transport),
    );
    const observed = server.server.transport;
    if (!observed) throw new Error("Missing observed transport");
    const request = (id: number) =>
      transport.onmessage?.({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "get_market_snapshot", arguments: {} },
      });
    request(500);
    const oldSend = observed.send({
      jsonrpc: "2.0",
      id: 500,
      result: { complete: true },
    });
    request(501);
    const otherSend = observed.send({
      jsonrpc: "2.0",
      id: 501,
      error: { code: -32603, message: "private-canary" },
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 500 },
    });
    await completions[0];
    const roots = () =>
      exporter
        .getFinishedSpans()
        .filter((span) => span.name === "tools/call get_market_snapshot");
    expect(roots().map((span) => span.attributes["eve.outcome"])).toEqual([
      "cancelled",
    ]);
    request(500);
    const newSend = observed.send({
      jsonrpc: "2.0",
      id: 500,
      result: { complete: false },
    });
    sends[0].resolve();
    await oldSend;
    expect(roots()).toHaveLength(1);
    sends[1].resolve();
    await otherSend;
    expect(roots()[1]?.attributes["error.type"]).toBe("rpc_error");
    expect(roots()[1]?.attributes["rpc.response.status_code"]).toBe(-32603);
    transport.onclose?.();
    sends[2].resolve();
    await newSend;
    await Promise.all(completions);
    expect(roots().map((span) => span.attributes["eve.outcome"])).toEqual([
      "cancelled",
      "error",
      "partial",
    ]);
    expect(completions).toHaveLength(3);
    expect(
      JSON.stringify(
        roots().map(({ attributes, events, status }) => ({
          attributes,
          events,
          status,
        })),
      ),
    ).not.toContain("private-canary");
  } finally {
    await server.close();
    handlerGate.resolve();
    await provider.shutdown();
  }
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
