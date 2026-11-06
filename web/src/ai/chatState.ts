// Claude chat state. Two backends:
//  - "bridge": the local Designotron bridge runs the user's own Claude Code
//    CLI (Pro/Max subscription or whatever it is signed in with) and gives
//    it this editor as an MCP server.
//  - "api": direct Messages API calls from the browser with the user's key.

import { create } from "zustand";
import { getDoc, onDocChange, toast, useStore, zoomToFit } from "../store";
import { useCollab } from "../collab";
import { bridge, type Attachment } from "./bridgeClient";
import { runApiAgent, resetApiConversation, abortApiAgent, hasApiConversation } from "./apiAgent";
import { contextLine, setToolFile } from "./tools";
import { loadConversation, saveConversation, serialize } from "./conversations";

export type ChatItem =
  | {
      id: number;
      kind: "user" | "assistant" | "error" | "system";
      text: string;
      images?: string[];
      title?: string;
      /** An error that a Retry button can send again (the prompt, as typed) and the short label it showed. */
      retry?: string;
      retryLabel?: string;
    }
  | { id: number; kind: "tool"; name: string; ok: boolean | null; detail?: string }
  /** A screenshot Claude took to check its work, shown so you see what it saw. */
  | { id: number; kind: "shot"; url: string; label: string };

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
  /** A prompt asked before Claude was connected; sent as soon as it is. */
  queued: string | null;
  /** The API key has worked at least once. */
  keyChecked: boolean;
  /** The file this conversation belongs to (null while no file is open). */
  chatFile: string | null;
  /** Text Stop (or leaving the file) returned from the queue; the composer takes it. */
  draft: string;
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
  queued: null,
  keyChecked: ls("dt:keyChecked", "") === "1",
  chatFile: null,
  draft: "",
}));

const bridgeReady = (s: ChatStore) => s.bridgeStatus === "connected" && s.claude?.available !== false;

/** Whether a prompt can be sent now, in either mode. */
export function claudeReady(s: ChatStore = useChat.getState()): boolean {
  return s.mode === "bridge" ? bridgeReady(s) : !!s.apiKey;
}

// Send a queued prompt once Claude connects, switching to whichever mode came up.
// Switching modes on its own only happens before the person has picked one (never into
// per-use API billing after they chose Claude Code).
const modeChosen = () => ls("dt:chatMode", "") !== "";

/** A queued prompt that waited this long for a connection is confirmed before it goes out. */
const STALE_QUEUE_MS = 10_000;

/** True while a queued prompt is waiting for the person to confirm sending it (see above). */
export const useQueueConfirm = create<{ stale: boolean }>(() => ({ stale: false }));

/** When the current prompt started waiting for Claude to connect (0: not waiting for that). */
let offlineSince = 0;

useChat.subscribe((s) => {
  if (!s.queued) {
    offlineSince = 0;
    if (useQueueConfirm.getState().stale) useQueueConfirm.setState({ stale: false });
    return;
  }
  if (s.running) return;
  if (!claudeReady(s)) {
    offlineSince ||= Date.now();
    if (!modeChosen() && s.mode === "api" && bridgeReady(s)) useChat.setState({ mode: "bridge" });
    else if (!modeChosen() && s.mode === "bridge" && s.apiKey && s.bridgeStatus === "offline") useChat.setState({ mode: "api" });
    return;
  }
  // Typed while offline and connected much later: the person may have moved on, so ask first.
  if (offlineSince && Date.now() - offlineSince > STALE_QUEUE_MS) {
    if (!useQueueConfirm.getState().stale) useQueueConfirm.setState({ stale: true });
    return;
  }
  const prompt = s.queued;
  useChat.setState({ queued: null });
  send(prompt);
});

/** Sends the queued prompt the person just confirmed. */
export function sendQueued() {
  const prompt = useChat.getState().queued;
  useChat.setState({ queued: null });
  if (prompt) send(prompt);
}

