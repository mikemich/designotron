// Plugins: user JavaScript run in a sandboxed iframe (opaque origin: no access to the
// editor's DOM, storage or API key). They call the same tool layer Claude uses through
// a small promise API over postMessage. A run is one undo step (see runPlugin). They have no
// network: a CSP in the frame, web addresses and fetching tools refused, and the editor page's
// frame-src (index.html) refuses the frame's navigation to the web. The editor talks to the frame
// over a MessageChannel whose far end only the bootstrap holds (pluginSandbox.ts), so a document
// that replaces the plugin in the frame can't call tools, hear replies or keep the run alive.
// What a run says (console.*, notify, failures, tool warnings) goes to the plugin console (pluginLog.ts).

import { create } from "zustand";
import { selection, toast, useStore } from "./store";
import { DRAG_BUSY, executeTool, whenCanvasIdle } from "./ai/tools";
import { PLUGIN_SANDBOX, sandboxDocument } from "./pluginSandbox";
import { WEB_ADDRESS_REFUSAL, hasWebAddress } from "./pluginPolicy";
import { asLevel, asLine, logFlush, logPush, logStart, usePluginLog } from "./pluginLog";
import { userName } from "./canvas/Comments";

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

/** Tools a plugin may not call: they reach the network, render remote content or install code. */
const PLUGIN_REFUSED_TOOLS = new Set(["import_url", "import_html", "save_plugin", "search_photos", "place_photo"]);

let runSeq = 0;

/** Runs a plugin; it stays alive while it shows UI. The whole run is one undo step: its tool
 *  calls share an undo group (`dt.commitUndo()` starts a new one, as in Figma). While a UI is
 *  showing, a pause of a second between calls also starts a new one, so each click is a step. */
export function runPlugin(plugin: Plugin) {
  stopPlugin();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", PLUGIN_SANDBOX);
  frame.referrerPolicy = "no-referrer";
  frame.className = "plugin-frame hidden";
  frame.title = plugin.name;
  const running: Running = { plugin, frame, ui: null };
  logStart();
  usePlugins.setState({ running });
  const runId = ++runSeq;
  let step = 0;
  let lastCall = 0;
  // The channel to the frame: one end goes to the bootstrap with the code, this end is ours. Only
  // what arrives on `port` is a plugin message, and only the bootstrap holds the other end, so a
  // document that replaces the plugin in the frame (document.open(), a navigation) can neither send
  // to us nor receive from us.
  const channel = new MessageChannel();
  const port = channel.port1;
  // Cut by code point (never in the middle of a pair) and with control characters out of the name.
  const author = Array.from(`${userName() || "You"} via ${plugin.name}`.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " "))
    .slice(0, 80)
    .join("");
  // Once the frame navigated or the run stopped, nothing more is posted.
  let navigated = false;
  const post = (msg: object) => {
    if (!navigated && usePlugins.getState().running?.frame === frame) port.postMessage(msg);
  };
  const reply = (id: number, result?: unknown, error?: string) => post({ id, result: result ?? null, error: error ?? null });
  const navigatedAway = () => {
    if (navigated) return;
    navigated = true;
    toast(`Plugin “${plugin.name}” was stopped: it tried to navigate its frame`, "error");
    stopPlugin();
  };
  const onMessage = async (e: MessageEvent) => {
    const m = e.data;
    if (m?.dtPlugin !== true) return;
    lastPong = Date.now();
    if (m.navigating) return navigatedAway();
    if (m.log !== undefined) {
      // A console line: [level, text, line]. No id, no reply. Whatever the frame sends is cut and checked.
      const l = Array.isArray(m.log) ? m.log : [];
      logPush(asLevel(l[0]), String(l[1] ?? "").slice(0, 2100), asLine(l[2]));
      return;
    }
    if (m.pong) {
      if (usePlugins.getState().running?.stuck) usePlugins.setState({ running: { ...running, stuck: false } });
      return;
    }
    try {
      switch (m.method) {
        case "tool": {
          const [name, raw] = m.args;
          if (PLUGIN_REFUSED_TOOLS.has(String(name))) throw new Error(`plugins can't use ${name}`);
          // What arrives is a structured clone, which keeps things JSON would turn into something
          // else (a `new String("https://…")`, whose entries are single characters). The checks and
          // the engine both see this plain-JSON copy, never the clone.
          let input: unknown;
          try {
            input = JSON.parse(JSON.stringify(raw ?? {}));
          } catch {
            throw new Error("tool input must be plain JSON");
          }
          if (hasWebAddress(input)) throw new Error(WEB_ADDRESS_REFUSAL);
          // The pause is measured from the previous call, before waiting for the canvas.
          if (running.ui && lastCall && Date.now() - lastCall > 1000) step++;
          if (!(await whenCanvasIdle())) throw new Error(DRAG_BUSY);
          if (usePlugins.getState().running?.frame !== frame) throw new Error("plugin stopped");
          const out = await executeTool(String(name), input, { group: `plugin:${runId}:${step}`, author });
          lastCall = Date.now();
          if (!out.ok) throw new Error(String(out.result));
          // Warnings come back to the plugin, and the author sees them in the console too.
          const warnings = (out.result as { warnings?: unknown } | null)?.warnings;
          if (Array.isArray(warnings)) for (const w of warnings.slice(0, 20)) logPush("tool", `${String(name)}: ${String(w)}`, asLine(m.line));
          return reply(m.id, out.result);
        }
        case "selection": {
          const ids = selection();
          if (!ids.length) return reply(m.id, []);
          const out = await executeTool("get_nodes", { ids });
          return reply(m.id, (out.result as any)?.nodes ?? out.result);
        }
        case "notify":
          logPush("notify", String(m.args[0]), asLine(m.line));
          toast(String(m.args[0]));
          return reply(m.id);
        case "showUi":
          running.ui = { width: Math.min(640, m.args[0]?.width ?? 300), height: Math.min(720, m.args[0]?.height ?? 240) };
          frame.className = "plugin-frame";
          frame.style.width = `${running.ui.width}px`;
          frame.style.height = `${running.ui.height}px`;
          usePlugins.setState({ running: { ...running } });
          return reply(m.id);
        case "commitUndo":
          step++;
          return reply(m.id);
        case "done":
          if (!running.ui) {
            logPush("info", "Done");
            stopPlugin();
          }
          return reply(m.id);
        case "error": {
          const text = String(m.args[0]).split("\n")[0].slice(0, 500);
          const line = asLine(m.args[1]);
          logPush("error", text, line);
          toast(`Plugin “${plugin.name}” failed${line ? ` at line ${line}` : ""}: ${text}`, "error");
          stopPlugin();
          return;
        }
        case "warn": {
          // An un-awaited dt.tool() that failed: nothing else would show it.
          const text = String(m.args[0]).split("\n")[0].slice(0, 500);
          logPush("error", text, asLine(m.line));
          toast(`Plugin “${plugin.name}”: ${text}`, "error");
          return;
        }
        case "close":
          logPush("info", "Closed");
          stopPlugin();
          return;
      }
      throw new Error(`unknown plugin call ${m.method}`);
    } catch (err) {
      reply(m.id, null, String(err instanceof Error ? err.message : err));
    }
  };
  port.onmessage = onMessage;
  // Watchdog: a plugin that stops answering is flagged so the person can stop it.
  let lastPong = Date.now();
  const watchdog = setInterval(() => {
    post({ ping: true });
    const cur = usePlugins.getState().running;
    if (cur?.frame === frame && !cur.stuck && Date.now() - lastPong > 6000) {
      usePlugins.setState({ running: { ...cur, stuck: true } });
    }
  }, 2000);
  // A plugin still busy after a few seconds shows that it is running (with Stop).
  const slow = setTimeout(() => {
    if (!running.ui) usePlugins.setState({ running: { ...running, slow: true } });
  }, 3000);
  // The frame loads once. A second load means the plugin navigated it (location, meta refresh):
  // that would escape the policy above, so the run stops.
  let loads = 0;
  frame.addEventListener("load", () => {
    if (loads++ === 0) {
      // The page is constant (see pluginSandbox.ts); the code is sent in once it is ready.
      frame.contentWindow?.postMessage({ dtHost: true, code: plugin.code }, "*", [channel.port2]);
    } else {
      navigatedAway();
    }
  });
  const unsub = useStore.subscribe((s, prev) => {
    if (s.es.selection !== prev.es.selection) post({ event: "selectionchange", data: s.es.selection });
  });
  cleanup = () => {
    clearTimeout(slow);
    clearInterval(watchdog);
    port.close();
    unsub();
    frame.remove();
  };
  frame.srcdoc = sandboxDocument();
  document.body.appendChild(frame);
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
}, plugin: () => usePlugins.getState().running?.plugin.id ?? null, pluginLog: () => (logFlush(), usePluginLog.getState().entries) };

