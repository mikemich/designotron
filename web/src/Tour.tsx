import { useEffect, useLayoutEffect, useState } from "react";
import { getDoc, useStore } from "./store";
import { MOD } from "./ui/controls";
import { useDemo } from "./Demo";

// One-time hints that appear when they become relevant, instead of a tour up front.
// They never dim the screen or block the first-run prompt, and wait while a dialog is open
// or the demo replay runs.
const KEY = "dt:tour-done";

interface Hint {
  id: string;
  selector: string;
  title: string;
  body: string;
  /** When the hint becomes relevant. */
  when: () => boolean;
}

/** True while a shown hint still applies. The Claude hint ends once the panel is open (opening it
 *  was the lesson); the others end when their condition stops holding. */
export function stillRelevant(hint: Pick<Hint, "id" | "when">, chatOpen: boolean): boolean {
  if (hint.id === "claude" && chatOpen) return false;
  return hint.when();
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
    body: `Claude can design, critique and fix this file, and turn it into real code. Open it any time with ${MOD}/. Needs Claude Code (Pro or Max) or an API key; the panel shows how.`,
    when: () => hasLayers() && !useStore.getState().chatOpen,
  },
];

const RESET_EVENT = "dt:tips-reset";

/** Help, Show tips again: forgets which hints were seen and dismissed, so they come back as they become relevant. */
export function resetTips() {
  try {
    localStorage.removeItem(KEY);
    for (const h of HINTS) localStorage.removeItem(`dt:hint:${h.id}`);
  } catch {
    /* storage unavailable: the hints that were dismissed stay dismissed */
  }
  window.dispatchEvent(new Event(RESET_EVENT));
}

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
  const demo = useDemo((s) => s.caption !== null);
  const [hint, setHint] = useState<Hint | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // Bumped by "Show tips again" so the next hint is picked even though nothing else changed.
  const [reset, setReset] = useState(0);
  useEffect(() => {
    const on = () => setReset((n) => n + 1);
    window.addEventListener(RESET_EVENT, on);
    return () => window.removeEventListener(RESET_EVENT, on);
  }, []);

  // A shown hint goes as soon as it no longer applies. Opening Claude counts as having seen its hint.
  useEffect(() => {
    if (!hint || stillRelevant(hint, chatOpen)) return;
    if (hint.id === "claude") {
      try {
        localStorage.setItem(`dt:hint:${hint.id}`, "1");
      } catch {
        /* storage unavailable */
      }
    }
    setHint(null);
  }, [hint, rev, selection, chatOpen]);

  // Pick the first relevant hint not seen yet, after things settle.
  useEffect(() => {
    if (hint || demo) return;
    const t = setTimeout(() => {
      if (document.querySelector(".modal-bg, .menu")) return;
      setHint(HINTS.find((h) => !seen(h.id) && h.when()) ?? null);
    }, 1200);
    return () => clearTimeout(t);
  }, [rev, selection, chatOpen, hint, demo, reset]);

  useLayoutEffect(() => {
    const measure = () => {
      const el = hint && document.querySelector(hint.selector);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [hint, chatOpen]);

  const dismiss = (all = false) => {
    try {
      localStorage.setItem(all ? KEY : `dt:hint:${hint!.id}`, "1");
    } catch {
      /* storage unavailable */
    }
    setHint(null);
  };

  if (!hint || !rect || rect.width === 0 || demo) return null;
  const width = 280;
  let style: React.CSSProperties;
  if (hint.id === "layers") {
    // Inside the layers panel, at its foot: it never covers the design.
    style = { left: rect.left + 8, bottom: window.innerHeight - rect.bottom + 12, width: Math.min(width, rect.width - 16) };
  } else {
    const left = hint.id === "design" ? rect.left - width - 12 : Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2);
    const top = hint.id === "claude" ? rect.bottom + 10 : rect.top + 60;
    style = { left: Math.max(12, Math.min(left, window.innerWidth - width - 12)), top: Math.min(top, window.innerHeight - 180), width };
  }
  return (
    <div className="hint-card" role="status" style={style}>
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
