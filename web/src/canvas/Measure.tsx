// Alt-hover measurement and equal-spacing guides, drawn in the canvas overlay.

import { useEffect, useMemo, useState } from "react";
import { query, useStore, type Viewport } from "../store";
import type { Gap, Guide, Mat, Measurement } from "../types";
import { corners, polyPoints, toScreen, type Pt } from "./geometry";

/** Figma's measurement red and spacing pink. */
export const MEASURE_RED = "#f24822";
export const SPACING_PINK = "#f5359d";

// Where the pointer last was (client pixels), so a measurement can appear when Alt goes down
// without the mouse moving.
let lastPointer: Pt | null = null;
export const trackPointer = (e: { clientX: number; clientY: number }) => {
  lastPointer = { x: e.clientX, y: e.clientY };
};

/** Distances from the selection to the layer (or enclosing frame) under the pointer while Alt is held. */
export function Measure({ v, host }: { v: Viewport; host: HTMLElement | null }) {
  const rev = useStore((s) => s.rev);
  const sel = useStore((s) => s.es.selection);
  // The layer the normal hover picked (an instance or group whole, deep with Ctrl/Cmd).
  const hover = useStore((s) => s.hover);
  const [at, setAt] = useState<Pt | null>(lastPointer);
  useEffect(() => {
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      const p = { x: e.clientX, y: e.clientY };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setAt(p));
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);
  const m = useMemo(() => {
    if (!at || !host || !sel.length) return null;
    const r = host.getBoundingClientRect();
    const x = (at.x - r.left - v.x) / v.zoom;
    const y = (at.y - r.top - v.y) / v.zoom;
    return query<Measurement | null>({ q: "measure", ids: sel, target: hover, x, y, zoom: v.zoom });
  }, [rev, at, sel, hover, v.x, v.y, v.zoom, host]);
  const target = useMemo(
    () => (m ? query<{ items: { matrix: Mat; width: number; height: number }[] }>({ q: "bounds", ids: [m.target] }).items[0] : null),
    [m?.target, rev],
  );
  if (!m || !target) return null;
  return (
    <g className="measure" pointerEvents="none">
      <polygon points={polyPoints(corners(v, target.matrix, target.width, target.height))} fill="none" stroke={MEASURE_RED} strokeWidth={1} />
      {m.extends.map((g, i) => (
        <GuideLine key={i} v={v} g={g} />
      ))}
      {m.lines.map((g, i) => (
        <Distance key={i} v={v} g={g} color={MEASURE_RED} />
      ))}
    </g>
  );
}

/** Pink gaps between siblings a drag snapped to. */
export function SpacingGaps({ v, gaps }: { v: Viewport; gaps: Gap[] }) {
  if (!gaps.length) return null;
  return (
    <g className="spacing-gaps" pointerEvents="none">
      {gaps.map((g, i) => (
        <Distance key={i} v={v} g={g} color={SPACING_PINK} />
      ))}
    </g>
  );
}

function GuideLine({ v, g }: { v: Viewport; g: Guide }) {
  const a = toScreen(v, { x: g.x1, y: g.y1 });
  const b = toScreen(v, { x: g.x2, y: g.y2 });
  return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={MEASURE_RED} strokeWidth={1} strokeDasharray="3 3" />;
}

const CAP = 4;

/** A distance line with end caps and a centred label. */
function Distance({ v, g, color }: { v: Viewport; g: Gap; color: string }) {
  const a = toScreen(v, { x: g.x1, y: g.y1 });
  const b = toScreen(v, { x: g.x2, y: g.y2 });
  const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const cap = (p: Pt) => (horizontal ? { x1: p.x, y1: p.y - CAP, x2: p.x, y2: p.y + CAP } : { x1: p.x - CAP, y1: p.y, x2: p.x + CAP, y2: p.y });
  const text = formatDistance(g.value);
  const w = text.length * 6.4 + 10;
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return (
    <g>
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={1} />
      <line {...cap(a)} stroke={color} strokeWidth={1} />
      <line {...cap(b)} stroke={color} strokeWidth={1} />
      <rect x={c.x - w / 2} y={c.y - 8} width={w} height={16} rx={3} fill={color} />
      <text x={c.x} y={c.y} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600} fill="#fff">
        {text}
      </text>
    </g>
  );
}

/** Whole pixels without a decimal point, otherwise one decimal. */
export function formatDistance(value: number): string {
  const r = Math.round(value * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
