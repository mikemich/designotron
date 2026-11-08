import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OVERLAY, overlayBox, overlayOrigin, presentStart } from "./prototype";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "./presenterPrefs";
import { carryScroll, scrollRange, type ScrollerScene } from "./player";
import type { Doc, Node, OverlaySettings } from "./types";

const screen = { width: 800, height: 600 };
const at = (position: OverlaySettings["position"], extra: Partial<OverlaySettings> = {}): OverlaySettings => ({ ...DEFAULT_OVERLAY, position, ...extra });
const trigger = { x: 100, y: 50, width: 40, height: 20 };

describe("overlayBox", () => {
  const small = { width: 200, height: 100 };
  it("places a small overlay at each position", () => {
    const pos = (p: OverlaySettings["position"]) => {
      const b = overlayBox(at(p), screen, small, trigger);
      return [b.x, b.y, b.width, b.height];
    };
    expect(pos("center")).toEqual([300, 250, 200, 100]);
    expect(pos("topLeft")).toEqual([0, 0, 200, 100]);
    expect(pos("topCenter")).toEqual([300, 0, 200, 100]);
    expect(pos("topRight")).toEqual([600, 0, 200, 100]);
    expect(pos("bottomLeft")).toEqual([0, 500, 200, 100]);
    expect(pos("bottomCenter")).toEqual([300, 500, 200, 100]);
    expect(pos("bottomRight")).toEqual([600, 500, 200, 100]);
    expect(pos("manual")).toEqual([100, 50, 200, 100]);
  });

  it("keeps a manual offset inside the screen on every edge", () => {
    const m = (offsetX: number, offsetY: number) => {
      const b = overlayBox(at("manual", { offsetX, offsetY }), screen, small, trigger);
      return [b.x, b.y];
    };
    expect(m(1000, 0)).toEqual([600, 50]); // past the right edge
    expect(m(0, 1000)).toEqual([100, 500]); // past the bottom
    expect(m(-500, 0)).toEqual([0, 50]); // past the left
    expect(m(0, -500)).toEqual([100, 0]); // past the top
    expect(m(20, 10)).toEqual([120, 60]); // inside: untouched
  });

  it("limits an overlay bigger than the screen to the screen", () => {
    const tall = overlayBox(at("center"), screen, { width: 300, height: 1200 }, trigger);
    expect([tall.x, tall.y, tall.width, tall.height]).toEqual([250, 0, 300, 600]);
    const wide = overlayBox(at("bottomRight"), screen, { width: 2000, height: 100 }, trigger);
    expect([wide.x, wide.y, wide.width, wide.height]).toEqual([0, 500, 800, 100]);
    const huge = overlayBox(at("manual", { offsetX: 900, offsetY: 900 }), screen, { width: 2000, height: 2000 }, trigger);
    expect([huge.x, huge.y, huge.width, huge.height]).toEqual([0, 0, 800, 600]);
  });

  it("overlayOrigin is the box's corner", () => {
    expect(overlayOrigin(at("topRight"), screen, small, trigger)).toEqual({ x: 600, y: 0 });
  });
});

describe("presenterPrefs", () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = () => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    return m;
  };

  it("defaults to hints on click on and always-show off", () => {
    store();
    expect(DEFAULT_PREFS).toEqual({ hints: true, always: false });
    expect(loadPrefs()).toEqual({ hints: true, always: false });
  });

  it("remembers each option under its own key", () => {
    const m = store();
    savePrefs({ always: true });
    expect(m.get("dt:present-always")).toBe("1");
    expect(m.has("dt:present-hints")).toBe(false);
    savePrefs({ hints: false });
    expect(loadPrefs()).toEqual({ hints: false, always: true });
  });

  it("falls back to the defaults when storage is missing or throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs({ hints: false })).not.toThrow();
  });
});

// ---------- carryScroll ----------

const node = (id: string, name: string, parent: string | null): Node => ({ id, name, parent }) as unknown as Node;
const docOf = (list: [string, string, string | null][]): Doc => ({ nodes: Object.fromEntries(list.map(([id, name, parent]) => [id, node(id, name, parent)])) }) as unknown as Doc;

/** A scroller 100 wide and 200 tall (frame coordinates from 0) with `contentH` of content. */
const scroller = (id: string, contentH: number, kids: ScrollerScene[] = [], overflow: ScrollerScene["overflow"] = "vertical"): ScrollerScene =>
  ({
    id,
    rect: { x: 0, y: 0, width: 100, height: 200 },
    overflow,
    content: { svg: "", x: 0, y: 0, width: 100, height: contentH },
    hotspots: [],
    scrollers: kids,
    above: null,
    chain: [id],
  }) as unknown as ScrollerScene;
const sceneOf = (id: string, scrollers: ScrollerScene[]) => ({ id, scrollers });

