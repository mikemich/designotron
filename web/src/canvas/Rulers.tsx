// Rulers, page guides and layout grid overlay.

import { useMemo, useState } from "react";
import { dispatch, getDoc, hasLayoutGrids, query, useStore } from "../store";
import type { Rect, RulerGuide } from "../types";

type View = { x: number; y: number; zoom: number };
export const RULER = 20;

interface GridItem {
  frameId: string;
  color: string;
  frame: Rect;
  bands?: Rect[];
  cell?: number;
}

/** Column/row bands and square grids of visible frames (page coordinates → screen). */
export function GridOverlay({ v }: { v: View }) {
  // Layout grids belong to the document: selecting layers must not recompute them.
  const docRev = useStore((s) => s.es.docRev);
  const page = useStore((s) => s.es.page);
  const items = useMemo(() => (hasLayoutGrids() ? query<GridItem[]>({ q: "gridOverlay" }) : []), [docRev, page]);
  if (!items.length) return null;
  return (
    <g className="grid-overlay">
      {items.map((g, i) => {
        const f = g.frame;
        if (g.bands)
          return g.bands.map((b, j) => (
            <rect key={`${i}-${j}`} x={b.x * v.zoom + v.x} y={b.y * v.zoom + v.y} width={b.width * v.zoom} height={b.height * v.zoom} fill={g.color} />
          ));
        const step = (g.cell ?? 8) * v.zoom;
        if (step < 4) return null;
        const id = `dt-grid-${i}`;
        return (
          <g key={i}>
            <defs>
              <pattern id={id} x={f.x * v.zoom + v.x} y={f.y * v.zoom + v.y} width={step} height={step} patternUnits="userSpaceOnUse">
                <path d={`M ${step} 0 L 0 0 0 ${step}`} fill="none" stroke={g.color} strokeWidth={1} />
              </pattern>
            </defs>
            <rect x={f.x * v.zoom + v.x} y={f.y * v.zoom + v.y} width={f.width * v.zoom} height={f.height * v.zoom} fill={`url(#${id})`} />
          </g>
        );
      })}
    </g>
  );
}

function pageGuides(): RulerGuide[] {
  const doc = getDoc();
  return doc.pages.find((p) => p.id === useStore.getState().es.page)?.guides ?? [];
}

function setGuides(guides: RulerGuide[]) {
  dispatch({ op: "setGuides", guides });
}

/** Screen position → page coordinate on one axis. */
const toPage = (v: View, axis: "x" | "y", screen: number) => Math.round((screen - (axis === "x" ? v.x : v.y)) / v.zoom);

