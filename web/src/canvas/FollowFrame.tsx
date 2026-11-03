// The border and bars that go with following someone and with spotlights.

import { useCollab } from "../collab";
import { breakFollow, dismissSpotlight, follow, stopSpotlight, useFollow } from "../follow";

export function FollowFrame() {
  const { leader, pending, dismissed, spotlight } = useFollow();
  const peers = useCollab((s) => s.peers);
  const me = useCollab((s) => s.me);
  const lead = leader != null ? peers[leader] : undefined;
  // Someone spotlighting whom this person isn't following (and hasn't turned down).
  const offered = Object.values(peers).find((p) => (p.presence?.spotlight ?? 0) > 0 && p.id !== leader && !dismissed.includes(`${p.id}:${p.presence?.spotlight}`));
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
