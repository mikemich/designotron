// Component, variant and style operations built from existing engine commands.
// Multi-command edits run inside one gesture so each is a single undo step.

import { dispatch, dispatchOrThrow, getDoc, getEngine, toast } from "./store";
import type { Doc, Node } from "./types";
import { MOD } from "./ui/controls";

type Props = Record<string, string>;
type TextStyle = Doc["styles"]["texts"][number];

/** Space between variants inside a component set (matches the engine's combine padding). */
const SET_PAD = 20;

/** Runs several commands as one undo step; on failure everything is rolled back. */
export function batch(fn: () => void): boolean {
  // Already inside a gesture (e.g. a scrub): just join it.
  if (JSON.parse(getEngine().state()).inGesture) {
    try {
      fn();
      return true;
    } catch (err) {
      toast(String(err), "error");
      return false;
    }
  }
  dispatch({ op: "beginGesture" });
  try {
    fn();
    dispatch({ op: "endGesture" });
    return true;
  } catch (err) {
    dispatch({ op: "cancelGesture" });
    toast(String(err), "error");
    return false;
  }
}

// ---------- Variants ----------

/** The component set a component belongs to, if any. */
export function variantSet(doc: Doc, comp: Node): Node | null {
  const p = comp.parent ? doc.nodes[comp.parent] : null;
  return p?.type === "componentSet" ? p : null;
}

export function variantsOf(doc: Doc, set: Node): Node[] {
  return set.children.map((id) => doc.nodes[id]).filter((n): n is Node => !!n && n.type === "component");
}

/** Variant properties of a set with their values, in first-seen order. */
export function setProperties(doc: Doc, set: Node): { name: string; values: string[] }[] {
  const out = new Map<string, string[]>();
  for (const v of variantsOf(doc, set)) {
    for (const [k, val] of Object.entries(v.component?.variantProps ?? {})) {
      const vals = out.get(k) ?? [];
      if (!vals.includes(val)) vals.push(val);
      out.set(k, vals);
    }
  }
  return [...out].map(([name, values]) => ({ name, values }));
}

/** Why a property name or value can't be used, or null. Names encode as "Prop=Value, …". */
export function invalidVariantText(s: string): string | null {
  if (!s.trim()) return "Name can't be empty";
  if (/[=,]/.test(s)) return "Names can't contain “=” or “,”";
  return null;
}

/** Renames a variant property on every variant in the set. */
export function renameVariantProperty(set: Node, from: string, to: string): boolean {
  to = to.trim();
  if (to === from) return true;
  const doc = getDoc();
  const bad = invalidVariantText(to) ?? (setProperties(doc, set).some((p) => p.name === to) ? `“${to}” already exists` : null);
  if (bad) return toast(bad, "error"), false;
  return batch(() => {
    for (const v of variantsOf(doc, set)) {
      const props = v.component?.variantProps ?? {};
      if (!(from in props)) continue;
      const next: Props = {};
      for (const [k, val] of Object.entries(props)) next[k === from ? to : k] = val;
      writeVariantProps(v, next);
    }
  });
}

/** Why giving variants these props would make two of them identical (then neither can be
 *  picked reliably), or null. `next` maps variant id → its new props. */
function duplicateVariant(doc: Doc, set: Node, next: Map<string, Props>): string | null {
  const seen = new Set<string>();
  for (const v of variantsOf(doc, set)) {
    const props = next.get(v.id) ?? v.component?.variantProps ?? {};
    const key = variantName(props);
    if (seen.has(key)) return `A variant with ${key} already exists`;
    seen.add(key);
  }
  return null;
}

/** Renames a value of a property on every variant that uses it ("Variant 1" → "Hover"). */
export function renameVariantValue(set: Node, prop: string, from: string, to: string): boolean {
  to = to.trim();
  if (to === from) return true;
  const bad = invalidVariantText(to);
  if (bad) return toast(bad, "error"), false;
  const doc = getDoc();
  const next = new Map<string, Props>();
  for (const v of variantsOf(doc, set)) {
    const props = v.component?.variantProps ?? {};
    if (props[prop] === from) next.set(v.id, { ...props, [prop]: to });
  }
  const clash = duplicateVariant(doc, set, next);
  if (clash) return toast(clash, "error"), false;
  return batch(() => {
    for (const v of variantsOf(doc, set)) {
      const props = v.component?.variantProps ?? {};
      if (props[prop] === from) writeVariantProps(v, { ...props, [prop]: to });
    }
  });
}

