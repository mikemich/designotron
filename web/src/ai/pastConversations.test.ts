// Past conversations: what New conversation archives, the caps, titles and the storage round trip.
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_BYTES,
  MAX_PAST,
  MAX_PAST_BYTES,
  TITLE_CHARS,
  addPast,
  chatsKey,
  conversationTitle,
  cutAtWord,
  dropConversation,
  loadConversation,
  loadPast,
  readPast,
  relativeDate,
  saveConversation,
  savePast,
  serialize,
  updatePast,
  worthArchiving,
  type AnyItem,
  type PastConversation,
} from "./conversations";

const user = (id: number, text: string): AnyItem => ({ id, kind: "user", text });
const rec = (text: string) => serialize([user(1, text), { id: 2, kind: "assistant", text: "done" }], "sess");

describe("past conversations", () => {
  it("titles a conversation with its first message, cut at a word", () => {
    expect(conversationTitle(rec("make a card"))).toBe("make a card");
    const long = "Design a mobile onboarding flow for a meditation app with three screens and a paywall";
    const t = conversationTitle(rec(long));
    expect(t.length).toBeLessThanOrEqual(TITLE_CHARS + 1);
    expect(t.endsWith("…")).toBe(true);
    // Cut between words: what is left is a prefix of the message ending at a word end.
    const kept = t.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(" ");
    expect(conversationTitle({ items: [] })).toBe("Conversation");
    expect(cutAtWord("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghij…");
  });

  it("puts the newest first and keeps at most 20", () => {
    let list: PastConversation[] = [];
    for (let i = 0; i < 25; i++) list = addPast(list, rec(`talk ${i}`), `id${i}`, i);
    expect(list).toHaveLength(MAX_PAST);
    expect(list[0].id).toBe("id24");
    expect(list[MAX_PAST - 1].id).toBe("id5");
  });

  it("drops the oldest when the list is over its byte cap, but keeps the newest", () => {
    const big = "z".repeat(MAX_BYTES - 2000);
    let list: PastConversation[] = [];
    for (let i = 0; i < 8; i++) list = addPast(list, serialize([user(1, `${i}${big}`)], null), `b${i}`, i);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(MAX_PAST_BYTES);
    expect(list.length).toBeLessThan(8);
    expect(list[0].id).toBe("b7");
  });

  it("only archives a conversation that has messages", () => {
    expect(worthArchiving(serialize([], "s", "draft"))).toBe(false);
    expect(worthArchiving(rec("hi"))).toBe(true);
  });

  it("round trips through storage, and dropping the file clears both keys", async () => {
    await saveConversation("fp", rec("current"));
    await updatePast("fp", (l) => addPast(l, rec("first"), "p1", 1));
    await updatePast("fp", (l) => addPast(l, rec("second"), "p2", 2));
    expect((await loadPast("fp")).map((e) => e.title)).toEqual(["second", "first"]);
    await updatePast("fp", (l) => l.filter((e) => e.id !== "p2"));
    expect((await loadPast("fp")).map((e) => e.id)).toEqual(["p1"]);
    expect(chatsKey("fp")).toBe("dt:chats:fp");
    await dropConversation("fp");
    expect(await loadPast("fp")).toEqual([]);
    expect(await loadConversation("fp")).toBeNull();
  });

  it("two tabs adding at once keep both entries", async () => {
    await Promise.all([updatePast("ft", (l) => addPast(l, rec("tab one"), "t1", 1)), updatePast("ft", (l) => addPast(l, rec("tab two"), "t2", 2))]);
    expect((await loadPast("ft")).map((e) => e.id).sort()).toEqual(["t1", "t2"]);
    await updatePast("ft", () => []);
    expect(await loadPast("ft")).toEqual([]);
  });

  it("ignores malformed lists and never throws when storage fails", async () => {
    expect(readPast({ v: 2, list: [] })).toEqual([]);
    expect(readPast({ v: 1, list: [null, { id: 1 }, { id: "a", title: "t", savedAt: 1, record: rec("x") }] })).toHaveLength(1);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = vi.fn(() => {
      throw new Error("quota");
    });
    try {
      await expect(savePast("fq", addPast([], rec("x"), "q"))).resolves.toBeUndefined();
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  });

  it("words a date for people", () => {
    const now = Date.UTC(2026, 5, 10, 12);
    expect(relativeDate(now - 5_000, now)).toBe("just now");
    expect(relativeDate(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(relativeDate(now - 3 * 3600_000, now)).toBe("3 hours ago");
    expect(relativeDate(now - 30 * 3600_000, now)).toBe("yesterday");
    expect(relativeDate(now - 3 * 86400_000, now)).toBe("3 days ago");
  });
});
