// Prototype player engine: scene building (scrolling frames, fixed layers), interactive
// components (a private engine that holds the variant state), motion tables and key names.

import { inlineAssets } from "./assets";
import { getDoc, getEngine, toast } from "./store";
import type { WasmEngine } from "./wasm/pkg/designotron_engine_wasm";
import type { Direction, Doc, Easing, Interaction, Node, Overflow, Rect } from "./types";

// ---------- the player's engine ----------

interface PlayerEngine {
  engine: WasmEngine;
  doc: Doc | null;
  rev: number;
}

/** Created on the first Change to, as a fork of the editor's engine (never `newEngine`, which
 *  would replace the editor's). Holds the variants the viewer has switched. */
let pe: PlayerEngine | null = null;
/** Moves on every change the player makes to its own engine; scenes are cached per value. */
let changes = 0;

export const playerRevision = () => changes;

/** Query through the player's engine when it exists, else the editor's. */
export function pq<T = any>(q: Record<string, unknown>): T {
  return JSON.parse((pe?.engine ?? getEngine()).query(JSON.stringify(q)));
}

/** The document the player shows: the player engine's once Change to has run. */
export function pdoc(): Doc {
  if (!pe) return getDoc();
  const rev = pe.engine.rev();
  if (pe.doc && pe.rev === rev) return pe.doc;
  const d = JSON.parse(pe.engine.docDelta(!pe.doc));
  if (d.full || !pe.doc) pe.doc = d.full;
  else if (!d.same) {
    const nodes = pe.doc.nodes;
    Object.assign(nodes, d.nodes);
    for (const id of d.removed) delete nodes[id];
    pe.doc = { ...d.meta, nodes };
  }
  pe.rev = rev;
  return pe.doc!;
}

function ensurePlayerEngine(): PlayerEngine {
  if (!pe) {
    // A copy of the editor's document made without serialising it, and the editor's own document
    // object (shallow-copied) as the starting point, so nothing is parsed or measured again.
    const engine = getEngine().fork();
    const d = getDoc();
    pe = { engine, doc: { ...d, nodes: { ...d.nodes } }, rev: engine.rev() };
  }
  return pe;
}

/** Throws the player's engine away (the presenter closed). */
export function closePlayer() {
  pe?.engine.free();
  pe = null;
  changes++;
}

/** Points an instance at another variant of its set, keeping its overrides. */
export function swapVariant(instance: string, component: string): boolean {
  try {
    ensurePlayerEngine().engine.dispatch(JSON.stringify({ op: "swapComponent", id: instance, componentId: component }));
    changes++;
    return true;
  } catch (err) {
    toast(String(err), "error");
    return false;
  }
}

/** The instance a Change to on `layer` switches: the nearest enclosing instance (or the layer
 *  itself) whose component set contains `variant`. */
export function changeTarget(layer: string, variant: string): string | null {
  const doc = pdoc();
  const set = doc.nodes[variant]?.parent;
  if (!set) return null;
  for (let id: string | null = layer; id; id = doc.nodes[id]?.parent ?? null) {
    const comp = doc.nodes[id]?.instance?.componentId;
    if (comp && doc.nodes[comp]?.parent === set) return id;
  }
  return null;
}

// ---------- interactions ----------

const sameTrigger = (a: Interaction, b: Interaction) => a.trigger === b.trigger && (a.trigger !== "key" || a.key === b.key);

/** What a layer does: its own interactions, and for an instance also its variant's Change to
 *  interactions (instances don't inherit the root's interactions) whose trigger it doesn't
 *  already use: a regular interaction on the instance with the same trigger wins. */
export function effectiveInteractions(doc: Doc, n: Node): Interaction[] {
  const comp = n.instance?.componentId;
  const main = comp ? doc.nodes[comp] : null;
  if (!main) return n.interactions;
  const extra = main.interactions.filter((i) => i.action === "changeTo" && !n.interactions.some((o) => sameTrigger(o, i)));
  return extra.length ? [...n.interactions, ...extra] : n.interactions;
}

/** Interactions that need a hotspot (the pointer ones). */
export const isPointerTrigger = (i: Interaction) => i.trigger !== "afterDelay" && i.trigger !== "key";

