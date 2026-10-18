import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { bootEngine } from "./store";
import { Editor } from "./Editor";
import { Dashboard } from "./Dashboard";
import { bridge } from "./ai/bridgeClient";
import { ensureGuestFile, joinFromUrl } from "./collab";

function route(): string | null {
  const m = location.hash.match(/^#\/file\/(\w+)/);
  return m ? m[1] : null;
}

function App() {
  const [fileId, setFileId] = useState<string | null>(route());
  useEffect(() => {
    const on = () => setFileId(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (fileId) return <Editor key={fileId} fileId={fileId} onHome={() => (location.hash = "#/")} />;
  return <Dashboard onOpen={(id) => (location.hash = `#/file/${id}`)} />;
}

bootEngine()
  .then(async () => {
    // Opening a shared link: a local file for it, then the editor joins the room.
    const shared = joinFromUrl();
    if (shared) {
      if (route() !== shared) await ensureGuestFile(shared);
      location.hash = `#/file/${shared}`;
    }
    bridge.start();
    // StrictMode is intentionally off: editor effects open/close undo gestures.
    ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
  })
  .catch((err) => {
    document.getElementById("root")!.innerHTML = `<pre style="padding:24px;color:#f88">Failed to start Designotron:\n${String(err)}</pre>`;
  });
