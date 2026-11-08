//! SVG renderer. The same code paints the editor canvas (with `data-id`
//! hooks) and produces exported SVG, so what you see is what you export.

use std::collections::HashMap;

use crate::geom::{fmt, Mat, Point, Rect};
use crate::model::{
  Document, Effect, EffectType, Node, NodeId, NodeType, Paint, StrokeAlign, StrokeCap, StrokeJoin, TextAlignH, TextAlignV, TextDecoration,
};
use crate::text::{layout_of_node, SpanStyle, TextMeasurer};
use crate::{color, model};
use crate::{paint, shapes};

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
  /// The text layer being edited: drawn live with all its lines (no line limit).
  pub editing: Option<&'a str>,
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
  /// Where a background blur's walk stops: the exported layer (`None`: the top-level layer).
  /// The flag says whether that layer's own fills are part of what lies below.
  stop: Option<(NodeId, bool)>,
  /// Above 0 while a background blur's copy of the content below is being painted: no canvas
  /// hooks, no text bars, no nested blur.
  backdrop: u32,
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
    stop: None,
    backdrop: 0,
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
    stop: None,
    backdrop: 0,
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
  export_svg_in(doc, id, m, render_bounds(doc, id, m), &[])
}

/// An SVG with its page-space crop.
pub struct SvgCrop {
  pub svg: String,
  pub bounds: Rect,
}

/// The prototype player's pieces of a screen. `hidden` layers are left out, with what is inside them.
/// With `children_only` only the node's children are drawn (not its own fills, strokes or
/// effects, and not clipped), cropped to what they paint, so a scrolling frame's content can
/// be placed inside a scroller of its own. Otherwise this is `export_svg` with `hidden`.
pub fn export_svg_parts(doc: &Document, id: &str, m: &dyn TextMeasurer, hidden: &[NodeId], children_only: bool) -> SvgCrop {
  if !children_only {
    let bounds = render_bounds(doc, id, m);
    return SvgCrop {
      svg: export_svg_in(doc, id, m, bounds, hidden),
      bounds,
    };
  }
  let Some(n) = doc.get(id) else {
    return SvgCrop {
      svg: String::new(),
      bounds: Rect::default(),
    };
  };
  let kids = n.children.iter().filter(|c| doc.get(c).is_some_and(|k| k.visible));
  let b = Rect::union_all(kids.map(|c| render_bounds(doc, c, m))).unwrap_or_else(|| doc.abs_bounds(id));
  let mut r = Renderer {
    doc,
    m,
    opts: RenderOptions {
      mode: Mode::Export,
      hidden,
      editing: None,
    },
    defs: String::new(),
    uid: 0,
    scope: export_scope(id, true, hidden),
    bounds: HashMap::new(),
    stop: Some((id.to_string(), false)),
    backdrop: 0,
  };
  let place = Mat::translate(-b.x, -b.y).mul(&doc.abs_matrix(id));
  let body = r.children(n);
  let svg = format!(
    "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\" fill=\"none\"><defs>{defs}</defs><g transform=\"{t}\">{body}</g></svg>",
    w = fmt(b.width.max(1.0)),
    h = fmt(b.height.max(1.0)),
    defs = r.defs,
    t = place.svg(),
  );
  SvgCrop { svg, bounds: b }
}

/// Like `export_svg` but cropped to the node's geometry only, so the size matches the layer
/// (code export embeds it in a box of that size).
pub fn export_svg_geometry(doc: &Document, id: &str, m: &dyn TextMeasurer) -> String {
  export_svg_in(doc, id, m, doc.abs_bounds(id), &[])
}

/// Page-space bounds of everything a node paints: its geometry plus outside/centre strokes
/// and line caps, drop shadows and layer blurs, and its descendants (unless it clips them).
pub fn render_bounds(doc: &Document, id: &str, m: &dyn TextMeasurer) -> Rect {
  let Some(n) = doc.get(id) else { return Rect::default() };
  let local = local_render_bounds(doc, m, &mut HashMap::new(), n);
  mat_bounds(&doc.abs_matrix(id), &local)
}

/// Deterministic def-id prefix for an export, so SVGs inlined into one page (player screens and
/// overlays, code-export vectors) never share ids. Differs per node, per `children_only` and per
/// set of hidden layers (the same node renders differently with them).
fn export_scope(id: &str, children_only: bool, hidden: &[NodeId]) -> String {
  let mut s = format!("x{}_", id.replace(|c: char| !c.is_ascii_alphanumeric(), ""));
  if children_only {
    s.push('k');
  }
  if !hidden.is_empty() {
    let mut h: u32 = 0x811c_9dc5;
    for b in hidden.iter().flat_map(|n| n.bytes().chain([0u8])) {
      h = (h ^ u32::from(b)).wrapping_mul(0x0100_0193);
    }
    s.push_str(&format!("h{h:x}"));
  }
  s
}

/// A layer's SVG in its parent's space: bounds from its own transform only. Code export uses it
/// for vectors, because the ancestors' rotation is applied by their own CSS transform.
pub fn export_svg_local(doc: &Document, id: &str, m: &dyn TextMeasurer) -> String {
  let Some(n) = doc.get(id) else { return String::new() };
  let b = doc.local_matrix(n).bounds_of(n.width, n.height);
  export_svg_with(doc, id, m, b, Mat::translate(-b.x, -b.y), &[])
}

/// A layer drawn in its own space (box 0,0,w,h, its own rotation and flip left out) for code
/// export, where the element's CSS transform applies them.
pub fn export_svg_own(doc: &Document, id: &str, m: &dyn TextMeasurer) -> String {
  let Some(n) = doc.get(id) else { return String::new() };
  let b = Rect::new(0.0, 0.0, n.width, n.height);
  export_svg_with(doc, id, m, b, doc.local_matrix(n).invert(), &[])
}

fn export_svg_in(doc: &Document, id: &str, m: &dyn TextMeasurer, b: Rect, hidden: &[NodeId]) -> String {
  export_svg_with(doc, id, m, b, Mat::translate(-b.x, -b.y).mul(&doc.parent_matrix(id)), hidden)
}

