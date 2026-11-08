import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Handle, Mat, Node, Rect, VectorPoint } from "../types";
import {
  describeSelection,
  dispatch,
  emptyPromptKey,
  getDoc,
  pointerDrag,
  noteZooming,
  query,
  renderPageIncremental,
  screenToPage,
  selection,
  setTool,
  toast,
  useStore,
  zoomBy,
} from "../store";
import { apply, corners, invert, mid, polyPoints, rectCorners, simplify, toScreen, type Pt } from "./geometry";
import { editTextAt, openTextGesture, TextEditor } from "./TextEditor";
import { EmptyPrompt } from "./EmptyPrompt";
import { GridOverlay, PageGuides, Rulers } from "./Rulers";
import { CommentLayer } from "./Comments";
import { Measure, SpacingGaps, trackPointer } from "./Measure";
import { RemoteCursors, RemoteSelections } from "./RemoteCursors";
import { PaintHandles } from "./PaintHandles";
import { pickTouchHandle } from "./touchHandles";
import { CropMode } from "./CropMode";
import { FollowFrame } from "./FollowFrame";
import { CursorChat } from "./CursorChat";
import { GuestBar } from "../panels/GuestBar";
import { reportCursor, useCollab } from "../collab";
import { assetUrl, noteRemoteImage } from "../assets";
import { imagesIn } from "../imageAssets";
import { getScaleStrokes, insertImageFile, insertSvgFile, joinVectorEnds, openDtronFile, pasteData, placeImageSource, toggleVectorPointSmooth, vectorPoints } from "../actions";
import { canvasMenu, insideInstance } from "./contextMenu";
import { limitCandidates, MAX_CANDIDATES, snapPoint } from "./vectorSnap";
import { pickColorAt } from "./eyedropper";
import { useDemo } from "../Demo";
import { isMac, Menu, type MenuItem } from "../ui/controls";
import { isOverlayLink, newInteraction } from "../prototype";

/** Half-size (screen px) of a vector anchor's hit area; it shrinks to a quarter of the gap to a close
 *  neighbour (never below the minimum) so the middle of a short segment can still take a point. */
const ANCHOR_HIT = 4;
const ANCHOR_HIT_MIN = 1;
/** Radius (screen px) of a drawn vector anchor: a circle, so it can't pass for a selection handle (a square). */
const ANCHOR_R = 4;
/** Radius (screen px) of a control handle's hit area; the drawn circle is smaller. */
const HANDLE_HIT = 5;
/** Below this screen distance to a neighbouring anchor, control handles show only for selected anchors. */
const CROWDED_ANCHOR_GAP = 12;
/** Segments shorter than this (screen px) are duplicate anchors, not neighbours. */
const MIN_SEGMENT_GAP = 0.5;

interface BoundsItem {
  id: string;
  matrix: Mat;
  width: number;
  height: number;
  bounds: Rect;
}

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "move"; start: Pt; ids: string[]; started: boolean; alt: boolean; clickSelect: string | null; shiftToggle: string | null; dropAt?: Pt }
  | { kind: "resize"; handle: Handle; start: Pt; ids: string[]; scale: boolean; /** The Scale tool's "Scale strokes" option, read once when the drag starts. */ scaleStrokes: boolean }
  | { kind: "rotate"; pivot: Pt; startAngle: number; ids: string[] }
  | { kind: "marquee"; start: Pt; base: string[] }
  | { kind: "draw"; start: Pt; cur: Pt }
  | { kind: "pencil"; points: Pt[] }
  | { kind: "penHandle"; index: number; /** The incoming handle once Alt breaks the mirror (kept for the rest of the drag). */ broken: Pt | null }
  | { kind: "vector"; id: string; sub: number; idx: number; part: "anchor" | "in" | "out" | "pull"; pts: [number, number][]; startLocal: Pt; start: Node; moved: boolean; cands: Pt[] }
  | { kind: "bend"; id: string; sub: number; seg: number; t: number; start: Pt; /** The grabbed point on the curve (page space). */ hit: Pt; moved: boolean }
  | { kind: "vmarquee"; id: string; start: Pt; base: [number, number][]; hitId: string | null; moved: boolean }
  | { kind: "link"; from: string; cur: Pt };

/** Cmd (Mac) or Ctrl held: a drag on a path segment bends it instead of adding an anchor. */
const bendModifier = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

/** The point on a path nearest the pointer (`vectorSegmentAt` query, page coordinates). */
interface SegmentHit {
  sub: number;
  seg: number;
  t: number;
  x: number;
  y: number;
}

