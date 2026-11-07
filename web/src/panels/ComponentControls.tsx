// Design panel sections for main components, component sets and instances, and the
// swap-instance picker (also opened from the canvas context menu).

import { useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Check, ChevronDown, Component, CornerUpLeft, Link2, Plus, RotateCcw, Scan } from "lucide-react";
import { dispatch, query, useDoc, useStore, zoomToSelection } from "../store";
import type { Node } from "../types";
import { IconButton, Menu, Popover, Section, SelectField, type MenuItem } from "../ui/controls";
import * as A from "../actions";
import {
  addVariant,
  addVariantProperty,
  bestVariant,
  renameVariantProperty,
  renameVariantValue,
  setProperties,
  orderFor,
  orderedEntries,
  propertyOrder,
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
  const props = orderedEntries(n.component?.variantProps ?? {}, orderFor(doc, n));
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
      <textarea
        className="textinput"
        placeholder="Description (used by Claude and code export)"
        aria-label="Component set description"
        defaultValue={n.component?.description ?? ""}
        key={n.id}
        onKeyDown={(e) => e.stopPropagation()}
        onBlur={(e) => {
          if (e.target.value !== (n.component?.description ?? "")) dispatch({ op: "update", ids: [n.id], patch: { component: { ...n.component, description: e.target.value } } });
        }}
      />
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

type OverrideGroup = { key: string; label: string };

/** The property groups a layer inside an instance overrides (see the engine's `OVERRIDE_GROUPS`). */
export function useOverrideGroups(id: string): OverrideGroup[] {
  const doc = useDoc();
  return useMemo(() => query<{ groups: OverrideGroup[] }>({ q: "overrideGroups", id }).groups, [doc, id]);
}

/** Menu items for resetting a layer: everything, then one item per overridden property group. */
export function resetItems(ids: string[], groups: OverrideGroup[], all: string, resetAll: () => void = () => A.resetOverrideGroups(ids)): MenuItem[] {
  const items: MenuItem[] = [{ label: all, onClick: resetAll }];
  if (groups.length) items.push({ sep: true });
  for (const g of groups) items.push({ label: `Reset ${g.label.toLowerCase()}`, onClick: () => A.resetOverrideGroups(ids, [g.key]) });
  return items;
}

type InsideLayer = { id: string; name: string; groups: OverrideGroup[] };

/** The layers inside instance `id` that differ from its main (the engine caps the list at 20). Asked when the menu opens, not on every change. */
export function overriddenLayers(id: string): { layers: InsideLayer[]; more: boolean } {
  return query<{ layers: InsideLayer[]; more: boolean }>({ q: "overriddenLayers", id });
}

/** The instance's reset menu: its own groups, then the changed layers inside it, one reset each. */
export function instanceResetItems(id: string, groups: OverrideGroup[], inside: { layers: InsideLayer[]; more: boolean }): MenuItem[] {
  const items = resetItems([id], groups, "Reset all changes", () => dispatch({ op: "resetInstance", ids: [id] }));
  if (!inside.layers.length) return items;
  items.push({ sep: true }, { heading: "Layers inside" });
  for (const l of inside.layers) {
    items.push({ label: `${l.name}: ${l.groups.map((g) => g.label).join(", ")}`, onClick: () => A.resetOverrideGroups([l.id]) });
  }
  if (inside.more) items.push({ label: "Select a layer to reset one property", disabled: true });
  return items;
}

/** A button that opens the reset menu under itself. */
function ResetButton({ title, items, testId }: { title: string; items: MenuItem[] | (() => MenuItem[]); testId?: string }) {
  const [at, setAt] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  return (
    <>
      <button
        className="ibtn"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={!!at}
        data-testid={testId}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAt({ x: Math.max(8, r.right - 190), y: r.bottom + 2, items: typeof items === "function" ? items() : items });
        }}
      >
        <CornerUpLeft size={13} />
      </button>
      {at && <Menu x={at.x} y={at.y} items={at.items} onClose={() => setAt(null)} label={title} />}
    </>
  );
}

