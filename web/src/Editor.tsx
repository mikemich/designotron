import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas } from "./canvas/Canvas";
import { LeftPanel } from "./panels/LeftPanel";
import { RightPanel } from "./panels/RightPanel";
import { Toolbar } from "./panels/Toolbar";
import { ChatPanel } from "./ai/ChatPanel";
import { askClaude, enterFile, leaveFile } from "./ai/chatState";
import { Presenter } from "./Presenter";
import { Tour } from "./Tour";
import { VariablesDialog } from "./panels/VariablesDialog";
import { FigmaImportDialog } from "./panels/FigmaImportDialog";
import { PluginWindow, PluginsDialog } from "./panels/PluginsDialog";
import { stopPlugin, usePlugins } from "./plugins";
import { joinShared, stopSharing, useCollab } from "./collab";
import { ShortcutsDialog } from "./panels/ShortcutsDialog";
import { ImportDialog } from "./panels/ImportDialog";
import { PhoneNote } from "./panels/PhoneNote";
import { DemoOverlay, playDemo, stopDemo } from "./Demo";
import { importFigmaJson } from "./figma";
import { ShareDialog } from "./panels/ShareDialog";
import { installShortcuts } from "./shortcuts";
import { bootEngine, getDoc, getEngine, markSaved, newEngine, lastKnownDoc, noteEngineError, onDocChange, saveHook, toast as showToast, useStore, zoomToFit, dispatch } from "./store";
import { focusCanvas, ToastLive } from "./ui/controls";
import { closePanel } from "./panels/PanelChrome";
import {
  askPersist,
  canSaveDelta,
  claimFile,
  onStorageBack,
  stealFileLock,
  tabLocksSupported,
  tryFileLock,
  waitFileLock,
  type FileLock,
  clearRecovery,
  download as download_,
  listVersions,
  loadFile,
  toDtron,
  persistentStorage,
  planIsOutdated,
  readRecovery,
  saveDelta,
  saveFile,
  listFolders,
  getFileMeta,
  onIndexChange,
  FileDeletedError,
  LockLostError,
  fenceFile,
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
import { resolveFolder } from "./folders";
import { saveDtron } from "./actions";
import { fileSafe } from "./exporter";

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

/** Files whose editing lock is about to be given up (after the closing editor's last write): the
 * same tab opening the file again waits for that, or it would find the file locked by itself. */
const releasing = new Map<string, Promise<void>>();

/** Lets the router ask the open editor before leaving it: true when it wants to ask first (and
 * then calls `go` if the person leaves anyway). */
export const leaveGuard: { ask: ((go: () => void) => boolean) | null } = { ask: null };

/** Names this page load on the channel the tabs tell each other about saves on. */
const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

/** This tab's part in "one editing tab per file". `view`: the tab only shows the file (another
 * tab holds `dt:file:<id>`), and neither saves nor edits. */
interface TabState {
  supported: boolean;
  view: boolean;
  /** Lost the lock with changes that aren't stored: they stay on screen until dealt with. */
  conflict: boolean;
  lock: FileLock | null;
}

/** Turns the engine's read-only mode on or off and shows it. (The command doesn't move the
 * revision, so the store would not pick it up on its own.) */
function setViewOnly(on: boolean) {
  useStore.setState({ tabView: on });
  dispatch({ op: "setReadOnly", on }, { quiet: true });
  try {
    useStore.setState({ es: JSON.parse(getEngine().state()) });
  } catch {
    /* engine not ready */
  }
}

/** A prompt for Claude to send once the next file has opened (from the start screen). */
let askOnOpen: string | null = null;
export function askWhenOpen(prompt: string | null) {
  askOnOpen = prompt;
}

/** Play the replay of Claude designing a page once the next file has opened (from the start screen). */
let demoOnOpen: string | null = null;
export function demoWhenOpen(fileId: string | null) {
  demoOnOpen = fileId;
}

/** The dashboard fetched a Figma file and made this one for it: import it now, once (taking it out of the
 *  store first, so a second mount can't repeat it). Warnings open the dialog's result view. */
function runPendingFigma(fileId: string) {
  const pending = useStore.getState().pendingFigma;
  if (!pending) return;
  useStore.setState({ pendingFigma: null });
  if (pending.fileId !== fileId) return; // meant for another file
  try {
    const r = importFigmaJson(pending.file, pending.images);
    showToast(`Imported ${r.layers} layers from Figma`);
    if (r.warnings.length) useStore.setState({ figmaResult: r, figmaOpen: "result" });
  } catch (err) {
    reportFailure("import from Figma", err);
  }
}

/** What to write for the document as of one moment: the layers that changed since the last
 * stored write, with the engine revision it was taken at. */
interface Snapshot {
  plan: SavePlan;
  name: string;
  rev: number;
}

/** Whatever throws while the editor draws shows a fallback instead of an empty page. Only a
 *  stopped engine (`engineFailed`, set by the call that trapped) counts as a failure of the
 *  engine: an ordinary render error leaves it healthy, so the editor's cleanup still saves what
 *  is pending. */
class EditorBoundary extends Component<{ fileId: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error(err);
    noteEngineError(err);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <EditorFallback fileId={this.props.fileId} retry={() => this.setState({ failed: false })} />;
  }
}

