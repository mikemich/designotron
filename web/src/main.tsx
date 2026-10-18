import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { bootEngine } from "./store";
import { Editor } from "./Editor";
import { Dashboard } from "./Dashboard";
import { bridge } from "./ai/bridgeClient";
import { ensureGuestFile, joinFromUrl } from "./collab";
import { isCopyLink, openCopyLink } from "./snapshot";
import { toast } from "./store";

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
      toast("This is your own copy of a shared design. Edit freely; nobody else sees your changes.");
    })
    .catch((err) => {
      history.replaceState(null, "", `${location.pathname}#/`);
      toast(String(err instanceof Error ? err.message : err), "error");
    });
}

function App() {
  const [fileId, setFileId] = useState<string | null>(route());
  useEffect(() => {
    if (isCopyLink()) openCopy();
    const on = () => (isCopyLink() ? openCopy() : setFileId(route()));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (fileId) return <Editor key={fileId} fileId={fileId} onHome={() => (location.hash = "#/")} />;
  return <Dashboard onOpen={(id) => (location.hash = `#/file/${id}`)} />;
}

const failed = (err: unknown) => {
  document.getElementById("root")!.innerHTML = `<pre style="padding:24px;color:#f88">Failed to start Designotron:\n${String(err)}</pre>`;
};
// StrictMode is intentionally off: editor effects open/close undo gestures.
const render = () => ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

if (joinFromUrl()) {
  // Opening a shared link: a local file for it (needs the engine), then the editor joins the room.
  bootEngine()
    .then(async () => {
      const shared = joinFromUrl()!;
      if (route() !== shared) await ensureGuestFile(shared);
      location.hash = `#/file/${shared}`;
      bridge.start();
      render();
    })
    .catch(failed);
} else {
  // The files dashboard doesn't need the engine: show it while the engine loads.
  render();
  bootEngine()
    .then(() => bridge.start())
    .catch(failed);
}
