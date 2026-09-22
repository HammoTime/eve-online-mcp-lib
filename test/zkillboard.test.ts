import { afterEach, describe, expect, it, vi } from "vitest";
import { ZKillboardClient } from "../src/zkillboard.js";

export const killmail = (id = 123) => ({
  killmail_id: id,
  killmail_time: "2026-09-20T12:00:00Z",
  solar_system_id: 30000142,
  victim: { ship_type_id: 587, character_id: 42, items: [] },
  attackers: [{ character_id: 43, ship_type_id: 588, final_blow: true }],
  zkb: { hash: "a".repeat(40), totalValue: 1000, solo: true },
});
const query = { entityType: "character" as const, entityId: 42 };
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("public zKillboard client", () => {
  it("binds the default Web fetch receiver for Workers and browsers", async () => {
    const fetcher = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json([killmail()]));
    });
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await new ZKillboardClient().get({ killmailId: 123 })).data.killmail_id,
    ).toBe(123);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([301, 302, 307, 308])(
    "rejects redirects without following the destination: %i",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          status,
          headers: { location: "https://untrusted.invalid/" },
        }),
      );
      const client = new ZKillboardClient({ fetchImplementation: fetcher });
      await expect(client.search(query)).rejects.toMatchObject({
        code: "UPSTREAM_ERROR",
        status,
        retryable: false,
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
    },
  );
  it("builds only fixed GET paths, sends project headers and caches isolated copies for an hour", async () => {
    let now = Date.parse("2026-09-22T00:00:00Z");
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json([killmail()])),
    );
    const client = new ZKillboardClient({
      fetchImplementation: fetcher,
      now: () => now,
    });
    const args = {
      ...query,
      side: "losses" as const,
      page: 2,
      solo: true,
      space: "w-space" as const,
      pastSeconds: 7200,
    };
    const first = await client.search(args);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://zkillboard.com/api/characterID/42/losses/solo/w-space/pastSeconds/7200/page/2/",
    );
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
    });
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("user-agent")).toContain("github.com/HammoTime");
    expect(headers.get("accept-encoding")).toBe("gzip");
    expect(first).toMatchObject({
      source: "zKillboard",
      complete: false,
      cached: false,
      pagination: { page: 2, hasMore: false, nextPage: null },
    });
    const firstRow = first.data[0];
    if (!firstRow) throw new Error("Missing fixture row");
    firstRow.victim.ship_type_id = 999;
    expect((await client.search(args)).data[0]?.victim.ship_type_id).toBe(587);
    expect((await client.search(args)).cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 3_600_000;
    expect((await client.search(args)).cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...query, entityId: -1 },
    { ...query, entityId: 1.2 },
    { ...query, entityType: "../post" },
    { ...query, url: "https://example.invalid" },
    { ...query, headers: { Authorization: "untrusted" } },
    { ...query, pastSeconds: 1 },
    { ...query, pastSeconds: 604801 },
    { ...query, page: 101 },
  ])(
    "rejects undeclared or malformed filters before fetching: %j",
    async (input) => {
      const fetcher = vi.fn<typeof fetch>();
      const client = new ZKillboardClient({ fetchImplementation: fetcher });
      await expect(client.search(input as typeof query)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("fetches one matching killmail and rejects invalid, missing or mismatched IDs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([killmail()]))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([killmail(789)]));
    let now = 0;
    const client = new ZKillboardClient({
      fetchImplementation: fetcher,
      now: () => now,
    });
    expect((await client.get({ killmailId: 123 })).data.killmail_id).toBe(123);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://zkillboard.com/api/killID/123/",
    );
    await expect(client.get({ killmailId: 0 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    now += 1000;
    await expect(client.get({ killmailId: 456 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    now += 1000;
    await expect(client.get({ killmailId: 987 })).rejects.toMatchObject({
      code: "INVALID_UPSTREAM_RESPONSE",
    });
  });

  it("treats full pages as possibly continued, never complete, and caps page traversal", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(Array.from({ length: 200 }, (_, i) => killmail(i + 1))),
      ),
    );
    let now = 0;
    const client = new ZKillboardClient({
      fetchImplementation: fetcher,
      now: () => now,
    });
    expect(await client.search(query)).toMatchObject({
      complete: false,
      pagination: { hasMore: null, nextPage: 2 },
    });
    now = 1000;
    expect(await client.search({ ...query, page: 100 })).toMatchObject({
      pagination: { hasMore: null, nextPage: null },
    });
  });

  it.each([
    { error: "private upstream error" },
    {},
    [killmail(), killmail()],
    [{ ...killmail(), victim: null }],
    Array.from({ length: 201 }, (_, i) => killmail(i + 1)),
  ])(
    "rejects error, malformed, duplicate and oversized pages",
    async (body) => {
      const client = new ZKillboardClient({
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json(body)),
      });
      await expect(client.search(query)).rejects.toMatchObject({
        code: "INVALID_UPSTREAM_RESPONSE",
      });
    },
  );

  it.each(["<html>upstream failure</html>", "{", ""])(
    "rejects non-JSON bodies",
    async (body) => {
      const client = new ZKillboardClient({
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(body)),
      });
      await expect(client.search(query)).rejects.toMatchObject({
        code: "INVALID_UPSTREAM_RESPONSE",
      });
    },
  );

  it("bounds streamed bodies even without Content-Length and cancels on overflow", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2_000_001));
      },
      cancel,
    });
    const client = new ZKillboardClient({
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(stream)),
    });
    await expect(client.search(query)).rejects.toMatchObject({
      code: "RESPONSE_LIMIT",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["12", "Tue, 22 Sep 2026 00:00:12 GMT", "invalid", null])(
    "honors Retry-After without a retry loop: %s",
    async (retry) => {
      let now = Date.parse("2026-09-22T00:00:00Z");
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("secret upstream body", {
            status: 429,
            headers: retry === null ? {} : { "Retry-After": retry },
          }),
        )
        .mockResolvedValueOnce(Response.json([]));
      const client = new ZKillboardClient({
        fetchImplementation: fetcher,
        now: () => now,
      });
      const delay = retry === null || retry === "invalid" ? 60 : 12;
      await expect(client.search(query)).rejects.toMatchObject({
        code: "THROTTLED",
        retryAfterSeconds: delay,
      });
      await expect(client.search(query)).rejects.toMatchObject({
        code: "THROTTLED",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      now += delay * 1000;
      expect((await client.search(query)).data).toEqual([]);
    },
  );

  it("sanitizes HTTP and transport failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("secret", { status: 503 }))
      .mockRejectedValueOnce(new Error("secret URL"));
    let now = 0;
    const client = new ZKillboardClient({
      fetchImplementation: fetcher,
      now: () => now,
    });
    await expect(client.search(query)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      status: 503,
      retryable: true,
      details: undefined,
    });
    now = 1000;
    await expect(client.search(query)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "zKillboard request failed",
    });
  });

  it("shares matching downloads, bounds waiters, rejects other concurrent work and isolates cancellation", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = new ZKillboardClient({ fetchImplementation: fetcher });
    const controller = new AbortController();
    const cancelled = client.search(query, controller.signal);
    const rejection = expect(cancelled).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    const waiters = Array.from({ length: 63 }, () => client.search(query));
    await expect(client.search(query)).rejects.toMatchObject({
      code: "THROTTLED",
    });
    await expect(
      client.search({ ...query, entityId: 43 }),
    ).rejects.toMatchObject({ code: "THROTTLED" });
    controller.abort();
    await rejection;
    finish(Response.json([killmail()]));
    const results = await Promise.all(waiters);
    expect(results[0]?.data).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(client.search(query, controller.signal)).rejects.toMatchObject(
      { code: "NETWORK_ERROR" },
    );
  });

  it.each(["fetch", "body"])(
    "enforces the deadline for a stalled %s",
    async (stage) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const fetcher = vi.fn<typeof fetch>(() =>
        stage === "fetch"
          ? new Promise(() => undefined)
          : Promise.resolve(new Response(new ReadableStream({ cancel }))),
      );
      const client = new ZKillboardClient({ fetchImplementation: fetcher });
      const result = expect(client.search(query)).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await result;
      if (stage === "body") expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("evicts old entries at the cache entry bound", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json([])),
    );
    const client = new ZKillboardClient({
      fetchImplementation: fetcher,
      now: () => now,
    });
    for (let entityId = 1; entityId <= 17; entityId++) {
      now += 1000;
      await client.search({ ...query, entityId });
    }
    now += 1000;
    expect((await client.search({ ...query, entityId: 1 })).cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(18);
  });
});
