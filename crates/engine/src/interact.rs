//! Canvas interaction math: hit-testing, Figma-style selection picking,
//! marquee selection, smart-guide snapping and resize.

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
      // A selected top-level frame never captures hits on its descendants: its
      // direct child is picked, as when nothing is selected.
      let k = if k == 0 && k + 1 < path.len() && is_top_container(doc, &path[0]) {
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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Snap {
  pub dx: f64,
  pub dy: f64,
  pub guides: Vec<Guide>,
}

/// What moving nodes may snap to: sibling/parent/top-level frame rects, plus
/// page guides and layout grid lines as (position, span start, span end).
struct Targets {
  rects: Vec<Rect>,
  xs: Vec<(f64, f64, f64)>,
  ys: Vec<(f64, f64, f64)>,
}

fn snap_targets(doc: &Document, page: &str, moving: &[NodeId]) -> Targets {
  let excluded: Vec<NodeId> = moving.iter().flat_map(|m| doc.subtree(m)).collect();
  let mut ids: Vec<NodeId> = Vec::new();
  if let Some(first) = moving.first() {
    ids.extend(doc.siblings_of(first));
    if let Some(p) = doc.get(first).and_then(|n| n.parent.clone()) {
      ids.push(p);
    }
  }
  if let Some(pg) = doc.page(page) {
    ids.extend(pg.children.iter().cloned());
  }
  ids.sort();
  ids.dedup();
  let rects = ids
    .into_iter()
    .filter(|i| !excluded.contains(i))
    .filter(|i| doc.get(i).map(|n| n.visible).unwrap_or(false))
    .map(|i| doc.abs_bounds(&i))
    .collect();
  let mut t = Targets {
    rects,
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

/// Snaps a page-space move delta of `ids` to nearby edges and centres.
pub fn snap_move(doc: &Document, page: &str, ids: &[NodeId], dx: f64, dy: f64, zoom: f64) -> Snap {
  let Some(start) = doc.bounds_of_many(ids) else {
    return Snap { dx, dy, guides: vec![] };
  };
  let moved = Rect::new(start.x + dx, start.y + dy, start.width, start.height);
  let targets = snap_targets(doc, page, ids);
  let thr = 6.0 / zoom.max(0.01);
  let (sx, sy) = best_snap(&moved, &targets, thr, [true, true, true, true]);
  let mut out = Snap {
    dx: sx.map(|s| dx + s).unwrap_or_else(|| (start.x + dx).round() - start.x),
    dy: sy.map(|s| dy + s).unwrap_or_else(|| (start.y + dy).round() - start.y),
    guides: vec![],
  };
  let fin = Rect::new(start.x + out.dx, start.y + out.dy, start.width, start.height);
  out.guides = guides_for(&fin, &targets, sx.is_some(), sy.is_some());
  out
}

/// Snaps an axis-aligned rect whose `edges` [left, right, top, bottom] are moving.
pub fn snap_rect(doc: &Document, page: &str, exclude: &[NodeId], r: Rect, edges: [bool; 4], zoom: f64) -> (Rect, Vec<Guide>) {
  let targets = snap_targets(doc, page, exclude);
  let thr = 6.0 / zoom.max(0.01);
  let (sx, sy) = best_snap(&r, &targets, thr, edges);
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
  let guides = guides_for(&out, &targets, sx.is_some(), sy.is_some());
  (out, guides)
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
}
