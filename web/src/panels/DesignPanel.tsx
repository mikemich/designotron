import { useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  ArrowDown,
  ArrowRight,
  Bold,
  Component,
  Eye,
  EyeOff,
  Italic,
  Link2,
  Minus,
  Plus,
  RotateCw,
  Scan,
  Strikethrough,
  Underline,
  WrapText,
  CornerUpLeft,
} from "lucide-react";
import type { Effect, Node, Paint } from "../types";
import { dispatch, FONTS, getDoc, styleTextSelection, useDoc, useSelection, useStore, zoomToSelection } from "../store";
import { common, IconButton, MIXED, NumberField, Section, Seg, SelectField, type Maybe } from "../ui/controls";
import { paintLabel, PaintSwatch, cssColor, ColorPicker } from "../ui/color";
import { exportNode } from "../exporter";
import * as A from "../actions";
import { Popover } from "../ui/controls";

const begin = () => dispatch({ op: "beginGesture" });
const end = () => dispatch({ op: "endGesture" });

function update(ids: string[], patch: Record<string, unknown>) {
  if (ids.length) dispatch({ op: "update", ids, patch });
}

const FRAME_PRESETS = [
  { label: "iPhone 16", w: 393, h: 852 },
  { label: "iPhone 16 Pro Max", w: 440, h: 956 },
  { label: "Android", w: 412, h: 917 },
  { label: "iPad", w: 820, h: 1180 },
  { label: "Desktop", w: 1440, h: 1024 },
  { label: "MacBook", w: 1512, h: 982 },
  { label: "Slide 16:9", w: 1920, h: 1080 },
  { label: "Instagram post", w: 1080, h: 1080 },
];

export function DesignPanel() {
  const nodes = useSelection();
  if (!nodes.length) return <PagePanel />;
  const ids = nodes.map((n) => n.id);
  return (
    <div className="scroll">
      <ComponentSection nodes={nodes} />
      <AlignSection />
      <FrameSection nodes={nodes} ids={ids} />
      <PositionSection nodes={nodes} ids={ids} />
      <AutoLayoutSection nodes={nodes} ids={ids} />
      <LayerSection nodes={nodes} ids={ids} />
      {nodes.every((n) => n.type === "text") && <TextSection nodes={nodes} ids={ids} />}
      <PaintsSection title="Fill" nodes={nodes} ids={ids} keyName="fills" />
      <PaintsSection title="Stroke" nodes={nodes} ids={ids} keyName="strokes" />
      <EffectsSection nodes={nodes} ids={ids} />
      <ExportSection nodes={nodes} />
      {nodes.length === 1 && <NotesSection node={nodes[0]} />}
    </div>
  );
}

function PagePanel() {
  const doc = useDoc();
  const pageId = useStore((s) => s.es.page);
  const page = doc.pages.find((p) => p.id === pageId);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!page) return null;
  return (
    <div className="scroll">
      <Section title="Page">
        <div className="row">
          <div className="swatch" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
            <i style={{ background: page.background }} />
          </div>
          <span>{page.background}</span>
          <span className="muted small" style={{ marginLeft: "auto" }}>
            Background
          </span>
        </div>
        {anchor && (
          <Popover anchor={anchor} onClose={() => setAnchor(null)}>
            <ColorPicker color={page.background} onChange={(color) => dispatch({ op: "setPageBackground", id: page.id, color })} />
          </Popover>
        )}
      </Section>
      <Section title="Local styles">
        {doc.styles.colors.length === 0 && doc.styles.texts.length === 0 && <div className="muted small">No styles yet. Create them in the Assets tab.</div>}
        {doc.styles.colors.map((s) => (
          <div key={s.id} className="row">
            <div className="swatch">
              <i style={{ background: cssColor(s.color) }} />
            </div>
            {s.name}
          </div>
        ))}
        {doc.styles.texts.map((s) => (
          <div key={s.id} className="row">
            <span style={{ fontFamily: s.fontFamily, fontWeight: s.fontWeight }}>Ag</span> {s.name}
          </div>
        ))}
      </Section>
      <Section title="Tips">
        <div className="muted small" style={{ lineHeight: 1.7 }}>
          F frame · R rectangle · O ellipse · T text · P pen · L line
          <br />
          Shift+A auto layout · ⌥⌘K component · ⌘G group
          <br />
          Space+drag to pan · ⌘+scroll to zoom · ⇧1 fit
          <br />⌘/ opens Claude
        </div>
      </Section>
    </div>
  );
}

