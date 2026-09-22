import { routeValue } from "../src/route-plan.js";
import { routeFixture } from "./route-fixtures.js";
import { describe, expect, it } from "vitest";
import {
  planRoute,
  routePlanSchema,
  validateRouteGraph,
} from "../src/route-plan.js";
import {
  itineraryPage,
  renderItinerary,
} from "../src/cartography/itinerary.js";
import {
  projectInput,
  projectOutput,
  TOOL_NAMES,
} from "../src/diagnostic-policy.js";

describe("exact server-owned routing", () => {
  it("plans the seven-stop 64-jump pickup regression and preserves repeated transit visits", () => {
    const plan = planRoute(routeFixture(33), {
      origin: "System 1",
      destination: 1,
      stops: [33, 5, 10, 15, 20, 25, 30],
    });
    expect(plan.totalJumps).toBe(64);
    expect(plan.path).toHaveLength(65);
    expect(plan.systems).toHaveLength(33);
    expect(plan.path).toEqual([
      ...Array.from({ length: 33 }, (_, i) => i + 1),
      ...Array.from({ length: 32 }, (_, i) => 32 - i),
    ]);
    expect(plan.optimality).toBe("exact");
    const pages = Array.from({ length: 3 }, (_, page) =>
      itineraryPage(plan, page),
    );
    expect(pages.map((p) => p.path.length)).toEqual([25, 25, 17]);
    expect(pages.flatMap((p, i) => (i ? p.path.slice(1) : p.path))).toEqual(
      plan.path,
    );
    const map = renderItinerary(plan, 2, "light");
    expect(map.svg).toContain("Visit 65 / FINISH");
    expect(map.routePlan).toEqual(plan);
    expect(map.completeness.omittedLabels).toBe(0);
  });
  it("honors directions, exclusions and raw-security constraints without inferred repairs", () => {
    const graph = routeFixture();
    graph.pairs[1] = [2, 3, 1, 0];
    graph.gateCount--;
    expect(planRoute(graph, { origin: 1, destination: 4 }).path).toEqual([
      1, 2, 3, 4,
    ]);
    expect(() => planRoute(graph, { origin: 4, destination: 1 })).toThrow(
      "No permanent-stargate",
    );
    expect(() =>
      planRoute(graph, { origin: 1, destination: 4, avoid: [2] }),
    ).toThrow("No permanent-stargate");
    expect(() =>
      planRoute(graph, { origin: 1, destination: 4, avoid: [1] }),
    ).toThrow("excluded");
    routeValue(graph.systems[1]).securityStatus = 0.49;
    expect(() =>
      planRoute(graph, { origin: 1, destination: 4, minimumSecurity: 0.5 }),
    ).toThrow("No permanent-stargate");
    expect(
      planRoute(graph, { origin: 1, destination: 4, minimumSecurity: 0.49 })
        .totalJumps,
    ).toBe(3);
  });
  it("keeps ordered repeat waypoints and collapses duplicate optimized pickups", () => {
    const graph = routeFixture();
    expect(
      planRoute(graph, {
        origin: 1,
        destination: 1,
        stops: [4, 2, 4],
        stopOrder: "as_given",
      }).path,
    ).toEqual([1, 2, 3, 4, 3, 2, 3, 4, 3, 2, 1]);
    expect(
      planRoute(graph, { origin: 1, destination: 1, stops: [4, 2, 4, 1] })
        .totalJumps,
    ).toBe(6);
    expect(planRoute(graph, { origin: 1, destination: 1 }).path).toEqual([1]);
    expect(
      itineraryPage(planRoute(graph, { origin: 1, destination: 1 })).pageCount,
    ).toBe(1);
  });
  it("resolves only exact names and keeps ambiguity explicit", () => {
    const graph = routeFixture();
    expect(
      planRoute(graph, { origin: " SYSTEM 1 ", destination: 4 }).origin,
    ).toBe(1);
    expect(() =>
      planRoute(graph, { origin: "Systm 1", destination: 4 }),
    ).toThrow("exact system");
    routeValue(graph.systems[1]).name = "System 1";
    expect(() =>
      planRoute(graph, { origin: "System 1", destination: 4 }),
    ).toThrow("exact system ID");
    expect(planRoute(graph, { origin: 1, destination: 4 }).origin).toBe(1);
  });
  it("rejects incomplete, oversized and malformed evidence", () => {
    const graph = routeFixture();
    expect(() =>
      validateRouteGraph({ ...graph, systems: graph.systems.slice(1) }),
    ).toThrow("every system");
    expect(() =>
      validateRouteGraph({ ...graph, pairs: graph.pairs.slice(1) }),
    ).toThrow("every gate");
    expect(() =>
      validateRouteGraph({ ...graph, pairs: [[2, 1, 1, 1]] }),
    ).toThrow("invalid connections");
    expect(() =>
      validateRouteGraph({ ...graph, pairs: [[1, 2, 0, 0]] }),
    ).toThrow("invalid connections");
    expect(() =>
      validateRouteGraph({ ...graph, pairs: [...graph.pairs, graph.pairs[0]] }),
    ).toThrow("invalid connections");
    expect(() => validateRouteGraph({ ...graph, systemCount: 20_001 })).toThrow(
      "bounds",
    );
    expect(() =>
      planRoute(graph, { origin: 1, destination: 4, stops: Array(13).fill(2) }),
    ).toThrow();
    expect(() =>
      planRoute(routeFixture(251), { origin: 1, destination: 251 }),
    ).toThrow("250 visits");
    expect(() =>
      planRoute(graph, { origin: 1, destination: 4, connections: [[1, 4]] }),
    ).toThrow();
    expect(() =>
      planRoute(graph, { origin: 1, destination: 4 }, AbortSignal.abort()),
    ).toThrow();
  });
  it("does not emit a partial tour for disconnected optimized stops", () => {
    const graph = routeFixture();
    graph.pairs.pop();
    graph.gateCount -= 2;
    expect(() =>
      planRoute(graph, { origin: 1, destination: 1, stops: [2, 4] }),
    ).toThrow("every required stop");
  });
  it("has stable ties independently of data and optimized pickup input order", () => {
    const graph = routeFixture(6),
      input = { origin: 1, destination: 1, stops: [6, 3, 4, 2] };
    const a = planRoute(graph, input);
    const b = planRoute(
      {
        ...graph,
        systems: [...graph.systems].reverse(),
        pairs: [...graph.pairs].reverse(),
      },
      { ...input, stops: [2, 4, 3, 6] },
    );
    expect(a.path).toEqual(b.path);
    expect(a.stopSequence).toEqual(b.stopSequence);
  });
  it("agrees with an independent Floyd-Warshall + exhaustive-tour oracle", () => {
    const permutations = (a: number[]): number[][] =>
      a.length
        ? a.flatMap((n, i) =>
            permutations(a.filter((_, j) => j !== i)).map((tail) => [
              n,
              ...tail,
            ]),
          )
        : [[]];
    for (let seed = 1; seed <= 12; seed++) {
      const graph = routeFixture(7);
      graph.pairs = [];
      graph.gateCount = 0;
      for (let a = 1; a <= 7; a++)
        for (let b = a + 1; b <= 7; b++) {
          const forward = b === a + 1 || (a * seed + b * 3) % 4 === 0 ? 1 : 0,
            reverse = b === a + 1 || (b * seed + a * 7) % 5 === 0 ? 1 : 0;
          if (forward || reverse) {
            graph.pairs.push([a, b, forward, reverse]);
            graph.gateCount += forward + reverse;
          }
        }
      const d = Array.from({ length: 7 }, (_, i) =>
        Array.from({ length: 7 }, (_, j) => (i === j ? 0 : Infinity)),
      );
      for (const [a, b, f, r] of graph.pairs) {
        if (f) routeValue(d[a - 1])[b - 1] = 1;
        if (r) routeValue(d[b - 1])[a - 1] = 1;
      }
      for (let k = 0; k < 7; k++)
        for (let i = 0; i < 7; i++)
          for (let j = 0; j < 7; j++)
            routeValue(d[i])[j] = Math.min(
              routeValue(routeValue(d[i])[j]),
              routeValue(routeValue(d[i])[k]) + routeValue(routeValue(d[k])[j]),
            );
      const stops = [2, 3, 4, 5, 6];
      const expected = Math.min(
        ...permutations(stops).map((order) => {
          const path = [1, ...order, 7];
          return path
            .slice(1)
            .reduce(
              (n, b, i) =>
                n + routeValue(routeValue(d[routeValue(path[i]) - 1])[b - 1]),
              0,
            );
        }),
      );
      expect(
        planRoute(graph, { origin: 1, destination: 7, stops }).totalJumps,
      ).toBe(expected);
    }
  });
  it("validates stored plans and rejects unavailable itinerary pages", () => {
    const plan = planRoute(routeFixture(), { origin: 1, destination: 4 });
    expect(routePlanSchema.safeParse({ ...plan, totalJumps: 99 }).success).toBe(
      false,
    );
    expect(routePlanSchema.safeParse({ ...plan, path: [1, 2] }).success).toBe(
      false,
    );
    expect(
      routePlanSchema.safeParse({
        ...plan,
        legs: [{ ...plan.legs[0], start: 2 }],
      }).success,
    ).toBe(false);
    expect(routePlanSchema.safeParse({ ...plan, avoid: [2] }).success).toBe(
      false,
    );
    expect(() => itineraryPage(plan, 1)).toThrow("outside");
    expect(() => itineraryPage(plan, -1)).toThrow("outside");
  });
  it("keeps names, route handles, stop arrays and paths out of diagnostic projections", () => {
    expect(TOOL_NAMES.has("plan_eve_route")).toBe(true);
    expect(
      JSON.stringify(
        projectInput({
          origin: "PRIVATE NAME",
          destination: 4,
          stops: [2, 3],
          routeId: "PRIVATE HANDLE",
        }),
      ),
    ).not.toContain("PRIVATE");
    expect(
      JSON.stringify(
        projectOutput(planRoute(routeFixture(), { origin: 1, destination: 4 })),
      ),
    ).not.toContain("System");
  });
});
