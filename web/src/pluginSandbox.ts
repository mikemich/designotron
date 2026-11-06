// The page a plugin runs in. No imports: the hash below is checked against the script text by a
// test (`pluginSandbox.test.ts`), so the two can't drift apart.

/** The only script the frame runs from its own page. It is constant: the plugin's code arrives
 *  by postMessage and runs through `new Function`, so no secret (nonce) exists for the plugin to
 *  find, and `import()` from plugin code is governed by a policy with no host sources.
 *  A frame the plugin creates inside itself inherits the policy, and the only inline script it
 *  can run is this one, which removes WebRTC first and then waits for code that only its own
 *  parent could send. */
export const BOOTSTRAP_SCRIPT = String.raw`
(() => {
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCIceTransport"]) {
    try { delete window[k]; } catch (e) {}
    try { Object.defineProperty(window, k, { value: undefined, configurable: false }); } catch (e) {}
  }
  let seq = 0;
  let started = false;
  const pending = new Map();
  const listeners = { selectionchange: [] };
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ dtPlugin: true, id, method, args }, "*");
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
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || !m.dtHost) return;
    if (typeof m.code === "string") {
      if (started || e.source !== parent) return;
      started = true;
      // Compiled inside the chain so a syntax error is reported like any other plugin error.
      Promise.resolve()
        .then(() => new Function("dt", "return (async () => {\n" + m.code + "\n})()")(window.dt))
        .then(() => call("done", []), (err) => call("error", [String(err && err.stack || err)]));
      return;
    }
    if (m.ping) return parent.postMessage({ dtPlugin: true, pong: true }, "*");
    if (m.event) return (listeners[m.event] || []).forEach((fn) => fn(m.data));
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
})();
`;

/** base64 SHA-256 of `BOOTSTRAP_SCRIPT` (the text between the script tags). */
export const BOOTSTRAP_HASH = "sha256-8ZhB2wWQoHxurQMYp4SPkl/FhYqM08Qx2Luk+/5UMcI=";

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
