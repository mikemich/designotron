import { useState } from "react";
import { Copy, Loader2, Users, X } from "lucide-react";
import { startSharing, stopSharing, useCollab } from "../collab";
import { useChat } from "../ai/chatState";
import { Avatar, userName } from "../canvas/Comments";

/** Share → invite people on the same network to edit this file live. */
export function ShareDialog() {
  const { status, role, link, peers } = useCollab();
  const bridgeStatus = useChat((s) => s.bridgeStatus);
  const [name, setName] = useState(userName());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useCollab.setState({ dialogOpen: false });
  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      if (name.trim()) localStorage.setItem("dt:userName", name.trim());
      await startSharing();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  const list = Object.values(peers);
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal share-dialog" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Share for live editing</b>
          <button className="ibtn" title="Close" onClick={close} style={{ marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
        <div className="figma-body">
          {!role ? (
            <>
              <div className="muted small" style={{ lineHeight: 1.6, marginBottom: 8 }}>
                People on your network open a link and edit this file with you in real time: live cursors, selections and changes. Each layer's latest edit wins. Your
                computer hosts the session through the Designotron bridge; only the editor and the shared file are exposed, behind a secret link.
              </div>
              <label className="small muted">Your name</label>
              <input className="textinput" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown next to your cursor" />
              {bridgeStatus !== "connected" && <div className="error-box">Live sharing needs the bridge running on this computer (npx designotron).</div>}
              {error && <div className="error-box">{error}</div>}
              <button className="btn primary" style={{ marginTop: 10 }} disabled={busy || bridgeStatus !== "connected"} onClick={start}>
                {busy ? <Loader2 size={13} className="spin" /> : <Users size={13} />} Start sharing
              </button>
            </>
          ) : (
            <>
              <div className="small muted">{role === "owner" ? "Send this link to people on your network:" : "You joined a shared file."}</div>
              {role === "owner" && link && (
                <div className="row" style={{ marginTop: 6 }}>
                  <input className="textinput mono" readOnly value={link} onFocus={(e) => e.target.select()} />
                  <button className="btn" onClick={() => navigator.clipboard.writeText(link)}>
                    <Copy size={13} /> Copy
                  </button>
                </div>
              )}
              <div className="small" style={{ marginTop: 12 }}>
                {status === "live" ? `${list.length + 1} people here` : "Connecting…"}
              </div>
              <div className="share-peers">
                <div className="row">
                  <Avatar name={userName() || "You"} /> {userName() || "You"} (you)
                </div>
                {list.map((p) => (
                  <div key={p.id} className="row">
                    <span className="avatar" style={{ width: 22, height: 22, background: p.color, fontSize: 10 }}>
                      {p.name[0]?.toUpperCase()}
                    </span>
                    {p.name}
                  </div>
                ))}
              </div>
              <button className="btn" style={{ marginTop: 10 }} onClick={() => (stopSharing(), close())}>
                {role === "owner" ? "Stop sharing" : "Leave"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
