//! Tree navigation and structural edits on a [`Document`].

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use imbl::ordmap::DiffItem;

use crate::geom::{local_matrix, Mat, Point, Rect};
use crate::model::{Document, Node, NodeId, NodeType, Page, Styles, SCHEMA_VERSION};

/// Deterministic, collision-resistant id generator (xorshift seeded per session).
#[derive(Clone, Debug)]
pub struct IdGen {
  state: u64,
}

impl IdGen {
  pub fn new(seed: u64) -> Self {
    IdGen { state: seed | 1 }
  }

  pub fn next(&mut self, prefix: &str) -> String {
    let mut x = self.state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    self.state = x;
    format!("{prefix}{}", base36(x & 0xFFFF_FFFF_FFFF))
  }
}

fn base36(mut v: u64) -> String {
  const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
  if v == 0 {
    return "0".into();
  }
  let mut out = Vec::new();
  while v > 0 {
    out.push(DIGITS[(v % 36) as usize]);
    v /= 36;
  }
  out.reverse();
  String::from_utf8(out).unwrap_or_default()
}

pub fn new_document(ids: &mut IdGen, name: &str) -> Document {
  let page = Page {
    id: ids.next("p_"),
    name: "Page 1".into(),
    children: Vec::new(),
    background: "#F5F5F5".into(),
    flow_start: None,
    guides: Vec::new(),
  };
  Document {
    id: ids.next("d_"),
    name: name.into(),
    schema: SCHEMA_VERSION,
    pages: vec![page],
    nodes: imbl::OrdMap::new(),
    styles: Styles::default(),
    variables: Vec::new(),
    comments: Default::default(),
    names: Default::default(),
  }
}

/// How many layers each `next_name` base matches, kept in step with `Document::nodes` by
/// diffing against the map it last saw, so a name costs what changed since the last one
/// instead of a scan of the whole document. Derived data: it is never saved, compared or
/// merged, and a clone carries a copy (which shares storage).
#[derive(Default, Debug)]
pub struct NameCache(Mutex<NameIndex>);

#[derive(Default, Clone, Debug)]
struct NameIndex {
  seen: imbl::OrdMap<NodeId, Node>,
  /// Layers whose name starts with the base, for every base asked about so far.
  counts: HashMap<String, usize>,
}

impl Clone for NameCache {
  fn clone(&self) -> Self {
    NameCache(Mutex::new(self.lock().clone()))
  }
}

impl PartialEq for NameCache {
  fn eq(&self, _: &Self) -> bool {
    true
  }
}

impl NameCache {
  fn lock(&self) -> MutexGuard<'_, NameIndex> {
    self.0.lock().unwrap_or_else(|e| e.into_inner())
  }
}

impl NameIndex {
  fn sync(&mut self, nodes: &imbl::OrdMap<NodeId, Node>) {
    if self.seen.ptr_eq(nodes) {
      return;
    }
    let counts = &mut self.counts;
    for item in self.seen.diff(nodes) {
      match item {
        DiffItem::Add(_, n) => counts
          .iter_mut()
          .filter(|(b, _)| n.name.starts_with(b.as_str()))
          .for_each(|(_, c)| *c += 1),
        DiffItem::Remove(_, n) => counts
          .iter_mut()
          .filter(|(b, _)| n.name.starts_with(b.as_str()))
          .for_each(|(_, c)| *c -= 1),
        DiffItem::Update { old: (_, o), new: (_, n) } if o.name != n.name => {
          for (b, c) in counts.iter_mut() {
            *c = *c + usize::from(n.name.starts_with(b.as_str())) - usize::from(o.name.starts_with(b.as_str()));
          }
        }
        DiffItem::Update { .. } => {}
      }
    }
    self.seen = nodes.clone();
  }
}

impl Document {
  /// Mutates the nodes `pred` selects; others keep their shared storage.
  pub fn update_where(&mut self, pred: impl Fn(&Node) -> bool, mut f: impl FnMut(&mut Node)) {
    let ids: Vec<NodeId> = self.nodes.values().filter(|n| pred(n)).map(|n| n.id.clone()).collect();
    for id in ids {
      if let Some(n) = self.nodes.get_mut(&id) {
        f(n);
      }
    }
  }

  pub fn get(&self, id: &str) -> Option<&Node> {
    self.nodes.get(id)
  }

  pub fn get_mut(&mut self, id: &str) -> Option<&mut Node> {
    self.nodes.get_mut(id)
  }

  pub fn page(&self, id: &str) -> Option<&Page> {
    self.pages.iter().find(|p| p.id == id)
  }

