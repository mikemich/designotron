//! SVG renderer. The same code paints the editor canvas (with `data-id`
//! hooks) and produces exported SVG, so what you see is what you export.

use std::collections::HashMap;

use crate::geom::{fmt, Mat, Point, Rect};
use crate::model::{
  Document, Effect, EffectType, Node, NodeId, NodeType, Paint, ScaleMode, StrokeAlign, StrokeCap, TextAlignH, TextAlignV, TextDecoration,
};
use crate::shapes;
use crate::text::{layout_of_node, SpanStyle, TextMeasurer};
use crate::{color, model};

/// Size classes of canvas text (px, rounded up to the next step): about 1.25x apart, so the
/// editor's level of detail switches rarely while zooming. Mirrors `TEXT_SIZE_STEPS` in
/// `web/src/canvas/Canvas.tsx`.
pub const TEXT_SIZE_STEPS: [u32; 20] = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
  Canvas,
  Export,
}

pub struct RenderOptions<'a> {
  pub mode: Mode,
  /// Nodes painted invisibly (e.g. text being edited in an overlay).
  pub hidden: &'a [NodeId],
}

struct Renderer<'a> {
  doc: &'a Document,
  m: &'a dyn TextMeasurer,
  opts: RenderOptions<'a>,
  defs: String,
  uid: usize,
  /// Prefix for generated def ids, so separately rendered roots never collide.
  scope: String,
  /// Paint bounds per node (see `local_render_bounds`), so nested effects don't rescan subtrees.
  bounds: HashMap<&'a str, Rect>,
}

/// Renders all roots of a page as SVG markup (`<defs>` + content), page coordinates.
pub fn render_page(doc: &Document, page: &str, m: &dyn TextMeasurer, opts: RenderOptions) -> String {
  let mut r = Renderer {
    doc,
    m,
    opts,
    defs: String::new(),
    uid: 0,
    scope: String::new(),
    bounds: HashMap::new(),
  };
  let roots = doc.page(page).map(|p| p.children.clone()).unwrap_or_default();
  let body = r.list(&roots);
  format!("<defs>{}</defs>{}", r.defs, body)
}

/// Renders one top-level layer (`<defs>` + content) with def ids scoped to it,
/// so roots can be cached and re-rendered independently.
pub fn render_root(doc: &Document, root: &str, m: &dyn TextMeasurer, opts: RenderOptions) -> String {
  let mut r = Renderer {
    doc,
    m,
    opts,
    defs: String::new(),
    uid: 0,
    scope: format!("{}_", root.replace(|c: char| !c.is_ascii_alphanumeric(), "")),
    bounds: HashMap::new(),
  };
  let body = r.node(root, None);
  if r.defs.is_empty() {
    body
  } else {
    format!("<defs>{}</defs>{}", r.defs, body)
  }
}

/// Renders a single node as a standalone SVG document cropped to everything it paints
/// (outside strokes, shadows, blurs), like Figma's export bounds.
pub fn export_svg(doc: &Document, id: &str, m: &dyn TextMeasurer) -> String {
  export_svg_in(doc, id, m, render_bounds(doc, id, m))
}

/// Like `export_svg` but cropped to the node's geometry only, so the size matches the layer
/// (code export embeds it in a box of that size).
pub fn export_svg_geometry(doc: &Document, id: &str, m: &dyn TextMeasurer) -> String {
  export_svg_in(doc, id, m, doc.abs_bounds(id))
}

/// Page-space bounds of everything a node paints: its geometry plus outside/centre strokes
/// and line caps, drop shadows and layer blurs, and its descendants (unless it clips them).
pub fn render_bounds(doc: &Document, id: &str, m: &dyn TextMeasurer) -> Rect {
  let Some(n) = doc.get(id) else { return Rect::default() };
  let local = local_render_bounds(doc, m, &mut HashMap::new(), n);
  mat_bounds(&doc.abs_matrix(id), &local)
}

fn export_svg_in(doc: &Document, id: &str, m: &dyn TextMeasurer, b: Rect) -> String {
  let Some(n) = doc.get(id) else { return String::new() };
  let mut r = Renderer {
    doc,
    m,
    opts: RenderOptions {
      mode: Mode::Export,
      hidden: &[],
    },
    defs: String::new(),
    uid: 0,
    scope: String::new(),
    bounds: HashMap::new(),
  };
  let place = Mat::translate(-b.x, -b.y).mul(&doc.parent_matrix(id));
  let body = r.node(&n.id, Some(place));
  format!(
    "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\" fill=\"none\"><defs>{defs}</defs>{body}</svg>",
    w = fmt(b.width.max(1.0)),
    h = fmt(b.height.max(1.0)),
    defs = r.defs,
  )
}

/// Everything a node paints, in its own coordinate space (before its transform).
/// `memo` caches the result per node for one pass over the document.
fn local_render_bounds<'a>(doc: &'a Document, m: &dyn TextMeasurer, memo: &mut HashMap<&'a str, Rect>, n: &'a Node) -> Rect {
  // Leaves are cheaper to recompute than to look up.
  let cached = !n.children.is_empty();
  if cached {
    if let Some(r) = memo.get(n.id.as_str()) {
      return *r;
    }
  }
  let sm = stroke_margin(n);
  let own = match n.kind {
    NodeType::Text => text_box(n, m),
    _ => Rect::new(-sm, -sm, n.width + 2.0 * sm, n.height + 2.0 * sm),
  };
  // A group paints only its children; every other node paints its own box too.
  let mut b: Option<Rect> = (n.kind != NodeType::Group).then_some(own);
  if !(n.kind.is_frame_like() && n.clip_content) {
    // Mirrors `Renderer::list`: a visible mask clips the siblings painted above it.
    let mut mask: Option<Rect> = None;
    for c in &n.children {
      let Some(cn) = doc.get(c) else { continue };
      if !cn.visible {
        continue;
      }
      let cb = mat_bounds(&doc.local_matrix(cn), &local_render_bounds(doc, m, memo, cn));
      if cn.is_mask {
        mask = Some(cb);
        continue;
      }
      let cb = match mask {
        Some(mk) => match intersect(&cb, &mk) {
          Some(r) => r,
          None => continue,
        },
        None => cb,
      };
      b = Some(b.map_or(cb, |b| b.union(&cb)));
    }
  }
  let b = b.unwrap_or(own);
  let [l, t, r, bt] = effects_margin(n);
  let out = Rect::new(b.x - l, b.y - t, b.width + l + r, b.height + t + bt);
  if cached {
    memo.insert(n.id.as_str(), out);
  }
  out
}