function ComponentSection({ nodes }: { nodes: Node[] }) {
  const doc = getDoc();
  if (nodes.length !== 1) return null;
  const n = nodes[0];
  if (n.type === "component") {
    const isVariant = n.parent && doc.nodes[n.parent]?.type === "componentSet";
    return (
      <Section title={<span style={{ color: "#c4a5ff" }}>❖ Main component</span>}>
        <textarea
          className="textinput"
          placeholder="Description (used by Claude and code export)"
          defaultValue={n.component?.description ?? ""}
          key={n.id}
          onKeyDown={(e) => e.stopPropagation()}
          onBlur={(e) => update([n.id], { component: { ...n.component, description: e.target.value } })}
        />
        {isVariant && (
          <div className="muted small" style={{ marginTop: 6 }}>
            Variant: {Object.entries(n.component?.variantProps ?? {}).map(([k, v]) => `${k}=${v}`).join(", ")}
          </div>
        )}
      </Section>
    );
  }
  if (n.type === "instance" && n.instance) {
    const comp = doc.nodes[n.instance.componentId];
    const set = comp?.parent ? doc.nodes[comp.parent] : null;
    const variantProps: Record<string, Set<string>> = {};
    if (set?.type === "componentSet") {
      for (const cid of set.children) {
        for (const [k, v] of Object.entries(doc.nodes[cid]?.component?.variantProps ?? {})) (variantProps[k] ??= new Set()).add(v);
      }
    }
    return (
      <Section
        title={
          <span style={{ color: "#c4a5ff" }}>
            <Component size={12} style={{ verticalAlign: -2 }} /> {comp?.name ?? "Missing component"}
          </span>
        }
        actions={
          <>
            <IconButton title="Go to main component" onClick={() => comp && (dispatch({ op: "select", ids: [comp.id] }), zoomToSelection())}>
              <Link2 size={13} />
            </IconButton>
            <IconButton title="Reset overrides" onClick={() => dispatch({ op: "resetInstance", ids: [n.id] })}>
              <CornerUpLeft size={13} />
            </IconButton>
            <IconButton title="Detach instance" onClick={A.detachInstance}>
              <Scan size={13} />
            </IconButton>
          </>
        }
      >
        {Object.entries(variantProps).map(([k, values]) => (
          <div className="row" key={k}>
            <span className="muted" style={{ width: 70 }}>
              {k}
            </span>
            <SelectField
              value={comp?.component?.variantProps[k] ?? ""}
              options={[...values].map((v) => ({ value: v, label: v }))}
              onChange={(value) => dispatch({ op: "setVariant", id: n.id, prop: k, value })}
            />
          </div>
        ))}
        {Object.keys(n.instance.overrides).length > 0 && <div className="muted small">{Object.keys(n.instance.overrides).length} override(s)</div>}
      </Section>
    );
  }
  return null;
}

function AlignSection() {
  const sel = useStore((s) => s.es.selection);
  return (
    <div className="section" style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, paddingBottom: 8 }}>
      <IconButton title="Align left (⌥A)" onClick={() => A.align("left")}>
        <AlignStartVertical size={14} />
      </IconButton>
      <IconButton title="Align horizontal centres (⌥H)" onClick={() => A.align("hCenter")}>
        <AlignCenterVertical size={14} />
      </IconButton>
      <IconButton title="Align right (⌥D)" onClick={() => A.align("right")}>
        <AlignEndVertical size={14} />
      </IconButton>
      <IconButton title="Align top (⌥W)" onClick={() => A.align("top")}>
        <AlignStartHorizontal size={14} />
      </IconButton>
      <IconButton title="Align vertical centres (⌥V)" onClick={() => A.align("vCenter")}>
        <AlignCenterHorizontal size={14} />
      </IconButton>
      <IconButton title="Align bottom (⌥S)" onClick={() => A.align("bottom")}>
        <AlignEndHorizontal size={14} />
      </IconButton>
      <IconButton title="Distribute horizontally" disabled={sel.length < 3} onClick={() => A.distribute(true)}>
        <AlignHorizontalSpaceBetween size={14} />
      </IconButton>
      <IconButton title="Distribute vertically" disabled={sel.length < 3} onClick={() => A.distribute(false)}>
        <AlignVerticalSpaceBetween size={14} />
      </IconButton>
    </div>
  );
}

