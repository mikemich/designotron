// WebSocket client for the local Designotron bridge (crates/bridge).
// The bridge forwards MCP tool calls from Claude Code to this editor and
// streams Claude Code chat events back.

import { getEngine, onDocChange } from "../store";
import { executeTool } from "./tools";
import { appendText, patchItem, push, useChat } from "./chatState";

function bridgeUrl(): string {
  try {
    const custom = localStorage.getItem("dt:bridgeUrl");
    if (custom) return custom;
  } catch {
    /* ignore */
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  return local ? `${proto}://${location.host}/bridge/ws` : "ws://127.0.0.1:5174/bridge/ws";
}

class BridgeClient {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private docTimer: ReturnType<typeof setTimeout> | null = null;
  private liveText: number | null = null;
  private toolChips = new Map<string, number>();
  /** Set once an error has been shown for the current turn, to avoid repeats. */
  private turnError = false;

  start() {
    this.connect();
    onDocChange(() => this.scheduleDocPush());
  }

  private connect() {
    useChat.setState({ bridgeStatus: "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(bridgeUrl());
    } catch {
      this.offline();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
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
    this.retry = setTimeout(() => this.connect(), 4000);
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
    try {
      this.send({ type: "doc", doc: getEngine().save() });
    } catch {
      /* engine not ready */
    }
  }

  chat(prompt: string, sessionId: string | null) {
    this.liveText = null;
    this.turnError = false;
    this.send({ type: "chat", prompt, sessionId });
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
        break;
      }
      case "chat_event":
        this.onClaudeEvent(m.event);
        break;
      case "chat_done":
        if (m.sessionId) useChat.setState({ sessionId: m.sessionId });
        useChat.setState({ running: false });
        this.liveText = null;
        break;
      case "chat_error":
        // A non-zero exit after an error we already explained adds nothing.
        if (!this.turnError) this.reportError(String(m.message));
        useChat.setState({ running: false });
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
