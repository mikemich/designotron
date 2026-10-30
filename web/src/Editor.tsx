import { useEffect, useState } from "react";
import { Canvas } from "./canvas/Canvas";
import { LeftPanel } from "./panels/LeftPanel";
import { RightPanel } from "./panels/RightPanel";
import { Toolbar } from "./panels/Toolbar";
import { ChatPanel } from "./ai/ChatPanel";
import { askClaude } from "./ai/chatState";
import { Presenter } from "./Presenter";
import { Tour } from "./Tour";
import { VariablesDialog } from "./panels/VariablesDialog";
import { FigmaImportDialog } from "./panels/FigmaImportDialog";
import { PluginWindow, PluginsDialog } from "./panels/PluginsDialog";
import { stopPlugin, usePlugins } from "./plugins";
import { joinShared, stopSharing, useCollab } from "./collab";
import { GuestBar } from "./panels/GuestBar";
import { ShortcutsDialog } from "./panels/ShortcutsDialog";
import { ImportDialog } from "./panels/ImportDialog";
import { PhoneNote } from "./panels/PhoneNote";
import { DemoOverlay, stopDemo } from "./Demo";
import { ShareDialog } from "./panels/ShareDialog";
import { installShortcuts } from "./shortcuts";
import { bootEngine, getDoc, getEngine, markSaved, newEngine, onDocChange, useStore, zoomToFit, dispatch } from "./store";
import {
  clearRecovery,
  listVersions,
  loadFile,
  persistentStorage,
  readRecovery,
  saveFile,
  saveThumbnail,
  saveVersion,
  writeRecovery,
} from "./files";
import { AUTO_VERSION_MS } from "./panels/HistoryPanel";
import { nodeSvg, svgToPngBlob } from "./exporter";
import { readFileAsDataUrl } from "./assets";

/** Largest document (in characters) copied to localStorage when closing: the quota is about
 * 5 MB, and a bigger copy only fails after a slow synchronous write. */
const MAX_RECOVERY_CHARS = 4_500_000;

/** A prompt for Claude to send once the next file has opened (from the start screen). */
let askOnOpen: string | null = null;
export function askWhenOpen(prompt: string) {
  askOnOpen = prompt;
}

/** The document as serialised at one moment, with the engine revision it was taken at. */
interface Snapshot {
  json: string;
  name: string;
  rev: number;
}

