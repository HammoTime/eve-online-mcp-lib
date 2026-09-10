import { describe, expect, it } from "vitest";
import { MapCatalog } from "../src/cartography/catalog.js";
import { present } from "../src/cartography/layout.js";
import {
  createPreparedMapScene,
  enumerateMapReferences,
  mapReferenceQuery,
  prepareMapScene,
  readPreparedMapScene,
  resolveMapBoundary,
  resolveMapReference,
  type PreparedMapFacts,
  type PreparedMapScene,
} from "../src/cartography/prepared.js";
import { renderMap, renderPreparedMap } from "../src/cartography/render.js";
import {
  LIGHT_YEAR_METRES,
  MAP_LIMITS,
  MapError,
  mapRequestSchema,
  type MapData,
  type MapRequest,
} from "../src/cartography/types.js";

function fixture(): MapData {
  return {
    schemaVersion: 1,
    buildNumber: 42,
    releaseDate: "2026-09-01T00:00:00Z",
    fetchedAt: "2026-09-02T00:00:00Z",
    sourceUrl: "https://example.invalid/synthetic",
    regions: [
      { id: 100, name: "Region" },
      { id: 101, name: "Outside" },
    ],
    constellations: [
      { id: 200, name: "Constellation", regionId: 100 },
      { id: 201, name: "Elsewhere", regionId: 101 },
    ],
    systems: ["Alpha", "Beta", "1", "Delta", "Epsilon"].map((name, index) => ({
      id: index + 1,
      name,
      regionId: index < 3 ? 100 : 101,
      constellationId: index < 3 ? 200 : 201,
      position: {
        x: index * 4 * LIGHT_YEAR_METRES,
        y: 1.234567891234567e18,
        z: (index % 2) * 3 * LIGHT_YEAR_METRES,
      },
      position2D: { x: index * 4, y: (index % 2) * 3 },
      securityStatus: 0.4499999910593033,
    })),
    gates: [
      { id: 10, systemId: 1, destinationId: 2, destinationGateId: 11 },
      { id: 11, systemId: 2, destinationId: 1, destinationGateId: 10 },
      { id: 12, systemId: 1, destinationId: 2, destinationGateId: 13 },
      { id: 14, systemId: 2, destinationId: 3, destinationGateId: 15 },
      { id: 16, systemId: 4, destinationId: 1, destinationGateId: 17 },
      { id: 18, systemId: 3, destinationId: 5, destinationGateId: 19 },
      { id: 20, systemId: 3, destinationId: 5, destinationGateId: 21 },
    ],
  };
}
function request(overrides: Partial<MapRequest> = {}): MapRequest {
  return mapRequestSchema.parse({
    boundary: { kind: "systems", systems: [1, 2, 3] },
    pointsOfInterest: [],
    ...overrides,
  });
}

