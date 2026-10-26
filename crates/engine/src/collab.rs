//! Collaboration: deltas between peers, merging them, repairing the tree after concurrent
//! structural edits, and reverting one step without touching other people's changes
//! (selective undo).
//!
//! Layers changed in place travel as per-property patches (`patch`), so two people editing
//! different properties of one layer both keep their change; a relay that orders every
//! change (see `designotron-rooms`) makes everyone converge on the same document.

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

use crate::model::{Comment, Document, Node, NodeId};

/// Changes from `base` to `doc` as JSON: added nodes in full (`nodes`), changed ones as
/// per-property `patch`es (whole nodes when `patches` is false, for peers that predate
/// patches), removed nodes and comments, plus the document-level fields that differ
/// (name, pages, styles, variables).
pub fn delta(base: &Document, doc: &Document, patches: bool) -> Value {
  let mut nodes = Map::new();
  let mut patch = Map::new();
  let mut removed = Vec::new();
  for item in base.nodes.diff(&doc.nodes) {
    match item {
      imbl::ordmap::DiffItem::Update { old: (_, o), new: (k, v) } if patches => {
        patch.insert(k.clone(), Value::Object(node_patch(o, v)));
      }
      imbl::ordmap::DiffItem::Add(k, v) | imbl::ordmap::DiffItem::Update { new: (k, v), .. } => {
        nodes.insert(k.clone(), serde_json::to_value(v).unwrap_or(Value::Null));
      }
      imbl::ordmap::DiffItem::Remove(k, _) => removed.push(json!(k)),
    }
  }
  let mut comments = Map::new();
  for (id, c) in &doc.comments {
    if base.comments.get(id) != Some(c) {
      comments.insert(id.clone(), serde_json::to_value(c).unwrap_or(Value::Null));
    }
  }
  let comments_removed: Vec<&String> = base.comments.keys().filter(|k| !doc.comments.contains_key(*k)).collect();
  let mut out = json!({ "nodes": nodes, "removed": removed, "comments": comments, "commentsRemoved": comments_removed });
  let o = out.as_object_mut().unwrap();
  if !patch.is_empty() {
    o.insert("patch".into(), Value::Object(patch));
  }
  if base.name != doc.name {
    o.insert("name".into(), json!(doc.name));
  }
  if base.pages != doc.pages {
    o.insert("pages".into(), json!(doc.pages));
  }
  if base.styles != doc.styles {
    o.insert("styles".into(), json!(doc.styles));
  }
  if base.variables != doc.variables {
    o.insert("variables".into(), json!(doc.variables));
  }
  out
}

/// The properties of `new` that differ from `old` (`null` for ones `new` leaves out).
fn node_patch(old: &Node, new: &Node) -> Map<String, Value> {
  let (Ok(Value::Object(o)), Ok(Value::Object(n))) = (serde_json::to_value(old), serde_json::to_value(new)) else {
    return Map::new();
  };
  let mut out = Map::new();
  for (k, v) in &n {
    if o.get(k) != Some(v) {
      out.insert(k.clone(), v.clone());
    }
  }
  for k in o.keys().filter(|k| !n.contains_key(*k)) {
    out.insert(k.clone(), Value::Null);
  }
  out
}

/// `node` with the properties in `patch` replaced (`null` resets one to its default).
fn patch_node(node: &Node, patch: &Map<String, Value>) -> Result<Node, String> {
  let mut v = serde_json::to_value(node).map_err(|e| e.to_string())?;
  let o = v.as_object_mut().ok_or("bad node")?;
  for (k, val) in patch {
    if val.is_null() {
      o.remove(k);
    } else {
      o.insert(k.clone(), val.clone());
    }
  }
  serde_json::from_value(v).map_err(|e| e.to_string())
}

/// True when a delta carries no changes.
pub fn is_empty(d: &Value) -> bool {
  let empty = |k: &str| {
    d.get(k)
      .map(|v| {
        v.as_object()
          .map(|o| o.is_empty())
          .or(v.as_array().map(|a| a.is_empty()))
          .unwrap_or(false)
      })
      .unwrap_or(true)
  };
  empty("nodes")
    && empty("patch")
    && empty("removed")
    && empty("comments")
    && empty("commentsRemoved")
    && ["name", "pages", "styles", "variables"].iter().all(|k| d.get(*k).is_none())
}