/** "Shift+K": modifiers ordered Ctrl, Alt, Shift, Meta, then the key (mirrors `normalize_key`
 *  in ai.rs). With a modifier held the key comes from the physical key (`code`), because the
 *  browser reports "Shift+1" as "!" and Alt+A on a Mac as "å". Null for a bare modifier, a held
 *  key repeating, or text being composed. */
export function keyName(e: { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; repeat?: boolean; isComposing?: boolean }): string | null {
  if (e.repeat || e.isComposing) return null;
  if (["Control", "Alt", "Shift", "Meta", "Dead", "Unidentified", "Process"].includes(e.key)) return null;
  const mod = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
  // A letter or digit the layout already gives wins (AZERTY); otherwise the physical key.
  const physical = mod && !/^[\p{L}\p{N}]$/u.test(e.key) ? /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code ?? "") : null;
  const k = physical ? (physical[1] ?? physical[2]) : e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", k].filter(Boolean).join("+");
}

// ---------- motion ----------

export const EASING_CSS: Record<Easing, string> = {
  linear: "linear",
  easeIn: "ease-in",
  easeOut: "ease-out",
  easeInOut: "ease-in-out",
  easeInBack: "cubic-bezier(0.36, 0, 0.66, -0.56)",
  easeOutBack: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  easeInOutBack: "cubic-bezier(0.68, -0.6, 0.32, 1.6)",
};

export type MotionKind = "instant" | "dissolve" | "smart" | "slide" | "moveIn" | "moveOut" | "push";

/** How a screen change plays: `dir` is the direction things move. */
export interface Motion {
  kind: MotionKind;
  dir: Direction;
  ms: number;
  /** CSS timing function. */
  easing: string;
}

export const INSTANT: Motion = { kind: "instant", dir: "left", ms: 0, easing: "linear" };

const SLIDES: Record<string, Direction> = { slideLeft: "left", slideRight: "right", slideUp: "up", slideDown: "down" };

/** The motion an interaction asks for (old files: 300 ms ease-out; Slide is Move in). */
export function motionOf(it: Interaction): Motion {
  const ms = it.durationMs > 0 ? it.durationMs : 300;
  const easing = EASING_CSS[it.easing ?? "easeOut"] ?? "ease-out";
  const dir = it.direction ?? "left";
  switch (it.transition) {
    case "instant":
      return INSTANT;
    case "smartAnimate":
      return { kind: "smart", dir, ms, easing };
    case "moveIn":
    case "moveOut":
    case "push":
      return { kind: it.transition, dir, ms, easing };
    case "slideLeft":
    case "slideRight":
    case "slideUp":
    case "slideDown":
      // The classic Slide: only the new screen moves, over nothing.
      return { kind: "slide", dir: SLIDES[it.transition], ms, easing };
    default:
      return { kind: "dissolve", dir, ms, easing };
  }
}

/** The slide the next/previous frame buttons and arrow keys play. */
export const slide = (dir: Direction): Motion => ({ kind: "slide", dir, ms: 300, easing: EASING_CSS.easeOut });

export const OPPOSITE: Record<Direction, Direction> = { left: "right", right: "left", up: "down", down: "up" };

/** Back plays the reverse of the transition that led to the screen. */
export function reverseMotion(m: Motion): Motion {
  switch (m.kind) {
    case "slide":
      return { ...m, dir: OPPOSITE[m.dir] };
    case "moveIn":
      return { ...m, kind: "moveOut", dir: OPPOSITE[m.dir] };
    case "moveOut":
      return { ...m, kind: "moveIn", dir: OPPOSITE[m.dir] };
    case "push":
      return { ...m, dir: OPPOSITE[m.dir] };
    default:
      return m;
  }
}

/** CSS `animation` for one of the two screens of a change (`entering` is the new one). */
export function motionAnimation(m: Motion, entering: boolean): string | undefined {
  const t = `${m.ms}ms ${m.easing} both`;
  switch (m.kind) {
    case "dissolve":
    case "smart":
      return entering ? `dt-dissolve ${t}` : undefined;
    case "slide":
    case "moveIn":
      return entering ? `dt-in-${m.dir} ${t}` : undefined;
    case "moveOut":
      return entering ? undefined : `dt-out-${m.dir} ${t}`;
    case "push":
      return `dt-${entering ? "in" : "out"}-${m.dir} ${t}`;
    default:
      return undefined;
  }
}

