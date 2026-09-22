import * as z from "zod/v4";
import { planTargetSchema, requirementSchema, typeId } from "./skill-data.js";
import { jsonPageSchema, responseOutputSchema } from "./response-budget.js";

const strings = z.array(z.string());
const count = z.number().int().nonnegative();
const zkillmailResult = z.object({
  source: z.literal("zKillboard"),
  url: z.string(),
  cached: z.boolean(),
  fetchedAt: z.string(),
  expiresAt: z.string(),
  complete: z.literal(false),
  pagination: z.object({
    page: count.nullable(),
    hasMore: z.literal(false).nullable(),
    nextPage: count.nullable(),
  }),
  caveats: strings,
  ...jsonPageSchema.shape,
});
const jsonRecord = z.record(z.string(), z.json());

// Status is host-owned. Describe known fields without requiring local-only
// metadata or discarding a host's additional JSON progress information.
const staticData = z
  .object({
    buildNumber: typeId.optional(),
    releaseDate: z.string().optional(),
    sourceUrl: z.string().optional(),
    fetchedAt: z.string().optional(),
    checkedAt: z.string().nullable().optional(),
    stale: z.boolean().optional(),
    cacheDirectory: z.string().optional(),
    typeCount: count.optional(),
    skillCount: count.optional(),
    warning: z.string().optional(),
    refreshInProgress: z.boolean().optional(),
    refresh: z.json().optional(),
  })
  .catchall(z.json());

const callArguments = z.object({
  operationId: z.string(),
  actingCharacterId: typeId.optional(),
  path: jsonRecord.optional(),
  query: jsonRecord.optional(),
  headers: jsonRecord.optional(),
  body: z.json().optional(),
});
const source = z.object({
  actingCharacterId: typeId.optional(),
  operationId: z.string(),
  status: z.number().int(),
  url: z.string(),
  cached: z.boolean(),
  headers: z.record(z.string(), z.string()),
  freshness: z.object({
    fetchedAt: z.string(),
    servedAt: z.string(),
    expiresAt: z.string().nullable(),
    sourceLastModified: z.string().nullable(),
  }),
  pagination: z.object({
    mode: z.enum(["page", "none"]),
    currentPage: z.number().int().nullable(),
    totalPages: typeId.nullable(),
    hasMore: z.boolean().nullable(),
    nextCall: callArguments.nullable(),
  }),
});
const publicError = z.object({
  error: z.string(),
  status: z.number().int().nullable(),
  details: z.json(),
  code: z.enum([
    "UNKNOWN_OPERATION",
    "VALIDATION_ERROR",
    "AUTHENTICATION_REQUIRED",
    "AUTHENTICATION_FAILED",
    "MISSING_SCOPES",
    "CHARACTER_MISMATCH",
    "CHARACTER_SELECTION_REQUIRED",
    "FORBIDDEN",
    "NOT_FOUND",
    "THROTTLED",
    "NETWORK_ERROR",
    "UPSTREAM_ERROR",
    "RESPONSE_LIMIT",
    "INVALID_UPSTREAM_RESPONSE",
  ]),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().nullable(),
  suggestedAction: z.string().nullable(),
});
const characters = z.object({
  characters: z
    .json()
    .describe(
      "Bounded character rows: characterId, characterName, scopeCount; scopes only on request. A response.path selection may return one member.",
    ),
  output: responseOutputSchema,
  defaultCharacterId: typeId.nullable(),
  legacyCredentialPendingMigration: z.boolean(),
  browserAuthorizationAvailable: z.boolean(),
});
const targetCandidate = z.object({
  typeId,
  name: z.string(),
  categoryId: typeId,
});
const resolvedTarget = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resolved"),
    input: planTargetSchema,
    typeId,
    name: z.string(),
    kind: z.enum(["skill", "ship"]),
    match: z.enum(["id", "exact-name", "singular-skill-name"]),
    requirements: z.array(requirementSchema),
  }),
  z.object({
    status: z.literal("unresolved"),
    input: planTargetSchema,
    candidates: z.array(targetCandidate),
    message: z.string(),
  }),
  z.object({
    status: z.literal("ambiguous"),
    input: planTargetSchema,
    candidates: z.array(targetCandidate),
    candidatesTruncated: z.boolean().optional(),
  }),
  z.object({
    status: z.literal("unsupported"),
    input: planTargetSchema,
    message: z.string(),
  }),
]);
export { resolvedTarget as resolvedTargetSchema };
const targetSelection = z.object({
  status: z.literal("needs_target_selection"),
  resolvedTargets: z.array(resolvedTarget),
  staticData,
});
const operation = z.object({
  operationId: z.string(),
  method: z.enum(["GET", "HEAD", "POST"]),
  path: z.string(),
  summary: z.string(),
  tags: strings,
  authenticated: z.boolean(),
  requiredScopes: strings,
  description: z.string().optional(),
  cacheSeconds: z.number().optional(),
  rateLimit: z.json().optional(),
  requestBodySchema: z.json().optional(),
  requestBodyRequired: z.boolean().optional(),
});
const parameter = z.object({
  name: z.string(),
  in: z.enum(["path", "query", "header", "cookie"]),
  required: z.boolean(),
  description: z.string(),
  schema: z.json(),
});
const section = z.discriminatedUnion("status", [
  jsonPageSchema.extend({ status: z.literal("ok"), source }),
  z.object({ status: z.literal("error"), error: publicError }),
]);
const sectionName = z.enum([
  "profile",
  "location",
  "ship",
  "skills",
  "skillQueue",
  "wallet",
]);

