import {
  attributes,
  cancellationSignal,
  diagnostic,
  withoutRequestTracking,
  withSpan,
  withSpanSync,
} from "./telemetry.js";
import { SpanKind } from "@opentelemetry/api";
import {
  activeCapture,
  dependencyInput,
  safeMarketBody,
  safeResponseHeaders,
} from "./diagnostics.js";
import {
  AuthenticationError,
  missingTokenScopes,
  type TokenProvider,
} from "./auth.js";
import { characterIdFromToken } from "./token-identity.js";
import { OperationCatalog, UnknownOperationError } from "./openapi.js";
const DEFAULT_ESI_USER_AGENT =
  "eve-online-mcp-lib (+https://github.com/HammoTime/eve-online-mcp-lib)";
import type {
  JsonValue,
  OperationDescriptor,
  ParameterObject,
  SchemaObject,
} from "./types.js";

export interface EsiCallInput {
  operationId: string;
  /** Execution identity only; never serialized as an ESI parameter. */
  actingCharacterId?: number;
  path?: Record<string, JsonValue>;
  query?: Record<string, JsonValue>;
  headers?: Record<string, JsonValue>;
  body?: JsonValue;
}

export interface EsiResponse {
  operationId: string;
  status: number;
  url: string;
  cached: boolean;
  headers: Record<string, string>;
  data: JsonValue | string | null;
  freshness: {
    fetchedAt: string;
    servedAt: string;
    expiresAt: string | null;
    sourceLastModified: string | null;
  };
  pagination: {
    mode: "page" | "none";
    currentPage: number | null;
    totalPages: number | null;
    hasMore: boolean | null;
    nextCall: EsiCallInput | null;
  };
}

export type EsiErrorCode =
  | "UNKNOWN_OPERATION"
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_FAILED"
  | "MISSING_SCOPES"
  | "CHARACTER_MISMATCH"
  | "CHARACTER_SELECTION_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "THROTTLED"
  | "NETWORK_ERROR"
  | "UPSTREAM_ERROR"
  | "RESPONSE_LIMIT"
  | "INVALID_UPSTREAM_RESPONSE";

export class EsiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: JsonValue | string,
    readonly metadata: {
      code?: EsiErrorCode;
      retryable?: boolean;
      retryAfterSeconds?: number | null;
      suggestedAction?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "EsiRequestError";
  }

  get code(): EsiErrorCode {
    return this.metadata.code ?? codeForStatus(this.status);
  }

  get retryable(): boolean {
    return this.metadata.retryable ?? retryableForCode(this.code);
  }

  get retryAfterSeconds(): number | null {
    return this.metadata.retryAfterSeconds ?? null;
  }

  get suggestedAction(): string | null {
    if (this.metadata.suggestedAction !== undefined)
      return this.metadata.suggestedAction;
    return suggestedActionForCode(this.code);
  }
}

export interface EsiAuthorization {
  readonly authorizationContext: "esi";
}

interface CacheEntry {
  expiresAt: number;
  response: Omit<EsiResponse, "pagination">;
  byteLength: number;
  cacheBytes: number;
}

interface WireResponse {
  response: Response;
  raw: string;
  byteLength: number;
  fetchedAt: number;
}

interface InFlightRequest {
  controller: AbortController;
  waiters: Set<{
    resolve: (response: WireResponse) => void;
    reject: (error: unknown) => void;
  }>;
  settled: boolean;
}

const DEFAULT_LIMITS = {
  maxResponseBytes: 5_000_000,
  maxCacheEntries: 128,
  maxCacheBytes: 20_000_000,
  maxInFlightRequests: 64,
  maxWaitersPerRequest: 64,
  requestTimeoutMs: 30_000,
};

function cancelled(): DOMException {
  return new DOMException("Operation cancelled", "AbortError");
}

// Stop waiting even when a host token provider or fetch implementation ignores abort.
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(cancelled());
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(
          error instanceof Error ? error : new Error("ESI operation failed"),
        );
      },
    );
  });
}

const RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "retry-after",
  "x-esi-error-limit-remain",
  "x-esi-error-limit-reset",
  "x-pages",
  "x-ratelimit-group",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-used",
];

