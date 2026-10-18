import { useMemo, useState } from "react";
import { Copy, Download, Play, Plus, Trash2, Sparkles } from "lucide-react";
import { dispatch, getDoc, query, useDoc, useSelection, useStore, type RightTab } from "../store";
import { DesignPanel } from "./DesignPanel";
import { ReviewPanel } from "./ReviewPanel";
import { AppPanel } from "./AppPanel";
import { IconButton, Section, SelectField } from "../ui/controls";
import type { Interaction, Node } from "../types";
import { exportProjectZip, nodeSvg } from "../exporter";
import { inlineAssets } from "../assets";
import { askClaude } from "../ai/chatState";

export function RightPanel() {
  const tab = useStore((s) => s.rightTab);
  const set = (rightTab: RightTab) => useStore.setState({ rightTab });
  return (
    <div className="panel right">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "design"} className={"tab" + (tab === "design" ? " active" : "")} onClick={() => set("design")}>
          Design
        </button>
        <button role="tab" aria-selected={tab === "prototype"} className={"tab" + (tab === "prototype" ? " active" : "")} onClick={() => set("prototype")}>
          Prototype
        </button>
        <button role="tab" aria-selected={tab === "code"} className={"tab" + (tab === "code" ? " active" : "")} onClick={() => set("code")}>
          Code
        </button>
        <button role="tab" aria-selected={tab === "review"} className={"tab" + (tab === "review" ? " active" : "")} onClick={() => set("review")}>
          Review
        </button>
        <button role="tab" aria-selected={tab === "app"} className={"tab" + (tab === "app" ? " active" : "")} onClick={() => set("app")}>
          App
        </button>
      </div>
      {tab === "design" && <DesignPanel />}
      {tab === "prototype" && <PrototypePanel />}
      {tab === "code" && <CodePanel />}
      {tab === "review" && <ReviewPanel />}
      {tab === "app" && <AppPanel />}
    </div>
  );
}

const DEFAULT_INTERACTION: Interaction = {
  trigger: "onClick",
  delayMs: 800,
  action: "navigate",
  destination: null,
  url: null,
  transition: "dissolve",
  durationMs: 300,
};

function PrototypePanel() {
  const doc = useDoc();
  const nodes = useSelection();
  const page = doc.pages.find((p) => p.id === useStore.getState().es.page);
  const frames = (page?.children ?? []).map((id) => doc.nodes[id]).filter((n) => n && ["frame", "component"].includes(n.type));
  const n = nodes.length === 1 ? nodes[0] : null;
  const isTop = n && !n.parent;
  return (
    <div className="scroll">
      <Section title="Flow">
        <div className="row">
          <SelectField
            label="▶"
            title="Flow starting point"
            value={page?.flowStart ?? ""}
            options={[{ value: "", label: "First frame" }, ...frames.map((f) => ({ value: f.id, label: f.name }))]}
            onChange={(id) => page && dispatch({ op: "setFlowStart", page: page.id, id: id || null })}
          />
        </div>
        <button className="btn block primary" onClick={() => useStore.setState({ presenting: page?.flowStart ?? frames.find((f) => f.type === "frame")?.id ?? frames[0]?.id ?? null })} disabled={!frames.length}>
          <Play size={13} /> Present
        </button>
        <div className="muted small" style={{ marginTop: 8 }}>
          Select a layer and drag the blue handle on its right edge onto a frame to link them.
        </div>
      </Section>
      {n && (
        <Section
          title="Interactions"
          actions={
            <IconButton title="Add interaction" onClick={() => dispatch({ op: "setInteractions", id: n.id, interactions: [...n.interactions, { ...DEFAULT_INTERACTION, destination: frames.find((f) => f.id !== n.id)?.id ?? null }] })}>
              <Plus size={14} />
            </IconButton>
          }
        >
          {n.interactions.length === 0 && <div className="muted small">No interactions on “{n.name}”.</div>}
          {n.interactions.map((it, i) => (
            <InteractionEditor key={i} node={n} index={i} frames={frames} />
          ))}
          {isTop && (
            <button className="btn block" onClick={() => page && dispatch({ op: "setFlowStart", page: page.id, id: n.id })}>
              Set “{n.name}” as starting point
            </button>
          )}
        </Section>
      )}
    </div>
  );
}

