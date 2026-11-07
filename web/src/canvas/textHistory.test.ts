import { describe, expect, it } from "vitest";
import { kindOf, MAX_RUNS, TextHistory, type EditKind, type Snapshot } from "./textHistory";

/** A text with a caret, edited the way the textarea does, recording into a history. */
class Sim {
  h = new TextHistory();
  text = "";
  caret = 0;
  sel: [number, number] | null = null;
  now = 0;
  snap(): Snapshot {
    const [a, b] = this.sel ?? [this.caret, this.caret];
    return { characters: this.text, runs: [], selStart: a, selEnd: b };
  }
  private edit(kind: EditKind, f: () => void, gap = 60) {
    this.now += gap;
    const before = this.snap();
    f();
    this.sel = null;
    this.h.record(before, this.snap(), kind, this.now);
  }
  type(s: string, gap = 60) {
    for (const c of s) {
      this.edit("insert", () => {
        const [a, b] = this.sel ?? [this.caret, this.caret];
        this.text = this.text.slice(0, a) + c + this.text.slice(b);
        this.caret = a + 1;
      }, gap);
    }
  }
  backspace(n = 1, gap = 60) {
    for (let i = 0; i < n; i++)
      this.edit("delete", () => {
        this.text = this.text.slice(0, this.caret - 1) + this.text.slice(this.caret);
        this.caret -= 1;
      }, gap);
  }
  paste(s: string) {
    this.edit("paste", () => {
      this.text = this.text.slice(0, this.caret) + s + this.text.slice(this.caret);
      this.caret += s.length;
    });
  }
  ime(s: string) {
    this.edit("ime", () => {
      this.text = this.text.slice(0, this.caret) + s + this.text.slice(this.caret);
      this.caret += s.length;
    });
  }
  jump(to: number) {
    this.caret = to;
  }
  undo(): boolean {
    const s = this.h.undo(this.snap());
    if (!s) return false;
    this.text = s.characters;
    this.caret = s.selEnd;
    return true;
  }
  redo(): boolean {
    const s = this.h.redo(this.snap());
    if (!s) return false;
    this.text = s.characters;
    this.caret = s.selEnd;
    return true;
  }
}

