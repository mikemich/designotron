import { useEffect, useState } from "react";
import { getFileMeta, listFolders, onIndexChange } from "../files";
import { ancestors, pathLabel, resolveFolder, type Folder } from "../folders";
import { useStore } from "../store";

/** Where the open file is (its folders, or Drafts), kept current when it is moved in another tab. */
function useFileLocation(fileId: string | null): { path: Folder[]; label: string } {
  const [state, setState] = useState<{ path: Folder[]; label: string }>({ path: [], label: "Drafts" });
  useEffect(() => {
    if (!fileId) return;
    let live = true;
    const read = async () => {
      try {
        const [meta, folders] = await Promise.all([getFileMeta(fileId), listFolders()]);
        if (!live) return;
        const at = resolveFolder(folders, meta?.folder);
        const path = ancestors(folders, at);
        const label = pathLabel(folders, at);
        setState((s) => (s.label === label && s.path.map((f) => f.id + f.name).join() === path.map((f) => f.id + f.name).join() ? s : { path, label }));
      } catch {
        /* keep what is shown */
      }
    };
    read();
    const off = onIndexChange(read);
    return () => {
      live = false;
      off();
    };
  }, [fileId]);
  return state;
}

/** "Acme / Marketing / Q4 /" before the file name in the top bar; each folder links to it. A long
 * path keeps the first and last folder. Hidden on phones (the whole top bar centre is). */
export function FileLocation() {
  const fileId = useStore((s) => s.fileId);
  const { path, label } = useFileLocation(fileId);
  const shown = path.length > 2 ? [path[0], null, path[path.length - 1]] : path;
  return (
    <nav className="file-loc" aria-label="File location" title={label}>
      {path.length === 0 ? (
        <a href="#/drafts">Drafts</a>
      ) : (
        shown.map((f, i) => (
          <span key={f ? f.id : "gap"} className="seg">
            {i > 0 && (
              <span aria-hidden="true" className="sep">
                /
              </span>
            )}
            {f ? <a href={`#/folder/${f.id}`}>{f.name}</a> : <span aria-hidden="true">…</span>}
          </span>
        ))
      )}
      <span aria-hidden="true" className="sep">
        /
      </span>
    </nav>
  );
}
