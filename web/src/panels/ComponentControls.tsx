// Design panel sections for main components, component sets and instances, and the
// swap-instance picker (also opened from the canvas context menu).

import { useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Check, ChevronDown, Component, CornerUpLeft, Link2, Plus, Scan } from "lucide-react";
import { dispatch, query, useDoc, useStore, zoomToSelection } from "../store";
import type { Node } from "../types";
import { IconButton, Popover, Section, SelectField } from "../ui/controls";
import * as A from "../actions";
import {
  addVariant,
  addVariantProperty,
  bestVariant,
  renameVariantProperty,
  renameVariantValue,
  setProperties,
  setVariantValue,
  swapGroups,
  swapInstances,
  variantSet,
  variantsOf,
} from "../componentOps";
import { InlineInput } from "./InlineInput";
import { InstanceProps, PropertiesSection } from "./PropertyControls";
import "./workflow.css";

const PURPLE = "#c4a5ff";

/** A selected main component: description, its variant values and "Add variant". */
export function MainComponentSection({ n }: { n: Node }) {
  const doc = useDoc();
  const set = variantSet(doc, n);
  const props = Object.entries(n.component?.variantProps ?? {});
  return (
    <>
      <MainComponentBody n={n} set={set} props={props} />
      <PropertiesSection n={n} />
    </>
  );
}

function MainComponentBody({ n, set, props }: { n: Node; set: Node | null; props: [string, string][] }) {
  return (
    <Section
      title={<span style={{ color: PURPLE }}>❖ {set ? "Variant" : "Main component"}</span>}
      actions={
        set && (
          <IconButton title="Select component set" onClick={() => dispatch({ op: "select", ids: [set.id] })}>
            <Component size={13} />
          </IconButton>
        )
      }
    >
      <textarea
        className="textinput"
        placeholder="Description (used by Claude and code export)"
        defaultValue={n.component?.description ?? ""}
        key={n.id}
        onKeyDown={(e) => e.stopPropagation()}
        onBlur={(e) => dispatch({ op: "update", ids: [n.id], patch: { component: { ...n.component, description: e.target.value } } })}
      />
      {set && props.length > 0 && (
        <div className="wf-props">
          <div className="wf-props-head muted small">
            <span>Property</span>
            <span>Value</span>
          </div>
          {props.map(([k, v]) => (
            <div className="wf-prop-row" key={k}>
              <InlineInput value={k} title={`Property name (renames “${k}” on every variant)`} onCommit={(t) => renameVariantProperty(set, k, t)} />
              <InlineInput value={v} title={`This variant's ${k}`} onCommit={(t) => setVariantValue(n, k, t)} />
            </div>
          ))}
        </div>
      )}
      <button className="btn block wf-gap" onClick={() => addVariant(n)} title={set ? "Add another variant to this set" : "Duplicate and combine into a variant set"}>
        <Plus size={13} /> Add variant
      </button>
    </Section>
  );
}

/** A selected component set: editable property names and values. */
export function ComponentSetSection({ n }: { n: Node }) {
  const doc = useDoc();
  const props = setProperties(doc, n);
  const count = variantsOf(doc, n).length;
  return (
    <>
      <ComponentSetBody n={n} props={props} count={count} />
      <PropertiesSection n={n} />
    </>
  );
}

function ComponentSetBody({ n, props, count }: { n: Node; props: { name: string; values: string[] }[]; count: number }) {
  return (
    <Section title={<span style={{ color: PURPLE }}>❖ Component set</span>}>
      {props.length === 0 && <div className="muted small">No variant properties.</div>}
      {props.map((p) => (
        <div className="wf-prop-block" key={p.name}>
          <InlineInput value={p.name} label="Prop" title="Property name" onCommit={(t) => renameVariantProperty(n, p.name, t)} />
          <div className="wf-values">
            {p.values.map((v) => (
              <InlineInput key={v} className="wf-value" value={v} title={`Rename the “${v}” value on every variant`} onCommit={(t) => renameVariantValue(n, p.name, v, t)} />
            ))}
          </div>
        </div>
      ))}
      <div className="muted small wf-gap">
        {count} variant{count === 1 ? "" : "s"}
      </div>
      <div className="grid2 wf-gap">
        <button className="btn" onClick={() => addVariant(n)}>
          <Plus size={13} /> Variant
        </button>
        <button className="btn" onClick={() => addVariantProperty(n)}>
          <Plus size={13} /> Property
        </button>
      </div>
    </Section>
  );
}

