import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EsiClient } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { createEveServer } from "../src/server.js";
import { jsonBytes, MODEL_RESULT_BYTES } from "../src/response-budget.js";
import { fixtureDocument } from "./fixtures.js";
import { loadOpenApiDocument } from "./openapi-fixture.js";
import { fixtureSource, skill, skillFixture } from "./skill-fixtures.js";

const connections: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()));
});
const scopes = [
  "esi-assets.read_assets.v1",
  "esi-skills.read_skills.v1",
  "esi-skills.read_skillqueue.v1",
];
const jwt = (characterId: number) =>
  `h.${Buffer.from(JSON.stringify({ sub: `CHARACTER:EVE:${characterId}`, scp: scopes })).toString("base64url")}.s`;
async function connect(
  catalog: OperationCatalog,
  esi: EsiClient,
  staticData = fixtureSource(),
) {
  const server = createEveServer(catalog, esi, {
    identity: { name: "budget-test", version: "1" },
    staticData,
  });
  const client = new Client({ name: "budget-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  connections.push(client, server);
  return client;
}

describe("MCP response budgets", () => {
  it("pins implicit acting identity on cached and upstream continuations and rechecks revoked authorization", async () => {
    const document = fixtureDocument();
    document.paths["/protected-status"] = {
      get: {
        operationId: "GetProtectedStatus",
        security: [{ OAuth2: ["esi-assets.read_assets.v1"] }],
        parameters: [
          {
            name: "page",
            in: "query",
            schema: { type: "integer", default: 1 },
          },
        ],
      },
    };
    const catalog = new OperationCatalog(document);
    let selected = 42;
    let revoked = false;
    const tokens = vi.fn((_scopes: string[], id?: number) => {
      if (revoked) return Promise.reject(new Error("Authorization revoked"));
      return Promise.resolve(jwt(id ?? selected));
    });
    const network = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          Array.from({ length: 60 }, (_, id) => ({ id })),
          { headers: { "cache-control": "max-age=300", "x-pages": "2" } },
        ),
      ),
    );
    const client = await connect(
      catalog,
      new EsiClient(
        catalog,
        { getAccessToken: tokens },
        { fetchImplementation: network },
      ),
    );
    const first = await client.callTool({
      name: "call_esi",
      arguments: { operationId: "GetProtectedStatus" },
    });
    expect(first.structuredContent).toMatchObject({
      actingCharacterId: 42,
      pagination: { nextCall: { actingCharacterId: 42, query: { page: 2 } } },
      output: { returned: 25, total: 60, nextOffset: 25, complete: false },
    });
    const output = (first.structuredContent as { output: { snapshot: string } })
      .output;
    selected = 43;
    const args = {
      operationId: "GetProtectedStatus",
      response: { offset: 25, snapshot: output.snapshot },
    };
    expect(
      (await client.callTool({ name: "call_esi", arguments: args }))
        .structuredContent,
    ).toMatchObject({ code: "CHARACTER_SELECTION_REQUIRED" });
    const second = await client.callTool({
      name: "call_esi",
      arguments: { ...args, actingCharacterId: 42 },
    });
    expect(second.structuredContent).toMatchObject({
      cached: true,
      actingCharacterId: 42,
      data: Array.from({ length: 25 }, (_, i) => ({ id: i + 25 })),
      output: { returned: 25, nextOffset: 50 },
    });
    expect(network).toHaveBeenCalledTimes(1);
    expect(tokens).toHaveBeenLastCalledWith(scopes.slice(0, 1), 42);
    const changed = await client.callTool({
      name: "call_esi",
      arguments: { ...args, actingCharacterId: 43 },
    });
    expect(changed.isError).toBe(true);
    expect(changed.structuredContent).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    revoked = true;
    const denied = await client.callTool({
      name: "call_esi",
      arguments: { ...args, actingCharacterId: 42 },
    });
    expect(denied.isError).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("reconstructs a large public page while keeping credentials absent and detecting changed evidence", async () => {
    const catalog = new OperationCatalog(fixtureDocument());
    let rows = Array.from({ length: 1000 }, (_, id) => ({
      id,
      text: "x".repeat(240),
    }));
    const tokens = vi.fn(() =>
      Promise.reject(new Error("Public call must not authenticate")),
    );
    const network = vi.fn<typeof fetch>((_url, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Promise.resolve(Response.json(rows));
    });
    const client = await connect(
      catalog,
      new EsiClient(
        catalog,
        { getAccessToken: tokens },
        { fetchImplementation: network },
      ),
    );
    let response: Record<string, unknown> | undefined;
    const observed: unknown[] = [];
    do {
      const result = await client.callTool({
        name: "call_esi",
        arguments: {
          operationId: "GetStatus",
          ...(response ? { response } : {}),
        },
      });
      expect(result.isError).not.toBe(true);
      expect(jsonBytes(result.structuredContent)).toBeLessThanOrEqual(
        MODEL_RESULT_BYTES,
      );
      const body = result.structuredContent as {
        data: unknown[];
        output: { nextOffset: number | null; snapshot: string };
      };
      observed.push(...body.data);
      if (body.output.nextOffset === null) break;
      response = {
        offset: body.output.nextOffset,
        snapshot: body.output.snapshot,
      };
    } while (observed.length < rows.length);
    expect(observed).toEqual(rows);
    rows = [...rows].reverse();
    expect(
      (
        await client.callTool({
          name: "call_esi",
          arguments: { operationId: "GetStatus", response },
        })
      ).isError,
    ).toBe(true);
    expect(tokens).not.toHaveBeenCalled();
  });

  it("bounds skills, retains section failures and exposes independent graph, queue and import text", async () => {
    const catalog = new OperationCatalog(await loadOpenApiDocument());
    const skills = Array.from({ length: 500 }, (_, i) => ({
      skill_id: 10000 + i,
      active_skill_level: 5,
      trained_skill_level: 5,
      skillpoints_in_skill: 256000,
    }));
    const chained = Array.from({ length: 30 }, (_, i) =>
      skill(1000 + i, `Skill ${i}`, i ? [{ skillId: 999 + i, level: 5 }] : []),
    );
    const network = vi.fn<typeof fetch>((input) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === "string"
            ? input
            : input.url;
      if (url.includes("/skillqueue"))
        return Promise.resolve(Response.json([]));
      if (url.includes("/skills"))
        return Promise.resolve(
          Response.json({
            skills,
            total_sp: 128000000,
            unallocated_sp: 0,
          }),
        );
      return Promise.resolve(new Response(null, { status: 503 }));
    });
    const client = await connect(
      catalog,
      new EsiClient(
        catalog,
        { getAccessToken: () => Promise.resolve(jwt(42)) },
        { fetchImplementation: network },
      ),
      fixtureSource(skillFixture(chained)),
    );
    const context = await client.callTool({
      name: "get_character_context",
      arguments: {
        characterId: 42,
        sections: ["skills", "skillQueue", "profile"],
      },
    });
    expect(context.structuredContent).toMatchObject({
      status: "partial",
      sections: {
        skills: {
          status: "ok",
          data: { total_sp: 128000000 },
          output: {
            complete: false,
            omitted: [{ path: ["skills"], total: 500 }],
          },
        },
        profile: { status: "error" },
        skillQueue: { data: [], output: { complete: true, total: 0 } },
      },
    });
    const detail = await client.callTool({
      name: "get_character_context",
      arguments: {
        characterId: 42,
        sections: ["skills"],
        response: { path: ["skills"] },
      },
    });
    expect(detail.structuredContent).toMatchObject({
      sections: { skills: { output: { total: 500, returned: 25 } } },
    });
    expect(
      (
        await client.callTool({
          name: "get_character_context",
          arguments: {
            characterId: 42,
            sections: ["skills", "profile"],
            response: {},
          },
        })
      ).isError,
    ).toBe(true);
    const args = { characterId: 42, target: { typeId: 1029, level: 5 } };
    const plan = await client.callTool({
      name: "generate_skill_plan",
      arguments: args,
    });
    expect(plan.isError).not.toBe(true);
    expect(jsonBytes(plan.structuredContent)).toBeLessThan(12_000);
    expect(plan.structuredContent).toMatchObject({
      counts: { plan: 150, graphNodes: 150 },
      output: { path: ["plan"], returned: 25, total: 150 },
    });
    for (const key of ["graph", "trainingText", "retainedQueue"])
      expect(plan.structuredContent).not.toHaveProperty(key);
    const snapshot = (
      plan.structuredContent as { output: { snapshot: string } }
    ).output.snapshot;
    const graph = await client.callTool({
      name: "generate_skill_plan",
      arguments: { ...args, response: { path: ["graph", "nodes"], snapshot } },
    });
    expect(graph.structuredContent).toMatchObject({
      output: { total: 150, returned: 25 },
    });
    const text = await client.callTool({
      name: "generate_skill_plan",
      arguments: { ...args, response: { path: ["trainingText"], snapshot } },
    });
    expect(text.structuredContent).toMatchObject({
      data: expect.stringContaining("Skill 29 V"),
      output: { complete: true },
    });
  });
});
