// Copy links: the whole file, compressed into the link's #fragment. Browsers never send the
// fragment to a server, so these work without a relay or account, for as long as the link
// exists. Whoever opens one gets their own copy of the file.

import { allAssets, loadAssets, referencedAssets } from "./assets";
import { HOSTED_EDITOR, isLocalPage } from "./collab";
import { loadFile, newFileId, saveFile } from "./files";
import { documentLoads, getEngine } from "./store";

const PREFIX = "#/copy/";
/** View-only links and embeds: play the design, with a Remix button. */
const VIEW = "#/view/";
/** Longest link we hand out; chat apps and browsers cope with this. */
const MAX_LINK = 400_000;

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

/** Where links point: this editor, or the hosted one when this runs on localhost. */
export const linkBase = () => (isLocalPage() ? HOSTED_EDITOR : location.origin + location.pathname);

/** This file (and its images, unless they'd make links too long), compressed for a link. */
export async function encodeFile(): Promise<{ data: string; withoutImages: boolean }> {
  const doc = getEngine().save();
  const used = referencedAssets(doc);
  const assets = Object.fromEntries(Object.entries(allAssets()).filter(([k]) => used.includes(k)));
  const encode = async (withAssets: boolean) => {
    const json = JSON.stringify({ v: 1, doc: JSON.parse(doc), assets: withAssets ? assets : {} });
    return toBase64Url(await pipe(new TextEncoder().encode(json), new CompressionStream("gzip")));
  };
  let data = await encode(true);
  let withoutImages = false;
  if (data.length > MAX_LINK && used.length) {
    data = await encode(false);
    withoutImages = true;
  }
  if (data.length > MAX_LINK) throw new Error("This file is too big for a link. Use Save as .dtron and send the file instead.");
  return { data, withoutImages };
}

/** A link containing this file; whoever opens it gets their own copy. */
export async function copyLink(): Promise<{ url: string; withoutImages: boolean }> {
  const { data, withoutImages } = await encodeFile();
  return { url: linkBase() + PREFIX + data, withoutImages };
}

/** Copy (remix) and view-only links for the same encoded file. */
export const copyUrl = (data: string) => linkBase() + PREFIX + data;
export const viewUrl = (data: string) => linkBase() + VIEW + data;

export const isCopyLink = (hash = location.hash) => hash.startsWith(PREFIX);
export const isViewLink = (hash = location.hash) => hash.startsWith(VIEW);

const DAMAGED = "This link is incomplete or damaged. Ask for a new one.";

/** The file inside a link's data, without saving anything. Images that don't decode are dropped. */
export async function decodeFile(data: string): Promise<{ doc: any; assets: Record<string, string> }> {
  let doc: any;
  let assets: Record<string, string> = {};
  try {
    const text = new TextDecoder().decode(await pipe(fromBase64Url(data), new DecompressionStream("gzip")));
    const parsed = JSON.parse(text);
    doc = parsed?.doc;
    if (parsed?.assets && typeof parsed.assets === "object") assets = parsed.assets;
  } catch {
    throw new Error(DAMAGED);
  }
  if (!doc?.pages || !(await documentLoads(JSON.stringify(doc)))) throw new Error(DAMAGED);
  const images = Object.fromEntries(Object.entries(assets).filter(([, url]) => typeof url === "string" && /^data:image\/[\w+.-]+;base64,[A-Za-z0-9+/=]+$/.test(url)));
  return { doc, assets: images };
}

/** Saves the file in a copy link as a new local file (once per link) and returns its id. */
export async function openCopyLink(hash = location.hash): Promise<string> {
  const data = hash.slice(PREFIX.length);
  // The same link opened again reopens the same copy.
  const key = `dt:copy:${data.length}:${data.slice(-24)}`;
  try {
    const known = localStorage.getItem(key);
    // Reuse the earlier copy only if it still exists (it may have been deleted).
    if (known && (await loadFile(known))) return known;
  } catch {
    /* ignore */
  }
  const { doc, assets } = await decodeFile(data);
  loadAssets(assets);
  const id = newFileId();
  await saveFile(id, doc.name || "Shared design", JSON.stringify(doc));
  try {
    localStorage.setItem(key, id);
  } catch {
    /* ignore */
  }
  return id;
}
