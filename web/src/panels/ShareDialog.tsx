import { useEffect, useState } from "react";
import { Check, Copy, Globe, Link2, Loader2, Share2, Users, Wifi, X } from "lucide-react";
import { copyLink } from "../snapshot";
import { pageIsRelay, relayUrl, remixShared, startOnline, startSharing, stopSharing, useCollab } from "../collab";
import { useChat } from "../ai/chatState";
import { Avatar, userName } from "../canvas/Comments";
import { useEscape } from "../ui/controls";

const RELAY_DOCS = "https://github.com/mikemich/designotron/blob/main/docs/relay.md";

/** Share → invite people to edit this file live, online (through a relay) or on the local network. */
export function ShareDialog() {
  const { status, role, mode, link, peers } = useCollab();
  const bridgeStatus = useChat((s) => s.bridgeStatus);
  const [name, setName] = useState(userName());
  const [relay, setRelay] = useState(relayUrl());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"online" | "lan" | null>(null);
  // The built-in relay needs no explanation; the address field is for people who run their own.
  const [customRelay, setCustomRelay] = useState(!relayUrl());
  const [copied, setCopied] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const sendCopy = async () => {
    setError(null);
    try {
      const { url, withoutImages } = await copyLink();
      await navigator.clipboard.writeText(url).catch(() => prompt("Copy this link:", url));
      setCopyState("copied");
      setCopyNote(withoutImages ? "Images were left out to keep the link short; send a .dtron file to include them." : null);
      setTimeout(() => setCopyState("idle"), 2000);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  const close = () => useCollab.setState({ dialogOpen: false });
  useEscape(close);

  // An editor served by a relay can share online with no setup.
  useEffect(() => {
    if (!relay) pageIsRelay().then((yes) => yes && (setRelay(location.origin), setCustomRelay(false)));
  }, []);

  const copy = (text: string, input?: HTMLInputElement | null) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => input?.select(),
    );
  };
  const invite = () => navigator.share?.({ title: "Design with me in Designotron", url: link ?? "" }).catch(() => {});

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
                {customRelay ? (
                  <>
                    <input className="textinput mono" value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="Relay address, e.g. https://designotron-relay.fly.dev" />
                    <div className="muted small" style={{ lineHeight: 1.5 }}>
                      Rooms are hosted on a Designotron relay: a small open-source server.{" "}
                      <a href={RELAY_DOCS} target="_blank" rel="noreferrer">
                        Deploy one in a few minutes
                      </a>
                      .
                    </div>
                  </>
                ) : (
                  <div className="muted small" style={{ lineHeight: 1.5 }}>
                    You get a link; whoever opens it edits with you, no account needed.{" "}
                    <a href="#" onClick={(e) => (e.preventDefault(), setCustomRelay(true))}>
                      Use a different relay
                    </a>
                  </div>
                )}
                <button className="btn primary" disabled={!!busy || !relay.trim()} onClick={() => start("online")}>
                  {busy === "online" ? <Loader2 size={13} className="spin" /> : <Globe size={13} />} Share online
                </button>
              </div>

              <div className="share-option">
                <div className="row" style={{ gap: 6 }}>
                  <Link2 size={14} /> <b>Send a copy</b>
                  <span className="muted small">no server, works anytime</span>
                </div>
                <div className="muted small" style={{ lineHeight: 1.5 }}>
                  A link that contains this file. Whoever opens it gets their own copy to remix; your file stays yours.
                </div>
                <button className="btn" disabled={!!busy} onClick={sendCopy}>
                  {copyState === "copied" ? <Check size={13} /> : <Link2 size={13} />} {copyState === "copied" ? "Link copied" : "Copy link to a copy"}
                </button>
                {copyNote && <div className="muted small">{copyNote}</div>}
              </div>

              <div className="share-option">
                <div className="row" style={{ gap: 6 }}>
                  <Wifi size={14} /> <b>Local network</b>
                  <span className="muted small">same Wi-Fi, no server needed</span>
                </div>
                <div className="muted small" style={{ lineHeight: 1.5 }}>
                  Your computer hosts the session through the Designotron bridge, behind a secret link.
                </div>
                <button className="btn" disabled={!!busy || bridgeStatus !== "connected"} onClick={() => start("lan")} title={bridgeStatus !== "connected" ? "Needs the Designotron bridge (setup steps in the Claude panel)" : ""}>
                  {busy === "lan" ? <Loader2 size={13} className="spin" /> : <Users size={13} />} Share on this network
                </button>
              </div>
              {error && <div className="error-box">{error}</div>}
            </>
          ) : (
            <>
              <div className="small muted">
                {role === "owner" ? (mode === "online" ? "Send this link to the people you want to design with:" : "Send this link to people on your network:") : `You joined a shared file${mode === "online" ? " (online)" : ""}.`}
              </div>
              {role === "owner" && link && (
                <>
                  <div className="row" style={{ marginTop: 6 }}>
                    <input id="share-link" className="textinput mono" readOnly value={link} onFocus={(e) => e.target.select()} />
                    <button className="btn primary" onClick={() => copy(link, document.getElementById("share-link") as HTMLInputElement)}>
                      {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  {"share" in navigator && (
                    <button className="btn" style={{ marginTop: 8 }} onClick={invite}>
                      <Share2 size={13} /> Invite…
                    </button>
                  )}
                  <div className="muted small" style={{ marginTop: 8 }}>
                    Anyone with the link can edit, so send it only to people you trust.
                  </div>
                </>
              )}
              {role === "guest" && (
                <button className="btn primary" style={{ marginTop: 8 }} onClick={() => (remixShared(), close())}>
                  <Copy size={13} /> Make my own copy
                </button>
              )}
              <div className="small" style={{ marginTop: 12 }}>
                {status !== "live" ? "Connecting…" : list.length ? `${list.length + 1} people here` : "Just you so far"}
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
