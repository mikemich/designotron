//! Structural document operations shared by commands and AI tools.

use crate::doc::{normalize_angle, IdGen};
use crate::geom::{Point, Rect};
use crate::model::{Document, Node, NodeId, NodeType, Paint, ShapeProps, TextProps};

/// Drops ids whose ancestor is also in the list (so subtrees are handled once).
pub fn top_most(doc: &Document, ids: &[NodeId]) -> Vec<NodeId> {
  ids
    .iter()
    .filter(|id| doc.nodes.contains_key(*id))
    .filter(|id| !doc.ancestors(id).iter().any(|a| ids.contains(a)))
    .cloned()
    .collect()
}

/// Sorts ids into paint order (bottom first) within the document.
pub fn paint_order(doc: &Document, ids: &[NodeId]) -> Vec<NodeId> {
  let mut out: Vec<NodeId> = Vec::new();
  for p in &doc.pages {
    for nid in doc.page_nodes(&p.id) {
      if ids.contains(&nid) {
        out.push(nid);
      }
    }
  }
  out
}

/// Wraps nodes in a new container placed at their combined bounds.
pub fn wrap_in_frame(doc: &mut Document, ids: &[NodeId], gen: &mut IdGen, kind: NodeType) -> Option<NodeId> {
  let ids = paint_order(doc, &top_most(doc, ids));
  let first = doc.get(ids.first()?)?.clone();
  let parent = first.parent.clone();
  let page = first.page.clone();
  let parent_inv = doc.parent_matrix(&first.id).invert();
  let abs = doc.bounds_of_many(&ids)?;
  let tl = parent_inv.apply(Point::new(abs.x, abs.y));
  let index = ids.iter().filter_map(|i| doc.index_in_parent(i)).max().map(|i| i + 1);
  let id = gen.next("n_");
  let name = match kind {
    NodeType::Group => doc.next_name("Group"),
    NodeType::ComponentSet => "Component Set".into(),
    _ => doc.next_name("Frame"),
  };
  let frame = Node {
    id: id.clone(),
    kind,
    name,
    x: tl.x,
    y: tl.y,
    width: abs.width.max(1.0),
    height: abs.height.max(1.0),
    fills: if kind == NodeType::Frame {
      vec![Paint::solid("#FFFFFF")]
    } else {
      vec![]
    },
    ..Default::default()
  };
  doc.insert(frame, parent.as_deref(), &page, index);
  for nid in &ids {
    doc.reparent(nid, Some(&id), None, true);
  }
  Some(id)
}

pub fn group(doc: &mut Document, ids: &[NodeId], gen: &mut IdGen) -> Option<NodeId> {
  let id = wrap_in_frame(doc, ids, gen, NodeType::Group)?;
  crate::layout::normalize_group(doc, &id);
  Some(id)
}

/// Moves a container's children up one level and deletes the container.
pub fn ungroup(doc: &mut Document, id: &str) -> Vec<NodeId> {
  let Some(n) = doc.get(id).cloned() else { return vec![] };
  if !n.kind.is_container() || n.kind == NodeType::Instance {
    return vec![];
  }
  let start = doc.index_in_parent(id).unwrap_or(0);
  for (index, c) in (start..).zip(n.children.iter()) {
    doc.reparent(c, n.parent.as_deref(), Some(index), true);
  }
  doc.remove(id);
  n.children
}

pub fn delete(doc: &mut Document, ids: &[NodeId]) {
  for id in top_most(doc, ids) {
    let parent = doc.get(&id).and_then(|n| n.parent.clone());
    doc.remove(&id);
    prune_empty_groups(doc, parent);
  }
  // A deleted starting frame leaves its page without one, so Present falls back to its first frame.
  let Document { pages, nodes, .. } = doc;
  for p in pages.iter_mut() {
    if p.flow_start.as_ref().is_some_and(|s| !nodes.contains_key(s)) {
      p.flow_start = None;
    }
  }
}

fn prune_empty_groups(doc: &mut Document, mut cur: Option<NodeId>) {
  while let Some(p) = cur {
    let Some(n) = doc.get(&p) else { return };
    if n.kind == NodeType::Group && n.children.is_empty() {
      let next = n.parent.clone();
      doc.remove(&p);
      cur = next;
    } else {
      return;
    }
  }
}

