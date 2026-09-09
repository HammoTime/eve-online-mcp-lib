import { describe, expect, it } from "vitest";
import { MAP_DATA_LIMITS, MapCatalog } from "../src/cartography/catalog.js";
import { MAP_DATA_FILES, parseMapData } from "../src/cartography/parse.js";
import { MapError, type MapData } from "../src/cartography/types.js";
import { jsonLines, type StaticDataEntry } from "../src/static-data-parser.js";

function fixture(): MapData {
  return {
    schemaVersion: 1,
    buildNumber: 42,
    releaseDate: "2026-09-01T00:00:00Z",
    sourceUrl:
      "https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-42-jsonl.zip",
    fetchedAt: "2026-09-09T00:00:00Z",
    regions: [
      { id: 1, name: "Shared" },
      { id: 2, name: "Elsewhere" },
    ],
    constellations: [{ id: 10, name: "Shared", regionId: 1 }],
    systems: [
      {
        id: 100,
        name: "Shared",
        regionId: 1,
        constellationId: 10,
        position: { x: -1e17, y: 2e17, z: 3e17 },
        position2D: { x: 12, y: -3 },
        securityStatus: 0.4499,
      },
      {
        id: 101,
        name: "Second",
        regionId: 1,
        constellationId: 10,
        position: { x: 0, y: 0, z: 0 },
        securityStatus: -0.001,
      },
    ],
    gates: [
      { id: 1000, systemId: 100, destinationId: 101, destinationGateId: 1001 },
    ],
  };
}
function rawEntries(): [string, unknown[]][] {
  const data = fixture();
  return [
    [
      "mapSolarSystems.jsonl",
      data.systems.map((system) => ({
        _key: system.id,
        name: { en: system.name, de: "Other" },
        regionID: system.regionId,
        constellationID: system.constellationId,
        position: system.position,
        ...(system.position2D ? { position2D: system.position2D } : {}),
        securityStatus: system.securityStatus,
        ignored: true,
      })),
    ],
    [
      "mapRegions.jsonl",
      data.regions.map((region) => ({
        _key: region.id,
        name: { en: region.name },
      })),
    ],
    [
      "mapConstellations.jsonl",
      data.constellations.map((item) => ({
        _key: item.id,
        name: { en: item.name },
        regionID: item.regionId,
      })),
    ],
    [
      "mapStargates.jsonl",
      data.gates.map((gate) => ({
        _key: gate.id,
        solarSystemID: gate.systemId,
        destination: {
          solarSystemID: gate.destinationId,
          stargateID: gate.destinationGateId,
        },
      })),
    ],
  ];
}
async function* values<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield await Promise.resolve(item);
}
function entries(items = rawEntries()): AsyncIterable<StaticDataEntry> {
  return values(items.map(([name, rows]) => ({ name, rows: values(rows) })));
}
function required<T>(items: T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error("Missing test fixture item");
  return item;
}
function capture(run: () => unknown): MapError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MapError);
    return error as MapError;
  }
  throw new Error("Expected MapError");
}

