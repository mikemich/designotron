import { useEffect, useId, useRef, useState } from "react";
import { FileJson, Loader2, X } from "lucide-react";
import { useStore, toast } from "../store";
import { plainError } from "../errors";
import { checkFigmaJson, fetchFigmaUrl, figmaFileName, importFigmaJson, importFigmaUrl, type ImportResult } from "../figma";
import { useDialog } from "../ui/controls";

const TOKEN_KEY = "dt:figmaToken";
const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};

/** The data an import dialog on the dashboard hands over: the new file is created from it. */
export type FigmaSource = { file: unknown; images: Record<string, string> };

/** File → Import from Figma: a file link plus a personal access token, or a saved JSON export.
 *  On the dashboard (`onCreate` given) nothing exists yet: Import fetches the data and creates the
 *  file named after the Figma file, which the editor then fills. Cancel just closes. */
export function FigmaImportDialog({ onCreate }: { onCreate?: (src: FigmaSource, name?: string) => Promise<boolean> }) {
  /** Set by closing: an import still being fetched is dropped when it arrives (nothing is created). */
  const closed = useRef(false);
  /** From the moment the file is being made: closing would race the new file opening, so it waits. */
  const creating = useRef(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState(readToken);
  const [remember, setRemember] = useState(!!readToken());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(() => (onCreate ? null : useStore.getState().figmaResult));
  const fileRef = useRef<HTMLInputElement>(null);
  const urlId = useId();
  const tokenId = useId();
  const close = async () => {
    if (creating.current) return;
    closed.current = true;
    useStore.setState({ figmaOpen: false, figmaResult: null });
  };
  // Leaving the dashboard with the dialog open (browser Back, a link) ends it: it must not follow the
  // person into the editor, and an import still being fetched is dropped.
  useEffect(
    () => () => {
      if (!onCreate) return;
      closed.current = true;
      if (useStore.getState().figmaOpen === "new") useStore.setState({ figmaOpen: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const dialogRef = useDialog(close);

  const finish = (r: ImportResult) => {
    setResult(r);
    setBusy(null);
    toast(`Imported ${r.layers} layers from Figma`);
    if (!r.warnings.length) close();
  };
  /** Dashboard mode: the file is made from what was fetched, and the dialog goes with the dashboard. */
  const create = async (src: FigmaSource, name?: string) => {
    if (closed.current) return;
    checkFigmaJson(src.file);
    setBusy("Creating the file…");
    creating.current = true;
    try {
      if (await onCreate!(src, name)) useStore.setState({ figmaOpen: false });
      else {
        setBusy(null);
        setError("Couldn't create the file.");
      }
    } finally {
      creating.current = false;
    }
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
      if (onCreate) {
        const src = await fetchFigmaUrl(url.trim(), token.trim(), (m) => !closed.current && setBusy(m));
        if (closed.current) return;
        await create(src, figmaFileName(src.file));
      } else finish(await importFigmaUrl(url.trim(), token.trim(), setBusy));
    } catch (e) {
      if (closed.current) return;
      setBusy(null);
      setError(plainError(e));
    }
  };
  const fromFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const json = JSON.parse(await f.text());
      if (onCreate) await create({ file: json, images: {} }, figmaFileName(json) ?? (f.name.replace(/\.json$/i, "").trim() || undefined));
      else {
        checkFigmaJson(json);
        finish(importFigmaJson(json));
      }
    } catch (e) {
      setError(plainError(e, { json: "That file isn't a Figma JSON export: it isn't valid JSON." }));
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
              <label className="small muted" htmlFor={urlId}>
                Figma file or frame link
              </label>
              <input id={urlId} className="textinput" placeholder="https://www.figma.com/design/…" value={url} onChange={(e) => setUrl(e.target.value)} />
              <label className="small muted" style={{ marginTop: 10 }} htmlFor={tokenId}>
                Personal access token{" "}
                <a href="https://www.figma.com/developers/api#access-tokens" target="_blank" rel="noreferrer">
                  (how to get one)
                </a>
              </label>
              <input id={tokenId} className="textinput" type="password" placeholder="figd_…" value={token} onChange={(e) => setToken(e.target.value)} />
              <label className="row small" style={{ gap: 6, marginTop: 6 }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember the token in this browser
              </label>
              <div className="muted small" style={{ marginTop: 8, lineHeight: 1.6 }}>
                Frames, auto layout, components and instances (with overrides), text styles, vectors, images, effects and prototype links come across. The token is only sent to Figma.
              </div>
              {error && <div className="error-box">{error}</div>}
              <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
                <button className="btn" disabled={!!busy} onClick={() => fileRef.current?.click()} title="A file saved from GET /v1/files/:key?geometry=paths">
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
