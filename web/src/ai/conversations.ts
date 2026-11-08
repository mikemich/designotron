// Per-file Claude conversations: what is kept for each file (the transcript as text and tool
// names, the Claude Code session id, an unsent draft) and the pure helpers that shape it.
// Records live in IndexedDB next to the files (`dt:chat:<fileId>`); they are user text in the
// same origin as the files, never sent anywhere.

import { get, set, del, update } from "idb-keyval";

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

/** Deleting a file clears the current conversation and every past one. */
export async function dropConversation(fileId: string): Promise<void> {
  for (const key of [chatKey(fileId), chatsKey(fileId)]) {
    try {
      await del(key);
    } catch {
      /* ignore */
    }
  }
}

// ---- Past conversations ("New conversation" archives the current one) ----

/** A conversation set aside by New conversation, newest first in the list. */
export interface PastConversation {
  id: string;
  title: string;
  savedAt: number;
  record: ChatRecord;
}

export const MAX_PAST = 20;
export const MAX_PAST_BYTES = 1024 * 1024;
export const TITLE_CHARS = 60;

export const chatsKey = (fileId: string) => `dt:chats:${fileId}`;

/** `text` cut to at most `max` characters at a word boundary, with "…" when something was cut. */
export function cutAtWord(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  // Back up to the last space when that keeps at least a few letters; one long word is cut hard.
  const at = head.lastIndexOf(" ");
  const cut = at >= Math.min(8, max / 2) ? head.slice(0, at) : head;
  return cut.replace(/[\s.,;:!?-]+$/, "") + "…";
}

/** What a past conversation is called: its first message from the person. */
export function conversationTitle(rec: Pick<ChatRecord, "items">): string {
  const first = rec.items.find((i) => i.kind === "user");
  const text = first && "text" in first ? first.text.replace(/\s+/g, " ").trim() : "";
  return text ? cutAtWord(text, TITLE_CHARS) : "Conversation";
}

/** Whether a conversation is worth keeping in the history: it has at least one message. */
export const worthArchiving = (rec: ChatRecord) => rec.items.length > 0;

/** `list` (newest first) with `rec` added at the front, capped to `MAX_PAST` entries and `MAX_PAST_BYTES`
 *  (the oldest go first; the newest always stays). */
export function addPast(list: readonly PastConversation[], rec: ChatRecord, id: string, now = Date.now()): PastConversation[] {
  const next = [{ id, title: conversationTitle(rec), savedAt: now, record: rec }, ...list].slice(0, MAX_PAST);
  while (next.length > 1 && JSON.stringify(next).length > MAX_PAST_BYTES) next.pop();
  return next;
}

/** Entries read from storage, dropping anything malformed. */
export function readPast(raw: unknown): PastConversation[] {
  const r = raw as { v?: number; list?: unknown } | null | undefined;
  if (!r || r.v !== 1 || !Array.isArray(r.list)) return [];
  return (r.list as PastConversation[]).filter(
    (e) => e && typeof e.id === "string" && typeof e.title === "string" && typeof e.savedAt === "number" && e.record && e.record.v === 1 && Array.isArray(e.record.items),
  );
}

export async function loadPast(fileId: string): Promise<PastConversation[]> {
  try {
    return readPast(await get(chatsKey(fileId)));
  } catch {
    return [];
  }
}

/** Stores the list (an empty one removes the record). Failures are ignored, like the conversation's own. */
export async function savePast(fileId: string, list: readonly PastConversation[]): Promise<void> {
  try {
    if (!list.length) await del(chatsKey(fileId));
    else await set(chatsKey(fileId), { v: 1, list });
  } catch {
    /* storage unavailable or full: the history is a convenience */
  }
}

/** Changes the list in one storage transaction (two tabs on one file each add to what the other wrote). */
export async function updatePast(fileId: string, change: (list: PastConversation[]) => PastConversation[]): Promise<PastConversation[]> {
  let next: PastConversation[] = [];
  try {
    await update(chatsKey(fileId), (old: unknown) => {
      next = change(readPast(old));
      return { v: 1, list: next };
    });
    if (!next.length) await del(chatsKey(fileId));
  } catch {
    /* storage unavailable or full: the history is a convenience */
  }
  return next;
}

/** "just now", "5 minutes ago", "yesterday", or the date. */
export function relativeDate(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}
