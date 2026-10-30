//! Collaboration: deltas between peers, merging them, repairing the tree after concurrent
//! structural edits, and reverting one step without touching other people's changes
//! (selective undo).
//!
//! Layers changed in place travel as per-property patches (`patch`), so two people editing
//! different properties of one layer both keep their change; a relay that orders every
//! change (see `designotron-rooms`) makes everyone converge on the same document.
//!
//! Pages, styles and variables travel per id too (`granular` deltas), so two people editing
//! different styles, variables or pages at the same moment both keep their change. Older
//! peers send and understand the whole lists (`pages`, `styles`, `variables`); `apply`
//! takes either form and `legacy` turns a granular delta into the old one.

use std::collections::{BTreeMap, BTreeSet};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::model::{Comment, Document, Node, NodeId};
use crate::variables::{Collection, Variable};

/// Changes from `base` to `doc` as JSON: added nodes in full (`nodes`), changed ones as
/// per-property `patch`es (whole nodes when `patches` is false, for peers that predate
/// patches), removed nodes and comments, plus the document-level fields that differ
/// (name, pages, styles, variables). With `granular`, pages, styles and variables are sent
/// as per-id changes (`pageChanges`, `colorStyles`, `textStyles`, `collectionChanges`,
/// `variableChanges`: see `ListDelta`); otherwise as whole lists, for peers that predate them.
pub fn delta(base: &Document, doc: &Document, patches: bool, granular: bool) -> Value {
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
  if granular {
    granular_parts(base, doc, o);
  } else {
    if base.pages != doc.pages {
      o.insert("pages".into(), json!(doc.pages));
    }
    if base.styles != doc.styles {
      o.insert("styles".into(), json!(doc.styles));
    }
    if base.variables != doc.variables {
      o.insert("variables".into(), json!(doc.variables));
    }
  }
  out
}

/// This engine can read and write the per-id form of pages, styles and variables.
pub const GRANULAR: bool = true;

/// The wire keys of the per-id form of pages, styles and variables.
const GRANULAR_KEYS: [&str; 5] = ["pageChanges", "colorStyles", "textStyles", "collectionChanges", "variableChanges"];

/// True when a delta uses the per-id form of pages, styles or variables.
pub fn is_granular(d: &Value) -> bool {
  GRANULAR_KEYS.iter().any(|k| d.get(*k).is_some())
}

/// A granular delta in the whole-list form older peers understand, with the lists taken from
/// `doc` (the room's document, after applying the delta). `None` when `d` is not granular.
pub fn legacy(d: &Value, doc: &Document) -> Option<Value> {
  if !is_granular(d) {
    return None;
  }
  let mut out = d.clone();
  let o = out.as_object_mut()?;
  let has = |o: &Map<String, Value>, keys: &[&str]| keys.iter().any(|k| o.contains_key(*k));
  let pages = has(o, &["pageChanges"]);
  let styles = has(o, &["colorStyles", "textStyles"]);
  let vars = has(o, &["collectionChanges", "variableChanges"]);
  for k in GRANULAR_KEYS {
    o.remove(k);
  }
  if pages {
    o.insert("pages".into(), json!(doc.pages));
  }
  if styles {
    o.insert("styles".into(), json!(doc.styles));
  }
  if vars {
    o.insert("variables".into(), json!(doc.variables));
  }
  Some(out)
}

/// Adds the per-id changes of pages, styles and variables from `base` to `doc` to `o`.
fn granular_parts(base: &Document, doc: &Document, o: &mut Map<String, Value>) {
  // Sent on every flush (every frame of a drag): comparing is cheap, serialising is not.
  if base.pages == doc.pages && base.styles == doc.styles && base.variables == doc.variables {
    return;
  }
  let mut put = |k: &str, d: Option<Value>| {
    if let Some(d) = d {
      o.insert(k.into(), d);
    }
  };
  if base.pages != doc.pages {
    put("pageChanges", ListDelta::of(&base.pages, &doc.pages, |p| &p.id, &[]));
  }
  if base.styles.colors != doc.styles.colors {
    put(
      "colorStyles",
      ListDelta::of(&base.styles.colors, &doc.styles.colors, |s| &s.id, &[]),
    );
  }
  if base.styles.texts != doc.styles.texts {
    put("textStyles", ListDelta::of(&base.styles.texts, &doc.styles.texts, |s| &s.id, &[]));
  }
  if base.variables == doc.variables {
    return;
  }
  // Collections without their variables; a new collection travels whole, with them.
  let bare = |l: &[Collection]| -> Vec<Collection> {
    l.iter()
      .map(|c| Collection {
        id: c.id.clone(),
        name: c.name.clone(),
        modes: c.modes.clone(),
        variables: vec![],
      })
      .collect()
  };
  if let Some(mut d) = ListDelta::of(&bare(&base.variables), &bare(&doc.variables), |c| &c.id, &[]) {
    if let Some(add) = d.get_mut("add").and_then(|a| a.as_object_mut()) {
      for c in &doc.variables {
        if let Some(slot) = add.get_mut(&c.id) {
          *slot = json!(c);
        }
      }
    }
    put("collectionChanges", Some(d));
  }
  // Variables of collections both sides have; a mode's value is merged on its own.
  let mut vars = Map::new();
  for c in &doc.variables {
    if let Some(b) = base.variables.iter().find(|b| b.id == c.id) {
      if let Some(d) = ListDelta::of(&b.variables, &c.variables, |v| &v.id, &["values"]) {
        vars.insert(c.id.clone(), d);
      }
    }
  }
  if !vars.is_empty() {
    put("variableChanges", Some(Value::Object(vars)));
  }
}

