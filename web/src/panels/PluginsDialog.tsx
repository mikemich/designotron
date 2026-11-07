import { useEffect, useRef, useState } from "react";
import { Loader2, Play, Plus, Sparkles, Terminal, Trash2, X } from "lucide-react";
import { checkPluginCode, deletePlugin, runPlugin, savePlugin, usePlugins, type Plugin } from "../plugins";
import { logClear, usePluginLog, type LogEntry } from "../pluginLog";
import { askClaude } from "../ai/chatState";
import { useDialog } from "../ui/controls";
import { pluginDirty } from "./pluginDirty";

const TEMPLATE = `// Plugins use the same tools as Claude: await dt.tool(name, input).
// Everything you can call is listed under "API reference" below the code.
// console.log(...) shows in the console under the code; Ctrl/Cmd+Enter runs.
const nodes = await dt.selection();
dt.notify(\`\${nodes.length} layer(s) selected\`);
`;

const API_ROWS: [string, string][] = [
  ["await dt.tool(name, input)", "Calls any tool Claude uses (create_nodes, update_nodes, find_nodes, arrange, …) and returns its result (create_nodes: { created: [{ id, name, type, w, h }] }; update_nodes: { updated: [ids], warnings? }). A failure throws, with the tool's message and the line of your call. One run is one undo step."],
  ["await dt.selection()", "The selected layers as an array of full nodes (fills, width, height, …)."],
  ["await dt.getDocument(depth = 2)", "A compact overview of the open file (shape below), to the given depth."],
  ["await dt.getNodes(ids)", "An array of full nodes for the ids, with fills, width, height, text, layout and everything else."],
  ["dt.notify(text)", "Shows a message at the bottom of the editor (one at a time) and in the console."],
  ["dt.close()", "Ends the run. A plugin without a panel ends by itself once its code and its calls are done."],
  ["dt.commitUndo()", "Ends the current undo step; the next call starts a new one. From a panel, a pause of 1 s or more between calls also starts a new step."],
  ['dt.on("selectionchange", fn)', "fn(ids) runs when the selection changes (while the plugin is alive, i.e. while its panel is open)."],
  ["dt.ui.show(html, { width, height })", "Shows a panel (at most 640 × 720) from the HTML. Set .onclick from code: inline on*= attributes don't run. The run stays alive until dt.close() or the panel's close button."],
  ["console.log / info / warn / error", "Show in the plugin console. Up to 200 lines per 100 ms; the console keeps the last 500."],
];

const DOC_SHAPE = `{
  document: "File name",
  pages: [{ id, name, current, layers }],
  currentPage: "page id",
  selection: [{ id, type, name }],
  layers: [{                 // the current page, compact
    id, type, name, x, y, w, h,
    fill,                    // first visible solid fill, "#rrggbb"
    text, font,              // text layers
    layout, hidden, componentId, props,
    children: [...],         // to the depth asked
    childCount               // when children are left out
  }],
  components: [{ id, name, width, height, props }],
  colorStyles, textStyles, effectStyles, gridStyles,
  variables: [{ id, name, modes: [...],
    variables: [{ id, name, type, scopes, values: { modeName: value } }] }],
  openComments: 0,
  nextFreeX: 1240            // x to place a new top-level layer beside the page's content
}`;

/** The plugin console: every line the current or last run said. A line with a number can be clicked. */
export function PluginConsole({ onJump, maxHeight }: { onJump?: (line: number) => void; maxHeight?: number }) {
  const entries = usePluginLog((s) => s.entries);
  const dropped = usePluginLog((s) => s.dropped);
  const start = usePluginLog((s) => s.start);
  const running = usePlugins((s) => s.running);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);
  return (
    <div className="plugin-console" aria-label="Plugin console">
      <div className="plugin-console-head">
        <Terminal size={12} /> <b>Console</b>
        {running && <Loader2 size={11} className="spin" aria-label="Running" />}
        <button className="btn small" onClick={logClear} disabled={!entries.length && !dropped} style={{ marginLeft: "auto" }}>
          Clear
        </button>
      </div>
      <div className="plugin-console-body" ref={box} style={maxHeight ? { maxHeight } : undefined} role="log" aria-label="Plugin console output">
        {!entries.length && !dropped && <div className="muted small plugin-console-empty">console.log output, notifications and errors from a run show here.</div>}
        {dropped > 0 && <div className="plugin-log dropped">{dropped} earlier lines dropped</div>}
        {entries.map((e, i) => (
          <LogRow key={i} e={e} start={start} onJump={onJump} />
        ))}
      </div>
    </div>
  );
}

