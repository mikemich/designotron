// Downloads a chosen photo and turns it into a safe, small data URL for `addAsset`.
// Only hosts on the provider's list are fetched; the body must be a JPEG, PNG or WebP (by header
// and by magic bytes), is capped at 15 MB while streaming, and is re-encoded at <= 1600 px, which
// also drops EXIF/GPS data.

import { assertHost, PhotoError, PROVIDERS, type PhotoResult } from "./providers";

export type ImageKind = "jpeg" | "png" | "webp";

export interface Downloaded {
  dataUrl: string;
  width: number;
  height: number;
}

export interface DownloadEnv {
  fetch: typeof fetch;
  /** Decodes and re-encodes the bytes (defaults to a canvas in the browser). */
  reencode?: (bytes: Uint8Array, kind: ImageKind) => Promise<Downloaded>;
}

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_SIDE = 1600;
const TIMEOUT_MS = 30000;

export async function downloadPhoto(env: DownloadEnv, r: PhotoResult): Promise<Downloaded> {
  const hosts = PROVIDERS[r.provider].imageHosts;
  const { bytes, kind } = await fetchImageBytes(env.fetch, r.downloadUrl, hosts);
  try {
    return await (env.reencode ?? reencodeInBrowser)(bytes, kind);
  } catch (err) {
    if (err instanceof PhotoError) throw err;
    throw new PhotoError("bad", "That image couldn't be decoded");
  }
}

export async function fetchImageBytes(fetchFn: typeof fetch, url: string, hosts: string[], cap = MAX_IMAGE_BYTES): Promise<{ bytes: Uint8Array; kind: ImageKind }> {
  assertHost(url, hosts);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchFn(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: ctl.signal });
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") throw new PhotoError("timeout", "The photo took too long to download");
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new PhotoError("offline", "Photo search needs the internet");
      throw new PhotoError("http", "Couldn't download the photo");
    }
    // A redirect may only lead to another allowed host.
    if (res.url) assertHost(res.url, hosts);
    if (res.status === 429) throw new PhotoError("rateLimited", "The photo host is rate limiting downloads", { status: 429 });
    if (!res.ok) throw new PhotoError("http", `The photo host answered ${res.status}`, { status: res.status });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const declared = KINDS[type];
    if (!declared) throw new PhotoError("bad", `Refusing that file (${type || "unknown type"}); only JPEG, PNG and WebP photos are used`);
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > cap) throw new PhotoError("bad", "That photo is too large (over 15 MB)");
    const bytes = await readBody(res, cap);
    const sniffed = sniff(bytes);
    if (!sniffed || sniffed !== declared) throw new PhotoError("bad", "That file isn't the image type it claims to be");
    return { bytes, kind: sniffed };
  } finally {
    clearTimeout(timer);
  }
}

/** The image type the first bytes say, or null. */
export function sniff(b: Uint8Array): ImageKind | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
  return null;
}

const KINDS: Record<string, ImageKind | undefined> = { "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/png": "png", "image/webp": "webp" };

async function readBody(res: Response, cap: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > cap) throw new PhotoError("bad", "That photo is too large (over 15 MB)");
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      reader.cancel().catch(() => {});
      throw new PhotoError("bad", "That photo is too large (over 15 MB)");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function reencodeInBrowser(bytes: Uint8Array, kind: ImageKind): Promise<Downloaded> {
  const mime = kind === "jpeg" ? "image/jpeg" : kind === "png" ? "image/png" : "image/webp";
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * k));
    const height = Math.max(1, Math.round(bitmap.height * k));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoError("bad", "This browser can't decode images");
    ctx.drawImage(bitmap, 0, 0, width, height);
    // JPEG stays JPEG; PNG and WebP become PNG so transparency survives.
    const dataUrl = kind === "jpeg" ? canvas.toDataURL("image/jpeg", 0.82) : canvas.toDataURL("image/png");
    return { dataUrl, width, height };
  } finally {
    bitmap.close();
  }
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, to));
}
