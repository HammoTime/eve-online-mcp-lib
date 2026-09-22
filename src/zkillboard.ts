import * as z from "zod/v4";
import { EsiRequestError } from "./esi-client.js";
import { cancellationSignal } from "./telemetry.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const zkillmailIdSchema = z.object({ killmailId: id }).strict();
export const zkillmailSearchSchema = z
  .object({
    entityType: z.enum([
      "character",
      "corporation",
      "alliance",
      "faction",
      "shipType",
      "group",
      "solarSystem",
      "constellation",
      "region",
      "location",
      "war",
    ]),
    entityId: id,
    side: z.enum(["all", "kills", "losses"]).default("all"),
    page: z.number().int().min(1).max(100).default(1),
    pastSeconds: z
      .number()
      .int()
      .min(3600)
      .max(604800)
      .multipleOf(3600)
      .optional(),
    solo: z.boolean().default(false),
    space: z
      .enum(["highsec", "lowsec", "nullsec", "w-space", "abyssal"])
      .optional(),
  })
  .strict();

const killmailSchema = z
  .object({
    killmail_id: id,
    killmail_time: z.iso.datetime(),
    solar_system_id: id,
    victim: z.object({ ship_type_id: id }).catchall(z.json()),
    attackers: z.array(z.json()),
    zkb: z
      .object({
        hash: z
          .string()
          .regex(/^[a-f0-9]{40}$/u)
          .optional(),
        totalValue: z.number().nonnegative().optional(),
      })
      .catchall(z.json()),
  })
  .catchall(z.json());
type Killmail = z.infer<typeof killmailSchema>;
interface Entry {
  data: Killmail[];
  fetchedAt: number;
  expiresAt: number;
  bytes: number;
}
const MAX_BODY_BYTES = 2_000_000;
const MAX_CACHE_BYTES = 8_000_000;
const CACHE_MS = 3_600_000;
const USER_AGENT =
  "eve-online-mcp (+https://github.com/HammoTime/eve-online-mcp)";
const CAVEATS = [
  "Public zKillboard records are delayed and incomplete; they do not establish live activity, safety, or a complete combat history.",
  "Killmails less than five minutes old are withheld upstream. Responses are cached for one hour.",
  "One upstream page only, at most 200 records. Finish response slices before requesting another page; pages can change independently.",
];

function failure(
  message: string,
  code: "NETWORK_ERROR" | "RESPONSE_LIMIT" | "INVALID_UPSTREAM_RESPONSE",
) {
  return new EsiRequestError(message, undefined, undefined, {
    code,
    retryable: code === "NETWORK_ERROR",
  });
}

/** Race even injected/stalled transports against cancellation without leaking errors. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      reject(
        failure("zKillboard request cancelled or timed out", "NETWORK_ERROR"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function bodyText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body)
    throw failure(
      "zKillboard returned an empty body",
      "INVALID_UPSTREAM_RESPONSE",
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES)
        throw failure(
          "zKillboard response exceeds the byte safety limit",
          "RESPONSE_LIMIT",
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Public-only client: no credentials, caller URLs, retries, or background polling.
 * Cache/rate limits are per instance (per isolate for the shared default).
 */
