import { describe, expect, it } from "vitest";
import {
  FolderGoneError,
  ancestors,
  applyCreateFolder,
  applyDeleteFolder,
  applyMoveFiles,
  applyMoveFolder,
  canMoveFolder,
  childrenOf,
  deleteSummary,
  nameWasCut,
  normalizeName,
  pathLabel,
  resolveFolder,
  sanitizeFolders,
  uniqueName,
  upsertEntry,
  type FileMeta,
  type Folder,
} from "./folders";

const F = (id: string, parent: string | null, name = id): Folder => ({ id, name, parent, createdAt: 1 });
const file = (id: string, folder?: string): FileMeta => ({ id, name: id, updatedAt: 1, ...(folder ? { folder } : {}) });
// Acme > Marketing > Q4, and a second project Beta.
const tree = [F("acme", null, "Acme"), F("mkt", "acme", "Marketing"), F("q4", "mkt", "Q4"), F("beta", null, "Beta")];

describe("sanitizeFolders", () => {
  it("reads nothing as empty and drops junk records", () => {
    expect(sanitizeFolders(undefined)).toEqual([]);
    expect(sanitizeFolders({ v: 1, folders: [null, 3, { id: 1 }, { id: "a" }, { id: "b", name: "B" }, { id: "b", name: "dup" }] }).map((f) => f.id)).toEqual(["b"]);
  });
  it("makes a dangling parent a project", () => {
    const out = sanitizeFolders({ v: 1, folders: [{ id: "a", name: "A", parent: "nope", createdAt: 1 }] });
    expect(out[0].parent).toBeNull();
  });
  it("breaks self-parents and 2-cycles into roots", () => {
    const out = sanitizeFolders({
      v: 1,
      folders: [
        { id: "s", name: "S", parent: "s", createdAt: 1 },
        { id: "a", name: "A", parent: "b", createdAt: 1 },
        { id: "b", name: "B", parent: "a", createdAt: 1 },
      ],
    });
    expect(out.find((f) => f.id === "s")!.parent).toBeNull();
    // Every folder reaches a root.
    for (const f of out) expect(ancestors(out, f.id)[0].parent).toBeNull();
  });
});

describe("canMoveFolder", () => {
  it("refuses itself, a child and a grandchild", () => {
    expect(canMoveFolder(tree, "acme", "acme")).toBe(false);
    expect(canMoveFolder(tree, "acme", "mkt")).toBe(false);
    expect(canMoveFolder(tree, "acme", "q4")).toBe(false);
    expect(canMoveFolder(tree, "mkt", "q4")).toBe(false);
  });
  it("allows a sibling project and the root", () => {
    expect(canMoveFolder(tree, "mkt", "beta")).toBe(true);
    expect(canMoveFolder(tree, "q4", null)).toBe(true);
    expect(canMoveFolder(tree, "acme", "beta")).toBe(true);
  });
});

describe("ancestors and pathLabel", () => {
  it("walk up in order", () => {
    expect(ancestors(tree, "q4").map((f) => f.id)).toEqual(["acme", "mkt", "q4"]);
    expect(pathLabel(tree, "q4")).toBe("Acme / Marketing / Q4");
    expect(pathLabel(tree, undefined)).toBe("Drafts");
    expect(pathLabel(tree, "gone")).toBe("Drafts");
  });
  it("stay safe on cyclic input", () => {
    const loop = [F("a", "b"), F("b", "a")];
    expect(ancestors(loop, "a").length).toBeLessThanOrEqual(2);
    expect(() => pathLabel(loop, "a")).not.toThrow();
    expect(canMoveFolder(loop, "a", "b")).toBe(false);
  });
});

describe("applyDeleteFolder", () => {
  const files = [file("1", "acme"), file("2", "q4"), file("3", "beta"), file("4"), file("5", "mkt")];
  it("removes the subtree and sends its files to Drafts", () => {
    const r = applyDeleteFolder(tree, files, "acme");
    expect(r.folders.map((f) => f.id)).toEqual(["beta"]);
    expect(r.moved).toBe(3);
    expect(r.removed).toBe(3);
    expect(r.files.map((f) => f.folder)).toEqual([undefined, undefined, "beta", undefined, undefined]);
    expect(r.files).toHaveLength(5);
  });
  it("leaves other files alone", () => {
    const r = applyDeleteFolder(tree, files, "q4");
    expect(r.files.find((f) => f.id === "5")!.folder).toBe("mkt");
    expect(r.moved).toBe(1);
  });
  it("describes what will happen", () => {
    expect(deleteSummary(tree, files, "acme")).toBe("Delete “Acme” and 2 folders inside? 3 files will move to Drafts.");
    expect(deleteSummary(tree, files, "beta")).toBe("Delete “Beta”? 1 file will move to Drafts.");
  });
});