// Independent selected-fact provider: no MapCatalog or prepareMapScene shortcut.
function facts(data: MapData, input: MapRequest): PreparedMapFacts {
  const resolutions = enumerateMapReferences(input).map((query) => {
    const all =
      query.category === "system"
        ? data.systems
        : query.category === "region"
          ? data.regions
          : data.constellations;
    const matches = all
      .filter((item) =>
        typeof query.reference === "number"
          ? item.id === query.reference
          : item.name.trim().toLowerCase() === query.reference,
      )
      .sort((a, b) => a.id - b.id);
    return {
      key: query.key,
      candidateCount: matches.length,
      candidates: matches
        .slice(0, 10)
        .map(({ id, name }) => ({ id, name: name.trim() })),
    };
  });
  const boundary = resolveMapBoundary(input, resolutions);
  const selected = data.systems.filter((system) => {
    switch (boundary.kind) {
      case "systems":
        return boundary.systemIds.includes(system.id);
      case "region":
        return system.regionId === boundary.regionId;
      case "constellation":
        return system.constellationId === boundary.constellationId;
      case "extent":
        return (
          system.position.x / LIGHT_YEAR_METRES >= boundary.minX &&
          system.position.x / LIGHT_YEAR_METRES <= boundary.maxX &&
          system.position.z / LIGHT_YEAR_METRES >= boundary.minZ &&
          system.position.z / LIGHT_YEAR_METRES <= boundary.maxZ
        );
    }
  });
  const ids = new Set(selected.map((system) => system.id));
  const internalPairs: PreparedMapFacts["internalPairs"] = [];
  // Enumerate endpoint pairs independently rather than relying on gate insertion order.
  for (const a of selected)
    for (const b of selected) {
      if (a.id >= b.id) continue;
      const forwardGateCount = data.gates.filter(
        (gate) => gate.systemId === a.id && gate.destinationId === b.id,
      ).length;
      const reverseGateCount = data.gates.filter(
        (gate) => gate.systemId === b.id && gate.destinationId === a.id,
      ).length;
      if (forwardGateCount || reverseGateCount)
        internalPairs.push({
          from: a.id,
          to: b.id,
          directionMask: forwardGateCount ? (reverseGateCount ? 3 : 1) : 2,
          forwardGateCount,
          reverseGateCount,
        });
    }
  return {
    source: {
      buildNumber: data.buildNumber,
      releaseDate: data.releaseDate,
      sourceUrl: data.sourceUrl,
      fetchedAt: data.fetchedAt,
    },
    resolutions,
    systemCount: selected.length,
    systems:
      selected.length > MAP_LIMITS.systems
        ? []
        : selected.map((system) => ({
            ...system,
            regionName: present(
              data.regions.find((item) => item.id === system.regionId),
            ).name,
            constellationName: present(
              data.constellations.find(
                (item) => item.id === system.constellationId,
              ),
            ).name,
            outgoingGateCount: data.gates.filter(
              (gate) => gate.systemId === system.id,
            ).length,
          })),
    internalPairs: selected.length > MAP_LIMITS.systems ? [] : internalPairs,
    boundaryConnections: new Set(
      data.gates
        .filter(
          (gate) => ids.has(gate.systemId) !== ids.has(gate.destinationId),
        )
        .map(
          (gate) =>
            `${Math.min(gate.systemId, gate.destinationId)}:${Math.max(gate.systemId, gate.destinationId)}`,
        ),
    ).size,
  };
}
function outcome(action: () => unknown): unknown {
  try {
    return action();
  } catch (error) {
    if (!(error instanceof MapError)) throw error;
    return { code: error.code, message: error.message, details: error.details };
  }
}
function parity(data: MapData, input: MapRequest) {
  const full = outcome(() => renderMap(new MapCatalog(data), input));
  const selected = outcome(() =>
    renderPreparedMap(createPreparedMapScene(input, facts(data, input))),
  );
  expect(selected).toEqual(full);
  return selected;
}

