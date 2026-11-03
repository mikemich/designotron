// Variable scopes: which properties a variable is offered for in the binding pickers.
// Mirrors `variables::SCOPES` / `scope_of` in the engine (existing bindings keep working whatever the scope).

import type { VarKind, Variable } from "../types";

export const SCOPES: { id: string; label: string }[] = [
  { id: "fill", label: "Fill" },
  { id: "stroke", label: "Stroke colour" },
  { id: "cornerRadius", label: "Corner radius" },
  { id: "size", label: "Width and height" },
  { id: "gap", label: "Gap and padding" },
  { id: "opacity", label: "Opacity" },
  { id: "strokeWidth", label: "Stroke width" },
  { id: "textContent", label: "Text content" },
  { id: "fontFamily", label: "Font family" },
  { id: "fontSize", label: "Font size" },
  { id: "fontWeight", label: "Font weight" },
  { id: "lineHeight", label: "Line height" },
  { id: "letterSpacing", label: "Letter spacing" },
  { id: "paragraphSpacing", label: "Paragraph spacing" },
];

/** Scopes that make sense for a variable type (booleans have none: they bind to Visible only). */
export const SCOPES_FOR_KIND: Record<VarKind, string[]> = {
  color: ["fill", "stroke"],
  number: ["cornerRadius", "size", "gap", "opacity", "strokeWidth", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paragraphSpacing"],
  string: ["textContent", "fontFamily"],
  boolean: [],
};

const SCOPE_OF: Record<string, string> = {
  fill: "fill",
  stroke: "stroke",
  cornerRadius: "cornerRadius",
  width: "size",
  height: "size",
  gap: "gap",
  counterGap: "gap",
  padding: "gap",
  paddingTop: "gap",
  paddingRight: "gap",
  paddingBottom: "gap",
  paddingLeft: "gap",
  opacity: "opacity",
  strokeWeight: "strokeWidth",
  characters: "textContent",
  fontFamily: "fontFamily",
  fontSize: "fontSize",
  fontWeight: "fontWeight",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  paragraphSpacing: "paragraphSpacing",
};

/** True when the variable's scopes cover the property (no scopes = everything of its type). */
export function inScope(v: Pick<Variable, "scopes">, prop: string): boolean {
  const s = SCOPE_OF[prop];
  return !v.scopes?.length || !s || v.scopes.includes(s);
}

/** Would pointing `from` at `to` close an alias loop (`to` is `from`, or leads back to it)? */
export function aliasCycle(collections: { variables: Variable[] }[], from: string, to: string): boolean {
  const byId = new Map<string, Variable>();
  for (const c of collections) for (const v of c.variables) byId.set(v.id, v);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const val of Object.values(byId.get(id)?.values ?? {})) {
      const a = (val as { alias?: string } | null)?.alias;
      if (typeof a === "string") stack.push(a);
    }
  }
  return false;
}
