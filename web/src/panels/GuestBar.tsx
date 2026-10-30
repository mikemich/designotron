import { useState } from "react";
import { Copy, Github, X } from "lucide-react";
import { leaveEndedRoom, remixShared, setMyName, useCollab } from "../collab";
import { userName } from "../canvas/Comments";

export const REPO_URL = "https://github.com/mikemich/designotron";

/** Shown to people who opened a shared link: who they're with, and how to keep a copy. */
export function GuestBar() {
  const { role, status, peers, ownerGone, reconnecting } = useCollab();
  const [hidden, setHidden] = useState(false);
  // Guests pick a name once (others see it on their cursor and comments).
  const [asking, setAsking] = useState(() => !userName());
  const [name, setName] = useState("");
  if (role !== "guest" || hidden) return null;
  const names = Object.values(peers).map((p) => p.name);
  const who = `${names.slice(0, 2).join(" and ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""}`;
  const message = ownerGone?.early
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
    <div className="guest-bar">
      <span className="live-dot" data-live={status === "live" && !ownerGone} />
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
  );
}
