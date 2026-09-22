import { routeValue } from "../route-plan.js";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { diagnosticMetadata, withSpan } from "../telemetry.js";
import {
  planRoute,
  routePlanSchema,
  routeRequestSchema,
} from "../route-plan.js";
import {
  PLANNING_AUTHORITY,
  ROUTE_INSTRUCTIONS,
  renderRouteGuidance,
} from "../route-guidance.js";
import { compactOutputSchema } from "../output-schema.js";
import { renderItinerary, itineraryPage } from "./itinerary.js";
import { renderMap, renderPreparedMap } from "./render.js";
import { mapRequestSchema, MapError, type MapRequest } from "./types.js";
import type { CartographyServices } from "./service.js";
import { mapSourceSchema } from "./catalog.js";

const routeIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const renderRequestSchema = z
  .object({
    routeId: routeIdSchema
      .optional()
      .describe(
        "Opaque routeId returned by plan_eve_route. Routes are loaded server-side; never supply or reconstruct system arrays.",
      ),
    page: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe(
        "Zero-based itinerary page returned by the server; same routeId for every page.",
      ),
    boundary: mapRequestSchema.shape.boundary.optional(),
    pointsOfInterest: mapRequestSchema.shape.pointsOfInterest.optional(),
    routes: z
      .array(z.never())
      .max(0)
      .optional()
      .describe(
        "Nonempty raw routes are forbidden. Use plan_eve_route and routeId.",
      ),
    layout: z.enum(["atlas", "geographic", "itinerary"]).default("atlas"),
    theme: mapRequestSchema.shape.theme,
    size: mapRequestSchema.shape.size,
    title: mapRequestSchema.shape.title,
    preview: mapRequestSchema.shape.preview,
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      request.routeId
        ? request.boundary !== undefined ||
          request.pointsOfInterest !== undefined ||
          request.routes !== undefined
        : request.boundary === undefined ||
          request.pointsOfInterest === undefined ||
          request.page !== undefined ||
          request.layout === "itinerary"
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Supply either routeId with presentation options, or an explicit boundary and pointsOfInterest without routes.",
      });
  });