/// The rect a node's `<filter>` covers: everything it paints, plus room for inner shadows
/// (which are cut out of the shape's alpha and so need transparent margin to work from).
fn filter_region<'a>(doc: &'a Document, m: &dyn TextMeasurer, memo: &mut HashMap<&'a str, Rect>, n: &'a Node) -> Rect {
  let r = local_render_bounds(doc, m, memo, n);
  let pad = n
    .effects
    .iter()
    .filter(|e| e.visible && e.kind == EffectType::InnerShadow)
    .map(|e| e.x.abs().max(e.y.abs()) + 1.5 * e.blur.max(0.0) + e.spread.abs())
    .fold(0.0_f64, f64::max)
    .ceil();
  Rect::new(r.x - pad, r.y - pad, r.width + 2.0 * pad, r.height + 2.0 * pad)
}

/// A text layer's box including lines that overflow it (fixed-size text paints past its edges).
fn text_box(n: &Node, m: &dyn TextMeasurer) -> Rect {
  let Some(t) = n.text.as_ref() else {
    return Rect::new(0.0, 0.0, n.width, n.height);
  };
  // Text that resizes itself already fits its layout.
  if t.auto_resize != crate::model::TextAutoResize::None {
    return Rect::new(0.0, 0.0, n.width, n.height);
  }
  let lay = layout_of_node(n, t, m);
  let dx = (lay.width - n.width).max(0.0);
  let dy = (lay.height - n.height).max(0.0);
  // Overflow runs away from the anchored edge, so follow the alignment.
  let left = match t.align_h {
    TextAlignH::Left | TextAlignH::Justify => 0.0,
    TextAlignH::Center => dx / 2.0,
    TextAlignH::Right => dx,
  };
  let top = match t.align_v {
    TextAlignV::Top => 0.0,
    TextAlignV::Middle => dy / 2.0,
    TextAlignV::Bottom => dy,
  };
  Rect::new(-left, -top, n.width + dx, n.height + dy)
}

fn intersect(a: &Rect, b: &Rect) -> Option<Rect> {
  let x = a.x.max(b.x);
  let y = a.y.max(b.y);
  let (r, bt) = (a.right().min(b.right()), a.bottom().min(b.bottom()));
  (r > x && bt > y).then(|| Rect::new(x, y, r - x, bt - y))
}

/// How far the visible strokes reach beyond the node's box.
fn stroke_margin(n: &Node) -> f64 {
  let sw = n.stroke_weight;
  if sw <= 0.0 || matches!(n.kind, NodeType::Text | NodeType::Group) || !n.strokes.iter().any(|p| p.visible()) {
    return 0.0;
  }
  let mut m = match n.kind {
    NodeType::Line => sw / 2.0,
    NodeType::Polygon | NodeType::Star => {
      if n.stroke_align == StrokeAlign::Inside {
        0.0
      } else {
        sw / 2.0
      }
    }
    NodeType::Vector => {
      if n.stroke_align == StrokeAlign::Inside && is_closed(n) {
        0.0
      } else {
        sw / 2.0
      }
    }
    _ => match n.stroke_align {
      StrokeAlign::Inside => 0.0,
      StrokeAlign::Center => sw / 2.0,
      StrokeAlign::Outside => sw,
    },
  };
  if matches!(n.kind, NodeType::Line | NodeType::Vector) {
    if let Some(s) = n.shape.as_ref() {
      for cap in [s.start_cap, s.end_cap] {
        m = m.max(match cap {
          StrokeCap::Arrow => 3.0 * sw,
          StrokeCap::Circle => 1.8 * sw,
          _ => 0.0,
        });
      }
    }
  }
  m.ceil()
}

/// Left, top, right and bottom reach of the node's drop shadows and layer blur.
fn effects_margin(n: &Node) -> [f64; 4] {
  let mut m = [0.0_f64; 4];
  let mut blur = 0.0_f64;
  for e in n.effects.iter().filter(|e| e.visible) {
    match e.kind {
      EffectType::DropShadow => {
        // The blur's tail reaches about 3 sigma = 1.5 x the radius.
        let reach = 1.5 * e.blur.max(0.0) + e.spread.max(0.0);
        m[0] = m[0].max(reach - e.x);
        m[1] = m[1].max(reach - e.y);
        m[2] = m[2].max(reach + e.x);
        m[3] = m[3].max(reach + e.y);
      }
      EffectType::LayerBlur => blur = blur.max(e.blur.max(0.0)),
      _ => {}
    }
  }
  m.map(|v| (v.max(0.0) + 1.5 * blur).ceil())
}

/// Axis-aligned bounds of `r` after transforming it by `m`.
fn mat_bounds(m: &Mat, r: &Rect) -> Rect {
  let pts = [
    m.apply(Point::new(r.x, r.y)),
    m.apply(Point::new(r.right(), r.y)),
    m.apply(Point::new(r.right(), r.bottom())),
    m.apply(Point::new(r.x, r.bottom())),
  ];
  let min_x = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
  let min_y = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
  let max_x = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
  let max_y = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
  Rect::new(min_x, min_y, max_x - min_x, max_y - min_y)
}

/// Geometry of a node in its local coordinate space.
enum Geo {
  Rect { w: f64, h: f64, r: [f64; 4] },
  Ellipse { w: f64, h: f64 },
  Path { d: String },
  Raw { d: String, transform: String, rule: String },
  Line { w: f64 },
}

impl<'a> Renderer<'a> {
  fn id(&mut self, prefix: &str) -> String {
    self.uid += 1;
    format!("{}{prefix}{}", self.scope, self.uid)
  }

  /// `place` overrides the node's own transform (used by export).
  fn node(&mut self, id: &str, place: Option<Mat>) -> String {
    let Some(n) = self.doc.get(id) else { return String::new() };
    if !n.visible {
      return String::new();
    }
    let m = match place {
      Some(p) => p.mul(&self.doc.local_matrix(n)),
      None => self.doc.local_matrix(n),
    };
    let mut attrs = String::new();
    if self.opts.mode == Mode::Canvas {
      attrs.push_str(&format!(" data-id=\"{}\"", esc(&n.id)));
    }
    if !m.is_identity() {
      attrs.push_str(&format!(" transform=\"{}\"", m.svg()));
    }
    if n.opacity < 1.0 {
      attrs.push_str(&format!(" opacity=\"{}\"", fmt(n.opacity.max(0.0))));
    }
    if n.blend_mode != model::BlendMode::Normal {
      attrs.push_str(&format!(" style=\"mix-blend-mode:{}\"", n.blend_mode.css()));
    }
    if self.opts.hidden.contains(&n.id) {
      attrs.push_str(" visibility=\"hidden\"");
    }
    if let Some(f) = self.effects_filter(n) {
      attrs.push_str(&format!(" filter=\"url(#{f})\""));
    }
    let body = self.body(n);
    format!("<g{attrs}>{body}</g>")
  }

