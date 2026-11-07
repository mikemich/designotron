// Raster/vector export and the generated-project zip.

import JSZip from "jszip";
import { assetDataUrl, assetExt, externalizeDataUrls, inlineAssets, referencedAssets } from "./assets";
import { download } from "./files";
import { buildPdf, deflate, splitRgba, type PdfPage } from "./pdf";
import { currentPage, getDoc, query, toast } from "./store";
import type { ExportSetting, Node, Rect } from "./types";

/** Largest canvas browsers will allocate: 16384 px per side and about 268 megapixels in all. */
const MAX_SIDE = 16384;
const MAX_AREA = 268_435_456;

const fontCss = new Map<string, Promise<string>>();

/** @font-face rules (latin subsets, inlined as data URLs) for a Google font family. */
function fontFaceCss(family: string): Promise<string> {
  let p = fontCss.get(family);
  if (!p) {
    p = (async () => {
      try {
        const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap`;
        const css = await (await fetch(url)).text();
        const blocks = css.split("/*").filter((b) => b.startsWith(" latin */"));
        const out: string[] = [];
        for (const b of blocks) {
          const rule = b.slice(b.indexOf("@font-face"));
          const m = rule.match(/url\((https:[^)]+)\)/);
          if (!m) continue;
          const font = await (await fetch(m[1])).blob();
          const data = await new Promise<string>((res) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.readAsDataURL(font);
          });
          out.push(rule.replace(m[1], data));
        }
        return out.join("\n");
      } catch {
        return "";
      }
    })();
    fontCss.set(family, p);
  }
  return p;
}

async function embedFonts(svg: string): Promise<string> {
  const families = [...new Set([...svg.matchAll(/font-family="'([^']+)'/g)].map((m) => m[1]))];
  if (!families.length) return svg;
  const css = (await Promise.all(families.map(fontFaceCss))).join("\n");
  if (!css) return svg;
  if (svg.includes("<defs>")) return svg.replace("<defs>", `<defs><style>${css}</style>`);
  return svg.replace(/<svg[^>]*>/, (open) => `${open}<defs><style>${css}</style></defs>`);
}

/** Self-contained SVG for a node (assets inlined). */
export function nodeSvg(id: string): string {
  return inlineAssets(query<string>({ q: "exportSvg", id }));
}

/** Pixel size of an exported SVG (its width/height attributes). */
function svgSize(svg: string): { w: number; h: number } {
  return { w: Number(svg.match(/width="([\d.]+)"/)?.[1] ?? 100), h: Number(svg.match(/height="([\d.]+)"/)?.[1] ?? 100) };
}

/** The largest scale at or below `scale` that keeps the raster within what a canvas can hold. */
export function fitScale(w: number, h: number, scale: number): number {
  const k = Math.min(scale, MAX_SIDE / Math.max(w, 1), MAX_SIDE / Math.max(h, 1), Math.sqrt(MAX_AREA / Math.max(w * h, 1)));
  // Rounding each side can push the area a hair over; leave room for it.
  return k < scale ? Math.floor(k * 1000) / 1000 : scale;
}

/** Draws an exported SVG onto a canvas at `scale` (reduced to what a canvas can hold). */
async function rasterise(svg: string, scale: number, background?: string, forceBackground = false): Promise<HTMLCanvasElement> {
  const withFonts = await embedFonts(svg);
  const { w, h } = svgSize(withFonts);
  scale = fitScale(w, h, scale);
  const url = URL.createObjectURL(new Blob([withFonts], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("could not rasterise SVG"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.min(MAX_SIDE, Math.round(w * scale)));
    canvas.height = Math.max(1, Math.min(MAX_SIDE, Math.round(h * scale)));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("the browser could not allocate an image this large");
    if (background || forceBackground) {
      ctx.fillStyle = background ?? "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function svgToPngBlob(svg: string, scale: number, type = "image/png", background?: string): Promise<Blob> {
  const canvas = await rasterise(svg, scale, background, type === "image/jpeg");
  return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), type, 0.92));
}

/** Longest file name stem in UTF-8 bytes; file systems stop at 255, and a suffix, an extension and numbering follow. */
const MAX_NAME_BYTES = 200;
/** Longest user-typed export suffix, in code points. */
const MAX_SUFFIX = 40;

/** Characters a file name can't hold or that make it lie: controls, bidi overrides and marks, zero-width spaces and marks, path separators and `<>:"|?*`. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028-\u202E\u2060-\u2069\uFEFF<>:"/\\|?*]/g;
/** Look-alikes of a separator or colon that Windows maps to the real one when it converts a name ("best fit"). */
const BEST_FIT = /[\uFF0F\uFF3C\u2215\uFF0E\uFF1A]/g;
/** A joiner that doesn't sit between two letters or pictographs (emoji sequences, Persian and Indic words need theirs). */
const STRAY_JOINER = /(?<![\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])[\u200C\u200D]|[\u200C\u200D](?![\p{L}\p{M}\p{Extended_Pictographic}])/gu;
/** Windows device names, which it also reads with trailing spaces and after the first dot. */
const RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])\s*(\..*)?$/i;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Removes what a file name can't hold from a piece of text (a suffix), without trimming or renaming it. */
export function stripUnsafe(s: string): string {
  return s
    .normalize("NFC")
    .replace(LONE_SURROGATE, "")
    .replace(BEST_FIT, "-")
    .replace(UNSAFE_CHARS, "")
    .replace(STRAY_JOINER, "")
    .replace(/\s+/g, " ");
}

/** The longest start of `s` within `bytes` UTF-8 bytes that doesn't split a character or an emoji sequence. */
function cutBytes(s: string, bytes: number): string {
  const enc = new TextEncoder();
  const parts: string[] =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (g) => g.segment)
      : Array.from(s);
  let used = 0;
  let out = "";
  for (const p of parts) {
    used += enc.encode(p).length;
    if (used > bytes) break;
    out += p;
  }
  return out;
}

/**
 * A file name made from text the user (or a file they opened) wrote. Keeps letters of any script,
 * digits, dots and spaces; removes path separators, controls, bidi overrides and the characters
 * Windows forbids, trims leading dots, dashes and spaces and trailing dots and spaces (no `..`,
 * no hidden files, no option-looking names), prefixes Windows device names with `_` and caps the
 * length at 200 UTF-8 bytes (file systems allow 255 and a suffix and extension follow). Never
 * returns an empty name or one that is only dots.
 */
export function fileSafe(name: string): string {
  let s = cutBytes(stripUnsafe(name).replace(/^[\s.-]+/, ""), MAX_NAME_BYTES).replace(/[\s.\u200C\u200D]+$/, "");
  if (!s) return "export";
  if (RESERVED_NAME.test(s)) s = `_${s}`;
  return s;
}

/** A layer name as a path inside a zip: "/" makes folders, and every segment is made safe, so `..` can't climb out. */
function zipPath(name: string): string {
  return name.split("/").map(fileSafe).join("/");
}

/** What a typed export size means: a scale, or a fixed width or height in px. */
export type ExportSize = { scale: number } | { width: number } | { height: number };

/** Parses `2.5`, `2.5x`, `512w` or `300h` (any case); null when it isn't one. Scales are clamped to 0.01-32. */
export function parseExportSize(text: string): ExportSize | null {
  const m = text.trim().toLowerCase().match(/^(\d*\.?\d+)\s*([xwh])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] === "w") return { width: Math.min(MAX_SIDE, Math.max(1, Math.round(n))) };
  if (m[2] === "h") return { height: Math.min(MAX_SIDE, Math.max(1, Math.round(n))) };
  return { scale: Math.min(32, Math.max(0.01, Math.round(n * 1000) / 1000)) };
}

