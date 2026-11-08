// Dev Mode style inspection for the Code tab: a layer's size, layout, colours, type, effects,
// notes and downloadable assets, each value copyable with a click.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import { getDoc, query, toast, useStore } from "../store";
import { assetUrl } from "../assets";
import { downloadImageAsset, downloadLayerAsset } from "../exporter";
import { Seg } from "../ui/controls";
import { framePosition } from "./groupOffset";
import { constraintsText, strokeRows } from "./inspectStroke";
import { formatColor, parseColor, toHex, type ColorFormat } from "../ui/color";
import type { Doc, Effect, ImageCredit, Node, Paint, TextRun } from "../types";

// The stored value stays "css" (saved in localStorage); the label says what it is, so it can't be
// mistaken for the code language's "CSS".
const FORMATS: { value: ColorFormat; label: string; title?: string }[] = [
  { value: "hex", label: "Hex" },
  { value: "rgb", label: "RGB" },
  { value: "hsl", label: "HSL" },
  { value: "css", label: "Token", title: "CSS custom property when the colour comes from a style or variable, else CSS colour" },
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
    navigator.clipboard.writeText(text).then(done, () => toast("Could not copy: the browser blocked clipboard access", "error"));
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
  // The names the exported code gives styles and variables.
  const names = useMemo(() => query<Names>({ q: "inspectNames" }), [docRev]);
  const info = useMemo(() => describe(doc, node, names), [node, docRev, names]);
  const assets = useMemo(() => collectAssets(doc, node), [node.id, docRev]);
  const val = (text: string, label?: string) => <Val key={label ?? text} text={text} label={label} copied={copied === text} onCopy={copy} />;
  const L = node.layout;
  // The safe area a device frame added to its padding is not content padding (code writes it as env()).
  const applied = node.device?.applied ?? [0, 0, 0, 0];
  // Same X/Y as the design panel: measured from the frame, not from a group.
  const framePos = framePosition(doc.nodes, node);
  const constraints = constraintsText(node, node.parent ? doc.nodes[node.parent] : null);
  const strokeInfo = strokeRows(node);
  // The format toggle sits on whichever colour group comes first.
  const formatSeg = <Seg ariaLabel="Colour format" value={format} options={FORMATS} onChange={pick} />;
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
          {val(`${r(framePos.x)}`, "X")} <span className="muted">,</span> {val(`${r(framePos.y)}`, "Y")}
        </Row>
        {node.rotation !== 0 && <Row k="Rotation">{val(`${r(node.rotation)}deg`)}</Row>}
        <Row k="Sizing">
          <span className="muted">
            W {node.sizingH}, H {node.sizingV}
          </span>
        </Row>
        {constraints && (
          <Row k="Constraints">
            <span className="muted">{constraints}</span>
          </Row>
        )}
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
                <div className="insp-pt">{val(`${r(L.paddingTop - applied[0])}`, "Padding top")}</div>
                <div className="insp-mid">
                  <div className="insp-pl">{val(`${r(L.paddingLeft - applied[3])}`, "Padding left")}</div>
                  <div className="insp-inner">
                    {r(node.width)} x {r(node.height)}
                  </div>
                  <div className="insp-pr">{val(`${r(L.paddingRight - applied[1])}`, "Padding right")}</div>
                </div>
                <div className="insp-pb">{val(`${r(L.paddingBottom - applied[2])}`, "Padding bottom")}</div>
              </div>
            </Row>
            {applied.some((v) => v !== 0) && (
              <Row k="">
                <span className="muted small">+ safe area, added by the device ({applied.map((v) => r(v)).join(" ")})</span>
              </Row>
            )}
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
        <>
          {info.fills.length > 0 && (
            <Group title="Fill" actions={formatSeg}>
              {info.fills.map((c, i) => (
                <ColorRow key={`f${i}`} kind="Fill" c={c} format={format} val={val} />
              ))}
            </Group>
          )}
          {info.strokes.length > 0 && (
            <Group title="Stroke" actions={info.fills.length === 0 ? formatSeg : undefined}>
              {info.strokes.map((c, i) => (
                <ColorRow key={`s${i}`} kind="Colour" c={c} format={format} val={val} />
              ))}
              {strokeInfo.map((row) => (
                <Row key={row.k} k={row.k}>
                  {row.k === "Weight" || row.k === "Dash" ? val(row.v, `Stroke ${row.k.toLowerCase()}`) : <span className="muted">{row.v}</span>}
                  {row.note && <span className="muted small"> {row.note}</span>}
                </Row>
              ))}
            </Group>
          )}
        </>
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
          {node.text.runs.length > 0 && (
            <Row k="Mixed">
              <span className="insp-runs">
                {node.text.runs.slice(0, 8).map((run, i) => (
                  <span key={i} className="muted small">
                    {run.start}-{run.end}: {runLabel(run)}
                  </span>
                ))}
                {node.text.runs.length > 8 && <span className="muted small">+{node.text.runs.length - 8} more</span>}
              </span>
            </Row>
          )}
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
            {a.credit && <Credit c={a.credit} />}
          </div>
        ))}
      </Group>
    </div>
  );
}

