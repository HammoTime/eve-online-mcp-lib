import { attributes, diagnostic, withSpan } from "./telemetry.js";
import * as z from "zod/v4";
import {
  decodeRequirements,
  type StaticCatalog,
  type StaticType,
  typeId,
  validateCatalog,
} from "./skill-data.js";

export async function* jsonLines(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator {
  const decoder = new TextDecoder();
  let bytes = 0;
  let remaining = "";
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error("Static data exceeds byte limit");
    remaining += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = remaining.indexOf("\n")) >= 0) {
      const line = remaining.slice(0, index).trim();
      remaining = remaining.slice(index + 1);
      if (line.length > 2_000_000)
        throw new Error("SDE record exceeds line limit");
      if (line) yield JSON.parse(line) as unknown;
    }
    if (remaining.length > 2_000_000)
      throw new Error("SDE record exceeds line limit");
  }
  remaining += decoder.decode();
  if (remaining.trim()) yield JSON.parse(remaining) as unknown;
}

const rawId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const groupSchema = z.object({ _key: rawId, categoryID: rawId });
export const typeSchema = z.object({
  _key: rawId,
  groupID: rawId,
  published: z.boolean(),
  name: z.object({
    en: z
      .string()
      .max(2000)
      .refine((value) => !value.includes("\0")),
  }),
});
const dogmaSchema = z.object({
  _key: typeId,
  dogmaAttributes: z
    .array(z.object({ attributeID: typeId, value: z.number() }))
    .default([]),
});

export function decodeDogma(row: unknown) {
  const type = dogmaSchema.parse(row);
  const attributes = new Map<number, number>();
  for (const attribute of type.dogmaAttributes) {
    if (attributes.has(attribute.attributeID))
      throw new Error("Duplicate SDE dogma attribute");
    attributes.set(attribute.attributeID, attribute.value);
  }
  let requirements: StaticType["requirements"] = null;
  try {
    requirements = decodeRequirements(attributes);
  } catch {
    /* Malformed slots are unavailable, not an empty prerequisite list. */
  }
  return { id: type._key, requirements, rank: attributes.get(275) ?? null };
}
export const STATIC_DATA_FILES = [
  "groups.jsonl",
  "types.jsonl",
  "typeDogma.jsonl",
];

export interface StaticDataEntry {
  name: string;
  rows: AsyncIterable<unknown>;
}

export async function parseStaticData(
  entries: AsyncIterable<StaticDataEntry>,
  metadata: Omit<StaticCatalog, "schemaVersion" | "types">,
): Promise<StaticCatalog> {
  return withSpan("eve.parseStaticData", {}, async () => {
    attributes({
      "eve.limit.records_per_file": 200_000,
      "eve.sde.build": metadata.buildNumber,
    });
    const groups = new Map<number, number>();
    const rawTypes: z.infer<typeof typeSchema>[] = [];
    const dogma = new Map<
      number,
      { requirements: StaticType["requirements"]; rank: number | null }
    >();
    const seen = new Set<string>();
    for await (const entry of entries) {
      if (!STATIC_DATA_FILES.includes(entry.name)) continue;
      if (seen.has(entry.name)) throw new Error("Duplicate SDE archive entry");
      seen.add(entry.name);
      let count = 0;
      for await (const row of entry.rows) {
        if (++count > 200_000)
          throw new Error("SDE record count exceeds limit");
        if (entry.name === "groups.jsonl") {
          const group = groupSchema.parse(row);
          if (groups.has(group._key)) throw new Error("Duplicate SDE group ID");
          groups.set(group._key, group.categoryID);
        } else if (entry.name === "types.jsonl")
          rawTypes.push(typeSchema.parse(row));
        else {
          const type = decodeDogma(row);
          if (dogma.has(type.id))
            throw new Error("Duplicate SDE dogma type ID");
          dogma.set(type.id, type);
        }
      }
    }
    diagnostic("eve.sde.parsed", {
      "eve.sde.file_count": seen.size,
      "eve.sde.group_count": groups.size,
      "eve.sde.type_count": rawTypes.length,
      "eve.sde.dogma_count": dogma.size,
    });
    if (seen.size !== STATIC_DATA_FILES.length)
      throw new Error("SDE archive is missing required files");
    const types = rawTypes
      .filter((type) => {
        const category = groups.get(type.groupID);
        if (category === undefined)
          throw new Error(`Missing SDE group ${type.groupID}`);
        return [6, 16].includes(category);
      })
      .map((type) => {
        const categoryId = groups.get(type.groupID);
        if (categoryId === undefined)
          throw new Error(`Missing SDE group ${type.groupID}`);
        const details = dogma.get(type._key);
        return {
          id: type._key,
          name: type.name.en,
          groupId: type.groupID,
          categoryId,
          published: type.published,
          requirements: details?.requirements ?? null,
          rank: details?.rank ?? null,
        };
      });
    return validateCatalog({ schemaVersion: 1, ...metadata, types });
  });
}
