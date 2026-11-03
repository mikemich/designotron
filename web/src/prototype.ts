import type { Doc, Interaction, Node, OverlaySettings, Rect } from "./types";

/** Figma's overlay defaults (mirrors `OverlaySettings::default` in model.rs). */
export const DEFAULT_OVERLAY: OverlaySettings = {
  position: "center",
  offsetX: 0,
  offsetY: 0,
  closeOnClickOutside: true,
  background: { color: "#000000", opacity: 0.3 },
};

export function newInteraction(destination: string | null): Interaction {
  return {
    trigger: "onClick",
    delayMs: 800,
    action: "navigate",
    destination,
    url: null,
    transition: "dissolve",
    durationMs: 300,
    overlay: { ...DEFAULT_OVERLAY },
  };
}

/** Layer types that can be a prototype screen or flow start. */
export const SCREEN_TYPES = ["frame", "component"];

/** Where Present starts on a page: its flow starting point when that still exists, else the
 *  first frame, else the first component. Null when the page has neither. */
export function startFrame(doc: Doc, pageId: string | undefined): string | null {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return null;
  const top = (id: string) => (doc.nodes[id] && !doc.nodes[id].parent && doc.nodes[id].page === page.id ? doc.nodes[id] : null);
  // Older files (or a collaborator's race) may point the start at a layer that isn't a top-level
  // frame of this page; ignore those too.
  const start = page.flowStart ? top(page.flowStart) : null;
  if (page.flowStart && start && SCREEN_TYPES.includes(start.type)) return page.flowStart;
  const ofType = (t: string) => page.children.find((id) => top(id)?.type === t) ?? null;
  return ofType("frame") ?? ofType("component");
}

/** A link's destination that no longer exists (deleted frame). */
export const isMissingDestination = (doc: Doc, i: Interaction) =>
  (i.action === "navigate" || i.action === "openOverlay" || i.action === "swapOverlay") && !!i.destination && !doc.nodes[i.destination];

/** Actions that show a frame as an overlay. */
export const isOverlayLink = (i: Interaction) => i.action === "openOverlay" || i.action === "swapOverlay";

/** Top-left of an overlay of `size` on a frame of `frame` size. `trigger` is the rect of the
 *  layer that opened it (frame coordinates), used by the manual position. */
export function overlayOrigin(o: OverlaySettings, frame: { width: number; height: number }, size: { width: number; height: number }, trigger: Rect): { x: number; y: number } {
  const cx = (frame.width - size.width) / 2;
  const cy = (frame.height - size.height) / 2;
  const right = frame.width - size.width;
  const bottom = frame.height - size.height;
  switch (o.position) {
    case "topLeft":
      return { x: 0, y: 0 };
    case "topCenter":
      return { x: cx, y: 0 };
    case "topRight":
      return { x: right, y: 0 };
    case "bottomLeft":
      return { x: 0, y: bottom };
    case "bottomCenter":
      return { x: cx, y: bottom };
    case "bottomRight":
      return { x: right, y: bottom };
    case "manual":
      return { x: trigger.x + o.offsetX, y: trigger.y + o.offsetY };
    default:
      return { x: cx, y: cy };
  }
}

/** CSS colour for the dimmed background, or transparent. */
export function overlayDim(o: OverlaySettings): string {
  const b = o.background;
  if (!b) return "transparent";
  const hex = b.color.replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex.slice(0, 6);
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return "transparent";
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, b.opacity))})`;
}

/** Component sets a layer can Change to variants of, nearest first: the set of the variant it is
 *  in, or of the instance it is in (or is). */
export function enclosingSets(doc: Doc, id: string): Node[] {
  const out: Node[] = [];
  for (let n: Node | undefined = doc.nodes[id]; n; n = n.parent ? doc.nodes[n.parent] : undefined) {
    const comp = n.type === "component" ? n : n.instance ? doc.nodes[n.instance.componentId] : undefined;
    const set = comp?.parent ? doc.nodes[comp.parent] : undefined;
    if (set?.type === "componentSet" && !out.includes(set)) out.push(set);
  }
  return out;
}

/** Layers inside the same top-level frame as `id`, with their name paths, for Scroll to. */
export function scrollTargets(doc: Doc, id: string, max = 400): { id: string; label: string }[] {
  let top = doc.nodes[id];
  while (top?.parent && doc.nodes[top.parent]) top = doc.nodes[top.parent];
  const out: { id: string; label: string }[] = [];
  const walk = (n: Node, path: string[]) => {
    for (const cid of n.children) {
      const c = doc.nodes[cid];
      if (!c || out.length >= max) continue;
      if (c.id !== id) out.push({ id: c.id, label: [...path, c.name].join(" / ") });
      walk(c, [...path, c.name]);
    }
  };
  if (top) walk(top, []);
  return out;
}

export const TRIGGER_LABELS: Record<Interaction["trigger"], string> = {
  onClick: "On click",
  onHover: "While hovering",
  onPress: "While pressing",
  afterDelay: "After delay",
  mouseEnter: "Mouse enter",
  mouseLeave: "Mouse leave",
  mouseDown: "Mouse down",
  mouseUp: "Mouse up",
  key: "Key",
};
