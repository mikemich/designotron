import { create } from "zustand";
import { Sparkles, X } from "lucide-react";
import { TEMPLATES } from "./templates";
import { dispatch, getDoc, useStore, zoomToFit } from "./store";

// "Watch Claude design": a replay for visitors who haven't connected Claude yet. It builds the
// landing template section by section with narration (clearly labelled as a replay), as one
// undo step, then points to connecting Claude for real.

export const useDemo = create<{ caption: string | null; done: boolean }>(() => ({ caption: null, done: false }));

const STEPS: [section: string | null, caption: string][] = [
  [null, "Planning a landing page for an analytics product: navigation, hero, features, pricing and a footer."],
  ["Nav", "Adding the navigation bar, laid out with auto layout so it resizes cleanly."],
  ["Hero", "Hero section: a headline, supporting copy and a call to action."],
  ["Features", "Three feature cards, all instances of one component."],
  ["Pricing", "Pricing plans, with the recommended one highlighted."],
  ["*", "Finishing with the footer, then checking spacing and contrast."],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cancelled = false;

export async function playDemo() {
  const landing = TEMPLATES.find((t) => t.id === "landing");
  if (!landing) return;
  cancelled = false;
  useDemo.setState({ caption: STEPS[0][1], done: false });
  dispatch({ op: "beginGesture" });
  try {
    landing.build();
    const doc = getDoc();
    const frame = Object.values(doc.nodes).find((n) => n.name === "Landing" && !n.parent);
    const sections = frame?.children ?? [];
    const byName = (name: string) => sections.filter((id) => doc.nodes[id]?.name === name);
    dispatch({ op: "update", ids: sections, patch: { visible: false } });
    requestAnimationFrame(() => requestAnimationFrame(zoomToFit));
    const shown = new Set<string>();
    for (const [section, caption] of STEPS) {
      if (cancelled) break;
      useDemo.setState({ caption });
      await sleep(section ? 1500 : 1800);
      const ids = section === "*" ? sections.filter((id) => !shown.has(id)) : section ? byName(section) : [];
      ids.forEach((id) => shown.add(id));
      if (ids.length) dispatch({ op: "update", ids, patch: { visible: true } });
    }
    // Skipped: show everything.
    if (sections.length) dispatch({ op: "update", ids: sections, patch: { visible: true } });
  } finally {
    dispatch({ op: "endGesture" });
  }
  useDemo.setState({ caption: "That was a replay of what Claude does. Connect Claude and it designs whatever you describe, right here.", done: true });
}

/** Caption card; blocks the canvas while the replay runs. */
export function DemoOverlay() {
  const { caption, done } = useDemo();
  if (!caption) return null;
  const close = () => useDemo.setState({ caption: null, done: false });
  return (
    <div className={"demo-layer" + (done ? " done" : "")}>
      <div className="demo-card" role="status">
        <div className="demo-who">
          <Sparkles size={13} /> Claude <span className="muted">· demo replay</span>
        </div>
        <div>{caption}</div>
        <div className="row" style={{ justifyContent: "flex-end", gap: 6, marginTop: 10 }}>
          {done ? (
            <>
              <button className="btn" onClick={close}>
                Explore the design
              </button>
              <button className="btn primary" onClick={() => (close(), useStore.setState({ chatOpen: true }))}>
                <Sparkles size={13} /> Connect Claude
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => (cancelled = true)}>
              <X size={13} /> Skip
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
