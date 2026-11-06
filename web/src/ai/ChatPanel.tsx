import { useEffect, useRef, useState } from "react";
import {
  Check,
  ImagePlus,
  Loader2,
  Plus,
  Settings,
  Sparkles,
  Square,
  Wrench,
  X,
  AlertTriangle,
  Camera,
} from "lucide-react";
import {
  MODELS,
  attachImage,
  newConversation,
  push,
  removeImage,
  discardQueued,
  send,
  sendQueued,
  setApiKey,
  setMode,
  setModel,
  stop,
  useChat,
  useQueueConfirm,
} from "./chatState";
import { bridgeHttpBase } from "./bridgeClient";
import { getDoc, toast, useStore } from "../store";
import { Menu, MOD, Seg, SelectField, type MenuItem } from "../ui/controls";
import { imagesFrom } from "./images";
import { Markdown } from "./markdown";
import { isPhone } from "../panels/PhoneNote";

const SUGGESTIONS = [
  "Design a 3-screen mobile onboarding flow for a meditation app, with prototype links",
  "Create a modern SaaS landing page at 1440px wide",
  "Design a mobile sign-up form with default, error and success states, in light and dark mode",
  "Turn the selection into a component with Default / Hover / Disabled variants",
  "Critique this design and fix spacing, hierarchy and contrast",
  "Build this design as a React app in the workspace",
];

/** Prompts behind the ✦ menu. `fill` puts the prompt in the box for the user to finish instead of sending. */
const QUICK_ACTIONS: {
  label: string;
  prompt: string;
  fill?: boolean;
  needsSelection?: boolean;
  needsImage?: boolean;
  /** Needs layers on the current page. */
  needsContent?: boolean;
}[] = [
  {
    label: "Rebuild attached screenshot as layers",
    needsImage: true,
    prompt:
      "Recreate the attached screenshot as editable layers on this page, to the right of existing content. Use frames with auto layout, real text and the closest fonts and colours, and build anything that repeats as a component with instances. Then call get_screenshot and compare it with the original; fix differences in spacing, sizes and colours.",
  },
  {
    label: "Import a website by URL…",
    fill: true,
    prompt:
      "Import this website as editable layers with import_url, then tidy the layer names: https://",
  },
  {
    label: "Design a user flow…",
    fill: true,
    prompt:
      "Design the complete user flow for: \nInclude every screen (empty, loading and error states too), shared components and colour/type tokens, and prototype links between screens.",
  },
  {
    label: "Make variants of the selection",
    needsSelection: true,
    prompt:
      "Turn the selected element into a component (if it isn't one) and combine it with its states into one component set with sensible variants (for example Default, Hover, Pressed, Disabled, and size variants where they make sense).",
  },
  {
    label: "Responsive versions (mobile + desktop)",
    needsSelection: true,
    prompt:
      "Create responsive versions of the selected screen: a 393px mobile version and a 1440px desktop version next to it. Adapt the layout, don't just scale it.",
  },
  {
    label: "Dark mode version",
    needsSelection: true,
    prompt:
      "Make a dark mode version of the selected screen without hard-coding colours: define_variables with a Light and a Dark mode (reuse a collection if the file has one), bind the screen's fills and text colours to them, then duplicate the screen next to it and set variableModes to Dark on the copy. Keep contrast at WCAG AA or better, then run lint_design.",
  },
  {
    label: "Fill with realistic content",
    needsSelection: true,
    prompt:
      "Replace placeholder text, names, numbers and images in the selection with realistic, varied content that fits the product. Keep the layout intact.",
  },
  {
    label: "Rename layers semantically",
    needsContent: true,
    prompt:
      "Rename the layers on this page with clear semantic names (e.g. Header, Nav, Hero title, Primary button, Card / Title). Don't change anything else.",
  },
  {
    label: "Sync design → code in the workspace",
    needsContent: true,
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
      'Find the design tokens in the workspace (Tailwind config, CSS variables, theme files). Create them as variables with define_variables (one collection per token group, with Light/Dark modes if the code has themes) and as colour/text styles with define_styles. Then bind matching layer properties to the variables and call fix_issues with kinds ["unlinkedStyle"].',
  },
];

