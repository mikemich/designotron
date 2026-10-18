//! 2D affine geometry.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct Point {
  pub x: f64,
  pub y: f64,
}

impl Point {
  pub fn new(x: f64, y: f64) -> Self {
    Point { x, y }
  }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct Rect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

impl Rect {
  pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
    Rect { x, y, width, height }
  }

  /// Normalised rect between two corner points.
  pub fn from_points(a: Point, b: Point) -> Self {
    Rect::new(a.x.min(b.x), a.y.min(b.y), (a.x - b.x).abs(), (a.y - b.y).abs())
  }

  pub fn right(&self) -> f64 {
    self.x + self.width
  }

  pub fn bottom(&self) -> f64 {
    self.y + self.height
  }

  pub fn center(&self) -> Point {
    Point::new(self.x + self.width / 2.0, self.y + self.height / 2.0)
  }

  pub fn contains(&self, p: Point) -> bool {
    p.x >= self.x && p.x <= self.right() && p.y >= self.y && p.y <= self.bottom()
  }

  pub fn contains_rect(&self, r: &Rect) -> bool {
    r.x >= self.x && r.y >= self.y && r.right() <= self.right() && r.bottom() <= self.bottom()
  }

  pub fn intersects(&self, r: &Rect) -> bool {
    self.x <= r.right() && r.x <= self.right() && self.y <= r.bottom() && r.y <= self.bottom()
  }

  pub fn union(&self, r: &Rect) -> Rect {
    let x = self.x.min(r.x);
    let y = self.y.min(r.y);
    Rect::new(x, y, self.right().max(r.right()) - x, self.bottom().max(r.bottom()) - y)
  }

  pub fn union_all<I: IntoIterator<Item = Rect>>(rects: I) -> Option<Rect> {
    rects.into_iter().reduce(|a, b| a.union(&b))
  }
}

/// Affine matrix `[a c e; b d f; 0 0 1]`, SVG/canvas convention.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Mat {
  pub a: f64,
  pub b: f64,
  pub c: f64,
  pub d: f64,
  pub e: f64,
  pub f: f64,
}

impl Default for Mat {
  fn default() -> Self {
    Mat::IDENTITY
  }
}

impl Mat {
  pub const IDENTITY: Mat = Mat {
    a: 1.0,
    b: 0.0,
    c: 0.0,
    d: 1.0,
    e: 0.0,
    f: 0.0,
  };

  pub fn translate(x: f64, y: f64) -> Mat {
    Mat {
      e: x,
      f: y,
      ..Mat::IDENTITY
    }
  }

  pub fn scale(sx: f64, sy: f64) -> Mat {
    Mat {
      a: sx,
      d: sy,
      ..Mat::IDENTITY
    }
  }

  pub fn rotate_deg(deg: f64) -> Mat {
    let r = deg.to_radians();
    let (s, c) = r.sin_cos();
    Mat {
      a: c,
      b: s,
      c: -s,
      d: c,
      e: 0.0,
      f: 0.0,
    }
  }

  /// `self * other` - applies `other` first, then `self`.
  pub fn mul(&self, o: &Mat) -> Mat {
    Mat {
      a: self.a * o.a + self.c * o.b,
      b: self.b * o.a + self.d * o.b,
      c: self.a * o.c + self.c * o.d,
      d: self.b * o.c + self.d * o.d,
      e: self.a * o.e + self.c * o.f + self.e,
      f: self.b * o.e + self.d * o.f + self.f,
    }
  }

  pub fn apply(&self, p: Point) -> Point {
    Point::new(self.a * p.x + self.c * p.y + self.e, self.b * p.x + self.d * p.y + self.f)
  }

  /// Applies only the linear part (for direction vectors).
  pub fn apply_vec(&self, p: Point) -> Point {
    Point::new(self.a * p.x + self.c * p.y, self.b * p.x + self.d * p.y)
  }

