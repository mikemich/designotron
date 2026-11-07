import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { bootEngine } from "./store";
import { Editor, leaveGuard } from "./Editor";
import { Dashboard } from "./Dashboard";
import { bridge } from "./ai/bridgeClient";
import { ensureGuestFile, joinFromUrl } from "./collab";
import { isCopyLink, isViewLink, openCopyLink } from "./snapshot";
import { Viewer } from "./Viewer";
import { toast } from "./store";
import { isPhone } from "./panels/PhoneNote";

function route(): string | null {
  const m = location.hash.match(/^#\/file\/(\w+)/);
  return m ? m[1] : null;
}

/** A copy link (#/copy/…) becomes the visitor's own file, then opens it. */
function openCopy() {
  openCopyLink()
    .then((id) => {
      history.replaceState(null, "", `${location.pathname}#/file/${id}`);
      dispatchEvent(new HashChangeEvent("hashchange"));
      toast(
        isPhone()
          ? "This is your own copy of a shared design; nobody else sees your changes. Open it on a computer to edit it fully."
          : "This is your own copy of a shared design. Edit freely; nobody else sees your changes.",
      );
    })
    .catch((err) => {
      history.replaceState(null, "", `${location.pathname}#/`);
      toast(String(err instanceof Error ? err.message : err), "error");
    });
}

const viewData = () => (isViewLink() ? location.hash.slice("#/view/".length) : null);

function App() {
  const [fileId, setFileId] = useState<string | null>(route());
  const [view, setView] = useState(viewData());
  useEffect(() => {
    if (isCopyLink()) openCopy();
    let at = location.hash;
    const on = () => {
      // An editor holding changes that are kept only on screen asks first: put the address back.
      const next = location.hash;
      if (next !== at && leaveGuard.ask?.(() => (location.hash = next))) {
        history.replaceState(null, "", location.pathname + location.search + at);
        return;
      }
      at = next;
      setView(viewData());
      if (isCopyLink()) openCopy();
      else setFileId(route());
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (view) return <Viewer key={view} data={view} />;
  if (fileId) return <Editor key={fileId} fileId={fileId} onHome={() => (location.hash = "#/")} />;
  return <Dashboard onOpen={(id) => (location.hash = `#/file/${id}`)} />;
}

// A file dropped outside the canvas and the dashboard would make the browser open or download it,
// taking the visitor out of the app. The canvas and the dashboard handle their own drops first.
const carriesFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => {
    if (!e.defaultPrevented && carriesFiles(e)) {
      e.preventDefault();
      // Nothing here takes the file: show the pointer as such.
      if (type === "dragover" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
    }
  });
}

// Only for shared links, which can't show anything without the engine.
const failed = (err: unknown) => {
  document.getElementById("root")!.innerHTML = `<div style="padding:32px;color:#e6e6e6;font:14px Inter,system-ui,sans-serif;line-height:1.6">The editor engine couldn't load (${String(err).replace(/[<&]/g, "")}).<br>Check your connection and try again.<br><button onclick="location.reload()" style="margin-top:12px;padding:6px 14px;border-radius:6px;border:0;background:#6d4aff;color:#fff;font:inherit">Retry</button></div>`;
};
// StrictMode is intentionally off: editor effects open/close undo gestures.
const render = () => ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

// The editor must not run inside a plugin's frame: local installs serve it on the localhost origins
// the editor's frame-src allows, so a plugin could navigate its frame to it. A sandboxed frame
// without allow-same-origin (opaque origin) gets an empty page: no engine, no rooms, no bridge.
const inOpaqueFrame = window !== window.top && window.origin === "null";

if (inOpaqueFrame) {
  document.getElementById("root")!.textContent = "";
} else if (joinFromUrl()) {
  // Opening a shared link: a local file for it (needs the engine), then the editor joins the room.
  bootEngine()
    .then(async () => {
      const shared = joinFromUrl()!;
      if (route() !== shared) await ensureGuestFile(shared);
      // Replace (not push) so Back doesn't return to a bare ?room= page that would join again.
      history.replaceState(null, "", `${location.pathname}${location.search}#/file/${shared}`);
      bridge.start();
      render();
    })
    .catch(failed);
} else {
  // The files dashboard doesn't need the engine: show it while the engine loads.
  render();
  // A failure shows a Retry banner on the dashboard (useBoot), so it isn't fatal here.
  bootEngine()
    .then(() => bridge.start())
    .catch(() => {});
}
