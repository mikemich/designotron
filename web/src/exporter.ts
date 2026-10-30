// Raster/vector export and the generated-project zip.

import JSZip from "jszip";
import { assetDataUrl, inlineAssets, referencedAssets } from "./assets";
import { download } from "./files";
import { getDoc, query, toast } from "./store";

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

export async function svgToPngBlob(svg: string, scale: number, type = "image/png", background?: string): Promise<Blob> {
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
    if (background || type === "image/jpeg") {
      ctx.fillStyle = background ?? "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), type, 0.92));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function safeName(s: string): string {
  return s.replace(/[^\w\- ]+/g, "").trim() || "export";
}

export async function exportNode(id: string, format: "png" | "jpg" | "svg", scale: number, suffix = "") {
  const node = getDoc().nodes[id];
  if (!node) return;
  try {
    const svg = nodeSvg(id);
    if (format === "svg") {
      // Vector: no scale. Fonts embedded so text looks the same wherever the SVG is opened.
      download(`${safeName(node.name)}${suffix}.svg`, await embedFonts(svg), "image/svg+xml");
      return;
    }
    const { w, h } = svgSize(svg);
    const used = fitScale(w, h, scale);
    if (used < scale) {
      const px = `${Math.round(w * used)} × ${Math.round(h * used)} px`;
      toast(`${node.name} is too large to export at ${scale}x; exporting at ${used}x (${px}), the most browsers can make`, "error");
    }
    const base = safeName(node.name) + (suffix || (used !== 1 ? `@${used}x` : ""));
    const blob = await svgToPngBlob(svg, used, format === "jpg" ? "image/jpeg" : "image/png");
    download(`${base}.${format}`, blob, blob.type);
  } catch (err) {
    toast(`Could not export ${node.name}: ${err instanceof Error ? err.message : String(err)}`, "error");
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

/** Generated project files with assets moved to `public/assets`. */
export function projectFiles(): { files: ProjectFile[]; binaries: { path: string; dataUrl: string }[] } {
  const files = query<ProjectFile[]>({ q: "exportProject" });
  const binaries: { path: string; dataUrl: string }[] = [];
  const seen = new Set<string>();
  const out = files.map((f) => {
    if (f.path === "design.dtron.json") return f;
    for (const id of referencedAssets(f.content)) {
      const data = assetDataUrl(id);
      if (data && !seen.has(id)) {
        seen.add(id);
        const ext = data.match(/data:image\/(\w+)/)?.[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") ?? "png";
        binaries.push({ path: `public/assets/${id}.${ext}`, dataUrl: data });
      }
    }
    return {
      ...f,
      content: f.content.replace(/asset:([a-z0-9_]+)/g, (m, id) => {
        const b = binaries.find((x) => x.path.includes(`/${id}.`));
        return b ? b.path.replace("public", "") : m;
      }),
    };
  });
  return { files: out, binaries };
}

export async function exportProjectZip() {
  const { files, binaries } = projectFiles();
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.content);
  for (const b of binaries) zip.file(b.path, b.dataUrl.split(",")[1], { base64: true });
  const blob = await zip.generateAsync({ type: "blob" });
  download(`${safeName(getDoc().name)}-react.zip`, blob, "application/zip");
}
