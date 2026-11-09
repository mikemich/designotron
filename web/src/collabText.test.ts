import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { addEventListener() {} };
});

// collab.ts reaches for the browser through these at import; presence cleaning needs none of it.
vi.mock("./store", async () => {
  const { create } = await import("zustand");
  return { useStore: create(() => ({ es: {} })), dispatch: () => {}, getDoc: () => null, getEngine: () => ({}), newEngine: () => {}, noteForeignChange: () => {}, onDocChange: () => () => {}, toast: () => {}, zoomToFit: () => {} };
});
vi.mock("./files", () => ({ deleteFile: () => {}, newFileId: () => "f", saveFile: () => {} }));
vi.mock("./assets", () => ({ allAssets: () => ({}), loadAssets: () => {}, referencedAssets: () => [] }));
vi.mock("./ai/bridgeClient", () => ({ bridgeChecked: () => {}, bridgeHttpBase: () => "" }));
vi.mock("./errors", () => ({ reportFailure: () => {} }));
vi.mock("./relayHost", () => ({ linkFor: () => "" }));
vi.mock("./canvas/Comments", () => ({ userName: () => "me" }));

import { cleanPresence } from "./collab";

const base = { page: "p", cursor: null, selection: [] };

describe("presence text", () => {
  it("keeps a well-formed caret", () => {
    expect(cleanPresence({ ...base, text: { id: "n_1", a: [12, 3], f: null } })?.text).toEqual({ id: "n_1", a: [12, 3], f: null });
    expect(cleanPresence({ ...base, text: { id: "n_1", a: null, f: [0, 0] } })?.text).toEqual({ id: "n_1", a: null, f: [0, 0] });
  });
  it("drops anything malformed", () => {
    const bad = [
      { id: "n", a: [1], f: null },
      { id: "n", a: [-1, 0], f: null },
      { id: "n", a: [1.5, 0], f: null },
      { id: "n", a: [2 ** 53, 0], f: null },
      { id: "n", a: [2 ** 48, 0], f: null },
      { id: "n", a: [1, 2 ** 32], f: null },
      { id: "n", a: ["1", 0], f: null },
      { id: "n", a: [1, 2, 3], f: null },
      { id: "n", a: undefined, f: null },
      { id: "n", a: null },
      { id: 5, a: null, f: null },
      { id: "x".repeat(101), a: null, f: null },
      "text",
      [],
    ];
    for (const t of bad) expect(cleanPresence({ ...base, text: t })?.text, JSON.stringify(t)).toBeUndefined();
  });
  it("leaves the rest of the presence alone", () => {
    const p = cleanPresence({ page: "p", cursor: { x: 1, y: 2 }, selection: ["a"], text: { id: "n", a: null, f: null } });
    expect(p?.cursor).toEqual({ x: 1, y: 2 });
    expect(p?.selection).toEqual(["a"]);
  });
});
