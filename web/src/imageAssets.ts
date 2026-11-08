// Images of the open file, for the Assets tab (pure: it walks the JS copy of the document).

import { readFileAsDataUrl, tryImageSize } from "./assets";
import type { Doc, ImageCredit, Node, Paint } from "./types";

export interface ImageUse {
  id: string;
  page: string;
  name: string;
}

export interface ImageEntry {
  /** The paint source: `asset:<id>` or an http(s) URL. */
  src: string;
  uses: ImageUse[];
  count: number;
  credit?: ImageCredit;
}

/** A source the file keeps itself (its bytes are in the file's assets), not a link to somewhere else. */
export const isAssetSrc = (src: string) => src.startsWith("asset:");

/** Longest side a dropped or placed image keeps; bigger ones are scaled down to it. */
export const MAX_IMAGE_SIDE = 4096;

/** The size a new image layer gets: the image's own, scaled down only above `max` px on the long side. */
export function fitNative(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (!(long > max)) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** The size an image of `width` x `height` is stored at: scaled to `max` on the long side, or null when it fits. */
export function downscaleSize(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } | null {
  if (!(Math.max(width, height) > max)) return null;
  return fitNative(width, height, max);
}

export interface PreparedImage {
  /** The data URL to store as the asset. */
  url: string;
  width: number;
  height: number;
  /** The natural size, when the image was scaled down to fit `MAX_IMAGE_SIDE`. */
  scaledFrom?: { width: number; height: number };
}

/**
 * Reads an image file for placing: its bytes as a data URL and its size. A raster image over 4096 px on
 * the long side is redrawn at 4096 (JPEG as JPEG at quality 0.92, WebP as WebP where the browser can
 * write it, anything else as PNG). GIF (animation) and SVG (vectors) are never touched, and a file that
 * fits keeps its bytes. Throws when the browser can't decode the file.
 */
export async function prepareImageFile(file: Blob): Promise<PreparedImage> {
  const url = await readFileAsDataUrl(file);
  const own = await tryImageSize(url);
  if (!own) throw new Error("not an image the browser can read");
  const small = downscaleSize(own.width, own.height);
  const type = (file.type || /^data:([^;,]+)/.exec(url)?.[1] || "").toLowerCase();
  if (!small || type === "image/gif" || type === "image/svg+xml") return { url, width: own.width, height: own.height };
  try {
    const scaled = await redraw(file, small.width, small.height, type);
    return { url: await readFileAsDataUrl(scaled), width: small.width, height: small.height, scaledFrom: own };
  } catch {
    // Couldn't redraw (no canvas, out of memory): keep the original; the layer is still capped by fitNative.
    return { url, ...fitNative(own.width, own.height) };
  }
}

async function redraw(file: Blob, width: number, height: number, type: string): Promise<Blob> {
  // The orientation is applied once, here; the canvas then holds upright pixels.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const mime = type === "image/jpeg" || type === "image/jpg" ? "image/jpeg" : type === "image/webp" ? "image/webp" : "image/png";
    let blob: Blob | null;
    if (typeof OffscreenCanvas !== "undefined") {
      const c = new OffscreenCanvas(width, height);
      c.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
      blob = await c.convertToBlob({ type: mime, quality: 0.92 });
    } else {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      c.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
      blob = await new Promise<Blob | null>((res) => c.toBlob(res, mime, 0.92));
    }
    // A browser that can't write WebP hands back PNG, and the blob's own type says so.
    if (!blob) throw new Error("no pixels");
    return blob;
  } finally {
    bitmap.close();
  }
}

/** Every image paint of the layers on a page (`pageId`) or all pages (null), one entry per source in the
 *  order they are first met, with the layers that use it. Layers inside instances are left out: they show
 *  their main component's image. */
export function imagesIn(doc: Doc, pageId: string | null): ImageEntry[] {
  const out = new Map<string, ImageEntry>();
  const add = (n: Node, page: string, paints: Paint[] | undefined) => {
    const seen = new Set<string>();
    for (const p of paints ?? []) {
      if (p.type !== "image" || !p.src || seen.has(p.src)) continue;
      seen.add(p.src);
      let e = out.get(p.src);
      if (!e) out.set(p.src, (e = { src: p.src, uses: [], count: 0 }));
      e.uses.push({ id: n.id, page, name: n.name });
      e.count++;
      if (p.credit && !e.credit) e.credit = p.credit;
    }
  };
  for (const page of doc.pages) {
    if (pageId !== null && page.id !== pageId) continue;
    const stack = [...page.children].reverse();
    while (stack.length) {
      const n = doc.nodes[stack.pop()!];
      if (!n) continue;
      add(n, page.id, n.fills);
      add(n, page.id, n.strokes);
      if (n.type === "instance") continue;
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
  }
  return [...out.values()];
}
