// User-level actions shared by menus, keyboard shortcuts and context menus.

import { addAsset, imageSize, readFileAsDataUrl } from "./assets";
import { exportProjectZip } from "./exporter";
import { download, getFileMeta, importDtron, pickFile, toDtron } from "./files";
import {
  canvasSize,
  currentPage,
  dispatch,
  getDoc,
  getEngine,
  query,
  selection,
  setTool,
  screenToPage,
  toast,
  useStore,
} from "./store";
import { openTextGesture } from "./canvas/TextEditor";
import type { Rect, Tool } from "./types";

const CLIPBOARD_TAG = "designotron/nodes";

export const undo = () => dispatch({ op: "undo" });
export const redo = () => dispatch({ op: "redo" });
export const deleteSelection = () => dispatch({ op: "delete", ids: selection() });
export const duplicate = () => dispatch({ op: "duplicate", ids: selection() });
export const group = () => selection().length && dispatch({ op: "group", ids: selection() });
export const ungroup = () => dispatch({ op: "ungroup", ids: selection() });
export const frameSelection = () => selection().length && dispatch({ op: "frameSelection", ids: selection() });
export const addAutoLayout = () => selection().length && dispatch({ op: "addAutoLayout", ids: selection() });
export const createComponent = () => selection().length && dispatch({ op: "createComponent", ids: selection() });
export const combineVariants = () => dispatch({ op: "combineVariants", ids: selection() });
export const detachInstance = () => dispatch({ op: "detachInstance", ids: selection() });
export const selectAll = () => dispatch({ op: "selectAll" });
export type BoolOp = "union" | "subtract" | "intersect" | "exclude";
export const booleanOp = (operation: BoolOp) => selection().length > 1 && dispatch({ op: "booleanOp", ids: selection(), operation });
export const flatten = () => selection().length && dispatch({ op: "flatten", ids: selection() });
export const outlineStroke = () => selection().length && dispatch({ op: "outlineStroke", ids: selection() });
export const useAsMask = () => selection().length && dispatch({ op: "useAsMask", ids: selection() });
export const reorder = (to: "front" | "back" | "forward" | "backward") => dispatch({ op: "reorder", ids: selection(), to });
export const align = (how: "left" | "hCenter" | "right" | "top" | "vCenter" | "bottom") => dispatch({ op: "align", ids: selection(), how });
export const distribute = (horizontal: boolean) => dispatch({ op: "distribute", ids: selection(), horizontal });
export const flip = (horizontal: boolean) => dispatch({ op: "flip", ids: selection(), horizontal });
export const nudge = (dx: number, dy: number) => dispatch({ op: "nudge", ids: selection(), dx, dy });

// ---------- Vector edit mode ----------

/** Selected anchors of the vector being edited that still exist (undo can remove some). */
export function vectorPoints(): [number, number][] {
  const st = useStore.getState();
  const sps = st.editingVector ? getDoc().nodes[st.editingVector]?.vector?.subpaths : null;
  return sps ? st.vectorPoints.filter(([s, i]) => i < (sps[s]?.points.length ?? 0)) : [];
}

/** Deletes the selected anchors; deleting all but one deletes the layer and leaves edit mode. */
export function deleteVectorPoints() {
  const id = useStore.getState().editingVector;
  const points = vectorPoints();
  if (!id || !points.length) return;
  const r = dispatch<{ deleted: boolean }>({ op: "deleteVectorPoints", id, points });
  useStore.setState(r?.deleted ? { editingVector: null } : { vectorPoints: [] });
  if (r?.deleted) toast("Path deleted: it needs at least two points");
}

export function nudgeVectorPoints(dx: number, dy: number) {
  const id = useStore.getState().editingVector;
  const points = vectorPoints();
  if (id && points.length) dispatch({ op: "moveVectorPoints", id, points, dx, dy });
}