export function Editor({ fileId, onHome }: { fileId: string; onHome: () => void }) {
  const chatOpen = useStore((s) => s.chatOpen);
  const presenting = useStore((s) => s.presenting);
  const toast = useStore((s) => s.toast);
  const variablesOpen = useStore((s) => s.variablesOpen);
  const figmaOpen = useStore((s) => s.figmaOpen);
  const pluginsOpen = usePlugins((s) => s.dialogOpen);
  const shareOpen = useCollab((s) => s.dialogOpen);
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState(false);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await bootEngine();
      // loadFile also loads the file's images. A copy kept while the page was closing is
      // newer than the last IndexedDB save.
      const stored = await loadFile(fileId).catch(() => null);
      const recovered = readRecovery(fileId);
      const json = recovered ?? stored;
      if (cancelled) return;
      // A link to a file that isn't in this browser (deleted, or from another device).
      if (json === null) {
        setMissing(true);
        return;
      }
      newEngine();
      if (json) {
        try {
          getEngine().load(json);
        } catch (err) {
          console.error(err);
        }
      }
      dispatch({ op: "relayout" });
      useStore.setState({ fileId, editingText: null, editingVector: null, presenting: null });
      // A recovered copy isn't in IndexedDB yet: leave it dirty so the first autosave stores it.
      markSaved(recovered === null ? useStore.getState().es.docRev : -1);
      setReady(true);
      // Two frames: the canvas has its final size by then.
      requestAnimationFrame(() => requestAnimationFrame(zoomToFit));
      joinShared();
      if (askOnOpen) {
        const prompt = askOnOpen;
        askOnOpen = null;
        askClaude(prompt);
      }
    })();
    return () => {
      cancelled = true;
      // Leaving the file stops what was running in it (a plugin would otherwise go on
      // editing whichever file opens next), and leaves its shared session.
      stopPlugin();
      stopDemo();
      if (useCollab.getState().role) stopSharing();
    };
  }, [fileId]);

  useEffect(() => installShortcuts(), []);

  // Autosave to IndexedDB, with an occasional thumbnail.
  //
  // Saves run one at a time, each serialising the document when it starts, so a slow one can
  // never land after (and over) a newer one. "Saved" means the engine's docRev equals the
  // docRev of a save that finished, so selecting or switching page never triggers a save, and
  // edits made while a save is running keep the file dirty.
  useEffect(() => {
    if (!ready) return;
    const engine = getEngine();
    const docRev = () => useStore.getState().es.docRev;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let idle: number | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let lastThumb = 0;
    let thumbBusy = false;
    let lastVersion = Date.now();
    let seenRev = docRev();
    // docRev of the copy kept in localStorage (written when a save fails or the page closes),
    // so a finished save only clears a recovery copy it has caught up with. `recoveryTried`
    // stops the same revision being serialised into localStorage again and again.
    let recoveryRev = -1;
    let recoveryTried = -1;
    // When the oldest unsaved change was made: steady edits can't postpone saving past a
    // maximum wait.
    let pendingSince: number | null = null;
    // Highest docRev a write has been started for, and the latest serialised document (so
    // closing doesn't serialise a big file once per event).
    let startedRev = -1;
    let lastSnap: Snapshot | null = null;
    // Layer count for the debounce, refreshed now and then rather than per change.
    let layers = { n: 0, at: 0 };
    // A file without versions gets its first autosave one interval from now, not on the first save.
    listVersions(fileId).then((v) => (lastVersion = v[0]?.createdAt ?? Date.now()));
    // Another tab saving this file makes this tab's copy stale: stop autosaving here so it
    // can't overwrite the newer work, and offer a reload.
    const tabs = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("dt-files");
    let stale = false;
    if (tabs)
      tabs.onmessage = (e) => {
        // In a live session both tabs stay in sync through the room, so they're not stale.
        if (e.data?.fileId === fileId && !useCollab.getState().role) {
          stale = true;
          setStale(true);
        }
      };
    let closed = false;
    let running = false;
    // A snapshot taken eagerly (the page is closing, or the editor is about to be replaced).
    let final: Snapshot | null = null;

    const snapshot = (): Snapshot => {
      const rev = docRev();
      if (lastSnap?.rev !== rev) lastSnap = { json: engine.save(), name: getDoc().name, rev };
      return lastSnap;
    };

    // Keeps a synchronous copy in localStorage. False when it couldn't be kept: over the
    // quota (a big file's copy is never tried, it would only fail slowly) or storage blocked.
    const keepRecovery = (snap: Snapshot): boolean => {
      if (recoveryTried === snap.rev) return recoveryRev === snap.rev;
      recoveryTried = snap.rev;
      if (snap.json.length <= MAX_RECOVERY_CHARS && writeRecovery(fileId, snap.json)) {
        recoveryRev = snap.rev;
        return true;
      }
      clearRecovery(fileId);
      recoveryRev = -1;
      return false;
    };

    const dropRecovery = (snap: Snapshot) => {
      // Without working storage the localStorage copy is the only one there is.
      if (!persistentStorage()) keepRecovery(snap);
      else if (recoveryRev <= snap.rev) {
        clearRecovery(fileId);
        recoveryRev = -1;
      }
    };

    // Runs saves until nothing newer than the last one is left. A call while one is running
    // changes nothing: the running loop takes another pass.
    const flush = async () => {
      if (running) return;
      running = true;
      try {
        while (!stale && (final || (!closed && docRev() !== useStore.getState().savedDocRev))) {
          // The engine was replaced under this editor: its revisions mean nothing here.
          if (!final && getEngine() !== engine) break;
          const snap = final ?? snapshot();
          final = null;
          pendingSince = null;
          startedRev = Math.max(startedRev, snap.rev);
          try {
            await saveFile(fileId, snap.name, snap.json);
          } catch (err) {
            // Not stored (quota, disk): stay dirty, keep what the recovery copy can hold, try again.
            console.error(err);
            keepRecovery(snap);
            startedRev = -1;
            if (!closed) {
              useStore.setState({ saveFailed: true });
              retry ??= setTimeout(() => {
                retry = null;
                schedule();
              }, 5000);
            }
            break;
          }
          dropRecovery(snap);
          if (lastSnap === snap) lastSnap = null;
          // Closed: the editor has moved on, so there is nothing to report and the channel is shut.
          if (closed) continue;
          tabs?.postMessage({ fileId });
          if (getEngine() === engine && snap.rev > useStore.getState().savedDocRev) markSaved(snap.rev);
          if (Date.now() - lastVersion > AUTO_VERSION_MS) {
            lastVersion = Date.now();
            await saveVersion(fileId, "Autosave", snap.json, true).catch(console.error);
          }
          maybeThumbnail();
        }
      } finally {
        running = false;
      }
    };

    // The thumbnail is rendered on its own (it can take seconds: fonts are fetched) and only
    // touches the file's index entry, never its document.
    const maybeThumbnail = () => {
      if (closed || thumbBusy || Date.now() - lastThumb < 15000) return;
      thumbBusy = true;
      lastThumb = Date.now();
      const run = () => {
        if (closed) {
          thumbBusy = false;
          return;
        }
        thumbnail()
          .then(async (t) => {
            if (t && !closed) await saveThumbnail(fileId, t);
          })
          .catch(() => {})
          .finally(() => (thumbBusy = false));
      };
      if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 3000 });
      else setTimeout(run, 0);
    };

    // 400 ms for ordinary files, rising to 2 s at 18k layers: serialising a big file costs
    // more than the typist notices, so wait for a longer pause. But never longer than
    // 4 s (10 s for big files) since the first unsaved change, however steadily edits arrive.
    const delay = () => {
      const now = Date.now();
      if (now - layers.at > 5000) layers = { n: Object.keys(getDoc().nodes).length, at: now };
      const big = Math.min(1, Math.max(0, (layers.n - 2000) / 16000));
      const debounce = 400 + big * 1600;
      const left = (pendingSince ?? now) + 4000 + big * 6000 - now;
      return Math.max(0, Math.min(debounce, left));
    };

    const cancelTimers = () => {
      if (timer) clearTimeout(timer);
      if (idle !== null && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      timer = null;
      idle = null;
    };

    const schedule = () => {
      cancelTimers();
      timer = setTimeout(() => {
        timer = null;
        if (typeof requestIdleCallback !== "function") return void flush();
        idle = requestIdleCallback(
          () => {
            idle = null;
            flush();
          },
          { timeout: 1000 },
        );
      }, delay());
    };

    const off = onDocChange(() => {
      // Selection and page changes move the revision but not the document.
      const rev = docRev();
      if (rev === seenRev) return;
      seenRev = rev;
      pendingSince ??= Date.now();
      schedule();
    });
    // A copy recovered after a crash isn't in IndexedDB yet.
    if (useStore.getState().dirty) {
      pendingSince = Date.now();
      schedule();
    }

    // Closing or reloading: IndexedDB writes can be cut off, so keep a synchronous copy in
    // localStorage too (picked up the next time the file opens). False when it couldn't be kept.
    const leave = (): boolean => {
      if (!useStore.getState().dirty || stale) return true;
      const snap = snapshot();
      const kept = keepRecovery(snap);
      cancelTimers();
      if (startedRev >= snap.rev) return kept;
      startedRev = snap.rev;
      if (!running) {
        final = snap;
        flush();
      } else {
        // A save is running: don't queue behind it. IndexedDB runs write transactions on
        // the store in the order they were made, so this one lands after it.
        saveFile(fileId, snap.name, snap.json).then(
          () => {
            dropRecovery(snap);
            if (!closed && getEngine() === engine && snap.rev > useStore.getState().savedDocRev) markSaved(snap.rev);
          },
          (err) => {
            console.error(err);
            startedRev = -1;
          },
        );
      }
      return kept;
    };
    // Unsaved work (waiting, or being written right now) or a recovery copy that couldn't be
    // kept: ask before the page goes.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (stale || !useStore.getState().dirty) return;
      leave();
      e.preventDefault();
      e.returnValue = "";
    };
    const hidden = () => document.visibilityState === "hidden" && leave();
    const pagehide = () => void leave();
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pagehide);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      off();
      cancelTimers();
      if (retry) clearTimeout(retry);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pagehide);
      document.removeEventListener("visibilitychange", hidden);
      // Leaving the file: write what's unsaved now, before the engine is replaced.
      if (!stale && useStore.getState().dirty && startedRev < docRev()) {
        final = snapshot();
        startedRev = final.rev;
        flush();
      }
      closed = true;
      tabs?.close();
    };
  }, [ready, fileId]);

  if (missing)
    return (
      <div className="empty-hint">
        <div>This file isn't in this browser. It may have been deleted, or it was made on another device.</div>
        <button className="btn primary" style={{ marginTop: 12 }} onClick={onHome}>
          Back to your files
        </button>
      </div>
    );
  if (!ready) return <div className="empty-hint">Loading…</div>;
  return (
    <div className="app">
      <Toolbar onHome={onHome} />
      <div className={"main" + (chatOpen ? " with-chat" : "")}>
        <LeftPanel />
        <Canvas />
        <RightPanel />
        {chatOpen && <ChatPanel />}
      </div>
      {presenting && <Presenter start={presenting} />}
      <Tour />
      {variablesOpen && <VariablesDialog />}
      {figmaOpen && <FigmaImportDialog />}
      {pluginsOpen && <PluginsDialog />}
      {shareOpen && <ShareDialog />}
      <GuestBar />
      {stale && (
        <div className="stale-bar" role="alert">
          This file was changed in another tab. Edits here are no longer saved.
          <button className="btn primary small" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}
      <ShortcutsDialog />
      <ImportDialog />
      <PhoneNote />
      <DemoOverlay />
      <PluginWindow />
      {toast && (
        <div className={"toast " + toast.kind} role="status" aria-live="polite">
          {toast.text}
        </div>
      )}
    </div>
  );
}

async function thumbnail(): Promise<string | undefined> {
  const doc = getDoc();
  const page = doc.pages[0];
  const first = page.children.find((id) => doc.nodes[id]?.visible);
  if (!first) return undefined;
  const svg = nodeSvg(first);
  const w = Number(svg.match(/width="([\d.]+)"/)?.[1] ?? 100);
  const h = Number(svg.match(/height="([\d.]+)"/)?.[1] ?? 100);
  const blob = await svgToPngBlob(svg, Math.min(1, 280 / Math.max(w, h)));
  return readFileAsDataUrl(blob);
}
