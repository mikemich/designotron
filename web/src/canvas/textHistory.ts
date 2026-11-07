import type { TextRun } from "../types";

/** Undo and redo while a text is being edited. The whole editing session is one step of the
 * document's own history, so Ctrl+Z inside the editor works on runs of typing kept here:
 *
 * - a word is one run (it ends after the space or line break typed after a word);
 * - so is every stretch of deleting;
 * - a caret jump, a switch between typing and deleting, a paste or cut, a style change, a soft
 *   line break and an IME commit each start a run of their own;
 * - so does a pause of more than 1.5 s.
 *
 * The browser's native textarea undo isn't used (the editor sets the value itself, which would
 * leave it out of step). */

/** What an edit was. `break` is a soft line break (Shift+Enter). */
export type EditKind = "insert" | "delete" | "paste" | "style" | "ime" | "break";

/** The text, its style runs and the textarea selection (UTF-16 offsets, as the textarea reports them). */
export interface Snapshot {
  characters: string;
  runs: TextRun[];
  /** The layer-wide look a style change can touch (opaque here: the editor reads and restores it). */
  look?: unknown;
  selStart: number;
  selEnd: number;
}

interface Entry {
  before: Snapshot;
  after: Snapshot;
  kind: EditKind;
  /** When the last edit of the run happened. */
  at: number;
  /** Nothing joins this run any more. */
  closed: boolean;
}

/** A pause longer than this starts a new run. */
export const PAUSE_MS = 1500;
/** The most runs kept; older ones are dropped. */
export const MAX_RUNS = 200;

const isSpace = (c: string | undefined) => !!c && /\s/u.test(c);

export class TextHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];

  get size(): number {
    return this.undoStack.length;
  }
  get redoSize(): number {
    return this.redoStack.length;
  }

  /** The caret moved on its own (arrow keys, a click): what is typed next starts a new run, even if
   * the caret ends up where the last edit left it. */
  breakRun() {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last) last.closed = true;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Notes an edit that took the text from `before` to `after`. New input empties the redo stack. */
  record(before: Snapshot, after: Snapshot, kind: EditKind, at: number) {
    this.redoStack = [];
    const last = this.undoStack[this.undoStack.length - 1];
    const own = kind !== "insert" && kind !== "delete";
    const joins =
      !!last &&
      !own &&
      !last.closed &&
      last.kind === kind &&
      at - last.at <= PAUSE_MS &&
      // Typed or deleted right where the last edit left the caret.
      before.selStart === before.selEnd &&
      before.selStart === last.after.selStart &&
      last.after.selStart === last.after.selEnd;
    if (joins) {
      last.after = after;
      last.at = at;
    } else {
      this.undoStack.push({ before, after, kind, at, closed: false });
      if (this.undoStack.length > MAX_RUNS) this.undoStack.shift();
    }
    const run = this.undoStack[this.undoStack.length - 1];
    if (own) run.closed = true;
    // A space or line break after a word ends the run: the next word starts a new one.
    if (kind === "insert" && before.selStart === before.selEnd) {
      const grown = after.characters.length - before.characters.length;
      const typed = grown > 0 ? after.characters.slice(before.selStart, before.selStart + grown) : "";
      if (typed && isSpace(typed[typed.length - 1]) && !isSpace(before.characters[before.selStart - 1])) run.closed = true;
    }
  }

  /** The state to go back to (the text as it was before the last run), or null at the start. `current`
   * is what is shown now: redo returns to exactly that. */
  undo(current: Snapshot): Snapshot | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ ...e, after: current, closed: true });
    return e.before;
  }

  redo(current: Snapshot): Snapshot | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ ...e, before: current, closed: true });
    return e.after;
  }
}

/** The kind of edit a `beforeinput` event announces, or null for the ones history handles itself. */
export function kindOf(inputType: string): EditKind | null {
  if (inputType === "historyUndo" || inputType === "historyRedo") return null;
  if (inputType === "insertCompositionText") return "ime";
  if (inputType === "insertFromPaste" || inputType === "insertFromDrop" || inputType === "insertFromYank" || inputType === "insertReplacementText" || inputType === "deleteByCut" || inputType === "deleteByDrag") return "paste";
  if (inputType.startsWith("delete")) return "delete";
  return "insert";
}