  fn body(&mut self, n: &Node) -> String {
    match n.kind {
      NodeType::Group => self.children(n),
      NodeType::Text => self.text(n),
      k if k.is_frame_like() => {
        let geo = Geo::Rect {
          w: n.width,
          h: n.height,
          r: shapes::corner_radii(n),
        };
        let mut out = self.fills(n, &geo);
        let kids = self.children(n);
        if !kids.is_empty() {
          if n.clip_content {
            let cid = self.id("clip");
            self
              .defs
              .push_str(&format!("<clipPath id=\"{cid}\">{}</clipPath>", geo_el(&geo, "")));
            out.push_str(&format!("<g clip-path=\"url(#{cid})\">{kids}</g>"));
          } else {
            out.push_str(&kids);
          }
        }
        out.push_str(&self.strokes(n, &geo));
        out
      }
      _ => {
        let geo = self.geometry(n);
        let mut out = self.fills(n, &geo);
        out.push_str(&self.strokes(n, &geo));
        out
      }
    }
  }

  fn children(&mut self, n: &Node) -> String {
    self.list(&n.children)
  }

  /// Renders siblings in paint order; a mask layer clips every sibling painted above it.
  fn list(&mut self, ids: &[String]) -> String {
    let mut out = String::new();
    let mut masked: Option<(String, String)> = None;
    for c in ids {
      let is_mask = self.doc.get(c).map(|m| m.is_mask && m.visible).unwrap_or(false);
      if is_mask {
        if let Some((mid, body)) = masked.take() {
          out.push_str(&format!("<g mask=\"url(#{mid})\">{body}</g>"));
        }
        let mid = self.id("mask");
        let shape = self.node(c, None);
        self.defs.push_str(&format!(
          "<mask id=\"{mid}\" maskUnits=\"userSpaceOnUse\" x=\"-100000\" y=\"-100000\" width=\"200000\" height=\"200000\" style=\"mask-type:alpha\">{shape}</mask>"
        ));
        masked = Some((mid, String::new()));
        continue;
      }
      let el = self.node(c, None);
      match masked.as_mut() {
        Some((_, body)) => body.push_str(&el),
        None => out.push_str(&el),
      }
    }
    if let Some((mid, body)) = masked {
      out.push_str(&format!("<g mask=\"url(#{mid})\">{body}</g>"));
    }
    out
  }

  fn geometry(&self, n: &Node) -> Geo {
    match n.kind {
      NodeType::Ellipse => Geo::Ellipse { w: n.width, h: n.height },
      NodeType::Polygon | NodeType::Star => Geo::Path {
        d: shapes::points_path(&shapes::polygon_points(n)),
      },
      NodeType::Line => Geo::Line { w: n.width },
      NodeType::Vector => match n.vector.as_ref().and_then(|v| v.raw.clone()) {
        Some(raw) => {
          let [vx, vy, vw, vh] = raw.view_box;
          let sx = if vw > 0.0 { n.width / vw } else { 1.0 };
          let sy = if vh > 0.0 { n.height / vh } else { 1.0 };
          Geo::Raw {
            d: raw.d,
            transform: format!("matrix({} 0 0 {} {} {})", fmt(sx), fmt(sy), fmt(-vx * sx), fmt(-vy * sy)),
            rule: if raw.fill_rule.is_empty() {
              "nonzero".into()
            } else {
              raw.fill_rule
            },
          }
        }
        None => Geo::Path { d: shapes::vector_d(n) },
      },
      _ => Geo::Rect {
        w: n.width,
        h: n.height,
        r: shapes::corner_radii(n),
      },
    }
  }

  fn fills(&mut self, n: &Node, geo: &Geo) -> String {
    if matches!(geo, Geo::Line { .. }) {
      return String::new();
    }
    let mut out = String::new();
    for p in n.fills.iter().filter(|p| p.visible()) {
      let paint = self.paint(p, n.width, n.height);
      out.push_str(&geo_el(geo, &paint));
    }
    out
  }

  fn strokes(&mut self, n: &Node, geo: &Geo) -> String {
    if n.stroke_weight <= 0.0 {
      return String::new();
    }
    let mut out = String::new();
    let sw = n.stroke_weight;
    let dash = if n.stroke_dash.is_empty() {
      String::new()
    } else {
      format!(
        " stroke-dasharray=\"{}\"",
        n.stroke_dash.iter().map(|v| fmt(*v)).collect::<Vec<_>>().join(" ")
      )
    };
    let caps = self.line_caps(n);
    for p in n.strokes.iter().filter(|p| p.visible()) {
      let paint = self.paint(p, n.width, n.height);
      let stroke = format!(" fill=\"none\" stroke=\"{paint}\"{dash}");
      let el = match (geo, n.stroke_align) {
        (Geo::Rect { w, h, r }, StrokeAlign::Inside) => {
          format!(
            "<path d=\"{}\" stroke-width=\"{}\"{stroke}/>",
            shapes::rounded_rect_path(*w, *h, *r, sw / 2.0),
            fmt(sw)
          )
        }
        (Geo::Rect { w, h, r }, StrokeAlign::Outside) => {
          format!(
            "<path d=\"{}\" stroke-width=\"{}\"{stroke}/>",
            shapes::rounded_rect_path(*w, *h, *r, -sw / 2.0),
            fmt(sw)
          )
        }
        (Geo::Ellipse { w, h }, align) if align != StrokeAlign::Center => {
          let off = if align == StrokeAlign::Inside { sw / 2.0 } else { -sw / 2.0 };
          format!(
            "<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" stroke-width=\"{}\"{stroke}/>",
            fmt(w / 2.0),
            fmt(h / 2.0),
            fmt((w / 2.0 - off).max(0.0)),
            fmt((h / 2.0 - off).max(0.0)),
            fmt(sw)
          )
        }
        (Geo::Path { .. } | Geo::Raw { .. }, StrokeAlign::Inside) if n.kind != NodeType::Vector || is_closed(n) => {
          let cid = self.id("sclip");
          self
            .defs
            .push_str(&format!("<clipPath id=\"{cid}\">{}</clipPath>", geo_el(geo, "")));
          format!(
            "<g clip-path=\"url(#{cid})\">{}</g>",
            geo_el_stroke(geo, &format!(" stroke-width=\"{}\"{stroke}", fmt(sw * 2.0)))
          )
        }
        _ => geo_el_stroke(
          geo,
          &format!(
            " stroke-width=\"{}\" stroke-linecap=\"{}\" stroke-linejoin=\"round\"{stroke}{caps}",
            fmt(sw),
            linecap(n)
          ),
        ),
      };
      out.push_str(&el);
    }
    out
  }