/** Whether the screen that is leaving stays on screen during the change. */
export const keepsOldScreen = (m: Motion) => m.kind === "moveIn" || m.kind === "moveOut" || m.kind === "push";

// ---------- scenes ----------

export interface Hotspot {
  id: string;
  /** Frame coordinates (the top-left of the screen is 0,0). */
  rect: Rect;
  interactions: Interaction[];
  /** This hotspot's layer, then its ancestors that have hotspots, innermost first. */
  chain: string[];
}

export interface Keyed {
  id: string;
  it: Interaction;
}

export interface ScrollerScene {
  id: string;
  /** The scrolling box, frame coordinates. */
  rect: Rect;
  overflow: Overflow;
  /** CSS corner radius of the box (the frame's own). */
  radius: string;
  /** The children's picture; `x`/`y` are frame coordinates. */
  content: { svg: string; x: number; y: number; width: number; height: number };
  hotspots: Hotspot[];
  scrollers: ScrollerScene[];
  /** Layers painted after this scroller, drawn over it (in the container that holds it). */
  above: AboveScene | null;
  /** This scroller's own layer, then the hotspot owners above it (for a click on its empty area). */
  chain: string[];
}

/** Layers painted after a scroller (and before the next one), drawn over it. Each is its own
 *  picture, like a fixed layer, so the layers around it stay where they are. */
export interface AboveScene {
  /** Pictures in frame coordinates. */
  pieces: { svg: string; x: number; y: number; width: number; height: number }[];
  hotspots: Hotspot[];
}

export interface FixedScene {
  id: string;
  svg: string;
  rect: Rect;
  hotspots: Hotspot[];
}

export interface Scene {
  id: string;
  width: number;
  height: number;
  base: string;
  hotspots: Hotspot[];
  scrollers: ScrollerScene[];
  fixed: FixedScene[];
  keyed: Keyed[];
  /** Every scroller of the screen, by layer id. */
  byId: Map<string, ScrollerScene>;
  /** Hotspots of every container by owner, for lookups. */
  all: Map<string, Hotspot>;
}

interface Info {
  id: string;
  parent: string | null;
  rect: Rect;
  overflow: Overflow;
}

const FRAME_LIKE = ["frame", "component", "instance"];
/** Whether `id` is `ancestor` or inside it. */
const isInside = (doc: Doc, id: string, ancestor: string) => {
  for (let x: string | null = id; x; x = doc.nodes[x]?.parent ?? null) if (x === ancestor) return true;
  return false;
};

const radiusOf = (n: Node) => (n.cornerRadii ? n.cornerRadii.map((r) => `${r}px`).join(" ") : n.cornerRadius ? `${n.cornerRadius}px` : "0");

/** Whether the children of `n` extend past its box in a direction it scrolls. */
function overflows(doc: Doc, n: Node, rect: Rect): boolean {
  if (!n.overflow || n.overflow === "none" || !FRAME_LIKE.includes(n.type)) return false;
  const kids = n.children.filter((c) => doc.nodes[c]?.visible !== false);
  if (!kids.length) return false;
  const u = pq<{ union: Rect | null }>({ q: "bounds", ids: kids }).union;
  if (!u) return false;
  const h = n.overflow === "horizontal" || n.overflow === "both";
  const v = n.overflow === "vertical" || n.overflow === "both";
  return (h && u.x + u.width > rect.x + rect.width + 0.5) || (v && u.y + u.height > rect.y + rect.height + 0.5);
}

/** Everything the presenter draws for one screen. A scrolling frame (the screen itself or any
 *  frame inside it whose content is bigger than its box on an allowed axis) becomes a scroller:
 *  its children are drawn once, as a separate picture the presenter scrolls. Layers marked
 *  Fixed in a scrolling screen are drawn on top of it. Hotspots belong to the innermost
 *  scroller (or fixed layer) holding their layer, so they scroll with the content. */
