// Dev Mode style inspection for the Code tab: a layer's size, layout, colours, type, effects,
// notes and downloadable assets, each value copyable with a click.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import { getDoc, useStore } from "../store";
import { assetUrl } from "../assets";
import { downloadImageAsset, downloadLayerAsset } from "../exporter";
import { Seg } from "../ui/controls";
import { formatColor, type ColorFormat } from "../ui/color";
import type { Doc, Effect, Node, Paint } from "../types";

const FORMATS: { value: ColorFormat; label: string }[] = [
  { value: "hex", label: "Hex" },
  { value: "rgb", label: "RGB" },
  { value: "hsl", label: "HSL" },
  { value: "css", label: "CSS" },
];
const FORMAT_KEY = "dt:inspect-color-format";
/** Most assets listed for one selection. */
const MAX_ASSETS = 40;
/** Most layers scanned for assets in one selection (a whole page selected can be huge). */
const MAX_SCAN = 4000;

export function Inspect({ node }: { node: Node }) {
  // Re-read only when the document changes, never per frame.
  const docRev = useStore((s) => s.es.docRev);
  const [format, setFormat] = useState<ColorFormat>(readFormat);
  const [copied, setCopied] = useState("");
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = (text: string) => {
    const done = () => {
      setCopied(text);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(""), 1400);
    };
    navigator.clipboard.writeText(text).then(done, () => {});
  };
  const pick = (f: ColorFormat) => {
    setFormat(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      // Private window: the choice lasts until the panel closes.
    }
  };
  const doc = getDoc();
  const info = useMemo(() => describe(doc, node), [node, docRev]);
  const assets = useMemo(() => collectAssets(doc, node), [node.id, docRev]);
  const val = (text: string, label?: string) => <Val key={label ?? text} text={text} label={label} copied={copied === text} onCopy={copy} />;
  const L = node.layout;
  return (
    <div className="section insp" data-testid="inspect">
      <div className="section-head">
        <span>Inspect</span>
        <span className="insp-live" role="status">
          {copied ? "Copied" : ""}
        </span>
      </div>
      <Group title="Layout">
        <Row k="Size">
          {val(`${r(node.width)}`, "Width")} <span className="muted">x</span> {val(`${r(node.height)}`, "Height")}
        </Row>
        <Row k="Position">
          {val(`${r(node.x)}`, "X")} <span className="muted">,</span> {val(`${r(node.y)}`, "Y")}
        </Row>
        {node.rotation !== 0 && <Row k="Rotation">{val(`${r(node.rotation)}deg`)}</Row>}
        <Row k="Sizing">
          <span className="muted">
            W {node.sizingH}, H {node.sizingV}
          </span>
        </Row>
        {L && (
          <>
            <Row k="Auto layout">
              <span>{L.direction === "horizontal" ? "Horizontal" : "Vertical"}</span>
              {L.wrap && <span className="muted"> wrap</span>}
            </Row>
            <Row k="Gap">
              {val(`${r(L.gap)}`, "Gap")}
              {node.bindings.gap && <Name kind="Variable" name={varName(doc, node.bindings.gap)} />}
              {L.wrap && <span className="muted"> / {val(`${r(L.counterGap)}`, "Cross gap")}</span>}
            </Row>
            <Row k="Align">
              <span className="muted">
                {L.primaryAlign}, {L.counterAlign}
              </span>
            </Row>
            <Row k="Padding">
              <div className="insp-box" aria-label="Padding">
                <div className="insp-pt">{val(`${r(L.paddingTop)}`, "Padding top")}</div>
                <div className="insp-mid">
                  <div className="insp-pl">{val(`${r(L.paddingLeft)}`, "Padding left")}</div>
                  <div className="insp-inner">
                    {r(node.width)} x {r(node.height)}
                  </div>
                  <div className="insp-pr">{val(`${r(L.paddingRight)}`, "Padding right")}</div>
                </div>
                <div className="insp-pb">{val(`${r(L.paddingBottom)}`, "Padding bottom")}</div>
              </div>
            </Row>
            {node.bindings.padding && (
              <Row k="">
                <Name kind="Variable" name={varName(doc, node.bindings.padding)} />
              </Row>
            )}
          </>
        )}
      </Group>
      <Group title="Appearance">
        {info.radius && (
          <Row k="Radius">
            {val(info.radius)}
            {node.bindings.cornerRadius && <Name kind="Variable" name={varName(doc, node.bindings.cornerRadius)} />}
          </Row>
        )}
        <Row k="Opacity">
          {val(`${Math.round(node.opacity * 100)}%`)}
          {node.bindings.opacity && <Name kind="Variable" name={varName(doc, node.bindings.opacity)} />}
        </Row>
        <Row k="Blend">{val(node.blendMode)}</Row>
      </Group>
      {(info.fills.length > 0 || info.strokes.length > 0) && (
        <Group
          title="Colours"
          actions={<Seg ariaLabel="Colour format" value={format} options={FORMATS} onChange={pick} />}
        >
          {info.fills.map((c, i) => (
            <ColorRow key={`f${i}`} kind="Fill" c={c} format={format} val={val} />
          ))}
          {info.strokes.map((c, i) => (
            <ColorRow key={`s${i}`} kind="Stroke" c={c} format={format} val={val} />
          ))}
          {info.strokes.length > 0 && (
            <Row k="Stroke">
              {val(`${r(node.strokeWeight)}px`)} <span className="muted">{node.strokeAlign}</span>
            </Row>
          )}
        </Group>
      )}
      {node.text && (
        <Group title="Typography">
          {info.textStyle && (
            <Row k="Style">
              <Name kind="Text style" name={info.textStyle} />
            </Row>
          )}
          <Row k="Font">{val(node.text.fontFamily)}</Row>
          <Row k="Weight">
            {val(`${node.text.fontWeight}`)}
            {node.text.italic && <span className="muted"> italic</span>}
          </Row>
          <Row k="Size">
            {val(`${r(node.text.fontSize)}px`)}
            {node.bindings.fontSize && <Name kind="Variable" name={varName(doc, node.bindings.fontSize)} />}
          </Row>
          <Row k="Line height">{val(node.text.lineHeight == null ? "auto" : `${r(node.text.lineHeight)}px`)}</Row>
          <Row k="Letter spacing">{val(`${r(node.text.letterSpacing)}px`)}</Row>
          <Row k="Align">
            <span className="muted">
              {node.text.alignH}
              {node.text.decoration !== "none" ? `, ${node.text.decoration}` : ""}
              {node.text.case !== "original" ? `, ${node.text.case}` : ""}
            </span>
          </Row>
        </Group>
      )}
      {node.effects.length > 0 && (
        <Group title="Effects">
          {node.effects.map((e, i) => (
            <Row key={i} k={effectLabel(e)}>
              {val(effectCss(e))}
              {!e.visible && <span className="muted"> hidden</span>}
            </Row>
          ))}
        </Group>
      )}
      {node.notes && (
        <Group title="Note">
          <div className="insp-note" role="note" data-testid="inspect-note">
            {node.notes}
          </div>
        </Group>
      )}
      <Group title={`Assets${assets.length ? ` (${assets.length})` : ""}`}>
        {assets.length === 0 && <div className="muted small">No image fills or exportable layers in this selection.</div>}
        {assets.map((a) => (
          <div className="insp-asset" key={a.key}>
            {a.thumb ? <img src={a.thumb} alt="" width={24} height={24} /> : <span className="insp-thumb" aria-hidden="true" />}
            <span className="insp-asset-name" title={a.name}>
              {a.name}
              <span className="muted small"> {a.kind}</span>
            </span>
            <button
              className="ibtn"
              title={`Download ${a.name}`}
              aria-label={`Download ${a.name}`}
              onClick={() => (a.assetId ? downloadImageAsset(a.assetId, a.name) : downloadLayerAsset(a.nodeId))}
            >
              <Download size={13} />
            </button>
          </div>
        ))}
      </Group>
    </div>
  );
}

