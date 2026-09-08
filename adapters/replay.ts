import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { EsiClient } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { createEveServer } from "../src/server.js";
import { object, projectOutput } from "../src/diagnostic-policy.js";
import type { OpenApiDocument } from "../src/types.js";
import { SkillCatalog, type StaticCatalog } from "../src/skill-data.js";

const scalar = z.union([
  z.string().max(1024),
  z.number(),
  z.boolean(),
  z.array(z.string().max(1024)).max(64),
]);
export const replaySchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.literal(1),
    traceId: z.string().regex(/^[a-f0-9]{32}$/u),
    boundary: z.literal("mcp"),
    status: z.enum(["exact", "partial"]),
    reasons: z.array(z.string().max(100)).max(30),
    versions: z.record(z.string().max(40), z.string().max(128)),
    request: z.object({
      method: z.literal("tools/call"),
      tool: z.string().max(100),
      arguments: z.record(z.string(), z.unknown()),
    }),
    dependencies: z
      .array(
        z
          .object({
            ordinal: z.number().int().positive(),
            operationId: z.string().max(150),
            input: z.record(z.string(), z.unknown()),
            cached: z.boolean(),
            startedAt: z.number(),
            fetchedAt: z.number(),
            status: z.number().int().min(100).max(599).optional(),
            headers: z.record(z.string(), z.string().max(256)).optional(),
            body: z.string().max(786432).optional(),
            bodyArtifact: z
              .object({
                sha256: z.string().regex(/^[a-f0-9]{64}$/u),
                key: z.string().regex(/^dependencies\/[a-f0-9]{64}\.json$/u),
              })
              .strict()
              .optional(),
            bodyBytes: z.number().int().nonnegative().optional(),
            errorCode: z.literal("NETWORK_ERROR").optional(),
          })
          .strict(),
      )
      .max(100),
    catalogs: z
      .array(
        z
          .object({
            kind: z.literal("static_catalog"),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            key: z.string().regex(/^catalogs\/[a-f0-9]{64}\.json$/u),
            status: z.record(
              z.string().max(40),
              z.union([z.string().max(100), z.number(), z.boolean(), z.null()]),
            ),
          })
          .strict(),
      )
      .max(10),
    expected: z.record(z.string(), scalar),
  })
  .strict();

/** No production auth, static data download or network access. All I/O fails
 * closed unless it matches the next captured dependency in order. */
export async function replayDiagnostic(
  value: unknown,
  document: OpenApiDocument,
  catalogs: ReadonlyMap<string, StaticCatalog> = new Map(),
  bodies: ReadonlyMap<string, string> = new Map(),
) {
  const manifest = replaySchema.parse(value);
  if (manifest.status !== "exact" || manifest.reasons.length)
    throw new Error(
      "Capture is partial; supply a reviewed synthetic fixture instead of claiming exact replay",
    );
  if (
    ![
      "call_esi",
      "get_market_snapshot",
      "get_skill_dependencies",
      "resolve_skill_plan_targets",
      "initialize_static_data",
    ].includes(manifest.request.tool)
  )
    throw new Error("Unsupported replay adapter");
  if (manifest.dependencies.some((d) => d.cached))
    throw new Error("Initial cache fixture is missing");
  const catalog = new OperationCatalog(document);
  let index = 0,
    clockIndex = 0;
  let catalogIndex = 0;
  const clocks = manifest.dependencies.flatMap((d) => [
    d.startedAt,
    d.fetchedAt,
  ]);
  const esi = new EsiClient(
    catalog,
    {
      getAccessToken: () => {
        throw new Error(
          "Protected authentication is unavailable in exact public replay",
        );
      },
    },
    {
      clock: () => {
        const time = clocks[clockIndex++];
        if (time === undefined) throw new Error("Unrecorded clock access");
        return new Date(time);
      },
      fetchImplementation: (input, init) => {
        const dependency = manifest.dependencies[index++];
        if (dependency?.ordinal !== index)
          throw new Error("Unrecorded or out-of-order dependency");
        const operation = catalog.get(dependency.operationId);
        const path = Object.entries(object(dependency.input.path)).reduce(
          (path, [key, val]) =>
            path.replace(`{${key}}`, encodeURIComponent(String(val))),
          operation.path,
        );
        const url =
          input instanceof URL
            ? input
            : new URL(typeof input === "string" ? input : input.url);
        if (
          url.origin !== "https://esi.evetech.net" ||
          url.pathname !== path ||
          init?.method !== operation.method ||
          operation.requiredScopes.length
        )
          throw new Error("Dependency request differs from capture");
        for (const parameter of operation.parameters.filter(
          (p) => p.in === "query",
        )) {
          const expected =
            object(dependency.input.query)[parameter.name] ??
            catalog.schemaFor(parameter).default;
          if (
            expected !== undefined &&
            url.searchParams.get(parameter.name) !==
              (typeof expected === "string" ||
              typeof expected === "number" ||
              typeof expected === "boolean"
                ? String(expected)
                : "invalid-complex-default")
          )
            throw new Error("Dependency query differs from capture");
        }
        if (dependency.errorCode) throw new Error("Recorded network failure");
        const body = dependency.bodyArtifact
          ? bodies.get(dependency.bodyArtifact.sha256)
          : dependency.body;
        if (dependency.status === undefined || body === undefined)
          throw new Error("Dependency response is missing");
        return Promise.resolve(
          new Response(body, {
            status: dependency.status,
            ...(dependency.headers ? { headers: dependency.headers } : {}),
          }),
        );
      },
    },
  );
  const server = createEveServer(catalog, esi, {
    identity: {
      name: "eve-replay",
      version: manifest.versions.server ?? "unknown",
    },
    staticData: {
      initialize: () => {
        const ref = manifest.catalogs[catalogIndex++],
          data = ref ? catalogs.get(ref.sha256) : undefined;
        if (!ref || !data) throw new Error("Unrecorded static data dependency");
        return Promise.resolve({
          catalog: new SkillCatalog(data),
          status: ref.status,
        });
      },
    },
  });
  const client = new Client({ name: "eve-replay", version: "1" });
  const [outbound, inbound] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(inbound);
    await client.connect(outbound);
    const result = await client.callTool({
      name: manifest.request.tool,
      arguments: manifest.request.arguments,
    });
    const output = projectOutput(result.structuredContent);
    const outcome = result.isError
      ? "error"
      : output["eve.output.complete"] === false
        ? "partial"
        : "success";
    const observed: Record<string, unknown> = {
      ...output,
      "eve.outcome": outcome,
    };
    for (const [key, expected] of Object.entries(manifest.expected))
      if (JSON.stringify(observed[key]) !== JSON.stringify(expected))
        throw new Error(`Observable assertion failed: ${key}`);
    if (
      index !== manifest.dependencies.length ||
      clockIndex !== clocks.length ||
      catalogIndex !== manifest.catalogs.length
    )
      throw new Error("Capture dependencies or clocks were not consumed");
    return {
      status: "reproduced",
      boundary: "mcp",
      dependencyCalls: index,
      observed,
      result,
    };
  } finally {
    await client.close();
    await server.close();
  }
}
