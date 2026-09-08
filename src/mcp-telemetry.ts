import { McpServer } from "@modelcontextprotocol/server";
import {
  context,
  trace,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type Context,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import {
  object,
  projectInput,
  projectOutput,
  TOOL_NAMES,
} from "./diagnostic-policy.js";
import {
  captureContext,
  captureOptions,
  DiagnosticCapture,
} from "./diagnostics.js";
import {
  diagnostic,
  getTracer,
  recordError,
  recordOperation,
  safeErrorCode,
  spanContext,
  trackCompletion,
  telemetryContext,
  operationContext,
  withSpanSync,
} from "./telemetry.js";

type Transport = Parameters<McpServer["connect"]>[0];
type Message = Parameters<Transport["send"]>[0];
const METHODS = new Set([
  "server/discover",
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
]);
const VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
]);
export function remoteSpan(value: unknown): SpanContext | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u.exec(value);
  const [, traceId, spanId, flags] = match ?? [];
  if (
    !traceId ||
    !spanId ||
    !flags ||
    /^0+$/u.test(traceId) ||
    /^0+$/u.test(spanId)
  )
    return undefined;
  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16) & 1 ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  };
}
interface Pending {
  span: Span;
  ctx: Context;
  start: number;
  method: string;
  tool: string;
  done(): void;
  controller: AbortController;
  activities: Set<Promise<void>>;
  cleanup(): void;
  capture?: DiagnosticCapture;
}
/** Public transport decorator: covers SDK validation, serialization and actual
 * send completion without reaching into MCP SDK private handler internals. */
