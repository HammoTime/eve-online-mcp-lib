# EVE Online MCP library

Shared, runtime-independent TypeScript source for the local `eve-online-mcp`
application and the future `eve-online-hosted-mcp` Workers service. This public
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

Applications supply `@modelcontextprotocol/server`, `jose`, and `zod` using the
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
freshness status for a plan. A D1 adapter and the four-hour ETag-only update check
will be implemented in the hosted application in the next stage. They are not
implemented here.

## Development

Use `.devcontainer/devcontainer.json`, or the equivalent Docker environment:

```sh
docker build --target development -f .devcontainer/Dockerfile -t eve-online-mcp-lib-dev .
docker run --rm --user node -v "$PWD:/workspace" -w /workspace eve-online-mcp-lib-dev sh -lc "npm ci && npm run validate"
```

Validation includes formatting, strict lint, typechecking, runtime compilation
without Node globals, coverage tests, a browser-target bundle check, and a build.
Publish library commits before updating a consumer's Git submodule pointer.