describe("TextHistory", () => {
  it("undoes one word at a time", () => {
    const s = new Sim();
    s.type("hello world again");
    expect(s.h.size).toBe(3);
    s.undo();
    expect(s.text).toBe("hello world ");
    s.undo();
    expect(s.text).toBe("hello ");
    s.undo();
    expect(s.text).toBe("");
    expect(s.undo()).toBe(false);
  });

  it("ends a run after the space that follows a word, not before", () => {
    const s = new Sim();
    s.type("ab");
    s.type(" ");
    s.type("cd");
    s.undo();
    expect(s.text).toBe("ab ");
    // Leading and doubled spaces don't end a run on their own.
    const t = new Sim();
    t.type("a  b");
    t.undo();
    expect(t.text).toBe("a ");
  });

  it("starts a new run at a caret jump", () => {
    const s = new Sim();
    s.type("abc");
    s.jump(1);
    s.type("X");
    expect(s.text).toBe("aXbc");
    s.undo();
    expect(s.text).toBe("abc");
    s.undo();
    expect(s.text).toBe("");
  });

  it("breakRun makes a caret that left and came back start a new run", () => {
    const s = new Sim();
    s.type("four");
    s.h.breakRun();
    s.type("X");
    s.undo();
    expect(s.text).toBe("four");
  });

  it("does not record an edit that changed nothing", () => {
    const h = new TextHistory();
    const a: Snapshot = { characters: "ab", runs: [{ start: 0, end: 2, fontWeight: 700 }], look: { x: 1 }, selStart: 0, selEnd: 2 };
    h.record(a, { ...a, runs: a.runs.map((r) => ({ ...r })) }, "style", 10);
    expect(h.size).toBe(0);
    h.record(a, { ...a, look: { x: 2 } }, "style", 20);
    expect(h.size).toBe(1);
  });

  it("keeps a stretch of deleting together and splits typing from deleting", () => {
    const s = new Sim();
    s.type("abcdef");
    s.backspace(3);
    s.type("Z");
    expect(s.text).toBe("abcZ");
    expect(s.h.size).toBe(3);
    s.undo();
    expect(s.text).toBe("abc");
    s.undo();
    expect(s.text).toBe("abcdef");
    s.undo();
    expect(s.text).toBe("");
  });

  it("gives a paste, an IME commit and a style change a run each", () => {
    const s = new Sim();
    s.type("ab");
    s.paste("PASTED");
    s.type("c");
    s.ime("かな");
    s.ime("さ");
    expect(s.h.size).toBe(5);
    s.undo();
    expect(s.text).toBe("abPASTEDcかな");
    s.undo();
    s.undo();
    expect(s.text).toBe("abPASTED");
    s.undo();
    expect(s.text).toBe("ab");
    // A style change keeps the text and restores the runs.
    const h = new TextHistory();
    const before: Snapshot = { characters: "ab", runs: [], selStart: 0, selEnd: 2 };
    const after: Snapshot = { characters: "ab", runs: [{ start: 0, end: 2, fontWeight: 700 }], selStart: 0, selEnd: 2 };
    h.record(before, after, "style", 10);
    h.record(after, { ...after, runs: [{ start: 0, end: 2, fontWeight: 700, italic: true }] }, "style", 20);
    expect(h.size).toBe(2);
    expect(h.undo(after)?.runs).toEqual(after.runs);
    expect(h.undo(after)?.runs).toEqual([]);
  });

  it("starts a new run after a pause of more than 1.5 s", () => {
    const s = new Sim();
    s.type("ab");
    s.type("c", 1500);
    expect(s.h.size).toBe(1);
    s.type("d", 1501);
    expect(s.h.size).toBe(2);
    s.undo();
    expect(s.text).toBe("abc");
  });

  it("redoes what was undone and forgets it at the next input", () => {
    const s = new Sim();
    s.type("one two");
    s.undo();
    expect(s.text).toBe("one ");
    expect(s.redo()).toBe(true);
    expect(s.text).toBe("one two");
    expect(s.redo()).toBe(false);
    s.undo();
    s.type("x");
    expect(s.h.redoSize).toBe(0);
    expect(s.redo()).toBe(false);
    expect(s.text).toBe("one x");
  });

  it("redo restores exactly what was shown at the undo", () => {
    const h = new TextHistory();
    const a: Snapshot = { characters: "", runs: [], selStart: 0, selEnd: 0 };
    const b: Snapshot = { characters: "hi", runs: [], selStart: 2, selEnd: 2 };
    h.record(a, b, "insert", 0);
    const shownNow: Snapshot = { characters: "hi!", runs: [], selStart: 3, selEnd: 3 };
    expect(h.undo(shownNow)).toEqual(a);
    expect(h.redo(a)).toEqual(shownNow);
  });

  it("typing over a selection is a run of its own", () => {
    const s = new Sim();
    s.type("hello");
    s.sel = [0, 5];
    s.type("J");
    s.type("o");
    expect(s.text).toBe("Jo");
    s.undo();
    expect(s.text).toBe("hello");
  });

  it("keeps at most 200 runs", () => {
    const s = new Sim();
    for (let i = 0; i < MAX_RUNS + 50; i++) s.type("a ");
    expect(s.h.size).toBe(MAX_RUNS);
    let n = 0;
    while (s.undo()) n++;
    expect(n).toBe(MAX_RUNS);
    expect(s.text.length).toBe(100);
  });

  it("clear drops everything", () => {
    const s = new Sim();
    s.type("a b");
    s.undo();
    s.h.clear();
    expect(s.h.size + s.h.redoSize).toBe(0);
    expect(s.undo()).toBe(false);
  });
});

describe("kindOf", () => {
  it("maps input types", () => {
    expect(kindOf("insertText")).toBe("insert");
    expect(kindOf("insertLineBreak")).toBe("insert");
    expect(kindOf("deleteContentBackward")).toBe("delete");
    expect(kindOf("deleteWordBackward")).toBe("delete");
    expect(kindOf("insertFromPaste")).toBe("paste");
    expect(kindOf("deleteByCut")).toBe("paste");
    expect(kindOf("insertCompositionText")).toBe("ime");
    expect(kindOf("historyUndo")).toBeNull();
  });
});
