import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticTokenProvider } from "../src/auth.js";
import type { CharacterAuthentication } from "../src/character-authentication.js";
import { EsiClient } from "../src/esi-client.js";
import { OperationCatalog, publicOperation } from "../src/openapi.js";
import { createEveServer } from "../src/server.js";
import { toolOutputSchemas } from "../src/tool-output-schemas.js";
import * as telemetry from "../src/telemetry.js";
import { fixtureDocument } from "./fixtures.js";
import { loadOpenApiDocument } from "./openapi-fixture.js";
import { fixtureSource, skill, skillFixture } from "./skill-fixtures.js";

type ToolName = keyof typeof toolOutputSchemas;
const connections: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  vi.restoreAllMocks();
});

const localStatus = {
  buildNumber: 123,
  releaseDate: "2026-09-01T00:00:00Z",
  sourceUrl: "https://example.invalid/synthetic-sde.zip",
  fetchedAt: "2026-09-07T00:00:00Z",
  checkedAt: "2026-09-10T00:00:00Z",
  stale: false,
  cacheDirectory: "/synthetic/cache",
  typeCount: 4,
  skillCount: 3,
};
const characterList: Awaited<ReturnType<CharacterAuthentication["list"]>> = {
  characters: [
    {
      characterId: 42,
      characterName: "Synthetic Pilot",
      scopes: ["esi-skills.read_skills.v1"],
    },
  ],
  defaultCharacterId: 42,
  legacyCredentialPendingMigration: false,
  browserAuthorizationAvailable: true,
};

function textEquivalent(result: CallToolResult) {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]).toEqual({
    type: "text",
    text: JSON.stringify(result.structuredContent, null, 2),
  });
  expect(result.structuredContent).not.toHaveProperty("result");
  expect(result._meta).toBeDefined();
}

