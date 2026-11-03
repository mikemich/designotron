// Multiplayer client: shares this file through the local bridge (owner) or joins a
// shared link (guest). Local changes go out as engine deltas; peers' deltas come in
// through `applyRemote` (never part of local undo). Presence: cursors and selections.

import { create } from "zustand";
import { allAssets, loadAssets, referencedAssets } from "./assets";
import { bridgeChecked, bridgeHttpBase } from "./ai/bridgeClient";
import { reportFailure } from "./errors";
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
  /** The page-space rectangle this person's canvas shows (what followers fit to their own). */
  view?: { x: number; y: number; w: number; h: number };
  /** The peer id this person follows. */
  following?: number;
  /** A timestamp while this person spotlights themselves; 0 or absent when not. */
  spotlight?: number;
  /** Cursor chat: what they typed (`t` counts changes; it isn't a clock). */
  chat?: { text: string; t: number };
  /** This person's colour, when it isn't the one they joined with (another person had it). */
  color?: string;
}

export interface Peer {
  id: number;
  name: string;
  color: string;
  presence: Presence | null;
  /** Joined through a view-only link. */
  role?: "viewer";
}

interface CollabState {
  status: "off" | "connecting" | "live";
  role: "owner" | "guest" | null;
  /** Online (through an internet relay) or on the local network (through the bridge). */
  mode: "online" | "lan" | null;
  link: string | null;
  peers: Record<number, Peer>;
  dialogOpen: boolean;
  /** Joined before and now connecting again (offline, or the relay went away): edits are kept
   *  locally and sent once the connection is back. */
  reconnecting: boolean;
  /** Online owners: the same room link on this editor, for trying what a guest sees. */
  previewLink: string | null;
  /** Guests: the person who shared the file has left ("left") or stopped sharing ("ended"). */
  ownerGone: { name: string; how: "left" | "ended"; /** Before this guest ever got the file. */ early?: boolean } | null;
  /** This connection's id in the room (peers refer to it, e.g. `following`). */
  me: number | null;
  /** Joined through a view-only link: the file can be watched and commented on, not edited. */
  viewer: boolean;
  /** Viewers: connected, but nobody with edit access has opened the file yet. */
  waiting: boolean;
  /** Editors: the id of this room's view-only link (new relays only). */
  viewId: string | null;
  /** Online, and the relay didn't say which model it understands: it predates this editor. */
  relayOld: boolean;
  /** Viewers: why the view link can't open right now. */
  viewError: string | null;
}

export const useCollab = create<CollabState>(() => ({
  status: "off",
  role: null,
  mode: null,
  link: null,
  peers: {},
  dialogOpen: false,
  reconnecting: false,
  previewLink: null,
  ownerGone: null,
  me: null,
  viewer: false,
  waiting: false,
  viewId: null,
  relayOld: false,
  viewError: null,
}));

/** Where shared links open when this editor runs on localhost (guests can't reach that). */
export const HOSTED_EDITOR = "https://mikemich.github.io/designotron/";

/** The editor that links made on a localhost page open in: `localStorage["dt:editorUrl"]` if
 *  set (e.g. a relay or Pages site of your own), else the build's `VITE_DT_EDITOR_URL`, else
 *  the public hosted editor. Always ends with a slash. */
