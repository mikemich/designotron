// Editor state: wraps the WASM engine (source of truth for the document)
// and holds UI-only state in a zustand store.

import { create } from "zustand";
import init, { WasmEngine } from "./wasm/pkg/designotron_engine_wasm";
import wasmUrl from "./wasm/pkg/designotron_engine_wasm_bg.wasm?url";
import type { Doc, EngineState, Guide, Node, Rect, Tool } from "./types";
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
export async function bootEngine(): Promise<void> {
  if (engine) return;
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

/** Replaces the engine with a fresh one holding an empty document. */
export function newEngine(): WasmEngine {
  engine = new WasmEngine(Math.floor(Math.random() * 2 ** 48));
  docCache = null;
  useStore.setState({ rev: -1 });
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

export type RightTab = "design" | "prototype" | "code" | "review";
export type LeftTab = "layers" | "assets";

interface Store {
  rev: number;
  es: EngineState;
  tool: Tool;
  viewport: Viewport;
  hover: string | null;
  editingText: string | null;
  editingVector: string | null;
  guides: Guide[];
  marquee: Rect | null;
  rightTab: RightTab;
  leftTab: LeftTab;
  chatOpen: boolean;
  presenting: string | null;
  fileId: string | null;
  dirty: boolean;
  toast: { text: string; kind: "info" | "error" } | null;
  dropTarget: string | null;
  /** Character range selected in the text being edited (code points). */
  textSel: { id: string; start: number; end: number } | null;
}

export const useStore = create<Store>(() => ({
  rev: 0,
  es: { rev: 0, page: "", selection: [], canUndo: false, canRedo: false, inGesture: false },
  tool: "move",
  viewport: { x: 0, y: 0, zoom: 1 },
  hover: null,
  editingText: null,
  editingVector: null,
  guides: [],
  marquee: null,
  rightTab: "design",
  leftTab: "layers",
  chatOpen: false,
  presenting: null,
  fileId: null,
  dirty: false,
  toast: null,
  dropTarget: null,
  textSel: null,
}));

/** Applies a style to the selected characters of the text being edited; false if none. */
export function styleTextSelection(style: Record<string, unknown>, clear: string[] = []): boolean {
  const { editingText, textSel } = useStore.getState();
  if (!editingText || !textSel || textSel.id !== editingText || textSel.end <= textSel.start) return false;
  dispatch({ op: "styleText", id: editingText, start: textSel.start, end: textSel.end, style, clear });
  window.dispatchEvent(new Event("dt-refocus-text"));
  return true;
}

const listeners = new Set<() => void>();
/** Called after every document change (autosave, bridge sync). */
export function onDocChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let docCache: { rev: number; doc: Doc } | null = null;

/** Parsed document for the current revision (cached). */
export function getDoc(): Doc {
  const e = getEngine();
  const rev = e.rev();
  if (!docCache || docCache.rev !== rev) docCache = { rev, doc: JSON.parse(e.save()) };
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

/** Pulls revision and state from the engine into the store. */
export function sync() {
  const e = getEngine();
  const rev = e.rev();
  const st = useStore.getState();
  if (rev === st.rev) return;
  const es: EngineState = JSON.parse(e.state());
  useStore.setState({ rev, es, dirty: true });
  listeners.forEach((l) => l());
}

export function toast(text: string, kind: "info" | "error" = "info") {
  useStore.setState({ toast: { text, kind } });
  setTimeout(() => {
    if (useStore.getState().toast?.text === text) useStore.setState({ toast: null });
  }, kind === "error" ? 5000 : 2500);
}

/** Runs an engine command. Errors surface as a toast and return null. */
export function dispatch<T = any>(cmd: Record<string, unknown>, opts: { quiet?: boolean } = {}): T | null {
  try {
    const r = JSON.parse(getEngine().dispatch(JSON.stringify(cmd)));
    sync();
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
};