describe("carryScroll", () => {
  it("scrollRange is the content beyond the box", () => {
    expect(scrollRange(scroller("s", 1000))).toEqual({ left: 0, top: 800 });
    expect(scrollRange(scroller("s", 100))).toEqual({ left: 0, top: 0 });
  });

  it("carries the top frame's scroll to the destination's top frame", () => {
    const doc = docOf([["a", "Home", null], ["b", "Home 2", null]]);
    const out = carryScroll(sceneOf("a", [scroller("a", 1000)]), sceneOf("b", [scroller("b", 1000)]), new Map([["a", { left: 0, top: 400 }]]), doc);
    expect(out.get("b")).toEqual({ left: 0, top: 400 });
  });

  it("clamps to the destination's range and ignores an axis it doesn't scroll", () => {
    const doc = docOf([["a", "A", null], ["b", "B", null]]);
    const from = sceneOf("a", [scroller("a", 2000, [], "both")]);
    const short = carryScroll(from, sceneOf("b", [scroller("b", 500)]), new Map([["a", { left: 30, top: 1500 }]]), doc);
    expect(short.get("b")).toEqual({ left: 0, top: 300 }); // top clamped to 500 - 200, left: vertical only
    const noScroll = carryScroll(from, sceneOf("b", [scroller("b", 150)]), new Map([["a", { left: 0, top: 900 }]]), doc);
    expect(noScroll.size).toBe(0);
  });

  it("pairs nested scrollers by layer name path, not id", () => {
    const doc = docOf([
      ["a", "Home", null],
      ["a-list", "List", "a"],
      ["a-inner", "Inner", "a-list"],
      ["b", "Home 2", null],
      ["b-list", "List", "b"],
      ["b-inner", "Inner", "b-list"],
      ["b-other", "Other", "b"],
    ]);
    const from = sceneOf("a", [scroller("a", 900, [scroller("a-list", 700, [scroller("a-inner", 600)])])]);
    const to = sceneOf("b", [scroller("b", 900, [scroller("b-list", 700, [scroller("b-inner", 600)]), scroller("b-other", 700)])]);
    const pos = new Map([
      ["a", { left: 0, top: 10 }],
      ["a-list", { left: 0, top: 20 }],
      ["a-inner", { left: 0, top: 30 }],
    ]);
    const out = carryScroll(from, to, pos, doc);
    expect(Object.fromEntries(out)).toEqual({ b: { left: 0, top: 10 }, "b-list": { left: 0, top: 20 }, "b-inner": { left: 0, top: 30 } });
  });

  it("pairs a repeated name in order", () => {
    const doc = docOf([
      ["a", "A", null],
      ["a1", "Row", "a"],
      ["a2", "Row", "a"],
      ["b", "B", null],
      ["b1", "Row", "b"],
      ["b2", "Row", "b"],
    ]);
    const from = sceneOf("a", [scroller("a1", 800), scroller("a2", 800)]);
    const to = sceneOf("b", [scroller("b1", 800), scroller("b2", 800)]);
    const out = carryScroll(from, to, new Map([["a1", { left: 0, top: 50 }], ["a2", { left: 0, top: 60 }]]), doc);
    expect(Object.fromEntries(out)).toEqual({ b1: { left: 0, top: 50 }, b2: { left: 0, top: 60 } });
    // A destination with only one of them takes the first.
    const one = carryScroll(from, sceneOf("b", [scroller("b1", 800)]), new Map([["a1", { left: 0, top: 50 }], ["a2", { left: 0, top: 60 }]]), doc);
    expect(Object.fromEntries(one)).toEqual({ b1: { left: 0, top: 50 } });
  });

  it("does nothing for a destination without scrollers or a scroller at the top", () => {
    const doc = docOf([["a", "A", null], ["b", "B", null]]);
    expect(carryScroll(sceneOf("a", [scroller("a", 900)]), sceneOf("b", []), new Map([["a", { left: 0, top: 100 }]]), doc).size).toBe(0);
    expect(carryScroll(sceneOf("a", []), sceneOf("b", [scroller("b", 900)]), new Map(), doc).size).toBe(0);
  });
});

describe("presentStart", () => {
  const n = (id: string, type: string, parent: string | null, page = "p1"): Node => ({ id, type, parent, page }) as unknown as Node;
  const doc = {
    pages: [
      { id: "p1", children: ["f1", "f2", "set"], flowStart: "f1" },
      { id: "p2", children: ["g1"] },
    ],
    nodes: Object.fromEntries(
      [
        n("f1", "frame", null),
        n("f2", "frame", null),
        n("inner", "frame", "f2"),
        n("leaf", "rectangle", "inner"),
        n("set", "componentSet", null),
        n("variant", "component", "set"),
        n("g1", "frame", null, "p2"),
      ].map((x) => [x.id, x]),
    ),
  } as unknown as Doc;

  it("starts on the top-level frame holding the selection", () => {
    expect(presentStart(doc, "p1", ["leaf"])).toBe("f2");
    expect(presentStart(doc, "p1", ["inner"])).toBe("f2");
    expect(presentStart(doc, "p1", ["f2", "f1"])).toBe("f2");
  });

  it("falls back to the flow start", () => {
    expect(presentStart(doc, "p1", [])).toBe("f1");
    expect(presentStart(doc, "p1", ["variant"])).toBe("f1");
    expect(presentStart(doc, "p1", ["set"])).toBe("f1");
    expect(presentStart(doc, "p1", ["g1"])).toBe("f1");
    expect(presentStart(doc, "p1", ["gone"])).toBe("f1");
  });
});
