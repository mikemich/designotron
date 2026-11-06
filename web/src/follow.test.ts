import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { addEventListener() {} };
});

// follow.ts only needs the collab and editor stores' shape for chat; the real modules reach for
// the browser (IndexedDB, location) at import.
vi.mock("./collab", async () => {
  const { create } = await import("zustand");
  return {
    useCollab: create(() => ({ status: "live", peers: { 2: { id: 2, name: "B", color: "#f00" } }, me: 1 })),
    sendPresence: () => {},
    setPresenceSource: () => {},
  };
});
vi.mock("./store", async () => {
  const { create } = await import("zustand");
  return {
    useStore: create(() => ({ es: {} })),
    canvasSize: () => ({ w: 0, h: 0 }),
    dispatch: () => {},
    getDoc: () => null,
    toast: () => {},
  };
});

import { CHAT_MS, closeCursorChat, openCursorChat, sendChatMessage, setChatText, useFollow } from "./follow";

describe("cursor chat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    closeCursorChat();
    vi.useRealTimers();
  });

  it("keeps the sent message up after Enter and clears it after CHAT_MS", () => {
    openCursorChat();
    setChatText("hello");
    expect(useFollow.getState().chat).toMatchObject({ text: "hello", shown: "hello" });
    sendChatMessage();
    // The draft is empty for the next message; everyone still sees the sent one.
    expect(useFollow.getState().chat).toMatchObject({ text: "", shown: "hello", open: true });
    vi.advanceTimersByTime(CHAT_MS - 50);
    expect(useFollow.getState().chat.shown).toBe("hello");
    vi.advanceTimersByTime(100);
    expect(useFollow.getState().chat).toMatchObject({ open: false, text: "", shown: "" });
  });

  it("typing replaces what is shown", () => {
    openCursorChat();
    setChatText("one");
    sendChatMessage();
    setChatText("two");
    expect(useFollow.getState().chat.shown).toBe("two");
  });

  it("Escape closes the bubble for everyone", () => {
    openCursorChat();
    setChatText("bye");
    closeCursorChat();
    expect(useFollow.getState().chat).toMatchObject({ open: false, shown: "" });
  });
});
