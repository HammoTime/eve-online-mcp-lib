import * as z from "zod/v4";
import { EsiRequestError } from "./esi-client.js";
import type { JsonValue } from "./types.js";

export const MODEL_RESULT_BYTES = 24_000;
export const MODEL_DATA_BYTES = 8_000;
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const responseSelectionSchema = z
  .object({
    path: z.array(z.string().max(256)).max(16).optional(),
    offset: index.default(0),
    limit: z.number().int().min(1).max(25).default(25),
    snapshot: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();
export type ResponseSelection = z.input<typeof responseSelectionSchema>;
export const responseOutputSchema = z.object({
  path: z.array(z.string()),
  kind: z.enum(["array", "object", "string", "scalar"]),
  offset: index,
  total: index,
  returned: index,
  complete: z.boolean(),
  nextOffset: index.nullable(),
  snapshot: z.string(),
  byteLimit: index,
  omitted: z.array(
    z.object({
      path: z.array(z.string()),
      kind: z.enum(["array", "object", "string", "scalar"]),
      total: index,
    }),
  ),
});
export const jsonPageSchema = z.object({
  data: z.json(),
  output: responseOutputSchema,
});
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function invalid(message: string): never {
  throw new EsiRequestError(message, undefined, undefined, {
    code: "VALIDATION_ERROR",
    retryable: false,
  });
}
function kind(value: JsonValue): "array" | "object" | "string" | "scalar" {
  return Array.isArray(value)
    ? "array"
    : value !== null && typeof value === "object"
      ? "object"
      : typeof value === "string"
        ? "string"
        : "scalar";
}
function size(value: JsonValue): number {
  return Array.isArray(value)
    ? value.length
    : value !== null && typeof value === "object"
      ? Object.keys(value).length
      : typeof value === "string"
        ? Array.from(value).length
        : 1;
}
function hasLargeArray(value: JsonValue, limit: number, depth = 0): boolean {
  if (depth >= 16 && value !== null && typeof value === "object") return true;
  if (Array.isArray(value))
    return (
      value.length > limit ||
      value.some((item) => hasLargeArray(item, limit, depth + 1))
    );
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).some((item) => hasLargeArray(item, limit, depth + 1))
  );
}

/** Stateless slices: the caller repeats the original inputs, and authorization runs
 * again before this helper. A digest detects changed evidence; it is not a grant.
 * Oversized members are described, never silently truncated or replaced by null.
 */
export async function pageJson(
  value: unknown,
  selection: ResponseSelection = {},
  byteLimit = MODEL_DATA_BYTES,
  identity: unknown = null,
) {
  const parsed = responseSelectionSchema.parse(selection);
  const input = { ...parsed, path: parsed.path ?? [] };
  // Domain results contain optional undefined properties; normalize just as the
  // MCP JSON transport does, without retaining host objects or prototypes.
  const root = JSON.parse(JSON.stringify(value)) as JsonValue;
  const snapshot = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([root, identity])),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (input.snapshot !== undefined && input.snapshot !== snapshot)
    invalid(
      "Response snapshot changed. Restart at offset 0 without snapshot; do not combine these slices.",
    );
  if (input.offset > 0 && input.snapshot === undefined)
    invalid("Continuation offsets require the previous output.snapshot.");
  let selected = root;
  for (const key of input.path) {
    if (
      selected === null ||
      typeof selected !== "object" ||
      !Object.hasOwn(selected, key) ||
      (Array.isArray(selected) && !/^(0|[1-9][0-9]*)$/u.test(key))
    )
      invalid("Response path must select an existing own JSON member.");
    const member = (selected as Record<string, JsonValue>)[key];
    if (member === undefined) invalid("Response path has no JSON value.");
    selected = member;
  }
  const total = size(selected);
  if (input.offset > total)
    invalid("Response offset exceeds the selected value.");
  const omitted: z.infer<typeof responseOutputSchema>["omitted"] = [];
  let returned = 0;
  let consumed = 0;
  let data: JsonValue;
  if (
    Array.isArray(selected) ||
    (selected !== null && typeof selected === "object")
  ) {
    const array = Array.isArray(selected);
    const entries = Object.entries(selected).slice(
      input.offset,
      input.offset + input.limit,
    );
    const rows: JsonValue[] = [];
    const fields: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    let used = 2;
    for (const [key, item] of entries) {
      const cost =
        jsonBytes(item) +
        (array ? 0 : jsonBytes(key) + 1) +
        (returned > 0 ? 1 : 0);
      if (used + cost > byteLimit || hasLargeArray(item, input.limit)) {
        // An array stays a consecutive prefix. Retrieve an oversized first row
        // through its path, or continue a normal page from nextOffset.
        if (array) {
          if (returned === 0) {
            omitted.push({
              path: [...input.path, key],
              kind: kind(item),
              total: size(item),
            });
            consumed = 1;
          }
          break;
        }
        omitted.push({
          path: [...input.path, key],
          kind: kind(item),
          total: size(item),
        });
      } else {
        if (array) rows.push(item);
        else
          Object.defineProperty(fields, key, { value: item, enumerable: true });
        used += cost;
        returned++;
      }
      consumed++;
    }
    data = array ? rows : fields;
  } else if (typeof selected === "string") {
    const characters = Array.from(selected);
    const chunk: string[] = [];
    let used = 2;
    for (const character of characters.slice(input.offset)) {
      const cost = jsonBytes(character) - 2;
      if (used + cost > byteLimit) break;
      chunk.push(character);
      used += cost;
    }
    data = chunk.join("");
    consumed = returned = chunk.length;
  } else {
    if (input.offset !== 0) invalid("Scalar responses require offset 0.");
    data = selected;
    consumed = returned = 1;
  }
  return {
    data,
    output: {
      path: input.path,
      kind: kind(selected),
      offset: input.offset,
      total,
      returned,
      complete:
        input.offset === 0 && returned === total && omitted.length === 0,
      nextOffset:
        consumed > 0 && input.offset + consumed < total
          ? input.offset + consumed
          : null,
      snapshot,
      byteLimit,
      omitted,
    },
  };
}