async function setup(
  options: {
    version?: string;
    authenticated?: boolean;
    hosted?: boolean;
    status?: Record<string, unknown>;
    data?: ReturnType<typeof skillFixture>;
    catalog?: OperationCatalog;
  } = {},
) {
  const document = fixtureDocument();
  for (const [suffix, operationId, scope] of [
    ["skills", "GetCharactersCharacterIdSkills", "esi-skills.read_skills.v1"],
    [
      "skillqueue",
      "GetCharactersCharacterIdSkillqueue",
      "esi-skills.read_skillqueue.v1",
    ],
    [
      "wallet",
      "GetCharactersCharacterIdWallet",
      "esi-wallet.read_character_wallet.v1",
    ],
    ["ship", "GetCharactersCharacterIdShip", "esi-location.read_ship_type.v1"],
  ] as const) {
    document.paths[`/characters/{character_id}/${suffix}`] = {
      get: {
        operationId,
        parameters: [
          {
            name: "character_id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        security: [{ OAuth2: [scope] }],
      },
    };
  }
  const catalog = options.catalog ?? new OperationCatalog(document);
  const token =
    options.authenticated === false
      ? undefined
      : `h.${Buffer.from(
          JSON.stringify({
            sub: "CHARACTER:EVE:42",
            scp: [
              "esi-skills.read_skills.v1",
              "esi-skills.read_skillqueue.v1",
              "esi-wallet.read_character_wallet.v1",
              "esi-assets.read_assets.v1",
              "esi-location.read_location.v1",
              "esi-location.read_ship_type.v1",
            ],
          }),
        ).toString("base64url")}.s`;
  const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = {
      "x-pages": "2",
      "cache-control": "no-store",
      "x-ratelimit-remaining": "99",
    };
    if (url.pathname.endsWith("/skills"))
      return Promise.resolve(
        Response.json({
          skills: [
            {
              skill_id: 100,
              trained_skill_level: 1,
              active_skill_level: 0,
              skillpoints_in_skill: 250,
            },
          ],
          total_sp: 250,
        }),
      );
    if (url.pathname.endsWith("/skillqueue"))
      return Promise.resolve(
        Response.json([
          {
            skill_id: 100,
            finished_level: 2,
            queue_position: 0,
            level_end_sp: 1415,
            start_date: "2026-09-11T00:00:00Z",
            finish_date: "2026-09-12T00:00:00Z",
          },
        ]),
      );
    if (url.pathname.endsWith("/wallet"))
      return Promise.resolve(Response.json(123.45));
    if (url.pathname.endsWith("/assets"))
      return Promise.resolve(Response.json([], { headers }));
    if (url.pathname.endsWith("/orders"))
      return Promise.resolve(
        Response.json(
          [
            {
              order_id: 1,
              type_id: 34,
              location_id: 600,
              volume_remain: 5,
              price: 5,
              is_buy_order: true,
            },
            {
              order_id: 2,
              type_id: 34,
              location_id: 600,
              volume_remain: 10,
              price: 4,
              is_buy_order: false,
            },
          ],
          { headers },
        ),
      );
    if (url.pathname.endsWith("/ids"))
      return Promise.resolve(
        Response.json({
          characters: [{ id: 42, name: "Pilot" }],
          corporations: [{ id: 43, name: "Pilot" }],
          inventory_types: [{ id: 34, name: "Tritanium" }],
        }),
      );
    if (url.pathname.endsWith("/names"))
      return Promise.resolve(
        Response.json([{ id: 42, name: "Pilot", category: "character" }]),
      );
    return Promise.resolve(Response.json({ name: "Synthetic Pilot" }));
  });
  const esi = new EsiClient(catalog, new StaticTokenProvider(token), {
    fetchImplementation: fetcher,
    clock: () => new Date("2026-09-10T00:00:00Z"),
  });
  const staticData = fixtureSource(options.data);
  const initialized = await staticData.initialize();
  vi.spyOn(staticData, "initialize").mockResolvedValue({
    ...initialized,
    status: options.status ?? localStatus,
  });
  const authentication: CharacterAuthentication = {
    list: vi.fn(() => Promise.resolve(characterList)),
    select: vi.fn(() => Promise.resolve(characterList)),
    authorize: vi.fn((characterId) =>
      Promise.resolve(
        options.hosted
          ? {
              status: "authorization_required" as const,
              authorizationUrl: "https://example.invalid/account/characters",
              characterId,
              message: "Complete browser consent, then retry.",
            }
          : characterList,
      ),
    ),
  };
  let server: ReturnType<typeof createEveServer> | undefined;
  const createServer = () => {
    server = createEveServer(catalog, esi, {
      identity: { name: "output-contract-test", version: "1.0.0" },
      staticData,
      authentication,
      ...(options.hosted
        ? { hostedAuthorizationUrl: "https://example.invalid" }
        : {}),
    });
    return server;
  };
  const version = options.version ?? "2025-11-25";
  const client = new Client(
    { name: "output-contract-client", version: "1.0.0" },
    {
      supportedProtocolVersions: [version],
      versionNegotiation: {
        mode: version === "2026-07-28" ? { pin: version } : "legacy",
      },
    },
  );
  connections.push(client);
  const httpMethods: string[] = [];
  if (version === "2026-07-28") {
    const handler = createMcpHandler(createServer, {
      legacy: "reject",
      keepAliveMs: 0,
    });
    connections.push(handler);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL("https://mcp.example.invalid/mcp"),
        {
          fetch: async (url, init) => {
            const request = new Request(url, init);
            expect(request.url).toBe("https://mcp.example.invalid/mcp");
            expect(request.method).toBe("POST");
            expect(request.headers.get("mcp-protocol-version")).toBe(version);
            const method = request.headers.get("mcp-method");
            if (!method) throw new Error("Missing modern MCP method header");
            expect(await request.clone().json()).toMatchObject({
              method,
              params: {
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": version,
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              },
            });
            httpMethods.push(method);
            return handler.fetch(request);
          },
        },
      ),
    );
  } else {
    const [a, b] = InMemoryTransport.createLinkedPair();
    let initializedVersion: unknown;
    const send = b.send.bind(b);
    b.send = (message, options) => {
      if ("result" in message && "protocolVersion" in message.result)
        initializedVersion = message.result.protocolVersion;
      return send(message, options);
    };
    const legacyServer = createServer();
    connections.push(legacyServer);
    await legacyServer.connect(b);
    await client.connect(a);
    expect(initializedVersion).toBe(version);
  }
  const { tools } = await client.listTools();
  if (!server) throw new Error("No server handled tool discovery");
  if (version === "2026-07-28") {
    expect(httpMethods[0]).toBe("server/discover");
    expect(httpMethods).toContain("tools/list");
  }
  const provider = new AjvJsonSchemaValidator();
  const validators = new Map(
    tools.map((tool) => {
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      if (!tool.outputSchema)
        throw new Error(`Missing schema for ${tool.name}`);
      expect(tool.outputSchema.properties ?? {}).not.toHaveProperty("result");
      const { $schema, ...schema } = tool.outputSchema;
      return [
        tool.name,
        provider.getValidator(
          $schema === undefined ? schema : { ...schema, $schema },
        ),
      ] as const;
    }),
  );
  function check(name: ToolName, value: unknown, valid: boolean) {
    const validator = validators.get(name);
    if (!validator) throw new Error(`Missing validator for ${name}`);
    expect(validator(value).valid, `${name}: ${JSON.stringify(value)}`).toBe(
      valid,
    );
    expect(toolOutputSchemas[name].safeParse(value).success, name).toBe(valid);
  }
  async function call(name: ToolName, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (version === "2026-07-28") expect(httpMethods.at(-1)).toBe("tools/call");
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    textEquivalent(result);
    check(name, result.structuredContent, true);
    return result.structuredContent;
  }
  return {
    client,
    server,
    tools,
    call,
    check,
    fetcher,
    esi,
    staticData,
    authentication,
  };
}

