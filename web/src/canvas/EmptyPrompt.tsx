import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { askClaude, claudeReady, discardQueued, sendQueued, useChat, useQueueConfirm } from "../ai/chatState";
import { playDemo } from "../Demo";
import { TEMPLATES } from "../templates";
import { closeEmptyPrompt, dispatch, zoomToFit } from "../store";

const IDEAS = ["A landing page for a coffee subscription", "A habit tracker mobile app, 3 screens", "An admin dashboard for an online store"];

/** A queued prompt, shortened for display. */
const preview = (q: string) => (q.length > 160 ? q.slice(0, 160) + "…" : q);

/** After the first close (`closeEmptyPrompt`) blank files show a one-line pill instead of the centred card. */
function compactPref(): boolean {
  try {
    return localStorage.getItem("dt:emptyPrompt") === "compact";
  } catch {
    return false;
  }
}

/** Shown on an empty page: describe a design for Claude, or start from a template. */
export function EmptyPrompt({ pageId }: { pageId: string }) {
  const [text, setText] = useState("");
  // Read once per mount: closing the card must not turn the next frame of this very file into a pill.
  const [compact, setCompact] = useState(compactPref);
  const [grab, setGrab] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (grab && !compact) input.current?.focus();
  }, [grab, compact]);
  const ready = useChat((s) => claudeReady(s));
  const queued = useChat((s) => s.queued);
  const running = useChat((s) => s.running);
  const stale = useQueueConfirm((s) => s.stale);
  const send = (prompt: string) => {
    if (!prompt.trim()) return;
    // A new message replaces a queued one that was waiting for confirmation.
    if (useQueueConfirm.getState().stale) discardQueued();
    askClaude(prompt.trim());
    setText("");
  };
  const pill = compact && !running && !queued;
  if (pill)
    return (
      <button
        className="empty-pill"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={() => {
          setCompact(false);
          setGrab(true);
        }}
      >
        <Sparkles size={13} />
        <span>Describe a design for Claude…</span>
        <span className="empty-pill-sep" aria-hidden="true" />
        <span className="muted">Templates</span>
      </button>
    );
  return (
    <div className="empty-prompt" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button className="ibtn empty-close" aria-label="Close" title="Close (Esc)" onClick={() => closeEmptyPrompt(pageId)}>
        <X size={14} />
      </button>
      {running ? (
        <div role="status">
          <div className="empty-title">
            <Loader2 size={15} className="spin" style={{ verticalAlign: -2 }} /> Claude is working…
          </div>
          <div className="muted small">The design appears here as soon as Claude has built something.</div>
          {queued && (
            <div className="queued-prompt" style={{ marginTop: 8 }}>
              Sends when Claude finishes: <i>“{preview(queued)}”</i>
            </div>
          )}
        </div>
      ) : queued && ready && stale ? (
        <>
          <div className="empty-title">Send queued message?</div>
          <div className="queued-prompt" role="alert" style={{ marginBottom: 4 }}>
            You typed this while Claude wasn't connected: <i>“{preview(queued)}”</i>
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <button className="btn primary" onClick={sendQueued}>
                Send
              </button>
              <button className="btn" onClick={discardQueued}>
                Discard
              </button>
            </div>
          </div>
        </>
      ) : queued ? (
        <>
          <div className="empty-title">Ready when Claude is</div>
          <div className="queued-prompt" style={{ marginBottom: 4 }}>
            Waiting to send: <i>“{preview(queued)}”</i>.{" "}
            {ready ? "It goes out in a moment." : "Connect Claude in the panel on the right and it starts designing here."}
          </div>
        </>
      ) : (
        <>
          <div className="empty-title">What do you want to design?</div>
          <textarea
            id="empty-prompt-input"
            ref={input}
            className="textinput"
            aria-label="What do you want to design?"
            placeholder="Describe a screen, a flow or a whole app…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                closeEmptyPrompt(pageId);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="kbd-hint">Claude builds it on the canvas</span>
            <button className="btn primary" onClick={() => send(text)} disabled={!text.trim()}>
              <Sparkles size={13} /> Design with Claude
            </button>
          </div>
          <div className="suggestions" style={{ marginTop: 10 }}>
            {IDEAS.map((i) => (
              <button key={i} onClick={() => send(i)}>
                {i}
              </button>
            ))}
          </div>
        </>
      )}
      {!ready && (
        <button className="link-btn demo-link" onClick={() => playDemo()}>
          ▶ Not connected yet? Watch Claude design a page (replay, no setup)
        </button>
      )}
      <div className="empty-divider">or start from a template</div>
      <div className="suggestions">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              dispatch({ op: "beginGesture" });
              try {
                t.build();
              } finally {
                dispatch({ op: "endGesture" });
              }
              requestAnimationFrame(() => requestAnimationFrame(zoomToFit));
            }}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div className="kbd-hint" style={{ marginTop: 12 }}>
        Or draw: F frame · R rectangle · T text · P pen
      </div>
    </div>
  );
}
