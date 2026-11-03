import { useMemo, useState } from "react";
import { Copy, Download, Image as ImageIcon, Sparkles } from "lucide-react";
import { getDoc, query, toast, useSelection, useStore } from "../store";
import { IconButton, Section, SelectField } from "../ui/controls";
import type { Node } from "../types";
import { copyText, exportProjectZip, withAssetPaths } from "../exporter";
import { inlineAssets } from "../assets";
import { askClaude } from "../ai/chatState";
import { Inspect } from "./Inspect";

type Lang = "react" | "html" | "svg" | "css";

export function CodePanel() {
  const nodes = useSelection();
  // Generated code depends on the document, not on what is selected beyond the layer's id.
  const docRev = useStore((s) => s.es.docRev);
  const [lang, setLang] = useState<Lang>("react");
  const n = nodes[0];
  const systemUi = !!n && inDeviceUi(n);
  // The engine writes images as `asset:<id>`. The snippet shows the paths an exported project
  // serves them from. Copy copies those paths; Copy with images inline embeds the bytes, which
  // work pasted into any project.
  const raw = useMemo(() => {
    if (!n || systemUi) return "";
    if (lang === "svg") return query<string>({ q: "exportSvg", id: n.id });
    if (lang === "css") return cssFor(n);
    return query<string>({ q: lang === "react" ? "exportReact" : "exportHtml", id: n.id });
  }, [n?.id, lang, docRev]);
  const hasImages = raw.includes("asset:");
  const code = useMemo(() => {
    const shown = withAssetPaths(raw);
    if (!hasImages || lang === "css") return shown;
    const note = "Images are written as /assets/<id>.<ext>, the files in public/assets of the downloaded project. Use Copy with images inline to embed them.";
    return lang === "html" || lang === "svg" ? `<!-- ${note} -->\n${shown}` : shown.replace("\n\n", `\n// ${note}\n\n`);
  }, [raw, lang, hasImages]);
  return (
    <div className="scroll">
      {n && <Inspect node={n} />}
      {n ? (
        <Section
          title={n.name}
          actions={
            <>
              <IconButton title={hasImages ? "Copy (image paths)" : "Copy"} onClick={() => copyText(withAssetPaths(raw), `Copied code for ${n.name}`, "code")}>
                <Copy size={13} />
              </IconButton>
              {hasImages && (
                <IconButton title="Copy with images inline" onClick={() => copyInline(raw, n.name)}>
                  <ImageIcon size={13} />
                </IconButton>
              )}
            </>
          }
        >
          <div className="row">
            <SelectField
              ariaLabel="Code language"
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
          {systemUi ? (
            <div className="muted small">Device UI, not exported. The real device or browser draws it, so code export leaves it out.</div>
          ) : (
            <div className="code-block" tabIndex={0} role="region" aria-label={`Code for ${n.name}`}>
              {code.length > 60000 ? code.slice(0, 60000) + "\n… (truncated, use Copy)" : code}
            </div>
          )}
        </Section>
      ) : (
        <Section title="Inspect">
          <div className="muted small">Select a layer to see its code.</div>
        </Section>
      )}
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
    </div>
  );
}

/** Whether a layer is part of a device frame's system UI (status bar, home indicator, window chrome). */
function inDeviceUi(n: Node): boolean {
  const doc = getDoc();
  for (let cur: Node | undefined = n; cur; cur = cur.parent ? doc.nodes[cur.parent] : undefined) if (cur.devicePart) return true;
  return false;
}

/** Copies the code with every image as a data URL, so it works pasted anywhere; big ones say so. */
async function copyInline(raw: string, name: string) {
  const text = inlineAssets(raw);
  await copyText(text, `Copied code for ${name} with images inline`, "code");
  if (text.length > 1_000_000) toast(`That is ${(text.length / 1_000_000).toFixed(1)} MB of code with the images inline; "Copy" keeps paths instead`);
}

export function cssFor(n: Node): string {
  const html = query<string>({ q: "exportHtml", id: n.id });
  const m = html.match(/<body>\s*<\w+ style="([^"]*)"/);
  const decl = (m?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const lines = decl
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `  ${s};`);
  const doc = getDoc();
  // A "*/" in the note would end the comment early and leak the rest into the stylesheet.
  const hint = n.notes ? `/* ${n.notes.replace(/\*\//g, "* /")} */\n` : "";
  return `${hint}.${(doc.nodes[n.id]?.name ?? "layer").replace(/[^\w]+/g, "-").toLowerCase()} {\n${lines.join("\n")}\n}`;
}
