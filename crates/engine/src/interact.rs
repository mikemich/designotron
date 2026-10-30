//! Canvas interaction math: hit-testing, Figma-style selection picking,
//! marquee selection, smart-guide snapping and resize.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::doc::IdGen;
use crate::geom::{dist_to_segment, local_matrix, point_in_polygon, Mat, Point, Rect};
use crate::model::{Axis, Document, Node, NodeId, NodeType, TextAutoResize};
use crate::shapes;

/// Deepest visible, unlocked node under a page-space point.
pub fn hit_test(doc: &Document, page: &str, p: Point, zoom: f64) -> Option<NodeId> {
  let roots = doc.page(page)?.children.clone();
  hit_list(doc, &roots, p, 4.0 / zoom.max(0.01))
}

fn hit_list(doc: &Document, ids: &[NodeId], p: Point, tol: f64) -> Option<NodeId> {
  for id in ids.iter().rev() {
    let Some(n) = doc.get(id) else { continue };
    if !n.visible || n.locked {
      continue;
    }
    let m = doc.abs_matrix(id);
    let scale = (m.a * m.d - m.b * m.c).abs().sqrt().max(1e-6);
    let local = m.invert().apply(p);
    let ltol = tol / scale;
    let inside = local.x >= 0.0 && local.y >= 0.0 && local.x <= n.width && local.y <= n.height;
    match n.kind {
      k if k.is_frame_like() => {
        if n.clip_content && !inside {
          continue;
        }
        if let Some(c) = hit_list(doc, &n.children, p, tol) {
          return Some(c);
        }
        if inside {
          return Some(id.clone());
        }
      }
      NodeType::Group => {
        if let Some(c) = hit_list(doc, &n.children, p, tol) {
          return Some(c);
        }
      }
      _ => {
        if shape_contains(n, local, ltol) {
          return Some(id.clone());
        }
      }
    }
  }
  None
}

fn shape_contains(n: &Node, p: Point, tol: f64) -> bool {
  let half_stroke = if n.strokes.iter().any(|s| s.visible()) {
    n.stroke_weight / 2.0
  } else {
    0.0
  };
  let t = tol.max(half_stroke);
  match n.kind {
    NodeType::Ellipse => {
      let (rx, ry) = ((n.width / 2.0).max(1e-6), (n.height / 2.0).max(1e-6));
      let dx = (p.x - rx) / (rx + t);
      let dy = (p.y - ry) / (ry + t);
      dx * dx + dy * dy <= 1.0
    }
    NodeType::Line => dist_to_segment(p, Point::new(0.0, 0.0), Point::new(n.width, 0.0)) <= t.max(3.0),
    NodeType::Polygon | NodeType::Star => point_in_polygon(p, &shapes::polygon_points(n)),
    NodeType::Vector => {
      let Some(v) = n.vector.as_ref() else { return false };
      if v.raw.is_some() {
        return p.x >= -t && p.y >= -t && p.x <= n.width + t && p.y <= n.height + t;
      }
      let filled = n.fills.iter().any(|f| f.visible());
      v.subpaths.iter().any(|sp| {
        let poly = shapes::flatten_subpath(sp);
        (filled && sp.closed && point_in_polygon(p, &poly)) || poly.windows(2).any(|w| dist_to_segment(p, w[0], w[1]) <= t.max(3.0))
      })
    }
    _ => p.x >= -t && p.y >= -t && p.x <= n.width + t && p.y <= n.height + t,
  }
}

/// Figma-like click selection: children of top-level frames are picked
/// directly, groups/instances are picked whole until drilled into.
pub fn pick(doc: &Document, page: &str, p: Point, zoom: f64, selection: &[NodeId], deep: bool) -> Option<NodeId> {
  let hit = hit_test(doc, page, p, zoom)?;
  if deep {
    return Some(hit);
  }
  let path = doc.path(&hit);
  // Stay at the depth of the current selection.
  let mut best: Option<usize> = None;
  for s in selection {
    if let Some(k) = path.iter().position(|x| x == s) {
      // A lone selected top-level frame never captures hits on its descendants: its
      // direct child is picked, as when nothing is selected. With several layers selected
      // the press stays on the selection, so they can be dragged together.
      let k = if k == 0 && selection.len() == 1 && k + 1 < path.len() && is_top_container(doc, &path[0]) {
        1
      } else {
        k
      };
      best = Some(best.map_or(k, |b: usize| b.max(k)));
    } else if let Some(parent) = doc.get(s).and_then(|n| n.parent.clone()) {
      if let Some(k) = path.iter().position(|x| *x == parent) {
        if k + 1 < path.len() {
          best = Some(best.map_or(k + 1, |b: usize| b.max(k + 1)));
        }
      }
    }
  }
  if let Some(k) = best {
    return Some(path[k].clone());
  }
  if path.len() > 1 && is_top_container(doc, &path[0]) {
    return Some(path[1].clone());
  }
  Some(path[0].clone())
}

/// Page-level frames, components and sets: their direct children are pickable without drilling.
fn is_top_container(doc: &Document, id: &str) -> bool {
  doc
    .get(id)
    .is_some_and(|n| matches!(n.kind, NodeType::Frame | NodeType::Component | NodeType::ComponentSet))
}

/// Double-click drill-down: the child of `container` on the path to the hit node.
pub fn drill(doc: &Document, page: &str, p: Point, zoom: f64, container: &str) -> Option<NodeId> {
  let hit = hit_test(doc, page, p, zoom)?;
  let path = doc.path(&hit);
  let k = path.iter().position(|x| x == container)?;
  path.get(k + 1).cloned()
}

