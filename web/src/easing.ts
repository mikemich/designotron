// Timing curves of the prototype player: CSS cubic-bezier evaluated in script (so every piece of a
// smart animate, and a drag, reads one clock), the named presets and the custom curve.

import type { Easing, Interaction } from "./types";

export type Bezier = [number, number, number, number];

/** The presets as control points: the CSS keywords and the three Back curves (easings.net). */
export const EASING_BEZIER: Record<Easing, Bezier> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  easeInBack: [0.36, 0, 0.66, -0.56],
  easeOutBack: [0.34, 1.56, 0.64, 1],
  easeInOutBack: [0.68, -0.6, 0.32, 1.6],
};

/** A time-to-progress function. Back curves return values below 0 and above 1. */
export type Ease = (t: number) => number;

export const linear: Ease = (t) => t;

/** CSS `cubic-bezier(x1, y1, x2, y2)` as a function of time: Newton's method with a bisection
 *  fallback, accurate to 1e-6 in x. `t` outside [0, 1] is clamped (the curve starts at 0 and ends at 1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = (s: number) => ((ax * s + bx) * s + cx) * s;
  const Y = (s: number) => ((ay * s + by) * s + cy) * s;
  const dX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const err = X(s) - t;
      if (Math.abs(err) < 1e-7) return Y(s);
      const d = dX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 60; i++) {
      const x = X(s);
      if (Math.abs(x - t) < 1e-7) break;
      if (x < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return Y(s);
  };
}

/** The control points an interaction asks for: its custom curve (x clamped to [0, 1]), else its preset. */
export function bezierOf(it: Pick<Interaction, "easing" | "bezier">): Bezier {
  const b = it.bezier;
  if (b && b.length === 4 && b.every((n) => Number.isFinite(n))) return [clamp01(b[0]), b[1], clamp01(b[2]), b[3]];
  return EASING_BEZIER[it.easing ?? "easeOut"] ?? EASING_BEZIER.easeOut;
}

export const cssBezier = (b: Bezier) => `cubic-bezier(${b[0]}, ${b[1]}, ${b[2]}, ${b[3]})`;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const cache = new Map<string, Ease>();
/** The function for control points (cached: every frame of every tween asks). */
export function easeOf(b: Bezier): Ease {
  const key = b.join(",");
  let f = cache.get(key);
  if (!f) cache.set(key, (f = b[0] === b[1] && b[2] === b[3] ? linear : cubicBezier(...b)));
  return f;
}
