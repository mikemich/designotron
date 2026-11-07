import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EDITOR_FRAME_SRC, hasWebAddress } from "./pluginPolicy";

describe("hasWebAddress", () => {
  it("accepts SVG markup with namespace declarations", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><path d="M0 0h1"/></svg>';
    expect(hasWebAddress({ nodes: [{ type: "svg", svg }] })).toBe(false);
    expect(hasWebAddress("<svg xmlns='http://www.w3.org/2000/svg'/>")).toBe(false);
    expect(hasWebAddress('<div xmlns="http://www.w3.org/1999/xhtml"/>')).toBe(false);
  });

  it("still refuses web addresses", () => {
    expect(hasWebAddress({ nodes: [{ type: "image", imageUrl: "https://example.com/a.png" }] })).toBe(true);
    expect(hasWebAddress("http://www.w3.org/2000/svg")).toBe(true);
    expect(hasWebAddress('<svg xmlns="http://www.w3.org/2000/svg?x=1">')).toBe(true);
    expect(hasWebAddress('<svg xmlns="http://evil">')).toBe(true);
    expect(hasWebAddress('<svg xmlns="http://www.w3.org/2000/svg"><image href="HTTP://evil/x.png"/></svg>')).toBe(true);
    expect(hasWebAddress('<svg xmlns="http://www.w3.org/2000/svg"><image href="http://www.w3.org/2000/svg"/></svg>')).toBe(true);
  });

  it("walks nested arrays and objects", () => {
    expect(hasWebAddress([[{ a: { b: ["x", "see https://x.test"] } }]])).toBe(true);
    expect(hasWebAddress([[{ a: { b: ["x", "fine"] } }]])).toBe(false);
    expect(hasWebAddress({ "https://k.test": 1 })).toBe(true);
    expect(hasWebAddress(null)).toBe(false);
    expect(hasWebAddress(undefined)).toBe(false);
    expect(hasWebAddress(12)).toBe(false);
  });
});

describe("editor frame policy", () => {
  it("index.html carries exactly EDITOR_FRAME_SRC as its Content-Security-Policy", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g)].map((m) => m[1]);
    expect(metas).toEqual([EDITOR_FRAME_SRC]);
  });

  it("has only frame-src, no 'self', no wildcard host", () => {
    expect(EDITOR_FRAME_SRC.split(";").map((d) => d.trim().split(" ")[0])).toEqual(["frame-src"]);
    expect(EDITOR_FRAME_SRC).not.toContain("'self'");
    expect(EDITOR_FRAME_SRC.split(" ").filter((s) => s.startsWith("http"))).toEqual(["http://localhost:*", "http://127.0.0.1:*"]);
  });
});