  fn line_caps(&mut self, n: &Node) -> String {
    let Some(shape) = n.shape.as_ref() else { return String::new() };
    if !matches!(n.kind, NodeType::Line | NodeType::Vector) {
      return String::new();
    }
    let color = n.strokes.iter().find_map(|p| match p {
      Paint::Solid { color, .. } => Some(color.clone()),
      _ => None,
    });
    let color = color.unwrap_or_else(|| "#000000".into());
    let mut out = String::new();
    for (cap, attr) in [(shape.start_cap, "marker-start"), (shape.end_cap, "marker-end")] {
      let shape_el = match cap {
        StrokeCap::Arrow => {
          "<path d=\"M0 0L10 5L0 10\" fill=\"none\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
        }
        StrokeCap::Circle => "<circle cx=\"5\" cy=\"5\" r=\"3\"/>",
        _ => continue,
      };
      let mid = self.id("mk");
      let colored = shape_el.replace(
        "/>",
        &format!(
          " stroke=\"{}\" {}/>",
          color::css_with_opacity(&color, 1.0),
          if cap == StrokeCap::Circle {
            format!("fill=\"{}\"", color::css_with_opacity(&color, 1.0))
          } else {
            String::new()
          }
        ),
      );
      self.defs.push_str(&format!(
        "<marker id=\"{mid}\" viewBox=\"0 0 10 10\" refX=\"{}\" refY=\"5\" markerWidth=\"6\" markerHeight=\"6\" orient=\"auto-start-reverse\">{colored}</marker>",
        if cap == StrokeCap::Arrow { "9" } else { "5" }
      ));
      out.push_str(&format!(" {attr}=\"url(#{mid})\""));
    }
    out
  }

  /// Returns an SVG paint value, registering gradient/pattern defs as needed.
  fn paint(&mut self, p: &Paint, w: f64, h: f64) -> String {
    match p {
      Paint::Solid { color, opacity, .. } => color::css_with_opacity(color, *opacity),
      Paint::LinearGradient { stops, angle, opacity, .. } => {
        let gid = self.id("lg");
        let a = angle.to_radians();
        let (dx, dy) = (a.sin(), -a.cos());
        let len = (w * a.sin()).abs() + (h * a.cos()).abs();
        let (cx, cy) = (w / 2.0, h / 2.0);
        self.defs.push_str(&format!(
          "<linearGradient id=\"{gid}\" gradientUnits=\"userSpaceOnUse\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\">{}</linearGradient>",
          fmt(cx - dx * len / 2.0),
          fmt(cy - dy * len / 2.0),
          fmt(cx + dx * len / 2.0),
          fmt(cy + dy * len / 2.0),
          stops_svg(stops, *opacity)
        ));
        format!("url(#{gid})")
      }
      Paint::RadialGradient { stops, opacity, .. } => {
        let gid = self.id("rg");
        self.defs.push_str(&format!(
          "<radialGradient id=\"{gid}\" cx=\"0.5\" cy=\"0.5\" r=\"0.5\">{}</radialGradient>",
          stops_svg(stops, *opacity)
        ));
        format!("url(#{gid})")
      }
      Paint::Image {
        src, scale_mode, opacity, ..
      } => {
        let pid = self.id("img");
        let (par, pw, ph) = match scale_mode {
          ScaleMode::Fill => ("xMidYMid slice", w, h),
          ScaleMode::Fit => ("xMidYMid meet", w, h),
          ScaleMode::Stretch => ("none", w, h),
          ScaleMode::Tile => ("xMidYMid slice", 64.0_f64.min(w), 64.0_f64.min(h)),
        };
        self.defs.push_str(&format!(
          "<pattern id=\"{pid}\" patternUnits=\"userSpaceOnUse\" width=\"{pw}\" height=\"{ph}\"><image href=\"{src}\" width=\"{pw}\" height=\"{ph}\" preserveAspectRatio=\"{par}\" opacity=\"{op}\"/></pattern>",
          pw = fmt(pw.max(1.0)),
          ph = fmt(ph.max(1.0)),
          src = esc(src),
          op = fmt(*opacity),
        ));
        format!("url(#{pid})")
      }
    }
  }

  fn effects_filter(&mut self, n: &'a Node) -> Option<String> {
    let effects: Vec<&Effect> = n
      .effects
      .iter()
      .filter(|e| e.visible && e.kind != EffectType::BackgroundBlur)
      .collect();
    if effects.is_empty() {
      return None;
    }
    let fid = self.id("fx");
    // Region in the node's own space, so big shadows/blurs and zero-height lines aren't cut off.
    let fr = filter_region(self.doc, self.m, &mut self.bounds, n);
    // Whole pixels, rounded outwards: cheaper to print and never smaller than needed.
    let (x0, y0) = (fr.x.floor() as i64, fr.y.floor() as i64);
    let (x1, y1) = (fr.right().ceil() as i64, fr.bottom().ceil() as i64);
    let mut f = format!(
      "<filter id=\"{fid}\" filterUnits=\"userSpaceOnUse\" x=\"{x0}\" y=\"{y0}\" width=\"{}\" height=\"{}\" color-interpolation-filters=\"sRGB\">",
      (x1 - x0).max(1),
      (y1 - y0).max(1)
    );
    let mut under = Vec::new();
    let mut over = Vec::new();
    for (i, e) in effects.iter().enumerate() {
      let c = color::parse(&e.color).unwrap_or(color::Rgba::BLACK);
      let flood = format!("flood-color=\"{}\" flood-opacity=\"{}\"", c.hex6(), fmt(c.a));
      match e.kind {
        EffectType::DropShadow => {
          let r = format!("ds{i}");
          let spread = if e.spread > 0.0 {
            format!(
              "<feMorphology in=\"SourceAlpha\" operator=\"dilate\" radius=\"{}\" result=\"{r}a\"/>",
              fmt(e.spread)
            )
          } else {
            format!("<feOffset in=\"SourceAlpha\" dx=\"0\" dy=\"0\" result=\"{r}a\"/>")
          };
          f.push_str(&format!(
            "{spread}<feGaussianBlur in=\"{r}a\" stdDeviation=\"{}\" result=\"{r}b\"/><feOffset in=\"{r}b\" dx=\"{}\" dy=\"{}\" result=\"{r}c\"/><feFlood {flood}/><feComposite in2=\"{r}c\" operator=\"in\" result=\"{r}\"/>",
            fmt(e.blur / 2.0),
            fmt(e.x),
            fmt(e.y)
          ));
          under.push(r);
        }
        EffectType::InnerShadow => {
          let r = format!("is{i}");
          f.push_str(&format!(
            "<feFlood {flood} result=\"{r}f\"/><feComposite in=\"{r}f\" in2=\"SourceAlpha\" operator=\"out\" result=\"{r}a\"/><feOffset in=\"{r}a\" dx=\"{}\" dy=\"{}\" result=\"{r}b\"/><feGaussianBlur in=\"{r}b\" stdDeviation=\"{}\" result=\"{r}c\"/><feComposite in=\"{r}c\" in2=\"SourceAlpha\" operator=\"in\" result=\"{r}\"/>",
            fmt(e.x),
            fmt(e.y),
            fmt(e.blur / 2.0)
          ));
          over.push(r);
        }
        _ => {}
      }
    }
    f.push_str("<feMerge result=\"merged\">");
    for r in &under {
      f.push_str(&format!("<feMergeNode in=\"{r}\"/>"));
    }
    f.push_str("<feMergeNode in=\"SourceGraphic\"/>");
    for r in &over {
      f.push_str(&format!("<feMergeNode in=\"{r}\"/>"));
    }
    f.push_str("</feMerge>");
    if let Some(blur) = effects.iter().find(|e| e.kind == EffectType::LayerBlur) {
      f.push_str(&format!(
        "<feGaussianBlur in=\"merged\" stdDeviation=\"{}\"/>",
        fmt(blur.blur / 2.0)
      ));
    }
    f.push_str("</filter>");
    self.defs.push_str(&f);
    Some(fid)
  }

