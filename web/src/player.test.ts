import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { addEventListener() {} };
});

// player.ts reaches the engine through the store, which needs the browser at import.
vi.mock("./store", () => ({ getDoc: () => null, getEngine: () => null, toast: () => {} }));

import { canAct } from "./player";
import type { Doc, Interaction } from "./types";

const doc = { nodes: { screen2: {}, overlay: {} } } as unknown as Doc;
const ia = (p: Partial<Interaction>) => ({ trigger: "onClick", action: "navigate", destination: null, url: null, ...p }) as Interaction;

describe("canAct", () => {
  it("needs an existing destination for the actions that go somewhere", () => {
    for (const action of ["navigate", "openOverlay", "swapOverlay", "scrollTo", "changeTo"] as const) {
      expect(canAct(ia({ action, destination: null }), doc)).toBe(false);
      expect(canAct(ia({ action, destination: "gone" }), doc)).toBe(false);
      expect(canAct(ia({ action, destination: "screen2" }), doc)).toBe(true);
    }
  });
  it("needs a non-empty URL to open one", () => {
    expect(canAct(ia({ action: "openUrl", url: null }), doc)).toBe(false);
    expect(canAct(ia({ action: "openUrl", url: "  " }), doc)).toBe(false);
    expect(canAct(ia({ action: "openUrl", url: "https://example.com" }), doc)).toBe(true);
  });
  it("lets back and close always act", () => {
    expect(canAct(ia({ action: "back" }), doc)).toBe(true);
    expect(canAct(ia({ action: "closeOverlay" }), doc)).toBe(true);
  });
});
