//! Paint servers and stroke outlines beyond plain colours: gradient handles, angular and
//! diamond gradients (SVG patterns, so they work as fill and stroke and rasterise in PNG
//! export), image crop rectangles and the filled ring that draws per-side strokes.

use std::f64::consts::TAU;

use crate::color::{self, Rgba};
use crate::geom::fmt;
use crate::model::{GradientHandles, GradientStop, ImageCrop, StrokeAlign};
use crate::render::stops_svg;

/// Wedges in an angular gradient; bigger boxes get the finer ring.
const WEDGES: usize = 180;
const WEDGES_LARGE: usize = 360;
const LARGE_BOX: f64 = 1000.0;
/// Each wedge reaches this much (of its own angle) into the next, hiding anti-aliasing seams.
const WEDGE_OVERLAP: f64 = 0.03;

/// Handles of a gradient that has none: what the renderer draws today, in the unit box.
pub fn default_handles(angular: bool) -> GradientHandles {
  GradientHandles {
    start: [0.5, 0.5],
    end: if angular { [0.5, 0.0] } else { [1.0, 0.5] },
    width: [0.5, 1.0],
  }
}

/// CSS angle (0 = up, 90 = right) of the start-to-end line of a layer `w` x `h`.
pub fn handle_angle(hd: &GradientHandles, w: f64, h: f64) -> f64 {
  let dx = (hd.end[0] - hd.start[0]) * w;
  let dy = (hd.end[1] - hd.start[1]) * h;
  let deg = dx.atan2(-dy).to_degrees();
  (deg.rem_euclid(360.0) * 100.0).round() / 100.0
}

/// Radii of the two axes as a percentage of the layer's width and height.
pub fn handle_radii(hd: &GradientHandles, w: f64, h: f64) -> (f64, f64) {
  let a = ((hd.end[0] - hd.start[0]) * w).hypot((hd.end[1] - hd.start[1]) * h);
  let b = ((hd.width[0] - hd.start[0]) * w).hypot((hd.width[1] - hd.start[1]) * h);
  (a / w.max(1.0) * 100.0, b / h.max(1.0) * 100.0)
}

/// `<linearGradient>` from the start handle to the end handle.
pub fn linear_def(id: &str, stops: &[GradientStop], opacity: f64, hd: &GradientHandles, w: f64, h: f64) -> String {
  format!(
    "<linearGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\">{}</linearGradient>",
    fmt(hd.start[0] * w),
    fmt(hd.start[1] * h),
    fmt(hd.end[0] * w),
    fmt(hd.end[1] * h),
    stops_svg(stops, opacity)
  )
}

/// `<radialGradient>` whose unit circle is mapped onto the ellipse the handles span.
pub fn radial_def(id: &str, stops: &[GradientStop], opacity: f64, hd: &GradientHandles, w: f64, h: f64) -> String {
  let ax = Axes::new(hd, w, h);
  format!(
    "<radialGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" cx=\"0\" cy=\"0\" r=\"1\" gradientTransform=\"{}\">{}</radialGradient>",
    ax.matrix(),
    stops_svg(stops, opacity)
  )
}

