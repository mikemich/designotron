import { useEffect, useRef, useState } from "react";
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
  canSaveDelta,
  claimFile,
  clearRecovery,
  listVersions,
  loadFile,
  persistentStorage,
  planIsOutdated,
  readRecovery,
  saveDelta,
  StaleStorageError,
  storedSize,
  saveThumbnail,
  saveVersion,
  writeRecovery,
  type SavePlan,
} from "./files";
import { AUTO_VERSION_MS } from "./panels/HistoryPanel";
import { nodeSvg, svgToPngBlob } from "./exporter";
import { readFileAsDataUrl } from "./assets";
import { failureText, reportFailure } from "./errors";

/** Largest document (in characters) copied to localStorage when closing: the quota is about
 * 5 MB, and a bigger copy only fails after a slow synchronous write. */
const MAX_RECOVERY_CHARS = 4_500_000;
/** Characters of JSON per layer for guessing the size of a file not yet stored in layers. */
const GUESS_CHARS_PER_LAYER = 1100;
/** Longest stretch (ms) of one task spent collecting what to save. */
const SAVE_SLICE_MS = 8;

/** Numbers the editors (engine instances) opened in this page, for ordering their saves. */
let editorCount = 0;

/** Files whose editor was just closed and is still writing: opening the file again waits for
 * that write, or it would read the file as it was before it. */
const closing = new Map<string, Promise<void>>();
/** Longest an editor waits for the closing editor's last write. */
const CLOSING_WAIT_MS = 15000;

/** A prompt for Claude to send once the next file has opened (from the start screen). */
let askOnOpen: string | null = null;
export function askWhenOpen(prompt: string | null) {
  askOnOpen = prompt;
}

/** What to write for the document as of one moment: the layers that changed since the last
 * stored write, with the engine revision it was taken at. */
