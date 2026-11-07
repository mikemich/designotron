import { useEffect, useState } from "react";

/** Whether the browser can draw a font family, so a layer whose font isn't here is shown with its
 * real family instead of the first font of the picker:
 * - `bundled`: one of the families the editor offers (they load from the web);
 * - `local`: installed on this computer only, so other people see a fallback;
 * - `missing`: not available at all, the canvas draws a fallback face. */
export type FontStatus = "bundled" | "local" | "missing";

/** Width of `text` in a CSS font shorthand. */
export type Measure = (font: string, text: string) => number;

/** Wide and narrow glyphs, so a different face is very unlikely to measure the same. */
const PROBE = "mmmmmmmmmmlli1WwQ@gj";
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);

/** A family as a CSS string: quoted, with backslashes and quotes escaped (a name can hold a comma or a quote). */
export function cssFamily(family: string): string {
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

let canvasCtx: CanvasRenderingContext2D | null | undefined;
const canvasMeasure: Measure = (font, text) => {
  if (canvasCtx === undefined) canvasCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!canvasCtx) return 0;
  canvasCtx.font = font;
  return canvasCtx.measureText(text).width;
};

const memo = new Map<string, FontStatus>();
const listeners = new Set<() => void>();
let watching = false;

function watchFonts() {
  if (watching || typeof document === "undefined" || !document.fonts?.addEventListener) return;
  watching = true;
  // A font that finishes loading changes the answer for families probed before.
  document.fonts.addEventListener("loadingdone", () => {
    memo.clear();
    listeners.forEach((f) => f());
  });
}

/** Forgets every answer (tests, and after fonts load). */
export function resetFontStatus() {
  memo.clear();
}

/** The status of `family`; `bundled` lists the families the editor itself offers. */
export function fontStatus(family: string, bundled: readonly string[], measure: Measure = canvasMeasure): FontStatus {
  if (bundled.includes(family) || GENERIC.has(family.trim().toLowerCase())) return "bundled";
  const key = measure === canvasMeasure ? family : "";
  const known = key ? memo.get(key) : undefined;
  if (known) return known;
  watchFonts();
  const q = cssFamily(family);
  const differs = (generic: string) => measure(`40px ${q}, ${generic}`, PROBE) !== measure(`40px ${generic}`, PROBE);
  const out: FontStatus = differs("monospace") || differs("serif") ? "local" : "missing";
  if (key) memo.set(key, out);
  return out;
}

/** Re-renders a component when fonts finish loading (the answers may have changed). */
export function useFontEpoch(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    watchFonts();
    const f = () => setN((x) => x + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return n;
}

/** What the family picker shows for a family that isn't one of the offered ones. */
export function fontLabel(family: string, status: FontStatus): string {
  return status === "missing" ? `${family} (missing)` : status === "local" ? `${family} (this computer only)` : family;
}

/** Every family a text (or the characters `start..end` of it) is drawn in: its base family, when
 * any character uses it, and each run's own. */
export function familiesIn(t: { fontFamily: string; characters: string; runs: { start: number; end: number; fontFamily?: string }[] }, start = 0, end = Array.from(t.characters).length): string[] {
  const out = new Set<string>();
  let covered = 0;
  for (const r of t.runs ?? []) {
    const a = Math.max(r.start, start);
    const b = Math.min(r.end, end);
    if (b <= a || !r.fontFamily) continue;
    out.add(r.fontFamily);
    covered += b - a;
  }
  if (covered < end - start || end <= start) out.add(t.fontFamily);
  return [...out];
}

/** The one-line warning under the family field, or null when every family can be drawn by anyone. */
export function fontNote(families: { family: string; status: FontStatus }[]): string | null {
  const missing = families.filter((f) => f.status === "missing").map((f) => f.family);
  const local = families.filter((f) => f.status === "local").map((f) => f.family);
  const list = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`);
  if (missing.length) {
    const pick = "Pick a font to replace " + (missing.length === 1 ? "it." : "them.");
    return missing.length === 1 ? `${missing[0]} isn't available, so a fallback font is shown. ${pick}` : `${list(missing)} aren't available, so fallback fonts are shown. ${pick}`;
  }
  if (local.length) return local.length === 1 ? `${local[0]} is on this computer only; others see a fallback.` : `${list(local)} are on this computer only; others see a fallback.`;
  return null;
}
