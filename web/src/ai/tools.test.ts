import { describe, expect, it, vi } from "vitest";

// tools.ts pulls in the store and the wasm engine; only the pure walker is under test here.
vi.mock("../store", () => ({ aiDispatch: () => null, getDoc: () => ({}), pointerDrag: {}, query: () => null, selection: () => [], useStore: {}, zoomToSelection: () => {} }));
vi.mock("./browserTools", () => ({ LEFT_FILE: "left", getScreenshot: () => null, importHtml: () => null, importUrl: () => null }));
vi.mock("../assets", () => ({ addAsset: (u: string) => "a" + u.length }));

import { internImageSources } from "./tools";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const add = (u: string) => "id" + u.length;

describe("internImageSources", () => {
  it("replaces imageUrl, fills[].src and url(data:) in fill strings", () => {
    const out = internImageSources(
      {
        nodes: [
          { type: "rectangle", imageUrl: PNG },
          { type: "frame", fills: [{ type: "image", src: PNG }] },
          { type: "frame", fill: `url(${PNG})` },
          { type: "frame", fills: [`url("${PNG}") center`] },
        ],
      },
      add,
    ) as any;
    const id = "asset:" + add(PNG);
    expect(out.nodes[0].imageUrl).toBe(id);
    expect(out.nodes[1].fills[0].src).toBe(id);
    expect(out.nodes[2].fill).toBe(`url(${id})`);
    expect(out.nodes[3].fills[0]).toBe(`url(${id}) center`);
  });
  it("leaves text, svg markup, http urls and asset references alone", () => {
    const input = { text: PNG, characters: PNG, svg: `<svg><image href="${PNG}"/></svg>`, imageUrl: "https://x.test/a.png", src: "asset:abc", name: PNG };
    expect(internImageSources(input, add)).toEqual(input);
  });
  it("gives one asset for the same data URL twice and doesn't mutate the input", () => {
    const input = { a: { src: PNG }, b: { src: PNG } };
    const out = internImageSources(input, () => "same") as any;
    expect(out.a.src).toBe("asset:same");
    expect(out.b.src).toBe("asset:same");
    expect(input.a.src).toBe(PNG);
  });
  it("refuses an image over 25 MB", () => {
    const big = "data:image/png;base64," + "A".repeat(26 * 1024 * 1024);
    expect(() => internImageSources({ imageUrl: big }, add)).toThrow("image is larger than 25 MB");
  });
});