describe("core tool output contracts", () => {
  it.each(["2025-03-26", "2025-11-25", "2026-07-28"])(
    "lists and calls all 13 object-root contracts without rewrapping on %s",
    async (version) => {
      vi.spyOn(telemetry, "diagnosticMetadata").mockReturnValue({
        "eve/trace-id": "a".repeat(32),
      });
      const { tools, client, call, check } = await setup({ version });
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        Object.keys(toolOutputSchemas).sort(),
      );
      const cases: [ToolName, Record<string, unknown>, string, unknown][] = [
        ["initialize_static_data", {}, "stale", "false"],
        ["resolve_skill_plan_targets", { target: "Mining II" }, "targets", {}],
        [
          "get_skill_dependencies",
          { target: "Test Hull" },
          "status",
          "invented",
        ],
        [
          "generate_skill_plan",
          { characterId: 42, target: "Exhumers II" },
          "plan",
          {},
        ],
        ["list_eve_characters", {}, "characters", {}],
        ["authorize_eve_character", { characterId: 42 }, "characters", {}],
        [
          "select_eve_character",
          { characterId: 42 },
          "defaultCharacterId",
          "42",
        ],
        ["search_esi_operations", { limit: 1 }, "nextOffset", "1"],
        [
          "get_esi_operation",
          { operationId: "GetCharacterAssets" },
          "parameters",
          {},
        ],
        ["call_esi", { operationId: "GetStatus" }, "cached", "false"],
        [
          "resolve_eve_entities",
          { names: ["Pilot", "Missing", "Tritanium"] },
          "matchMode",
          "fuzzy",
        ],
        [
          "get_character_context",
          {
            characterId: 42,
            sections: [
              "profile",
              "skills",
              "skillQueue",
              "wallet",
              "location",
              "ship",
            ],
          },
          "atomic",
          true,
        ],
        [
          "get_market_snapshot",
          { regionId: 1, typeId: 34, maxPages: 1 },
          "aggregates",
          [],
        ],
      ];
      for (const [name, args, field, invalid] of cases) {
        const body = await call(name, args);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("Expected object body");
        check(name, { ...body, [field]: invalid }, false);
        check(name, [], false);
        if (name !== "initialize_static_data") {
          const missing = Object.fromEntries(
            Object.entries(body).filter(([key]) => key !== field),
          );
          check(name, missing, false);
        }
      }
      const result = await client.callTool({
        name: "list_eve_characters",
        arguments: {},
      });
      expect(result._meta).toMatchObject({ "eve/trace-id": "a".repeat(32) });
      expect(result.structuredContent).toEqual(characterList);
    },
  );

  it.each(["2025-03-26", "2025-11-25", "2026-07-28"])(
    "keeps hosted authorization and target-selection branches unwrapped on %s",
    async (version) => {
      const { call, fetcher } = await setup({ version, hosted: true });
      expect(
        await call("authorize_eve_character", { characterId: 42 }),
      ).toEqual({
        status: "authorization_required",
        authorizationUrl: "https://example.invalid/account/characters",
        characterId: 42,
        message: "Complete browser consent, then retry.",
      });
      for (const name of [
        "get_skill_dependencies",
        "generate_skill_plan",
      ] as const) {
        expect(
          await call(name, {
            target: "Missing",
            ...(name === "generate_skill_plan" ? { characterId: 42 } : {}),
          }),
        ).toMatchObject({
          status: "needs_target_selection",
          resolvedTargets: [{ status: "unresolved", input: "Missing" }],
          staticData: localStatus,
        });
      }
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("validates search and inspection contracts for every pinned read-only operation", async () => {
    const catalog = new OperationCatalog(await loadOpenApiDocument());
    const { call, fetcher } = await setup({ catalog, authenticated: false });
    expect(catalog.operations.length).toBeGreaterThan(0);
    const searched: string[] = [];
    for (let offset = 0; offset < catalog.operations.length; offset += 100) {
      const page = toolOutputSchemas.search_esi_operations.parse(
        await call("search_esi_operations", { offset, limit: 100 }),
      );
      const expected = catalog.operations.slice(offset, offset + 100);
      expect(page).toMatchObject({
        count: expected.length,
        totalMatches: catalog.operations.length,
        offset,
        hasMore: offset + expected.length < catalog.operations.length,
        nextOffset:
          offset + expected.length < catalog.operations.length
            ? offset + expected.length
            : null,
      });
      for (const [index, match] of page.operations.entries()) {
        const descriptor = expected[index];
        if (!descriptor) throw new Error("Unexpected search operation");
        const { matchReasons, ...summary } = match;
        expect(matchReasons).toEqual([]);
        expect(summary).toEqual(publicOperation(descriptor));
        searched.push(match.operationId);
      }
    }
    expect(searched).toEqual(
      catalog.operations.map((item) => item.operationId),
    );

    for (const descriptor of catalog.operations) {
      const detail = toolOutputSchemas.get_esi_operation.parse(
        await call("get_esi_operation", {
          operationId: descriptor.operationId,
        }),
      );
      const summary = publicOperation(descriptor);
      expect(detail, descriptor.operationId).toMatchObject(summary);
      for (const field of [
        "description",
        "cacheSeconds",
        "rateLimit",
        "requestBodySchema",
        "requestBodyRequired",
      ]) {
        expect(
          Object.hasOwn(detail, field),
          `${descriptor.operationId}.${field}`,
        ).toBe(Object.hasOwn(summary, field));
      }
      expect(detail.parameters).toEqual(
        descriptor.parameters.map((parameter) => ({
          name: parameter.name,
          in: parameter.in,
          required: parameter.required ?? false,
          description: parameter.description ?? "",
          schema: catalog.resolvedSchema(parameter.schema ?? {}),
        })),
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves hosted authorization, nullable character selection and host static status extensions", async () => {
    const status = {
      buildNumber: 123,
      sourceUrl: localStatus.sourceUrl,
      checkedAt: null,
      stale: true,
      refreshInProgress: true,
      refresh: { error: "Check failed; serving published build" },
      hostProgress: [1, null, "pending"],
    };
    const { call, check, authentication } = await setup({
      hosted: true,
      status,
    });
    expect(await call("initialize_static_data", { refresh: true })).toEqual(
      status,
    );
    expect(await call("authorize_eve_character", { characterId: 42 })).toEqual({
      status: "authorization_required",
      authorizationUrl: "https://example.invalid/account/characters",
      characterId: 42,
      message: "Complete browser consent, then retry.",
    });
    check(
      "authorize_eve_character",
      { status: "authorization_required", characterId: 42 },
      false,
    );
    vi.spyOn(authentication, "list").mockResolvedValue({
      ...characterList,
      characters: [],
      defaultCharacterId: null,
      legacyCredentialPendingMigration: true,
    });
    expect(await call("list_eve_characters")).toMatchObject({
      characters: [],
      defaultCharacterId: null,
    });
    check("initialize_static_data", {}, true);
    check(
      "initialize_static_data",
      {
        refresh: [false, null, 1],
        warning: "Retained old build",
        stale: true,
      },
      true,
    );
  });

  it("retains all target-selection outcomes and complete queue-policy plan fields", async () => {
    const data = skillFixture();
    data.types.push(skill(501, "Duplicate"), skill(502, "Duplicate"), {
      ...skill(503, "Module II"),
      categoryId: 7,
    });
    const { call, check } = await setup({ data });
    const targets = [
      "Mining II",
      "exhumer",
      { typeId: 400 },
      "Missing",
      "Duplicate",
      "Module II",
    ];
    const resolved = toolOutputSchemas.resolve_skill_plan_targets.parse(
      await call("resolve_skill_plan_targets", { targets }),
    );
    expect(resolved.targets.map((target) => target.status)).toEqual([
      "resolved",
      "resolved",
      "resolved",
      "unresolved",
      "ambiguous",
      "unsupported",
    ]);
    for (const name of [
      "get_skill_dependencies",
      "generate_skill_plan",
    ] as const) {
      expect(
        await call(name, {
          targets,
          ...(name === "generate_skill_plan" ? { characterId: 42 } : {}),
        }),
      ).toMatchObject({ status: "needs_target_selection" });
      check(
        name,
        { status: "complete", resolvedTargets: [], staticData: {} },
        false,
      );
    }
    for (const queuePolicy of ["preserve", "reorder"] as const) {
      const plan = toolOutputSchemas.generate_skill_plan.parse(
        await call("generate_skill_plan", {
          characterId: 42,
          target: "Exhumers II",
          queuePolicy,
        }),
      );
      if (plan.status !== "complete") throw new Error("Expected complete plan");
      expect(plan.retainedQueue[0]).toMatchObject({
        level_end_sp: 1415,
        start_date: expect.any(String),
        finish_date: expect.any(String),
      });
      expect(plan.plan[0]).toHaveProperty("prerequisites");
      expect(plan.plan[0]).toHaveProperty("key");
      expect(plan.acquisitionChecks).toEqual([
        { skillId: 200, name: "Exhumers", action: expect.any(String) },
      ]);
      check(
        "generate_skill_plan",
        { ...plan, plan: [{ ...plan.plan[0], observedTrainedLevel: 6 }] },
        false,
      );
    }
  });

  it.each(
    [
      null,
      123.45,
      true,
      "text",
      [1, null, { nested: [false] }],
      { nested: [null, "text"] },
    ].map((data) => ({ data })),
  )(
    "allows arbitrary JSON ESI data without restricting it to objects: %j",
    async ({ data }) => {
      const { fetcher, call } = await setup();
      fetcher.mockResolvedValueOnce(Response.json(data));
      expect(
        await call("call_esi", { operationId: "GetStatus" }),
      ).toMatchObject({
        data,
      });
    },
  );

  it("allows empty additions and queue entries without optional timing/SP fields", async () => {
    const { call, fetcher } = await setup();
    fetcher.mockResolvedValueOnce(Response.json({ skills: [], total_sp: 0 }));
    fetcher.mockResolvedValueOnce(
      Response.json([{ skill_id: 100, finished_level: 1, queue_position: 0 }]),
    );
    expect(
      await call("generate_skill_plan", {
        characterId: 42,
        target: "Mining I",
      }),
    ).toMatchObject({
      status: "complete",
      plan: [],
      trainingText: "",
      additionalSkillPointsEstimate: 0,
      graph: { nodes: [], edges: [] },
      retainedQueue: [{ skill_id: 100, finished_level: 1, queue_position: 0 }],
    });
  });

  it("preserves plain-text/empty responses, cached freshness, and pagination next calls", async () => {
    const { fetcher, call, check } = await setup();
    fetcher.mockResolvedValueOnce(new Response("not JSON"));
    expect(await call("call_esi", { operationId: "GetStatus" })).toMatchObject({
      data: "not JSON",
    });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect(await call("call_esi", { operationId: "GetStatus" })).toMatchObject({
      status: 304,
      data: null,
    });
    fetcher.mockResolvedValueOnce(
      Response.json(
        { players: 1 },
        {
          headers: {
            "cache-control": "max-age=60",
            "last-modified": "Wed, 09 Sep 2026 00:00:00 GMT",
          },
        },
      ),
    );
    await call("call_esi", { operationId: "GetStatus" });
    expect(await call("call_esi", { operationId: "GetStatus" })).toMatchObject({
      cached: true,
      freshness: {
        expiresAt: "2026-09-10T00:01:00.000Z",
        sourceLastModified: "2026-09-09T00:00:00.000Z",
      },
    });
    const result = toolOutputSchemas.call_esi.parse(
      await call("call_esi", {
        operationId: "GetCharacterAssets",
        actingCharacterId: 42,
        path: { character_id: 42 },
        query: { page: 1 },
        headers: { "If-None-Match": "old" },
      }),
    );
    expect(result.pagination).toEqual({
      mode: "page",
      currentPage: 1,
      totalPages: 2,
      hasMore: true,
      nextCall: {
        operationId: "GetCharacterAssets",
        actingCharacterId: 42,
        path: { character_id: 42 },
        query: { page: 2 },
        headers: {},
      },
    });
    check(
      "call_esi",
      {
        ...result,
        pagination: { ...result.pagination, nextCall: { query: { page: 2 } } },
      },
      false,
    );
    expect(result.headers).toHaveProperty("x-ratelimit-remaining", "99");
  });

  it("preserves operation schemas/defaults/examples and search pagination", async () => {
    const { call, check } = await setup();
    expect(await call("search_esi_operations", { limit: 1 })).toMatchObject({
      count: 1,
      hasMore: true,
      nextOffset: 1,
    });
    expect(
      await call("search_esi_operations", { query: "no-such-operation" }),
    ).toMatchObject({
      count: 0,
      operations: [],
      hasMore: false,
      nextOffset: null,
    });
    const operation = toolOutputSchemas.get_esi_operation.parse(
      await call("get_esi_operation", { operationId: "PostUniverseNames" }),
    );
    expect(operation.requestBodySchema).toMatchObject({
      type: "array",
      items: { type: "integer" },
    });
    expect(operation.invocation.requiredCallerInputs.body).toEqual(
      operation.requestBodySchema,
    );
    expect(operation.exampleCall?.arguments).toEqual({
      operationId: "PostUniverseNames",
      body: [34],
    });
    const market = toolOutputSchemas.get_esi_operation.parse(
      await call("get_esi_operation", {
        operationId: "GetMarketsRegionIdOrders",
      }),
    );
    expect(market.invocation.declaredDefaults.query).toEqual({
      order_type: "all",
    });
    check(
      "get_esi_operation",
      {
        ...market,
        parameters: [{ ...market.parameters[0], required: "true" }],
      },
      false,
    );
    check(
      "get_esi_operation",
      { ...market, parameters: [{ ...market.parameters[0], schema: false }] },
      true,
    );
    expect(
      await call("resolve_eve_entities", { ids: [42, 999] }),
    ).toMatchObject({
      results: [
        { input: 42, status: "resolved" },
        { input: 999, status: "unresolved" },
      ],
      caveat: expect.any(String),
    });
  });

  it("validates partial sections but leaves failed and shared error bodies and OAuth metadata intact", async () => {
    const { client, call, check, staticData } = await setup({
      authenticated: false,
      hosted: true,
    });
    const partial = toolOutputSchemas.get_character_context.parse(
      await call("get_character_context", {
        characterId: 42,
        sections: ["profile", "wallet"],
      }),
    );
    expect(partial).toMatchObject({
      status: "partial",
      sections: {
        profile: { status: "ok" },
        wallet: {
          status: "error",
          error: {
            code: "AUTHENTICATION_REQUIRED",
            status: 401,
            details: {
              characterId: 42,
              requiredScopes: ["esi-wallet.read_character_wallet.v1"],
            },
            retryAfterSeconds: null,
          },
        },
      },
    });
    check(
      "get_character_context",
      {
        ...partial,
        sections: {
          wallet: {
            status: "error",
            error: { code: "AUTHENTICATION_REQUIRED" },
          },
        },
      },
      false,
    );
    const failed = await client.callTool({
      name: "get_character_context",
      arguments: { characterId: 42, sections: ["wallet"] },
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ status: "failed" });
    textEquivalent(failed);
    check("get_character_context", failed.structuredContent, false);
    const auth = await client.callTool({
      name: "call_esi",
      arguments: {
        operationId: "GetCharactersCharacterIdWallet",
        path: { character_id: 42 },
      },
    });
    expect(auth.isError).toBe(true);
    textEquivalent(auth);
    expect(auth._meta).toMatchObject({
      "mcp/www_authenticate": [
        'Bearer resource_metadata="https://example.invalid/.well-known/oauth-protected-resource/mcp"',
      ],
    });
    check("call_esi", auth.structuredContent, false);
    vi.spyOn(staticData, "initialize").mockRejectedValue(
      new Error("Synthetic static data failure"),
    );
    for (const [name, args] of [
      ["initialize_static_data", {}],
      ["get_esi_operation", { operationId: "NotAnOperation" }],
    ] as const) {
      const error = await client.callTool({ name, arguments: args });
      expect(error.isError).toBe(true);
      textEquivalent(error);
      expect(error.structuredContent).toHaveProperty("retryable", false);
    }
  });

  it.each([
    ["allPagesFetched", "1", false],
    ["maxPages", "2", false],
    ["unknownPageCount", null, false],
    ["pageError", "2", true],
    ["invalidPage", "2", true],
    ["pageCountChanged", "2", true],
    ["inconsistentData", "2", true],
  ] as const)(
    "preserves market completeness, sources and null aggregates: %s",
    async (reason, pages, secondPage) => {
      const { fetcher, call } = await setup();
      const order = {
        order_id: 1,
        type_id: 34,
        location_id: 600,
        volume_remain: 5,
        price: 5,
        is_buy_order: true,
      };
      fetcher.mockResolvedValueOnce(
        Response.json(reason === "inconsistentData" ? [order] : [], {
          headers: pages ? { "x-pages": pages } : {},
        }),
      );
      if (secondPage)
        fetcher.mockResolvedValueOnce(
          reason === "pageError"
            ? new Response("unavailable", { status: 503 })
            : Response.json(
                reason === "invalidPage"
                  ? {}
                  : reason === "inconsistentData"
                    ? [{ ...order, price: 6 }]
                    : [],
                {
                  headers: {
                    "x-pages": reason === "pageCountChanged" ? "3" : "2",
                  },
                },
              ),
        );
      expect(
        await call("get_market_snapshot", {
          regionId: 1,
          typeId: 34,
          locationId: 600,
          maxPages: secondPage ? 2 : 1,
        }),
      ).toMatchObject({
        complete: reason === "allPagesFetched",
        stopReason: reason,
        locationId: 600,
        aggregates: { lowestObservedSell: null, observedSpread: null },
      });
    },
  );

  it("lets the real SDK reject malformed success outputs rather than advertising a catch-all", async () => {
    const { client, staticData } = await setup();
    const initialized = await staticData.initialize();
    vi.spyOn(staticData, "initialize").mockResolvedValue({
      ...initialized,
      status: { stale: "not a boolean" },
    });
    const result = await client.callTool({
      name: "initialize_static_data",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Output validation error"),
    });
  });

  it("keeps byte-limited markets partial and first-page errors as tool errors", async () => {
    const { call, client, esi, fetcher } = await setup();
    vi.spyOn(esi, "responseByteLength").mockReturnValue(3_000_000);
    expect(
      await call("get_market_snapshot", {
        regionId: 1,
        typeId: 34,
        maxPages: 2,
      }),
    ).toMatchObject({
      complete: false,
      stopReason: "byteLimit",
      pagesFetched: 1,
      locationId: null,
      aggregates: { observedSpread: -1 },
    });
    fetcher.mockResolvedValueOnce(
      Response.json(
        { error: "Synthetic throttle" },
        { status: 429, headers: { "retry-after": "5" } },
      ),
    );
    const error = await client.callTool({
      name: "get_market_snapshot",
      arguments: { regionId: 1, typeId: 34 },
    });
    expect(error.isError).toBe(true);
    expect(error.structuredContent).toMatchObject({
      status: 429,
      code: "THROTTLED",
      retryable: true,
      retryAfterSeconds: 5,
    });
    textEquivalent(error);
  });
});
