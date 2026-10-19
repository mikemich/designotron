// Multiplayer client: shares this file through the local bridge (owner) or joins a
// shared link (guest). Local changes go out as engine deltas; peers' deltas come in
// through `applyRemote` (never part of local undo). Presence: cursors and selections.

import { create } from "zustand";
import { allAssets, loadAssets, referencedAssets } from "./assets";
import { bridgeChecked, bridgeHttpBase } from "./ai/bridgeClient";
import { dispatch, getDoc, getEngine, newEngine, onDocChange, toast, useStore, zoomToFit } from "./store";
import { deleteFile, newFileId, saveFile } from "./files";
import { userName } from "./canvas/Comments";

export interface Presence {
  page: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
  /** Sent by whoever shared the file, so guests can tell when they leave. */
  owner?: boolean;
  /** The owner clicked Stop sharing. */
  ended?: boolean;
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
  /** Online (through an internet relay) or on the local network (through the bridge). */
  mode: "online" | "lan" | null;
  link: string | null;
  peers: Record<number, Peer>;
  dialogOpen: boolean;
  /** Guests: the person who shared the file has left ("left") or stopped sharing ("ended"). */
  ownerGone: { name: string; how: "left" | "ended"; /** Before this guest ever got the file. */ early?: boolean } | null;
}

export const useCollab = create<CollabState>(() => ({ status: "off", role: null, mode: null, link: null, peers: {}, dialogOpen: false, ownerGone: null }));

/** Where shared links open when this editor runs on localhost (guests can't reach that). */
export const HOSTED_EDITOR: string = import.meta.env.VITE_DT_EDITOR_URL || "https://mikemich.github.io/designotron/";