pub fn duplicate(doc: &mut Document, ids: &[NodeId], gen: &mut IdGen, offset: Point) -> Vec<NodeId> {
  let mut out = Vec::new();
  for id in paint_order(doc, &top_most(doc, ids)) {
    let Some(orig) = doc.get(&id).cloned() else { continue };
    let (nodes, _) = doc.clone_subtree(&id, gen);
    let index = doc.index_in_parent(&id).map(|i| i + 1);
    let root_id = nodes[0].id.clone();
    for (i, mut n) in nodes.into_iter().enumerate() {
      if i == 0 {
        n.x += offset.x;
        n.y += offset.y;
        n.parent = orig.parent.clone();
        doc.insert(n, orig.parent.as_deref(), &orig.page, index);
      } else {
        doc.nodes.insert(n.id.clone(), n);
      }
    }
    out.push(root_id);
  }
  out
}

/// Moves nodes by a page-space delta.
pub fn move_by(doc: &mut Document, ids: &[NodeId], dx: f64, dy: f64) {
  for id in top_most(doc, ids) {
    if doc.get(&id).map(|n| n.locked).unwrap_or(true) {
      continue;
    }
    let pm = doc.parent_matrix(&id).invert();
    let d = pm.apply_vec(Point::new(dx, dy));
    if let Some(n) = doc.get_mut(&id) {
      n.x += d.x;
      n.y += d.y;
    }
  }
}

