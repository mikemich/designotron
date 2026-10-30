// Image assets live outside the document JSON so the engine never copies
// megabytes of base64 per frame. Paints reference them as `asset:<id>`.

const dataUrls = new Map<string, string>();
const objectUrls = new Map<string, string>();

function hash(s: string): string {
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

/** Registers a data URL and returns its asset id. */
export function addAsset(dataUrl: string): string {
  const id = hash(dataUrl);
  if (!dataUrls.has(id)) {
    dataUrls.set(id, dataUrl);
    objectUrls.set(id, URL.createObjectURL(dataUrlToBlob(dataUrl)));
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

export function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 200, height: img.naturalHeight || 200 });
    img.onerror = () => resolve({ width: 200, height: 200 });
    img.src = url;
  });
}
