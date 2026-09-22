import {
  McpServer,
  ResourceTemplate,
  ResourceNotFoundError,
  PROTOCOL_VERSION_META_KEY,
  type ContentBlock,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { compactOutputSchema } from "../output-schema.js";
import { attributes, diagnosticMetadata, withSpan } from "../telemetry.js";
import { MapError, MAP_LIMITS } from "./types.js";
import type { CartographyServices } from "./service.js";
import {
  prepareMapRender,
  registerRoutePlanning,
  renderRequestSchema,
  routePageSchema,
} from "./routing-mcp.js";
import { PLANNING_AUTHORITY, ROUTE_INSTRUCTIONS } from "../route-guidance.js";

const warningSchema = z.object({ code: z.string(), message: z.string() });
const artifactSchema = z.object({
  id: z.string(),
  uri: z.string(),
  manifestUri: z.string(),
  mimeType: z.literal("image/svg+xml"),
  bytes: z.number().int(),
  sha256: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  expiresAt: z.string(),
});
export const mapResultSchema = z.union([
  z.object({
    status: z.enum(["ready", "partial"]),
    artifact: artifactSchema,
    preview: z.object({
      status: z.enum(["ready", "not_requested", "unavailable", "failed"]),
      width: z.number().optional(),
      height: z.number().optional(),
    }),
    summary: z.object({
      systemCount: z.number().int(),
      edgeCount: z.number().int(),
      boundaryLabel: z.string(),
      routes: z.array(
        z.object({
          label: z.string(),
          systems: z.array(
            z.object({ id: z.number().int(), name: z.string() }),
          ),
          jumps: z.number().int(),
        }),
      ),
      pointsOfInterest: z.array(
        z.object({
          systemId: z.number().int(),
          systemName: z.string(),
          label: z.string(),
          kind: z.string(),
          note: z.string().optional(),
        }),
      ),
    }),
    layout: z.object({
      requested: z.string(),
      used: z.string(),
      coordinateBasis: z.string(),
    }),
    completeness: z.object({
      omittedLabels: z.number().int(),
      boundaryConnections: z.number().int(),
    }),
    sources: z.object({
      staticData: z.object({
        buildNumber: z.number().int(),
        releaseDate: z.string(),
        sourceUrl: z.string(),
        fetchedAt: z.string(),
        checkedAt: z.string(),
        stale: z.boolean(),
        warning: z.string().optional(),
      }),
    }),
    warnings: z.array(warningSchema),
    route: routePageSchema.optional(),
  }),
  z.object({
    status: z.enum(["failed", "needs_selection"]),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.json()),
  }),
]);

export const MAP_INSTRUCTIONS = `${ROUTE_INSTRUCTIONS} Context maps use an explicit boundary and pointsOfInterest (or []). For one system and its immediate permanent-stargate neighbors request boundary:{kind:'neighborhood',center:<exact name or ID>,jumps:1} directly, without ESI discovery or per-neighbor calls. Only jumps:1 is supported. Route maps require routeId from plan_eve_route; raw route arrays are forbidden. SVG is the primary artifact; request preview:png for inline images. Resources use private MCP URIs, not public web URLs. ${PLANNING_AUTHORITY}`;

