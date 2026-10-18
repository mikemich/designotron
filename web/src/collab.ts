// Multiplayer client: shares this file through the local bridge (owner) or joins a
// shared link (guest). Local changes go out as engine deltas; peers' deltas come in
// through `applyRemote` (never part of local undo). Presence: cursors and selections.

import { create } from "zustand";
import { allAssets, loadAssets, referencedAssets } from "./assets";
import { bridgeHttpBase } from "./ai/bridgeClient";
import { dispatch, getEngine, newEngine, onDocChange, toast, useStore, zoomToFit } from "./store";
import { newFileId, saveFile } from "./files";
import { userName } from "./canvas/Comments";

export interface Presence {
  page: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
}

export interface Peer {
  id: number;
  name: string;
  color: string;
  presence: Presence | null;
}

interface CollabState {
  status: "off" | "connecting" | "live";
  role: "owner" | "guest" | null;
  link: string | null;
  peers: Record<number, Peer>;
  dialogOpen: boolean;
}

export const useCollab = create<CollabState>(() => ({ status: "off", role: null, link: null, peers: {}, dialogOpen: false }));

const COLORS = ["#F24822", "#0FA958", "#9747FF", "#FF7A00", "#1BC4FF", "#FF24BD", "#14AE5C", "#E8A400"];
const myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
const myName = () => userName() || "Anonymous";

let ws: WebSocket | null = null;
let wsUrl = "";
let applying = false;
let flushQueued = false;
let retry: ReturnType<typeof setTimeout> | null = null;
const sentAssets = new Set<string>();
let unsubscribe: (() => void) | null = null;

function isEmptyDelta(d: any): boolean {
  return (
    !Object.keys(d.nodes ?? {}).length &&
    !(d.removed ?? []).length &&
    !Object.keys(d.comments ?? {}).length &&
    !(d.commentsRemoved ?? []).length &&
    !["name", "pages", "styles", "variables"].some((k) => k in d)
  );
}