  pub fn page_mut(&mut self, id: &str) -> Option<&mut Page> {
    self.pages.iter_mut().find(|p| p.id == id)
  }

  /// Ordered child list (bottom to top) of a parent, or of a page root.
  pub fn child_ids(&self, parent: Option<&str>, page: &str) -> Vec<NodeId> {
    match parent {
      Some(p) => self.get(p).map(|n| n.children.clone()).unwrap_or_default(),
      None => self.page(page).map(|p| p.children.clone()).unwrap_or_default(),
    }
  }

  fn child_list_mut(&mut self, parent: Option<&str>, page: &str) -> Option<&mut Vec<NodeId>> {
    match parent {
      Some(p) => self.nodes.get_mut(p).map(|n| &mut n.children),
      None => self.page_mut(page).map(|p| &mut p.children),
    }
  }

  pub fn siblings_of(&self, id: &str) -> Vec<NodeId> {
    match self.get(id) {
      Some(n) => self.child_ids(n.parent.as_deref(), &n.page),
      None => Vec::new(),
    }
  }

  pub fn index_in_parent(&self, id: &str) -> Option<usize> {
    self.siblings_of(id).iter().position(|c| c == id)
  }

  /// Ancestor ids, nearest first. Stops at a parent cycle (a damaged or hostile document)
  /// instead of looping forever.
  pub fn ancestors(&self, id: &str) -> Vec<NodeId> {
    let mut out: Vec<NodeId> = Vec::new();
    let mut cur = self.get(id).and_then(|n| n.parent.clone());
    while let Some(p) = cur {
      if p == id || out.contains(&p) {
        break;
      }
      cur = self.get(&p).and_then(|n| n.parent.clone());
      out.push(p);
    }
    out
  }

