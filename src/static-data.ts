import type { SkillReader } from "./skill-data.js";
import { activeCapture, captureCatalog } from "./diagnostics.js";
import { attributes, withSpan } from "./telemetry.js";

export interface StaticDataSnapshot {
  catalog: SkillReader;
  status: Record<string, unknown>;
  /** Idempotent; callers must release in finally, including status-only calls. */
  release?: () => void;
}
export interface StaticDataSource {
  initialize(refresh?: boolean): Promise<StaticDataSnapshot>;
}
export function observedStaticData(source: StaticDataSource): StaticDataSource {
  return {
    initialize: (refresh = false) =>
      withSpan(
        "eve.static_data.initialize",
        { "eve.input.refresh": refresh },
        async () => {
          let result: StaticDataSnapshot | undefined;
          try {
            result = await source.initialize(refresh);
            attributes({
              "eve.sde.build": result.catalog.metadata.buildNumber,
              "eve.sde.type_count": result.catalog.metadata.typeCount,
            });
            const artifact = result.catalog.diagnosticCatalog;
            if (artifact)
              await captureCatalog(artifact, result.status, refresh);
            else activeCapture()?.incomplete("catalog_artifact_unavailable");
            return result;
          } catch (error) {
            activeCapture()?.incomplete("static_catalog_unavailable");
            result?.release?.();
            throw error;
          }
        },
      ),
  };
}
