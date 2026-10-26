import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Handle, Mat, Node, Rect, VectorPoint } from "../types";
import {
  dispatch,
  getDoc,
  query,
  renderPageIncremental,
  screenToPage,
  selection,
  setTool,
  useStore,
  zoomBy,
} from "../store";
import { apply, corners, invert, mid, polyPoints, rectCorners, simplify, toScreen, type Pt } from "./geometry";
import { openTextGesture, TextEditor } from "./TextEditor";
import { EmptyPrompt } from "./EmptyPrompt";
import { GridOverlay, PageGuides, Rulers } from "./Rulers";
import { CommentLayer } from "./Comments";
import { RemoteCursors, RemoteSelections } from "./RemoteCursors";
import { reportCursor } from "../collab";
import { insertImageFile, openDtronFile, toggleVectorPointSmooth, vectorPoints } from "../actions";
import { canvasMenu } from "./contextMenu";
import { useDemo } from "../Demo";
import { Menu, type MenuItem } from "../ui/controls";
import { isOverlayLink, newInteraction } from "../prototype";

interface BoundsItem {
  id: string;
  matrix: Mat;
  width: number;
  height: number;
  bounds: Rect;
}

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "move"; start: Pt; ids: string[]; started: boolean; alt: boolean; clickSelect: string | null }
  | { kind: "resize"; handle: Handle; start: Pt; ids: string[] }
  | { kind: "rotate"; pivot: Pt; startAngle: number; ids: string[] }
  | { kind: "marquee"; start: Pt; base: string[] }
  | { kind: "draw"; start: Pt; cur: Pt }
  | { kind: "pencil"; points: Pt[] }
  | { kind: "penHandle"; index: number }
  | { kind: "vector"; id: string; sub: number; idx: number; part: "anchor" | "in" | "out"; pts: [number, number][]; startLocal: Pt; start: Node; moved: boolean }
  | { kind: "vmarquee"; id: string; start: Pt; base: [number, number][]; onSelf: boolean; moved: boolean }
  | { kind: "link"; from: string; cur: Pt };

/** The point on a path nearest the pointer (`vectorSegmentAt` query, page coordinates). */
interface SegmentHit {
  sub: number;
  seg: number;
  t: number;
  x: number;
  y: number;
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
  const marquee = useStore((s) => s.marquee);
  const rightTab = useStore((s) => s.rightTab);
  const dropTarget = useStore((s) => s.dropTarget);
  const showRulers = useStore((s) => s.showRulers);
  const showGrids = useStore((s) => s.showGrids);
  const [size, setSize] = useState({ w: 0, h: 0 });
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
  // Pen continuing an open path from one of its ends.
  const [penFrom, setPenFrom] = useState<PenFrom | null>(null);
  // Vector edit mode: the point on the path under the pointer (where a click adds an anchor).
  const [vHover, setVHover] = useState<SegmentHit | null>(null);
  const lastInsert = useRef<{ key: string; time: number } | null>(null);
  const vectorPts = useStore((s) => s.vectorPoints);
  const [pencil, setPencil] = useState<Pt[] | null>(null);
  const [link, setLink] = useState<{ from: string; cur: Pt } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [panning, setPanning] = useState(false);

