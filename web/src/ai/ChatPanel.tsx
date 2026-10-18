import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, Settings, Square, Wrench, X, AlertTriangle } from "lucide-react";
import { MODELS, newConversation, send, setApiKey, setMode, setModel, stop, useChat } from "./chatState";
import { useStore } from "../store";
import { Seg, SelectField } from "../ui/controls";

const SUGGESTIONS = [
  "Design a 3-screen mobile onboarding flow for a meditation app, with prototype links",
  "Create a modern SaaS landing page at 1440px wide",
  "Turn the selection into a component with Default / Hover / Disabled variants",
  "Critique this design and fix spacing, hierarchy and contrast",
  "Build this design as a React app in the workspace",
];

export function ChatPanel() {
  const { items, running, mode, apiKey, model, bridgeStatus, claude, sessionId } = useChat();
  const [text, setText] = useState("");
  const [settings, setSettings] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [items]);
  useEffect(() => inputRef.current?.focus(), []);

  const submit = () => {
    if (!text.trim() || running) return;
    send(text);
    setText("");
  };

  const ready = mode === "bridge" ? bridgeStatus === "connected" && claude?.available !== false : !!apiKey;

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="title">Claude</span>
        <button className="ibtn" title="New conversation" onClick={newConversation}>
          <Plus size={14} />
        </button>
        <button className={"ibtn" + (settings ? " on" : "")} title="Settings" onClick={() => setSettings(!settings)}>
          <Settings size={14} />
        </button>
        <button className="ibtn" title="Close (⌘/)" onClick={() => useStore.setState({ chatOpen: false })}>
          <X size={14} />
        </button>
      </div>
      <div className="section" style={{ padding: "8px 10px" }}>
        <Seg
          value={mode}
          onChange={setMode}
          options={[
            { value: "bridge", label: "Claude Code · Pro/Max", title: "Uses your local Claude Code CLI and its sign-in" },
            { value: "api", label: "API key", title: "Calls the Anthropic API from the browser" },
          ]}
        />
        <div className="small muted" style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
          {mode === "bridge" ? (
            <>
              <span className="status-dot" style={{ background: bridgeStatus === "connected" ? (claude?.available === false ? "#f24822" : "#14ae5c") : "#666" }} />
              {bridgeStatus === "connected"
                ? claude?.available === false
                  ? "Bridge running, but `claude` CLI not found"
                  : `Bridge connected${claude?.version ? ` · Claude Code ${claude.version}` : ""}`
                : bridgeStatus === "connecting"
                  ? "Connecting to bridge…"
                  : "Bridge offline: run `npx designotron` on this computer"}
            </>
          ) : (
            <>
              <span className="status-dot" style={{ background: apiKey ? "#14ae5c" : "#666" }} />
              {apiKey ? MODELS.find((m) => m.value === model)?.label : "No API key set"}
            </>
          )}
        </div>
        {settings && (
          <div style={{ marginTop: 10 }}>
            {mode === "api" ? (
              <>
                <div className="small muted" style={{ marginBottom: 4 }}>
                  Anthropic API key (stored in this browser only)
                </div>
                <input className="textinput" type="password" placeholder="sk-ant-…" value={apiKey} onChange={(e) => setApiKey(e.target.value.trim())} onKeyDown={(e) => e.stopPropagation()} />
                <div className="row" style={{ marginTop: 6 }}>
                  <SelectField value={model} options={MODELS} onChange={setModel} />
                </div>
              </>
            ) : (
              <div className="small muted" style={{ lineHeight: 1.6 }}>
                Chat runs through your own <b>Claude Code</b> CLI, so it uses whatever it is signed in with (Claude Pro or Max, or an API key).
                {claude?.workspace && (
                  <>
                    <br />
                    Workspace: <code>{claude.workspace}</code>
                  </>
                )}
                {sessionId && (
                  <>
                    <br />
                    Session: <code>{sessionId.slice(0, 8)}…</code>
                  </>
                )}
                <br />
                Use it from your terminal too: <code>claude mcp add --transport http designotron http://127.0.0.1:5174/mcp</code>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="chat-log" ref={logRef}>
        {items.length === 0 && (
          <>
            <div className="muted" style={{ lineHeight: 1.6 }}>
              Ask Claude to design, edit, critique or build. It can see and change this file, take screenshots to check its work, and turn designs into real code.
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} disabled={!ready}>
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        {items.map((it) =>
          it.kind === "tool" ? (
            <div key={it.id} className={"tool-chip" + (it.ok === false ? " err" : "")} title={it.detail}>
              {it.ok === null ? <Loader2 size={11} className="spin" /> : it.ok ? <Check size={11} /> : <AlertTriangle size={11} />}
              <Wrench size={11} /> {it.name}
              {it.detail ? <span style={{ opacity: 0.7 }}> · {it.detail.slice(0, 60)}</span> : null}
            </div>
          ) : (
            <div key={it.id} className={"msg " + it.kind}>
              {it.text}
            </div>
          ),
        )}
        {running && (
          <div className="msg system">
            <Loader2 size={11} style={{ verticalAlign: -1 }} /> Working…
          </div>
        )}
      </div>
      <div className="chat-input">
        <textarea
          ref={inputRef}
          placeholder={ready ? "Describe what to design or change…" : "Connect Claude Code or add an API key to start"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="row" style={{ marginTop: 6, justifyContent: "space-between" }}>
          <span className="kbd-hint">Enter to send · Shift+Enter for a new line</span>
          {running ? (
            <button className="btn" onClick={stop}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button className="btn primary" onClick={submit} disabled={!text.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
