# EVE Online MCP library

Shared, runtime-independent TypeScript source for the local `eve-online-mcp`
application and the `eve-online-hosted-mcp` Workers service. This public
repository is consumed as a Git submodule pinned to a reviewed commit, not as an
independently published npm package. Licensed AGPL-3.0-only; extracted from
`HammoTime/eve-online-mcp` at `05ca567`.

## Runtime boundary

- `src/openapi.ts` owns the read-only operation catalog and manually reviewed
  safe POST allowlist; `openapi/esi-openapi.json` is the canonical pinned schema.
- `src/esi-client.ts` owns validated ESI requests, response limits, pagination,
  freshness metadata and bounded per-client caching. Protected cache keys vary
  by a SHA-256 digest of the access token. Public requests never obtain tokens.
- `src/auth.ts` and `src/token-identity.ts` provide token contracts, refresh and
  rotation callbacks, scope inspection, and verified EVE SSO identities.
- `src/server.ts` registers transport-independent MCP tools/resources/prompts.
- `src/tool-output-schemas.ts` describes the structured results of the 13 core
  tools, including host authorization, partial workflows and source metadata.
- Skill catalogs, dependency graphs, planning, entity resolution, character
  context and market snapshots are shared here.

The runtime uses Web APIs and has no Node filesystem, process, HTTP listener,
browser-launch, or Cloudflare binding dependency. File loading, SSO callbacks,
credential persistence, archive extraction, scheduling, and static-data storage
belong to each application. Schema maintenance scripts currently live in the
local application and update this submodule's pinned document.

## Integration

```sh
git submodule add https://github.com/HammoTime/eve-online-mcp-lib.git lib
git submodule update --init --recursive
```

Import the source directly and compile/bundle it with your application:

```ts
import { OperationCatalog } from "./lib/src/openapi.js";
import { EsiClient } from "./lib/src/esi-client.js";
import { createEveServer } from "./lib/src/server.js";

const catalog = new OperationCatalog(pinnedDocument);
const client = new EsiClient(catalog, sessionTokenProvider, {
  userAgent: "my-eve-service/1.0 (contact@example.com)",
});
const server = createEveServer(catalog, client, {
  identity: { name: "my-eve-service", version: "1.0.0" },
  authentication: sessionCharacterAuthentication,
  staticData: applicationStaticDataSource,
});
```

Applications supply `@modelcontextprotocol/server`, `@opentelemetry/api`, `jose`, and `zod` using the
compatible ranges in `package.json`. The `.js` imports resolve to `.ts` source
during TypeScript compilation. Build the submodule with the consumer; no npm
workspace, sibling checkout, or separately published artifact is required.

Create a separate `EsiClient`, token provider, authentication adapter and MCP
server for each user session. Never use a global mutable default character or
credential store across users. Authorization handles are bound to their client
instance. The in-memory ESI cache is instance-local and credential-sensitive;
this library does not provide persistent Workers caching or hosted sessions.
Refresh providers must receive an identity-verification callback and a durable
rotation callback in authenticated applications.

`StaticDataSource.initialize()` returns one validated `SkillCatalog` and its
freshness status for a plan. The hosted application supplies the D1 adapter,
full-SDE import workflow and four-hour ETag check.

## Tool output contracts

All 13 core tools advertise an `outputSchema` in `tools/list`. These are success
contracts for the existing `structuredContent` object, not new result wrappers.
Every schema explicitly has an object root, including the alternative local and
hosted authorization results and the skill planner's target-selection results.
This prevents the SDK's older-protocol projection from adding a `{ result: ... }`
envelope. The optional `render_eve_map` extension retains its separate schema.

The schemas describe character lists, target candidates, dependency graphs,
training plans, operation discovery/invocation metadata, entity matches,
character sections and bounded market aggregates. `call_esi.data` and successful
character-section data accept any JSON value, including arrays, scalar wallet
balances, strings (also used for non-JSON upstream text) and null. Upstream JSON
schemas, rate-limit extensions and host refresh progress are also JSON-valued,
not restricted to a guessed ESI payload shape. Source freshness, nullable page
counts, pagination next-call arguments, warnings and caveats are retained.

Static-data status belongs to the host adapter. Its known fields are typed but
optional; additional JSON status fields are allowed. Local cache paths/counts
are not required from hosted adapters, and hosted `checkedAt` can be null.
Local authorization returns the same character-list object as list/select;
hosted authorization returns `status: "authorization_required"`, a browser URL,
the requested character ID and a message, without claiming consent completed.