export const routePageSchema = z.object({
  routeId: routeIdSchema,
  page: z.number().int(),
  pageCount: z.number().int(),
  totalJumps: z.number().int(),
  visitStart: z.number().int(),
  visitEnd: z.number().int(),
  visitCount: z.number().int(),
  nextPage: z.number().int().optional(),
});
export const routeResultSchema = z.union([
  z.object({
    status: z.literal("complete"),
    routeId: routeIdSchema,
    expiresAt: z.iso.datetime(),
    totalJumps: z.number().int().min(0).max(249),
    visitCount: z.number().int().min(1).max(250),
    stopOrder: z.enum(["optimize", "as_given"]),
    waypoints: z
      .array(z.object({ id: z.number().int().positive(), name: z.string() }))
      .max(14),
    waypointText: z.string(),
    algorithm: z.literal("BFS + Held-Karp"),
    optimality: z.literal("exact"),
    objective: z.literal("minimum_jumps"),
    source: mapSourceSchema.extend({
      checkedAt: z.string(),
      stale: z.boolean(),
      warning: z.string().optional(),
    }),
    constraints: z.object({
      avoidCount: z.number().int(),
      minimumSecurity: z.number().nullable(),
    }),
    render: z.object({
      tool: z.literal("render_eve_map"),
      arguments: z.object({
        routeId: routeIdSchema,
        preview: z.literal("png"),
      }),
    }),
    caveats: z.array(z.string()),
    manifestUri: z.string(),
  }),
  z.object({
    status: z.enum(["needs_selection", "failed"]),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
]);

function failure(error: unknown) {
  const known = error instanceof MapError;
  const body = {
    status:
      known &&
      ["ROUTE_REFERENCE_UNKNOWN", "ROUTE_REFERENCE_AMBIGUOUS"].includes(
        error.code,
      )
        ? "needs_selection"
        : "failed",
    code: known ? error.code : "ROUTE_PLAN_FAILED",
    message: known
      ? error.message
      : "Route planning failed or was cancelled. No plan was published. Retry the tool; do not construct a substitute route.",
    details: known ? error.details : {},
  };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
    _meta: diagnosticMetadata(),
  };
}

export function registerRoutePlanning(
  server: McpServer,
  services: CartographyServices,
) {
  if (!services.routing) return;
  server.registerTool(
    "plan_eve_route",
    {
      title: "Plan a complete EVE Online route or pickup loop",
      description: `Compute the entire EVE Online permanent-stargate route, ordered stops and jump totals from a complete cached SDE snapshot. Exact BFS paths and bounded Held-Karp optimization; at most 12 stops and 250 visits. Returns a private expiring routeId for render_eve_map. No EVE login or game-state changes. Writes a private plan/map artifact. ${ROUTE_INSTRUCTIONS} ${PLANNING_AUTHORITY}`,
      inputSchema: routeRequestSchema,
      outputSchema: compactOutputSchema(routeResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (request, ctx) =>
      withSpan(
        "eve.tool.plan_eve_route",
        { "gen_ai.tool.name": "plan_eve_route" },
        async () => {
          let finish: (() => void) | undefined;
          try {
            const signal = ctx.mcpReq.signal;
            signal.throwIfAborted();
            finish = services.beginRender?.(signal);
            const graph = await routeValue(services.routing).loadRouteGraph(
              signal,
            );
            signal.throwIfAborted();
            const plan = planRoute(graph, request, signal),
              map = renderItinerary(plan);
            signal.throwIfAborted();
            const artifact = await services.artifacts.put(map, plan.source);
            signal.throwIfAborted();
            const systems = new Map(plan.systems.map((s) => [s.id, s]));
            const waypoints = plan.stopSequence.map((id) => ({
              id,
              name: routeValue(systems.get(id)).name,
            }));
            const body = {
              status: "complete",
              routeId: artifact.id,
              expiresAt: artifact.expiresAt,
              totalJumps: plan.totalJumps,
              visitCount: plan.path.length,
              stopOrder: plan.stopOrder,
              waypoints,
              waypointText: waypoints.map((s) => s.name).join("\n"),
              algorithm: plan.algorithm,
              optimality: plan.optimality,
              objective: plan.objective,
              source: plan.source,
              constraints: {
                avoidCount: plan.avoid.length,
                minimumSecurity: plan.minimumSecurity ?? null,
              },
              render: {
                tool: "render_eve_map",
                arguments: { routeId: artifact.id, preview: "png" },
              },
              caveats: [
                "Exact only for this complete static permanent-stargate snapshot and the requested constraints.",
                "No live safety, wormhole/cyno routing, docking access or cargo-capacity guarantee.",
                "Use this routeId unchanged. Rendering may return consecutive itinerary pages; never merge or redraw them.",
              ],
              manifestUri: artifact.manifestUri,
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(body) }],
              structuredContent: body,
              _meta: diagnosticMetadata(),
            };
          } catch (error) {
            return failure(error);
          } finally {
            finish?.();
          }
        },
      ),
  );
  server.registerPrompt(
    "plan_eve_travel",
    {
      title: "Plan EVE travel using MCP tools only",
      description:
        "Clarify a route or pickup-run request and delegate all routing, optimization and rendering to the MCP.",
      argsSchema: z.object({
        goal: z.string().min(1).max(4000),
        constraints: z.string().max(4000).optional(),
      }),
    },
    ({ goal, constraints }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: renderRouteGuidance(goal, constraints),
          },
        },
      ],
    }),
  );
}

