// "A file's versions changed": tells the History tab (in this tab and in other tabs of the same
// browser) to reread the list. It has a channel of its own: `dt-files` means "another tab saved
// this file" to the editor, which would then offer a reload.

import type { Version } from "./files";

const CHANNEL = "dt-versions";

type Listener = { fileId: string; cb: () => void };
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null | undefined;

function deliver(fileId: string) {
  for (const l of [...listeners]) if (l.fileId === fileId) l.cb();
}

/** The shared channel, opened on first use (null where there is none). */
function chan(): BroadcastChannel | null {
  if (channel === undefined) {
    try {
      channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
      channel?.addEventListener("message", (e: MessageEvent) => {
        const id = (e.data as { fileId?: unknown } | null)?.fileId;
        if (typeof id === "string") deliver(id);
      });
    } catch {
      channel = null;
    }
  }
  return channel;
}

/** Call after a version of `fileId` was saved, renamed or deleted. */
export function notifyVersions(fileId: string) {
  deliver(fileId);
  try {
    chan()?.postMessage({ fileId });
  } catch {
    /* other tabs just refresh when they next show */
  }
}

/** Runs `cb` whenever the versions of `fileId` change here or in another tab. Returns the unsubscribe. */
export function onVersionsChange(fileId: string, cb: () => void): () => void {
  chan();
  const l = { fileId, cb };
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** The default name for the next version: "Version N", N one more than the largest "Version <n>"
 *  already there (other names, including renamed ones, don't count). */
export function nextVersionName(versions: Pick<Version, "name">[]): string {
  let max = 0;
  for (const v of versions) {
    const m = /^Version (\d+)$/.exec(v.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Version ${max + 1}`;
}