export class ObservedMcpServer extends McpServer {
  private readonly creationContext = context.active();
  knownOperation: (name: string) => boolean = () => false;
  trustedTraceContext = false;
  override async connect(transport: Transport): Promise<void> {
    const pending = new Map<string | number, Pending>();
    const hostContext = telemetryContext(this.creationContext);
    let version = "unknown";
    const finish = (
      id: string | number,
      message?: Message,
      failure?: unknown,
      cancelled = false,
    ) => {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      call.cleanup();
      context.with(call.ctx, () => {
        let outcome = "success";
        const result =
          message && "result" in message ? object(message.result) : {};
        const output = projectOutput(result.structuredContent ?? result);
        if (cancelled || call.controller.signal.aborted) {
          outcome = "cancelled";
          call.capture?.incomplete("cancelled");
        } else if (failure) {
          call.capture?.incomplete("transport_failure");
          recordError(failure);
          outcome = "error";
        } else if (message && "error" in message) {
          call.span.setAttribute(
            "rpc.response.status_code",
            message.error.code,
          );
          outcome = [-32700, -32600, -32601, -32602, -32002].includes(
            message.error.code,
          )
            ? "rejected"
            : "error";
          if (outcome === "error")
            call.span.setAttributes({ "error.type": "rpc_error" });
        } else if (result.isError === true) {
          outcome = "error";
          call.span.setAttributes({
            "error.type": "tool_error",
            "eve.error.code": safeErrorCode(result.structuredContent),
          });
        } else if (
          output["eve.output.complete"] === false ||
          output["eve.output.status"] === "partial"
        )
          outcome = "partial";
        if (outcome === "error")
          call.span.setStatus({ code: SpanStatusCode.ERROR });
        call.span.setAttributes({
          ...output,
          "eve.outcome": outcome,
          "mcp.protocol.version": version,
        });
        call.capture?.finish({ ...output, "eve.outcome": outcome });
        diagnostic("mcp.request.complete", {
          "eve.outcome": outcome,
          "mcp.method.name": call.method,
        });
        recordOperation(
          call.method,
          call.start,
          outcome,
          call.tool ? { "gen_ai.tool.name": call.tool } : {},
        );
        call.span.end();
        call.done();
      });
    };
    const cancel = (id: string | number) => {
      const call = pending.get(id);
      if (!call || call.controller.signal.aborted) return;
      call.controller.abort();
      void Promise.all(call.activities).then(() => {
        finish(id, undefined, undefined, true);
      });
    };
    const wrapper: Transport = {
      ...(transport.hasPerRequestStream === undefined
        ? {}
        : { hasPerRequestStream: transport.hasPerRequestStream }),
      get sessionId() {
        return transport.sessionId;
      },
      start: () => transport.start(),
      close: () => transport.close(),
      setProtocolVersion: (value) => {
        version = VERSIONS.has(value) ? value : "unknown";
        transport.setProtocolVersion?.(value);
      },
      setSupportedProtocolVersions: (values) =>
        transport.setSupportedProtocolVersions?.(values),
      send: async (message, options) => {
        const id =
          "id" in message && !("method" in message) ? message.id : undefined;
        const call = id === undefined ? undefined : pending.get(id);
        const send = async () => {
          try {
            await transport.send(message, options);
            if (id !== undefined) finish(id, message);
          } catch (cause) {
            if (id !== undefined) finish(id, undefined, cause);
            throw cause;
          }
        };
        return call ? context.with(call.ctx, send) : send();
      },
    };
    transport.onmessage = (message, extra) => {
      if (!("method" in message)) {
        wrapper.onmessage?.(message, extra);
        return;
      }
      if (!("id" in message)) {
        const requestId = object(message.params).requestId;
        if (
          message.method === "notifications/cancelled" &&
          version !== "2026-07-28" &&
          (typeof requestId === "number" || typeof requestId === "string")
        )
          cancel(requestId);
        const method = [
          "notifications/initialized",
          "notifications/cancelled",
          "notifications/progress",
        ].includes(message.method)
          ? message.method
          : "_OTHER";
        // SDK schedules handlers asynchronously. This span describes receipt and
        // dispatch only; any application notification handler owns its own span.
        context.with(hostContext, () =>
          withSpanSync(
            "mcp.notification.dispatch",
            () => wrapper.onmessage?.(message, extra),
            { "mcp.method.name": method },
          ),
        );
        return;
      }
      const id = message.id;
      if (pending.has(id)) {
        pending.get(id)?.capture?.incomplete("duplicate_request_id");
        pending.get(id)?.span.setAttribute("eve.telemetry.incomplete", true);
        wrapper.onmessage?.(message, extra);
        return;
      }
      const method = METHODS.has(message.method) ? message.method : "_OTHER";
      const params = object(message.params),
        proposedTool = params.name;
      const modernVersion = object(params._meta)[
        "io.modelcontextprotocol/protocolVersion"
      ];
      if (typeof modernVersion === "string" && VERSIONS.has(modernVersion))
        version = modernVersion;
      const tool =
        method === "tools/call"
          ? typeof proposedTool === "string" && TOOL_NAMES.has(proposedTool)
            ? proposedTool
            : "_OTHER"
          : "";
      if (method === "initialize" && typeof params.protocolVersion === "string")
        version = VERSIONS.has(params.protocolVersion)
          ? params.protocolVersion
          : "unknown";
      const input = projectInput(params.arguments ?? {}, this.knownOperation);
      const incoming = remoteSpan(object(params._meta).traceparent);
      const ambient = trace.getSpanContext(hostContext);
      // Public context is only a link: an unsampled caller cannot suppress local diagnostics.
      const parent =
        incoming && this.trustedTraceContext
          ? trace.setSpanContext(hostContext, incoming)
          : incoming
            ? trace.deleteSpan(hostContext)
            : hostContext;
      const links =
        incoming && !this.trustedTraceContext ? [{ context: incoming }] : [];
      if (
        incoming &&
        ambient &&
        (incoming.traceId !== ambient.traceId ||
          incoming.spanId !== ambient.spanId)
      )
        links.push({ context: ambient });
      const span = context.with(hostContext, () =>
        getTracer().startSpan(
          tool ? `${method} ${tool}` : method,
          {
            kind: SpanKind.SERVER,
            links,
            attributes: {
              "mcp.method.name": method,
              "mcp.protocol.version": version,
              "eve.trace.parent_source": incoming
                ? this.trustedTraceContext
                  ? "mcp_meta"
                  : "untrusted_link"
                : ambient
                  ? "transport"
                  : "local_root",
              "eve.input.complete": input.complete,
              ...input.attributes,
              ...(tool
                ? {
                    "gen_ai.tool.name": tool,
                    "gen_ai.operation.name": "execute_tool",
                  }
                : {}),
              ...(typeof id === "number" && Number.isSafeInteger(id)
                ? { "jsonrpc.request.id": id }
                : { "eve.request.id_kind": typeof id }),
            },
          },
          parent,
        ),
      );
      const controller = new AbortController(),
        activities = new Set<Promise<void>>();
      let ctx = operationContext(
        spanContext(span, parent),
        activities,
        controller.signal,
      );
      const captureConfig = context.with(hostContext, captureOptions);
      const capture =
        captureConfig && tool
          ? new DiagnosticCapture(
              captureConfig,
              { method, tool, arguments: input.value },
              input.complete,
            )
          : undefined;
      if (capture) ctx = captureContext(capture, ctx);
      let done = () => {
        /* Assigned synchronously by the Promise executor. */
      };
      const completion = new Promise<void>((resolve) => {
        done = resolve;
      });
      context.with(hostContext, () => {
        trackCompletion(completion);
      });
      pending.set(id, {
        span,
        ctx,
        start: Date.now(),
        method,
        tool,
        done,
        controller,
        activities,
        cleanup: () => {
          extra?.request?.signal.removeEventListener("abort", abort);
        },
        ...(capture ? { capture } : {}),
      });
      const abort = () => {
        cancel(id);
      };
      if (version === "2026-07-28" && transport.hasPerRequestStream) {
        extra?.request?.signal.addEventListener("abort", abort, { once: true });
        if (extra?.request?.signal.aborted) cancel(id);
      }
      try {
        context.with(ctx, () => wrapper.onmessage?.(message, extra));
      } catch (cause) {
        finish(id, undefined, cause);
        throw cause;
      }
    };
    transport.onerror = (error) => wrapper.onerror?.(error);
    transport.onclose = () => {
      for (const id of pending.keys())
        finish(id, undefined, new Error("Transport closed"));
      wrapper.onclose?.();
    };
    await super.connect(wrapper);
  }
}
