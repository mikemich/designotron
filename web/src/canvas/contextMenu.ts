import * as A from "../actions";
import { dispatch, getDoc, query, selection, toast, useStore, zoomToSelection } from "../store";
import { ALT, MOD, SHIFT, type MenuItem } from "../ui/controls";
import { assetDataUrl } from "../assets";
import { askClaude } from "../ai/chatState";
import { rasterize } from "../ai/images";
import type { Node, Rect } from "../types";
import { addVariant } from "../componentOps";
import { openSwapPicker } from "../panels/ComponentControls";
import { cssFor } from "../panels/RightPanel";
import { copyAsPng, copyAsSvg, copyText } from "../exporter";

/** Where the last right-click happened, so pickers opened from the menu appear there. */
let menuAt = { x: 240, y: 160 };
if (typeof window !== "undefined") window.addEventListener("contextmenu", (e) => (menuAt = { x: e.clientX, y: e.clientY }), true);

/** The image painted on a layer, as a URL the browser can load. */
function layerImage(n: Node): string | null {
  const paint = n.fills.find((f) => f.type === "image" && f.visible);
  if (!paint || paint.type !== "image") return null;
  return paint.src.startsWith("asset:") ? (assetDataUrl(paint.src.slice(6)) ?? null) : paint.src;
}

async function rebuildImage(n: Node, src: string) {
  let url: string;
  try {
    url = await rasterize(src);
  } catch {
    url = src;
  }
  askClaude(
    `The attached image is the layer ${n.id} ("${n.name}", ${Math.round(n.width)}×${Math.round(n.height)}). Recreate it as editable layers with create_nodes, at the same size, placed ${Math.round(n.width) + 80}px to the right of it (x = ${Math.round(n.x + n.width + 80)}, y = ${Math.round(n.y)} in the same parent). Use auto layout frames, real text and the closest fonts and colours. Then get_screenshot your result and fix differences. Leave the original image in place.`,
    [url],
  );
}

let internalClipboard = "";

export async function copySelection() {
  const ids = selection();
  if (!ids.length) return;
  internalClipboard = query<string>({ q: "copy", ids });
  try {
    await navigator.clipboard.writeText(internalClipboard);
  } catch {
    /* clipboard permission denied; internal copy still works */
  }
}

export async function pasteHere(x?: number, y?: number) {
  const text = await clipboardLayers();
  if (text) dispatch({ op: "paste", data: text, parent: null, x: x ?? null, y: y ?? null });
}

/**
 * Paste to replace (Figma ⇧⌘R): each selected layer is swapped for a copy of the clipboard
 * layers, which take its top-left corner, parent and place in the stack. One undo step.
 */
export async function pasteReplace() {
  const targets = selection();
  if (!targets.length) {
    toast("Select the layers to replace, then paste to replace");
    return;
  }
  const text = await clipboardLayers();
  if (!text) {
    toast("Copy some layers first, then paste to replace", "error");
    return;
  }
  const created: string[] = [];
  let skipped = 0;
  dispatch({ op: "beginGesture" });
  try {
    for (const id of targets) {
      const doc = getDoc();
      const n = doc.nodes[id];
      const box = query<{ union: Rect | null }>({ q: "bounds", ids: [id] }).union;
      if (!n || !box) continue;
      // Layers inside an instance mirror the main component: a pasted layer there would vanish on its next edit.
      if (insideInstance(n)) {
        skipped++;
        continue;
      }
      const siblings = n.parent ? doc.nodes[n.parent]?.children : doc.pages.find((p) => p.id === n.page)?.children;
      const index = siblings?.indexOf(id) ?? -1;
      const r = dispatch<{ created: string[] }>({ op: "paste", data: text, parent: n.parent, x: box.x, y: box.y });
      if (!r?.created?.length) continue;
      dispatch({ op: "moveToParent", ids: r.created, parent: n.parent, index: index >= 0 ? index : null });
      dispatch({ op: "delete", ids: [id] });
      created.push(...r.created);
    }
  } finally {
    dispatch({ op: "endGesture" });
  }
  if (skipped) toast("Can't replace layers inside an instance", "error");
  if (created.length) dispatch({ op: "select", ids: created });
}

function insideInstance(n: Node): boolean {
  const doc = getDoc();
  if (n.masterId) return true;
  for (let p = n.parent ? doc.nodes[n.parent] : null; p; p = p.parent ? doc.nodes[p.parent] : null) {
    if (p.type === "instance") return true;
  }
  return false;
}

/** The Designotron layers on the clipboard (or the last copy in this tab when it can't be read). */
async function clipboardLayers(): Promise<string> {
  try {
    // What the system clipboard holds now wins, even if it isn't layers (Copy as CSS, say).
    const t = await navigator.clipboard.readText();
    return t.includes("designotron/nodes") ? t : "";
  } catch {
    return internalClipboard;
  }
}