// ---------- Pieces ----------

/** Where a stock photo came from and its licence (links are https only, see providers.safeLink). */
function Credit({ c }: { c: ImageCredit }) {
  const link = (url: string, text: string) =>
    url.startsWith("https://") ? (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {text}
      </a>
    ) : (
      text
    );
  return (
    <div className="insp-credit small" data-testid="photo-credit">
      <span>
        {link(c.sourceUrl, c.title || "Photo")}
        {c.author && <> by {link(c.authorUrl, c.author)}</>}
        {c.source && <span className="muted"> ({c.source})</span>}
      </span>
      <span>
        {link(c.licenseUrl, c.license || "Licence unknown")}
        {c.attributionRequired && <span className="insp-badge">Attribution required</span>}
        {c.nonCommercial && <span className="insp-badge warn">Non-commercial</span>}
      </span>
    </div>
  );
}

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
  /** The stops (or the one colour) of the paint. */
  values: { hex: string; opacity: number }[];
  /** Linked colour style or bound variable. */
  link?: { kind: "Style" | "Variable"; name: string; css: string };
}

/** What a paint is called in the panel. */
function paintName(p: Paint): string {
  const t: string = p.type;
  return t === "solid" ? "Solid" : t === "image" ? "Image" : t.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function ColorRow(props: { kind: string; c: Swatch; format: ColorFormat; val: (text: string, label?: string) => ReactNode }) {
  const { c, format } = props;
  const p = c.paint;
  const one = (v: { hex: string; opacity: number }) => (format === "css" && c.link ? c.link.css : formatColor(v.hex, v.opacity, format));
  // Linear and radial gradients are one CSS value; other kinds list their stops.
  const gradient = p.type === "linearGradient" || p.type === "radialGradient" ? gradientText(p, format) : "";
  return (
    <Row k={props.kind}>
      <span className="insp-swatch" style={{ background: swatchCss(p) }} aria-hidden="true" />
      {p.type === "image" ? (
        <span>Image ({p.scaleMode})</span>
      ) : gradient ? (
        props.val(gradient, `${props.kind} ${paintName(p)}`)
      ) : (
        <>
          {p.type !== "solid" && <span className="muted">{paintName(p)} </span>}
          {c.values.map((v, i) => props.val(one(v), `${props.kind} ${i + 1}`))}
        </>
      )}
      {c.link && <Name kind={c.link.kind} name={c.link.name} />}
    </Row>
  );
}

function gradientText(p: Paint, format: ColorFormat): string {
  if (p.type !== "linearGradient" && p.type !== "radialGradient") return "";
  const stops = p.stops.map((s) => `${formatColor(s.color, p.opacity, format)} ${Math.round(s.position * 1000) / 10}%`).join(", ");
  return p.type === "linearGradient" ? `linear-gradient(${Math.round(p.angle * 100) / 100}deg, ${stops})` : `radial-gradient(circle, ${stops})`;
}

function runLabel(run: TextRun): string {
  const bits: string[] = [];
  if (run.fontFamily) bits.push(run.fontFamily);
  if (run.fontSize) bits.push(`${run.fontSize}px`);
  if (run.fontWeight) bits.push(`${run.fontWeight}`);
  if (run.italic) bits.push("italic");
  if (run.color) bits.push(run.color);
  if (run.link) bits.push("link");
  return bits.join(" ") || "styled";
}

// ---------- Reading the node ----------

interface Info {
  radius: string;
  fills: Swatch[];
  strokes: Swatch[];
  textStyle: string;
}

/** Names the engine gives styles and variables in exported code (`Query::Inspect`). */
interface Names {
  colorStyles: Record<string, string>;
  textStyles: Record<string, string>;
  variables: Record<string, string>;
}

/** Everything the panel shows that needs the document (linked style and variable names). */
function describe(doc: Doc, n: Node, names: Names): Info {
  const radii = n.cornerRadii;
  const radius = radii && radii.some((v) => v !== radii[0]) ? radii.map(r).join(" ") : `${r(radii ? radii[0] : n.cornerRadius)}`;
  const colorStyle = n.fillStyle ? doc.styles.colors.find((s) => s.id === n.fillStyle) : undefined;
  const sameColor = (a: string, b: string) => toHex(parseColor(a)) === toHex(parseColor(b));
  const link = (prop: "fill" | "stroke", p: Paint, first: boolean): Swatch["link"] => {
    const id = n.bindings[prop];
    if (id && first) {
      const name = varName(doc, id);
      return { kind: "Variable", name, css: `var(${names.variables[id] ?? "--" + slug(name)})` };
    }
    // The style names a fill only while that fill still has the style's colour.
    if (prop === "fill" && colorStyle && p.type === "solid" && p.opacity >= 1 && sameColor(p.color, colorStyle.color)) {
      return { kind: "Style", name: colorStyle.name, css: `var(${names.colorStyles[colorStyle.id] ?? "--color-" + slug(colorStyle.name)})` };
    }
    return undefined;
  };
  // Top paint first, as in the Design panel (the last paint draws on top).
  const swatches = (paints: Paint[], prop: "fill" | "stroke"): Swatch[] => {
    const visible = paints.filter((p) => p.visible);
    return visible
      .map((p, i) => ({
        paint: p,
        values: p.type === "solid" ? [{ hex: p.color, opacity: p.opacity }] : p.type === "image" ? [] : p.stops.map((s) => ({ hex: s.color, opacity: p.opacity })),
        link: link(prop, p, i === 0),
      }))
      .reverse();
  };
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
  /** Stock photo credit. */
  credit?: ImageCredit;
}

/** Image fills and exportable layers (own export rows, vectors) in a selection, itself included. */
function collectAssets(doc: Doc, root: Node): AssetRow[] {
  const out: AssetRow[] = [];
  const stack = [root.id];
  let scanned = 0;
  while (stack.length && scanned < MAX_SCAN) {
    const n = doc.nodes[stack.pop() as string];
    // System UI of a device frame is the device's, not an asset of the design.
    if (!n || n.devicePart) continue;
    scanned++;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    for (const p of n.fills) {
      const m = p.type === "image" && p.visible ? p.src.match(/^asset:([a-z0-9_]+)$/) : null;
      if (m) out.push({ key: `${n.id}:${m[1]}`, name: n.name, kind: "image", nodeId: n.id, assetId: m[1], thumb: assetUrl(m[1]), credit: p.type === "image" ? p.credit : undefined });
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
  if (p.type !== "linearGradient" && p.type !== "radialGradient") {
    // Other gradient kinds: a plain preview from their stops.
    const stops = (p as { stops?: { color: string; position: number }[] }).stops ?? [];
    return stops.length ? `linear-gradient(90deg, ${stops.map((s) => `${formatColor(s.color, 1, "rgb")} ${Math.round(s.position * 100)}%`).join(", ")})` : "var(--panel-3)";
  }
  return gradientText(p, "rgb");
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
