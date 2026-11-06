/** Caret and selection geometry for the text editor, from the engine's own line layout
 * (`Query::TextLayout`). Pure functions over synthetic or real geometry: no DOM here.
 * All indices are code points (chars) into the layer's `characters`, like the engine's runs. */

export interface CaretLine {
  /** Top in layer px (vertical alignment included). */
  top: number;
  height: number;
  /** Char range the line consumed. */
  start: number;
  end: number;
  /** `end - start + 1` x positions: the left edge of each char, then the end. */
  xs: number[];
}

export interface CaretGeometry {
  lines: CaretLine[];
  height: number;
}

/** At a soft-wrap boundary one index is both the end of a line and the start of the next:
 * "before" keeps the caret at the end of the earlier line, "after" at the start of the next. */
export type Affinity = "before" | "after";

export interface Pos {
  index: number;
  affinity: Affinity;
}

export interface CaretRect {
  x: number;
  top: number;
  height: number;
}

export interface SelRect {
  x: number;
  top: number;
  width: number;
  height: number;
}

/** Width given to a selected line break (and to an empty line) so it shows as selected. */
const BREAK_W = 5;

/** The line a position is on. */
export function lineOf(g: CaretGeometry, index: number, affinity: Affinity = "after"): number {
  const n = g.lines.length;
  if (n === 0) return -1;
  let found = -1;
  for (let i = 0; i < n; i++) {
    const l = g.lines[i];
    if (index >= l.start && index <= l.end) {
      found = i;
      if (affinity === "before") return i;
    }
  }
  if (found >= 0) return found;
  return index < g.lines[0].start ? 0 : n - 1;
}

export function caretRect(g: CaretGeometry, index: number, affinity: Affinity = "after"): CaretRect | null {
  const li = lineOf(g, index, affinity);
  if (li < 0) return null;
  const l = g.lines[li];
  const i = Math.min(Math.max(index - l.start, 0), l.xs.length - 1);
  return { x: l.xs[i], top: l.top, height: l.height };
}

/** Index in a line nearest to `x`. Ties go to the earlier index, so a click past the end of a
 * wrapped line lands before its trailing spaces. */
function indexInLine(g: CaretGeometry, li: number, x: number): Pos {
  const l = g.lines[li];
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < l.xs.length; i++) {
    const d = Math.abs(l.xs[i] - x);
    if (d < bd - 1e-9) {
      bd = d;
      best = i;
    }
  }
  const index = l.start + best;
  const next = g.lines[li + 1];
  // The end of a soft-wrapped line is also the start of the next one.
  const affinity: Affinity = next && index === l.end && next.start === l.end ? "before" : "after";
  return { index, affinity };
}

/** The position under a point (layer px). */
export function indexAt(g: CaretGeometry, x: number, y: number): Pos {
  const n = g.lines.length;
  if (n === 0) return { index: 0, affinity: "after" };
  let li = 0;
  if (y >= g.lines[0].top) {
    li = n - 1;
    for (let i = 0; i < n; i++) {
      const l = g.lines[i];
      const nextTop = i + 1 < n ? g.lines[i + 1].top : Infinity;
      // Gaps between paragraphs belong to the line above.
      if (y >= l.top && y < nextTop) {
        li = i;
        break;
      }
    }
  }
  return indexInLine(g, li, x);
}

/** Highlight rectangles for `start..end`, one per line. */
export function selectionRects(g: CaretGeometry, start: number, end: number): SelRect[] {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  const out: SelRect[] = [];
  if (a === b) return out;
  for (let i = 0; i < g.lines.length; i++) {
    const l = g.lines[i];
    const next = g.lines[i + 1];
    // A hard break sits between this line and the next (a soft wrap has no char of its own).
    const breakAfter = !!next && next.start > l.end;
    const from = Math.max(a, l.start);
    const to = Math.min(b, l.end);
    const coversBreak = breakAfter && b > l.end && a <= l.end;
    if (from > to || (from === to && !coversBreak)) continue;
    const x1 = l.xs[from - l.start];
    const x2 = l.xs[to - l.start] + (coversBreak && to === l.end ? BREAK_W : 0);
    if (x2 - x1 <= 0 && !coversBreak) continue;
    out.push({ x: x1, top: l.top, width: Math.max(x2 - x1, 0), height: l.height });
  }
  return out;
}