// All alternatives below are objects. The explicit JSON Schema root type keeps
// the SDK's legacy codec from wrapping these existing bodies in { result: ... }.
// These are success contracts; the SDK skips output validation for isError=true.
export const toolOutputSchemas = {
  search_zkillmails: zkillmailResult,
  get_zkillmail: zkillmailResult,
  initialize_static_data: staticData,
  resolve_skill_plan_targets: z.object({
    staticData,
    targets: z
      .json()
      .describe(
        "Bounded resolved, ambiguous, unresolved or unsupported target results, or selected member. Missing rows are described by output.",
      ),
    output: responseOutputSchema,
  }),
  get_skill_dependencies: z
    .discriminatedUnion("status", [
      targetSelection,
      z.object({
        status: z.literal("complete"),
        resolvedTargets: z.array(resolvedTarget),
        staticData,
        ...jsonPageSchema.shape,
        counts: z.object({ graphNodes: count, graphEdges: count }),
        scope: z.string(),
      }),
    ])
    .meta({ type: "object" }),
  generate_skill_plan: z
    .discriminatedUnion("status", [
      targetSelection,
      z.object({
        status: z.literal("complete"),
        dependencyChecked: z.literal(true),
        characterId: typeId,
        queuePolicy: z.enum(["preserve", "reorder"]),
        resolvedTargets: z.array(resolvedTarget),
        staticData,
        baseline: z.enum([
          "conditional after retained queue",
          "observed trained skills",
        ]),
        characterSources: z.object({ skills: source, skillQueue: source }),
        atomic: z.literal(false),
        ...jsonPageSchema.shape,
        counts: z.object({
          plan: count,
          retainedQueue: count,
          acquisitionChecks: count,
          graphNodes: count,
          graphEdges: count,
        }),
        additionalSkillPointsEstimate: z.number().nonnegative(),
        trainingTextKind: z.enum([
          "additions after retained queue",
          "proposed replacement including existing commitments",
        ]),
        queueSlotsRemaining: count,
        caveats: strings,
      }),
    ])
    .meta({ type: "object" }),
  list_eve_characters: characters,
  authorize_eve_character: z
    .union([
      characters,
      z.object({
        status: z.literal("authorization_required"),
        authorizationUrl: z.string(),
        characterId: typeId,
        message: z.string(),
      }),
    ])
    .meta({ type: "object" }),
  select_eve_character: characters,
  search_esi_operations: z.object({
    count,
    operations: z.array(
      z.object({
        operationId: z.string(),
        summary: z.string(),
        authenticated: z.boolean(),
        matchReasons: strings,
      }),
    ),
    totalMatches: count,
    offset: count,
    hasMore: z.boolean(),
    nextOffset: count.nullable(),
  }),
  get_esi_operation: operation.extend({
    parameters: z.array(parameter),
    invocation: z.object({
      tool: z.literal("call_esi"),
      operationId: z.string(),
      requiredCallerInputs: z.object({
        path: z.array(parameter),
        query: z.array(parameter),
        headers: z.array(parameter),
        body: z.json(),
      }),
      declaredDefaults: z.object({ query: jsonRecord, headers: jsonRecord }),
      suppliedByClient: strings,
    }),
    pagination: z.object({
      mode: z.enum(["page", "none"]),
      parameterName: z.string().nullable(),
      instructions: z.string().nullable(),
    }),
    notes: strings,
    exampleCall: z
      .object({
        label: z.string(),
        arguments: callArguments,
      })
      .optional(),
  }),
  call_esi: source.extend(jsonPageSchema.shape),
  resolve_eve_entities: z.object({
    matchMode: z.literal("exact"),
    results: z
      .json()
      .describe(
        "Bounded exact entity matches (input, status, candidates with id/name/category), or selected member. Omitted evidence is not unresolved evidence.",
      ),
    output: responseOutputSchema,
    source,
    caveat: z.string().optional(),
  }),
  get_character_context: z.object({
    characterId: typeId,
    requestedSections: z.array(sectionName),
    status: z.enum(["complete", "partial"]),
    sections: z.partialRecord(sectionName, section),
    atomic: z.literal(false),
    caveats: strings,
  }),
  get_market_snapshot: z.object({
    regionId: typeId,
    typeId,
    locationId: typeId.nullable(),
    scope: z.literal("public regional market orders only"),
    pagesFetched: count,
    observedPageCount: typeId.nullable(),
    complete: z.boolean(),
    stopReason: z.enum([
      "allPagesFetched",
      "pageError",
      "byteLimit",
      "invalidPage",
      "unknownPageCount",
      "pageCountChanged",
      "maxPages",
      "inconsistentData",
    ]),
    warnings: strings,
    sources: z.array(source.extend({ page: typeId })),
    aggregates: z.object({
      buyOrderCount: count,
      sellOrderCount: count,
      buyVolumeRemaining: z.number().nonnegative(),
      sellVolumeRemaining: z.number().nonnegative(),
      highestObservedBuy: z.number().nonnegative().nullable(),
      lowestObservedSell: z.number().nonnegative().nullable(),
      observedSpread: z.number().nullable(),
    }),
  }),
};