function FrameSection({ nodes, ids }: { nodes: Node[]; ids: string[] }) {
  if (!nodes.every((n) => ["frame", "component", "instance"].includes(n.type))) return null;
  return (
    <Section title="Frame">
      <div className="row">
        <SelectField
          value={"" as string}
          options={[{ value: "", label: "Resize to preset…" }, ...FRAME_PRESETS.map((p) => ({ value: p.label, label: `${p.label}  ${p.w}×${p.h}` }))]}
          onChange={(label) => {
            const p = FRAME_PRESETS.find((x) => x.label === label);
            if (p) update(ids, { width: p.w, height: p.h, sizingH: "fixed", sizingV: "fixed" });
          }}
        />
      </div>
      <label className="row" style={{ cursor: "pointer" }}>
        <input type="checkbox" checked={common(nodes, (n) => n.clipContent) === true} onChange={(e) => update(ids, { clipContent: e.target.checked })} />
        Clip content
      </label>
    </Section>
  );
}

function PositionSection({ nodes, ids }: { nodes: Node[]; ids: string[] }) {
  const doc = getDoc();
  const [corners, setCorners] = useState(false);
  const parent = nodes[0].parent ? doc.nodes[nodes[0].parent] : null;
  const inFlow = !!parent?.layout && nodes.every((n) => !n.absolutePosition);
  const isText = nodes.every((n) => n.type === "text");
  const radiusable = nodes.every((n) => ["rectangle", "frame", "component", "instance", "componentSet"].includes(n.type));
  const sizeable = nodes.some((n) => n.layout) || !!parent?.layout;
  return (
    <Section title="Position & size">
      <div className="grid2">
        <NumberField label="X" value={common(nodes, (n) => n.x)} onChange={(x) => update(ids, { x })} onScrubStart={begin} onScrubEnd={end} />
        <NumberField label="Y" value={common(nodes, (n) => n.y)} onChange={(y) => update(ids, { y })} onScrubStart={begin} onScrubEnd={end} />
        <NumberField
          label="W"
          min={0}
          value={common(nodes, (n) => n.width)}
          onChange={(width) => update(ids, isText ? { width, text: { autoResize: "height" }, sizingH: "fixed" } : { width, sizingH: "fixed" })}
          onScrubStart={begin}
          onScrubEnd={end}
        />
        <NumberField
          label="H"
          min={0}
          value={common(nodes, (n) => n.height)}
          onChange={(height) => update(ids, isText ? { height, text: { autoResize: "none" }, sizingV: "fixed" } : { height, sizingV: "fixed" })}
          onScrubStart={begin}
          onScrubEnd={end}
        />
      </div>
      {sizeable && (
        <div className="grid2">
          <SelectField
            label="W"
            value={common(nodes, (n) => n.sizingH)}
            options={[
              { value: "fixed", label: "Fixed width" },
              { value: "hug", label: "Hug contents" },
              { value: "fill", label: "Fill container" },
            ]}
            onChange={(sizingH) => update(ids, { sizingH })}
          />
          <SelectField
            label="H"
            value={common(nodes, (n) => n.sizingV)}
            options={[
              { value: "fixed", label: "Fixed height" },
              { value: "hug", label: "Hug contents" },
              { value: "fill", label: "Fill container" },
            ]}
            onChange={(sizingV) => update(ids, { sizingV })}
          />
        </div>
      )}
      <div className="grid2">
        <NumberField label={<RotateCw size={11} />} value={common(nodes, (n) => n.rotation)} suffix="°" onChange={(rotation) => update(ids, { rotation })} onScrubStart={begin} onScrubEnd={end} title="Rotation" />
        {radiusable && !corners && (
          <div className="row" style={{ margin: 0 }}>
            <NumberField label="◜" min={0} value={common(nodes, (n) => n.cornerRadius)} onChange={(cornerRadius) => update(ids, { cornerRadius, cornerRadii: null })} onScrubStart={begin} onScrubEnd={end} title="Corner radius" />
            <IconButton title="Independent corners" onClick={() => setCorners(true)}>
              <Scan size={12} />
            </IconButton>
          </div>
        )}
      </div>
      {radiusable && corners && (
        <div className="grid2">
          {(["↖", "↗", "↘", "↙"] as const).map((lbl, i) => (
            <NumberField
              key={i}
              label={lbl}
              min={0}
              value={common(nodes, (n) => (n.cornerRadii ?? [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius])[i])}
              onChange={(v) => {
                for (const n of nodes) {
                  const r = [...(n.cornerRadii ?? [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius])];
                  r[i] = v;
                  update([n.id], { cornerRadii: r });
                }
              }}
            />
          ))}
        </div>
      )}
      {parent?.layout && (
        <label className="row" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={common(nodes, (n) => n.absolutePosition) === true} onChange={(e) => update(ids, { absolutePosition: e.target.checked })} />
          Absolute position (ignore auto layout)
        </label>
      )}
      {parent && !inFlow && !parent.layout && ["frame", "component", "instance"].includes(parent.type) && (
        <div className="grid2">
          <SelectField
            label="↔"
            title="Horizontal constraint"
            value={common(nodes, (n) => n.constraints.horizontal)}
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
              { value: "leftRight", label: "Left & right" },
              { value: "center", label: "Center" },
              { value: "scale", label: "Scale" },
            ]}
            onChange={(horizontal) => update(ids, { constraints: { horizontal } })}
          />
          <SelectField
            label="↕"
            title="Vertical constraint"
            value={common(nodes, (n) => n.constraints.vertical)}
            options={[
              { value: "top", label: "Top" },
              { value: "bottom", label: "Bottom" },
              { value: "topBottom", label: "Top & bottom" },
              { value: "center", label: "Center" },
              { value: "scale", label: "Scale" },
            ]}
            onChange={(vertical) => update(ids, { constraints: { vertical } })}
          />
        </div>
      )}
    </Section>
  );
}

