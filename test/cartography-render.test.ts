import { afterEach, describe, expect, it, vi } from "vitest";
import { MapCatalog } from "../src/cartography/catalog.js";
import {
  ATLAS_MAX_DISPLACEMENT,
  contains,
  distanceToSegment,
  overlaps,
  present,
  textWidth,
  wrapText,
} from "../src/cartography/layout.js";
import type { Box } from "../src/cartography/layout.js";
import { renderMap } from "../src/cartography/render.js";
import {
  LIGHT_YEAR_METRES,
  MAP_LIMITS,
  MapError,
  mapRequestSchema,
} from "../src/cartography/types.js";
import type {
  MapData,
  MapRequest,
  MapSystem,
} from "../src/cartography/types.js";

// Entirely synthetic Alpha/Beta test topology, not actual EVE systems or gates.
function system(
  id: number,
  name: string,
  x: number,
  z: number,
  extra: Partial<MapSystem> = {},
): MapSystem {
  return {
    id,
    name,
    regionId: 100,
    constellationId: 200,
    position: { x: x * LIGHT_YEAR_METRES, y: 0, z: z * LIGHT_YEAR_METRES },
    position2D: { x, y: z },
    securityStatus: 0.449999,
    ...extra,
  };
}

function fixture(): MapData {
  const pairs: [number, number][] = [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
  ];
  return {
    schemaVersion: 1,
    buildNumber: 42,
    releaseDate: "2026-09-01T00:00:00Z",
    sourceUrl: "https://example.invalid/synthetic-sde",
    fetchedAt: "2026-09-02T00:00:00Z",
    systems: [
      system(1, "Alpha", 0, 0),
      system(2, "Beta", 4, 3),
      system(3, "Gamma", 8, 0),
      system(4, "Delta", 8, 6, { constellationId: 201 }),
      system(5, "Epsilon", 12, 6, { regionId: 101, constellationId: 202 }),
    ],
    regions: [
      { id: 100, name: "Synthetic Region" },
      { id: 101, name: "Other Test Region" },
    ],
    constellations: [
      { id: 200, name: "Synthetic Constellation", regionId: 100 },
      { id: 201, name: "Second Test Constellation", regionId: 100 },
      { id: 202, name: "Outside Constellation", regionId: 101 },
    ],
    gates: pairs.flatMap(([from, to], index) => [
      {
        id: 1000 + index * 2,
        systemId: from,
        destinationId: to,
        destinationGateId: 1001 + index * 2,
      },
      {
        id: 1001 + index * 2,
        systemId: to,
        destinationId: from,
        destinationGateId: 1000 + index * 2,
      },
    ]),
  };
}

function request(overrides: Partial<MapRequest> = {}): MapRequest {
  return mapRequestSchema.parse({
    boundary: { kind: "systems", systems: [1, 2, 3] },
    pointsOfInterest: [],
    ...overrides,
  });
}

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [
      present(match[1]),
      present(match[2]),
    ]),
  );
}

function nodes(svg: string) {
  return [...svg.matchAll(/<g data-system-id="[^>]+>/g)].map(([tag]) => {
    const attr = attributes(tag);
    return {
      id: Number(attr["data-system-id"]),
      x: Number(attr["data-x"]),
      y: Number(attr["data-y"]),
      radius: Number(attr["data-radius"]),
    };
  });
}

function labels(svg: string) {
  return [...svg.matchAll(/<g data-label-for="[^>]+>/g)].map(([tag]) => {
    const attr = attributes(tag);
    return {
      id: Number(attr["data-label-for"]),
      x: Number(attr["data-x"]),
      y: Number(attr["data-y"]),
      width: Number(attr["data-width"]),
      height: Number(attr["data-height"]),
    };
  });
}

