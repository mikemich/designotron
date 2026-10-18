import { useEffect, useState } from "react";
import { FilePlus, FolderOpen, MoreHorizontal, Sparkles } from "lucide-react";
import { deleteFile, duplicateFile, fromDtron, listFiles, newFileId, pickFile, renameFile, saveFile, type FileMeta } from "./files";
import { getEngine, newEngine, dispatch, toast, useStore } from "./store";
import { buildSample } from "./sample";
import { Menu, type MenuItem } from "./ui/controls";

export function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const t = useStore((s) => s.toast);
  const refresh = () => listFiles().then(setFiles);
  useEffect(() => {
    refresh();
  }, []);

  const create = async (sample: boolean) => {
    newEngine();
    if (sample) buildSample();
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
      const json = fromDtron(await f.text());
      const id = newFileId();
      await saveFile(id, JSON.parse(json).name ?? f.name, json);
      onOpen(id);
    } catch (err) {
      toast(String(err), "error");
    }
  };

  return (
    <div className="files">
      <div className="files-head">
        <div className="logo">D</div>
        <h1>Designotron</h1>
        <span className="muted">Free, open-source design tool with Claude built in</span>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={importFile}>
          <FolderOpen size={14} /> Open .dtron
        </button>
        <button className="btn primary" onClick={() => create(false)}>
          <FilePlus size={14} /> New design file
        </button>
      </div>
      {files && files.length === 0 && (
        <div className="hero">
          <Sparkles size={32} color="#9b85ff" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Start with the sample file</div>
            <div className="muted">Two screens built with auto layout, a component, and a prototype link. Open the Claude panel (⌘/) to keep designing with AI.</div>
          </div>
          <button className="btn primary" onClick={() => create(true)}>
            Open sample
          </button>
        </div>
      )}
      <div className="files-grid">
        {files?.map((f) => (
          <div key={f.id} className="file-card" onClick={() => onOpen(f.id)}>
            <div className="thumb">{f.thumbnail ? <img src={f.thumbnail} alt="" /> : <span className="muted">No preview yet</span>}</div>
            <div className="meta">
              <div className="n">{f.name}</div>
              <div className="muted small">Edited {new Date(f.updatedAt).toLocaleString()}</div>
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
        {files && files.length > 0 && (
          <div className="file-card" onClick={() => create(true)}>
            <div className="thumb">
              <Sparkles size={28} color="#9b85ff" />
            </div>
            <div className="meta">
              <div className="n">New sample file</div>
              <div className="muted small">Screens, components, prototype</div>
            </div>
          </div>
        )}
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {t && <div className={"toast " + t.kind}>{t.text}</div>}
    </div>
  );
}
