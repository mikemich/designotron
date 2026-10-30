// Component properties in the design panel: defining them on a main component or set, applying
// them to layers ("Apply component property"), and the controls an instance shows at the top
// of its panel (toggle, text field, swap dropdown).

import { useMemo, useState } from "react";
import { CornerUpLeft, DiamondPlus, Eye, Replace, ToggleLeft, Trash2, Type, Unlink } from "lucide-react";
import { useDoc, useStore } from "../store";
import type { Doc, Node, PropKind } from "../types";
import { IconButton, Popover, Section, SelectField, Seg } from "../ui/controls";
import {
  addProp,
  bindLayer,
  componentProps,
  deleteProp,
  exposeProps,
  freeName,
  KIND_LABEL,
  setInstanceProp,
  updateProp,
  type BindField,
  type InstanceGroup,
  type MainProp,
  type PropValue,
} from "../componentProps";
import { InlineInput } from "./InlineInput";

const KIND_ICON: Record<PropKind, typeof Type> = { boolean: ToggleLeft, text: Type, instanceSwap: Replace };
const FIELD_LABEL: Record<BindField, string> = { visible: "Visibility", characters: "Text", swap: "Instance" };
const FIELD_ICON: Record<BindField, typeof Type> = { visible: Eye, characters: Type, swap: Replace };

/** The properties of a selected main component or component set: create, rename, default, delete. */
export function PropertiesSection({ n }: { n: Node }) {
  const doc = useDoc();
  // Queries and the component list are redone when the document changes, not on every render.
  const docRev = useStore((s) => s.es.docRev);
  const info = useMemo(() => componentProps(n.id), [docRev, n.id]);
  const options = useMemo(() => componentOptions(doc), [docRev]);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (info.mode !== "main") return null;
  return (
    <Section
      title={<span className="wf-purple-text">Properties</span>}
      actions={
        <IconButton title="Create component property" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
          <DiamondPlus size={13} />
        </IconButton>
      }
    >
      {info.props.length === 0 && (
        <div className="muted small">No properties yet. Create one here, or from a layer's “Apply component property”.</div>
      )}
      {info.props.map((p) => (
        <MainPropRow key={p.id} owner={n.id} p={p} options={options} />
      ))}
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={250}>
          <CreateForm
            title="Create component property"
            taken={info.props.map((p) => p.name)}
            onCreate={(name, kind, def) => {
              if (addProp(n.id, name, kind, { default: def })) setAnchor(null);
            }}
            options={options}
          />
        </Popover>
      )}
    </Section>
  );
}

type ComponentChoice = { value: string; label: string };

function MainPropRow({ owner, p, options }: { owner: string; p: MainProp; options: ComponentChoice[] }) {
  const Icon = KIND_ICON[p.kind];
  const used = p.bound.map((b) => b.name || "Layer");
  return (
    <div className="wf-prop-block" data-testid={`prop-${p.name}`}>
      <div className="row">
        <Icon size={13} className="wf-purple" />
        <InlineInput value={p.name} title={`Property name (${KIND_LABEL[p.kind]})`} onCommit={(t) => updateProp(owner, p.id, { name: t }) !== null} />
        <IconButton title="Delete property" onClick={() => deleteProp(owner, p.id)}>
          <Trash2 size={13} />
        </IconButton>
      </div>
      <div className="row wf-indent">
        {p.kind === "boolean" && (
          <label className="row wf-check" title="What the main component shows">
            <input type="checkbox" aria-label={`${p.name} default`} checked={p.default === true} onChange={(e) => updateProp(owner, p.id, { default: e.target.checked })} />
            <span className="muted small">{p.default === true ? "On by default" : "Off by default"}</span>
          </label>
        )}
        {p.kind === "text" && (
          <InlineInput
            value={String(p.default)}
            title={`${p.name} default text`}
            label="Default"
            onCommit={(t) => updateProp(owner, p.id, { default: t }) !== null}
          />
        )}
        {p.kind === "instanceSwap" && (
          <SelectField
            label="Default"
            title={`${p.name} default component`}
            value={String(p.default)}
            options={withCurrent(options, String(p.default))}
            onChange={(id) => updateProp(owner, p.id, { default: id })}
          />
        )}
      </div>
      <div className="muted small wf-indent">{used.length ? `Applied to ${used.join(", ")}` : "Not applied to a layer yet"}</div>
    </div>
  );
}

