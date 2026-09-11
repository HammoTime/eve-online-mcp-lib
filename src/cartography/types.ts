import * as z from "zod/v4";

export const MAP_LIMITS = {
  systems: 250,
  routeSystems: 100,
  routes: 3,
  pointsOfInterest: 12,
  svgBytes: 1_000_000,
  previewBytes: 1_500_000,
  responseBytes: 5_000_000,
} as const;
export const LIGHT_YEAR_METRES = 9_460_730_472_580_800;

export const mapIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
// Text is data, never SVG/CSS. Invalid XML characters and bidi controls are rejected.
export function mapText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        // eslint-disable-next-line no-control-regex -- Reject XML-invalid caller text.
        !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF\uFFFE\uFFFF]/u.test(
          value,
        ),
      "Text contains unsupported control characters",
    );
}
export const mapReferenceSchema = z.union([mapIdSchema, mapText(100)]);
export type MapReference = z.infer<typeof mapReferenceSchema>;

export const mapBoundarySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("systems"),
      systems: z.array(mapReferenceSchema).min(1).max(MAP_LIMITS.systems),
    })
    .strict(),
  z.object({ kind: z.literal("region"), region: mapReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("neighborhood"),
      center: mapReferenceSchema,
      jumps: z.literal(1).default(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("constellation"),
      constellation: mapReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("extent"),
      // Absolute X/Z in light years, inclusive. This selects a projection, not jump range.
      minX: z.number(),
      maxX: z.number(),
      minZ: z.number(),
      maxZ: z.number(),
    })
    .strict(),
]);
export const mapRequestSchema = z
  .object({
    boundary: mapBoundarySchema.describe(
      "Required explicit scope: systems, region, constellation, neighborhood (center plus all incoming/outgoing permanent-stargate neighbors; jumps defaults to 1, only 1 supported), or inclusive X/Z extent in light years. Never inferred from a plan.",
    ),
    pointsOfInterest: z
      .array(
        z
          .object({
            system: mapReferenceSchema,
            label: mapText(60),
            kind: z
              .enum(["activity", "staging", "waypoint", "warning"])
              .default("activity"),
            note: mapText(160).optional(),
          })
          .strict(),
      )
      .max(MAP_LIMITS.pointsOfInterest)
      .describe(
        "Required list of caller-selected points; use [] for none. Labels/notes are caller annotations, not recommendations.",
      ),
    routes: z
      .array(
        z
          .object({
            label: mapText(60).optional(),
            systems: z
              .array(mapReferenceSchema)
              .min(1)
              .max(MAP_LIMITS.routeSystems),
          })
          .strict(),
      )
      .max(MAP_LIMITS.routes)
      .default([])
      .describe(
        "Already-planned ordered paths from other tools. Never calculated, reordered or extended.",
      ),
    title: mapText(100).optional(),
    theme: z.enum(["dark", "light"]).default("dark"),
    layout: z.enum(["atlas", "geographic"]).default("atlas"),
    size: z.enum(["standard", "wide"]).default("standard"),
    preview: z.enum(["png", "none"]).default("png"),
  })
  .strict()
  .refine(
    ({ boundary }) =>
      boundary.kind !== "extent" ||
      (boundary.minX < boundary.maxX && boundary.minZ < boundary.maxZ),
    "Extent minima must be smaller than maxima",
  );
export type MapRequest = z.infer<typeof mapRequestSchema>;
export type MapBoundary = MapRequest["boundary"];

export interface MapSystem {
  id: number;
  name: string;
  regionId: number;
  constellationId: number;
  position: { x: number; y: number; z: number };
  position2D?: { x: number; y: number };
  securityStatus: number;
}
export interface MapData {
  schemaVersion: 1;
  buildNumber: number;
  releaseDate: string;
  sourceUrl: string;
  fetchedAt: string;
  systems: MapSystem[];
  regions: { id: number; name: string }[];
  constellations: { id: number; name: string; regionId: number }[];
  gates: {
    id: number;
    systemId: number;
    destinationId: number;
    destinationGateId: number;
  }[];
}
export interface MapDataStatus {
  buildNumber: number;
  releaseDate: string;
  sourceUrl: string;
  fetchedAt: string;
  checkedAt: string;
  stale: boolean;
  warning?: string;
}
export class MapError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MapError";
  }
}
export interface RenderedMap {
  svg: string;
  width: number;
  height: number;
  title: string;
  summary: {
    systemCount: number;
    edgeCount: number;
    boundaryLabel: string;
    routes: {
      label: string;
      systems: { id: number; name: string }[];
      jumps: number;
    }[];
    pointsOfInterest: {
      systemId: number;
      systemName: string;
      label: string;
      kind: string;
      note?: string;
    }[];
  };
  layout: { requested: string; used: string; coordinateBasis: string };
  completeness: { omittedLabels: number; boundaryConnections: number };
  warnings: { code: string; message: string }[];
}
