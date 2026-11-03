//! Organising moves: scaling subtrees (the Scale tool), tidy up, moving and duplicating pages,
//! and the scans behind "select matching layers" / "select all with the same ...".

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::doc::IdGen;
use crate::geom::{Point, Rect};
use crate::model::{Document, Node, NodeId, NodeType, Page};
use crate::ops;

/// Gap used by tidy up when the selection offers nothing to measure (one layer, or overlaps).
const DEFAULT_TIDY_GAP: f64 = 20.0;

/// Which property "select all with same ..." compares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SameProp {
  Fill,
  Stroke,
  Effect,
  Text,
  Font,
  Instance,
}

impl SameProp {
  pub fn parse(s: &str) -> Option<SameProp> {
    Some(match s {
      "fill" => SameProp::Fill,
      "stroke" => SameProp::Stroke,
      "effect" => SameProp::Effect,
      "text" => SameProp::Text,
      "font" => SameProp::Font,
      "instance" => SameProp::Instance,
      _ => return None,
    })
  }
}

// ---------------------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------------------

/// The layers a scale applies to: top-most, unlocked and not part of an instance (the
/// instance itself can be scaled as a whole).
pub fn scalable(doc: &Document, ids: &[NodeId]) -> Vec<NodeId> {
  ops::top_most(doc, ids)
    .into_iter()
    .filter(|id| doc.get(id).is_some_and(|n| !n.locked) && doc.instance_ancestor(id).is_none())
    .collect()
}

/// Scales layers by `k` around a page-space `anchor`: positions, sizes and everything that
/// has a length (strokes, radii, effects, type, auto layout spacing, grids). Constraints of
/// nested layers are ignored; the whole subtree scales as one. What changes inside an instance
/// is recorded as overrides (so the next edit of the main component keeps it), and bindings and
/// text styles on the scaled properties are let go (or the bound value would win again).
pub fn scale_nodes(doc: &mut Document, ids: &[NodeId], k: f64, anchor: Point) {
  for id in scalable(doc, ids) {
    let Some(n) = doc.get(&id) else { continue };
    let local_center = Point::new(n.x + n.width / 2.0, n.y + n.height / 2.0);
    let pm = doc.parent_matrix(&id);
    let c = pm.apply(local_center);
    let nc = Point::new(anchor.x + (c.x - anchor.x) * k, anchor.y + (c.y - anchor.y) * k);
    let nc = pm.invert().apply(nc);
    let subtree = doc.subtree(&id);
    let before: Vec<Value> = subtree
      .iter()
      .filter_map(|i| doc.get(i))
      .map(|n| serde_json::to_value(n).unwrap_or(Value::Null))
      .collect();
    scale_subtree(doc, &id, k);
    if let Some(n) = doc.get_mut(&id) {
      n.x = tidy(nc.x - n.width / 2.0);
      n.y = tidy(nc.y - n.height / 2.0);
    }
    for (nid, old) in subtree.iter().zip(before) {
      let Some(now) = doc.get(nid).and_then(|n| serde_json::to_value(n).ok()) else {
        continue;
      };
      let Some(patch) = diff(&old, &now) else { continue };
      crate::variables::unbind_for_patch(doc, std::slice::from_ref(nid), &patch);
      let typography = patch.get("text").and_then(|t| t.as_object()).is_some_and(|t| {
        ["fontSize", "lineHeight", "letterSpacing", "paragraphSpacing"]
          .iter()
          .any(|k| t.contains_key(*k))
      });
      if typography {
        if let Some(n) = doc.get_mut(nid) {
          n.text_style = None;
        }
      }
      let in_instance = doc.get(nid).is_some_and(|n| n.kind == NodeType::Instance) || doc.instance_ancestor(nid).is_some();
      if in_instance {
        crate::components::record_override(doc, nid, &patch);
      }
    }
  }
}

/// Merge patch from `a` to `b`: objects recursively, anything else whole. `None` when equal.
fn diff(a: &Value, b: &Value) -> Option<Value> {
  match (a, b) {
    (Value::Object(x), Value::Object(y)) => {
      let mut out = serde_json::Map::new();
      for (k, v) in y {
        match x.get(k) {
          Some(old) => {
            if let Some(d) = diff(old, v) {
              out.insert(k.clone(), d);
            }
          }
          None => {
            out.insert(k.clone(), v.clone());
          }
        }
      }
      (!out.is_empty()).then_some(Value::Object(out))
    }
    _ => (a != b).then(|| b.clone()),
  }
}

