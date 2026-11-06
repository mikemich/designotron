import { describe, expect, it } from "vitest";
import { buildPdf, deflate, splitRgba, type PdfPage } from "./pdf";

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function page(w: number, h: number, pxW: number, pxH: number, alpha = false): PdfPage {
  const rgb = new Uint8Array(pxW * pxH * 3).map((_, i) => (i * 7) % 256);
  const a = new Uint8Array(pxW * pxH).fill(255);
  if (alpha) a[1] = 10;
  return { widthPt: w, heightPt: h, pxW, pxH, rgb, alpha: a };
}

/** Reads the xref and returns each object's text, checking every offset points at `n 0 obj`. */
function parse(bytes: Uint8Array) {
  const text = latin1(bytes);
  expect(text.startsWith("%PDF-1.4\n")).toBe(true);
  expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  const start = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)![1]);
  expect(text.slice(start, start + 4)).toBe("xref");
  const m = text.slice(start).match(/^xref\n0 (\d+)\n/)!;
  const count = Number(m[1]);
  const lines = text.slice(start + m[0].length).split("\n").slice(0, count);
  expect(lines[0]).toBe("0000000000 65535 f ");
  const objs: Record<number, string> = {};
  for (let n = 1; n < count; n++) {
    expect(lines[n]).toMatch(/^\d{10} 00000 n $/);
    const off = Number(lines[n].slice(0, 10));
    expect(text.slice(off, off + `${n} 0 obj\n`.length)).toBe(`${n} 0 obj\n`);
    objs[n] = text.slice(off, text.indexOf("endobj", off));
  }
  expect(text).toContain(`/Size ${count}`);
  return { text, objs, count };
}

describe("buildPdf", () => {
  it("writes a structurally valid two page document", async () => {
    const blob = await buildPdf([page(390, 844, 8, 4), page(100.5, 50, 4, 2, true)]);
    expect(blob.type).toBe("application/pdf");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { text, objs } = parse(bytes);
    expect(text).toContain("/Count 2");
    expect(text).toContain("/MediaBox [0 0 390 844]");
    expect(text).toContain("/MediaBox [0 0 100.5 50]");
    expect(text).toContain("q 390 0 0 844 0 0 cm /Im0 Do Q");
    // An SMask only where some alpha is below 255.
    expect(text.match(/\/SMask/g)).toHaveLength(1);
    const kids = text.match(/\/Kids \[([^\]]*)\]/)![1].match(/(\d+) 0 R/g)!;
    expect(kids).toHaveLength(2);
    for (const k of kids) expect(objs[Number(k.split(" ")[0])]).toContain("/Type /Page ");
  });

  it("stores the pixels so inflating the stream gives them back", async () => {
    const p = page(10, 10, 5, 3, true);
    const bytes = new Uint8Array(await (await buildPdf([p])).arrayBuffer());
    const text = latin1(bytes);
    const stream = (dict: RegExp) => {
      const head = text.match(dict)!;
      const len = Number(head[0].match(/\/Length (\d+)/)![1]);
      const at = head.index! + head[0].length;
      return bytes.slice(at, at + len);
    };
    const rgb = await inflate(stream(/<< \/Type \/XObject \/Subtype \/Image \/Width 5 \/Height 3 \/ColorSpace \/DeviceRGB[^>]*>>\nstream\n/));
    expect(Array.from(rgb)).toEqual(Array.from(p.rgb!));
    const alpha = await inflate(stream(/<< \/Type \/XObject \/Subtype \/Image \/Width 5 \/Height 3 \/ColorSpace \/DeviceGray[^>]*>>\nstream\n/));
    expect(Array.from(alpha)).toEqual(Array.from(p.alpha!));
  });

  it("takes pages that are already deflated", async () => {
    const rgb = new Uint8Array(2 * 2 * 3).fill(9);
    const bytes = new Uint8Array(await (await buildPdf([{ widthPt: 2, heightPt: 2, pxW: 2, pxH: 2, rgbZ: await deflate(rgb) }])).arrayBuffer());
    const { text } = parse(bytes);
    expect(text).not.toContain("/SMask");
  });

  it("rejects an empty document and pixel data of the wrong length", async () => {
    await expect(buildPdf([])).rejects.toThrow();
    await expect(buildPdf([{ widthPt: 1, heightPt: 1, pxW: 2, pxH: 2, rgb: new Uint8Array(3) }])).rejects.toThrow();
  });

  it("splits RGBA into colour and alpha", () => {
    const opaque = splitRgba(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]));
    expect(Array.from(opaque.rgb)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(opaque.alpha).toBeNull();
    const clear = splitRgba(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 0]));
    expect(Array.from(clear.alpha!)).toEqual([255, 0]);
  });
});

describe("page boxes", () => {
  it("keeps a page within 3 to 14,400 units a side", async () => {
    const bytes = new Uint8Array(await (await buildPdf([page(1440, 28800, 2, 2), page(1, 100, 2, 2)])).arrayBuffer());
    const text = latin1(bytes);
    expect(text).toContain("/MediaBox [0 0 720 14400]");
    expect(text).toContain("/MediaBox [0 0 3 100]");
  });
});