function AutoLayoutSection({ nodes, ids }: { nodes: Node[]; ids: string[] }) {
  const frames = nodes.every((n) => ["frame", "component", "instance"].includes(n.type));
  if (!frames && nodes.length > 1) return null;
  const has = nodes.every((n) => n.layout);
  if (!has) {
    return (
      <Section
        title="Auto layout"
        actions={
          <IconButton title="Add auto layout (⇧A)" onClick={A.addAutoLayout}>
            <Plus size={14} />
          </IconButton>
        }
      />
    );
  }
  const al = nodes[0].layout!;
  const set = (patch: Record<string, unknown>) => update(ids, { layout: patch });
  const horizontal = al.direction === "horizontal";
  const cells = ["start", "center", "end"] as const;
  return (
    <Section
      title="Auto layout"
      actions={
        <IconButton title="Remove auto layout" onClick={() => dispatch({ op: "removeAutoLayout", ids })}>
          <Minus size={14} />
        </IconButton>
      }
    >
      <div className="row">
        <Seg
          value={common(nodes, (n) => n.layout!.direction)}
          onChange={(direction) => set({ direction })}
          options={[
            { value: "vertical", label: <ArrowDown size={13} />, title: "Vertical" },
            { value: "horizontal", label: <ArrowRight size={13} />, title: "Horizontal" },
          ]}
        />
        <IconButton title="Wrap" on={al.wrap} onClick={() => set({ wrap: !al.wrap, direction: "horizontal" })}>
          <WrapText size={13} />
        </IconButton>
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="align-grid" title="Alignment">
          {cells.map((row) =>
            cells.map((col) => {
              const primary = horizontal ? col : row;
              const counter = horizontal ? row : col;
              const on = (al.primaryAlign === primary || (al.primaryAlign === "spaceBetween" && primary === "start")) && (al.counterAlign === counter);
              return (
                <button
                  key={row + col}
                  className={on ? "on" : ""}
                  onClick={() => set({ primaryAlign: al.primaryAlign === "spaceBetween" ? "spaceBetween" : primary, counterAlign: counter })}
                >
                  <i />
                </button>
              );
            }),
          )}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          <NumberField label="⇹" title="Gap between items" value={common(nodes, (n) => n.layout!.gap)} onChange={(gap) => set({ gap })} onScrubStart={begin} onScrubEnd={end} min={0} />
          <SelectField
            value={al.primaryAlign === "spaceBetween" ? "between" : "packed"}
            options={[
              { value: "packed", label: "Packed" },
              { value: "between", label: "Space between" },
            ]}
            onChange={(v) => set({ primaryAlign: v === "between" ? "spaceBetween" : "start" })}
          />
        </div>
      </div>
      <div className="grid2">
        <NumberField label="↔" title="Horizontal padding" min={0} value={common(nodes, (n) => n.layout!.paddingLeft)} onChange={(p) => set({ paddingLeft: p, paddingRight: p })} onScrubStart={begin} onScrubEnd={end} />
        <NumberField label="↕" title="Vertical padding" min={0} value={common(nodes, (n) => n.layout!.paddingTop)} onChange={(p) => set({ paddingTop: p, paddingBottom: p })} onScrubStart={begin} onScrubEnd={end} />
      </div>
      <div className="grid2" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
        <NumberField label="T" min={0} value={al.paddingTop} onChange={(paddingTop) => set({ paddingTop })} />
        <NumberField label="R" min={0} value={al.paddingRight} onChange={(paddingRight) => set({ paddingRight })} />
        <NumberField label="B" min={0} value={al.paddingBottom} onChange={(paddingBottom) => set({ paddingBottom })} />
        <NumberField label="L" min={0} value={al.paddingLeft} onChange={(paddingLeft) => set({ paddingLeft })} />
      </div>
      {al.wrap && <NumberField label="↧" title="Row gap" min={0} value={al.counterGap} onChange={(counterGap) => set({ counterGap })} />}
    </Section>
  );
}