/** Drops the queued prompt. */
export function discardQueued() {
  useChat.setState({ queued: null });
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
let nextImage = 1;

/** Queues an image (data: URL) for the next message. */
/** Shows a screenshot Claude took (get_screenshot) in the chat, during a chat turn. */
export function showScreenshot(out: { result?: unknown; image?: { data: string; mediaType: string } | null }, toolName = "get_screenshot") {
  if (!out.image || !useChat.getState().running) return;
  if (toolName === "search_photos") {
    push({ kind: "shot", url: `data:${out.image.mediaType};base64,${out.image.data}`, label: "Photo results Claude looked at" });
    return;
  }
  const id = (out.result as { nodeId?: string } | undefined)?.nodeId;
  let name = "";
  try {
    name = id ? (getDoc().nodes[id]?.name ?? "") : "";
  } catch {
    /* engine not ready */
  }
  push({ kind: "shot", url: `data:${out.image.mediaType};base64,${out.image.data}`, label: name ? `Claude looked at “${name}”` : "Claude took a screenshot" });
}

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
    localStorage.removeItem("dt:keyChecked");
  } catch {
    /* ignore */
  }
  useChat.setState({ apiKey, keyChecked: false });
}

export function setModel(model: string) {
  try {
    localStorage.setItem("dt:model", model);
  } catch {
    /* ignore */
  }
  useChat.setState({ model });
}

// ---- One conversation per file -------------------------------------------------------------

/** Bumped when a file is entered or left, so a conversation still loading for an earlier file
 *  is dropped instead of landing in the current one. */
let enterToken = 0;
/** The file whose saved conversation has been read (saving earlier would overwrite it). */
let loadedFor: string | null = null;
/** Something changed after the saved conversation was read: only then is anything written. */
let dirty = false;
/** Resolves once the entered file's saved conversation is in place. */
let entering: Promise<void> = Promise.resolve();
/** Files whose conversation came from storage: API mode doesn't have its messages any more. */
const apiLost = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const joinText = (...parts: (string | null | undefined)[]) => parts.filter((p) => p && p.trim()).join("\n\n");

/** A view-only tab (or a viewer) never writes the conversation: the editing tab owns it. */
const readOnlyNow = () => !!useStore.getState().es.readOnly || useCollab.getState().viewer;

/** When the first change since the last write happened (a long streaming turn is still saved
 *  within `MAX_WAIT_MS`, though it keeps changing). */
let pendingSince = 0;
const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 5000;

function scheduleSave() {
  pendingSince ||= Date.now();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), Math.max(0, Math.min(DEBOUNCE_MS, pendingSince + MAX_WAIT_MS - Date.now())));
}

/** Writes the conversation if it changed since it was read or last written. `force`: also when the
 *  tab has just become read-only (what it did until that moment is still its own to save). */
function saveNow(opts: { force?: boolean } = {}) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  pendingSince = 0;
  const s = useChat.getState();
  if (!dirty || !s.chatFile || loadedFor !== s.chatFile || (readOnlyNow() && !opts.force)) return;
  dirty = false;
  const file = s.chatFile;
  void saveConversation(file, serialize(s.items, s.sessionId, s.draft)).then(() => chatCh?.postMessage({ fileId: file }));
}

/** Tells other tabs a conversation was written, so a tab showing the same file (a view-only one,
 *  or the one that takes over) reads it again when it isn't busy itself. */
let chatCh: BroadcastChannel | null = null;
try {
  chatCh = new BroadcastChannel("dt-chat");
  chatCh.onmessage = (ev) => {
    const s = useChat.getState();
    if (ev.data?.fileId && ev.data.fileId === s.chatFile && !dirty && !s.running) reloadConversation();
  };
} catch {
  /* no BroadcastChannel */
}

// A conversation is kept shortly after it changes (and at once when its file closes).
useChat.subscribe((s, prev) => {
  if (!s.chatFile || s.chatFile !== prev.chatFile || loadedFor !== s.chatFile) return;
  if (s.items === prev.items && s.sessionId === prev.sessionId && s.draft === prev.draft) return;
  dirty = true;
  scheduleSave();
});
if (typeof window !== "undefined") window.addEventListener("pagehide", () => saveNow());

