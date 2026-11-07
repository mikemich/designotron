// Image assets live outside the document JSON so the engine never copies
// megabytes of base64 per frame. Paints reference them as `asset:<id>`.

const dataUrls = new Map<string, string>();
const objectUrls = new Map<string, string>();

export function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  // Every character: sampling let two images that differ in a few places share an id.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 + c, 2246822519);
  }
  return "a" + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(",");
  const mime = head.match(/data:([^;]+)/)?.[1] ?? "application/octet-stream";
  const bin = head.includes(";base64") ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Pixel sizes of the images the file uses, handed to the engine (tiled fills are laid out by them).
// `src` is the paint source: `asset:<id>` or an http(s) URL.
const sizes = new Map<string, [number, number]>();
let queued: Record<string, [number, number]> = {};
let sizeSink: ((json: string) => void) | null = null;
let flushTimer: number | null = null;

function flushSizes() {
  flushTimer = null;
  if (!sizeSink || !Object.keys(queued).length) return;
  const batch = queued;
  queued = {};
  sizeSink(JSON.stringify(batch));
}

function noteSize(src: string, w: number, h: number) {
  const old = sizes.get(src);
  if (old && old[0] === w && old[1] === h) return;
  sizes.set(src, [w, h]);
  queued[src] = [w, h];
  // One call per frame however many images were measured in it.
  if (flushTimer === null) flushTimer = (typeof requestAnimationFrame === "function" ? requestAnimationFrame(flushSizes) : setTimeout(flushSizes, 0)) as unknown as number;
}

/** Where measured sizes go (the engine). Everything measured so far is sent at once. */
export function setSizeSink(sink: (json: string) => void) {
  sizeSink = sink;
  queued = Object.fromEntries(sizes);
  flushSizes();
}

/** The size measured for a paint source, if any. */
export function knownImageSize(src: string): [number, number] | undefined {
  return sizes.get(src);
}

const remoteSeen = new Set<string>();

/** Measures an image (an asset, or an http(s) source the canvas has just loaded) once; failures leave no size. */
function measureSrc(src: string, url: string) {
  void tryImageSize(url).then((s) => s && noteSize(src, s.width, s.height));
}