function LayerSection({ nodes, ids }: { nodes: Node[]; ids: string[] }) {
  return (
    <Section title="Layer">
      <div className="grid2">
        <SelectField
          value={common(nodes, (n) => n.blendMode)}
          options={["normal", "multiply", "screen", "overlay", "darken", "lighten", "colorDodge", "colorBurn", "hardLight", "softLight", "difference", "exclusion", "hue", "saturation", "color", "luminosity"].map((v) => ({
            value: v,
            label: v.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
          }))}
          onChange={(blendMode) => update(ids, { blendMode })}
        />
        <NumberField
          label="◐"
          value={mapMaybe(common(nodes, (n) => n.opacity), (v) => Math.round(v * 100))}
          suffix="%"
          min={0}
          max={100}
          onChange={(v) => update(ids, { opacity: v / 100 })}
          onScrubStart={begin}
          onScrubEnd={end}
          title="Opacity"
        />
      </div>
    </Section>
  );
}

function mapMaybe<T, U>(v: Maybe<T>, f: (t: T) => U): Maybe<U> {
  return v === MIXED ? MIXED : f(v as T);
}

const WEIGHTS = [
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semibold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "Extra bold" },
];

function TextSection({ nodes, ids }: { nodes: Node[]; ids: string[] }) {
  const t = (f: (n: Node) => unknown) => common(nodes, (n) => f(n));
  const RUN_KEYS = ["fontFamily", "fontSize", "fontWeight", "italic", "letterSpacing", "decoration"];
  const set = (patch: Record<string, unknown>) => {
    // While editing with characters selected, style just those characters.
    const runPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => RUN_KEYS.includes(k)));
    if (Object.keys(runPatch).length === Object.keys(patch).length && styleTextSelection(runPatch)) return;
    update(ids, { text: patch });
  };
  const sel = useStore((s) => s.textSel);
  const editing = useStore((s) => s.editingText);
  const partial = !!sel && sel.id === editing && sel.end > sel.start;
  return (
    <Section title={partial ? `Text · ${sel!.end - sel!.start} characters selected` : "Text"}>
      <div className="row">
        <SelectField value={t((n) => n.text!.fontFamily) as Maybe<string>} options={FONTS.map((f) => ({ value: f, label: f }))} onChange={(fontFamily) => set({ fontFamily })} />
      </div>
      <div className="grid2">
        <SelectField value={t((n) => n.text!.fontWeight) as Maybe<number>} options={WEIGHTS} onChange={(fontWeight) => set({ fontWeight })} />
        <NumberField value={t((n) => n.text!.fontSize) as Maybe<number>} min={1} onChange={(fontSize) => set({ fontSize })} onScrubStart={begin} onScrubEnd={end} label="Aa" title="Font size" />
      </div>
      <div className="grid2">
        <NumberField
          label="↨"
          title="Line height (px, 0 = auto)"
          value={t((n) => n.text!.lineHeight ?? Math.round(n.text!.fontSize * 1.2)) as Maybe<number>}
          min={0}
          onChange={(lh) => set({ lineHeight: lh || null })}
          onScrubStart={begin}
          onScrubEnd={end}
        />
        <NumberField label="|A|" title="Letter spacing" value={t((n) => n.text!.letterSpacing) as Maybe<number>} step={0.1} onChange={(letterSpacing) => set({ letterSpacing })} onScrubStart={begin} onScrubEnd={end} />
      </div>
      <div className="row">
        <Seg
          value={t((n) => n.text!.alignH) as Maybe<string>}
          onChange={(alignH) => set({ alignH })}
          options={[
            { value: "left", label: "L", title: "Align left" },
            { value: "center", label: "C", title: "Align center" },
            { value: "right", label: "R", title: "Align right" },
            { value: "justify", label: "J", title: "Justify" },
          ]}
        />
        <Seg
          value={t((n) => n.text!.alignV) as Maybe<string>}
          onChange={(alignV) => set({ alignV })}
          options={[
            { value: "top", label: "⤒", title: "Top" },
            { value: "middle", label: "⇕", title: "Middle" },
            { value: "bottom", label: "⤓", title: "Bottom" },
          ]}
        />
      </div>
      <div className="row">
        <Seg
          value={t((n) => n.text!.autoResize) as Maybe<string>}
          onChange={(autoResize) => set({ autoResize })}
          options={[
            { value: "width", label: "Auto W", title: "Auto width" },
            { value: "height", label: "Auto H", title: "Auto height" },
            { value: "none", label: "Fixed", title: "Fixed size" },
          ]}
        />
      </div>
      <div className="row">
        <IconButton title="Bold" on={nodes.every((n) => n.text!.fontWeight >= 700)} onClick={() => set({ fontWeight: nodes[0].text!.fontWeight >= 700 ? 400 : 700 })}>
          <Bold size={13} />
        </IconButton>
        <IconButton title="Italic" on={nodes.every((n) => n.text!.italic)} onClick={() => set({ italic: !nodes[0].text!.italic })}>
          <Italic size={13} />
        </IconButton>
        <IconButton title="Underline" on={nodes.every((n) => n.text!.decoration === "underline")} onClick={() => set({ decoration: nodes[0].text!.decoration === "underline" ? "none" : "underline" })}>
          <Underline size={13} />
        </IconButton>
        <IconButton title="Strikethrough" on={nodes.every((n) => n.text!.decoration === "strikethrough")} onClick={() => set({ decoration: nodes[0].text!.decoration === "strikethrough" ? "none" : "strikethrough" })}>
          <Strikethrough size={13} />
        </IconButton>
        <SelectField
          value={t((n) => n.text!.case) as Maybe<string>}
          options={[
            { value: "original", label: "Aa  As typed" },
            { value: "upper", label: "AA  Uppercase" },
            { value: "lower", label: "aa  Lowercase" },
            { value: "title", label: "Aa  Title case" },
          ]}
          onChange={(c) => set({ case: c })}
        />
      </div>
    </Section>
  );
}

