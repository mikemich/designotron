import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { dispatch, getDoc, localDispatchCount, query, styleTextSelection, useStore } from "../store";
import type { Mat, TextProps } from "../types";
import { apply, invert, type Pt } from "./geometry";
import {
  caretRect,
  indexAt,
  lineEdge,
  moveVertical,
  paragraphRange,
  selectionRects,
  clusterAround,
  snapToGrapheme,
  toIndex,
  toOffset,
  wordRange,
  type Affinity,
  type CaretGeometry,
  type Pos,
} from "./textCaret";
import { kindOf, TextHistory, type EditKind, type Snapshot } from "./textHistory";

type Look = { text: Record<string, unknown>; fills: unknown[] };

/** In-place text editing. The canvas draws the text live (all its lines, mixed styles) from the
 * engine; the textarea laid over it is only the input: keyboard, IME and screen readers (undo
 * is ours, in runs: see `textHistory`). Its text is transparent, and the caret and selection are drawn from the engine's own
 * line layout so they line up with the glyphs the canvas shows. */

/** Set by the canvas when it opened the gesture for a text layer it just created. */
let textGestureOpen = false;
export function openTextGesture() {
  dispatch({ op: "beginGesture" });
  textGestureOpen = true;
}

/** Set by the canvas when the text tool was clicked on an existing text: the caret goes to the
 * clicked point (page coordinates) instead of selecting everything. */
let caretAt: { id: string; x: number; y: number } | null = null;
export function editTextAt(id: string, page: Pt) {
  caretAt = { id, x: page.x, y: page.y };
  useStore.setState({ editingText: id });
}

const CLIP_TYPE = "application/x-designotron-text";
/** A soft line break (Shift+Enter): a new line inside a paragraph, as in Figma. */
const SOFT_BREAK = "\u2028";

/** The layer-wide look a style change can touch besides runs: styling all the text folds the style
 * into the base properties (and a colour into the fills), so undo has to carry those too. */
function readLook(id: string): Look {
  const n = getDoc().nodes[id];
  const t = n?.text;
  if (!t) return { text: {}, fills: [] };
  return {
    text: { fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: t.fontWeight, italic: t.italic, letterSpacing: t.letterSpacing, decoration: t.decoration },
    fills: JSON.parse(JSON.stringify(n.fills)),
  };
}
const sameLook = (a: Look, b: Look) => JSON.stringify(a) === JSON.stringify(b);
const sameRuns = (a: TextProps["runs"], b: TextProps["runs"]) => a === b || JSON.stringify(a) === JSON.stringify(b);

interface SpanStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  italic?: boolean;
  letterSpacing?: number;
  decoration?: "none" | "underline" | "strikethrough";
  color?: string | null;
  link?: string | null;
}
interface Span {
  start: number;
  end: number;
  style: SpanStyle;
}
interface RichText {
  text: string;
  spans: Span[];
}

