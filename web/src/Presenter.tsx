import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { getDoc, query, toast, useStore } from "./store";
import { nodeSvg } from "./exporter";
import type { Interaction, Rect } from "./types";
import { REPO_URL } from "./panels/GuestBar";

interface Hotspot {
  id: string;
  rect: Rect;
  interactions: Interaction[];
}

/** Prototype player: renders a frame and turns interactions into hotspots. With `remixUrl` it
 *  is the view-only player for view links and embeds: no close, a Remix button instead. */
export function Presenter({ start, remixUrl }: { start: string; remixUrl?: string }) {
  const [history, setHistory] = useState<{ id: string; transition: Interaction["transition"] }[]>([{ id: start, transition: "instant" }]);
  const [flash, setFlash] = useState(false);
  const current = history[history.length - 1];
  const doc = getDoc();
  const frame = doc.nodes[current.id];
  const frames = useMemo(() => {
    const page = doc.pages.find((p) => p.id === frame?.page);
    return (page?.children ?? []).filter((id) => ["frame", "component"].includes(doc.nodes[id]?.type));
  }, [current.id]);

  const svg = useMemo(() => (frame ? nodeSvg(frame.id) : ""), [current.id]);
  const hotspots = useMemo<Hotspot[]>(() => {
    if (!frame) return [];
    const ids = Object.values(doc.nodes)
      .filter((n) => n.interactions.length && (n.id === frame.id || isDescendant(n.id, frame.id)))
      .map((n) => n.id);
    const fb = query<{ union: Rect }>({ q: "bounds", ids: [frame.id] }).union;
    const items = query<{ items: { id: string; bounds: Rect }[] }>({ q: "bounds", ids }).items;
    return items.map((it) => ({
      id: it.id,
      rect: { x: it.bounds.x - fb.x, y: it.bounds.y - fb.y, width: it.bounds.width, height: it.bounds.height },
      interactions: doc.nodes[it.id].interactions,
    }));
  }, [current.id]);

  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!frame) return;
    const fit = () => setScale(Math.min(1, (window.innerWidth - 80) / frame.width, (window.innerHeight - 100) / frame.height));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [current.id]);

  const go = (it: Interaction) => {
    if (it.action === "back") setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
    else if (it.action === "openUrl" && it.url) {
      const url = safeLink(it.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else toast("This prototype link isn't a web, email or phone link, so it wasn't opened", "error");
    }
    else if (it.action === "navigate" && it.destination && doc.nodes[it.destination]) setHistory((h) => [...h, { id: it.destination!, transition: it.transition }]);
  };

  // Delayed interactions on the frame itself.
  useEffect(() => {
    const delayed = frame?.interactions.find((i) => i.trigger === "afterDelay");
    if (!delayed) return;
    const t = setTimeout(() => go(delayed), delayed.delayMs || 800);
    return () => clearTimeout(t);
  }, [current.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !remixUrl) useStore.setState({ presenting: null });
      const i = frames.indexOf(current.id);
      if (e.key === "ArrowRight" && i < frames.length - 1) setHistory((h) => [...h, { id: frames[i + 1], transition: "slideLeft" }]);
      if (e.key === "ArrowLeft" && i > 0) setHistory((h) => [...h, { id: frames[i - 1], transition: "slideRight" }]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current.id, frames]);

  if (!frame) return null;
  const anim: Record<string, string> = {
    dissolve: "dt-dissolve",
    smartAnimate: "dt-dissolve",
    slideLeft: "dt-slide-left",
    slideRight: "dt-slide-right",
    slideUp: "dt-slide-up",
    slideDown: "dt-slide-down",
  };
  const a = anim[current.transition];
  return (
    <div className="presenter" onClick={() => !hotspots.length || (setFlash(true), setTimeout(() => setFlash(false), 400))}>
      <div className="bar" onClick={(e) => e.stopPropagation()}>
        <button className="tbtn" title="Previous frame" onClick={() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h))}>
          <ChevronLeft size={16} />
        </button>
        <span className="muted" style={{ padding: "0 8px" }}>
          {frame.name}
        </span>
        <button className="tbtn" title="Next frame" onClick={() => {
          const i = frames.indexOf(current.id);
          if (i < frames.length - 1) setHistory((h) => [...h, { id: frames[i + 1], transition: "slideLeft" }]);
        }}>
          <ChevronRight size={16} />
        </button>
        {remixUrl ? (
          <>
            <a className="btn primary remix" href={remixUrl} target="_blank" rel="noopener" title="Open your own editable copy in Designotron">
              Remix
            </a>
            <a className="made-with" href={REPO_URL} target="_blank" rel="noopener">
              Made with Designotron
            </a>
          </>
        ) : (
          <button className="tbtn" title="Close (Esc)" onClick={() => useStore.setState({ presenting: null })}>
            <X size={16} />
          </button>
        )}
      </div>
      <div style={{ overflow: "hidden", width: frame.width * scale, height: frame.height * scale }}>
        <div
          key={history.length}
          className="stage"
          style={{ width: frame.width, height: frame.height, transform: `scale(${scale})`, transformOrigin: "0 0", animation: a ? `${a} 300ms ease-out` : undefined }}
        >
          <div dangerouslySetInnerHTML={{ __html: svg }} />
          {hotspots.map((h) => {
            const click = h.interactions.find((i) => i.trigger === "onClick" || i.trigger === "onPress");
            const hover = h.interactions.find((i) => i.trigger === "onHover");
            return (
              <div
                key={h.id}
                className={"hotspot" + (flash ? " hint-flash" : "")}
                style={{ left: h.rect.x, top: h.rect.y, width: h.rect.width, height: h.rect.height }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (click) go(click);
                }}
                onMouseEnter={() => hover && go(hover)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function isDescendant(id: string, ancestor: string): boolean {
  const doc = getDoc();
  for (let p = doc.nodes[id]?.parent; p; p = doc.nodes[p]?.parent ?? null) if (p === ancestor) return true;
  return false;
}

/** Prototype links come from shared files: only web, email and phone links may open (never
 *  `javascript:` or `data:`). Mirrors the engine's `safe_link`. */
export function safeLink(url: string): string | null {
  const u = url.replace(/[\u0000-\u0020\u007f]/g, "");
  return /^(https?:\/\/|mailto:|tel:)/i.test(u) ? u : null;
}
