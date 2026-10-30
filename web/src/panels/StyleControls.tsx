// Colour and text styles: the applied-style chips in the design panel, the "apply style"
// menus, and the editable style lists in the Assets tab.

import { useState } from "react";
import { LayoutGrid, Pencil, Plus, Trash2, Unlink } from "lucide-react";
import { dispatch, dispatchOrThrow, FONTS, getDoc, toast, useDoc, useStore } from "../store";
import type { Doc, Node } from "../types";
import { common, IconButton, Menu, MIXED, NumberField, Popover, SelectField, type MenuItem } from "../ui/controls";
import { ColorPicker, cssColor } from "../ui/color";
import { addDefaultTextStyle, batch, deleteStyle, nextName, updateColorStyle, updateTextStyle } from "../componentOps";
import { InlineInput } from "./InlineInput";
import "./workflow.css";

type ColorStyle = Doc["styles"]["colors"][number];
type TextStyle = Doc["styles"]["texts"][number];

const WEIGHTS = [
  { value: 100, label: "Thin" },
  { value: 200, label: "Extra light" },
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semibold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "Extra bold" },
  { value: 900, label: "Black" },
];

const begin = () => dispatch({ op: "beginGesture" });
const end = () => dispatch({ op: "endGesture" });

// ---------- Design panel ----------

/** Shows the colour or text style linked to the selection, with a detach button. */
export function StyleChip({ kind, nodes, ids }: { kind: "fill" | "text"; nodes: Node[]; ids: string[] }) {
  const doc = useDoc();
  const key = kind === "fill" ? "fillStyle" : "textStyle";
  const linked = common(nodes, (n) => n[key]);
  if (linked === null || (linked === MIXED && !nodes.some((n) => n[key]))) return null;
  const detach = () => dispatch({ op: "update", ids, patch: { [key]: null } });
  const color = linked !== MIXED && kind === "fill" ? doc.styles.colors.find((s) => s.id === linked) : undefined;
  const text = linked !== MIXED && kind === "text" ? doc.styles.texts.find((s) => s.id === linked) : undefined;
  const name = linked === MIXED ? "Mixed styles" : (color?.name ?? text?.name ?? "Missing style");
  return (
    <div className="row wf-chip-row">
      <div className="wf-chip" title={kind === "fill" ? "Colour style" : "Text style"}>
        {color && (
          <span className="swatch wf-chip-swatch">
            <i style={{ background: cssColor(color.color) }} />
          </span>
        )}
        {text && (
          <span className="wf-chip-ag" style={{ fontFamily: text.fontFamily, fontWeight: text.fontWeight }}>
            Ag
          </span>
        )}
        <span className="wf-chip-name">{name}</span>
        {text && (
          <span className="muted small">
            {textStyleLabel(text)}
          </span>
        )}
      </div>
      <IconButton title="Detach style" onClick={detach}>
        <Unlink size={13} />
      </IconButton>
    </div>
  );
}