export type CheckResult = { ok: true } | { ok: false; message: string; line?: number; column?: number };

/** Whether a plugin's code compiles, without running it. The frame (same page, sandbox and CSP as a
 *  run) compiles it and answers over its own channel: that channel carries nothing but the
 *  answer (the editor never replies on it, so the frame has no tools), and the frame is removed
 *  whatever happens. A frame that doesn't answer within 2 seconds is replaced by a plain compile in
 *  the editor, which can't say where the error is. */
export function checkPluginCode(code: string): Promise<CheckResult> {
  if (!code.trim()) return Promise.resolve({ ok: false, message: "The plugin has no code." });
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", PLUGIN_SANDBOX);
    frame.referrerPolicy = "no-referrer";
    frame.className = "plugin-frame hidden";
    frame.title = "Plugin check";
    const channel = new MessageChannel();
    let timer = 0;
    let done = false;
    const finish = (r: CheckResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.port1.close();
      frame.remove();
      resolve(r);
    };
    channel.port1.onmessage = (e) => {
      const m = e.data;
      if (m?.dtPlugin !== true || m.checked !== true) return;
      if (m.ok === true) return finish({ ok: true });
      finish({ ok: false, message: String(m.message ?? "invalid code").slice(0, 500), line: asLine(m.line), column: asLine(m.column) });
    };
    timer = window.setTimeout(() => {
      try {
        new Function("dt", "return (async () => {\n" + code + "\n})()");
        finish({ ok: true });
      } catch (err) {
        finish({ ok: false, message: String(err instanceof Error ? err.message : err).slice(0, 500) });
      }
    }, 2000);
    frame.addEventListener("load", () => frame.contentWindow?.postMessage({ dtHost: true, check: true, code }, "*", [channel.port2]));
    frame.srcdoc = sandboxDocument();
    document.body.appendChild(frame);
  });
}
