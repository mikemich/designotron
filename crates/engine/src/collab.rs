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

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::clipboard;
use crate::model::{arc_eq, arcs_eq, ColorStyle, Comment, Document, EffectStyle, GridStyle, Node, NodeId, TextStyle};
use crate::textseq;
use crate::variables::{Collection, Variable};

/// What `delta_with` writes: `patches` as per-property patches (peers that predate them get
/// whole nodes), `granular` pages, styles and variables per id, `lists` child orders as moves
/// and comments per message (see `moved`, `place` and `comment_changes`). `lists` needs both
/// others; a room says whether it takes it in its welcome. `text` (which needs `lists`) sends the
/// characters, runs and props of a text layer as per-character changes (`text`, see `textseq`)
/// instead of the whole `text` object.
#[derive(Clone, Copy, Debug, Default)]
pub struct DeltaOpts {
  pub patches: bool,
  pub granular: bool,
  pub lists: bool,
  pub text: bool,
}

/// `delta_with` without `lists`: the form every peer since per-id changes understands.
pub fn delta(base: &Document, doc: &Document, patches: bool, granular: bool) -> Value {
  delta_with(
    base,
    doc,
    DeltaOpts {
      patches,
      granular,
      lists: false,
      text: false,
    },
  )
}

/// Changes from `base` to `doc` as JSON: added nodes in full (`nodes`), changed ones as
/// per-property `patch`es (whole nodes when `patches` is false, for peers that predate
/// patches), removed nodes and comments, plus the document-level fields that differ
/// (name, pages, styles, variables). With `granular`, pages, styles and variables are sent
/// as per-id changes (`pageChanges`, `colorStyles`, `textStyles`, `effectStyles`, `gridStyles`,
/// `collectionChanges`, `variableChanges`: see `ListDelta`); otherwise as whole lists, for peers that predate them.
/// With `lists`, a child list that changed also says which children moved (`moves`, `pageMoves`:
/// the receiver places those relative to its own list), and a comment that exists on both sides
/// travels as the messages added and removed and the fields changed (`commentChanges`).
pub fn delta_with(base: &Document, doc: &Document, opts: DeltaOpts) -> Value {
  delta_hinted(base, doc, opts, &HashSet::new())
}

/// `delta_with`, with the layers the person moved on purpose (see `moved_hinted`).
pub fn delta_hinted(base: &Document, doc: &Document, opts: DeltaOpts, hint: &HashSet<NodeId>) -> Value {
  let DeltaOpts {
    patches,
    granular,
    lists,
    text,
  } = opts;
  let mut nodes = Map::new();
  let mut patch = Map::new();
  let mut texts = Map::new();
  let mut moves = Map::new();
  let mut removed = Vec::new();
  for item in base.nodes.diff(&doc.nodes) {
    match item {
      imbl::ordmap::DiffItem::Update { old: (_, o), new: (k, v) } if patches => {
        let mut p = node_patch(o, v);
        if lists && o.children != v.children {
          moves.insert(k.clone(), json!(moved_hinted(&o.children, &v.children, hint)));
        }
        // A text that merges per character travels as `text`, never whole in the patch.
        if text {
          if let Some(entry) = text_entry(doc, k, o, v) {
            p.remove("text");
            if entry.as_object().is_some_and(|e| e.len() > 1) {
              texts.insert(k.clone(), entry);
            }
            if p.is_empty() {
              continue;
            }
          }
        }
        patch.insert(k.clone(), Value::Object(p));
      }
      imbl::ordmap::DiffItem::Add(k, v) | imbl::ordmap::DiffItem::Update { new: (k, v), .. } => {
        nodes.insert(k.clone(), serde_json::to_value(v).unwrap_or(Value::Null));
      }
      imbl::ordmap::DiffItem::Remove(k, _) => removed.push(json!(k)),
    }
  }
  let mut comments = Map::new();
  let mut changes = Map::new();
  for (id, c) in doc.comments.iter() {
    let part = match base.comments.get(id) {
      Some(b) if b == c => continue,
      Some(b) if lists => comment_changes(b, c),
      _ => None,
    };
    match part {
      Some(p) => drop(changes.insert(id.clone(), p)),
      None => drop(comments.insert(id.clone(), serde_json::to_value(c).unwrap_or(Value::Null))),
    }
  }
  let comments_removed: Vec<&String> = base.comments.keys().filter(|k| !doc.comments.contains_key(*k)).collect();
  let mut out = json!({ "nodes": nodes, "removed": removed, "comments": comments, "commentsRemoved": comments_removed });
  let o = out.as_object_mut().unwrap();
  if !patch.is_empty() {
    o.insert("patch".into(), Value::Object(patch));
  }
  if !moves.is_empty() {
    o.insert("moves".into(), Value::Object(moves));
  }
  if !texts.is_empty() {
    o.insert("text".into(), Value::Object(texts));
  }
  if !changes.is_empty() {
    o.insert("commentChanges".into(), Value::Object(changes));
  }
  if base.name != doc.name {
    o.insert("name".into(), json!(doc.name));
  }
  if granular {
    granular_parts(base, doc, o);
    if lists {
      let mut page_moves = Map::new();
      for p in doc.pages.iter() {
        if let Some(b) = base.page(&p.id).filter(|b| b.children != p.children) {
          page_moves.insert(p.id.clone(), json!(moved_hinted(&b.children, &p.children, hint)));
        }
      }
      if !page_moves.is_empty() {
        o.insert("pageMoves".into(), Value::Object(page_moves));
      }
    }
  } else {
    if !arcs_eq(&base.pages, &doc.pages) {
      o.insert("pages".into(), json!(doc.pages));
    }
    if !arc_eq(&base.styles, &doc.styles) {
      o.insert("styles".into(), json!(doc.styles));
    }
    if !arcs_eq(&base.variables, &doc.variables) {
      o.insert("variables".into(), json!(doc.variables));
    }
  }
  out
}

/// This engine can read and write text layers as per-character changes (the `text` part of a room's
/// welcome; see `DeltaOpts` and `textseq`).
pub const TEXT: bool = true;

/// The per-character change of the text layer `id` from `old` to `new`, when it has one: both have
/// text, it isn't inside an instance (those overrides stay whole) and the two share an epoch.
fn text_entry(doc: &Document, id: &str, old: &Node, new: &Node) -> Option<Value> {
  let (ot, nt) = (old.text.as_ref()?, new.text.as_ref()?);
  if ot == nt || doc.instance_ancestor(id).is_some() {
    return None;
  }
  textseq::ops(ot, nt)
}

/// A delta in the form peers that predate `text` understand: every `text` entry becomes the layer's
/// whole text from `doc` (the room's document, after applying the delta) in `patch`, without its
/// sequence. `None` when `d` has no `text`.
pub fn legacy_text(d: &Value, doc: &Document) -> Option<Value> {
  let texts = d.get("text")?.as_object()?;
  let mut out = d.clone();
  let o = out.as_object_mut()?;
  o.remove("text");
  let patch = o.entry("patch").or_insert_with(|| json!({})).as_object_mut()?;
  for id in texts.keys() {
    let Some(t) = doc.get(id).and_then(|n| n.text.as_ref()) else {
      continue;
    };
    let mut v = serde_json::to_value(t).ok()?;
    v.as_object_mut()?.remove("seq");
    match patch.get_mut(id).and_then(|p| p.as_object_mut()) {
      Some(p) => drop(p.insert("text".into(), v)),
      None => drop(patch.insert(id.clone(), json!({ "text": v }))),
    }
  }
  Some(out)
}

/// Which generation of the document model this build understands. Rooms say it in their welcome, so
/// an editor can tell a relay that predates the model it uses (older relays say nothing).
pub const MODEL_REVISION: u32 = 4;

/// `value` (a delta or a document, as JSON) rewritten so a relay that understands only model
/// `relay_model` can store it: values it has no names for are replaced by the closest old one
/// (angular and diamond gradients become radial, cropped images fill, Move in, Move out and Push
/// become the slide in their direction, hover/press/up triggers become the old ones) and what has
/// no old equivalent (mouse leave and key triggers, Change to) is dropped. Old relays reject a
/// whole change that holds an unknown name, so this is applied to what is *sent* only, never to
/// the editor's own copy. Works on names alone, anywhere in the JSON (fills, strokes, styles,
/// instance overrides, patches). A relay at this build's model gets `value` back unchanged.
///
/// The rewrites are layered by revision: below 3 the ones above; below 4 also the On drag trigger
/// (dropped: it has no old equivalent) and sticky scrolling (shown as scroll). `bezier` stays,
/// older code ignores it and plays `easing`.
pub fn downgrade(value: &Value, relay_model: u32) -> Value {
  let mut v = value.clone();
  if relay_model < MODEL_REVISION {
    downgrade_in_place(&mut v, relay_model);
  }
  v
}

/// `downgrade` in place, for a value the caller owns (no copy). A model at this build's is left alone.
pub fn downgrade_value(v: &mut Value, relay_model: u32) {
  if relay_model < MODEL_REVISION {
    downgrade_in_place(v, relay_model);
  }
}

fn downgrade_in_place(v: &mut Value, model: u32) {
  match v {
    Value::Array(a) => a.iter_mut().for_each(|x| downgrade_in_place(x, model)),
    Value::Object(o) => {
      if o.get("scrollBehavior").and_then(Value::as_str) == Some("sticky") {
        o.insert("scrollBehavior".into(), json!("scroll"));
      }
      if model < 3 && matches!(o.get("type").and_then(Value::as_str), Some("angularGradient" | "diamondGradient")) {
        o.insert("type".into(), json!("radialGradient"));
        o.remove("handles");
      }
      if model < 3 && o.get("scaleMode").and_then(Value::as_str) == Some("crop") {
        o.insert("scaleMode".into(), json!("fill"));
        o.remove("crop");
      }
      if let Some(Value::Array(list)) = o.get_mut("interactions") {
        *list = std::mem::take(list)
          .into_iter()
          .filter_map(|i| downgrade_interaction(i, model))
          .collect();
      }
      o.values_mut().for_each(|x| downgrade_in_place(x, model));
    }
    _ => {}
  }
}

/// An interaction as an old relay knows it, or None when it has no old equivalent.
fn downgrade_interaction(mut i: Value, model: u32) -> Option<Value> {
  let o = i.as_object_mut()?;
  let name = |o: &Map<String, Value>, k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
  if name(o, "trigger").as_deref() == Some("onDrag") {
    return None;
  }
  if model >= 3 {
    return Some(i);
  }
  match name(o, "trigger").as_deref() {
    Some("mouseLeave" | "key") => return None,
    Some("mouseEnter") => drop(o.insert("trigger".into(), json!("onHover"))),
    Some("mouseDown") => drop(o.insert("trigger".into(), json!("onPress"))),
    Some("mouseUp") => drop(o.insert("trigger".into(), json!("onClick"))),
    _ => {}
  }
  if name(o, "action").as_deref() == Some("changeTo") {
    return None;
  }
  if matches!(name(o, "transition").as_deref(), Some("moveIn" | "moveOut" | "push")) {
    // The direction defaults to left (see `Direction`).
    let slide = match name(o, "direction").as_deref() {
      None | Some("left") => "slideLeft",
      Some("right") => "slideRight",
      Some("up") => "slideUp",
      Some("down") => "slideDown",
      Some(_) => "dissolve",
    };
    o.insert("transition".into(), json!(slide));
  }
  Some(i)
}

/// This engine can read and write the per-id form of pages, styles and variables.
pub const GRANULAR: bool = true;

/// The wire keys of the per-id form of pages, styles and variables.
const GRANULAR_KEYS: [&str; 7] = [
  "pageChanges",
  "colorStyles",
  "textStyles",
  "effectStyles",
  "gridStyles",
  "collectionChanges",
  "variableChanges",
];

/// True when a delta uses the per-id form of pages, styles or variables.
pub fn is_granular(d: &Value) -> bool {
  GRANULAR_KEYS.iter().any(|k| d.get(*k).is_some())
}