/** Every main component as dropdown options (variants labelled with their set). */
function componentOptions(doc: Doc): ComponentChoice[] {
  return Object.values(doc.nodes)
    .filter((c) => c.type === "component")
    .map((c) => {
      const set = c.parent ? doc.nodes[c.parent] : null;
      return { value: c.id, label: set?.type === "componentSet" ? `${set.name} / ${c.name}` : c.name };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

const withCurrent = (options: ComponentChoice[], current: string): ComponentChoice[] =>
  options.some((o) => o.value === current) ? options : [{ value: current, label: "Missing component" }, ...options];

/** Name, type and default for a new property. With `kind` fixed (made from a layer) only the name. */
function CreateForm(props: {
  title: string;
  taken: string[];
  options: ComponentChoice[];
  kind?: PropKind;
  onCreate: (name: string, kind: PropKind, def: PropValue | undefined) => void;
}) {
  const [kind, setKind] = useState<PropKind>(props.kind ?? "boolean");
  const [name, setName] = useState(freeName(props.taken));
  const options = props.options;
  const [swap, setSwap] = useState(options[0]?.value ?? "");
  const [text, setText] = useState("Text");
  const [on, setOn] = useState(true);
  const fromLayer = !!props.kind;
  const submit = () => {
    const def = fromLayer ? undefined : kind === "boolean" ? on : kind === "text" ? text : swap;
    props.onCreate(name.trim(), kind, def);
  };
  return (
    <div className="wf-create" data-testid="create-prop">
      <div className="muted small wf-gap-b">{props.title}</div>
      <input
        className="textinput"
        aria-label="Property name"
        placeholder="Property name"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && name.trim()) submit();
        }}
      />
      {!fromLayer && (
        <>
          <div className="wf-gap">
            <Seg
              value={kind}
              options={[
                { value: "boolean", label: "Boolean", title: "Shows or hides a layer" },
                { value: "text", label: "Text", title: "A text layer's characters" },
                { value: "instanceSwap", label: "Instance", title: "Swaps a nested instance" },
              ]}
              onChange={setKind}
            />
          </div>
          <div className="wf-gap">
            {kind === "boolean" && (
              <label className="row wf-check">
                <input type="checkbox" checked={on} aria-label="Default on" onChange={(e) => setOn(e.target.checked)} /> On by default
              </label>
            )}
            {kind === "text" && <input className="textinput" aria-label="Default text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />}
            {kind === "instanceSwap" &&
              (options.length ? (
                <SelectField title="Default component" value={swap} options={options} onChange={setSwap} />
              ) : (
                <div className="muted small">Make a main component first.</div>
              ))}
          </div>
        </>
      )}
      <button className="btn primary block wf-gap" disabled={!name.trim() || (kind === "instanceSwap" && !fromLayer && !swap)} onClick={submit}>
        Create property
      </button>
    </div>
  );
}

/** A layer of a main component: apply component properties to its visibility, text or swap. */
export function LayerPropsSection({ n }: { n: Node }) {
  const docRev = useStore((s) => s.es.docRev);
  const found = useMemo(() => componentProps(n.id), [docRev, n.id]);
  const info = found.mode === "instance" ? found.layer : found;
  if (info?.mode !== "layer") return null;
  const fields = (["visible", "characters", "swap"] as BindField[]).filter((f) => info.canBind[f]);
  return (
    <Section title={<span className="wf-purple-text">Component properties</span>}>
      {fields.map((f) => (
        <LayerPropRow key={f} n={n} field={f} owner={info.owner} props={info.props} bound={info.refs?.[f] ?? null} />
      ))}
    </Section>
  );
}

function LayerPropRow(props: {
  n: Node;
  field: BindField;
  owner: string;
  props: { id: string; name: string; kind: PropKind }[];
  bound: string | null;
}) {
  const { n, field, owner, bound } = props;
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const kind: PropKind = field === "visible" ? "boolean" : field === "characters" ? "text" : "instanceSwap";
  const mine = props.props.filter((p) => p.kind === kind);
  const current = props.props.find((p) => p.id === bound);
  const Icon = FIELD_ICON[field];
  return (
    <div className="row" data-testid={`bind-${field}`}>
      <span className="muted wf-prop-label">
        <Icon size={12} style={{ verticalAlign: -2 }} /> {FIELD_LABEL[field]}
      </span>
      {current ? (
        <>
          <span className="wf-chip wf-bound" title={`Controlled by the ${current.name} property`}>
            <DiamondPlus size={12} className="wf-purple" />
            <span className="wf-chip-name">{current.name}</span>
          </span>
          <IconButton title="Remove property" onClick={() => bindLayer(n.id, field, null)}>
            <Unlink size={13} />
          </IconButton>
        </>
      ) : (
        <button className="field wf-apply" title="Apply component property" onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
          <DiamondPlus size={12} className="wf-purple" />
          <span className="muted">Apply property…</span>
        </button>
      )}
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={240}>
          <div className="wf-picker" data-testid="apply-prop">
            {mine.length > 0 && <div className="wf-pick-head muted small">{KIND_LABEL[kind]} properties</div>}
            {mine.map((p) => (
              <button
                key={p.id}
                className="wf-pick"
                onClick={() => {
                  if (bindLayer(n.id, field, p.id)) setAnchor(null);
                }}
              >
                <DiamondPlus size={12} className="wf-purple" />
                <span className="wf-pick-name">{p.name}</span>
              </button>
            ))}
            <div className="wf-pick-head muted small">New</div>
            <CreateForm
              title={`Create ${KIND_LABEL[kind].toLowerCase()} property from this layer`}
              taken={props.props.map((p) => p.name)}
              options={[]}
              kind={kind}
              onCreate={(name) => {
                if (addProp(owner, name, kind, { bind: n.id })) setAnchor(null);
              }}
            />
          </div>
        </Popover>
      )}
    </div>
  );
}

