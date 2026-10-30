// Local file storage (IndexedDB) and the portable `.dtron` file format.

import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import { allAssets, loadAssets, referencedAssets } from "./assets";
import { documentLoads } from "./store";

export interface FileMeta {
  id: string;
  name: string;
  updatedAt: number;
  thumbnail?: string;
}

interface StoredFile {
  doc: string;
  assets: Record<string, string>;
}

/** Portable file wrapper written by "Save as .dtron" and read by the bridge. */
export interface DtronFile {
  format: "designotron";
  version: 1;
  document: unknown;
  assets: Record<string, string>;
}

const INDEX = "dt:index";

// IndexedDB can be missing or throw (private windows, sandboxed previews); fall back to memory.
const memory = new Map<string, unknown>();
let idbOk = true;

async function get(key: string): Promise<unknown> {
  if (idbOk) {
    try {
      return await idbGet(key);
    } catch {
      idbOk = false;
    }
  }
  return memory.get(key);
}

async function set(key: string, value: unknown): Promise<void> {
  memory.set(key, value);
  if (idbOk) {
    try {
      await idbSet(key, value);
    } catch {
      idbOk = false;
    }
  }
}

async function del(key: string): Promise<void> {
  memory.delete(key);
  if (idbOk) {
    try {
      await idbDel(key);
    } catch {
      idbOk = false;
    }
  }
}

/** False when files only live in memory for this session. */
export function persistentStorage(): boolean {
  return idbOk;
}

export async function listFiles(): Promise<FileMeta[]> {
  const idx = ((await get(INDEX)) as FileMeta[] | undefined) ?? [];
  return idx.sort((a, b) => b.updatedAt - a.updatedAt);
}

// The index is read, changed and written back, so two writers (a save and a thumbnail)
// must not interleave or the later one drops the earlier one's change.
let indexQueue: Promise<unknown> = Promise.resolve();

function writeIndex(fn: (idx: FileMeta[]) => FileMeta[]): Promise<void> {
  const run = async () => {
    const idx = ((await get(INDEX)) as FileMeta[] | undefined) ?? [];
    await set(INDEX, fn(idx));
  };
  const next = indexQueue.then(run, run);
  indexQueue = next.catch(() => {});
  return next;
}

