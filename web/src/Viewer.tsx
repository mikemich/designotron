import { useEffect, useState } from "react";
import { loadAssets } from "./assets";
import { Presenter } from "./Presenter";
import { startFrame } from "./prototype";
import { copyUrl, decodeFile } from "./snapshot";
import { bootEngine, dispatch, getDoc, getEngine, newEngine } from "./store";

/** View links (#/view/…) and embeds: plays the design read-only, nothing is saved. */
export function Viewer({ data }: { data: string }) {
  const [state, setState] = useState<{ start: string } | { error: string } | null>(null);
  useEffect(() => {
    (async () => {
      try {
        await bootEngine();
        const { doc, assets } = await decodeFile(data);
        loadAssets(assets);
        newEngine();
        getEngine().load(JSON.stringify(doc));
        dispatch({ op: "relayout" });
        const d = getDoc();
        // Same rule as Present in the editor, on the first page that has something to show.
        // A file with no frames at all is wrapped in one here (this copy is never saved), so
        // the page's loose layers still show.
        let start: string | null = null;
        for (const p of d.pages) start ??= startFrame(d, p.id);
        for (const pg of d.pages) {
          if (start) break;
          const visible = pg.children.filter((id) => d.nodes[id]?.visible !== false);
          const made = visible.length ? dispatch<{ id: string }>({ op: "frameSelection", ids: visible }, { quiet: true }) : null;
          if (!made?.id) continue;
          start = made.id;
          const fills = [{ type: "solid", color: pg.background, opacity: 1, visible: true }];
          dispatch({ op: "update", ids: [start], patch: { name: pg.name, fills } }, { quiet: true });
        }
        setState(start ? { start } : { error: "This design is empty." });
      } catch (err) {
        setState({ error: String(err instanceof Error ? err.message : err) });
      }
    })();
  }, [data]);
  if (!state) return <div className="empty-hint">Loading design…</div>;
  if ("error" in state)
    return (
      <div className="empty-hint">
        {state.error}{" "}
        <a href={location.pathname + "#/"} style={{ color: "var(--accent-2)" }}>
          Open Designotron
        </a>
      </div>
    );
  return <Presenter start={state.start} remixUrl={copyUrl(data)} />;
}
