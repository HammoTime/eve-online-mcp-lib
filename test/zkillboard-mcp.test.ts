import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EsiClient } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { createEveServer } from "../src/server.js";
import { ZKillboardClient } from "../src/zkillboard.js";
import { projectInput, projectOutput } from "../src/diagnostic-policy.js";
import { jsonBytes, MODEL_RESULT_BYTES } from "../src/response-budget.js";
import { fixtureDocument } from "./fixtures.js";
import { fixtureSource } from "./skill-fixtures.js";

const connections: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()));
});
async function setup(rows: unknown) {
  const catalog = new OperationCatalog(fixtureDocument());
  const getAccessToken = vi.fn(() =>
    Promise.reject(new Error("Must not authenticate")),
  );
  const esiFetch = vi.fn<typeof fetch>();
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json(rows)),
  );
  const server = createEveServer(
    catalog,
    new EsiClient(
      catalog,
      { getAccessToken },
      { fetchImplementation: esiFetch },
    ),
    {
      identity: { name: "test", version: "1" },
      staticData: fixtureSource(),
      zkillboard: new ZKillboardClient({ fetchImplementation: fetcher }),
    },
  );
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  connections.push(client, server);
  return { client, getAccessToken, esiFetch, fetcher };
}
const row = (id: number) => ({
  killmail_id: id,
  killmail_time: "2026-09-20T12:00:00Z",
  solar_system_id: 30000142,
  victim: { ship_type_id: 587 },
  attackers: [],
  zkb: { totalValue: 1000 },
});

describe("zKillboard MCP tools", () => {
  it("slices cached pages with stable snapshots without authenticating or treating a slice as history", async () => {
    const { client, getAccessToken, esiFetch, fetcher } = await setup(
      Array.from({ length: 200 }, (_, i) => row(i + 1)),
    );
    const args = { entityType: "character", entityId: 42 };
    const first = await client.callTool({
      name: "search_zkillmails",
      arguments: args,
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      complete: false,
      output: { complete: false, returned: 25, nextOffset: 25 },
      pagination: { nextPage: 2, hasMore: null },
    });
    expect(jsonBytes(first.structuredContent)).toBeLessThanOrEqual(
      MODEL_RESULT_BYTES,
    );
    const { output } = first.structuredContent as {
      output: { snapshot: string };
    };
    const second = await client.callTool({
      name: "search_zkillmails",
      arguments: {
        ...args,
        response: { offset: 25, snapshot: output.snapshot },
      },
    });
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent).toMatchObject({
      cached: true,
      data: [
        { killmail_id: 26 },
        ...Array.from({ length: 24 }, (_, i) => ({ killmail_id: i + 27 })),
      ],
      output: { nextOffset: 50 },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(esiFetch).not.toHaveBeenCalled();
    const changed = await client.callTool({
      name: "search_zkillmails",
      arguments: {
        ...args,
        response: { offset: 25, snapshot: "f".repeat(64) },
      },
    });
    expect(changed.isError).toBe(true);
    expect(changed.structuredContent).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("retrieves oversized nested attacker lists through explicit paths", async () => {
    const { client } = await setup([
      {
        ...row(123),
        attackers: Array.from({ length: 100 }, (_, i) => ({
          character_id: 1000 + i,
        })),
      },
    ]);
    const first = await client.callTool({
      name: "get_zkillmail",
      arguments: { killmailId: 123 },
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      output: {
        complete: false,
        omitted: [{ path: ["attackers"], total: 100 }],
      },
    });
    const second = await client.callTool({
      name: "get_zkillmail",
      arguments: { killmailId: 123, response: { path: ["attackers"] } },
    });
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent).toMatchObject({
      output: { returned: 25, total: 100, nextOffset: 25 },
    });
  });

  it("returns sanitized errors and keeps killmail evidence outside diagnostic projection", async () => {
    const { client } = await setup({ error: "secret upstream message" });
    const result = await client.callTool({
      name: "get_zkillmail",
      arguments: { killmailId: 123 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "INVALID_UPSTREAM_RESPONSE",
    });
    expect(JSON.stringify(result)).not.toContain("secret upstream");
    expect(
      projectInput({ killmailId: 123, entityId: 42, hash: "a".repeat(40) }),
    ).toMatchObject({ value: {}, complete: false });
    expect(
      JSON.stringify(
        projectOutput({ data: { ...row(123), zkb: { hash: "a".repeat(40) } } }),
      ),
    ).not.toContain("aaaa");
  });
});