/// Changes to a list of items keyed by id, as JSON:
/// `{add: {id: item}, patch: {id: {field: value | null}}, del: [id], order: [id]}`, each part
/// only when not empty. Items are added whole and edited field by field (a `nested` field is
/// itself merged key by key: a variable's per-mode values); an item someone deleted meanwhile
/// stays deleted. `order` (the sender's whole order) is only sent when the order differs from
/// "removed ones gone, new ones last"; on arrival, ids it doesn't list (added by others
/// meanwhile) keep their relative order after it.
struct ListDelta;

impl ListDelta {
  fn of<T: Serialize + PartialEq>(base: &[T], new: &[T], id: impl Fn(&T) -> &String, nested: &[&str]) -> Option<Value> {
    let (mut add, mut patch) = (Map::new(), Map::new());
    for n in new {
      match base.iter().find(|b| id(b) == id(n)) {
        None => {
          add.insert(id(n).clone(), serde_json::to_value(n).unwrap_or(Value::Null));
        }
        Some(b) if b == n => {}
        Some(b) => {
          let p = fields_patch(b, n, nested);
          if !p.is_empty() {
            patch.insert(id(n).clone(), Value::Object(p));
          }
        }
      }
    }
    let del: Vec<&String> = base.iter().map(&id).filter(|b| !new.iter().any(|n| id(n) == *b)).collect();
    // What a receiver of the base list ends up with without `order` (it adds in key order).
    let expected = base.iter().map(&id).filter(|b| !del.contains(b)).chain(add.keys());
    let ids: Vec<&String> = new.iter().map(&id).collect();
    let in_order = expected.eq(ids.iter().copied());
    let mut out = Map::new();
    for (k, v) in [("add", add), ("patch", patch)] {
      if !v.is_empty() {
        out.insert(k.into(), Value::Object(v));
      }
    }
    if !del.is_empty() {
      out.insert("del".into(), json!(del));
    }
    if !in_order {
      out.insert("order".into(), json!(ids));
    }
    (!out.is_empty()).then_some(Value::Object(out))
  }

  /// Applies `d` (see `of`) to `cur`.
  fn apply<T: Serialize + DeserializeOwned>(
    cur: &mut Vec<T>,
    d: &Value,
    id: impl Fn(&T) -> &String,
    nested: &[&str],
    what: &str,
  ) -> Result<(), String> {
    if let Some(add) = d.get("add").and_then(|v| v.as_object()) {
      for (k, v) in add {
        let item: T = serde_json::from_value(v.clone()).map_err(|e| format!("bad {what} {k}: {e}"))?;
        match cur.iter().position(|x| id(x) == k) {
          Some(i) => cur[i] = item,
          None => cur.push(item),
        }
      }
    }
    if let Some(patch) = d.get("patch").and_then(|v| v.as_object()) {
      for (k, p) in patch {
        let (Some(i), Some(p)) = (cur.iter().position(|x| id(x) == k), p.as_object()) else {
          continue;
        };
        cur[i] = patch_fields(&cur[i], p, nested).map_err(|e| format!("bad {what} patch {k}: {e}"))?;
      }
    }
    if let Some(del) = d.get("del").and_then(|v| v.as_array()) {
      cur.retain(|x| !del.iter().any(|k| k.as_str() == Some(id(x).as_str())));
    }
    if let Some(order) = d.get("order").and_then(|v| v.as_array()) {
      let rank = |x: &T| order.iter().position(|k| k.as_str() == Some(id(x).as_str())).unwrap_or(usize::MAX);
      cur.sort_by_key(rank); // stable: unlisted items keep their order, after the listed ones
    }
    Ok(())
  }
}

/// The properties of `new` that differ from `old` (`null` for ones `new` leaves out).
fn node_patch(old: &Node, new: &Node) -> Map<String, Value> {
  fields_patch(old, new, &[])
}

/// `node` with the properties in `patch` replaced (`null` resets one to its default).
fn patch_node(node: &Node, patch: &Map<String, Value>) -> Result<Node, String> {
  patch_fields(node, patch, &[])
}

/// The serialised fields of `new` that differ from `old`, `null` for ones `new` leaves out.
/// A `nested` field that is an object on both sides is diffed key by key (`null` removes one).
fn fields_patch<T: Serialize>(old: &T, new: &T, nested: &[&str]) -> Map<String, Value> {
  let (Ok(Value::Object(o)), Ok(Value::Object(n))) = (serde_json::to_value(old), serde_json::to_value(new)) else {
    return Map::new();
  };
  let mut out = Map::new();
  for (k, v) in &n {
    if o.get(k) == Some(v) {
      continue;
    }
    match (nested.contains(&k.as_str()), o.get(k), v) {
      (true, Some(Value::Object(ov)), Value::Object(nv)) => {
        let mut sub = Map::new();
        for (sk, sv) in nv.iter().filter(|(sk, sv)| ov.get(*sk) != Some(*sv)) {
          sub.insert(sk.clone(), sv.clone());
        }
        for sk in ov.keys().filter(|sk| !nv.contains_key(*sk)) {
          sub.insert(sk.clone(), Value::Null);
        }
        out.insert(k.clone(), Value::Object(sub));
      }
      _ => {
        out.insert(k.clone(), v.clone());
      }
    }
  }
  for k in o.keys().filter(|k| !n.contains_key(*k)) {
    out.insert(k.clone(), Value::Null);
  }
  out
}

