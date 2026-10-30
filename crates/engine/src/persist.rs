//! Incremental persistence: what changed since the document was last stored, grouped by
//! top-level layer, so a big file's autosave writes the layers that changed instead of the
//! whole document.
//!
//! The editor keeps one record per top-level layer (`chunk`: the layer and all its
//! descendants) plus a small record for everything else (`Plan::meta`). `Persist` remembers
//! the document as of the last stored write (`base`); `plan` diffs against it (O(changes):
//! the node map is persistent) and `commit` moves the baseline once the write has landed.

use std::collections::{BTreeMap, BTreeSet};

use imbl::ordmap::DiffItem;
use serde_json::Value;

use crate::model::{Document, NodeId};

/// Plans handed out and not yet written, kept so a later plan can include what they changed.
const MAX_OUTSTANDING: usize = 8;

/// What to write for one save.
pub struct Plan {
  /// Identifies this plan for `commit`.
  pub token: u64,
  /// Every top-level layer is in `dirty` and the stored set of layers is replaced by it.
  pub full: bool,
  /// Document-level fields (everything but the node table) as a JSON object.
  pub meta: String,
  /// Top-level layers to (re)write, see `Persist::chunk`.
  pub dirty: Vec<NodeId>,
  /// Names of the layers in `dirty`, for reporting a layer that can't be read back.
  pub names: BTreeMap<NodeId, String>,
  /// Layers that are stored but no longer top-level (deleted, or moved into another layer).
  pub removed: Vec<NodeId>,
}

#[derive(Default)]
pub struct Persist {
  /// The document as of the last write that landed; `None` until one has (or was adopted).
  base: Option<Document>,
  /// The document of every plan handed out and not yet superseded by a landed write, oldest
  /// first. A write that was started may land or not (or land after a later one), so a plan
  /// must cover what any of them changed: a layer deleted by one and brought back by an undo
  /// is unchanged against the baseline, yet the earlier write may have removed it.
  outstanding: Vec<(u64, Document)>,
  /// A plan was dropped from `outstanding`: only a full write is safe.
  lost_track: bool,
  next: u64,
  committed: u64,
}

impl Persist {
  /// Treats `doc` as what storage holds (a file just read from it).
  pub fn adopt(&mut self, doc: &Document) {
    self.base = Some(doc.clone());
    self.outstanding.clear();
    self.lost_track = false;
  }

  /// Forgets the baseline: the next plan writes everything.
  pub fn reset(&mut self) {
    self.base = None;
  }

  /// What to write so storage matches `doc`: the layers that changed since the baseline or
  /// since any outstanding plan (all of them without a baseline, or when `force_full`).
  pub fn plan(&mut self, doc: &Document, force_full: bool) -> Plan {
    self.next += 1;
    let token = self.next;
    let meta = meta_json(doc);
    let full = force_full || self.base.is_none() || self.lost_track;
    let mut dirty: BTreeSet<NodeId> = BTreeSet::new();
    let mut removed: BTreeSet<NodeId> = BTreeSet::new();
    if full {
      dirty.extend(doc.nodes.values().filter(|n| n.parent.is_none()).map(|n| n.id.clone()));
    } else {
      let bases = self.base.iter().chain(self.outstanding.iter().map(|(_, d)| d));
      for prev in bases {
        changes(prev, doc, &mut dirty, &mut removed);
      }
      // Only layers that exist (a missing ancestor id would name nothing).
      dirty.retain(|r| doc.get(r).is_some_and(|n| n.parent.is_none()));
    }
    self.outstanding.push((token, doc.clone()));
    if self.outstanding.len() > MAX_OUTSTANDING {
      self.outstanding.remove(0);
      self.lost_track = true;
    }
    if full {
      // The write replaces everything stored, whatever it was.
      self.lost_track = false;
    }
    let names = dirty
      .iter()
      .filter_map(|r| doc.get(r).map(|n| (r.clone(), n.name.clone())))
      .collect();
    Plan {
      token,
      full,
      meta,
      dirty: dirty.into_iter().collect(),
      names,
      removed: removed.into_iter().collect(),
    }
  }

