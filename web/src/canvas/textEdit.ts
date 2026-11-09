// Turns what the textarea did into the engine's range edit, and carries caret positions across
// changes that came from elsewhere. Indices are code points (the engine's); strings and offsets
// that come from the textarea are UTF-16.

/** `characters[start..end]` (code points) replaced by `text`. */
export interface RangeEdit {
  start: number;
  end: number;
  text: string;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** Whether `i` falls between the two halves of a surrogate pair of `s`. */
const splits = (s: string, i: number) => i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i));
/** Code points in `s.slice(a, b)`. */
const count = (s: string, a: number, b: number) => {
  let n = 0;
  for (let i = a; i < b; i++) {
    n++;
    if (isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1))) i++;
  }
  return n;
};

/**
 * The edit that took `old` to `next`, given where the caret ended up in `next` (a UTF-16 offset).
 * It is the usual common prefix and suffix, except that the edit is made to end at the caret: what
 * follows the caret is matched first. Typing "a" at the start of "aa" is an insert at 0 (not at 2),
 * and a backspace in "aaa" deletes the character before the caret. Surrogate pairs stay whole.
 */
export function editFromValues(old: string, next: string, caretAfter: number): RangeEdit {
  const caret = Math.min(Math.max(caretAfter, 0), next.length);
  const maxSuf = Math.min(old.length, next.length);
  const same = (k: number) => old.charCodeAt(old.length - 1 - k) === next.charCodeAt(next.length - 1 - k);
  // The tail after the caret is the old text's tail, unless the edit reached past the caret.
  let suf = 0;
  const tail = Math.min(maxSuf, next.length - caret);
  while (suf < tail && same(suf)) suf++;
  // The text after the caret changed too (autocorrect, an IME): any common suffix will do.
  if (suf < next.length - caret) while (suf < maxSuf && same(suf)) suf++;
  while (suf > 0 && (splits(old, old.length - suf) || splits(next, next.length - suf))) suf--;
  let pre = 0;
  const head = maxSuf - suf;
  while (pre < head && old.charCodeAt(pre) === next.charCodeAt(pre)) pre++;
  while (pre > 0 && (splits(old, pre) || splits(next, pre))) pre--;
  const start = count(old, 0, pre);
  return { start, end: start + count(old, pre, old.length - suf), text: next.slice(pre, next.length - suf) };
}

/**
 * Where code point index `i` of `old` is in `next` when only the part between their common prefix
 * and suffix changed (the fallback when the engine has no ids to follow): an index inside the
 * changed part goes to its end.
 */
export function shiftIndex(old: string, next: string, i: number): number {
  const a = Array.from(old);
  const b = Array.from(next);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return i <= pre ? i : i >= a.length - suf ? i + b.length - a.length : b.length - suf;
}

/** Code point index of UTF-16 `offset` in `s`. */
export const indexOfOffset = (s: string, offset: number) => count(s, 0, Math.min(offset, s.length));

/** UTF-16 offset of code point `index` in `s`. */
export function offsetOfIndex(s: string, index: number): number {
  let o = 0;
  for (let n = 0; n < index && o < s.length; n++) o += isHigh(s.charCodeAt(o)) && isLow(s.charCodeAt(o + 1)) ? 2 : 1;
  return o;
}
