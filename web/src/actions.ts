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
  if (text.trim().startsWith("<svg")) {
    const c = viewportCenter();
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text.trim());
    const { width, height } = await imageSize(url);
    dispatch({ op: "createImage", src: "asset:" + addAsset(url), x: c.x - width / 2, y: c.y - height / 2, width, height, name: "SVG", parent: null });
    return;
  }
  const c = viewportCenter();
  dispatch({ op: "createText", x: c.x, y: c.y, characters: text.slice(0, 5000), parent: pasteTarget() });
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
