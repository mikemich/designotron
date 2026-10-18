// Comment pins on the canvas, thread popovers and the new-comment composer.

import { useMemo, useState } from "react";
import { Check, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { dispatch, query, useStore } from "../store";
import type { CommentPin } from "../types";
import { askClaude } from "../ai/chatState";

type View = { x: number; y: number; zoom: number };

export function userName(): string {
  try {
    return localStorage.getItem("dt:userName") ?? "";
  } catch {
    return "";
  }
}

function setUserName(name: string) {
  try {
    localStorage.setItem("dt:userName", name);
  } catch {
    /* ignore */
  }
}

export function ago(t: number): string {
  if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

function avatarColor(name: string): string {
  if (name === "Claude") return "#D97757";
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 48%)`;
}

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, background: avatarColor(name), fontSize: size * 0.45 }} title={name}>
      {initial(name)}
    </span>
  );
}

/** Asks Claude to handle one thread (or all open ones). */
export function askClaudeAboutComments(id?: string) {
  askClaude(
    id
      ? `Address comment thread ${id}: call get_comments to read it (and look at the layer it is attached to with get_screenshot), make the change it asks for, then reply_comment saying what you changed and resolve_comment.`
      : "Address every open comment: call get_comments, then for each thread look at the attached layer (get_screenshot), make the requested change, reply_comment with what you changed, and resolve_comment. If a comment is unclear, reply with a question instead of resolving it.",
  );
}

/** Pins for the current page plus the open thread / composer. */
export function CommentLayer({ v }: { v: View }) {
  const rev = useStore((s) => s.rev);
  const page = useStore((s) => s.es.page);
  const tool = useStore((s) => s.tool);
  const leftTab = useStore((s) => s.leftTab);
  const open = useStore((s) => s.openComment);
  const draft = useStore((s) => s.draftComment);
  const pins = useMemo(() => query<CommentPin[]>({ q: "comments", page, includeResolved: true }), [rev, page]);
  const showPins = tool === "comment" || leftTab === "comments" || !!open;
  const toScreen = (x: number, y: number) => ({ left: x * v.zoom + v.x, top: y * v.zoom + v.y });
  const openPin = pins.find((p) => p.id === open);
  return (
    <>
      {showPins &&
        pins
          .filter((p) => !p.resolved || p.id === open)
          .map((p) => (
            <button
              key={p.id}
              className={"comment-pin" + (p.id === open ? " open" : "")}
              style={toScreen(p.x, p.y)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                useStore.setState({ openComment: p.id === open ? null : p.id, draftComment: null });
              }}
              title={p.messages[0]?.text}
            >
              <Avatar name={p.messages[0]?.author ?? "?"} size={24} />
              {p.messages.length > 1 && <span className="count">{p.messages.length}</span>}
            </button>
          ))}
      {openPin && <Thread pin={openPin} style={toScreen(openPin.x, openPin.y)} />}
      {draft && <Composer draft={draft} style={toScreen(draft.x, draft.y)} />}
    </>
  );
}

function NameField({ name, setName }: { name: string; setName: (n: string) => void }) {
  return (
    <input
      className="textinput"
      placeholder="Your name"
      value={name}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      style={{ marginBottom: 6 }}
    />
  );
}

function Composer({ draft, style }: { draft: { x: number; y: number; node: string | null }; style: { left: number; top: number } }) {
  const [text, setText] = useState("");
  const [name, setName] = useState(userName());
  const close = () => useStore.setState({ draftComment: null });
  const submit = () => {
    if (!text.trim()) return;
    const author = name.trim() || "Anonymous";
    setUserName(author);
    const r = dispatch<{ id: string }>({ op: "addComment", x: draft.x, y: draft.y, node: draft.node, text: text.trim(), author, time: Date.now() });
    useStore.setState({ draftComment: null, openComment: r?.id ?? null });
  };
  return (
    <div className="comment-popover" style={style} onPointerDown={(e) => e.stopPropagation()}>
      {!userName() && <NameField name={name} setName={setName} />}
      <textarea
        autoFocus
        className="textinput"
        placeholder="Add a comment… (Claude can read and resolve these)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") close();
        }}
      />
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" disabled={!text.trim()} onClick={submit}>
          Comment
        </button>
      </div>
    </div>
  );
}

function Thread({ pin, style }: { pin: CommentPin; style: { left: number; top: number } }) {
  const [reply, setReply] = useState("");
  const [name, setName] = useState(userName());
  const send = () => {
    if (!reply.trim()) return;
    const author = name.trim() || "Anonymous";
    setUserName(author);
    dispatch({ op: "replyComment", id: pin.id, text: reply.trim(), author, time: Date.now() });
    setReply("");
  };
  return (
    <div className="comment-popover" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <div className="row" style={{ marginBottom: 6, gap: 2 }}>
        <span className="muted small" style={{ flex: 1 }}>
          {pin.nodeName ? `On “${pin.nodeName}”` : "Comment"}
          {pin.resolved ? " · resolved" : ""}
        </span>
        <button className="ibtn" title="Ask Claude to handle this" onClick={() => askClaudeAboutComments(pin.id)}>
          <Sparkles size={13} />
        </button>
        <button className="ibtn" title={pin.resolved ? "Reopen" : "Resolve"} onClick={() => dispatch({ op: "resolveComment", id: pin.id, resolved: !pin.resolved })}>
          {pin.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
        </button>
        <button className="ibtn" title="Delete thread" onClick={() => (dispatch({ op: "deleteComment", id: pin.id }), useStore.setState({ openComment: null }))}>
          <Trash2 size={13} />
        </button>
        <button className="ibtn" title="Close" onClick={() => useStore.setState({ openComment: null })}>
          <X size={13} />
        </button>
      </div>
      <div className="comment-messages">
        {pin.messages.map((m, i) => (
          <div key={i} className="comment-message">
            <Avatar name={m.author} />
            <div>
              <div className="small">
                <b>{m.author}</b> <span className="muted">{ago(m.time)}</span>
              </div>
              <div className="comment-text">{m.text}</div>
            </div>
          </div>
        ))}
      </div>
      {!userName() && <NameField name={name} setName={setName} />}
      <input
        className="textinput"
        placeholder="Reply…"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") send();
          if (e.key === "Escape") useStore.setState({ openComment: null });
        }}
      />
    </div>
  );
}
