// Local file storage (IndexedDB) and the portable `.dtron` file format.

import {
  createStore,
  get as idbGet,
  set as idbSet,
  del as idbDel,
  getMany as idbGetMany,
} from "idb-keyval";
import { allAssets, assetDataUrl, loadAssets, referencedAssets } from "./assets";
import { documentLoads, toast } from "./store";

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
  /** The tab (page load) that wrote this manifest: a tab only builds on what it wrote itself. */
  writer: string;
  /** Document-level fields as a JSON object (everything but `nodes`). */
  meta: string;
  /** Stored layers, with the image assets each one uses. */
  roots: Record<string, string[]>;
  /** Names of the stored layers, to say which ones can't be read back. */
  names?: Record<string, string>;
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
  /** Layer id -> name, for the layers in `dirty`. */
  names: Record<string, string>;
  removed: string[];
}

/** The stored file isn't the one this tab last wrote (another tab or writer saved since), so a
 * save that only adds changes would build on the wrong thing: write the whole file instead. */
export class StaleStorageError extends Error {
  constructor() {
    super("The stored file was changed by another writer");
  }
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
// Set once IndexedDB has opened or served a read or write. After that a failing read or write
// is a real failure (a transient error, quota, a full disk) that callers must see, not a sign
// that IndexedDB is missing.
let idbWorked = false;
// Set once a write has landed. Some browsers (older Safari in private mode) open IndexedDB and
// fail every write; until one has worked a failing write means falling back to memory.
let idbWrote = false;

/** Opens the database once (as idb-keyval will) so that only a failed *open* means IndexedDB is
 * missing; a read that fails on a cold load then reaches the caller instead of reading as
 * "no such file". */
let opened: Promise<void> | null = null;
function ensureOpen(): Promise<void> {
  opened ??= new Promise<void>((resolve) => {
    try {
      const req = indexedDB.open("keyval-store");
      req.onupgradeneeded = () => req.result.createObjectStore("keyval");
      req.onsuccess = () => {
        req.result.close();
        // Reads work (even if every write fails); see idbWrote.
        idbWorked = true;
        resolve();
      };
      req.onerror = () => {
        idbOk = false;
        resolve();
      };
    } catch {
      idbOk = false;
      resolve();
    }
  });
  return opened;
}

async function get(key: string): Promise<unknown> {
  await ensureOpen();
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
  await ensureOpen();
  memory.set(key, value);
  if (idbOk) {
    try {
      await idbSet(key, value);
      idbWrote = true;
    } catch (err) {
      if (idbWrote) throw err;
      idbOk = false;
    }
  }
}

async function del(key: string): Promise<void> {
  await ensureOpen();
  memory.delete(key);
  if (idbOk) {
    try {
      await idbDel(key);
      idbWrote = true;
    } catch (err) {
      if (idbWrote) throw err;
      idbOk = false;
    }
  }
}

// The batch forms read or write several records in one transaction: all land or none does.
// They keep the data out of `memory` while IndexedDB works (a copy there would double a big
// file's RAM).

async function getMany(keys: string[]): Promise<unknown[]> {
  await ensureOpen();
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

/** What a read-modify-write of the stored records decided: records to write and to delete. */
interface Writes {
  put: [string, unknown][];
  del: string[];
}

const keyval = createStore("keyval-store", "keyval");

/**
 * Reads `readKeys`, lets `decide` (synchronously) choose what to write and delete from what
 * it found, and applies that, all in one transaction: no other writer can land in between,
 * and either everything is applied or nothing is. `decide` may throw to abort.
 */
async function transact(readKeys: string[], decide: (found: unknown[]) => Writes): Promise<void> {
  await ensureOpen();
  if (idbOk) {
    try {
      await keyval(
        "readwrite",
        (os) =>
          new Promise<void>((resolve, reject) => {
            const tx = os.transaction;
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
            const found: unknown[] = new Array(readKeys.length);
            let left = readKeys.length;
            readKeys.forEach((k, i) => {
              const req = os.get(k);
              req.onsuccess = () => {
                found[i] = req.result;
                if (--left > 0) return;
                try {
                  const w = decide(found);
                  for (const [key, value] of w.put) os.put(value, key);
                  for (const key of w.del) os.delete(key);
                } catch (err) {
                  reject(err);
                  tx.abort();
                }
              };
            });
          }),
      );
      idbWrote = true;
      return;
    } catch (err) {
      // A decision to give up (or a broken store that has worked before) is the caller's.
      if (err instanceof StaleStorageError || idbWrote) throw err;
      idbOk = false;
    }
  }
  const w = decide(readKeys.map((k) => memory.get(k)));
  for (const [k, v] of w.put) memory.set(k, v);
  for (const k of w.del) memory.delete(k);
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

/** What is known to be stored in the layered form for files opened or saved in this session:
 * the manifest this tab last read or wrote (writer and seq identify it) and what it lists. */
interface Known {
  seq: number;
  writer: string;
  roots: Record<string, string[]>;
  names: Record<string, string>;
  assets: Set<string>;
  /** Size of each layer's records, in characters, and of the document-level record. */
  sizes: Record<string, number>;
  metaSize: number;
}
const layered = new Map<string, Known>();

/** This page load, for telling manifests apart. */
const WRITER = Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Whether the next `saveDelta` for this file can build on what is stored (else it must be `full`). */
export function canSaveDelta(id: string): boolean {
  return layered.has(id);
}

/** About how many characters the whole document is as JSON, from what was stored; null when
 * the file hasn't been stored in the layered form yet. */
export function storedSize(id: string): number | null {
  const k = layered.get(id);
  return k ? k.metaSize + Object.values(k.sizes).reduce((a, b) => a + b, 0) : null;
}

const isManifest = (v: unknown): v is Manifest => (v as Manifest | undefined)?.v === 2;

/** Writes a file as one record (used by import, duplicate and the like; autosave uses `saveDelta`). */
export async function saveFile(id: string, name: string, docJson: string, thumbnail?: string) {
  const used = new Set(referencedAssets(docJson));
  const assets = Object.fromEntries(Object.entries(allAssets()).filter(([k]) => used.has(k)));
  layered.delete(id);
  // Whatever layered records the file has now go in the same transaction as the new record.
  await transact([fileKey(id)], ([stored]) => ({
    put: [[fileKey(id), { doc: docJson, assets } satisfies StoredFile]],
    del: isManifest(stored) ? layeredKeys(id, stored.roots, stored.assets) : [],
  }));
  await writeIndex((idx) => {
    const rest = idx.filter((f) => f.id !== id);
    const prev = idx.find((f) => f.id === id);
    return [...rest, { id, name, updatedAt: Date.now(), thumbnail: thumbnail ?? prev?.thumbnail }];
  });
}

/**
 * Stores a save from `persistPlan`: the layers that changed plus the document-level fields.
 * One transaction reads the stored manifest, works out which layers the file has from it, writes
 * the changed layers and the new manifest and deletes the records the old manifest listed and
 * the new one doesn't. Cost follows what changed, not the size of the file.
 *
 * It only builds on the manifest this tab last wrote (a `StaleStorageError` otherwise, after
 * which the caller makes a `full` plan: the last writer's document wins whole, never a mix).
 * Throws when the write didn't land (nothing is changed then).
 */
export async function saveDelta(id: string, name: string, plan: SavePlan) {
  const state = layered.get(id);
  if (!plan.full && !state) throw new StaleStorageError();
  // This tab's view of the stored file once the write lands, for a write started before it
  // does: it is only right if this one lands, and a failure forgets it.
  const sizes: Record<string, number> = plan.full ? {} : { ...state!.sizes };
  const roots: Record<string, string[]> = plan.full ? {} : { ...state!.roots };
  const names: Record<string, string> = plan.full ? {} : { ...state!.names };
  for (const r of plan.removed) {
    delete roots[r];
    delete names[r];
    delete sizes[r];
  }
  const rootAssets: Record<string, string[]> = {};
  for (const [r, body] of Object.entries(plan.dirty)) {
    rootAssets[r] = referencedAssets(body);
    roots[r] = rootAssets[r];
    names[r] = plan.names[r] ?? names[r] ?? "";
    sizes[r] = body.length;
  }
  const expected = state ? { seq: state.seq, writer: state.writer } : null;
  const seq = (state?.seq ?? 0) + 1;
  const known: Known = { seq, writer: WRITER, roots, names, assets: new Set(), sizes, metaSize: plan.meta.length };
  // Optimistic: a write begun before this one lands builds on this.
  layered.set(id, known);
  try {
    await transact([fileKey(id)], ([stored]) => {
      const m = isManifest(stored) ? stored : null;
      if (!plan.full && (!m || !expected || m.seq !== expected.seq || m.writer !== expected.writer)) throw new StaleStorageError();
      // What is stored, less what goes, plus what changed.
      const nextRoots: Record<string, string[]> = plan.full ? {} : { ...m!.roots };
      const nextNames: Record<string, string> = plan.full ? {} : { ...(m!.names ?? {}) };
      for (const r of plan.removed) {
        delete nextRoots[r];
        delete nextNames[r];
      }
      const put: [string, unknown][] = [];
      for (const [r, body] of Object.entries(plan.dirty)) {
        nextRoots[r] = rootAssets[r];
        nextNames[r] = names[r];
        put.push([rootKey(id, r), body]);
      }
      const had = new Set(m?.assets ?? []);
      const nextAssets = new Set<string>();
      for (const a of new Set(Object.values(nextRoots).flat())) {
        if (had.has(a)) nextAssets.add(a);
        else {
          const url = assetDataUrl(a);
          if (url) {
            put.push([assetKey(id, a), url]);
            nextAssets.add(a);
          }
        }
      }
      put.push([fileKey(id), { v: 2, seq: (m?.seq ?? 0) + 1, writer: WRITER, meta: plan.meta, roots: nextRoots, names: nextNames, assets: [...nextAssets] } satisfies Manifest]);
      // Records the stored manifest listed and the new one doesn't, deleted with the write.
      const goneRoots = Object.fromEntries(Object.entries(m?.roots ?? {}).filter(([r]) => !(r in nextRoots)));
      known.assets = nextAssets;
      known.seq = (m?.seq ?? 0) + 1;
      return { put, del: layeredKeys(id, goneRoots, (m?.assets ?? []).filter((a) => !nextAssets.has(a))) };
    });
  } catch (err) {
    // Unknown what is stored now (or known to be somebody else's): the next save starts over.
    layered.delete(id);
    throw err;
  }
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

/**
 * Assembles a document from its layer records, which must all belong to one save. A record that
 * is missing doesn't make the file unopenable: the layers that are there open, the ones that
 * aren't are named in a toast, and the next save rewrites the whole file (which repairs it).
 */
async function loadLayered(id: string, first: Manifest): Promise<string> {
  let m = first;
  for (let attempt = 0; attempt < 4; attempt++) {
    const rootIds = Object.keys(m.roots);
    const keys = [...rootIds.map((r) => rootKey(id, r)), ...m.assets.map((a) => assetKey(id, a)), fileKey(id)];
    const values = await getMany(keys);
    const again = values[values.length - 1] as Manifest | undefined;
    // Another tab saved between reading the manifest and the layers: start over from its manifest.
    if (!isManifest(again)) throw new Error("This file's storage changed while it was opening.");
    if (again.seq !== m.seq || again.writer !== m.writer) {
      m = again;
      continue;
    }
    const found = values.slice(0, rootIds.length) as (string | undefined)[];
    const urls = values.slice(rootIds.length, rootIds.length + m.assets.length) as (string | undefined)[];
    loadAssets(Object.fromEntries(m.assets.flatMap((a, i) => (urls[i] ? [[a, urls[i]!]] : []))));
    const sizes: Record<string, number> = {};
    const bodies: string[] = [];
    const lost: string[] = [];
    found.forEach((b, i) => {
      if (typeof b === "string") {
        bodies.push(b);
        sizes[rootIds[i]] = b.length;
      } else lost.push(rootIds[i]);
    });
    let meta = m.meta;
    if (lost.length) {
      // Pages mustn't list layers that aren't there.
      const doc = JSON.parse(meta);
      for (const page of doc.pages ?? []) page.children = (page.children ?? []).filter((c: string) => !lost.includes(c));
      meta = JSON.stringify(doc);
      toast(`Couldn't read ${lost.map((r) => `“${m.names?.[r] ?? r}”`).join(", ")} from this file; ${lost.length === 1 ? "it is" : "they are"} missing. The rest opened.`, "error");
      // Not what the stored manifest says: the next save writes everything.
      layered.delete(id);
    } else {
      layered.set(id, {
        seq: m.seq,
        writer: m.writer,
        roots: m.roots,
        names: m.names ?? {},
        assets: new Set(m.assets),
        sizes,
        metaSize: m.meta.length,
      });
    }
    return `${meta.slice(0, -1)},"nodes":{${bodies.join(",")}}}`;
  }
  throw new Error("This file is being saved elsewhere; try again.");
}

export async function deleteFile(id: string) {
  // The index first: if that write fails nothing was deleted, instead of a listed file whose
  // data is gone.
  await writeIndex((idx) => idx.filter((f) => f.id !== id));
  for (const v of await listVersions(id)) await del(`dt:version:${id}:${v.id}`);
  await del("dt:versions:" + id);
  layered.delete(id);
  await transact([fileKey(id)], ([stored]) => ({
    put: [],
    del: [fileKey(id), ...(isManifest(stored) ? layeredKeys(id, stored.roots, stored.assets) : [])],
  }));
  clearRecovery(id);
}

export async function renameFile(id: string, name: string) {
  const rec = (await get(fileKey(id))) as StoredFile | Manifest | undefined;
  if (isManifest(rec)) {
    // Only the document-level record carries the name.
    await transact([fileKey(id)], ([stored]) => {
      if (!isManifest(stored)) throw new Error("This file changed while it was being renamed.");
      return { put: [[fileKey(id), { ...stored, meta: JSON.stringify({ ...JSON.parse(stored.meta), name }) } satisfies Manifest]], del: [] };
    });
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