export function ChatPanel() {
  const {
    items,
    running,
    mode,
    apiKey,
    model,
    bridgeStatus,
    claude,
    sessionId,
    pending,
    keyChecked,
  } = useChat();
  const hasSelection = useStore((s) => s.es.selection.length > 0);
  const hasContent = useStore((s) => !!getDoc().pages.find((p) => p.id === s.es.page)?.children.length);
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
  // Closing the panel (the X, Ctrl+/ or the toolbar) must not leave focus on the page body.
  useEffect(
    () => () => {
      if (document.activeElement === document.body || !document.activeElement) document.getElementById("claude-toggle")?.focus();
    },
    [],
  );

  const queued = useChat((s) => s.queued);
  const draft = useChat((s) => s.draft);
  const staleQueue = useQueueConfirm((s) => s.stale);
  // Text returned by Stop (a message that was queued) or kept from the last visit to this file
  // goes in front of whatever is typed.
  useEffect(() => {
    if (!draft) return;
    useChat.setState({ draft: "" });
    setText((t) => (t.trim() ? `${draft}\n\n${t}` : draft));
    inputRef.current?.focus();
  }, [draft]);
  const submit = () => {
    if (!text.trim()) return;
    // A new message replaces a queued one that was waiting for confirmation.
    if (useQueueConfirm.getState().stale) discardQueued();
    send(text);
    setText("");
  };

  const ready =
    mode === "bridge"
      ? bridgeStatus === "connected" && claude?.available !== false
      : !!apiKey;
  const connectCard = !ready && !(mode === "bridge" && bridgeStatus === "connecting");

  const addImages = async (list: DataTransferItemList | FileList | null) => {
    const { images, errors } = await imagesFrom(list);
    for (const img of images) attachImage(img.url, img.name);
    for (const text of errors) push({ kind: "error", text });
  };

  const quickItems: MenuItem[] = QUICK_ACTIONS.map((a) => ({
    label: a.label,
    disabled:
      (a.needsSelection && !hasSelection) || (a.needsImage && !pending.length) || (a.needsContent && !hasContent),
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
      } else send(a.prompt, { label: a.label });
    },
  }));

  return (
    <aside className="chat" aria-label="Claude chat">
      <div className="chat-head">
        <h2 className="title">Claude</h2>
        <button
          className="ibtn"
          title="New conversation"
          aria-label="New conversation"
          onClick={newConversation}
        >
          <Plus size={14} />
        </button>
        <button
          className={"ibtn" + (settings ? " on" : "")}
          title="Settings"
          aria-label="Settings"
          aria-pressed={settings}
          onClick={() => setSettings(!settings)}
        >
          <Settings size={14} />
        </button>
        <button
          className="ibtn"
          title={`Close (${MOD}/)`}
          aria-label="Close Claude panel"
          onClick={() => {
            useStore.setState({ chatOpen: false });
            // The panel unmounts after this click; focus goes to the toolbar button right away.
            document.getElementById("claude-toggle")?.focus();
          }}
        >
          <X size={14} />
        </button>
      </div>
      <div className="section" style={{ padding: "8px 10px" }}>
        <Seg
          ariaLabel="Claude connection"
          value={mode}
          onChange={setMode}
          options={[
            {
              value: "bridge",
              label: "Claude Code · Pro/Max",
              title: "Uses your local Claude Code CLI and its sign-in",
            },
            {
              value: "api",
              label: "API key",
              title: "Calls the Anthropic API from the browser",
            },
          ]}
        />
        <div
          className="small muted"
          style={{
            marginTop: 6,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {mode === "bridge" ? (
            <>
              <span
                className="status-dot"
                style={{
                  background:
                    bridgeStatus === "connected"
                      ? claude?.available === false
                        ? "#f24822"
                        : "#14ae5c"
                      : "#666",
                }}
              />
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
              <span
                className="status-dot"
                style={{ background: apiKey ? "#14ae5c" : "#666" }}
              />
              {apiKey
                ? `${MODELS.find((m) => m.value === model)?.label}${keyChecked ? "" : " · key not checked yet"}`
                : "No API key set"}
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
                <input
                  className="textinput"
                  type="password"
                  aria-label="Anthropic API key"
                  placeholder="sk-ant-…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value.trim())}
                  onKeyDown={(e) => e.stopPropagation()}
                />
                <div className="row" style={{ marginTop: 6 }}>
                  <SelectField
                    ariaLabel="Model"
                    value={model}
                    options={MODELS}
                    onChange={setModel}
                  />
                </div>
              </>
            ) : (
              <div className="small muted" style={{ lineHeight: 1.6 }}>
                Chat runs through your own <b>Claude Code</b> CLI, so it uses
                whatever it is signed in with (Claude Pro or Max, or an API
                key).
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
                Use it from your terminal too:{" "}
                <code>
                  claude mcp add --transport http designotron{" "}
                  {bridgeHttpBase()}/mcp
                </code>
              </div>
            )}
          </div>
        )}
      </div>
      {connectCard && <ConnectCard alone={!items.length} />}
      {/* Until Claude is connected, the setup card has the room (the suggestions can't be used yet). */}
      {connectCard && !items.length ? <div style={{ flex: 1 }} /> : (
      <div className="chat-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation" tabIndex={0}>
        {items.length === 0 && (
          <>
            <div className="muted" style={{ lineHeight: 1.6 }}>
              Ask Claude to design, edit, critique or build. It can see and
              change this file, take screenshots to check its work, and turn
              designs into real code.
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
            <div
              key={it.id}
              className={"tool-chip" + (it.ok === false ? " err" : "")}
              title={it.detail}
            >
              {it.ok === null ? (
                <Loader2 size={11} className="spin" />
              ) : it.ok ? (
                <Check size={11} />
              ) : (
                <AlertTriangle size={11} />
              )}
              <Wrench size={11} /> {it.name}
              {it.detail ? (
                <span style={{ opacity: 0.7 }}>
                  {" "}
                  · {it.detail.slice(0, 60)}
                </span>
              ) : null}
            </div>
          ) : it.kind === "shot" ? (
            <Shot key={it.id} url={it.url} label={it.label} />
          ) : (
            <div key={it.id} className={"msg " + it.kind} title={"title" in it ? it.title : undefined}>
              {"images" in it && it.images?.length ? (
                <div className="msg-images">
                  {it.images.map((u, i) => (
                    <img key={i} src={u} alt="" />
                  ))}
                </div>
              ) : null}
              {it.kind === "assistant" ? <Markdown text={it.text} /> : it.text}
              {it.kind === "error" && it.retry && !running && (
                <button className="btn small retry-btn" onClick={() => send(it.retry!)}>
                  Retry
                </button>
              )}
            </div>
          ),
        )}
        {running && (
          <div className="msg system">
            <Loader2 size={11} style={{ verticalAlign: -1 }} /> Working…
          </div>
        )}
      </div>
      )}
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
        {running && queued && (
          <div className="queued-prompt">
            Sends when Claude finishes:{" "}
            <i>“{queued.length > 120 ? queued.slice(0, 120) + "…" : queued}”</i>{" "}
            <button className="btn small" onClick={() => useChat.setState({ queued: null })}>
              Cancel
            </button>
          </div>
        )}
        {!running && queued && ready && staleQueue && (
          <div className="queued-prompt" role="alert">
            <b>Send queued message?</b> You typed it while Claude wasn't connected:{" "}
            <i>“{queued.length > 120 ? queued.slice(0, 120) + "…" : queued}”</i>
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              <button className="btn primary small" onClick={sendQueued}>
                Send
              </button>
              <button className="btn small" onClick={discardQueued}>
                Discard
              </button>
            </div>
          </div>
        )}
        <textarea
          ref={inputRef}
          aria-label="Message to Claude"
          placeholder={
            running
              ? "Claude is working. Type to queue a message for when it's done…"
              : ready
              ? "Describe what to design or change…"
              : "Connect Claude Code or add an API key to start"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (
              Array.from(e.clipboardData.items).some(
                (i) => i.kind === "file" && i.type.startsWith("image/"),
              )
            ) {
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
        <div
          className="row"
          style={{ marginTop: 6, justifyContent: "space-between" }}
        >
          <div className="row" style={{ gap: 2 }}>
            <button
              className="ibtn"
              title="Quick actions"
              aria-label="Quick actions"
              aria-haspopup="menu"
              aria-expanded={!!menu}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left, y: r.top - 8 });
              }}
            >
              <Sparkles size={14} />
            </button>
            <button
              className="ibtn"
              title="Attach an image (or paste / drop one)"
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus size={14} />
            </button>
            <button
              className="ibtn"
              title="Attach a screenshot of the selection (or of the page) so Claude can see it"
              onClick={attachCanvasShot}
            >
              <Camera size={14} />
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
            // Stop stays in reach while a message is being queued.
            <div className="row" style={{ gap: 6 }}>
              <button className="btn" onClick={stop}>
                <Square size={12} /> Stop
              </button>
              {text.trim() && (
                <button className="btn primary" onClick={submit} title="Sends when Claude finishes this turn">
                  Queue
                </button>
              )}
            </div>
          ) : (
            <button
              className="btn primary"
              onClick={submit}
              disabled={!text.trim()}
            >
              Send
            </button>
          )}
        </div>
      </div>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          items={quickItems}
          label="Quick actions"
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}

