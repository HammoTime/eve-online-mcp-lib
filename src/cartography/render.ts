import type { MapCatalog } from "./catalog.js";
import {
  ATLAS_MAX_DISPLACEMENT,
  curvePoint,
  layoutMap,
  present,
  textWidth,
  tooDense,
  wrapText,
} from "./layout.js";
import type { Box, LabelLine } from "./layout.js";
import {
  prepareMapScene,
  readPreparedMapScene,
  type PreparedMapScene,
} from "./prepared.js";
import { MAP_FONT, MAP_THEMES, ROUTE_DASHES } from "./themes.js";
import { MAP_LIMITS, MapError } from "./types.js";
import type { MapRequest, RenderedMap } from "./types.js";

function escapeXml(value: string): string {
  return value
    .replace(
      // eslint-disable-next-line no-control-regex -- Strip XML-invalid controls from source metadata.
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF\uFFFE\uFFFF]/gu,
      "\uFFFD",
    )
    .replace(/[&<>"']/g, (char) =>
      present(
        {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        }[char],
      ),
    );
}

function number(value: number): string {
  if (!Number.isFinite(value))
    throw new MapError("INVALID_MAP_DATA", "Non-finite SVG coordinate.");
  return String(Math.round(value * 1000) / 1000);
}

/** Pure renderer: scopes and ordered paths are entirely caller-supplied. */
export function renderMap(catalog: MapCatalog, input: MapRequest): RenderedMap {
  return renderPreparedMap(prepareMapScene(catalog, input));
}

