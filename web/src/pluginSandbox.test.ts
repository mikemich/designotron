import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_HASH, BOOTSTRAP_SCRIPT, PLUGIN_SANDBOX, SANDBOX_CSP, sandboxDocument } from "./pluginSandbox";

describe("plugin sandbox page", () => {
  it("the CSP hash is the hash of the bootstrap script text", () => {
    const hash = "sha256-" + createHash("sha256").update(BOOTSTRAP_SCRIPT).digest("base64");
    expect(BOOTSTRAP_HASH).toBe(hash);
    expect(SANDBOX_CSP).toContain(`'${hash}'`);
    // The page embeds the script text exactly.
    expect(sandboxDocument()).toContain(`<script>${BOOTSTRAP_SCRIPT}</script>`);
  });

  it("allows no host sources and no inline script", () => {
    const script = SANDBOX_CSP.split(";").find((d) => d.trim().startsWith("script-src"))!;
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toMatch(/https?:|\*|nonce-/);
  });

  it("removes WebRTC before anything else", () => {
    const firstStatement = BOOTSTRAP_SCRIPT.slice(0, BOOTSTRAP_SCRIPT.indexOf("let send"));
    for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCIceTransport"]) {
      expect(firstStatement).toContain(k);
    }
  });
});

describe("plugin sandbox channel and capture", () => {
  const s = BOOTSTRAP_SCRIPT;

  it("is strict and captures what it needs before any listener or plugin code", () => {
    expect(s.startsWith('"use strict";')).toBe(true);
    expect(s.indexOf("const host = window.parent")).toBeGreaterThan(s.indexOf("RTCPeerConnection"));
    for (const captured of [
      "const listen = window.addEventListener.bind(window)",
      "const later = window.setTimeout.bind(window)",
      'getOwnPropertyDescriptor(MessageEvent.prototype, "data").get',
      'getOwnPropertyDescriptor(MessageEvent.prototype, "ports").get',
    ]) {
      expect(s).toContain(captured);
      expect(s.indexOf(captured)).toBeLessThan(s.indexOf('listen("pagehide"'));
    }
    // After the capture the replaceable globals are not used to send anything.
    expect(s.replace("const host = window.parent;", "")).not.toMatch(/\bparent\b|window\.addEventListener\(|\bpostMessage\(/);
    expect(s).not.toMatch(/globalThis|localStorage|sessionStorage/i);
  });

  it("talks to the editor only over the transferred port", () => {
    // The only window listener takes the code message; it is removed once the port is taken.
    expect([...s.matchAll(/\blisten\("message"/g)].length).toBe(1);
    expect(s).toContain('unlisten("message", onStart)');
    expect(s).toContain("eventPorts.call(e)[0]");
    expect(s).toContain("const post = port.postMessage.bind(port)");
    expect(s).toContain('port.addEventListener("message", onPort)');
    expect(s).toContain("send = (msg) => post(msg)");
    // No secret in the page, no other way out.
    expect(s).not.toMatch(/host\.postMessage|window\.postMessage|\btoken\b/);
    const sends = [...s.matchAll(/send\(\{([^}]*)\}/g)].map((m) => m[1]);
    expect(sends.length).toBeGreaterThanOrEqual(4);
    for (const body of sends) expect(body).toContain("dtPlugin: true");
  });

  it("starts the plugin from a timer task, never from the message event", () => {
    const start = s.slice(s.indexOf("const onStart"));
    const timerAt = start.indexOf("later(() => {");
    expect(timerAt).toBeGreaterThan(-1);
    // The code is compiled and run only inside the timer callback.
    expect(start.indexOf("new Function")).toBeGreaterThan(timerAt);
    expect(start.indexOf("}, 0);")).toBeGreaterThan(start.indexOf("new Function"));
    // Inside the callback nothing refers to the event, the message or the port.
    const callback = start.slice(timerAt, start.indexOf("}, 0);"));
    expect(callback).not.toMatch(/\bm\b|\be\b|port/);
  });

  it("reports navigation and unhandled rejections, trusted events only", () => {
    expect(s).toContain('listen("pagehide", leave)');
    expect(s).toContain('listen("beforeunload", leave)');
    expect(s).toContain("navigating: true");
    expect(s).toContain('listen("unhandledrejection"');
    expect(s.match(/!e\.isTrusted/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("only takes the code from its own parent, once", () => {
    expect(s).toContain("e.source !== host");
    expect(s).toContain("if (started ||");
  });

  it("PLUGIN_SANDBOX grants scripts and nothing else", () => {
    expect(PLUGIN_SANDBOX).toBe("allow-scripts");
    for (const flag of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals", "allow-downloads"]) {
      expect(PLUGIN_SANDBOX).not.toContain(flag);
    }
  });
});