/** Sets one property value on a single variant. */
export function setVariantValue(comp: Node, prop: string, value: string): boolean {
  value = value.trim();
  const props = comp.component?.variantProps ?? {};
  if (props[prop] === value) return true;
  const bad = invalidVariantText(value);
  if (bad) return toast(bad, "error"), false;
  const doc = getDoc();
  const set = variantSet(doc, comp);
  const clash = set && duplicateVariant(doc, set, new Map([[comp.id, { ...props, [prop]: value }]]));
  if (clash) return toast(clash, "error"), false;
  return batch(() => writeVariantProps(comp, { ...props, [prop]: value }));
}

/** Adds a property to every variant in the set, with a default value. */
export function addVariantProperty(set: Node): boolean {
  const doc = getDoc();
  const names = new Set(setProperties(doc, set).map((p) => p.name));
  let i = names.size + 1;
  while (names.has(`Property ${i}`)) i++;
  const name = `Property ${i}`;
  return batch(() => {
    for (const v of variantsOf(doc, set)) writeVariantProps(v, { ...(v.component?.variantProps ?? {}), [name]: "Default" });
  });
}

/**
 * Adds a variant. A standalone component is duplicated and both are combined into a new
 * component set; a variant (or a set) gets one more variant next to the others.
 */
export function addVariant(target: Node): boolean {
  const doc = getDoc();
  if (target.type === "componentSet") {
    const vs = variantsOf(doc, target);
    return vs.length ? addToSet(target, vs[vs.length - 1]) : false;
  }
  if (target.type !== "component") return false;
  const set = variantSet(doc, target);
  if (set) return addToSet(set, target);
  return batch(() => {
    const dup = dispatchOrThrow<{ created: string[] }>({ op: "duplicate", ids: [target.id] }).created[0];
    // Duplicates inside a frame keep their position: put the new variant beside the original
    // so the set is built around both.
    dispatchOrThrow({ op: "update", ids: [dup], patch: { x: target.x + target.width + SET_PAD, y: target.y } });
    const r = dispatchOrThrow<{ id: string }>({ op: "combineVariants", ids: [target.id, dup] });
    // The engine names a set built from plain names "Component Set"; keep the component's name.
    if (target.name) dispatchOrThrow({ op: "update", ids: [r.id], patch: { name: target.name } });
    dispatchOrThrow({ op: "select", ids: [dup] });
  });
}

function addToSet(set: Node, source: Node): boolean {
  const doc = getDoc();
  const vs = variantsOf(doc, set);
  const props: Props = { ...(source.component?.variantProps ?? {}) };
  const key = Object.keys(props)[0] ?? "Property 1";
  const used = new Set(vs.map((v) => v.component?.variantProps[key]));
  let i = vs.length + 1;
  while (used.has(`Variant ${i}`)) i++;
  props[key] = `Variant ${i}`;
  return batch(() => {
    const dup = dispatchOrThrow<{ created: string[] }>({ op: "duplicate", ids: [source.id] }).created[0];
    const patch: Record<string, unknown> = { name: variantName(props), component: { description: source.component?.description ?? "", variantProps: props } };
    if (!set.layout) {
      // Free-form set: place it after the right-most variant and grow the set to fit.
      const right = Math.max(...vs.map((v) => v.x + v.width));
      patch.x = right + SET_PAD;
      patch.y = source.y;
      dispatchOrThrow({ op: "update", ids: [dup], patch });
      const w = right + SET_PAD + source.width + SET_PAD;
      if (w > set.width) dispatchOrThrow({ op: "update", ids: [set.id], patch: { width: w } });
    } else {
      dispatchOrThrow({ op: "update", ids: [dup], patch });
    }
    dispatchOrThrow({ op: "select", ids: [dup] });
  });
}

/** Writes variant props and the matching "Prop=Value, …" name. Must run inside `batch`. */
function writeVariantProps(n: Node, props: Props) {
  const old = n.component?.variantProps ?? {};
  const component = { description: n.component?.description ?? "", variantProps: props };
  // A merge patch can't drop map keys (a renamed property), so clear the info first.
  if (Object.keys(old).some((k) => !(k in props))) dispatchOrThrow({ op: "update", ids: [n.id], patch: { component: null } });
  dispatchOrThrow({ op: "update", ids: [n.id], patch: { name: variantName(props), component } });
}

/** Engine order (keys sorted), so names match what combine-as-variants writes. */
function variantName(props: Props): string {
  return Object.keys(props)
    .sort()
    .map((k) => `${k}=${props[k]}`)
    .join(", ");
}