let labelCtx: CanvasRenderingContext2D | null | undefined;
const labelWidths = new Map<string, number>();
// Widths measured before the web font loaded are wrong; measure again once it has.
if (typeof document !== "undefined" && document.fonts) {
  document.fonts.addEventListener("loadingdone", () => labelWidths.clear());
}
/** `text` cut with an ellipsis to fit `maxW` pixels at the frame label's size; null under 24 px. */
function fitLabel(text: string, maxW: number): string | null {
  if (maxW < 24) return null;
  if (labelCtx === undefined) {
    labelCtx = document.createElement("canvas").getContext("2d");
    // The label's real font: the page's family at the label's size.
    if (labelCtx) labelCtx.font = `11px ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
  }
  // Every frame's label is measured on every render: widths are cached by string.
  const w = (t: string) => {
    let v = labelWidths.get(t);
    if (v === undefined) {
      if (labelWidths.size > 5000) labelWidths.clear();
      v = labelCtx ? labelCtx.measureText(t).width : t.length * 6;
      labelWidths.set(t, v);
    }
    return v;
  };
  if (w(text) <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (w(text.slice(0, mid) + "…") <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo).trimEnd() + "…" : "…";
}

/** A vector projected onto the nearest 45 degree direction. */
function snap45(v: Pt, on: boolean): Pt {
  if (!on) return v;
  const a = Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4)) * (Math.PI / 4);
  const d = { x: Math.cos(a), y: Math.sin(a) };
  const len = v.x * d.x + v.y * d.y;
  return { x: d.x * len, y: d.y * len };
}

/** The open path end the pen tool continues from, with its outgoing handle (page space). */
interface PenFrom {
  id: string;
  sub: number;
  prepend: boolean;
  anchor: VectorPoint;
  /** The path's other end: clicking it closes the path. */
  other: Pt | null;
}

const HANDLE_CURSORS: Record<Handle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

/** Text smaller than this on screen (px) is drawn as bars, not glyphs. */
const MIN_TEXT_PX = 5;
/** While zooming a page with more than this many text layers in view, text is drawn as bars. */
const ZOOM_TEXT_BUDGET = 400;
/** Roots this far (screen px) outside the canvas still stay in the DOM, so panning doesn't pop. */
const CULL_MARGIN = 300;

/** Size classes of canvas text, as in `TEXT_SIZE_STEPS` in render.rs. */
const TEXT_SIZE_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256];

/** For each level `lod-L` on the canvas, text of the size classes up to step L is hidden and
 * its bars shown. The sheet never changes: rewriting one makes the browser restyle every
 * element, while switching a class on the canvas only restyles the text. */
const LOD_CSS = TEXT_SIZE_STEPS.map((_, level) => {
  const upTo = TEXT_SIZE_STEPS.slice(0, level + 1);
  return `${upTo.map((n) => `.dt-content.lod-${level} text.s${n}`).join(",")}{display:none}${upTo.map((n) => `.dt-content.lod-${level} path.g${n}`).join(",")}{display:inline}`;
}).join("");

/** The highest `lod-L` level whose text classes are all under MIN_TEXT_PX at this zoom (-1: none). */
function lodLevel(zoom: number): number {
  let level = -1;
  while (level + 1 < TEXT_SIZE_STEPS.length && TEXT_SIZE_STEPS[level + 1] * zoom < MIN_TEXT_PX) level++;
  return level;
}

/** How long the selection must stay put before it is announced to screen readers. */
const ANNOUNCE_DELAY_MS = 300;
/** A finger held this long (ms) without moving past the slop (px) opens the canvas menu. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;

const keys = { space: false };
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !(e.target as HTMLElement).matches("input, textarea, [contenteditable]")) keys.space = true;
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") keys.space = false;
});

export function Canvas() {
  const ref = useRef<HTMLDivElement>(null);
  const rev = useStore((s) => s.rev);
  const v = useStore((s) => s.viewport);
  const tool = useStore((s) => s.tool);
  const page = useStore((s) => s.es.page);
  const sel = useStore((s) => s.es.selection);
  const hover = useStore((s) => s.hover);
  const editingText = useStore((s) => s.editingText);
  // Sections of the demo replay still waiting to appear.
  const demoHidden = useDemo((s) => s.hidden);
  const editingVector = useStore((s) => s.editingVector);
  const guides = useStore((s) => s.guides);
  const gaps = useStore((s) => s.gaps);
  const marquee = useStore((s) => s.marquee);
  const rightTab = useStore((s) => s.rightTab);
  const dropTarget = useStore((s) => s.dropTarget);
  const dropLine = useStore((s) => s.dropLine);
  const showRulers = useStore((s) => s.showRulers);
  const showGrids = useStore((s) => s.showGrids);
  const docRev = useStore((s) => s.es.docRev);
  const zooming = useStore((s) => s.zooming);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // The same size without re-rendering (reading clientWidth after DOM writes forces a layout).
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const drag = useRef<Drag | null>(null);
  const [draw, setDraw] = useState<{ start: Pt; cur: Pt } | null>(null);
  const [pen, setPen] = useState<VectorPoint[]>([]);
  const [penCursor, setPenCursor] = useState<Pt | null>(null);
  const penLast = useRef<Pt | null>(null);
  // The anchor a dragged point or a new pen point is snapping to (page space).
  const [snapMark, setSnapMark] = useState<Pt | null>(null);
  // Anchors of the page's top-level vectors, for the pen (per document revision).
  const penCands = useRef<{ key: string; pts: Pt[] } | null>(null);
  // Pen continuing an open path from one of its ends.
  const [penFrom, setPenFrom] = useState<PenFrom | null>(null);
  // Vector edit mode: the point on the path under the pointer (where a click adds an anchor).
  const [vHover, setVHover] = useState<SegmentHit | null>(null);
  /** The pointer is over a segment that a drag would bend (Bend on, or the modifier held). */
  const [bendReady, setBendReady] = useState(false);
  const lastInsert = useRef<{ key: string; time: number } | null>(null);
  const vectorPts = useStore((s) => s.vectorPoints);
  const [pencil, setPencil] = useState<Pt[] | null>(null);
  const [link, setLink] = useState<{ from: string; cur: Pt } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [panning, setPanning] = useState(false);
  // The long-press menu: the latest `openLongPressMenu`, and when it last opened.
  const longPress = useRef<(x: number, y: number) => void>(() => {});
  const longPressAt = useRef(0);
  /** What a finger at a client point grabs of the selection box (set each render, read by the pointer handlers). */
  const touchPick = useRef<(x: number, y: number) => Handle | "rotate" | null | undefined>(() => undefined);
  /** The touch handlers' hold timer and drag abort, for the native context menu and pointercancel. */
  const holdControl = useRef<{ cancel: () => void; abort: () => void } | null>(null);
  // Alt held with nothing being dragged: show distances from the selection to the hovered layer.
  const [alt, setAlt] = useState(false);
  const measuring = alt && tool === "move" && sel.length > 0 && !editingText && !editingVector;

  const doc = getDoc();
  const pageObj = doc.pages.find((p) => p.id === page) ?? doc.pages[0];
  // Canvas content is patched per top-level layer: only changed roots are re-rendered and replaced.
  const contentRef = useRef<SVGGElement>(null);
  // `load` doesn't bubble, so the canvas listens in the capture phase: an http(s) image that has loaded
  // tells the engine its size (tiled fills lay out by it).
  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;
    const onLoad = (e: Event) => {
      const href = (e.target as Element | null)?.getAttribute?.("href");
      if (href) noteRemoteImage(href);
    };
    host.addEventListener("load", onLoad, true);
    return () => host.removeEventListener("load", onLoad, true);
  }, []);
  const rootEls = useRef(new Map<string, SVGGElement>());
  // What each root paints (page space) and how many text layers it has, from the engine, so
  // roots far outside the view can be left out of the layout and painting.
  const rootInfo = useRef(new Map<string, { b: Rect; texts: number }>());
  const culled = useRef(new Set<string>());
  /** Hides roots outside the view and turns on the cheap zoom look when the view is heavy. */
  const applyView = () => {
    const host = contentRef.current;
    if (!host) return;
    const { viewport: vp, zooming: z } = useStore.getState();
    const { w, h } = sizeRef.current;
    // Before the first measurement everything counts as in view.
    const x0 = w ? (-CULL_MARGIN - vp.x) / vp.zoom : -Infinity;
    const y0 = h ? (-CULL_MARGIN - vp.y) / vp.zoom : -Infinity;
    const x1 = w ? (w + CULL_MARGIN - vp.x) / vp.zoom : Infinity;
    const y1 = h ? (h + CULL_MARGIN - vp.y) / vp.zoom : Infinity;
    let texts = 0;
    for (const [id, g] of rootEls.current) {
      const info = rootInfo.current.get(id);
      const show = !info || (info.b.x < x1 && info.b.x + info.b.width > x0 && info.b.y < y1 && info.b.y + info.b.height > y0);
      if (show) texts += info?.texts ?? 0;
      if (show === culled.current.has(id)) {
        if (show) {
          culled.current.delete(id);
          g.removeAttribute("display");
        } else {
          culled.current.add(id);
          g.setAttribute("display", "none");
        }
      }
    }
    host.classList.toggle("zoom-lod", z && texts > ZOOM_TEXT_BUDGET);
  };
  useLayoutEffect(() => {
    const host = contentRef.current;
    if (!host) return;
    // A stopped engine can't draw: the canvas keeps what it has on screen.
    if (useStore.getState().engineFailed) return;
    const fresh = rootEls.current.size === 0;
    // The text being edited is drawn live (all its lines, mixed styles); its textarea is only the input.
    const r = renderPageIncremental(page, demoHidden, fresh, editingText ?? "");
    if ("full" in r) {
      rootEls.current.clear();
      rootInfo.current.clear();
      culled.current.clear();
      host.innerHTML = r.full;
      return;
    }
    if (fresh) {
      host.innerHTML = "";
      rootInfo.current.clear();
      culled.current.clear();
    }
    const els = rootEls.current;
    const live = new Set(r.order);
    for (const [id, el] of els) {
      if (!live.has(id)) {
        el.remove();
        els.delete(id);
        rootInfo.current.delete(id);
        culled.current.delete(id);
      }
    }
    for (const id in r.bounds) {
      const [x, y, width, height] = r.bounds[id];
      const prev = rootInfo.current.get(id);
      rootInfo.current.set(id, { b: { x, y, width, height }, texts: id in r.texts ? r.texts[id] : (prev?.texts ?? 0) });
    }
    const want = r.order.map((id) => {
      let el = els.get(id);
      if (!el) {
        el = document.createElementNS("http://www.w3.org/2000/svg", "g");
        el.dataset.root = id;
        els.set(id, el);
      }
      if (id in r.changed) el.innerHTML = r.changed[id];
      else if (id in r.moved) el.querySelector(":scope > g[data-id]")?.setAttribute("transform", r.moved[id]);
      return el;
    });
    for (const c of Array.from(host.children)) if (!els.has((c as SVGGElement).dataset?.root ?? "")) c.remove();
    // Reorder with as few DOM moves as possible: re-inserting a root forces the browser to
    // lay it out again, so keep the longest run already in order and move only the rest.
    const index = new Map(Array.from(host.children).map((c, i) => [c, i]));
    const keep = longestIncreasingRun(want.map((el) => index.get(el) ?? -1));
    for (let i = want.length - 1; i >= 0; i--) {
      if (!keep.has(i)) host.insertBefore(want[i], want[i + 1] ?? null);
    }
    applyView();
  }, [rev, page, editingText, demoHidden]);

  // Panning and zooming change what is in view; zooming also switches the cheap look.
  useLayoutEffect(applyView, [v.x, v.y, v.zoom, size.w, size.h, zooming]);

  // The text level of detail follows the zoom once it settles: switching it restyles every
  // text layer, and while zooming a big page they are already drawn as bars (`zoom-lod`).
  const lodRef = useRef(-1);
  if (!zooming) lodRef.current = lodLevel(v.zoom);
  const lod = lodRef.current;
  const selKey = sel.join(",");
  const selItems = useMemo(() => query<{ items: BoundsItem[]; union: Rect | null }>({ q: "bounds", ids: sel }), [rev, selKey]);

  // Screen readers hear what got selected ("Button (frame) 120×40, 2 of 5 in Card"): worked out once
  // the selection has settled, never while a drag is running, and only when it changes.
  const liveRef = useRef<HTMLDivElement>(null);
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (announced.current === null) {
      announced.current = selKey;
      return;
    }
    if (announced.current === selKey) return;
    // A drag that began meanwhile holds it back; it is tried again until the gesture ends.
    let t: ReturnType<typeof setTimeout>;
    const announce = () => {
      if (useStore.getState().es.inGesture) {
        t = setTimeout(announce, ANNOUNCE_DELAY_MS);
        return;
      }
      if (!liveRef.current) return;
      announced.current = selKey;
      liveRef.current.textContent = describeSelection();
    };
    t = setTimeout(announce, ANNOUNCE_DELAY_MS);
    return () => clearTimeout(t);
  }, [selKey]);
  const hoverItem = useMemo(() => (hover && !sel.includes(hover) ? query<{ items: BoundsItem[] }>({ q: "bounds", ids: [hover] }).items[0] : null), [rev, hover, sel]);
  const topFrames = useMemo(() => {
    const ids = (pageObj?.children ?? []).filter((id) => {
      const n = doc.nodes[id];
      return n && n.visible && ["frame", "component", "componentSet", "instance"].includes(n.type);
    });
    return query<{ items: BoundsItem[] }>({ q: "bounds", ids }).items;
  }, [docRev, page]);

  // Wheel zoom/pan needs a non-passive listener.
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomBy(Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top);
      } else {
        const { viewport } = useStore.getState();
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        useStore.setState({ viewport: { ...viewport, x: viewport.x - dx, y: viewport.y - dy } });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Touch: two fingers pinch to zoom and pan. Runs before the tools' handlers and keeps the
  // gesture to itself until every finger is lifted. A second finger cancels what the first one
  // had started (a move, resize or rotate goes back to where it was, the selection too), and a
  // single finger held still for 500 ms opens the canvas menu like a right-click.
  useEffect(() => {
    const el = ref.current!;
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; mx: number; my: number; v: { x: number; y: number; zoom: number } } | null = null;
    let swallow = false;
    /** The hold fired for the finger that is down: its lift must not click through to the menu. */
    let fired = false;
    /** The first finger: where it went down, what was selected then, and the hold timer. */
    let first: { id: number; x: number; y: number; sel: string[]; target: Element; timer: number } | null = null;
    const local = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      return { x: x - r.left, y: y - r.top };
    };
    const measure = () => {
      const [a, b] = [...touches.values()];
      const m = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: m.x, my: m.y };
    };
    const stopHold = () => {
      if (first) clearTimeout(first.timer);
    };
    /** Ends whatever the first finger had started, as if it never touched. */
    const abortDrag = (restoreSelection: boolean) => {
      const d = drag.current;
      drag.current = null;
      pointerDrag.active = false;
      if (d) {
        if ((d.kind === "move" && d.started) || d.kind === "resize" || d.kind === "rotate" || d.kind === "vector" || d.kind === "bend") dispatch({ op: "cancelGesture" });
        if (d.kind === "marquee" || d.kind === "vmarquee") useStore.setState({ marquee: null });
        if (d.kind === "draw") setDraw(null);
        if (d.kind === "pencil") setPencil(null);
        if (d.kind === "vector") setSnapMark(null);
        if (d.kind === "link") setLink(null);
        if (d.kind === "penHandle") setPen((p) => p.slice(0, d.index));
        if (d.kind === "pan") setPanning(false);
      }
      useStore.setState({ guides: [], gaps: [], dropTarget: null, dropLine: null });
      if (restoreSelection && useStore.getState().draftComment) useStore.setState({ draftComment: null });
      if (first) {
        if (restoreSelection) {
          const cur = useStore.getState().es.selection;
          const before = first.sel;
          if (cur.length !== before.length || cur.some((id, i) => id !== before[i])) dispatch({ op: "select", ids: before });
        }
      }
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      // A first finger starts afresh: a lift that was missed can't leave a ghost finger behind.
      if (e.isPrimary) {
        stopHold();
        touches.clear();
        pinch = null;
        swallow = false;
        fired = false;
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 1) {
        const t = e.target as Element;
        first = { id: e.pointerId, x: e.clientX, y: e.clientY, sel: [...useStore.getState().es.selection], target: t, timer: 0 };
        // Only the drawing surface: inputs, prompts and popovers on the canvas keep the browser's menu.
        const onCanvas = (t === el || !!t.closest?.("svg.dt-content, svg.overlay")) && !t.closest?.("[data-paint-overlay], [data-handle], [data-rotate], [data-vpt], [data-link]") && !touchPick.current(e.clientX, e.clientY);
        const st = useStore.getState();
        if (onCanvas && st.tool === "move" && !st.editingText && !st.editingVector) {
          const at = { x: e.clientX, y: e.clientY };
          first.timer = window.setTimeout(() => {
            if (touches.size !== 1) return;
            fired = true;
            abortDrag(false);
            longPress.current(at.x, at.y);
          }, LONG_PRESS_MS);
        }
      }
      if (touches.size === 2) {
        stopHold();
        abortDrag(true);
        pinch = { ...measure(), v: { ...useStore.getState().viewport } };
        swallow = true;
      }
      if (swallow) e.stopPropagation();
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (first && e.pointerId === first.id && Math.hypot(e.clientX - first.x, e.clientY - first.y) > LONG_PRESS_SLOP) stopHold();
      if (!swallow) return;
      e.stopPropagation();
      if (!pinch || touches.size < 2) return;
      const now = measure();
      const zoom = Math.min(64, Math.max(0.02, (pinch.v.zoom * now.d) / pinch.d));
      // Keep the page point that was under the fingers' midpoint under the new midpoint.
      const px = (pinch.mx - pinch.v.x) / pinch.v.zoom;
      const py = (pinch.my - pinch.v.y) / pinch.v.zoom;
      noteZooming();
      useStore.setState({ viewport: { zoom, x: now.mx - px * zoom, y: now.my - py * zoom } });
    };
    const upAnywhere = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      up(e);
    };
    const up = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      stopHold();
      if (touches.size < 2) pinch = null;
      if (swallow) e.stopPropagation();
      if (touches.size === 0) {
        swallow = false;
        first = null;
        if (fired) {
          // The click the browser may synthesise for this lift must not hit the menu under the finger.
          fired = false;
          const stop = (ev: Event) => {
            ev.stopPropagation();
            ev.preventDefault();
            done();
          };
          const done = () => {
            clearTimeout(t);
            window.removeEventListener("click", stop, true);
          };
          const t = window.setTimeout(done, 150);
          window.addEventListener("click", stop, true);
        }
      }
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move, true);
    // The lift may land off the canvas (the menu opens under the finger, a pinch drifts onto a panel).
    window.addEventListener("pointerup", upAnywhere, true);
    window.addEventListener("pointercancel", upAnywhere, true);
    holdControl.current = { cancel: stopHold, abort: () => abortDrag(false) };
    return () => {
      stopHold();
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", upAnywhere, true);
      window.removeEventListener("pointercancel", upAnywhere, true);
    };
  }, []);

  // Pen tool: Enter/Escape finishes the path.
  useEffect(() => {
    if (tool !== "pen") {
      if (pen.length) setPen([]);
      if (penFrom) setPenFrom(null);
      setSnapMark(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        finishPen(false);
      }
    };
    // The preview follows Shift going down or up without the pointer moving.
    const onShift = (e: KeyboardEvent) => {
      if (e.key === "Shift" && penLast.current) setPenCursor(penSnap(penLast.current, e.type === "keydown", e.ctrlKey));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onShift);
    window.addEventListener("keyup", onShift);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onShift);
      window.removeEventListener("keyup", onShift);
    };
  }, [tool, pen, penFrom]);

  useEffect(() => {
    const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.matches?.("input, textarea, select, [contenteditable]");
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Alt" && !typing(e) && !drag.current) setAlt(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      setAlt(false);
      // Releasing Alt on its own would otherwise focus the browser menu bar.
      if (!typing(e) && useStore.getState().es.selection.length) e.preventDefault();
    };
    const off = () => setAlt(false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", off);
    };
  }, []);

  useEffect(() => {
    setVHover(null);
    setBendReady(false);
    if (!editingVector) return;
    // Capture phase, before the global Escape shortcut closes vector edit (and this effect with it):
    // an Escape mid-drag takes a bend or anchor drag back. It stops nothing and changes no store state.
    const onCancel = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const d = drag.current;
      if (d && (d.kind === "bend" || d.kind === "vector")) {
        drag.current = null;
        pointerDrag.active = false;
        dispatch({ op: "cancelGesture" });
        setSnapMark(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useStore.setState({ editingVector: null });
      // Enter leaves too: selectChildren (the Enter shortcut) toggles vector edit.
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        // A field or a dialog keeps its own keys.
        const t = e.target;
        if (t instanceof Element && (t.matches("input, textarea, select, [contenteditable]") || t.closest("[role=dialog], [role=menu]"))) return;
        e.preventDefault();
        joinVectorEnds();
      }
    };
    window.addEventListener("keydown", onCancel, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onCancel, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [editingVector]);

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pagePt = (e: { clientX: number; clientY: number }): Pt => {
    const l = local(e);
    return screenToPage(l.x, l.y);
  };
  const zoom = () => useStore.getState().viewport.zoom;

  function finishPen(closed: boolean) {
    if (penFrom) {
      if (pen.length || closed) dispatch({ op: "extendVector", id: penFrom.id, sub: penFrom.sub, prepend: penFrom.prepend, points: pen, close: closed });
      setPenFrom(null);
    } else if (pen.length >= 2) dispatch({ op: "createVector", points: pen, closed, parent: null });
    setPen([]);
    setSnapMark(null);
    setTool("move");
  }

  /** Starts dragging an anchor (with the other selected anchors) or a handle of the edited vector. */
  function startVectorDrag(id: string, sub: number, idx: number, part: "anchor" | "in" | "out" | "pull", p: Pt) {
    const n = getDoc().nodes[id];
    const m = query<{ items: BoundsItem[] }>({ q: "bounds", ids: [id] }).items[0];
    const pts = part === "anchor" ? vectorPoints() : [];
    const cands = part === "anchor" ? vectorSnapTargets(n, m.matrix, pts.some(([s, i]) => s === sub && i === idx) ? pts : [[sub, idx]]) : [];
    drag.current = { kind: "vector", id, sub, idx, part, pts, startLocal: apply(invert(m.matrix), p), start: n, moved: false, cands };
  }

  /** Page-space anchors of the top-level (or same-parent) vectors beside `exclude`: snap targets. */
  function siblingAnchors(parent: string | null, exclude: string | null): Pt[] {
    const doc = getDoc();
    const ids = (parent ? doc.nodes[parent]?.children : doc.pages.find((pg) => pg.id === page)?.children) ?? [];
    const vecs = ids.filter((id) => {
      const o = doc.nodes[id];
      return id !== exclude && o?.type === "vector" && !!o.vector && !o.vector.raw && o.visible && !o.locked;
    });
    if (!vecs.length) return [];
    const items = query<{ items: BoundsItem[] }>({ q: "bounds", ids: vecs }).items;
    // Stop at the cap rather than building every point first.
    const out: Pt[] = [];
    for (const it of items) {
      for (const sp of doc.nodes[it.id]?.vector?.subpaths ?? []) {
        for (const pt of sp.points) {
          if (out.length >= MAX_CANDIDATES) return out;
          out.push(apply(it.matrix, pt));
        }
      }
    }
    return out;
  }

  /** Snap targets for dragging anchors of `n`: its anchors that stay put, then its siblings' anchors. */
  function vectorSnapTargets(n: Node, matrix: Mat, moving: [number, number][]): Pt[] {
    const skip = new Set(moving.map(([s, i]) => `${s}:${i}`));
    const own = (n.vector?.subpaths ?? []).flatMap((sp, s) => sp.points.flatMap((pt, i) => (skip.has(`${s}:${i}`) ? [] : [apply(matrix, pt)])));
    return limitCandidates([own, siblingAnchors(n.parent, n.id)]);
  }

  /** A new pen point: with Shift, on a 45 degree step from the previous anchor. */
  function penSnap(p: Pt, shift: boolean, ctrl = false): Pt {
    const prev = pen.length ? pen[pen.length - 1] : penFrom?.anchor;
    if (shift && prev) {
      // The 45 degree step is exact: no anchor or pixel snapping on top of it.
      setSnapMark(null);
      const v = snap45({ x: p.x - prev.x, y: p.y - prev.y }, true);
      return { x: prev.x + v.x, y: prev.y + v.y };
    }
    if (ctrl) {
      setSnapMark(null);
      return p;
    }
    // The anchors of the page's top-level vectors (not the path being drawn: a point a few pixels
    // from the last one is meant to be there, and closing is the click on the first point), else
    // whole pixels.
    const key = `${page}:${useStore.getState().es.docRev}`;
    if (penCands.current?.key !== key) penCands.current = { key, pts: siblingAnchors(null, null) };
    const sn = snapPoint(p, penCands.current.pts, zoom(), { pixel: true });
    setSnapMark(sn.kind === "anchor" ? sn.target ?? null : null);
    return sn.p;
  }

  /** An open end of a selected (or edited) path that `near` accepts, for the pen to continue. */
  function openEndAt(near: (q: Pt) => boolean): PenFrom | null {
    const doc = getDoc();
    const ids = [...new Set([...(editingVector ? [editingVector] : []), ...selection()])];
    for (const id of ids) {
      const n = doc.nodes[id];
      if (n?.type !== "vector" || !n.vector || n.vector.raw) continue;
      const m = query<{ items: BoundsItem[] }>({ q: "bounds", ids: [id] }).items[0]?.matrix;
      if (!m) continue;
      const vec = (q: Pt) => ({ x: m.a * q.x + m.c * q.y, y: m.b * q.x + m.d * q.y });
      for (const [sub, sp] of n.vector.subpaths.entries()) {
        if (sp.closed || sp.points.length < 2) continue;
        const first = sp.points[0];
        const last = sp.points[sp.points.length - 1];
        for (const prepend of [false, true]) {
          const end = prepend ? first : last;
          const a = apply(m, end);
          if (!near(a)) continue;
          // The handle pointing away from the path, so the preview curves like the result.
          const h = vec(prepend ? { x: end.inX, y: end.inY } : { x: end.outX, y: end.outY });
          return { id, sub, prepend, anchor: { x: a.x, y: a.y, inX: 0, inY: 0, outX: h.x, outY: h.y }, other: apply(m, prepend ? last : first) };
        }
      }
    }
    return null;
  }

  function startMove(e: React.PointerEvent, p: Pt, id: string | null) {
    const st = useStore.getState();
    const current = st.es.selection;
    let clickSelect: string | null = null;
    let shiftToggle: string | null = null;
    if (id) {
      // Shift on an unselected layer adds it now (and the drag moves the whole selection); on a
      // selected one it removes it on release, unless the press turned into a drag.
      if (e.shiftKey) {
        if (!current.includes(id)) dispatch({ op: "select", ids: [id], mode: "toggle" });
        else shiftToggle = id;
      } else if (!current.includes(id)) dispatch({ op: "select", ids: [id] });
      else if (current.length > 1) clickSelect = id;
    }
    const ids = selection().filter((s) => !getDoc().nodes[s]?.locked);
    if (!ids.length) return;
    drag.current = { kind: "move", start: p, ids, started: false, alt: e.altKey, clickSelect, shiftToggle };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button === 2) return;
    // Gradient handles and the crop frame run their own drags.
    if ((e.target as Element).closest?.("[data-paint-overlay]")) return;
    ref.current!.focus();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = pagePt(e);
    const target = e.target as Element;
    const st = useStore.getState();
    if (st.editingText) return;
    setAlt(false);

    if (e.button === 1 || keys.space || tool === "hand") {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: st.viewport.x, vy: st.viewport.y };
      setPanning(true);
      return;
    }

    let handle = target.getAttribute("data-handle") as Handle | null;
    let rotating = target.hasAttribute("data-rotate");
    // A finger is wide: the nearest handle in a 44 px zone wins over what is under it, and the
    // rotate ring only starts outside that zone. A mouse keeps the exact DOM target.
    // With handles up, the pick replaces the DOM target (null: neither, so the layer moves), except on the
    // prototype link dot, which sits beside the e handle.
    if ((e.pointerType === "touch" || e.pointerType === "pen") && !target.closest?.("[data-link]")) {
      const pick = touchPick.current(e.clientX, e.clientY);
      if (pick !== undefined) {
        handle = pick === "rotate" ? null : pick;
        rotating = pick === "rotate";
      }
    }
    if (handle) {
      dispatch({ op: "beginGesture" });
      drag.current = { kind: "resize", handle, start: p, ids: [...sel], scale: tool === "scale", scaleStrokes: getScaleStrokes() };
      return;
    }
    if (rotating) {
      const u = selItems.union;
      if (!u) return;
      const pivot = { x: u.x + u.width / 2, y: u.y + u.height / 2 };
      dispatch({ op: "beginGesture" });
      drag.current = { kind: "rotate", pivot, startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x), ids: [...sel] };
      return;
    }
    const linkFrom = target.getAttribute("data-link");
    if (linkFrom) {
      drag.current = { kind: "link", from: linkFrom, cur: p };
      setLink({ from: linkFrom, cur: p });
      return;
    }
    const vpt = target.getAttribute("data-vpt");
    if (vpt && editingVector) {
      const [sub, idx, part] = vpt.split(":");
      if (part === "anchor") {
        const key: [number, number] = [+sub, +idx];
        const cur = vectorPoints();
        const has = cur.some(([s, i]) => s === key[0] && i === key[1]);
        if (e.shiftKey) {
          useStore.setState({ vectorPoints: has ? cur.filter(([s, i]) => s !== key[0] || i !== key[1]) : [...cur, key] });
          if (has) return;
        } else if (!has) useStore.setState({ vectorPoints: [key] });
      }
      dispatch({ op: "beginGesture" });
      // With Bend on, a plain drag on an anchor pulls mirrored handles out of it (the modifier keeps the move).
      const pull = part === "anchor" && st.vectorBend && !bendModifier(e) && !e.shiftKey;
      startVectorDrag(editingVector, +sub, +idx, pull ? "pull" : (part as "anchor" | "in" | "out"), p);
      return;
    }
    if (editingVector && tool === "move") {
      // Click on the path: add an anchor there (and drag it, all one undo step).
      const hit = query<SegmentHit | null>({ q: "vectorSegmentAt", id: editingVector, x: p.x, y: p.y, zoom: zoom() });
      if (hit && (st.vectorBend || bendModifier(e))) {
        // Bend: drag the segment itself, so the curve follows the pointer.
        dispatch({ op: "beginGesture" });
        drag.current = { kind: "bend", id: editingVector, sub: hit.sub, seg: hit.seg, t: hit.t, start: p, hit: { x: hit.x, y: hit.y }, moved: false };
        setVHover(null);
        return;
      }
      if (hit) {
        dispatch({ op: "beginGesture" });
        const r = dispatch<{ index: number }>({ op: "insertVectorPoint", id: editingVector, sub: hit.sub, seg: hit.seg, t: hit.t });
        if (!r) {
          dispatch({ op: "endGesture" });
          return;
        }
        useStore.setState({ vectorPoints: [[hit.sub, r.index]] });
        lastInsert.current = { key: `${hit.sub}:${r.index}`, time: Date.now() };
        setVHover(null);
        startVectorDrag(editingVector, hit.sub, r.index, "anchor", p);
        return;
      }
      // Anywhere else: select anchors with a marquee. A plain click is decided on release,
      // from the layer under it (a frame behind the path must not take the drag).
      const hitId = query<string | null>({ q: "pick", x: p.x, y: p.y, zoom: zoom(), deep: false });
      drag.current = { kind: "vmarquee", id: editingVector, start: p, base: e.shiftKey ? vectorPoints() : [], hitId, moved: false };
      return;
    }
    const labelId = target.getAttribute("data-label");
    if (labelId) {
      startMove(e, p, labelId);
      return;
    }

    switch (tool) {
      case "eyedropper":
        void pickColorAt(p, zoom());
        break;
      case "scale":
      case "move": {
        if (editingVector) {
          useStore.setState({ editingVector: null });
        }
        const id = query<string | null>({ q: "pick", x: p.x, y: p.y, zoom: zoom(), deep: e.metaKey || e.ctrlKey });
        if (id) startMove(e, p, id);
        else {
          if (!e.shiftKey) dispatch({ op: "select", ids: [] });
          drag.current = { kind: "marquee", start: p, base: e.shiftKey ? [...selection()] : [] };
        }
        break;
      }
      case "pen": {
        const l = local(e);
        const near = (q: Pt) => {
          const s = toScreen(st.viewport, q);
          return Math.hypot(s.x - l.x, s.y - l.y) < 8;
        };
        if (penFrom) {
          // Clicking the path's other end closes it.
          if (penFrom.other && near(penFrom.other)) {
            finishPen(true);
            return;
          }
        } else if (pen.length >= 2 && near(pen[0])) {
          finishPen(true);
          return;
        } else if (!pen.length) {
          // Clicking an open end of a selected path continues it.
          const end = openEndAt(near);
          if (end) {
            setPenFrom(end);
            return;
          }
        }
        const np = penSnap(p, e.shiftKey, e.ctrlKey);
        setPen([...pen, { x: np.x, y: np.y, inX: 0, inY: 0, outX: 0, outY: 0 }]);
        drag.current = { kind: "penHandle", index: pen.length, broken: null };
        break;
      }
      case "pencil":
        drag.current = { kind: "pencil", points: [p] };
        setPencil([p]);
        break;
      case "comment": {
        const node = query<string | null>({ q: "pick", x: p.x, y: p.y, zoom: zoom(), deep: true });
        useStore.setState({ draftComment: { x: p.x, y: p.y, node }, openComment: null });
        break;
      }
      default:
        drag.current = { kind: "draw", start: p, cur: p };
        setDraw({ start: p, cur: p });
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const p = pagePt(e);
    reportCursor(p);
    trackPointer(e);
    if (!d && e.altKey !== alt) setAlt(e.altKey);
    if (!d) {
      if (editingVector && tool === "move") {
        const onPoint = (e.target as Element).hasAttribute?.("data-vpt");
        const hit = onPoint ? null : query<SegmentHit | null>({ q: "vectorSegmentAt", id: editingVector, x: p.x, y: p.y, zoom: zoom() });
        if (hit?.x !== vHover?.x || hit?.y !== vHover?.y) setVHover(hit);
        const ready = !!hit && (useStore.getState().vectorBend || bendModifier(e));
        if (ready !== bendReady) setBendReady(ready);
        if (useStore.getState().hover) useStore.setState({ hover: null });
        return;
      }
      if (tool === "move" && !useStore.getState().editingText) {
        const id = query<string | null>({ q: "pick", x: p.x, y: p.y, zoom: zoom(), deep: e.metaKey || e.ctrlKey });
        if (id !== useStore.getState().hover) useStore.setState({ hover: id });
      }
      if (tool === "pen") {
        penLast.current = p;
        setPenCursor(penSnap(p, e.shiftKey, e.ctrlKey));
      }
      return;
    }
    switch (d.kind) {
      case "pan":
        useStore.setState({ viewport: { ...useStore.getState().viewport, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy } });
        break;
      case "move": {
        const dx = p.x - d.start.x;
        const dy = p.y - d.start.y;
        if (!d.started) {
          if (Math.hypot(dx, dy) * zoom() < 3) return;
          d.started = true;
          d.clickSelect = null;
          d.shiftToggle = null;
          dispatch({ op: "beginGesture" });
          if (d.alt) {
            // Alt-drag duplicates in place, then moves the copies. Rebasing makes the drag move
            // the copies while undo still goes back to before the paste: one undo step.
            const doc = getDoc();
            const data = query<string>({ q: "copy", ids: d.ids });
            const parent = doc.nodes[d.ids[0]]?.parent ?? null;
            const b = query<{ union: Rect | null }>({ q: "bounds", ids: d.ids }).union;
            const r = pasteData({ data, parent, x: b?.x ?? null, y: b?.y ?? null });
            if (r) d.ids = r.created;
            dispatch({ op: "rebaseGesture" });
          }
          useStore.setState({ hover: null });
        }
        // Shift locks the move to the dominant axis; the engine snaps only along the free one.
        const axis = e.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? "x" : "y") : undefined;
        const r = dispatch<{ guides: any[]; gaps: any[] }>({ op: "translate", ids: d.ids, dx, dy, snap: !e.ctrlKey, zoom: zoom(), axis }, { quiet: true });
        // With the axis locked the layers sit at the locked delta, so the drop target is looked up there.
        const tp = axis === "x" ? { x: p.x, y: d.start.y } : axis === "y" ? { x: d.start.x, y: p.y } : p;
        d.dropAt = tp;
        const target = query<string | null>({ q: "frameAt", x: tp.x, y: tp.y, exclude: d.ids });
        // A layer about to enter an auto layout frame shows where it will land.
        const slot = target ? query<{ line: [number, number, number, number] } | null>({ q: "dropSlot", ids: d.ids, x: tp.x, y: tp.y }) : null;
        useStore.setState({ guides: r?.guides ?? [], gaps: r?.gaps ?? [], dropTarget: target, dropLine: slot?.line ?? null });
        break;
      }
      case "resize": {
        const r = dispatch<{ guides: any[]; gaps: any[] }>(
          { op: "resize", ids: d.ids, handle: d.handle, dx: p.x - d.start.x, dy: p.y - d.start.y, keepAspect: e.shiftKey, fromCenter: e.altKey, snap: !e.ctrlKey, zoom: zoom(), scale: d.scale, scaleStrokes: d.scaleStrokes },
          { quiet: true },
        );
        useStore.setState({ guides: r?.guides ?? [], gaps: r?.gaps ?? [] });
        break;
      }
      case "rotate": {
        let angle = ((Math.atan2(p.y - d.pivot.y, p.x - d.pivot.x) - d.startAngle) * 180) / Math.PI;
        if (e.shiftKey) angle = Math.round(angle / 15) * 15;
        dispatch({ op: "rotate", ids: d.ids, angle, pivotX: d.pivot.x, pivotY: d.pivot.y }, { quiet: true });
        break;
      }
      case "marquee": {
        const r: Rect = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), width: Math.abs(p.x - d.start.x), height: Math.abs(p.y - d.start.y) };
        useStore.setState({ marquee: r });
        const ids = query<string[]>({ q: "marquee", ...r });
        dispatch({ op: "select", ids: [...new Set([...d.base, ...ids])] });
        break;
      }
      case "draw":
        d.cur = p;
        setDraw({ start: d.start, cur: p });
        break;
      case "pencil": {
        const last = d.points[d.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * zoom() > 2) {
          d.points.push(p);
          setPencil([...d.points]);
        }
        break;
      }
      case "penHandle": {
        setPen((pts) => {
          const a = pts[d.index];
          if (!a) return pts;
          const out = snap45({ x: p.x - a.x, y: p.y - a.y }, e.shiftKey);
          if (Math.hypot(out.x, out.y) * zoom() < 3) return pts;
          // Alt breaks the mirror: the incoming handle stays as it was when Alt went down (and
          // stays so if Alt is let go), only the outgoing one follows the pointer.
          if (e.altKey && !d.broken) d.broken = { x: a.inX, y: a.inY };
          const inn = d.broken ?? { x: -out.x, y: -out.y };
          return pts.map((pt, i) => (i === d.index ? { ...pt, outX: out.x, outY: out.y, inX: inn.x, inY: inn.y } : pt));
        });
        break;
      }
      case "vector": {
        const m = query<{ items: BoundsItem[] }>({ q: "bounds", ids: [d.id] }).items[0];
        const lp = apply(invert(m.matrix), p);
        const dx = lp.x - d.startLocal.x;
        const dy = lp.y - d.startLocal.y;
        if (!d.moved) {
          if (Math.hypot(dx, dy) * zoom() < 2) return;
          d.moved = true;
        }
        const vec = structuredClone(d.start.vector!);
        const pt = vec.subpaths[d.sub].points[d.idx];
        const orig = d.start.vector!.subpaths[d.sub].points[d.idx];
        if (d.part === "anchor") {
          // The dragged anchor snaps (to another anchor, else to whole pixels, in page space) and
          // every selected anchor moves by its snapped delta. Ctrl drags freely.
          const sn = snapPoint(apply(m.matrix, { x: orig.x + dx, y: orig.y + dy }), d.cands, zoom(), { pixel: true, off: e.ctrlKey || e.metaKey });
          const back = apply(invert(m.matrix), sn.p);
          const clean = (v: number) => Math.round(v * 1e6) / 1e6;
          const sdx = sn.kind ? clean(back.x - orig.x) : dx;
          const sdy = sn.kind ? clean(back.y - orig.y) : dy;
          setSnapMark(sn.kind === "anchor" ? sn.target ?? null : null);
          // Every selected anchor moves together (the dragged one is always among them).
          const moving = d.pts.some(([s, i]) => s === d.sub && i === d.idx) ? d.pts : [[d.sub, d.idx] as [number, number]];
          for (const [s, i] of moving) {
            const o = d.start.vector!.subpaths[s]?.points[i];
            const q = vec.subpaths[s]?.points[i];
            if (!o || !q) continue;
            q.x = o.x + sdx;
            q.y = o.y + sdy;
          }
        } else if (d.part === "pull") {
          // Bend on an anchor: the pointer is the out handle's tip, the in handle mirrors it.
          pt.outX = lp.x - orig.x;
          pt.outY = lp.y - orig.y;
          pt.inX = -pt.outX;
          pt.inY = -pt.outY;
        } else if (d.part === "out") {
          pt.outX = orig.outX + dx;
          pt.outY = orig.outY + dy;
          if (!e.altKey) {
            pt.inX = -pt.outX;
            pt.inY = -pt.outY;
          }
        } else {
          pt.inX = orig.inX + dx;
          pt.inY = orig.inY + dy;
          if (!e.altKey) {
            pt.outX = -pt.inX;
            pt.outY = -pt.inY;
          }
        }
        dispatch({ op: "update", ids: [d.id], patch: { vector: vec } }, { quiet: true });
        break;
      }
      case "bend": {
        if (!d.moved) {
          if (Math.hypot(p.x - d.start.x, p.y - d.start.y) * zoom() < 2) return;
          d.moved = true;
        }
        dispatch({ op: "bendVectorSegment", id: d.id, sub: d.sub, seg: d.seg, t: d.t, x: d.hit.x + (p.x - d.start.x), y: d.hit.y + (p.y - d.start.y) }, { quiet: true });
        break;
      }
      case "vmarquee": {
        if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) * zoom() < 3) return;
        d.moved = true;
        const r: Rect = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), width: Math.abs(p.x - d.start.x), height: Math.abs(p.y - d.start.y) };
        useStore.setState({ marquee: r });
        const n = getDoc().nodes[d.id];
        const m = query<{ items: BoundsItem[] }>({ q: "bounds", ids: [d.id] }).items[0]?.matrix;
        if (!n?.vector || !m) break;
        const inside: [number, number][] = [];
        n.vector.subpaths.forEach((sp, s) =>
          sp.points.forEach((pt, i) => {
            const a = apply(m, pt);
            if (a.x >= r.x && a.x <= r.x + r.width && a.y >= r.y && a.y <= r.y + r.height) inside.push([s, i]);
          }),
        );
        const baseKeys = new Set(d.base.map(([s, i]) => `${s}:${i}`));
        const fresh = inside.filter(([s, i]) => !baseKeys.has(`${s}:${i}`));
        useStore.setState({ vectorPoints: [...d.base, ...fresh] });
        break;
      }
      case "link":
        d.cur = p;
        setLink({ from: d.from, cur: p });
        break;
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    setAlt(e.altKey);
    if (!d) return;
    const p = pagePt(e);
    switch (d.kind) {
      case "move":
        if (d.started) {
          dispatch({ op: "dropInto", ids: d.ids, x: d.dropAt?.x ?? p.x, y: d.dropAt?.y ?? p.y }, { quiet: true });
          dispatch({ op: "endGesture" });
        } else if (d.clickSelect) {
          dispatch({ op: "select", ids: [d.clickSelect] });
        } else if (d.shiftToggle) {
          dispatch({ op: "select", ids: [d.shiftToggle], mode: "toggle" });
        }
        useStore.setState({ guides: [], gaps: [], dropTarget: null, dropLine: null });
        break;
      case "resize":
      case "rotate":
        dispatch({ op: "endGesture" });
        useStore.setState({ guides: [], gaps: [] });
        break;
      case "vector":
        setSnapMark(null);
        // Points may have left the layer's box: refit it in the same undo step.
        if (d.moved) dispatch({ op: "fitVectorBounds", id: d.id }, { quiet: true });
        dispatch({ op: "endGesture" });
        break;
      case "bend":
        dispatch({ op: "endGesture" });
        break;
      case "vmarquee":
        useStore.setState({ marquee: null });
        if (!d.moved && !e.shiftKey) {
          // A click off the path clears the anchors. Another layer under it takes over the
          // selection; empty canvas with no anchors selected leaves edit mode.
          const nodes = getDoc().nodes;
          const ancestors = new Set<string>([d.id]);
          for (let a = nodes[d.id]?.parent; a; a = nodes[a]?.parent) ancestors.add(a);
          if (d.hitId && !ancestors.has(d.hitId)) {
            useStore.setState({ editingVector: null });
            dispatch({ op: "select", ids: [d.hitId] });
          } else if (vectorPoints().length || d.hitId) useStore.setState({ vectorPoints: [] });
          else {
            useStore.setState({ editingVector: null });
            dispatch({ op: "select", ids: [] });
          }
        }
        break;
      case "marquee":
        useStore.setState({ marquee: null });
        break;
      case "draw":
        setDraw(null);
        createFromDrag(d.start, p, e.shiftKey, e.altKey);
        break;
      case "pencil": {
        setPencil(null);
        const pts = simplify(d.points, 1.5 / zoom());
        if (pts.length >= 2) {
          // Round line ends, set in the same undo step (a stroke's ends are flat unless it says otherwise).
          dispatch({ op: "beginGesture" });
          const r = dispatch<{ id: string }>({ op: "createVector", points: pts.map((q) => ({ x: q.x, y: q.y, inX: 0, inY: 0, outX: 0, outY: 0 })), closed: false, parent: null });
          if (r?.id) dispatch({ op: "update", ids: [r.id], patch: { shape: { startCap: "round", endCap: "round" } } });
          dispatch({ op: "endGesture" });
        }
        break;
      }
      case "link": {
        setLink(null);
        const frames = getDoc().pages.find((pg) => pg.id === page)?.children ?? [];
        const hit = query<string | null>({ q: "frameAt", x: p.x, y: p.y, exclude: [d.from] });
        const top = hit ? getDoc() && (frames.includes(hit) ? hit : findTop(hit)) : null;
        if (top && top !== d.from) {
          dispatch({
            op: "addInteraction",
            id: d.from,
            interaction: newInteraction(top),
          });
        }
        break;
      }
    }
  }

  function findTop(id: string): string {
    const doc = getDoc();
    let cur = doc.nodes[id];
    while (cur?.parent) cur = doc.nodes[cur.parent];
    return cur?.id ?? id;
  }

  function createFromDrag(start: Pt, end: Pt, shift: boolean, alt: boolean) {
    const z = zoom();
    const clicked = Math.hypot(end.x - start.x, end.y - start.y) * z < 3;
    if (tool === "text") {
      if (clicked) {
        // A click on an existing text edits it, with the caret where you clicked.
        const hit = query<string | null>({ q: "pick", x: start.x, y: start.y, zoom: z, deep: true });
        const hn = hit ? getDoc().nodes[hit] : null;
        if (hn && hn.type === "text" && hn.visible && !hn.locked) {
          dispatch({ op: "select", ids: [hn.id] });
          editTextAt(hn.id, start);
          setTool("move");
          return;
        }
      }
      openTextGesture();
      const r = dispatch<{ id: string }>({ op: "createText", x: start.x, y: start.y, characters: "", parent: null });
      if (!r) dispatch({ op: "endGesture" });
      if (r) {
        if (!clicked) {
          dispatch({ op: "update", ids: [r.id], patch: { width: Math.abs(end.x - start.x), text: { autoResize: "height" } } });
        }
        useStore.setState({ editingText: r.id });
      }
      setTool("move");
      return;
    }
    if (tool === "line" || tool === "arrow") {
      const e2 = clicked ? { x: start.x + 100, y: start.y } : end;
      let dx = e2.x - start.x;
      let dy = e2.y - start.y;
      if (shift) {
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        dx = Math.cos(a) * len;
        dy = Math.sin(a) * len;
      }
      const len = Math.hypot(dx, dy);
      const cx = start.x + dx / 2;
      const cy = start.y + dy / 2;
      dispatch({ op: "beginGesture" });
      const r = dispatch<{ id: string }>({ op: "createShape", kind: "line", x: start.x, y: start.y, width: len, height: 0, parent: null });
      if (r) {
        const parentM = getDoc().nodes[r.id]?.parent;
        let lc = { x: cx, y: cy };
        if (parentM) lc = apply(invert(query<{ items: BoundsItem[] }>({ q: "bounds", ids: [parentM] }).items[0].matrix), lc);
        dispatch({
          op: "update",
          ids: [r.id],
          patch: { x: lc.x - len / 2, y: lc.y, rotation: (Math.atan2(dy, dx) * 180) / Math.PI, ...(tool === "arrow" ? { shape: { endCap: "arrow" } } : {}) },
        });
      }
      dispatch({ op: "endGesture" });
      setTool("move");
      return;
    }
    const kind = tool === "frame" ? "frame" : tool;
    let w = Math.abs(end.x - start.x);
    let h = Math.abs(end.y - start.y);
    if (clicked) {
      w = 100;
      h = 100;
    }
    if (shift) w = h = Math.max(w, h);
    let x = clicked ? start.x : end.x < start.x ? start.x - w : start.x;
    let y = clicked ? start.y : end.y < start.y ? start.y - h : start.y;
    if (alt && !clicked) {
      x = start.x - w;
      y = start.y - h;
      w *= 2;
      h *= 2;
    }
    dispatch({ op: "createShape", kind, x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h), parent: null });
    setTool("move");
  }

  function onDoubleClick(e: React.MouseEvent) {
    const vpt = (e.target as Element).getAttribute?.("data-vpt");
    if (vpt && editingVector) {
      // Double-click an anchor: sharp / smooth (not the one the first click just added).
      const [sub, idx, part] = vpt.split(":");
      const li = lastInsert.current;
      const fresh = li && li.key === `${sub}:${idx}` && Date.now() - li.time < 600;
      if (part === "anchor" && !fresh) toggleVectorPointSmooth(+sub, +idx);
      return;
    }
    const p = pagePt(e);
    const z = zoom();
    const doc = getDoc();
    const cur = selection();
    if (cur.length === 1) {
      const n = doc.nodes[cur[0]];
      if (n?.type === "text") {
        useStore.setState({ editingText: n.id });
        return;
      }
      if (n?.type === "vector" && n.vector && !n.vector.raw) {
        useStore.setState({ editingVector: n.id });
        return;
      }
      if (n && ["group", "frame", "component", "instance", "componentSet"].includes(n.type)) {
        const child = query<string | null>({ q: "drill", x: p.x, y: p.y, zoom: z, container: n.id });
        if (child) {
          dispatch({ op: "select", ids: [child] });
          if (doc.nodes[child]?.type === "text") useStore.setState({ editingText: child });
          return;
        }
      }
    }
    const hit = query<string | null>({ q: "hit", x: p.x, y: p.y, zoom: z });
    if (hit && doc.nodes[hit]?.type === "text") {
      dispatch({ op: "select", ids: [hit] });
      useStore.setState({ editingText: hit });
    }
  }

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    // On a Mac Ctrl-click (the snapping override) also raises a context menu: while the pen is
    // down or a drag is on, it is a click with Ctrl, not a request for the menu.
    if (isMac && e.ctrlKey && e.button === 0 && (tool === "pen" || drag.current)) return;
    holdControl.current?.cancel();
    // The editor and its caret have their own (the browser's text menu on a long-press).
    if ((e.target as Element).closest?.(".text-editor, .text-caret")) return;
    // Android raises one after our own long-press menu is already open.
    if (Date.now() - longPressAt.current < 1000) return;
    openMenuAt(e.clientX, e.clientY);
  }

  /** The canvas menu at a client point, with the layer under it selected. */
  function openMenuAt(x: number, y: number) {
    const p = pagePt({ clientX: x, clientY: y });
    const id = query<string | null>({ q: "pick", x: p.x, y: p.y, zoom: zoom(), deep: false });
    if (id && !selection().includes(id)) dispatch({ op: "select", ids: [id] });
    setMenu({ x, y, items: canvasMenu(p) });
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const p = pagePt(e);
    for (const f of [...e.dataTransfer.files]) {
      if (f.type === "image/svg+xml" || /\.svg$/i.test(f.name)) await insertSvgFile(f, p.x, p.y);
      else if (f.type.startsWith("image/")) await insertImageFile(f, p.x, p.y);
      else if (f.name.endsWith(".dtron") || f.name.endsWith(".json")) await openDtronFile(f);
    }
    const comp = e.dataTransfer.getData("application/x-designotron-component");
    const main = comp ? getDoc().nodes[comp] : null;
    // Centred on the pointer; the frame under the pointer (not the corner) is the parent,
    // and dropping onto a main component nests the instance there like Figma.
    if (main) {
      dispatch({ op: "createInstance", componentId: comp, x: p.x - main.width / 2, y: p.y - main.height / 2, parent: null, anchor: p, intoComponents: true });
    }
    // A picture from the Images list in Assets: a new layer at its own size.
    const picture = e.dataTransfer.getData("application/x-designotron-image");
    // Only a source the file already holds: an asset it has or an http(s) link one of its layers uses (never raw data).
    if (picture && droppableImage(picture)) await placeImageSource(picture, p.x, p.y);
    // A stock photo from the Assets panel: a new image layer at the pointer.
    const photo = e.dataTransfer.getData("application/x-designotron-photo");
    if (photo && /^[\w:.\-/]{1,200}$/.test(photo)) {
      try {
        const [{ photoDetails }, { placeNewLayer }, { photoEnv }] = await Promise.all([import("../photos/providers"), import("../photos/place"), import("../photos/settings")]);
        await placeNewLayer(await photoDetails(photoEnv(), photo), { x: p.x, y: p.y });
      } catch (err) {
        toast(String(err instanceof Error ? err.message : err), "error");
      }
    }
  }

  // ---------- Overlay ----------
  const single = sel.length === 1 ? selItems.items[0] : null;
  const singleNode = single ? doc.nodes[single.id] : null;
  const box: Pt[] | null = single ? corners(v, single.matrix, single.width, single.height) : selItems.union ? rectCorners(v, selItems.union) : null;
  const isLine = singleNode?.type === "line";
  const showHandles = !!box && !editingText && !editingVector && (tool === "move" || (tool === "scale" && !sel.some((id) => insideInstance(doc.nodes[id])))) && sel.every((id) => !doc.nodes[id]?.locked);
  const handlePts: { h: Handle; p: Pt }[] = box
    ? isLine
      ? [
          { h: "w", p: mid(box[0], box[3]) },
          { h: "e", p: mid(box[1], box[2]) },
        ]
      : [
          { h: "nw", p: box[0] },
          { h: "ne", p: box[1] },
          { h: "se", p: box[2] },
          { h: "sw", p: box[3] },
          { h: "n", p: mid(box[0], box[1]) },
          { h: "e", p: mid(box[1], box[2]) },
          { h: "s", p: mid(box[2], box[3]) },
          { h: "w", p: mid(box[3], box[0]) },
        ]
    : [];
  const centroid = box ? { x: (box[0].x + box[2].x) / 2, y: (box[0].y + box[2].y) / 2 } : null;
  touchPick.current = (cx, cy) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !box || !showHandles || isLine || editingVector) return undefined;
    return pickTouchHandle<Handle>({ x: cx - r.left, y: cy - r.top }, handlePts, box);
  };
  // Handles are bigger under a finger.
  const handleSize = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? 10 : 8;
  const sizeLabel = selItems.union ? `${round(single ? single.width : selItems.union.width)} × ${round(single ? single.height : selItems.union.height)}` : "";
  const bottomMid = box ? [...box].sort((a, b) => b.y - a.y).slice(0, 2).reduce((a, b) => mid(a, b)) : null;

  const vectorNode = editingVector ? doc.nodes[editingVector] : null;
  const vectorM = editingVector ? query<{ items: BoundsItem[] }>({ q: "bounds", ids: [editingVector] }).items[0]?.matrix : null;

  const protoLinks = rightTab === "prototype" ? collectLinks() : [];
  function collectLinks() {
    // Overlay links (open/swap overlay) are drawn dashed.
    const out: { from: Pt; to: Pt; selected: boolean; overlay: boolean }[] = [];
    const linked = (i: Node["interactions"][number]) => (i.action === "navigate" || isOverlayLink(i)) && !!i.destination;
    const ids = Object.values(doc.nodes).filter((n) => n.page === page && n.interactions.some(linked));
    if (!ids.length) return out;
    const fromB = query<{ items: BoundsItem[] }>({ q: "bounds", ids: ids.map((n) => n.id) }).items;
    for (const n of ids) {
      const fb = fromB.find((b) => b.id === n.id);
      if (!fb) continue;
      for (const i of n.interactions) {
        if (!linked(i)) continue;
        const tb = topFrames.find((t) => t.id === i.destination);
        if (!tb) continue;
        out.push({
          from: toScreen(v, { x: fb.bounds.x + fb.bounds.width, y: fb.bounds.y + fb.bounds.height / 2 }),
          to: toScreen(v, { x: tb.bounds.x, y: tb.bounds.y + Math.min(40, tb.bounds.height / 2) }),
          selected: sel.includes(n.id),
          overlay: isOverlayLink(i),
        });
      }
    }
    return out;
  }

  longPress.current = (x, y) => {
    longPressAt.current = Date.now();
    navigator.vibrate?.(10);
    openMenuAt(x, y);
  };
  const cursor = panning ? "grabbing" : keys.space || tool === "hand" ? "grab" : tool === "move" ? (bendReady ? undefined : vHover ? "crosshair" : "default") : tool === "text" ? "text" : "crosshair";
  const emptyPromptClosed = useStore((s) => s.emptyPromptClosed);
  /** The Figma import dialog is open: it has the say, not the blank-file prompt. */
  const figmaOpen = useStore((s) => s.figmaOpen);
  // A view-only file offers no Claude: it couldn't change anything.
  const engineReadOnly = useStore((s) => !!s.es.readOnly);
  const viewer = useCollab((s) => s.viewer);
  const viewOnly = engineReadOnly || viewer;
  const empty = !viewOnly && !pageObj?.children.length && !emptyPromptClosed.includes(emptyPromptKey(pageObj?.id ?? ""));

  return (
    <div
      id="dt-canvas"
      ref={ref}
      className={"canvas" + (bendReady ? " bend-ready" : "")}
      tabIndex={0}
      role="application"
      aria-roledescription="design canvas"
      aria-label={`Canvas, ${pageObj?.name ?? "page"}`}
      aria-description="Tab selects the next layer. F6, or Esc then Tab, leaves the canvas for the panels"
      style={{ background: pageObj?.background ?? "#1a1a1a", cursor }}
      onPointerDown={(e) => {
        onPointerDown(e);
        pointerDrag.active = !!drag.current;
      }}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => {
        onPointerUp(e);
        pointerDrag.active = false;
      }}
      onPointerCancel={(e) => {
        pointerDrag.active = false;
        // A system gesture took the finger mid-drag: the drag is cancelled, not left open.
        if (e.pointerType === "touch") holdControl.current?.abort();
        useStore.setState({ dropTarget: null, dropLine: null });
      }}
      onPointerLeave={() => {
        reportCursor(null);
        if (!drag.current) useStore.setState({ hover: null });
        setVHover(null);
      }}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="canvas-live" role="status" aria-live="polite" ref={liveRef} />
      <svg className={"dt-content" + (lod >= 0 ? ` lod-${lod}` : "")} xmlns="http://www.w3.org/2000/svg" width={size.w || undefined} height={size.h || undefined}>
        <style>{LOD_CSS}</style>
        <g ref={contentRef} transform={`translate(${v.x} ${v.y}) scale(${v.zoom})`} />
      </svg>
      <svg className="overlay" width={size.w || undefined} height={size.h || undefined}>
        {showGrids && <GridOverlay v={v} />}
        <PageGuides v={v} width={size.w} height={size.h} />
        <RemoteSelections v={v} />
        {topFrames.map((f) => {
          const n = doc.nodes[f.id];
          const p = toScreen(v, apply(f.matrix, { x: 0, y: 0 }));
          const isComp = n.type === "component" || n.type === "componentSet";
          // The label never runs past its frame's screen width, and goes when the frame is tiny.
          const label = fitLabel((isComp ? "❖ " : "") + n.name, Math.hypot(f.matrix.a, f.matrix.b) * n.width * v.zoom);
          if (label === null) return null;
          return (
            <text
              key={f.id}
              data-label={f.id}
              x={p.x}
              y={p.y - 6}
              className={"frame-label" + (sel.includes(f.id) ? " selected" : "") + (isComp ? " component" : "")}
            >
              {label}
            </text>
          );
        })}
        {dropTarget && <DropOutline id={dropTarget} v={v} />}
        {dropLine && <DropLine line={dropLine} v={v} />}
        {hoverItem && !measuring && <polygon points={polyPoints(corners(v, hoverItem.matrix, hoverItem.width, hoverItem.height))} fill="none" stroke="#0d99ff" strokeWidth={1.5} />}
        {/* Vector edit mode draws the path itself instead of the layer's box. */}
        {!editingVector && selItems.items.map((it) => (
          <polygon key={it.id} points={polyPoints(corners(v, it.matrix, it.width, it.height))} fill="none" stroke={doc.nodes[it.id]?.type === "component" || doc.nodes[it.id]?.instance ? "#9747ff" : "#0d99ff"} strokeWidth={1} />
        ))}
        {box && sel.length > 1 && <polygon points={polyPoints(box)} fill="none" stroke="#0d99ff" strokeWidth={1} />}
        {showHandles &&
          !isLine &&
          box!.map((c, i) => {
            const dir = { x: c.x - centroid!.x, y: c.y - centroid!.y };
            const len = Math.hypot(dir.x, dir.y) || 1;
            return <circle key={"r" + i} data-rotate="1" className="handle" cx={c.x + (dir.x / len) * 14} cy={c.y + (dir.y / len) * 14} r={10} fill="transparent" style={{ cursor: "grab" }} />;
          })}
        {showHandles &&
          handlePts.map(({ h, p }) => (
            <rect key={h} data-handle={h} className="handle" x={p.x - handleSize / 2} y={p.y - handleSize / 2} width={handleSize} height={handleSize} fill="white" stroke="#0d99ff" strokeWidth={1} style={{ cursor: HANDLE_CURSORS[h] }} />
          ))}
        {showHandles && bottomMid && !measuring && (
          <g transform={`translate(${bottomMid.x} ${bottomMid.y + 16})`}>
            <rect x={-sizeLabel.length * 3.3 - 6} y={-9} width={sizeLabel.length * 6.6 + 12} height={18} rx={3} fill="#0d99ff" />
            <text textAnchor="middle" dominantBaseline="central" fill="white" fontSize={11}>
              {sizeLabel}
            </text>
          </g>
        )}
        {rightTab === "prototype" &&
          protoLinks.map((l, i) => (
            <g key={i} data-proto-link={l.overlay ? "overlay" : "navigate"}>
              <path
                d={`M${l.from.x} ${l.from.y} C${l.from.x + 60} ${l.from.y} ${l.to.x - 60} ${l.to.y} ${l.to.x} ${l.to.y}`}
                fill="none"
                stroke={l.selected ? "#0d99ff" : "#0d99ff88"}
                strokeWidth={2}
                strokeDasharray={l.overlay ? "6 4" : undefined}
              />
              {l.overlay ? <rect x={l.to.x - 4} y={l.to.y - 4} width={8} height={8} rx={1.5} fill="#0d99ff" /> : <circle cx={l.to.x} cy={l.to.y} r={4} fill="#0d99ff" />}
            </g>
          ))}
        {rightTab === "prototype" && single && (
          <circle
            data-link={single.id}
            className="handle"
            cx={toScreen(v, { x: single.bounds.x + single.bounds.width, y: single.bounds.y + single.bounds.height / 2 }).x + 10}
            cy={toScreen(v, { x: 0, y: single.bounds.y + single.bounds.height / 2 }).y}
            r={7}
            fill="#0d99ff"
            stroke="white"
            strokeWidth={2}
            style={{ cursor: "crosshair" }}
          />
        )}
        {link && (() => {
          const fb = query<{ items: BoundsItem[] }>({ q: "bounds", ids: [link.from] }).items[0];
          if (!fb) return null;
          const a = toScreen(v, { x: fb.bounds.x + fb.bounds.width, y: fb.bounds.y + fb.bounds.height / 2 });
          const b = toScreen(v, link.cur);
          return <path d={`M${a.x} ${a.y} C${a.x + 60} ${a.y} ${b.x - 60} ${b.y} ${b.x} ${b.y}`} fill="none" stroke="#0d99ff" strokeWidth={2} strokeDasharray="4 3" />;
        })()}
        {guides.map((g, i) => {
          const a = toScreen(v, { x: g.x1, y: g.y1 });
          const b = toScreen(v, { x: g.x2, y: g.y2 });
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#f24822" strokeWidth={1} />;
        })}
        <SpacingGaps v={v} gaps={gaps} />
        {measuring && <Measure v={v} host={ref.current} />}
        {marquee && <polygon points={polyPoints(rectCorners(v, marquee))} fill="rgba(13,153,255,0.08)" stroke="#0d99ff" strokeWidth={1} />}
        {draw && <DrawPreview tool={tool} start={draw.start} cur={draw.cur} v={v} />}
        {pencil && <polyline points={polyPoints(pencil.map((p) => toScreen(v, p)))} fill="none" stroke="#0d99ff" strokeWidth={1.5} />}
        {(pen.length > 0 || penFrom) && <PenPreview pts={penFrom ? [penFrom.anchor, ...pen] : pen} cursor={penCursor} v={v} />}
        {snapMark && (() => {
          const s = toScreen(v, snapMark);
          return <circle className="vsnap-mark" cx={s.x} cy={s.y} r={7} fill="none" pointerEvents="none" />;
        })()}
        {vectorNode?.vector && vectorM && <VectorPoints node={vectorNode} m={vectorM} v={v} selected={vectorPts} hover={vHover} />}
      </svg>
      <PaintHandles v={v} />
      <CropMode v={v} />
      <CommentLayer v={v} />
      <RemoteCursors v={v} />
      <CursorChat v={v} />
      <GuestBar />
      <FollowFrame />
      {showRulers && <Rulers v={v} width={size.w} height={size.h} selection={selItems.union} />}
      {editingText && <TextEditor key={editingText} id={editingText} />}
      {empty && !figmaOpen && (tool === "move" || tool === "hand") && <EmptyPrompt pageId={pageObj?.id ?? ""} forceCompact={doc.pages.some((p) => p.id !== pageObj?.id && p.children.length > 0)} />}
      <ZoomFlash zoom={v.zoom} />
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Indices of the longest strictly increasing subsequence of `pos` (entries < 0 never count). */
function longestIncreasingRun(pos: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(pos.length).fill(-1);
  for (let i = 0; i < pos.length; i++) {
    if (pos[i] < 0) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pos[tails[mid]] < pos[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i);
  return out;
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

function DropOutline({ id, v }: { id: string; v: { x: number; y: number; zoom: number } }) {
  const it = query<{ items: BoundsItem[] }>({ q: "bounds", ids: [id] }).items[0];
  if (!it) return null;
  return <polygon points={polyPoints(corners(v, it.matrix, it.width, it.height))} fill="none" stroke="#0d99ff" strokeWidth={2} strokeDasharray="5 3" />;
}

/** Where a layer dropped into an auto layout frame will be inserted. */
function DropLine({ line, v }: { line: [number, number, number, number]; v: { x: number; y: number; zoom: number } }) {
  const a = toScreen(v, { x: line[0], y: line[1] });
  const b = toScreen(v, { x: line[2], y: line[3] });
  return <line className="flow-drop-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
}

function DrawPreview({ tool, start, cur, v }: { tool: string; start: Pt; cur: Pt; v: { x: number; y: number; zoom: number } }) {
  const a = toScreen(v, start);
  const b = toScreen(v, cur);
  if (tool === "line" || tool === "arrow") return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#0d99ff" strokeWidth={1.5} />;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  if (tool === "ellipse") return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill="rgba(13,153,255,0.1)" stroke="#0d99ff" />;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={tool === "text" ? "none" : "rgba(13,153,255,0.1)"} stroke="#0d99ff" strokeDasharray={tool === "text" ? "3 2" : undefined} />
      <text x={x + w / 2} y={y + h + 16} textAnchor="middle" fill="#0d99ff" fontSize={11}>
        {Math.round(w / v.zoom)} × {Math.round(h / v.zoom)}
      </text>
    </g>
  );
}

function PenPreview({ pts, cursor, v }: { pts: VectorPoint[]; cursor: Pt | null; v: { x: number; y: number; zoom: number } }) {
  const s = pts.map((p) => toScreen(v, p));
  let d = `M${s[0].x} ${s[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c1 = toScreen(v, { x: a.x + a.outX, y: a.y + a.outY });
    const c2 = toScreen(v, { x: b.x + b.inX, y: b.y + b.inY });
    d += ` C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${s[i].x} ${s[i].y}`;
  }
  const last = s[s.length - 1];
  const c = cursor ? toScreen(v, cursor) : null;
  return (
    <g>
      <path d={d} fill="none" stroke="#0d99ff" strokeWidth={1.5} />
      {c && <line x1={last.x} y1={last.y} x2={c.x} y2={c.y} stroke="#0d99ff" strokeDasharray="3 3" />}
      {s.map((p, i) => (
        <rect key={i} x={p.x - 3.5} y={p.y - 3.5} width={7} height={7} fill={i === 0 ? "#0d99ff" : "white"} stroke="#0d99ff" />
      ))}
    </g>
  );
}

/** Screen-space path data for subpaths in a node's local space. */
function screenPathD(subpaths: { points: VectorPoint[]; closed: boolean }[], m: Mat, v: { x: number; y: number; zoom: number }): string {
  const sc = (q: Pt) => toScreen(v, apply(m, q));
  return subpaths
    .filter((sp) => sp.points.length)
    .map((sp) => {
      const pts = sp.points;
      const seg = (a: VectorPoint, b: VectorPoint) => {
        const c1 = sc({ x: a.x + a.outX, y: a.y + a.outY });
        const c2 = sc({ x: b.x + b.inX, y: b.y + b.inY });
        const e = sc(b);
        return ` C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${e.x} ${e.y}`;
      };
      const s0 = sc(pts[0]);
      let d = `M${s0.x} ${s0.y}`;
      for (let i = 1; i < pts.length; i++) d += seg(pts[i - 1], pts[i]);
      if (sp.closed && pts.length > 1) d += seg(pts[pts.length - 1], pts[0]) + " Z";
      return d;
    })
    .join(" ");
}

/** Vector edit mode overlay: path outline, the segment under the pointer, handles and anchors. */
function VectorPoints({
  node,
  m,
  v,
  selected,
  hover,
}: {
  node: Node;
  m: Mat;
  v: { x: number; y: number; zoom: number };
  selected: [number, number][];
  hover: SegmentHit | null;
}) {
  const subpaths = node.vector!.subpaths;
  // The path and its anchors only change with the document, view or selection, not with the
  // hover indicator that moves on every pointer move.
  const base = useMemo(() => {
    const keys = new Set(selected.map(([s, i]) => `${s}:${i}`));
    const isSel = (si: number, pi: number) => keys.has(`${si}:${pi}`);
    const handles: JSX.Element[] = [];
    const anchors: JSX.Element[] = [];
    subpaths.forEach((sp, si) => {
      const pts = sp.points;
      // Screen length of the control polygon of the segment after each anchor (its chord when
      // straight); the polygon, unlike the chord, stays long for a curve between close anchors.
      const segLen = pts.map((a, i) => {
        const b = pts[i + 1] ?? (sp.closed ? pts[0] : undefined);
        if (!b || b === a) return Infinity;
        const [p0, c1, c2, p3] = [a, { x: a.x + a.outX, y: a.y + a.outY }, { x: b.x + b.inX, y: b.y + b.inY }, b].map((q) => toScreen(v, apply(m, q)));
        return Math.hypot(c1.x - p0.x, c1.y - p0.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(p3.x - c2.x, p3.y - c2.y);
      });
      pts.forEach((p, pi) => {
        const a = toScreen(v, apply(m, p));
        const on = isSel(si, pi);
        // The anchor is drawn 8px wide, but its hit area shrinks next to a close neighbour so
        // the middle of a short segment stays free to take a new point. Coincident neighbours
        // (zero-length segments) don't count: those anchors just overlap.
        const gap = Math.min(...[segLen[pi], segLen[(pi + pts.length - 1) % pts.length]].filter((len) => len >= MIN_SEGMENT_GAP));
        // Control handles of unselected anchors would cover a short segment; select the anchor to see them.
        const crowded = gap < CROWDED_ANCHOR_GAP && !on;
        const hasOut = (p.outX || p.outY) && !crowded;
        const hasIn = (p.inX || p.inY) && !crowded;
        if (hasOut) {
          const o = toScreen(v, apply(m, { x: p.x + p.outX, y: p.y + p.outY }));
          handles.push(<line key={`lo${si}-${pi}`} x1={a.x} y1={a.y} x2={o.x} y2={o.y} stroke="#0d99ff" />);
          handles.push(<circle key={`o${si}-${pi}`} className="vector-handle" cx={o.x} cy={o.y} r={2.5} fill="white" stroke="#0d99ff" pointerEvents="none" />);
          handles.push(<circle key={`oh${si}-${pi}`} data-vpt={`${si}:${pi}:out`} className="handle" cx={o.x} cy={o.y} r={HANDLE_HIT} fill="transparent" />);
        }
        if (hasIn) {
          const o = toScreen(v, apply(m, { x: p.x + p.inX, y: p.y + p.inY }));
          handles.push(<line key={`li${si}-${pi}`} x1={a.x} y1={a.y} x2={o.x} y2={o.y} stroke="#0d99ff" />);
          handles.push(<circle key={`i${si}-${pi}`} className="vector-handle" cx={o.x} cy={o.y} r={2.5} fill="white" stroke="#0d99ff" pointerEvents="none" />);
          handles.push(<circle key={`ih${si}-${pi}`} data-vpt={`${si}:${pi}:in`} className="handle" cx={o.x} cy={o.y} r={HANDLE_HIT} fill="transparent" />);
        }
        const hit = Math.max(ANCHOR_HIT_MIN, Math.min(ANCHOR_HIT, gap / 4));
        anchors.push(
          <g key={`a${si}-${pi}`}>
            <circle
              className={"vector-anchor" + (on ? " selected" : "")}
              cx={a.x}
              cy={a.y}
              r={ANCHOR_R}
              fill={on ? "#0d99ff" : "white"}
              stroke="#0d99ff"
              strokeWidth={1.5}
              pointerEvents="none"
            />
            <rect data-vpt={`${si}:${pi}:anchor`} className="handle" x={a.x - hit} y={a.y - hit} width={hit * 2} height={hit * 2} fill="transparent" />
          </g>,
        );
      });
    });
    return { handles, anchors, d: screenPathD(subpaths, m, v) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subpaths, m.a, m.b, m.c, m.d, m.e, m.f, v.x, v.y, v.zoom, selected]);
  const hoverSp = hover ? subpaths[hover.sub] : null;
  const hoverSeg =
    hover && hoverSp && hoverSp.points.length > 1
      ? screenPathD([{ points: [hoverSp.points[hover.seg], hoverSp.points[(hover.seg + 1) % hoverSp.points.length]], closed: false }], m, v)
      : null;
  const hp = hover ? toScreen(v, hover) : null;
  return (
    <g>
      <path d={base.d} fill="none" stroke="#0d99ff" strokeWidth={1} />
      {hoverSeg && <path className="vector-hover-segment" d={hoverSeg} fill="none" stroke="#0d99ff" strokeWidth={2.5} />}
      {base.handles}
      {base.anchors}
      {hp && (
        <g className="vector-hover-point" pointerEvents="none">
          <circle cx={hp.x} cy={hp.y} r={4.5} fill="white" stroke="#0d99ff" strokeWidth={1.5} />
          <path d={`M${hp.x - 2} ${hp.y}H${hp.x + 2}M${hp.x} ${hp.y - 2}V${hp.y + 2}`} stroke="#0d99ff" strokeWidth={1.2} />
        </g>
      )}
    </g>
  );
}

/** The zoom level, shown briefly while it changes (the toolbar always has it). */
function ZoomFlash({ zoom }: { zoom: number }) {
  const [shown, setShown] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    setShown(true);
    const t = setTimeout(() => setShown(false), 900);
    return () => clearTimeout(t);
  }, [zoom]);
  return <div className={"zoom-indicator" + (shown ? " shown" : "")}>{Math.round(zoom * 100)}%</div>;
}

/** Whether a dragged image source is one the file holds: an `asset:` id that exists, or an http(s) URL some layer uses. */
function droppableImage(src: string): boolean {
  if (src.startsWith("asset:")) return !!assetUrl(src.slice(6));
  return /^https?:\/\//i.test(src) && imagesIn(getDoc(), null).some((e) => e.src === src);
}
