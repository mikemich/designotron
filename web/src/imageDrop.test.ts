import { describe, expect, it } from "vitest";
import { GRID_GAP, gridLayout, pastePlacement, scaledMessage, union, type Box, type Size } from "./imageDrop";

const sizes = (n: number): Size[] => Array.from({ length: n }, (_, i) => ({ width: 40 + ((i * 37) % 90), height: 30 + ((i * 53) % 110) }));

function boxes(s: Size[], at = { x: 500, y: -200 }): Box[] {
  return gridLayout(s, at).map((p, i) => ({ ...p, ...s[i] }));
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("gridLayout", () => {
  it("centres one image on the point", () => {
    expect(gridLayout([{ width: 100, height: 60 }], { x: 300, y: 200 })).toEqual([{ x: 250, y: 170 }]);
  });

  it("puts two images side by side with the gap between them", () => {
    const [a, b] = boxes([{ width: 100, height: 50 }, { width: 80, height: 50 }], { x: 0, y: 0 });
    expect(b.x - (a.x + a.width)).toBe(GRID_GAP);
    expect(a.y).toBe(b.y);
  });

  it.each([1, 2, 3, 12, 60])("lays out %i images without overlaps, centred", (n) => {
    const s = sizes(n);
    const b = boxes(s);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(overlap(b[i], b[j])).toBe(false);
    const u = union(b);
    expect(u.x + u.width / 2).toBeCloseTo(500, 6);
    expect(u.y + u.height / 2).toBeCloseTo(-200, 6);
  });

  it("uses ceil(sqrt(n)) columns, filled left to right", () => {
    const n = 12;
    const b = boxes(sizes(n));
    // 4 columns: the 5th image starts a new row below the first.
    expect(b[4].y).toBeGreaterThan(b[0].y + b[0].height);
    expect(b[3].y).toBe(b[0].y);
    expect(b[4].x).toBe(b[0].x);
  });

  it("spans about 8 columns for 60 images", () => {
    const b = boxes(sizes(60));
    const firstRow = b.filter((x) => x.y === b[0].y).length;
    expect(firstRow).toBe(8);
  });

  it("keeps rows as tall as their tallest image", () => {
    const s: Size[] = [{ width: 10, height: 10 }, { width: 10, height: 90 }, { width: 10, height: 10 }, { width: 10, height: 10 }];
    const b = boxes(s, { x: 0, y: 0 });
    // 2 columns: the second row starts below the 90 px image.
    expect(b[2].y - b[0].y).toBe(90 + GRID_GAP);
  });

  it("returns nothing for nothing", () => {
    expect(gridLayout([], { x: 0, y: 0 })).toEqual([]);
  });
});

describe("pastePlacement", () => {
  const view: Box = { x: 0, y: 0, width: 1000, height: 800 };

  it("centres on a frame that is in view", () => {
    expect(pastePlacement({ x: 100, y: 100, width: 200, height: 100 }, view)).toEqual({ at: { x: 200, y: 150 }, inFrame: true });
  });

  it("counts a frame that is partly in view", () => {
    expect(pastePlacement({ x: 900, y: 700, width: 400, height: 400 }, view).inFrame).toBe(true);
  });

  it("falls back to the view centre when the frame is out of view", () => {
    expect(pastePlacement({ x: 5000, y: 5000, width: 100, height: 100 }, view)).toEqual({ at: { x: 500, y: 400 }, inFrame: false });
  });

  it("falls back to the view centre with no frame", () => {
    expect(pastePlacement(null, view)).toEqual({ at: { x: 500, y: 400 }, inFrame: false });
  });
});

describe("scaledMessage", () => {
  it("counts the images", () => {
    expect(scaledMessage(2, 4096)).toBe("Scaled 2 large images down to 4096 px to keep the file light.");
    expect(scaledMessage(1, 4096)).toBe("Scaled 1 large image down to 4096 px to keep the file light.");
  });
});