export function buildScene(frameId: string): Scene {
  const doc = pdoc();
  const frame = doc.nodes[frameId];
  const fb = pq<{ union: Rect }>({ q: "bounds", ids: [frameId] }).union;
  const rel = (r: Rect): Rect => ({ x: r.x - fb.x, y: r.y - fb.y, width: r.width, height: r.height });
  const svgOf = (id: string, hide: string[]) => inlineAssets(pq<string>({ q: "exportSvg", id, hide }));

  // 1. Scrollers (outermost first) and fixed layers.
  const infos: Info[] = [];
  const fixedIds: string[] = [];
  const top = overflows(doc, frame, fb);
  if (top) infos.push({ id: frameId, parent: null, rect: fb, overflow: frame.overflow ?? "none" });
  const walk = (id: string, scroller: string | null) => {
    for (const cid of doc.nodes[id].children) {
      const c = doc.nodes[cid];
      if (!c || !c.visible) continue;
      if (top && id === frameId && c.scrollBehavior === "fixed" && (!frame.layout || c.absolutePosition)) {
        fixedIds.push(cid);
        continue;
      }
      let next = scroller;
      if (c.overflow && c.overflow !== "none") {
        const rect = pq<{ items: { bounds: Rect }[] }>({ q: "bounds", ids: [cid] }).items[0]?.bounds;
        if (rect && overflows(doc, c, rect)) {
          infos.push({ id: cid, parent: scroller, rect, overflow: c.overflow });
          next = cid;
        }
      }
      walk(cid, next);
    }
  };
  walk(frameId, top ? frameId : null);
  const infoOf = new Map(infos.map((i) => [i.id, i]));

  // 2. Which hotspot belongs where, and the pointer and key interactions of the screen.
  const owners: { id: string; its: Interaction[] }[] = [];
  const keyed: Keyed[] = [];
  const fixedSet = new Set(fixedIds);
  // Layers painted after a scroller are drawn over it, each as a picture of its own (so the
  // ancestors between it and the container lose their clipping and opacity there). Every such
  // layer goes over the last scroller that comes before it, so a badge between two carousels is
  // above the first and under the second.
  const order = new Map<string, number>();
  const number = (id: string) => {
    order.set(id, order.size);
    for (const c of doc.nodes[id]?.children ?? []) number(c);
  };
  number(frameId);
  const aboveRoots = new Map<string, string[]>(); // scroller id → layers drawn over it
  const rootsIn = new Map<string, string[]>(); // container ("" = screen) → all of them
  for (const c of new Set(infos.filter((i) => i.id !== frameId).map((i) => i.parent ?? ""))) {
    const node = c || frameId;
    const mine = infos.filter((i) => i.id !== frameId && (i.parent ?? "") === c);
    const all: string[] = [];
    for (const sc of mine) {
      for (let x: string | null = sc.id; x && x !== node; x = doc.nodes[x].parent) {
        const sibs = doc.nodes[doc.nodes[x].parent!].children;
        for (const sib of sibs.slice(sibs.indexOf(x) + 1)) {
          if (doc.nodes[sib]?.visible === false || fixedSet.has(sib) || infoOf.has(sib) || all.includes(sib)) continue;
          all.push(sib);
          let owner: string | null = null;
          for (const o of mine) if ((order.get(o.id) ?? 0) < (order.get(sib) ?? 0) && !isInside(doc, o.id, sib)) owner = o.id;
          if (owner) aboveRoots.set(owner, [...(aboveRoots.get(owner) ?? []), sib]);
        }
      }
    }
    rootsIn.set(c, all.filter((r) => [...aboveRoots.values()].some((l) => l.includes(r))));
  }
  const rootOwner = new Map<string, string>();
  for (const [o, list] of aboveRoots) for (const r of list) rootOwner.set(r, o);
  const visit = (id: string) => {
    const n = doc.nodes[id];
    if (!n) return;
    const its = effectiveInteractions(doc, n);
    for (const it of its) if (it.trigger === "key" && it.key) keyed.push({ id, it });
    if (its.some(isPointerTrigger)) owners.push({ id, its });
    for (const c of n.children) if (doc.nodes[c]?.visible !== false) visit(c);
  };
  visit(frameId);
  const bounds = owners.length ? pq<{ items: { id: string; bounds: Rect }[] }>({ q: "bounds", ids: owners.map((o) => o.id) }).items : [];
  const withHotspot = new Set(bounds.map((b) => b.id));
  const itsOf = new Map(owners.map((o) => [o.id, o.its]));
  const lineage = (id: string) => {
    const out = [id];
    for (let p = doc.nodes[id]?.parent; p && out[out.length - 1] !== frameId; p = doc.nodes[p]?.parent ?? null) out.push(p);
    return out;
  };
  const sorted = bounds
    .map((b) => {
      const line = lineage(b.id);
      return { h: { id: b.id, rect: rel(b.bounds), interactions: itsOf.get(b.id)!, chain: line.filter((l) => withHotspot.has(l)) } as Hotspot, depth: line.length, line };
    })
    // Deeper layers go on top of their ancestors (a child that overflows or matches its parent's
    // size still gets the click); among layers of the same depth bigger ones go first.
    .sort((a, b) => a.depth - b.depth || b.h.rect.width * b.h.rect.height - a.h.rect.width * a.h.rect.height || (a.h.id < b.h.id ? -1 : 1));
  const into = new Map<string, Hotspot[]>(); // container id ("" = the screen, "fixed:<id>") → hotspots
  const all = new Map<string, Hotspot>();
  for (const { h, line } of sorted) {
    all.set(h.id, h);
    // A fixed layer owns its subtree; otherwise the innermost scroller that is a proper ancestor.
    let key = "";
    const fixed = line.find((l) => fixedSet.has(l));
    if (fixed) key = "fixed:" + fixed;
    else {
      key = line.slice(1).find((l) => infoOf.has(l)) ?? "";
      const root = line.find((l) => rootOwner.has(l));
      if (root && !line.slice(1).slice(0, line.indexOf(root)).some((l) => infoOf.has(l))) key = "above:" + rootOwner.get(root);
    }
    if (!into.has(key)) into.set(key, []);
    into.get(key)!.push(h);
  }

  // 3. Pictures: the screen without scrolling content and fixed layers, then each scroller's.
  const kids = (id: string) => doc.nodes[id].children;
  const baseHide = [...infos.filter((i) => i.parent === null).flatMap((i) => kids(i.id)), ...(rootsIn.get("") ?? [])];
  const base = svgOf(frameId, baseHide);
  const aboveScene = (scroller: string): AboveScene | null => {
    const roots = aboveRoots.get(scroller);
    if (!roots?.length) return null;
    const pieces = roots.map((id) => {
      // A scroller inside keeps its own picture: leave its children out here.
      const hide = infos.filter((i) => isInside(doc, i.id, id)).flatMap((i) => kids(i.id));
      const r = pq<{ svg: string; x: number; y: number; width: number; height: number }>({ q: "exportSvg", id, hide, withBounds: true });
      return { svg: inlineAssets(r.svg), x: r.x - fb.x, y: r.y - fb.y, width: r.width, height: r.height };
    });
    return { pieces, hotspots: into.get("above:" + scroller) ?? [] };
  };
  const byId = new Map<string, ScrollerScene>();
  const build = (i: Info): ScrollerScene => {
    const hide = [...infos.filter((o) => o.parent === i.id).flatMap((o) => kids(o.id)), ...(rootsIn.get(i.id) ?? [])];
    if (i.id === frameId) hide.push(...fixedIds);
    const c = pq<{ svg: string; x: number; y: number; width: number; height: number }>({ q: "exportSvg", id: i.id, hide, childrenOnly: true });
    const rect = rel(i.rect);
    const s: ScrollerScene = {
      id: i.id,
      rect,
      overflow: i.overflow,
      radius: radiusOf(doc.nodes[i.id]),
      content: { svg: inlineAssets(c.svg), x: c.x - fb.x, y: c.y - fb.y, width: c.width, height: c.height },
      hotspots: into.get(i.id) ?? [],
      scrollers: infos.filter((o) => o.parent === i.id).map(build),
      above: aboveScene(i.id),
      chain: lineage(i.id).filter((l) => withHotspot.has(l)),
    };
    byId.set(i.id, s);
    return s;
  };
  const scrollers = infos.filter((i) => i.parent === null).map(build);
  const fixed = fixedIds.map<FixedScene>((id) => {
    const c = pq<{ svg: string; x: number; y: number; width: number; height: number }>({ q: "exportSvg", id, withBounds: true });
    return { id, svg: inlineAssets(c.svg), rect: rel(c), hotspots: into.get("fixed:" + id) ?? [] };
  });
  return { id: frameId, width: frame.width, height: frame.height, base, hotspots: into.get("") ?? [], scrollers, fixed, keyed, byId, all };
}

