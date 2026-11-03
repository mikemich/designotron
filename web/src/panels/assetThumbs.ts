// Thumbnails for the Assets panel: a component rendered with the export path, then rasterised to a
// small PNG. Perf rules: only rows in view render (IntersectionObserver), only while the Assets tab is
// mounted, and a cache keyed by what the component looks like: the identity of its subtree's node
// objects (`getDoc()` patches the JS copy from the engine's doc_delta, so an unchanged node is the same
// object between revisions) plus the *content* of the styles and variables (the engine re-sends those
// on every change, so their identity says nothing). The cache holds PNGs, capped in bytes.

import { useCallback, useEffect, useRef, useState } from "react";
import { getDoc, useStore } from "../store";
import { nodeSvg } from "../exporter";
import type { Doc } from "../types";

interface Cached {
  /** The subtree's node objects, root first. */
  nodes: object[];
  /** Styles and variables as text: they also change how a component looks. */
  meta: string;
  url: string;
}

/** Side of the longer edge of a thumbnail raster; rows show them at 32 px (20 px in a set strip). */
const SIZE = 64;
/** Most bytes of thumbnail data kept; the oldest go first. */
const CACHE_BYTES = 8 * 1024 * 1024;

const cache = new Map<string, Cached>();
let cacheBytes = 0;
const inFlight = new Map<string, Promise<string | null>>();

function subtree(id: string): object[] {
  const doc = getDoc();
  const out: object[] = [];
  const stack = [id];
  while (stack.length) {
    const n = doc.nodes[stack.pop()!];
    if (!n) continue;
    out.push(n);
    for (const c of n.children) stack.push(c);
  }
  return out;
}

function same(a: object[], b: object[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const metaKeys = new WeakMap<Doc, string>();
/** Styles and variables as text, serialised once per document object (not once per row). */
function metaKey(doc: Doc): string {
  let k = metaKeys.get(doc);
  if (k === undefined) {
    k = JSON.stringify([doc.styles, doc.variables]);
    metaKeys.set(doc, k);
  }
  return k;
}

function store(id: string, entry: Cached) {
  const old = cache.get(id);
  if (old) cacheBytes -= old.url.length;
  cache.delete(id);
  cache.set(id, entry);
  cacheBytes += entry.url.length;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_BYTES || k === id) break;
    cache.delete(k);
    cacheBytes -= v.url.length;
  }
}

/** Draws an SVG into a PNG data URL no larger than SIZE px on its longer edge. */
function rasterise(svg: string): Promise<string | null> {
  return new Promise((resolve) => {
    // A blob URL, not a data URL: no percent-encoded copy of a possibly megabytes-long SVG (inlined images).
    const blobUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    const done = (url: string | null) => {
      URL.revokeObjectURL(blobUrl);
      resolve(url);
    };
    img.onload = () => {
      try {
        const w = img.naturalWidth || SIZE;
        const h = img.naturalHeight || SIZE;
        const k = SIZE / Math.max(w, h);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        done(c.toDataURL("image/png"));
      } catch {
        done(null);
      }
    };
    img.onerror = () => done(null);
    img.src = blobUrl;
  });
}

/** How many thumbnails have been rendered (cache misses), for the e2e check that hits cost nothing. */
let renders = 0;
export function thumbRenderCount(): number {
  return renders;
}
(globalThis as any).__dtThumbs = thumbRenderCount;

/** The thumbnail PNG for a component; renders again only when what it looks like changed. */
export async function thumbnail(id: string): Promise<string | null> {
  const nodes = subtree(id);
  if (!nodes.length) return null;
  const meta = metaKey(getDoc());
  const hit = cache.get(id);
  if (hit && hit.meta === meta && same(hit.nodes, nodes)) return hit.url;
  const running = inFlight.get(id);
  if (running) return running;
  renders++;
  const job = (async () => {
    let svg: string;
    try {
      svg = nodeSvg(id);
    } catch {
      return null;
    }
    const url = await rasterise(svg);
    if (url) store(id, { nodes, meta, url });
    return url;
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, job);
  return job;
}

/**
 * Thumbnail URL for a row. Looks when the row scrolls into view, then again (at most every
 * 400 ms) after the document changed, while the row stays in view; a change that left the
 * component alone is a cache hit.
 */
export function useThumb(id: string): { ref: (el: HTMLElement | null) => void; url: string | null } {
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const docRev = useStore((s) => s.es.docRev);
  const first = useRef(true);
  const observer = useRef<IntersectionObserver | null>(null);
  // Stable: a new callback each render would be called again (null, then the element) every time.
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return setVisible(true);
    observer.current = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: "100px" });
    observer.current.observe(el);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    const t = setTimeout(
      () => {
        thumbnail(id).then((u) => live && setUrl(u));
      },
      first.current ? 0 : 400,
    );
    first.current = false;
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [id, visible, docRev]);
  return { ref, url };
}
