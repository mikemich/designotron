import { useEffect, useState } from "react";
import { Hash, Palette, Plus, ToggleLeft, Trash2, Type as TypeIcon, X } from "lucide-react";
import { dispatch, useDoc, useStore } from "../store";
import type { VarKind, Variable, VariableCollection } from "../types";
import { Menu, type MenuItem, useEscape } from "../ui/controls";
import { cssColor } from "../ui/color";

const uid = (p: string) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const DEFAULTS: Record<VarKind, unknown> = { color: "#6D4AFF", number: 16, string: "Text", boolean: true };

export const KIND_ICON: Record<VarKind, JSX.Element> = {
  color: <Palette size={12} />,
  number: <Hash size={12} />,
  string: <TypeIcon size={12} />,
  boolean: <ToggleLeft size={12} />,
};

function save(collections: VariableCollection[]) {
  dispatch({ op: "setVariables", collections });
}

/** Text input that commits on blur or Enter (one undo step per edit). */
function Commit({ value, onCommit, className, type = "text" }: { value: string; onCommit: (v: string) => void; className?: string; type?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={className ?? "textinput"}
      type={type}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setV(value);
      }}
      onBlur={() => v !== value && onCommit(v)}
    />
  );
}

function ValueCell({ v, mode, onChange }: { v: Variable; mode: string; onChange: (val: unknown) => void }) {
  const val = v.values[mode];
  if (val && typeof val === "object" && "alias" in (val as any)) return <span className="muted small">alias</span>;
  switch (v.type) {
    case "color": {
      const c = typeof val === "string" ? val : "#000000";
      return (
        <div className="row" style={{ gap: 6 }}>
          <label className="swatch" title="Pick colour">
            <i style={{ background: cssColor(c) }} />
            <input type="color" value={c.slice(0, 7)} onChange={(e) => onChange(e.target.value.toUpperCase())} style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
          </label>
          <Commit value={c} onCommit={(x) => onChange(x.trim())} className="textinput mono" />
        </div>
      );
    }
    case "number":
      return <Commit value={String(val ?? 0)} type="number" onCommit={(x) => onChange(Number(x) || 0)} />;
    case "boolean":
      return <input type="checkbox" checked={!!val} onChange={(e) => onChange(e.target.checked)} />;
    default:
      return <Commit value={String(val ?? "")} onCommit={onChange} />;
  }
}

/** Figma-style local variables editor: collections, modes as columns, variables as rows. */
export function VariablesDialog() {
  const doc = useDoc();
  const collections = doc.variables ?? [];
  const [active, setActive] = useState<string | null>(collections[0]?.id ?? null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const coll = collections.find((c) => c.id === active) ?? collections[0];
  const close = () => useStore.setState({ variablesOpen: false });
  useEscape(close);

  const update = (fn: (c: VariableCollection) => VariableCollection) => save(collections.map((c) => (c.id === coll.id ? fn(c) : c)));
  const addCollection = () => {
    const c: VariableCollection = { id: uid("vc_"), name: `Collection ${collections.length + 1}`, modes: [{ id: uid("vm_"), name: "Default" }], variables: [] };
    save([...collections, c]);
    setActive(c.id);
  };
  const addVariable = (type: VarKind) =>
    update((c) => {
      const n = c.variables.filter((v) => v.type === type).length + 1;
      const values = Object.fromEntries(c.modes.map((m) => [m.id, DEFAULTS[type]]));
      return { ...c, variables: [...c.variables, { id: uid("v_"), name: `${type} ${n}`, type, values, description: "" }] };
    });
  const addMode = () =>
    update((c) => {
      const id = uid("vm_");
      const first = c.modes[0]?.id;
      return {
        ...c,
        modes: [...c.modes, { id, name: `Mode ${c.modes.length + 1}` }],
        variables: c.variables.map((v) => ({ ...v, values: { ...v.values, [id]: first ? v.values[first] : DEFAULTS[v.type] } })),
      };
    });
  const setValue = (vid: string, mode: string, val: unknown) =>
    update((c) => ({ ...c, variables: c.variables.map((v) => (v.id === vid ? { ...v, values: { ...v.values, [mode]: val } } : v)) }));

  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal variables-dialog" onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="modal-head">
          <b>Local variables</b>
          <button className="ibtn" title="Close" onClick={close} style={{ marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
        <div className="variables-body">
          <div className="var-collections">
            {collections.map((c) => (
              <button key={c.id} className={"var-coll" + (c.id === coll?.id ? " active" : "")} onClick={() => setActive(c.id)}>
                {c.name}
              </button>
            ))}
            <button className="var-coll muted" onClick={addCollection}>
              <Plus size={12} /> New collection
            </button>
          </div>
          {coll ? (
            <div className="var-table-wrap">
              <div className="row" style={{ marginBottom: 8 }}>
                <Commit value={coll.name} onCommit={(name) => name.trim() && update((c) => ({ ...c, name: name.trim() }))} />
                <button className="ibtn" title="Delete collection" onClick={() => save(collections.filter((c) => c.id !== coll.id))}>
                  <Trash2 size={13} />
                </button>
              </div>
              <table className="var-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    {coll.modes.map((m) => (
                      <th key={m.id}>
                        <div className="row" style={{ gap: 2 }}>
                          <Commit value={m.name} className="textinput head" onCommit={(name) => name.trim() && update((c) => ({ ...c, modes: c.modes.map((x) => (x.id === m.id ? { ...x, name: name.trim() } : x)) }))} />
                          {coll.modes.length > 1 && (
                            <button className="ibtn" title="Delete mode" onClick={() => update((c) => ({ ...c, modes: c.modes.filter((x) => x.id !== m.id) }))}>
                              <X size={11} />
                            </button>
                          )}
                        </div>
                      </th>
                    ))}
                    <th style={{ width: 32 }}>
                      <button className="ibtn" title="Add mode" onClick={addMode}>
                        <Plus size={13} />
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {coll.variables.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          <span className="muted">{KIND_ICON[v.type]}</span>
                          <Commit value={v.name} onCommit={(name) => name.trim() && update((c) => ({ ...c, variables: c.variables.map((x) => (x.id === v.id ? { ...x, name: name.trim() } : x)) }))} />
                        </div>
                      </td>
                      {coll.modes.map((m) => (
                        <td key={m.id}>
                          <ValueCell v={v} mode={m.id} onChange={(val) => setValue(v.id, m.id, val)} />
                        </td>
                      ))}
                      <td>
                        <button className="ibtn" title="Delete variable" onClick={() => update((c) => ({ ...c, variables: c.variables.filter((x) => x.id !== v.id) }))}>
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                className="btn"
                style={{ marginTop: 8 }}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({
                    x: r.left,
                    y: r.bottom + 4,
                    items: (["color", "number", "string", "boolean"] as VarKind[]).map((t) => ({ label: t[0].toUpperCase() + t.slice(1), onClick: () => addVariable(t) })),
                  });
                }}
              >
                <Plus size={13} /> Create variable
              </button>
            </div>
          ) : (
            <div className="var-table-wrap muted">
              Variables are reusable values (colours, sizes, text) with modes such as Light and Dark. Bind them to layer properties from the Design panel; exported code gets CSS variables.
              <div>
                <button className="btn primary" style={{ marginTop: 12 }} onClick={addCollection}>
                  <Plus size={13} /> Create collection
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
