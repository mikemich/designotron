import { describe, expect, it } from "vitest";
import { TextHistory, type Snapshot } from "./textHistory";

describe("TextHistory with character ids", () => {
  const seq = (k: number) => ({ e: 1, h: 2, k, s: [[0, 0, 5]] });
  const snap = (characters: string, k: number): Snapshot => ({ characters, runs: [], seq: seq(k), selStart: characters.length, selEnd: characters.length });

  it("hands back the run's own ends with their ids", () => {
    const h = new TextHistory();
    h.record(snap("a", 1), snap("ab", 2), "insert", 0);
    expect(h.undo(snap("xab", 3))?.characters).toBe("a");
    // The run is reversed from the state it left (not the one shown now), to the state before it.
    expect(h.lastStep?.from).toEqual(snap("ab", 2));
    expect(h.lastStep?.to).toEqual(snap("a", 1));
    // Redo repeats the run's own change (from the state before it to the one it made), not what was shown.
    expect(h.redo(snap("xa", 4))?.characters).toBe("xab");
    expect(h.lastStep?.from).toEqual(snap("a", 1));
    expect(h.lastStep?.to).toEqual(snap("ab", 2));
    // And the undo after it reverses the run's own end again.
    h.undo(snap("xab", 5));
    expect(h.lastStep?.from).toEqual(snap("ab", 2));
    expect(h.lastStep?.to).toEqual(snap("a", 1));
  });

  it("breaks a run when someone else edited, so an undo never spans their characters", () => {
    const h = new TextHistory();
    const at = (c: string, k: number, caret: number): Snapshot => ({ ...snap(c, k), selStart: caret, selEnd: caret });
    h.record(at("Hello", 0, 5), at("Hellof", 1, 6), "insert", 0);
    h.breakRun();
    h.record(at("HellofX", 2, 6), at("HellofoX", 3, 7), "insert", 10);
    expect(h.size).toBe(2);
    h.undo(at("HellofoX", 3, 7));
    expect(h.lastStep?.from.characters).toBe("HellofoX");
    expect(h.lastStep?.to.characters).toBe("HellofX");
  });

  it("has no step when there is nothing to undo", () => {
    const h = new TextHistory();
    expect(h.undo(snap("a", 1))).toBeNull();
    expect(h.lastStep).toBeNull();
  });
});