/// Scales a layer's own size and lengths and its descendants' positions, sizes and lengths by
/// `k` (the layer's own position is left to the caller). Instance contents scale too.
fn scale_subtree(doc: &mut Document, id: &str, k: f64) {
  let kids = match doc.get(id) {
    Some(n) => n.children.clone(),
    None => return,
  };
  if let Some(n) = doc.get_mut(id) {
    scale_own(n, k);
  }
  for c in kids {
    scale_subtree(doc, &c, k);
    if let Some(n) = doc.get_mut(&c) {
      n.x = tidy(n.x * k);
      n.y = tidy(n.y * k);
    }
  }
}

/// Every length a layer has is scaled here: add new length fields to this list.
fn scale_own(n: &mut Node, k: f64) {
  n.width = tidy(n.width * k).max(if n.kind == NodeType::Line { 0.0 } else { 0.01 });
  n.height = tidy(n.height * k).max(if n.kind == NodeType::Line { 0.0 } else { 0.01 });
  n.stroke_weight = tidy(n.stroke_weight * k);
  n.corner_radius = tidy(n.corner_radius * k);
  if let Some(r) = n.corner_radii.as_mut() {
    r.iter_mut().for_each(|v| *v = tidy(*v * k));
  }
  n.stroke_dash.iter_mut().for_each(|v| *v = tidy(*v * k));
  for e in n.effects.iter_mut() {
    e.x = tidy(e.x * k);
    e.y = tidy(e.y * k);
    e.blur = tidy(e.blur * k);
    e.spread = tidy(e.spread * k);
  }
  for v in [&mut n.min_width, &mut n.max_width, &mut n.min_height, &mut n.max_height] {
    if let Some(x) = v.as_mut() {
      *x = tidy(*x * k);
    }
  }
  if let Some(l) = n.layout.as_mut() {
    for v in [
      &mut l.gap,
      &mut l.counter_gap,
      &mut l.padding_top,
      &mut l.padding_right,
      &mut l.padding_bottom,
      &mut l.padding_left,
    ] {
      *v = tidy(*v * k);
    }
  }
  for g in n.layout_grids.iter_mut() {
    g.gutter = tidy(g.gutter * k);
    g.margin = tidy(g.margin * k);
    g.size = tidy(g.size * k);
  }
  if let Some(t) = n.text.as_mut() {
    t.font_size = tidy(t.font_size * k);
    t.line_height = t.line_height.map(|v| tidy(v * k));
    t.letter_spacing = tidy(t.letter_spacing * k);
    t.paragraph_spacing = tidy(t.paragraph_spacing * k);
    for r in t.runs.iter_mut() {
      r.font_size = r.font_size.map(|v| tidy(v * k));
      r.letter_spacing = r.letter_spacing.map(|v| tidy(v * k));
    }
  }
  if let Some(v) = n.vector.as_mut() {
    for p in v.subpaths.iter_mut().flat_map(|s| s.points.iter_mut()) {
      for c in [&mut p.x, &mut p.y, &mut p.in_x, &mut p.in_y, &mut p.out_x, &mut p.out_y] {
        *c *= k;
      }
    }
  }
}

/// Rounded to 0.01 so scaling doesn't leave float noise in the panel.
fn tidy(v: f64) -> f64 {
  (v * 100.0).round() / 100.0
}

// ---------------------------------------------------------------------------------------
// Tidy up
// ---------------------------------------------------------------------------------------