/** Right-click menu items for the current selection. */
export function canvasMenu(at: { x: number; y: number }): MenuItem[] {
  const doc = getDoc();
  const sel = selection();
  const nodes = sel.map((id) => doc.nodes[id]).filter(Boolean);
  const one = nodes.length === 1 ? nodes[0] : null;
  if (!nodes.length) {
    return [
      { label: "Paste here", kbd: `${MOD}V`, onClick: () => pasteHere(at.x, at.y) },
      { sep: true },
      { label: "Select all", kbd: `${MOD}A`, onClick: A.selectAll },
      { label: "Zoom to fit", kbd: `${SHIFT}1`, onClick: () => import("../store").then((s) => s.zoomToFit()) },
    ];
  }
  const items: MenuItem[] = [
    { label: "Copy", kbd: `${MOD}C`, onClick: copySelection },
    { label: "Paste here", kbd: `${MOD}V`, onClick: () => pasteHere(at.x, at.y) },
    { label: "Paste to replace", kbd: `${SHIFT}${MOD}R`, onClick: pasteReplace },
    { label: "Copy properties", kbd: `${ALT}${MOD}C`, onClick: A.copyProperties },
    { label: "Paste properties", kbd: `${ALT}${MOD}V`, onClick: A.pasteProperties },
    { heading: "Copy as" },
    { label: "Copy as PNG", disabled: !one, onClick: () => one && copyAsPng(one.id) },
    { label: "Copy as SVG", disabled: !one, onClick: () => one && copyAsSvg(one.id) },
    { label: "Copy as CSS", disabled: !one, onClick: () => one && copyText(cssFor(one), `Copied CSS for ${one.name}`, "CSS") },
    { sep: true },
    { label: "Duplicate", kbd: `${MOD}D`, onClick: A.duplicate },
    { label: "Delete", kbd: "⌫", onClick: A.deleteSelection },
    { sep: true },
    { label: "Bring to front", kbd: `${ALT}${MOD}]`, onClick: () => A.reorder("front") },
    { label: "Bring forward", kbd: `${MOD}]`, onClick: () => A.reorder("forward") },
    { label: "Send backward", kbd: `${MOD}[`, onClick: () => A.reorder("backward") },
    { label: "Send to back", kbd: `${ALT}${MOD}[`, onClick: () => A.reorder("back") },
    { sep: true },
    { label: "Group selection", kbd: `${MOD}G`, onClick: A.group },
    { label: "Frame selection", kbd: `${ALT}${MOD}G`, onClick: A.frameSelection },
  ];
  if (nodes.some((n) => ["group", "frame"].includes(n.type))) items.push({ label: "Ungroup", kbd: `${SHIFT}${MOD}G`, onClick: A.ungroup });
  items.push({ label: one?.isMask ? "Remove mask" : "Use as mask", kbd: `${ALT}${MOD}M`, onClick: A.useAsMask });
  if (nodes.length > 1) {
    items.push({ heading: "Boolean" });
    items.push({ label: "Union", onClick: () => A.booleanOp("union") });
    items.push({ label: "Subtract", onClick: () => A.booleanOp("subtract") });
    items.push({ label: "Intersect", onClick: () => A.booleanOp("intersect") });
    items.push({ label: "Exclude", onClick: () => A.booleanOp("exclude") });
  }
  if (nodes.some((n) => n.type !== "text")) items.push({ label: "Flatten", kbd: `${MOD}E`, onClick: A.flatten });
  if (nodes.some((n) => n.strokeWeight > 0 && n.strokes.some((p) => p.visible))) items.push({ label: "Outline stroke", kbd: `${SHIFT}${MOD}O`, onClick: A.outlineStroke });
  items.push({ label: "Add auto layout", kbd: `${SHIFT}A`, onClick: A.addAutoLayout });
  items.push({ sep: true });
  if (!nodes.some((n) => n.type === "component" || n.type === "instance")) items.push({ label: "Create component", kbd: `${ALT}${MOD}K`, onClick: A.createComponent });
  if (nodes.length > 1 && nodes.every((n) => n.type === "component")) items.push({ label: "Combine as variants", onClick: A.combineVariants });
  if (one && (one.type === "component" || one.type === "componentSet")) items.push({ label: "Add variant", onClick: () => addVariant(one) });
  if (nodes.every((n) => n.type === "instance")) {
    const at = menuAt;
    items.push({ label: "Swap instance…", onClick: () => openSwapPicker(sel, at.x, at.y) });
  }
  if (one?.type === "instance") {
    items.push({ label: "Go to main component", onClick: () => one.instance && dispatch({ op: "select", ids: [one.instance.componentId] }) && zoomToSelection() });
    items.push({ label: "Reset all overrides", onClick: () => dispatch({ op: "resetInstance", ids: [one.id] }) });
    items.push({ label: "Detach instance", kbd: `${ALT}${MOD}B`, onClick: A.detachInstance });
  }
  items.push({ sep: true });
  items.push({ label: "Show/Hide", kbd: `${SHIFT}${MOD}H`, onClick: () => A.toggleVisibility() });
  items.push({ label: "Lock/Unlock", kbd: `${SHIFT}${MOD}L`, onClick: () => A.toggleLock() });
  items.push({ label: "Flip horizontal", kbd: `${SHIFT}H`, onClick: () => A.flip(true) });
  items.push({ label: "Flip vertical", kbd: `${SHIFT}V`, onClick: () => A.flip(false) });
  items.push({ sep: true });
  const img = one ? layerImage(one) : null;
  if (one && img) items.push({ label: "Rebuild as editable layers with Claude", onClick: () => rebuildImage(one, img) });
  items.push({ label: "Ask Claude about this…", kbd: `${MOD}/`, onClick: () => useStore.setState({ chatOpen: true }) });
  return keepSelection(items, sel);
}

/** The menu renders inside the canvas, so pressing an item also reaches the canvas pointer
 * handler, which can clear or change the selection. Items act on the selection the menu opened with. */
function keepSelection(items: MenuItem[], sel: string[]): MenuItem[] {
  const restore = () => {
    const now = selection();
    if (now.length !== sel.length || now.some((id, i) => id !== sel[i])) dispatch({ op: "select", ids: sel });
  };
  return items.map((it) => (it.onClick ? { ...it, onClick: () => (restore(), it.onClick!()) } : it));
}
