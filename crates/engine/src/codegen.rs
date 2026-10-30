//! Design-to-code: React + Tailwind components, standalone HTML and a
//! complete Vite project where prototype links become working navigation.

use std::collections::{BTreeMap, BTreeSet};

use crate::color;
use crate::components;
use crate::geom::fmt;
use crate::model::{
  Action, Align, Document, EffectType, LayoutDirection, Node, NodeType, OverlayPosition, OverlaySettings, Paint, ScaleMode, Sizing,
  StrokeAlign, TextAlignH, TextAutoResize, TextCase, TextDecoration,
};
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
  const [history, setHistory] = useState<string[]>([__START__]);
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeTop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const phone = phoneScreens.has(current);
  return (
    <div className={phone ? "min-h-screen flex items-start justify-center bg-neutral-100 py-10" : "min-h-screen flex justify-center"}>
      <div ref={host} className="relative w-full" style={{ maxWidth: widths[current] }}>
        {Screen ? <Screen onNavigate={onNavigate} /> : null}
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
  /// `onNavigate` target: a screen name, "back", "overlay:<Screen>", "swap-overlay:<Screen>"
  /// or "close-overlay".
  navigate: Option<String>,
  /// Overlay placement passed as `onNavigate`'s second argument.
  overlay: Option<serde_json::Value>,
  url: Option<String>,
  is_component_root: bool,
  /// Extra HTML attributes (src, alt, type).
  attrs: Vec<(String, String)>,
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
      navigate: None,
      overlay: None,
      url: None,
      is_component_root: false,
      attrs: vec![],
    }
  }

  fn s(&mut self, k: &str, v: impl Into<String>) {
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
    name
  }

  /// The component set `comp_id` is a variant of.
  fn variant_set(&self, comp_id: &str) -> Option<Node> {
    let p = self.doc.get(comp_id)?.parent.as_ref()?;
    self.doc.get(p).filter(|s| s.kind == NodeType::ComponentSet).cloned()
  }

  fn build(&mut self, id: &str, place: Place) -> Option<El> {
    let n = self.doc.get(id)?.clone();
    if !n.visible {
      return None;
    }
    if self.reuse_components && n.kind == NodeType::Instance && place != Place::Root {
      if let Some(info) = n.instance.as_ref() {
        if !components::has_overrides(self.doc, id) && self.doc.get(&info.component_id).is_some() {
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
        e.tag = self.heading_tag(&n);
        e
      }
      NodeType::Vector | NodeType::Polygon | NodeType::Star => {
        let mut e = El::new("div");
        e.raw = Some(export_svg_geometry(self.doc, &n.id, self.m));
        e
      }
      _ if image_src.is_some() => {
        let mut e = El::new("img");
        e.attrs.push(("src".into(), image_src.clone().unwrap_or_default()));
        e.attrs.push(("alt".into(), n.name.clone()));
        e
      }
      _ => El::new(self.container_tag(&n)),
    };
    if el.tag == "button" {
      el.attrs.push(("type".into(), "button".into()));
    }
    if n.kind == NodeType::Group {
      el.comment = Some(n.name.clone());
    }
    el.is_component_root = place == Place::ComponentRoot;
    self.position(&mut el, &n, place);
    self.limits(&mut el, &n);
    self.visual(&mut el, &n);
    self.bind_vars(&mut el, &n);
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
        el.s("padding", pad.iter().map(|p| px(*p)).collect::<Vec<_>>().join(" "));
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
      for cid in &n.children {
        let Some(c) = self.doc.get(cid).cloned() else { continue };
        if let Some(ce) = self.build(cid, child_place(&c)) {
          el.children.push(ce);
        }
      }
    }
    self.interactions(&mut el, &n);
    Some(el)
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
    } else if has("main") {
      "main"
    } else if has("hero") || has("section") || has("features") || has("pricing") || has("testimonials") || has("faq") {
      "section"
    } else {
      "div"
    }
  }

  fn interactions(&self, el: &mut El, n: &Node) {
    for i in &n.interactions {
      match i.action {
        Action::Navigate => {
          if let Some(name) = i.destination.as_ref().and_then(|d| self.screen_names.get(d)) {
            el.navigate = Some(name.clone());
          }
        }
        Action::Back => el.navigate = Some("back".into()),
        Action::OpenOverlay | Action::SwapOverlay => {
          if let Some(name) = i.destination.as_ref().and_then(|d| self.screen_names.get(d)) {
            let kind = if i.action == Action::OpenOverlay {
              "overlay"
            } else {
              "swap-overlay"
            };
            el.navigate = Some(format!("{kind}:{name}"));
            el.overlay = Some(self.overlay_opts(n, &i.overlay));
          }
        }
        Action::CloseOverlay => el.navigate = Some("close-overlay".into()),
        Action::OpenUrl => el.url = i.url.as_deref().and_then(crate::model::safe_link),
        Action::ScrollTo => {}
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
        el.s("min-height", px(n.height));
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
          el.attrs.push((vars::mode_attr(c), vars::slug(&m.name)));
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
              if k == "border" || k == "outline" || k == "border-top" {
                *val = val.replace(&lit, &var);
              }
            }
          }
        }
        "cornerRadius" => set(el, "border-radius", &len),
        "padding" => set(el, "padding", &len),
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
      let bgs: Vec<String> = n.fills.iter().rev().filter(|p| p.visible()).map(css_paint).collect();
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
      if let Some(Paint::Image { scale_mode, .. }) = n.fills.iter().find(|p| matches!(p, Paint::Image { .. }) && p.visible()) {
        el.s(
          "background-size",
          match scale_mode {
            ScaleMode::Fill => "cover",
            ScaleMode::Fit => "contain",
            ScaleMode::Stretch => "100% 100%",
            ScaleMode::Tile => "64px 64px",
          },
        );
        el.s("background-position", "center");
        if *scale_mode != ScaleMode::Tile {
          el.s("background-repeat", "no-repeat");
        }
      }
      if let Some(Paint::Solid { color, opacity, .. }) = n.strokes.iter().find(|p| p.visible()) {
        if n.stroke_weight > 0.0 {
          let style = if n.stroke_dash.is_empty() { "solid" } else { "dashed" };
          let c = color::css_with_opacity(color, *opacity);
          match n.stroke_align {
            StrokeAlign::Outside => el.s("outline", format!("{} {style} {c}", px(n.stroke_weight))),
            _ => el.s("border", format!("{} {style} {c}", px(n.stroke_weight))),
          }
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
      if n.clip_content && n.kind.is_frame_like() {
        el.s("overflow", "hidden");
      }
    }
    let shadows: Vec<String> = n
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
        el.s("background", css_paint(p));
        el.s("-webkit-background-clip", "text");
        el.s("background-clip", "text");
        el.s("color", "transparent");
      }
      None => {}
    }
    el.s("font-family", font_stack(&t.font_family));
    el.s("font-size", px(t.font_size));
    if t.font_weight != 400 {
      el.s("font-weight", t.font_weight.to_string());
    }
    if t.italic {
      el.s("font-style", "italic");
    }
    el.s("line-height", px(t.line_height_px()));
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

