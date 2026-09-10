import type { MapCatalog } from "./catalog.js";
import type { MapDataStatus, RenderedMap } from "./types.js";

export interface MapDataSource {
  initialize: (
    refresh?: boolean,
  ) => Promise<{ catalog: MapCatalog; status: MapDataStatus }>;
}
export interface MapArtifact {
  id: string;
  uri: string;
  manifestUri: string;
  mimeType: "image/svg+xml";
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  expiresAt: string;
}
export interface MapArtifactStore {
  put: (map: RenderedMap, source: MapDataStatus) => Promise<MapArtifact>;
  read: (
    id: string,
    file: "map.svg" | "manifest.json",
  ) => Promise<{ text: string; mimeType: string }>;
}
export interface MapPreview {
  render: (
    svg: string,
    width: number,
    signal: AbortSignal,
  ) => Promise<{
    data: string;
    bytes: number;
    width: number;
    height: number;
  }>;
}
export interface CartographyServices {
  /** Host admission/cancellation. Cleanup runs when the actual render settles,
   * including errors, not when Streamable HTTP returns its response headers. */
  beginRender?: (signal: AbortSignal) => () => void;
  data: MapDataSource;
  artifacts: MapArtifactStore;
  preview?: MapPreview;
}
