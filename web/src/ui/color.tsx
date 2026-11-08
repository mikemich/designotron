import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Pipette, Plus, RotateCw, Trash2 } from "lucide-react";
import type { GradientHandles, GradientPaintType, ImageCrop, ImageFilters, Paint } from "../types";
import { addStop } from "../gradient";
import { NumberField, Popover, Seg, SelectField } from "./controls";
import { addAsset, assetUrl, readFileAsDataUrl } from "../assets";
import { safeImageSrc } from "../imageSrc";
import { pickFile } from "../files";
import { getDoc, useStore } from "../store";
import { useCollab } from "../collab";
import { PhotoSearch } from "../panels/PhotoSearch";
import { paintAriaLabel, paintLabel } from "./paintText";
import { sliderKey, type SliderKind } from "./sliderKeys";

export { paintLabel };
import { photoPaint } from "../photos/place";

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
  const pct = (v: number) => Math.round(v * 100);
  /** A key on one of the sliders: the new colour from `sliderKey`, emitted like a drag. */
  const sliderKeys = (e: React.KeyboardEvent, kind: SliderKind) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const next = sliderKey(kind, e.key, e.shiftKey, { ...hsv, a: c.a });
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    emit(next.h, next.s, next.v, next.a);
  };
  return (
    <div>
      <div
        ref={svRef}
        className="picker-sv"
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct(hsv.s)}
        aria-valuetext={`Saturation ${pct(hsv.s)}%, brightness ${pct(hsv.v)}%`}
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, rgb(${hueRgb.r},${hueRgb.g},${hueRgb.b}))` }}
        onPointerDown={(e) => drag(svRef.current, (x, y) => emit(hsv.h, x, 1 - y, c.a))(e)}
        onKeyDown={(e) => sliderKeys(e, "sv")}
      >
        <div className="dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div
        className="picker-slider"
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuetext={`Hue ${Math.round(hsv.h)}°`}
        onPointerDown={(e) => drag(e.currentTarget.firstElementChild as HTMLElement, (x) => emit(x * 359.9, hsv.s, hsv.v, c.a))(e)}
        onKeyDown={(e) => sliderKeys(e, "hue")}
      >
        <div className="picker-bar" style={{ background: "linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)" }}>
          <div className="dot" style={{ left: `${(hsv.h / 360) * 100}%` }} />
        </div>
      </div>
      <div
        className="picker-slider"
        role="slider"
        tabIndex={0}
        aria-label="Alpha"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct(c.a)}
        aria-valuetext={`Alpha ${pct(c.a)}%`}
        onPointerDown={(e) => drag(e.currentTarget.firstElementChild as HTMLElement, (x) => emit(hsv.h, hsv.s, hsv.v, x))(e)}
        onKeyDown={(e) => sliderKeys(e, "alpha")}
      >
        <div className="picker-bar swatch" style={{ width: "100%", height: 12, borderRadius: 6 }}>
          <i style={{ background: `linear-gradient(to right, transparent, ${toHex(c)})` }} />
          <div className="dot" style={{ left: `${c.a * 100}%` }} />
        </div>
      </div>
      <div className="row">
        <label className="field">
          <span className="lbl">#</span>
          <input
            value={hexText.replace("#", "")}
            onChange={(e) => setHexText(e.target.value)}
            onKeyDown={(e) => {
              // Escape first puts back the colour; with nothing typed it reaches the popover and closes it.
              if (e.key === "Escape" && hexText.replace("#", "").toUpperCase() === toHex(c).slice(1)) return;
              e.stopPropagation();
              if (e.key === "Escape") setHexText(toHex(c));
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
          <NumberField ariaLabel="Alpha" value={Math.round(c.a * 100)} suffix="%" min={0} max={100} onChange={(v) => emit(hsv.h, hsv.s, hsv.v, v / 100)} />
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
              <button
                key={s.id}
                type="button"
                className="swatch"
                title={s.name}
                aria-label={`Colour style ${s.name}, ${s.color}`}
                onClick={() => {
                  const nc = parseColor(s.color);
                  setHsv(rgbToHsv(nc));
                  setHexText(toHex(nc));
                  props.onChange(s.color);
                }}
              >
                <i style={{ background: cssColor(s.color) }} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export type GradientPaint = Extract<Paint, { type: GradientPaintType }>;

export const GRADIENT_TYPES: GradientPaintType[] = ["linearGradient", "radialGradient", "angularGradient", "diamondGradient"];

export function isGradient(p: Paint): p is GradientPaint {
  return (GRADIENT_TYPES as string[]).includes(p.type);
}

/** CSS angle (0 = up, 90 = right) of the start to end line, on a square box. */
function handleAngle(h: GradientHandles): number {
  const deg = (Math.atan2(h.end[0] - h.start[0], -(h.end[1] - h.start[1])) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

export function paintCss(p: Paint): string {
  const stops = (g: GradientPaint) => g.stops.map((s) => `${cssColor(s.color, g.opacity)} ${s.position * 100}%`).join(", ");
  switch (p.type) {
    case "solid":
      return cssColor(p.color, p.opacity);
    case "linearGradient":
      return `linear-gradient(${p.angle}deg, ${stops(p)})`;
    // CSS has no diamond gradient: the swatch shows the radial approximation, like code export.
    case "radialGradient":
    case "diamondGradient":
      return `radial-gradient(circle, ${stops(p)})`;
    case "angularGradient": {
      const h = p.handles;
      return `conic-gradient(from ${h ? handleAngle(h) : 0}deg at ${(h?.start[0] ?? 0.5) * 100}% ${(h?.start[1] ?? 0.5) * 100}%, ${stops(p)})`;
    }
    case "image": {
      const src = !safeImageSrc(p.src) ? "" : p.src.startsWith("asset:") ? assetUrl(p.src.slice(6)) ?? "" : p.src;
      return `center / cover no-repeat url("${src}")`;
    }
  }
}

/** Where the whole image sits in a `w` x `h` layer for a scale mode: the starting rectangle of a crop. */
export function cropRectFor(mode: string, nw: number, nh: number, w: number, h: number): ImageCrop {
  if (mode === "stretch" || !nw || !nh || !w || !h) return { x: 0, y: 0, w: 1, h: 1 };
  const k = mode === "fit" ? Math.min(w / nw, h / nh) : Math.max(w / nw, h / nh);
  const [iw, ih] = [nw * k, nh * k];
  return { x: (w - iw) / 2 / w, y: (h - ih) / 2 / h, w: iw / w, h: ih / h };
}

/** Edits one paint (solid, gradient or image) in a popover. */
export function PaintEditor(props: { paint: Paint; onChange: (p: Paint) => void }) {
  const p = props.paint;
  const [stop, setStop] = useState(0);
  const [finding, setFinding] = useState(false);
  const [turnSaid, setTurnSaid] = useState("");
  const toType = (t: Paint["type"]) => {
    const base = p.type === "solid" ? p.color : p.type === "image" ? "#D9D9D9" : p.stops[0]?.color ?? "#000000";
    if (t === "solid") props.onChange({ type: "solid", color: base, opacity: p.opacity, visible: p.visible });
    else if (t === "image") props.onChange({ type: "image", src: "", scaleMode: "fill", opacity: p.opacity, visible: p.visible });
    else {
      // Gradients keep their stops and handles when you switch between the four kinds.
      const from = isGradient(p) ? p : null;
      const stops = from?.stops ?? [{ color: base, position: 0 }, { color: "#FFFFFF", position: 1 }];
      const handles = from?.handles;
      const angle = from?.type === "linearGradient" ? from.angle : handles ? handleAngle(handles) : 180;
      const common = { stops, opacity: p.opacity, visible: p.visible, ...(handles ? { handles } : {}) };
      props.onChange(t === "linearGradient" ? { type: t, angle, ...common } : { type: t, ...common });
    }
  };
  return (
    <div>
      <div className="paint-type" style={{ marginBottom: 10 }}>
        <Seg
          value={p.type}
          onChange={toType}
          options={[
            { value: "solid", label: "Solid" },
            { value: "linearGradient", label: "Linear" },
            { value: "radialGradient", label: "Radial" },
            { value: "angularGradient", label: "Angular" },
            { value: "diamondGradient", label: "Diamond" },
            { value: "image", label: <ImageIcon size={13} />, title: "Image" },
          ]}
        />
      </div>
      {p.type === "solid" && <ColorPicker key="solid" color={p.color} onChange={(color) => props.onChange({ ...p, color })} />}
      {isGradient(p) && (
        <>
          <div
            className="picker-bar"
            data-gradient-bar=""
            title="Click to add a stop"
            style={{ background: paintCss({ ...p, type: "linearGradient", angle: 90 } as Paint), height: 16, marginBottom: 12 }}
            onPointerDown={(e) => {
              // A click on the bar itself (not on a stop) adds a stop there, coloured by the gradient.
              if (e.target !== e.currentTarget || e.button !== 0) return;
              const box = e.currentTarget.getBoundingClientRect();
              const added = addStop(p.stops, (e.clientX - box.left) / box.width);
              props.onChange({ ...p, stops: added.stops });
              setStop(added.index);
            }}
          >
            {p.stops.map((s, i) => {
              const move = (to: number) => props.onChange({ ...p, stops: p.stops.map((x, j) => (j === i ? { ...x, position: Math.max(0, Math.min(1, to)) } : x)) });
              return (
                <button
                  key={i}
                  type="button"
                  className="dot stop-dot"
                  data-stop={i}
                  aria-label={`Stop ${i + 1} at ${Math.round(s.position * 100)}%, ${s.color}`}
                  aria-pressed={i === stop}
                  style={{ left: `${s.position * 100}%`, background: s.color, outline: i === stop ? "2px solid #0d99ff" : undefined, pointerEvents: "all", cursor: "pointer" }}
                  onPointerDown={() => setStop(i)}
                  onKeyDown={(e) => {
                    if (e.ctrlKey || e.metaKey || e.altKey) return;
                    const k = e.shiftKey ? 0.1 : 0.01;
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      e.preventDefault();
                      e.stopPropagation();
                      setStop(i);
                      move(Math.round((s.position + (e.key === "ArrowLeft" ? -k : k)) * 100) / 100);
                    } else if (e.key === "Delete" || e.key === "Backspace") {
                      e.preventDefault();
                      e.stopPropagation();
                      if (p.stops.length <= 2) return;
                      props.onChange({ ...p, stops: p.stops.filter((_, j) => j !== i) });
                      setStop(0);
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      setStop(i);
                    }
                  }}
                />
              );
            })}
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
            <button
              className="ibtn"
              title="Add stop"
              onClick={() => {
                const added = addStop(p.stops);
                props.onChange({ ...p, stops: added.stops });
                setStop(added.index);
              }}
            >
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
                // Another file is not the photo whose credit this paint carried.
                if (f) props.onChange({ ...p, src: "asset:" + addAsset(await readFileAsDataUrl(f)), credit: undefined });
              }}
            >
              Choose image…
            </button>
            <button className="btn" aria-expanded={finding} onClick={() => setFinding(!finding)}>
              Find a photo…
            </button>
          </div>
          <div className="row scale-mode-row">
            <SelectField
              ariaLabel="Image scale mode"
              value={p.scaleMode}
              onChange={(scaleMode) => {
                if (scaleMode !== "crop" || p.crop) return props.onChange({ ...p, scaleMode });
                // The first time: the whole image starts where the mode it came from shows it, set in
                // the same change as the mode (one undo step, no jump).
                const id = useStore.getState().paintEdit?.id;
                const box = id ? getDoc().nodes[id] : undefined;
                const url = !safeImageSrc(p.src) ? undefined : p.src.startsWith("asset:") ? assetUrl(p.src.slice(6)) : p.src;
                const whole = { x: 0, y: 0, w: 1, h: 1 };
                if (!box || !url) return props.onChange({ ...p, scaleMode, crop: whole });
                const img = new Image();
                const turned = ((p.rotation ?? 0) / 90) % 2 !== 0;
                img.onload = () =>
                  props.onChange({
                    ...p,
                    scaleMode,
                    crop: cropRectFor(p.scaleMode, turned ? img.naturalHeight : img.naturalWidth, turned ? img.naturalWidth : img.naturalHeight, box.width, box.height),
                  });
                img.onerror = () => props.onChange({ ...p, scaleMode, crop: whole });
                img.src = url;
              }}
              options={[
                { value: "fill", label: "Fill" },
                { value: "fit", label: "Fit" },
                { value: "stretch", label: "Stretch" },
                { value: "tile", label: "Tile" },
                { value: "crop", label: "Crop" },
              ]}
            />
          </div>
          {p.scaleMode === "tile" && (
            <div className="row effect-fields">
              <NumberField
                label="Scale"
                ariaLabel="Tile scale"
                value={Math.round((p.scalingFactor ?? 1) * 10000) / 100}
                suffix="%"
                min={1}
                max={10000}
                onChange={(v) => props.onChange({ ...p, scalingFactor: v === 100 ? undefined : v / 100 })}
              />
            </div>
          )}
          <div className="row image-turn-row">
            <button
              className="btn"
              title="Rotate the image 90° clockwise"
              onClick={() => {
                const turned = (((p.rotation ?? 0) + 90) % 360) || undefined;
                setTurnSaid(`Rotated to ${turned ?? 0}°`);
                props.onChange({ ...p, rotation: turned });
              }}
            >
              <RotateCw size={13} /> Rotate 90°
            </button>
            {(p.rotation ?? 0) !== 0 && <span className="muted small image-turn-value">{p.rotation}°</span>}
            <span className="sr-only" role="status" aria-live="polite">
              {turnSaid}
            </span>
          </div>
          <ImageAdjust filters={p.filters} onChange={(filters) => props.onChange({ ...p, filters })} />
          {finding && (
            <div className="photo-pick">
              <PhotoSearch
                mode={{
                  kind: "pick",
                  onPick: async (r) => {
                    const { paint } = await photoPaint(r, p.scaleMode === "crop" ? "fill" : p.scaleMode);
                    // A new photo starts uncropped; the opacity of this paint stays.
                    props.onChange({ ...p, src: paint.src, credit: paint.credit, scaleMode: paint.scaleMode, crop: undefined });
                    setFinding(false);
                  },
                }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const ADJUSTMENTS: [keyof ImageFilters, string][] = [
  ["exposure", "Exposure"],
  ["contrast", "Contrast"],
  ["saturation", "Saturation"],
  ["temperature", "Temperature"],
  ["tint", "Tint"],
  ["highlights", "Highlights"],
  ["shadows", "Shadows"],
];

/** The seven adjustments of an image fill, -100 to 100 (stored -1 to 1). Edits join the popover's
 *  gesture, so closing it leaves one undo step. */
function ImageAdjust(props: { filters: ImageFilters | undefined; onChange: (f: ImageFilters | undefined) => void }) {
  const f = props.filters ?? {};
  const any = ADJUSTMENTS.some(([k]) => (f[k] ?? 0) !== 0);
  const set = (k: keyof ImageFilters, pct: number) => {
    const next = { ...f, [k]: pct / 100 };
    if (pct === 0) delete next[k];
    props.onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="image-adjust" role="group" aria-label="Adjust">
      <div className="image-adjust-head">
        <span>Adjust</span>
        <button className="btn" disabled={!any} onClick={() => props.onChange(undefined)}>
          Reset
        </button>
      </div>
      {ADJUSTMENTS.map(([k, label]) => {
        const pct = Math.round((f[k] ?? 0) * 100);
        return (
          <label key={k} className="image-adjust-row">
            <span>{label}</span>
            <input
              type="range"
              min={-100}
              max={100}
              step={1}
              value={pct}
              aria-label={label}
              aria-valuetext={String(pct)}
              data-adjust={k}
              onChange={(e) => set(k, Number(e.target.value))}
              onDoubleClick={() => set(k, 0)}
            />
            <output aria-hidden="true">{pct}</output>
          </label>
        );
      })}
    </div>
  );
}

/** Button that opens a paint editor popover. Its name comes from the paint unless `label` says more. */
export function PaintSwatch(props: { paint: Paint; onChange: (p: Paint) => void; onOpen?: () => void; onClose?: () => void; label?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // Enter or Escape on the canvas (see PaintHandles) clears `paintEdit`: that closes the popover too.
  const editing = useStore((s) => s.paintEdit !== null);
  const sawEdit = useRef(false);
  useEffect(() => {
    if (!anchor) sawEdit.current = false;
    else if (editing) sawEdit.current = true;
    else if (sawEdit.current) {
      sawEdit.current = false;
      setAnchor(null);
      props.onClose?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, anchor]);
  // A popover that is open when the role turns viewer (or the tab read-only) closes: its sliders aren't inside the disabled panel.
  const viewOnly = useStore((s) => !!s.es.readOnly) || useCollab((s) => s.viewer);
  useEffect(() => {
    if (viewOnly && anchor) {
      setAnchor(null);
      props.onClose?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewOnly]);
  // While text is being edited the keyboard stays in the text, so Escape would end the editing and leave
  // the popover open. It closes the popover first (a field inside the popover keeps its own Escape).
  useEffect(() => {
    if (!anchor || !useStore.getState().editingText) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as Element | null)?.closest?.(".popover")) return;
      e.preventDefault();
      e.stopPropagation();
      setAnchor(null);
      props.onClose?.();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!anchor]);
  const name = paintAriaLabel(props.paint);
  return (
    <>
      <button
        type="button"
        className="swatch"
        aria-label={props.label ? `${props.label}: ${name}` : name}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        // While text is being edited the click must not take focus off the text: a swatch holding it would
        // hand the next Backspace to the canvas, which deletes the layer.
        onMouseDown={(e) => useStore.getState().editingText && e.preventDefault()}
        onClick={(e) => {
          setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
          props.onOpen?.();
          if (useStore.getState().editingText) requestAnimationFrame(() => window.dispatchEvent(new Event("dt-refocus-text")));
        }}
      >
        <i style={{ background: paintCss(props.paint) }} />
      </button>
      {anchor && (
        <Popover
          width={300}
          anchor={anchor}
          label={props.label ?? "Edit " + (props.paint.type === "solid" ? "colour" : props.paint.type === "image" ? "image" : "gradient")}
          // Text being edited keeps the keyboard: the swatch for the selected characters must not take it.
          focusOnOpen={!useStore.getState().editingText}
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

// ---------- Inspect formats ----------

export type ColorFormat = "hex" | "rgb" | "hsl" | "css";

function rgbToHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** A colour as text for the Code tab: `#7C5CFF`, `rgb(124, 92, 255)`, `hsl(250, 100%, 68%)` or CSS (lower-case hex, rgba when see-through). */
export function formatColor(hex: string, opacity: number, format: ColorFormat): string {
  const c = parseColor(hex);
  const a = Math.round(c.a * opacity * 100) / 100;
  const [r, g, b] = [c.r, c.g, c.b].map((v) => Math.round(v));
  if (format === "rgb") return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
  if (format === "hsl") {
    const { h, s, l } = rgbToHsl(c);
    const body = `${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`;
    return a >= 1 ? `hsl(${body})` : `hsla(${body}, ${a})`;
  }
  if (format === "css") return a >= 1 ? toHex(c).toLowerCase() : `rgba(${r}, ${g}, ${b}, ${a})`;
  return toHex8({ ...c, a: c.a * opacity });
}
