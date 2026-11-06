//! Design-to-code: React + Tailwind components, standalone HTML and a
//! complete Vite project where prototype links become working navigation.

use std::collections::{BTreeMap, BTreeSet};

use crate::color;
use serde_json::json;

use crate::components;
use crate::geom::fmt;
use crate::model::{
  Action, Align, Document, EffectType, ImageCredit, InstanceInfo, LayoutDirection, Node, NodeId, NodeType, OverlayPosition,
  OverlaySettings, Paint, PropKind, ScaleMode, Sizing, StrokeAlign, TextAlignH, TextAutoResize, TextCase, TextDecoration,
};
use crate::paint;
use crate::props;
use crate::render::{esc, export_svg_geometry, font_stack};
use crate::text::TextMeasurer;

const PX: &str = "px";

/// The generated project's `src/App.tsx`: screen history plus a stack of overlays.
const APP_TSX: &str = r#"import { useEffect, useRef, useState, type CSSProperties } from "react";
__IMPORTS__
type Navigate = (screen: string, overlay?: Record<string, unknown>) => void;
type Overlay = { screen: string; position?: string; x?: number; y?: number; background?: string | null; closeOnClickOutside?: boolean };

const screens: Record<string, (props: { onNavigate?: Navigate }) => JSX.Element> = {
__MAP__};

// Design widths: screens fill the window up to these; overlays render at them.
const widths: Record<string, number> = { __WIDTHS__ };

// Phone-sized screens are shown centred on a backdrop; wider ones fill the window.
const phoneScreens = new Set<string>([__PHONES__]);

// What a key or delay trigger of the design does: go to a screen (or open or close an overlay),
// or open a link.
type Step = { to?: string; url?: string; opts?: Record<string, unknown> };
// Each screen's "Key" and "After delay" triggers.
const keys: Record<string, (Step & { key: string })[]> = __KEYS__;
const delays: Record<string, (Step & { ms: number })[]> = __DELAYS__;

// The name of a key press as the design writes it: "Enter", "Space", "Ctrl+Shift+K". Letters and
// digits follow the physical key when a modifier changes what the key reports (Shift+1 is "!").
function keyName(e: KeyboardEvent): string | null {
  if (e.repeat || e.isComposing) return null;
  if (["Control", "Alt", "Shift", "Meta", "Dead", "Unidentified", "Process"].includes(e.key)) return null;
  const mod = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
  const physical = mod && !/^[\p{L}\p{N}]$/u.test(e.key) ? /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code) : null;
  const k = physical ? (physical[1] ?? physical[2]) : e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", k].filter(Boolean).join("+");
}

// Frame names that differ from their screen key ("Marketing Dark" is MarketingDark).
const screenNames: Record<string, string> = __SCREEN_NAMES__;

// Each page's flow starts at its start screen; /#Screen opens a screen directly (another flow).
function startScreen(): string {
  let hash = window.location.hash.slice(1);
  try {
    hash = decodeURIComponent(hash);
  } catch {
    /* keep the raw hash */
  }
  // A frame's own name works too: /#Marketing%20Dark.
  if (!Object.prototype.hasOwnProperty.call(screens, hash) && Object.prototype.hasOwnProperty.call(screenNames, hash)) hash = screenNames[hash];
  return Object.prototype.hasOwnProperty.call(screens, hash) ? hash : __START__;
}

// Where an overlay sits on the screen underneath it.
const placement: Record<string, CSSProperties> = {
  center: { alignItems: "center", justifyContent: "center" },
  topLeft: { alignItems: "flex-start", justifyContent: "flex-start" },
  topCenter: { alignItems: "flex-start", justifyContent: "center" },
  topRight: { alignItems: "flex-start", justifyContent: "flex-end" },
  bottomLeft: { alignItems: "flex-end", justifyContent: "flex-start" },
  bottomCenter: { alignItems: "flex-end", justifyContent: "center" },
  bottomRight: { alignItems: "flex-end", justifyContent: "flex-end" },
};

