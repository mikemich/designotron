import { create } from "zustand";
import { Sparkles, X } from "lucide-react";
import { TEMPLATES } from "./templates";
import { canvasSize, dispatch, getDoc, useStore, zoomToRect } from "./store";

// "Watch Claude design": a replay for visitors who haven't connected Claude yet. It builds the
// landing template (one undo step), then reveals it section by section with narration
// (clearly labelled as a replay), and points to connecting Claude for real. Sections are only
// painted invisibly while they wait (`hidden`), never hidden in the document, so leaving
// mid-replay can't save a half-shown file.

export const useDemo = create<{ caption: string | null; done: boolean; hidden: string[] }>(() => ({ caption: null, done: false, hidden: [] }));

const STEPS: [section: string | null, caption: string][] = [
  [null, "Planning a landing page for an analytics product: navigation, hero, features, pricing and a footer."],
  ["Nav", "Adding the navigation bar, laid out with auto layout so it resizes cleanly."],
  ["Hero", "Hero section: a headline, supporting copy and a call to action."],
  ["Features", "Three feature cards, all instances of one component."],
  ["Pricing", "Pricing plans, with the recommended one highlighted."],
  ["*", "Finishing with the footer, then checking spacing and contrast."],
];

/** Screen space the caption card takes at the bottom of the canvas. */
const CARD_SPACE = 190;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The replay running now; bumping it cancels (Skip, or leaving the file). */
let run = 0;

export async function playDemo() {
  const landing = TEMPLATES.find((t) => t.id === "landing");
  if (!landing) return;
  const me = ++run;
  // A file the person already named keeps its name (the template names it "Landing page").
  const name = getDoc().name;
  dispatch({ op: "beginGesture" });
  try {
    landing.build();
    if (name && name !== "Untitled") dispatch({ op: "setDocName", name });
  } finally {
    dispatch({ op: "endGesture" });
  }
  const doc = getDoc();
  const frame = Object.values(doc.nodes).find((n) => n.name === "Landing" && !n.parent);
  const sections = frame?.children ?? [];
  const byName = (name: string) => sections.filter((id) => doc.nodes[id]?.name === name);
  useDemo.setState({ caption: STEPS[0][1], done: false, hidden: sections });
  // Fit the finished page above the caption card, so every section appears in view.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!frame || run !== me) return;
      const { w, h } = canvasSize();
      zoomToRect({ x: frame.x, y: frame.y, width: frame.width, height: frame.height }, w, Math.max(200, h - CARD_SPACE));
    }),
  );
  for (const [section, caption] of STEPS) {
    if (run !== me) break;
    useDemo.setState({ caption });
    await sleep(section ? 1500 : 1800);
    if (run !== me) break;
    const ids = section === "*" ? sections : section ? byName(section) : [];
    if (ids.length) useDemo.setState((s) => ({ hidden: s.hidden.filter((id) => !ids.includes(id)) }));
  }
  if (run !== me) return;
  useDemo.setState({ hidden: [], caption: "That was a replay of what Claude does. Connect Claude and it designs whatever you describe, right here.", done: true });
}

/** Skip: show the whole page now. */
function skipDemo() {
  run++;
  useDemo.setState({ hidden: [], caption: "That was a replay of what Claude does. Connect Claude and it designs whatever you describe, right here.", done: true });
}

/** Ends any replay (the editor is closing this file). */
export function stopDemo() {
  run++;
  useDemo.setState({ caption: null, done: false, hidden: [] });
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
            <button className="btn" onClick={skipDemo}>
              <X size={13} /> Skip
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