/** Host-independent renderer registration. No EsiClient/planner/auth dependency. */
export function registerCartography(
  server: McpServer,
  services: CartographyServices,
  protocolVersionHint?: string,
) {
  registerRoutePlanning(server, services);
  server.registerTool(
    "render_eve_map",
    {
      title: "Render an EVE Online map of an existing plan",
      description: `Render an EVE Online server-computed route by routeId, or a context map from an explicit boundary and pointsOfInterest. Nonempty raw routes are rejected. Never creates plans, chooses destinations, calculates routes or recommends activities; call plan_eve_route first. Dense route maps automatically become consecutive numbered itinerary pages; follow route.nextPage with the same routeId. Never redraw, trim or reconstruct a failed map. Request boundary:{kind:'neighborhood',center:<exact name or ID>,jumps:1} directly for immediate permanent-stargate neighbors, without ESI discovery or per-neighbor calls. Only jumps:1 is supported; context boundaries are limited to 250 systems. Writes private expiring SVG artifacts and optionally a PNG preview. No EVE login or game-state changes. ${PLANNING_AUTHORITY}`,
      inputSchema: renderRequestSchema,
      outputSchema: compactOutputSchema(mapResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, ctx) =>
      withSpan(
        "eve.tool.render_eve_map",
        { "gen_ai.tool.name": "render_eve_map" },
        async () => {
          let finish: (() => void) | undefined;
          try {
            const signal = ctx.mcpReq.signal;
            signal.throwIfAborted();
            finish = services.beginRender?.(signal);
            const { map, status, request, route } = await prepareMapRender(
              services,
              input,
              signal,
            );
            signal.throwIfAborted();
            const warnings = [...map.warnings];
            if (status.stale)
              warnings.push({
                code: "STALE_MAP_DATA",
                message:
                  status.warning ?? "Using an older validated SDE snapshot.",
              });
            let preview: {
              status: "ready" | "not_requested" | "unavailable" | "failed";
              width?: number;
              height?: number;
            } = { status: "not_requested" };
            let image: ContentBlock | undefined;
            if (request.preview === "png") {
              preview = { status: "unavailable" };
              if (services.preview) {
                try {
                  const png = await services.preview.render(
                    map.svg,
                    map.width,
                    signal,
                  );
                  if (
                    png.bytes > MAP_LIMITS.previewBytes ||
                    png.data.length > Math.ceil(MAP_LIMITS.previewBytes / 3) * 4
                  )
                    throw new MapError(
                      "MAP_PREVIEW_TOO_LARGE",
                      "Preview exceeds its byte limit.",
                    );
                  preview = {
                    status: "ready",
                    width: png.width,
                    height: png.height,
                  };
                  image = {
                    type: "image",
                    mimeType: "image/png",
                    data: png.data,
                  };
                } catch {
                  signal.throwIfAborted();
                  preview = { status: "failed" };
                }
              }
              if (preview.status !== "ready")
                warnings.push({
                  code: "MAP_PREVIEW_UNAVAILABLE",
                  message:
                    "The SVG is available, but a PNG preview could not be produced. Use the SVG resource in a compatible viewer.",
                });
            }
            signal.throwIfAborted();
            const artifact = await services.artifacts.put(map, status);
            const structuredContent = mapResultSchema.parse({
              status:
                preview.status === "failed" || preview.status === "unavailable"
                  ? "partial"
                  : "ready",
              artifact,
              preview,
              summary: map.summary,
              layout: map.layout,
              completeness: map.completeness,
              sources: { staticData: status },
              warnings,
              ...(route ? { route } : {}),
            });
            const content: ContentBlock[] = [
              { type: "text", text: JSON.stringify(structuredContent) },
            ];
            const envelope = ctx.mcpReq.envelope as
              Record<string, unknown> | undefined;
            let version =
              envelope?.[PROTOCOL_VERSION_META_KEY] ?? protocolVersionHint;
            if (typeof version !== "string") {
              // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy clients have no per-request envelope.
              version = server.server.getNegotiatedProtocolVersion();
            }
            if (version === "2024-11-05" || version === "2025-03-26") {
              content.push({
                type: "resource",
                resource: {
                  uri: artifact.uri,
                  mimeType: "image/svg+xml",
                  text: map.svg,
                },
              });
            } else {
              content.push({
                type: "resource_link",
                uri: artifact.uri,
                name: "map.svg",
                mimeType: "image/svg+xml",
                size: artifact.bytes,
                description:
                  "Original vector map; retrieve through MCP resources/read.",
              });
            }
            if (image) content.push(image);
            const result = {
              content,
              structuredContent,
              _meta: diagnosticMetadata(),
            };
            if (
              new TextEncoder().encode(JSON.stringify(result)).byteLength >
              MAP_LIMITS.responseBytes
            )
              throw new MapError(
                "MAP_OUTPUT_TOO_LARGE",
                "Serialized map response exceeds the five-megabyte limit.",
              );
            attributes({
              "eve.map.system_count": map.summary.systemCount,
              "eve.map.svg_bytes": artifact.bytes,
              "eve.map.theme": request.theme,
              "eve.map.boundary_kind": request.boundary.kind,
            });
            return result;
          } catch (error) {
            const body =
              error instanceof MapError
                ? {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                  }
                : {
                    code: "MAP_RENDER_FAILED",
                    message:
                      "Map rendering was cancelled or failed. No plan was created or changed. Retry with a smaller scope or inspect the server diagnostics.",
                    details: {},
                  };
            const structuredContent = mapResultSchema.parse({
              status:
                body.code === "MAP_REFERENCE_AMBIGUOUS" ||
                body.code === "MAP_REFERENCE_UNKNOWN"
                  ? "needs_selection"
                  : "failed",
              ...body,
            });
            return {
              isError: true as const,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(structuredContent),
                },
              ],
              structuredContent,
              _meta: diagnosticMetadata(),
            };
          } finally {
            finish?.();
          }
        },
      ),
  );
  server.registerResource(
    "eve-map-artifact",
    new ResourceTemplate("eve-map://artifacts/{artifactId}/{file}", {
      list: undefined,
    }),
    {
      title: "Generated EVE Online map artifacts",
      description:
        "Private SVG maps and manifests. Opaque handles expire; never use as a public web URL.",
    },
    async (uri, variables) => {
      const id = variables.artifactId;
      const file = variables.file;
      if (
        typeof id !== "string" ||
        !/^[a-f0-9]{32}$/.test(id) ||
        (file !== "map.svg" && file !== "manifest.json") ||
        uri.href !== `eve-map://artifacts/${id}/${file}`
      )
        throw new ResourceNotFoundError(uri.href);
      try {
        const contents = await services.artifacts.read(id, file);
        return { contents: [{ uri: uri.href, ...contents }] };
      } catch {
        throw new ResourceNotFoundError(
          uri.href,
          "Map artifact is unavailable or expired; render again to create a new artifact.",
        );
      }
    },
  );
}
