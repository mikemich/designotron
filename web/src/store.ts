// Editor state: wraps the WASM engine (source of truth for the document)
// and holds UI-only state in a zustand store.

import { create } from "zustand";
import init, { clearMeasureCache, WasmEngine } from "./wasm/pkg/designotron_engine_wasm";
import wasmUrl from "./wasm/pkg/designotron_engine_wasm_bg.wasm?url";
import type { Doc, EngineState, Gap, Guide, Node, Rect, Tool } from "./types";
import { assetUrl } from "./assets";
import { COMPACT_QUERY, TIGHT_QUERY, panelShown, readPanels, setPanel, toggleUi as toggleUiPanels, writePanels, type Panels } from "./panelState";

export const FONTS = [
  "Inter",
  "Roboto",
  "Poppins",
  "Montserrat",
  "Playfair Display",
  "DM Sans",
  "Space Grotesk",
  "JetBrains Mono",
  "Lato",
  "Open Sans",
];

let engine: WasmEngine | null = null;
const measureCache = new Map<string, number>();

/** Loads the WASM engine, installs the text measurer and waits for web fonts. */
let booting: Promise<void> | null = null;

/** Why the engine failed to load (shown with a Retry button), or null. */
export const useBoot = create<{ error: string | null }>(() => ({ error: null }));

/** Loads the WASM engine once; every caller shares the same load. A failure can be retried. */
export function bootEngine(): Promise<void> {
  booting ??= loadEngine().then(
    () => useBoot.setState({ error: null }),
    (err) => {
      booting = null;
      useBoot.setState({ error: String(err instanceof Error ? err.message : err) });
      throw err;
    },
  );
  return booting;
}

async function loadEngine(): Promise<void> {
  const ctx = document.createElement("canvas").getContext("2d")!;
  (globalThis as any).dtMeasureText = (family: string, size: number, weight: number, italic: boolean, text: string) => {
    const font = `${italic ? "italic " : ""}${weight} ${size}px "${family}", sans-serif`;
    const key = font + "\u0000" + text;
    let w = measureCache.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width;
      if (measureCache.size > 50000) measureCache.clear();
      measureCache.set(key, w);
    }
    return w;
  };
  const embedded = (globalThis as any).__DT_WASM_B64 as string | undefined;
  const source = embedded ? Uint8Array.from(atob(embedded), (c) => c.charCodeAt(0)) : wasmUrl;
  await init({ module_or_path: source });
  await Promise.race([
    Promise.all(FONTS.flatMap((f) => [400, 600, 700].map((w) => document.fonts.load(`${w} 16px "${f}"`).catch(() => null)))),
    new Promise((r) => setTimeout(r, 2500)),
  ]);
  engine = new WasmEngine(Math.floor(Math.random() * 2 ** 48));
  document.fonts.addEventListener("loadingdone", () => {
    measureCache.clear();
    clearMeasureCache();
    dispatch({ op: "relayout" });
  });
}

/** Whether a document JSON loads in the engine, without touching the open file. */
export async function documentLoads(json: string): Promise<boolean> {
  await bootEngine();
  const probe = new WasmEngine(1);
  try {
    probe.load(json);
    return true;
  } catch {
    return false;
  } finally {
    probe.free();
  }
}

/** Replaces the engine with a fresh one holding an empty document. */
export function newEngine(): WasmEngine {
  engine = new WasmEngine(Math.floor(Math.random() * 2 ** 48));
  docCache = null;
  lastDocRev = -1;
  // The new engine's revisions restart, so nothing counts as saved until the opener says so.
  useStore.setState({ rev: -1, savedDocRev: -1 });
  sync();
  return engine;
}