export function newFileId(): string {
  return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function saveFile(id: string, name: string, docJson: string, thumbnail?: string) {
  const used = new Set(referencedAssets(docJson));
  const assets = Object.fromEntries(Object.entries(allAssets()).filter(([k]) => used.has(k)));
  await set("dt:file:" + id, { doc: docJson, assets } satisfies StoredFile);
  await writeIndex((idx) => {
    const rest = idx.filter((f) => f.id !== id);
    const prev = idx.find((f) => f.id === id);
    return [...rest, { id, name, updatedAt: Date.now(), thumbnail: thumbnail ?? prev?.thumbnail }];
  });
}

/** Updates a file's dashboard thumbnail without touching its document, so a slow thumbnail
 * can never put an older document over a newer save. */
export async function saveThumbnail(id: string, thumbnail: string) {
  await writeIndex((idx) => idx.map((f) => (f.id === id ? { ...f, thumbnail } : f)));
}

export async function loadFile(id: string): Promise<string | null> {
  const f = (await get("dt:file:" + id)) as StoredFile | undefined;
  if (!f) return null;
  loadAssets(f.assets);
  return f.doc;
}

export async function deleteFile(id: string) {
  for (const v of await listVersions(id)) await del(`dt:version:${id}:${v.id}`);
  await del("dt:versions:" + id);
  await del("dt:file:" + id);
  clearRecovery(id);
  await writeIndex((idx) => idx.filter((f) => f.id !== id));
}

export async function renameFile(id: string, name: string) {
  const json = await loadFile(id);
  if (!json) return;
  const doc = JSON.parse(json);
  doc.name = name;
  await saveFile(id, name, JSON.stringify(doc));
}

export async function duplicateFile(id: string): Promise<string | null> {
  const json = await loadFile(id);
  if (!json) return null;
  const doc = JSON.parse(json);
  doc.name = `${doc.name} (copy)`;
  const nid = newFileId();
  await saveFile(nid, doc.name, JSON.stringify(doc));
  return nid;
}

// Version history: named or automatic snapshots of a file, newest first.

export interface Version {
  id: string;
  name: string;
  createdAt: number;
  auto: boolean;
}

const MAX_AUTO_VERSIONS = 30;

export async function listVersions(fileId: string): Promise<Version[]> {
  return ((await get("dt:versions:" + fileId)) as Version[] | undefined) ?? [];
}

export async function saveVersion(fileId: string, name: string, docJson: string, auto = false): Promise<Version> {
  const used = new Set(referencedAssets(docJson));
  const assets = Object.fromEntries(Object.entries(allAssets()).filter(([k]) => used.has(k)));
  const v: Version = { id: "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, createdAt: Date.now(), auto };
  await set(`dt:version:${fileId}:${v.id}`, { doc: docJson, assets } satisfies StoredFile);
  let list = [v, ...(await listVersions(fileId))];
  // Keep every named version; drop the oldest automatic ones.
  const autos = list.filter((x) => x.auto);
  for (const old of autos.slice(MAX_AUTO_VERSIONS)) {
    await del(`dt:version:${fileId}:${old.id}`);
    list = list.filter((x) => x.id !== old.id);
  }
  await set("dt:versions:" + fileId, list);
  return v;
}

export async function loadVersion(fileId: string, versionId: string): Promise<string | null> {
  const f = (await get(`dt:version:${fileId}:${versionId}`)) as StoredFile | undefined;
  if (!f) return null;
  loadAssets(f.assets);
  return f.doc;
}

export async function renameVersion(fileId: string, versionId: string, name: string) {
  const list = await listVersions(fileId);
  await set(
    "dt:versions:" + fileId,
    list.map((v) => (v.id === versionId ? { ...v, name, auto: false } : v)),
  );
}

export async function deleteVersion(fileId: string, versionId: string) {
  await del(`dt:version:${fileId}:${versionId}`);
  await set(
    "dt:versions:" + fileId,
    (await listVersions(fileId)).filter((v) => v.id !== versionId),
  );
}

export function toDtron(docJson: string): string {
  const used = new Set(referencedAssets(docJson));
  const assets = Object.fromEntries(Object.entries(allAssets()).filter(([k]) => used.has(k)));
  const file: DtronFile = { format: "designotron", version: 1, document: JSON.parse(docJson), assets };
  return JSON.stringify(file);
}

/** Accepts a `.dtron` wrapper or a bare document JSON; returns document JSON. */
export function fromDtron(text: string): string {
  const v = JSON.parse(text);
  if (v && v.format === "designotron") {
    loadAssets(v.assets);
    return JSON.stringify(v.document);
  }
  if (v && Array.isArray(v.pages) && v.nodes) return text;
  throw new Error("Not a Designotron file");
}

export function download(name: string, data: BlobPart, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** Saves a .dtron file's contents as a new file (never over an open one) and returns its id. */
export async function importDtron(text: string, fallbackName: string): Promise<string> {
  let json: string;
  try {
    json = fromDtron(text);
  } catch {
    throw new Error("That isn't a Designotron file, or it's damaged.");
  }
  if (!(await documentLoads(json))) throw new Error("That Designotron file is damaged and can't be opened.");
  const id = newFileId();
  await saveFile(id, JSON.parse(json).name || fallbackName, json);
  return id;
}

// Recovery copies: written synchronously while a page closes, when an IndexedDB save may not
// finish. Read on the next open, removed after the next successful save.
const recoveryKey = (id: string) => `dt:recover:${id}`;

/** False when the copy couldn't be kept (over the ~5 MB localStorage quota, or storage is
 * blocked): the IndexedDB save is then all there is, so the caller should warn. */
export function writeRecovery(id: string, docJson: string): boolean {
  try {
    localStorage.setItem(recoveryKey(id), docJson);
    return true;
  } catch {
    // A stale older copy would win over the IndexedDB save on the next open.
    clearRecovery(id);
    return false;
  }
}

export function readRecovery(id: string): string | null {
  try {
    return localStorage.getItem(recoveryKey(id));
  } catch {
    return null;
  }
}

export function clearRecovery(id: string) {
  try {
    localStorage.removeItem(recoveryKey(id));
  } catch {
    /* ignore */
  }
}