/// `item` with the fields in `patch` replaced (`null` resets one to its default); a `nested`
/// object is merged key by key.
fn patch_fields<T: Serialize + DeserializeOwned>(item: &T, patch: &Map<String, Value>, nested: &[&str]) -> Result<T, String> {
  let mut v = serde_json::to_value(item).map_err(|e| e.to_string())?;
  let o = v.as_object_mut().ok_or("bad item")?;
  for (k, val) in patch {
    let nest = nested.contains(&k.as_str());
    match (nest, o.get_mut(k), val) {
      (_, _, Value::Null) => {
        o.remove(k);
      }
      (true, Some(Value::Object(cur)), Value::Object(sub)) => {
        for (sk, sv) in sub {
          if sv.is_null() {
            cur.remove(sk);
          } else {
            cur.insert(sk.clone(), sv.clone());
          }
        }
      }
      _ => {
        o.insert(k.clone(), val.clone());
      }
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
    && !is_granular(d)
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
  apply_granular(doc, d)?;
  // Two people deleting different pages at the same moment must not leave none (the first
  // page is the editor's fallback): the room's order decides, so every copy keeps the same one.
  keep_a_page(doc, &before);
  repair(doc, &before, &touched);
  Ok(())
}

/// Applies the per-id changes of pages, styles and variables in `d`, if it has any.
fn apply_granular(doc: &mut Document, d: &Value) -> Result<(), String> {
  if let Some(c) = d.get("pageChanges") {
    ListDelta::apply(&mut doc.pages, c, |p| &p.id, &[], "page")?;
  }
  if let Some(c) = d.get("colorStyles") {
    ListDelta::apply(&mut doc.styles.colors, c, |s| &s.id, &[], "colour style")?;
  }
  if let Some(c) = d.get("textStyles") {
    ListDelta::apply(&mut doc.styles.texts, c, |s| &s.id, &[], "text style")?;
  }
  if let Some(c) = d.get("collectionChanges") {
    // Collections change without their variables, which have their own changes below.
    let kept: BTreeMap<String, Vec<Variable>> = doc.variables.iter().map(|c| (c.id.clone(), c.variables.clone())).collect();
    for c in doc.variables.iter_mut() {
      c.variables.clear();
    }
    let done = ListDelta::apply(&mut doc.variables, c, |c| &c.id, &[], "collection");
    for c in doc.variables.iter_mut() {
      if let Some(v) = kept.get(&c.id) {
        c.variables = v.clone();
      }
    }
    done?;
  }
  if let Some(vars) = d.get("variableChanges").and_then(|v| v.as_object()) {
    for (id, c) in vars {
      if let Some(coll) = doc.variables.iter_mut().find(|x| x.id == *id) {
        ListDelta::apply(&mut coll.variables, c, |v| &v.id, &["values"], "variable")?;
      }
    }
  }
  Ok(())
}

/// Moves `doc` by the change that took `from` to `to`, leaving every other change in place.
/// With `doc == from` the result is exactly `to`.
///
/// Three-way per property: a property the step changed is reset only while `doc` still holds
/// the value the step gave it (`from`), so a collaborator's later value of the same property
/// survives an undo or redo, as do their other properties, layers, styles and variables.
pub fn revert(doc: &Document, from: &Document, to: &Document) -> Document {
  let mut out = revert_inner(doc, from, to);
  keep_a_page(&mut out, doc);
  out
}

/// A document always has a page: if `doc` has none, the last page `before` had comes back.
fn keep_a_page(doc: &mut Document, before: &Document) {
  if doc.pages.is_empty() {
    if let Some(p) = before.pages.last() {
      doc.pages.push(p.clone());
    }
  }
}

fn revert_inner(doc: &Document, from: &Document, to: &Document) -> Document {
  let mut out = doc.clone();
  let mut touched = Vec::new();
  for item in from.nodes.diff(&to.nodes) {
    match item {
      imbl::ordmap::DiffItem::Update { old: (_, o), new: (k, v) } if out.get(k).is_some() => {
        let n = merge_fields(out.get(k).unwrap(), o, v, true).unwrap_or_else(|| v.clone());
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
  if from.name != to.name && out.name == from.name {
    out.name = to.name.clone();
  }
  merge_list(&mut out.pages, &from.pages, &to.pages, |p| &p.id);
  merge_list(&mut out.styles.colors, &from.styles.colors, &to.styles.colors, |s| &s.id);
  merge_list(&mut out.styles.texts, &from.styles.texts, &to.styles.texts, |s| &s.id);
  merge_collections(&mut out.variables, &from.variables, &to.variables);
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

/// Three-way merge of the serialised fields of one item: each field the step changed
/// (`from` to `to`) takes `to`'s value unless `cur` has since given it another one. `deep`
/// also merges inside nested objects (a layer's layout, a variable's per-mode values), key by
/// key; arrays are taken whole, and a text's characters and runs go together.
fn merge_fields<T: Serialize + DeserializeOwned>(cur: &T, from: &T, to: &T, deep: bool) -> Option<T> {
  let (Ok(c), Ok(f), Ok(t)) = (serde_json::to_value(cur), serde_json::to_value(from), serde_json::to_value(to)) else {
    return None;
  };
  serde_json::from_value(merge_json(&c, &f, &t, deep)).ok()
}

fn merge_json(cur: &Value, from: &Value, to: &Value, deep: bool) -> Value {
  let (Some(c), Some(f), Some(t)) = (cur.as_object(), from.as_object(), to.as_object()) else {
    return if same(cur, from) { to.clone() } else { cur.clone() };
  };
  let mut out = c.clone();
  // Run ranges index into the characters: keep both of someone else's, or take both of ours.
  let text_theirs = ["characters", "runs"].iter().any(|k| !same_opt(c.get(*k), f.get(*k)));
  for k in c.keys().chain(f.keys()).chain(t.keys()).collect::<BTreeSet<_>>() {
    let (cv, fv, tv) = (c.get(k), f.get(k), t.get(k));
    if same_opt(fv, tv) || (text_theirs && (k == "characters" || k == "runs") && c.contains_key("characters")) {
      continue; // this step left it alone, or someone else changed this text
    }
    let merged = if k == "children" {
      Some(merge_children(cv, fv, tv))
    } else if let (true, Some(cv), Some(fv), Some(tv)) = (deep, cv, fv, tv) {
      (cv.is_object() && fv.is_object() && tv.is_object()).then(|| merge_json(cv, fv, tv, true))
    } else {
      None
    };
    match merged {
      Some(v) => {
        out.insert(k.clone(), v);
      }
      None if same_opt(cv, fv) => match tv {
        Some(v) => {
          out.insert(k.clone(), v.clone());
        }
        None => {
          out.remove(k);
        }
      },
      None => {} // someone else's newer value stays
    }
  }
  Value::Object(out)
}

/// Child lists: `to`'s order, plus children `cur` has that neither `from` nor `to` knew (added
/// by others meanwhile). `repair` drops the ones that no longer belong.
fn merge_children(cur: Option<&Value>, from: Option<&Value>, to: Option<&Value>) -> Value {
  let list = |v: Option<&Value>| v.and_then(|v| v.as_array()).cloned().unwrap_or_default();
  let (cur, from, mut out) = (list(cur), list(from), list(to));
  let theirs: Vec<Value> = cur.iter().filter(|c| !from.contains(c) && !out.contains(c)).cloned().collect();
  out.extend(theirs);
  Value::Array(out)
}

/// Keyed lists (pages, styles): items the step added are removed, items it removed come back
/// at their old place, and items it edited are merged field by field. Items others added are
/// left alone.
fn merge_list<T: Serialize + DeserializeOwned + Clone + PartialEq>(cur: &mut Vec<T>, from: &[T], to: &[T], id: impl Fn(&T) -> &String) {
  if from == to {
    return;
  }
  let at = |list: &[T], k: &String| list.iter().position(|x| id(x) == k);
  for f in from {
    if at(to, id(f)).is_none() {
      cur.retain(|x| id(x) != id(f));
    }
  }
  for (i, t) in to.iter().enumerate() {
    match (at(from, id(t)), at(cur, id(t))) {
      (None, None) => cur.insert(i.min(cur.len()), t.clone()),
      (Some(fi), Some(ci)) if from[fi] != *t => {
        if let Some(m) = merge_fields(&cur[ci], &from[fi], t, true) {
          cur[ci] = m;
        }
      }
      _ => {}
    }
  }
}

/// Variable collections: like `merge_list`, with each collection's variables merged by id too.
fn merge_collections(cur: &mut Vec<Collection>, from: &[Collection], to: &[Collection]) {
  if from == to {
    return;
  }
  // Variables of collections that exist on every side are merged on their own; the
  // collections are then merged without them.
  let mut merged: BTreeMap<String, Vec<Variable>> = BTreeMap::new();
  for t in to {
    if let (Some(f), Some(c)) = (from.iter().find(|f| f.id == t.id), cur.iter().find(|c| c.id == t.id)) {
      let mut vars = c.variables.clone();
      merge_list(&mut vars, &f.variables, &t.variables, |v| &v.id);
      merged.insert(t.id.clone(), vars);
    }
  }
  let bare = |l: &[Collection]| -> Vec<Collection> { l.iter().cloned().map(|c| Collection { variables: vec![], ..c }).collect() };
  let mut out = bare(cur);
  merge_list(&mut out, &bare(from), &bare(to), |c| &c.id);
  for c in out.iter_mut() {
    c.variables = match merged.remove(&c.id) {
      Some(v) => v,
      None => match (cur.iter().find(|x| x.id == c.id), to.iter().find(|x| x.id == c.id)) {
        (Some(x), _) => x.variables.clone(),
        (None, Some(t)) => t.variables.clone(),
        _ => vec![],
      },
    };
  }
  *cur = out;
}

/// Equal, with numbers compared within a rounding error (layout re-runs can nudge a value by
/// a hair).
fn same(a: &Value, b: &Value) -> bool {
  match (a, b) {
    (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
      (Some(x), Some(y)) => (x - y).abs() <= 1e-6 * x.abs().max(y.abs()).max(1.0),
      _ => x == y,
    },
    (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
    (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
    _ => a == b,
  }
}

/// `same` for properties that may be missing (`null` counts as missing).
fn same_opt(a: Option<&Value>, b: Option<&Value>) -> bool {
  match (a, b) {
    (Some(a), Some(b)) => same(a, b),
    (None, None) | (Some(Value::Null), None) | (None, Some(Value::Null)) => true,
    _ => false,
  }
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
    let da = delta(&base, &a.doc, true, true);
    let db = delta(&base, &b.doc, true, true);
    apply(&mut a.doc, &db).unwrap();
    apply(&mut b.doc, &da).unwrap();
    for d in [&a.doc, &b.doc] {
      let kids = &d.get(&frame).unwrap().children;
      assert!(kids.contains(&ra) && kids.contains(&rb), "{kids:?}");
    }
  }

  #[test]
  fn export_rows_travel_to_peers_and_undo_removes_them() {
    let mut a = engine(1);
    let r = rect(&mut a, 0.0, None);
    let mut b = engine(2);
    b.load(&a.to_json()).unwrap();
    let base = a.doc.clone();
    let rows = json!([{ "format": "png", "scale": 2, "suffix": "" }, { "format": "jpg", "scale": 1, "suffix": "-w", "width": 512 }]);
    a.dispatch(Command::Update {
      ids: vec![r.clone()],
      patch: json!({ "exportSettings": rows }),
    })
    .unwrap();
    let d = delta(&base, &a.doc, true);
    apply(&mut b.doc, &d).unwrap();
    assert_eq!(b.doc.get(&r).unwrap().export_settings, a.doc.get(&r).unwrap().export_settings);
    assert_eq!(b.doc.get(&r).unwrap().export_settings.len(), 2);
    // Removing the rows leaves the key out of the node; the peer must clear them too.
    let with_rows = a.doc.clone();
    a.dispatch(Command::Update {
      ids: vec![r.clone()],
      patch: json!({ "exportSettings": [] }),
    })
    .unwrap();
    apply(&mut b.doc, &delta(&with_rows, &a.doc, true)).unwrap();
    assert!(b.doc.get(&r).unwrap().export_settings.is_empty());
    a.dispatch(Command::Undo).unwrap();
    assert_eq!(a.doc.get(&r).unwrap().export_settings.len(), 2);
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
      delta: delta(&base_b, &b.doc, true, true),
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
          // Seeds differ in more than the low bit (the id generator ignores it).
          let mut e = engine(10 + 2 * i as u64);
          e.load(&json).unwrap();
          e.collab_reset(true, true);
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

  /// Delivers editor `from`'s pending changes to everyone, as the relay would, in order.
  fn sync(room: &mut Room, from: usize) {
    for m in room.send(from) {
      room.receive(m);
    }
  }

  fn colour(e: &Engine, id: &str) -> String {
    match &e.doc.get(id).unwrap().fills[0] {
      crate::model::Paint::Solid { color, .. } => color.clone(),
      _ => panic!("not solid"),
    }
  }

  fn fill(c: &str) -> Value {
    json!([{ "type": "solid", "color": c }])
  }

  #[test]
  fn undo_skips_property_changed_by_peer_later() {
    let (mut room, id) = Room::new(2);
    set(&mut room.editors[0], &id, json!({ "fills": fill("#FF0000"), "x": 10.0 }));
    sync(&mut room, 0);
    set(&mut room.editors[1], &id, json!({ "fills": fill("#0000FF") }));
    sync(&mut room, 1);
    room.editors[0].dispatch(Command::Undo).unwrap();
    sync(&mut room, 0);
    room.assert_converged();
    assert_eq!(colour(&room.editors[0], &id), "#0000FF", "the peer's newer fill survives my undo");
    assert_eq!(room.editors[0].doc.get(&id).unwrap().x, 0.0, "what only I changed is undone");
  }

  #[test]
  fn redo_skips_property_changed_by_peer_later() {
    let (mut room, id) = Room::new(2);
    set(&mut room.editors[0], &id, json!({ "fills": fill("#FF0000") }));
    sync(&mut room, 0);
    room.editors[0].dispatch(Command::Undo).unwrap();
    sync(&mut room, 0);
    set(&mut room.editors[1], &id, json!({ "fills": fill("#0000FF") }));
    sync(&mut room, 1);
    room.editors[0].dispatch(Command::Redo).unwrap();
    sync(&mut room, 0);
    room.assert_converged();
    assert_eq!(colour(&room.editors[0], &id), "#0000FF");
  }

  #[test]
  fn undo_is_exact_when_nobody_else_edited() {
    let mut e = engine(1);
    let id = rect(&mut e, 0.0, None);
    let before = e.doc.clone();
    set(&mut e, &id, json!({ "x": 37.5, "fills": fill("#123456"), "opacity": 0.3 }));
    let after = e.doc.clone();
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc, before);
    e.dispatch(Command::Redo).unwrap();
    assert_eq!(e.doc, after);
  }

  #[test]
  fn undo_after_layout_rounding_still_reverts() {
    let mut e = engine(1);
    let id = rect(&mut e, 0.0, None);
    set(&mut e, &id, json!({ "x": 50.0 }));
    // A relayout or a peer's merge nudged the value by a rounding error.
    e.doc.get_mut(&id).unwrap().x = 50.0 + 1e-9;
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 0.0);
    // A real change by someone else is not mistaken for rounding.
    set(&mut e, &id, json!({ "x": 60.0 }));
    e.doc.get_mut(&id).unwrap().x = 61.0;
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 61.0);
  }

  #[test]
  fn undo_keeps_a_peers_edit_inside_the_same_object() {
    let (mut room, id) = Room::new(2);
    set(&mut room.editors[0], &id, json!({ "layout": { "gap": 10.0, "paddingTop": 10.0 } }));
    sync(&mut room, 0);
    set(&mut room.editors[0], &id, json!({ "layout": { "gap": 33.0 } }));
    sync(&mut room, 0);
    set(&mut room.editors[1], &id, json!({ "layout": { "paddingTop": 41.0 } }));
    sync(&mut room, 1);
    room.editors[0].dispatch(Command::Undo).unwrap();
    sync(&mut room, 0);
    room.assert_converged();
    let l = room.doc.get(&id).unwrap().layout.clone().unwrap();
    assert_eq!((l.gap, l.padding_top), (10.0, 41.0), "my gap is undone, their padding stays");
  }

  #[test]
  fn undo_text_edit_with_a_peer_style_change_in_the_same_text() {
    let mut a = engine(1);
    let id = a
      .dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "Hello".into(),
        parent: None,
      })
      .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    let json = a.to_json();
    let mut b = engine(12);
    b.load(&json).unwrap();
    let mut room = Room {
      doc: a.doc.clone(),
      editors: vec![a, b],
    };
    for e in room.editors.iter_mut() {
      e.collab_reset(true, true);
    }
    set(&mut room.editors[0], &id, json!({ "text": { "characters": "Goodbye" } }));
    sync(&mut room, 0);
    set(&mut room.editors[1], &id, json!({ "text": { "fontSize": 40.0 } }));
    sync(&mut room, 1);
    room.editors[0].dispatch(Command::Undo).unwrap();
    let t = room.editors[0].doc.get(&id).unwrap().text.clone().unwrap();
    assert_eq!((t.characters.as_str(), t.font_size), ("Hello", 40.0));
  }

  #[test]
  fn undo_style_edit_keeps_peer_added_style() {
    let (mut room, _) = Room::new(2);
    let add = |name: &str, color: &str| Command::AddColorStyle {
      name: name.into(),
      color: color.into(),
    };
    room.editors[0].dispatch(add("Mine", "#111111")).unwrap();
    sync(&mut room, 0);
    let mine = room.editors[0].doc.styles.colors[0].id.clone();
    room.editors[0]
      .dispatch(Command::UpdateColorStyle {
        id: mine.clone(),
        name: None,
        color: Some("#222222".into()),
      })
      .unwrap();
    sync(&mut room, 0);
    room.editors[1].dispatch(add("Theirs", "#333333")).unwrap();
    sync(&mut room, 1);
    room.editors[0].dispatch(Command::Undo).unwrap();
    let styles = &room.editors[0].doc.styles.colors;
    assert_eq!(styles.len(), 2, "the peer's style is still there");
    assert_eq!(styles.iter().find(|s| s.id == mine).unwrap().color, "#111111");
    assert!(styles.iter().any(|s| s.name == "Theirs"));
    // Undoing the creation removes only my style.
    room.editors[0].dispatch(Command::Undo).unwrap();
    let names: Vec<&str> = room.editors[0].doc.styles.colors.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Theirs"]);
  }

  #[test]
  fn undo_variable_edit_keeps_peer_added_variable() {
    use crate::variables::{Collection, VarMode, Variable};
    let var = |id: &str, v: f64| Variable {
      id: id.into(),
      name: id.into(),
      values: [("m".to_string(), json!(v))].into_iter().collect(),
      ..Default::default()
    };
    let coll = |vars: Vec<Variable>| Collection {
      id: "c".into(),
      name: "C".into(),
      modes: vec![VarMode {
        id: "m".into(),
        name: "Mode".into(),
      }],
      variables: vars,
    };
    let set_vars = |room: &mut Room, i: usize, vars: Vec<Variable>| {
      room.editors[i]
        .dispatch(Command::SetVariables {
          collections: vec![coll(vars)],
        })
        .unwrap();
      sync(room, i);
    };
    let (mut room, _) = Room::new(2);
    set_vars(&mut room, 0, vec![var("a", 1.0)]);
    set_vars(&mut room, 0, vec![var("a", 2.0)]);
    set_vars(&mut room, 1, vec![var("a", 2.0), var("b", 9.0)]);
    room.editors[0].dispatch(Command::Undo).unwrap();
    let vars = &room.editors[0].doc.variables[0].variables;
    assert_eq!(vars.len(), 2, "the peer's variable survives");
    assert_eq!(vars[0].values["m"], json!(1.0), "my edit is undone");
  }

  /// Both editors send at the same moment; each hears the other's change before its own ack.
  fn concurrent(room: &mut Room) {
    let from_a = room.send(0);
    let from_b = room.send(1);
    for m in [from_b[0].clone(), from_a[0].clone(), from_a[1].clone(), from_b[1].clone()] {
      room.receive(m);
    }
  }

  fn assert_documents_converged(room: &Room) {
    for e in &room.editors {
      assert_eq!(e.doc.pages, room.doc.pages);
      assert_eq!(e.doc.styles, room.doc.styles);
      assert_eq!(e.doc.variables, room.doc.variables);
    }
  }

  #[test]
  fn concurrent_edits_to_different_styles_both_survive() {
    let (mut room, _) = Room::new(2);
    for i in 0..2 {
      room.editors[0]
        .dispatch(Command::AddColorStyle {
          name: format!("Colour {i}"),
          color: "#111111".into(),
        })
        .unwrap();
    }
    sync(&mut room, 0);
    let ids: Vec<String> = room.editors[0].doc.styles.colors.iter().map(|s| s.id.clone()).collect();
    let text = room.editors[0]
      .dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "Body".into(),
        parent: None,
      })
      .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    room.editors[0]
      .dispatch(Command::AddTextStyle {
        name: "Body".into(),
        from: text,
      })
      .unwrap();
    sync(&mut room, 0);
    let body = room.editors[0].doc.styles.texts[0].id.clone();
    room.editors[0]
      .dispatch(Command::UpdateColorStyle {
        id: ids[0].clone(),
        name: None,
        color: Some("#AA0000".into()),
      })
      .unwrap();
    room.editors[1]
      .dispatch(Command::UpdateColorStyle {
        id: ids[1].clone(),
        name: Some("Renamed".into()),
        color: None,
      })
      .unwrap();
    // A third change by B at the same moment: a new style.
    room.editors[1]
      .dispatch(Command::AddColorStyle {
        name: "Third".into(),
        color: "#333333".into(),
      })
      .unwrap();
    concurrent(&mut room);
    assert_documents_converged(&room);
    let c = &room.doc.styles.colors;
    assert_eq!(c.len(), 3);
    assert_eq!(c.iter().find(|s| s.id == ids[0]).unwrap().color, "#AA0000");
    assert_eq!(c.iter().find(|s| s.id == ids[1]).unwrap().name, "Renamed");
    assert!(c.iter().any(|s| s.name == "Third"));
    assert_eq!(room.doc.styles.texts[0].id, body);
    // One person deleting a style while the other edits another one.
    room.editors[0].dispatch(Command::DeleteStyle { id: ids[0].clone() }).unwrap();
    room.editors[1]
      .dispatch(Command::UpdateColorStyle {
        id: ids[1].clone(),
        name: None,
        color: Some("#00BB00".into()),
      })
      .unwrap();
    concurrent(&mut room);
    assert_documents_converged(&room);
    assert_eq!(room.doc.styles.colors.len(), 2);
    assert_eq!(room.doc.styles.colors.iter().find(|s| s.id == ids[1]).unwrap().color, "#00BB00");
  }

  fn variable(id: &str, values: &[(&str, f64)]) -> Variable {
    Variable {
      id: id.into(),
      name: id.into(),
      values: values.iter().map(|(m, v)| (m.to_string(), json!(v))).collect(),
      ..Default::default()
    }
  }

  fn collection(id: &str, vars: Vec<Variable>) -> Collection {
    Collection {
      id: id.into(),
      name: id.into(),
      modes: ["m1", "m2"]
        .iter()
        .map(|m| crate::variables::VarMode {
          id: m.to_string(),
          name: m.to_string(),
        })
        .collect(),
      variables: vars,
    }
  }

  #[test]
  fn concurrent_edits_to_different_variables_and_modes_both_survive() {
    let (mut room, _) = Room::new(2);
    room.editors[0]
      .dispatch(Command::SetVariables {
        collections: vec![
          collection(
            "c1",
            vec![variable("a", &[("m1", 1.0), ("m2", 1.0)]), variable("b", &[("m1", 1.0)])],
          ),
          collection("c2", vec![variable("x", &[("m1", 1.0)])]),
        ],
      })
      .unwrap();
    sync(&mut room, 0);
    let edit = |room: &mut Room, i: usize, f: &dyn Fn(&mut Vec<Collection>)| {
      let mut cs = room.editors[i].doc.variables.clone();
      f(&mut cs);
      room.editors[i].dispatch(Command::SetVariables { collections: cs }).unwrap();
    };
    // Different variables, and different modes of one variable, and a different collection.
    edit(&mut room, 0, &|cs| {
      cs[0].variables[0].values.insert("m1".into(), json!(5.0));
      cs[1].variables.push(variable("y", &[("m1", 7.0)]));
    });
    edit(&mut room, 1, &|cs| {
      cs[0].variables[0].values.insert("m2".into(), json!(6.0));
      cs[0].variables[1].values.insert("m1".into(), json!(8.0));
      cs[0].variables.push(variable("c", &[("m1", 3.0)]));
    });
    concurrent(&mut room);
    assert_documents_converged(&room);
    let c1 = &room.doc.variables[0].variables;
    assert_eq!(c1[0].values["m1"], json!(5.0));
    assert_eq!(c1[0].values["m2"], json!(6.0));
    assert_eq!(c1[1].values["m1"], json!(8.0));
    assert_eq!(c1.len(), 3, "the new variable is kept");
    assert_eq!(room.doc.variables[1].variables.len(), 2);
    // A removed mode value and a removed variable.
    edit(&mut room, 0, &|cs| {
      cs[0].variables[0].values.remove("m2");
    });
    edit(&mut room, 1, &|cs| {
      cs[0].variables.retain(|v| v.id != "b");
      cs[1].name = "Renamed".into();
    });
    concurrent(&mut room);
    assert_documents_converged(&room);
    assert!(!room.doc.variables[0].variables[0].values.contains_key("m2"));
    assert_eq!(room.doc.variables[0].variables.len(), 2);
    assert_eq!(room.doc.variables[1].name, "Renamed");
    // A new collection travels with its variables; a removed one is gone.
    edit(&mut room, 0, &|cs| cs.push(collection("c3", vec![variable("z", &[("m1", 2.0)])])));
    edit(&mut room, 1, &|cs| cs.retain(|c| c.id != "c2"));
    concurrent(&mut room);
    assert_documents_converged(&room);
    let ids: Vec<&str> = room.doc.variables.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["c1", "c3"]);
    assert_eq!(room.doc.variables[1].variables[0].id, "z");
  }

  #[test]
  fn concurrent_page_edits_keep_both_and_the_page_order() {
    let (mut room, _) = Room::new(2);
    for _ in 0..2 {
      room.editors[0].dispatch(Command::AddPage { name: None }).unwrap();
    }
    sync(&mut room, 0);
    let ids: Vec<String> = room.editors[0].doc.pages.iter().map(|p| p.id.clone()).collect();
    assert_eq!(ids.len(), 3);
    room.editors[0]
      .dispatch(Command::RenamePage {
        id: ids[0].clone(),
        name: "One".into(),
      })
      .unwrap();
    room.editors[1]
      .dispatch(Command::RenamePage {
        id: ids[1].clone(),
        name: "Two".into(),
      })
      .unwrap();
    room.editors[1]
      .dispatch(Command::SetPageBackground {
        id: ids[2].clone(),
        color: "#101010".into(),
      })
      .unwrap();
    concurrent(&mut room);
    assert_documents_converged(&room);
    let names: Vec<&str> = room.doc.pages.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(&names[..2], ["One", "Two"]);
    assert_eq!(room.doc.pages[2].background, "#101010");
    // One person reorders the pages while the other renames one.
    room.editors[0].doc.pages.swap(0, 2);
    room.editors[1]
      .dispatch(Command::RenamePage {
        id: ids[1].clone(),
        name: "Second".into(),
      })
      .unwrap();
    concurrent(&mut room);
    assert_documents_converged(&room);
    let order: Vec<&str> = room.doc.pages.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(order, [ids[2].as_str(), ids[1].as_str(), ids[0].as_str()]);
    assert_eq!(room.doc.pages[1].name, "Second");
  }

  #[test]
  fn whole_list_deltas_from_older_peers_still_apply() {
    let mut a = engine(1);
    let mut start = engine(2);
    start.load(&a.to_json()).unwrap();
    a.dispatch(Command::AddPage { name: Some("Old".into()) }).unwrap();
    a.dispatch(Command::AddColorStyle {
      name: "Brand".into(),
      color: "#123456".into(),
    })
    .unwrap();
    a.dispatch(Command::SetVariables {
      collections: vec![collection("c", vec![variable("v", &[("m1", 4.0)])])],
    })
    .unwrap();
    let base = start.doc.clone();
    let old = delta(&base, &a.doc, true, false);
    assert!(!is_granular(&old));
    for k in ["pages", "styles", "variables"] {
      assert!(old.get(k).is_some(), "{k}");
    }
    let mut b = engine(2);
    b.load(&start.to_json()).unwrap();
    apply(&mut b.doc, &old).unwrap();
    assert_eq!(
      (&b.doc.pages, &b.doc.styles, &b.doc.variables),
      (&a.doc.pages, &a.doc.styles, &a.doc.variables)
    );
    // The per-id form of the same change builds the same lists, and has none of the whole ones.
    let new = delta(&base, &a.doc, true, true);
    assert!(is_granular(&new));
    for k in ["pages", "styles", "variables"] {
      assert!(new.get(k).is_none(), "{k}");
    }
    let mut c = engine(3);
    c.load(&start.to_json()).unwrap();
    apply(&mut c.doc, &new).unwrap();
    assert_eq!(
      (&c.doc.pages, &c.doc.styles, &c.doc.variables),
      (&a.doc.pages, &a.doc.styles, &a.doc.variables)
    );
    // A relay hands older peers the whole lists of its merged document.
    let down = legacy(&new, &c.doc).unwrap();
    assert!(!is_granular(&down));
    let mut d = engine(4);
    d.load(&start.to_json()).unwrap();
    apply(&mut d.doc, &down).unwrap();
    assert_eq!(
      (&d.doc.pages, &d.doc.styles, &d.doc.variables),
      (&a.doc.pages, &a.doc.styles, &a.doc.variables)
    );
    assert!(legacy(&old, &c.doc).is_none());
    // Nothing changed: nothing sent, in either form.
    assert!(is_empty(&delta(&a.doc, &a.doc, true, true)));
  }

  #[test]
  fn a_granular_delta_only_names_what_changed() {
    let mut a = engine(1);
    for n in ["One", "Two"] {
      a.dispatch(Command::AddColorStyle {
        name: n.into(),
        color: "#111111".into(),
      })
      .unwrap();
    }
    let base = a.doc.clone();
    let id = a.doc.styles.colors[1].id.clone();
    a.dispatch(Command::UpdateColorStyle {
      id: id.clone(),
      name: None,
      color: Some("#222222".into()),
    })
    .unwrap();
    let d = delta(&base, &a.doc, true, true);
    assert_eq!(d["colorStyles"].as_object().unwrap().keys().collect::<Vec<_>>(), ["patch"]);
    assert_eq!(d["colorStyles"]["patch"].as_object().unwrap().keys().collect::<Vec<_>>(), [&id]);
    assert_eq!(d["colorStyles"]["patch"][&id], json!({ "color": "#222222" }));
    assert!(d.get("textStyles").is_none() && d.get("pageChanges").is_none() && d.get("collectionChanges").is_none());
  }

  #[test]
  fn undo_reorder_keeps_layers_a_peer_added_meanwhile() {
    let (mut room, first) = Room::new(2);
    let second = rect(&mut room.editors[0], 20.0, None);
    sync(&mut room, 0);
    room.editors[0]
      .dispatch(Command::Reorder {
        ids: vec![first.clone()],
        to: crate::ops::ReorderTo::Front,
      })
      .unwrap();
    sync(&mut room, 0);
    let theirs = rect(&mut room.editors[1], 40.0, None);
    sync(&mut room, 1);
    room.editors[0].dispatch(Command::Undo).unwrap();
    let page = room.editors[0].doc.page(&room.editors[0].page).unwrap();
    assert_eq!(page.children, [first.clone(), second, theirs], "old order back, their layer kept");
  }

  #[test]
  fn redo_restores_added_page_as_current() {
    let mut e = engine(1);
    let first = e.page.clone();
    e.dispatch(Command::AddPage { name: None }).unwrap();
    let added = e.page.clone();
    assert_ne!(first, added);
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.pages.len(), 1);
    assert_eq!(e.page, first);
    e.dispatch(Command::Redo).unwrap();
    assert_eq!(e.doc.pages.len(), 2);
    assert_eq!(e.page, added, "the page that was added is current again");
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
      delta: delta(&base_b, &b.doc, true, true),
      local: false,
    })
    .unwrap();
    assert!(!a.state()["canUndo"].as_bool().unwrap());
    assert!(is_empty(&a.collab_delta()), "applying a peer's change must not be sent back");
  }
}
