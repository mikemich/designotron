// Projects and nested folders for the files dashboard: pure tree operations, no storage.
// A project is a folder with no parent. A file's folder is kept in its `dt:index` entry and
// never in the document; a file with no (or a missing) folder is in Drafts.

export interface FileMeta {
  id: string;
  name: string;
  updatedAt: number;
  thumbnail?: string;
  /** The folder the file is in; none means Drafts. */
  folder?: string;
}

export interface Folder {
  id: string;
  name: string;
  /** The folder this one is inside; null for a project. */
  parent: string | null;
  createdAt: number;
}

export interface FolderRecord {
  v: 1;
  folders: Folder[];
}

export const MAX_NAME = 80;

export function newFolderId(): string {
  return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** The first `max` graphemes of `s` (code points when `Intl.Segmenter` is missing), so a cut never
 *  leaves half an emoji or a lone surrogate. A grapheme that straddles the end is dropped whole. */
export function cutGraphemes(s: string, max: number): string {
  const Seg = (Intl as { Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const parts = Seg ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment) : Array.from(s);
  return parts.length <= max ? s : parts.slice(0, max).join("");
}

const cleanName = (raw: string) =>
  // eslint-disable-next-line no-control-regex
  raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();

/** Trims, collapses whitespace, strips control characters and caps the length at 80 graphemes. Empty means rejected. */
export function normalizeName(raw: string): string {
  return cutGraphemes(cleanName(raw), MAX_NAME).trim();
}

/** Whether `raw` is longer than a name may be, so `normalizeName` shortened it (for the notice). */
export function nameWasCut(raw: string): boolean {
  const clean = cleanName(raw);
  return clean.length > MAX_NAME && normalizeName(raw) !== clean;
}

/** The notice for a name that was shortened. */
export const NAME_CUT_NOTICE = `Names can be up to ${MAX_NAME} characters; it was shortened`;

/** `base`, or `base 2`, `base 3`... when a sibling already has that name. */
export function uniqueName(taken: string[], base: string): string {
  const has = new Set(taken.map((n) => n.toLowerCase()));
  if (!has.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!has.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Reads the stored folder record defensively: junk records are dropped, a parent that doesn't
 * exist makes the folder a project, and a stored cycle is broken by making a looping folder a
 * project. Whatever is stored, every file stays reachable. */
export function sanitizeFolders(raw: unknown): Folder[] {
  const list = Array.isArray((raw as FolderRecord | undefined)?.folders) ? (raw as FolderRecord).folders : [];
  const seen = new Set<string>();
  const out: Folder[] = [];
  for (const f of list as Partial<Folder>[]) {
    if (!f || typeof f.id !== "string" || !f.id || typeof f.name !== "string" || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({
      ...f,
      id: f.id,
      name: normalizeName(f.name) || "Untitled",
      parent: typeof f.parent === "string" ? f.parent : null,
      createdAt: typeof f.createdAt === "number" ? f.createdAt : 0,
    });
  }
  const byId = new Map(out.map((f) => [f.id, f]));
  for (const f of out) if (f.parent !== null && !byId.has(f.parent)) f.parent = null;
  for (const f of out) {
    // Walk up; reaching a folder already on this walk means a cycle.
    const walked = new Set<string>([f.id]);
    let at = f.parent;
    while (at !== null) {
      if (walked.has(at)) {
        f.parent = null;
        break;
      }
      walked.add(at);
      at = byId.get(at)?.parent ?? null;
    }
  }
  return out;
}

/** The folder a file is really in: an id that points to no folder means Drafts (undefined). */
export function resolveFolder(folders: Folder[], id: string | undefined): string | undefined {
  return id && folders.some((f) => f.id === id) ? id : undefined;
}

/** From the project down to the folder itself. Safe on cyclic input. */
export function ancestors(folders: Folder[], id: string | undefined): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [];
  const seen = new Set<string>();
  let at = id ? byId.get(id) : undefined;
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    path.unshift(at);
    at = at.parent ? byId.get(at.parent) : undefined;
  }
  return path;
}

/** "Acme / Marketing / Q4", or "Drafts". */
export function pathLabel(folders: Folder[], id: string | undefined): string {
  const path = ancestors(folders, resolveFolder(folders, id));
  return path.length ? path.map((f) => f.name).join(" / ") : "Drafts";
}

/** Folders directly inside `parent` (null for the projects), sorted by name. */
export function childrenOf(folders: Folder[], parent: string | null): Folder[] {
  return folders.filter((f) => f.parent === parent).sort((a, b) => compareNames(a.name, b.name) || a.createdAt - b.createdAt);
}

/** The folder and everything inside it, at any depth. */
export function subtreeIds(folders: Folder[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parent && out.has(f.parent) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Whether `id` can go inside `parent` (null: made a project): not into itself or its own subtree. */
export function canMoveFolder(folders: Folder[], id: string, parent: string | null): boolean {
  if (parent === null) return true;
  if (parent === id) return false;
  return !ancestors(folders, parent).some((f) => f.id === id);
}

export class FolderGoneError extends Error {
  constructor() {
    super("That folder no longer exists");
  }
}

/** Counts of what is directly inside a folder (for "3 files · 1 folder"). */
export function contents(folders: Folder[], files: FileMeta[], id: string): { files: number; folders: number } {
  return { files: files.filter((f) => f.folder === id).length, folders: folders.filter((f) => f.parent === id).length };
}

export function applyCreateFolder(folders: Folder[], parent: string | null, name: string, id = newFolderId(), now = Date.now()): { folders: Folder[]; folder: Folder } {
  if (parent !== null && !folders.some((f) => f.id === parent)) throw new FolderGoneError();
  const clean = normalizeName(name);
  if (!clean) throw new Error("A folder needs a name");
  const folder: Folder = { id, name: clean, parent, createdAt: now };
  return { folders: [...folders, folder], folder };
}

export function applyRenameFolder(folders: Folder[], id: string, name: string): Folder[] {
  if (!folders.some((f) => f.id === id)) throw new FolderGoneError();
  const clean = normalizeName(name);
  if (!clean) throw new Error("A folder needs a name");
  return folders.map((f) => (f.id === id ? { ...f, name: clean } : f));
}

export function applyMoveFolder(folders: Folder[], id: string, parent: string | null): Folder[] {
  if (!folders.some((f) => f.id === id) || (parent !== null && !folders.some((f) => f.id === parent))) throw new FolderGoneError();
  if (!canMoveFolder(folders, id, parent)) throw new Error("A folder can't go inside itself");
  return folders.map((f) => (f.id === id ? { ...f, parent } : f));
}

/** The entry placed in a folder (undefined: Drafts). */
function placed(f: FileMeta, target: string | undefined): FileMeta {
  const { folder: _old, ...rest } = f;
  return target === undefined ? rest : { ...rest, folder: target };
}

/** Moves files into a folder (undefined: Drafts). Throws when the target is gone. */
export function applyMoveFiles(folders: Folder[], files: FileMeta[], ids: string[], target: string | undefined): FileMeta[] {
  if (target !== undefined && !folders.some((f) => f.id === target)) throw new FolderGoneError();
  const set = new Set(ids);
  return files.map((f) => (set.has(f.id) ? placed(f, target) : f));
}

/** Removes a folder with everything inside it; the files in any of them go to Drafts. */
export function applyDeleteFolder(folders: Folder[], files: FileMeta[], id: string): { folders: Folder[]; files: FileMeta[]; moved: number; removed: number } {
  const gone = subtreeIds(folders, id);
  let moved = 0;
  const next = files.map((f) => {
    if (!f.folder || !gone.has(f.folder)) return f;
    moved++;
    return placed(f, undefined);
  });
  const kept = folders.filter((f) => !gone.has(f.id));
  return { folders: kept, files: next, moved, removed: folders.length - kept.length };
}

/** Adds or updates one index entry. An existing entry keeps every field the patch doesn't give
 * (its folder, its thumbnail, anything a later version adds); `folder` only places a new entry. */
export function upsertEntry(idx: FileMeta[], patch: Partial<FileMeta> & { id: string }, folder?: string): FileMeta[] {
  const prev = idx.find((f) => f.id === patch.id);
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const entry = (prev ? { ...prev, ...defined } : { ...(folder ? { folder } : {}), ...defined }) as FileMeta;
  return [...idx.filter((f) => f.id !== patch.id), entry];
}

/** What to say when deleting a folder. */
export function deleteSummary(folders: Folder[], files: FileMeta[], id: string): string {
  const f = folders.find((x) => x.id === id);
  const gone = subtreeIds(folders, id);
  const inner = gone.size - 1;
  const n = files.filter((x) => x.folder && gone.has(x.folder)).length;
  const head = `Delete “${f?.name ?? "this folder"}”${inner ? ` and ${inner} folder${inner === 1 ? "" : "s"} inside` : ""}?`;
  return `${head} ${n ? `${n} file${n === 1 ? "" : "s"} will move to Drafts.` : "It has no files."}`;
}