export function selectAllVectorPoints() {
  const id = useStore.getState().editingVector;
  const sps = id ? getDoc().nodes[id]?.vector?.subpaths ?? [] : [];
  useStore.setState({ vectorPoints: sps.flatMap((sp, s) => sp.points.map((_, i) => [s, i] as [number, number])) });
}

/** Makes an anchor sharp if it has handles, else smooth. */
export function toggleVectorPointSmooth(sub: number, index: number) {
  const id = useStore.getState().editingVector;
  const p = id ? getDoc().nodes[id]?.vector?.subpaths[sub]?.points[index] : null;
  if (!id || !p) return;
  const smooth = !(p.inX || p.inY || p.outX || p.outY);
  dispatch({ op: "setVectorPointsSmooth", id, points: [[sub, index]], smooth });
}

/** Runs several edits as one undo step. */
function oneStep(fn: () => void) {
  dispatch({ op: "beginGesture" });
  try {
    fn();
  } finally {
    dispatch({ op: "endGesture" });
  }
}

export function toggleVisibility(ids = selection()) {
  const doc = getDoc();
  oneStep(() => {
    for (const id of ids) {
      const n = doc.nodes[id];
      if (n) dispatch({ op: "update", ids: [id], patch: { visible: !n.visible } });
    }
  });
}

export function toggleLock(ids = selection()) {
  const doc = getDoc();
  oneStep(() => {
    for (const id of ids) {
      const n = doc.nodes[id];
      if (n) dispatch({ op: "update", ids: [id], patch: { locked: !n.locked } });
    }
  });
}

export function selectParent() {
  const doc = getDoc();
  const parents = [...new Set(selection().map((id) => doc.nodes[id]?.parent).filter(Boolean))] as string[];
  dispatch({ op: "select", ids: parents });
}

export function selectChildren() {
  const doc = getDoc();
  const kids = selection().flatMap((id) => doc.nodes[id]?.children ?? []);
  if (kids.length) dispatch({ op: "select", ids: kids });
  else {
    const only = selection().length === 1 ? doc.nodes[selection()[0]] : null;
    if (only?.type === "text") useStore.setState({ editingText: only.id });
  }
}

// ---------- Keyboard insert ----------

/** Size of the layer Enter inserts for each drawing tool (what a click without a drag makes). */
const INSERT_SIZE: Partial<Record<Tool, { w: number; h: number }>> = {
  rectangle: { w: 100, h: 100 },
  ellipse: { w: 100, h: 100 },
  polygon: { w: 100, h: 100 },
  star: { w: 100, h: 100 },
  line: { w: 100, h: 0 },
  arrow: { w: 100, h: 0 },
  frame: { w: 390, h: 844 },
  text: { w: 0, h: 0 },
};

/** Whether the active tool draws a layer, so Enter can insert one from the keyboard. */
export function canInsertWithKeyboard(): boolean {
  return useStore.getState().tool in INSERT_SIZE;
}

/** Inserts the active tool's default layer centred in the viewport, selects it and goes back to the
 * Move tool: one undo step. A frame is 390×844, or 100×100 when a frame is selected (it goes
 * inside); with `inSelected` (Ctrl+Enter) the layer goes inside the selected frame, at the
 * viewport centre if that lies in the frame and else at the frame's centre. Text opens for typing. */
