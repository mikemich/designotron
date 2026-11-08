// Collapsible slash folders for the Assets panel and the Variables dialog (see groupBySlash.ts).

import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { folderSize, groupBySlash, type Entry, type Folder } from "./groupBySlash";

/** Folders the person collapsed. UI-only: never saved, and shared by every list that uses the same scope. */
const collapsed = new Set<string>();

/** Open/closed state of one scope's folders, for lists that draw their own rows (the Variables table). */
export function useFolderState(scope: string) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  return {
    isOpen: (path: string) => !collapsed.has(`${scope}:${path}`),
    toggle: (path: string) => {
      const key = `${scope}:${path}`;
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      bump();
    },
  };
}

/**
 * The name field that replaces a folder's label while it is renamed (double-click or F2): Enter or
 * blur commits, Escape cancels. `onDone` gets the new path of the folder (parents included), or
 * null when nothing changed.
 */
export function FolderRenameInput({ path, onDone }: { path: string; onDone: (to: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(path);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (to: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(to);
  };
  return (
    <input
      ref={ref}
      className="textinput wf-folder-rename"
      aria-label={`Rename folder ${path}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(text.trim() === path ? null : text.trim());
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(text.trim() === path ? null : text.trim())}
    />
  );
}

/**
 * Items grouped by the folders in their names. `scope` keeps the open/closed state of one list
 * apart from the others ("colour", "text", "components", "variables:<collection>").
 * With `forceOpen` (a search is active) every folder is open and nothing is remembered.
 */
export function FolderTree<T>({
  scope,
  items,
  name,
  row,
  forceOpen = false,
  indent = 0,
  onRenameFolder,
}: {
  scope: string;
  items: T[];
  name: (item: T) => string;
  /** One row; `label` is the name without its folders, `depth` the folder nesting. */
  row: (item: T, label: string, depth: number) => ReactNode;
  forceOpen?: boolean;
  /** Extra left padding in px for the whole tree. */
  indent?: number;
  /** Renames a folder (double-click or F2 on its row): the full path it had and the full path it should get. */
  onRenameFolder?: (from: string, to: string) => void;
}) {
  const folderState = useFolderState(scope);
  const [renaming, setRenaming] = useState<string | null>(null);
  const tree = useMemo(() => groupBySlash(items, name), [items, name]);
  const renderFolder = (f: Folder<T>, depth: number): ReactNode => {
    const open = forceOpen || folderState.isOpen(f.path);
    return (
      <div key={f.path} className="asset-folder-wrap" role="group" aria-label={f.name}>
        {renaming === f.path ? (
          <div className="asset-folder" style={{ paddingLeft: indent + 4 + depth * 12 }}>
            <FolderRenameInput
              path={f.path}
              onDone={(to) => {
                setRenaming(null);
                if (to) onRenameFolder?.(f.path, to);
              }}
            />
          </div>
        ) : (
          <button
            className="asset-folder"
            style={{ paddingLeft: indent + 4 + depth * 12 }}
            aria-expanded={open}
            title={onRenameFolder ? `${f.path}\nDouble-click or press F2 to rename` : f.path}
            onClick={() => !forceOpen && folderState.toggle(f.path)}
            onDoubleClick={onRenameFolder ? () => setRenaming(f.path) : undefined}
            onKeyDown={onRenameFolder ? (e) => e.key === "F2" && (e.preventDefault(), setRenaming(f.path)) : undefined}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="asset-folder-name">{f.name}</span>
            <span className="muted small">{folderSize(f)}</span>
          </button>
        )}
        {open && (
          <>
            {f.folders.map((g) => renderFolder(g, depth + 1))}
            {f.items.map((e: Entry<T>) => row(e.item, e.label, depth + 1))}
          </>
        )}
      </div>
    );
  };
  return (
    <>
      {tree.folders.map((f) => renderFolder(f, 0))}
      {tree.items.map((e) => row(e.item, e.label, 0))}
    </>
  );
}
