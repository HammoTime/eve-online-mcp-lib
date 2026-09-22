import type { RouteGraph } from "../src/route-plan.js";
export function routeFixture(count = 4): RouteGraph {
  return {
    snapshotId: "synthetic",
    source: {
      buildNumber: 42,
      releaseDate: "2026-09-01T00:00:00Z",
      fetchedAt: "2026-09-01T00:00:00Z",
      checkedAt: "2026-09-01T00:00:00Z",
      sourceUrl: "https://example.invalid/sde",
      stale: false,
    },
    systemCount: count,
    gateCount: 2 * (count - 1),
    systems: Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      name: `System ${i + 1}`,
      securityStatus: 0.8,
    })),
    pairs: Array.from({ length: count - 1 }, (_, i) => [i + 1, i + 2, 1, 1]),
  };
}
