import { useCallback, useEffect, useRef, useState } from "react";
import { bootEngine, resolveAssets } from "../store";
import { WasmEngine } from "../wasm/pkg/designotron_engine_wasm";
import { loadVersion, type Version } from "../files";
import { useDialog } from "../ui/controls";

/** Zoom limits of the preview (a view of one version, not the canvas). */
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 32;
/** Fit never enlarges past this, so a small frame doesn't fill the dialog. */
const MAX_FIT = 4;

interface PageInfo {
  id: string;
  name: string;
  children: string[];
}
interface Rendered {
  svg: string;
  box: [number, number, number, number] | null;
}
interface View {
  s: number;
  x: number;
  y: number;
}

/** Draws one page of a stored version with a throwaway engine, so the open document, its
 *  selection, undo history and autosave are never touched. */
async function renderVersionPage(json: string, page: string): Promise<Rendered> {
  await bootEngine();
  const probe = new WasmEngine(1);
  try {
    probe.load(json);
    const svg = resolveAssets(probe.render(page, "", ""));
    const doc = JSON.parse(json) as { pages?: PageInfo[] };
    const roots = doc.pages?.find((p) => p.id === page)?.children ?? [];
    let box: Rendered["box"] = null;
    if (roots.length) {
      const r = JSON.parse(probe.query(JSON.stringify({ q: "bounds", ids: roots }))) as { union: { x: number; y: number; width: number; height: number } | null };
      if (r.union) box = [r.union.x, r.union.y, r.union.width, r.union.height];
    }
    return { svg, box };
  } finally {
    probe.free();
  }
}

/** A read-only look at a saved version: the page drawn and fitted, zoom and pan, with Restore,
 *  Duplicate as file and Close. */
export function VersionPreview(props: { fileId: string; version: Version; label: string; onRestore: () => void; onDuplicate: () => void; onClose: () => void }) {
  const { fileId, version, label } = props;
  const ref = useDialog(props.onClose);
  const stage = useRef<HTMLDivElement>(null);
  const [json, setJson] = useState<string | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [page, setPage] = useState("");
  const [failed, setFailed] = useState(false);
  const [out, setOut] = useState<Rendered | null>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const boxRef = useRef<Rendered["box"]>(null);
  boxRef.current = out?.box ?? null;

  useEffect(() => {
    let live = true;
    loadVersion(fileId, version.id).then(
      (j) => {
        if (!live) return;
        try {
          if (!j) throw new Error("missing");
          const ps = ((JSON.parse(j) as { pages?: PageInfo[] }).pages ?? []).map((p) => ({ id: p.id, name: p.name, children: p.children }));
          if (!ps.length) throw new Error("no pages");
          setPages(ps);
          setPage(ps[0].id);
          setJson(j);
        } catch {
          setFailed(true);
        }
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [fileId, version.id]);

  const fit = useCallback((box: Rendered["box"]) => {
    const el = stage.current;
    if (!el || !box) return;
    const { width: vw, height: vh } = el.getBoundingClientRect();
    const s = Math.min(MAX_FIT, Math.max(MIN_ZOOM, Math.min((vw - 48) / Math.max(box[2], 1), (vh - 48) / Math.max(box[3], 1))));
    setView({ s, x: (vw - box[2] * s) / 2 - box[0] * s, y: (vh - box[3] * s) / 2 - box[1] * s });
  }, []);

  useEffect(() => {
    if (json === null || !page) return;
    let live = true;
    setOut(null);
    // Let "Rendering…" paint before the (synchronous) load and draw.
    const t = setTimeout(() => {
      renderVersionPage(json, page).then(
        (r) => {
          if (!live) return;
          setOut(r);
          requestAnimationFrame(() => live && fit(r.box));
        },
        () => live && setFailed(true),
      );
    }, 30);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [json, page, fit]);

  // Ctrl/Cmd+wheel zooms around the pointer; a plain wheel pans. (Native listener: React's is passive.)
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.s * Math.exp(-e.deltaY * 0.01)));
        setView({ s, x: px - ((px - v.x) / v.s) * s, y: py - ((py - v.y) / v.s) * s });
      } else {
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [json, failed]);

  const drag = useRef<{ x: number; y: number } | null>(null);
  const when = new Date(version.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} className="modal version-preview" role="dialog" aria-modal="true" aria-label={`Preview of ${label}`}>
        <div className="modal-head vp-head">
          <div className="vp-title">
            <b>{label}</b>
            <span className="muted small">{when} · Read-only</span>
          </div>
          {pages.length > 1 && (
            <select className="select" aria-label="Page" value={page} onChange={(e) => setPage(e.target.value)}>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn" onClick={() => fit(out?.box ?? null)} disabled={!out?.box}>
            Fit
          </button>
        </div>
        <div
          ref={stage}
          className="vp-stage"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            drag.current = { x: e.clientX, y: e.clientY };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            drag.current = { x: e.clientX, y: e.clientY };
            setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {failed ? (
            <div className="vp-note" role="alert">
              This version couldn't be opened
            </div>
          ) : !out ? (
            <div className="vp-note" role="status">
              Rendering…
            </div>
          ) : !out.box ? (
            <div className="vp-note">This page is empty</div>
          ) : (
            <svg className="vp-svg" role="img" aria-label={`${label}, read-only preview`} width="100%" height="100%">
              <g transform={`translate(${view.x} ${view.y}) scale(${view.s})`} dangerouslySetInnerHTML={{ __html: out.svg }} />
            </svg>
          )}
        </div>
        <div className="confirm-actions vp-actions">
          <span className="muted small vp-hint">Ctrl or ⌘ and scroll to zoom, drag to pan</span>
          <button className="btn" onClick={props.onDuplicate} disabled={failed}>
            Duplicate as file
          </button>
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
          <button className="btn primary" onClick={props.onRestore} disabled={failed}>
            Restore this version
          </button>
        </div>
      </div>
    </div>
  );
}