describe("map catalog", () => {
  it("resolves exact category-aware names and numeric IDs without changing raw security or coordinates", () => {
    const data = fixture();
    const catalog = new MapCatalog(data);
    expect(catalog.resolveSystem("  sHaReD  ")).toBe(catalog.systems.get(100));
    expect(catalog.resolveSystem(101)).toBe(catalog.data.systems[1]);
    expect(catalog.resolveRegion("shared")).toEqual({ id: 1, name: "Shared" });
    expect(catalog.resolveConstellation(" SHARED ")).toEqual({
      id: 10,
      name: "Shared",
      regionId: 1,
    });
    expect(catalog.resolveRegion(2)).toBe(catalog.regions.get(2));
    expect(catalog.resolveConstellation(10)).toBe(
      catalog.constellations.get(10),
    );
    expect(catalog.data).toEqual(data);
    expect(catalog.data).not.toBe(data);
    expect(catalog.resolveSystem(100).securityStatus).toBe(0.4499);
    required(data.systems).position.x = 8;
    expect(catalog.resolveSystem(100).position.x).toBe(-1e17);
  });
  it("indexes directed gates without manufacturing missing reverse links", () => {
    const data = fixture();
    const oneWay = new MapCatalog(data);
    expect(oneWay.hasGate(100, 101)).toBe(true);
    expect(oneWay.hasGate(101, 100)).toBe(false);
    expect(oneWay.hasGate(100, 100)).toBe(false);
    expect(oneWay.hasGate(999, 100)).toBe(false);
    data.gates.push({
      id: 1001,
      systemId: 101,
      destinationId: 100,
      destinationGateId: 1000,
    });
    expect(new MapCatalog(data).hasGate(101, 100)).toBe(true);
    data.gates = [];
    expect(new MapCatalog(data).hasGate(100, 101)).toBe(false);
  });
  it.each(["Shar", "100", "missing", 1, 999])(
    "never coerces or guesses unknown system %s",
    (ref) => {
      const error = capture(() => new MapCatalog(fixture()).resolveSystem(ref));
      expect(error.code).toBe("MAP_REFERENCE_UNKNOWN");
      expect(error.details).toMatchObject({
        category: "system",
        candidates: [],
        candidateCount: 0,
      });
    },
  );
  it.each([
    "",
    " ",
    "x".repeat(101),
    "bad\u0001",
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects malformed references %#", (ref) => {
    expect(
      capture(() => new MapCatalog(fixture()).resolveSystem(ref)).code,
    ).toBe("MAP_REFERENCE_INVALID");
  });
  it("bounds and sorts ambiguous candidates and keeps ambiguity within each category", () => {
    const data = fixture();
    data.systems = Array.from({ length: 25 }, (_, index) => ({
      ...required(data.systems),
      id: 124 - index,
      name: index % 2 ? "shared" : "SHARED",
    }));
    const catalog = new MapCatalog(data);
    const error = capture(() => catalog.resolveSystem("shared"));
    expect(error.code).toBe("MAP_REFERENCE_AMBIGUOUS");
    expect(error.details.candidateCount).toBe(25);
    expect(error.details.candidates).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        id: 100 + index,
        name: index % 2 ? "shared" : "SHARED",
      })),
    );
    expect(JSON.stringify(error.details).length).toBeLessThan(1000);
    expect(catalog.resolveRegion("shared").id).toBe(1);
    expect(catalog.resolveSystem(100).id).toBe(100);
    data.regions.push({ id: 3, name: "SHARED" });
    data.constellations.push({ id: 11, name: "shared", regionId: 1 });
    const ambiguous = new MapCatalog(data);
    expect(capture(() => ambiguous.resolveRegion("shared")).code).toBe(
      "MAP_REFERENCE_AMBIGUOUS",
    );
    expect(capture(() => ambiguous.resolveConstellation("shared")).code).toBe(
      "MAP_REFERENCE_AMBIGUOUS",
    );
    expect(capture(() => catalog.resolveRegion(100)).code).toBe(
      "MAP_REFERENCE_UNKNOWN",
    );
    expect(capture(() => catalog.resolveConstellation("Second")).code).toBe(
      "MAP_REFERENCE_UNKNOWN",
    );
  });
  it("does not hardcode current ID ranges or round low positive security", () => {
    const data = fixture();
    data.gates = [];
    required(data.systems).id = Number.MAX_SAFE_INTEGER;
    required(data.systems).securityStatus = 0.00001;
    expect(
      new MapCatalog(data).resolveSystem(Number.MAX_SAFE_INTEGER)
        .securityStatus,
    ).toBe(0.00001);
  });
  it.each<(data: MapData) => void>([
    (data) => {
      data.systems.push(required(data.systems));
    },
    (data) => {
      data.regions.push(required(data.regions));
    },
    (data) => {
      data.constellations.push(required(data.constellations));
    },
    (data) => {
      data.gates.push(required(data.gates));
    },
    (data) => {
      required(data.systems).position.x = Infinity;
    },
    (data) => {
      required(data.systems).position.y = NaN;
    },
    (data) => {
      required(data.systems).position2D = { x: 0, y: Infinity };
    },
    (data) => {
      required(data.systems).securityStatus = NaN;
    },
    (data) => {
      required(data.systems).regionId = 999;
    },
    (data) => {
      required(data.systems).regionId = 2;
    },
    (data) => {
      required(data.systems).constellationId = 999;
    },
    (data) => {
      required(data.constellations).regionId = 999;
    },
    (data) => {
      required(data.gates).systemId = 999;
    },
    (data) => {
      required(data.gates).destinationId = 999;
    },
    (data) => {
      required(data.gates).destinationId = 100;
    },
    (data) => {
      required(data.gates).destinationGateId = 1000;
    },
    (data) => {
      data.gates.push({
        id: 1002,
        systemId: 100,
        destinationId: 101,
        destinationGateId: 1001,
      });
    },
    (data) => {
      data.gates.push({
        id: 1001,
        systemId: 100,
        destinationId: 101,
        destinationGateId: 1000,
      });
    },
    (data) => {
      data.gates.push({
        id: 1001,
        systemId: 101,
        destinationId: 100,
        destinationGateId: 1002,
      });
    },
    (data) => {
      data.systems = [];
    },
    (data) => {
      data.regions = [];
    },
    (data) => {
      data.constellations = [];
    },
    (data) => {
      data.buildNumber = 0;
    },
    (data) => {
      data.releaseDate = "not a date";
    },
    (data) => {
      data.sourceUrl = "not a URL";
    },
    (data) => {
      required(data.systems).name = "bad\u202E";
    },
  ])("rejects invalid data %#", (mutate) => {
    const data = fixture();
    mutate(data);
    expect(capture(() => new MapCatalog(data)).code).toBe("MAP_DATA_INVALID");
  });
});