const STYLE_KEYS = ["fontFamily", "fontSize", "fontWeight", "italic", "letterSpacing", "decoration"] as const;
const sameStyle = (a: SpanStyle, b: SpanStyle) => (Object.keys(a) as (keyof SpanStyle)[]).every((k) => a[k] === b[k]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The layer's solid fill colour: what text without its own colour is painted with. */
function layerColor(id: string): string | null {
  const f = getDoc().nodes[id]?.fills.find((p) => p.visible);
  return f?.type === "solid" ? String(f.color).toLowerCase() : null;
}

/** Fully resolved styles of the characters `start..end` (code points), merged into spans.
 * Linear in the text plus the runs it touches. */
function resolveSpans(t: TextProps, color: string | null, start: number, end: number): Span[] {
  const per: (TextProps["runs"][number] | undefined)[] = new Array(Math.max(end - start, 0));
  for (const r of t.runs) {
    for (let i = Math.max(r.start, start); i < Math.min(r.end, end); i++) per[i - start] = r;
  }
  const spans: Span[] = [];
  for (let i = start; i < end; i++) {
    const r = per[i - start];
    const style: SpanStyle = {
      fontFamily: r?.fontFamily ?? t.fontFamily,
      fontSize: r?.fontSize ?? t.fontSize,
      fontWeight: r?.fontWeight ?? t.fontWeight,
      italic: r?.italic ?? t.italic,
      letterSpacing: r?.letterSpacing ?? t.letterSpacing,
      decoration: r?.decoration ?? t.decoration,
      color: r?.color ? r.color.toLowerCase() : color,
      link: r?.link ?? null,
    };
    const last = spans[spans.length - 1];
    if (last && last.end === i - start && sameStyle(last.style, style)) last.end = i - start + 1;
    else spans.push({ start: i - start, end: i - start + 1, style });
  }
  return spans;
}

/** Clipboard JSON from anywhere is untrusted: keep only well-formed spans and valid style values. */
function parseRich(raw: string): RichText | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.text !== "string" || !v.text || v.text.length > 2_000_000 || !Array.isArray(v.spans) || v.spans.length > 100_000) return null;
  const len = Array.from(v.text).length;
  const spans: Span[] = [];
  for (const sp of v.spans) {
    if (!isObj(sp) || !isObj(sp.style) || !Number.isInteger(sp.start) || !Number.isInteger(sp.end)) continue;
    const start = sp.start as number;
    const end = sp.end as number;
    if (start < 0 || end > len || start >= end) continue;
    const s = sp.style;
    const style: SpanStyle = {};
    if (typeof s.fontFamily === "string" && s.fontFamily && s.fontFamily.length <= 100) style.fontFamily = s.fontFamily;
    if (typeof s.fontSize === "number" && s.fontSize >= 1 && s.fontSize <= 1000) style.fontSize = s.fontSize;
    if (typeof s.fontWeight === "number" && Number.isInteger(s.fontWeight) && s.fontWeight >= 1 && s.fontWeight <= 1000) style.fontWeight = s.fontWeight;
    if (typeof s.italic === "boolean") style.italic = s.italic;
    if (typeof s.letterSpacing === "number" && Math.abs(s.letterSpacing) <= 1000) style.letterSpacing = s.letterSpacing;
    if (s.decoration === "none" || s.decoration === "underline" || s.decoration === "strikethrough") style.decoration = s.decoration;
    if (typeof s.color === "string" && /^#[0-9a-f]{3,8}$/i.test(s.color)) style.color = s.color.toLowerCase();
    if (typeof s.link === "string" && /^(https?:\/\/|mailto:|tel:)/i.test(s.link) && s.link.length <= 2000) style.link = s.link;
    spans.push({ start, end, style });
  }
  return spans.length ? { text: v.text, spans } : null;
}

/** `runs` with the range `a..b` removed (the pasted spans replace whatever was there). */
function cutRuns(runs: TextProps["runs"], a: number, b: number): TextProps["runs"] {
  const out: TextProps["runs"] = [];
  for (const r of runs) {
    if (r.end <= a || r.start >= b) out.push(r);
    else {
      if (r.start < a) out.push({ ...r, end: a });
      if (r.end > b) out.push({ ...r, start: b });
    }
  }
  return out;
}

