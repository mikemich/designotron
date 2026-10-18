import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const MIXED = Symbol("mixed");
export type Maybe<T> = T | typeof MIXED;

/** Number input with a scrubbable label, arrow-key stepping and simple math. */
export function NumberField(props: {
  label?: ReactNode;
  value: Maybe<number>;
  onChange: (v: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  title?: string;
  precision?: number;
}) {
  const { label, value, onChange, step = 1, min, max, suffix, title, precision = 2 } = props;
  const fmt = (v: Maybe<number>) => (v === MIXED ? "Mixed" : String(Math.round(v * 10 ** precision) / 10 ** precision) + (suffix ?? ""));
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  /** Enter already committed, or Escape cancelled: the blur that follows must not commit. */
  const settled = useRef(false);
  useEffect(() => {
    if (!focused) setText(fmt(value));
  }, [value, focused]);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = () => {
    const raw = text.replace(suffix ?? "", "").trim();
    if (!raw || raw === "Mixed") return;
    let v: number;
    try {
      // Allow simple expressions like "100/2" or "24+8".
      v = /^[\d\s+\-*/().]+$/.test(raw) ? Function(`"use strict";return (${raw})`)() : parseFloat(raw);
    } catch {
      v = parseFloat(raw);
    }
    if (Number.isFinite(v)) onChange(clamp(v));
  };
  const scrub = (e: React.PointerEvent) => {
    if (value === MIXED) return;
    e.preventDefault();
    const startX = e.clientX;
    const start = value;
    props.onScrubStart?.();
    const move = (ev: PointerEvent) => {
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      onChange(clamp(Math.round((start + (ev.clientX - startX) * step * mult) * 100) / 100));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      props.onScrubEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <label className="field" title={title}>
      {label !== undefined && (
        <span className="lbl" onPointerDown={scrub}>
          {label}
        </span>
      )}
      <input
        value={text}
        onFocus={(e) => {
          settled.current = false;
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          if (!settled.current) commit();
          settled.current = false;
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // preventDefault: committing can move focus (e.g. back into text being edited),
            // and the Enter must not land there as a newline.
            e.preventDefault();
            commit();
            settled.current = true;
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setText(fmt(value));
            settled.current = true;
            (e.target as HTMLInputElement).blur();
          } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value !== MIXED) {
            e.preventDefault();
            const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            onChange(clamp(value + d));
          }
          e.stopPropagation();
        }}
      />
    </label>
  );
}

export function SelectField<T extends string | number>(props: {
  label?: ReactNode;
  value: Maybe<T>;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  title?: string;
}) {
  return (
    <label className="field" title={props.title}>
      {props.label !== undefined && <span className="lbl">{props.label}</span>}
      <select
        value={props.value === MIXED ? "__mixed" : String(props.value)}
        onChange={(e) => {
          const opt = props.options.find((o) => String(o.value) === e.target.value);
          if (opt) props.onChange(opt.value);
        }}
      >
        {props.value === MIXED && <option value="__mixed">Mixed</option>}
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Seg<T extends string>(props: { value: Maybe<T>; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <button key={o.value} className={props.value === o.value ? "on" : ""} title={o.title} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function IconButton(props: { title: string; onClick?: (e: React.MouseEvent) => void; children: ReactNode; on?: boolean; disabled?: boolean }) {
  return (
    <button className={"ibtn" + (props.on ? " on" : "")} title={props.title} onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  );
}

export function Section(props: { title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="section">
      <div className="section-head">
        <span>{props.title}</span>
        {props.actions && <div className="actions">{props.actions}</div>}
      </div>
      {props.children}
    </div>
  );
}

/** Floating panel anchored near a DOM rect; closes on outside click / Escape. */
export function Popover(props: { anchor: DOMRect; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.anchor.left, top: props.anchor.bottom + 6 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = props.anchor.left - w - 12;
    if (left < 8) left = Math.min(window.innerWidth - w - 8, props.anchor.right + 8);
    let top = Math.min(props.anchor.top, window.innerHeight - h - 8);
    setPos({ left, top: Math.max(8, top) });
  }, [props.anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    setTimeout(() => window.addEventListener("pointerdown", down), 0);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return createPortal(
    <div ref={ref} className="popover" style={{ ...pos, width: props.width ?? 240 }} onKeyDown={(e) => e.stopPropagation()}>
      {props.children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label?: string;
  kbd?: string;
  onClick?: () => void;
  sep?: boolean;
  heading?: string;
  disabled?: boolean;
}

export function Menu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({
      left: Math.max(8, Math.min(props.x, window.innerWidth - el.offsetWidth - 8)),
      // Taller than the window: pin to the top and let it scroll (max-height in CSS).
      top: Math.max(8, Math.min(props.y, window.innerHeight - el.offsetHeight - 8)),
    });
  }, [props.x, props.y]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) props.onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    setTimeout(() => window.addEventListener("pointerdown", down), 0);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return createPortal(
    // Portalled, but React events still bubble to the component that opened it (e.g. the
    // canvas, which would re-pick the layer under the pointer before the item runs).
    <div ref={ref} className="menu" style={pos} onContextMenu={(e) => e.preventDefault()} onPointerDown={(e) => e.stopPropagation()}>
      {props.items.map((it, i) =>
        it.sep ? (
          <div key={i} className="sep" />
        ) : it.heading ? (
          <div key={i} className="label">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            className="item"
            disabled={it.disabled}
            style={it.disabled ? { opacity: 0.4 } : undefined}
            onClick={() => {
              props.onClose();
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Shared value across a selection, or MIXED. */
export function common<T, V>(items: T[], get: (t: T) => V): Maybe<V> {
  if (!items.length) return MIXED as Maybe<V>;
  const first = get(items[0]);
  const same = items.every((i) => JSON.stringify(get(i)) === JSON.stringify(first));
  return same ? first : (MIXED as Maybe<V>);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl+";
export const ALT = isMac ? "⌥" : "Alt+";
export const SHIFT = isMac ? "⇧" : "Shift+";

/** Closes a dialog on Escape, unless a menu inside it is open (the menu closes first).
 *  Listens only while `enabled`, so a closed dialog never swallows the editor's Escape. */
export function useEscape(close: () => void, enabled = true) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!enabled) return;
    // Capture phase: dialogs stop key events from reaching the editor's shortcuts.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".menu")) return;
      e.stopPropagation();
      ref.current();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [enabled]);
}

/** Dialog behaviour: Escape closes, focus moves into the dialog and stays there (Tab wraps),
 *  and returns to where it was on close. Attach the returned ref to the dialog element. */
export function useDialog(close: () => void, active = true) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(close, active);
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const focusable = () =>
      [...(ref.current?.querySelectorAll<HTMLElement>("input, textarea, select, button, a[href], [tabindex]:not([tabindex='-1'])") ?? [])].filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
      );
    const t = setTimeout(() => {
      const els = focusable();
      // The first field if there is one (the close button comes first otherwise).
      (els.find((el) => el.matches("input, textarea, select")) ?? els[0])?.focus();
    }, 0);
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !ref.current) return;
      const els = focusable();
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (!ref.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", trap, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", trap, true);
      before?.focus?.();
    };
  }, [active]);
  return ref;
}
