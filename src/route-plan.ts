import * as z from "zod/v4";
import { mapSourceSchema } from "./cartography/catalog.js";
import {
  MapError,
  mapIdSchema,
  mapReferenceSchema,
  mapText,
} from "./cartography/types.js";

export const ROUTE_LIMITS = {
  stops: 12,
  systems: 20_000,
  pairs: 50_000,
  visits: 250,
  bytes: 64_000,
  graphBytes: 8_000_000,
} as const;
export const routeSourceSchema = mapSourceSchema
  .extend({
    checkedAt: z.union([z.iso.datetime(), z.literal("")]),
    stale: z.boolean(),
    warning: mapText(2048).optional(),
  })
  .strict()
  .refine((source) => source.checkedAt !== "" || source.stale)
  .transform(({ warning, ...source }) => ({
    ...source,
    ...(warning === undefined ? {} : { warning }),
  }));
export const routeSystemSchema = z
  .object({
    id: mapIdSchema,
    name: mapText(100),
    securityStatus: z.number().min(-1).max(1),
  })
  .strict();
export const routeRequestSchema = z
  .object({
    origin: mapReferenceSchema.describe(
      "Exact origin system name or ID; never guess IDs.",
    ),
    destination: mapReferenceSchema.describe(
      "Exact final system; use the origin again for a return loop.",
    ),
    stops: z
      .array(mapReferenceSchema)
      .max(ROUTE_LIMITS.stops)
      .default([])
      .describe(
        "All required pickup systems in one request. The server orders and combines them.",
      ),
    stopOrder: z.enum(["optimize", "as_given"]).default("optimize"),
    avoid: z.array(mapReferenceSchema).max(100).default([]),
    minimumSecurity: z
      .number()
      .min(-1)
      .max(1)
      .optional()
      .describe(
        "Minimum raw SDE security for every visited system, including endpoints. Not a rounded in-game security category or safety guarantee.",
      ),
  })
  .strict();
export type RouteRequest = z.infer<typeof routeRequestSchema>;
export const routeGraphSchema = z
  .object({
    snapshotId: z.string().min(1).max(128),
    source: routeSourceSchema,
    systemCount: z.number().int().positive().max(ROUTE_LIMITS.systems),
    gateCount: z.number().int().nonnegative().max(500_000),
    systems: z.array(routeSystemSchema).min(1).max(ROUTE_LIMITS.systems),
    // Canonical low/high endpoints and independently observed direction counts.
    pairs: z
      .array(
        z.tuple([
          mapIdSchema,
          mapIdSchema,
          z.number().int().nonnegative().max(500_000),
          z.number().int().nonnegative().max(500_000),
        ]),
      )
      .max(ROUTE_LIMITS.pairs),
  })
  .strict();
export type RouteGraph = z.infer<typeof routeGraphSchema>;
/** Assert internal lookup invariants instead of accepting missing graph evidence. */
export function routeValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new MapError(
      "ROUTE_REPLAY_FAILED",
      "Required route evidence is missing; no plan was published.",
    );
  return value;
}
export interface RouteGraphSource {
  loadRouteGraph: (signal?: AbortSignal) => Promise<RouteGraph>;
}

