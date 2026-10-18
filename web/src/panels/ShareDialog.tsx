import { useEffect, useState } from "react";
import { Copy, Globe, Loader2, Users, Wifi, X } from "lucide-react";
import { pageIsRelay, relayUrl, startOnline, startSharing, stopSharing, useCollab } from "../collab";
import { useChat } from "../ai/chatState";
import { Avatar, userName } from "../canvas/Comments";

const RELAY_DOCS = "https://github.com/mikemich/designotron/blob/main/docs/relay.md";

/** Share → invite people to edit this file live, online (through a relay) or on the local network. */
export function ShareDialog() {
  const { status, role, mode, link, peers } = useCollab();
  const bridgeStatus = useChat((s) => s.bridgeStatus);
  const [name, setName] = useState(userName());
  const [relay, setRelay] = useState(relayUrl());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"online" | "lan" | null>(null);
  const close = () => useCollab.setState({ dialogOpen: false });

  // An editor served by a relay can share online with no setup.
  useEffect(() => {
    if (!relay) pageIsRelay().then((yes) => yes && setRelay(location.origin));
  }, []);

  const start = async (how: "online" | "lan") => {
    setError(null);
    setBusy(how);
    try {
      if (name.trim()) localStorage.setItem("dt:userName", name.trim());
      if (how === "online") await startOnline(relay);
      else await startSharing();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
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
              <label className="small muted">Your name</label>
              <input className="textinput" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown next to your cursor" />

              <div className="share-option">
                <div className="row" style={{ gap: 6 }}>
                  <Globe size={14} /> <b>Online</b>
                  <span className="muted small">anyone with the link, anywhere</span>
                </div>
                <input className="textinput mono" value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="Relay address, e.g. https://designotron-relay.fly.dev" />
                <div className="muted small" style={{ lineHeight: 1.5 }}>
                  Rooms are hosted on a Designotron relay: a small open-source server.{" "}
                  <a href={RELAY_DOCS} target="_blank" rel="noreferrer">
                    Deploy one in a few minutes
                  </a>
                  .
                </div>
                <button className="btn primary" disabled={!!busy || !relay.trim()} onClick={() => start("online")}>
                  {busy === "online" ? <Loader2 size={13} className="spin" /> : <Globe size={13} />} Share online
                </button>
              </div>

              <div className="share-option">
                <div className="row" style={{ gap: 6 }}>
                  <Wifi size={14} /> <b>Local network</b>
                  <span className="muted small">same Wi-Fi, no server needed</span>
                </div>
                <div className="muted small" style={{ lineHeight: 1.5 }}>
                  Your computer hosts the session through the Designotron bridge, behind a secret link.
                </div>
                <button className="btn" disabled={!!busy || bridgeStatus !== "connected"} onClick={() => start("lan")} title={bridgeStatus !== "connected" ? "Needs the bridge (npx designotron)" : ""}>
                  {busy === "lan" ? <Loader2 size={13} className="spin" /> : <Users size={13} />} Share on this network
                </button>
              </div>
              {error && <div className="error-box">{error}</div>}
            </>
          ) : (
            <>
              <div className="small muted">
                {role === "owner" ? (mode === "online" ? "Anyone with this link can edit with you:" : "Send this link to people on your network:") : `You joined a shared file${mode === "online" ? " (online)" : ""}.`}
              </div>
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
