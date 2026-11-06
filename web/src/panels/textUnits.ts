/**
 * One notation for line height and letter spacing, shared by the design panel and the text style
 * editor (Claude's tools read the same rule in `crates/engine/src/ai/parse.rs`). Storage stays px:
 * a percentage or em is converted with the font size at the moment it is typed.
 *
 * Both return the px value, and `undefined` for text that isn't a value (the field reverts).
 * Line height also returns `null` for automatic.
 */

/** A bare line height below this is a multiple of the font size, otherwise px. */
const MULTIPLE_BELOW = 4;

/** Line height: "", "auto", "normal", "0" -> Auto; "150%" and "1.5em" -> × size; "24px" -> 24; a bare number below 4 -> × size, else px. */
export function parseLineHeight(raw: string, size: number): number | null | undefined {
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "auto" || t === "normal") return null;
  const h = measure(t, size, (n) => (n < MULTIPLE_BELOW ? n * size : n));
  if (h === undefined) return undefined;
  if (h === 0) return null;
  return h < 0 ? undefined : h;
}

/** Letter spacing: "10%" and "0.05em" -> × size; a bare number or "px" -> px. */
export function parseLetterSpacing(raw: string, size: number): number | undefined {
  const t = raw.trim().toLowerCase();
  if (t === "") return undefined;
  return measure(t, size, (n) => n);
}

/** Number with an optional unit. `bare` turns a unitless number into px. */
function measure(t: string, size: number, bare: (n: number) => number): number | undefined {
  const m = /^(.*?)\s*(%|px|em)?$/.exec(t);
  const n = m ? arithmetic(m[1]) : undefined;
  if (n === undefined) return undefined;
  const unit = m![2];
  const v = unit === "%" ? (n / 100) * size : unit === "em" ? n * size : unit === "px" ? n : bare(n);
  return Math.round(v * 100) / 100;
}

/** A number, or simple arithmetic on numbers ("24+8", "100/2"). */
function arithmetic(s: string): number | undefined {
  if (!s || !/^[\d\s+\-*/().]+$/.test(s)) return undefined;
  try {
    const v = Function(`"use strict";return (${s})`)();
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