export function getEngine(): WasmEngine {
  if (!engine) throw new Error("engine not booted");
  return engine;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export type RightTab = "design" | "prototype" | "code" | "review" | "app";
export type LeftTab = "layers" | "assets" | "history" | "comments";

interface Store {
  rev: number;
  es: EngineState;
  tool: Tool;
  viewport: Viewport;
  /** The view is being zoomed (wheel, pinch, zoom commands) and for a moment after. */
  zooming: boolean;
  hover: string | null;
  editingText: string | null;
  editingVector: string | null;
  /** Pages whose empty-page prompt was closed in this session (it still goes away once something is drawn). */
  emptyPromptClosed: string[];
  /** A layer the Layers tree should start renaming (F2 on the canvas); the tree clears it. */
  renameRequest: string | null;
  /** Anchors selected in vector edit mode, as [subpath, index]. */
  vectorPoints: [number, number][];
  guides: Guide[];
  /** Equal gaps the current drag snapped to (pink spacing guides). */
  gaps: Gap[];
  marquee: Rect | null;
  rightTab: RightTab;
  leftTab: LeftTab;
  chatOpen: boolean;
  /** The Layers (left) and Design (right) panels: open or closed. Below 1100 px they overlay the canvas. */
  panels: Panels;
  /** What Ctrl+\ hid, to bring back. */
  panelsStash: Panels | null;
  /** Tablet width (up to 1100 px): panels are overlays and start closed. */
  compact: boolean;
  /** Up to 1280 px: Claude's chat takes the Design panel's place. */
  tight: boolean;
  presenting: string | null;
  fileId: string | null;
  /** The document has changes that aren't in storage yet (engine docRev !== savedDocRev). */
  dirty: boolean;
  /** Engine `docRev` that is safely stored; -1 until the opened file says so. */
  savedDocRev: number;
  /** The last save attempt failed. */
  saveFailed: boolean;
  /** This tab only shows the file (another tab edits it): the engine still allows comments, undo
   * and replacing the document in read-only mode, which here would be lost, so `dispatch` refuses them. */
  tabView: boolean;
  toast: { text: string; kind: "info" | "error" } | null;
  dropTarget: string | null;
  /** Insertion line `[x1, y1, x2, y2]` (page space) for a layer about to enter an auto layout frame. */
  dropLine: [number, number, number, number] | null;
  /** Character range selected in the text being edited (code points). */
  textSel: { id: string; start: number; end: number } | null;
  showRulers: boolean;
  showGrids: boolean;
  variablesOpen: boolean;
  /** "new": opened from the files dashboard (no file exists until Import); "result": the editor shows the
   *  warnings of an import that just ran (`figmaResult`). */
  figmaOpen: boolean | "new" | "result";
  /** Fetched Figma data waiting for its new file (`fileId`) to open; that editor imports it once and clears it. */
  pendingFigma: { fileId: string; file: unknown; images: Record<string, string> } | null;
  /** The warnings shown by the dialog's result view when the import ran as the file opened. */
  figmaResult: { pages: string[]; layers: number; warnings: string[] } | null;
  /** A control on the dashboard to focus once it mounts (its `data-focus-key`), set by flows that end there. */
  focusOnDashboard: string | null;
  /** Comment thread open in a popover. */
  openComment: string | null;
  /** New comment being written at a page position. */
  draftComment: { x: number; y: number; node: string | null } | null;
  /** The gradient or image paint whose popover is open: its handles / crop frame show on the canvas (W3-D). */
  paintEdit: { id: string; key: "fills" | "strokes"; index: number } | null;
}

const pref = (k: string, d: boolean) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : v === "1";
  } catch {
    return d;
  }
};

