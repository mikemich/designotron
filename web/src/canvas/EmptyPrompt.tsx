import { useState } from "react";
import { Sparkles } from "lucide-react";
import { askClaude, claudeReady, useChat } from "../ai/chatState";
import { playDemo } from "../Demo";
import { TEMPLATES } from "../templates";
import { dispatch, zoomToFit } from "../store";

const IDEAS = ["A landing page for a coffee subscription", "A habit tracker mobile app, 3 screens", "An admin dashboard for an online store"];

/** Shown on an empty page: describe a design for Claude, or start from a template. */
export function EmptyPrompt() {
  const [text, setText] = useState("");
  const ready = useChat((s) => claudeReady(s));
  const queued = useChat((s) => s.queued);
  const send = (prompt: string) => {
    if (!prompt.trim()) return;
    askClaude(prompt.trim());
    setText("");
  };
  return (
    <div className="empty-prompt" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {queued ? (
        <>
          <div className="empty-title">Ready when Claude is</div>
          <div className="queued-prompt" style={{ marginBottom: 4 }}>
            Waiting to send: <i>“{queued.length > 160 ? queued.slice(0, 160) + "…" : queued}”</i>. Connect Claude in the panel on the right
            and it starts designing here.
          </div>
        </>
      ) : (
        <>
        <div className="empty-title">What do you want to design?</div>
        <textarea
          id="empty-prompt-input"
          className="textinput"
          placeholder="Describe a screen, a flow or a whole app…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
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