/** Page guides: drag to move, drag back onto a ruler to delete. */
export function PageGuides({ v, width, height }: { v: View; width: number; height: number }) {
  useStore((s) => s.es.docRev);
  const [dragging, setDragging] = useState<{ index: number; pos: number } | null>(null);
  const guides = pageGuides();
  return (
    <g className="page-guides">
      {guides.map((g, i) => {
        const pos = dragging?.index === i ? dragging.pos : g.position;
        const s = g.axis === "x" ? pos * v.zoom + v.x : pos * v.zoom + v.y;
        const line = g.axis === "x" ? { x1: s, y1: 0, x2: s, y2: height } : { x1: 0, y1: s, x2: width, y2: s };
        return (
          <g key={i}>
            <line {...line} stroke="#f24822" strokeWidth={1} />
            <line
              {...line}
              data-guide={i}
              className="handle"
              stroke="transparent"
              strokeWidth={7}
              style={{ cursor: g.axis === "x" ? "ew-resize" : "ns-resize" }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                (e.target as Element).setPointerCapture(e.pointerId);
                setDragging({ index: i, pos: g.position });
              }}
              onPointerMove={(e) => {
                if (dragging?.index !== i) return;
                e.stopPropagation();
                const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setDragging({ index: i, pos: toPage(v, g.axis, g.axis === "x" ? e.clientX - r.left : e.clientY - r.top) });
              }}
              onPointerUp={(e) => {
                if (dragging?.index !== i) return;
                e.stopPropagation();
                const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                const screen = g.axis === "x" ? e.clientX - r.left : e.clientY - r.top;
                const next = [...guides];
                if (screen < RULER && useStore.getState().showRulers) next.splice(i, 1);
                else next[i] = { ...g, position: dragging.pos };
                setDragging(null);
                setGuides(next);
              }}
            />
            {dragging?.index === i && (
              <text x={line.x1 + 4} y={g.axis === "x" ? 34 : line.y1 - 4} className="guide-label">
                {dragging.pos}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** Pixel step between labelled ticks so labels stay ~50px+ apart. */
function tickStep(zoom: number): number {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  return steps.find((s) => s * zoom >= 50) ?? 10000;
}

/** Top and left rulers. Drag out of a ruler to create a guide. */
export function Rulers({ v, width, height, selection }: { v: View; width: number; height: number; selection: Rect | null }) {
  const [creating, setCreating] = useState<{ axis: "x" | "y"; pos: number } | null>(null);
  const step = tickStep(v.zoom);

  const ticks = (axis: "x" | "y", len: number) => {
    const offset = axis === "x" ? v.x : v.y;
    const first = Math.floor(-offset / v.zoom / step) * step;
    const out: number[] = [];
    for (let p = first; p * v.zoom + offset < len; p += step) out.push(p);
    return out;
  };

  const start = (axis: "x" | "y") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setCreating({ axis, pos: NaN });
  };
  const move = (e: React.PointerEvent) => {
    if (!creating) return;
    e.stopPropagation();
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const screen = creating.axis === "x" ? e.clientX - r.left : e.clientY - r.top;
    setCreating({ ...creating, pos: screen < RULER ? NaN : toPage(v, creating.axis, screen) });
  };
  const end = (e: React.PointerEvent) => {
    if (!creating) return;
    e.stopPropagation();
    if (!Number.isNaN(creating.pos)) setGuides([...pageGuides(), { axis: creating.axis, position: creating.pos }]);
    setCreating(null);
  };

  const band = (axis: "x" | "y") => {
    if (!selection) return null;
    const a = axis === "x" ? selection.x * v.zoom + v.x : selection.y * v.zoom + v.y;
    const len = (axis === "x" ? selection.width : selection.height) * v.zoom;
    return axis === "x" ? <rect x={a} y={0} width={len} height={RULER} className="ruler-sel" /> : <rect x={0} y={a} width={RULER} height={len} className="ruler-sel" />;
  };

  // A vertical guide (axis x) is dragged out of the left ruler, a horizontal one out of the top ruler.
  return (
    <>
      <svg className="ruler top" width={width} height={RULER} onPointerDown={start("y")} onPointerMove={move} onPointerUp={end}>
        {band("x")}
        {ticks("x", width).map((p) => {
          const x = p * v.zoom + v.x;
          return (
            <g key={p}>
              <line x1={x} y1={RULER - 6} x2={x} y2={RULER} />
              <text x={x + 3} y={10}>
                {p}
              </text>
            </g>
          );
        })}
      </svg>
      <svg className="ruler left" width={RULER} height={height} onPointerDown={start("x")} onPointerMove={move} onPointerUp={end}>
        {band("y")}
        {ticks("y", height).map((p) => {
          const y = p * v.zoom + v.y;
          return (
            <g key={p}>
              <line x1={RULER - 6} y1={y} x2={RULER} y2={y} />
              <text x={10} y={y + 3} transform={`rotate(-90 10 ${y + 3})`}>
                {p}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="ruler-corner" />
      {creating && !Number.isNaN(creating.pos) && (
        <svg className="guide-preview" width={width} height={height}>
          {creating.axis === "x" ? (
            <line x1={creating.pos * v.zoom + v.x} y1={0} x2={creating.pos * v.zoom + v.x} y2={height} stroke="#f24822" />
          ) : (
            <line x1={0} y1={creating.pos * v.zoom + v.y} x2={width} y2={creating.pos * v.zoom + v.y} stroke="#f24822" />
          )}
        </svg>
      )}
    </>
  );
}