export default function App() {
  const [history, setHistory] = useState<string[]>(() => [startScreen()]);
  // Open overlays (modals, menus, sheets), topmost last.
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const current = history[history.length - 1];
  const Screen = screens[current];
  const host = useRef<HTMLDivElement>(null);
  const closeTop = () => setOverlays((o) => o.slice(0, -1));
  // Manual offsets are relative to the screen holding the trigger; from inside an overlay that is
  // the overlay's own frame, so add where that overlay currently sits.
  const placed = (opts?: Record<string, unknown>) => {
    if (opts?.position !== "manual" || !overlays.length) return opts;
    const layer = host.current?.querySelector(`[data-overlay="${overlays.length - 1}"]`);
    if (!host.current || !layer) return opts;
    const a = host.current.getBoundingClientRect();
    const b = layer.getBoundingClientRect();
    return { ...opts, x: Number(opts.x ?? 0) + b.left - a.left, y: Number(opts.y ?? 0) + b.top - a.top };
  };
  const onNavigate: Navigate = (s, opts) => {
    if (s === "close-overlay") return closeTop();
    if (s.startsWith("overlay:")) return setOverlays((o) => [...o, { ...placed(opts), screen: s.slice(8) } as Overlay]);
    if (s.startsWith("swap-overlay:")) return setOverlays((o) => [...o.slice(0, -1), { ...placed(opts), screen: s.slice(13) } as Overlay]);
    if (s === "back" && overlays.length) return closeTop();
    setOverlays([]);
    setHistory((h) => (s === "back" ? (h.length > 1 ? h.slice(0, -1) : h) : [...h, s]));
  };
  const live = useRef({ overlays, current, onNavigate });
  live.current = { overlays, current, onNavigate };
  const run = (step: Step) => {
    if (step.to) live.current.onNavigate(step.to, step.opts);
    else if (step.url) window.open(step.url, "_blank", "noopener,noreferrer");
  };
  useEffect(() => {
    // Enter and Space belong to a focused control, unless a click (not Tab) put the focus there.
    let byPointer = false;
    const onPointer = () => (byPointer = true);
    const onKey = (e: KeyboardEvent) => {
      // A control that already handled this key (its own onKeyDown) has run its action.
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
      const space = e.key === "Enter" || e.key === " ";
      if (!space && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) byPointer = false;
      if (space && !byPointer && t?.closest("button, a[href], [role=button]")) return;
      const name = keyName(e);
      const { overlays, current } = live.current;
      const top = overlays[overlays.length - 1];
      const find = (screen?: string) => (name && screen ? keys[screen]?.find((k) => k.key === name) : undefined);
      let hit = find(top?.screen);
      if (!hit && top && e.key === "Escape") return closeTop();
      hit = hit ?? find(current);
      if (hit) {
        e.preventDefault();
        run(hit);
      } else if (e.key === "Escape") closeTop();
    };
    const onHash = () => {
      setOverlays([]);
      setHistory([startScreen()]);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  // After delay: runs once per visit to a screen, and once when an overlay opens.
  useEffect(() => {
    const timers = (delays[current] ?? []).map((d) => setTimeout(() => run(d), d.ms));
    return () => timers.forEach(clearTimeout);
  }, [history.length, current]);
  // An overlay's delay starts once, when that overlay opens (a swap keeps the count, not the overlay).
  const started = useRef(new WeakSet<Overlay>());
  const top = overlays[overlays.length - 1];
  useEffect(() => {
    if (!top || started.current.has(top)) return;
    started.current.add(top);
    const timers = (delays[top.screen] ?? []).map((d) => setTimeout(() => run(d), d.ms));
    return () => timers.forEach(clearTimeout);
  }, [top]);
  const phone = phoneScreens.has(current);
  return (
    <div className={phone ? "min-h-screen flex items-start justify-center bg-neutral-100 sm:py-10" : "min-h-screen flex justify-center"}>
      <div ref={host} className="relative w-full" style={{ maxWidth: widths[current] }}>
        <main>{Screen ? <Screen onNavigate={onNavigate} /> : null}</main>
        {overlays.map((o, i) => {
          const Layer = screens[o.screen];
          const manual = o.position === "manual";
          return Layer ? (
            <div
              key={i}
              className="absolute inset-0 flex overflow-hidden"
              style={{ background: o.background ?? "transparent", ...placement[o.position ?? "center"] }}
              onClick={() => {
                if (i === overlays.length - 1 && o.closeOnClickOutside !== false) closeTop();
              }}
            >
              <div
                data-overlay={i}
                className={manual ? "absolute" : undefined}
                style={{ width: widths[o.screen], maxWidth: "100%", ...(manual ? { left: o.x, top: o.y } : {}) }}
                onClick={(e) => e.stopPropagation()}
              >
                <Layer onNavigate={onNavigate} />
              </div>
            </div>
          ) : null;
        })}
      </div>
    </div>
  );
}
"#;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Place {
  /// Root of the export (relative, no offset).
  Root,
  /// Root of a reusable component function (positioned by the caller).
  ComponentRoot,
  /// Child of a non auto layout container.
  Absolute,
  /// Child flowing in an auto layout container.
  Flow { horizontal: bool },
}

/// Intermediate element tree shared by the JSX and HTML writers.
struct Span {
  text: String,
  styles: Vec<(String, String)>,
  link: Option<String>,
}

struct El {
  tag: &'static str,
  styles: Vec<(String, String)>,
  children: Vec<El>,
  text: Option<String>,
  /// Styled pieces of a mixed-style text: (text, CSS declarations, link).
  spans: Vec<Span>,
  raw: Option<String>,
  /// Name of a component to reference instead of inlining (`<Button />`).
  component_ref: Option<String>,
  comment: Option<String>,
  /// Where the CSS only approximates the design (diamond gradients), as a comment in the output.
  approx: Option<String>,
  /// `onNavigate` target: a screen name, "back", "overlay:<Screen>", "swap-overlay:<Screen>"
  /// or "close-overlay".
  navigate: Option<String>,
  /// Overlay placement passed as `onNavigate`'s second argument.
  overlay: Option<serde_json::Value>,
  url: Option<String>,
  is_component_root: bool,
  /// Extra HTML attributes (src, alt, type).
  attrs: Vec<(String, String)>,
  /// Attributes whose value is a JSX expression (`icon={false}`).
  expr_attrs: Vec<(String, String)>,
  /// Component property that shows or hides this element (a boolean prop).
  show_if: Option<String>,
  /// Component property that holds this element's text.
  text_prop: Option<String>,
  /// Component property that can replace this element (an instance swap prop).
  slot: Option<String>,
  /// Named style classes (`text-heading-1`), written before the utilities. React project export only.
  classes: Vec<String>,
  /// Inside a button or link: the click handler stops there, so only the innermost action runs.
  stop_click: bool,
  /// A clickable element that isn't a button or link: it gets `role="button"`, `tabIndex` and an
  /// Enter/Space handler so the keyboard reaches it.
  focusable: bool,
  /// The element's subtree holds a button, link or other control (or this is a component that renders one).
  holds_control: bool,
  /// A component reference whose component renders a button or link.
  renders_control: bool,
  /// The layer name as an accessible name (empty for default names like "Frame 3"), or the
  /// component name on a component root.
  label: Option<String>,
  /// What the click does, as an accessible name ("Go to Detail", "Back").
  action_label: Option<String>,
}

impl El {
  fn new(tag: &'static str) -> Self {
    El {
      tag,
      styles: vec![],
      children: vec![],
      text: None,
      spans: vec![],
      raw: None,
      component_ref: None,
      comment: None,
      approx: None,
      navigate: None,
      overlay: None,
      url: None,
      is_component_root: false,
      attrs: vec![],
      expr_attrs: vec![],
      show_if: None,
      text_prop: None,
      slot: None,
      classes: vec![],
      stop_click: false,
      focusable: false,
      holds_control: false,
      renders_control: false,
      label: None,
      action_label: None,
    }
  }

  fn s(&mut self, k: &str, v: impl Into<String>) {
    self.styles.retain(|(name, _)| name != k);
    self.styles.push((k.to_string(), v.into()));
  }
}

struct Ctx<'a> {
  doc: &'a Document,
  m: &'a dyn TextMeasurer,
  /// Component ids referenced by instances, with generated names.
  components: BTreeMap<String, String>,
  /// Component sets whose variants are referenced: set id → the exported component that
  /// picks a variant from props (`<Button state="Pressed" />`).
  sets: BTreeMap<String, String>,
  screen_names: BTreeMap<String, String>,
  /// Screens in page/layer order.
  screen_order: Vec<(String, String)>,
  used_names: BTreeSet<String>,
  reuse_components: bool,
  /// One h1 per screen.
  h1_used: bool,
  /// The main component whose function is being built (its layers use its properties).
  cur_comp: Option<NodeId>,
  /// Properties the function being built uses, in order.
  used_props: Vec<UsedProp>,
  /// Component ids in the order their functions are written.
  component_order: Vec<String>,
  /// Text and colour styles become classes and custom properties (project export).
  style_classes: bool,
  /// Text style class → its declarations.
  text_classes: BTreeMap<String, Vec<(String, String)>>,
  /// Colour style custom property → its colour.
  color_vars: BTreeMap<String, String>,
  /// Names of the styles' classes and custom properties, by style id.
  names: StyleNames,
  /// How many button or link elements enclose the layer being built.
  interactive_depth: usize,
  /// Main component id → whether it renders a button or link.
  interactive_cache: BTreeMap<String, bool>,
  /// The screen being built (none for component functions): key and delay triggers go to it.
  screen: Option<String>,
  /// Screen name → its key triggers (`{ key, to | url, opts? }`) and delays (`{ ms, to | url, opts? }`).
  keys: BTreeMap<String, Vec<serde_json::Value>>,
  delays: BTreeMap<String, Vec<serde_json::Value>>,
}

/// Props an instance sets on its component: string attributes and expression attributes.
#[derive(Default)]
struct PropArgs {
  attrs: Vec<(String, String)>,
  exprs: Vec<(String, String)>,
}

/// The prop names a layer's component properties go by in the function being built.
#[derive(Default)]
struct BoundProps {
  visible: Option<String>,
  characters: Option<String>,
  swap: Option<String>,
}

/// A component property a generated function takes as a prop.
struct UsedProp {
  id: String,
  ident: String,
  kind: PropKind,
  /// What the main component shows (`true`, a text; none for a swap slot).
  default: serde_json::Value,
}

impl<'a> Ctx<'a> {
  fn new(doc: &'a Document, m: &'a dyn TextMeasurer, reuse_components: bool) -> Self {
    let mut c = Ctx {
      doc,
      m,
      components: BTreeMap::new(),
      sets: BTreeMap::new(),
      screen_names: BTreeMap::new(),
      screen_order: Vec::new(),
      used_names: BTreeSet::new(),
      reuse_components,
      h1_used: false,
      cur_comp: None,
      used_props: Vec::new(),
      component_order: Vec::new(),
      style_classes: false,
      text_classes: BTreeMap::new(),
      color_vars: BTreeMap::new(),
      names: StyleNames::default(),
      interactive_depth: 0,
      interactive_cache: BTreeMap::new(),
      screen: None,
      keys: BTreeMap::new(),
      delays: BTreeMap::new(),
    };
    for p in &doc.pages {
      for id in &p.children {
        if let Some(n) = doc.get(id) {
          if n.kind == NodeType::Frame {
            let name = c.unique(&pascal(&n.name, "Screen"));
            c.screen_names.insert(id.clone(), name.clone());
            c.screen_order.push((id.clone(), name));
          }
        }
      }
    }
    c
  }

  fn unique(&mut self, base: &str) -> String {
    let mut name = base.to_string();
    let mut i = 2;
    while self.used_names.contains(&name) {
      name = format!("{base}{i}");
      i += 1;
    }
    self.used_names.insert(name.clone());
    name
  }

  fn component_name(&mut self, comp_id: &str) -> String {
    if let Some(n) = self.components.get(comp_id) {
      return n.clone();
    }
    if let Some(set) = self.variant_set(comp_id) {
      // Every variant gets its own function, named after the set and its values.
      let set_name = self.unique(&pascal(&set.name, "Component"));
      self.sets.insert(set.id.clone(), set_name.clone());
      for v in variants(self.doc, &set) {
        let values: Vec<String> = v.variant_props().into_values().collect();
        let name = self.unique(&format!("{set_name}{}", pascal(&values.join(" "), "Variant")));
        self.components.insert(v.id.clone(), name);
        self.component_order.push(v.id.clone());
      }
      if let Some(n) = self.components.get(comp_id) {
        return n.clone();
      }
    }
    let base = self
      .doc
      .get(comp_id)
      .map(|n| pascal(&n.name, "Component"))
      .unwrap_or_else(|| "Component".into());
    let name = self.unique(&base);
    self.components.insert(comp_id.to_string(), name.clone());
    self.component_order.push(comp_id.to_string());
    name
  }

  /// Registers every main component and component set of the file (page order, then name), so
  /// the library is exported whether or not a screen uses it.
  fn register_library(&mut self) {
    let mut found: Vec<(usize, String, NodeId)> = Vec::new();
    for (pi, page) in self.doc.pages.iter().enumerate() {
      for root in &page.children {
        for id in self.doc.subtree(root) {
          let Some(n) = self.doc.get(&id) else { continue };
          match n.kind {
            NodeType::ComponentSet => {
              if let Some(first) = variants(self.doc, n).first() {
                found.push((pi, n.name.clone(), first.id.clone()));
              }
            }
            NodeType::Component if self.variant_set(&id).is_none() => found.push((pi, n.name.clone(), id.clone())),
            _ => {}
          }
        }
      }
    }
    found.sort();
    for (_, _, id) in found {
      self.component_name(&id);
    }
  }

  /// CSS padding of an auto layout frame. A device frame's safe area is not content padding: on a
  /// phone or tablet it becomes `env(safe-area-inset-*)` (the real device supplies it), and in a
  /// window or browser frame it is left out (the real chrome takes that space).
  fn padding_value(&self, n: &Node, pad: [f64; 4]) -> String {
    // Per-side strokes are borders, which take layout space that Figma's strokes don't.
    let mut pad = pad;
    if let Some(b) = border_widths(n) {
      for (p, b) in pad.iter_mut().zip(b) {
        *p = (*p - b).max(0.0);
      }
    }
    let applied = n.device.as_ref().map(|d| d.applied).filter(|a| a.iter().any(|v| *v > 0.0));
    let (Some(applied), Some(d)) = (applied, n.device.as_ref()) else {
      return pad.iter().map(|p| px(*p)).collect::<Vec<_>>().join(" ");
    };
    let mobile = crate::devices::is_mobile(d);
    ["top", "right", "bottom", "left"]
      .iter()
      .enumerate()
      .map(|(i, side)| {
        let rest = (pad[i] - applied[i]).max(0.0);
        if !mobile || applied[i] <= 0.0 {
          px(rest)
        } else if rest == 0.0 {
          format!("env(safe-area-inset-{side}, 0px)")
        } else {
          format!("calc({} + env(safe-area-inset-{side}, 0px))", px(rest))
        }
      })
      .collect::<Vec<_>>()
      .join(" ")
  }

  /// The component set `comp_id` is a variant of.
  fn variant_set(&self, comp_id: &str) -> Option<Node> {
    let p = self.doc.get(comp_id)?.parent.as_ref()?;
    self.doc.get(p).filter(|s| s.kind == NodeType::ComponentSet).cloned()
  }

  /// Whether a main component has a layer that is written as a button or link (memoised).
  fn renders_interactive(&mut self, comp_id: &str) -> bool {
    if let Some(v) = self.interactive_cache.get(comp_id) {
      return *v;
    }
    let doc = self.doc;
    let found = doc.subtree(comp_id).iter().filter_map(|id| doc.get(id)).any(|n| {
      let link = n.text.as_ref().is_some_and(|t| t.runs.iter().any(|r| r.link.is_some()));
      link || (n.kind.is_container() && self.container_tag(n) == "button")
    });
    self.interactive_cache.insert(comp_id.to_string(), found);
    found
  }

  fn build(&mut self, id: &str, place: Place) -> Option<El> {
    let n = self.doc.get(id)?.clone();
    // A device frame's system UI is not app content.
    if n.device_part.is_some() {
      return None;
    }
    // Layers a component property controls are written as expressions in the component's function.
    let bound = self.bound_props(&n);
    if !n.visible && bound.visible.is_none() {
      return None;
    }
    // A component function that renders a button or link would put it inside this button or link:
    // write that instance inline. Slots of an instance swap property stay slots.
    let clicks = n.interactions.iter().any(|i| {
      use crate::model::Trigger;
      matches!(
        i.trigger,
        Trigger::OnClick | Trigger::OnPress | Trigger::MouseDown | Trigger::MouseUp
      )
    });
    // (An instance with a click of its own would make its root a control inside the button.)
    let inline = self.interactive_depth > 0
      && bound.swap.is_none()
      && n
        .instance
        .as_ref()
        .is_some_and(|i| clicks || self.renders_interactive(&i.component_id));
    if self.reuse_components && !inline && n.kind == NodeType::Instance && place != Place::Root {
      if let Some(info) = n.instance.as_ref() {
        // Property values and swapped icons become props; any other override inlines the instance.
        let args = self.prop_args(&n);
        let plain = !components::has_overrides(self.doc, id);
        if (plain || args.is_some()) && self.doc.get(&info.component_id).is_some() {
          let name = self.component_name(&info.component_id);
          let mut el = El::new("div");
          self.position(&mut el, &n, place);
          self.limits(&mut el, &n);
          match self.variant_set(&info.component_id).and_then(|s| self.sets.get(&s.id).cloned()) {
            Some(set_name) => {
              el.component_ref = Some(set_name);
              for (k, v) in self.doc.get(&info.component_id).map(|c| c.variant_props()).unwrap_or_default() {
                el.attrs.push((prop_ident(&k), v));
              }
            }
            None => el.component_ref = Some(name),
          }
          let PropArgs { attrs, exprs } = args.unwrap_or_default();
          el.attrs.extend(attrs);
          el.expr_attrs.extend(exprs);
          el.show_if = bound.visible.clone();
          el.slot = bound.swap.clone();
          el.renders_control = self.renders_interactive(&info.component_id);
          self.interactions(&mut el, &n);
          return Some(el);
        }
      }
    }
    if place == Place::Root {
      self.h1_used = false;
    }
    let image_src = image_only(&n);
    // Masks have no faithful HTML equivalent; export the masked container as SVG.
    let has_mask = n
      .children
      .iter()
      .any(|c| self.doc.get(c).map(|m| m.is_mask && m.visible).unwrap_or(false));
    let mut el = match n.kind {
      _ if has_mask => {
        let mut e = El::new("div");
        e.raw = Some(export_svg_geometry(self.doc, &n.id, self.m));
        e
      }
      NodeType::Text => {
        let mut e = self.text_el(&n);
        // Text in a button or link is a span, and doesn't use up the screen's h1.
        e.tag = if self.interactive_depth > 0 { "span" } else { self.heading_tag(&n) };
        e
      }
      NodeType::Vector | NodeType::Polygon | NodeType::Star => {
        let mut e = El::new("div");
        e.raw = Some(export_svg_geometry(self.doc, &n.id, self.m));
        e
      }
      _ if image_src.is_some() => {
        let mut e = El::new("img");
        let src = image_src.clone().unwrap_or_default();
        // A `#` in a raw text data URL would start a fragment: encode it like a CSS url.
        let text_data = src.starts_with("data:") && src.split(',').next().is_some_and(|h| !h.contains(";base64"));
        e.attrs.push(("src".into(), if text_data { css_url(&src) } else { src }));
        e.attrs.push(("alt".into(), photo_alt(&n)));
        e
      }
      _ => El::new(self.container_tag(&n)),
    };
    if el.tag == "button" {
      el.attrs.push(("type".into(), "button".into()));
    }
    el.show_if = bound.visible.clone();
    if let Some(p) = bound.characters.clone() {
      el.text_prop = Some(p);
      el.spans.clear();
    }
    if n.kind == NodeType::Group {
      el.comment = Some(n.name.clone());
    }
    el.is_component_root = place == Place::ComponentRoot;
    el.label = if place == Place::ComponentRoot {
      // A variant is named by its set.
      let owner = self.variant_set(&n.id).unwrap_or_else(|| n.clone());
      Some(owner.name.clone())
    } else {
      Some(n.name.clone()).filter(|s| !is_default_name(s))
    };
    self.position(&mut el, &n, place);
    self.limits(&mut el, &n);
    self.visual(&mut el, &n);
    self.bind_vars(&mut el, &n);
    if self.style_classes {
      self.apply_styles(&mut el, &n);
    }
    if el.tag == "img" {
      let fit = if el.styles.iter().any(|(k, v)| k == "background-size" && v == "contain") {
        "contain"
      } else {
        "cover"
      };
      el.styles.retain(|(k, _)| !k.starts_with("background"));
      el.s("object-fit", fit);
    }
    if let Some(al) = n.layout.as_ref() {
      el.s("display", "flex");
      if al.direction == LayoutDirection::Vertical {
        el.s("flex-direction", "column");
      }
      if al.wrap {
        el.s("flex-wrap", "wrap");
        el.s("row-gap", px(al.counter_gap));
      }
      if al.primary_align != Align::SpaceBetween && al.gap != 0.0 {
        el.s(
          "column-gap",
          px(if al.direction == LayoutDirection::Horizontal { al.gap } else { 0.0 }),
        );
        el.s(
          "row-gap",
          px(if al.direction == LayoutDirection::Vertical {
            al.gap
          } else {
            al.counter_gap
          }),
        );
        el.styles.retain(|(k, v)| !(k.ends_with("-gap") && (v == "0px" || v == "0")));
      }
      let pad = [al.padding_top, al.padding_right, al.padding_bottom, al.padding_left];
      if pad.iter().any(|p| *p != 0.0) {
        el.s("padding", self.padding_value(&n, pad));
      }
      let justify = match al.primary_align {
        Align::Start | Align::Baseline => None,
        Align::Center => Some("center"),
        Align::End => Some("flex-end"),
        Align::SpaceBetween => Some("space-between"),
      };
      if let Some(j) = justify {
        el.s("justify-content", j);
      }
      let items = match al.counter_align {
        Align::Center => "center",
        Align::End => "flex-end",
        Align::Baseline if al.direction == LayoutDirection::Horizontal && !al.wrap => "baseline",
        _ => "flex-start",
      };
      el.s("align-items", items);
    }
    if n.kind.is_container() && !has_mask {
      let child_place = |c: &Node| match n.layout.as_ref() {
        Some(al) if !c.absolute_position => Place::Flow {
          horizontal: al.direction == LayoutDirection::Horizontal,
        },
        _ => Place::Absolute,
      };
      // Fixed layers of a scrolling frame stay put: the scrolling content moves into a box of its
      // own and the fixed layers sit next to it.
      let fixed = |c: &Node| c.scroll_behavior == crate::model::ScrollBehavior::Fixed && (n.layout.is_none() || c.absolute_position);
      // A frame that hugs along its scroll axis has nothing to scroll: keep its content in flow
      // (an absolute scroller would leave it 0 tall).
      let hugs = |s: Sizing| n.layout.is_some() && s == Sizing::Hug;
      let hug_over = match n.overflow {
        crate::model::Overflow::None => false,
        crate::model::Overflow::Horizontal => hugs(n.sizing_h),
        crate::model::Overflow::Vertical => hugs(n.sizing_v),
        crate::model::Overflow::Both => hugs(n.sizing_h) || hugs(n.sizing_v),
      };
      let split = n.overflow != crate::model::Overflow::None && !hug_over;
      let mut stuck = Vec::new();
      let interactive = matches!(el.tag, "button" | "a");
      self.interactive_depth += usize::from(interactive);
      for cid in &n.children {
        let Some(c) = self.doc.get(cid).cloned() else { continue };
        if let Some(ce) = self.build(cid, child_place(&c)) {
          if split && fixed(&c) {
            stuck.push(ce);
          } else {
            el.children.push(ce);
          }
        }
      }
      if !stuck.is_empty() {
        let mut inner = El::new("div");
        for (k, v) in [
          ("position", "absolute"),
          ("left", "0"),
          ("top", "0"),
          ("width", "100%"),
          ("height", "100%"),
        ] {
          inner.s(k, v);
        }
        // The scroller takes the overflow and the layout, so auto layout and safe-area padding
        // scroll with the content; the outer box keeps size, paint and the anchor for the layers.
        let moves = |k: &str| {
          k.starts_with("overflow")
            || k.starts_with("padding")
            || matches!(k, "flex-direction" | "flex-wrap")
            || k.ends_with("gap")
            || matches!(k, "display" | "justify-content" | "align-items" | "align-content")
        };
        inner.styles.extend(el.styles.iter().filter(|(k, _)| moves(k)).cloned());
        el.styles.retain(|(k, _)| !moves(k));
        // The scroller follows the corners; the outer box still clips what it clipped.
        inner.s("border-radius", "inherit");
        if n.clip_content {
          el.s("overflow", "hidden");
        }
        inner.children = std::mem::take(&mut el.children);
        el.children.push(inner);
        el.children.extend(stuck);
      }
      // An outline is painted before the positioned children, so absolute children would cover
      // an inside or centre stroke: it becomes the last child instead.
      let has_absolute = n
        .children
        .iter()
        .filter_map(|c| self.doc.get(c))
        .any(|c| n.layout.is_none() || c.absolute_position);
      let scrolls = el.styles.iter().any(|(k, v)| k.starts_with("overflow") && v == "auto");
      if has_absolute && n.stroke_align != StrokeAlign::Outside && !scrolls && !el.children.is_empty() {
        if let Some(ov) = el.styles.iter().find(|(k, _)| k == "outline").map(|(_, v)| v.clone()) {
          el.styles.retain(|(k, _)| k != "outline" && k != "outline-offset");
          if !el.styles.iter().any(|(k, _)| k == "position") {
            el.s("position", "relative");
          }
          // A span, so it is valid inside a button or link.
          let mut stroke = El::new("span");
          stroke.attrs.push(("aria-hidden".into(), "true".into()));
          stroke.s("position", "absolute");
          stroke.s("inset", "0");
          let border = if n.stroke_align == StrokeAlign::Center {
            // The inside half is the overlay; the outer half stays an outline, which the frame's
            // own overflow never clips.
            let half = ov.replacen(&px(n.stroke_weight), &px(n.stroke_weight / 2.0), 1);
            el.s("outline", half.clone());
            el.s("outline-offset", "0");
            half
          } else {
            ov
          };
          stroke.s("border", border);
          stroke.s("border-radius", "inherit");
          stroke.s("pointer-events", "none");
          el.children.push(stroke);
        }
      }
      self.interactive_depth -= usize::from(interactive);
    }
    self.interactions(&mut el, &n);
    if matches!(place, Place::Root | Place::ComponentRoot) {
      fix_interactive(&mut el, place == Place::ComponentRoot);
    }
    Some(el)
  }

  /// The prop names of the component properties `n` is bound to, when it is a layer of the
  /// component function being built (registering them as used by it).
  fn bound_props(&mut self, n: &Node) -> BoundProps {
    let mut out = BoundProps::default();
    let (Some(refs), Some(comp)) = (&n.prop_refs, self.cur_comp.clone()) else {
      return out;
    };
    if !self.reuse_components || self.doc.instance_ancestor(&n.id).is_some() {
      return out;
    }
    let defs = props::props_of(self.doc, &comp);
    let idents = prop_idents(self.doc, &comp);
    let mut take = |id: &Option<String>, field: &str| -> Option<String> {
      let def = defs.iter().find(|d| Some(&d.id) == id.as_ref())?;
      let ident = idents.get(&def.id)?.clone();
      if !self.used_props.iter().any(|u| u.id == def.id) {
        let default = match field {
          "visible" => json!(n.visible),
          "characters" => json!(n.text.as_ref().map(|t| t.characters.clone()).unwrap_or_default()),
          _ => serde_json::Value::Null,
        };
        self.used_props.push(UsedProp {
          id: def.id.clone(),
          ident: ident.clone(),
          kind: def.kind,
          default,
        });
      }
      Some(ident)
    };
    out.visible = take(&refs.visible, "visible");
    out.characters = take(&refs.characters, "characters");
    out.swap = take(&refs.swap, "swap");
    out
  }

  /// The props an instance sets on its component.
  /// None when it has overrides that props can't express.
  fn prop_args(&mut self, n: &Node) -> Option<PropArgs> {
    let info = n.instance.as_ref()?;
    let has_overrides = components::has_overrides(self.doc, &n.id);
    let defs = props::props_of(self.doc, &info.component_id);
    if defs.is_empty() || self.doc.instance_ancestor(&n.id).is_some() {
      return (!has_overrides).then(Default::default);
    }
    let idents = prop_idents(self.doc, &info.component_id);
    let ident = |id: &str| idents.get(id).cloned().unwrap_or_default();
    let mut attrs = Vec::new();
    let mut exprs = Vec::new();
    for (key, v) in &info.overrides {
      // Only a swap recorded for a layer an instance swap property controls.
      let def = self
        .doc
        .get(key)
        .and_then(|m| m.prop_refs.as_ref())
        .and_then(|r| r.swap.as_ref())
        .and_then(|p| defs.iter().find(|d| &d.id == p))?;
      let obj = v.as_object()?;
      if obj.keys().any(|k| k != components::SWAP_KEY && k != "name") {
        return None;
      }
      let swap: InstanceInfo = serde_json::from_value(obj.get(components::SWAP_KEY)?.clone()).ok()?;
      if !swap.overrides.is_empty() || !swap.prop_values.is_empty() {
        return None;
      }
      let name = self.component_name(&swap.component_id);
      exprs.push((ident(&def.id), format!("<{name} />")));
    }
    for (pid, v) in &info.prop_values {
      let Some(def) = defs.iter().find(|d| &d.id == pid) else { continue };
      match v {
        serde_json::Value::Bool(b) => exprs.push((ident(&def.id), b.to_string())),
        serde_json::Value::String(t) => attrs.push((ident(&def.id), t.clone())),
        _ => {}
      }
    }
    Some(PropArgs { attrs, exprs })
  }

  /// h1 for the first large heading of a screen, h2/h3 for smaller ones.
  fn heading_tag(&mut self, n: &Node) -> &'static str {
    let Some(t) = n.text.as_ref() else { return "p" };
    if t.font_size >= 32.0 && !self.h1_used {
      self.h1_used = true;
      "h1"
    } else if t.font_size >= 24.0 {
      "h2"
    } else if t.font_size >= 18.0 && t.font_weight >= 600 {
      "h3"
    } else {
      "p"
    }
  }

  /// Landmark and control tags from layer names and behaviour.
  fn container_tag(&self, n: &Node) -> &'static str {
    let name = n.name.to_lowercase();
    let has = |w: &str| name.split(|c: char| !c.is_alphanumeric()).any(|p| p == w);
    let clickable = n
      .interactions
      .iter()
      .any(|i| matches!(i.trigger, crate::model::Trigger::OnClick | crate::model::Trigger::OnPress));
    let small = n.children.len() <= 3 && n.height <= 80.0;
    let has_text = self
      .doc
      .subtree(&n.id)
      .iter()
      .any(|c| self.doc.get(c).map(|x| x.kind == NodeType::Text).unwrap_or(false));
    if (has("button") || has("btn") || has("cta") || clickable) && small && has_text && n.kind != NodeType::Group {
      return "button";
    }
    if n.kind == NodeType::Group {
      return "div";
    }
    if has("nav") || has("navbar") || has("navigation") || has("menu") && n.layout.is_some() {
      "nav"
    } else if has("header") || name.contains("top bar") || has("topbar") {
      "header"
    } else if has("footer") {
      "footer"
    } else if has("sidebar") {
      "aside"
    } else if has("hero") || has("section") || has("features") || has("pricing") || has("testimonials") || has("faq") {
      "section"
    } else {
      "div"
    }
  }

  /// What an interaction does in the project: an `onNavigate` target with its overlay placement,
  /// or a URL to open. None for actions the export has no equivalent of (scroll to, change to).
  fn action_of(&self, n: &Node, i: &crate::model::Interaction) -> Option<(Option<String>, Option<serde_json::Value>, Option<String>)> {
    match i.action {
      Action::Navigate => {
        let name = i.destination.as_ref().and_then(|d| self.screen_names.get(d))?;
        Some((Some(name.clone()), None, None))
      }
      Action::Back => Some((Some("back".into()), None, None)),
      Action::OpenOverlay | Action::SwapOverlay => {
        let name = i.destination.as_ref().and_then(|d| self.screen_names.get(d))?;
        let kind = if i.action == Action::OpenOverlay {
          "overlay"
        } else {
          "swap-overlay"
        };
        Some((Some(format!("{kind}:{name}")), Some(self.overlay_opts(n, &i.overlay)), None))
      }
      Action::CloseOverlay => Some((Some("close-overlay".into()), None, None)),
      Action::OpenUrl => i.url.as_deref().and_then(crate::model::safe_link).map(|u| (None, None, Some(u))),
      Action::ScrollTo | Action::ChangeTo => None,
    }
  }

  /// Clicks and presses become the element's `onNavigate`; keys and delays go into the screen's
  /// tables in `App.tsx`. Hover, mouse enter/leave and Change to have no equivalent here.
  fn interactions(&mut self, el: &mut El, n: &Node) {
    use crate::model::Trigger;
    let mut best: Option<u8> = None;
    let mut delayed = false;
    for i in &n.interactions {
      match i.trigger {
        Trigger::OnClick | Trigger::OnPress | Trigger::MouseDown | Trigger::MouseUp => {
          // One handler per element: On click wins over Mouse up, Mouse down and While pressing.
          let rank = match i.trigger {
            Trigger::OnClick => 0,
            Trigger::MouseUp => 1,
            Trigger::MouseDown => 2,
            _ => 3,
          };
          if rank >= best.unwrap_or(u8::MAX) {
            continue;
          }
          if let Some((nav, overlay, url)) = self.action_of(n, i) {
            best = Some(rank);
            let target = || {
              i.destination
                .as_ref()
                .and_then(|d| self.doc.get(d))
                .map(|d| d.name.clone())
                .unwrap_or_default()
            };
            el.action_label = Some(match i.action {
              Action::Navigate => format!("Go to {}", target()),
              Action::Back => "Back".into(),
              Action::OpenOverlay | Action::SwapOverlay => format!("Open {}", target()),
              Action::CloseOverlay => "Close".into(),
              _ => "Open link".into(),
            });
            el.navigate = nav;
            el.overlay = overlay;
            el.url = url;
          }
        }
        Trigger::Key | Trigger::AfterDelay => {
          // Component functions have no screen of their own.
          let Some(screen) = self.screen.clone() else { continue };
          // Like the player: only a screen's own first After delay.
          if i.trigger == Trigger::AfterDelay && (delayed || !self.screen_names.contains_key(&n.id)) {
            continue;
          }
          let Some((nav, overlay, url)) = self.action_of(n, i) else {
            continue;
          };
          let mut v = serde_json::Map::new();
          if i.trigger == Trigger::Key {
            let Some(key) = i.key.clone().filter(|k| !k.is_empty()) else {
              continue;
            };
            v.insert("key".into(), json!(key));
          } else {
            delayed = true;
            v.insert("ms".into(), json!(if i.delay_ms > 0.0 { i.delay_ms } else { 800.0 }));
          }
          match (nav, url) {
            (Some(to), _) => {
              v.insert("to".into(), json!(to));
              if let Some(o) = overlay {
                v.insert("opts".into(), o);
              }
            }
            (None, Some(u)) => {
              v.insert("url".into(), json!(u));
            }
            _ => continue,
          }
          let table = if i.trigger == Trigger::Key {
            &mut self.keys
          } else {
            &mut self.delays
          };
          table.entry(screen).or_default().push(serde_json::Value::Object(v));
        }
        Trigger::OnHover | Trigger::MouseEnter | Trigger::MouseLeave => {}
      }
    }
    if el.navigate.is_some() || el.url.is_some() {
      el.s("cursor", "pointer");
    }
  }

  /// What `App.tsx` needs to place an overlay; manual offsets become a point on the screen.
  fn overlay_opts(&self, n: &Node, o: &OverlaySettings) -> serde_json::Value {
    let mut v = serde_json::json!({
      "position": serde_json::to_value(o.position).unwrap_or_default(),
      "closeOnClickOutside": o.close_on_click_outside,
      "background": o.background.as_ref().map(|b| color::css_with_opacity(&b.color, b.opacity)),
    });
    if o.position == OverlayPosition::Manual {
      let at = self.doc.abs_bounds(&n.id);
      let screen = self.doc.abs_bounds(&self.doc.top_level_of(&n.id));
      v["x"] = serde_json::json!((at.x - screen.x + o.offset_x).round());
      v["y"] = serde_json::json!((at.y - screen.y + o.offset_y).round());
    }
    v
  }

  fn position(&self, el: &mut El, n: &Node, place: Place) {
    let text_auto_w = n.text.as_ref().map(|t| t.auto_resize == TextAutoResize::Width).unwrap_or(false);
    let text_auto_h = n.text.as_ref().map(|t| t.auto_resize == TextAutoResize::Height).unwrap_or(false);
    let vectorish = matches!(n.kind, NodeType::Vector | NodeType::Polygon | NodeType::Star);
    match place {
      Place::Root => el.s("position", "relative"),
      Place::ComponentRoot => el.s("position", "relative"),
      Place::Absolute => {
        el.s("position", "absolute");
        if vectorish && n.rotation != 0.0 {
          // Rotated vectors are exported pre-rotated; place their bounding box.
          let b = self.doc.local_matrix(n).bounds_of(n.width, n.height);
          el.s("left", px(b.x));
          el.s("top", px(b.y));
        } else {
          el.s("left", px(n.x));
          el.s("top", px(n.y));
        }
      }
      Place::Flow { .. } => {}
    }
    let (fill_w, fill_h) = match place {
      Place::Flow { horizontal } => {
        let main_fill = if horizontal {
          n.sizing_h == Sizing::Fill
        } else {
          n.sizing_v == Sizing::Fill
        };
        let cross_fill = if horizontal {
          n.sizing_v == Sizing::Fill
        } else {
          n.sizing_h == Sizing::Fill
        };
        if main_fill {
          el.s("flex", "1 1 0");
          el.s(if horizontal { "min-width" } else { "min-height" }, "0");
        } else {
          el.s("flex-shrink", "0");
        }
        if cross_fill {
          el.s("align-self", "stretch");
        }
        (
          if horizontal { main_fill } else { cross_fill },
          if horizontal { cross_fill } else { main_fill },
        )
      }
      _ => (false, false),
    };
    if vectorish {
      return;
    }
    let hug_w = n.layout.is_some() && n.sizing_h == Sizing::Hug;
    let hug_h = n.layout.is_some() && n.sizing_v == Sizing::Hug;
    if place == Place::Root && n.parent.is_none() && n.kind == NodeType::Frame {
      // Screens stretch to the viewport up to their design width and grow with content.
      el.s("width", "100%");
      el.s("max-width", px(n.width));
      if !hug_h {
        // A scrolling screen is as tall as its frame, so its content scrolls inside it.
        let key = if n.overflow != crate::model::Overflow::None {
          "height"
        } else {
          "min-height"
        };
        el.s(key, px(n.height));
      }
      return;
    }
    if !fill_w && !hug_w && !text_auto_w {
      el.s("width", px(n.width));
    }
    if !fill_h && !hug_h && !text_auto_w && !text_auto_h && n.kind != NodeType::Line {
      el.s("height", px(n.height));
    }
    if n.rotation != 0.0 && !vectorish {
      el.s("transform", format!("rotate({}deg)", fmt(n.rotation)));
    }
  }

  /// Min and max size limits (`min-w-`, `max-w-`, `min-h-`, `max-h-` in Tailwind). They replace
  /// what `position` already emitted for the same property (a fill child's `min-width: 0`).
  fn limits(&self, el: &mut El, n: &Node) {
    let set = |el: &mut El, k: &str, v: f64| {
      let v = px(v);
      match el.styles.iter_mut().find(|(key, _)| key == k) {
        Some(e) => e.1 = v,
        None => el.s(k, v),
      }
    };
    for (key, v) in [
      ("min-width", n.min_width),
      ("max-width", n.max_width),
      ("min-height", n.min_height),
      ("max-height", n.max_height),
    ] {
      if let Some(v) = v {
        set(el, key, v);
      }
    }
    // Auto-width text only wraps at its max width if whitespace may collapse into line breaks.
    let auto_w = n.text.as_ref().is_some_and(|t| t.auto_resize == TextAutoResize::Width);
    if auto_w && n.max_width.is_some() {
      // Only `pre` becomes `pre-wrap`: a one-line `nowrap` (max lines 1) keeps its ellipsis.
      let mut wraps = false;
      for (k, v) in el.styles.iter_mut() {
        if k == "white-space" && v == "pre" {
          *v = "pre-wrap".into();
          wraps = true;
        }
      }
      if wraps {
        el.s("overflow-wrap", "anywhere");
      }
    }
  }

  /// Replaces literal values of variable-bound properties with CSS custom properties,
  /// and marks layers that switch a collection's mode.
  fn bind_vars(&self, el: &mut El, n: &Node) {
    use crate::variables as vars;
    for (coll_id, mode_id) in &n.variable_modes {
      if let Some(c) = self.doc.variables.iter().find(|c| &c.id == coll_id) {
        if let Some(m) = c.modes.iter().find(|m| &m.id == mode_id) {
          el.attrs.push((vars::mode_attr(self.doc, c), vars::mode_slug(c, m)));
        }
      }
    }
    if el.raw.is_some() {
      return;
    }
    for (prop, var_id) in &n.bindings {
      let Some((c, v)) = vars::find(self.doc, var_id) else { continue };
      let name = vars::css_name(c, v);
      let var = format!("var({name})");
      let len = format!("calc(var({name})*1px)");
      let set = |el: &mut El, key: &str, value: &str| {
        for (k, val) in el.styles.iter_mut() {
          if k == key {
            *val = value.to_string();
          }
        }
      };
      match prop.as_str() {
        "fill" if n.kind == NodeType::Text => set(el, "color", &var),
        "fill" => set(el, "background-color", &var),
        "stroke" => {
          if let Some(Paint::Solid { color, opacity, .. }) = n.strokes.iter().find(|p| p.visible()) {
            let lit = color::css_with_opacity(color, *opacity);
            for (k, val) in el.styles.iter_mut() {
              if k == "border" || k == "outline" || k == "border-top" || k == "border-color" || k == "-webkit-text-stroke" {
                *val = val.replace(&lit, &var);
              }
            }
          }
        }
        "cornerRadius" => set(el, "border-radius", &len),
        "padding" => match border_widths(n).filter(|b| b.iter().any(|w| *w > 0.0)) {
          // Per-side borders come out of the padding, as in `padding_value`.
          Some(b) => {
            let side = |w: f64| {
              if w > 0.0 {
                format!("max(0px, calc(var({name})*1px - {}px))", fmt(w))
              } else {
                len.clone()
              }
            };
            set(el, "padding", &b.map(side).join(" "));
          }
          None => set(el, "padding", &len),
        },
        "gap" => {
          let key = match n.layout.as_ref().map(|l| l.direction) {
            Some(LayoutDirection::Horizontal) => "column-gap",
            _ => "row-gap",
          };
          set(el, key, &len);
        }
        "opacity" => set(el, "opacity", &var),
        "fontSize" => set(el, "font-size", &len),
        _ => {}
      }
    }
  }

  /// Text styles become classes (`text-heading-1`) and colour styles custom properties
  /// (`--color-brand-primary`), where the layer still looks like its style. A fill bound to a
  /// variable keeps the variable.
  fn apply_styles(&mut self, el: &mut El, n: &Node) {
    if let (Some(t), Some(style)) = (
      n.text.as_ref(),
      n.text_style
        .as_ref()
        .and_then(|id| self.doc.styles.texts.iter().find(|s| &s.id == id)),
    ) {
      let same = t.font_family == style.font_family
        && t.font_size == style.font_size
        && t.font_weight == style.font_weight
        && t.line_height == style.line_height
        && t.letter_spacing == style.letter_spacing;
      if same && el.raw.is_none() {
        let class = self.names.texts.get(&style.id).cloned().unwrap_or_else(|| text_class(&style.name));
        const OWN: [&str; 5] = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing"];
        let mut decls: Vec<(String, String)> = el.styles.iter().filter(|(k, _)| OWN.contains(&k.as_str())).cloned().collect();
        if !decls.iter().any(|(k, _)| k == "font-weight") {
          decls.push(("font-weight".into(), "400".into()));
        }
        if !decls.iter().any(|(k, _)| k == "letter-spacing") {
          decls.push(("letter-spacing".into(), "0".into()));
        }
        decls.sort_by_key(|(k, _)| OWN.iter().position(|o| o == k));
        el.styles.retain(|(k, _)| !OWN.contains(&k.as_str()));
        el.classes.push(class.clone());
        self.text_classes.entry(class).or_insert(decls);
      }
    }
    if n.bindings.contains_key("fill") || el.raw.is_some() {
      return;
    }
    let Some(style) = n
      .fill_style
      .as_ref()
      .and_then(|id| self.doc.styles.colors.iter().find(|s| &s.id == id))
    else {
      return;
    };
    let Some(Paint::Solid { color: fill, opacity, .. }) = n.fills.iter().find(|p| p.visible()) else {
      return;
    };
    // A custom property holds the opaque colour, so a see-through fill keeps its literal value.
    if *opacity < 1.0 || color::normalize(fill) != color::normalize(&style.color) {
      return;
    }
    let key = if n.kind == NodeType::Text { "color" } else { "background-color" };
    let lit = color::css_with_opacity(fill, *opacity);
    let Some(name) = self.names.colors.get(&style.id).cloned() else {
      return;
    };
    if let Some((_, v)) = el.styles.iter_mut().find(|(k, v)| k == key && *v == lit) {
      *v = format!("var({name})");
      self.color_vars.insert(name, color::css_with_opacity(&style.color, 1.0));
    }
  }

  fn visual(&self, el: &mut El, n: &Node) {
    if n.opacity < 1.0 {
      el.s("opacity", fmt(n.opacity));
    }
    if n.blend_mode != crate::model::BlendMode::Normal {
      el.s("mix-blend-mode", n.blend_mode.css());
    }
    let vectorish = matches!(n.kind, NodeType::Vector | NodeType::Polygon | NodeType::Star);
    if vectorish {
      return;
    }
    if n.kind == NodeType::Line {
      if let Some(Paint::Solid { color, opacity, .. }) = n.strokes.iter().find(|p| p.visible()) {
        el.s(
          "border-top",
          format!("{} solid {}", px(n.stroke_weight), color::css_with_opacity(color, *opacity)),
        );
      }
      return;
    }
    if n.kind != NodeType::Text {
      let bgs: Vec<String> = n
        .fills
        .iter()
        .rev()
        .filter(|p| p.visible())
        .map(|p| css_paint(p, n.width, n.height))
        .collect();
      if bgs.len() == 1 && !bgs[0].contains('(') {
        el.s("background-color", bgs[0].clone());
      } else if !bgs.is_empty() {
        let layers: Vec<String> = bgs
          .iter()
          .map(|b| {
            if b.contains('(') {
              b.clone()
            } else {
              format!("linear-gradient({b}, {b})")
            }
          })
          .collect();
        el.s("background", layers.join(", "));
      }
      if has_diamond(n) {
        el.approx = Some(DIAMOND_NOTE.into());
      }
      if let Some(Paint::Image { scale_mode, crop, .. }) = n.fills.iter().find(|p| matches!(p, Paint::Image { .. }) && p.visible()) {
        match (scale_mode, crop) {
          // The whole image sits at `crop` in the layer's box; what pokes out is clipped by the box.
          (ScaleMode::Crop, Some(c)) => {
            el.s("background-size", format!("{} {}", px(c.w * n.width), px(c.h * n.height)));
            el.s("background-position", format!("{} {}", px(c.x * n.width), px(c.y * n.height)));
          }
          _ => {
            el.s(
              "background-size",
              match scale_mode {
                ScaleMode::Fill | ScaleMode::Crop => "cover",
                ScaleMode::Fit => "contain",
                ScaleMode::Stretch => "100% 100%",
                ScaleMode::Tile => "64px 64px",
              },
            );
            el.s("background-position", "center");
          }
        }
        if *scale_mode != ScaleMode::Tile {
          el.s("background-repeat", "no-repeat");
        }
      }
      if let (Some(weights), Some(Paint::Solid { color, opacity, .. })) = (side_weights(n), n.strokes.iter().find(|p| p.visible())) {
        side_strokes(el, n, weights, &color::css_with_opacity(color, *opacity));
      } else if let Some(Paint::Solid { color, opacity, .. }) = n.strokes.iter().find(|p| p.visible()) {
        if n.stroke_weight > 0.0 {
          let style = if n.stroke_dash.is_empty() { "solid" } else { "dashed" };
          let c = color::css_with_opacity(color, *opacity);
          // An outline takes no layout space (a border would grow hug sizes and shift absolute
          // children), paints above the children like Figma's strokes and follows the radius.
          el.s("outline", format!("{} {style} {c}", px(n.stroke_weight)));
          let offset = match n.stroke_align {
            StrokeAlign::Inside => -n.stroke_weight,
            StrokeAlign::Center => -n.stroke_weight / 2.0,
            StrokeAlign::Outside => 0.0,
          };
          el.s("outline-offset", px(offset));
        }
      }
      if n.kind == NodeType::Ellipse {
        el.s("border-radius", "50%");
      } else {
        let r = crate::shapes::corner_radii(n);
        if r.iter().any(|v| *v > 0.0) {
          if r.iter().all(|v| *v == r[0]) {
            el.s("border-radius", px(r[0]));
          } else {
            el.s("border-radius", r.iter().map(|v| px(*v)).collect::<Vec<_>>().join(" "));
          }
        }
      }
      if n.kind.is_frame_like() {
        match n.overflow {
          crate::model::Overflow::Horizontal => el.s("overflow-x", "auto"),
          crate::model::Overflow::Vertical => el.s("overflow-y", "auto"),
          crate::model::Overflow::Both => el.s("overflow", "auto"),
          crate::model::Overflow::None if n.clip_content => el.s("overflow", "hidden"),
          crate::model::Overflow::None => {}
        }
      }
    }
    let mut shadows: Vec<String> = n
      .effects
      .iter()
      .filter(|e| e.visible && matches!(e.kind, EffectType::DropShadow | EffectType::InnerShadow))
      .map(|e| {
        format!(
          "{}{} {} {} {} {}",
          if e.kind == EffectType::InnerShadow { "inset " } else { "" },
          px(e.x),
          px(e.y),
          px(e.blur),
          px(e.spread),
          color::css_with_opacity(&e.color, 1.0)
        )
      })
      .collect();
    // Per-side strokes that sit outside the box (or half of them) are shadows, see `side_strokes`.
    if let (Some(weights), Some(Paint::Solid { color, opacity, .. })) = (side_weights(n), n.strokes.iter().find(|p| p.visible())) {
      let c = color::css_with_opacity(color, *opacity);
      shadows.splice(0..0, side_shadows(n, weights, &c));
    }
    if !shadows.is_empty() {
      if n.kind == NodeType::Text {
        let ts: Vec<String> = shadows.iter().map(|s| s.replace("inset ", "")).collect();
        el.s("text-shadow", ts.join(", "));
      } else {
        el.s("box-shadow", shadows.join(", "));
      }
    }
    for e in n.effects.iter().filter(|e| e.visible) {
      match e.kind {
        EffectType::LayerBlur => el.s("filter", format!("blur({})", px(e.blur / 2.0))),
        EffectType::BackgroundBlur => el.s("backdrop-filter", format!("blur({})", px(e.blur / 2.0))),
        _ => {}
      }
    }
  }

  fn text_el(&self, n: &Node) -> El {
    let t = n.text.clone().unwrap_or_default();
    let mut el = El::new("p");
    el.text = Some(t.characters.clone());
    el.spans = text_spans(&t);
    el.s("margin", "0");
    match n.fills.iter().find(|p| p.visible()) {
      Some(Paint::Solid { color, opacity, .. }) => el.s("color", color::css_with_opacity(color, *opacity)),
      Some(p) => {
        el.s("background", css_paint(p, n.width, n.height));
        if has_diamond(n) {
          el.approx = Some(DIAMOND_NOTE.into());
        }
        el.s("-webkit-background-clip", "text");
        el.s("background-clip", "text");
        el.s("color", "transparent");
      }
      None => {}
    }
    el.s("font-family", css_family(&t.font_family));
    el.s("font-size", px(t.font_size));
    if t.font_weight != 400 {
      el.s("font-weight", t.font_weight.to_string());
    }
    if t.italic {
      el.s("font-style", "italic");
    }
    el.s("line-height", px(t.line_height_px()));
    if let (Some(Paint::Solid { color, opacity, .. }), true) = (n.strokes.iter().find(|p| p.visible()), n.stroke_weight > 0.0) {
      // Centre strokes keep their weight; outside ones are doubled and painted under the fill.
      // CSS has no inside stroke, so it falls back to the centre one.
      let c = color::css_with_opacity(color, *opacity);
      let outside = n.stroke_align == StrokeAlign::Outside;
      let w = if outside { n.stroke_weight * 2.0 } else { n.stroke_weight };
      el.s("-webkit-text-stroke", format!("{} {c}", px(w)));
      if outside {
        el.s("paint-order", "stroke fill");
      } else if n.stroke_align == StrokeAlign::Inside {
        let note = "Inside text strokes have no CSS equivalent; drawn centred.";
        el.approx = Some(match el.approx.take() {
          Some(prev) => format!("{prev} {note}"),
          None => note.into(),
        });
      }
    }
    if t.letter_spacing != 0.0 {
      el.s("letter-spacing", px(t.letter_spacing));
    }
    match t.align_h {
      TextAlignH::Left => {}
      TextAlignH::Center => el.s("text-align", "center"),
      TextAlignH::Right => el.s("text-align", "right"),
      TextAlignH::Justify => el.s("text-align", "justify"),
    }
    match t.decoration {
      TextDecoration::None => {}
      TextDecoration::Underline => el.s("text-decoration", "underline"),
      TextDecoration::Strikethrough => el.s("text-decoration", "line-through"),
    }
    match t.case {
      TextCase::Original => {}
      TextCase::Upper => el.s("text-transform", "uppercase"),
      TextCase::Lower => el.s("text-transform", "lowercase"),
      TextCase::Title => el.s("text-transform", "capitalize"),
    }
    // Truncation: one line is `truncate`, several are `line-clamp-N`.
    let limit = crate::text::line_limit(&t, Some(n.height));
    match limit {
      Some(1) => {
        el.s("overflow", "hidden");
        el.s("text-overflow", "ellipsis");
        el.s("white-space", "nowrap");
      }
      Some(k) => {
        el.s("overflow", "hidden");
        el.s("display", "-webkit-box");
        el.s("-webkit-line-clamp", k.to_string());
        el.s("-webkit-box-orient", "vertical");
      }
      None => {}
    }
    if limit != Some(1) {
      el.s(
        "white-space",
        if t.auto_resize == TextAutoResize::Width {
          "pre"
        } else {
          "pre-wrap"
        },
      );
      // Long words break like they do on the canvas instead of overflowing.
      if t.auto_resize != TextAutoResize::Width {
        el.s("overflow-wrap", "anywhere");
      }
    }
    // Paragraph spacing: one block per paragraph (a truncated text stays one block).
    if t.paragraph_spacing != 0.0 && t.characters.contains('\n') && limit.is_none() {
      let paras = split_paragraphs(&t.characters, std::mem::take(&mut el.spans));
      el.text = None;
      for (i, (text, spans)) in paras.into_iter().enumerate() {
        let mut p = El::new("span");
        p.s("display", "block");
        if i > 0 {
          p.s("margin-top", px(t.paragraph_spacing));
        }
        if text.is_empty() && spans.is_empty() {
          // An empty paragraph still takes a line.
          p.s("min-height", px(t.line_height_px()));
        }
        if spans.is_empty() {
          p.text = Some(text);
        } else {
          p.spans = spans;
        }
        el.children.push(p);
      }
    }
    el
  }
}

