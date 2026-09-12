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
  token: symbol;
  span: Span;
  ctx: Context;
  start: number;
  method: string;
  tool: string;
  done(): void;
  controller: AbortController;
  requestSignal?: AbortSignal;
  activities: Set<Promise<void>>;
  cleanup(): void;
  capture?: DiagnosticCapture;
  response?: {
    output: ReturnType<typeof projectOutput>;
    rpcError?: number;
    toolError?: string;
  };
}
/** Public transport decorator: covers SDK validation, serialization and actual
 * send completion without reaching into MCP SDK private handler internals. */
export class ObservedMcpServer extends McpServer {
  private readonly creationContext = context.active();
  knownOperation: (name: string) => boolean = () => false;
  trustedTraceContext = false;
  /** Transport-supplied revision hint; initialize and per-request metadata take precedence. */
  protocolVersionHint: string | undefined;
  override async connect(transport: Transport): Promise<void> {
    const pending = new Map<string | number, Pending>();
    let closed = false;
    let closeDispatched = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const hostContext = telemetryContext(this.creationContext);
    let version =
      this.protocolVersionHint && VERSIONS.has(this.protocolVersionHint)
        ? this.protocolVersionHint
        : "unknown";
    const finish = (
      id: string | number,
      token: symbol,
      failure?: unknown,
      cancelled = false,
    ) => {
      const call = pending.get(id);
      if (call?.token !== token) return;
      pending.delete(id);
      if (pending.size === 0 && closeTimer !== undefined) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      call.cleanup();
      context.with(call.ctx, () => {
        let outcome = "success";
        const response = failure === undefined ? call.response : undefined;
        const output = response?.output ?? projectOutput({});
        if (
          cancelled ||
          call.controller.signal.aborted ||
          call.requestSignal?.aborted
        ) {
          outcome = "cancelled";
          call.capture?.incomplete("cancelled");
        } else if (failure !== undefined) {
          call.capture?.incomplete("transport_failure");
          recordError(failure);
          outcome = "error";
        } else if (response?.rpcError !== undefined) {
          call.span.setAttribute("rpc.response.status_code", response.rpcError);
          outcome = [-32700, -32600, -32601, -32602, -32002].includes(
            response.rpcError,
          )
            ? "rejected"
            : "error";
          if (outcome === "error")
            call.span.setAttributes({ "error.type": "rpc_error" });
        } else if (response?.toolError !== undefined) {
          outcome = "error";
          call.span.setAttributes({
            "error.type": "tool_error",
            "eve.error.code": response.toolError,
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
      // Preserve the transport outcome before stopping leftover request work.
      if (closed) call.controller.abort();
    };
    const cancel = (id: string | number) => {
      const call = pending.get(id);
      if (!call || call.controller.signal.aborted) return;
      call.controller.abort();
      const token = call.token;
      void Promise.all(call.activities).then(() => {
        finish(id, token, undefined, true);
      });
    };
    const finishClosed = () => {
      for (const [id, call] of pending)
        finish(id, call.token, new Error("Transport closed"));
    };
    // Keep only identity in promise reactions: a stuck send must not retain the
    // response payload or a removed Pending (including its diagnostic capture).
    const observeSend = (
      id: string | number,
      token: symbol,
      sent: Promise<void>,
    ) =>
      sent.then(
        () => {
          finish(id, token);
        },
        (cause: unknown) => {
          finish(id, token, cause ?? new Error("Transport send failed"));
          throw cause;
        },
      );
    const wrapper: Transport = {
      ...(transport.hasPerRequestStream === undefined
        ? {}
        : { hasPerRequestStream: transport.hasPerRequestStream }),
      get sessionId() {
        return transport.sessionId;
      },
      start: () => transport.start(),
      close: () => {
        closed = true;
        finishClosed();
        return transport.close();
      },
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
        if (id === undefined || !call || call.response)
          return transport.send(message, options);
        const result = "result" in message ? object(message.result) : {};
        call.response = {
          output: projectOutput(result.structuredContent ?? result),
          ...("error" in message ? { rpcError: message.error.code } : {}),
          ...(result.isError === true
            ? { toolError: safeErrorCode(result.structuredContent) }
            : {}),
        };
        let sent: Promise<void>;
        try {
          sent = context.with(call.ctx, () => transport.send(message, options));
        } catch (cause) {
          finish(id, call.token, cause ?? new Error("Transport send failed"));
          throw cause;
        }
        return observeSend(id, call.token, sent);
      },
    };
    transport.onmessage = (message, extra) => {
      if (closed || !("method" in message)) {
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
      const token = Symbol();
      const requestSignal =
        version === "2026-07-28" ? extra?.request?.signal : undefined;
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
        token,
        span,
        ctx,
        start: Date.now(),
        method,
        tool,
        done,
        controller,
        ...(requestSignal ? { requestSignal } : {}),
        activities,
        cleanup: () => {
          requestSignal?.removeEventListener("abort", abort);
        },
        ...(capture ? { capture } : {}),
      });
      const abort = () => {
        cancel(id);
      };
      requestSignal?.addEventListener("abort", abort, { once: true });
      if (requestSignal?.aborted) cancel(id);
      try {
        context.with(ctx, () => wrapper.onmessage?.(message, extra));
      } catch (cause) {
        finish(id, token, cause ?? new Error("Transport dispatch failed"));
        throw cause;
      }
    };
    transport.onerror = (error) => wrapper.onerror?.(error);
    transport.onclose = () => {
      if (closeDispatched) return;
      closeDispatched = true;
      closed = true;
      for (const [id, call] of pending) {
        // The HTTP transport's abort listener may run before ours.
        if (call.requestSignal?.aborted) cancel(id);
        if (call.controller.signal.aborted || !call.response)
          finish(id, call.token, new Error("Transport closed"));
      }
      // SDK per-request JSON/SSE sends queue normal close before their promise
      // reactions. Drain this turn, not just one microtask, without waiting on a
      // delayed or never-settling write after shutdown. SDK close dispatch stays
      // synchronous; tracked completion still covers the deferred diagnostics.
      if (pending.size > 0 && closeTimer === undefined)
        closeTimer = setTimeout(finishClosed, 0);
      wrapper.onclose?.();
    };
    await super.connect(wrapper);
  }
}
