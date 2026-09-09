export const MAP_THEMES = {
  dark: {
    background: "#0B1220",
    panel: "#101B2D",
    rail: "#142137",
    frame: "#34465F",
    text: "#F1F5FC",
    muted: "#B0C0D5",
    gate: "#536781",
    node: "#C7D7EE",
    accent: "#91DCD3",
    routes: ["#73DACA", "#F4BE73", "#B7A1FA"],
  },
  light: {
    background: "#F5F1E8",
    panel: "#FBF8F0",
    rail: "#EDE8DD",
    frame: "#B6B0A5",
    text: "#202D3E",
    muted: "#526174",
    gate: "#A5AAB0",
    node: "#52657B",
    accent: "#176B65",
    routes: ["#087C70", "#A45A0B", "#7451B7"],
  },
} as const;

export const MAP_FONT = "DejaVu Sans, Arial, Helvetica, sans-serif";
export const ROUTE_DASHES = ["", "12 6", "3 6"] as const;