/// Valid nesting: a button or link inside another becomes a `div` (or `span` for text) with the
/// same classes; text inside a button or link is a `span`, never a paragraph or heading; links
/// inside their text become spans. A clickable layer inside a button stops the click there, so
/// only the innermost action runs, as in the prototype player.
fn fix_interactive(el: &mut El, in_component: bool) {
  fix_nested(el, false, in_component);
}

/// Whether anything below `el` is a button, a link, an element with an action, or a component
/// that renders a control: such an element can't be a control itself (nested interactive).
fn holds_control(el: &El) -> bool {
  el.children.iter().any(|c| {
    c.tag == "button"
      || c.tag == "a"
      || c.navigate.is_some()
      || c.url.is_some()
      || c.renders_control
      || c.spans.iter().any(|s| s.link.is_some())
      || holds_control(c)
  })
}

fn fix_nested(el: &mut El, inside: bool, acting: bool) {
  let interactive = el.tag == "button" || el.tag == "a";
  // A component reference passes its handler on as `onClick`; the component is the control.
  let has_action = (el.navigate.is_some() || el.url.is_some()) && el.component_ref.is_none();
  if inside {
    if interactive {
      el.tag = "div";
      el.attrs.retain(|(k, _)| k != "type" && k != "href");
    }
    if matches!(el.tag, "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
      el.tag = "span";
    }
    for sp in &mut el.spans {
      sp.link = None;
    }
  }
  // Only the innermost action runs, as in the prototype player.
  el.stop_click = (inside || acting) && has_action;
  el.holds_control = holds_control(el);
  el.focusable = !inside && !interactive && has_action && !el.holds_control;
  let inner = inside || interactive;
  let acting = acting || has_action;
  for c in &mut el.children {
    fix_nested(c, inner, acting);
  }
  name_control(el, interactive, has_action);
}

/// Layer names the editor gives (`Frame 3`, `Image`): no help to a screen reader.
fn is_default_name(name: &str) -> bool {
  let name = name.trim();
  let base = name.trim_end_matches(|c: char| c.is_ascii_digit()).trim_end();
  name.is_empty()
    || [
      "Frame",
      "Rectangle",
      "Ellipse",
      "Vector",
      "Group",
      "Line",
      "Polygon",
      "Star",
      "Image",
      "Instance",
      "Component",
      "Icon",
      "SVG",
      "Text",
    ]
    .contains(&base)
      && (base.len() == name.len() || name[base.len()..].starts_with(' '))
}

/// Whether the element has a name of its own to read: text, or an image with alt text.
fn has_visible_text(el: &El) -> bool {
  el.text.as_deref().is_some_and(|t| !t.trim().is_empty())
    || el.spans.iter().any(|s| !s.text.trim().is_empty())
    || el.text_prop.is_some()
    // A component reference is assumed to show text of its own.
    || el.component_ref.is_some()
    || (el.tag == "img" && el.attrs.iter().any(|(k, v)| k == "alt" && !v.trim().is_empty()))
    || el.children.iter().any(has_visible_text)
}

/// A button, link or focusable element with no text below it gets an `aria-label`.
fn name_control(el: &mut El, interactive: bool, has_action: bool) {
  let control = interactive || el.focusable;
  let root_control = el.is_component_root && !el.holds_control;
  if (!control && !root_control) || has_visible_text(el) || el.attrs.iter().any(|(k, _)| k == "aria-label") {
    return;
  }
  let label = if el.is_component_root {
    el.label.clone()
  } else {
    el.label.clone().or_else(|| has_action.then(|| el.action_label.clone()).flatten())
  };
  let Some(label) = label.filter(|l| !l.trim().is_empty()) else {
    return;
  };
  if control {
    el.attrs.push(("aria-label".into(), label));
  } else {
    // A component root is only a control while `onClick` is set.
    el.expr_attrs.push((
      "aria-label".into(),
      format!("onClick ? {} : undefined", serde_json::to_string(&label).unwrap_or_default()),
    ));
  }
}

/// Names of the classes and custom properties of the document's styles, by style id. Every style
/// gets its own: names that repeat get `-2`, `-3`, an empty name (all non-ASCII) `-N` by position,
/// and a colour never takes a variable's custom property.
#[derive(Default)]
pub(crate) struct StyleNames {
  pub colors: BTreeMap<String, String>,
  pub texts: BTreeMap<String, String>,
}

pub(crate) fn style_names(doc: &Document) -> StyleNames {
  let mut taken: BTreeSet<String> = doc
    .variables
    .iter()
    .flat_map(|c| c.variables.iter().map(move |v| crate::variables::css_name(c, v)))
    .collect();
  let mut out = StyleNames::default();
  let free = |base: String, taken: &mut BTreeSet<String>| {
    let mut name = base.clone();
    let mut i = 2;
    while taken.contains(&name) {
      name = format!("{base}-{i}");
      i += 1;
    }
    taken.insert(name.clone());
    name
  };
  for (i, c) in doc.styles.colors.iter().enumerate() {
    let slug = crate::variables::slug(&c.name);
    let base = if slug.is_empty() {
      format!("--color-style-{}", i + 1)
    } else {
      format!("--color-{slug}")
    };
    out.colors.insert(c.id.clone(), free(base, &mut taken));
  }
  let mut taken: BTreeSet<String> = BTreeSet::new();
  for (i, t) in doc.styles.texts.iter().enumerate() {
    let base = if crate::variables::slug(&t.name).is_empty() {
      format!("text-style-{}", i + 1)
    } else {
      text_class(&t.name)
    };
    out.texts.insert(t.id.clone(), free(base, &mut taken));
  }
  out
}

/// What `Query::Inspect` answers: the custom property of each colour style and variable, and the
/// class of each text style, as the exported project names them.
pub fn inspect_names(doc: &Document) -> serde_json::Value {
  let n = style_names(doc);
  let vars: BTreeMap<String, String> = doc
    .variables
    .iter()
    .flat_map(|c| c.variables.iter().map(move |v| (v.id.clone(), crate::variables::css_name(c, v))))
    .collect();
  json!({ "colorStyles": n.colors, "textStyles": n.texts, "variables": vars })
}

/// CSS class of a text style: "Heading 1" → `text-heading-1`. Names Tailwind already uses for a
/// utility (`text-center`) get a suffix.
fn text_class(name: &str) -> String {
  let slug = crate::variables::slug(name);
  let taken = matches!(
    slug.as_str(),
    "left"
      | "center"
      | "right"
      | "justify"
      | "start"
      | "end"
      | "wrap"
      | "nowrap"
      | "balance"
      | "pretty"
      | "clip"
      | "ellipsis"
      | "inherit"
      | "current"
      | "transparent"
      | "black"
      | "white"
      | "xs"
      | "sm"
      | "base"
      | "lg"
      | "xl"
  ) || slug.ends_with("xl");
  match (slug.is_empty(), taken) {
    (true, _) => "text-style".into(),
    (false, true) => format!("text-{slug}-style"),
    _ => format!("text-{slug}"),
  }
}

/// Splits a text (plain, or as styled spans) at its line breaks into paragraphs.
fn split_paragraphs(text: &str, spans: Vec<Span>) -> Vec<(String, Vec<Span>)> {
  if spans.is_empty() {
    return text.split('\n').map(|p| (p.to_string(), vec![])).collect();
  }
  let mut out: Vec<(String, Vec<Span>)> = vec![(String::new(), vec![])];
  for sp in spans {
    for (i, part) in sp.text.split('\n').enumerate() {
      if i > 0 {
        out.push((String::new(), vec![]));
      }
      if !part.is_empty() {
        out.last_mut().unwrap().1.push(Span {
          text: part.to_string(),
          styles: sp.styles.clone(),
          link: sp.link.clone(),
        });
      }
    }
  }
  out
}

/// The credit and source of a layer's visible image fill, if it is a stock photo.
fn image_credit(n: &Node) -> Option<(&ImageCredit, &str)> {
  n.fills.iter().find_map(|p| match p {
    Paint::Image {
      credit: Some(c),
      src,
      visible: true,
      ..
    } => Some((&**c, src.as_str())),
    _ => None,
  })
}

/// `alt` text of an image layer: the photo's description when it has one, else the layer name
/// (provider titles are often file names like DSC_0012).
fn photo_alt(n: &Node) -> String {
  match image_credit(n) {
    Some((c, _)) if !c.alt.trim().is_empty() => c.alt.trim().to_string(),
    _ => n.name.clone(),
  }
}

/// Distinct credits of the stock photos under `root` (or in the whole file), in layer id order.
fn credits_under(doc: &Document, root: Option<&str>) -> Vec<ImageCredit> {
  let mut out: Vec<(String, ImageCredit)> = Vec::new();
  let mut add = |n: &Node| {
    if let Some((c, src)) = image_credit(n) {
      let key = if c.photo_id.is_empty() {
        src.to_string()
      } else {
        format!("{}:{}", c.provider, c.photo_id)
      };
      if !out.iter().any(|(k, _)| *k == key) {
        out.push((key, c.clone()));
      }
    }
  };
  match root {
    None => doc.nodes.values().for_each(&mut add),
    Some(id) => {
      let mut stack = vec![id.to_string()];
      while let Some(id) = stack.pop() {
        if let Some(n) = doc.get(&id) {
          add(n);
          stack.extend(n.children.iter().cloned());
        }
      }
    }
  }
  out.into_iter().map(|(_, c)| c).collect()
}

