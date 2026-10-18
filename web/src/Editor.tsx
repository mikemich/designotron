import { useEffect, useState } from "react";
import { Canvas } from "./canvas/Canvas";
import { LeftPanel } from "./panels/LeftPanel";
import { RightPanel } from "./panels/RightPanel";
import { Toolbar } from "./panels/Toolbar";
import { ChatPanel } from "./ai/ChatPanel";
import { Presenter } from "./Presenter";
import { Tour } from "./Tour";
import { VariablesDialog } from "./panels/VariablesDialog";
import { FigmaImportDialog } from "./panels/FigmaImportDialog";
import { PluginWindow, PluginsDialog } from "./panels/PluginsDialog";
import { usePlugins } from "./plugins";
import { joinShared, stopSharing, useCollab } from "./collab";
import { ShareDialog } from "./panels/ShareDialog";
import { installShortcuts } from "./shortcuts";
import { getDoc, getEngine, newEngine, onDocChange, useStore, zoomToFit, dispatch } from "./store";
import { listVersions, loadFile, saveFile, saveVersion } from "./files";
import { AUTO_VERSION_MS } from "./panels/HistoryPanel";
import { nodeSvg, svgToPngBlob } from "./exporter";
import { readFileAsDataUrl } from "./assets";

export function Editor({ fileId, onHome }: { fileId: string; onHome: () => void }) {
  const chatOpen = useStore((s) => s.chatOpen);
  const presenting = useStore((s) => s.presenting);
  const toast = useStore((s) => s.toast);
  const variablesOpen = useStore((s) => s.variablesOpen);
  const figmaOpen = useStore((s) => s.figmaOpen);
  const pluginsOpen = usePlugins((s) => s.dialogOpen);
  const shareOpen = useCollab((s) => s.dialogOpen);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const json = await loadFile(fileId);
      if (cancelled) return;
      newEngine();
      if (json) {
        try {
          getEngine().load(json);
        } catch (err) {
          console.error(err);
        }
      }
      dispatch({ op: "relayout" });
      useStore.setState({ fileId, dirty: false, editingText: null, editingVector: null, presenting: null });
      setReady(true);
      requestAnimationFrame(zoomToFit);
      joinShared();
    })();
    return () => {
      cancelled = true;
      // Leaving the file leaves its shared session.
      if (useCollab.getState().role) stopSharing();
    };
  }, [fileId]);

  useEffect(() => installShortcuts(), []);

  // Autosave to IndexedDB, with an occasional thumbnail.
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastThumb = 0;
    let lastVersion = Date.now();
    listVersions(fileId).then((v) => (lastVersion = v[0]?.createdAt ?? 0));
    const save = async () => {
      const json = getEngine().save();
      const doc = getDoc();
      let thumb: string | undefined;
      if (Date.now() - lastThumb > 15000) {
        lastThumb = Date.now();
        thumb = await thumbnail().catch(() => undefined);
      }
      await saveFile(fileId, doc.name, json, thumb);
      useStore.setState({ dirty: false });
      if (Date.now() - lastVersion > AUTO_VERSION_MS) {
        lastVersion = Date.now();
        await saveVersion(fileId, "Autosave", json, true);
      }
    };
    const off = onDocChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, 700);
    });
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) {
        save();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      off();
      if (timer) {
        clearTimeout(timer);
        save();
      }
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [ready, fileId]);

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
      <PluginWindow />
      {toast && <div className={"toast " + toast.kind}>{toast.text}</div>}
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
