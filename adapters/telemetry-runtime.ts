/** Optional host SDK adapter. Shared src/ depends only on the OTel API. */
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  AggregationTemporality,
  AggregationType,
  MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  LoggerProvider,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  JsonTraceSerializer,
  JsonMetricsSerializer,
  JsonLogsSerializer,
} from "@opentelemetry/otlp-transformer";
import { withTelemetry, type DiagnosticRecord } from "../src/telemetry.js";
import {
  withCaptureOptions,
  type DiagnosticCaptureOptions,
} from "../src/diagnostics.js";

type Log = Parameters<LogRecordProcessor["onEmit"]>[0];
type Signal = "traces" | "metrics" | "logs";
export interface RuntimeOptions {
  service: string;
  version: string;
  environment: string;
  endpoint: string;
  headers?: string;
  versions?: Record<string, string>;
  capture?: DiagnosticCaptureOptions;
  fetch?: typeof fetch;
  failure?: (reason: string) => void;
}
class DeltaReader extends MetricReader {
  constructor() {
    super({
      aggregationTemporalitySelector: () => AggregationTemporality.DELTA,
      cardinalitySelector: () => 128,
    });
  }
  protected onShutdown() {
    return Promise.resolve();
  }
  protected onForceFlush() {
    return Promise.resolve();
  }
}
export class TelemetryRuntime {
  private spans: ReadableSpan[] = [];
  private logs: Log[] = [];
  private admitted = new WeakSet<object>();
  private slots = 0;
  private bytes = 0;
  private logBytes = 0;
  private dropped = 0;
  private readonly traces: BasicTracerProvider;
  private readonly meters: MeterProvider;
  private readonly loggers: LoggerProvider;
  private readonly reader = new DeltaReader();
  private flushing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<void>>();
  private readonly roots = new Map<object, Span>();
  readonly tracer;
  readonly meter;
  private readonly logger;
  constructor(readonly options: RuntimeOptions) {
    const resource = resourceFromAttributes({
      "service.name": options.service,
      "service.version": options.version,
      "deployment.environment.name": options.environment,
      "eve.telemetry.schema_version": 1,
      ...Object.fromEntries(
        Object.entries(options.versions ?? {}).map(([k, v]) => [
          `eve.version.${k}`,
          v,
        ]),
      ),
    });
    const processor: SpanProcessor = {
      onStart: (span) => {
        // Reserve capacity for late-ending parents by admitting at start.
        const priority =
          span.kind === SpanKind.SERVER || !span.parentSpanContext;
        if (priority) this.roots.set(span, span);
        if (this.slots < (priority ? 1024 : 960)) {
          this.slots++;
          this.admitted.add(span);
        } else this.drop();
      },
      onEnd: (span) => {
        this.roots.delete(span);
        if (!this.admitted.has(span)) return;
        const priority =
          span.kind === SpanKind.SERVER ||
          !span.parentSpanContext ||
          span.status.code === SpanStatusCode.ERROR;
        const size =
          JsonTraceSerializer.serializeRequest([span])?.byteLength ?? 0;
        if (this.bytes + size > (priority ? 256 * 1024 : 192 * 1024)) {
          this.drop();
          return;
        }
        this.bytes += size;
        this.spans.push(span);
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
    this.traces = new BasicTracerProvider({
      resource,
      spanProcessors: [processor],
      spanLimits: {
        attributeCountLimit: 64,
        attributeValueLengthLimit: 1024,
        eventCountLimit: 32,
        attributePerEventCountLimit: 16,
        linkCountLimit: 8,
      },
    });
    this.meters = new MeterProvider({
      resource,
      readers: [this.reader],
      views: [
        {
          instrumentName: "eve.operation.duration",
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: {
              boundaries: [
                0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
                30, 60,
              ],
            },
          },
        },
      ],
    });
    this.loggers = new LoggerProvider({
      resource,
      logRecordLimits: {
        attributeCountLimit: 32,
        attributeValueLengthLimit: 1024,
      },
      processors: [
        {
          onEmit: (record) => {
            const bytes =
              JsonLogsSerializer.serializeRequest([record])?.byteLength ?? 0;
            const priority =
              record.body === "exception" ||
              (typeof record.body === "string" &&
                record.body.startsWith("diagnostic.capture_"));
            if (
              bytes <= 8 * 1024 &&
              this.logBytes + bytes <= (priority ? 128 : 96) * 1024
            ) {
              this.logs.push(record);
              this.logBytes += bytes;
            } else this.drop();
          },
          forceFlush: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
        },
      ],
    });
    this.tracer = this.traces.getTracer("eve-online-mcp-lib", "1");
    this.meter = this.meters.getMeter("eve-online-mcp-lib", "1");
    this.logger = this.loggers.getLogger("eve-online-mcp-lib", "1");
  }
  emit = (record: DiagnosticRecord): void => {
    this.logger.emit({
      body: record.event,
      severityNumber: record.event === "exception" ? 17 : 9,
      attributes: record.attributes,
      context: context.active(),
    });
  };
  private failure(reason: string): void {
    try {
      this.options.failure?.(reason);
    } catch {
      /* Telemetry must not change application results. */
    }
  }
  private drop(): void {
    this.dropped++;
    for (const span of this.roots.values())
      span.setAttributes({
        "eve.telemetry.incomplete": true,
        "eve.telemetry.dropped_records": this.dropped,
      });
  }
  run<T>(operation: () => T, parent: Context = context.active()): T {
    return context.with(parent, () =>
      withTelemetry(
        {
          tracer: this.tracer,
          meter: this.meter,
          emit: this.emit,
          trackCompletion: (completion) => {
            this.pending.add(completion);
            void completion.finally(() => this.pending.delete(completion));
          },
        },
        () => withCaptureOptions(this.options.capture, operation),
      ),
    );
  }
  async settle(): Promise<void> {
    await Promise.all(this.pending);
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.export()
      .catch(() => {
        this.failure("export_failed");
      })
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }
  private async export(): Promise<void> {
    if (this.dropped) {
      this.meter
        .createCounter("eve.telemetry.dropped", { unit: "{record}" })
        .add(this.dropped);
      this.failure("capture_limit");
    }
    const spans = this.spans.splice(0),
      logs = this.logs.splice(0);
    this.bytes = 0;
    this.logBytes = 0;
    this.slots = 0;
    this.dropped = 0;
    const metrics = await this.reader.collect({ timeoutMillis: 500 });
    const batches: { signal: Signal; body: Uint8Array }[] = [];
    const split = <T>(
      signal: Signal,
      items: T[],
      serialize: (items: T[]) => Uint8Array | undefined,
    ) => {
      let batch: T[] = [];
      for (const item of items) {
        const next = serialize([...batch, item]);
        if (next && next.byteLength > 256 * 1024 && batch.length) {
          const body = serialize(batch);
          if (body) batches.push({ signal, body });
          batch = [];
        }
        batch.push(item);
      }
      const body = serialize(batch);
      if (body && batch.length) batches.push({ signal, body });
    };
    split("traces", spans, (s) => JsonTraceSerializer.serializeRequest(s));
    split("logs", logs, (s) => JsonLogsSerializer.serializeRequest(s));
    const metricBody = JsonMetricsSerializer.serializeRequest(
      metrics.resourceMetrics,
    );
    if (metricBody && metricBody.byteLength <= 256 * 1024)
      batches.push({ signal: "metrics", body: metricBody });
    else this.failure("metric_limit");
    const deadline = AbortSignal.timeout(12_000);
    let index = 0;
    await context.with(suppressTracing(ROOT_CONTEXT), () =>
      Promise.allSettled(
        Array.from({ length: 2 }, async () => {
          while (index < batches.length) {
            const batch = batches[index++];
            if (!batch) break;
            try {
              await this.send(batch.signal, batch.body, deadline);
            } catch {
              this.failure("export_failed");
            }
          }
        }),
      ),
    );
  }
  private async send(
    signal: Signal,
    body: Uint8Array,
    deadline: AbortSignal,
  ): Promise<void> {
    const url = new URL(this.options.endpoint);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      )
    )
      throw new Error("Invalid telemetry endpoint");
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Invalid telemetry endpoint");
    url.pathname = url.pathname.replace(/\/$/u, "") + `/v1/${signal}`;
    const headers = new Headers({ "content-type": "application/json" });
    for (const [key, value] of Object.entries(
      JSON.parse(this.options.headers ?? "{}") as Record<string, unknown>,
    )) {
      if (typeof value !== "string")
        throw new Error("Invalid telemetry headers");
      headers.set(key, value);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(url, {
          method: "POST",
          headers,
          body: new Uint8Array(body),
          redirect: "manual",
          signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
        });
      } catch {
        if (!attempt && !deadline.aborted) continue;
        throw new Error("Telemetry connection failed");
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (
          !attempt &&
          [429, 502, 503, 504].includes(response.status) &&
          !deadline.aborted
        )
          continue;
        throw new Error("Telemetry rejected");
      }
      // An HTTP 200 can still reject records. Never replay an accepted partial batch.
      const reader = response.body?.getReader();
      let size = 0,
        text = "";
      if (reader)
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 4096) {
              await reader.cancel();
              throw new Error("Telemetry reply limit");
            }
            text += new TextDecoder().decode(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      const result = text
        ? (JSON.parse(text) as { partialSuccess?: Record<string, unknown> })
        : {};
      const partial = result.partialSuccess;
      if (
        partial &&
        ["rejectedSpans", "rejectedLogRecords", "rejectedDataPoints"].some(
          (k) => Number(partial[k] ?? 0) > 0,
        )
      ) {
        this.failure("partial_success");
      }
      return;
    }
  }
  async shutdown(): Promise<void> {
    await this.flush();
    await Promise.all([
      this.traces.shutdown(),
      this.meters.shutdown(),
      this.loggers.shutdown(),
    ]);
  }
}