/// Provider text as one plain line: control characters become spaces and angle brackets are
/// swapped for look-alikes, so it can't open a tag or close an HTML comment.
fn plain(s: &str) -> String {
  let flat: String = s
    .chars()
    .map(|ch| match ch {
      '<' => '‹',
      '>' => '›',
      c if c.is_control() => ' ',
      c => c,
    })
    .collect();
  flat.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `plain`, with Markdown syntax escaped.
fn md_text(s: &str) -> String {
  let mut out = String::new();
  for ch in plain(s).chars() {
    if "\\`*_[]()<>!#|~&".contains(ch) {
      out.push('\\');
    }
    out.push(ch);
  }
  out
}

/// One line per credit, for CREDITS.md and the HTML comment; `esc` cleans each provider field.
fn credit_line(c: &ImageCredit, esc: fn(&str) -> String) -> String {
  let (title, author, source, license) = (esc(&c.title), esc(&c.author), esc(&c.source), esc(&c.license));
  let mut line = format!("\"{}\"", if title.is_empty() { "Photo" } else { &title });
  if !author.is_empty() {
    line.push_str(&format!(" by {author}"));
  }
  if !source.is_empty() {
    line.push_str(&format!(" ({source})"));
  }
  if !license.is_empty() {
    line.push_str(&format!(", {license}"));
  }
  if c.attribution_required {
    line.push_str(" (attribution required)");
  }
  if c.non_commercial {
    line.push_str(" (non-commercial only)");
  }
  line
}

/// A link for CREDITS.md: https only, nothing that could end the link or start a new line.
fn md_link(url: &str) -> Option<String> {
  let ok = url.starts_with("https://")
    && !url
      .chars()
      .any(|ch| ch.is_whitespace() || ch.is_control() || "<>()\\`".contains(ch));
  ok.then(|| format!("<{url}>"))
}

/// CREDITS.md for a project, empty when no stock photos are used.
fn credits_md(doc: &Document) -> String {
  let credits = credits_under(doc, None);
  if credits.is_empty() {
    return String::new();
  }
  let mut out = String::from("# Photo credits\n\nStock photos used in this design. Keep the attribution where a licence asks for it.\n\n");
  for c in &credits {
    out.push_str(&format!("- {}\n", credit_line(c, md_text)));
    for (label, url) in [("Photo", &c.source_url), ("Author", &c.author_url), ("Licence", &c.license_url)] {
      if let Some(link) = md_link(url) {
        out.push_str(&format!("  - {label}: {link}\n"));
      }
    }
  }
  out
}

/// An HTML comment listing the credits under `root`, empty when there are none. Without `<` and
/// `>` in the text, `-->` and `--!>` can't appear inside it.
fn credits_comment(doc: &Document, root: &str) -> String {
  let credits = credits_under(doc, Some(root));
  if credits.is_empty() {
    return String::new();
  }
  let lines: Vec<String> = credits.iter().map(|c| format!("  {}", credit_line(c, plain))).collect();
  format!("<!-- Photo credits:\n{}\n-->\n", lines.join("\n"))
}

/// The image URL when a rectangle is just an image (one visible image fill).
fn image_only(n: &Node) -> Option<String> {
  if n.kind != NodeType::Rectangle || !n.children.is_empty() {
    return None;
  }
  let visible: Vec<&Paint> = n.fills.iter().filter(|p| p.visible()).collect();
  match visible.as_slice() {
    // A cropped image needs its background offset, which `<img>` can't express.
    [Paint::Image {
      scale_mode: ScaleMode::Crop,
      crop: Some(_),
      ..
    }] => None,
    [Paint::Image { src, .. }] => Some(src.clone()),
    _ => None,
  }
}

/// Splits a mixed-style text into spans with CSS for each override.
fn text_spans(t: &crate::model::TextProps) -> Vec<Span> {
  if t.runs.is_empty() {
    return vec![];
  }
  let chars: Vec<char> = t.characters.chars().collect();
  let mut out = Vec::new();
  let mut pos = 0;
  let plain = |a: usize, b: usize| Span {
    text: chars[a..b].iter().collect(),
    styles: vec![],
    link: None,
  };
  for r in &t.runs {
    let (start, end) = (r.start.min(chars.len()), r.end.min(chars.len()));
    if start > pos {
      out.push(plain(pos, start));
    }
    if end > start {
      let mut styles: Vec<(String, String)> = Vec::new();
      if let Some(f) = &r.font_family {
        styles.push(("font-family".into(), css_family(f)));
      }
      if let Some(v) = r.font_size {
        styles.push(("font-size".into(), px(v)));
      }
      if let Some(v) = r.font_weight {
        styles.push(("font-weight".into(), v.to_string()));
      }
      if let Some(v) = r.italic {
        styles.push(("font-style".into(), if v { "italic" } else { "normal" }.into()));
      }
      if let Some(c) = &r.color {
        styles.push(("color".into(), color::css_with_opacity(c, 1.0)));
      }
      let link = r.link.as_deref().and_then(crate::model::safe_link);
      // One decoration per span: the range's own (even "none") wins, a link underlines only
      // when neither the range nor its layer has one.
      let deco = match r.decoration {
        None if t.decoration == TextDecoration::None && link.is_some() => Some(TextDecoration::Underline),
        d => d,
      };
      if let Some(d) = deco {
        let v = match d {
          TextDecoration::None => "none",
          TextDecoration::Underline => "underline",
          TextDecoration::Strikethrough => "line-through",
        };
        styles.push(("text-decoration".into(), v.into()));
      }
      if let Some(v) = r.letter_spacing {
        styles.push(("letter-spacing".into(), px(v)));
      }
      if link.is_some() {
        // Browsers colour links themselves; keep the design's look.
        if r.color.is_none() {
          styles.push(("color".into(), "inherit".into()));
        }
      }
      out.push(Span {
        text: chars[start..end].iter().collect(),
        styles,
        link,
      });
    }
    pos = pos.max(end);
  }
  if pos < chars.len() {
    out.push(plain(pos, chars.len()));
  }
  out
}

/// A font stack for CSS, with quotes and backslashes in the family name escaped.
fn css_family(family: &str) -> String {
  font_stack(&family.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// A paint as a CSS background value for a layer of `w` x `h` (gradient handles are in layer units).
fn css_paint(p: &Paint, w: f64, h: f64) -> String {
  match p {
    Paint::Solid { color, opacity, .. } => color::css_with_opacity(color, *opacity),
    Paint::LinearGradient {
      stops,
      opacity,
      handles: Some(hd),
      ..
    } => {
      // CSS spans the whole box along the angle; the handles may cover only part of that line.
      let (t0, t1) = paint::linear_extent(hd, w, h);
      let mapped: Vec<crate::model::GradientStop> = stops
        .iter()
        .map(|s| crate::model::GradientStop {
          color: s.color.clone(),
          position: t0 + (t1 - t0) * s.position,
        })
        .collect();
      format!(
        "linear-gradient({}deg, {})",
        fmt(paint::handle_angle(hd, w, h)),
        css_stops(&mapped, *opacity)
      )
    }
    Paint::LinearGradient { stops, angle, opacity, .. } => format!("linear-gradient({}deg, {})", fmt(*angle), css_stops(stops, *opacity)),
    Paint::RadialGradient {
      stops,
      opacity,
      handles: Some(hd),
      ..
    } => radial_css(stops, *opacity, hd, w, h),
    Paint::RadialGradient { stops, opacity, .. } => format!("radial-gradient(circle, {})", css_stops(stops, *opacity)),
    Paint::AngularGradient {
      stops, opacity, handles, ..
    } => {
      let hd = handles.unwrap_or_else(|| paint::default_handles(true));
      format!(
        "conic-gradient(from {}deg at {}% {}%, {})",
        fmt(paint::handle_angle(&hd, w, h)),
        fmt(hd.start[0] * 100.0),
        fmt(hd.start[1] * 100.0),
        css_stops(stops, *opacity)
      )
    }
    // CSS has no diamond gradient: a radial one with the same centre and radii is the closest.
    Paint::DiamondGradient {
      stops, opacity, handles, ..
    } => radial_css(stops, *opacity, &handles.unwrap_or_else(|| paint::default_handles(false)), w, h),
    Paint::Image { src, .. } => format!("url('{}')", css_url(src)),
  }
}

/// An image source safe inside `url('…')` and a Tailwind class: text data URLs (SVG) are fully
/// percent-encoded, because spaces turn into `_` in a class, `)` ends the value and a lone `%`
/// is no escape at all.
fn css_url(src: &str) -> String {
  let text_data = src.starts_with("data:") && src.split(',').next().is_some_and(|h| !h.contains(";base64"));
  if !text_data {
    return src.replace('\'', "%27").replace('"', "%22");
  }
  let b = src.as_bytes();
  let mut out = String::with_capacity(src.len());
  for (i, c) in src.char_indices() {
    let escape = match c {
      ' ' | '(' | ')' | '\'' | '"' | '_' | '`' | '\\' | '#' | '<' | '>' => true,
      '%' => !(b.get(i + 1).is_some_and(u8::is_ascii_hexdigit) && b.get(i + 2).is_some_and(u8::is_ascii_hexdigit)),
      _ => false,
    };
    if escape {
      out.push_str(&format!("%{:02X}", c as u32));
    } else {
      out.push(c);
    }
  }
  out
}

fn radial_css(stops: &[crate::model::GradientStop], opacity: f64, hd: &crate::model::GradientHandles, w: f64, h: f64) -> String {
  let (rx, ry) = paint::handle_radii(hd, w, h);
  format!(
    "radial-gradient({}% {}% at {}% {}%, {})",
    fmt(rx),
    fmt(ry),
    fmt(hd.start[0] * 100.0),
    fmt(hd.start[1] * 100.0),
    css_stops(stops, opacity)
  )
}

const DIAMOND_NOTE: &str = "diamond gradient approximated";

fn has_diamond(n: &Node) -> bool {
  n.fills.iter().any(|p| p.visible() && matches!(p, Paint::DiamondGradient { .. }))
}

/// Per-side stroke weights, for the layers that draw them (boxes with a visible stroke).
fn side_weights(n: &Node) -> Option<[f64; 4]> {
  let boxy = matches!(
    n.kind,
    NodeType::Rectangle | NodeType::Frame | NodeType::Component | NodeType::ComponentSet | NodeType::Instance
  );
  n.stroke_weights.filter(|w| boxy && w.iter().any(|v| *v > 0.0))
}

/// The border widths `side_strokes` gives a layer (top, right, bottom, left), when it has any.
fn border_widths(n: &Node) -> Option<[f64; 4]> {
  let w = side_weights(n)?;
  n.strokes
    .iter()
    .find(|p| p.visible())
    .filter(|p| matches!(p, Paint::Solid { .. }))?;
  let k = match n.stroke_align {
    StrokeAlign::Inside => 1.0,
    StrokeAlign::Center => 0.5,
    StrokeAlign::Outside => 0.0,
  };
  Some(w.map(|v| v * k))
}

/// Per-side strokes as borders (inside) or, outside the box, `box-shadow`s with offsets and no
/// blur (see `side_shadows`): CSS borders can't sit outside without moving the layout. Corner
/// squares between two sides are left out of the shadows.
fn side_strokes(el: &mut El, n: &Node, weights: [f64; 4], color: &str) {
  let [t, r, b, l] = weights;
  let (bt, br, bb, bl) = match n.stroke_align {
    StrokeAlign::Inside => (t, r, b, l),
    StrokeAlign::Center => (t / 2.0, r / 2.0, b / 2.0, l / 2.0),
    StrokeAlign::Outside => (0.0, 0.0, 0.0, 0.0),
  };
  el.s("border-style", "solid");
  el.s("border-color", color);
  for (side, v) in [("top", bt), ("right", br), ("bottom", bb), ("left", bl)] {
    el.s(&format!("border-{side}-width"), px(v));
  }
}

/// The outside half (centre) or all (outside) of a per-side stroke as offset shadows.
fn side_shadows(n: &Node, weights: [f64; 4], color: &str) -> Vec<String> {
  let [t, r, b, l] = weights;
  let k = match n.stroke_align {
    StrokeAlign::Inside => return vec![],
    StrokeAlign::Center => 0.5,
    StrokeAlign::Outside => 1.0,
  };
  [(0.0, -t), (r, 0.0), (0.0, b), (-l, 0.0)]
    .into_iter()
    .filter(|(x, y)| *x != 0.0 || *y != 0.0)
    .map(|(x, y)| format!("{} {} 0 0 {color}", px(x * k), px(y * k)))
    .collect()
}

fn css_stops(stops: &[crate::model::GradientStop], opacity: f64) -> String {
  stops
    .iter()
    .map(|s| format!("{} {}%", color::css_with_opacity(&s.color, opacity), fmt(s.position * 100.0)))
    .collect::<Vec<_>>()
    .join(", ")
}

fn px(v: f64) -> String {
  if v == 0.0 {
    "0".into()
  } else {
    format!("{}{PX}", fmt(v))
  }
}

/// PascalCase identifier from a layer name.
pub fn pascal(name: &str, fallback: &str) -> String {
  let mut out = String::new();
  let mut up = true;
  for c in name.chars() {
    if c.is_ascii_alphanumeric() {
      if up {
        out.extend(c.to_uppercase());
        up = false;
      } else {
        out.push(c);
      }
    } else {
      up = true;
    }
  }
  if out.is_empty() || out.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
    out = format!("{fallback}{out}");
  }
  out
}

// ---------- Tailwind ----------

fn tw_value(v: &str) -> String {
  // A `"` would end the className string in the generated TSX.
  v.replace(' ', "_").replace('"', "'")
}

/// Converts a CSS declaration into Tailwind utility classes. A double quote would end the
/// `className="..."` attribute, so values use single quotes (`url('/a.png')`).
fn tw_class(k: &str, v: &str) -> String {
  tw_class_raw(k, v).replace('"', "'")
}

fn tw_class_raw(k: &str, v: &str) -> String {
  let a = tw_value(v);
  match (k, v) {
    ("position", "absolute") => "absolute".into(),
    ("position", "relative") => "relative".into(),
    ("display", "flex") => "flex".into(),
    ("flex-direction", "column") => "flex-col".into(),
    ("flex-wrap", "wrap") => "flex-wrap".into(),
    ("flex", "1 1 0") => "flex-1".into(),
    ("flex-shrink", "0") => "shrink-0".into(),
    ("min-width", "0") => "min-w-0".into(),
    ("min-height", "0") => "min-h-0".into(),
    ("align-self", "stretch") => "self-stretch".into(),
    ("justify-content", "center") => "justify-center".into(),
    ("justify-content", "flex-end") => "justify-end".into(),
    ("justify-content", "space-between") => "justify-between".into(),
    ("align-items", "center") => "items-center".into(),
    ("align-items", "flex-end") => "items-end".into(),
    ("align-items", "flex-start") => "items-start".into(),
    ("overflow", "hidden") => "overflow-hidden".into(),
    ("overflow", "auto") => "overflow-auto".into(),
    ("overflow-x", "auto") => "overflow-x-auto".into(),
    ("overflow-y", "auto") => "overflow-y-auto".into(),
    ("margin", "0") => "m-0".into(),
    ("cursor", "pointer") => "cursor-pointer".into(),
    ("white-space", "pre") => "whitespace-pre".into(),
    ("white-space", "pre-wrap") => "whitespace-pre-wrap".into(),
    ("text-align", "center") => "text-center".into(),
    ("text-align", "right") => "text-right".into(),
    ("text-align", "justify") => "text-justify".into(),
    ("text-decoration", "underline") => "underline".into(),
    ("text-decoration", "line-through") => "line-through".into(),
    ("text-transform", "uppercase") => "uppercase".into(),
    ("text-transform", "lowercase") => "lowercase".into(),
    ("text-transform", "capitalize") => "capitalize".into(),
    ("font-style", "italic") => "italic".into(),
    ("border-radius", "50%") => "rounded-full".into(),
    ("border-style", "solid") => "border-solid".into(),
    ("border-top-width", _) => tw_border_side("t", v),
    ("border-right-width", _) => tw_border_side("r", v),
    ("border-bottom-width", _) => tw_border_side("b", v),
    ("border-left-width", _) => tw_border_side("l", v),
    ("border-color", _) if v.starts_with("var(") => format!("border-[color:{a}]"),
    ("border-color", _) => format!("border-[{a}]"),
    ("background-size", "cover") => "bg-cover".into(),
    ("background-size", "contain") => "bg-contain".into(),
    ("background-position", "center") => "bg-center".into(),
    ("background-repeat", "no-repeat") => "bg-no-repeat".into(),
    ("width", "100%") => "w-full".into(),
    ("object-fit", "cover") => "object-cover".into(),
    ("object-fit", "contain") => "object-contain".into(),
    ("text-overflow", "ellipsis") => "truncate".into(),
    ("white-space", "nowrap") | ("display", "-webkit-box") | ("-webkit-box-orient", "vertical") => String::new(),
    ("-webkit-line-clamp", n) if n.parse::<u32>().is_ok_and(|n| (1..=6).contains(&n)) => format!("line-clamp-{n}"),
    ("-webkit-line-clamp", n) => format!("line-clamp-[{n}]"),
    ("color", "inherit") => "text-inherit".into(),
    ("display", "block") => "block".into(),
    ("margin-top", _) => format!("mt-[{a}]"),
    ("max-width", _) => format!("max-w-[{a}]"),
    ("min-width", _) => format!("min-w-[{a}]"),
    ("max-height", _) => format!("max-h-[{a}]"),
    ("min-height", _) => format!("min-h-[{a}]"),
    ("left", _) => format!("left-[{a}]"),
    ("top", _) => format!("top-[{a}]"),
    ("width", _) => format!("w-[{a}]"),
    ("height", _) => format!("h-[{a}]"),
    ("column-gap", _) => format!("gap-x-[{a}]"),
    ("row-gap", _) => format!("gap-y-[{a}]"),
    ("padding", _) => tw_padding(v),
    ("background-color", _) if v.starts_with("var(") => format!("bg-[color:{a}]"),
    ("color", _) if v.starts_with("var(") => format!("text-[color:{a}]"),
    ("background-color", _) => format!("bg-[{a}]"),
    ("color", _) => format!("text-[{a}]"),
    ("font-size", _) => format!("text-[length:{a}]"),
    ("font-weight", _) => format!("font-[{a}]"),
    ("line-height", _) => format!("leading-[{a}]"),
    ("letter-spacing", _) => format!("tracking-[{a}]"),
    ("border-radius", _) => format!("rounded-[{a}]"),
    ("opacity", _) => format!("opacity-[{a}]"),
    ("box-shadow", _) => format!("shadow-[{a}]"),
    ("font-family", _) => {
      let bare: String = v.chars().filter(|c| !matches!(c, '\'' | '"' | '\\' | '[' | ']')).collect();
      format!("font-[{}]", tw_value(&bare).replace(",_", ","))
    }
    _ => format!("[{k}:{a}]"),
  }
}

fn tw_border_side(side: &str, v: &str) -> String {
  if v == "0" || v == "0px" {
    format!("border-{side}-0")
  } else {
    format!("border-{side}-[{}]", tw_value(v))
  }
}

/// Splits a padding value at the spaces outside parentheses (`calc(1px + 2px)` stays whole).
fn split_top(v: &str) -> Vec<&str> {
  let (mut depth, mut start, mut out) = (0usize, 0usize, Vec::new());
  for (i, c) in v.char_indices() {
    match c {
      '(' => depth += 1,
      ')' => depth = depth.saturating_sub(1),
      ' ' if depth == 0 => {
        out.push(&v[start..i]);
        start = i + 1;
      }
      _ => {}
    }
  }
  out.push(&v[start..]);
  out
}

fn tw_padding(v: &str) -> String {
  let p: Vec<&str> = split_top(v);
  if p.len() != 4 {
    return format!("p-[{}]", tw_value(v));
  }
  let (t, r, b, l) = (p[0], p[1], p[2], p[3]);
  let cls = |pre: &str, val: &str| {
    if val == "0" {
      String::new()
    } else {
      format!("{pre}-[{}]", tw_value(val))
    }
  };
  if t == r && r == b && b == l {
    return cls("p", t);
  }
  let mut out = Vec::new();
  if t == b && l == r {
    out.push(cls("py", t));
    out.push(cls("px", l));
  } else {
    out.push(cls("pt", t));
    out.push(cls("pr", r));
    out.push(cls("pb", b));
    out.push(cls("pl", l));
  }
  out.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

fn jsx(el: &El, depth: usize, out: &mut String) {
  match &el.show_if {
    // A swap slot writes its own condition.
    Some(cond) if el.slot.is_none() => {
      let pad = "  ".repeat(depth);
      out.push_str(&format!("{pad}{{{cond} && (\n"));
      jsx_el(el, depth + 1, out);
      out.push_str(&format!("{pad})}}\n"));
    }
    _ => jsx_el(el, depth, out),
  }
}

fn jsx_el(el: &El, depth: usize, out: &mut String) {
  let pad = "  ".repeat(depth);
  if let Some(c) = &el.comment {
    out.push_str(&format!("{pad}{{/* {} */}}\n", c.replace("*/", "")));
  }
  if let Some(c) = &el.approx {
    out.push_str(&format!("{pad}{{/* {c} */}}\n"));
  }
  let mut classes: Vec<String> = el.styles.iter().map(|(k, v)| tw_class(k, v)).filter(|c| !c.is_empty()).collect();
  classes.dedup();
  classes.splice(0..0, el.classes.iter().cloned());
  let mut class_attr = classes.join(" ");
  if el.is_component_root {
    class_attr = format!("{{`{class_attr} ${{className ?? \"\"}}`}}");
  } else {
    class_attr = format!("\"{class_attr}\"");
  }
  let action = if let Some(screen) = &el.navigate {
    let opts = el.overlay.as_ref().map(|o| format!(", {o}")).unwrap_or_default();
    Some(format!("onNavigate?.({}{opts})", serde_json::to_string(screen).unwrap_or_default()))
  } else {
    el.url
      .as_ref()
      .map(|url| format!("window.open({}, \"_blank\")", serde_json::to_string(url).unwrap_or_default()))
  };
  let key_handler = |call: &str| {
    format!(" onKeyDown={{(e) => {{ if (e.target === e.currentTarget && (e.key === \"Enter\" || e.key === \" \")) {{ e.preventDefault(); {call}; }} }}}}")
  };
  let handler = match action {
    Some(a) => {
      let mut h = if el.stop_click {
        format!(" onClick={{(e) => {{ e.stopPropagation(); {a}; }}}}")
      } else {
        format!(" onClick={{() => {a}}}")
      };
      if el.focusable {
        h.push_str(" role=\"button\" tabIndex={0}");
        h.push_str(&key_handler(&a));
      }
      h
    }
    None if el.is_component_root => {
      // The caller's click handler; the click stops here so an outer action doesn't also run. A
      // component without controls inside is a control for the keyboard too.
      let mut h = " onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}".to_string();
      if el.tag != "button" && el.tag != "a" && !el.holds_control {
        h.push_str(" role={onClick ? \"button\" : undefined} tabIndex={onClick ? 0 : undefined}");
        h.push_str(" onKeyDown={onClick ? (e) => { if (e.target === e.currentTarget && (e.key === \"Enter\" || e.key === \" \")) { e.preventDefault(); onClick(); } } : undefined}");
      }
      h
    }
    None => String::new(),
  };
  let handler = format!(
    "{handler}{}",
    el.attrs
      .iter()
      .map(|(k, v)| format!(" {k}={}", jsx_attr_value(v)))
      .collect::<String>()
  );
  let handler = format!(
    "{handler}{}",
    el.expr_attrs.iter().map(|(k, v)| format!(" {k}={{{v}}}")).collect::<String>()
  );
  if let Some(name) = &el.component_ref {
    match &el.slot {
      Some(slot) => {
        let expr = format!("{slot} ?? <{name} className={class_attr}{handler} />");
        match &el.show_if {
          Some(cond) => out.push_str(&format!("{pad}{{{cond} && ({expr})}}\n")),
          None => out.push_str(&format!("{pad}{{{expr}}}\n")),
        }
      }
      None => out.push_str(&format!("{pad}<{name} className={class_attr}{handler} />\n")),
    }
    return;
  }
  if let Some(svg) = &el.raw {
    out.push_str(&format!(
      "{pad}<div className={class_attr}{handler} dangerouslySetInnerHTML={{{{ __html: {} }}}} />\n",
      serde_json::to_string(svg).unwrap_or_default()
    ));
    return;
  }
  if let Some(prop) = &el.text_prop {
    out.push_str(&format!(
      "{pad}<{tag} className={class_attr}{handler}>{{{prop}}}</{tag}>\n",
      tag = el.tag
    ));
    return;
  }
  if !el.spans.is_empty() {
    let inner: String = el
      .spans
      .iter()
      .map(|sp| {
        let txt = format!("{{{}}}", serde_json::to_string(&sp.text).unwrap_or_default());
        let classes: Vec<String> = sp.styles.iter().map(|(k, v)| tw_class(k, v)).collect();
        match (&sp.link, classes.is_empty()) {
          (Some(href), _) => format!(
            "<a href={} target=\"_blank\" rel=\"noopener noreferrer\" className=\"{}\">{txt}</a>",
            serde_json::to_string(href).unwrap_or_default(),
            classes.join(" ")
          ),
          (None, true) => txt,
          (None, false) => format!("<span className=\"{}\">{txt}</span>", classes.join(" ")),
        }
      })
      .collect();
    out.push_str(&format!(
      "{pad}<{tag} className={class_attr}{handler}>{inner}</{tag}>\n",
      tag = el.tag
    ));
    return;
  }
  if let Some(t) = &el.text {
    out.push_str(&format!(
      "{pad}<{tag} className={class_attr}{handler}>{{{}}}</{tag}>\n",
      serde_json::to_string(t).unwrap_or_default(),
      tag = el.tag
    ));
    return;
  }
  if el.children.is_empty() {
    out.push_str(&format!("{pad}<{} className={class_attr}{handler} />\n", el.tag));
    return;
  }
  out.push_str(&format!("{pad}<{} className={class_attr}{handler}>\n", el.tag));
  for c in &el.children {
    jsx(c, depth + 1, out);
  }
  out.push_str(&format!("{pad}</{}>\n", el.tag));
}

fn html(el: &El, depth: usize, out: &mut String) {
  let pad = "  ".repeat(depth);
  let mut decls: Vec<(String, String)> = Vec::new();
  if el.tag == "button" {
    // Browsers style buttons; start from a clean slate like Tailwind's preflight.
    decls.extend(
      [
        ("border", "0"),
        ("background", "none"),
        ("font", "inherit"),
        ("color", "inherit"),
        ("cursor", "pointer"),
      ]
      .map(|(k, v)| (k.to_string(), v.to_string())),
    );
  }
  decls.extend(el.styles.iter().cloned());
  let mut style: String = decls.iter().map(|(k, v)| format!("{k}: {v}; ")).collect();
  if let Some(c) = &el.approx {
    style.push_str(&format!("/* {c} */"));
  }
  let style = esc(style.trim_end());
  let mut link = el
    .navigate
    .as_ref()
    .map(|s| format!(" data-navigate=\"{}\"", esc(s)))
    .unwrap_or_default();
  for (k, v) in &el.attrs {
    link.push_str(&format!(" {k}=\"{}\"", esc(v)));
  }
  if el.tag == "img" {
    out.push_str(&format!("{pad}<img style=\"{style}\"{link} />\n"));
  } else if let Some(svg) = &el.raw {
    out.push_str(&format!("{pad}<div style=\"{style}\"{link}>{svg}</div>\n"));
  } else if !el.spans.is_empty() {
    let inner: String = el
      .spans
      .iter()
      .map(|sp| {
        let st: String = sp.styles.iter().map(|(k, v)| format!("{k}: {v}; ")).collect();
        let st = esc(st.trim_end());
        match (&sp.link, st.is_empty()) {
          (Some(href), _) => format!(
            "<a href=\"{}\" target=\"_blank\" rel=\"noopener noreferrer\" style=\"{st}\">{}</a>",
            esc(href),
            esc(&sp.text)
          ),
          (None, true) => esc(&sp.text),
          (None, false) => format!("<span style=\"{st}\">{}</span>", esc(&sp.text)),
        }
      })
      .collect();
    out.push_str(&format!("{pad}<{tag} style=\"{style}\"{link}>{inner}</{tag}>\n", tag = el.tag));
  } else if let Some(t) = &el.text {
    out.push_str(&format!("{pad}<{tag} style=\"{style}\"{link}>{}</{tag}>\n", esc(t), tag = el.tag));
  } else {
    out.push_str(&format!("{pad}<{} style=\"{style}\"{link}>\n", el.tag));
    for c in &el.children {
      html(c, depth + 1, out);
    }
    out.push_str(&format!("{pad}</{}>\n", el.tag));
  }
}

fn google_fonts_link(doc: &Document) -> String {
  let fams: BTreeSet<String> = doc
    .nodes
    .values()
    .filter_map(|n| n.text.as_ref())
    .map(|t| t.font_family.clone())
    .collect();
  if fams.is_empty() {
    return String::new();
  }
  let q: Vec<String> = fams
    .iter()
    .map(|f| format!("family={}:wght@300;400;500;600;700;800", f.replace(' ', "+")))
    .collect();
  format!("https://fonts.googleapis.com/css2?{}&display=swap", q.join("&"))
}

/// `viewport-fit=cover` lets a page reach under the notch, which `env(safe-area-inset-*)` needs.
fn viewport_fit(mobile: bool) -> &'static str {
  if mobile {
    ", viewport-fit=cover"
  } else {
    ""
  }
}

/// Standalone HTML document for a node.
pub fn export_html(doc: &Document, id: &str, m: &dyn TextMeasurer) -> String {
  let mut ctx = Ctx::new(doc, m, false);
  let Some(el) = ctx.build(id, Place::Root) else {
    return String::new();
  };
  let mut body = String::new();
  html(&el, 2, &mut body);
  let fonts = google_fonts_link(doc);
  let name = doc.get(id).map(|n| n.name.clone()).unwrap_or_default();
  let credits = credits_comment(doc, id);
  format!(
    "<!doctype html>\n{credits}<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0{}\" />\n  <title>{}</title>\n{}  <style>*, *::before, *::after {{ box-sizing: border-box; }} body {{ margin: 0; }} :focus-visible {{ outline: 2px solid #2563eb !important; outline-offset: 2px !important; }}{}</style>\n</head>\n<body>\n<main>\n{}</main>\n</body>\n</html>\n",
    viewport_fit(doc.get(id).is_some_and(|n| n.device.as_ref().is_some_and(crate::devices::is_mobile))),
    esc(&name),
    if fonts.is_empty() { String::new() } else { format!("  <link rel=\"stylesheet\" href=\"{}\" />\n", esc(&fonts)) },
    if doc.variables.is_empty() { String::new() } else { format!("\n{}", crate::variables::tokens_css(doc)) },
    body
  )
}

/// A single React + Tailwind component file for a node.
pub fn export_react(doc: &Document, id: &str, m: &dyn TextMeasurer) -> String {
  let mut ctx = Ctx::new(doc, m, true);
  let name = doc.get(id).map(|n| pascal(&n.name, "Design")).unwrap_or_else(|| "Design".into());
  let Some(el) = ctx.build(id, Place::Root) else {
    return String::new();
  };
  let mut out = String::from("// Generated by Designotron. Requires Tailwind CSS.\n\n");
  out.push_str(&component_fns(&mut ctx));
  out.push_str(&screen_fn(&name, &el, true));
  out
}

fn screen_fn(name: &str, el: &El, export_default: bool) -> String {
  let mut body = String::new();
  jsx(el, 2, &mut body);
  format!(
    "{}function {name}({{ onNavigate }}: {{ onNavigate?: {NAVIGATE} }}) {{\n  return (\n{body}  );\n}}\n",
    if export_default { "export default " } else { "export " }
  )
}

/// Generates functions for every component registered so far (and those they reference).
fn component_fns(ctx: &mut Ctx) -> String {
  let mut out = String::new();
  let mut i = 0;
  while i < ctx.component_order.len() {
    let id = ctx.component_order[i].clone();
    i += 1;
    let Some(name) = ctx.components.get(&id).cloned() else { continue };
    ctx.cur_comp = Some(id.clone());
    ctx.used_props.clear();
    let built = ctx.build(&id, Place::ComponentRoot);
    ctx.cur_comp = None;
    if let Some(el) = built {
      let mut body = String::new();
      jsx(&el, 2, &mut body);
      // Variants are reached through their set's component.
      let export = if ctx.variant_set(&id).is_some() { "" } else { "export " };
      let (params, types) = prop_params(&ctx.used_props);
      out.push_str(&jsdoc(
        ctx.doc.get(&id).and_then(|n| n.component.as_ref()).map(|c| c.description.as_str()),
      ));
      out.push_str(&format!(
        "{export}function {name}({{ {params}className, onClick, onNavigate }}: {PROPS_OPEN}{types} }}) {{\n  void onNavigate;\n  return (\n{body}  );\n}}\n\n"
      ));
    }
  }
  for (set_id, set_name) in ctx.sets.clone() {
    if let Some(set) = ctx.doc.get(&set_id) {
      out.push_str(&set_fn(ctx, set, &set_name));
    }
  }
  out
}

/// A description as a JSDoc comment above a function (nothing when it is empty).
fn jsdoc(description: Option<&str>) -> String {
  let text = description.unwrap_or("").trim().replace("*/", "* /");
  if text.is_empty() {
    String::new()
  } else if !text.contains('\n') {
    format!("/** {text} */\n")
  } else {
    let lines: Vec<String> = text.lines().map(|l| format!(" * {l}").trim_end().to_string()).collect();
    format!("/**\n{}\n */\n", lines.join("\n"))
  }
}

/// Start of the props type of a component function; component property props follow it.
const PROPS_OPEN: &str =
  "{ className?: string; onClick?: () => void; onNavigate?: (screen: string, overlay?: Record<string, unknown>) => void;";

/// Destructuring entries (with defaults) and type members for the component properties a
/// function uses: `icon = true, label = "Buy", ` and ` icon?: boolean; label?: string;`.
fn prop_params(used: &[UsedProp]) -> (String, String) {
  let mut params = String::new();
  let mut types = String::new();
  for u in used {
    let ty = match u.kind {
      PropKind::Boolean => "boolean",
      PropKind::Text => "string",
      PropKind::InstanceSwap => "React.ReactNode",
    };
    match u.kind {
      PropKind::InstanceSwap => params.push_str(&format!("{}, ", u.ident)),
      _ => params.push_str(&format!("{} = {}, ", u.ident, u.default)),
    }
    types.push_str(&format!(" {}?: {ty};", u.ident));
  }
  (params, types)
}
/// Type of the `onNavigate` prop; the second argument places overlays (see `App.tsx`).
const NAVIGATE: &str = "(screen: string, overlay?: Record<string, unknown>) => void";

fn variants(doc: &Document, set: &Node) -> Vec<Node> {
  set
    .children
    .iter()
    .filter_map(|c| doc.get(c))
    .filter(|c| c.kind == NodeType::Component)
    .cloned()
    .collect()
}

/// Names a React prop can't have: ours, React's, and JavaScript's reserved words.
const RESERVED_PROPS: &[&str] = &[
  "className",
  "onClick",
  "onNavigate",
  "key",
  "ref",
  "children",
  "rest",
  "style",
  "arguments",
  "eval",
  "undefined",
  "await",
  "async",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
];

/// camelCase prop name for a variant property ("Size" → `size`).
pub(crate) fn prop_ident(key: &str) -> String {
  let mut id = camel(key);
  if RESERVED_PROPS.contains(&id.as_str()) {
    id.push_str("Prop");
  }
  id
}

fn camel(key: &str) -> String {
  let p = pascal(key, "Prop");
  p.chars()
    .next()
    .map(|c| c.to_ascii_lowercase())
    .into_iter()
    .chain(p.chars().skip(1))
    .collect()
}

/// The React prop name of each component property (by property id) of component `comp`: never
/// a reserved word, never the name of a variant property or of another property.
fn prop_idents(doc: &Document, comp: &str) -> BTreeMap<String, String> {
  let mut taken: BTreeSet<String> = BTreeSet::new();
  let variant_keys: Vec<String> = match props::owner(doc, comp).and_then(|o| doc.get(&o)) {
    Some(o) if o.kind == NodeType::ComponentSet => variants(doc, o).iter().flat_map(|v| v.variant_props().into_keys()).collect(),
    Some(o) => o.variant_props().into_keys().collect(),
    None => Vec::new(),
  };
  taken.extend(variant_keys.iter().map(|k| prop_ident(k)));
  let mut out = BTreeMap::new();
  for d in props::props_of(doc, comp) {
    let mut id = camel(&d.name);
    while RESERVED_PROPS.contains(&id.as_str()) || taken.contains(&id) {
      id.push_str("Prop");
    }
    taken.insert(id.clone());
    out.insert(d.id, id);
  }
  out
}

/// An attribute value as JSX: a plain string literal when it has nothing JSX would read
/// differently (quotes, backslashes, entities, control characters), else an expression.
fn jsx_attr_value(v: &str) -> String {
  let plain = !v.chars().any(|c| matches!(c, '"' | '\\' | '&') || c.is_control());
  let json = serde_json::to_string(v).unwrap_or_default();
  if plain {
    json
  } else {
    format!("{{{json}}}")
  }
}

/// The exported component for a component set: picks the variant matching its props,
/// defaulting to the set's first variant.
fn set_fn(ctx: &Ctx, set: &Node, name: &str) -> String {
  let vs = variants(ctx.doc, set);
  let Some(first) = vs.first() else { return String::new() };
  let mut keys: Vec<String> = Vec::new();
  for v in &vs {
    for k in v.variant_props().keys() {
      if !keys.contains(k) {
        keys.push(k.clone());
      }
    }
  }
  let defaults = first.variant_props();
  let q = |v: &str| serde_json::to_string(v).unwrap_or_default();
  let params: Vec<String> = keys
    .iter()
    .map(|k| match defaults.get(k) {
      Some(d) => format!("{} = {}", prop_ident(k), q(d)),
      None => prop_ident(k),
    })
    .collect();
  let mut types: Vec<String> = keys
    .iter()
    .map(|k| {
      let mut values: Vec<String> = Vec::new();
      for v in &vs {
        if let Some(val) = v.variant_props().get(k) {
          if !values.contains(val) {
            values.push(val.clone());
          }
        }
      }
      format!(
        "{}?: {}",
        prop_ident(k),
        values.iter().map(|v| q(v)).collect::<Vec<_>>().join(" | ")
      )
    })
    .collect();
  // Component properties are shared by the variants, which pick them up through `...rest`.
  let idents = prop_idents(ctx.doc, &set.id);
  for d in props::props_of(ctx.doc, &set.id) {
    let ty = match d.kind {
      PropKind::Boolean => "boolean",
      PropKind::Text => "string",
      PropKind::InstanceSwap => "React.ReactNode",
    };
    types.push(format!("{}?: {ty}", idents.get(&d.id).cloned().unwrap_or_default()));
  }
  let mut body = String::new();
  for v in vs.iter().skip(1) {
    let Some(fname) = ctx.components.get(&v.id) else { continue };
    let cond: Vec<String> = v
      .variant_props()
      .iter()
      .map(|(k, val)| format!("{} === {}", prop_ident(k), q(val)))
      .collect();
    if !cond.is_empty() {
      body.push_str(&format!("  if ({}) return <{fname} {{...rest}} />;\n", cond.join(" && ")));
    }
  }
  let default_fn = ctx.components.get(&first.id).cloned().unwrap_or_default();
  body.push_str(&format!("  return <{default_fn} {{...rest}} />;\n"));
  // The set's description, or its first variant's.
  let described = std::iter::once(set).chain(vs.iter());
  let doc_text = described
    .filter_map(|n| n.component.as_ref())
    .map(|c| c.description.as_str())
    .find(|d| !d.trim().is_empty());
  format!(
    "{}export function {name}({{ {}, ...rest }}: {{ {}; className?: string; onClick?: () => void; onNavigate?: {NAVIGATE} }}) {{\n{body}}}\n\n",
    jsdoc(doc_text),
    params.join(", "),
    types.join("; ")
  )
}

/// `index.css` rules for the text style classes and colour style custom properties in use.
fn style_css(ctx: &Ctx) -> String {
  if ctx.color_vars.is_empty() && ctx.text_classes.is_empty() {
    return String::new();
  }
  let mut out = String::from("\n/* Styles from Designotron. */\n");
  if !ctx.color_vars.is_empty() {
    out.push_str("@layer base {\n  :root {\n");
    for (name, color) in &ctx.color_vars {
      out.push_str(&format!("    {name}: {color};\n"));
    }
    out.push_str("  }\n}\n");
  }
  if !ctx.text_classes.is_empty() {
    out.push_str("@layer components {\n");
    for (class, decls) in &ctx.text_classes {
      let get = |k: &str| decls.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
      let size = get("font-size").unwrap_or_else(|| "16px".into());
      let line = get("line-height").unwrap_or_else(|| "normal".into());
      let family = get("font-family").unwrap_or_else(|| "sans-serif".into());
      let weight = get("font-weight").unwrap_or_else(|| "400".into());
      out.push_str(&format!(
        "  .{class} {{\n    font: {weight} {size}/{line} {family};\n    letter-spacing: {};\n  }}\n",
        get("letter-spacing").unwrap_or_else(|| "0".into())
      ));
    }
    out.push_str("}\n");
  }
  out
}

/// Collections with more than one mode: (attribute suffix, mode names as written in CSS).
fn themed_collections(doc: &Document) -> Vec<(String, Vec<String>)> {
  doc
    .variables
    .iter()
    .filter(|c| c.modes.len() > 1)
    .map(|c| {
      (
        crate::variables::mode_attr(doc, c).trim_start_matches("data-").to_string(),
        c.modes.iter().map(|m| crate::variables::mode_slug(c, m)).collect(),
      )
    })
    .collect()
}

/// `tokens.ts`: switches a collection's mode by setting `data-<collection>` on the root element.
fn tokens_ts(themed: &[(String, Vec<String>)]) -> String {
  let q = |v: &str| serde_json::to_string(v).unwrap_or_default();
  let rows: String = themed
    .iter()
    .map(|(c, modes)| format!("  {}: [{}],\n", q(c), modes.iter().map(|m| q(m)).collect::<Vec<_>>().join(", ")))
    .collect();
  format!(
    "// Theme modes from Designotron variable collections. The first mode of each is the default.\n// Each mode is a [data-<collection>=\"<mode>\"] block in tokens.css.\n\nexport const modes = {{\n{rows}}} as const;\n\nexport type ModeCollection = keyof typeof modes;\n\n/** Switches a collection to one of its modes, for example `setMode(\"{}\", \"{}\")`. */\nexport function setMode<C extends ModeCollection>(collection: C, mode: (typeof modes)[C][number]): void {{\n  document.documentElement.setAttribute(`data-${{collection}}`, mode);\n}}\n",
    themed[0].0,
    themed[0].1.last().cloned().unwrap_or_default()
  )
}

/// Where each page's flow starts: the project opens the first one, `/#Screen` any other.
fn readme_flows(doc: &Document, ctx: &Ctx) -> String {
  let flows: Vec<String> = doc
    .pages
    .iter()
    .filter_map(|p| {
      let name = p.flow_start.as_ref().and_then(|s| ctx.screen_names.get(s))?;
      Some(format!("- {}: `/#{name}`\n", md_text(&p.name)))
    })
    .collect();
  if flows.is_empty() {
    return String::new();
  }
  format!(
    "\n## Flows\n\nThe project opens at the first flow start that names a screen. Open another flow, or any screen, with its name after `#`:\n\n{}",
    flows.concat()
  )
}

/// Strokes are author `outline`s, which would hide the browser's focus ring: this puts one back.
const FOCUS_CSS: &str = ":focus-visible { outline: 2px solid #2563eb !important; outline-offset: 2px !important; }\n";

/// What the prototype and the export don't carry over, and the top-level layers left out.
fn readme_limits(doc: &Document) -> String {
  let mut out = String::from(
    "\n## What isn't exported\n\n- Screen transitions and animations (screens change instantly).\n- Hover and Change to states, and mouse enter / mouse leave triggers. While pressing becomes a click when the layer has no On click (it doesn't revert).\n- Key and After delay triggers inside reusable components (the ones on screens are in `src/App.tsx`).\n- Strokes are CSS `outline`s (they take no layout space, like Figma's), so `src/index.css` ends with a `:focus-visible` rule that keeps a keyboard focus ring; restyle it to taste.\n- Accessible names (`aria-label`) generated for icon-only controls are in English (\"Go to Detail\", \"Back\"); translate them for other languages.\n",
  );
  let left_out: Vec<&str> = doc
    .pages
    .iter()
    .flat_map(|p| p.children.iter())
    .filter_map(|id| doc.get(id))
    .filter(|n| !matches!(n.kind, NodeType::Frame | NodeType::Component | NodeType::ComponentSet))
    .map(|n| n.name.as_str())
    .collect();
  if !left_out.is_empty() {
    let shown: Vec<String> = left_out.iter().take(8).map(|n| md_text(n)).collect();
    let more = left_out.len().saturating_sub(shown.len());
    out.push_str(&format!(
      "- Not exported: {} layer{} outside frames: {}{}. Put them in a frame to export them.\n",
      left_out.len(),
      if left_out.len() == 1 { "" } else { "s" },
      shown.join(", "),
      if more > 0 { format!(" and {more} more") } else { String::new() }
    ));
  }
  out
}

fn readme_themes(themed: &[(String, Vec<String>)]) -> String {
  if themed.is_empty() {
    return String::new();
  }
  let mut out = String::from("\n## Theme modes\n\nVariable collections with several modes are CSS custom properties in `src/tokens.css`, one `[data-<collection>=\"<mode>\"]` block per mode. The first mode is the default. Switch one from code with `setMode` in `src/tokens.ts`:\n\n```ts\nimport { setMode } from \"./tokens\";\n\n");
  for (c, modes) in themed {
    out.push_str(&format!("setMode({c:?}, {:?});\n", modes.last().cloned().unwrap_or_default()));
  }
  out.push_str(
    "```\n\nA frame that sets a mode in the design keeps its `data-<collection>` attribute, so that screen stays in that mode.\n\nNumber tokens are unitless, like Figma's, because one variable can feed both an opacity and a padding. Use them as lengths with `calc(var(--space-8) * 1px)`.\n",
  );
  out
}

pub struct ProjectFile {
  pub path: String,
  pub content: String,
}

/// A complete Vite + React + Tailwind project: one screen per top-level frame.
pub fn export_project(doc: &Document, m: &dyn TextMeasurer) -> Vec<ProjectFile> {
  let mut ctx = Ctx::new(doc, m, true);
  ctx.style_classes = true;
  ctx.names = style_names(doc);
  ctx.register_library();
  let mut files = Vec::new();
  let screens: Vec<(String, String)> = ctx.screen_order.clone();
  let mut screen_src = Vec::new();
  for (id, name) in &screens {
    ctx.screen = Some(name.clone());
    if let Some(el) = ctx.build(id, Place::Root) {
      screen_src.push((name.clone(), screen_fn(name, &el, true)));
    }
  }
  ctx.screen = None;
  let comps = component_fns(&mut ctx);
  let comp_names: Vec<String> = ctx.components.values().chain(ctx.sets.values()).cloned().collect();
  files.push(ProjectFile {
    path: "src/components.tsx".into(),
    content: format!("// Reusable components generated from Designotron main components.\n\n{comps}"),
  });
  for (name, src) in &screen_src {
    let used: Vec<&String> = comp_names.iter().filter(|c| src.contains(&format!("<{c} "))).collect();
    let import = if used.is_empty() {
      String::new()
    } else {
      format!(
        "import {{ {} }} from \"../components\";\n\n",
        used.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
      )
    };
    files.push(ProjectFile {
      path: format!("src/screens/{name}.tsx"),
      content: format!("{import}{src}"),
    });
  }
  let start = doc
    .pages
    .iter()
    .find_map(|p| p.flow_start.as_ref().and_then(|s| ctx.screen_names.get(s)).cloned())
    .or_else(|| screens.first().map(|s| s.1.clone()))
    .unwrap_or_else(|| "Home".into());
  let imports: String = screens
    .iter()
    .map(|(_, n)| format!("import {n} from \"./screens/{n}\";\n"))
    .collect();
  let map: String = screens.iter().map(|(_, n)| format!("  {n},\n")).collect();
  let phones: Vec<String> = screens
    .iter()
    .filter(|(id, _)| doc.get(id).map(|n| n.width < 600.0).unwrap_or(false))
    .map(|(_, n)| format!("{n:?}"))
    .collect();
  let widths: Vec<String> = screens
    .iter()
    .filter_map(|(id, n)| doc.get(id).map(|f| format!("{n}: {}", fmt(f.width))))
    .collect();
  let mut screen_aliases = BTreeMap::new();
  for (id, key) in &screens {
    // A name that is another screen's key stays that screen's.
    if let Some(f) = doc.get(id).filter(|f| &f.name != key && !screens.iter().any(|(_, k)| *k == f.name)) {
      screen_aliases.entry(f.name.clone()).or_insert_with(|| key.clone());
    }
  }
  files.push(ProjectFile {
    path: "src/App.tsx".into(),
    content: APP_TSX
      .replace("__IMPORTS__", &imports)
      .replace("__MAP__", &map)
      .replace("__WIDTHS__", &widths.join(", "))
      .replace("__PHONES__", &phones.join(", "))
      .replace(
        "__SCREEN_NAMES__",
        &serde_json::to_string(&screen_aliases).unwrap_or_else(|_| "{}".into()),
      )
      .replace("__KEYS__", &serde_json::to_string(&ctx.keys).unwrap_or_else(|_| "{}".into()))
      .replace("__DELAYS__", &serde_json::to_string(&ctx.delays).unwrap_or_else(|_| "{}".into()))
      .replace("__START__", &format!("{start:?}")),
  });
  let fonts = google_fonts_link(doc);
  files.push(ProjectFile {
    path: "src/index.css".into(),
    content: format!(
      "{}{}@tailwind base;\n@tailwind components;\n@tailwind utilities;\n{FOCUS_CSS}{}",
      if fonts.is_empty() {
        String::new()
      } else {
        format!("@import url(\"{fonts}\");\n")
      },
      if doc.variables.is_empty() {
        ""
      } else {
        "@import \"./tokens.css\";\n"
      },
      style_css(&ctx)
    ),
  });
  let themed = themed_collections(doc);
  if !themed.is_empty() {
    files.push(ProjectFile {
      path: "src/tokens.ts".into(),
      content: tokens_ts(&themed),
    });
  }
  if !doc.variables.is_empty() {
    files.push(ProjectFile {
      path: "src/tokens.css".into(),
      content: crate::variables::tokens_css(doc),
    });
  }
  files.push(ProjectFile {
    path: "src/main.tsx".into(),
    content: "import React from \"react\";\nimport ReactDOM from \"react-dom/client\";\nimport App from \"./App\";\nimport \"./index.css\";\n\nReactDOM.createRoot(document.getElementById(\"root\")!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n".into(),
  });
  let title = esc(&doc.name);
  let fit = viewport_fit(
    doc
      .nodes
      .values()
      .any(|n| n.parent.is_none() && n.device.as_ref().is_some_and(crate::devices::is_mobile)),
  );
  files.push(ProjectFile {
    path: "index.html".into(),
    content: format!("<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0{fit}\" />\n    <title>{title}</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n    <script type=\"module\" src=\"/src/main.tsx\"></script>\n  </body>\n</html>\n"),
  });
  let pkg = pascal(&doc.name, "app").to_lowercase();
  files.push(ProjectFile {
    path: "package.json".into(),
    content: format!(
      "{{\n  \"name\": \"{pkg}\",\n  \"private\": true,\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": {{\n    \"dev\": \"vite\",\n    \"build\": \"tsc -b && vite build\",\n    \"preview\": \"vite preview\"\n  }},\n  \"dependencies\": {{\n    \"react\": \"18.3.1\",\n    \"react-dom\": \"18.3.1\"\n  }},\n  \"devDependencies\": {{\n    \"@types/react\": \"18.3.12\",\n    \"@types/react-dom\": \"18.3.1\",\n    \"@vitejs/plugin-react\": \"4.3.3\",\n    \"autoprefixer\": \"10.4.20\",\n    \"postcss\": \"8.4.47\",\n    \"tailwindcss\": \"3.4.14\",\n    \"typescript\": \"5.6.3\",\n    \"vite\": \"5.4.10\"\n  }}\n}}\n"
    ),
  });
  files.push(ProjectFile {
    path: "vite.config.ts".into(),
    content: "import { defineConfig } from \"vite\";\nimport react from \"@vitejs/plugin-react\";\n\nexport default defineConfig({ plugins: [react()] });\n".into(),
  });
  files.push(ProjectFile {
    path: "tailwind.config.js".into(),
    content: "/** @type {import('tailwindcss').Config} */\nexport default {\n  content: [\"./index.html\", \"./src/**/*.{ts,tsx}\"],\n  theme: { extend: {} },\n  plugins: [],\n};\n".into(),
  });
  files.push(ProjectFile {
    path: "postcss.config.js".into(),
    content: "export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n".into(),
  });
  files.push(ProjectFile {
    path: "tsconfig.json".into(),
    content: "{\n  \"compilerOptions\": {\n    \"target\": \"ES2020\",\n    \"lib\": [\"ES2020\", \"DOM\", \"DOM.Iterable\"],\n    \"module\": \"ESNext\",\n    \"moduleResolution\": \"bundler\",\n    \"jsx\": \"react-jsx\",\n    \"strict\": true,\n    \"skipLibCheck\": true,\n    \"noEmit\": true\n  },\n  \"include\": [\"src\"]\n}\n".into(),
  });
  files.push(ProjectFile {
    path: "CLAUDE.md".into(),
    content: format!(
      "# {title}\n\nThis project was generated from a Designotron design. `design.dtron.json` is the design source.\n\n- Screens live in `src/screens/`, one per top-level frame. Reusable components are in `src/components.tsx`.\n- Layout is generated from auto layout (flexbox) and absolute positioning; refactor toward responsive layouts where it makes sense.\n- Prototype links became `onNavigate(\"Screen\")` calls handled in `src/App.tsx`; overlays (`\"overlay:Screen\"`, `\"swap-overlay:Screen\"`, `\"close-overlay\"`) open on top of the current screen, and Escape closes the topmost.\n- If the Designotron bridge is running, its MCP server (`designotron`) can read the live design: use `get_document`, `get_nodes` and `get_screenshot` to check details.\n"
    ),
  });
  let credits = credits_md(doc);
  files.push(ProjectFile {
    path: "README.md".into(),
    content: format!(
      "# {title}\n\nGenerated with [Designotron](https://github.com/mikemich/designotron).\n\n```bash\nnpm install\nnpm run dev\n```\n{}{}{}{}",
      readme_flows(doc, &ctx),
      readme_limits(doc),
      readme_themes(&themed),
      if credits.is_empty() {
        ""
      } else {
        "\n## Credits\n\nStock photos in this design are credited in `CREDITS.md`. Keep it with the project.\n"
      }
    ),
  });
  if !credits.is_empty() {
    files.push(ProjectFile {
      path: "CREDITS.md".into(),
      content: credits,
    });
  }
  files.push(ProjectFile {
    path: "design.dtron.json".into(),
    content: serde_json::to_string_pretty(doc).unwrap_or_default(),
  });
  files
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::model::{AutoLayout, Interaction};
  use crate::text::HeuristicMeasurer;

  fn sample() -> Document {
    let mut gen = IdGen::new(11);
    let mut doc = new_document(&mut gen, "Shop");
    let page = doc.pages[0].id.clone();
    let mut home = crate::ops::default_node(NodeType::Frame, "home".into(), "Home".into());
    home.width = 390.0;
    home.height = 844.0;
    home.layout = Some(AutoLayout {
      gap: 12.0,
      ..Default::default()
    });
    doc.insert(home, None, &page, None);
    let mut detail = crate::ops::default_node(NodeType::Frame, "detail".into(), "Product detail".into());
    detail.x = 500.0;
    doc.insert(detail, None, &page, None);
    let mut btn = crate::ops::default_node(NodeType::Rectangle, "btn".into(), "Buy".into());
    btn.fills = vec![Paint::solid("#7C5CFF")];
    btn.corner_radius = 12.0;
    btn.sizing_h = Sizing::Fill;
    btn.interactions.push(Interaction {
      destination: Some("detail".into()),
      ..Default::default()
    });
    doc.insert(btn, Some("home"), &page, None);
    let mut t = crate::ops::default_node(NodeType::Text, "t".into(), "Title".into());
    t.text.as_mut().unwrap().characters = "Hello \"world\"".into();
    doc.insert(t, Some("home"), &page, None);
    doc
  }

  #[test]
  fn react_has_flex_and_navigation() {
    let doc = sample();
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(src.contains("export default function Home"));
    assert!(src.contains("flex flex-col"));
    assert!(src.contains("gap-y-[12px]"));
    assert!(src.contains("bg-[#7C5CFF]"));
    assert!(src.contains("rounded-[12px]"));
    assert!(src.contains("flex-1") || src.contains("self-stretch"));
    assert!(src.contains("onNavigate?.(\"ProductDetail\")"));
    assert!(src.contains("{\"Hello \\\"world\\\"\"}"));
  }

  #[test]
  fn project_has_screens_and_app() {
    let doc = sample();
    let files = export_project(&doc, &HeuristicMeasurer);
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"src/screens/Home.tsx"));
    assert!(paths.contains(&"src/screens/ProductDetail.tsx"));
    assert!(paths.contains(&"package.json"));
    let app = &files.iter().find(|f| f.path == "src/App.tsx").unwrap().content;
    assert!(app.contains("hash : \"Home\";"));
    assert!(
      app.contains("const widths: Record<string, number> = { Home: 390, ProductDetail: 100 };"),
      "{app}"
    );
    assert!(!app.contains("__"), "unfilled placeholder: {app}");
  }

  #[test]
  fn project_start_skips_a_missing_flow_start() {
    let mut doc = sample();
    doc.pages[0].flow_start = Some("gone".into());
    let start = |doc: &Document| {
      let files = export_project(doc, &HeuristicMeasurer);
      files.iter().find(|f| f.path == "src/App.tsx").unwrap().content.clone()
    };
    assert!(start(&doc).contains("hash : \"Home\";"), "falls back to the first screen");
    // A later page's valid start wins over an earlier page's missing one.
    let mut other = doc.pages[0].clone();
    other.id = "p2".into();
    other.children.clear();
    other.flow_start = Some("detail".into());
    doc.pages.push(other);
    assert!(start(&doc).contains("hash : \"ProductDetail\";"));
  }

  #[test]
  fn overlays_become_navigate_calls_with_placement() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    let mut close = crate::ops::default_node(NodeType::Rectangle, "close".into(), "Close".into());
    close.interactions.push(Interaction {
      action: Action::CloseOverlay,
      ..Default::default()
    });
    doc.insert(close, Some("detail"), &page, None);
    let btn = doc.get_mut("btn").unwrap();
    btn.interactions[0].action = Action::OpenOverlay;
    btn.interactions[0].overlay.position = OverlayPosition::TopRight;
    let react = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(
      react.contains(
        r#"onNavigate?.("overlay:ProductDetail", {"background":"rgba(0, 0, 0, 0.3)","closeOnClickOutside":true,"position":"topRight"})"#
      ),
      "{react}"
    );
    assert!(export_react(&doc, "detail", &HeuristicMeasurer).contains(r#"onNavigate?.("close-overlay")"#));
    let files = export_project(&doc, &HeuristicMeasurer);
    let app = &files.iter().find(|f| f.path == "src/App.tsx").unwrap().content;
    assert!(app.contains("s.startsWith(\"overlay:\")") && app.contains("e.key === \"Escape\""));
    // Manual offsets from inside an overlay are shifted by that overlay's position.
    assert!(app.contains("getBoundingClientRect") && app.contains("data-overlay={i}"));
  }

  #[test]
  fn manual_overlay_is_placed_from_the_trigger() {
    let mut doc = sample();
    let btn = doc.get_mut("btn").unwrap();
    btn.x = 20.0;
    btn.y = 30.0;
    btn.interactions[0].action = Action::SwapOverlay;
    btn.interactions[0].overlay.position = OverlayPosition::Manual;
    btn.interactions[0].overlay.offset_y = 40.0;
    btn.interactions[0].overlay.background = None;
    let ctx = Ctx::new(&doc, &HeuristicMeasurer, false);
    let b = doc.get("btn").unwrap();
    let opts = ctx.overlay_opts(b, &b.interactions[0].overlay);
    assert_eq!(opts["position"], "manual");
    assert_eq!(opts["background"], serde_json::Value::Null);
    let at = doc.abs_bounds("btn");
    assert_eq!(
      (opts["x"].as_f64(), opts["y"].as_f64()),
      (Some(at.x.round()), Some((at.y + 40.0).round()))
    );
  }

  #[test]
  fn semantic_tags_and_responsive_root() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    let mut h = crate::ops::default_node(NodeType::Text, "h".into(), "Heading".into());
    h.text.as_mut().unwrap().characters = "Big title".into();
    h.text.as_mut().unwrap().font_size = 40.0;
    doc.insert(h, Some("home"), &page, None);
    let mut nav = crate::ops::default_node(NodeType::Frame, "nav".into(), "Nav bar".into());
    nav.layout = Some(AutoLayout::default());
    doc.insert(nav, Some("home"), &page, None);
    let mut img = crate::ops::default_node(NodeType::Rectangle, "img".into(), "Product photo".into());
    img.fills = vec![Paint::Image {
      credit: None,
      src: "https://example.com/p.png".into(),
      scale_mode: ScaleMode::Fill,
      opacity: 1.0,
      visible: true,
      crop: None,
    }];
    doc.insert(img, Some("home"), &page, None);
    let mut cta = crate::ops::default_node(NodeType::Frame, "cta".into(), "Primary button".into());
    cta.height = 44.0;
    doc.insert(cta, Some("home"), &page, None);
    let mut label = crate::ops::default_node(NodeType::Text, "lbl".into(), "Label".into());
    label.text.as_mut().unwrap().characters = "Buy".into();
    doc.insert(label, Some("cta"), &page, None);
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(src.contains("<h1 "), "{src}");
    assert!(src.contains("<nav "));
    assert!(src.contains("<img ") && src.contains("alt=\"Product photo\"") && src.contains("object-cover"));
    assert!(src.contains("<button ") && src.contains("type=\"button\""));
    assert!(src.contains("w-full max-w-[390px] min-h-[844px]"), "{src}");
    let html = export_html(&doc, "home", &HeuristicMeasurer);
    assert!(html.contains("<img style=") && html.contains("<button style=\"border: 0;"));
  }

  #[test]
  fn min_max_truncation_paragraphs_and_links_export() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    {
      let b = doc.get_mut("btn").unwrap();
      b.min_width = Some(120.0);
      b.max_width = Some(300.0);
      b.min_height = Some(40.0);
      b.max_height = Some(64.0);
    }
    let mut clamp = crate::ops::default_node(NodeType::Text, "clamp".into(), "Clamp".into());
    clamp.width = 200.0;
    {
      let t = clamp.text.as_mut().unwrap();
      t.characters = "A long description that goes on".into();
      t.auto_resize = TextAutoResize::Height;
      t.max_lines = Some(2);
    }
    doc.insert(clamp, Some("home"), &page, None);
    let mut one = crate::ops::default_node(NodeType::Text, "one".into(), "One".into());
    one.text.as_mut().unwrap().characters = "Single line title".into();
    one.text.as_mut().unwrap().max_lines = Some(1);
    doc.insert(one, Some("home"), &page, None);
    let mut paras = crate::ops::default_node(NodeType::Text, "paras".into(), "Paras".into());
    {
      let t = paras.text.as_mut().unwrap();
      t.characters = "First\n\nSecond".into();
      t.paragraph_spacing = 12.0;
    }
    doc.insert(paras, Some("home"), &page, None);
    let mut link = crate::ops::default_node(NodeType::Text, "link".into(), "Link".into());
    {
      let t = link.text.as_mut().unwrap();
      t.characters = "See docs or this".into();
      t.runs = vec![
        crate::model::TextRun {
          start: 4,
          end: 8,
          link: Some("https://example.com/docs".into()),
          ..Default::default()
        },
        crate::model::TextRun {
          start: 12,
          end: 16,
          link: Some("javascript:alert(1)".into()),
          ..Default::default()
        },
      ];
    }
    doc.insert(link, Some("home"), &page, None);
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    for class in [
      "min-w-[120px]",
      "max-w-[300px]",
      "min-h-[40px]",
      "max-h-[64px]",
      "line-clamp-2",
      "truncate",
      "mt-[12px]",
    ] {
      assert!(src.contains(class), "{class} in {src}");
    }
    assert!(!src.contains("javascript:"), "{src}");
    assert!(
      src.contains("<a href=\"https://example.com/docs\" target=\"_blank\" rel=\"noopener noreferrer\""),
      "{src}"
    );
    assert!(src.contains("underline"));
    // Paragraphs become blocks, so the gap survives in the page.
    assert!(src.contains("{\"First\"}") && src.contains("{\"Second\"}"));
    let html = export_html(&doc, "home", &HeuristicMeasurer);
    assert!(html.contains("-webkit-line-clamp: 2"), "{html}");
    assert!(html.contains("text-overflow: ellipsis"));
    assert!(html.contains("min-width: 120px") && html.contains("max-height: 64px"));
    assert!(html.contains("margin-top: 12px"));
    assert!(html.contains("<a href=\"https://example.com/docs\""));
  }

  #[test]
  fn text_strokes_become_webkit_text_stroke() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    let mut t = crate::ops::default_node(NodeType::Text, "st".into(), "S".into());
    t.text.as_mut().unwrap().characters = "Outlined".into();
    t.strokes = vec![Paint::solid("#ff0000")];
    t.stroke_weight = 2.0;
    t.stroke_align = StrokeAlign::Outside;
    doc.insert(t, Some("home"), &page, None);
    let html = export_html(&doc, "home", &HeuristicMeasurer);
    assert!(html.contains("-webkit-text-stroke: 4px #FF0000"), "{html}");
    assert!(html.contains("paint-order: stroke fill"), "{html}");
    doc.get_mut("st").unwrap().stroke_align = StrokeAlign::Center;
    let html = export_html(&doc, "home", &HeuristicMeasurer);
    assert!(
      html.contains("-webkit-text-stroke: 2px #FF0000") && !html.contains("paint-order"),
      "{html}"
    );
  }

  #[test]
  fn links_keep_a_range_decoration_and_wrapping_text_breaks_long_words() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    let mut t = crate::ops::default_node(NodeType::Text, "s".into(), "S".into());
    {
      let p = t.text.as_mut().unwrap();
      p.characters = "struck link here".into();
      p.decoration = crate::model::TextDecoration::Strikethrough;
      p.auto_resize = TextAutoResize::Height;
      p.max_lines = Some(1);
      p.runs = vec![crate::model::TextRun {
        start: 7,
        end: 11,
        link: Some("https://example.com".into()),
        ..Default::default()
      }];
    }
    t.max_width = Some(240.0);
    doc.insert(t, Some("home"), &page, None);
    let html = export_html(&doc, "home", &HeuristicMeasurer);
    let a = html.split("<a href").nth(1).unwrap().split('>').next().unwrap();
    assert!(!a.contains("underline"), "a link on struck text keeps the strike: {a}");
    // A link whose range sets decoration none stays plain; one that sets nothing on plain text
    // underlines itself.
    let mut doc2 = sample();
    let page2 = doc2.pages[0].id.clone();
    let mut l = crate::ops::default_node(NodeType::Text, "l".into(), "L".into());
    {
      let p = l.text.as_mut().unwrap();
      p.characters = "plain none link".into();
      p.runs = vec![
        crate::model::TextRun {
          start: 6,
          end: 10,
          decoration: Some(TextDecoration::None),
          link: Some("https://example.com/a".into()),
          ..Default::default()
        },
        crate::model::TextRun {
          start: 11,
          end: 15,
          link: Some("https://example.com/b".into()),
          ..Default::default()
        },
      ];
    }
    doc2.insert(l, Some("home"), &page2, None);
    let html2 = export_html(&doc2, "home", &HeuristicMeasurer);
    let tag = |h: &str, url: &str| {
      h.split(&format!("<a href=\"{url}\""))
        .nth(1)
        .unwrap()
        .split('>')
        .next()
        .unwrap()
        .to_string()
    };
    assert!(tag(&html2, "https://example.com/a").contains("text-decoration: none"), "{html2}");
    assert!(
      tag(&html2, "https://example.com/b").contains("text-decoration: underline"),
      "{html2}"
    );
    // One line with a max width keeps its ellipsis rules.
    assert!(
      html.contains("white-space: nowrap") && html.contains("text-overflow: ellipsis"),
      "{html}"
    );
    // Wrapping text breaks long words.
    let mut w = crate::ops::default_node(NodeType::Text, "w".into(), "W".into());
    w.text.as_mut().unwrap().characters = "Pneumonoultramicroscopicsilicovolcanoconiosis".into();
    w.text.as_mut().unwrap().auto_resize = TextAutoResize::Height;
    doc.insert(w, Some("home"), &page, None);
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(src.contains("[overflow-wrap:anywhere]"), "{src}");
  }

  #[test]
  fn baseline_alignment_exports_align_items_baseline() {
    let mut doc = sample();
    {
      let home = doc.get_mut("home").unwrap();
      let al = home.layout.as_mut().unwrap();
      al.direction = crate::model::LayoutDirection::Horizontal;
      al.counter_align = crate::model::Align::Baseline;
    }
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(src.contains("[align-items:baseline]"), "{src}");
  }

  #[test]
  fn html_inline_styles() {
    let doc = sample();
    let h = export_html(&doc, "home", &HeuristicMeasurer);
    assert!(h.contains("display: flex"));
    assert!(h.contains("Hello &quot;world&quot;"));
  }

  #[test]
  fn angular_diamond_and_handle_gradients_become_css() {
    use crate::model::{GradientHandles, GradientStop};
    let stops = vec![
      GradientStop {
        color: "#FF0000".into(),
        position: 0.0,
      },
      GradientStop {
        color: "#0000FF".into(),
        position: 1.0,
      },
    ];
    let mut doc = sample();
    let mut a = crate::ops::default_node(NodeType::Rectangle, "ang".into(), "Ang".into());
    a.fills = vec![Paint::AngularGradient {
      stops: stops.clone(),
      opacity: 1.0,
      visible: true,
      handles: Some(GradientHandles {
        start: [0.25, 0.5],
        end: [1.0, 0.5],
        width: [0.25, 1.0],
      }),
    }];
    let page = doc.get("home").unwrap().page.clone();
    doc.insert(a, Some("home"), &page, None);
    let mut d = crate::ops::default_node(NodeType::Rectangle, "dia".into(), "Dia".into());
    d.fills = vec![Paint::DiamondGradient {
      stops,
      opacity: 1.0,
      visible: true,
      handles: None,
    }];
    doc.insert(d, Some("home"), &page, None);
    let react = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(react.contains("conic-gradient(from_90deg_at_25%_50%"), "{react}");
    assert!(react.contains("radial-gradient(50%_50%_at_50%_50%"), "{react}");
    assert!(react.contains("diamond gradient approximated"), "{react}");
    let html = export_html(&doc, "home", &HeuristicMeasurer);
    assert!(
      html.contains("conic-gradient(from 90deg at 25% 50%") && html.contains("/* diamond gradient approximated */"),
      "{html}"
    );
  }

  #[test]
  fn individual_strokes_become_per_side_borders() {
    let mut doc = sample();
    let page = doc.get("home").unwrap().page.clone();
    let mut r = crate::ops::default_node(NodeType::Rectangle, "bx".into(), "Box".into());
    r.strokes = vec![Paint::solid("#112233")];
    r.stroke_weights = Some([2.0, 0.0, 0.0, 0.0]);
    doc.insert(r, Some("home"), &page, None);
    let react = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(
      react.contains("border-t-[2px]") && react.contains("border-r-0") && react.contains("border-solid"),
      "{react}"
    );
    // Outside strokes are offset shadows instead of borders.
    doc.get_mut("bx").unwrap().stroke_align = StrokeAlign::Outside;
    let html = export_html(&doc, "home", &HeuristicMeasurer);
    assert!(html.contains("box-shadow: 0 -2px 0 0 #112233"), "{html}");
  }

  #[test]
  fn cropped_images_offset_their_background() {
    use crate::model::ImageCrop;
    let mut doc = sample();
    let page = doc.get("home").unwrap().page.clone();
    let mut r = crate::ops::default_node(NodeType::Rectangle, "pic".into(), "Pic".into());
    r.width = 200.0;
    r.height = 100.0;
    r.fills = vec![Paint::Image {
      credit: None,
      src: "https://example.com/c.png".into(),
      scale_mode: ScaleMode::Crop,
      opacity: 1.0,
      visible: true,
      crop: Some(ImageCrop {
        x: -0.5,
        y: 0.0,
        w: 2.0,
        h: 1.0,
      }),
    }];
    doc.insert(r, Some("home"), &page, None);
    let html = export_html(&doc, "home", &HeuristicMeasurer);
    assert!(
      html.contains("background-size: 400px 100px") && html.contains("background-position: -100px 0"),
      "{html}"
    );
  }

  #[test]
  fn class_names_never_contain_double_quotes() {
    use crate::model::ImageCrop;
    let mut doc = sample();
    let page = doc.get("home").unwrap().page.clone();
    let mut r = crate::ops::default_node(NodeType::Rectangle, "pic2".into(), "Pic2".into());
    r.fills = vec![Paint::Image {
      credit: None,
      src: "https://example.com/it's \"q\".png".into(),
      scale_mode: ScaleMode::Crop,
      opacity: 1.0,
      visible: true,
      crop: Some(ImageCrop {
        x: 0.0,
        y: 0.0,
        w: 1.5,
        h: 1.5,
      }),
    }];
    // A second fill so the background shorthand with url() lands in the class list too.
    r.fills.push(Paint::solid("#112233"));
    doc.insert(r, Some("home"), &page, None);
    let react = export_react(&doc, "home", &HeuristicMeasurer);
    let line = react.lines().find(|l| l.contains("url(")).expect("a url() class");
    let class = line.split("className=\"").nth(1).expect("className");
    let class = class.split('"').next().unwrap();
    assert!(class.contains("url('") && class.contains("%27") && class.contains("%22"), "{line}");
    assert!(line.matches('"').count() == 2, "className must hold no double quote: {line}");
  }

  #[test]
  fn handle_extent_rescales_css_linear_stops() {
    use crate::model::{GradientHandles, GradientStop};
    let p = Paint::LinearGradient {
      stops: vec![
        GradientStop {
          color: "#000000".into(),
          position: 0.0,
        },
        GradientStop {
          color: "#FFFFFF".into(),
          position: 1.0,
        },
      ],
      angle: 90.0,
      opacity: 1.0,
      visible: true,
      handles: Some(GradientHandles {
        start: [0.25, 0.5],
        end: [0.75, 0.5],
        width: [0.25, 1.0],
      }),
    };
    let css = css_paint(&p, 200.0, 100.0);
    assert!(css.starts_with("linear-gradient(90deg"), "{css}");
    assert!(css.contains("25%") && css.contains("75%"), "{css}");
  }

  // ---------- W3-F: component library, naming, valid HTML, themes, style classes ----------

  /// A frame with a text child, made into a main component named `name`.
  fn make_component(doc: &mut Document, gen: &mut IdGen, id: &str, name: &str, label: &str) -> NodeId {
    let page = doc.pages[0].id.clone();
    let mut f = crate::ops::default_node(NodeType::Frame, id.into(), name.into());
    f.x = 900.0;
    f.layout = Some(AutoLayout::default());
    doc.insert(f, None, &page, None);
    let mut t = crate::ops::default_node(NodeType::Text, format!("{id}_t"), "Label".into());
    t.text.as_mut().unwrap().characters = label.into();
    doc.insert(t, Some(id), &page, None);
    crate::components::create_component(doc, &[id.to_string()], gen).unwrap()
  }

  fn tag_stack_ok(src: &str) -> Result<(), String> {
    // Interactive tags may not nest (JSX or HTML).
    let mut stack: Vec<String> = Vec::new();
    let mut i = 0;
    while let Some(off) = src[i..].find('<') {
      i += off + 1;
      let rest = &src[i..];
      let closing = rest.starts_with('/');
      let name: String = rest
        .trim_start_matches('/')
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
      let end = rest.find('>').unwrap_or(rest.len());
      let self_closing = rest[..end].ends_with('/');
      if name.is_empty() || self_closing {
        continue;
      }
      if closing {
        if let Some(p) = stack.iter().rposition(|t| *t == name) {
          stack.truncate(p);
        }
      } else {
        if (name == "button" || name == "a") && stack.iter().any(|t| t == "button" || t == "a") {
          return Err(format!("<{name}> inside {stack:?}"));
        }
        stack.push(name);
      }
    }
    Ok(())
  }

  #[test]
  fn component_library_exports_unused_components_with_descriptions() {
    let mut doc = sample();
    let mut gen = IdGen::new(500);
    let c = make_component(&mut doc, &mut gen, "card", "Card", "Hi");
    doc.get_mut(&c).unwrap().component.as_mut().unwrap().description = "A card. Ends with */ oops".into();
    let files = export_project(&doc, &HeuristicMeasurer);
    let comps = &files.iter().find(|f| f.path == "src/components.tsx").unwrap().content;
    assert!(comps.contains("export function Card("), "{comps}");
    assert!(comps.contains("/** A card. Ends with * / oops */\nexport function Card"), "{comps}");
    // The Code tab for a single screen only has what the screen uses.
    let one = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(!one.contains("function Card"), "{one}");
  }

  #[test]
  fn unused_variant_sets_are_exported_whole() {
    let mut doc = sample();
    let mut gen = IdGen::new(600);
    let a = make_component(&mut doc, &mut gen, "ba", "Button/Primary", "Go");
    let b = make_component(&mut doc, &mut gen, "bb", "Button/Secondary", "Go");
    crate::components::combine_as_variants(&mut doc, &[a, b], &mut gen).unwrap();
    let files = export_project(&doc, &HeuristicMeasurer);
    let comps = &files.iter().find(|f| f.path == "src/components.tsx").unwrap().content;
    assert!(comps.contains("function ButtonPrimary("), "{comps}");
    assert!(comps.contains("function ButtonSecondary("), "{comps}");
    assert!(comps.contains("export function Button("), "{comps}");
  }

  #[test]
  fn variant_instance_function_is_named_after_set_and_value() {
    let mut doc = sample();
    let mut gen = IdGen::new(700);
    let a = make_component(&mut doc, &mut gen, "ba", "Button/Primary", "Go");
    let b = make_component(&mut doc, &mut gen, "bb", "Button/Secondary", "Go");
    crate::components::combine_as_variants(&mut doc, &[a, b.clone()], &mut gen).unwrap();
    let page = doc.pages[0].id.clone();
    crate::components::create_instance(&mut doc, &b, Some("home"), &page, 0.0, 0.0, &mut gen).unwrap();
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(src.contains("function ButtonSecondary("), "{src}");
    assert!(!src.contains("Property1"), "{src}");
  }

  #[test]
  fn component_property_named_style_is_suffixed() {
    let mut doc = sample();
    let mut gen = IdGen::new(800);
    let c = make_component(&mut doc, &mut gen, "card", "Card", "Hi");
    let t = "card_t".to_string();
    let r = crate::props::apply_op(
      &mut doc,
      &mut gen,
      crate::props::PropsOp::Add {
        component: c.clone(),
        name: "style".into(),
        kind: PropKind::Text,
        default: Some(json!("Hi")),
        bind: Some(t),
      },
    );
    assert!(r.is_ok(), "{r:?}");
    let files = export_project(&doc, &HeuristicMeasurer);
    let comps = &files.iter().find(|f| f.path == "src/components.tsx").unwrap().content;
    assert!(comps.contains("styleProp"), "{comps}");
    assert!(!comps.contains("{ style,") && !comps.contains(" style = "), "{comps}");
  }

  #[test]
  fn nested_interactive_elements_are_downgraded() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    let mut b = crate::ops::default_node(NodeType::Frame, "cta".into(), "Buy button".into());
    b.height = 44.0;
    b.interactions.push(Interaction {
      destination: Some("detail".into()),
      ..Default::default()
    });
    doc.insert(b, Some("home"), &page, None);
    let mut inner = crate::ops::default_node(NodeType::Frame, "inner".into(), "Inner button".into());
    inner.height = 30.0;
    inner.interactions.push(Interaction {
      destination: Some("detail".into()),
      ..Default::default()
    });
    doc.insert(inner, Some("cta"), &page, None);
    let mut t = crate::ops::default_node(NodeType::Text, "lbl".into(), "Label".into());
    t.text.as_mut().unwrap().characters = "Buy".into();
    t.text.as_mut().unwrap().font_size = 40.0;
    doc.insert(t, Some("inner"), &page, None);
    let mut link = crate::ops::default_node(NodeType::Text, "lnk".into(), "Link".into());
    link.text.as_mut().unwrap().characters = "Terms".into();
    link.text.as_mut().unwrap().runs = vec![crate::model::TextRun {
      start: 0,
      end: 5,
      link: Some("https://example.com".into()),
      ..Default::default()
    }];
    doc.insert(link, Some("cta"), &page, None);
    for src in [
      export_react(&doc, "home", &HeuristicMeasurer),
      export_html(&doc, "home", &HeuristicMeasurer),
    ] {
      assert!(tag_stack_ok(&src).is_ok(), "{:?}\n{src}", tag_stack_ok(&src));
      assert!(src.contains("<button "), "{src}");
      // Text in a button is a span, never a heading or paragraph.
      assert!(!src.contains("<h1") && !src.contains("<h2"), "{src}");
      assert!(!src.contains("<p ") || !src.contains("Buy</p>"), "{src}");
    }
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert_eq!(src.matches("<button ").count(), 1, "{src}");
    assert_eq!(
      src.matches("onClick=").count(),
      3,
      "the sample button, the outer button and the inner one: {src}"
    );
    // The downgraded inner button keeps its action but stops the click, so only it runs.
    assert!(src.contains("(e) => { e.stopPropagation(); onNavigate?.("), "{src}");
    // A big heading inside a button doesn't use up the screen's h1.
    let mut doc2 = doc.clone();
    let page = doc2.pages[0].id.clone();
    let mut h = crate::ops::default_node(NodeType::Text, "hh".into(), "Heading".into());
    h.text.as_mut().unwrap().characters = "Title".into();
    h.text.as_mut().unwrap().font_size = 40.0;
    doc2.insert(h, Some("home"), &page, None);
    assert!(export_react(&doc2, "home", &HeuristicMeasurer).contains("<h1 "));
  }

  #[test]
  fn instances_inside_buttons_are_written_inline() {
    let mut doc = sample();
    let mut gen = IdGen::new(900);
    let c = make_component(&mut doc, &mut gen, "pay", "Pay button", "Pay");
    doc.get_mut(&c).unwrap().height = 40.0;
    let page = doc.pages[0].id.clone();
    let mut row = crate::ops::default_node(NodeType::Frame, "row".into(), "Row button".into());
    row.height = 60.0;
    row.interactions.push(Interaction {
      destination: Some("detail".into()),
      ..Default::default()
    });
    doc.insert(row, Some("home"), &page, None);
    let inst = crate::components::create_instance(&mut doc, &c, Some("row"), &page, 0.0, 0.0, &mut gen).unwrap();
    doc.get_mut(&inst).unwrap().interactions.push(Interaction {
      destination: Some("detail".into()),
      ..Default::default()
    });
    // Outside a button the instance is still a component.
    let loose = crate::components::create_instance(&mut doc, &c, Some("home"), &page, 0.0, 0.0, &mut gen).unwrap();
    let _ = loose;
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(tag_stack_ok(&src).is_ok(), "{:?}\n{src}", tag_stack_ok(&src));
    assert!(src.contains("<PayButton "), "{src}");
    assert!(src.contains("e.stopPropagation()"), "{src}");
    let files = export_project(&doc, &HeuristicMeasurer);
    for f in files.iter().filter(|f| f.path.ends_with(".tsx")) {
      assert!(tag_stack_ok(&f.content).is_ok(), "{}: {:?}", f.path, tag_stack_ok(&f.content));
    }
  }

  #[test]
  fn swap_slots_and_plain_icons_inside_buttons_stay_components() {
    let mut doc = sample();
    let mut gen = IdGen::new(1000);
    let star = make_component(&mut doc, &mut gen, "star", "Star", "*");
    let pay = make_component(&mut doc, &mut gen, "pay", "Pay button", "Pay");
    doc.get_mut(&pay).unwrap().height = 40.0;
    let page = doc.pages[0].id.clone();
    let slot = crate::components::create_instance(&mut doc, &star, Some(&pay), &page, 0.0, 0.0, &mut gen).unwrap();
    let added = crate::props::apply_op(
      &mut doc,
      &mut gen,
      crate::props::PropsOp::Add {
        component: pay.clone(),
        name: "icon".into(),
        kind: PropKind::InstanceSwap,
        default: None,
        bind: Some(slot),
      },
    );
    assert!(added.is_ok(), "{added:?}");
    // A clickable row with a plain icon instance: the icon stays `<Star />`, not inlined.
    let mut row = crate::ops::default_node(NodeType::Frame, "row".into(), "Row button".into());
    row.height = 60.0;
    row.interactions.push(Interaction {
      destination: Some("detail".into()),
      ..Default::default()
    });
    doc.insert(row, Some("home"), &page, None);
    crate::components::create_instance(&mut doc, &star, Some("row"), &page, 0.0, 0.0, &mut gen).unwrap();
    let files = export_project(&doc, &HeuristicMeasurer);
    let comps = &files.iter().find(|f| f.path == "src/components.tsx").unwrap().content;
    assert!(comps.contains("icon ?? <Star"), "{comps}");
    let home = &files.iter().find(|f| f.path == "src/screens/Home.tsx").unwrap().content;
    assert!(home.contains("<Star "), "{home}");
    for f in files.iter().filter(|f| f.path.ends_with(".tsx")) {
      assert!(tag_stack_ok(&f.content).is_ok(), "{}: {:?}", f.path, tag_stack_ok(&f.content));
    }
  }

  #[test]
  fn collections_with_the_same_slug_get_their_own_attribute() {
    use crate::variables::{Collection, VarMode};
    let mut doc = sample();
    let col = |id: &str, name: &str, modes: &[&str]| Collection {
      id: id.into(),
      name: name.into(),
      modes: modes
        .iter()
        .map(|m| VarMode {
          id: format!("{id}{m}"),
          name: (*m).into(),
        })
        .collect(),
      variables: vec![],
    };
    doc.variables = vec![
      col("a", "Theme", &["Light", "Dark"]),
      col("b", "theme!", &["Light", "Sepia"]),
      col("c", "主题", &["亮", "暗"]),
      col("d", "颜色", &["亮", "暗"]),
    ];
    let files = export_project(&doc, &HeuristicMeasurer);
    let ts = &files.iter().find(|f| f.path == "src/tokens.ts").unwrap().content;
    assert!(ts.contains("\"theme\": [\"light\", \"dark\"]"), "{ts}");
    assert!(ts.contains("\"theme-2\": [\"light\", \"sepia\"]"), "{ts}");
    assert!(ts.contains("\"collection\": [\"mode-1\", \"mode-2\"]"), "{ts}");
    assert!(ts.contains("\"collection-2\": [\"mode-1\", \"mode-2\"]"), "{ts}");
    let css = &files.iter().find(|f| f.path == "src/tokens.css").unwrap().content;
    assert!(
      css.contains("[data-theme-2=\"sepia\"]") && css.contains("[data-theme=\"dark\"]"),
      "{css}"
    );
    // One frame that sets both collections: two distinct attributes, so each switches on its own.
    let page = doc.pages[0].id.clone();
    let mut f = crate::ops::default_node(NodeType::Frame, "both".into(), "Both".into());
    f.variable_modes.insert("a".into(), "aDark".into());
    f.variable_modes.insert("b".into(), "bSepia".into());
    doc.insert(f, None, &page, None);
    let src = export_react(&doc, "both", &HeuristicMeasurer);
    assert!(
      src.contains("data-theme=\"dark\"") && src.contains("data-theme-2=\"sepia\""),
      "{src}"
    );
  }

  #[test]
  fn style_names_are_unique_and_never_take_a_variables_property() {
    use crate::variables::{Collection, VarKind, VarMode, Variable};
    let mut doc = sample();
    doc.variables.push(Collection {
      id: "c".into(),
      name: "Color".into(),
      modes: vec![VarMode {
        id: "m".into(),
        name: "Default".into(),
      }],
      variables: vec![Variable {
        id: "v".into(),
        name: "Color/Primary".into(),
        kind: VarKind::Color,
        values: BTreeMap::from([("m".into(), json!("#FF0000"))]),
        description: String::new(),
        scopes: Vec::new(),
      }],
    });
    let color = |id: &str, name: &str, c: &str| crate::model::ColorStyle {
      id: id.into(),
      name: name.into(),
      color: c.into(),
    };
    doc.styles.colors = vec![
      color("c1", "Brand/Primary", "#111111"),
      color("c2", "Brand Primary", "#222222"),
      color("c3", "主色", "#333333"),
      color("c4", "副色", "#444444"),
      color("c5", "Primary", "#555555"),
      color("c6", "Color Primary", "#666666"),
    ];
    let text = |id: &str, name: &str, size: f64| crate::model::TextStyle {
      id: id.into(),
      name: name.into(),
      font_family: "Inter".into(),
      font_size: size,
      font_weight: 400,
      line_height: None,
      letter_spacing: 0.0,
    };
    doc.styles.texts = vec![
      text("t1", "Heading 1", 20.0),
      text("t2", "Heading-1", 30.0),
      text("t3", "标题", 40.0),
      text("t4", "正文", 50.0),
    ];
    let n = style_names(&doc);
    let all: BTreeSet<&String> = n.colors.values().chain(n.texts.values()).collect();
    assert_eq!(all.len(), 10, "{:?} {:?}", n.colors, n.texts);
    assert_eq!(n.colors["c1"], "--color-brand-primary");
    assert_eq!(n.colors["c2"], "--color-brand-primary-2");
    assert_eq!(n.colors["c3"], "--color-style-3");
    assert_eq!(n.colors["c4"], "--color-style-4");
    // "--color-primary" is the variable "Color/Primary": the style steps aside.
    assert_eq!(n.colors["c6"], "--color-color-primary");
    assert_ne!(n.colors["c5"], "--color-primary");
    assert_eq!(n.texts["t1"], "text-heading-1");
    assert_eq!(n.texts["t2"], "text-heading-1-2");
    assert_eq!(n.texts["t3"], "text-style-3");
    // Two layers with styles of the same slug each get their own class and values.
    {
      let t = doc.get_mut("t").unwrap();
      t.text_style = Some("t2".into());
      t.text.as_mut().unwrap().font_size = 30.0;
    }
    let files = export_project(&doc, &HeuristicMeasurer);
    let css = &files.iter().find(|f| f.path == "src/index.css").unwrap().content;
    assert!(css.contains(".text-heading-1-2 {") && css.contains("30px"), "{css}");
    let inspect = inspect_names(&doc);
    assert_eq!(inspect["colorStyles"]["c4"], "--color-style-4");
    assert_eq!(inspect["variables"]["v"], "--color-primary");
  }

  #[test]
  fn colour_style_on_a_see_through_fill_keeps_its_opacity() {
    let mut doc = sample();
    doc.styles.colors.push(crate::model::ColorStyle {
      id: "cs".into(),
      name: "Brand".into(),
      color: "#7C5CFF".into(),
    });
    let b = doc.get_mut("btn").unwrap();
    b.fill_style = Some("cs".into());
    b.fills = vec![Paint::Solid {
      color: "#7C5CFF".into(),
      opacity: 0.4,
      visible: true,
    }];
    let files = export_project(&doc, &HeuristicMeasurer);
    let home = &files.iter().find(|f| f.path == "src/screens/Home.tsx").unwrap().content;
    assert!(!home.contains("var(--color-brand)"), "{home}");
    assert!(home.contains("rgba(124,92,255,0.4)") || home.contains("0.4"), "{home}");
  }

  #[test]
  fn font_families_with_quotes_are_escaped() {
    let mut doc = sample();
    doc.get_mut("t").unwrap().text.as_mut().unwrap().font_family = "Gill's \"Sans\"".into();
    doc.styles.texts.push(crate::model::TextStyle {
      id: "ts".into(),
      name: "Body".into(),
      font_family: "Gill's \"Sans\"".into(),
      font_size: 16.0,
      font_weight: 400,
      line_height: None,
      letter_spacing: 0.0,
    });
    doc.get_mut("t").unwrap().text_style = Some("ts".into());
    let files = export_project(&doc, &HeuristicMeasurer);
    let css = &files.iter().find(|f| f.path == "src/index.css").unwrap().content;
    assert!(css.contains("'Gill\\'s \"Sans\"'"), "{css}");
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    let class_attrs: Vec<&str> = src.lines().filter(|l| l.contains("className=")).collect();
    for l in class_attrs {
      let inner = l.split("className=\"").nth(1).unwrap_or("");
      let inner = &inner[..inner.find('"').unwrap_or(inner.len())];
      assert!(!inner.contains('\\'), "{l}");
    }
  }

  #[test]
  fn stock_photo_credits_reach_alt_html_and_credits_md() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    let credit = ImageCredit {
      provider: "openverse".into(),
      photo_id: "openverse:abc".into(),
      title: "Sneakers".into(),
      alt: "White sneakers on concrete".into(),
      author: "Ann --x".into(),
      source: "Flickr\r\nvia".into(),
      author_url: "https://example.com/ann".into(),
      license: "CC BY 2.0".into(),
      attribution_required: true,
      ..Default::default()
    };
    let mut img = crate::ops::default_node(NodeType::Rectangle, "pic".into(), "Product photo".into());
    img.fills = vec![Paint::Image {
      credit: Some(Box::new(credit)),
      src: "asset:abc".into(),
      scale_mode: ScaleMode::Fill,
      opacity: 1.0,
      visible: true,
      crop: None,
    }];
    doc.insert(img, Some("home"), &page, None);
    let react = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(react.contains("alt=\"White sneakers on concrete\""), "{react}");
    let html = export_html(&doc, "home", &HeuristicMeasurer);
    assert!(
      html.contains("<!-- Photo credits:") && html.contains("\"Sneakers\" by Ann --x (Flickr via)"),
      "{html}"
    );
    assert_eq!(html.matches("-->").count(), 1, "{html}");
    let files = export_project(&doc, &HeuristicMeasurer);
    let md = &files.iter().find(|f| f.path == "CREDITS.md").unwrap().content;
    assert!(
      md.contains("CC BY 2.0") && md.contains("(attribution required)") && md.contains("https://example.com/ann"),
      "{md}"
    );
    // Hostile provider text can't close the comment, open a tag or add Markdown.
    let hostile = [
      "x--->",
      "x---!>",
      "x-->",
      "<script>alert(1)</script>",
      "![](https://t.example/x) [Download](https://evil.example)",
    ];
    for (i, title) in hostile.iter().enumerate() {
      let mut bad = doc.clone();
      let mut n = bad.get("pic").unwrap().clone();
      if let Paint::Image { credit: Some(c), .. } = &mut n.fills[0] {
        c.title = title.to_string();
        c.author = "a\r\nb* _".into();
        c.source_url = format!("https://example.com/a b)\n- [x](https://evil{i})");
        c.license_url = "https://creativecommons.org/licenses/by/2.0/".into();
      }
      bad.nodes.insert("pic".into(), n);
      let html = export_html(&bad, "home", &HeuristicMeasurer);
      assert_eq!(html.matches("-->").count(), 1, "{title}: {html}");
      assert!(!html.contains("--!>") && !html.contains("<script>alert"), "{html}");
      let md = export_project(&bad, &HeuristicMeasurer)
        .into_iter()
        .find(|f| f.path == "CREDITS.md")
        .unwrap()
        .content;
      assert!(!md.contains("![") && !md.contains("](") && !md.contains("<script"), "{md}");
      assert!(!md.contains(&format!("evil{i}")) && !md.contains("Photo:"), "{md}");
      assert!(
        !md.contains('\r') && md.lines().filter(|l| l.starts_with("- ")).count() == 1,
        "{md}"
      );
      assert!(md.contains("<https://creativecommons.org/licenses/by/2.0/>"), "{md}");
    }
    // No photos, no file and no comment.
    let plain = sample();
    assert!(export_project(&plain, &HeuristicMeasurer).iter().all(|f| f.path != "CREDITS.md"));
    assert!(!export_html(&plain, "home", &HeuristicMeasurer).contains("Photo credits"));
  }

  #[test]
  fn image_filled_frame_keeps_its_class_attribute_valid() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    let mut f = crate::ops::default_node(NodeType::Frame, "ph".into(), "Photo".into());
    f.fills = vec![Paint::Image {
      credit: None,
      src: "asset:abc".into(),
      scale_mode: ScaleMode::Fill,
      opacity: 1.0,
      visible: true,
      crop: None,
    }];
    doc.insert(f, Some("home"), &page, None);
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(src.contains("[background:url('asset:abc')]"), "{src}");
    assert!(!src.contains("url(\""), "{src}");
  }

  #[test]
  fn reserved_variant_property_names_get_a_prop_suffix() {
    assert_eq!(prop_ident("Style"), "styleProp");
    assert_eq!(prop_ident("Class Name"), "classNameProp");
    assert_eq!(prop_ident("Size"), "size");
    assert_eq!(prop_ident("Property 1"), "property1");
  }

  #[test]
  fn two_mode_collection_exports_set_mode() {
    use crate::variables::{Collection, VarKind, VarMode, Variable};
    let mut doc = sample();
    doc.variables.push(Collection {
      id: "c1".into(),
      name: "Theme".into(),
      modes: vec![
        VarMode {
          id: "m1".into(),
          name: "Light".into(),
        },
        VarMode {
          id: "m2".into(),
          name: "Dark".into(),
        },
      ],
      variables: vec![Variable {
        id: "v1".into(),
        name: "Brand/bg".into(),
        kind: VarKind::Color,
        values: BTreeMap::from([("m1".into(), json!("#FFFFFF")), ("m2".into(), json!("#111111"))]),
        description: String::new(),
        scopes: Vec::new(),
      }],
    });
    let files = export_project(&doc, &HeuristicMeasurer);
    let get = |p: &str| files.iter().find(|f| f.path == p).map(|f| f.content.clone());
    let ts = get("src/tokens.ts").expect("tokens.ts");
    assert!(
      ts.contains("export function setMode") && ts.contains("\"theme\": [\"light\", \"dark\"]"),
      "{ts}"
    );
    let css = get("src/tokens.css").unwrap();
    assert!(
      css.contains("[data-theme=\"light\"]") && css.contains("[data-theme=\"dark\"]"),
      "{css}"
    );
    assert!(get("README.md").unwrap().contains("setMode(\"theme\", \"dark\")"));
    // One mode: no helper.
    doc.variables[0].modes.pop();
    let files = export_project(&doc, &HeuristicMeasurer);
    assert!(!files.iter().any(|f| f.path == "src/tokens.ts"));
  }

  #[test]
  fn linked_text_and_colour_styles_become_classes() {
    let mut doc = sample();
    doc.styles.texts.push(crate::model::TextStyle {
      id: "ts1".into(),
      name: "Heading 1".into(),
      font_family: "Inter".into(),
      font_size: 40.0,
      font_weight: 700,
      line_height: Some(48.0),
      letter_spacing: -0.5,
    });
    doc.styles.colors.push(crate::model::ColorStyle {
      id: "cs1".into(),
      name: "Brand/Primary".into(),
      color: "#7C5CFF".into(),
    });
    {
      let t = doc.get_mut("t").unwrap();
      let tp = t.text.as_mut().unwrap();
      tp.font_size = 40.0;
      tp.font_weight = 700;
      tp.line_height = Some(48.0);
      tp.letter_spacing = -0.5;
      t.text_style = Some("ts1".into());
      t.fills = vec![Paint::solid("#7C5CFF")];
      t.fill_style = Some("cs1".into());
    }
    doc.get_mut("btn").unwrap().fill_style = Some("cs1".into());
    let files = export_project(&doc, &HeuristicMeasurer);
    let get = |p: &str| files.iter().find(|f| f.path == p).unwrap().content.clone();
    let home = get("src/screens/Home.tsx");
    assert!(home.contains("text-heading-1"), "{home}");
    assert!(!home.contains("text-[length:40px]") && !home.contains("tracking-"), "{home}");
    assert!(home.contains("text-[color:var(--color-brand-primary)]"), "{home}");
    assert!(home.contains("bg-[color:var(--color-brand-primary)]"), "{home}");
    let css = get("src/index.css");
    assert!(css.contains(".text-heading-1 {") && css.contains("font: 700 40px/48px"), "{css}");
    assert!(
      css.contains("letter-spacing: -0.5px") && css.contains("--color-brand-primary: #7C5CFF;"),
      "{css}"
    );
    // A layer that drifted from its style keeps its own values.
    doc.get_mut("t").unwrap().text.as_mut().unwrap().font_size = 22.0;
    let files = export_project(&doc, &HeuristicMeasurer);
    let home = files.iter().find(|f| f.path == "src/screens/Home.tsx").unwrap().content.clone();
    assert!(!home.contains("text-heading-1") && home.contains("text-[length:22px]"), "{home}");
    // The single-layer code has no stylesheet to point at, so it keeps utilities.
    assert!(!export_react(&doc, "home", &HeuristicMeasurer).contains("text-heading-1"));
  }
}

