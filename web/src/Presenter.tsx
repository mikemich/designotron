import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, RotateCcw, Settings2, X } from "lucide-react";
import { toast, useStore } from "./store";
import type { Interaction, OverlaySettings, Rect } from "./types";
import { REPO_URL } from "./panels/GuestBar";
import { DEFAULT_OVERLAY, overlayBox, overlayDim, TRIGGER_LABELS } from "./prototype";
import { loadPrefs, savePrefs } from "./presenterPrefs";
import { focusedByPointer } from "./ui/controls";
import { canFullscreen, exitFullscreenIfInside, isFullscreenIn, toggleFullscreen } from "./fullscreen";
import {
  buildScene,
  buildSceneWithout,
  carryScroll,
  changeTarget,
  closePlayer,
  frozenSide,
  INSTANT,
  keepsOldScreen,
  keyName,
  liveSide,
  motionAnimation,
  motionOf,
  pdoc,
  playerRevision,
  pq,
  reverseMotion,
  scrollersOf,
  slide,
  swapVariant,
  type AboveScene,
  type Backdrop,
  type FixedScene,
  type Hotspot,
  type Motion,
  type Scene,
  type ScrollerScene,
  type StickyScene,
} from "./player";
import { linear, type Ease } from "./easing";
import {
  completes,
  DRAG_SLOP,
  dragAxis,
  dragProgress,
  matchTrees,
  measure,
  planSmart,
  ramp,
  rubberBand,
  smartVector,
  SmartTween,
  stickyShift,
  stickyOffset,
  touchActionFor,
  velocityAlong,
  type SmartPlan,
  type Vec,
} from "./smart";

/** Undoes what an interaction did (While hovering / While pressing). */
type Revert = () => void;

/** A screen the player has been on, and how it was entered (Back plays that in reverse). */
interface Entry {
  id: string;
  via: Motion;
}

/** An open overlay; `x`/`y` place it on the base frame and `w`/`h` are its box there (an overlay
 *  bigger than the screen is limited to it and scrolls inside). */
interface OpenOverlay {
  key: number;
  id: string;
  settings: OverlaySettings;
  motion: Motion;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A change of screen in progress: the screen that is leaving and how it plays. */
interface Leaving {
  key: number;
  id: string;
  motion: Motion;
  /** Where the leaving screen's scrollers were, so it doesn't jump to the top while it goes. */
  pos: Map<string, { left: number; top: number }>;
  /** A drag drives the two screens' animations (they start paused). */
  manual?: boolean;
}

/** A smart animate in progress: the plan of its pieces and what is drawn under them. */
interface Smart {
  key: number;
  motion: Motion;
  plan: SmartPlan;
  /** The rest of the screen, for a Change to (the new screen is hidden while the pieces play). */
  backdrop?: React.ReactNode;
  /** A drag drives the tween instead of a clock. */
  manual?: boolean;
  /** Pieces inside this overlay: they show over the overlays and its own picture is hidden. */
  overlay?: number;
}

/** A change a drag is following: progress 0 is where it started, 1 is done. */
interface Manual {
  /** The vector (frame pixels) the change travels along. */
  vec: Vec;
  set: (v: number) => void;
  ramp: (to: 0 | 1, ms: number, ease: Ease) => Promise<unknown>;
  /** The change stays: the animation layers go. */
  settle: () => void;
  /** Puts everything back as it was. */
  revert: Revert;
  ms: number;
  ease: Ease;
  /** Stops a ramp that is running (a restart or the player closing cut the release off). */
  cancel?: () => void;
}

/** A drag drives the screen animations: they start paused (one `animation` value, so the shorthand isn't mixed with a longhand). */
const paused = (a: string | undefined, manual?: boolean) => (a && manual ? `${a} paused` : a);

const DIR_VEC: Record<string, Vec> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

/** The box `r` of `a` and `b` where both overlap (null when they don't). */
const overlap = (a: Rect | null, b: Rect): Rect | null => {
  if (!a) return b;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.width, b.x + b.width) - x;
  const h = Math.min(a.y + a.height, b.y + b.height) - y;
  return { x, y, width: Math.max(0, w), height: Math.max(0, h) };
};

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
/** Keyboard presses in progress (a hotspot's key is down). Each entry removes its own listeners
 *  without running its release; the presenter closing or restarting calls them all. */
const keyPresses = new Set<() => void>();
function cancelKeyPresses() {
  for (const stop of [...keyPresses]) stop();
  keyPresses.clear();
}
/** The pointer id a key press uses (real pointers are never negative). */
const KEY_POINTER = -1;
/** Where the pointer last was (window coordinates); null until it first moves. A screen that appears
 *  under a still pointer gets boundary events from the browser: hover waits for real movement from here. */
let lastPointer: { x: number; y: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("pointermove", (e) => (lastPointer = { x: e.clientX, y: e.clientY }), { capture: true, passive: true });
}
/** Pointer movement that counts as real: at least this far (px) from where the screen appeared. */
const HOVER_ARM_DISTANCE = 1;
const within = (b: DOMRect, x: number, y: number) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

/** The presenter's polite live region; `setter.current` sets what it says. */
function LiveRegion({ setter }: { setter: { current: (text: string) => void } }) {
  const [said, setSaid] = useState("");
  setter.current = setSaid;
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-presenter-live="">
      {said}
    </div>
  );
}

/** Prototype player: renders a frame and turns interactions into hotspots, with overlays
 *  (modals, menus) stacked on top. With `remixUrl` it is the view-only player for view links
 *  and embeds: no close, a Remix button instead. */
