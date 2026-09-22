import { describe, expect, it } from "vitest";
import { jsonBytes, pageJson, jsonPageSchema } from "../src/response-budget.js";
import { projectInput, projectOutput } from "../src/diagnostic-policy.js";

describe("model response slices", () => {
  it("keeps continuation evidence outside the closed diagnostic policy", () => {
    const snapshot = "a".repeat(64);
    expect(
      projectInput({ response: { path: ["private member"], snapshot } })
        .complete,
    ).toBe(false);
    expect(
      projectOutput({
        counts: { graphNodes: 30, graphEdges: 40, private: "hidden" },
        output: { snapshot, omitted: [{ path: ["private member"] }] },
      }),
    ).toEqual({
      "eve.output.graph.node_count": 30,
      "eve.output.graph.edge_count": 40,
    });
    expect(
      projectOutput({ counts: { graphNodes: -1, graphEdges: "private" } }),
    ).toEqual({});
  });
  it("reconstructs every row exactly across byte-limited consecutive pages", async () => {
    const rows = Array.from({ length: 101 }, (_, id) => ({
      id,
      label: "🚀".repeat(60),
    }));
    const collected: unknown[] = [];
    let offset = 0;
    let snapshot: string | undefined;
    do {
      const page = await pageJson(
        rows,
        { offset, ...(snapshot ? { snapshot } : {}) },
        1000,
      );
      expect(jsonPageSchema.safeParse(page).success).toBe(true);
      expect(jsonBytes(page.data)).toBeLessThanOrEqual(1000);
      expect(page.output.returned).toBeGreaterThan(0);
      expect(page.output.returned).toBeLessThanOrEqual(25);
      expect(page.output.omitted).toEqual([]);
      collected.push(...(page.data as unknown[]));
      snapshot = page.output.snapshot;
      offset = page.output.nextOffset ?? -1;
    } while (offset !== -1);
    expect(collected).toEqual(rows);
  });

  it("describes nested collections and oversized rows without silently substituting empty facts", async () => {
    const rows = [
      { attackers: Array.from({ length: 100 }, (_, id) => id), ship: 34 },
      { ship: 35 },
    ];
    const first = await pageJson(rows);
    expect(first).toMatchObject({
      data: [],
      output: {
        complete: false,
        total: 2,
        returned: 0,
        nextOffset: 1,
        omitted: [{ path: ["0"], kind: "object", total: 2 }],
      },
    });
    const detail = await pageJson(rows, {
      path: ["0"],
      snapshot: first.output.snapshot,
    });
    expect(detail).toMatchObject({
      data: { ship: 34 },
      output: {
        complete: false,
        omitted: [{ path: ["0", "attackers"], total: 100 }],
      },
    });
    const attackers = await pageJson(rows, {
      path: ["0", "attackers"],
      snapshot: first.output.snapshot,
    });
    expect(attackers.output).toMatchObject({
      returned: 25,
      nextOffset: 25,
      total: 100,
    });
    const second = await pageJson(rows, {
      offset: 1,
      snapshot: first.output.snapshot,
    });
    expect(second.data).toEqual([{ ship: 35 }]);
  });

  it("keeps scalar metadata when a large skills array is omitted", async () => {
    const result = await pageJson({
      skills: Array.from({ length: 500 }, (_, skill_id) => ({ skill_id })),
      total_sp: 1000,
    });
    expect(result).toMatchObject({
      data: { total_sp: 1000 },
      output: {
        complete: false,
        omitted: [{ path: ["skills"], kind: "array", total: 500 }],
      },
    });
  });

  it("round-trips escaped Unicode strings in complete JSON chunks", async () => {
    const original = '🚀\n"\\中'.repeat(2000);
    let text = "";
    let page = await pageJson(original, {}, 101);
    while (text.length < original.length) {
      expect(jsonBytes(page.data)).toBeLessThanOrEqual(101);
      if (typeof page.data !== "string") throw new Error("Expected text chunk");
      text += page.data;
      if (page.output.nextOffset === null) break;
      page = await pageJson(
        original,
        { offset: page.output.nextOffset, snapshot: page.output.snapshot },
        101,
      );
    }
    expect(text).toBe(original);
  });

  it("rejects changed data, changed identity, invalid offsets and missing snapshot guards", async () => {
    const first = await pageJson([1, 2], { limit: 1 }, undefined, 42);
    await expect(
      pageJson(
        [1, 3],
        { offset: 1, snapshot: first.output.snapshot },
        undefined,
        42,
      ),
    ).rejects.toThrow("snapshot changed");
    await expect(
      pageJson(
        [1, 2],
        { offset: 1, snapshot: first.output.snapshot },
        undefined,
        43,
      ),
    ).rejects.toThrow("snapshot changed");
    await expect(pageJson([1, 2], { offset: 1 })).rejects.toThrow("require");
    await expect(
      pageJson(
        [1, 2],
        { offset: 3, snapshot: first.output.snapshot },
        undefined,
        42,
      ),
    ).rejects.toThrow("exceeds");
    const scalar = await pageJson(false);
    await expect(
      pageJson(false, { offset: 1, snapshot: scalar.output.snapshot }),
    ).rejects.toThrow("Scalar");
    await expect(pageJson([], { limit: 26 })).rejects.toThrow();
  });

  it("uses own JSON members, including prototype-like keys, without inherited traversal", async () => {
    const root = JSON.parse(
      '{"__proto__":{"secret":"safe fixture"},"constructor":0}',
    ) as unknown;
    const result = await pageJson(root);
    expect(Object.hasOwn(result.data as object, "__proto__")).toBe(true);
    expect((await pageJson(root, { path: ["__proto__", "secret"] })).data).toBe(
      "safe fixture",
    );
    for (const [value, path] of [
      [{}, ["toString"]],
      [[1], ["length"]],
      [null, ["missing"]],
      [{}, ["missing"]],
    ] as const) {
      await expect(pageJson(value, { path: [...path] })).rejects.toThrow(
        "own JSON",
      );
    }
  });

  it("pages objects and labels empty selections and depth bounds honestly", async () => {
    const first = await pageJson({ a: 1, b: null }, { limit: 1 });
    expect(first.output).toMatchObject({
      total: 2,
      returned: 1,
      nextOffset: 1,
      complete: false,
    });
    expect(
      (
        await pageJson(
          { a: 1, b: null },
          { offset: 1, snapshot: first.output.snapshot },
        )
      ).data,
    ).toEqual({ b: null });
    expect((await pageJson([])).output).toMatchObject({
      total: 0,
      returned: 0,
      complete: true,
    });
    expect((await pageJson(null)).data).toBeNull();
    expect((await pageJson(0)).data).toBe(0);
    let deep: unknown = [1];
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect((await pageJson(deep)).output.complete).toBe(false);
  });
});
