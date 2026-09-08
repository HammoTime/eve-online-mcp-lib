import {
  context,
  createContextKey,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { DiagnosticError } from "./diagnostic-error.js";

export interface DiagnosticRecord {
  event: string;
  attributes: Attributes;
  traceId: string;
  spanId: string;
}
export interface TelemetryServices {
  tracer: Tracer;
  meter?: Meter;
  emit?: (record: DiagnosticRecord) => void;
  trackCompletion?: (completion: Promise<void>) => void;
}
const SERVICES = createContextKey("eve.telemetry.services");
const ERRORS = createContextKey("eve.telemetry.errors");
const ACTIVITIES = createContextKey("eve.telemetry.activities");
const CANCELLATION = createContextKey("eve.telemetry.cancellation");
const ERROR_CODES = new Set([
  "UNKNOWN_OPERATION",
  "VALIDATION_ERROR",
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_FAILED",
  "MISSING_SCOPES",
  "CHARACTER_MISMATCH",
  "CHARACTER_SELECTION_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "THROTTLED",
  "NETWORK_ERROR",
  "UPSTREAM_ERROR",
  "RESPONSE_LIMIT",
  "INVALID_UPSTREAM_RESPONSE",
  "CHARACTER_NOT_AUTHORIZED",
  "EVE_RECONNECT_REQUIRED",
  "EVE_SSO_UNAVAILABLE",
  "CREDENTIAL_CHANGED",
  "INVALID_EVE_CALLBACK",
  "EXPIRED_EVE_TRANSACTION",
  "MISSING_EVE_REFRESH_TOKEN",
  "UNEXPECTED_EVE_SCOPE",
]);

/** Hosts bind providers to context; no request can replace another request's SDK. */
export function withTelemetry<T>(
  services: TelemetryServices,
  operation: () => T,
): T {
  return context.with(
    context
      .active()
      .setValue(SERVICES, services)
      .setValue(ERRORS, new WeakMap<object, string>()),
    operation,
  );
}
export function withTracer<T>(tracer: Tracer, operation: () => T): T {
  return withTelemetry({ tracer }, operation);
}
export function getTracer(): Tracer {
  return (
    (context.active().getValue(SERVICES) as TelemetryServices | undefined)
      ?.tracer ?? trace.getTracer("eve-online-mcp-lib", "1")
  );
}
export function telemetryContext(fallback: Context): Context {
  return context.active().getValue(SERVICES) ? context.active() : fallback;
}
export function operationContext(
  parent: Context,
  activities: Set<Promise<void>>,
  signal: AbortSignal,
): Context {
  return parent
    .setValue(ACTIVITIES, activities)
    .setValue(CANCELLATION, signal)
    .setValue(ERRORS, new WeakMap<object, string>());
}
export function cancellationSignal(): AbortSignal | undefined {
  return context.active().getValue(CANCELLATION) as AbortSignal | undefined;
}
export function trackCompletion(completion: Promise<void>): void {
  (
    context.active().getValue(SERVICES) as TelemetryServices | undefined
  )?.trackCompletion?.(completion);
}
export function diagnostic(event: string, attributes: Attributes = {}): void {
  // Only call with a reviewed field projection. Never serialize the source object.
  const span = trace.getSpan(context.active());
  span?.addEvent(event, attributes);
  const services = context.active().getValue(SERVICES) as
    TelemetryServices | undefined;
  const ids = span?.spanContext();
  if (ids && services?.emit) {
    try {
      services.emit({
        event,
        attributes,
        traceId: ids.traceId,
        spanId: ids.spanId,
      });
    } catch {
      /* Diagnostic failures must not change application behavior. */
    }
  }
}
export function attributes(values: Attributes): void {
  trace.getSpan(context.active())?.setAttributes(values);
}
export function diagnosticMetadata(): Record<string, string> {
  const traceId = trace.getSpan(context.active())?.spanContext().traceId;
  return traceId && !/^0+$/u.test(traceId) ? { "eve/trace-id": traceId } : {};
}
export function safeErrorCode(cause: unknown): string {
  if (cause instanceof DiagnosticError) return cause.code;
  if (cause instanceof Error && cause.name === "ZodError")
    return "VALIDATION_ERROR";
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    ERROR_CODES.has(cause.code)
  )
    return cause.code;
  return cause instanceof Error && cause.name === "AbortError"
    ? "CANCELLED"
    : "INTERNAL_ERROR";
}
/** Messages/stacks may contain credentials, URLs or private data. Code and
 * origin span identify the failure; versions and safe evidence reproduce it. */
