import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Plus, Trash2 } from "lucide-react";
import { dispatch, query, useDoc, useSelection, useStore, type RightTab } from "../store";
import { DesignPanel } from "./DesignPanel";
import { CodePanel } from "./CodePanel";
import { ReviewPanel } from "./ReviewPanel";
import { AppPanel } from "./AppPanel";
import { focusedByPointer, IconButton, NumberField, Section, SelectField } from "../ui/controls";
import type { Direction, Easing, Interaction, Node, Overflow, OverlaySettings } from "../types";
import { DEFAULT_OVERLAY, enclosingSets, isMissingDestination, newInteraction, overlayDim, rememberMotion, SCREEN_TYPES, scrollTargets, startFrame, TRIGGER_LABELS } from "../prototype";
import { keyName } from "../player";
import { PanelClose } from "./PanelChrome";
import { useCollab } from "../collab";

const TABS: { id: RightTab; label: string }[] = [
  { id: "design", label: "Design" },
  { id: "prototype", label: "Prototype" },
  { id: "code", label: "Code" },
  { id: "review", label: "Review" },
  { id: "app", label: "App" },
];

export function RightPanel() {
  const tab = useStore((s) => s.rightTab);
  const set = (rightTab: RightTab) => useStore.setState({ rightTab });
  // A viewer, or a tab that only shows the file, can't edit: the Design and Prototype fields say so.
  const engineReadOnly = useStore((s) => !!s.es.readOnly);
  const viewer = useCollab((s) => s.viewer);
  const viewOnly = engineReadOnly || viewer;
  // Every control in a locked panel is disabled, so its scroll area is a focusable region of its own (keyboard scrolling).
  const lock = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    const el = lock.current?.firstElementChild as HTMLElement | null;
    if (!el || !viewOnly) return;
    el.tabIndex = 0;
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", tab === "design" ? "Design properties, view only" : "Prototype properties, view only");
    return () => {
      el.removeAttribute("tabindex");
      el.removeAttribute("role");
      el.removeAttribute("aria-label");
    };
  });
  // Arrow keys move between tabs (only the selected one is a Tab stop).
  const onKeyDown = (e: React.KeyboardEvent) => {
    // A tab that was clicked leaves the arrows to the design (they nudge the selection).
    if (focusedByPointer(e.target as Element)) return;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const home = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (!step && home < 0) return;
    // The editor's shortcuts must not take the arrows as a nudge of the selection.
    e.preventDefault();
    e.stopPropagation();
    const at = TABS.findIndex((t) => t.id === tab);
    const next = TABS[home >= 0 ? home : (at + step + TABS.length) % TABS.length];
    set(next.id);
    document.getElementById("right-tab-" + next.id)?.focus();
  };
  return (
    <aside className="panel right" id="panel-right" aria-label="Properties">
      <PanelClose side="right" />
      <div className="tabs" role="tablist" aria-label="Properties" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={"right-tab-" + t.id}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="right-tabpanel"
            tabIndex={tab === t.id ? 0 : -1}
            className={"tab" + (tab === t.id ? " active" : "")}
            onClick={() => set(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tabpanel" role="tabpanel" id="right-tabpanel" aria-labelledby={"right-tab-" + tab}>
        {/* The section titles below are level 3; this keeps the heading outline in order. */}
        <h2 className="sr-only">{TABS.find((t) => t.id === tab)?.label}</h2>
        {viewOnly && (tab === "design" || tab === "prototype") && (
          <div className="view-only-note" role="note">
            {viewer ? "View only. Copy values from the Code tab." : "Read-only: this file is open for editing in another tab."}
          </div>
        )}
        {(tab === "design" || tab === "prototype") && (
          // Always the same element, so a role change never remounts the panel (an open colour popover would lose its onClose).
          <fieldset ref={lock} disabled={viewOnly} className="panel-lock">
            {tab === "design" ? <DesignPanel /> : <PrototypePanel />}
          </fieldset>
        )}
        {tab === "code" && <CodePanel />}
        {tab === "review" && <ReviewPanel />}
        {tab === "app" && <AppPanel />}
      </div>
    </aside>
  );
}

function PrototypePanel() {
  const doc = useDoc();
  const nodes = useSelection();
  const page = doc.pages.find((p) => p.id === useStore.getState().es.page);
  const frames = (page?.children ?? []).map((id) => doc.nodes[id]).filter((n) => n && SCREEN_TYPES.includes(n.type));
  const n = nodes.length === 1 ? nodes[0] : null;
  const isTop = n && !n.parent && SCREEN_TYPES.includes(n.type);
  const start = startFrame(doc, page?.id);
  const present = () => start && useStore.setState({ presenting: start });
  const list = useRef<HTMLDivElement>(null);
  return (
    <div className="scroll">
      <Section title="Flow">
        <div className="row">
          <SelectField
            label="▶"
            title="Flow starting point"
            value={page?.flowStart && frames.some((f) => f.id === page.flowStart) ? page.flowStart : ""}
            options={[{ value: "", label: "First frame" }, ...frames.map((f) => ({ value: f.id, label: f.name }))]}
            onChange={(id) => page && dispatch({ op: "setFlowStart", page: page.id, id: id || null })}
          />
        </div>
        <button className="btn block primary" onClick={present} disabled={!start}>
          <Play size={13} /> Present
        </button>
        <div className="muted small" style={{ marginTop: 8 }}>
          Select a layer and drag the blue handle on its right edge onto a frame to link them. Choose Open overlay to show a frame (a modal or menu) on top instead.
        </div>
      </Section>
      {n && <ScrollingSection node={n} />}
      {n && (
        <Section
          title="Interactions"
          actions={
            <IconButton title="Add interaction" onClick={() => {
                // No destination is guessed: the picker takes the focus so the next step is choosing one.
                dispatch({ op: "setInteractions", id: n.id, interactions: [...n.interactions, newInteraction(null)] });
                requestAnimationFrame(() => {
                  const all = list.current?.querySelectorAll<HTMLElement>('[aria-label="Destination"]');
                  all?.[all.length - 1]?.focus();
                });
              }}
            >
              <Plus size={14} />
            </IconButton>
          }
        >
          <div ref={list}>
            {n.interactions.length === 0 && <div className="muted small">No interactions on “{n.name}”.</div>}
            {n.interactions.map((it, i) => (
              <InteractionEditor key={i} node={n} index={i} frames={frames} />
            ))}
          </div>
          {isTop && (
            <button className="btn block" onClick={() => page && dispatch({ op: "setFlowStart", page: page.id, id: n.id })}>
              Set “{n.name}” as starting point
            </button>
          )}
        </Section>
      )}
    </div>
  );
}

/** Overflow scrolling for a frame, and the scroll position of a layer inside a frame. */
function ScrollingSection({ node: n }: { node: Node }) {
  const doc = useDoc();
  const parent = n.parent ? doc.nodes[n.parent] : null;
  const isFrame = ["frame", "component", "instance"].includes(n.type);
  const inFrame = !!parent && ["frame", "component", "instance"].includes(parent.type);
  if (!isFrame && !inFrame) return null;
  const overflow = n.overflow ?? "none";
  // Scrolling only shows when the content is bigger than the frame on a scrolling axis.
  let tooSmall = false;
  if (isFrame && overflow !== "none") {
    const u = n.children.length ? query<{ union: { x: number; y: number; width: number; height: number } | null }>({ q: "bounds", ids: n.children }).union : null;
    const me = query<{ union: { x: number; y: number; width: number; height: number } }>({ q: "bounds", ids: [n.id] }).union;
    const h = overflow === "horizontal" || overflow === "both";
    const v = overflow === "vertical" || overflow === "both";
    tooSmall = !u || !((h && u.x + u.width > me.x + me.width + 0.5) || (v && u.y + u.height > me.y + me.height + 0.5));
  }
  // In an auto layout frame only layers with an absolute position can stay put.
  const canFix = !!parent && (!parent.layout || n.absolutePosition);
  const topLevelParent = !!parent && !parent.parent;
  // Sticky sticks inside a frame that scrolls vertically (any depth above the layer).
  let vScroller = false;
  for (let a = parent; a && !vScroller; a = a.parent ? doc.nodes[a.parent] : null) vScroller = a.overflow === "vertical" || a.overflow === "both";
  const behavior = n.scrollBehavior ?? "scroll";
  const set = (patch: Record<string, unknown>) => dispatch({ op: "update", ids: [n.id], patch });
  return (
    <Section title="Scrolling">
      {isFrame && (
        <>
          <div className="row">
            <SelectField
              label="Overflow"
              ariaLabel="Overflow scrolling"
              value={overflow}
              options={[
                { value: "none", label: "No scrolling" },
                { value: "horizontal", label: "Horizontal scrolling" },
                { value: "vertical", label: "Vertical scrolling" },
                { value: "both", label: "Both directions" },
              ]}
              onChange={(v: Overflow) => set({ overflow: v })}
            />
          </div>
          {tooSmall && <div className="muted small">For scrolling to work on this frame, the content needs to be bigger than the frame.</div>}
        </>
      )}
      {inFrame && (
        <>
          <div className="row">
            <SelectField
              label="Position"
              ariaLabel="Position when scrolling"
              value={behavior === "sticky" || canFix ? behavior : "scroll"}
              options={[
                { value: "scroll", label: "Scroll with parent" },
                { value: "fixed", label: "Fixed (stay in place)" },
                { value: "sticky", label: "Sticky (stay in place)" },
              ]}
              onChange={(v) => set({ scrollBehavior: v })}
            />
          </div>
          {behavior === "sticky" && !vScroller && <div className="muted small">Sticky works inside a frame that scrolls vertically.</div>}
          {!canFix && behavior !== "sticky" && <div className="muted small">In an auto layout frame only layers with an absolute position can be fixed.</div>}
          {canFix && behavior !== "sticky" && topLevelParent && parent?.layout && <div className="muted small">Code export keeps fixed layers of an auto layout frame inside the scrolling box, so they scroll there.</div>}
          {canFix && behavior !== "sticky" && !topLevelParent && <div className="muted small">Fixed layers work in a scrolling top-level frame; inside other frames they scroll with the frame.</div>}
        </>
      )}
    </Section>
  );
}

const MOTIONS: { value: Interaction["transition"]; label: string }[] = [
  { value: "instant", label: "Instant" },
  { value: "dissolve", label: "Dissolve" },
  { value: "smartAnimate", label: "Smart animate" },
  { value: "moveIn", label: "Move in" },
  { value: "moveOut", label: "Move out" },
  { value: "push", label: "Push" },
  { value: "slideLeft", label: "Slide left" },
  { value: "slideRight", label: "Slide right" },
  { value: "slideUp", label: "Slide up" },
  { value: "slideDown", label: "Slide down" },
];

const CUSTOM_BEZIER: [number, number, number, number] = [0.42, 0, 0.58, 1];

const EASINGS: { value: Easing | "custom"; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "easeIn", label: "Ease in" },
  { value: "easeOut", label: "Ease out" },
  { value: "easeInOut", label: "Ease in and out" },
  { value: "easeInBack", label: "Ease in back" },
  { value: "easeOutBack", label: "Ease out back" },
  { value: "easeInOutBack", label: "Ease in and out back" },
  { value: "custom", label: "Custom bezier" },
];

