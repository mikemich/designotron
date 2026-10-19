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
        // Same rule as Present in the editor: the starting frame, else the first frame, else
        // the first component.
        const page = d.pages[0];
        const ofType = (t: string) => d.pages.flatMap((p) => p.children).find((id) => d.nodes[id]?.type === t);
        const flow = page?.flowStart && d.nodes[page.flowStart] ? page.flowStart : null;
        const start = flow ?? ofType("frame") ?? ofType("component");
        setState(start ? { start } : { error: "This design has no frames to show." });
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