export function editorBase(): string {
  let url = "";
  try {
    url = localStorage.getItem("dt:editorUrl") ?? "";
  } catch {
    /* ignore */
  }
  for (const candidate of [url, import.meta.env.VITE_DT_EDITOR_URL ?? ""]) {
    if (!candidate.trim()) continue;
    try {
      const u = new URL(/^https?:\/\//.test(candidate.trim()) ? candidate.trim() : `https://${candidate.trim()}`);
      return u.origin + u.pathname.replace(/\/*$/, "/");
    } catch {
      /* not a URL: try the next */
    }
  }
  return HOSTED_EDITOR;
}

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
/** This person's cursor colour, as collaborators see it. Starts random; changes to the first
 *  free one when somebody else in the room already has it (see `settleColor`). */
export let myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
/** True once the colour was changed from the one joined with: presence then carries it. */
let colorChanged = false;

/** Keeps colours distinct: if another person uses this editor's colour (and this editor joined
 *  later, or the other can't change theirs), takes the first colour nobody has. */
function settleColor() {
  const { peers, me } = useCollab.getState();
  const others = Object.values(peers);
  const same = (c: string) => c.toLowerCase() === myColor.toLowerCase();
  // The later joiner yields; an older editor (its presence has no `view`) can't, so always yields to it.
  const clash = others.some((p) => same(p.color) && (me == null || p.id < me || (!!p.presence && p.presence.view === undefined)));
  if (!clash) return;
  const taken = new Set(others.map((p) => p.color.toLowerCase()));
  const free = COLORS.find((c) => !taken.has(c.toLowerCase()));
  if (!free || free === myColor) return;
  myColor = free;
  colorChanged = true;
  useCollab.setState({ peers: { ...peers } });
  sendPresence(true);
}
const myName = () => userName() || "Anonymous";

let ws: WebSocket | null = null;
let wsUrl = "";
let applying = false;
/** The relay acknowledges our changes in the order it applies everyone's (newer relays):
 *  the engine then keeps unacknowledged changes on top, so everyone converges. */
let ordered = false;
/** The room takes pages, styles and variables per id, so edits to different ones merge
 *  (older relays: whole lists, last writer wins). */
let granular = false;
/** The relay said the owner stopped sharing this room. */
let roomEnded = false;
let flushQueued = false;
let retry: ReturnType<typeof setTimeout> | null = null;
/** Pause before reconnecting; doubles while the relay refuses or can't be reached. */
const RETRY_MS = 2000;
let retryDelay = RETRY_MS;
/** Editors ping the room this often; a room that answered pings before and then stays silent
 *  this long (a dropped network leaves the socket "open" for minutes) is replaced. */
const PING_MS = 10_000;
const SILENT_MS = 25_000;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let lastHeard = 0;
let lastPing = 0;
/** The room has answered a ping on this connection (older relays don't know pings). */
let heardPong = false;
/** Drops the current connection as if it had closed (set by `connect`). */
let dropConnection: (() => void) | null = null;
const sentAssets = new Set<string>();
let unsubscribe: (() => void) | null = null;

/** Delta keys of pages, styles and variables sent per id (see `collab::delta`). */
const GRANULAR_KEYS = ["pageChanges", "colorStyles", "textStyles", "effectStyles", "gridStyles", "collectionChanges", "variableChanges"];

function isEmptyDelta(d: any): boolean {
  return (
    !Object.keys(d.nodes ?? {}).length &&
    !Object.keys(d.patch ?? {}).length &&
    !(d.removed ?? []).length &&
    !Object.keys(d.comments ?? {}).length &&
    !(d.commentsRemoved ?? []).length &&
    !["name", "pages", "styles", "variables", ...GRANULAR_KEYS].some((k) => k in d)
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

/** Shown when the relay's `/health` has no "viewLinks" feature. */
const NO_VIEW_LINKS = "This relay can't open view-only links. Ask whoever shared it for an edit link or to update the relay.";
/** This connection joined through a view-only link (never sends a document). */
let viewing = false;
/** Relay base of the view link, for the health check after failed attempts. */
let viewRelay = "";
/** Failed attempts to open the view link's socket (it never opened). */
let viewFailures = 0;

/** What a (re)join sends: the file for editors, nothing for viewers. */
const joinBody = () => (viewing ? {} : currentFile());

/** Whether this session has joined its room before (reconnects keep the view and local edits). */
let joinedOnce = false;
/** The room's file has arrived at least once (a viewer can join a room nobody has opened yet). */
let joinedDoc = false;

function loadShared(doc: unknown, assets: Record<string, string>, fit = true) {
  loadAssets(assets ?? {});
  for (const id of Object.keys(assets ?? {})) sentAssets.add(id);
  getEngine().load(JSON.stringify(doc));
  dispatch({ op: "relayout" });
  getEngine().collabReset(ordered, granular);
  if (fit) requestAnimationFrame(zoomToFit);
}

function onMessage(m: any) {
  lastHeard = Date.now();
  switch (m.type) {
    case "pong":
      heardPong = true;
      break;
    case "welcome": {
      // Edits the room never got (made while disconnected, or sent but not acknowledged).
      const unsent: unknown[] = joinedOnce && m.doc ? JSON.parse(getEngine().collabUnsent()) : [];
      ordered = !!m.ordered;
      granular = !!m.granular;
      // A viewer's engine refuses every edit (comments still work).
      if (m.role === "viewer") dispatch({ op: "setReadOnly", on: true }, { quiet: true });
      if (m.doc) loadShared(m.doc, m.assets, !joinedOnce);
      else getEngine().collabReset(ordered, granular);
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
      for (const p of m.peers ?? []) peers[p.id] = { ...p, color: p.presence?.color ?? p.color };
      const online = useCollab.getState().mode === "online";
      useCollab.setState({
        status: "live",
        peers,
        reconnecting: false,
        me: m.you,
        viewer: m.role === "viewer",
        waiting: m.role === "viewer" && !m.doc && !joinedDoc,
        viewId: m.view ?? null,
        // Only relays on the internet are ever too old (the bridge is built with the editor).
        relayOld: online && m.model === undefined,
        viewError: null,
      });
      if (m.doc) joinedDoc = true;
      viewFailures = 0;
      if (unsent.length) flush();
      retryDelay = RETRY_MS;
      settleColor();
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
      joinedDoc = true;
      useCollab.setState({ waiting: false });
      loadShared(m.doc, m.assets);
      toast("The shared file was replaced by its owner");
      break;
    case "peer":
      useCollab.setState((s) => ({ peers: { ...s.peers, [m.id]: { id: m.id, name: m.name, color: m.color, presence: null, role: m.role } } }));
      settleColor();
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
        // A colour in presence wins over the one joined with (the person had to change it).
        const peers = { ...s.peers, [m.id]: { ...p, color: m.presence?.color ?? p.color, presence: m.presence } };
        // The owner stopped sharing, or came back.
        const ownerGone = m.presence?.ended ? { name: p.name, how: "ended" as const } : m.presence?.owner ? null : s.ownerGone;
        return { peers, ownerGone };
      });
      settleColor();
      break;
    case "rename":
      useCollab.setState((s) => (s.peers[m.id] ? { peers: { ...s.peers, [m.id]: { ...s.peers[m.id], name: m.name } } } : s));
      break;
    case "ended":
      // The owner stopped sharing before we (re)joined: keep this copy, don't retry.
      roomEnded = true;
      // `early`: this copy is still the empty placeholder (the guest never got the file).
      useCollab.setState({ status: "off", reconnecting: false, peers: {}, ownerGone: { name: m.name || "The owner", how: "ended", early: !joinedOnce && !Object.keys(getDoc().nodes).length } });
      break;
    case "error":
      // A view link the relay doesn't serve right now: say so in the bar, keep trying quietly.
      if (viewing && /view link/i.test(m.message ?? "")) useCollab.setState({ viewError: m.message });
      else toast(m.message, "error");
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
  useCollab.setState({ status: "connecting", reconnecting: joinedOnce });
  const socket = new WebSocket(wsUrl);
  ws = socket;
  let opened = false;
  /** This connection is gone (closed, or silent for too long): try again after a pause. */
  const lost = () => {
    if (ws !== socket) return;
    ws = null;
    stopHeartbeat();
    socket.onclose = socket.onmessage = socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    if (!useCollab.getState().role || roomEnded) return;
    useCollab.setState({ status: "connecting", reconnecting: joinedOnce, peers: {} });
    // Reconnect with this copy of the file but without `reset`: the relay keeps the room's
    // document if it still has one, and adopts ours if it lost the room (e.g. a free host
    // restarted it after sleeping).
    // A busy relay (its error was already shown) or one that turns connections away gets
    // longer and longer pauses, up to a minute.
    if (!opened && retryDelay === RETRY_MS * 4) toast("Can't connect to the relay right now (it may be busy); still trying…", "error");
    // An older relay answers a view link with an HTTP error, so the socket never opens. After two
    // failed tries ask it what it can do instead of retrying for ever.
    if (viewing && !opened && ++viewFailures >= 2) {
      void checkViewSupport();
      return;
    }
    retry = setTimeout(() => connect(joinBody()), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60_000);
  };
  socket.onopen = () => {
    // Replaced while connecting (never expected, but two live sockets would double-join).
    if (ws !== socket) return socket.close();
    opened = true;
    lastHeard = lastPing = Date.now();
    heardPong = false;
    stopHeartbeat();
    heartbeat = setInterval(() => {
      const now = Date.now();
      // Dead: nothing heard for SILENT_MS, and a ping that has had time to be answered is
      // still unanswered. (Timers in hidden tabs can run a minute late: lateness alone says
      // nothing about the connection, and pings keep going out meanwhile.)
      if (heardPong && lastPing > lastHeard && now - lastHeard > SILENT_MS && now - lastPing >= PING_MS / 2 - 500) return lost();
      if (now - lastPing >= PING_MS - 500) ping();
    }, PING_MS / 2);
    socket.send(JSON.stringify({ type: "join", name: myName(), color: myColor, granular: getEngine().collabGranular(), ...join }));
  };
  socket.onmessage = (e) => ws === socket && onMessage(JSON.parse(e.data));
  socket.onclose = lost;
  dropConnection = lost;
  unsubscribe ??= subscribeLocal();
}

function ping() {
  lastPing = Date.now();
  send({ type: "ping" });
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/** The network went away or came back. Edits made meanwhile stay in the engine and go out
 *  after the next welcome. */
function onNetwork(online: boolean) {
  if (!useCollab.getState().role || roomEnded) return;
  if (!online) {
    // Don't wait for the socket to notice.
    dropConnection?.();
    useCollab.setState({ status: "connecting", reconnecting: joinedOnce });
    return;
  }
  // A connection is already open or opening (a second one would join the room twice).
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (retry) clearTimeout(retry);
  retryDelay = RETRY_MS;
  connect(joinBody());
}

/** After a view link failed to open twice: if the relay has no view links, say so and stop. */
async function checkViewSupport() {
  let supported: boolean | null = null;
  try {
    const info = await (await fetch(`${viewRelay}/health`)).json();
    supported = Array.isArray(info?.features) && info.features.includes("viewLinks");
  } catch {
    /* can't tell (offline?): keep trying below */
  }
  if (!useCollab.getState().role || roomEnded) return;
  if (supported === false) {
    roomEnded = true;
    useCollab.setState({ status: "off", reconnecting: false, peers: {}, viewError: NO_VIEW_LINKS });
    return;
  }
  retry = setTimeout(() => connect(joinBody()), retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60_000);
}

function subscribeLocal(): () => void {
  const offDoc = onDocChange(scheduleFlush);
  const goOnline = () => onNetwork(true);
  const goOffline = () => onNetwork(false);
  addEventListener("online", goOnline);
  addEventListener("offline", goOffline);
  // Back in view: check the connection now instead of at the next (possibly throttled) tick.
  const shown = () => document.visibilityState === "visible" && useCollab.getState().status === "live" && ping();
  document.addEventListener("visibilitychange", shown);
  const offSel = useStore.subscribe((s, prev) => {
    if (s.es.selection !== prev.es.selection || s.es.page !== prev.es.page) sendPresence(true);
  });
  return () => {
    offDoc();
    offSel();
    removeEventListener("online", goOnline);
    removeEventListener("offline", goOffline);
    document.removeEventListener("visibilitychange", shown);
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
  // Guests open this editor (or, when this runs on localhost, the one `editorBase` names),
  // pointed at the relay: never the relay's bundled editor, which can be older than this one.
  const here = location.origin + location.pathname;
  const own = base === location.origin; // this page is served by the relay itself
  const query = own ? `?room=${room}` : `?room=${room}&relay=${encodeURIComponent(base)}`;
  const link = `${own || !isLocalPage() ? here : editorBase()}${query}`;
  useCollab.setState({ role: "owner", mode: "online", link, previewLink: link === `${here}${query}` ? null : `${here}${query}` });
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
  joinedDoc = false;
  roomEnded = false;
  viewing = false;
  viewFailures = 0;
  colorChanged = false;
  if (useCollab.getState().viewer) dispatch({ op: "setReadOnly", on: false }, { quiet: true });
  // Tell guests the owner stopped sharing (they keep their copy and can save it).
  if (useCollab.getState().role === "owner") send({ type: "presence", presence: { page: "", cursor: null, selection: [], owner: true, ended: true } satisfies Presence });
  stopHeartbeat();
  useCollab.setState({
    role: null,
    mode: null,
    status: "off",
    reconnecting: false,
    peers: {},
    link: null,
    previewLink: null,
    ownerGone: null,
    me: null,
    viewer: false,
    waiting: false,
    viewId: null,
    relayOld: false,
    viewError: null,
  });
  ws?.close();
  ws = null;
  unsubscribe?.();
  unsubscribe = null;
}

/** Guest: turns this copy of the shared file into their own file (no second file), leaves
 *  the room and keeps editing it. */
/** The local-file key of the shared link this page was opened with (null: not a shared link). */
function linkKey(q: URLSearchParams): string | null {
  const view = q.get("view");
  if (view) return `dt:collab:view:${view}`;
  const token = q.get("room") ?? q.get("collab");
  return token ? `dt:collab:${token}` : null;
}

export async function remixShared(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const key = linkKey(q);
  stopSharing();
  const fileId = useStore.getState().fileId;
  // Renamed after leaving, so the room doesn't get the new name.
  const name = `${getDoc().name || "Shared design"} (my copy)`;
  dispatch({ op: "setDocName", name });
  const id = fileId ?? newFileId();
  let saved = true;
  try {
    await saveFile(id, name, getEngine().save());
  } catch (e) {
    // Still editable here, and autosave keeps trying; the room has been left either way.
    saved = false;
    reportFailure("save your copy", e);
  }
  // Opening the link again joins with a fresh copy instead of this one.
  try {
    if (key) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  // Drop ?room= so a reload doesn't join again.
  history.replaceState(null, "", `${location.pathname}#/file/${id}`);
  if (id !== fileId) dispatchEvent(new HashChangeEvent("hashchange"));
  if (saved) toast("It's your own file now: changes stay with you and nobody else sees them.");
}

/** Guest who opened a link after sharing ended: drops the empty placeholder file and goes
 *  to their files. */
export async function leaveEndedRoom(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const key = linkKey(q);
  const fileId = useStore.getState().fileId;
  stopSharing();
  try {
    if (key) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  // Deleted first, so the file list it goes to doesn't show it.
  if (fileId) {
    try {
      await deleteFile(fileId);
    } catch (e) {
      reportFailure("remove the empty file", e);
    }
  }
  history.replaceState(null, "", `${location.pathname}#/`);
  dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Guest: opens (or reuses) a local file for the shared link and joins the room. */
export function joinFromUrl(): string | null {
  const key = linkKey(new URLSearchParams(location.search));
  if (!key) return null;
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
  const view = q.get("view");
  const wsBase = (http: string) => http.replace(/^http/, "ws");
  if (view) {
    // A view-only link: watches the live file; the relay only takes comments from it.
    const relay = normalizeRelay(q.get("relay") || location.origin);
    viewing = true;
    viewRelay = relay;
    wsUrl = `${wsBase(relay)}/ws?view=${encodeURIComponent(view)}`;
    useCollab.setState({ role: "guest", mode: "online", link: location.href, viewer: true });
  } else if (room) {
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

/** Extra presence fields (the visible area, following, spotlight, cursor chat), supplied by
 *  `follow.ts` at the moment presence is sent. */
let presenceSource: (() => Partial<Presence>) | null = null;
export function setPresenceSource(fn: () => Partial<Presence>) {
  presenceSource = fn;
}

let lastPresence = 0;
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
let cursor: { x: number; y: number } | null = null;

/** Reports the local cursor (page coordinates, or null when it leaves the canvas). */
export function reportCursor(p: { x: number; y: number } | null) {
  cursor = p;
  sendPresence(false);
}

/** Sends presence now, or (not `now`) at most every 40 ms. */
export function sendPresence(now: boolean) {
  if (useCollab.getState().status !== "live") return;
  const go = () => {
    lastPresence = Date.now();
    presenceTimer = null;
    const st = useStore.getState();
    const owner = useCollab.getState().role === "owner" || undefined;
    const color = colorChanged ? myColor : undefined;
    send({ type: "presence", presence: { page: st.es.page, cursor, selection: st.es.selection, owner, color, ...presenceSource?.() } satisfies Presence });
  };
  if (now) return go();
  if (presenceTimer) return;
  const wait = Math.max(0, 40 - (Date.now() - lastPresence));
  presenceTimer = setTimeout(go, wait);
}

// Automation handle (see store.ts).
(globalThis as any).__dt = { ...(globalThis as any).__dt, collab: () => useCollab.getState() };
