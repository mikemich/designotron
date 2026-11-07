/** Which keys belong to the focused element and which to the editor's shortcuts. */

const TEXT_INPUTS = new Set(["", "text", "search", "number", "email", "url", "tel", "password", "date", "time", "datetime-local", "month", "week"]);

/** The parts of an element this module reads (so it runs on plain objects in tests). */
export interface KeyTarget {
  tagName: string;
  isContentEditable?: boolean;
  getAttribute(name: string): string | null;
}

const asTarget = (t: unknown): KeyTarget | null => (t && typeof (t as KeyTarget).tagName === "string" && typeof (t as KeyTarget).getAttribute === "function" ? (t as KeyTarget) : null);

/** Text entry: a textarea, a contentEditable, or an input that takes typed characters. */
export function isTextEntry(target: unknown): boolean {
  const t = asTarget(target);
  if (!t) return false;
  const tag = t.tagName.toLowerCase();
  if (tag === "textarea" || t.isContentEditable) return true;
  return tag === "input" && TEXT_INPUTS.has((t.getAttribute("type") ?? "").toLowerCase());
}

const OWN_KEYS = new Set([" ", "Spacebar", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** Whether the focused element keeps this key press (the editor's shortcuts stay out).
 * Text entry keeps everything. Other form controls (checkbox, radio, range, colour, select) let
 * Ctrl/Cmd shortcuts through; plain keys reach the editor too when the control was clicked, except
 * Space, Enter and the arrows. A control reached with Tab keeps all its keys (type-ahead, sliders). */
export function controlOwnsKey(e: { target: unknown; key: string; ctrlKey: boolean; metaKey: boolean }, byPointer: (el: unknown) => boolean): boolean {
  const t = asTarget(e.target);
  if (!t) return false;
  if (isTextEntry(t)) return true;
  const tag = t.tagName.toLowerCase();
  if (tag !== "input" && tag !== "select") return false;
  if (e.ctrlKey || e.metaKey) return false;
  if (OWN_KEYS.has(e.key)) return true;
  return !byPointer(t);
}