#[cfg(test)]
mod w3a_tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::text::HeuristicMeasurer;

  fn page_with(overflow: crate::model::Overflow, fixed_nav: bool) -> Document {
    let mut gen = IdGen::new(3);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut f = crate::ops::default_node(NodeType::Frame, "f".into(), "Screen".into());
    f.width = 390.0;
    f.height = 800.0;
    f.overflow = overflow;
    doc.insert(f, None, &page, None);
    for (id, fixed) in [("nav", fixed_nav), ("body", false)] {
      let mut c = crate::ops::default_node(NodeType::Frame, id.into(), id.into());
      c.width = 390.0;
      c.height = if id == "nav" { 80.0 } else { 2000.0 };
      if fixed {
        c.scroll_behavior = crate::model::ScrollBehavior::Fixed;
      }
      doc.insert(c, Some("f"), &page, None);
    }
    doc
  }

  #[test]
  fn scrolling_frames_get_overflow_classes_and_fixed_layers_leave_the_scroller() {
    use crate::model::Overflow;
    let m = HeuristicMeasurer;
    let src = export_react(&page_with(Overflow::Vertical, false), "f", &m);
    assert!(src.contains("overflow-y-auto"), "{src}");
    let src = export_react(&page_with(Overflow::Horizontal, false), "f", &m);
    assert!(src.contains("overflow-x-auto"), "{src}");
    let src = export_react(&page_with(Overflow::Both, false), "f", &m);
    assert!(src.contains("overflow-auto"), "{src}");
    // A fixed nav sits next to the scrolling box instead of inside it: the screen itself no
    // longer scrolls, a new box inside it does.
    let src = export_react(&page_with(Overflow::Vertical, true), "f", &m);
    assert_eq!(src.matches("overflow-y-auto").count(), 1, "{src}");
    assert!(
      src.contains("h-full") || src.contains("height: 100%") || src.contains("100%"),
      "{src}"
    );
  }
}

