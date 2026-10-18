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
import { TextEditor } from "./TextEditor";
import { EmptyPrompt } from "./EmptyPrompt";
import { GridOverlay, PageGuides, Rulers } from "./Rulers";
import { CommentLayer } from "./Comments";
import { RemoteCursors, RemoteSelections } from "./RemoteCursors";
import { reportCursor } from "../collab";
import { insertImageFile } from "../actions";
import { canvasMenu } from "./contextMenu";
import { Menu, type MenuItem } from "../ui/controls";
import { fromDtron } from "../files";
import { getEngine } from "../store";

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
  | { kind: "vector"; id: string; sub: number; idx: number; part: "anchor" | "in" | "out"; startLocal: Pt; start: Node }
  | { kind: "link"; from: string; cur: Pt };

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
    const r = renderPageIncremental(page, editingText ? [editingText] : [], fresh);
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

  }, [rev, page, editingText]);

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

  // Pen tool: Enter/Escape finishes the path.
  useEffect(() => {
    if (tool !== "pen") {
      if (pen.length) setPen([]);
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
  }, [tool, pen]);

  useEffect(() => {
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
    if (pen.length >= 2) dispatch({ op: "createVector", points: pen, closed, parent: null });
    setPen([]);
    setTool("move");
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
      const n = getDoc().nodes[editingVector];
      const m = query<{ items: BoundsItem[] }>({ q: "bounds", ids: [editingVector] }).items[0];
      dispatch({ op: "beginGesture" });
      drag.current = { kind: "vector", id: editingVector, sub: +sub, idx: +idx, part: part as any, startLocal: apply(invert(m.matrix), p), start: n };
      return;
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
        if (pen.length >= 2) {
          const first = toScreen(st.viewport, pen[0]);
          const l = local(e);
          if (Math.hypot(first.x - l.x, first.y - l.y) < 8) {
            finishPen(true);
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
          if (d.alt) {
            // Alt-drag duplicates in place, then moves the copies.
            const doc = getDoc();
            const data = query<string>({ q: "copy", ids: d.ids });
            const parent = doc.nodes[d.ids[0]]?.parent ?? null;
            const b = query<{ union: Rect | null }>({ q: "bounds", ids: d.ids }).union;
            const r = dispatch<{ created: string[] }>({ op: "paste", data, parent, x: b?.x ?? null, y: b?.y ?? null });
            if (r) d.ids = r.created;
          }
          dispatch({ op: "beginGesture" });
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
        const vec = structuredClone(d.start.vector!);
        const pt = vec.subpaths[d.sub].points[d.idx];
        const orig = d.start.vector!.subpaths[d.sub].points[d.idx];
        if (d.part === "anchor") {
          pt.x = orig.x + dx;
          pt.y = orig.y + dy;
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
      case "vector":
        dispatch({ op: "endGesture" });
        useStore.setState({ guides: [] });
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
            interaction: { trigger: "onClick", delayMs: 800, action: "navigate", destination: top, url: null, transition: "dissolve", durationMs: 300 },
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
      const r = dispatch<{ id: string }>({ op: "createText", x: start.x, y: start.y, characters: "", parent: null });
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
      else if (f.name.endsWith(".dtron") || f.name.endsWith(".json")) {
        try {
          getEngine().load(fromDtron(await f.text()));
          dispatch({ op: "relayout" });
        } catch (err) {
          console.error(err);
        }
      }
    }
    const comp = e.dataTransfer.getData("application/x-designotron-component");
    if (comp) dispatch({ op: "createInstance", componentId: comp, x: p.x, y: p.y, parent: null });
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
    const out: { from: Pt; to: Pt; selected: boolean }[] = [];
    const ids = Object.values(doc.nodes).filter((n) => n.page === page && n.interactions.some((i) => i.action === "navigate" && i.destination));
    if (!ids.length) return out;
    const fromB = query<{ items: BoundsItem[] }>({ q: "bounds", ids: ids.map((n) => n.id) }).items;
    for (const n of ids) {
      const fb = fromB.find((b) => b.id === n.id);
      if (!fb) continue;
      for (const i of n.interactions) {
        const tb = topFrames.find((t) => t.id === i.destination);
        if (!tb) continue;
        out.push({
          from: toScreen(v, { x: fb.bounds.x + fb.bounds.width, y: fb.bounds.y + fb.bounds.height / 2 }),
          to: toScreen(v, { x: tb.bounds.x, y: tb.bounds.y + Math.min(40, tb.bounds.height / 2) }),
          selected: sel.includes(n.id),
        });
      }
    }
    return out;
  }

  const cursor = panning ? "grabbing" : keys.space || tool === "hand" ? "grab" : tool === "move" ? "default" : tool === "text" ? "text" : "crosshair";
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
        {selItems.items.map((it) => (
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
            <g key={i}>
              <path d={`M${l.from.x} ${l.from.y} C${l.from.x + 60} ${l.from.y} ${l.to.x - 60} ${l.to.y} ${l.to.x} ${l.to.y}`} fill="none" stroke={l.selected ? "#0d99ff" : "#0d99ff88"} strokeWidth={2} />
              <circle cx={l.to.x} cy={l.to.y} r={4} fill="#0d99ff" />
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
        {pen.length > 0 && <PenPreview pts={pen} cursor={penCursor} v={v} />}
        {vectorNode?.vector && vectorM && <VectorPoints node={vectorNode} m={vectorM} v={v} />}
      </svg>
      <CommentLayer v={v} />
      <RemoteCursors v={v} />
      {showRulers && <Rulers v={v} width={size.w} height={size.h} selection={selItems.union} />}
      {editingText && <TextEditor id={editingText} />}
      {empty && tool === "move" && <EmptyPrompt />}
      <div className="zoom-indicator">{Math.round(v.zoom * 100)}%</div>
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

function VectorPoints({ node, m, v }: { node: Node; m: Mat; v: { x: number; y: number; zoom: number } }) {
  const items: JSX.Element[] = [];
  node.vector!.subpaths.forEach((sp, si) =>
    sp.points.forEach((p, pi) => {
      const a = toScreen(v, apply(m, p));
      const hasOut = p.outX || p.outY;
      const hasIn = p.inX || p.inY;
      if (hasOut) {
        const o = toScreen(v, apply(m, { x: p.x + p.outX, y: p.y + p.outY }));
        items.push(<line key={`lo${si}-${pi}`} x1={a.x} y1={a.y} x2={o.x} y2={o.y} stroke="#0d99ff" />);
        items.push(<circle key={`o${si}-${pi}`} data-vpt={`${si}:${pi}:out`} className="handle" cx={o.x} cy={o.y} r={4} fill="white" stroke="#0d99ff" />);
      }
      if (hasIn) {
        const o = toScreen(v, apply(m, { x: p.x + p.inX, y: p.y + p.inY }));
        items.push(<line key={`li${si}-${pi}`} x1={a.x} y1={a.y} x2={o.x} y2={o.y} stroke="#0d99ff" />);
        items.push(<circle key={`i${si}-${pi}`} data-vpt={`${si}:${pi}:in`} className="handle" cx={o.x} cy={o.y} r={4} fill="white" stroke="#0d99ff" />);
      }
      items.push(<rect key={`a${si}-${pi}`} data-vpt={`${si}:${pi}:anchor`} className="handle" x={a.x - 4} y={a.y - 4} width={8} height={8} fill="white" stroke="#0d99ff" />);
    }),
  );
  return <g>{items}</g>;
}
