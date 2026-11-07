import { describe, expect, it } from "vitest";
import { isOpenPath, limitCandidates, MAX_CANDIDATES, snapPoint } from "./vectorSnap";

describe("snapPoint", () => {
  it("snaps to an anchor within 5 screen px and wins over the pixel grid", () => {
    const r = snapPoint({ x: 10.3, y: 20.4 }, [{ x: 12.2, y: 20.9 }], 1, { pixel: true });
    expect(r.kind).toBe("anchor");
    expect(r.p).toEqual({ x: 12.2, y: 20.9 });
    expect(r.target).toEqual({ x: 12.2, y: 20.9 });
  });

  it("falls back to whole pixels beyond the reach", () => {
    const r = snapPoint({ x: 10.3, y: 20.6 }, [{ x: 40, y: 40 }], 1, { pixel: true });
    expect(r).toEqual({ p: { x: 10, y: 21 }, kind: "pixel" });
  });

  it("picks the nearest of several anchors", () => {
    const r = snapPoint({ x: 0, y: 0 }, [{ x: 3, y: 0 }, { x: 1, y: 1 }, { x: -2, y: 0 }], 1);
    expect(r.target).toEqual({ x: 1, y: 1 });
  });

  it("scales the reach with the zoom: 5 screen px", () => {
    const cands = [{ x: 4, y: 0 }];
    // At 4x, 4 page px are 16 screen px: out of reach. At 0.5x they are 2 screen px.
    expect(snapPoint({ x: 0, y: 0 }, cands, 4).kind).toBe("pixel");
    expect(snapPoint({ x: 0, y: 0 }, cands, 0.5).kind).toBe("anchor");
    // 1.2 page px at 4x is 4.8 screen px: in; 1.3 is 5.2: out.
    expect(snapPoint({ x: 0, y: 0 }, [{ x: 1.2, y: 0 }], 4).kind).toBe("anchor");
    expect(snapPoint({ x: 0, y: 0 }, [{ x: 1.3, y: 0 }], 4).kind).toBe("pixel");
  });

  it("still rounds to pixels at 0.1x zoom", () => {
    const r = snapPoint({ x: 100.4, y: 200.6 }, [], 0.1);
    expect(r).toEqual({ p: { x: 100, y: 201 }, kind: "pixel" });
  });

  it("does nothing when snapping is off (Ctrl held)", () => {
    const p = { x: 10.3, y: 20.4 };
    expect(snapPoint(p, [{ x: 10.5, y: 20.4 }], 1, { off: true })).toEqual({ p, kind: null });
  });

  it("can leave out the pixel step", () => {
    const p = { x: 10.3, y: 20.4 };
    expect(snapPoint(p, [], 1, { pixel: false })).toEqual({ p, kind: null });
  });
});

describe("limitCandidates", () => {
  it("keeps the order and stops at the cap", () => {
    const a = Array.from({ length: 3000 }, (_, i) => ({ x: i, y: 0 }));
    const b = Array.from({ length: 3000 }, (_, i) => ({ x: i, y: 1 }));
    const out = limitCandidates([a, b]);
    expect(out).toHaveLength(MAX_CANDIDATES);
    expect(out[0]).toBe(a[0]);
    expect(out[3000]).toBe(b[0]);
  });
  it("takes everything below the cap", () => {
    expect(limitCandidates([[{ x: 1, y: 1 }], [{ x: 2, y: 2 }]])).toHaveLength(2);
    expect(limitCandidates([[{ x: 1, y: 1 }], [{ x: 2, y: 2 }]], 1)).toHaveLength(1);
  });
});

describe("isOpenPath", () => {
  const sp = (closed: boolean) => ({ points: [], closed });
  it("is true for lines and fully open vectors", () => {
    expect(isOpenPath({ type: "line", vector: null })).toBe(true);
    expect(isOpenPath({ type: "vector", vector: { subpaths: [sp(false), sp(false)], raw: null } })).toBe(true);
  });
  it("is false when any subpath is closed (a mixed selection shows the position)", () => {
    expect(isOpenPath({ type: "vector", vector: { subpaths: [sp(false), sp(true)], raw: null } })).toBe(false);
    expect(isOpenPath({ type: "vector", vector: { subpaths: [sp(true)], raw: null } })).toBe(false);
  });
  it("is false for imported raw paths, shapes and missing layers", () => {
    expect(isOpenPath({ type: "vector", vector: { subpaths: [], raw: { d: "M0 0", viewBox: [0, 0, 1, 1] } } })).toBe(false);
    expect(isOpenPath({ type: "rectangle", vector: null })).toBe(false);
    expect(isOpenPath(undefined)).toBe(false);
  });
});
