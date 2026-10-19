import { useState } from "react";
import { create } from "zustand";
import { Loader2, X } from "lucide-react";
import { canvasSize, dispatch, getDoc, toast, zoomToRect } from "../store";
import { viewportCenter } from "../actions";
import { useDialog } from "../ui/controls";

export const useImport = create<{ open: boolean }>(() => ({ open: false }));

/** Main menu → Import website or HTML: a live page (through the bridge) or pasted HTML. */
export function ImportDialog() {
  const open = useImport((s) => s.open);
  const [url, setUrl] = useState("");
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => useImport.setState({ open: false });
  const dialogRef = useDialog(close, open);
  if (!open) return null;
  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const tools = await import("../ai/browserTools");
      const c = viewportCenter();
      const width = url.trim() ? 1440 : 1280;
      const at = { x: Math.round(c.x - width / 2), y: Math.round(c.y), width };
      const r = url.trim() ? await tools.importUrl({ url: url.trim(), ...at }, true) : await tools.importHtml({ html, ...at });
      // Show the top of the page across the view, selected.
      const id: string | undefined = r?.created?.[0]?.id;
      const frame = id ? getDoc().nodes[id] : undefined;
      if (frame) {
        dispatch({ op: "select", ids: [frame.id] });
        const { w, h } = canvasSize();
        zoomToRect({ x: frame.x, y: frame.y, width: frame.width, height: Math.min(frame.height, frame.width * (h / Math.max(w, 1))) }, w, h);
      }
      toast("Imported as layers");
      close();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e).replace(/^./, (c) => c.toUpperCase()));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} className="modal share-dialog" role="dialog" aria-modal="true" aria-label="Import website or HTML" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Import website or HTML</b>
          <button className="ibtn" title="Close" onClick={close} style={{ marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
        <div className="figma-body">
          <label className="small muted">Website address (needs the Designotron bridge on this computer)</label>
          <input className="textinput" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
          <label className="small muted" style={{ marginTop: 8 }}>
            Or paste HTML (inline styles or a &lt;style&gt; block)
          </label>
          <textarea className="textinput mono" rows={6} value={html} onChange={(e) => setHtml(e.target.value)} disabled={!!url.trim()} placeholder="<div style=&quot;padding:24px&quot;>…</div>" />
          {error && <div className="error-box">{error}</div>}
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || (!url.trim() && !html.trim())} onClick={run}>
              {busy && <Loader2 size={13} className="spin" />} Import as layers
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
