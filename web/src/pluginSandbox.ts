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
 *  `arguments.callee.caller` or stack-trace hooks.
 *
 *  Developer experience (round 16): the run ends only after the calls the body left in flight have
 *  been answered (plus a short grace for the unhandled-rejection report), so an un-awaited failing
 *  dt.tool isn't lost; errors and failed calls carry the plugin's own line (the wrapper's line
 *  offset is measured at start-up, and a syntax error's position comes from compiling the code once
 *  more as a string timer that throws before evaluating anything); console.* reaches the editor in throttled batches;
 *  and a check start only compiles, so Save can tell the author about a syntax error. A plugin's
 *  Error.prepareStackTrace can only change the text read for a line, which is coerced, cut and
 *  matched against one pattern. */
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
  const con = window.console;
  let send = null;
  let seq = 0;
  let started = false;
  let leaving = false;
  const pending = new Map();
  const listeners = { selectionchange: [] };
  // Console output reaches the editor in batches (see addLog); calls, errors and the end of the run
  // flush it first, so lines keep their order relative to them.
  // fmt:begin
  const plain = (v, depth, seen) => {
    if (v === null) return null;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;
    if (t === "undefined") return "undefined";
    if (t === "function") return "[Function" + (v.name ? " " + v.name : "") + "]";
    if (t === "symbol") return String(v);
    if (t === "bigint") return v + "n";
    if (seen.includes(v)) return "[Circular]";
    if (v instanceof Error) return String(v.name) + ": " + String(v.message);
    if (depth >= 4) return Array.isArray(v) ? "[Array]" : "[Object]";
    seen.push(v);
    let out;
    if (Array.isArray(v)) out = v.slice(0, 100).map((x) => plain(x, depth + 1, seen));
    else {
      out = Object.create(null);
      let n = 0;
      for (const k of Object.keys(v)) {
        if (n++ >= 100) break;
        out[k] = plain(v[k], depth + 1, seen);
      }
    }
    seen.pop();
    return out;
  };
  const one = (v) => {
    try {
      if (typeof v === "string") return v;
      if (v instanceof Error) return String(v.name) + ": " + String(v.message);
      const p = plain(v, 0, []);
      return typeof p === "string" ? p : JSON.stringify(p);
    } catch (e) {
      return "[unprintable]";
    }
  };
  const formatArgs = (args) => {
    const s = args.map(one).join(" ");
    return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
  };
  // fmt:end
  // pos:begin
  const stackPos = (stack) => {
    let s;
    try {
      s = String(stack).slice(0, 20000);
    } catch (e) {
      return null;
    }
    const m = /(?:<anonymous>|Function|eval|@):(\d+):(\d+)/.exec(s);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  // pos:end
  // Lines of the plugin's code: offset is how many lines the wrapper adds in front of it (measured
  // once at start-up, because engines differ), lines how long the code is.
  let offset = null;
  let lines = 0;
  const mapLine = (raw) => {
    if (offset === null) return undefined;
    const l = raw - offset;
    return Number.isInteger(l) && l >= 1 && l <= lines ? l : undefined;
  };
  const here = () => {
    try {
      const pos = stackPos(new Error().stack);
      return pos ? mapLine(pos[0]) : undefined;
    } catch (e) {
      return undefined;
    }
  };
  // The plugin's own line of a failed call, by the error the call's rejection made.
  const callLines = new WeakMap();
  let buf = [];
  let dropped = 0;
  let timer = 0;
  const flushLogs = () => {
    timer = 0;
    if (!send) return;
    const b = buf;
    buf = [];
    for (const l of b) send({ dtPlugin: true, log: l });
    if (dropped) send({ dtPlugin: true, log: ["warn", "(" + dropped + " lines dropped)"] });
    dropped = 0;
  };
  const addLog = (level, args, line) => {
    if (buf.length >= 200) {
      dropped++;
      return;
    }
    buf.push([level, typeof args === "string" ? args : formatArgs(args), line]);
    if (!timer) timer = later(flushLogs, 100);
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = typeof con[level] === "function" ? con[level].bind(con) : null;
    con[level] = (...args) => {
      if (orig) {
        try { orig(...args); } catch (e) {}
      }
      if (buf.length >= 200) dropped++;
      else addLog(level === "debug" ? "log" : level, args, here());
    };
  }
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    const line = here();
    pending.set(id, { resolve, reject, line, label: method === "tool" ? String(args[0]) : method });
    flushLogs();
    send({ dtPlugin: true, id, method, args, line });
  });
  // What an error says, one line, and where in the plugin's code it came from.
  const describe = (err) => {
    let text = "error";
    try { text = (callLines.has(err) ? String(err.message) : err instanceof Error ? String(err.name) + ": " + String(err.message) : String(err)).split("\n")[0].slice(0, 500); } catch (e) {}
    let line;
    let column;
    try {
      line = callLines.get(err);
      if (line === undefined) {
        const pos = stackPos(err && err.stack);
        line = pos ? mapLine(pos[0]) : undefined;
        column = line === undefined ? undefined : pos[1];
      }
    } catch (e) {}
    return [text, line, column];
  };
  // The frame is going away or being replaced: tell the editor while it still can listen.
  const leave = (e) => {
    if (leaving || !send || !e.isTrusted) return;
    leaving = true;
    flushLogs();
    send({ dtPlugin: true, navigating: true });
  };
  listen("pagehide", leave);
  listen("beforeunload", leave);
  listen("unhandledrejection", (e) => {
    if (!send || !e.isTrusted) return;
    const d = describe(e.reason);
    flushLogs();
    send({ dtPlugin: true, method: "warn", args: [d[0]], line: d[1] });
  });
  // Errors thrown later (a click handler, a timer) go to the console; they don't stop the plugin.
  let diagnosing = false;
  listen("error", (e) => {
    if (!send || diagnosing || !e.isTrusted) return;
    let text = "error";
    try { text = String(e.message).replace(/^Uncaught /, "").slice(0, 500); } catch (x) {}
    addLog("error", text, typeof e.lineno === "number" ? mapLine(e.lineno) : undefined);
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
      if (!m.error) return p.resolve(m.result);
      const err = new Error(p.label + " failed" + (p.line ? " (line " + p.line + ")" : "") + ": " + m.error);
      callLines.set(err, p.line);
      p.reject(err);
    }, 0);
  };
  // The plugin's code is wrapped like this; nothing compiles or runs it except run, which only a
  // timer task calls.
  const compile = (code) => new Function("dt", "return (async () => {\n" + code + "\n})()");
  const calibrate = async () => {
    try {
      const pos = stackPos(await compile("return new Error().stack")(window.dt));
      offset = pos ? pos[0] - 1 : null;
    } catch (e) {
      offset = null;
    }
  };
  // Where new Function found a syntax error: it doesn't say, but a string timer's compile error
  // reaches the window's error event with a position. The script starts with a throw, so it is
  // compiled whole (a syntax error anywhere is reported with its position) and then stops before
  // evaluating anything: code that closes the wrapper early can't run. The wrapper there adds two
  // lines; the throw's own error event is on line 1 and is ignored.
  const diagnose = (code) => new Promise((resolve) => {
    let found = null;
    diagnosing = true;
    const h = (e) => {
      if (!e.isTrusted || found) return;
      const l = e.lineno - 2;
      if (Number.isInteger(l) && l >= 1 && l <= lines) found = [l, e.colno];
      e.preventDefault();
    };
    listen("error", h);
    later("throw null;\n(async function(dt){\n" + code + "\n})", 0);
    later(() => {
      unlisten("error", h);
      diagnosing = false;
      resolve(found);
    }, 30);
  });
  // The body finished: wait for the calls it left in flight (their failures are reported as warnings
  // by the unhandledrejection listener, which needs a moment after the reply), then the editor may stop us.
  const settle = () => new Promise((resolve) => {
    const check = () => (pending.size ? later(check, 20) : later(() => (pending.size ? check() : resolve()), 50));
    check();
  });
  const run = async (code, check) => {
    lines = code.split("\n").length;
    await calibrate();
    let fn;
    try {
      fn = compile(code);
    } catch (err) {
      let msg = "invalid code";
      try { msg = String(err.message).slice(0, 500); } catch (x) {}
      const pos = err instanceof SyntaxError ? await diagnose(code) : null;
      if (check) return send({ dtPlugin: true, checked: true, ok: false, message: msg, line: pos ? pos[0] : null, column: pos ? pos[1] : null });
      return call("error", ["SyntaxError: " + msg, pos ? pos[0] : undefined, pos ? pos[1] : undefined]);
    }
    if (check) return send({ dtPlugin: true, checked: true, ok: true });
    try {
      await fn(window.dt);
      await settle();
    } catch (err) {
      return call("error", describe(err));
    }
    return call("done", []);
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
    const check = m.check === true;
    // From a timer task, not from this event: window.event is undefined there, so plugin code can't
    // read the message (or its port) off it. onPort does the same for replies and events.
    later(() => {
      run(code, check).catch(() => {});
    }, 0);
  };
  listen("message", onStart);
})();
`;

/** base64 SHA-256 of `BOOTSTRAP_SCRIPT` (the text between the script tags). */
export const BOOTSTRAP_HASH = "sha256-HrpAuTUyZ6ONF1h+B4vvrgKx6pd4mHwJUHUj/xJemPw=";

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