/// Marquee selection. Top-level frames that are only partially covered are
/// descended into so dragging inside an artboard selects its layers.
pub fn marquee(doc: &Document, page: &str, r: Rect) -> Vec<NodeId> {
  let mut out = Vec::new();
  let Some(pg) = doc.page(page) else { return out };
  for id in &pg.children {
    let Some(n) = doc.get(id) else { continue };
    if !n.visible || n.locked {
      continue;
    }
    let b = doc.abs_bounds(id);
    if !r.intersects(&b) {
      continue;
    }
    if n.kind.is_frame_like() && n.kind != NodeType::Instance && !r.contains_rect(&b) {
      for c in &n.children {
        let cn = doc.get(c).unwrap();
        if cn.visible && !cn.locked && r.intersects(&doc.abs_bounds(c)) {
          out.push(c.clone());
        }
      }
    } else {
      out.push(id.clone());
    }
  }
  out
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Guide {
  pub x1: f64,
  pub y1: f64,
  pub x2: f64,
  pub y2: f64,
}

/// An equal-spacing hint or a measured distance: a segment along one axis and its length.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Gap {
  pub x1: f64,
  pub y1: f64,
  pub x2: f64,
  pub y2: f64,
  pub value: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Snap {
  pub dx: f64,
  pub dy: f64,
  pub guides: Vec<Guide>,
  /// Equal gaps between siblings the move snapped to.
  #[serde(default)]
  pub gaps: Vec<Gap>,
}

/// What moving nodes may snap to: sibling/parent/top-level frame rects, plus
/// page guides and layout grid lines as (position, span start, span end).
struct Targets {
  rects: Vec<Rect>,
  /// Siblings of the moving nodes, for equal-spacing snaps.
  siblings: Vec<Rect>,
  xs: Vec<(f64, f64, f64)>,
  ys: Vec<(f64, f64, f64)>,
}

fn snap_targets(doc: &Document, page: &str, moving: &[NodeId]) -> Targets {
  let excluded: HashSet<NodeId> = moving.iter().flat_map(|m| doc.subtree(m)).collect();
  let sibling_ids: Vec<NodeId> = moving.first().map(|first| doc.siblings_of(first)).unwrap_or_default();
  let mut ids: Vec<&NodeId> = sibling_ids.iter().collect();
  if let Some(parent) = moving.first().and_then(|first| doc.get(first)).and_then(|n| n.parent.as_ref()) {
    ids.push(parent);
  }
  if let Some(pg) = doc.page(page) {
    ids.extend(pg.children.iter());
  }
  let is_sibling: HashSet<&NodeId> = sibling_ids.iter().collect();
  let mut seen: HashSet<&NodeId> = HashSet::new();
  let (mut rects, mut siblings) = (Vec::new(), Vec::new());
  for id in ids {
    if excluded.contains(id) || !seen.insert(id) || !doc.get(id).is_some_and(|n| n.visible) {
      continue;
    }
    let r = doc.abs_bounds(id);
    if is_sibling.contains(id) {
      siblings.push(r);
    }
    rects.push(r);
  }
  let mut t = Targets {
    rects,
    siblings,
    xs: Vec::new(),
    ys: Vec::new(),
  };
  const FAR: f64 = 1e7;
  if let Some(pg) = doc.page(page) {
    for g in &pg.guides {
      match g.axis {
        Axis::X => t.xs.push((g.position, FAR, -FAR)),
        Axis::Y => t.ys.push((g.position, FAR, -FAR)),
      }
    }
  }
  // Layout grids of the frames containing the moving nodes.
  let mut anc = moving.first().and_then(|m| doc.get(m)).and_then(|n| n.parent.clone());
  while let Some(a) = anc {
    let Some(n) = doc.get(&a) else { break };
    if n.visible && !n.layout_grids.is_empty() {
      let r = doc.abs_bounds(&a);
      for g in n.layout_grids.iter().filter(|g| g.visible) {
        let (xs, ys) = crate::grids::lines(&r, g);
        t.xs.extend(xs.into_iter().map(|x| (x, r.y, r.bottom())));
        t.ys.extend(ys.into_iter().map(|y| (y, r.x, r.right())));
      }
    }
    anc = n.parent.clone();
  }
  t
}

/// Snaps a page-space move delta of `ids` to nearby edges, centres and equal gaps between siblings.
pub fn snap_move(doc: &Document, page: &str, ids: &[NodeId], dx: f64, dy: f64, zoom: f64) -> Snap {
  let Some(start) = doc.bounds_of_many(ids) else {
    return Snap {
      dx,
      dy,
      ..Default::default()
    };
  };
  let moved = Rect::new(start.x + dx, start.y + dy, start.width, start.height);
  let targets = snap_targets(doc, page, ids);
  let thr = 6.0 / zoom.max(0.01);
  let (mut sx, mut sy) = best_snap(&moved, &targets, thr, [true, true, true, true]);
  let hx = spacing_hit(&targets.siblings, Axis::X, &moved, Edge::Both, thr).filter(|h| closer(h.delta, sx));
  let hy = spacing_hit(&targets.siblings, Axis::Y, &moved, Edge::Both, thr).filter(|h| closer(h.delta, sy));
  let (ex, ey) = (sx.is_some() && hx.is_none(), sy.is_some() && hy.is_none());
  if let Some(h) = &hx {
    sx = Some(h.delta);
  }
  if let Some(h) = &hy {
    sy = Some(h.delta);
  }
  let mut out = Snap {
    dx: sx.map(|s| dx + s).unwrap_or_else(|| (start.x + dx).round() - start.x),
    dy: sy.map(|s| dy + s).unwrap_or_else(|| (start.y + dy).round() - start.y),
    ..Default::default()
  };
  let fin = Rect::new(start.x + out.dx, start.y + out.dy, start.width, start.height);
  out.guides = guides_for(&fin, &targets, ex, ey);
  out.gaps = hx.into_iter().chain(hy).flat_map(|h| h.gaps).collect();
  out
}

/// Snaps an axis-aligned rect whose `edges` [left, right, top, bottom] are moving.
/// Also returns the equal gaps it snapped to, unless `spacing` is off (auto layout children,
/// resizing from the centre or keeping the aspect ratio, where the moving edges aren't the whole story).
pub fn snap_rect(
  doc: &Document,
  page: &str,
  exclude: &[NodeId],
  r: Rect,
  edges: [bool; 4],
  zoom: f64,
  spacing: bool,
) -> (Rect, Vec<Guide>, Vec<Gap>) {
  let targets = snap_targets(doc, page, exclude);
  let thr = 6.0 / zoom.max(0.01);
  let (mut sx, mut sy) = best_snap(&r, &targets, thr, edges);
  // A zero-size rect is a point (drawing tools): no spacing there.
  let spaced = spacing && (r.width > 0.0 || r.height > 0.0);
  let one_edge = |lo: bool, hi: bool| match (lo, hi) {
    (true, false) => Some(Edge::Lo),
    (false, true) => Some(Edge::Hi),
    _ => None,
  };
  let hx = one_edge(edges[0], edges[1])
    .filter(|_| spaced)
    .and_then(|e| spacing_hit(&targets.siblings, Axis::X, &r, e, thr))
    .filter(|h| closer(h.delta, sx));
  let hy = one_edge(edges[2], edges[3])
    .filter(|_| spaced)
    .and_then(|e| spacing_hit(&targets.siblings, Axis::Y, &r, e, thr))
    .filter(|h| closer(h.delta, sy));
  let (ex, ey) = (sx.is_some() && hx.is_none(), sy.is_some() && hy.is_none());
  if let Some(h) = &hx {
    sx = Some(h.delta);
  }
  if let Some(h) = &hy {
    sy = Some(h.delta);
  }
  let mut out = r;
  if let Some(s) = sx {
    if edges[0] {
      out.x += s;
      out.width -= s;
    } else {
      out.width += s;
    }
  }
  if let Some(s) = sy {
    if edges[2] {
      out.y += s;
      out.height -= s;
    } else {
      out.height += s;
    }
  }
  let guides = guides_for(&out, &targets, ex, ey);
  (out, guides, hx.into_iter().chain(hy).flat_map(|h| h.gaps).collect())
}

/// Which edges of the moving rect an equal-spacing snap may shift along one axis.
#[derive(Clone, Copy, PartialEq)]
enum Edge {
  /// A move: both edges shift together.
  Both,
  /// A resize from the start edge (left or top).
  Lo,
  /// A resize from the end edge (right or bottom).
  Hi,
}

/// An equal-spacing snap: how far the moving edge shifts and the equal gaps to draw.
struct SpaceHit {
  delta: f64,
  gaps: Vec<Gap>,
}

/// One gap to draw: the rects on either side (to place the marker) and its extent on the axis.
type GapSpec = (Rect, Rect, f64, f64);

/// A position for the moving edges that makes two gaps equal.
struct Candidate {
  lo: f64,
  hi: f64,
  gaps: Vec<GapSpec>,
}

/// Whether an equal-spacing shift beats the edge snap on the same axis (ties go to edges).
fn closer(spacing: f64, edge: Option<f64>) -> bool {
  edge.is_none_or(|e| spacing.abs() < e.abs())
}

/// Finds the nearest shift (within `thr`) that makes the gap beside the moving rect equal to
/// another gap between siblings along `axis`: centred between its two neighbours, or repeating
/// the gap of the two nearest siblings on either side. Only siblings sharing its row (or column,
/// on the vertical axis) count, so unrelated layers far away never pull on it.
fn spacing_hit(siblings: &[Rect], axis: Axis, moved: &Rect, edge: Edge, thr: f64) -> Option<SpaceHit> {
  if siblings.len() < 2 {
    return None;
  }
  let (p_lo, p_hi) = perp_span(moved, axis);
  let aligned: Vec<Rect> = siblings
    .iter()
    .filter(|r| {
      let (a, b) = perp_span(r, axis);
      a < p_hi && b > p_lo
    })
    .cloned()
    .collect();
  if aligned.len() < 2 {
    return None;
  }
  spacing_in(&aligned, axis, moved, edge, thr)
}

fn spacing_in(rects: &[Rect], axis: Axis, moved: &Rect, edge: Edge, thr: f64) -> Option<SpaceHit> {
  const EPS: f64 = 0.01;
  let span = |r: &Rect| axis_span(r, axis);
  let (lo, hi) = span(moved);
  let w = hi - lo;
  // The nearest sibling satisfying `pred` by `key`, other than `skip`.
  let nearest = |pred: &dyn Fn(&Rect) -> bool, key: &dyn Fn(&Rect) -> f64, skip: Option<usize>| -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, r) in rects.iter().enumerate() {
      if Some(i) != skip && pred(r) && best.is_none_or(|b| key(r) < key(&rects[b])) {
        best = Some(i);
      }
    }
    best
  };
  // Nearest sibling before and after the moving rect, and the one beyond each.
  let l = nearest(&|r| span(r).1 <= lo + EPS, &|r| -span(r).1, None);
  let r = nearest(&|r| span(r).0 >= hi - EPS, &|r| span(r).0, None);
  let ll = l.and_then(|l| {
    let ls = span(&rects[l]).0;
    nearest(&|r| span(r).1 <= ls + EPS, &|r| -span(r).1, Some(l))
  });
  let rr = r.and_then(|r| {
    let re = span(&rects[r]).1;
    nearest(&|r| span(r).0 >= re - EPS, &|r| span(r).0, Some(r))
  });
  let mut cands: Vec<Candidate> = Vec::new();
  let mut add = |nl: f64, nh: f64, gaps: Vec<GapSpec>| {
    if nh - nl > EPS && gaps.iter().all(|g| g.3 - g.2 > EPS) {
      cands.push(Candidate { lo: nl, hi: nh, gaps });
    }
  };
  let shifted = |nl: f64, nh: f64| axis_rect(moved, axis, nl, nh);
  if let (Some(l), Some(r)) = (l, r) {
    let (le, rs) = (span(&rects[l]).1, span(&rects[r]).0);
    let (nl, nh) = match edge {
      Edge::Both => ((le + rs - w) / 2.0, (le + rs + w) / 2.0),
      Edge::Lo => (le + rs - hi, hi),
      Edge::Hi => (lo, rs - (lo - le)),
    };
    let m = shifted(nl, nh);
    add(nl, nh, vec![(rects[l], m, le, nl), (m, rects[r], nh, rs)]);
  }
  if let (Some(l), Some(ll)) = (l, ll) {
    if edge != Edge::Hi {
      let (ls, le) = span(&rects[l]);
      let lle = span(&rects[ll]).1;
      let nl = le + (ls - lle);
      let nh = if edge == Edge::Both { nl + w } else { hi };
      add(nl, nh, vec![(rects[ll], rects[l], lle, ls), (rects[l], shifted(nl, nh), le, nl)]);
    }
  }
  if let (Some(r), Some(rr)) = (r, rr) {
    if edge != Edge::Lo {
      let (rs, re) = span(&rects[r]);
      let rrs = span(&rects[rr]).0;
      let nh = rs - (rrs - re);
      let nl = if edge == Edge::Both { nh - w } else { lo };
      add(nl, nh, vec![(shifted(nl, nh), rects[r], nh, rs), (rects[r], rects[rr], re, rrs)]);
    }
  }
  let delta_of = |c: &Candidate| if edge == Edge::Hi { c.hi - hi } else { c.lo - lo };
  let best = cands
    .into_iter()
    .filter(|c| delta_of(c).abs() <= thr)
    .min_by(|a, b| delta_of(a).abs().total_cmp(&delta_of(b).abs()))?;
  let delta = delta_of(&best);
  let gaps = best
    .gaps
    .iter()
    .map(|(a, b, from, to)| {
      let pos = perp_mid(a, b, axis);
      match axis {
        Axis::X => Gap {
          x1: *from,
          y1: pos,
          x2: *to,
          y2: pos,
          value: to - from,
        },
        Axis::Y => Gap {
          x1: pos,
          y1: *from,
          x2: pos,
          y2: *to,
          value: to - from,
        },
      }
    })
    .collect();
  Some(SpaceHit { delta, gaps })
}