  /// The nodes of a top-level layer's tree from the document plan `token` was made from, as
  /// the body of a JSON object (`"id":{...},"id2":{...}`), ready to be joined with others.
  /// Empty when that plan is no longer kept.
  pub fn chunk(&self, token: u64, root: &str) -> String {
    let Some((_, doc)) = self.outstanding.iter().find(|(t, _)| *t == token) else {
      return String::new();
    };
    let mut out = String::new();
    let mut stack = vec![root.to_string()];
    while let Some(id) = stack.pop() {
      let Some(n) = doc.get(&id) else { continue };
      if !out.is_empty() {
        out.push(',');
      }
      out.push_str(&serde_json::to_string(&id).unwrap_or_default());
      out.push(':');
      out.push_str(&serde_json::to_string(n).unwrap_or_default());
      stack.extend(n.children.iter().rev().cloned());
    }
    out
  }

  /// The write for `token` landed: storage now holds that plan's document.
  pub fn commit(&mut self, token: u64) {
    // Writes can finish out of order; an older one must not move the baseline back.
    if token <= self.committed {
      return;
    }
    if let Some(i) = self.outstanding.iter().position(|(t, _)| *t == token) {
      self.base = Some(self.outstanding[i].1.clone());
      self.committed = token;
      // Plans older than the one that landed are covered by it (storage is at least as new);
      // later ones may still be in flight.
      self.outstanding.drain(..=i);
    }
  }
}

/// Adds to `dirty` the top-level layers whose tree differs between `prev` and `doc`, and to
/// `removed` the layers that were top-level in `prev` and no longer are.
fn changes(prev: &Document, doc: &Document, dirty: &mut BTreeSet<NodeId>, removed: &mut BTreeSet<NodeId>) {
  for item in prev.nodes.diff(&doc.nodes) {
    let id: &str = match &item {
      DiffItem::Add(k, _) => k,
      DiffItem::Update { new: (k, _), .. } => k,
      DiffItem::Remove(k, _) => k,
    };
    // A node that is gone, or no longer top-level, takes its stored record with it.
    if prev.get(id).is_some_and(|n| n.parent.is_none()) && doc.get(id).is_none_or(|n| n.parent.is_some()) {
      removed.insert(id.to_string());
    }
    // A removed node changed its parent's child list, so its layer is dirty through that.
    if !matches!(item, DiffItem::Remove(..)) {
      let root = doc.ancestors(id).last().cloned().unwrap_or_else(|| id.to_string());
      dirty.insert(root);
    }
  }
}

/// Every document-level field except the node table, as a JSON object.
fn meta_json(doc: &Document) -> String {
  let mut shell = doc.clone();
  shell.nodes = imbl::OrdMap::new();
  let mut v = serde_json::to_value(&shell).unwrap_or(Value::Null);
  if let Some(m) = v.as_object_mut() {
    m.remove("nodes");
  }
  v.to_string()
}

#[cfg(test)]
mod tests {
  use std::collections::BTreeMap;

  use serde_json::json;

  use super::*;
  use crate::engine::{Command, Engine};
  use crate::text::HeuristicMeasurer;

  /// What the editor keeps: the layer records and the document-level record.
  #[derive(Default)]
  struct Store {
    meta: String,
    chunks: BTreeMap<NodeId, String>,
  }

  fn engine() -> Engine {
    Engine::new(Box::new(HeuristicMeasurer), 7)
  }

  fn ai(e: &mut Engine, tool: &str, input: Value) -> Value {
    e.dispatch(Command::Ai { tool: tool.into(), input }).unwrap()
  }

  fn frame_with_cards(e: &mut Engine, name: &str, x: f64, cards: usize) -> String {
    let kids: Vec<Value> = (0..cards)
      .map(|i| {
        json!({ "type": "frame", "name": format!("Card {i}"), "width": 100, "height": 40, "children": [
          { "type": "rectangle", "width": 20, "height": 20, "fill": "#ff0000" },
          { "type": "text", "text": "Hello" }] })
      })
      .collect();
    let r = ai(
      e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": name, "x": x, "width": 400, "height": 400, "children": kids }] }),
    );
    r["created"][0]["id"].as_str().unwrap().to_string()
  }

