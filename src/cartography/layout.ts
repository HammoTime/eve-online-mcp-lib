import { LIGHT_YEAR_METRES, MapError } from "./types.js";
import type { MapRequest, MapSystem } from "./types.js";

// EVE coordinates: ignore Y (height), place +X right and +Z up. Atlas 2D +Y is up.
export const XZ_ORIENTATION = "+X right; +Z up; Y omitted";
export const ATLAS_MAX_DISPLACEMENT = 24;
export interface Point {
  x: number;
  y: number;
}
export interface Box extends Point {
  width: number;
  height: number;
}
export interface MapNode extends Point {
  system: MapSystem;
  radius: number;
}
export interface LabelLine {
  text: string;
  size: number;
}
export interface MapLabel extends Box {
  systemId: number;
  lines: LabelLine[];
}
export interface RouteLeg {
  from: number;
  to: number;
  route: number;
  hop: number;
}
export interface RouteCurve extends RouteLeg {
  start: Point;
  control: Point;
  end: Point;
  samples: Point[];
}

export function tooDense(message: string): never {
  throw new MapError("MAP_TOO_DENSE", message);
}

export function present<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) {
    throw new MapError(
      "INVALID_MAP_DATA",
      "A required map layout value is missing.",
    );
  }
  return value;
}

