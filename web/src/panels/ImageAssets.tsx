import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { assetUrl } from "../assets";
import { placeImageSource } from "../actions";
import { safeImageSrc } from "../imageSrc";
import { imagesIn, isAssetSrc, type ImageEntry } from "../imageAssets";
import { dispatch, getDoc, useStore } from "../store";
import { IconButton } from "../ui/controls";

/** Pictures the file uses (image fills), one row per source: thumbnail, layers using it, and Place.
 *  Mounted only while the Assets tab shows; the list follows the document 300 ms after it stops changing. */
export function ImageAssets({ filter }: { filter: string }) {
  const docRev = useStore((s) => s.es.docRev);
  const selection = useStore((s) => s.es.selection);
  const [entries, setEntries] = useState<ImageEntry[]>(() => imagesIn(getDoc(), null));
  useEffect(() => {
    const t = setTimeout(() => setEntries(imagesIn(getDoc(), null)), 300);
    return () => clearTimeout(t);
  }, [docRev]);
  const q = filter.trim().toLowerCase();
  const shown = q ? entries.filter((e) => e.uses.some((u) => u.name.toLowerCase().includes(q))) : entries;
  const thumb = (src: string) => (!safeImageSrc(src) ? "" : isAssetSrc(src) ? assetUrl(src.slice(6)) ?? "" : src);

  /** Selects the layers using the picture on this page, or goes to the first page that has one. */
  const select = (e: ImageEntry) => {
    const page = useStore.getState().es.page;
    const here = e.uses.filter((u) => u.page === page);
    const uses = here.length ? here : e.uses.filter((u) => u.page === e.uses[0].page);
    if (!here.length) dispatch({ op: "setPage", id: e.uses[0].page });
    dispatch({ op: "select", ids: uses.map((u) => u.id) });
  };

  return (
    <div className="section image-assets" data-testid="image-assets">
      <div className="section-head">
        <span>Images</span>
      </div>
      {entries.length === 0 && <div className="muted small">Images in this file show here.</div>}
      {entries.length > 0 && shown.length === 0 && <div className="muted small">No image layer matches.</div>}
      {shown.map((e) => {
        const on = selection.length > 0 && e.uses.some((u) => selection.includes(u.id));
        const name = e.uses[0].name;
        return (
          <div
            key={e.src}
            className={"image-asset" + (on ? " on" : "")}
            data-image-src={e.src}
            data-count={e.count}
            draggable
            onDragStart={(ev) => ev.dataTransfer.setData("application/x-designotron-image", e.src)}
          >
            <button
              type="button"
              className="image-main"
              aria-pressed={on}
              onClick={() => select(e)}
              title={"Select the layers that use it. Drag it onto the canvas, or use + to place a copy" + (e.credit ? `\nPhoto: ${e.credit.title || "untitled"} by ${e.credit.author} (${e.credit.license})` : "")}
            >
              <span className="image-thumb" style={thumb(e.src) ? { backgroundImage: `url("${thumb(e.src)}")` } : undefined} />
              <span className="image-meta">
                <span className="name">{name}</span>
                <span className="muted">
                  {e.count === 1 ? "1 layer" : `${e.count} layers`}
                  {e.credit ? ` · ${e.credit.author}` : ""}
                </span>
              </span>
            </button>
            <IconButton title="Place at its own size" onClick={() => void placeImageSource(e.src, undefined, undefined, name)}>
              <Plus size={14} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