/** How a row's size is shown in the field: `2x`, `512w` or `300h`. */
export function formatExportSize(row: Pick<ExportSetting, "scale" | "width" | "height">): string {
  if (row.width && row.width > 0) return `${Math.round(row.width)}w`;
  if (row.height && row.height > 0) return `${Math.round(row.height)}h`;
  return `${Math.round(row.scale * 1000) / 1000}x`;
}

/** What a layer exports when it has no rows of its own. */
export const DEFAULT_EXPORT: ExportSetting = { format: "png", scale: 1, suffix: "" };

/** Rows to export for a layer: its own, or the default one. */
export function exportRows(node: Node): ExportSetting[] {
  return node.exportSettings?.length ? node.exportSettings : [DEFAULT_EXPORT];
}

/**
 * Scale a row asks for, where `w` x `h` is the layer's own box (not the image, which also holds
 * strokes, shadows and blurs). A fixed width or height makes that box N px and wins over `scale`.
 */
export function rowScale(row: ExportSetting, w: number, h: number): number {
  if (row.format === "svg") return 1;
  if (row.width && row.width > 0) return row.width / Math.max(w, 1);
  if (row.height && row.height > 0) return row.height / Math.max(h, 1);
  return row.scale > 0 ? row.scale : 1;
}

/** File name suffix of a row: what the user typed, else `@2x`, `@512w` or `@1024h` (nothing at 1x). */
export function rowSuffix(row: ExportSetting, scale = row.scale): string {
  if (row.suffix) return Array.from(stripUnsafe(row.suffix)).slice(0, MAX_SUFFIX).join("");
  if (row.format === "svg") return "";
  if (row.width && row.width > 0) return `@${Math.round(row.width)}w`;
  if (row.height && row.height > 0) return `@${Math.round(row.height)}h`;
  return scale !== 1 ? `@${scale}x` : "";
}