#[cfg(test)]
mod r8_tests {
  use super::*;
  use crate::model::{GradientStop, Interaction, Trigger};
  use crate::text::HeuristicMeasurer;

  const GRADIENT_A: &str = "#000000";
  const GRADIENT_B: &str = "#FFFFFF";

  #[test]
  fn key_triggers_go_to_the_screen_table_not_to_onclick() {
    let mut doc = sample();
    let btn = doc.get_mut("btn").unwrap();
    btn.interactions[0].trigger = Trigger::Key;
    btn.interactions[0].key = Some("Enter".into());
    let home = project(&doc, "src/screens/Home.tsx");
    assert!(!home.contains("onClick"), "{home}");
    let app = project(&doc, "src/App.tsx");
    assert!(
      app.contains(r#"const keys: Record<string, (Step & { key: string })[]> = {"Home":[{"key":"Enter","to":"ProductDetail"}]};"#),
      "{app}"
    );
    assert!(
      app.contains("const delays: Record<string, (Step & { ms: number })[]> = {};"),
      "{app}"
    );
  }

  #[test]
  fn delays_are_the_screens_first_one_and_hover_is_skipped() {
    let mut doc = sample();
    let mut delay = Interaction {
      trigger: Trigger::AfterDelay,
      delay_ms: 1500.0,
      destination: Some("detail".into()),
      ..Default::default()
    };
    let mut second = delay.clone();
    second.delay_ms = 99.0;
    // A layer's delay is not exported (the player runs a screen's own), nor a screen's second.
    let btn = doc.get_mut("btn").unwrap();
    btn.interactions[0].trigger = Trigger::OnHover;
    btn.interactions.push(delay.clone());
    delay.destination = Some("detail".into());
    let home = doc.get_mut("home").unwrap();
    home.interactions.push(delay);
    home.interactions.push(second);
    let src = project(&doc, "src/screens/Home.tsx");
    assert!(!src.contains("onClick"), "{src}");
    let app = project(&doc, "src/App.tsx");
    assert!(app.contains(r#"= {"Home":[{"ms":1500.0,"to":"ProductDetail"}]};"#), "{app}");
  }

  #[test]
  fn one_enter_runs_one_action() {
    let app = project(&sample(), "src/App.tsx");
    assert!(app.contains("if (e.defaultPrevented) return;"), "{app}");
    let src = export_react(&sample(), "home", &HeuristicMeasurer);
    assert!(src.contains("e.preventDefault();"), "{src}");
  }

  #[test]
  fn a_card_holding_a_button_is_not_itself_a_control() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    let mut card = crate::ops::default_node(NodeType::Frame, "card".into(), "Card".into());
    card.height = 150.0;
    card.interactions.push(Interaction {
      destination: Some("detail".into()),
      ..Default::default()
    });
    doc.insert(card, Some("home"), &page, None);
    let mut b = crate::ops::default_node(NodeType::Frame, "del".into(), "Delete button".into());
    b.height = 40.0;
    b.interactions.push(Interaction {
      action: Action::CloseOverlay,
      ..Default::default()
    });
    doc.insert(b, Some("card"), &page, None);
    let mut t = crate::ops::default_node(NodeType::Text, "dt".into(), "T".into());
    t.text.as_mut().unwrap().characters = "Delete".into();
    doc.insert(t, Some("del"), &page, None);
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    // The card keeps its click (and the button stops it); only the childless "Buy" layer is a control.
    assert_eq!(src.matches("role=\"button\"").count(), 1, "{src}");
    assert!(src.contains("<button "), "{src}");
    assert!(src.contains("e.stopPropagation()"), "{src}");
  }

  #[test]
  fn component_clicks_stop_there() {
    let mut doc = sample();
    let mut gen = crate::doc::IdGen::new(900);
    let page = doc.pages[0].id.clone();
    let mut f = crate::ops::default_node(NodeType::Frame, "cmp".into(), "Row".into());
    f.x = 900.0;
    f.height = 60.0;
    doc.insert(f, None, &page, None);
    let mut r = crate::ops::default_node(NodeType::Rectangle, "cmp_in".into(), "Inner".into());
    r.interactions.push(Interaction {
      destination: Some("detail".into()),
      ..Default::default()
    });
    doc.insert(r, Some("cmp"), &page, None);
    let comp = crate::components::create_component(&mut doc, &["cmp".to_string()], &mut gen).unwrap();
    crate::components::create_instance(&mut doc, &comp, Some("home"), &page, 0.0, 0.0, &mut gen).unwrap();
    let files = export_project(&doc, &HeuristicMeasurer);
    let comps = &files.iter().find(|f| f.path == "src/components.tsx").unwrap().content;
    assert!(
      comps.contains("onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}"),
      "{comps}"
    );
    assert!(comps.contains("e.stopPropagation(); onNavigate?.("), "{comps}");
  }

  #[test]
  fn on_click_beats_while_pressing_and_the_hash_cannot_hit_the_prototype_chain() {
    let mut doc = sample();
    let btn = doc.get_mut("btn").unwrap();
    let mut press = btn.interactions[0].clone();
    press.trigger = Trigger::OnPress;
    press.action = Action::CloseOverlay;
    // Pressing listed after the click, then a pressing listed before it: the click wins both ways.
    btn.interactions.push(press.clone());
    btn.interactions.insert(0, press);
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(
      src.contains("onNavigate?.(\"ProductDetail\")") && !src.contains("close-overlay"),
      "{src}"
    );
    let app = project(&doc, "src/App.tsx");
    assert!(app.contains("Object.prototype.hasOwnProperty.call(screens, hash)"), "{app}");
    assert!(!app.contains("hash in screens"), "{app}");
  }

  #[test]
  fn clickable_layers_are_keyboard_controls() {
    let doc = sample();
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(src.contains("role=\"button\" tabIndex={0}"), "{src}");
    assert!(src.contains("onKeyDown="), "{src}");
    // The HTML export has no handlers, so it claims no role either.
    let html = export_html(&doc, "home", &HeuristicMeasurer);
    assert!(!html.contains("role=") && !html.contains("tabindex"), "{html}");
  }

  #[test]
  fn start_screen_comes_from_the_hash_and_the_readme_lists_flows_and_limits() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    doc.pages[0].flow_start = Some("detail".into());
    let hero = crate::ops::default_node(NodeType::Rectangle, "hero".into(), "hero.jpg".into());
    doc.insert(hero, None, &page, None);
    let app = project(&doc, "src/App.tsx");
    assert!(
      app.contains("window.location.hash") && app.contains("hasOwnProperty.call(screens, hash) ? hash : \"ProductDetail\";"),
      "{app}"
    );
    let readme = project(&doc, "README.md");
    assert!(readme.contains("`/#ProductDetail`"), "{readme}");
    assert!(
      readme.contains("transitions") && readme.contains("While pressing becomes a click"),
      "{readme}"
    );
    assert!(readme.contains("Not exported: 1 layer outside frames: hero.jpg"), "{readme}");
  }

  #[test]
  fn vectors_inlined_in_one_screen_have_distinct_def_ids() {
    let mut doc = sample();
    let page = doc.pages[0].id.clone();
    for id in ["v1", "v2"] {
      let mut v = crate::ops::default_node(NodeType::Polygon, id.into(), id.into());
      v.width = 40.0;
      v.height = 40.0;
      v.fills = vec![Paint::LinearGradient {
        stops: vec![
          GradientStop {
            color: GRADIENT_A.into(),
            position: 0.0,
          },
          GradientStop {
            color: GRADIENT_B.into(),
            position: 1.0,
          },
        ],
        angle: 90.0,
        opacity: 1.0,
        visible: true,
        handles: None,
      }];
      doc.insert(v, Some("home"), &page, None);
    }
    let home = project(&doc, "src/screens/Home.tsx").replace("\\\"", "\"");
    let ids: Vec<&str> = home.split("id=\"").skip(1).filter_map(|r| r.split('"').next()).collect();
    let unique: BTreeSet<&&str> = ids.iter().collect();
    assert!(ids.len() >= 2 && unique.len() == ids.len(), "{ids:?}");
  }

  fn sample() -> Document {
    let mut gen = crate::doc::IdGen::new(1);
    let mut doc = crate::doc::new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    for (id, name, x) in [("home", "Home", 0.0), ("detail", "Product detail", 500.0)] {
      let mut f = crate::ops::default_node(NodeType::Frame, id.into(), name.into());
      f.x = x;
      doc.insert(f, None, &page, None);
    }
    let mut btn = crate::ops::default_node(NodeType::Rectangle, "btn".into(), "Buy".into());
    btn.height = 120.0;
    btn.interactions.push(Interaction {
      destination: Some("detail".into()),
      ..Default::default()
    });
    doc.insert(btn, Some("home"), &page, None);
    doc
  }

  fn project(doc: &Document, path: &str) -> String {
    export_project(doc, &HeuristicMeasurer)
      .into_iter()
      .find(|f| f.path == path)
      .map(|f| f.content)
      .unwrap_or_default()
  }
}

#[cfg(test)]
mod r10_tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::model::{AutoLayout, Interaction, Overflow, ScrollBehavior, Sizing};
  use crate::text::HeuristicMeasurer;

