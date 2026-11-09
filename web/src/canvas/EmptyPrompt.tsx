import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { askClaude, claudeReady, discardQueued, sendQueued, useChat, useQueueConfirm } from "../ai/chatState";
import { playDemo } from "../Demo";
import { TEMPLATES } from "../templates";
import { closeEmptyPrompt, dispatch, useStore, zoomToFit } from "../store";
import { pasteFromClipboardData } from "../actions";
import { pasteHere } from "./contextMenu";

const IDEAS = ["A landing page for a coffee subscription", "A habit tracker mobile app, 3 screens", "An admin dashboard for an online store"];

/** A queued prompt, shortened for display. */
const preview = (q: string) => (q.length > 160 ? q.slice(0, 160) + "…" : q);

/** Pages whose card already took focus by itself (it does that once per file and page). */
const autoFocused = new Set<string>();
const emptyPromptKey = (pageId: string) => `${location.hash}|${pageId}`;

/** After the first close (`closeEmptyPrompt`) blank files show a one-line pill instead of the centred card. */
function compactPref(): boolean {
  try {
    return localStorage.getItem("dt:emptyPrompt") === "compact";
  } catch {
    return false;
  }
}

/** Shown on an empty page: describe a design for Claude, or start from a template. `forceCompact`: the
 *  file has layers on other pages, so it is not a blank file and gets the pill, never the card. */
/** Ctrl/Cmd combinations the prompt keeps for editing its own text. */
const TEXT_KEYS = new Set(["a", "c", "x", "v", "z", "y", "arrowleft", "arrowright", "arrowup", "arrowdown", "backspace", "delete", "home", "end", "enter"]);

export function EmptyPrompt({ pageId, forceCompact = false }: { pageId: string; forceCompact?: boolean }) {
  const [text, setText] = useState("");
  // Read once per mount: closing the card must not turn the next frame of this very file into a pill.
  const [compact, setCompact] = useState(() => forceCompact || compactPref());
  const [grab, setGrab] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (grab && !compact) input.current?.focus();
  }, [grab, compact]);
  // A new or untouched file: the card takes focus, so typing goes into it (a bare "a" would pick the
  // Frame tool and the card would vanish). Not on a page someone just emptied (something to undo),
  // and never over a dialog, a menu or another field.
  // Once per file and page, and only with nothing to undo or redo: after Ctrl+Z (or a template undone) the
  // card comes back without taking the keys, so Ctrl+Shift+Z still redoes.
  const untouched = useStore((s) => !s.es.canUndo && !s.es.canRedo);
  useEffect(() => {
    if (compact || !untouched || autoFocused.has(emptyPromptKey(pageId))) return;
    const free = () => {
      const a = document.activeElement;
      return !a || a === document.body || !!a.closest(".canvas");
    };
    const t = requestAnimationFrame(() => {
      if (free() && !document.querySelector(".modal-bg, .menu, .hint-card")) {
        autoFocused.add(emptyPromptKey(pageId));
        input.current?.focus();
      }
    });
    return () => cancelAnimationFrame(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
      <div className="empty-pill" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button
          aria-label="Describe a design for Claude or pick a template"
          onClick={() => {
            setCompact(false);
            setGrab(true);
          }}
        >
          <Sparkles size={13} />
          <span>Describe a design for Claude…</span>
        </button>
        <span className="empty-pill-sep" aria-hidden="true" />
        <button
          className="muted"
          onClick={() => {
            setCompact(false);
            setGrab(true);
          }}
        >
          Templates
        </button>
      </div>
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
            onPaste={(e) => {
              // The prompt holds focus on a new file. Copied layers, images and SVG still go onto the
              // canvas, as they would without the prompt; only plain text is typed into it.
              const dt = e.clipboardData;
              const text = dt.getData("text/plain");
              const design = dt.files.length > 0 || !text || text.includes("designotron/nodes") || /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text);
              if (!design) return;
              e.preventDefault();
              document.getElementById("dt-canvas")?.focus();
              if (!text && !dt.files.length) void pasteHere();
              else void pasteFromClipboardData(e.nativeEvent);
            }}
            onKeyDown={(e) => {
              // Editor commands (save, export, undo of the canvas...) still work from the prompt: only the
              // text-editing combinations belong to the field. Hand the rest to the editor's shortcuts.
              const mod = e.ctrlKey || e.metaKey;
              if (mod && e.key !== "/" && !TEXT_KEYS.has(e.key.toLowerCase())) {
                e.preventDefault();
                e.stopPropagation();
                const canvas = document.getElementById("dt-canvas");
                canvas?.focus();
                (canvas ?? window).dispatchEvent(
                  new KeyboardEvent("keydown", { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true }),
                );
                return;
              }
              e.stopPropagation();
              // The prompt now holds focus on a new file, and the global shortcuts leave text fields alone:
              // the Claude panel's own key still has to work from here.
              if ((e.ctrlKey || e.metaKey) && e.key === "/") {
                e.preventDefault();
                useStore.setState((s) => ({ chatOpen: !s.chatOpen }));
                return;
              }
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
