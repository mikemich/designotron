// Figma import: fetch a file through the Figma REST API (directly, or through the
// local bridge when the browser blocks it), download its images, convert in the engine.

import { addAsset, readFileAsDataUrl } from "./assets";
import { bridgeHttpBase } from "./ai/bridgeClient";
import { dispatchOrThrow, zoomToFit } from "./store";

/** File key and optional node id from a figma.com URL. */
export function parseFigmaUrl(url: string): { key: string; nodeId: string | null } | null {
  const m = url.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  const node = new URL(url.includes("://") ? url : `https://${url}`).searchParams.get("node-id");
  return { key: m[1], nodeId: node ? node.replace(/-/g, ":") : null };
}

async function api(path: string, query: string, token: string): Promise<any> {
  const direct = `https://api.figma.com/v1/${path}${query ? `?${query}` : ""}`;
  let res: Response | null = null;
  try {
    res = await fetch(direct, { headers: { "X-Figma-Token": token } });
  } catch {
    // Blocked by the browser (CORS/network): go through the bridge.
    try {
      res = await fetch(`${bridgeHttpBase()}/bridge/figma?path=${encodeURIComponent(path)}&query=${encodeURIComponent(query)}&token=${encodeURIComponent(token)}`);
    } catch {
      throw new Error("Couldn't reach the Figma API. Check your connection, or start the bridge (npx designotron) and try again.");
    }
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).err ?? JSON.parse(text).message ?? text;
    } catch {
      /* plain text */
    }
    if (res.status === 403) msg = "Figma refused the token. Create a personal access token with file read access (Figma → Settings → Security).";
    if (res.status === 404) msg = "File not found. Check the link, and that the token's account can open the file.";
    throw new Error(msg);
  }
  return JSON.parse(text);
}

function imageRefs(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => imageRefs(x, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.type === "IMAGE" && typeof o.imageRef === "string") out.add(o.imageRef);
    for (const k in o) if (k !== "fillGeometry" && k !== "strokeGeometry") imageRefs(o[k], out);
  }
  return out;
}

/** Downloads images into assets; falls back to the remote URL when a download is blocked. */
async function downloadImages(urls: Record<string, string>, refs: Set<string>, progress: (s: string) => void): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const list = [...refs].filter((r) => urls[r]);
  let done = 0;
  const queue = [...list];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try {
        const blob = await (await fetch(urls[r])).blob();
        out[r] = "asset:" + addAsset(await readFileAsDataUrl(blob));
      } catch {
        out[r] = urls[r];
      }
      progress(`Downloading images ${++done}/${list.length}…`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

export interface ImportResult {
  pages: string[];
  layers: number;
  warnings: string[];
}

/** Converts already-fetched Figma JSON (file or /nodes response). */
export function importFigmaJson(file: unknown, images: Record<string, string> = {}): ImportResult {
  const r = dispatchOrThrow<ImportResult>({ op: "importFigma", file, images });
  requestAnimationFrame(zoomToFit);
  return r;
}

export async function importFigmaUrl(url: string, token: string, progress: (s: string) => void): Promise<ImportResult> {
  const parsed = parseFigmaUrl(url);
  if (!parsed) throw new Error("That doesn't look like a Figma file link (figma.com/design/…).");
  progress("Fetching the file from Figma…");
  const file = parsed.nodeId
    ? await api(`files/${parsed.key}/nodes`, `ids=${encodeURIComponent(parsed.nodeId)}&geometry=paths`, token)
    : await api(`files/${parsed.key}`, "geometry=paths", token);
  const refs = imageRefs(file);
  let images: Record<string, string> = {};
  if (refs.size) {
    progress("Fetching image links…");
    const meta = await api(`files/${parsed.key}/images`, "", token).catch(() => null);
    images = await downloadImages(meta?.meta?.images ?? {}, refs, progress);
  }
  progress("Converting…");
  return importFigmaJson(file, images);
}
