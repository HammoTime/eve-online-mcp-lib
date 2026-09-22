import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/** Use the SDK's public Standard Schema interface to share repeated definitions
 * within each advertised contract. Runtime validation remains the original Zod
 * validator; references are local to this schema, never external URLs.
 */
export function compactOutputSchema<T extends z.ZodType>(
  schema: T,
): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  const convert = (io: "input" | "output", target: string) => {
    if (
      target !== "draft-07" &&
      target !== "draft-2020-12" &&
      target !== "openapi-3.0"
    )
      throw new Error("Unsupported JSON Schema target");
    return z.toJSONSchema(schema, { io, target, reused: "ref" });
  };
  return {
    "~standard": {
      ...schema["~standard"],
      jsonSchema: {
        input: ({ target }) => convert("input", target),
        output: ({ target }) => convert("output", target),
      },
    },
  };
}
