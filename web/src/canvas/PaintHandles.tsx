// Gradient handles on the canvas while a gradient paint's popover is open (W3-D): drag the start,
// end and width points, and the stop markers along the start-to-end line.

import { useEffect, useMemo } from "react";
import { dispatch, getDoc, query, useStore, type Viewport } from "../store";
import type { GradientHandles, Mat, Node, Paint } from "../types";
import { isGradient, type GradientPaint } from "../ui/color";
import { apply, invert, toScreen, type Pt } from "./geometry";

type Edit = NonNullable<ReturnType<typeof useStore.getState>["paintEdit"]>;

export interface PaintTarget {
  edit: Edit;
  node: Node;
  paint: Paint;
  matrix: Mat;
  width: number;
  height: number;
}

type Grab = "start" | "end" | "width" | { stop: number };

/** The paint being edited, when it is still there: dropped as soon as the selection or page moves on. */
export function usePaintTarget(): PaintTarget | null {
  const edit = useStore((s) => s.paintEdit);
  const sel = useStore((s) => s.es.selection);
  const page = useStore((s) => s.es.page);
  const rev = useStore((s) => s.rev);
  const node = edit ? getDoc().nodes[edit.id] : undefined;
  const valid = !!edit && !!node && sel.length === 1 && sel[0] === edit.id && node.page === page;
  useEffect(() => {
    if (edit && !valid) useStore.setState({ paintEdit: null });
  }, [edit, valid]);
  return useMemo(() => {
    if (!edit || !node || !valid) return null;
    const paint = node[edit.key][edit.index];
    if (!paint) return null;
    const b = query<{ items: { matrix: Mat; width: number; height: number }[] }>({ q: "bounds", ids: [edit.id] }).items[0];
    if (!b) return null;
    return { edit, node, paint, matrix: b.matrix, width: b.width, height: b.height };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, valid, rev]);
}

/** Unit-box point under a pointer event for a layer with this matrix and size. */
export function unitAt(ev: { clientX: number; clientY: number }, m: Mat, w: number, h: number): [number, number] {
  const host = document.getElementById("dt-canvas");
  const r = host?.getBoundingClientRect();
  const v = useStore.getState().viewport;
  const page = { x: (ev.clientX - (r?.left ?? 0) - v.x) / v.zoom, y: (ev.clientY - (r?.top ?? 0) - v.y) / v.zoom };
  const local = apply(invert(m), page);
  return [local.x / (w || 1), local.y / (h || 1)];
}

/** Replaces one paint of the layer (the whole list, like the Fill section does). */
export function sendPaint(edit: Edit, paint: Paint) {
  const node = getDoc().nodes[edit.id];
  if (!node) return;
  const list = node[edit.key].map((p, i) => (i === edit.index ? paint : p));
  dispatch({ op: "update", ids: [edit.id], patch: { [edit.key]: list, ...(edit.key === "fills" ? { fillStyle: null } : {}) } });
}

