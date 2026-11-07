import { describe, expect, it } from "vitest";
import { pickTouchHandle } from "./touchHandles";
import type { Pt } from "./geometry";

type H = "nw" | "ne" | "se" | "sw" | "n" | "e" | "s" | "w";
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const handlesOf = (c: Pt[]): { h: H; p: Pt }[] => [
  { h: "nw", p: c[0] },
  { h: "ne", p: c[1] },
  { h: "se", p: c[2] },
  { h: "sw", p: c[3] },
  { h: "n", p: mid(c[0], c[1]) },
  { h: "e", p: mid(c[1], c[2]) },
  { h: "s", p: mid(c[2], c[3]) },
  { h: "w", p: mid(c[3], c[0]) },
];
const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const pick = (pt: Pt, c: Pt[]) => pickTouchHandle(pt, handlesOf(c), c);

describe("pickTouchHandle", () => {
  const box = rect(100, 100, 200, 120);
  const se = box[2];

  it("resizes from 0, 6, 14 and 20 px off the SE corner, in any direction", () => {
    for (const off of [0, 6, 14, 20]) {
      expect(pick({ x: se.x + off, y: se.y }, box)).toBe("se");
      expect(pick({ x: se.x, y: se.y + off }, box)).toBe("se");
      expect(pick({ x: se.x - off, y: se.y - off / 4 }, box)).toBe("se");
    }
    expect(pick({ x: se.x + 14, y: se.y + 14 }, box)).toBe("se");
  });

  it("rotates 30 px out along the diagonal", () => {
    const d = 30 / Math.SQRT2;
    expect(pick({ x: se.x + d, y: se.y + d }, box)).toBe("rotate");
  });

  it("gives nothing far from the box, or in the middle of a big one", () => {
    expect(pick({ x: se.x + 80, y: se.y + 80 }, box)).toBeNull();
    expect(pick({ x: 200, y: 160 }, box)).toBeNull();
  });

  it("picks an edge handle", () => {
    expect(pick({ x: 200, y: 100 - 15 }, box)).toBe("n");
    expect(pick({ x: 300 + 10, y: 160 }, box)).toBe("e");
  });

  it("lets a small box move from the middle", () => {
    const small = rect(100, 100, 30, 30);
    expect(pick({ x: 115, y: 115 }, small)).toBeNull();
    expect(pick({ x: 100 + 4, y: 100 + 4 }, small)).toBe("nw");
    // Outside the box the full zone applies.
    expect(pick({ x: 130 + 15, y: 130 + 15 }, small)).toBe("se");
  });

  it("works on a rotated box in screen space", () => {
    const a = Math.PI / 6;
    const c = box.map((p) => ({ x: 200 + (p.x - 200) * Math.cos(a) - (p.y - 160) * Math.sin(a), y: 160 + (p.x - 200) * Math.sin(a) + (p.y - 160) * Math.cos(a) }));
    expect(pick({ x: c[2].x + 6, y: c[2].y + 6 }, c)).toBe("se");
    const out = { x: c[2].x + (c[2].x - 200) * 0.2, y: c[2].y + (c[2].y - 160) * 0.2 };
    expect(Math.hypot(out.x - c[2].x, out.y - c[2].y)).toBeGreaterThan(22);
    expect(pick(out, c)).toBe("rotate");
  });

  it("ignores boxes without handles", () => {
    expect(pickTouchHandle({ x: 0, y: 0 }, [], box)).toBeNull();
  });
});