// ---------- Pieces ----------

function Group(props: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="insp-group" role="group" aria-label={props.title}>
      <div className="insp-title">
        <span>{props.title}</span>
        {props.actions}
      </div>
      {props.children}
    </div>
  );
}

function Row(props: { k: string; children: ReactNode }) {
  return (
    <div className="insp-row">
      <span className="insp-k">{props.k}</span>
      <span className="insp-v">{props.children}</span>
    </div>
  );
}

/** A value that copies itself on click. */
function Val(props: { text: string; label?: string; copied: boolean; onCopy: (t: string) => void }) {
  return (
    <button className={"insp-val" + (props.copied ? " copied" : "")} title="Copy" aria-label={`${props.label ?? "Value"} ${props.text}, copy`} onClick={() => props.onCopy(props.text)}>
      {props.text}
    </button>
  );
}

function Name(props: { kind: string; name: string }) {
  return (
    <span className="insp-name" title={props.kind}>
      {props.kind}: {props.name}
    </span>
  );
}

interface Swatch {
  paint: Paint;
  /** The value in each format. Gradients list their stops. */
  values: { hex: string; opacity: number }[];
  /** Linked colour style or bound variable. */
  link?: { kind: "Style" | "Variable"; name: string; css: string };
}

function ColorRow(props: { kind: string; c: Swatch; format: ColorFormat; val: (text: string, label?: string) => ReactNode }) {
  const { c, format } = props;
  const text = (v: { hex: string; opacity: number }) => (format === "css" && c.link ? c.link.css : formatColor(v.hex, v.opacity, format));
  const p = c.paint;
  return (
    <Row k={props.kind}>
      <span className="insp-swatch" style={{ background: swatchCss(p) }} aria-hidden="true" />
      {p.type === "image" ? (
        <span>Image ({p.scaleMode})</span>
      ) : (
        <>
          {p.type !== "solid" && <span className="muted">{p.type === "linearGradient" ? "Linear " : "Radial "}</span>}
          {c.values.map((v, i) => props.val(text(v), `${props.kind} ${i + 1}`))}
        </>
      )}
      {c.link && <Name kind={c.link.kind} name={c.link.name} />}
    </Row>
  );
}

