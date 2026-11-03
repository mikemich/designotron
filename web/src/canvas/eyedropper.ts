// Eyedropper tool (I): samples the colour of the topmost layer under a click.

import { nodeSvg, svgToPngBlob } from "../exporter";
import { dispatch, getDoc, query, selection, setTool, toast, useStore } from "../store";
import type { Node, Rect } from "../types";

export interface Sample {
  /** `#RRGGBB`. */
  color: string;
  /** 0..1, folded from the paint's and the layer's opacity (and a colour's own alpha). */
  opacity: number;
}

/** Samples the page point, then fills every selected layer with it (one undo step). With nothing
 * selected the colour is copied to the clipboard instead. The tool is one-shot: it ends here. */
export async function pickColorAt(p: { x: number; y: number }, zoom: number) {
  setTool("move");
  const s = await sampleAt(p, zoom);
  if (!s) {
    toast("Couldn't sample that colour", "error");
    return;
  }
  const ids = selection();
  if (!ids.length) {
    const hex = s.color.toUpperCase();
    try {
      await navigator.clipboard.writeText(hex);
      toast(`Copied ${hex}`);
    } catch {
      toast(`${hex} (couldn't reach the clipboard)`);
    }
    return;
  }
  dispatch({ op: "update", ids, patch: { fills: [{ type: "solid", color: s.color, opacity: s.opacity, visible: true }] } });
}

/** The colour of the topmost visible layer at a page point, or null when it can't be read. A layer with one
 * visible solid fill gives that fill directly. Anything else (no fill, gradients, images, several fills) is
 * drawn: its top-level layer is rasterised and the pixel at the point read, so what shows through counts;
 * a transparent pixel reads as the page background. Limitation: images that live on the web (http URLs) can't
 * be fetched while sampling, so they read as the placeholder the export draws for them. */
export async function sampleAt(p: { x: number; y: number }, zoom: number): Promise<Sample | null> {
  const doc = getDoc();
  const hit = query<string | null>({ q: "hit", x: p.x, y: p.y, zoom });
  const n: Node | undefined = hit ? doc.nodes[hit] : undefined;
  const visible = n?.fills.filter((f) => f.visible) ?? [];
  if (n && visible.length === 1 && visible[0].type === "solid") return solid(visible[0].color, visible[0].opacity * n.opacity);
  // The hit's top-level layer first, then the ones under it: the first that paints something at the point.
  // Off every layer's geometry (a drop shadow, say) all top-level layers are candidates.
  let top = n;
  while (top?.parent && doc.nodes[top.parent]) top = doc.nodes[top.parent];
  const roots = doc.pages.find((pg) => pg.id === (top?.page ?? useStore.getState().es.page))?.children ?? [];
  const under = (top ? roots.slice(0, roots.indexOf(top.id) + 1) : roots).slice().reverse();
  // Painted bounds (shadows, outside strokes): that is the area the export covers and where its pixels start.
  const boxes = query<{ items: { id: string; painted: Rect }[] }>({ q: "bounds", ids: under, painted: true }).items;
  for (const { id, painted: b } of boxes) {
    if (p.x < b.x || p.y < b.y || p.x > b.x + b.width || p.y > b.y + b.height) continue;
    const px = await rasterSample(id, p, b);
    if (!px) return null;
    if (px.opacity >= 0.01) return px;
  }
  return pageBackground();
}

function pageBackground(): Sample | null {
  const doc = getDoc();
  const bg = doc.pages.find((pg) => pg.id === useStore.getState().es.page)?.background;
  return bg ? solid(bg, 1) : null;
}

/** `#RRGGBB[AA]` to a sample, the colour's own alpha folded into the opacity. */
function solid(color: string, opacity: number): Sample {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (!m) return { color: "#000000", opacity };
  const alpha = m[2] ? parseInt(m[2], 16) / 255 : 1;
  return { color: "#" + m[1].toUpperCase(), opacity: Math.round(opacity * alpha * 1000) / 1000 };
}

/** Draws one layer on its own and reads the pixel at a page point (gradients, images, stacked fills). The export
 * is cropped to what the layer paints, so `painted` (page space) is where its pixels start. */
async function rasterSample(id: string, p: { x: number; y: number }, painted: Rect): Promise<Sample | null> {
  try {
    const bmp = await createImageBitmap(await svgToPngBlob(nodeSvg(id), 1));
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const px = Math.max(0, Math.min(bmp.width - 1, Math.floor(p.x - painted.x)));
    const py = Math.max(0, Math.min(bmp.height - 1, Math.floor(p.y - painted.y)));
    const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
    const hex = [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    return { color: "#" + hex.toUpperCase(), opacity: Math.round((a / 255) * 1000) / 1000 };
  } catch {
    return null;
  }
}
