import { describe, expect, it } from "vitest";
import { cubicBezier, EASING_BEZIER, bezierOf, easeOf } from "./easing";
import {
  boxAt,
  completes,
  dragAxis,
  dragProgress,
  interpolatable,
  matchTrees,
  measure,
  mixColor,
  mixEffects,
  mixPaints,
  parseColor,
  patchAt,
  planSmart,
  rubberBand,
  smartVector,
  stickyOffset,
  stickyShift,
  touchActionFor,
  velocityAlong,
  type Nodes,
  type Side,
} from "./smart";
import type { Node, Paint } from "./types";

const solid = (color: string): Paint => ({ type: "solid", color, opacity: 1, visible: true });
let seq = 0;
function node(name: string, type: Node["type"], extra: Partial<Node> = {}): Node {
  return {
    id: `n${++seq}`, type, name, page: "p", parent: null, children: [], x: 0, y: 0, width: 100, height: 50, rotation: 0, flipX: false, flipY: false,
    visible: true, locked: false, opacity: 1, blendMode: "normal", fills: [solid("#FF0000")], strokes: [], strokeWeight: 0, strokeAlign: "inside", strokeDash: [],
    cornerRadius: 0, cornerRadii: null, effects: [], clipContent: false, layout: null, sizingH: "fixed", sizingV: "fixed", absolutePosition: false,
    constraints: { horizontal: "left", vertical: "top" }, text: null, vector: null, shape: null, component: null, instance: null, masterId: null, fillStyle: null,
    textStyle: null, interactions: [], notes: "", isMask: false, ...extra,
  } as Node;
}
/** A tree from `[node, children]` pairs; returns the map and the root id. */
type Spec = [Node, Spec[]?];
function tree(spec: Spec, nodes: Nodes = {}): { nodes: Nodes; root: string } {
  const add = (s: Spec, parent: string | null) => {
    const [n, kids = []] = s;
    n.parent = parent;
    nodes[n.id] = n;
    n.children = kids.map((k) => k[0].id);
    kids.forEach((k) => add(k, n.id));
  };
  add(spec, null);
  return { nodes, root: spec[0].id };
}
const idOf = (nodes: Nodes, ...path: string[]) => {
  let cur = Object.values(nodes).find((n) => n.parent === null)!;
  for (const name of path) cur = nodes[cur.children.find((c) => nodes[c].name === name)!];
  return cur.id;
};

describe("easing", () => {
  it("cubicBezier matches known values", () => {
    expect(cubicBezier(0.42, 0, 1, 1)(0.5)).toBeCloseTo(0.3153, 3);
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 5);
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3);
    expect(cubicBezier(0.42, 0, 0.58, 1)(0)).toBe(0);
    expect(cubicBezier(0.42, 0, 0.58, 1)(1)).toBe(1);
  });
  it("Back curves leave 0..1", () => {
    const inBack = easeOf(EASING_BEZIER.easeInBack);
    const outBack = easeOf(EASING_BEZIER.easeOutBack);
    expect(inBack(0.15)).toBeLessThan(0);
    expect(outBack(0.85)).toBeGreaterThan(1);
  });
  it("a custom bezier replaces the preset and clamps x", () => {
    expect(bezierOf({ easing: "easeIn", bezier: [2, 0, -1, 1] })).toEqual([1, 0, 0, 1]);
    expect(bezierOf({ easing: "easeIn", bezier: null })).toEqual(EASING_BEZIER.easeIn);
    expect(bezierOf({ easing: undefined, bezier: undefined })).toEqual(EASING_BEZIER.easeOut);
  });
});

