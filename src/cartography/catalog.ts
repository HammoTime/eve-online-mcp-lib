import * as z from "zod/v4";
import {
  MapError,
  mapIdSchema,
  mapReferenceSchema,
  mapText,
  type MapData,
  type MapSystem,
} from "./types.js";

// Capacity limits, not assumptions about today's SDE ID ranges or population.
export const MAP_DATA_LIMITS = {
  systems: 100_000,
  regions: 10_000,
  constellations: 100_000,
  gates: 500_000,
  entries: 10_000,
  entryBytes: 128_000_000,
} as const;

const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
const position2DSchema = positionSchema.omit({ z: true });
const namedSchema = z.object({ id: mapIdSchema, name: mapText(100) });
const mapDataSchema = z.object({
  schemaVersion: z.literal(1),
  buildNumber: mapIdSchema,
  releaseDate: z.iso.datetime(),
  sourceUrl: z.url(),
  fetchedAt: z.iso.datetime(),
  systems: z
    .array(
      namedSchema.extend({
        regionId: mapIdSchema,
        constellationId: mapIdSchema,
        position: positionSchema,
        position2D: position2DSchema.optional(),
        securityStatus: z.number(),
      }),
    )
    .min(1)
    .max(MAP_DATA_LIMITS.systems),
  regions: z.array(namedSchema).min(1).max(MAP_DATA_LIMITS.regions),
  constellations: z
    .array(namedSchema.extend({ regionId: mapIdSchema }))
    .min(1)
    .max(MAP_DATA_LIMITS.constellations),
  gates: z
    .array(
      z.object({
        id: mapIdSchema,
        systemId: mapIdSchema,
        destinationId: mapIdSchema,
        destinationGateId: mapIdSchema,
      }),
    )
    .max(MAP_DATA_LIMITS.gates),
});