function EditorFallback({ fileId, retry }: { fileId: string; retry: () => void }) {
  const engineFailed = useStore((s) => s.engineFailed);
  if (engineFailed)
    return (
      <div className="engine-fallback" role="main">
        <EngineFailedBar fileId={fileId} />
        <p>The editor stopped, so this page can't be shown. Reload to reopen the file at its last save.</p>
      </div>
    );
  return (
    <div className="engine-fallback" role="main">
      <div className="stale-bar engine-bar" role="alert">
        <span>Something went wrong showing the editor. Your changes are saved.</span>
        <button className="btn primary small" onClick={() => location.reload()}>
          Reload
        </button>
        <button
          className="btn small"
          onClick={() => {
            try {
              saveDtron();
            } catch {
              showToast("Couldn't make a copy. Reload to reopen the last save.", "error");
            }
          }}
        >
          Download a .dtron copy
        </button>
        <button className="btn small" onClick={retry}>
          Try again
        </button>
      </div>
      <p>The editor hit a problem drawing this file.</p>
    </div>
  );
}

export function Editor(props: { fileId: string; onHome: () => void }) {
  return (
    <EditorBoundary fileId={props.fileId}>
      <EditorInner {...props} />
    </EditorBoundary>
  );
}

function EditorInner({ fileId, onHome }: { fileId: string; onHome: () => void }) {
  const chatOpen = useStore((s) => s.chatOpen);
  const panels = useStore((s) => s.panels);
  const compact = useStore((s) => s.compact);
  /** A view-only link: no Claude, no plugins, no drawing tools (the engine refuses edits anyway). */
  const engineReadOnly = useStore((s) => !!s.es.readOnly);
  const viewing = useCollab((s) => s.viewer);
  const readOnly = engineReadOnly || viewing;
  const presenting = useStore((s) => s.presenting);
  const variablesOpen = useStore((s) => s.variablesOpen);
  const figmaOpen = useStore((s) => s.figmaOpen);
  // The Figma import dialog belongs to this file: leaving the file closes it (it stays open to
  // show import warnings, and must not reappear over the next file).
  useEffect(() => () => useStore.setState({ figmaOpen: false, figmaResult: null, pendingFigma: null }), []);
  const pluginsOpen = usePlugins((s) => s.dialogOpen);
  const shareOpen = useCollab((s) => s.dialogOpen);
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState(false);
  /** Why the file couldn't be read right now (it may well be in this browser); retried by a button. */
  const [readError, setReadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stale, setStale] = useState(false);
  /** The file was deleted in another tab; `keep` brings it back. */
  const [gone, setGone] = useState(false);
  const keepRef = useRef<(() => void) | null>(null);
  /** The closing editor's last save is still being written. */
  const [finishing, setFinishing] = useState(false);
  /** This editor's number, taken when it starts opening the file (see `claimFile`). */
  const editorIdRef = useRef(0);
  const tabRef = useRef<TabState>({ supported: false, view: false, conflict: false, lock: null });
  /** What the bar about the other tab says (null: none). */
  const [tabBar, setTabBar] = useState<null | "other" | "asking" | "stuck" | "moved" | "conflict" | "session" | "unsaved">(null);
  const tabActions = useRef<{ handoff: () => void; steal: () => void; discard: () => void }>({ handoff: () => {}, steal: () => {}, discard: () => {} });
  /** Marks the open document stale (another tab saved while this one has unsaved edits). */
  const staleRef = useRef<(() => void) | null>(null);
  const tabView = useStore((s) => s.tabView);
  const engineFailed = useStore((s) => s.engineFailed);
  /** Leaving was asked for while unsaved changes are only on screen; the function leaves. */
  const [leaveAsk, setLeaveAsk] = useState<(() => void) | null>(null);
  /** Saving keeps failing (disk full, storage blocked): the bar offers a copy to download. */
  const [storageBar, setStorageBar] = useState(false);

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
      // One editing tab per file: without the lock this tab opens the file read-only. (Not for a
      // link into a live session: the room keeps tabs in step, as before.)
      const tab = tabRef.current;
      tab.view = false;
      tab.conflict = false;
      useStore.setState({ tabView: false });
      fenceFile(fileId, false);
      tab.lock = null;
      tab.supported = tabLocksSupported() && !/[?&](room|collab|view)=/.test(location.search);
      if (tab.supported) {
        // (The earlier editor's last write may be slow: wait for it, but not forever.)
        const rel = releasing.get(fileId);
        if (rel) await Promise.race([rel, new Promise((r) => setTimeout(r, CLOSING_WAIT_MS))]);
        if (cancelled) return;
        const held = await tryFileLock(fileId);
        if (cancelled) {
          held?.release();
          return;
        }
        tab.lock = held;
        tab.view = !held;
      }
      // loadFile also loads the file's images. A copy kept while the page was closing is
      // newer than the last IndexedDB save.
      let stored: string | null = null;
      let readFailed: unknown = null;
      try {
        stored = await loadFile(fileId);
      } catch (err) {
        readFailed = err ?? new Error("storage failed");
      }
      // (A tab that isn't the editing one never takes over a recovery copy: the editing tab's
      // newer work isn't in the file yet.)
      const recovered = tabRef.current.view ? null : readRecovery(fileId);
      const json = recovered ?? stored;
      if (cancelled) return;
      // Storage failed and there is no recovery copy: the file may well be here, so don't
      // claim it isn't.
      if (readFailed && recovered === null) {
        useStore.setState({ pendingFigma: null });
        console.error(readFailed);
        setReadError(failureText("read this file", readFailed));
        return;
      }
      // A link to a file that isn't in this browser (deleted, or from another device).
      if (json === null) {
        useStore.setState({ pendingFigma: null });
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
      if (tabRef.current.view) setViewOnly(true);
      useStore.setState({ fileId, editingText: null, editingVector: null, presenting: null });
      // A recovered copy isn't in IndexedDB yet: leave it dirty so the first autosave stores it.
      markSaved(recovered === null ? useStore.getState().es.docRev : -1);
      setReady(true);
      // Two frames: the canvas has its final size by then.
      requestAnimationFrame(() => requestAnimationFrame(zoomToFit));
      runPendingFigma(fileId);
      joinShared();
      // This file's own conversation (after the first paint: it only reads storage).
      await enterFile(fileId);
      if (cancelled) return;
      if (demoOnOpen) {
        const mine = demoOnOpen === fileId;
        demoOnOpen = null;
        if (mine) void playDemo();
      }
      if (askOnOpen) {
        const prompt = askOnOpen;
        askOnOpen = null;
        askClaude(prompt);
      }
    })();
    return () => {
      cancelled = true;
      // Data or a replay meant for this file that never got to run (the load was cancelled or failed)
      // must not land in the next file opened.
      if (useStore.getState().pendingFigma?.fileId === fileId) useStore.setState({ pendingFigma: null });
      if (demoOnOpen === fileId) demoOnOpen = null;
      // The lock goes once the closing editor's last write has finished (its cleanup runs next).
      const lock = tabRef.current.lock;
      tabRef.current.lock = null;
      if (lock) {
        const done = Promise.resolve().then(() => closing.get(fileId)).then(
          () => lock.release(),
          () => lock.release(),
        );
        const tracked = done.finally(() => {
          if (releasing.get(fileId) === tracked) releasing.delete(fileId);
        });
        releasing.set(fileId, tracked);
      }
      // Leaving the file stops what was running in it (a plugin would otherwise go on
      // editing whichever file opens next), and leaves its shared session.
      stopPlugin();
      stopDemo();
      // A Claude turn working in this file stops with it (and its late calls are refused).
      leaveFile();
      if (useCollab.getState().role) stopSharing();
    };
  }, [fileId, attempt]);

  useEffect(() => installShortcuts(), []);

  // A newly opened file takes keyboard focus (unless something such as the chat box already has it).
  useEffect(() => {
    if (!ready) return;
    const id = requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) focusCanvas();
    });
    return () => cancelAnimationFrame(id);
  }, [ready, fileId]);

  useFrameLabelColors(ready);
  useCanvasFocusRing();

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
    // The folder the file was in when it was deleted elsewhere (kept for "Keep it").
    let goneFolder: string | undefined;
    const markDeleted = (folder?: string) => {
      stale = true;
      goneFolder = folder ?? lastFolder;
      setGone(true);
    };
    // Where the file is, tracked so "Keep it" knows even if the deletion's broadcast was missed.
    let lastFolder: string | undefined;
    const trackFolder = () =>
      getFileMeta(fileId).then(
        (m) => {
          if (m) lastFolder = m.folder;
        },
        () => {},
      );
    trackFolder();
    const offFolder = onIndexChange(trackFolder);
    if (tabs)
      tabs.onmessage = (e) => {
        // In a live session both tabs stay in sync through the room, so they're not stale.
        if (e.data?.fileId === fileId && !useCollab.getState().role) {
          if (e.data.deleted) return markDeleted(e.data.folder);
          // A tab that only shows the file, or has nothing unsaved, reloads instead (see the tab
          // lock effect).
          if (tabRef.current.view || (tabRef.current.supported && tabRef.current.lock && !useStore.getState().dirty)) return;
          stale = true;
          setStale(true);
        }
      };
    staleRef.current = () => {
      stale = true;
      setStale(true);
    };
    keepRef.current = async () => {
      try {
        const place = resolveFolder(await listFolders(), goneFolder);
        await saveFile(fileId, getDoc().name, engine.save(), { folder: place, restore: true });
        stale = false;
        setGone(false);
        // What is on screen is stored whole now, but the next save must say so: a full one.
        startedRev = -1;
        lastSnap = null;
        schedule();
      } catch (err) {
        reportFailure("keep the file", err);
      }
    };
    // Saves in a row that didn't reach storage (failed, or kept in memory only).
    let failures = 0;
    const failedSave = () => {
      if (++failures >= 2 && !closed) setStorageBar(true);
    };
    // IndexedDB works again (a probe write landed): save the whole file now.
    const offBack = onStorageBack(() => {
      failures = 0;
      setStorageBar(false);
      if (closed) return;
      useStore.setState({ saveFailed: false });
      startedRev = -1;
      lastSnap = null;
      schedule();
    });
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
      try {
        // From the size of what was stored (or a guess), so a big file isn't serialised just to
        // find out its copy is too big for localStorage.
        if ((storedSize(fileId) ?? Object.keys(getDoc().nodes).length * GUESS_CHARS_PER_LAYER) <= MAX_RECOVERY_CHARS) {
          const json = engine.save();
          if (json.length <= MAX_RECOVERY_CHARS && writeRecovery(fileId, json)) {
            recoveryRev = rev;
            return true;
          }
        }
      } catch (err) {
        // The engine can't serialise (a string too long, a trap): no copy, but never a throw
        // that would leave the label stuck on "Saving…".
        noteEngineError(err);
        console.error(err);
      }
      try {
        clearRecovery(fileId);
      } catch {
        /* storage blocked */
      }
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
    // A save that couldn't be prepared or written: say so and schedule the retry first, only then
    // try the recovery copy (which can fail too, and must never hide the failure).
    const saveFailure = (err: unknown) => {
      console.error(err);
      startedRev = -1;
      failedSave();
      if (!closed) {
        useStore.setState({ saveFailed: true });
        retry ??= setTimeout(
          () => {
            retry = null;
            schedule();
          },
          failures >= 3 ? 30000 : 5000,
        );
      }
      keepRecovery();
    };
    const runFlush = async () => {
      try {
        // A write already started for this revision (closing while one ran) is not repeated.
        while (!stale && !tabRef.current.view && !useStore.getState().engineFailed && (final || (!closed && docRev() !== useStore.getState().savedDocRev && startedRev < docRev()))) {
          // The engine was replaced under this editor: its revisions mean nothing here.
          if (!final && getEngine() !== engine) break;
          // Preparing the save can fail too (wasm out of memory, a string too long): that is a
          // failed save like a failed write, never a label stuck on "Saving…".
          let snap: Snapshot;
          try {
            snap = final ?? (await snapshotInSlices());
          } catch (err) {
            final = null;
            noteEngineError(err);
            saveFailure(err);
            break;
          }
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
            // Deleted elsewhere: nothing to retry (the bar offers to keep it).
            if (err instanceof FileDeletedError) {
              markDeleted();
              break;
            }
            // Another tab took the file over: nothing more is written here (the tab lock effect
            // keeps the unsaved changes on screen).
            if (err instanceof LockLostError) break;
            // Not stored (quota, disk): stay dirty, keep what the recovery copy can hold, try again.
            saveFailure(err);
            break;
          }
          dropRecovery(snap);
          if (persistentStorage()) {
            failures = 0;
            if (!closed) setStorageBar(false);
            askPersist();
          } else failedSave();
          if (lastSnap === snap) lastSnap = null;
          // Closed: the editor has moved on, so there is nothing to report and the channel is shut.
          if (closed) continue;
          tabs?.postMessage({ fileId, src: TAB_ID });
          // Without working storage nothing is saved: stay dirty (and ask before closing).
          if (persistentStorage() && getEngine() === engine && snap.rev > useStore.getState().savedDocRev) markSaved(snap.rev);
          if (Date.now() - lastVersion > AUTO_VERSION_MS) {
            lastVersion = Date.now();
            // A version is a whole copy of the file (the current one, which may be newer than
            // the save that just finished).
            try {
              await saveVersion(fileId, "Automatic version", engine.save(), true);
            } catch (err) {
              noteEngineError(err);
              console.error(err);
            }
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
      const run = () => {
        if (closed) {
          thumbBusy = false;
          return;
        }
        thumbnail()
          .then(async (t) => {
            // An empty file makes none: don't hold back the first real one.
            if (t && !closed) {
              await saveThumbnail(fileId, t);
              lastThumb = Date.now();
            }
          })
          .catch(() => (lastThumb = Date.now()))
          .finally(() => (thumbBusy = false));
      };
      if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 3000 });
      else setTimeout(run, 0);
    };

    // A file opened without a preview (a template, an imported .dtron) gets one without waiting
    // for the first edit.
    const openThumb = setTimeout(() => {
      getFileMeta(fileId).then((m) => {
        // (Rendering one runs on the main thread: not for very big files.)
        if (m && !m.thumbnail && Object.keys(getDoc().nodes).length <= 5000) maybeThumbnail();
      }, () => {});
    }, 2000);

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

    saveHook.flush = flush;
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
      if (!useStore.getState().dirty || stale || tabRef.current.view) return true;
      let snap: Snapshot;
      let kept: boolean;
      try {
        snap = snapshot();
        kept = keepRecovery();
      } catch (err) {
        // The engine can't serialise (it stopped): nothing to keep, and the page still asks before closing.
        noteEngineError(err);
        console.error(err);
        return false;
      }
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
            if (err instanceof FileDeletedError) return markDeleted();
            if (err instanceof LockLostError) return;
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
      // (A tab that lost the lock with unsaved changes asks too: closing it loses them.)
      if (stale || (tabRef.current.view && !tabRef.current.conflict) || !useStore.getState().dirty) return;
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
      offFolder();
      offBack();
      clearTimeout(openThumb);
      cancelTimers();
      if (retry) clearTimeout(retry);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pagehide);
      document.removeEventListener("visibilitychange", hidden);
      // Leaving the file: write what's unsaved now, before the engine is replaced.
      // (Not from a stopped engine: it can't be asked, and the page keeps asking before it closes.)
      if (!stale && !tabRef.current.view && !useStore.getState().engineFailed && useStore.getState().dirty && startedRev < docRev()) {
        try {
          final = snapshot();
          startedRev = final.rev;
          flush();
        } catch (err) {
          noteEngineError(err);
          console.error(err);
        }
      }
      if (running) {
        const writing: Promise<void> = flushing!.finally(() => {
          if (closing.get(fileId) === writing) closing.delete(fileId);
        });
        closing.set(fileId, writing);
      }
      closed = true;
      if (saveHook.flush === flush) saveHook.flush = null;
      tabs?.close();
    };
  }, [ready, fileId]);

  // One editing tab per file. The tab holding the Web Lock edits; any other shows the file
  // read-only, reloads it when the editing tab saves, and can take over: "Edit here instead" asks
  // the editing tab to save, go read-only and let go (the lock is only released after its last
  // write landed, so no edit is lost); if it doesn't within 5 s, "Edit here anyway" takes the lock.
  // A tab that loses the lock by force with unsaved changes keeps them on screen (and offers a
  // copy to download) instead of showing the file as stored.
  useEffect(() => {
    if (!ready) return;
    const tab = tabRef.current;
    if (!tab.supported) return;
    const lockCh = new BroadcastChannel("dt-lock");
    const filesCh = new BroadcastChannel("dt-files");
    let gone = false;
    let waiter: AbortController | null = null;
    let askTimer: ReturnType<typeof setTimeout> | null = null;
    let handing = false;
    // Taking over: reading the file. A save in another tab that lands meanwhile makes it read again.
    let taking = false;
    let savedMeanwhile = false;
    // A reload wanted while the tab is hidden waits until it is shown.
    let pendingHidden = false;
    // Reloads run one at a time, in the order asked.
    let chain: Promise<boolean> = Promise.resolve(false);
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    /** Reads the file from storage into the open editor (same page, selection and view kept where the
     * layers still exist). With `recovery`, a copy kept while another tab was closing counts too.
     * With `onlyClean`, nothing is replaced if this tab has unsaved edits by the time it has read.
     * False if the document wasn't replaced. */
    const reload = (recovery: boolean, onlyClean = false): Promise<boolean> =>
      (chain = chain.then(async () => {
        if (gone) return false;
        let stored: string | null;
        try {
          stored = await loadFile(fileId);
        } catch (err) {
          console.error(err);
          return false;
        }
        const recovered = recovery ? readRecovery(fileId) : null;
        const json = recovered ?? stored;
        if (json === null || gone) return false;
        // (No await from here to the load: nothing can be edited in between.)
        if (onlyClean && useStore.getState().dirty) {
          staleRef.current?.();
          return false;
        }
        const engine = getEngine();
        const { page, selection } = useStore.getState().es;
        try {
          engine.load(json);
          if (recovered === null && canSaveDelta(fileId)) engine.persistAdopt();
        } catch (err) {
          console.error(err);
          return false;
        }
        dispatch({ op: "relayout" });
        const doc = getDoc();
        if (doc.pages.some((p) => p.id === page)) dispatch({ op: "setPage", id: page });
        const keep = selection.filter((id) => doc.nodes[id]);
        if (keep.length) dispatch({ op: "select", ids: keep });
        markSaved(recovered === null ? useStore.getState().es.docRev : -1);
        return true;
      }));

    const becomeEditor = async (lock: FileLock) => {
      // (Not twice: a granted waiting request and a take-over can both arrive.)
      if (gone || tab.conflict || (tab.lock && tab.lock !== lock) || taking) return lock.release();
      if (askTimer) clearTimeout(askTimer);
      askTimer = null;
      tab.lock = lock;
      taking = true;
      savedMeanwhile = false;
      let ok = await reload(true);
      // The old holder's last write can land after the first read: read again until quiet.
      for (let i = 0; ok && savedMeanwhile && i < 5; i++) {
        savedMeanwhile = false;
        ok = await reload(true);
      }
      taking = false;
      if (gone) return;
      if (!ok) {
        // Can't tell what is stored: don't edit on a guess.
        showToast("Couldn't read the file to take over editing", "error");
        if (tab.lock === lock) tab.lock = null;
        lock.release();
        setTabBar("other");
        return queueWait();
      }
      // Taken from this tab again while it was reading.
      if (tab.lock !== lock) return;
      fenceFile(fileId, false);
      tab.view = false;
      setViewOnly(false);
      setTabBar(null);
      showToast("You can edit here now");
      // A recovered copy isn't stored yet.
      if (useStore.getState().dirty) void saveHook.flush?.();
      void lock.lost.then(() => onLost(lock));
    };
    const queueWait = () => {
      waiter?.abort();
      const ac = new AbortController();
      waiter = ac;
      void waitFileLock(fileId, ac.signal).then((lock) => {
        if (lock) void becomeEditor(lock);
      });
    };
    // The lock was taken from this tab by force. Its pending writes must not land; what isn't
    // saved stays on screen until the person has copied it or let it go.
    const onLost = (lock: FileLock) => {
      if (gone || tab.lock !== lock) return;
      tab.lock = null;
      // A live session keeps this tab editing, as it always did.
      if (useCollab.getState().role) return;
      fenceFile(fileId, true);
      tab.view = true;
      setViewOnly(true);
      if (useStore.getState().dirty) {
        tab.conflict = true;
        setTabBar("conflict");
      } else {
        setTabBar("moved");
        queueWait();
      }
    };

    // The editing tab: asked to let go.
    const refuse = (reason: "session" | "unsaved") => lockCh.postMessage({ kind: "handoff-refused", fileId, reason });
    const giveUp = async () => {
      if (handing || tab.view || !tab.lock) return;
      if (useCollab.getState().role) return refuse("session");
      handing = true;
      const lock = tab.lock;
      try {
        // An open text edit is part of the document already (every keystroke is); closing it
        // ends its undo step.
        if (useStore.getState().editingText) {
          useStore.setState({ editingText: null });
          await new Promise((r) => setTimeout(r, 60));
        }
        // Freeze first, so nothing is edited while the last save runs.
        setViewOnly(true);
        await saveHook.flush?.();
        if (gone || tab.lock !== lock) return;
        const st = useStore.getState();
        // Not stored (storage failing, or kept in memory only): keep editing, keep the lock.
        if (st.dirty || st.saveFailed || !persistentStorage()) {
          setViewOnly(false);
          return refuse("unsaved");
        }
        tab.lock = null;
        tab.view = true;
        setTabBar("moved");
        lock.release();
        queueWait();
        // Shows what is stored (this tab's last edit included) and drops the undo steps, which
        // no longer apply here.
        void reload(false);
      } finally {
        handing = false;
      }
    };
    lockCh.onmessage = (e) => {
      const d = e.data;
      if (d?.fileId !== fileId) return;
      if (d.kind === "handoff") void giveUp();
      else if (d.kind === "handoff-refused" && tab.view && !tab.lock) {
        if (askTimer) clearTimeout(askTimer);
        askTimer = null;
        setTabBar((b) => (b === "asking" || b === "stuck" ? (d.reason === "session" ? "session" : "unsaved") : b));
      }
    };

    // Another tab saved: a tab that only shows the file, or one that has nothing unsaved, reads it again.
    const reloadNow = () => {
      if (gone || tab.conflict || taking) return;
      if (tab.view && !tab.lock) void reload(false);
      else if (!tab.view && tab.lock && !useStore.getState().dirty && !handing) void reload(false, true);
    };
    const wantReload = () => {
      if (document.hidden) {
        pendingHidden = true;
        return;
      }
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        reloadNow();
      }, 150);
    };
    filesCh.onmessage = (e) => {
      const d = e.data;
      if (d?.fileId !== fileId || d.deleted || d.src === TAB_ID) return;
      if (taking) savedMeanwhile = true;
      // A third writer saved while this tab is handing over: what it holds may not be the newest.
      else if (handing && useStore.getState().dirty) staleRef.current?.();
      else wantReload();
    };
    const shown = () => {
      if (!document.hidden && pendingHidden) {
        pendingHidden = false;
        wantReload();
      }
    };
    document.addEventListener("visibilitychange", shown);

    tabActions.current = {
      handoff: () => {
        lockCh.postMessage({ kind: "handoff", fileId });
        setTabBar("asking");
        if (askTimer) clearTimeout(askTimer);
        askTimer = setTimeout(() => setTabBar((b) => (b === "asking" ? "stuck" : b)), 5000);
      },
      steal: async () => {
        if (tab.lock || taking) return;
        waiter?.abort();
        const lock = await stealFileLock(fileId);
        if (lock) void becomeEditor(lock);
        else queueWait();
      },
      discard: async () => {
        // The unsaved changes are let go: show the file as stored and wait for the lock again.
        tab.conflict = false;
        await reload(false);
        setTabBar("moved");
        queueWait();
      },
    };

    // Leaving the file inside the app (Home, another file, Back) with changes that are kept only
    // on screen asks first.
    leaveGuard.ask = (go) => {
      if (!tab.conflict || !useStore.getState().dirty) return false;
      setLeaveAsk(() => go);
      return true;
    };

    // A live session started or joined here: the room keeps the tabs in step, so nothing is held back.
    const offRole = useCollab.subscribe((c) => {
      if (!c.role || c.viewer || !tab.view || tab.conflict) return;
      waiter?.abort();
      tab.view = false;
      setViewOnly(false);
      setTabBar(null);
    });

    if (tab.view) {
      setTabBar("other");
      queueWait();
    } else if (tab.lock) {
      const held = tab.lock;
      void held.lost.then(() => onLost(held));
    }
    return () => {
      gone = true;
      offRole();
      waiter?.abort();
      if (askTimer) clearTimeout(askTimer);
      if (reloadTimer) clearTimeout(reloadTimer);
      document.removeEventListener("visibilitychange", shown);
      lockCh.close();
      filesCh.close();
      leaveGuard.ask = null;
      setTabBar(null);
      setLeaveAsk(null);
      // (The next file starts editable; a read-only mode belongs to this file.)
      useStore.setState({ tabView: false });
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
    <div className={"app" + (readOnly ? " view-only" : "")}>
      <Toolbar onHome={onHome} />
      {/* Before the main area in the DOM, so Tab reaches its buttons without crossing the canvas. */}
      {engineFailed && <EngineFailedBar fileId={fileId} second={!!(tabBar || gone || stale)} />}
      <main
        className={"main" + (chatOpen && !readOnly ? " with-chat" : "") + (panels.left ? "" : " no-left") + (panels.right ? "" : " no-right") + (compact ? " compact" : "")}
        onKeyDown={(e) => {
          // An overlay panel closes with Escape (and hands focus back to its toolbar button).
          if (e.key !== "Escape" || !compact || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
          const panel = (e.target as Element).closest(".main > .panel");
          if (!panel) return;
          e.preventDefault();
          e.stopPropagation();
          closePanel(panel.classList.contains("right") ? "right" : "left");
        }}
      >
        <LeftPanel />
        <Canvas />
        <RightPanel />
        {chatOpen && !readOnly && <ChatPanel />}
      </main>
      {presenting && <Presenter start={presenting} />}
      <Tour />
      {variablesOpen && <VariablesDialog />}
      {(figmaOpen === true || figmaOpen === "result") && <FigmaImportDialog />}
      {pluginsOpen && !readOnly && <PluginsDialog />}
      {shareOpen && <ShareDialog />}
      {gone && (
        <div className="stale-bar" role="alert">
          This file was deleted in another tab. Edits here are no longer saved.
          {!tabView && (
            <button className="btn primary small" onClick={() => keepRef.current?.()}>
              Keep it
            </button>
          )}
          <button className="btn small" onClick={onHome}>
            Back to files
          </button>
        </div>
      )}
      {stale && !gone && (
        <div className="stale-bar" role="alert">
          This file was changed in another tab. Edits here are no longer saved.
          <button className="btn primary small" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}
      {tabBar && (
        <div className="stale-bar" role="status">
          {tabBar === "other" && "This file is open for editing in another tab."}
          {tabBar === "asking" && "Asking the other tab to let go of this file…"}
          {tabBar === "stuck" && "The other tab hasn't let go of this file. Taking over now may lose its newest edits."}
          {tabBar === "moved" && "Editing moved to another tab."}
          {tabBar === "session" && "The other tab is in a live session, so editing can't move here."}
          {tabBar === "unsaved" && "The other tab can't save right now, so it can't hand over yet."}
          {tabBar === "conflict" && "Another tab took over before these changes were saved."}
          {tabBar === "conflict" && (
            <>
              <button className="btn primary small" onClick={() => saveDtron()}>
                Download a .dtron copy
              </button>
              <button className="btn small" onClick={() => tabActions.current.discard()}>
                Discard and view
              </button>
            </>
          )}
          {tabBar === "unsaved" && (
            <button className="btn primary small" onClick={() => tabActions.current.handoff()}>
              Try again
            </button>
          )}
          {tabBar === "other" && (
            <button className="btn primary small" onClick={() => tabActions.current.handoff()}>
              Edit here instead
            </button>
          )}
          {tabBar === "moved" && (
            <button className="btn primary small" onClick={() => tabActions.current.handoff()}>
              Edit here
            </button>
          )}
          {tabBar === "stuck" && (
            <button className="btn primary small" onClick={() => tabActions.current.steal()}>
              Edit here anyway
            </button>
          )}
        </div>
      )}
      {leaveAsk && (
        <div className="stale-bar second" role="alertdialog" aria-label="Leave without saving?">
          These changes aren't saved anywhere yet. Leaving loses them.
          <button className="btn primary small" onClick={() => saveDtron()}>
            Download a .dtron copy
          </button>
          <button
            className="btn small"
            onClick={() => {
              const go = leaveAsk;
              tabRef.current.conflict = false;
              setLeaveAsk(null);
              go();
            }}
          >
            Leave anyway
          </button>
          <button className="btn small" onClick={() => setLeaveAsk(null)}>
            Stay
          </button>
        </div>
      )}
      {storageBar && !engineFailed && (
        <div className={"stale-bar" + (tabBar || gone || stale ? " second" : "")} role="alert">
          This browser can't store the file (storage is full or blocked), so your changes aren't saved.
          <button className="btn primary small" onClick={() => saveDtron()}>
            Download a .dtron copy
          </button>
        </div>
      )}
      <ShortcutsDialog />
      <ImportDialog />
      <PhoneNote />
      <DemoOverlay />
      {!readOnly && <PluginWindow />}
      <ToastLive />
    </div>
  );
}

/** The wasm engine trapped (out of memory): editing and saving have stopped. Offers a reload and a
 *  last try at a .dtron copy of what is in memory. */
function EngineFailedBar({ fileId, second = false }: { fileId: string; second?: boolean }) {
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const reload = useRef<HTMLButtonElement>(null);
  // The engine stopping is the one thing on screen that matters: focus goes to Reload.
  useEffect(() => reload.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    getFileMeta(fileId).then((m) => setSavedAt(m?.updatedAt ?? null), () => {});
  }, [fileId]);
  // The editor's own close guard may be gone (the editor unmounted): keep asking while there are
  // changes that were never stored.
  useEffect(() => {
    const ask = (e: BeforeUnloadEvent) => {
      if (!useStore.getState().dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, []);
  const time = savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const download = () => {
    try {
      saveDtron();
      return;
    } catch {
      /* the engine can't be asked: use the copy the screen holds */
    }
    try {
      const doc = lastKnownDoc();
      if (!doc) throw new Error("no copy");
      download_(`${fileSafe(doc.name || "Untitled")}.dtron`, toDtron(JSON.stringify(doc)), "application/json");
    } catch {
      showToast("Couldn't make a copy either: the editor has stopped. Reload to reopen the last save.", "error");
    }
  };
  return (
    <div className={"stale-bar engine-bar" + (second ? " second" : "")} role="alert" aria-label="The editor stopped" tabIndex={-1}>
      <span>
        The editor ran out of memory and stopped. Your file is safe up to the last save{time ? ` (${time})` : ""}. Reload to reopen it.
      </span>
      <button ref={reload} className="btn primary small" onClick={() => location.reload()}>
        Reload
      </button>
      <button className="btn small" onClick={download}>
        Try to download a .dtron
      </button>
    </div>
  );
}

/** The canvas shows its focus ring (`data-kbd-focus`) only when Tab or F6 brought focus to it:
 *  after any other key the browser would keep drawing it through every click and drag. */
function useCanvasFocusRing() {
  useEffect(() => {
    let viaTab = false;
    const canvas = () => document.getElementById("dt-canvas");
    const key = (e: KeyboardEvent) => {
      viaTab = e.key === "Tab" || e.key === "F6";
    };
    const focusin = (e: FocusEvent) => {
      const el = canvas();
      if (!el) return;
      if (e.target === el && viaTab) el.setAttribute("data-kbd-focus", "");
      else el.removeAttribute("data-kbd-focus");
    };
    const clear = () => canvas()?.removeAttribute("data-kbd-focus");
    // A click focuses the canvas too: that focus didn't come from Tab, whatever key came before.
    const pointer = () => {
      viaTab = false;
      clear();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focusin, true);
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusout", clear, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", focusin, true);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusout", clear, true);
    };
  }, []);
}

/** Frame names on the canvas must read on any page colour: pick the pair of label colours with
 *  the better contrast against the current page's background (the CSS variables are read by
 *  `.frame-label`). */
function useFrameLabelColors(ready: boolean) {
  const page = useStore((s) => s.es.page);
  useEffect(() => {
    if (!ready) return;
    const root = document.documentElement.style;
    const apply = () => {
      const doc = getDoc();
      const bg = (doc.pages.find((p) => p.id === page) ?? doc.pages[0])?.background ?? "#1a1a1a";
      const light = contrast(bg, "#595959") > contrast(bg, "#a6a6a6");
      root.setProperty("--frame-label", light ? "#595959" : "#a6a6a6");
      root.setProperty("--frame-label-selected", light ? "#0a64b5" : "#0d99ff");
      root.setProperty("--frame-label-component", light ? "#7a2bd6" : "#c4a5ff");
    };
    apply();
    const off = onDocChange(apply);
    return () => {
      off();
      for (const v of ["--frame-label", "--frame-label-selected", "--frame-label-component"]) root.removeProperty(v);
    };
  }, [ready, page]);
}

/** WCAG contrast ratio of two #rgb / #rrggbb colours (anything else counts as a dark page). */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const m = hex.match(/^#([\da-f]{6}|[\da-f]{3})/i)?.[1];
    if (!m) return 0.01;
    const full = m.length === 3 ? [...m].map((c) => c + c).join("") : m;
    const [r, g, bl] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
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
