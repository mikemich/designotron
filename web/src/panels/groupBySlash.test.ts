import { describe, expect, it } from "vitest";
import { folderSize, groupBySlash } from "./groupBySlash";

const names = (xs: string[]) => groupBySlash(xs, (x) => x);

describe("groupBySlash", () => {
  it("puts names without a slash at the root, in order", () => {
    const t = names(["b", "a", "c"]);
    expect(t.folders).toEqual([]);
    expect(t.items.map((e) => e.label)).toEqual(["b", "a", "c"]);
  });

  it("nests folders and labels items by their last segment", () => {
    const t = names(["Brand/Primary/500", "Brand/Primary/600", "Brand/Accent", "Text/Body"]);
    expect(t.items).toEqual([]);
    expect(t.folders.map((f) => f.path)).toEqual(["Brand", "Text"]);
    const brand = t.folders[0];
    expect(brand.items.map((e) => e.label)).toEqual(["Accent"]);
    expect(brand.folders[0].path).toBe("Brand/Primary");
    expect(brand.folders[0].items.map((e) => [e.label, e.item])).toEqual([
      ["500", "Brand/Primary/500"],
      ["600", "Brand/Primary/600"],
    ]);
    expect(folderSize(brand)).toBe(3);
  });

  it("keeps first-appearance order for folders and mixes root items in", () => {
    const t = names(["Z/one", "loose", "A/two", "Z/three"]);
    expect(t.folders.map((f) => f.name)).toEqual(["Z", "A"]);
    expect(t.folders[0].items.map((e) => e.label)).toEqual(["one", "three"]);
    expect(t.items.map((e) => e.label)).toEqual(["loose"]);
  });

  it("treats empty segments and stray spaces sensibly", () => {
    const t = names(["/lead", "trail/", "Brand / Primary", "//", ""]);
    expect(t.items.map((e) => e.label)).toEqual(["lead", "trail", "//", ""]);
    expect(t.folders[0].path).toBe("Brand");
    expect(t.folders[0].items[0].label).toBe("Primary");
  });

  it("keeps an item that is also a folder name", () => {
    const t = names(["Brand", "Brand/Primary"]);
    expect(t.items.map((e) => e.label)).toEqual(["Brand"]);
    expect(t.folders[0].items.map((e) => e.label)).toEqual(["Primary"]);
  });

  it("works on objects through the name accessor", () => {
    const t = groupBySlash(
      [
        { name: "A/x", id: 1 },
        { name: "A/y", id: 2 },
      ],
      (o) => o.name,
    );
    expect(t.folders[0].items.map((e) => e.item.id)).toEqual([1, 2]);
  });
});
