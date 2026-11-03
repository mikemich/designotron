// Slash folders: "Brand/Primary/500" is the item "500" in the folder Brand > Primary. Pure,
// shared by the Assets panel (components and every style kind) and the Variables dialog.

export interface Folder<T> {
  /** Last path segment ("Primary"). */
  name: string;
  /** Full path ("Brand/Primary"), unique per folder: the key for open/closed state. */
  path: string;
  folders: Folder<T>[];
  items: Entry<T>[];
}

export interface Entry<T> {
  item: T;
  /** The name without its folders ("500"). */
  label: string;
}

/**
 * Groups items by the folders in their names. Folders and items keep the order in which they
 * first appear; an item whose name has no folder (or only empty segments) is at the root.
 * A name that is also a folder ("Brand" and "Brand/Primary") stays an item next to the folder.
 */
export function groupBySlash<T>(items: T[], name: (item: T) => string): Folder<T> {
  const root: Folder<T> = { name: "", path: "", folders: [], items: [] };
  for (const item of items) {
    const full = name(item);
    const segments = full
      .split("/")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    if (segments.length < 2) {
      root.items.push({ item, label: segments[0] ?? full });
      continue;
    }
    let at = root;
    for (const seg of segments.slice(0, -1)) {
      let next = at.folders.find((f) => f.name === seg);
      if (!next) {
        next = { name: seg, path: at.path ? `${at.path}/${seg}` : seg, folders: [], items: [] };
        at.folders.push(next);
      }
      at = next;
    }
    at.items.push({ item, label: segments[segments.length - 1] });
  }
  return root;
}

/** How many items a folder holds, including nested folders. */
export function folderSize<T>(f: Folder<T>): number {
  return f.items.length + f.folders.reduce((n, g) => n + folderSize(g), 0);
}