/// Arranges top-level layers into a grid with equal spacing, keeping their rough row and
/// column order, starting at the selection's top-left. `spacing` overrides the median gap.
pub fn tidy_up(doc: &mut Document, ids: &[NodeId], spacing: Option<f64>) -> Result<(), String> {
  let ids: Vec<NodeId> = ops::top_most(doc, ids)
    .into_iter()
    .filter(|id| doc.get(id).is_some_and(|n| !n.locked))
    .collect();
  if ids.len() < 2 {
    return Err("select at least two layers to tidy up".into());
  }
  if ids.iter().any(|id| in_flow(doc, id)) {
    return Err("tidy up doesn't work inside auto layout".into());
  }
  let origin = doc.bounds_of_many(&ids).ok_or("nothing selected")?;
  let mut items: Vec<(NodeId, Rect)> = ids.iter().map(|i| (i.clone(), doc.abs_bounds(i))).collect();
  items.sort_by(|a, b| a.1.center().y.total_cmp(&b.1.center().y));

  // Rows: a layer joins the current row when its centre lies within the row's vertical range.
  let mut rows: Vec<Vec<(NodeId, Rect)>> = Vec::new();
  let mut range = (0.0, 0.0);
  for it in items {
    let cy = it.1.center().y;
    match rows.last_mut() {
      Some(row) if cy >= range.0 && cy <= range.1 => {
        range = (range.0.min(it.1.y), range.1.max(it.1.bottom()));
        row.push(it);
      }
      _ => {
        range = (it.1.y, it.1.bottom());
        rows.push(vec![it]);
      }
    }
  }
  for row in rows.iter_mut() {
    row.sort_by(|a, b| a.1.x.total_cmp(&b.1.x));
  }

  let row_bounds: Vec<(f64, f64)> = rows
    .iter()
    .map(|r| {
      let top = r.iter().map(|i| i.1.y).fold(f64::MAX, f64::min);
      (top, r.iter().map(|i| i.1.bottom()).fold(f64::MIN, f64::max))
    })
    .collect();
  let mut h_gaps: Vec<f64> = Vec::new();
  for r in &rows {
    h_gaps.extend(r.windows(2).map(|w| (w[1].1.x - w[0].1.right()).max(0.0)));
  }
  let v_gaps: Vec<f64> = row_bounds.windows(2).map(|w| (w[1].0 - w[0].1).max(0.0)).collect();
  // One gap for both axes: the median of every gap between neighbours in the selection.
  let all_gaps: Vec<f64> = h_gaps.iter().chain(v_gaps.iter()).copied().collect();
  let gap = spacing.or_else(|| median(&all_gaps)).unwrap_or(DEFAULT_TIDY_GAP);
  let (gap_h, gap_v) = (gap, gap);

  // Column widths: the widest layer at each index; a single row or column only spaces its axis.
  let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
  let col_w: Vec<f64> = (0..cols)
    .map(|c| rows.iter().filter_map(|r| r.get(c)).map(|i| i.1.width).fold(0.0, f64::max))
    .collect();
  let single_row = rows.len() == 1;
  let single_col = cols == 1;
  let mut y = origin.y;
  for row in &rows {
    let row_h = row.iter().map(|i| i.1.height).fold(0.0, f64::max);
    let mut x = origin.x;
    for (c, (id, b)) in row.iter().enumerate() {
      let nx = if single_col { b.x } else { x };
      let ny = if single_row { b.y } else { y };
      ops::move_abs_to(doc, id, nx.round(), ny.round());
      x += col_w[c] + gap_h;
    }
    y += row_h + gap_v;
  }
  Ok(())
}

fn in_flow(doc: &Document, id: &str) -> bool {
  let Some(n) = doc.get(id) else { return false };
  !n.absolute_position && n.parent.as_ref().and_then(|p| doc.get(p)).is_some_and(|p| p.layout.is_some())
}

/// Median rounded to a whole pixel; `None` for an empty list.
fn median(v: &[f64]) -> Option<f64> {
  if v.is_empty() {
    return None;
  }
  let mut s = v.to_vec();
  s.sort_by(f64::total_cmp);
  let m = if s.len() % 2 == 1 {
    s[s.len() / 2]
  } else {
    (s[s.len() / 2 - 1] + s[s.len() / 2]) / 2.0
  };
  Some(m.round())
}

// ---------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------

/// Moves a page to `index` in the pages list.
pub fn move_page(doc: &mut Document, id: &str, index: usize) -> Result<(), String> {
  let from = doc.pages.iter().position(|p| p.id == id).ok_or("no such page")?;
  let page = doc.pages.remove(from);
  doc.pages.insert(index.min(doc.pages.len()), page);
  Ok(())
}

