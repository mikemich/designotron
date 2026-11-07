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
    const firstStatement = BOOTSTRAP_SCRIPT.slice(0, BOOTSTRAP_SCRIPT.indexOf("let seq"));
    for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCIceTransport"]) {
      expect(firstStatement).toContain(k);
    }
  });
});

describe("plugin sandbox token and capture", () => {
  const s = BOOTSTRAP_SCRIPT;

  it("is strict and captures parent, postMessage and addEventListener before any listener", () => {
    expect(s.startsWith('"use strict";')).toBe(true);
    const sendAt = s.indexOf("const send = host.postMessage.bind(host)");
    expect(s.indexOf("const host = window.parent")).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(s.indexOf("RTCPeerConnection"));
    expect(s.indexOf("const listen = window.addEventListener.bind(window)")).toBeGreaterThan(-1);
    expect(sendAt).toBeLessThan(s.indexOf("listen("));
    // No use of the replaceable globals after the capture.
    expect(s.replace("const host = window.parent;", "")).not.toMatch(/\bparent\b|window\.addEventListener\(|\bpostMessage\(/);
  });

  it("keeps the token in the closure only", () => {
    expect(s).toContain("let token = null");
    expect(s).not.toMatch(/window\.\w*token|window\[[^\]]*token|dt\.token|globalThis|document\.\w*token|localStorage|sessionStorage|name\s*=/i);
    // Every message the bootstrap sends carries the token.
    const sends = [...s.matchAll(/send\(\{([^}]*)\}/g)].map((m) => m[1]);
    expect(sends.length).toBeGreaterThanOrEqual(4);
    for (const body of sends) expect(body).toContain("token");
  });

  it("reports navigation and unhandled rejections", () => {
    expect(s).toContain('listen("pagehide", leave)');
    expect(s).toContain('listen("beforeunload", leave)');
    expect(s).toContain("navigating: true");
    expect(s).toContain('listen("unhandledrejection"');
  });

  it("only takes the code from its own parent, once, with a token", () => {
    expect(s).toContain("e.source !== host");
    expect(s).toContain("if (started || typeof m.token");
  });

  it("PLUGIN_SANDBOX grants scripts and nothing else", () => {
    expect(PLUGIN_SANDBOX).toBe("allow-scripts");
    for (const flag of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals", "allow-downloads"]) {
      expect(PLUGIN_SANDBOX).not.toContain(flag);
    }
  });
});
