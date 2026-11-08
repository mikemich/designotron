import { useState } from "react";
import { Check } from "lucide-react";
import { bridgeHttpBase } from "./bridgeClient";

const INSTALL_CMD = "curl -fsSL https://raw.githubusercontent.com/mikemich/designotron/main/install.sh | sh";
const RUN_CMD = "~/.local/bin/designotron";

export function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  return (
    <div className="copy-line">
      <code tabIndex={0}>{text}</code>
      <button onClick={copy} title="Copy">
        {copied ? <Check size={12} /> : "Copy"}
      </button>
    </div>
  );
}

/** The steps for Pro or Max: install Claude Code, then the bridge. Used by the chat panel and the dashboard. */
export function ClaudeSetupSteps() {
  const bridge = bridgeHttpBase();
  return (
    <>
      <div style={{ margin: "6px 0" }}>The Designotron bridge runs your own Claude Code on this computer:</div>
      <ol>
        <li>
          Install{" "}
          <a href="https://code.claude.com" target="_blank" rel="noreferrer">
            Claude Code
          </a>{" "}
          and sign in once: run <code>claude</code>, then <code>/login</code>.
        </li>
        <li>
          Install the bridge (macOS or Linux):
          <CopyLine text={INSTALL_CMD} />
          On Windows, download it from{" "}
          <a href="https://github.com/mikemich/designotron/releases/latest" target="_blank" rel="noreferrer">
            Releases
          </a>
          .
        </li>
        <li>
          It starts in the background and at every login. If the installer says to start it yourself, run:
          <CopyLine text={RUN_CMD} />
        </li>
      </ol>
      <div className="muted">
        This page connects on its own a few seconds later. If it doesn't (Safari and Brave can stop websites from reaching your computer), use the copy of the editor the bridge serves at{" "}
        <a href={bridge} target="_blank" rel="noreferrer">
          {bridge.replace(/^https?:\/\//, "")}
        </a>
        .
      </div>
    </>
  );
}