// ---------- Reading the node ----------

interface Info {
  radius: string;
  fills: Swatch[];
  strokes: Swatch[];
  textStyle: string;
}

/** Everything the panel shows that needs the document (linked style and variable names). */
function describe(doc: Doc, n: Node): Info {
  const radii = n.cornerRadii;
  const radius = radii && radii.some((v) => v !== radii[0]) ? radii.map(r).join(" ") : `${r(radii ? radii[0] : n.cornerRadius)}`;
  const colorStyle = n.fillStyle ? doc.styles.colors.find((s) => s.id === n.fillStyle) : undefined;
  const link = (prop: "fill" | "stroke"): Swatch["link"] => {
    const id = n.bindings[prop];
    if (id) {
      const name = varName(doc, id);
      return { kind: "Variable", name, css: `var(--${slug(name)})` };
    }
    if (prop === "fill" && colorStyle) return { kind: "Style", name: colorStyle.name, css: `var(--color-${slug(colorStyle.name)})` };
    return undefined;
  };
  const swatches = (paints: Paint[], prop: "fill" | "stroke"): Swatch[] =>
    paints
      .filter((p) => p.visible)
      .map((p, i) => ({
        paint: p,
        values: p.type === "solid" ? [{ hex: p.color, opacity: p.opacity }] : p.type === "image" ? [] : p.stops.map((s) => ({ hex: s.color, opacity: p.opacity })),
        // A style or variable names the layer's first paint.
        link: i === 0 ? link(prop) : undefined,
      }));
  return {
    radius: radius === "0" ? "" : radius,
    fills: swatches(n.fills, "fill"),
    strokes: swatches(n.strokes, "stroke"),
    textStyle: n.textStyle ? (doc.styles.texts.find((s) => s.id === n.textStyle)?.name ?? "") : "",
  };
}

interface AssetRow {
  key: string;
  name: string;
  kind: string;
  nodeId: string;
  /** Image fills download their original bytes. */
  assetId?: string;
  thumb?: string;
}

/** Image fills and exportable layers (own export rows, vectors) in a selection, itself included. */
function collectAssets(doc: Doc, root: Node): AssetRow[] {
  const out: AssetRow[] = [];
  const stack = [root.id];
  let scanned = 0;
  while (stack.length && scanned < MAX_SCAN) {
    const n = doc.nodes[stack.pop() as string];
    if (!n) continue;
    scanned++;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    for (const p of n.fills) {
      const m = p.type === "image" && p.visible ? p.src.match(/^asset:([a-z0-9_]+)$/) : null;
      if (m) out.push({ key: `${n.id}:${m[1]}`, name: n.name, kind: "image", nodeId: n.id, assetId: m[1], thumb: assetUrl(m[1]) });
    }
    const vector = n.type === "vector" || n.type === "polygon" || n.type === "star";
    if (n.exportSettings?.length) {
      out.push({ key: `${n.id}:export`, name: n.name, kind: n.exportSettings.map((e) => `${e.format.toUpperCase()}${e.scale !== 1 && e.format !== "svg" ? ` ${e.scale}x` : ""}`).join(", "), nodeId: n.id });
    } else if (vector) {
      out.push({ key: `${n.id}:svg`, name: n.name, kind: "SVG", nodeId: n.id });
    }
  }
  return out.slice(0, MAX_ASSETS);
}

function varName(doc: Doc, id: string): string {
  for (const c of doc.variables) {
    const v = c.variables.find((x) => x.id === id);
    if (v) return v.name;
  }
  return "(missing variable)";
}

/** `Brand/Primary 500` as the exported CSS custom property names it: `brand-primary-500`. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function effectLabel(e: Effect): string {
  return { dropShadow: "Drop shadow", innerShadow: "Inner shadow", layerBlur: "Layer blur", backgroundBlur: "Background blur" }[e.type];
}

function effectCss(e: Effect): string {
  if (e.type === "layerBlur" || e.type === "backgroundBlur") return `blur(${r(e.blur / 2)}px)`;
  return `${e.type === "innerShadow" ? "inset " : ""}${r(e.x)}px ${r(e.y)}px ${r(e.blur)}px ${r(e.spread)}px ${formatColor(e.color, 1, "css")}`;
}

function swatchCss(p: Paint): string {
  if (p.type === "solid") return formatColor(p.color, p.opacity, "rgb");
  if (p.type === "image") return "var(--panel-3)";
  const stops = p.stops.map((s) => `${formatColor(s.color, p.opacity, "rgb")} ${Math.round(s.position * 100)}%`).join(", ");
  return p.type === "linearGradient" ? `linear-gradient(${p.angle}deg, ${stops})` : `radial-gradient(circle, ${stops})`;
}

function readFormat(): ColorFormat {
  try {
    const v = localStorage.getItem(FORMAT_KEY);
    if (v === "hex" || v === "rgb" || v === "hsl" || v === "css") return v;
  } catch {
    // Storage blocked.
  }
  return "hex";
}

/** At most two decimals, no trailing zeros. */
function r(v: number): number {
  return Math.round(v * 100) / 100;
}