/** Renders only validated selected facts. Optional input binds a provider result to its request. */
export function renderPreparedMap(
  scene: PreparedMapScene,
  input?: MapRequest,
): RenderedMap {
  const {
    request,
    source,
    systems,
    internalPairs: edges,
    boundaryConnections,
    boundaryLabel,
    pointsOfInterest,
    routes,
    legs,
  } = readPreparedMapScene(scene, input);
  const boundary = request.boundary;
  const important = new Set([
    ...pointsOfInterest.map((poi) => poi.systemId),
    ...routes.flatMap((route) => route.systems.map((system) => system.id)),
  ]);
  const poiNumbers = new Map<number, number[]>();
  pointsOfInterest.forEach((poi, index) =>
    poiNumbers.set(poi.systemId, [
      ...(poiNumbers.get(poi.systemId) ?? []),
      index + 1,
    ]),
  );
  const labelText = new Map<number, LabelLine[]>();
  const systemDetails = new Map<number, string>();
  for (const system of systems) {
    const primary = important.has(system.id);
    const size = primary ? 22 : 18;
    const lines = wrapText(system.name, size, 240).map((text) => ({
      text,
      size,
    }));
    const gateCount = system.outgoingGateCount;
    const poiIds = (poiNumbers.get(system.id) ?? []).map(
      (value) => `P${value}`,
    );
    const details = [
      `${system.name} (ID ${system.id})`,
      `raw security ${system.securityStatus}`,
      `region ${system.regionName}`,
      `constellation ${system.constellationName}`,
      `${gateCount} outgoing SDE gates, including connections outside this boundary`,
    ];
    if (poiIds.length) details.push(poiIds.join(" / "));
    routes.forEach((route, index) => {
      const visits = route.systems.flatMap((item, visit) =>
        item.id === system.id ? [visit + 1] : [],
      );
      if (!visits.length) return;
      const start = present(route.systems[0]).id === system.id;
      const end =
        present(route.systems[route.systems.length - 1]).id === system.id;
      details.push(
        `R${index + 1}${start && end ? " start/end" : start ? " start" : end ? " end" : ""}: ${route.label}; visits ${visits.join(", ")} of ${route.systems.length}`,
      );
    });
    systemDetails.set(system.id, details.join("; "));
    if (primary) {
      // Approximate display only, never an effective-security class or safety claim.
      const security =
        Math.abs(system.securityStatus) < 100
          ? system.securityStatus.toFixed(2)
          : system.securityStatus.toExponential(2);
      const detail = `sec ~${security} | ${poiIds.length ? poiIds.join("/") : `${gateCount} gates`}`;
      lines.push(
        ...(poiIds.length ? wrapText(detail, 18, 240) : [detail]).map(
          (text) => ({
            text,
            size: 18,
          }),
        ),
      );
    }
    labelText.set(system.id, lines);
  }
  const width = request.size === "wide" ? 1600 : 1440;
  const height = 900;
  const hasRail = pointsOfInterest.length > 0;
  const panel: Box = {
    x: 40,
    y: 170,
    width: hasRail ? width - 478 : width - 80,
    height: 558,
  };
  const plot: Box = {
    x: panel.x + 42,
    y: panel.y + 46,
    width: panel.width - 84,
    height: 450,
  };
  const labelArea: Box = {
    x: panel.x + 14,
    y: panel.y + 18,
    width: panel.width - 28,
    height: 502,
  };
  const layout = layoutMap(
    systems,
    request,
    plot,
    labelArea,
    important,
    labelText,
    legs,
  );
  const warnings: RenderedMap["warnings"] = [
    {
      code: "CALLER_SUPPLIED_PLANS",
      message:
        "Caller-supplied plans; not live intel. No route planning, safety assessment or live data is included.",
    },
  ];
  if (layout.used === "atlas")
    warnings.push({
      code: "ATLAS_NOT_TO_SCALE",
      message:
        "Atlas layout is not to scale; collision separation may move nodes.",
    });
  if (layout.moved)
    warnings.push({
      code: "ATLAS_NODES_SEPARATED",
      message: `Overlapping atlas nodes were separated deterministically, by at most ${ATLAS_MAX_DISPLACEMENT} SVG pixels.`,
    });
  if (request.layout === "atlas" && boundary.kind === "extent")
    warnings.push({
      code: "EXTENT_USES_GEOGRAPHIC",
      message:
        "An absolute extent always uses the supplied X/Z viewport and geographic projection.",
    });
  if (layout.used === "atlas" && layout.coordinateBasis.startsWith("X/Z"))
    warnings.push({
      code: "ATLAS_XZ_FALLBACK",
      message:
        "Not every selected system has position2D; the entire view uses X/Z coordinates.",
    });
  if (layout.omittedLabels)
    warnings.push({
      code: "CONTEXT_LABELS_OMITTED",
      message: `${layout.omittedLabels} context labels omitted for readability; all selected nodes and all important labels remain.`,
    });
  if (boundaryConnections)
    warnings.push({
      code: "BOUNDARY_CONNECTIONS",
      message: `${boundaryConnections} gate connections leave the explicit boundary and are not drawn.`,
    });
  const title = request.title ?? "Stellar atlas";
  const summary = {
    systemCount: systems.length,
    edgeCount: edges.length,
    boundaryLabel,
    routes,
    pointsOfInterest,
  };
  const layoutSummary = {
    requested: request.layout,
    used: layout.used,
    coordinateBasis: layout.coordinateBasis,
  };
  const completeness = {
    omittedLabels: layout.omittedLabels,
    boundaryConnections,
  };
  const theme = MAP_THEMES[request.theme];
  const svg: string[] = [];
  const text = (
    x: number,
    y: number,
    value: string,
    size: number,
    fill: string,
    extra = "",
  ) => {
    svg.push(
      `<text x="${number(x)}" y="${number(y)}" font-size="${size}" fill="${fill}" data-text-width="${number(textWidth(value, size))}"${extra}>${escapeXml(value)}</text>`,
    );
  };
  const wrapped = (
    value: string,
    x: number,
    y: number,
    size: number,
    maxWidth: number,
    maxLines: number,
    fill: string,
  ) => {
    const lines = wrapText(value, size, maxWidth);
    if (lines.length > maxLines)
      tooDense(
        "Text exceeds the available readable space; shorten the title, scope name or annotation.",
      );
    lines.forEach((line, index) => {
      text(x, y + index * (size + 6), line, size, fill);
    });
  };
  svg.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="map-title map-desc" font-family="${MAP_FONT}">`,
  );
  svg.push(
    `<title id="map-title">${escapeXml(title)}</title><desc id="map-desc">${escapeXml(`${boundaryLabel}. ${systems.length} systems. ${layout.coordinateBasis}. ${layout.used === "atlas" ? "Atlas not to scale. " : "Geographic coordinates are not moved. "}Caller-supplied plans. Not live intel. P numbers link nodes to the points of interest list; R numbers identify ordered routes. Visible security is approximate (~), rounded to two decimals; tooltips retain raw SDE values and all route visits. No safety classification. Gate counts are outgoing SDE gates, including connections outside the boundary. Background gates are masked only beneath label text. ${layout.omittedLabels} context labels omitted.`)}</desc>`,
  );
  svg.push(
    `<metadata>${escapeXml(JSON.stringify({ schemaVersion: 1, source, summary, layout: layoutSummary, projectionBounds: layout.bounds, completeness, warnings }))}</metadata>`,
  );
  svg.push(
    `<rect width="${width}" height="${height}" rx="28" fill="${theme.background}"/><rect x="20" y="20" width="${width - 40}" height="860" rx="24" fill="none" stroke="${theme.frame}" stroke-width="1.5" data-frame="outer"/>`,
  );
  wrapped(title, 48, 70, 32, width - 100, 1, theme.text);
  wrapped(boundaryLabel, 48, 106, 20, width - 100, 1, theme.muted);
  // U+2022 is a fixed visual separator, never caller-provided markup.
  text(
    48,
    139,
    "Caller-supplied plans \u2022 Not live intel",
    18,
    theme.accent,
  );
  svg.push(
    `<rect x="${panel.x}" y="${panel.y}" width="${panel.width}" height="${panel.height}" rx="22" fill="${theme.panel}" stroke="${theme.frame}" data-frame="boundary"/>`,
  );
  // Clear each text line, including inter-glyph spaces, without drawing label cards
  // or altering the underlying gate paths. Routes and nodes are never masked.
  svg.push(
    `<defs><mask id="gate-label-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
  );
  for (const label of layout.labels) {
    let y = label.y;
    for (const line of label.lines) {
      svg.push(
        `<rect data-label-cutout="${label.systemId}" x="${number(label.x - 1)}" y="${number(y - 2)}" width="${number(textWidth(line.text, line.size) + 6)}" height="${line.size + 8}" fill="#000000"/>`,
      );
      y += line.size + 6;
    }
  }
  svg.push('</mask></defs><g data-gates="true" mask="url(#gate-label-mask)">');
  const byId = new Map(layout.nodes.map((node) => [node.system.id, node]));
  for (const edge of edges) {
    const a = present(byId.get(edge.from));
    const b = present(byId.get(edge.to));
    const routed = layout.curves.find(
      (curve) =>
        (curve.from === edge.from && curve.to === edge.to) ||
        (curve.from === edge.to && curve.to === edge.from),
    );
    const path = routed
      ? `M ${number(a.x)} ${number(a.y)} Q ${number(routed.control.x)} ${number(routed.control.y)} ${number(b.x)} ${number(b.y)}`
      : `M ${number(a.x)} ${number(a.y)} L ${number(b.x)} ${number(b.y)}`;
    svg.push(
      `<path data-gate="${edge.from}:${edge.to}" d="${path}" fill="none" stroke="${theme.gate}" stroke-width="1.3" opacity="0.6"/>`,
    );
  }
  svg.push("</g>");
  for (const curve of layout.curves) {
    const color = present(theme.routes[curve.route]);
    const dash = present(ROUTE_DASHES[curve.route]);
    const path = `M ${number(curve.start.x)} ${number(curve.start.y)} Q ${number(curve.control.x)} ${number(curve.control.y)} ${number(curve.end.x)} ${number(curve.end.y)}`;
    svg.push(
      `<path d="${path}" fill="none" stroke="${color}" stroke-width="12" opacity="0.10"/>`,
    );
    svg.push(
      `<path data-route="${curve.route + 1}" data-hop="${curve.hop}" data-from="${curve.from}" data-to="${curve.to}" d="${path}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
    );
    const tip = curvePoint(curve, 0.58);
    const previous = curvePoint(curve, 0.56);
    const length = Math.hypot(tip.x - previous.x, tip.y - previous.y);
    const dx = (tip.x - previous.x) / length;
    const dy = (tip.y - previous.y) / length;
    svg.push(
      `<path data-arrow="${curve.route + 1}:${curve.hop}" d="M ${number(tip.x)} ${number(tip.y)} L ${number(tip.x - dx * 13 - dy * 6)} ${number(tip.y - dy * 13 + dx * 6)} L ${number(tip.x - dx * 13 + dy * 6)} ${number(tip.y - dy * 13 - dx * 6)} Z" fill="${color}"/>`,
    );
  }
  for (const node of layout.nodes) {
    const poi = poiNumbers.get(node.system.id);
    const memberships = routes.flatMap((route, index) =>
      route.systems.some((system) => system.id === node.system.id)
        ? [index]
        : [],
    );
    const endpoint = routes.some(
      (route) =>
        present(route.systems[0]).id === node.system.id ||
        present(route.systems[route.systems.length - 1]).id === node.system.id,
    );
    svg.push(
      `<g data-system-id="${node.system.id}" data-x="${number(node.x)}" data-y="${number(node.y)}" data-radius="${node.radius}"><title>${escapeXml(present(systemDetails.get(node.system.id)))}</title>`,
    );
    if (important.has(node.system.id))
      svg.push(
        `<circle cx="${number(node.x)}" cy="${number(node.y)}" r="${node.radius + 4}" fill="none" stroke="${theme.accent}" stroke-width="8" opacity="0.10"/>`,
      );
    if (endpoint)
      svg.push(
        `<circle data-endpoint="true" cx="${number(node.x)}" cy="${number(node.y)}" r="18" fill="${theme.panel}" stroke="${theme.text}" stroke-width="2"/>`,
      );
    svg.push(
      `<circle cx="${number(node.x)}" cy="${number(node.y)}" r="${important.has(node.system.id) ? 14 : 6}" fill="${important.has(node.system.id) ? theme.panel : theme.node}" stroke="${poi ? theme.accent : memberships.length ? present(theme.routes[present(memberships[0])]) : theme.node}" stroke-width="2.5"/>`,
    );
    if (poi)
      text(
        node.x,
        node.y + 6,
        String(poi[0]),
        18,
        theme.text,
        ' text-anchor="middle" font-weight="700"',
      );
    else if (memberships.length)
      text(
        node.x,
        node.y + 6,
        String(present(memberships[0]) + 1),
        18,
        theme.text,
        ' text-anchor="middle"',
      );
    svg.push("</g>");
  }
  for (const label of layout.labels) {
    svg.push(
      `<g data-label-for="${label.systemId}" data-x="${number(label.x)}" data-y="${number(label.y)}" data-width="${number(label.width)}" data-height="${number(label.height)}"><title>${escapeXml(present(systemDetails.get(label.systemId)))}</title>`,
    );
    let y = label.y;
    for (const line of label.lines) {
      y += line.size;
      text(
        label.x + 2,
        y,
        line.text,
        line.size,
        line.size === 22 ? theme.text : theme.muted,
        ` stroke="${theme.panel}" stroke-width="4" stroke-linejoin="round" paint-order="stroke"`,
      );
      y += 6;
    }
    svg.push("</g>");
  }
  text(
    60,
    712,
    `${layout.used === "atlas" ? "Atlas / not to scale" : "X/Z projection"} | ${systems.length} systems | ${boundaryConnections} external links | ${layout.omittedLabels} hidden labels`,
    18,
    theme.muted,
  );
  text(
    48,
    760,
    "Gate counts: outbound | Routes: arrows + R numbers | Rings: endpoints",
    18,
    theme.muted,
  );
  if (!routes.length)
    text(
      48,
      800,
      "No routes supplied. No destinations selected by this renderer.",
      18,
      theme.muted,
    );
  routes.forEach((route, index) => {
    const y = 793 + index * 25;
    const color = present(theme.routes[index]);
    const dash = present(ROUTE_DASHES[index]);
    text(50, y, `R${index + 1}`, 18, color);
    svg.push(
      `<path d="M 91 ${y - 6} L 137 ${y - 6}" stroke="${color}" stroke-width="4"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
    );
    wrapped(
      `${route.label} / ${route.jumps} ${route.jumps === 1 ? "jump" : "jumps"} / ${route.systems.length} visits`,
      151,
      y,
      18,
      panel.width - 125,
      1,
      theme.text,
    );
  });
  if (hasRail) {
    const railX = width - 414;
    const railWidth = 374;
    svg.push(
      `<g data-poi-list="true"><rect x="${railX}" y="170" width="${railWidth}" height="674" rx="22" fill="${theme.rail}" stroke="${theme.frame}"/>`,
    );
    text(railX + 22, 207, "POINTS OF INTEREST", 20, theme.text);
    text(railX + 22, 235, "Caller annotations / P numbers", 18, theme.muted);
    let y = 267;
    pointsOfInterest.forEach((poi, index) => {
      const labelLines = wrapText(poi.label, 22, railWidth - 82);
      const contextLines = wrapText(
        `${poi.systemName} / ${poi.kind}`,
        18,
        railWidth - 82,
      );
      const noteLines = poi.note ? wrapText(poi.note, 18, railWidth - 82) : [];
      const required =
        labelLines.length * 28 +
        (contextLines.length + noteLines.length) * 24 +
        18;
      if (y + required > 834)
        tooDense(
          "The complete points-of-interest list does not fit at readable size. Shorten notes or supply fewer points; no annotations were truncated.",
        );
      svg.push(
        `<g data-poi="${index + 1}" data-system-id="${poi.systemId}"><circle cx="${railX + 29}" cy="${y + 9}" r="17" fill="${theme.background}" stroke="${theme.accent}"/>`,
      );
      text(
        railX + 29,
        y + 15,
        String(index + 1),
        18,
        theme.text,
        ' text-anchor="middle"',
      );
      labelLines.forEach((line) => {
        text(railX + 60, y + 18, line, 22, theme.text);
        y += 28;
      });
      contextLines.forEach((line) => {
        text(railX + 60, y + 16, line, 18, theme.accent);
        y += 24;
      });
      noteLines.forEach((line) => {
        text(railX + 60, y + 16, line, 18, theme.muted);
        y += 24;
      });
      y += 18;
      svg.push("</g>");
    });
    svg.push("</g>");
  }
  wrapped(
    `SDE build ${source.buildNumber} / ${source.releaseDate} | Sec ~2dp; raw in tooltips; no safety classification`,
    48,
    873,
    18,
    width - 100,
    1,
    theme.muted,
  );
  svg.push("</svg>");
  const result = svg.join("");
  if (new TextEncoder().encode(result).byteLength > MAP_LIMITS.svgBytes)
    throw new MapError(
      "MAP_OUTPUT_TOO_LARGE",
      "SVG exceeds the one-megabyte output limit.",
    );
  return {
    svg: result,
    width,
    height,
    title,
    summary,
    layout: layoutSummary,
    completeness,
    warnings,
  };
}
