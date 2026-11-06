import { useState } from "react";
import { create } from "zustand";
import { Copy, Github, X } from "lucide-react";
import { leaveEndedRoom, remixShared, setMyName, useCollab } from "../collab";
import { userName } from "../canvas/Comments";

export const REPO_URL = "https://github.com/mikemich/designotron";

/** Shown (in the Share dialog and the guest bar) when the relay predates this editor. */
export const RELAY_OLD =
  "This relay is older than your editor. Newer properties (for example scrolling, gradients and effect styles) may not reach people who join later. Ask the relay's owner to update it.";

const noticeKey = "dt:relayNoticeSeen";
/** Whether the person closed the relay notice in this browser session. */
export const useRelayNotice = create<{ dismissed: boolean }>(() => {
  try {
    return { dismissed: sessionStorage.getItem(noticeKey) === "1" };
  } catch {
    return { dismissed: false };
  }
});

export function dismissRelayNotice() {
  useRelayNotice.setState({ dismissed: true });
  try {
    sessionStorage.setItem(noticeKey, "1");
  } catch {
    /* ignore */
  }
}

/** The "relay is older" note, when it applies and hasn't been closed. */
export function RelayNotice({ className = "" }: { className?: string }) {
  const relayOld = useCollab((s) => s.relayOld);
  const dismissed = useRelayNotice((s) => s.dismissed);
  if (!relayOld || dismissed) return null;
  return (
    <div className={`relay-notice ${className}`} role="status">
      <span>{RELAY_OLD}</span>
      <button className="ibtn" title="Dismiss" aria-label="Dismiss this note" onClick={dismissRelayNotice}>
        <X size={13} />
      </button>
    </div>
  );
}

/** Shown to people who opened a shared link: who they're with, and how to keep a copy. */
export function GuestBar() {
  const { role, status, peers, ownerGone, reconnecting, viewer, waiting, viewError } = useCollab();
  const [hidden, setHidden] = useState(false);
  // Guests pick a name once (others see it on their cursor and comments).
  const [asking, setAsking] = useState(() => !userName());
  const [name, setName] = useState("");
  if (role !== "guest" || hidden) return null;
  const names = Object.values(peers).map((p) => p.name);
  const who = `${names.slice(0, 2).join(" and ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""}`;
  const message = viewError
    ? viewError
    : viewer && waiting && status === "live"
      ? "Waiting for someone with edit access to open the file"
      : viewer && status === "live" && !ownerGone
        ? names.length
          ? `Viewing live with ${who}. You can view this file but not edit it.`
          : "You can view this file but not edit it."
        : ownerGone?.early
    ? `${ownerGone.name} stopped sharing this file, so there's nothing to open. Ask them for a new link.`
    : ownerGone
      ? `${ownerGone.name} ${ownerGone.how === "ended" ? "stopped sharing" : "left the file"}. Keep a copy to carry on.`
      : status !== "live"
        ? reconnecting
          ? "Connection lost: reconnecting. Your changes are kept and will be sent."
          : "Connecting to the shared file…"
        : names.length
          ? `Editing live with ${who}`
          : "You're the only one here right now";
  const saveName = () => {
    if (!name.trim()) return;
    setMyName(name);
    setAsking(false);
  };
  return (
    // Lives inside the canvas: presses on the bar or the notice must not reach its handlers.
    <div className="guest-bar-root" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
    <div className="guest-bar">
      <span className="live-dot" data-live={status === "live" && !ownerGone && !viewError} />
      <span>{message}</span>
      {asking && status === "live" && !ownerGone ? (
        <form
          className="guest-name"
          onSubmit={(e) => {
            e.preventDefault();
            saveName();
          }}
        >
          <input
            className="textinput"
            placeholder="Your name"
            aria-label="Your name, as others see it"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button className="btn small primary" type="submit" disabled={!name.trim()}>
            Join as this name
          </button>
          <button className="btn small" type="button" onClick={() => setAsking(false)}>
            Skip
          </button>
        </form>
      ) : ownerGone?.early ? (
        <button className="btn small" onClick={() => leaveEndedRoom()}>
          Go to my files
        </button>
      ) : (
        <button className="btn small" onClick={() => remixShared()} title="Keep this file as your own and edit it on your own">
          <Copy size={12} /> Make my own copy
        </button>
      )}
      <span className="guest-bar-pitch muted">
        Designotron is a free, open-source design tool with Claude built in.{" "}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          <Github size={12} /> Star on GitHub
        </a>
      </span>
      <button className="ibtn" title="Hide" onClick={() => setHidden(true)} style={{ marginLeft: "auto" }}>
        <X size={13} />
      </button>
    </div>
    <RelayNotice className="floating" />
    </div>
  );
}
