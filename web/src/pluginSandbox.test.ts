import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_HASH, BOOTSTRAP_SCRIPT, SANDBOX_CSP, sandboxDocument } from "./pluginSandbox";

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