export function insertDefaultLayer(inSelected = false): boolean {
  const tool = useStore.getState().tool;
  const size = INSERT_SIZE[tool];
  if (!size) return false;
  const target = pasteTarget();
  const parent = inSelected || (tool === "frame" && target) ? target : null;
  let { w, h } = size;
  if (tool === "frame" && parent) w = h = 100;
  let c = viewportCenter();
  if (parent) {
    const box = query<{ items: { bounds: Rect }[] }>({ q: "bounds", ids: [parent] }).items[0]?.bounds;
    if (box && (c.x < box.x || c.x > box.x + box.width || c.y < box.y || c.y > box.y + box.height)) c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  const x = Math.round(c.x - w / 2);
  const y = Math.round(c.y - h / 2);
  if (tool === "text") {
    openTextGesture();
    const r = dispatch<{ id: string }>({ op: "createText", x: Math.round(c.x), y: Math.round(c.y), characters: "", parent });
    if (!r) dispatch({ op: "endGesture" });
    else useStore.setState({ editingText: r.id });
  } else if (tool === "arrow") {
    oneStep(() => {
      const r = dispatch<{ id: string }>({ op: "createShape", kind: "line", x, y, width: w, height: 0, parent });
      if (r) dispatch({ op: "update", ids: [r.id], patch: { shape: { endCap: "arrow" } } });
    });
  } else {
    dispatch({ op: "createShape", kind: tool === "line" ? "line" : tool, x, y, width: w, height: h, parent });
  }
  setTool("move");
  return true;
}

// ---------- Copy / paste properties (Figma ⌥⌘C / ⌥⌘V) ----------

/** Look properties pasted onto any layer. */
const LOOK_KEYS = ["opacity", "blendMode", "fills", "strokes", "strokeWeight", "strokeAlign", "strokeDash", "cornerRadius", "cornerRadii", "effects"] as const;
/** Type properties pasted onto text layers (never the characters, sizing mode or ranges). */
const TEXT_KEYS = ["fontFamily", "fontSize", "fontWeight", "italic", "lineHeight", "letterSpacing", "paragraphSpacing", "alignH", "alignV", "decoration", "case"] as const;

interface CopiedProps {
  look: Record<string, unknown>;
  text: Record<string, unknown> | null;
  fillStyle: string | null;
  effectStyle?: string | null;
  strokeStyle?: string | null;
  textStyle: string | null;
}

let copiedProps: CopiedProps | null = null;

/** Remembers the look of the first selected layer (fills, strokes, effects, radius, opacity, blend, text style). */
export function copyProperties() {
  const n = getDoc().nodes[selection()[0]];
  if (!n) {
    toast("Select a layer to copy its properties");
    return;
  }
  const look: Record<string, unknown> = {};
  for (const k of LOOK_KEYS) look[k] = structuredClone(n[k]);
  const text = n.text ? Object.fromEntries(TEXT_KEYS.map((k) => [k, n.text![k]])) : null;
  copiedProps = { look, text, fillStyle: n.fillStyle, textStyle: n.textStyle, effectStyle: n.effectStyle ?? null, strokeStyle: n.strokeStyle ?? null };
  toast(`Copied properties of ${n.name}`);
}

/** Pastes the copied properties onto the selection as one undo step. */
export function pasteProperties() {
  const p = copiedProps;
  if (!p) {
    toast("Copy properties first (select a layer, then ⌥⌘C)");
    return;
  }
  const doc = getDoc();
  const nodes = selection().map((id) => doc.nodes[id]).filter(Boolean);
  if (!nodes.length) return;
  const ids = nodes.map((n) => n.id);
  const texts = nodes.filter((n) => n.type === "text").map((n) => n.id);
  oneStep(() => {
    dispatch({ op: "update", ids, patch: { ...p.look, ...(p.fillStyle ? {} : { fillStyle: null }), ...(p.effectStyle ? {} : { effectStyle: null }), ...(p.strokeStyle ? {} : { strokeStyle: null }) } });
    // The style link goes in the same patch as the type values, and is cleared when the source has none
    // (a leftover link would let a later edit of the old style overwrite what was pasted).
    const textStyle = p.textStyle && doc.styles.texts.some((s) => s.id === p.textStyle) ? p.textStyle : null;
    if (p.text && texts.length) dispatch({ op: "update", ids: texts, patch: { text: p.text, textStyle } });
    // Editing fills detaches a colour style, so link it again; a plain update records it as an instance override.
    if (p.fillStyle && doc.styles.colors.some((s) => s.id === p.fillStyle)) dispatch({ op: "update", ids, patch: { fillStyle: p.fillStyle } });
    // Same for the stroke colour style and the effect style.
    const strokeStyle = p.strokeStyle && doc.styles.colors.some((s) => s.id === p.strokeStyle) ? p.strokeStyle : null;
    const effectStyle = p.effectStyle && doc.styles.effects?.some((s) => s.id === p.effectStyle) ? p.effectStyle : null;
    if (strokeStyle || effectStyle) dispatch({ op: "update", ids, patch: { ...(strokeStyle ? { strokeStyle } : {}), ...(effectStyle ? { effectStyle } : {}) } });
  });
  toast(`Pasted properties onto ${nodes.length === 1 ? nodes[0].name : `${nodes.length} layers`}`);
}

/** Page point at the centre of the visible canvas. */
export function viewportCenter(): { x: number; y: number } {
  const { w, h } = canvasSize();
  return screenToPage(w / 2, h / 2);
}

/** Parent for pasted content: the selected frame, if any. */
export function pasteTarget(): string | null {
  const doc = getDoc();
  const sel = selection();
  if (sel.length !== 1) return null;
  const n = doc.nodes[sel[0]];
  if (!n) return null;
  if (["frame", "component"].includes(n.type) && !n.instance) return n.id;
  return n.parent && doc.nodes[n.parent] && ["frame", "component"].includes(doc.nodes[n.parent].type) ? n.parent : null;
}

export function copyToClipboardData(e: ClipboardEvent) {
  const ids = selection();
  if (!ids.length) return;
  const data = query<string>({ q: "copy", ids });
  e.clipboardData?.setData("text/plain", data);
  e.preventDefault();
}

export function cut(e: ClipboardEvent) {
  copyToClipboardData(e);
  deleteSelection();
}

export async function pasteFromClipboardData(e: ClipboardEvent) {
  const dt = e.clipboardData;
  if (!dt) return;
  const image = [...dt.files].find((f) => f.type.startsWith("image/"));
  if (image) {
    e.preventDefault();
    const c = viewportCenter();
    await insertImageFile(image, c.x, c.y);
    return;
  }
  const text = dt.getData("text/plain");
  if (!text) return;
  e.preventDefault();
  if (text.includes(CLIPBOARD_TAG)) {
    dispatch({ op: "paste", data: text, ...pastePosition(text, pasteTarget()) });
    return;
  }
  if (isSvgText(text)) {
    const c = viewportCenter();
    // Only leading whitespace before the prolog stops the browser loading it; the rest is left
    // as it was (DOCTYPE entities, comments) so the image renders as the author made it.
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text.replace(/^\uFEFF/, "").trim());
    const { width, height } = await imageSize(url);
    dispatch({ op: "createImage", src: "asset:" + addAsset(url), x: c.x - width / 2, y: c.y - height / 2, width, height, name: "SVG", parent: null });
    return;
  }
  const c = viewportCenter();
  dispatch({ op: "createText", x: c.x, y: c.y, characters: text.slice(0, 5000), parent: pasteTarget() });
}