export interface ExportFile {
  name: string;
  data: Blob | string;
  mime: string;
}

/** One exported file for a layer and a row. A raster that is too large is scaled down with a toast. */
export async function renderExport(id: string, row: ExportSetting): Promise<ExportFile> {
  const node = getDoc().nodes[id];
  if (!node) throw new Error("the layer no longer exists");
  const svg = nodeSvg(id);
  // A "/" in the layer name is a folder inside a zip, as in Figma.
  const base = zipPath(node.name);
  if (row.format === "svg") {
    // Vector: no scale. Fonts embedded so text looks the same wherever the SVG is opened.
    return { name: `${base}${rowSuffix(row)}.svg`, data: await embedFonts(svg), mime: "image/svg+xml" };
  }
  const { w, h } = svgSize(svg);
  const box = query<{ union: Rect | null }>({ q: "bounds", ids: [id] }).union;
  const want = rowScale(row, box?.width ?? w, box?.height ?? h);
  const used = fitScale(w, h, want);
  if (used < want) {
    const px = `${Math.round(w * used)} × ${Math.round(h * used)} px`;
    toast(`${node.name} is too large to export at ${Math.round(want * 100) / 100}x; exporting at ${used}x (${px}), the most browsers can make`, "error");
  }
  const blob = await svgToPngBlob(svg, used, row.format === "jpg" ? "image/jpeg" : "image/png");
  const suffix = used < want && !row.suffix ? `@${used}x` : rowSuffix(row, used);
  return { name: `${base}${suffix}.${row.format}`, data: blob, mime: blob.type };
}

/**
 * Exports every row of every layer. One file downloads as it is; several come as a zip
 * (browsers ask before allowing many downloads). Names that collide get a number.
 */