export class ZKillboardClient {
  private readonly cache = new Map<string, Entry>();
  private cacheBytes = 0;
  private nextRequestAt = 0;
  private pending:
    { url: string; promise: Promise<Entry>; waiters: number } | undefined;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  constructor(
    options: { fetchImplementation?: typeof fetch; now?: () => number } = {},
  ) {
    this.fetch =
      options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  async search(
    input: z.input<typeof zkillmailSearchSchema>,
    signal = cancellationSignal(),
  ) {
    const parsed = zkillmailSearchSchema.safeParse(input);
    if (!parsed.success)
      throw new EsiRequestError(
        "Invalid zKillboard search filters",
        undefined,
        undefined,
        { code: "VALIDATION_ERROR", retryable: false },
      );
    const query = parsed.data;
    const path = [
      `${query.entityType}ID`,
      String(query.entityId),
      ...(query.side === "all" ? [] : [query.side]),
      ...(query.solo ? ["solo"] : []),
      ...(query.space ? [query.space] : []),
      ...(query.pastSeconds ? ["pastSeconds", String(query.pastSeconds)] : []),
      "page",
      String(query.page),
    ];
    return this.request(path, query.page, signal);
  }

  async get(
    input: z.input<typeof zkillmailIdSchema>,
    signal = cancellationSignal(),
  ) {
    const parsed = zkillmailIdSchema.safeParse(input);
    if (!parsed.success)
      throw new EsiRequestError("Invalid killmail ID", undefined, undefined, {
        code: "VALIDATION_ERROR",
        retryable: false,
      });
    const result = await this.request(
      ["killID", String(parsed.data.killmailId)],
      null,
      signal,
    );
    if (result.data.length === 0)
      throw new EsiRequestError(
        "Killmail is not available in the public zKillboard records",
        404,
      );
    if (
      result.data.length !== 1 ||
      result.data[0]?.killmail_id !== parsed.data.killmailId
    )
      throw failure(
        "zKillboard returned a different killmail",
        "INVALID_UPSTREAM_RESPONSE",
      );
    return { ...result, data: result.data[0] };
  }

  private async request(
    path: string[],
    page: number | null,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted)
      throw failure("zKillboard request cancelled", "NETWORK_ERROR");
    const url = `https://zkillboard.com/api/${path.join("/")}/`;
    let entry = this.cache.get(url);
    const cached = entry !== undefined && entry.expiresAt > this.now();
    if (!cached) {
      if (entry) {
        this.cache.delete(url);
        this.cacheBytes -= entry.bytes;
      }
      if (
        this.pending &&
        (this.pending.url !== url || this.pending.waiters >= 64)
      )
        this.throttled(1);
      if (!this.pending) {
        if (this.now() < this.nextRequestAt)
          this.throttled(Math.ceil((this.nextRequestAt - this.now()) / 1000));
        this.nextRequestAt = this.now() + 1000;
        const promise = this.download(url).finally(() => {
          this.pending = undefined;
        });
        this.pending = { url, promise, waiters: 0 };
      }
      const pending = this.pending;
      pending.waiters++;
      try {
        entry = signal
          ? await abortable(pending.promise, signal)
          : await pending.promise;
      } finally {
        pending.waiters--;
      }
    }
    if (!entry)
      throw failure(
        "zKillboard response unavailable",
        "INVALID_UPSTREAM_RESPONSE",
      );
    return {
      source: "zKillboard" as const,
      url,
      cached,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      complete: false as const,
      pagination: {
        page,
        hasMore: page !== null && entry.data.length === 200 ? null : false,
        nextPage:
          page !== null && page < 100 && entry.data.length === 200
            ? page + 1
            : null,
      },
      caveats: [...CAVEATS],
      data: structuredClone(entry.data),
    };
  }

  private throttled(seconds: number): never {
    throw new EsiRequestError(
      "zKillboard requests are rate limited; retry after the stated delay",
      429,
      undefined,
      {
        code: "THROTTLED",
        retryable: true,
        retryAfterSeconds: seconds,
      },
    );
  }

  private async download(url: string): Promise<Entry> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 30_000);
    try {
      const response = await abortable(
        this.fetch(url, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "User-Agent": USER_AGENT,
          },
        }),
        controller.signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 420 || response.status === 429) {
          const raw = response.headers.get("retry-after");
          const delay =
            raw && /^\d+$/u.test(raw)
              ? Number(raw)
              : raw
                ? (Date.parse(raw) - this.now()) / 1000
                : 60;
          const seconds = Number.isFinite(delay)
            ? Math.max(1, Math.ceil(delay))
            : 60;
          this.nextRequestAt = this.now() + seconds * 1000;
          this.throttled(seconds);
        }
        throw new EsiRequestError(
          "zKillboard upstream request failed",
          response.status,
          undefined,
          {
            code: "UPSTREAM_ERROR",
            retryable: response.status >= 500,
          },
        );
      }
      const text = await bodyText(response, controller.signal);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw failure(
          "zKillboard returned invalid JSON",
          "INVALID_UPSTREAM_RESPONSE",
        );
      }
      const parsed = z.array(killmailSchema).max(200).safeParse(json);
      if (
        !parsed.success ||
        new Set(parsed.data.map((row) => row.killmail_id)).size !==
          parsed.data.length
      )
        throw failure(
          "zKillboard returned an invalid killmail page",
          "INVALID_UPSTREAM_RESPONSE",
        );
      const fetchedAt = this.now();
      const entry = {
        data: parsed.data,
        fetchedAt,
        expiresAt: fetchedAt + CACHE_MS,
        bytes: new TextEncoder().encode(text).byteLength,
      };
      while (
        this.cache.size >= 16 ||
        this.cacheBytes + entry.bytes > MAX_CACHE_BYTES
      ) {
        const oldest = this.cache.entries().next().value;
        if (!oldest) break;
        this.cache.delete(oldest[0]);
        this.cacheBytes -= oldest[1].bytes;
      }
      this.cache.set(url, entry);
      this.cacheBytes += entry.bytes;
      return entry;
    } catch (error) {
      if (error instanceof EsiRequestError) throw error;
      throw failure("zKillboard request failed", "NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }
}

let sharedClient: ZKillboardClient | undefined;
export function defaultZKillboardClient(): ZKillboardClient {
  return (sharedClient ??= new ZKillboardClient());
}
