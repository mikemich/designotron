// Presence beyond cursors: following someone's view, spotlighting yourself, and cursor chat.
//
// All of it travels as optional keys of the presence blob the relay passes on untouched (see
// `Presence` in collab.ts), so it works on any relay and old editors ignore it.
//
// Following: a follower fits the leader's `view` rectangle to its own canvas whenever the
// leader's presence arrives. Anything the person does to their own view (pan, zoom, switching
// page) ends it; the changes following itself makes are marked with `applying` so they don't.

import { create } from "zustand";
import { sendPresence, setPresenceSource, useCollab, type Peer, type Presence } from "./collab";
import { canvasSize, dispatch, getDoc, toast, useStore } from "./store";
import type { Tool } from "./types";

/** How long "<Name> is spotlighting" waits (with "Not now") before following. */
export const SPOTLIGHT_WAIT_MS = 3000;
/** A cursor chat message stays this long after its last change. */
export const CHAT_MS = 5000;
/** Longest cursor chat message. */
export const CHAT_MAX = 52;

interface FollowState {
  /** The peer being followed. */
  leader: number | null;
  /** The spotlight (its timestamp) this follow began from; null when started by hand. */
  via: number | null;
  /** A spotlight announced, counting down to following it. */
  pending: { peer: number; spot: number } | null;
  /** Spotlights the person said "Not now" to (`peer:timestamp`). */
  dismissed: string[];
  /** This person's own spotlight (a timestamp; 0 when off). */
  spotlight: number;
  /** The local cursor chat: `text` is the draft in the input, `shown` the message everyone
   *  sees (it outlives the draft after Enter, until `CHAT_MS`). `t` counts changes. */
  chat: { open: boolean; text: string; shown: string; t: number };
}

export const useFollow = create<FollowState>(() => ({
  leader: null,
  via: null,
  pending: null,
  dismissed: [],
  spotlight: 0,
  chat: { open: false, text: "", shown: "", t: 0 },
}));

/** True while following itself moves the view (so it isn't taken for the person moving it). */
let applying = false;
let lastApplied = "";
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
/** The spotlight (`peer:timestamp`) the bar was last shown for, to notice a new one. */
let seenKey = "";

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 256;

/** The page-space rectangle the canvas shows, or undefined before the canvas exists. */
function currentView(): Presence["view"] {
  if (!document.getElementById("dt-canvas")) return undefined;
  const { viewport: v } = useStore.getState();
  const { w, h } = canvasSize();
  if (!w || !h || !v.zoom) return undefined;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { x: r(-v.x / v.zoom), y: r(-v.y / v.zoom), w: r(w / v.zoom), h: r(h / v.zoom) };
}

setPresenceSource(() => {
  const { leader, spotlight, chat } = useFollow.getState();
  return {
    view: currentView(),
    following: leader ?? undefined,
    spotlight: spotlight || undefined,
    chat: chat.t ? { text: chat.shown, t: chat.t } : undefined,
  };
});

/** True if following `peer` would come back to this person: `peer` follows someone who follows
 *  someone ... who follows me. The walk is bounded by the number of people. */
function loopsBackToMe(peer: number): boolean {
  const { me, peers } = useCollab.getState();
  if (me == null) return false;
  let cur = peer;
  for (let i = 0; i <= Object.keys(peers).length; i++) {
    const next = peers[cur]?.presence?.following;
    if (next == null) return false;
    if (next === me) return true;
    cur = next;
  }
  return false;
}

/** Starts following `peer` (their page and view, at once), or stops with null. `via` is the
 *  spotlight that started it. */
export function follow(peer: number | null, via: number | null = null) {
  const c = useCollab.getState();
  if (peer != null && peer === c.me) return;
  // Following each other (or in a ring) would chase one view round and round.
  if (peer != null && loopsBackToMe(peer)) {
    toast(`Following ${c.peers[peer]?.name ?? "them"} would loop back to you: they follow you, directly or through others`);
    return;
  }
  clearPending();
  lastApplied = "";
  useFollow.setState({ leader: peer, via: peer == null ? null : via });
  if (peer != null) applyLeader();
  sendPresence(true);
}

