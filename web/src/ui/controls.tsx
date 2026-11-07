import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dispatch, useStore } from "../store";

import { MIXED, type Maybe } from "./mixed";

export { MIXED, type Maybe };

/** Largest magnitude a number field accepts unless it sets its own range. */
const MAX_NUMBER = 1e6;

/** Number input with a scrubbable label, arrow-key stepping and simple math. `null` shows
 *  `autoText` (e.g. an automatic line height); scrubbing and arrows then start at `autoValue`. */
export function NumberField(props: {
  label?: ReactNode;
  value: Maybe<number> | null;
  autoText?: string;
  autoValue?: number;
  onChange: (v: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  title?: string;
  /** Accessible name; defaults to the title, or the label when that is text. */
  ariaLabel?: string;
  precision?: number;
  /** Reads typed text instead of the built-in number/math rule: a number to apply, `null` for auto, `undefined` when it can't be read (the field reverts). */
  parse?: (raw: string) => number | null | undefined;
  /** Called for `null` from `parse` and for an empty field. */
  onAuto?: () => void;
}) {
  const { label, value, onChange, step = 1, min = -MAX_NUMBER, max = MAX_NUMBER, suffix, title, precision = 2 } = props;
  const fmt = (v: Maybe<number> | null) =>
    v === MIXED ? "Mixed" : v === null ? (props.autoText ?? "Auto") : String(Math.round(v * 10 ** precision) / 10 ** precision) + (suffix ?? "");
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  /** The text was edited since the last commit: only then does leaving the field commit it. */
  const edited = useRef(false);
  /** What the field last showed for the document's value. */
  const shown = useRef(text);
  /** Something typed that differs from what the document said: it is kept, not overwritten. */
  const pending = () => edited.current && text !== shown.current;
  useEffect(() => {
    // A focused field keeps what is being typed, but follows the document after a commit or an undo.
    if (!focused || !pending()) setText(fmt(value));
    shown.current = fmt(value);
  }, [value, focused]);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  /** Applies the typed text; returns the value it was clamped to, or null when there was none. */
  const commit = (): number | null => {
    const wasEdited = edited.current;
    edited.current = false;
    const raw = text.replace(suffix ?? "", "").trim();
    if (raw === "Mixed" || raw === (props.autoText ?? "Auto")) return null;
    // Enter on a field nobody typed in: the shown value is the document's, not new text to read again
    // (a stored 3 px line height would otherwise be read as 3 x size).
    if (props.parse && !wasEdited) return null;
    if (props.parse || props.onAuto) {
      const parsed = !raw ? null : props.parse?.(raw);
      if (parsed === null && props.onAuto) {
        props.onAuto();
        setText(fmt(null));
        shown.current = fmt(null);
        return null;
      }
      if (props.parse) {
        if (parsed === undefined || parsed === null) {
          setText(fmt(value));
          return null;
        }
        const out = clamp(parsed);
        onChange(out);
        return out;
      }
    }
    if (!raw) return null;
    let v: number;
    try {
      // Allow simple expressions like "100/2" or "24+8".
      v = /^[\d\s+\-*/().]+$/.test(raw) ? Function(`"use strict";return (${raw})`)() : parseFloat(raw);
    } catch {
      v = parseFloat(raw);
    }
    if (!Number.isFinite(v)) return null;
    const out = clamp(v);
    onChange(out);
    return out;
  };
  const scrub = (e: React.PointerEvent) => {
    const start = value === null ? props.autoValue : value;
    if (start === MIXED || start === undefined) return;
    e.preventDefault();
    const startX = e.clientX;
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
        aria-label={props.ariaLabel ?? title ?? (typeof label === "string" ? label : undefined)}
        onFocus={(e) => {
          edited.current = false;
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          if (edited.current) commit();
        }}
        onChange={(e) => {
          edited.current = true;
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // preventDefault: committing can move focus (e.g. back into text being edited),
            // and the Enter must not land there as a newline. In the side panels Enter commits and
            // gives the keys back to the canvas (Figma); Tab moves on to the next field. Dialogs
            // keep focus in the field, text selected.
            e.preventDefault();
            const input = e.target as HTMLInputElement;
            const out = commit();
            if (out !== null) {
              setText(fmt(out));
              shown.current = fmt(out);
            }
            if (document.activeElement === input) {
              if (leavesFieldOnEnter(input)) {
                edited.current = false;
                input.blur();
                focusCanvas();
              } else requestAnimationFrame(() => document.activeElement === input && input.select());
            }
          } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y") && !pending()) {
            // Nothing typed since the last commit: undo and redo belong to the design, not the text box.
            e.preventDefault();
            dispatch({ op: e.key.toLowerCase() === "y" || e.shiftKey ? "redo" : "undo" });
          } else if (e.key === "Escape") {
            setText(fmt(value));
            edited.current = false;
            const input = e.target as HTMLInputElement;
            input.blur();
            focusCanvas();
          } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value !== MIXED && (value ?? props.autoValue) !== undefined) {
            e.preventDefault();
            const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            onChange(clamp((value ?? props.autoValue!) + d));
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
  /** `group` puts an option under an `<optgroup>`; groups appear in the order they first occur and ungrouped options stay on top. */
  options: { value: T; label: string; group?: string }[];
  onChange: (v: T) => void;
  title?: string;
  /** Accessible name; defaults to the title, or the label when that is text. */
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const loose = props.options.filter((o) => !o.group);
  const groups = [...new Set(props.options.filter((o) => o.group).map((o) => o.group!))];
  return (
    <label className="field" title={props.title}>
      {props.label !== undefined && (
        <span className={typeof props.label === "string" && props.label.length > 2 ? "lbl wide" : "lbl"}>{props.label}</span>
      )}
      <select
        disabled={props.disabled}
        aria-label={props.ariaLabel ?? props.title ?? (typeof props.label === "string" ? props.label : undefined)}
        value={props.value === MIXED ? "__mixed" : String(props.value)}
        onChange={(e) => {
          const opt = props.options.find((o) => String(o.value) === e.target.value);
          if (opt) props.onChange(opt.value);
        }}
      >
        {props.value === MIXED && <option value="__mixed">Mixed</option>}
        {loose.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {props.options
              .filter((o) => o.group === g)
              .map((o) => (
                <option key={String(o.value)} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

export function Seg<T extends string>(props: { value: Maybe<T>; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <div className="seg" role="group" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button key={o.value} className={props.value === o.value ? "on" : ""} title={o.title} aria-label={o.title && typeof o.label !== "string" ? o.title : undefined} aria-pressed={props.value === o.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function IconButton(props: { title: string; onClick?: (e: React.MouseEvent) => void; children: ReactNode; on?: boolean; disabled?: boolean }) {
  return (
    <button className={"ibtn" + (props.on ? " on" : "")} title={props.title} aria-label={props.title} aria-pressed={props.on} onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  );
}

export function Section(props: { title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="section">
      <div className="section-head">
        <span role="heading" aria-level={3}>
          {props.title}
        </span>
        {props.actions && <div className="actions">{props.actions}</div>}
      </div>
      {props.children}
    </div>
  );
}

/**
 * The toast: two live regions that are always mounted (a region inserted together with its text is
 * often not announced), polite for information and assertive for errors, plus the visible toast,
 * which is `aria-hidden` so the text isn't read twice.
 */
export function ToastLive() {
  const toast = useStore((s) => s.toast);
  const [said, setSaid] = useState<{ info: string; error: string }>({ info: "", error: "" });
  useEffect(() => {
    if (!toast) {
      setSaid({ info: "", error: "" });
      return;
    }
    // Clear first so the same text twice in a row is announced again.
    setSaid({ info: "", error: "" });
    const id = requestAnimationFrame(() => setSaid({ info: toast.kind === "info" ? toast.text : "", error: toast.kind === "error" ? toast.text : "" }));
    return () => cancelAnimationFrame(id);
  }, [toast]);
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-toast-live="info">
        {said.info}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-toast-live="error">
        {said.error}
      </div>
      {toast && (
        <div className={"toast " + toast.kind} aria-hidden="true">
          {toast.text}
        </div>
      )}
    </>
  );
}

/** Floating panel anchored near a DOM rect; closes on outside click / Escape. */
export function Popover(props: { anchor: DOMRect; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.anchor.left, top: props.anchor.bottom + 6 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = props.anchor.left - w - 12;
      if (left < 8) left = Math.min(window.innerWidth - w - 8, props.anchor.right + 8);
      let top = Math.min(props.anchor.top, window.innerHeight - h - 8);
      setPos((p) => (p.left === left && p.top === Math.max(8, top) ? p : { left, top: Math.max(8, top) }));
    };
    place();
    // Content that grows later (a photo search inside the popover) keeps it on screen.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [props.anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      // Canvas overlays that edit what the popover edits (gradient handles, crop) keep it open.
      if ((e.target as Element).closest?.("[data-keep-popover]")) return;
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

/** Whether the last thing the person did was press a key (not click or touch): a menu they
 *  opened by keyboard focuses its first item, one opened by pointer waits for an arrow key. */
let keyboardModality = false;
/** The element that last took focus from a pointer (a click on a button, say), if it still has it. */
let pointerFocused: EventTarget | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => (keyboardModality = !["Shift", "Control", "Alt", "Meta"].includes(e.key) || keyboardModality), true);
  window.addEventListener("pointerdown", () => (keyboardModality = false), true);
  window.addEventListener("focusin", (e) => (pointerFocused = keyboardModality ? null : e.target), true);
}

/** Whether `el` has focus because it was clicked or tapped (not reached with Tab). Keys then
 *  belong to the design, not to that button: Enter on a clicked button selects children. */
export function focusedByPointer(el: EventTarget | null): boolean {
  return !!el && el === pointerFocused;
}

/** Menu following the ARIA menu pattern: focus moves to the first item on open, arrows, Home/End
 *  and typing a letter move between items, Enter/Space run one, and Escape or Tab close it and
 *  give focus back to whatever opened it. */
export function Menu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  /** What had focus when the menu opened (the button, or the canvas for a context menu). */
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const typed = useRef({ text: "", at: 0 });
  const enabled = () => [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? [])];
  const restoreFocus = () => {
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
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
    (keyboardModality ? enabled()[0] : ref.current)?.focus({ preventScroll: true });
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) props.onClose();
    };
    // Escape when focus is elsewhere (the menu's own keys are handled in onKeyDown).
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      restoreFocus();
      props.onClose();
    };
    const t = setTimeout(() => window.addEventListener("pointerdown", down), 0);
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    // The editor's shortcuts (Enter selects children, arrows nudge...) must not see these keys.
    e.stopPropagation();
    const items = enabled();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      const el = items[(i + items.length) % items.length];
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      restoreFocus();
      props.onClose();
    } else if (e.key === "Tab") {
      // Focus goes back to the opener first, so Tab carries on from there.
      restoreFocus();
      props.onClose();
    } else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead: the letters typed within the last second pick the first matching item.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 1000 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const from = typed.current.text.length > 1 ? at : at + 1;
      for (let i = 0; i < items.length; i++) {
        const el = items[(from + i + items.length) % items.length];
        if (el.textContent?.trim().toLowerCase().startsWith(typed.current.text)) {
          e.preventDefault();
          el.focus({ preventScroll: true });
          break;
        }
      }
    }
  };
  return createPortal(
    // Portalled, but React events still bubble to the component that opened it (e.g. the
    // canvas, which would re-pick the layer under the pointer before the item runs).
    <div
      ref={ref}
      className="menu"
      role="menu"
      tabIndex={-1}
      aria-label={props.label}
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
      // The item under the pointer is the focused one, so hover and keyboard never show two.
      onPointerMove={(e) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>("[role=menuitem]:not(:disabled)");
        if (item && item !== document.activeElement) item.focus({ preventScroll: true });
      }}
      onKeyDown={onKeyDown}
    >
      {props.items.map((it, i) =>
        it.sep ? (
          <div key={i} className="sep" role="separator" />
        ) : it.heading ? (
          <div key={i} className="label" role="presentation">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            className="item"
            role="menuitem"
            tabIndex={-1}
            disabled={it.disabled}
            style={it.disabled ? { opacity: 0.4 } : undefined}
            onClick={() => {
              // Focus returns before the item runs, so a dialog it opens remembers the opener
              // and an item that moves focus (a text box, the canvas) wins.
              restoreFocus();
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

/** Enter in a panel field hands the keys back to the canvas; fields inside a dialog keep them. */
export function leavesFieldOnEnter(input: Element) {
  return !input.closest('[role="dialog"], .modal, .modal-bg');
}

/** Puts keyboard focus on the canvas (after a field or panel gives it up). */
export function focusCanvas() {
  const el = document.getElementById("dt-canvas");
  if (el && !document.querySelector(".modal-bg")) el.focus({ preventScroll: true });
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl+";
export const ALT = isMac ? "⌥" : "Alt+";
export const SHIFT = isMac ? "⇧" : "Shift+";
/** Command chords as the platform writes them: ⌥⌘K on a Mac, Ctrl+Alt+K elsewhere. */
export const ALT_MOD = isMac ? "⌥⌘" : "Ctrl+Alt+";
export const SHIFT_MOD = isMac ? "⇧⌘" : "Ctrl+Shift+";
/** Bring to front / send to back: ⌥⌘] on a Mac, Ctrl+Shift+] elsewhere (where Ctrl+Alt is AltGr). */
export const FRONT_MOD = isMac ? "⌥⌘" : "Ctrl+Shift+";

/** Closes a dialog on Escape, unless a menu inside it is open (the menu closes first).
 *  Listens only while `enabled`, so a closed dialog never swallows the editor's Escape. */
export function useEscape(close: () => void, enabled = true) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!enabled) return;
    // Capture phase: dialogs stop key events from reaching the editor's shortcuts.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".menu, .popover")) return;
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
        (el) => !el.hasAttribute("disabled") && el.getAttribute("tabindex") !== "-1" && el.offsetParent !== null,
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