/** An http(s) image that has loaded: its size is read from the browser's cached copy. */
export function noteRemoteImage(src: string) {
  if (!/^https?:\/\//i.test(src) || remoteSeen.has(src)) return;
  remoteSeen.add(src);
  measureSrc(src, src);
}

/** Registers a data URL and returns its asset id. */
export function addAsset(dataUrl: string): string {
  const id = hash(dataUrl);
  if (!dataUrls.has(id)) {
    let blob: Blob;
    try {
      blob = dataUrlToBlob(dataUrl);
    } catch {
      throw new Error("image data URL is not valid base64");
    }
    // Both maps only once the image decoded: a bad one leaves nothing behind.
    objectUrls.set(id, URL.createObjectURL(blob));
    dataUrls.set(id, dataUrl);
    measureSrc("asset:" + id, dataUrl);
  }
  return id;
}

export function assetUrl(id: string): string | undefined {
  return objectUrls.get(id);
}

export function assetDataUrl(id: string): string | undefined {
  return dataUrls.get(id);
}

export function allAssets(): Record<string, string> {
  return Object.fromEntries(dataUrls);
}

export function loadAssets(map: Record<string, string> | undefined) {
  for (const [id, url] of Object.entries(map ?? {})) {
    if (!dataUrls.has(id)) {
      dataUrls.set(id, url);
      objectUrls.set(id, URL.createObjectURL(dataUrlToBlob(url)));
      measureSrc("asset:" + id, url);
    }
  }
}

/** Replaces `asset:` references with inline data URLs (for export). */
export function inlineAssets(text: string): string {
  return text.replace(/asset:([a-z0-9_]+)/g, (m, id) => dataUrls.get(id) ?? m);
}

/** Asset ids referenced in a string. */
export function referencedAssets(text: string): string[] {
  // Nothing loaded, so nothing to find (and no scan of a big document for it).
  if (dataUrls.size === 0) return [];
  return [...new Set([...text.matchAll(/asset:([a-z0-9_]+)/g)].map((m) => m[1]))];
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** The SVG's own size: `width` and `height` (plain numbers or px), else its `viewBox`. A browser reports
 *  150x150 for an SVG that only has a viewBox, so the file is read before the image is measured. */
export function svgSize(text: string): { width: number; height: number } | null {
  let root: Element | null = null;
  try {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    root = doc.documentElement.nodeName.toLowerCase() === "svg" ? doc.documentElement : null;
  } catch {
    return null;
  }
  if (!root) return null;
  const len = (v: string | null) => {
    const m = v?.trim().match(/^([0-9]*\.?[0-9]+)(px)?$/i);
    return m ? parseFloat(m[1]) : 0;
  };
  const w = len(root.getAttribute("width"));
  const h = len(root.getAttribute("height"));
  const ok = (v: { width: number; height: number } | null) => (v && Number.isFinite(v.width) && Number.isFinite(v.height) && v.width > 0 && v.height > 0 ? v : null);
  return ok(measure(w, h, root));
}

function measure(w: number, h: number, root: Element): { width: number; height: number } | null {
  const vb = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const [vw, vh] = vb.length === 4 && vb.every(Number.isFinite) ? [vb[2], vb[3]] : [0, 0];
  if (w && h) return { width: w, height: h };
  if (vw > 0 && vh > 0) {
    if (w) return { width: w, height: (w * vh) / vw };
    if (h) return { width: (h * vw) / vh, height: h };
    return { width: vw, height: vh };
  }
  return w || h ? { width: w || h, height: h || w } : null;
}

function dataUrlText(url: string): string | null {
  const m = url.match(/^data:([^,]*),([\s\S]*)$/);
  if (!m) return null;
  try {
    if (/;base64/i.test(m[1])) {
      const bin = atob(m[2]);
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    return decodeURIComponent(m[2]);
  } catch {
    return null;
  }
}

/** The image's own size, or null when it can't be read or decoded. */
export function tryImageSize(url: string): Promise<{ width: number; height: number } | null> {
  if (/^data:image\/svg\+xml/i.test(url)) {
    const text = dataUrlText(url);
    const size = text ? svgSize(text) : null;
    if (size) return Promise.resolve({ width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) });
  }
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function imageSize(url: string): Promise<{ width: number; height: number }> {
  return (await tryImageSize(url)) ?? { width: 200, height: 200 };
}

/** File extension of an asset's image type. */
export function assetExt(data: string): string {
  return data.match(/data:image\/(\w+)/)?.[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") ?? "png";
}

/** An inline image in generated code: data URLs end at a quote, bracket, space or backslash. */
const INLINE_IMAGE = /data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[^'")\s`\\]*/g;
/** Smaller inline images stay where they are (icons, 1px fills). */
const MIN_INLINE_BYTES = 1024;

/** The same URL with base64 data, so a zip entry can hold it whatever the original encoding; null
 *  when it can't be decoded (it then stays inline rather than breaking the export). */
function base64DataUrl(url: string): string | null {
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  if (url.slice(0, comma).includes(";base64")) return /^[A-Za-z0-9+/]*={0,2}$/.test(url.slice(comma + 1)) ? url : null;
  try {
    const text = decodeURIComponent(url.slice(comma + 1));
    return url.slice(0, comma).replace(/;.*$/, "") + ";base64," + btoa(unescape(encodeURIComponent(text)));
  } catch {
    return null;
  }
}

/** Moves inline images of 1 KB or more out of generated code into `public/assets`. */
export function externalizeDataUrls(
  text: string,
  binaries: { path: string; dataUrl: string }[],
  seen: Set<string>,
): string {
  return text.replace(INLINE_IMAGE, (url) => {
    if (url.length < MIN_INLINE_BYTES) return url;
    const full = base64DataUrl(url);
    if (!full) return url;
    const path = `assets/${hash(url)}.${assetExt(full)}`;
    if (!seen.has(path)) {
      seen.add(path);
      binaries.push({ path: `public/${path}`, dataUrl: full });
    }
    return `/${path}`;
  });
}