const planFields = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("BFS + Held-Karp"),
    objective: z.literal("minimum_jumps"),
    optimality: z.literal("exact"),
    snapshotId: z.string().min(1).max(128),
    source: routeSourceSchema,
    stopOrder: z.enum(["optimize", "as_given"]),
    origin: mapIdSchema,
    destination: mapIdSchema,
    requestedStops: z.array(mapIdSchema).max(ROUTE_LIMITS.stops),
    avoid: z.array(mapIdSchema).max(100),
    minimumSecurity: z.number().min(-1).max(1).optional(),
    systems: z.array(routeSystemSchema).min(1).max(ROUTE_LIMITS.visits),
    path: z.array(mapIdSchema).min(1).max(ROUTE_LIMITS.visits),
    stopSequence: z
      .array(mapIdSchema)
      .min(2)
      .max(ROUTE_LIMITS.stops + 2),
    legs: z
      .array(
        z
          .object({
            from: mapIdSchema,
            to: mapIdSchema,
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            jumps: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(ROUTE_LIMITS.stops + 1),
    totalJumps: z
      .number()
      .int()
      .nonnegative()
      .max(ROUTE_LIMITS.visits - 1),
  })
  .strict();
export const routePlanSchema = planFields.superRefine((plan, ctx) => {
  const systems = new Map(plan.systems.map((system) => [system.id, system]));
  const pathIds = new Set(plan.path);
  const fail = () => {
    ctx.addIssue({ code: "custom", message: "Inconsistent stored route plan" });
  };
  if (
    systems.size !== plan.systems.length ||
    systems.size !== pathIds.size ||
    plan.path.some(
      (id) =>
        !systems.has(id) ||
        plan.avoid.includes(id) ||
        routeValue(systems.get(id)).securityStatus <
          (plan.minimumSecurity ?? -1),
    ) ||
    plan.path[0] !== plan.origin ||
    plan.path.at(-1) !== plan.destination ||
    plan.stopSequence[0] !== plan.origin ||
    plan.stopSequence.at(-1) !== plan.destination ||
    plan.requestedStops.some((id) => !pathIds.has(id)) ||
    plan.totalJumps !== plan.path.length - 1 ||
    plan.legs.length !== plan.stopSequence.length - 1
  )
    fail();
  let end = 0;
  for (const [index, leg] of plan.legs.entries()) {
    if (
      leg.start !== end ||
      leg.end < leg.start ||
      leg.end >= plan.path.length ||
      leg.jumps !== leg.end - leg.start ||
      plan.path[leg.start] !== leg.from ||
      plan.path[leg.end] !== leg.to ||
      plan.stopSequence[index] !== leg.from ||
      plan.stopSequence[index + 1] !== leg.to
    )
      fail();
    end = leg.end;
  }
  if (
    end !== plan.path.length - 1 ||
    (plan.stopOrder === "as_given" &&
      JSON.stringify(plan.stopSequence) !==
        JSON.stringify([plan.origin, ...plan.requestedStops, plan.destination]))
  )
    fail();
});
export type RoutePlan = z.infer<typeof routePlanSchema>;

function failure(code: string, message: string): never {
  throw new MapError(code, message);
}

/** Validates a compact projection, not a second raw SDE import. Counts must be exact. */
export function validateRouteGraph(value: unknown): RouteGraph {
  const result = routeGraphSchema.safeParse(value);
  if (!result.success)
    failure(
      "ROUTE_DATA_INVALID",
      "The routing snapshot is invalid or exceeds its bounds.",
    );
  const graph = result.data;
  const ids = new Set(graph.systems.map((s) => s.id));
  const pairs = new Set<string>();
  let gates = 0;
  if (
    ids.size !== graph.systemCount ||
    graph.systems.length !== graph.systemCount
  )
    failure(
      "ROUTE_DATA_INCOMPLETE",
      "The routing snapshot does not contain every system.",
    );
  for (const [low, high, forward, reverse] of graph.pairs) {
    const key = `${low}:${high}`;
    if (
      low >= high ||
      !ids.has(low) ||
      !ids.has(high) ||
      (!forward && !reverse) ||
      pairs.has(key)
    )
      failure(
        "ROUTE_DATA_INVALID",
        "The routing snapshot contains invalid connections.",
      );
    pairs.add(key);
    gates += forward + reverse;
  }
  if (gates !== graph.gateCount)
    failure(
      "ROUTE_DATA_INCOMPLETE",
      "The routing snapshot does not contain every gate.",
    );
  return graph;
}

/** Exact shortest directed walk through required stops; no inferred reverse edges. */
export function planRoute(
  value: unknown,
  input: unknown,
  signal?: AbortSignal,
): RoutePlan {
  signal?.throwIfAborted();
  const request = routeRequestSchema.parse(input);
  const graph = validateRouteGraph(value);
  const systems = [...graph.systems].sort((a, b) => a.id - b.id);
  const byId = new Map(systems.map((system, index) => [system.id, index]));
  const resolve = (ref: string | number) => {
    const matches =
      typeof ref === "number"
        ? systems.filter((s) => s.id === ref)
        : systems.filter(
            (s) => s.name.trim().toLowerCase() === ref.trim().toLowerCase(),
          );
    if (!matches.length)
      failure(
        "ROUTE_REFERENCE_UNKNOWN",
        "A system reference was not found; supply an exact system name or ID.",
      );
    if (matches.length !== 1)
      throw new MapError(
        "ROUTE_REFERENCE_AMBIGUOUS",
        "Select an exact system ID before planning.",
        {
          candidates: matches
            .slice(0, 10)
            .map(({ id, name }) => ({ id, name })),
          candidatesTruncated: matches.length > 10,
        },
      );
    return routeValue(matches[0]).id;
  };
  const origin = resolve(request.origin),
    destination = resolve(request.destination);
  const requestedStops = request.stops.map(resolve),
    avoid = [...new Set(request.avoid.map(resolve))].sort((a, b) => a - b);
  const forbidden = new Set(avoid);
  for (const s of systems)
    if (s.securityStatus < (request.minimumSecurity ?? -1)) forbidden.add(s.id);
  const terminals = [...new Set([origin, ...requestedStops, destination])];
  if (terminals.some((id) => forbidden.has(id)))
    failure(
      "ROUTE_CONSTRAINT_CONFLICT",
      "An endpoint or required stop is excluded by the route constraints. Revise the request; no exclusions were relaxed.",
    );
  const adjacent: number[][] = systems.map(() => []);
  for (const [low, high, forward, reverse] of graph.pairs) {
    if (forbidden.has(low) || forbidden.has(high)) continue;
    if (forward)
      routeValue(adjacent[routeValue(byId.get(low))]).push(
        routeValue(byId.get(high)),
      );
    if (reverse)
      routeValue(adjacent[routeValue(byId.get(high))]).push(
        routeValue(byId.get(low)),
      );
  }
  adjacent.forEach((neighbors) => neighbors.sort((a, b) => a - b));
  const trees = new Map<number, { distance: Int32Array; parent: Int32Array }>();
  for (const terminal of terminals) {
    signal?.throwIfAborted();
    const distance = new Int32Array(systems.length).fill(-1),
      parent = new Int32Array(systems.length).fill(-1);
    const queue = [routeValue(byId.get(terminal))];
    distance[routeValue(queue[0])] = 0;
    for (const node of queue) {
      for (const child of routeValue(adjacent[node]))
        if (distance[child] === -1) {
          distance[child] = routeValue(distance[node]) + 1;
          parent[child] = node;
          queue.push(child);
        }
    }
    trees.set(terminal, { distance, parent });
  }
  const distance = (a: number, b: number) => {
    const d = routeValue(
      routeValue(trees.get(a)).distance[routeValue(byId.get(b))],
    );
    return d < 0 ? Infinity : d;
  };
  const stops = [...new Set(requestedStops)]
    .filter((id) => id !== origin && id !== destination)
    .sort((a, b) => a - b);
  let order = requestedStops;
  if (request.stopOrder === "optimize") {
    order = [];
    if (stops.length) {
      const n = stops.length,
        size = 1 << n,
        costs = new Float64Array(size * n).fill(Infinity),
        previous = new Int16Array(size * n).fill(-1);
      for (let i = 0; i < n; i++)
        costs[(1 << i) * n + i] = distance(origin, routeValue(stops[i]));
      for (let mask = 1; mask < size; mask++) {
        if (mask % 64 === 0) signal?.throwIfAborted();
        for (let last = 0; last < n; last++)
          if (mask & (1 << last)) {
            const cost = routeValue(costs[mask * n + last]);
            if (!Number.isFinite(cost)) continue;
            for (let next = 0; next < n; next++)
              if (!(mask & (1 << next))) {
                const index = (mask | (1 << next)) * n + next,
                  candidate =
                    cost +
                    distance(routeValue(stops[last]), routeValue(stops[next]));
                if (candidate < routeValue(costs[index])) {
                  costs[index] = candidate;
                  previous[index] = last;
                }
              }
          }
      }
      let last = -1,
        best = Infinity;
      for (let i = 0; i < n; i++) {
        const cost =
          routeValue(costs[(size - 1) * n + i]) +
          distance(routeValue(stops[i]), destination);
        if (cost < best) {
          best = cost;
          last = i;
        }
      }
      if (last < 0)
        failure(
          "ROUTE_UNREACHABLE",
          "No permanent-stargate route visits every required stop under these constraints.",
        );
      let mask = size - 1;
      while (last >= 0) {
        order.push(routeValue(stops[last]));
        const before = routeValue(previous[mask * n + last]);
        mask ^= 1 << last;
        last = before;
      }
      order.reverse();
    }
  }
  const sequence = [origin, ...order, destination],
    path = [origin];
  const legs: RoutePlan["legs"] = [];
  for (let leg = 1; leg < sequence.length; leg++) {
    signal?.throwIfAborted();
    const from = routeValue(sequence[leg - 1]),
      to = routeValue(sequence[leg]);
    if (!Number.isFinite(distance(from, to)))
      failure(
        "ROUTE_UNREACHABLE",
        "No permanent-stargate route connects the required stops under these constraints.",
      );
    const reversed: number[] = [];
    let current = routeValue(byId.get(to));
    const start = routeValue(byId.get(from));
    while (current !== start) {
      reversed.push(routeValue(systems[current]).id);
      current = routeValue(routeValue(trees.get(from)).parent[current]);
    }
    const offset = path.length - 1;
    path.push(...reversed.reverse());
    if (path.length > ROUTE_LIMITS.visits)
      failure(
        "ROUTE_TOO_LONG",
        "The complete route exceeds 250 visits. Narrow the request; no route was truncated.",
      );
    legs.push({
      from,
      to,
      start: offset,
      end: path.length - 1,
      jumps: path.length - 1 - offset,
    });
  }
  // Replay against the original direction counts, independently of the BFS trees.
  const edges = new Set<string>();
  for (const [low, high, forward, reverse] of graph.pairs) {
    if (forward) edges.add(`${low}:${high}`);
    if (reverse) edges.add(`${high}:${low}`);
  }
  for (let i = 1; i < path.length; i++)
    if (!edges.has(`${path[i - 1]}:${path[i]}`))
      failure(
        "ROUTE_REPLAY_FAILED",
        "Route replay failed; no plan was published.",
      );
  const visited = new Set(path);
  const plan = routePlanSchema.parse({
    version: 1,
    algorithm: "BFS + Held-Karp",
    objective: "minimum_jumps",
    optimality: "exact",
    snapshotId: graph.snapshotId,
    source: graph.source,
    stopOrder: request.stopOrder,
    origin,
    destination,
    requestedStops,
    avoid,
    ...(request.minimumSecurity === undefined
      ? {}
      : { minimumSecurity: request.minimumSecurity }),
    systems: systems.filter((s) => visited.has(s.id)),
    path,
    stopSequence: sequence,
    legs,
    totalJumps: path.length - 1,
  });
  if (
    new TextEncoder().encode(JSON.stringify(plan)).byteLength >
    ROUTE_LIMITS.bytes
  )
    failure(
      "ROUTE_OUTPUT_LIMIT",
      "The complete plan exceeds its storage budget; narrow the request.",
    );
  return plan;
}
