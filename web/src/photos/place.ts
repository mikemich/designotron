// Puts a chosen photo into the document: downloads it, stores the bytes as an asset and writes
// an image paint carrying the credit. Shared by the Photos panel, the fill popover, the canvas
// drop and Claude's `place_photo`.

import { addAsset } from "../assets";
import { aiDispatch, dispatch, dispatchOrThrow, getDoc } from "../store";
import type { Node, Paint } from "../types";
import { downloadPhoto, type Downloaded } from "./download";
import { PhotoError, type PhotoResult } from "./providers";
import { photoEnv } from "./settings";

export type Fit = "fill" | "fit";

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
 *  at `x`,`y` (its centre, or its top-left with `corner`) inside the frame under that point, or on the page. */
export async function placeNewLayer(
  r: PhotoResult,
  o: { x: number; y: number; parentId?: string; width?: number; fit?: Fit; name?: string; group?: string; corner?: boolean },
): Promise<string> {
  const { paint, width: pw, height: ph } = await photoPaint(r, o.fit);
  const w = Math.max(16, Math.min(MAX_WIDTH, Math.round(o.width ?? DEFAULT_WIDTH)));
  const h = Math.max(16, Math.round((w * (ph || r.height || 1)) / (pw || r.width || 1)));
  const name = (o.name || r.title || "Photo").slice(0, 60);
  const parent = o.parentId ? getDoc().nodes[o.parentId] : undefined;
  if (o.parentId && !parent) throw new PhotoError("bad", `parentId: no layer ${o.parentId}`);
  if (o.group || o.parentId) {
    const spec = { type: "image", name, width: w, height: h, fills: [paint], ...(o.corner ? { x: o.x, y: o.y } : { x: o.x - w / 2, y: o.y - h / 2 }) };
    const made = aiDispatch("create_nodes", { ...(o.parentId ? { parentId: o.parentId } : {}), nodes: [spec] }, o.group);
    const id = made?.created?.[0]?.id;
    if (!id) throw new PhotoError("bad", "The layer couldn't be created");
    return id;
  }
  // The engine picks the frame under the point; the credit is set in the same undo step.
  dispatch({ op: "beginGesture" });
  try {
    const made = dispatchOrThrow({ op: "createImage", src: paint.src, x: o.x - w / 2, y: o.y - h / 2, width: w, height: h, name, parent: null });
    dispatchOrThrow({ op: "update", ids: [made.id], patch: { fills: [paint] } });
    return made.id as string;
  } finally {
    dispatch({ op: "endGesture" });
  }
}
