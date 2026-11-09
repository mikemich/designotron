import { describe, expect, it } from "vitest";
import type { VariableCollection } from "../types";
import { deleteImpact, impactMessage, isMissing, resolveValue } from "./variableImpact";

const v = (id: string, values: Record<string, unknown>) => ({ id, name: id, type: "color" as const, values, description: "" });
const colls = (): VariableCollection[] => [
  { id: "p", name: "Prim", modes: [{ id: "pm", name: "Base" }], variables: [v("ink", { pm: "#111111" }), v("paper", { pm: "#FAFAFA" })] },
  {
    id: "t",
    name: "Theme",
    modes: [
      { id: "l", name: "Light" },
      { id: "d", name: "Dark" },
    ],
    variables: [v("surface", { l: { alias: "paper" }, d: { alias: "ink" } }), v("edge", { l: "#00FF00", d: { alias: "gone" } }), v("loop", { l: { alias: "gone" }, d: { alias: "gone" } })],
  },
];

describe("resolveValue", () => {
  it("follows aliases across collections, per mode", () => {
    expect(resolveValue(colls(), "surface", "l")).toBe("#FAFAFA");
    expect(resolveValue(colls(), "surface", "d")).toBe("#111111");
  });

  it("shows the default mode for an alias whose target is gone", () => {
    expect(resolveValue(colls(), "edge", "d")).toBe("#00FF00");
    expect(resolveValue(colls(), "edge", "l")).toBe("#00FF00");
  });

  it("has nothing to show when the default mode dangles too, or the variable is unknown", () => {
    expect(resolveValue(colls(), "loop", "d")).toBeUndefined();
    expect(resolveValue(colls(), "nope", "d")).toBeUndefined();
  });

  it("falls back from a dangling Dark to a default mode that aliases a live variable", () => {
    const c = colls();
    c[1].variables.push(v("soft", { l: { alias: "paper" }, d: { alias: "gone" } }));
    expect(resolveValue(c, "soft", "d")).toBe("#FAFAFA");
  });

  it("knows which ids are missing", () => {
    expect(isMissing(colls(), "gone")).toBe(true);
    expect(isMissing(colls(), "ink")).toBe(false);
  });
});

describe("impact", () => {
  it("counts bound layers and aliases of what goes", () => {
    const nodes = { a: { bindings: { fill: "ink" } }, b: { bindings: {} }, c: {} };
    expect(deleteImpact(nodes, colls(), new Set(["ink"]))).toEqual({ layers: 1, aliases: 1 });
    expect(deleteImpact(nodes, colls(), new Set(["ink", "paper"]))).toEqual({ layers: 1, aliases: 2 });
    expect(deleteImpact(nodes, colls(), new Set(["edge"]))).toEqual({ layers: 0, aliases: 0 });
  });

  it("says what the aliases do now", () => {
    expect(impactMessage({ layers: 0, aliases: 1 }, "Ink")).toBe("1 alias now uses Ink's value.");
    expect(impactMessage({ layers: 3, aliases: 2 }, "Ink")).toBe("3 layers keep their current value; 2 aliases now use Ink's value.");
    expect(impactMessage({ layers: 1, aliases: 2 })).toBe("1 layer keeps its current value; 2 aliases now use their deleted variable's value.");
    expect(impactMessage({ layers: 0, aliases: 1 })).toBe("1 alias now uses its deleted variable's value.");
    expect(impactMessage({ layers: 0, aliases: 0 })).toBe("");
  });
});