fn axis_span(r: &Rect, axis: Axis) -> (f64, f64) {
  match axis {
    Axis::X => (r.x, r.right()),
    Axis::Y => (r.y, r.bottom()),
  }
}

fn perp_span(r: &Rect, axis: Axis) -> (f64, f64) {
  axis_span(r, if axis == Axis::X { Axis::Y } else { Axis::X })
}

fn axis_rect(r: &Rect, axis: Axis, lo: f64, hi: f64) -> Rect {
  match axis {
    Axis::X => Rect::new(lo, r.y, hi - lo, r.height),
    Axis::Y => Rect::new(r.x, lo, r.width, hi - lo),
  }
}

/// Where a gap marker sits across the axis: the middle of the two rects' overlap, or of the first when they don't overlap.
fn perp_mid(a: &Rect, b: &Rect, axis: Axis) -> f64 {
  let (a1, a2) = perp_span(a, axis);
  let (b1, b2) = perp_span(b, axis);
  let (o1, o2) = (a1.max(b1), a2.min(b2));
  if o1 < o2 {
    (o1 + o2) / 2.0
  } else {
    (a1 + a2) / 2.0
  }
}

fn best_snap(r: &Rect, targets: &Targets, thr: f64, edges: [bool; 4]) -> (Option<f64>, Option<f64>) {
  let all = edges.iter().all(|e| *e);
  let mut xs: Vec<f64> = Vec::new();
  if edges[0] {
    xs.push(r.x);
  }
  if all {
    xs.push(r.center().x);
  }
  if edges[1] {
    xs.push(r.right());
  }
  let mut ys: Vec<f64> = Vec::new();
  if edges[2] {
    ys.push(r.y);
  }
  if all {
    ys.push(r.center().y);
  }
  if edges[3] {
    ys.push(r.bottom());
  }
  let pick = |vals: &[f64], tv: &dyn Fn(&Rect) -> [f64; 3], lines: &[(f64, f64, f64)]| -> Option<f64> {
    let mut best: Option<f64> = None;
    let rect_values = targets.rects.iter().flat_map(tv);
    for target in rect_values.chain(lines.iter().map(|l| l.0)) {
      for v in vals {
        let d = target - v;
        if d.abs() <= thr && best.is_none_or(|b| d.abs() < b.abs()) {
          best = Some(d);
        }
      }
    }
    best
  };
  (
    pick(&xs, &|t: &Rect| [t.x, t.center().x, t.right()], &targets.xs),
    pick(&ys, &|t: &Rect| [t.y, t.center().y, t.bottom()], &targets.ys),
  )
}

