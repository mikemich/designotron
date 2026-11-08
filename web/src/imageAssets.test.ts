import { describe, expect, it } from "vitest";
import { downscaleSize, fitNative, imagesIn, isAssetSrc } from "./imageAssets";
import type { Doc, Node, Paint } from "./types";

const img = (src: string, extra: Partial<Extract<Paint, { type: "image" }>> = {}): Paint => ({ type: "image", src, scaleMode: "fill", opacity: 1, visible: true, ...extra });

function node(id: string, type: string, over: Partial<Node> = {}): Node {
  return { id, type, name: id, children: [], fills: [], strokes: [], ...over } as unknown as Node;
}

function doc(): Doc {
  const nodes: Record<string, Node> = {
    f1: node("f1", "frame", { children: ["a", "b", "inst"] }),
    a: node("a", "rectangle", { name: "Hero", fills: [img("asset:x1")] }),
    b: node("b", "rectangle", { name: "Hero copy", fills: [{ type: "solid", color: "#fff", opacity: 1, visible: true }, img("asset:x1"), img("asset:x1")] }),
    inst: node("inst", "instance", { children: ["innerImg"], fills: [img("asset:x2")] }),
    innerImg: node("innerImg", "rectangle", { fills: [img("asset:x1")] }),
    f2: node("f2", "frame", { children: ["c", "d"] }),
    c: node("c", "rectangle", { name: "Remote", fills: [img("https://example.com/p.jpg", { credit: { provider: "pexels", photoId: "1", title: "t", alt: "", author: "A", authorUrl: "", source: "", sourceUrl: "", license: "L", licenseUrl: "", attributionRequired: false, nonCommercial: false } })] }),
    d: node("d", "ellipse", { name: "Ring", strokes: [img("asset:x3")] }),
  };
  return {
    id: "d",
    name: "t",
    schema: 1,
    pages: [
      { id: "p1", name: "One", children: ["f1"], background: "#fff", flowStart: null, guides: [] },
      { id: "p2", name: "Two", children: ["f2"], background: "#fff", flowStart: null, guides: [] },
    ],
    nodes,
    styles: { colors: [], texts: [] },
    variables: [],
    comments: {},
  };
}

describe("imagesIn", () => {
  it("lists a source once with every layer that uses it", () => {
    const all = imagesIn(doc(), null);
    expect(all.map((e) => e.src)).toEqual(["asset:x1", "asset:x2", "https://example.com/p.jpg", "asset:x3"]);
    const x1 = all[0];
    // Two fills of one layer count once; the layer inside the instance is not a use.
    expect(x1.count).toBe(2);
    expect(x1.uses.map((u) => u.id)).toEqual(["a", "b"]);
    expect(x1.uses.every((u) => u.page === "p1")).toBe(true);
    expect(all[1].uses.map((u) => u.id)).toEqual(["inst"]);
  });

  it("keeps the page of each use and the credit, and reads strokes", () => {
    const all = imagesIn(doc(), null);
    const remote = all.find((e) => e.src.startsWith("https"))!;
    expect(remote.uses[0].page).toBe("p2");
    expect(remote.credit?.author).toBe("A");
    expect(all.find((e) => e.src === "asset:x3")!.uses[0].name).toBe("Ring");
  });

  it("limits to one page", () => {
    expect(imagesIn(doc(), "p2").map((e) => e.src)).toEqual(["https://example.com/p.jpg", "asset:x3"]);
    expect(imagesIn(doc(), "nope")).toEqual([]);
  });

  it("tells file assets from links", () => {
    expect(isAssetSrc("asset:x1")).toBe(true);
    expect(isAssetSrc("https://example.com/a.png")).toBe(false);
  });
});

describe("fitNative", () => {
  it("keeps the native size up to 4096 px and scales the long side down above it", () => {
    expect(fitNative(4000, 3000)).toEqual({ width: 4000, height: 3000 });
    expect(fitNative(4096, 100)).toEqual({ width: 4096, height: 100 });
    expect(fitNative(5000, 1000)).toEqual({ width: 4096, height: 819 });
    expect(fitNative(1000, 8192)).toEqual({ width: 500, height: 4096 });
    expect(fitNative(1, 20000)).toEqual({ width: 1, height: 4096 });
  });
});

describe("downscaleSize", () => {
  it("leaves images that fit alone", () => {
    expect(downscaleSize(4096, 100)).toBeNull();
    expect(downscaleSize(1200, 800)).toBeNull();
  });

  it("scales the long side to 4096 and keeps the aspect ratio", () => {
    expect(downscaleSize(8000, 6000)).toEqual({ width: 4096, height: 3072 });
    expect(downscaleSize(3000, 12288)).toEqual({ width: 1000, height: 4096 });
  });

  it("never rounds a thin side to zero", () => {
    expect(downscaleSize(40960, 1)).toEqual({ width: 4096, height: 1 });
  });
});
