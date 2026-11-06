import { describe, expect, it } from "vitest";
import { caretRect, clusterAround, indexAt, lineEdge, moveVertical, paragraphRange, selectionRects, snapToGrapheme, toIndex, toOffset, wordRange, type CaretGeometry } from "./textCaret";

const line = (top: number, start: number, end: number, x0 = 0, w = 10, height = 20) => ({
  top,
  height,
  start,
  end,
  xs: Array.from({ length: end - start + 1 }, (_, i) => x0 + i * w),
});

// "aaaa bbbb cccc" wrapped into three lines (the wrap's space belongs to the earlier line),
// then a hard break and a short line "dd": chars 0..14 and 15..17.
const g: CaretGeometry = {
  lines: [line(0, 0, 5), line(20, 5, 10), line(40, 10, 14), line(70, 15, 17)],
  height: 90,
};

describe("indexAt", () => {
  it("clamps above the first line and below the last", () => {
    expect(indexAt(g, 12, -30).index).toBe(1);
    expect(indexAt(g, 12, 500).index).toBe(16);
  });
  it("picks the nearest edge on a line", () => {
    expect(indexAt(g, 24, 5).index).toBe(2);
    expect(indexAt(g, 26, 5).index).toBe(3);
  });
  it("gives the gap between paragraphs to the line above", () => {
    expect(indexAt(g, 0, 62).index).toBe(10);
  });
  it("keeps the end of a wrapped line before its wrap", () => {
    const noSpace: CaretGeometry = { lines: [line(0, 0, 4), line(20, 4, 8)], height: 40 };
    expect(indexAt(noSpace, 500, 5)).toEqual({ index: 4, affinity: "before" });
    expect(indexAt(noSpace, 0, 25)).toEqual({ index: 4, affinity: "after" });
  });
  it("handles an empty geometry", () => {
    expect(indexAt({ lines: [], height: 0 }, 5, 5).index).toBe(0);
  });
});

describe("caretRect", () => {
  const wrap: CaretGeometry = { lines: [line(0, 0, 4), line(20, 4, 8)], height: 40 };
  it("follows the affinity at a wrap boundary", () => {
    expect(caretRect(wrap, 4, "after")).toEqual({ x: 0, top: 20, height: 20 });
    expect(caretRect(wrap, 4, "before")).toEqual({ x: 40, top: 0, height: 20 });
  });
  it("clamps past the end", () => {
    expect(caretRect(wrap, 99)).toEqual({ x: 40, top: 20, height: 20 });
  });
});

describe("selectionRects", () => {
  it("makes one rectangle per line over three lines", () => {
    const r = selectionRects(g, 2, 12);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ x: 20, width: 30, top: 0 });
    expect(r[1]).toMatchObject({ x: 0, width: 50, top: 20 });
    expect(r[2]).toMatchObject({ x: 0, width: 20, top: 40 });
  });
  it("shows a selected line break and an empty line", () => {
    const r = selectionRects(g, 12, 16);
    expect(r).toHaveLength(2);
    expect(r[0].width).toBeGreaterThan(20);
    const blank: CaretGeometry = { lines: [line(0, 0, 1), line(20, 2, 2), line(40, 3, 4)], height: 60 };
    expect(selectionRects(blank, 0, 4)).toHaveLength(3);
    expect(selectionRects(blank, 0, 4)[1].width).toBeGreaterThan(0);
  });
  it("is empty for a collapsed selection", () => {
    expect(selectionRects(g, 3, 3)).toEqual([]);
  });
});

describe("moveVertical", () => {
  it("keeps a goal x across lines of different length", () => {
    const a = moveVertical(g, { index: 3, affinity: "after" }, 1, null)!;
    expect(a.goalX).toBe(30);
    expect(a.index).toBe(8);
    const short: CaretGeometry = { lines: [line(0, 0, 8), line(20, 9, 11)], height: 40 };
    const d = moveVertical(short, { index: 6, affinity: "after" }, 1, null)!;
    expect(d.index).toBe(11);
    const u = moveVertical(short, { index: d.index, affinity: d.affinity }, -1, d.goalX)!;
    expect(u.index).toBe(6);
  });
  it("goes to the start or end at the first and last line", () => {
    expect(moveVertical(g, { index: 3, affinity: "after" }, -1, null)!.index).toBe(0);
    expect(moveVertical(g, { index: 16, affinity: "after" }, 1, null)!.index).toBe(17);
  });
});

describe("lineEdge", () => {
  it("Home and End stay on the line, End before swallowed spaces", () => {
    expect(lineEdge(g, { index: 7, affinity: "after" }, "home")!.index).toBe(5);
    const withGap: CaretGeometry = { lines: [{ top: 0, height: 20, start: 0, end: 5, xs: [0, 10, 20, 30, 40, 40] }, line(20, 5, 8)], height: 40 };
    expect(lineEdge(withGap, { index: 2, affinity: "after" }, "end")).toEqual({ index: 4, affinity: "after" });
    expect(lineEdge(g, { index: 16, affinity: "after" }, "end")!.index).toBe(17);
  });
});

describe("ranges", () => {
  it("selects a word, spaces and an emoji", () => {
    expect(wordRange("hello big world", 7)).toEqual([6, 9]);
    expect(wordRange("hello  world", 5)).toEqual([5, 7]);
    expect(wordRange("a 👋 b", 2)).toEqual([2, 3]);
    expect(wordRange("hello", 5)).toEqual([0, 5]);
  });
  it("selects a paragraph", () => {
    expect(paragraphRange("one\ntwo three\nfour", 6)).toEqual([4, 13]);
    expect(paragraphRange("one\n\nfour", 4)).toEqual([4, 4]);
  });
  it("converts between code points and UTF-16 offsets", () => {
    expect(toOffset("a👋b", 2)).toBe(3);
    expect(toIndex("a👋b", 3)).toBe(2);
  });
  it("snaps into a grapheme cluster back to its start", () => {
    const t = "a👋🏽b";
    expect(snapToGrapheme(t, 2)).toBe(1);
    expect(snapToGrapheme(t, 3)).toBe(3);
    expect(snapToGrapheme(t, 1)).toBe(1);
  });
  it("finds the cluster around a position inside an emoji with joiners", () => {
    const t = "a\u{1F468}\u200D\u{1F469}\u200D\u{1F467}z";
    expect(clusterAround(t, 3)).toEqual([1, 6]);
    expect(clusterAround(t, 1)).toBeNull();
    expect(clusterAround(t, 6)).toBeNull();
    expect(snapToGrapheme(t, 4)).toBe(1);
  });
});
