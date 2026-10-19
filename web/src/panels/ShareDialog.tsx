import { useEffect, useState } from "react";
import { Check, Copy, Globe, Link2, Loader2, Share2, Users, Wifi, X } from "lucide-react";
import { copyUrl, encodeFile, linkBase, viewUrl } from "../snapshot";
import { myColor, pageIsRelay, relayUrl, remixShared, startOnline, startSharing, stopSharing, useCollab } from "../collab";
import { useChat } from "../ai/chatState";
import { userName } from "../canvas/Comments";
import { useDialog } from "../ui/controls";

const RELAY_DOCS = "https://github.com/mikemich/designotron/blob/main/docs/relay.md";

type CopyKind = "copy" | "view" | "embed" | "badge";

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
  const [copyState, setCopyState] = useState<CopyKind | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [copyBusy, setCopyBusy] = useState<CopyKind | null>(null);
  /** Shown to copy by hand when the clipboard isn't available. */
  const [manual, setManual] = useState<string | null>(null);
  /** Copies a link (or snippet) that carries this file: no server involved. */
  const sendCopy = async (kind: CopyKind) => {
    setError(null);
    setCopyNote(null);
    setCopyBusy(kind);
    try {
      const { data, withoutImages } = await encodeFile();
      const text = {
        copy: copyUrl(data),
        view: viewUrl(data),
        embed: `<iframe src="${viewUrl(data)}" width="800" height="600" style="border:1px solid #3a3a3a;border-radius:8px" allowfullscreen></iframe>`,
        badge: `[![Open in Designotron](${linkBase()}badge.svg)](${copyUrl(data)})`,
      }[kind];
      const copied = await (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(
        () => true,
        () => false,
      );
      const notes: string[] = [];
      if (!copied) setManual(text);
      else {
        setManual(null);
        setCopyState(kind);
        setTimeout(() => setCopyState(null), 2000);
      }
      const what = { copy: "link", view: "link", embed: "embed code", badge: "badge" }[kind];
      const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(1)}k`);
      if (withoutImages) notes.push(`Images were left out to keep the ${what} short; send a .dtron file to include them.`);
      if (kind === "copy" || kind === "view") {
        // Links over these lengths get cut off or rejected by common chat apps.
        if (text.length > 30_000) notes.push(`This link is ${k(text.length)} characters: too long for Slack, Teams and Discord. Email it, or send a .dtron file.`);
        else if (text.length > 2_000) notes.push(`This link is ${k(text.length)} characters: fine for Slack, email and most chats, too long for Discord and SMS.`);
      } else if (text.length > 30_000) {
        // Snippets are pasted into pages, not chats; only very long ones run into limits.
        notes.push(`This ${what} is ${k(text.length)} characters, more than some sites accept in one paste. A smaller file (or one without images) makes it shorter.`);
      }
      setCopyNote(notes.join(" ") || null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setCopyBusy(null);
    }
  };
  const close = () => useCollab.setState({ dialogOpen: false });
  const dialogRef = useDialog(close);

  // An editor served by a relay can share online with no setup.
  useEffect(() => {
    if (!relay) pageIsRelay().then((yes) => yes && (setRelay(location.origin), setCustomRelay(false)));
  }, []);

  const copy = (text: string, input?: HTMLInputElement | null) => {
    (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      // No clipboard access: select the link so it can be copied by hand.
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
      <div ref={dialogRef} className="modal share-dialog" role="dialog" aria-modal="true" aria-label="Share" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Share</b>
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
                <button className="btn" disabled={!!busy} onClick={() => sendCopy("copy")}>
                  {copyBusy === "copy" ? <Loader2 size={13} className="spin" /> : copyState === "copy" ? <Check size={13} /> : <Link2 size={13} />}{" "}
                  {copyState === "copy" ? "Link copied" : "Copy link"}
                </button>
                <div className="copy-kinds small">
                  {(
                    [
                      ["view", "View-only link", "A link that plays the design (clickable prototype) with a Remix button"],
                      ["embed", "Embed code", "An <iframe> for blogs, docs and Notion"],
                      ["badge", "README badge", "An 'Open in Designotron' badge for a GitHub README"],
                    ] as const
                  ).map(([kind, label, title]) => (
                    <button key={kind} className="link-btn" title={title} onClick={() => sendCopy(kind)}>
                      {copyBusy === kind ? "Copying…" : copyState === kind ? "Copied ✓" : label}
                    </button>
                  ))}
                </div>
                {manual && (
                  <>
                    <div className="small">Your browser blocked copying. Select this and copy it:</div>
                    <textarea className="textinput mono" readOnly rows={3} value={manual} onFocus={(e) => e.target.select()} autoFocus />
                  </>
                )}
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
                  <span className="avatar" style={{ width: 22, height: 22, background: myColor, fontSize: 10 }}>
                    {(userName() || "You")[0].toUpperCase()}
                  </span>
                  {userName() ? `${userName()} (you)` : "You"}
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
              {role === "owner" && mode === "online" && (
                <div className="muted small" style={{ marginTop: 6 }}>
                  Stopping ends this link: anyone who opens it later is told you stopped sharing and keeps their own copy. Sharing again makes a new link.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
