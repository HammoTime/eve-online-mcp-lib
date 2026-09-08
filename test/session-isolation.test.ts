import { describe, expect, it, vi } from "vitest";
import { StaticTokenProvider } from "../src/auth.js";
import { EsiClient } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { fixtureDocument } from "./fixtures.js";

describe("session boundaries", () => {
  it("does not reuse protected results or authorization handles across clients", async () => {
    const token = `h.${Buffer.from(JSON.stringify({ sub: "CHARACTER:EVE:1", scp: ["esi-assets.read_assets.v1"] })).toString("base64url")}.s`;
    const catalog = new OperationCatalog(fixtureDocument());
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        Response.json([], {
          headers: { "cache-control": "private, max-age=300" },
        }),
      ),
    );
    const first = new EsiClient(catalog, new StaticTokenProvider(token), {
      fetchImplementation: fetcher,
    });
    const second = new EsiClient(catalog, new StaticTokenProvider(token), {
      fetchImplementation: fetcher,
    });
    const input = {
      operationId: "GetCharacterAssets",
      path: { character_id: 1 },
    };
    await first.call(input);
    expect((await first.call(input)).cached).toBe(true);
    expect((await second.call(input)).cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const handle = await first.authorize(["esi-assets.read_assets.v1"], 1);
    await expect(second.call(input, handle)).rejects.toThrow(
      "Invalid ESI authorization context",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
