// Editor state: wraps the WASM engine (source of truth for the document)
// and holds UI-only state in a zustand store.

import { create } from "zustand";
import init, { WasmEngine } from "./wasm/pkg/designotron_engine_wasm";
import wasmUrl from "./wasm/pkg/designotron_engine_wasm_bg.wasm?url";
import type { Doc, EngineState, Gap, Guide, Node, Rect, Tool } from "./types";
import { assetUrl } from "./assets";

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
  hover: string | null;
  editingText: string | null;
  editingVector: string | null;
  /** Anchors selected in vector edit mode, as [subpath, index]. */
  vectorPoints: [number, number][];
  guides: Guide[];
  /** Equal gaps the current drag snapped to (pink spacing guides). */
  gaps: Gap[];
  marquee: Rect | null;
  rightTab: RightTab;
  leftTab: LeftTab;
  chatOpen: boolean;
  presenting: string | null;
  fileId: string | null;
  /** The document has changes that aren't in storage yet (engine docRev !== savedDocRev). */
  dirty: boolean;
  /** Engine `docRev` that is safely stored; -1 until the opened file says so. */
  savedDocRev: number;
  /** The last save attempt failed. */
  saveFailed: boolean;
  toast: { text: string; kind: "info" | "error" } | null;
  dropTarget: string | null;
  /** Character range selected in the text being edited (code points). */
  textSel: { id: string; start: number; end: number } | null;
  showRulers: boolean;
  showGrids: boolean;
  variablesOpen: boolean;
  /** "new": opened from the files dashboard for a new file, which is discarded if nothing is imported. */
  figmaOpen: boolean | "new";
  /** Comment thread open in a popover. */
  openComment: string | null;
  /** New comment being written at a page position. */
  draftComment: { x: number; y: number; node: string | null } | null;
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

export const useStore = create<Store>(() => ({
  rev: 0,
  es: { rev: 0, docRev: 0, page: "", selection: [], canUndo: false, canRedo: false, inGesture: false },
  tool: "move",
  viewport: { x: 0, y: 0, zoom: 1 },
  hover: null,
  editingText: null,
  editingVector: null,
  vectorPoints: [],
  guides: [],
  gaps: [],
  marquee: null,
  rightTab: "design",
  leftTab: "layers",
  chatOpen: false,
  presenting: null,
  fileId: null,
  dirty: false,
  savedDocRev: -1,
  saveFailed: false,
  toast: null,
  dropTarget: null,
  textSel: null,
  showRulers: pref("dt:showRulers", false),
  showGrids: pref("dt:showGrids", true),
  variablesOpen: false,
  figmaOpen: false,
  openComment: null,
  draftComment: null,
}));

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
/** Called after every document change (autosave, bridge sync). */
export function onDocChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let docCache: { rev: number; doc: Doc } | null = null;

/** Parsed document for the current revision. Kept current from engine deltas, so a
 * change to one layer costs that layer, not the whole file. */
export function getDoc(): Doc {
  const e = getEngine();
  const rev = e.rev();
  if (docCache && docCache.rev === rev) return docCache.doc;
  const d = JSON.parse(e.docDelta(!docCache));
  if (d.full || !docCache) {
    docCache = { rev, doc: d.full };
  } else {
    // Patch the node table in place (changed nodes are new objects; the table is shared).
    const nodes = docCache.doc.nodes;
    Object.assign(nodes, d.nodes);
    for (const id of d.removed) delete nodes[id];
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
export function dispatch<T = any>(cmd: Record<string, unknown>, opts: { quiet?: boolean } = {}): T | null {
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
export function renderPage(page: string, hidden: string[]): string {
  return resolveAssets(getEngine().render(page, JSON.stringify(hidden)));
}

export type RenderUpdate = { full: string } | { order: string[]; changed: Record<string, string>; moved: Record<string, string> };

/** Incremental canvas render: only top-level layers changed since the last call come back. */
export function renderPageIncremental(page: string, hidden: string[], reset: boolean): RenderUpdate {
  const r = JSON.parse(getEngine().renderIncremental(page, JSON.stringify(hidden), reset));
  if ("full" in r) return { full: resolveAssets(r.full) };
  for (const k in r.changed) r.changed[k] = resolveAssets(r.changed[k]);
  return r;
}

export function resolveAssets(svg: string): string {
  return svg.replace(/asset:([a-z0-9_]+)/g, (m, id) => assetUrl(id) ?? m);
}

export function setTool(tool: Tool) {
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
  vectorEdit: () => ({ id: useStore.getState().editingVector, points: useStore.getState().vectorPoints }),
};