/// The image URL when a rectangle is just an image (one visible image fill).
fn image_only(n: &Node) -> Option<String> {
  if n.kind != NodeType::Rectangle || !n.children.is_empty() {
    return None;
  }
  let visible: Vec<&Paint> = n.fills.iter().filter(|p| p.visible()).collect();
  match visible.as_slice() {
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
        styles.push(("font-family".into(), font_stack(f)));
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

fn css_paint(p: &Paint) -> String {
  match p {
    Paint::Solid { color, opacity, .. } => color::css_with_opacity(color, *opacity),
    Paint::LinearGradient { stops, angle, opacity, .. } => format!("linear-gradient({}deg, {})", fmt(*angle), css_stops(stops, *opacity)),
    Paint::RadialGradient { stops, opacity, .. } => format!("radial-gradient(circle, {})", css_stops(stops, *opacity)),
    Paint::Image { src, .. } => format!("url(\"{}\")", src.replace('"', "%22")),
  }
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
  v.replace(' ', "_")
}

/// Converts a CSS declaration into Tailwind utility classes.
fn tw_class(k: &str, v: &str) -> String {
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
    ("font-family", _) => format!("font-[{}]", tw_value(&v.replace('\'', "")).replace(",_", ",")),
    _ => format!("[{k}:{a}]"),
  }
}

fn tw_padding(v: &str) -> String {
  let p: Vec<&str> = v.split(' ').collect();
  if p.len() != 4 {
    return format!("p-[{}]", tw_value(v));
  }
  let (t, r, b, l) = (p[0], p[1], p[2], p[3]);
  let cls = |pre: &str, val: &str| if val == "0" { String::new() } else { format!("{pre}-[{val}]") };
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
  let pad = "  ".repeat(depth);
  if let Some(c) = &el.comment {
    out.push_str(&format!("{pad}{{/* {} */}}\n", c.replace("*/", "")));
  }
  let mut classes: Vec<String> = el.styles.iter().map(|(k, v)| tw_class(k, v)).filter(|c| !c.is_empty()).collect();
  classes.dedup();
  let mut class_attr = classes.join(" ");
  if el.is_component_root {
    class_attr = format!("{{`{class_attr} ${{className ?? \"\"}}`}}");
  } else {
    class_attr = format!("\"{class_attr}\"");
  }
  let handler = if let Some(screen) = &el.navigate {
    let opts = el.overlay.as_ref().map(|o| format!(", {o}")).unwrap_or_default();
    format!(
      " onClick={{() => onNavigate?.({}{opts})}}",
      serde_json::to_string(screen).unwrap_or_default()
    )
  } else if let Some(url) = &el.url {
    format!(
      " onClick={{() => window.open({}, \"_blank\")}}",
      serde_json::to_string(url).unwrap_or_default()
    )
  } else if el.is_component_root {
    " onClick={onClick}".to_string()
  } else {
    String::new()
  };
  let handler = format!(
    "{handler}{}",
    el.attrs
      .iter()
      .map(|(k, v)| format!(" {k}={}", serde_json::to_string(v).unwrap_or_default()))
      .collect::<String>()
  );
  if let Some(name) = &el.component_ref {
    out.push_str(&format!("{pad}<{name} className={class_attr}{handler} />\n"));
    return;
  }
  if let Some(svg) = &el.raw {
    out.push_str(&format!(
      "{pad}<div className={class_attr}{handler} dangerouslySetInnerHTML={{{{ __html: {} }}}} />\n",
      serde_json::to_string(svg).unwrap_or_default()
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
  let style: String = decls.iter().map(|(k, v)| format!("{k}: {v}; ")).collect();
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
  format!(
    "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n  <title>{}</title>\n{}  <style>*, *::before, *::after {{ box-sizing: border-box; }} body {{ margin: 0; }}{}</style>\n</head>\n<body>\n{}</body>\n</html>\n",
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

/// Generates functions for every component referenced so far (and those they reference).
fn component_fns(ctx: &mut Ctx) -> String {
  let mut out = String::new();
  let mut done: BTreeSet<String> = BTreeSet::new();
  loop {
    let pending: Vec<(String, String)> = ctx
      .components
      .iter()
      .filter(|(id, _)| !done.contains(*id))
      .map(|(a, b)| (a.clone(), b.clone()))
      .collect();
    if pending.is_empty() {
      break;
    }
    for (id, name) in pending {
      done.insert(id.clone());
      if let Some(el) = ctx.build(&id, Place::ComponentRoot) {
        let mut body = String::new();
        jsx(&el, 2, &mut body);
        // Variants are reached through their set's component.
        let export = if ctx.variant_set(&id).is_some() { "" } else { "export " };
        out.push_str(&format!(
          "{export}function {name}({{ className, onClick, onNavigate }}: {PROPS}) {{\n  void onNavigate;\n  return (\n{body}  );\n}}\n\n"
        ));
      }
    }
  }
  for (set_id, set_name) in ctx.sets.clone() {
    if let Some(set) = ctx.doc.get(&set_id) {
      out.push_str(&set_fn(ctx, set, &set_name));
    }
  }
  out
}

const PROPS: &str =
  "{ className?: string; onClick?: () => void; onNavigate?: (screen: string, overlay?: Record<string, unknown>) => void }";
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

/// camelCase prop name for a variant property ("Size" → `size`).
fn prop_ident(key: &str) -> String {
  let p = pascal(key, "Prop");
  let mut id: String = p
    .chars()
    .next()
    .map(|c| c.to_ascii_lowercase())
    .into_iter()
    .chain(p.chars().skip(1))
    .collect();
  if [
    "className",
    "onClick",
    "onNavigate",
    "default",
    "class",
    "for",
    "new",
    "delete",
    "in",
  ]
  .contains(&id.as_str())
  {
    id.push_str("Variant");
  }
  id
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
  let types: Vec<String> = keys
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
  format!(
    "export function {name}({{ {}, ...rest }}: {{ {}; className?: string; onClick?: () => void; onNavigate?: {NAVIGATE} }}) {{\n{body}}}\n\n",
    params.join(", "),
    types.join("; ")
  )
}

pub struct ProjectFile {
  pub path: String,
  pub content: String,
}

/// A complete Vite + React + Tailwind project: one screen per top-level frame.
pub fn export_project(doc: &Document, m: &dyn TextMeasurer) -> Vec<ProjectFile> {
  let mut ctx = Ctx::new(doc, m, true);
  let mut files = Vec::new();
  let screens: Vec<(String, String)> = ctx.screen_order.clone();
  let mut screen_src = Vec::new();
  for (id, name) in &screens {
    if let Some(el) = ctx.build(id, Place::Root) {
      screen_src.push((name.clone(), screen_fn(name, &el, true)));
    }
  }
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
  files.push(ProjectFile {
    path: "src/App.tsx".into(),
    content: APP_TSX
      .replace("__IMPORTS__", &imports)
      .replace("__MAP__", &map)
      .replace("__WIDTHS__", &widths.join(", "))
      .replace("__PHONES__", &phones.join(", "))
      .replace("__START__", &format!("{start:?}")),
  });
  let fonts = google_fonts_link(doc);
  files.push(ProjectFile {
    path: "src/index.css".into(),
    content: format!(
      "{}{}@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
      if fonts.is_empty() {
        String::new()
      } else {
        format!("@import url(\"{fonts}\");\n")
      },
      if doc.variables.is_empty() {
        ""
      } else {
        "@import \"./tokens.css\";\n"
      }
    ),
  });
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
  files.push(ProjectFile {
    path: "index.html".into(),
    content: format!("<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <title>{title}</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n    <script type=\"module\" src=\"/src/main.tsx\"></script>\n  </body>\n</html>\n"),
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
      "# {title}\n\nThis project was generated from a Designotron design. `design.dtron.json` is the design source.\n\n- Screens live in `src/screens/`, one per top-level frame. Reusable components are in `src/components.tsx`.\n- Layout is generated from auto layout (flexbox) and absolute positioning; refactor toward responsive layouts where it makes sense.\n- Prototype links became `onNavigate(\"Screen\")` calls handled in `src/App.tsx`; overlays (`\"overlay:Screen\"`, `\"swap-overlay:Screen\"`, `\"close-overlay\"`) open on top of the current screen, and Escape closes the topmost.\n- If the Designotron bridge is running, its MCP server (`designotron`) can read the live design: use `get_document`, `get_node` and `get_screenshot` to check details.\n"
    ),
  });
  files.push(ProjectFile {
    path: "README.md".into(),
    content: format!(
      "# {title}\n\nGenerated with [Designotron](https://github.com/mikemich/designotron).\n\n```bash\nnpm install\nnpm run dev\n```\n"
    ),
  });
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
    assert!(app.contains("useState<string[]>([\"Home\"])"));
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
    assert!(
      start(&doc).contains("useState<string[]>([\"Home\"])"),
      "falls back to the first screen"
    );
    // A later page's valid start wins over an earlier page's missing one.
    let mut other = doc.pages[0].clone();
    other.id = "p2".into();
    other.children.clear();
    other.flow_start = Some("detail".into());
    doc.pages.push(other);
    assert!(start(&doc).contains("useState<string[]>([\"ProductDetail\"])"));
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
      src: "https://example.com/p.png".into(),
      scale_mode: ScaleMode::Fill,
      opacity: 1.0,
      visible: true,
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
}