// Conservative layout bounds, NOT a target advance for the SVG text. Glyphs must
// keep their natural aspect ratio and spacing. Account for wide Latin glyphs as
// well as narrow punctuation; leave room for common sans-serif fallback fonts.
export function textWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) {
    const advance = /\s/u.test(char)
      ? 0.38
      : /[MW@%&]/u.test(char)
        ? 1.1
        : /[mw]/u.test(char)
          ? 1.0
          : /[ijlI.,:;'!|]/u.test(char)
            ? 0.4
            : /[frt()[\]{}"`]/u.test(char)
              ? 0.52
              : /[A-Z]/u.test(char)
                ? 0.86
                : /[a-z0-9]/u.test(char)
                  ? 0.72
                  : present(char.codePointAt(0)) > 0x2ff
                    ? 1.2
                    : 1.1;
    width += size * advance;
  }
  return width;
}

export function wrapText(text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/u)) {
    if (line && textWidth(`${line} ${word}`, size) <= width) {
      line += ` ${word}`;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    for (const char of word) {
      if (line && textWidth(line + char, size) > width) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function overlaps(a: Box, b: Box, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length),
        );
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

export function curvePoint(
  curve: Pick<RouteCurve, "start" | "control" | "end">,
  t: number,
): Point {
  const u = 1 - t;
  return {
    x:
      u * u * curve.start.x + 2 * u * t * curve.control.x + t * t * curve.end.x,
    y:
      u * u * curve.start.y + 2 * u * t * curve.control.y + t * t * curve.end.y,
  };
}

export function layoutMap(
  systems: MapSystem[],
  request: MapRequest,
  plot: Box,
  labelArea: Box,
  important: ReadonlySet<number>,
  labelText: ReadonlyMap<number, LabelLine[]>,
  legs: RouteLeg[],
) {
  const geographic =
    request.boundary.kind === "extent" || request.layout === "geographic";
  const use2D =
    !geographic && systems.every((system) => system.position2D !== undefined);
  const coordinates = systems.map((system) => ({
    x: use2D
      ? present(system.position2D).x
      : system.position.x / LIGHT_YEAR_METRES,
    y: use2D
      ? present(system.position2D).y
      : system.position.z / LIGHT_YEAR_METRES,
  }));
  let minX = Math.min(...coordinates.map((point) => point.x));
  let maxX = Math.max(...coordinates.map((point) => point.x));
  let minY = Math.min(...coordinates.map((point) => point.y));
  let maxY = Math.max(...coordinates.map((point) => point.y));
  if (request.boundary.kind === "extent") {
    ({ minX, maxX, minZ: minY, maxZ: maxY } = request.boundary);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (![minX, maxX, minY, maxY, spanX, spanY].every(Number.isFinite)) {
    throw new MapError(
      "INVALID_MAP_DATA",
      "Map coordinates cannot be projected safely.",
    );
  }
  const scale =
    spanX === 0 && spanY === 0
      ? 1
      : Math.min(
          spanX === 0 ? Infinity : plot.width / spanX,
          spanY === 0 ? Infinity : plot.height / spanY,
        );
  if (!Number.isFinite(scale))
    throw new MapError(
      "INVALID_MAP_REQUEST",
      "Coordinate spans are too small to project safely.",
    );
  const nodes: MapNode[] = systems.map((system, index) => ({
    system,
    x:
      plot.x +
      (plot.width - spanX * scale) / 2 +
      (present(coordinates[index]).x - minX) * scale,
    y:
      plot.y +
      (plot.height - spanY * scale) / 2 +
      (maxY - present(coordinates[index]).y) * scale,
    radius: important.has(system.id) ? 18 : 6,
  }));
  const anchors = nodes.map(({ x, y }) => ({ x, y }));
  let moved = false;
  if (!geographic) {
    // Bounded local relaxation, sorted IDs, fixed iterations and no random seed.
    for (let iteration = 0; iteration < 180; iteration++) {
      let collisions = 0;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = present(nodes[i]);
          const b = present(nodes[j]);
          const distance = Math.hypot(b.x - a.x, b.y - a.y);
          const minimum = a.radius + b.radius + 18;
          if (distance >= minimum) continue;
          collisions++;
          const angle = (((i * 37 + j * 71) % 360) * Math.PI) / 180;
          const dx =
            distance < 0.001 ? Math.cos(angle) : (b.x - a.x) / distance;
          const dy =
            distance < 0.001 ? Math.sin(angle) : (b.y - a.y) / distance;
          const push = Math.min(8, (minimum - distance + 0.1) / 2);
          a.x -= dx * push;
          a.y -= dy * push;
          b.x += dx * push;
          b.y += dy * push;
        }
      }
      for (let i = 0; i < nodes.length; i++) {
        const node = present(nodes[i]);
        const anchor = present(anchors[i]);
        const displacement = Math.hypot(node.x - anchor.x, node.y - anchor.y);
        if (displacement > ATLAS_MAX_DISPLACEMENT) {
          node.x =
            anchor.x +
            ((node.x - anchor.x) * ATLAS_MAX_DISPLACEMENT) / displacement;
          node.y =
            anchor.y +
            ((node.y - anchor.y) * ATLAS_MAX_DISPLACEMENT) / displacement;
        }
        node.x = Math.max(plot.x, Math.min(plot.x + plot.width, node.x));
        node.y = Math.max(plot.y, Math.min(plot.y + plot.height, node.y));
      }
      if (!collisions) break;
      moved = true;
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = present(nodes[i]);
      const b = present(nodes[j]);
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius + 8) {
        tooDense(
          geographic
            ? "Geographic nodes overlap; coordinates have not been moved. Choose a smaller explicit boundary or atlas layout."
            : `Atlas collision separation exhausted its ${ATLAS_MAX_DISPLACEMENT}px displacement bound. Choose a smaller explicit boundary.`,
        );
      }
    }
  }
  const byId = new Map(nodes.map((node) => [node.system.id, node]));
  const curves: RouteCurve[] = [];
  const offsets = new Map<string, Set<number>>();
  for (const leg of legs) {
    const start = present(byId.get(leg.from));
    const end = present(byId.get(leg.to));
    const key = `${Math.min(leg.from, leg.to)}:${Math.max(leg.from, leg.to)}`;
    const used = offsets.get(key) ?? new Set<number>();
    offsets.set(key, used);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const direction = leg.from < leg.to ? 1 : -1;
    let found = false;
    for (const offset of [
      0, 36, -36, 72, -72, 112, -112, 160, -160, 224, -224,
    ]) {
      if (used.has(offset)) continue;
      const control = {
        x:
          (start.x + end.x) / 2 -
          ((end.y - start.y) / length) * offset * direction,
        y:
          (start.y + end.y) / 2 +
          ((end.x - start.x) / length) * offset * direction,
      };
      if (!contains(labelArea, { ...control, width: 0, height: 0 })) continue;
      const curve: RouteCurve = { ...leg, start, control, end, samples: [] };
      curve.samples = Array.from({ length: 49 }, (_, index) =>
        curvePoint(curve, index / 48),
      );
      if (
        nodes.some(
          (node) =>
            node.system.id !== leg.from &&
            node.system.id !== leg.to &&
            curve.samples.some(
              (point, index) =>
                index > 0 &&
                distanceToSegment(
                  node,
                  present(curve.samples[index - 1]),
                  point,
                ) <
                  node.radius + 12,
            ),
        )
      )
        continue;
      curves.push(curve);
      used.add(offset);
      found = true;
      break;
    }
    if (!found)
      tooDense(
        "A directed route cannot be drawn distinctly without crossing an unrelated node. No route was changed.",
      );
  }
  const labels: MapLabel[] = [];
  let omittedLabels = 0;
  const ordered = [...nodes].sort(
    (a, b) =>
      Number(important.has(b.system.id)) - Number(important.has(a.system.id)) ||
      a.system.id - b.system.id,
  );
  for (const node of ordered) {
    const lines = present(labelText.get(node.system.id));
    const width =
      Math.max(...lines.map((line) => textWidth(line.text, line.size))) + 4;
    const height = lines.reduce((total, line) => total + line.size + 6, 0);
    let placed = false;
    for (const gap of [12, 24, 40, 56]) {
      const distance = node.radius + gap;
      const positions = [
        { x: node.x + distance, y: node.y - height / 2 },
        { x: node.x - distance - width, y: node.y - height / 2 },
        { x: node.x - width / 2, y: node.y - distance - height },
        { x: node.x - width / 2, y: node.y + distance },
        { x: node.x + distance, y: node.y - height },
        { x: node.x - distance - width, y: node.y - height },
        { x: node.x + distance, y: node.y },
        { x: node.x - distance - width, y: node.y },
        { x: node.x + distance, y: node.y - distance - height },
        { x: node.x - distance - width, y: node.y - distance - height },
        { x: node.x + distance, y: node.y + distance },
        { x: node.x - distance - width, y: node.y + distance },
      ];
      for (const position of positions) {
        const box = {
          x: Math.max(
            labelArea.x,
            Math.min(labelArea.x + labelArea.width - width, position.x),
          ),
          y: Math.max(
            labelArea.y,
            Math.min(labelArea.y + labelArea.height - height, position.y),
          ),
          width,
          height,
        };
        if (
          !contains(labelArea, box) ||
          labels.some((label) => overlaps(box, label, 8))
        )
          continue;
        if (
          nodes.some((other) =>
            overlaps(
              box,
              {
                x: other.x - other.radius,
                y: other.y - other.radius,
                width: other.radius * 2,
                height: other.radius * 2,
              },
              6,
            ),
          )
        )
          continue;
        // Conservative segment bounding boxes reserve the complete route stroke.
        if (
          curves.some((curve) =>
            curve.samples.some((point, index) => {
              if (!index) return false;
              const previous = present(curve.samples[index - 1]);
              return overlaps(
                box,
                {
                  x: Math.min(point.x, previous.x),
                  y: Math.min(point.y, previous.y),
                  width: Math.abs(point.x - previous.x),
                  height: Math.abs(point.y - previous.y),
                },
                10,
              );
            }),
          )
        )
          continue;
        labels.push({ ...box, lines, systemId: node.system.id });
        placed = true;
        break;
      }
      if (placed) break;
    }
    if (!placed) {
      if (important.has(node.system.id))
        tooDense(
          `No readable label placement for important system ${node.system.id}. Choose a smaller explicit boundary or fewer annotations.`,
        );
      omittedLabels++;
    }
  }
  return {
    nodes,
    labels,
    curves,
    moved,
    omittedLabels,
    used: geographic ? "geographic" : "atlas",
    coordinateBasis: use2D
      ? "position2D (+X right; +Y up)"
      : `X/Z light years (${XZ_ORIENTATION})`,
    bounds: { minX, maxX, minZ: minY, maxZ: maxY },
  };
}