describe("colours and values", () => {
  it("parses and mixes in sRGB", () => {
    expect(parseColor("#f00")).toEqual([255, 0, 0, 1]);
    expect(parseColor("rgba(0, 0, 255, 0.5)")).toEqual([0, 0, 255, 0.5]);
    expect(mixColor("#FF0000", "#0000FF", 0.5)).toBe("#800080");
    expect(mixColor("#FFFFFF", "#FFFFFF00", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
  });
  it("clamps channels and alpha on overshoot", () => {
    expect(mixColor("#FF0000", "#00FF00", -0.5)).toBe("#ff0000".replace("ff0000", "ff0000"));
    expect(mixColor("#808080", "#FFFFFF", 5)).toBe("#ffffff");
    const p = mixPaints([solid("#000000")], [{ ...solid("#FFFFFF"), opacity: 0.5 }], -1)[0] as Extract<Paint, { type: "solid" }>;
    expect(p.opacity).toBe(1);
  });
  it("mixes gradient stops and effects (blur never below 0)", () => {
    const g = (a: string, b: string): Paint => ({ type: "linearGradient", angle: 0, opacity: 1, visible: true, stops: [{ color: a, position: 0 }, { color: b, position: 1 }] });
    const m = mixPaints([g("#000000", "#FFFFFF")], [g("#FF0000", "#FFFFFF")], 0.5)[0] as any;
    expect(m.stops[0].color).toBe("#800000");
    const fx = (blur: number) => ({ type: "dropShadow" as const, color: "#000000", x: 0, y: 4, blur, spread: 0, visible: true });
    expect(mixEffects([fx(10)], [fx(0)], 2)[0].blur).toBe(0);
    expect(mixEffects([fx(10)], [fx(20)], 0.5)[0].blur).toBe(15);
  });
});

describe("matching", () => {
  const frame = (name: string, kids: Spec[], extra: Partial<Node> = {}): Spec => [node(name, "frame", extra), kids];
  const leaf = (name: string, extra: Partial<Node> = {}): Spec => [node(name, "rectangle", extra)];

  it("pairs by name path through frames, groups and instances", () => {
    const a = tree(frame("A", [frame("Card", [leaf("Badge"), [node("Row", "group"), [leaf("Icon")]]])]));
    const b = tree(frame("B", [frame("Card", [leaf("Badge"), [node("Row", "group"), [leaf("Icon")]]])]));
    const m = matchTrees(a.nodes, a.root, b.nodes, b.root);
    expect(m.tracks.map((t) => t.name)).toEqual(["B", "Card", "Badge", "Row", "Icon"]);
    expect(m.orphans).toEqual([]);
    const inst = tree(frame("A", [[node("Toggle", "instance"), [leaf("Knob")]]]));
    const inst2 = tree(frame("B", [[node("Toggle", "instance"), [leaf("Knob")]]]));
    expect(matchTrees(inst.nodes, inst.root, inst2.nodes, inst2.root).tracks.map((t) => t.name)).toEqual(["B", "Toggle", "Knob"]);
  });
  it("pairs repeated names in order and leaves extras unmatched", () => {
    const a = tree(frame("A", [leaf("Dot", { x: 1 }), leaf("Dot", { x: 2 })]));
    const b = tree(frame("B", [leaf("Dot", { x: 10 }), leaf("Dot", { x: 20 }), leaf("Dot", { x: 30 })]));
    const m = matchTrees(a.nodes, a.root, b.nodes, b.root);
    expect(m.tracks.slice(1).map((t) => [a.nodes[t.a].x, b.nodes[t.b].x])).toEqual([[1, 10], [2, 20]]);
    expect(m.orphans.map((o) => [o.side, b.nodes[o.id]?.x])).toEqual([["b", 30]]);
  });
  it("an unmatched parent blocks its children", () => {
    const a = tree(frame("A", [frame("Box", [leaf("Dot")])]));
    const b = tree(frame("B", [frame("Boxes", [leaf("Dot")])]));
    const m = matchTrees(a.nodes, a.root, b.nodes, b.root);
    expect(m.tracks).toHaveLength(1);
    expect(m.orphans.map((o) => [o.side, o.name])).toEqual([["a", "Box"], ["b", "Boxes"]]);
  });
  it("rotated containers and masks are one piece", () => {
    const a = tree(frame("A", [frame("Spin", [leaf("In")], { rotation: 10 }), frame("Masked", [leaf("M", { isMask: true }), leaf("Under")])]));
    const b = tree(frame("B", [frame("Spin", [leaf("In")], { rotation: 40 }), frame("Masked", [leaf("M", { isMask: true }), leaf("Under")])]));
    const m = matchTrees(a.nodes, a.root, b.nodes, b.root);
    expect(m.tracks.map((t) => [t.name, t.rec])).toEqual([["B", true], ["Spin", false], ["Masked", false]]);
  });
  it("skips hidden layers", () => {
    const a = tree(frame("A", [leaf("Gone", { visible: false })]));
    const b = tree(frame("B", [leaf("Gone")]));
    const m = matchTrees(a.nodes, a.root, b.nodes, b.root);
    expect(m.tracks).toHaveLength(1);
    expect(m.orphans.map((o) => o.side)).toEqual(["b"]);
  });
  it("matches an instance's before and after snapshots layer by layer", () => {
    const nodes = { ...tree(frame("Off", [leaf("Knob", { x: 4 })])).nodes };
    const offRoot = Object.values(nodes)[0].id;
    const on = tree(frame("On", [leaf("Knob", { x: 96 })]));
    const m = matchTrees(nodes, offRoot, on.nodes, on.root);
    expect(m.tracks.map((t) => t.name)).toEqual(["On", "Knob"]);
  });
});

describe("interpolation", () => {
  it("decides what can be interpolated", () => {
    const a = node("x", "rectangle", { fills: [solid("#FF0000")], cornerRadius: 4, width: 80 });
    expect(interpolatable(a, node("x", "rectangle", { fills: [solid("#0000FF")], cornerRadius: 16, width: 160 }))).toBe(true);
    expect(interpolatable(a, node("x", "ellipse"))).toBe(false);
    expect(interpolatable(a, node("x", "rectangle", { fills: [] }))).toBe(false);
    const grad: Paint = { type: "linearGradient", angle: 0, opacity: 1, visible: true, stops: [{ color: "#000", position: 0 }] };
    expect(interpolatable(a, node("x", "rectangle", { fills: [grad] }))).toBe(false);
  });
  it("text interpolates colours only", () => {
    const t = (chars: string, color: string) => node("t", "text", { fills: [solid(color)], text: { characters: chars, fontFamily: "Inter", fontSize: 14, fontWeight: 400, italic: false, lineHeight: null, letterSpacing: 0, paragraphSpacing: 0, alignH: "left", alignV: "top", autoResize: "none", decoration: "none", case: "original", runs: [{ start: 0, end: chars.length, color }] } });
    expect(interpolatable(t("Hi", "#000000"), t("Hi", "#FF0000"))).toBe(true);
    expect(interpolatable(t("Hi", "#000000"), t("Ho", "#000000"))).toBe(false);
  });

  /** A side whose engine answers `bounds` and `exportPieces` from the nodes themselves. */
  const side = (t: { nodes: Nodes; root: string }): Side => ({
    ...t,
    q: (q: any) => {
      if (q.q === "bounds") {
        const abs = (id: string): { x: number; y: number; width: number; height: number } => {
          const n = t.nodes[id];
          const p = n.parent ? abs(n.parent) : { x: 0, y: 0 };
          return { x: p.x + n.x, y: p.y + n.y, width: n.width, height: n.height };
        };
        return { items: q.ids.map((id: string) => ({ id, bounds: abs(id) })) };
      }
      return q.ids.map((id: string) => ({ id, svg: `<svg id="a${id}"></svg>`, x: 0, y: 0, width: 10, height: 10 }));
    },
  });
  const mk = (p: boolean) =>
    tree([node(p ? "B" : "A", "frame", { width: 390, height: 844 }), [[node("Card", "frame", { x: p ? 200 : 20, y: 100, width: 300, height: 200, clipContent: true }), [
      [node("Badge", "rectangle", { x: 10, y: 10, width: p ? 160 : 80, height: 30, cornerRadius: p ? 16 : 4, fills: [solid(p ? "#0000FF" : "#FF0000")] })],
      [node("Img", "rectangle", { x: 10, y: 60, width: p ? 80 : 40, height: p ? 80 : 40, fills: [{ type: "image", src: "asset:x", scaleMode: "fill", opacity: 1, visible: true } as Paint] })],
      [node("Still", "rectangle", { x: 10, y: 150, width: 20, height: 20 })],
    ]]]]);
  it("plans pieces by kind", () => {
    const plan = planSmart(side(mk(false)), side(mk(true)))!;
    const by = (name: string) => plan.pieces.filter((p) => p.name === name).map((p) => p.kind);
    expect(by("Badge")).toEqual(["live"]);
    expect(by("Img")).toEqual(["morph", "morph"]);
    expect(by("Still")).toEqual(["move"]);
    expect(plan.live).toBe(1);
  });
  it("patches the interpolated values and clamps on overshoot", () => {
    const plan = planSmart(side(mk(false)), side(mk(true)))!;
    const badge = plan.tracks.find((t) => t.name === "Badge")!;
    const half = patchAt(badge, 0.5) as any;
    expect(half.width).toBe(120);
    expect(half.cornerRadius).toBe(10);
    expect(half.fills[0].color).toBe("#800080");
    expect(half.opacity).toBe(1);
    const back = patchAt(badge, -1) as any;
    expect(back.width).toBe(0); // 80 - 80
    expect(back.cornerRadius).toBe(0);
    expect(patchAt(badge, 1.5).width).toBe(200); // geometry extrapolates
    const card = plan.tracks.find((t) => t.name === "Card")!;
    expect(boxAt(card, 0.5).x).toBe(110);
    expect(boxAt(card, -0.5).x).toBe(-70);
  });
  it("a Back overshoot of rotation and position extrapolates", () => {
    const a = tree([node("A", "frame"), [[node("R", "rectangle", { x: 0, rotation: 0 })]]]);
    const b = tree([node("B", "frame"), [[node("R", "rectangle", { x: 100, rotation: 90 })]]]);
    const plan = planSmart(side(a), side(b))!;
    const r = plan.tracks.find((t) => t.name === "R")!;
    expect(r.kind).toBe("live");
    expect(patchAt(r, -0.1)).toMatchObject({ x: -10, rotation: -9 });
  });
  it("dissolves above 400 pieces and keeps at most 40 live", () => {
    const many = (n: number, color: string) => tree([node("S", "frame"), Array.from({ length: n }, (_, i) => [node(`L${i}`, "rectangle", { fills: [solid(color)], x: i })] as Spec)]);
    expect(planSmart(side(many(401, "#FF0000")), side(many(401, "#00FF00")))).toBeNull();
    const plan = planSmart(side(many(60, "#FF0000")), side(many(60, "#00FF00")))!;
    expect(plan.pieces.filter((p) => p.kind === "live").length).toBe(40);
    expect(plan.pieces.filter((p) => p.kind === "morph" && p.side === "old").length).toBe(20);
  });
  it("measures boxes relative to each root", () => {
    const a = side(mk(false));
    const b = side(mk(true));
    const m = matchTrees(a.nodes, a.root, b.nodes, b.root);
    const g = measure(a, b, m);
    const card = m.tracks.find((t) => t.name === "Card")!;
    expect(g.a.get(card.a)).toMatchObject({ x: 20, y: 100 });
    expect(g.b.get(card.b)).toMatchObject({ x: 200, y: 100 });
  });
});

describe("On drag", () => {
  it("progress projects the pointer on the travel vector", () => {
    expect(dragProgress({ x: -120, y: 7 }, { x: -300, y: 0 })).toBeCloseTo(0.4);
    expect(dragProgress({ x: 50, y: 0 }, { x: -300, y: 0 })).toBeCloseTo(-1 / 6);
    expect(dragProgress({ x: 5, y: 5 }, { x: 0, y: 0 })).toBe(0);
  });
  it("the rubber band follows at 0.3 beyond the ends", () => {
    expect(rubberBand(0.5)).toBe(0.5);
    expect(rubberBand(-1)).toBeCloseTo(-0.3);
    expect(rubberBand(2)).toBeCloseTo(1.3);
  });
  it("velocity over the last 100 ms and the completion decision", () => {
    const s = [{ t: 0, x: 0, y: 0 }, { t: 200, x: -10, y: 0 }, { t: 240, x: -40, y: 0 }];
    expect(velocityAlong(s, { x: -1, y: 0 })).toBeCloseTo(0.75);
    expect(velocityAlong([s[0]], { x: -1, y: 0 })).toBe(0);
    expect(completes(0.5, 0)).toBe(true);
    expect(completes(0.49, 0.49)).toBe(false);
    expect(completes(0.1, 0.5)).toBe(true);
    expect(completes(0.1, -2)).toBe(false);
  });
  it("touch-action comes from the axis", () => {
    expect(touchActionFor(dragAxis({ x: -300, y: 0 }))).toBe("pan-y");
    expect(touchActionFor(dragAxis({ x: 0, y: 200 }))).toBe("pan-x");
    expect(touchActionFor(dragAxis({ x: 2, y: 1 }))).toBe("none");
    expect(touchActionFor(dragAxis(null))).toBe("none");
  });
  it("the drag axis of a carousel is its moving track, not the still frame", () => {
    const track = (n: number) => tree([node("Slide", "frame", { width: 300, clipContent: true }), [[node("Track", "frame", { x: -(n - 1) * 300, width: 900 }), [0, 1, 2].map((i) => [node(`S${i}`, "rectangle", { x: i * 300 })] as Spec)]]]);
    const a = track(1);
    const b = track(2);
    const q = (t: { nodes: Nodes }) => (qq: any) => ({
      items: qq.ids.map((id: string) => {
        let x = 0;
        for (let c: string | null = id; c; c = t.nodes[c].parent) x += t.nodes[c].x;
        return { id, bounds: { x, y: 0, width: t.nodes[id].width, height: 10 } };
      }),
    });
    const A: Side = { ...a, q: q(a) };
    const B: Side = { ...b, q: q(b) };
    const m = matchTrees(a.nodes, a.root, b.nodes, b.root);
    const v = smartVector(m, measure(A, B, m), a.root)!;
    expect(v).toEqual({ x: -300, y: 0 });
    expect(touchActionFor(dragAxis(v))).toBe("pan-y");
    // A layer inside the moving track moves with it.
    expect(smartVector(m, measure(A, B, m), idOf(a.nodes, "Track", "S1"))).toEqual({ x: -300, y: 0 });
  });
});

describe("sticky layers", () => {
  it("sticks at the scroller's top and leaves with its parent", () => {
    // Layer top 40, scroller top 0, box bottom 90 (height 50), parent bottom 200.
    const at = (top: number) => stickyShift(top, 40, 0, 90, 200);
    expect(at(0)).toBe(0); // not reached yet
    expect(at(40)).toBe(0);
    expect(at(100)).toBe(60); // held at the top: pushed down by what it scrolled past
    expect(at(1000)).toBe(110); // the parent's bottom takes it away (200 - 90)
  });
  it("is never negative, even when the box is already past the parent", () => {
    expect(stickyShift(500, 40, 0, 300, 200)).toBe(0);
    expect(stickyShift(-50, 40, 0, 90, 200)).toBe(0);
  });
  it("the offset is minus the scroll plus the push (the layer stays where the screen shows it)", () => {
    const shift = stickyShift(100, 40, 0, 90, 200); // 60
    expect(stickyOffset(-100, shift)).toBe(-40); // content at 40 shows at 40 - 100 + 60 = 0
    expect(40 + stickyOffset(-100, shift)).toBe(0);
    expect(stickyOffset(-100, 0)).toBe(-100); // a plain layer just scrolls
  });
});
