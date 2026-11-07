// Colour and text styles: the applied-style chips in the design panel, the "apply style"
// menus, and the editable style lists in the Assets tab.

import { useState } from "react";
import { Grid3x3, LayoutGrid, Pencil, Plus, Sparkles, Trash2, Unlink, Variable as VariableIcon } from "lucide-react";
import { dispatch, dispatchOrThrow, FONTS, getDoc, toast, useDoc, useStore } from "../store";
import type { Doc, Effect, EffectType, LayoutGrid as GridSpec, Node } from "../types";
import { common, IconButton, Menu, MIXED, NumberField, Popover, SelectField, type MenuItem } from "../ui/controls";
import { ColorPicker, cssColor } from "../ui/color";
import { addDefaultTextStyle, batch, deleteStyle, nextName, updateColorStyle, updateEffectStyle, updateGridStyle, updateTextStyle } from "../componentOps";
import { InlineInput } from "./InlineInput";
import { FolderTree } from "./FolderTree";
import { parseLetterSpacing, parseLineHeight } from "./textUnits";
import "./workflow.css";

type ColorStyle = Doc["styles"]["colors"][number];
type TextStyle = Doc["styles"]["texts"][number];
type EffectStyle = NonNullable<Doc["styles"]["effects"]>[number];
type GridStyle = NonNullable<Doc["styles"]["grids"]>[number];

/** The style kinds a layer can be linked to; `fill` and `stroke` both use colour styles. */
export type StyleKind = "fill" | "stroke" | "text" | "effect" | "grid";

const LINK_KEY = { fill: "fillStyle", stroke: "strokeStyle", text: "textStyle", effect: "effectStyle", grid: "gridStyle" } as const;
const KIND_TITLE: Record<StyleKind, string> = { fill: "Colour style", stroke: "Colour style (stroke)", text: "Text style", effect: "Effect style", grid: "Grid style" };

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

/** Shows the style linked to the selection (colour, stroke colour, text, effect or grid), with a detach button. */
export function StyleChip({ kind, nodes, ids }: { kind: StyleKind; nodes: Node[]; ids: string[] }) {
  const doc = useDoc();
  const key = LINK_KEY[kind];
  const linked = common(nodes, (n) => n[key] ?? null);
  if (linked === null || (linked === MIXED && !nodes.some((n) => n[key]))) return null;
  const detach = () => dispatch({ op: "update", ids, patch: { [key]: null } });
  const one = linked === MIXED ? undefined : linked;
  const color = kind === "fill" || kind === "stroke" ? doc.styles.colors.find((s) => s.id === one) : undefined;
  const text = kind === "text" ? doc.styles.texts.find((s) => s.id === one) : undefined;
  const effect = kind === "effect" ? doc.styles.effects?.find((s) => s.id === one) : undefined;
  const grid = kind === "grid" ? doc.styles.grids?.find((s) => s.id === one) : undefined;
  const name = linked === MIXED ? "Mixed styles" : (color?.name ?? text?.name ?? effect?.name ?? grid?.name ?? "Missing style");
  return (
    <div className="row wf-chip-row">
      <div className="wf-chip" title={KIND_TITLE[kind] + (effect?.description || grid?.description ? ": " + (effect?.description || grid?.description) : "")} data-style-chip={kind}>
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
        {effect && <Sparkles size={13} className="muted" />}
        {grid && <Grid3x3 size={13} className="muted" />}
        <span className="wf-chip-name">{name}</span>
        {text && <span className="muted small">{textStyleLabel(text)}</span>}
        {effect && <span className="muted small">{effectSummary(effect.effects)}</span>}
        {grid && <span className="muted small">{gridSummary(grid.grids)}</span>}
      </div>
      <IconButton title="Detach style" onClick={detach}>
        <Unlink size={13} />
      </IconButton>
    </div>
  );
}

/** "Drop shadow" / "2 effects": what an effect style holds, in a few words. */
export function effectSummary(list: Effect[]): string {
  if (list.length !== 1) return `${list.length} effects`;
  return { dropShadow: "Drop shadow", innerShadow: "Inner shadow", layerBlur: "Layer blur", backgroundBlur: "Background blur" }[list[0].type];
}

