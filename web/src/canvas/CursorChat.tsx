// Cursor chat: a short message in a bubble at your cursor, shown to everyone in the file for a
// few seconds. Nothing is stored or logged; it rides on presence.

import { useEffect, useRef, useState } from "react";
import { myColor, useCollab } from "../collab";
import { CHAT_MAX, CHAT_MS, closeCursorChat, setChatText, useFollow } from "../follow";
import { useStore } from "../store";
import { PresenceBoundary } from "./PresenceBoundary";

type View = { x: number; y: number; zoom: number };

export function CursorChat({ v }: { v: View }) {
  return (
    <PresenceBoundary>
      <LocalBubble />
      <RemoteBubbles v={v} />
    </PresenceBoundary>
  );
}

/** The input bubble, following the local pointer. */
function LocalBubble() {
  const chat = useFollow((s) => s.chat);
  const live = useCollab((s) => s.status === "live" && Object.keys(s.peers).length > 0);
  // The pointer is tracked in a ref (no re-render per move); the bubble reads it when it opens
  // and follows it only while it is open.
  const pointer = useRef({ x: 80, y: 80 });
  const [at, setAt] = useState<{ x: number; y: number }>({ x: 80, y: 80 });
  const input = useRef<HTMLInputElement>(null);
  const open = chat.open;
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = document.getElementById("dt-canvas");
      if (!el) return;
      const r = el.getBoundingClientRect();
      pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (open) setAt(pointer.current);
    };
    if (open) setAt(pointer.current);
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [open]);
  useEffect(() => {
    if (chat.open) input.current?.focus({ preventScroll: true });
  }, [chat.open]);
  if (!chat.open || !live) return null;
  return (
    <div className="chat-bubble mine" style={{ left: at.x + 16, top: at.y + 18, background: myColor }}>
      <input
        ref={input}
        value={chat.text}
        maxLength={CHAT_MAX}
        aria-label="Cursor chat message"
        placeholder="Say something…"
        size={Math.max(8, Math.min(chat.text.length + 1, CHAT_MAX))}
        onChange={(e) => setChatText(e.target.value)}
        onKeyDown={(e) => {
          // Keys here are the message's, never the editor's shortcuts.
          e.stopPropagation();
          if (e.key === "Escape") {
            closeCursorChat();
            document.getElementById("dt-canvas")?.focus({ preventScroll: true });
          } else if (e.key === "Enter") {
            e.preventDefault();
            // A new message: the old one clears (an empty one just closes the bubble).
            if (chat.text) setChatText("");
            else closeCursorChat();
          }
        }}
        onBlur={() => useFollow.setState((s) => ({ chat: { ...s.chat, open: false } }))}
      />
    </div>
  );
}

/** Other people's bubbles, attached to their cursors. A bubble goes `CHAT_MS` after its last
 *  change (measured here, with this clock), or when its text is empty. */
function RemoteBubbles({ v }: { v: View }) {
  const peers = useCollab((s) => s.peers);
  const page = useStore((s) => s.es.page);
  /** Per peer: the last `chat.t` seen and when it arrived. */
  const seen = useRef(new Map<number, { t: number; at: number }>());
  const [, tick] = useState(0);
  const now = Date.now();
  for (const p of Object.values(peers)) {
    const c = p.presence?.chat;
    if (!c) continue;
    const prev = seen.current.get(p.id);
    if (!prev || prev.t !== c.t) seen.current.set(p.id, { t: c.t, at: now });
  }
  for (const id of [...seen.current.keys()]) if (!peers[id]) seen.current.delete(id);
  // Come back when the soonest visible bubble expires.
  const soonest = Math.min(...[...seen.current.values()].map((s) => s.at + CHAT_MS - now).filter((ms) => ms > 0), Infinity);
  useEffect(() => {
    if (!Number.isFinite(soonest)) return;
    const id = setTimeout(() => tick((n) => n + 1), soonest + 20);
    return () => clearTimeout(id);
  });
  return (
    <>
      {Object.values(peers).map((p) => {
        const c = p.presence?.chat;
        const s = seen.current.get(p.id);
        const cur = p.presence?.page === page ? p.presence.cursor : null;
        if (!c || !c.text || !s || now - s.at >= CHAT_MS || !cur) return null;
        return (
          <div key={p.id} className="chat-bubble" data-peer={p.id} style={{ left: cur.x * v.zoom + v.x + 16, top: cur.y * v.zoom + v.y + 38, background: p.color }}>
            {c.text}
          </div>
        );
      })}
    </>
  );
}
