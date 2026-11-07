import type { Doc, Interaction, Node, OverlaySettings, Rect } from "./types";

/** Figma's overlay defaults (mirrors `OverlaySettings::default` in model.rs). */
export const DEFAULT_OVERLAY: OverlaySettings = {
  position: "center",
  offsetX: 0,
  offsetY: 0,
  closeOnClickOutside: true,
  background: { color: "#000000", opacity: 0.3 },
};

/** The animation fields of an interaction. */
export type Motion = Pick<Interaction, "transition" | "durationMs" | "easing" | "direction">;

/** What a new connection animates with until the user picks something else: Figma's Instant. The duration stays for when it is switched. */
const FIRST_MOTION: Motion = { transition: "instant", durationMs: 300 };

/** The last animation chosen in the interaction editor, kept for the session like Figma does. */
let lastMotion: Motion = FIRST_MOTION;

/** Remembers the animation a user just chose, so the next new interaction starts with it. */
export function rememberMotion(patch: Partial<Interaction>) {
  const keys = ["transition", "durationMs", "easing", "direction"] as const;
  if (!keys.some((k) => k in patch)) return;
  lastMotion = { ...lastMotion, ...Object.fromEntries(keys.filter((k) => k in patch).map((k) => [k, patch[k]])) } as Motion;
}

/** Forgets the remembered animation (tests). */
export function resetMotion() {
  lastMotion = FIRST_MOTION;
}

export function newInteraction(destination: string | null): Interaction {
  return {
    trigger: "onClick",
    delayMs: 800,
    action: "navigate",
    destination,
    url: null,
    ...lastMotion,
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

/** The box an overlay of `size` takes on a frame of `frame` size: limited to the frame (a bigger
 *  overlay scrolls inside it), placed by its position, then kept inside the frame so a manual
 *  offset can't push it past an edge. `trigger` is the rect of the layer that opened it (frame
 *  coordinates), used by the manual position. */
export function overlayBox(o: OverlaySettings, frame: { width: number; height: number }, size: { width: number; height: number }, trigger: Rect): Rect {
  const width = Math.min(size.width, frame.width);
  const height = Math.min(size.height, frame.height);
  const cx = (frame.width - width) / 2;
  const cy = (frame.height - height) / 2;
  const right = frame.width - width;
  const bottom = frame.height - height;
  let x = cx;
  let y = cy;
  switch (o.position) {
    case "topLeft":
      [x, y] = [0, 0];
      break;
    case "topCenter":
      [x, y] = [cx, 0];
      break;
    case "topRight":
      [x, y] = [right, 0];
      break;
    case "bottomLeft":
      [x, y] = [0, bottom];
      break;
    case "bottomCenter":
      [x, y] = [cx, bottom];
      break;
    case "bottomRight":
      [x, y] = [right, bottom];
      break;
    case "manual":
      [x, y] = [trigger.x + o.offsetX, trigger.y + o.offsetY];
      break;
  }
  return { x: Math.min(Math.max(x, 0), right), y: Math.min(Math.max(y, 0), bottom), width, height };
}

/** Top-left of an overlay (see `overlayBox`). */
export function overlayOrigin(o: OverlaySettings, frame: { width: number; height: number }, size: { width: number; height: number }, trigger: Rect): { x: number; y: number } {
  const { x, y } = overlayBox(o, frame, size, trigger);
  return { x, y };
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
