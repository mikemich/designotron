// Storage fallback: when a failing write means "give up on IndexedDB", and how memory mode is
// copied back without touching what another tab stored meanwhile.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({ documentLoads: async () => true, toast: () => {} }));
vi.mock("./assets", () => ({
  allAssets: () => ({}),
  assetDataUrl: () => null,
  loadAssets: () => {},
  referencedAssets: () => [],
}));

const DOC = (name: string) => JSON.stringify({ name, pages: [{ id: "p", name: "Page 1", children: [] }], nodes: {} });

/** Every put throws as it is queued (what Safari does on a full disk) while `on`. */
function failPuts() {
  const put = IDBObjectStore.prototype.put;
  let on = true;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...a: Parameters<IDBObjectStore["put"]>) {
    if (on) throw new DOMException("Not enough space on the disk", "QuotaExceededError");
    return put.apply(this, a);
  };
  return {
    off() {
      on = false;
    },
    restore() {
      IDBObjectStore.prototype.put = put;
    },
  };
}

/** A fresh module (its storage state starts over) on an empty database. */
async function fresh() {
  const { clear } = await import("idb-keyval");
  await clear();
  vi.resetModules();
  return import("./files");
}

/** Another tab writing straight to the database. */
async function otherTab(key: string, value: unknown) {
  const { set } = await import("idb-keyval");
  await set(key, value);
}
async function raw(key: string) {
  const { get } = await import("idb-keyval");
  return get(key);
}

describe("falling back to memory", () => {
  beforeEach(() => vi.useRealTimers());

  it("keeps failing loudly once a record has been read (quota on a file that exists)", async () => {
    const files = await fresh();
    await files.saveFile("f1", "One", DOC("One"));
    await files.listFiles(); // a read that returned data
    const f = failPuts();
    try {
      await expect(files.saveFile("f1", "One", DOC("One v2"))).rejects.toBeInstanceOf(DOMException);
      expect(files.persistentStorage()).toBe(true);
    } finally {
      f.restore();
    }
  });

  it("gives up on a store that was never read or written, then the probe brings it back", async () => {
    const files = await fresh();
    const f = failPuts();
    await files.saveFile("f1", "One", DOC("One"));
    expect(files.persistentStorage()).toBe(false);
    // Meanwhile another tab stores a file, a folder and a record under a key this tab also wrote.
    f.off();
    await otherTab("dt:index", [{ id: "other", name: "Other", updatedAt: 5 }]);
    await otherTab("dt:folders", { v: 1, folders: [{ id: "fo1", name: "Theirs", parent: null }] });
    await otherTab("dt:file:other", { doc: DOC("Other"), assets: {} });
    f.off();
    f.restore();
    let back = 0;
    files.onStorageBack(() => back++);
    expect(await files.probeStorage()).toBe(true);
    expect(files.persistentStorage()).toBe(true);
    expect(back).toBe(1);
    const index = (await raw("dt:index")) as { id: string }[];
    expect(index.map((x) => x.id).sort()).toEqual(["f1", "other"]);
    expect((await raw("dt:folders")) as { folders: { id: string }[] }).toMatchObject({ folders: [{ id: "fo1" }] });
    expect(await raw("dt:file:f1")).toBeTruthy();
    expect(await raw("dt:file:other")).toMatchObject({ doc: DOC("Other") });
  });

  it("never overwrites a record another tab stored under the same key, and doesn't list that file", async () => {
    const files = await fresh();
    const f = failPuts();
    await files.saveFile("same", "Mine", DOC("Mine"));
    f.off();
    await otherTab("dt:file:same", { doc: DOC("Theirs"), assets: {} });
    f.off();
    f.restore();
    expect(await files.probeStorage()).toBe(true);
    expect(await raw("dt:file:same")).toMatchObject({ doc: DOC("Theirs") });
    const index = ((await raw("dt:index")) as { id: string }[] | undefined) ?? [];
    expect(index.some((x) => x.id === "same")).toBe(false);
  });

  it("probes again when something was written during the copy, and reads keep the probe going", async () => {
    const files = await fresh();
    const f = failPuts();
    await files.saveFile("a", "A", DOC("A"));
    f.off();
    f.restore();
    // A write lands while the probe is awaiting storage.
    const probing = files.probeStorage();
    await files.saveFile("b", "B", DOC("B")).catch(() => {});
    expect(await probing).toBe(true);
    const index = (await raw("dt:index")) as { id: string }[];
    expect(index.map((x) => x.id)).toContain("a");
    // (Whether "b" was copied or written directly, it is stored.)
    expect(await raw("dt:file:b")).toBeTruthy();
  });
});

describe("duplicating a file", () => {
  it("gives the copy a new document id and keeps the folder", async () => {
    const files = await fresh();
    const doc = JSON.stringify({ id: "d_orig", name: "One", pages: [{ id: "p", name: "Page 1", children: [] }], nodes: {} });
    await files.saveFile("f1", "One", doc, { folder: "fo1" });
    const nid = await files.duplicateFile("f1");
    expect(nid).toBeTruthy();
    const copy = JSON.parse((await files.loadFile(nid!))!);
    expect(copy.id).toMatch(/^d_/);
    expect(copy.id).not.toBe("d_orig");
    expect(copy.name).toBe("One (copy)");
    expect((await files.getFileMeta(nid!))?.folder).toBe("fo1");
    // The original is untouched.
    expect(JSON.parse((await files.loadFile("f1"))!).id).toBe("d_orig");
  });
});