export function recordError(
  cause: unknown,
  span = trace.getSpan(context.active()),
): void {
  if (!span) return;
  const code = safeErrorCode(cause);
  span.setAttributes({ "error.type": code, "eve.error.code": code });
  span.setStatus({ code: SpanStatusCode.ERROR });
  const seen = context.active().getValue(ERRORS) as
    WeakMap<object, string> | undefined;
  const key = typeof cause === "object" && cause !== null ? cause : undefined;
  const origin = key ? seen?.get(key) : undefined;
  span.setAttribute(
    "eve.error.origin_span_id",
    origin ?? span.spanContext().spanId,
  );
  if (!origin) {
    if (key) seen?.set(key, span.spanContext().spanId);
    diagnostic("exception", { "exception.type": code, "eve.error.code": code });
  }
}
export function recordOperation(
  name: string,
  start: number,
  outcome: string,
  labels: Attributes = {},
): void {
  const meter =
    (context.active().getValue(SERVICES) as TelemetryServices | undefined)
      ?.meter ?? metrics.getMeter("eve-online-mcp-lib", "1");
  const dimensions = {
    "eve.operation.name": name,
    "eve.outcome": outcome,
    ...labels,
  };
  meter
    .createCounter("eve.operation.calls", { unit: "{call}" })
    .add(1, dimensions);
  meter
    .createHistogram("eve.operation.duration", { unit: "s" })
    .record(Math.max(0, Date.now() - start) / 1000, dimensions);
}
function resultOutcome(value: unknown, span: Span): string {
  if (typeof value !== "object" || value === null) return "success";
  if ("isError" in value && value.isError === true) {
    span.setAttribute("error.type", "tool_error");
    span.setStatus({ code: SpanStatusCode.ERROR });
    return "error";
  }
  if (
    ("complete" in value && value.complete === false) ||
    ("status" in value && value.status === "partial")
  )
    return "partial";
  return "success";
}
export async function withSpan<T>(
  name: string,
  values: Attributes,
  operation: () => T | Promise<T>,
  kind = SpanKind.INTERNAL,
): Promise<T> {
  const result = getTracer().startActiveSpan(
    name,
    { attributes: { "code.function.name": name, ...values }, kind },
    async (span) => {
      const start = Date.now();
      let outcome = "success";
      try {
        const result = await operation();
        outcome = resultOutcome(result, span);
        return result;
      } catch (cause) {
        outcome = "error";
        recordError(cause, span);
        throw cause;
      } finally {
        span.setAttributes({
          "eve.outcome": outcome,
          "eve.operation.failed": outcome === "error",
        });
        recordOperation(name, start, outcome);
        span.end();
      }
    },
  );
  const completion = result.then(
    () => {
      /* settled */
    },
    () => {
      /* caller handles the failure */
    },
  );
  const activities = context.active().getValue(ACTIVITIES) as
    Set<Promise<void>> | undefined;
  activities?.add(completion);
  void completion.then(() => {
    activities?.delete(completion);
  });
  trackCompletion(completion);
  return result;
}
export function withSpanSync<T>(
  name: string,
  operation: () => T,
  values: Attributes = {},
): T {
  return getTracer().startActiveSpan(name, { attributes: values }, (span) => {
    const start = Date.now();
    let outcome = "success";
    try {
      const result = operation();
      outcome = resultOutcome(result, span);
      return result;
    } catch (cause) {
      outcome = "error";
      recordError(cause, span);
      throw cause;
    } finally {
      span.setAttribute("eve.outcome", outcome);
      recordOperation(name, start, outcome);
      span.end();
    }
  });
}
export function spanContext(span: Span, parent = context.active()): Context {
  return trace.setSpan(parent, span);
}
