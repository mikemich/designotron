// Pure pieces of the chat's file binding: how the page tells a bridge from other servers, and
// that a bad file in a drop doesn't take the good ones with it.
import { describe, expect, it, vi } from "vitest";

vi.mock("../store", () => ({ getEngine: () => ({}), onDocChange: () => {} }));
vi.mock("./tools", () => ({ DRAG_BUSY: "", LEFT_FILE: "", executeTool: async () => ({}), whenCanvasIdle: async () => true }));
vi.mock("./chatState", () => ({ appendText: () => {}, connectionLost: () => {}, patchItem: () => {}, push: () => {}, resumeFailed: () => false, showScreenshot: () => {}, useChat: { setState: () => {}, getState: () => ({}) } }));
vi.mock("./preview", () => ({ onPreviewMessage: () => {} }));

import { settleImages } from "./images";

// The client reads `location` and `window` when it loads.
vi.stubGlobal("location", { hostname: "example.test", protocol: "http:", host: "example.test", origin: "http://example.test" });
const { bridgeAnswer } = await import("./bridgeClient");

describe("bridgeAnswer", () => {
  it("a 5xx is no answer (a dev server whose proxy found the bridge down)", () => {
    expect(bridgeAnswer(500, "text/plain", null)).toBe("unknown");
    expect(bridgeAnswer(502, "", null)).toBe("unknown");
  });
  it("a bridge answers with its name", () => {
    expect(bridgeAnswer(200, "application/json", { name: "designotron-bridge" })).toBe("bridge");
  });
  it("anything else that answered is final: not a bridge", () => {
    expect(bridgeAnswer(404, "text/plain", null)).toBe("other");
    expect(bridgeAnswer(200, "text/html", null)).toBe("other");
    expect(bridgeAnswer(200, "application/json", { name: "something-else" })).toBe("other");
  });
});

describe("settleImages", () => {
  it("keeps the readable files and reports the others by name", async () => {
    const files = [{ name: "good.png" }, { name: "bad.png" }, { name: "" }];
    const out = await settleImages(files, async (f) => {
      if (f.name === "bad.png") throw new Error("could not load the image");
      return `data:image/png;base64,${f.name || "pasted"}`;
    });
    expect(out.images.map((i) => i.name)).toEqual(["good.png", "pasted image"]);
    expect(out.errors).toEqual(["Couldn't read “bad.png” as an image."]);
  });
});