  fn base() -> Document {
    let mut gen = IdGen::new(21);
    new_document(&mut gen, "R10")
  }

  fn add(doc: &mut Document, kind: NodeType, id: &str, name: &str, parent: Option<&str>) {
    let page = doc.pages[0].id.clone();
    let n = crate::ops::default_node(kind, id.into(), name.into());
    doc.insert(n, parent, &page, None);
  }

  fn project(doc: &Document, path: &str) -> String {
    export_project(doc, &HeuristicMeasurer)
      .into_iter()
      .find(|f| f.path == path)
      .map(|f| f.content)
      .unwrap_or_default()
  }

  fn pad8() -> AutoLayout {
    AutoLayout {
      padding_top: 8.0,
      padding_right: 8.0,
      padding_bottom: 8.0,
      padding_left: 8.0,
      ..Default::default()
    }
  }

  #[test]
  fn a_scrolling_auto_layout_screen_has_a_fixed_height_and_an_inner_scroller() {
    let mut doc = base();
    add(&mut doc, NodeType::Frame, "feed", "Feed", None);
    {
      let f = doc.get_mut("feed").unwrap();
      f.width = 390.0;
      f.height = 874.0;
      f.overflow = Overflow::Vertical;
      f.layout = Some(AutoLayout {
        gap: 12.0,
        padding_top: 20.0,
        ..Default::default()
      });
    }
    for id in ["a", "b"] {
      add(&mut doc, NodeType::Frame, id, id, Some("feed"));
      let c = doc.get_mut(id).unwrap();
      c.width = 390.0;
      c.height = 900.0;
    }
    add(&mut doc, NodeType::Frame, "tab", "Tab bar", Some("feed"));
    {
      let t = doc.get_mut("tab").unwrap();
      t.width = 390.0;
      t.height = 80.0;
      t.absolute_position = true;
      t.scroll_behavior = ScrollBehavior::Fixed;
    }
    let src = export_react(&doc, "feed", &HeuristicMeasurer);
    assert!(src.contains("h-[874px]") && !src.contains("min-h-[874px]"), "{src}");
    let root = src.lines().find(|l| l.contains("h-[874px]")).unwrap_or_default();
    assert!(
      root.contains("relative") && !root.contains("overflow-y") && !root.contains("flex"),
      "{src}"
    );
    let scroller = src.lines().find(|l| l.contains("overflow-y-auto")).expect("scroller");
    assert!(
      scroller.contains("flex-col") && scroller.contains("gap-y-[12px]") && scroller.contains("pt-[20px]"),
      "{scroller}"
    );
    // The fixed layer follows the scroller's closing tag.
    let end = src.find("</div>").expect("scroller end");
    assert!(src.contains("h-[80px]"), "{src}");
    assert!(
      src[..end].find("h-[80px]").is_none() && src.find("h-[80px]").unwrap() > end,
      "{src}"
    );
  }

