import { afterEach, describe, expect, it, vi } from "vitest";
import { paintAriaLabel, paintLabel } from "./ui/paintText";
import { sliderKey, type Hsva } from "./ui/sliderKeys";
import { pluginDirty } from "./panels/pluginDirty";
import { linkFor } from "./relayHost";
import { isPhone, PHONE_QUERY } from "./panelState";
import type { Paint } from "./types";

const solid = (color: string, opacity = 1, visible = true): Paint => ({ type: "solid", color, opacity, visible });

describe("paint labels", () => {
  it("says solid colours with their hex and opacity", () => {
    expect(paintAriaLabel(solid("#3366ff"))).toBe("Solid #3366FF, 100%");
    expect(paintAriaLabel(solid("#3366FF80", 0.5))).toBe("Solid #3366FF, 50%");
    expect(paintAriaLabel(solid("#000000", 1, false))).toBe("Solid #000000, 100%, hidden");
  });
  it("names gradients by kind and images by scale mode", () => {
    const stops = [{ color: "#000000", position: 0 }, { color: "#FFFFFF", position: 1 }];
    expect(paintAriaLabel({ type: "linearGradient", angle: 0, stops, opacity: 1, visible: true })).toBe("Linear gradient");
    expect(paintAriaLabel({ type: "diamondGradient", stops, opacity: 1, visible: true })).toBe("Diamond gradient");
    expect(paintAriaLabel({ type: "image", src: "", scaleMode: "fill", opacity: 1, visible: true })).toBe("Image (Fill)");
    expect(paintLabel(solid("#3366ff"))).toBe("3366ff");
  });
});

describe("colour slider keys", () => {
  const c: Hsva = { h: 210, s: 0.4, v: 0.8, a: 1 };
  it("steps saturation and brightness by one percent, Shift by ten", () => {
    expect(sliderKey("sv", "ArrowRight", false, c)).toEqual({ ...c, s: 0.41 });
    expect(sliderKey("sv", "ArrowLeft", true, c)).toEqual({ ...c, s: 0.3 });
    expect(sliderKey("sv", "ArrowUp", false, c)).toEqual({ ...c, v: 0.81 });
    expect(sliderKey("sv", "ArrowDown", true, c)).toEqual({ ...c, v: 0.7 });
  });
  it("stops at the ends and jumps with Home, End, PageUp and PageDown", () => {
    expect(sliderKey("sv", "ArrowRight", true, { ...c, s: 0.95 })?.s).toBe(1);
    expect(sliderKey("sv", "ArrowLeft", true, { ...c, s: 0.05 })?.s).toBe(0);
    expect(sliderKey("sv", "Home", false, c)?.s).toBe(0);
    expect(sliderKey("sv", "End", false, c)?.s).toBe(1);
    expect(sliderKey("sv", "PageUp", false, c)?.v).toBe(1);
    expect(sliderKey("sv", "PageDown", false, c)?.v).toBe(0);
  });
  it("moves hue by whole degrees and alpha by whole percent", () => {
    expect(sliderKey("hue", "ArrowRight", false, c)?.h).toBe(211);
    expect(sliderKey("hue", "ArrowDown", true, c)?.h).toBe(200);
    expect(sliderKey("hue", "End", false, c)?.h).toBe(359.9);
    expect(sliderKey("hue", "ArrowRight", true, { ...c, h: 355 })?.h).toBe(359.9);
    expect(sliderKey("alpha", "ArrowLeft", false, c)?.a).toBe(0.99);
    expect(sliderKey("alpha", "ArrowLeft", true, { ...c, a: 0.05 })?.a).toBe(0);
    expect(sliderKey("alpha", "Home", false, c)?.a).toBe(0);
  });
  it("ignores other keys", () => {
    expect(sliderKey("sv", "a", false, c)).toBeNull();
    expect(sliderKey("hue", "PageUp", false, c)).toBeNull();
    expect(sliderKey("alpha", "Enter", false, c)).toBeNull();
  });
});

