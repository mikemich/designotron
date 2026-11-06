// A small PDF 1.4 writer for raster pages: one image per page, no dependencies.

export interface PdfPage {
  /** Page size in points (1 pt = 1 px of the layer's export box, as in Figma). */
  widthPt: number;
  heightPt: number;
  /** Image size in pixels. */
  pxW: number;
  pxH: number;
  /** 8-bit RGB, pxW * pxH * 3 bytes (ignored when `rgbZ` is given). */
  rgb?: Uint8Array;
  /** 8-bit alpha, pxW * pxH bytes; makes a soft mask when any value is below 255. */
  alpha?: Uint8Array;
  /** The same data already deflated (zlib), so a caller can drop the raw pixels page by page. */
  rgbZ?: Uint8Array;
  alphaZ?: Uint8Array;
}

/** zlib-compresses bytes, the format PDF's FlateDecode reads. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Splits RGBA pixels (canvas `getImageData`) into RGB and alpha; alpha is null when fully opaque. */
export function splitRgba(rgba: Uint8ClampedArray | Uint8Array): { rgb: Uint8Array; alpha: Uint8Array | null } {
  const n = rgba.length >> 2;
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  let clear = false;
  for (let i = 0, j = 0; i < n; i++) {
    rgb[j++] = rgba[i * 4];
    rgb[j++] = rgba[i * 4 + 1];
    rgb[j++] = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    alpha[i] = a;
    if (a < 255) clear = true;
  }
  return { rgb, alpha: clear ? alpha : null };
}

/** A PDF document with one page per item, in order. */
export async function buildPdf(pages: PdfPage[]): Promise<Blob> {
  if (!pages.length) throw new Error("a PDF needs at least one page");
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const put = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? enc.encode(b) : b;
    parts.push(bytes);
    size += bytes.length;
  };
  /** Starts object `n`; its byte position goes into the xref. */
  const begin = (n: number) => {
    offsets[n] = size;
    put(`${n} 0 obj\n`);
  };
  const stream = (n: number, dict: string, data: Uint8Array) => {
    begin(n);
    put(`<< ${dict} /Length ${data.length} >>\nstream\n`);
    put(data);
    put("\nendstream\nendobj\n");
  };

  // Object numbers: 1 catalog, 2 pages, then per page: page, content, image, optional mask.
  const ids: { page: number; content: number; image: number; mask: number }[] = [];
  const zipped: { rgb: Uint8Array; alpha: Uint8Array | null }[] = [];
  let next = 3;
  for (const p of pages) {
    const rgb = p.rgbZ ?? (await deflate(expectLen(p.rgb, p.pxW * p.pxH * 3, "rgb")));
    let alpha = p.alphaZ ?? null;
    if (!alpha && p.alpha) {
      expectLen(p.alpha, p.pxW * p.pxH, "alpha");
      if (p.alpha.some((a) => a < 255)) alpha = await deflate(p.alpha);
    }
    zipped.push({ rgb, alpha });
    ids.push({ page: next, content: next + 1, image: next + 2, mask: alpha ? next + 3 : 0 });
    next += alpha ? 4 : 3;
  }

  put("%PDF-1.4\n");
  // Four bytes above 127 tell tools the file is binary.
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  begin(1);
  put("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  begin(2);
  put(`<< /Type /Pages /Count ${pages.length} /Kids [${ids.map((i) => `${i.page} 0 R`).join(" ")}] >>\nendobj\n`);
  pages.forEach((p, k) => {
    const id = ids[k];
    const [w, h] = pageBox(p.widthPt, p.heightPt);
    begin(id.page);
    put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id.image} 0 R >> >> /Contents ${id.content} 0 R >>\nendobj\n`);
    stream(id.content, "", enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`));
    const z = zipped[k];
    const mask = id.mask ? ` /SMask ${id.mask} 0 R` : "";
    stream(id.image, `/Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${mask}`, z.rgb);
    if (id.mask && z.alpha) {
      stream(id.mask, `/Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, z.alpha);
    }
  });

  const info = next;
  begin(info);
  put("<< /Producer (Designotron) >>\nendobj\n");
  const xref = size;
  const count = info + 1;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  put(table);
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

function expectLen(a: Uint8Array | undefined, n: number, what: string): Uint8Array {
  if (!a || a.length !== n) throw new Error(`PDF page ${what} data has the wrong length`);
  return a;
}

/** Acrobat refuses pages under 3 or over 14,400 units a side: scale the box to fit, keeping the aspect where it can. */
function pageBox(w: number, h: number): [string, string] {
  const big = Math.max(w, h);
  const k = big > 14400 ? 14400 / big : 1;
  const clamp = (v: number) => Math.min(14400, Math.max(3, v * k));
  return [num(clamp(w)), num(clamp(h))];
}

/** A number for a content stream or box: at most 3 decimals, no exponent. */
function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}
