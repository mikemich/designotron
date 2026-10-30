// Local file storage (IndexedDB) and the portable `.dtron` file format.

import { get as idbGet, set as idbSet, del as idbDel, getMany as idbGetMany, setMany as idbSetMany, delMany as idbDelMany } from "idb-keyval";
import { allAssets, assetDataUrl, loadAssets, referencedAssets } from "./assets";
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

/** A file stored as one record per top-level layer (see `saveDelta`), so saving a change in a
 * big file writes only the layers that changed. `dt:file:<id>` holds this instead of a
 * `StoredFile` (older files and the other writers keep the single-record form). */
interface Manifest {
  v: 2;
  /** Counts saves, so a reader can tell the records it read belong together. */
  seq: number;
  /** Document-level fields as a JSON object (everything but `nodes`). */
  meta: string;
  /** Stored layers, with the image assets each one uses. */
  roots: Record<string, string[]>;
  /** Image assets stored for this file, one record each. */
  assets: string[];
}

/** What the engine says to write for one save (`persistPlan`) with each layer's records. */
export interface SavePlan {
  token: number;
  /** Replaces every stored layer (nothing stored to build on, or a forced rewrite). */
  full: boolean;
  meta: string;
  /** Layer id -> its nodes as the body of a JSON object. */
  dirty: Record<string, string>;
  removed: string[];
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
// Set once IndexedDB has served a read or write. After that a failing write is a real
// failure (quota, a full disk) that callers must see, not a sign that IndexedDB is missing.
let idbWorked = false;

async function get(key: string): Promise<unknown> {
  if (idbOk) {
    try {
      const v = await idbGet(key);
      idbWorked = true;
      return v;
    } catch (err) {
      // Reading nothing back would let a caller write back an empty index over the real one.
      if (idbWorked) throw err;
      idbOk = false;
    }
  }
  return memory.get(key);
}

/** Rejects when a write to a working IndexedDB fails: the data is not stored. */
async function set(key: string, value: unknown): Promise<void> {
  memory.set(key, value);
  if (idbOk) {
    try {
      await idbSet(key, value);
      idbWorked = true;
    } catch (err) {
      if (idbWorked) throw err;
      idbOk = false;
    }
  }
}

async function del(key: string): Promise<void> {
  memory.delete(key);
  if (idbOk) {
    try {
      await idbDel(key);
    } catch (err) {
      if (idbWorked) throw err;
      idbOk = false;
    }
  }
}

// The batch forms write several records in one transaction: all land or none does. They keep
// the data out of `memory` while IndexedDB works (a copy there would double a big file's RAM).

async function getMany(keys: string[]): Promise<unknown[]> {
  if (idbOk) {
    try {
      const v = await idbGetMany(keys);
      idbWorked = true;
      return v;
    } catch (err) {
      if (idbWorked) throw err;
      idbOk = false;
    }
  }
  return keys.map((k) => memory.get(k));
}

async function setMany(entries: [string, unknown][]): Promise<void> {
  if (idbOk) {
    try {
      await idbSetMany(entries);
      idbWorked = true;
      return;
    } catch (err) {
      if (idbWorked) throw err;
      idbOk = false;
    }
  }
  for (const [k, v] of entries) memory.set(k, v);
}

async function delMany(keys: string[]): Promise<void> {
  for (const k of keys) memory.delete(k);
  if (idbOk) {
    try {
      await idbDelMany(keys);
    } catch (err) {
      if (idbWorked) throw err;
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

const fileKey = (id: string) => "dt:file:" + id;
const rootKey = (id: string, root: string) => `dt:root:${id}:${root}`;
const assetKey = (id: string, asset: string) => `dt:asset:${id}:${asset}`;

/** What is known to be stored in the layered form for files opened or saved in this session. */
const layered = new Map<string, { seq: number; roots: Record<string, string[]>; assets: Set<string> }>();

/** Whether the next `saveDelta` for this file can build on what is stored (else it must be `full`). */
export function canSaveDelta(id: string): boolean {
  return layered.has(id);
}

const isManifest = (v: unknown): v is Manifest => (v as Manifest | undefined)?.v === 2;

/** Writes a file as one record (used by import, duplicate and the like; autosave uses `saveDelta`). */
export async function saveFile(id: string, name: string, docJson: string, thumbnail?: string) {
  const used = new Set(referencedAssets(docJson));
  const assets = Object.fromEntries(Object.entries(allAssets()).filter(([k]) => used.has(k)));
  await set(fileKey(id), { doc: docJson, assets } satisfies StoredFile);
  // The layered records it replaces are garbage now.
  const old = layered.get(id);
  layered.delete(id);
  if (old) await delMany(layeredKeys(id, old.roots, old.assets)).catch(() => {});
  await writeIndex((idx) => {
    const rest = idx.filter((f) => f.id !== id);
    const prev = idx.find((f) => f.id === id);
    return [...rest, { id, name, updatedAt: Date.now(), thumbnail: thumbnail ?? prev?.thumbnail }];
  });
}

/**
 * Stores a save from `persistPlan`: the layers that changed plus the document-level fields,
 * in one transaction. Cost follows what changed, not the size of the file. Throws when the
 * write didn't land (nothing is changed then); the plan can be retried or superseded.
 */
export async function saveDelta(id: string, name: string, plan: SavePlan) {
  const state = layered.get(id);
  if (!plan.full && !state) throw new Error("nothing stored to build on");
  const roots: Record<string, string[]> = plan.full ? {} : { ...state!.roots };
  for (const r of plan.removed) delete roots[r];
  const entries: [string, unknown][] = [];
  for (const [r, body] of Object.entries(plan.dirty)) {
    roots[r] = referencedAssets(body);
    entries.push([rootKey(id, r), body]);
  }
  const used = new Set(Object.values(roots).flat());
  const had = state?.assets ?? new Set<string>();
  const stored = new Set<string>();
  for (const a of used) {
    if (had.has(a)) stored.add(a);
    else {
      const url = assetDataUrl(a);
      if (url) {
        entries.push([assetKey(id, a), url]);
        stored.add(a);
      }
    }
  }
  const seq = (state?.seq ?? 0) + 1;
  entries.push([fileKey(id), { v: 2, seq, meta: plan.meta, roots, assets: [...stored] } satisfies Manifest]);
  await setMany(entries);
  // Records of layers and images the file no longer has (best effort: leftovers are harmless).
  const gone = layeredKeys(
    id,
    Object.fromEntries(Object.entries(state?.roots ?? {}).filter(([r]) => !(r in roots))),
    new Set([...had].filter((a) => !stored.has(a))),
  );
  layered.set(id, { seq, roots, assets: stored });
  if (gone.length) await delMany(gone).catch(() => {});
  await writeIndex((idx) => {
    const rest = idx.filter((f) => f.id !== id);
    const prev = idx.find((f) => f.id === id);
    return [...rest, { id, name, updatedAt: Date.now(), thumbnail: prev?.thumbnail }];
  });
}

function layeredKeys(id: string, roots: Record<string, string[]>, assets: Iterable<string>): string[] {
  return [...Object.keys(roots).map((r) => rootKey(id, r)), ...[...assets].map((a) => assetKey(id, a))];
}

/** Updates a file's dashboard thumbnail without touching its document, so a slow thumbnail
 * can never put an older document over a newer save. */
export async function saveThumbnail(id: string, thumbnail: string) {
  await writeIndex((idx) => idx.map((f) => (f.id === id ? { ...f, thumbnail } : f)));
}

export async function loadFile(id: string): Promise<string | null> {
  const f = (await get(fileKey(id))) as StoredFile | Manifest | undefined;
  if (!f) return null;
  if (isManifest(f)) return loadLayered(id, f);
  layered.delete(id);
  loadAssets(f.assets);
  return f.doc;
}

/** Assembles a document from its layer records, which must all belong to one save. */
async function loadLayered(id: string, first: Manifest): Promise<string> {
  let m = first;
  for (let attempt = 0; attempt < 4; attempt++) {
    const rootIds = Object.keys(m.roots);
    const keys = [...rootIds.map((r) => rootKey(id, r)), ...m.assets.map((a) => assetKey(id, a)), fileKey(id)];
    const values = await getMany(keys);
    const again = values[values.length - 1] as Manifest | undefined;
    // Another tab saved between reading the manifest and the layers: start over from its manifest.
    if (!isManifest(again)) throw new Error("This file's storage changed while it was opening.");
    if (again.seq !== m.seq) {
      m = again;
      continue;
    }
    const bodies = values.slice(0, rootIds.length) as (string | undefined)[];
    const missing = bodies.findIndex((b) => typeof b !== "string");
    if (missing >= 0) throw new Error("This file is damaged: a stored layer is missing.");
    const urls = values.slice(rootIds.length, rootIds.length + m.assets.length) as (string | undefined)[];
    loadAssets(Object.fromEntries(m.assets.flatMap((a, i) => (urls[i] ? [[a, urls[i]!]] : []))));
    layered.set(id, { seq: m.seq, roots: m.roots, assets: new Set(m.assets) });
    return `${m.meta.slice(0, -1)},"nodes":{${bodies.join(",")}}}`;
  }
  throw new Error("This file is being saved elsewhere; try again.");
}

export async function deleteFile(id: string) {
  for (const v of await listVersions(id)) await del(`dt:version:${id}:${v.id}`);
  await del("dt:versions:" + id);
  const rec = (await get(fileKey(id))) as StoredFile | Manifest | undefined;
  if (isManifest(rec)) await delMany(layeredKeys(id, rec.roots, rec.assets));
  layered.delete(id);
  await del("dt:file:" + id);
  clearRecovery(id);
  await writeIndex((idx) => idx.filter((f) => f.id !== id));
}

export async function renameFile(id: string, name: string) {
  const rec = (await get(fileKey(id))) as StoredFile | Manifest | undefined;
  if (isManifest(rec)) {
    // Only the document-level record carries the name.
    await set(fileKey(id), { ...rec, meta: JSON.stringify({ ...JSON.parse(rec.meta), name }) } satisfies Manifest);
    await writeIndex((idx) => idx.map((f) => (f.id === id ? { ...f, name, updatedAt: Date.now() } : f)));
    return;
  }
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
