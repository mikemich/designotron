import { describe, expect, it } from "vitest";
import { panToComment } from "./commentPan";
import { constraintsText, strokeRows } from "./panels/inspectStroke";

const solid = [{ type: "solid", color: "#000000", opacity: 1, visible: true }] as never;
const base = { strokes: solid, strokeWeight: 2, strokeAlign: "inside" as const, strokeDash: [], strokeWeights: undefined, shape: null };

describe("panToComment", () => {
  const canvas = { w: 800, h: 600 };
  it("keeps the zoom and centres the pin", () => {
    const v = panToComment({ x: 0, y: 0, zoom: 2 }, { x: 100, y: 50 }, 40, canvas);
    expect(v.zoom).toBe(2);
    expect(v.x + 100 * v.zoom).toBe(400);
    expect(v.y + 50 * v.zoom).toBe(300);
  });
  it("goes to 100% only when the layer would be under 8px", () => {
    expect(panToComment({ x: 0, y: 0, zoom: 0.25 }, { x: 10, y: 10 }, 3, canvas).zoom).toBe(1);
    expect(panToComment({ x: 0, y: 0, zoom: 0.25 }, { x: 10, y: 10 }, 40, canvas).zoom).toBe(0.25);
    expect(panToComment({ x: 0, y: 0, zoom: 0.1 }, { x: 10, y: 10 }, 0, canvas).zoom).toBe(0.1);
    expect(panToComment({ x: 0, y: 0, zoom: 16 }, { x: 10, y: 10 }, 1, canvas).zoom).toBe(16);
  });
});

describe("strokeRows", () => {
  it("has nothing without a stroke", () => {
    expect(strokeRows({ ...base, strokes: [] })).toEqual([]);
  });
  it("lists weight, position and dash", () => {
    expect(strokeRows({ ...base, strokeDash: [6, 4] })).toEqual([
      { k: "Weight", v: "2px" },
      { k: "Position", v: "inside" },
      { k: "Dash", v: "Dashed 6, 4" },
    ]);
  });
  it("lists per-side weights when they differ", () => {
    expect(strokeRows({ ...base, strokeWeights: [1, 2, 3, 4] })[0].v).toBe("1 2 3 4px (top right bottom left)");
    expect(strokeRows({ ...base, strokeWeights: [3, 3, 3, 3] })[0].v).toBe("3px");
  });
  it("lists caps for lines", () => {
    const rows = strokeRows({ ...base, shape: { pointCount: 0, innerRadius: 0, startCap: "round", endCap: "none" } });
    expect(rows.at(-1)).toEqual({ k: "Caps", v: "round, none" });
  });
});

describe("constraintsText", () => {
  const c = { constraints: { horizontal: "right", vertical: "top" }, absolutePosition: false };
  it("shows for a child of a frame without layout", () => {
    expect(constraintsText(c, { type: "frame", layout: null })).toBe("Right, Top");
  });
  it("shows for an absolute child of an auto layout frame only", () => {
    const layout = {} as never;
    expect(constraintsText(c, { type: "frame", layout })).toBe("");
    expect(constraintsText({ ...c, absolutePosition: true }, { type: "frame", layout })).toBe("Right, Top");
  });
  it("is empty at the page root or in a group", () => {
    expect(constraintsText(c, null)).toBe("");
    expect(constraintsText(c, { type: "group", layout: null })).toBe("");
  });
});