export interface VerticalMove extends Pos {
  goalX: number;
}

/** ArrowUp / ArrowDown: one line up or down, keeping the x the move started from. At the first
 * or last line the caret goes to the start or end of the text, like a text field. */
export function moveVertical(g: CaretGeometry, pos: Pos, dir: -1 | 1, goalX: number | null): VerticalMove | null {
  const li = lineOf(g, pos.index, pos.affinity);
  if (li < 0) return null;
  const x = goalX ?? caretRect(g, pos.index, pos.affinity)!.x;
  const to = li + dir;
  if (to < 0) return { index: g.lines[0].start, affinity: "after", goalX: x };
  if (to >= g.lines.length) {
    const last = g.lines[g.lines.length - 1];
    return { index: last.end, affinity: "after", goalX: x };
  }
  return { ...indexInLine(g, to, x), goalX: x };
}

/** Home / End: the start or end of the line the position is on. At the end of a soft-wrapped
 * line the caret stays before the spaces the wrap swallowed. */
export function lineEdge(g: CaretGeometry, pos: Pos, edge: "home" | "end"): Pos | null {
  const li = lineOf(g, pos.index, pos.affinity);
  if (li < 0) return null;
  const l = g.lines[li];
  if (edge === "home") return { index: l.start, affinity: "after" };
  const next = g.lines[li + 1];
  const soft = !!next && next.start === l.end;
  if (!soft) return { index: l.end, affinity: "after" };
  const endX = l.xs[l.xs.length - 1];
  let i = 0;
  while (i < l.xs.length - 1 && l.xs[i] < endX - 1e-6) i++;
  const index = l.start + i;
  return { index, affinity: index === l.end ? "before" : "after" };
}

/** Code points of `text`. */
export function chars(text: string): string[] {
  return Array.from(text);
}

const isWordChar = (c: string) => /[\p{L}\p{N}\p{M}_]/u.test(c);

/** The word (or the run of spaces or punctuation) around `index`, in code points. */
export function wordRange(text: string, index: number): [number, number] {
  const cs = chars(text);
  if (cs.length === 0) return [0, 0];
  let i = Math.min(Math.max(index, 0), cs.length);
  // A click at the very end selects the last word.
  if (i === cs.length) i--;
  const kind = (c: string) => (isWordChar(c) ? 1 : /\s/.test(c) && c !== "\n" ? 2 : c === "\n" ? 3 : 4);
  const k = kind(cs[i]);
  if (k === 3) return [i, i];
  let s = i;
  let e = i + 1;
  while (s > 0 && kind(cs[s - 1]) === k) s--;
  while (e < cs.length && kind(cs[e]) === k) e++;
  return [s, e];
}

/** The paragraph (between line breaks) around `index`. */
export function paragraphRange(text: string, index: number): [number, number] {
  const cs = chars(text);
  const i = Math.min(Math.max(index, 0), cs.length);
  let s = i;
  let e = i;
  while (s > 0 && cs[s - 1] !== "\n") s--;
  while (e < cs.length && cs[e] !== "\n") e++;
  return [s, e];
}

/** Code-point index to UTF-16 offset in `text`. */
export function toOffset(text: string, index: number): number {
  let off = 0;
  let n = 0;
  for (const c of text) {
    if (n >= index) break;
    off += c.length;
    n++;
  }
  return off;
}

/** UTF-16 offset to code-point index. */
export function toIndex(text: string, offset: number): number {
  const end = Math.min(offset, text.length);
  let n = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    // The low half of a surrogate pair belongs to the code point its high half started.
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const p = text.charCodeAt(i - 1);
      if (p >= 0xd800 && p <= 0xdbff) continue;
    }
    n++;
  }
  return n;
}

let segmenter: Intl.Segmenter | null | undefined;

/** Moves a code-point index out of the inside of a grapheme cluster (an emoji with a skin tone,
 * a letter with a combining accent) to the start of that cluster. */
export function snapToGrapheme(text: string, index: number): number {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  }
  if (!segmenter) return index;
  const off = toOffset(text, index);
  if (off <= 0 || off >= text.length) return index;
  for (const s of segmenter.segment(text)) {
    if (s.index === off) return index;
    if (s.index < off && off < s.index + s.segment.length) return toIndex(text, s.index);
    if (s.index > off) break;
  }
  return index;
}
