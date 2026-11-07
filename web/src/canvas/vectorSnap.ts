import type { Node } from "../types";
import type { Pt } from "./geometry";

/** How close (screen px) a dragged anchor has to be to another anchor to snap to it. */
export const SNAP_PX = 5;
/** Most anchors considered as snap targets; the rest are skipped (a drag stays cheap on huge files). */
export const MAX_CANDIDATES = 5000;

export type SnapKind = "anchor" | "pixel" | null;

export interface Snapped {
  /** The snapped point (page space). */
  p: Pt;
  kind: SnapKind;
  /** The anchor snapped to, for `kind: "anchor"`. */
  target?: Pt;
}

/**
 * Snaps a point (page space) to the nearest candidate anchor within `SNAP_PX` screen pixels,
 * else to whole page pixels. `off` (the snapping modifier held) leaves it where it is, and
 * `pixel: false` leaves out the whole-pixel step.
 */
export function snapPoint(p: Pt, candidates: readonly Pt[], zoom: number, opts: { pixel?: boolean; off?: boolean } = {}): Snapped {
  if (opts.off) return { p, kind: null };
  const reach = SNAP_PX / (zoom > 0 ? zoom : 1);
  let best: Pt | null = null;
  let bestD = reach;
  for (const c of candidates) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  if (best) return { p: { x: best.x, y: best.y }, kind: "anchor", target: best };
  if (opts.pixel === false) return { p, kind: null };
  return { p: { x: Math.round(p.x), y: Math.round(p.y) }, kind: "pixel" };
}

/** Joins lists of anchors into one candidate list of at most `cap` points (later ones are skipped). */
export function limitCandidates(lists: readonly (readonly Pt[])[], cap = MAX_CANDIDATES): Pt[] {
  const out: Pt[] = [];
  for (const list of lists) {
    for (const q of list) {
      if (out.length >= cap) return out;
      out.push(q);
    }
  }
  return out;
}

/** Whether a layer's stroke has ends: a line, or a vector whose subpaths are all open. */
export function isOpenPath(n: Pick<Node, "type" | "vector"> | undefined): boolean {
  if (!n) return false;
  if (n.type === "line") return true;
  if (n.type !== "vector" || !n.vector || n.vector.raw) return false;
  return n.vector.subpaths.length > 0 && n.vector.subpaths.every((sp) => !sp.closed);
}
