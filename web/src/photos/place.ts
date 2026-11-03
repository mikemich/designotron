// Puts a chosen photo into the document: downloads it, stores the bytes as an asset and writes
// an image paint carrying the credit. Shared by the Photos panel, the fill popover, the canvas
// drop and Claude's `place_photo`.

import { addAsset } from "../assets";
import { aiDispatch, dispatchOrThrow, getDoc, useStore } from "../store";
import type { Doc, Node, Paint } from "../types";
import { downloadPhoto, type Downloaded } from "./download";
import { PhotoError, type PhotoResult } from "./providers";
import { photoEnv } from "./settings";

/** How the photo sits in its layer (a paint keeps its mode when its image is replaced). */
export type Fit = "fill" | "fit" | "stretch" | "tile";

export interface PlacedPaint {
  paint: Extract<Paint, { type: "image" }>;
  width: number;
  height: number;
}

const DEFAULT_WIDTH = 400;
const MAX_WIDTH = 1600;

/** Layers a photo can fill: shapes and frames (not text, groups or lines). */
export function fillable(n: Node | undefined): boolean {
  return !!n && ["frame", "rectangle", "ellipse", "polygon", "star", "vector", "component", "instance"].includes(n.type);
}

/** Downloads the photo, stores its bytes as an asset and returns the paint (with the credit). */
export async function photoPaint(r: PhotoResult, fit: Fit = "fill"): Promise<PlacedPaint> {
  const dl: Downloaded = await downloadPhoto({ fetch: photoEnv().fetch }, r);
  const id = addAsset(dl.dataUrl);
  return { paint: { type: "image", src: "asset:" + id, scaleMode: fit, opacity: 1, visible: true, credit: r.credit }, width: dl.width, height: dl.height };
}

/** Fills each layer in `ids` with the photo (one undo step). The layers are checked again after
 *  the download, so one deleted meanwhile is skipped; none left is an error. */
export async function fillLayers(r: PhotoResult, ids: string[], opts: { fit?: Fit; group?: string } = {}): Promise<string[]> {
  const { paint } = await photoPaint(r, opts.fit);
  const doc = getDoc();
  const targets = ids.filter((id) => fillable(doc.nodes[id]));
  if (!targets.length) throw new PhotoError("bad", "The layer is gone or can't hold a photo");
  if (opts.group) aiDispatch("update_nodes", { updates: targets.map((id) => ({ id, fills: [paint] })) }, opts.group);
  else dispatchOrThrow({ op: "update", ids: targets, patch: { fills: [paint] } });
  return targets;
}

/** A new image layer. With `parentId` it goes into that layer (appended in auto layout); without,
 *  it is centred on `x`,`y` (its top-left with `corner`) inside the frame under that point, or on
 *  the page. One undo step; the width is capped to the target frame's inner width. */
export async function placeNewLayer(
  r: PhotoResult,
  o: { x: number; y: number; parentId?: string; width?: number; fit?: Fit; name?: string; group?: string; corner?: boolean },
): Promise<string> {
  const { paint, width: pw, height: ph } = await photoPaint(r, o.fit);
  // The document may have changed during the download: look at it now.
  const doc = getDoc();
  if (o.parentId && !doc.nodes[o.parentId]) throw new PhotoError("bad", `parentId: no layer ${o.parentId}`);
  const target = o.parentId ? { id: o.parentId, ...pagePosition(doc, o.parentId) } : o.corner ? null : frameAt(doc, o.x, o.y);
  const parent = target ? doc.nodes[target.id] : undefined;
  let w = Math.max(16, Math.min(MAX_WIDTH, Math.round(o.width ?? DEFAULT_WIDTH)));
  if (parent) {
    const pad = parent.layout ? parent.layout.paddingLeft + parent.layout.paddingRight : 0;
    w = Math.max(16, Math.min(w, Math.floor(parent.width - pad)));
  }
  const h = Math.max(16, Math.round((w * (ph || r.height || 1)) / (pw || r.width || 1)));
  const left = o.corner ? o.x : o.x - w / 2;
  const top = o.corner ? o.y : o.y - h / 2;
  const spec = { type: "image", name: (o.name || "Photo").slice(0, 60), width: w, height: h, fills: [paint], x: left - (target?.x ?? 0), y: top - (target?.y ?? 0) };
  // With an explicit parent and position, x and y are the caller's own (relative) numbers.
  if (o.parentId && o.corner) Object.assign(spec, { x: o.x, y: o.y });
  const made = aiDispatch("create_nodes", { ...(target ? { parentId: target.id } : {}), nodes: [spec] }, o.group);
  const id = made?.created?.[0]?.id;
  if (!id) throw new PhotoError("bad", "The layer couldn't be created");
  if (!o.group) dispatchOrThrow({ op: "select", ids: [id] });
  return id;
}

/** The deepest unlocked, visible frame under a page point on the current page (not a main
 *  component or instance); null when there is none. Rotated layers are skipped. */
export function frameAt(doc: Doc, px: number, py: number): { id: string; x: number; y: number } | null {
  const page = doc.pages.find((p) => p.id === useStore.getState().es.page);
  let found: { id: string; x: number; y: number } | null = null;
  const visit = (ids: string[], ox: number, oy: number) => {
    for (const id of [...ids].reverse()) {
      const n = doc.nodes[id];
      if (!n || n.locked || !n.visible || n.rotation) continue;
      const x = ox + n.x;
      const y = oy + n.y;
      if (px < x || py < y || px > x + n.width || py > y + n.height) continue;
      if (n.type === "frame") found = { id, x, y };
      else if (n.type !== "group") continue;
      visit(n.children, x, y);
      return;
    }
  };
  visit(page?.children ?? [], 0, 0);
  return found;
}

/** Page position of a layer's top-left corner (rotations ignored). */
function pagePosition(doc: Doc, id: string): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let n: Node | undefined = doc.nodes[id];
  while (n) {
    x += n.x;
    y += n.y;
    n = n.parent ? doc.nodes[n.parent] : undefined;
  }
  return { x, y };
}
