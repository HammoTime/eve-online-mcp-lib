import * as z from "zod/v4";
import {
  MAP_DATA_LIMITS,
  mapSourceSchema,
  mapSystemSchema,
  type MapCatalog,
} from "./catalog.js";
import { present, type RouteLeg } from "./layout.js";
import {
  enumerateMapReferences,
  mapReferenceQuery,
  mapResolutionFactSchema,
  parseMapRequest,
  resolveMapReference,
  validateMapResolutionFact,
  type MapReferenceCategory,
  type MapResolutionFact,
} from "./references.js";
import {
  LIGHT_YEAR_METRES,
  MAP_LIMITS,
  MapError,
  mapIdSchema,
  mapText,
  type MapData,
  type MapReference,
  type MapRequest,
  type MapSystem,
  type RenderedMap,
} from "./types.js";

export {
  enumerateMapReferences,
  mapReferenceQuery,
  resolveMapReference,
} from "./references.js";
export type {
  MapReferenceCategory,
  MapReferenceQuery,
  MapResolutionFact,
} from "./references.js";

export type MapSceneSource = Pick<
  MapData,
  "buildNumber" | "releaseDate" | "sourceUrl" | "fetchedAt"
>;
export interface MapSelectedSystem extends MapSystem {
  regionName: string;
  constellationName: string;
  /** All outgoing gate rows, including parallel gates and external destinations. */
  outgoingGateCount: number;
}
export interface MapInternalPair {
  /** Canonical unordered endpoints: from < to. */
  from: number;
  to: number;
  /** Bit 1: from -> to; bit 2: to -> from. A reverse gate is never inferred. */
  directionMask: 1 | 2 | 3;
  forwardGateCount: number;
  reverseGateCount: number;
}
export interface PreparedMapFacts {
  source: MapSceneSource;
  resolutions: MapResolutionFact[];
  /** Exact complete boundary count. Oversized boundaries may omit system/pair rows. */
  systemCount: number;
  systems: MapSelectedSystem[];
  internalPairs: MapInternalPair[];
  /** Distinct unordered pairs with exactly one selected endpoint, including incoming-only pairs. */
  boundaryConnections: number;
}
export type ResolvedMapBoundary =
  | { kind: "systems"; systemIds: number[] }
  | { kind: "region"; regionId: number; name: string }
  | { kind: "constellation"; constellationId: number; name: string }
  | Extract<MapRequest["boundary"], { kind: "extent" }>;

declare const preparedSceneBrand: unique symbol;
/** Only the factory can mint a renderable handle. It contains no exposed data or collections. */
export interface PreparedMapScene {
  readonly [preparedSceneBrand]: true;
}
interface SceneData {
  request: MapRequest;
  source: MapSceneSource;
  systems: MapSelectedSystem[];
  internalPairs: MapInternalPair[];
  boundaryConnections: number;
  boundaryLabel: string;
  pointsOfInterest: RenderedMap["summary"]["pointsOfInterest"];
  routes: RenderedMap["summary"]["routes"];
  legs: RouteLeg[];
}
const scenes = new WeakMap<PreparedMapScene, SceneData>();
const countSchema = z.number().int().nonnegative().max(MAP_DATA_LIMITS.gates);
const factsSchema = z
  .object({
    source: mapSourceSchema.strict(),
    resolutions: z.array(mapResolutionFactSchema),
    systemCount: z.number().int().nonnegative().max(MAP_DATA_LIMITS.systems),
    systems: z
      .array(
        mapSystemSchema
          .extend({
            position: mapSystemSchema.shape.position.strict(),
            position2D: mapSystemSchema.shape.position2D
              .unwrap()
              .strict()
              .optional(),
            regionName: mapText(100),
            constellationName: mapText(100),
            outgoingGateCount: countSchema,
          })
          .strict(),
      )
      .max(MAP_LIMITS.systems),
    internalPairs: z
      .array(
        z
          .object({
            from: mapIdSchema,
            to: mapIdSchema,
            directionMask: z.union([z.literal(1), z.literal(2), z.literal(3)]),
            forwardGateCount: countSchema,
            reverseGateCount: countSchema,
          })
          .strict(),
      )
      .max((MAP_LIMITS.systems * (MAP_LIMITS.systems - 1)) / 2),
    boundaryConnections: countSchema,
  })
  .strict();

function invalid(message: string): never {
  throw new MapError("MAP_DATA_INVALID", message);
}