export function validateMapData(value: unknown): MapData {
  const parsed = mapDataSchema.safeParse(value);
  if (!parsed.success)
    throw new MapError("MAP_DATA_INVALID", "Invalid map data fields.", {
      issues: parsed.error.issues
        .slice(0, 8)
        .map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  const data: MapData = {
    ...parsed.data,
    systems: parsed.data.systems.map(({ position2D, ...system }) => ({
      ...system,
      ...(position2D ? { position2D } : {}),
    })),
  };
  const systems = new Map(data.systems.map((system) => [system.id, system]));
  const regions = new Map(data.regions.map((region) => [region.id, region]));
  const constellations = new Map(
    data.constellations.map((item) => [item.id, item]),
  );
  const gates = new Map(data.gates.map((gate) => [gate.id, gate]));
  if (
    systems.size !== data.systems.length ||
    regions.size !== data.regions.length ||
    constellations.size !== data.constellations.length ||
    gates.size !== data.gates.length
  )
    throw new MapError(
      "MAP_DATA_INVALID",
      "Duplicate map IDs within a category.",
    );
  for (const constellation of data.constellations) {
    if (!regions.has(constellation.regionId))
      throw new MapError(
        "MAP_DATA_INVALID",
        "Constellation references an unknown region.",
        { constellationId: constellation.id },
      );
  }
  for (const system of data.systems) {
    if (
      !regions.has(system.regionId) ||
      constellations.get(system.constellationId)?.regionId !== system.regionId
    )
      throw new MapError(
        "MAP_DATA_INVALID",
        "System region/constellation membership is inconsistent.",
        { systemId: system.id },
      );
  }
  const destinations = new Set<number>();
  for (const gate of data.gates) {
    if (
      !systems.has(gate.systemId) ||
      !systems.has(gate.destinationId) ||
      gate.systemId === gate.destinationId ||
      gate.id === gate.destinationGateId
    )
      throw new MapError(
        "MAP_DATA_INVALID",
        "Gate references invalid systems or itself.",
        { gateId: gate.id },
      );
    if (destinations.has(gate.destinationGateId))
      throw new MapError(
        "MAP_DATA_INVALID",
        "Multiple gates reference the same destination gate.",
        { gateId: gate.id },
      );
    destinations.add(gate.destinationGateId);
    // A missing reverse row is allowed, but is never synthesized. Present pairs must agree.
    const reverse = gates.get(gate.destinationGateId);
    if (
      reverse &&
      (reverse.systemId !== gate.destinationId ||
        reverse.destinationId !== gate.systemId ||
        reverse.destinationGateId !== gate.id)
    )
      throw new MapError(
        "MAP_DATA_INVALID",
        "Gate pair references are inconsistent.",
        { gateId: gate.id },
      );
  }
  return data;
}

function indexNames<T extends { id: number; name: string }>(items: T[]) {
  const names = new Map<string, T[]>();
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    const matches = names.get(key);
    if (matches) matches.push(item);
    else names.set(key, [item]);
  }
  for (const matches of names.values()) matches.sort((a, b) => a.id - b.id);
  return names;
}

function resolve<T extends { id: number; name: string }>(
  ref: string | number,
  category: string,
  ids: Map<number, T>,
  names: Map<string, T[]>,
): T {
  const parsed = mapReferenceSchema.safeParse(ref);
  if (!parsed.success)
    throw new MapError(
      "MAP_REFERENCE_INVALID",
      "Use a positive safe integer ID or an exact name of at most 100 characters.",
      { category },
    );
  const reference = parsed.data;
  // Strings are exact names, not coercible IDs, prefixes or fuzzy matches.
  const item = typeof reference === "number" ? ids.get(reference) : undefined;
  const matches =
    typeof reference === "string"
      ? (names.get(reference.toLowerCase()) ?? [])
      : item
        ? [item]
        : [];
  const match = matches[0];
  if (matches.length !== 1 || !match)
    throw new MapError(
      matches.length ? "MAP_REFERENCE_AMBIGUOUS" : "MAP_REFERENCE_UNKNOWN",
      `Select an exact ${category} name or numeric ID; no match was inferred.`,
      {
        category,
        reference,
        candidateCount: matches.length,
        candidates: matches.slice(0, 10).map(({ id, name }) => ({ id, name })),
      },
    );
  return match;
}

export class MapCatalog {
  readonly data: MapData;
  readonly systems: Map<number, MapSystem>;
  readonly regions: Map<number, MapData["regions"][number]>;
  readonly constellations: Map<number, MapData["constellations"][number]>;
  private readonly systemNames;
  private readonly regionNames;
  private readonly constellationNames;
  private readonly gateLinks = new Map<number, Set<number>>();

  constructor(data: MapData) {
    this.data = validateMapData(data);
    this.systems = new Map(
      this.data.systems.map((system) => [system.id, system]),
    );
    this.regions = new Map(
      this.data.regions.map((region) => [region.id, region]),
    );
    this.constellations = new Map(
      this.data.constellations.map((item) => [item.id, item]),
    );
    this.systemNames = indexNames(this.data.systems);
    this.regionNames = indexNames(this.data.regions);
    this.constellationNames = indexNames(this.data.constellations);
    for (const gate of this.data.gates) {
      let links = this.gateLinks.get(gate.systemId);
      if (!links) this.gateLinks.set(gate.systemId, (links = new Set()));
      links.add(gate.destinationId);
    }
  }

  resolveSystem(ref: string | number): MapSystem {
    return resolve(ref, "system", this.systems, this.systemNames);
  }
  resolveRegion(ref: string | number): MapData["regions"][number] {
    return resolve(ref, "region", this.regions, this.regionNames);
  }
  resolveConstellation(
    ref: string | number,
  ): MapData["constellations"][number] {
    return resolve(
      ref,
      "constellation",
      this.constellations,
      this.constellationNames,
    );
  }
  hasGate(a: number, b: number): boolean {
    return this.gateLinks.get(a)?.has(b) ?? false;
  }
}
