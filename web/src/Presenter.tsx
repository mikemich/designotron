import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { toast, useStore } from "./store";
import type { Interaction, OverlaySettings, Rect } from "./types";
import { REPO_URL } from "./panels/GuestBar";
import { DEFAULT_OVERLAY, overlayDim, overlayOrigin } from "./prototype";
import { inlineAssets } from "./assets";
import { focusedByPointer } from "./ui/controls";
import {
  buildScene,
  changeTarget,
  closePlayer,
  INSTANT,
  keepsOldScreen,
  keyName,
  matchPieces,
  morph,
  motionAnimation,
  motionOf,
  pdoc,
  piecesOf,
  playerRevision,
  pq,
  reverseMotion,
  scrollersOf,
  slide,
  smartable,
  swapVariant,
  type AboveScene,
  type FixedScene,
  type Hotspot,
  type Motion,
  type Piece,
  type Scene,
  type ScrollerScene,
} from "./player";

/** Undoes what an interaction did (While hovering / While pressing). */
type Revert = () => void;

/** A screen the player has been on, and how it was entered (Back plays that in reverse). */
interface Entry {
  id: string;
  via: Motion;
}

/** An open overlay; `x`/`y` place it on the base frame. */
interface OpenOverlay {
  key: number;
  id: string;
  settings: OverlaySettings;
  motion: Motion;
  x: number;
  y: number;
}

/** A change of screen in progress: the screen that is leaving and how it plays. */
interface Leaving {
  key: number;
  id: string;
  motion: Motion;
  /** Where the leaving screen's scrollers were, so it doesn't jump to the top while it goes. */
  pos: Map<string, { left: number; top: number }>;
}

/** A smart animate in progress: the new state's background, and the pieces of both states. */
interface Smart {
  key: number;
  motion: Motion;
  bg: string;
  from: Piece[];
  to: Piece[];
}

/** People who asked for less motion get instant transitions. */
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How long the click that follows a released "While pressing" is ignored. */
const SWALLOW_CLICK_MS = 500;
/** A press-and-release that moved less than this (px) still counts as a tap. */
const TAP_SLOP = 10;

/** The click of a layer that also has "While pressing", run on release (see `press`). */
interface Tap {
  act: () => void;
  /** The layer on screen when the pointer went down, and where. */
  box: DOMRect;
  x: number;
  y: number;
}
const within = (b: DOMRect, x: number, y: number) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

/** Prototype player: renders a frame and turns interactions into hotspots, with overlays
 *  (modals, menus) stacked on top. With `remixUrl` it is the view-only player for view links
 *  and embeds: no close, a Remix button instead. */
