// Per-file Claude conversations: what is kept for each file (the transcript as text and tool
// names, the Claude Code session id, an unsent draft) and the pure helpers that shape it.
// Records live in IndexedDB next to the files (`dt:chat:<fileId>`); they are user text in the
// same origin as the files, never sent anywhere.

import { get, set, del } from "idb-keyval";

/** A chat item as stored: no screenshots, and images are only counted. */
export type StoredItem =
  | { id: number; kind: "user" | "assistant" | "error" | "system"; text: string; imageCount?: number; title?: string }
  | { id: number; kind: "tool"; name: string; ok: boolean; detail?: string };

export interface ChatRecord {
  v: 1;
  items: StoredItem[];
  sessionId: string | null;
  /** Text returned to the composer (a queued message when Stop or leaving ended its turn). */
  draft: string;
  savedAt: number;
}

/** The slice of a chat item these helpers read (the full type lives in chatState). */
export type AnyItem =
  | { id: number; kind: "user" | "assistant" | "error" | "system"; text: string; images?: string[]; title?: string; retry?: string; retryLabel?: string }
  | { id: number; kind: "tool"; name: string; ok: boolean | null; detail?: string }
  | { id: number; kind: "shot"; url: string; label: string };

export const MAX_ITEMS = 200;
export const MAX_BYTES = 256 * 1024;

export const chatKey = (fileId: string) => `dt:chat:${fileId}`;

/** What to keep of a conversation: the last `MAX_ITEMS` items, no screenshots, images as a count,
 *  unfinished tool calls marked interrupted, and under `MAX_BYTES` (oldest dropped first). */
export function serialize(items: readonly AnyItem[], sessionId: string | null, draft = "", now = Date.now()): ChatRecord {
  const kept: StoredItem[] = [];
  for (const it of items) {
    if (it.kind === "shot") continue;
    if (it.kind === "tool") {
      kept.push({ id: it.id, kind: "tool", name: it.name, ok: it.ok === true, ...(it.ok === null ? { detail: "Interrupted" } : it.detail ? { detail: it.detail } : {}) });
      continue;
    }
    // (A Retry button is for the session it appeared in, not for a later visit.)
    const { images, retry: _retry, retryLabel: _label, ...rest } = it;
    kept.push({ ...rest, ...(images?.length ? { imageCount: images.length } : {}) });
  }
  let out = kept.slice(-MAX_ITEMS);
  let record: ChatRecord = { v: 1, items: out, sessionId, draft, savedAt: now };
  let size = JSON.stringify(record).length;
  // Drop the oldest items until it fits (a single huge item is cut instead).
  while (size > MAX_BYTES && out.length > 1) {
    out = out.slice(Math.max(1, Math.ceil(out.length / 10)));
    record = { ...record, items: out };
    size = JSON.stringify(record).length;
  }
  if (size > MAX_BYTES && out.length === 1 && "text" in out[0]) {
    out = [{ ...out[0], text: out[0].text.slice(0, 20_000) }];
    record = { ...record, items: out };
  }
  return record;
}

/** Items for the chat list from a stored record, numbered from 1, and the next free id. */
export function restore(record: unknown): { items: AnyItem[]; sessionId: string | null; draft: string; nextId: number } | null {
  const r = record as Partial<ChatRecord> | null | undefined;
  if (!r || r.v !== 1 || !Array.isArray(r.items)) return null;
  const items: AnyItem[] = [];
  for (const raw of r.items as StoredItem[]) {
    if (!raw || typeof raw !== "object") continue;
    const id = items.length + 1;
    if (raw.kind === "tool") {
      if (typeof raw.name !== "string") continue;
      items.push({ id, kind: "tool", name: raw.name, ok: !!raw.ok, ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}) });
    } else if (raw.kind === "user" || raw.kind === "assistant" || raw.kind === "error" || raw.kind === "system") {
      if (typeof raw.text !== "string") continue;
      const n = raw.imageCount ?? 0;
      const text = raw.kind === "user" && n > 0 ? `${raw.text}\n(${n} image${n === 1 ? "" : "s"} attached, not kept)` : raw.text;
      items.push({
        id,
        kind: raw.kind,
        text,
        ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      });
    }
  }
  return { items, sessionId: typeof r.sessionId === "string" ? r.sessionId : null, draft: typeof r.draft === "string" ? r.draft : "", nextId: items.length + 1 };
}

/** True when a conversation has nothing worth keeping. */
export const isEmpty = (rec: ChatRecord) => !rec.items.length && !rec.sessionId && !rec.draft;

export async function loadConversation(fileId: string): Promise<ReturnType<typeof restore>> {
  try {
    return restore(await get(chatKey(fileId)));
  } catch {
    return null;
  }
}

/** Stores a conversation (an empty one removes the record). Storage failures are ignored: the
 *  conversation is a convenience, never worth an error. */
export async function saveConversation(fileId: string, rec: ChatRecord): Promise<void> {
  try {
    if (isEmpty(rec)) await del(chatKey(fileId));
    else await set(chatKey(fileId), rec);
  } catch {
    /* storage unavailable or full */
  }
}

export async function dropConversation(fileId: string): Promise<void> {
  try {
    await del(chatKey(fileId));
  } catch {
    /* ignore */
  }
}
