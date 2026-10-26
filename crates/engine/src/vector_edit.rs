//! Vector edit mode geometry: inserting anchors on segments (exact Bézier subdivision),
//! deleting anchors, sharp/smooth anchors, continuing open paths, finding the segment
//! under the pointer and keeping a vector's box fitted to its path.
//!
//! A segment `seg` of a subpath runs from anchor `seg` to anchor `seg + 1` (the last
//! segment of a closed subpath wraps to anchor 0). Its cubic control points are
//! `a`, `a + a.out`, `b + b.in`, `b`.

use std::collections::HashSet;

use serde::Serialize;

use crate::geom::{local_matrix, Mat, Point};
use crate::model::{Node, SubPath, VectorData, VectorPoint};

/// Coarse samples per segment before refining the nearest point.
const NEAREST_SAMPLES: usize = 32;
/// Golden-section refinement steps around the best sample.
const NEAREST_REFINE: usize = 40;

/// The point on a vector's path nearest to a query point.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SegmentHit {
  pub sub: usize,
  pub seg: usize,
  pub t: f64,
  /// The point on the curve, in node-local coordinates.
  pub x: f64,
  pub y: f64,
  pub dist: f64,
}

/// Number of segments in a subpath.
pub fn segment_count(sp: &SubPath) -> usize {
  let n = sp.points.len();
  match (n, sp.closed) {
    (0 | 1, _) => 0,
    (_, true) => n,
    (_, false) => n - 1,
  }
}

/// Cubic control points of segment `seg`.
pub fn segment(sp: &SubPath, seg: usize) -> [Point; 4] {
  let n = sp.points.len();
  let a = sp.points[seg];
  let b = sp.points[(seg + 1) % n];
  [
    Point::new(a.x, a.y),
    Point::new(a.x + a.out_x, a.y + a.out_y),
    Point::new(b.x + b.in_x, b.y + b.in_y),
    Point::new(b.x, b.y),
  ]
}