describe("plugin unsaved changes", () => {
  const saved = { name: "Mine", description: "d", code: "x" };
  it("is clean when nothing differs from the saved plugin", () => {
    expect(pluginDirty({ ...saved }, saved, "T")).toBe(false);
  });
  it("is dirty after any change to name, description or code", () => {
    expect(pluginDirty({ ...saved, name: "Mine 2" }, saved, "T")).toBe(true);
    expect(pluginDirty({ ...saved, description: "" }, saved, "T")).toBe(true);
    expect(pluginDirty({ ...saved, code: "y" }, saved, "T")).toBe(true);
  });
  it("treats a new plugin as clean until it has text beyond the template", () => {
    expect(pluginDirty({ name: "", description: "", code: "T" }, undefined, "T")).toBe(false);
    expect(pluginDirty({ name: "  ", description: "", code: "T" }, undefined, "T")).toBe(false);
    expect(pluginDirty({ name: "A", description: "", code: "T" }, undefined, "T")).toBe(true);
    expect(pluginDirty({ name: "", description: "", code: "T // more" }, undefined, "T")).toBe(true);
  });
  it("never asks for a built-in or when nothing is open", () => {
    expect(pluginDirty({ ...saved, code: "changed", builtin: true }, saved, "T")).toBe(false);
    expect(pluginDirty(null, undefined, "T")).toBe(false);
  });
});

describe("share link rule", () => {
  const base = { room: "R", here: "http://localhost:5173/", pageLocal: true, own: false, editor: true, hosted: "https://hosted.example/" };
  it("opens a local relay's own editor", () => {
    const r = linkFor({ ...base, relay: "http://127.0.0.1:7013" });
    expect(r.link).toBe("http://127.0.0.1:7013/?room=R");
    expect(r.previewLink).toBe("http://localhost:5173/?room=R&relay=http%3A%2F%2F127.0.0.1%3A7013");
    expect(r.localOnly).toBe(true);
    expect(linkFor({ ...base, relay: "http://localhost:7013" }).link).toBe("http://localhost:7013/?room=R");
  });
  it("a LAN relay's link is reachable by others", () => {
    const r = linkFor({ ...base, relay: "http://192.168.1.20:7013" });
    expect(r.link).toBe("http://192.168.1.20:7013/?room=R");
    expect(r.localOnly).toBe(false);
  });
  it("a local relay without an editor opens this editor, pointed at the relay", () => {
    const r = linkFor({ ...base, relay: "http://127.0.0.1:7017", editor: false });
    expect(r.link).toBe("http://localhost:5173/?room=R&relay=http%3A%2F%2F127.0.0.1%3A7017");
    expect(r.previewLink).toBeNull();
    expect(r.localOnly).toBe(true);
  });
  it("a hosted relay keeps today's rule: a localhost page shares through the hosted editor", () => {
    const r = linkFor({ ...base, relay: "https://relay.example.com" });
    expect(r.link).toBe("https://hosted.example/?room=R&relay=https%3A%2F%2Frelay.example.com");
    expect(r.localOnly).toBe(false);
    expect(linkFor({ ...base, relay: "https://relay.example.com", pageLocal: false, here: "https://me.example/" }).link).toBe("https://me.example/?room=R&relay=https%3A%2F%2Frelay.example.com");
  });
  it("a page served by the relay itself needs no relay parameter", () => {
    expect(linkFor({ ...base, relay: "http://127.0.0.1:7013", here: "http://127.0.0.1:7013/", own: true }).link).toBe("http://127.0.0.1:7013/?room=R");
  });
});

describe("isPhone", () => {
  afterEach(() => vi.unstubAllGlobals());
  const mock = (width: number, coarse: boolean) =>
    vi.stubGlobal("window", {
      matchMedia: (q: string) => ({
        // Just enough of a media query engine for the one rule under test.
        matches: q === PHONE_QUERY && (width <= 639 || (width <= 820 && coarse)),
      }),
    });
  it("follows the phone rule", () => {
    mock(390, true);
    expect(isPhone()).toBe(true);
    mock(744, true);
    expect(isPhone()).toBe(true);
    mock(720, false);
    expect(isPhone()).toBe(false);
    mock(480, false);
    expect(isPhone()).toBe(true);
  });
  it("is false without matchMedia", () => {
    vi.stubGlobal("window", {});
    expect(isPhone()).toBe(false);
  });
});