  /// One save, applied to the store the way the editor does.
  fn save(p: &mut Persist, e: &Engine, store: &mut Store, force_full: bool) -> Plan {
    let plan = p.plan(&e.doc, force_full);
    if plan.full {
      store.chunks.clear();
    }
    for r in &plan.removed {
      store.chunks.remove(r);
    }
    for r in &plan.dirty {
      store.chunks.insert(r.clone(), p.chunk(plan.token, r));
    }
    store.meta = plan.meta.clone();
    p.commit(plan.token);
    plan
  }

  /// The document the stored records describe.
  fn restore(store: &Store) -> Document {
    let body: Vec<&str> = store.chunks.values().map(String::as_str).collect();
    let json = format!("{},\"nodes\":{{{}}}}}", &store.meta[..store.meta.len() - 1], body.join(","));
    serde_json::from_str(&json).expect("stored records load")
  }

  fn assert_stored(e: &Engine, store: &Store, what: &str) {
    let doc = restore(store);
    assert_eq!(doc.nodes.len(), e.doc.nodes.len(), "{what}: node count");
    assert!(doc == e.doc, "{what}: stored document differs");
  }

  #[test]
  fn roundtrips_edits_moves_and_deletes() {
    let mut e = engine();
    let mut p = Persist::default();
    let mut store = Store::default();
    let a = frame_with_cards(&mut e, "A", 0.0, 3);
    let b = frame_with_cards(&mut e, "B", 500.0, 3);
    let first = save(&mut p, &e, &mut store, false);
    assert!(first.full, "nothing was stored yet");
    assert_stored(&e, &store, "first save");

    // Editing one card rewrites only its layer.
    let card = e.doc.get(&a).unwrap().children[1].clone();
    e.dispatch(Command::Update {
      ids: vec![card],
      patch: json!({ "name": "Renamed" }),
    })
    .unwrap();
    let plan = save(&mut p, &e, &mut store, false);
    assert!(!plan.full);
    assert_eq!(plan.dirty, vec![a.clone()]);
    assert_stored(&e, &store, "edit");

    // Nothing changed: nothing to write but the document-level record.
    let plan = save(&mut p, &e, &mut store, false);
    assert!(plan.dirty.is_empty() && plan.removed.is_empty());

    // A card moved from one top-level layer into the other changes both.
    let moved = e.doc.get(&a).unwrap().children[0].clone();
    e.dispatch(Command::MoveToParent {
      ids: vec![moved],
      parent: Some(b.clone()),
      index: None,
    })
    .unwrap();
    let plan = save(&mut p, &e, &mut store, false);
    assert_eq!(plan.dirty.len(), 2, "both layers are rewritten: {:?}", plan.dirty);
    assert_stored(&e, &store, "reparent");

    // A top-level layer put inside another stops being stored as one.
    e.dispatch(Command::MoveToParent {
      ids: vec![a.clone()],
      parent: Some(b.clone()),
      index: None,
    })
    .unwrap();
    let plan = save(&mut p, &e, &mut store, false);
    assert!(plan.removed.contains(&a), "A is no longer top-level");
    assert!(!store.chunks.contains_key(&a));
    assert_stored(&e, &store, "nested layer");

    // Deleting a top-level layer drops its record.
    e.dispatch(Command::Delete { ids: vec![b.clone()] }).unwrap();
    let plan = save(&mut p, &e, &mut store, false);
    assert!(plan.removed.contains(&b));
    assert_stored(&e, &store, "delete");

    // Undo brings everything back.
    e.dispatch(Command::Undo).unwrap();
    save(&mut p, &e, &mut store, false);
    assert_stored(&e, &store, "undo");
    e.dispatch(Command::Undo).unwrap();
    e.dispatch(Command::Undo).unwrap();
    save(&mut p, &e, &mut store, false);
    assert_stored(&e, &store, "more undo");
  }