function resolutionLookup(request: MapRequest, input: MapResolutionFact[]) {
  const parsed = z.array(mapResolutionFactSchema).safeParse(input);
  if (!parsed.success) invalid("Invalid map reference resolution facts.");
  const facts = new Map(parsed.data.map((fact) => [fact.key, fact]));
  const queries = enumerateMapReferences(request);
  if (facts.size !== parsed.data.length || facts.size !== queries.length)
    invalid(
      "Map resolution facts must cover exactly the distinct request references.",
    );
  const names = new Map<string, string>();
  for (const query of queries) {
    const fact = facts.get(query.key);
    if (!fact) invalid("Missing global map reference resolution fact.");
    validateMapResolutionFact(query, fact);
    for (const candidate of fact.candidates) {
      const key = `${query.category}:${candidate.id}`;
      if (names.has(key) && names.get(key) !== candidate.name)
        invalid("Conflicting names in global map resolution facts.");
      names.set(key, candidate.name);
    }
  }
  return (category: MapReferenceCategory, reference: MapReference) =>
    resolveMapReference(
      category,
      reference,
      present(facts.get(mapReferenceQuery(category, reference).key)),
    );
}

function resolvedBoundary(
  request: MapRequest,
  resolve: ReturnType<typeof resolutionLookup>,
): ResolvedMapBoundary {
  const boundary = request.boundary;
  switch (boundary.kind) {
    case "systems":
      return {
        kind: "systems",
        systemIds: [
          ...new Set(boundary.systems.map((ref) => resolve("system", ref).id)),
        ],
      };
    case "region": {
      const region = resolve("region", boundary.region);
      return { kind: "region", regionId: region.id, name: region.name };
    }
    case "constellation": {
      const constellation = resolve("constellation", boundary.constellation);
      return {
        kind: "constellation",
        constellationId: constellation.id,
        name: constellation.name,
      };
    }
    case "extent":
      return { ...boundary };
  }
}

/** Q1 -> Q2 helper. Resolves ONLY the boundary; POI/route errors remain deferred. */
export function resolveMapBoundary(
  input: MapRequest,
  resolutions: MapResolutionFact[],
): ResolvedMapBoundary {
  const request = parseMapRequest(input);
  return resolvedBoundary(request, resolutionLookup(request, resolutions));
}

function inside(system: MapSystem, boundary: ResolvedMapBoundary): boolean {
  switch (boundary.kind) {
    case "systems":
      return boundary.systemIds.includes(system.id);
    case "region":
      return system.regionId === boundary.regionId;
    case "constellation":
      return system.constellationId === boundary.constellationId;
    case "extent": {
      const x = system.position.x / LIGHT_YEAR_METRES;
      const z = system.position.z / LIGHT_YEAR_METRES;
      return (
        x >= boundary.minX &&
        x <= boundary.maxX &&
        z >= boundary.minZ &&
        z <= boundary.maxZ
      );
    }
  }
}

/** Validates selected facts, never a fake/unchecked partial MapCatalog.
 * Providers must read all facts from one validated snapshot and supply exact global
 * counts. Local consistency checks cannot prove the completeness of a remote query.
 */