/**
 * Where a plain paste lands: at the copied layers' own position when any of it is in the viewport,
 * else centred in the viewport (`null` x/y keep the original position). Paste in place skips this.
 */
export function pastePosition(text: string, frame: string | null = null): { x: number | null; y: number | null; parent: string | null } {
  const top = { x: null, y: null, parent: null };
  try {
    const clip = JSON.parse(text) as { roots?: string[]; nodes?: { id: string; x: number; y: number; width: number; height: number }[] };
    const roots = new Set(clip.roots ?? []);
    const boxes = (clip.nodes ?? []).filter((n) => roots.has(n.id));
    if (!boxes.length) return { ...top, parent: frame };
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.width));
    const y1 = Math.max(...boxes.map((b) => b.y + b.height));
    const { w, h } = canvasSize();
    const a = screenToPage(0, 0);
    const z = screenToPage(w, h);
    const inView = (r: Rect) => r.x <= z.x && r.x + r.width >= a.x && r.y <= z.y && r.y + r.height >= a.y;
    const box = frame ? query<{ union: Rect | null }>({ q: "bounds", ids: [frame] }).union : null;
    if (frame && box && inView(box)) {
      // Into a frame: where it was if it fits in the frame there, else in the middle of the frame.
      if (x0 >= box.x && y0 >= box.y && x1 <= box.x + box.width && y1 <= box.y + box.height) return { x: null, y: null, parent: frame };
      return { x: Math.round(box.x + box.width / 2 - (x1 - x0) / 2), y: Math.round(box.y + box.height / 2 - (y1 - y0) / 2), parent: frame };
    }
    // No frame, or one that is out of view: top level, where it was if that is on screen, else at the view centre.
    if (inView({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })) return top;
    const c = viewportCenter();
    return { x: Math.round(c.x - (x1 - x0) / 2), y: Math.round(c.y - (y1 - y0) / 2), parent: null };
  } catch {
    return { ...top, parent: frame };
  }
}

