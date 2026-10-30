// WebSocket client for the local Designotron bridge (crates/bridge).
// The bridge forwards MCP tool calls from Claude Code to this editor and
// streams Claude Code chat events back.

import { getEngine, onDocChange } from "../store";
import { executeTool } from "./tools";
import { appendText, patchItem, push, showScreenshot, useChat } from "./chatState";
import { onPreviewMessage } from "./preview";

const isLocalPage = ["localhost", "127.0.0.1"].includes(location.hostname);
/** A local page whose own server isn't a bridge (e.g. a relay serving the editor). */
let notBridgeHere = false;
let checked: Promise<void> | null = null;

/** Asks this page's own server whether it is (or proxies) a bridge, once per page load.
 *  Anything else (a relay, a static server) means the bridge is at its default address. */
export function bridgeChecked(): Promise<void> {
  if (!isLocalPage) return Promise.resolve();
  checked ??= servedByRelay()
    .then((relay) => {
      if (relay) return null;
      return fetch(`${location.origin}/bridge/status`).then((r) => (r.ok ? r.json() : null));
    })
    .then((j) => {
      notBridgeHere = j?.name !== "designotron-bridge";
    })
    .catch(() => {
      notBridgeHere = true;
    });
  return checked;
}

/** True when this page's server is a relay. Asked first because a relay answers every
 *  /bridge route with a 404 (an error in the console on every page load), while a bridge or
 *  dev server answers /health with the editor page. */
async function servedByRelay(): Promise<boolean> {
  try {
    const r = await fetch(`${location.origin}/health`);
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return false;
    return (await r.json())?.relay === "designotron";
  } catch {
    return false;
  }
}

