import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { compactOutputSchema } from "../src/output-schema.js";

describe("compact output contracts", () => {
  it.each(["draft-07", "draft-2020-12", "openapi-3.0"] as const)(
    "honors %s while retaining the original validator",
    async (target) => {
      const row = z.object({
        id: z.number().int().positive(),
        tags: z.array(z.string()),
      });
      const original = z.object({ first: row, second: row });
      const schema = compactOutputSchema(original)["~standard"];
      for (const io of ["input", "output"] as const) {
        const json = schema.jsonSchema[io]({ target });
        expect(json.type).toBe("object");
        expect(JSON.stringify(json)).toContain("$ref");
        expect(JSON.stringify(json)).not.toContain('"$ref":"http');
      }
      expect(
        await schema.validate({
          first: { id: -1, tags: [] },
          second: { id: 1, tags: [] },
        }),
      ).toHaveProperty("issues");
      expect(
        await schema.validate({
          first: { id: 1, tags: [] },
          second: { id: 2, tags: [] },
        }),
      ).toHaveProperty("value");
      expect(() =>
        schema.jsonSchema.output({ target: "unsupported" as never }),
      ).toThrow("Unsupported");
    },
  );
});