/** Stops following (the person moved their own view, pressed Escape, or clicked Stop). */
export function breakFollow() {
  if (useFollow.getState().leader == null) return;
  follow(null);
}

export const isFollowing = () => useFollow.getState().leader != null;

/** Click on a person's avatar: follow them, or stop when already following them. */
export function toggleFollow(peer: number) {
  if (useFollow.getState().leader === peer) breakFollow();
  else follow(peer);
}

export function startSpotlight() {
  useFollow.setState({ spotlight: Date.now() });
  sendPresence(true);
}

export function stopSpotlight() {
  useFollow.setState({ spotlight: 0 });
  sendPresence(true);
}

/** "Not now": ignore this spotlight. */
export function dismissSpotlight() {
  const { pending } = useFollow.getState();
  if (!pending) return;
  useFollow.setState((s) => ({ dismissed: [...s.dismissed, `${pending.peer}:${pending.spot}`].slice(-50) }));
  clearPending();
}

function clearPending() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  if (useFollow.getState().pending) useFollow.setState({ pending: null });
}

/** Fits the leader's view to this canvas (and switches to their page). */
function applyLeader() {
  const { leader } = useFollow.getState();
  if (leader == null) return;
  const c = useCollab.getState();
  const p = c.peers[leader];
  if (!p) return endFollow();
  if (loopsBackToMe(leader)) {
    toast(`Stopped following ${p.name}: they follow you, directly or through others`);
    return endFollow();
  }
  const view = p.presence?.view;
  const page = p.presence?.page;
  if (!view || !page || !(view.w > 0) || !(view.h > 0)) return;
  const { w, h } = canvasSize();
  if (!w || !h) return;
  const key = `${page}|${view.x}|${view.y}|${view.w}|${view.h}|${w}|${h}`;
  if (key === lastApplied) return;
  applying = true;
  try {
    if (page !== useStore.getState().es.page) {
      // The page may not have reached this editor yet: try again with the next update.
      if (!getDoc().pages.some((x) => x.id === page)) return;
      dispatch({ op: "setPage", id: page }, { quiet: true });
    }
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(w / view.w, h / view.h)));
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    useStore.setState({ viewport: { zoom, x: w / 2 - cx * zoom, y: h / 2 - cy * zoom } });
    lastApplied = key;
  } finally {
    applying = false;
  }
}

/** The leader left: stop quietly. */
function endFollow() {
  useFollow.setState({ leader: null, via: null });
  lastApplied = "";
  sendPresence(true);
}

/** The one spotlight in force: the newest; on a tie the lower id. The timestamps come from each
 *  person's own clock, so with clocks that disagree "newest" is approximate (everyone still
 *  picks the same winner, since they compare the same numbers). `mine` is this person's own. */
export function winningSpotlight(peers: Record<number, Peer>, me: number | null, mine: number): { id: number; spot: number } | null {
  let best: { id: number; spot: number } | null = null;
  const consider = (id: number, spot: number) => {
    if (!(spot > 0)) return;
    if (!best || spot > best.spot || (spot === best.spot && id < best.id)) best = { id, spot };
  };
  for (const p of Object.values(peers)) consider(p.id, p.presence?.spotlight ?? 0);
  if (me != null) consider(me, mine);
  return best;
}

/** Notices spotlights starting and ending. Only one counts at a time (see `winningSpotlight`);
 *  a spotlight that was overtaken ends. */
