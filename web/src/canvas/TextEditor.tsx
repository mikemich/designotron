import { useEffect, useRef } from "react";
import { dispatch, getDoc, query, styleTextSelection, useStore } from "../store";
import type { Mat } from "../types";
import { cssColor } from "../ui/color";

/** In-place text editing: a textarea laid over the (hidden) text node. */
/** Set by the canvas when it opened the gesture for a text layer it just created. */
let textGestureOpen = false;
export function openTextGesture() {
  dispatch({ op: "beginGesture" });
  textGestureOpen = true;
}

export function TextEditor({ id }: { id: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const v = useStore((s) => s.viewport);
  useStore((s) => s.rev);
  const node = getDoc().nodes[id];
  const startText = useRef(node?.text?.characters ?? "");

  useEffect(() => {
    // New text: the canvas already opened the gesture before creating the layer, so creating
    // and typing are one undo step.
    if (textGestureOpen) textGestureOpen = false;
    else dispatch({ op: "beginGesture" });
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
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
    return () => {
      window.removeEventListener("dt-refocus-text", refocus);
      useStore.setState({ textSel: null });
      // Empty text is removed inside the gesture, so abandoning a new text leaves no undo step.
      const n = getDoc().nodes[id];
      if (n && n.type === "text" && !n.text?.characters.trim()) dispatch({ op: "delete", ids: [id] });
      dispatch({ op: "endGesture" });
    };
  }, [id]);

  if (!node || !node.text) return null;
  const t = node.text;
  const m = query<{ items: { matrix: Mat }[] }>({ q: "bounds", ids: [id] }).items[0]?.matrix;
  if (!m) return null;
  const transform = `matrix(${m.a * v.zoom},${m.b * v.zoom},${m.c * v.zoom},${m.d * v.zoom},${m.e * v.zoom + v.x},${m.f * v.zoom + v.y})`;
  const fill = node.fills.find((f) => f.visible);
  const color = fill?.type === "solid" ? cssColor(fill.color, fill.opacity) : "#000";
  const lh = t.lineHeight ?? t.fontSize * 1.2;
  const finish = () => useStore.setState({ editingText: null });
  const trackSelection = (ta: HTMLTextAreaElement) => {
    const before = (i: number) => Array.from(ta.value.slice(0, i)).length;
    useStore.setState({ textSel: { id, start: before(ta.selectionStart), end: before(ta.selectionEnd) } });
  };
  /** Current value of a style at the selection start (run override or base). */
  const styleAt = (key: "fontWeight" | "italic" | "decoration") => {
    const sel = useStore.getState().textSel;
    const run = t.runs?.find((r: any) => sel && r.start <= sel.start && r.end > sel.start) as any;
    return run?.[key] ?? (t as any)[key];
  };

  return (
    <textarea
      ref={ref}
      className="text-editor"
      spellCheck={false}
      defaultValue={t.characters}
      style={{
        left: 0,
        top: 0,
        transform,
        width: Math.max(node.width, 4) + (t.autoResize === "width" ? t.fontSize : 0),
        height: Math.max(node.height, lh),
        font: `${t.italic ? "italic " : ""}${t.fontWeight} ${t.fontSize}px/${lh}px "${t.fontFamily}", sans-serif`,
        letterSpacing: t.letterSpacing,
        color,
        textAlign: t.alignH === "justify" ? "left" : t.alignH,
        textTransform: t.case === "upper" ? "uppercase" : t.case === "lower" ? "lowercase" : t.case === "title" ? "capitalize" : "none",
        whiteSpace: t.autoResize === "width" ? "pre" : "pre-wrap",
      }}
      onChange={(e) => dispatch({ op: "setText", id, characters: e.target.value }, { quiet: true })}
      onSelect={(e) => trackSelection(e.currentTarget)}
      onKeyUp={(e) => trackSelection(e.currentTarget)}
      onBlur={(e) => {
        // Keep editing while the user styles the selection in the side panel or a popover.
        const next = e.relatedTarget as HTMLElement | null;
        if (next && next.closest(".panel.right, .popover")) return;
        finish();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        const mod = e.metaKey || e.ctrlKey;
        const k = e.key.toLowerCase();
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
        if (mod && k === "k") {
          // Link the selected characters: the Design panel's link field takes over.
          e.preventDefault();
          trackSelection(e.currentTarget);
          window.dispatchEvent(new Event("dt-link"));
          return;
        }
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          finish();
        }
      }}
      data-start={startText.current}
    />
  );
}