fn guides_for(r: &Rect, all: &Targets, gx: bool, gy: bool) -> Vec<Guide> {
  let mut out = Vec::new();
  let near = |a: f64, b: f64| (a - b).abs() < 0.5;
  let targets = &all.rects;
  if gx {
    for v in [r.x, r.center().x, r.right()] {
      for l in all.xs.iter().filter(|l| near(l.0, v)) {
        out.push(Guide {
          x1: v,
          y1: r.y.min(l.1),
          x2: v,
          y2: r.bottom().max(l.2),
        });
      }
      for t in targets {
        if [t.x, t.center().x, t.right()].iter().any(|tv| near(*tv, v)) {
          out.push(Guide {
            x1: v,
            y1: r.y.min(t.y),
            x2: v,
            y2: r.bottom().max(t.bottom()),
          });
        }
      }
    }
  }
  if gy {
    for v in [r.y, r.center().y, r.bottom()] {
      for l in all.ys.iter().filter(|l| near(l.0, v)) {
        out.push(Guide {
          x1: r.x.min(l.1),
          y1: v,
          x2: r.right().max(l.2),
          y2: v,
        });
      }
      for t in targets {
        if [t.y, t.center().y, t.bottom()].iter().any(|tv| near(*tv, v)) {
          out.push(Guide {
            x1: r.x.min(t.x),
            y1: v,
            x2: r.right().max(t.right()),
            y2: v,
          });
        }
      }
    }
  }
  out
}

/// Alt-hover measurement: the distances from the selection to the layer under the pointer.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Measurement {
  /// The layer measured to (the hovered layer or the frame around the pointer).
  pub target: NodeId,
  pub lines: Vec<Gap>,
  /// Dashed projections joining a distance line to the layer it ends at.
  pub extends: Vec<Guide>,
}

/// Measures from `ids` to `hover`, the layer the editor's normal hover picked (so an instance
/// or group is measured whole, not its inner text). Without a usable hover (nothing picked, or it
/// is the selection or inside it) it measures to the layer enclosing the selection at `p`, so
/// pointing at the selection or at empty frame area gives the distances to the parent's inner edges.
pub fn measure_at(doc: &Document, page: &str, ids: &[NodeId], hover: Option<&str>, p: Point, zoom: f64) -> Option<Measurement> {
  let inside_selection = |id: &str| doc.path(id).iter().any(|a| ids.contains(a));
  if let Some(h) = hover.filter(|h| doc.get(h).is_some() && !inside_selection(h)) {
    return measure_to(doc, ids, h);
  }
  let path = doc.path(&hit_test(doc, page, p, zoom)?);
  let target = match path.iter().position(|a| ids.contains(a)) {
    Some(0) => return None,
    Some(k) => path[k - 1].clone(),
    None => path.last()?.clone(),
  };
  measure_to(doc, ids, &target)
}

/// Measures from the bounds of `ids` to the layer `target`.
pub fn measure_to(doc: &Document, ids: &[NodeId], target: &str) -> Option<Measurement> {
  let from = doc.bounds_of_many(ids)?;
  doc.get(target)?;
  let to = doc.abs_bounds(target);
  let mut m = Measurement {
    target: target.to_string(),
    ..Default::default()
  };
  measure_axis(&from, &to, Axis::X, &mut m);
  measure_axis(&from, &to, Axis::Y, &mut m);
  Some(m)
}