async function readBoundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0,
    text = "";
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) {
      cancel();
      throw cancelled();
    }
    for (;;) {
      const chunk = await waitFor(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        cancel();
        throw new EsiRequestError(
          "ESI response exceeds the byte safety limit",
          response.status,
          undefined,
          { code: "RESPONSE_LIMIT", retryable: false },
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    attributes({ "eve.output.bytes": bytes });
    return text + decoder.decode();
  } catch (cause) {
    if (signal.aborted) throw cancelled();
    if (cause instanceof EsiRequestError) throw cause;
    throw new EsiRequestError(
      "ESI response body could not be read",
      response.status,
      undefined,
      { code: "NETWORK_ERROR", retryable: true },
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function codeForStatus(status: number | undefined): EsiErrorCode {
  if (status === 401) return "AUTHENTICATION_REQUIRED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 420 || status === 429) return "THROTTLED";
  if (status !== undefined && status >= 500) return "UPSTREAM_ERROR";
  return "VALIDATION_ERROR";
}

function retryableForCode(code: EsiErrorCode): boolean {
  return ["THROTTLED", "NETWORK_ERROR", "UPSTREAM_ERROR"].includes(code);
}

function suggestedActionForCode(code: EsiErrorCode): string | null {
  switch (code) {
    case "AUTHENTICATION_REQUIRED":
    case "AUTHENTICATION_FAILED":
      return "Use authorize_eve_character for the requested character, complete browser consent, then retry the protected operation.";
    case "CHARACTER_MISMATCH":
      return "Use authorize_eve_character and select the requested character in EVE SSO, then retry.";
    case "CHARACTER_SELECTION_REQUIRED":
      return "Use list_eve_characters, then select_eve_character for the intended character.";
    case "MISSING_SCOPES":
      return "Use authorize_eve_character to grant the required read-only scopes listed in details.";
    case "THROTTLED":
      return "Wait for retryAfterSeconds when provided before trying again.";
    case "NETWORK_ERROR":
    case "UPSTREAM_ERROR":
      return "Retry later if the request is still needed.";
    case "RESPONSE_LIMIT":
      return "Request a smaller page or use a more selective operation.";
    case "UNKNOWN_OPERATION":
      return "Use search_esi_operations, then inspect the selected operation.";
    case "VALIDATION_ERROR":
      return "Inspect the operation contract and correct the supplied inputs.";
    case "NOT_FOUND":
      return "Verify the identifiers and access context before making another request.";
    case "FORBIDDEN":
      return "Verify ownership, roles, and endpoint access; authorization alone may not resolve this response.";
    case "INVALID_UPSTREAM_RESPONSE":
      return "The upstream response could not be safely interpreted; try again later.";
  }
}

export function publicEsiError(error: unknown): Record<string, unknown> {
  if (error instanceof UnknownOperationError) {
    return {
      error: error.message,
      status: null,
      details: null,
      code: "UNKNOWN_OPERATION",
      retryable: false,
      retryAfterSeconds: null,
      suggestedAction: suggestedActionForCode("UNKNOWN_OPERATION"),
    };
  }
  if (error instanceof EsiRequestError) {
    return {
      error: error.message,
      status: error.status ?? null,
      details: error.details ?? null,
      code: error.code,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
      suggestedAction: error.suggestedAction,
    };
  }
  return {
    error: error instanceof Error ? error.message : String(error),
    status: null,
    details: null,
    code: "UPSTREAM_ERROR",
    retryable: false,
    retryAfterSeconds: null,
    suggestedAction: null,
  };
}

function validationError(message: string): EsiRequestError {
  return new EsiRequestError(message, undefined, undefined, {
    code: "VALIDATION_ERROR",
    retryable: false,
  });
}

function valueTypeMatches(value: JsonValue, schema: SchemaObject): boolean {
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (types.length === 0) return true;
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object")
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    if (type === "integer")
      return typeof value === "number" && Number.isInteger(value);
    return typeof value === type;
  });
}

function validateValue(
  name: string,
  value: JsonValue,
  schema: SchemaObject,
): void {
  if (!valueTypeMatches(value, schema))
    throw validationError(
      `Parameter ${name} does not match type ${String(schema.type)}`,
    );
  if (
    schema.enum &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    throw validationError(
      `Parameter ${name} must be one of: ${schema.enum.map(String).join(", ")}`,
    );
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      throw validationError(`Parameter ${name} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      throw validationError(`Parameter ${name} must be <= ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      throw validationError(`Parameter ${name} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      throw validationError(`Parameter ${name} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      throw validationError(`Parameter ${name} has an invalid format`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      throw validationError(
        `${name} requires at least ${schema.minItems} items`,
      );
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      throw validationError(`${name} allows at most ${schema.maxItems} items`);
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      throw validationError(`${name} items must be unique`);
    if (schema.items) {
      const itemSchema = schema.items as SchemaObject;
      value.forEach((item, index) => {
        validateValue(`${name}[${index}]`, item, itemSchema);
      });
    }
  }
}

function scalar(value: JsonValue): string {
  return typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value);
}

function valuesForQuery(
  value: JsonValue,
  parameter: ParameterObject,
): string[] {
  if (!Array.isArray(value)) return [scalar(value)];
  return parameter.explode === false
    ? [value.map(scalar).join(",")]
    : value.map(scalar);
}

function declaredByLocation(
  operation: OperationDescriptor,
  location: ParameterObject["in"],
): Map<string, ParameterObject> {
  return new Map(
    operation.parameters
      .filter((parameter) => parameter.in === location)
      .map((parameter) => [parameter.name.toLowerCase(), parameter]),
  );
}

function selectedHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    RESPONSE_HEADERS.flatMap((name) =>
      headers.has(name) ? [[name, headers.get(name) ?? ""]] : [],
    ),
  );
}

function parseHttpDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cacheExpiry(
  headers: Headers,
  operation: OperationDescriptor,
  fetchedAt: number,
): { expiresAt: number | null; cacheable: boolean } {
  const cacheControl = headers.get("cache-control");
  if (
    cacheControl &&
    /(?:^|,)\s*(?:no-store|no-cache)(?:=|\s|,|$)/iu.test(cacheControl)
  )
    return { expiresAt: fetchedAt, cacheable: false };
  const maxAgeMatch = cacheControl?.match(
    /(?:^|,)\s*max-age\s*=\s*([^,\s]+)/iu,
  );
  if (maxAgeMatch) {
    const seconds = Number(maxAgeMatch[1]);
    const expiresAt = fetchedAt + seconds * 1000;
    if (
      Number.isFinite(seconds) &&
      seconds >= 0 &&
      Number.isFinite(new Date(expiresAt).getTime())
    )
      return {
        expiresAt,
        cacheable: seconds > 0,
      };
    return { expiresAt: null, cacheable: false };
  }
  const expires = headers.get("expires");
  if (expires) {
    const parsed = parseHttpDate(expires);
    return parsed === null
      ? { expiresAt: null, cacheable: false }
      : { expiresAt: parsed, cacheable: parsed > fetchedAt };
  }
  if (operation.cacheSeconds === undefined)
    return { expiresAt: null, cacheable: false };
  const expiresAt = fetchedAt + Math.max(operation.cacheSeconds, 0) * 1000;
  return { expiresAt, cacheable: expiresAt > fetchedAt };
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const date = parseHttpDate(value);
  return date === null ? null : Math.max(Math.ceil((date - now) / 1000), 0);
}

function validPageCount(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 1 ? count : null;
}

export class EsiClient {
  private readonly cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private readonly inFlight = new Map<string, InFlightRequest>();
  private activeRequests = 0;
  private readonly limits: typeof DEFAULT_LIMITS;
  private readonly authorizationTokens = new WeakMap<object, string>();
  private readonly responseSizes = new WeakMap<EsiResponse, number>();
  private readonly baseUrl: string;

  constructor(
    private readonly catalog: OperationCatalog,
    private readonly tokenProvider: TokenProvider,
    private readonly options: {
      fetchImplementation?: typeof fetch;
      userAgent?: string;
      /** UTF-8 response body limit; default 5,000,000 bytes. */
      maxResponseBytes?: number;
      /** LRU cache budgets, including serialized metadata; defaults 128 / 20,000,000 bytes. */
      maxCacheEntries?: number;
      maxCacheBytes?: number;
      /** Active wire requests / callers per shared GET; both default to 64. */
      maxInFlightRequests?: number;
      maxWaitersPerRequest?: number;
      /** Independent wire deadline, including streaming; default 30,000 ms. */
      requestTimeoutMs?: number;
      /** Host request context fallback when OTel context is unavailable. */
      getRequestSignal?: () => AbortSignal | undefined;
      baseUrl?: string;
      clock?: () => Date;
    } = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS };
    for (const name of Object.keys(
      DEFAULT_LIMITS,
    ) as (keyof typeof DEFAULT_LIMITS)[]) {
      const { [name]: value = DEFAULT_LIMITS[name] } = options;
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(
          `Invalid ESI client configuration: ${name} must be a positive safe integer`,
        );
      this.limits[name] = value;
    }
    if (this.limits.requestTimeoutMs > 2_147_483_647)
      throw new RangeError(
        "Invalid ESI client configuration: requestTimeoutMs must not exceed 2147483647",
      );
    this.baseUrl = options.baseUrl ?? "https://esi.evetech.net";
    const parsed = new URL(this.baseUrl);
    if (
      parsed.protocol !== "https:" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost"
    )
      throw new Error(
        "ESI base URL must use HTTPS (except loopback URLs used by tests)",
      );
  }

  async authorize(
    requiredScopes: string[],
    characterId?: number,
    signal?: AbortSignal,
  ): Promise<EsiAuthorization> {
    signal = this.requestSignal(signal);
    if (signal?.aborted) throw cancelled();
    return withSpan(
      "eve.esi-client.authorize",
      {
        "eve.auth.scope_count": requiredScopes.length,
        "eve.auth.character_requested": characterId !== undefined,
      },
      async () => {
        if (
          characterId !== undefined &&
          (!Number.isSafeInteger(characterId) || characterId <= 0)
        )
          throw validationError("characterId must be a positive safe integer");
        const scopes = [...new Set(requiredScopes)].sort();
        attributes({ "eve.auth.required": scopes.length > 0 });
        if (scopes.length === 0) return { authorizationContext: "esi" };
        let token: string | undefined;
        try {
          token = await waitFor(
            withoutRequestTracking(() =>
              this.tokenProvider.getAccessToken(scopes, characterId),
            ),
            signal,
          );
        } catch (error) {
          if (signal?.aborted) throw cancelled();
          throw new EsiRequestError(
            error instanceof Error
              ? error.message
              : "EVE authentication failed",
            error instanceof AuthenticationError ? 403 : 401,
            {
              requiredScopes: scopes,
              ...(characterId === undefined ? {} : { characterId }),
              ...(error instanceof AuthenticationError ? error.details : {}),
            },
            {
              code:
                error instanceof AuthenticationError
                  ? error.code
                  : "AUTHENTICATION_FAILED",
              retryable: false,
            },
          );
        }
        if (signal?.aborted) throw cancelled();
        const checkedToken = this.requireToken(token, scopes, characterId);
        const authorization: EsiAuthorization = { authorizationContext: "esi" };
        this.authorizationTokens.set(authorization, checkedToken);
        return authorization;
      },
    );
  }

  responseByteLength(response: EsiResponse): number {
    return (
      this.responseSizes.get(response) ??
      new TextEncoder().encode(JSON.stringify(response.data)).byteLength
    );
  }

  async call(
    input: EsiCallInput,
    authorization?: EsiAuthorization,
    signal?: AbortSignal,
  ): Promise<EsiResponse> {
    signal = this.requestSignal(signal);
    if (signal?.aborted) throw cancelled();
    input = structuredClone(input);
    return withSpan("eve.esi-client.call", {}, async () => {
      const capture = activeCapture();
      const ordinal = capture?.next() ?? 0;
      const operation = this.catalog.get(input.operationId);
      const projected = dependencyInput(input, operation.operationId);
      if (!projected.complete) capture?.incomplete("dependency_input_redacted");
      if (operation.requiredScopes.length)
        capture?.incomplete("private_dependency");
      attributes({
        ...projected.attributes,
        "eve.esi.operation_id": operation.operationId,
        "eve.esi.path_template": operation.path,
        "eve.auth.required": operation.requiredScopes.length > 0,
        "eve.auth.scope_count": operation.requiredScopes.length,
        "eve.limit.response_bytes": this.limits.maxResponseBytes,
      });
      const url = withSpanSync("eve.esi.validate_url", () =>
        this.buildUrl(operation, input.path ?? {}, input.query ?? {}),
      );
      const headers = withSpanSync("eve.esi.validate_headers", () =>
        this.buildHeaders(operation, input.headers ?? {}),
      );
      let body: string | undefined;
      if (operation.requestBodyRequired && input.body === undefined)
        throw validationError(
          `Operation ${operation.operationId} requires a JSON body`,
        );
      if (input.body !== undefined) {
        if (!operation.requestBodySchema)
          throw validationError(
            `Operation ${operation.operationId} does not accept a JSON body`,
          );
        validateValue("body", input.body, operation.requestBodySchema);
        body = JSON.stringify(input.body);
        headers.set("content-type", "application/json");
      }

      if (
        input.actingCharacterId !== undefined &&
        (!Number.isSafeInteger(input.actingCharacterId) ||
          input.actingCharacterId <= 0)
      )
        throw validationError(
          "actingCharacterId must be a positive safe integer",
        );
      if (
        typeof input.path?.character_id === "number" &&
        input.actingCharacterId !== undefined &&
        input.path.character_id !== input.actingCharacterId
      )
        throw validationError(
          "actingCharacterId must match the character path",
        );
      const characterId =
        typeof input.path?.character_id === "number"
          ? input.path.character_id
          : input.actingCharacterId;
      const token = await withSpan(
        "eve.esi.authorize",
        {
          "eve.auth.required": operation.requiredScopes.length > 0,
          "eve.auth.reused": authorization !== undefined,
        },
        () =>
          waitFor(
            withoutRequestTracking(() =>
              this.tokenFor(operation, authorization, characterId),
            ),
            signal,
          ),
      );
      if (signal?.aborted) throw cancelled();
      if (token) headers.set("authorization", `Bearer ${token}`);
      // Hash the complete wire identity; no credentials or unbounded input keys are retained.
      const cacheKey = Array.from(
        new Uint8Array(
          await waitFor(
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(
                JSON.stringify([
                  operation.operationId,
                  operation.method,
                  url.href,
                  [...headers.entries()],
                  body ?? null,
                ]),
              ),
            ),
            signal,
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (signal?.aborted) throw cancelled();
      const servedAt = this.now();
      this.evictCache(servedAt);
      const cached =
        operation.method === "GET" ? this.cache.get(cacheKey) : undefined;
      diagnostic("eve.cache.lookup", {
        "eve.cache.hit": !!cached && cached.expiresAt > servedAt,
        "eve.cache.partition": token ? "protected" : "public",
        "eve.clock.unix_ms": servedAt,
        ...(cached ? { "eve.cache.expires_at_ms": cached.expiresAt } : {}),
      });
      if (cached && cached.expiresAt > servedAt) {
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        capture?.incomplete("initial_cache_state_required");
        await waitFor(
          Promise.resolve(
            capture?.add({
              ordinal,
              operationId: operation.operationId,
              input: projected.value,
              cached: true,
              startedAt: servedAt,
              fetchedAt: Date.parse(cached.response.freshness.fetchedAt),
            }),
          ),
          signal,
        );
        if (signal?.aborted) throw cancelled();
        const result: EsiResponse = {
          ...structuredClone(cached.response),
          cached: true,
          pagination: this.paginationFor(
            operation,
            input,
            cached.response.headers,
          ),
          freshness: {
            ...cached.response.freshness,
            servedAt: new Date(servedAt).toISOString(),
          },
        };
        this.responseSizes.set(result, cached.byteLength);
        return result;
      }

      return withSpan(
        `HTTP ${operation.method}`,
        {
          "http.request.method": operation.method,
          "eve.esi.operation_id": operation.operationId,
          "server.address": "esi.evetech.net",
          "eve.dependency.attempt": 1,
        },
        async () => {
          let wire: WireResponse;
          try {
            wire = await this.request(
              cacheKey,
              operation,
              url,
              headers,
              body,
              signal,
            );
          } catch (error) {
            if (signal?.aborted) throw cancelled();
            if (error instanceof EsiRequestError && error.status !== undefined)
              attributes({ "http.response.status_code": error.status });
            await waitFor(
              Promise.resolve(
                capture?.add({
                  ordinal,
                  operationId: operation.operationId,
                  input: projected.value,
                  cached: false,
                  startedAt: servedAt,
                  fetchedAt: this.now(),
                  errorCode:
                    error instanceof EsiRequestError
                      ? error.code
                      : "NETWORK_ERROR",
                }),
              ),
              signal,
            );
            throw error;
          }
          if (signal?.aborted) throw cancelled();
          const { response, raw, byteLength, fetchedAt } = wire;
          attributes({
            "http.response.status_code": response.status,
            "eve.limit.response_bytes": this.limits.maxResponseBytes,
          });
          let data: JsonValue | string | null = null;
          if (raw) {
            try {
              data = withSpanSync(
                "eve.esi.decode_json",
                () => JSON.parse(raw) as JsonValue,
                { "eve.input.bytes": byteLength },
              );
            } catch {
              data = raw;
            }
          }

          attributes({
            "http.response.body.size": byteLength,
            "eve.clock.unix_ms": fetchedAt,
          });
          if (capture) {
            const safeHeaders = safeResponseHeaders(
              response.headers,
              operation.requiredScopes.length === 0 &&
                operation.operationId === "GetMarketsRegionIdOrders",
            );
            const bodyAllowed =
              operation.requiredScopes.length === 0 &&
              safeMarketBody(raw, operation.operationId, response.status);
            if (!bodyAllowed) capture.incomplete("dependency_body_redacted");
            if (!safeHeaders.complete)
              capture.incomplete("dependency_headers_redacted");
            await waitFor(
              capture.add({
                ordinal,
                operationId: operation.operationId,
                input: projected.value,
                cached: false,
                startedAt: servedAt,
                fetchedAt,
                status: response.status,
                headers: safeHeaders.values,
                ...(bodyAllowed ? { body: raw } : {}),
                bodyBytes: byteLength,
              }),
              signal,
            );
          }
          if (signal?.aborted) throw cancelled();
          const responseHeaders = selectedHeaders(response.headers);
          const policy = cacheExpiry(response.headers, operation, fetchedAt);
          const modifiedAt = parseHttpDate(
            response.headers.get("last-modified"),
          );
          const result: EsiResponse = {
            operationId: operation.operationId,
            status: response.status,
            url: url.href,
            cached: false,
            headers: responseHeaders,
            data,
            freshness: {
              fetchedAt: new Date(fetchedAt).toISOString(),
              servedAt: new Date(fetchedAt).toISOString(),
              expiresAt:
                policy.expiresAt === null
                  ? null
                  : new Date(policy.expiresAt).toISOString(),
              sourceLastModified:
                modifiedAt === null ? null : new Date(modifiedAt).toISOString(),
            },
            pagination: this.paginationFor(operation, input, responseHeaders),
          };
          diagnostic("eve.esi.response", {
            "http.response.status_code": response.status,
            "eve.cache.cacheable": policy.cacheable,
            "eve.response.bytes": byteLength,
            "eve.pagination.current_page": result.pagination.currentPage ?? 0,
            "eve.pagination.total_pages": result.pagination.totalPages ?? 0,
            "eve.pagination.count_known": result.pagination.totalPages !== null,
            ...(policy.expiresAt === null
              ? {}
              : { "eve.cache.expires_at_ms": policy.expiresAt }),
            ...(response.status >= 400
              ? {
                  "eve.error.code": codeForStatus(response.status),
                  "eve.error.retryable": retryableForCode(
                    codeForStatus(response.status),
                  ),
                  "eve.retry.after_seconds":
                    parseRetryAfter(
                      response.headers.get("retry-after"),
                      fetchedAt,
                    ) ?? 0,
                }
              : {}),
          });
          this.responseSizes.set(result, byteLength);
          if (!response.ok && response.status !== 304) {
            const code = codeForStatus(response.status);
            throw new EsiRequestError(
              `ESI ${operation.operationId}${characterId === undefined ? "" : ` for character ${characterId}`} failed with HTTP ${response.status}`,
              response.status,
              response.status === 401 || response.status === 403
                ? {
                    ...(characterId === undefined ? {} : { characterId }),
                    authenticatedCharacterId: token
                      ? (characterIdFromToken(token) ?? null)
                      : null,
                    requiredScopes: [...operation.requiredScopes],
                  }
                : (data ?? undefined),
              {
                code,
                retryable: retryableForCode(code),
                retryAfterSeconds: parseRetryAfter(
                  response.headers.get("retry-after"),
                  fetchedAt,
                ),
              },
            );
          }
          if (
            operation.method === "GET" &&
            response.ok &&
            policy.cacheable &&
            policy.expiresAt !== null
          )
            this.storeCache(cacheKey, policy.expiresAt, result, byteLength);
          return result;
        },
        SpanKind.CLIENT,
      );
    });
  }

  private now(): number {
    return (this.options.clock?.() ?? new Date()).getTime();
  }

  private requestSignal(signal?: AbortSignal): AbortSignal | undefined {
    const signals = [
      signal,
      cancellationSignal(),
      this.options.getRequestSignal?.(),
    ].filter((value): value is AbortSignal => value !== undefined);
    return signals.length ? AbortSignal.any(signals) : undefined;
  }

  private evictCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt > now) continue;
      this.cache.delete(key);
      this.cacheBytes -= entry.cacheBytes;
    }
  }

  private storeCache(
    key: string,
    expiresAt: number,
    result: EsiResponse,
    byteLength: number,
  ): void {
    const now = this.now();
    this.evictCache(now);
    if (expiresAt <= now) return;
    // Continuations belong to callers, never to a shared cache entry.
    const response = {
      operationId: result.operationId,
      status: result.status,
      url: result.url,
      cached: false,
      headers: result.headers,
      data: result.data,
      freshness: result.freshness,
    };
    const cacheBytes = new TextEncoder().encode(
      key + JSON.stringify(response),
    ).byteLength;
    if (cacheBytes > this.limits.maxCacheBytes) return;
    const previous = this.cache.get(key);
    if (previous) {
      this.cache.delete(key);
      this.cacheBytes -= previous.cacheBytes;
    }
    while (
      this.cache.size >= this.limits.maxCacheEntries ||
      this.cacheBytes + cacheBytes > this.limits.maxCacheBytes
    ) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].cacheBytes;
    }
    this.cache.set(key, {
      expiresAt,
      response: structuredClone(response),
      byteLength,
      cacheBytes,
    });
    this.cacheBytes += cacheBytes;
  }

  private async request(
    key: string,
    operation: OperationDescriptor,
    url: URL,
    headers: Headers,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<WireResponse> {
    if (signal?.aborted) throw cancelled();
    let flight =
      operation.method === "GET" ? this.inFlight.get(key) : undefined;
    if (!flight) {
      if (this.activeRequests >= this.limits.maxInFlightRequests)
        throw new EsiRequestError(
          "ESI concurrent request safety limit reached",
          undefined,
          undefined,
          { code: "RESPONSE_LIMIT", retryable: false },
        );
      const controller = new AbortController();
      const created: InFlightRequest = {
        controller,
        waiters: new Set(),
        settled: false,
      };
      flight = created;
      this.activeRequests++;
      if (operation.method === "GET") this.inFlight.set(key, created);
      const timer = setTimeout(() => {
        controller.abort(
          new EsiRequestError(
            "ESI request deadline exceeded",
            undefined,
            undefined,
            { code: "NETWORK_ERROR", retryable: true },
          ),
        );
      }, this.limits.requestTimeoutMs);
      const release = () => {
        if (created.settled) return;
        created.settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", release);
        this.activeRequests--;
        if (this.inFlight.get(key) === created) this.inFlight.delete(key);
      };
      controller.signal.addEventListener("abort", release, { once: true });
      const work = async (): Promise<WireResponse> => {
        const limit = this.limits.maxResponseBytes;
        try {
          const fetching = (this.options.fetchImplementation ?? fetch)(url, {
            method: operation.method,
            headers,
            signal: controller.signal,
            ...(body === undefined ? {} : { body }),
          });
          // A non-cooperative fetch may resolve after its last caller has gone.
          void fetching.then(
            (response) => {
              if (controller.signal.aborted)
                void response.body?.cancel().catch(() => undefined);
            },
            () => undefined,
          );
          const response = await waitFor(fetching, controller.signal);
          const contentLength = Number(
            response.headers.get("content-length") ?? 0,
          );
          if (Number.isFinite(contentLength) && contentLength > limit) {
            void response.body?.cancel().catch(() => undefined);
            throw new EsiRequestError(
              `ESI response exceeds the ${limit} byte safety limit`,
              response.status,
              undefined,
              { code: "RESPONSE_LIMIT", retryable: false },
            );
          }
          const emptyBody =
            operation.method === "HEAD" ||
            response.status === 204 ||
            response.status === 304;
          if (emptyBody) void response.body?.cancel().catch(() => undefined);
          const raw = emptyBody
            ? ""
            : await withSpan(
                "eve.esi.read_body",
                { "eve.limit.response_bytes": limit },
                () => readBoundedBody(response, limit, controller.signal),
              );
          const byteLength = new TextEncoder().encode(raw).byteLength;
          if (byteLength > limit)
            throw new EsiRequestError(
              `ESI response exceeds the ${limit} byte safety limit`,
              response.status,
              undefined,
              { code: "RESPONSE_LIMIT", retryable: false },
            );
          if (controller.signal.aborted) throw cancelled();
          return { response, raw, byteLength, fetchedAt: this.now() };
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof EsiRequestError) throw error;
          throw new EsiRequestError(
            "ESI network request failed",
            undefined,
            undefined,
            { code: "NETWORK_ERROR", retryable: true },
          );
        }
      };
      void work().then(
        (response) => {
          release();
          for (const waiter of created.waiters) waiter.resolve(response);
        },
        (error: unknown) => {
          release();
          for (const waiter of created.waiters) waiter.reject(error);
        },
      );
    }
    const shared = flight;
    if (shared.waiters.size >= this.limits.maxWaitersPerRequest)
      throw new EsiRequestError(
        "ESI shared request waiter safety limit reached",
        undefined,
        undefined,
        { code: "RESPONSE_LIMIT", retryable: false },
      );
    return new Promise<WireResponse>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        shared.waiters.delete(waiter);
        if (!shared.settled && shared.waiters.size === 0)
          shared.controller.abort(cancelled());
      };
      const abort = () => {
        finish();
        reject(cancelled());
      };
      const waiter = {
        resolve: (response: WireResponse) => {
          finish();
          resolve(response);
        },
        reject: (error: unknown) => {
          finish();
          reject(
            error instanceof EsiRequestError
              ? new EsiRequestError(
                  error.message,
                  error.status,
                  structuredClone(error.details),
                  { ...error.metadata },
                )
              : cancelled(),
          );
        },
      };
      shared.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private requireToken(
    token: string | undefined,
    requiredScopes: string[],
    characterId?: number,
  ): string {
    if (!token)
      throw new EsiRequestError(
        "This operation requires EVE authentication.",
        401,
        {
          requiredScopes: [...requiredScopes],
          ...(characterId === undefined ? {} : { characterId }),
        },
        { code: "AUTHENTICATION_REQUIRED", retryable: false },
      );
    const missingScopes = missingTokenScopes(token, requiredScopes);
    if (missingScopes.length > 0)
      throw new EsiRequestError(
        "The EVE access token lacks required scopes",
        403,
        {
          missingScopes,
          ...(characterId === undefined ? {} : { characterId }),
        },
        { code: "MISSING_SCOPES", retryable: false },
      );
    if (
      characterId !== undefined &&
      characterIdFromToken(token) !== characterId
    )
      throw new EsiRequestError(
        `The EVE authorization does not belong to requested character ${characterId}.`,
        403,
        {
          characterId,
          authenticatedCharacterId: characterIdFromToken(token) ?? null,
        },
        { code: "CHARACTER_MISMATCH", retryable: false },
      );
    return token;
  }

  private async tokenFor(
    operation: OperationDescriptor,
    authorization: EsiAuthorization | undefined,
    characterId: number | undefined,
  ): Promise<string | undefined> {
    if (operation.requiredScopes.length === 0) return undefined;
    let token = authorization
      ? this.authorizationTokens.get(authorization)
      : undefined;
    if (authorization && !token)
      throw validationError("Invalid ESI authorization context");
    if (!token) {
      try {
        token = await this.tokenProvider.getAccessToken(
          operation.requiredScopes,
          characterId,
        );
      } catch (error) {
        throw new EsiRequestError(
          error instanceof Error ? error.message : "EVE authentication failed",
          error instanceof AuthenticationError ? 403 : 401,
          {
            requiredScopes: [...operation.requiredScopes],
            ...(characterId === undefined ? {} : { characterId }),
            ...(error instanceof AuthenticationError ? error.details : {}),
          },
          {
            code:
              error instanceof AuthenticationError
                ? error.code
                : "AUTHENTICATION_FAILED",
            retryable: false,
          },
        );
      }
    }
    return this.requireToken(token, operation.requiredScopes, characterId);
  }

  private paginationFor(
    operation: OperationDescriptor,
    input: EsiCallInput,
    responseHeaders: Record<string, string>,
  ): EsiResponse["pagination"] {
    const pageParameter = operation.parameters.find((parameter) => {
      if (parameter.in !== "query" || parameter.name !== "page") return false;
      const type = this.catalog.schemaFor(parameter).type;
      return (
        type === "integer" || (Array.isArray(type) && type.includes("integer"))
      );
    });
    if (!pageParameter)
      return {
        mode: "none",
        currentPage: null,
        totalPages: null,
        hasMore: null,
        nextCall: null,
      };
    const suppliedPage = input.query?.[pageParameter.name];
    const defaultPage = this.catalog.schemaFor(pageParameter).default;
    const currentPage =
      typeof suppliedPage === "number"
        ? suppliedPage
        : typeof defaultPage === "number"
          ? defaultPage
          : 1;
    const totalPages = validPageCount(responseHeaders["x-pages"]);
    const hasMore = totalPages === null ? null : currentPage < totalPages;
    return {
      mode: "page",
      currentPage,
      totalPages,
      hasMore,
      nextCall:
        hasMore === true
          ? {
              operationId: input.operationId,
              ...(operation.requiredScopes.length > 0 &&
              input.actingCharacterId !== undefined
                ? { actingCharacterId: input.actingCharacterId }
                : {}),
              ...(input.path ? { path: { ...input.path } } : {}),
              query: { ...input.query, [pageParameter.name]: currentPage + 1 },
              ...(input.headers
                ? {
                    headers: Object.fromEntries(
                      Object.entries(input.headers).filter(
                        ([name]) =>
                          !["if-none-match", "if-modified-since"].includes(
                            name.toLowerCase(),
                          ),
                      ),
                    ),
                  }
                : {}),
              ...(input.body === undefined ? {} : { body: input.body }),
            }
          : null,
    };
  }

  private buildUrl(
    operation: OperationDescriptor,
    pathValues: Record<string, JsonValue>,
    queryValues: Record<string, JsonValue>,
  ): URL {
    const pathParameters = declaredByLocation(operation, "path");
    this.rejectUnknown(pathValues, pathParameters, "path");
    let path = operation.path;
    for (const parameter of pathParameters.values()) {
      const value = pathValues[parameter.name];
      if (value === undefined || value === null)
        throw validationError(
          `Missing required path parameter: ${parameter.name}`,
        );
      validateValue(parameter.name, value, this.catalog.schemaFor(parameter));
      path = path.replace(
        `{${parameter.name}}`,
        encodeURIComponent(scalar(value)),
      );
    }
    if (/\{[^}]+\}/u.test(path))
      throw validationError(
        `Not all path parameters were supplied for ${operation.operationId}`,
      );

    const url = new URL(path, this.baseUrl);
    const queryParameters = declaredByLocation(operation, "query");
    this.rejectUnknown(queryValues, queryParameters, "query");
    for (const parameter of queryParameters.values()) {
      let value = queryValues[parameter.name];
      if (value === undefined && parameter.schema)
        value = this.catalog.schemaFor(parameter).default;
      if (value === undefined || value === null) {
        if (parameter.required)
          throw validationError(
            `Missing required query parameter: ${parameter.name}`,
          );
        continue;
      }
      validateValue(parameter.name, value, this.catalog.schemaFor(parameter));
      for (const encoded of valuesForQuery(value, parameter))
        url.searchParams.append(parameter.name, encoded);
    }
    return url;
  }

  private buildHeaders(
    operation: OperationDescriptor,
    input: Record<string, JsonValue>,
  ): Headers {
    const parameters = declaredByLocation(operation, "header");
    const normalizedInput = Object.fromEntries(
      Object.entries(input).map(([name, value]) => [name.toLowerCase(), value]),
    );
    this.rejectUnknown(normalizedInput, parameters, "header");
    const headers = new Headers({
      accept: "application/json",
      "user-agent": this.options.userAgent ?? DEFAULT_ESI_USER_AGENT,
    });
    for (const parameter of parameters.values()) {
      let value = normalizedInput[parameter.name.toLowerCase()];
      const schema = this.catalog.schemaFor(parameter);
      if (value === undefined) value = schema.default;
      if (
        value === undefined &&
        parameter.name.toLowerCase() === "x-compatibility-date"
      )
        value =
          schema.enum?.[0] ?? this.catalog.document.info.version ?? undefined;
      if (value === undefined || value === null) {
        if (parameter.required)
          throw validationError(
            `Missing required header parameter: ${parameter.name}`,
          );
        continue;
      }
      validateValue(parameter.name, value, schema);
      headers.set(parameter.name, scalar(value));
    }
    return headers;
  }

  private rejectUnknown(
    values: Record<string, JsonValue>,
    parameters: Map<string, ParameterObject>,
    location: string,
  ): void {
    const unknown = Object.keys(values).filter(
      (name) => !parameters.has(name.toLowerCase()),
    );
    if (unknown.length > 0)
      throw validationError(
        `Unknown ${location} parameter(s): ${unknown.join(", ")}`,
      );
  }
}
