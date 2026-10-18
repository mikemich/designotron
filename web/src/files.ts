// Local file storage (IndexedDB) and the portable `.dtron` file format.

import { get, set, del } from "idb-keyval";
import { allAssets, loadAssets, referencedAssets } from "./assets";

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

export async function listFiles(): Promise<FileMeta[]> {
  const idx = ((await get(INDEX)) as FileMeta[] | undefined) ?? [];
  return idx.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function writeIndex(fn: (idx: FileMeta[]) => FileMeta[]) {
  const idx = ((await get(INDEX)) as FileMeta[] | undefined) ?? [];
  await set(INDEX, fn(idx));
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

export async function loadFile(id: string): Promise<string | null> {
  const f = (await get("dt:file:" + id)) as StoredFile | undefined;
  if (!f) return null;
  loadAssets(f.assets);
  return f.doc;
}

export async function deleteFile(id: string) {
  await del("dt:file:" + id);
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