  /// Makes every node in `ids` that is its own ancestor top-level, and keeps only children
  /// that point back at their parent, so walking the tree (either way) always ends.
  pub fn break_parent_cycles<'a>(&mut self, ids: impl IntoIterator<Item = &'a NodeId>) {
    let ids: Vec<&NodeId> = ids.into_iter().collect();
    for id in &ids {
      let mut seen: Vec<NodeId> = Vec::new();
      let mut cur = self.get(id).and_then(|n| n.parent.clone());
      while let Some(p) = cur {
        if p == **id {
          self.get_mut(id).unwrap().parent = None;
          break;
        }
        // A cycle further up that doesn't include this node: its own members break it.
        if seen.contains(&p) {
          break;
        }
        cur = self.get(&p).and_then(|n| n.parent.clone());
        seen.push(p);
      }
    }
    for id in ids {
      let Some(n) = self.get(id) else { continue };
      let kids: Vec<NodeId> = n
        .children
        .iter()
        .filter(|c| self.get(c).map(|cn| cn.parent.as_deref() == Some(id.as_str())).unwrap_or(false))
        .cloned()
        .collect();
      if kids != n.children {
        self.get_mut(id).unwrap().children = kids;
      }
    }
  }

  /// Path from the page root down to (and including) `id`.
  pub fn path(&self, id: &str) -> Vec<NodeId> {
    let mut p = self.ancestors(id);
    p.reverse();
    p.push(id.to_string());
    p
  }

  pub fn is_ancestor(&self, ancestor: &str, id: &str) -> bool {
    self.ancestors(id).iter().any(|a| a == ancestor)
  }

  /// Pre-order list of `id` and all its descendants.
  pub fn subtree(&self, id: &str) -> Vec<NodeId> {
    let mut out = Vec::new();
    let mut stack = vec![id.to_string()];
    while let Some(cur) = stack.pop() {
      if let Some(n) = self.get(&cur) {
        for c in n.children.iter().rev() {
          stack.push(c.clone());
        }
        out.push(cur);
      }
    }
    out
  }

  /// Nearest instance ancestor (or the node itself if it is an instance child root).
  pub fn instance_ancestor(&self, id: &str) -> Option<NodeId> {
    self
      .ancestors(id)
      .into_iter()
      .find(|a| self.get(a).map(|n| n.kind == NodeType::Instance).unwrap_or(false))
  }

  pub fn local_matrix(&self, n: &Node) -> Mat {
    local_matrix(n.x, n.y, n.width, n.height, n.rotation, n.flip_x, n.flip_y)
  }

  /// Page-space transform of a node.
  pub fn abs_matrix(&self, id: &str) -> Mat {
    let mut m = Mat::IDENTITY;
    for nid in self.path(id) {
      if let Some(n) = self.get(&nid) {
        m = m.mul(&self.local_matrix(n));
      }
    }
    m
  }

  /// Page-space transform of a node's parent coordinate system.
  pub fn parent_matrix(&self, id: &str) -> Mat {
    match self.get(id).and_then(|n| n.parent.clone()) {
      Some(p) => self.abs_matrix(&p),
      None => Mat::IDENTITY,
    }
  }

  /// Axis-aligned page-space bounds.
  pub fn abs_bounds(&self, id: &str) -> Rect {
    match self.get(id) {
      Some(n) => self.abs_matrix(id).bounds_of(n.width, n.height),
      None => Rect::default(),
    }
  }

  pub fn bounds_of_many(&self, ids: &[NodeId]) -> Option<Rect> {
    Rect::union_all(ids.iter().filter(|i| self.nodes.contains_key(*i)).map(|i| self.abs_bounds(i)))
  }

  pub fn top_level_of(&self, id: &str) -> NodeId {
    self.path(id).into_iter().next().unwrap_or_else(|| id.to_string())
  }

  /// Inserts a node into `parent` (or the page root) at `index` (default top).
  pub fn insert(&mut self, mut node: Node, parent: Option<&str>, page: &str, index: Option<usize>) {
    node.parent = parent.map(|p| p.to_string());
    node.page = page.to_string();
    let id = node.id.clone();
    self.nodes.insert(id.clone(), node);
    if let Some(list) = self.child_list_mut(parent, page) {
      let i = index.unwrap_or(list.len()).min(list.len());
      list.insert(i, id);
    }
  }

  /// Removes a node id from its parent's child list without deleting it.
  pub fn detach(&mut self, id: &str) {
    let Some((parent, page)) = self.get(id).map(|n| (n.parent.clone(), n.page.clone())) else {
      return;
    };
    if let Some(list) = self.child_list_mut(parent.as_deref(), &page) {
      list.retain(|c| c != id);
    }
  }

  /// Deletes a node and all descendants.
  pub fn remove(&mut self, id: &str) {
    self.detach(id);
    for nid in self.subtree(id) {
      self.nodes.remove(&nid);
    }
  }

  /// Moves a node under a new parent, keeping its page-space position when `keep_abs`.
  pub fn reparent(&mut self, id: &str, new_parent: Option<&str>, index: Option<usize>, keep_abs: bool) {
    if let Some(p) = new_parent {
      if p == id || self.is_ancestor(id, p) {
        return;
      }
    }
    let Some(node) = self.get(id) else { return };
    let page = node.page.clone();
    let abs = self.abs_matrix(id);
    self.detach(id);
    let new_page = match new_parent {
      Some(p) => self.get(p).map(|n| n.page.clone()).unwrap_or(page),
      None => page,
    };
    if let Some(list) = self.child_list_mut(new_parent, &new_page) {
      let i = index.unwrap_or(list.len()).min(list.len());
      list.insert(i, id.to_string());
    }
    let parent_m = match new_parent {
      Some(p) => self.abs_matrix(p),
      None => Mat::IDENTITY,
    };
    if let Some(n) = self.get_mut(id) {
      n.parent = new_parent.map(|p| p.to_string());
      n.page = new_page.clone();
    }
    if keep_abs {
      self.set_abs_origin(id, &abs, &parent_m);
    }
    for nid in self.subtree(id) {
      if let Some(n) = self.get_mut(&nid) {
        n.page = new_page.clone();
      }
    }
  }

  /// Re-derives local x/y/rotation so the node lands on `abs` under a parent transform.
  fn set_abs_origin(&mut self, id: &str, abs: &Mat, parent_m: &Mat) {
    let Some(n) = self.get(id) else { return };
    let (w, h) = (n.width, n.height);
    let center_abs = abs.apply(Point::new(w / 2.0, h / 2.0));
    let center_local = parent_m.invert().apply(center_abs);
    let rel = parent_m.invert().mul(abs);
    let rotation = rel.b.atan2(rel.a).to_degrees();
    if let Some(n) = self.get_mut(id) {
      n.x = center_local.x - w / 2.0;
      n.y = center_local.y - h / 2.0;
      n.rotation = normalize_angle(rotation);
    }
  }

  /// Deep-clones a subtree with fresh ids. Returns cloned nodes (root first) and an id map.
  pub fn clone_subtree(&self, id: &str, ids: &mut IdGen) -> (Vec<Node>, HashMap<NodeId, NodeId>) {
    let order = self.subtree(id);
    let mut map = HashMap::new();
    for old in &order {
      map.insert(old.clone(), ids.next("n_"));
    }
    let nodes = order
      .iter()
      .filter_map(|old| self.get(old))
      .map(|n| {
        let mut c = n.clone();
        c.id = map[&n.id].clone();
        c.children = n.children.iter().filter_map(|ch| map.get(ch).cloned()).collect();
        c.parent = n.parent.as_ref().and_then(|p| map.get(p).cloned());
        c
      })
      .collect();
    (nodes, map)
  }

  /// All nodes on a page in paint order (pre-order).
  pub fn page_nodes(&self, page: &str) -> Vec<NodeId> {
    let roots = self.page(page).map(|p| p.children.clone()).unwrap_or_default();
    roots.iter().flat_map(|r| self.subtree(r)).collect()
  }

  pub fn components(&self) -> Vec<&Node> {
    self.nodes.values().filter(|n| n.kind == NodeType::Component).collect()
  }

  /// Unique layer name like "Rectangle 3": the base plus one more than the number of layers
  /// whose name starts with it. The first ask for a base scans the document; after that the
  /// count follows the nodes that changed since the last ask.
  pub fn next_name(&self, base: &str) -> String {
    let mut index = self.names.lock();
    index.sync(&self.nodes);
    let index = &mut *index;
    let count = *index
      .counts
      .entry(base.to_string())
      .or_insert_with(|| index.seen.values().filter(|n| n.name.starts_with(base)).count());
    format!("{base} {}", count + 1)
  }
}