/** A selected instance: swap, variant pickers, overrides. */
export function InstanceSection({ n }: { n: Node }) {
  const doc = useDoc();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // Layers that differ from the main component, including ones changed through an outer instance.
  const overrides = useMemo(() => query<{ count: number }>({ q: "overrideCount", id: n.id }).count, [doc, n.id]);
  if (!n.instance) return null;
  const comp = doc.nodes[n.instance.componentId];
  const set = comp ? variantSet(doc, comp) : null;
  const variantProps: Record<string, Set<string>> = {};
  if (set) {
    for (const v of variantsOf(doc, set)) {
      for (const [k, val] of Object.entries(v.component?.variantProps ?? {})) (variantProps[k] ??= new Set()).add(val);
    }
  }
  return (
    <Section
      title={
        <span style={{ color: PURPLE }}>
          <Component size={12} style={{ verticalAlign: -2 }} /> {comp?.name ?? "Missing component"}
        </span>
      }
      actions={
        <>
          <IconButton title="Go to main component" onClick={() => comp && (dispatch({ op: "select", ids: [comp.id] }), zoomToSelection())}>
            <Link2 size={13} />
          </IconButton>
          <IconButton title="Reset overrides" onClick={() => dispatch({ op: "resetInstance", ids: [n.id] })}>
            <CornerUpLeft size={13} />
          </IconButton>
          <IconButton title="Detach instance" onClick={A.detachInstance}>
            <Scan size={13} />
          </IconButton>
        </>
      }
    >
      <div className="row">
        <button className="field wf-swap" title="Swap instance" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
          <Component size={12} className="wf-purple" />
          <span className="wf-swap-name">{set?.name ?? comp?.name ?? "Missing component"}</span>
          <ChevronDown size={12} className="muted" />
        </button>
      </div>
      {anchor && <SwapPicker ids={[n.id]} anchor={anchor} onClose={() => setAnchor(null)} />}
      {Object.entries(variantProps).map(([k, values]) => (
        <div className="row" key={k}>
          <span className="muted wf-prop-label" title={k}>
            {k}
          </span>
          <SelectField
            value={comp?.component?.variantProps[k] ?? ""}
            options={[...values].map((v) => ({ value: v, label: v }))}
            onChange={(value) => dispatch({ op: "setVariant", id: n.id, prop: k, value })}
          />
        </div>
      ))}
      <InstanceProps n={n} />
      {overrides > 0 && <div className="muted small">{overrides === 1 ? "1 override" : `${overrides} overrides`}</div>}
    </Section>
  );
}

/** Searchable list of the file's components and variant sets; picking one swaps `ids`. */
export function SwapPicker({ ids, anchor, onClose }: { ids: string[]; anchor: DOMRect; onClose: () => void }) {
  const doc = useDoc();
  const [q, setQ] = useState("");
  const first = doc.nodes[ids[0]];
  const current = first?.instance ? doc.nodes[first.instance.componentId] : undefined;
  const groups = useMemo(() => swapGroups(doc), [doc]);
  const pageId = useStore((s) => s.es.page);
  const pageName = (id: string) => doc.pages.find((p) => p.id === id)?.name ?? "";
  const needle = q.trim().toLowerCase();
  const pick = (id: string | undefined) => {
    onClose();
    if (id) swapInstances(ids, id);
  };
  const shown = groups
    .map((g) => {
      if (!needle || g.set?.name.toLowerCase().includes(needle)) return g;
      return { ...g, items: g.items.filter((i) => i.name.toLowerCase().includes(needle)) };
    })
    .filter((g) => g.items.length);
  return (
    <Popover anchor={anchor} onClose={onClose} width={260}>
      <div className="wf-picker">
        <input
          className="textinput"
          placeholder="Swap with…"
          aria-label="Search components"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onClose();
            if (e.key === "Enter") {
              const g = shown[0];
              if (g) pick(g.set && !needle ? bestVariant(doc, g.set, current)?.id : g.items[0].id);
            }
          }}
        />
        <div className="wf-picker-list">
          {shown.length === 0 && <div className="muted small wf-empty">{groups.length ? "No matches" : "No components in this file yet"}</div>}
          {shown.map((g) => (
            <div key={g.set?.id ?? "loose"}>
              {g.set ? (
                <button className="wf-pick wf-pick-set" title="Swap to this set (closest variant)" onClick={() => pick(bestVariant(doc, g.set!, current)?.id)}>
                  <Component size={12} className="wf-purple" />
                  <span className="wf-pick-name">{g.set.name}</span>
                  <span className="muted small">{g.set.page !== pageId ? `${pageName(g.set.page)} · ` : ""}{variantsOf(doc, g.set).length}</span>
                </button>
              ) : (
                <div className="wf-pick-head muted small">Components</div>
              )}
              {g.items.map((c) => (
                <button key={c.id} className={"wf-pick" + (g.set ? " wf-pick-sub" : "") + (c.id === current?.id ? " current" : "")} onClick={() => pick(c.id)}>
                  {c.id === current?.id ? <Check size={12} /> : <span className="wf-pick-dot" />}
                  <span className="wf-pick-name">{c.name || "Component"}</span>
                  {!g.set && c.page !== pageId && <span className="muted small">{pageName(c.page)}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Popover>
  );
}

let floating: { root: Root; el: HTMLDivElement } | null = null;

/** Opens the swap picker at a screen point (from the canvas context menu). */
export function openSwapPicker(ids: string[], x: number, y: number) {
  closeSwapPicker();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const me = { root: createRoot(el), el };
  floating = me;
  const width = 260;
  // Popover places itself left of its anchor; anchor just right of the picker so it opens at the cursor.
  const anchor = new DOMRect(Math.min(x, window.innerWidth - width - 8) + width + 12, y, 0, 0);
  me.root.render(<SwapPicker ids={ids} anchor={anchor} onClose={() => floating === me && closeSwapPicker()} />);
}

function closeSwapPicker() {
  const f = floating;
  floating = null;
  // Deferred: this can run from inside the picker's own event handlers.
  if (f)
    setTimeout(() => {
      f.root.unmount();
      f.el.remove();
    }, 0);
}
