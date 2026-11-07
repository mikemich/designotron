// The page a plugin runs in. No imports: the hash below is checked against the script text by a
// test (`pluginSandbox.test.ts`), so the two can't drift apart.

/** Flags of the plugin frame. No `allow-same-origin` (opaque origin: no editor DOM, storage or API
 *  key), and no top navigation, popups or forms. */
export const PLUGIN_SANDBOX = "allow-scripts";

/** The only script the frame runs from its own page. It is constant: the plugin's code arrives
 *  over a MessagePort and runs through `new Function`, so no nonce exists for the plugin to
 *  find, and `import()` from plugin code is governed by a policy with no host sources.
 *  A frame the plugin creates inside itself inherits the policy, and the only inline script it
 *  can run is this one, which removes WebRTC first and then waits for code that only its own
 *  parent could send.
 *
 *  The channel to the editor is a MessageChannel, not window messages. The host sends the code once
 *  by window postMessage and transfers one end of the channel; the bootstrap keeps that port in its
 *  closure and uses only it from then on (calls, pongs, navigation signal on one side; replies,
 *  pings, selection events on the other). So nothing a document that replaces the plugin in this
 *  frame (document.open(), a navigation) can reach carries a secret or a result, and the editor
 *  ignores everything that doesn't arrive on its end of the port. The plugin can't get at the port:
 *  `parent`, `postMessage`, `addEventListener`, the port's `postMessage` and the `data`/`ports`
 *  getters of MessageEvent are captured before plugin code exists, the plugin starts from a timer
 *  task, as does every reply and event after it (so `window.event` is undefined whenever plugin code
 *  runs, and it never sees a message or the port that carried it), and
 *  the script is strict, so the plugin (sloppy, from `new Function`) can't reach its callers through
 *  `arguments.callee.caller` or stack-trace hooks. */
export const BOOTSTRAP_SCRIPT = String.raw`"use strict";
(() => {
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCIceTransport"]) {
    try { delete window[k]; } catch (e) {}
    try { Object.defineProperty(window, k, { value: undefined, configurable: false }); } catch (e) {}
  }
  const host = window.parent;
  const listen = window.addEventListener.bind(window);
  const unlisten = window.removeEventListener.bind(window);
  const later = window.setTimeout.bind(window);
  const eventData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data").get;
  const eventPorts = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "ports").get;
  let send = null;
  let seq = 0;
  let started = false;
  let leaving = false;
  const pending = new Map();
  const listeners = { selectionchange: [] };
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ dtPlugin: true, id, method, args });
  });
  // The frame is going away or being replaced: tell the editor while it still can listen.
  const leave = (e) => {
    if (leaving || !send || !e.isTrusted) return;
    leaving = true;
    send({ dtPlugin: true, navigating: true });
  };
  listen("pagehide", leave);
  listen("beforeunload", leave);
  listen("unhandledrejection", (e) => {
    if (!send || !e.isTrusted) return;
    const r = e.reason;
    send({ dtPlugin: true, method: "warn", args: [String(r && r.message || r)] });
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
  const onPort = (e) => {
    const m = eventData.call(e);
    if (!m) return;
    if (m.ping) return send({ dtPlugin: true, pong: true });
    // Plugin code runs only from timer tasks (timers of one delay fire in order, so replies and
    // events keep their order): while this event is being dispatched, window.event is the
    // port's message, and a continuation that ran now could read the port off it.
    later(() => {
      if (m.event) return (listeners[m.event] || []).forEach((fn) => fn(m.data));
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    }, 0);
  };
  const onStart = (e) => {
    const m = eventData.call(e);
    const port = eventPorts.call(e)[0];
    if (started || !e.isTrusted || e.source !== host || !m || !m.dtHost || typeof m.code !== "string" || !port) return;
    started = true;
    unlisten("message", onStart);
    const post = port.postMessage.bind(port);
    send = (msg) => post(msg);
    port.addEventListener("message", onPort);
    port.start();
    const code = m.code;
    // From a timer task, not from this event: window.event is undefined there, so plugin code can't
    // read the message (or its port) off it. onPort does the same for replies and events. Compiled inside the chain so a syntax error is
    // reported like any other plugin error.
    later(() => {
      Promise.resolve()
        .then(() => new Function("dt", "return (async () => {\n" + code + "\n})()")(window.dt))
        .then(() => call("done", []), (err) => call("error", [String(err && err.stack || err)]));
    }, 0);
  };
  listen("message", onStart);
})();
`;

/** base64 SHA-256 of `BOOTSTRAP_SCRIPT` (the text between the script tags). */
export const BOOTSTRAP_HASH = "sha256-e3dBmEyBOMHYFAauit4eQrQQnNXX/6qd3nicFnX+A3w=";

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
