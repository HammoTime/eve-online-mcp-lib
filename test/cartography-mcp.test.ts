import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapCatalog } from "../src/cartography/catalog.js";
import {
  registerCartography,
  mapResultSchema,
} from "../src/cartography/mcp.js";
import { MapError, type MapData } from "../src/cartography/types.js";
import type { CartographyServices } from "../src/cartography/service.js";
import {
  projectInput,
  projectOutput,
  TOOL_NAMES,
} from "../src/diagnostic-policy.js";

const data: MapData = {
  schemaVersion: 1,
  buildNumber: 42,
  releaseDate: "2026-09-01T00:00:00Z",
  fetchedAt: "2026-09-01T01:00:00Z",
  sourceUrl: "https://example.invalid/test-sde",
  regions: [{ id: 100, name: "Synthetic region" }],
  constellations: [{ id: 200, name: "Synthetic constellation", regionId: 100 }],
  systems: [1, 2, 3].map((id) => ({
    id,
    name: `Test ${id}`,
    regionId: 100,
    constellationId: 200,
    position: { x: id * 100, y: 0, z: id === 2 ? 100 : 0 },
    securityStatus: 0.9459131360054016,
  })),
  gates: [
    { id: 10, systemId: 1, destinationId: 2, destinationGateId: 11 },
    { id: 11, systemId: 2, destinationId: 1, destinationGateId: 10 },
  ],
};
const id = "a".repeat(32);
const request = {
  boundary: { kind: "systems", systems: [1, 2, 3] },
  pointsOfInterest: [{ system: 1, label: "Existing plan marker" }],
  routes: [{ systems: [1, 2] }],
  preview: "none",
};
const connections: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  vi.restoreAllMocks();
});
async function setup(
  options: {
    preview?: "ready" | "fail" | "oversize";
    stale?: boolean;
    legacy?: boolean;
  } = {},
) {
  const catalog = new MapCatalog(data);
  let svg = "";
  const services: CartographyServices = {
    data: {
      initialize: vi.fn(() =>
        Promise.resolve({
          catalog,
          status: {
            buildNumber: data.buildNumber,
            releaseDate: data.releaseDate,
            sourceUrl: data.sourceUrl,
            fetchedAt: data.fetchedAt,
            checkedAt: data.fetchedAt,
            stale: options.stale ?? false,
          },
        }),
      ),
    },
    artifacts: {
      put: vi.fn((map) => {
        svg = map.svg;
        return Promise.resolve({
          id,
          uri: `eve-map://artifacts/${id}/map.svg`,
          manifestUri: `eve-map://artifacts/${id}/manifest.json`,
          mimeType: "image/svg+xml" as const,
          bytes: new TextEncoder().encode(svg).byteLength,
          sha256: "b".repeat(64),
          width: map.width,
          height: map.height,
          expiresAt: "2026-09-08T00:00:00Z",
        });
      }),
      read: vi.fn((_id, file) =>
        Promise.resolve({
          text: file === "map.svg" ? svg : "{}",
          mimeType: file === "map.svg" ? "image/svg+xml" : "application/json",
        }),
      ),
    },
  };
  if (options.preview)
    services.preview = {
      render: vi.fn(() => {
        if (options.preview === "fail")
          throw new Error("PRIVATE preview error");
        return Promise.resolve({
          data: "cG5n",
          bytes: options.preview === "oversize" ? 2_000_000 : 3,
          width: 1440,
          height: 900,
        });
      }),
    };
  const server = new McpServer({ name: "map-test", version: "1.0.0" });
  registerCartography(server, services);
  const client = new Client({ name: "map-test-client", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  if (options.legacy)
    vi.spyOn(server.server, "getNegotiatedProtocolVersion").mockReturnValue(
      "2025-03-26",
    );
  connections.push(server, client);
  return { client, services, server };
}
describe("renderer-only map MCP", () => {
  it("requires an explicit boundary and POI list and exposes no planning arguments", async () => {
    const { client, services } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["render_eve_map"]);
    expect(tools[0]?.inputSchema.required).toEqual(
      expect.arrayContaining(["boundary", "pointsOfInterest"]),
    );
    expect(tools[0]?.description).toContain("Never creates plans");
    expect(tools[0]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(services.data.initialize).not.toHaveBeenCalled();
    for (const invalid of [
      {},
      { boundary: request.boundary },
      { ...request, from: "Test 1", to: "Test 2" },
      {
        ...request,
        routes: [{ from: "Test 1", to: "Test 2", preference: "shortest" }],
      },
      { ...request, outputPath: "../map.svg" },
      { ...request, pointsOfInterest: [{ system: 1, label: "bad\u0000" }] },
    ]) {
      const result = await client.callTool({
        name: "render_eve_map",
        arguments: invalid,
      });
      expect(result.isError).toBe(true);
    }
    expect(services.data.initialize).not.toHaveBeenCalled();
  });
  it("returns the original SVG resource, framed boundary and POI list without changing supplied routes", async () => {
    const { client, services } = await setup();
    const result = await client.callTool({
      name: "render_eve_map",
      arguments: { ...request, routes: [{ systems: [1, 2, 1] }] },
    });
    expect(result.isError).not.toBe(true);
    expect(mapResultSchema.safeParse(result.structuredContent).success).toBe(
      true,
    );
    expect(result.structuredContent).toMatchObject({
      status: "ready",
      preview: { status: "not_requested" },
      summary: {
        systemCount: 3,
        routes: [{ systems: [{ id: 1 }, { id: 2 }, { id: 1 }], jumps: 2 }],
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "resource_link",
          mimeType: "image/svg+xml",
        }),
      ]),
    );
    const resources = await client.listResourceTemplates();
    expect(resources.resourceTemplates).toHaveLength(1);
    const read = await client.readResource({
      uri: `eve-map://artifacts/${id}/map.svg`,
    });
    expect(read.contents[0]).toMatchObject({
      mimeType: "image/svg+xml",
      text: expect.stringContaining('data-frame="boundary"'),
    });
    expect(read.contents[0]).toHaveProperty(
      "text",
      expect.stringContaining('data-poi-list="true"'),
    );
    expect(services.data.initialize).toHaveBeenCalledTimes(1);
    expect(services.artifacts.put).toHaveBeenCalledTimes(1);
  });
  it.each(["fail", "oversize", undefined] as const)(
    "keeps SVG on preview problem %s",
    async (preview) => {
      const { client } = await setup(preview ? { preview } : {});
      const result = await client.callTool({
        name: "render_eve_map",
        arguments: { ...request, preview: "png" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "partial",
        artifact: { mimeType: "image/svg+xml" },
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "MAP_PREVIEW_UNAVAILABLE" }),
        ]),
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    },
  );
  it("returns a PNG image and per-source stale metadata", async () => {
    const { client } = await setup({ preview: "ready", stale: true });
    const result = await client.callTool({
      name: "render_eve_map",
      arguments: { ...request, preview: "png" },
    });
    expect(result.structuredContent).toMatchObject({
      status: "ready",
      sources: { staticData: { stale: true } },
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "STALE_MAP_DATA" }),
      ]),
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        { type: "image", data: "cG5n", mimeType: "image/png" },
      ]),
    );
  });
  it("fails rather than calculating a missing route or extending the boundary", async () => {
    const { client, services } = await setup();
    for (const invalid of [
      { ...request, routes: [{ systems: [1, 3] }] },
      { ...request, boundary: { kind: "systems", systems: [1] } },
    ])
      expect(
        (await client.callTool({ name: "render_eve_map", arguments: invalid }))
          .isError,
      ).toBe(true);
    expect(services.artifacts.put).not.toHaveBeenCalled();
  });
  it("returns bounded resolution errors and generic adapter failures", async () => {
    const { client, services } = await setup();
    const unknown = await client.callTool({
      name: "render_eve_map",
      arguments: {
        ...request,
        boundary: { kind: "systems", systems: ["unknown"] },
      },
    });
    expect(unknown.structuredContent).toMatchObject({
      status: "needs_selection",
      code: "MAP_REFERENCE_UNKNOWN",
    });
    vi.mocked(services.data.initialize).mockRejectedValue(
      new MapError("MAP_DATA_UNAVAILABLE", "No map data"),
    );
    expect(
      (await client.callTool({ name: "render_eve_map", arguments: request }))
        .structuredContent,
    ).toMatchObject({ code: "MAP_DATA_UNAVAILABLE" });
    vi.mocked(services.data.initialize).mockRejectedValue(
      new Error("PRIVATE path"),
    );
    expect(
      JSON.stringify(
        await client.callTool({ name: "render_eve_map", arguments: request }),
      ),
    ).not.toContain("PRIVATE");
  });
  it("rejects non-artifact resource paths and unknown/expired artifacts", async () => {
    const { client, services } = await setup();
    for (const uri of [
      "eve-map://artifacts/no/map.svg",
      `eve-map://artifacts/${id}/secret`,
      `eve-map://artifacts/${id}/map.svg?x=1`,
    ])
      await expect(client.readResource({ uri })).rejects.toThrow();
    expect(services.artifacts.read).not.toHaveBeenCalled();
    vi.mocked(services.artifacts.read).mockRejectedValue(
      new Error("PRIVATE store"),
    );
    await expect(
      client.readResource({ uri: `eve-map://artifacts/${id}/map.svg` }),
    ).rejects.toThrow(/unavailable or expired/);
  });
  it("uses an embedded SVG fallback for a legacy negotiated version", async () => {
    const { client } = await setup({ legacy: true });
    const result = await client.callTool({
      name: "render_eve_map",
      arguments: request,
    });
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "resource" })]),
    );
  });
  it("does not capture POI notes, full routes or artifact handles in diagnostics", () => {
    expect(TOOL_NAMES.has("render_eve_map")).toBe(true);
    const input = projectInput({
      ...request,
      title: "PRIVATE",
      pointsOfInterest: [{ system: 1, label: "PRIVATE" }],
    });
    expect(input.complete).toBe(false);
    expect(JSON.stringify(input)).not.toContain("PRIVATE");
    expect(
      JSON.stringify(
        projectOutput({
          artifact: { id, uri: `eve-map://artifacts/${id}/map.svg` },
          summary: { routes: ["PRIVATE"] },
        }),
      ),
    ).not.toContain("PRIVATE");
  });
});
