// What deleting variables leaves behind, and what an alias shows: pure helpers shared by the
// Variables dialog and the Design panel's variable picker.

import type { VariableCollection } from "../types";

/** The id an alias value points at, or null for a plain value. */
export const aliasOf = (val: unknown): string | null => {
  const a = val && typeof val === "object" ? (val as { alias?: unknown }).alias : null;
  return typeof a === "string" ? a : null;
};

/**
 * A variable's value in a mode with aliases followed (the first mode's value when this mode has none).
 * An alias to a variable that is gone shows the aliasing variable's default-mode value, as the engine
 * does for the canvas and tokens.css; `undefined` when there is nothing to show.
 */
export function resolveValue(collections: VariableCollection[], id: string, mode: string): unknown {
  const all = new Map(collections.flatMap((c) => c.variables.map((v) => [v.id, { v, first: c.modes[0]?.id }] as const)));
  let cur = id;
  for (let i = 0; i < 8; i++) {
    const x = all.get(cur);
    if (!x) return undefined;
    const val = x.v.values[mode] ?? (x.first ? x.v.values[x.first] : undefined) ?? Object.values(x.v.values)[0];
    const next = aliasOf(val);
    if (!next) return val;
    if (all.has(next)) {
      cur = next;
      continue;
    }
    // The target was deleted: this variable's default mode stands in for it.
    const def = x.first ? x.v.values[x.first] : undefined;
    const again = aliasOf(def);
    if (def === undefined) return undefined;
    if (!again) return def;
    if (!all.has(again)) return undefined;
    cur = again;
  }
  return undefined;
}

/** True when `id` is an alias target that no variable has. */
export const isMissing = (collections: VariableCollection[], id: string): boolean => !collections.some((c) => c.variables.some((v) => v.id === id));

/** What deleting these variables leaves behind: layers bound to them, and aliases of them in variables that stay. */
export function deleteImpact(nodes: Record<string, { bindings?: Record<string, string> }>, collections: VariableCollection[], gone: Set<string>) {
  const layers = Object.values(nodes).filter((n) => n.bindings && Object.values(n.bindings).some((id) => gone.has(id))).length;
  let aliases = 0;
  for (const c of collections)
    for (const v of c.variables) {
      if (gone.has(v.id)) continue;
      for (const x of Object.values(v.values)) {
        const a = aliasOf(x);
        if (a !== null && gone.has(a)) aliases++;
      }
    }
  return { layers, aliases };
}

/**
 * "3 layers keep their current value; 2 aliases now use their deleted variable's value." Empty when
 * nothing depended on it. `name` is the one variable that was deleted ("1 alias now uses Ink's value").
 */
export function impactMessage({ layers, aliases }: { layers: number; aliases: number }, name?: string): string {
  const parts: string[] = [];
  if (layers) parts.push(layers === 1 ? "1 layer keeps its current value" : `${layers} layers keep their current value`);
  if (aliases) parts.push(aliases === 1 ? (name ? `1 alias now uses ${name}'s value` : "1 alias now uses its deleted variable's value") : name ? `${aliases} aliases now use ${name}'s value` : `${aliases} aliases now use their deleted variable's value`);
  return parts.length ? parts.join("; ") + "." : "";
}
