// Claude chat state. Two backends:
//  - "bridge": the local Designotron bridge runs the user's own Claude Code
//    CLI (Pro/Max subscription or whatever it is signed in with) and gives
//    it this editor as an MCP server.
//  - "api": direct Messages API calls from the browser with the user's key.

import { create } from "zustand";
import { useStore } from "../store";
import { bridge, type Attachment } from "./bridgeClient";
import { runApiAgent, resetApiConversation } from "./apiAgent";
import { contextLine } from "./tools";

export type ChatItem =
  | { id: number; kind: "user" | "assistant" | "error" | "system"; text: string; images?: string[] }
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
  /** Images waiting to be sent with the next message. */
  pending: PendingImage[];
}

export interface PendingImage {
  id: number;
  name: string;
  /** Full data: URL, used for the thumbnail. */
  url: string;
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
  pending: [],
}));

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
let nextImage = 1;

/** Queues an image (data: URL) for the next message. */
export function attachImage(url: string, name = "image") {
  if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(url)) {
    push({ kind: "error", text: "Only PNG, JPEG, GIF and WebP images can be attached." });
    return;
  }
  if (url.length * 0.75 > MAX_IMAGE_BYTES) {
    push({ kind: "error", text: "That image is larger than 10 MB." });
    return;
  }
  useChat.setState((s) => ({ pending: [...s.pending, { id: nextImage++, name, url }] }));
}

export function removeImage(id: number) {
  useChat.setState((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
}

function toAttachment(p: PendingImage): Attachment {
  const [head, data] = p.url.split(",", 2);
  return { name: p.name, data, mediaType: head.slice(5, head.indexOf(";")) };
}

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

/** Opens the panel and sends a prompt, optionally with images (data: URLs). */
export function askClaude(prompt: string, images: string[] = []) {
  useStore.setState({ chatOpen: true });
  for (const url of images) attachImage(url);
  send(prompt);
}

export async function send(prompt: string) {
  const st = useChat.getState();
  if (st.running || !prompt.trim()) return;
  const attachments = st.pending.map(toAttachment);
  push({ kind: "user", text: prompt, images: st.pending.map((p) => p.url) });
  useChat.setState({ pending: [] });
  const full = `${contextLine()}\n\n${prompt}`;
  if (st.mode === "bridge") {
    if (st.bridgeStatus !== "connected") {
      push({
        kind: "error",
        text: "The Designotron bridge isn't running on this computer. Start it with `npx designotron` (or `./dev.sh` in a checkout), or switch to API-key mode in settings.",
      });
      return;
    }
    if (st.claude && !st.claude.available) {
      push({ kind: "error", text: "The bridge couldn't find the `claude` CLI. Install Claude Code and sign in with your Pro/Max account (`claude` then /login)." });
      return;
    }
    useChat.setState({ running: true });
    bridge.chat(full, st.sessionId, attachments);
    return;
  }
  if (!st.apiKey) {
    push({ kind: "error", text: "Add an Anthropic API key in settings, or use Claude Code mode with your Pro/Max subscription." });
    return;
  }
  useChat.setState({ running: true });
  try {
    await runApiAgent(full, attachments);
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

// Expose chat state on the automation handle (see store.ts).
(globalThis as any).__dt = { ...(globalThis as any).__dt, chat: () => useChat.getState(), send: (p: string) => send(p) };
