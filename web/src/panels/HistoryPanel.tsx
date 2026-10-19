import { useEffect, useState } from "react";
import { Copy, History, RotateCcw, Trash2 } from "lucide-react";
import { dispatchOrThrow, getDoc, getEngine, toast, useStore } from "../store";
import { deleteVersion, listVersions, loadVersion, newFileId, renameVersion, saveFile, saveVersion, type Version } from "../files";
import { IconButton, Section } from "../ui/controls";

/** Saves an automatic version when the last one is older than this. */
export const AUTO_VERSION_MS = 10 * 60 * 1000;

function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Named and automatic snapshots of this file; restoring is one undoable step. */
export function HistoryPanel() {
  const fileId = useStore((s) => s.fileId);
  const [versions, setVersions] = useState<Version[]>([]);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const refresh = () => {
    if (fileId) listVersions(fileId).then(setVersions);
  };
  useEffect(() => {
    refresh();
  }, [fileId]);
  if (!fileId) return null;

  const save = async () => {
    await saveVersion(fileId, name.trim() || `Version ${versions.filter((v) => !v.auto).length + 1}`, getEngine().save());
    setName("");
    refresh();
  };
  const restore = async (v: Version) => {
    const json = await loadVersion(fileId, v.id);
    if (!json) return toast("That version could not be read", "error");
    await saveVersion(fileId, `Before restoring “${v.name}”`, getEngine().save(), true);
    // The file keeps its current name: a version is about the design, not what it's called.
    const doc = JSON.parse(json);
    doc.name = getDoc().name;
    dispatchOrThrow({ op: "replaceDocument", doc });
    toast(`Restored “${v.name}”. Undo to go back.`);
    refresh();
  };
  const duplicate = async (v: Version) => {
    const json = await loadVersion(fileId, v.id);
    if (!json) return;
    const doc = JSON.parse(json);
    doc.name = `${getDoc().name} (${v.name})`;
    await saveFile(newFileId(), doc.name, JSON.stringify(doc));
    toast(`Saved “${doc.name}” to your files`);
  };

  return (
    <div className="scroll history">
      <Section title="Save a version">
        <div className="row">
          <input
            className="textinput"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") save();
            }}
          />
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          Versions are kept in this browser. An automatic one is saved every 10 minutes while you edit.
        </div>
      </Section>
      {versions.length === 0 && <div className="section muted small">No versions yet.</div>}
      {versions.map((v) => (
        <div key={v.id} className={"version" + (v.auto ? " auto" : "")}>
          <History size={13} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {renaming === v.id ? (
              <input
                className="textinput"
                autoFocus
                defaultValue={v.name}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={async (e) => {
                  setRenaming(null);
                  if (e.target.value.trim()) await renameVersion(fileId, v.id, e.target.value.trim());
                  refresh();
                }}
              />
            ) : (
              <div className="version-name" title="Double-click to rename" onDoubleClick={() => setRenaming(v.id)}>
                {v.name}
              </div>
            )}
            <div className="muted small">{ago(v.createdAt)}</div>
          </div>
          <IconButton title="Restore this version" onClick={() => restore(v)}>
            <RotateCcw size={13} />
          </IconButton>
          <IconButton title="Duplicate as a new file" onClick={() => duplicate(v)}>
            <Copy size={13} />
          </IconButton>
          <IconButton title="Delete" onClick={() => deleteVersion(fileId, v.id).then(refresh)}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
