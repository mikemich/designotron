import { describe, expect, it } from "vitest";
import { editFromValues, indexOfOffset, offsetOfIndex, shiftIndex } from "./textEdit";

/** Applies an edit to `old` (as the engine does, on code points). */
const apply = (old: string, e: { start: number; end: number; text: string }) => {
  const c = Array.from(old);
  return [...c.slice(0, e.start), e.text, ...c.slice(e.end)].join("");
};
const check = (old: string, next: string, caret: number) => {
  const e = editFromValues(old, next, caret);
  expect(apply(old, e)).toBe(next);
  return e;
};

describe("editFromValues", () => {
  it("types at the end, the start and the middle", () => {
    expect(check("Hello", "Hello!", 6)).toEqual({ start: 5, end: 5, text: "!" });
    expect(check("Hello", "XHello", 1)).toEqual({ start: 0, end: 0, text: "X" });
    expect(check("Hello", "Heyllo", 3)).toEqual({ start: 2, end: 2, text: "y" });
  });
  it("puts a repeated character where the caret was", () => {
    expect(check("aa", "aaa", 1)).toEqual({ start: 0, end: 0, text: "a" });
    expect(check("aa", "aaa", 2)).toEqual({ start: 1, end: 1, text: "a" });
    expect(check("aa", "aaa", 3)).toEqual({ start: 2, end: 2, text: "a" });
  });
  it("backspaces and deletes forward", () => {
    expect(check("aaa", "aa", 1)).toEqual({ start: 1, end: 2, text: "" });
    expect(check("abcd", "abd", 2)).toEqual({ start: 2, end: 3, text: "" });
    expect(check("aaa", "aa", 0)).toEqual({ start: 0, end: 1, text: "" });
  });
  it("replaces a selection", () => {
    expect(check("Hello world", "Hello there", 11)).toEqual({ start: 6, end: 11, text: "there" });
    expect(check("Hello world", "Hi", 2)).toEqual({ start: 1, end: 11, text: "i" });
    expect(check("abcabc", "abXbc", 3)).toEqual({ start: 2, end: 4, text: "X" });
  });
  it("pastes a block", () => {
    expect(check("ab", "aXYZb", 4)).toEqual({ start: 1, end: 1, text: "XYZ" });
    expect(check("ab", "abab", 4)).toEqual({ start: 2, end: 2, text: "ab" });
    expect(check("ab", "abab", 2)).toEqual({ start: 0, end: 0, text: "ab" });
  });
  it("counts emoji as one character and never splits one", () => {
    expect(check("a😀b", "a😀😀b", 5)).toEqual({ start: 2, end: 2, text: "😀" });
    expect(check("a😀b", "ab", 1)).toEqual({ start: 1, end: 2, text: "" });
    // Replacing one emoji by another that shares its first half.
    expect(check("😀", "😁", 2)).toEqual({ start: 0, end: 1, text: "😁" });
  });
  it("handles empty texts and out-of-range carets", () => {
    expect(check("", "abc", 3)).toEqual({ start: 0, end: 0, text: "abc" });
    expect(check("abc", "", 0)).toEqual({ start: 0, end: 3, text: "" });
    check("abc", "abcd", 99);
    check("abc", "abcd", -4);
  });
  it("copes with a change after the caret", () => {
    check("hello wrld", "hello world!", 8);
  });
  it("round-trips random edits", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const alphabet = ["a", "b", "😀", "é", "\n"];
    for (let i = 0; i < 2000; i++) {
      const old = Array.from({ length: rnd(8) }, () => alphabet[rnd(alphabet.length)]);
      const at = rnd(old.length + 1);
      const del = rnd(old.length - at + 1);
      const ins = Array.from({ length: rnd(4) }, () => alphabet[rnd(alphabet.length)]).join("");
      const next = [...old.slice(0, at), ins, ...old.slice(at + del)].join("");
      const caret = [...old.slice(0, at), ins].join("").length;
      check(old.join(""), next, caret);
    }
  });
});

describe("indices", () => {
  it("converts between UTF-16 offsets and code points", () => {
    expect(indexOfOffset("a😀b", 3)).toBe(2);
    expect(offsetOfIndex("a😀b", 2)).toBe(3);
    expect(offsetOfIndex("ab", 9)).toBe(2);
  });
  it("shifts an index across a change", () => {
    expect(shiftIndex("Hello world", "Hello big world", 11)).toBe(15);
    expect(shiftIndex("Hello world", "Hello big world", 2)).toBe(2);
    expect(shiftIndex("abc", "aXc", 2)).toBe(2);
  });
});
