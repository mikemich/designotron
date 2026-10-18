import { useState } from "react";
import { Sparkles } from "lucide-react";
import { askClaude } from "../ai/chatState";
import { TEMPLATES } from "../templates";
import { dispatch, zoomToFit } from "../store";

const IDEAS = ["A landing page for a coffee subscription", "A habit tracker mobile app, 3 screens", "An admin dashboard for an online store"];

/** Shown on an empty page: describe a design for Claude, or start from a template. */
export function EmptyPrompt() {
  const [text, setText] = useState("");
  const send = (prompt: string) => {
    if (!prompt.trim()) return;
    askClaude(prompt.trim());
    setText("");
  };
  return (
    <div className="empty-prompt" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
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
