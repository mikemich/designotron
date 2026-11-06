import { describe, expect, it } from "vitest";
import { MIXED } from "../ui/mixed";
import { rangeValue } from "./textRange";

// "Hello world paragraph." with "world" bold (6..11) and "paragraph." at 32 px (12..22).
const text = {
  characters: "Hello world paragraph.",
  fontWeight: 400,
  fontSize: 16,
  italic: false,
  runs: [
    { start: 6, end: 11, fontWeight: 700 },
    { start: 12, end: 22, fontSize: 32 },
  ],
};

describe("rangeValue", () => {
  it("reads the base value of a range with no run", () => {
    expect(rangeValue(text, 0, 5, "fontWeight")).toBe(400);
    expect(rangeValue(text, 0, 5, "fontSize")).toBe(16);
  });
  it("reads a run's value inside one run", () => {
    expect(rangeValue(text, 6, 11, "fontWeight")).toBe(700);
    expect(rangeValue(text, 7, 9, "fontWeight")).toBe(700);
    expect(rangeValue(text, 12, 22, "fontSize")).toBe(32);
    expect(rangeValue(text, 12, 22, "fontWeight")).toBe(400);
  });
  it("is mixed across a run edge", () => {
    expect(rangeValue(text, 4, 8, "fontWeight")).toBe(MIXED);
    expect(rangeValue(text, 0, 22, "fontSize")).toBe(MIXED);
    expect(rangeValue(text, 10, 13, "fontSize")).toBe(MIXED);
  });
  it("is not mixed when the neighbours resolve to the same value", () => {
    expect(rangeValue(text, 0, 22, "italic")).toBe(false);
    expect(rangeValue({ ...text, runs: [{ start: 2, end: 4, fontWeight: 400 }] }, 0, 8, "fontWeight")).toBe(400);
  });
  it("falls back to the given colour, and a run colour wins", () => {
    expect(rangeValue(text, 0, 5, "color", "#111111")).toBe("#111111");
    const coloured = { ...text, runs: [{ start: 0, end: 5, color: "#ff0000" }] };
    expect(rangeValue(coloured, 0, 5, "color", "#111111")).toBe("#ff0000");
    expect(rangeValue(coloured, 3, 8, "color", "#111111")).toBe(MIXED);
  });
  it("reads a link, none being undefined", () => {
    const linked = { ...text, runs: [{ start: 0, end: 5, link: "https://a.b" }] };
    expect(rangeValue(linked, 0, 5, "link")).toBe("https://a.b");
    expect(rangeValue(linked, 6, 9, "link")).toBeUndefined();
    expect(rangeValue(linked, 3, 9, "link")).toBe(MIXED);
  });
  it("reads the character at the start of a collapsed range", () => {
    expect(rangeValue(text, 8, 8, "fontWeight")).toBe(700);
    expect(rangeValue(text, 2, 2, "fontWeight")).toBe(400);
  });
  it("ignores the part of a range past the end of the text", () => {
    expect(rangeValue(text, 12, 99, "fontSize")).toBe(32);
  });
});