pub fn normalize_angle(a: f64) -> f64 {
  let mut r = a % 360.0;
  if r > 180.0 {
    r -= 360.0;
  }
  if r <= -180.0 {
    r += 360.0;
  }
  if r.abs() < 1e-9 {
    0.0
  } else {
    (r * 1000.0).round() / 1000.0
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn rect(id: &str) -> Node {
    Node {
      id: id.into(),
      ..Default::default()
    }
  }

  #[test]
  fn insert_reparent_keeps_position() {
    let mut ids = IdGen::new(7);
    let mut doc = new_document(&mut ids, "t");
    let page = doc.pages[0].id.clone();
    let mut frame = Node {
      id: "f".into(),
      kind: NodeType::Frame,
      x: 100.0,
      y: 50.0,
      ..Default::default()
    };
    frame.width = 400.0;
    frame.height = 400.0;
    doc.insert(frame, None, &page, None);
    let mut r = rect("r");
    r.x = 150.0;
    r.y = 80.0;
    doc.insert(r, None, &page, None);
    doc.reparent("r", Some("f"), None, true);
    let n = doc.get("r").unwrap();
    assert_eq!((n.x, n.y), (50.0, 30.0));
    assert_eq!(doc.abs_bounds("r").x, 150.0);
    assert_eq!(doc.get("f").unwrap().children, vec!["r".to_string()]);
    assert!(doc.page(&page).unwrap().children == vec!["f".to_string()]);
  }

  #[test]
  fn no_cycles() {
    let mut ids = IdGen::new(7);
    let mut doc = new_document(&mut ids, "t");
    let page = doc.pages[0].id.clone();
    doc.insert(
      Node {
        id: "a".into(),
        kind: NodeType::Frame,
        ..Default::default()
      },
      None,
      &page,
      None,
    );
    doc.insert(
      Node {
        id: "b".into(),
        kind: NodeType::Frame,
        ..Default::default()
      },
      Some("a"),
      &page,
      None,
    );
    doc.reparent("a", Some("b"), None, true);
    assert_eq!(doc.get("a").unwrap().parent, None);
  }

  /// `cargo test --release -p designotron-engine bench_unnamed_imports -- --ignored --nocapture`
  #[test]
  #[ignore]
  fn bench_unnamed_imports() {
    use std::time::Instant;
    let import = |existing: usize, added: usize| {
      let mut ids = IdGen::new(7);
      let mut doc = new_document(&mut ids, "t");
      let page = doc.pages[0].id.clone();
      for i in 0..existing {
        doc.insert(
          Node {
            id: format!("e{i}"),
            name: format!("Layer {i}"),
            ..Default::default()
          },
          None,
          &page,
          None,
        );
      }
      let t = Instant::now();
      for i in 0..added {
        let name = doc.next_name("Text");
        doc.insert(
          Node {
            id: format!("t{i}"),
            name,
            kind: NodeType::Text,
            ..Default::default()
          },
          None,
          &page,
          None,
        );
      }
      let ms = t.elapsed().as_secs_f64() * 1000.0;
      println!("import {added:>5} unnamed layers into {existing:>5}-layer doc: {ms:>9.1} ms");
      ms
    };
    let small = import(100, 5_000);
    let large = import(10_000, 5_000);
    println!(
      "10000-layer / 100-layer time: {:.2} (about 1 when the document size doesn't matter)",
      large / small
    );
  }
}
