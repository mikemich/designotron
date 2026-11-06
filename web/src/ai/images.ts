// Image helpers for chat attachments.

const MAX_SIDE = 1568;

/** Re-encodes any image URL (SVG, huge PNGs, …) as a PNG data URL no larger than the vision limit. */
export async function rasterize(url: string, maxSide = MAX_SIDE): Promise<string> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("could not load the image"));
    img.src = url;
  });
  const w = img.naturalWidth || 512;
  const h = img.naturalHeight || 512;
  const k = Math.min(1, maxSide / Math.max(w, h));
  if (k === 1 && /^data:image\/(png|jpeg|gif|webp);base64,/.test(url)) return url;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/** The images that were read, and a message for each file that was not. */
export interface ImagesRead {
  images: { name: string; url: string }[];
  errors: string[];
}

/** Reads every file with `read`; one that fails is reported and doesn't drop the others. */
export async function settleImages<F extends { name: string }>(files: F[], read: (f: F) => Promise<string>): Promise<ImagesRead> {
  const settled = await Promise.allSettled(files.map(read));
  const out: ImagesRead = { images: [], errors: [] };
  settled.forEach((r, i) => {
    const name = files[i].name || "pasted image";
    if (r.status === "fulfilled") out.images.push({ name, url: r.value });
    else out.errors.push(`Couldn't read “${name}” as an image.`);
  });
  return out;
}

async function readImage(f: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
  return rasterize(raw);
}

/** Reads image files from a paste or drop event as data URLs. Files that aren't images, and
 *  images that can't be read, come back as messages. */
export async function imagesFrom(items: DataTransferItemList | FileList | null): Promise<ImagesRead> {
  if (!items) return { images: [], errors: [] };
  const files: File[] = [];
  const others: string[] = [];
  for (const it of Array.from(items as ArrayLike<DataTransferItem | File>)) {
    const f = it instanceof File ? it : it.kind === "file" ? it.getAsFile() : null;
    if (!f) continue;
    if (f.type.startsWith("image/")) files.push(f);
    else others.push(f.name || "a file");
  }
  const out = await settleImages(files, readImage);
  if (others.length) out.errors.push(`Only images can be attached (${others.join(", ")}).`);
  return out;
}
