// "Select layers using this": which layers link to a style or are bound to a variable. Scans the
// document once, when asked (a click or a row opening), never per render.

import type { Doc, Node } from "../types";

export interface Usage {
  /** Layers on the page that use it, in layer order. */
  here: string[];
  /** Layers on other pages. */
  other: number;
}

const LINKS = ["fillStyle", "strokeStyle", "textStyle", "effectStyle", "gridStyle"] as const;

/** True when the layer links to the style `id` or binds the variable `id`. */
export function uses(n: Pick<Node, "bindings"> & Partial<Pick<Node, (typeof LINKS)[number]>>, id: string): boolean {
  if (LINKS.some((k) => n[k] === id)) return true;
  const b = n.bindings;
  if (!b) return false;
  for (const k in b) if (b[k] === id) return true;
  return false;
}

/** The layers of page `pageId` that use the style or variable `id`, and how many others elsewhere do. */
export function layersUsing(doc: Pick<Doc, "nodes" | "pages">, pageId: string, id: string): Usage {
  const page = doc.pages.find((p) => p.id === pageId);
  const inPage = new Set<string>();
  const order: string[] = [];
  const stack = [...(page?.children ?? [])].reverse();
  while (stack.length) {
    const nid = stack.pop()!;
    const n = doc.nodes[nid];
    if (!n || inPage.has(nid)) continue;
    inPage.add(nid);
    order.push(nid);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  let other = 0;
  for (const nid in doc.nodes) if (!inPage.has(nid) && uses(doc.nodes[nid], id)) other++;
  return { here: order.filter((nid) => uses(doc.nodes[nid], id)), other };
}

/** "Selected 12 layers (3 more on other pages)" / "No layers use Brand". */
export function usageMessage(name: string, u: Usage): string {
  const n = (k: number) => `${k} layer${k === 1 ? "" : "s"}`;
  if (!u.here.length && !u.other) return `No layers use ${name}`;
  if (!u.here.length) return `No layers on this page use ${name} (${u.other} on other pages)`;
  return `Selected ${n(u.here.length)}` + (u.other ? ` (${u.other} more on other pages)` : "");
}