interface Snapshot {
  plan: SavePlan;
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
  /** Why the file couldn't be read right now (it may well be in this browser); retried by a button. */
  const [readError, setReadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stale, setStale] = useState(false);
  /** The closing editor's last save is still being written. */
  const [finishing, setFinishing] = useState(false);
  /** This editor's number, taken when it starts opening the file (see `claimFile`). */
  const editorIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setReadError(null);
    setMissing(false);
    (async () => {
      try {
        await bootEngine();
      } catch (err) {
        if (!cancelled) setReadError(failureText("load the editor", err));
        return;
      }
      const last = closing.get(fileId);
      if (last) {
        setFinishing(true);
        await Promise.race([last, new Promise((r) => setTimeout(r, CLOSING_WAIT_MS))]);
        setFinishing(false);
      }
      // From here no older editor's save may land over what this one reads and then writes.
      editorIdRef.current = ++editorCount;
      claimFile(fileId, editorIdRef.current);
      // loadFile also loads the file's images. A copy kept while the page was closing is
      // newer than the last IndexedDB save.
      let stored: string | null = null;
      let readFailed: unknown = null;
      try {
        stored = await loadFile(fileId);
      } catch (err) {
        readFailed = err ?? new Error("storage failed");
      }
      const recovered = readRecovery(fileId);
      const json = recovered ?? stored;
      if (cancelled) return;
      // Storage failed and there is no recovery copy: the file may well be here, so don't
      // claim it isn't.
      if (readFailed && recovered === null) {
        console.error(readFailed);
        setReadError(failureText("read this file", readFailed));
        return;
      }
      // A link to a file that isn't in this browser (deleted, or from another device).
      if (json === null) {
        setMissing(true);
        return;
      }
      newEngine();
      if (json) {
        try {
          getEngine().load(json);
          // Read from storage as it is (not a recovered copy): later saves write only changes.
          if (recovered === null && canSaveDelta(fileId)) getEngine().persistAdopt();
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
  }, [fileId, attempt]);

  useEffect(() => installShortcuts(), []);

  // Autosave to IndexedDB, with an occasional thumbnail.
  //
  // Saves run one at a time, each taking the layers that changed when it starts, so a slow one
  // can never land after (and over) a newer one. "Saved" means the engine's docRev equals the
  // docRev of a save that finished, so selecting or switching page never triggers a save, and
  // edits made while a save is running keep the file dirty.
  useEffect(() => {
    if (!ready) return;
    const engine = getEngine();
    const editorId = editorIdRef.current;
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
    // Highest docRev a write has been started for, and the latest plan (so closing doesn't
    // collect a big file's changes once per event).
    let startedRev = -1;
    let lastSnap: Snapshot | null = null;
    // Layer count for the debounce, refreshed now and then rather than per change.
    let layers = { n: 0, at: 0 };
    // A file without versions gets its first autosave one interval from now, not on the first save.
    listVersions(fileId).then(
      (v) => (lastVersion = v[0]?.createdAt ?? Date.now()),
      (err) => reportFailure("read this file's versions", err),
    );
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

    // A plan can only be written on top of what is stored (`canSaveDelta`): when that was
    // replaced since the plan was made (another writer saved the whole file), make a new one.
    const stillUsable = (snap: Snapshot | null, rev: number): snap is Snapshot =>
      !!snap && snap.rev === rev && (snap.plan.full || canSaveDelta(fileId));

    // The layers to write, gathered in one go (closing the page can't wait).
    const snapshot = (): Snapshot => {
      const rev = docRev();
      if (!stillUsable(lastSnap, rev)) {
        const p = JSON.parse(engine.persistPlan(!canSaveDelta(fileId)));
        const dirty: Record<string, string> = {};
        for (const root of p.dirty as string[]) dirty[root] = engine.persistChunk(p.token, root);
        lastSnap = { plan: { token: p.token, full: p.full, meta: p.meta, dirty, names: p.names, removed: p.removed, engine: editorId }, name: getDoc().name, rev };
      }
      return lastSnap!;
    };

    // The same, letting the page breathe between layers: after changing everything in a big
    // file this is megabytes of JSON, which as one task would stall typing and the canvas.
    const snapshotInSlices = async (): Promise<Snapshot> => {
      for (;;) {
        const rev = docRev();
        if (stillUsable(lastSnap, rev)) return lastSnap;
        const p = JSON.parse(engine.persistPlan(!canSaveDelta(fileId)));
        const dirty: Record<string, string> = {};
        let sliceStart = performance.now();
        let superseded = false;
        for (const root of p.dirty as string[]) {
          const body = engine.persistChunk(p.token, root);
          // A plan made meanwhile (closing the page) replaced this one: start over.
          if (!body) {
            superseded = true;
            break;
          }
          dirty[root] = body;
          if (performance.now() - sliceStart > SAVE_SLICE_MS) {
            await new Promise((r) => setTimeout(r));
            sliceStart = performance.now();
          }
        }
        if (superseded) continue;
        const gathered: Snapshot = { plan: { token: p.token, engine: editorId, full: p.full, meta: p.meta, dirty, names: p.names, removed: p.removed }, name: getDoc().name, rev };
        // (Not over a newer plan made meanwhile, say by closing the page.)
        const last = lastSnap as Snapshot | null;
        if (!last || last.rev <= rev) lastSnap = gathered;
        return gathered;
      }
    };

    // Keeps a synchronous copy of the whole document in localStorage too (as of now, which is
    // the revision it is filed under). False when it couldn't be kept: over the quota (a big
    // file's copy is never tried, it would only fail slowly) or storage blocked.
    const keepRecovery = (): boolean => {
      const rev = docRev();
      if (recoveryTried === rev) return recoveryRev === rev;
      recoveryTried = rev;
      // From the size of what was stored (or a guess), so a big file isn't serialised just to
      // find out its copy is too big for localStorage.
      if ((storedSize(fileId) ?? Object.keys(getDoc().nodes).length * GUESS_CHARS_PER_LAYER) <= MAX_RECOVERY_CHARS) {
        const json = engine.save();
        if (json.length <= MAX_RECOVERY_CHARS && writeRecovery(fileId, json)) {
          recoveryRev = rev;
          return true;
        }
      }
      clearRecovery(fileId);
      recoveryRev = -1;
      return false;
    };

    const dropRecovery = (snap: Snapshot) => {
      // Without working storage the localStorage copy is the only one there is.
      if (!persistentStorage()) keepRecovery();
      else if (recoveryRev <= snap.rev) {
        clearRecovery(fileId);
        recoveryRev = -1;
      }
    };

    // Writes a snapshot and tells the engine it landed. If the stored file isn't the one this tab
    // last wrote (another tab or writer saved it since), the whole document is written over it
    // instead: the last writer wins, whole, never a mix. Returns what was written, or null when
    // a newer plan was already started (that write covers it; nothing is committed or marked saved).
    const store = async (sn: Snapshot): Promise<boolean> => {
      const saved = await saveDelta(fileId, sn.name, sn.plan);
      if (!saved) return false;
      engine.persistCommit(sn.plan.token);
      // The save kept a name the file was given elsewhere: the editor shows it too.
      if (saved.name !== sn.name && !closed && getEngine() === engine) dispatch({ op: "setDocName", name: saved.name });
      return true;
    };
    const write = async (snap: Snapshot): Promise<Snapshot | null> => {
      try {
        return (await store(snap)) ? snap : null;
      } catch (err) {
        if (!(err instanceof StaleStorageError)) throw err;
        lastSnap = null;
        const whole = snapshot();
        return (await store(whole)) ? whole : null;
      }
    };

    // Runs saves until nothing newer than the last one is left. A call while one is running
    // changes nothing: the running loop takes another pass.
    let flushing: Promise<void> | null = null;
    const flush = (): Promise<void> => {
      if (!running) {
        running = true;
        flushing = runFlush();
      }
      return flushing!;
    };
    const runFlush = async () => {
      try {
        // A write already started for this revision (closing while one ran) is not repeated.
        while (!stale && (final || (!closed && docRev() !== useStore.getState().savedDocRev && startedRev < docRev()))) {
          // The engine was replaced under this editor: its revisions mean nothing here.
          if (!final && getEngine() !== engine) break;
          let snap = final ?? (await snapshotInSlices());
          final = null;
          // A plan still being gathered when a newer one was made and started (closing the
          // page) must not land after it: it holds older records of the same layers.
          // (Its write is already under way and handles failure itself: leave the loop.)
          if (planIsOutdated(fileId, snap.plan)) break;
          pendingSince = null;
          startedRev = Math.max(startedRev, snap.rev);
          try {
            const done = await write(snap);
            if (!done) break;
            snap = done;
            startedRev = Math.max(startedRev, snap.rev);
          } catch (err) {
            // Not stored (quota, disk): stay dirty, keep what the recovery copy can hold, try again.
            console.error(err);
            keepRecovery();
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
          // Without working storage nothing is saved: stay dirty (and ask before closing).
          if (persistentStorage() && getEngine() === engine && snap.rev > useStore.getState().savedDocRev) markSaved(snap.rev);
          if (Date.now() - lastVersion > AUTO_VERSION_MS) {
            lastVersion = Date.now();
            // A version is a whole copy of the file (the current one, which may be newer than
            // the save that just finished).
            await saveVersion(fileId, "Autosave", engine.save(), true).catch(console.error);
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
      const kept = keepRecovery();
      cancelTimers();
      if (startedRev >= snap.rev) return kept;
      startedRev = snap.rev;
      if (!running) {
        final = snap;
        flush();
      } else {
        // A save is running: don't queue behind it. IndexedDB runs write transactions on
        // the store in the order they were made, so this one lands after it.
        write(snap).then(
          (done) => {
            if (!done) return;
            dropRecovery(done);
            if (persistentStorage() && !closed && getEngine() === engine && done.rev > useStore.getState().savedDocRev) markSaved(done.rev);
          },
          (err) => {
            console.error(err);
            startedRev = -1;
            if (!closed) {
              useStore.setState({ saveFailed: true });
              retry ??= setTimeout(() => {
                retry = null;
                schedule();
              }, 5000);
            }
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
      if (running) {
        const writing: Promise<void> = flushing!.finally(() => {
          if (closing.get(fileId) === writing) closing.delete(fileId);
        });
        closing.set(fileId, writing);
      }
      closed = true;
      tabs?.close();
    };
  }, [ready, fileId]);

  if (readError)
    return (
      <div className="empty-hint" role="alert">
        <div>{readError}</div>
        <div className="muted small" style={{ marginTop: 6 }}>
          Nothing was changed or deleted. Try again in a moment.
        </div>
        <div className="row" style={{ marginTop: 12, justifyContent: "center" }}>
          <button className="btn primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
          <button className="btn" onClick={onHome}>
            Back to your files
          </button>
        </div>
      </div>
    );
  if (missing)
    return (
      <div className="empty-hint">
        <div>This file isn't in this browser. It may have been deleted, or it was made on another device.</div>
        <button className="btn primary" style={{ marginTop: 12 }} onClick={onHome}>
          Back to your files
        </button>
      </div>
    );
  if (!ready) return <div className="empty-hint">{finishing ? "Finishing the last save…" : "Loading…"}</div>;
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
