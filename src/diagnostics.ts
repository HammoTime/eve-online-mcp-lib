import {
  context,
  createContextKey,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { object, projectInput } from "./diagnostic-policy.js";
import { attributes, diagnostic } from "./telemetry.js";
import type { StaticCatalog } from "./skill-data.js";

export interface CatalogArtifact {
  kind: "static_catalog";
  sha256: string;
  key: string;
  status: Record<string, string | number | boolean | null>;
}

export interface DependencyEvidence {
  ordinal: number;
  operationId: string;
  input: Record<string, unknown>;
  cached: boolean;
  startedAt: number;
  fetchedAt: number;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  bodyArtifact?: { sha256: string; key: string };
  bodyBytes?: number;
  errorCode?: string;
}
export interface ReplayManifest {
  schemaVersion: 1;
  policyVersion: 1;
  traceId: string;
  boundary: "mcp";
  status: "exact" | "partial";
  reasons: string[];
  versions: Record<string, string>;
  request: { method: string; tool: string; arguments: Record<string, unknown> };
  dependencies: DependencyEvidence[];
  catalogs: CatalogArtifact[];
  expected: Attributes;
}
export interface DiagnosticCaptureOptions {
  versions: Record<string, string>;
  save(manifest: ReplayManifest): void;
  saveCatalog?: (
    catalog: StaticCatalog,
  ) => Promise<{ sha256: string; key: string }>;
  saveDependency?: (body: string) => Promise<{ sha256: string; key: string }>;
}
const CAPTURE = createContextKey("eve.diagnostic.capture");
const OPTIONS = createContextKey("eve.diagnostic.options");
const MAX_BYTES = 768 * 1024;
export class DiagnosticCapture {
  readonly dependencies: DependencyEvidence[] = [];
  readonly catalogs: CatalogArtifact[] = [];
  private readonly reasons = new Set<string>();
  private bytes = 0;
  private ordinal = 0;
  private artifactBytes = 0;
  constructor(
    readonly options: DiagnosticCaptureOptions,
    readonly request: ReplayManifest["request"],
    complete: boolean,
  ) {
    if (!complete) this.incomplete("input_redacted");
    if (
      ![
        "get_market_snapshot",
        "call_esi",
        "get_skill_dependencies",
        "resolve_skill_plan_targets",
        "initialize_static_data",
      ].includes(request.tool)
    )
      this.incomplete("unsupported_replay_adapter");
    if (
      !/^[a-f0-9]{40}$/u.test(options.versions.server ?? "") ||
      !/^[a-f0-9]{40}$/u.test(options.versions.library ?? "") ||
      !/^[a-f0-9]{64}$/u.test(options.versions.openapi ?? "")
    )
      this.incomplete("missing_versions");
  }
  next(): number {
    return ++this.ordinal;
  }
  incomplete(reason: string): void {
    this.reasons.add(reason);
  }
  async add(record: DependencyEvidence): Promise<void> {
    if (
      record.body &&
      new TextEncoder().encode(record.body).byteLength > 16 * 1024 &&
      this.options.saveDependency
    ) {
      const size = new TextEncoder().encode(record.body).byteLength;
      if (this.artifactBytes + size > 8 * 1024 * 1024) {
        this.incomplete("artifact_limit");
        delete record.body;
      } else {
        this.artifactBytes += size;
        try {
          record.bodyArtifact = await this.options.saveDependency(record.body);
        } catch {
          this.incomplete("dependency_capture_failed");
        }
        delete record.body;
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (this.bytes + bytes > MAX_BYTES || this.dependencies.length >= 100) {
      this.incomplete("capture_limit");
      return;
    }
    this.bytes += bytes;
    this.dependencies.push(record);
  }
  finish(expected: Attributes): void {
    const traceId = trace.getSpan(context.active())?.spanContext().traceId;
    if (!traceId) return;
    if (this.dependencies.length !== this.ordinal)
      this.incomplete("missing_dependency");
    const manifest: ReplayManifest = {
      schemaVersion: 1,
      policyVersion: 1,
      traceId,
      boundary: "mcp",
      status: this.reasons.size ? "partial" : "exact",
      reasons: [...this.reasons],
      versions: this.options.versions,
      request: this.request,
      dependencies: this.dependencies.sort((a, b) => a.ordinal - b.ordinal),
      catalogs: this.catalogs,
      expected,
    };
    attributes({
      "eve.replay.status": manifest.status,
      "eve.replay.boundary": "mcp",
      "eve.replay.reasons": manifest.reasons,
      "eve.replay.dependency_count": manifest.dependencies.length,
      "eve.replay.artifact_id": traceId,
      "eve.replay.policy_version": 1,
    });
    try {
      this.options.save(manifest);
    } catch {
      diagnostic("diagnostic.capture_failed", {
        "eve.replay.failure": "sink_unavailable",
      });
    }
  }
}
export function withCaptureOptions<T>(
  options: DiagnosticCaptureOptions | undefined,
  operation: () => T,
): T {
  return options
    ? context.with(context.active().setValue(OPTIONS, options), operation)
    : operation();
}
export function captureOptions(): DiagnosticCaptureOptions | undefined {
  return context.active().getValue(OPTIONS) as
    DiagnosticCaptureOptions | undefined;
}
export function captureContext(
  capture: DiagnosticCapture,
  parent = context.active(),
) {
  return parent.setValue(CAPTURE, capture);
}
export function activeCapture(): DiagnosticCapture | undefined {
  return context.active().getValue(CAPTURE) as DiagnosticCapture | undefined;
}
export async function captureCatalog(
  data: StaticCatalog,
  status: Record<string, unknown>,
  refresh: boolean,
): Promise<void> {
  const capture = activeCapture();
  if (!capture) return;
  if (capture.catalogs.length >= 10) {
    capture.incomplete("catalog_limit");
    return;
  }
  if (refresh) capture.incomplete("refresh_adapter_required");
  if (!capture.options.saveCatalog) {
    capture.incomplete("catalog_sink_unavailable");
    return;
  }
  const safeStatus: CatalogArtifact["status"] = {};
  for (const key of ["buildNumber", "stale", "refreshInProgress", "cached"])
    if (typeof status[key] === "number" || typeof status[key] === "boolean")
      safeStatus[key] = status[key];
  for (const key of ["checkedAt", "fetchedAt"])
    if (
      status[key] === null ||
      (typeof status[key] === "string" &&
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(status[key]))
    )
      safeStatus[key] = status[key];
  try {
    const ref = await capture.options.saveCatalog(data);
    capture.catalogs.push({
      kind: "static_catalog",
      ...ref,
      status: safeStatus,
    });
    attributes({
      "eve.sde.build": data.buildNumber,
      "eve.sde.sha256": ref.sha256,
      "eve.sde.type_count": data.types.length,
    });
  } catch {
    capture.incomplete("catalog_capture_failed");
  }
}

const ORDER_NUMBERS = new Set([
  "order_id",
  "type_id",
  "location_id",
  "volume_remain",
  "volume_total",
  "price",
  "duration",
  "min_volume",
  "system_id",
]);
/** The entire raw body is retained only when every field passes this reviewed
 * public-market policy. This preserves order/whitespace and duplicate evidence. */
export function safeMarketBody(
  raw: string,
  operation: string,
  status: number,
): boolean {
  if (operation !== "GetMarketsRegionIdOrders") return false;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  if (status >= 400) {
    const data = object(value);
    return (
      Object.keys(data).length === 1 &&
      [
        "Rate limited",
        "Too many requests",
        "Service unavailable",
        "Internal server error",
      ].includes(String(data.error))
    );
  }
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        return false;
      return Object.entries(object(item)).every(([key, field]) => {
        if (ORDER_NUMBERS.has(key))
          return (
            typeof field === "number" &&
            Number.isFinite(field) &&
            (key !== "location_id" || (field >= 60000000 && field < 70000000))
          );
        if (key === "is_buy_order") return typeof field === "boolean";
        if (key === "range")
          return (
            typeof field === "string" &&
            /^(station|solarsystem|region|[0-9]{1,2})$/u.test(field)
          );
        if (key === "issued")
          return (
            typeof field === "string" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(field)
          );
        return false;
      });
    })
  );
}
export function safeResponseHeaders(
  headers: Headers,
  publicMarket = false,
): {
  values: Record<string, string>;
  complete: boolean;
} {
  const values: Record<string, string> = {};
  let complete = true;
  const known = [
    "cache-control",
    "content-type",
    "etag",
    "expires",
    "last-modified",
    "retry-after",
    "x-pages",
    "x-esi-error-limit-remain",
    "x-esi-error-limit-reset",
    "x-ratelimit-group",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-used",
  ];
  for (const key of known) {
    const value = headers.get(key);
    if (value === null) continue;
    const allowed =
      value.length <= 256 &&
      ((publicMarket &&
        key === "etag" &&
        /^(W\/)?"[a-f0-9]{32,64}"$/iu.test(value)) ||
        (publicMarket &&
          key === "x-ratelimit-group" &&
          value === "market-order") ||
        (key === "x-ratelimit-limit" &&
          /^\d{1,9}\/\d{1,6}[smh]$/u.test(value)) ||
        (key === "cache-control" &&
          /^(?:(?:public|private|no-cache|no-store|must-revalidate|max-age=\d+|s-maxage=\d+)(?:,\s*)?)+$/u.test(
            value,
          )) ||
        (key === "content-type" &&
          /^(application\/json|text\/plain)(;\s*charset=utf-8)?$/iu.test(
            value,
          )) ||
        (["expires", "last-modified"].includes(key) &&
          /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
            value,
          )) ||
        ([
          "retry-after",
          "x-pages",
          "x-esi-error-limit-remain",
          "x-esi-error-limit-reset",
          "x-ratelimit-limit",
          "x-ratelimit-remaining",
          "x-ratelimit-used",
        ].includes(key) &&
          /^\d{1,12}$/u.test(value)));
    if (allowed) values[key] = value;
    else complete = false;
  }
  return { values, complete };
}
export function dependencyInput(input: unknown, operation: string) {
  return projectInput(input, (name) => name === operation);
}