/** The controls an instance shows for its component's properties, and for those of nested
 *  instances that expose theirs. Empty when there is nothing to control. */
export function InstanceProps({ n }: { n: Node }) {
  const docRev = useStore((s) => s.es.docRev);
  const info = useMemo(() => componentProps(n.id), [docRev, n.id]);
  if (info.mode !== "instance") return null;
  const own = info.groups.find((g) => g.instance === n.id);
  const nested = info.groups.filter((g) => g.instance !== n.id);
  if (!own && !nested.length && !info.canExpose) return null;
  return (
    <div className="wf-instance-props" data-testid="instance-props">
      {own && <GroupControls g={own} />}
      {nested.map((g) => (
        <div key={g.instance}>
          <div className="wf-group-head muted small">{g.name}</div>
          <GroupControls g={g} />
        </div>
      ))}
      {info.canExpose && own && (
        <label className="row wf-check" title="Show this instance's properties on instances of the component it sits in">
          <input type="checkbox" checked={info.exposed} onChange={(e) => exposeProps(n.id, e.target.checked)} />
          <span className="muted small">Expose properties on the outer component</span>
        </label>
      )}
    </div>
  );
}

function GroupControls({ g }: { g: InstanceGroup }) {
  return (
    <>
      {g.props.map((p) => (
        <div className="row wf-ctl" key={p.id} data-testid={`ctl-${p.name}`}>
          {p.kind === "boolean" && (
            <label className="wf-ctl-bool" title={p.name}>
              <input type="checkbox" aria-label={p.name} checked={p.value === true} onChange={(e) => setInstanceProp(g.instance, p.id, e.target.checked)} />
              <span className="wf-prop-name">{p.name}</span>
            </label>
          )}
          {p.kind === "text" && (
            <InlineInput label={p.name} title={p.name} value={String(p.value)} onCommit={(t) => setInstanceProp(g.instance, p.id, t) !== null} />
          )}
          {p.kind === "instanceSwap" && (
            <SelectField
              label={p.name}
              title={p.name}
              value={String(p.value)}
              options={(p.options ?? []).map((o) => ({ value: o.id, label: o.name }))}
              onChange={(id) => setInstanceProp(g.instance, p.id, id)}
            />
          )}
          {p.custom && (
            <IconButton title={`Reset ${p.name}`} onClick={() => setInstanceProp(g.instance, p.id, null)}>
              <CornerUpLeft size={13} />
            </IconButton>
          )}
        </div>
      ))}
    </>
  );
}