function InteractionEditor({ node, index, frames }: { node: Node; index: number; frames: Node[] }) {
  const it = node.interactions[index];
  const set = (patch: Partial<Interaction>) => dispatch({ op: "setInteractions", id: node.id, interactions: node.interactions.map((x, i) => (i === index ? { ...x, ...patch } : x)) });
  return (
    <div style={{ background: "var(--panel-2)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
      <div className="row">
        <SelectField
          value={it.trigger}
          options={[
            { value: "onClick", label: "On click" },
            { value: "onHover", label: "While hovering" },
            { value: "onPress", label: "While pressing" },
            { value: "afterDelay", label: "After delay" },
          ]}
          onChange={(trigger) => set({ trigger })}
        />
        <IconButton title="Remove" onClick={() => dispatch({ op: "setInteractions", id: node.id, interactions: node.interactions.filter((_, i) => i !== index) })}>
          <Trash2 size={13} />
        </IconButton>
      </div>
      <div className="row">
        <SelectField
          value={it.action}
          options={[
            { value: "navigate", label: "Navigate to" },
            { value: "back", label: "Back" },
            { value: "openUrl", label: "Open link" },
          ]}
          onChange={(action) => set({ action })}
        />
      </div>
      {it.action === "navigate" && (
        <div className="row">
          <SelectField value={it.destination ?? ""} options={[{ value: "", label: "Choose frame…" }, ...frames.map((f) => ({ value: f.id, label: f.name }))]} onChange={(destination) => set({ destination: destination || null })} />
        </div>
      )}
      {it.action === "openUrl" && (
        <input className="textinput" placeholder="https://" defaultValue={it.url ?? ""} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => set({ url: e.target.value })} />
      )}
      {it.action === "navigate" && (
        <div className="row">
          <SelectField
            value={it.transition}
            options={[
              { value: "instant", label: "Instant" },
              { value: "dissolve", label: "Dissolve" },
              { value: "smartAnimate", label: "Smart animate" },
              { value: "slideLeft", label: "Slide left" },
              { value: "slideRight", label: "Slide right" },
              { value: "slideUp", label: "Slide up" },
              { value: "slideDown", label: "Slide down" },
            ]}
            onChange={(transition) => set({ transition })}
          />
        </div>
      )}
    </div>
  );
}

function CodePanel() {
  const nodes = useSelection();
  const rev = useStore((s) => s.rev);
  const [lang, setLang] = useState<"react" | "html" | "svg" | "css">("react");
  const n = nodes[0];
  const code = useMemo(() => {
    if (!n) return "";
    if (lang === "svg") return nodeSvg(n.id);
    if (lang === "css") return cssFor(n);
    return inlineAssets(query<string>({ q: lang === "react" ? "exportReact" : "exportHtml", id: n.id }));
  }, [n?.id, lang, rev]);
  return (
    <div className="scroll">
      <Section title="Build the real thing">
        <div className="muted small" style={{ marginBottom: 8 }}>
          Every top-level frame becomes a screen; prototype links become navigation.
        </div>
        <button className="btn block" style={{ marginBottom: 6 }} onClick={() => exportProjectZip()}>
          <Download size={13} /> Download React + Tailwind project
        </button>
        <button
          className="btn block primary"
          onClick={() =>
            askClaude(
              "Turn this design into a production-quality React + Tailwind app in the workspace. Use export_code with format 'project' as the starting point, then refactor into clean, responsive components, keep prototype navigation working, run the build to verify it compiles, and tell me how to run it.",
            )
          }
        >
          <Sparkles size={13} /> Build with Claude Code
        </button>
      </Section>
      {n ? (
        <Section
          title={n.name}
          actions={
            <IconButton title="Copy" onClick={() => navigator.clipboard.writeText(code)}>
              <Copy size={13} />
            </IconButton>
          }
        >
          <div className="row">
            <SelectField
              value={lang}
              options={[
                { value: "react", label: "React + Tailwind" },
                { value: "html", label: "HTML + CSS" },
                { value: "css", label: "CSS (this layer)" },
                { value: "svg", label: "SVG" },
              ]}
              onChange={setLang}
            />
          </div>
          <div className="code-block">{code.length > 60000 ? code.slice(0, 60000) + "\n… (truncated, use Copy)" : code}</div>
        </Section>
      ) : (
        <Section title="Inspect">
          <div className="muted small">Select a layer to see its code.</div>
        </Section>
      )}
    </div>
  );
}

function cssFor(n: Node): string {
  const html = query<string>({ q: "exportHtml", id: n.id });
  const m = html.match(/<body>\s*<\w+ style="([^"]*)"/);
  const decl = (m?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const lines = decl
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `  ${s};`);
  const doc = getDoc();
  const hint = n.notes ? `/* ${n.notes} */\n` : "";
  return `${hint}.${(doc.nodes[n.id]?.name ?? "layer").replace(/[^\w]+/g, "-").toLowerCase()} {\n${lines.join("\n")}\n}`;
}
