// User-level actions shared by menus, keyboard shortcuts and context menus.

import { addAsset, imageSize, readFileAsDataUrl } from "./assets";
import { exportProjectZip } from "./exporter";
import { download, importDtron, pickFile, toDtron } from "./files";
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
import type { Rect } from "./types";

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

// ---------- Copy / paste properties (Figma ⌥⌘C / ⌥⌘V) ----------

/** Look properties pasted onto any layer. */
const LOOK_KEYS = ["opacity", "blendMode", "fills", "strokes", "strokeWeight", "strokeAlign", "strokeDash", "cornerRadius", "cornerRadii", "effects"] as const;
/** Type properties pasted onto text layers (never the characters, sizing mode or ranges). */
const TEXT_KEYS = ["fontFamily", "fontSize", "fontWeight", "italic", "lineHeight", "letterSpacing", "paragraphSpacing", "alignH", "alignV", "decoration", "case"] as const;

interface CopiedProps {
  look: Record<string, unknown>;
  text: Record<string, unknown> | null;
  fillStyle: string | null;
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
  copiedProps = { look, text, fillStyle: n.fillStyle, textStyle: n.textStyle };
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
    // A text style first, so the layer's own type values below win over the style's.
    if (p.text && p.textStyle && doc.styles.texts.some((s) => s.id === p.textStyle) && texts.length) dispatch({ op: "applyStyle", ids: texts, styleId: p.textStyle });
    dispatch({ op: "update", ids, patch: { ...p.look, ...(p.fillStyle ? {} : { fillStyle: null }) } });
    if (p.text && texts.length) dispatch({ op: "update", ids: texts, patch: { text: p.text } });
    // Editing fills detaches a colour style, so link it again afterwards.
    if (p.fillStyle && doc.styles.colors.some((s) => s.id === p.fillStyle)) dispatch({ op: "applyStyle", ids, styleId: p.fillStyle });
  });
  toast(`Pasted properties onto ${nodes.length === 1 ? nodes[0].name : `${nodes.length} layers`}`);
}

/** Page point at the centre of the visible canvas. */
export function viewportCenter(): { x: number; y: number } {
  const { w, h } = canvasSize();
  return screenToPage(w / 2, h / 2);
}

/** Parent for pasted content: the selected frame, if any. */
function pasteTarget(): string | null {
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
    dispatch({ op: "paste", data: text, parent: pasteTarget(), x: null, y: null });
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
    const id = await importDtron(await f.text(), f.name.replace(/\.(dtron|json)$/, ""));
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
