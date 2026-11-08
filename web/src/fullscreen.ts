// Full screen for the presenter. Not every browser has the API (iPhone Safari has neither the
// `fullscreenEnabled` flag nor `requestFullscreen`), and a browser may refuse a request.

/** The browser can put an element in full screen. */
export function canFullscreen(): boolean {
  return typeof document !== "undefined" && !!document.fullscreenEnabled && typeof document.documentElement?.requestFullscreen === "function";
}

/** Whether `el` (or something inside it) is the full screen element. */
export function isFullscreenIn(el: Element | null | undefined): boolean {
  const fs = typeof document === "undefined" ? null : document.fullscreenElement;
  return !!fs && !!el && el.contains(fs);
}

/** Enters full screen with `el`, or leaves it when something is already in full screen. False when
 *  the browser refused (or has no API), so the caller can say so. */
export async function toggleFullscreen(el: Element | null | undefined): Promise<boolean> {
  try {
    if (typeof document === "undefined") return false;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return true;
    }
    if (!el || !canFullscreen()) return false;
    await el.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

/** Leaves full screen when `el` is what is in it. Never throws. */
export function exitFullscreenIfInside(el: Element | null | undefined): void {
  if (!isFullscreenIn(el)) return;
  try {
    void document.exitFullscreen().catch(() => {});
  } catch {
    /* already out */
  }
}
