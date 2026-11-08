// Figma import: fetch a file through the Figma REST API (directly, or through the
// local bridge when the browser blocks it), download its images, convert in the engine.

import { addAsset, readFileAsDataUrl } from "./assets";
import { normalizeName } from "./folders";
import { bridgeChecked, bridgeHttpBase } from "./ai/bridgeClient";
import { dispatchOrThrow, zoomToFit } from "./store";

/** File key and optional node id from a figma.com URL. */
export function parseFigmaUrl(url: string): { key: string; nodeId: string | null } | null {
  const m = url.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  const node = new URL(url.includes("://") ? url : `https://${url}`).searchParams.get("node-id");
  return { key: m[1], nodeId: node ? node.replace(/-/g, ":") : null };
}

const COULD_NOT_REACH = "Couldn't reach the Figma API. Check your connection, or start the Designotron bridge (setup steps in the Claude panel) and try again.";

async function api(path: string, query: string, token: string): Promise<any> {
  const direct = `https://api.figma.com/v1/${path}${query ? `?${query}` : ""}`;
  let res: Response | null = null;
  try {
    res = await fetch(direct, { headers: { "X-Figma-Token": token } });
  } catch {
    // Blocked by the browser (CORS/network): go through the bridge.
    try {
      await bridgeChecked();
      res = await fetch(`${bridgeHttpBase()}/bridge/figma?path=${encodeURIComponent(path)}&query=${encodeURIComponent(query)}&token=${encodeURIComponent(token)}`);
    } catch {
      throw new Error(COULD_NOT_REACH);
    }
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 403) throw new Error("Figma refused the token. Create a personal access token with file read access (Figma → Settings → Security).");
    if (res.status === 404) throw new Error("File not found. Check the link, and that the token's account can open the file.");
    // An empty body or a gateway error is the dev proxy (or the bridge) failing to reach Figma.
    if (!text.trim() || [500, 502, 503, 504].includes(res.status)) throw new Error(COULD_NOT_REACH);
    let msg = "";
    try {
      const j = JSON.parse(text);
      msg = typeof j.err === "string" ? j.err : typeof j.message === "string" ? j.message : "";
    } catch {
      /* not JSON */
    }
    throw new Error(msg || `Figma answered with an error (${res.status}).`);
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

/** Everything before the conversion: the file JSON and its images (nothing in the document changes). */
export async function fetchFigmaUrl(url: string, token: string, progress: (s: string) => void): Promise<{ file: unknown; images: Record<string, string> }> {
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
  return { file, images };
}

export async function importFigmaUrl(url: string, token: string, progress: (s: string) => void): Promise<ImportResult> {
  const { file, images } = await fetchFigmaUrl(url, token, progress);
  return importFigmaJson(file, images);
}

/** The name a fetched Figma file carries, if any (cleaned and capped like any file name). */
export function figmaFileName(file: unknown): string | undefined {
  const n = (file as { name?: unknown } | null)?.name;
  return typeof n === "string" ? normalizeName(n) || undefined : undefined;
}

/** What `importFigma` needs: a file's `document.children`, or a `/nodes` response's `nodes`. Checked before a
 *  file is created for it, so JSON that isn't Figma's makes no empty file. */
export function checkFigmaJson(file: unknown): void {
  const f = file as { document?: { children?: unknown }; nodes?: unknown } | null;
  const ok = Array.isArray(f?.document?.children) || (!!f?.nodes && typeof f.nodes === "object" && !Array.isArray(f.nodes));
  if (!ok) throw new Error("This is not a Figma file: expected the JSON from the Figma REST API (/v1/files/:key)");
}
