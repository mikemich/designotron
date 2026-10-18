import { useEffect, useState } from "react";
import { Figma, FilePlus, FolderOpen, Github, Loader2, MoreHorizontal } from "lucide-react";
import { REPO_URL } from "./panels/GuestBar";
import { deleteFile, duplicateFile, importDtron, listFiles, newFileId, pickFile, renameFile, saveFile, type FileMeta } from "./files";
import { bootEngine, getEngine, newEngine, dispatch, toast, useBoot, useStore } from "./store";
import { TEMPLATES, type Template } from "./templates";
import { persistentStorage } from "./files";
import { Menu, type MenuItem } from "./ui/controls";

/** "just now", "5 minutes ago", "yesterday", or a date. */
function edited(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  if (h < 48) return "yesterday";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const t = useStore((s) => s.toast);
  const engineError = useBoot((s) => s.error);
  /** The file being created while the engine loads ("new" or a template id). */
  const [opening, setOpening] = useState<string | null>(null);
  const refresh = () => listFiles().then(setFiles);
  useEffect(() => {
    refresh();
  }, []);

  const create = async (template: Template | null) => {
    setOpening(template?.id ?? "new");
    try {
      await bootEngine();
    } catch {
      setOpening(null);
      return;
    }
    newEngine();
    if (template) template.build();
    else dispatch({ op: "setDocName", name: "Untitled" });
    const id = newFileId();
    const json = getEngine().save();
    await saveFile(id, JSON.parse(json).name, json);
    onOpen(id);
  };

  const importFile = async () => {
    const f = await pickFile(".dtron,.json");
    if (!f) return;
    try {
      onOpen(await importDtron(await f.text(), f.name.replace(/\.(dtron|json)$/, "")));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  return (
    <div className="files">
      <div className="files-head">
        <div className="logo">D</div>
        <h1>Designotron</h1>
        <span className="muted">Free, open-source design tool with Claude built in</span>
        <div style={{ flex: 1 }} />
        <a className="btn" href={REPO_URL} target="_blank" rel="noreferrer" title="Designotron is free and open source. A star helps others find it">
          <Github size={14} /> Star
        </a>
        <button className="btn" onClick={importFile}>
          <FolderOpen size={14} /> Open .dtron
        </button>
        <button
          className="btn"
          onClick={async () => {
            useStore.setState({ figmaOpen: "new" });
            await create(null);
          }}
        >
          <Figma size={14} /> Import from Figma
        </button>
        <button className="btn primary" onClick={() => create(null)} disabled={!!opening}>
          {opening === "new" ? <Loader2 size={14} className="spin" /> : <FilePlus size={14} />} {opening === "new" ? "Loading editor…" : "New design file"}
        </button>
      </div>
      {engineError && (
        <div className="error-box" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <span>The editor engine couldn't load. Check your connection; your files are safe.</span>
          <button className="btn" onClick={() => bootEngine().catch(() => {})}>
            Retry
          </button>
        </div>
      )}
      {!persistentStorage() && (
        <div className="hero" style={{ padding: 14 }}>
          <span className="muted">This browser isn't keeping files between visits here. Use Save as .dtron from the editor menu to keep your work.</span>
        </div>
      )}
      <div className="section-head" style={{ marginBottom: 12, fontSize: 14 }}>
        Start from a template
      </div>
      <div className="files-grid" style={{ marginBottom: 32 }}>
        {TEMPLATES.map((t) => (
          <div key={t.id} className="file-card" onClick={() => !opening && create(t)}>
            <TemplateThumb t={t} />
            <div className="meta">
              <div className="n">{t.name}</div>
              <div className="muted small">{opening === t.id ? "Loading editor…" : t.description}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="section-head" style={{ marginBottom: 12, fontSize: 14 }}>
        Your files
      </div>
      {files && files.length === 0 && <div className="muted" style={{ marginBottom: 20 }}>No files yet. Pick a template above or create a new file.</div>}
      <div className="files-grid">
        {files?.map((f) => (
          <div key={f.id} className="file-card" onClick={() => onOpen(f.id)}>
            <div className="thumb">{f.thumbnail ? <img src={f.thumbnail} alt="" /> : <span className="muted">No preview yet</span>}</div>
            <div className="meta">
              <div className="n">{f.name}</div>
              <div className="muted small" title={new Date(f.updatedAt).toLocaleString()}>
                Edited {edited(f.updatedAt)}
              </div>
            </div>
            <button
              className="ibtn more"
              onClick={(e) => {
                e.stopPropagation();
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    { label: "Open", onClick: () => onOpen(f.id) },
                    {
                      label: "Rename",
                      onClick: async () => {
                        const name = window.prompt("File name", f.name);
                        if (name) {
                          await renameFile(f.id, name);
                          refresh();
                        }
                      },
                    },
                    { label: "Duplicate", onClick: async () => (await duplicateFile(f.id), refresh()) },
                    { sep: true },
                    {
                      label: "Delete",
                      onClick: async () => {
                        if (window.confirm(`Delete “${f.name}”? This cannot be undone.`)) {
                          await deleteFile(f.id);
                          refresh();
                        }
                      },
                    },
                  ],
                });
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        ))}
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {t && <div className={"toast " + t.kind}>{t.text}</div>}
    </div>
  );
}

/** Small schematic preview of a template. */
function TemplateThumb({ t }: { t: Template }) {
  const [bg, accent] = t.colors;
  const block = (style: React.CSSProperties, key?: number) => <div key={key} style={{ position: "absolute", borderRadius: 4, ...style }} />;
  return (
    <div className="thumb" style={{ position: "relative", background: bg }}>
      {t.id === "mobile" && (
        <>
          {block({ left: "30%", top: 14, width: "18%", height: 112, background: "#0E0B1F", border: `2px solid ${accent}` })}
          {block({ left: "52%", top: 14, width: "18%", height: 112, background: "#F6F5FB" })}
          {block({ left: "33%", top: 96, width: "12%", height: 10, background: accent })}
        </>
      )}
      {t.id === "landing" && (
        <>
          {block({ left: "12%", top: 16, width: "76%", height: 46, background: "#1E293B" })}
          {block({ left: "36%", top: 50, width: "28%", height: 8, background: accent })}
          {[0, 1, 2].map((i) => block({ left: `${12 + i * 26}%`, top: 72, width: "23%", height: 50, background: "#F8FAFC" }, i))}
        </>
      )}
      {t.id === "dashboard" && (
        <>
          {block({ left: "10%", top: 14, width: "16%", height: 112, background: "#0F172A" })}
          {[0, 1, 2].map((i) => block({ left: `${30 + i * 20}%`, top: 14, width: "17%", height: 24, background: "#FFFFFF", border: "1px solid #E2E8F0" }, i))}
          {block({ left: "30%", top: 46, width: "57%", height: 80, background: "#FFFFFF", border: "1px solid #E2E8F0" })}
          {[0, 1, 2, 3, 4, 5].map((i) => block({ left: `${34 + i * 8.5}%`, top: 120 - (20 + ((i * 37) % 50)), width: "5%", height: 20 + ((i * 37) % 50), background: accent }, i))}
        </>
      )}
      {t.id === "system" && (
        <>
          {["#F97316", "#C2410C", "#1C1917", "#78716C", "#16A34A"].map((c, i) => block({ left: `${12 + i * 15}%`, top: 22, width: "12%", height: 34, background: c }, i))}
          {block({ left: "12%", top: 72, width: "22%", height: 18, background: accent, borderRadius: 6 })}
          {block({ left: "38%", top: 72, width: "22%", height: 18, background: "#FFFFFF", border: "1px solid #D6D3D1", borderRadius: 6 })}
          {block({ left: "12%", top: 100, width: "48%", height: 6, background: "#D6D3D1" })}
        </>
      )}
    </div>
  );
}
