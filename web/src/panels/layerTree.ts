import { create } from "zustand";
import type { Doc, Node } from "../types";

/** Range select in the Layers panel (owner decision): the visible rows between the anchor and the
 * target, inclusive, top-most only. A frame in the range stands for its expanded children, as engine
 * operations treat a selection. A missing anchor gives just the target. */
export function rangeIds(rows: { n: { id: string; parent: string | null } }[], anchorId: string | null | undefined, toId: string): string[] {
  const to = rows.findIndex((r) => r.n.id === toId);
  if (to < 0) return [];
  const from = anchorId ? rows.findIndex((r) => r.n.id === anchorId) : -1;
  if (from < 0) return [toId];
  const [lo, hi] = from < to ? [from, to] : [to, from];
  const inRange = new Set<string>();
  for (let i = lo; i <= hi; i++) inRange.add(rows[i].n.id);
  const parent = new Map(rows.map((r) => [r.n.id, r.n.parent]));
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) {
    let covered = false;
    for (let p = parent.get(rows[i].n.id) ?? null; p; p = parent.get(p) ?? null) {
      if (inRange.has(p)) {
        covered = true;
        break;
      }
    }
    if (!covered) out.push(rows[i].n.id);
  }
  return out;
}

/** Every layer below `id` that has children (not `id` itself), parents before children. Iterative,
 * so a deep tree can't overflow the stack. */
export function descendantContainers(doc: Doc, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const stack = [...(doc.nodes[id]?.children ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const n = doc.nodes[cur];
    if (!n?.children.length) continue;
    out.push(cur);
    stack.push(...n.children);
  }
  return out;
}

/** Which rows of the tree are open. Module-level so a shortcut can collapse everything. */
export const useLayerTree = create<{ expanded: Set<string> }>(() => ({ expanded: new Set() }));

export function setLayerExpanded(update: (prev: Set<string>) => Set<string>) {
  useLayerTree.setState((s) => {
    const next = update(s.expanded);
    return next === s.expanded ? s : { expanded: next };
  });
}

/** Alt+L: collapse every row. */
export function collapseAllLayers() {
  setLayerExpanded((prev) => (prev.size ? new Set() : prev));
}

export const LAYER_FILTERS = ["frames", "groups", "components", "instances", "text", "images", "shapes", "vectors", "hidden", "locked"] as const;
export type LayerFilter = (typeof LAYER_FILTERS)[number];
const STATE_FILTERS = new Set<LayerFilter>(["hidden", "locked"]);

export const LAYER_FILTER_LABELS: Record<LayerFilter, string> = {
  frames: "Frames",
  groups: "Groups",
  components: "Components",
  instances: "Instances",
  text: "Text",
  images: "Images",
  shapes: "Shapes",
  vectors: "Vectors",
  hidden: "Hidden",
  locked: "Locked",
};

/** The type filter a layer belongs to. */
export function filterKind(n: Node): LayerFilter {
  switch (n.type) {
    case "frame":
      return "frames";
    case "group":
      return "groups";
    case "component":
    case "componentSet":
      return "components";
    case "instance":
      return "instances";
    case "text":
      return "text";
    case "vector":
      return "vectors";
    case "rectangle":
      return n.fills.some((f) => f.type === "image") ? "images" : "shapes";
    default:
      return "shapes";
  }
}

export type LayerHit = { id: string; path: string[] };
export type LayerSearch = { hits: LayerHit[]; total: number };

/** Layers of one page matching a query and filters, in panel order (top layer first, depth first),
 * including layers inside instances. Names match case-insensitively as substrings, text layers also by
 * their content. Type filters combine with "or", Hidden and Locked with "or" among themselves, and
 * the two groups with "and". */
export function searchLayers(doc: Doc, pageId: string, query: string, filters: ReadonlySet<LayerFilter>, limit: number): LayerSearch {
  const q = query.trim().toLowerCase();
  const types = [...filters].filter((f) => !STATE_FILTERS.has(f));
  const states = [...filters].filter((f) => STATE_FILTERS.has(f));
  const hits: LayerHit[] = [];
  let total = 0;
  const stack: { id: string; path: string[] }[] = [];
  const top = doc.pages.find((p) => p.id === pageId)?.children ?? [];
  for (let i = 0; i < top.length; i++) stack.push({ id: top[i], path: [] });
  while (stack.length) {
    const { id, path } = stack.pop()!;
    const n = doc.nodes[id];
    if (!n) continue;
    const name = n.name || n.type;
    if (
      (!q || name.toLowerCase().includes(q) || (n.type === "text" && !!n.text?.characters && n.text.characters.toLowerCase().includes(q))) &&
      (!types.length || types.includes(filterKind(n))) &&
      (!states.length || (states.includes("hidden") && !n.visible) || (states.includes("locked") && n.locked))
    ) {
      total++;
      if (hits.length < limit) hits.push({ id, path });
    }
    // Pushed in paint order so the top layer pops first.
    if (n.children.length) {
      const sub = [...path, name];
      for (let i = 0; i < n.children.length; i++) stack.push({ id: n.children[i], path: sub });
    }
  }
  return { hits, total };
}