/**
 * Whether pasted text is an SVG document, allowing the XML prolog, DOCTYPE and comments that
 * editors and exporters put in front of the `<svg>` tag.
 */
export function isSvgText(text: string): boolean {
  const s = text
    .replace(/^\uFEFF/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*<\?xml[\s\S]*?\?>/, "")
    .replace(/^\s*<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/i, "");
  return /^\s*<svg[\s>]/i.test(s);
}

export async function insertImageFile(file: File, x: number, y: number) {
  const url = await readFileAsDataUrl(file);
  const id = addAsset(url);
  let { width, height } = await imageSize(url);
  const max = 1200;
  if (width > max || height > max) {
    const k = max / Math.max(width, height);
    width = Math.round(width * k);
    height = Math.round(height * k);
  }
  dispatch({ op: "createImage", src: "asset:" + id, x: x - width / 2, y: y - height / 2, width, height, name: file.name.replace(/\.\w+$/, ""), parent: null });
}

export async function placeImage() {
  const f = await pickFile("image/*");
  if (!f) return;
  const c = viewportCenter();
  await insertImageFile(f, c.x, c.y);
  setTool("move");
}

export function saveDtron() {
  const doc = getDoc();
  download(`${doc.name || "Untitled"}.dtron`, toDtron(getEngine().save()), "application/json");
}

/** Opens a .dtron file as a new file next to this one (the open file is left as it is). */
export async function openDtronFile(f: File): Promise<boolean> {
  try {
    const here = useStore.getState().fileId;
    const id = await importDtron(await f.text(), f.name.replace(/\.(dtron|json)$/, ""), here ? (await getFileMeta(here))?.folder : undefined);
    location.hash = `#/file/${id}`;
    toast(`Opened ${f.name} as a new file`);
    return true;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
    return false;
  }
}

export async function openDtron(): Promise<boolean> {
  const f = await pickFile(".dtron,.json,application/json");
  return f ? openDtronFile(f) : false;
}


export const exportProject = () => exportProjectZip().catch((e) => toast(String(e), "error"));

export function newPage() {
  dispatch({ op: "addPage", name: null });
}

export function selectionBounds(): Rect | null {
  return query<{ union: Rect | null }>({ q: "bounds", ids: selection() }).union;
}

export function pageId() {
  return currentPage();
}

// ---------- Pages, selection and layout commands ----------

/** Selects layers, reporting when there are none. */
function selectFound(ids: string[], what: string) {
  if (!ids.length) {
    toast(`No ${what} found`);
    return;
  }
  dispatch({ op: "select", ids });
  toast(ids.length > 5000 ? `Selected ${ids.length} layers: that is a lot, edits to all of them may be slow` : `Selected ${ids.length} ${ids.length === 1 ? "layer" : "layers"}`);
}

