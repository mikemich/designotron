import { describe, expect, it } from "vitest";
import type { Doc, Node } from "../types";
import { descendantContainers, rangeIds, searchLayers, type LayerFilter } from "./layerTree";

const mk = (id: string, parent: string | null, extra: Partial<Node> = {}): Node =>
  ({ id, name: id, type: "frame", parent, page: "p1", children: [], visible: true, locked: false, fills: [], ...extra }) as unknown as Node;

/** Builds a doc from [id, parent, extra] tuples; children keep the order given (bottom first). */
function docOf(list: [string, string | null, Partial<Node>?][]): Doc {
  const nodes: Record<string, Node> = {};
  for (const [id, parent, extra] of list) nodes[id] = mk(id, parent, extra);
  const roots: string[] = [];
  for (const [id, parent] of list) (parent ? nodes[parent].children : roots).push(id);
  return { pages: [{ id: "p1", name: "P", children: roots }], nodes } as unknown as Doc;
}

const rowsOf = (ids: [string, string | null][]) => ids.map(([id, parent]) => ({ n: { id, parent } }));

describe("rangeIds", () => {
  // Panel order, top first: F (open) > a, b ; then c, d.
  const rows = rowsOf([
    ["F", null],
    ["a", "F"],
    ["b", "F"],
    ["c", null],
    ["d", null],
  ]);
  it("goes forward and backward, inclusive", () => {
    expect(rangeIds(rows, "c", "d")).toEqual(["c", "d"]);
    expect(rangeIds(rows, "d", "c")).toEqual(["c", "d"]);
    expect(rangeIds(rows, "a", "b")).toEqual(["a", "b"]);
  });
  it("lets a frame in the range stand for its expanded children", () => {
    expect(rangeIds(rows, "F", "d")).toEqual(["F", "c", "d"]);
    expect(rangeIds(rows, "d", "F")).toEqual(["F", "c", "d"]);
  });
  it("keeps children whose frame is outside the range", () => {
    expect(rangeIds(rows, "b", "c")).toEqual(["b", "c"]);
    expect(rangeIds(rows, "d", "a")).toEqual(["a", "b", "c", "d"]);
  });
  it("keeps every row of the range when it is flat (search results)", () => {
    expect(rangeIds(rows, "F", "d", false)).toEqual(["F", "a", "b", "c", "d"]);
    expect(rangeIds(rows, "d", "a", false)).toEqual(["a", "b", "c", "d"]);
  });
  it("falls back to the target without an anchor", () => {
    expect(rangeIds(rows, null, "c")).toEqual(["c"]);
    expect(rangeIds(rows, "gone", "c")).toEqual(["c"]);
    expect(rangeIds(rows, "a", "gone")).toEqual([]);
  });
});

describe("descendantContainers", () => {
  it("lists nested containers but not leaves or the start", () => {
    const d = docOf([
      ["root", null],
      ["x", "root"],
      ["y", "x"],
      ["leaf", "y"],
      ["z", "root"],
    ]);
    expect(descendantContainers(d, "root").sort()).toEqual(["x", "y"]);
    expect(descendantContainers(d, "leaf")).toEqual([]);
  });
  it("handles a chain of 500 without recursion", () => {
    const list: [string, string | null][] = [];
    for (let i = 0; i < 500; i++) list.push([`n${i}`, i ? `n${i - 1}` : null]);
    list.push(["end", "n499"]);
    expect(descendantContainers(docOf(list), "n0")).toHaveLength(499);
  });
});

describe("searchLayers", () => {
  const none = new Set<LayerFilter>();
  const d = docOf([
    ["s1", null, { name: "Screen 1" }],
    ["c1", "s1", { name: "Card 01" }],
    ["t1", "c1", { type: "text", name: "Title", text: { characters: "Hello World" } as never }],
    ["c2", "s1", { name: "Card 02", visible: false }],
    ["img", "s1", { type: "rectangle", name: "Photo", fills: [{ type: "image" }] as never }],
    ["r", "s1", { type: "rectangle", name: "Box", locked: true }],
    ["comp", null, { type: "component", name: "Button" }],
    ["inst", null, { type: "instance", name: "Button copy" }],
    ["inner", "inst", { type: "text", name: "Label", text: { characters: "Card text" } as never }],
  ]);
  it("matches names case-insensitively with the parent path, top layer first", () => {
    const r = searchLayers(d, "p1", "CARD", none, 50);
    expect(r.hits.map((h) => h.id)).toEqual(["inner", "c2", "c1"]);
    expect(r.hits.find((h) => h.id === "c1")!.path).toEqual(["Screen 1"]);
    expect(r.total).toBe(3);
  });
  it("matches text content, and inside instances", () => {
    expect(searchLayers(d, "p1", "hello", none, 50).hits.map((h) => h.id)).toEqual(["t1"]);
    expect(searchLayers(d, "p1", "label", none, 50).hits[0].path).toEqual(["Button copy"]);
  });
  it("filters by type, hidden and locked", () => {
    const ids = (f: LayerFilter[], q = "") => searchLayers(d, "p1", q, new Set(f), 50).hits.map((h) => h.id);
    expect(ids(["text"])).toEqual(["inner", "t1"]);
    expect(ids(["text"], "card")).toEqual(["inner"]);
    expect(ids(["images"])).toEqual(["img"]);
    expect(ids(["shapes"])).toEqual(["r"]);
    expect(ids(["components", "instances"])).toEqual(["inst", "comp"]);
    expect(ids(["hidden"])).toEqual(["c2"]);
    expect(ids(["locked"])).toEqual(["r"]);
    expect(ids(["hidden", "locked"])).toEqual(["r", "c2"]);
    expect(ids(["frames", "hidden"])).toEqual(["c2"]);
  });
  it("caps the list but keeps counting", () => {
    const r = searchLayers(d, "p1", "", new Set<LayerFilter>(["frames"]), 2);
    expect(r.hits).toHaveLength(2);
    expect(r.total).toBe(3);
  });
  it("only looks at the given page", () => {
    expect(searchLayers(d, "other", "card", none, 50).total).toBe(0);
  });
});

describe("searchLayers names only", () => {
  const d = docOf([
    ["s1", null, { name: "Screen 1" }],
    ["t1", "s1", { type: "text", name: "Title", text: { characters: "Hello World" } as never }],
    ["t2", "s1", { type: "text", name: "Hello label", text: { characters: "Other words" } as never }],
  ]);
  const none = new Set<LayerFilter>();
  it("content: false matches names only", () => {
    expect(searchLayers(d, "p1", "hello", none, 50).hits.map((h) => h.id)).toEqual(["t2", "t1"]);
    expect(searchLayers(d, "p1", "hello", none, 50, { content: false }).hits.map((h) => h.id)).toEqual(["t2"]);
    expect(searchLayers(d, "p1", "hello", none, 50, { content: true }).total).toBe(2);
  });
  it("names still match with the filters", () => {
    expect(searchLayers(d, "p1", "title", new Set<LayerFilter>(["text"]), 50, { content: false }).hits.map((h) => h.id)).toEqual(["t1"]);
  });
});
