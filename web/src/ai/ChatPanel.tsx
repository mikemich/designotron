import { useEffect, useRef, useState } from "react";
import { Check, ImagePlus, Loader2, Plus, Settings, Sparkles, Square, Wrench, X, AlertTriangle } from "lucide-react";
import { MODELS, attachImage, newConversation, removeImage, send, setApiKey, setMode, setModel, stop, useChat } from "./chatState";
import { useStore } from "../store";
import { Menu, Seg, SelectField, type MenuItem } from "../ui/controls";
import { imagesFrom } from "./images";

const SUGGESTIONS = [
  "Design a 3-screen mobile onboarding flow for a meditation app, with prototype links",
  "Create a modern SaaS landing page at 1440px wide",
  "Turn the selection into a component with Default / Hover / Disabled variants",
  "Critique this design and fix spacing, hierarchy and contrast",
  "Build this design as a React app in the workspace",
];

/** Prompts behind the ✦ menu. `fill` puts the prompt in the box for the user to finish instead of sending. */
const QUICK_ACTIONS: { label: string; prompt: string; fill?: boolean; needsSelection?: boolean; needsImage?: boolean }[] = [
  {
    label: "Rebuild attached screenshot as layers",
    needsImage: true,
    prompt:
      "Recreate the attached screenshot as editable layers on this page, to the right of existing content. Use frames with auto layout, real text and the closest fonts and colours. Then call get_screenshot and compare it with the original; fix differences in spacing, sizes and colours.",
  },
  { label: "Import a website by URL…", fill: true, prompt: "Import this website as editable layers with import_url, then tidy the layer names: https://" },
  {
    label: "Design a user flow…",
    fill: true,
    prompt: "Design the complete user flow for: \nInclude every screen (empty, loading and error states too), consistent components, and prototype links between screens.",
  },
  {
    label: "Make variants of the selection",
    needsSelection: true,
    prompt:
      "Turn the selected element into a component (if it isn't one) and create a component set with sensible variants (for example Default, Hover, Pressed, Disabled, and size variants where they make sense).",
  },
  {
    label: "Responsive versions (mobile + desktop)",
    needsSelection: true,
    prompt: "Create responsive versions of the selected screen: a 393px mobile version and a 1440px desktop version next to it. Adapt the layout, don't just scale it.",
  },
  {
    label: "Dark mode version",
    needsSelection: true,
    prompt: "Duplicate the selected screen next to it and make a polished dark mode version. Keep contrast at WCAG AA or better, then run lint_design on it.",
  },
  {
    label: "Fill with realistic content",
    needsSelection: true,
    prompt: "Replace placeholder text, names, numbers and images in the selection with realistic, varied content that fits the product. Keep the layout intact.",
  },
  {
    label: "Rename layers semantically",
    prompt: "Rename the layers on this page with clear semantic names (e.g. Header, Nav, Hero title, Primary button, Card / Title). Don't change anything else.",
  },
  {
    label: "Sync design → code in the workspace",
    prompt:
      "Look at the code in the workspace and update it to match the current design: export_code for the screens, then edit the existing components rather than overwriting the project. Run the build to check it compiles.",
  },
  {
    label: "Import screens from my codebase",
    prompt:
      "Read the UI code in the workspace (pages, components, styles) and recreate the main screens on this page as editable designs, with shared components turned into Designotron components.",
  },
  {
    label: "Import design tokens from code",
    prompt:
      "Find the design tokens in the workspace (Tailwind config, CSS variables, theme files). Create them as variables with define_variables (one collection per token group, with Light/Dark modes if the code has themes) and as colour/text styles with define_styles. Then bind matching layer properties to the variables and call fix_issues with kinds [\"unlinkedStyle\"].",
  },
];