  pub fn invert(&self) -> Mat {
    let det = self.a * self.d - self.b * self.c;
    if det.abs() < 1e-12 {
      return Mat::IDENTITY;
    }
    let inv = 1.0 / det;
    Mat {
      a: self.d * inv,
      b: -self.b * inv,
      c: -self.c * inv,
      d: self.a * inv,
      e: (self.c * self.f - self.d * self.e) * inv,
      f: (self.b * self.e - self.a * self.f) * inv,
    }
  }

  pub fn is_identity(&self) -> bool {
    *self == Mat::IDENTITY
  }

  /// Axis-aligned bounds of a local `w × h` box transformed by this matrix.
  pub fn bounds_of(&self, w: f64, h: f64) -> Rect {
    let pts = [
      self.apply(Point::new(0.0, 0.0)),
      self.apply(Point::new(w, 0.0)),
      self.apply(Point::new(w, h)),
      self.apply(Point::new(0.0, h)),
    ];
    let min_x = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let min_y = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let max_x = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
    let max_y = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
    Rect::new(min_x, min_y, max_x - min_x, max_y - min_y)
  }

  pub fn svg(&self) -> String {
    format!(
      "matrix({} {} {} {} {} {})",
      fmt(self.a),
      fmt(self.b),
      fmt(self.c),
      fmt(self.d),
      fmt(self.e),
      fmt(self.f)
    )
  }
}

/// Local transform of a node box: translate to (x, y), then rotate/flip around the centre.
pub fn local_matrix(x: f64, y: f64, w: f64, h: f64, rotation: f64, flip_x: bool, flip_y: bool) -> Mat {
  let mut m = Mat::translate(x, y);
  if rotation != 0.0 || flip_x || flip_y {
    let cx = w / 2.0;
    let cy = h / 2.0;
    m = m
      .mul(&Mat::translate(cx, cy))
      .mul(&Mat::rotate_deg(rotation))
      .mul(&Mat::scale(if flip_x { -1.0 } else { 1.0 }, if flip_y { -1.0 } else { 1.0 }))
      .mul(&Mat::translate(-cx, -cy));
  }
  m
}

/// Compact number formatting for SVG/CSS output.
pub fn fmt(v: f64) -> String {
  if !v.is_finite() {
    return "0".into();
  }
  let r = (v * 1000.0).round() / 1000.0;
  if r == r.trunc() {
    format!("{}", r as i64)
  } else {
    let s = format!("{:.3}", r);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
  }
}

pub fn dist(a: Point, b: Point) -> f64 {
  ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

pub fn dist_to_segment(p: Point, a: Point, b: Point) -> f64 {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let len2 = dx * dx + dy * dy;
  if len2 == 0.0 {
    return dist(p, a);
  }
  let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0);
  dist(p, Point::new(a.x + t * dx, a.y + t * dy))
}

pub fn point_in_polygon(p: Point, poly: &[Point]) -> bool {
  let mut inside = false;
  let n = poly.len();
  if n < 3 {
    return false;
  }
  let mut j = n - 1;
  for i in 0..n {
    let (pi, pj) = (poly[i], poly[j]);
    if (pi.y > p.y) != (pj.y > p.y) && p.x < (pj.x - pi.x) * (p.y - pi.y) / (pj.y - pi.y) + pi.x {
      inside = !inside;
    }
    j = i;
  }
  inside
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn invert_roundtrip() {
    let m = local_matrix(10.0, 20.0, 100.0, 50.0, 33.0, false, false);
    let p = Point::new(7.0, 9.0);
    let q = m.invert().apply(m.apply(p));
    assert!((q.x - p.x).abs() < 1e-9 && (q.y - p.y).abs() < 1e-9);
  }

  #[test]
  fn rotation_keeps_center() {
    let m = local_matrix(0.0, 0.0, 100.0, 50.0, 90.0, false, false);
    let c = m.apply(Point::new(50.0, 25.0));
    assert!((c.x - 50.0).abs() < 1e-9 && (c.y - 25.0).abs() < 1e-9);
  }

  #[test]
  fn fmt_trims() {
    assert_eq!(fmt(1.5), "1.5");
    assert_eq!(fmt(2.0), "2");
    assert_eq!(fmt(0.33333), "0.333");
  }
}