/// Applies a peer's delta, then repairs the tree around everything it touched.
pub fn apply(doc: &mut Document, d: &Value) -> Result<(), String> {
  let before = doc.clone();
  let mut touched: Vec<NodeId> = Vec::new();
  if let Some(nodes) = d.get("nodes").and_then(|v| v.as_object()) {
    for (id, v) in nodes {
      let n: Node = serde_json::from_value(v.clone()).map_err(|e| format!("bad node {id}: {e}"))?;
      doc.nodes.insert(id.clone(), n);
      touched.push(id.clone());
    }
  }
  if let Some(patches) = d.get("patch").and_then(|v| v.as_object()) {
    for (id, p) in patches {
      // A layer someone deleted meanwhile stays deleted.
      let (Some(n), Some(p)) = (doc.get(id), p.as_object()) else {
        continue;
      };
      let n = patch_node(n, p).map_err(|e| format!("bad patch {id}: {e}"))?;
      doc.nodes.insert(id.clone(), n);
      touched.push(id.clone());
    }
  }
  for id in d
    .get("removed")
    .and_then(|v| v.as_array())
    .into_iter()
    .flatten()
    .filter_map(|v| v.as_str())
  {
    if doc.nodes.remove(id).is_some() {
      touched.push(id.to_string());
    }
  }
  if let Some(c) = d.get("comments").and_then(|v| v.as_object()) {
    for (id, v) in c {
      let c: Comment = serde_json::from_value(v.clone()).map_err(|e| format!("bad comment {id}: {e}"))?;
      doc.comments.insert(id.clone(), c);
    }
  }
  for id in d
    .get("commentsRemoved")
    .and_then(|v| v.as_array())
    .into_iter()
    .flatten()
    .filter_map(|v| v.as_str())
  {
    doc.comments.remove(id);
  }
  if let Some(v) = d.get("name").and_then(|v| v.as_str()) {
    doc.name = v.to_string();
  }
  if let Some(v) = d.get("pages") {
    doc.pages = serde_json::from_value(v.clone()).map_err(|e| format!("bad pages: {e}"))?;
  }
  if let Some(v) = d.get("styles") {
    doc.styles = serde_json::from_value(v.clone()).map_err(|e| format!("bad styles: {e}"))?;
  }
  if let Some(v) = d.get("variables") {
    doc.variables = serde_json::from_value(v.clone()).map_err(|e| format!("bad variables: {e}"))?;
  }
  repair(doc, &before, &touched);
  crate::components::resync_swapped(doc, &before, &touched);
  Ok(())
}

/// Moves `doc` by the change that took `from` to `to`, leaving every other change in place.
/// With `doc == from` the result is exactly `to`.
pub fn revert(doc: &Document, from: &Document, to: &Document) -> Document {
  let mut out = doc.clone();
  let mut touched = Vec::new();
  for item in from.nodes.diff(&to.nodes) {
    match item {
      // Only the properties this step changed, so a collaborator's edits to other
      // properties of the same layer survive the undo.
      imbl::ordmap::DiffItem::Update { old: (_, o), new: (k, v) } if out.get(k).is_some() => {
        let n = patch_node(out.get(k).unwrap(), &node_patch(o, v)).unwrap_or_else(|_| v.clone());
        out.nodes.insert(k.clone(), n);
        touched.push(k.clone());
      }
      imbl::ordmap::DiffItem::Add(k, v) | imbl::ordmap::DiffItem::Update { new: (k, v), .. } => {
        out.nodes.insert(k.clone(), v.clone());
        touched.push(k.clone());
      }
      imbl::ordmap::DiffItem::Remove(k, _) => {
        out.nodes.remove(k);
        touched.push(k.clone());
      }
    }
  }
  if from.name != to.name {
    out.name = to.name.clone();
  }
  if from.pages != to.pages {
    out.pages = to.pages.clone();
  }
  if from.styles != to.styles {
    out.styles = to.styles.clone();
  }
  if from.variables != to.variables {
    out.variables = to.variables.clone();
  }
  for id in from.comments.keys().chain(to.comments.keys()).collect::<BTreeSet<_>>() {
    if from.comments.get(id) != to.comments.get(id) {
      match to.comments.get(id) {
        Some(c) => out.comments.insert(id.clone(), c.clone()),
        None => out.comments.remove(id),
      };
    }
  }
  let base = doc.clone();
  repair(&mut out, &base, &touched);
  out
}