  fn text(&mut self, n: &Node) -> String {
    let Some(t) = n.text.as_ref() else { return String::new() };
    let lay = layout_of_node(n, t, self.m);
    let fill = n
      .fills
      .iter()
      .find(|p| p.visible())
      .map(|p| self.paint(p, n.width, n.height))
      .unwrap_or_else(|| "none".into());
    let lh = lay.line_height;
    let offset = match t.align_v {
      TextAlignV::Top => 0.0,
      TextAlignV::Middle => (n.height - lay.height) / 2.0,
      TextAlignV::Bottom => n.height - lay.height,
    };
    let (x, anchor) = match t.align_h {
      TextAlignH::Left | TextAlignH::Justify => (0.0, "start"),
      TextAlignH::Center => (n.width / 2.0, "middle"),
      TextAlignH::Right => (n.width, "end"),
    };
    let deco = match t.decoration {
      TextDecoration::None => "",
      TextDecoration::Underline => " text-decoration=\"underline\"",
      TextDecoration::Strikethrough => " text-decoration=\"line-through\"",
    };
    let lod_size = self.lod_size(t, &lay);
    let lod = lod_size.map(|s| format!(" class=\"s{s}\"")).unwrap_or_default();
    let mut out = format!(
      "<text{lod} fill=\"{fill}\" font-family=\"{}\" font-size=\"{}\" font-weight=\"{}\"{}{} text-anchor=\"{anchor}\" dominant-baseline=\"central\"{deco} style=\"white-space:pre\">",
      esc(&font_stack(&t.font_family)),
      fmt(t.font_size),
      t.font_weight,
      if t.italic { " font-style=\"italic\"" } else { "" },
      if t.letter_spacing != 0.0 { format!(" letter-spacing=\"{}\"", fmt(t.letter_spacing)) } else { String::new() },
    );
    let _ = lh;
    let base = SpanStyle::base(t);
    let mut bars = String::new();
    for line in &lay.lines {
      let top = offset + line.top;
      if self.opts.mode == Mode::Canvas {
        bars.push_str(&greek_bar(line, base.size, top, n.width, t.align_h));
      }
      let mixed_size = line.segments.iter().any(|sg| sg.style.size != base.size);
      if mixed_size {
        // Mixed sizes share an alphabetic baseline (central would centre each span).
        let max = line.segments.iter().map(|sg| sg.style.size).fold(0.0, f64::max);
        let y = top + line.height / 2.0 + 0.35 * max;
        out.push_str(&format!(
          "<tspan x=\"{}\" y=\"{}\" dominant-baseline=\"alphabetic\">",
          fmt(x),
          fmt(y)
        ));
      } else {
        out.push_str(&format!("<tspan x=\"{}\" y=\"{}\">", fmt(x), fmt(top + line.height / 2.0)));
      }
      for sg in &line.segments {
        let attrs = span_attrs(&sg.style, &base, |c| color::css_with_opacity(c, 1.0));
        if attrs.is_empty() {
          out.push_str(&esc(&sg.text));
        } else {
          out.push_str(&format!("<tspan{attrs}>{}</tspan>", esc(&sg.text)));
        }
      }
      out.push_str("</tspan>");
    }
    out.push_str("</text>");
    if let (Some(size), false) = (lod_size, bars.is_empty() || fill == "none") {
      out.push_str(&format!(
        "<path class=\"gk g{size}\" d=\"{bars}\" fill=\"{fill}\" fill-opacity=\"0.5\"/>"
      ));
    }
    out
  }

  /// Canvas only: the text's size class (see `TEXT_SIZE_STEPS`), so the editor can hide text too
  /// small to read, and show its `greek_bar`s, by switching one class on the canvas.
  fn lod_size(&self, t: &model::TextProps, lay: &crate::text::TextLayout) -> Option<u32> {
    if self.opts.mode != Mode::Canvas {
      return None;
    }
    let size = lay
      .lines
      .iter()
      .flat_map(|l| l.segments.iter().map(|sg| sg.style.size))
      .fold(t.font_size, f64::max);
    let steps = &TEXT_SIZE_STEPS;
    Some(
      steps
        .iter()
        .copied()
        .find(|&s| f64::from(s) >= size)
        .unwrap_or(steps[steps.len() - 1]),
    )
  }
}

/// A bar standing in for one line of text, as path data (empty for a blank line).
fn greek_bar(line: &crate::text::TextLine, base_size: f64, top: f64, width: f64, align: TextAlignH) -> String {
  if line.text.trim().is_empty() || line.width <= 0.0 {
    return String::new();
  }
  let size = line.segments.iter().map(|sg| sg.style.size).fold(base_size, f64::max);
  let x = match align {
    TextAlignH::Left | TextAlignH::Justify => 0.0,
    TextAlignH::Center => (width - line.width) / 2.0,
    TextAlignH::Right => width - line.width,
  };
  let h = (size * 0.5).max(1.0);
  format!(
    "M{} {}h{}v{}h{}z",
    fmt(x),
    fmt(top + line.height / 2.0 - h / 2.0),
    fmt(line.width),
    fmt(h),
    fmt(-line.width)
  )
}

/// SVG attributes for the parts of a span style that differ from the base.
fn span_attrs(s: &SpanStyle, base: &SpanStyle, color: impl Fn(&str) -> String) -> String {
  let mut a = String::new();
  if s.family != base.family {
    a.push_str(&format!(" font-family=\"{}\"", esc(&font_stack(&s.family))));
  }
  if s.size != base.size {
    a.push_str(&format!(" font-size=\"{}\"", fmt(s.size)));
  }
  if s.weight != base.weight {
    a.push_str(&format!(" font-weight=\"{}\"", s.weight));
  }
  if s.italic != base.italic {
    a.push_str(if s.italic {
      " font-style=\"italic\""
    } else {
      " font-style=\"normal\""
    });
  }
  if s.letter_spacing != base.letter_spacing {
    a.push_str(&format!(" letter-spacing=\"{}\"", fmt(s.letter_spacing)));
  }
  // One decoration per span, written once (a repeated attribute makes the SVG invalid). A
  // decoration the range sets (even "none") wins; a link only underlines a span that has none.
  let deco = if s.decoration == TextDecoration::None && !s.own_decoration && s.link.as_deref().and_then(crate::model::safe_link).is_some() {
    TextDecoration::Underline
  } else {
    s.decoration
  };
  if deco != base.decoration {
    a.push_str(match deco {
      TextDecoration::None => " text-decoration=\"none\"",
      TextDecoration::Underline => " text-decoration=\"underline\"",
      TextDecoration::Strikethrough => " text-decoration=\"line-through\"",
    });
  }
  if let Some(c) = &s.color {
    a.push_str(&format!(" fill=\"{}\"", color(c)));
  }
  a
}

