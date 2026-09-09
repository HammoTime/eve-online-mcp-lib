import {
  McpServer,
  ResourceTemplate,
  ResourceNotFoundError,
  PROTOCOL_VERSION_META_KEY,
  type ContentBlock,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { attributes, diagnosticMetadata, withSpan } from "../telemetry.js";
import { renderMap } from "./render.js";
import { MapError, MAP_LIMITS, mapRequestSchema } from "./types.js";
import type { CartographyServices } from "./service.js";

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
  }),
  z.object({
    status: z.enum(["failed", "needs_selection"]),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.json()),
  }),
]);

export const MAP_INSTRUCTIONS =
  "Use render_eve_map only to visualize an existing plan: supply an explicit boundary, pointsOfInterest (or []), and any already-ordered route systems obtained from other tools. It never plans, recommends destinations or computes routes. SVG is the primary artifact, with an optional PNG preview; inline display depends on the host. Retrieve the original through its MCP resource URI, not by treating it as a public web URL. No EVE login is needed.";

/** Host-independent renderer registration. No EsiClient/planner/auth dependency. */
export function registerCartography(
  server: McpServer,
  services: CartographyServices,
) {
  server.registerTool(
    "render_eve_map",
    {
      title: "Render an EVE Online map of an existing plan",
      description:
        "Render an EVE Online SVG from an explicit boundary, a required list of points of interest and optional already-planned ordered routes. Exact names or numeric IDs; permanent gates only. Never creates plans, chooses destinations, calculates routes or recommends activities. Reads public SDE geography, writes private generated artifacts (up to seven days, subject to storage eviction), and optionally returns a PNG preview. No game-state changes or EVE login. Inline display is host-dependent; read the returned SVG MCP resource for the original.",
      inputSchema: mapRequestSchema,
      outputSchema: mapResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (request, ctx) =>
      withSpan(
        "eve.tool.render_eve_map",
        { "gen_ai.tool.name": "render_eve_map" },
        async () => {
          try {
            const signal = ctx.mcpReq.signal;
            signal.throwIfAborted();
            const { catalog, status } = await services.data.initialize();
            signal.throwIfAborted();
            const map = renderMap(catalog, request);
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
            });
            const content: ContentBlock[] = [
              { type: "text", text: JSON.stringify(structuredContent) },
            ];
            const envelope = ctx.mcpReq.envelope as
              Record<string, unknown> | undefined;
            let version = envelope?.[PROTOCOL_VERSION_META_KEY];
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
