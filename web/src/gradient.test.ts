import { describe, expect, it } from "vitest";
import { addStop, colorAt } from "./gradient";

const bw = [
  { color: "#000000", position: 0 },
  { color: "#FFFFFF", position: 1 },
];

describe("colorAt", () => {
  it("interpolates between neighbouring stops and holds the ends", () => {
    expect(colorAt(bw, 0.5)).toBe("#808080");
    expect(colorAt(bw, 0.25)).toBe("#404040");
    expect(colorAt(bw, -1)).toBe("#000000");
    expect(colorAt(bw, 2)).toBe("#FFFFFF");
    const three = [
      { color: "#FF0000", position: 0 },
      { color: "#00FF00", position: 0.5 },
      { color: "#0000FF", position: 1 },
    ];
    expect(colorAt(three, 0.75)).toBe("#008080");
    expect(colorAt(three, 0.5)).toBe("#00FF00");
  });

  it("interpolates alpha separately and ignores the order stops are listed in", () => {
    const a = [
      { color: "#FFFFFF", position: 1 },
      { color: "#FF000000", position: 0 },
    ];
    expect(colorAt(a, 0.5)).toBe("#FF808080");
    expect(colorAt([{ color: "#123456", position: 0.3 }], 0.9)).toBe("#123456");
  });
});

describe("addStop", () => {
  it("puts the first new stop in the middle and colours it by interpolation", () => {
    const r = addStop(bw);
    expect(r.stops.map((s) => s.position)).toEqual([0, 0.5, 1]);
    expect(r.stops[r.index].color).toBe("#808080");
    expect(r.index).toBe(1);
  });

  it("splits the widest gap next, and the first of equal gaps", () => {
    const first = addStop(bw);
    const second = addStop(first.stops);
    expect(second.stops.map((s) => s.position)).toEqual([0, 0.25, 0.5, 1]);
    expect(second.index).toBe(1);
    const uneven = addStop([
      { color: "#000000", position: 0 },
      { color: "#FF0000", position: 0.2 },
      { color: "#FFFFFF", position: 1 },
    ]);
    expect(uneven.stops[uneven.index].position).toBe(0.6);
  });

  it("takes the click position, clamped, and works with one stop", () => {
    const r = addStop(bw, 0.8);
    expect(r.stops[r.index]).toEqual({ color: "#CCCCCC", position: 0.8 });
    expect(addStop(bw, 4).stops[2].position).toBe(1);
    const one = addStop([{ color: "#336699", position: 0 }]);
    expect(one.stops[one.index]).toEqual({ color: "#336699", position: 0.5 });
  });
});
