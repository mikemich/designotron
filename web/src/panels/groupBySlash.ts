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

export interface FolderRename {
  /** The items that move, with their new full names (by position in `names`). */
  renames: { index: number; name: string }[];
  /** The first new name that another item already has (or two new names share), else null. */
  collision: string | null;
}

/**
 * Renames the folder `from` ("Brand/Primary") to `to` in the full names of every item inside it,
 * nested folders included: "Brand/Primary/500" becomes "Accent/500". Names are compared by their
 * trimmed segments, as `groupBySlash` reads them. Nothing changes when the new name would clash.
 */
export function renameFolder(names: string[], from: string, to: string): FolderRename {
  const parts = (s: string) => s.split("/").map((p) => p.trim()).filter((p) => p !== "");
  const src = parts(from);
  const dst = parts(to);
  const renames: { index: number; name: string }[] = [];
  if (!src.length || !dst.length || src.join("/") === dst.join("/")) return { renames, collision: null };
  names.forEach((full, index) => {
    const segs = parts(full);
    // Only items inside the folder (a name equal to the folder itself is an item next to it).
    if (segs.length > src.length && src.every((s, i) => segs[i] === s)) renames.push({ index, name: [...dst, ...segs.slice(src.length)].join("/") });
  });
  const moved = new Set(renames.map((r) => r.index));
  const taken = new Set(names.filter((_, i) => !moved.has(i)).map((n) => parts(n).join("/").toLowerCase()));
  for (const r of renames) {
    const key = r.name.toLowerCase();
    if (taken.has(key)) return { renames: [], collision: r.name };
    taken.add(key);
  }
  return { renames, collision: null };
}

/** How many items a folder holds, including nested folders. */
export function folderSize<T>(f: Folder<T>): number {
  return f.items.length + f.folders.reduce((n, g) => n + folderSize(g), 0);
}
