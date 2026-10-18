import { useRef, useState } from "react";
import { FileJson, Loader2, X } from "lucide-react";
import { getDoc, useStore, toast } from "../store";
import { deleteFile } from "../files";
import { importFigmaJson, importFigmaUrl, type ImportResult } from "../figma";
import { useDialog } from "../ui/controls";

const TOKEN_KEY = "dt:figmaToken";
const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};

/** File → Import from Figma: a file link plus a personal access token, or a saved JSON export. */
export function FigmaImportDialog() {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState(readToken);
  const [remember, setRemember] = useState(!!readToken());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const close = async () => {
    const { figmaOpen, fileId } = useStore.getState();
    useStore.setState({ figmaOpen: false });
    // Cancelled from the dashboard: don't leave an empty "Untitled" file behind.
    if (figmaOpen === "new" && fileId && getDoc().pages.every((p) => p.children.length === 0)) {
      await deleteFile(fileId);
      location.hash = "#/";
    }
  };
  const dialogRef = useDialog(close);

  const finish = (r: ImportResult) => {
    setResult(r);
    setBusy(null);
    toast(`Imported ${r.layers} layers from Figma`);
    if (!r.warnings.length) close();
  };
  const run = async () => {
    setError(null);
    try {
      if (remember) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    try {
      finish(await importFigmaUrl(url.trim(), token.trim(), setBusy));
    } catch (e) {
      setBusy(null);
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  const fromFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      finish(importFigmaJson(JSON.parse(await f.text())));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} className="modal figma-dialog" role="dialog" aria-modal="true" aria-label="Import from Figma" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Import from Figma</b>
          <button className="ibtn" title="Close" onClick={close} style={{ marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
        <div className="figma-body">
          {result ? (
            <>
              <p>
                Imported {result.layers} layers into {result.pages.length} page{result.pages.length === 1 ? "" : "s"}.
              </p>
              {result.warnings.length > 0 && (
                <ul className="small muted">
                  {[...new Set(result.warnings)].slice(0, 12).map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <button className="btn primary" onClick={close}>
                Done
              </button>
            </>
          ) : (
            <>
              <label className="small muted">Figma file or frame link</label>
              <input className="textinput" placeholder="https://www.figma.com/design/…" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
              <label className="small muted" style={{ marginTop: 10 }}>
                Personal access token{" "}
                <a href="https://www.figma.com/developers/api#access-tokens" target="_blank" rel="noreferrer">
                  (how to get one)
                </a>
              </label>
              <input className="textinput" type="password" placeholder="figd_…" value={token} onChange={(e) => setToken(e.target.value)} />
              <label className="row small" style={{ gap: 6, marginTop: 6 }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember the token in this browser
              </label>
              <div className="muted small" style={{ marginTop: 8, lineHeight: 1.6 }}>
                Frames, auto layout, components and instances (with overrides), text styles, vectors, images, effects and prototype links come across. The token is only sent to Figma.
              </div>
              {error && <div className="error-box">{error}</div>}
              <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
                <button className="btn" onClick={() => fileRef.current?.click()} title="A file saved from GET /v1/files/:key?geometry=paths">
                  <FileJson size={13} /> Open JSON export…
                </button>
                <button className="btn primary" disabled={!url.trim() || !token.trim() || !!busy} onClick={run}>
                  {busy ? (
                    <>
                      <Loader2 size={13} className="spin" /> {busy}
                    </>
                  ) : (
                    "Import"
                  )}
                </button>
              </div>
              <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => fromFile(e.target.files?.[0])} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