export function ChatPanel() {
  const { items, running, mode, apiKey, model, bridgeStatus, claude, sessionId, pending } = useChat();
  const hasSelection = useStore((s) => s.es.selection.length > 0);
  const [text, setText] = useState("");
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const addImages = async (list: DataTransferItemList | FileList | null) => {
    for (const img of await imagesFrom(list)) attachImage(img.url, img.name);
  };

  const quickItems: MenuItem[] = QUICK_ACTIONS.map((a) => ({
    label: a.label,
    disabled: (a.needsSelection && !hasSelection) || (a.needsImage && !pending.length),
    onClick: () => {
      if (a.fill) {
        setText(a.prompt);
        setTimeout(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          const at = a.prompt.indexOf("\n");
          const pos = at >= 0 ? at : a.prompt.length;
          el.setSelectionRange(pos, pos);
        }, 0);
      } else send(a.prompt);
    },
  }));

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
                  : "Bridge offline: start it on this computer (steps below)"}
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
        {mode === "bridge" && bridgeStatus === "offline" && <BridgeSetup />}
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
              {"images" in it && it.images?.length ? (
                <div className="msg-images">
                  {it.images.map((u, i) => (
                    <img key={i} src={u} alt="" />
                  ))}
                </div>
              ) : null}
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
      <div
        className={"chat-input" + (dragOver ? " drag" : "")}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          addImages(e.dataTransfer.files);
        }}
      >
        {pending.length > 0 && (
          <div className="attachments">
            {pending.map((p) => (
              <div key={p.id} className="attachment" title={p.name}>
                <img src={p.url} alt={p.name} />
                <button title="Remove" onClick={() => removeImage(p.id)}>
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          placeholder={ready ? "Describe what to design or change…" : "Connect Claude Code or add an API key to start"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (Array.from(e.clipboardData.items).some((i) => i.kind === "file" && i.type.startsWith("image/"))) {
              e.preventDefault();
              addImages(e.clipboardData.items);
            }
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="row" style={{ marginTop: 6, justifyContent: "space-between" }}>
          <div className="row" style={{ gap: 2 }}>
            <button
              className="ibtn"
              title="Quick actions"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left, y: r.top - 8 });
              }}
            >
              <Sparkles size={14} />
            </button>
            <button className="ibtn" title="Attach an image (or paste / drop one)" onClick={() => fileRef.current?.click()}>
              <ImagePlus size={14} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                addImages(e.target.files);
                e.target.value = "";
              }}
            />
            <span className="kbd-hint" style={{ marginLeft: 4 }}>
              Enter to send
            </span>
          </div>
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
      {menu && <Menu x={menu.x} y={menu.y} items={quickItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

const INSTALL_CMD = "curl -fsSL https://raw.githubusercontent.com/mikemich/designotron/main/install.sh | sh";
const RUN_CMD = "~/.local/bin/designotron";

function CopyLine({ text }: { text: string }) {
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
      <code>{text}</code>
      <button onClick={copy} title="Copy">
        {copied ? <Check size={12} /> : "Copy"}
      </button>
    </div>
  );
}

/** Shown while the bridge is unreachable: how to start it on this computer. */
function BridgeSetup() {
  return (
    <div className="bridge-setup">
      <b>Connect Claude</b>
      <div>Claude runs through the Designotron bridge on your computer, using your Claude Code sign-in.</div>
      <ol>
        <li>
          Install <a href="https://code.claude.com" target="_blank" rel="noreferrer">Claude Code</a> and sign in once: run <code>claude</code>, then <code>/login</code>.
        </li>
        <li>
          Install the bridge (macOS or Linux):
          <CopyLine text={INSTALL_CMD} />
          On Windows, download it from{" "}
          <a href="https://github.com/mikemich/designotron/releases/latest" target="_blank" rel="noreferrer">Releases</a>.
        </li>
        <li>
          Start it and leave it running:
          <CopyLine text={RUN_CMD} />
        </li>
      </ol>
      <div className="muted">
        This page connects on its own a few seconds later. If it doesn't (Safari and Brave can stop websites from reaching your computer), use the copy of
        the editor the bridge serves at <a href="http://127.0.0.1:5174" target="_blank" rel="noreferrer">127.0.0.1:5174</a>.
      </div>
    </div>
  );
}