fn is_closed(n: &Node) -> bool {
  n.vector
    .as_ref()
    .map(|v| v.raw.is_some() || v.subpaths.iter().all(|s| s.closed))
    .unwrap_or(false)
}

fn linecap(n: &Node) -> &'static str {
  match n.shape.as_ref().map(|s| s.end_cap) {
    Some(StrokeCap::Round) => "round",
    Some(StrokeCap::Square) => "square",
    _ => "round",
  }
}

fn geo_el(geo: &Geo, fill: &str) -> String {
  let fill_attr = if fill.is_empty() {
    String::new()
  } else {
    format!(" fill=\"{fill}\"")
  };
  match geo {
    Geo::Rect { w, h, r } => {
      if r.iter().all(|v| *v == r[0]) {
        let rx = if r[0] > 0.0 {
          format!(" rx=\"{}\"", fmt(r[0]))
        } else {
          String::new()
        };
        format!(
          "<rect width=\"{}\" height=\"{}\"{rx}{fill_attr}/>",
          fmt(w.max(0.0)),
          fmt(h.max(0.0))
        )
      } else {
        format!("<path d=\"{}\"{fill_attr}/>", shapes::rounded_rect_path(*w, *h, *r, 0.0))
      }
    }
    Geo::Ellipse { w, h } => format!(
      "<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\"{fill_attr}/>",
      fmt(w / 2.0),
      fmt(h / 2.0),
      fmt((w / 2.0).max(0.0)),
      fmt((h / 2.0).max(0.0))
    ),
    Geo::Path { d } => format!("<path d=\"{}\"{fill_attr}/>", esc(d)),
    Geo::Raw { d, transform, rule } => format!("<path d=\"{}\" transform=\"{transform}\" fill-rule=\"{rule}\"{fill_attr}/>", esc(d)),
    Geo::Line { w } => format!("<line x1=\"0\" y1=\"0\" x2=\"{}\" y2=\"0\"{fill_attr}/>", fmt(*w)),
  }
}

fn geo_el_stroke(geo: &Geo, stroke_attrs: &str) -> String {
  match geo {
    Geo::Raw { d, transform, .. } => format!(
      "<path d=\"{}\" transform=\"{transform}\" vector-effect=\"non-scaling-stroke\"{stroke_attrs}/>",
      esc(d)
    ),
    _ => geo_el(geo, "").replace("/>", &format!("{stroke_attrs}/>")),
  }
}

fn stops_svg(stops: &[model::GradientStop], opacity: f64) -> String {
  stops
    .iter()
    .map(|s| {
      let c = color::parse(&s.color).unwrap_or(color::Rgba::BLACK);
      format!(
        "<stop offset=\"{}\" stop-color=\"{}\" stop-opacity=\"{}\"/>",
        fmt(s.position),
        c.hex6(),
        fmt(c.a * opacity)
      )
    })
    .collect()
}

pub fn font_stack(family: &str) -> String {
  let fallback = if family.to_lowercase().contains("mono") {
    "monospace"
  } else if family.contains("Playfair") {
    "serif"
  } else {
    "sans-serif"
  };
  format!("'{family}', {fallback}")
}

