import { readFile } from "node:fs/promises";
import type { OpenApiDocument } from "../src/types.js";
export * from "../src/openapi.js";
export async function loadOpenApiDocument(): Promise<OpenApiDocument> {
  return JSON.parse(
    await readFile(
      new URL("../openapi/esi-openapi.json", import.meta.url),
      "utf8",
    ),
  ) as OpenApiDocument;
}
