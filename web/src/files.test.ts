// Storage fallback: when a failing write means "give up on IndexedDB", and how memory mode is
// copied back without touching what another tab stored meanwhile.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("./store", () => ({
  bootEngine: async () => {},
  documentLoads: async (json: string) => !json.includes("onTeleport"),
  toast: mocks.toast,
}));
vi.mock("./wasm/pkg/designotron_engine_wasm", () => ({
  WasmEngine: class {
    load(json: string) {
      if (json.includes("onTeleport")) throw new Error("unknown variant `onTeleport`, expected one of `onClick`");
    }
    free() {}
  },
}));
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

describe("storage that the browser refuses", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("loads when indexedDB.open throws, works in memory, and the probe recovers", async () => {
    const open = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.resetModules();
    const files = await import("./files");
    await files.saveFile("m1", "Mem", DOC("Mem"));
    expect((await files.listFiles()).map((f) => f.id)).toContain("m1");
    expect(files.persistentStorage()).toBe(false);
    open.mockRestore();
    expect(await files.probeStorage()).toBe(true);
    expect(files.persistentStorage()).toBe(true);
    expect(await raw("dt:file:m1")).toBeTruthy();
  });

  it("recovers after an open that fails asynchronously (onerror)", async () => {
    const real = indexedDB.open.bind(indexedDB);
    let opens = 0;
    vi.spyOn(indexedDB, "open").mockImplementation((...a: Parameters<typeof real>) => {
      if (opens++ >= 2) return real(...a);
      const req: Partial<IDBOpenDBRequest> = {};
      setTimeout(() => (req.onerror as (() => void) | null | undefined)?.call(req as IDBOpenDBRequest), 0);
      return req as IDBOpenDBRequest;
    });
    vi.resetModules();
    const files = await import("./files");
    await files.saveFile("m2", "Mem", DOC("Mem"));
    expect(files.persistentStorage()).toBe(false);
    // The first probe's open fails too; the failed store is forgotten, so the second one opens again.
    expect(await files.probeStorage()).toBe(false);
    expect(await files.probeStorage()).toBe(true);
    expect(await raw("dt:file:m2")).toBeTruthy();
  });
});

describe("importing a .dtron", () => {
  const wrap = (version: number, doc: object) => JSON.stringify({ format: "designotron", version, document: doc, assets: {} });
  const base = { name: "Imp", schema: 1, pages: [{ id: "p", name: "Page 1", children: [] }], nodes: {} };
  beforeEach(() => mocks.toast.mockClear());

  it("opens a newer file that loads, with a warning", async () => {
    const files = await fresh();
    const id = await files.importDtron(wrap(99, base), "x");
    expect(await files.loadFile(id)).toBeTruthy();
    expect(mocks.toast.mock.calls[0][0]).toMatch(/newer version/);
  });

  it("refuses a newer file it can't read as 'newer', not 'damaged'", async () => {
    const files = await fresh();
    await expect(files.importDtron(wrap(99, { ...base, trigger: "onTeleport" }), "x")).rejects.toThrow(/newer version/);
    // Even without a version bump: the engine's own "unknown variant" says so.
    await expect(files.importDtron(wrap(1, { ...base, trigger: "onTeleport" }), "x")).rejects.toThrow(/newer version/);
    await expect(files.importDtron("{}", "x")).rejects.toThrow(/Designotron file/);
  });

  it("makes a new copy each time and says when the name exists", async () => {
    const files = await fresh();
    const a = await files.importDtron(wrap(1, base), "x");
    expect(mocks.toast).not.toHaveBeenCalled();
    const b = await files.importDtron(wrap(1, base), "x");
    expect(b).not.toBe(a);
    expect(mocks.toast.mock.calls[0][0]).toContain("you already have");
  });
});