function PaintsSection({ title, nodes, ids, keyName }: { title: string; nodes: Node[]; ids: string[]; keyName: "fills" | "strokes" }) {
  const paints = common(nodes, (n) => n[keyName]);
  const list: Paint[] = paints === MIXED ? [] : paints;
  const set = (next: Paint[]) => update(ids, { [keyName]: next, ...(keyName === "fills" ? { fillStyle: null } : {}) });
  const isLineish = nodes.every((n) => n.type === "line" || n.type === "vector");
  return (
    <Section
      title={title}
      actions={
        <IconButton
          title={`Add ${title.toLowerCase()}`}
          onClick={() => {
            const color = keyName === "fills" ? (nodes[0].type === "text" ? "#000000" : "#D9D9D9") : "#000000";
            set([...list, { type: "solid", color, opacity: 1, visible: true }]);
            if (keyName === "strokes" && nodes.every((n) => n.strokeWeight === 0)) update(ids, { strokeWeight: 1 });
          }}
        >
          <Plus size={14} />
        </IconButton>
      }
    >
      {paints === MIXED && <div className="muted small">Mixed — click + to replace for all</div>}
      {[...list].reverse().map((p, ri) => {
        const i = list.length - 1 - ri;
        const setP = (np: Paint) => {
          // Colouring selected characters of the text being edited.
          if (keyName === "fills" && np.type === "solid" && nodes.length === 1 && nodes[0].type === "text" && styleTextSelection({ color: np.color })) return;
          set(list.map((x, j) => (j === i ? np : x)));
        };
        return (
          <div className="row" key={i}>
            <label className="field" style={{ paddingLeft: 5, gap: 6 }}>
              <PaintSwatch paint={p} onChange={setP} onOpen={begin} onClose={end} />
              {p.type === "solid" ? (
                <input
                  key={p.color}
                  defaultValue={p.color.replace("#", "").slice(0, 6)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.replace("#", "").trim();
                    if (/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) setP({ ...p, color: "#" + (v.length === 3 ? v.split("").map((c) => c + c).join("") : v).toUpperCase() });
                  }}
                />
              ) : (
                <span style={{ flex: 1 }}>{paintLabel(p)}</span>
              )}
            </label>
            <div style={{ width: 62 }}>
              <NumberField value={Math.round(p.opacity * 100)} suffix="%" min={0} max={100} onChange={(v) => setP({ ...p, opacity: v / 100 })} />
            </div>
            <IconButton title={p.visible ? "Hide" : "Show"} onClick={() => setP({ ...p, visible: !p.visible })}>
              {p.visible ? <Eye size={13} /> : <EyeOff size={13} />}
            </IconButton>
            <IconButton title="Remove" onClick={() => set(list.filter((_, j) => j !== i))}>
              <Minus size={13} />
            </IconButton>
          </div>
        );
      })}
      {keyName === "strokes" && list.length > 0 && (
        <>
          <div className="grid2">
            <NumberField label="≡" title="Stroke weight" min={0} value={common(nodes, (n) => n.strokeWeight)} onChange={(strokeWeight) => update(ids, { strokeWeight })} onScrubStart={begin} onScrubEnd={end} />
            <SelectField
              value={common(nodes, (n) => n.strokeAlign)}
              options={[
                { value: "inside", label: "Inside" },
                { value: "center", label: "Center" },
                { value: "outside", label: "Outside" },
              ]}
              onChange={(strokeAlign) => update(ids, { strokeAlign })}
            />
          </div>
          <div className="grid2">
            <SelectField
              value={common(nodes, (n) => (n.strokeDash.length ? "dashed" : "solid"))}
              options={[
                { value: "solid", label: "Solid" },
                { value: "dashed", label: "Dashed" },
              ]}
              onChange={(v) => update(ids, { strokeDash: v === "dashed" ? [6, 4] : [] })}
            />
            {isLineish && (
              <SelectField
                value={common(nodes, (n) => n.shape?.endCap ?? "none")}
                options={[
                  { value: "none", label: "No end cap" },
                  { value: "round", label: "Round" },
                  { value: "arrow", label: "Arrow" },
                  { value: "circle", label: "Circle" },
                ]}
                onChange={(endCap) => update(ids, { shape: { endCap } })}
              />
            )}
          </div>
        </>
      )}
    </Section>
  );
}

