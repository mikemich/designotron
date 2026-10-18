//! Shape geometry: SVG path data and flattened outlines for hit-testing.

use crate::geom::{fmt, Point};
use crate::model::{Node, NodeType, SubPath};

pub fn corner_radii(n: &Node) -> [f64; 4] {
  let max = (n.width.min(n.height) / 2.0).max(0.0);
  let r = n.corner_radii.unwrap_or([n.corner_radius; 4]);
  [r[0].min(max), r[1].min(max), r[2].min(max), r[3].min(max)]
}

pub fn has_uniform_radius(n: &Node) -> bool {
  let r = corner_radii(n);
  r.iter().all(|v| (*v - r[0]).abs() < 1e-9)
}

/// Rounded rectangle path with independent corners, inset by `inset` on every side.
pub fn rounded_rect_path(w: f64, h: f64, r: [f64; 4], inset: f64) -> String {
  let (x0, y0, x1, y1) = (inset, inset, w - inset, h - inset);
  let adj = |v: f64| (v - inset).max(0.0);
  let [tl, tr, br, bl] = [adj(r[0]), adj(r[1]), adj(r[2]), adj(r[3])];
  format!(
    "M{} {}H{}{}V{}{}H{}{}V{}{}Z",
    fmt(x0 + tl),
    fmt(y0),
    fmt(x1 - tr),
    arc(tr, x1, y0 + tr),
    fmt(y1 - br),
    arc(br, x1 - br, y1),
    fmt(x0 + bl),
    arc(bl, x0, y1 - bl),
    fmt(y0 + tl),
    arc(tl, x0 + tl, y0),
  )
}

fn arc(r: f64, x: f64, y: f64) -> String {
  if r <= 0.0 {
    format!("L{} {}", fmt(x), fmt(y))
  } else {
    format!("A{} {} 0 0 1 {} {}", fmt(r), fmt(r), fmt(x), fmt(y))
  }
}

/// Regular polygon or star outline points within the node box.
pub fn polygon_points(n: &Node) -> Vec<Point> {
  let shape = n.shape.clone().unwrap_or_default();
  let count = shape.point_count.max(3) as usize;
  let (cx, cy) = (n.width / 2.0, n.height / 2.0);
  let (rx, ry) = (n.width / 2.0, n.height / 2.0);
  let star = n.kind == NodeType::Star;
  let steps = if star { count * 2 } else { count };
  (0..steps)
    .map(|i| {
      let a = -std::f64::consts::FRAC_PI_2 + i as f64 * std::f64::consts::TAU / steps as f64;
      let k = if star && i % 2 == 1 { shape.inner_radius } else { 1.0 };
      Point::new(cx + a.cos() * rx * k, cy + a.sin() * ry * k)
    })
    .collect()
}

pub fn points_path(pts: &[Point]) -> String {
  let mut d = String::new();
  for (i, p) in pts.iter().enumerate() {
    d.push_str(&format!("{}{} {}", if i == 0 { "M" } else { "L" }, fmt(p.x), fmt(p.y)));
  }
  d.push('Z');
  d
}

pub fn subpath_d(sp: &SubPath) -> String {
  let pts = &sp.points;
  if pts.is_empty() {
    return String::new();
  }
  let mut d = format!("M{} {}", fmt(pts[0].x), fmt(pts[0].y));
  let seg = |a: &crate::model::VectorPoint, b: &crate::model::VectorPoint| -> String {
    if a.out_x == 0.0 && a.out_y == 0.0 && b.in_x == 0.0 && b.in_y == 0.0 {
      format!("L{} {}", fmt(b.x), fmt(b.y))
    } else {
      format!(
        "C{} {} {} {} {} {}",
        fmt(a.x + a.out_x),
        fmt(a.y + a.out_y),
        fmt(b.x + b.in_x),
        fmt(b.y + b.in_y),
        fmt(b.x),
        fmt(b.y)
      )
    }
  };
  for w in pts.windows(2) {
    d.push_str(&seg(&w[0], &w[1]));
  }
  if sp.closed && pts.len() > 1 {
    d.push_str(&seg(&pts[pts.len() - 1], &pts[0]));
    d.push('Z');
  }
  d
}

/// Path data for a vector node's own subpaths (raw paths are handled by the renderer).
pub fn vector_d(n: &Node) -> String {
  n.vector.as_ref().map(|v| v.subpaths.iter().map(subpath_d).collect::<Vec<_>>().join(" ")).unwrap_or_default()
}

/// Flattens subpaths to polylines (cubic segments sampled) for hit-testing.
pub fn flatten_subpath(sp: &SubPath) -> Vec<Point> {
  let pts = &sp.points;
  let mut out = Vec::new();
  if pts.is_empty() {
    return out;
  }
  out.push(Point::new(pts[0].x, pts[0].y));
  let mut seg = |a: &crate::model::VectorPoint, b: &crate::model::VectorPoint| {
    let p0 = Point::new(a.x, a.y);
    let p1 = Point::new(a.x + a.out_x, a.y + a.out_y);
    let p2 = Point::new(b.x + b.in_x, b.y + b.in_y);
    let p3 = Point::new(b.x, b.y);
    for i in 1..=12 {
      let t = i as f64 / 12.0;
      let u = 1.0 - t;
      out.push(Point::new(
        u * u * u * p0.x + 3.0 * u * u * t * p1.x + 3.0 * u * t * t * p2.x + t * t * t * p3.x,
        u * u * u * p0.y + 3.0 * u * u * t * p1.y + 3.0 * u * t * t * p2.y + t * t * t * p3.y,
      ));
    }
  };
  for w in pts.windows(2) {
    seg(&w[0], &w[1]);
  }
  if sp.closed && pts.len() > 1 {
    seg(&pts[pts.len() - 1], &pts[0]);
  }
  out
}

/// Bounding box of subpath anchors and handles.
pub fn subpaths_bounds(sps: &[SubPath]) -> Option<(f64, f64, f64, f64)> {
  let mut it = sps.iter().flat_map(flatten_subpath);
  let first = it.next()?;
  let (mut x0, mut y0, mut x1, mut y1) = (first.x, first.y, first.x, first.y);
  for p in it {
    x0 = x0.min(p.x);
    y0 = y0.min(p.y);
    x1 = x1.max(p.x);
    y1 = y1.max(p.y);
  }
  Some((x0, y0, x1, y1))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::model::VectorPoint;

  #[test]
  fn rect_path_has_arcs() {
    let d = rounded_rect_path(100.0, 50.0, [8.0, 8.0, 0.0, 0.0], 0.0);
    assert!(d.starts_with("M8 0"));
    assert_eq!(d.matches('A').count(), 2);
  }

  #[test]
  fn subpath_curves() {
    let sp = SubPath {
      points: vec![VectorPoint { out_x: 10.0, ..VectorPoint::at(0.0, 0.0) }, VectorPoint::at(20.0, 20.0)],
      closed: false,
    };
    assert_eq!(subpath_d(&sp), "M0 0C10 0 20 20 20 20");
  }
}
