import { useEffect, useState } from "react";
import { loadAssets } from "./assets";
import { Presenter } from "./Presenter";
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
        const frames = d.pages.flatMap((p) => p.children).filter((id) => ["frame", "component"].includes(d.nodes[id]?.type));
        setState(frames[0] ? { start: frames[0] } : { error: "This design has no frames to show." });
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
