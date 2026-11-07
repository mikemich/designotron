// The page a plugin runs in. No imports: the hash below is checked against the script text by a
// test (`pluginSandbox.test.ts`), so the two can't drift apart.

/** Flags of the plugin frame. No `allow-same-origin` (opaque origin: no editor DOM, storage or API
 *  key), and no top navigation, popups or forms. */
export const PLUGIN_SANDBOX = "allow-scripts";

/** The only script the frame runs from its own page. It is constant: the plugin's code arrives
 *  by postMessage and runs through `new Function`, so no nonce exists for the plugin to find, and
 *  `import()` from plugin code is governed by a policy with no host sources.
 *  A frame the plugin creates inside itself inherits the policy, and the only inline script it
 *  can run is this one, which removes WebRTC first and then waits for code that only its own
 *  parent could send.
 *
 *  The per-run token arrives with the code and lives only in this closure; every message the
 *  bootstrap sends carries it, and the editor ignores any message without it. A document that
 *  replaces the plugin in this frame (the plugin navigates it) never receives the token, so it can
 *  neither call tools nor keep the run looking alive. `parent`, `postMessage` and `addEventListener`
 *  are captured before plugin code exists, so the plugin can't swap them for spies. The script is
 *  strict, so plugin code (sloppy, from `new Function`) can't reach its callers through
 *  `arguments.callee.caller` or stack-trace hooks. */
export const BOOTSTRAP_SCRIPT = String.raw`"use strict";
(() => {
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCIceTransport"]) {
    try { delete window[k]; } catch (e) {}
    try { Object.defineProperty(window, k, { value: undefined, configurable: false }); } catch (e) {}
  }
  const host = window.parent;
  const send = host.postMessage.bind(host);
  const listen = window.addEventListener.bind(window);
  let token = null;
  let seq = 0;
  let started = false;
  let leaving = false;
  const pending = new Map();
  const listeners = { selectionchange: [] };
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ dtPlugin: true, token, id, method, args }, "*");
  });
  // The frame is going away or being replaced: tell the editor while it still can listen.
  const leave = () => {
    if (leaving || token === null) return;
    leaving = true;
    send({ dtPlugin: true, token, navigating: true }, "*");
  };
  listen("pagehide", leave);
  listen("beforeunload", leave);
  listen("unhandledrejection", (e) => {
    if (token === null) return;
    const r = e.reason;
    send({ dtPlugin: true, token, method: "warn", args: [String(r && r.message || r)] }, "*");
  });
  window.dt = {
    tool: (name, input) => call("tool", [name, input || {}]),
    selection: () => call("selection", []),
    getDocument: (depth) => call("tool", ["get_document", { depth: depth || 2 }]),
    getNodes: (ids) => call("tool", ["get_nodes", { ids }]),
    notify: (text) => call("notify", [String(text)]),
    close: () => call("close", []),
    commitUndo: () => call("commitUndo", []),
    on: (event, fn) => (listeners[event] || (listeners[event] = [])).push(fn),
    ui: { show: (html, size) => { document.body.innerHTML = html; return call("showUi", [size || {}]); } },
  };
  listen("message", (e) => {
    const m = e.data;
    if (!m || !m.dtHost || e.source !== host) return;
    if (typeof m.code === "string") {
      if (started || typeof m.token !== "string" || m.token.length < 16) return;
      started = true;
      token = m.token;
      // Compiled inside the chain so a syntax error is reported like any other plugin error.
      Promise.resolve()
        .then(() => new Function("dt", "return (async () => {\n" + m.code + "\n})()")(window.dt))
        .then(() => call("done", []), (err) => call("error", [String(err && err.stack || err)]));
      return;
    }
    if (!started) return;
    if (m.ping) return send({ dtPlugin: true, token, pong: true }, "*");
    if (m.event) return (listeners[m.event] || []).forEach((fn) => fn(m.data));
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
})();
`;

/** base64 SHA-256 of `BOOTSTRAP_SCRIPT` (the text between the script tags). */
export const BOOTSTRAP_HASH = "sha256-2yK8NAP78SrCvlq9zt9Ce3tuTG9m0Xc6Mr3mYHA+EgI=";

/** Frame policy: nothing loads or connects; images only from data: and blob:; scripts only the
 *  bootstrap (by hash) and eval. No `unsafe-inline`: a plugin's frames can't use `on*=`
 *  attributes or `javascript:` URLs either (set `.onclick` from code). */
export const SANDBOX_CSP = `default-src 'none'; script-src '${BOOTSTRAP_HASH}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'`;

export function sandboxDocument(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">
<meta http-equiv="x-dns-prefetch-control" content="off">
</head><body><script>${BOOTSTRAP_SCRIPT}</script></body></html>`;
}