export function TextEditor({ id }: { id: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const v = useStore((s) => s.viewport);
  const rev = useStore((s) => s.rev);
  const node = getDoc().nodes[id];
  const startText = useRef(node?.text?.characters ?? "");
  // Undo inside the editor, in runs. `known` is the text and runs this editor last saw, so a style
  // change from the panel (or a collaborator's edit) can be told from typing.
  const history = useRef(new TextHistory());
  const known = useRef<{ characters: string; runs: TextProps["runs"]; look: Look }>({ characters: node?.text?.characters ?? "", runs: node?.text?.runs ?? [], look: readLook(id) });
  const seenOps = useRef(localDispatchCount());
  const pending = useRef<{ before: Snapshot; kind: EditKind | null } | null>(null);
  const composeBefore = useRef<Snapshot | null>(null);
  /** Edits made by the editor itself (rich paste, cut) that it records as one run when done. */
  const suppress = useRef(0);
  // The selection (code points) and which side of a wrap the caret sits on are read from the
  // textarea on every render; `sync` renders again when they changed without the document.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const drawn = useRef({ s: 0, e: 0, back: false, aff: "after" as Affinity });
  const [focused, setFocused] = useState(true);
  const affRef = useRef<Affinity>("after");
  const goalX = useRef<number | null>(null);
  const pointer = useRef("mouse");
  /** The last touch press on the textarea: where and when it went down and up. */
  const lastTouchUp = useRef(0);
  const touchDown = useRef<{ t: number; x: number; y: number; up: number; gap: number } | null>(null);
  const plainPaste = useRef(0);
  const composing = useRef(false);
  /** The full line layout of the current document revision (clicks and drags reuse it). */
  const fullLayout = useRef<{ rev: number; g: CaretGeometry | null } | null>(null);

  const readSel = () => {
    const ta = ref.current!;
    return {
      s: toIndex(ta.value, ta.selectionStart),
      e: toIndex(ta.value, ta.selectionEnd),
      back: ta.selectionDirection === "backward",
      aff: affRef.current,
    };
  };
  /** Line geometry from the engine. `range` limits the measuring to the lines it touches (and
   * one either side): all a caret or selection needs, and cheap in a long text. */
  const layout = (range?: [number, number]) => {
    if (range) return query<CaretGeometry | null>({ q: "textLayout", id, from: range[0], to: range[1] });
    const r = useStore.getState().rev;
    if (fullLayout.current?.rev !== r) fullLayout.current = { rev: r, g: query<CaretGeometry | null>({ q: "textLayout", id }) };
    return fullLayout.current.g;
  };
  // Geometry and matrix only change with the document or the selection, not with the view.
  const sel = ref.current ? readSel() : drawn.current;
  drawn.current = sel;
  const geo = useMemo(() => layout([Math.min(sel.s, sel.e), Math.max(sel.s, sel.e)]), [rev, id, sel.s, sel.e]);
  const m = useMemo(() => query<{ items: { matrix: Mat }[] }>({ q: "bounds", ids: [id] }).items[0]?.matrix, [rev, id]);
  const view = useRef({ m, v });
  view.current = { m, v };

  const sync = () => {
    if (!ref.current) return;
    const n = readSel();
    const o = drawn.current;
    if (o.s !== n.s || o.e !== n.e || o.back !== n.back || o.aff !== n.aff) redraw();
  };
  const trackSel = (ta: HTMLTextAreaElement) => {
    const before = (i: number) => Array.from(ta.value.slice(0, i)).length;
    useStore.setState({ textSel: { id, start: before(ta.selectionStart), end: before(ta.selectionEnd) } });
  };
  /** The text, runs and selection now. */
  const snapshot = (): Snapshot => {
    const ta = ref.current!;
    const runs = getDoc().nodes[id]?.text?.runs ?? [];
    return { characters: ta.value, runs: runs.map((r) => ({ ...r })), look: readLook(id), selStart: ta.selectionStart, selEnd: ta.selectionEnd };
  };
  const remember = (s: Snapshot) => {
    known.current = { characters: s.characters, runs: s.runs, look: s.look as Look };
    seenOps.current = localDispatchCount();
  };
  /** Records an edit that took the text from `before` to what it is now. */
  const note = (before: Snapshot, kind: EditKind) => {
    const after = snapshot();
    remember(after);
    history.current.record(before, after, kind, Date.now());
  };
  /** Shows a snapshot: the textarea, the selection and the layer's text and runs. */
  const showSnapshot = (s: Snapshot) => {
    const ta = ref.current;
    if (!ta) return;
    ta.value = s.characters;
    ta.setSelectionRange(s.selStart, s.selEnd);
    dispatch({ op: "setText", id, characters: s.characters, runs: s.runs }, { quiet: true });
    // A style applied to all the text lives in the layer's own properties.
    const look = s.look as Look | undefined;
    if (look && !sameLook(look, readLook(id))) dispatch({ op: "update", ids: [id], patch: { text: look.text, fills: look.fills } }, { quiet: true });
    remember(s);
    goalX.current = null;
    affRef.current = "after";
    trackSel(ta);
    sync();
  };
  const undoRedo = (redo: boolean) => {
    const ta = ref.current;
    if (!ta || composing.current) return;
    const s = redo ? history.current.redo(snapshot()) : history.current.undo(snapshot());
    // At the start (or end) of the runs there is nothing to do; never the browser's own undo.
    if (s) showSnapshot(s);
  };

  useEffect(() => {
    // New text: the canvas already opened the gesture before creating the layer, so creating
    // and typing are one undo step.
    if (textGestureOpen) textGestureOpen = false;
    else dispatch({ op: "beginGesture" });
    // Where focus was when editing began: it goes back there when editing ends.
    const from = document.activeElement as HTMLElement | null;
    const rowId = from?.closest<HTMLElement>("[data-layer]")?.dataset.layer;
    const el = ref.current;
    if (el) {
      el.focus();
      // A textarea reads line breaks as "\n": make the layer's text agree before indices are used.
      const chars0 = getDoc().nodes[id]?.text?.characters;
      if (chars0 !== undefined && chars0 !== el.value) dispatch({ op: "setText", id, characters: el.value }, { quiet: true });
      remember(snapshot());
      const at = caretAt?.id === id ? caretAt : null;
      caretAt = null;
      const g = layout();
      const mat = view.current.m;
      if (at && g && mat) {
        const p = apply(invert(mat), at);
        const hit = indexAt(g, p.x, p.y);
        const i = snapToGrapheme(el.value, hit.index);
        affRef.current = hit.affinity;
        const o = toOffset(el.value, i);
        el.setSelectionRange(o, o);
      } else el.select();
      sync();
    }
    const refocus = () => {
      const sel = useStore.getState().textSel;
      const ta = ref.current;
      if (!ta || !sel) return;
      ta.focus();
      const chars = Array.from(ta.value);
      ta.setSelectionRange(chars.slice(0, sel.start).join("").length, chars.slice(0, sel.end).join("").length);
    };
    window.addEventListener("dt-refocus-text", refocus);
    // What kind of edit is about to happen, and the text it starts from. Undo and redo that don't
    // come from the keyboard (the Edit menu, touch) arrive here too.
    const onBeforeInput = (ev: Event) => {
      const e = ev as InputEvent;
      if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
        e.preventDefault();
        undoRedo(e.inputType === "historyRedo");
        return;
      }
      if (composing.current) return;
      pending.current = { before: snapshot(), kind: kindOf(e.inputType) };
    };
    el?.addEventListener("beforeinput", onBeforeInput);
    // Some browsers report a textarea's selection only here, not on the element.
    const onSelChange = () => {
      if (document.activeElement === ref.current) sync();
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      window.removeEventListener("dt-refocus-text", refocus);
      el?.removeEventListener("beforeinput", onBeforeInput);
      document.removeEventListener("selectionchange", onSelChange);
      useStore.setState({ textSel: null });
      // Empty text is removed inside the gesture, so abandoning a new text leaves no undo step.
      const n = getDoc().nodes[id];
      if (n && n.type === "text" && !n.text?.characters.trim()) dispatch({ op: "delete", ids: [id] });
      dispatch({ op: "endGesture" });
      // The textarea is gone: unless focus went somewhere on purpose, hand it back so it never falls to the page.
      const active = document.activeElement;
      if (!active || active === document.body) {
        const row = rowId ? Array.from(document.querySelectorAll<HTMLElement>("[data-layer]")).find((r) => r.dataset.layer === rowId) : null;
        (row ?? document.getElementById("dt-canvas"))?.focus({ preventScroll: true });
      }
    };
  }, [id]);

  // The edited layer was deleted (a collaborator): end editing.
  const gone = !node || !node.text;
  useEffect(() => {
    if (gone) useStore.setState({ editingText: null });
  }, [gone]);
  // A change to the text from elsewhere (a collaborator) shows in the textarea, so the next key
  // doesn't write the old text back over it. The caret stays with the content around it: an
  // offset after the changed span moves by the change in length.
  useEffect(() => {
    const ta = ref.current;
    const cur = getDoc().nodes[id]?.text;
    const c = cur?.characters;
    if (!ta || !cur || c === undefined || composing.current) return;
    if (c !== known.current.characters) {
      // Someone else changed the text: the runs kept here no longer fit it.
      history.current.clear();
    } else if (!sameRuns(cur.runs, known.current.runs) || !sameLook(readLook(id), known.current.look)) {
      if (localDispatchCount() === seenOps.current) history.current.clear();
      else {
        // A style change from the panel or a shortcut: a run of its own, undone like typing.
        const at = { selStart: ta.selectionStart, selEnd: ta.selectionEnd };
        const now = { characters: c, runs: cur.runs.map((r) => ({ ...r })), look: readLook(id), ...at };
        history.current.record({ characters: c, runs: known.current.runs, look: known.current.look, ...at }, now, "style", Date.now());
      }
    }
    known.current = { characters: c, runs: cur.runs.map((r) => ({ ...r })), look: readLook(id) };
    seenOps.current = localDispatchCount();
    if (ta.value === c) return;
    const old = ta.value;
    let pre = 0;
    while (pre < old.length && pre < c.length && old[pre] === c[pre]) pre++;
    let suf = 0;
    while (suf < old.length - pre && suf < c.length - pre && old[old.length - 1 - suf] === c[c.length - 1 - suf]) suf++;
    const shift = (o: number) => (o <= pre ? o : o >= old.length - suf ? o + c.length - old.length : c.length - suf);
    const { selectionStart: s0, selectionEnd: e0 } = ta;
    ta.value = c;
    ta.setSelectionRange(shift(s0), shift(e0));
    sync();
  }, [rev]);

  if (!node || !node.text || !m) return null;
  const t = node.text;
  // Text the renderer skips (the layer or an ancestor is hidden) can't be drawn live: keep the
  // textarea's own glyphs then.
  let shown = true;
  for (let n: typeof node | undefined = node; n; n = n.parent ? getDoc().nodes[n.parent] : undefined) {
    if (!n.visible) {
      shown = false;
      break;
    }
  }
  const live = !!geo && shown;
  const transform = `matrix(${m.a * v.zoom},${m.b * v.zoom},${m.c * v.zoom},${m.d * v.zoom},${m.e * v.zoom + v.x},${m.f * v.zoom + v.y})`;
  const lh = t.lineHeight ?? t.fontSize * 1.2;
  const wrapsAtMax = t.autoResize === "width" && !!node.maxWidth;
  const finish = () => useStore.setState({ editingText: null });
  const trackSelection = trackSel;
  /** Current value of a style at the selection start (run override or base). */
  const styleAt = (key: "fontWeight" | "italic" | "decoration") => {
    const sel = useStore.getState().textSel;
    const run = t.runs?.find((r: any) => sel && r.start <= sel.start && r.end > sel.start) as any;
    return run?.[key] ?? (t as any)[key];
  };

  /** The text position under a client point. */
  const hitAt = (clientX: number, clientY: number): Pos | null => {
    const ta = ref.current;
    const { m: mat, v: vp } = view.current;
    const g = ta ? layout() : null;
    if (!ta || !g || !mat) return null;
    const host = (ta.offsetParent as HTMLElement | null) ?? ta.parentElement;
    const r = host?.getBoundingClientRect();
    if (!r) return null;
    const screen = { a: mat.a * vp.zoom, b: mat.b * vp.zoom, c: mat.c * vp.zoom, d: mat.d * vp.zoom, e: mat.e * vp.zoom + vp.x, f: mat.f * vp.zoom + vp.y };
    const p = apply(invert(screen), { x: clientX - r.left, y: clientY - r.top });
    const hit = indexAt(g, p.x, p.y);
    // Inside an emoji or accented letter: the nearer edge of the cluster.
    const cl = clusterAround(ta.value, hit.index);
    let index = hit.index;
    if (cl) {
      const a = caretRect(g, cl[0]);
      const b = caretRect(g, cl[1]);
      index = !a || !b || Math.abs(p.x - a.x) <= Math.abs(p.x - b.x) ? cl[0] : cl[1];
    }
    return { index, affinity: hit.affinity };
  };
  /** Selects `anchor..focus` (code points), the caret ending up at `focus`. */
  const select = (ta: HTMLTextAreaElement, anchor: number, focus: number, aff: Affinity = "after") => {
    affRef.current = aff;
    const a = Math.min(anchor, focus);
    const b = Math.max(anchor, focus);
    ta.setSelectionRange(toOffset(ta.value, a), toOffset(ta.value, b), focus < anchor ? "backward" : "forward");
    trackSelection(ta);
    sync();
  };
  const anchorFocus = (ta: HTMLTextAreaElement) => {
    const s = toIndex(ta.value, ta.selectionStart);
    const e = toIndex(ta.value, ta.selectionEnd);
    return ta.selectionDirection === "backward" ? { anchor: e, focus: s } : { anchor: s, focus: e };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    const ta = e.currentTarget;
    history.current.breakRun();
    // Touch keeps the browser's own selection handles and gestures.
    if (pointer.current === "touch" || e.button !== 0 || !geo) return;
    const hit = hitAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    ta.focus();
    goalX.current = null;
    if (e.detail >= 3) {
      const [s, en] = paragraphRange(ta.value, hit.index);
      select(ta, s, en);
      return;
    }
    if (e.detail === 2) {
      const [s, en] = wordRange(ta.value, hit.index);
      select(ta, s, en);
      return;
    }
    const anchor = e.shiftKey ? anchorFocus(ta).anchor : hit.index;
    select(ta, anchor, hit.index, hit.affinity);
    const move = (ev: MouseEvent) => {
      const h = hitAt(ev.clientX, ev.clientY);
      if (h) select(ta, anchor, h.index, h.affinity);
    };
    const up = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  };

  /** A touch tap puts the caret where the canvas draws the text (the browser places it from the
   * invisible textarea's own layout, which is wrong once sizes are mixed). It runs after the
   * browser's placement, so its handles and IME keep working; a double-tap's word stays native. */
  const onTouchTap = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const d = touchDown.current;
    if (pointer.current !== "touch" || !d) return;
    // A quick second or third tap is the browser's word or paragraph selection. A slow one (the
    // click count can still run on after the double-tap that opened the editor) is a plain tap.
    const multi = e.detail > 1 && d.gap <= 500;
    if (multi || (d.up && d.up - d.t >= 400)) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 10) return;
    const hit = hitAt(e.clientX, e.clientY);
    if (!hit) return;
    goalX.current = null;
    select(ta, hit.index, hit.index, hit.affinity);
  };

  /** The canvas menu never opens over an open editor. A touch tap that the browser reports as a
   * context menu is swallowed; a real long-press keeps the browser's own text menu. */
  const onContextMenu = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    const d = touchDown.current;
    if (pointer.current === "touch" && d && Date.now() - d.t < 450 && (!d.up || d.up - d.t < 400)) e.preventDefault();
  };

  /** Arrow Up/Down and Home/End move by the engine's lines (the textarea wraps differently
   * once sizes are mixed). Returns true when it handled the key. */
  const moveByLines = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const ta = e.currentTarget;
    // Cmd+Left/Right is Home/End on a Mac.
    const lineCmd = e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight");
    if (!geo || e.nativeEvent.isComposing || (!lineCmd && (e.metaKey || e.ctrlKey || e.altKey)) || (e.ctrlKey && lineCmd)) return false;
    const { anchor, focus } = anchorFocus(ta);
    const g = layout([focus, focus]);
    if (!g) return false;
    const pos: Pos = { index: focus, affinity: affRef.current };
    let next: Pos | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const r = moveVertical(g, pos, e.key === "ArrowUp" ? -1 : 1, goalX.current);
      if (!r) return false;
      goalX.current = r.goalX;
      next = r;
    } else if (e.key === "Home" || e.key === "End" || lineCmd) {
      next = lineEdge(g, pos, e.key === "Home" || e.key === "ArrowLeft" ? "home" : "end");
      goalX.current = null;
    }
    if (!next) return false;
    e.preventDefault();
    const index = snapToGrapheme(ta.value, next.index);
    select(ta, e.shiftKey ? anchor : index, index, next.affinity);
    return true;
  };

  const onCopy = (e: React.ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    const ta = e.currentTarget;
    if (ta.selectionStart === ta.selectionEnd) return;
    const s = toIndex(ta.value, ta.selectionStart);
    const en = toIndex(ta.value, ta.selectionEnd);
    const text = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const rich: RichText = { text, spans: resolveSpans(t, layerColor(id), s, en) };
    e.preventDefault();
    // Plain text has no soft breaks: they become line breaks. The rich clipboard keeps them.
    e.clipboardData.setData("text/plain", text.replaceAll(SOFT_BREAK, "\n"));
    e.clipboardData.setData(CLIP_TYPE, JSON.stringify(rich));
    if (cut) {
      const before = snapshot();
      suppress.current++;
      try {
        document.execCommand("delete");
      } finally {
        suppress.current--;
      }
      pending.current = null;
      note(before, "paste");
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    // Ctrl+Shift+V pastes the text only ("paste and match style").
    if (Date.now() - plainPaste.current < 1000) return;
    const raw = e.clipboardData.getData(CLIP_TYPE);
    const rich = raw ? parseRich(raw) : null;
    if (!rich) return;
    e.preventDefault();
    const at = toIndex(ta.value, ta.selectionStart);
    const before = snapshot();
    suppress.current++;
    try {
      if (!document.execCommand("insertText", false, rich.text)) {
        ta.setRangeText(rich.text, ta.selectionStart, ta.selectionEnd, "end");
        dispatch({ op: "setText", id, characters: ta.value }, { quiet: true });
      }
    } finally {
      suppress.current--;
    }
    pending.current = null;
    // Everything runs inside the editing gesture: the paste and its styles are one undo step.
    const cur = getDoc().nodes[id]?.text;
    if (!cur) return;
    const color = layerColor(id);
    const base: Record<string, unknown> = { ...cur };
    // One update of the runs, however many spans: what was in the pasted range is replaced.
    const pasted: TextProps["runs"] = [];
    for (const sp of rich.spans) {
      const run: Record<string, unknown> = { start: at + sp.start, end: at + sp.end };
      for (const k of STYLE_KEYS) if (sp.style[k] !== undefined && sp.style[k] !== base[k]) run[k] = sp.style[k];
      if (sp.style.color && sp.style.color !== color) run.color = sp.style.color;
      if (sp.style.link) run.link = sp.style.link;
      if (Object.keys(run).length > 2) pasted.push(run as unknown as TextProps["runs"][number]);
    }
    const len = Array.from(rich.text).length;
    const runs = [...cutRuns(cur.runs ?? [], at, at + len), ...pasted].sort((x, y) => x.start - y.start);
    dispatch({ op: "update", ids: [id], patch: { text: { runs } } }, { quiet: true });
    // The pasted text and its styles are one run.
    note(before, "paste");
    trackSelection(ta);
    sync();
  };

  /** Shift+Enter: a new line inside the paragraph (U+2028), its own undo run. */
  const insertSoftBreak = (ta: HTMLTextAreaElement) => {
    const before = snapshot();
    ta.setRangeText(SOFT_BREAK, ta.selectionStart, ta.selectionEnd, "end");
    goalX.current = null;
    affRef.current = "after";
    dispatch({ op: "setText", id, characters: ta.value }, { quiet: true });
    note(before, "break");
    trackSelection(ta);
    sync();
  };

  // Overlay: selection rectangles and caret, in layer px (same transform as the textarea).
  const rects = live && geo && sel.s !== sel.e ? selectionRects(geo, sel.s, sel.e) : [];
  const focusIdx = sel.back ? sel.s : sel.e;
  const caret = live && geo && sel.s === sel.e && focused ? caretRect(geo, focusIdx, sel.aff) : null;
  const barW = 1.25 / v.zoom;
  // The box of the textarea covers every line: above the layer's box too (bottom or middle
  // aligned text in a short fixed box starts above it) and below.
  const first = geo?.lines[0];
  const last = geo?.lines[geo.lines.length - 1];
  const top0 = live && first ? Math.min(0, first.top) : 0;
  const bottom = Math.max(node.height, lh, live && last ? last.top + last.height : 0);

  return (
    <>
      <svg className="text-caret" aria-hidden="true" style={{ left: 0, top: 0, transform }}>
        {rects.map((r, i) => (
          <rect key={i} className="text-sel" x={r.x} y={r.top} width={r.width} height={r.height} />
        ))}
        {caret && <rect key={`${caret.x}:${caret.top}`} className="text-caret-bar" x={caret.x - barW / 2} y={caret.top} width={barW} height={caret.height} />}
      </svg>
      <textarea
        ref={ref}
        className="text-editor"
        aria-label={"Edit text: " + (node.name || "Text")}
        data-live={live ? "" : undefined}
        spellCheck={false}
        defaultValue={t.characters}
        style={{
          left: 0,
          top: 0,
          transform: top0 ? `${transform} translate(0px, ${top0}px)` : transform,
          // Auto-width text with a max width wraps there, like the layer does.
          width: wrapsAtMax ? node.maxWidth! : Math.max(node.width, 4) + (t.autoResize === "width" ? t.fontSize : 0),
          // All lines, also the ones past a fixed box: pointer events must reach them.
          height: bottom - top0,
          font: `${t.italic ? "italic " : ""}${t.fontWeight} ${t.fontSize}px/${lh}px "${t.fontFamily}", sans-serif`,
          letterSpacing: t.letterSpacing,
          lineBreak: "strict",
          textAlign: t.alignH,
          textTransform: t.case === "upper" ? "uppercase" : t.case === "lower" ? "lowercase" : t.case === "title" ? "capitalize" : "none",
          whiteSpace: t.autoResize === "width" && !wrapsAtMax ? "pre" : "pre-wrap",
          overflowWrap: "anywhere",
        }}
        onChange={(e) => {
          goalX.current = null;
          affRef.current = "after";
          dispatch({ op: "setText", id, characters: e.target.value }, { quiet: true });
          const p = pending.current;
          pending.current = null;
          if (suppress.current || composing.current) remember(snapshot());
          // An edit with no `beforeinput` (a browser that skips it) is a run of its own.
          else if (p?.kind) note(p.before, p.kind);
          else note({ ...known.current, selStart: e.target.selectionStart, selEnd: e.target.selectionStart }, "paste");
          sync();
        }}
        onSelect={(e) => {
          trackSelection(e.currentTarget);
          sync();
        }}
        onKeyUp={(e) => {
          trackSelection(e.currentTarget);
          sync();
        }}
        onScroll={(e) => {
          // The text is drawn on the canvas: the textarea must never scroll away from it.
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
        onCompositionStart={() => {
          composing.current = true;
          composeBefore.current = snapshot();
          pending.current = null;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          // The committed text is one run, however many keys made it.
          const before = composeBefore.current;
          composeBefore.current = null;
          if (before) note(before, "ime");
        }}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          setFocused(false);
          // Keep editing while the user styles the selection in the side panel or a popover.
          const next = e.relatedTarget as HTMLElement | null;
          if (next && next.closest(".panel.right, .popover, #panel-toggle-right")) return;
          finish();
        }}
        onPointerDown={(e) => {
          pointer.current = e.pointerType;
          touchDown.current = e.pointerType === "touch" ? { t: Date.now(), x: e.clientX, y: e.clientY, up: 0, gap: lastTouchUp.current ? Date.now() - lastTouchUp.current : Infinity } : null;
          e.stopPropagation();
        }}
        onPointerUp={(e) => {
          if (touchDown.current && !touchDown.current.up) touchDown.current.up = lastTouchUp.current = Date.now();
          e.stopPropagation();
        }}
        onClick={onTouchTap}
        onContextMenu={onContextMenu}
        onMouseDown={onMouseDown}
        onCopy={(e) => onCopy(e, false)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          e.stopPropagation();
          const mod = e.metaKey || e.ctrlKey;
          const k = e.key.toLowerCase();
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) history.current.breakRun();
          if (mod && !e.altKey && !e.nativeEvent.isComposing && (k === "z" || (k === "y" && !e.shiftKey))) {
            e.preventDefault();
            undoRedo(k === "y" || e.shiftKey);
            return;
          }
          if (e.key === "Enter" && e.shiftKey && !mod && !e.altKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            insertSoftBreak(e.currentTarget);
            return;
          }
          if (mod && e.shiftKey && k === "v") plainPaste.current = Date.now();
          if (!moveByLines(e) && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
            goalX.current = null;
            affRef.current = "after";
          }
          if (e.defaultPrevented) return;
          if (mod && (k === "b" || k === "i" || k === "u")) {
            e.preventDefault();
            trackSelection(e.currentTarget);
            const style =
              k === "b"
                ? { fontWeight: (styleAt("fontWeight") ?? 400) >= 700 ? 400 : 700 }
                : k === "i"
                  ? { italic: !styleAt("italic") }
                  : { decoration: styleAt("decoration") === "underline" ? "none" : "underline" };
            styleTextSelection(style);
            return;
          }
          if (mod && !e.shiftKey && !e.altKey && k === "k") {
            // Link the selected characters: the Design panel's link field takes over.
            e.preventDefault();
            trackSelection(e.currentTarget);
            // The field lives in the Design tab: show it, then let it mount before asking it to open.
            useStore.setState({ rightTab: "design" });
            setTimeout(() => window.dispatchEvent(new Event("dt-link")), 50);
            return;
          }
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            finish();
          }
        }}
        data-start={startText.current}
      />
    </>
  );
}
