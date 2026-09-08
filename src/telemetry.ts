import {
  context,
  createContextKey,
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Tracer,
} from "@opentelemetry/api";

const TRACER = createContextKey("eve.telemetry.tracer");
const duration = metrics
  .getMeter("eve-online-mcp-lib")
  .createHistogram("eve.operation.duration", { unit: "s" });
const calls = metrics
  .getMeter("eve-online-mcp-lib")
  .createCounter("eve.operation.calls");

/** Hosts may bind a request-local tracer without replacing the process-global SDK. */
export function withTracer<T>(tracer: Tracer, operation: () => T): T {
  return context.with(context.active().setValue(TRACER, tracer), operation);
}
function tracer(): Tracer {
  return (
    (context.active().getValue(TRACER) as Tracer | undefined) ??
    trace.getTracer("eve-online-mcp-lib")
  );
}
function failed(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    value.isError === true
  );
}
/** Never record exception messages, arguments, tokens, or result payloads. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  operation: () => T | Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    const start = Date.now();
    let error = false;
    try {
      const value = await operation();
      error = failed(value);
      if (error) span.setStatus({ code: SpanStatusCode.ERROR });
      return value;
    } catch (cause) {
      error = true;
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw cause;
    } finally {
      span.setAttribute("eve.operation.failed", error);
      span.end();
      const labels = { operation: name, error };
      calls.add(1, labels);
      duration.record((Date.now() - start) / 1000, labels);
    }
  });
}
export function withSpanSync<T>(name: string, operation: () => T): T {
  return tracer().startActiveSpan(name, (span) => {
    try {
      return operation();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
