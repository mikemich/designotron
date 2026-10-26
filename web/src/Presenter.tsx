import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { getDoc, query, toast, useStore } from "./store";
import { nodeSvg } from "./exporter";
import type { Interaction, OverlaySettings, Rect } from "./types";
import { REPO_URL } from "./panels/GuestBar";
import { DEFAULT_OVERLAY, overlayDim, overlayOrigin } from "./prototype";

interface Hotspot {
  id: string;
  rect: Rect;
  interactions: Interaction[];
  /** This hotspot's layer, then its ancestors that have hotspots, innermost first. */
  chain: string[];
}

/** An open overlay; `x`/`y` place it on the base frame. */
interface OpenOverlay {
  key: number;
  id: string;
  settings: OverlaySettings;
  transition: Interaction["transition"];
  x: number;
  y: number;
}

const ANIM: Record<string, string> = {
  dissolve: "dt-dissolve",
  smartAnimate: "dt-dissolve",
  slideLeft: "dt-slide-left",
  slideRight: "dt-slide-right",
  slideUp: "dt-slide-up",
  slideDown: "dt-slide-down",
};

/** Prototype player: renders a frame and turns interactions into hotspots, with overlays
 *  (modals, menus) stacked on top. With `remixUrl` it is the view-only player for view links
 *  and embeds: no close, a Remix button instead. */