/** "Changed from main: Fill, Text" for a layer inside an instance, with Figma-style per-property reset. */
export function OverridesRow({ n }: { n: Node }) {
  const groups = useOverrideGroups(n.id);
  // An instance (nested ones too) shows its changes in its own section.
  if (n.type === "instance" || !n.masterId || !groups.length) return null;
  return (
    <div className="wf-overrides" data-testid="overrides-row">
      <span className="muted small wf-overrides-text">Changed from main: {groups.map((g) => g.label).join(", ")}</span>
      <ResetButton title="Reset changes on this layer" testId="overrides-reset" items={resetItems([n.id], groups, "Reset all changes on this layer")} />
    </div>
  );
}

/** A selected instance: swap, variant pickers, overrides. */
export function InstanceSection({ n }: { n: Node }) {
  const doc = useDoc();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // Layers that differ from the main component, including ones changed through an outer instance.
  const overrides = useMemo(() => query<{ count: number }>({ q: "overrideCount", id: n.id }).count, [doc, n.id]);
  const groups = useOverrideGroups(n.id);
  if (!n.instance) return null;
  const comp = doc.nodes[n.instance.componentId];
  const set = comp ? variantSet(doc, comp) : null;
  const variantProps: Record<string, Set<string>> = {};
  if (set) {
    for (const v of variantsOf(doc, set)) {
      for (const [k, val] of Object.entries(v.component?.variantProps ?? {})) (variantProps[k] ??= new Set()).add(val);
    }
  }
  const propRows = set ? orderedEntries(Object.fromEntries(Object.keys(variantProps).map((k) => [k, k])), propertyOrder(doc, set)).map(([k]) => k) : Object.keys(variantProps);
  return (
    <Section
      title={
        <span style={{ color: PURPLE }}>
          <Component size={12} style={{ verticalAlign: -2 }} /> {comp ? comp.name : "Main component deleted"}
        </span>
      }
      actions={
        <>
          {comp && (
            <IconButton title="Go to main component" onClick={() => (dispatch({ op: "select", ids: [comp.id] }), zoomToSelection())}>
              <Link2 size={13} />
            </IconButton>
          )}
          {comp && (
            <ResetButton
              title="Reset overrides"
              testId="instance-reset"
              items={() => instanceResetItems(n.id, groups, overriddenLayers(n.id))}
            />
          )}
          <IconButton title="Detach instance" onClick={A.detachInstance}>
            <Scan size={13} />
          </IconButton>
        </>
      }
    >
      {!comp && (
        <>
          <div className="muted small">This instance keeps its look, but its main component was deleted.</div>
          <button className="btn block wf-gap" data-testid="restore-main" onClick={() => A.restoreComponent(n.id)} title="Rebuild the main component from the instances that remain">
            <RotateCcw size={13} /> Restore main component
          </button>
          <div className="muted small wf-gap">Rebuilt from the instance with the fewest changes. Component properties and variant sets can't be restored.</div>
        </>
      )}
      {comp && (
        <div className="row">
          <button className="field wf-swap" title="Swap instance" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
            <Component size={12} className="wf-purple" />
            <span className="wf-swap-name">{set?.name ?? comp.name}</span>
            <ChevronDown size={12} className="muted" />
          </button>
        </div>
      )}
      {comp && anchor && <SwapPicker ids={[n.id]} anchor={anchor} onClose={() => setAnchor(null)} />}
      {propRows.map((k) => [k, variantProps[k]] as const).map(([k, values]) => (
        <div className="row" key={k}>
          <span className="muted wf-prop-label" title={k}>
            {k}
          </span>
          <SelectField
            ariaLabel={`Variant ${k}`}
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
    <Popover anchor={anchor} onClose={onClose} width={260} label="Swap component">
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
