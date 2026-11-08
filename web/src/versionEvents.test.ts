import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChannel {
  static all: FakeChannel[] = [];
  posted: unknown[] = [];
  handlers: ((e: { data: unknown }) => void)[] = [];
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  addEventListener(_t: string, h: (e: { data: unknown }) => void) {
    this.handlers.push(h);
  }
}

async function load() {
  vi.resetModules();
  return import("./versionEvents");
}

describe("versionEvents", () => {
  beforeEach(() => {
    FakeChannel.all = [];
    vi.stubGlobal("BroadcastChannel", FakeChannel);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("delivers in this tab to the matching file only", async () => {
    const { notifyVersions, onVersionsChange } = await load();
    const a = vi.fn();
    const b = vi.fn();
    onVersionsChange("f1", a);
    onVersionsChange("f2", b);
    notifyVersions("f1");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("stops after unsubscribe", async () => {
    const { notifyVersions, onVersionsChange } = await load();
    const a = vi.fn();
    const off = onVersionsChange("f1", a);
    off();
    notifyVersions("f1");
    expect(a).not.toHaveBeenCalled();
  });

  it("posts {fileId} on dt-versions, never dt-files", async () => {
    const { notifyVersions } = await load();
    notifyVersions("f1");
    expect(FakeChannel.all.map((c) => c.name)).toEqual(["dt-versions"]);
    expect(FakeChannel.all[0].posted).toEqual([{ fileId: "f1" }]);
  });

  it("delivers messages from other tabs, ignoring other files and junk", async () => {
    const { onVersionsChange } = await load();
    const a = vi.fn();
    onVersionsChange("f1", a);
    const h = FakeChannel.all[0].handlers[0];
    h({ data: { fileId: "f2" } });
    h({ data: null });
    h({ data: { fileId: 3 } });
    expect(a).not.toHaveBeenCalled();
    h({ data: { fileId: "f1" } });
    expect(a).toHaveBeenCalledTimes(1);
    // A message from another tab is not posted back out.
    expect(FakeChannel.all[0].posted).toEqual([]);
  });

  it("works without BroadcastChannel", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const { notifyVersions, onVersionsChange } = await load();
    const a = vi.fn();
    onVersionsChange("f1", a);
    notifyVersions("f1");
    expect(a).toHaveBeenCalledTimes(1);
  });
});

describe("nextVersionName", () => {
  it("is Version 1 when nothing is numbered", async () => {
    const { nextVersionName } = await load();
    expect(nextVersionName([])).toBe("Version 1");
    expect(nextVersionName([{ name: "Logo done" }, { name: "Automatic version" }])).toBe("Version 1");
  });
  it("is one more than the largest number, counting only exact names", async () => {
    const { nextVersionName } = await load();
    expect(nextVersionName([{ name: "Version 1" }, { name: "Version 7" }, { name: "Version 3" }])).toBe("Version 8");
    expect(nextVersionName([{ name: "Version 9 final" }, { name: "My Version 4" }, { name: "Version 2" }])).toBe("Version 3");
  });
});