/** The scrollers a layer sits in, innermost first. */
export function scrollersOf(scene: Scene, layer: string): ScrollerScene[] {
  const doc = pdoc();
  const out: ScrollerScene[] = [];
  for (let p = doc.nodes[layer]?.parent; p; p = doc.nodes[p]?.parent ?? null) {
    const s = scene.byId.get(p);
    if (s) out.push(s);
  }
  return out;
}

// ---------- smart animate (stage 1: direct children matched by name) ----------

/** One direct child of a container, drawn on its own. */
export interface Piece {
  name: string;
  svg: string;
  /** What it paints, frame coordinates (the crop of `svg`). */
  crop: Rect;
  /** Its box centre in frame coordinates, its size and rotation in degrees. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
  opacity: number;
}

/** More direct children than this and a smart animate dissolves instead. */
export const SMART_MAX_CHILDREN = 200;

/** Whether `container`'s direct children can be smart animated. */
export const smartable = (container: string) => (pdoc().nodes[container]?.children.length ?? 0) <= SMART_MAX_CHILDREN;

/** The visible direct children of a container, each as its own picture (frame = the screen
 *  the coordinates are relative to). Renders each child only, never the whole screen. */
export function piecesOf(container: string, frame: string): Piece[] {
  const doc = pdoc();
  const ids = (doc.nodes[container]?.children ?? []).filter((c) => doc.nodes[c]?.visible !== false);
  if (!ids.length) return [];
  const fb = pq<{ union: Rect }>({ q: "bounds", ids: [frame] }).union;
  const geo = pq<{ items: { id: string; bounds: Rect }[] }>({ q: "bounds", ids }).items;
  return ids.flatMap((id) => {
    const n = doc.nodes[id];
    const b = geo.find((g) => g.id === id)?.bounds;
    if (!b) return [];
    const c = pq<{ svg: string; x: number; y: number; width: number; height: number }>({ q: "exportSvg", id, withBounds: true });
    return [
      {
        name: n.name,
        svg: inlineAssets(c.svg),
        crop: { x: c.x - fb.x, y: c.y - fb.y, width: c.width, height: c.height },
        cx: b.x - fb.x + b.width / 2,
        cy: b.y - fb.y + b.height / 2,
        w: Math.max(1, n.width),
        h: Math.max(1, n.height),
        rot: n.rotation ?? 0,
        opacity: n.opacity ?? 1,
      },
    ];
  });
}

/** Pairs old and new pieces by layer name; repeated names pair in order. */
export function matchPieces(from: Piece[], to: Piece[]): { pairs: [Piece, Piece][]; gone: Piece[]; added: Piece[] } {
  const free = new Map<string, Piece[]>();
  for (const p of to) free.set(p.name, [...(free.get(p.name) ?? []), p]);
  const pairs: [Piece, Piece][] = [];
  const gone: Piece[] = [];
  const used = new Set<Piece>();
  for (const p of from) {
    const q = free.get(p.name)?.shift();
    if (q) {
      pairs.push([p, q]);
      used.add(q);
    } else gone.push(p);
  }
  return { pairs, gone, added: to.filter((p) => !used.has(p)) };
}

/** CSS transform that makes `a`'s box look like `b`'s (about `a`'s centre). */
export function morph(a: Piece, b: Piece): string {
  return `translate(${b.cx - a.cx}px, ${b.cy - a.cy}px) rotate(${b.rot - a.rot}deg) scale(${b.w / a.w}, ${b.h / a.h})`;
}
