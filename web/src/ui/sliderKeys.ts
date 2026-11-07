// What a key does to the colour picker's three sliders. Pure, so the arithmetic can be tested.

export interface Hsva {
  /** 0 to 359.9 */
  h: number;
  /** 0 to 1 */
  s: number;
  /** 0 to 1 */
  v: number;
  /** 0 to 1 */
  a: number;
}

export type SliderKind = "sv" | "hue" | "alpha";

const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));

/** The colour after `key` on a slider, or null when the key does nothing there. Arrows step one whole
 *  percent (one degree on hue), Shift ten; Home and End jump to the ends. On the saturation/brightness
 *  area Left/Right change saturation and Up/Down brightness, Home/End go to no/full saturation and
 *  PageDown/PageUp to no/full brightness. */
export function sliderKey(kind: SliderKind, key: string, shift: boolean, c: Hsva): Hsva | null {
  const k = shift ? 10 : 1;
  if (kind === "sv") {
    const s = Math.round(c.s * 100);
    const v = Math.round(c.v * 100);
    switch (key) {
      case "ArrowLeft":
        return { ...c, s: clamp(s - k, 100) / 100 };
      case "ArrowRight":
        return { ...c, s: clamp(s + k, 100) / 100 };
      case "ArrowUp":
        return { ...c, v: clamp(v + k, 100) / 100 };
      case "ArrowDown":
        return { ...c, v: clamp(v - k, 100) / 100 };
      case "Home":
        return { ...c, s: 0 };
      case "End":
        return { ...c, s: 1 };
      case "PageUp":
        return { ...c, v: 1 };
      case "PageDown":
        return { ...c, v: 0 };
    }
    return null;
  }
  const dir = key === "ArrowRight" || key === "ArrowUp" ? 1 : key === "ArrowLeft" || key === "ArrowDown" ? -1 : 0;
  if (kind === "hue") {
    if (dir) return { ...c, h: clamp(Math.round(c.h) + dir * k, 359.9) };
    if (key === "Home") return { ...c, h: 0 };
    if (key === "End") return { ...c, h: 359.9 };
    return null;
  }
  if (dir) return { ...c, a: clamp(Math.round(c.a * 100) + dir * k, 100) / 100 };
  if (key === "Home") return { ...c, a: 0 };
  if (key === "End") return { ...c, a: 1 };
  return null;
}