/// Point on a cubic at parameter `t`.
pub fn cubic_at(c: &[Point; 4], t: f64) -> Point {
  let u = 1.0 - t;
  let (w0, w1, w2, w3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
  Point::new(
    w0 * c[0].x + w1 * c[1].x + w2 * c[2].x + w3 * c[3].x,
    w0 * c[0].y + w1 * c[1].y + w2 * c[2].y + w3 * c[3].y,
  )
}

/// Inserts an anchor on segment `seg` at parameter `t` (0 < t < 1) without changing the
/// shape: de Casteljau subdivision for curves, a plain split for straight segments.
/// Returns the new anchor's index.
pub fn insert_point(sp: &mut SubPath, seg: usize, t: f64) -> Result<usize, String> {
  if seg >= segment_count(sp) {
    return Err("no such segment".into());
  }
  if !(t > 0.0 && t < 1.0) {
    return Err("the new point must lie inside the segment".into());
  }
  let n = sp.points.len();
  let (ia, ib) = (seg, (seg + 1) % n);
  let c = segment(sp, seg);
  let lerp = |p: Point, q: Point| Point::new(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t);
  let straight = {
    let (a, b) = (sp.points[ia], sp.points[ib]);
    a.out_x == 0.0 && a.out_y == 0.0 && b.in_x == 0.0 && b.in_y == 0.0
  };
  let new = if straight {
    // The point the pointer is over (`t` is the cubic's parameter); it lies on the line.
    let m = cubic_at(&c, t);
    VectorPoint::at(m.x, m.y)
  } else {
    let p01 = lerp(c[0], c[1]);
    let p12 = lerp(c[1], c[2]);
    let p23 = lerp(c[2], c[3]);
    let p012 = lerp(p01, p12);
    let p123 = lerp(p12, p23);
    let m = lerp(p012, p123);
    let a = &mut sp.points[ia];
    a.out_x = p01.x - c[0].x;
    a.out_y = p01.y - c[0].y;
    let b = &mut sp.points[ib];
    b.in_x = p23.x - c[3].x;
    b.in_y = p23.y - c[3].y;
    VectorPoint {
      x: m.x,
      y: m.y,
      in_x: p012.x - m.x,
      in_y: p012.y - m.y,
      out_x: p123.x - m.x,
      out_y: p123.y - m.y,
    }
  };
  sp.points.insert(seg + 1, new);
  Ok(seg + 1)
}

/// Deletes anchors given as `[subpath, index]`. Neighbours of a deleted interior anchor are
/// joined and keep their handles (so the curve stays close); deleting an endpoint shortens
/// an open path. Closed subpaths stay closed while they have three or more anchors, and
/// subpaths left with fewer than two anchors are removed. Returns false when nothing is left.
pub fn delete_points(v: &mut VectorData, refs: &[[usize; 2]]) -> bool {
  for (si, sp) in v.subpaths.iter_mut().enumerate() {
    let kill: HashSet<usize> = refs.iter().filter(|r| r[0] == si).map(|r| r[1]).collect();
    if kill.is_empty() {
      continue;
    }
    let mut i = 0;
    sp.points.retain(|_| {
      i += 1;
      !kill.contains(&(i - 1))
    });
    if sp.closed && sp.points.len() < 3 {
      sp.closed = false;
    }
  }
  v.subpaths.retain(|sp| sp.points.len() >= 2);
  !v.subpaths.is_empty()
}

/// Makes anchors smooth (handles along the neighbours' direction, a third of the distance
/// to each neighbour) or sharp (no handles).
pub fn set_smooth(v: &mut VectorData, refs: &[[usize; 2]], smooth: bool) {
  for &[si, pi] in refs {
    let Some(sp) = v.subpaths.get_mut(si) else { continue };
    let n = sp.points.len();
    if pi >= n {
      continue;
    }
    if !smooth {
      let p = &mut sp.points[pi];
      (p.in_x, p.in_y, p.out_x, p.out_y) = (0.0, 0.0, 0.0, 0.0);
      continue;
    }
    let p = sp.points[pi];
    let prev = if pi > 0 {
      Some(sp.points[pi - 1])
    } else if sp.closed && n > 1 {
      Some(sp.points[n - 1])
    } else {
      None
    };
    let next = if pi + 1 < n {
      Some(sp.points[pi + 1])
    } else if sp.closed && n > 1 {
      Some(sp.points[0])
    } else {
      None
    };
    let d = |q: &VectorPoint| ((q.x - p.x).powi(2) + (q.y - p.y).powi(2)).sqrt();
    let (dir, len_in, len_out) = match (prev, next) {
      (Some(a), Some(b)) => ((b.x - a.x, b.y - a.y), d(&a) / 3.0, d(&b) / 3.0),
      (Some(a), None) => ((p.x - a.x, p.y - a.y), d(&a) / 3.0, d(&a) / 3.0),
      (None, Some(b)) => ((b.x - p.x, b.y - p.y), d(&b) / 3.0, d(&b) / 3.0),
      (None, None) => continue,
    };
    let len = (dir.0 * dir.0 + dir.1 * dir.1).sqrt();
    if len < 1e-9 {
      continue;
    }
    let (ux, uy) = (dir.0 / len, dir.1 / len);
    let q = &mut sp.points[pi];
    (q.in_x, q.in_y) = (-ux * len_in, -uy * len_in);
    (q.out_x, q.out_y) = (ux * len_out, uy * len_out);
  }
}

/// True when an anchor has a handle.
pub fn is_smooth(p: &VectorPoint) -> bool {
  p.in_x != 0.0 || p.in_y != 0.0 || p.out_x != 0.0 || p.out_y != 0.0
}

/// Moves anchors (with their handles) by a node-local delta.
pub fn move_points(v: &mut VectorData, refs: &[[usize; 2]], dx: f64, dy: f64) {
  let refs: HashSet<[usize; 2]> = refs.iter().copied().collect();
  for r in refs {
    if let Some(p) = v.subpaths.get_mut(r[0]).and_then(|sp| sp.points.get_mut(r[1])) {
      p.x += dx;
      p.y += dy;
    }
  }
}

/// Continues an open subpath from one of its ends with node-local anchors (in drawing
/// order, starting next to the end), optionally closing it.
pub fn extend(v: &mut VectorData, sub: usize, prepend: bool, points: &[VectorPoint], close: bool) -> Result<(), String> {
  let sp = v.subpaths.get_mut(sub).ok_or("no such subpath")?;
  if sp.closed {
    return Err("the path is already closed".into());
  }
  if prepend {
    // Drawn outwards from the start: reverse them and swap their handles.
    let mut front: Vec<VectorPoint> = points
      .iter()
      .rev()
      .map(|p| VectorPoint {
        in_x: p.out_x,
        in_y: p.out_y,
        out_x: p.in_x,
        out_y: p.in_y,
        ..*p
      })
      .collect();
    front.append(&mut sp.points);
    sp.points = front;
  } else {
    sp.points.extend_from_slice(points);
  }
  if close && sp.points.len() >= 3 {
    sp.closed = true;
  }
  Ok(())
}

/// Nearest point on any segment of the path to `p` (node-local), if within `tol`.
pub fn nearest_segment(v: &VectorData, p: Point, tol: f64) -> Option<SegmentHit> {
  let mut best: Option<SegmentHit> = None;
  for (si, sp) in v.subpaths.iter().enumerate() {
    for seg in 0..segment_count(sp) {
      let c = segment(sp, seg);
      let dist_at = |t: f64| {
        let q = cubic_at(&c, t);
        (q.x - p.x).hypot(q.y - p.y)
      };
      let (mut bt, mut bd) = (0.0, f64::INFINITY);
      for i in 0..=NEAREST_SAMPLES {
        let t = i as f64 / NEAREST_SAMPLES as f64;
        let d = dist_at(t);
        if d < bd {
          (bt, bd) = (t, d);
        }
      }
      // Golden-section search in the neighbourhood of the best sample.
      let step = 1.0 / NEAREST_SAMPLES as f64;
      let (mut lo, mut hi) = ((bt - step).max(0.0), (bt + step).min(1.0));
      let g = (5f64.sqrt() - 1.0) / 2.0;
      for _ in 0..NEAREST_REFINE {
        let m1 = hi - g * (hi - lo);
        let m2 = lo + g * (hi - lo);
        if dist_at(m1) < dist_at(m2) {
          hi = m2;
        } else {
          lo = m1;
        }
      }
      let t = (lo + hi) / 2.0;
      let d = dist_at(t);
      if d <= tol && best.map(|b| d < b.dist).unwrap_or(true) {
        let q = cubic_at(&c, t);
        best = Some(SegmentHit {
          sub: si,
          seg,
          t,
          x: q.x,
          y: q.y,
          dist: d,
        });
      }
    }
  }
  best
}

/// Exact bounds of the path (curve extrema, not handles).
pub fn path_bounds(sps: &[SubPath]) -> Option<(f64, f64, f64, f64)> {
  let mut b: Option<(f64, f64, f64, f64)> = None;
  let mut add = |q: Point| {
    b = Some(match b {
      None => (q.x, q.y, q.x, q.y),
      Some((x0, y0, x1, y1)) => (x0.min(q.x), y0.min(q.y), x1.max(q.x), y1.max(q.y)),
    });
  };
  for sp in sps {
    for p in &sp.points {
      add(Point::new(p.x, p.y));
    }
    for seg in 0..segment_count(sp) {
      let c = segment(sp, seg);
      for t in extrema(c[0].x, c[1].x, c[2].x, c[3].x)
        .into_iter()
        .chain(extrema(c[0].y, c[1].y, c[2].y, c[3].y))
      {
        add(cubic_at(&c, t));
      }
    }
  }
  b
}

/// Refits a vector's box to its path without moving the path on the page: anchors shift
/// so the path starts at 0,0 and the node moves (respecting rotation and flips) to match.
/// Lines keep at least a 1px box, like newly drawn paths.
pub fn fit_bounds(n: &mut Node) {
  let Some(v) = n.vector.as_mut() else { return };
  if v.raw.is_some() {
    return;
  }
  let Some((x0, y0, x1, y1)) = path_bounds(&v.subpaths) else { return };
  let (w, h) = ((x1 - x0).max(1.0), (y1 - y0).max(1.0));
  if x0.abs() < 1e-9 && y0.abs() < 1e-9 && (w - n.width).abs() < 1e-9 && (h - n.height).abs() < 1e-9 {
    return;
  }
  for sp in v.subpaths.iter_mut() {
    for p in sp.points.iter_mut() {
      p.x -= x0;
      p.y -= y0;
    }
  }
  // The new box's origin must land where the old local point (x0, y0) was.
  let old = local_matrix(n.x, n.y, n.width, n.height, n.rotation, n.flip_x, n.flip_y);
  let target = old.apply(Point::new(x0, y0));
  let origin = local_matrix(0.0, 0.0, w, h, n.rotation, n.flip_x, n.flip_y).apply(Point::new(0.0, 0.0));
  n.x = target.x - origin.x;
  n.y = target.y - origin.y;
  n.width = w;
  n.height = h;
}

/// Converts page-space anchors (positions and handle offsets) into a node's local space.
pub fn to_local(points: &[VectorPoint], page_to_local: &Mat) -> Vec<VectorPoint> {
  points
    .iter()
    .map(|p| {
      let a = page_to_local.apply(Point::new(p.x, p.y));
      let i = page_to_local.apply_vec(Point::new(p.in_x, p.in_y));
      let o = page_to_local.apply_vec(Point::new(p.out_x, p.out_y));
      VectorPoint {
        x: a.x,
        y: a.y,
        in_x: i.x,
        in_y: i.y,
        out_x: o.x,
        out_y: o.y,
      }
    })
    .collect()
}

/// Parameters in (0, 1) where one coordinate of a cubic has a local extremum.
fn extrema(p0: f64, p1: f64, p2: f64, p3: f64) -> Vec<f64> {
  // B'(t) / 3 = a t² + b t + c
  let a = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
  let b = 2.0 * (p0 - 2.0 * p1 + p2);
  let c = p1 - p0;
  let mut out = Vec::new();
  if a.abs() < 1e-12 {
    if b.abs() > 1e-12 {
      out.push(-c / b);
    }
  } else {
    let disc = b * b - 4.0 * a * c;
    if disc >= 0.0 {
      let s = disc.sqrt();
      out.push((-b + s) / (2.0 * a));
      out.push((-b - s) / (2.0 * a));
    }
  }
  out.retain(|t| *t > 0.0 && *t < 1.0);
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  const EPS: f64 = 1e-6;

  #[test]
  fn subdividing_a_curve_keeps_its_shape() {
    let orig = curvy(false);
    let mut sp = orig.clone();
    let idx = insert_point(&mut sp, 0, 0.3).unwrap();
    assert_eq!((idx, sp.points.len()), (1, 4));
    assert_same_split(&orig, 0, 0.3, &sp);
  }

  #[test]
  fn subdividing_the_closing_segment_appends_the_point() {
    let orig = curvy(true);
    let mut sp = orig.clone();
    let idx = insert_point(&mut sp, 2, 0.5).unwrap();
    assert_eq!(idx, 3);
    assert_same_split(&orig, 2, 0.5, &sp);
  }

  #[test]
  fn splitting_a_straight_segment_adds_a_sharp_point() {
    let mut sp = SubPath {
      points: vec![VectorPoint::at(0.0, 0.0), VectorPoint::at(100.0, 50.0)],
      closed: false,
    };
    insert_point(&mut sp, 0, 0.5).unwrap();
    assert_eq!(sp.points[1], VectorPoint::at(50.0, 25.0));
    assert!(!is_smooth(&sp.points[0]) && !is_smooth(&sp.points[2]));
    assert!(insert_point(&mut sp, 5, 0.5).is_err());
    assert!(insert_point(&mut sp, 0, 1.0).is_err());
  }

  #[test]
  fn deleting_an_interior_point_joins_its_neighbours() {
    let mut v = data(vec![curvy(false)]);
    let keep = (v.subpaths[0].points[0], v.subpaths[0].points[2]);
    assert!(delete_points(&mut v, &[[0, 1]]));
    assert_eq!(v.subpaths[0].points, vec![keep.0, keep.1], "neighbours keep their handles");
  }

  #[test]
  fn deleting_an_endpoint_shortens_an_open_path() {
    let mut v = data(vec![curvy(false)]);
    let rest = v.subpaths[0].points[1..].to_vec();
    assert!(delete_points(&mut v, &[[0, 0]]));
    assert_eq!(v.subpaths[0].points, rest);
    assert!(!v.subpaths[0].closed);
  }

  #[test]
  fn closed_paths_stay_closed_until_too_small() {
    let mut sq = SubPath {
      points: [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
        .iter()
        .map(|&(x, y)| VectorPoint::at(x, y))
        .collect(),
      closed: true,
    };
    let mut v = data(vec![sq.clone()]);
    assert!(delete_points(&mut v, &[[0, 3]]));
    assert!(v.subpaths[0].closed && v.subpaths[0].points.len() == 3);
    assert!(delete_points(&mut v, &[[0, 0]]));
    assert!(!v.subpaths[0].closed, "two points make a line");
    sq.closed = false;
    let mut v = data(vec![sq.clone(), sq]);
    assert!(delete_points(&mut v, &[[0, 0], [0, 1], [0, 2]]));
    assert_eq!(v.subpaths.len(), 1, "a lone point is dropped");
    assert!(!delete_points(&mut v, &[[0, 0], [0, 1], [0, 2]]));
  }

  #[test]
  fn smooth_and_sharp_points() {
    let mut v = data(vec![SubPath {
      points: vec![VectorPoint::at(0.0, 0.0), VectorPoint::at(30.0, 30.0), VectorPoint::at(60.0, 0.0)],
      closed: false,
    }]);
    set_smooth(&mut v, &[[0, 1]], true);
    let p = v.subpaths[0].points[1];
    let third = 1800f64.sqrt() / 3.0;
    assert!((p.in_x + third).abs() < 1e-9 && p.in_y.abs() < 1e-9, "{p:?}");
    assert!((p.out_x - third).abs() < 1e-9 && p.out_y.abs() < 1e-9, "{p:?}");
    set_smooth(&mut v, &[[0, 1]], false);
    assert!(!is_smooth(&v.subpaths[0].points[1]));
  }

  #[test]
  fn extending_from_either_end() {
    let line = SubPath {
      points: vec![VectorPoint::at(0.0, 0.0), VectorPoint::at(10.0, 0.0)],
      closed: false,
    };
    let mut v = data(vec![line.clone()]);
    extend(&mut v, 0, false, &[VectorPoint::at(10.0, 10.0)], false).unwrap();
    assert_eq!(v.subpaths[0].points.last().unwrap(), &VectorPoint::at(10.0, 10.0));
    let mut v = data(vec![line]);
    let drawn = VectorPoint {
      out_x: 1.0,
      in_x: -1.0,
      ..VectorPoint::at(0.0, 10.0)
    };
    extend(&mut v, 0, true, &[VectorPoint::at(-5.0, 5.0), drawn], true).unwrap();
    let pts = &v.subpaths[0].points;
    assert_eq!(
      (pts[0].x, pts[0].y, pts[0].out_x, pts[0].in_x),
      (0.0, 10.0, -1.0, 1.0),
      "reversed with handles swapped"
    );
    assert_eq!((pts[1].x, pts[2].x), (-5.0, 0.0));
    assert!(v.subpaths[0].closed);
    assert!(extend(&mut v, 0, false, &[VectorPoint::at(1.0, 1.0)], false).is_err());
  }

  #[test]
  fn nearest_segment_finds_the_curve_point() {
    let v = data(vec![curvy(false)]);
    let c = segment(&v.subpaths[0], 1);
    let on = cubic_at(&c, 0.37);
    let hit = nearest_segment(&v, Point::new(on.x + 0.5, on.y), 3.0).unwrap();
    assert_eq!((hit.sub, hit.seg), (0, 1));
    assert!(hit.dist <= 0.5 + 1e-9);
    assert!(nearest_segment(&v, Point::new(500.0, 500.0), 3.0).is_none());
  }

  #[test]
  fn fitting_bounds_keeps_the_path_in_place() {
    for rotation in [0.0, 30.0] {
      let mut n = Node {
        kind: crate::model::NodeType::Vector,
        x: 100.0,
        y: 50.0,
        width: 100.0,
        height: 100.0,
        rotation,
        flip_x: true,
        vector: Some(data(vec![SubPath {
          points: vec![VectorPoint::at(20.0, 10.0), VectorPoint::at(80.0, 60.0)],
          closed: false,
        }])),
        ..Default::default()
      };
      let page = |n: &Node| {
        let m = local_matrix(n.x, n.y, n.width, n.height, n.rotation, n.flip_x, n.flip_y);
        n.vector.as_ref().unwrap().subpaths[0]
          .points
          .iter()
          .map(|p| m.apply(Point::new(p.x, p.y)))
          .collect::<Vec<_>>()
      };
      let before = page(&n);
      fit_bounds(&mut n);
      assert_eq!((n.width, n.height), (60.0, 50.0));
      assert_eq!(n.vector.as_ref().unwrap().subpaths[0].points[0], VectorPoint::at(0.0, 0.0));
      for (a, b) in before.iter().zip(page(&n)) {
        assert!((a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9, "{a:?} → {b:?}");
      }
    }
  }

  #[test]
  fn path_bounds_use_curve_extrema() {
    let sp = SubPath {
      points: vec![
        VectorPoint {
          out_y: -40.0,
          ..VectorPoint::at(0.0, 0.0)
        },
        VectorPoint {
          in_y: -40.0,
          ..VectorPoint::at(30.0, 0.0)
        },
      ],
      closed: false,
    };
    let (_, y0, _, y1) = path_bounds(&[sp]).unwrap();
    assert!((y0 + 30.0).abs() < 1e-9 && y1 == 0.0, "{y0}");
  }

  fn curvy(closed: bool) -> SubPath {
    SubPath {
      points: vec![
        VectorPoint {
          out_x: 30.0,
          out_y: -40.0,
          ..VectorPoint::at(0.0, 50.0)
        },
        VectorPoint {
          in_x: -20.0,
          in_y: -10.0,
          out_x: 20.0,
          out_y: 10.0,
          ..VectorPoint::at(60.0, 20.0)
        },
        VectorPoint {
          in_x: 10.0,
          in_y: -30.0,
          out_x: -20.0,
          out_y: 40.0,
          ..VectorPoint::at(120.0, 70.0)
        },
      ],
      closed,
    }
  }

  fn data(subpaths: Vec<SubPath>) -> VectorData {
    VectorData { subpaths, raw: None }
  }

  /// Checks that `after` is `before` with segment `seg` split at `t`: every other segment is
  /// unchanged and the two halves trace the original segment exactly.
  fn assert_same_split(before: &SubPath, seg: usize, t: f64, after: &SubPath) {
    let close = |a: Point, b: Point| (a.x - b.x).abs() < EPS && (a.y - b.y).abs() < EPS;
    assert_eq!(segment_count(after), segment_count(before) + 1);
    for s in 0..segment_count(before) {
      let c0 = segment(before, s);
      for i in 0..=100 {
        let u = i as f64 / 100.0;
        let want = cubic_at(&c0, u);
        let got = match s.cmp(&seg) {
          std::cmp::Ordering::Less => cubic_at(&segment(after, s), u),
          std::cmp::Ordering::Greater => cubic_at(&segment(after, s + 1), u),
          std::cmp::Ordering::Equal if u <= t => cubic_at(&segment(after, s), u / t),
          std::cmp::Ordering::Equal => cubic_at(&segment(after, s + 1), (u - t) / (1.0 - t)),
        };
        assert!(close(want, got), "segment {s} at {u}: {want:?} vs {got:?}");
      }
    }
  }
}