/// Distances along one axis. Disjoint rects get the single gap between them; overlapping or
/// nested ones get the distance between their start edges and between their end edges.
fn measure_axis(a: &Rect, b: &Rect, axis: Axis, m: &mut Measurement) {
  const MIN: f64 = 0.01;
  let (a1, a2) = axis_span(a, axis);
  let (b1, b2) = axis_span(b, axis);
  let mut spans: Vec<(f64, f64)> = Vec::new();
  if a2 <= b1 {
    spans.push((a2, b1));
  } else if b2 <= a1 {
    spans.push((b2, a1));
  } else {
    spans.push((a1.min(b1), a1.max(b1)));
    spans.push((a2.min(b2), a2.max(b2)));
  }
  // Across the axis the lines sit in the middle of where the rects overlap, else on the selection.
  let (p1, p2) = perp_span(a, axis);
  let (q1, q2) = perp_span(b, axis);
  let (o1, o2) = (p1.max(q1), p2.min(q2));
  let pos = if o1 < o2 { (o1 + o2) / 2.0 } else { (p1 + p2) / 2.0 };
  for (from, to) in spans.into_iter().filter(|s| s.1 - s.0 > MIN) {
    // The line may end beside the layer rather than on it: project it back with a dashed line.
    for end in [from, to] {
      let on_b = (end - b1).abs() < MIN || (end - b2).abs() < MIN;
      let on_a = (end - a1).abs() < MIN || (end - a2).abs() < MIN;
      for (on, lo, hi) in [(on_b, q1, q2), (on_a, p1, p2)] {
        if on && (pos < lo || pos > hi) {
          let near = if (pos - lo).abs() < (pos - hi).abs() { lo } else { hi };
          m.extends.push(match axis {
            Axis::X => Guide {
              x1: end,
              y1: pos,
              x2: end,
              y2: near,
            },
            Axis::Y => Guide {
              x1: pos,
              y1: end,
              x2: near,
              y2: end,
            },
          });
        }
      }
    }
    m.lines.push(match axis {
      Axis::X => Gap {
        x1: from,
        y1: pos,
        x2: to,
        y2: pos,
        value: to - from,
      },
      Axis::Y => Gap {
        x1: pos,
        y1: from,
        x2: pos,
        y2: to,
        value: to - from,
      },
    });
  }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Handle {
  N,
  S,
  E,
  W,
  Ne,
  Nw,
  Se,
  Sw,
}

impl Handle {
  /// Direction factors: which side of each axis moves.
  pub fn factors(self) -> (f64, f64) {
    match self {
      Handle::N => (0.0, -1.0),
      Handle::S => (0.0, 1.0),
      Handle::E => (1.0, 0.0),
      Handle::W => (-1.0, 0.0),
      Handle::Ne => (1.0, -1.0),
      Handle::Nw => (-1.0, -1.0),
      Handle::Se => (1.0, 1.0),
      Handle::Sw => (-1.0, 1.0),
    }
  }
}

/// Resizes one node from its gesture-start state (`start`) by a page-space pointer delta.
pub fn resize_node(doc: &mut Document, start: &Node, handle: Handle, delta: Point, keep_aspect: bool, from_center: bool) {
  let id = start.id.clone();
  let pm_inv = doc.parent_matrix(&id).invert();
  let d_parent = pm_inv.apply_vec(delta);
  let d = Mat::rotate_deg(-start.rotation).apply_vec(d_parent);
  let (fx, fy) = handle.factors();
  let mult = if from_center { 2.0 } else { 1.0 };
  let (w0, h0) = (start.width, start.height);
  let mut w = w0 + fx * d.x * mult;
  let mut h = h0 + fy * d.y * mult;
  if start.kind == NodeType::Line {
    h = 0.0;
  } else if keep_aspect && w0 > 0.0 && h0 > 0.0 {
    let ratio = w0 / h0;
    // Each axis keeps its own sign so a corner can still cross one edge at a time.
    if fx != 0.0 && fy != 0.0 {
      if (w / w0).abs() > (h / h0).abs() {
        h = h.signum() * (w / ratio).abs();
      } else {
        w = w.signum() * (h * ratio).abs();
      }
    } else if fx != 0.0 {
      h = (w / ratio).abs();
    } else {
      w = (h * ratio).abs();
    }
  }
  // Dragged past the opposite edge, the box flips there and keeps following the cursor.
  let (fx1, fy1) = (if w < 0.0 { -fx } else { fx }, if h < 0.0 { -fy } else { fy });
  // Whole-pixel input gives whole-pixel boxes; anything else is rounded to 0.01 px.
  let whole = !keep_aspect && [w0, h0, d.x, d.y].iter().all(|v| v.fract() == 0.0);
  let tidy = |v: f64| if whole { v.round() } else { (v * 100.0).round() / 100.0 };
  let w = tidy(w.abs()).max(1.0);
  let h = if start.kind == NodeType::Line {
    0.0
  } else {
    tidy(h.abs()).max(1.0)
  };

  let anchor_of = |f: f64, size: f64| {
    if from_center || f == 0.0 {
      size / 2.0
    } else if f > 0.0 {
      0.0
    } else {
      size
    }
  };
  let a0 = Point::new(anchor_of(fx, w0), anchor_of(fy, h0));
  let a1 = Point::new(anchor_of(fx1, w), anchor_of(fy1, h));
  let m0 = local_matrix(start.x, start.y, w0, h0, start.rotation, start.flip_x, start.flip_y);
  let anchor_parent = m0.apply(a0);
  let c = Point::new(w / 2.0, h / 2.0);
  let r = Mat::rotate_deg(start.rotation);
  let rp = r.apply_vec(Point::new(a1.x - c.x, a1.y - c.y));
  let mut x = anchor_parent.x - c.x - rp.x;
  let mut y = anchor_parent.y - c.y - rp.y;
  // Rotated boxes keep their exact anchor; upright ones are tidied like the size.
  if start.rotation == 0.0 {
    let whole_pos = whole && start.x.fract() == 0.0 && start.y.fract() == 0.0;
    let tidy_pos = |v: f64| if whole_pos { v.round() } else { (v * 100.0).round() / 100.0 };
    x = tidy_pos(x);
    y = tidy_pos(y);
  }
  set_geometry(doc, start, x, y, w, h, fx != 0.0, fy != 0.0);
}

/// Applies a new box to a node, scaling content where the node type requires it.
#[allow(clippy::too_many_arguments)]
pub fn set_geometry(doc: &mut Document, start: &Node, x: f64, y: f64, w: f64, h: f64, changed_w: bool, changed_h: bool) {
  let id = start.id.clone();
  let (sx, sy) = (
    if start.width > 0.0 { w / start.width } else { 1.0 },
    if start.height > 0.0 { h / start.height } else { 1.0 },
  );
  if let Some(n) = doc.get_mut(&id) {
    n.x = x;
    n.y = y;
    n.width = w;
    n.height = h;
    if let Some(t) = n.text.as_mut() {
      if changed_w && t.auto_resize == TextAutoResize::Width {
        t.auto_resize = TextAutoResize::Height;
      }
      if changed_h {
        t.auto_resize = TextAutoResize::None;
      }
    }
    if changed_w && n.sizing_h == crate::model::Sizing::Hug {
      n.sizing_h = crate::model::Sizing::Fixed;
    }
    if changed_h && n.sizing_v == crate::model::Sizing::Hug {
      n.sizing_v = crate::model::Sizing::Fixed;
    }
    if let (Some(v), Some(v0)) = (n.vector.as_mut(), start.vector.as_ref()) {
      for (sp, sp0) in v.subpaths.iter_mut().zip(v0.subpaths.iter()) {
        for (p, p0) in sp.points.iter_mut().zip(sp0.points.iter()) {
          p.x = p0.x * sx;
          p.y = p0.y * sy;
          p.in_x = p0.in_x * sx;
          p.in_y = p0.in_y * sy;
          p.out_x = p0.out_x * sx;
          p.out_y = p0.out_y * sy;
        }
      }
    }
  }
  match start.kind {
    NodeType::Group => scale_children(doc, &id, sx, sy),
    k if k.is_frame_like() => crate::layout::apply_constraints(doc, &id, start.width, start.height),
    _ => {}
  }
}

fn scale_children(doc: &mut Document, id: &str, sx: f64, sy: f64) {
  let children = doc.get(id).map(|n| n.children.clone()).unwrap_or_default();
  for c in children {
    let Some(start) = doc.get(&c).cloned() else { continue };
    set_geometry(
      doc,
      &start,
      start.x * sx,
      start.y * sy,
      (start.width * sx).max(0.5),
      (start.height * sy).max(if start.kind == NodeType::Line { 0.0 } else { 0.5 }),
      true,
      true,
    );
  }
}

/// Scales several nodes as one selection box (page space).
pub fn resize_many(doc: &mut Document, starts: &[Node], from: Rect, to: Rect) {
  let sx = if from.width > 0.0 { to.width / from.width } else { 1.0 };
  let sy = if from.height > 0.0 { to.height / from.height } else { 1.0 };
  for s in starts {
    let b = doc.abs_bounds(&s.id);
    let nb = Rect::new(to.x + (b.x - from.x) * sx, to.y + (b.y - from.y) * sy, b.width * sx, b.height * sy);
    let pm_inv = doc.parent_matrix(&s.id).invert();
    let tl = pm_inv.apply(Point::new(nb.x, nb.y));
    // Rounded to 0.01 px so scaling doesn't leave float noise in the panel.
    let tidy = |v: f64| (v * 100.0).round() / 100.0;
    let w = tidy(s.width * sx).max(1.0);
    let h = if s.kind == NodeType::Line {
      0.0
    } else {
      tidy(s.height * sy).max(1.0)
    };
    // Keep the rotated box's bounds top-left where the scaled bounds start.
    let m = local_matrix(0.0, 0.0, w, h, s.rotation, s.flip_x, s.flip_y);
    let off = m.bounds_of(w, h);
    set_geometry(doc, s, tidy(tl.x - off.x), tidy(tl.y - off.y), w, h, sx != 1.0, sy != 1.0);
  }
}

/// Pen/pencil tool output (page-space points) to a vector node in `parent`.
pub fn vector_from_points(
  doc: &Document,
  gen: &mut IdGen,
  parent: Option<&str>,
  points: &[crate::model::VectorPoint],
  closed: bool,
) -> Option<Node> {
  if points.len() < 2 {
    return None;
  }
  let pm_inv = match parent {
    Some(p) => doc.abs_matrix(p).invert(),
    None => Mat::IDENTITY,
  };
  let local: Vec<crate::model::VectorPoint> = points
    .iter()
    .map(|p| {
      let a = pm_inv.apply(Point::new(p.x, p.y));
      let i = pm_inv.apply_vec(Point::new(p.in_x, p.in_y));
      let o = pm_inv.apply_vec(Point::new(p.out_x, p.out_y));
      crate::model::VectorPoint {
        x: a.x,
        y: a.y,
        in_x: i.x,
        in_y: i.y,
        out_x: o.x,
        out_y: o.y,
      }
    })
    .collect();
  let sp = crate::model::SubPath { points: local, closed };
  let (x0, y0, x1, y1) = shapes::subpaths_bounds(std::slice::from_ref(&sp))?;
  let mut sp = sp;
  for p in sp.points.iter_mut() {
    p.x -= x0;
    p.y -= y0;
  }
  let mut n = crate::ops::default_node(NodeType::Vector, gen.next("n_"), doc.next_name("Vector"));
  n.x = x0;
  n.y = y0;
  n.width = (x1 - x0).max(1.0);
  n.height = (y1 - y0).max(1.0);
  if closed {
    n.fills = vec![crate::model::Paint::solid("#D9D9D9")];
  }
  n.vector = Some(crate::model::VectorData {
    subpaths: vec![sp],
    raw: None,
  });
  Some(n)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::new_document;

  fn doc_with_frame() -> (Document, String) {
    let mut gen = IdGen::new(2);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let f = Node {
      id: "f".into(),
      kind: NodeType::Frame,
      width: 300.0,
      height: 300.0,
      ..Default::default()
    };
    doc.insert(f, None, &page, None);
    let g = Node {
      id: "g".into(),
      kind: NodeType::Group,
      x: 10.0,
      y: 10.0,
      width: 100.0,
      height: 100.0,
      ..Default::default()
    };
    doc.insert(g, Some("f"), &page, None);
    let r = Node {
      id: "r".into(),
      width: 50.0,
      height: 50.0,
      ..Default::default()
    };
    doc.insert(r, Some("g"), &page, None);
    (doc, page)
  }

  #[test]
  fn pick_selects_group_then_drills() {
    let (doc, page) = doc_with_frame();
    let p = Point::new(20.0, 20.0);
    assert_eq!(hit_test(&doc, &page, p, 1.0).as_deref(), Some("r"));
    assert_eq!(pick(&doc, &page, p, 1.0, &[], false).as_deref(), Some("g"));
    assert_eq!(drill(&doc, &page, p, 1.0, "g").as_deref(), Some("r"));
    assert_eq!(pick(&doc, &page, p, 1.0, &["r".into()], false).as_deref(), Some("r"));
    assert_eq!(pick(&doc, &page, Point::new(200.0, 200.0), 1.0, &[], false).as_deref(), Some("f"));
  }

  #[test]
  fn pick_with_top_level_frame_selected_returns_its_child() {
    let (doc, page) = doc_with_frame();
    let p = Point::new(20.0, 20.0);
    // The selected frame doesn't capture hits on its content: the direct child is picked.
    assert_eq!(pick(&doc, &page, p, 1.0, &["f".into()], false).as_deref(), Some("g"));
    // Empty frame area still picks the frame itself.
    assert_eq!(
      pick(&doc, &page, Point::new(200.0, 200.0), 1.0, &["f".into()], false).as_deref(),
      Some("f")
    );
    // A selected nested group stays selected (drill-down state is kept).
    assert_eq!(pick(&doc, &page, p, 1.0, &["g".into()], false).as_deref(), Some("g"));
    // Frame plus its child selected: stays at the child's depth.
    assert_eq!(pick(&doc, &page, p, 1.0, &["f".into(), "g".into()], false).as_deref(), Some("g"));
  }

  #[test]
  fn pick_keeps_a_multi_selection_of_frames() {
    let (mut doc, page) = doc_with_frame();
    node(&mut doc, &page, "f2", NodeType::Frame, None, (400.0, 0.0, 300.0, 300.0));
    // Pressing inside one selected frame must not narrow the selection to a child.
    let sel = ["f".to_string(), "f2".to_string()];
    assert_eq!(pick(&doc, &page, Point::new(20.0, 20.0), 1.0, &sel, false).as_deref(), Some("f"));
  }

  #[test]
  fn pick_under_a_selected_top_level_container_stops_at_instances_components_and_sets() {
    let (mut doc, page) = doc_with_frame();
    // An instance inside the selected frame is picked whole, not its internals.
    node(&mut doc, &page, "i", NodeType::Instance, Some("f"), (150.0, 150.0, 100.0, 100.0));
    node(&mut doc, &page, "ir", NodeType::Rectangle, Some("i"), (0.0, 0.0, 50.0, 50.0));
    assert_eq!(
      pick(&doc, &page, Point::new(160.0, 160.0), 1.0, &["f".into()], false).as_deref(),
      Some("i")
    );
    // A selected main component and a component set hand out their child.
    node(&mut doc, &page, "c", NodeType::Component, None, (0.0, 400.0, 100.0, 100.0));
    node(&mut doc, &page, "cr", NodeType::Rectangle, Some("c"), (10.0, 10.0, 50.0, 50.0));
    assert_eq!(
      pick(&doc, &page, Point::new(20.0, 420.0), 1.0, &["c".into()], false).as_deref(),
      Some("cr")
    );
    node(&mut doc, &page, "cs", NodeType::ComponentSet, None, (400.0, 400.0, 200.0, 200.0));
    node(&mut doc, &page, "v", NodeType::Component, Some("cs"), (20.0, 20.0, 100.0, 100.0));
    node(&mut doc, &page, "vr", NodeType::Rectangle, Some("v"), (10.0, 10.0, 50.0, 50.0));
    assert_eq!(
      pick(&doc, &page, Point::new(440.0, 440.0), 1.0, &["cs".into()], false).as_deref(),
      Some("v")
    );
  }

  #[test]
  fn resize_from_west_keeps_east_edge() {
    let (mut doc, _) = doc_with_frame();
    let start = doc.get("f").unwrap().clone();
    resize_node(&mut doc, &start, Handle::W, Point::new(50.0, 0.0), false, false);
    let f = doc.get("f").unwrap();
    assert_eq!((f.x, f.width), (50.0, 250.0));
  }

  #[test]
  fn resize_past_the_opposite_edge_flips() {
    let (mut doc, page) = doc_with_frame();
    let r = Node {
      id: "a".into(),
      x: 500.0,
      y: 100.0,
      width: 100.0,
      height: 100.0,
      ..Default::default()
    };
    doc.insert(r, None, &page, None);
    let start = doc.get("a").unwrap().clone();
    resize_node(&mut doc, &start, Handle::E, Point::new(-150.0, 0.0), false, false);
    let a = doc.get("a").unwrap();
    assert_eq!((a.x, a.width), (450.0, 50.0), "follows the cursor past the west edge");
    resize_node(&mut doc, &start, Handle::Nw, Point::new(130.0, 160.0), false, false);
    let a = doc.get("a").unwrap();
    assert_eq!((a.x, a.y, a.width, a.height), (600.0, 200.0, 30.0, 60.0));
    // Sub-pixel input lands on two decimals instead of float noise.
    resize_node(&mut doc, &start, Handle::S, Point::new(0.0, 30.000_01), false, false);
    assert_eq!(doc.get("a").unwrap().height, 130.0);
    resize_node(&mut doc, &start, Handle::S, Point::new(0.0, 0.1 + 0.2), false, false);
    assert_eq!(doc.get("a").unwrap().height, 100.3);
  }

  #[test]
  fn resize_rotated_keeps_anchor() {
    let (mut doc, _) = doc_with_frame();
    doc.get_mut("f").unwrap().rotation = 90.0;
    let start = doc.get("f").unwrap().clone();
    let anchor_before = doc.abs_matrix("f").apply(Point::new(0.0, 0.0));
    // With 90° rotation the local +x axis points down the page.
    resize_node(&mut doc, &start, Handle::E, Point::new(0.0, 40.0), false, false);
    let f = doc.get("f").unwrap();
    assert!((f.width - 340.0).abs() < 1e-6);
    let anchor_after = doc.abs_matrix("f").apply(Point::new(0.0, 0.0));
    assert!((anchor_before.x - anchor_after.x).abs() < 1e-6 && (anchor_before.y - anchor_after.y).abs() < 1e-6);
  }

  #[test]
  fn snapping_aligns_left_edges() {
    let (mut doc, page) = doc_with_frame();
    doc.insert(
      Node {
        id: "a".into(),
        x: 400.0,
        y: 0.0,
        width: 50.0,
        height: 50.0,
        ..Default::default()
      },
      None,
      &page,
      None,
    );
    // Move "a" so its left edge lands 3px from the frame's right edge (300).
    let s = snap_move(&doc, &page, &["a".into()], -97.0, 100.0, 1.0);
    assert_eq!(s.dx, -100.0);
    assert!(!s.guides.is_empty());
  }

  #[test]
  fn marquee_descends_into_frames() {
    let (doc, page) = doc_with_frame();
    assert_eq!(marquee(&doc, &page, Rect::new(0.0, 0.0, 50.0, 50.0)), vec!["g".to_string()]);
    assert_eq!(marquee(&doc, &page, Rect::new(-10.0, -10.0, 400.0, 400.0)), vec!["f".to_string()]);
  }

  type Box4 = (f64, f64, f64, f64);

  fn flat_doc(rects: &[(&str, Box4)]) -> (Document, String) {
    let mut doc = new_document(&mut IdGen::new(2), "t");
    let page = doc.pages[0].id.clone();
    for (id, r) in rects {
      node(&mut doc, &page, id, NodeType::Rectangle, None, *r);
    }
    (doc, page)
  }

  fn values(m: &Measurement) -> Vec<f64> {
    m.lines.iter().map(|l| l.value).collect()
  }

  #[test]
  fn move_snaps_to_equal_gaps_between_neighbours() {
    // A row with gaps A-B 100 and B-C 120: B 3px off the 110/110 split. D is far below the row.
    let (doc, page) = flat_doc(&[
      ("a", (-300.0, -300.0, 100.0, 100.0)),
      ("b", (-100.0, -260.0, 80.0, 60.0)),
      ("c", (100.0, -300.0, 60.0, 60.0)),
      ("d", (-100.0, 2000.0, 80.0, 60.0)),
    ]);
    // Dragged 7px right (x=-93) snaps to x=-90: dx 10.
    let s = snap_move(&doc, &page, &["b".into()], 7.0, 0.0, 1.0);
    assert!((s.dx - 10.0).abs() < 1e-9, "snapped to x=-90, got dx {}", s.dx);
    assert_eq!(s.gaps.len(), 2);
    assert!(s.gaps.iter().all(|g| (g.value - 110.0).abs() < 1e-9));
    // Out of range: no spacing snap.
    let far = snap_move(&doc, &page, &["b".into()], 20.0, 0.0, 1.0);
    assert!(far.gaps.is_empty());
    // A layer far from the row (no shared rows) has nothing to space against, even at the
    // x position that would be equal if it were in the row.
    let d = snap_move(&doc, &page, &["d".into()], 7.0, 0.0, 1.0);
    assert!(d.gaps.is_empty(), "far layer spacing-snapped: {:?}", d.gaps);
    assert_eq!(d.dx, 7.0);
    // Unaligned (staircase) layers don't count either: B moved a row below A and C.
    let (doc, page) = flat_doc(&[
      ("a", (-300.0, -300.0, 100.0, 100.0)),
      ("b", (-100.0, -100.0, 80.0, 60.0)),
      ("c", (100.0, -300.0, 60.0, 60.0)),
    ]);
    let s = snap_move(&doc, &page, &["b".into()], 7.0, 0.0, 1.0);
    assert!(s.gaps.is_empty() && s.dx == 7.0, "{s:?}");
  }

  #[test]
  fn move_repeats_the_gap_between_two_siblings() {
    // A and B are 40 apart; C dragged to the right of B lands 40 away (x=180).
    let (doc, page) = flat_doc(&[
      ("a", (0.0, 0.0, 50.0, 50.0)),
      ("b", (90.0, 0.0, 50.0, 50.0)),
      ("c", (200.0, 0.0, 50.0, 50.0)),
    ]);
    let s = snap_move(&doc, &page, &["c".into()], -17.0, 0.0, 1.0);
    assert!((s.dx - -20.0).abs() < 1e-9, "dx {}", s.dx);
    assert_eq!(s.gaps.len(), 2);
    assert!(s.gaps.iter().all(|g| (g.value - 40.0).abs() < 1e-9));
    // Same on the vertical axis.
    let (doc, page) = flat_doc(&[
      ("a", (0.0, 0.0, 50.0, 50.0)),
      ("b", (0.0, 90.0, 50.0, 50.0)),
      ("c", (0.0, 200.0, 50.0, 50.0)),
    ]);
    let s = snap_move(&doc, &page, &["c".into()], 0.0, -17.0, 1.0);
    assert!((s.dy - -20.0).abs() < 1e-9, "dy {}", s.dy);
  }

  #[test]
  fn edge_alignment_wins_over_spacing_on_a_tie() {
    // B's left edge is already on A's right edge; the equal-gap position is further away.
    let (doc, page) = flat_doc(&[
      ("a", (0.0, 0.0, 100.0, 50.0)),
      ("b", (103.0, 0.0, 40.0, 50.0)),
      ("c", (204.0, 0.0, 50.0, 50.0)),
    ]);
    let s = snap_move(&doc, &page, &["b".into()], -3.0, 0.0, 1.0);
    assert_eq!(s.dx, -3.0);
    assert!(s.gaps.is_empty());
  }

  #[test]
  fn resize_snaps_the_moving_edge_to_an_equal_gap() {
    // B's right edge is dragged; the gap B-C should equal the gap A-B (40).
    let (doc, page) = flat_doc(&[
      ("a", (0.0, 0.0, 50.0, 50.0)),
      ("b", (90.0, 0.0, 50.0, 50.0)),
      ("c", (260.0, 0.0, 50.0, 50.0)),
    ]);
    let r = Rect::new(90.0, 0.0, 127.0, 50.0);
    let (out, _, gaps) = snap_rect(&doc, &page, &["b".into()], r, [false, true, false, false], 1.0, true);
    assert!((out.right() - 220.0).abs() < 1e-9, "right edge {}", out.right());
    assert_eq!(out.x, 90.0);
    assert_eq!(gaps.len(), 2);
    // A point (drawing tools) never spaces.
    let (_, _, none) = snap_rect(
      &doc,
      &page,
      &[],
      Rect::new(221.0, 0.0, 0.0, 0.0),
      [true, false, true, false],
      1.0,
      true,
    );
    assert!(none.is_empty());
  }

  #[test]
  fn measure_nested_layer_reports_inner_edges_of_the_parent() {
    let (mut doc, page) = flat_doc(&[]);
    node(&mut doc, &page, "f", NodeType::Frame, None, (0.0, 0.0, 400.0, 300.0));
    node(&mut doc, &page, "r", NodeType::Rectangle, Some("f"), (50.0, 40.0, 100.0, 60.0));
    // Hovering the frame's empty area from the rectangle: four distances.
    let m = measure_at(&doc, &page, &["r".into()], None, Point::new(300.0, 250.0), 1.0).unwrap();
    assert_eq!(m.target, "f");
    assert_eq!(values(&m), vec![50.0, 250.0, 40.0, 200.0]);
    assert!(m.extends.is_empty());
    let left = &m.lines[0];
    assert_eq!((left.x1, left.x2, left.y1), (0.0, 50.0, 70.0));
    // Over the selection itself the distances are to its parent; a top-level selection has none.
    let own = measure_at(&doc, &page, &["r".into()], Some("r"), Point::new(60.0, 50.0), 1.0).unwrap();
    assert_eq!(own.target, "f");
    assert!(measure_at(&doc, &page, &["f".into()], Some("f"), Point::new(60.0, 50.0), 1.0).is_none());
    assert!(measure_at(&doc, &page, &["r".into()], None, Point::new(900.0, 900.0), 1.0).is_none());
  }

  #[test]
  fn measure_uses_the_hovered_layer_not_its_deepest_child() {
    let (mut doc, page) = flat_doc(&[("s", (0.0, 0.0, 40.0, 40.0))]);
    node(&mut doc, &page, "btn", NodeType::Frame, None, (200.0, 0.0, 100.0, 40.0));
    node(&mut doc, &page, "label", NodeType::Rectangle, Some("btn"), (10.0, 10.0, 30.0, 20.0));
    // The pointer is over the label, but the hover (button) is what gets measured.
    let p = Point::new(215.0, 15.0);
    let whole = measure_at(&doc, &page, &["s".into()], Some("btn"), p, 1.0).unwrap();
    assert_eq!((whole.target.as_str(), values(&whole)[0]), ("btn", 160.0));
    // Without a hover the deepest layer under the pointer is the fallback.
    let deep = measure_at(&doc, &page, &["s".into()], None, p, 1.0).unwrap();
    assert_eq!(deep.target, "label");
  }

  #[test]
  fn measure_between_siblings_overlapping_and_diagonal() {
    let (doc, _) = flat_doc(&[
      ("a", (0.0, 0.0, 100.0, 100.0)),
      ("b", (160.0, 20.0, 80.0, 40.0)),
      ("c", (200.0, 200.0, 50.0, 50.0)),
      ("d", (50.0, 50.0, 100.0, 100.0)),
    ]);
    // Side by side, b within a's rows: the gap across them, then b's insets from a's top and bottom.
    let m = measure_to(&doc, &["a".into()], "b").unwrap();
    assert_eq!((values(&m), m.lines[0].y1), (vec![60.0, 20.0, 40.0], 40.0));
    // Diagonal: a horizontal and a vertical gap, each joined to c by a dashed projection.
    let m = measure_to(&doc, &["a".into()], "c").unwrap();
    assert_eq!(values(&m), vec![100.0, 100.0]);
    assert_eq!(m.extends.len(), 2);
    // Partial overlap: start-to-start and end-to-end distances on both axes.
    let m = measure_to(&doc, &["a".into()], "d").unwrap();
    assert_eq!(values(&m), vec![50.0, 50.0, 50.0, 50.0]);
    // A multi-selection measures from its bounds (0..240 x 0..100).
    let m = measure_to(&doc, &["a".into(), "b".into()], "c").unwrap();
    assert_eq!(values(&m), vec![200.0, 10.0, 100.0]);
  }

  fn node(doc: &mut Document, page: &str, id: &str, kind: NodeType, parent: Option<&str>, (x, y, w, h): (f64, f64, f64, f64)) {
    let n = Node {
      id: id.into(),
      kind,
      x,
      y,
      width: w,
      height: h,
      ..Default::default()
    };
    doc.insert(n, parent, page, None);
  }
}