function send(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Assets referenced by `json` that peers don't have yet. */
function newAssets(json: string): Record<string, string> {
  const all = allAssets();
  const out: Record<string, string> = {};
  for (const id of referencedAssets(json)) {
    if (!sentAssets.has(id) && all[id]) {
      out[id] = all[id];
      sentAssets.add(id);
    }
  }
  return out;
}

/** Sends local changes made since the last flush. */
function flush() {
  flushQueued = false;
  if (useCollab.getState().status !== "live") return;
  const d = JSON.parse(getEngine().collabDelta());
  if (d.full || isEmptyDelta(d)) return;
  send({ type: "delta", delta: d, assets: newAssets(JSON.stringify(d.nodes ?? {})) });
}

function scheduleFlush() {
  if (applying || flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(flush);
}

function loadShared(doc: unknown, assets: Record<string, string>) {
  loadAssets(assets ?? {});
  for (const id of Object.keys(assets ?? {})) sentAssets.add(id);
  getEngine().load(JSON.stringify(doc));
  dispatch({ op: "relayout" });
  getEngine().collabReset();
  requestAnimationFrame(zoomToFit);
}

function onMessage(m: any) {
  switch (m.type) {
    case "welcome": {
      if (m.doc) loadShared(m.doc, m.assets);
      else getEngine().collabReset();
      const peers: Record<number, Peer> = {};
      for (const p of m.peers ?? []) peers[p.id] = p;
      useCollab.setState({ status: "live", peers });
      sendPresence(true);
      break;
    }
    case "delta":
      // Our own unsent edits go out first, so the engine's baseline stays exact.
      flush();
      loadAssets(m.assets ?? {});
      applying = true;
      try {
        dispatch({ op: "applyRemote", delta: m.delta }, { quiet: true });
      } finally {
        applying = false;
      }
      break;
    case "reload":
      loadShared(m.doc, m.assets);
      toast("The shared file was replaced by its owner");
      break;
    case "peer":
      useCollab.setState((s) => ({ peers: { ...s.peers, [m.id]: { id: m.id, name: m.name, color: m.color, presence: null } } }));
      break;
    case "leave":
      useCollab.setState((s) => {
        const peers = { ...s.peers };
        delete peers[m.id];
        return { peers };
      });
      break;
    case "presence":
      useCollab.setState((s) => (s.peers[m.id] ? { peers: { ...s.peers, [m.id]: { ...s.peers[m.id], presence: m.presence } } } : s));
      break;
    case "error":
      toast(m.message, "error");
      break;
  }
}

function connect(join: Record<string, unknown>) {
  if (retry) clearTimeout(retry);
  useCollab.setState({ status: "connecting" });
  const socket = new WebSocket(wsUrl);
  ws = socket;
  socket.onopen = () => socket.send(JSON.stringify({ type: "join", name: myName(), color: myColor, ...join }));
  socket.onmessage = (e) => onMessage(JSON.parse(e.data));
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    if (!useCollab.getState().role) return;
    useCollab.setState({ status: "connecting", peers: {} });
    // Reconnect without replacing the room's document.
    retry = setTimeout(() => connect({}), 2000);
  };
  unsubscribe ??= subscribeLocal();
}

function subscribeLocal(): () => void {
  const offDoc = onDocChange(scheduleFlush);
  const offSel = useStore.subscribe((s, prev) => {
    if (s.es.selection !== prev.es.selection || s.es.page !== prev.es.page) sendPresence(true);
  });
  return () => {
    offDoc();
    offSel();
  };
}

/** Owner: starts the LAN share (once) and puts this file in the shared room. */
export async function startSharing(): Promise<void> {
  const res = await fetch(`${bridgeHttpBase()}/bridge/share`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  const { url } = await res.json();
  wsUrl = `${bridgeHttpBase().replace(/^http/, "ws")}/collab/ws`;
  useCollab.setState({ role: "owner", link: url });
  const json = getEngine().save();
  const used = new Set(referencedAssets(json));
  const assets = Object.fromEntries(Object.entries(allAssets()).filter(([k]) => used.has(k)));
  used.forEach((id) => sentAssets.add(id));
  connect({ doc: JSON.parse(json), assets, reset: true });
}

export function stopSharing() {
  useCollab.setState({ role: null, status: "off", peers: {}, link: null });
  ws?.close();
  ws = null;
  unsubscribe?.();
  unsubscribe = null;
}

/** Guest: opens (or reuses) a local file for the shared link and joins the room. */
export function joinFromUrl(): string | null {
  const token = new URLSearchParams(location.search).get("collab");
  if (!token) return null;
  const key = `dt:collab:${token}`;
  let fileId: string | null = null;
  try {
    fileId = localStorage.getItem(key);
  } catch {
    /* ignore */
  }
  if (!fileId) {
    fileId = newFileId();
    try {
      localStorage.setItem(key, fileId);
    } catch {
      /* ignore */
    }
  }
  return fileId;
}

export async function ensureGuestFile(fileId: string) {
  // A placeholder until the room's document arrives.
  newEngine();
  dispatch({ op: "setDocName", name: "Shared design" });
  await saveFile(fileId, "Shared design", getEngine().save());
}

/** Called once the editor for the guest file is ready. */
export function joinShared() {
  const token = new URLSearchParams(location.search).get("collab");
  if (!token || useCollab.getState().role) return;
  wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab/ws?token=${encodeURIComponent(token)}`;
  useCollab.setState({ role: "guest", link: location.href });
  connect({});
}

let lastPresence = 0;
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
let cursor: { x: number; y: number } | null = null;

/** Reports the local cursor (page coordinates, or null when it leaves the canvas). */
export function reportCursor(p: { x: number; y: number } | null) {
  cursor = p;
  sendPresence(false);
}

function sendPresence(now: boolean) {
  if (useCollab.getState().status !== "live") return;
  const go = () => {
    lastPresence = Date.now();
    presenceTimer = null;
    const st = useStore.getState();
    send({ type: "presence", presence: { page: st.es.page, cursor, selection: st.es.selection } satisfies Presence });
  };
  if (now) return go();
  if (presenceTimer) return;
  const wait = Math.max(0, 40 - (Date.now() - lastPresence));
  presenceTimer = setTimeout(go, wait);
}

// Automation handle (see store.ts).
(globalThis as any).__dt = { ...(globalThis as any).__dt, collab: () => useCollab.getState() };
