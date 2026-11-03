// Thumbnails for the Assets panel: a component rendered with the export path into a data-URL image.
// Perf rules: only rows in view render (IntersectionObserver), only while the Assets tab is mounted,
// and a cache keyed by the identity of the component's subtree nodes. `getDoc()` patches the JS copy
// from the engine's doc_delta, so a node nobody changed is the same object between revisions.

import { useCallback, useEffect, useRef, useState } from "react";
import { getDoc, useStore } from "../store";
import { nodeSvg } from "../exporter";

interface Cached {
  /** The subtree's node objects, root first. */
  nodes: object[];
  /** Variables, styles and the asset table also change how a component looks. */
  meta: [unknown, unknown];
  url: string;
}

const cache = new Map<string, Cached>();
/** Most thumbnails kept; the oldest go first. */
const LIMIT = 300;

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

/** The thumbnail URL for a component, rendering again only when its subtree changed. */
export function thumbnail(id: string): string | null {
  const nodes = subtree(id);
  if (!nodes.length) return null;
  const doc = getDoc();
  const meta: [unknown, unknown] = [doc.variables, doc.styles];
  const hit = cache.get(id);
  if (hit && same(hit.nodes, nodes) && hit.meta[0] === meta[0] && hit.meta[1] === meta[1]) return hit.url;
  let url: string;
  try {
    url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(nodeSvg(id));
  } catch {
    return null;
  }
  cache.delete(id);
  cache.set(id, { nodes, meta, url });
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value as string);
  return url;
}

/** How many thumbnails have been rendered (for the e2e check that hidden tabs and offscreen rows cost nothing). */
let renders = 0;
export function thumbRenderCount(): number {
  return renders;
}
(globalThis as any).__dtThumbs = thumbRenderCount;

/**
 * Thumbnail URL for a row. Renders when the row scrolls into view, then again (at most every
 * 400 ms) after the document changed, while the row stays in view.
 */
export function useThumb(id: string): { ref: (el: HTMLElement | null) => void; url: string | null } {
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const docRev = useStore((s) => s.es.docRev);
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
    const t = setTimeout(() => {
      const before = cache.get(id);
      const next = thumbnail(id);
      if (next !== before?.url) renders++;
      setUrl(next);
    }, url === null ? 0 : 400);
    return () => clearTimeout(t);
    // `url` is deliberately not a dependency: the first render is immediate, later ones wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, visible, docRev]);
  return { ref, url };
}
