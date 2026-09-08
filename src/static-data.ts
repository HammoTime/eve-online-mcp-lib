import type { SkillCatalog } from "./skill-data.js";
import { captureCatalog } from "./diagnostics.js";
import { attributes, withSpan } from "./telemetry.js";

export interface StaticDataSource {
  initialize(
    refresh?: boolean,
  ): Promise<{ catalog: SkillCatalog; status: Record<string, unknown> }>;
}
export function observedStaticData(source: StaticDataSource): StaticDataSource {
  return {
    initialize: (refresh = false) =>
      withSpan(
        "eve.static_data.initialize",
        { "eve.input.refresh": refresh },
        async () => {
          const result = await source.initialize(refresh);
          attributes({
            "eve.sde.build": result.catalog.data.buildNumber,
            "eve.sde.type_count": result.catalog.types.size,
          });
          await captureCatalog(result.catalog.data, result.status, refresh);
          return result;
        },
      ),
  };
}
