import { useEffect, useLayoutEffect, useState } from "react";

const KEY = "dt:tour-done";

const STEPS: { selector: string; title: string; body: string }[] = [
  { selector: ".topbar .group", title: "Tools", body: "Frame (F), shapes (R, O, L), pen (P), text (T) and the hand (H, or hold Space). Click a tool, then drag on the canvas." },
  { selector: ".main > .panel:not(.right)", title: "Layers and pages", body: "Everything on the canvas, as a tree. Drag to reorder or nest, double-click to rename. Assets holds your components and styles." },
  { selector: ".panel.right", title: "Design, Prototype, Code", body: "Edit the selection's size, auto layout, colours and effects. Link screens in Prototype. Get React, HTML or CSS in Code." },
  { selector: "button[title^='Claude']", title: "Claude", body: "Describe what you want and Claude builds it on the canvas, using your Claude Code login (Pro/Max) or an API key. Shortcut: ⌘/." },
];

function done(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return true;
  }
}

/** One-time guided tour of the editor. */
export function Tour() {
  const [step, setStep] = useState(() => (done() ? -1 : 0));
  const [rect, setRect] = useState<DOMRect | null>(null);
  const finish = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* storage unavailable: the tour simply shows again next time */
    }
    setStep(-1);
  };
  useLayoutEffect(() => {
    if (step < 0) return;
    const el = document.querySelector(STEPS[step].selector);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step]);
  useEffect(() => {
    if (step < 0) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);
  if (step < 0 || !rect) return null;
  const s = STEPS[step];
  const width = 300;
  const below = rect.bottom + 180 < window.innerHeight;
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.left + rect.width / 2 - width / 2));
  const top = below ? rect.bottom + 10 : Math.max(12, rect.top - 170);
  return (
    <div className="tour-layer">
      <div className="tour-highlight" style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }} />
      <div className="tour-card" style={{ left, top, width }}>
        <div className="small muted">
          {step + 1} of {STEPS.length}
        </div>
        <div style={{ fontWeight: 600, fontSize: 14, margin: "4px 0 6px" }}>{s.title}</div>
        <div style={{ lineHeight: 1.55 }}>{s.body}</div>
        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <button className="btn" onClick={finish}>
            Skip tour
          </button>
          <button className="btn primary" onClick={() => (step + 1 < STEPS.length ? setStep(step + 1) : finish())}>
            {step + 1 < STEPS.length ? "Next" : "Start designing"}
          </button>
        </div>
      </div>
    </div>
  );
}
