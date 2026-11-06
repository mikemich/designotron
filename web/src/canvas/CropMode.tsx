// Image crop on the canvas (W3-D): while an image paint in Crop mode has its popover open, the whole
// image shows ghosted beyond the layer. Drag inside it to move, drag a corner to scale (aspect kept).

import { useEffect } from "react";
import { assetUrl } from "../assets";
import { safeImageSrc } from "../imageSrc";
import type { Viewport } from "../store";
import type { ImageCrop, Paint } from "../types";
import { cropRectFor } from "../ui/color";
import { apply, toScreen } from "./geometry";
import { dragGesture, sendPaint, unitAt, usePaintTarget, type PaintTarget } from "./PaintHandles";

type ImagePaint = Extract<Paint, { type: "image" }>;

/** Corners of the image rectangle, in the order top-left, top-right, bottom-right, bottom-left. */
const CORNERS: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export function CropMode({ v }: { v: Viewport }) {
  const t = usePaintTarget();
  if (!t || t.paint.type !== "image" || t.paint.scaleMode !== "crop") return null;
  return <Crop v={v} t={t} paint={t.paint} />;
}

function Crop({ v, t, paint }: { v: Viewport; t: PaintTarget; paint: ImagePaint }) {
  const { width: w, height: h, matrix: m } = t;
  const src = !safeImageSrc(paint.src) ? "" : paint.src.startsWith("asset:") ? assetUrl(paint.src.slice(6)) ?? "" : paint.src;

  // A Crop paint without a rectangle (AI, import) starts from what Fill shows.
  useEffect(() => {
    if (paint.crop || !src) return;
    const img = new Image();
    img.onload = () => sendPaint(t.edit, { ...paint, crop: cropRectFor("fill", img.naturalWidth, img.naturalHeight, w, h) });
    img.onerror = () => sendPaint(t.edit, { ...paint, crop: { x: 0, y: 0, w: 1, h: 1 } });
    img.src = src;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paint.crop, src]);

  const crop: ImageCrop | undefined = paint.crop;
  if (!crop || !src) return null;
  const rect = { x: crop.x * w, y: crop.y * h, w: crop.w * w, h: crop.h * h };
  const corner = ([cx, cy]: [number, number]) => toScreen(v, apply(m, { x: rect.x + cx * rect.w, y: rect.y + cy * rect.h }));
  const toScreenMatrix = `matrix(${m.a * v.zoom} ${m.b * v.zoom} ${m.c * v.zoom} ${m.d * v.zoom} ${m.e * v.zoom + v.x} ${m.f * v.zoom + v.y})`;
  const clipId = "crop-outside-" + t.edit.id.replace(/[^\w-]/g, "");
  const big = 1e5;

  /** Starts moving (`corner` null) or scaling from that corner of the image rectangle. */
  function grab(ev: React.PointerEvent, from: number | null) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const u0 = unitAt(ev.nativeEvent, m, w, h);
    const c0 = crop!;
    dragGesture((pe) => {
      const u = unitAt(pe, m, w, h);
      if (from === null) {
        sendPaint(t.edit, { ...paint, crop: { ...c0, x: c0.x + (u[0] - u0[0]), y: c0.y + (u[1] - u0[1]) } });
        return;
      }
      // Scale about the opposite corner, keeping the rectangle's aspect.
      const [fx, fy] = CORNERS[from];
      const [ax, ay] = [(c0.x + (1 - fx) * c0.w) * w, (c0.y + (1 - fy) * c0.h) * h];
      const [cx, cy] = [(c0.x + fx * c0.w) * w, (c0.y + fy * c0.h) * h];
      const sx = (u[0] * w - ax) / (cx - ax || 1);
      const sy = (u[1] * h - ay) / (cy - ay || 1);
      const k = Math.max(0.05, Math.max(sx, sy));
      sendPaint(t.edit, {
        ...paint,
        crop: { x: (ax + (c0.x * w - ax) * k) / w, y: (ay + (c0.y * h - ay) * k) / h, w: c0.w * k, h: c0.h * k },
      });
    });
  }

  return (
    <svg className="paint-overlay" aria-hidden="true">
      <g data-paint-overlay="" data-keep-popover="" className="paint-handles crop-mode">
        <g transform={toScreenMatrix}>
          <clipPath id={clipId}>
            <path clipRule="evenodd" d={`M${-big} ${-big}H${big}V${big}H${-big}ZM0 0H${w}V${h}H0Z`} />
          </clipPath>
          <image data-crop-ghost="" href={src} x={rect.x} y={rect.y} width={rect.w} height={rect.h} preserveAspectRatio="none" opacity={0.4} clipPath={`url(#${clipId})`} pointerEvents="none" />
          <rect x={0} y={0} width={w} height={h} className="paint-line" vectorEffect="non-scaling-stroke" pointerEvents="none" />
          <rect data-crop-body="" className="paint-handle crop-body" x={rect.x} y={rect.y} width={rect.w} height={rect.h} onPointerDown={(ev) => grab(ev, null)} />
        </g>
        {CORNERS.map((c, i) => {
          const p = corner(c);
          return <rect key={i} data-crop-corner={i} className="paint-handle crop-corner" x={p.x - 4.5} y={p.y - 4.5} width={9} height={9} onPointerDown={(ev) => grab(ev, i)} />;
        })}
      </g>
    </svg>
  );
}
