// Per-file Claude conversations: what is stored (no screenshots, images counted, capped), how it
// comes back (ids from 1) and the storage round trip.
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { MAX_BYTES, MAX_ITEMS, chatKey, dropConversation, loadConversation, restore, saveConversation, serialize, type AnyItem } from "./conversations";

const user = (id: number, text: string, images?: string[]): AnyItem => ({ id, kind: "user", text, ...(images ? { images } : {}) });

describe("serialize", () => {
  it("drops screenshots and keeps images as a count", () => {
    const rec = serialize(
      [user(1, "look", ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]), { id: 2, kind: "shot", url: "data:image/png;base64,CCCC", label: "x" }, { id: 3, kind: "assistant", text: "ok" }],
      "sess",
      "",
      1,
    );
    expect(rec.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(rec.items[0]).toMatchObject({ imageCount: 2 });
    expect(JSON.stringify(rec)).not.toContain("base64");
    expect(rec.sessionId).toBe("sess");
  });

  it("marks tool calls that never finished as interrupted", () => {
    const rec = serialize([{ id: 1, kind: "tool", name: "create_nodes", ok: null }], null);
    expect(rec.items[0]).toEqual({ id: 1, kind: "tool", name: "create_nodes", ok: false, detail: "Interrupted" });
  });

  it("keeps the last 200 items", () => {
    const items = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => user(i + 1, `m${i}`));
    const rec = serialize(items, null);
    expect(rec.items).toHaveLength(MAX_ITEMS);
    expect((rec.items[0] as { text: string }).text).toBe("m50");
  });

  it("stays under the size cap by dropping the oldest items", () => {
    const big = "x".repeat(20_000);
    const items = Array.from({ length: 100 }, (_, i) => user(i + 1, `${i}:${big}`));
    const rec = serialize(items, null);
    expect(JSON.stringify(rec).length).toBeLessThanOrEqual(MAX_BYTES);
    const last = rec.items[rec.items.length - 1] as { text: string };
    expect(last.text.startsWith("99:")).toBe(true);
    expect(rec.items.length).toBeGreaterThan(1);
  });

  it("cuts a single huge item instead of storing nothing", () => {
    const rec = serialize([{ id: 1, kind: "assistant", text: "y".repeat(MAX_BYTES * 2) }], null);
    expect(JSON.stringify(rec).length).toBeLessThanOrEqual(MAX_BYTES);
    expect(rec.items).toHaveLength(1);
  });
});

describe("restore", () => {
  it("renumbers ids from 1 and says the next free one", () => {
    const rec = serialize([user(40, "a"), { id: 41, kind: "tool", name: "t", ok: true }, { id: 90, kind: "assistant", text: "b" }], "s", "half typed");
    const back = restore(rec)!;
    expect(back.items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(back.nextId).toBe(4);
    expect(back.sessionId).toBe("s");
    expect(back.draft).toBe("half typed");
  });

  it("says how many images a message had", () => {
    const back = restore(serialize([user(1, "see", ["data:image/png;base64,AA"])], null))!;
    expect((back.items[0] as { text: string }).text).toBe("see\n(1 image attached, not kept)");
  });

  it("refuses anything that isn't a record", () => {
    expect(restore(null)).toBeNull();
    expect(restore({ v: 2, items: [] })).toBeNull();
    expect(restore({ v: 1, items: "no" })).toBeNull();
    expect(restore({ v: 1, items: [null, { kind: "user" }, { kind: "tool" }, { id: 1, kind: "system", text: "ok" }] })!.items).toHaveLength(1);
  });
});

describe("storage", () => {
  it("round trips a conversation per file and an empty one removes the record", async () => {
    const a = serialize([user(1, "in A")], "sa");
    await saveConversation("fa", a);
    await saveConversation("fb", serialize([user(1, "in B")], "sb"));
    expect((await loadConversation("fa"))!.sessionId).toBe("sa");
    expect(((await loadConversation("fb"))!.items[0] as { text: string }).text).toBe("in B");
    await saveConversation("fa", serialize([], null));
    expect(await loadConversation("fa")).toBeNull();
    await dropConversation("fb");
    expect(await loadConversation("fb")).toBeNull();
    expect(chatKey("fb")).toBe("dt:chat:fb");
  });

  it("never throws when storage fails", async () => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = vi.fn(() => {
      throw new Error("quota");
    });
    try {
      await expect(saveConversation("fz", serialize([user(1, "x")], null))).resolves.toBeUndefined();
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  });
});
