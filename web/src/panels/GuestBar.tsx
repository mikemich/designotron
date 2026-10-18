import { useState } from "react";
import { Copy, Github, X } from "lucide-react";
import { remixShared, useCollab } from "../collab";

export const REPO_URL = "https://github.com/mikemich/designotron";

/** Shown to people who opened a shared link: who they're with, and how to keep a copy. */
export function GuestBar() {
  const { role, status, peers } = useCollab();
  const [hidden, setHidden] = useState(false);
  if (role !== "guest" || hidden) return null;
  const names = Object.values(peers).map((p) => p.name);
  const who = names.length ? `with ${names.slice(0, 2).join(" and ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""}` : "";
  return (
    <div className="guest-bar">
      <span className="live-dot" data-live={status === "live"} />
      <span>{status === "live" ? `Editing live ${who}` : "Connecting to the shared file…"}</span>
      <button className="btn small" onClick={() => remixShared()} title="Keep a copy in your own files and edit it on your own">
        <Copy size={12} /> Make my own copy
      </button>
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