/// Restores parent/child consistency after merging: every node is listed by its parent
/// (or its page when top-level) exactly once, and lists only hold their own children.
/// Only the touched nodes, their old and new parents and the pages are examined.
pub fn repair(doc: &mut Document, before: &Document, touched: &[NodeId]) {
  // A peer's change must never make a layer its own ancestor (walking the tree would hang).
  doc.break_parent_cycles(touched);
  let mut check: BTreeSet<NodeId> = BTreeSet::new();
  for id in touched {
    check.insert(id.clone());
    for d in [&*doc, before] {
      if let Some(p) = d.get(id).and_then(|n| n.parent.clone()) {
        check.insert(p);
      }
    }
  }
  let first_page = doc.pages.first().map(|p| p.id.clone()).unwrap_or_default();
  // Children lists keep only nodes that exist and point back at this parent. Children the
  // list had before the merge (added concurrently here) stay, appended after the new order.
  for id in &check {
    let Some(n) = doc.get(id) else { continue };
    let earlier = before.get(id).map(|b| b.children.clone()).unwrap_or_default();
    let mut seen = BTreeSet::new();
    let fixed: Vec<NodeId> = n
      .children
      .iter()
      .chain(earlier.iter())
      .filter(|c| doc.get(c).map(|cn| cn.parent.as_deref() == Some(id.as_str())).unwrap_or(false) && seen.insert((*c).clone()))
      .cloned()
      .collect();
    if fixed != n.children {
      doc.get_mut(id).unwrap().children = fixed;
    }
  }
  // Each touched node is listed by its parent (or becomes top-level if the parent is gone).
  for id in touched {
    let Some(n) = doc.get(id).cloned() else { continue };
    match n.parent.as_deref() {
      Some(p) if doc.get(p).is_some() => {
        if !doc.get(p).unwrap().children.contains(id) {
          doc.get_mut(p).unwrap().children.push(id.clone());
        }
      }
      Some(_) => {
        let m = doc.get_mut(id).unwrap();
        m.parent = None;
      }
      None => {}
    }
    if doc.page(&n.page).is_none() {
      let m = doc.get_mut(id).unwrap();
      m.page = first_page.clone();
    }
  }
  // Pages list exactly their top-level nodes.
  let roots: Vec<(NodeId, String)> = touched
    .iter()
    .filter_map(|id| doc.get(id))
    .filter(|n| n.parent.is_none())
    .map(|n| (n.id.clone(), n.page.clone()))
    .collect();
  let nodes = &doc.nodes;
  for page in doc.pages.iter_mut() {
    let earlier = before.page(&page.id).map(|p| p.children.clone()).unwrap_or_default();
    let mut seen = BTreeSet::new();
    let valid = |c: &NodeId| nodes.get(c).map(|n| n.parent.is_none() && n.page == page.id).unwrap_or(false);
    let mut fixed: Vec<NodeId> = page
      .children
      .iter()
      .chain(earlier.iter())
      .filter(|c| valid(c) && seen.insert((*c).clone()))
      .cloned()
      .collect();
    for (id, pid) in &roots {
      if *pid == page.id && !fixed.contains(id) {
        fixed.push(id.clone());
      }
    }
    page.children = fixed;
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::engine::{Command, Engine};
  use crate::model::NodeType;
  use crate::text::HeuristicMeasurer;

  fn engine(seed: u64) -> Engine {
    Engine::new(Box::new(HeuristicMeasurer), seed)
  }

  fn rect(e: &mut Engine, x: f64, parent: Option<String>) -> String {
    e.dispatch(Command::CreateShape {
      kind: NodeType::Rectangle,
      x,
      y: 0.0,
      width: 10.0,
      height: 10.0,
      parent,
    })
    .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string()
  }

  #[test]
  fn a_peer_cannot_make_a_layer_its_own_ancestor() {
    let mut e = engine(1);
    let a = rect(&mut e, 0.0, None);
    let b = rect(&mut e, 20.0, None);
    let mut na = serde_json::to_value(e.doc.get(&a).unwrap()).unwrap();
    let mut nb = serde_json::to_value(e.doc.get(&b).unwrap()).unwrap();
    // Self-parent.
    na["parent"] = json!(a);
    na["children"] = json!([a]);
    apply(&mut e.doc, &json!({ "nodes": { &a: na.clone() } })).unwrap();
    assert!(e.doc.ancestors(&a).is_empty());
    assert_eq!(e.doc.get(&a).unwrap().parent, None);
    assert!(e.doc.get(&a).unwrap().children.is_empty());
    // Mutual parents.
    na["parent"] = json!(b);
    na["children"] = json!([b]);
    nb["parent"] = json!(a);
    nb["children"] = json!([a]);
    apply(&mut e.doc, &json!({ "nodes": { &a: na, &b: nb } })).unwrap();
    for id in [&a, &b] {
      assert!(e.doc.ancestors(id).len() <= 1, "{id}");
      assert!(!e.doc.ancestors(id).contains(id));
    }
    let tops = [&a, &b].iter().filter(|id| e.doc.get(id).unwrap().parent.is_none()).count();
    assert_eq!(tops, 1, "exactly one side of the cycle is cut");
    e.dispatch(Command::SelectAll).ok();
    let page = e.doc.pages[0].id.clone();
    e.render(&page, &[]);
  }

  #[test]
  fn concurrent_adds_to_the_same_frame_both_survive() {
    let mut a = engine(1);
    let frame = a
      .dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 0.0,
        y: 0.0,
        width: 200.0,
        height: 200.0,
        parent: None,
      })
      .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    let mut b = engine(2);
    b.load(&a.to_json()).unwrap();
    let base = a.doc.clone();
    let ra = rect(&mut a, 10.0, Some(frame.clone()));
    let rb = rect(&mut b, 50.0, Some(frame.clone()));
    // Each side's frame lists only its own new child; merging must keep both.
    let da = delta(&base, &a.doc, true);
    let db = delta(&base, &b.doc, true);
    apply(&mut a.doc, &db).unwrap();
    apply(&mut b.doc, &da).unwrap();
    for d in [&a.doc, &b.doc] {
      let kids = &d.get(&frame).unwrap().children;
      assert!(kids.contains(&ra) && kids.contains(&rb), "{kids:?}");
    }
  }

  #[test]
  fn undo_keeps_a_collaborators_later_edit() {
    let mut a = engine(1);
    let mine = rect(&mut a, 0.0, None);
    let mut b = engine(2);
    b.load(&a.to_json()).unwrap();
    // A moves its rectangle; B then adds one; A undoes the move.
    a.dispatch(Command::Update {
      ids: vec![mine.clone()],
      patch: json!({ "x": 100 }),
    })
    .unwrap();
    let base_b = b.doc.clone();
    let theirs = rect(&mut b, 300.0, None);
    a.dispatch(Command::ApplyRemote {
      delta: delta(&base_b, &b.doc, true),
      local: false,
    })
    .unwrap();
    a.dispatch(Command::Undo).unwrap();
    assert_eq!(a.doc.get(&mine).unwrap().x, 0.0, "my move is undone");
    assert!(a.doc.get(&theirs).is_some(), "their rectangle survives my undo");
    assert!(a.doc.page(&a.page).unwrap().children.contains(&theirs));
    a.dispatch(Command::Redo).unwrap();
    assert_eq!(a.doc.get(&mine).unwrap().x, 100.0);
    assert!(a.doc.get(&theirs).is_some());
  }

  /// A relay (the room's document, applying deltas in arrival order) and its editors.
  struct Room {
    doc: Document,
    editors: Vec<Engine>,
  }

  impl Room {
    fn new(n: usize) -> (Room, String) {
      let mut first = engine(1);
      let id = rect(&mut first, 0.0, None);
      let json = first.to_json();
      let editors = (0..n)
        .map(|i| {
          let mut e = engine(10 + i as u64);
          e.load(&json).unwrap();
          e.collab_reset(true);
          e
        })
        .collect();
      (
        Room {
          doc: first.doc.clone(),
          editors,
        },
        id,
      )
    }

    /// Editor `i` sends its changes; the relay applies them and hands back what each
    /// editor receives: the delta for the others, an ack for the sender.
    fn send(&mut self, i: usize) -> Vec<(usize, Value)> {
      let d = self.editors[i].collab_delta();
      apply(&mut self.doc, &d).unwrap();
      (0..self.editors.len())
        .map(|j| (j, if j == i { json!({ "ack": true }) } else { d.clone() }))
        .collect()
    }

    fn receive(&mut self, (j, m): (usize, Value)) {
      let e = &mut self.editors[j];
      e.collab_delta(); // flush first, as the editor does
      if m.get("ack").is_some() {
        e.dispatch(Command::CollabAck { rejected: false }).unwrap();
      } else {
        e.dispatch(Command::ApplyRemote { delta: m, local: false }).unwrap();
      }
    }

    fn assert_converged(&self) {
      for e in &self.editors {
        assert_eq!(e.doc.nodes, self.doc.nodes);
      }
    }
  }

  fn set(e: &mut Engine, id: &str, patch: Value) {
    e.dispatch(Command::Update {
      ids: vec![id.to_string()],
      patch,
    })
    .unwrap();
  }

  #[test]
  fn concurrent_edits_to_one_layer_converge() {
    // Different properties: both survive.
    let (mut room, id) = Room::new(2);
    set(&mut room.editors[0], &id, json!({ "opacity": 0.5 }));
    set(&mut room.editors[1], &id, json!({ "x": 40.0 }));
    let from_a = room.send(0);
    let from_b = room.send(1);
    // Each editor hears the other's change before its own ack (worst case).
    for m in [from_b[0].clone(), from_a[0].clone(), from_a[1].clone(), from_b[1].clone()] {
      room.receive(m);
    }
    room.assert_converged();
    let n = room.doc.get(&id).unwrap();
    assert_eq!((n.opacity, n.x), (0.5, 40.0));

    // The same property: the change the relay ordered last wins everywhere, and an editor
    // never shows the other's value over its own unacknowledged one.
    set(&mut room.editors[0], &id, json!({ "x": 1.0 }));
    set(&mut room.editors[1], &id, json!({ "x": 2.0 }));
    let from_a = room.send(0);
    let from_b = room.send(1);
    room.receive(from_a[1].clone());
    assert_eq!(room.editors[1].doc.get(&id).unwrap().x, 2.0, "own pending change stays on top");
    room.receive(from_b[1].clone());
    room.receive(from_a[0].clone());
    room.receive(from_b[0].clone());
    room.assert_converged();
    assert_eq!(room.doc.get(&id).unwrap().x, 2.0);
  }

  #[test]
  fn a_rejected_change_is_dropped_locally() {
    let (mut room, id) = Room::new(1);
    let e = &mut room.editors[0];
    set(e, &id, json!({ "x": 99.0 }));
    e.collab_delta();
    e.dispatch(Command::CollabAck { rejected: true }).unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 0.0);
    assert!(is_empty(&e.collab_delta()));
  }

  #[test]
  fn undo_keeps_a_collaborators_edit_to_another_property() {
    let (mut room, id) = Room::new(2);
    set(&mut room.editors[0], &id, json!({ "x": 50.0 }));
    for m in room.send(0) {
      room.receive(m);
    }
    set(&mut room.editors[1], &id, json!({ "opacity": 0.25 }));
    for m in room.send(1) {
      room.receive(m);
    }
    room.editors[0].dispatch(Command::Undo).unwrap();
    for m in room.send(0) {
      room.receive(m);
    }
    room.assert_converged();
    let n = room.doc.get(&id).unwrap();
    assert_eq!((n.x, n.opacity), (0.0, 0.25));
  }

  #[test]
  fn remote_changes_are_not_undoable_locally_and_do_not_echo() {
    let mut a = engine(1);
    let mut b = engine(2);
    b.load(&a.to_json()).unwrap();
    a.collab_delta();
    let base_b = b.doc.clone();
    rect(&mut b, 0.0, None);
    a.dispatch(Command::ApplyRemote {
      delta: delta(&base_b, &b.doc, true),
      local: false,
    })
    .unwrap();
    assert!(!a.state()["canUndo"].as_bool().unwrap());
    assert!(is_empty(&a.collab_delta()), "applying a peer's change must not be sent back");
  }
}