export function Presenter({ start, remixUrl }: { start: string; remixUrl?: string }) {
  const [history, setHistory] = useState<{ id: string; transition: Interaction["transition"] }[]>([{ id: start, transition: "instant" }]);
  // Open overlays, topmost last. Navigating to another frame closes them all.
  const [overlays, setOverlays] = useState<OpenOverlay[]>([]);
  const overlayKey = useRef(0);
  const [flash, setFlash] = useState(false);
  const current = history[history.length - 1];
  const doc = getDoc();
  const frame = doc.nodes[current.id];
  const frames = useMemo(() => {
    const page = doc.pages.find((p) => p.id === frame?.page);
    return (page?.children ?? []).filter((id) => ["frame", "component"].includes(doc.nodes[id]?.type));
  }, [current.id]);
  const baseHotspots = useHotspots(current.id);

  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!frame) return;
    const fit = () => setScale(Math.min(1, (window.innerWidth - 80) / frame.width, (window.innerHeight - 100) / frame.height));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [current.id]);

  const navigate = (id: string, transition: Interaction["transition"]) => {
    setOverlays([]);
    setHistory((h) => [...h, { id, transition }]);
  };
  // Back closes the topmost overlay before leaving the frame.
  const back = () => {
    if (overlays.length) setOverlays((o) => o.slice(0, -1));
    else setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
  };

  /** Runs an interaction; `from` is the triggering layer's rect on the base frame. */
  const go = (it: Interaction, from: Rect) => {
    if (it.action === "back") back();
    else if (it.action === "openUrl" && it.url) {
      const url = safeLink(it.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else toast("This prototype link isn't a web, email or phone link, so it wasn't opened", "error");
    } else if (it.action === "navigate" && it.destination && doc.nodes[it.destination]) navigate(it.destination, it.transition);
    else if (it.action === "closeOverlay") setOverlays((o) => o.slice(0, -1));
    else if ((it.action === "openOverlay" || it.action === "swapOverlay") && it.destination && frame) {
      const dest = doc.nodes[it.destination];
      if (!dest) return;
      const settings = it.overlay ?? DEFAULT_OVERLAY;
      const at = overlayOrigin(settings, frame, dest, from);
      const next: OpenOverlay = { key: ++overlayKey.current, id: dest.id, settings, transition: it.transition, x: at.x, y: at.y };
      setOverlays((o) => (it.action === "swapOverlay" ? [...o.slice(0, -1), next] : [...o, next]));
    }
  };

  // Timers call `go` through a ref so they never act on a stale render (e.g. "after delay → Back"
  // firing while a modal is open must close the modal).
  const goRef = useRef(go);
  goRef.current = go;
  const top = overlays.length ? overlays[overlays.length - 1] : null;
  // The base frame's delayed interaction runs once per visit to the frame; each overlay starts
  // its own once, when it opens (see OverlayLayer), so closing an overlay never restarts either.
  useEffect(() => {
    const n = getDoc().nodes[current.id];
    const delayed = n?.interactions.find((i) => i.trigger === "afterDelay");
    if (!n || !delayed) return;
    const t = setTimeout(() => goRef.current(delayed, { x: 0, y: 0, width: n.width, height: n.height }), delayed.delayMs || 800);
    return () => clearTimeout(t);
  }, [history.length, current.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (overlays.length) setOverlays((o) => o.slice(0, -1));
        else if (!remixUrl) useStore.setState({ presenting: null });
      }
      const i = frames.indexOf(current.id);
      if (e.key === "ArrowRight" && i < frames.length - 1) navigate(frames[i + 1], "slideLeft");
      if (e.key === "ArrowLeft" && i > 0) navigate(frames[i - 1], "slideRight");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current.id, frames, overlays.length]);

  if (!frame) return null;
  const a = ANIM[current.transition];
  const onBaseClick = (h: Hotspot, it: Interaction) => go(it, h.rect);
  return (
    <div className="presenter" onClick={() => !baseHotspots.length || (setFlash(true), setTimeout(() => setFlash(false), 400))}>
      <div className="bar" onClick={(e) => e.stopPropagation()}>
        <button className="tbtn" title="Back" onClick={back}>
          <ChevronLeft size={16} />
        </button>
        <span className="muted" style={{ padding: "0 8px" }}>
          {frame.name}
          {top ? ` › ${doc.nodes[top.id]?.name ?? ""}` : ""}
        </span>
        <button
          className="tbtn"
          title="Next frame"
          onClick={() => {
            const i = frames.indexOf(current.id);
            if (i < frames.length - 1) navigate(frames[i + 1], "slideLeft");
          }}
        >
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
      <div style={{ position: "relative", overflow: "hidden", width: frame.width * scale, height: frame.height * scale }}>
        <div
          key={history.length}
          className="stage"
          style={{ width: frame.width, height: frame.height, transform: `scale(${scale})`, transformOrigin: "0 0", animation: a ? `${a} 300ms ease-out` : undefined }}
        >
          <FrameLayer id={current.id} hotspots={baseHotspots} flash={flash} onAct={onBaseClick} />
        </div>
        {overlays.length > 0 && (
          <div className="overlays" style={{ width: frame.width, height: frame.height, transform: `scale(${scale})` }}>
            {overlays.map((o, i) => (
              <OverlayLayer
                key={o.key}
                overlay={o}
                isTop={i === overlays.length - 1}
                onClose={() => setOverlays((l) => l.slice(0, -1))}
                onAct={(h, it) => go(it, { ...h.rect, x: h.rect.x + o.x, y: h.rect.y + o.y })}
                onDelay={(it, from) => goRef.current(it, from)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One overlay: a click-catching (optionally dimmed) backdrop over the frame and the overlay
 *  frame at its position. Only the topmost overlay's backdrop closes on click. */
function OverlayLayer({
  overlay: o,
  isTop,
  onClose,
  onAct,
  onDelay,
}: {
  overlay: OpenOverlay;
  isTop: boolean;
  onClose: () => void;
  onAct: (h: Hotspot, it: Interaction) => void;
  onDelay: (it: Interaction, from: Rect) => void;
}) {
  const n = getDoc().nodes[o.id];
  const hotspots = useHotspots(o.id);
  // Layers are keyed by the overlay's key, so this runs once per opening, not whenever it is on top.
  useEffect(() => {
    const node = getDoc().nodes[o.id];
    const delayed = node?.interactions.find((i) => i.trigger === "afterDelay");
    if (!node || !delayed) return;
    const t = setTimeout(() => onDelay(delayed, { x: o.x, y: o.y, width: node.width, height: node.height }), delayed.delayMs || 800);
    return () => clearTimeout(t);
  }, []);
  if (!n) return null;
  const a = ANIM[o.transition];
  return (
    <div
      className="overlay-backdrop"
      data-overlay={o.id}
      style={{ background: overlayDim(o.settings), animation: "dt-dissolve 200ms ease-out" }}
      onClick={(e) => {
        e.stopPropagation();
        if (isTop && o.settings.closeOnClickOutside) onClose();
      }}
    >
      <div
        className="overlay-frame"
        style={{ left: o.x, top: o.y, width: n.width, height: n.height, animation: a ? `${a} 300ms ease-out` : undefined }}
        onClick={(e) => e.stopPropagation()}
      >
        <FrameLayer id={o.id} hotspots={hotspots} flash={false} onAct={onAct} />
      </div>
    </div>
  );
}

/** A frame's picture plus a hotspot per layer with interactions. Hotspots are siblings, so a
 *  layer without its own click runs its nearest ancestor's click, and pointer hover counts for
 *  every layer in the chain (entering a child is still hovering the parent). */
function FrameLayer({ id, hotspots, flash, onAct }: { id: string; hotspots: Hotspot[]; flash: boolean; onAct: (h: Hotspot, it: Interaction) => void }) {
  const svg = useMemo(() => nodeSvg(id), [id]);
  const byId = useMemo(() => new Map(hotspots.map((h) => [h.id, h])), [hotspots]);
  const isClick = (i: Interaction) => i.trigger === "onClick" || i.trigger === "onPress";
  const isHover = (i: Interaction) => i.trigger === "onHover";
  // How many hotspots of each hover owner's chain the pointer is inside; fire on 0 → 1 only.
  const inside = useRef(new Map<string, number>());
  const enter = (h: Hotspot) => {
    for (const owner of h.chain) {
      const o = byId.get(owner);
      const hover = o?.interactions.find(isHover);
      if (!o || !hover) continue;
      const n = inside.current.get(owner) ?? 0;
      inside.current.set(owner, n + 1);
      if (n === 0) onAct(o, hover);
    }
  };
  const leave = (h: Hotspot) => {
    // Deferred so moving between a parent and its child (leave, then enter) doesn't re-fire.
    setTimeout(() => {
      for (const owner of h.chain) if (inside.current.has(owner)) inside.current.set(owner, Math.max(0, (inside.current.get(owner) ?? 1) - 1));
    }, 0);
  };
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      {hotspots.map((h) => (
        <div
          key={h.id}
          className={"hotspot" + (flash ? " hint-flash" : "")}
          data-hotspot={h.id}
          style={{ left: h.rect.x, top: h.rect.y, width: h.rect.width, height: h.rect.height }}
          onClick={(e) => {
            e.stopPropagation();
            for (const owner of h.chain) {
              const o = byId.get(owner);
              const click = o?.interactions.find(isClick);
              if (o && click) return onAct(o, click);
            }
          }}
          onMouseEnter={() => enter(h)}
          onMouseLeave={() => leave(h)}
        />
      ))}
    </>
  );
}

/** Hotspots of a frame's layers, in frame coordinates. */
function useHotspots(frameId: string): Hotspot[] {
  return useMemo<Hotspot[]>(() => {
    const doc = getDoc();
    if (!doc.nodes[frameId]) return [];
    const ids = Object.values(doc.nodes)
      // Only layers with something to click or hover get a hotspot: an after-delay interaction on
      // the frame itself must not put a click-swallowing layer over its children.
      .filter((n) => n.interactions.some((i) => i.trigger !== "afterDelay") && (n.id === frameId || isDescendant(n.id, frameId)))
      .map((n) => n.id);
    const fb = query<{ union: Rect }>({ q: "bounds", ids: [frameId] }).union;
    const items = query<{ items: { id: string; bounds: Rect }[] }>({ q: "bounds", ids }).items;
    const withHotspot = new Set(items.map((it) => it.id));
    // Layer ids from `id` up to (and including) the frame.
    const lineage = (id: string) => {
      const out = [id];
      for (let p = doc.nodes[id]?.parent; p && out[out.length - 1] !== frameId; p = doc.nodes[p]?.parent ?? null) out.push(p);
      return out;
    };
    return (
      items
        .map((it) => ({
          id: it.id,
          rect: { x: it.bounds.x - fb.x, y: it.bounds.y - fb.y, width: it.bounds.width, height: it.bounds.height },
          interactions: doc.nodes[it.id].interactions,
          chain: lineage(it.id).filter((l) => withHotspot.has(l)),
          depth: lineage(it.id).length,
        }))
        // Node order in the document is arbitrary: deeper layers go on top of their ancestors
        // (so a child that overflows or matches its parent's size still gets the click), and
        // among layers of the same depth bigger ones go first.
        .sort((a, b) => a.depth - b.depth || b.rect.width * b.rect.height - a.rect.width * a.rect.height || (a.id < b.id ? -1 : 1))
        .map(({ depth: _depth, ...h }) => h)
    );
  }, [frameId]);
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