// A file deleted (here or in another tab) loses its conversation: don't write it back. If the
// editor keeps the file after all ("Keep it"), this visit's conversation is saved again.
let deletedFile: string | null = null;
try {
  const ch = new BroadcastChannel("dt-files");
  ch.onmessage = (ev) => {
    const file = useChat.getState().chatFile;
    if (!file || ev.data?.fileId !== file) return;
    if (ev.data.deleted) {
      deletedFile = file;
      loadedFor = null;
      dirty = false;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      pendingSince = 0;
    } else if (deletedFile === file && loadedFor === null) {
      deletedFile = null;
      loadedFor = file;
      dirty = true;
      scheduleSave();
    }
  };
} catch {
  /* no BroadcastChannel */
}

/** The unsent text in the composer (the panel registers it), so leaving a file can keep it. */
let composer: (() => string) | null = null;
export function registerComposer(read: (() => string) | null) {
  composer = read;
}

/** Reads this file's saved conversation into the chat. `merge`: what is in the chat already
 *  (a turn started before the read finished) stays after the stored items; otherwise the stored
 *  conversation replaces it. */
function load(id: string, token: number, merge: boolean): Promise<void> {
  loadedFor = null;
  return loadConversation(id).then((rec) => {
    if (token !== enterToken) return;
    const now = useChat.getState();
    if (rec && (merge || !now.running)) {
      // Ids stay unique across files, so a late patch from an old run can't hit another item.
      const base = nextId - 1;
      nextId += rec.nextId - 1;
      const stored = rec.items.map((i) => ({ ...i, id: i.id + base }) as ChatItem);
      useChat.setState({
        items: merge ? [...stored, ...now.items] : stored,
        sessionId: merge ? (now.sessionId ?? rec.sessionId) : rec.sessionId,
        draft: merge ? joinText(rec.draft, now.draft) : rec.draft,
      });
      if (rec.items.length && !hasApiConversation(id)) apiLost.add(id);
    } else if (!rec && !merge && !now.running) {
      // A re-read that finds no record: another tab cleared this conversation (New conversation
      // saves an empty record, which deletes it). Don't keep, and later save back, the old one.
      useChat.setState({ items: [], sessionId: null, draft: "" });
    }
    loadedFor = id;
    // Whatever was added while reading is saved after the stored part.
    dirty = merge && (now.items.length > 0 || !!now.draft);
    if (dirty) scheduleSave();
  });
}

/** The editor opened `id`: its conversation (transcript and Claude Code session) comes back from
 *  storage, or starts empty. Resolves once that is in place. */
export function enterFile(id: string): Promise<void> {
  const token = ++enterToken;
  dirty = false;
  hookRights();
  setToolFile(id);
  useChat.setState({ chatFile: id, items: [], sessionId: null, pending: [], queued: null, running: false, draft: "" });
  // This tab is the one the person works in now: plain MCP calls and the headless file follow it.
  bridge.focusEditor();
  entering = load(id, token, true);
  return entering;
}

/** Reads the open file's conversation again (this tab just became the editing tab: the other one
 *  may have added to it). Not while a turn runs here. */
export function reloadConversation() {
  const s = useChat.getState();
  if (!s.chatFile || s.running || loadedFor !== s.chatFile) return;
  entering = load(s.chatFile, ++enterToken, false);
}

/** Ends the running turn without a note and makes the client forget it (its late events and
 *  tool calls are dropped). */
function dropTurn() {
  const st = useChat.getState();
  if (!st.running) return;
  stoppedToken = turnToken;
  if (st.mode === "bridge") bridge.cancel();
  else abortApiAgent();
  bridge.detach();
  useChat.setState({ running: false });
}

