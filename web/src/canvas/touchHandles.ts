import type { Pt } from "./geometry";

/** A finger lands within this many screen px of a resize handle and resizes (44 px zone). */
export const TOUCH_HANDLE_RADIUS = 22;
/** On a box with a short side under this, the middle moves the layer: handles only count close up. */
export const SMALL_BOX_SIDE = 44;
/** Inside a small box a handle counts only this close. */
export const SMALL_BOX_RADIUS = 8;
/** A touch outside the box and this close to a corner rotates. */
export const ROTATE_RING = 48;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Whether `p` is inside the convex quad `q` (corners in order, either winding). */
function inside(p: Pt, q: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c === 0) continue;
    if (sign && Math.sign(c) !== sign) return false;
    sign = Math.sign(c);
  }
  return true;
}

/** What a touch at `pt` (screen px) grabs on a selection box: the nearest resize handle within the
 * touch zone (resize beats rotate), "rotate" in the ring outside a corner, else null (the caller
 * falls back to what is under the finger). `corners` are the box's four corners in screen space,
 * so a rotated box works as is. */
export function pickTouchHandle<H extends string>(pt: Pt, handles: { h: H; p: Pt }[], corners: Pt[]): H | "rotate" | null {
  if (corners.length !== 4 || !handles.length) return null;
  const shortSide = Math.min(dist(corners[0], corners[1]), dist(corners[1], corners[2]));
  const within = inside(pt, corners);
  // Inside a small box the reach also stays under a quarter of its short side, so the middle of a 10 px layer
  // (5 px from its edge handles) is never a handle.
  const reach = within && shortSide < SMALL_BOX_SIDE ? Math.min(SMALL_BOX_RADIUS, shortSide / 4) : TOUCH_HANDLE_RADIUS;
  let best: { h: H; d: number } | null = null;
  for (const { h, p } of handles) {
    const d = dist(pt, p);
    if (!best || d < best.d) best = { h, d };
  }
  if (best && best.d <= reach) return best.h;
  if (!within && !(best && best.d <= TOUCH_HANDLE_RADIUS) && corners.some((c) => dist(pt, c) <= ROTATE_RING)) return "rotate";
  return null;
}