// ---------- Swapping ----------

export interface SwapGroup {
  set: Node | null;
  items: Node[];
}

/** Every main component in the file, grouped by component set (sets first). */
export function swapGroups(doc: Doc): SwapGroup[] {
  const sets = new Map<string, SwapGroup>();
  const loose: Node[] = [];
  for (const n of Object.values(doc.nodes)) {
    if (n.type !== "component") continue;
    const set = variantSet(doc, n);
    if (set) {
      if (!sets.has(set.id)) sets.set(set.id, { set, items: variantsOf(doc, set) });
    } else loose.push(n);
  }
  const byName = (a: Node, b: Node) => a.name.localeCompare(b.name);
  const groups = [...sets.values()].sort((a, b) => byName(a.set!, b.set!));
  if (loose.length) groups.push({ set: null, items: loose.sort(byName) });
  return groups;
}

/** The variant of `set` closest to the instance's current variant props (else its first). */
export function bestVariant(doc: Doc, set: Node, current: Node | undefined): Node | undefined {
  const want = current?.component?.variantProps ?? {};
  let best: Node | undefined;
  let score = -1;
  for (const v of variantsOf(doc, set)) {
    const s = Object.entries(v.component?.variantProps ?? {}).filter(([k, val]) => want[k] === val).length;
    if (s > score) [best, score] = [v, s];
  }
  return best;
}

export function swapInstances(ids: string[], componentId: string): boolean {
  if (ids.length === 1) return dispatch({ op: "swapComponent", id: ids[0], componentId }) !== null;
  return batch(() => ids.forEach((id) => dispatchOrThrow({ op: "swapComponent", id, componentId })));
}

// ---------- Styles ----------

/** Why `name` can't be used for the style `id` (another style of the kind has it), or null. */
function takenStyleName(kind: "colors" | "texts", id: string, name: string): string | null {
  const other = getDoc().styles[kind].some((s) => s.id !== id && s.name.trim().toLowerCase() === name.trim().toLowerCase());
  return other ? `A ${kind === "colors" ? "colour" : "text"} style named “${name.trim()}” already exists` : null;
}

export function updateColorStyle(id: string, change: { name?: string; color?: string }): boolean {
  const taken = change.name !== undefined ? takenStyleName("colors", id, change.name) : null;
  if (taken) return toast(taken, "error"), false;
  return dispatch({ op: "updateColorStyle", id, name: change.name ?? null, color: change.color ?? null }) !== null;
}

/** Deletes a style; layers using it keep their look but are detached (undoable). */
export function deleteStyle(id: string): boolean {
  const doc = getDoc();
  const style = [...doc.styles.colors, ...doc.styles.texts].find((s) => s.id === id);
  const used = Object.values(doc.nodes).filter((n) => n.fillStyle === id || n.textStyle === id).length;
  if (dispatch({ op: "deleteStyle", id }) === null) return false;
  if (used) toast(`Deleted “${style?.name ?? "style"}”: ${used} layer${used === 1 ? "" : "s"} keep${used === 1 ? "s" : ""} the look, detached. Undo with ${MOD}Z.`);
  return true;
}

/** Edits the text style at `index` in place (its id stays) and updates the layers using it. */
export function updateTextStyle(index: number, change: Partial<Omit<TextStyle, "id">>): boolean {
  const target = getDoc().styles.texts[index];
  if (!target) return false;
  if (change.name !== undefined) {
    change.name = change.name.trim();
    if (!change.name) return toast("Name can't be empty", "error"), false;
    const taken = takenStyleName("texts", target.id, change.name);
    if (taken) return toast(taken, "error"), false;
  }
  return (
    dispatch({
      op: "updateTextStyle",
      id: target.id,
      name: change.name ?? null,
      fontFamily: change.fontFamily ?? null,
      fontSize: change.fontSize ?? null,
      fontWeight: change.fontWeight ?? null,
      lineHeight: change.lineHeight ?? null,
      autoLineHeight: "lineHeight" in change && change.lineHeight == null,
      letterSpacing: change.letterSpacing ?? null,
    }) !== null
  );
}

/** A text style with default properties (for "+" with no text selected). */
export function addDefaultTextStyle(name: string): boolean {
  return dispatch({ op: "ai", tool: "define_styles", input: { texts: [{ name, fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: null, letterSpacing: 0 }] } }) !== null;
}

/** "Base 1", "Base 2", … not yet used by any of `names`. */
export function nextName(base: string, names: string[]): string {
  let i = names.length + 1;
  while (names.includes(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}
