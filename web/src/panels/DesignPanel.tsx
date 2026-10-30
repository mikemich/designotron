import { useEffect, useRef, useState } from "react";
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
  Baseline,
  Bold,
  Eye,
  EyeOff,
  Italic,
  Link as LinkIcon,
  Minus,
  Pilcrow,
  Plus,
  RotateCw,
  Scan,
  Strikethrough,
  Underline,
  Unlink,
  WrapText,
  Variable,
  Radius,
  Blend,
} from "lucide-react";
import type { Effect, ExportSetting, LayoutGrid, Node, Paint, VarKind } from "../types";
import { dispatch, FONTS, getDoc, styleTextSelection, useDoc, useSelection, useStore } from "../store";
import { ALT, common, IconButton, MIXED, MOD, NumberField, Section, Seg, SelectField, SHIFT, type Maybe } from "../ui/controls";
import { paintLabel, PaintSwatch, cssColor, ColorPicker } from "../ui/color";
import { DEFAULT_EXPORT, exportLayers, rowSuffix } from "../exporter";
import * as A from "../actions";
import { Popover } from "../ui/controls";
import { ComponentSetSection, InstanceSection, MainComponentSection } from "./ComponentControls";
import { LayerPropsSection } from "./PropertyControls";
import { ApplyStyleButton, StyleChip } from "./StyleControls";

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
      {nodes.length === 1 && ["frame", "component"].includes(nodes[0].type) && <GridSection node={nodes[0]} />}
      <VariablesSection nodes={nodes} ids={ids} />
      <ExportSection nodes={nodes} ids={ids} />
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
      <Section title="Local variables">
        <div className="muted small" style={{ marginBottom: 6 }}>
          {(doc.variables ?? []).length
            ? (() => {
                const n = doc.variables.reduce((k, c) => k + c.variables.length, 0);
                return `${n} variable${n === 1 ? "" : "s"} in ${doc.variables.length} collection${doc.variables.length === 1 ? "" : "s"}`;
              })()
            : "Colours, sizes and text with modes (Light/Dark, brands)."}
        </div>
        <button className="btn block" onClick={() => useStore.setState({ variablesOpen: true })}>
          <Variable size={13} /> Open variables
        </button>
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
          {`${SHIFT}A auto layout · ${ALT}${MOD}K component · ${MOD}G group`}
          <br />
          {`Space+drag to pan · ${MOD}scroll to zoom · ${SHIFT}1 fit`}
          <br />
          {`${MOD}/ opens Claude · ? all shortcuts`}
        </div>
      </Section>
    </div>
  );
}

function ComponentSection({ nodes }: { nodes: Node[] }) {
  if (nodes.length !== 1) return null;
  const n = nodes[0];
  if (n.type === "component") return <MainComponentSection n={n} />;
  if (n.type === "componentSet") return <ComponentSetSection n={n} />;
  if (n.type === "instance" && n.instance) {
    return (
      <>
        <InstanceSection n={n} />
        <LayerPropsSection n={n} />
      </>
    );
  }
  return <LayerPropsSection n={n} />;
}