describe("prepared map scenes", () => {
  it("does not revalidate expanded Unicode lowercase keys as caller names", () => {
    const data = fixture();
    const name = "\u0130".repeat(100);
    present(data.systems[0]).name = name;
    const input = request({ boundary: { kind: "systems", systems: [name] } });
    expect(enumerateMapReferences(input)[0]?.reference).toHaveLength(200);
    const scene = createPreparedMapScene(input, facts(data, input));
    expect(readPreparedMapScene(scene).systems[0]?.name).toBe(name);
    expect(
      readPreparedMapScene(prepareMapScene(new MapCatalog(data), input)),
    ).toEqual(readPreparedMapScene(scene));
  });

  it("rejects truncated, unsorted and contradictory global resolution evidence", () => {
    for (const candidates of [
      [
        { id: 2, name: "Alpha" },
        { id: 1, name: "Alpha" },
      ],
      [
        { id: 1, name: "Alpha" },
        { id: 1, name: "Alpha" },
      ],
      [
        { id: 1, name: "Alpha" },
        { id: 2, name: "Beta" },
      ],
    ])
      expect(
        outcome(() =>
          resolveMapReference("system", "Alpha", {
            key: "system:name:alpha",
            candidateCount: 2,
            candidates,
          }),
        ),
      ).toMatchObject({ code: "MAP_DATA_INVALID" });
    const input = request({
      pointsOfInterest: [{ system: "Alpha", label: "Known", kind: "activity" }],
    });
    const value = facts(fixture(), input);
    const fact = present(
      value.resolutions.find((item) => item.key === "system:name:alpha"),
    );
    fact.candidateCount = 0;
    fact.candidates = [];
    expect(outcome(() => createPreparedMapScene(input, value))).toMatchObject({
      code: "MAP_DATA_INVALID",
    });
  });
  it("enumerates normalized distinct references without losing category or ID/name identity", () => {
    const input = request({
      boundary: { kind: "region", region: " ALPHA " },
      pointsOfInterest: [
        { system: " Alpha ", label: "First", kind: "activity" },
      ],
      routes: [{ systems: ["ALPHA", 1, "1", 1, "1"] }],
    });
    expect(enumerateMapReferences(input)).toEqual([
      { key: "region:name:alpha", category: "region", reference: "alpha" },
      { key: "system:name:alpha", category: "system", reference: "alpha" },
      { key: "system:id:1", category: "system", reference: 1 },
      { key: "system:name:1", category: "system", reference: "1" },
    ]);
    expect(mapReferenceQuery("system", "\u0130").reference).toBe("i\u0307");
    expect(outcome(() => mapReferenceQuery("system", 0))).toMatchObject({
      code: "MAP_REFERENCE_INVALID",
    });
    const maximum = request({
      boundary: {
        kind: "systems",
        systems: Array.from({ length: 250 }, (_, i) => i + 1),
      },
      pointsOfInterest: Array.from({ length: 12 }, (_, i) => ({
        system: i + 251,
        label: "Point",
        kind: "activity",
      })),
      routes: Array.from({ length: 3 }, (_, route) => ({
        systems: Array.from({ length: 100 }, (_, i) => 263 + route * 100 + i),
      })),
    });
    expect(enumerateMapReferences(maximum)).toHaveLength(562);
  });

  it.each(["systems", "region", "constellation", "extent"] as const)(
    "preserves exact SVG/results for %s scopes, palettes, layouts and sizes",
    (kind) => {
      const boundary: MapRequest["boundary"] =
        kind === "systems"
          ? { kind, systems: [" beta ", 3, "ALPHA", 1, "1"] }
          : kind === "region"
            ? { kind, region: " region " }
            : kind === "constellation"
              ? { kind, constellation: 200 }
              : { kind, minX: 0, maxX: 8, minZ: 0, maxZ: 3 };
      for (const theme of ["dark", "light"] as const)
        for (const layout of ["atlas", "geographic"] as const)
          for (const size of ["standard", "wide"] as const) {
            const data = fixture();
            const input = request({
              boundary,
              theme,
              layout,
              size,
              pointsOfInterest: [
                {
                  system: "Alpha",
                  label: "Caller <plan>",
                  kind: "staging",
                  note: "No inferred plans & no live intel",
                },
              ],
              routes: [{ systems: [1, 2, 1] }, { systems: [1, 2] }],
            });
            const result = parity(data, input);
            expect(result).toHaveProperty("svg");
            expect(result).toMatchObject({
              summary: {
                systemCount: 3,
                edgeCount: 2,
                routes: [
                  { systems: [{ id: 1 }, { id: 2 }, { id: 1 }], jumps: 2 },
                  { jumps: 1 },
                ],
              },
              completeness: { boundaryConnections: 2 },
            });
            const supplied = facts(data, input);
            supplied.systems.reverse();
            supplied.internalPairs.reverse();
            supplied.resolutions.reverse();
            expect(
              renderPreparedMap(createPreparedMapScene(input, supplied)),
            ).toEqual(result);
          }
    },
  );

  it("preserves parallel outbound counts, incoming-only external pairs, missing reverse direction and raw precision", () => {
    const data = fixture();
    const input = request({ routes: [{ systems: [1, 2, 3] }] });
    const scene = createPreparedMapScene(input, facts(data, input));
    const result = renderPreparedMap(scene);
    expect(result).toEqual(renderMap(new MapCatalog(data), input));
    expect(result.svg).toContain("raw security 0.4499999910593033");
    expect(result.svg).toContain("sec ~0.45 | 2 gates");
    expect(result.completeness.boundaryConnections).toBe(2);
    expect(
      parity(data, request({ routes: [{ systems: [3, 2] }] })),
    ).toMatchObject({
      code: "INVALID_ROUTE_ADJACENCY",
      details: { route: 1, hop: 1, from: 3, to: 2 },
    });
    const incoming = request({ boundary: { kind: "systems", systems: [1] } });
    expect(parity(data, incoming)).toMatchObject({
      completeness: { boundaryConnections: 2 },
    });
    delete present(data.systems[1]).position2D;
    expect(parity(data, input)).toMatchObject({
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "ATLAS_XZ_FALLBACK" }),
      ]),
    });
  });

  it("uses global ambiguity counts and the first ten ID-sorted candidates, even outside the boundary", () => {
    const data = fixture();
    for (let id = 6; id <= 18; id++)
      data.systems.push({ ...present(data.systems[3]), id, name: "Alpha" });
    data.systems.reverse();
    const input = request({
      pointsOfInterest: [
        { system: " ALPHA ", label: "Ambiguous", kind: "activity" },
      ],
    });
    const result = parity(data, input);
    expect(result).toMatchObject({
      code: "MAP_REFERENCE_AMBIGUOUS",
      details: {
        category: "system",
        reference: "ALPHA",
        candidateCount: 14,
        candidates: [1, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((id) => ({
          id,
          name: "Alpha",
        })),
      },
    });
    expect(resolveMapBoundary(input, facts(data, input).resolutions)).toEqual({
      kind: "systems",
      systemIds: [1, 2, 3],
    });
    expect(
      outcome(() =>
        resolveMapReference("system", "Alpha", {
          key: "system:name:alpha",
          candidateCount: 14,
          candidates: [{ id: 1, name: "Alpha" }],
        }),
      ),
    ).toMatchObject({ code: "MAP_DATA_INVALID" });
  });

  it.each([
    {
      overrides: {
        boundary: { kind: "systems", systems: [999] },
        pointsOfInterest: [
          { system: "missing", label: "POI", kind: "activity" },
        ],
      },
      code: "MAP_REFERENCE_UNKNOWN",
      details: { reference: 999 },
    },
    {
      overrides: { boundary: { kind: "region", region: "missing" } },
      code: "MAP_REFERENCE_UNKNOWN",
      details: { category: "region" },
    },
    {
      overrides: {
        boundary: { kind: "constellation", constellation: "missing" },
      },
      code: "MAP_REFERENCE_UNKNOWN",
      details: { category: "constellation" },
    },
    {
      overrides: {
        boundary: {
          kind: "extent",
          minX: 100,
          maxX: 101,
          minZ: 100,
          maxZ: 101,
        },
        pointsOfInterest: [
          { system: "missing", label: "POI", kind: "activity" },
        ],
      },
      code: "EMPTY_MAP_BOUNDARY",
      details: {},
    },
    {
      overrides: {
        pointsOfInterest: [
          { system: 4, label: "Outside", kind: "activity" },
          { system: "missing", label: "Later", kind: "activity" },
        ],
        routes: [{ systems: [3, 2] }],
      },
      code: "OUT_OF_BOUNDARY",
      details: { systemId: 4 },
    },
    {
      overrides: { routes: [{ systems: [3, 2, "missing"] }] },
      code: "MAP_REFERENCE_UNKNOWN",
      details: { reference: "missing" },
    },
    {
      overrides: { routes: [{ systems: [3, 2, 4] }] },
      code: "OUT_OF_BOUNDARY",
      details: { systemId: 4 },
    },
    {
      overrides: { routes: [{ systems: [3, 2] }, { systems: ["missing"] }] },
      code: "INVALID_ROUTE_ADJACENCY",
      details: { route: 1, hop: 1, from: 3, to: 2 },
    },
    {
      overrides: { routes: [{ systems: [1, 1] }] },
      code: "INVALID_ROUTE_ADJACENCY",
      details: { from: 1, to: 1 },
    },
  ] as {
    overrides: Partial<MapRequest>;
    code: string;
    details: Record<string, unknown>;
  }[])(
    "preserves semantic error precedence: $code $details",
    ({ overrides, code, details }) => {
      expect(parity(fixture(), request(overrides))).toMatchObject({
        code,
        details,
      });
    },
  );

  it("retains complete-count size errors before POI lookup and never silently trims", () => {
    const data = fixture();
    data.gates = [];
    data.systems = Array.from({ length: 251 }, (_, i) => ({
      ...present(data.systems[0]),
      id: i + 1,
      name: `Test ${i + 1}`,
    }));
    const input = request({
      boundary: { kind: "region", region: 100 },
      pointsOfInterest: [
        { system: "missing", label: "Later", kind: "activity" },
      ],
    });
    expect(parity(data, input)).toEqual({
      code: "MAP_TOO_LARGE",
      message:
        "The complete boundary contains 251 systems; the limit is 250. No systems were trimmed.",
      details: { systemCount: 251 },
    });
  });

  it("retains projection, density, request and output-limit failures", () => {
    const data = fixture();
    present(data.systems[0]).position2D = { x: -Number.MAX_VALUE, y: 0 };
    present(data.systems[1]).position2D = { x: Number.MAX_VALUE, y: 0 };
    expect(parity(data, request())).toMatchObject({ code: "INVALID_MAP_DATA" });
    const dense = fixture();
    dense.systems.forEach((system) => {
      system.position2D = { x: 0, y: 0 };
    });
    expect(
      parity(dense, request({ routes: [{ systems: [1, 2, 3] }] })),
    ).toMatchObject({ code: "MAP_TOO_DENSE" });
    const huge = fixture();
    huge.sourceUrl += "a".repeat(MAP_LIMITS.svgBytes);
    expect(parity(huge, request())).toMatchObject({
      code: "MAP_OUTPUT_TOO_LARGE",
    });
    expect(
      parity(fixture(), { ...request(), title: "bad\u202E" }),
    ).toMatchObject({ code: "INVALID_MAP_REQUEST" });
  });

  it.each([
    (value: PreparedMapFacts) => {
      value.systems.push(present(value.systems[0]));
    },
    (value: PreparedMapFacts) => {
      value.systems.pop();
    },
    (value: PreparedMapFacts) => {
      value.systemCount--;
    },
    (value: PreparedMapFacts) => {
      present(value.systems[0]).id = Number.MAX_SAFE_INTEGER + 1;
    },
    (value: PreparedMapFacts) => {
      present(value.systems[0]).position.x = Infinity;
    },
    (value: PreparedMapFacts) => {
      present(value.systems[0]).securityStatus = NaN;
    },
    (value: PreparedMapFacts) => {
      present(value.systems[0]).regionName = "Conflicting parent";
    },
    (value: PreparedMapFacts) => {
      present(value.systems[0]).constellationId = 201;
      present(value.systems[1]).constellationId = 201;
      present(value.systems[1]).regionId = 101;
    },
    (value: PreparedMapFacts) => {
      present(value.systems[0]).name = "Other name";
    },
    (value: PreparedMapFacts) => {
      value.resolutions.pop();
    },
    (value: PreparedMapFacts) => {
      value.resolutions.push(present(value.resolutions[0]));
    },
    (value: PreparedMapFacts) => {
      present(value.resolutions[0]).key = "system:name:1";
    },
    (value: PreparedMapFacts) => {
      present(value.resolutions[0]).candidateCount = 2;
    },
    (value: PreparedMapFacts) => {
      present(present(value.resolutions[0]).candidates[0]).id = 999;
    },
    (value: PreparedMapFacts) => {
      value.internalPairs.push(present(value.internalPairs[0]));
    },
    (value: PreparedMapFacts) => {
      present(value.internalPairs[0]).from = 2;
    },
    (value: PreparedMapFacts) => {
      present(value.internalPairs[0]).to = 99;
    },
    (value: PreparedMapFacts) => {
      present(value.internalPairs[0]).directionMask = 1;
    },
    (value: PreparedMapFacts) => {
      present(value.internalPairs[0]).forwardGateCount = -1;
    },
    (value: PreparedMapFacts) => {
      present(value.internalPairs[0]).forwardGateCount = 3;
    },
    (value: PreparedMapFacts) => {
      present(value.systems[0]).outgoingGateCount = 0;
    },
    (value: PreparedMapFacts) => {
      value.boundaryConnections = 0;
    },
    (value: PreparedMapFacts) => {
      value.boundaryConnections = 0.5;
    },
    (value: PreparedMapFacts) => {
      value.source.buildNumber = 0;
    },
    (value: PreparedMapFacts) => {
      value.source.fetchedAt = "not a date";
    },
    (value: PreparedMapFacts) => {
      Object.assign(value, { unexpected: true });
    },
    (value: PreparedMapFacts) => {
      Object.assign(present(value.systems[0]).position, { unexpected: true });
    },
  ])("rejects malformed/inconsistent selected facts %#", (mutate) => {
    const input = request();
    const value = facts(fixture(), input);
    mutate(value);
    expect(outcome(() => createPreparedMapScene(input, value))).toMatchObject({
      code: "MAP_DATA_INVALID",
    });
  });

  it("rejects forged handles and isolates input, snapshots and returned-result mutation", () => {
    const data = fixture();
    const input = request({ routes: [{ systems: [1, 2] }] });
    const value = facts(data, input);
    const scene = createPreparedMapScene(input, value);
    const expected = renderPreparedMap(scene);
    expect(Object.isFrozen(scene)).toBe(true);
    expect(Reflect.ownKeys(scene)).toEqual([]);
    expect(() => Object.assign(scene, { systems: [] })).toThrow(TypeError);
    input.routes[0]?.systems.reverse();
    present(value.systems[0]).position.x = NaN;
    value.internalPairs.length = 0;
    value.source.buildNumber++;
    const snapshot = readPreparedMapScene(scene);
    snapshot.systems.length = 0;
    snapshot.request.title = "Mutated";
    const result = renderPreparedMap(scene);
    result.summary.routes.length = 0;
    expect(renderPreparedMap(scene)).toEqual(expected);
    for (const forged of [
      {},
      { ...scene },
      Object.create(scene) as unknown,
      structuredClone(scene),
    ])
      expect(
        outcome(() => renderPreparedMap(forged as PreparedMapScene)),
      ).toMatchObject({ code: "MAP_DATA_INVALID" });
    expect(outcome(() => renderPreparedMap(scene, input))).toMatchObject({
      code: "INVALID_MAP_REQUEST",
    });
    const catalog = new MapCatalog(fixture());
    const prepared = prepareMapScene(catalog, request());
    const before = renderPreparedMap(prepared);
    catalog.data.gates.length = 0;
    catalog.systems.clear();
    expect(renderPreparedMap(prepared)).toEqual(before);
  });
});