/** Select matching layers (⌥⌘A): the same layers in the other top-level frames or groups. */
export function selectMatching() {
  const ids = selection();
  if (!ids.length) return toast("Select a layer to find its matches");
  const found = query<string[]>({ q: "matchingLayers", ids });
  if (found.length <= ids.length) return toast("No matching layers in other frames");
  selectFound(found, "matching layers");
}

export type SameProp = "fill" | "stroke" | "effect" | "text" | "font" | "instance";

/** Select all layers on the page with the same fill, stroke, effect, text properties, font or instance. */
export function selectSame(prop: SameProp) {
  const first = selection()[0];
  if (!first) return toast("Select a layer first");
  const found = query<string[]>({ q: "sameProperty", id: first, prop });
  selectFound(found, "layers with the same " + prop);
}

/** Select all instances of the selected main component or instance, on this page or on every page. */
export function selectInstances(allPages = false) {
  const first = selection()[0];
  const n = first ? getDoc().nodes[first] : null;
  if (!n || !["component", "instance", "componentSet"].includes(n.type)) return toast("Select a main component or an instance");
  selectFound(query<string[]>({ q: "instances", component: n.id, allPages }), "instances");
}

/** Invert selection (⇧⌘A): the siblings of the selection that aren't selected (visible and unlocked). */
export function invertSelection() {
  const doc = getDoc();
  const first = doc.nodes[selection()[0]];
  if (!first) return;
  const sibs = first.parent ? (doc.nodes[first.parent]?.children ?? []) : (doc.pages.find((p) => p.id === first.page)?.children ?? []);
  const chosen = new Set(selection());
  const rest = sibs.filter((id) => !chosen.has(id) && doc.nodes[id]?.visible && !doc.nodes[id]?.locked);
  if (rest.length) dispatch({ op: "select", ids: rest });
}

/** Tidy up (⌃⌥T): arranges the selected layers into an evenly spaced grid. */
export function tidyUp() {
  if (selection().length < 2) return toast("Select two or more layers to tidy up");
  dispatch({ op: "tidyUp", ids: selection(), spacing: null });
}

export const duplicatePage = (id: string) => dispatch({ op: "duplicatePage", id });

/** Moves layers to the top level of another page, which becomes current; they stay selected. */
export function moveToPage(ids: string[], page: string) {
  const r = dispatch<{ ids: string[] }>({ op: "moveToPage", ids, page });
  if (r) toast(`Moved ${r.ids.length === 1 ? "1 layer" : `${r.ids.length} layers`} to ${getDoc().pages.find((p) => p.id === page)?.name ?? "the page"}`);
}

/** Moves a page to a new place in the list (`index` is where it ends up). */
export function movePage(id: string, index: number) {
  const at = getDoc().pages.findIndex((p) => p.id === id);
  if (at < 0 || index === at || index < 0 || index >= getDoc().pages.length) return;
  dispatch({ op: "movePage", id, index });
}

/** A frame of a preset size at the viewport centre (to the right of what is there when that is taken). */
export function createFramePreset(w: number, h: number, name: string) {
  const c = viewportCenter();
  let x = Math.round(c.x - w / 2);
  let y = Math.round(c.y - h / 2);
  const doc = getDoc();
  const roots = doc.pages.find((p) => p.id === currentPage())?.children ?? [];
  const boxes = roots.length ? query<{ items: { bounds: Rect }[] }>({ q: "bounds", ids: roots }).items.map((i) => i.bounds) : [];
  if (boxes.some((b) => x < b.x + b.width && x + w > b.x && y < b.y + b.height && y + h > b.y)) {
    x = Math.round(Math.max(...boxes.map((b) => b.x + b.width)) + 100);
    y = Math.round(Math.min(...boxes.map((b) => b.y)));
  }
  oneStep(() => {
    const r = dispatch<{ id: string }>({ op: "createShape", kind: "frame", x, y, width: w, height: h, parent: null });
    if (r) dispatch({ op: "update", ids: [r.id], patch: { name } });
  });
  setTool("move");
}
