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
    expect(h.redo(snap("xa", 4))?.characters).toBe("xab");
    expect(h.lastStep?.from).toEqual(snap("a", 1));
    expect(h.lastStep?.to.characters).toBe("xab");
  });

  it("has no step when there is nothing to undo", () => {
    const h = new TextHistory();
    expect(h.undo(snap("a", 1))).toBeNull();
    expect(h.lastStep).toBeNull();
  });
});
