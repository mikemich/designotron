import { useEffect, useRef } from "react";
import { dispatch, getDoc, query, useStore } from "../store";
import type { Mat } from "../types";
import { cssColor } from "../ui/color";

/** In-place text editing: a textarea laid over the (hidden) text node. */
export function TextEditor({ id }: { id: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const v = useStore((s) => s.viewport);
  useStore((s) => s.rev);
  const node = getDoc().nodes[id];
  const startText = useRef(node?.text?.characters ?? "");

  useEffect(() => {
    dispatch({ op: "beginGesture" });
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
    }
    return () => {
      dispatch({ op: "endGesture" });
      const n = getDoc().nodes[id];
      if (n && n.type === "text" && !n.text?.characters.trim()) dispatch({ op: "delete", ids: [id] });
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
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          finish();
        }
      }}
      data-start={startText.current}
    />
  );
}
