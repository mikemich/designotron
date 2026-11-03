import { describe, expect, it } from "vitest";
import { filterPresets, groupPresets, hasDeviceUi, nextIndex, type DevicePreset } from "./presetList";

const p = (id: string, group: string, label: string, w: number, h: number, kind = "none"): DevicePreset => ({ id, group, label, w, h, kind, insets: [0, 0, 0, 0] });
const list = [
  p("iphone-17-pro", "Phone", "iPhone 17 Pro", 402, 874, "iosIsland"),
  p("iphone-16", "Phone", "iPhone 16", 393, 852, "iosIsland"),
  p("ipad-pro-11", "Tablet", "iPad Pro 11\"", 834, 1210, "ipadHome"),
  p("browser-1440", "Web", "Browser 1440", 1440, 900, "browser"),
  p("a4", "Print", "A4", 595, 842),
];

describe("groupPresets", () => {
  it("keeps the order groups first appear in", () => {
    expect(groupPresets(list).map((g) => [g.group, g.items.length])).toEqual([
      ["Phone", 2],
      ["Tablet", 1],
      ["Web", 1],
      ["Print", 1],
    ]);
  });

  it("is empty for no presets", () => {
    expect(groupPresets([])).toEqual([]);
  });
});

describe("filterPresets", () => {
  const ids = (q: string) => filterPresets(list, q).map((x) => x.id);

  it("returns everything for a blank filter", () => {
    expect(ids("  ")).toHaveLength(list.length);
  });

  it("matches the label, case-insensitively", () => {
    expect(ids("pro")).toEqual(["iphone-17-pro", "ipad-pro-11"]);
  });

  it("matches the group and the id", () => {
    expect(ids("tablet")).toEqual(["ipad-pro-11"]);
    expect(ids("iphone-16")).toEqual(["iphone-16"]);
  });

  it("matches a width, a height or a size", () => {
    expect(ids("393")).toEqual(["iphone-16"]);
    expect(ids("1210")).toEqual(["ipad-pro-11"]);
    expect(ids("1440×900")).toEqual(["browser-1440"]);
    expect(ids("1440x900")).toEqual(["browser-1440"]);
  });

  it("needs every word to match", () => {
    expect(ids("iphone pro")).toEqual(["iphone-17-pro"]);
    expect(ids("iphone tablet")).toEqual([]);
  });
});

describe("nextIndex", () => {
  it("starts at the first row going down and the last going up", () => {
    expect(nextIndex(-1, 4, "ArrowDown")).toBe(0);
    expect(nextIndex(-1, 4, "ArrowUp")).toBe(3);
  });

  it("wraps at both ends", () => {
    expect(nextIndex(3, 4, "ArrowDown")).toBe(0);
    expect(nextIndex(0, 4, "ArrowUp")).toBe(3);
    expect(nextIndex(1, 4, "ArrowDown")).toBe(2);
  });

  it("jumps with Home and End and ignores other keys", () => {
    expect(nextIndex(2, 4, "Home")).toBe(0);
    expect(nextIndex(1, 4, "End")).toBe(3);
    expect(nextIndex(2, 4, "a")).toBe(2);
  });

  it("has no row when the list is empty", () => {
    expect(nextIndex(0, 0, "ArrowDown")).toBe(-1);
  });
});

describe("hasDeviceUi", () => {
  it("is true only for presets with system UI", () => {
    expect(list.filter(hasDeviceUi).map((x) => x.id)).toEqual(["iphone-17-pro", "iphone-16", "ipad-pro-11", "browser-1440"]);
  });
});