  #[test]
  fn a_write_that_did_not_land_is_included_in_the_next_plan() {
    let mut e = engine();
    let mut p = Persist::default();
    let mut store = Store::default();
    let a = frame_with_cards(&mut e, "A", 0.0, 2);
    let b = frame_with_cards(&mut e, "B", 500.0, 2);
    save(&mut p, &e, &mut store, false);
    e.dispatch(Command::Update {
      ids: vec![a.clone()],
      patch: json!({ "x": 10.0 }),
    })
    .unwrap();
    // This plan is never committed (the write failed).
    let lost = p.plan(&e.doc, false);
    assert_eq!(lost.dirty, vec![a.clone()]);
    e.dispatch(Command::Update {
      ids: vec![b.clone()],
      patch: json!({ "x": 600.0 }),
    })
    .unwrap();
    let plan = save(&mut p, &e, &mut store, false);
    assert_eq!(plan.dirty.len(), 2, "the failed plan's layer is still dirty");
    assert_stored(&e, &store, "after a failed write");
  }

  #[test]
  fn adopting_a_loaded_document_writes_only_later_changes() {
    let mut e = engine();
    let a = frame_with_cards(&mut e, "A", 0.0, 2);
    frame_with_cards(&mut e, "B", 500.0, 2);
    let json = e.to_json();
    let mut e2 = engine();
    e2.load(&json).unwrap();
    let mut p = Persist::default();
    p.adopt(&e2.doc);
    let plan = p.plan(&e2.doc, false);
    assert!(!plan.full && plan.dirty.is_empty());
    e2.dispatch(Command::Update {
      ids: vec![a.clone()],
      patch: json!({ "x": 3.0 }),
    })
    .unwrap();
    let plan = p.plan(&e2.doc, false);
    assert_eq!(plan.dirty, vec![a]);
    assert!(p.plan(&e2.doc, true).full, "a full plan can be forced");
  }

  #[test]
  fn an_older_commit_does_not_move_the_baseline_back() {
    let mut e = engine();
    let mut p = Persist::default();
    let a = frame_with_cards(&mut e, "A", 0.0, 1);
    let first = p.plan(&e.doc, false);
    e.dispatch(Command::Update {
      ids: vec![a.clone()],
      patch: json!({ "x": 1.0 }),
    })
    .unwrap();
    let second = p.plan(&e.doc, false);
    assert!(
      p.chunk(first.token, &a).contains(&a),
      "an older plan keeps its chunks until it is covered"
    );
    assert!(p.chunk(second.token, &a).contains(&a));
    p.commit(second.token);
    assert_eq!(p.chunk(first.token, &a), "", "a landed write covers the plans before it");
    p.commit(first.token);
    let third = p.plan(&e.doc, false);
    assert!(third.dirty.is_empty(), "the newer plan stays committed");
  }

  #[test]
  fn a_plan_includes_what_an_unfinished_one_changed_even_if_it_was_undone() {
    let mut e = engine();
    let mut p = Persist::default();
    let mut store = Store::default();
    let a = frame_with_cards(&mut e, "A", 0.0, 2);
    let c = frame_with_cards(&mut e, "C", 800.0, 2);
    save(&mut p, &e, &mut store, false);
    e.dispatch(Command::Delete { ids: vec![c.clone()] }).unwrap();
    let first = p.plan(&e.doc, false);
    assert_eq!(first.removed, vec![c.clone()]);
    // The write of `first` is in flight; the delete is undone and a second plan is made.
    e.dispatch(Command::Undo).unwrap();
    let second = p.plan(&e.doc, false);
    assert!(
      second.dirty.contains(&c),
      "C may have been removed by the first write: {:?}",
      second.dirty
    );
    assert!(!second.dirty.contains(&a));
    assert_eq!(second.names.get(&c).map(String::as_str), Some("C"));
    // Both writes land in order: the stored layers are those of the document.
    for plan in [&first, &second] {
      for r in &plan.removed {
        store.chunks.remove(r);
      }
      for r in &plan.dirty {
        store.chunks.insert(r.clone(), p.chunk(plan.token, r));
      }
      store.meta = plan.meta.clone();
    }
    assert_stored(&e, &store, "after both writes");
  }

  #[test]
  fn too_many_unfinished_plans_force_a_full_write() {
    let mut e = engine();
    let mut p = Persist::default();
    let mut store = Store::default();
    frame_with_cards(&mut e, "A", 0.0, 1);
    save(&mut p, &e, &mut store, false);
    for _ in 0..=MAX_OUTSTANDING {
      p.plan(&e.doc, false);
    }
    assert!(p.plan(&e.doc, false).full);
    assert!(!p.plan(&e.doc, false).full, "a full plan starts over");
  }
}
