import { describe, expect, it } from "vitest";
import { folderSize, groupBySlash, renameFolder } from "./groupBySlash";

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

describe("renameFolder", () => {
  const list = ["Brand/Primary/500", "Brand/Primary/600", "Brand/Danger", "Brand", "Neutral/Ink"];

  it("renames the prefix of every item inside, nested folders too", () => {
    const r = renameFolder(list, "Brand", "Accent");
    expect(r.collision).toBeNull();
    expect(r.renames).toEqual([
      { index: 0, name: "Accent/Primary/500" },
      { index: 1, name: "Accent/Primary/600" },
      { index: 2, name: "Accent/Danger" },
    ]);
    expect(renameFolder(list, "Brand/Primary", "Core/Blue").renames.map((x) => x.name)).toEqual(["Core/Blue/500", "Core/Blue/600"]);
  });

  it("leaves an item with the folder's own name and other folders alone", () => {
    expect(renameFolder(list, "Brand", "Accent").renames.some((x) => x.index === 3 || x.index === 4)).toBe(false);
  });

  it("refuses a clash with another item or between two new names", () => {
    expect(renameFolder(["A/x", "B/x"], "A", "B")).toEqual({ renames: [], collision: "B/x" });
    expect(renameFolder(["A/x", "B/X"], "A", "B").collision).toBe("B/x");
    expect(renameFolder(["A/x", "A/y"], "A", "A")).toEqual({ renames: [], collision: null });
    expect(renameFolder(["A/x"], "A", "  ").renames).toEqual([]);
  });

  it("reads names the way groupBySlash does", () => {
    expect(renameFolder([" A / x ", "A//y"], "A", "B").renames.map((r) => r.name)).toEqual(["B/x", "B/y"]);
  });
});