/** Relay used for online sharing: one the user set, else the build default (VITE_DT_RELAY). */
export function relayUrl(): string {
  try {
    const saved = localStorage.getItem("dt:relay");
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  return import.meta.env.VITE_DT_RELAY || "";
}

export function setRelayUrl(url: string) {
  try {
    localStorage.setItem("dt:relay", url);
  } catch {
    /* ignore */
  }
}

function normalizeRelay(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (!/^(https?|wss?):\/\//.test(u)) u = `https://${u}`;
  return u.replace(/^ws/, "http");
}

/** Checks that `url` is a Designotron relay; returns its health info. */
export async function probeRelay(url: string): Promise<{ editor: boolean }> {
  const base = normalizeRelay(url);
  if (location.protocol === "https:" && base.startsWith("http:")) throw new Error("This editor is on https, so the relay must be too (https://…).");
  let info: any;
  // Free hosts put idle relays to sleep; the first request wakes them (up to a minute).
  const slow = setTimeout(() => toast("Waking up the relay, this can take up to a minute…"), 3000);
  try {
    info = await (await fetch(`${base}/health`)).json();
  } catch {
    throw new Error(`Couldn't reach a relay at ${base}.`);
  } finally {
    clearTimeout(slow);
  }
  if (info?.relay !== "designotron") throw new Error(`${base} isn't a Designotron relay.`);
  return { editor: !!info.editor };
}

/** True when this page is itself served by a relay (it can share without any setup). */
export async function pageIsRelay(): Promise<boolean> {
  try {
    const info = await (await fetch(`${location.origin}/health`)).json();
    return info?.relay === "designotron";
  } catch {
    return false;
  }
}

function randomRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const isLocalPage = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

const COLORS = ["#F24822", "#0FA958", "#9747FF", "#FF7A00", "#1BC4FF", "#FF24BD", "#14AE5C", "#E8A400"];
/** This person's cursor colour, as collaborators see it. */
export const myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
const myName = () => userName() || "Anonymous";

let ws: WebSocket | null = null;
let wsUrl = "";
let applying = false;
/** The relay acknowledges our changes in the order it applies everyone's (newer relays):
 *  the engine then keeps unacknowledged changes on top, so everyone converges. */
let ordered = false;
/** The relay said the owner stopped sharing this room. */
let roomEnded = false;
let flushQueued = false;
let retry: ReturnType<typeof setTimeout> | null = null;
/** Pause before reconnecting; doubles while the relay refuses or can't be reached. */
const RETRY_MS = 2000;
let retryDelay = RETRY_MS;
const sentAssets = new Set<string>();
let unsubscribe: (() => void) | null = null;

function isEmptyDelta(d: any): boolean {
  return (
    !Object.keys(d.nodes ?? {}).length &&
    !Object.keys(d.patch ?? {}).length &&
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
  send({ type: "delta", delta: d, assets: newAssets(JSON.stringify([d.nodes ?? {}, d.patch ?? {}])) });
}

function scheduleFlush() {
  if (applying || flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(flush);
}

/** Whether this session has joined its room before (reconnects keep the view and local edits). */
let joinedOnce = false;

function loadShared(doc: unknown, assets: Record<string, string>, fit = true) {
  loadAssets(assets ?? {});
  for (const id of Object.keys(assets ?? {})) sentAssets.add(id);
  getEngine().load(JSON.stringify(doc));
  dispatch({ op: "relayout" });
  getEngine().collabReset(ordered);
  if (fit) requestAnimationFrame(zoomToFit);
}

function onMessage(m: any) {
  switch (m.type) {
    case "welcome": {
      // Edits the room never got (made while disconnected, or sent but not acknowledged).
      const unsent: unknown[] = joinedOnce && m.doc ? JSON.parse(getEngine().collabUnsent()) : [];
      ordered = !!m.ordered;
      if (m.doc) loadShared(m.doc, m.assets, !joinedOnce);
      else getEngine().collabReset(ordered);
      // Put them back on top of the room's copy; the flush below sends them, so nothing made
      // offline is lost.
      applying = true;
      try {
        for (const d of unsent) dispatch({ op: "applyRemote", delta: d, local: true }, { quiet: true });
      } finally {
        applying = false;
      }
      joinedOnce = true;
      const peers: Record<number, Peer> = {};
      for (const p of m.peers ?? []) peers[p.id] = p;
      useCollab.setState({ status: "live", peers });
      if (unsent.length) flush();
      retryDelay = RETRY_MS;
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
    case "ack":
      // The relay applied our oldest unacknowledged change (or turned it down).
      flush();
      if (m.rejected) dispatch({ op: "collabAck", rejected: true }, { quiet: true });
      else getEngine().dispatch(JSON.stringify({ op: "collabAck", rejected: false }));
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
        const gone = peers[m.id];
        delete peers[m.id];
        const ownerGone = gone?.presence?.owner && !s.ownerGone ? { name: gone.name, how: "left" as const } : s.ownerGone;
        return { peers, ownerGone };
      });
      break;
    case "presence":
      useCollab.setState((s) => {
        const p = s.peers[m.id];
        if (!p) return s;
        const peers = { ...s.peers, [m.id]: { ...p, presence: m.presence } };
        // The owner stopped sharing, or came back.
        const ownerGone = m.presence?.ended ? { name: p.name, how: "ended" as const } : m.presence?.owner ? null : s.ownerGone;
        return { peers, ownerGone };
      });
      break;
    case "rename":
      useCollab.setState((s) => (s.peers[m.id] ? { peers: { ...s.peers, [m.id]: { ...s.peers[m.id], name: m.name } } } : s));
      break;
    case "ended":
      // The owner stopped sharing before we (re)joined: keep this copy, don't retry.
      roomEnded = true;
      // `early`: this copy is still the empty placeholder (the guest never got the file).
      useCollab.setState({ status: "off", peers: {}, ownerGone: { name: m.name || "The owner", how: "ended", early: !joinedOnce && !Object.keys(getDoc().nodes).length } });
      break;
    case "error":
      toast(m.message, "error");
      break;
  }
}

/** Saves this person's name and tells the room (guests pick one after joining). */
export function setMyName(name: string) {
  name = name.trim().slice(0, 40);
  if (!name) return;
  try {
    localStorage.setItem("dt:userName", name);
  } catch {
    /* ignore */
  }
  send({ type: "name", name });
}

function connect(join: Record<string, unknown>) {
  if (retry) clearTimeout(retry);
  useCollab.setState({ status: "connecting" });
  const socket = new WebSocket(wsUrl);
  ws = socket;
  let opened = false;
  socket.onopen = () => {
    opened = true;
    socket.send(JSON.stringify({ type: "join", name: myName(), color: myColor, ...join }));
  };
  socket.onmessage = (e) => onMessage(JSON.parse(e.data));
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    if (!useCollab.getState().role || roomEnded) return;
    useCollab.setState({ status: "connecting", peers: {} });
    // Reconnect with this copy of the file but without `reset`: the relay keeps the room's
    // document if it still has one, and adopts ours if it lost the room (e.g. a free host
    // restarted it after sleeping).
    // A busy relay (its error was already shown) or one that turns connections away gets
    // longer and longer pauses, up to a minute.
    if (!opened && retryDelay === RETRY_MS * 4) toast("Can't connect to the relay right now (it may be busy); still trying…", "error");
    retry = setTimeout(() => connect(currentFile()), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60_000);
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

/** This file and the images it uses, as sent in a join. */
function currentFile(): { doc: unknown; assets: Record<string, unknown> } {
  const json = getEngine().save();
  const used = new Set(referencedAssets(json));
  const assets = Object.fromEntries(Object.entries(allAssets()).filter(([k]) => used.has(k)));
  used.forEach((id) => sentAssets.add(id));
  return { doc: JSON.parse(json), assets };
}

function shareCurrentFile() {
  connect({ ...currentFile(), reset: true });
}

/** Owner: shares this file through an internet relay; anyone with the link can join. */
export async function startOnline(relay: string): Promise<void> {
  const base = normalizeRelay(relay);
  await probeRelay(base);
  setRelayUrl(base);
  const room = randomRoomId();
  wsUrl = `${base.replace(/^http/, "ws")}/ws?room=${room}`;
  // Guests open this editor (or the hosted one when this runs on localhost), pointed at the
  // relay: never the relay's bundled editor, which can be older than this one.
  const here = location.origin + location.pathname;
  const link =
    base === location.origin
      ? `${here}?room=${room}` // this page is served by the relay itself
      : `${isLocalPage() ? HOSTED_EDITOR : here}?room=${room}&relay=${encodeURIComponent(base)}`;
  useCollab.setState({ role: "owner", mode: "online", link });
  shareCurrentFile();
}

/** Owner: starts the LAN share (once) and puts this file in the shared room. */
export async function startSharing(): Promise<void> {
  await bridgeChecked();
  const res = await fetch(`${bridgeHttpBase()}/bridge/share`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  const { url } = await res.json();
  wsUrl = `${bridgeHttpBase().replace(/^http/, "ws")}/collab/ws`;
  useCollab.setState({ role: "owner", mode: "lan", link: url });
  shareCurrentFile();
}

export function stopSharing() {
  joinedOnce = false;
  roomEnded = false;
  // Tell guests the owner stopped sharing (they keep their copy and can save it).
  if (useCollab.getState().role === "owner") send({ type: "presence", presence: { page: "", cursor: null, selection: [], owner: true, ended: true } satisfies Presence });
  useCollab.setState({ role: null, mode: null, status: "off", peers: {}, link: null, ownerGone: null });
  ws?.close();
  ws = null;
  unsubscribe?.();
  unsubscribe = null;
}

/** Guest: turns this copy of the shared file into their own file (no second file), leaves
 *  the room and keeps editing it. */
export async function remixShared(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const token = q.get("room") ?? q.get("collab");
  stopSharing();
  const fileId = useStore.getState().fileId;
  // Renamed after leaving, so the room doesn't get the new name.
  const name = `${getDoc().name || "Shared design"} (my copy)`;
  dispatch({ op: "setDocName", name });
  const id = fileId ?? newFileId();
  await saveFile(id, name, getEngine().save());
  // Opening the link again joins with a fresh copy instead of this one.
  try {
    if (token) localStorage.removeItem(`dt:collab:${token}`);
  } catch {
    /* ignore */
  }
  // Drop ?room= so a reload doesn't join again.
  history.replaceState(null, "", `${location.pathname}#/file/${id}`);
  if (id !== fileId) dispatchEvent(new HashChangeEvent("hashchange"));
  toast("It's your own file now: changes stay with you and nobody else sees them.");
}

/** Guest who opened a link after sharing ended: drops the empty placeholder file and goes
 *  to their files. */
export async function leaveEndedRoom(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const token = q.get("room") ?? q.get("collab");
  const fileId = useStore.getState().fileId;
  stopSharing();
  try {
    if (token) localStorage.removeItem(`dt:collab:${token}`);
  } catch {
    /* ignore */
  }
  // Deleted first, so the file list it goes to doesn't show it.
  if (fileId) await deleteFile(fileId);
  history.replaceState(null, "", `${location.pathname}#/`);
  dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Guest: opens (or reuses) a local file for the shared link and joins the room. */
export function joinFromUrl(): string | null {
  const q = new URLSearchParams(location.search);
  const token = q.get("room") ?? q.get("collab");
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
  if (useCollab.getState().role) return;
  const q = new URLSearchParams(location.search);
  const room = q.get("room");
  const token = q.get("collab");
  const wsBase = (http: string) => http.replace(/^http/, "ws");
  if (room) {
    // Online: the relay given in the link, or this page's own origin when the relay serves the editor.
    const relay = normalizeRelay(q.get("relay") || location.origin);
    wsUrl = `${wsBase(relay)}/ws?room=${encodeURIComponent(room)}`;
    useCollab.setState({ role: "guest", mode: "online", link: location.href });
  } else if (token) {
    wsUrl = `${wsBase(location.origin)}/collab/ws?token=${encodeURIComponent(token)}`;
    useCollab.setState({ role: "guest", mode: "lan", link: location.href });
  } else return;
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
    const owner = useCollab.getState().role === "owner" || undefined;
    send({ type: "presence", presence: { page: st.es.page, cursor, selection: st.es.selection, owner } satisfies Presence });
  };
  if (now) return go();
  if (presenceTimer) return;
  const wait = Math.max(0, 40 - (Date.now() - lastPresence));
  presenceTimer = setTimeout(go, wait);
}

// Automation handle (see store.ts).
(globalThis as any).__dt = { ...(globalThis as any).__dt, collab: () => useCollab.getState() };