/// Copies a page and every layer on it (fresh ids), named "<name> copy", right after it.
/// Prototype links and the flow start between layers of the page point at the copies, and
/// instances of a main component on the page use the copy of that main. Returns the new page id.
pub fn duplicate_page(doc: &mut Document, gen: &mut IdGen, id: &str) -> Result<String, String> {
  let at = doc.pages.iter().position(|p| p.id == id).ok_or("no such page")?;
  let src = doc.pages[at].clone();
  let new_id = gen.next("p_");
  let mut map: HashMap<NodeId, NodeId> = HashMap::new();
  let mut copies: Vec<Node> = Vec::new();
  let mut roots: Vec<NodeId> = Vec::new();
  for root in &src.children {
    let (nodes, m) = doc.clone_subtree(root, gen);
    roots.push(m[root].clone());
    map.extend(m);
    copies.extend(nodes);
  }
  let remap = |s: &mut String| {
    if let Some(n) = map.get(s.as_str()) {
      *s = n.clone();
    }
  };
  for c in copies.iter_mut() {
    c.page = new_id.clone();
    c.master_id = c.master_id.clone().map(|mut m| {
      remap(&mut m);
      m
    });
    for i in c.interactions.iter_mut() {
      if let Some(d) = i.destination.as_mut() {
        remap(d);
      }
    }
    if let Some(info) = c.instance.as_mut() {
      remap(&mut info.component_id);
      info.overrides = std::mem::take(&mut info.overrides)
        .into_iter()
        .map(|(mut k, v)| {
          remap(&mut k);
          (k, v)
        })
        .collect();
    }
    if let Some(comp) = c.component.as_mut() {
      for p in comp.props.iter_mut() {
        p.options.iter_mut().for_each(remap);
        if let Value::String(s) = &mut p.default {
          remap(s);
        }
      }
    }
  }
  for c in copies {
    doc.nodes.insert(c.id.clone(), c);
  }
  let mut flow_start = src.flow_start.clone();
  if let Some(f) = flow_start.as_mut() {
    remap(f);
  }
  doc.pages.insert(
    at + 1,
    Page {
      id: new_id.clone(),
      name: format!("{} copy", src.name),
      children: roots,
      background: src.background,
      flow_start,
      guides: src.guides,
    },
  );
  Ok(new_id)
}

/// Moves layers to the top level of another page, keeping their x/y. Comments pinned to them
/// and the flow start follow or clear. Returns the moved ids (in paint order).
pub fn move_to_page(doc: &mut Document, ids: &[NodeId], page: &str) -> Result<Vec<NodeId>, String> {
  if doc.page(page).is_none() {
    return Err("no such page".into());
  }
  let ids: Vec<NodeId> = ops::paint_order(doc, &ops::top_most(doc, ids))
    .into_iter()
    .filter(|id| doc.instance_ancestor(id).is_none())
    .collect();
  let mut moved = Vec::new();
  for id in ids {
    let Some(n) = doc.get(&id) else { continue };
    let from = n.page.clone();
    if from == page && n.parent.is_none() {
      moved.push(id);
      continue;
    }
    // Top level on its own page first (keeps its page position), then across.
    doc.reparent(&id, None, None, true);
    doc.detach(&id);
    for nid in doc.subtree(&id) {
      if let Some(n) = doc.get_mut(&nid) {
        n.page = page.to_string();
      }
    }
    if let Some(p) = doc.page_mut(page) {
      p.children.push(id.clone());
    }
    if let Some(p) = doc.page_mut(&from) {
      if p.flow_start.as_deref() == Some(id.as_str()) {
        p.flow_start = None;
      }
    }
    let sub: HashSet<NodeId> = doc.subtree(&id).into_iter().collect();
    for c in doc.comments.values_mut() {
      if c.node.as_ref().is_some_and(|n| sub.contains(n)) {
        c.page = page.to_string();
      }
    }
    moved.push(id);
  }
  Ok(moved)
}

// ---------------------------------------------------------------------------------------
// Selection scans
// ---------------------------------------------------------------------------------------

