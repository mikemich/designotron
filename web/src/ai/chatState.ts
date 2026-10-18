// Claude chat state. Two backends:
//  - "bridge": the local Designotron bridge runs the user's own Claude Code
//    CLI (Pro/Max subscription or whatever it is signed in with) and gives
//    it this editor as an MCP server.
//  - "api": direct Messages API calls from the browser with the user's key.

import { create } from "zustand";
import { useStore } from "../store";
import { bridge } from "./bridgeClient";
import { runApiAgent, resetApiConversation } from "./apiAgent";
import { contextLine } from "./tools";

export type ChatItem =
  | { id: number; kind: "user" | "assistant" | "error" | "system"; text: string }
  | { id: number; kind: "tool"; name: string; ok: boolean | null; detail?: string };

export type Mode = "bridge" | "api";

interface ChatStore {
  items: ChatItem[];
  running: boolean;
  mode: Mode;
  apiKey: string;
  model: string;
  bridgeStatus: "connecting" | "connected" | "offline";
  claude: { available: boolean; version?: string; workspace?: string } | null;
  sessionId: string | null;
}

const ls = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};

export const MODELS = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { value: "claude-fable-5-1", label: "Claude Fable 5.1" },
];

export const useChat = create<ChatStore>(() => ({
  items: [],
  running: false,
  mode: (ls("dt:chatMode", "bridge") as Mode) || "bridge",
  apiKey: ls("dt:apiKey", ""),
  model: ls("dt:model", "claude-opus-5-5"),
  bridgeStatus: "connecting",
  claude: null,
  sessionId: null,
}));

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let nextId = 1;
export function push(item: DistOmit<ChatItem, "id">): number {
  const id = nextId++;
  useChat.setState((s) => ({ items: [...s.items, { ...item, id } as ChatItem] }));
  return id;
}

export function patchItem(id: number, patch: Record<string, unknown>) {
  useChat.setState((s) => ({ items: s.items.map((i) => (i.id === id ? ({ ...i, ...patch } as ChatItem) : i)) }));
}

export function appendText(id: number, text: string) {
  useChat.setState((s) => ({ items: s.items.map((i) => (i.id === id && "text" in i ? { ...i, text: i.text + text } : i)) }));
}

export function setMode(mode: Mode) {
  try {
    localStorage.setItem("dt:chatMode", mode);
  } catch {
    /* ignore */
  }
  useChat.setState({ mode });
}

export function setApiKey(apiKey: string) {
  try {
    localStorage.setItem("dt:apiKey", apiKey);
  } catch {
    /* ignore */
  }
  useChat.setState({ apiKey });
}

export function setModel(model: string) {
  try {
    localStorage.setItem("dt:model", model);
  } catch {
    /* ignore */
  }
  useChat.setState({ model });
}

export function newConversation() {
  useChat.setState({ items: [], sessionId: null });
  resetApiConversation();
}

/** Opens the panel and sends a prompt. */
export function askClaude(prompt: string) {
  useStore.setState({ chatOpen: true });
  send(prompt);
}

export async function send(prompt: string) {
  const st = useChat.getState();
  if (st.running || !prompt.trim()) return;
  push({ kind: "user", text: prompt });
  const full = `${contextLine()}\n\n${prompt}`;
  if (st.mode === "bridge") {
    if (st.bridgeStatus !== "connected") {
      push({
        kind: "error",
        text: "The Designotron bridge isn't running. Start it with `cargo run -p designotron-bridge` (or `npm run dev` from web/), or switch to API-key mode in settings.",
      });
      return;
    }
    if (st.claude && !st.claude.available) {
      push({ kind: "error", text: "The bridge couldn't find the `claude` CLI. Install Claude Code and sign in with your Pro/Max account (`claude` then /login)." });
      return;
    }
    useChat.setState({ running: true });
    bridge.chat(full, st.sessionId);
    return;
  }
  if (!st.apiKey) {
    push({ kind: "error", text: "Add an Anthropic API key in settings, or use Claude Code mode with your Pro/Max subscription." });
    return;
  }
  useChat.setState({ running: true });
  try {
    await runApiAgent(full);
  } catch (err) {
    push({ kind: "error", text: String(err instanceof Error ? err.message : err) });
  } finally {
    useChat.setState({ running: false });
  }
}

export function stop() {
  const st = useChat.getState();
  if (st.mode === "bridge") bridge.cancel();
  else import("./apiAgent").then((m) => m.abortApiAgent());
  useChat.setState({ running: false });
}
