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
export async function useEyedropper(p: { x: number; y: number }, zoom: number) {
  setTool("move");
  const s = await sampleAt(p, zoom);
  if (!s) {
    toast("Nothing to sample there", "error");
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

/** The colour of the topmost visible layer at a page point, or null when the point is off every layer. Not
 * blended with the layers beneath: a half transparent layer reads as its own colour with its own alpha. */
export async function sampleAt(p: { x: number; y: number }, zoom: number): Promise<Sample | null> {
  const doc = getDoc();
  const hit = query<string | null>({ q: "hit", x: p.x, y: p.y, zoom });
  let n: Node | undefined = hit ? doc.nodes[hit] : undefined;
  if (!n) return pageBackground();
  // A layer with no fill (a stroke-only frame, a group) shows what is behind it: its parent's colour.
  while (n && !n.fills.some((f) => f.visible)) n = n.parent ? doc.nodes[n.parent] : undefined;
  if (!n) return pageBackground();
  const visible = n.fills.filter((f) => f.visible);
  if (visible.length === 1 && visible[0].type === "solid") return solid(visible[0].color, visible[0].opacity * n.opacity);
  return (await rasterSample(n.id, p)) ?? solid("#000000", 1);
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

/** Draws one layer on its own and reads the pixel at a page point (gradients, images, stacked fills). The export is
 * cropped to everything the layer paints, so it is lined up on the layer's box by its centre. */
async function rasterSample(id: string, p: { x: number; y: number }): Promise<Sample | null> {
  try {
    const svg = nodeSvg(id);
    const w = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 0);
    const h = Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 0);
    const box = query<{ items: { bounds: Rect }[] }>({ q: "bounds", ids: [id] }).items[0]?.bounds;
    if (!w || !h || !box) return null;
    const bmp = await createImageBitmap(await svgToPngBlob(svg, 1));
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const px = Math.max(0, Math.min(bmp.width - 1, Math.round(p.x - box.x + (w - box.width) / 2)));
    const py = Math.max(0, Math.min(bmp.height - 1, Math.round(p.y - box.y + (h - box.height) / 2)));
    const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
    const hex = [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    return { color: "#" + hex.toUpperCase(), opacity: Math.round((a / 255) * 1000) / 1000 };
  } catch {
    return null;
  }
}