function checkSpotlights(peers: Record<number, Peer>) {
  const { me } = useCollab.getState();
  const f = useFollow.getState();
  const w = winningSpotlight(peers, me, f.spotlight);
  if (f.spotlight > 0 && w && w.id !== me) stopSpotlight();
  if (f.pending && (!w || w.id !== f.pending.peer || w.spot !== f.pending.spot)) clearPending();
  // A follow that came from a spotlight ends with it.
  if (f.leader != null && f.via != null && !((peers[f.leader]?.presence?.spotlight ?? 0) > 0)) follow(null);
  if (!w || w.id === me) {
    seenKey = "";
    return;
  }
  const key = `${w.id}:${w.spot}`;
  if (key === seenKey) return;
  seenKey = key;
  const now = useFollow.getState();
  if (now.leader === w.id || now.dismissed.includes(key)) return;
  clearPending();
  useFollow.setState({ pending: { peer: w.id, spot: w.spot } });
  pendingTimer = setTimeout(() => {
    const cur = useFollow.getState().pending;
    if (cur && cur.peer === w.id && cur.spot === w.spot) follow(w.id, w.spot);
  }, SPOTLIGHT_WAIT_MS);
}

/** This canvas changed size (window, panels): refit the leader's view, and tell followers. */
export function onCanvasResize() {
  lastApplied = "";
  applyLeader();
  sendPresence(false);
}

useCollab.subscribe((s, prev) => {
  if (s.peers !== prev.peers) {
    checkSpotlights(s.peers);
    applyLeader();
  }
  if (s.status === "off" && prev.status !== "off") {
    // Sharing ended: nothing to follow or announce any more.
    clearPending();
    seenKey = "";
    useFollow.setState({ leader: null, via: null, spotlight: 0, chat: { open: false, text: "", shown: "", t: 0 } });
  }
});

/** What a view-only editor may use besides looking: moving around and comments. */
const VIEW_TOOLS: Tool[] = ["move", "hand", "comment"];

useStore.subscribe((s, prev) => {
  const moved = s.viewport !== prev.viewport || s.es.page !== prev.es.page;
  if (moved) {
    // The person did it (following marks its own moves): they take the view back.
    if (!applying && useFollow.getState().leader != null) breakFollow();
    // Followers of this editor need the new view.
    sendPresence(false);
  }
  if (s.es.readOnly && !VIEW_TOOLS.includes(s.tool)) useStore.setState({ tool: "move" });
});

// Escape with nothing else to close stops following. Registered before the editor's own
// shortcuts, so it sees the selection as it was when the key went down.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || useFollow.getState().leader == null) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.("input, textarea, select, [role=menu], .menu, [role=dialog]") || t?.isContentEditable) return;
  const st = useStore.getState();
  if (st.es.selection.length || st.editingText || st.editingVector || st.tool !== "move") return;
  breakFollow();
});

// ---------- Cursor chat ----------

let chatTimer: ReturnType<typeof setTimeout> | null = null;

/** Cursor chat needs someone to talk to, and a live connection. */
export function canOpenCursorChat(): boolean {
  const c = useCollab.getState();
  return c.status === "live" && Object.keys(c.peers).length > 0;
}

export function openCursorChat() {
  if (!canOpenCursorChat()) return;
  useFollow.setState((s) => ({ chat: { ...s.chat, open: true } }));
  armChatTimer();
}

/** The draft changed (typing): what everyone sees follows it. */
export function setChatText(text: string) {
  const t = text.slice(0, CHAT_MAX);
  useFollow.setState((s) => ({ chat: { open: true, text: t, shown: t, t: s.chat.t + 1 } }));
  sendPresence(false);
  armChatTimer();
}

/** Enter: the draft clears for the next message while the sent one stays up for everyone
 *  for another `CHAT_MS`. */
export function sendChatMessage() {
  useFollow.setState((s) => ({ chat: { ...s.chat, open: true, text: "", t: s.chat.t + 1 } }));
  sendPresence(false);
  armChatTimer();
}

/** Escape or the message's time is up: the bubble goes away for everyone. */
export function closeCursorChat() {
  if (chatTimer) clearTimeout(chatTimer);
  chatTimer = null;
  const { chat } = useFollow.getState();
  if (!chat.open && !chat.text && !chat.shown) return;
  useFollow.setState({ chat: { open: false, text: "", shown: "", t: chat.t + 1 } });
  sendPresence(true);
}

/** The bubble stays up for `CHAT_MS` after the last change. */
function armChatTimer() {
  if (chatTimer) clearTimeout(chatTimer);
  chatTimer = setTimeout(closeCursorChat, CHAT_MS);
}
