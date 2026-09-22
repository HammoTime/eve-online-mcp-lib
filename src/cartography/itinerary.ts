import { routeValue } from "../route-plan.js";
import { routePlanSchema, type RoutePlan } from "../route-plan.js";
import { wrapText } from "./layout.js";
import { MapError, mapRequestSchema, type RenderedMap } from "./types.js";
import { MAP_FONT, MAP_THEMES } from "./themes.js";

export const ROUTE_PAGE_JUMPS = 24;
export function itineraryPage(plan: RoutePlan, page = 0) {
  const pageCount = Math.max(1, Math.ceil(plan.totalJumps / ROUTE_PAGE_JUMPS));
  if (!Number.isInteger(page) || page < 0 || page >= pageCount)
    throw new MapError(
      "ROUTE_PAGE_INVALID",
      "Requested route page is outside the complete plan.",
      { pageCount },
    );
  const start = page * ROUTE_PAGE_JUMPS;
  const path = plan.path.slice(start, start + ROUTE_PAGE_JUMPS + 1);
  return {
    page,
    pageCount,
    start,
    path,
    ...(page + 1 < pageCount ? { nextPage: page + 1 } : {}),
  };
}
const xml = (text: string) =>
  text.replace(/[&<>"']/g, (char) =>
    routeValue(
      {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      }[char],
    ),
  );

/** Deterministic, bounded route display. Every page-boundary jump remains visible. */
export function renderItinerary(
  value: RoutePlan,
  page = 0,
  themeName: "dark" | "light" = "dark",
  presentation: { title?: string; size?: "standard" | "wide" } = {},
): RenderedMap {
  const plan = routePlanSchema.parse(value),
    pagination = itineraryPage(plan, page);
  const theme = MAP_THEMES[themeName],
    systems = new Map(plan.systems.map((s) => [s.id, s]));
  const options = {
    title: mapRequestSchema.shape.title.parse(presentation.title),
    size: mapRequestSchema.shape.size.parse(presentation.size),
  };
  const width = options.size === "wide" ? 1600 : 1440;
  const cardWidth = (width - 88 - 4 * 16) / 5;
  const title = `${options.title ?? "Route itinerary"} / page ${page + 1} of ${pagination.pageCount}`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="900" viewBox="0 0 ${width} 900" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="map-title map-desc" font-family="${MAP_FONT}">`,
    `<title id="map-title">${xml(title)}</title><desc id="map-desc">Server-computed permanent-stargate route. Ordered visits, not geographic coordinates. No live safety assessment. Repeated transit systems are intentional.</desc>`,
    `<rect width="${width}" height="900" fill="${theme.background}"/>`,
  ];
  const text = (
    x: number,
    y: number,
    value: string,
    size = 18,
    color: string = theme.text,
  ) =>
    svg.push(
      `<text x="${x}" y="${y}" font-size="${size}" fill="${color}">${xml(value)}</text>`,
    );
  let titleSize = 28;
  while (titleSize > 12 && wrapText(title, titleSize, width - 88).length > 1)
    titleSize--;
  text(44, 48, title, titleSize);
  text(
    44,
    82,
    `${plan.totalJumps} total jumps • ${plan.path.length} visits • ${plan.stopOrder === "optimize" ? "Exact minimum-jump stop order" : "Requested stop order"}`,
    20,
  );
  text(
    44,
    113,
    `SDE build ${plan.source.buildNumber} • ${plan.source.stale ? "Stale snapshot; see source warning" : "Captured static snapshot"} • Not live intel`,
    16,
  );
  text(
    44,
    143,
    `Visits ${pagination.start + 1}–${pagination.start + pagination.path.length} of ${plan.path.length}. Follow the numbered visits and arrows.`,
    16,
  );
  const positions = pagination.path.map((_id, index) => {
    const row = Math.floor(index / 5),
      column = row % 2 ? 4 - (index % 5) : index % 5;
    return { x: 44 + column * (cardWidth + 16), y: 170 + row * 132 };
  });
  positions.forEach((position, index) => {
    const next = positions[index + 1];
    if (!next) return;
    const down = next.y !== position.y,
      right = next.x > position.x;
    const a = {
        x: position.x + (down ? cardWidth / 2 : right ? cardWidth : 0),
        y: position.y + (down ? 120 : 60),
      },
      b = {
        x: next.x + (down ? cardWidth / 2 : right ? 0 : cardWidth),
        y: next.y + (down ? 0 : 60),
      };
    const head = down
      ? `${b.x - 4},${b.y - 6} ${b.x},${b.y} ${b.x + 4},${b.y - 6}`
      : right
        ? `${b.x - 6},${b.y - 4} ${b.x},${b.y} ${b.x - 6},${b.y + 4}`
        : `${b.x + 6},${b.y - 4} ${b.x},${b.y} ${b.x + 6},${b.y + 4}`;
    svg.push(
      `<path d="M ${a.x} ${a.y} L ${b.x} ${b.y}" stroke="${theme.accent}" stroke-width="2" fill="none"/><path d="M ${head.replaceAll(" ", " L ")}" stroke="${theme.accent}" stroke-width="2" fill="none"/>`,
    );
  });
  pagination.path.forEach((id, index) => {
    const s = routeValue(systems.get(id)),
      p = routeValue(positions[index]),
      visit = pagination.start + index;
    const stops = plan.stopSequence.flatMap((stop, i) =>
      stop === id ? [i] : [],
    );
    svg.push(
      `<g><title>${xml(`${visit + 1}: ${s.name}; system ${id}; raw security ${s.securityStatus}`)}</title><rect x="${p.x}" y="${p.y}" width="${cardWidth}" height="120" rx="8" fill="${theme.panel}" stroke="${theme.accent}"/>`,
    );
    text(
      p.x + 12,
      p.y + 20,
      `Visit ${visit + 1}${visit === 0 ? " / START" : visit === plan.path.length - 1 ? " / FINISH" : stops.length ? " / STOP" : ""}`,
      15,
    );
    let fontSize = 14;
    while (
      fontSize > 10 &&
      wrapText(s.name, fontSize, cardWidth - 24).length > 5
    )
      fontSize--;
    wrapText(s.name, fontSize, cardWidth - 24).forEach((line, lineIndex) =>
      text(p.x + 12, p.y + 39 + lineIndex * 13, line, fontSize),
    );
    text(
      p.x + 12,
      p.y + 108,
      `Raw security: ${s.securityStatus.toFixed(3)}`,
      13,
    );
    svg.push("</g>");
  });
  text(
    44,
    853,
    pagination.nextPage === undefined
      ? "End of route. No systems or jumps omitted."
      : `Continue with page ${pagination.nextPage + 1}. Its first visit repeats this page's final visit.`,
    16,
  );
  text(
    44,
    880,
    "Schematic sequence only. No wormholes, cynos, temporary connections, cargo-capacity or safe-passage guarantee.",
    14,
  );
  svg.push("</svg>");
  const path = pagination.path.map((id) => ({
    id,
    name: routeValue(systems.get(id)).name,
  }));
  return {
    svg: svg.join(""),
    width,
    height: 900,
    title,
    summary: {
      systemCount: new Set(pagination.path).size,
      edgeCount: Math.max(0, path.length - 1),
      boundaryLabel: title,
      routes: [
        { label: "Verified route", systems: path, jumps: path.length - 1 },
      ],
      pointsOfInterest: [],
    },
    layout: {
      requested: "itinerary",
      used: "itinerary",
      coordinateBasis: "ordered route visits; schematic, not geographic",
    },
    completeness: { omittedLabels: 0, boundaryConnections: 0 },
    warnings: [],
    routePlan: plan,
  };
}
