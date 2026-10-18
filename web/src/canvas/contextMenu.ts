import * as A from "../actions";
import { dispatch, getDoc, query, selection, useStore, zoomToSelection } from "../store";
import { ALT, MOD, SHIFT, type MenuItem } from "../ui/controls";
import { assetDataUrl } from "../assets";
import { askClaude } from "../ai/chatState";
import { rasterize } from "../ai/images";
import type { Node } from "../types";

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
  let text = internalClipboard;
  try {
    const t = await navigator.clipboard.readText();
    if (t.includes("designotron/nodes")) text = t;
  } catch {
    /* fall back to the internal clipboard */
  }
  if (text) dispatch({ op: "paste", data: text, parent: null, x: x ?? null, y: y ?? null });
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
  items.push({ label: "Add auto layout", kbd: `${SHIFT}A`, onClick: A.addAutoLayout });
  items.push({ sep: true });
  if (!nodes.some((n) => n.type === "component" || n.type === "instance")) items.push({ label: "Create component", kbd: `${ALT}${MOD}K`, onClick: A.createComponent });
  if (nodes.length > 1 && nodes.every((n) => n.type === "component")) items.push({ label: "Combine as variants", onClick: A.combineVariants });
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
  return items;
}