export async function prepareMapRender(
  services: CartographyServices,
  input: z.infer<typeof renderRequestSchema>,
  signal: AbortSignal,
) {
  if (!input.routeId) {
    const request = mapRequestSchema.parse({
      boundary: input.boundary,
      pointsOfInterest: input.pointsOfInterest,
      routes: [],
      layout: input.layout,
      theme: input.theme,
      size: input.size,
      title: input.title,
      preview: input.preview,
    });
    const prepared =
      "prepare" in services.data
        ? await services.data.prepare(request, signal)
        : await services.data.initialize();
    signal.throwIfAborted();
    return {
      map:
        "scene" in prepared
          ? renderPreparedMap(prepared.scene, request)
          : renderMap(prepared.catalog, request),
      status: prepared.status,
      request,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(
      (await services.artifacts.read(input.routeId, "manifest.json")).text,
    );
  } catch {
    throw new MapError(
      "ROUTE_PLAN_UNAVAILABLE",
      "The routeId is unavailable or expired. Call plan_eve_route again; do not reconstruct the old route.",
    );
  }
  const planResult = routePlanSchema.safeParse(
    typeof value === "object" && value !== null && "routePlan" in value
      ? value.routePlan
      : undefined,
  );
  if (!planResult.success)
    throw new MapError(
      "ROUTE_PLAN_UNAVAILABLE",
      "This artifact is not a valid server-computed route. Call plan_eve_route.",
    );
  const plan = planResult.data;
  signal.throwIfAborted();
  const page = input.page ?? 0,
    pagination = itineraryPage(plan, page);
  let map = renderItinerary(plan, page, input.theme, {
    size: input.size,
    ...(input.title === undefined ? {} : { title: input.title }),
  });
  const request: MapRequest = mapRequestSchema.parse({
    boundary: { kind: "systems", systems: plan.systems.map((s) => s.id) },
    pointsOfInterest: [],
    routes: [],
    theme: input.theme,
    size: input.size,
    preview: input.preview,
    layout: input.layout === "itinerary" ? "atlas" : input.layout,
    ...(input.title ? { title: input.title } : {}),
  });
  let fallback = "";
  if (input.layout !== "itinerary" && input.page === undefined) {
    if (plan.path.length > 100)
      fallback = "The full route exceeds the atlas route bound.";
    else
      try {
        const geoRequest = mapRequestSchema.parse({
          ...request,
          routes: [{ systems: plan.path, label: "Verified route" }],
        });
        const prepared =
          "prepare" in services.data
            ? await services.data.prepare(geoRequest, signal)
            : await services.data.initialize();
        signal.throwIfAborted();
        if (
          ["buildNumber", "sourceUrl", "releaseDate", "fetchedAt"].some(
            (key) =>
              prepared.status[key as keyof typeof prepared.status] !==
              plan.source[key as keyof typeof plan.source],
          )
        )
          fallback =
            "The available geometry belongs to a different snapshot; the stored plan is unchanged.";
        else
          map = {
            ...("scene" in prepared
              ? renderPreparedMap(prepared.scene, geoRequest)
              : renderMap(prepared.catalog, geoRequest)),
            routePlan: plan,
          };
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof MapError) || error.code === "MAP_CANCELLED")
          throw error;
        fallback =
          error.code === "MAP_TOO_DENSE"
            ? "The geographic/atlas layout is too dense for readable labels."
            : "Current atlas geometry is unavailable for this stored plan.";
      }
  }
  map.layout.requested = input.layout;
  if (fallback)
    map.warnings.push({
      code: "ROUTE_ITINERARY_FALLBACK",
      message: `${fallback} The server rendered consecutive itinerary pages without altering any route steps.`,
    });
  const isItinerary = map.layout.used === "itinerary";
  return {
    map,
    status: plan.source,
    request,
    route: {
      routeId: input.routeId,
      page: isItinerary ? page : 0,
      pageCount: isItinerary ? pagination.pageCount : 1,
      totalJumps: plan.totalJumps,
      visitStart: isItinerary ? pagination.start + 1 : 1,
      visitEnd: isItinerary
        ? pagination.start + pagination.path.length
        : plan.path.length,
      visitCount: plan.path.length,
      ...(isItinerary && pagination.nextPage !== undefined
        ? { nextPage: pagination.nextPage }
        : {}),
    },
  };
}