export function Presenter({ start, remixUrl }: { start: string; remixUrl?: string }) {
  const [history, setHistory] = useState<Entry[]>([{ id: start, via: INSTANT }]);
  // Open overlays, topmost last. Navigating to another frame closes them all.
  const [overlays, setOverlays] = useState<OpenOverlay[]>([]);
  const overlayKey = useRef(0);
  const [flash, setFlash] = useState(false);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [smart, setSmart] = useState<Smart | null>(null);
  const motionKey = useRef(0);
  // Moves when the player's own engine changes (a Change to), so scenes are rebuilt.
  const [, setRevision] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = history[history.length - 1];
  const doc = pdoc();
  const frame = doc.nodes[current.id];
  const frames = useMemo(() => {
    const page = doc.pages.find((p) => p.id === frame?.page);
    return (page?.children ?? []).filter((id) => ["frame", "component"].includes(doc.nodes[id]?.type));
  }, [current.id]);

  // Scenes are built once per screen and player revision (never per frame or scroll event).
  const scenes = useRef({ rev: -1, map: new Map<string, Scene>() });
  const sceneFor = (id: string): Scene => {
    const rev = playerRevision();
    if (scenes.current.rev !== rev) scenes.current = { rev, map: new Map() };
    let s = scenes.current.map.get(id);
    if (!s) scenes.current.map.set(id, (s = buildScene(id)));
    return s;
  };
  const scene = frame ? sceneFor(current.id) : null;

  // Scroll positions survive a rebuilt scene (Change to) and are dropped with the screen.
  const scrolls = useRef({ key: "", pos: new Map<string, { left: number; top: number }>() });
  const scrollEls = useRef(new Map<string, HTMLElement>());
  const scrollKey = `${history.length}`;
  if (scrolls.current.key !== scrollKey) scrolls.current = { key: scrollKey, pos: new Map() };

  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!frame) return;
    const fit = () => setScale(Math.min(1, (window.innerWidth - 80) / frame.width, (window.innerHeight - 100) / frame.height));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [current.id]);
  useEffect(() => closePlayer, []);

  /** The motion that really plays: none with reduced motion, a dissolve for a smart animate
   *  between containers with too many children. */
  const playable = (m: Motion, ...containers: string[]): Motion =>
    reducedMotion() ? INSTANT : m.kind === "smart" && !containers.every(smartable) ? { ...m, kind: "dissolve" } : m;

  /** Starts a change of screen from `from` (the screen that goes away) to `to`. */
  const startMotion = (from: string, to: string, m: Motion) => {
    const motion = playable(m, from, to);
    setSmart(null);
    if (motion.kind === "instant") return setLeaving(null);
    const key = ++motionKey.current;
    if (motion.kind === "smart") {
      const kids = pdoc().nodes[to]?.children ?? [];
      const bg = inlineAssets(pq<string>({ q: "exportSvg", id: to, hide: kids }));
      setSmart({ key, motion, bg, from: piecesOf(from, from), to: piecesOf(to, to) });
    }
    setLeaving({ key, id: from, motion, pos: new Map(scrolls.current.pos) });
  };

  const navigate = (id: string, m: Motion) => {
    setOverlays([]);
    startMotion(current.id, id, m);
    setHistory((h) => [...h, { id, via: m }]);
  };
  // Back closes the topmost overlay before leaving the frame, and plays the way in reversed.
  const back = () => {
    if (overlays.length) return setOverlays((o) => o.slice(0, -1));
    if (history.length < 2) return;
    startMotion(current.id, history[history.length - 2].id, reverseMotion(current.via));
    setHistory((h) => h.slice(0, -1));
  };
  // The change of screen is over: take the old screen away.
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => {
      setLeaving(null);
      setSmart(null);
    }, leaving.motion.ms + 60);
    return () => clearTimeout(t);
  }, [leaving?.key]);

  /** Puts screens and overlays back as they were (While hovering / While pressing). */
  const snapshot = (): Revert => {
    const prev = { history, overlays };
    return () => {
      setLeaving(null);
      setSmart(null);
      setHistory(prev.history);
      setOverlays(prev.overlays);
    };
  };

  /** Scrolls every scroller holding `target` so the layer's top-left reaches the scroller's. */
  const scrollTo = (it: Interaction, sceneOf: Scene) => {
    if (!it.destination) return;
    const frameAt = pq<{ union: Rect }>({ q: "bounds", ids: [sceneOf.id] }).union;
    const target = pq<{ items: { bounds: Rect }[] }>({ q: "bounds", ids: [it.destination] }).items[0]?.bounds;
    if (!target) return;
    const smooth = it.transition !== "instant" && !reducedMotion();
    for (const s of scrollersOf(sceneOf, it.destination)) {
      const el = scrollEls.current.get(s.id);
      if (!el) continue;
      const h = s.overflow === "horizontal" || s.overflow === "both";
      const v = s.overflow === "vertical" || s.overflow === "both";
      el.scrollTo({
        left: h ? target.x - frameAt.x - s.rect.x : el.scrollLeft,
        top: v ? target.y - frameAt.y - s.rect.y : el.scrollTop,
        behavior: smooth ? "smooth" : "instant",
      });
    }
  };

  /** Runs an interaction; `from` is the triggering layer's rect on the base frame, `source` its
   *  layer and `inFrame` the screen it lives on. Returns how to undo it, if it can be undone. */
  const go = (it: Interaction, from: Rect, source: string, inFrame: string): Revert | null => {
    if (it.action === "back") back();
    else if (it.action === "openUrl" && it.url) {
      const url = safeLink(it.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else toast("This prototype link isn't a web, email or phone link, so it wasn't opened", "error");
    } else if (it.action === "scrollTo") {
      const s = sceneFor(inFrame);
      scrollTo(it, s);
    } else if (it.action === "changeTo" && it.destination) {
      return changeVariant(it, source, inFrame);
    } else if (it.action === "navigate" && it.destination && doc.nodes[it.destination]) {
      const undo = snapshot();
      navigate(it.destination, motionOf(it));
      return undo;
    } else if (it.action === "closeOverlay") setOverlays((o) => o.slice(0, -1));
    else if ((it.action === "openOverlay" || it.action === "swapOverlay") && it.destination && frame) {
      const dest = doc.nodes[it.destination];
      if (!dest) return null;
      const settings = it.overlay ?? DEFAULT_OVERLAY;
      const at = overlayOrigin(settings, frame, dest, from);
      const next: OpenOverlay = { key: ++overlayKey.current, id: dest.id, settings, motion: playable(motionOf(it)), x: at.x, y: at.y };
      const undo = snapshot();
      setOverlays((o) => (it.action === "swapOverlay" ? [...o.slice(0, -1), next] : [...o, next]));
      return undo;
    }
    return null;
  };

  /** Change to: the instance holding `source` switches to another variant of its set, in place. */
  const changeVariant = (it: Interaction, source: string, inFrame: string): Revert | null => {
    const instance = changeTarget(source, it.destination!);
    const before = instance ? pdoc().nodes[instance]?.instance?.componentId : null;
    if (!instance || !before || before === it.destination) return null;
    const m = playable(motionOf(it), instance);
    // Smart animate: the instance's direct children, before and after. Only on the visible screen
    // and outside scrolling layers (their pictures are placed by the scroller).
    const sc = sceneFor(inFrame);
    let pieces: Piece[] | null = null;
    if (m.kind === "smart" && inFrame === current.id && !overlays.length && !scrollersOf(sc, instance).length && !sc.fixed.some((f) => f.id === instance)) {
      pieces = piecesOf(instance, inFrame);
    }
    if (!swapVariant(instance, it.destination!)) return null;
    if (pieces) {
      const kids = pdoc().nodes[instance].children;
      const bg = inlineAssets(pq<string>({ q: "exportSvg", id: inFrame, hide: kids }));
      const key = ++motionKey.current;
      setSmart({ key, motion: m, bg, from: pieces, to: piecesOf(instance, inFrame) });
      setLeaving({ key, id: inFrame, motion: { ...m, kind: "dissolve" }, pos: new Map() });
    }
    setRevision((r) => r + 1);
    return () => {
      if (swapVariant(instance, before)) setRevision((r) => r + 1);
    };
  };

  // "While hovering": acts when the pointer enters the layer and undoes it when the pointer is
  // no longer over the layer's box. The layer itself may be gone by then (a Navigate replaced the
  // screen), so the box is checked on the window, in the page's coordinates.
  const hovering = useRef<(() => void) | null>(null);
  const hover = (owner: string, run: () => Revert | null) => {
    hovering.current?.();
    const box = rootRef.current?.querySelector<HTMLElement>(`[data-hotspot="${CSS.escape(owner)}"]`)?.getBoundingClientRect();
    const undo = run();
    if (!undo || !box) return;
    const move = (e: PointerEvent | MouseEvent) => {
      if (e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom) return;
      stop();
      undo();
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("mousemove", move);
      hovering.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("mousemove", move);
    hovering.current = stop;
  };

  /** "While pressing": acts on pointer down and puts the previous screen back when that same
   *  pointer is released. Only one press is tracked at a time (a second finger is ignored), and
   *  the click the browser sends after the release is swallowed so it can't run another link. */
  const pressing = useRef<(() => void) | null>(null);
  const disarmSwallow = useRef<(() => void) | null>(null);
  const press = (it: Interaction, from: Rect, source: string, inFrame: string, pointerId: number, tap?: Tap) => {
    if (pressing.current) return;
    const undo = go(it, from, source, inFrame);
    if (!undo) return;
    const stop = () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      pressing.current = null;
    };
    const release = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      stop();
      undo();
      // A layer with both "While pressing" and "On click": the release over the layer is the tap,
      // so the click runs once the press is put back (not when the press is cancelled).
      if (tap && e.type === "pointerup" && (within(tap.box, e.clientX, e.clientY) || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < TAP_SLOP)) tap.act();
      // A mouse release sends no click into the player (the layer under the pointer was replaced),
      // so the next pointerdown, which starts a real click, disarms the swallow too.
      disarmSwallow.current?.();
      const swallow = (c: Event) => {
        if (!(c.target as Element | null)?.closest?.(".presenter")) return;
        c.stopPropagation();
        c.preventDefault();
        disarm();
      };
      const timer = setTimeout(() => disarm(), SWALLOW_CLICK_MS);
      const disarm = () => {
        window.removeEventListener("click", swallow, true);
        window.removeEventListener("pointerdown", disarm, true);
        clearTimeout(timer);
        disarmSwallow.current = null;
      };
      window.addEventListener("click", swallow, true);
      window.addEventListener("pointerdown", disarm, true);
      disarmSwallow.current = disarm;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    pressing.current = stop;
  };
  useEffect(
    () => () => {
      pressing.current?.();
      disarmSwallow.current?.();
      hovering.current?.();
    },
    [],
  );

  // Timers and keys call `go` through a ref so they never act on a stale render (e.g. "after
  // delay → Back" firing while a modal is open must close the modal).
  const goRef = useRef(go);
  goRef.current = go;
  const top = overlays.length ? overlays[overlays.length - 1] : null;
  // The base frame's delayed interaction runs once per visit to the frame; each overlay starts
  // its own once, when it opens (see OverlayLayer), so closing an overlay never restarts either.
  useEffect(() => {
    const n = pdoc().nodes[current.id];
    const delayed = n?.interactions.find((i) => i.trigger === "afterDelay");
    if (!n || !delayed) return;
    const t = setTimeout(() => goRef.current(delayed, { x: 0, y: 0, width: n.width, height: n.height }, n.id, n.id), delayed.delayMs || 800);
    return () => clearTimeout(t);
  }, [history.length, current.id]);

  // Focus moves into the player (Tab stays inside) and goes back to the opener on exit.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => {
      if (before?.isConnected) before.focus?.();
    };
  }, []);

  // Keys: a Key interaction of the top overlay, else of the base frame, wins; otherwise Escape
  // closes and the arrows step through the page's frames.
  const keys = useRef({ scene, top, frames, current, overlays });
  keys.current = { scene, top, frames, current, overlays };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A focused hotspot already ran its click on this Enter or Space.
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
      const k = keys.current;
      // A focused button or link (Back, Close, Remix) keeps Enter and Space.
      // (not one a mouse click focused: the bar's Back button must not swallow a key trigger).
      if ((e.key === "Enter" || e.key === " ") && t?.closest("button, a[href]") && !focusedByPointer(t.closest("button, a[href]"))) return;
      const name = keyName(e);
      // Order: the top overlay's keys, then Escape closes an open overlay, then the base frame's
      // keys, then the built-ins (Escape leaves, the arrows step through the frames).
      const run = (live: Scene | null, offset: OpenOverlay | null) => {
        const hit = name ? live?.keyed.find((x) => x.it.key === name) : undefined;
        if (!hit || !live) return false;
        e.preventDefault();
        e.stopPropagation();
        const r = live.all.get(hit.id)?.rect ?? { x: 0, y: 0, width: live.width, height: live.height };
        goRef.current(hit.it, offset ? { ...r, x: r.x + offset.x, y: r.y + offset.y } : r, hit.id, live.id);
        return true;
      };
      if (k.top && run(sceneFor(k.top.id), k.top)) return;
      if (k.top && e.key === "Escape") {
        e.preventDefault();
        setOverlays((o) => o.slice(0, -1));
        return;
      }
      if (run(k.scene, null)) return;
      if (e.key === "Escape") {
        if (k.overlays.length) setOverlays((o) => o.slice(0, -1));
        else if (!remixUrl) useStore.setState({ presenting: null });
      }
      const i = k.frames.indexOf(k.current.id);
      if (e.key === "ArrowRight" && i < k.frames.length - 1) navigateRef.current(k.frames[i + 1], slide("left"));
      if (e.key === "ArrowLeft" && i > 0) navigateRef.current(k.frames[i - 1], slide("right"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  if (!frame || !scene) return null;
  const hasHotspots = scene.all.size > 0;
  const trapTab = (e: React.KeyboardEvent) => {
    const root = rootRef.current;
    if (e.key !== "Tab" || !root) return;
    const els = [...root.querySelectorAll<HTMLElement>('button, a[href], .hotspot[tabindex="0"]')];
    const at = document.activeElement;
    if (!els.length) e.preventDefault();
    else if (e.shiftKey && (at === els[0] || at === root)) (e.preventDefault(), els[els.length - 1].focus());
    else if (!e.shiftKey && at === els[els.length - 1]) (e.preventDefault(), els[0].focus());
  };

  const crumb = frame.name + (top ? ` › ${doc.nodes[top.id]?.name ?? ""}` : "");
  const m = leaving?.motion;
  const old = leaving && m && keepsOldScreen(m) && pdoc().nodes[leaving.id] ? leaving : null;
  // The scale sits on a wrapper so the move/push keyframes (which set `transform`) can run on
  // the stage itself without dropping it.
  const curStage = (
    <div
      key={"s" + history.length}
      style={{ position: "absolute", left: 0, top: 0, width: frame.width, height: frame.height, transform: `scale(${scale})`, transformOrigin: "0 0", zIndex: m?.kind === "moveOut" ? 0 : 1 }}
    >
      <div
        className="stage"
        style={{ width: frame.width, height: frame.height, animation: m ? motionAnimation(m, true) : undefined, visibility: smart ? "hidden" : undefined }}
      >
        <SceneView
          scene={scene}
          flash={flash}
          interactive={!smart}
          tabbable={!smart && overlays.length === 0}
          scrolls={scrolls}
          scrollEls={scrollEls}
          onAct={(h, it) => go(it, h.rect, h.id, current.id)}
          onHover={hover}
          onPress={(h, it, pointerId, tap) => press(it, h.rect, h.id, current.id, pointerId, tap)}
        />
      </div>
    </div>
  );
  const oldStage = old && (
    <div
      key={"l" + old.key}
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: pdoc().nodes[old.id].width,
        height: pdoc().nodes[old.id].height,
        transform: `scale(${scale})`,
        transformOrigin: "0 0",
        pointerEvents: "none",
        zIndex: old.motion.kind === "moveOut" ? 2 : 0,
      }}
    >
      <div className="stage stage-leaving" style={{ width: pdoc().nodes[old.id].width, height: pdoc().nodes[old.id].height, animation: motionAnimation(old.motion, false) }}>
        <SceneView scene={sceneFor(old.id)} flash={false} interactive={false} scrolls={{ current: { key: "", pos: old.pos } }} scrollEls={scrollEls} />
      </div>
    </div>
  );
  return (
    <div
      ref={rootRef}
      className="presenter"
      role="dialog"
      aria-modal="true"
      aria-label={`Prototype: ${frame.name}`}
      tabIndex={-1}
      onKeyDown={trapTab}
      onClick={() => hasHotspots || (setFlash(true), setTimeout(() => setFlash(false), 400))}
    >
      <div className="bar" onClick={(e) => e.stopPropagation()}>
        <button className="tbtn" title="Back" onClick={back}>
          <ChevronLeft size={16} />
        </button>
        <span className="muted crumb" title={crumb}>
          {crumb}
        </span>
        <button
          className="tbtn"
          title="Next frame"
          onClick={() => {
            const i = frames.indexOf(current.id);
            if (i < frames.length - 1) navigate(frames[i + 1], slide("left"));
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
        {old && m?.kind !== "moveOut" && oldStage}
        {curStage}
        {old && m?.kind === "moveOut" && oldStage}
        {smart && <SmartLayer key={smart.key} smart={smart} width={frame.width} height={frame.height} scale={scale} />}
        {overlays.length > 0 && (
          <div className="overlays" style={{ width: frame.width, height: frame.height, transform: `scale(${scale})` }}>
            {overlays.map((o, i) => (
              <OverlayLayer
                key={o.key}
                overlay={o}
                scene={sceneFor(o.id)}
                isTop={i === overlays.length - 1}
                scrolls={scrolls}
                scrollEls={scrollEls}
                onClose={() => setOverlays((l) => l.slice(0, -1))}
                onAct={(h, it) => go(it, { ...h.rect, x: h.rect.x + o.x, y: h.rect.y + o.y }, h.id, o.id)}
                onHover={hover}
                onPress={(h, it, pointerId, tap) => press(it, { ...h.rect, x: h.rect.x + o.x, y: h.rect.y + o.y }, h.id, o.id, pointerId, tap)}
                onDelay={(it, from) => goRef.current(it, from, o.id, o.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Smart animate, stage 1: the direct children of the old and new state matched by layer name
 *  move, resize, rotate and fade from one to the other over the new state's background; what
 *  only one state has fades out or in. The real screen replaces this when it is done. */
function SmartLayer({ smart, width, height, scale }: { smart: Smart; width: number; height: number; scale: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { pairs, gone, added } = useMemo(() => matchPieces(smart.from, smart.to), [smart]);
  // What each picture does: [element key, piece, keyframes, side].
  const items = useMemo(() => {
    const out: { key: string; piece: Piece; frames: Keyframe[]; side: "old" | "new" | "both" }[] = [];
    pairs.forEach(([a, b], i) => {
      if (a.svg === b.svg) {
        // Same picture: it only moves (a cross-fade would dim it halfway).
        out.push({ key: `p${i}`, piece: a, frames: [{ transform: "none" }, { transform: morph(a, b) }], side: "both" });
      } else {
        out.push({ key: `o${i}`, piece: a, frames: [{ transform: "none", opacity: 1 }, { transform: morph(a, b), opacity: 0 }], side: "old" });
        out.push({ key: `n${i}`, piece: b, frames: [{ transform: morph(b, a), opacity: 0 }, { transform: "none", opacity: 1 }], side: "new" });
      }
    });
    gone.forEach((p, i) => out.push({ key: `g${i}`, piece: p, frames: [{ opacity: 1 }, { opacity: 0 }], side: "old" }));
    added.forEach((p, i) => out.push({ key: `a${i}`, piece: p, frames: [{ opacity: 0 }, { opacity: 1 }], side: "new" }));
    return out;
  }, [pairs, gone, added]);
  useEffect(() => {
    const els = ref.current?.querySelectorAll<HTMLElement>("[data-piece]");
    if (!els) return;
    const anims = [...els].map((el) => el.animate(items[Number(el.dataset.piece)].frames, { duration: smart.motion.ms, easing: smart.motion.easing, fill: "both" }));
    return () => anims.forEach((a) => a.cancel());
  }, [items]);
  return (
    <div ref={ref} className="smart-layer" style={{ position: "absolute", left: 0, top: 0, width, height, transform: `scale(${scale})`, transformOrigin: "0 0", pointerEvents: "none", zIndex: 3 }}>
      <div dangerouslySetInnerHTML={{ __html: smart.bg }} />
      {items.map((it, i) => (
        <div
          key={it.key}
          data-piece={i}
          data-smart={it.piece.name}
          data-smart-side={it.side}
          style={{
            position: "absolute",
            left: it.piece.crop.x,
            top: it.piece.crop.y,
            width: it.piece.crop.width,
            height: it.piece.crop.height,
            transformOrigin: `${it.piece.cx - it.piece.crop.x}px ${it.piece.cy - it.piece.crop.y}px`,
          }}
          dangerouslySetInnerHTML={{ __html: it.piece.svg }}
        />
      ))}
    </div>
  );
}

/** One overlay: a click-catching (optionally dimmed) backdrop over the frame and the overlay
 *  frame at its position. Only the topmost overlay's backdrop closes on click. */
function OverlayLayer({
  overlay: o,
  scene,
  isTop,
  scrolls,
  scrollEls,
  onClose,
  onAct,
  onHover,
  onPress,
  onDelay,
}: {
  overlay: OpenOverlay;
  scene: Scene;
  isTop: boolean;
  scrolls: Scrolls;
  scrollEls: ScrollEls;
  onClose: () => void;
  onAct: (h: Hotspot, it: Interaction) => Revert | null;
  onHover: (owner: string, run: () => Revert | null) => void;
  onPress: (h: Hotspot, it: Interaction, pointerId: number, tap?: Tap) => void;
  onDelay: (it: Interaction, from: Rect) => void;
}) {
  const n = pdoc().nodes[o.id];
  // Layers are keyed by the overlay's key, so this runs once per opening, not whenever it is on top.
  useEffect(() => {
    const node = pdoc().nodes[o.id];
    const delayed = node?.interactions.find((i) => i.trigger === "afterDelay");
    if (!node || !delayed) return;
    const t = setTimeout(() => onDelay(delayed, { x: o.x, y: o.y, width: node.width, height: node.height }), delayed.delayMs || 800);
    return () => clearTimeout(t);
  }, []);
  if (!n) return null;
  const m = o.motion;
  const a = m.kind === "instant" ? undefined : m.kind === "dissolve" || m.kind === "smart" ? motionAnimation(m, true) : `dt-in-${m.dir} ${m.ms}ms ${m.easing} both`;
  return (
    <div
      className="overlay-backdrop"
      data-overlay={o.id}
      style={{ background: overlayDim(o.settings), animation: m.kind === "instant" ? undefined : `dt-dissolve ${Math.min(m.ms, 300)}ms ${m.easing}` }}
      onClick={(e) => {
        e.stopPropagation();
        if (isTop && o.settings.closeOnClickOutside) onClose();
      }}
    >
      <div className="overlay-frame" style={{ left: o.x, top: o.y, width: n.width, height: n.height, animation: a }} onClick={(e) => e.stopPropagation()}>
        <SceneView scene={scene} flash={false} interactive tabbable={isTop} scrolls={scrolls} scrollEls={scrollEls} onAct={onAct} onHover={onHover} onPress={onPress} />
      </div>
    </div>
  );
}

type Scrolls = React.MutableRefObject<{ key: string; pos: Map<string, { left: number; top: number }> }>;
type ScrollEls = React.MutableRefObject<Map<string, HTMLElement>>;

interface SceneProps {
  scene: Scene;
  flash: boolean;
  interactive: boolean;
  /** Click hotspots are in the Tab order (not under an overlay or a screen that is leaving). */
  tabbable?: boolean;
  scrolls: Scrolls;
  scrollEls: ScrollEls;
  onAct?: (h: Hotspot, it: Interaction) => Revert | null;
  onHover?: (owner: string, run: () => Revert | null) => void;
  onPress?: (h: Hotspot, it: Interaction, pointerId: number, tap?: Tap) => void;
}

/** A screen's picture, its scrolling boxes and fixed layers, and a hotspot per layer with
 *  interactions. Hotspots are siblings, so a layer without its own click runs its nearest
 *  ancestor's click, and pointer hover counts for every layer in the chain (entering a child is
 *  still hovering the parent). */
function SceneView({ scene, flash, interactive, tabbable, scrolls, scrollEls, onAct, onHover, onPress }: SceneProps) {
  const byId = scene.all;
  const is = (t: Interaction["trigger"]) => (i: Interaction) => i.trigger === t;
  // How many hotspots of each owner's chain the pointer is inside; fire on 0 → 1 and 1 → 0 only.
  const inside = useRef(new Map<string, number>());
  const enter = (h: Hotspot) => {
    for (const owner of h.chain) {
      const o = byId.get(owner);
      if (!o) continue;
      const n = inside.current.get(owner) ?? 0;
      inside.current.set(owner, n + 1);
      if (n !== 0) continue;
      for (const it of o.interactions) {
        if (it.trigger === "mouseEnter") onAct?.(o, it);
        else if (it.trigger === "onHover") onHover?.(owner, () => onAct?.(o, it) ?? null);
      }
    }
  };
  const leave = (h: Hotspot) => {
    // Deferred so moving between a parent and its child (leave, then enter) doesn't re-fire.
    setTimeout(() => {
      for (const owner of h.chain) {
        const n = inside.current.get(owner);
        if (n === undefined) continue;
        inside.current.set(owner, Math.max(0, n - 1));
        if (n !== 1) continue;
        const o = byId.get(owner);
        for (const it of o?.interactions.filter(is("mouseLeave")) ?? []) onAct?.(o!, it);
      }
    }, 0);
  };
  /** The click a tap on `chain` runs: the nearest layer with one (a press on the way owns the tap). */
  const clickOf = (chain: string[]) => {
    for (const owner of chain) {
      const o = byId.get(owner);
      const c = o?.interactions.find(is("onClick"));
      if (o && c) return { o, c };
      if (o?.interactions.some(is("onPress"))) return null;
    }
    return null;
  };
  const click = (chain: string[]): boolean => {
    const hit = clickOf(chain);
    if (hit) onAct?.(hit.o, hit.c);
    return hit !== null || chain.some((owner) => byId.get(owner)?.interactions.some(is("onPress")));
  };
  const nearest = (chain: string[], t: Interaction["trigger"]) => {
    for (const owner of chain) {
      const o = byId.get(owner);
      const it = o?.interactions.find(is(t));
      if (o && it) return { o, it };
    }
    return null;
  };
  const spot = (h: Hotspot, origin: Rect) => {
    // A hotspot whose tap runs a click is reachable by keyboard: Enter or Space acts.
    const hit = tabbable ? clickOf(h.chain) : null;
    const dest = hit?.c.destination ? pdoc().nodes[hit.c.destination]?.name : null;
    return (
      <div
        key={h.id}
        className={"hotspot" + (flash ? " hint-flash" : "")}
        data-hotspot={h.id}
        {...(hit ? { tabIndex: 0, role: "button", "aria-label": pdoc().nodes[hit.o.id]?.name || (dest ? `Go to ${dest}` : "Button") } : {})}
        onKeyDown={
          hit
            ? (e) => {
                if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                e.preventDefault();
                click(h.chain);
              }
            : undefined
        }
        style={{ left: h.rect.x - origin.x, top: h.rect.y - origin.y, width: h.rect.width, height: h.rect.height }}
        onClick={(e) => {
          e.stopPropagation();
          click(h.chain);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const down = nearest(h.chain, "mouseDown");
          if (down) onAct?.(down.o, down.it);
          for (const owner of h.chain) {
            const o = byId.get(owner);
            const p = o?.interactions.find(is("onPress"));
            if (o && p) {
              const c = o.interactions.find(is("onClick"));
              // The press owner's own rect (it may be an ancestor of the layer under the pointer).
              const own = e.currentTarget.closest(".presenter")?.querySelector<HTMLElement>(`[data-hotspot="${CSS.escape(owner)}"]`);
              const box = (own ?? e.currentTarget).getBoundingClientRect();
              return onPress?.(o, p, e.pointerId, c ? { act: () => onAct?.(o, c), box, x: e.clientX, y: e.clientY } : undefined);
            }
            if (o?.interactions.some(is("onClick"))) return;
          }
        }}
        // Mouse up acts when the pointer is released over the layer, wherever the press began.
        onPointerUp={(e) => {
          if (e.button !== 0) return;
          const up = nearest(h.chain, "mouseUp");
          if (up) onAct?.(up.o, up.it);
        }}
        onMouseEnter={() => enter(h)}
        onMouseLeave={() => leave(h)}
      />
    );
  };
  const none: Rect = { x: 0, y: 0, width: 0, height: 0 };
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: scene.base }} />
      {interactive && scene.hotspots.map((h) => spot(h, none))}
      {scene.scrollers.map((s) => (
        <Fragment key={s.id}>
          <ScrollerView s={s} origin={none} interactive={interactive} scrolls={scrolls} scrollEls={scrollEls} spot={spot} click={click} />
          {s.above && <AboveView a={s.above} origin={none} interactive={interactive} spot={spot} />}
        </Fragment>
      ))}
      {scene.fixed.length > 0 && (
        <div className="fixed-layers">
          {scene.fixed.map((f) => (
            <FixedView key={f.id} f={f} interactive={interactive} spot={spot} />
          ))}
        </div>
      )}
    </>
  );
}

/** The layers painted after a scrolling box, over it. */
function AboveView({ a, origin, interactive, spot }: { a: AboveScene; origin: Rect; interactive: boolean; spot: (h: Hotspot, origin: Rect) => React.ReactNode }) {
  return (
    <>
      {a.pieces.map((p, i) => (
        <div key={i} style={{ position: "absolute", left: p.x - origin.x, top: p.y - origin.y, width: p.width, height: p.height, pointerEvents: "none" }} dangerouslySetInnerHTML={{ __html: p.svg }} />
      ))}
      {interactive && a.hotspots.map((h) => spot(h, origin))}
    </>
  );
}

/** A fixed layer: drawn above the scrolling box, never moves. */
function FixedView({ f, interactive, spot }: { f: FixedScene; interactive: boolean; spot: (h: Hotspot, origin: Rect) => React.ReactNode }) {
  const none: Rect = { x: 0, y: 0, width: 0, height: 0 };
  return (
    <>
      <div data-fixed={f.id} style={{ position: "absolute", left: f.rect.x, top: f.rect.y, width: f.rect.width, height: f.rect.height }} dangerouslySetInnerHTML={{ __html: f.svg }} />
      {interactive && f.hotspots.map((h) => spot(h, none))}
    </>
  );
}

/** A scrolling box: a div that scrolls the children's picture, with the hotspots and the
 *  scrolling boxes inside it so they move with the content. */
function ScrollerView({
  s,
  origin,
  interactive,
  scrolls,
  scrollEls,
  spot,
  click,
}: {
  s: ScrollerScene;
  origin: Rect;
  interactive: boolean;
  scrolls: Scrolls;
  scrollEls: ScrollEls;
  spot: (h: Hotspot, origin: Rect) => React.ReactNode;
  click: (chain: string[]) => boolean;
}) {
  const h = s.overflow === "horizontal" || s.overflow === "both";
  const v = s.overflow === "vertical" || s.overflow === "both";
  const ox = s.content.x - s.rect.x;
  const oy = s.content.y - s.rect.y;
  return (
    <div
      className="scroller"
      data-scroller={s.id}
      ref={(el) => {
        // The screen that is leaving draws scrollers too; only the live one may be scrolled to.
        if (interactive) {
          if (!el) return scrollEls.current.delete(s.id);
          scrollEls.current.set(s.id, el);
        }
        if (!el) return;
        const at = scrolls.current.pos.get(s.id);
        if (at) {
          el.scrollLeft = at.left;
          el.scrollTop = at.top;
        }
      }}
      style={{ left: s.rect.x - origin.x, top: s.rect.y - origin.y, width: s.rect.width, height: s.rect.height, overflowX: h ? "auto" : "hidden", overflowY: v ? "auto" : "hidden", borderRadius: s.radius }}
      onScroll={(e) => scrolls.current.pos.set(s.id, { left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop })}
      onClick={(e) => {
        // The empty area of the box acts as the box's own layer (or the nearest one above it).
        if (interactive && click(s.chain)) e.stopPropagation();
      }}
    >
      <div style={{ position: "relative", width: Math.max(s.rect.width, ox + s.content.width), height: Math.max(s.rect.height, oy + s.content.height) }}>
        <div style={{ position: "absolute", left: ox, top: oy, width: s.content.width, height: s.content.height, pointerEvents: "none" }} dangerouslySetInnerHTML={{ __html: s.content.svg }} />
        {interactive && s.hotspots.map((hs) => spot(hs, s.rect))}
        {s.scrollers.map((n) => (
          <Fragment key={n.id}>
            <ScrollerView s={n} origin={s.rect} interactive={interactive} scrolls={scrolls} scrollEls={scrollEls} spot={spot} click={click} />
            {n.above && <AboveView a={n.above} origin={s.rect} interactive={interactive} spot={spot} />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** Prototype links come from shared files: only web, email and phone links may open (never
 *  `javascript:` or `data:`). Mirrors the engine's `safe_link`. */
export function safeLink(url: string): string | null {
  const u = url.replace(/[\u0000- \u007f]/g, "");
  return /^(https?:\/\/|mailto:|tel:)/i.test(u) ? u : null;
}