/** "12 columns" / "2 grids". */
export function gridSummary(list: GridSpec[]): string {
  if (list.length !== 1) return `${list.length} grids`;
  const g = list[0];
  return g.pattern === "grid" ? `Grid ${g.size}px` : `${g.count} ${g.pattern}`;
}

/** A bound variable's name with a detach button: for fills and strokes, and a one-line hint under number fields. */
export function BoundChip({ nodes, ids, prop, label }: { nodes: Node[]; ids: string[]; prop: string; label?: string }) {
  const doc = useDoc();
  const bound = common(nodes, (n) => n.bindings?.[prop] ?? "");
  if (!bound) return null;
  const found = bound === MIXED ? undefined : doc.variables.flatMap((c) => c.variables.map((v) => ({ c, v }))).find((x) => x.v.id === bound);
  const name = bound === MIXED ? "Mixed variables" : found ? found.v.name : "Missing variable";
  // The swatch is the colour the canvas shows (already resolved for the layer's mode, aliases followed),
  // not the variable's stored first value, which for an alias is only `{alias}`.
  const paints = prop === "fill" ? nodes[0]?.fills : prop === "stroke" ? nodes[0]?.strokes : undefined;
  // The engine writes the bound colour to the first paint; any other first visible solid paint otherwise.
  const solid = paints?.[0]?.type === "solid" && paints[0].visible !== false ? paints[0] : paints?.find((p) => p.visible !== false && p.type === "solid");
  const swatch = found && found.v.type === "color" && solid?.type === "solid" ? solid.color : null;
  return (
    <div className="row wf-chip-row wf-bound" data-bound-chip={prop}>
      <div className="wf-chip" title={`${label ?? prop} is bound to a variable. Detach to keep its current value.`}>
        <VariableIcon size={13} className="wf-purple" />
        <span className="wf-chip-name">{name}</span>
        {swatch && (
          <span className="swatch wf-chip-swatch" title={swatch}>
            <i style={{ background: cssColor(swatch) }} />
          </span>
        )}
      </div>
      <IconButton title={`Detach ${label ?? prop} variable`} onClick={() => dispatch({ op: "bindVariable", ids, property: prop, variable: null })}>
        <Unlink size={13} />
      </IconButton>
    </div>
  );
}

const APPLY_TITLE: Record<StyleKind, string> = {
  fill: "Apply colour style",
  stroke: "Apply colour style to stroke",
  text: "Apply text style",
  effect: "Apply effect style",
  grid: "Apply grid style",
};

