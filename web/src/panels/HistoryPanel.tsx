import { useEffect, useState } from "react";
import { Copy, History, RotateCcw, Trash2 } from "lucide-react";
import { dispatchOrThrow, getDoc, getEngine, toast, useStore } from "../store";
import { deleteVersion, getFileMeta, listVersions, loadVersion, newDocId, newFileId, withSuffix, renameVersion, saveFile, saveVersion, type Version } from "../files";
import { IconButton, Section } from "../ui/controls";
import { attempt, reportFailure } from "../errors";

/** Saves an automatic version when the last one is older than this. */
export const AUTO_VERSION_MS = 10 * 60 * 1000;

function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Automatic versions are labelled as such with their time, whatever they were stored as
 *  (older ones say "Autosave"). Renaming one makes it a named version (`auto: false`). */
export function versionLabel(v: Version): string {
  // Only the plain automatic ones are renamed; a safety copy ("Before restoring …") keeps its name.
  if (!v.auto || (v.name !== "Autosave" && v.name !== "Automatic version")) return v.name;
  return `Automatic version · ${new Date(v.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** Named and automatic snapshots of this file; restoring is one undoable step. */
export function HistoryPanel() {
  const fileId = useStore((s) => s.fileId);
  const [versions, setVersions] = useState<Version[]>([]);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const refresh = () => {
    if (fileId) listVersions(fileId).then(setVersions, (e) => reportFailure("read the versions", e));
  };
  useEffect(() => {
    refresh();
  }, [fileId]);
  if (!fileId) return null;

  const save = async () => {
    if (useStore.getState().tabView) return toast("This tab only shows the file. Edit it in the other tab to save a version.", "error");
    const saved = await attempt("save the version", () =>
      saveVersion(fileId, name.trim() || `Version ${versions.filter((v) => !v.auto).length + 1}`, getEngine().save()),
    );
    if (saved) setName("");
    refresh();
  };
  const restore = async (v: Version) => {
    if (useStore.getState().tabView) return toast("This tab only shows the file. Restore in the tab that edits it.", "error");
    await attempt("restore the version", async () => {
      const json = await loadVersion(fileId, v.id);
      if (!json) return toast("That version could not be read", "error");
      await saveVersion(fileId, `Before restoring “${versionLabel(v)}”`, getEngine().save(), true);
      // The file keeps its current name: a version is about the design, not what it's called.
      const doc = JSON.parse(json);
      doc.name = getDoc().name;
      dispatchOrThrow({ op: "replaceDocument", doc, keepComments: true });
      toast(`Restored “${versionLabel(v)}”. Undo to go back.`);
    });
    refresh();
  };
  const duplicate = async (v: Version) => {
    await attempt("duplicate the version", async () => {
      const json = await loadVersion(fileId, v.id);
      if (!json) return toast("That version could not be read", "error");
      const doc = JSON.parse(json);
      doc.name = withSuffix(getDoc().name, ` (${versionLabel(v)})`);
      doc.id = newDocId();
      await saveFile(newFileId(), doc.name, JSON.stringify(doc), { folder: (await getFileMeta(fileId))?.folder });
      toast(`Saved “${doc.name}” to your files`);
    });
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
                  // Unchanged (focus, then blur) is not a rename: an automatic version stays automatic.
                  const next = e.target.value.trim();
                  if (next && next !== versionLabel(v) && next !== v.name) await attempt("rename the version", () => renameVersion(fileId, v.id, e.target.value.trim()));
                  refresh();
                }}
              />
            ) : (
              <div className="version-name" title="Double-click to rename" onDoubleClick={() => setRenaming(v.id)}>
                {versionLabel(v)}
                {v.auto && <span className="sr-only"> (automatic)</span>}
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
          <IconButton title="Delete" onClick={() => attempt("delete the version", () => deleteVersion(fileId, v.id)).then(refresh)}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
