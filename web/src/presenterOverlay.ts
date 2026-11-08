// Pure helpers for closing an overlay in the player: how it leaves, and the vector and
// transform a Close overlay On drag follows.
import { INSTANT, OPPOSITE, type Motion } from "./player";
import type { Vec } from "./smart";

const DIRS: Record<string, Vec> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

const directional = (m: Motion) => m.kind === "slide" || m.kind === "moveIn" || m.kind === "moveOut" || m.kind === "push";

/** How an overlay leaves. The result is `moveOut` (the overlay travels `dir` off screen), `dissolve`
 *  (it fades) or `instant`.
 *  - Reduced motion: instant.
 *  - A close interaction with its own directional transition (only MCP can set one): Move out and
 *    Push leave toward `dir`; Move in and Slide leave back the way they would come in.
 *  - Otherwise the reverse of the opening: an overlay that came in moving `dir` leaves moving the
 *    opposite way, a dissolve or smart animate fades out, an instant one is instant. */
export function closeMotion(opened: Motion, via: Motion | null, reduced: boolean): Motion {
  if (reduced) return INSTANT;
  if (via && directional(via)) {
    const dir = via.kind === "moveOut" || via.kind === "push" ? via.dir : OPPOSITE[via.dir];
    return { ...via, kind: "moveOut", dir };
  }
  if (directional(opened)) return { ...opened, kind: "moveOut", dir: OPPOSITE[opened.dir] };
  if (opened.kind === "dissolve" || opened.kind === "smart") return { ...opened, kind: "dissolve" };
  return INSTANT;
}

/** The CSS animation of the overlay frame that leaves with `m` (undefined: nothing to play). */
export function leaveAnimation(m: Motion): string | undefined {
  if (m.kind === "moveOut") return `dt-out-${m.dir} ${m.ms}ms ${m.easing} both`;
  if (m.kind === "dissolve") return `dt-fade-out ${m.ms}ms ${m.easing} both`;
  return undefined;
}

/** The vector (frame pixels) a drag of a Close overlay follows: the way the overlay leaves, as long
 *  as the overlay is on that axis (`w` across, `h` down). Null when it only fades or is instant. */
export function closeVector(m: Motion, size: { w: number; h: number }): Vec | null {
  if (m.kind !== "moveOut") return null;
  const d = DIRS[m.dir];
  const v = { x: d.x * size.w, y: d.y * size.h };
  return v.x || v.y ? v : null;
}

/** The overlay frame's transform when the drag is at progress `v` (0 open, 1 gone). */
export function dragTransform(vec: Vec, v: number): string {
  return v === 0 ? "" : `translate(${vec.x * v}px, ${vec.y * v}px)`;
}

/** The dim behind an overlay at progress `v` of its closing: `rgba(...)` colours keep their hue and
 *  lose alpha with the drag; anything else (transparent) stays. */
export function dimAt(dim: string, v: number): string {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(dim);
  if (!m) return dim;
  const k = Math.min(1, Math.max(0, 1 - v));
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${Math.round(parseFloat(m[4]) * k * 1000) / 1000})`;
}