/** Four numbers of a custom curve with a 64 x 40 preview of it (x 0 to 1 across, y up). */
function BezierEditor({ value, onChange }: { value: [number, number, number, number]; onChange: (b: [number, number, number, number]) => void }) {
  const [x1, y1, x2, y2] = value;
  const set = (i: number, v: number) => onChange(value.map((x, k) => (k === i ? v : x)) as [number, number, number, number]);
  // The curve in a box with room above and below for values past 0 and 1.
  const X = (x: number) => 4 + x * 56;
  const Y = (y: number) => 30 - y * 20;
  return (
    <div className="bezier-editor" style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <svg width={64} height={40} viewBox="0 0 64 40" role="img" aria-label="Curve preview" style={{ flex: "none", background: "var(--panel)", borderRadius: 4 }}>
        <path d={`M ${X(0)} ${Y(0)} L ${X(x1)} ${Y(y1)} M ${X(1)} ${Y(1)} L ${X(x2)} ${Y(y2)}`} stroke="var(--muted, #888)" strokeWidth={0.75} fill="none" />
        <path data-bezier-curve d={`M ${X(0)} ${Y(0)} C ${X(x1)} ${Y(y1)} ${X(x2)} ${Y(y2)} ${X(1)} ${Y(1)}`} stroke="var(--accent, #7c5cff)" strokeWidth={1.5} fill="none" />
      </svg>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, flex: 1 }}>
        <NumberField label="x1" title="First handle, x (0 to 1)" ariaLabel="Bezier x1" value={x1} min={0} max={1} precision={2} onChange={(v) => set(0, v)} />
        <NumberField label="y1" title="First handle, y" ariaLabel="Bezier y1" value={y1} min={-5} max={5} precision={2} onChange={(v) => set(1, v)} />
        <NumberField label="x2" title="Second handle, x (0 to 1)" ariaLabel="Bezier x2" value={x2} min={0} max={1} precision={2} onChange={(v) => set(2, v)} />
        <NumberField label="y2" title="Second handle, y" ariaLabel="Bezier y2" value={y2} min={-5} max={5} precision={2} onChange={(v) => set(3, v)} />
      </div>
    </div>
  );
}

