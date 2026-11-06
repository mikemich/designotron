import { describe, expect, it } from "vitest";
import { externalizeDataUrls, hash } from "./assets";

const big = (fill: string) => `data:image/png;base64,${fill.repeat(1500)}`;

describe("externalizeDataUrls", () => {
  it("moves a data URL out once even when two screens hold it", () => {
    const url = big("A");
    const binaries: { path: string; dataUrl: string }[] = [];
    const seen = new Set<string>();
    const one = externalizeDataUrls(`<div className="bg-[url('${url}')]" />`, binaries, seen);
    const two = externalizeDataUrls(`<img src="${url}" />`, binaries, seen);
    const path = `/assets/${hash(url)}.png`;
    expect(one).toBe(`<div className="bg-[url('${path}')]" />`);
    expect(two).toBe(`<img src="${path}" />`);
    expect(binaries).toEqual([{ path: `public${path}`, dataUrl: url }]);
  });
  it("leaves small data URLs inline", () => {
    const small = "data:image/png;base64,iVBORw0KGgo=";
    const binaries: { path: string; dataUrl: string }[] = [];
    expect(externalizeDataUrls(`url('${small}')`, binaries, new Set())).toBe(`url('${small}')`);
    expect(binaries).toEqual([]);
  });
  it("keeps url(#a), spaces, underscores and 100% intact through the round trip", () => {
    const body =
      "<svg xmlns='http://www.w3.org/2000/svg'><defs><linearGradient id='a'/></defs><rect fill='url(#a)' width='100%' transform='translate(1 2)'/>" +
      "<g/>".repeat(300) +
      "<text>a_b 100%</text></svg>";
    // What the code generator writes: everything unsafe is percent-encoded.
    const url = `data:image/svg+xml,${encodeURIComponent(body).replace(/[!'()*_]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
    const binaries: { path: string; dataUrl: string }[] = [];
    const out = externalizeDataUrls(`bg-[url('${url}')]`, binaries, new Set());
    expect(out).toBe(`bg-[url('/assets/${hash(url)}.svg')]`);
    const text = decodeURIComponent(escape(atob(binaries[0].dataUrl.split(",")[1])));
    expect(text).toContain("url(#a)");
    expect(text).toContain("a_b 100%");
  });
  it("leaves a URL inline when it does not decode", () => {
    const url = `data:image/svg+xml,${"%".repeat(1100)}`;
    const binaries: { path: string; dataUrl: string }[] = [];
    expect(externalizeDataUrls(`url('${url}')`, binaries, new Set())).toBe(`url('${url}')`);
    expect(binaries).toEqual([]);
  });
  it("writes SVG text as base64 with an svg extension", () => {
    const svg = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg'>" + "<g/>".repeat(400) + "</svg>").replace(/'/g, "%27")}`;
    const binaries: { path: string; dataUrl: string }[] = [];
    const out = externalizeDataUrls(`url('${svg}')`, binaries, new Set());
    expect(out).toBe(`url('/assets/${hash(svg)}.svg')`);
    expect(binaries[0].dataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
});