fn export_svg_with(doc: &Document, id: &str, m: &dyn TextMeasurer, b: Rect, place: Mat, hidden: &[NodeId]) -> String {
  let Some(n) = doc.get(id) else { return String::new() };
  let mut r = Renderer {
    doc,
    m,
    opts: RenderOptions {
      mode: Mode::Export,
      hidden,
      editing: None,
    },
    defs: String::new(),
    uid: 0,
    scope: export_scope(id, false, hidden),
    bounds: HashMap::new(),
    stop: Some((id.to_string(), true)),
    backdrop: 0,
  };
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
  let [sl, st, sr, sb] = stroke_margins(n);
  let own = match n.kind {
    NodeType::Text => {
      let b = text_box(n, m);
      Rect::new(b.x - sl, b.y - st, b.width + sl + sr, b.height + st + sb)
    }
    _ => Rect::new(-sl, -st, n.width + sl + sr, n.height + st + sb),
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

/// How far the visible strokes reach beyond the node's box: left, top, right, bottom.
fn stroke_margins(n: &Node) -> [f64; 4] {
  if let Some(weights) = per_side_weights(n) {
    if n.strokes.iter().any(|p| p.visible()) {
      return paint::ring_margins(weights, n.stroke_align).map(f64::ceil);
    }
    return [0.0; 4];
  }
  [stroke_margin(n); 4]
}

/// The per-side weights, when the node draws them (boxes only).
fn per_side_weights(n: &Node) -> Option<[f64; 4]> {
  let boxy = !matches!(
    n.kind,
    NodeType::Ellipse | NodeType::Polygon | NodeType::Star | NodeType::Line | NodeType::Vector | NodeType::Text | NodeType::Group
  );
  n.stroke_weights.filter(|_| boxy)
}

/// How far the visible strokes reach beyond the node's box.
fn stroke_margin(n: &Node) -> f64 {
  let sw = n.stroke_weight;
  if sw <= 0.0 || n.kind == NodeType::Group || !n.strokes.iter().any(|p| p.visible()) {
    return 0.0;
  }
  if n.kind == NodeType::Text {
    // Outside strokes are drawn at twice the weight, half of it under the glyphs; miters can't
    // spike because the joins are round.
    return match n.stroke_align {
      StrokeAlign::Inside => 0.0,
      StrokeAlign::Center => sw / 2.0,
      StrokeAlign::Outside => sw,
    }
    .ceil();
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
    if self.canvas() {
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
      // Exports leave hidden layers (and everything inside them) out; the canvas keeps them so
      // text being edited still measures.
      if self.opts.mode == Mode::Export || self.backdrop > 0 {
        return String::new();
      }
      attrs.push_str(" visibility=\"hidden\"");
    }
    if let Some(f) = self.effects_filter(n) {
      attrs.push_str(&format!(" filter=\"url(#{f})\""));
    }
    let backdrop = self.backdrop(n);
    let body = self.body(n);
    format!("<g{attrs}>{backdrop}{body}</g>")
  }

  /// Canvas markup with its editor hooks (not inside a background blur's copy).
  fn canvas(&self) -> bool {
    self.opts.mode == Mode::Canvas && self.backdrop == 0
  }

  /// A visible background blur: the content below the layer within the render root (the
  /// top-level layer on the canvas, the exported layer in an export), painted again in the
  /// layer's own space, blurred and clipped to its shape. Paints first, under the layer's fills.
  fn backdrop(&mut self, n: &'a Node) -> String {
    let eligible = n.kind.is_frame_like()
      || matches!(
        n.kind,
        NodeType::Rectangle | NodeType::Ellipse | NodeType::Polygon | NodeType::Star | NodeType::Vector
      );
    if self.backdrop > 0 || !eligible || n.width <= 0.0 || n.height <= 0.0 {
      return String::new();
    }
    let Some(blur) = n
      .effects
      .iter()
      .find(|e| e.visible && e.kind == EffectType::BackgroundBlur && e.blur > 0.0)
      .map(|e| e.blur)
    else {
      return String::new();
    };
    let path = self.doc.path(&n.id);
    let from = match &self.stop {
      Some((s, _)) => path.iter().position(|p| p == s),
      None => Some(0),
    };
    let Some(from) = from.filter(|f| path.len() - f >= 2) else {
      return String::new();
    };
    let sigma = blur / 2.0;
    let margin = 3.0 * sigma;
    let abs_n = self.doc.abs_matrix(&n.id);
    let inv_n = abs_n.invert();
    let cull = {
      let b = abs_n.bounds_of(n.width, n.height);
      Rect::new(b.x - margin, b.y - margin, b.width + 2.0 * margin, b.height + 2.0 * margin)
    };
    self.backdrop += 1;
    let doc = self.doc;
    let mut abs_a = doc.abs_matrix(&path[from]);
    let mut below = String::new();
    for i in from..path.len() - 1 {
      let Some(a) = doc.get(&path[i]) else { continue };
      if i > from {
        abs_a = abs_a.mul(&doc.local_matrix(a));
      }
      let own_fills = i > from || self.stop.as_ref().is_none_or(|(_, fills)| *fills);
      let upto = a.children.iter().position(|c| *c == path[i + 1]).unwrap_or(0);
      let mut kids: Vec<NodeId> = Vec::new();
      for c in &a.children[..upto] {
        let Some(k) = doc.get(c) else { continue };
        if !k.is_mask {
          let lb = local_render_bounds(doc, self.m, &mut self.bounds, k);
          if intersect(&mat_bounds(&abs_a.mul(&doc.local_matrix(k)), &lb), &cull).is_none() {
            continue;
          }
        }
        kids.push(c.clone());
      }
      let mut part = String::new();
      let geo = Geo::Rect {
        w: a.width,
        h: a.height,
        r: shapes::corner_radii(a),
      };
      if own_fills && a.kind.is_frame_like() {
        part.push_str(&self.fills(a, &geo));
      }
      let content = self.list(&kids);
      if a.kind.is_frame_like() && a.clip_content && !content.is_empty() {
        let cid = self.id("clip");
        self
          .defs
          .push_str(&format!("<clipPath id=\"{cid}\">{}</clipPath>", geo_el(&geo, "")));
        part.push_str(&format!("<g clip-path=\"url(#{cid})\">{content}</g>"));
      } else {
        part.push_str(&content);
      }
      if !part.is_empty() {
        let t = inv_n.mul(&abs_a);
        if t.is_identity() {
          below.push_str(&part);
        } else {
          below.push_str(&format!("<g transform=\"{}\">{part}</g>", t.svg()));
        }
      }
    }
    self.backdrop -= 1;
    if below.is_empty() {
      return String::new();
    }
    let geo = if n.kind.is_frame_like() {
      Geo::Rect {
        w: n.width,
        h: n.height,
        r: shapes::corner_radii(n),
      }
    } else {
      self.geometry(n)
    };
    let (cid, fid) = (self.id("bbc"), self.id("bbf"));
    self
      .defs
      .push_str(&format!("<clipPath id=\"{cid}\">{}</clipPath>", geo_el(&geo, "")));
    self.defs.push_str(&format!(
      "<filter id=\"{fid}\" filterUnits=\"userSpaceOnUse\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" color-interpolation-filters=\"sRGB\"><feGaussianBlur stdDeviation=\"{}\"/></filter>",
      fmt(-margin),
      fmt(-margin),
      fmt(n.width + 2.0 * margin),
      fmt(n.height + 2.0 * margin),
      fmt(sigma)
    ));
    let class = if self.opts.mode == Mode::Canvas { " class=\"dt-bb\"" } else { "" };
    format!("<g{class} clip-path=\"url(#{cid})\"><g filter=\"url(#{fid})\">{below}</g></g>")
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
        if let Some(fill) = self.single_fill_stroke(n, &geo) {
          return self.strokes_with(n, &geo, Some(&fill));
        }
        let mut out = self.fills(n, &geo);
        out.push_str(&self.strokes(n, &geo));
        out
      }
    }
  }

  /// The fill paint when `n` has exactly one visible fill and one visible centred stroke, so
  /// both can be written as one element (an SVG paints fill, then stroke: same pixels).
  fn single_fill_stroke(&mut self, n: &Node, geo: &Geo) -> Option<String> {
    if n.stroke_weight <= 0.0 || per_side_weights(n).is_some() {
      return None;
    }
    let mut fills = n.fills.iter().filter(|p| p.visible());
    let mut strokes = n.strokes.iter().filter(|p| p.visible());
    let fill = fills.next()?;
    strokes.next()?;
    if fills.next().is_some() || strokes.next().is_some() {
      return None;
    }
    let open_vector = n.kind == NodeType::Vector && !is_closed(n);
    let centred = match geo {
      Geo::Rect { .. } | Geo::Ellipse { .. } => n.stroke_align == StrokeAlign::Center,
      Geo::Path { .. } => n.stroke_align == StrokeAlign::Center || open_vector,
      _ => false,
    };
    centred.then(|| self.paint(fill, n.width, n.height, 0.0))
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
      let paint = self.paint(p, n.width, n.height, 0.0);
      out.push_str(&geo_el(geo, &paint));
    }
    out
  }

  fn strokes(&mut self, n: &Node, geo: &Geo) -> String {
    self.strokes_with(n, geo, None)
  }

  /// `merged_fill` is the fill paint drawn by the same element (see `single_fill_stroke`).
  fn strokes_with(&mut self, n: &Node, geo: &Geo, merged_fill: Option<&str>) -> String {
    if let (Some(weights), Geo::Rect { w, h, r }) = (per_side_weights(n), geo) {
      return self.side_strokes(n, weights, paint::ring_path(*w, *h, weights, n.stroke_align, *r));
    }
    if n.stroke_weight <= 0.0 {
      return String::new();
    }
    let mut out = String::new();
    let sw = n.stroke_weight;
    let join = n
      .stroke_join
      .map_or(String::new(), |j| format!(" stroke-linejoin=\"{}\"", join_name(j)));
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
      let paint = self.paint(p, n.width, n.height, sw);
      let stroke = format!(" fill=\"{}\" stroke=\"{paint}\"{dash}", merged_fill.unwrap_or("none"));
      let el = match (geo, n.stroke_align) {
        (Geo::Rect { w, h, r }, StrokeAlign::Inside) => {
          format!(
            "<path d=\"{}\" stroke-width=\"{}\"{stroke}{join}/>",
            shapes::rounded_rect_path(*w, *h, *r, sw / 2.0),
            fmt(sw)
          )
        }
        (Geo::Rect { w, h, r }, StrokeAlign::Outside) => {
          format!(
            "<path d=\"{}\" stroke-width=\"{}\"{stroke}{join}/>",
            shapes::rounded_rect_path(*w, *h, *r, -sw / 2.0),
            fmt(sw)
          )
        }
        (Geo::Ellipse { w, h }, align) if align != StrokeAlign::Center => {
          let off = if align == StrokeAlign::Inside { sw / 2.0 } else { -sw / 2.0 };
          format!(
            "<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" stroke-width=\"{}\"{stroke}{join}/>",
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
            geo_el_stroke(geo, &format!(" stroke-width=\"{}\"{stroke}{join}", fmt(sw * 2.0)))
          )
        }
        _ => geo_el_stroke(
          geo,
          &format!(
            " stroke-width=\"{}\" stroke-linecap=\"{}\" stroke-linejoin=\"{}\"{stroke}{caps}",
            fmt(sw),
            linecap(n),
            n.stroke_join.map_or("round", join_name)
          ),
        ),
      };
      out.push_str(&el);
    }
    out
  }

  /// Per-side strokes: one filled ring per visible stroke paint.
  fn side_strokes(&mut self, n: &Node, weights: [f64; 4], ring: String) -> String {
    let pad = weights.iter().cloned().fold(0.0_f64, f64::max);
    if pad <= 0.0 {
      return String::new();
    }
    let mut out = String::new();
    for p in n.strokes.iter().filter(|p| p.visible()) {
      let paint = self.paint(p, n.width, n.height, pad);
      out.push_str(&format!("<path d=\"{ring}\" fill=\"{paint}\" fill-rule=\"evenodd\"/>"));
    }
    out
  }

  fn line_caps(&mut self, n: &Node) -> String {
    let Some(shape) = n.shape.as_ref() else { return String::new() };
    // Closed and imported raw paths have no ends to mark.
    if !matches!(n.kind, NodeType::Line | NodeType::Vector) || is_closed(n) {
      return String::new();
    }
    let (color, opacity) = marker_paint(n);
    let mut out = String::new();
    for (cap, attr) in [(shape.start_cap, "marker-start"), (shape.end_cap, "marker-end")] {
      let flat = body_cap(n);
      let shape_el = match cap {
        StrokeCap::Round | StrokeCap::Square if cap != flat => {
          // One unit is the stroke width (markerUnits), so the end is sized to the stroke.
          let mid = self.id("mk");
          let fill = color::css_with_opacity(&color, opacity);
          // Only the half beyond the end (+x in the marker), so the stroke is not painted twice.
          let shape = if cap == StrokeCap::Round {
            format!("<path d=\"M0 0A0.5 0.5 0 0 1 0 1Z\" fill=\"{fill}\"/>")
          } else {
            format!("<rect width=\"0.5\" height=\"1\" fill=\"{fill}\"/>")
          };
          self.defs.push_str(&format!(
            "<marker id=\"{mid}\" viewBox=\"0 0 0.5 1\" refX=\"0\" refY=\"0.5\" markerWidth=\"0.5\" markerHeight=\"1\" markerUnits=\"strokeWidth\" orient=\"auto-start-reverse\">{shape}</marker>"
          ));
          out.push_str(&format!(" {attr}=\"url(#{mid})\""));
          continue;
        }
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
          color::css_with_opacity(&color, opacity),
          if cap == StrokeCap::Circle {
            format!("fill=\"{}\"", color::css_with_opacity(&color, opacity))
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

  /// Returns an SVG paint value, registering gradient/pattern defs as needed. `pad` is how far
  /// past the box the paint is used (strokes), for the paints that are patterns.
  fn paint(&mut self, p: &Paint, w: f64, h: f64, pad: f64) -> String {
    match p {
      Paint::Solid { color, opacity, .. } => color::css_with_opacity(color, *opacity),
      Paint::LinearGradient {
        stops,
        opacity,
        handles: Some(hd),
        ..
      } => {
        let gid = self.id("lg");
        self.defs.push_str(&paint::linear_def(&gid, stops, *opacity, hd, w, h));
        format!("url(#{gid})")
      }
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
      Paint::RadialGradient {
        stops,
        opacity,
        handles: Some(hd),
        ..
      } => {
        let gid = self.id("rg");
        self.defs.push_str(&paint::radial_def(&gid, stops, *opacity, hd, w, h));
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
      Paint::AngularGradient {
        stops, opacity, handles, ..
      } => {
        let pid = self.id("ag");
        let hd = handles.unwrap_or_else(|| paint::default_handles(true));
        match paint::angular_pattern(&pid, stops, *opacity, &hd, w, h, pad) {
          Some(def) => {
            self.defs.push_str(&def);
            format!("url(#{pid})")
          }
          None => "none".into(),
        }
      }
      Paint::DiamondGradient {
        stops, opacity, handles, ..
      } => {
        let pid = self.id("dg");
        let hd = handles.unwrap_or_else(|| paint::default_handles(false));
        match paint::diamond_pattern(&pid, stops, *opacity, &hd, w, h, pad) {
          Some(def) => {
            self.defs.push_str(&def);
            format!("url(#{pid})")
          }
          // Degenerate axes: nothing but the outer colour is left to show.
          None => stops.last().map_or("none".into(), |s| color::css_with_opacity(&s.color, *opacity)),
        }
      }
      Paint::Image {
        src,
        scale_mode,
        opacity,
        crop,
        scaling_factor,
        rotation,
        filters,
        ..
      } => {
        let pid = self.id("img");
        let ip = paint::ImagePaint {
          src,
          scale_mode: *scale_mode,
          opacity: *opacity,
          crop: crop.as_ref(),
          scaling_factor: *scaling_factor,
          rotation: *rotation,
          filters: filters.as_ref(),
          // Only a tile depends on the size: other fills never ask, so measuring never repaints them.
          natural: if *scale_mode == crate::model::ScaleMode::Tile {
            self.m.image_size(src)
          } else {
            None
          },
        };
        self.defs.push_str(&paint::image_pattern(&pid, &ip, w, h));
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
    let editing = self.opts.mode == Mode::Canvas && self.opts.editing == Some(n.id.as_str());
    let lay = crate::text::layout_for_box_with(t, n.width, Some(n.height), n.max_width, editing, self.m);
    let fill = n
      .fills
      .iter()
      .find(|p| p.visible())
      .map(|p| self.paint(p, n.width, n.height, 0.0))
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
    let stroke = self.text_stroke(n);
    let head = |fill: &str, extra: &str| {
      format!(
        "<text{lod} fill=\"{fill}\" font-family=\"{}\" font-size=\"{}\" font-weight=\"{}\"{}{} text-anchor=\"{anchor}\" dominant-baseline=\"central\"{deco}{extra} style=\"white-space:pre\">",
        esc(&font_stack(&t.font_family)),
        fmt(t.font_size),
        t.font_weight,
        if t.italic { " font-style=\"italic\"" } else { "" },
        if t.letter_spacing != 0.0 { format!(" letter-spacing=\"{}\"", fmt(t.letter_spacing)) } else { String::new() },
      )
    };
    let on_text = match stroke.as_ref().map(|s| (s.align, s.attrs.as_str())) {
      Some((StrokeAlign::Center, a)) => a.to_string(),
      Some((StrokeAlign::Outside, a)) => format!(" paint-order=\"stroke\"{a}"),
      _ => String::new(),
    };
    let mut out = head(&fill, &on_text);
    let _ = lh;
    let base = SpanStyle::base(t);
    let mut bars = String::new();
    let mut body = String::new();
    for line in &lay.lines {
      let top = offset + line.top;
      if self.canvas() {
        bars.push_str(&greek_bar(line, base.size, top, n.width, t.align_h));
      }
      // Justify stretches the gaps of wrapped lines to the box's width.
      let spacing = (t.align_h == TextAlignH::Justify && line.soft_wrap && t.auto_resize != crate::model::TextAutoResize::Width)
        .then(|| {
          let spaces = line.text.chars().filter(|c| matches!(*c, ' ' | '\u{a0}')).count();
          let extra = n.width - line.width;
          (spaces > 0 && extra > 0.01).then(|| format!(" word-spacing=\"{}\"", fmt(extra / spaces as f64)))
        })
        .flatten()
        .unwrap_or_default();
      let mixed_size = line.segments.iter().any(|sg| sg.style.size != base.size);
      if mixed_size {
        // Mixed sizes share an alphabetic baseline (central would centre each span).
        let max = line.segments.iter().map(|sg| sg.style.size).fold(0.0, f64::max);
        let y = top + line.height / 2.0 + 0.35 * max;
        body.push_str(&format!(
          "<tspan x=\"{}\" y=\"{}\" dominant-baseline=\"alphabetic\"{spacing}>",
          fmt(x),
          fmt(y)
        ));
      } else {
        body.push_str(&format!("<tspan x=\"{}\" y=\"{}\"{spacing}>", fmt(x), fmt(top + line.height / 2.0)));
      }
      for sg in &line.segments {
        let attrs = span_attrs(&sg.style, &base, |c| color::css_with_opacity(c, 1.0));
        if attrs.is_empty() {
          body.push_str(&esc(&sg.text));
        } else {
          body.push_str(&format!("<tspan{attrs}>{}</tspan>", esc(&sg.text)));
        }
      }
      body.push_str("</tspan>");
    }
    out.push_str(&body);
    out.push_str("</text>");
    if let Some(st) = stroke.as_ref().filter(|s| s.align == StrokeAlign::Inside) {
      // Inside: a double-width stroke clipped to the glyphs, drawn over the fill.
      let cid = self.id("tclip");
      self
        .defs
        .push_str(&format!("<clipPath id=\"{cid}\">{}{body}</text></clipPath>", head("#000", "")));
      out.push_str(&head("none", &format!(" clip-path=\"url(#{cid})\"{}", st.attrs)));
      out.push_str(&body);
      out.push_str("</text>");
    }
    if let (Some(size), false) = (lod_size, bars.is_empty() || fill == "none") {
      out.push_str(&format!(
        "<path class=\"gk g{size}\" d=\"{bars}\" fill=\"{fill}\" fill-opacity=\"0.5\"/>"
      ));
    }
    out
  }

  /// The first visible stroke of a text layer as SVG attributes. Centre strokes use the weight;
  /// inside and outside strokes use twice it, of which the glyphs hide or clip half.
  fn text_stroke(&mut self, n: &Node) -> Option<TextStroke> {
    let sw = n.stroke_weight;
    let p = n.strokes.iter().find(|p| p.visible())?;
    if sw <= 0.0 {
      return None;
    }
    let paint = self.paint(p, n.width, n.height, 0.0);
    let w = if n.stroke_align == StrokeAlign::Center { sw } else { sw * 2.0 };
    // Always round: a miter on a glyph corner spikes past the stroke margin and the export crop.
    let join = join_name(StrokeJoin::Round);
    let dash = if n.stroke_dash.is_empty() {
      String::new()
    } else {
      format!(
        " stroke-dasharray=\"{}\"",
        n.stroke_dash.iter().map(|v| fmt(*v)).collect::<Vec<_>>().join(" ")
      )
    };
    Some(TextStroke {
      align: n.stroke_align,
      attrs: format!(" stroke=\"{paint}\" stroke-width=\"{}\" stroke-linejoin=\"{join}\"{dash}", fmt(w)),
    })
  }

  /// Canvas only: the text's size class (see `TEXT_SIZE_STEPS`), so the editor can hide text too
  /// small to read, and show its `greek_bar`s, by switching one class on the canvas.
  fn lod_size(&self, t: &model::TextProps, lay: &crate::text::TextLayout) -> Option<u32> {
    if !self.canvas() {
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

struct TextStroke {
  align: StrokeAlign,
  attrs: String,
}

fn join_name(j: StrokeJoin) -> &'static str {
  match j {
    StrokeJoin::Miter => "miter",
    StrokeJoin::Bevel => "bevel",
    StrokeJoin::Round => "round",
  }
}

/// The cap of the stroke's body. "None" is flat. When the two ends differ, the body is flat and
/// a round or square end is drawn as a marker (`line_caps`).
fn linecap(n: &Node) -> &'static str {
  match body_cap(n) {
    StrokeCap::Round => "round",
    StrokeCap::Square => "square",
    _ => "butt",
  }
}

/// The colour and opacity line-end markers are drawn in: the first visible stroke paint (a
/// gradient's first stop, an image as black).
fn marker_paint(n: &Node) -> (String, f64) {
  match n.strokes.iter().find(|p| p.visible()) {
    Some(Paint::Solid { color, opacity, .. }) => (color.clone(), *opacity),
    Some(
      Paint::LinearGradient { stops, opacity, .. }
      | Paint::RadialGradient { stops, opacity, .. }
      | Paint::AngularGradient { stops, opacity, .. }
      | Paint::DiamondGradient { stops, opacity, .. },
    ) => (stops.first().map_or("#000000".to_string(), |s| s.color.clone()), *opacity),
    _ => ("#000000".into(), 1.0),
  }
}

fn body_cap(n: &Node) -> StrokeCap {
  match n.shape.as_ref() {
    Some(s) if s.start_cap == s.end_cap && matches!(s.end_cap, StrokeCap::Round | StrokeCap::Square) => s.end_cap,
    _ => StrokeCap::None,
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

pub(crate) fn stops_svg(stops: &[model::GradientStop], opacity: f64) -> String {
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

/// `s` escaped for the inside of a CSS string delimited by `quote`: backslashes, the quote,
/// `<` (so `</style>` can't end an inline block), and control characters, line separators and
/// NUL as hex escapes (`\A `). Ordinary text comes out unchanged.
pub fn css_string(s: &str, quote: char) -> String {
  let mut out = String::with_capacity(s.len());
  for c in s.chars() {
    match c {
      '\\' => out.push_str("\\\\"),
      '<' => out.push_str("\\3C "),
      '\0' => out.push_str("\\FFFD "),
      c if c == quote => {
        out.push('\\');
        out.push(c);
      }
      c if c.is_control() || c == '\u{2028}' || c == '\u{2029}' => out.push_str(&format!("\\{:X} ", c as u32)),
      c => out.push(c),
    }
  }
  out
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
        editing: None,
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

  fn text_doc(chars: &str, width: f64, f: impl FnOnce(&mut Node)) -> Document {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut t = crate::ops::default_node(NodeType::Text, "t".into(), "T".into());
    t.text.as_mut().unwrap().characters = chars.into();
    t.text.as_mut().unwrap().auto_resize = crate::model::TextAutoResize::Height;
    t.width = width;
    f(&mut t);
    doc.insert(t, None, &page, None);
    doc
  }

  #[test]
  fn justified_text_stretches_wrapped_lines_only() {
    let doc = text_doc("alpha beta gamma delta epsilon zeta eta theta\nlast", 150.0, |t| {
      t.text.as_mut().unwrap().align_h = TextAlignH::Justify;
    });
    let svg = export_svg(&doc, "t", &HeuristicMeasurer);
    let lines: Vec<&str> = svg.split("<tspan x=").skip(1).collect();
    assert!(lines.len() >= 3, "{svg}");
    assert!(lines[0].split('>').next().unwrap().contains("word-spacing"), "{svg}");
    // The last line of a wrapped paragraph and a hard-broken one stay ragged.
    let last = lines.last().unwrap().split('>').next().unwrap();
    assert!(!last.contains("word-spacing"), "{last}");
    let before_break = lines[lines.len() - 2].split('>').next().unwrap();
    assert!(!before_break.contains("word-spacing"), "{before_break}");
    // Left-aligned text is untouched.
    let doc = text_doc("alpha beta gamma delta epsilon zeta eta theta", 150.0, |_| {});
    assert!(!export_svg(&doc, "t", &HeuristicMeasurer).contains("word-spacing"));
  }

  #[test]
  fn justified_mixed_size_lines_get_one_spacing() {
    let doc = text_doc("alpha beta gamma delta epsilon zeta eta theta iota", 160.0, |t| {
      let p = t.text.as_mut().unwrap();
      p.align_h = TextAlignH::Justify;
      p.runs = vec![crate::model::TextRun {
        start: 6,
        end: 16,
        font_size: Some(30.0),
        ..Default::default()
      }];
    });
    let svg = export_svg(&doc, "t", &HeuristicMeasurer);
    let first = svg.split("<tspan x=").nth(1).unwrap().split('>').next().unwrap();
    assert!(first.contains("alphabetic") && first.contains("word-spacing"), "{first}");
  }

  #[test]
  fn text_strokes_follow_their_alignment() {
    let mk = |align: StrokeAlign| {
      text_doc("Hi", 100.0, |t| {
        t.strokes = vec![Paint::solid("#ff0000")];
        t.stroke_weight = 3.0;
        t.stroke_align = align;
      })
    };
    let centre = export_svg(&mk(StrokeAlign::Center), "t", &HeuristicMeasurer);
    assert!(
      centre.contains("stroke=\"#FF0000\"") && centre.contains("stroke-width=\"3\"") && centre.contains("stroke-linejoin=\"round\""),
      "{centre}"
    );
    assert!(!centre.contains("paint-order"));
    let outside = export_svg(&mk(StrokeAlign::Outside), "t", &HeuristicMeasurer);
    assert!(
      outside.contains("paint-order=\"stroke\"") && outside.contains("stroke-width=\"6\""),
      "{outside}"
    );
    let inside = export_svg(&mk(StrokeAlign::Inside), "t", &HeuristicMeasurer);
    assert!(
      inside.contains("<clipPath") && inside.contains("clip-path=\"url(#") && inside.contains("stroke-width=\"6\""),
      "{inside}"
    );
    // The bounds include the stroke's reach, except inside.
    let b = |a| render_bounds(&mk(a), "t", &HeuristicMeasurer);
    assert!(b(StrokeAlign::Outside).width >= b(StrokeAlign::Inside).width + 6.0);
    assert!(b(StrokeAlign::Center).width > b(StrokeAlign::Inside).width);
    // No stroke, no attributes.
    let doc = text_doc("Hi", 100.0, |_| {});
    assert!(!export_svg(&doc, "t", &HeuristicMeasurer).contains("stroke"));
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
          editing: None,
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
    let opts = |mode| RenderOptions {
      mode,
      hidden: &[],
      editing: None,
    };
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

#[cfg(test)]
mod w3a_tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::text::HeuristicMeasurer;

  /// A 100x100 red clipping frame at (50, 20) with a blue child that overflows it (y 50..250)
  /// and a green strip at the top.
  fn scroller() -> Document {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut f = crate::ops::default_node(NodeType::Frame, "f".into(), "Frame".into());
    f.x = 50.0;
    f.y = 20.0;
    f.width = 100.0;
    f.height = 100.0;
    f.clip_content = true;
    f.fills = vec![crate::model::Paint::solid("#FF0000")];
    doc.insert(f, None, &page, None);
    for (id, y, color) in [("tall", 50.0, "#0000FF"), ("nav", 0.0, "#00FF00")] {
      let mut c = crate::ops::default_node(NodeType::Rectangle, id.into(), id.into());
      c.y = y;
      c.width = 100.0;
      c.height = if id == "tall" { 200.0 } else { 10.0 };
      c.fills = vec![crate::model::Paint::solid(color)];
      doc.insert(c, Some("f"), &page, None);
    }
    crate::layout::relayout_all(&mut doc, &HeuristicMeasurer);
    doc
  }

  #[test]
  fn children_only_crops_to_overflowing_children_and_skips_the_frame_paint() {
    let doc = scroller();
    let c = export_svg_parts(&doc, "f", &HeuristicMeasurer, &[], true);
    assert_eq!(
      (c.bounds.x, c.bounds.y, c.bounds.width, c.bounds.height),
      (50.0, 20.0, 100.0, 250.0),
      "{}",
      c.svg
    );
    assert!(
      c.svg.to_lowercase().contains("0000ff") && c.svg.contains("height=\"250\""),
      "{}",
      c.svg
    );
    assert!(
      !c.svg.to_lowercase().contains("ff0000"),
      "the frame's own fill is left out: {}",
      c.svg
    );
    assert!(!c.svg.contains("clip-path"), "not clipped: {}", c.svg);
    // The whole frame still clips and paints itself.
    let full = export_svg_parts(&doc, "f", &HeuristicMeasurer, &[], false);
    assert!(full.svg.to_lowercase().contains("ff0000") && full.svg.contains("clip-path"));
  }

  fn def_ids(svg: &str) -> Vec<String> {
    svg
      .split("id=\"")
      .skip(1)
      .filter_map(|r| r.split('"').next())
      .map(String::from)
      .collect()
  }

  #[test]
  fn clipped_siblings_exported_separately_share_no_def_ids() {
    let mut doc = scroller();
    let page = doc.pages[0].id.clone();
    let mut g = crate::ops::default_node(NodeType::Frame, "g".into(), "G".into());
    g.width = 80.0;
    g.height = 80.0;
    g.clip_content = true;
    doc.insert(g, None, &page, None);
    let mut kid = crate::ops::default_node(NodeType::Rectangle, "g_kid".into(), "Kid".into());
    kid.width = 200.0;
    kid.height = 200.0;
    doc.insert(kid, Some("g"), &page, None);
    let a = export_svg_parts(&doc, "f", &HeuristicMeasurer, &[], false).svg;
    let b = export_svg_parts(&doc, "g", &HeuristicMeasurer, &[], false).svg;
    let c = export_svg_parts(&doc, "f", &HeuristicMeasurer, &["nav".to_string()], false).svg;
    let (ia, ib, ic) = (def_ids(&a), def_ids(&b), def_ids(&c));
    assert!(!ia.is_empty() && !ib.is_empty() && !ic.is_empty(), "{a} {b} {c}");
    for (x, y) in [(&ia, &ib), (&ia, &ic), (&ib, &ic)] {
      assert!(x.iter().all(|i| !y.contains(i)), "{x:?} vs {y:?}");
    }
  }

  #[test]
  fn scopes_differ_per_node_children_only_and_hidden_set() {
    let a = export_scope("f", false, &[]);
    let b = export_scope("f", false, &["nav".to_string()]);
    let c = export_scope("f", true, &[]);
    let d = export_scope("g", false, &[]);
    let e = export_scope("f", false, &["nav".to_string(), "x".to_string()]);
    let all = [&a, &b, &c, &d, &e];
    for (i, x) in all.iter().enumerate() {
      assert!(
        x.starts_with('x') && x.ends_with(|ch: char| ch.is_ascii_alphanumeric() || ch == '_'),
        "{x}"
      );
      assert!(all.iter().skip(i + 1).all(|y| x != y), "{all:?}");
    }
    assert_eq!(a, export_scope("f", false, &[]), "deterministic");
  }

  #[test]
  fn a_screen_and_an_overlay_in_one_page_each_resolve_their_own_references() {
    let mut doc = scroller();
    let page = doc.pages[0].id.clone();
    let mut o = crate::ops::default_node(NodeType::Frame, "dlg".into(), "Dialog".into());
    o.width = 60.0;
    o.height = 60.0;
    o.clip_content = true;
    o.corner_radius = 8.0;
    doc.insert(o, None, &page, None);
    let mut kid = crate::ops::default_node(NodeType::Rectangle, "dlg_kid".into(), "Kid".into());
    kid.width = 200.0;
    kid.height = 200.0;
    doc.insert(kid, Some("dlg"), &page, None);
    let screen = export_svg_parts(&doc, "f", &HeuristicMeasurer, &[], false).svg;
    let overlay = export_svg_parts(&doc, "dlg", &HeuristicMeasurer, &[], false).svg;
    let page_html = format!("{screen}{overlay}");
    for svg in [&screen, &overlay] {
      let ids = def_ids(svg);
      assert!(!ids.is_empty(), "{svg}");
      for r in svg.split("url(#").skip(1) {
        let r = r.split(')').next().unwrap();
        assert!(ids.iter().any(|i| i == r), "{r} not in its own svg: {svg}");
        assert_eq!(
          page_html.matches(&format!("id=\"{r}\"")).count(),
          1,
          "{r} defined twice on the page"
        );
      }
    }
  }

  #[test]
  fn hidden_layers_are_left_out_of_the_svg() {
    let doc = scroller();
    let c = export_svg_parts(&doc, "f", &HeuristicMeasurer, &["nav".to_string()], false);
    assert!(
      !c.svg.to_lowercase().contains("00ff00"),
      "the hidden strip isn't painted: {}",
      c.svg
    );
    assert!(c.svg.to_lowercase().contains("0000ff"), "its sibling is: {}", c.svg);
    assert!(export_svg(&doc, "f", &HeuristicMeasurer).to_lowercase().contains("00ff00"));
    // The crop is still what the whole layer paints.
    assert_eq!(c.bounds, render_bounds(&doc, "f", &HeuristicMeasurer));
  }
}

#[cfg(test)]
mod r17c_tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::model::ScaleMode;
  use crate::text::{FontSpec, HeuristicMeasurer};

  /// Answers `image_size` like the editor does once an image has been measured.
  struct Sized(f64, f64);

  impl TextMeasurer for Sized {
    fn measure(&self, text: &str, font: &FontSpec) -> f64 {
      HeuristicMeasurer.measure(text, font)
    }
    fn image_size(&self, src: &str) -> Option<(f64, f64)> {
      (src == "asset:a").then_some((self.0, self.1))
    }
  }

  fn image_doc(mode: ScaleMode, f: impl FnOnce(&mut Paint)) -> Document {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut r = crate::ops::default_node(NodeType::Rectangle, "r".into(), "R".into());
    r.width = 400.0;
    r.height = 200.0;
    let mut p = Paint::Image {
      src: "asset:a".into(),
      scale_mode: mode,
      opacity: 1.0,
      visible: true,
      crop: None,
      credit: None,
      scaling_factor: 1.0,
      rotation: 0.0,
      filters: None,
    };
    f(&mut p);
    r.fills = vec![p];
    doc.insert(r, None, &page, None);
    doc
  }

  fn pattern_of(svg: &str) -> String {
    let at = svg.find("<pattern").expect("pattern");
    svg[at..svg.find("</pattern>").unwrap()].to_string()
  }

  #[test]
  fn a_tile_cell_is_the_images_own_size_times_the_scale() {
    let doc = image_doc(ScaleMode::Tile, |_| {});
    let known = pattern_of(&export_svg(&doc, "r", &Sized(40.0, 20.0)));
    assert!(known.contains("width=\"40\" height=\"20\">"), "{known}");
    assert!(known.contains("preserveAspectRatio=\"none\""), "{known}");
    let half = image_doc(ScaleMode::Tile, |p| {
      if let Paint::Image { scaling_factor, .. } = p {
        *scaling_factor = 0.5;
      }
    });
    let half = pattern_of(&export_svg(&half, "r", &Sized(40.0, 20.0)));
    assert!(half.contains("width=\"20\" height=\"10\">"), "{half}");
    // Without a size: the old 64 px slice cell, times the scale.
    let unknown = pattern_of(&export_svg(&doc, "r", &HeuristicMeasurer));
    assert!(
      unknown.contains("width=\"64\" height=\"64\">") && unknown.contains("xMidYMid slice"),
      "{unknown}"
    );
  }

  #[test]
  fn a_quarter_turn_swaps_the_box_the_image_fills() {
    let doc = image_doc(ScaleMode::Fill, |p| {
      if let Paint::Image { rotation, .. } = p {
        *rotation = 90.0;
      }
    });
    let pat = pattern_of(&export_svg(&doc, "r", &HeuristicMeasurer));
    // The 400x200 box is filled by a 200x400 image turned about its centre (200, 100).
    assert!(pat.contains("rotate(90 200 100)"), "{pat}");
    assert!(pat.contains("x=\"100\" y=\"-100\" width=\"200\" height=\"400\""), "{pat}");
    assert!(pat.contains("xMidYMid slice"), "{pat}");
    // 180 keeps the box; tiles turn with patternTransform.
    let flipped = image_doc(ScaleMode::Fill, |p| {
      if let Paint::Image { rotation, .. } = p {
        *rotation = 180.0;
      }
    });
    assert!(pattern_of(&export_svg(&flipped, "r", &HeuristicMeasurer)).contains("x=\"0\" y=\"0\" width=\"400\" height=\"200\""));
    let tile = image_doc(ScaleMode::Tile, |p| {
      if let Paint::Image { rotation, .. } = p {
        *rotation = 270.0;
      }
    });
    assert!(pattern_of(&export_svg(&tile, "r", &Sized(40.0, 20.0))).contains("patternTransform=\"rotate(270)\""));
  }

  #[test]
  fn a_rotated_crop_turns_about_the_crop_rectangle() {
    let doc = image_doc(ScaleMode::Crop, |p| {
      if let Paint::Image { rotation, crop, .. } = p {
        *rotation = 90.0;
        *crop = Some(crate::model::ImageCrop {
          x: 0.0,
          y: 0.0,
          w: 0.5,
          h: 1.0,
        });
      }
    });
    // The crop is 200x200: its centre is (100, 100).
    let pat = pattern_of(&export_svg(&doc, "r", &HeuristicMeasurer));
    assert!(pat.contains("rotate(90 100 100)"), "{pat}");
  }

  #[test]
  fn adjustments_become_a_filter_the_image_uses_and_identity_ones_do_not() {
    let adjusted = image_doc(ScaleMode::Fill, |p| {
      if let Paint::Image { filters, .. } = p {
        *filters = Some(crate::model::ImageFilters {
          saturation: -1.0,
          ..Default::default()
        });
      }
    });
    let svg = export_svg(&adjusted, "r", &HeuristicMeasurer);
    assert!(
      svg.contains("<filter id=\"xr_img1_f\" color-interpolation-filters=\"sRGB\""),
      "{svg}"
    );
    assert!(svg.contains("type=\"saturate\" values=\"0\""), "{svg}");
    assert!(svg.contains("filter=\"url(#xr_img1_f)\""), "{svg}");
    let plain = image_doc(ScaleMode::Fill, |p| {
      if let Paint::Image { filters, .. } = p {
        *filters = Some(crate::model::ImageFilters::default());
      }
    });
    assert!(!export_svg(&plain, "r", &HeuristicMeasurer).contains("<filter"));
  }
}

#[cfg(test)]
mod r18d_tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::model::{ShapeProps, SubPath, VectorData, VectorPoint};
  use crate::text::HeuristicMeasurer;

  fn doc_with(f: impl FnOnce(&mut Node)) -> Document {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut n = crate::ops::default_node(NodeType::Rectangle, "n".into(), "N".into());
    n.width = 60.0;
    n.height = 40.0;
    n.fills = vec![Paint::solid("#3366FF")];
    n.strokes = vec![Paint::solid("#112233")];
    n.stroke_weight = 4.0;
    n.stroke_align = StrokeAlign::Center;
    f(&mut n);
    doc.insert(n, None, &page, None);
    doc
  }

  fn open_path(start_cap: StrokeCap, end_cap: StrokeCap) -> Document {
    doc_with(|n| {
      n.kind = NodeType::Vector;
      n.fills.clear();
      n.vector = Some(VectorData {
        subpaths: vec![SubPath {
          points: vec![VectorPoint::at(0.0, 0.0), VectorPoint::at(60.0, 0.0)],
          closed: false,
        }],
        raw: None,
      });
      n.shape = Some(ShapeProps {
        start_cap,
        end_cap,
        ..Default::default()
      });
    })
  }

  fn svg(doc: &Document) -> String {
    export_svg(doc, "n", &HeuristicMeasurer)
  }

  #[test]
  fn none_caps_draw_flat_round_and_square_follow() {
    assert!(svg(&open_path(StrokeCap::None, StrokeCap::None)).contains("stroke-linecap=\"butt\""));
    assert!(svg(&open_path(StrokeCap::Round, StrokeCap::Round)).contains("stroke-linecap=\"round\""));
    assert!(svg(&open_path(StrokeCap::Square, StrokeCap::Square)).contains("stroke-linecap=\"square\""));
    // A line with no shape settings is flat too.
    let line = doc_with(|n| {
      n.kind = NodeType::Line;
      n.shape = None;
    });
    assert!(svg(&line).contains("stroke-linecap=\"butt\""));
    let same = svg(&open_path(StrokeCap::Round, StrokeCap::Round));
    assert!(!same.contains("<marker"), "equal round ends need no marker: {same}");
  }

  #[test]
  fn different_ends_use_a_flat_body_and_a_marker_for_the_round_or_square_one() {
    let s = svg(&open_path(StrokeCap::Round, StrokeCap::Arrow));
    assert!(s.contains("stroke-linecap=\"butt\""), "{s}");
    assert_eq!(s.matches("<marker").count(), 2, "{s}");
    assert!(s.contains("marker-start=") && s.contains("marker-end="), "{s}");
    assert!(
      s.contains("markerUnits=\"strokeWidth\"") && s.contains("M0 0A0.5 0.5 0 0 1 0 1Z"),
      "{s}"
    );
    let sq = svg(&open_path(StrokeCap::None, StrokeCap::Square));
    assert!(sq.contains("stroke-linecap=\"butt\""), "{sq}");
    assert_eq!(sq.matches("<marker").count(), 1, "{sq}");
    assert!(sq.contains("marker-end=") && !sq.contains("marker-start="), "{sq}");
    assert!(sq.contains("<rect width=\"0.5\" height=\"1\""), "{sq}");
  }

  #[test]
  fn closed_and_raw_paths_have_no_end_markers() {
    let mut closed = open_path(StrokeCap::Round, StrokeCap::Arrow);
    let id = closed.pages[0].children[0].clone();
    closed.get_mut(&id).unwrap().vector.as_mut().unwrap().subpaths[0].closed = true;
    let s = svg(&closed);
    assert!(!s.contains("<marker") && !s.contains("marker-end"), "{s}");
    let raw = doc_with(|n| {
      n.kind = NodeType::Vector;
      n.vector = Some(VectorData {
        subpaths: vec![],
        raw: Some(crate::model::RawPath {
          d: "M0 0L60 0L30 40".into(),
          view_box: [0.0, 0.0, 60.0, 40.0],
          fill_rule: String::new(),
        }),
      });
      n.shape = Some(ShapeProps {
        start_cap: StrokeCap::Round,
        end_cap: StrokeCap::Circle,
        ..Default::default()
      });
    });
    let s = svg(&raw);
    assert!(!s.contains("<marker"), "{s}");
  }

  #[test]
  fn round_and_square_markers_use_the_stroke_opacity_and_a_half_disk() {
    let s = svg(&doc_with(|n| {
      n.kind = NodeType::Line;
      n.fills.clear();
      n.strokes = vec![Paint::Solid {
        color: "#112233".into(),
        opacity: 0.5,
        visible: true,
      }];
      n.shape = Some(ShapeProps {
        start_cap: StrokeCap::Round,
        end_cap: StrokeCap::Square,
        ..Default::default()
      });
    }));
    assert_eq!(s.matches("<marker").count(), 2, "{s}");
    assert!(s.contains("M0 0A0.5 0.5 0 0 1 0 1Z") && !s.contains("<circle"), "{s}");
    assert_eq!(s.matches("fill=\"rgba(17, 34, 51, 0.5)\"").count(), 2, "{s}");
    // A gradient stroke uses its first stop.
    let g = svg(&doc_with(|n| {
      n.kind = NodeType::Line;
      n.fills.clear();
      n.strokes = vec![Paint::LinearGradient {
        stops: vec![
          crate::model::GradientStop {
            position: 0.0,
            color: "#FF0000".into(),
          },
          crate::model::GradientStop {
            position: 1.0,
            color: "#0000FF".into(),
          },
        ],
        angle: 90.0,
        opacity: 1.0,
        handles: None,
        visible: true,
      }];
      n.shape = Some(ShapeProps {
        start_cap: StrokeCap::None,
        end_cap: StrokeCap::Round,
        ..Default::default()
      });
    }));
    assert!(g.contains("<marker") && g.to_lowercase().contains("#ff0000"), "{g}");
  }

  #[test]
  fn a_centre_stroke_with_one_fill_is_one_element() {
    let s = svg(&doc_with(|_| {}));
    assert_eq!(s.matches("<rect").count(), 1, "{s}");
    assert!(
      s.contains("fill=\"#3366FF\"") && s.contains("stroke=\"#112233\"") && s.contains("stroke-width=\"4\""),
      "{s}"
    );
    // The same for an ellipse and a closed path.
    let e = svg(&doc_with(|n| n.kind = NodeType::Ellipse));
    assert_eq!(e.matches("<ellipse").count(), 1, "{e}");
    let star = svg(&doc_with(|n| n.kind = NodeType::Star));
    assert_eq!(star.matches("<path").count(), 1, "{star}");
  }

  #[test]
  fn an_open_path_with_a_fill_and_a_stroke_is_one_element() {
    let doc = doc_with(|n| {
      n.kind = NodeType::Vector;
      n.stroke_align = StrokeAlign::Inside;
      n.vector = Some(VectorData {
        subpaths: vec![SubPath {
          points: vec![VectorPoint::at(0.0, 0.0), VectorPoint::at(60.0, 0.0), VectorPoint::at(30.0, 40.0)],
          closed: false,
        }],
        raw: None,
      });
    });
    let s = svg(&doc);
    assert_eq!(s.matches("<path").count(), 1, "{s}");
    assert!(!s.contains("clipPath"), "{s}");
  }

  #[test]
  fn inside_outside_several_paints_and_per_side_weights_keep_two_elements() {
    for align in [StrokeAlign::Inside, StrokeAlign::Outside] {
      let s = svg(&doc_with(|n| n.stroke_align = align));
      assert_eq!(s.matches("<rect").count() + s.matches("<path").count(), 2, "{align:?}: {s}");
    }
    let two_strokes = svg(&doc_with(|n| n.strokes.push(Paint::solid("#ff0000"))));
    assert_eq!(two_strokes.matches("<rect").count(), 3, "{two_strokes}");
    let sides = svg(&doc_with(|n| n.stroke_weights = Some([4.0, 0.0, 4.0, 0.0])));
    assert_eq!(sides.matches("<rect").count(), 1, "{sides}");
    assert!(sides.contains("evenodd"), "{sides}");
    let no_fill = svg(&doc_with(|n| n.fills.clear()));
    assert_eq!(no_fill.matches("<rect").count(), 1);
    assert!(no_fill.contains("fill=\"none\""), "{no_fill}");
  }

  #[test]
  fn the_merged_element_carries_the_same_attributes_as_the_two_it_replaces() {
    let s = svg(&doc_with(|n| {
      n.stroke_dash = vec![4.0, 2.0];
      n.stroke_join = Some(StrokeJoin::Bevel);
    }));
    let el = s.split("<rect").nth(1).unwrap().split("/>").next().unwrap();
    for want in [
      "fill=\"#3366FF\"",
      "stroke=\"#112233\"",
      "stroke-dasharray=\"4 2\"",
      "stroke-linejoin=\"bevel\"",
      "stroke-width=\"4\"",
    ] {
      assert!(el.contains(want), "{want} in {el}");
    }
  }
}

#[cfg(test)]
mod w4ad_tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::text::HeuristicMeasurer;

  /// Frame `f` (400x300) holding `blue` (0,0,200x200), `far` (350,250,20x20), the glass `card`
  /// (50,50,100x100, background blur 20) and `above` (60,60,10x10), painted in that order.
  fn glass() -> Document {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut f = crate::ops::default_node(NodeType::Frame, "f".into(), "F".into());
    f.width = 400.0;
    f.height = 300.0;
    doc.insert(f, None, &page, None);
    for (id, x, y, w, h) in [
      ("blue", 0.0, 0.0, 200.0, 200.0),
      ("far", 350.0, 250.0, 20.0, 20.0),
      ("card", 50.0, 50.0, 100.0, 100.0),
      ("above", 60.0, 60.0, 10.0, 10.0),
    ] {
      let mut r = crate::ops::default_node(NodeType::Rectangle, id.into(), id.into());
      (r.x, r.y, r.width, r.height) = (x, y, w, h);
      r.fills = vec![model::Paint::solid(match id {
        "blue" => "#0000FF",
        "far" => "#00FF00",
        _ => "#ffffff66",
      })];
      r.strokes.clear();
      r.stroke_weight = 0.0;
      if id == "card" {
        r.effects = vec![bg_blur(20.0)];
      }
      doc.insert(r, Some("f"), &page, None);
    }
    doc
  }

  fn bg_blur(blur: f64) -> Effect {
    Effect {
      kind: EffectType::BackgroundBlur,
      blur,
      ..Effect::default()
    }
  }

  fn canvas(doc: &Document, root: &str) -> String {
    let opts = RenderOptions {
      mode: Mode::Canvas,
      hidden: &[],
      editing: None,
    };
    render_root(doc, root, &HeuristicMeasurer, opts)
  }

  /// The card's `<g>` markup, up to the layer painted above it.
  fn card_group(svg: &str) -> String {
    let i = svg.find("data-id=\"card\"").expect("card group");
    let rest = &svg[i..];
    let j = rest.find("<g data-id=\"above\"").unwrap_or(rest.len());
    rest[..j].to_string()
  }

  fn count(s: &str, pat: &str) -> usize {
    s.matches(pat).count()
  }

  /// The blurred copy of an SVG without hooks and def ids, to compare canvas with export.
  fn copy_of(svg: &str) -> String {
    let i = svg.find("<g filter=\"url(#").expect("backdrop");
    let rest = &svg[i..];
    let mut s = rest[..rest.find("</g></g>").unwrap()].to_string();
    while let Some(i) = s.find(" data-id=\"") {
      let j = s[i + 10..].find('"').unwrap() + i + 11;
      s.replace_range(i..j, "");
    }
    s.split("url(#")
      .map(|p| p.split_once(')').map_or(p, |(_, r)| r))
      .collect::<Vec<_>>()
      .join("url()")
  }

  #[test]
  fn a_card_repaints_the_content_below_it_blurred_and_clipped() {
    let svg = canvas(&glass(), "f");
    let card = card_group(&svg);
    assert!(card.contains("class=\"dt-bb\""), "{card}");
    assert!(card.contains("clip-path=\"url(#"));
    assert!(card.contains("filter=\"url(#"));
    assert!(svg.contains("feGaussianBlur stdDeviation=\"10\""));
    // the blue rectangle: once as itself, once as the copy; hooks only on the real one
    assert_eq!(count(&svg, "data-id=\"blue\""), 1);
    assert_eq!(count(&svg, "#0000FF"), 2);
    // the copy is in the card's own space: blue sits at (-50,-50)
    assert!(card.contains("matrix(1 0 0 1 -50 -50)"), "{card}");
    // what paints above the card is not copied
    assert_eq!(count(&svg, "data-id=\"above\""), 1);
    assert_eq!(count(&card, "rgba(255, 255, 255, 0.4)"), 1, "only the card's own fill");
  }

  #[test]
  fn far_siblings_are_culled() {
    let svg = canvas(&glass(), "f");
    assert_eq!(count(&svg, "#00FF00"), 1, "far is painted once, not copied");
  }

  #[test]
  fn no_backdrop_for_a_top_level_layer_an_invisible_effect_or_blur_zero() {
    let mut doc = glass();
    doc.get_mut("card").unwrap().effects[0].visible = false;
    assert!(!canvas(&doc, "f").contains("dt-bb"));
    doc.get_mut("card").unwrap().effects[0].visible = true;
    doc.get_mut("card").unwrap().effects[0].blur = 0.0;
    assert!(!canvas(&doc, "f").contains("dt-bb"));
    let page = doc.pages[0].id.clone();
    let mut t = crate::ops::default_node(NodeType::Rectangle, "top".into(), "top".into());
    t.effects = vec![bg_blur(20.0)];
    doc.insert(t, None, &page, None);
    assert!(!canvas(&doc, "top").contains("dt-bb"));
  }

  #[test]
  fn export_stops_at_the_exported_layer() {
    let doc = glass();
    let m = &HeuristicMeasurer;
    let card = export_svg(&doc, "card", m);
    assert!(!card.contains("feGaussianBlur"), "{card}");
    let frame = export_svg(&doc, "f", m);
    assert!(frame.contains("feGaussianBlur stdDeviation=\"10\""));
    assert!(!frame.contains("data-id") && !frame.contains("dt-bb"));
    let kids = export_svg_parts(&doc, "f", m, &[], true).svg;
    assert!(kids.contains("feGaussianBlur"));
  }

  #[test]
  fn the_canvas_and_export_copies_match_apart_from_hooks() {
    let doc = glass();
    let (a, b) = (copy_of(&canvas(&doc, "f")), copy_of(&export_svg(&doc, "f", &HeuristicMeasurer)));
    assert!(a.contains("#0000FF"));
    assert_eq!(a, b);
  }

  #[test]
  fn nested_blurs_are_not_expanded() {
    let mut doc = glass();
    let page = doc.pages[0].id.clone();
    let mut g2 = crate::ops::default_node(NodeType::Rectangle, "g2".into(), "g2".into());
    (g2.x, g2.y, g2.width, g2.height) = (60.0, 60.0, 50.0, 50.0);
    g2.effects = vec![bg_blur(8.0)];
    doc.insert(g2, Some("f"), &page, Some(2));
    let svg = canvas(&doc, "f");
    // g2 blurs `blue`; the card blurs `blue` and a plain copy of g2 (no backdrop of its own)
    assert_eq!(count(&svg, "feGaussianBlur"), 2);
    assert_eq!(count(&svg, "data-id=\"g2\""), 1);
  }

  #[test]
  fn a_mask_below_the_card_is_kept_in_the_copy() {
    let mut doc = glass();
    let page = doc.pages[0].id.clone();
    let mut m = crate::ops::default_node(NodeType::Ellipse, "mk".into(), "mk".into());
    (m.x, m.y, m.width, m.height) = (0.0, 0.0, 300.0, 300.0);
    m.is_mask = true;
    doc.insert(m, Some("f"), &page, Some(0));
    let card = card_group(&canvas(&doc, "f"));
    assert!(card.contains("mask=\"url(#"), "{card}");
  }

  #[test]
  fn a_rotated_card_carries_the_inverse_transform() {
    let mut doc = glass();
    doc.get_mut("card").unwrap().rotation = 30.0;
    let card = card_group(&canvas(&doc, "f"));
    assert!(card.contains("matrix("), "{card}");
    assert!(card.contains("#0000FF"));
  }

  #[test]
  fn hidden_layers_are_left_out_of_the_copy() {
    let doc = glass();
    let hidden = vec!["blue".to_string()];
    let opts = RenderOptions {
      mode: Mode::Canvas,
      hidden: &hidden,
      editing: None,
    };
    let svg = render_root(&doc, "f", &HeuristicMeasurer, opts);
    assert_eq!(count(&svg, "#0000FF"), 1, "hidden stays on the canvas but is not copied");
  }

  #[test]
  fn text_has_no_background_blur() {
    let mut doc = glass();
    let page = doc.pages[0].id.clone();
    let mut t = crate::ops::default_node(NodeType::Text, "tx".into(), "tx".into());
    t.effects = vec![bg_blur(20.0)];
    doc.insert(t, Some("f"), &page, None);
    assert_eq!(count(&canvas(&doc, "f"), "dt-bb"), 1);
  }
}
