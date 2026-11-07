// Gradient stop helpers (pure, so they test without the editor).

export interface Stop {
  color: string;
  position: number;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parse(hex: string): Rgba {
  const h = hex.replace("#", "");
  const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { r: n(0) || 0, g: n(2) || 0, b: n(4) || 0, a: full.length >= 8 ? n(6) / 255 : 1 };
}

function format(c: Rgba): string {
  const byte = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0").toUpperCase();
  const rgb = "#" + byte(c.r) + byte(c.g) + byte(c.b);
  return c.a >= 0.999 ? rgb : rgb + byte(c.a * 255);
}

const sorted = (stops: Stop[]) => stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.position - b.s.position || a.i - b.i).map((x) => x.s);

/** The colour a gradient has at `t` (0..1): channels and alpha interpolate separately in sRGB,
 *  as the renderer's `stop-color` and `stop-opacity` do. Outside the first and last stop the end colour holds. */
export function colorAt(stops: Stop[], t: number): string {
  if (!stops.length) return "#000000";
  const s = sorted(stops);
  if (t <= s[0].position) return s[0].color;
  const last = s[s.length - 1];
  if (t >= last.position) return last.color;
  let i = 1;
  while (s[i].position < t) i++;
  const [a, b] = [s[i - 1], s[i]];
  const span = b.position - a.position;
  const k = span > 0 ? (t - a.position) / span : 0;
  const [ca, cb] = [parse(a.color), parse(b.color)];
  const mix = (x: number, y: number) => x + (y - x) * k;
  return format({ r: mix(ca.r, cb.r), g: mix(ca.g, cb.g), b: mix(ca.b, cb.b), a: mix(ca.a, cb.a) });
}

/** Adds a stop coloured by the gradient at its position: at `at` (a click on the bar), else in the
 *  middle of the widest gap between neighbouring stops (0.5 with one stop). Returns the sorted
 *  stops and the index of the new one. */
export function addStop(stops: Stop[], at?: number): { stops: Stop[]; index: number } {
  const s = sorted(stops);
  let position = at === undefined ? 0.5 : Math.max(0, Math.min(1, at));
  if (at === undefined && s.length >= 2) {
    let best = -1;
    for (let i = 1; i < s.length; i++) {
      const gap = s[i].position - s[i - 1].position;
      if (gap > best) {
        best = gap;
        position = (s[i].position + s[i - 1].position) / 2;
      }
    }
  }
  position = Math.round(position * 10000) / 10000;
  const added: Stop = { color: colorAt(s, position), position };
  // After stops already at this position, so it never takes over an existing one's index.
  let index = s.length;
  while (index > 0 && s[index - 1].position > position) index--;
  return { stops: [...s.slice(0, index), added, ...s.slice(index)], index };
}
