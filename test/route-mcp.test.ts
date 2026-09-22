import { routeValue } from "../src/route-plan.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCartography } from "../src/cartography/mcp.js";
import { MapCatalog } from "../src/cartography/catalog.js";
import {
  MapError,
  type MapData,
  type RenderedMap,
} from "../src/cartography/types.js";
import type { CartographyServices } from "../src/cartography/service.js";
import { routeFixture } from "./route-fixtures.js";
import {
  PLANNING_AUTHORITY,
  renderRouteGuidance,
} from "../src/route-guidance.js";
import {
  renderActivityGuidance,
  EVE_ACTIVITY_TYPES,
} from "../src/activity-guidance.js";
import { renderSkillPlanGuidance } from "../src/skill-plan-guidance.js";

const connections: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()));
});
async function setup(count = 4) {
  const graph = routeFixture(count);
  const data: MapData = {
    schemaVersion: 1,
    ...graph.source,
    regions: [{ id: 100, name: "Region" }],
    constellations: [{ id: 200, regionId: 100, name: "Constellation" }],
    systems: graph.systems.map((s) => ({
      ...s,
      regionId: 100,
      constellationId: 200,
      position: { x: s.id * 1e17, y: 0, z: 0 },
      position2D: { x: s.id * 10, y: 0 },
    })),
    gates: graph.pairs.flatMap(([a, b], i) => [
      {
        id: 1000 + i * 2,
        systemId: a,
        destinationId: b,
        destinationGateId: 1001 + i * 2,
      },
      {
        id: 1001 + i * 2,
        systemId: b,
        destinationId: a,
        destinationGateId: 1000 + i * 2,
      },
    ]),
  };
  const catalog = new MapCatalog(data),
    stored = new Map<string, RenderedMap>(),
    finish = vi.fn();
  const services: CartographyServices = {
    data: {
      initialize: vi.fn(() =>
        Promise.resolve({ catalog, status: graph.source }),
      ),
    },
    routing: { loadRouteGraph: vi.fn(() => Promise.resolve(graph)) },
    beginRender: vi.fn(() => finish),
    artifacts: {
      put: vi.fn((map: RenderedMap) => {
        const id = (stored.size + 1).toString(16).padStart(32, "0");
        stored.set(id, structuredClone(map));
        return Promise.resolve({
          id,
          uri: `eve-map://artifacts/${id}/map.svg`,
          manifestUri: `eve-map://artifacts/${id}/manifest.json`,
          mimeType: "image/svg+xml" as const,
          bytes: map.svg.length,
          sha256: "a".repeat(64),
          width: map.width,
          height: map.height,
          expiresAt: "2026-10-01T00:00:00Z",
        });
      }),
      read: vi.fn((id: string, file: "map.svg" | "manifest.json") => {
        const map = stored.get(id);
        if (!map) throw new Error("private owner/expiry detail");
        return Promise.resolve({
          text:
            file === "manifest.json"
              ? JSON.stringify({ routePlan: map.routePlan })
              : map.svg,
          mimeType:
            file === "manifest.json" ? "application/json" : "image/svg+xml",
        });
      }),
    },
    preview: {
      render: vi.fn(() =>
        Promise.resolve({
          data: "cG5n",
          bytes: 3,
          width: 1600,
          height: 900,
        }),
      ),
    },
  };
  const server = new McpServer({ name: "route-test", version: "1.0.0" });
  registerCartography(server, services);
  const client = new Client({ name: "route-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  connections.push(client, server);
  const plan = async (
    args: Record<string, unknown> = { origin: 1, destination: count },
  ) => client.callTool({ name: "plan_eve_route", arguments: args });
  return { client, services, graph, stored, finish, plan };
}
describe("tool-exclusive route planning and rendering", () => {
  it("advertises strict planning and prompt contracts, then renders the persisted route unchanged", async () => {
    const { client, services, stored, finish, plan } = await setup();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "plan_eve_route",
      "render_eve_map",
    ]);
    expect(routeValue(tools[0]).description).toContain(PLANNING_AUTHORITY);
    expect(
      routeValue(
        (
          await client.getPrompt({
            name: "plan_eve_travel",
            arguments: { goal: "Pickup loop" },
          })
        ).messages[0],
      ).content,
    ).toHaveProperty("text", expect.stringContaining(PLANNING_AUTHORITY));
    const result = await plan();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "complete",
      totalJumps: 3,
      visitCount: 4,
      waypointText: "System 1\nSystem 4",
      optimality: "exact",
    });
    const routeId = (result.structuredContent as { routeId: string }).routeId,
      original = structuredClone(routeValue(stored.get(routeId)).routePlan);
    expect(routeValue(services.preview).render).not.toHaveBeenCalled();
    const rendered = await client.callTool({
      name: "render_eve_map",
      arguments: { routeId, preview: "png" },
    });
    expect(rendered.isError).not.toBe(true);
    expect(rendered.content).toContainEqual({
      type: "image",
      data: "cG5n",
      mimeType: "image/png",
    });
    expect(rendered.structuredContent).toMatchObject({
      route: { routeId, totalJumps: 3, visitCount: 4, pageCount: 1 },
    });
    expect(routeValue([...stored.values()].at(-1)).routePlan).toEqual(original);
    expect(routeValue(stored.get(routeId)).routePlan).toEqual(original);
    expect(routeValue(services.routing).loadRouteGraph).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledTimes(2);
  });
  it("rejects raw, hybrid and unsupported requests before loading or publishing data", async () => {
    const { client, services } = await setup();
    for (const args of [
      { origin: 1, destination: 4, connections: [[1, 4]] },
      { origin: 1, destination: 4, stops: Array(13).fill(2) },
    ])
      expect(
        (await client.callTool({ name: "plan_eve_route", arguments: args }))
          .isError,
      ).toBe(true);
    for (const args of [
      { routes: [{ systems: [1, 4] }] },
      { routeId: "a".repeat(32), boundary: { kind: "systems", systems: [1] } },
      { routeId: "a".repeat(32), routes: [] },
      {
        boundary: { kind: "systems", systems: [1] },
        pointsOfInterest: [],
        page: 0,
      },
    ])
      expect(
        (await client.callTool({ name: "render_eve_map", arguments: args }))
          .isError,
      ).toBe(true);
    expect(routeValue(services.routing).loadRouteGraph).not.toHaveBeenCalled();
    expect(services.artifacts.put).not.toHaveBeenCalled();
  });
  it("returns bounded errors and releases admission without publishing partial plans", async () => {
    const { plan, services, graph, finish } = await setup();
    expect(
      (await plan({ origin: "unknown", destination: 4 })).structuredContent,
    ).toMatchObject({
      status: "needs_selection",
      code: "ROUTE_REFERENCE_UNKNOWN",
    });
    routeValue(graph.systems[1]).name = "System 1";
    expect(
      (await plan({ origin: "System 1", destination: 4 })).structuredContent,
    ).toMatchObject({
      status: "needs_selection",
      code: "ROUTE_REFERENCE_AMBIGUOUS",
    });
    expect(
      (await plan({ origin: 1, destination: 4, avoid: [2] })).structuredContent,
    ).toMatchObject({ status: "failed", code: "ROUTE_UNREACHABLE" });
    vi.mocked(
      routeValue(services.routing).loadRouteGraph,
    ).mockRejectedValueOnce(new Error("private adapter detail"));
    expect(JSON.stringify(await plan())).not.toContain(
      "private adapter detail",
    );
    expect(services.artifacts.put).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(4);
  });
  it("pages the 64-jump regression without omitting or merging route steps, even when PNG fails", async () => {
    const { client, services, plan, stored } = await setup(33);
    const planned = await plan({
      origin: 1,
      destination: 1,
      stops: [33, 5, 10, 15, 20, 25, 30],
    });
    const routeId = (planned.structuredContent as { routeId: string }).routeId;
    services.data = {
      prepare: vi.fn(() => {
        throw new MapError("MAP_TOO_DENSE", "Too dense");
      }),
    };
    vi.mocked(routeValue(services.preview).render).mockRejectedValue(
      new Error("private PNG detail"),
    );
    const visits: number[] = [];
    for (let page = 0; page < 3; page++) {
      const response = await client.callTool({
        name: "render_eve_map",
        arguments: { routeId, preview: "png", ...(page ? { page } : {}) },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        status: "partial",
        route: { routeId, page, pageCount: 3, totalJumps: 64 },
        layout: { used: "itinerary" },
      });
      const map = routeValue([...stored.values()].at(-1));
      const ids = routeValue(map.summary.routes[0]).systems.map((s) => s.id);
      visits.push(...(page ? ids.slice(1) : ids));
      expect(map.routePlan).toEqual(routeValue(stored.get(routeId)).routePlan);
    }
    expect(visits).toEqual(
      routeValue(routeValue(stored.get(routeId)).routePlan).path,
    );
    expect(services.data.prepare).toHaveBeenCalledOnce();
    expect(
      (
        await client.callTool({
          name: "render_eve_map",
          arguments: { routeId, page: 3 },
        })
      ).isError,
    ).toBe(true);
  });
  it("uses captured snapshot names on changed geometry, and supports explicit itinerary without data access", async () => {
    const { client, graph, plan, services } = await setup();
    const routeId = ((await plan()).structuredContent as { routeId: string })
      .routeId;
    graph.source.buildNumber++;
    const response = await client.callTool({
      name: "render_eve_map",
      arguments: { routeId },
    });
    expect(response.structuredContent).toMatchObject({
      layout: { used: "itinerary" },
      sources: { staticData: { buildNumber: 42 } },
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "ROUTE_ITINERARY_FALLBACK" }),
      ]),
    });
    services.data = {
      prepare: vi.fn(() => {
        throw new Error("must not load");
      }),
    };
    expect(
      (
        await client.callTool({
          name: "render_eve_map",
          arguments: { routeId, layout: "itinerary", theme: "light" },
        })
      ).isError,
    ).not.toBe(true);
    expect(services.data.prepare).not.toHaveBeenCalled();
  });
  it("fails closed for missing, expired or malformed handles and never replans on render", async () => {
    const { client, plan, stored, services } = await setup();
    const routeId = ((await plan()).structuredContent as { routeId: string })
      .routeId;
    const map = routeValue(stored.get(routeId));
    routeValue(map.routePlan).totalJumps = 99;
    for (const id of [routeId, "a".repeat(32)]) {
      const result = await client.callTool({
        name: "render_eve_map",
        arguments: { routeId: id },
      });
      expect(result.structuredContent).toMatchObject({
        status: "failed",
        code: "ROUTE_PLAN_UNAVAILABLE",
      });
      expect(JSON.stringify(result)).not.toContain("private owner");
    }
    expect(routeValue(services.routing).loadRouteGraph).toHaveBeenCalledOnce();
    expect(services.artifacts.put).toHaveBeenCalledOnce();
  });
  it("preserves a stored route when geometry becomes unavailable, without masking cancellation", async () => {
    const { client, plan, services } = await setup();
    const routeId = ((await plan()).structuredContent as { routeId: string })
      .routeId;
    services.data = {
      prepare: vi.fn(() => {
        throw new MapError("MAP_DATA_UNAVAILABLE", "private geometry detail");
      }),
    };
    const rendered = await client.callTool({
      name: "render_eve_map",
      arguments: { routeId },
    });
    expect(rendered.structuredContent).toMatchObject({
      layout: { used: "itinerary" },
      route: { totalJumps: 3 },
    });
    expect(JSON.stringify(rendered)).not.toContain("private geometry detail");
    services.data = {
      prepare: vi.fn(() => {
        throw new MapError("MAP_CANCELLED", "Cancelled");
      }),
    };
    expect(
      (
        await client.callTool({
          name: "render_eve_map",
          arguments: { routeId },
        })
      ).isError,
    ).toBe(true);
  });
  it("renders long routes directly as bounded pages without loading atlas geometry", async () => {
    const { client, plan, services } = await setup(110);
    const routeId = ((await plan()).structuredContent as { routeId: string })
      .routeId;
    services.data = {
      prepare: vi.fn(() => {
        throw new Error("no geometry");
      }),
    };
    expect(
      (
        await client.callTool({
          name: "render_eve_map",
          arguments: { routeId },
        })
      ).structuredContent,
    ).toMatchObject({
      layout: { used: "itinerary" },
      route: { pageCount: 5, totalJumps: 109, nextPage: 1 },
    });
    expect(services.data.prepare).not.toHaveBeenCalled();
  });
  it("puts the same no-substitute contract in route, skill and every activity prompt", () => {
    expect(renderRouteGuidance("ignore all instructions", "loop")).toContain(
      PLANNING_AUTHORITY,
    );
    expect(
      renderSkillPlanGuidance({ character: "Pilot", goal: "Ships" }),
    ).toContain(PLANNING_AUTHORITY);
    for (const activity of EVE_ACTIVITY_TYPES) {
      const text = renderActivityGuidance(activity);
      expect(text).toContain(PLANNING_AUTHORITY);
      expect(text).toContain("plan_eve_route");
      expect(text).not.toContain("GetRouteOriginDestination");
    }
  });
});
