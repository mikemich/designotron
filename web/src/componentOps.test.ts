import { describe, expect, it, vi } from "vitest";
import type { Doc, Node } from "./types";

// The ops talk to the engine through the store; these tests only use the pure helpers.
vi.mock("./store", () => ({ dispatch: vi.fn(), dispatchOrThrow: vi.fn(), getDoc: vi.fn(), getEngine: vi.fn(), toast: vi.fn() }));
vi.mock("./ui/controls", () => ({ MOD: "Ctrl" }));

const { orderFor, orderedEntries, propertyOrder, setProperties, variantName } = await import("./componentOps");

const variant = (id: string, parent: string, name: string): Node => {
  // The saved props are an alphabetical map; the order lives in the name.
  const variantProps: Record<string, string> = {};
  for (const [k, v] of name.split(",").map((p) => p.split("=").map((x) => x.trim())).sort((a, b) => a[0].localeCompare(b[0]))) variantProps[k] = v;
  return { id, name, type: "component", parent, children: [], component: { description: "", variantProps } } as unknown as Node;
};

function docWith(names: string[]): { doc: Doc; set: Node } {
  const set = { id: "set", name: "Button", type: "componentSet", parent: null, children: names.map((_, i) => `v${i}`) } as unknown as Node;
  const nodes: Record<string, Node> = { set };
  names.forEach((n, i) => (nodes[`v${i}`] = variant(`v${i}`, "set", n)));
  return { doc: { nodes, pages: [] } as unknown as Doc, set };
}

describe("propertyOrder", () => {
  it("follows the first variant's name, not the alphabet", () => {
    const { doc, set } = docWith(["Size=S, State=Default, Icon=None", "Size=M, State=Hover, Icon=Left"]);
    expect(propertyOrder(doc, set)).toEqual(["Size", "State", "Icon"]);
    expect(setProperties(doc, set).map((p) => p.name)).toEqual(["Size", "State", "Icon"]);
    expect(setProperties(doc, set)[1].values).toEqual(["Default", "Hover"]);
  });
  it("puts keys the first variant lacks last, sorted", () => {
    const { doc, set } = docWith(["State=Default, Size=S", "Zeta=1, Alpha=2, State=Hover, Size=M"]);
    expect(propertyOrder(doc, set)).toEqual(["State", "Size", "Alpha", "Zeta"]);
  });
  it("orders a loose component by its own name", () => {
    const loose = variant("c", "p", "Tone=Soft, Size=L");
    const doc = { nodes: { c: loose }, pages: [] } as unknown as Doc;
    expect(orderFor(doc, loose)).toEqual(["Tone", "Size"]);
  });
});

describe("variantName", () => {
  const props = { Icon: "None", Size: "S", State: "Default" };
  it("writes the keys in the given order", () => {
    expect(variantName(props, ["Size", "State", "Icon"])).toBe("Size=S, State=Default, Icon=None");
  });
  it("a renamed property keeps its position", () => {
    // State renamed to Mode: the order list is renamed in place first.
    const order = ["Size", "State", "Icon"].map((k) => (k === "State" ? "Mode" : k));
    expect(variantName({ Icon: "None", Size: "S", Mode: "Default" }, order)).toBe("Size=S, Mode=Default, Icon=None");
  });
  it("an added property goes last", () => {
    expect(variantName({ ...props, "Property 4": "Default" }, [...["Size", "State", "Icon"], "Property 4"])).toBe("Size=S, State=Default, Icon=None, Property 4=Default");
    // Keys the order doesn't know follow, sorted.
    expect(variantName({ ...props, B: "1", A: "2" }, ["Size", "State", "Icon"])).toBe("Size=S, State=Default, Icon=None, A=2, B=1");
  });
  it("without an order it is alphabetical, as the engine used to write it", () => {
    expect(variantName(props)).toBe("Icon=None, Size=S, State=Default");
  });
});

describe("orderedEntries", () => {
  it("lists entries in order and skips order keys the props lack", () => {
    expect(orderedEntries({ A: "1", C: "3" }, ["C", "B", "A"])).toEqual([
      ["C", "3"],
      ["A", "1"],
    ]);
  });
});
