import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EDITOR_FRAME_SRC, WEB_ADDRESS_REFUSAL, hasWebAddress } from "./pluginPolicy";

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

  it("fails closed when the input is nested too deeply to look through", () => {
    let deep: unknown = { a: "fine" };
    for (let i = 0; i < 205; i++) deep = { a: deep };
    expect(hasWebAddress(deep)).toBe(true);
  });

  it("sees a String wrapper once the input is reduced to plain JSON (what plugins.ts does)", () => {
    // postMessage's structured clone keeps new String(...); JSON turns it into the URL itself.
    const cloned = structuredClone({ a: new String("https://x"), b: [new String("fine")] });
    const plain = JSON.parse(JSON.stringify(cloned));
    expect(plain).toEqual({ a: "https://x", b: ["fine"] });
    expect(hasWebAddress(plain)).toBe(true);
    expect(hasWebAddress(JSON.parse(JSON.stringify(structuredClone({ b: [new String("fine")] }))))).toBe(false);
  });
});

describe("plain text may hold web addresses", () => {
  const url = "See https://example.com/docs for more";
  it("allows them in text, characters, name, description, span text and comment text", () => {
    expect(hasWebAddress({ nodes: [{ type: "text", text: url }] })).toBe(false);
    expect(hasWebAddress({ updates: [{ id: "n_1", text: url }] })).toBe(false);
    expect(hasWebAddress({ text: { characters: url } })).toBe(false);
    expect(hasWebAddress({ nodes: [{ type: "rectangle", name: url }] })).toBe(false);
    expect(hasWebAddress({ name: "Doc", description: url })).toBe(false);
    expect(hasWebAddress({ nodes: [{ type: "text", spans: [{ text: url }, { text: "plain" }] }] })).toBe(false);
    expect(hasWebAddress({ id: "n_1", text: url, kind: "comment" })).toBe(false);
  });

  it("still refuses them as image sources, links, urls, SVG content and variable values", () => {
    expect(hasWebAddress({ nodes: [{ type: "image", imageUrl: "https://x.test/a.png" }] })).toBe(true);
    expect(hasWebAddress({ nodes: [{ fills: [{ type: "image", src: "https://x.test/a.png" }] }] })).toBe(true);
    expect(hasWebAddress({ nodes: [{ type: "text", spans: [{ text: "x", link: "https://x.test" }] }] })).toBe(true);
    expect(hasWebAddress({ nodes: [{ type: "text", text: "x", href: "https://x.test" }] })).toBe(true);
    expect(hasWebAddress({ prototype: { url: "https://x.test" } })).toBe(true);
    expect(hasWebAddress({ nodes: [{ type: "svg", svg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x.test/a.png"/></svg>' }] })).toBe(true);
    expect(hasWebAddress({ variables: [{ name: "v", values: { light: "https://x.test" } }] })).toBe(true);
  });

  it("walks objects under an exempt key and checks keys", () => {
    expect(hasWebAddress({ text: { src: "https://x.test" } })).toBe(true);
    expect(hasWebAddress({ text: ["https://x.test"] })).toBe(true); // only a direct string value is exempt
    expect(hasWebAddress({ name: { link: "https://x.test" } })).toBe(true);
    expect(hasWebAddress({ [url]: 1 })).toBe(true);
  });

  it("tells the plugin what is allowed", () => {
    expect(WEB_ADDRESS_REFUSAL).toContain("outside text");
    expect(WEB_ADDRESS_REFUSAL).toContain("links");
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
