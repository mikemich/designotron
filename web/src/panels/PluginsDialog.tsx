import { useState } from "react";
import { Play, Plus, Sparkles, Trash2, X } from "lucide-react";
import { deletePlugin, runPlugin, savePlugin, usePlugins, type Plugin } from "../plugins";
import { askClaude } from "../ai/chatState";

const TEMPLATE = `// Plugins use the same tools as Claude: await dt.tool(name, input).
// dt.selection(), dt.getDocument(), dt.getNodes(ids), dt.notify(text),
// dt.ui.show(html, { width, height }) for a panel, dt.close() when done.
const nodes = await dt.selection();
dt.notify(\`\${nodes.length} layer(s) selected\`);
`;

/** Plugins → Manage: run, write, edit and delete plugins. */
export function PluginsDialog() {
  const list = usePlugins((s) => s.list);
  const [editing, setEditing] = useState<Plugin | null>(null);
  const close = () => usePlugins.setState({ dialogOpen: false });
  const run = (p: Plugin) => {
    close();
    runPlugin(p);
  };
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal plugins-dialog" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{editing ? (editing.builtin ? editing.name : "Edit plugin") : "Plugins"}</b>
          <button className="ibtn" title="Close" onClick={close} style={{ marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
        {editing ? (
          <div className="plugin-editor">
            <input className="textinput" placeholder="Name" value={editing.name} disabled={editing.builtin} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <input
              className="textinput"
              placeholder="What it does"
              value={editing.description}
              disabled={editing.builtin}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
            <textarea className="textinput code" spellCheck={false} value={editing.code} readOnly={editing.builtin} onChange={(e) => setEditing({ ...editing, code: e.target.value })} />
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn" onClick={() => setEditing(null)}>
                Back
              </button>
              <div className="row">
                {!editing.builtin && (
                  <button className="btn" onClick={() => (savePlugin(editing), setEditing(null))} disabled={!editing.name.trim()}>
                    Save
                  </button>
                )}
                <button
                  className="btn primary"
                  onClick={() => {
                    if (!editing.builtin) savePlugin(editing);
                    run(editing);
                  }}
                >
                  <Play size={13} /> Run
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="plugin-list">
            {list.map((p) => (
              <div key={p.id} className="plugin-row">
                <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setEditing(p)}>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="muted small">{p.description || (p.builtin ? "Built in" : "")}</div>
                </div>
                <button className="ibtn" title="Run" onClick={() => run(p)}>
                  <Play size={13} />
                </button>
                {!p.builtin && (
                  <button className="ibtn" title="Delete" onClick={() => deletePlugin(p.id)}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => setEditing({ id: "p_" + Date.now().toString(36), name: "", description: "", code: TEMPLATE })}>
                <Plus size={13} /> New plugin
              </button>
              <button
                className="btn"
                onClick={() => {
                  close();
                  askClaude("Write a Designotron plugin that ");
                }}
                title="Describe a plugin and Claude writes it with save_plugin"
              >
                <Sparkles size={13} /> Write one with Claude
              </button>
            </div>
            <div className="muted small" style={{ marginTop: 10, lineHeight: 1.6 }}>
              Plugins run in a sandbox with no access to your files or keys, and call the same tools Claude uses. Each run is one undo step.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Title bar for a plugin that shows UI (the sandboxed iframe sits right below it). */
export function PluginWindow() {
  const running = usePlugins((s) => s.running);
  if (!running?.ui) return null;
  return (
    <div className="plugin-header" style={{ width: running.ui.width }}>
      <span>{running.plugin.name}</span>
      <button className="ibtn" title="Close plugin" onClick={() => import("../plugins").then((m) => m.stopPlugin())}>
        <X size={13} />
      </button>
    </div>
  );
}
