// Plugins: user JavaScript run in a sandboxed iframe (opaque origin: no access to the
// editor's DOM, storage or API key). They call the same tool layer Claude uses through
// a small promise API over postMessage. One plugin run is one undo step.

import { create } from "zustand";
import { dispatch, selection, toast, useStore } from "./store";
import { executeTool } from "./ai/tools";

export interface Plugin {
  id: string;
  name: string;
  description: string;
  code: string;
  builtin?: boolean;
}

const KEY = "dt:plugins";

export const BUILTIN_PLUGINS: Plugin[] = [
  {
    id: "builtin-lorem",
    name: "Fill text with placeholder copy",
    description: "Replaces the selected text layers with lorem ipsum of a similar length.",
    builtin: true,
    code: `const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation".split(" ");
const nodes = await dt.selection();
const texts = nodes.filter((n) => n.type === "text");
if (!texts.length) return dt.notify("Select one or more text layers first.");
await dt.tool("update_nodes", { updates: texts.map((n) => {
  const len = Math.max(2, ((n.text && n.text.characters) || "").split(/\\s+/).length);
  const out = Array.from({ length: len }, (_, i) => words[(i * 7 + n.id.length) % words.length]).join(" ");
  return { id: n.id, text: out[0].toUpperCase() + out.slice(1) };
}) });
dt.notify(\`Filled \${texts.length} text layer\${texts.length === 1 ? "" : "s"}\`);`,
  },
  {
    id: "builtin-palette",
    name: "Random harmonious colours",
    description: "Gives the selected shapes fills from a random harmonious palette.",
    builtin: true,
    code: `const nodes = (await dt.selection()).filter((n) => n.type !== "text" && n.type !== "group");
if (!nodes.length) return dt.notify("Select some shapes or frames first.");
const base = Math.random() * 360;
const hsl = (h, s, l) => {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("");
};
await dt.tool("update_nodes", { updates: nodes.map((n, i) => ({ id: n.id, fill: hsl((base + i * 37) % 360, 70, 62) })) });
dt.notify("Recoloured " + nodes.length + " layers");`,
  },
  {
    id: "builtin-rename",
    name: "Rename layers",
    description: "Renames the selection to a numbered sequence (shows a small UI).",
    builtin: true,
    code: `dt.ui.show(\`
  <style>body{font:13px system-ui;margin:12px;color:#e6e6e6;background:#2c2c2c}input,button{font:inherit;padding:6px 8px;border-radius:6px;border:1px solid #444;background:#383838;color:inherit}button{background:#7c5cff;border:0;color:#fff;margin-top:8px;width:100%}</style>
  <label>Name<br><input id="name" value="Item" style="width:100%"></label>
  <button id="go">Rename selection</button>\`, { width: 240, height: 130 });
document.getElementById("go").onclick = async () => {
  const nodes = await dt.selection();
  const name = document.getElementById("name").value || "Item";
  await dt.tool("update_nodes", { updates: nodes.map((n, i) => ({ id: n.id, name: nodes.length > 1 ? name + " " + (i + 1) : name })) });
  dt.notify("Renamed " + nodes.length + " layers");
  dt.close();
};`,
  },
];

export function loadPlugins(): Plugin[] {
  try {
    return [...BUILTIN_PLUGINS, ...(JSON.parse(localStorage.getItem(KEY) ?? "[]") as Plugin[])];
  } catch {
    return [...BUILTIN_PLUGINS];
  }
}

export function savePlugin(p: Plugin) {
  const mine = loadPlugins().filter((x) => !x.builtin && x.id !== p.id);
  try {
    localStorage.setItem(KEY, JSON.stringify([...mine, { ...p, builtin: undefined }]));
  } catch {
    /* storage unavailable */
  }
  usePlugins.setState({ list: loadPlugins() });
}

export function deletePlugin(id: string) {
  const mine = loadPlugins().filter((x) => !x.builtin && x.id !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(mine));
  } catch {
    /* storage unavailable */
  }
  usePlugins.setState({ list: loadPlugins() });
}

interface Running {
  plugin: Plugin;
  frame: HTMLIFrameElement;
  ui: { width: number; height: number } | null;
  /** Still running after a few seconds without showing UI. */
  slow?: boolean;
  /** Stopped answering (e.g. stuck in a loop): only Stop helps. */
  stuck?: boolean;
}

export const usePlugins = create<{ list: Plugin[]; running: Running | null; dialogOpen: boolean }>(() => ({
  list: loadPlugins(),
  running: null,
  dialogOpen: false,
}));

