// Smart animate, stage 2: layers of two states are matched by name through frames, groups and
// instances, each match becomes a piece that moves, re-renders every frame with interpolated
// values, or cross-fades, and one clock (`SmartTween`) drives them all. Also the pure maths of the
// On drag trigger (progress, rubber band, flick, the completion decision).

import { inlineAssets } from "./assets";
import { linear, type Ease } from "./easing";
import type { Effect, Node, Paint, Rect, TextProps } from "./types";

export type Nodes = Record<string, Node>;
export type Query = (q: Record<string, unknown>) => any;

/** One state of the animation: its layers, the root layer and how to ask the engine that holds them. */
export interface Side {
  nodes: Nodes;
  root: string;
  q: Query;
}

export const SMART_MAX_PIECES = 400;
export const SMART_MAX_LIVE = 40;
const MAX_DEPTH = 10;

// ---------- maths ----------

const lerp = (a: number, b: number, e: number) => a + (b - a) * e;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

type Rgba = [number, number, number, number];

const NAMED: Record<string, Rgba> = { transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1] };

/** `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, `rgb()` and `rgba()` (what the engine writes); null otherwise. */
export function parseColor(s: string): Rgba | null {
  const t = s.trim().toLowerCase();
  if (NAMED[t]) return NAMED[t];
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(t);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  return null;
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
export function formatColor([r, g, b, a]: Rgba): string {
  a = clamp01(a);
  return a >= 0.9995 ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : `rgba(${Math.round(clamp(r, 0, 255))}, ${Math.round(clamp(g, 0, 255))}, ${Math.round(clamp(b, 0, 255))}, ${Math.round(a * 1000) / 1000})`;
}

/** sRGB mix (straight alpha); channels and alpha clamp, so a Back curve doesn't leave the gamut.
 *  A colour that can't be parsed switches half way. */
export function mixColor(a: string, b: string, e: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return e < 0.5 ? a : b;
  return formatColor([lerp(ca[0], cb[0], e), lerp(ca[1], cb[1], e), lerp(ca[2], cb[2], e), lerp(ca[3], cb[3], e)]);
}

const num = (v: number | undefined | null, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function mixPaint(a: Paint, b: Paint, e: number): Paint {
  const opacity = clamp01(lerp(num(a.opacity, 1), num(b.opacity, 1), e));
  if (a.type === "solid" && b.type === "solid") return { ...b, color: mixColor(a.color, b.color, e), opacity };
  if (a.type === "image" || b.type === "image") return { ...b, opacity } as Paint;
  const ga = a as Extract<Paint, { stops: unknown }>;
  const gb = b as Extract<Paint, { stops: unknown }>;
  const out: any = {
    ...gb,
    opacity,
    stops: gb.stops.map((s, i) => ({ color: mixColor(ga.stops[i]?.color ?? s.color, s.color, e), position: clamp01(lerp(ga.stops[i]?.position ?? s.position, s.position, e)) })),
  };
  if (a.type === "linearGradient" && b.type === "linearGradient") out.angle = lerp(num(a.angle), num(b.angle), e);
  const ha = (a as any).handles;
  const hb = (b as any).handles;
  if (ha && hb) {
    const pt = (k: "start" | "end" | "width") => [lerp(ha[k][0], hb[k][0], e), lerp(ha[k][1], hb[k][1], e)];
    out.handles = { start: pt("start"), end: pt("end"), width: pt("width") };
  }
  return out;
}
export const mixPaints = (a: Paint[], b: Paint[], e: number) => b.map((p, i) => mixPaint(a[i], p, e));

export function mixEffects(a: Effect[], b: Effect[], e: number): Effect[] {
  return b.map((x, i) => ({ ...x, color: mixColor(a[i].color, x.color, e), x: lerp(a[i].x, x.x, e), y: lerp(a[i].y, x.y, e), spread: lerp(a[i].spread, x.spread, e), blur: Math.max(0, lerp(a[i].blur, x.blur, e)) }));
}

const radii4 = (n: Node): [number, number, number, number] => n.cornerRadii ?? [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius];

// ---------- matching ----------

const CONTAINERS = new Set(["frame", "group", "component", "componentSet", "instance"]);

const visibleKids = (nodes: Nodes, id: string) => (nodes[id]?.children ?? []).filter((c) => nodes[c] && nodes[c].visible !== false);

/** A matched pair of layers (the old state's `a`, the new state's `b`). */
export interface Track {
  idx: number;
  a: string;
  b: string;
  /** The track of the parent pair, -1 for the roots. */
  parent: number;
  depth: number;
  /** The children are matched below this pair. */
  rec: boolean;
  name: string;
}

/** A layer only one state has (it fades), under the track whose children it is. */
export interface Orphan {
  id: string;
  side: "a" | "b";
  parent: number;
  name: string;
}

export interface Matching {
  tracks: Track[];
  orphans: Orphan[];
}

function canRecurse(an: Nodes, a: string, bn: Nodes, b: string, depth: number): boolean {
  const na = an[a];
  const nb = bn[b];
  if (depth >= MAX_DEPTH || !CONTAINERS.has(na.type) || !CONTAINERS.has(nb.type)) return false;
  const ka = visibleKids(an, a);
  const kb = visibleKids(bn, b);
  if (!ka.length && !kb.length) return false;
  if (na.isMask || nb.isMask || ka.some((c) => an[c].isMask) || kb.some((c) => bn[c].isMask)) return false;
  // A rotated or flipped container is one piece: its children's positions don't add up in a plain sum.
  return !na.rotation && !nb.rotation && !na.flipX && !nb.flipX && !na.flipY && !nb.flipY;
}

/** Pairs the layers of two states by name, level by level. Repeated names pair in order. A pair
 *  recurses when both are containers (not masks, not rotated); the children of an unmatched layer
 *  never match (hierarchy counts). */
export function matchTrees(an: Nodes, ra: string, bn: Nodes, rb: string): Matching {
  const tracks: Track[] = [];
  const orphans: Orphan[] = [];
  const visit = (a: string, b: string, parent: number, depth: number) => {
    const t: Track = { idx: tracks.length, a, b, parent, depth, rec: false, name: bn[b].name };
    tracks.push(t);
    if (!canRecurse(an, a, bn, b, depth)) return;
    t.rec = true;
    const free = new Map<string, string[]>();
    const kb = visibleKids(bn, b);
    for (const c of kb) free.set(bn[c].name, [...(free.get(bn[c].name) ?? []), c]);
    const used = new Set<string>();
    for (const ca of visibleKids(an, a)) {
      const cb = free.get(an[ca].name)?.shift();
      if (cb) {
        used.add(cb);
        visit(ca, cb, t.idx, depth + 1);
      } else orphans.push({ id: ca, side: "a", parent: t.idx, name: an[ca].name });
    }
    for (const cb of kb) if (!used.has(cb)) orphans.push({ id: cb, side: "b", parent: t.idx, name: bn[cb].name });
  };
  if (an[ra] && bn[rb]) visit(ra, rb, -1, 0);
  return { tracks, orphans };
}

// ---------- geometry ----------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Geometry {
  a: Map<string, Box>;
  b: Map<string, Box>;
  /** The page position of each state's root (boxes are relative to it). */
  originA: { x: number; y: number };
  originB: { x: number; y: number };
}

/** Where every layer of the matching sits, relative to its state's root. Reads bounds only. */
export function measure(A: Side, B: Side, m: Matching): Geometry {
  const one = (side: Side, ids: string[]) => {
    const items = side.q({ q: "bounds", ids: [side.root, ...ids] }).items as { id: string; bounds: Rect }[];
    const root = items.find((i) => i.id === side.root)?.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
    const map = new Map<string, Box>();
    for (const i of items) map.set(i.id, { x: i.bounds.x - root.x, y: i.bounds.y - root.y, w: i.bounds.width, h: i.bounds.height });
    return { map, origin: { x: root.x, y: root.y } };
  };
  const a = one(A, [...m.tracks.map((t) => t.a), ...m.orphans.filter((o) => o.side === "a").map((o) => o.id)]);
  const b = one(B, [...m.tracks.map((t) => t.b), ...m.orphans.filter((o) => o.side === "b").map((o) => o.id)]);
  return { a: a.map, b: b.map, originA: a.origin, originB: b.origin };
}

// ---------- what each pair does ----------

export type PieceKind = "move" | "live" | "morph" | "fade";

/** Keys of a layer that draw it, besides its position and opacity. */
const LOOK_KEYS = ["type", "width", "height", "rotation", "flipX", "flipY", "blendMode", "fills", "strokes", "strokeWeight", "strokeAlign", "strokeDash", "strokeWeights", "strokeJoin", "cornerRadius", "cornerRadii", "effects", "clipContent", "text", "vector", "shape", "isMask"] as const;

const lookEqual = (a: Node, b: Node, skip?: ReadonlySet<string>) => LOOK_KEYS.every((k) => skip?.has(k) || same((a as any)[k], (b as any)[k]));

/** Layers (with all their descendants) that look and sit the same relative to their parents. */
function deepSame(an: Nodes, a: string, bn: Nodes, b: string): boolean {
  const na = an[a];
  const nb = bn[b];
  if (!lookEqual(na, nb) || na.x !== nb.x || na.y !== nb.y || na.opacity !== nb.opacity || na.name !== nb.name) return false;
  const ka = visibleKids(an, a);
  const kb = visibleKids(bn, b);
  return ka.length === kb.length && ka.every((c, i) => deepSame(an, c, bn, kb[i]));
}

const paints = (n: Node) => n.fills.some((p) => p.visible !== false) || n.strokes.some((p) => p.visible !== false) || n.effects.some((f) => f.visible !== false);

const paintKinds = (a: Paint[], b: Paint[]) =>
  a.length === b.length &&
  a.every((p, i) => {
    const q = b[i];
    if (p.type !== q.type || (p.visible !== false) !== (q.visible !== false)) return false;
    if (p.type === "image") return same({ ...p, opacity: 0 }, { ...q, opacity: 0 });
    if (p.type === "solid") return parseColor(p.color) !== null && parseColor((q as typeof p).color) !== null;
    const sa = (p as any).stops as unknown[];
    const sb = (q as any).stops as unknown[];
    return sa.length === sb.length;
  });

const stripRunColors = (t: TextProps) => ({ ...t, runs: t.runs.map((r) => ({ ...r, color: undefined })) });

/** Whether two layers differ only in ways that can be interpolated. */
export function interpolatable(a: Node, b: Node): boolean {
  if (a.type !== b.type || a.flipX !== b.flipX || a.flipY !== b.flipY) return false;
  if (!paintKinds(a.fills, b.fills) || !paintKinds(a.strokes, b.strokes)) return false;
  if (a.effects.length !== b.effects.length || a.effects.some((f, i) => f.type !== b.effects[i].type || f.visible !== b.effects[i].visible || !parseColor(f.color) || !parseColor(b.effects[i].color))) return false;
  const skip = new Set(["width", "height", "rotation", "fills", "strokes", "strokeWeight", "cornerRadius", "cornerRadii", "effects", "text"]);
  if (!lookEqual(a, b, skip)) return false;
  if (!!a.text !== !!b.text) return false;
  if (a.text && b.text) {
    if (a.text.runs.length !== b.text.runs.length) return false;
    if (!same(stripRunColors(a.text), stripRunColors(b.text))) return false;
    if (a.text.runs.some((r, i) => (r.color === undefined) !== (b.text!.runs[i].color === undefined) || (r.color !== undefined && (!parseColor(r.color) || !parseColor(b.text!.runs[i].color!))))) return false;
  }
  return true;
}

/** The keys a live piece patches, those in which the two layers differ. */
const LIVE_KEYS = ["width", "height", "rotation", "fills", "strokes", "strokeWeight", "cornerRadius", "cornerRadii", "effects", "text"] as const;

interface PTrack extends Track {
  na: Node;
  nb: Node;
  boxA: Box;
  boxB: Box;
  /** What the layer's own picture does ("none": nothing to draw). */
  kind: PieceKind | "none";
  /** Keys that differ (live: also those of LIVE_KEYS). Position keys are here for every track that
   *  is, or has below it, a live piece. */
  diff: string[];
  /** Has a live piece in its subtree (its position goes into the patch). */
  carries: boolean;
  /** The children are clipped to this box. */
  clips: boolean;
  /** Tracks above this one, outermost first. */
  chain: number[];
}

function classify(an: Nodes, nb: Nodes, t: Track): PieceKind | "none" {
  const na = an[t.a];
  const nn = nb[t.b];
  if (t.rec && !paints(na) && !paints(nn)) return "none";
  if (!t.rec && (visibleKids(an, t.a).length || visibleKids(nb, t.b).length)) {
    const ka = visibleKids(an, t.a);
    const kb = visibleKids(nb, t.b);
    if (ka.length !== kb.length || !ka.every((c, i) => deepSame(an, c, nb, kb[i]))) return "morph";
  }
  if (lookEqual(na, nn)) return "move";
  // An image that is resized is cross-faded with scaling, not re-rendered.
  const image = [...na.fills, ...na.strokes].some((p) => p.type === "image");
  if (image && (na.width !== nn.width || na.height !== nn.height)) return "morph";
  return interpolatable(na, nn) ? "live" : "morph";
}

// ---------- the plan ----------

/** A picture and where it goes, frame coordinates. */
export interface Art {
  svg: string;
  crop: Rect;
}

export interface PlanPiece {
  key: string;
  kind: PieceKind;
  side: "both" | "old" | "new";
  name: string;
  path: string;
  /** Track of the layer itself (`live`, `move`, `morph`) or of the parent it moves with (`fade`). */
  track: number;
  /** Tracks whose opacity multiplies in (strictly above the layer), and the ones that clip it. */
  anc: number[];
  clips: number[];
  /** Layer id on the state it's drawn from. */
  id: string;
  own: boolean;
  art?: Art;
  /** Move: the layer's displacement. Morph and fade use `from`/`to` boxes. */
  dx: number;
  dy: number;
  boxA?: Box;
  boxB?: Box;
  rotA: number;
  rotB: number;
  opA: number;
  opB: number;
  /** The layer's own opacity (fade). */
  op: number;
}

export interface SmartPlan {
  match: Matching;
  geo: Geometry;
  width: number;
  height: number;
  tracks: PTrack[];
  pieces: PlanPiece[];
  live: number;
  liveIds: string[];
  ownIds: string[];
  patchIds: PTrack[];
  originB: { x: number; y: number };
  /** Where the root sits on the screen the pieces are drawn on. */
  at: { x: number; y: number };
  offsetA: { x: number; y: number };
  offsetB: { x: number; y: number };
  /** Everything is clipped to this (a scroller's or an overlay's box), frame coordinates. */
  clip: Rect | null;
  q: Query;
}

export interface SmartOptions {
  at?: { x: number; y: number };
  offsetA?: { x: number; y: number };
  offsetB?: { x: number; y: number };
  clip?: Rect | null;
}

/** Prefixes the ids of an SVG, so two pictures of the same layer can sit in one page. */
export function scopeSvg(svg: string, prefix: string): string {
  return svg.replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`).replace(/\bhref="#([^"]+)"/g, `href="#${prefix}$1"`);
}

/** How many pieces a pair of states would make (to decide before drawing anything). */
export function pieceCount(an: Nodes, bn: Nodes, m: Matching): number {
  let n = m.orphans.length;
  for (const t of m.tracks) {
    const k = classify(an, bn, t);
    if (k !== "none") n += k === "morph" ? 2 : 1;
  }
  return n;
}

/** Plans the animation from `A` to `B`: matches, decides what each pair does, draws what needs
 *  drawing once. Null when it is too big to animate (the caller dissolves instead). */
export function planSmart(A: Side, B: Side, o: SmartOptions = {}): SmartPlan | null {
  const m = matchTrees(A.nodes, A.root, B.nodes, B.root);
  if (!m.tracks.length || pieceCount(A.nodes, B.nodes, m) > SMART_MAX_PIECES) return null;
  const geo = measure(A, B, m);
  const zero: Box = { x: 0, y: 0, w: 0, h: 0 };
  const tracks: PTrack[] = m.tracks.map((t) => {
    const na = A.nodes[t.a];
    const nb = B.nodes[t.b];
    const chain = t.parent < 0 ? [] : [...(tracks_chain(m.tracks, t.parent))];
    return { ...t, na, nb, boxA: geo.a.get(t.a) ?? zero, boxB: geo.b.get(t.b) ?? zero, kind: classify(A.nodes, B.nodes, t), diff: [], carries: false, clips: t.rec && t.depth > 0 && na.clipContent && nb.clipContent, chain };
  });
  // The first live pieces stay live; the rest cross-fade.
  let live = 0;
  for (const t of tracks) {
    if (t.kind !== "live") continue;
    if (live < SMART_MAX_LIVE) live++;
    else t.kind = "morph";
  }
  for (const t of tracks) {
    if (t.kind === "live") for (const k of LIVE_KEYS) if (!same((t.na as any)[k], (t.nb as any)[k])) t.diff.push(k);
    if (t.parent >= 0 && (t.na.x !== t.nb.x || t.na.y !== t.nb.y)) t.diff.push("pos");
    if (t.kind === "live") for (const i of t.chain) tracks[i].carries = true;
  }
  const patchTracks = tracks.filter((t) => t.kind === "live" || (t.parent >= 0 && t.carries));
  const pathOf = (nodes: Nodes, id: string) => {
    const names: string[] = [];
    for (let x: string | null | undefined = id; x && x !== A.root && x !== B.root; x = nodes[x]?.parent) names.unshift(nodes[x]?.name ?? "");
    return names.join("/");
  };
  const pieces: PlanPiece[] = [];
  const blank = { dx: 0, dy: 0, rotA: 0, rotB: 0, opA: 1, opB: 1, op: 1 };
  const clipsOf = (chain: number[]) => chain.filter((i) => tracks[i].clips);
  const need = { a: new Map<string, boolean>(), b: new Map<string, boolean>() };
  for (const t of tracks) {
    if (t.kind === "none") continue;
    const base = { name: t.name, path: pathOf(B.nodes, t.b), track: t.idx, anc: t.chain, clips: clipsOf(t.chain), own: t.rec, ...blank, boxA: t.boxA, boxB: t.boxB, rotA: t.na.rotation, rotB: t.nb.rotation, opA: t.na.opacity, opB: t.nb.opacity };
    if (t.kind === "move") {
      pieces.push({ ...base, key: `t${t.idx}`, kind: "move", side: "both", id: t.b, dx: t.boxB.x - t.boxA.x, dy: t.boxB.y - t.boxA.y });
      need.b.set(t.b, t.rec);
    } else if (t.kind === "live") {
      pieces.push({ ...base, key: `t${t.idx}`, kind: "live", side: "both", id: t.b });
    } else {
      pieces.push({ ...base, key: `o${t.idx}`, kind: "morph", side: "old", id: t.a });
      pieces.push({ ...base, key: `n${t.idx}`, kind: "morph", side: "new", id: t.b });
      need.a.set(t.a, t.rec);
      need.b.set(t.b, t.rec);
    }
  }
  m.orphans.forEach((or, i) => {
    const nodes = or.side === "a" ? A.nodes : B.nodes;
    const parent = tracks[or.parent];
    const chain = [...parent.chain, parent.idx];
    pieces.push({
      ...blank,
      key: `f${i}`,
      kind: "fade",
      side: or.side === "a" ? "old" : "new",
      name: or.name,
      path: pathOf(nodes, or.id),
      track: parent.idx,
      anc: chain,
      clips: clipsOf(chain),
      id: or.id,
      own: false,
      op: nodes[or.id].opacity,
      dx: parent.boxB.x - parent.boxA.x,
      dy: parent.boxB.y - parent.boxA.y,
    });
    (or.side === "a" ? need.a : need.b).set(or.id, false);
  });
  // Pictures drawn once: the opacity is applied per frame, so the layer is drawn at full opacity.
  const draw = (side: Side, origin: { x: number; y: number }, ids: Map<string, boolean>) => {
    const out = new Map<string, Art>();
    if (!ids.size) return out;
    const list = [...ids.keys()];
    const patch = Object.fromEntries(list.map((id) => [id, { opacity: 1 }]));
    const items = side.q({ q: "exportPieces", ids: list, patch, own: list.filter((id) => ids.get(id)) }) as { id: string; svg: string; x: number; y: number; width: number; height: number }[];
    for (const it of items) out.set(it.id, { svg: inlineAssets(it.svg), crop: { x: it.x - origin.x, y: it.y - origin.y, width: it.width, height: it.height } });
    return out;
  };
  const artA = draw(A, geo.originA, need.a);
  const artB = draw(B, geo.originB, need.b);
  for (const p of pieces) {
    if (p.kind === "live") continue;
    const fromA = p.side === "old";
    const art = (fromA ? artA : artB).get(p.id);
    // The old state's pictures get their own ids: the same layer can be drawn on both sides (Change to).
    if (art) p.art = fromA ? { ...art, svg: scopeSvg(art.svg, "a_") } : art;
  }
  const root = tracks[0];
  return {
    match: m,
    geo,
    width: root.nb.width,
    height: root.nb.height,
    tracks,
    pieces,
    live,
    liveIds: tracks.filter((t) => t.kind === "live").map((t) => t.b),
    ownIds: tracks.filter((t) => t.kind === "live" && t.rec).map((t) => t.b),
    patchIds: patchTracks,
    originB: geo.originB,
    at: o.at ?? { x: 0, y: 0 },
    offsetA: o.offsetA ?? { x: 0, y: 0 },
    offsetB: o.offsetB ?? { x: 0, y: 0 },
    clip: o.clip ?? null,
    q: B.q,
  };
}

function tracks_chain(tracks: Track[], idx: number): number[] {
  const out: number[] = [];
  for (let i = idx; i >= 0; i = tracks[i].parent) out.unshift(i);
  return out;
}

// ---------- values at a moment ----------

/** The merge patch for one track at progress `e` (not clamped: a Back curve overshoots). */
export function patchAt(t: PTrack, e: number): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const a = t.na;
  const b = t.nb;
  if (t.kind === "live") p.opacity = 1;
  for (const k of t.diff) {
    switch (k) {
      case "pos":
        p.x = lerp(a.x, b.x, e);
        p.y = lerp(a.y, b.y, e);
        break;
      case "width":
      case "height":
        p[k] = Math.max(0, lerp(a[k], b[k], e));
        break;
      case "rotation":
        p.rotation = lerp(a.rotation, b.rotation, e);
        break;
      case "strokeWeight":
        p.strokeWeight = Math.max(0, lerp(a.strokeWeight, b.strokeWeight, e));
        break;
      case "cornerRadius":
        p.cornerRadius = Math.max(0, lerp(a.cornerRadius, b.cornerRadius, e));
        break;
      case "cornerRadii": {
        const ra = radii4(a);
        const rb = radii4(b);
        p.cornerRadii = rb.map((r, i) => Math.max(0, lerp(ra[i], r, e)));
        break;
      }
      case "fills":
        p.fills = mixPaints(a.fills, b.fills, e);
        break;
      case "strokes":
        p.strokes = mixPaints(a.strokes, b.strokes, e);
        break;
      case "effects":
        p.effects = mixEffects(a.effects, b.effects, e);
        break;
      case "text":
        if (a.text && b.text) p.text = { runs: b.text.runs.map((r, i) => (r.color !== undefined && a.text!.runs[i]?.color !== undefined ? { ...r, color: mixColor(a.text!.runs[i].color!, r.color, e) } : r)) };
        break;
    }
  }
  // A corner radius that moves with `cornerRadii` set on one side only needs both keys.
  if (("cornerRadius" in p || "cornerRadii" in p) && (a.cornerRadii || b.cornerRadii) && !("cornerRadii" in p)) {
    const ra = radii4(a);
    const rb = radii4(b);
    p.cornerRadii = rb.map((r, i) => Math.max(0, lerp(ra[i], r, e)));
  }
  return p;
}

/** A track's box at progress `e`, frame coordinates (clamped to non-negative sizes). */
export function boxAt(t: PTrack, e: number): Box {
  return { x: lerp(t.boxA.x, t.boxB.x, e), y: lerp(t.boxA.y, t.boxB.y, e), w: Math.max(0, lerp(t.boxA.w, t.boxB.w, e)), h: Math.max(0, lerp(t.boxA.h, t.boxB.h, e)) };
}

// ---------- the tween ----------

const css = (el: HTMLElement) => el.style;
const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;

/** Draws a plan into `host` and drives it: `seek` freezes it at a moment, `play` runs it. One
 *  requestAnimationFrame loop moves every piece, so they stay in step and the duration is exact. */
export class SmartTween {
  private raf = 0;
  private timer = 0;
  private done: ((reached: boolean) => void) | null = null;
  private els: { piece: PlanPiece; el: HTMLElement; clipEls: HTMLElement[] }[] = [];
  private shift: HTMLElement;
  private root: HTMLElement;
  private clipEls = new Map<number, HTMLElement[]>();
  /** The progress passed to the last `seek` (0..1 of time) and the value that drew it. */
  p = 0;
  eased = 0;
  /** Whether a `play` is running. */
  running = false;

  constructor(
    host: HTMLElement,
    readonly plan: SmartPlan,
    readonly ease: Ease = linear,
  ) {
    this.root = document.createElement("div");
    css(this.root).cssText = "position:absolute;left:0;top:0;width:100%;height:100%;";
    if (plan.clip) css(this.root).clipPath = `inset(${px(plan.clip.y)} calc(100% - ${px(plan.clip.x + plan.clip.width)}) calc(100% - ${px(plan.clip.y + plan.clip.height)}) ${px(plan.clip.x)})`;
    this.shift = document.createElement("div");
    css(this.shift).cssText = `position:absolute;left:${px(plan.at.x)};top:${px(plan.at.y)};width:${px(plan.width)};height:${px(plan.height)};`;
    this.root.appendChild(this.shift);
    host.appendChild(this.root);
    for (const piece of plan.pieces) {
      const el = document.createElement("div");
      el.dataset.smart = piece.name;
      el.dataset.smartKind = piece.kind;
      el.dataset.smartSide = piece.side;
      el.dataset.smartPath = piece.path;
      css(el).position = "absolute";
      if (piece.art) {
        const c = piece.art.crop;
        css(el).left = px(c.x);
        css(el).top = px(c.y);
        css(el).width = px(c.width);
        css(el).height = px(c.height);
        css(el).transformOrigin = this.origin(piece);
        el.innerHTML = piece.art.svg;
      }
      // Nested boxes that clip, so a piece inside a clipping frame is cut by it as it moves.
      let parent: HTMLElement = this.shift;
      const own: HTMLElement[] = [];
      for (const ci of piece.clips) {
        const w = document.createElement("div");
        css(w).cssText = `position:absolute;left:0;top:0;width:${px(plan.width)};height:${px(plan.height)};`;
        parent.appendChild(w);
        parent = w;
        own.push(w);
        this.clipEls.set(ci, [...(this.clipEls.get(ci) ?? []), w]);
      }
      parent.appendChild(el);
      this.els.push({ piece, el, clipEls: own });
    }
  }

  /** Where a piece rotates and scales about: its own centre, in its picture's coordinates. */
  private origin(p: PlanPiece): string {
    const c = p.art!.crop;
    const box = p.side === "new" ? p.boxB : p.boxA;
    const b = box ?? { x: c.x, y: c.y, w: c.width, h: c.height };
    return `${px(b.x + b.w / 2 - c.x)} ${px(b.y + b.h / 2 - c.y)}`;
  }

  /** Freezes the tween at time `t` (0..1) with `ease` (default: the tween's own). */
  seek(t: number, ease: Ease = this.ease) {
    this.halt();
    this.p = t;
    this.draw(ease(t));
  }

  /** Runs from where it is to 0 or 1 over `ms` with `ease`. Resolves true when it gets there,
   *  false when something else (a seek, a cancel) stopped it first. */
  play(to: 0 | 1, ms: number, ease: Ease = this.ease): Promise<boolean> {
    this.halt();
    const from = this.eased;
    const start = performance.now();
    this.running = true;
    return new Promise<boolean>((resolve) => {
      const finish = () => {
        cancelAnimationFrame(this.raf);
        clearTimeout(this.timer);
        this.running = false;
        this.done = null;
        this.p = to;
        this.draw(to);
        resolve(true);
      };
      this.done = resolve;
      if (ms <= 0 || from === to) return finish();
      const tick = (now: number) => {
        const tau = Math.min(1, Math.max(0, (now - start) / ms));
        this.p = to === 1 ? tau : 1 - tau;
        this.draw(from + (to - from) * ease(tau));
        if (tau >= 1) return finish();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
      // A page that doesn't paint (a hidden tab) still gets to the end.
      this.timer = window.setTimeout(finish, ms + 120);
    });
  }

  private halt() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.running = false;
    const d = this.done;
    this.done = null;
    d?.(false);
  }

  /** Stops it and takes its pictures away. */
  cancel() {
    this.halt();
    this.root.remove();
  }

  state() {
    return { p: this.p, eased: this.eased, pieces: this.plan.pieces.map((p) => ({ name: p.name, path: p.path, kind: p.kind, side: p.side })) };
  }

  /** Puts every piece where it belongs at progress `e` (may lie outside 0..1). */
  draw(e: number) {
    const plan = this.plan;
    this.eased = e;
    // The whole thing sits where the scrollers (or the overlay) of both states put it.
    css(this.shift).transform = `translate(${px(lerp(plan.offsetA.x, plan.offsetB.x, e))}, ${px(lerp(plan.offsetA.y, plan.offsetB.y, e))})`;
    // Layers that re-render: one query for all of them, with the interpolated values.
    const live = new Map<string, { svg: string; x: number; y: number; width: number; height: number }>();
    if (plan.liveIds.length) {
      const patch: Record<string, unknown> = {};
      for (const t of plan.patchIds) patch[t.b] = patchAt(t, e);
      const items = plan.q({ q: "exportPieces", ids: plan.liveIds, patch, own: plan.ownIds }) as { id: string; svg: string; x: number; y: number; width: number; height: number }[];
      for (const it of items) live.set(it.id, it);
    }
    // Opacity of each track, multiplied down the tree.
    const op = plan.tracks.map((t) => clamp01(lerp(t.na.opacity, t.nb.opacity, e)));
    const chainOp = plan.tracks.map((t) => t.chain.reduce((m, i) => m * op[i], 1));
    const anc = (p: PlanPiece) => (p.kind === "fade" ? plan.tracks[p.track].chain.reduce((m, i) => m * op[i], op[p.track]) : chainOp[p.track]);
    for (const [ci, wrappers] of this.clipEls) {
      const t = plan.tracks[ci];
      const b = boxAt(t, e);
      const r = radii4(t.nb).map((rb, i) => Math.max(0, lerp(radii4(t.na)[i], rb, e)));
      const v = `inset(${px(b.y)} ${px(plan.width - (b.x + b.w))} ${px(plan.height - (b.y + b.h))} ${px(b.x)} round ${r.map(px).join(" ")})`;
      for (const el of wrappers) css(el).clipPath = v;
    }
    for (const { piece: p, el } of this.els) {
      const s = css(el);
      const aop = anc(p);
      if (p.kind === "live") {
        const it = live.get(p.id);
        if (it) {
          const key = it.svg;
          if ((el as any)._svg !== key) {
            el.innerHTML = inlineAssets(it.svg);
            (el as any)._svg = key;
          }
          s.left = px(it.x - plan.originB.x);
          s.top = px(it.y - plan.originB.y);
          s.width = px(it.width);
          s.height = px(it.height);
        }
        s.opacity = String(clamp01(lerp(p.opA, p.opB, e)) * aop);
      } else if (p.kind === "move") {
        s.transform = `translate(${px((e - 1) * p.dx)}, ${px((e - 1) * p.dy)})`;
        s.opacity = String(clamp01(lerp(p.opA, p.opB, e)) * aop);
      } else if (p.kind === "morph") {
        const a = p.boxA!;
        const b = p.boxB!;
        const sx = a.w > 0 && b.w > 0 ? b.w / a.w : 1;
        const sy = a.h > 0 && b.h > 0 ? b.h / a.h : 1;
        const dcx = b.x + b.w / 2 - (a.x + a.w / 2);
        const dcy = b.y + b.h / 2 - (a.y + a.h / 2);
        if (p.side === "old") {
          s.transform = `translate(${px(dcx * e)}, ${px(dcy * e)}) rotate(${(p.rotB - p.rotA) * e}deg) scale(${Math.max(0, 1 + (sx - 1) * e)}, ${Math.max(0, 1 + (sy - 1) * e)})`;
          s.opacity = String(clamp01(1 - e) * p.opA * aop);
        } else {
          const k = 1 - e;
          s.transform = `translate(${px(-dcx * k)}, ${px(-dcy * k)}) rotate(${(p.rotA - p.rotB) * k}deg) scale(${Math.max(0, 1 + (1 / sx - 1) * k)}, ${Math.max(0, 1 + (1 / sy - 1) * k)})`;
          s.opacity = String(clamp01(e) * p.opB * aop);
        }
      } else {
        // Fade: where it was (old) or will be (new), carried by its parent's movement.
        if (p.side === "old") {
          s.transform = `translate(${px(e * p.dx)}, ${px(e * p.dy)})`;
          s.opacity = String(clamp01(1 - e) * p.op * aop);
        } else {
          s.transform = `translate(${px((e - 1) * p.dx)}, ${px((e - 1) * p.dy)})`;
          s.opacity = String(clamp01(e) * p.op * aop);
        }
      }
    }
  }
}

// ---------- On drag ----------

/** Screen pixels the pointer moves before a press becomes a drag. */
export const DRAG_SLOP = 5;
/** A release at this speed (px/ms) toward completion completes the action. */
export const FLICK_SPEED = 0.5;
/** Beyond the ends the drag follows at this fraction of the pointer. */
export const RUBBER_BAND = 0.3;
/** A displacement under this (px) isn't a direction to drag along. */
export const MIN_DISPLACEMENT = 8;

export type Vec = { x: number; y: number };

/** Progress of a drag: the pointer's travel along `d` (the vector the layer travels), as a fraction
 *  of its length. Not clamped. */
export function dragProgress(delta: Vec, d: Vec): number {
  const len = Math.hypot(d.x, d.y);
  return len > 0 ? (delta.x * d.x + delta.y * d.y) / (len * len) : 0;
}

/** 0..1 inside, beyond the ends it moves at `RUBBER_BAND` of the pointer. */
export const rubberBand = (p: number) => (p < 0 ? p * RUBBER_BAND : p > 1 ? 1 + (p - 1) * RUBBER_BAND : p);

/** Speed (px/ms) along the unit vector `dir` over the samples of the last `windowMs`. */
export function velocityAlong(samples: { t: number; x: number; y: number }[], dir: Vec, windowMs = 100): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = last;
  for (let i = samples.length - 2; i >= 0 && last.t - samples[i].t <= windowMs; i--) first = samples[i];
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  const len = Math.hypot(dir.x, dir.y) || 1;
  return ((last.x - first.x) * dir.x + (last.y - first.y) * dir.y) / len / dt;
}

/** Whether a released drag completes: half way or more, or a flick toward completion. */
export const completes = (progress: number, speedToward: number) => progress >= 0.5 || speedToward >= FLICK_SPEED;

/** The axis a drag vector runs along: horizontal, vertical, or null when it is too short. */
export function dragAxis(d: Vec | null): "x" | "y" | null {
  if (!d || Math.hypot(d.x, d.y) < MIN_DISPLACEMENT) return null;
  return Math.abs(d.x) >= Math.abs(d.y) ? "x" : "y";
}

/** The CSS `touch-action` a drag along `axis` needs: the other axis stays with the browser. */
export const touchActionFor = (axis: "x" | "y" | null) => (axis === "x" ? "pan-y" : axis === "y" ? "pan-x" : "none");

/** The vector a smart animate moves a dragged layer along: its displacement between the states,
 *  else its nearest matched ancestor's; when that is under `MIN_DISPLACEMENT`, the biggest
 *  displacement among the matched layers below that ancestor (a carousel track inside a still
 *  frame). Reads the plan's boxes, nothing is drawn. */
export function smartVector(m: Matching, geo: Geometry, layer: string): Vec | null {
  const disp = (t: Track): Vec => {
    const a = geo.a.get(t.a);
    const b = geo.b.get(t.b);
    return a && b ? { x: b.x - a.x, y: b.y - a.y } : { x: 0, y: 0 };
  };
  const byA = new Map(m.tracks.map((t) => [t.a, t]));
  const byB = new Map(m.tracks.map((t) => [t.b, t]));
  const own = byA.get(layer) ?? byB.get(layer);
  let t: Track | undefined = own;
  if (!t) {
    // Not matched: its nearest matched ancestor, by the orphan's parent.
    const or = m.orphans.find((o) => o.id === layer);
    if (or) t = m.tracks[or.parent];
  }
  if (!t) return null;
  const d = disp(t);
  if (Math.hypot(d.x, d.y) >= MIN_DISPLACEMENT) return d;
  let best = d;
  const below = (i: number) => {
    for (const c of m.tracks) {
      if (c.parent !== i) continue;
      const cd = disp(c);
      if (Math.hypot(cd.x, cd.y) > Math.hypot(best.x, best.y)) best = cd;
      below(c.idx);
    }
  };
  below(t.idx);
  return Math.hypot(best.x, best.y) >= MIN_DISPLACEMENT ? best : null;
}

/** Moves a value from `from` to `to` over `ms` with `ease` (`from + (to - from) * ease(t)`), calling
 *  `apply` every frame. Resolves at the end or when cancelled. Used where the picture isn't a tween
 *  (a drag that scrubs the screen animations). */
export function ramp(from: number, to: number, ms: number, ease: Ease, apply: (v: number) => void): { done: Promise<void>; cancel: () => void } {
  let raf = 0;
  let timer = 0;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => (settle = resolve));
  const stop = () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    settle();
  };
  const finish = () => {
    apply(to);
    stop();
  };
  if (ms <= 0 || from === to) finish();
  else {
    const start = performance.now();
    const tick = (now: number) => {
      const tau = Math.min(1, Math.max(0, (now - start) / ms));
      if (tau >= 1) return finish();
      apply(from + (to - from) * ease(tau));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    timer = window.setTimeout(finish, ms + 120);
  }
  return { done, cancel: stop };
}
