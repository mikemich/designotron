// Image sources a paint may use: the TypeScript twin of `paint::safe_image_src` in the engine.
// A file or a collaborator can carry any string, so UI that puts a paint's `src` into an <img>
// or a CSS url() goes through here first.

/** `asset:` ids, `data:image/` URLs and absolute `http(s)://` URLs; nothing with whitespace or
 *  control characters (browsers drop tabs and newlines inside a URL), no `//host`, no `https:host`. */
export function safeImageSrc(src: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(src)) return false;
  const lower = src.toLowerCase();
  if (lower.startsWith("data:image/")) return true;
  if (/\s/.test(src)) return false;
  return lower.startsWith("asset:") || lower.startsWith("https://") || lower.startsWith("http://");
}
