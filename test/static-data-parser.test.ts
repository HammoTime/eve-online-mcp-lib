import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { jsonLines, parseStaticData } from "../src/static-data-parser.js";
import { archiveEntries, skillFixture } from "./skill-fixtures.js";
async function* entriesFrom(entries: [string, string][]) {
  for (const [name, text] of entries)
    yield await Promise.resolve({
      name,
      rows: jsonLines(
        Readable.from([new TextEncoder().encode(text)]),
        512_000_000,
      ),
    });
}
function parse(entries: [string, string][]) {
  return parseStaticData(entriesFrom(entries), skillFixture());
}
function requiredEntry(entries: [string, string][], index: number) {
  const entry = entries[index];
  if (!entry) throw new Error("Missing test entry");
  return entry;
}
describe("portable static-data parser", () => {
  it("streams selected entries in any order, accepts raw placeholder IDs, and ignores other files", async () => {
    const result = await parse([
      ...archiveEntries().reverse(),
      ["irrelevant.jsonl", "not json"],
    ]);
    expect(result.types).toEqual([
      {
        id: 100,
        name: "Mining",
        groupId: 10,
        categoryId: 16,
        published: true,
        requirements: [],
        rank: 1,
      },
    ]);
  });
  it("decodes all requirement slots and retains unavailable ship metadata", async () => {
    const entries = archiveEntries();
    requiredEntry(entries, 0)[1] +=
      "\n" + JSON.stringify({ _key: 20, categoryID: 6 });
    requiredEntry(entries, 1)[1] +=
      "\n" +
      JSON.stringify({
        _key: 200,
        groupID: 20,
        name: { en: "Ship" },
        published: true,
      });
    expect(
      (await parse(entries)).types.find((type) => type.id === 200),
    ).toMatchObject({ requirements: null, rank: null });
    requiredEntry(entries, 2)[1] +=
      "\n" +
      JSON.stringify({
        _key: 200,
        dogmaAttributes: [
          { attributeID: 1290, value: 100 },
          { attributeID: 1288, value: 5 },
        ],
      });
    expect(
      (await parse(entries)).types.find((type) => type.id === 200)
        ?.requirements,
    ).toEqual([{ skillId: 100, level: 5 }]);
  });
  it("never converts malformed prerequisites to an empty list", async () => {
    const entries = archiveEntries();
    requiredEntry(entries, 2)[1] = JSON.stringify({
      _key: 100,
      dogmaAttributes: [
        { attributeID: 275, value: 1 },
        { attributeID: 182, value: 100 },
      ],
    });
    await expect(parse(entries)).rejects.toThrow("Incomplete skill");
    requiredEntry(entries, 2)[1] = JSON.stringify({ _key: 100 });
    await expect(parse(entries)).rejects.toThrow("Incomplete skill");
  });
  it.each([0, 1, 2])("rejects missing selected file %i", async (index) => {
    const entries = archiveEntries();
    entries.splice(index, 1);
    await expect(parse(entries)).rejects.toThrow("missing required files");
  });
  it.each([0, 1, 2])(
    "rejects duplicate records in selected file %i",
    async (index) => {
      const entries = archiveEntries();
      const entry = requiredEntry(entries, index);
      entry[1] += "\n" + entry[1];
      await expect(parse(entries)).rejects.toThrow("Duplicate");
    },
  );
  it("rejects duplicate selected entries, missing groups, invalid attributes", async () => {
    const entries = archiveEntries();
    await expect(
      parse([...entries, requiredEntry(entries, 0)]),
    ).rejects.toThrow("Duplicate SDE archive entry");
    requiredEntry(entries, 0)[1] = JSON.stringify({ _key: 99, categoryID: 16 });
    await expect(parse(entries)).rejects.toThrow("Missing SDE group");
    const duplicate = archiveEntries();
    requiredEntry(duplicate, 2)[1] = JSON.stringify({
      _key: 100,
      dogmaAttributes: [
        { attributeID: 275, value: 1 },
        { attributeID: 275, value: 1 },
      ],
    });
    await expect(parse(duplicate)).rejects.toThrow(
      "Duplicate SDE dogma attribute",
    );
  });
  it("handles split UTF-8, CRLF, blank lines and a final unterminated line", async () => {
    const data = Buffer.from('\n{"name":"Mín"}\r\n\n{"next":2}');
    const stream = Readable.from(
      Array.from(data, (byte) => Buffer.from([byte])),
    );
    const values = [];
    for await (const value of jsonLines(stream, 1000)) values.push(value);
    expect(values).toEqual([{ name: "Mín" }, { next: 2 }]);
  });
  it.each([
    ["123", 2],
    ["x".repeat(2_000_001), 3_000_000],
    ["x".repeat(2_000_001) + "\n", 3_000_000],
  ])("rejects oversized byte/line inputs %#", async (text, limit) => {
    const consume = async () => {
      for await (const value of jsonLines(
        Readable.from([Buffer.from(text)]),
        limit,
      ))
        expect(value).toBeDefined();
    };
    await expect(consume()).rejects.toThrow("limit");
  });
});