/** The editor closed its file: a running turn stops (it was working on this file), a queued
 *  message goes back to this file's draft, the conversation is saved, and the chat is empty
 *  until the next file opens. */
export function leaveFile() {
  enterToken++;
  const file = useChat.getState().chatFile;
  setToolFile(null);
  if (!file) return;
  if (useChat.getState().running) {
    dropTurn();
    push({ kind: "system", text: "Stopped: you left this file." });
  }
  const st = useChat.getState();
  // Unsent text (a queued message, what was typed in the box) waits in the file's draft.
  const typed = composer?.() ?? "";
  if (joinText(st.draft, st.queued, typed) !== st.draft) dirty = dirty || loadedFor === file;
  useChat.setState({ draft: joinText(st.draft, st.queued, typed), queued: null });
  saveNow();
  loadedFor = null;
  dirty = false;
  useChat.setState({ chatFile: null, items: [], sessionId: null, pending: [], queued: null, running: false, draft: "" });
}

// Losing the right to edit (another tab took the file over) ends a running turn like leaving does;
// getting it back reads the conversation the other tab kept.
let wasReadOnly = false;
const rightsChanged = () => {
  const ro = readOnlyNow();
  if (ro === wasReadOnly) return;
  wasReadOnly = ro;
  if (ro) {
    if (useChat.getState().chatFile && useChat.getState().running) {
      dropTurn();
      push({ kind: "system", text: "Stopped: you can no longer edit this file here." });
    }
    // Everything up to this moment is this tab's to save (the editing tab reads it when it takes
    // over); the tab is read-only already, so the usual guard is skipped.
    saveNow({ force: true });
  } else reloadConversation();
};
let rightsHooked = false;
/** (Not at load: this module and `collab` import each other through `bridgeClient`, a cycle that is
 *  safe only while each is used at run time, not while loading; `useCollab` doesn't exist yet then.)
 *  Losing the right to edit stops the turn here even when the hand-off was refused elsewhere
 *  ("Edit here anyway" can force it), because from then on this tab's calls would be refused. */
function hookRights() {
  if (rightsHooked) return;
  rightsHooked = true;
  useStore.subscribe(rightsChanged);
  useCollab.subscribe(rightsChanged);
}

/** Starts a fresh conversation in this file: the running turn (if any) stops, the saved record
 *  and Claude Code session are forgotten. */
export function newConversation() {
  const file = useChat.getState().chatFile;
  dropTurn();
  useChat.setState({ items: [], sessionId: null, queued: null, draft: "" });
  resetApiConversation(file);
  if (file) apiLost.delete(file);
}

/** The labels of prompts that were queued, so they show short when they finally go out. */
const labels = new Map<string, string>();

/** Opens the panel and sends a prompt, optionally with images (data: URLs). `label` is what the
 *  conversation shows for the person's message (the full prompt still goes to Claude). */
export function askClaude(prompt: string, images: string[] = [], opts: { label?: string } = {}) {
  useStore.setState({ chatOpen: true });
  for (const url of images) attachImage(url);
  send(prompt, opts);
}

/** Number of the latest turn that started, and the one the person last stopped. A turn that
 *  isn't the latest mustn't end the latest one's "running" state or report its own abort. */
let turnToken = 0;
let stoppedToken = 0;

/** What the last bridge turn sent, to send again when its session turns out to be gone. */
let lastBridgeTurn: { full: string; attachments: Attachment[]; session: string | null } | null = null;