/// Layers identical to the given ones in the other top-level frames or groups of the page:
/// same name path below their top-level layer, same type. The given layers come first.
pub fn matching_layers(doc: &Document, ids: &[NodeId]) -> Vec<NodeId> {
  let mut out: Vec<NodeId> = ids.iter().filter(|i| doc.get(i).is_some()).cloned().collect();
  let mut seen: HashSet<NodeId> = out.iter().cloned().collect();
  let mut wanted: HashMap<(Vec<String>, NodeType), HashSet<NodeId>> = HashMap::new();
  for id in ids {
    let Some(n) = doc.get(id) else { continue };
    let path = name_path(doc, id);
    if path.is_empty() {
      continue;
    }
    wanted.entry((path, n.kind)).or_default().insert(doc.top_level_of(id));
  }
  if wanted.is_empty() {
    return out;
  }
  let Some(page) = ids.iter().find_map(|i| doc.get(i)).map(|n| n.page.clone()) else {
    return out;
  };
  for root in doc.page(&page).map(|p| p.children.clone()).unwrap_or_default() {
    let mut stack: Vec<(NodeId, Vec<String>)> = doc
      .get(&root)
      .map(|r| r.children.iter().rev().map(|c| (c.clone(), Vec::new())).collect())
      .unwrap_or_default();
    while let Some((id, mut path)) = stack.pop() {
      let Some(n) = doc.get(&id) else { continue };
      path.push(n.name.clone());
      if let Some(tops) = wanted.get(&(path.clone(), n.kind)) {
        if !tops.contains(&root) && seen.insert(id.clone()) {
          out.push(id.clone());
        }
      }
      for c in n.children.iter().rev() {
        stack.push((c.clone(), path.clone()));
      }
    }
  }
  out
}

/// Names from just below the top-level ancestor down to the layer (empty for a top-level layer).
fn name_path(doc: &Document, id: &str) -> Vec<String> {
  let path = doc.path(id);
  path.iter().skip(1).filter_map(|p| doc.get(p)).map(|n| n.name.clone()).collect()
}

/// Layers on the page of `id` whose `prop` equals that of `id` (visible, unlocked ones only).
/// A layer without the property matches only itself.
pub fn same_property(doc: &Document, id: &str, prop: SameProp) -> Vec<NodeId> {
  let Some(n) = doc.get(id) else { return vec![] };
  if !has_prop(n, prop) {
    return vec![id.to_string()];
  }
  doc
    .page_nodes(&n.page)
    .into_iter()
    .filter(|o| {
      o == id
        || doc
          .get(o)
          .is_some_and(|m| m.visible && !m.locked && has_prop(m, prop) && same(n, m, prop))
    })
    .collect()
}

fn has_prop(n: &Node, prop: SameProp) -> bool {
  match prop {
    SameProp::Fill => !n.fills.is_empty(),
    SameProp::Stroke => !n.strokes.is_empty(),
    SameProp::Effect => !n.effects.is_empty(),
    SameProp::Text | SameProp::Font => n.text.is_some(),
    SameProp::Instance => n.instance.is_some(),
  }
}

/// Whether two layers (both with the property) agree on it.
fn same(a: &Node, b: &Node, prop: SameProp) -> bool {
  match (prop, a.text.as_ref(), b.text.as_ref()) {
    (SameProp::Fill, ..) => a.fills == b.fills,
    (SameProp::Stroke, ..) => a.strokes == b.strokes,
    (SameProp::Effect, ..) => a.effects == b.effects,
    (SameProp::Font, Some(x), Some(y)) => x.font_family == y.font_family,
    (SameProp::Text, Some(x), Some(y)) => {
      x.font_family == y.font_family
        && x.font_size == y.font_size
        && x.font_weight == y.font_weight
        && x.italic == y.italic
        && x.line_height == y.line_height
        && x.letter_spacing == y.letter_spacing
        && x.paragraph_spacing == y.paragraph_spacing
        && x.align_h == y.align_h
        && x.decoration == y.decoration
        && x.case == y.case
    }
    (SameProp::Instance, ..) => a.instance.as_ref().map(|i| &i.component_id) == b.instance.as_ref().map(|i| &i.component_id),
    _ => false,
  }
}

/// Instances of a main component (or of the component an instance uses; a component set counts
/// its variants) on the current page, or on every page.
pub fn instances_of(doc: &Document, id: &str, page: &str, all_pages: bool) -> Vec<NodeId> {
  let Some(n) = doc.get(id) else { return vec![] };
  let mains: HashSet<NodeId> = match n.kind {
    NodeType::Instance => n.instance.iter().map(|i| i.component_id.clone()).collect(),
    NodeType::ComponentSet => n.children.iter().cloned().collect(),
    _ => HashSet::from([id.to_string()]),
  };
  let mut out = Vec::new();
  for p in doc.pages.iter().filter(|p| all_pages || p.id == page) {
    out.extend(doc.page_nodes(&p.id).into_iter().filter(|i| {
      doc
        .get(i)
        .and_then(|m| m.instance.as_ref())
        .is_some_and(|inf| mains.contains(&inf.component_id))
    }));
  }
  out
}
