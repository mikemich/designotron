import { describe, expect, it } from "vitest";
import type { Doc, Node } from "../types";
import { layersUsing, usageMessage } from "./layersUsing";

const node = (id: string, extra: Partial<Node> = {}, children: string[] = []) => ({ id, children, bindings: {}, ...extra }) as unknown as Node;

function doc(): Pick<Doc, "nodes" | "pages"> {
  const nodes: Record<string, Node> = {};
  for (const n of [
    node("f1", {}, ["a", "b"]),
    node("a", { fillStyle: "s1" }),
    node("b", { bindings: { fill: "v1" } }, ["c"]),
    node("c", { textStyle: "s1", strokeStyle: "s1" }),
    node("f2", { effectStyle: "s1" }, ["d"]),
    node("d", { bindings: { gap: "v1" } }),
    node("lonely", { gridStyle: "s2" }),
  ])
    nodes[n.id] = n;
  return {
    nodes,
    pages: [
      { id: "p1", name: "One", children: ["f1"], background: "#fff", flowStart: null, guides: [] },
      { id: "p2", name: "Two", children: ["f2"], background: "#fff", flowStart: null, guides: [] },
    ],
  };
}

describe("layersUsing", () => {
  it("lists the page's layers in layer order and counts the other pages", () => {
    expect(layersUsing(doc(), "p1", "s1")).toEqual({ here: ["a", "c"], other: 1 });
    expect(layersUsing(doc(), "p2", "s1")).toEqual({ here: ["f2"], other: 2 });
  });

  it("finds variable bindings", () => {
    expect(layersUsing(doc(), "p1", "v1")).toEqual({ here: ["b"], other: 1 });
  });

  it("reports nothing for an unused id or an unknown page", () => {
    expect(layersUsing(doc(), "p1", "nope")).toEqual({ here: [], other: 0 });
    expect(layersUsing(doc(), "missing", "s1").here).toEqual([]);
  });

  it("scans a 20,000-layer document in a few milliseconds", () => {
    const nodes: Record<string, Node> = { root: node("root", {}, []) };
    for (let i = 0; i < 20000; i++) {
      nodes["n" + i] = node("n" + i, i % 5 === 0 ? { fillStyle: "s" } : {});
      nodes.root.children.push("n" + i);
    }
    const big = { nodes, pages: [{ id: "p", name: "P", children: ["root"], background: "#fff", flowStart: null, guides: [] }] };
    const t = performance.now();
    const u = layersUsing(big, "p", "s");
    expect(u.here).toHaveLength(4000);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("usageMessage", () => {
  it("reads as the plan words it", () => {
    expect(usageMessage("Brand", { here: Array(12).fill("x"), other: 3 })).toBe("Selected 12 layers (3 more on other pages)");
    expect(usageMessage("Brand", { here: ["x"], other: 0 })).toBe("Selected 1 layer");
    expect(usageMessage("Brand", { here: [], other: 0 })).toBe("No layers use Brand");
    expect(usageMessage("Brand", { here: [], other: 2 })).toContain("2 on other pages");
  });
});
