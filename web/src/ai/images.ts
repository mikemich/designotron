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

/** Reads image files from a paste or drop event as data URLs. */
export async function imagesFrom(items: DataTransferItemList | FileList | null): Promise<{ name: string; url: string }[]> {
  if (!items) return [];
  const files: File[] = [];
  for (const it of Array.from(items as ArrayLike<DataTransferItem | File>)) {
    const f = it instanceof File ? it : it.kind === "file" ? it.getAsFile() : null;
    if (f && f.type.startsWith("image/")) files.push(f);
  }
  return Promise.all(
    files.map(async (f) => {
      const raw = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      });
      return { name: f.name || "pasted image", url: await rasterize(raw) };
    }),
  );
}