function bridgeUrl(): string {
  try {
    const custom = localStorage.getItem("dt:bridgeUrl");
    if (custom) return custom;
  } catch {
    /* ignore */
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return isLocalPage && !notBridgeHere ? `${proto}://${location.host}/bridge/ws` : "ws://127.0.0.1:5174/bridge/ws";
}

/** HTTP base of the bridge (same origin when the editor is served by the bridge; call
 *  `bridgeChecked` first). */
export function bridgeHttpBase(): string {
  return bridgeUrl()
    .replace(/^ws/, "http")
    .replace(/\/bridge\/ws$/, "");
}

export interface Attachment {
  name: string;
  /** Base64 without the data: prefix. */
  data: string;
  mediaType: string;
}

class BridgeClient {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private docTimer: ReturnType<typeof setTimeout> | null = null;
  private liveText: number | null = null;
  private toolChips = new Map<string, number>();
  /** Number of the latest chat message, echoed back by the bridge. */
  private turn = 0;
  /** Set once an error has been shown for the current turn, to avoid repeats. */
  private turnError = false;

  /** Reconnect delay; grows while the bridge stays offline (fewer console errors). */
  private delay = 2000;

  start() {
    this.connect();
    onDocChange(() => this.scheduleDocPush());
    // Coming back to the tab (e.g. after installing the bridge) retries at once.
    window.addEventListener("focus", () => {
      if (!this.ws && this.retry) {
        clearTimeout(this.retry);
        this.connect();
      }
    });
  }

  private async connect() {
    useChat.setState({ bridgeStatus: "connecting" });
    await bridgeChecked();
    let ws: WebSocket;
    try {
      ws = new WebSocket(bridgeUrl());
    } catch {
      this.offline();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 2000;
      useChat.setState({ bridgeStatus: "connected" });
      ws.send(JSON.stringify({ type: "hello", client: "designotron-editor" }));
      this.pushDoc();
    };
    ws.onclose = () => this.offline();
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
  }

  private offline() {
    this.ws = null;
    useChat.setState({ bridgeStatus: "offline" });
    if (useChat.getState().running && useChat.getState().mode === "bridge") useChat.setState({ running: false });
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 1.5, 30000);
  }

  /** Sends a message to the bridge if connected. */
  request(msg: unknown) {
    this.send(msg);
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private scheduleDocPush() {
    if (this.docTimer) clearTimeout(this.docTimer);
    this.docTimer = setTimeout(() => this.pushDoc(), 800);
  }

  /** Mirrors the document to the bridge so headless tools and project export see it. */
  pushDoc() {
    // Serialising a big file costs far more than the send; skip it when nobody is listening.
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.send({ type: "doc", doc: getEngine().save() });
    } catch {
      /* engine not ready */
    }
  }

  chat(prompt: string, sessionId: string | null, attachments: Attachment[] = []) {
    this.liveText = null;
    this.turnError = false;
    this.send({ type: "chat", prompt, sessionId, attachments, turn: ++this.turn });
  }

  cancel() {
    this.send({ type: "chat_cancel" });
  }

  private async onMessage(m: any) {
    switch (m.type) {
      case "welcome":
        useChat.setState({ claude: { available: !!m.claude?.available, version: m.claude?.version, workspace: m.workspace } });
        break;
      case "tool_call": {
        const out = await executeTool(m.name, m.input);
        this.send({ type: "tool_result", id: m.id, ok: out.ok, result: out.result, image: out.image ?? null });
        showScreenshot(out);
        break;
      }
      case "chat_event":
        this.onClaudeEvent(m.event);
        break;
      case "chat_done":
        // A late reply from an earlier turn (its process exiting after a newer turn began).
        if (m.turn != null && m.turn !== this.turn) break;
        if (m.sessionId) useChat.setState({ sessionId: m.sessionId });
        useChat.setState({ running: false });
        this.liveText = null;
        break;
      case "chat_error":
        if (m.turn != null && m.turn !== this.turn) break;
        // A non-zero exit after an error we already explained adds nothing.
        if (!this.turnError) this.reportError(String(m.message));
        useChat.setState({ running: false });
        break;
      case "preview":
      case "preview_log":
      case "project_written":
        onPreviewMessage(m);
        break;
      case "log":
        push({ kind: "system", text: m.message });
        break;
    }
  }

  private reportError(raw: string) {
    this.turnError = true;
    push({ kind: "error", text: explainError(raw) });
  }

  /** Renders Claude Code `stream-json` events. */
  private onClaudeEvent(e: any) {
    if (e.type === "system" && e.subtype === "init") {
      if (e.session_id) useChat.setState({ sessionId: e.session_id });
      const mcp = (e.mcp_servers ?? []).find((s: any) => s.name === "designotron");
      if (mcp && mcp.status !== "connected") push({ kind: "error", text: `Designotron MCP server status: ${mcp.status}` });
      return;
    }
    if (e.type === "stream_event") {
      const ev = e.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        if (this.liveText === null) this.liveText = push({ kind: "assistant", text: "" });
        appendText(this.liveText, ev.delta.text);
      }
      if (ev?.type === "message_stop") this.liveText = null;
      return;
    }
    if (e.type === "assistant") {
      for (const block of e.message?.content ?? []) {
        if (block.type === "text" && block.text && isApiError(block.text)) {
          if (this.liveText !== null) useChat.setState((s) => ({ items: s.items.filter((i) => i.id !== this.liveText) }));
          this.liveText = null;
          this.reportError(block.text);
          continue;
        }
        if (block.type === "text" && block.text) {
          // Text already arrived through partial events; only add it when it did not.
          const items = useChat.getState().items;
          const last = items[items.length - 1];
          if (!(last && last.kind === "assistant" && last.text.trim() === block.text.trim())) {
            if (this.liveText !== null) patchItem(this.liveText, { text: block.text });
            else push({ kind: "assistant", text: block.text });
          }
          this.liveText = null;
        }
        if (block.type === "tool_use") {
          const name = String(block.name).replace(/^mcp__designotron__/, "");
          this.toolChips.set(block.id, push({ kind: "tool", name, ok: null, detail: summarizeInput(block.name, block.input) }));
        }
      }
      return;
    }
    if (e.type === "user") {
      for (const block of e.message?.content ?? []) {
        if (block.type === "tool_result") {
          const chip = this.toolChips.get(block.tool_use_id);
          if (chip) patchItem(chip, { ok: !block.is_error });
        }
      }
      return;
    }
    if (e.type === "result") {
      if (e.session_id) useChat.setState({ sessionId: e.session_id });
      if (e.is_error && e.result && !this.turnError) this.reportError(String(e.result));
      const cost = typeof e.total_cost_usd === "number" ? ` · $${e.total_cost_usd.toFixed(3)} API-equivalent` : "";
      push({ kind: "system", text: `Done in ${((e.duration_ms ?? 0) / 1000).toFixed(1)}s${cost}` });
      // The turn is over at its result, even if the CLI process takes a moment to exit.
      useChat.setState({ running: false });
    }
  }
}

function isApiError(text: string): boolean {
  return /^(Failed to authenticate|API Error:)/.test(text.trim()) || /authentication_error|OAuth access token has expired/i.test(text);
}

/** Turns Claude Code failures into an explanation with a fix. */
function explainError(raw: string): string {
  if (/authentication_error|OAuth access token has expired|Re-authenticate|not logged in|run \/login|Invalid API key/i.test(raw)) {
    return "Claude Code needs you to sign in again. In a terminal run `claude`, type /login and finish signing in with your Claude account, then send your message again.";
  }
  if (/rate_limit|usage limit|429/i.test(raw)) {
    return "Your Claude plan's usage limit was reached. Wait for it to reset, or switch to API-key mode in settings.";
  }
  if (/overloaded|529/i.test(raw)) return "Claude is overloaded right now. Try again in a minute.";
  return raw;
}

function summarizeInput(name: string, input: any): string | undefined {
  if (!input) return undefined;
  if (name === "Bash") return input.command;
  if (name === "Write" || name === "Edit" || name === "Read") return input.file_path;
  return undefined;
}

export const bridge = new BridgeClient();
