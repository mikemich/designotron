// Copy links: the whole file, compressed into the link's #fragment. Browsers never send the
// fragment to a server, so these work without a relay or account, for as long as the link
// exists. Whoever opens one gets their own copy of the file.

import { allAssets, loadAssets, referencedAssets } from "./assets";
import { HOSTED_EDITOR, isLocalPage } from "./collab";
import { newFileId, saveFile } from "./files";
import { getEngine } from "./store";

const PREFIX = "#/copy/";
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

/** A link containing this file. Images are left out if they'd make the link too long. */
export async function copyLink(): Promise<{ url: string; withoutImages: boolean }> {
  const doc = getEngine().save();
  const used = referencedAssets(doc);
  const assets = Object.fromEntries(Object.entries(allAssets()).filter(([k]) => used.includes(k)));
  const base = isLocalPage() ? HOSTED_EDITOR : location.origin + location.pathname;
  const encode = async (withAssets: boolean) => {
    const json = JSON.stringify({ v: 1, doc: JSON.parse(doc), assets: withAssets ? assets : {} });
    return base + PREFIX + toBase64Url(await pipe(new TextEncoder().encode(json), new CompressionStream("gzip")));
  };
  let url = await encode(true);
  let withoutImages = false;
  if (url.length > MAX_LINK && used.length) {
    url = await encode(false);
    withoutImages = true;
  }
  if (url.length > MAX_LINK) throw new Error("This file is too big for a link. Use Save as .dtron and send the file instead.");
  return { url, withoutImages };
}

export const isCopyLink = (hash = location.hash) => hash.startsWith(PREFIX);

/** Saves the file in a copy link as a new local file (once per link) and returns its id. */
export async function openCopyLink(hash = location.hash): Promise<string> {
  const data = hash.slice(PREFIX.length);
  // The same link opened again reopens the same copy.
  const key = `dt:copy:${data.length}:${data.slice(-24)}`;
  try {
    const known = localStorage.getItem(key);
    if (known) return known;
  } catch {
    /* ignore */
  }
  const text = new TextDecoder().decode(await pipe(fromBase64Url(data), new DecompressionStream("gzip")));
  const { doc, assets } = JSON.parse(text);
  if (!doc?.pages) throw new Error("This copy link is damaged.");
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