/** One undo step around a pointer drag, inside or outside the popover's own gesture. */
export function dragGesture(onMove: (ev: PointerEvent) => void) {
  // The popover holds a gesture open while it is shown: close it so this drag is its own step.
  const inside = useStore.getState().es.inGesture;
  if (inside) dispatch({ op: "endGesture" });
  dispatch({ op: "beginGesture" });
  const up = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    dispatch({ op: "endGesture" });
    if (inside) dispatch({ op: "beginGesture" });
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** CSS angle (0 = up, 90 = right) of the start to end line in layer pixels, like the engine. */
export function lineAngle(h: GradientHandles, w: number, ht: number): number {
  const deg = (Math.atan2((h.end[0] - h.start[0]) * w, -(h.end[1] - h.start[1]) * ht) * 180) / Math.PI;
  return Math.round((((deg % 360) + 360) % 360) * 100) / 100;
}

/** Handles a gradient draws with: its own, or the ones that reproduce what it shows without any. */
export function handlesOf(p: GradientPaint, w: number, h: number): GradientHandles {
  if (p.handles) return p.handles;
  if (p.type === "linearGradient") {
    const a = (p.angle * Math.PI) / 180;
    const [dx, dy] = [Math.sin(a), -Math.cos(a)];
    const len = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    const at = (k: number): [number, number] => [(w / 2 + dx * len * k) / (w || 1), (h / 2 + dy * len * k) / (h || 1)];
    const [sx, sy] = at(-0.5);
    // The width handle stands off the start point, square to the line, half a line long.
    const wx = sx + (-dy * len * 0.5) / (w || 1);
    const wy = sy + (dx * len * 0.5) / (h || 1);
    return { start: [sx, sy], end: at(0.5), width: [wx, wy] };
  }
  if (p.type === "angularGradient") return { start: [0.5, 0.5], end: [0.5, 0], width: [1, 0.5] };
  return { start: [0.5, 0.5], end: [1, 0.5], width: [0.5, 1] };
}

export function PaintHandles({ v }: { v: Viewport }) {
  const t = usePaintTarget();
  if (!t || !isGradient(t.paint)) return null;
  return <Handles v={v} t={t} paint={t.paint} />;
}

function Handles({ v, t, paint }: { v: Viewport; t: PaintTarget; paint: GradientPaint }) {
  const { width: w, height: h, matrix: m } = t;
  const hd = handlesOf(paint, w, h);
  const scr = (u: [number, number]): Pt => toScreen(v, apply(m, { x: u[0] * w, y: u[1] * h }));
  const [s, e, wd] = [scr(hd.start), scr(hd.end), scr(hd.width)];
  const angular = paint.type === "angularGradient";
  const showWidth = !angular;
  const stopMarkers = !angular;

  function grab(ev: React.PointerEvent, what: Grab) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const base = handlesOf(paint, w, h);
    const px = (u: [number, number]): [number, number] => [u[0] * w, u[1] * h];
    const sendHandles = (nh: GradientHandles) => {
      const np = { ...paint, handles: nh } as GradientPaint;
      // Older editors know only the angle: keep it in step with the line.
      if (np.type === "linearGradient") np.angle = lineAngle(nh, w, h);
      sendPaint(t.edit, np);
    };
    dragGesture((pe) => {
      const u = unitAt(pe, m, w, h);
      if (what === "start") {
        if (paint.type === "linearGradient") sendHandles({ ...base, start: u });
        else {
          // Radial, diamond and angular move as a whole by their centre.
          const d: [number, number] = [u[0] - base.start[0], u[1] - base.start[1]];
          const mv = (p: [number, number]): [number, number] => [p[0] + d[0], p[1] + d[1]];
          sendHandles({ start: u, end: mv(base.end), width: mv(base.width) });
        }
      } else if (what === "end") sendHandles({ ...base, end: u });
      else if (what === "width") sendHandles({ ...base, width: u });
      else {
        const [a, b, q] = [px(base.start), px(base.end), px(u)];
        const [ax, ay] = [b[0] - a[0], b[1] - a[1]];
        const len2 = ax * ax + ay * ay || 1;
        let pos = ((q[0] - a[0]) * ax + (q[1] - a[1]) * ay) / len2;
        // Stops keep their order: a marker stops at its neighbours.
        const lo = what.stop > 0 ? paint.stops[what.stop - 1].position : 0;
        const hi = what.stop < paint.stops.length - 1 ? paint.stops[what.stop + 1].position : 1;
        pos = Math.round(Math.max(lo, Math.min(hi, pos)) * 1000) / 1000;
        sendPaint(t.edit, { ...paint, stops: paint.stops.map((st, i) => (i === what.stop ? { ...st, position: pos } : st)) } as GradientPaint);
      }
    });
  }

  return (
    <svg className="paint-overlay" aria-hidden="true">
      <g data-paint-overlay="" data-keep-popover="" className="paint-handles">
        <line x1={s.x} y1={s.y} x2={e.x} y2={e.y} className="paint-line" />
        {showWidth && <line x1={s.x} y1={s.y} x2={wd.x} y2={wd.y} className="paint-line dashed" />}
        {stopMarkers &&
          paint.stops.map((st, i) => (
            <rect
              key={i}
              data-paint-stop={i}
              className="paint-handle stop"
              x={s.x + (e.x - s.x) * st.position - 5}
              y={s.y + (e.y - s.y) * st.position - 5}
              width={10}
              height={10}
              rx={2}
              fill={st.color}
              onPointerDown={(ev) => grab(ev, { stop: i })}
            />
          ))}
        <circle data-paint-handle="start" className="paint-handle" cx={s.x} cy={s.y} r={5.5} onPointerDown={(ev) => grab(ev, "start")} />
        <circle data-paint-handle="end" className="paint-handle" cx={e.x} cy={e.y} r={5.5} onPointerDown={(ev) => grab(ev, "end")} />
        {showWidth && <circle data-paint-handle="width" className="paint-handle width" cx={wd.x} cy={wd.y} r={4.5} onPointerDown={(ev) => grab(ev, "width")} />}
      </g>
    </svg>
  );
}
