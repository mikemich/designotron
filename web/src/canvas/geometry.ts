import type { Mat, Rect } from "../types";
import type { Viewport } from "../store";

export interface Pt {
  x: number;
  y: number;
}

export const apply = (m: Mat, p: Pt): Pt => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });

export function invert(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c || 1e-12;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export const toScreen = (v: Viewport, p: Pt): Pt => ({ x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y });

/** Screen-space corners of a node box (tl, tr, br, bl). */
export function corners(v: Viewport, m: Mat, w: number, h: number): Pt[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ].map((p) => toScreen(v, apply(m, p)));
}

export const polyPoints = (pts: Pt[]) => pts.map((p) => `${p.x},${p.y}`).join(" ");

export function rectCorners(v: Viewport, r: Rect): Pt[] {
  return corners(v, { a: 1, b: 0, c: 0, d: 1, e: r.x, f: r.y }, r.width, r.height);
}

export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Ramer–Douglas–Peucker simplification for pencil strokes. */
export function simplify(points: Pt[], tolerance: number): Pt[] {
  if (points.length < 3) return points;
  const sqTol = tolerance * tolerance;
  const segDist = (p: Pt, a: Pt, b: Pt) => {
    let x = a.x,
      y = a.y,
      dx = b.x - x,
      dy = b.y - y;
    if (dx || dy) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = b.x;
        y = b.y;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }
    dx = p.x - x;
    dy = p.y - y;
    return dx * dx + dy * dy;
  };
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxD = sqTol,
      idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist(points[i], points[first], points[last]);
      if (d > maxD) {
        idx = i;
        maxD = d;
      }
    }
    if (idx > -1) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
