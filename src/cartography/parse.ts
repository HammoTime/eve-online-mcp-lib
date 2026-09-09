import * as z from "zod/v4";
import type { StaticDataEntry } from "../static-data-parser.js";
import { MAP_DATA_LIMITS, validateMapData } from "./catalog.js";
import { MapError, mapIdSchema, mapText, type MapData } from "./types.js";

export const MAP_DATA_FILES: readonly string[] = [
  "mapSolarSystems.jsonl",
  "mapRegions.jsonl",
  "mapConstellations.jsonl",
  "mapStargates.jsonl",
];

const namedSchema = z.object({
  _key: mapIdSchema,
  name: z.object({ en: mapText(100) }),
});
const systemSchema = namedSchema.extend({
  regionID: mapIdSchema,
  constellationID: mapIdSchema,
  position: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
  position2D: z.object({ x: z.number(), y: z.number() }).optional(),
  securityStatus: z.number(),
});
const constellationSchema = namedSchema.extend({ regionID: mapIdSchema });
const gateSchema = z.object({
  _key: mapIdSchema,
  solarSystemID: mapIdSchema,
  destination: z.object({
    solarSystemID: mapIdSchema,
    stargateID: mapIdSchema,
  }),
});

export async function parseMapData(
  entries: AsyncIterable<StaticDataEntry>,
  metadata: Omit<
    MapData,
    "schemaVersion" | "systems" | "regions" | "constellations" | "gates"
  >,
): Promise<MapData> {
  const data: MapData = {
    ...metadata,
    schemaVersion: 1,
    systems: [],
    regions: [],
    constellations: [],
    gates: [],
  };
  const seen = new Set<string>();
  let entryCount = 0;
  try {
    for await (const entry of entries) {
      if (++entryCount > MAP_DATA_LIMITS.entries)
        throw new MapError(
          "MAP_DATA_LIMIT",
          "Map archive entry count exceeds limit.",
        );
      if (!MAP_DATA_FILES.includes(entry.name)) continue;
      if (seen.has(entry.name))
        throw new MapError("MAP_DATA_INVALID", "Duplicate map archive entry.", {
          file: entry.name,
        });
      seen.add(entry.name);
      const category =
        entry.name === "mapSolarSystems.jsonl"
          ? "systems"
          : entry.name === "mapRegions.jsonl"
            ? "regions"
            : entry.name === "mapConstellations.jsonl"
              ? "constellations"
              : "gates";
      let count = 0;
      for await (const row of entry.rows) {
        if (++count > MAP_DATA_LIMITS[category])
          throw new MapError(
            "MAP_DATA_LIMIT",
            "Map record count exceeds limit.",
            { file: entry.name },
          );
        if (category === "systems") {
          const system = systemSchema.parse(row);
          data.systems.push({
            id: system._key,
            name: system.name.en,
            regionId: system.regionID,
            constellationId: system.constellationID,
            position: system.position,
            ...(system.position2D ? { position2D: system.position2D } : {}),
            securityStatus: system.securityStatus,
          });
        } else if (category === "regions") {
          const region = namedSchema.parse(row);
          data.regions.push({ id: region._key, name: region.name.en });
        } else if (category === "constellations") {
          const constellation = constellationSchema.parse(row);
          data.constellations.push({
            id: constellation._key,
            name: constellation.name.en,
            regionId: constellation.regionID,
          });
        } else {
          const gate = gateSchema.parse(row);
          data.gates.push({
            id: gate._key,
            systemId: gate.solarSystemID,
            destinationId: gate.destination.solarSystemID,
            destinationGateId: gate.destination.stargateID,
          });
        }
      }
    }
    if (seen.size !== MAP_DATA_FILES.length)
      throw new MapError(
        "MAP_DATA_INVALID",
        "Map archive is missing required files.",
        { files: MAP_DATA_FILES.filter((name) => !seen.has(name)) },
      );
    return validateMapData(data);
  } catch (error) {
    if (error instanceof MapError) throw error;
    // Do not echo untrusted rows or transport error text into a tool response.
    throw new MapError("MAP_DATA_INVALID", "Map archive could not be parsed.");
  }
}