function AlignSection() {
  const sel = useStore((s) => s.es.selection);
  return (
    <div className="section" style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, paddingBottom: 8 }}>
      <IconButton title={`Align left (${ALT}A)`} onClick={() => A.align("left")}>
        <AlignStartVertical size={14} />
      </IconButton>
      <IconButton title={`Align horizontal centres (${ALT}H)`} onClick={() => A.align("hCenter")}>
        <AlignCenterVertical size={14} />
      </IconButton>
      <IconButton title={`Align right (${ALT}D)`} onClick={() => A.align("right")}>
        <AlignEndVertical size={14} />
      </IconButton>
      <IconButton title={`Align top (${ALT}W)`} onClick={() => A.align("top")}>
        <AlignStartHorizontal size={14} />
      </IconButton>
      <IconButton title={`Align vertical centres (${ALT}V)`} onClick={() => A.align("vCenter")}>
        <AlignCenterHorizontal size={14} />
      </IconButton>
      <IconButton title={`Align bottom (${ALT}S)`} onClick={() => A.align("bottom")}>
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
  // Hug only means something for layers with contents to hug (auto layout, text, groups, instances).
  const canHug = nodes.every((n) => !!n.layout || ["text", "group", "instance"].includes(n.type));
  const sizingOptions = [
    { value: "fixed" as const, label: "Fixed" },
    ...(canHug ? [{ value: "hug" as const, label: "Hug" }] : []),
    { value: "fill" as const, label: "Fill" },
  ];
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
            options={sizingOptions}
            onChange={(sizingH) => update(ids, { sizingH })}
          />
          <SelectField
            label="H"
            value={common(nodes, (n) => n.sizingV)}
            options={sizingOptions}
            onChange={(sizingV) => update(ids, { sizingV })}
          />
        </div>
      )}
      {(sizeable || isText) && <MinMaxFields nodes={nodes} ids={ids} />}
      <div className="grid2">
        <NumberField label={<RotateCw size={11} />} value={common(nodes, (n) => n.rotation)} suffix="°" onChange={(rotation) => update(ids, { rotation })} onScrubStart={begin} onScrubEnd={end} title="Rotation" />
        {radiusable && !corners && (
          <div className="row" style={{ margin: 0 }}>
            <NumberField label={<Radius size={11} />} min={0} value={common(nodes, (n) => n.cornerRadius)} onChange={(cornerRadius) => update(ids, { cornerRadius, cornerRadii: null })} onScrubStart={begin} onScrubEnd={end} title="Corner radius" />
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

const LIMITS = [
  { key: "minWidth", label: "Min W", title: "Minimum width (0 or empty for none)" },
  { key: "maxWidth", label: "Max W", title: "Maximum width (0 or empty for none)" },
  { key: "minHeight", label: "Min H", title: "Minimum height (0 or empty for none)" },
  { key: "maxHeight", label: "Max H", title: "Maximum height (0 or empty for none)" },
] as const;

/** Min and max width/height: hug and fill stop at them, auto-width text wraps at the max. */
function MinMaxFields({ nodes, ids }: { nodes: Node[]; ids: string[] }) {
  const anySet = nodes.some((n) => LIMITS.some((l) => n[l.key] != null));
  const [shown, setShown] = useState(false);
  const open = shown || anySet;
  return (
    <>
      {!anySet && (
        <div className="row" style={{ marginBottom: open ? 6 : 0 }}>
          <button className="link-btn" style={{ fontSize: 11 }} onClick={() => setShown(!shown)}>
            {shown ? "Hide min / max size" : "Add min / max size"}
          </button>
        </div>
      )}
      {open && (
        <div className="grid2 size-limits" data-testid="size-limits">
          {LIMITS.map((l) => (
            <NumberField
              key={l.key}
              value={common(nodes, (n) => n[l.key] ?? null)}
              label={l.label}
              autoText="None"
              title={l.title}
              min={0}
              onChange={(v) => update(ids, { [l.key]: v > 0 ? v : null })}
            />
          ))}
        </div>
      )}
    </>
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
          <IconButton title={`Add auto layout (${SHIFT}A)`} onClick={A.addAutoLayout}>
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
          // Wrap and baseline alignment only exist in horizontal layouts: leaving one drops them.
          onChange={(direction) => set(direction === "vertical" ? { direction, wrap: false, ...(al.counterAlign === "baseline" ? { counterAlign: "start" } : {}) } : { direction })}
          options={[
            { value: "vertical", label: <ArrowDown size={13} />, title: "Vertical" },
            { value: "horizontal", label: <ArrowRight size={13} />, title: "Horizontal" },
          ]}
        />
        <IconButton
          title={horizontal ? "Wrap" : "Wrap needs a horizontal layout: switch the direction first"}
          on={al.wrap && horizontal}
          disabled={!horizontal}
          onClick={() => set({ wrap: !al.wrap, ...(!al.wrap && al.counterAlign === "baseline" ? { counterAlign: "start" } : {}) })}
        >
          <WrapText size={13} />
        </IconButton>
        <IconButton
          title={horizontal && !al.wrap ? "Align text baselines" : "Baseline alignment needs a horizontal layout without wrap"}
          on={al.counterAlign === "baseline"}
          disabled={!horizontal || al.wrap}
          onClick={() => set({ counterAlign: al.counterAlign === "baseline" ? "start" : "baseline" })}
        >
          <Baseline size={13} />
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
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
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
          label={<Blend size={11} />}
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
  // A layer-wide value is "Mixed" when a styled range overrides it with something else.
  const r = <K extends "fontFamily" | "fontWeight" | "fontSize" | "letterSpacing">(key: K) => {
    const v = common(nodes, (n) => n.text![key]);
    if (v === MIXED) return v;
    const ranged = nodes.some((n) => (n.text!.runs ?? []).some((run) => run[key] !== undefined && (run[key] as unknown) !== v));
    return ranged ? MIXED : v;
  };
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
  const truncating = nodes.every((n) => !!n.text!.truncate || n.text!.maxLines != null);
  return (
    <Section title={partial ? `Text · ${sel!.end - sel!.start} characters selected` : "Text"} actions={<ApplyStyleButton kind="text" ids={ids} />}>
      <StyleChip kind="text" nodes={nodes} ids={ids} />
      <div className="row">
        <SelectField value={r("fontFamily") as Maybe<string>} options={FONTS.map((f) => ({ value: f, label: f }))} onChange={(fontFamily) => set({ fontFamily })} />
      </div>
      <div className="grid2">
        <SelectField value={r("fontWeight") as Maybe<number>} options={WEIGHTS} onChange={(fontWeight) => set({ fontWeight })} />
        <NumberField value={r("fontSize") as Maybe<number>} min={1} onChange={(fontSize) => set({ fontSize })} onScrubStart={begin} onScrubEnd={end} label="Aa" title="Font size" />
      </div>
      <div className="grid2">
        <NumberField
          label="↨"
          title="Line height (px; 0 or empty for auto)"
          value={t((n) => n.text!.lineHeight ?? null) as Maybe<number> | null}
          autoValue={(() => {
            const fs = r("fontSize");
            return fs === MIXED ? undefined : Math.round((fs as number) * 1.2);
          })()}
          min={0}
          onChange={(lh) => set({ lineHeight: lh || null })}
          onScrubStart={begin}
          onScrubEnd={end}
        />
        <NumberField label="|A|" title="Letter spacing" value={r("letterSpacing") as Maybe<number>} step={0.1} onChange={(letterSpacing) => set({ letterSpacing })} onScrubStart={begin} onScrubEnd={end} />
      </div>
      <div className="grid2">
        <NumberField
          label={<Pilcrow size={11} />}
          title="Paragraph spacing (between lines separated by Enter)"
          min={0}
          value={t((n) => n.text!.paragraphSpacing ?? 0) as Maybe<number>}
          onChange={(paragraphSpacing) => set({ paragraphSpacing })}
          onScrubStart={begin}
          onScrubEnd={end}
        />
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
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="row" style={{ cursor: "pointer", margin: 0 }} title="Cut text that doesn't fit and end it with an ellipsis">
          <input
            type="checkbox"
            checked={truncating}
            onChange={(e) =>
              set(
                e.target.checked
                  ? // Auto-size text has no box to cut at, so start with one line.
                    { truncate: true, maxLines: nodes.every((n) => n.text!.autoResize === "none") ? null : 1 }
                  : { truncate: false, maxLines: null },
              )
            }
          />
          Truncate text
        </label>
        {truncating && (
          <div style={{ width: 96 }}>
            <NumberField
              label="≡"
              title="Maximum lines (0 or empty: the lines that fit a fixed box)"
              autoText="No limit"
              min={0}
              value={t((n) => n.text!.maxLines ?? null) as Maybe<number> | null}
              onChange={(v) => set({ truncate: true, maxLines: v > 0 ? Math.round(v) : null })}
            />
          </div>
        )}
      </div>
      {editing && sel && sel.id === editing && <LinkRow nodes={nodes} sel={sel} />}
      <LinkList nodes={nodes} />
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

/** Turns what was typed into a link: a bare address gets https://, other schemes are left to the engine to accept or refuse. */
function normalizeUrl(raw: string): string {
  const url = raw.trim();
  return url && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? `https://${url}` : url;
}

/** Link of the text range under `pos`, with that range. */
function linkAt(node: Node, pos: number) {
  return (node.text!.runs ?? []).find((r) => r.link && r.start <= pos && pos < r.end);
}

/** While editing text with characters selected: set or remove the link on the selection (Ctrl+K). */
function LinkRow({ nodes, sel }: { nodes: Node[]; sel: { id: string; start: number; end: number } }) {
  const node = nodes.find((n) => n.id === sel.id);
  const current = node ? linkAt(node, sel.start)?.link ?? "" : "";
  const ranged = sel.end > sel.start;
  const [value, setValue] = useState(current);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(current), [current, sel.start, sel.end]);
  useEffect(() => {
    // Ctrl+K in the text editor.
    const show = () => {
      setOpen(true);
      requestAnimationFrame(() => input.current?.select());
    };
    window.addEventListener("dt-link", show);
    return () => window.removeEventListener("dt-link", show);
  }, []);
  // The engine refuses unsafe links; the field stays open (with the engine's message as a toast) until one is accepted.
  const run = (style: Record<string, unknown>, clear: string[]) => {
    if (!dispatch({ op: "styleText", id: sel.id, start: sel.start, end: sel.end, style, clear })) return;
    setOpen(false);
    requestAnimationFrame(() => window.dispatchEvent(new Event("dt-refocus-text")));
  };
  const apply = () => {
    const url = normalizeUrl(value);
    if (url) run({ link: url }, []);
  };
  const remove = () => run({}, ["link"]);
  return (
    <div className="row" style={{ flexWrap: "wrap" }} data-testid="link-row">
      <IconButton title={`${ranged ? "Link the selected text" : "Select text to link"} (${MOD}K)`} on={open || !!current} disabled={!ranged} onClick={() => setOpen(!open)}>
        <LinkIcon size={13} />
      </IconButton>
      {ranged && !open && current && <span className="muted small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={current}>{current}</span>}
      {ranged && open && (
        <>
          <input
            ref={input}
            className="textinput"
            style={{ flex: 1, minWidth: 0, padding: "4px 8px" }}
            placeholder="https://example.com"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") apply();
              if (e.key === "Escape") {
                setOpen(false);
                window.dispatchEvent(new Event("dt-refocus-text"));
              }
            }}
          />
          <button className="btn" onClick={apply}>
            Apply
          </button>
          {current && (
            <IconButton title="Remove link" onClick={remove}>
              <Unlink size={13} />
            </IconButton>
          )}
        </>
      )}
    </div>
  );
}

/** Links the text carries, each with the words it covers and a way to remove it. */
function LinkList({ nodes }: { nodes: Node[] }) {
  if (nodes.length !== 1) return null;
  const n = nodes[0];
  const links = (n.text!.runs ?? []).filter((r) => r.link);
  if (!links.length) return null;
  const chars = Array.from(n.text!.characters);
  return (
    <div style={{ marginBottom: 6 }} data-testid="link-list">
      {links.map((r) => (
        <div className="row" key={`${r.start}-${r.end}`} style={{ marginBottom: 2 }}>
          <LinkIcon size={11} />
          <span className="small" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${chars.slice(r.start, r.end).join("")} → ${r.link}`}>
            {chars.slice(r.start, r.end).join("")} <span className="muted">{r.link}</span>
          </span>
          <IconButton title="Remove link" onClick={() => dispatch({ op: "styleText", id: n.id, start: r.start, end: r.end, style: {}, clear: ["link"] })}>
            <Unlink size={12} />
          </IconButton>
        </div>
      ))}
    </div>
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
        <>
          {keyName === "fills" && <ApplyStyleButton kind="fill" ids={ids} />}
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
        </>
      }
    >
      {keyName === "fills" && <StyleChip kind="fill" nodes={nodes} ids={ids} />}
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

const GRID_DEFAULTS: Record<LayoutGrid["pattern"], LayoutGrid> = {
  columns: { pattern: "columns", count: 12, gutter: 20, margin: 20, size: 60, alignment: "stretch", color: "#FF00001A", visible: true },
  rows: { pattern: "rows", count: 6, gutter: 20, margin: 20, size: 60, alignment: "stretch", color: "#0D99FF1A", visible: true },
  grid: { pattern: "grid", count: 1, gutter: 0, margin: 0, size: 8, alignment: "stretch", color: "#FF00001A", visible: true },
};

/** Layout grids on a frame: canvas overlay plus snapping (never exported). */
function GridSection({ node }: { node: Node }) {
  const list = node.layoutGrids ?? [];
  const [open, setOpen] = useState<number | null>(null);
  const set = (layoutGrids: LayoutGrid[]) => update([node.id], { layoutGrids });
  const label = (g: LayoutGrid) => (g.pattern === "grid" ? `Grid (${g.size}px)` : `${g.count} ${g.pattern}`);
  return (
    <Section
      title="Layout grid"
      actions={
        <IconButton title="Add layout grid" onClick={() => (set([...list, list.length ? GRID_DEFAULTS.grid : GRID_DEFAULTS.columns]), setOpen(list.length))}>
          <Plus size={14} />
        </IconButton>
      }
    >
      {list.map((g, i) => {
        const setG = (patch: Partial<LayoutGrid>) => set(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <div className="row">
              <button className="btn" style={{ flex: 1, justifyContent: "flex-start" }} onClick={() => setOpen(open === i ? null : i)}>
                <Scan size={13} /> {label(g)}
              </button>
              <IconButton title={g.visible ? "Hide" : "Show"} onClick={() => setG({ visible: !g.visible })}>
                {g.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </IconButton>
              <IconButton title="Remove" onClick={() => set(list.filter((_, j) => j !== i))}>
                <Minus size={13} />
              </IconButton>
            </div>
            {open === i && (
              <>
                <div className="row">
                  <SelectField
                    value={g.pattern}
                    options={[
                      { value: "columns", label: "Columns" },
                      { value: "rows", label: "Rows" },
                      { value: "grid", label: "Grid" },
                    ]}
                    onChange={(pattern) => setG({ ...GRID_DEFAULTS[pattern], color: g.color, visible: g.visible })}
                  />
                  {g.pattern !== "grid" && (
                    <SelectField
                      value={g.alignment}
                      options={[
                        { value: "stretch", label: "Stretch" },
                        { value: "start", label: g.pattern === "columns" ? "Left" : "Top" },
                        { value: "center", label: "Center" },
                        { value: "end", label: g.pattern === "columns" ? "Right" : "Bottom" },
                      ]}
                      onChange={(alignment) => setG({ alignment })}
                    />
                  )}
                </div>
                <div className="grid2">
                  {g.pattern === "grid" ? (
                    <NumberField label="Size" min={1} value={g.size} onChange={(size) => setG({ size })} onScrubStart={begin} onScrubEnd={end} />
                  ) : (
                    <>
                      <NumberField label="Count" min={1} value={g.count} onChange={(count) => setG({ count: Math.max(1, Math.round(count)) })} onScrubStart={begin} onScrubEnd={end} />
                      <NumberField label="Gutter" min={0} value={g.gutter} onChange={(gutter) => setG({ gutter })} onScrubStart={begin} onScrubEnd={end} />
                      {g.alignment !== "center" && <NumberField label="Margin" min={0} value={g.margin} onChange={(margin) => setG({ margin })} onScrubStart={begin} onScrubEnd={end} />}
                      {g.alignment !== "stretch" && <NumberField label="Width" min={1} value={g.size} onChange={(size) => setG({ size })} onScrubStart={begin} onScrubEnd={end} />}
                    </>
                  )}
                </div>
                <div className="row">
                  <PaintSwatch paint={{ type: "solid", color: g.color, opacity: 1, visible: true }} onChange={(p) => p.type === "solid" && setG({ color: p.color })} onOpen={begin} onClose={end} />
                  <span className="muted">{g.color}</span>
                </div>
              </>
            )}
          </div>
        );
      })}
      {list.length > 0 && !useStore.getState().showGrids && <div className="muted small">Layout grids are hidden (⇧⌘4 to show).</div>}
    </Section>
  );
}

const BINDABLE: { prop: string; label: string; kind: VarKind; applies: (n: Node) => boolean }[] = [
  { prop: "fill", label: "Fill", kind: "color", applies: (n) => n.type !== "group" && n.type !== "line" },
  { prop: "stroke", label: "Stroke", kind: "color", applies: (n) => n.type !== "group" },
  { prop: "cornerRadius", label: "Radius", kind: "number", applies: (n) => ["rectangle", "frame", "component", "instance"].includes(n.type) },
  { prop: "gap", label: "Gap", kind: "number", applies: (n) => !!n.layout },
  { prop: "padding", label: "Padding", kind: "number", applies: (n) => !!n.layout },
  { prop: "opacity", label: "Opacity", kind: "number", applies: () => true },
  { prop: "width", label: "Width", kind: "number", applies: () => true },
  { prop: "height", label: "Height", kind: "number", applies: () => true },
  { prop: "fontSize", label: "Font size", kind: "number", applies: (n) => n.type === "text" },
  { prop: "characters", label: "Text", kind: "string", applies: (n) => n.type === "text" },
  { prop: "visible", label: "Visible", kind: "boolean", applies: () => true },
];

/** Bind properties to variables and pick variable modes for frames. */
function VariablesSection({ nodes, ids }: { nodes: Node[]; ids: string[] }) {
  const doc = useDoc();
  const [showAll, setShowAll] = useState(false);
  const colls = doc.variables ?? [];
  if (!colls.some((c) => c.variables.length)) return null;
  const rows = BINDABLE.filter((b) => nodes.every(b.applies));
  const frames = nodes.every((n) => ["frame", "component", "instance", "group"].includes(n.type));
  const multiMode = colls.filter((c) => c.modes.length > 1);
  const bound = rows.filter((b) => nodes.some((n) => n.bindings?.[b.prop]));
  const visibleRows = showAll ? rows : bound;
  return (
    <Section
      title="Variables"
      actions={
        <IconButton title={showAll ? "Show bound only" : "Bind a property"} on={showAll} onClick={() => setShowAll(!showAll)}>
          <Plus size={14} />
        </IconButton>
      }
    >
      {frames &&
        multiMode.map((c) => {
          const mode = common(nodes, (n) => n.variableModes?.[c.id] ?? "");
          return (
            <div key={c.id} className="row">
              <span className="muted small" style={{ width: 64 }}>
                {c.name}
              </span>
              <SelectField
                value={mode === MIXED ? "" : mode}
                options={[{ value: "", label: `Auto (${c.modes[0].name})` }, ...c.modes.map((m) => ({ value: m.id, label: m.name }))]}
                onChange={(m) => dispatch({ op: "setVariableMode", ids, collection: c.id, mode: m || null })}
              />
            </div>
          );
        })}
      {visibleRows.map((b) => {
        const cur = common(nodes, (n) => n.bindings?.[b.prop] ?? "");
        const options = colls.flatMap((c) => c.variables.filter((v) => v.type === b.kind).map((v) => ({ value: v.id, label: colls.length > 1 ? `${c.name} / ${v.name}` : v.name })));
        return (
          <div key={b.prop} className="row">
            <span className="muted small" style={{ width: 64 }}>
              {b.label}
            </span>
            <SelectField
              value={cur === MIXED ? "" : cur}
              options={[{ value: "", label: options.length ? "Not bound" : `No ${b.kind} variables` }, ...options]}
              onChange={(v) => dispatch({ op: "bindVariable", ids, property: b.prop, variable: v || null })}
            />
          </div>
        );
      })}
      {!visibleRows.length && !(frames && multiMode.length) && <div className="muted small">Click + to bind fill, radius, spacing or text to a variable.</div>}
    </Section>
  );
}

const EXPORT_SIZES = [
  { value: "0.5", label: "0.5x" },
  { value: "0.75", label: "0.75x" },
  { value: "1", label: "1x" },
  { value: "1.5", label: "1.5x" },
  { value: "2", label: "2x" },
  { value: "3", label: "3x" },
  { value: "4", label: "4x" },
  { value: "w", label: "Width" },
  { value: "h", label: "Height" },
];

/** Figma's Export section: any number of rows per layer, saved on the layer. */
function ExportSection({ nodes, ids }: { nodes: Node[]; ids: string[] }) {
  const stored = common(nodes, (n) => n.exportSettings ?? []);
  const first = nodes[0];
  const saved: ExportSetting[] = stored === MIXED ? (first.exportSettings ?? []) : stored;
  // A layer without rows still shows one (not saved until it is edited), so it exports in two clicks.
  const rows = saved.length ? saved : [DEFAULT_EXPORT];
  const set = (next: ExportSetting[]) => update(ids, { exportSettings: next });
  const setRow = (i: number, patch: Partial<ExportSetting>) =>
    set(
      rows.map((r, j) => {
        if (j !== i) return r;
        // A fixed width or height replaces the other; undefined drops the key.
        const { width, height, ...rest } = { ...r, ...patch };
        return { ...rest, ...(width ? { width } : {}), ...(height ? { height } : {}) };
      }),
    );
  const sizeOf = (r: ExportSetting) => (r.width ? "w" : r.height ? "h" : String(r.scale));
  const setSize = (i: number, v: string) => {
    if (v === "w") setRow(i, { width: Math.max(1, Math.round(first.width)), height: undefined });
    else if (v === "h") setRow(i, { height: Math.max(1, Math.round(first.height)), width: undefined });
    else setRow(i, { scale: Number(v), width: undefined, height: undefined });
  };
  const sizeOptions = (r: ExportSetting) => (EXPORT_SIZES.some((o) => o.value === sizeOf(r)) ? EXPORT_SIZES : [...EXPORT_SIZES, { value: sizeOf(r), label: `${r.scale}x` }]);
  const add = () => {
    const last = rows[rows.length - 1];
    const presets = [0.5, 1, 2, 3, 4];
    const next = presets.find((p) => p > (last.width || last.height ? 1 : last.scale)) ?? 1;
    set([...rows, { format: last.format, scale: next, suffix: "" }]);
  };
  return (
    <Section
      title="Export"
      actions={
        <IconButton title="Add export setting" onClick={add}>
          <Plus size={14} />
        </IconButton>
      }
    >
      {rows.map((r, i) => {
        const svg = r.format === "svg";
        const fixed = !svg && (r.width || r.height);
        return (
          <div key={i} className="export-row" style={{ marginBottom: 8 }}>
            <div className="grid2" style={svg ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
              {!svg && <SelectField value={sizeOf(r)} options={sizeOptions(r)} onChange={(v) => setSize(i, v)} />}
              <SelectField
                value={r.format}
                options={[
                  { value: "png", label: "PNG" },
                  { value: "jpg", label: "JPG" },
                  { value: "svg", label: "SVG" },
                ]}
                onChange={(format) => setRow(i, { format })}
              />
            </div>
            {fixed && (
              <div className="grid2">
                <NumberField
                  label={r.width ? "W" : "H"}
                  min={1}
                  suffix="px"
                  value={r.width || r.height || 1}
                  onChange={(v) => setRow(i, r.width ? { width: Math.max(1, Math.round(v)) } : { height: Math.max(1, Math.round(v)) })}
                />
              </div>
            )}
            <div className="row">
              <input
                key={`${first.id}:${i}:${r.suffix}`}
                className="textinput"
                placeholder={`Suffix ${rowSuffix(r) || "(none)"}`}
                title="File name suffix"
                defaultValue={r.suffix}
                onKeyDown={(e) => (e.key === "Enter" && e.currentTarget.blur(), e.stopPropagation())}
                onBlur={(e) => e.target.value !== r.suffix && setRow(i, { suffix: e.target.value })}
              />
              {saved.length > 0 && (
                <IconButton title="Remove export setting" onClick={() => set(saved.filter((_, j) => j !== i))}>
                  <Minus size={13} />
                </IconButton>
              )}
            </div>
          </div>
        );
      })}
      <button className="btn block" onClick={() => exportLayers(ids)}>
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
