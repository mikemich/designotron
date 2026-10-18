import { useEffect, useLayoutEffect, useState } from "react";
import { getDoc, useStore } from "./store";
import { MOD } from "./ui/controls";

// One-time hints that appear when they become relevant, instead of a tour up front.
// They never dim the screen or block the first-run prompt, and wait while a dialog is open.
const KEY = "dt:tour-done";

interface Hint {
  id: string;
  selector: string;
  title: string;
  body: string;
  /** When the hint becomes relevant. */
  when: () => boolean;
}

const hasLayers = () => {
  const doc = getDoc();
  const page = doc.pages.find((p) => p.id === useStore.getState().es.page) ?? doc.pages[0];
  return !!page && page.children.length > 0;
};

const HINTS: Hint[] = [
  {
    id: "layers",
    selector: ".main > .panel:not(.right)",
    title: "Layers",
    body: "Everything on this page, as a tree. Drag to reorder or nest, double-click to rename. Assets holds components and styles.",
    when: hasLayers,
  },
  {
    id: "design",
    selector: ".panel.right",
    title: "Design, Prototype, Code",
    body: "Edit the selection's size, auto layout, colours and effects. Link screens in Prototype; get React, HTML or CSS in Code.",
    when: () => useStore.getState().es.selection.length > 0,
  },
  {
    id: "claude",
    selector: "button[title^='Claude']",
    title: "Ask Claude",
    body: `Claude can design, critique and fix this file, and turn it into real code. Open it any time with ${MOD}/.`,
    when: () => hasLayers() && !useStore.getState().chatOpen,
  },
];

const seen = (id: string): boolean => {
  try {
    return localStorage.getItem(KEY) === "1" || localStorage.getItem(`dt:hint:${id}`) === "1";
  } catch {
    return true;
  }
};

export function Tour() {
  const rev = useStore((s) => s.rev);
  const selection = useStore((s) => s.es.selection);
  const chatOpen = useStore((s) => s.chatOpen);
  const [hint, setHint] = useState<Hint | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Pick the first relevant hint not seen yet, after things settle.
  useEffect(() => {
    if (hint) return;
    const t = setTimeout(() => {
      if (document.querySelector(".modal-bg, .menu")) return;
      setHint(HINTS.find((h) => !seen(h.id) && h.when()) ?? null);
    }, 1200);
    return () => clearTimeout(t);
  }, [rev, selection, chatOpen, hint]);

  useLayoutEffect(() => {
    const el = hint && document.querySelector(hint.selector);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [hint, chatOpen]);

  const dismiss = (all = false) => {
    try {
      localStorage.setItem(all ? KEY : `dt:hint:${hint!.id}`, "1");
    } catch {
      /* storage unavailable */
    }
    setHint(null);
  };

  if (!hint || !rect || rect.width === 0) return null;
  const width = 280;
  const right = hint.id === "design";
  const left = right ? rect.left - width - 12 : hint.id === "layers" ? rect.right + 12 : Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2);
  const top = hint.id === "claude" ? rect.bottom + 10 : rect.top + 60;
  return (
    <div className="hint-card" role="status" style={{ left: Math.max(12, left), top, width }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{hint.title}</div>
      <div style={{ lineHeight: 1.55 }}>{hint.body}</div>
      <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
        <button className="btn" onClick={() => dismiss(true)}>
          No more tips
        </button>
        <button className="btn primary" onClick={() => dismiss()}>
          Got it
        </button>
      </div>
    </div>
  );
}
