// Collapsible slash folders for the Assets panel and the Variables dialog (see groupBySlash.ts).

import { useMemo, useReducer, type ReactNode } from "react";
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
}: {
  scope: string;
  items: T[];
  name: (item: T) => string;
  /** One row; `label` is the name without its folders, `depth` the folder nesting. */
  row: (item: T, label: string, depth: number) => ReactNode;
  forceOpen?: boolean;
  /** Extra left padding in px for the whole tree. */
  indent?: number;
}) {
  const folderState = useFolderState(scope);
  const tree = useMemo(() => groupBySlash(items, name), [items, name]);
  const renderFolder = (f: Folder<T>, depth: number): ReactNode => {
    const open = forceOpen || folderState.isOpen(f.path);
    return (
      <div key={f.path} className="asset-folder-wrap" role="group" aria-label={f.name}>
        <button
          className="asset-folder"
          style={{ paddingLeft: indent + 4 + depth * 12 }}
          aria-expanded={open}
          title={f.path}
          onClick={() => !forceOpen && folderState.toggle(f.path)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="asset-folder-name">{f.name}</span>
          <span className="muted small">{folderSize(f)}</span>
        </button>
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