function LogRow({ e, start, onJump }: { e: LogEntry; start: number; onJump?: (line: number) => void }) {
  const secs = Math.max(0, (e.t - start) / 1000);
  return (
    <div className={`plugin-log ${e.level}`}>
      <span className="plugin-log-t">+{secs.toFixed(secs < 10 ? 2 : 1)}s</span>
      <span className="plugin-log-kind">{e.level === "notify" ? "notify" : e.level === "tool" ? "tool" : e.level}</span>
      <span className="plugin-log-text">{e.text}</span>
      {e.line !== undefined &&
        (onJump ? (
          <button className="plugin-log-line" title={`Go to line ${e.line}`} onClick={() => onJump(e.line!)}>
            line {e.line}
          </button>
        ) : (
          <span className="plugin-log-line">line {e.line}</span>
        ))}
    </div>
  );
}

/** Plugins → Manage: run, write, edit and delete plugins. */
export function PluginsDialog() {
  const list = usePlugins((s) => s.list);
  const running = usePlugins((s) => s.running);
  const [editing, setEditing] = useState<Plugin | null>(null);
  const [problem, setProblem] = useState<{ message: string; line?: number; column?: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  // Set when Run was pressed in the editor: a plugin that then shows a panel closes the dialog.
  const launched = useRef(false);
  const close = () => usePlugins.setState({ dialogOpen: false });
  /** What Discard does once the person confirms: leave the dialog (Escape, Close) or go back to the list (Back). */
  const [discard, setDiscard] = useState<"close" | "back" | null>(null);
  // Where to put focus when the view changes: the Name field of a new plugin, the code of an old one,
  // the row that was opened when going back to the list.
  const nameField = useRef<HTMLInputElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const listEl = useRef<HTMLDivElement>(null);
  const want = useRef<"name" | "code" | "row" | null>(null);
  const opened = useRef<string | null>(null);
  const caret = useRef<[number, number]>([0, 0]);
  const saved = editing ? list.find((p) => p.id === editing.id) : undefined;
  const dirty = pluginDirty(editing, saved, TEMPLATE);
  const keepEditing = () => {
    setDiscard(null);
    requestAnimationFrame(() => {
      const ta = area.current;
      if (!ta) return;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(caret.current[0], caret.current[1]);
    });
  };
  const ask = (what: "close" | "back") => {
    const ta = area.current;
    if (ta) caret.current = [ta.selectionStart, ta.selectionEnd];
    setDiscard(what);
  };
  /** Escape or Close: the confirm bar first when there is something to lose. */
  const leave = () => {
    if (discard) return keepEditing();
    if (dirty) return ask("close");
    close();
  };
  const dialogRef = useDialog(leave);
  useEffect(() => {
    if (discard) keepButton.current?.focus();
  }, [discard]);
  useEffect(() => {
    const to = want.current;
    if (!to) return;
    want.current = null;
    if (to === "name") nameField.current?.focus();
    else if (to === "code") area.current?.focus({ preventScroll: true });
    else (listEl.current?.querySelector<HTMLElement>(`[data-plugin-edit="${opened.current}"]`) ?? listEl.current?.querySelector<HTMLElement>("[data-plugin-new]"))?.focus();
  }, [editing === null, editing?.id]);
  const runFromList = (p: Plugin) => {
    close();
    runPlugin(p);
  };
  useEffect(() => {
    if (launched.current && running?.ui) close();
  }, [running?.ui]);

  /** Puts the caret on a line (and column) of the code and scrolls it into view. */
  const jumpTo = (line: number, column = 1) => {
    const ta = area.current;
    if (!ta) return;
    const rows = ta.value.split("\n");
    const at = Math.min(Math.max(line, 1), rows.length);
    let pos = 0;
    for (let i = 0; i < at - 1; i++) pos += rows[i].length + 1;
    pos += Math.min(Math.max(column - 1, 0), rows[at - 1].length);
    ta.focus();
    ta.setSelectionRange(pos, pos);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, (at - 3) * lh);
    if (gutter.current) gutter.current.scrollTop = ta.scrollTop;
  };
  /** Compiles the code in the plugin frame; shows what is wrong, and where, when it isn't valid. */
  const valid = async (p: Plugin): Promise<boolean> => {
    setChecking(true);
    const r = await checkPluginCode(p.code);
    setChecking(false);
    if (r.ok) {
      setProblem(null);
      return true;
    }
    setProblem(r);
    if (r.line) requestAnimationFrame(() => jumpTo(r.line!, r.column));
    else area.current?.focus();
    return false;
  };
  const save = async (p: Plugin) => {
    if (checking || !(await valid(p))) return;
    savePlugin(p);
    opened.current = p.id;
    edit(null);
  };
  const runEditing = async (p: Plugin) => {
    if (checking) return;
    // A built-in is known good; anything else is checked and saved first, as before.
    if (!p.builtin) {
      if (!(await valid(p))) return;
      savePlugin(p);
    }
    launched.current = true;
    runPlugin(p);
  };
  const edit = (p: Plugin | null) => {
    if (p) {
      opened.current = list.some((x) => x.id === p.id) ? p.id : null;
      want.current = list.some((x) => x.id === p.id) ? "code" : "name";
    } else want.current = "row";
    setDiscard(null);
    setEditing(p);
    setProblem(null);
    launched.current = false;
    logClear();
  };
  const lines = (editing?.code ?? "").split("\n").length;
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && !discard && leave()}>
      <div ref={dialogRef} className="modal plugins-dialog" role="dialog" aria-modal="true" aria-label="Plugins" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{editing ? (editing.builtin ? editing.name : "Edit plugin") : "Plugins"}</b>
          <button className="ibtn" title="Close" aria-label="Close" onClick={leave} style={{ marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
        {editing ? (
          <div className="plugin-editor">
            <input ref={nameField} className="textinput" placeholder="Name" aria-label="Name" value={editing.name} disabled={editing.builtin} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <input
              className="textinput"
              placeholder="What it does"
              aria-label="What it does"
              value={editing.description}
              disabled={editing.builtin}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
            <div className={`code-box${problem ? " bad" : ""}`}>
              <div className="code-gutter" ref={gutter} aria-hidden="true">
                {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
              </div>
              <textarea
                ref={area}
                className="textinput code"
                aria-label="Plugin code"
                aria-invalid={!!problem}
                spellCheck={false}
                wrap="off"
                value={editing.code}
                readOnly={editing.builtin}
                onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void runEditing(editing);
                  }
                }}
                onChange={(e) => {
                  setEditing({ ...editing, code: e.target.value });
                  setProblem(null);
                }}
              />
            </div>
            {problem && (
              <div className="plugin-problem" role="alert">
                {problem.line ? (
                  <button className="plugin-log-line" onClick={() => jumpTo(problem.line!, problem.column)}>
                    Line {problem.line}
                    {problem.column ? `, column ${problem.column}` : ""}
                  </button>
                ) : null}
                <span>
                  {problem.line ? ": " : ""}
                  {problem.message.replace(/^SyntaxError: /, "")}
                </span>
              </div>
            )}
            <PluginConsole onJump={(l) => jumpTo(l)} />
            <details className="plugin-api">
              <summary>API reference</summary>
              <div className="plugin-api-body">
                {API_ROWS.map(([sig, text]) => (
                  <div key={sig} className="plugin-api-row">
                    <code>{sig}</code>
                    <span>{text}</span>
                  </div>
                ))}
                <div className="plugin-api-row">
                  <code>What dt.getDocument() returns</code>
                  <span>
                    Layers are compact (fill, w, h); use dt.getNodes(ids) or dt.selection() for full nodes.
                  </span>
                </div>
                <pre className="plugin-api-shape">{DOC_SHAPE}</pre>
                <div className="plugin-api-row">
                  <code>Web addresses</code>
                  <span>
                    Plain text may hold them: text, characters, name, description, span text and comment text. Image sources, links, prototype URLs, SVG content, variable values and the fetching tools (import_url, import_html, search_photos, place_photo) are refused, and so is save_plugin. The frame has no network.
                  </span>
                </div>
                <div className="plugin-api-row">
                  <code>Undo</code>
                  <span>A run is one undo step however long it takes. dt.commitUndo() starts a new one; from a panel, each click after a pause of 1 s or more is its own step.</span>
                </div>
              </div>
            </details>
            {discard && (
              <div className="plugin-discard" role="alertdialog" aria-label="Discard changes?">
                <span>
                  Discard changes{editing.name.trim() ? ` to ${editing.name.trim()}` : ""}?
                </span>
                <button
                  className="btn small"
                  onClick={() => {
                    const what = discard;
                    setDiscard(null);
                    if (what === "close") close();
                    else edit(null);
                  }}
                >
                  Discard
                </button>
                <button ref={keepButton} className="btn primary small" onClick={keepEditing}>
                  Keep editing
                </button>
              </div>
            )}
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn" onClick={() => (dirty ? ask("back") : edit(null))}>
                Back
              </button>
              <div className="row">
                {!editing.builtin && (
                  <button className="btn" onClick={() => void save(editing)} disabled={!editing.name.trim() || checking}>
                    Save
                  </button>
                )}
                <button className="btn primary" onClick={() => void runEditing(editing)} disabled={checking} title="Run (Ctrl/Cmd+Enter)">
                  {checking ? <Loader2 size={13} className="spin" /> : <Play size={13} />} Run
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="plugin-list" ref={listEl}>
            {list.map((p) => (
              <div key={p.id} className="plugin-row">
                {/* The name is the keyboard way in; a click anywhere on the block opens it too. */}
                <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => edit(p)}>
                  <button type="button" className="plugin-row-name" data-plugin-edit={p.id}>
                    <span className="sr-only">Edit </span>
                    {p.name}
                  </button>
                  <div className="muted small">{p.description || (p.builtin ? "Built in" : "")}</div>
                </div>
                <button className="ibtn" title={`Run ${p.name}`} aria-label={`Run ${p.name}`} onClick={() => runFromList(p)}>
                  <Play size={13} />
                </button>
                {!p.builtin && (
                  <button className="ibtn" title={`Delete ${p.name}`} aria-label={`Delete ${p.name}`} onClick={() => deletePlugin(p.id)}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" data-plugin-new="" onClick={() => edit({ id: "p_" + Date.now().toString(36), name: "", description: "", code: TEMPLATE })}>
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
              Plugins run in a sandbox with no access to your files or keys, and call the same tools Claude uses. In Chromium the frame can't make web requests or navigate to the web (web addresses are refused in tool inputs except as plain text); Firefox and Safari haven't been verified, so only run plugins you trust. A run is one undo step, however long it takes; a plugin can start a new step with dt.commitUndo(), and from a plugin's panel each click is its own step. Inline on*= attributes in a plugin's panel HTML don't run; set .onclick from the plugin's code.
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
  const panelOpen = usePluginLog((s) => s.panelOpen);
  if (running && (running.stuck || (running.slow && !running.ui)))
    return (
      <div className="plugin-running" role="status">
        <Loader2 size={13} className="spin" /> {running.stuck ? `“${running.plugin.name}” isn't responding` : `Running “${running.plugin.name}”…`}
        <button className="btn small" onClick={() => import("../plugins").then((m) => m.stopPlugin())}>
          Stop
        </button>
      </div>
    );
  if (!running?.ui) return null;
  return (
    <>
      <div className="plugin-header" style={{ width: running.ui.width }}>
        <span>{running.plugin.name}</span>
        <span style={{ display: "flex", gap: 2 }}>
          <button className={`ibtn${panelOpen ? " active" : ""}`} title="Console" aria-pressed={panelOpen} aria-label="Console" onClick={() => usePluginLog.setState({ panelOpen: !panelOpen })}>
            <Terminal size={13} />
          </button>
          <button className="ibtn" title="Close plugin" onClick={() => import("../plugins").then((m) => m.stopPlugin())}>
            <X size={13} />
          </button>
        </span>
      </div>
      {panelOpen && (
        <div className="plugin-console-float" style={{ width: Math.max(running.ui.width, 300), top: 88 + running.ui.height + 8 }}>
          <PluginConsole maxHeight={180} />
        </div>
      )}
    </>
  );
}