export function createPreparedMapScene(
  input: MapRequest,
  value: PreparedMapFacts,
): PreparedMapScene {
  const request = parseMapRequest(input);
  const parsed = factsSchema.safeParse(value);
  if (!parsed.success)
    throw new MapError("MAP_DATA_INVALID", "Invalid prepared map facts.", {
      issues: parsed.error.issues
        .slice(0, 8)
        .map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  const facts = parsed.data;
  const resolve = resolutionLookup(request, facts.resolutions);
  const boundary = resolvedBoundary(request, resolve);
  if (
    boundary.kind === "systems" &&
    facts.systemCount !== boundary.systemIds.length
  )
    invalid("Explicit map boundary count is inconsistent.");
  if (!facts.systemCount)
    throw new MapError(
      "EMPTY_MAP_BOUNDARY",
      "The explicit boundary contains no systems.",
    );
  if (facts.systemCount > MAP_LIMITS.systems)
    throw new MapError(
      "MAP_TOO_LARGE",
      `The complete boundary contains ${facts.systemCount} systems; the limit is ${MAP_LIMITS.systems}. No systems were trimmed.`,
      { systemCount: facts.systemCount },
    );
  const systems: MapSelectedSystem[] = facts.systems
    .map(({ position2D, ...system }) => ({
      ...system,
      ...(position2D ? { position2D } : {}),
    }))
    .sort((a, b) => a.id - b.id);
  const selected = new Map(systems.map((system) => [system.id, system]));
  if (
    selected.size !== facts.systemCount ||
    systems.length !== facts.systemCount ||
    systems.some((system) => !inside(system, boundary))
  )
    invalid(
      "Selected systems must cover the complete explicit map boundary exactly once.",
    );
  const regions = new Map<number, string>();
  const constellations = new Map<number, { name: string; regionId: number }>();
  for (const system of systems) {
    const constellation = constellations.get(system.constellationId);
    if (
      (regions.has(system.regionId) &&
        regions.get(system.regionId) !== system.regionName) ||
      (constellation &&
        (constellation.name !== system.constellationName ||
          constellation.regionId !== system.regionId)) ||
      (boundary.kind === "region" && system.regionName !== boundary.name) ||
      (boundary.kind === "constellation" &&
        system.constellationName !== boundary.name)
    )
      invalid("Selected system parent facts are inconsistent.");
    regions.set(system.regionId, system.regionName);
    constellations.set(system.constellationId, {
      name: system.constellationName,
      regionId: system.regionId,
    });
  }
  for (const query of enumerateMapReferences(request)) {
    const fact = present(
      facts.resolutions.find((item) => item.key === query.key),
    );
    for (const candidate of fact.candidates) {
      const name =
        query.category === "system"
          ? selected.get(candidate.id)?.name
          : query.category === "region"
            ? regions.get(candidate.id)
            : constellations.get(candidate.id)?.name;
      if (name !== undefined && name !== candidate.name)
        invalid("Selected names disagree with global resolution facts.");
    }
    const known =
      query.category === "system"
        ? systems
        : query.category === "region"
          ? [...regions].map(([id, name]) => ({ id, name }))
          : [...constellations].map(([id, { name }]) => ({ id, name }));
    const matches = known.filter((item) =>
      typeof query.reference === "number"
        ? item.id === query.reference
        : item.name.trim().toLowerCase() === query.reference,
    );
    if (
      matches.length > fact.candidateCount ||
      matches.some(
        (item) =>
          (fact.candidateCount <= 10 ||
            item.id <= present(fact.candidates[9]).id) &&
          !fact.candidates.some((candidate) => candidate.id === item.id),
      )
    )
      invalid("Global resolution facts omit known selected matches.");
  }
  const pairs = new Map<string, MapInternalPair>();
  const internalOutgoing = new Map<number, number>();
  for (const pair of facts.internalPairs) {
    const key = `${pair.from}:${pair.to}`;
    if (
      pair.from >= pair.to ||
      !selected.has(pair.from) ||
      !selected.has(pair.to) ||
      pairs.has(key) ||
      pair.directionMask !==
        ((pair.forwardGateCount ? 1 : 0) | (pair.reverseGateCount ? 2 : 0))
    )
      invalid("Invalid internal map gate pair.");
    pairs.set(key, pair);
    internalOutgoing.set(
      pair.from,
      (internalOutgoing.get(pair.from) ?? 0) + pair.forwardGateCount,
    );
    internalOutgoing.set(
      pair.to,
      (internalOutgoing.get(pair.to) ?? 0) + pair.reverseGateCount,
    );
  }
  if (
    [...internalOutgoing.values()].reduce((sum, count) => sum + count, 0) +
      facts.boundaryConnections >
      MAP_DATA_LIMITS.gates ||
    systems.reduce((sum, system) => sum + system.outgoingGateCount, 0) >
      MAP_DATA_LIMITS.gates ||
    systems.some(
      (system) =>
        system.outgoingGateCount < (internalOutgoing.get(system.id) ?? 0) ||
        (!facts.boundaryConnections &&
          system.outgoingGateCount !== (internalOutgoing.get(system.id) ?? 0)),
    )
  )
    invalid(
      "Map outgoing gate counts are inconsistent with internal/boundary pairs.",
    );
  const resolveInside = (reference: MapReference) => {
    const match = resolve("system", reference);
    const system = selected.get(match.id);
    if (!system)
      throw new MapError(
        "OUT_OF_BOUNDARY",
        `System ${match.id} is outside the explicit map boundary.`,
        { systemId: match.id },
      );
    return system;
  };
  const pointsOfInterest = request.pointsOfInterest.map((poi) => {
    const system = resolveInside(poi.system);
    return {
      systemId: system.id,
      systemName: system.name,
      label: poi.label,
      kind: poi.kind,
      ...(poi.note === undefined ? {} : { note: poi.note }),
    };
  });
  const legs: RouteLeg[] = [];
  const routes = request.routes.map((route, index) => {
    // Resolve the whole path before checking its hops, then move to the next route.
    const path = route.systems.map(resolveInside);
    for (let hop = 1; hop < path.length; hop++) {
      const from = present(path[hop - 1]).id;
      const to = present(path[hop]).id;
      const pair = pairs.get(`${Math.min(from, to)}:${Math.max(from, to)}`);
      if (!pair || !(pair.directionMask & (from < to ? 1 : 2)))
        throw new MapError(
          "INVALID_ROUTE_ADJACENCY",
          `Route ${index + 1}, hop ${hop}: no directed gate from ${from} to ${to}. Routes are never repaired.`,
          { route: index + 1, hop, from, to },
        );
      legs.push({ from, to, route: index, hop });
    }
    return {
      label: route.label ?? `Route ${index + 1}`,
      systems: path.map(({ id, name }) => ({ id, name })),
      jumps: path.length - 1,
    };
  });
  const boundaryLabel =
    boundary.kind === "systems"
      ? `Explicit systems / ${systems.length} selected`
      : boundary.kind === "region"
        ? `Region / ${boundary.name}`
        : boundary.kind === "constellation"
          ? `Constellation / ${boundary.name}`
          : `X/Z extent (ly) / X ${boundary.minX} to ${boundary.maxX}; Z ${boundary.minZ} to ${boundary.maxZ}`;
  const scene = Object.freeze({}) as PreparedMapScene;
  scenes.set(scene, {
    request,
    source: facts.source,
    systems,
    internalPairs: [...pairs.values()].sort(
      (a, b) => a.from - b.from || a.to - b.to,
    ),
    boundaryConnections: facts.boundaryConnections,
    boundaryLabel,
    pointsOfInterest,
    routes,
    legs,
  });
  return scene;
}

/** @internal Returns a detached copy, never mutable access to the stored scene. */
export function readPreparedMapScene(
  scene: PreparedMapScene,
  input?: MapRequest,
): SceneData {
  const data = scenes.get(scene);
  if (!data)
    invalid("Prepared map scene was not created by the validated factory.");
  if (
    input !== undefined &&
    JSON.stringify(parseMapRequest(input)) !== JSON.stringify(data.request)
  )
    throw new MapError(
      "INVALID_MAP_REQUEST",
      "Prepared map scene belongs to a different request.",
    );
  return structuredClone(data);
}

/** Compatibility preparation from a real, fully validated catalog. */
export function prepareMapScene(
  catalog: MapCatalog,
  input: MapRequest,
): PreparedMapScene {
  const request = parseMapRequest(input);
  const resolutions = enumerateMapReferences(request).map((query) =>
    catalog.resolutionFact(query),
  );
  const boundary = resolveMapBoundary(request, resolutions);
  const selected = [...catalog.systems.values()].filter((system) =>
    inside(system, boundary),
  );
  const ids = new Set(selected.map((system) => system.id));
  const outgoing = new Map<number, number>();
  const pairs = new Map<string, MapInternalPair>();
  const external = new Set<string>();
  for (const gate of catalog.data.gates) {
    if (ids.has(gate.systemId))
      outgoing.set(gate.systemId, (outgoing.get(gate.systemId) ?? 0) + 1);
    const from = Math.min(gate.systemId, gate.destinationId);
    const to = Math.max(gate.systemId, gate.destinationId);
    const key = `${from}:${to}`;
    if (ids.has(from) && ids.has(to)) {
      const pair = pairs.get(key) ?? {
        from,
        to,
        directionMask: 1,
        forwardGateCount: 0,
        reverseGateCount: 0,
      };
      if (gate.systemId === from) pair.forwardGateCount++;
      else pair.reverseGateCount++;
      pair.directionMask = pair.forwardGateCount
        ? pair.reverseGateCount
          ? 3
          : 1
        : 2;
      pairs.set(key, pair);
    } else if (ids.has(from) || ids.has(to)) external.add(key);
  }
  return createPreparedMapScene(request, {
    source: {
      buildNumber: catalog.data.buildNumber,
      releaseDate: catalog.data.releaseDate,
      sourceUrl: catalog.data.sourceUrl,
      fetchedAt: catalog.data.fetchedAt,
    },
    resolutions,
    systemCount: selected.length,
    systems:
      selected.length > MAP_LIMITS.systems
        ? []
        : selected.map((system) => ({
            ...system,
            regionName: catalog.resolveRegion(system.regionId).name,
            constellationName: catalog.resolveConstellation(
              system.constellationId,
            ).name,
            outgoingGateCount: outgoing.get(system.id) ?? 0,
          })),
    internalPairs:
      selected.length > MAP_LIMITS.systems ? [] : [...pairs.values()],
    boundaryConnections: external.size,
  });
}
