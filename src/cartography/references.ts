import * as z from "zod/v4";
import {
  MapError,
  mapIdSchema,
  mapReferenceSchema,
  mapRequestSchema,
  mapText,
  type MapReference,
  type MapRequest,
} from "./types.js";

export type MapReferenceCategory = "system" | "region" | "constellation";
export interface MapReferenceQuery {
  key: string;
  category: MapReferenceCategory;
  /** Names use exactly trim().toLowerCase(); numeric strings remain names. */
  reference: MapReference;
}
export interface MapResolutionFact {
  key: string;
  /** Exact global count, not the length of a truncated query result. */
  candidateCount: number;
  /** Exactly min(candidateCount, 10) candidates, ordered by ascending ID. */
  candidates: { id: number; name: string }[];
}

export const mapResolutionFactSchema = z
  .object({
    key: z.string(),
    candidateCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    candidates: z
      .array(z.object({ id: mapIdSchema, name: mapText(100) }).strict())
      .max(10),
  })
  .strict();

export function parseMapRequest(input: MapRequest): MapRequest {
  const parsed = mapRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new MapError("INVALID_MAP_REQUEST", "Invalid map request.", {
      issues: parsed.error.issues,
    });
  return parsed.data;
}

export function mapReferenceQuery(
  category: MapReferenceCategory,
  ref: MapReference,
): MapReferenceQuery {
  const parsed = mapReferenceSchema.safeParse(ref);
  if (!parsed.success)
    throw new MapError(
      "MAP_REFERENCE_INVALID",
      "Use a positive safe integer ID or an exact name of at most 100 characters.",
      { category },
    );
  const reference =
    typeof parsed.data === "string" ? parsed.data.toLowerCase() : parsed.data;
  return {
    key: `${category}:${typeof reference === "number" ? "id" : "name"}:${reference}`,
    category,
    reference,
  };
}

/** Deduplicates lookup work only; annotations and ordered route visits are retained. */
export function enumerateMapReferences(input: MapRequest): MapReferenceQuery[] {
  const request = parseMapRequest(input);
  const queries = new Map<string, MapReferenceQuery>();
  const add = (category: MapReferenceCategory, reference: MapReference) => {
    const query = mapReferenceQuery(category, reference);
    queries.set(query.key, query);
  };
  const boundary = request.boundary;
  if (boundary.kind === "systems")
    for (const ref of boundary.systems) add("system", ref);
  else if (boundary.kind === "region") add("region", boundary.region);
  else if (boundary.kind === "constellation")
    add("constellation", boundary.constellation);
  for (const poi of request.pointsOfInterest) add("system", poi.system);
  for (const route of request.routes)
    for (const ref of route.systems) add("system", ref);
  return [...queries.values()];
}

/** Validates lookup evidence without triggering unknown/ambiguous selection errors. */
export function validateMapResolutionFact(
  query: MapReferenceQuery,
  fact: MapResolutionFact,
): MapResolutionFact {
  const parsed = mapResolutionFactSchema.safeParse(fact);
  if (!parsed.success || parsed.data.key !== query.key)
    throw new MapError(
      "MAP_DATA_INVALID",
      "Invalid map reference resolution fact.",
    );
  const { candidates, candidateCount } = parsed.data;
  if (
    candidates.length !== Math.min(candidateCount, 10) ||
    (typeof query.reference === "number" && candidateCount > 1) ||
    candidates.some(
      (candidate, index) =>
        candidate.id <= (candidates[index - 1]?.id ?? 0) ||
        (typeof query.reference === "number"
          ? candidate.id !== query.reference
          : candidate.name.trim().toLowerCase() !== query.reference),
    )
  )
    throw new MapError(
      "MAP_DATA_INVALID",
      "Inconsistent map reference resolution fact.",
    );
  return parsed.data;
}

/** Shared global resolution semantics for catalog and selected-fact providers. */
export function resolveMapReference(
  category: MapReferenceCategory,
  ref: MapReference,
  fact: MapResolutionFact,
): { id: number; name: string } {
  const { candidates, candidateCount } = validateMapResolutionFact(
    mapReferenceQuery(category, ref),
    fact,
  );
  const match = candidates[0];
  if (candidateCount !== 1 || !match)
    throw new MapError(
      candidateCount ? "MAP_REFERENCE_AMBIGUOUS" : "MAP_REFERENCE_UNKNOWN",
      `Select an exact ${category} name or numeric ID; no match was inferred.`,
      {
        category,
        reference: typeof ref === "string" ? ref.trim() : ref,
        candidateCount,
        candidates,
      },
    );
  return match;
}
