import type { Attributes } from "@opentelemetry/api";

export const TOOL_NAMES = new Set([
  "initialize_static_data",
  "resolve_skill_plan_targets",
  "get_skill_dependencies",
  "generate_skill_plan",
  "list_eve_characters",
  "authorize_eve_character",
  "select_eve_character",
  "search_esi_operations",
  "get_esi_operation",
  "call_esi",
  "resolve_eve_entities",
  "get_character_context",
  "get_market_snapshot",
  "render_eve_map",
]);
const PUBLIC_NUMBERS = new Set([
  "regionId",
  "typeId",
  "maxPages",
  "limit",
  "level",
  "page",
  "region_id",
  "type_id",
  "group_id",
  "category_id",
  "system_id",
  "constellation_id",
]);
const ENUMS: Record<string, readonly string[]> = {
  queuePolicy: ["preserve", "reorder"],
  order_type: ["all", "buy", "sell"],
  category: [
    "character",
    "corporation",
    "alliance",
    "inventory_type",
    "region",
    "solar_system",
    "station",
  ],
  kind: ["skill", "ship"],
};
export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export interface Projection {
  value: Record<string, unknown>;
  complete: boolean;
  attributes: Attributes;
}
/** Closed policy: unknown keys/strings are never copied, including malformed input. */
export function projectInput(
  value: unknown,
  knownOperation: (name: string) => boolean = () => false,
  depth = 0,
): Projection {
  const result: Record<string, unknown> = {},
    attrs: Attributes = {};
  if (depth >= 4)
    return {
      value: result,
      attributes: { "eve.input.depth_limited": true },
      complete: false,
    };
  let complete =
    typeof value === "object" && value !== null && !Array.isArray(value);
  const entries = Object.entries(object(value));
  if (entries.length > 64) complete = false;
  for (const [key, item] of entries.slice(0, 64)) {
    if (key === "_meta") continue;
    let allowed = false;
    if (
      PUBLIC_NUMBERS.has(key) &&
      typeof item === "number" &&
      Number.isFinite(item)
    )
      allowed = true;
    if (key === "refresh" && typeof item === "boolean") allowed = true;
    if (
      key === "locationId" &&
      typeof item === "number" &&
      Number.isInteger(item) &&
      item >= 60000000 &&
      item < 70000000
    )
      allowed = true;
    if (
      key === "operationId" &&
      typeof item === "string" &&
      knownOperation(item)
    )
      allowed = true;
    if (typeof item === "string" && ENUMS[key]?.includes(item)) allowed = true;
    if (allowed) {
      result[key] = item;
      attrs[`eve.input.${key}`] = item as string | number | boolean;
    } else if (["path", "query", "target"].includes(key)) {
      const nested = projectInput(item, knownOperation, depth + 1);
      result[key] = nested.value;
      complete &&= nested.complete;
      for (const [name, val] of Object.entries(nested.attributes))
        attrs[`eve.input.${key}.${name.slice(10)}`] = val;
    } else if (key === "targets" && Array.isArray(item)) {
      const nested = item
        .slice(0, 50)
        .map((v) => projectInput(v, knownOperation, depth + 1));
      result[key] = nested.map((v) => v.value);
      complete &&= item.length <= 50 && nested.every((v) => v.complete);
      attrs["eve.input.targets.count"] = item.length;
    } else {
      complete = false;
      if (
        PUBLIC_NUMBERS.has(key) ||
        [
          "characterId",
          "actingCharacterId",
          "names",
          "ids",
          "sections",
          "headers",
          "body",
          "queuePolicy",
          "operationId",
          "refresh",
        ].includes(key)
      ) {
        attrs[`eve.input.${key}.present`] = true;
        attrs[`eve.input.${key}.kind`] =
          item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
        if (typeof item === "string" || Array.isArray(item))
          attrs[`eve.input.${key}.length`] = item.length;
      }
      // Arbitrary field names can also contain secrets.
      attrs["eve.input.omitted_fields"] =
        Number(attrs["eve.input.omitted_fields"] ?? 0) + 1;
    }
  }
  return { value: result, complete, attributes: attrs };
}
const OUTPUT_NUMBERS = [
  "pagesFetched",
  "observedPageCount",
  "buyOrderCount",
  "sellOrderCount",
  "buyVolumeRemaining",
  "sellVolumeRemaining",
  "highestObservedBuy",
  "lowestObservedSell",
  "observedSpread",
  "total",
  "count",
  "build",
  "buildNumber",
  "typeCount",
  "skillCount",
];
const REASONS = new Set([
  "allPagesFetched",
  "pageError",
  "byteLimit",
  "invalidPage",
  "unknownPageCount",
  "pageCountChanged",
  "maxPages",
  "inconsistentData",
]);
export function projectOutput(value: unknown, depth = 0): Attributes {
  const data = object(value),
    attrs: Attributes = {};
  if (depth > 1) return attrs;
  for (const key of OUTPUT_NUMBERS) {
    const item = data[key];
    if (typeof item === "number" && Number.isFinite(item))
      attrs[`eve.output.${key}`] = item;
  }
  for (const key of ["complete", "cached", "stale"])
    if (typeof data[key] === "boolean") attrs[`eve.output.${key}`] = data[key];
  if (typeof data.stopReason === "string" && REASONS.has(data.stopReason))
    attrs["eve.output.stopReason"] = data.stopReason;
  if (
    typeof data.status === "string" &&
    [
      "complete",
      "partial",
      "failed",
      "needs_target_selection",
      "ready",
    ].includes(data.status)
  )
    attrs["eve.output.status"] = data.status;
  for (const key of [
    "warnings",
    "sources",
    "targets",
    "rows",
    "candidates",
    "tools",
    "resources",
    "prompts",
  ])
    if (Array.isArray(data[key]))
      attrs[`eve.output.${key}.count`] = data[key].length;
  if (data.aggregates)
    Object.assign(attrs, projectOutput(data.aggregates, depth + 1));
  const graph = object(data.graph);
  if (Array.isArray(graph.nodes))
    attrs["eve.output.graph.node_count"] = graph.nodes.length;
  if (Array.isArray(graph.edges))
    attrs["eve.output.graph.edge_count"] = graph.edges.length;
  return attrs;
}
