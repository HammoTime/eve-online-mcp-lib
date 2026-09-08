import { afterAll, describe, expect, it, vi } from "vitest";
import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createEveServer } from "../src/server.js";
import { EsiClient } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { withTracer } from "../src/telemetry.js";
import {
  withCaptureOptions,
  safeMarketBody,
  safeResponseHeaders,
  type ReplayManifest,
} from "../src/diagnostics.js";
import { projectInput, projectOutput } from "../src/diagnostic-policy.js";
import { remoteSpan } from "../src/mcp-telemetry.js";
import { replayDiagnostic } from "../adapters/replay.js";
import {
  replaySynthetic,
  SYNTHETIC_RULES,
} from "../adapters/synthetic-replay.js";
import { fixtureDocument } from "./fixtures.js";
import { fixtureSource } from "./skill-fixtures.js";
import { skillFixture } from "./skill-fixtures.js";
import { createHash } from "node:crypto";
import { DiagnosticCapture } from "../src/diagnostics.js";

const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
afterAll(() => {
  context.disable();
  manager.disable();
});
describe("MCP diagnostic evidence", () => {
  it("snapshots public static data and replays the dependency graph without downloading SDE", async () => {
    const provider = new BasicTracerProvider();
    const document = fixtureDocument(),
      data = skillFixture();
    const captures: ReplayManifest[] = [];
    const sha256 = createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");
    const catalog = new OperationCatalog(document);
    const server = createEveServer(
      catalog,
      new EsiClient(catalog, {
        getAccessToken: () => Promise.resolve(undefined),
      }),
      {
        identity: { name: "test", version: "1" },
        staticData: fixtureSource(data),
      },
    );
    const client = new Client({ name: "test", version: "1" });
    const [outbound, inbound] = InMemoryTransport.createLinkedPair();
    await withTracer(provider.getTracer("test"), () =>
      withCaptureOptions(
        {
          versions: {
            server: "1".repeat(40),
            library: "2".repeat(40),
            openapi: "3".repeat(64),
          },
          save: (m) => {
            captures.push(m);
          },
          saveCatalog: (value) => {
            expect(value).toEqual(data);
            return Promise.resolve({ sha256, key: `catalogs/${sha256}.json` });
          },
        },
        () => server.connect(inbound),
      ),
    );
    try {
      await client.connect(outbound);
      const result = await client.callTool({
        name: "get_skill_dependencies",
        arguments: { target: { typeId: 400 } },
      });
      expect(result.isError).not.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const capture = captures[0];
      if (!capture) throw new Error("Missing catalog capture");
      expect(capture.status).toBe("exact");
      expect(capture.catalogs).toHaveLength(1);
      const replay = await replayDiagnostic(
        capture,
        document,
        new Map([[sha256, data]]),
      );
      expect(replay.observed["eve.output.graph.node_count"]).toBeGreaterThan(0);
      await expect(replayDiagnostic(capture, document)).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
      await provider.shutdown();
    }
  });
  it("externalizes large reviewed bodies and marks capture limits and sink failures explicitly", async () => {
    const stored: string[] = [];
    const capture = new DiagnosticCapture(
      {
        versions: {
          server: "1".repeat(40),
          library: "2".repeat(40),
          openapi: "3".repeat(64),
        },
        save: () => undefined,
        saveDependency: (body) => {
          stored.push(body);
          const sha256 = createHash("sha256").update(body).digest("hex");
          return Promise.resolve({
            sha256,
            key: `dependencies/${sha256}.json`,
          });
        },
      },
      { method: "tools/call", tool: "get_market_snapshot", arguments: {} },
      true,
    );
    const body = JSON.stringify(
      Array.from({ length: 10000 }, () => ({
        price: 4.5,
        location_id: 60003760,
      })),
    );
    await capture.add({
      ordinal: capture.next(),
      operationId: "GetMarketsRegionIdOrders",
      input: {},
      cached: false,
      startedAt: 1,
      fetchedAt: 2,
      body,
    });
    expect(stored).toEqual([body]);
    expect(capture.dependencies[0]?.body).toBeUndefined();
    expect(capture.dependencies[0]?.bodyArtifact?.key).toMatch(
      /^dependencies\/[a-f0-9]{64}\.json$/u,
    );
  });
  it.each(SYNTHETIC_RULES)(
    "reproduces %s with private state replaced by reviewed stand-ins",
    async (rule) => {
      expect(await replaySynthetic(rule, fixtureDocument())).toMatchObject({
        status: "synthetic",
        boundary: "domain",
        rule,
        dependencyCalls: 2,
      });
    },
  );
  it("captures a partial market result with nested spans and reproduces it through MCP offline", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const captures: ReplayManifest[] = [];
    const document = fixtureDocument(),
      catalog = new OperationCatalog(document);
    let now = 1788912000000;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      return Promise.resolve(
        url.searchParams.get("page") === "1"
          ? new Response(
              JSON.stringify([
                {
                  order_id: 1,
                  type_id: 34,
                  location_id: 60003760,
                  volume_remain: 100,
                  price: 4.5,
                  is_buy_order: false,
                },
              ]),
              { headers: { "x-pages": "3", "cache-control": "no-store" } },
            )
          : new Response('{"error":"Rate limited"}', {
              status: 429,
              headers: { "retry-after": "2" },
            }),
      );
    });
    const server = createEveServer(
      catalog,
      new EsiClient(
        catalog,
        {
          getAccessToken: () => {
            throw new Error("Public requests cannot authenticate");
          },
        },
        { fetchImplementation: fetcher, clock: () => new Date(now++) },
      ),
      { identity: { name: "test", version: "1" }, staticData: fixtureSource() },
    );
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await withTracer(provider.getTracer("test"), () =>
      withCaptureOptions(
        {
          versions: {
            server: "1".repeat(40),
            library: "2".repeat(40),
            openapi: "3".repeat(64),
          },
          save: (m) => {
            captures.push(m);
          },
        },
        () => server.connect(serverTransport),
      ),
    );
    try {
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "get_market_snapshot",
        arguments: { regionId: 10000002, typeId: 34, maxPages: 3 },
        _meta: {
          traceparent: `00-${"4".repeat(32)}-${"5".repeat(16)}-00`,
          baggage: "private-canary",
        },
      });
      expect(result.isError).not.toBe(true);
      // In-memory delivery can resolve the caller one microtask before send() ends.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const capture = captures[0];
      if (!capture) throw new Error("Missing capture");
      expect(capture.status).toBe("exact");
      expect(capture.dependencies).toHaveLength(2);
      expect(capture.expected).toMatchObject({
        "eve.output.complete": false,
        "eve.output.pagesFetched": 1,
        "eve.output.stopReason": "pageError",
      });
      const root = exporter
        .getFinishedSpans()
        .find((s) => s.name === "tools/call get_market_snapshot");
      expect(root?.kind).toBe(SpanKind.SERVER);
      expect(root?.status.code).toBe(SpanStatusCode.UNSET);
      expect(root?.attributes["eve.outcome"]).toBe("partial");
      expect(root?.spanContext().traceId).not.toBe("4".repeat(32));
      expect(root?.links[0]?.context.traceId).toBe("4".repeat(32));
      const http = exporter
        .getFinishedSpans()
        .filter((s) => s.kind === SpanKind.CLIENT);
      expect(http).toHaveLength(2);
      expect(http[1]?.attributes["eve.error.code"]).toBe("THROTTLED");
      expect(http[1]?.attributes["http.response.status_code"]).toBe(429);
      expect(JSON.stringify(captures)).not.toContain("private-canary");
      const replay = await replayDiagnostic(capture, document);
      expect(replay.status).toBe("reproduced");
      expect(replay.dependencyCalls).toBe(2);
      await expect(
        replayDiagnostic(
          { ...capture, dependencies: capture.dependencies.slice(0, 1) },
          document,
        ),
      ).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
      await provider.shutdown();
    }
  });
  it("fails closed on private fields, malformed public values, unknown fields and excessive nesting", () => {
    const projected = projectInput({
      regionId: 10000002,
      query: { page: 2, character_id: 90000001 },
      headers: { authorization: "private-canary" },
      secretFieldName: "private-canary",
      targets: [{ typeId: 34, level: 2 }, "private-canary"],
    });
    expect(projected.complete).toBe(false);
    expect(JSON.stringify(projected)).not.toMatch(
      /private-canary|90000001|authorization|secretFieldName/u,
    );
    expect(projected.attributes["eve.input.regionId"]).toBe(10000002);
    expect(projectInput({ regionId: "private-canary" }).complete).toBe(false);
    const recursive: Record<string, unknown> = {};
    recursive.target = recursive;
    expect(projectInput(recursive).complete).toBe(false);
    expect(
      projectOutput({ status: "private-canary", aggregates: recursive }),
    ).toEqual({});
    expect(
      safeMarketBody(
        '[{"order_id":1,"secret":"private-canary"}]',
        "GetMarketsRegionIdOrders",
        200,
      ),
    ).toBe(false);
    expect(
      safeMarketBody(
        '[{"location_id":1000000000001}]',
        "GetMarketsRegionIdOrders",
        200,
      ),
    ).toBe(false);
    expect(
      safeMarketBody(
        '{"error":"private-canary"}',
        "GetMarketsRegionIdOrders",
        429,
      ),
    ).toBe(false);
    expect(
      safeResponseHeaders(
        new Headers({ etag: "private-canary", "retry-after": "3" }),
      ),
    ).toEqual({ complete: false, values: { "retry-after": "3" } });
    expect(
      remoteSpan(`00-${"0".repeat(32)}-${"1".repeat(16)}-01`),
    ).toBeUndefined();
    expect(remoteSpan("private-canary")).toBeUndefined();
  });
});
