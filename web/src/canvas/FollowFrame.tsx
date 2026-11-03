// The border and bars that go with following someone and with spotlights.

import { useCollab } from "../collab";
import { useEffect } from "react";
import { breakFollow, dismissSpotlight, follow, onCanvasResize, stopSpotlight, useFollow, winningSpotlight } from "../follow";
import { PresenceBoundary } from "./PresenceBoundary";

export function FollowFrame() {
  return (
    <PresenceBoundary>
      <Frame />
    </PresenceBoundary>
  );
}

function Frame() {
  // Followers refit to this canvas's size, so a panel opening or a window resize counts.
  useEffect(() => {
    const el = document.getElementById("dt-canvas");
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => onCanvasResize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { leader, pending, dismissed, spotlight } = useFollow();
  const peers = useCollab((s) => s.peers);
  const me = useCollab((s) => s.me);
  const lead = leader != null ? peers[leader] : undefined;
  // Someone spotlighting whom this person isn't following (and hasn't turned down).
  const win = winningSpotlight(peers, me, spotlight);
  const offered = win && win.id !== me && win.id !== leader && !dismissed.includes(`${win.id}:${win.spot}`) ? peers[win.id] : undefined;
  const waiting = pending ? peers[pending.peer] : undefined;
  const followers = Object.values(peers).filter((p) => me != null && p.presence?.following === me).length;
  return (
    <>
      {lead && <div className="follow-frame" style={{ borderColor: lead.color }} />}
      <div className="follow-bars">
        {lead ? (
          <div className="follow-bar" role="status" style={{ ["--ring" as string]: lead.color }}>
            <span className="follow-dot" style={{ background: lead.color }} />
            <span>Following {lead.name}</span>
            <button className="btn small" onClick={breakFollow}>
              Stop following
            </button>
          </div>
        ) : waiting ? (
          <div className="follow-bar" role="status" style={{ ["--ring" as string]: waiting.color }}>
            <span className="follow-dot" style={{ background: waiting.color }} />
            <span>{waiting.name} is spotlighting</span>
            <button className="btn small" onClick={dismissSpotlight}>
              Not now
            </button>
          </div>
        ) : offered ? (
          <div className="follow-bar" role="status" style={{ ["--ring" as string]: offered.color }}>
            <span className="follow-dot" style={{ background: offered.color }} />
            <span>{offered.name} is spotlighting</span>
            <button className="btn small primary" onClick={() => follow(offered.id, offered.presence?.spotlight ?? null)}>
              Follow
            </button>
          </div>
        ) : null}
        {spotlight > 0 && (
          <div className="follow-bar mine" role="status">
            <span>
              You're spotlighting · {followers} following
            </span>
            <button className="btn small" onClick={stopSpotlight}>
              Stop
            </button>
          </div>
        )}
      </div>
    </>
  );
}
