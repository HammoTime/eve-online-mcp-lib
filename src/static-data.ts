import type { SkillCatalog } from "./skill-data.js";

export interface StaticDataSource {
  initialize(
    refresh?: boolean,
  ): Promise<{ catalog: SkillCatalog; status: Record<string, unknown> }>;
}