/// A whole-`styles` delta from an editor that predates effect and grid styles lacks both lists, and
/// applying it would empty the room's. Puts the document's lists into it; true when it changed `d`.
pub fn keep_style_lists(d: &mut Value, doc: &Document) -> bool {
  let Some(styles) = d.get_mut("styles").and_then(|s| s.as_object_mut()) else {
    return false;
  };
  let mut changed = false;
  if !styles.contains_key("effects") && !doc.styles.effects.is_empty() {
    styles.insert("effects".into(), json!(doc.styles.effects));
    changed = true;
  }
  if !styles.contains_key("grids") && !doc.styles.grids.is_empty() {
    styles.insert("grids".into(), json!(doc.styles.grids));
    changed = true;
  }
  changed
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
  let styles = has(o, &["colorStyles", "textStyles", "effectStyles", "gridStyles"]);
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

/// This engine can read and write child orders as moves and comments per message (the `lists`
/// part of a room's welcome; see `DeltaOpts`).
pub const LISTS: bool = true;

/// The ids of `new` that moved relative to `base`: the ones `base` lacks, and the ones not on a
/// longest run of ids that kept their relative order. In `new` order. Taking one layer to the
/// back gives just that layer. Which of two equally long runs stays is arbitrary, so the editor
/// says which layers the person moved (`moved_hinted`).
pub fn moved(base: &[NodeId], new: &[NodeId]) -> Vec<NodeId> {
  moved_hinted(base, new, &HashSet::new())
}

/// `moved`, with the layers a command or drag moved (`hint`: Bring forward, Send backward, a drop
/// in Layers) as the tie-break between runs of equal length. Moving one layer a step is also a
/// neighbour "moving" the other way round, and which of the two counts is arbitrary without it:
/// with the hint the run that stays keeps the most layers nobody moved on purpose. The set is
/// still the smallest there is (the longest run stays), so nothing a command didn't move is
/// re-placed, and `place(base, new, M)` is `new` for it.
pub fn moved_hinted(base: &[NodeId], new: &[NodeId], hint: &HashSet<NodeId>) -> Vec<NodeId> {
  let pos: HashMap<&str, usize> = base.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
  // (index in `new`, position in `base`) of the ids both lists hold.
  let seq: Vec<(usize, usize)> = new
    .iter()
    .enumerate()
    .filter_map(|(i, id)| pos.get(id.as_str()).map(|&p| (i, p)))
    .collect();
  let mut prev: Vec<Option<usize>> = vec![None; seq.len()];
  let last;
  if hint.is_empty() {
    // Longest increasing run of base positions (patience sorting, O(n log n)).
    let mut tails: Vec<usize> = Vec::new();
    for (k, &(_, p)) in seq.iter().enumerate() {
      let at = tails.partition_point(|&t| seq[t].1 < p);
      if at > 0 {
        prev[k] = Some(tails[at - 1]);
      }
      if at == tails.len() {
        tails.push(k);
      } else {
        tails[at] = k;
      }
    }
    last = tails.last().copied();
  } else {
    // The same run, weighted: length first, then the number of layers nobody moved on purpose
    // (a Fenwick tree of the best chain ending at or before each base position).
    let big = seq.len() as u64 + 1;
    let weight = |k: usize| big + u64::from(!hint.contains(&new[seq[k].0]));
    let m = base.len();
    let mut tree: Vec<(u64, usize)> = vec![(0, usize::MAX); m + 1];
    let mut best: Vec<u64> = vec![0; seq.len()];
    let mut top: Option<usize> = None;
    for (k, &(_, p)) in seq.iter().enumerate() {
      // Best chain among base positions below `p`.
      let (mut w, mut from) = (0, usize::MAX);
      let mut i = p;
      while i > 0 {
        if tree[i].0 > w {
          (w, from) = tree[i];
        }
        i -= i & i.wrapping_neg();
      }
      prev[k] = (from != usize::MAX).then_some(from);
      best[k] = w + weight(k);
      let mut i = p + 1;
      while i <= m {
        if best[k] > tree[i].0 {
          tree[i] = (best[k], k);
        }
        i += i & i.wrapping_neg();
      }
      if top.is_none_or(|t| best[k] > best[t]) {
        top = Some(k);
      }
    }
    last = top;
  }
  let mut stay: HashSet<usize> = HashSet::new();
  let mut at = last;
  while let Some(k) = at {
    stay.insert(seq[k].0);
    at = prev[k];
  }
  new
    .iter()
    .enumerate()
    .filter(|(i, _)| !stay.contains(i))
    .map(|(_, id)| id.clone())
    .collect()
}

/// `cur` with the ids in `moved` taken out and put back where `reference` (the mover's list)
/// has them, relative to everything else `cur` holds:
/// - the leading run of `reference` that is all moved goes to the start, in order (sent to the
///   back), and the trailing run to the end (brought to the front);
/// - any other moved id goes right after the nearest preceding `reference` sibling `cur` has,
///   else before the nearest following one, else to the end.
///
/// Ids of `cur` that `reference` doesn't know (added by others meanwhile) keep their places.
/// Deterministic, so every peer that applies the same moves to the same list gets the same
/// order. With `cur` equal to the mover's base and `reference` its new list the result is
/// exactly `reference`.
pub fn place(cur: &[NodeId], reference: &[NodeId], moved: &[NodeId]) -> Vec<NodeId> {
  let in_ref: HashSet<&str> = reference.iter().map(String::as_str).collect();
  let mset: HashSet<&str> = moved.iter().map(String::as_str).filter(|m| in_ref.contains(m)).collect();
  let mut seen: HashSet<&str> = HashSet::new();
  let working: Vec<&NodeId> = cur
    .iter()
    .filter(|c| !mset.contains(c.as_str()) && seen.insert(c.as_str()))
    .collect();
  if mset.is_empty() {
    return working.into_iter().cloned().collect();
  }
  let n = reference.len();
  let is_moved = |i: usize| mset.contains(reference[i].as_str());
  let lead = (0..n).take_while(|&i| is_moved(i)).count();
  let tail = if lead == n {
    0
  } else {
    (0..n).rev().take_while(|&i| is_moved(i)).count()
  };
  // Nothing is inserted into a vector: each moved id is hung on the id it follows (or precedes),
  // and the result is written out once, in O(n + moved).
  let mut present: HashSet<&str> = working.iter().map(|w| w.as_str()).collect();
  let mut placed: HashSet<&str> = HashSet::new();
  let mut after: HashMap<&str, Vec<&NodeId>> = HashMap::new();
  let mut before: HashMap<&str, Vec<&NodeId>> = HashMap::new();
  let mut front: Vec<&NodeId> = Vec::new();
  let mut end: Vec<&NodeId> = Vec::new();
  for r in &reference[..lead] {
    if placed.insert(r.as_str()) {
      present.insert(r.as_str());
      front.push(r);
    }
  }
  for i in lead..n - tail {
    if !is_moved(i) || !placed.insert(reference[i].as_str()) {
      continue;
    }
    let id = &reference[i];
    let anchor = (0..i).rev().find(|&j| present.contains(reference[j].as_str()));
    match anchor {
      Some(j) => after.entry(reference[j].as_str()).or_default().insert(0, id),
      None => match (i + 1..n).find(|&k| present.contains(reference[k].as_str())) {
        Some(k) => before.entry(reference[k].as_str()).or_default().push(id),
        None => end.push(id),
      },
    }
    present.insert(id.as_str());
  }
  let mut tail_ids: Vec<&NodeId> = Vec::new();
  for r in &reference[n - tail..] {
    if placed.insert(r.as_str()) {
      tail_ids.push(r);
    }
  }
  enum Todo<'a> {
    Expand(&'a NodeId),
    Out(&'a NodeId),
  }
  let mut out: Vec<NodeId> = Vec::with_capacity(working.len() + front.len() + end.len() + tail_ids.len());
  let roots: Vec<&NodeId> = front.into_iter().chain(working).chain(end).chain(tail_ids).collect();
  let mut stack: Vec<Todo> = roots.into_iter().rev().map(Todo::Expand).collect();
  while let Some(t) = stack.pop() {
    match t {
      Todo::Out(id) => out.push(id.clone()),
      Todo::Expand(id) => {
        stack.extend(after.get(id.as_str()).into_iter().flatten().rev().map(|x| Todo::Expand(x)));
        stack.push(Todo::Out(id));
        stack.extend(before.get(id.as_str()).into_iter().flatten().rev().map(|x| Todo::Expand(x)));
      }
    }
  }
  out
}

/// The first, slower `place` (a vector with inserts); the tests compare the two.
#[cfg(test)]
fn place_slow(cur: &[NodeId], reference: &[NodeId], moved: &[NodeId]) -> Vec<NodeId> {
  let in_ref: HashSet<&str> = reference.iter().map(String::as_str).collect();
  let mset: HashSet<&str> = moved.iter().map(String::as_str).filter(|m| in_ref.contains(m)).collect();
  let mut seen: HashSet<&str> = HashSet::new();
  let mut working: Vec<NodeId> = cur
    .iter()
    .filter(|c| !mset.contains(c.as_str()) && seen.insert(c.as_str()))
    .cloned()
    .collect();
  if mset.is_empty() {
    return working;
  }
  let n = reference.len();
  let is_moved = |i: usize| mset.contains(reference[i].as_str());
  let lead = (0..n).take_while(|&i| is_moved(i)).count();
  let tail = if lead == n {
    0
  } else {
    (0..n).rev().take_while(|&i| is_moved(i)).count()
  };
  let mut placed: HashSet<&str> = HashSet::new();
  let front: Vec<NodeId> = reference[..lead].iter().filter(|r| placed.insert(r.as_str())).cloned().collect();
  working.splice(0..0, front);
  for i in lead..n - tail {
    if !is_moved(i) || !placed.insert(reference[i].as_str()) {
      continue;
    }
    let at = |w: &[NodeId], id: &NodeId| w.iter().position(|x| x == id);
    let slot = (0..i)
      .rev()
      .find_map(|j| at(&working, &reference[j]).map(|p| p + 1))
      .or_else(|| (i + 1..n).find_map(|k| at(&working, &reference[k])))
      .unwrap_or(working.len());
    working.insert(slot, reference[i].clone());
  }
  for r in &reference[n - tail..] {
    if placed.insert(r.as_str()) {
      working.push(r.clone());
    }
  }
  working
}

/// A comment message's identity: messages carry no id, and nothing edits one, so author, time and
/// text name it.
type MsgKey = (String, u64, String);

fn msg_key(m: &crate::model::CommentMessage) -> MsgKey {
  (m.author.clone(), m.time.to_bits(), m.text.clone())
}

/// What changed in a comment both sides hold, as `{set?, add?, del?}` (see `delta_with`), or
/// `None` when it can't be said that way (the whole comment then travels).
fn comment_changes(b: &Comment, c: &Comment) -> Option<Value> {
  let mut set = Map::new();
  if b.resolved != c.resolved {
    set.insert("resolved".into(), json!(c.resolved));
  }
  if b.x != c.x {
    set.insert("x".into(), json!(c.x));
  }
  if b.y != c.y {
    set.insert("y".into(), json!(c.y));
  }
  if b.node != c.node {
    set.insert("node".into(), json!(c.node));
  }
  if b.page != c.page {
    set.insert("page".into(), json!(c.page));
  }
  let (bk, ck): (HashSet<MsgKey>, HashSet<MsgKey>) = (b.messages.iter().map(msg_key).collect(), c.messages.iter().map(msg_key).collect());
  let add: Vec<&crate::model::CommentMessage> = c.messages.iter().filter(|m| !bk.contains(&msg_key(m))).collect();
  let del: Vec<Value> = b
    .messages
    .iter()
    .filter(|m| !ck.contains(&msg_key(m)))
    .map(|m| json!([m.author, m.time, m.text]))
    .collect();
  if set.is_empty() && add.is_empty() && del.is_empty() {
    return None;
  }
  let mut out = Map::new();
  if !set.is_empty() {
    out.insert("set".into(), Value::Object(set));
  }
  if !add.is_empty() {
    out.insert("add".into(), json!(add));
  }
  if !del.is_empty() {
    out.insert("del".into(), Value::Array(del));
  }
  Some(Value::Object(out))
}

/// Applies `commentChanges` to the comments `doc` still has (one a peer deleted stays deleted).
fn apply_comment_changes(doc: &mut Document, changes: &Map<String, Value>) -> Result<(), String> {
  for (id, ch) in changes {
    let Some(cur) = doc.comments.get(id) else { continue };
    let mut c = cur.clone();
    if let Some(set) = ch.get("set").and_then(|s| s.as_object()) {
      if let Some(v) = set.get("resolved").and_then(|v| v.as_bool()) {
        c.resolved = v;
      }
      if let Some(v) = set.get("x").and_then(|v| v.as_f64()) {
        c.x = v;
      }
      if let Some(v) = set.get("y").and_then(|v| v.as_f64()) {
        c.y = v;
      }
      if let Some(v) = set.get("node") {
        c.node = v.as_str().map(str::to_string);
      }
      if let Some(v) = set.get("page").and_then(|v| v.as_str()) {
        c.page = v.to_string();
      }
    }
    if let Some(del) = ch.get("del").and_then(|d| d.as_array()) {
      // A malformed key fails the delta, as a malformed message in `add` does.
      let gone: HashSet<MsgKey> = del
        .iter()
        .map(|k| {
          let k = k.as_array()?;
          Some((
            k.first()?.as_str()?.to_string(),
            k.get(1)?.as_f64()?.to_bits(),
            k.get(2)?.as_str()?.to_string(),
          ))
        })
        .collect::<Option<_>>()
        .ok_or_else(|| format!("bad comment key in {id}"))?;
      c.messages.retain(|m| !gone.contains(&msg_key(m)));
    }
    if let Some(add) = ch.get("add").and_then(|a| a.as_array()) {
      let mut have: HashSet<MsgKey> = c.messages.iter().map(msg_key).collect();
      for m in add {
        let m: crate::model::CommentMessage = serde_json::from_value(m.clone()).map_err(|e| format!("bad comment message {id}: {e}"))?;
        if have.insert(msg_key(&m)) {
          c.messages.push(m);
        }
      }
    }
    if c != *cur {
      doc.comments_mut().insert(id.clone(), c);
    }
  }
  Ok(())
}

/// A delta in the form editors that predate `lists` (but read per-id changes) understand: the
/// child lists the delta moved things in are sent whole, taken from `doc` (the room's document,
/// after applying), comments that changed are sent whole (or as removed), and the layers
/// `prune_refs` changed (`pruned`) are sent whole, because those editors don't prune. `None` when
/// there is nothing to rewrite.
pub fn legacy_lists(d: &Value, doc: &Document, pruned: &[NodeId]) -> Option<Value> {
  let has = |k: &str| d.get(k).is_some();
  if !has("moves") && !has("pageMoves") && !has("commentChanges") && pruned.is_empty() {
    return None;
  }
  let mut out = d.clone();
  let o = out.as_object_mut()?;
  fn sub<'a>(o: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let v = o.entry(key.to_string()).or_insert_with(|| json!({}));
    if !v.is_object() {
      *v = json!({});
    }
    v.as_object_mut().unwrap()
  }
  if let Some(Value::Object(moves)) = o.remove("moves") {
    for id in moves.keys() {
      if let Some(n) = doc.get(id) {
        let entry = sub(sub(o, "patch"), id);
        entry.insert("children".into(), json!(n.children));
      }
    }
  }
  if let Some(Value::Object(moves)) = o.remove("pageMoves") {
    for id in moves.keys() {
      if let Some(p) = doc.page(id) {
        let entry = sub(sub(sub(o, "pageChanges"), "patch"), id);
        entry.insert("children".into(), json!(p.children));
      }
    }
  }
  if let Some(Value::Object(changes)) = o.remove("commentChanges") {
    for id in changes.keys() {
      match doc.comments.get(id) {
        Some(c) => {
          sub(o, "comments").insert(id.clone(), serde_json::to_value(c).unwrap_or(Value::Null));
        }
        None => {
          let gone = o.entry("commentsRemoved".to_string()).or_insert_with(|| json!([]));
          if let Some(a) = gone.as_array_mut().filter(|a| !a.iter().any(|x| x.as_str() == Some(id))) {
            a.push(json!(id));
          }
        }
      }
    }
  }
  for id in pruned {
    if let Some(n) = doc.get(id) {
      sub(o, "nodes").insert(id.clone(), serde_json::to_value(n).unwrap_or(Value::Null));
      sub(o, "patch").remove(id);
    }
  }
  Some(out)
}

#[cfg(test)]
thread_local! {
  /// How many whole-document scans `prune_refs` made on this thread (see the tests).
  static ALL_SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// What `prune_refs` examines.
#[derive(Clone, Copy)]
pub enum Scope<'a> {
  /// Just these layers (the ones a change touched).
  Nodes(&'a [NodeId]),
  /// Every layer (a style, variable, collection or mode went away).
  All,
}

/// Variables, modes and styles that exist, for `prune_refs`.
struct Live {
  vars: HashSet<String>,
  modes: HashMap<String, HashSet<String>>,
  colors: HashSet<String>,
  texts: HashSet<String>,
  effects: HashSet<String>,
  grids: HashSet<String>,
}

impl Live {
  fn of(doc: &Document) -> Live {
    let s = &doc.styles;
    Live {
      vars: doc
        .variables
        .iter()
        .flat_map(|c| c.variables.iter().map(|v| v.id.clone()))
        .collect(),
      modes: doc
        .variables
        .iter()
        .map(|c| (c.id.clone(), c.modes.iter().map(|m| m.id.clone()).collect()))
        .collect(),
      colors: s.colors.iter().map(|x| x.id.clone()).collect(),
      texts: s.texts.iter().map(|x| x.id.clone()).collect(),
      effects: s.effects.iter().map(|x| x.id.clone()).collect(),
      grids: s.grids.iter().map(|x| x.id.clone()).collect(),
    }
  }

  fn mode_ok(&self, coll: &str, mode: &str) -> bool {
    self.modes.get(coll).is_some_and(|m| m.contains(mode))
  }

  fn style_ok(&self, key: &str, id: &str) -> bool {
    match key {
      "fillStyle" | "strokeStyle" => self.colors.contains(id),
      "textStyle" => self.texts.contains(id),
      "effectStyle" => self.effects.contains(id),
      _ => self.grids.contains(id),
    }
  }
}

const STYLE_KEYS: [&str; 5] = ["fillStyle", "strokeStyle", "textStyle", "effectStyle", "gridStyle"];

fn has_refs(n: &Node) -> bool {
  !n.bindings.is_empty()
    || !n.variable_modes.is_empty()
    || n.fill_style.is_some()
    || n.stroke_style.is_some()
    || n.text_style.is_some()
    || n.effect_style.is_some()
    || n.grid_style.is_some()
    || n.instance.as_ref().is_some_and(|i| !i.overrides.is_empty())
}

/// True when an override patch (or a nested swap record's overrides) refers to something gone.
fn override_stale(o: &Value, live: &Live) -> bool {
  let Some(obj) = o.as_object() else { return false };
  let bad_binding = obj
    .get("bindings")
    .and_then(|b| b.as_object())
    .is_some_and(|b| b.values().any(|v| v.as_str().is_some_and(|s| !live.vars.contains(s))));
  let bad_mode = obj
    .get("variableModes")
    .and_then(|m| m.as_object())
    .is_some_and(|m| m.iter().any(|(c, v)| v.as_str().is_some_and(|mode| !live.mode_ok(c, mode))));
  let bad_style = STYLE_KEYS
    .iter()
    .any(|k| obj.get(*k).and_then(|v| v.as_str()).is_some_and(|s| !live.style_ok(k, s)));
  bad_binding
    || bad_mode
    || bad_style
    || obj
      .get(crate::components::SWAP_KEY)
      .and_then(|s| s.get("overrides"))
      .and_then(|o| o.as_object())
      .is_some_and(|inner| inner.values().any(|o| override_stale(o, live)))
}

/// Removes what `override_stale` finds. A `null` stays: `bindings: {fill: null}` records "unbound here".
fn clean_override(o: &mut Value, live: &Live) {
  let Some(obj) = o.as_object_mut() else { return };
  if let Some(Value::Object(b)) = obj.get_mut("bindings") {
    b.retain(|_, v| v.as_str().is_none_or(|s| live.vars.contains(s)));
    if b.is_empty() {
      obj.remove("bindings");
    }
  }
  if let Some(Value::Object(m)) = obj.get_mut("variableModes") {
    m.retain(|c, v| v.as_str().is_none_or(|mode| live.mode_ok(c, mode)));
    if m.is_empty() {
      obj.remove("variableModes");
    }
  }
  for k in STYLE_KEYS {
    if obj.get(k).and_then(|v| v.as_str()).is_some_and(|s| !live.style_ok(k, s)) {
      obj.remove(k);
    }
  }
  if let Some(Value::Object(swap)) = obj.get_mut(crate::components::SWAP_KEY) {
    if let Some(Value::Object(inner)) = swap.get_mut("overrides") {
      inner.values_mut().for_each(|o| clean_override(o, live));
      inner.retain(|_, o| o.as_object().is_none_or(|m| !m.is_empty()));
    }
  }
}

fn node_stale(n: &Node, live: &Live) -> bool {
  let style = |l: &Option<String>, key: &str| l.as_deref().is_some_and(|s| !live.style_ok(key, s));
  n.bindings.values().any(|v| !live.vars.contains(v))
    || n.variable_modes.iter().any(|(c, m)| !live.mode_ok(c, m))
    || style(&n.fill_style, "fillStyle")
    || style(&n.stroke_style, "strokeStyle")
    || style(&n.text_style, "textStyle")
    || style(&n.effect_style, "effectStyle")
    || style(&n.grid_style, "gridStyle")
    || n
      .instance
      .as_ref()
      .is_some_and(|i| i.overrides.values().any(|o| override_stale(o, live)))
}

/// Drops, from the layers in `scope`, every reference to a variable, collection, mode or style the
/// document no longer has: `bindings`, `variableModes` (the rule of `variables::prune`), the
/// style links, and the same keys inside instance overrides (swap records too). A layer keeps
/// the value it shows and loses the link. Returns the changed layers, sorted.
///
/// A deleted token and someone's link to it can meet in any order, and nobody else's copy
/// knows about the other half, so every peer and the room run this on each delta they apply
/// (`apply_opts`) and the sender after each local change: all end with the same document.
pub fn prune_refs(doc: &mut Document, scope: Scope) -> Vec<NodeId> {
  let candidates: Vec<NodeId> = match scope {
    Scope::All => {
      #[cfg(test)]
      ALL_SCANS.with(|c| c.set(c.get() + 1));
      doc.nodes.values().filter(|n| has_refs(n)).map(|n| n.id.clone()).collect()
    }
    Scope::Nodes(ids) => ids
      .iter()
      .filter(|id| doc.get(id).is_some_and(has_refs))
      .cloned()
      .collect::<BTreeSet<_>>()
      .into_iter()
      .collect(),
  };
  if candidates.is_empty() {
    return vec![];
  }
  let live = Live::of(doc);
  let mut stale: Vec<NodeId> = candidates
    .into_iter()
    .filter(|id| node_stale(doc.get(id).unwrap(), &live))
    .collect();
  for id in &stale {
    let Some(n) = doc.get_mut(id) else { continue };
    n.bindings.retain(|_, v| live.vars.contains(v));
    n.variable_modes.retain(|c, m| live.mode_ok(c, m));
    for (link, key) in [
      (&mut n.fill_style, "fillStyle"),
      (&mut n.stroke_style, "strokeStyle"),
      (&mut n.text_style, "textStyle"),
      (&mut n.effect_style, "effectStyle"),
      (&mut n.grid_style, "gridStyle"),
    ] {
      if link.as_deref().is_some_and(|s| !live.style_ok(key, s)) {
        *link = None;
      }
    }
    if let Some(info) = n.instance.as_mut() {
      info.overrides.values_mut().for_each(|o| clean_override(o, &live));
      info.overrides.retain(|_, o| o.as_object().is_none_or(|m| !m.is_empty()));
    }
  }
  stale.sort();
  stale
}

/// Every id of a style, variable, collection and mode (for telling whether a change removed one).
fn token_ids(d: &Document) -> BTreeSet<String> {
  let s = &d.styles;
  let mut v: BTreeSet<String> = s.colors.iter().map(|x| x.id.clone()).collect();
  v.extend(s.texts.iter().map(|x| x.id.clone()));
  v.extend(s.effects.iter().map(|x| x.id.clone()));
  v.extend(s.grids.iter().map(|x| x.id.clone()));
  for c in &d.variables {
    v.insert(format!("c:{}", c.id));
    v.extend(c.variables.iter().map(|x| x.id.clone()));
    v.extend(c.modes.iter().map(|m| format!("m:{}/{}", c.id, m.id)));
  }
  v
}

/// True when `after` lacks a style, variable, collection or mode that `before` has. Documents that
/// share their styles and variables (the usual case) compare in O(1).
pub fn lost_tokens(before: &Document, after: &Document) -> bool {
  if arc_eq(&before.styles, &after.styles) && arcs_eq(&before.variables, &after.variables) {
    return false;
  }
  token_ids(before).difference(&token_ids(after)).next().is_some()
}

/// The collections without their variables (new allocations; the variables travel separately).
fn bare_collections(l: &[Arc<Collection>]) -> Vec<Arc<Collection>> {
  l.iter()
    .map(|c| {
      Arc::new(Collection {
        id: c.id.clone(),
        name: c.name.clone(),
        modes: c.modes.clone(),
        variables: vec![],
      })
    })
    .collect()
}

/// Adds the per-id changes of pages, styles and variables from `base` to `doc` to `o`.
fn granular_parts(base: &Document, doc: &Document, o: &mut Map<String, Value>) {
  // Sent on every flush (every frame of a drag): comparing is cheap, serialising is not.
  // (Shared `Arc`s compare equal without a look inside.)
  let (pages_same, styles_same, vars_same) = (
    arcs_eq(&base.pages, &doc.pages),
    arc_eq(&base.styles, &doc.styles),
    arcs_eq(&base.variables, &doc.variables),
  );
  if pages_same && styles_same && vars_same {
    return;
  }
  let mut put = |k: &str, d: Option<Value>| {
    if let Some(d) = d {
      o.insert(k.into(), d);
    }
  };
  if !pages_same {
    put("pageChanges", ListDelta::of(&base.pages, &doc.pages, |p| &p.id, &[]));
  }
  if !styles_same && base.styles.colors != doc.styles.colors {
    put(
      "colorStyles",
      ListDelta::of(&base.styles.colors, &doc.styles.colors, |s| &s.id, &[]),
    );
  }
  if !styles_same && base.styles.texts != doc.styles.texts {
    put("textStyles", ListDelta::of(&base.styles.texts, &doc.styles.texts, |s| &s.id, &[]));
  }
  if !styles_same && base.styles.effects != doc.styles.effects {
    put(
      "effectStyles",
      ListDelta::of(&base.styles.effects, &doc.styles.effects, |s| &s.id, &[]),
    );
  }
  if !styles_same && base.styles.grids != doc.styles.grids {
    put("gridStyles", ListDelta::of(&base.styles.grids, &doc.styles.grids, |s| &s.id, &[]));
  }
  if vars_same {
    return;
  }
  // Collections without their variables; a new collection travels whole, with them.
  if let Some(mut d) = ListDelta::of(
    &bare_collections(&base.variables),
    &bare_collections(&doc.variables),
    |c| &c.id,
    &[],
  ) {
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
    if let Some(b) = base.variables.iter().find(|b| b.id == c.id).filter(|b| !arc_eq(b, c)) {
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

/// Equality that lets two handles to one allocation skip the deep compare.
trait Same {
  fn same(&self, other: &Self) -> bool;
}

impl<T: PartialEq> Same for Arc<T> {
  fn same(&self, other: &Self) -> bool {
    arc_eq(self, other)
  }
}

macro_rules! same_by_eq {
  ($($t:ty),*) => {$(impl Same for $t {
    fn same(&self, other: &Self) -> bool {
      self == other
    }
  })*};
}
same_by_eq!(ColorStyle, TextStyle, EffectStyle, GridStyle);

impl ListDelta {
  fn of<T: Serialize + Same>(base: &[T], new: &[T], id: impl Fn(&T) -> &String, nested: &[&str]) -> Option<Value> {
    let (mut add, mut patch) = (Map::new(), Map::new());
    for n in new {
      match base.iter().find(|b| id(b) == id(n)) {
        None => {
          add.insert(id(n).clone(), serde_json::to_value(n).unwrap_or(Value::Null));
        }
        Some(b) if b.same(n) => {}
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
    && empty("moves")
    && empty("pageMoves")
    && empty("commentChanges")
    && empty("text")
    && ["name", "pages", "styles", "variables"].iter().all(|k| d.get(*k).is_none())
    && !is_granular(d)
}

/// How `apply_opts` applies a delta.
#[derive(Clone, Copy, Debug, Default)]
pub struct ApplyOpts {
  /// Afterwards, drop references to styles, variables and modes the document no longer has
  /// (`prune_refs`), from the layers the delta touched and, when it removed a token, from all.
  pub prune: bool,
}

/// Applies a peer's delta, then repairs the tree around everything it touched.
pub fn apply(doc: &mut Document, d: &Value) -> Result<(), String> {
  apply_opts(doc, d, ApplyOpts::default()).map(drop)
}

/// `apply`, with the options; returns the layers `prune_refs` changed.
pub fn apply_opts(doc: &mut Document, d: &Value, opts: ApplyOpts) -> Result<Vec<NodeId>, String> {
  // All or nothing: a delta that fails half way leaves the document as it was (the room acks it as
  // rejected, so no peer may hold any of it).
  let start = doc.clone();
  let out = apply_inner(doc, d, opts);
  if out.is_err() {
    *doc = start;
  }
  out
}

thread_local! {
  /// Set while `apply_local` runs: text entries are applied as this editor's own change.
  static LOCAL_TEXT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// `apply_opts` for changes this editor re-applies as its own (see `textseq::apply_local`).
pub fn apply_local(doc: &mut Document, d: &Value, opts: ApplyOpts) -> Result<Vec<NodeId>, String> {
  LOCAL_TEXT.with(|l| l.set(true));
  let out = apply_opts(doc, d, opts);
  LOCAL_TEXT.with(|l| l.set(false));
  out
}

fn apply_inner(doc: &mut Document, d: &Value, opts: ApplyOpts) -> Result<Vec<NodeId>, String> {
  let before = doc.clone();
  let mut touched: Vec<NodeId> = Vec::new();
  if let Some(nodes) = d.get("nodes").and_then(|v| v.as_object()) {
    for (id, v) in nodes {
      let n: Node = serde_json::from_value(v.clone()).map_err(|e| format!("bad node {id}: {e}"))?;
      doc.nodes.insert(id.clone(), Arc::new(n));
      touched.push(id.clone());
      drop_stale_seq(doc, id);
    }
  }
  let moves = d.get("moves").and_then(|v| v.as_object());
  if let Some(patches) = d.get("patch").and_then(|v| v.as_object()) {
    for (id, p) in patches {
      // A layer someone deleted meanwhile stays deleted.
      let (Some(n), Some(p)) = (doc.get(id), p.as_object()) else {
        continue;
      };
      let mut new = patch_node(n, p).map_err(|e| format!("bad patch {id}: {e}"))?;
      // The sender's list is the reference; what it moved is placed in this one's order.
      if let Some(m) = moves.and_then(|m| m.get(id)).filter(|_| p.contains_key("children")) {
        new.children = place(&n.children, &new.children, &id_list(m));
      }
      let n = new;
      doc.nodes.insert(id.clone(), Arc::new(n));
      touched.push(id.clone());
      if p.contains_key("text") {
        drop_stale_seq(doc, id);
      }
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
  // Characters, runs and props of text layers that merge per character.
  if let Some(texts) = d.get("text").and_then(|v| v.as_object()) {
    for (id, entry) in texts {
      let Some(mut t) = doc.get(id).and_then(|n| n.text.clone()) else {
        continue;
      };
      let applied = if LOCAL_TEXT.with(|l| l.get()) {
        textseq::apply_local(&mut t, entry)
      } else {
        textseq::apply(&mut t, entry)
      };
      applied.map_err(|e| format!("bad text {id}: {e}"))?;
      doc.modify(id, |n| n.text = Some(t));
      touched.push(id.clone());
    }
  }
  if let Some(c) = d.get("comments").and_then(|v| v.as_object()) {
    for (id, v) in c {
      let c: Comment = serde_json::from_value(v.clone()).map_err(|e| format!("bad comment {id}: {e}"))?;
      doc.comments_mut().insert(id.clone(), c);
    }
  }
  if let Some(c) = d.get("commentChanges").and_then(|v| v.as_object()) {
    apply_comment_changes(doc, c)?;
  }
  for id in d
    .get("commentsRemoved")
    .and_then(|v| v.as_array())
    .into_iter()
    .flatten()
    .filter_map(|v| v.as_str())
  {
    doc.comments_mut().remove(id);
  }
  if let Some(v) = d.get("name").and_then(|v| v.as_str()) {
    doc.name = v.to_string();
  }
  if let Some(v) = d.get("pages") {
    let new: Vec<Arc<crate::model::Page>> = serde_json::from_value(v.clone()).map_err(|e| format!("bad pages: {e}"))?;
    let old = std::mem::replace(&mut doc.pages, new);
    for p in &mut doc.pages {
      if let Some(o) = old.iter().find(|o| o.id == p.id).filter(|o| arc_eq(o, p)) {
        *p = Arc::clone(o);
      }
    }
  }
  if let Some(v) = d.get("styles") {
    let new: Arc<crate::model::Styles> = serde_json::from_value(v.clone()).map_err(|e| format!("bad styles: {e}"))?;
    if *new != *doc.styles {
      doc.styles = new;
    }
  }
  if let Some(v) = d.get("variables") {
    let mut new: Vec<Arc<crate::variables::Collection>> = serde_json::from_value(v.clone()).map_err(|e| format!("bad variables: {e}"))?;
    let old = std::mem::take(&mut doc.variables);
    crate::variables::reshare(&mut new, &old);
    doc.variables = new;
  }
  apply_granular(doc, d)?;
  // Two people deleting different pages at the same moment must not leave none (the first
  // page is the editor's fallback): the room's order decides, so every copy keeps the same one.
  keep_a_page(doc, &before);
  repair(doc, &before, &touched);
  if !opts.prune {
    return Ok(vec![]);
  }
  // Someone's link to a token and someone else's deletion of it can arrive in either order.
  Ok(if lost_tokens(&before, doc) {
    prune_refs(doc, Scope::All)
  } else {
    prune_refs(doc, Scope::Nodes(&touched))
  })
}

/// A text whose stored sequence doesn't describe its characters (a whole text arrived from a peer
/// that doesn't know sequences) is plain again, the same on every copy.
fn drop_stale_seq(doc: &mut Document, id: &str) {
  let stale = doc
    .get(id)
    .and_then(|n| n.text.as_ref())
    .and_then(|t| t.seq.as_ref().map(|s| !textseq::valid(s, &t.characters)))
    .unwrap_or(false);
  if stale {
    if let Some(t) = doc.get_mut(id).and_then(|n| n.text.as_mut()) {
      t.seq = None;
    }
  }
}

/// The strings of a JSON array (anything else is empty).
fn id_list(v: &Value) -> Vec<String> {
  v.as_array()
    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
    .unwrap_or_default()
}

/// Applies the per-id changes of pages, styles and variables in `d`, if it has any.
fn apply_granular(doc: &mut Document, d: &Value) -> Result<(), String> {
  if let Some(c) = d.get("pageChanges") {
    let moves = d.get("pageMoves").and_then(|v| v.as_object());
    let old: Vec<(String, Vec<NodeId>)> = moves
      .into_iter()
      .flat_map(|m| m.keys())
      .filter(|id| {
        c.get("patch")
          .and_then(|p| p.get(id.as_str()))
          .is_some_and(|p| p.get("children").is_some())
      })
      .filter_map(|id| doc.page(id).map(|p| (id.clone(), p.children.clone())))
      .collect();
    ListDelta::apply(&mut doc.pages, c, |p| &p.id, &[], "page")?;
    for (id, old) in old {
      if let (Some(p), Some(m)) = (doc.page_mut(&id), moves.and_then(|m| m.get(&id))) {
        let placed = place(&old, &p.children, &id_list(m));
        if placed != p.children {
          p.children = placed;
        }
      }
    }
  }
  if let Some(c) = d.get("colorStyles") {
    ListDelta::apply(&mut doc.styles_mut().colors, c, |s| &s.id, &[], "colour style")?;
  }
  if let Some(c) = d.get("textStyles") {
    ListDelta::apply(&mut doc.styles_mut().texts, c, |s| &s.id, &[], "text style")?;
  }
  if let Some(c) = d.get("effectStyles") {
    ListDelta::apply(&mut doc.styles_mut().effects, c, |s| &s.id, &[], "effect style")?;
  }
  if let Some(c) = d.get("gridStyles") {
    ListDelta::apply(&mut doc.styles_mut().grids, c, |s| &s.id, &[], "grid style")?;
  }
  if let Some(c) = d.get("collectionChanges") {
    // Collections change without their variables, which have their own changes below.
    let old = std::mem::take(&mut doc.variables);
    let mut work = bare_collections(&old);
    let done = ListDelta::apply(&mut work, c, |c| &c.id, &[], "collection");
    for c in work.iter_mut() {
      if let Some(o) = old.iter().find(|o| o.id == c.id) {
        Arc::make_mut(c).variables = o.variables.clone();
      }
    }
    crate::variables::reshare(&mut work, &old);
    doc.variables = work;
    done?;
  }
  if let Some(vars) = d.get("variableChanges").and_then(|v| v.as_object()) {
    for (id, c) in vars {
      if let Some(coll) = crate::variables::coll_mut(doc, id) {
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

thread_local! {
  /// The layers the step being reverted moved on purpose (see `revert_hinted`).
  static REVERT_HINT: std::cell::RefCell<HashSet<NodeId>> = std::cell::RefCell::new(HashSet::new());
}

/// `revert`, for a step whose command moved the layers in `hint` (the engine records them with
/// the step): undoing "Send backward" of one layer puts that layer back, not its neighbour.
pub fn revert_hinted(doc: &Document, from: &Document, to: &Document, hint: &[NodeId]) -> Document {
  REVERT_HINT.with(|h| *h.borrow_mut() = hint.iter().cloned().collect());
  let out = revert(doc, from, to);
  REVERT_HINT.with(|h| h.borrow_mut().clear());
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
        let cur = out.get(k).unwrap();
        let n = merge_fields(cur, o, v, true).map(Arc::new).unwrap_or_else(|| v.clone());
        let n = merge_text(cur, o, v, n);
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
  if !arc_eq(&from.styles, &to.styles) {
    let styles = out.styles_mut();
    merge_list(&mut styles.colors, &from.styles.colors, &to.styles.colors, |s| &s.id);
    merge_list(&mut styles.texts, &from.styles.texts, &to.styles.texts, |s| &s.id);
    merge_list(&mut styles.effects, &from.styles.effects, &to.styles.effects, |s| &s.id);
    merge_list(&mut styles.grids, &from.styles.grids, &to.styles.grids, |s| &s.id);
  }
  merge_collections(&mut out.variables, &from.variables, &to.variables);
  for id in from.comments.keys().chain(to.comments.keys()).collect::<BTreeSet<_>>() {
    let (f, t) = (from.comments.get(id), to.comments.get(id));
    if f == t {
      continue;
    }
    match (f, t, out.comments.get(id)) {
      // The step changed where a comment sits (a restore re-homing it): a peer's newer
      // messages or resolve stay, and a comment a peer deleted meanwhile stays deleted.
      (Some(f), Some(t), Some(cur)) => {
        let m = merge_comment(cur, f, t);
        if m != *cur {
          out.comments_mut().insert(id.clone(), m);
        }
      }
      (Some(_), Some(_), None) => {}
      (_, Some(t), _) => {
        out.comments_mut().insert(id.clone(), t.clone());
      }
      (_, None, _) => {
        if out.comments.contains_key(id) {
          out.comments_mut().remove(id);
        }
      }
    }
  }
  keep_tokens_in_use(&mut out, doc);
  let base = doc.clone();
  repair(&mut out, &base, &touched);
  out
}

/// A text layer reverted three ways: when any of the three texts carries merge data and they share
/// an epoch, the step's own characters (and runs and sequence) are reversed (`textseq::revert`) and
/// everyone else's stay; the other text props are already merged in `merged`. Otherwise
/// `merged` stands (the whole-text rule), with its sequence dropped if it no longer fits.
fn merge_text(cur: &Node, from: &Node, to: &Node, merged: Arc<Node>) -> Arc<Node> {
  if let (Some(c), Some(f), Some(t)) = (cur.text.as_ref(), from.text.as_ref(), to.text.as_ref()) {
    if [c, f, t].iter().any(|x| x.seq.is_some()) {
      if let Some(r) = textseq::revert(c, f, t) {
        let mut n = (*merged).clone();
        if let Some(m) = n.text.as_mut() {
          m.characters = r.characters;
          m.runs = r.runs;
          m.seq = r.seq;
        }
        return Arc::new(n);
      }
    }
  }
  let stale = merged
    .text
    .as_ref()
    .is_some_and(|t| t.seq.as_ref().is_some_and(|s| !textseq::valid(s, &t.characters)));
  if !stale {
    return merged;
  }
  let mut n = (*merged).clone();
  if let Some(t) = n.text.as_mut() {
    t.seq = None;
  }
  Arc::new(n)
}

/// True when `out` lacks a style, variable or collection that `doc` has: the only case in which
/// the layers need scanning for references.
fn drops_tokens(out: &Document, doc: &Document) -> bool {
  let ids = |d: &Document| -> BTreeSet<String> {
    let s = &d.styles;
    let mut v: BTreeSet<String> = s.colors.iter().map(|x| x.id.clone()).collect();
    v.extend(s.texts.iter().map(|x| x.id.clone()));
    v.extend(s.effects.iter().map(|x| x.id.clone()));
    v.extend(s.grids.iter().map(|x| x.id.clone()));
    v.extend(d.variables.iter().flat_map(|c| c.variables.iter().map(|x| x.id.clone())));
    v
  };
  ids(doc).difference(&ids(out)).next().is_some() || doc.variables.iter().any(|c| !out.variables.iter().any(|o| o.id == c.id))
}

/// A revert may drop a style, variable or collection that `doc` has, because the undone step
/// created it. When a layer still refers to one (a peer's layer, which per-person undo never
/// touches), it is put back: an unused token is harmless and can be deleted on purpose,
/// while unbinding would silently change someone else's work. The layers are scanned only
/// when something was dropped, so ordinary undo costs nothing extra.
fn keep_tokens_in_use(out: &mut Document, doc: &Document) {
  if !drops_tokens(out, doc) {
    return;
  }
  let used = clipboard::references(out.nodes.values().map(|n| &**n));
  macro_rules! restore_styles {
    ($list:ident) => {
      for (at, s) in doc.styles.$list.iter().enumerate() {
        if used.styles.contains(&s.id) && !out.styles.$list.iter().any(|o| o.id == s.id) {
          let list = &mut out.styles_mut().$list;
          list.insert(at.min(list.len()), s.clone());
        }
      }
    };
  }
  restore_styles!(colors);
  restore_styles!(texts);
  restore_styles!(effects);
  restore_styles!(grids);

  // Variables: those layers use, what the variables that stay alias, and everything in a
  // collection that comes back whole, to a fixed point.
  let in_out: HashSet<String> = out
    .variables
    .iter()
    .flat_map(|c| c.variables.iter().map(|v| v.id.clone()))
    .collect();
  let live_colls: HashSet<String> = out.variables.iter().map(|c| c.id.clone()).collect();
  let (need, whole) = {
    let mut by_id: HashMap<&str, &Variable> = HashMap::new();
    for v in out.variables.iter().chain(doc.variables.iter()).flat_map(|c| c.variables.iter()) {
      by_id.entry(v.id.as_str()).or_insert(&**v);
    }
    let mut need: HashSet<String> = used.vars.clone();
    let mut queue: Vec<&str> = used.vars.iter().map(|s| s.as_str()).collect();
    queue.extend(in_out.iter().map(|s| s.as_str()));
    let mut seen: HashSet<&str> = HashSet::new();
    let mut whole: HashSet<String> = HashSet::new();
    loop {
      while let Some(id) = queue.pop() {
        if !seen.insert(id) {
          continue;
        }
        let Some(v) = by_id.get(id) else { continue };
        for target in v.values.values().filter_map(|x| x.get("alias").and_then(|a| a.as_str())) {
          if need.insert(target.to_string()) {
            queue.push(target);
          }
        }
      }
      // A dropped collection that is pinned, or holds a needed variable, returns whole.
      let back: Vec<&Arc<Collection>> = doc
        .variables
        .iter()
        .filter(|c| !live_colls.contains(&c.id) && !whole.contains(&c.id))
        .filter(|c| used.colls.contains(&c.id) || c.variables.iter().any(|v| need.contains(&v.id)))
        .collect();
      if back.is_empty() {
        break;
      }
      for c in back {
        whole.insert(c.id.clone());
        queue.extend(c.variables.iter().map(|v| v.id.as_str()));
      }
    }
    (need, whole)
  };
  for (at, c) in doc.variables.iter().enumerate() {
    if whole.contains(&c.id) {
      out.variables.insert(at.min(out.variables.len()), c.clone());
    } else if let Some(o) = out.variables.iter_mut().find(|o| o.id == c.id) {
      for (vat, v) in c.variables.iter().enumerate() {
        if need.contains(&v.id) && !in_out.contains(&v.id) {
          let o = Arc::make_mut(o);
          o.variables.insert(vat.min(o.variables.len()), v.clone());
        }
      }
    }
  }
}

/// Three-way merge of the serialised fields of one item: each field the step changed
/// (`from` to `to`) takes `to`'s value unless `cur` has since given it another one. `deep`
/// also merges inside nested objects (a layer's layout, a variable's per-mode values), key by
/// key; arrays are taken whole, and a text's characters and runs go together.
fn merge_fields<T: Serialize + DeserializeOwned>(cur: &T, from: &T, to: &T, deep: bool) -> Option<T> {
  let (Ok(c), Ok(f), Ok(t)) = (serde_json::to_value(cur), serde_json::to_value(from), serde_json::to_value(to)) else {
    return None;
  };
  serde_json::from_value(merge_json(&c, &f, &t, deep, false)).ok()
}

/// `strict`: inside an instance's overrides a `null` is a record (`bindings: {fill: null}` means
/// "unbound here"), so it differs from a missing key.
fn merge_json(cur: &Value, from: &Value, to: &Value, deep: bool, strict: bool) -> Value {
  let (Some(c), Some(f), Some(t)) = (cur.as_object(), from.as_object(), to.as_object()) else {
    return if same(cur, from) { to.clone() } else { cur.clone() };
  };
  let mut out = c.clone();
  // Run ranges index into the characters: keep both of someone else's, or take both of ours.
  let text_theirs = ["characters", "runs"].iter().any(|k| !same_opt_in(c.get(*k), f.get(*k), strict));
  for k in c.keys().chain(f.keys()).chain(t.keys()).collect::<BTreeSet<_>>() {
    let (cv, fv, tv) = (c.get(k), f.get(k), t.get(k));
    if same_opt_in(fv, tv, strict) || (text_theirs && (k == "characters" || k == "runs") && c.contains_key("characters")) {
      continue; // this step left it alone, or someone else changed this text
    }
    let merged = if k == "children" {
      Some(merge_order(cv, fv, tv))
    } else if let (true, Some(cv), Some(fv), Some(tv)) = (deep, cv, fv, tv) {
      (cv.is_object() && fv.is_object() && tv.is_object()).then(|| merge_json(cv, fv, tv, true, strict || k == "overrides"))
    } else {
      None
    };
    match merged {
      Some(v) => {
        out.insert(k.clone(), v);
      }
      None if same_opt_in(cv, fv, strict) => match tv {
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

/// Child lists, three ways: `from` is the list the step produced, `to` the one it started from
/// (an undo; for a redo the other way round) and `cur` the list now. What the step moved
/// (`moved(from, to)`) goes back, unless `cur` shows a collaborator moved it since (it no longer
/// sits between the neighbours the step gave it), and goes back relative to the others
/// (`place`), so a collaborator's later reorders of other layers stay. Layers the step took out
/// of the list return, ones it put in leave, and ones others added stay where they are.
/// `repair` drops the ones that no longer belong. With `cur == from` the result is `to`.
fn merge_order(cur: Option<&Value>, from: Option<&Value>, to: Option<&Value>) -> Value {
  let (cur, from, to) = (
    cur.map(id_list).unwrap_or_default(),
    from.map(id_list).unwrap_or_default(),
    to.map(id_list).unwrap_or_default(),
  );
  let (in_from, in_to): (HashSet<&String>, HashSet<&String>) = (from.iter().collect(), to.iter().collect());
  let cur: Vec<NodeId> = cur.iter().filter(|c| !in_from.contains(c) || in_to.contains(c)).cloned().collect();
  let at_from: HashMap<&String, usize> = from.iter().enumerate().map(|(i, id)| (id, i)).collect();
  let at_cur: HashMap<&String, usize> = cur.iter().enumerate().map(|(i, id)| (id, i)).collect();
  let hint = REVERT_HINT.with(|h| h.borrow().clone());
  let kept: Vec<NodeId> = moved_hinted(&from, &to, &hint)
    .into_iter()
    .filter(|id| {
      let Some(&f) = at_from.get(id) else { return true }; // the step took it out: it returns
      let Some(&c) = at_cur.get(id) else { return false }; // someone else took it out
      let before =
        |i: usize, list: &[NodeId], other: &HashMap<&String, usize>| list[..i].iter().rev().find(|x| other.contains_key(x)).cloned();
      let after =
        |i: usize, list: &[NodeId], other: &HashMap<&String, usize>| list[i + 1..].iter().find(|x| other.contains_key(x)).cloned();
      before(c, &cur, &at_from) == before(f, &from, &at_from) || after(c, &cur, &at_from) == after(f, &from, &at_from)
    })
    .collect();
  json!(place(&cur, &to, &kept))
}

/// Three-way merge of a comment: the fields as for a layer, the messages one by one. A message the
/// step added (in `from`, not in `to`) goes, whoever replied since; one it removed returns at the
/// end, as a reply does on the wire (`commentChanges.add` appends), so this editor's document and
/// the room's agree.
fn merge_comment(cur: &Comment, from: &Comment, to: &Comment) -> Comment {
  let bare = |c: &Comment| Comment {
    messages: vec![],
    ..c.clone()
  };
  let mut out = merge_fields(&bare(cur), &bare(from), &bare(to), false).unwrap_or_else(|| bare(cur));
  let (fk, tk): (HashSet<MsgKey>, HashSet<MsgKey>) = (
    from.messages.iter().map(msg_key).collect(),
    to.messages.iter().map(msg_key).collect(),
  );
  let mut msgs: Vec<crate::model::CommentMessage> = cur
    .messages
    .iter()
    .filter(|m| {
      let k = msg_key(m);
      !fk.contains(&k) || tk.contains(&k)
    })
    .cloned()
    .collect();
  for m in &to.messages {
    let k = msg_key(m);
    if !fk.contains(&k) && !msgs.iter().any(|x| msg_key(x) == k) {
      msgs.push(m.clone());
    }
  }
  out.messages = msgs;
  out
}

/// Keyed lists (pages, styles): items the step added are removed, items it removed come back
/// at their old place, and items it edited are merged field by field. Items others added are
/// left alone.
fn merge_list<T: Serialize + DeserializeOwned + Clone + Same>(cur: &mut Vec<T>, from: &[T], to: &[T], id: impl Fn(&T) -> &String) {
  if from.len() == to.len() && from.iter().zip(to).all(|(f, t)| f.same(t)) {
    return;
  }
  let at = |list: &[T], k: &String| list.iter().position(|x| id(x) == k);
  for f in from {
    if at(to, id(f)).is_none() {
      cur.retain(|x| id(x) != id(f));
    }
  }
  restore_order(cur, from, to, &id);
  for (i, t) in to.iter().enumerate() {
    match (at(from, id(t)), at(cur, id(t))) {
      (None, None) => cur.insert(i.min(cur.len()), t.clone()),
      (Some(fi), Some(ci)) if !from[fi].same(t) => {
        if let Some(m) = merge_fields(&cur[ci], &from[fi], t, true) {
          cur[ci] = m;
        }
      }
      _ => {}
    }
  }
}

/// Puts the items the step neither added nor removed back in `to`'s order, if the step
/// reordered them and `cur` still has `from`'s order (a collaborator's newer order stays).
/// Only the slots those items occupy are rearranged, so items others added keep their place.
fn restore_order<T: Clone>(cur: &mut [T], from: &[T], to: &[T], id: &impl Fn(&T) -> &String) {
  let in_list = |list: &[T], k: &String| list.iter().any(|x| id(x) == k);
  let slots: Vec<usize> = (0..cur.len())
    .filter(|&i| in_list(from, id(&cur[i])) && in_list(to, id(&cur[i])))
    .collect();
  let cur_order: Vec<String> = slots.iter().map(|&i| id(&cur[i]).clone()).collect();
  let order_in = |list: &[T]| -> Vec<String> { list.iter().map(|x| id(x).clone()).filter(|k| cur_order.contains(k)).collect() };
  let (from_order, to_order) = (order_in(from), order_in(to));
  if cur_order != from_order || from_order == to_order {
    return;
  }
  let sorted: Vec<T> = to_order.iter().filter_map(|k| cur.iter().find(|x| id(x) == k).cloned()).collect();
  for (slot, item) in slots.into_iter().zip(sorted) {
    cur[slot] = item;
  }
}

/// Variable collections: like `merge_list`, with each collection's variables merged by id too.
fn merge_collections(cur: &mut Vec<Arc<Collection>>, from: &[Arc<Collection>], to: &[Arc<Collection>]) {
  if arcs_eq(from, to) {
    return;
  }
  // Variables of collections that exist on every side are merged on their own; the
  // collections are then merged without them.
  let mut merged: BTreeMap<String, Vec<Arc<Variable>>> = BTreeMap::new();
  for t in to {
    if let (Some(f), Some(c)) = (from.iter().find(|f| f.id == t.id), cur.iter().find(|c| c.id == t.id)) {
      let mut vars = c.variables.clone();
      merge_list(&mut vars, &f.variables, &t.variables, |v| &v.id);
      merged.insert(t.id.clone(), vars);
    }
  }
  let mut out = bare_collections(cur);
  merge_list(&mut out, &bare_collections(from), &bare_collections(to), |c| &c.id);
  for c in out.iter_mut() {
    Arc::make_mut(c).variables = match merged.remove(&c.id) {
      Some(v) => v,
      None => match (cur.iter().find(|x| x.id == c.id), to.iter().find(|x| x.id == c.id)) {
        (Some(x), _) => x.variables.clone(),
        (None, Some(t)) => t.variables.clone(),
        _ => vec![],
      },
    };
  }
  crate::variables::reshare(&mut out, cur);
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

/// `same_opt`, or with `strict` a `null` is not a missing key.
fn same_opt_in(a: Option<&Value>, b: Option<&Value>, strict: bool) -> bool {
  if strict {
    match (a, b) {
      (Some(a), Some(b)) => same(a, b),
      (None, None) => true,
      _ => false,
    }
  } else {
    same_opt(a, b)
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
    if page.children != fixed {
      Arc::make_mut(page).children = fixed;
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::engine::{Command, Engine};
  use crate::model::NodeType;
  use crate::text::HeuristicMeasurer;

  #[test]
  fn downgrade_maps_new_names_to_old_ones() {
    let paints = json!([
      { "type": "angularGradient", "stops": [{ "position": 0, "color": "#000" }], "opacity": 0.5, "visible": false, "blend": "multiply", "handles": [1, 2] },
      { "type": "diamondGradient", "stops": [] },
      { "type": "image", "src": "asset:x", "scaleMode": "crop", "crop": { "x": 0 }, "opacity": 1 },
      { "type": "solid", "color": "#fff" }
    ]);
    let d = json!({ "nodes": { "a": { "fills": paints, "strokes": paints } }, "patch": { "b": { "fills": paints } },
      "colorStyles": { "added": [{ "id": "s", "paints": paints }] }, "x": { "overrides": { "c": { "fills": paints } } } });
    let out = downgrade(&d, 0);
    let check = |p: &Value| {
      assert_eq!(p[0]["type"], "radialGradient");
      assert_eq!(
        (p[0]["opacity"].clone(), p[0]["visible"].clone(), p[0]["blend"].clone()),
        (json!(0.5), json!(false), json!("multiply"))
      );
      assert!(p[0].get("handles").is_none() && p[0]["stops"].as_array().unwrap().len() == 1);
      assert_eq!(p[1]["type"], "radialGradient");
      assert_eq!(p[2]["scaleMode"], "fill");
      assert!(p[2].get("crop").is_none());
      assert_eq!(p[3], json!({ "type": "solid", "color": "#fff" }));
    };
    check(&out["nodes"]["a"]["fills"]);
    check(&out["nodes"]["a"]["strokes"]);
    check(&out["patch"]["b"]["fills"]);
    check(&out["colorStyles"]["added"][0]["paints"]);
    check(&out["x"]["overrides"]["c"]["fills"]);
    assert_eq!(d["nodes"]["a"]["fills"][0]["type"], "angularGradient", "the input is untouched");
  }

  #[test]
  fn downgrade_maps_interactions() {
    let list = json!([
      { "trigger": "mouseEnter", "action": "navigate", "transition": "moveIn", "direction": "down" },
      { "trigger": "mouseDown", "transition": "push", "direction": "right" },
      { "trigger": "mouseUp", "transition": "moveOut" },
      { "trigger": "mouseLeave" },
      { "trigger": "key", "key": "k" },
      { "trigger": "onClick", "action": "changeTo" },
      { "trigger": "onClick", "action": "navigate", "transition": "smartAnimate" }
    ]);
    let out = downgrade(&json!({ "patch": { "n": { "interactions": list } } }), 1);
    let got = out["patch"]["n"]["interactions"].as_array().unwrap();
    assert_eq!(got.len(), 4);
    assert_eq!(
      (got[0]["trigger"].clone(), got[0]["transition"].clone()),
      (json!("onHover"), json!("slideDown"))
    );
    assert_eq!(
      (got[1]["trigger"].clone(), got[1]["transition"].clone()),
      (json!("onPress"), json!("slideRight"))
    );
    assert_eq!(
      (got[2]["trigger"].clone(), got[2]["transition"].clone()),
      (json!("onClick"), json!("slideLeft"))
    );
    assert_eq!(got[3]["transition"], "smartAnimate");
  }

  #[test]
  fn downgrade_leaves_a_current_relay_alone() {
    let d = json!({ "nodes": { "a": { "fills": [{ "type": "angularGradient" }], "interactions": [{ "trigger": "key" }] } } });
    assert_eq!(downgrade(&d, MODEL_REVISION), d);
    assert_ne!(downgrade(&d, 0), d);
  }

  /// A change with everything revision 4 added, next to things revision 3 already had.
  fn v4_delta() -> Value {
    let list = json!([
      { "trigger": "onDrag", "action": "navigate", "transition": "smartAnimate", "bezier": [0.1, 0.2, 0.3, 0.4] },
      { "trigger": "mouseEnter", "action": "navigate", "transition": "push", "direction": "down" },
      { "trigger": "onClick", "action": "navigate", "bezier": [0.1, 0.2, 0.3, 0.4] }
    ]);
    let fills = json!([{ "type": "angularGradient", "stops": [], "handles": [1] }]);
    json!({
      "nodes": { "a": { "scrollBehavior": "sticky", "fills": fills, "interactions": list } },
      "patch": { "b": { "scrollBehavior": "sticky", "interactions": list } },
      "x": { "overrides": { "c": { "scrollBehavior": "sticky" } } },
    })
  }

  #[test]
  fn downgrade_layers_by_revision() {
    let d = v4_delta();
    // Revision 3 keeps what it knew (angular gradients, Move, Push), drops On drag, maps sticky.
    let out = downgrade(&d, 3);
    let list = &out["nodes"]["a"]["interactions"];
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert_eq!(list[0]["trigger"], "mouseEnter");
    assert_eq!(list[0]["transition"], "push");
    assert_eq!(
      list[1]["bezier"],
      json!([0.1, 0.2, 0.3, 0.4]),
      "bezier is left for old code to ignore"
    );
    assert_eq!(out["nodes"]["a"]["fills"][0]["type"], "angularGradient");
    assert_eq!(out["nodes"]["a"]["scrollBehavior"], "scroll");
    assert_eq!(out["patch"]["b"]["scrollBehavior"], "scroll");
    assert_eq!(out["patch"]["b"]["interactions"].as_array().unwrap().len(), 2);
    assert_eq!(out["x"]["overrides"]["c"]["scrollBehavior"], "scroll");
    // Revision 0 does both.
    let out = downgrade(&d, 0);
    let list = out["nodes"]["a"]["interactions"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(
      (list[0]["trigger"].clone(), list[0]["transition"].clone()),
      (json!("onHover"), json!("slideDown"))
    );
    assert_eq!(out["nodes"]["a"]["fills"][0]["type"], "radialGradient");
    assert_eq!(out["nodes"]["a"]["scrollBehavior"], "scroll");
    // Revision 4 is the identity.
    assert_eq!(downgrade(&d, 4), d);
    assert_eq!(MODEL_REVISION, 4);
  }

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
    e.render(&page, &[], None);
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
    let d = delta(&base, &a.doc, true, true);
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
    apply(&mut b.doc, &delta(&with_rows, &a.doc, true, true)).unwrap();
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
          e.collab_reset(true, true, false);
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
      e.collab_reset(true, true, false);
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
      kind: crate::variables::VarKind::Number,
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
      variables: vars.into_iter().map(Arc::new).collect(),
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
      kind: crate::variables::VarKind::Number,
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
      variables: vars.into_iter().map(Arc::new).collect(),
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
      let mut cs = crate::variables::plain(&room.editors[i].doc.variables);
      f(&mut cs);
      room.editors[i].dispatch(Command::SetVariables { collections: cs }).unwrap();
    };
    // Different variables, and different modes of one variable, and a different collection.
    edit(&mut room, 0, &|cs| {
      Arc::make_mut(&mut cs[0].variables[0]).values.insert("m1".into(), json!(5.0));
      cs[1].variables.push(Arc::new(variable("y", &[("m1", 7.0)])));
    });
    edit(&mut room, 1, &|cs| {
      Arc::make_mut(&mut cs[0].variables[0]).values.insert("m2".into(), json!(6.0));
      Arc::make_mut(&mut cs[0].variables[1]).values.insert("m1".into(), json!(8.0));
      cs[0].variables.push(Arc::new(variable("c", &[("m1", 3.0)])));
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
      Arc::make_mut(&mut cs[0].variables[0]).values.remove("m2");
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

  /// A rectangle with a drop shadow and a column grid, saved as an effect and a grid style.
  fn styled_layer(e: &mut Engine, effect_name: &str, grid_name: &str) -> (String, String, String) {
    let id = effects_layer(e);
    let (fx, gr) = save_styles(e, &id, effect_name, grid_name);
    (id, fx, gr)
  }

  fn effects_layer(e: &mut Engine) -> String {
    let id = e
      .dispatch(Command::CreateShape {
        kind: crate::model::NodeType::Rectangle,
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
        parent: None,
      })
      .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    e.dispatch(Command::Update {
      ids: vec![id.clone()],
      patch: json!({ "effects": [{ "type": "dropShadow", "blur": 12 }], "layoutGrids": [{ "pattern": "columns", "count": 4 }] }),
    })
    .unwrap();
    id
  }

  fn save_styles(e: &mut Engine, id: &str, effect_name: &str, grid_name: &str) -> (String, String) {
    let id = id.to_string();
    let fx = e
      .dispatch(Command::AddEffectStyle {
        name: effect_name.into(),
        from: id.clone(),
        description: String::new(),
      })
      .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    let gr = e
      .dispatch(Command::AddGridStyle {
        name: grid_name.into(),
        from: id.clone(),
        description: String::new(),
      })
      .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    (fx, gr)
  }

  #[test]
  fn effect_and_grid_styles_travel_per_id() {
    let (mut room, _) = Room::new(2);
    let a = effects_layer(&mut room.editors[0]);
    sync(&mut room, 0);
    let b = effects_layer(&mut room.editors[1]);
    sync(&mut room, 1);
    // Two people add different styles at the same moment: both are kept.
    save_styles(&mut room.editors[0], &a, "Shadow/Card", "Grid/4");
    save_styles(&mut room.editors[1], &b, "Shadow/Pop", "Grid/Wide");
    concurrent(&mut room);
    // (The order of two styles added at once is settled by the next flush, not asserted here.)
    for e in &room.editors {
      assert_eq!(e.doc.styles.effects.len(), 2);
      assert_eq!(e.doc.styles.grids.len(), 2);
    }
    assert_eq!(room.doc.styles.effects.len(), 2);
    assert_eq!(room.doc.styles.grids.len(), 2);
    // The delta of one edit names only that style.
    let base = room.editors[0].doc.clone();
    let fx = room.editors[0].doc.styles.effects[0].id.clone();
    room.editors[0]
      .dispatch(Command::UpdateEffectStyle {
        id: fx.clone(),
        name: Some("Shadow/Big".into()),
        effects: None,
        description: None,
      })
      .unwrap();
    let d = delta(&base, &room.editors[0].doc, true, true);
    assert_eq!(d["effectStyles"]["patch"][&fx], json!({ "name": "Shadow/Big" }));
    assert!(d.get("gridStyles").is_none() && d.get("colorStyles").is_none());
    // An old peer gets the whole `styles` with both lists.
    let old = legacy(&d, &room.editors[0].doc).unwrap();
    assert_eq!(old["styles"]["effects"].as_array().unwrap().len(), 2);
    assert_eq!(old["styles"]["grids"].as_array().unwrap().len(), 2);
    assert!(old.get("effectStyles").is_none());
    assert!(!is_empty(&d));
    sync(&mut room, 0);
    // Deleting one of them while the other person edits the second.
    let ids: Vec<String> = room.doc.styles.effects.iter().map(|s| s.id.clone()).collect();
    room.editors[0].dispatch(Command::DeleteStyle { id: ids[0].clone() }).unwrap();
    room.editors[1]
      .dispatch(Command::UpdateEffectStyle {
        id: ids[1].clone(),
        name: None,
        effects: Some(vec![crate::model::Effect {
          blur: 99.0,
          ..Default::default()
        }]),
        description: None,
      })
      .unwrap();
    concurrent(&mut room);
    assert_eq!(room.doc.styles.effects.len(), 1);
    assert_eq!(room.doc.styles.effects[0].effects[0].blur, 99.0);
    for e in &room.editors {
      assert_eq!(e.doc.styles.effects, room.doc.styles.effects);
    }
  }

  #[test]
  fn undo_of_an_effect_style_edit_keeps_the_peers_newer_changes() {
    let (mut room, _) = Room::new(2);
    let (_, mine, _) = styled_layer(&mut room.editors[0], "Mine", "G");
    sync(&mut room, 0);
    room.editors[0]
      .dispatch(Command::UpdateEffectStyle {
        id: mine.clone(),
        name: None,
        effects: Some(vec![crate::model::Effect {
          blur: 50.0,
          ..Default::default()
        }]),
        description: Some("big".into()),
      })
      .unwrap();
    sync(&mut room, 0);
    // The peer adds another style and renames mine meanwhile.
    styled_layer(&mut room.editors[1], "Theirs", "G2");
    room.editors[1]
      .dispatch(Command::UpdateEffectStyle {
        id: mine.clone(),
        name: Some("Renamed".into()),
        effects: None,
        description: None,
      })
      .unwrap();
    sync(&mut room, 1);
    room.editors[0].dispatch(Command::Undo).unwrap();
    let styles = &room.editors[0].doc.styles.effects;
    assert_eq!(styles.len(), 2, "the peer's style is still there");
    let m = styles.iter().find(|s| s.id == mine).unwrap();
    assert_eq!(m.name, "Renamed", "the peer's newer rename survives (three-way)");
    assert_eq!(m.effects[0].blur, 12.0, "my edit is undone");
    assert_eq!(m.description, "");
  }

  #[test]
  fn a_remote_variable_change_leaves_untouched_collections_shared() {
    use crate::variables::{Collection, VarKind, VarMode, Variable};
    let mut a = engine(1);
    let mode = |m: &str| VarMode {
      id: m.into(),
      name: m.into(),
    };
    let cols: Vec<Collection> = (0..3)
      .map(|c| {
        let vars = (0..5)
          .map(|i| Variable {
            id: format!("v{c}_{i}"),
            name: format!("V{i}"),
            kind: VarKind::Number,
            values: [("m".to_string(), json!(i))].into_iter().collect(),
            ..Default::default()
          })
          .collect();
        Collection::new(&format!("c{c}"), &format!("C{c}"), vec![mode("m")], vars)
      })
      .collect();
    a.dispatch(Command::SetVariables { collections: cols }).unwrap();
    let base = a.doc.clone();
    let mut edited = crate::variables::plain(&a.doc.variables);
    Arc::make_mut(&mut edited[1].variables[2]).values.insert("m".into(), json!(99));
    a.dispatch(Command::SetVariables { collections: edited }).unwrap();
    let d = delta(&base, &a.doc, true, true);
    let mut b = base.clone();
    apply(&mut b, &d).unwrap();
    assert_eq!(b.variables, a.doc.variables);
    assert!(Arc::ptr_eq(&b.variables[0], &base.variables[0]));
    assert!(Arc::ptr_eq(&b.variables[2], &base.variables[2]));
    assert!(Arc::ptr_eq(&b.variables[1].variables[0], &base.variables[1].variables[0]));
    assert!(!Arc::ptr_eq(&b.variables[1].variables[2], &base.variables[1].variables[2]));
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
  fn undo_of_a_variable_reorder_restores_the_order_and_keeps_a_peers_variable() {
    let ids = |room: &Room, i: usize| -> Vec<String> { room.editors[i].doc.variables[0].variables.iter().map(|v| v.id.clone()).collect() };
    let set = |room: &mut Room, i: usize, f: &dyn Fn(&mut Vec<Collection>)| {
      let mut cs = crate::variables::plain(&room.editors[i].doc.variables);
      f(&mut cs);
      room.editors[i].dispatch(Command::SetVariables { collections: cs }).unwrap();
      sync(room, i);
    };
    let (mut room, _) = Room::new(2);
    set(&mut room, 0, &|cs| {
      *cs = vec![
        collection("c1", vec![variable("a", &[("m1", 1.0)]), variable("b", &[("m1", 2.0)])]),
        collection("c2", vec![variable("x", &[("m1", 3.0)])]),
      ]
    });
    // Solo: undo and redo are exact, for variables and for collections.
    set(&mut room, 0, &|cs| {
      cs[0].variables.reverse();
      cs.reverse();
    });
    assert_eq!(ids(&room, 0), ["x"]);
    room.editors[0].dispatch(Command::Undo).unwrap();
    let c: Vec<&str> = room.editors[0].doc.variables.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(c, ["c1", "c2"], "collections are back in order");
    assert_eq!(ids(&room, 0), ["a", "b"], "variables are back in order");
    room.editors[0].dispatch(Command::Redo).unwrap();
    assert_eq!(
      room.editors[0].doc.variables[1]
        .variables
        .iter()
        .map(|v| v.id.as_str())
        .collect::<Vec<_>>(),
      ["b", "a"]
    );
    sync(&mut room, 0);
    // A peer adds a variable after my reorder: undoing mine keeps theirs.
    set(&mut room, 1, &|cs| {
      let n = cs.iter().position(|c| c.id == "c1").unwrap();
      cs[n].variables.push(Arc::new(variable("c", &[("m1", 4.0)])));
    });
    room.editors[0].dispatch(Command::Undo).unwrap();
    let c1 = room.editors[0].doc.variables.iter().find(|c| c.id == "c1").unwrap();
    let v: Vec<&str> = c1.variables.iter().map(|v| v.id.as_str()).collect();
    assert_eq!(v, ["a", "b", "c"], "my order is back, their variable stays");
    let c: Vec<&str> = room.editors[0].doc.variables.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(c, ["c1", "c2"]);
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

  // ---- undo keeps tokens that a layer still uses ----

  fn ai(e: &mut Engine, tool: &str, input: Value) -> Value {
    e.dispatch(Command::Ai { tool: tool.into(), input })
      .unwrap_or_else(|er| panic!("{tool}: {er}"))
  }

  fn var_id(e: &Engine, coll: &str, name: &str) -> String {
    e.doc
      .variables
      .iter()
      .find(|c| c.name == coll)
      .and_then(|c| c.variables.iter().find(|v| v.name == name))
      .unwrap_or_else(|| panic!("no variable {coll}/{name}"))
      .id
      .clone()
  }

  fn tokens(e: &Engine) -> (usize, usize) {
    (e.doc.variables.iter().map(|c| c.variables.len()).sum(), e.doc.styles.colors.len())
  }

  /// Editor 0 defines Theme/Surface (aliasing Primitives/Gray) and a colour style; editor 1
  /// binds a rectangle to them.
  fn shared_tokens(room: &mut Room) -> (String, String) {
    ai(
      &mut room.editors[0],
      "define_variables",
      json!({ "collection": "Primitives", "variables": [{ "name": "Gray", "type": "color", "value": "#111111" }] }),
    );
    ai(
      &mut room.editors[0],
      "define_variables",
      json!({ "collection": "Theme", "variables": [{ "name": "Surface", "type": "color", "value": { "alias": "Primitives/Gray" } }] }),
    );
    ai(
      &mut room.editors[0],
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#6D4AFF" }] }),
    );
    sync(room, 0);
    let r = ai(
      &mut room.editors[1],
      "create_nodes",
      json!({ "nodes": [{ "type": "rectangle", "name": "Mine", "width": 20, "height": 20,
        "bind": { "fill": "Theme/Surface" }, "fillStyle": "Brand" }] }),
    );
    let id = r["created"][0]["id"].as_str().unwrap().to_string();
    sync(room, 1);
    (id, var_id(&room.editors[1], "Theme", "Surface"))
  }

  #[test]
  fn undo_keeps_a_variable_and_style_a_peers_layer_uses() {
    let (mut room, _) = Room::new(2);
    // Undo only the style/variable steps of editor 0: three steps.
    let (mine, surface) = shared_tokens(&mut room);
    for _ in 0..3 {
      room.editors[0].dispatch(Command::Undo).unwrap();
    }
    sync(&mut room, 0);
    for e in &room.editors {
      assert!(e.doc.get(&mine).is_some(), "the peer's layer stays");
      assert_eq!(e.doc.get(&mine).unwrap().bindings.get("fill"), Some(&surface));
      assert_eq!(var_id(e, "Theme", "Surface"), surface, "the bound variable stays");
      // Reached through an alias from the kept variable.
      var_id(e, "Primitives", "Gray");
      assert_eq!(e.doc.styles.colors.len(), 1, "the style stays");
    }
    // Redo puts nothing twice.
    for _ in 0..3 {
      room.editors[0].dispatch(Command::Redo).unwrap();
    }
    sync(&mut room, 0);
    assert_eq!(tokens(&room.editors[0]), (2, 1));
    assert_eq!(tokens(&room.editors[1]), (2, 1));
  }

  #[test]
  fn undo_still_removes_tokens_nobody_uses() {
    let (mut room, _) = Room::new(1);
    ai(
      &mut room.editors[0],
      "define_variables",
      json!({ "collection": "Theme", "variables": [{ "name": "Surface", "type": "color", "value": "#111111" }] }),
    );
    ai(
      &mut room.editors[0],
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#6D4AFF" }] }),
    );
    room.editors[0].dispatch(Command::Undo).unwrap();
    room.editors[0].dispatch(Command::Undo).unwrap();
    assert_eq!(tokens(&room.editors[0]), (0, 0));
    assert!(room.editors[0].doc.variables.is_empty());
  }

  #[test]
  fn a_kept_variable_keeps_its_alias_chain_and_pinned_collection() {
    let (mut room, _) = Room::new(2);
    let (_, _) = shared_tokens(&mut room);
    // Editor 1 also pins a frame to the Theme collection's mode.
    let theme = room.editors[1].doc.variables.iter().find(|c| c.name == "Theme").unwrap().clone();
    let primitives = room.editors[1]
      .doc
      .variables
      .iter()
      .find(|c| c.name == "Primitives")
      .unwrap()
      .id
      .clone();
    for _ in 0..3 {
      room.editors[0].dispatch(Command::Undo).unwrap();
    }
    sync(&mut room, 0);
    let e = &room.editors[1];
    let kept = e.doc.variables.iter().find(|c| c.id == theme.id).unwrap();
    assert_eq!(kept.modes, theme.modes, "the collection returns with its modes");
    let gray = e
      .doc
      .variables
      .iter()
      .find(|c| c.id == primitives)
      .expect("alias target's collection");
    assert_eq!(gray.variables.len(), 1);
  }

  #[test]
  fn only_a_revert_that_drops_a_token_needs_the_reference_scan() {
    let mut a = engine(1);
    let id = rect(&mut a, 0.0, None);
    let before = a.doc.clone();
    a.dispatch(Command::Update {
      ids: vec![id],
      patch: json!({ "x": 5 }),
    })
    .unwrap();
    let after = a.doc.clone();
    assert!(!drops_tokens(&revert(&after, &after, &before), &after), "a move drops nothing");
    ai(
      &mut a,
      "define_variables",
      json!({ "collection": "Theme", "variables": [{ "name": "Surface", "type": "color", "value": "#111111" }] }),
    );
    let with_token = a.doc.clone();
    let mut undone = revert_inner(&with_token, &with_token, &after);
    assert!(drops_tokens(&undone, &with_token), "undoing a definition drops the token");
    keep_tokens_in_use(&mut undone, &with_token);
    assert!(undone.variables.is_empty(), "nothing uses it, so it goes");
  }

  #[test]
  fn redo_keeps_every_variable_of_a_partly_restored_collection() {
    let (mut room, _) = Room::new(2);
    ai(
      &mut room.editors[0],
      "define_variables",
      json!({ "collection": "Theme", "variables": [
        { "name": "Surface", "type": "color", "value": "#111111" },
        { "name": "Text", "type": "color", "value": "#EEEEEE" }] }),
    );
    sync(&mut room, 0);
    let surface = var_id(&room.editors[1], "Theme", "Surface");
    ai(
      &mut room.editors[1],
      "create_nodes",
      json!({ "nodes": [{ "type": "rectangle", "name": "Mine", "width": 20, "height": 20, "bind": { "fill": "Theme/Surface" } }] }),
    );
    sync(&mut room, 1);
    room.editors[0].dispatch(Command::Undo).unwrap();
    sync(&mut room, 0);
    for e in &room.editors {
      assert_eq!(var_id(e, "Theme", "Surface"), surface);
    }
    room.editors[0].dispatch(Command::Redo).unwrap();
    sync(&mut room, 0);
    for e in &room.editors {
      assert_eq!(tokens(e).0, 2, "Surface and Text on both editors");
      var_id(e, "Theme", "Text");
    }
  }

  #[test]
  fn a_collection_alias_into_another_dropped_collection_comes_back_whole() {
    let (mut room, _) = Room::new(2);
    let (_, surface) = shared_tokens(&mut room);
    ai(
      &mut room.editors[0],
      "define_variables",
      json!({ "collection": "Theme", "variables": [{ "name": "Text", "type": "color", "value": { "alias": "Primitives/Gray" } }] }),
    );
    sync(&mut room, 0);
    for _ in 0..4 {
      room.editors[0].dispatch(Command::Undo).unwrap();
    }
    sync(&mut room, 0);
    for e in &room.editors {
      assert_eq!(var_id(e, "Theme", "Surface"), surface);
      var_id(e, "Primitives", "Gray");
    }
  }

  #[test]
  fn undo_keeps_a_style_used_only_through_an_instance_override() {
    let (mut room, _) = Room::new(2);
    ai(
      &mut room.editors[0],
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#6D4AFF" }] }),
    );
    sync(&mut room, 0);
    let style = room.editors[1].doc.styles.colors[0].id.clone();
    let id = rect(&mut room.editors[1], 300.0, None);
    // Set directly: no command writes an override with a style link.
    room.editors[1].doc.get_mut(&id).unwrap().instance = Some(crate::model::InstanceInfo {
      component_id: "main".into(),
      overrides: [("inner".to_string(), json!({ "fillStyle": style }))].into(),
      ..Default::default()
    });
    assert!(room.editors[1].doc.get(&id).unwrap().instance.is_some(), "the override was set");
    sync(&mut room, 1);
    assert!(
      room.editors[0].doc.get(&id).unwrap().instance.is_some(),
      "and reached the other editor"
    );
    room.editors[0].dispatch(Command::Undo).unwrap();
    sync(&mut room, 0);
    for e in &room.editors {
      assert_eq!(e.doc.styles.colors.len(), 1, "the override still points at it");
    }
  }

  #[test]
  fn undoing_a_restore_keeps_a_peers_reply_and_resolve() {
    let (mut room, _) = Room::new(2);
    let snapshot: Value = serde_json::from_str(&room.editors[0].to_json()).unwrap();
    let late = rect(&mut room.editors[0], 400.0, None);
    room.editors[0]
      .dispatch(Command::AddComment {
        page: None,
        x: 405.0,
        y: 5.0,
        node: Some(late.clone()),
        text: "on late".into(),
        author: "A".into(),
        time: 1.0,
      })
      .unwrap();
    sync(&mut room, 0);
    let cid = room.editors[1].doc.comments.keys().next().unwrap().clone();
    room.editors[0]
      .dispatch(Command::ReplaceDocument {
        doc: snapshot,
        keep_comments: true,
      })
      .unwrap();
    sync(&mut room, 0);
    assert_eq!(room.editors[1].doc.comments[&cid].node, None, "re-homed as a page comment");
    room.editors[1]
      .dispatch(Command::ReplyComment {
        id: cid.clone(),
        text: "reply".into(),
        author: "B".into(),
        time: 2.0,
      })
      .unwrap();
    room.editors[1]
      .dispatch(Command::ResolveComment {
        id: cid.clone(),
        resolved: true,
      })
      .unwrap();
    sync(&mut room, 1);
    room.editors[0].dispatch(Command::Undo).unwrap();
    sync(&mut room, 0);
    for e in &room.editors {
      let c = &e.doc.comments[&cid];
      assert_eq!(c.messages.len(), 2, "the peer's reply survives");
      assert!(c.resolved, "and so does their resolve");
      assert_eq!(c.node.as_deref(), Some(late.as_str()), "attached to its layer again");
    }
  }

  #[test]
  fn undoing_a_restore_leaves_a_comment_a_peer_deleted_deleted() {
    let (mut room, _) = Room::new(2);
    let snapshot: Value = serde_json::from_str(&room.editors[0].to_json()).unwrap();
    let late = rect(&mut room.editors[0], 400.0, None);
    room.editors[0]
      .dispatch(Command::AddComment {
        page: None,
        x: 405.0,
        y: 5.0,
        node: Some(late),
        text: "on late".into(),
        author: "A".into(),
        time: 1.0,
      })
      .unwrap();
    sync(&mut room, 0);
    let cid = room.editors[1].doc.comments.keys().next().unwrap().clone();
    room.editors[0]
      .dispatch(Command::ReplaceDocument {
        doc: snapshot,
        keep_comments: true,
      })
      .unwrap();
    sync(&mut room, 0);
    room.editors[1].dispatch(Command::DeleteComment { id: cid }).unwrap();
    sync(&mut room, 1);
    room.editors[0].dispatch(Command::Undo).unwrap();
    sync(&mut room, 0);
    for e in &room.editors {
      assert!(e.doc.comments.is_empty());
    }
  }

  // ---- `lists` rooms: moves, comments per message, three-way undo, pruned references ----------

  use crate::model::CommentMessage;
  use crate::ops::ReorderTo;

  fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn moved_finds_what_a_reorder_moved() {
    let base = ids(&["a", "b", "c", "t"]);
    assert!(moved(&base, &base).is_empty());
    assert_eq!(moved(&base, &ids(&["b", "c", "t", "a"])), ["a"], "to the front");
    assert_eq!(moved(&base, &ids(&["c", "a", "b", "t"])), ["c"], "to the back");
    assert_eq!(moved(&base, &ids(&["a", "c", "b", "t"])).len(), 1, "a swap moves one");
    assert_eq!(moved(&base, &ids(&["a", "b", "c", "t", "n"])), ["n"], "an added id counts");
    assert!(moved(&base, &ids(&["a", "c", "t"])).is_empty(), "removals alone move nothing");
    assert_eq!(moved(&base, &ids(&["t", "c", "b", "a"])).len(), 3, "a reversal moves all but one");
    assert_eq!(moved(&ids(&[]), &ids(&["x", "y"])), ["x", "y"]);
    // O(n log n): a long list with one id taken to the front.
    let long: Vec<String> = (0..50_000).map(|i| format!("n{i}")).collect();
    let mut shuffled = long.clone();
    let last = shuffled.pop().unwrap();
    shuffled.insert(0, last.clone());
    assert_eq!(moved(&long, &shuffled), [last]);
  }

  #[test]
  fn place_puts_moved_ids_where_the_movers_list_has_them() {
    // The mover's own base and new list reproduce the new list exactly.
    let base = ids(&["a", "b", "c", "t"]);
    for new in [
      ids(&["b", "c", "t", "a"]),
      ids(&["c", "a", "b", "t"]),
      ids(&["a", "t", "b", "c"]),
      ids(&["t", "c", "b", "a"]),
      ids(&["a", "x", "b", "c", "t"]),
      ids(&["x", "a", "b", "c", "t", "y"]),
    ] {
      let m = moved(&base, &new);
      assert_eq!(place(&base, &new, &m), new, "{new:?}");
    }
    // Front and back stay at the ends whatever others hold meanwhile.
    let cur = ids(&["b", "c", "t", "a", "n"]);
    assert_eq!(
      place(&cur, &ids(&["c", "a", "b", "t"]), &ids(&["c"])),
      ["c", "b", "t", "a", "n"],
      "back"
    );
    assert_eq!(
      place(&ids(&["c", "a", "b", "t", "n"]), &ids(&["b", "c", "t", "a"]), &ids(&["a"])),
      ["c", "b", "t", "n", "a"],
      "front"
    );
    // A move in the middle follows the sibling it followed, else the one it preceded, else the end.
    let cur = ids(&["a", "b", "c", "t"]);
    assert_eq!(place(&cur, &ids(&["a", "t", "b", "c"]), &ids(&["t"])), ["a", "t", "b", "c"]);
    assert_eq!(
      place(&ids(&["b", "c", "t"]), &ids(&["a", "t", "b", "c"]), &ids(&["t"])),
      ["t", "b", "c"],
      "anchor gone: before the next one"
    );
    assert_eq!(
      place(&ids(&["q", "r"]), &ids(&["a", "t", "b"]), &ids(&["t"])),
      ["q", "r", "t"],
      "no anchors: the end"
    );
    // Nothing moved: the list as it is. Ids the reference doesn't hold are not moved.
    assert_eq!(place(&cur, &ids(&["t", "a"]), &[]), cur);
    assert_eq!(place(&cur, &ids(&["t", "a"]), &ids(&["zzz"])), cur);
    // Duplicates in `cur` are dropped.
    assert_eq!(place(&ids(&["a", "a", "b"]), &ids(&["a", "b"]), &[]), ["a", "b"]);
  }

  /// How an editor speaks to the room.
  #[derive(Clone, Copy, PartialEq, Debug)]
  enum Dialect {
    /// `lists`: moves, comments per message, prunes by itself.
    Lists,
    /// Per-id changes, whole child lists and comments (round 16).
    Granular,
    /// Whole lists only.
    Whole,
  }
  use Dialect::{Granular, Lists, Whole};

  /// A relay as `designotron-rooms` runs it (applies with pruning, rewrites each delta for the
  /// dialect of its receivers) and its editors, over a frame with four layers, a second frame and
  /// a layer at the top level.
  struct Hub {
    doc: Document,
    eds: Vec<Engine>,
    dialect: Vec<Dialect>,
    /// frame, A, B, C, T (the frame's children), other frame, R (top level).
    ids: Vec<String>,
    /// Messages on their way to editors, in the order the relay sent them.
    queue: std::collections::VecDeque<(usize, Value)>,
  }

  impl Hub {
    fn new(dialects: &[Dialect]) -> Hub {
      let mut first = engine(1);
      let shape = |e: &mut Engine, kind: NodeType, x: f64, parent: Option<String>| -> String {
        e.dispatch(Command::CreateShape {
          kind,
          x,
          y: 0.0,
          width: 40.0,
          height: 40.0,
          parent,
        })
        .unwrap()["id"]
          .as_str()
          .unwrap()
          .to_string()
      };
      let frame = shape(&mut first, NodeType::Frame, 0.0, None);
      let mut ids = vec![frame.clone()];
      for i in 0..4 {
        ids.push(shape(&mut first, NodeType::Rectangle, 10.0 * i as f64, Some(frame.clone())));
      }
      ids.push(shape(&mut first, NodeType::Frame, 500.0, None));
      ids.push(shape(&mut first, NodeType::Rectangle, 900.0, None));
      let json = first.to_json();
      let eds = dialects
        .iter()
        .enumerate()
        .map(|(i, d)| {
          let mut e = engine(10 + 2 * i as u64);
          e.load(&json).unwrap();
          e.collab_reset(true, *d != Whole, *d == Lists);
          e
        })
        .collect();
      Hub {
        doc: first.doc.clone(),
        eds,
        dialect: dialects.to_vec(),
        ids,
        queue: Default::default(),
      }
    }

    fn frame(&self) -> String {
      self.ids[0].clone()
    }

    fn id(&self, label: char) -> String {
      self.ids["?ABCT".find(label).unwrap()].clone()
    }

    /// Editor `i` sends its changes; the relay applies them at once and queues what each editor
    /// receives, as the room would for its dialect.
    fn send(&mut self, i: usize) {
      let d = self.eds[i].collab_delta();
      if d.get("full").is_some() || is_empty(&d) {
        return;
      }
      let d: Value = serde_json::from_str(&d.to_string()).unwrap();
      let pruned = apply_opts(&mut self.doc, &d, ApplyOpts { prune: true }).expect("the relay takes every delta");
      let lists_form = legacy_lists(&d, &self.doc, &pruned);
      let out = &mut self.queue;
      for j in 0..self.eds.len() {
        if j == i {
          out.push_back((j, json!({ "ack": true })));
          if self.dialect[i] != Lists && !pruned.is_empty() {
            out.push_back((j, legacy_lists(&json!({ "nodes": {} }), &self.doc, &pruned).unwrap()));
          }
          continue;
        }
        let m = match self.dialect[j] {
          Lists => d.clone(),
          Granular => lists_form.clone().unwrap_or_else(|| d.clone()),
          Whole => {
            let g = lists_form.clone().unwrap_or_else(|| d.clone());
            legacy(&g, &self.doc).unwrap_or(g)
          }
        };
        out.push_back((j, m));
      }
    }

    /// Delivers everything queued, in order. An editor sends what it has not sent yet before it
    /// hears anything (as the web shell does), and what it then sends queues behind the rest.
    fn deliver(&mut self) {
      while let Some((j, m)) = self.queue.pop_front() {
        self.send(j);
        let e = &mut self.eds[j];
        if m.get("ack").is_some() {
          e.dispatch(Command::CollabAck { rejected: false }).unwrap();
        } else {
          e.dispatch(Command::ApplyRemote { delta: m, local: false }).unwrap();
        }
      }
    }

    fn sync(&mut self, i: usize) {
      self.send(i);
      self.deliver();
    }

    /// Editors `first` and `second` both have unsent changes; the relay orders `first`'s first and
    /// everyone hears them in that order.
    fn race(&mut self, first: usize, second: usize) {
      self.send(first);
      self.send(second);
      self.deliver();
      self.settle();
    }

    fn settle(&mut self) {
      for i in 0..self.eds.len() {
        self.send(i);
      }
      self.deliver();
      self.assert_converged();
    }

    fn assert_converged(&self) {
      for (i, e) in self.eds.iter().enumerate() {
        for (id, n) in self.doc.nodes.iter() {
          let got = e.doc.nodes.get(id);
          assert!(
            got.is_some_and(|g| g == n),
            "editor {i} ({:?}) node {id}: room has children {:?}, editor {:?}",
            self.dialect[i],
            n.children,
            got.map(|g| g.children.clone())
          );
        }
        assert_eq!(e.doc.nodes.len(), self.doc.nodes.len(), "editor {i} node count");
        assert_eq!(e.doc.pages, self.doc.pages, "editor {i} pages");
        assert_eq!(e.doc.styles, self.doc.styles, "editor {i} styles");
        assert_eq!(e.doc.variables, self.doc.variables, "editor {i} variables");
        assert_eq!(e.doc.comments, self.doc.comments, "editor {i} comments");
      }
      self.assert_sound(&self.doc);
    }

    /// Parent and child lists agree; nothing refers to a token that is gone.
    fn assert_sound(&self, d: &Document) {
      for n in d.nodes.values() {
        for c in &n.children {
          assert_eq!(
            d.get(c).and_then(|x| x.parent.clone()).as_deref(),
            Some(n.id.as_str()),
            "child {c} of {}",
            n.id
          );
        }
        if let Some(p) = &n.parent {
          assert!(d.get(p).unwrap().children.contains(&n.id), "{} is listed by {p}", n.id);
        } else {
          assert!(d.page(&n.page).unwrap().children.contains(&n.id), "{} is on its page", n.id);
        }
      }
      let mut stale = d.clone();
      assert!(prune_refs(&mut stale, Scope::All).is_empty(), "no dangling token reference");
    }

    /// The labels of `parent`'s children ("A,B,C,T"; other ids as "?").
    fn order(&self, i: usize, parent: &str) -> String {
      let list = &self.eds[i].doc.get(parent).unwrap().children;
      list.iter().map(|c| self.label(c)).collect::<Vec<_>>().join(",")
    }

    fn label(&self, id: &str) -> String {
      match self.ids.iter().position(|x| x == id) {
        Some(1) => "A".into(),
        Some(2) => "B".into(),
        Some(3) => "C".into(),
        Some(4) => "T".into(),
        Some(5) => "F2".into(),
        Some(6) => "R".into(),
        Some(0) => "F".into(),
        _ => "?".into(),
      }
    }

    fn page_order(&self, i: usize) -> String {
      let page = self.eds[i].doc.pages[0].children.clone();
      page.iter().map(|c| self.label(c)).collect::<Vec<_>>().join(",")
    }
  }

  fn reorder(e: &mut Engine, id: &str, to: ReorderTo) {
    e.dispatch(Command::Reorder {
      ids: vec![id.to_string()],
      to,
    })
    .unwrap();
  }

  fn move_to(e: &mut Engine, id: &str, parent: Option<&str>, index: usize) {
    e.dispatch(Command::MoveToParent {
      ids: vec![id.to_string()],
      parent: parent.map(str::to_string),
      index: Some(index),
    })
    .unwrap();
  }

  /// Runs `f` once per relay order (`first`, `second`) of two editors.
  fn each_order(f: impl Fn(usize, usize)) {
    f(0, 1);
    f(1, 0);
  }

  #[test]
  fn concurrent_reorders_both_apply() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let (frame, a, c) = (h.frame(), h.id('A'), h.id('C'));
      assert_eq!(h.order(0, &frame), "A,B,C,T");
      reorder(&mut h.eds[0], &a, ReorderTo::Front);
      reorder(&mut h.eds[1], &c, ReorderTo::Back);
      h.race(x, y);
      for i in 0..3 {
        assert_eq!(h.order(i, &frame), "C,B,T,A", "editor {i}, relay order {x},{y}");
      }
    });
  }

  #[test]
  fn three_concurrent_reorders_all_apply() {
    for first in 0..3 {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let (frame, a, b, t) = (h.frame(), h.id('A'), h.id('B'), h.id('T'));
      reorder(&mut h.eds[0], &a, ReorderTo::Front);
      reorder(&mut h.eds[1], &t, ReorderTo::Back);
      reorder(&mut h.eds[2], &b, ReorderTo::Front);
      for i in [first, (first + 1) % 3, (first + 2) % 3] {
        h.send(i);
      }
      h.deliver();
      h.settle();
      let o = h.order(0, &frame);
      assert!(o.starts_with('T') && (o.ends_with('A') || o.ends_with('B')), "{o} (first {first})");
    }
  }

  #[test]
  fn a_multi_layer_reorder_and_a_third_layers_move_all_apply() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists]);
      let (frame, a, b, t) = (h.frame(), h.id('A'), h.id('B'), h.id('T'));
      h.eds[0]
        .dispatch(Command::Reorder {
          ids: vec![a, b],
          to: ReorderTo::Front,
        })
        .unwrap();
      reorder(&mut h.eds[1], &t, ReorderTo::Back);
      h.race(x, y);
      let o = h.order(0, &frame);
      // The pair that came to the front is last, T is at the back.
      assert_eq!(o, "T,C,B,A", "relay order {x},{y}");
    });
  }

  #[test]
  fn a_reorder_racing_an_added_layer_keeps_both() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists]);
      let (frame, a) = (h.frame(), h.id('A'));
      reorder(&mut h.eds[0], &a, ReorderTo::Front);
      let n = rect(&mut h.eds[1], 70.0, Some(frame.clone()));
      h.race(x, y);
      let o = &h.eds[0].doc.get(&frame).unwrap().children;
      assert_eq!(o.len(), 5);
      assert!(o.contains(&n));
      let pos = |id: &str| o.iter().position(|c| c == id).unwrap();
      assert!(pos(&a) > pos(&h.id('T')), "A is in front of what it was behind");
    });
  }

  #[test]
  fn a_reorder_racing_the_delete_of_its_anchor_lands_by_the_next_sibling() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists]);
      let (frame, a, b, t) = (h.frame(), h.id('A'), h.id('B'), h.id('T'));
      // T goes between A and B; A is deleted at the same moment.
      move_to(&mut h.eds[0], &t, Some(&frame), 1);
      assert_eq!(h.order(0, &frame), "A,T,B,C");
      h.eds[1].dispatch(Command::Delete { ids: vec![a] }).unwrap();
      h.race(x, y);
      assert_eq!(h.order(0, &frame), "T,B,C", "relay order {x},{y}");
      assert!(h.eds[0].doc.get(&b).is_some());
    });
  }

  #[test]
  fn a_reorder_racing_a_reparent_of_the_moved_layer_stays_consistent() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let (frame, other, a) = (h.frame(), h.ids[5].clone(), h.id('A'));
      reorder(&mut h.eds[0], &a, ReorderTo::Front);
      move_to(&mut h.eds[1], &a, Some(&other), 0);
      h.race(x, y);
      let parent = h.eds[2].doc.get(&a).unwrap().parent.clone();
      let in_frame = h.eds[2].doc.get(&frame).unwrap().children.contains(&a);
      let in_other = h.eds[2].doc.get(&other).unwrap().children.contains(&a);
      assert_eq!(
        (in_frame, in_other),
        (parent.as_deref() == Some(frame.as_str()), parent.as_deref() == Some(other.as_str()))
      );
    });
  }

  #[test]
  fn concurrent_top_level_reorders_both_apply() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let (frame, r) = (h.frame(), h.id('?'));
      let _ = r;
      let top = h.ids[6].clone();
      assert_eq!(h.page_order(0), "F,F2,R");
      reorder(&mut h.eds[0], &frame, ReorderTo::Front);
      reorder(&mut h.eds[1], &top, ReorderTo::Back);
      h.race(x, y);
      for i in 0..3 {
        assert_eq!(h.page_order(i), "R,F2,F", "editor {i}, relay order {x},{y}");
      }
    });
  }

  #[test]
  fn undo_of_a_reorder_keeps_a_collaborators_later_reorder() {
    // B-3: Ana brings A to the front, Ben then sends C to the back; Ana's undo puts A back and
    // leaves Ben's order alone.
    let mut h = Hub::new(&[Lists, Lists, Lists]);
    let (frame, a, c) = (h.frame(), h.id('A'), h.id('C'));
    reorder(&mut h.eds[0], &a, ReorderTo::Front);
    h.sync(0);
    reorder(&mut h.eds[1], &c, ReorderTo::Back);
    h.sync(1);
    assert_eq!(h.order(0, &frame), "C,B,T,A");
    h.eds[0].dispatch(Command::Undo).unwrap();
    h.sync(0);
    h.assert_converged();
    assert_eq!(
      h.order(2, &frame),
      "A,C,B,T",
      "A is back at the start, C is still first among the rest"
    );
    // Redo brings it to the front again.
    h.eds[0].dispatch(Command::Redo).unwrap();
    h.sync(0);
    h.assert_converged();
    assert_eq!(h.order(2, &frame), "C,B,T,A");
  }

  #[test]
  fn undo_after_a_collaborator_moved_the_same_layer_leaves_it_there() {
    let mut h = Hub::new(&[Lists, Lists]);
    let (frame, b) = (h.frame(), h.id('B'));
    reorder(&mut h.eds[0], &b, ReorderTo::Front);
    h.sync(0);
    reorder(&mut h.eds[1], &b, ReorderTo::Back);
    h.sync(1);
    assert_eq!(h.order(0, &frame), "B,A,C,T");
    h.eds[0].dispatch(Command::Undo).unwrap();
    h.sync(0);
    h.assert_converged();
    assert_eq!(h.order(1, &frame), "B,A,C,T", "Ben's move of the same layer wins");
  }

  #[test]
  fn redo_after_a_collaborators_reorder_places_the_layer_by_the_same_rule() {
    let mut h = Hub::new(&[Lists, Lists]);
    let (frame, a, c) = (h.frame(), h.id('A'), h.id('C'));
    reorder(&mut h.eds[0], &a, ReorderTo::Front);
    h.sync(0);
    h.eds[0].dispatch(Command::Undo).unwrap();
    h.sync(0);
    reorder(&mut h.eds[1], &c, ReorderTo::Back);
    h.sync(1);
    assert_eq!(h.order(0, &frame), "C,A,B,T");
    h.eds[0].dispatch(Command::Redo).unwrap();
    h.sync(0);
    h.assert_converged();
    assert_eq!(h.order(1, &frame), "C,B,T,A");
  }

  #[test]
  fn undo_and_redo_of_reorders_are_exact_when_nobody_else_edits() {
    let mut h = Hub::new(&[Lists, Lists]);
    let (frame, a, b, t) = (h.frame(), h.id('A'), h.id('B'), h.id('T'));
    let start = h.eds[0].doc.clone();
    let mut states = vec![start.clone()];
    for (id, to) in [(&a, ReorderTo::Front), (&t, ReorderTo::Back), (&b, ReorderTo::Forward)] {
      reorder(&mut h.eds[0], id, to);
      states.push(h.eds[0].doc.clone());
    }
    // The pure merge, with nobody else's change in the way, is exact too (what undo does after a sync).
    for i in (1..states.len()).rev() {
      let back = revert(&states[i], &states[i], &states[i - 1]);
      assert_eq!(back.nodes, states[i - 1].nodes, "revert {i}");
      assert_eq!(back.pages, states[i - 1].pages, "revert {i} pages");
      let fwd = revert(&states[i - 1], &states[i - 1], &states[i]);
      assert_eq!(fwd.nodes, states[i].nodes, "forward {i}");
    }
    h.sync(0);
    for i in (0..3).rev() {
      h.eds[0].dispatch(Command::Undo).unwrap();
      h.sync(0);
      assert_eq!(h.eds[0].doc.nodes, states[i].nodes);
    }
    h.assert_converged();
    assert_eq!(h.order(1, &frame), "A,B,C,T");
    for want in states.iter().skip(1).take(3) {
      h.eds[0].dispatch(Command::Redo).unwrap();
      h.sync(0);
      assert_eq!(h.eds[0].doc.nodes, want.nodes);
    }
    h.assert_converged();
  }

  #[test]
  fn undo_of_a_top_level_reorder_keeps_the_peers_later_reorder() {
    let mut h = Hub::new(&[Lists, Lists]);
    let (frame, top) = (h.frame(), h.ids[6].clone());
    reorder(&mut h.eds[0], &frame, ReorderTo::Front);
    h.sync(0);
    reorder(&mut h.eds[1], &top, ReorderTo::Back);
    h.sync(1);
    assert_eq!(h.page_order(0), "R,F2,F");
    h.eds[0].dispatch(Command::Undo).unwrap();
    h.sync(0);
    h.assert_converged();
    assert_eq!(h.page_order(1), "F,R,F2", "F is back in front of the others, R stays first of them");
  }

  #[test]
  fn an_old_editors_whole_order_still_applies_in_a_lists_room() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Whole, Granular]);
      let (frame, a, c) = (h.frame(), h.id('A'), h.id('C'));
      reorder(&mut h.eds[0], &a, ReorderTo::Front);
      reorder(&mut h.eds[1], &c, ReorderTo::Back);
      h.race(x, y);
      let o = h.order(2, &frame);
      // The old editor's whole list is the last writer's, the new one's move is placed.
      assert!(matches!(o.as_str(), "C,B,T,A" | "C,A,B,T" | "B,C,T,A"), "{o}");
      for i in 0..3 {
        assert_eq!(h.order(i, &frame), o);
      }
    });
  }

  #[test]
  fn bring_forward_and_a_peers_send_to_back_both_apply_in_either_relay_order() {
    // C1: B one step forward is B moving, not its neighbour C.
    {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let (frame, b) = (h.frame(), h.id('B'));
      reorder(&mut h.eds[0], &b, ReorderTo::Forward);
      let d = h.eds[0].collab_delta();
      assert_eq!(d["moves"][&frame], json!([b]), "the layer the person moved is the one named");
    }
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let (frame, b, t) = (h.frame(), h.id('B'), h.id('T'));
      reorder(&mut h.eds[0], &b, ReorderTo::Forward);
      reorder(&mut h.eds[1], &t, ReorderTo::Back);
      h.race(x, y);
      for i in 0..3 {
        assert_eq!(h.order(i, &frame), "T,A,C,B", "editor {i}, relay order {x},{y}");
      }
    });
  }

  #[test]
  fn a_command_that_changed_nothing_leaves_no_hint_behind() {
    // LEAK: A to the back while it is there (nothing changes), then B one step backward: the
    // delta names B only, so a peer bringing A to the front at once is not overridden.
    for (x, y) in [(0, 1), (1, 0)] {
      let mut h = Hub::new(&[Lists, Lists]);
      let (frame, a, b) = (h.frame(), h.id('A'), h.id('B'));
      reorder(&mut h.eds[0], &a, ReorderTo::Back);
      reorder(&mut h.eds[0], &b, ReorderTo::Backward);
      assert_eq!(h.order(0, &frame), "B,A,C,T");
      let d = h.eds[0].collab_delta();
      assert_eq!(d["moves"][&frame], json!([b]), "only the layer that moved");
      // Again, for real, with the peer.
      let mut h = Hub::new(&[Lists, Lists]);
      reorder(&mut h.eds[0], &a, ReorderTo::Back);
      reorder(&mut h.eds[0], &b, ReorderTo::Backward);
      reorder(&mut h.eds[1], &a, ReorderTo::Front);
      h.race(x, y);
      assert_eq!(h.order(0, &frame), "B,C,T,A", "relay order {x},{y}: A is in front, B stepped back");
    }
  }

  #[test]
  fn a_failed_command_and_what_was_moved_before_joining_leave_no_hint() {
    let mut h = Hub::new(&[Lists]);
    let frame = h.frame();
    // A move into itself fails and names nothing.
    let _ = h.eds[0].dispatch(Command::MoveToParent {
      ids: vec![frame.clone()],
      parent: Some(frame.clone()),
      index: None,
    });
    assert!(h.eds[0].collab_delta().get("moves").is_none());
    // Moved while alone, then the baseline starts: the first delta names only what moved after.
    let mut e = engine(5);
    let first = rect(&mut e, 0.0, None);
    let second = rect(&mut e, 20.0, None);
    reorder(&mut e, &first, ReorderTo::Front);
    e.collab_reset(true, true, true);
    reorder(&mut e, &second, ReorderTo::Front);
    let d = e.collab_delta();
    let page = e.doc.pages[0].id.clone();
    assert_eq!(d["pageMoves"][&page], json!([second]), "{d}");
  }

  #[test]
  fn undoing_a_send_backward_after_a_peer_moved_another_layer_puts_the_layer_back() {
    let mut h = Hub::new(&[Lists, Lists]);
    let (frame, b, c) = (h.frame(), h.id('B'), h.id('C'));
    reorder(&mut h.eds[0], &c, ReorderTo::Backward); // A,C,B,T
    h.sync(0);
    reorder(&mut h.eds[1], &b, ReorderTo::Front); // A,C,T,B
    h.sync(1);
    assert_eq!(h.order(0, &frame), "A,C,T,B");
    h.eds[0].dispatch(Command::Undo).unwrap();
    h.sync(0);
    h.assert_converged();
    assert_eq!(h.order(1, &frame), "A,T,B,C", "C goes back behind B, Ben's move of B stays");
    h.eds[0].dispatch(Command::Redo).unwrap();
    h.sync(0);
    h.assert_converged();
  }

  #[test]
  fn a_hint_only_breaks_ties_between_equally_long_runs() {
    let base = ids(&["a", "b", "x", "c"]);
    let new = ids(&["a", "b", "c", "x"]);
    assert_eq!(moved(&base, &new), ["c"], "alone, the neighbour is what stays out of the run");
    let hint: HashSet<String> = ["x".to_string()].into();
    assert_eq!(moved_hinted(&base, &new, &hint), ["x"]);
    for h in [vec!["x"], vec!["c"], vec!["a", "b", "x", "c"], vec![]] {
      let hint: HashSet<String> = h.iter().map(|s| s.to_string()).collect();
      let m = moved_hinted(&base, &new, &hint);
      assert_eq!(m.len(), 1, "the smallest set, whatever the hint: {h:?}");
      assert_eq!(place(&base, &new, &m), new, "{h:?}");
    }
  }

  /// A small deterministic generator for the property tests.
  fn lcg(seed: &mut u64) -> usize {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (*seed >> 33) as usize
  }

  #[test]
  fn hinted_moves_are_as_small_as_unhinted_ones_and_exact() {
    let mut seed = 99;
    for _ in 0..2000 {
      let n = 2 + lcg(&mut seed) % 9;
      let base: Vec<String> = (0..n).map(|i| format!("n{i}")).collect();
      let mut new = base.clone();
      for i in (1..n).rev() {
        new.swap(i, lcg(&mut seed) % (i + 1));
      }
      if lcg(&mut seed).is_multiple_of(3) {
        new.push("added".into());
      }
      let hint: HashSet<String> = base.iter().filter(|_| lcg(&mut seed).is_multiple_of(2)).cloned().collect();
      let m = moved_hinted(&base, &new, &hint);
      assert_eq!(m.len(), moved(&base, &new).len(), "{base:?} {new:?} {hint:?}");
      assert_eq!(place(&base, &new, &m), new, "{base:?} {new:?} {hint:?}");
    }
  }

  #[test]
  fn the_indexed_place_matches_the_plain_one() {
    let mut seed = 7;
    for _ in 0..3000 {
      let n = lcg(&mut seed) % 9;
      let pool: Vec<String> = (0..12).map(|i| format!("n{i}")).collect();
      let pick = |seed: &mut u64, k: usize| -> Vec<String> {
        let mut v: Vec<String> = pool.iter().filter(|_| lcg(seed) % 12 < k).cloned().collect();
        for i in (1..v.len()).rev() {
          v.swap(i, lcg(seed) % (i + 1));
        }
        v
      };
      let cur = pick(&mut seed, 3 + n % 6);
      let reference = pick(&mut seed, 3 + n % 6);
      let moved: Vec<String> = pool.iter().filter(|_| lcg(&mut seed).is_multiple_of(3)).cloned().collect();
      assert_eq!(
        place(&cur, &reference, &moved),
        place_slow(&cur, &reference, &moved),
        "{cur:?} {reference:?} {moved:?}"
      );
    }
  }

  #[test]
  fn place_stays_fast_when_everything_interleaves() {
    let n = 10_000;
    let cur: Vec<String> = (0..n).map(|i| format!("n{i}")).collect();
    let mut reference: Vec<String> = Vec::new();
    for i in 0..n / 2 {
      reference.push(cur[i].clone());
      reference.push(cur[n - 1 - i].clone());
    }
    let m = moved(&cur, &reference);
    let t = std::time::Instant::now();
    assert_eq!(place(&cur, &reference, &m), reference);
    assert!(t.elapsed() < std::time::Duration::from_millis(150), "{:?}", t.elapsed());
  }

  #[test]
  fn a_malformed_comment_change_applies_nothing() {
    let (mut h, _) = (Hub::new(&[Lists]), 0);
    let a = h.id('A');
    let cid = add_comment(&mut h.eds[0], &a, "Q1", "Ana", 1.0);
    h.sync(0);
    let before = h.doc.clone();
    let node = serde_json::to_value(h.doc.get(&a).unwrap()).unwrap();
    for bad in [
      json!({ cid.clone(): { "add": [5] } }),
      json!({ cid.clone(): { "del": [["x"]] } }),
      json!({ cid.clone(): { "del": [5] } }),
    ] {
      let mut doc = before.clone();
      let mut n2 = node.clone();
      n2["x"] = json!(321.0);
      let d = json!({ "nodes": {}, "patch": { a.clone(): { "x": 321.0 } }, "commentChanges": bad });
      assert!(apply_opts(&mut doc, &d, ApplyOpts { prune: true }).is_err(), "{bad}");
      assert!(doc == before, "a failed delta leaves the document as it was: {bad}");
    }
    // The same delta without the bad part applies.
    let mut doc = before.clone();
    apply(&mut doc, &json!({ "patch": { a.clone(): { "x": 321.0 } } })).unwrap();
    assert_eq!(doc.get(&a).unwrap().x, 321.0);
  }

  fn add_comment(e: &mut Engine, node: &str, text: &str, author: &str, time: f64) -> String {
    e.dispatch(Command::AddComment {
      page: None,
      x: 5.0,
      y: 5.0,
      node: Some(node.to_string()),
      text: text.into(),
      author: author.into(),
      time,
    })
    .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string()
  }

  fn reply(e: &mut Engine, id: &str, text: &str, author: &str, time: f64) {
    e.dispatch(Command::ReplyComment {
      id: id.into(),
      text: text.into(),
      author: author.into(),
      time,
    })
    .unwrap();
  }

  fn texts(h: &Hub, i: usize, id: &str) -> Vec<String> {
    h.eds[i].doc.comments[id].messages.iter().map(|m| m.text.clone()).collect()
  }

  #[test]
  fn concurrent_replies_both_stay_in_the_relays_order() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let a = h.id('A');
      let cid = add_comment(&mut h.eds[0], &a, "Q1", "Ana", 1.0);
      h.sync(0);
      // Client clocks disagree with the relay's order on purpose.
      reply(&mut h.eds[1], &cid, "BEN-1", "Ben", 50.0);
      reply(&mut h.eds[2], &cid, "CAI-1", "Cai", 10.0);
      h.race(x + 1, y + 1);
      let want = if x == 0 {
        ["Q1", "BEN-1", "CAI-1"]
      } else {
        ["Q1", "CAI-1", "BEN-1"]
      };
      for i in 0..3 {
        assert_eq!(texts(&h, i, &cid), want, "editor {i}, relay order {x},{y}");
      }
    });
  }

  #[test]
  fn three_concurrent_replies_all_stay() {
    for first in 0..3 {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let a = h.id('A');
      let cid = add_comment(&mut h.eds[0], &a, "Q", "Ana", 1.0);
      h.sync(0);
      for (i, who) in ["Ana", "Ben", "Cai"].iter().enumerate() {
        reply(&mut h.eds[i], &cid, &format!("R-{who}"), who, 5.0);
      }
      for i in [first, (first + 1) % 3, (first + 2) % 3] {
        h.send(i);
      }
      h.deliver();
      h.settle();
      let got = texts(&h, 0, &cid);
      assert_eq!(got.len(), 4, "{got:?}");
      assert_eq!(got[1], format!("R-{}", ["Ana", "Ben", "Cai"][first]), "the relay's order: {got:?}");
      for i in 1..3 {
        assert_eq!(texts(&h, i, &cid), got);
      }
    }
  }

  #[test]
  fn undoing_my_reply_removes_only_mine() {
    let mut h = Hub::new(&[Lists, Lists, Lists]);
    let a = h.id('A');
    let cid = add_comment(&mut h.eds[0], &a, "Q1", "Ana", 1.0);
    h.sync(0);
    reply(&mut h.eds[1], &cid, "BEN-1", "Ben", 2.0);
    h.sync(1);
    reply(&mut h.eds[2], &cid, "CAI-1", "Cai", 3.0);
    h.sync(2);
    h.eds[1].dispatch(Command::Undo).unwrap();
    h.sync(1);
    h.assert_converged();
    assert_eq!(texts(&h, 0, &cid), ["Q1", "CAI-1"]);
    h.eds[1].dispatch(Command::Redo).unwrap();
    h.sync(1);
    h.assert_converged();
    assert_eq!(texts(&h, 2, &cid), ["Q1", "CAI-1", "BEN-1"], "back at the end, as a reply is");
  }

  #[test]
  fn undoing_my_reply_when_a_peer_replied_after_and_at_the_same_time() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let a = h.id('A');
      let cid = add_comment(&mut h.eds[0], &a, "Q1", "Ana", 1.0);
      h.sync(0);
      reply(&mut h.eds[1], &cid, "BEN-1", "Ben", 2.0);
      reply(&mut h.eds[2], &cid, "CAI-1", "Cai", 2.0);
      h.race(x + 1, y + 1);
      h.eds[1].dispatch(Command::Undo).unwrap();
      h.sync(1);
      h.assert_converged();
      assert_eq!(texts(&h, 0, &cid), ["Q1", "CAI-1"]);
    });
  }

  #[test]
  fn resolving_and_replying_at_once_both_stick() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let a = h.id('A');
      let cid = add_comment(&mut h.eds[0], &a, "Q1", "Ana", 1.0);
      h.sync(0);
      h.eds[0]
        .dispatch(Command::ResolveComment {
          id: cid.clone(),
          resolved: true,
        })
        .unwrap();
      reply(&mut h.eds[1], &cid, "BEN-1", "Ben", 2.0);
      h.race(x, y);
      for i in 0..3 {
        let c = &h.eds[i].doc.comments[&cid];
        assert!(c.resolved && c.messages.len() == 2, "editor {i}: {c:?}");
      }
    });
  }

  #[test]
  fn a_reply_racing_the_threads_deletion_stays_deleted() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let a = h.id('A');
      let cid = add_comment(&mut h.eds[0], &a, "Q1", "Ana", 1.0);
      h.sync(0);
      h.eds[0].dispatch(Command::DeleteComment { id: cid.clone() }).unwrap();
      reply(&mut h.eds[1], &cid, "BEN-1", "Ben", 2.0);
      h.race(x, y);
      for i in 0..3 {
        assert!(h.eds[i].doc.comments.is_empty(), "editor {i}");
      }
    });
  }

  #[test]
  fn a_reply_only_delta_is_not_empty() {
    let mut h = Hub::new(&[Lists, Lists]);
    let a = h.id('A');
    let cid = add_comment(&mut h.eds[0], &a, "Q1", "Ana", 1.0);
    h.sync(0);
    reply(&mut h.eds[1], &cid, "BEN-1", "Ben", 2.0);
    let d = h.eds[1].collab_delta();
    assert!(!is_empty(&d), "{d}");
    assert_eq!(d["commentChanges"][&cid]["add"][0]["text"], "BEN-1");
    assert!(d["comments"].as_object().unwrap().is_empty(), "the thread itself isn't resent");
    assert!(!is_empty(&json!({ "moves": { "n": ["a"] } })));
    assert!(!is_empty(&json!({ "pageMoves": { "p": [] } })));
    assert!(is_empty(&json!({ "moves": {}, "pageMoves": {}, "commentChanges": {} })));
  }

  #[test]
  fn comment_changes_set_fields_and_remove_messages() {
    let mk = |msgs: &[(&str, f64)]| Comment {
      id: "c".into(),
      page: "p".into(),
      messages: msgs
        .iter()
        .map(|(t, time)| CommentMessage {
          author: "x".into(),
          text: t.to_string(),
          time: *time,
        })
        .collect(),
      ..Default::default()
    };
    let base = mk(&[("one", 1.0), ("two", 2.0)]);
    let mut moved_c = mk(&[("two", 2.0), ("three", 3.0)]);
    moved_c.x = 7.0;
    moved_c.resolved = true;
    moved_c.node = Some("n".into());
    let ch = comment_changes(&base, &moved_c).unwrap();
    assert_eq!(ch["set"], json!({ "resolved": true, "x": 7.0, "node": "n" }));
    assert_eq!(ch["add"].as_array().unwrap().len(), 1);
    assert_eq!(ch["del"], json!([["x", 1.0, "one"]]));
    let mut doc = engine(1).doc.clone();
    doc.comments_mut().insert("c".into(), base.clone());
    apply_comment_changes(&mut doc, json!({ "c": ch, "gone": { "add": [] } }).as_object().unwrap()).unwrap();
    assert_eq!(doc.comments["c"], moved_c);
    // Applying it twice changes nothing (a message is added once).
    let again = comment_changes(&base, &moved_c).unwrap();
    apply_comment_changes(&mut doc, json!({ "c": again }).as_object().unwrap()).unwrap();
    assert_eq!(doc.comments["c"], moved_c);
    assert!(comment_changes(&base, &base).is_none());
  }

  /// A color variable plus a rectangle that can be bound to it, shared with everyone.
  fn with_variable(h: &mut Hub) -> (String, String) {
    ai(
      &mut h.eds[0],
      "define_variables",
      json!({ "collection": "Theme", "variables": [{ "name": "Ink", "type": "color", "value": "#112233" }] }),
    );
    h.sync(0);
    for i in 1..h.eds.len() {
      h.sync(i);
    }
    (var_id(&h.eds[0], "Theme", "Ink"), h.id('A'))
  }

  fn without_variables(e: &Engine, keep_var: Option<&str>) -> Vec<Collection> {
    let mut cs = crate::variables::plain(&e.doc.variables);
    for c in &mut cs {
      c.variables.retain(|v| Some(v.id.as_str()) == keep_var);
    }
    cs
  }

  fn bind(e: &mut Engine, id: &str, var: &str) {
    e.dispatch(Command::BindVariable {
      ids: vec![id.to_string()],
      property: "fill".into(),
      variable: Some(var.to_string()),
    })
    .unwrap();
  }

  #[test]
  fn deleting_a_variable_while_someone_binds_it_leaves_no_dangling_id() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      let (ink, a) = with_variable(&mut h);
      let cs = without_variables(&h.eds[0], None);
      h.eds[0].dispatch(Command::SetVariables { collections: cs }).unwrap();
      bind(&mut h.eds[1], &a, &ink);
      h.race(x, y);
      for i in 0..3 {
        let n = h.eds[i].doc.get(&a).unwrap();
        assert!(n.bindings.is_empty(), "editor {i}, relay order {x},{y}: {:?}", n.bindings);
        assert_eq!(colour(&h.eds[i], &a), "#112233", "the layer keeps the colour it showed");
      }
      // A later change of that layer still reaches everyone.
      set(&mut h.eds[2], &a, json!({ "x": 333.0 }));
      h.settle();
      assert_eq!(h.eds[0].doc.get(&a).unwrap().x, 333.0);
    });
  }

  #[test]
  fn deleting_a_collection_while_someone_binds_into_it_unbinds_everywhere() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists]);
      let (ink, a) = with_variable(&mut h);
      h.eds[0].dispatch(Command::SetVariables { collections: vec![] }).unwrap();
      bind(&mut h.eds[1], &a, &ink);
      h.race(x, y);
      assert!(h.doc.variables.is_empty());
      assert!(h.eds[1].doc.get(&a).unwrap().bindings.is_empty());
    });
  }

  #[test]
  fn deleting_a_mode_while_a_frame_is_pinned_to_it_unpins_everywhere() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists]);
      ai(
        &mut h.eds[0],
        "define_variables",
        json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [{ "name": "Ink", "type": "color", "values": { "Light": "#FFFFFF", "Dark": "#000000" } }] }),
      );
      h.sync(0);
      h.sync(1);
      let coll = h.eds[0].doc.variables[0].clone();
      let dark = coll.modes[1].id.clone();
      let frame = h.frame();
      let mut cs = crate::variables::plain(&h.eds[0].doc.variables);
      cs[0].modes.truncate(1);
      h.eds[0].dispatch(Command::SetVariables { collections: cs }).unwrap();
      h.eds[1]
        .dispatch(Command::SetVariableMode {
          ids: vec![frame.clone()],
          collection: coll.id.clone(),
          mode: Some(dark),
        })
        .unwrap();
      h.race(x, y);
      for i in 0..2 {
        assert!(h.eds[i].doc.get(&frame).unwrap().variable_modes.is_empty(), "editor {i}");
      }
    });
  }

  #[test]
  fn deleting_a_style_while_someone_applies_it_leaves_the_fill_and_no_link() {
    each_order(|x, y| {
      let mut h = Hub::new(&[Lists, Lists, Lists]);
      ai(
        &mut h.eds[0],
        "define_styles",
        json!({ "colors": [{ "name": "Tmp", "color": "#FF00FF" }] }),
      );
      h.sync(0);
      let sid = h.eds[0].doc.styles.colors[0].id.clone();
      let a = h.id('A');
      h.eds[0].dispatch(Command::DeleteStyle { id: sid.clone() }).unwrap();
      h.eds[1]
        .dispatch(Command::ApplyStyle {
          ids: vec![a.clone()],
          style_id: sid,
          kind: None,
        })
        .unwrap();
      h.race(x, y);
      for i in 0..3 {
        assert_eq!(h.eds[i].doc.get(&a).unwrap().fill_style, None, "editor {i}, relay order {x},{y}");
        assert!(h.eds[i].doc.styles.colors.is_empty());
      }
      assert_eq!(
        colour(&h.eds[2], &a),
        "#FF00FF",
        "it keeps the colour the style gave it (if the apply came first)"
      );
    });
  }

  fn override_instance(e: &mut Engine, id: &str, overrides: Value) {
    // Set directly: no command writes an override with a style link or a binding to a variable.
    e.doc.get_mut(id).unwrap().instance = Some(crate::model::InstanceInfo {
      component_id: "main".into(),
      overrides: overrides.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
      ..Default::default()
    });
  }

  #[test]
  fn instance_overrides_lose_links_to_deleted_tokens_too() {
    let mut h = Hub::new(&[Lists, Lists]);
    let (ink, _) = with_variable(&mut h);
    ai(
      &mut h.eds[0],
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#6D4AFF" }] }),
    );
    h.sync(0);
    h.sync(1);
    let style = h.eds[0].doc.styles.colors[0].id.clone();
    let coll = h.eds[0].doc.variables[0].id.clone();
    let inst = h.id('B');
    let rec = json!({
      "inner": { "bindings": { "fill": ink, "stroke": null }, "fillStyle": style, "textStyle": "gone", "fills": [{ "type": "solid", "color": "#010203" }],
        "variableModes": { coll.clone(): "no-such-mode" } },
      "nested": { "instance": { "componentId": "m2", "overrides": { "deep": { "bindings": { "fill": ink }, "strokeStyle": style } } } }
    });
    override_instance(&mut h.eds[1], &inst, rec);
    h.sync(1);
    // Scrubbed on arrival (the dead textStyle and mode) everywhere, by every copy the same way.
    for i in 0..2 {
      let o = &h.eds[i].doc.get(&inst).unwrap().instance.as_ref().unwrap().overrides;
      assert!(o["inner"].get("textStyle").is_none(), "editor {i}");
      assert!(o["inner"].get("variableModes").is_none(), "editor {i}");
      assert_eq!(o["inner"]["bindings"]["fill"], json!(ink));
    }
    h.assert_converged();
    // Deleting the variable and the style cleans the overrides, and keeps the `null` record.
    let cs = without_variables(&h.eds[0], None);
    h.eds[0].dispatch(Command::SetVariables { collections: cs }).unwrap();
    h.eds[0].dispatch(Command::DeleteStyle { id: style }).unwrap();
    h.settle();
    for i in 0..2 {
      let o = &h.eds[i].doc.get(&inst).unwrap().instance.as_ref().unwrap().overrides;
      assert_eq!(
        o["inner"]["bindings"],
        json!({ "stroke": null }),
        "editor {i}: null stays, the link goes"
      );
      assert!(o["inner"].get("fillStyle").is_none());
      assert_eq!(o["inner"]["fills"][0]["color"], "#010203", "literal values stay");
      let inner = &o["nested"]["instance"]["overrides"];
      assert!(inner.get("deep").is_none(), "{inner}");
    }
  }

  #[test]
  fn local_delete_style_clears_override_style_keys_too() {
    let mut e = engine(1);
    let id = rect(&mut e, 0.0, None);
    ai(
      &mut e,
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#6D4AFF" }] }),
    );
    let style = e.doc.styles.colors[0].id.clone();
    e.doc.get_mut(&id).unwrap().instance = Some(crate::model::InstanceInfo {
      component_id: "main".into(),
      overrides: [("inner".to_string(), json!({ "fillStyle": style, "effectStyle": "gone" }))].into(),
      ..Default::default()
    });
    // Any command that touches the layer drops what points at nothing.
    set(&mut e, &id, json!({ "x": 3.0 }));
    assert!(e.doc.get(&id).unwrap().instance.as_ref().unwrap().overrides["inner"]
      .get("effectStyle")
      .is_none());
    e.dispatch(Command::DeleteStyle { id: style }).unwrap();
    let o = &e.doc.get(&id).unwrap().instance.as_ref().unwrap().overrides;
    assert!(o.get("inner").is_none(), "{o:?}");
    // And it undoes with the delete.
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.get(&id).unwrap().instance.as_ref().unwrap().overrides["inner"]
      .get("fillStyle")
      .is_some());
  }

  #[test]
  fn local_binding_to_a_missing_variable_is_pruned_like_a_receivers() {
    let mut e = engine(1);
    let id = rect(&mut e, 0.0, None);
    set(&mut e, &id, json!({ "bindings": { "fill": "nope" }, "fillStyle": "nope" }));
    let n = e.doc.get(&id).unwrap();
    assert!(n.bindings.is_empty() && n.fill_style.is_none());
  }

  #[test]
  fn the_whole_document_is_scanned_only_when_a_token_disappears() {
    let mut h = Hub::new(&[Lists, Lists]);
    let (ink, a) = with_variable(&mut h);
    bind(&mut h.eds[1], &a, &ink);
    h.sync(1);
    h.sync(0);
    let scans = || ALL_SCANS.with(|c| c.get());
    // A move, a rename of the variable, a new variable and a new style remove nothing.
    let before = scans();
    set(&mut h.eds[0], &a, json!({ "x": 9.0 }));
    h.sync(0);
    ai(
      &mut h.eds[0],
      "define_variables",
      json!({ "collection": "Theme", "variables": [{ "name": "Ink 2", "type": "color", "value": "#000000" }] }),
    );
    h.sync(0);
    ai(
      &mut h.eds[0],
      "define_styles",
      json!({ "colors": [{ "name": "S", "color": "#FF0000" }] }),
    );
    h.sync(0);
    assert_eq!(scans(), before, "no token went away: no full scan, here or at the receiver");
    // Deleting one scans on the editor that deletes it and on every receiver.
    let cs = without_variables(&h.eds[0], Some(&var_id(&h.eds[0], "Theme", "Ink 2")));
    h.eds[0].dispatch(Command::SetVariables { collections: cs }).unwrap();
    assert!(scans() > before, "the deleter scans");
    let mid = scans();
    h.sync(0);
    assert!(scans() > mid, "and so does the room and a receiver");
    assert!(h.eds[1].doc.get(&a).unwrap().bindings.is_empty());
  }

  #[test]
  fn legacy_lists_rewrites_moves_comments_and_pruned_layers_whole() {
    let mut h = Hub::new(&[Lists, Lists]);
    let (frame, a, b) = (h.frame(), h.id('A'), h.id('B'));
    let cid = add_comment(&mut h.eds[0], &a, "Q1", "Ana", 1.0);
    h.sync(0);
    h.sync(1);
    reorder(&mut h.eds[0], &a, ReorderTo::Front);
    reply(&mut h.eds[0], &cid, "R1", "Ana", 2.0);
    let d = h.eds[0].collab_delta();
    assert!(d["moves"][&frame].is_array() && d["commentChanges"][&cid].is_object());
    apply(&mut h.doc, &d).unwrap();
    assert!(
      legacy_lists(&json!({ "nodes": {}, "removed": [] }), &h.doc, &[]).is_none(),
      "nothing to rewrite"
    );
    let old = legacy_lists(&d, &h.doc, std::slice::from_ref(&b)).unwrap();
    assert!(old.get("moves").is_none() && old.get("commentChanges").is_none());
    assert_eq!(old["patch"][&frame]["children"], json!(h.doc.get(&frame).unwrap().children));
    assert_eq!(old["comments"][&cid]["messages"].as_array().unwrap().len(), 2, "the whole thread");
    assert_eq!(old["nodes"][&b]["id"], json!(b), "a pruned layer travels whole");
    assert!(old["patch"].get(&b).is_none());
    // A comment that is gone becomes a removal.
    let mut gone = h.doc.clone();
    gone.comments_mut().remove(&cid);
    let old = legacy_lists(&d, &gone, &[]).unwrap();
    assert_eq!(old["commentsRemoved"], json!([cid]));
    assert!(old["comments"].get(&cid).is_none());
  }

  #[test]
  fn editors_of_every_dialect_converge_on_reorders_replies_and_prunes() {
    for dialects in [
      [Lists, Lists, Granular],
      [Lists, Granular, Lists],
      [Lists, Lists, Whole],
      [Granular, Lists, Whole],
      [Granular, Granular, Whole],
    ] {
      for (x, y) in [(0, 1), (1, 0), (2, 0)] {
        let mut h = Hub::new(&dialects);
        let (frame, a, c, b) = (h.frame(), h.id('A'), h.id('C'), h.id('B'));
        let cid = add_comment(&mut h.eds[0], &a, "Q1", "Ana", 1.0);
        let (ink, _) = with_variable(&mut h);
        h.settle();
        reorder(&mut h.eds[0], &a, ReorderTo::Front);
        reply(&mut h.eds[1], &cid, "BEN", "Ben", 2.0);
        reorder(&mut h.eds[2], &c, ReorderTo::Back);
        let cs = without_variables(&h.eds[0], None);
        h.eds[0].dispatch(Command::SetVariables { collections: cs }).unwrap();
        bind(&mut h.eds[1], &b, &ink);
        h.race(x, y);
        h.settle();
        let o = h.order(0, &frame);
        assert_eq!(o.len(), 7, "{o} {dialects:?}");
        for i in 1..3 {
          assert_eq!(h.order(i, &frame), o, "{dialects:?} {x},{y}");
        }
        assert!(!texts(&h, 2, &cid).is_empty() && texts(&h, 0, &cid)[0] == "Q1");
        assert!(h.eds[0].doc.get(&b).unwrap().bindings.is_empty(), "{dialects:?} {x},{y}");
        // Nothing is lost for the dialects that speak lists: both replies and moves stay.
        if dialects[1] == Lists {
          assert!(texts(&h, 0, &cid).contains(&"BEN".to_string()), "{dialects:?} {x},{y}");
        }
      }
    }
  }

  #[test]
  fn editors_that_never_heard_of_lists_behave_as_before() {
    // A room without `lists` (a relay from before): whole lists, last writer wins, converged.
    let (mut room, a) = Room::new(2);
    let c = rect(&mut room.editors[0], 20.0, None);
    let d = rect(&mut room.editors[0], 40.0, None);
    sync(&mut room, 0);
    sync(&mut room, 1);
    reorder(&mut room.editors[0], &a, ReorderTo::Front);
    reorder(&mut room.editors[1], &d, ReorderTo::Back);
    let from_a = room.send(0);
    let from_b = room.send(1);
    for m in from_a.into_iter().chain(from_b) {
      room.receive(m);
    }
    room.assert_converged();
    let page = room.editors[0].doc.page(&room.editors[0].page).unwrap();
    assert_eq!(page.children, [d.clone(), a.clone(), c.clone()], "the later change decides");
    assert!(
      room.editors.iter().all(|e| !e.collab_lists),
      "a room without lists is not asked for them"
    );
    assert!(room.editors[0].collab_delta().get("moves").is_none());
    // Their deltas carry no moves or comment changes, whatever they change.
    reorder(&mut room.editors[0], &a, ReorderTo::Back);
    let d = room.editors[0].collab_delta();
    assert!(
      d.get("moves").is_none() && d.get("pageMoves").is_none() && d.get("commentChanges").is_none(),
      "{d}"
    );
  }
}