/// Sets the page-space top-left of a node's axis-aligned bounds.
pub fn move_abs_to(doc: &mut Document, id: &str, x: f64, y: f64) {
  let b = doc.abs_bounds(id);
  move_by(doc, &[id.to_string()], x - b.x, y - b.y);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlignHow {
  Left,
  HCenter,
  Right,
  Top,
  VCenter,
  Bottom,
}

pub fn align(doc: &mut Document, ids: &[NodeId], how: AlignHow) {
  let ids = top_most(doc, ids);
  let target = if ids.len() == 1 {
    match doc.get(&ids[0]).and_then(|n| n.parent.clone()) {
      Some(p) => doc.abs_bounds(&p),
      None => return,
    }
  } else {
    match doc.bounds_of_many(&ids) {
      Some(b) => b,
      None => return,
    }
  };
  for id in &ids {
    let b = doc.abs_bounds(id);
    let (dx, dy) = match how {
      AlignHow::Left => (target.x - b.x, 0.0),
      AlignHow::HCenter => (target.center().x - b.center().x, 0.0),
      AlignHow::Right => (target.right() - b.right(), 0.0),
      AlignHow::Top => (0.0, target.y - b.y),
      AlignHow::VCenter => (0.0, target.center().y - b.center().y),
      AlignHow::Bottom => (0.0, target.bottom() - b.bottom()),
    };
    move_by(doc, std::slice::from_ref(id), dx, dy);
  }
}

/// Spaces nodes evenly along an axis (`horizontal` = x).
pub fn distribute(doc: &mut Document, ids: &[NodeId], horizontal: bool) {
  let mut items: Vec<(NodeId, Rect)> = top_most(doc, ids).into_iter().map(|i| (i.clone(), doc.abs_bounds(&i))).collect();
  if items.len() < 3 {
    return;
  }
  items.sort_by(|a, b| {
    let (ka, kb) = if horizontal { (a.1.x, b.1.x) } else { (a.1.y, b.1.y) };
    ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal)
  });
  let first = items.first().unwrap().1;
  let last = items.last().unwrap().1;
  let total: f64 = items.iter().map(|(_, r)| if horizontal { r.width } else { r.height }).sum();
  let span = if horizontal {
    last.right() - first.x
  } else {
    last.bottom() - first.y
  };
  let gap = (span - total) / (items.len() as f64 - 1.0);
  let mut cursor = if horizontal { first.x } else { first.y };
  for (id, r) in &items {
    if horizontal {
      move_by(doc, std::slice::from_ref(id), cursor - r.x, 0.0);
      cursor += r.width + gap;
    } else {
      move_by(doc, std::slice::from_ref(id), 0.0, cursor - r.y);
      cursor += r.height + gap;
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReorderTo {
  Front,
  Back,
  Forward,
  Backward,
}

pub fn reorder(doc: &mut Document, ids: &[NodeId], to: ReorderTo) {
  let mut ids = paint_order(doc, &top_most(doc, ids));
  if matches!(to, ReorderTo::Front | ReorderTo::Forward) {
    ids.reverse();
  }
  for id in ids {
    let Some(n) = doc.get(&id).cloned() else { continue };
    let siblings = doc.siblings_of(&id);
    let Some(i) = siblings.iter().position(|s| *s == id) else {
      continue;
    };
    let len = siblings.len();
    let target = match to {
      ReorderTo::Front => len - 1,
      ReorderTo::Back => 0,
      ReorderTo::Forward => (i + 1).min(len - 1),
      ReorderTo::Backward => i.saturating_sub(1),
    };
    if target == i {
      continue;
    }
    doc.reparent(&id, n.parent.as_deref(), Some(target), false);
  }
}

/// Rotates nodes by `delta` degrees around a page-space pivot.
pub fn rotate(doc: &mut Document, ids: &[NodeId], delta: f64, pivot: Point) {
  let (s, c) = delta.to_radians().sin_cos();
  for id in top_most(doc, ids) {
    let kind = doc.get(&id).map(|n| n.kind);
    if kind == Some(NodeType::Group) {
      let children = doc.get(&id).unwrap().children.clone();
      rotate(doc, &children, delta, pivot);
      continue;
    }
    let Some(n) = doc.get(&id).cloned() else { continue };
    let abs = doc.abs_matrix(&id);
    let center = abs.apply(Point::new(n.width / 2.0, n.height / 2.0));
    let rx = pivot.x + (center.x - pivot.x) * c - (center.y - pivot.y) * s;
    let ry = pivot.y + (center.x - pivot.x) * s + (center.y - pivot.y) * c;
    let local_center = doc.parent_matrix(&id).invert().apply(Point::new(rx, ry));
    if let Some(m) = doc.get_mut(&id) {
      m.rotation = normalize_angle(m.rotation + delta);
      m.x = local_center.x - m.width / 2.0;
      m.y = local_center.y - m.height / 2.0;
    }
  }
}

pub fn flip(doc: &mut Document, ids: &[NodeId], horizontal: bool) {
  for id in top_most(doc, ids) {
    if let Some(n) = doc.get_mut(&id) {
      if horizontal {
        n.flip_x = !n.flip_x;
      } else {
        n.flip_y = !n.flip_y;
      }
    }
  }
}

/// Default node for a drawing tool.
pub fn default_node(kind: NodeType, id: String, name: String) -> Node {
  let mut n = Node {
    id,
    kind,
    name,
    ..Default::default()
  };
  match kind {
    NodeType::Frame | NodeType::Component => {
      n.fills = vec![Paint::solid("#FFFFFF")];
      n.clip_content = true;
    }
    NodeType::Rectangle | NodeType::Ellipse | NodeType::Polygon | NodeType::Star => {
      n.fills = vec![Paint::solid("#D9D9D9")];
      if kind != NodeType::Rectangle && kind != NodeType::Ellipse {
        n.shape = Some(ShapeProps {
          point_count: if kind == NodeType::Star { 5 } else { 3 },
          ..Default::default()
        });
      }
    }
    NodeType::Line => {
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_align = crate::model::StrokeAlign::Center;
      n.height = 0.0;
      n.shape = Some(ShapeProps::default());
    }
    NodeType::Vector => {
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_align = crate::model::StrokeAlign::Center;
    }
    NodeType::Text => {
      n.fills = vec![Paint::solid("#000000")];
      n.text = Some(TextProps::default());
    }
    _ => {}
  }
  n
}

/// Deepest frame-like node on a page containing a page-space point. Instances are never
/// containers; main components and sets (with everything inside them) only count when
/// `include_mains` is set; a set itself is never returned, only the variants inside it.
pub fn frame_at(doc: &Document, page: &str, p: Point, exclude: &[NodeId], include_mains: bool) -> Option<NodeId> {
  fn walk(doc: &Document, ids: &[NodeId], p: Point, exclude: &[NodeId], include_mains: bool) -> Option<NodeId> {
    for id in ids.iter().rev() {
      if exclude.contains(id) {
        continue;
      }
      let Some(n) = doc.get(id) else { continue };
      if !n.visible || !n.kind.is_frame_like() || n.kind == NodeType::Instance || doc.instance_ancestor(id).is_some() {
        continue;
      }
      if !include_mains && matches!(n.kind, NodeType::Component | NodeType::ComponentSet) {
        continue;
      }
      let local = doc.abs_matrix(id).invert().apply(p);
      if local.x >= 0.0 && local.y >= 0.0 && local.x <= n.width && local.y <= n.height {
        if let Some(inner) = walk(doc, &n.children, p, exclude, include_mains) {
          return Some(inner);
        }
        // A set only holds variants: its gaps fall through to whatever is behind it.
        if n.kind == NodeType::ComponentSet {
          continue;
        }
        return Some(id.clone());
      }
    }
    None
  }
  let roots = doc.page(page)?.children.clone();
  walk(doc, &roots, p, exclude, include_mains)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::new_document;

  #[test]
  fn frame_at_never_returns_a_component_set() {
    let mut gen = IdGen::new(9);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mk = |id: &str, kind: NodeType, x: f64, y: f64, w: f64, h: f64| Node {
      id: id.into(),
      kind,
      x,
      y,
      width: w,
      height: h,
      ..Default::default()
    };
    doc.insert(mk("bg", NodeType::Frame, 0.0, 0.0, 500.0, 500.0), None, &page, None);
    doc.insert(mk("set", NodeType::ComponentSet, 100.0, 100.0, 200.0, 200.0), None, &page, None);
    doc.insert(mk("v", NodeType::Component, 20.0, 20.0, 100.0, 100.0), Some("set"), &page, None);
    let at = |x: f64, y: f64, mains: bool| frame_at(&doc, &page, Point::new(x, y), &[], mains);
    // Inside a variant: the variant. In the set's gap: what is behind the set, never the set.
    assert_eq!(at(150.0, 150.0, true).as_deref(), Some("v"));
    assert_eq!(at(280.0, 280.0, true).as_deref(), Some("bg"));
    assert_eq!(at(280.0, 280.0, false).as_deref(), Some("bg"));
    // Without mains, variants are skipped too.
    assert_eq!(at(150.0, 150.0, false).as_deref(), Some("bg"));
  }

  #[test]
  fn group_and_ungroup_roundtrip() {
    let mut gen = IdGen::new(9);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    doc.insert(
      Node {
        id: "a".into(),
        x: 10.0,
        y: 10.0,
        width: 20.0,
        height: 20.0,
        ..Default::default()
      },
      None,
      &page,
      None,
    );
    doc.insert(
      Node {
        id: "b".into(),
        x: 50.0,
        y: 40.0,
        width: 20.0,
        height: 20.0,
        ..Default::default()
      },
      None,
      &page,
      None,
    );
    let g = group(&mut doc, &["a".into(), "b".into()], &mut gen).unwrap();
    let gn = doc.get(&g).unwrap();
    assert_eq!((gn.x, gn.y, gn.width, gn.height), (10.0, 10.0, 60.0, 50.0));
    assert_eq!(doc.abs_bounds("b").x, 50.0);
    ungroup(&mut doc, &g);
    assert!(doc.get(&g).is_none());
    assert_eq!(doc.get("b").unwrap().x, 50.0);
    assert_eq!(doc.page(&page).unwrap().children, vec!["a".to_string(), "b".to_string()]);
  }

  #[test]
  fn distribute_three() {
    let mut gen = IdGen::new(9);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    for (id, x) in [("a", 0.0), ("b", 10.0), ("c", 100.0)] {
      doc.insert(
        Node {
          id: id.into(),
          x,
          width: 10.0,
          height: 10.0,
          ..Default::default()
        },
        None,
        &page,
        None,
      );
    }
    distribute(&mut doc, &["a".into(), "b".into(), "c".into()], true);
    assert_eq!(doc.get("b").unwrap().x, 50.0);
  }
}