export async function send(prompt: string, opts: { label?: string } = {}) {
  if (!prompt.trim()) return;
  // The file's saved conversation is read first, so this message lands after it.
  await entering;
  const st = useChat.getState();
  if (opts.label) labels.set(prompt, opts.label);
  // Claude can't change a file that is view-only here.
  if (useStore.getState().es.readOnly || useCollab.getState().viewer) {
    toast("You can view this file but not edit it, so Claude can't change it here.", "error");
    return;
  }
  // Claude is busy: the message goes out when this turn ends (no need to stop it to ask).
  if (st.running) {
    useChat.setState({ queued: st.queued ? `${st.queued}\n\n${prompt}` : prompt });
    return;
  }
  // Not connected yet: keep the prompt (the panel shows how to connect) instead of failing.
  if (!claudeReady(st) && !(st.mode === "bridge" && st.claude?.available === false)) {
    useChat.setState({ queued: prompt });
    return;
  }
  const label = opts.label ?? labels.get(prompt);
  labels.delete(prompt);
  const attachments = st.pending.map(toAttachment);
  push({
    kind: "user",
    text: label ?? prompt,
    images: st.pending.map((p) => p.url),
    ...(label ? { title: prompt.length > 600 ? prompt.slice(0, 600) + "…" : prompt } : {}),
  });
  useChat.setState({ pending: [] });
  const full = `${contextLine()}\n\n${prompt}`;
  if (st.mode === "bridge") {
    if (st.bridgeStatus !== "connected") {
      push({
        kind: "error",
        text: "The Designotron bridge isn't running on this computer. The setup steps are at the top of this panel. Or switch to API-key mode in settings.",
      });
      return;
    }
    if (st.claude && !st.claude.available) {
      push({ kind: "error", text: "The bridge couldn't find the `claude` CLI. Install Claude Code and sign in with your Pro/Max account (`claude` then /login)." });
      return;
    }
    useChat.setState({ running: true });
    lastTurn = { prompt, images: attachments.length, label };
    lastBridgeTurn = { full, attachments, session: st.sessionId };
    bridge.chat(full, st.sessionId, attachments);
    return;
  }
  if (!st.apiKey) {
    push({ kind: "error", text: "Add an Anthropic API key in settings, or use Claude Code mode with your Pro/Max subscription." });
    return;
  }
  const token = ++turnToken;
  const file = st.chatFile;
  lastTurn = { prompt, images: attachments.length, label };
  useChat.setState({ running: true });
  // After a reload the transcript is back but the API messages are not.
  if (file && apiLost.delete(file)) {
    push({ kind: "system", text: "Claude doesn't have the messages above any more (API mode starts fresh after a reload)." });
  }
  try {
    await runApiAgent(full, attachments);
    if (!st.keyChecked) {
      useChat.setState({ keyChecked: true });
      try {
        localStorage.setItem("dt:keyChecked", "1");
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    // The person has moved to another file or conversation since: this run's errors aren't theirs.
    const here = useChat.getState().chatFile === file;
    // Stopping aborts the request on purpose; it isn't an error to report.
    if (stoppedToken !== token && here) push({ kind: "error", text: apiErrorText(err), ...(retryable(err) ? { retry: prompt, retryLabel: label } : {}) });
    // A rejected key: keep the prompt so it sends once a valid key is entered.
    if ((err as { status?: number })?.status === 401 && here) useChat.setState({ queued: prompt });
  } finally {
    if (token === turnToken) useChat.setState({ running: false });
  }
}

/** What the last turn was, for the Retry button of an interrupted one. */
let lastTurn: { prompt: string; images: number; label?: string } | null = null;

/** Errors that go away by themselves: a busy API, a rate limit, a dropped connection. */
function retryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 503 || status === 529) return true;
  return !status && /APIConnection|network|fetch|connection/i.test(`${(err as Error)?.name ?? ""} ${(err as Error)?.message ?? ""}`);
}

const UNDO_KEYS = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") ? "⌘Z" : "Ctrl+Z";

/** The bridge connection dropped while a turn was running. What the turn built is kept. */
export function connectionLost() {
  useChat.setState({ running: false });
  const t = lastTurn;
  push({
    kind: "error",
    text: `Lost the connection to the bridge, so Claude's turn stopped. What it built so far is kept (${UNDO_KEYS} removes it).${t?.images ? " Attached images aren't sent again." : ""}`,
    ...(t ? { retry: t.prompt, retryLabel: t.label } : {}),
  });
}