`isError: true` results keep the existing error body; the SDK skips success-schema
validation for those results. A wholly failed character context is also a tool
error. Partial character contexts, incomplete market snapshots and
`needs_target_selection` plans are **not** tool errors and satisfy their success
contracts. Always inspect section errors, completeness and freshness before
treating a response as evidence. Output schemas do not change access controls,
upstream response validation or diagnostic capture policy.

Core handlers still return their pretty-printed JSON text fallback, identical to
`JSON.stringify(structuredContent, null, 2)`. SDK input/output validation failures
remain SDK-generated text errors. Diagnostic and hosted OAuth challenge metadata
remain on the MCP result's `_meta`, outside the output schema.
Contract tests use the actual SDK over legacy in-memory transports and a modern
Streamable HTTP client connected to the SDK's per-request HTTP handler through
an in-process fetch adapter. They validate the advertised JSON Schemas as well
as the Zod contracts, and check malformed outputs and unchanged text/error
delivery across legacy and modern protocol revisions.
They also sweep every pinned read-only operation through search and inspection,
and check that SDK output-validation errors and telemetry do not echo malformed
private result values.

## OpenTelemetry and hosted authorization

The library uses only the OpenTelemetry API. With no SDK it is a no-op; the host
owns the context manager, exporter, sampling and lifecycle. MCP tool/resource/
prompt handlers, ESI calls and network requests, token refresh, static parsing,
entity resolution, market and character summaries, skill graphs and plans emit
spans. Closed field projections record reviewed public inputs, effective limits,
branch decisions, clocks, output counts and stable error codes. Credentials,
private character state, free text and raw exception messages remain excluded.
Operation metrics use fixed names and bounded labels.

Hosts with a process-wide SDK can use its global tracer. Workers can bind a
per-invocation tracer with `withTracer(tracer, operation)` from `src/telemetry.ts`.
That tracer follows the active OpenTelemetry context through async operations,
so service bindings and durable workflow steps can preserve W3C parent context.
Configure a metrics provider in the host to enable the library's metric instruments.
The library never initializes an SDK or exports data itself.

The optional `adapters/telemetry-runtime.ts` supplies a bounded SDK implementation
for hosts. It provides real delta metrics, correlated OTLP logs, and diagnostic
artifact hooks. See [diagnostic capture and offline replay](docs/diagnostics.md)
for the evidence contract, limits, supported replay boundaries and commands.

`createEveServer` accepts `hostedAuthorizationUrl` to add MCP OAuth challenge
metadata to auth errors. A hosted character adapter may return
`status: "authorization_required"` and a browser URL instead of starting a local
browser. Existing local adapters remain compatible. `call_esi.actingCharacterId`
selects credentials for protected operations that lack a character path parameter;
it is validated separately and is never forwarded as an ESI parameter.

## Development

Use `.devcontainer/devcontainer.json`, or the equivalent Docker environment:

```sh
docker build --target development -f .devcontainer/Dockerfile -t eve-online-mcp-lib-dev .
docker run --rm --user node -v "$PWD:/workspace" -w /workspace eve-online-mcp-lib-dev sh -lc "npm ci && npm run validate"
```

Validation includes formatting, strict lint, typechecking, runtime compilation
without Node globals, coverage tests, a browser-target bundle check, and a build.
Publish library commits before updating a consumer's Git submodule pointer.

## Cartography extension

Optional `cartography` services in `createEveServer` register `render_eve_map` and
artifact resource templates. The shared `src/cartography` core is runtime-independent;
consumers supply public SDE map data, private artifact storage and optionally a PNG
preview adapter. It is a renderer only: `boundary` and `pointsOfInterest` are required,
and supplied route sequences are validated without planning, repair or expansion.
There is no ESI/planner/auth dependency in the renderer or its registration module.
Request `boundary: { kind: "neighborhood", center: "Jita", jumps: 1 }` directly
for a center and all its distinct incoming/outgoing permanent-stargate neighbors
from validated SDE, without an ESI discovery chain. Names/IDs use the existing exact
reference resolver. `jumps` defaults to `1`; other values are rejected. Selection
never expands POIs/routes or a second hop, and the existing 250-system limit fails
with the complete count rather than trimming the neighborhood.
Absent adapters leave existing consumers unchanged. Never expose stored artifacts
across users without an owner-scoped adapter; base geography being public does not
make caller-authored plans public.