/// Pattern holding four quadrants whose linear gradients run perpendicular to the diamond's
/// edges: inside each quadrant |u| + |v| is linear, so this is exact. `None` when the axes
/// are parallel and there is no diamond to draw.
pub fn diamond_pattern(id: &str, stops: &[GradientStop], opacity: f64, hd: &GradientHandles, w: f64, h: f64, pad: f64) -> Option<String> {
  let ax = Axes::new(hd, w, h);
  let det = ax.det();
  if det.abs() < 1e-6 {
    return None;
  }
  // The pattern tile in axis space: farthest corner decides how far the quadrants must reach.
  let reach = ax
    .corners(w, h, pad)
    .iter()
    .map(|&p| {
      let [u, v] = ax.to_uv(p);
      u.abs().max(v.abs())
    })
    .fold(0.0_f64, f64::max)
    + 1.0;
  let overlap = (0.3 / ax.min_len().max(1e-6)).min(0.05);
  let stops = stops_svg(stops, opacity);
  let mut grads = String::new();
  let mut rects = String::new();
  for (i, (sx, sy)) in [(1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0), (1.0, -1.0)].into_iter().enumerate() {
    let gid = format!("{id}q{i}");
    grads.push_str(&format!(
      "<linearGradient id=\"{gid}\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"{}\" y2=\"{}\">{stops}</linearGradient>",
      fmt(sx * 0.5),
      fmt(sy * 0.5)
    ));
    let x = if sx > 0.0 { -overlap } else { -reach };
    let y = if sy > 0.0 { -overlap } else { -reach };
    rects.push_str(&format!(
      "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"url(#{gid})\"/>",
      fmt(x),
      fmt(y),
      fmt(reach + overlap),
      fmt(reach + overlap)
    ));
  }
  Some(format!(
    "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\">{grads}<g transform=\"translate({} {})\"><g transform=\"{}\">{rects}</g></g></pattern>",
    fmt(-pad),
    fmt(-pad),
    fmt(w + 2.0 * pad),
    fmt(h + 2.0 * pad),
    fmt(pad),
    fmt(pad),
    ax.matrix()
  ))
}

/// Pattern of solid wedges around the start handle; the sweep begins towards the end handle
/// and runs clockwise. `None` when the stops are empty.
pub fn angular_pattern(id: &str, stops: &[GradientStop], opacity: f64, hd: &GradientHandles, w: f64, h: f64, pad: f64) -> Option<String> {
  let samples = Sampler::new(stops, opacity)?;
  let n = if w.max(h) > LARGE_BOX { WEDGES_LARGE } else { WEDGES };
  let (cx, cy) = (hd.start[0] * w, hd.start[1] * h);
  let (dx, dy) = ((hd.end[0] - hd.start[0]) * w, (hd.end[1] - hd.start[1]) * h);
  let start = if dx == 0.0 && dy == 0.0 {
    -std::f64::consts::FRAC_PI_2
  } else {
    dy.atan2(dx)
  };
  let far = [(-pad, -pad), (w + pad, -pad), (w + pad, h + pad), (-pad, h + pad)]
    .iter()
    .map(|(x, y)| (x - cx).hypot(y - cy))
    .fold(0.0_f64, f64::max)
    + 2.0;
  let step = TAU / n as f64;
  // The chord between two rim points sits inside the circle, so push the rim out.
  let rim = far / (step * (1.0 + WEDGE_OVERLAP) / 2.0).cos();
  let mut out = String::new();
  for i in 0..n {
    let a0 = start + step * i as f64;
    let a1 = start + step * (i as f64 + 1.0 + WEDGE_OVERLAP);
    let (c, alpha) = samples.at((i as f64 + 0.5) / n as f64);
    out.push_str(&format!(
      "<path d=\"M{} {}L{} {}L{} {}Z\" fill=\"{}\"{}/>",
      fmt(cx),
      fmt(cy),
      fmt(cx + rim * a0.cos()),
      fmt(cy + rim * a0.sin()),
      fmt(cx + rim * a1.cos()),
      fmt(cy + rim * a1.sin()),
      c.hex6(),
      if alpha < 0.999 {
        format!(" fill-opacity=\"{}\"", fmt(alpha))
      } else {
        String::new()
      }
    ));
  }
  Some(format!(
    "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"><g transform=\"translate({} {})\">{out}</g></pattern>",
    fmt(-pad),
    fmt(-pad),
    fmt(w + 2.0 * pad),
    fmt(h + 2.0 * pad),
    fmt(pad),
    fmt(pad)
  ))
}

/// Image pattern for `ScaleMode::Crop`: the whole image stretched over `crop`, which is given
/// relative to the layer box and may reach outside it.
pub fn crop_pattern(id: &str, src: &str, opacity: f64, crop: &ImageCrop, w: f64, h: f64) -> String {
  format!(
    "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" width=\"{}\" height=\"{}\"><image href=\"{}\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" opacity=\"{}\"/></pattern>",
    fmt(w.max(1.0)),
    fmt(h.max(1.0)),
    crate::render::esc(src),
    fmt(crop.x * w),
    fmt(crop.y * h),
    fmt(crop.w * w),
    fmt(crop.h * h),
    fmt(opacity)
  )
}

/// Outline of a stroke with one weight per side (top, right, bottom, left) as a ring to fill
/// with `fill-rule="evenodd"`. `radii` are the corner radii (top-left, top-right,
/// bottom-right, bottom-left). Inner radii shrink by the weights next to the corner.
pub fn ring_path(w: f64, h: f64, weights: [f64; 4], align: StrokeAlign, radii: [f64; 4]) -> String {
  let [t, r, b, l] = weights.map(|v| v.max(0.0));
  let (out, inn) = match align {
    StrokeAlign::Inside => ([0.0; 4], [t, r, b, l]),
    StrokeAlign::Center => ([t / 2.0, r / 2.0, b / 2.0, l / 2.0], [t / 2.0, r / 2.0, b / 2.0, l / 2.0]),
    StrokeAlign::Outside => ([t, r, b, l], [0.0; 4]),
  };
  let grow = |rad: f64, ox: f64, oy: f64| if rad > 0.0 { (rad + ox, rad + oy) } else { (0.0, 0.0) };
  let outer = rrect(
    -out[3],
    -out[0],
    w + out[1],
    h + out[2],
    [
      grow(radii[0], out[3], out[0]),
      grow(radii[1], out[1], out[0]),
      grow(radii[2], out[1], out[2]),
      grow(radii[3], out[3], out[2]),
    ],
  );
  let shrink = |rad: f64, ix: f64, iy: f64| ((rad - ix).max(0.0), (rad - iy).max(0.0));
  let (ix0, iy0, ix1, iy1) = (inn[3], inn[0], w - inn[1], h - inn[2]);
  if ix1 <= ix0 || iy1 <= iy0 {
    return outer;
  }
  let inner = rrect(
    ix0,
    iy0,
    ix1,
    iy1,
    [
      shrink(radii[0], inn[3], inn[0]),
      shrink(radii[1], inn[1], inn[0]),
      shrink(radii[2], inn[1], inn[2]),
      shrink(radii[3], inn[3], inn[2]),
    ],
  );
  format!("{outer}{inner}")
}

/// How far a per-side stroke reaches past the box: left, top, right, bottom.
pub fn ring_margins(weights: [f64; 4], align: StrokeAlign) -> [f64; 4] {
  let [t, r, b, l] = weights.map(|v| v.max(0.0));
  let f = |v: f64| match align {
    StrokeAlign::Inside => 0.0,
    StrokeAlign::Center => v / 2.0,
    StrokeAlign::Outside => v,
  };
  [f(l), f(t), f(r), f(b)]
}

/// Rounded rectangle with elliptical corners (rx, ry per corner), scaled down when they overlap.
fn rrect(x0: f64, y0: f64, x1: f64, y1: f64, radii: [(f64, f64); 4]) -> String {
  let (w, h) = ((x1 - x0).max(0.0), (y1 - y0).max(0.0));
  let fit = |a: f64, b: f64, size: f64| if a + b > size && a + b > 0.0 { size / (a + b) } else { 1.0 };
  let k = fit(radii[0].0, radii[1].0, w)
    .min(fit(radii[3].0, radii[2].0, w))
    .min(fit(radii[0].1, radii[3].1, h))
    .min(fit(radii[1].1, radii[2].1, h));
  let [(tlx, tly), (trx, try_), (brx, bry), (blx, bly)] = radii.map(|(a, b)| (a * k, b * k));
  let arc = |rx: f64, ry: f64, x: f64, y: f64| {
    if rx <= 0.0 || ry <= 0.0 {
      format!("L{} {}", fmt(x), fmt(y))
    } else {
      format!("A{} {} 0 0 1 {} {}", fmt(rx), fmt(ry), fmt(x), fmt(y))
    }
  };
  format!(
    "M{} {}H{}{}V{}{}H{}{}V{}{}Z",
    fmt(x0 + tlx),
    fmt(y0),
    fmt(x1 - trx),
    arc(trx, try_, x1, y0 + try_),
    fmt(y1 - bry),
    arc(brx, bry, x1 - brx, y1),
    fmt(x0 + blx),
    arc(blx, bly, x0, y1 - bly),
    fmt(y0 + tly),
    arc(tlx, tly, x0 + tlx, y0),
  )
}

/// The two gradient axes in layer pixels: u runs start to end, v start to width.
struct Axes {
  c: [f64; 2],
  a: [f64; 2],
  b: [f64; 2],
}

impl Axes {
  fn new(hd: &GradientHandles, w: f64, h: f64) -> Axes {
    let c = [hd.start[0] * w, hd.start[1] * h];
    Axes {
      c,
      a: [hd.end[0] * w - c[0], hd.end[1] * h - c[1]],
      b: [hd.width[0] * w - c[0], hd.width[1] * h - c[1]],
    }
  }

  fn matrix(&self) -> String {
    format!(
      "matrix({} {} {} {} {} {})",
      fmt(self.a[0]),
      fmt(self.a[1]),
      fmt(self.b[0]),
      fmt(self.b[1]),
      fmt(self.c[0]),
      fmt(self.c[1])
    )
  }

  fn det(&self) -> f64 {
    self.a[0] * self.b[1] - self.a[1] * self.b[0]
  }

  fn min_len(&self) -> f64 {
    self.a[0].hypot(self.a[1]).min(self.b[0].hypot(self.b[1]))
  }

  fn to_uv(&self, p: [f64; 2]) -> [f64; 2] {
    let (dx, dy) = (p[0] - self.c[0], p[1] - self.c[1]);
    let det = self.det();
    [(dx * self.b[1] - dy * self.b[0]) / det, (dy * self.a[0] - dx * self.a[1]) / det]
  }

  fn corners(&self, w: f64, h: f64, pad: f64) -> [[f64; 2]; 4] {
    [[-pad, -pad], [w + pad, -pad], [w + pad, h + pad], [-pad, h + pad]]
  }
}

/// Colour of a gradient at any position, interpolated like SVG does between stops.
struct Sampler {
  stops: Vec<(f64, Rgba)>,
  opacity: f64,
}

impl Sampler {
  fn new(stops: &[GradientStop], opacity: f64) -> Option<Sampler> {
    let mut s: Vec<(f64, Rgba)> = stops
      .iter()
      .map(|s| (s.position, color::parse(&s.color).unwrap_or(Rgba::BLACK)))
      .collect();
    if s.is_empty() {
      return None;
    }
    s.sort_by(|a, b| a.0.total_cmp(&b.0));
    Some(Sampler { stops: s, opacity })
  }

  /// Colour and alpha (stop alpha times the paint's opacity) at `t`.
  fn at(&self, t: f64) -> (Rgba, f64) {
    let first = &self.stops[0];
    let last = &self.stops[self.stops.len() - 1];
    let (c, a) = if t <= first.0 {
      (first.1, first.1.a)
    } else if t >= last.0 {
      (last.1, last.1.a)
    } else {
      let i = self.stops.iter().position(|s| s.0 >= t).unwrap_or(1).max(1);
      let (p, q) = (&self.stops[i - 1], &self.stops[i]);
      let k = if q.0 > p.0 { (t - p.0) / (q.0 - p.0) } else { 1.0 };
      let mix = |x: u8, y: u8| (x as f64 + (y as f64 - x as f64) * k).round() as u8;
      (
        Rgba {
          r: mix(p.1.r, q.1.r),
          g: mix(p.1.g, q.1.g),
          b: mix(p.1.b, q.1.b),
          a: 1.0,
        },
        p.1.a + (q.1.a - p.1.a) * k,
      )
    };
    (c, a * self.opacity)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::model::{Document, Node, NodeType, Paint, ScaleMode, StrokeJoin};
  use crate::render::{export_svg, render_bounds, render_root};
  use crate::render::{Mode, RenderOptions};
  use crate::text::HeuristicMeasurer;

  fn stops() -> Vec<GradientStop> {
    vec![
      GradientStop {
        color: "#FF0000".into(),
        position: 0.0,
      },
      GradientStop {
        color: "#0000FF".into(),
        position: 1.0,
      },
    ]
  }

  fn doc_with(kind: NodeType, w: f64, h: f64, f: impl FnOnce(&mut Node)) -> Document {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut n = crate::ops::default_node(kind, "r".into(), "R".into());
    n.width = w;
    n.height = h;
    n.x = 100.0;
    n.y = 100.0;
    n.fills.clear();
    n.strokes.clear();
    n.stroke_weight = 0.0;
    f(&mut n);
    doc.insert(n, None, &page, None);
    doc
  }

  fn svg(doc: &Document) -> String {
    export_svg(doc, "r", &HeuristicMeasurer)
  }

  fn angular(handles: Option<GradientHandles>) -> Paint {
    Paint::AngularGradient {
      stops: stops(),
      opacity: 1.0,
      visible: true,
      handles,
    }
  }

  #[test]
  fn old_paints_round_trip_unchanged() {
    for src in [
      r##"{"type":"linearGradient","stops":[{"color":"#FF0000","position":0.0}],"angle":90.0,"opacity":1.0,"visible":true}"##,
      r##"{"type":"radialGradient","stops":[{"color":"#FF0000","position":0.0}],"opacity":1.0,"visible":true}"##,
      r##"{"type":"image","src":"asset:a","scaleMode":"fill","opacity":1.0,"visible":true}"##,
    ] {
      let p: Paint = serde_json::from_str(src).unwrap();
      assert_eq!(serde_json::to_string(&p).unwrap(), src);
    }
    let v = serde_json::to_value(Node::default()).unwrap();
    assert!(v.get("strokeWeights").is_none() && v.get("strokeJoin").is_none());
  }

  #[test]
  fn new_paints_round_trip() {
    let hd = GradientHandles {
      start: [0.5, 0.5],
      end: [1.0, 0.5],
      width: [0.5, 1.0],
    };
    for p in [
      angular(Some(hd)),
      Paint::DiamondGradient {
        stops: stops(),
        opacity: 0.5,
        visible: true,
        handles: None,
      },
      Paint::Image {
        src: "asset:a".into(),
        scale_mode: ScaleMode::Crop,
        opacity: 1.0,
        visible: true,
        crop: Some(ImageCrop {
          x: -0.1,
          y: 0.0,
          w: 1.5,
          h: 1.2,
        }),
      },
    ] {
      let json = serde_json::to_string(&p).unwrap();
      assert_eq!(serde_json::from_str::<Paint>(&json).unwrap(), p);
    }
    assert!(serde_json::to_string(&angular(None)).unwrap().contains("\"angularGradient\""));
  }

  #[test]
  fn angular_renders_a_wedge_pattern_the_fill_references() {
    let doc = doc_with(NodeType::Rectangle, 100.0, 100.0, |n| n.fills = vec![angular(None)]);
    let s = svg(&doc);
    let pat = s.split("<pattern").nth(1).expect("pattern");
    assert!(pat.matches("<path").count() >= 180, "wedges: {}", pat.matches("<path").count());
    assert!(s.contains("fill=\"url(#ag1)\""));
    // Big boxes get the finer ring.
    let big = doc_with(NodeType::Rectangle, 1200.0, 100.0, |n| n.fills = vec![angular(None)]);
    assert!(svg(&big).matches("<path").count() >= 360);
  }

  #[test]
  fn diamond_renders_four_quadrant_gradients() {
    let doc = doc_with(NodeType::Rectangle, 100.0, 100.0, |n| {
      n.fills = vec![Paint::DiamondGradient {
        stops: stops(),
        opacity: 1.0,
        visible: true,
        handles: None,
      }]
    });
    let s = svg(&doc);
    assert_eq!(s.matches("<linearGradient").count(), 4);
    assert_eq!(s.matches("<rect x=").count(), 4);
    assert!(s.contains("fill=\"url(#dg1)\""));
  }

  #[test]
  fn linear_handles_set_the_gradient_line() {
    let hd = GradientHandles {
      start: [0.0, 0.5],
      end: [1.0, 0.5],
      width: [0.0, 1.0],
    };
    let doc = doc_with(NodeType::Rectangle, 100.0, 100.0, |n| {
      n.fills = vec![Paint::LinearGradient {
        stops: stops(),
        angle: 90.0,
        opacity: 1.0,
        visible: true,
        handles: Some(hd),
      }]
    });
    let s = svg(&doc);
    assert!(s.contains("x1=\"0\" y1=\"50\" x2=\"100\" y2=\"50\""), "{s}");
  }

  #[test]
  fn radial_handles_use_a_gradient_transform() {
    let hd = GradientHandles {
      start: [0.5, 0.5],
      end: [1.0, 0.5],
      width: [0.5, 0.75],
    };
    let doc = doc_with(NodeType::Rectangle, 100.0, 100.0, |n| {
      n.fills = vec![Paint::RadialGradient {
        stops: stops(),
        opacity: 1.0,
        visible: true,
        handles: Some(hd),
      }]
    });
    assert!(svg(&doc).contains("gradientTransform=\"matrix(50 0 0 25 50 50)\""));
  }

  #[test]
  fn per_side_stroke_is_a_ring_with_one_band() {
    let doc = doc_with(NodeType::Rectangle, 100.0, 60.0, |n| {
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_weights = Some([4.0, 0.0, 0.0, 0.0]);
    });
    let s = svg(&doc);
    assert!(s.contains("fill-rule=\"evenodd\""));
    // Outer is the box; the inner is the box minus a 4 px top band.
    assert!(s.contains("M0 0H100L100 0V60L100 60H0L0 60V0L0 0Z"), "{s}");
    assert!(s.contains("M0 4H100L100 4V60L100 60H0L0 60V4L0 4Z"), "{s}");
  }

  #[test]
  fn per_side_outside_stroke_only_grows_those_sides() {
    let mut doc = doc_with(NodeType::Rectangle, 100.0, 60.0, |n| {
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_weights = Some([4.0, 0.0, 0.0, 10.0]);
      n.stroke_align = StrokeAlign::Outside;
    });
    let b = render_bounds(&doc, "r", &HeuristicMeasurer);
    assert_eq!((b.x, b.y, b.width, b.height), (90.0, 96.0, 110.0, 64.0));
    doc.get_mut("r").unwrap().stroke_align = StrokeAlign::Center;
    let b = render_bounds(&doc, "r", &HeuristicMeasurer);
    assert_eq!((b.x, b.y, b.width, b.height), (95.0, 98.0, 105.0, 62.0));
  }

  #[test]
  fn ring_radii_shrink_inside_and_grow_outside() {
    let inside = ring_path(100.0, 100.0, [10.0; 4], StrokeAlign::Inside, [16.0; 4]);
    assert!(inside.contains("A16 16") && inside.contains("A6 6"), "{inside}");
    let outside = ring_path(100.0, 100.0, [10.0; 4], StrokeAlign::Outside, [16.0; 4]);
    assert!(outside.contains("A26 26") && outside.contains("A16 16"), "{outside}");
    // A radius smaller than the weight leaves a sharp inner corner.
    assert!(!ring_path(100.0, 100.0, [10.0; 4], StrokeAlign::Inside, [4.0; 4]).contains("A0"));
  }

  #[test]
  fn stroke_join_defaults_to_round_and_can_be_set() {
    let mut doc = doc_with(NodeType::Star, 100.0, 100.0, |n| {
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_weight = 4.0;
      n.stroke_align = StrokeAlign::Center;
    });
    assert!(svg(&doc).contains("stroke-linejoin=\"round\""));
    doc.get_mut("r").unwrap().stroke_join = Some(StrokeJoin::Miter);
    let s = svg(&doc);
    assert!(s.contains("stroke-linejoin=\"miter\"") && !s.contains("stroke-linejoin=\"round\""));
    doc.get_mut("r").unwrap().stroke_join = Some(StrokeJoin::Bevel);
    doc.get_mut("r").unwrap().stroke_dash = vec![10.0, 5.0];
    let s = svg(&doc);
    assert!(s.contains("stroke-linejoin=\"bevel\"") && s.contains("stroke-dasharray=\"10 5\""));
    // The inside-aligned path and a rectangle say it once too.
    doc.get_mut("r").unwrap().stroke_align = StrokeAlign::Inside;
    assert_eq!(svg(&doc).matches("stroke-linejoin=").count(), 1);
    let rect = doc_with(NodeType::Rectangle, 50.0, 50.0, |n| {
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_weight = 4.0;
      n.stroke_join = Some(StrokeJoin::Round);
    });
    assert_eq!(svg(&rect).matches("stroke-linejoin=\"round\"").count(), 1);
  }

  #[test]
  fn crop_places_the_whole_image_in_the_box() {
    let doc = doc_with(NodeType::Rectangle, 100.0, 50.0, |n| {
      n.fills = vec![Paint::Image {
        src: "asset:a".into(),
        scale_mode: ScaleMode::Crop,
        opacity: 1.0,
        visible: true,
        crop: Some(ImageCrop {
          x: -0.2,
          y: 0.1,
          w: 1.5,
          h: 2.0,
        }),
      }]
    });
    let s = svg(&doc);
    assert!(
      s.contains("x=\"-20\" y=\"5\" width=\"150\" height=\"100\" preserveAspectRatio=\"none\""),
      "{s}"
    );
  }

  #[test]
  fn canvas_defs_stay_inside_the_root_markup() {
    let doc = doc_with(NodeType::Rectangle, 100.0, 100.0, |n| n.fills = vec![angular(None)]);
    let out = render_root(
      &doc,
      "r",
      &HeuristicMeasurer,
      RenderOptions {
        mode: Mode::Canvas,
        hidden: &[],
      },
    );
    assert!(out.starts_with("<defs><pattern id=\"r_ag1\""), "{}", &out[..80.min(out.len())]);
  }

  #[test]
  fn angular_colours_sweep_clockwise_from_the_end_handle() {
    let s = Sampler::new(&stops(), 1.0).unwrap();
    assert_eq!(s.at(0.0).0.hex6(), "#FF0000");
    assert_eq!(s.at(1.0).0.hex6(), "#0000FF");
    assert_eq!(s.at(0.5).0.hex6(), "#800080");
    assert_eq!(handle_angle(&default_handles(true), 100.0, 100.0), 0.0);
    assert_eq!(handle_angle(&default_handles(false), 100.0, 100.0), 90.0);
  }
}