/** The CLI no longer has the session this conversation was resuming (cleaned up, or another
 *  computer): the same message goes out once more in a new session. False when that isn't the case. */
export function resumeFailed(): boolean {
  const t = lastBridgeTurn;
  if (!t?.session || !useChat.getState().running) return false;
  lastBridgeTurn = { ...t, session: null };
  useChat.setState({ sessionId: null });
  push({ kind: "system", text: "Started a new Claude Code session (the earlier one is no longer on this computer)." });
  bridge.chat(t.full, null, t.attachments);
  return true;
}

/** Plain-language text for Anthropic API errors (the SDK's message is raw JSON). */
function apiErrorText(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 401) {
    setApiKey("");
    return "That API key wasn't accepted. Paste a valid key from console.anthropic.com to continue.";
  }
  if (status === 403) return "This API key isn't allowed to use that model. Pick another model in settings or check the key's permissions.";
  if (status === 429) return "Rate limit reached for this API key. Wait a minute and try again.";
  if (status === 529 || status === 503) return "Claude is overloaded right now. Try again in a moment.";
  if (status === 400 && /credit balance/i.test(String((err as Error).message))) return "This API key's account is out of credit. Add credit at console.anthropic.com.";
  return apiMessage(err) ?? String(err instanceof Error ? err.message : err);
}

/** The API's own message from an error body (`{"type":"error","error":{"message":…}}`), never the
 *  raw JSON the SDK puts in `Error.message`. */
function apiMessage(err: unknown): string | null {
  const fromBody = (b: any): string | null => (typeof b?.error?.message === "string" ? b.error.message : typeof b?.message === "string" ? b.message : null);
  const direct = fromBody((err as { error?: unknown })?.error);
  if (direct) return direct;
  const text = String(err instanceof Error ? err.message : err);
  const status = (err as { status?: number })?.status;
  const brace = text.indexOf("{");
  // Only SDK errors carry a JSON body in their message ("400 {...}").
  if (brace < 0 || (!status && !/^\d{3}\s*\{/.test(text))) return null;
  try {
    const parsed = fromBody(JSON.parse(text.slice(brace)));
    if (parsed) return parsed;
  } catch {
    /* not JSON after all */
  }
  return `The API returned an error${status ? ` (HTTP ${status})` : ""}. Try again, or check the key and model in settings.`;
}

export function stop() {
  const st = useChat.getState();
  stoppedToken = turnToken;
  if (st.mode === "bridge") bridge.cancel();
  // Now, not after a lazy import: a queued message's request starts right after this, and a late
  // abort would hit it instead.
  else abortApiAgent();
  // A message queued behind this turn goes back to the box (the person stopped to say something
  // else, not to send that).
  useChat.setState({ running: false, queued: null, draft: joinText(st.draft, st.queued) });
}

// A turn that starts on an empty page shows Claude's work: the view fits it as soon as
// something appears and again when the turn ends (it may land anywhere on the canvas).
{
  const pageEmpty = () => {
    const doc = getDoc();
    const page = doc.pages.find((p) => p.id === useStore.getState().es.page) ?? doc.pages[0];
    return !page?.children.length;
  };
  let watch: (() => void) | null = null;
  useChat.subscribe((s, prev) => {
    if (s.running === prev.running) return;
    if (s.running) {
      watch?.();
      watch = null;
      if (!pageEmpty()) return;
      let shown = false;
      watch = onDocChange(() => {
        if (!shown && !pageEmpty()) {
          shown = true;
          requestAnimationFrame(zoomToFit);
        }
      });
    } else if (watch) {
      watch();
      watch = null;
      if (!pageEmpty()) requestAnimationFrame(zoomToFit);
    }
  });
}

// Expose chat state on the automation handle (see store.ts).
(globalThis as any).__dt = { ...(globalThis as any).__dt, chat: () => useChat.getState(), chatSet: (p: Partial<ChatStore>) => useChat.setState(p), send: (p: string) => send(p) };