/** Bootstrap inside the sandbox: defines `dt`, then runs the plugin body as an async function. */
function bootstrap(code: string): string {
  const body = JSON.stringify(code);
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
(() => {
  let seq = 0;
  const pending = new Map();
  const listeners = { selectionchange: [] };
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ dtPlugin: true, id, method, args }, "*");
  });
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || !m.dtHost) return;
    if (m.ping) return parent.postMessage({ dtPlugin: true, pong: true }, "*");
    if (m.event) return (listeners[m.event] || []).forEach((fn) => fn(m.data));
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  window.dt = {
    tool: (name, input) => call("tool", [name, input || {}]),
    selection: () => call("selection", []),
    getDocument: (depth) => call("tool", ["get_document", { depth: depth || 2 }]),
    getNodes: (ids) => call("tool", ["get_nodes", { ids }]),
    notify: (text) => call("notify", [String(text)]),
    close: () => call("close", []),
    on: (event, fn) => (listeners[event] || (listeners[event] = [])).push(fn),
    ui: { show: (html, size) => { document.body.innerHTML = html; return call("showUi", [size || {}]); } },
  };
  // Compiled inside the chain so a syntax error is reported like any other plugin error.
  Promise.resolve()
    .then(() => new Function("dt", "return (async () => {\\n" + ${body} + "\\n})()")(window.dt))
    .then(() => call("done", []), (err) => call("error", [String(err && err.stack || err)]));
})();
<\/script></body></html>`;
}

/** Runs a plugin. Its edits form one undo step; it stays alive while it shows UI. */
export function runPlugin(plugin: Plugin) {
  stopPlugin();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.className = "plugin-frame hidden";
  frame.title = plugin.name;
  const running: Running = { plugin, frame, ui: null };
  usePlugins.setState({ running });
  dispatch({ op: "beginGesture" });
  let gestureOpen = true;
  const endGesture = () => {
    if (gestureOpen) dispatch({ op: "endGesture" });
    gestureOpen = false;
  };
  const reply = (id: number, result?: unknown, error?: string) =>
    frame.contentWindow?.postMessage({ dtHost: true, id, result: result ?? null, error: error ?? null }, "*");
  const onMessage = async (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m?.dtPlugin) return;
    lastPong = Date.now();
    if (m.pong) {
      if (usePlugins.getState().running?.stuck) usePlugins.setState({ running: { ...running, stuck: false } });
      return;
    }
    try {
      switch (m.method) {
        case "tool": {
          const [name, input] = m.args;
          const out = await executeTool(String(name), input);
          if (!out.ok) throw new Error(String(out.result));
          return reply(m.id, out.result);
        }
        case "selection": {
          const ids = selection();
          if (!ids.length) return reply(m.id, []);
          const out = await executeTool("get_nodes", { ids });
          return reply(m.id, (out.result as any)?.nodes ?? out.result);
        }
        case "notify":
          toast(m.args[0]);
          return reply(m.id);
        case "showUi":
          running.ui = { width: Math.min(640, m.args[0]?.width ?? 300), height: Math.min(720, m.args[0]?.height ?? 240) };
          frame.className = "plugin-frame";
          frame.style.width = `${running.ui.width}px`;
          frame.style.height = `${running.ui.height}px`;
          // Edits made from a plugin UI are undone together per run of the UI.
          endGesture();
          usePlugins.setState({ running: { ...running } });
          return reply(m.id);
        case "done":
          if (!running.ui) stopPlugin();
          else endGesture();
          return reply(m.id);
        case "error":
          toast(`Plugin “${plugin.name}” failed: ${String(m.args[0]).split("\n")[0]}`, "error");
          stopPlugin();
          return;
        case "close":
          stopPlugin();
          return;
      }
      throw new Error(`unknown plugin call ${m.method}`);
    } catch (err) {
      reply(m.id, null, String(err instanceof Error ? err.message : err));
    }
  };
  window.addEventListener("message", onMessage);
  // Watchdog: a plugin that stops answering is flagged so the person can stop it.
  let lastPong = Date.now();
  const watchdog = setInterval(() => {
    frame.contentWindow?.postMessage({ dtHost: true, ping: true }, "*");
    const cur = usePlugins.getState().running;
    if (cur?.frame === frame && !cur.stuck && Date.now() - lastPong > 6000) {
      endGesture();
      usePlugins.setState({ running: { ...cur, stuck: true } });
    }
  }, 2000);
  // A plugin still busy after a few seconds: close its undo step so the person's own edits
  // don't merge into it, and show that it's running (with Stop).
  const slow = setTimeout(() => {
    if (!running.ui) {
      endGesture();
      usePlugins.setState({ running: { ...running, slow: true } });
    }
  }, 3000);
  const unsub = useStore.subscribe((s, prev) => {
    if (s.es.selection !== prev.es.selection) frame.contentWindow?.postMessage({ dtHost: true, event: "selectionchange", data: s.es.selection }, "*");
  });
  cleanup = () => {
    clearTimeout(slow);
    clearInterval(watchdog);
    window.removeEventListener("message", onMessage);
    unsub();
    endGesture();
    frame.remove();
  };
  document.body.appendChild(frame);
  frame.srcdoc = bootstrap(plugin.code);
}

let cleanup: (() => void) | null = null;

export function stopPlugin() {
  cleanup?.();
  cleanup = null;
  usePlugins.setState({ running: null });
}

// Automation handle (see store.ts).
(globalThis as any).__dt = { ...(globalThis as any).__dt, runPlugin: (id: string) => {
  const p = loadPlugins().find((x) => x.id === id);
  if (p) runPlugin(p);
  return !!p;
}, plugin: () => usePlugins.getState().running?.plugin.id ?? null };
