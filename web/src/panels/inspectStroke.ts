// The stroke rows of the Inspect panel, as plain text so they are easy to test.

import type { Node } from "../types";

export interface StrokeRow {
  k: string;
  /** The value, and what a click copies. */
  v: string;
  /** Muted words after the value (not copied). */
  note?: string;
}

/** At most two decimals, no trailing zeros. */
const r = (v: number) => Math.round(v * 100) / 100;

/** Layers whose stroke can have a weight per side (the renderer ignores `strokeWeights` on the others). */
const NOT_BOXY = ["ellipse", "polygon", "star", "line", "vector", "text", "group", "arrow"];

const CAPS: Record<string, string> = { none: "None", round: "Round", square: "Square", arrow: "Arrow", circle: "Circle", arrowLines: "Arrow (lines)", arrowTriangle: "Arrow (triangle)" };
const capName = (c: string) => CAPS[c] ?? c.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase());

/** The weight, position, dash and caps of a layer's stroke (nothing when it has no stroke paint). */
export function strokeRows(n: Pick<Node, "type" | "strokes" | "strokeWeight" | "strokeWeights" | "strokeAlign" | "strokeDash" | "shape">): StrokeRow[] {
  if (!n.strokes.some((p) => p.visible)) return [];
  const rows: StrokeRow[] = [];
  const sides = NOT_BOXY.includes(n.type) ? undefined : n.strokeWeights;
  if (sides && sides.some((w) => w !== sides[0])) {
    rows.push({ k: "Weight", v: sides.map((w) => `${r(w)}px`).join(" "), note: "top right bottom left" });
  } else {
    rows.push({ k: "Weight", v: `${r(sides ? sides[0] : n.strokeWeight)}px` });
  }
  rows.push({ k: "Position", v: n.strokeAlign });
  if (n.strokeDash.length > 0) rows.push({ k: "Dash", v: `Dashed ${n.strokeDash.map(r).join(", ")}` });
  const caps = n.shape ? [n.shape.startCap, n.shape.endCap] : [];
  if (caps.some((c) => c && c !== "none")) rows.push({ k: "Caps", v: `${capName(caps[0])} to ${capName(caps[1])}` });
  return rows;
}

const H_LABEL: Record<string, string> = { left: "Left", right: "Right", leftRight: "Left & right", center: "Center", scale: "Scale" };
const V_LABEL: Record<string, string> = { top: "Top", bottom: "Bottom", topBottom: "Top & bottom", center: "Center", scale: "Scale" };

/** "Right, Top" for a layer that follows constraints (a frame without layout, or an absolute child), else "". */
export function constraintsText(n: Pick<Node, "constraints" | "absolutePosition">, parent: Pick<Node, "type" | "layout"> | null | undefined): string {
  if (!parent || !["frame", "component", "instance"].includes(parent.type)) return "";
  if (parent.layout && !n.absolutePosition) return "";
  return `${H_LABEL[n.constraints.horizontal] ?? n.constraints.horizontal}, ${V_LABEL[n.constraints.vertical] ?? n.constraints.vertical}`;
}