function EffectsSection({ nodes, ids }: { nodes: Node[]; ids: string[] }) {
  const effects = common(nodes, (n) => n.effects);
  const list: Effect[] = effects === MIXED ? [] : effects;
  const [open, setOpen] = useState<number | null>(null);
  const set = (next: Effect[]) => update(ids, { effects: next });
  return (
    <Section
      title="Effects"
      actions={
        <IconButton title="Add effect" onClick={() => set([...list, { type: "dropShadow", color: "#00000040", x: 0, y: 4, blur: 12, spread: 0, visible: true }])}>
          <Plus size={14} />
        </IconButton>
      }
    >
      {list.map((e, i) => {
        const setE = (patch: Partial<Effect>) => set(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        const shadow = e.type === "dropShadow" || e.type === "innerShadow";
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <div className="row">
              <SelectField
                value={e.type}
                options={[
                  { value: "dropShadow", label: "Drop shadow" },
                  { value: "innerShadow", label: "Inner shadow" },
                  { value: "layerBlur", label: "Layer blur" },
                  { value: "backgroundBlur", label: "Background blur" },
                ]}
                onChange={(type) => setE({ type })}
              />
              <IconButton title="Edit" on={open === i} onClick={() => setOpen(open === i ? null : i)}>
                <Scan size={13} />
              </IconButton>
              <IconButton title={e.visible ? "Hide" : "Show"} onClick={() => setE({ visible: !e.visible })}>
                {e.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </IconButton>
              <IconButton title="Remove" onClick={() => set(list.filter((_, j) => j !== i))}>
                <Minus size={13} />
              </IconButton>
            </div>
            {open === i && (
              <>
                <div className="grid2">
                  {shadow && <NumberField label="X" value={e.x} onChange={(x) => setE({ x })} onScrubStart={begin} onScrubEnd={end} />}
                  {shadow && <NumberField label="Y" value={e.y} onChange={(y) => setE({ y })} onScrubStart={begin} onScrubEnd={end} />}
                  <NumberField label="Blur" min={0} value={e.blur} onChange={(blur) => setE({ blur })} onScrubStart={begin} onScrubEnd={end} />
                  {shadow && <NumberField label="Spr" value={e.spread} onChange={(spread) => setE({ spread })} onScrubStart={begin} onScrubEnd={end} />}
                </div>
                {shadow && (
                  <div className="row">
                    <PaintSwatch paint={{ type: "solid", color: e.color, opacity: 1, visible: true }} onChange={(p) => p.type === "solid" && setE({ color: p.color })} onOpen={begin} onClose={end} />
                    <span className="muted">{e.color}</span>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </Section>
  );
}

function ExportSection({ nodes }: { nodes: Node[] }) {
  const [format, setFormat] = useState<"png" | "jpg" | "svg">("png");
  const [scale, setScale] = useState(2);
  return (
    <Section title="Export">
      <div className="grid2">
        <SelectField
          value={scale}
          options={[0.5, 1, 2, 3, 4].map((s) => ({ value: s, label: `${s}x` }))}
          onChange={setScale}
        />
        <SelectField
          value={format}
          options={[
            { value: "png", label: "PNG" },
            { value: "jpg", label: "JPG" },
            { value: "svg", label: "SVG" },
          ]}
          onChange={setFormat}
        />
      </div>
      <button className="btn block" onClick={() => nodes.forEach((n) => exportNode(n.id, format, scale))}>
        Export {nodes.length === 1 ? nodes[0].name : `${nodes.length} layers`}
      </button>
    </Section>
  );
}

function NotesSection({ node }: { node: Node }) {
  return (
    <Section title="Developer notes">
      <textarea
        key={node.id}
        className="textinput"
        placeholder="Notes for developers and Claude (behaviour, data, edge cases)…"
        defaultValue={node.notes}
        onKeyDown={(e) => e.stopPropagation()}
        onBlur={(e) => e.target.value !== node.notes && update([node.id], { notes: e.target.value })}
      />
    </Section>
  );
}
