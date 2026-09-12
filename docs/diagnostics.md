# Diagnostic capture and offline replay

MCP response metadata includes `eve/trace-id`. Find that trace in the configured
OTLP backend, then inspect its SERVER span (`tools/call get_market_snapshot`, for
example). Child spans describe tool, domain, validation, cache, authentication and
dependency calls. HTTP spans include response-body consumption. The MCP span ends
after transport send completes. A successful partial result has `eve.outcome=partial`
and UNSET status; its failed dependency retains its own ERROR status and safe code.

## Evidence contract

| Evidence       | Fields                                                                           |
| -------------- | -------------------------------------------------------------------------------- |
| Caller intent  | `mcp.method.name`, `gen_ai.tool.name`, reviewed `eve.input.*`                    |
| Interpretation | effective limits, queue policy, resolved public type IDs, graph counts           |
| Decisions      | cache hit/partition/expiry, requested scopes count, pagination and stop reason   |
| State          | recorded clocks, ordered dependency observations, public SDE build and digest    |
| Outcome        | `eve.outcome`, reviewed `eve.output.*`, `eve.error.code`, origin span ID         |
| Identity       | `eve.version.server`, `eve.version.library`, `eve.version.openapi`               |
| Replay         | `eve.replay.status`, reasons, artifact ID, and correlated capture completion log |

The source of truth for allowed values is `src/diagnostic-policy.ts` and
`src/diagnostics.ts`. Unknown fields and malformed values fail closed. Arbitrary
field names, free-text targets, credentials, authorization headers, OAuth state,
private character IDs/progress/queues and private structure IDs are not copied.
Reviewed NPC station IDs and public type/region IDs are allowed. Generic errors
use stable codes and the originating function span; raw messages and stacks are
excluded. A UUID independent of OAuth state correlates hosted browser flows.

External trace context is linked to a locally sampled trace. Owned service bindings
may propagate a parent. MCP `_meta.traceparent` takes precedence over transport
context, and conflicting transport context is linked. Baggage is never propagated.
ESI, SSO and identity providers do not receive owned trace context.

## Replay readiness

`exact` means a supported MCP boundary has complete reviewed inputs, dependency
evidence and immutable versions. **Also require `diagnostic.capture_complete`**:
the span's artifact ID is a proposed location, not confirmation that storage worked.
`diagnostic.capture_failed` means the artifact is unavailable. `partial` includes
explicit reasons such as redacted input/body, missing cache state, cancellation,
unsupported adapter, missing versions, transport failure or capture limits.
Never relabel a partial capture as exact to make replay run.

Query-backed static-data readers may not expose a complete catalog artifact.
Those calls are explicitly partial (`catalog_artifact_unavailable`); the local
SQLite adapter does not reconstruct the full catalog or capture personalized
skill-lookup footprints as public evidence. Initialization failures are marked
`static_catalog_unavailable`. Existing full-catalog snapshots and replay adapters
remain supported, but these partial captures are not exact-replay inputs.

Exact adapters cover `get_market_snapshot`, `call_esi` for the reviewed public
regional market response policy, `get_skill_dependencies`, numeric-ID
`resolve_skill_plan_targets`, and cached `initialize_static_data`. Public market
bodies are retained only if every field is reviewed; private structure IDs cause
the entire body to be omitted. Cache hits without an initial cache fixture remain
partial. Forced SDE refresh needs live adapter state and remains partial. Other
tools still emit diagnostic context, but do not claim exact replay.

Public SDE catalogs are content-addressed snapshots, separate from raw import
archives. Dependency bodies above 16 KiB use content-addressed artifacts when the
host provides that sink. Replay verifies SHA-256 digests, loads the pinned OpenAPI
document and executes through the real MCP server using an in-memory transport.
It rejects unrecorded/out-of-order requests, missing catalogs, unconsumed clocks,
changed observable outputs and attempts to use protected authentication.

Private failures can instead use reviewed synthetic fixtures. These reproduce a
rule at the domain boundary with stand-ins, not the original private state. Five
fixtures cover queue timestamp order, completed-level conflict, queue SP threshold,
duplicate trained-skill evidence and inconsistent SP baseline.

## Operator commands

Run in the consumer's devcontainer with its captured library revision checked out:

```sh
npm run diagnostics:export -- --trace-id <32-hex-id> --env dev --out /tmp/eve-replay
npm run diagnostics:replay -- /tmp/eve-replay/manifest.json
```

For local captures, replace `--env dev` with `--from /path/to/diagnostics`.
Use `--env prod` explicitly for production. Hosted export uses the operator's
existing Wrangler/R2 authorization; it never exposes an anonymous download URL.
The export includes the manifest, its digest, pinned schema and referenced safe
artifacts. Preserve the capture-completion digest from the trace to verify the
exported manifest. Run replay in a fresh container with network disabled after
installing dependencies and checking out the recorded revisions.

```sh
npm run diagnostics:replay -- --synthetic QUEUE_TIME_ORDER
```

No capture contains an executable command, arbitrary URL or production credential.
The replay CLI disables global fetch and injected dependencies only accept the
recorded read-only ESI operation sequence. `replay-result.json` records assertions
and the reproduced safe result. Do not run a capture as a shell script.

## Delivery and retention

The SDK adapter bounds each window/request to 1,024 admitted spans (960 ordinary
slots, reserving room for roots), 64 span attributes, 32 events and 1 KiB strings.
Serialized spans have a 256 KiB budget; ordinary spans stop at 192 KiB. Individual
logs are at most 8 KiB, total logs 128 KiB, with 32 KiB reserved for exceptions and
artifact completion/failure records. Metrics have cardinality 128 and explicit
duration histogram buckets with delta temporality. Dropped records increment
`eve.telemetry.dropped` and mark active roots incomplete.

OTLP batches are at most 256 KiB, with two concurrent sends, five seconds per
attempt, at most two attempts, and a 12-second flush deadline. HTTP 200 partial
success is checked and never retried as an entire accepted batch. Export failures
cannot alter application results. Diagnostic manifests retain at most 100
dependencies and 768 KiB inline evidence; external dependency bodies total at most
8 MiB per call. Catalog artifacts are at most 8 MiB each, at most ten references.
Hosted pending artifact bytes are capped at 16 MiB and providers at 16 per isolate.

Workers export after logical request work and artifact writes settle, using the
host lifecycle. Node exports every five seconds and flushes on EOF/SIGINT/SIGTERM.
The host owns retention: hosted diagnostic R2 has a 14-day lifecycle; raw SDE import
staging retains its separate cleanup policy. Local files use private filesystem
modes; export bundles are operator-controlled and must be deleted when no longer
needed. Telemetry is best effort, and missing/dropped artifacts are never evidence
that an operation did not run.

## Acceptance checks

`npm run validate` in the library covers privacy canaries, real SDK OTLP payloads,
bounded admission, delta histograms, public market MCP replay, catalog graph replay
and synthetic private rules. Consumer validation also runs actual bundled Workers
against a local OTLP collector and the packaged stdio process on EOF and SIGTERM.
Deployment acceptance must additionally check the selected deployed revision,
actual backend ingestion, artifact completion and offline replay from that
environment; local fixtures do not establish production ingestion or latency.
