import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { context, createContextKey, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { RefreshTokenProvider, StaticTokenProvider } from "../src/auth.js";
import {
  EsiClient,
  publicEsiError,
  type EsiCallInput,
} from "../src/esi-client.js";
import { captureContext, DiagnosticCapture } from "../src/diagnostics.js";
import { operationContext, withSpan, withTelemetry } from "../src/telemetry.js";
import { OperationCatalog } from "../src/openapi.js";
import { fixtureDocument } from "./fixtures.js";

const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
afterAll(() => {
  context.disable();
  manager.disable();
});
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Resource accounting without exposing cache/key material in the public API.
function state(client: EsiClient) {
  return client as unknown as {
    cache: Map<string, unknown>;
    cacheBytes: number;
    inFlight: Map<string, { waiters: Set<unknown> }>;
    activeRequests: number;
  };
}

function token(
  characterId = 42,
  marker = "one",
  scopes = ["esi-assets.read_assets.v1"],
): string {
  return `h.${Buffer.from(JSON.stringify({ sub: `CHARACTER:EVE:${characterId}`, scp: scopes, marker })).toString("base64url")}.s`;
}

function catalog(): OperationCatalog {
  const document = fixtureDocument();
  document.paths["/protected-status"] = {
    get: {
      operationId: "GetProtectedStatus",
      security: [{ OAuth2: ["esi-assets.read_assets.v1"] }],
      parameters: [
        {
          name: "page",
          in: "query",
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        { name: "language", in: "query", schema: { type: "string" } },
        { name: "Accept-Language", in: "header", schema: { type: "string" } },
        { name: "If-None-Match", in: "header", schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: { type: "array", items: { type: "integer" } },
          },
        },
      },
    },
  };
  return new OperationCatalog(document);
}

const protectedInput: EsiCallInput = { operationId: "GetProtectedStatus" };
const publicInput: EsiCallInput = { operationId: "GetStatus" };
const marketInput: EsiCallInput = {
  operationId: "GetMarketsRegionIdOrders",
  path: { region_id: 10000002 },
};
const response = (raw = '[{"value":1}]') =>
  new Response(raw, {
    headers: { "cache-control": "max-age=60", "x-pages": "3" },
  });

describe("ESI cache and single-flight safety", () => {
  it.each([
    "maxResponseBytes",
    "maxCacheEntries",
    "maxCacheBytes",
    "maxInFlightRequests",
    "maxWaitersPerRequest",
    "requestTimeoutMs",
  ] as const)("rejects invalid %s configuration before fetching", (name) => {
    const network = vi.fn<typeof fetch>();
    for (const value of [
      NaN,
      Infinity,
      -Infinity,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      "5",
    ]) {
      expect(
        () =>
          new EsiClient(catalog(), new StaticTokenProvider(undefined), {
            fetchImplementation: network,
            [name]: value,
          }),
      ).toThrow(
        `Invalid ESI client configuration: ${name} must be a positive safe integer`,
      );
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects timeout values that would overflow platform timers", () => {
    expect(
      () =>
        new EsiClient(catalog(), new StaticTokenProvider(undefined), {
          requestTimeoutMs: 2_147_483_648,
        }),
    ).toThrow(/requestTimeoutMs must not exceed/u);
  });

  it.each([false, true])(
    "rebuilds caller pagination on cache hits (explicit first: %s)",
    async (explicitFirst) => {
      let active = 42;
      const tokens = {
        getAccessToken: vi.fn((_scopes?: string[], characterId?: number) =>
          Promise.resolve(token(characterId ?? active)),
        ),
      };
      const network = vi.fn<typeof fetch>(() => Promise.resolve(response()));
      const client = new EsiClient(catalog(), tokens, {
        fetchImplementation: network,
      });
      const explicit = {
        ...protectedInput,
        actingCharacterId: 42,
        query: { page: 1 },
      };
      const first = await client.call(
        explicitFirst ? explicit : protectedInput,
      );
      const second = await client.call(
        explicitFirst ? protectedInput : explicit,
      );
      expect(first.pagination.nextCall?.actingCharacterId).toBe(
        explicitFirst ? 42 : undefined,
      );
      expect(second.pagination.nextCall?.actingCharacterId).toBe(
        explicitFirst ? undefined : 42,
      );
      expect(second.cached).toBe(true);
      expect(network).toHaveBeenCalledTimes(1);
      active = 43;
      const next = explicitFirst
        ? first.pagination.nextCall
        : second.pagination.nextCall;
      if (!next) throw new Error("Missing next call");
      await client.call(next);
      expect(tokens.getAccessToken).toHaveBeenLastCalledWith(
        ["esi-assets.read_assets.v1"],
        42,
      );
      expect(
        new Headers(network.mock.calls[1]?.[1]?.headers).get("authorization"),
      ).toBe(`Bearer ${token(42)}`);
      const url = network.mock.calls[1]?.[0];
      if (!(url instanceof URL)) throw new Error("Expected a URL");
      expect(url.href).not.toContain("actingCharacterId");
    },
  );

  it("isolates caller input, cached data, headers and continuation objects", async () => {
    const pending = deferred<Response>();
    const network = vi.fn<typeof fetch>(() => pending.promise);
    const client = new EsiClient(catalog(), new StaticTokenProvider(token()), {
      fetchImplementation: network,
    });
    const input = {
      ...protectedInput,
      actingCharacterId: 42,
      body: [1],
      headers: { "Accept-Language": "en", "If-None-Match": '"old"' },
    };
    const first = client.call(input);
    input.body[0] = 99;
    input.headers["Accept-Language"] = "de";
    await vi.waitFor(() => {
      expect(network).toHaveBeenCalledTimes(1);
    });
    const original = {
      ...protectedInput,
      body: [1],
      headers: { "accept-language": "en", "if-none-match": '"old"' },
    };
    const second = client.call(original);
    await vi.waitFor(() => {
      expect(state(client).inFlight.values().next().value?.waiters.size).toBe(
        2,
      );
    });
    pending.resolve(response());
    const [a, b] = await Promise.all([first, second]);
    expect(a.pagination.nextCall).toMatchObject({
      actingCharacterId: 42,
      body: [1],
      headers: { "Accept-Language": "en" },
    });
    expect(b.pagination.nextCall?.actingCharacterId).toBeUndefined();
    expect(b.pagination.nextCall?.headers).toEqual({ "accept-language": "en" });
    const firstItem = (a.data as { value: number }[])[0];
    if (!firstItem) throw new Error("Missing response item");
    firstItem.value = 99;
    a.headers["x-pages"] = "9";
    if (!a.pagination.nextCall) throw new Error("Missing next call");
    a.pagination.nextCall.body = [99];
    expect(b.data).toEqual([{ value: 1 }]);
    const cached = await client.call(original);
    expect(cached.headers["x-pages"]).toBe("3");
    expect(cached.pagination.nextCall?.body).toEqual([1]);
    const cachedItem = (cached.data as { value: number }[])[0];
    if (!cachedItem) throw new Error("Missing cached item");
    cachedItem.value = 99;
    expect((await client.call(original)).data).toEqual([{ value: 1 }]);
    expect(client.responseByteLength(cached)).toBe(
      new TextEncoder().encode('[{"value":1}]').byteLength,
    );
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("evicts expired entries even for unrelated lookups and uses LRU entry budgets", async () => {
    let now = 0;
    const network = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const client = new EsiClient(
      catalog(),
      new StaticTokenProvider(undefined),
      {
        fetchImplementation: network,
        clock: () => new Date(now),
        maxCacheEntries: 2,
      },
    );
    const page = (page: number) => ({ ...marketInput, query: { page } });
    await client.call(page(1));
    await client.call(page(2));
    expect((await client.call(page(1))).cached).toBe(true);
    await client.call(page(3));
    expect((await client.call(page(1))).cached).toBe(true);
    expect((await client.call(page(2))).cached).toBe(false);
    expect(state(client).cache.size).toBe(2);
    now = 60_000;
    expect((await client.call(publicInput)).cached).toBe(false);
    expect(state(client).cache.size).toBe(1);
    expect((await client.call(page(2))).cached).toBe(false);
    expect(state(client).cacheBytes).toBeGreaterThan(0);
    expect(network).toHaveBeenCalledTimes(6);
  });

  it("accounts UTF-8 cache bytes including metadata and skips oversized entries", async () => {
    const network = vi.fn<typeof fetch>(() =>
      Promise.resolve(response(JSON.stringify("\u20ac".repeat(200)))),
    );
    const client = new EsiClient(
      catalog(),
      new StaticTokenProvider(undefined),
      { fetchImplementation: network, maxCacheBytes: 900 },
    );
    await client.call(publicInput);
    expect((await client.call(publicInput)).cached).toBe(false);
    expect(state(client).cache.size).toBe(0);
    expect(state(client).cacheBytes).toBe(0);
    const bounded = new EsiClient(
      catalog(),
      new StaticTokenProvider(undefined),
      { fetchImplementation: network, maxCacheBytes: 1_800 },
    );
    await bounded.call({ ...marketInput, query: { page: 1 } });
    await bounded.call({ ...marketInput, query: { page: 2 } });
    expect(state(bounded).cache.size).toBe(1);
    expect(state(bounded).cacheBytes).toBeLessThanOrEqual(1_800);
    expect(state(bounded).cacheBytes).toBeGreaterThan(600);
  });

  it.each([
    "page",
    "language",
    "header",
    "body",
    "token",
    "character",
  ] as const)(
    "does not coalesce or cache across changed %s",
    async (variation) => {
      const pending = deferred<undefined>();
      const network = vi.fn<typeof fetch>(async () => {
        await pending.promise;
        return response();
      });
      let current = token();
      const tokens = { getAccessToken: vi.fn(() => Promise.resolve(current)) };
      const client = new EsiClient(catalog(), tokens, {
        fetchImplementation: network,
      });
      const first = client.call(protectedInput);
      await vi.waitFor(() => {
        expect(network).toHaveBeenCalledTimes(1);
      });
      let other = protectedInput;
      if (variation === "page")
        other = { ...protectedInput, query: { page: 2 } };
      if (variation === "language")
        other = { ...protectedInput, query: { language: "de" } };
      if (variation === "header")
        other = { ...protectedInput, headers: { "Accept-Language": "de" } };
      if (variation === "body") other = { ...protectedInput, body: [1] };
      if (variation === "token") current = token(42, "rotated");
      if (variation === "character") {
        current = token(43);
        other = { ...protectedInput, actingCharacterId: 43 };
      }
      const second = client.call(other);
      await vi.waitFor(() => {
        expect(network).toHaveBeenCalledTimes(2);
      });
      pending.resolve(undefined);
      await Promise.all([first, second]);
      expect((await client.call(other)).cached).toBe(true);
      current = token();
      expect((await client.call(protectedInput)).cached).toBe(true);
      expect(tokens.getAccessToken).toHaveBeenCalledTimes(4);
      expect(network).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["missing", "scope", "character", "context"] as const)(
    "reauthorizes before cache hits and joins: %s denial",
    async (denial) => {
      const pending = deferred<Response>();
      const network = vi.fn<typeof fetch>(() => pending.promise);
      let current: string | undefined = token();
      const tokens = { getAccessToken: vi.fn(() => Promise.resolve(current)) };
      const client = new EsiClient(catalog(), tokens, {
        fetchImplementation: network,
      });
      const input = { ...protectedInput, actingCharacterId: 42 };
      const first = client.call(input);
      await vi.waitFor(() => {
        expect(network).toHaveBeenCalledTimes(1);
      });
      if (denial === "missing") current = undefined;
      if (denial === "scope") current = token(42, "one", []);
      if (denial === "character") current = token(43);
      const code = {
        missing: "AUTHENTICATION_REQUIRED",
        scope: "MISSING_SCOPES",
        character: "CHARACTER_MISMATCH",
        context: "VALIDATION_ERROR",
      }[denial];
      const authorization =
        denial === "context"
          ? { authorizationContext: "esi" as const }
          : undefined;
      await expect(client.call(input, authorization)).rejects.toMatchObject({
        code,
      });
      pending.resolve(response());
      await first;
      await expect(client.call(input, authorization)).rejects.toMatchObject({
        code,
      });
      expect(network).toHaveBeenCalledTimes(1);
    },
  );

  it("never authenticates public cache hits, joins, or continuations", async () => {
    const pending = deferred<Response>();
    const tokens = {
      getAccessToken: vi.fn(() => {
        throw new Error("Must not authenticate");
      }),
    };
    const network = vi.fn<typeof fetch>(() => pending.promise);
    const client = new EsiClient(catalog(), tokens, {
      fetchImplementation: network,
    });
    const input = { ...marketInput, actingCharacterId: 42 };
    const calls = [client.call(input), client.call(input)];
    await vi.waitFor(() => {
      expect(state(client).inFlight.values().next().value?.waiters.size).toBe(
        2,
      );
    });
    pending.resolve(response("[]"));
    const [first] = await Promise.all(calls);
    expect(first?.pagination.nextCall?.actingCharacterId).toBeUndefined();
    expect((await client.call(input)).cached).toBe(true);
    expect(tokens.getAccessToken).not.toHaveBeenCalled();
    expect(
      new Headers(network.mock.calls[0]?.[1]?.headers).has("authorization"),
    ).toBe(false);
  });

  it("never coalesces or caches safe POST calls", async () => {
    const pending = deferred<undefined>();
    const network = vi.fn<typeof fetch>(async () => {
      await pending.promise;
      return response();
    });
    const client = new EsiClient(
      catalog(),
      new StaticTokenProvider(undefined),
      { fetchImplementation: network },
    );
    const input = { operationId: "PostUniverseNames", body: [34] };
    const calls = [client.call(input), client.call(input)];
    await vi.waitFor(() => {
      expect(network).toHaveBeenCalledTimes(2);
    });
    pending.resolve(undefined);
    await Promise.all(calls);
    expect((await client.call(input)).cached).toBe(false);
    expect(network).toHaveBeenCalledTimes(3);
    expect(state(client).inFlight.size).toBe(0);
  });

  it.each([0, 1])(
    "cancels waiter %s without cancelling the other caller",
    async (index) => {
      const pending = deferred<Response>();
      const network = vi.fn<typeof fetch>(() => pending.promise);
      const client = new EsiClient(
        catalog(),
        new StaticTokenProvider(token()),
        { fetchImplementation: network },
      );
      const controllers = [new AbortController(), new AbortController()];
      const calls = controllers.map((controller) =>
        client.call(protectedInput, undefined, controller.signal),
      );
      await vi.waitFor(() => {
        expect(state(client).inFlight.values().next().value?.waiters.size).toBe(
          2,
        );
      });
      const rejected = expect(calls[index]).rejects.toMatchObject({
        name: "AbortError",
      });
      controllers[index]?.abort(new Error("private cancellation reason"));
      await rejected;
      expect(network.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      expect(state(client).inFlight.values().next().value?.waiters.size).toBe(
        1,
      );
      pending.resolve(response());
      expect((await calls[1 - index])?.data).toEqual([{ value: 1 }]);
      expect(network).toHaveBeenCalledTimes(1);
      expect(state(client).inFlight.size).toBe(0);
    },
  );

  it("all-waiter abort cancels a stalled body and frees the key for a new call", async () => {
    const cancel = vi.fn();
    const network = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
      .mockImplementation(() => Promise.resolve(response()));
    const client = new EsiClient(
      catalog(),
      new StaticTokenProvider(undefined),
      { fetchImplementation: network, maxInFlightRequests: 1 },
    );
    const controllers = [new AbortController(), new AbortController()];
    const calls = controllers.map((controller) =>
      client.call(publicInput, undefined, controller.signal),
    );
    await vi.waitFor(() => {
      expect(state(client).inFlight.values().next().value?.waiters.size).toBe(
        2,
      );
    });
    const outcomes = Promise.allSettled(calls);
    controllers.forEach((controller) => {
      controller.abort();
    });
    expect(
      (await outcomes).every((outcome) => outcome.status === "rejected"),
    ).toBe(true);
    expect(network.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(state(client).inFlight.size).toBe(0);
    expect((await client.call(publicInput)).cached).toBe(false);
  });

  it("reclaims an aborted fetch that ignores its signal and cancels its late response", async () => {
    const pending = deferred<Response>();
    const network = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementation(() => Promise.resolve(response()));
    const client = new EsiClient(
      catalog(),
      new StaticTokenProvider(undefined),
      { fetchImplementation: network, maxInFlightRequests: 1 },
    );
    const controller = new AbortController();
    const call = client.call(publicInput, undefined, controller.signal);
    await vi.waitFor(() => {
      expect(network).toHaveBeenCalledOnce();
    });
    const rejection = expect(call).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    const cancel = vi.fn();
    pending.resolve(new Response(new ReadableStream({ cancel })));
    await client.call(publicInput);
    expect(cancel).toHaveBeenCalledOnce();
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each(["fetch", "body"])(
    "enforces the shared %s deadline independently of waiter cancellation",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const cancel = vi.fn();
      const network = vi.fn<typeof fetch>(() =>
        phase === "fetch"
          ? new Promise<Response>(() => undefined)
          : Promise.resolve(new Response(new ReadableStream({ cancel }))),
      );
      const client = new EsiClient(
        catalog(),
        new StaticTokenProvider(undefined),
        { fetchImplementation: network, requestTimeoutMs: 100 },
      );
      const controller = new AbortController();
      const first = client.call(publicInput, undefined, controller.signal);
      const firstResult = first.catch((error: unknown) => error);
      await vi.waitFor(
        () => {
          expect(network).toHaveBeenCalledOnce();
        },
        {
          interval: 1,
        },
      );
      await vi.advanceTimersByTimeAsync(40);
      const second = client.call(publicInput);
      const secondResult = second.catch((error: unknown) =>
        publicEsiError(error),
      );
      await vi.waitFor(
        () => {
          expect(
            state(client).inFlight.values().next().value?.waiters.size,
          ).toBe(2);
        },
        { interval: 1 },
      );
      controller.abort();
      expect(await firstResult).toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(60);
      expect(await secondResult).toMatchObject({
        code: "NETWORK_ERROR",
        error: "ESI request deadline exceeded",
        retryable: true,
      });
      expect(network.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      if (phase === "body") expect(cancel).toHaveBeenCalledOnce();
      expect(state(client).inFlight.size).toBe(0);
      expect(state(client).activeRequests).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds active request keys and waiters, and allows retry after completion", async () => {
    const pending = deferred<undefined>();
    const network = vi.fn<typeof fetch>(async () => {
      await pending.promise;
      return response();
    });
    const client = new EsiClient(
      catalog(),
      new StaticTokenProvider(undefined),
      {
        fetchImplementation: network,
        maxInFlightRequests: 1,
        maxWaitersPerRequest: 1,
      },
    );
    const first = client.call(publicInput);
    await vi.waitFor(() => {
      expect(network).toHaveBeenCalledOnce();
    });
    await expect(client.call(publicInput)).rejects.toMatchObject({
      code: "RESPONSE_LIMIT",
    });
    await expect(client.call(marketInput)).rejects.toMatchObject({
      code: "RESPONSE_LIMIT",
    });
    expect(state(client).inFlight.size).toBe(1);
    pending.resolve(undefined);
    await first;
    await client.call(marketInput);
    expect(network).toHaveBeenCalledTimes(2);
    expect(state(client).inFlight.size).toBe(0);
  });

  it.each(["explicit", "ambient", "host"] as const)(
    "honors %s cancellation before auth and on cache hits",
    async (source) => {
      const controller = new AbortController();
      const tokens = { getAccessToken: vi.fn(() => Promise.resolve(token())) };
      const network = vi.fn<typeof fetch>(() => Promise.resolve(response()));
      const client = new EsiClient(catalog(), tokens, {
        fetchImplementation: network,
        ...(source === "host"
          ? { getRequestSignal: () => controller.signal }
          : {}),
      });
      const call = () =>
        source === "ambient"
          ? context.with(
              operationContext(context.active(), new Set(), controller.signal),
              () => client.call(protectedInput),
            )
          : client.call(
              protectedInput,
              undefined,
              source === "explicit" ? controller.signal : undefined,
            );
      await call();
      controller.abort();
      await expect(call()).rejects.toMatchObject({ name: "AbortError" });
      expect(tokens.getAccessToken).toHaveBeenCalledOnce();
      expect(network).toHaveBeenCalledOnce();
    },
  );

  it("does not let an explicit signal override ambient cancellation during auth", async () => {
    const pending = deferred<string>();
    const tokens = { getAccessToken: vi.fn(() => pending.promise) };
    const network = vi.fn<typeof fetch>();
    const client = new EsiClient(catalog(), tokens, {
      fetchImplementation: network,
    });
    const ambient = new AbortController();
    const call = context.with(
      operationContext(context.active(), new Set(), ambient.signal),
      () =>
        client.call(protectedInput, undefined, new AbortController().signal),
    );
    const rejection = expect(call).rejects.toMatchObject({
      name: "AbortError",
    });
    ambient.abort();
    await rejection;
    pending.resolve(token());
    await Promise.resolve();
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    ["call", "resolve"],
    ["call", "reject"],
    ["authorize", "resolve"],
    ["authorize", "reject"],
  ] as const)(
    "drains request-owned %s activities before a nested refresh can %s late",
    async (api, lateOutcome) => {
      const exporter = new InMemorySpanExporter();
      const traces = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const activities = new Set<Promise<void>>();
      const completions: Promise<void>[] = [];
      const completed = vi.fn();
      const held = deferred<string>();
      const entered = deferred<undefined>();
      const controller = new AbortController();
      const marker = createContextKey("test.credential-context");
      const network = vi.fn<typeof fetch>();
      const client = new EsiClient(
        catalog(),
        {
          getAccessToken: () =>
            withSpan("eve.auth.refresh", {}, async () => {
              expect(context.active().getValue(marker)).toBe(
                "private-context-canary",
              );
              entered.resolve(undefined);
              return held.promise;
            }),
        },
        { fetchImplementation: network },
      );
      try {
        const call = withTelemetry(
          {
            tracer: traces.getTracer("test"),
            trackCompletion: (completion) => {
              completions.push(completion);
              void completion.then(() => {
                completed();
              });
            },
          },
          () =>
            context.with(
              operationContext(
                context.active().setValue(marker, "private-context-canary"),
                activities,
                controller.signal,
              ),
              () =>
                api === "call"
                  ? client.call(protectedInput)
                  : client.authorize(["esi-assets.read_assets.v1"], 42),
            ),
        );
        const rejection = expect(call).rejects.toMatchObject({
          name: "AbortError",
        });
        await entered.promise;
        controller.abort();
        await rejection;
        await vi.waitFor(() => {
          expect(activities.size).toBe(0);
        });
        await Promise.all(completions);
        expect(completions).toHaveLength(api === "call" ? 2 : 1);
        expect(completed).toHaveBeenCalledTimes(completions.length);
        expect(network).not.toHaveBeenCalled();
        const authorization = exporter
          .getFinishedSpans()
          .find(
            (span) =>
              span.name ===
              (api === "call"
                ? "eve.esi.authorize"
                : "eve.esi-client.authorize"),
          );
        expect(authorization?.attributes).toMatchObject({
          "eve.auth.required": true,
          "eve.error.code": "CANCELLED",
          "eve.outcome": "error",
        });
        expect(authorization?.status.code).toBe(SpanStatusCode.ERROR);
        expect(
          exporter
            .getFinishedSpans()
            .some((span) => span.name === "eve.auth.refresh"),
        ).toBe(false);
        if (lateOutcome === "reject")
          held.reject(new Error("private-provider-canary"));
        else held.resolve(token());
        await vi.waitFor(() => {
          expect(
            exporter
              .getFinishedSpans()
              .some((span) => span.name === "eve.auth.refresh"),
          ).toBe(true);
        });
        const refresh = exporter
          .getFinishedSpans()
          .find((span) => span.name === "eve.auth.refresh");
        expect(refresh?.parentSpanContext?.spanId).toBe(
          authorization?.spanContext().spanId,
        );
        expect(refresh?.spanContext().traceId).toBe(
          authorization?.spanContext().traceId,
        );
        expect(refresh?.attributes["eve.outcome"]).toBe(
          lateOutcome === "reject" ? "error" : "success",
        );
        expect(completed).toHaveBeenCalledTimes(completions.length);
        expect(completions).toHaveLength(api === "call" ? 2 : 1);
        expect(activities.size).toBe(0);
        expect(network).not.toHaveBeenCalled();
        const evidence = JSON.stringify(
          exporter.getFinishedSpans().map(({ attributes, events, status }) => ({
            attributes,
            events,
            status,
          })),
        );
        expect(evidence).not.toContain("private-context-canary");
        expect(evidence).not.toContain("private-provider-canary");
        expect(evidence).not.toContain(token());
      } finally {
        held.resolve(token());
        await traces.shutdown();
      }
    },
  );

  it("lets cancelled authorization finish refresh-token persistence without retaining request completions", async () => {
    const fetching = deferred<Response>();
    const persisting = deferred<undefined>();
    const activities = new Set<Promise<void>>();
    const completions: Promise<void>[] = [];
    const traces = new BasicTracerProvider();
    const controller = new AbortController();
    const refreshFetch = vi.fn<typeof fetch>(() => fetching.promise);
    const persist = vi.fn(() =>
      withSpan("eve.auth.persist", {}, () => persisting.promise),
    );
    const tokens = new RefreshTokenProvider(
      "synthetic-client",
      "synthetic-old-refresh",
      undefined,
      refreshFetch,
      persist,
    );
    const network = vi.fn<typeof fetch>();
    const client = new EsiClient(catalog(), tokens, {
      fetchImplementation: network,
    });
    try {
      const call = withTelemetry(
        {
          tracer: traces.getTracer("test"),
          trackCompletion: (completion) => {
            completions.push(completion);
          },
        },
        () =>
          context.with(
            operationContext(context.active(), activities, controller.signal),
            () => client.call(protectedInput),
          ),
      );
      const rejection = expect(call).rejects.toMatchObject({
        name: "AbortError",
      });
      await vi.waitFor(() => {
        expect(refreshFetch).toHaveBeenCalledOnce();
      });
      controller.abort();
      await rejection;
      await vi.waitFor(() => {
        expect(activities.size).toBe(0);
      });
      await Promise.all(completions);
      expect(completions).toHaveLength(2);
      fetching.resolve(
        Response.json({
          access_token: token(),
          expires_in: 3600,
          refresh_token: "synthetic-rotated-refresh",
        }),
      );
      await vi.waitFor(() => {
        expect(persist).toHaveBeenCalledWith("synthetic-rotated-refresh");
      });
      expect(refreshFetch.mock.calls[0]?.[1]?.signal).toBeUndefined();
      expect(completions).toHaveLength(2);
      const refreshed = tokens.getAccessToken();
      let ready = false;
      void refreshed.then(() => {
        ready = true;
      });
      await Promise.resolve();
      expect(ready).toBe(false);
      persisting.resolve(undefined);
      expect(await refreshed).toBe(token());
      expect(await tokens.getAccessToken()).toBe(token());
      expect(refreshFetch).toHaveBeenCalledOnce();
      expect(network).not.toHaveBeenCalled();
      expect(completions).toHaveLength(2);
      expect(activities.size).toBe(0);
    } finally {
      fetching.resolve(
        Response.json({ access_token: token(), expires_in: 3600 }),
      );
      persisting.resolve(undefined);
      await traces.shutdown();
    }
  });

  it("honors cancellation during reauthorization rather than serving cached data", async () => {
    const controller = new AbortController();
    const tokens = { getAccessToken: vi.fn(() => Promise.resolve(token())) };
    const network = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const client = new EsiClient(catalog(), tokens, {
      fetchImplementation: network,
    });
    await client.call(protectedInput);
    tokens.getAccessToken.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(token());
    });
    await expect(
      client.call(protectedInput, undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(network).toHaveBeenCalledOnce();
  });

  it("does not wait for a non-cooperative stream cancellation after reaching the byte limit", async () => {
    const cancel = vi.fn(() => new Promise<undefined>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([49, 50]));
        controller.enqueue(new Uint8Array([51, 52]));
      },
      cancel,
    });
    const client = new EsiClient(
      catalog(),
      new StaticTokenProvider(undefined),
      {
        fetchImplementation: vi.fn<typeof fetch>(() =>
          Promise.resolve(new Response(stream)),
        ),
        maxResponseBytes: 3,
      },
    );
    await expect(client.call(publicInput)).rejects.toMatchObject({
      code: "RESPONSE_LIMIT",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(state(client).inFlight.size).toBe(0);
  });

  it("retains malformed JSON fallback, selected rate-limit headers, and exact wire byte counts", async () => {
    const client = new EsiClient(
      catalog(),
      new StaticTokenProvider(undefined),
      {
        fetchImplementation: vi.fn<typeof fetch>(() =>
          Promise.resolve(
            new Response("{invalid", {
              headers: {
                "x-ratelimit-remaining": "12",
                "x-esi-error-limit-remain": "34",
                "cache-control": "max-age=60",
              },
            }),
          ),
        ),
      },
    );
    const first = await client.call(publicInput);
    const cached = await client.call(publicInput);
    for (const result of [first, cached]) {
      expect(result.data).toBe("{invalid");
      expect(result.headers).toMatchObject({
        "x-ratelimit-remaining": "12",
        "x-esi-error-limit-remain": "34",
      });
      expect(client.responseByteLength(result)).toBe(8);
    }
  });

  it.each(["length", "stream", "utf8"])(
    "keeps %s response bounds for every joined caller and clears failed flights",
    async (kind) => {
      const pending = deferred<Response>();
      const network = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(() => pending.promise)
        .mockImplementation(() => Promise.resolve(response("{}")));
      const client = new EsiClient(
        catalog(),
        new StaticTokenProvider(undefined),
        { fetchImplementation: network, maxResponseBytes: 3 },
      );
      const calls = [client.call(publicInput), client.call(publicInput)];
      const outcomes = Promise.all(
        calls.map((call) => call.catch((error: unknown) => error)),
      );
      await vi.waitFor(() => {
        expect(state(client).inFlight.values().next().value?.waiters.size).toBe(
          2,
        );
      });
      pending.resolve(
        new Response(kind === "utf8" ? "\u20ac\u20ac" : "1234", {
          headers: kind === "length" ? { "content-length": "4" } : {},
        }),
      );
      const [a, b] = await outcomes;
      expect(a).toMatchObject({ code: "RESPONSE_LIMIT", retryable: false });
      expect(b).toMatchObject({ code: "RESPONSE_LIMIT", retryable: false });
      expect(a).not.toBe(b);
      expect(state(client).cache.size).toBe(0);
      expect((await client.call(publicInput)).data).toEqual({});
      expect(network).toHaveBeenCalledTimes(2);
    },
  );

  it.each([403, 429, 503])(
    "keeps request-specific, isolated HTTP %s errors and retry metadata",
    async (status) => {
      const pending = deferred<Response>();
      const network = vi.fn<typeof fetch>(() => pending.promise);
      const client = new EsiClient(
        catalog(),
        new StaticTokenProvider(token()),
        { fetchImplementation: network },
      );
      const calls = [
        client.call(protectedInput),
        client.call({ ...protectedInput, actingCharacterId: 42 }),
      ];
      const outcomes = Promise.all(
        calls.map((call) =>
          call.then(
            () => {
              throw new Error("Expected an HTTP failure");
            },
            (error: unknown) => publicEsiError(error),
          ),
        ),
      );
      await vi.waitFor(() => {
        expect(state(client).inFlight.values().next().value?.waiters.size).toBe(
          2,
        );
      });
      pending.resolve(
        new Response('{"error":"private-canary"}', {
          status,
          headers: { "retry-after": "7", "x-esi-error-limit-remain": "0" },
        }),
      );
      const [a, b] = await outcomes;
      expect(a).toMatchObject({ status, retryAfterSeconds: 7 });
      expect(b).toMatchObject({ status, retryAfterSeconds: 7 });
      expect(b?.error).toContain("for character 42");
      expect(a?.error).not.toContain("for character 42");
      expect(a?.details).not.toBe(b?.details);
      if (status === 403) {
        const firstScopes = (a?.details as { requiredScopes: string[] })
          .requiredScopes;
        firstScopes.push("changed");
        expect(b?.details).toMatchObject({
          requiredScopes: ["esi-assets.read_assets.v1"],
        });
      }
      if (status === 403)
        expect(JSON.stringify([a, b])).not.toContain("private-canary");
      expect(state(client).cache.size).toBe(0);
    },
  );

  it.each([false, true])(
    "observes each coalesced caller in its own capture without private leakage (protected: %s)",
    async (privateCall) => {
      const pending = deferred<Response>();
      const network = vi.fn<typeof fetch>(() => pending.promise);
      const client = new EsiClient(
        catalog(),
        new StaticTokenProvider(token()),
        { fetchImplementation: network },
      );
      const captures = [0, 1].map(
        () =>
          new DiagnosticCapture(
            { versions: {}, save: () => undefined },
            { method: "tools/call", tool: "call_esi", arguments: {} },
            true,
          ),
      );
      const calls = captures.map((capture, index) =>
        context.with(captureContext(capture), () =>
          client.call(
            privateCall
              ? {
                  ...protectedInput,
                  ...(index ? { actingCharacterId: 42 } : {}),
                }
              : {
                  ...marketInput,
                  ...(index ? { query: { order_type: "all" } } : {}),
                },
          ),
        ),
      );
      await vi.waitFor(() => {
        expect(state(client).inFlight.values().next().value?.waiters.size).toBe(
          2,
        );
      });
      pending.resolve(
        response(privateCall ? '{"value":"private-canary"}' : "[]"),
      );
      await Promise.all(calls);
      for (const capture of captures) {
        expect(capture.dependencies).toHaveLength(1);
        expect(capture.dependencies[0]).toMatchObject({
          ordinal: 1,
          cached: false,
          status: 200,
        });
        expect(capture.dependencies[0]?.body).toBe(
          privateCall ? undefined : "[]",
        );
      }
      expect(captures[0]?.dependencies[0]).not.toBe(
        captures[1]?.dependencies[0],
      );
      expect(
        JSON.stringify(captures.map((capture) => capture.dependencies)),
      ).not.toContain("private-canary");
      expect(
        JSON.stringify(captures.map((capture) => capture.dependencies)),
      ).not.toContain(token());
      expect(network).toHaveBeenCalledOnce();
    },
  );
});
