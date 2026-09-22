import { routePlanSchema, type RoutePlan } from "../route-plan.js";
import type { RenderedMap } from "./types.js";

/** Persist a plan in the existing artifact envelope without drawing an itinerary.
 * The inert SVG is storage compatibility only; it is never returned as a map or
 * submitted to a preview renderer. The route itself lives in the JSON manifest.
 */
export function createRouteArtifact(value: RoutePlan): RenderedMap {
  const plan = routePlanSchema.parse(value);
  return {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><title>Stored route plan; use render_eve_map for a map.</title></svg>',
    width: 1,
    height: 1,
    title: "Stored route plan",
    summary: {
      systemCount: plan.systems.length,
      edgeCount: plan.totalJumps,
      boundaryLabel: "Stored route plan",
      routes: [],
      pointsOfInterest: [],
    },
    layout: {
      requested: "plan",
      used: "plan",
      coordinateBasis: "not rendered",
    },
    completeness: { omittedLabels: 0, boundaryConnections: 0 },
    warnings: [],
    routePlan: plan,
  };
}