  const doc = getDoc();
  const pageObj = doc.pages.find((p) => p.id === page) ?? doc.pages[0];
  // Canvas content is patched per top-level layer: only changed roots are re-rendered and replaced.
  const contentRef = useRef<SVGGElement>(null);
  const rootEls = useRef(new Map<string, SVGGElement>());
  useLayoutEffect(() => {
    const host = contentRef.current;
    if (!host) return;
    const fresh = rootEls.current.size === 0;
    const r = renderPageIncremental(page, editingText ? [...demoHidden, editingText] : demoHidden, fresh);
    if ("full" in r) {
      rootEls.current.clear();
      host.innerHTML = r.full;
      return;
    }
    if (fresh) host.innerHTML = "";
    const els = rootEls.current;
    for (const [id, el] of els) {
      if (!r.order.includes(id)) {
        el.remove();
        els.delete(id);
      }
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

  }, [rev, page, editingText, demoHidden]);

  const selItems = useMemo(() => query<{ items: BoundsItem[]; union: Rect | null }>({ q: "bounds", ids: sel }), [rev, sel]);
  const hoverItem = useMemo(() => (hover && !sel.includes(hover) ? query<{ items: BoundsItem[] }>({ q: "bounds", ids: [hover] }).items[0] : null), [rev, hover, sel]);
  const topFrames = useMemo(() => {
    const ids = (pageObj?.children ?? []).filter((id) => {
      const n = doc.nodes[id];
      return n && n.visible && ["frame", "component", "componentSet", "instance"].includes(n.type);
    });
    return query<{ items: BoundsItem[] }>({ q: "bounds", ids }).items;
  }, [rev, page]);

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
  // gesture to itself until every finger is lifted.
  useEffect(() => {
    const el = ref.current!;
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; mx: number; my: number; v: { x: number; y: number; zoom: number } } | null = null;
    let swallow = false;
    const local = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      return { x: x - r.left, y: y - r.top };
    };
    const measure = () => {
      const [a, b] = [...touches.values()];
      const m = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: m.x, my: m.y };
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        pinch = { ...measure(), v: { ...useStore.getState().viewport } };
        swallow = true;
      }
      if (swallow) e.stopPropagation();
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!swallow) return;
      e.stopPropagation();
      if (!pinch || touches.size < 2) return;
      const now = measure();
      const zoom = Math.min(64, Math.max(0.02, (pinch.v.zoom * now.d) / pinch.d));
      // Keep the page point that was under the fingers' midpoint under the new midpoint.
      const px = (pinch.mx - pinch.v.x) / pinch.v.zoom;
      const py = (pinch.my - pinch.v.y) / pinch.v.zoom;
      useStore.setState({ viewport: { zoom, x: now.mx - px * zoom, y: now.my - py * zoom } });
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      if (swallow) e.stopPropagation();
      if (touches.size === 0) swallow = false;
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move, true);
    el.addEventListener("pointerup", up, true);
    el.addEventListener("pointercancel", up, true);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move, true);
      el.removeEventListener("pointerup", up, true);
      el.removeEventListener("pointercancel", up, true);
    };
  }, []);

  // Pen tool: Enter/Escape finishes the path.
  useEffect(() => {
    if (tool !== "pen") {
      if (pen.length) setPen([]);
      if (penFrom) setPenFrom(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        finishPen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, pen, penFrom]);

  useEffect(() => {
    setVHover(null);
    if (!editingVector) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") useStore.setState({ editingVector: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    setTool("move");
  }

  /** Starts dragging an anchor (with the other selected anchors) or a handle of the edited vector. */
  function startVectorDrag(id: string, sub: number, idx: number, part: "anchor" | "in" | "out", p: Pt) {
    const n = getDoc().nodes[id];
    const m = query<{ items: BoundsItem[] }>({ q: "bounds", ids: [id] }).items[0];
    const pts = part === "anchor" ? vectorPoints() : [];
    drag.current = { kind: "vector", id, sub, idx, part, pts, startLocal: apply(invert(m.matrix), p), start: n, moved: false };
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
    if (id) {
      if (e.shiftKey) dispatch({ op: "select", ids: [id], mode: "toggle" });
      else if (!current.includes(id)) dispatch({ op: "select", ids: [id] });
      else if (current.length > 1) clickSelect = id;
    }
    const ids = selection().filter((s) => !getDoc().nodes[s]?.locked);
    if (!ids.length) return;
    drag.current = { kind: "move", start: p, ids, started: false, alt: e.altKey, clickSelect };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button === 2) return;
    ref.current!.focus();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = pagePt(e);
    const target = e.target as Element;
    const st = useStore.getState();
    if (st.editingText) return;

    if (e.button === 1 || keys.space || tool === "hand") {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: st.viewport.x, vy: st.viewport.y };
      setPanning(true);
      return;
    }

    const handle = target.getAttribute("data-handle") as Handle | null;
    if (handle) {
      dispatch({ op: "beginGesture" });
      drag.current = { kind: "resize", handle, start: p, ids: [...sel] };
      return;
    }
    if (target.hasAttribute("data-rotate")) {
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
      startVectorDrag(editingVector, +sub, +idx, part as "anchor" | "in" | "out", p);
      return;
    }
    if (editingVector && tool === "move") {
      // Click on the path: add an anchor there (and drag it, all one undo step).
      const hit = query<SegmentHit | null>({ q: "vectorSegmentAt", id: editingVector, x: p.x, y: p.y, zoom: zoom() });
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
      // Anywhere but another layer: select anchors with a marquee (a plain click clears them).
      const id = query<string | null>({ q: "pick", x: p.x, y: p.y, zoom: zoom(), deep: false });
      if (!id || id === editingVector) {
        drag.current = { kind: "vmarquee", id: editingVector, start: p, base: e.shiftKey ? vectorPoints() : [], onSelf: id === editingVector, moved: false };
        return;
      }
    }
    const labelId = target.getAttribute("data-label");
    if (labelId) {
      startMove(e, p, labelId);
      return;
    }

    switch (tool) {
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
        setPen([...pen, { x: p.x, y: p.y, inX: 0, inY: 0, outX: 0, outY: 0 }]);
        drag.current = { kind: "penHandle", index: pen.length };
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
    if (!d) {
      if (editingVector && tool === "move") {
        const onPoint = (e.target as Element).hasAttribute?.("data-vpt");
        const hit = onPoint ? null : query<SegmentHit | null>({ q: "vectorSegmentAt", id: editingVector, x: p.x, y: p.y, zoom: zoom() });
        if (hit?.x !== vHover?.x || hit?.y !== vHover?.y) setVHover(hit);
        if (useStore.getState().hover) useStore.setState({ hover: null });
        return;
      }
      if (tool === "move" && !useStore.getState().editingText) {
        const id = query<string | null>({ q: "pick", x: p.x, y: p.y, zoom: zoom(), deep: e.metaKey || e.ctrlKey });
        if (id !== useStore.getState().hover) useStore.setState({ hover: id });
      }
      if (tool === "pen") setPenCursor(p);
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
          dispatch({ op: "beginGesture" });
          if (d.alt) {
            // Alt-drag duplicates in place, then moves the copies. Rebasing makes the drag move
            // the copies while undo still goes back to before the paste: one undo step.
            const doc = getDoc();
            const data = query<string>({ q: "copy", ids: d.ids });
            const parent = doc.nodes[d.ids[0]]?.parent ?? null;
            const b = query<{ union: Rect | null }>({ q: "bounds", ids: d.ids }).union;
            const r = dispatch<{ created: string[] }>({ op: "paste", data, parent, x: b?.x ?? null, y: b?.y ?? null });
            if (r) d.ids = r.created;
            dispatch({ op: "rebaseGesture" });
          }
          useStore.setState({ hover: null });
        }
        const r = dispatch<{ guides: any[] }>({ op: "translate", ids: d.ids, dx, dy, snap: !e.ctrlKey, zoom: zoom() }, { quiet: true });
        const target = query<string | null>({ q: "frameAt", x: p.x, y: p.y, exclude: d.ids });
        useStore.setState({ guides: r?.guides ?? [], dropTarget: target });
        break;
      }
      case "resize": {
        const r = dispatch<{ guides: any[] }>(
          { op: "resize", ids: d.ids, handle: d.handle, dx: p.x - d.start.x, dy: p.y - d.start.y, keepAspect: e.shiftKey, fromCenter: e.altKey, snap: !e.ctrlKey, zoom: zoom() },
          { quiet: true },
        );
        useStore.setState({ guides: r?.guides ?? [] });
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
          const out = { x: p.x - a.x, y: p.y - a.y };
          if (Math.hypot(out.x, out.y) * zoom() < 3) return pts;
          return pts.map((pt, i) => (i === d.index ? { ...pt, outX: out.x, outY: out.y, inX: -out.x, inY: -out.y } : pt));
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
          // Every selected anchor moves together (the dragged one is always among them).
          const moving = d.pts.some(([s, i]) => s === d.sub && i === d.idx) ? d.pts : [[d.sub, d.idx] as [number, number]];
          for (const [s, i] of moving) {
            const o = d.start.vector!.subpaths[s]?.points[i];
            const q = vec.subpaths[s]?.points[i];
            if (!o || !q) continue;
            q.x = o.x + dx;
            q.y = o.y + dy;
          }
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
        const fresh = inside.filter(([s, i]) => !d.base.some(([bs, bi]) => bs === s && bi === i));
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
    if (!d) return;
    const p = pagePt(e);
    switch (d.kind) {
      case "move":
        if (d.started) {
          dispatch({ op: "dropInto", ids: d.ids, x: p.x, y: p.y }, { quiet: true });
          dispatch({ op: "endGesture" });
        } else if (d.clickSelect) {
          dispatch({ op: "select", ids: [d.clickSelect] });
        }
        useStore.setState({ guides: [], dropTarget: null });
        break;
      case "resize":
      case "rotate":
        dispatch({ op: "endGesture" });
        useStore.setState({ guides: [] });
        break;
      case "vector":
        // Points may have left the layer's box: refit it in the same undo step.
        if (d.moved) dispatch({ op: "fitVectorBounds", id: d.id }, { quiet: true });
        dispatch({ op: "endGesture" });
        break;
      case "vmarquee":
        useStore.setState({ marquee: null });
        if (!d.moved && !e.shiftKey) {
          // A click off the path clears the anchors, or leaves edit mode when none are selected.
          if (vectorPoints().length || d.onSelf) useStore.setState({ vectorPoints: [] });
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
          dispatch({ op: "createVector", points: pts.map((q) => ({ x: q.x, y: q.y, inX: 0, inY: 0, outX: 0, outY: 0 })), closed: false, parent: null });
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
    const p = pagePt(e);
    const id = query<string | null>({ q: "pick", x: p.x, y: p.y, zoom: zoom(), deep: false });
    if (id && !selection().includes(id)) dispatch({ op: "select", ids: [id] });
    setMenu({ x: e.clientX, y: e.clientY, items: canvasMenu(p) });
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const p = pagePt(e);
    for (const f of [...e.dataTransfer.files]) {
      if (f.type.startsWith("image/")) await insertImageFile(f, p.x, p.y);
      else if (f.name.endsWith(".dtron") || f.name.endsWith(".json")) await openDtronFile(f);
    }
    const comp = e.dataTransfer.getData("application/x-designotron-component");
    const main = comp ? getDoc().nodes[comp] : null;
    // Centred on the pointer, like click-to-place in the Assets panel.
    if (main) dispatch({ op: "createInstance", componentId: comp, x: p.x - main.width / 2, y: p.y - main.height / 2, parent: null });
  }

  // ---------- Overlay ----------
  const single = sel.length === 1 ? selItems.items[0] : null;
  const singleNode = single ? doc.nodes[single.id] : null;
  const box: Pt[] | null = single ? corners(v, single.matrix, single.width, single.height) : selItems.union ? rectCorners(v, selItems.union) : null;
  const isLine = singleNode?.type === "line";
  const showHandles = !!box && !editingText && !editingVector && tool === "move" && sel.every((id) => !doc.nodes[id]?.locked);
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

  const cursor = panning ? "grabbing" : keys.space || tool === "hand" ? "grab" : tool === "move" ? (vHover ? "crosshair" : "default") : tool === "text" ? "text" : "crosshair";
  const empty = !pageObj?.children.length;

  return (
    <div
      id="dt-canvas"
      ref={ref}
      className="canvas"
      tabIndex={0}
      style={{ background: pageObj?.background ?? "#1a1a1a", cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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
      <svg xmlns="http://www.w3.org/2000/svg" width={size.w || undefined} height={size.h || undefined}>
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
          return (
            <text
              key={f.id}
              data-label={f.id}
              x={p.x}
              y={p.y - 6}
              className={"frame-label" + (sel.includes(f.id) ? " selected" : "") + (isComp ? " component" : "")}
            >
              {isComp ? "❖ " : ""}
              {n.name}
            </text>
          );
        })}
        {dropTarget && <DropOutline id={dropTarget} v={v} />}
        {hoverItem && <polygon points={polyPoints(corners(v, hoverItem.matrix, hoverItem.width, hoverItem.height))} fill="none" stroke="#0d99ff" strokeWidth={1.5} />}
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
            <rect key={h} data-handle={h} className="handle" x={p.x - 4} y={p.y - 4} width={8} height={8} fill="white" stroke="#0d99ff" strokeWidth={1} style={{ cursor: HANDLE_CURSORS[h] }} />
          ))}
        {showHandles && bottomMid && (
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
        {marquee && <polygon points={polyPoints(rectCorners(v, marquee))} fill="rgba(13,153,255,0.08)" stroke="#0d99ff" strokeWidth={1} />}
        {draw && <DrawPreview tool={tool} start={draw.start} cur={draw.cur} v={v} />}
        {pencil && <polyline points={polyPoints(pencil.map((p) => toScreen(v, p)))} fill="none" stroke="#0d99ff" strokeWidth={1.5} />}
        {(pen.length > 0 || penFrom) && <PenPreview pts={penFrom ? [penFrom.anchor, ...pen] : pen} cursor={penCursor} v={v} />}
        {vectorNode?.vector && vectorM && <VectorPoints node={vectorNode} m={vectorM} v={v} selected={vectorPts} hover={vHover} />}
      </svg>
      <CommentLayer v={v} />
      <RemoteCursors v={v} />
      {showRulers && <Rulers v={v} width={size.w} height={size.h} selection={selItems.union} />}
      {editingText && <TextEditor id={editingText} />}
      {empty && (tool === "move" || tool === "hand") && <EmptyPrompt />}
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
  const isSel = (si: number, pi: number) => selected.some(([s, i]) => s === si && i === pi);
  const handles: JSX.Element[] = [];
  const anchors: JSX.Element[] = [];
  subpaths.forEach((sp, si) =>
    sp.points.forEach((p, pi) => {
      const a = toScreen(v, apply(m, p));
      const hasOut = p.outX || p.outY;
      const hasIn = p.inX || p.inY;
      if (hasOut) {
        const o = toScreen(v, apply(m, { x: p.x + p.outX, y: p.y + p.outY }));
        handles.push(<line key={`lo${si}-${pi}`} x1={a.x} y1={a.y} x2={o.x} y2={o.y} stroke="#0d99ff" />);
        handles.push(<circle key={`o${si}-${pi}`} data-vpt={`${si}:${pi}:out`} className="handle" cx={o.x} cy={o.y} r={3.5} fill="white" stroke="#0d99ff" />);
      }
      if (hasIn) {
        const o = toScreen(v, apply(m, { x: p.x + p.inX, y: p.y + p.inY }));
        handles.push(<line key={`li${si}-${pi}`} x1={a.x} y1={a.y} x2={o.x} y2={o.y} stroke="#0d99ff" />);
        handles.push(<circle key={`i${si}-${pi}`} data-vpt={`${si}:${pi}:in`} className="handle" cx={o.x} cy={o.y} r={3.5} fill="white" stroke="#0d99ff" />);
      }
      const on = isSel(si, pi);
      anchors.push(
        <rect
          key={`a${si}-${pi}`}
          data-vpt={`${si}:${pi}:anchor`}
          className={"handle vector-anchor" + (on ? " selected" : "")}
          x={a.x - 4}
          y={a.y - 4}
          width={8}
          height={8}
          rx={on ? 1 : 0}
          fill={on ? "#0d99ff" : "white"}
          stroke={on ? "white" : "#0d99ff"}
          strokeWidth={on ? 1.5 : 1}
        />,
      );
    }),
  );
  const hoverSp = hover ? subpaths[hover.sub] : null;
  const hoverSeg =
    hover && hoverSp && hoverSp.points.length > 1
      ? screenPathD([{ points: [hoverSp.points[hover.seg], hoverSp.points[(hover.seg + 1) % hoverSp.points.length]], closed: false }], m, v)
      : null;
  const hp = hover ? toScreen(v, hover) : null;
  return (
    <g>
      <path d={screenPathD(subpaths, m, v)} fill="none" stroke="#0d99ff" strokeWidth={1} />
      {hoverSeg && <path className="vector-hover-segment" d={hoverSeg} fill="none" stroke="#0d99ff" strokeWidth={2.5} />}
      {handles}
      {anchors}
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