/** Toggles a remembered view option (rulers, layout grids). */
export function toggleView(key: "showRulers" | "showGrids") {
  const on = !useStore.getState()[key];
  useStore.setState({ [key]: on } as Partial<Store>);
  try {
    localStorage.setItem(`dt:${key}`, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const media = (q: string) => typeof window !== "undefined" && !!window.matchMedia?.(q).matches;
const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
const startCompact = media(COMPACT_QUERY);

export const useStore = create<Store>(() => ({
  rev: 0,
  es: { rev: 0, docRev: 0, page: "", selection: [], canUndo: false, canRedo: false, inGesture: false },
  tool: "move",
  viewport: { x: 0, y: 0, zoom: 1 },
  zooming: false,
  hover: null,
  editingText: null,
  editingVector: null,
  emptyPromptClosed: [],
  renameRequest: null,
  vectorPoints: [],
  guides: [],
  gaps: [],
  marquee: null,
  rightTab: "design",
  leftTab: "layers",
  chatOpen: false,
  panels: readPanels(startCompact, storage()),
  panelsStash: null,
  compact: startCompact,
  tight: media(TIGHT_QUERY),
  presenting: null,
  fileId: null,
  dirty: false,
  savedDocRev: -1,
  saveFailed: false,
  tabView: false,
  toast: null,
  dropTarget: null,
  dropLine: null,
  textSel: null,
  showRulers: pref("dt:showRulers", false),
  showGrids: pref("dt:showGrids", true),
  variablesOpen: false,
  figmaOpen: false,
  pendingFigma: null,
  figmaResult: null,
  focusOnDashboard: null,
  openComment: null,
  draftComment: null,
  paintEdit: null,
}));

/** Opens, closes or (without `open`) toggles a side panel. Remembered per mode (desktop, tablet). */
export function togglePanel(side: keyof Panels, open?: boolean) {
  const st = useStore.getState();
  const now = st.panels[side] && !(side === "right" && st.chatOpen && st.tight);
  const r = setPanel(st.panels, side, open ?? !now, st.chatOpen, st.tight);
  const keep = keepCentre(st, r.panels, r.chatOpen);
  useStore.setState({ panels: r.panels, chatOpen: r.chatOpen, panelsStash: null, ...keep });
  writePanels(st.compact, r.panels, storage());
}

/** Ctrl+\: hides the panels, or brings back the ones that were open. */
export function toggleUi() {
  const st = useStore.getState();
  const r = toggleUiPanels(st.panels, st.panelsStash, st.compact);
  // Claude stays as it was: where it covers the Design panel, that panel just isn't shown.
  const chatOpen = st.chatOpen;
  const keep = keepCentre(st, r.panels, chatOpen);
  // Focus inside a panel that is about to go: after the update it would drop to <body>.
  const inPanel = !!document.activeElement?.closest?.(".main > .panel, .main > .chat");
  useStore.setState({ panels: r.panels, panelsStash: r.stash, chatOpen, ...keep });
  writePanels(st.compact, r.panels, storage());
  if (inPanel) keepFocusVisible();
}

/** After a panel hides, puts focus on the canvas when it fell to <body> (or onto a node that is gone or hidden). */
function keepFocusVisible() {
  const fix = () => {
    const a = document.activeElement;
    const lost = !a || a === document.body || a === document.documentElement || !a.isConnected || ![...(a as HTMLElement).getClientRects()].some((c) => c.width > 0 && c.height > 0);
    if (lost) document.getElementById("dt-canvas")?.focus({ preventScroll: true });
  };
  // The panel hides on a later render and the browser drops focus when it does: when exactly varies, so
  // catch the blur itself (a focusout that lands on nothing), with a few timed passes as a backstop.
  const onOut = (e: FocusEvent) => {
    if (!e.relatedTarget) setTimeout(fix, 0);
  };
  document.addEventListener("focusout", onOut, true);
  const stop = () => document.removeEventListener("focusout", onOut, true);
  setTimeout(stop, 600);
  for (const ms of [50, 150, 300]) setTimeout(fix, ms);
  requestAnimationFrame(() => {
    fix();
    requestAnimationFrame(fix);
  });
}

/** Column widths of the panels (px), as in the stylesheet. */
const PANEL_W = { left: 248, right: 272 };

/** On a desktop a panel opening or closing changes the canvas width: the viewport moves by half
 * of that so the page point at the canvas centre stays at its centre. (Tablet overlays don't
 * resize the canvas.) */
function keepCentre(st: Store, next: Panels, chatOpen: boolean): Partial<Store> {
  if (st.compact) return {};
  let dw = 0;
  for (const side of ["left", "right"] as const) {
    const was = panelShown(st.panels, side, st.chatOpen, st.tight);
    const now = panelShown(next, side, chatOpen, st.tight);
    if (was !== now) dw += was ? PANEL_W[side] : -PANEL_W[side];
  }
  return dw ? { viewport: { ...st.viewport, x: st.viewport.x + dw / 2 } } : {};
}

// Crossing the tablet breakpoint swaps in that mode's own remembered panels.
if (typeof window !== "undefined" && window.matchMedia) {
  const compact = window.matchMedia(COMPACT_QUERY);
  const tight = window.matchMedia(TIGHT_QUERY);
  compact.addEventListener?.("change", () => {
    useStore.setState({ compact: compact.matches, panels: readPanels(compact.matches, storage()), panelsStash: null });
  });
  tight.addEventListener?.("change", () => useStore.setState({ tight: tight.matches }));
}

/** Applies a style to the selected characters of the text being edited; false if none. */
export function styleTextSelection(style: Record<string, unknown>, clear: string[] = []): boolean {
  const { editingText, textSel } = useStore.getState();
  if (!editingText || !textSel || textSel.id !== editingText || textSel.end <= textSel.start) return false;
  dispatch({ op: "styleText", id: editingText, start: textSel.start, end: textSel.end, style, clear });
  // After the current key event, so it can't land in the text being edited.
  requestAnimationFrame(() => window.dispatchEvent(new Event("dt-refocus-text")));
  return true;
}

const listeners = new Set<() => void>();
/** Engine `docRev` the listeners were last told about. */
let lastDocRev = -1;
/** Called after every change to the document itself (autosave, bridge sync, multiplayer), not
 * after selecting, switching page or ending a drag that changed nothing. */
export function onDocChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let docCache: { rev: number; doc: Doc } | null = null;
/** Layers that have layout grids, kept current with the document copy: most files have none,
 * and then nothing needs to look for grids to draw. */
const gridFrames = new Set<string>();
/** Device frames, kept the same way: the safe-area overlay only runs when there are any. */
const deviceFrames = new Set<string>();

/** Whether any layer of the document has layout grids. */
export function hasLayoutGrids(): boolean {
  getDoc();
  return gridFrames.size > 0;
}

/** Whether any layer of the document is a device frame. */
export function hasDeviceFrames(): boolean {
  getDoc();
  return deviceFrames.size > 0;
}

/** Parsed document for the current revision. Kept current from engine deltas, so a
 * change to one layer costs that layer, not the whole file. */
export function getDoc(): Doc {
  const e = getEngine();
  const rev = e.rev();
  if (docCache && docCache.rev === rev) return docCache.doc;
  const d = JSON.parse(e.docDelta(!docCache));
  // Selecting and the like: keep the same object, so what is derived from it isn't redone.
  if (d.same && docCache) {
    docCache = { rev, doc: docCache.doc };
    return docCache.doc;
  }
  if (d.full || !docCache) {
    docCache = { rev, doc: d.full };
    gridFrames.clear();
    deviceFrames.clear();
    for (const id in d.full.nodes) {
      if (d.full.nodes[id].layoutGrids?.length) gridFrames.add(id);
      if (d.full.nodes[id].device) deviceFrames.add(id);
    }
  } else {
    // Patch the node table in place (changed nodes are new objects; the table is shared).
    const nodes = docCache.doc.nodes;
    Object.assign(nodes, d.nodes);
    for (const id in d.nodes) {
      if (d.nodes[id].layoutGrids?.length) gridFrames.add(id);
      else gridFrames.delete(id);
      if (d.nodes[id].device) deviceFrames.add(id);
      else deviceFrames.delete(id);
    }
    for (const id of d.removed) {
      delete nodes[id];
      gridFrames.delete(id);
      deviceFrames.delete(id);
    }
    docCache = { rev, doc: { ...d.meta, nodes } };
  }
  return docCache.doc;
}

/** Subscribes a component to document changes and returns the document. */
export function useDoc(): Doc {
  useStore((s) => s.rev);
  return getDoc();
}

export function useSelection(): Node[] {
  const doc = useDoc();
  const sel = useStore((s) => s.es.selection);
  return sel.map((id) => doc.nodes[id]).filter(Boolean);
}

/** Records that the document as of engine `docRev` is stored (or that a file just opened). */
export function markSaved(docRev: number) {
  useStore.setState((s) => ({ savedDocRev: docRev, dirty: s.es.docRev !== docRev, saveFailed: false }));
}

/** Pulls revision and state from the engine into the store. */
export function sync() {
  const e = getEngine();
  const rev = e.rev();
  const st = useStore.getState();
  if (rev === st.rev) return;
  const es: EngineState = JSON.parse(e.state());
  // Selecting or switching page moves `rev` but not `docRev`: nothing to save.
  useStore.setState({ rev, es, dirty: es.docRev !== st.savedDocRev });
  dropStalePoints();
  if (es.docRev === lastDocRev) return;
  lastDocRev = es.docRev;
  listeners.forEach((l) => l());
}

/** True while a pointer drag is in progress on the canvas (keyboard edits must wait). */
export const pointerDrag = { active: false };

// Point selection belongs to one vector edit session and is made of indices, so it must not
// outlive a change in the path's shape: undo/redo, or a collaborator adding/removing anchors.
let pathShape: string | null = null;
function shapeOf(id: string | null): string | null {
  const sps = id ? getDoc().nodes[id]?.vector?.subpaths : null;
  return sps ? sps.map((sp) => `${sp.points.length}${sp.closed ? "c" : "o"}`).join(",") : null;
}
function dropStalePoints() {
  const st = useStore.getState();
  const shape = shapeOf(st.editingVector);
  if (shape !== pathShape && st.vectorPoints.length) useStore.setState({ vectorPoints: [] });
  pathShape = shape;
}
useStore.subscribe((s, prev) => {
  if (s.editingVector !== prev.editingVector) {
    pathShape = shapeOf(s.editingVector);
    if (s.vectorPoints.length) useStore.setState({ vectorPoints: [] });
  }
});

export function toast(text: string, kind: "info" | "error" = "info") {
  useStore.setState({ toast: { text, kind } });
  setTimeout(() => {
    if (useStore.getState().toast?.text === text) useStore.setState({ toast: null });
    // Long enough to read: about 15 characters a second, at least 2.5 s (5 s for errors).
  }, Math.max(kind === "error" ? 5000 : 2500, text.length * 65));
}

/** Runs an engine command. Errors surface as a toast and return null. */
const TAB_VIEW_REFUSED = new Set(["addComment", "replyComment", "resolveComment", "undo", "redo", "replaceDocument"]);

export function dispatch<T = any>(cmd: Record<string, unknown>, opts: { quiet?: boolean } = {}): T | null {
  if (useStore.getState().tabView && TAB_VIEW_REFUSED.has(cmd.op as string)) return null;
  try {
    const r = JSON.parse(getEngine().dispatch(JSON.stringify(cmd)));
    sync();
    if ((cmd.op === "undo" || cmd.op === "redo") && useStore.getState().vectorPoints.length) useStore.setState({ vectorPoints: [] });
    return r;
  } catch (err) {
    if (!opts.quiet) toast(String(err), "error");
    return null;
  }
}

/** Throwing variant for callers that report errors themselves (AI tools). */
export function dispatchOrThrow<T = any>(cmd: Record<string, unknown>): T {
  const r = JSON.parse(getEngine().dispatch(JSON.stringify(cmd)));
  sync();
  return r;
}

/** Runs an AI tool through the engine. Given a `group`, its undo step joins that chat turn's
 *  group, so one Ctrl+Z undoes the whole turn. The group is only open for this call, so
 *  the user's own edits in between are steps of their own. */
export function aiDispatch<T = any>(tool: string, input: unknown, group?: string): T {
  const engine = getEngine();
  const setGroup = (g: string | null) => engine.dispatch(JSON.stringify({ op: "setHistoryGroup", group: g }));
  try {
    if (group) setGroup(group);
    return JSON.parse(engine.dispatch(JSON.stringify({ op: "ai", tool, input })));
  } finally {
    if (group) setGroup(null);
    sync();
  }
}

export function query<T = any>(q: Record<string, unknown>): T {
  return JSON.parse(getEngine().query(JSON.stringify(q)));
}

export function selection(): string[] {
  return useStore.getState().es.selection;
}

export function currentPage(): string {
  return useStore.getState().es.page;
}

/** Engine SVG for a page with asset references resolved to object URLs. */
export function renderPage(page: string, hidden: string[], editing = ""): string {
  return resolveAssets(getEngine().render(page, JSON.stringify(hidden), editing));
}

export type RenderUpdate =
  | { full: string }
  | {
      order: string[];
      changed: Record<string, string>;
      moved: Record<string, string>;
      /** Page-space `[x, y, width, height]` of everything a root paints (roots that changed or moved). */
      bounds: Record<string, [number, number, number, number]>;
      /** Text layers in a root that changed. */
      texts: Record<string, number>;
    };

/** Incremental canvas render: only top-level layers changed since the last call come back. */
export function renderPageIncremental(page: string, hidden: string[], reset: boolean, editing = ""): RenderUpdate {
  const r = JSON.parse(getEngine().renderIncremental(page, JSON.stringify(hidden), reset, editing));
  if ("full" in r) return { full: resolveAssets(r.full) };
  for (const k in r.changed) r.changed[k] = resolveAssets(r.changed[k]);
  return r;
}

export function resolveAssets(svg: string): string {
  return svg.replace(/asset:([a-z0-9_]+)/g, (m, id) => assetUrl(id) ?? m);
}

/** How long after the last zoom step the view still counts as zooming. */
const ZOOM_SETTLE_MS = 150;
let zoomTimer: ReturnType<typeof setTimeout> | undefined;

/** Marks the view as zooming until `ZOOM_SETTLE_MS` after the last call, so the canvas can
 * draw big pages cheaply (text as bars) while the zoom is moving. */
export function noteZooming() {
  if (!useStore.getState().zooming) useStore.setState({ zooming: true });
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => useStore.setState({ zooming: false }), ZOOM_SETTLE_MS);
}

export function setTool(tool: Tool) {
  if (tool === "comment" && useStore.getState().tabView) return;
  useStore.setState({ tool, editingVector: null });
}

export function screenToPage(sx: number, sy: number): { x: number; y: number } {
  const { viewport: v } = useStore.getState();
  return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom };
}

/** Scrolls/zooms so a page-space rect is visible in the canvas element. */
export function zoomToRect(r: Rect | null, canvasW: number, canvasH: number, maxZoom = 1) {
  if (!r) return;
  const pad = 80;
  const zoom = Math.min(maxZoom, (canvasW - pad * 2) / Math.max(r.width, 1), (canvasH - pad * 2) / Math.max(r.height, 1));
  const z = Math.max(0.02, Math.min(256, zoom));
  noteZooming();
  useStore.setState({ viewport: { zoom: z, x: canvasW / 2 - (r.x + r.width / 2) * z, y: canvasH / 2 - (r.y + r.height / 2) * z } });
}

export function canvasSize(): { w: number; h: number } {
  const el = document.getElementById("dt-canvas");
  return { w: el?.clientWidth ?? 800, h: el?.clientHeight ?? 600 };
}

export function zoomToFit() {
  const doc = getDoc();
  const page = doc.pages.find((p) => p.id === currentPage());
  const { w, h } = canvasSize();
  const u = query<{ union: Rect | null }>({ q: "bounds", ids: page?.children ?? [] }).union;
  if (u) zoomToRect(u, w, h, 1);
  else useStore.setState({ viewport: { x: w / 2, y: h / 2, zoom: 1 } });
}

export function zoomToSelection() {
  const u = query<{ union: Rect | null }>({ q: "bounds", ids: selection() }).union;
  const { w, h } = canvasSize();
  zoomToRect(u, w, h, 8);
}

export function zoomBy(factor: number, cx?: number, cy?: number) {
  const { viewport: v } = useStore.getState();
  const { w, h } = canvasSize();
  const px = cx ?? w / 2;
  const py = cy ?? h / 2;
  const zoom = Math.max(0.02, Math.min(256, v.zoom * factor));
  const k = zoom / v.zoom;
  noteZooming();
  useStore.setState({ viewport: { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k } });
}

// Debug/automation handle (used by scripts/e2e.mjs and handy in devtools).
(globalThis as any).__dt = {
  state: () => useStore.getState().es,
  doc: () => getDoc(),
  dispatch: (cmd: Record<string, unknown>) => dispatch(cmd),
  query: (q: Record<string, unknown>) => query(q),
  zoomToFit: () => zoomToFit(),
  edit: (id: string) => useStore.setState({ editingText: id }),
  viewport: () => useStore.getState().viewport,
  dirty: () => useStore.getState().dirty,
  setViewport: (v: Viewport) => useStore.setState({ viewport: v }),
  onDocChange: (fn: () => void) => onDocChange(fn),
  vectorEdit: () => ({ id: useStore.getState().editingVector, points: useStore.getState().vectorPoints }),
};

// ---------- Keyboard selection helpers ----------

/** Ids of the layers beside `id` (its parent's children, or the page's top-level layers), in document order. */
function siblingsOf(id: string): string[] {
  const doc = getDoc();
  const n = doc.nodes[id];
  if (!n) return [];
  return (n.parent ? doc.nodes[n.parent]?.children : doc.pages.find((p) => p.id === n.page)?.children) ?? [];
}

/** Selects the next (or previous) visible sibling of the first selected layer, wrapping around.
 * Tab and Shift+Tab on the canvas. False when nothing is selected. */
export function selectSibling(dir: 1 | -1): boolean {
  const doc = getDoc();
  const first = selection()[0];
  if (!first || !doc.nodes[first]) return false;
  const sibs = siblingsOf(first);
  const at = sibs.indexOf(first);
  for (let step = 1; step <= sibs.length; step++) {
    const id = sibs[(((at + dir * step) % sibs.length) + sibs.length) % sibs.length];
    if (doc.nodes[id]?.visible) {
      dispatch({ op: "select", ids: [id] });
      return true;
    }
  }
  return true;
}

/** What a screen reader hears when the selection changes: "Button (frame) 120×40, 2 of 5 in Card". */
export function describeSelection(): string {
  const doc = getDoc();
  const ids = selection().filter((id) => doc.nodes[id]);
  if (!ids.length) return "Nothing selected";
  if (ids.length > 1) return `${ids.length} layers selected`;
  const n = doc.nodes[ids[0]];
  const sibs = siblingsOf(n.id);
  const where = n.parent ? doc.nodes[n.parent]?.name : doc.pages.find((p) => p.id === n.page)?.name;
  return `${n.name || n.type} (${n.type}) ${Math.round(n.width)}×${Math.round(n.height)}, ${sibs.indexOf(n.id) + 1} of ${sibs.length} in ${where ?? "page"}`;
}

/** The open editor's autosave: Ctrl+S runs it at once (set by `Editor`, null while no file is open). */
export const saveHook: { flush: (() => Promise<void>) | null } = { flush: null };

/** Closes the empty-page prompt for a page until the editor is reloaded, and makes later ones compact. */
export function closeEmptyPrompt(page: string) {
  // After the first close, blank files show the compact pill instead of the centred card.
  try {
    localStorage.setItem("dt:emptyPrompt", "compact");
  } catch {
    /* storage unavailable */
  }
  const key = emptyPromptKey(page);
  useStore.setState((s) => (s.emptyPromptClosed.includes(key) ? s : { emptyPromptClosed: [...s.emptyPromptClosed, key] }));
}

/** Page ids repeat between files, so the closed prompts are keyed by file too. */
export const emptyPromptKey = (page: string) => `${useStore.getState().fileId ?? ""}:${page}`;
