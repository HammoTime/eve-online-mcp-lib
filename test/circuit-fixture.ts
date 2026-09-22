import { readFileSync } from "node:fs";
import { validateMapData } from "../src/cartography/catalog.js";
import { routePlanSchema } from "../src/route-plan.js";

// Public CCP SDE build 3532181: selected geometry and the complete planner result
// for C-J6MT → GPLB-C → E-JCUS → YHEN-G → L-FM3P → C-J6MT, in that order.
// No character, asset, or other private evidence is included.
export function circuitFixture() {
  return {
    data: validateMapData(
      JSON.parse(
        readFileSync(
          new URL("./fixtures/c-j6mt-map.json", import.meta.url),
          "utf8",
        ),
      ),
    ),
    plan: routePlanSchema.parse(
      JSON.parse(
        readFileSync(
          new URL("./fixtures/c-j6mt-route.json", import.meta.url),
          "utf8",
        ),
      ),
    ),
  };
}
