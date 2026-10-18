import { useRef, useState } from "react";
import { Image as ImageIcon, Pipette, Plus, Trash2 } from "lucide-react";
import type { Paint } from "../types";
import { NumberField, Popover, Seg, SelectField } from "./controls";
import { addAsset, assetUrl, readFileAsDataUrl } from "../assets";
import { pickFile } from "../files";
import { getDoc } from "../store";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(hex: string): Rgba {
  const h = hex.replace("#", "");
  const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { r: n(0) || 0, g: n(2) || 0, b: n(4) || 0, a: full.length >= 8 ? n(6) / 255 : 1 };
}

export function toHex({ r, g, b }: Rgba): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function toHex8(c: Rgba): string {
  return c.a >= 0.999 ? toHex(c) : toHex(c) + Math.round(c.a * 255).toString(16).padStart(2, "0").toUpperCase();
}

export function cssColor(hex: string, opacity = 1): string {
  const c = parseColor(hex);
  return `rgba(${c.r},${c.g},${c.b},${c.a * opacity})`;
}

function rgbToHsv({ r, g, b }: Rgba) {
  const rr = r / 255,
    gg = g / 255,
    bb = b / 255;
  const max = Math.max(rr, gg, bb),
    min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** HSV picker with alpha, hex entry, eyedropper and document colour styles. */
export function ColorPicker(props: { color: string; onChange: (hex8: string) => void }) {
  const c = parseColor(props.color);
  const [hsv, setHsv] = useState(() => rgbToHsv(c));
  const [hexText, setHexText] = useState(toHex(c));
  const svRef = useRef<HTMLDivElement>(null);
  const emit = (h: number, s: number, v: number, a: number) => {
    setHsv({ h, s, v });
    const rgb = hsvToRgb(h, s, v);
    const hex = toHex8({ ...rgb, a });
    setHexText(toHex({ ...rgb, a }));
    props.onChange(hex);
  };
  const drag = (el: HTMLElement | null, fn: (x: number, y: number) => void) => (e: React.PointerEvent) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const run = (ev: { clientX: number; clientY: number }) =>
      fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
    run(e);
    const move = (ev: PointerEvent) => run(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const hueRgb = hsvToRgb(hsv.h, 1, 1);
  const styles = getDoc().styles.colors;
  return (
    <div>
      <div
        ref={svRef}
        className="picker-sv"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, rgb(${hueRgb.r},${hueRgb.g},${hueRgb.b}))` }}
        onPointerDown={(e) => drag(svRef.current, (x, y) => emit(hsv.h, x, 1 - y, c.a))(e)}
      >
        <div className="dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div
        className="picker-bar"
        style={{ background: "linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)" }}
        onPointerDown={(e) => drag(e.currentTarget as HTMLElement, (x) => emit(x * 359.9, hsv.s, hsv.v, c.a))(e)}
      >
        <div className="dot" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
      <div
        className="picker-bar swatch"
        style={{ width: "100%", height: 12, borderRadius: 6 }}
        onPointerDown={(e) => drag(e.currentTarget as HTMLElement, (x) => emit(hsv.h, hsv.s, hsv.v, x))(e)}
      >
        <i style={{ background: `linear-gradient(to right, transparent, ${toHex(c)})` }} />
        <div className="dot" style={{ left: `${c.a * 100}%` }} />
      </div>
      <div className="row">
        <label className="field">
          <span className="lbl">#</span>
          <input
            value={hexText.replace("#", "")}
            onChange={(e) => setHexText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            onBlur={() => {
              const v = hexText.replace("#", "");
              if (/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) {
                const nc = parseColor(v);
                const a = v.length === 8 ? nc.a : c.a;
                setHsv(rgbToHsv(nc));
                props.onChange(toHex8({ ...nc, a }));
              }
            }}
          />
        </label>
        <div style={{ width: 70 }}>
          <NumberField value={Math.round(c.a * 100)} suffix="%" min={0} max={100} onChange={(v) => emit(hsv.h, hsv.s, hsv.v, v / 100)} />
        </div>
        {"EyeDropper" in window && (
          <button
            className="ibtn"
            title="Pick colour from screen"
            onClick={async () => {
              try {
                const r = await new (window as any).EyeDropper().open();
                const nc = parseColor(r.sRGBHex);
                setHsv(rgbToHsv(nc));
                setHexText(toHex(nc));
                props.onChange(toHex8({ ...nc, a: c.a }));
              } catch {
                /* cancelled */
              }
            }}
          >
            <Pipette size={14} />
          </button>
        )}
      </div>
      {styles.length > 0 && (
        <>
          <div className="small muted" style={{ marginTop: 8 }}>
            Colour styles
          </div>
          <div className="picker-swatches">
            {styles.map((s) => (
              <div
                key={s.id}
                className="swatch"
                title={s.name}
                onClick={() => {
                  const nc = parseColor(s.color);
                  setHsv(rgbToHsv(nc));
                  setHexText(toHex(nc));
                  props.onChange(s.color);
                }}
              >
                <i style={{ background: cssColor(s.color) }} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function paintCss(p: Paint): string {
  switch (p.type) {
    case "solid":
      return cssColor(p.color, p.opacity);
    case "linearGradient":
      return `linear-gradient(${p.angle}deg, ${p.stops.map((s) => `${cssColor(s.color, p.opacity)} ${s.position * 100}%`).join(", ")})`;
    case "radialGradient":
      return `radial-gradient(circle, ${p.stops.map((s) => `${cssColor(s.color, p.opacity)} ${s.position * 100}%`).join(", ")})`;
    case "image": {
      const src = p.src.startsWith("asset:") ? assetUrl(p.src.slice(6)) ?? "" : p.src;
      return `center / cover no-repeat url("${src}")`;
    }
  }
}

export function paintLabel(p: Paint): string {
  switch (p.type) {
    case "solid":
      return p.color.replace("#", "").slice(0, 6);
    case "linearGradient":
      return "Linear";
    case "radialGradient":
      return "Radial";
    case "image":
      return "Image";
  }
}

/** Edits one paint (solid, gradient or image) in a popover. */
export function PaintEditor(props: { paint: Paint; onChange: (p: Paint) => void }) {
  const p = props.paint;
  const [stop, setStop] = useState(0);
  const toType = (t: Paint["type"]) => {
    const base = p.type === "solid" ? p.color : p.type === "image" ? "#D9D9D9" : p.stops[0]?.color ?? "#000000";
    if (t === "solid") props.onChange({ type: "solid", color: base, opacity: p.opacity, visible: p.visible });
    else if (t === "linearGradient" || t === "radialGradient") {
      const stops = p.type === "linearGradient" || p.type === "radialGradient" ? p.stops : [{ color: base, position: 0 }, { color: "#FFFFFF", position: 1 }];
      props.onChange(t === "linearGradient" ? { type: t, stops, angle: 180, opacity: p.opacity, visible: p.visible } : { type: t, stops, opacity: p.opacity, visible: p.visible });
    } else props.onChange({ type: "image", src: "", scaleMode: "fill", opacity: p.opacity, visible: p.visible });
  };
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <Seg
          value={p.type}
          onChange={toType}
          options={[
            { value: "solid", label: "Solid" },
            { value: "linearGradient", label: "Linear" },
            { value: "radialGradient", label: "Radial" },
            { value: "image", label: <ImageIcon size={13} />, title: "Image" },
          ]}
        />
      </div>
      {p.type === "solid" && <ColorPicker key="solid" color={p.color} onChange={(color) => props.onChange({ ...p, color })} />}
      {(p.type === "linearGradient" || p.type === "radialGradient") && (
        <>
          <div className="picker-bar" style={{ background: paintCss({ ...p, type: "linearGradient", angle: 90 } as Paint), height: 16, marginBottom: 12 }}>
            {p.stops.map((s, i) => (
              <div
                key={i}
                className="dot"
                style={{ left: `${s.position * 100}%`, background: s.color, outline: i === stop ? "2px solid #0d99ff" : undefined, pointerEvents: "all", cursor: "pointer" }}
                onPointerDown={() => setStop(i)}
              />
            ))}
          </div>
          <div className="row">
            {p.type === "linearGradient" && <NumberField label="∠" value={p.angle} suffix="°" onChange={(angle) => props.onChange({ ...p, angle })} />}
            <NumberField
              label="Pos"
              value={Math.round((p.stops[stop]?.position ?? 0) * 100)}
              suffix="%"
              min={0}
              max={100}
              onChange={(v) => props.onChange({ ...p, stops: p.stops.map((s, i) => (i === stop ? { ...s, position: v / 100 } : s)) })}
            />
            <button className="ibtn" title="Add stop" onClick={() => props.onChange({ ...p, stops: [...p.stops, { color: "#FFFFFF", position: 0.5 }].sort((a, b) => a.position - b.position) })}>
              <Plus size={14} />
            </button>
            <button
              className="ibtn"
              title="Remove stop"
              disabled={p.stops.length <= 2}
              onClick={() => {
                props.onChange({ ...p, stops: p.stops.filter((_, i) => i !== stop) });
                setStop(0);
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
          {p.stops[stop] && (
            <ColorPicker
              key={stop}
              color={p.stops[stop].color}
              onChange={(color) => props.onChange({ ...p, stops: p.stops.map((s, i) => (i === stop ? { ...s, color } : s)) })}
            />
          )}
        </>
      )}
      {p.type === "image" && (
        <>
          <div className="swatch" style={{ width: "100%", height: 120, borderRadius: 6, marginBottom: 8 }}>
            <i style={{ background: paintCss(p) }} />
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                const f = await pickFile("image/*");
                if (f) props.onChange({ ...p, src: "asset:" + addAsset(await readFileAsDataUrl(f)) });
              }}
            >
              Choose image…
            </button>
            <SelectField
              value={p.scaleMode}
              onChange={(scaleMode) => props.onChange({ ...p, scaleMode })}
              options={[
                { value: "fill", label: "Fill" },
                { value: "fit", label: "Fit" },
                { value: "stretch", label: "Stretch" },
                { value: "tile", label: "Tile" },
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Swatch that opens a paint editor popover. */
export function PaintSwatch(props: { paint: Paint; onChange: (p: Paint) => void; onOpen?: () => void; onClose?: () => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <div
        className="swatch"
        onClick={(e) => {
          setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
          props.onOpen?.();
        }}
      >
        <i style={{ background: paintCss(props.paint) }} />
      </div>
      {anchor && (
        <Popover
          anchor={anchor}
          onClose={() => {
            setAnchor(null);
            props.onClose?.();
          }}
        >
          <PaintEditor paint={props.paint} onChange={props.onChange} />
        </Popover>
      )}
    </>
  );
}