const INSTALL_CMD =
  "curl -fsSL https://raw.githubusercontent.com/mikemich/designotron/main/install.sh | sh";
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
      <code tabIndex={0}>{text}</code>
      <button onClick={copy} title="Copy">
        {copied ? <Check size={12} /> : "Copy"}
      </button>
    </div>
  );
}

/** Shown until Claude is connected: an API key (works at once) or the bridge for Pro/Max. */
function ConnectCard({ alone }: { alone: boolean }) {
  const queued = useChat((s) => s.queued);
  const mode = useChat((s) => s.mode);
  const savedKey = useChat((s) => s.apiKey);
  const [key, setKey] = useState("");
  const save = () => {
    if (!key.trim()) return;
    setApiKey(key.trim());
    setMode("api");
  };
  return (
    <div className={"bridge-setup" + (alone ? " alone" : "")}>
      <b>Connect Claude</b>
      {queued && (
        <div className="queued-prompt">
          Waiting to send:{" "}
          <i>“{queued.length > 120 ? queued.slice(0, 120) + "…" : queued}”</i>.
          It goes out once Claude is connected (you'll be asked first if that takes a while).
        </div>
      )}
      <div>
        <b>Quickest:</b> paste an{" "}
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noreferrer"
        >
          Anthropic API key
        </a>{" "}
        (kept in this browser only, billed per use).
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="textinput"
          type="password"
          aria-label="Anthropic API key"
          placeholder="sk-ant-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") save();
          }}
        />
        <button className="btn primary" onClick={save} disabled={!key.trim()}>
          Connect
        </button>
      </div>
      {mode === "bridge" && savedKey && (
        <button className="btn" onClick={() => setMode("api")} title="Billed per use to your Anthropic API account">
          Use my saved API key instead
        </button>
      )}
      <details open={alone && mode === "bridge" && !queued && !isPhone()}>
        <summary>
          <b>Have Claude Pro or Max?</b> Use it at no extra cost
        </summary>
        <div style={{ margin: "6px 0" }}>
          The Designotron bridge runs your own Claude Code on this computer:
        </div>
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
            <a
              href="https://github.com/mikemich/designotron/releases/latest"
              target="_blank"
              rel="noreferrer"
            >
              Releases
            </a>
            .
          </li>
          <li>
            It starts in the background and at every login. If the installer
            says to start it yourself, run:
            <CopyLine text={RUN_CMD} />
          </li>
        </ol>
        <div className="muted">
          This page connects on its own a few seconds later. If it doesn't
          (Safari and Brave can stop websites from reaching your computer), use
          the copy of the editor the bridge serves at{" "}
          <a href="http://127.0.0.1:5174" target="_blank" rel="noreferrer">
            127.0.0.1:5174
          </a>
          .
        </div>
      </details>
    </div>
  );
}

/** Attaches a screenshot of the selection (or the topmost layer on the page) to the next message. */
async function attachCanvasShot() {
  try {
    const { getScreenshot } = await import("./browserTools");
    const shot = await getScreenshot(undefined, 1);
    const name = getDoc().nodes[shot.id]?.name ?? "canvas";
    attachImage(`data:image/png;base64,${shot.data}`, `${name}.png`);
  } catch (err) {
    toast(String(err instanceof Error ? err.message : err).replace(/^./, (c) => c.toUpperCase()), "error");
  }
}

/** A screenshot Claude took; click to see it larger. */
function Shot({ url, label }: { url: string; label: string }) {
  const [big, setBig] = useState(false);
  return (
    <div className={"msg shot" + (big ? " big" : "")}>
      <button className="shot-img" title={big ? "Smaller" : "Larger"} onClick={() => setBig(!big)}>
        <img src={url} alt={label} />
      </button>
      <span className="muted small">{label}</span>
    </div>
  );
}