  #[test]
  fn strokes_are_outlines_that_take_no_layout_space() {
    let mut doc = base();
    add(&mut doc, NodeType::Frame, "f", "Card", None);
    {
      let f = doc.get_mut("f").unwrap();
      f.layout = Some(pad8());
      f.sizing_h = Sizing::Hug;
      f.sizing_v = Sizing::Hug;
      f.strokes = vec![Paint::solid("#112233")];
      f.stroke_weight = 1.0;
      f.stroke_align = StrokeAlign::Inside;
    }
    let src = export_react(&doc, "f", &HeuristicMeasurer);
    assert!(!src.contains("border-solid") && !src.contains("[border:"), "{src}");
    assert!(src.contains("outline-offset:-1px"), "{src}");
    {
      let f = doc.get_mut("f").unwrap();
      f.stroke_align = StrokeAlign::Center;
      f.stroke_weight = 4.0;
    }
    assert!(export_react(&doc, "f", &HeuristicMeasurer).contains("outline-offset:-2px"));
    doc.get_mut("f").unwrap().stroke_align = StrokeAlign::Outside;
    assert!(export_react(&doc, "f", &HeuristicMeasurer).contains("outline-offset:0"));
  }

  #[test]
  fn per_side_borders_come_out_of_the_padding() {
    let mut doc = base();
    add(&mut doc, NodeType::Frame, "f", "Card", None);
    {
      let f = doc.get_mut("f").unwrap();
      f.layout = Some(pad8());
      f.strokes = vec![Paint::solid("#112233")];
      f.stroke_weight = 2.0;
      f.stroke_weights = Some([2.0, 0.0, 0.0, 10.0]);
      f.stroke_align = StrokeAlign::Inside;
    }
    let src = export_react(&doc, "f", &HeuristicMeasurer);
    assert!(src.contains("border-t-[2px]"), "{src}");
    assert!(src.contains("pt-[6px] pr-[8px] pb-[8px]") && !src.contains("pl-["), "{src}");
  }

  #[test]
  fn controls_without_text_get_an_accessible_name() {
    let mut doc = base();
    add(&mut doc, NodeType::Frame, "home", "Home", None);
    add(&mut doc, NodeType::Frame, "detail", "Detail", None);
    for (id, name) in [("e1", "Ellipse 4"), ("e2", "Filter")] {
      add(&mut doc, NodeType::Ellipse, id, name, Some("home"));
      let e = doc.get_mut(id).unwrap();
      e.width = 24.0;
      e.height = 24.0;
      e.interactions.push(Interaction {
        destination: Some("detail".into()),
        ..Default::default()
      });
    }
    let src = export_react(&doc, "home", &HeuristicMeasurer);
    assert!(src.contains("aria-label=\"Go to Detail\""), "{src}");
    assert!(src.contains("aria-label=\"Filter\""), "{src}");
  }

  #[test]
  fn default_names_are_recognised() {
    for n in ["Frame", "Frame 12", "Rectangle 3", "Image", "Instance 2", " "] {
      assert!(is_default_name(n), "{n}");
    }
    for n in ["Frame Home", "Filter", "Framework", "Star 3 big"] {
      assert!(!is_default_name(n), "{n}");
    }
  }

  #[test]
  fn a_wrap_container_has_one_row_gap() {
    let mut doc = base();
    add(&mut doc, NodeType::Frame, "f", "Chips", None);
    doc.get_mut("f").unwrap().layout = Some(AutoLayout {
      wrap: true,
      gap: 8.0,
      counter_gap: 8.0,
      ..Default::default()
    });
    let src = export_react(&doc, "f", &HeuristicMeasurer);
    assert_eq!(src.matches("gap-y-").count(), 1, "{src}");
  }

  #[test]
  fn claude_md_screen_names_and_credits() {
    let mut doc = base();
    add(&mut doc, NodeType::Frame, "m", "Marketing Dark", None);
    let claude = project(&doc, "CLAUDE.md");
    assert!(claude.contains("`get_nodes`") && !claude.contains("`get_node`"), "{claude}");
    let app = project(&doc, "src/App.tsx");
    assert!(app.contains("{\"Marketing Dark\":\"MarketingDark\"}"), "{app}");
    assert!(!project(&doc, "README.md").contains("CREDITS.md"));
    // A name that equals its key needs no alias.
    let mut plain = base();
    add(&mut plain, NodeType::Frame, "h", "Home", None);
    assert!(project(&plain, "src/App.tsx").contains("screenNames: Record<string, string> = {};"));
  }

  #[test]
  fn a_set_description_is_the_jsdoc_of_the_set_function() {
    let mut doc = base();
    let mut gen = IdGen::new(900);
    let mut ids = vec![];
    for (id, name) in [("ba", "Button/Primary"), ("bb", "Button/Secondary")] {
      add(&mut doc, NodeType::Frame, id, name, None);
      doc.get_mut(id).unwrap().layout = Some(AutoLayout::default());
      let tid = format!("{id}_t");
      add(&mut doc, NodeType::Text, &tid, "Label", Some(id));
      doc.get_mut(&tid).unwrap().text.as_mut().unwrap().characters = "Go".into();
      ids.push(crate::components::create_component(&mut doc, &[id.to_string()], &mut gen).unwrap());
    }
    let set = crate::components::combine_as_variants(&mut doc, &ids, &mut gen).unwrap();
    doc
      .get_mut(&set)
      .unwrap()
      .component
      .get_or_insert_with(Default::default)
      .description = "Primary action.".into();
    let comps = project(&doc, "src/components.tsx");
    assert!(comps.contains("/** Primary action. */\nexport function Button("), "{comps}");
  }

  #[test]
  fn an_inside_stroke_is_the_last_child_when_children_are_absolute() {
    let mut doc = base();
    add(&mut doc, NodeType::Frame, "f", "Card", None);
    {
      let f = doc.get_mut("f").unwrap();
      f.width = 200.0;
      f.height = 100.0;
      f.corner_radius = 12.0;
      f.strokes = vec![Paint::solid("#112233")];
      f.stroke_weight = 2.0;
      f.stroke_align = StrokeAlign::Inside;
    }
    add(&mut doc, NodeType::Rectangle, "img", "Cover", Some("f"));
    let src = export_react(&doc, "f", &HeuristicMeasurer);
    assert!(!src.contains("outline"), "{src}");
    let img = src.find("bg-[#D9D9D9]").expect("cover");
    let last = src.find("[inset:0]").expect("overlay");
    assert!(
      last > img && src[last..src.rfind("aria-hidden").unwrap()].contains("[pointer-events:none]"),
      "{src}"
    );
    assert!(
      src[last..].contains("[inset:0]") && src[last..].contains("rounded-[inherit]"),
      "{src}"
    );
    // Outside strokes can't be covered, so they stay outlines.
    doc.get_mut("f").unwrap().stroke_align = StrokeAlign::Outside;
    let src = export_react(&doc, "f", &HeuristicMeasurer);
    assert!(src.contains("outline") && !src.contains("aria-hidden"), "{src}");
  }

  #[test]
  fn a_hugging_scroller_with_a_fixed_child_stays_in_flow() {
    let mut doc = base();
    add(&mut doc, NodeType::Frame, "f", "List", None);
    {
      let f = doc.get_mut("f").unwrap();
      f.overflow = Overflow::Vertical;
      f.layout = Some(AutoLayout::default());
      f.sizing_v = Sizing::Hug;
    }
    add(&mut doc, NodeType::Frame, "c", "Row", Some("f"));
    add(&mut doc, NodeType::Frame, "bar", "Bar", Some("f"));
    {
      let b = doc.get_mut("bar").unwrap();
      b.absolute_position = true;
      b.scroll_behavior = ScrollBehavior::Fixed;
    }
    let src = export_react(&doc, "f", &HeuristicMeasurer);
    assert!(!src.contains("h-[100%]"), "{src}");
  }

  #[test]
  fn a_centre_stroke_keeps_its_outer_half_as_an_outline() {
    let mut doc = base();
    add(&mut doc, NodeType::Frame, "f", "Card", None);
    {
      let f = doc.get_mut("f").unwrap();
      f.strokes = vec![Paint::solid("#112233")];
      f.stroke_weight = 4.0;
      f.stroke_align = StrokeAlign::Center;
      f.clip_content = true;
    }
    add(&mut doc, NodeType::Rectangle, "img", "Cover", Some("f"));
    let src = export_react(&doc, "f", &HeuristicMeasurer);
    // Half inside as an overlay span, half outside as an outline the frame's overflow can't clip.
    assert!(
      src.contains("[outline:2px_solid_#112233]") && src.contains("[outline-offset:0]"),
      "{src}"
    );
    assert!(
      src.contains("<span") && src.contains("[border:2px_solid_#112233]") && src.contains("[inset:0]"),
      "{src}"
    );
    assert!(!src.contains("-2px"), "{src}");
  }

  #[test]
  fn a_text_svg_image_source_is_encoded_in_img_src() {
    let mut doc = base();
    add(&mut doc, NodeType::Rectangle, "r", "Pic", None);
    doc.get_mut("r").unwrap().fills = vec![Paint::Image {
      src: "data:image/svg+xml,<svg xmlns='x'><stop stop-color='#00ff00'/></svg>".into(),
      scale_mode: crate::model::ScaleMode::Fill,
      opacity: 1.0,
      visible: true,
      crop: None,
      credit: None,
    }];
    let src = export_react(&doc, "r", &HeuristicMeasurer);
    assert!(src.contains("%2300ff00") && !src.contains("#00ff00"), "{src}");
  }

  #[test]
  fn text_data_urls_are_fully_percent_encoded() {
    let svg = "data:image/svg+xml,<svg xmlns='x' a_b='100%'><g fill='url(#g)'/>%20</svg>";
    let out = css_url(svg);
    assert!(!out.contains([' ', '(', ')', '_', '\'', '#', '<']), "{out}");
    assert!(out.contains("100%25") && !out.contains("%20<"), "{out}");
    assert_eq!(css_url("data:image/png;base64,AAA_"), "data:image/png;base64,AAA_");
  }

  #[test]
  fn duplicate_frame_names_do_not_steal_a_screen_key() {
    let mut doc = base();
    add(&mut doc, NodeType::Frame, "a", "Home", None);
    add(&mut doc, NodeType::Frame, "b", "Home", None);
    let app = project(&doc, "src/App.tsx");
    assert!(app.contains("screenNames: Record<string, string> = {};"), "{app}");
    assert!(app.contains("!Object.prototype.hasOwnProperty.call(screens, hash) &&"), "{app}");
  }

  #[test]
  fn focus_ring_and_main_come_with_outline_strokes() {
    let doc = base();
    assert!(project(&doc, "src/index.css").contains(":focus-visible { outline: 2px solid #2563eb !important;"));
    assert!(project(&doc, "README.md").contains("focus ring"));
    let mut d = base();
    add(&mut d, NodeType::Frame, "a", "Home", None);
    let html = export_html(&d, "a", &HeuristicMeasurer);
    assert!(html.contains("<main>") && html.contains(":focus-visible"), "{html}");
  }
}
