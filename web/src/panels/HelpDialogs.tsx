import { useState } from "react";
import { create } from "zustand";
import { X } from "lucide-react";
import { getDoc, toast } from "../store";
import { useDialog } from "../ui/controls";
import { REPO_URL } from "./GuestBar";

/** The app version (keep in step with web/package.json). */
export const APP_VERSION = "0.1.0";
/** The document model revision this editor writes (keep in step with `collab::MODEL_REVISION`). */
export const MODEL_REVISION = 4;
/** Where bug reports go. The app only shows this address; it never opens or fetches it. */
export const ISSUES_URL = `${REPO_URL}/issues`;

export const useHelp = create<{ dialog: "feedback" | "about" | null }>(() => ({ dialog: null }));

/** Opens the help page that ships with the editor (a static page, no network needed). */
export function openHelpPage() {
  const base = import.meta.env.BASE_URL ?? "/";
  window.open(`${base}help/index.html`, "_blank", "noopener");
}

/** What the person can paste into a bug report: where it runs and how big the file is, never its content. */
export function feedbackDetails(): string {
  let layers = 0;
  try {
    layers = Object.keys(getDoc().nodes).length;
  } catch {
    /* no file open */
  }
  return [
    `Designotron ${APP_VERSION} (model revision ${MODEL_REVISION})`,
    `Browser: ${navigator.userAgent}`,
    `Platform: ${navigator.platform || "unknown"}`,
    `Screen: ${window.innerWidth}x${window.innerHeight} at ${window.devicePixelRatio}x`,
    `Layers in this file: ${layers}`,
  ].join("\n");
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast("Couldn't copy. Select the text and copy it yourself.", "error");
  }
}

export function HelpDialogs() {
  const dialog = useHelp((s) => s.dialog);
  if (dialog === "feedback") return <FeedbackDialog />;
  if (dialog === "about") return <AboutDialog />;
  return null;
}

function Shell({ title, children, close, wide }: { title: string; children: React.ReactNode; close: () => void; wide?: boolean }) {
  const ref = useDialog(close);
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} className={"modal help-dialog" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{title}</b>
          <button className="ibtn" title="Close" aria-label="Close" onClick={close} style={{ marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
        <div className="help-body">{children}</div>
      </div>
    </div>
  );
}

function AboutDialog() {
  const close = () => useHelp.setState({ dialog: null });
  return (
    <Shell title="About Designotron" close={close}>
      <p>
        <b>Designotron</b> is a free, open-source design tool with Claude built in.
      </p>
      <dl className="help-facts">
        <dt>Version</dt>
        <dd>{APP_VERSION}</dd>
        <dt>Document model revision</dt>
        <dd>{MODEL_REVISION}</dd>
        <dt>Licence</dt>
        <dd>MIT</dd>
        <dt>Source</dt>
        <dd>{REPO_URL}</dd>
      </dl>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn" onClick={close}>
          Close
        </button>
      </div>
    </Shell>
  );
}

function FeedbackDialog() {
  const close = () => useHelp.setState({ dialog: null });
  const [text, setText] = useState("");
  return (
    <Shell title="Send feedback" close={close} wide>
      <p className="muted small" style={{ marginTop: 0 }}>
        Designotron doesn't send anything by itself. Write what happened, copy the details, and paste both into an issue at the address below.
      </p>
      <textarea className="textinput" aria-label="What happened?" placeholder="What did you try, what did you expect, what happened instead?" rows={5} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div className="muted small" style={{ margin: "10px 0 4px" }}>
        Details (no layers, text or images from your file):
      </div>
      <pre className="help-details">{feedbackDetails()}</pre>
      <div className="row" style={{ gap: 6, margin: "6px 0 14px" }}>
        <button className="btn primary" onClick={() => void copy(`${text.trim() ? `${text.trim()}\n\n` : ""}${feedbackDetails()}`, "Copied. Paste it into your issue.")}>
          Copy details
        </button>
      </div>
      <div className="muted small" style={{ marginBottom: 4 }}>
        Report it here:
      </div>
      <div className="copy-line">
        <code tabIndex={0}>{ISSUES_URL}</code>
        <button onClick={() => void copy(ISSUES_URL, "Address copied.")} title="Copy the address">
          Copy
        </button>
      </div>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn" onClick={close}>
          Close
        </button>
      </div>
    </Shell>
  );
}
