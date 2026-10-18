//! SVG renderer. The same code paints the editor canvas (with `data-id`
//! hooks) and produces exported SVG, so what you see is what you export.

use crate::geom::{fmt, Mat};
use crate::model::{
  Document, Effect, EffectType, Node, NodeId, NodeType, Paint, ScaleMode, StrokeAlign, StrokeCap, TextAlignH, TextAlignV, TextDecoration,
};
use crate::shapes;
use crate::text::{layout_for_node, TextMeasurer};
use crate::{color, model};

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
}

/// Renders all roots of a page as SVG markup (`<defs>` + content), page coordinates.
pub fn render_page(doc: &Document, page: &str, m: &dyn TextMeasurer, opts: RenderOptions) -> String {
  let mut r = Renderer {
    doc,
    m,
    opts,
    defs: String::new(),
    uid: 0,
  };
  let roots = doc.page(page).map(|p| p.children.clone()).unwrap_or_default();
  let body: String = roots.iter().map(|id| r.node(id, None)).collect();
  format!("<defs>{}</defs>{}", r.defs, body)
}

/// Renders a single node as a standalone SVG document cropped to its bounds.
pub fn export_svg(doc: &Document, id: &str, m: &dyn TextMeasurer) -> String {
  let Some(n) = doc.get(id) else { return String::new() };
  let b = doc.abs_bounds(id);
  let mut r = Renderer {
    doc,
    m,
    opts: RenderOptions {
      mode: Mode::Export,
      hidden: &[],
    },
    defs: String::new(),
    uid: 0,
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
    format!("{prefix}{}", self.uid)
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
      NodeType::Group => n.children.iter().map(|c| self.node(c, None)).collect(),
      NodeType::Text => self.text(n),
      k if k.is_frame_like() => {
        let geo = Geo::Rect {
          w: n.width,
          h: n.height,
          r: shapes::corner_radii(n),
        };
        let mut out = self.fills(n, &geo);
        let kids: String = n.children.iter().map(|c| self.node(c, None)).collect();
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

  fn effects_filter(&mut self, n: &Node) -> Option<String> {
    let effects: Vec<&Effect> = n
      .effects
      .iter()
      .filter(|e| e.visible && e.kind != EffectType::BackgroundBlur)
      .collect();
    if effects.is_empty() {
      return None;
    }
    let fid = self.id("fx");
    let mut f = format!("<filter id=\"{fid}\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\" color-interpolation-filters=\"sRGB\">");
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
    let lay = layout_for_node(t, n.width, self.m);
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
    let mut out = format!(
      "<text fill=\"{fill}\" font-family=\"{}\" font-size=\"{}\" font-weight=\"{}\"{}{} text-anchor=\"{anchor}\" dominant-baseline=\"central\"{deco} style=\"white-space:pre\">",
      esc(&font_stack(&t.font_family)),
      fmt(t.font_size),
      t.font_weight,
      if t.italic { " font-style=\"italic\"" } else { "" },
      if t.letter_spacing != 0.0 { format!(" letter-spacing=\"{}\"", fmt(t.letter_spacing)) } else { String::new() },
    );
    for (i, line) in lay.lines.iter().enumerate() {
      let y = offset + i as f64 * lh + lh / 2.0;
      out.push_str(&format!("<tspan x=\"{}\" y=\"{}\">{}</tspan>", fmt(x), fmt(y), esc(&line.text)));
    }
    out.push_str("</text>");
    out
  }
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
}
