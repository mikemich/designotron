// Component properties (boolean, text, instance swap): typed access to the engine's
// `componentProps` command and query. The engine owns all the rules; this only shapes them.

import { dispatch, query } from "./store";
import type { PropKind, PropRefs } from "./types";

export type PropValue = boolean | string;
export type BindField = "visible" | "characters" | "swap";

/** A property of a main component or set, with the layers bound to it. */
export interface MainProp {
  id: string;
  name: string;
  kind: PropKind;
  /** What the main component shows. */
  default: PropValue;
  options: { id: string; name: string }[];
  bound: { node: string; name: string; field: BindField }[];
}

/** One instance's property controls (the instance itself, or a nested one that exposes them). */
export interface InstanceGroup {
  instance: string;
  name: string;
  /** Name of the outer instance when this is a nested instance's group. */
  outer: string | null;
  component: string;
  props: {
    id: string;
    name: string;
    kind: PropKind;
    value: PropValue;
    /** Set on this instance (differs from the main component). */
    custom: boolean;
    /** A layer of the instance uses it. */
    bound: boolean;
    /** Instance swap: the components it can take. */
    options?: { id: string; name: string }[];
  }[];
}

/** A layer of a main component: the properties it can bind to and what it is bound to. */
export interface LayerInfo {
  mode: "layer";
  owner: string;
  props: { id: string; name: string; kind: PropKind }[];
  refs: PropRefs | null;
  canBind: Record<BindField, boolean>;
}

export type PropsInfo =
  | { mode: "none" }
  | { mode: "main"; owner: string; props: MainProp[] }
  | LayerInfo
  | { mode: "instance"; groups: InstanceGroup[]; canExpose: boolean; exposed: boolean; layer: LayerInfo | null };

export const BIND_KIND: Record<BindField, PropKind> = { visible: "boolean", characters: "text", swap: "instanceSwap" };

export const KIND_LABEL: Record<PropKind, string> = { boolean: "Boolean", text: "Text", instanceSwap: "Instance swap" };

export function componentProps(id: string): PropsInfo {
  return query<PropsInfo>({ q: "componentProps", id });
}

/** Runs one property edit (one undo step); null when the engine refused it (a toast says why). */
export function propsEdit(edit: Record<string, unknown>): { id?: string } | null {
  return dispatch({ op: "componentProps", edit });
}

export const addProp = (component: string, name: string, kind: PropKind, opts: { default?: PropValue; bind?: string } = {}) =>
  propsEdit({ op: "add", component, name, kind, default: opts.default ?? null, bind: opts.bind ?? null });

export const updateProp = (component: string, prop: string, change: { name?: string; default?: PropValue; options?: string[] }) =>
  propsEdit({ op: "update", component, prop, name: change.name ?? null, default: change.default ?? null, options: change.options ?? null });

export const deleteProp = (component: string, prop: string) => propsEdit({ op: "delete", component, prop });

export const bindLayer = (node: string, field: BindField, prop: string | null) => propsEdit({ op: "bind", node, field, prop });

/** Sets an instance's value for a property; null goes back to the main component's. */
export const setInstanceProp = (instance: string, prop: string, value: PropValue | null) =>
  propsEdit({ op: "set", instance, prop, value });

export const exposeProps = (instance: string, expose: boolean) => propsEdit({ op: "expose", instance, expose });

/** A name for a new property that isn't taken ("Property 1", "Property 2", …). */
export function freeName(taken: string[], base = "Property"): string {
  let i = taken.length + 1;
  while (taken.includes(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}