describe("moves", () => {
  it("applyMoveFiles to a missing folder throws", () => {
    expect(() => applyMoveFiles(tree, [file("1")], ["1"], "gone")).toThrow(FolderGoneError);
  });
  it("moves files in and back to Drafts", () => {
    const a = applyMoveFiles(tree, [file("1"), file("2")], ["1"], "q4");
    expect(a.map((f) => f.folder)).toEqual(["q4", undefined]);
    expect(applyMoveFiles(tree, a, ["1"], undefined)[0]).not.toHaveProperty("folder");
  });
  it("applyMoveFolder refuses cycles and missing targets", () => {
    expect(() => applyMoveFolder(tree, "acme", "q4")).toThrow();
    expect(() => applyMoveFolder(tree, "mkt", "gone")).toThrow(FolderGoneError);
    expect(applyMoveFolder(tree, "mkt", "beta").find((f) => f.id === "mkt")!.parent).toBe("beta");
  });
  it("applyCreateFolder refuses a missing parent", () => {
    expect(() => applyCreateFolder(tree, "gone", "X")).toThrow(FolderGoneError);
    expect(applyCreateFolder(tree, "beta", "  X  ").folder).toMatchObject({ name: "X", parent: "beta" });
  });
});

describe("upsertEntry", () => {
  const idx: FileMeta[] = [{ id: "a", name: "A", updatedAt: 1, thumbnail: "t", folder: "q4" }, file("b")];
  it("keeps folder and thumbnail when name and date change", () => {
    const next = upsertEntry(idx, { id: "a", name: "A2", updatedAt: 5, thumbnail: undefined });
    expect(next.find((f) => f.id === "a")).toEqual({ id: "a", name: "A2", updatedAt: 5, thumbnail: "t", folder: "q4" });
    expect(next).toHaveLength(2);
  });
  it("ignores the folder argument for an existing entry", () => {
    expect(upsertEntry(idx, { id: "a", name: "A", updatedAt: 2 }, "beta").find((f) => f.id === "a")!.folder).toBe("q4");
  });
  it("adds a new entry with the given folder", () => {
    expect(upsertEntry(idx, { id: "n", name: "N", updatedAt: 2 }, "beta").find((f) => f.id === "n")).toEqual({ id: "n", name: "N", updatedAt: 2, folder: "beta" });
    expect(upsertEntry(idx, { id: "n", name: "N", updatedAt: 2 }).find((f) => f.id === "n")).not.toHaveProperty("folder");
  });
  it("keeps unknown fields", () => {
    const withExtra = [{ id: "a", name: "A", updatedAt: 1, future: 1 } as FileMeta];
    expect(upsertEntry(withExtra, { id: "a", name: "B", updatedAt: 2 })[0]).toHaveProperty("future", 1);
  });
});

describe("names", () => {
  it("normalizeName trims, collapses, strips controls and caps", () => {
    expect(normalizeName("  a \t b\n")).toBe("a b");
    expect(normalizeName("a\u0000b")).toBe("a b");
    expect(normalizeName("   ")).toBe("");
    expect(normalizeName("x".repeat(200))).toHaveLength(80);
  });
  it("normalizeName cuts by grapheme and never leaves a lone surrogate", () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const a = normalizeName("a".repeat(79) + "\u{1F600}" + "tail");
    expect(a).toBe("a".repeat(79) + "\u{1F600}");
    expect(lone.test(a)).toBe(false);
    const b = normalizeName("a".repeat(80) + "\u{1F600}");
    expect(b).toBe("a".repeat(80));
    expect(lone.test(b)).toBe(false);
  });
  it("normalizeName keeps or drops a ZWJ family whole at the boundary", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    expect(family.length).toBe(11);
    expect(normalizeName("a".repeat(79) + family + "z")).toBe("a".repeat(79) + family);
    expect(normalizeName("a".repeat(80) + family)).toBe("a".repeat(80));
  });
  it("nameWasCut tells when a name was shortened", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    expect(nameWasCut("short")).toBe(false);
    expect(nameWasCut("x".repeat(80))).toBe(false);
    expect(nameWasCut("x".repeat(81))).toBe(true);
    expect(nameWasCut("a".repeat(70) + family.repeat(5))).toBe(false);
    expect(nameWasCut("  " + "x".repeat(80) + "  ")).toBe(false);
  });
  it("uniqueName numbers duplicates", () => {
    expect(uniqueName([], "New folder")).toBe("New folder");
    expect(uniqueName(["New folder"], "New folder")).toBe("New folder 2");
    expect(uniqueName(["New folder", "new folder 2"], "New folder")).toBe("New folder 3");
  });
  it("childrenOf sorts by name, numerically", () => {
    const l = [F("a", null, "Item 10"), F("b", null, "item 2"), F("c", null, "Alpha")];
    expect(childrenOf(l, null).map((f) => f.name)).toEqual(["Alpha", "item 2", "Item 10"]);
  });
});

describe("resolveFolder", () => {
  it("treats an orphan id as Drafts", () => {
    expect(resolveFolder(tree, "q4")).toBe("q4");
    expect(resolveFolder(tree, "gone")).toBeUndefined();
    expect(resolveFolder(tree, undefined)).toBeUndefined();
  });
});