export async function exportLayers(ids: string[]) {
  const doc = getDoc();
  const files: ExportFile[] = [];
  warnHidden(ids);
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    for (const row of exportRows(node)) {
      try {
        files.push(await renderExport(id, row));
      } catch (err) {
        toast(`Could not export ${node.name}: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
  }
  if (!files.length) return;
  const named = uniqueNames(files);
  if (named.length === 1) {
    // Browsers don't take folders in a download name.
    download(named[0].name.replace(/\//g, "-"), named[0].data, named[0].mime);
    return;
  }
  const zip = new JSZip();
  for (const f of named) zip.file(f.name, f.data);
  const first = doc.nodes[ids[0]];
  const label = fileSafe(ids.length === 1 && first ? first.name : doc.name);
  download(`${label}.zip`, await zip.generateAsync({ type: "blob" }), "application/zip");
}

/** Says so for each hidden layer: the engine draws nothing for it, so its export is empty. */
function warnHidden(ids: string[]) {
  const doc = getDoc();
  const hidden = ids.map((id) => doc.nodes[id]).filter((n) => n && n.visible === false);
  if (hidden.length === 1) toast(`${hidden[0].name} is hidden, so its export is empty`);
  else if (hidden.length > 1) toast(`${hidden.length} selected layers are hidden, so their exports are empty`);
}

/** `a.png`, `a.png` -> `a.png`, `a-2.png` (numbering on until the name is free, even of a real `a-2.png`). */
function uniqueNames(files: ExportFile[]): ExportFile[] {
  const taken = new Set(files.map((f) => f.name));
  const used = new Set<string>();
  return files.map((f) => {
    if (!used.has(f.name)) {
      used.add(f.name);
      return f;
    }
    for (let n = 2; ; n++) {
      const name = f.name.replace(/(\.\w+)$/, `-${n}$1`);
      if (!used.has(name) && !taken.has(name)) {
        used.add(name);
        return { ...f, name };
      }
    }
  });
}

// ---------- PDF ----------

/** Pixels per point in a PDF page's image: 2x, so a screen stays sharp when zoomed. */
const PDF_SCALE = 2;
/** Most pixels one PDF page's image holds: it is decoded to RGBA and then split, about 7 bytes a pixel at the peak. */
const PDF_MAX_AREA = 64_000_000;

/** Layers File > Export frames to PDF takes: every visible top-level frame of the page, in layer order. */
export function pdfFrames(): string[] {
  const doc = getDoc();
  const page = doc.pages.find((p) => p.id === currentPage());
  return (page?.children ?? []).filter((id) => {
    const n = doc.nodes[id];
    return n && n.visible !== false && (n.type === "frame" || n.type === "component" || n.type === "componentSet");
  });
}

/**
 * Exports layers as one PDF with a page per layer, in the order given. Pages are 2x images of the
 * layer (text is not selectable); a page is 1 pt per px of the layer's export box.
 */
export async function exportPdf(ids: string[]) {
  const doc = getDoc();
  const layers = ids.filter((id) => doc.nodes[id]);
  if (!layers.length) {
    toast("Select a layer, or add a frame, to export a PDF");
    return;
  }
  warnHidden(layers);
  if (layers.length > 10) toast(`Exporting ${layers.length} pages…`);
  const pages: PdfPage[] = [];
  for (const id of layers) {
    try {
      const svg = nodeSvg(id);
      const { w, h } = svgSize(svg);
      const scale = Math.min(PDF_SCALE, Math.sqrt(PDF_MAX_AREA / Math.max(w * h, 1)));
      const canvas = await rasterise(svg, scale);
      // Report the scale really rendered (rasterise can reduce it further to fit the browser).
      const used = canvas.width / Math.max(w, 1);
      if (used < PDF_SCALE - 0.01) toast(`${doc.nodes[id].name} is large, so its PDF page is rendered at ${Math.round(used * 100) / 100}x`);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("the browser could not read the image back");
      const { rgb, alpha } = splitRgba(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      // Only the compressed bytes stay, so a long document doesn't hold every page's pixels.
      pages.push({ widthPt: w, heightPt: h, pxW: canvas.width, pxH: canvas.height, rgbZ: await deflate(rgb), alphaZ: alpha ? await deflate(alpha) : undefined });
      canvas.width = canvas.height = 0;
    } catch (err) {
      toast(`Could not export ${doc.nodes[id].name}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }
  if (!pages.length) return;
  const first = doc.nodes[layers[0]];
  const name = fileSafe(layers.length === 1 ? first.name : doc.name);
  download(`${name}.pdf`, await buildPdf(pages), "application/pdf");
}

// ---------- Copy as ----------

/** Copies a layer to the clipboard as a 2x PNG image. */
export async function copyAsPng(id: string) {
  const node = getDoc().nodes[id];
  if (!node) return;
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("this browser can't copy images");
    const svg = nodeSvg(id);
    const { w, h } = svgSize(svg);
    // The promise goes in unresolved so the copy still counts as the user's click while it renders.
    const png = svgToPngBlob(svg, fitScale(w, h, 2));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast(`Copied ${node.name} as PNG`);
  } catch (err) {
    toast(`Could not copy as PNG: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

/** Copies a layer's SVG markup to the clipboard as text. */
export async function copyAsSvg(id: string) {
  const node = getDoc().nodes[id];
  if (!node) return;
  await copyText(nodeSvg(id), `Copied ${node.name} as SVG`, "SVG");
}

/** Copies a text (code) to the clipboard with a toast. */
export async function copyText(text: string, done: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch (err) {
    toast(`Could not copy as ${what}: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

/** Base64 PNG of a node (or the union of a page) for Claude to look at. */
export async function screenshotBase64(id: string, scale = 1): Promise<{ data: string; width: number; height: number }> {
  const svg = nodeSvg(id);
  const w = Number(svg.match(/width="([\d.]+)"/)?.[1] ?? 100);
  const h = Number(svg.match(/height="([\d.]+)"/)?.[1] ?? 100);
  // Keep screenshots under ~1600px on the long side.
  const s = Math.min(scale, 1600 / Math.max(w, h, 1));
  const blob = await svgToPngBlob(svg, s);
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { data: btoa(bin), width: Math.round(w * s), height: Math.round(h * s) };
}

export interface ProjectFile {
  path: string;
  content: string;
}

/** Where an exported project keeps an asset (`/assets/<id>.png`, served from `public/assets`). */
export function assetPath(id: string): string | undefined {
  const data = assetDataUrl(id);
  return data ? `/assets/${id}.${assetExt(data)}` : undefined;
}

/** Replaces `asset:` references with the paths an exported project serves them from. */
export function withAssetPaths(text: string): string {
  return text.replace(/asset:([a-z0-9_]+)/g, (m, id) => assetPath(id) ?? m);
}

/** Generated project files with assets moved to `public/assets`. */
export function projectFiles(): { files: ProjectFile[]; binaries: { path: string; dataUrl: string }[] } {
  const files = query<ProjectFile[]>({ q: "exportProject" });
  const binaries: { path: string; dataUrl: string }[] = [];
  const seen = new Set<string>();
  const out = files.map((f) => {
    if (f.path === "design.dtron.json") return f;
    for (const id of referencedAssets(f.content)) {
      const data = assetDataUrl(id);
      const path = data ? `assets/${id}.${assetExt(data)}` : "";
      if (data && !seen.has(path)) {
        seen.add(path);
        binaries.push({ path: `public/${path}`, dataUrl: data });
      }
    }
    return { ...f, content: externalizeDataUrls(withAssetPaths(f.content), binaries, seen) };
  });
  return { files: out, binaries };
}

// ---------- Inspect downloads ----------

function dataUrlBlob(url: string): Blob {
  const [head, body = ""] = url.split(",");
  const mime = head.match(/data:([^;]+)/)?.[1] ?? "application/octet-stream";
  if (!head.includes(";base64")) return new Blob([decodeURIComponent(body)], { type: mime });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Downloads the original bytes of an image asset under a file name made from the layer's name. */
export function downloadImageAsset(assetId: string, layerName: string) {
  const data = assetDataUrl(assetId);
  if (!data) {
    toast("That image is not loaded", "error");
    return;
  }
  const blob = dataUrlBlob(data);
  download(`${fileSafe(layerName.replace(/\//g, "-"))}.${assetExt(data)}`, blob, blob.type);
}

/** Downloads a layer as its own export rows, else as SVG (vectors) or a 2x PNG. */
export async function downloadLayerAsset(id: string) {
  const node = getDoc().nodes[id];
  if (!node) return;
  if (node.exportSettings?.length) return exportLayers([id]);
  const vector = node.type === "vector" || node.type === "polygon" || node.type === "star";
  const f = await renderExport(id, vector ? { format: "svg", scale: 1, suffix: "" } : { format: "png", scale: 2, suffix: "" });
  download(f.name.replace(/\//g, "-"), f.data, f.mime);
}

/** Downloads the variables as a W3C design tokens file (`<name>-tokens.json`). */
export function exportTokensJson() {
  const text = query<string>({ q: "tokensJson" });
  download(`${fileSafe(getDoc().name)}-tokens.json`, text, "application/json");
}

export async function exportProjectZip() {
  const { files, binaries } = projectFiles();
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.content);
  for (const b of binaries) zip.file(b.path, b.dataUrl.split(",")[1], { base64: true });
  const blob = await zip.generateAsync({ type: "blob" });
  const name = `${fileSafe(getDoc().name)}-react.zip`;
  download(name, blob, "application/zip");
  toast(`Downloaded ${name}`);
}
