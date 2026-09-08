import { createEveServer as createSharedEveServer } from "../src/server.js";
import type { OperationCatalog } from "../src/openapi.js";
import type { EsiClient } from "../src/esi-client.js";
import type { CharacterAuthentication } from "../src/character-authentication.js";
import type { StaticDataSource } from "../src/static-data.js";
import { fixtureSource } from "./skill-fixtures.js";
export function createEveServer(
  catalog: OperationCatalog,
  client: EsiClient,
  authentication?: CharacterAuthentication,
  staticData: StaticDataSource = fixtureSource(),
) {
  return createSharedEveServer(catalog, client, {
    identity: { name: "eve-online-mcp", version: "0.0.0" },
    staticData,
    ...(authentication ? { authentication } : {}),
  });
}