/** Header button listing the file's colour or text styles to apply to `ids`. */
export function ApplyStyleButton({ kind, ids }: { kind: "fill" | "text"; ids: string[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const doc = getDoc();
    const styles = kind === "fill" ? doc.styles.colors : doc.styles.texts;
    const items: MenuItem[] = [{ heading: kind === "fill" ? "Colour styles" : "Text styles" }];
    for (const s of styles) items.push({ label: s.name, onClick: () => dispatch({ op: "applyStyle", ids, styleId: s.id }) });
    if (!styles.length) items.push({ label: "No styles yet", disabled: true });
    items.push({ sep: true }, { label: "Manage styles in Assets", onClick: () => useStore.setState({ leftTab: "assets" }) });
    setMenu({ x: r.left - 200, y: r.bottom + 4, items });
  };
  return (
    <>
      <IconButton title={kind === "fill" ? "Apply colour style" : "Apply text style"} onClick={open}>
        <LayoutGrid size={13} />
      </IconButton>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </>
  );
}

// ---------- Assets tab ----------

export function ColorStylesSection({ filter = "" }: { filter?: string }) {
  const doc = useDoc();
  const sel = useStore((s) => s.es.selection);
  const [editing, setEditing] = useState<string | null>(null);
  const add = () => {
    const n = getDoc().nodes[sel[0]];
    // A colour style holds one solid colour: use the first visible solid fill, and refuse
    // (rather than invent a colour) when the only visible fills are gradients or images.
    const f = n?.fills.find((p) => p.visible && p.type === "solid");
    if (n && !f && n.fills.some((p) => p.visible)) {
      toast("Colour styles hold a single solid colour. Select a layer with a solid fill, or change this fill to solid first.", "error");
      return;
    }
    const color = f && f.type === "solid" ? f.color : "#7C5CFF";
    let id = "";
    const ok = batch(() => {
      id = dispatchOrThrow<{ id: string }>({ op: "addColorStyle", name: nextName("Colour", doc.styles.colors.map((s) => s.name)), color }).id;
      if (n && f) dispatchOrThrow({ op: "applyStyle", ids: [n.id], styleId: id });
    });
    if (ok) setEditing(id);
  };
  return (
    <div className="section">
      <div className="section-head">
        <span>Colour styles</span>
        <IconButton title={sel.length ? "Create colour style from selection" : "Create colour style"} onClick={add}>
          <Plus size={14} />
        </IconButton>
      </div>
      {doc.styles.colors.length === 0 && <div className="muted small">Shared colours. Select a layer and click + to save its fill.</div>}
      {doc.styles.colors.filter((s) => matches(s.name, filter) || editing === s.id).map((s) => (
        <ColorStyleRow key={s.id} s={s} sel={sel} editing={editing === s.id} setEditing={(on) => setEditing(on ? s.id : null)} />
      ))}
    </div>
  );
}

function ColorStyleRow({ s, sel, editing, setEditing }: { s: ColorStyle; sel: string[]; editing: boolean; setEditing: (on: boolean) => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const hex = s.color.toUpperCase().endsWith("FF") && s.color.length === 9 ? s.color.slice(0, 7).toUpperCase() : s.color.toUpperCase();
  return (
    <div className={"wf-style" + (editing ? " editing" : "")}>
      <div className="wf-style-row" onClick={() => sel.length && dispatch({ op: "applyStyle", ids: sel, styleId: s.id })} title={sel.length ? "Apply to selection" : s.name}>
        <div
          className="swatch"
          title="Edit colour"
          onClick={(e) => {
            e.stopPropagation();
            setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
            begin();
          }}
        >
          <i style={{ background: cssColor(s.color) }} />
        </div>
        <span className="wf-style-name" onDoubleClick={() => setEditing(true)}>
          {s.name}
        </span>
        <span className="muted small">{hex}</span>
        <StyleRowTools editing={editing} setEditing={setEditing} onDelete={() => deleteStyle(s.id)} />
      </div>
      {editing && (
        <div className="wf-style-edit">
          <InlineInput label="Name" value={s.name} autoFocus title="Style name" onCommit={(name) => (name.trim() ? updateColorStyle(s.id, { name: name.trim() }) : false)} />
          <InlineInput
            label="Hex"
            value={hex.replace("#", "")}
            title="Colour (hex)"
            onCommit={(v) => {
              const h = v.replace("#", "").trim();
              if (!/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return false;
              return updateColorStyle(s.id, { color: "#" + (h.length === 3 ? h.split("").map((c) => c + c).join("") : h).toUpperCase() });
            }}
          />
        </div>
      )}
      {anchor && (
        <Popover
          anchor={anchor}
          onClose={() => {
            setAnchor(null);
            end();
          }}
        >
          <ColorPicker color={s.color} onChange={(color) => updateColorStyle(s.id, { color })} />
        </Popover>
      )}
    </div>
  );
}

export function TextStylesSection({ filter = "" }: { filter?: string }) {
  const doc = useDoc();
  const sel = useStore((s) => s.es.selection);
  // Text style edits re-create the style (new id), so rows are tracked by position.
  const [editing, setEditing] = useState<number | null>(null);
  const add = () => {
    const d = getDoc();
    const n = d.nodes[sel[0]];
    const name = nextName("Text", d.styles.texts.map((s) => s.name));
    const ok = n?.type === "text" ? dispatch({ op: "addTextStyle", name, from: n.id }) !== null : addDefaultTextStyle(name);
    if (ok) setEditing(getDoc().styles.texts.length - 1);
  };
  return (
    <div className="section">
      <div className="section-head">
        <span>Text styles</span>
        <IconButton title="Create text style (from the selected text, if any)" onClick={add}>
          <Plus size={14} />
        </IconButton>
      </div>
      {doc.styles.texts.length === 0 && <div className="muted small">Shared type settings. Select a text layer and click + to save its style.</div>}
      {doc.styles.texts.map((s, i) => (matches(s.name, filter) || editing === i) && (
        <TextStyleRow key={i} s={s} index={i} sel={sel} editing={editing === i} setEditing={(on) => setEditing(on ? i : null)} />
      ))}
    </div>
  );
}

function TextStyleRow({ s, index, sel, editing, setEditing }: { s: TextStyle; index: number; sel: string[]; editing: boolean; setEditing: (on: boolean) => void }) {
  const set = (change: Partial<Omit<TextStyle, "id">>) => updateTextStyle(index, change);
  const fonts = FONTS.includes(s.fontFamily) ? FONTS : [s.fontFamily, ...FONTS];
  const weights = WEIGHTS.some((w) => w.value === s.fontWeight) ? WEIGHTS : [...WEIGHTS, { value: s.fontWeight, label: String(s.fontWeight) }];
  return (
    <div className={"wf-style" + (editing ? " editing" : "")}>
      <div className="wf-style-row" onClick={() => sel.length && dispatch({ op: "applyStyle", ids: sel, styleId: s.id })} title={sel.length ? "Apply to selection" : s.name}>
        <span className="wf-ag" style={{ fontFamily: s.fontFamily, fontWeight: s.fontWeight }}>
          Ag
        </span>
        <span className="wf-style-name" onDoubleClick={() => setEditing(true)}>
          {s.name}
        </span>
        <span className="muted small">{textStyleLabel(s)}</span>
        <StyleRowTools editing={editing} setEditing={setEditing} onDelete={() => deleteStyle(s.id)} />
      </div>
      {editing && (
        <div className="wf-style-edit">
          <InlineInput label="Name" value={s.name} autoFocus title="Style name" onCommit={(name) => set({ name })} />
          <SelectField value={s.fontFamily} options={fonts.map((f) => ({ value: f, label: f }))} onChange={(fontFamily) => set({ fontFamily })} title="Font" />
          <div className="grid2">
            <SelectField value={s.fontWeight} options={weights} onChange={(fontWeight) => set({ fontWeight })} title="Weight" />
            <NumberField label="Aa" title="Font size" value={s.fontSize} min={1} onChange={(fontSize) => set({ fontSize })} onScrubStart={begin} onScrubEnd={end} />
          </div>
          <div className="grid2">
            <NumberField
              label="↨"
              title="Line height (px; 0 or empty for auto)"
              value={s.lineHeight ?? null}
              autoValue={Math.round(s.fontSize * 1.2)}
              min={0}
              onChange={(lh) => set({ lineHeight: lh || null })}
              onScrubStart={begin}
              onScrubEnd={end}
            />
            <NumberField label="|A|" title="Letter spacing" value={s.letterSpacing} step={0.1} onChange={(letterSpacing) => set({ letterSpacing })} onScrubStart={begin} onScrubEnd={end} />
          </div>
        </div>
      )}
    </div>
  );
}

/** "32/Auto": size / line height, the same everywhere a text style is summarised. */
export function textStyleLabel(s: { fontSize: number; lineHeight: number | null }): string {
  const n = (v: number) => String(Math.round(v * 100) / 100);
  return `${n(s.fontSize)}/${s.lineHeight == null ? "Auto" : n(s.lineHeight)}`;
}

function matches(name: string, filter: string): boolean {
  return name.toLowerCase().includes(filter.trim().toLowerCase());
}

function StyleRowTools({ editing, setEditing, onDelete }: { editing: boolean; setEditing: (on: boolean) => void; onDelete: () => void }) {
  return (
    <span className={"wf-style-tools" + (editing ? " pinned" : "")} onClick={(e) => e.stopPropagation()}>
      <IconButton title={editing ? "Done editing" : "Edit style"} on={editing} onClick={() => setEditing(!editing)}>
        <Pencil size={12} />
      </IconButton>
      <IconButton title="Delete style" onClick={onDelete}>
        <Trash2 size={12} />
      </IconButton>
    </span>
  );
}