function assertGeometry(svg: string, width = 1440) {
  const allNodes = nodes(svg);
  const allLabels = labels(svg);
  const frame = attributes(
    present(/<rect\b[^>]*data-frame="boundary"[^>]*>/.exec(svg))[0],
  );
  const bounds = {
    x: Number(frame.x),
    y: Number(frame.y),
    width: Number(frame.width),
    height: Number(frame.height),
  };
  for (const [index, label] of allLabels.entries()) {
    expect(contains(bounds, label)).toBe(true);
    for (const other of allLabels.slice(index + 1))
      expect(overlaps(label, other, 4)).toBe(false);
    for (const node of allNodes)
      expect(
        overlaps(
          label,
          {
            x: node.x - node.radius,
            y: node.y - node.radius,
            width: node.radius * 2,
            height: node.radius * 2,
          },
          3,
        ),
      ).toBe(false);
  }
  for (const [index, node] of allNodes.entries()) {
    expect(
      contains(bounds, {
        x: node.x - node.radius,
        y: node.y - node.radius,
        width: node.radius * 2,
        height: node.radius * 2,
      }),
    ).toBe(true);
    for (const other of allNodes.slice(index + 1))
      expect(
        Math.hypot(node.x - other.x, node.y - other.y),
      ).toBeGreaterThanOrEqual(node.radius + other.radius + 7.9);
  }
  for (const [tag] of svg.matchAll(/<path data-route="[^>]+>/g)) {
    const attr = attributes(tag);
    const values = present(present(attr.d).match(/-?\d+(?:\.\d+)?/g)).map(
      Number,
    );
    const [x1, y1, cx, cy, x2, y2] = values as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const from = present(
      allNodes.find((node) => node.id === Number(attr["data-from"])),
    );
    const to = present(
      allNodes.find((node) => node.id === Number(attr["data-to"])),
    );
    expect([x1, y1, x2, y2]).toEqual([from.x, from.y, to.x, to.y]);
    let previous = { x: x1, y: y1 };
    for (let i = 1; i <= 200; i++) {
      const t = i / 200;
      const u = 1 - t;
      const point = {
        x: u * u * x1 + 2 * u * t * cx + t * t * x2,
        y: u * u * y1 + 2 * u * t * cy + t * t * y2,
      };
      for (const node of allNodes.filter(
        (node) => node.id !== from.id && node.id !== to.id,
      ))
        expect(distanceToSegment(node, previous, point)).toBeGreaterThan(
          node.radius + 9,
        );
      for (const label of allLabels)
        expect(
          overlaps(
            label,
            {
              x: Math.min(previous.x, point.x),
              y: Math.min(previous.y, point.y),
              width: Math.abs(point.x - previous.x),
              height: Math.abs(point.y - previous.y),
            },
            3,
          ),
        ).toBe(false);
      previous = point;
    }
  }
  for (const [tag] of svg.matchAll(/<text\b[^>]*>/g)) {
    const attr = attributes(tag);
    expect(Number(attr.x)).toBeGreaterThanOrEqual(20);
    expect(
      Number(attr.x) + Number(attr["data-text-width"]),
    ).toBeLessThanOrEqual(width - 20);
    expect(Number(attr.y) - Number(attr["font-size"])).toBeGreaterThanOrEqual(
      20,
    );
    expect(Number(attr.y) + Number(attr["font-size"]) / 4).toBeLessThanOrEqual(
      880,
    );
  }
  const gateLayer = present(
    /<g data-gates="true" mask="url\(#gate-label-mask\)">([\s\S]*?)<\/g>/.exec(
      svg,
    ),
  )[1];
  expect(gateLayer).not.toMatch(/data-route=|data-system-id=|data-label-for=/);
  for (const [tag] of present(gateLayer).matchAll(/<path data-gate="[^>]+>/g)) {
    const attr = attributes(tag);
    const [from, to] = present(attr["data-gate"]).split(":").map(Number);
    const coordinates = present(present(attr.d).match(/-?\d+(?:\.\d+)?/g)).map(
      Number,
    );
    const start = present(allNodes.find((node) => node.id === from));
    const end = present(allNodes.find((node) => node.id === to));
    expect(coordinates.slice(0, 2)).toEqual([start.x, start.y]);
    expect(coordinates.slice(-2)).toEqual([end.x, end.y]);
  }
  const mask = present(
    /<mask id="gate-label-mask"[^>]*>([\s\S]*?)<\/mask>/.exec(svg),
  )[1];
  const cutouts = [
    ...present(mask).matchAll(/<rect data-label-cutout="[^>]+>/g),
  ].map(([tag]) => {
    const attr = attributes(tag);
    expect(attr.fill).toBe("#000000");
    return {
      id: Number(attr["data-label-cutout"]),
      x: Number(attr.x),
      y: Number(attr.y),
      width: Number(attr.width),
      height: Number(attr.height),
    };
  });
  for (const [group, id] of svg.matchAll(
    /<g data-label-for="(\d+)"[^>]*>[\s\S]*?<\/g>/g,
  )) {
    for (const [tag] of group.matchAll(/<text\b[^>]*>/g)) {
      const attr = attributes(tag);
      const line = {
        x: Number(attr.x) - 2,
        y: Number(attr.y) - Number(attr["font-size"]),
        width: Number(attr["data-text-width"]) + 4,
        height: Number(attr["font-size"]) + 5,
      };
      expect(
        cutouts.some(
          (cutout) => cutout.id === Number(id) && contains(cutout, line),
        ),
      ).toBe(true);
    }
  }
}

function expectCode(action: () => unknown, code: string) {
  expect(action).toThrow(MapError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local pure SVG cartography renderer", () => {
  it.each(["dark", "light"] as const)(
    "keeps natural glyph proportions and centered markers in %s exports",
    (theme) => {
      const result = renderMap(
        new MapCatalog(fixture()),
        request({
          theme,
          title: "Wide WWW / narrow iii",
          pointsOfInterest: [{ system: 1, label: "WWW iii", kind: "staging" }],
          routes: [{ systems: [1, 2] }],
        }),
      );
      expect(result.svg).toContain('preserveAspectRatio="xMidYMid meet"');
      expect(result.svg).toContain(
        'font-family="DejaVu Sans, Arial, Helvetica, sans-serif"',
      );
      for (const [tag] of result.svg.matchAll(/<text\b[^>]*>/g)) {
        const attr = attributes(tag);
        expect(attr).not.toHaveProperty("textLength");
        expect(attr).not.toHaveProperty("lengthAdjust");
        expect(attr).not.toHaveProperty("transform");
        expect(Number(attr["data-text-width"])).toBeGreaterThan(0);
      }
      const point = present(nodes(result.svg).find((node) => node.id === 1));
      expect(result.svg).toContain(`<text x="${point.x}" y="${point.y + 6}"`);
      expect(result.svg).toContain(
        'text-anchor="middle" font-weight="700">1</text>',
      );
      assertGeometry(result.svg);
    },
  );
  it("renders an accessible, framed stellar atlas and a linked POI rail", () => {
    const result = renderMap(
      new MapCatalog(fixture()),
      request({
        pointsOfInterest: [
          {
            system: "Alpha",
            label: "Test staging",
            kind: "staging",
            note: "Synthetic annotation only.",
          },
        ],
        routes: [{ systems: [1, 2, 3], label: "Caller test path" }],
      }),
    );
    expect(result).toMatchObject({
      width: 1440,
      height: 900,
      summary: {
        systemCount: 3,
        edgeCount: 2,
        routes: [{ jumps: 2, systems: [{ id: 1 }, { id: 2 }, { id: 3 }] }],
        pointsOfInterest: [{ systemId: 1, label: "Test staging" }],
      },
      completeness: { omittedLabels: 0, boundaryConnections: 1 },
    });
    expect(result.svg).toContain(
      'role="img" aria-labelledby="map-title map-desc"',
    );
    expect(result.svg).toContain('data-frame="outer"');
    expect(result.svg).toContain('data-frame="boundary"');
    expect(result.svg).toContain('data-poi-list="true"');
    expect(result.svg).toContain('data-poi="1" data-system-id="1"');
    expect(result.svg).toContain("POINTS OF INTEREST");
    expect(result.svg).toContain("Caller-supplied plans \u2022 Not live intel");
    expect(result.svg).toContain("not to scale");
    expect(result.svg).toContain("SDE build 42 / 2026-09-01T00:00:00Z");
    expect(result.svg).toContain('font-size="22"');
    expect(result.svg).toContain('data-endpoint="true"');
    expect(result.svg).toContain('data-arrow="1:1"');
    expect(result.svg).not.toContain("<filter");
    expect(new TextEncoder().encode(result.svg).byteLength).toBeLessThanOrEqual(
      MAP_LIMITS.svgBytes,
    );
    assertGeometry(result.svg);
  });

  it("is deterministic under catalog and boundary insertion ordering, without I/O or time", () => {
    const firstData = fixture();
    const secondData = fixture();
    secondData.systems.reverse();
    secondData.gates.reverse();
    secondData.regions.reverse();
    secondData.constellations.reverse();
    const first = new MapCatalog(firstData);
    const second = new MapCatalog(secondData);
    const input = request();
    const before = JSON.stringify({ data: first.data, input });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("No network");
      }),
    );
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("No clock");
    });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("No random");
    });
    expect(renderMap(first, input)).toEqual(
      renderMap(
        second,
        request({ boundary: { kind: "systems", systems: [3, 1, 2, 1] } }),
      ),
    );
    expect(JSON.stringify({ data: first.data, input })).toBe(before);
  });

  it.each(["dark", "light"] as const)(
    "supports the %s palette and wide frame",
    (theme) => {
      const result = renderMap(
        new MapCatalog(fixture()),
        request({ theme, size: "wide" }),
      );
      expect(result.width).toBe(1600);
      expect(result.svg).toContain('viewBox="0 0 1600 900"');
      expect(result.svg).toContain(theme === "dark" ? "#0B1220" : "#F5F1E8");
      expect(result.svg).not.toContain('data-poi-list="true"');
      assertGeometry(result.svg, 1600);
    },
  );

  it.each(["dark", "light"] as const)(
    "draws only real system dots on the %s map, with no decorative stars",
    (theme) => {
      const result = renderMap(new MapCatalog(fixture()), request({ theme }));
      expect([...result.svg.matchAll(/<circle\b/g)]).toHaveLength(
        result.summary.systemCount,
      );
      expect(result.svg).not.toMatch(/<circle\b[^>]*\sr="1"/);
      assertGeometry(result.svg);
    },
  );

  it("uses only safe SVG elements and escapes catalog data and all annotations", () => {
    const data = fixture();
    present(data.systems[0]).name = "A<&\"'><script>";
    present(data.regions[0]).name = '<svg onload="bad">';
    data.sourceUrl = 'https://example.invalid/?x="/><script>alert(1)</script>';
    const result = renderMap(
      new MapCatalog(data),
      request({
        title: '<script>alert("x")</script>',
        boundary: { kind: "region", region: 100 },
        pointsOfInterest: [
          {
            system: 1,
            label: '<img onerror="bad">',
            kind: "warning",
            note: "</text><script>& \" ' </script>",
          },
        ],
        routes: [{ label: '<a href="evil">', systems: [1] }],
      }),
    );
    const tags = [...result.svg.matchAll(/<([A-Za-z][\w:-]*)\b/g)].map(
      (match) => match[1],
    );
    expect(new Set(tags)).toEqual(
      new Set([
        "svg",
        "title",
        "desc",
        "metadata",
        "rect",
        "text",
        "circle",
        "g",
        "path",
        "defs",
        "mask",
      ]),
    );
    expect(result.svg).toContain("&lt;script&gt;");
    expect(result.svg).toContain("&amp;");
    expect(result.svg).toContain("&quot;");
    expect(result.svg).toContain("&apos;");
    expect(result.svg).not.toMatch(/<[^>]+\s(?:on\w+|style|href|xlink:href)=/i);
    expect(
      result.svg.replaceAll('mask="url(#gate-label-mask)"', ""),
    ).not.toMatch(/<!DOCTYPE|<script|<foreignObject|<style|<image|<use|url\(/i);
    assertGeometry(result.svg);
  });

  it("rejects unsupported control characters before SVG generation", () => {
    expectCode(
      () =>
        renderMap(new MapCatalog(fixture()), {
          ...request(),
          title: "bad\u202Econtrol",
        }),
      "INVALID_MAP_REQUEST",
    );
  });

  it("requires both an explicit boundary and the POI array", () => {
    const catalog = new MapCatalog(fixture());
    expectCode(
      () =>
        renderMap(catalog, { pointsOfInterest: [] } as unknown as MapRequest),
      "INVALID_MAP_REQUEST",
    );
    expectCode(
      () =>
        renderMap(catalog, {
          boundary: { kind: "systems", systems: [1] },
        } as unknown as MapRequest),
      "INVALID_MAP_REQUEST",
    );
  });

  it.each([
    { kind: "region", region: "Synthetic Region" } as const,
    {
      kind: "constellation",
      constellation: "Synthetic Constellation",
    } as const,
  ])("selects all and only the explicit $kind members", (boundary) => {
    const result = renderMap(new MapCatalog(fixture()), request({ boundary }));
    expect(nodes(result.svg).map((node) => node.id)).toEqual(
      boundary.kind === "region" ? [1, 2, 3, 4] : [1, 2, 3],
    );
    expect(result.summary.boundaryLabel).toContain(
      boundary.kind === "region" ? "Region /" : "Constellation /",
    );
  });

  it("does not trim a region exceeding 250 systems", () => {
    const data = fixture();
    data.systems = Array.from({ length: 251 }, (_, index) =>
      system(index + 1, `Synthetic ${index + 1}`, index, 0),
    );
    data.gates = [];
    expectCode(
      () =>
        renderMap(
          new MapCatalog(data),
          request({ boundary: { kind: "region", region: 100 } }),
        ),
      "MAP_TOO_LARGE",
    );
  });

  it("accepts a complete 250-system boundary, preserving nodes and reporting omitted context labels", () => {
    const data = fixture();
    data.systems = Array.from({ length: 250 }, (_, index) =>
      system(
        index + 1,
        `Test ${index + 1}`,
        index % 25,
        Math.floor(index / 25),
      ),
    );
    data.gates = [];
    const result = renderMap(
      new MapCatalog(data),
      request({ boundary: { kind: "region", region: 100 } }),
    );
    expect(result.summary.systemCount).toBe(250);
    expect(nodes(result.svg)).toHaveLength(250);
    expect(result.completeness.omittedLabels).toBeGreaterThan(0);
    expect(labels(result.svg).length + result.completeness.omittedLabels).toBe(
      250,
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "CONTEXT_LABELS_OMITTED" }),
    );
    assertGeometry(result.svg);
  });

  it.each(["poi", "route"])(
    "rejects an out-of-boundary %s rather than expanding the map",
    (kind) => {
      const overrides: Partial<MapRequest> =
        kind === "poi"
          ? {
              pointsOfInterest: [
                { system: 4, label: "Outside", kind: "activity" },
              ],
            }
          : { routes: [{ systems: [3, 4] }] };
      expectCode(
        () => renderMap(new MapCatalog(fixture()), request(overrides)),
        "OUT_OF_BOUNDARY",
      );
    },
  );

  it.each([
    { boundary: { kind: "systems", systems: [999] } },
    { boundary: { kind: "region", region: "Missing" } },
    { boundary: { kind: "constellation", constellation: 999 } },
    {
      pointsOfInterest: [
        { system: "Missing", label: "No guess", kind: "activity" },
      ],
    },
    { routes: [{ systems: [1, 999] }] },
  ] as Partial<MapRequest>[])(
    "propagates unknown catalog references: %j",
    (overrides) => {
      expectCode(
        () => renderMap(new MapCatalog(fixture()), request(overrides)),
        "MAP_REFERENCE_UNKNOWN",
      );
    },
  );

  it("never plans missing hops or repairs an invalid route", () => {
    expectCode(
      () =>
        renderMap(
          new MapCatalog(fixture()),
          request({ routes: [{ systems: [1, 3] }] }),
        ),
      "INVALID_ROUTE_ADJACENCY",
    );
    expectCode(
      () =>
        renderMap(
          new MapCatalog(fixture()),
          request({ routes: [{ systems: [1, 1] }] }),
        ),
      "INVALID_ROUTE_ADJACENCY",
    );
  });

  it("propagates ambiguous catalog names rather than choosing a destination", () => {
    const data = fixture();
    present(data.systems[1]).name = "Alpha";
    expectCode(
      () =>
        renderMap(
          new MapCatalog(data),
          request({ boundary: { kind: "systems", systems: ["Alpha"] } }),
        ),
      "MAP_REFERENCE_AMBIGUOUS",
    );
  });

  it("preserves repeated visits and duplicate routes, including direction", () => {
    const result = renderMap(
      new MapCatalog(fixture()),
      request({
        boundary: { kind: "systems", systems: [1, 2] },
        routes: [
          { label: "Out and back", systems: [1, 2, 1] },
          { label: "Duplicate plan", systems: [1, 2, 1] },
        ],
      }),
    );
    expect(
      result.summary.routes.map((route) =>
        route.systems.map((item) => item.id),
      ),
    ).toEqual([
      [1, 2, 1],
      [1, 2, 1],
    ]);
    expect(result.summary.routes.map((route) => route.jumps)).toEqual([2, 2]);
    const paths = [...result.svg.matchAll(/<path data-route="[^>]+>/g)].map(
      ([tag]) => attributes(tag),
    );
    expect(
      paths.map((path) => [
        path["data-route"],
        path["data-hop"],
        path["data-from"],
        path["data-to"],
      ]),
    ).toEqual([
      ["1", "1", "1", "2"],
      ["1", "2", "2", "1"],
      ["2", "1", "1", "2"],
      ["2", "2", "2", "1"],
    ]);
    expect(new Set(paths.map((path) => path.d)).size).toBe(4);
    expect(result.svg).toContain('stroke-dasharray="12 6"');
    expect(result.svg).toContain(
      "R1 start/end: Out and back; visits 1, 3 of 3",
    );
    expect(result.svg).toContain(
      "R2 start/end: Duplicate plan; visits 1, 3 of 3",
    );
    assertGeometry(result.svg);
  });

  it("validates directed gates without synthesizing a missing reverse edge", () => {
    const data = fixture();
    data.gates = [present(data.gates[0])];
    const catalog = new MapCatalog(data);
    expect(
      present(
        renderMap(
          catalog,
          request({
            boundary: { kind: "systems", systems: [1, 2] },
            routes: [{ systems: [1, 2] }],
          }),
        ).summary.routes[0],
      ).jumps,
    ).toBe(1);
    expectCode(
      () => renderMap(catalog, request({ routes: [{ systems: [2, 1] }] })),
      "INVALID_ROUTE_ADJACENCY",
    );
  });

  it.each(["dark", "light"] as const)(
    "distinguishes all three routes without relying on %s colors alone",
    (theme) => {
      const result = renderMap(
        new MapCatalog(fixture()),
        request({
          theme,
          boundary: { kind: "systems", systems: [1, 2] },
          routes: [
            { systems: [1, 2] },
            { systems: [1, 2] },
            { systems: [1, 2] },
          ],
        }),
      );
      expect(result.summary.routes).toHaveLength(3);
      expect(result.svg).toContain('stroke-dasharray="12 6"');
      expect(result.svg).toContain('stroke-dasharray="3 6"');
      expect(result.svg).toContain('data-arrow="3:1"');
      expect(result.svg).toContain("R3 start");
      const colors = [...result.svg.matchAll(/<path data-route="[^>]+>/g)].map(
        ([tag]) => attributes(tag).stroke,
      );
      expect(new Set(colors).size).toBe(3);
      assertGeometry(result.svg);
    },
  );

  it("lists multiple caller-selected POIs at one system without deduplicating annotations", () => {
    const result = renderMap(
      new MapCatalog(fixture()),
      request({
        pointsOfInterest: [
          { system: 1, label: "First activity", kind: "activity" },
          { system: 1, label: "Second activity", kind: "waypoint" },
        ],
      }),
    );
    expect(result.summary.pointsOfInterest).toHaveLength(2);
    expect(result.svg).toContain('data-poi="1" data-system-id="1"');
    expect(result.svg).toContain('data-poi="2" data-system-id="1"');
    expect(result.svg).toContain("P1 / P2");
    assertGeometry(result.svg);
  });

  it("keeps a single-node route and shows approximate numeric security without classification", () => {
    const result = renderMap(
      new MapCatalog(fixture()),
      request({
        boundary: { kind: "systems", systems: [1] },
        routes: [{ systems: [1] }],
      }),
    );
    expect(result.summary.routes[0]).toMatchObject({
      jumps: 0,
      systems: [{ id: 1 }],
    });
    expect(nodes(result.svg)).toHaveLength(1);
    expect(result.svg).toContain("sec ~0.45");
    expect(result.svg).toContain("raw security 0.449999");
    expect(result.svg).toContain("R1 start/end");
    expect(result.svg).not.toMatch(/highsec|lowsec|nullsec|secure route/i);
    expect(result.svg).not.toContain("data-route=");
    assertGeometry(result.svg);
  });

  it.each([
    { raw: 0.4499999910593033, display: "0.45" },
    { raw: -0.56789123456789, display: "-0.57" },
    { raw: -0.0000123456789, display: "-0.00" },
    { raw: 1, display: "1.00" },
    { raw: 0, display: "0.00" },
    { raw: 1e30, display: "1.00e+30" },
  ])(
    "keeps intermediate labels to two readable lines for security $raw",
    ({ raw, display }) => {
      const data = fixture();
      present(data.systems[1]).securityStatus = raw;
      const result = renderMap(
        new MapCatalog(data),
        request({ routes: [{ label: "Caller path", systems: [1, 2, 3] }] }),
      );
      const label = present(
        /<g data-label-for="2"[^>]*>([\s\S]*?)<\/g>/.exec(result.svg),
      )[0];
      const text = [...label.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)];
      expect(text.map((match) => match[1])).toEqual([
        "Beta",
        `sec ~${display} | 2 gates`,
      ]);
      expect(text.map(([tag]) => attributes(tag)["font-size"])).toEqual([
        "22",
        "18",
      ]);
      expect(label).toContain(`raw security ${raw}`);
      expect(label).toContain("Beta (ID 2)");
      expect(label).toContain(
        "region Synthetic Region; constellation Synthetic Constellation",
      );
      expect(label).toContain("R1: Caller path; visits 2 of 3");
      expect(result.svg).not.toMatch(/highsec|lowsec|nullsec|secure route/i);
      expect(
        present(labels(result.svg).find((item) => item.id === 2)).height,
      ).toBe(52);
      assertGeometry(result.svg);
    },
  );

  it("counts outgoing catalog gates, including out-of-boundary links, without adding them to the map", () => {
    const result = renderMap(
      new MapCatalog(fixture()),
      request({ routes: [{ systems: [1, 2, 3] }] }),
    );
    const label = present(
      /<g data-label-for="3"[^>]*>[\s\S]*?<\/g>/.exec(result.svg),
    )[0];
    expect(label).toContain("sec ~0.45 | 2 gates");
    expect(label).toContain(
      "2 outgoing SDE gates, including connections outside this boundary",
    );
    expect(result.summary.edgeCount).toBe(2);
    expect(result.completeness.boundaryConnections).toBe(1);
    expect(nodes(result.svg).map((node) => node.id)).toEqual([1, 2, 3]);
  });

  it("counts distinct outgoing gates even when they share a destination system", () => {
    const data = fixture();
    data.gates.push(
      { id: 2000, systemId: 2, destinationId: 3, destinationGateId: 2001 },
      { id: 2001, systemId: 3, destinationId: 2, destinationGateId: 2000 },
    );
    const result = renderMap(
      new MapCatalog(data),
      request({ routes: [{ systems: [1, 2, 3] }] }),
    );
    const label = present(
      /<g data-label-for="2"[^>]*>[\s\S]*?<\/g>/.exec(result.svg),
    )[0];
    expect(label).toContain("sec ~0.45 | 3 gates");
    expect(result.summary.edgeCount).toBe(2);
    assertGeometry(result.svg);
  });

  it("uses all position2D coordinates or falls back for the whole atlas view", () => {
    const data = fixture();
    present(data.systems[0]).position2D = { x: 500, y: 500 };
    const atlas = renderMap(new MapCatalog(data), request());
    expect(atlas.layout.coordinateBasis).toContain("position2D");
    delete present(data.systems[1]).position2D;
    const fallback = renderMap(new MapCatalog(data), request());
    const geographic = renderMap(
      new MapCatalog(data),
      request({ layout: "geographic" }),
    );
    expect(fallback.layout.coordinateBasis).toContain("X/Z light years");
    expect(nodes(fallback.svg)).toEqual(nodes(geographic.svg));
    expect(fallback.warnings).toContainEqual(
      expect.objectContaining({ code: "ATLAS_XZ_FALLBACK" }),
    );
  });

  it("selects inclusive extents, fixes their X/Z viewport, and never zooms to POIs", () => {
    const catalog = new MapCatalog(fixture());
    const boundary = {
      kind: "extent",
      minX: 0,
      maxX: 8,
      minZ: 0,
      maxZ: 6,
    } as const;
    const first = renderMap(
      catalog,
      request({
        boundary,
        pointsOfInterest: [{ system: 1, label: "First", kind: "activity" }],
      }),
    );
    const second = renderMap(
      catalog,
      request({
        boundary,
        pointsOfInterest: [{ system: 4, label: "Other", kind: "activity" }],
      }),
    );
    expect(first.layout).toMatchObject({
      requested: "atlas",
      used: "geographic",
    });
    expect(nodes(first.svg).map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      nodes(second.svg).map(({ id, x, y }) => ({ id, x, y })),
    );
    expect(nodes(first.svg).map((node) => node.id)).toEqual([1, 2, 3, 4]);
    const alpha = present(nodes(first.svg).find((node) => node.id === 1));
    const gamma = present(nodes(first.svg).find((node) => node.id === 3));
    const delta = present(nodes(first.svg).find((node) => node.id === 4));
    expect(alpha.x).toBeLessThan(gamma.x);
    expect(delta.y).toBeLessThan(gamma.y);
    expect((gamma.x - alpha.x) / (gamma.y - delta.y)).toBeCloseTo(8 / 6, 3);
    const larger = renderMap(
      catalog,
      request({
        boundary: { kind: "extent", minX: -20, maxX: 20, minZ: -15, maxZ: 15 },
      }),
    );
    const extentNodes = nodes(larger.svg);
    expect(
      present(extentNodes.find((node) => node.id === 3)).x -
        present(extentNodes[0]).x,
    ).toBeLessThan(gamma.x - alpha.x);
    expectCode(
      () =>
        renderMap(
          catalog,
          request({
            boundary: {
              kind: "extent",
              minX: -80,
              maxX: 80,
              minZ: -60,
              maxZ: 60,
            },
          }),
        ),
      "MAP_TOO_DENSE",
    );
    assertGeometry(first.svg);
  });

  it.each([
    { minX: 0, maxX: 0, minZ: 0, maxZ: 1 },
    { minX: 0, maxX: 1, minZ: 0, maxZ: 0 },
    { minX: 1, maxX: -1, minZ: 0, maxZ: 1 },
    { minX: 0, maxX: Infinity, minZ: 0, maxZ: 1 },
  ])("rejects degenerate/invalid supplied extents: %j", (extent) => {
    expectCode(
      () =>
        renderMap(new MapCatalog(fixture()), {
          ...request(),
          boundary: { kind: "extent", ...extent },
        }),
      "INVALID_MAP_REQUEST",
    );
  });

  it("rejects an empty extent rather than substituting a POI-based view", () => {
    expectCode(
      () =>
        renderMap(
          new MapCatalog(fixture()),
          request({
            boundary: {
              kind: "extent",
              minX: 100,
              maxX: 101,
              minZ: 100,
              maxZ: 101,
            },
          }),
        ),
      "EMPTY_MAP_BOUNDARY",
    );
  });

  it("centers zero-span data and separates duplicate atlas coordinates deterministically", () => {
    const data = fixture();
    data.systems = [system(1, "Alpha", 0, 0), system(2, "Beta", 0, 0)];
    data.gates = [];
    const catalog = new MapCatalog(data);
    const input = request({ boundary: { kind: "systems", systems: [1, 2] } });
    const result = renderMap(catalog, input);
    expect(result).toEqual(renderMap(catalog, input));
    expect(result.warnings).toContainEqual({
      code: "ATLAS_NODES_SEPARATED",
      message:
        "Overlapping atlas nodes were separated deterministically, by at most 24 SVG pixels.",
    });
    expect(ATLAS_MAX_DISPLACEMENT).toBe(24);
    for (const node of nodes(result.svg))
      expect(Math.hypot(node.x - 720, node.y - 441)).toBeLessThanOrEqual(
        24.001,
      );
    expect(result.svg).not.toMatch(/NaN|Infinity/);
    assertGeometry(result.svg);
    expectCode(
      () => renderMap(catalog, { ...input, layout: "geographic" }),
      "MAP_TOO_DENSE",
    );
  });

  it("caps even important duplicate atlas nodes at 24px from their projected anchors", () => {
    const data = fixture();
    data.systems = [system(1, "Alpha", 0, 0), system(2, "Beta", 0, 0)];
    data.gates = data.gates.slice(0, 2);
    const catalog = new MapCatalog(data);
    const input = request({
      boundary: { kind: "systems", systems: [1, 2] },
      routes: [{ systems: [1, 2] }],
    });
    const result = renderMap(catalog, input);
    const distances = nodes(result.svg).map((node) =>
      Math.hypot(node.x - 720, node.y - 441),
    );
    expect(distances.every((distance) => distance <= 24.001)).toBe(true);
    expect(distances.some((distance) => distance > 23.9)).toBe(true);
    expect(result).toEqual(renderMap(catalog, input));
    assertGeometry(result.svg);
  });

  it("rejects important collisions that cannot fit within the 24px atlas displacement limit", () => {
    const data = fixture();
    data.systems = [
      system(1, "Alpha", 0, 0),
      system(2, "Beta", 0, 0),
      system(3, "Gamma", 0, 0),
    ];
    data.gates = data.gates.slice(0, 4);
    const render = () =>
      renderMap(
        new MapCatalog(data),
        request({ routes: [{ systems: [1, 2, 3] }] }),
      );
    expectCode(render, "MAP_TOO_DENSE");
    expect(render).toThrow("24px displacement bound");
  });

  it("handles one-axis zero spans without moving geographic nodes", () => {
    const data = fixture();
    data.systems = [
      system(1, "Alpha", 2, 0),
      system(2, "Beta", 2, 8),
      system(3, "Gamma", 2, 4),
    ];
    data.gates = [];
    const result = renderMap(
      new MapCatalog(data),
      request({ layout: "geographic" }),
    );
    expect(new Set(nodes(result.svg).map((node) => node.x)).size).toBe(1);
    expect(
      result.warnings.some(
        (warning) => warning.code === "ATLAS_NODES_SEPARATED",
      ),
    ).toBe(false);
    assertGeometry(result.svg);
  });

  it("curves a supplied gate route around an unrelated collinear node", () => {
    const data = fixture();
    data.systems = [
      system(1, "Alpha", 0, 0),
      system(2, "Beta", 8, 0),
      system(3, "Gamma", 4, 0),
    ];
    data.gates = data.gates.slice(0, 2);
    const result = renderMap(
      new MapCatalog(data),
      request({ layout: "geographic", routes: [{ systems: [1, 2] }] }),
    );
    expect(
      present(result.summary.routes[0]).systems.map((node) => node.id),
    ).toEqual([1, 2]);
    const gate = attributes(
      present(/<path data-gate="1:2"[^>]+>/.exec(result.svg))[0],
    );
    const route = attributes(
      present(/<path data-route="1"[^>]+>/.exec(result.svg))[0],
    );
    expect(gate.d).toBe(route.d);
    assertGeometry(result.svg);
  });

  it.each(["dark", "light"] as const)(
    "masks a background gate beneath label text without altering adjacency in %s",
    (theme) => {
      const data = fixture();
      data.systems = [
        system(1, "Alpha", 4, 0),
        system(2, "Beta", 0, 0),
        system(3, "Gamma", 8, 0),
      ];
      data.gates = [
        { id: 1000, systemId: 1, destinationId: 3, destinationGateId: 1001 },
        { id: 1001, systemId: 3, destinationId: 1, destinationGateId: 1000 },
      ];
      const result = renderMap(
        new MapCatalog(data),
        request({ theme, layout: "geographic" }),
      );
      const start = present(nodes(result.svg).find((node) => node.id === 1));
      const end = present(nodes(result.svg).find((node) => node.id === 3));
      const label = present(labels(result.svg).find((item) => item.id === 1));
      expect(label.x).toBeGreaterThan(start.x);
      expect(label.x + label.width).toBeLessThan(end.x);
      expect(start.y).toBeGreaterThan(label.y);
      expect(start.y).toBeLessThan(label.y + label.height);
      const gate = attributes(
        present(/<path data-gate="1:3"[^>]*>/.exec(result.svg))[0],
      );
      expect(gate.d).toBe(`M ${start.x} ${start.y} L ${end.x} ${end.y}`);
      expect(result.summary.edgeCount).toBe(1);
      expect([...result.svg.matchAll(/\bmask="/g)]).toHaveLength(1);
      expect(result.svg).toContain('mask="url(#gate-label-mask)"');
      assertGeometry(result.svg);
    },
  );

  it("wraps long notes and long words without tiny text or annotation truncation", () => {
    const note =
      "A".repeat(100) + " Synthetic test note that must wrap in the rail.";
    const result = renderMap(
      new MapCatalog(fixture()),
      request({
        pointsOfInterest: [
          { system: 1, label: "Long annotation", kind: "warning", note },
        ],
      }),
    );
    expect(present(result.summary.pointsOfInterest[0]).note).toBe(note);
    const rail = result.svg.slice(
      result.svg.indexOf('<g data-poi-list="true">'),
    );
    const railTexts = [...rail.matchAll(/<text\b[^>]*>/g)].map(([tag]) =>
      attributes(tag),
    );
    for (const attr of railTexts.slice(0, -1)) {
      expect(Number(attr["font-size"])).toBeGreaterThanOrEqual(18);
      expect(Number(attr.x) + Number(attr["data-text-width"])).toBeLessThan(
        1400,
      );
      expect(Number(attr.y)).toBeLessThan(834);
    }
    expect(result.svg).not.toContain("...");
  });

  it("fails explicitly when full POI notes cannot fit in the rail", () => {
    expectCode(
      () =>
        renderMap(
          new MapCatalog(fixture()),
          request({
            pointsOfInterest: Array.from({ length: 12 }, (_, index) => ({
              system: 1,
              label: `Test point ${index + 1}`,
              kind: "activity" as const,
              note: "Synthetic annotation ".repeat(7),
            })),
          }),
        ),
      "MAP_TOO_DENSE",
    );
  });

  it("fails explicitly for irreducible density rather than hiding selected systems", () => {
    const data = fixture();
    data.systems = Array.from({ length: 250 }, (_, index) =>
      system(index + 1, `Synthetic ${index + 1}`, 0, 0),
    );
    data.gates = [];
    expectCode(
      () =>
        renderMap(
          new MapCatalog(data),
          request({ boundary: { kind: "region", region: 100 } }),
        ),
      "MAP_TOO_DENSE",
    );
  });

  it("fails explicitly when an important label has no readable placement", () => {
    const data = fixture();
    present(data.systems[0]).name = "W".repeat(100);
    const input = request({
      pointsOfInterest: Array.from({ length: 12 }, (_, index) => ({
        system: 1,
        label: `Point ${index + 1}`,
        kind: "activity" as const,
      })),
      routes: Array.from({ length: 3 }, () => ({ systems: [1] })),
    });
    expectCode(() => renderMap(new MapCatalog(data), input), "MAP_TOO_DENSE");
  });

  it("never drops repeated traversals when the distinct curve budget is exhausted", () => {
    expectCode(
      () =>
        renderMap(
          new MapCatalog(fixture()),
          request({
            boundary: { kind: "systems", systems: [1, 2] },
            routes: [
              {
                systems: Array.from(
                  { length: 15 },
                  (_, index) => (index % 2) + 1,
                ),
              },
            ],
          }),
        ),
      "MAP_TOO_DENSE",
    );
  });

  it("enforces the UTF-8 SVG byte limit including escaped source metadata", () => {
    const data = fixture();
    data.sourceUrl = `https://example.invalid/${"a".repeat(MAP_LIMITS.svgBytes)}`;
    expectCode(
      () => renderMap(new MapCatalog(data), request()),
      "MAP_OUTPUT_TOO_LARGE",
    );
  });

  it("measures deterministic wrapping including wide Unicode and tests boxes", () => {
    expect(textWidth("WWW", 18)).toBeGreaterThan(textWidth("iii", 18) * 2);
    expect(textWidth("MW@%& mw / () [] {} `", 18)).toBeGreaterThan(100);
    expect(
      wrapText("WWWWWWWWWWWW", 22, 240).every(
        (line) => textWidth(line, 22) <= 240,
      ),
    ).toBe(true);
    const lines = wrapText(
      "Alpha Beta " + "X".repeat(40) + " \u661f\u7a7a",
      18,
      100,
    );
    expect(lines.every((line) => textWidth(line, 18) <= 100)).toBe(true);
    expect(lines.join("").replaceAll(" ", "")).toBe(
      ("Alpha Beta " + "X".repeat(40) + " \u661f\u7a7a").replaceAll(" ", ""),
    );
    const box: Box = { x: 1, y: 1, width: 10, height: 10 };
    expect(contains(box, box)).toBe(true);
    expect(overlaps(box, { ...box, x: 12 })).toBe(false);
    expect(
      distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }),
    ).toBe(5);
    expectCode(() => {
      present(undefined);
    }, "INVALID_MAP_DATA");
  });

  it("rejects finite but unprojectable coordinate spans without emitting invalid SVG", () => {
    const data = fixture();
    present(data.systems[0]).position2D = { x: -Number.MAX_VALUE, y: 0 };
    present(data.systems[1]).position2D = { x: Number.MAX_VALUE, y: 0 };
    expectCode(
      () => renderMap(new MapCatalog(data), request()),
      "INVALID_MAP_DATA",
    );
  });
});