export function Presenter({ start, remixUrl }: { start: string; remixUrl?: string }) {
  const [history, setHistory] = useState<Entry[]>([{ id: start, via: INSTANT }]);
  // Open overlays, topmost last. Navigating to another frame closes them all.
  const [overlays, setOverlays] = useState<OpenOverlay[]>([]);
  const overlayKey = useRef(0);
  const [flash, setFlash] = useState(false);
  // Options (remembered per browser) and the menu that sets them.
  const [prefs, setPrefs] = useState(loadPrefs);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(false);
  menuRef.current = menu;
  const menuId = useId();
  // Moves on every restart (R): screens, scrollers and timers start over even on the same frame.
  const [restarts, setRestarts] = useState(0);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [full, setFull] = useState(false);
  const [smart, setSmart] = useState<Smart | null>(null);
  const motionKey = useRef(0);
  const smartCtl = useRef<SmartTween | null>(null);
  // The drag in progress (calling it cancels it) and the revert of a While pressing that is held.
  const dragging = useRef<(() => void) | null>(null);
  const pressUndo = useRef<(() => void) | null>(null);
  // Moves when the player's own engine changes (a Change to), so scenes are rebuilt.
  const [revision, setRevision] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = history[history.length - 1];
  const doc = pdoc();
  const frame = doc.nodes[current.id];
  // What a screen reader is told: the frame's name whenever the frame changes (Navigate, Back, Swap,
  // Restart), "<overlay> opened" and "Changed to <variant>". Not on scroll. Emptied first so the same
  // words twice in a row (a restart on the start frame) are still spoken.
  // The words live in their own component: a state change here would re-render the whole player, and
  // a re-render restores every scroller to its stored position, which stops a smooth scroll half way.
  const setSaid = useRef<(text: string) => void>(() => {});
  const saidTimer = useRef(0);
  const say = (text: string, wait = 60) => {
    setSaid.current("");
    clearTimeout(saidTimer.current);
    saidTimer.current = window.setTimeout(() => setSaid.current(text), wait);
  };
  useEffect(() => () => clearTimeout(saidTimer.current), []);
  // The first run is the start frame, once the dialog has taken focus (which announces the dialog itself).
  const firstSay = useRef(true);
  useEffect(() => {
    const name = pdoc().nodes[current.id]?.name;
    if (name) say(name, firstSay.current ? 400 : 60);
    firstSay.current = false;
  }, [current.id, restarts]);
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
  // Preserve scroll position: where the next screen starts, set by the navigation that opens it.
  const carried = useRef<Map<string, { left: number; top: number }> | null>(null);
  const scrollKey = `${history.length}:${restarts}`;
  if (scrolls.current.key !== scrollKey) {
    scrolls.current = { key: scrollKey, pos: carried.current ?? new Map() };
    carried.current = null;
  }

  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!frame) return;
    const fit = () => setScale(Math.min(1, (window.innerWidth - 80) / frame.width, (window.innerHeight - 100) / frame.height));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [current.id]);
  useEffect(() => closePlayer, []);

  /** The motion that really plays: none with reduced motion. */
  const playable = (m: Motion): Motion => (reducedMotion() ? INSTANT : m);

  /** Starts a change of screen from `from` (the screen that goes away) to `to`. A smart animate
   *  that is too big to animate dissolves. With `manual` the animation waits for a drag. */
  const startMotion = (from: string, to: string, m: Motion, manual = false) => {
    let motion = playable(m);
    setSmart(null);
    if (motion.kind === "instant") return setLeaving(null);
    const key = ++motionKey.current;
    if (motion.kind === "smart") {
      const plan = planSmart(liveSide(from), liveSide(to));
      if (plan) setSmart({ key, motion, plan, manual });
      else motion = { ...motion, kind: "dissolve" };
    }
    setLeaving({ key, id: from, motion, pos: new Map(scrolls.current.pos), manual });
  };

  const navigate = (id: string, m: Motion, keepScroll = false, manual = false) => {
    // The new screen starts where this one is scrolled (a destination without scrollers ignores it).
    if (keepScroll && doc.nodes[id]) carried.current = carryScroll(sceneFor(current.id), sceneFor(id), scrolls.current.pos);
    setOverlays([]);
    startMotion(current.id, id, m, manual);
    setHistory((h) => [...h, { id, via: m }]);
  };
  /** R: back to the start screen with nothing open, as if the prototype had just been opened. */
  const restart = () => {
    hovering.current?.();
    pressing.current?.();
    dragging.current?.();
    cancelKeyPresses();
    carried.current = null;
    closePlayer();
    setLeaving(null);
    setSmart(null);
    setOverlays([]);
    setHistory([{ id: start, via: INSTANT }]);
    setRestarts((r) => r + 1);
    setRevision((r) => r + 1);
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
    // A smart animate ends with its tween; a drag ends the change itself.
    if (leaving.manual || smart?.key === leaving.key) return;
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
      return changeVariant(it, source, inFrame)?.undo ?? null;
    } else if (it.action === "navigate" && it.destination && doc.nodes[it.destination]) {
      const undo = snapshot();
      navigate(it.destination, motionOf(it), it.preserveScroll);
      return undo;
    } else if (it.action === "closeOverlay") setOverlays((o) => o.slice(0, -1));
    else if ((it.action === "openOverlay" || it.action === "swapOverlay") && it.destination && frame) {
      const dest = doc.nodes[it.destination];
      if (!dest) return null;
      const settings = it.overlay ?? DEFAULT_OVERLAY;
      const box = overlayBox(settings, frame, dest, from);
      const next: OpenOverlay = { key: ++overlayKey.current, id: dest.id, settings, motion: playable(motionOf(it)), x: box.x, y: box.y, w: box.width, h: box.height };
      if (it.action === "swapOverlay" && it.preserveScroll && overlays.length) {
        // The overlay that replaces the top one starts scrolled where it was.
        const old = overlays[overlays.length - 1];
        for (const [id, at] of carryScroll(sceneFor(old.id), sceneFor(dest.id), scrolls.current.pos)) scrolls.current.pos.set(id, at);
        const own = scrolls.current.pos.get(`ov:${old.key}`);
        if (own) scrolls.current.pos.set(`ov:${next.key}`, own);
      }
      const undo = snapshot();
      setOverlays((o) => (it.action === "swapOverlay" ? [...o.slice(0, -1), next] : [...o, next]));
      say(`${dest.name} opened`);
      return undo;
    }
    return null;
  };

  /** Change to: the instance holding `source` switches to another variant of its set, in place.
   *  Smart animate draws the old and the new state's layers moving into each other; `manual` leaves
   *  that to a drag. */
  const changeVariant = (it: Interaction, source: string, inFrame: string, manual = false): { undo: Revert; smart: Smart | null } | null => {
    const instance = changeTarget(source, it.destination!);
    const before = instance ? pdoc().nodes[instance]?.instance?.componentId : null;
    if (!instance || !before || before === it.destination) return null;
    const m = playable(motionOf(it));
    const sc = sceneFor(inFrame);
    // Smart animate on the visible screen, or in the top overlay.
    const topO = overlays.length ? overlays[overlays.length - 1] : null;
    const onBase = inFrame === current.id && !overlays.length;
    const inTop = !!topO && topO.id === inFrame;
    const smartOk = m.kind === "smart" && (onBase || inTop);
    // The old state is drawn from a copy of the engine taken before the swap.
    const frozen = smartOk ? frozenSide(instance) : null;
    const posBefore = new Map(scrolls.current.pos);
    const inner = scrollersOf(sc, instance);
    const sticky = (pos: Map<string, { left: number; top: number }>) => stickyAmount(sc, instance, inFrame, pos);
    const stickyA = frozen ? sticky(posBefore) : 0;
    if (!swapVariant(instance, it.destination!)) {
      frozen?.free();
      return null;
    }
    // Preserve scroll position: the variant's scrollers start where the old ones were.
    if (it.preserveScroll) for (const [id, at] of carryScroll(sc, sceneFor(inFrame), scrolls.current.pos)) scrolls.current.pos.set(id, at);
    let sm: Smart | null = null;
    if (frozen) {
      const fb = pq<{ union: Rect }>({ q: "bounds", ids: [inFrame] }).union;
      const ib = pq<{ union: Rect }>({ q: "bounds", ids: [instance] }).union;
      const off = (pos: Map<string, { left: number; top: number }>, dy: number): Vec => {
        let x = 0;
        let y = 0;
        for (const s of inner) {
          const p = pos.get(s.id);
          x -= p?.left ?? 0;
          y -= p?.top ?? 0;
        }
        const ov = topO && inTop ? pos.get(`ov:${topO.key}`) : null;
        return { x: x - (ov?.left ?? 0), y: stickyOffset(y - (ov?.top ?? 0), dy) };
      };
      const shiftX = topO && inTop ? topO.x : 0;
      const shiftY = topO && inTop ? topO.y : 0;
      let clip: Rect | null = topO && inTop ? { x: topO.x, y: topO.y, width: topO.w, height: topO.h } : null;
      for (const s of inner) clip = overlap(clip, { ...s.rect, x: s.rect.x + shiftX, y: s.rect.y + shiftY });
      const A = off(posBefore, stickyA);
      const B = off(scrolls.current.pos, sticky(scrolls.current.pos));
      let plan: ReturnType<typeof planSmart> = null;
      try {
        plan = planSmart(frozen.side, liveSide(instance), {
          at: { x: ib.x - fb.x + shiftX, y: ib.y - fb.y + shiftY },
          offsetA: A,
          offsetB: B,
          clip,
        });
      } finally {
        // The old state's engine copy has drawn what it was needed for.
        frozen.free();
      }
      if (plan) {
        const rest = buildSceneWithout(inFrame, [instance]);
        const pos = new Map(scrolls.current.pos);
        const view = (
          <SceneView scene={rest} flash={false} interactive={false} scrolls={{ current: { key: "", pos } }} scrollEls={scrollEls} />
        );
        const n = pdoc().nodes[inFrame];
        const backdrop =
          topO && inTop ? (
            <div style={{ position: "absolute", left: topO.x, top: topO.y, width: topO.w, height: topO.h, overflow: "hidden" }}>
              <div style={{ position: "relative", left: -(pos.get(`ov:${topO.key}`)?.left ?? 0), top: -(pos.get(`ov:${topO.key}`)?.top ?? 0), width: n.width, height: n.height }}>{view}</div>
            </div>
          ) : (
            view
          );
        const key = ++motionKey.current;
        sm = { key, motion: m, plan, backdrop, manual, overlay: inTop ? topO!.key : undefined };
        setSmart(sm);
        setLeaving({ key, id: inFrame, motion: { ...m, kind: "dissolve" }, pos: new Map(), manual });
      }
    }
    setRevision((r) => r + 1);
    // A drag says it when the change is kept (a snap-back says nothing).
    if (!manual) say(`Changed to ${pdoc().nodes[it.destination!]?.name ?? "another variant"}`);
    return {
      smart: sm,
      undo: () => {
        if (swapVariant(instance, before)) setRevision((r) => r + 1);
      },
    };
  };

  /** How far a sticky layer holding `instance` is pushed down by a scroller's position (0 when none). */
  const stickyAmount = (sc: Scene, instance: string, inFrame: string, pos: Map<string, { left: number; top: number }>): number => {
    const d = pdoc();
    const chain: string[] = [];
    for (let at: string | null = instance; at && at !== inFrame; at = (d.nodes[at]?.parent as string | null | undefined) ?? null) chain.push(at);
    for (const id of chain) {
      const n = d.nodes[id];
      if (n?.scrollBehavior !== "sticky" || !n.parent) continue;
      const s = scrollersOf(sc, id)[0];
      if (!s || (s.overflow !== "vertical" && s.overflow !== "both")) return 0;
      const items = pq<{ union: Rect; items: { id: string; bounds: Rect }[] }>({ q: "bounds", ids: [id, n.parent] }).items;
      const box = items.find((i) => i.id === id)?.bounds;
      const parent = items.find((i) => i.id === n.parent)?.bounds;
      if (!box || !parent) return 0;
      const frameAt = pq<{ union: Rect }>({ q: "bounds", ids: [inFrame] }).union;
      return stickyShift(pos.get(s.id)?.top ?? 0, box.y - frameAt.y, s.rect.y, box.y + box.height - frameAt.y, parent.y + parent.height - frameAt.y);
    }
    return 0;
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
      pressUndo.current = null;
    };
    const release = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      stop();
      undo();
      // A layer with both "While pressing" and "On click": the release over the layer is the tap,
      // so the click runs once the press is put back (not when the press is cancelled).
      if (tap && e.type === "pointerup" && (within(tap.box, e.clientX, e.clientY) || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < TAP_SLOP)) tap.act();
      armSwallow();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    pressing.current = stop;
    // A drag that starts puts the press back itself (no tap).
    pressUndo.current = () => {
      stop();
      undo();
    };
  };
  /** The click the browser sends after a press or drag that was released is ignored, so it can't
   *  run another link. A mouse release sends no click into the player (the layer under the pointer
   *  was replaced), so the next pointerdown, which starts a real click, disarms the swallow too. */
  const armSwallow = () => {
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

  // ---- On drag ----
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const vecCache = useRef({ rev: -1, map: new Map<string, Vec | null>() });
  /** The vector a drag of `it` on `source` moves things along (frame pixels), or null when there is
   *  none to follow. Reads layer data and bounds, draws nothing; cached per player revision. */
  const dragVec = (it: Interaction, source: string, inFrame: string): Vec | null => {
    const rev = playerRevision();
    if (vecCache.current.rev !== rev) vecCache.current = { rev, map: new Map() };
    const key = [it.action, it.destination, it.transition, it.direction, source, inFrame].join("|");
    const cache = vecCache.current.map;
    if (cache.has(key)) return cache.get(key)!;
    let out: Vec | null = null;
    const m = motionOf(it);
    const d = pdoc();
    if (it.action === "navigate" && it.destination && d.nodes[it.destination]) {
      const fr = d.nodes[inFrame];
      const to = d.nodes[it.destination];
      if (m.kind === "smart") {
        const mt = matchTrees(d.nodes, inFrame, d.nodes, it.destination);
        out = smartVector(mt, measure(liveSide(inFrame), liveSide(it.destination), mt), source);
      } else if (m.kind === "push" || m.kind === "moveIn" || m.kind === "moveOut" || m.kind === "slide") {
        const dir = DIR_VEC[m.dir];
        out = { x: dir.x * (dir.x ? to.width || fr.width : 0), y: dir.y * (dir.y ? to.height || fr.height : 0) };
      }
    } else if (it.action === "changeTo" && it.destination && m.kind === "smart") {
      const inst = changeTarget(source, it.destination);
      if (inst && d.nodes[it.destination]) {
        const mt = matchTrees(d.nodes, inst, d.nodes, it.destination);
        out = smartVector(mt, measure(liveSide(inst), liveSide(it.destination), mt), source);
      }
    }
    cache.set(key, out);
    return out;
  };

  /** Starts the change a drag follows. Null when the action ran once instead (no vector to follow,
   *  an instant or dissolve, reduced motion, an action that isn't a screen change). */
  const beginManual = (it: Interaction, from: Rect, source: string, inFrame: string): Manual | null => {
    const m = playable(motionOf(it));
    const vec = m.kind === "instant" ? null : dragVec(it, source, inFrame);
    const base = inFrame === current.id && !overlays.length;
    if (vec && it.action === "navigate" && it.destination && base) {
      const back = snapshot();
      // A snap-back puts the screen back as it was, scrolled where it was.
      const pos = new Map(scrolls.current.pos);
      const undo = () => {
        carried.current = pos;
        back();
      };
      const dest = it.destination;
      flushSync(() => navigate(dest, m, it.preserveScroll, true));
      if (m.kind === "smart") {
        const tw = smartCtl.current;
        if (tw) return { vec, set: (v) => tw.seek(v, linear), ramp: (to, ms, ease) => tw.play(to, ms, ease), settle: finishMotion, revert: undo, ms: m.ms, ease: m.ease };
        // Too big to animate: it dissolved instead; the change has happened.
        flushSync(finishMotion);
        return null;
      }
      // Both screens' own animations, paused and scrubbed with the pointer.
      const stages = [...(rootRef.current?.querySelectorAll<HTMLElement>(".presenter-viewport .stage") ?? [])];
      const anims = stages.flatMap((el) => el.getAnimations());
      for (const a of anims) {
        a.pause();
        const fx = a.effect as KeyframeEffect | null;
        // Linear while dragging: the effect's own easing and the one each keyframe interval carries.
        fx?.updateTiming({ easing: "linear", fill: "both", duration: m.ms });
        fx?.setKeyframes(fx.getKeyframes().map((k) => ({ ...k, easing: "linear" })));
      }
      let at = 0;
      const set = (v: number) => {
        at = Math.min(1, Math.max(0, v));
        for (const a of anims) a.currentTime = at * m.ms;
      };
      set(0);
      let running: ReturnType<typeof ramp> | null = null;
      return {
        vec,
        set,
        ramp: (to, ms, ease) => (running = ramp(at, to, ms, ease, set)).done,
        cancel: () => running?.cancel(),
        settle: finishMotion,
        revert: undo,
        ms: m.ms,
        ease: m.ease,
      };
    }
    if (vec && it.action === "changeTo" && m.kind === "smart") {
      const held: { r: ReturnType<typeof changeVariant> } = { r: null };
      flushSync(() => {
        held.r = changeVariant(it, source, inFrame, true);
      });
      const r = held.r;
      if (!r) return null;
      const tw = smartCtl.current;
      if (r.smart && tw) {
        return {
          vec,
          set: (v) => tw.seek(v, linear),
          ramp: (to, ms, ease) => tw.play(to, ms, ease),
          settle: () => {
            finishMotion();
            say(`Changed to ${pdoc().nodes[it.destination!]?.name ?? "another variant"}`);
          },
          revert: () => {
            finishMotion();
            r.undo();
          },
          ms: m.ms,
          ease: m.ease,
        };
      }
      return null;
    }
    go(it, from, source, inFrame);
    return null;
  };
  /** The animation layers go; what the change did stays. */
  const finishMotion = () => {
    setLeaving(null);
    setSmart(null);
  };

  /** A press on a layer with On drag: after DRAG_SLOP screen pixels it becomes a drag that the
   *  change follows; a release at half way or with a flick completes it, otherwise it snaps back. */
  const dragStart = (it: Interaction, from: Rect, source: string, inFrame: string, pointerId: number, x0: number, y0: number) => {
    if (dragging.current) return;
    const samples: { t: number; x: number; y: number }[] = [{ t: performance.now(), x: x0, y: y0 }];
    let manual: Manual | null | undefined; // undefined: still a press
    let once = false; // the action ran once at the slop
    let at = 0;
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      if (samples.length > 30) samples.shift();
      if (once) return;
      if (manual === undefined) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < DRAG_SLOP) return;
        // The drag takes over: a While pressing on the layer is put back first.
        pressUndo.current?.();
        manual = beginManual(it, from, source, inFrame);
        if (!manual) {
          // Done; the click that follows the release is swallowed when the pointer comes up.
          once = true;
          return;
        }
      }
      if (!manual) return;
      const k = scaleRef.current || 1;
      at = rubberBand(dragProgress({ x: (e.clientX - x0) / k, y: (e.clientY - y0) / k }, manual.vec));
      manual.set(at);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      stop();
      const mm = manual;
      if (!mm) {
        dragging.current = null;
        if (once) armSwallow();
        return;
      }
      armSwallow();
      const len = Math.hypot(mm.vec.x, mm.vec.y) || 1;
      const speed = velocityAlong(samples, { x: mm.vec.x / len, y: mm.vec.y / len });
      const p = Math.min(1, Math.max(0, at));
      const done = e.type === "pointerup" && completes(p, speed);
      // A restart or the player closing cuts the release off: then nothing is settled or reverted.
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        mm.cancel?.();
        // A later drag must be able to start (a restart doesn't close the player).
        if (dragging.current === cancel) dragging.current = null;
      };
      dragging.current = cancel;
      const end = (reached: unknown, then: () => void) => {
        if (!cancelled && reached !== false) then();
        if (!cancelled) dragging.current = null;
      };
      if (done) mm.ramp(1, (1 - p) * mm.ms, mm.ease).then((r) => end(r, mm.settle));
      else mm.ramp(0, p * mm.ms, mm.ease).then((r) => end(r, mm.revert));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    dragging.current = () => {
      stop();
      dragging.current = null;
    };
  };

  useEffect(
    () => () => {
      pressing.current?.();
      disarmSwallow.current?.();
      hovering.current?.();
      dragging.current?.();
      cancelKeyPresses();
    },
    [],
  );
  // Test hook: freeze the running smart animate at a moment and read what it draws.
  useEffect(() => {
    const dt = ((globalThis as any).__dt ??= {});
    dt.smart = { seek: (p: number) => smartCtl.current?.seek(p), state: () => smartCtl.current?.state() ?? null, variant: (id: string) => pdoc().nodes[id]?.instance?.componentId ?? null, name: (id: string) => pdoc().nodes[id]?.name ?? null };
    return () => {
      delete dt.smart;
    };
  }, []);

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
  }, [history.length, current.id, restarts]);

  // Focus moves into the player (Tab stays inside) and goes back to the opener on exit.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => {
      if (before?.isConnected) before.focus?.();
    };
  }, []);
  // A keyboard-activated hotspot that leaves the screen or opens an overlay takes its focus with
  // it: put it back in the player, so Tab stays inside. (Declared after the opener effect, which
  // must see the opener focused when the player mounts.)
  useEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  }, [history.length, overlays.length, revision]);

  // Keys: a Key interaction of the top overlay, else of the base frame, wins; otherwise Escape
  // closes and the arrows step through the page's frames.
  const keys = useRef({ scene, top, frames, current, overlays });
  keys.current = { scene, top, frames, current, overlays };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape with the options open closes only them.
      if (e.key === "Escape" && menuRef.current) {
        e.preventDefault();
        setMenu(false);
        return;
      }
      // Escape in full screen only leaves full screen (the browser usually takes it before the page).
      if (e.key === "Escape" && isFullscreenIn(rootRef.current)) {
        e.preventDefault();
        void toggleFullscreen(rootRef.current);
        return;
      }
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
      // R starts over (after the screens' own Key triggers, so a frame can keep R for itself).
      if (name === "R" && !t?.closest(".bar-menu")) {
        e.preventDefault();
        restartRef.current();
        return;
      }
      // F toggles full screen, after the screens' own Key triggers like R.
      if (name === "F" && canFullscreen() && !t?.closest(".bar-menu")) {
        e.preventDefault();
        fullRef.current();
        return;
      }
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
  const fullRef = useRef(() => {});
  fullRef.current = () => {
    void toggleFullscreen(rootRef.current).then((ok) => {
      if (!ok) toast("Full screen isn't available here");
    });
  };
  // Full screen follows the browser (Escape, F11, the system): the button's state and the fit. Closing the
  // presenter leaves full screen.
  useEffect(() => {
    const el = rootRef.current;
    const onChange = () => {
      setFull(isFullscreenIn(rootRef.current));
      window.dispatchEvent(new Event("resize"));
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      exitFullscreenIfInside(el);
    };
  }, []);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const restartRef = useRef(restart);
  restartRef.current = restart;

  if (!frame || !scene) return null;
  const hasHotspots = scene.all.size > 0;
  // Tab: the bar first, then the hotspots top to bottom and left to right (the order they have on
  // screen, not the order they were drawn in), wrapping at the ends.
  const trapTab = (e: React.KeyboardEvent) => {
    const root = rootRef.current;
    if (e.key !== "Tab" || !root) return;
    const all = [...root.querySelectorAll<HTMLElement>('button, a[href], input, .hotspot[tabindex="0"]')];
    const spots = all
      .filter((el) => !el.closest(".bar"))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
      .map((x) => x.el);
    const els = [...all.filter((el) => el.closest(".bar")), ...spots];
    const at = document.activeElement as HTMLElement | null;
    const i = at ? els.indexOf(at) : -1;
    if (!els.length) return e.preventDefault();
    if (i < 0 && at !== root) return;
    e.preventDefault();
    const last = els.length - 1;
    els[e.shiftKey ? (i <= 0 ? last : i - 1) : i < 0 || i === last ? 0 : i + 1].focus();
  };

  const crumb = frame.name + (top ? ` › ${doc.nodes[top.id]?.name ?? ""}` : "");
  const m = leaving?.motion;
  const old = leaving && m && keepsOldScreen(m) && pdoc().nodes[leaving.id] ? leaving : null;
  // The scale sits on a wrapper so the move/push keyframes (which set `transform`) can run on
  // the stage itself without dropping it.
  const curStage = (
    <div
      key={"s" + history.length + ":" + restarts}
      style={{ position: "absolute", left: 0, top: 0, width: frame.width, height: frame.height, transform: `scale(${scale})`, transformOrigin: "0 0", zIndex: m?.kind === "moveOut" ? 0 : 1 }}
    >
      <div
        className="stage"
        style={{ width: frame.width, height: frame.height, animation: m ? paused(motionAnimation(m, true), leaving?.manual) : undefined, visibility: smart && smart.overlay === undefined ? "hidden" : undefined }}
      >
        <SceneView
          scene={scene}
          flash={flash}
          interactive={!smart || smart.overlay !== undefined}
          tabbable={!smart && overlays.length === 0}
          scrolls={scrolls}
          scrollEls={scrollEls}
          onAct={(h, it) => go(it, h.rect, h.id, current.id)}
          onHover={hover}
          onPress={(h, it, pointerId, tap) => press(it, h.rect, h.id, current.id, pointerId, tap)}
          onDrag={(h, it, pointerId, x, y) => dragStart(it, h.rect, h.id, current.id, pointerId, x, y)}
          dragVec={(h, it) => dragVec(it, h.id, current.id)}
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
      <div className="stage stage-leaving" style={{ width: pdoc().nodes[old.id].width, height: pdoc().nodes[old.id].height, animation: paused(motionAnimation(old.motion, false), old.manual) }}>
        <SceneView scene={sceneFor(old.id)} flash={false} interactive={false} scrolls={{ current: { key: "", pos: old.pos } }} scrollEls={scrollEls} />
      </div>
    </div>
  );
  return (
    <div
      ref={rootRef}
      className={"presenter" + (prefs.always ? " hints-always" : "")}
      role="dialog"
      aria-modal="true"
      aria-label={`Prototype: ${frame.name}`}
      tabIndex={-1}
      onKeyDown={trapTab}
      onClick={() => {
        // A click that lands on nothing flashes the clickable areas (when hints are on).
        setMenu(false);
        if (!hasHotspots || !prefs.hints) return;
        setFlash(true);
        setTimeout(() => setFlash(false), 400);
      }}
    >
      <LiveRegion setter={setSaid} />
      <div
        className="bar"
        onClick={(e) => {
          e.stopPropagation();
          // Any other button of the bar closes the options.
          if (!(e.target as Element).closest(".bar-menu")) setMenu(false);
        }}
      >
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
        <button className="tbtn" title="Restart (R)" aria-label="Restart (R)" onClick={restart}>
          <RotateCcw size={16} />
        </button>
        <div
          className="bar-menu"
          onKeyDown={(e) => {
            // Escape closes the options (and only them) and gives focus back to their button.
            if (!menu || e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            setMenu(false);
            e.currentTarget.querySelector("button")?.focus();
          }}
          onBlur={(e) => {
            // Tabbing or clicking away closes it.
            if (menu && !e.currentTarget.contains(e.relatedTarget as Node | null)) setMenu(false);
          }}
        >
          <button className="tbtn" title="Presenter options" aria-label="Presenter options" aria-expanded={menu} aria-controls={menuId} onClick={() => setMenu((m) => !m)}>
            <Settings2 size={16} />
          </button>
          {menu && (
            <div className="bar-menu-list" id={menuId} role="group" aria-label="Presenter options">
              <label>
                <input type="checkbox" checked={prefs.hints} onChange={(e) => (setPrefs((p) => ({ ...p, hints: e.target.checked })), savePrefs({ hints: e.target.checked }))} />
                Show hotspot hints on click
              </label>
              <label>
                <input type="checkbox" checked={prefs.always} onChange={(e) => (setPrefs((p) => ({ ...p, always: e.target.checked })), savePrefs({ always: e.target.checked }))} />
                Always show hotspots
              </label>
            </div>
          )}
        </div>
        {canFullscreen() && (
          <button className="tbtn" title="Full screen (F)" aria-label="Full screen (F)" aria-pressed={full} onClick={() => fullRef.current()}>
            {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
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
      <div className="presenter-viewport" style={{ position: "relative", overflow: "hidden", width: frame.width * scale, height: frame.height * scale }}>
        {old && m?.kind !== "moveOut" && oldStage}
        {curStage}
        {old && m?.kind === "moveOut" && oldStage}
        {smart && (
          <SmartLayer
            key={smart.key}
            smart={smart}
            width={frame.width}
            height={frame.height}
            scale={scale}
            ctl={smartCtl}
            onDone={() => {
              setSmart((x) => (x?.key === smart.key ? null : x));
              setLeaving((x) => (x?.key === smart.key ? null : x));
            }}
          />
        )}
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
                onDrag={(h, it, pointerId, x, y) => dragStart(it, { ...h.rect, x: h.rect.x + o.x, y: h.rect.y + o.y }, h.id, o.id, pointerId, x, y)}
                dragVec={() => null}
                hidden={smart?.overlay === o.key}
                onDelay={(it, from) => goRef.current(it, from, o.id, o.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Smart animate: the layers of the old and new state, matched by name through frames, groups and
 *  instances, move, resize, recolour and fade into each other on one clock (see smart.ts). The real
 *  screen replaces this when it is done. */
function SmartLayer({ smart, width, height, scale, ctl, onDone }: { smart: Smart; width: number; height: number; scale: number; ctl: React.MutableRefObject<SmartTween | null>; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const tw = new SmartTween(host, smart.plan, smart.motion.ease);
    ctl.current = tw;
    tw.seek(0, linear);
    let live = true;
    if (!smart.manual) tw.play(1, smart.motion.ms, smart.motion.ease).then((reached) => reached && live && onDone());
    return () => {
      live = false;
      tw.cancel();
      if (ctl.current === tw) ctl.current = null;
    };
  }, []);
  return (
    <div className="smart-layer" style={{ position: "absolute", left: 0, top: 0, width, height, transform: `scale(${scale})`, transformOrigin: "0 0", pointerEvents: "none", zIndex: smart.overlay === undefined ? 3 : 6 }}>
      {smart.backdrop}
      <div ref={ref} style={{ position: "absolute", left: 0, top: 0, width, height }} />
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
  onDrag,
  dragVec,
  hidden,
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
  onDrag: (h: Hotspot, it: Interaction, pointerId: number, x: number, y: number) => void;
  dragVec: (h: Hotspot, it: Interaction) => Vec | null;
  /** A smart animate is drawing this overlay's pieces; its own picture waits. */
  hidden: boolean;
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
  // Bigger than the screen on an axis: the frame is limited to the screen and scrolls there.
  const clipX = n.width > o.w + 0.5;
  const clipY = n.height > o.h + 0.5;
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
      <div
        className={"overlay-frame" + (clipX || clipY ? " overlay-scrolls" : "")}
        data-overlay-frame={o.id}
        style={{ left: o.x, top: o.y, width: o.w, height: o.h, animation: a, overflowX: clipX ? "auto" : undefined, overflowY: clipY ? "auto" : undefined }}
        ref={(el) => {
          // An overlay swapped in with Preserve scroll position starts where the one it replaces was.
          const at = el && scrolls.current.pos.get(`ov:${o.key}`);
          if (el && at && !el.dataset.restored) {
            el.dataset.restored = "1";
            el.scrollLeft = at.left;
            el.scrollTop = at.top;
          }
        }}
        onScroll={(e) => scrolls.current.pos.set(`ov:${o.key}`, { left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop })}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ position: "relative", width: n.width, height: n.height, visibility: hidden ? "hidden" : undefined }}>
          <SceneView scene={scene} flash={false} interactive tabbable={isTop} scrolls={scrolls} scrollEls={scrollEls} onAct={onAct} onHover={onHover} onPress={onPress} onDrag={onDrag} dragVec={dragVec} />
        </div>
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
  /** A press on a layer with On drag (the owner, its drag and where the pointer went down). */
  onDrag?: (h: Hotspot, it: Interaction, pointerId: number, x: number, y: number) => void;
  /** The vector a drag moves things along, for the layer's `touch-action`. */
  dragVec?: (h: Hotspot, it: Interaction) => Vec | null;
}

/** A screen's picture, its scrolling boxes and fixed layers, and a hotspot per layer with
 *  interactions. Hotspots are siblings, so a layer without its own click runs its nearest
 *  ancestor's click, and pointer hover counts for every layer in the chain (entering a child is
 *  still hovering the parent). */
function SceneView({ scene, flash, interactive, tabbable, scrolls, scrollEls, onAct, onHover, onPress, onDrag, dragVec }: SceneProps) {
  const byId = scene.all;
  const is = (t: Interaction["trigger"]) => (i: Interaction) => i.trigger === t;
  // How many hotspots of each owner's chain the pointer is inside; fire on 0 → 1 and 1 → 0 only.
  const inside = useRef(new Map<string, number>());
  // Hover waits for real pointer movement after the screen appears (see the effect below). The hotspots
  // the pointer is in, so a boundary event the browser sends twice never counts twice.
  const armed = useRef(false);
  const entered = useRef(new Set<string>());
  const enter = (h: Hotspot) => {
    if (!armed.current || entered.current.has(h.id)) return;
    entered.current.add(h.id);
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
    if (!entered.current.delete(h.id)) return;
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
  const enterRef = useRef(enter);
  enterRef.current = enter;
  useEffect(() => {
    if (armed.current) return;
    const start = lastPointer ? { ...lastPointer } : null;
    const stop = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
    const arm = (x: number, y: number) => {
      stop();
      armed.current = true;
      // The pointer is over a layer that appeared under it: it is entered now.
      // Only the topmost hotspot, as the browser would: its chain covers the ancestors.
      const el = document.elementFromPoint(x, y)?.closest("[data-hotspot]");
      const id = el?.getAttribute("data-hotspot");
      const h = id && el?.getAttribute("data-scene") === scene.id ? byId.get(id) : undefined;
      if (h) enterRef.current(h);
    };
    const onMove = (e: PointerEvent) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < HOVER_ARM_DISTANCE) return;
      arm(e.clientX, e.clientY);
    };
    // A touch has no hovering: its press is real input at once.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") arm(e.clientX, e.clientY);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    return stop;
  }, []);
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
    const found = tabbable ? clickOf(h.chain) : null;
    // Only the layer that owns the click is a stop (a child inside it shares that stop).
    const hit = found && found.o.id === h.id ? found : null;
    const dest = hit?.c.destination ? pdoc().nodes[hit.c.destination]?.name : null;
    const name = pdoc().nodes[h.id]?.name;
    // A layer that only reacts to the press (On press, Mouse down, Mouse up) is a stop too: the
    // key goes down as the press and up as the release.
    const pressers = h.interactions.filter((i) => i.trigger === "onPress" || i.trigger === "mouseDown" || i.trigger === "mouseUp");
    const presser = !hit && tabbable && pressers.length ? pressers[0] : null;
    // A layer whose only pointer trigger is On drag is a stop too: Enter or Space plays the drag's action.
    const dragger = !hit && !presser && tabbable ? (h.interactions.find(is("onDrag")) ?? null) : null;
    // The browser keeps the pan along the other axis; the drag's own axis is ours.
    const owner = nearest(h.chain, "onDrag");
    const touchAction = owner && dragVec ? touchActionFor(dragAxis(dragVec(owner.o, owner.it))) : undefined;
    // Everything else (hover-only layers, layers that share an ancestor's click, anything under an
    // overlay) is pointer-only and hidden from assistive technology.
    const a11y = hit
      ? { tabIndex: 0, role: "button", "aria-label": name || (dest ? `Go to ${dest}` : "Button") }
      : presser
        ? { tabIndex: 0, role: "button", "aria-label": `${name || "Button"}, ${TRIGGER_LABELS[presser.trigger].toLowerCase()}` }
        : dragger
          ? { tabIndex: 0, role: "button", "aria-label": `${name || "Button"}, ${TRIGGER_LABELS.onDrag.toLowerCase()}` }
          : { "aria-hidden": true as const };
    const dragKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget || e.repeat || (e.key !== "Enter" && e.key !== " ") || !dragger) return;
      if (focusedByPointer(e.currentTarget)) return;
      e.preventDefault();
      e.stopPropagation();
      onAct?.(h, dragger);
    };
    const pressKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget || e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
      if (focusedByPointer(e.currentTarget)) return;
      e.preventDefault();
      e.stopPropagation();
      const key = e.key;
      const down = h.interactions.find(is("mouseDown"));
      if (down) onAct?.(h, down);
      const p = h.interactions.find(is("onPress"));
      if (p) onPress?.(h, p, KEY_POINTER);
      // The release is the key coming up, wherever focus is by then (a press that opens an overlay
      // moves it).
      const stop = () => {
        window.removeEventListener("keyup", release, true);
        window.removeEventListener("blur", release);
        keyPresses.delete(stop);
      };
      const release = (k: KeyboardEvent | FocusEvent) => {
        if (k instanceof KeyboardEvent && k.key !== key) return;
        stop();
        const up = h.interactions.find(is("mouseUp"));
        if (up) onAct?.(h, up);
        if (p) window.dispatchEvent(new PointerEvent("pointerup", { pointerId: KEY_POINTER, button: 0 }));
      };
      window.addEventListener("keyup", release, true);
      window.addEventListener("blur", release);
      keyPresses.add(stop);
    };
    return (
      <div
        key={h.id}
        className={"hotspot" + (flash ? " hint-flash" : "")}
        data-hotspot={h.id}
        data-scene={scene.id}
        {...a11y}
        onKeyDown={
          hit
            ? (e) => {
                if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                // A click that focused it keeps Enter and Space for the screen's Key triggers.
                if (focusedByPointer(e.currentTarget)) return;
                // This key is the hotspot's: no Key trigger or Escape handler also runs on it.
                e.preventDefault();
                e.stopPropagation();
                click(h.chain);
              }
            : presser
              ? pressKey
              : dragger
                ? dragKey
                : undefined
        }
        style={{ left: h.rect.x - origin.x, top: h.rect.y - origin.y, width: h.rect.width, height: h.rect.height, touchAction }}
        onClick={(e) => {
          e.stopPropagation();
          click(h.chain);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const down = nearest(h.chain, "mouseDown");
          if (down) onAct?.(down.o, down.it);
          // On drag: the press may become a drag (after a few pixels); the loop below still starts a press.
          const drag = nearest(h.chain, "onDrag");
          if (drag) onDrag?.(drag.o, drag.it, e.pointerId, e.clientX, e.clientY);
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

/** The live background blur behind a fixed or sticky layer: what scrolls under it is blurred. */
const backdropStyle = (b: Backdrop): React.CSSProperties => ({ backdropFilter: `blur(${b.blur}px)`, WebkitBackdropFilter: `blur(${b.blur}px)`, borderRadius: b.radius, pointerEvents: "none" });

/** A fixed layer: drawn above the scrolling box, never moves. */
function FixedView({ f, interactive, spot }: { f: FixedScene; interactive: boolean; spot: (h: Hotspot, origin: Rect) => React.ReactNode }) {
  const none: Rect = { x: 0, y: 0, width: 0, height: 0 };
  return (
    <>
      {f.backdrop && <div data-backdrop={f.id} style={{ position: "absolute", left: f.box.x, top: f.box.y, width: f.box.width, height: f.box.height, ...backdropStyle(f.backdrop) }} />}
      <div data-fixed={f.id} style={{ position: "absolute", left: f.rect.x, top: f.rect.y, width: f.rect.width, height: f.rect.height }} dangerouslySetInnerHTML={{ __html: f.svg }} />
      {interactive && f.hotspots.map((h) => spot(h, none))}
    </>
  );
}

/** A sticky layer: it scrolls with the content until its top reaches the top of the box, then
 *  stays there while its parent is in view. Pure CSS: a wrapper as tall as the layer's travel and
 *  a `position: sticky` element inside it (`data-sticky` marks it). The layers painted after it
 *  come next and scroll normally, so they cover it where they overlap. */
function StickyView({ t, origin, interactive, spot }: { t: StickyScene; origin: Rect; interactive: boolean; spot: (h: Hotspot, origin: Rect) => React.ReactNode }) {
  return (
    <>
      <div data-sticky-range={t.id} style={{ position: "absolute", left: t.box.x - origin.x, top: t.box.y - origin.y, width: t.box.width, height: t.limit - t.box.y, pointerEvents: "none" }}>
        <div data-sticky={t.id} style={{ position: "sticky", top: 0, width: t.box.width, height: t.box.height }}>
          {t.backdrop && <div data-backdrop={t.id} style={{ position: "absolute", inset: 0, ...backdropStyle(t.backdrop) }} />}
          <div style={{ position: "absolute", left: t.crop.x - t.box.x, top: t.crop.y - t.box.y, width: t.crop.width, height: t.crop.height, pointerEvents: "none" }} dangerouslySetInnerHTML={{ __html: t.svg }} />
          {interactive && <div style={{ pointerEvents: "auto" }}>{t.hotspots.map((h) => spot(h, t.box))}</div>}
        </div>
      </div>
      {t.above && <AboveView a={t.above} origin={origin} interactive={interactive} spot={spot} />}
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
        {s.sticky.map((t) => (
          <StickyView key={t.id} t={t} origin={s.rect} interactive={interactive} spot={spot} />
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
