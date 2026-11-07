//! Structural document operations shared by commands and AI tools.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::doc::{normalize_angle, IdGen};
use crate::geom::{Point, Rect};
use crate::model::{Document, Node, NodeId, NodeType, Paint, ShapeProps, TextProps};

thread_local! {
  /// Test oracle (see `Engine::reference`): `top_most` and `paint_order` take the quadratic road.
  static REFERENCE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Switches `top_most` / `paint_order` between the fast versions and the whole-document walks they
/// replace, for this thread. The engine sets it from `Engine::reference` on every entry point.
pub(crate) fn set_reference(on: bool) {
  REFERENCE.with(|r| r.set(on));
}

fn reference() -> bool {
  REFERENCE.with(|r| r.get())
}

/// Drops ids whose ancestor is also in the list (so subtrees are handled once).
pub fn top_most(doc: &Document, ids: &[NodeId]) -> Vec<NodeId> {
  if reference() {
    return top_most_slow(doc, ids);
  }
  let set: HashSet<&str> = ids.iter().map(|i| i.as_str()).collect();
  ids
    .iter()
    .filter(|id| doc.nodes.contains_key(*id))
    .filter(|id| !doc.ancestors(id).iter().any(|a| set.contains(a.as_str())))
    .cloned()
    .collect()
}

/// `top_most` as it was: `contains` on the list for every ancestor of every id.
pub(crate) fn top_most_slow(doc: &Document, ids: &[NodeId]) -> Vec<NodeId> {
  ids
    .iter()
    .filter(|id| doc.nodes.contains_key(*id))
    .filter(|id| !doc.ancestors(id).iter().any(|a| ids.contains(a)))
    .cloned()
    .collect()
}

/// Sorts ids into paint order (bottom first) within the document. Ids that aren't in the document,
/// or that no page reaches through its layers' children, are dropped, and so are repeats.
///
/// Each id gets its path (page, index of its top-level layer, then its index in each parent on the
/// way down) and the paths sort in pre-order. That costs the ids' depth plus the children lists of
/// the parents they sit in, where walking every layer of every page for every id did not.
pub fn paint_order(doc: &Document, ids: &[NodeId]) -> Vec<NodeId> {
  if reference() {
    return paint_order_slow(doc, ids);
  }
  // Top-level layer → (page, index) for the layers the pages list.
  let mut roots: HashMap<&str, (usize, usize)> = HashMap::new();
  for (pi, p) in doc.pages.iter().enumerate() {
    for (ri, r) in p.children.iter().enumerate() {
      roots.entry(r.as_str()).or_insert((pi, ri));
    }
  }
  // Parent → child → index, built for the parents met.
  let mut index_in: HashMap<&str, HashMap<&str, usize>> = HashMap::new();
  let mut seen: HashSet<&str> = HashSet::new();
  let mut keyed: Vec<(Vec<usize>, &NodeId)> = Vec::new();
  'ids: for id in ids {
    if !seen.insert(id.as_str()) {
      continue;
    }
    // Up from the layer; a path longer than the document has layers is a cycle.
    let mut path: Vec<usize> = Vec::new();
    let mut cur: &str = id.as_str();
    loop {
      let Some(n) = doc.get(cur) else { continue 'ids };
      match n.parent.as_deref() {
        Some(p) => {
          let Some(pn) = doc.get(p) else { continue 'ids };
          let at = index_in.entry(p).or_insert_with(|| {
            let mut m: HashMap<&str, usize> = HashMap::with_capacity(pn.children.len());
            for (i, c) in pn.children.iter().enumerate() {
              m.entry(c.as_str()).or_insert(i);
            }
            m
          });
          let Some(i) = at.get(cur) else { continue 'ids };
          path.push(*i);
          if path.len() > doc.nodes.len() {
            continue 'ids;
          }
          cur = p;
        }
        None => {
          let Some((pi, ri)) = roots.get(cur) else { continue 'ids };
          path.push(*ri);
          path.push(*pi);
          break;
        }
      }
    }
    path.reverse();
    keyed.push((path, id));
  }
  keyed.sort();
  keyed.into_iter().map(|(_, id)| id.clone()).collect()
}

/// `paint_order` as it was: every layer of every page, in order, kept when it is in the list.
pub(crate) fn paint_order_slow(doc: &Document, ids: &[NodeId]) -> Vec<NodeId> {
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

// ---- edits that change neither layout nor pixels (round 18) ----
//
// The engine skips re-laying out and re-rendering the layer tree such an edit sits in. Each helper
// copies the fields it lists from the new layer onto a copy of the old one and asks whether the two
// are then equal, so a field added to `Node` later is never on the list: a change to it is never
// neutral, the safe default. Tests change every listed field and compare layout and render output.

/// Copies the named fields of `$from` onto `$to`, the ones that differ (cloning is the cost).
macro_rules! adopt {
  ($to:ident, $from:ident, $($f:ident),* $(,)?) => {
    $(
      if $to.$f != $from.$f {
        $to.$f = $from.$f.clone();
      }
    )*
  };
}

/// True when `new` differs from `old` only in fields `layout::layout_node` never reads: paints,
/// effects, opacity, blend mode, the name, variable bindings and pins, style links, prototype
/// interactions, export rows, notes, layout grids, the lock, and the
/// instance record (an instance's overrides reach its layers through the sync, which changes those
/// layers themselves). (`stroke_weight` and `visible` are left out on purpose.)
pub fn layout_neutral(old: &Node, new: &Node) -> bool {
  // Cheap rejects first: this runs for every changed layer of a big edit.
  if old.x != new.x
    || old.y != new.y
    || old.width != new.width
    || old.height != new.height
    || old.visible != new.visible
    || old.parent != new.parent
    || old.children.len() != new.children.len()
  {
    return false;
  }
  let mut a = old.clone();
  adopt!(
    a,
    new,
    fills,
    strokes,
    effects,
    opacity,
    blend_mode,
    name,
    bindings,
    variable_modes,
    fill_style,
    stroke_style,
    effect_style,
    grid_style,
    text_style,
    interactions,
    export_settings,
    notes,
    layout_grids,
    locked,
    instance
  );
  // (Not the colour or link of a text run: a run splits the measured pieces, and a real font's
  // widths aren't additive, so the same words can measure differently.)
  a == *new
}

/// True when `new` differs from `old` only in fields `render` never reads: variable bindings and
/// pins, the style links (the paints they stand for are fields of their own), export rows, notes and
/// the instance record (what an instance shows is in its own layers).
pub fn render_neutral(old: &Node, new: &Node) -> bool {
  let mut a = old.clone();
  adopt!(
    a,
    new,
    bindings,
    variable_modes,
    fill_style,
    stroke_style,
    effect_style,
    grid_style,
    text_style,
    export_settings,
    notes,
    instance
  );
  a == *new
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
      Arc::make_mut(p).flow_start = None;
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
        doc.nodes.insert(n.id.clone(), Arc::new(n));
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
      // System UI of a device frame is never a drop target: layers go into the device frame.
      if !n.visible
        || !n.kind.is_frame_like()
        || n.kind == NodeType::Instance
        || n.device_part.is_some()
        || doc.instance_ancestor(id).is_some()
      {
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

  /// A random forest over a few pages (some layers missing from their parent's list, which no page
  /// walk reaches): `paint_order` and `top_most` give what the old whole-document walks gave, for
  /// id lists with repeats, ancestors next to descendants and ids that aren't there.
  #[test]
  fn paint_order_and_top_most_match_the_old_functions() {
    struct Lcg(u64);
    impl Lcg {
      fn below(&mut self, n: usize) -> usize {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) % n.max(1) as u64) as usize
      }
    }
    for seed in 1..=60u64 {
      let mut r = Lcg(seed);
      let mut gen = IdGen::new(seed);
      let mut doc = new_document(&mut gen, "t");
      for i in 0..r.below(3) {
        doc.pages.push(Arc::new(crate::model::Page {
          id: format!("page{i}"),
          name: format!("Page {i}"),
          children: Vec::new(),
          background: "#FFFFFF".into(),
          flow_start: None,
          guides: Vec::new(),
        }));
      }
      let mut ids: Vec<String> = Vec::new();
      for i in 0..(5 + r.below(70)) {
        let id = format!("n{i}");
        let parent = if ids.is_empty() || r.below(4) == 0 {
          None
        } else {
          Some(ids[r.below(ids.len())].clone())
        };
        let page = match &parent {
          Some(p) => doc.get(p).unwrap().page.clone(),
          None => doc.pages[r.below(doc.pages.len())].id.clone(),
        };
        let index = (r.below(3) > 0).then(|| r.below(5));
        doc.insert(
          Node {
            id: id.clone(),
            kind: NodeType::Frame,
            ..Default::default()
          },
          parent.as_deref(),
          &page,
          index,
        );
        ids.push(id);
      }
      // A layer its parent no longer lists (a damaged file): neither walk reaches it.
      if ids.len() > 4 {
        let orphan = ids[3].clone();
        doc.detach(&orphan);
      }
      for _ in 0..30 {
        let mut want: Vec<String> = (0..r.below(25)).map(|_| ids[r.below(ids.len())].clone()).collect();
        for _ in 0..r.below(3) {
          want.push(format!("gone{}", r.below(9)));
        }
        assert_eq!(
          paint_order(&doc, &want),
          paint_order_slow(&doc, &want),
          "seed {seed}: paint_order of {want:?}"
        );
        assert_eq!(
          top_most(&doc, &want),
          top_most_slow(&doc, &want),
          "seed {seed}: top_most of {want:?}"
        );
        let tops = top_most(&doc, &want);
        assert_eq!(paint_order(&doc, &tops), paint_order_slow(&doc, &tops));
      }
    }
  }

  /// A measurer that kerns "AV" like a real font does (the browser's `measureText` isn't additive).
  struct Kern;
  impl crate::text::TextMeasurer for Kern {
    fn measure(&self, text: &str, font: &crate::text::FontSpec) -> f64 {
      let n = text.chars().count() as f64;
      n * font.size * 0.6 - text.matches("AV").count() as f64 * font.size * 0.2 + n * font.letter_spacing
    }
  }

  /// A laid-out screen with every kind of layer the neutral lists talk about.
  fn neutral_doc() -> Document {
    use crate::model::{AutoLayout, Sizing, TextProps, TextRun};
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mk = |id: &str, kind: NodeType, w: f64, h: f64| Node {
      id: id.into(),
      kind,
      width: w,
      height: h,
      fills: vec![Paint::solid("#336699")],
      ..Default::default()
    };
    let mut screen = mk("screen", NodeType::Frame, 300.0, 100.0);
    screen.layout = Some(AutoLayout::default());
    screen.sizing_v = Sizing::Hug;
    doc.insert(screen, None, &page, None);
    let mut text = mk("text", NodeType::Text, 100.0, 20.0);
    text.text = Some(TextProps {
      characters: "AVAVAVAV neutral world".into(),
      auto_resize: crate::model::TextAutoResize::Width,
      runs: vec![TextRun {
        start: 1,
        end: 2,
        color: Some("#FF0000".into()),
        ..Default::default()
      }],
      ..Default::default()
    });
    doc.insert(text, Some("screen"), &page, None);
    doc.insert(mk("rect", NodeType::Rectangle, 80.0, 40.0), Some("screen"), &page, None);
    let mut inner = mk("inner", NodeType::Frame, 120.0, 30.0);
    inner.layout = Some(AutoLayout::default());
    inner.sizing_v = Sizing::Hug;
    doc.insert(inner, Some("screen"), &page, None);
    let mut label = mk("label", NodeType::Text, 50.0, 20.0);
    label.text = Some(TextProps {
      characters: "Inner".into(),
      ..Default::default()
    });
    doc.insert(label, Some("inner"), &page, None);
    crate::layout::relayout_all(&mut doc, &Kern);
    doc
  }

  /// A run's colour splits the measured pieces, and a kerning font measures the pair differently:
  /// dropping it merges them and moves the layout, so it is not a neutral change.
  #[test]
  fn a_run_colour_can_change_the_width_of_a_text() {
    let base = neutral_doc();
    let mut after = base.clone();
    after.get_mut("text").unwrap().text.as_mut().unwrap().runs[0].color = None;
    let mut laid = after.clone();
    crate::layout::layout_node(&mut laid, "screen", &Kern);
    assert!(laid != after, "the run colour moved the layout");
    assert!(!layout_neutral(base.get("text").unwrap(), after.get("text").unwrap()));
  }

  /// Each field the neutral helpers list, changed on its own: the helper says neutral, and layout
  /// (for `layout_neutral`) or the canvas markup (for `render_neutral`) really doesn't change.
  /// Fields not on a list (size, position, visibility, the children, a text's characters) aren't neutral.
  #[test]
  fn the_neutral_lists_name_only_fields_layout_and_render_never_read() {
    use crate::model::{BlendMode, Effect, ExportSetting, Interaction, LayoutGrid};
    let base = neutral_doc();
    let m = Kern;
    type Change = Box<dyn Fn(&mut Node)>;
    let changes: Vec<(&str, bool, Change)> = vec![
      // (name, also render-neutral, change)
      ("fills", false, Box::new(|n| n.fills = vec![Paint::solid("#00FF00")])),
      ("strokes", false, Box::new(|n| n.strokes = vec![Paint::solid("#00FF00")])),
      ("effects", false, Box::new(|n| n.effects = vec![Effect::default()])),
      ("opacity", false, Box::new(|n| n.opacity = 0.5)),
      ("blend_mode", false, Box::new(|n| n.blend_mode = BlendMode::Multiply)),
      ("name", false, Box::new(|n| n.name = "Renamed".into())),
      (
        "bindings",
        true,
        Box::new(|n| n.bindings.insert("fill".into(), "v1".into()).map(|_| ()).unwrap_or(())),
      ),
      (
        "variable_modes",
        true,
        Box::new(|n| n.variable_modes.insert("c1".into(), "m1".into()).map(|_| ()).unwrap_or(())),
      ),
      ("fill_style", true, Box::new(|n| n.fill_style = Some("s1".into()))),
      ("stroke_style", true, Box::new(|n| n.stroke_style = Some("s1".into()))),
      ("effect_style", true, Box::new(|n| n.effect_style = Some("s1".into()))),
      ("grid_style", true, Box::new(|n| n.grid_style = Some("s1".into()))),
      ("text_style", true, Box::new(|n| n.text_style = Some("s1".into()))),
      ("interactions", false, Box::new(|n| n.interactions = vec![Interaction::default()])),
      (
        "export_settings",
        true,
        Box::new(|n| n.export_settings = vec![ExportSetting::default()]),
      ),
      ("notes", true, Box::new(|n| n.notes = "a note".into())),
      (
        "instance",
        true,
        Box::new(|n| {
          n.instance = Some(crate::model::InstanceInfo {
            component_id: "elsewhere".into(),
            overrides: [("x".to_string(), serde_json::json!({ "bindings": { "fill": "v" } }))]
              .into_iter()
              .collect(),
            ..Default::default()
          })
        }),
      ),
      ("layout_grids", false, Box::new(|n| n.layout_grids = vec![LayoutGrid::default()])),
      ("locked", false, Box::new(|n| n.locked = true)),
    ];
    for (name, render_too, change) in &changes {
      for id in ["screen", "text", "rect", "inner", "label"] {
        let old = base.get(id).unwrap();
        let mut new = old.clone();
        change(&mut new);
        if new == *old {
          // (A change that doesn't apply to this kind of layer, such as a text run's colour on a rectangle.)
          continue;
        }
        assert!(layout_neutral(old, &new), "{name} on {id} should be layout-neutral");
        let mut after = base.clone();
        after.nodes.insert(id.to_string(), Arc::new(new.clone()));
        let mut laid = after.clone();
        crate::layout::layout_node(&mut laid, "screen", &m);
        assert!(laid == after, "{name} on {id}: layout moved something");
        if *render_too {
          assert!(render_neutral(old, &new), "{name} on {id} should be render-neutral");
          let (a, b) = (
            crate::render::render_root(
              &base,
              "screen",
              &m,
              crate::render::RenderOptions {
                mode: crate::render::Mode::Canvas,
                hidden: &[],
                editing: None,
              },
            ),
            crate::render::render_root(
              &after,
              "screen",
              &m,
              crate::render::RenderOptions {
                mode: crate::render::Mode::Canvas,
                hidden: &[],
                editing: None,
              },
            ),
          );
          assert_eq!(a, b, "{name} on {id}: the canvas changed");
        } else {
          assert!(!render_neutral(old, &new), "{name} is not on the render list");
        }
      }
    }
    // Fields layout reads (or that were left out to be safe) are never neutral.
    let not_neutral: Vec<(&str, Change)> = vec![
      ("width", Box::new(|n| n.width += 1.0)),
      ("x", Box::new(|n| n.x += 1.0)),
      ("visible", Box::new(|n| n.visible = false)),
      ("stroke_weight", Box::new(|n| n.stroke_weight = 4.0)),
      ("corner_radius", Box::new(|n| n.corner_radius = 4.0)),
      ("children", Box::new(|n| n.children.push("x".into()))),
      (
        "characters",
        Box::new(|n| {
          if let Some(t) = n.text.as_mut() {
            t.characters.push('!')
          }
        }),
      ),
      (
        "run color",
        Box::new(|n| {
          if let Some(r) = n.text.as_mut().and_then(|t| t.runs.first_mut()) {
            r.color = Some("#0000FF".into());
          }
        }),
      ),
      (
        "run link",
        Box::new(|n| {
          if let Some(r) = n.text.as_mut().and_then(|t| t.runs.first_mut()) {
            r.link = Some("https://example.com".into());
          }
        }),
      ),
      (
        "run size",
        Box::new(|n| {
          if let Some(r) = n.text.as_mut().and_then(|t| t.runs.first_mut()) {
            r.font_size = Some(30.0)
          }
        }),
      ),
      (
        "layout",
        Box::new(|n| {
          if let Some(l) = n.layout.as_mut() {
            l.gap += 4.0
          }
        }),
      ),
    ];
    for (name, change) in &not_neutral {
      let old = base.get("text").unwrap();
      let mut new = old.clone();
      change(&mut new);
      if new != *old {
        assert!(!layout_neutral(old, &new), "{name} must not be layout-neutral");
      }
      let old = base.get("screen").unwrap();
      let mut new = old.clone();
      change(&mut new);
      if new != *old {
        assert!(!layout_neutral(old, &new), "{name} must not be layout-neutral");
      }
    }
  }
}
