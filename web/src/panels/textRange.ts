import { MIXED, type Maybe } from "../ui/mixed";

export type RangeKey = "fontFamily" | "fontSize" | "fontWeight" | "italic" | "letterSpacing" | "decoration" | "color" | "link";

/** The parts of a text layer `rangeValue` reads: its base style and its styled runs. */
export interface RangeText {
  characters?: string;
  runs?: { start: number; end: number; fontWeight?: number; fontSize?: number; color?: string; link?: string }[];
}

type Bag = Record<string, unknown>;

/**
 * The value a style key has over the characters `[start, end)`: the run's override, else the
 * layer's own value (`fallback` for keys the layer doesn't hold, like colour), or MIXED when the
 * range spans different values. A collapsed range reads the character at `start`.
 */
export function rangeValue(text: RangeText, start: number, end: number, key: RangeKey, fallback?: unknown): Maybe<unknown> {
  const runs = (text.runs ?? []) as (Bag & { start: number; end: number })[];
  const base = key in text ? (text as Bag)[key] : fallback;
  const at = (pos: number) => {
    const run = runs.find((r) => r.start <= pos && pos < r.end && r[key] !== undefined);
    return run ? run[key] : base;
  };
  if (end <= start) return at(start);
  const limit = text.characters === undefined ? end : Math.min(end, Array.from(text.characters).length);
  if (limit <= start) return at(start);
  // Every place the effective value can change inside the range.
  const cuts = new Set([start]);
  for (const r of runs) {
    if (r.start > start && r.start < limit) cuts.add(r.start);
    if (r.end > start && r.end < limit) cuts.add(r.end);
  }
  const first = at(start);
  for (const c of cuts) if (at(c) !== first) return MIXED;
  return first;
}