const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
];

/** A button that takes the next key press (with its modifiers) as the trigger key. */
function KeyField({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  const [listening, setListening] = useState(false);
  return (
    <button
      className="btn block"
      aria-label="Trigger key"
      title="Click, then press a key or combination"
      onClick={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(e) => {
        if (!listening) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") return setListening(false);
        const k = keyName(e.nativeEvent);
        if (!k) return;
        onChange(k);
        setListening(false);
      }}
    >
      {listening ? "Press a key…" : value || "Click to set a key"}
    </button>
  );
}

function InteractionEditor({ node, index, frames }: { node: Node; index: number; frames: Node[] }) {
  const doc = useDoc();
  const it = node.interactions[index];
  const set = (patch: Partial<Interaction>) => {
    // Navigate and overlay animations are what the next new interaction starts with.
    if (!("action" in patch) && (it.action === "navigate" || it.action === "openOverlay" || it.action === "swapOverlay")) rememberMotion(patch);
    dispatch({ op: "setInteractions", id: node.id, interactions: node.interactions.map((x, i) => (i === index ? { ...x, ...patch } : x)) });
  };
  const overlay = it.action === "openOverlay" || it.action === "swapOverlay";
  const sets = useMemo(() => enclosingSets(doc, node.id), [doc, node.id]);
  const variants = sets.flatMap((s) => s.children.map((c) => doc.nodes[c]).filter(Boolean).map((v) => ({ value: v.id, label: sets.length > 1 ? `${s.name} / ${v.name}` : v.name })));
  const targets = useMemo(() => (it.action === "scrollTo" ? scrollTargets(doc, node.id) : []), [doc, node.id, it.action]);
  const ACTIONS: { value: Interaction["action"]; label: string }[] = [
    { value: "navigate", label: "Navigate to" },
    { value: "openOverlay", label: "Open overlay" },
    { value: "swapOverlay", label: "Swap overlay" },
    { value: "closeOverlay", label: "Close overlay" },
    { value: "back", label: "Back" },
    { value: "scrollTo", label: "Scroll to" },
    ...(variants.length || it.action === "changeTo" ? [{ value: "changeTo" as const, label: "Change to" }] : []),
    { value: "openUrl", label: "Open link" },
  ];
  // What the transition controls offer for this action.
  const animates = it.action === "navigate" || overlay || it.action === "changeTo" || it.action === "scrollTo";
  const motions =
    it.action === "changeTo"
      ? MOTIONS.filter((m) => ["instant", "dissolve", "smartAnimate"].includes(m.value))
      : it.action === "scrollTo"
        ? [
            { value: "dissolve" as const, label: "Smooth" },
            { value: "instant" as const, label: "Instant" },
          ]
        : MOTIONS;
  const directional = ["moveIn", "moveOut", "push"].includes(it.transition);
  const timed = animates && it.transition !== "instant" && it.action !== "scrollTo";
  return (
    <div style={{ background: "var(--panel-2)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
      <div className="row">
        <SelectField
          ariaLabel="Trigger"
          value={it.trigger}
          options={(Object.keys(TRIGGER_LABELS) as Interaction["trigger"][]).map((value) => ({ value, label: TRIGGER_LABELS[value] }))}
          onChange={(trigger) => set({ trigger })}
        />
        <IconButton title="Remove" onClick={() => dispatch({ op: "setInteractions", id: node.id, interactions: node.interactions.filter((_, i) => i !== index) })}>
          <Trash2 size={13} />
        </IconButton>
      </div>
      {it.trigger === "key" && (
        <div className="row">
          <KeyField value={it.key ?? ""} onChange={(key) => set({ key })} />
        </div>
      )}
      {it.trigger === "afterDelay" && (
        <div className="row">
          <NumberField label="ms" title="Delay in milliseconds" ariaLabel="Delay (ms)" value={it.delayMs} min={0} precision={0} onChange={(delayMs) => set({ delayMs })} />
        </div>
      )}
      <div className="row">
        <SelectField
          ariaLabel="Action"
          value={it.action}
          options={ACTIONS}
          onChange={(action) => {
            // A destination only makes sense for the kind of action it was picked for.
            const kind = (a: Interaction["action"]) => (a === "scrollTo" ? "layer" : a === "changeTo" ? "variant" : "frame");
            const patch: Partial<Interaction> = { action };
            if (kind(action) !== kind(it.action)) patch.destination = null;
            if (action === "changeTo" && !["instant", "dissolve", "smartAnimate"].includes(it.transition)) patch.transition = "dissolve";
            set(patch);
          }}
        />
      </div>
      {isMissingDestination(doc, it) && (
        <div className="row missing-destination" role="alert" style={{ color: "var(--danger)" }}>
          <span className="small" style={{ flex: 1 }}>Missing destination: that frame was deleted.</span>
          <button className="btn" title="Remove the broken link" onClick={() => set({ destination: null })}>
            Remove
          </button>
        </div>
      )}
      {(it.action === "navigate" || overlay) && (
        <div className="row">
          <SelectField
            ariaLabel="Destination"
            value={it.destination && doc.nodes[it.destination] ? it.destination : ""}
            options={[
              { value: "", label: overlay ? "Choose overlay frame…" : "Choose frame…" },
              ...frames.filter((f) => !overlay || f.id !== node.id).map((f) => ({ value: f.id, label: f.name })),
              // Frames on other pages: the player follows links across pages.
              ...doc.pages
                .filter((pg) => pg.id !== useStore.getState().es.page)
                .flatMap((pg) => pg.children.map((id) => doc.nodes[id]).filter((f) => f && SCREEN_TYPES.includes(f.type)).map((f) => ({ value: f.id, label: `${pg.name} / ${f.name}` }))),
            ]}
            onChange={(destination) => set({ destination: destination || null })}
          />
        </div>
      )}
      {it.action === "scrollTo" && (
        <div className="row">
          <SelectField
            ariaLabel="Scroll to layer"
            value={it.destination && doc.nodes[it.destination] ? it.destination : ""}
            options={[{ value: "", label: "Choose layer…" }, ...targets.map((t) => ({ value: t.id, label: t.label }))]}
            onChange={(destination) => set({ destination: destination || null })}
          />
        </div>
      )}
      {it.action === "changeTo" && (
        <div className="row">
          <SelectField
            ariaLabel="Change to variant"
            value={it.destination && doc.nodes[it.destination] ? it.destination : ""}
            options={[{ value: "", label: variants.length ? "Choose variant…" : "Select a variant or a layer in one" }, ...variants]}
            onChange={(destination) => set({ destination: destination || null })}
          />
        </div>
      )}
      {it.action === "openUrl" && (
        <input
          key={it.url ?? ""}
          className="textinput"
          placeholder="https://"
          defaultValue={it.url ?? ""}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          onBlur={(e) => e.target.value !== (it.url ?? "") && set({ url: e.target.value })}
        />
      )}
      {animates && (
        <div className="row">
          <SelectField ariaLabel="Transition" value={motions.some((m) => m.value === it.transition) ? it.transition : motions[0].value} options={motions} onChange={(transition) => set({ transition })} />
        </div>
      )}
      {timed && directional && (
        <div className="row">
          <SelectField ariaLabel="Direction" label="Direction" value={it.direction ?? "left"} options={DIRECTIONS} onChange={(direction) => set({ direction })} />
        </div>
      )}
      {timed && (
        <div className="row">
          <NumberField label="ms" title="Duration in milliseconds" ariaLabel="Duration (ms)" value={it.durationMs > 0 ? it.durationMs : 300} min={1} max={60000} precision={0} onChange={(durationMs) => set({ durationMs })} />
          <SelectField
            ariaLabel="Easing"
            value={it.bezier ? "custom" : (it.easing ?? "easeOut")}
            options={EASINGS}
            // A custom curve keeps the preset next to it, which older editors still play.
            onChange={(v) => (v === "custom" ? set({ bezier: it.bezier ?? CUSTOM_BEZIER }) : set({ easing: v, bezier: null }))}
          />
        </div>
      )}
      {timed && it.bezier && (
        <div className="row">
          <BezierEditor value={it.bezier} onChange={(bezier) => set({ bezier })} />
        </div>
      )}
      {it.trigger === "onDrag" && animates && !["smartAnimate", "moveIn", "moveOut", "push", "slideLeft", "slideRight", "slideUp", "slideDown"].includes(it.transition) && (
        <div className="muted small">On drag follows the pointer with Smart animate, Move or Push; other transitions play when the drag starts.</div>
      )}
      {(it.action === "navigate" || it.action === "swapOverlay" || it.action === "changeTo") && (
        <label className="row" style={{ cursor: "pointer" }} title="The screen that opens starts scrolled where this one is (scrolling frames are matched by layer name)">
          <input type="checkbox" checked={!!it.preserveScroll} onChange={(e) => set({ preserveScroll: e.target.checked })} />
          Preserve scroll position
        </label>
      )}
      {overlay && <OverlayEditor value={it.overlay ?? DEFAULT_OVERLAY} onChange={(o) => set({ overlay: o })} />}
    </div>
  );
}

const OVERLAY_POSITIONS: { value: OverlaySettings["position"]; label: string }[] = [
  { value: "center", label: "Center" },
  { value: "topLeft", label: "Top left" },
  { value: "topCenter", label: "Top center" },
  { value: "topRight", label: "Top right" },
  { value: "bottomLeft", label: "Bottom left" },
  { value: "bottomCenter", label: "Bottom center" },
  { value: "bottomRight", label: "Bottom right" },
  { value: "manual", label: "Manual" },
];

/** Overlay position, click-outside and background dimming for Open / Swap overlay. */
function OverlayEditor({ value: o, onChange }: { value: OverlaySettings; onChange: (o: OverlaySettings) => void }) {
  const set = (patch: Partial<OverlaySettings>) => onChange({ ...o, ...patch });
  const bg = o.background;
  return (
    <div className="overlay-settings">
      <div className="row">
        <SelectField title="Overlay position" value={o.position} options={OVERLAY_POSITIONS.map((p) => ({ ...p, label: `Position: ${p.label}` }))} onChange={(position) => set({ position })} />
      </div>
      {o.position === "manual" && (
        <div className="row" title="Offset from the top-left of this layer">
          <NumberField label="X" value={o.offsetX} onChange={(offsetX) => set({ offsetX })} />
          <NumberField label="Y" value={o.offsetY} onChange={(offsetY) => set({ offsetY })} />
        </div>
      )}
      <label className="row" style={{ cursor: "pointer" }}>
        <input type="checkbox" checked={o.closeOnClickOutside} onChange={(e) => set({ closeOnClickOutside: e.target.checked })} />
        Close when clicking outside
      </label>
      <label className="row" style={{ cursor: "pointer" }}>
        <input type="checkbox" checked={!!bg} onChange={(e) => set({ background: e.target.checked ? (DEFAULT_OVERLAY.background ?? null) : null })} />
        Background
      </label>
      {bg && (
        <div className="row">
          <label className="swatch" title="Background colour">
            <i style={{ background: overlayDim(o) }} />
            <input type="color" value={bg.color.slice(0, 7)} onChange={(e) => set({ background: { ...bg, color: e.target.value.toUpperCase() } })} style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
          </label>
          <NumberField label="%" title="Background opacity" value={Math.round(bg.opacity * 100)} min={0} max={100} precision={0} onChange={(v) => set({ background: { ...bg, opacity: v / 100 } })} />
        </div>
      )}
    </div>
  );
}

export { cssFor } from "./CodePanel";
