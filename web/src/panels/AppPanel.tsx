import { useEffect, useRef, useState } from "react";
import { ExternalLink, FolderDown, Loader2, Play, RotateCw, Sparkles, Square } from "lucide-react";
import { Section, Seg } from "../ui/controls";
import { useChat, askClaude } from "../ai/chatState";
import { setLiveSync, startPreview, stopPreview, usePreview, writeProject } from "../ai/preview";

const DEVICES = { mobile: 393, desktop: 1440 } as const;

/** The real app running from the workspace, next to the design. */
export function AppPanel() {
  const { phase, url, project, logs, liveSync, lastWrite } = usePreview();
  const bridgeStatus = useChat((s) => s.bridgeStatus);
  const [device, setDevice] = useState<keyof typeof DEVICES>("mobile");
  const [reload, setReload] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(260);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [url]);
  useEffect(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }), [logs]);

  if (bridgeStatus !== "connected") {
    return (
      <div className="scroll">
        <Section title="Live app">
          <div className="muted small" style={{ lineHeight: 1.6 }}>
            The live preview runs your app's dev server on this computer through the Designotron bridge. Start it with <code>npx designotron</code>.
          </div>
        </Section>
      </div>
    );
  }

  const busy = phase === "installing" || phase === "starting";
  const width = DEVICES[device];
  const scale = Math.min(1, boxW / width);
  return (
    <div className="scroll app-panel">
      <Section title="Live app">
        <div className="muted small" style={{ marginBottom: 8, wordBreak: "break-all" }}>
          {project ? <>Runs <code>npm run dev</code> in <code>{project}</code></> : "No app in the workspace yet."}
        </div>
        <button className="btn block" style={{ marginBottom: 6 }} onClick={writeProject} title="Writes the generated React + Tailwind project into workspace/app">
          <FolderDown size={13} /> Write design to workspace
        </button>
        <label className="row small" style={{ gap: 6, marginBottom: 8, cursor: "pointer" }} title="Overwrites the generated files in workspace/app whenever the design changes">
          <input type="checkbox" checked={liveSync} onChange={(e) => setLiveSync(e.target.checked)} /> Keep in sync while I design
        </label>
        {lastWrite && <div className="muted small" style={{ marginBottom: 8 }}>{lastWrite}</div>}
        {phase === "running" || busy ? (
          <button className="btn block" onClick={stopPreview}>
            <Square size={12} /> Stop
          </button>
        ) : (
          <button className="btn block primary" onClick={startPreview}>
            <Play size={13} /> Run app
          </button>
        )}
      </Section>
      {busy && (
        <div className="section muted small">
          <Loader2 size={12} className="spin" style={{ verticalAlign: -2 }} /> {phase === "installing" ? "Installing dependencies (first run only)…" : "Starting dev server…"}
        </div>
      )}
      {url && (
        <div className="section">
          <div className="row" style={{ marginBottom: 6 }}>
            <Seg
              value={device}
              onChange={setDevice}
              options={[
                { value: "mobile", label: "Mobile" },
                { value: "desktop", label: "Desktop" },
              ]}
            />
            <button className="ibtn" title="Reload" onClick={() => setReload((r) => r + 1)}>
              <RotateCw size={13} />
            </button>
            <a className="ibtn" title="Open in a new tab" href={url} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />
            </a>
          </div>
          <div ref={boxRef} className="app-frame" style={{ height: Math.round(Math.min(760, (device === "mobile" ? 852 : 900)) * scale) }}>
            <iframe
              key={reload}
              src={url}
              title="App preview"
              style={{ width, height: device === "mobile" ? 852 : 900, transform: `scale(${scale})` }}
            />
          </div>
        </div>
      )}
      {phase === "failed" && (
        <div className="section">
          <button
            className="btn block primary"
            onClick={() =>
              askClaude(
                `The app preview failed. Here are the last log lines:\n\n${logs.slice(-40).join("\n")}\n\nFind and fix the problem in the workspace app, then tell me when it's ready to run again.`,
              )
            }
          >
            <Sparkles size={13} /> Ask Claude to fix it
          </button>
        </div>
      )}
      {logs.length > 0 && (
        <Section title="Logs">
          <div ref={logRef} className="code-block app-logs">
            {logs.join("\n")}
          </div>
        </Section>
      )}
    </div>
  );
}
