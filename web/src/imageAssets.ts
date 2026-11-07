// Images of the open file, for the Assets tab (pure: it walks the JS copy of the document).

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