/** Header button listing the file's styles of one kind to apply to `ids`. */
export function ApplyStyleButton({ kind, ids }: { kind: StyleKind; ids: string[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const doc = getDoc();
    const styles: { id: string; name: string }[] =
      kind === "fill" || kind === "stroke" ? doc.styles.colors : kind === "text" ? doc.styles.texts : kind === "effect" ? (doc.styles.effects ?? []) : (doc.styles.grids ?? []);
    const items: MenuItem[] = [{ heading: { fill: "Colour styles", stroke: "Colour styles", text: "Text styles", effect: "Effect styles", grid: "Grid styles" }[kind] }];
    for (const s of styles) items.push({ label: s.name, onClick: () => dispatch({ op: "applyStyle", ids, styleId: s.id, kind: kind === "stroke" ? "stroke" : null }) });
    if (!styles.length) items.push({ label: "No styles yet", disabled: true });
    items.push({ sep: true }, { label: "Manage styles in Assets", onClick: () => useStore.setState({ leftTab: "assets" }) });
    setMenu({ x: r.left - 200, y: r.bottom + 4, items });
  };
  return (
    <>
      <IconButton title={APPLY_TITLE[kind]} onClick={open}>
        <LayoutGrid size={13} />
      </IconButton>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </>
  );
}

/** "Create style" button for the Effects and Layout grid sections: saves the layer's list under a new name and links it. */
export function CreateStyleButton({ kind, node }: { kind: "effect" | "grid"; node: Node }) {
  const empty = kind === "effect" ? !node.effects.length : !(node.layoutGrids ?? []).length;
  const linked = kind === "effect" ? node.effectStyle : node.gridStyle;
  if (empty || linked) return null;
  const create = () => {
    const d = getDoc();
    const names = ((kind === "effect" ? d.styles.effects : d.styles.grids) ?? []).map((s) => s.name);
    const name = nextName(kind === "effect" ? "Effect" : "Grid", names);
    dispatch({ op: kind === "effect" ? "addEffectStyle" : "addGridStyle", name, from: node.id });
  };
  return (
    <IconButton title={kind === "effect" ? "Create effect style from these effects" : "Create grid style from these grids"} onClick={create}>
      <LayoutGrid size={13} />
    </IconButton>
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
  const shown = doc.styles.colors.filter((s) => matches(s.name, filter) || editing === s.id);
  return (
    <div className="section" data-styles="colour">
      <div className="section-head">
        <span>Colour styles</span>
        <IconButton title={sel.length ? "Create colour style from selection" : "Create colour style"} onClick={add}>
          <Plus size={14} />
        </IconButton>
      </div>
      {doc.styles.colors.length === 0 && <div className="muted small">Shared colours. Select a layer and click + to save its fill.</div>}
      <FolderTree
        scope="colour"
        items={shown}
        name={styleName}
        forceOpen={!!filter.trim() || editing !== null}
        row={(s, label, depth) => <ColorStyleRow key={s.id} s={s} label={label} depth={depth} sel={sel} editing={editing === s.id} setEditing={(on) => setEditing(on ? s.id : null)} />}
      />
    </div>
  );
}

const styleName = (s: { name: string }) => s.name;

function ColorStyleRow({ s, label, depth, sel, editing, setEditing }: { s: ColorStyle; label: string; depth: number; sel: string[]; editing: boolean; setEditing: (on: boolean) => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const hex = s.color.toUpperCase().endsWith("FF") && s.color.length === 9 ? s.color.slice(0, 7).toUpperCase() : s.color.toUpperCase();
  return (
    <div className={"wf-style" + (editing ? " editing" : "")} style={depthStyle(depth)}>
      <div className="wf-style-row" onClick={() => sel.length && dispatch({ op: "applyStyle", ids: sel, styleId: s.id })} title={sel.length ? `Apply ${s.name} to selection` : s.name}>
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
          {label}
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

/** Left padding of a style row inside `depth` folders (the chevron rows indent 12 px per level). */
function depthStyle(depth: number): React.CSSProperties | undefined {
  return depth ? { marginLeft: depth * 12 - 6 } : undefined;
}

export function TextStylesSection({ filter = "" }: { filter?: string }) {
  const doc = useDoc();
  const sel = useStore((s) => s.es.selection);
  // Rows are tracked by position in the list.
  const [editing, setEditing] = useState<number | null>(null);
  const add = () => {
    const d = getDoc();
    const n = d.nodes[sel[0]];
    const name = nextName("Text", d.styles.texts.map((s) => s.name));
    const ok = n?.type === "text" ? dispatch({ op: "addTextStyle", name, from: n.id }) !== null : addDefaultTextStyle(name);
    if (ok) setEditing(getDoc().styles.texts.length - 1);
  };
  const shown = doc.styles.texts.map((s, i) => ({ s, i })).filter(({ s, i }) => matches(s.name, filter) || editing === i);
  return (
    <div className="section" data-styles="text">
      <div className="section-head">
        <span>Text styles</span>
        <IconButton title="Create text style (from the selected text, if any)" onClick={add}>
          <Plus size={14} />
        </IconButton>
      </div>
      {doc.styles.texts.length === 0 && <div className="muted small">Shared type settings. Select a text layer and click + to save its style.</div>}
      <FolderTree
        scope="text"
        items={shown}
        name={(x) => x.s.name}
        forceOpen={!!filter.trim() || editing !== null}
        row={({ s, i }, label, depth) => <TextStyleRow key={i} s={s} label={label} depth={depth} index={i} sel={sel} editing={editing === i} setEditing={(on) => setEditing(on ? i : null)} />}
      />
    </div>
  );
}

function TextStyleRow({ s, label, depth, index, sel, editing, setEditing }: { s: TextStyle; label: string; depth: number; index: number; sel: string[]; editing: boolean; setEditing: (on: boolean) => void }) {
  const set = (change: Partial<Omit<TextStyle, "id">>) => updateTextStyle(index, change);
  const fonts = FONTS.includes(s.fontFamily) ? FONTS : [s.fontFamily, ...FONTS];
  const weights = WEIGHTS.some((w) => w.value === s.fontWeight) ? WEIGHTS : [...WEIGHTS, { value: s.fontWeight, label: String(s.fontWeight) }];
  return (
    <div className={"wf-style" + (editing ? " editing" : "")} style={depthStyle(depth)}>
      <div className="wf-style-row" onClick={() => sel.length && dispatch({ op: "applyStyle", ids: sel, styleId: s.id })} title={sel.length ? `Apply ${s.name} to selection` : s.name}>
        <span className="wf-ag" style={{ fontFamily: s.fontFamily, fontWeight: s.fontWeight }}>
          Ag
        </span>
        <span className="wf-style-name" onDoubleClick={() => setEditing(true)}>
          {label}
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
              title="Line height (px, 150% or 1.5×; empty for auto)"
              value={s.lineHeight ?? null}
              autoValue={Math.round(s.fontSize * 1.2)}
              min={0}
              parse={(raw) => parseLineHeight(raw, s.fontSize)}
              onAuto={() => set({ lineHeight: null })}
              onChange={(lh) => set({ lineHeight: lh || null })}
              onScrubStart={begin}
              onScrubEnd={end}
            />
            <NumberField label="|A|" title="Letter spacing (px or %)" value={s.letterSpacing} step={0.1} parse={(raw) => parseLetterSpacing(raw, s.fontSize)} onChange={(letterSpacing) => set({ letterSpacing })} onScrubStart={begin} onScrubEnd={end} />
          </div>
        </div>
      )}
    </div>
  );
}

const EFFECT_TYPES: { value: EffectType; label: string }[] = [
  { value: "dropShadow", label: "Drop shadow" },
  { value: "innerShadow", label: "Inner shadow" },
  { value: "layerBlur", label: "Layer blur" },
  { value: "backgroundBlur", label: "Background blur" },
];

/** Effect styles: create from the selected layer's effects, apply, edit in place, rename, delete. */
export function EffectStylesSection({ filter = "" }: { filter?: string }) {
  const doc = useDoc();
  const sel = useStore((s) => s.es.selection);
  const [editing, setEditing] = useState<string | null>(null);
  const styles = doc.styles.effects ?? [];
  const add = () => {
    const n = getDoc().nodes[sel[0]];
    if (!n?.effects.length) {
      toast("Select a layer with effects (a shadow or a blur) to save them as a style.", "error");
      return;
    }
    const r = dispatch<{ id: string }>({ op: "addEffectStyle", name: nextName("Effect", styles.map((s) => s.name)), from: n.id });
    if (r) setEditing(r.id);
  };
  const shown = styles.filter((s) => matches(s.name, filter) || editing === s.id);
  return (
    <div className="section" data-styles="effect">
      <div className="section-head">
        <span>Effect styles</span>
        <IconButton title="Create effect style from the selected layer's effects" onClick={add}>
          <Plus size={14} />
        </IconButton>
      </div>
      {styles.length === 0 && <div className="muted small">Shared shadows and blurs. Select a layer with effects and click + to save them.</div>}
      <FolderTree
        scope="effect"
        items={shown}
        name={styleName}
        forceOpen={!!filter.trim() || editing !== null}
        row={(s, label, depth) => <EffectStyleRow key={s.id} s={s} label={label} depth={depth} sel={sel} editing={editing === s.id} setEditing={(on) => setEditing(on ? s.id : null)} />}
      />
    </div>
  );
}

function EffectStyleRow({ s, label, depth, sel, editing, setEditing }: { s: EffectStyle; label: string; depth: number; sel: string[]; editing: boolean; setEditing: (on: boolean) => void }) {
  const setEffects = (effects: Effect[]) => updateEffectStyle(s.id, { effects });
  const setE = (i: number, patch: Partial<Effect>) => setEffects(s.effects.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className={"wf-style" + (editing ? " editing" : "")} style={depthStyle(depth)}>
      <div className="wf-style-row" onClick={() => sel.length && dispatch({ op: "applyStyle", ids: sel, styleId: s.id })} title={(sel.length ? `Apply ${s.name} to selection` : s.name) + (s.description ? `: ${s.description}` : "")}>
        <Sparkles size={13} className="wf-ag muted" />
        <span className="wf-style-name" onDoubleClick={() => setEditing(true)}>
          {label}
        </span>
        <span className="muted small">{effectSummary(s.effects)}</span>
        <StyleRowTools editing={editing} setEditing={setEditing} onDelete={() => deleteStyle(s.id)} />
      </div>
      {editing && (
        <div className="wf-style-edit">
          <InlineInput label="Name" value={s.name} autoFocus title="Style name" onCommit={(name) => (name.trim() ? updateEffectStyle(s.id, { name: name.trim() }) : false)} />
          <InlineInput label="Info" value={s.description ?? ""} title="Description" placeholder="Where to use it" onCommit={(description) => updateEffectStyle(s.id, { description })} />
          {s.effects.map((e, i) => {
            const shadow = e.type === "dropShadow" || e.type === "innerShadow";
            return (
              <div key={i} className="wf-fx">
                <div className="row">
                  <SelectField ariaLabel="Effect type" value={e.type} options={EFFECT_TYPES} onChange={(type) => setE(i, { type })} />
                  <IconButton title="Remove effect" onClick={() => s.effects.length > 1 && setEffects(s.effects.filter((_, j) => j !== i))} disabled={s.effects.length < 2}>
                    <Trash2 size={12} />
                  </IconButton>
                </div>
                <div className="grid2 effect-fields">
                  {shadow && <NumberField label="X" value={e.x} onChange={(x) => setE(i, { x })} onScrubStart={begin} onScrubEnd={end} />}
                  {shadow && <NumberField label="Y" value={e.y} onChange={(y) => setE(i, { y })} onScrubStart={begin} onScrubEnd={end} />}
                  <NumberField label="Blur" min={0} value={e.blur} onChange={(blur) => setE(i, { blur })} onScrubStart={begin} onScrubEnd={end} />
                  {shadow && <NumberField label="Spread" value={e.spread} onChange={(spread) => setE(i, { spread })} onScrubStart={begin} onScrubEnd={end} />}
                </div>
                {shadow && <InlineInput label="Hex" value={e.color.replace("#", "")} title="Shadow colour (hex, 8 digits for opacity)" onCommit={(v) => (/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim().replace("#", "")) ? setE(i, { color: "#" + v.trim().replace("#", "").toUpperCase() }) : false)} />}
              </div>
            );
          })}
          <button className="btn" onClick={() => setEffects([...s.effects, { type: "dropShadow", color: "#00000040", x: 0, y: 4, blur: 4, spread: 0, visible: true }])}>
            <Plus size={13} /> Add effect
          </button>
        </div>
      )}
    </div>
  );
}

const GRID_PATTERNS: { value: GridSpec["pattern"]; label: string }[] = [
  { value: "columns", label: "Columns" },
  { value: "rows", label: "Rows" },
  { value: "grid", label: "Grid" },
];

/** Grid styles: the layout grids of a frame, saved by name. */
export function GridStylesSection({ filter = "" }: { filter?: string }) {
  const doc = useDoc();
  const sel = useStore((s) => s.es.selection);
  const [editing, setEditing] = useState<string | null>(null);
  const styles = doc.styles.grids ?? [];
  const add = () => {
    const n = getDoc().nodes[sel[0]];
    if (!n?.layoutGrids?.length) {
      toast("Select a frame with layout grids to save them as a style.", "error");
      return;
    }
    const r = dispatch<{ id: string }>({ op: "addGridStyle", name: nextName("Grid", styles.map((s) => s.name)), from: n.id });
    if (r) setEditing(r.id);
  };
  const shown = styles.filter((s) => matches(s.name, filter) || editing === s.id);
  return (
    <div className="section" data-styles="grid">
      <div className="section-head">
        <span>Grid styles</span>
        <IconButton title="Create grid style from the selected frame's layout grids" onClick={add}>
          <Plus size={14} />
        </IconButton>
      </div>
      {styles.length === 0 && <div className="muted small">Shared layout grids. Select a frame with a layout grid and click + to save it.</div>}
      <FolderTree
        scope="grid"
        items={shown}
        name={styleName}
        forceOpen={!!filter.trim() || editing !== null}
        row={(s, label, depth) => <GridStyleRow key={s.id} s={s} label={label} depth={depth} sel={sel} editing={editing === s.id} setEditing={(on) => setEditing(on ? s.id : null)} />}
      />
    </div>
  );
}

function GridStyleRow({ s, label, depth, sel, editing, setEditing }: { s: GridStyle; label: string; depth: number; sel: string[]; editing: boolean; setEditing: (on: boolean) => void }) {
  const setGrids = (grids: GridSpec[]) => updateGridStyle(s.id, { grids });
  const setG = (i: number, patch: Partial<GridSpec>) => setGrids(s.grids.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className={"wf-style" + (editing ? " editing" : "")} style={depthStyle(depth)}>
      <div className="wf-style-row" onClick={() => sel.length && dispatch({ op: "applyStyle", ids: sel, styleId: s.id })} title={(sel.length ? `Apply ${s.name} to selected frames` : s.name) + (s.description ? `: ${s.description}` : "")}>
        <Grid3x3 size={13} className="wf-ag muted" />
        <span className="wf-style-name" onDoubleClick={() => setEditing(true)}>
          {label}
        </span>
        <span className="muted small">{gridSummary(s.grids)}</span>
        <StyleRowTools editing={editing} setEditing={setEditing} onDelete={() => deleteStyle(s.id)} />
      </div>
      {editing && (
        <div className="wf-style-edit">
          <InlineInput label="Name" value={s.name} autoFocus title="Style name" onCommit={(name) => (name.trim() ? updateGridStyle(s.id, { name: name.trim() }) : false)} />
          <InlineInput label="Info" value={s.description ?? ""} title="Description" placeholder="Where to use it" onCommit={(description) => updateGridStyle(s.id, { description })} />
          {s.grids.map((g, i) => (
            <div key={i} className="wf-fx">
              <div className="row">
                <SelectField ariaLabel="Grid pattern" value={g.pattern} options={GRID_PATTERNS} onChange={(pattern) => setG(i, { pattern })} />
                <IconButton title="Remove grid" onClick={() => setGrids(s.grids.filter((_, j) => j !== i))} disabled={s.grids.length < 2}>
                  <Trash2 size={12} />
                </IconButton>
              </div>
              <div className="grid2">
                {g.pattern === "grid" ? (
                  <NumberField label="Size" min={1} value={g.size} onChange={(size) => setG(i, { size })} onScrubStart={begin} onScrubEnd={end} />
                ) : (
                  <>
                    <NumberField label="Count" min={1} value={g.count} onChange={(count) => setG(i, { count: Math.max(1, Math.round(count)) })} onScrubStart={begin} onScrubEnd={end} />
                    <NumberField label="Gutter" min={0} value={g.gutter} onChange={(gutter) => setG(i, { gutter })} onScrubStart={begin} onScrubEnd={end} />
                    <NumberField label="Margin" min={0} value={g.margin} onChange={(margin) => setG(i, { margin })} onScrubStart={begin} onScrubEnd={end} />
                  </>
                )}
              </div>
            </div>
          ))}
          <button className="btn" onClick={() => setGrids([...s.grids, { pattern: "grid", count: 1, gutter: 0, margin: 0, size: 8, alignment: "stretch", color: "#FF00001A", visible: true }])}>
            <Plus size={13} /> Add grid
          </button>
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