describe("portable map SDE parser", () => {
  it("requires exactly the four known filenames and maps CCP fields in any order", async () => {
    expect(MAP_DATA_FILES).toEqual([
      "mapSolarSystems.jsonl",
      "mapRegions.jsonl",
      "mapConstellations.jsonl",
      "mapStargates.jsonl",
    ]);
    expect(
      await parseMapData(
        entries([...rawEntries().reverse(), ["ignored.jsonl", [null]]]),
        fixture(),
      ),
    ).toEqual(fixture());
  });
  it.each([0, 1, 2, 3])(
    "rejects missing, nested or duplicate file %i and duplicate IDs",
    async (index) => {
      const raw = rawEntries();
      const entry = required(raw, index);
      raw.splice(index, 1);
      await expect(parseMapData(entries(raw), fixture())).rejects.toMatchObject(
        { code: "MAP_DATA_INVALID" },
      );
      await expect(
        parseMapData(
          entries([...raw, [`nested/${entry[0]}`, entry[1]]]),
          fixture(),
        ),
      ).rejects.toThrow("missing required");
      await expect(
        parseMapData(entries([...raw, entry, entry]), fixture()),
      ).rejects.toThrow("Duplicate map archive");
      await expect(
        parseMapData(
          entries([...raw, [entry[0], [...entry[1], entry[1][0]]]]),
          fixture(),
        ),
      ).rejects.toThrow("Duplicate map IDs");
    },
  );
  it.each([
    null,
    {},
    { _key: 100, name: { de: "No English name" } },
    {
      _key: 100,
      name: { en: "Bad" },
      regionID: 1,
      constellationID: 10,
      position: { x: 0, y: 0, z: 0 },
      securityStatus: "0.5",
    },
  ])("fails closed on malformed source row %#", async (row) => {
    const raw = rawEntries();
    required(raw)[1][0] = row;
    await expect(parseMapData(entries(raw), fixture())).rejects.toMatchObject({
      code: "MAP_DATA_INVALID",
    });
  });
  it("reuses streaming jsonLines with split UTF-8, CRLF, blank lines and an unterminated final row", async () => {
    const raw = rawEntries();
    required(raw, 1)[1] = [
      { _key: 1, name: { en: "R\u00e9gion" } },
      { _key: 2, name: { en: "Elsewhere" } },
    ];
    const streams = raw.map(([name, rows]) => ({
      name,
      rows: jsonLines(
        values(
          Array.from(
            new TextEncoder().encode(
              "\r\n" + rows.map((row) => JSON.stringify(row)).join("\r\n\n"),
            ),
            (byte) => new Uint8Array([byte]),
          ),
        ),
        MAP_DATA_LIMITS.entryBytes,
      ),
    }));
    expect(
      (await parseMapData(values(streams), fixture())).regions[0]?.name,
    ).toBe("R\u00e9gion");
  });
  it("bounds all entry enumeration, selected row counts and streaming bytes", async () => {
    await expect(
      parseMapData(
        entries(
          Array.from({ length: MAP_DATA_LIMITS.entries + 1 }, () => [
            "ignored",
            [],
          ]),
        ),
        fixture(),
      ),
    ).rejects.toMatchObject({ code: "MAP_DATA_LIMIT" });
    await expect(
      parseMapData(
        entries([
          [
            "mapRegions.jsonl",
            Array.from({ length: MAP_DATA_LIMITS.regions + 1 }, (_, index) => ({
              _key: index + 1,
              name: { en: "Region" },
            })),
          ],
        ]),
        fixture(),
      ),
    ).rejects.toMatchObject({ code: "MAP_DATA_LIMIT" });
    await expect(
      parseMapData(
        values([
          {
            name: "mapRegions.jsonl",
            rows: jsonLines(values([new Uint8Array(4)]), 3),
          },
        ]),
        fixture(),
      ),
    ).rejects.toMatchObject({ code: "MAP_DATA_INVALID" });
  });
  it("closes the source on error without leaking transport error text", async () => {
    let closed = false;
    async function* broken(): AsyncGenerator<StaticDataEntry> {
      try {
        yield await Promise.resolve({ name: "ignored", rows: values([]) });
        throw new Error("PRIVATE transport details");
      } finally {
        closed = true;
      }
    }
    await expect(parseMapData(broken(), fixture())).rejects.toMatchObject({
      code: "MAP_DATA_INVALID",
      message: "Map archive could not be parsed.",
    });
    expect(closed).toBe(true);
  });
});