pub fn esc(s: &str) -> String {
  s.replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::text::HeuristicMeasurer;

  #[test]
  fn renders_frame_with_child_and_effects() {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut f = crate::ops::default_node(NodeType::Frame, "f".into(), "Frame".into());
    f.effects.push(Effect::default());
    doc.insert(f, None, &page, None);
    let mut t = crate::ops::default_node(NodeType::Text, "t".into(), "T".into());
    t.text.as_mut().unwrap().characters = "Hi <b>".into();
    doc.insert(t, Some("f"), &page, None);
    let svg = render_page(
      &doc,
      &page,
      &HeuristicMeasurer,
      RenderOptions {
        mode: Mode::Canvas,
        hidden: &[],
      },
    );
    assert!(svg.contains("data-id=\"f\""));
    assert!(svg.contains("clip-path"));
    assert!(svg.contains("Hi &lt;b&gt;"));
    assert!(svg.contains("<filter"));
    let out = export_svg(&doc, "f", &HeuristicMeasurer);
    assert!(out.starts_with("<svg"));
    assert!(!out.contains("data-id"));
  }

  #[test]
  fn text_shows_links_paragraph_spacing_and_truncation() {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut t = crate::ops::default_node(NodeType::Text, "t".into(), "T".into());
    {
      let p = t.text.as_mut().unwrap();
      p.characters = "Go here\nThen there and back again to the very start".into();
      p.paragraph_spacing = 10.0;
      p.runs = vec![
        crate::model::TextRun {
          start: 3,
          end: 7,
          link: Some("https://example.com".into()),
          ..Default::default()
        },
        crate::model::TextRun {
          start: 13,
          end: 18,
          link: Some("javascript:alert(1)".into()),
          ..Default::default()
        },
      ];
    }
    t.width = 120.0;
    doc.insert(t, None, &page, None);
    let render = |doc: &Document| {
      render_page(
        doc,
        &page,
        &HeuristicMeasurer,
        RenderOptions {
          mode: Mode::Canvas,
          hidden: &[],
        },
      )
    };
    crate::layout::relayout_all(&mut doc, &HeuristicMeasurer);
    let svg = render(&doc);
    // Only the safe link is underlined; the canvas never makes it a clickable anchor.
    assert_eq!(svg.matches("text-decoration=\"underline\"").count(), 1, "{svg}");
    assert!(!svg.contains("<a ") && !svg.contains("javascript"));
    // The second paragraph starts one line plus the spacing below the first.
    let lh = 16.0 * 1.2;
    assert!(svg.contains(&format!("y=\"{}\"", fmt(lh / 2.0))), "{svg}");
    assert!(svg.contains(&format!("y=\"{}\"", fmt(lh + 10.0 + lh / 2.0))), "{svg}");
    assert!(!svg.contains('\u{2026}'));
    doc.get_mut("t").unwrap().text.as_mut().unwrap().max_lines = Some(1);
    crate::layout::relayout_all(&mut doc, &HeuristicMeasurer);
    let svg = render(&doc);
    assert!(svg.contains('\u{2026}'), "{svg}");
  }

  #[test]
  fn exported_text_never_repeats_an_attribute() {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut t = crate::ops::default_node(NodeType::Text, "t".into(), "T".into());
    {
      let p = t.text.as_mut().unwrap();
      p.characters = "Underlined with a link and struck link".into();
      p.decoration = crate::model::TextDecoration::Underline;
      p.runs = vec![
        // Explicit "none" on a link range: one attribute, the explicit one's underline-for-link wins over none.
        crate::model::TextRun {
          start: 16,
          end: 20,
          decoration: Some(crate::model::TextDecoration::None),
          link: Some("https://example.com".into()),
          ..Default::default()
        },
        crate::model::TextRun {
          start: 31,
          end: 37,
          decoration: Some(crate::model::TextDecoration::Strikethrough),
          link: Some("https://example.com".into()),
          ..Default::default()
        },
      ];
    }
    doc.insert(t, None, &page, None);
    let svg = export_svg(&doc, "t", &HeuristicMeasurer);
    // No tag may carry the same attribute twice (browsers reject the whole SVG).
    for tag in svg.split('<').skip(1) {
      let tag = tag.split('>').next().unwrap();
      let mut seen = std::collections::HashSet::new();
      for attr in tag.split(' ').filter_map(|a| a.split_once("=\"").map(|(k, _)| k)) {
        assert!(seen.insert(attr), "{attr} repeated in <{tag}>");
      }
    }
    // The struck link keeps its strike-through; an explicit "none" on a link removes the
    // underline the text has, and it is written once.
    assert!(svg.contains("text-decoration=\"line-through\""), "{svg}");
    assert_eq!(svg.matches("text-decoration=\"none\"").count(), 1, "{svg}");
    // On plain text a link underlines itself, unless its range says "none".
    {
      let p = doc.get_mut("t").unwrap().text.as_mut().unwrap();
      p.decoration = crate::model::TextDecoration::None;
    }
    let svg = export_svg(&doc, "t", &HeuristicMeasurer);
    assert!(!svg.contains("text-decoration=\"none\""), "already none: nothing to write: {svg}");
    assert_eq!(svg.matches("text-decoration=\"line-through\"").count(), 1, "{svg}");
    assert!(!svg.contains("underline"), "the explicit none link isn't underlined: {svg}");
    doc.get_mut("t").unwrap().text.as_mut().unwrap().runs[0].decoration = None;
    let svg = export_svg(&doc, "t", &HeuristicMeasurer);
    assert_eq!(
      svg.matches("text-decoration=\"underline\"").count(),
      1,
      "a plain link underlines: {svg}"
    );
  }

  #[test]
  fn canvas_text_carries_a_size_class_and_greek_bars_that_export_leaves_out() {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut t = crate::ops::default_node(NodeType::Text, "t".into(), "T".into());
    {
      let p = t.text.as_mut().unwrap();
      p.characters = "Hello\n\nworld".into();
      p.font_size = 13.2;
    }
    doc.insert(t, None, &page, None);
    crate::layout::relayout_all(&mut doc, &HeuristicMeasurer);
    let opts = |mode| RenderOptions { mode, hidden: &[] };
    let svg = render_root(&doc, "t", &HeuristicMeasurer, opts(Mode::Canvas));
    assert!(svg.contains("<text class=\"s16\""), "size 13.2 is in the 16 class: {svg}");
    let path = svg
      .split("<path class=\"gk g16\" d=\"")
      .nth(1)
      .expect("greek bars")
      .split('"')
      .next()
      .unwrap();
    assert_eq!(path.matches('M').count(), 2, "one bar per non-blank line: {path}");
    let out = export_svg(&doc, "t", &HeuristicMeasurer);
    assert!(!out.contains("class=") && !out.contains("<path"), "export is unchanged: {out}");
  }

  #[test]
  fn render_bounds_cover_strokes_shadows_and_blur() {
    let (mut doc, _) = doc_with_rect(100.0, 100.0, 100.0, 60.0);
    // No decoration: exactly the geometry.
    let b = render_bounds(&doc, "r", &HeuristicMeasurer);
    assert_eq!((b.x, b.y, b.width, b.height), (100.0, 100.0, 100.0, 60.0));
    // Inside stroke adds nothing, centre adds w/2, outside adds w.
    edit(&mut doc, |n| {
      n.strokes = vec![Paint::Solid {
        color: "#000".into(),
        opacity: 1.0,
        visible: true,
      }];
      n.stroke_weight = 10.0;
    });
    assert_eq!(render_bounds(&doc, "r", &HeuristicMeasurer).width, 100.0);
    edit(&mut doc, |n| n.stroke_align = StrokeAlign::Center);
    let b = render_bounds(&doc, "r", &HeuristicMeasurer);
    assert_eq!((b.x, b.width, b.height), (95.0, 110.0, 70.0));
    edit(&mut doc, |n| n.stroke_align = StrokeAlign::Outside);
    let b = render_bounds(&doc, "r", &HeuristicMeasurer);
    assert_eq!((b.x, b.y, b.width, b.height), (90.0, 90.0, 120.0, 80.0));
    // Drop shadow: offset +/- (1.5 x blur + spread), per side.
    edit(&mut doc, |n| {
      n.stroke_weight = 0.0;
      n.effects = vec![shadow(0.0, 12.0, 20.0)];
    });
    let b = render_bounds(&doc, "r", &HeuristicMeasurer);
    assert_eq!((b.x, b.y, b.width, b.height), (70.0, 82.0, 160.0, 120.0));
    // Layer blur reaches 1.5x its radius on every side.
    edit(&mut doc, |n| {
      n.effects = vec![Effect {
        kind: EffectType::LayerBlur,
        blur: 10.0,
        ..Effect::default()
      }];
    });
    let b = render_bounds(&doc, "r", &HeuristicMeasurer);
    assert_eq!((b.x, b.y, b.width, b.height), (85.0, 85.0, 130.0, 90.0));
    // Hidden effects and inner shadows add nothing.
    edit(&mut doc, |n| {
      n.effects = vec![
        Effect {
          visible: false,
          blur: 40.0,
          ..Effect::default()
        },
        Effect {
          kind: EffectType::InnerShadow,
          blur: 40.0,
          ..Effect::default()
        },
      ];
    });
    assert_eq!(render_bounds(&doc, "r", &HeuristicMeasurer).width, 100.0);
  }

  #[test]
  fn render_bounds_union_children_unless_clipped() {
    let (mut doc, page) = doc_with_rect(500.0, 500.0, 10.0, 10.0);
    let mut f = crate::ops::default_node(NodeType::Frame, "f".into(), "F".into());
    f.width = 100.0;
    f.height = 100.0;
    f.clip_content = false;
    doc.insert(f, None, &page, None);
    let mut c = crate::ops::default_node(NodeType::Rectangle, "c".into(), "C".into());
    c.x = 80.0;
    c.y = 80.0;
    c.width = 50.0;
    c.height = 50.0;
    c.effects = vec![shadow(0.0, 0.0, 10.0)];
    doc.insert(c, Some("f"), &page, None);
    let b = render_bounds(&doc, "f", &HeuristicMeasurer);
    assert_eq!((b.x, b.y, b.right(), b.bottom()), (0.0, 0.0, 145.0, 145.0));
    edit_id(&mut doc, "f", |n| n.clip_content = true);
    let b = render_bounds(&doc, "f", &HeuristicMeasurer);
    assert_eq!((b.right(), b.bottom()), (100.0, 100.0));
  }

  #[test]
  fn render_bounds_follow_rotation_and_size_the_export() {
    let (mut doc, _) = doc_with_rect(50.0, 50.0, 100.0, 40.0);
    edit(&mut doc, |n| {
      n.rotation = 90.0;
      n.effects = vec![shadow(0.0, 0.0, 10.0)];
    });
    // The rotated box is 40x100 around the same centre, plus 15 (1.5 x blur) on every side.
    let b = render_bounds(&doc, "r", &HeuristicMeasurer);
    assert!((b.width - 70.0).abs() < 1e-6 && (b.height - 130.0).abs() < 1e-6, "{b:?}");
    let svg = export_svg(&doc, "r", &HeuristicMeasurer);
    assert!(svg.contains("width=\"70\" height=\"130\""), "{svg}");
    let tight = export_svg_geometry(&doc, "r", &HeuristicMeasurer);
    assert!(tight.contains("width=\"40\" height=\"100\""), "{tight}");
    // The filter region is explicit so it can't clip what the export makes room for.
    assert!(svg.contains("filterUnits=\"userSpaceOnUse\""));
  }

  #[test]
  fn filter_region_leaves_room_for_inner_shadows() {
    let (mut doc, _) = doc_with_rect(0.0, 0.0, 100.0, 60.0);
    edit(&mut doc, |n| {
      n.effects = vec![Effect {
        kind: EffectType::InnerShadow,
        x: 0.0,
        y: 6.0,
        blur: 12.0,
        ..Effect::default()
      }];
    });
    // The export crop is unchanged: inner shadows paint inside the shape.
    assert_eq!(render_bounds(&doc, "r", &HeuristicMeasurer).width, 100.0);
    // The filter needs transparent margin of offset + 1.5 * blur on every side.
    let fr = filter_region(&doc, &HeuristicMeasurer, &mut HashMap::new(), doc.get("r").unwrap());
    assert_eq!((fr.x, fr.y, fr.width, fr.height), (-24.0, -24.0, 148.0, 108.0));
    let svg = export_svg(&doc, "r", &HeuristicMeasurer);
    assert!(svg.contains("x=\"-24\" y=\"-24\" width=\"148\" height=\"108\""), "{svg}");
  }

  #[test]
  fn shadow_filter_region_covers_the_blur_tail() {
    let (mut doc, _) = doc_with_rect(100.0, 100.0, 100.0, 60.0);
    edit(&mut doc, |n| n.effects = vec![shadow(0.0, 12.0, 20.0)]);
    let fr = filter_region(&doc, &HeuristicMeasurer, &mut HashMap::new(), doc.get("r").unwrap());
    // Offset 12 down: the blur (3 sigma = 30) reaches 18 above the shape and 42 below it.
    assert!(-fr.y >= 18.0 && fr.bottom() - 60.0 >= 42.0, "{fr:?}");
    assert!(-fr.x >= 30.0 && fr.right() - 100.0 >= 30.0, "{fr:?}");
  }

  #[test]
  fn text_that_overflows_its_box_is_inside_the_filter_region() {
    let (mut doc, page) = doc_with_rect(500.0, 500.0, 10.0, 10.0);
    let mut t = crate::ops::default_node(NodeType::Text, "t".into(), "T".into());
    t.width = 90.0;
    t.height = 24.0;
    {
      let props = t.text.as_mut().unwrap();
      props.characters = "line one line two line three line four line five line six".into();
      props.auto_resize = crate::model::TextAutoResize::None;
    }
    t.effects = vec![shadow(2.0, 2.0, 2.0)];
    doc.insert(t, None, &page, None);
    let b = render_bounds(&doc, "t", &HeuristicMeasurer);
    assert!(b.height > 24.0 + 4.0 * 16.0, "{b:?}");
    let fr = filter_region(&doc, &HeuristicMeasurer, &mut HashMap::new(), doc.get("t").unwrap());
    assert!(fr.bottom() > 24.0 + 4.0 * 16.0, "{fr:?}");
  }

  #[test]
  fn a_mask_crops_the_siblings_above_it() {
    let (mut doc, page) = doc_with_rect(500.0, 500.0, 10.0, 10.0);
    let mut g = crate::ops::default_node(NodeType::Group, "g".into(), "G".into());
    g.x = 100.0;
    g.y = 100.0;
    g.width = 160.0;
    g.height = 140.0;
    doc.insert(g, None, &page, None);
    let mut mask = crate::ops::default_node(NodeType::Rectangle, "mk".into(), "Mask".into());
    mask.x = 30.0;
    mask.y = 20.0;
    mask.width = 80.0;
    mask.height = 80.0;
    mask.is_mask = true;
    doc.insert(mask, Some("g"), &page, None);
    let mut c = crate::ops::default_node(NodeType::Rectangle, "c".into(), "C".into());
    c.width = 160.0;
    c.height = 140.0;
    c.effects = vec![shadow(-10.0, -10.0, 10.0)];
    doc.insert(c, Some("g"), &page, None);
    let b = render_bounds(&doc, "g", &HeuristicMeasurer);
    assert_eq!((b.x, b.y, b.width, b.height), (130.0, 120.0, 80.0, 80.0));
  }

  fn doc_with_rect(x: f64, y: f64, w: f64, h: f64) -> (Document, String) {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut r = crate::ops::default_node(NodeType::Rectangle, "r".into(), "R".into());
    r.x = x;
    r.y = y;
    r.width = w;
    r.height = h;
    r.fills.clear();
    r.strokes.clear();
    r.stroke_weight = 0.0;
    doc.insert(r, None, &page, None);
    (doc, page)
  }

  fn edit(doc: &mut Document, f: impl FnOnce(&mut Node)) {
    edit_id(doc, "r", f);
  }

  fn edit_id(doc: &mut Document, id: &str, f: impl FnOnce(&mut Node)) {
    f(doc.get_mut(id).unwrap());
  }

  fn shadow(x: f64, y: f64, blur: f64) -> Effect {
    Effect {
      x,
      y,
      blur,
      spread: 0.0,
      ..Effect::default()
    }
  }
}
