//! Components, instances, overrides and variants.
//!
//! Instances own real child nodes (copies of the main component) so rendering,
//! hit-testing and code generation treat them like frames. Each copied node
//! remembers its `master_id`; edits made inside an instance are recorded as
//! overrides on the outermost instance (keyed by that `master_id`) and re-applied
//! whenever it re-syncs, so they survive edits to any main component involved.
//!
//! A nested instance swapped through an outer one (another variant or component) is
//! recorded as an `instance` entry in the outer instance's override for it; that record
//! holds the overrides for the swapped instance's own layers. Swapping keeps overrides
//! on layers whose path of names exists in the new component.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use serde_json::Value;

use crate::doc::IdGen;
use crate::model::{ComponentInfo, Document, InstanceInfo, Node, NodeId, NodeType, Sizing};
use crate::patch;
use crate::props;

pub const ROOT_KEY: &str = "__root";

/// Key, inside an override, of a nested instance's swap record (its `InstanceInfo`).
pub(crate) const SWAP_KEY: &str = "instance";

/// How deep swaps recorded inside swaps are followed (guards against cyclic files).
const MAX_SWAP_DEPTH: usize = 16;

/// Root keys that position an instance rather than override it.
const ROOT_LOCAL_KEYS: &[&str] = &[
  "x",
  "y",
  "rotation",
  "name",
  "visible",
  "locked",
  "flipX",
  "flipY",
  "interactions",
  "scrollBehavior",
  "constraints",
  "absolutePosition",
  "sizingH",
  "sizingV",
];

#[cfg(test)]
thread_local! {
  /// How many fingerprints this thread computed (tests check that unrelated edits compute none).
  pub(crate) static FINGERPRINTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Fingerprint of a component subtree; changes whenever the component is edited.
pub fn fingerprint(doc: &Document, comp_id: &str) -> u64 {
  #[cfg(test)]
  FINGERPRINTS.with(|c| c.set(c.get() + 1));
  let mut h = DefaultHasher::new();
  // Variants share the properties of their set.
  if let Some(set) = doc.get(comp_id).and_then(|c| c.parent.as_ref()).and_then(|p| doc.get(p)) {
    if set.kind == NodeType::ComponentSet {
      if let Ok(s) = serde_json::to_string(&set.component) {
        s.hash(&mut h);
      }
    }
  }
  for nid in doc.subtree(comp_id) {
    if let Some(n) = doc.get(&nid) {
      if let Ok(s) = serde_json::to_string(&strip_position(n, nid == comp_id)) {
        s.hash(&mut h);
      }
    }
  }
  h.finish()
}

fn strip_position(n: &Node, is_root: bool) -> Node {
  let mut c = n.clone();
  if is_root {
    c.x = 0.0;
    c.y = 0.0;
    c.name = String::new();
    c.interactions.clear();
  }
  c
}

/// The name of a main component (or set) inside the subtree of one of `ids`, other than `ids`
/// themselves: wrapping such a selection would nest main components.
pub fn main_inside(doc: &Document, ids: &[NodeId]) -> Option<String> {
  ids
    .iter()
    .flat_map(|i| doc.subtree(i).into_iter().filter(move |n| n != i))
    .filter_map(|n| doc.get(&n))
    .find(|n| matches!(n.kind, NodeType::Component | NodeType::ComponentSet))
    .map(|n| n.name.clone())
}

/// Turns the given nodes into a main component. Returns the component id.
pub fn create_component(doc: &mut Document, ids: &[NodeId], gen: &mut IdGen) -> Option<NodeId> {
  let single = if ids.len() == 1 { doc.get(&ids[0]).cloned() } else { None };
  // Already a main component or a set: nothing to make (wrapping would nest main components).
  if let Some(n) = single
    .as_ref()
    .filter(|n| matches!(n.kind, NodeType::Component | NodeType::ComponentSet))
  {
    return Some(n.id.clone());
  }
  if ids.iter().any(|i| {
    doc
      .get(i)
      .is_some_and(|n| matches!(n.kind, NodeType::Component | NodeType::ComponentSet))
  }) {
    return None;
  }
  let target = match &single {
    Some(n) if matches!(n.kind, NodeType::Frame | NodeType::Group) => ids[0].clone(),
    _ => {
      // Named after the layer it was made from (never the wrapper's "Frame N").
      let name = single
        .as_ref()
        .map(|n| n.name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| doc.next_name("Component"));
      let id = crate::ops::wrap_in_frame(doc, ids, gen, NodeType::Frame)?;
      // The wrapper is a transparent holder: a lone rounded rectangle or circle must not gain
      // white corners (Figma's wrapper has no fill either).
      let w = doc.get_mut(&id)?;
      w.name = name;
      w.fills.clear();
      id
    }
  };
  // Layers inside nested instances keep their link to the component they copy.
  for nid in doc.subtree(&target) {
    let in_instance = doc
      .ancestors(&nid)
      .iter()
      .take_while(|a| **a != target)
      .any(|a| doc.get(a).map(|n| n.kind == NodeType::Instance).unwrap_or(false));
    if !in_instance {
      if let Some(n) = doc.get_mut(&nid) {
        n.master_id = None;
      }
    }
  }
  let n = doc.get_mut(&target)?;
  if n.kind == NodeType::Group {
    n.fills.clear();
  }
  n.kind = NodeType::Component;
  n.component = Some(ComponentInfo::default());
  Some(target)
}

/// Places a new instance of `comp_id`.
pub fn create_instance(
  doc: &mut Document,
  comp_id: &str,
  parent: Option<&str>,
  page: &str,
  x: f64,
  y: f64,
  gen: &mut IdGen,
) -> Option<NodeId> {
  let comp = doc.get(comp_id)?.clone();
  if comp.kind != NodeType::Component {
    return None;
  }
  if would_nest(doc, comp_id, &parent.and_then(|p| enclosing_component(doc, p))) {
    return None;
  }
  let id = doc.fresh_id(gen, "n_");
  let name = instance_name(doc, comp_id);
  // An instance of a hugging main hugs too; Fill depends on a parent the instance doesn't have yet.
  let hug = |s: Sizing| if s == Sizing::Hug { Sizing::Hug } else { Sizing::Fixed };
  let inst = Node {
    id: id.clone(),
    kind: NodeType::Instance,
    name,
    x,
    y,
    width: comp.width,
    height: comp.height,
    sizing_h: hug(comp.sizing_h),
    sizing_v: hug(comp.sizing_v),
    instance: Some(InstanceInfo {
      component_id: comp_id.to_string(),
      overrides: BTreeMap::new(),
      ..Default::default()
    }),
    ..Default::default()
  };
  doc.insert(inst, parent, page, None);
  sync_instance(doc, &id, gen);
  Some(id)
}

/// What a new instance of `comp_id` is called: a variant takes its set's name ("Button"), not its
/// property values ("Style=Primary").
fn instance_name(doc: &Document, comp_id: &str) -> String {
  let Some(comp) = doc.get(comp_id) else { return String::new() };
  comp
    .parent
    .as_ref()
    .and_then(|p| doc.get(p))
    .filter(|p| p.kind == NodeType::ComponentSet)
    .map_or_else(|| comp.name.clone(), |p| p.name.clone())
}

/// The deleted main's name, as far as the instances remember it. Instances start out named after
/// their main, so a source whose name ends in an auto " <number>" (a duplicate) gets the name most
/// of the instances share, else its own without the number, provided another instance is named the
/// plain name or the name and another number (else the number may be part of the name); any other name is kept (the user chose
/// it). Limit: a main whose name really ends in a number, restored from a lone instance, loses it.
fn restored_name(doc: &Document, users: &[NodeId], source_name: &str) -> String {
  let stripped = match source_name.rsplit_once(' ') {
    Some((head, tail)) if !head.is_empty() && !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => head,
    _ => return source_name.to_string(),
  };
  // Only when another instance carries the plain name (or the name and another number) is the
  // number an auto-suffix; a lone instance keeps the name it has.
  let numbered = |name: &str| {
    name == stripped
      || name
        .strip_prefix(stripped)
        .and_then(|r| r.strip_prefix(' '))
        .is_some_and(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()))
  };
  if !users
    .iter()
    .filter_map(|u| doc.get(u))
    .any(|n| n.name != source_name && numbered(&n.name))
  {
    return source_name.to_string();
  }
  let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
  for n in users.iter().filter_map(|u| doc.get(u)) {
    *counts.entry(n.name.as_str()).or_default() += 1;
  }
  if let Some((name, c)) = counts.iter().max_by_key(|(_, c)| **c) {
    if *c > 1 && counts.values().filter(|x| *x == c).count() == 1 {
      return name.to_string();
    }
  }
  stripped.to_string()
}

/// Rebuilds an instance's children from its main component and re-applies overrides.
/// Nested instances swapped through it are rebuilt from the component they were swapped to.
pub fn sync_instance(doc: &mut Document, inst_id: &str, gen: &mut IdGen) {
  let Some(info) = doc.get(inst_id).and_then(|n| n.instance.as_ref()) else {
    return;
  };
  if doc.get(&info.component_id).is_none() {
    return;
  }
  // Overrides of layers the main no longer has go first, so the copies `build` makes of swap
  // records are the cleaned ones.
  drop_dangling_overrides(doc, inst_id);
  let Some(info) = doc.get(inst_id).and_then(|n| n.instance.clone()) else {
    return;
  };
  // Reuse ids of existing copies so selection (and overrides keyed by them) survive. The old
  // copies are removed by `build` once it has what it needs from them.
  let mut reuse = Reuse::new(doc, inst_id);
  build(doc, gen, &mut reuse, inst_id, &info, &info.overrides, &Vec::new(), 0);
  reuse.remove_old(doc, &HashSet::new());
}

/// Before variables are removed: every layer inside an instance that is bound to one of them
/// records the value it shows as an override and drops the dead binding from the overrides, so
/// the sync that follows keeps the painted value instead of falling back to the main's.
pub fn keep_values_of_removed(doc: &mut Document, removed: &HashSet<String>) {
  // (layer, patch to record, override keys that repeat the main's value once the binding is gone)
  let patches: Vec<(NodeId, Value, Vec<&'static str>)> = doc
    .nodes
    .iter()
    .filter_map(|(id, n)| {
      let props: Vec<String> = n
        .bindings
        .iter()
        .filter(|(_, v)| removed.contains(v.as_str()))
        .map(|(p, _)| p.clone())
        .collect();
      if props.is_empty() {
        return None;
      }
      // Only layers inside an instance record anything.
      if n.master_id.is_none() && n.instance.is_none() {
        return None;
      }
      let master = match &n.master_id {
        Some(m) => doc.get(m),
        None => n.instance.as_ref().and_then(|i| doc.get(&i.component_id)),
      };
      // "Unbound here" stays only where the main binds the property to a variable that stays.
      let main_keeps = |p: &str| master.and_then(|mn| mn.bindings.get(p)).is_some_and(|v| !removed.contains(v));
      // Colours the main shows too (and doesn't bind to a variable that stays): the layer's own
      // override of them, if any, only repeats the main once the binding is gone.
      let mut repeats: Vec<&'static str> = Vec::new();
      if let Some(mn) = master {
        for p in &props {
          match p.as_str() {
            "fill" if !main_keeps(p) && mn.fills == n.fills => repeats.push("fills"),
            "stroke" if !main_keeps(p) && mn.strokes == n.strokes => repeats.push("strokes"),
            _ => {}
          }
        }
        // Nothing to record or remove unless the layer has an override of that colour itself.
        if repeats.len() == props.len() {
          let own = match scope_chain(doc, id).as_slice() {
            [scope] => n
              .master_id
              .as_ref()
              .and_then(|m| doc.get(scope)?.instance.as_ref()?.overrides.get(m))
              .is_some_and(|o| repeats.iter().any(|k| o.get(*k).is_some())),
            _ => true,
          };
          if !own {
            return None;
          }
        }
      }
      let mut p = crate::variables::detach_patch(n, &props);
      if let Value::Object(m) = &mut p {
        if let Some(Value::Object(b)) = m.get_mut("bindings") {
          b.retain(|k, _| main_keeps(k));
          if b.is_empty() {
            m.remove("bindings");
          }
        }
      }
      Some((id.clone(), p, repeats))
    })
    .collect();
  let holders: Vec<NodeId> = doc
    .nodes
    .iter()
    .filter(|(_, n)| {
      n.instance
        .as_ref()
        .is_some_and(|i| i.overrides.values().any(|o| override_binds(o, removed)))
    })
    .map(|(id, _)| id.clone())
    .collect();
  for id in holders {
    if let Some(info) = doc.get_mut(&id).and_then(|n| n.instance.as_mut()) {
      for o in info.overrides.values_mut() {
        drop_bindings(o, removed);
      }
      info.overrides.retain(|_, o| o.as_object().is_none_or(|m| !m.is_empty()));
    }
  }
  for (id, p, repeats) in patches {
    // The common case (a colour or border on a layer of a plain instance, no component property
    // behind it) goes straight into the override.
    let plain = p
      .as_object()
      .is_some_and(|m| m.keys().all(|k| matches!(k.as_str(), "fills" | "strokes" | "bindings")));
    let fast = plain.then(|| doc.get(&id)).flatten().and_then(|n| {
      let mid = n.master_id.clone().filter(|_| n.prop_refs.is_none())?;
      let scopes = scope_chain(doc, &id);
      (scopes.len() == 1).then(|| (scopes[0].clone(), mid))
    });
    match fast {
      Some((scope, mid)) => {
        if let Some(info) = doc.get_mut(&scope).and_then(|n| n.instance.as_mut()) {
          let entry = info.overrides.entry(mid.clone()).or_insert_with(empty);
          merge_override(entry, &patch::sanitize(&p));
          // The value equals the main's: an override of it would only pin a copy of it.
          if let Value::Object(m) = entry {
            for k in &repeats {
              m.remove(*k);
            }
            if m.is_empty() {
              info.overrides.remove(&mid);
            }
          }
        }
      }
      // `record_override` drops what equals the main's value.
      None => record_override(doc, &id, &p),
    }
  }
}

fn override_binds(o: &Value, removed: &HashSet<String>) -> bool {
  o.get("bindings")
    .and_then(|b| b.as_object())
    .is_some_and(|b| b.values().any(|v| v.as_str().is_some_and(|s| removed.contains(s))))
    || o
      .get(SWAP_KEY)
      .and_then(|s| s.get("overrides"))
      .and_then(|x| x.as_object())
      .is_some_and(|m| m.values().any(|x| override_binds(x, removed)))
}

fn drop_bindings(o: &mut Value, removed: &HashSet<String>) {
  let Some(obj) = o.as_object_mut() else { return };
  if let Some(Value::Object(b)) = obj.get_mut("bindings") {
    b.retain(|_, v| v.as_str().is_none_or(|s| !removed.contains(s)));
    if b.is_empty() {
      obj.remove("bindings");
    }
  }
  if let Some(Value::Object(swap)) = obj.get_mut(SWAP_KEY) {
    if let Some(Value::Object(inner)) = swap.get_mut("overrides") {
      inner.values_mut().for_each(|x| drop_bindings(x, removed));
      inner.retain(|_, x| x.as_object().is_none_or(|m| !m.is_empty()));
    }
  }
}

/// Overrides keyed by a layer the main component (or, in a swap record, the swapped-to
/// component) no longer has. The instance is only written when something goes.
fn dangling_overrides(doc: &Document, overrides: &BTreeMap<NodeId, Value>, component: &str) -> Option<BTreeMap<NodeId, Value>> {
  let has_swap = overrides.values().any(|o| o.get(SWAP_KEY).is_some());
  if !has_swap && overrides.keys().all(|k| k == ROOT_KEY) {
    return None;
  }
  let live: HashSet<NodeId> = doc.subtree(component).into_iter().collect();
  let dangling = overrides.keys().any(|k| k != ROOT_KEY && !live.contains(k));
  if !dangling && !has_swap {
    return None;
  }
  let mut out = overrides.clone();
  out.retain(|k, _| k == ROOT_KEY || live.contains(k));
  for o in out.values_mut() {
    let Some(swap) = o.get_mut(SWAP_KEY) else { continue };
    let Some(c) = swap.get("componentId").and_then(|c| c.as_str()).map(str::to_string) else {
      continue;
    };
    if doc.get(&c).is_none() {
      continue;
    }
    let Some(inner) = swap
      .get("overrides")
      .and_then(|x| serde_json::from_value::<BTreeMap<NodeId, Value>>(x.clone()).ok())
    else {
      continue;
    };
    if let Some(kept) = dangling_overrides(doc, &inner, &c) {
      swap["overrides"] = serde_json::to_value(kept).unwrap_or(Value::Null);
    }
  }
  (out != *overrides).then_some(out)
}

fn drop_dangling_overrides(doc: &mut Document, inst_id: &str) {
  let Some(info) = doc.get(inst_id).and_then(|n| n.instance.as_ref()) else {
    return;
  };
  let Some(kept) = dangling_overrides(doc, &info.overrides, &info.component_id) else {
    return;
  };
  if let Some(i) = doc.get_mut(inst_id).and_then(|n| n.instance.as_mut()) {
    i.overrides = kept;
  }
}

/// Records a property edit made on a node that lives in an instance.
pub fn record_override(doc: &mut Document, node_id: &str, p: &Value) {
  // Edits to a layer a component property controls change the property instead.
  let redirected = props::redirect_edit(doc, node_id, p);
  let p = &redirected;
  let Some(n) = doc.get(node_id) else { return };
  let scopes = scope_chain(doc, node_id);
  let (scope, key, clean) = match (scopes.last(), n.master_id.clone()) {
    (None, _) if n.kind == NodeType::Instance => {
      let mut clean = patch::sanitize(p);
      if let Value::Object(m) = &mut clean {
        for k in ROOT_LOCAL_KEYS {
          m.remove(*k);
        }
      }
      (node_id.to_string(), ROOT_KEY.to_string(), clean)
    }
    (Some(s), Some(mid)) => (s.clone(), mid, patch::sanitize(p)),
    _ => return,
  };
  if clean.as_object().map(|m| m.is_empty()).unwrap_or(true) {
    return;
  }
  // An edit that puts back the main component's value is no override at all (typing a letter
  // and deleting it again must not pin the text against later changes to the main).
  let base = {
    let layer = match key.as_str() {
      ROOT_KEY => doc.get(&scope).and_then(|i| i.instance.as_ref()).map(|i| i.component_id.clone()),
      k => Some(k.to_string()),
    };
    // Inside a swapped nested instance, its source's overrides apply under the component's layers.
    let under = match (scopes.len(), doc.get(&scope)) {
      (l, Some(s)) if l > 1 => match (s.master_id.as_ref(), s.instance.as_ref()) {
        (Some(src), Some(i)) => source_base(doc, src, &i.component_id).remove(&key),
        _ => None,
      },
      _ => None,
    };
    layer
      .and_then(|l| doc.get(&l))
      .and_then(|b| serde_json::to_value(b).ok())
      .map(|mut j| {
        if let Some(u) = under {
          patch::merge(&mut j, &u);
        }
        j
      })
  };
  if let Some(info) = doc.get_mut(&scope).and_then(|i| i.instance.as_mut()) {
    let entry = info.overrides.entry(key.clone()).or_insert_with(empty);
    merge_override(entry, &clean);
    if let Some(b) = base {
      match prune_equal(entry, &b) {
        Some(kept) => *entry = kept,
        None => {
          info.overrides.remove(&key);
        }
      }
    }
  }
  persist_scopes(doc, &scopes);
}

pub fn detach_instance(doc: &mut Document, inst_id: &str) {
  // Layers of the instance keep what the properties made of them but no longer follow its
  // properties; layers inside instances nested in it still follow theirs. The detached layer
  // itself keeps following the property of the component it sits in that controls its
  // visibility.
  let own: HashSet<NodeId> = doc
    .subtree(inst_id)
    .into_iter()
    .filter(|nid| {
      nid != inst_id
        && doc
          .ancestors(nid)
          .into_iter()
          .find(|a| doc.get(a).map(|n| n.kind == NodeType::Instance).unwrap_or(false))
          .as_deref()
          == Some(inst_id)
    })
    .collect();
  for nid in doc.subtree(inst_id) {
    if let Some(n) = doc.get_mut(&nid) {
      n.master_id = None;
      if own.contains(&nid) {
        n.prop_refs = None;
      }
      if nid == inst_id {
        n.kind = NodeType::Frame;
        n.instance = None;
        n.prop_refs = n.prop_refs.take().and_then(|r| {
          let kept = crate::model::PropRefs {
            visible: r.visible,
            ..Default::default()
          };
          (!kept.is_empty()).then_some(kept)
        });
      }
    }
  }
}

/// Puts an instance's Hug/Fixed back to its main's (a resize to Fixed isn't recorded as an override);
/// Fill depends on the parent and stays.
fn follow_main_sizing(doc: &mut Document, inst_id: &str) {
  let Some(comp) = doc
    .get(inst_id)
    .and_then(|n| n.instance.as_ref())
    .and_then(|i| doc.get(&i.component_id))
    .map(|c| (c.sizing_h, c.sizing_v))
  else {
    return;
  };
  let hug = |s: Sizing| if s == Sizing::Hug { Sizing::Hug } else { Sizing::Fixed };
  doc.modify(inst_id, |n| {
    if n.sizing_h != Sizing::Fill {
      n.sizing_h = hug(comp.0);
    }
    if n.sizing_v != Sizing::Fill {
      n.sizing_v = hug(comp.1);
    }
  });
}

/// Clears an instance's overrides. Inside another instance, this clears the overrides (and
/// any swap) made on it through the outer instance, so it matches its main component again.
pub fn reset_overrides(doc: &mut Document, inst_id: &str, gen: &mut IdGen) {
  let scopes = scope_chain(doc, inst_id);
  let Some(parent) = scopes.last() else {
    if let Some(info) = doc.get_mut(inst_id).and_then(|i| i.instance.as_mut()) {
      info.overrides.clear();
      info.prop_values.clear();
    }
    follow_main_sizing(doc, inst_id);
    sync_instance(doc, inst_id, gen);
    return;
  };
  let masters: HashSet<NodeId> = doc
    .subtree(inst_id)
    .iter()
    .filter_map(|d| doc.get(d).and_then(|n| n.master_id.clone()))
    .collect();
  if let Some(info) = doc.get_mut(parent).and_then(|i| i.instance.as_mut()) {
    info.overrides.retain(|k, _| !masters.contains(k));
  }
  persist_scopes(doc, &scopes);
  sync_instance(doc, &scopes[0], gen);
}

/// The groups of properties an override can cover, as (key, label). A layer's override patch
/// is sorted into these for the per-property reset menu; anything unmatched is "other".
pub const OVERRIDE_GROUPS: &[(&str, &str)] = &[
  ("fill", "Fill"),
  ("stroke", "Stroke"),
  ("effects", "Effects"),
  ("text", "Text"),
  ("typography", "Typography"),
  ("size", "Size"),
  ("layout", "Layout"),
  ("position", "Position"),
  ("radius", "Corner radius"),
  ("appearance", "Appearance"),
  ("visibility", "Visibility"),
  ("name", "Name"),
  ("swap", "Swapped component"),
  ("variables", "Variables"),
  ("props", "Component properties"),
  ("other", "Other"),
];

/// The group a patch key belongs to; `sub` is the key inside a `text` object.
fn group_of(key: &str, sub: Option<&str>) -> &'static str {
  match key {
    "fills" | "fillStyle" => "fill",
    "strokes" | "strokeWeight" | "strokeAlign" | "strokeDash" | "strokeWeights" | "strokeJoin" | "strokeCap" | "strokeStyle" => "stroke",
    "effects" | "effectStyle" => "effects",
    "text" => match sub {
      Some("characters") | Some("runs") => "text",
      Some("autoResize") => "size",
      _ => "typography",
    },
    "textStyle" => "typography",
    "width" | "height" | "sizingH" | "sizingV" | "minWidth" | "maxWidth" | "minHeight" | "maxHeight" => "size",
    "layout" | "clipContent" | "absolutePosition" | "constraints" | "layoutGrids" | "gridStyle" | "overflow" | "scrollBehavior" => "layout",
    "x" | "y" | "rotation" | "flipX" | "flipY" => "position",
    "cornerRadius" | "cornerRadii" => "radius",
    "opacity" | "blendMode" | "isMask" => "appearance",
    "visible" => "visibility",
    "name" => "name",
    SWAP_KEY => "swap",
    "bindings" | "variableModes" => "variables",
    props::PROPS_KEY => "props",
    _ => "other",
  }
}

/// The property group a binding key (`fill`, `gap`, ...) belongs to besides "variables".
fn binding_group(prop: &str) -> &'static str {
  match prop {
    "fill" => "fill",
    "stroke" | "strokeWeight" => "stroke",
    "cornerRadius" => "radius",
    "width" | "height" => "size",
    "gap" | "counterGap" | "padding" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" => "layout",
    "opacity" => "appearance",
    "visible" => "visibility",
    "characters" => "text",
    "fontSize" | "fontFamily" | "fontWeight" | "lineHeight" | "letterSpacing" | "paragraphSpacing" => "typography",
    _ => "variables",
  }
}

/// The group of a key inside a `text` override. A change of the runs alone (bolding a word) is
/// typography; with new characters the runs belong to the text.
fn text_group(t: &serde_json::Map<String, Value>, sub: &str) -> &'static str {
  if sub == "runs" && !t.contains_key("characters") {
    return "typography";
  }
  group_of("text", Some(sub))
}

/// Where the overrides of layer `id` are stored: the instance that holds them, the key in its
/// override map and the recorded patch. The root of a top-level instance is (itself, `ROOT_KEY`);
/// any other layer of an instance (a nested instance's root included) is (the innermost scope
/// that stores edits for it, its `master_id`).
pub fn layer_overrides(doc: &Document, id: &str) -> Option<(NodeId, String, Value)> {
  let n = doc.get(id)?;
  let scopes = scope_chain(doc, id);
  let (scope, key) = match (scopes.last(), n.master_id.clone()) {
    (None, _) if n.kind == NodeType::Instance => (id.to_string(), ROOT_KEY.to_string()),
    (Some(s), Some(m)) => (s.clone(), m),
    _ => return None,
  };
  // With the main deleted nothing re-applies the entry: there is nothing to reset until it is restored.
  let missing = |i: &str| {
    doc
      .get(i)
      .and_then(|n| n.instance.as_ref())
      .is_none_or(|i| doc.get(&i.component_id).is_none())
  };
  if missing(&scope) || scopes.first().is_some_and(|o| missing(o)) {
    return None;
  }
  let patch = doc.get(&scope)?.instance.as_ref()?.overrides.get(&key)?.clone();
  Some((scope, key, patch))
}

/// The property groups layer `id` overrides, in table order (empty outside instances).
pub fn override_groups(doc: &Document, id: &str) -> Vec<(&'static str, &'static str)> {
  let Some((_, _, patch)) = layer_overrides(doc, id) else {
    return vec![];
  };
  let Value::Object(m) = &patch else { return vec![] };
  let mut present: HashSet<&'static str> = HashSet::new();
  for (k, v) in m {
    match (k.as_str(), v) {
      // The name a swap brings along isn't a change of its own.
      ("name", _) if m.contains_key(SWAP_KEY) => {}
      ("text", Value::Object(t)) => present.extend(t.keys().map(|s| text_group(t, s))),
      // A binding belongs to its property's group and to Variables.
      ("bindings", Value::Object(b)) => {
        present.insert("variables");
        present.extend(b.keys().map(|s| binding_group(s)));
      }
      (k, _) => {
        present.insert(group_of(k, None));
      }
    }
  }
  OVERRIDE_GROUPS.iter().filter(|(g, _)| present.contains(g)).copied().collect()
}

/// A layer inside an instance that carries overrides: (id, name, groups).
pub type OverriddenLayer = (NodeId, String, Vec<(&'static str, &'static str)>);

/// The layers inside instance `id` that differ from their main, in tree order, at most `cap`
/// of them, and whether there were more. Nested instances' layers are included.
pub fn overridden_layers(doc: &Document, id: &str, cap: usize) -> (Vec<OverriddenLayer>, bool) {
  let mut out: Vec<OverriddenLayer> = Vec::new();
  if doc.get(id).is_none_or(|n| n.kind != NodeType::Instance) {
    return (out, false);
  }
  let tree = doc.subtree(id);
  // Nothing is recorded in this instance, nested ones, or the outer instances that store edits
  // made through them (a nested instance's layers can be overridden from its outer instance): done.
  let has_overrides = |i: &String| {
    doc
      .get(i)
      .and_then(|n| n.instance.as_ref())
      .is_some_and(|x| !x.overrides.is_empty())
  };
  if !tree.iter().chain(scope_chain(doc, id).iter()).any(has_overrides) {
    return (out, false);
  }
  for lid in tree.into_iter().skip(1) {
    if doc.get(&lid).is_none_or(|n| n.master_id.is_none()) {
      continue;
    }
    let groups = override_groups(doc, &lid);
    if groups.is_empty() {
      continue;
    }
    if out.len() >= cap {
      return (out, true);
    }
    let name = doc.get(&lid).map(|n| n.name.clone()).unwrap_or_default();
    out.push((lid, name, groups));
  }
  (out, false)
}

/// Drops the parts of an override patch that belong to `groups` (all of them when empty).
fn strip_groups(patch: &mut Value, groups: &[String]) {
  let Value::Object(m) = patch else { return };
  let hit = |g: &str| groups.is_empty() || groups.iter().any(|x| x == g);
  // The name a swap brings along goes with it.
  let swap_hit = m.contains_key(SWAP_KEY) && hit("swap");
  m.retain(|k, v| match (k.as_str(), v) {
    ("name", _) if swap_hit => false,
    ("text", Value::Object(t)) => {
      let keep: Vec<String> = t.keys().filter(|s| !hit(text_group(t, s))).cloned().collect();
      t.retain(|s, _| keep.contains(s));
      !t.is_empty()
    }
    ("bindings", Value::Object(b)) => {
      b.retain(|p, _| !hit("variables") && !hit(binding_group(p)));
      !b.is_empty()
    }
    (k, _) => !hit(group_of(k, None)),
  });
}

/// Puts the given property groups of layer `id` (every group when empty) back to what its main
/// component says, keeping its other overrides. Works through nested and swapped instances: the
/// change is made where the override is stored. Returns false when there was nothing to reset.
pub fn reset_override_groups(doc: &mut Document, id: &str, groups: &[String], gen: &mut IdGen) -> bool {
  let Some((scope, key, patch)) = layer_overrides(doc, id) else {
    return false;
  };
  let is_root = key == ROOT_KEY;
  let mut kept = patch.clone();
  strip_groups(&mut kept, groups);
  if kept == patch {
    return false;
  }
  let scopes = scope_chain(doc, id);
  if let Some(info) = doc.get_mut(&scope).and_then(|i| i.instance.as_mut()) {
    if kept.as_object().is_none_or(|m| m.is_empty()) {
      info.overrides.remove(&key);
    } else {
      info.overrides.insert(key, kept);
    }
  }
  persist_scopes(doc, &scopes);
  if is_root && (groups.is_empty() || groups.iter().any(|g| g == "size")) {
    follow_main_sizing(doc, id);
  }
  let outer = scopes.first().cloned().unwrap_or(scope);
  sync_instance(doc, &outer, gen);
  true
}

/// Rebuilds a deleted main component from one of its instances, the one that differs least from
/// it (`prefer` wins a tie). The new main takes the old id and each of its layers the id it had
/// (the `master_id` its copies carry), so every instance points at it again with its overrides.
/// Component properties and variant membership lived on the deleted layers and are not restored.
pub fn restore_component(doc: &mut Document, prefer: &str, gen: &mut IdGen) -> Result<NodeId, String> {
  let comp = doc
    .get(prefer)
    .and_then(|n| n.instance.as_ref())
    .map(|i| i.component_id.clone())
    .ok_or("not an instance")?;
  if doc.get(&comp).is_some() {
    return Err("the main component still exists".into());
  }
  let mut users: Vec<NodeId> = doc
    .nodes
    .values()
    .filter(|n| n.kind == NodeType::Instance && n.instance.as_ref().is_some_and(|i| i.component_id == comp))
    .map(|n| n.id.clone())
    .collect();
  users.sort();
  // A copy inside another instance links to that instance's main, not to this one: only
  // instances that stand on their own can be the source (unless every one is nested).
  let standalone: Vec<&NodeId> = users.iter().filter(|u| doc.instance_ancestor(u).is_none()).collect();
  let pool: Vec<&NodeId> = if standalone.is_empty() {
    users.iter().collect()
  } else {
    standalone
  };
  let source = pool
    .into_iter()
    .min_by_key(|u| (override_count(doc, u), u.as_str() != prefer))
    .cloned()
    .ok_or("no instance to restore from")?;
  let src_root = doc.get(&source).cloned().ok_or("no instance to restore from")?;

  // Ids: the main keeps its old one, its layers the ids their copies point at (unless taken).
  let order = doc.subtree(&source);
  let mut map: HashMap<NodeId, NodeId> = HashMap::new();
  let mut used: HashSet<NodeId> = HashSet::from([comp.clone()]);
  map.insert(source.clone(), comp.clone());
  for old in order.iter().skip(1) {
    // Follow the links to the layer of the deleted main (a copy of a copy points at an existing layer first).
    let mut wanted = doc.get(old).and_then(|n| n.master_id.clone());
    for _ in 0..MAX_SWAP_DEPTH {
      match wanted.as_ref().and_then(|w| doc.get(w)).and_then(|n| n.master_id.clone()) {
        Some(next) => wanted = Some(next),
        None => break,
      }
    }
    let new = match wanted {
      Some(m) if doc.get(&m).is_none() && !used.contains(&m) => m,
      _ => loop {
        let id = doc.fresh_id(gen, "n_");
        if !used.contains(&id) {
          break id;
        }
      },
    };
    used.insert(new.clone());
    map.insert(old.clone(), new);
  }

  // Where it goes: right of the source's top-level layer, clear of other top-level layers.
  let top = doc.top_level_of(prefer);
  let page = doc.get(prefer).map(|n| n.page.clone()).unwrap_or_else(|| src_root.page.clone());
  let b = doc.abs_bounds(&top);
  let (x, mut y) = (b.right() + 100.0, b.y);
  let others: Vec<crate::geom::Rect> = doc
    .page(&page)
    .map(|p| p.children.clone())
    .unwrap_or_default()
    .iter()
    .map(|c| doc.abs_bounds(c))
    .collect();
  for _ in 0..others.len().min(64) + 1 {
    let hit = others
      .iter()
      .find(|o| x < o.right() && x + src_root.width > o.x && y < o.bottom() && y + src_root.height > o.y);
    match hit {
      Some(o) => y = o.bottom() + 40.0,
      None => break,
    }
  }

  let in_nested = |doc: &Document, d: &str| -> bool {
    doc
      .ancestors(d)
      .into_iter()
      .take_while(|a| *a != source)
      .any(|a| doc.get(&a).is_some_and(|n| n.kind == NodeType::Instance))
  };
  let mut fresh: Vec<Node> = Vec::new();
  for old in &order {
    let Some(src) = doc.get(old) else { continue };
    let mut n = src.clone();
    n.id = map[old].clone();
    n.children = src.children.iter().filter_map(|c| map.get(c).cloned()).collect();
    if *old == source {
      n.kind = NodeType::Component;
      n.parent = None;
      n.x = x;
      n.y = y;
      n.rotation = 0.0;
      n.flip_x = false;
      n.flip_y = false;
      n.visible = true;
      n.locked = false;
      n.interactions.clear();
      n.absolute_position = false;
      n.master_id = None;
      n.instance = None;
      n.prop_refs = None;
      n.component = Some(ComponentInfo::default());
      // An instance of a variant is named after its set: the restored main stands alone, so say so.
      if doc.nodes.values().any(|x| x.kind == NodeType::ComponentSet && x.name == src.name) {
        n.name = format!("{} (restored)", src.name);
      } else {
        n.name = restored_name(doc, &users, &src.name);
      }
      for s in [&mut n.sizing_h, &mut n.sizing_v] {
        if *s == Sizing::Fill {
          *s = Sizing::Fixed;
        }
      }
    } else {
      n.parent = src.parent.as_ref().and_then(|p| map.get(p).cloned());
      n.page = page.clone();
      // Layers of nested instances are relinked to the layers they copy below.
      n.master_id = None;
      if !in_nested(doc, old) {
        n.prop_refs = None;
      }
    }
    fresh.push(n);
  }
  for n in fresh {
    if n.parent.is_none() {
      doc.insert(n, None, &page, None);
    } else {
      doc.set_node(n);
    }
  }
  // The instances inside the restored main rebuild their layers from their own components, which
  // links them (ids are kept by layer path) the way a main component made by hand is linked.
  let nested: Vec<NodeId> = order
    .iter()
    .skip(1)
    .map(|o| map[o].clone())
    .filter(|n| doc.get(n).is_some_and(|x| x.kind == NodeType::Instance) && doc.instance_ancestor(n).is_none())
    .collect();
  for ni in nested {
    // Link the copies first (by layer path, then position), so the rebuild keeps their ids even
    // where a copy's name differs from its layer in the component.
    if let Some(k) = doc.get(&ni).and_then(|n| n.instance.as_ref()).map(|i| i.component_id.clone()) {
      if doc.get(&k).is_some() {
        for (d, m) in match_layers(doc, &ni, &k) {
          if let Some(n) = doc.get_mut(&d) {
            n.master_id = Some(m);
          }
        }
      }
    }
    sync_instance(doc, &ni, gen);
  }

  // Every instance of the restored main picks it up again (overrides re-apply by master id).
  let mut outers: Vec<NodeId> = Vec::new();
  for u in &users {
    match doc.instance_ancestor(u) {
      None => outers.push(u.clone()),
      Some(_) if is_swapped_nested(doc, u) => {
        if let Some(o) = scope_chain(doc, u).first().filter(|o| !outers.contains(o)) {
          outers.push(o.clone());
        }
      }
      Some(_) => {}
    }
  }
  for o in outers {
    sync_instance(doc, &o, gen);
  }
  Ok(comp)
}

/// Points an instance at another component (variant swap or instance swap). Overrides on
/// layers that exist in both components, matched by their path of layer names, carry over;
/// everything else follows the new component. An instance inside another instance is
/// swapped through the outer one, so the swap survives the outer instance re-syncing.
pub fn swap_component(doc: &mut Document, inst_id: &str, comp_id: &str, gen: &mut IdGen) {
  if doc.get(comp_id).is_none_or(|c| c.kind != NodeType::Component) {
    return;
  }
  let new_name = instance_name(doc, comp_id);
  if comp_id == inst_id || doc.is_ancestor(comp_id, inst_id) || would_nest(doc, comp_id, &enclosing_component(doc, inst_id)) {
    return;
  }
  let Some(inst) = doc.get(inst_id).cloned() else { return };
  let Some(info) = inst.instance.clone() else { return };
  let old_name = doc.get(&info.component_id).map(|c| c.name.clone());
  let old_default = instance_name(doc, &info.component_id);
  // An instance still named after its component follows the swap; a name of its own stays.
  let follow = inst.name.is_empty() || Some(&inst.name) == old_name.as_ref() || inst.name == old_default;
  let scopes = scope_chain(doc, inst_id);
  let Some(parent) = scopes.last().cloned() else {
    let overrides = carry_overrides(doc, &info.component_id, comp_id, &info.overrides, &BTreeMap::new());
    let prop_values = props::carry_values(doc, &info.component_id, comp_id, &info.prop_values);
    if let Some(inst) = doc.get_mut(inst_id) {
      if follow {
        inst.name = new_name;
      }
      inst.instance = Some(InstanceInfo {
        component_id: comp_id.to_string(),
        overrides,
        prop_values,
        expose_props: info.expose_props,
      });
    }
    sync_instance(doc, inst_id, gen);
    return;
  };
  let Some(key) = inst.master_id.clone() else { return };
  // (The host check above covers where the outer instance lives; a swap recorded in it can't
  // recurse, the copies inside the new component are not expanded again.)
  if doc.is_ancestor(comp_id, &key) {
    return;
  }
  let new_info = match swap_entry(doc, &parent, &key) {
    Some(swapped) => {
      let base = source_base(doc, &key, &swapped.component_id);
      InstanceInfo {
        component_id: comp_id.to_string(),
        overrides: carry_overrides(doc, &swapped.component_id, comp_id, &swapped.overrides, &base),
        prop_values: props::carry_values(doc, &swapped.component_id, comp_id, &swapped.prop_values),
        expose_props: swapped.expose_props,
      }
    }
    None => {
      // First swap: overrides made through the outer instance on this one's layers move
      // into the swap (keyed by the new component's layers).
      let region: HashSet<NodeId> = doc.subtree(&key).into_iter().skip(1).collect();
      let mut moved = BTreeMap::new();
      // Property values set on it (in its main component and through the outer instance).
      let source = doc.get(&key).and_then(|n| n.instance.clone()).unwrap_or_default();
      let mut values = source.prop_values.clone();
      if let Some(info) = doc.get_mut(&parent).and_then(|i| i.instance.as_mut()) {
        let keys: Vec<NodeId> = info.overrides.keys().filter(|k| region.contains(*k)).cloned().collect();
        for k in keys {
          if let Some(v) = info.overrides.remove(&k) {
            moved.insert(k, v);
          }
        }
        if let Some(Value::Object(m)) = info.overrides.get_mut(&key) {
          if let Some(Value::Object(set)) = m.remove(props::PROPS_KEY) {
            values.extend(set);
          }
        }
      }
      InstanceInfo {
        component_id: comp_id.to_string(),
        overrides: carry_overrides(doc, &key, comp_id, &moved, &BTreeMap::new()),
        prop_values: props::carry_values(doc, &source.component_id, comp_id, &values),
        expose_props: source.expose_props,
      }
    }
  };
  if let Some(info) = doc.get_mut(&parent).and_then(|i| i.instance.as_mut()) {
    let entry = info.overrides.entry(key).or_insert_with(empty);
    if let Value::Object(m) = entry {
      m.insert(SWAP_KEY.into(), serde_json::to_value(&new_info).unwrap_or(Value::Null));
      if follow {
        m.insert("name".into(), Value::String(new_name));
      }
    }
  }
  persist_scopes(doc, &scopes);
  sync_instance(doc, &scopes[0], gen);
}

/// True for an instance inside another instance that was swapped through it: it no longer
/// follows its own main component's changes via the outer one, so it re-syncs on its own.
pub fn is_swapped_nested(doc: &Document, id: &str) -> bool {
  let scopes = scope_chain(doc, id);
  match (scopes.last(), doc.get(id).and_then(|n| n.master_id.as_ref())) {
    (Some(s), Some(m)) => swap_entry(doc, s, m).is_some(),
    _ => false,
  }
}

/// True when an instance looks different from its main component: it has overrides of its
/// own, or (inside another instance) overrides or a swap made through the outer one.
pub fn has_overrides(doc: &Document, id: &str) -> bool {
  override_count(doc, id) > 0
}

/// How many layers of instance `id` differ from its main component: those it overrides itself
/// plus, inside another instance, those overridden (or swapped) through the outer one.
pub fn override_count(doc: &Document, id: &str) -> usize {
  let Some(n) = doc.get(id) else { return 0 };
  let own = n.instance.as_ref().map(|i| i.overrides.len()).unwrap_or(0);
  let scopes = scope_chain(doc, id);
  let Some(store) = scopes.last().and_then(|s| doc.get(s)).and_then(|s| s.instance.as_ref()) else {
    return own;
  };
  let source_overridden = n
    .master_id
    .as_ref()
    .and_then(|m| doc.get(m))
    .and_then(|m| m.instance.as_ref())
    .map(|i| !i.overrides.is_empty())
    .unwrap_or(false);
  let swapped_over_source = is_swapped_nested(doc, id) && source_overridden && own == 0;
  let through = doc
    .subtree(id)
    .iter()
    .filter(|d| {
      let Some(m) = doc.get(d).and_then(|x| x.master_id.as_ref()) else {
        return false;
      };
      match store.overrides.get(m) {
        // The swap itself is shown by the component reference; its name isn't visual.
        Some(Value::Object(o)) if *d == id => o.keys().any(|k| k != SWAP_KEY && k != "name"),
        Some(_) => true,
        None => false,
      }
    })
    .count();
  own + through + swapped_over_source as usize
}

/// The component whose layers contain `id` (the nearest one above it, or itself).
pub(crate) fn enclosing_component(doc: &Document, id: &str) -> Option<NodeId> {
  std::iter::once(id.to_string())
    .chain(doc.ancestors(id))
    .find(|a| doc.get(a).map(|n| n.kind == NodeType::Component).unwrap_or(false))
}

/// The components instanced by `n` itself: its main component and any it was swapped to
/// (recorded in its overrides, to any depth).
pub(crate) fn referenced_components(n: &Node, out: &mut Vec<NodeId>) {
  fn swaps(overrides: &BTreeMap<NodeId, Value>, out: &mut Vec<NodeId>, depth: usize) {
    if depth > MAX_SWAP_DEPTH {
      return;
    }
    for v in overrides.values() {
      let Some(si) = v.get(SWAP_KEY).and_then(|s| serde_json::from_value::<InstanceInfo>(s.clone()).ok()) else {
        continue;
      };
      out.push(si.component_id.clone());
      swaps(&si.overrides, out, depth + 1);
    }
  }
  if let Some(i) = &n.instance {
    out.push(i.component_id.clone());
    swaps(&i.overrides, out, 0);
  }
}

/// True when `comp` is, or (through the instances inside it) contains, the component `host`:
/// placing an instance of `comp` inside `host` would make `host` contain itself.
pub fn would_nest(doc: &Document, comp: &str, host: &Option<NodeId>) -> bool {
  would_nest_any(doc, vec![comp.to_string()], host)
}

/// `would_nest` for several components at once, walking each reachable component once.
pub fn would_nest_any(doc: &Document, comps: Vec<NodeId>, host: &Option<NodeId>) -> bool {
  let Some(host) = host else { return false };
  let mut seen: HashSet<NodeId> = HashSet::new();
  let mut stack = comps;
  while let Some(c) = stack.pop() {
    if c == *host {
      return true;
    }
    if !seen.insert(c.clone()) {
      continue;
    }
    for id in doc.subtree(&c) {
      if let Some(n) = doc.get(&id) {
        referenced_components(n, &mut stack);
      }
    }
  }
  false
}

/// True when putting copies of `nodes` under `parent` would put a component inside itself:
/// some node is an instance of (or holds one of) a component that reaches the main component
/// around `parent`. Copies of a main component are new components, so they never count.
pub fn would_nest_nodes(doc: &Document, nodes: &[&Node], parent: Option<&str>) -> bool {
  let host = parent.and_then(|p| enclosing_component(doc, p));
  nests_in(doc, nodes, &host)
}

/// True when moving `ids` under `parent` would put a component inside itself.
pub fn would_nest_under(doc: &Document, ids: &[NodeId], parent: Option<&str>) -> bool {
  let subtree: Vec<NodeId> = ids.iter().flat_map(|id| doc.subtree(id)).collect();
  let nodes: Vec<&Node> = subtree.iter().filter_map(|d| doc.get(d)).collect();
  let host = parent.and_then(|p| enclosing_component(doc, p));
  // Moving a main component into its own layers, or something that holds an instance of it.
  nodes.iter().any(|n| n.kind == NodeType::Component && Some(&n.id) == host.as_ref()) || nests_in(doc, &nodes, &host)
}

/// Whether any component the `nodes` instance reaches the `host` main component.
fn nests_in(doc: &Document, nodes: &[&Node], host: &Option<NodeId>) -> bool {
  if host.is_none() {
    return false;
  }
  let mut refs = Vec::new();
  for n in nodes {
    referenced_components(n, &mut refs);
  }
  would_nest_any(doc, refs, host)
}

/// Links layers inside instances that lost their `master_id` (instances nested in main
/// components made by older versions) back to the layers they copy, matched by position,
/// and records how they differ as overrides, so they keep following their main component.
pub fn repair_masters(doc: &mut Document) {
  let instances: Vec<NodeId> = doc
    .nodes
    .values()
    .filter(|n| n.kind == NodeType::Instance)
    .map(|n| n.id.clone())
    .collect();
  for inst in instances {
    // Only the older-file case: instances nested in a main component. Others (a Figma import's
    // instances, say) never had layers to link and are left alone.
    if doc.instance_ancestor(&inst).is_some() || enclosing_component(doc, &inst).is_none() {
      continue;
    }
    let Some(comp) = doc.get(&inst).and_then(|n| n.instance.as_ref()).map(|i| i.component_id.clone()) else {
      continue;
    };
    if doc.get(&comp).is_none()
      || doc
        .subtree(&inst)
        .iter()
        .skip(1)
        .all(|d| doc.get(d).map(|n| n.master_id.is_some()).unwrap_or(true))
    {
      continue;
    }
    let pairs = match_layers(doc, &inst, &comp);
    let mut found = BTreeMap::new();
    for (d, m) in pairs {
      let (Some(n), Some(master)) = (doc.get(&d).cloned(), doc.get(&m).cloned()) else {
        continue;
      };
      if n.master_id.is_some() {
        continue;
      }
      let mut base = master;
      base.id = n.id.clone();
      base.parent = n.parent.clone();
      base.children = n.children.clone();
      base.page = n.page.clone();
      base.component = None;
      base.instance = n.instance.clone();
      base.master_id = None;
      base.kind = n.kind;
      // Layout places copies; only what the user changed is an override.
      (base.x, base.y, base.width, base.height) = (n.x, n.y, n.width, n.height);
      let before = serde_json::to_value(&base).unwrap_or(Value::Null);
      let after = serde_json::to_value(&n).unwrap_or(Value::Null);
      if let Some(diff) = deep_diff(&before, &after) {
        found.insert(m.clone(), diff);
      }
      if let Some(n) = doc.get_mut(&d) {
        n.master_id = Some(m);
      }
    }
    if let Some(info) = doc.get_mut(&inst).and_then(|i| i.instance.as_mut()) {
      for (k, v) in found {
        info.overrides.entry(k).or_insert(v);
      }
    }
  }
}

/// A merge patch turning `before` into `after`, descending into objects so a changed text
/// records only its changed fields (None when they're equal).
fn deep_diff(before: &Value, after: &Value) -> Option<Value> {
  match (before, after) {
    (Value::Object(b), Value::Object(a)) => {
      let mut out = serde_json::Map::new();
      for (k, v) in a {
        match b.get(k) {
          Some(old) => {
            if let Some(d) = deep_diff(old, v) {
              out.insert(k.clone(), d);
            }
          }
          None => {
            out.insert(k.clone(), v.clone());
          }
        }
      }
      for k in b.keys().filter(|k| !a.contains_key(*k)) {
        out.insert(k.clone(), Value::Null);
      }
      (!out.is_empty()).then_some(Value::Object(out))
    }
    _ => (before != after).then(|| after.clone()),
  }
}

fn same_layer_kind(doc: &Document, a: &str, b: &str) -> bool {
  match (doc.get(a), doc.get(b)) {
    (Some(x), Some(y)) => x.kind == y.kind || (x.kind == NodeType::Frame && y.kind == NodeType::Component),
    _ => false,
  }
}

/// Pairs the layers under `inst` with the ones they copy under `comp`: by path of layer names
/// (so a layer added or moved in the main since doesn't shift the rest), then by position
/// for what's left.
fn match_layers(doc: &Document, inst: &str, comp: &str) -> Vec<(NodeId, NodeId)> {
  let by_path: HashMap<LayerPath, NodeId> = layer_paths(&doc.nodes, comp)
    .into_iter()
    .filter(|(_, p)| !p.is_empty())
    .map(|(id, p)| (p, id))
    .collect();
  let mut out: Vec<(NodeId, NodeId)> = Vec::new();
  for (d, p) in layer_paths(&doc.nodes, inst) {
    if p.is_empty() {
      continue;
    }
    if let Some(m) = by_path.get(&p).filter(|m| same_layer_kind(doc, &d, m)) {
      out.push((d, m.clone()));
    }
  }
  let mut by_pos = Vec::new();
  match_by_position(doc, inst, comp, &mut by_pos);
  for (d, m) in by_pos {
    if !out.iter().any(|(od, om)| *od == d || *om == m) {
      out.push((d, m));
    }
  }
  out.sort();
  out
}

/// Pairs `a`'s descendants with `b`'s where the trees have the same shape.
fn match_by_position(doc: &Document, a: &str, b: &str, out: &mut Vec<(NodeId, NodeId)>) {
  let (Some(na), Some(nb)) = (doc.get(a), doc.get(b)) else { return };
  if na.children.len() != nb.children.len() {
    return;
  }
  for (ca, cb) in na.children.iter().zip(&nb.children) {
    if same_layer_kind(doc, ca, cb) {
      out.push((ca.clone(), cb.clone()));
      match_by_position(doc, ca, cb, out);
    }
  }
}

/// The instances whose override maps hold edits for the layers under `id`, outermost first:
/// the outermost instance around it, then each nested instance swapped through the previous
/// one (a swapped instance keeps the overrides for its own layers in its swap record).
pub(crate) fn scope_chain(doc: &Document, id: &str) -> Vec<NodeId> {
  let mut scopes: Vec<NodeId> = Vec::new();
  for a in doc.ancestors(id).into_iter().rev() {
    let Some(n) = doc.get(&a) else { continue };
    if n.kind != NodeType::Instance {
      continue;
    }
    let nested_swap = match (scopes.last(), n.master_id.as_ref()) {
      (None, _) => true,
      (Some(s), Some(m)) => swap_entry(doc, s, m).is_some(),
      (Some(_), None) => false,
    };
    if nested_swap {
      scopes.push(a);
    }
  }
  scopes
}

/// The swap recorded in `scope`'s overrides for the nested instance copied from `master`.
pub(crate) fn swap_entry(doc: &Document, scope: &str, master: &str) -> Option<InstanceInfo> {
  let v = doc.get(scope)?.instance.as_ref()?.overrides.get(master)?.get(SWAP_KEY)?;
  serde_json::from_value(v.clone()).ok()
}

/// Writes each nested scope's instance info back into the swap record of the scope above.
pub(crate) fn persist_scopes(doc: &mut Document, scopes: &[NodeId]) {
  for i in (1..scopes.len()).rev() {
    let Some(child) = doc.get(&scopes[i]) else { continue };
    let (Some(info), Some(key)) = (child.instance.clone(), child.master_id.clone()) else {
      continue;
    };
    if let Some(parent) = doc.get_mut(&scopes[i - 1]).and_then(|p| p.instance.as_mut()) {
      if let Value::Object(m) = parent.overrides.entry(key).or_insert_with(empty) {
        m.insert(SWAP_KEY.into(), serde_json::to_value(&info).unwrap_or(Value::Null));
      }
    }
  }
}

/// Copies `info`'s component under `inst_id` (whose old children are already removed),
/// then applies `overrides`. Nested instances with a swap record are built from the
/// component they were swapped to. `prefix` is `inst_id`'s layer path in the outermost
/// instance (for reusing ids by path).
#[allow(clippy::too_many_arguments)]
fn build(
  doc: &mut Document,
  gen: &mut IdGen,
  reuse: &mut Reuse,
  inst_id: &str,
  info: &InstanceInfo,
  overrides: &BTreeMap<NodeId, Value>,
  prefix: &LayerPath,
  depth: usize,
) {
  let Some(inst) = doc.get(inst_id).cloned() else { return };
  let Some(comp) = doc.get(&info.component_id).cloned() else { return };

  // Nested instances swapped through this one.
  let mut swaps: HashMap<NodeId, InstanceInfo> = HashMap::new();
  if depth < MAX_SWAP_DEPTH {
    for (k, v) in overrides {
      let Some(si) = v.get(SWAP_KEY).and_then(|s| serde_json::from_value::<InstanceInfo>(s.clone()).ok()) else {
        continue;
      };
      let nested = doc.get(k).map(|n| n.kind == NodeType::Instance).unwrap_or(false);
      let target_ok = doc.get(&si.component_id).map(|c| c.kind == NodeType::Component).unwrap_or(false);
      if nested && target_ok && *k != comp.id && !doc.is_ancestor(&si.component_id, k) {
        swaps.insert(k.clone(), si);
      }
    }
  }
  // The component's layers in pre-order, without the layers of swapped nested instances.
  let mut comp_nodes = Vec::new();
  let mut stack = vec![comp.id.clone()];
  while let Some(cur) = stack.pop() {
    let Some(n) = doc.get(&cur) else { continue };
    if cur == comp.id || !swaps.contains_key(&cur) {
      for c in n.children.iter().rev() {
        stack.push(c.clone());
      }
    }
    comp_nodes.push(cur);
  }
  let mut paths = LazyPaths {
    root: comp.id.clone(),
    prefix,
    cache: None,
  };
  let mut map = reuse.alloc(doc, gen, &comp_nodes[1..], &mut paths, !swaps.is_empty());
  // Copies whose id is reused are overwritten below (and left alone if equal).
  reuse.remove_old(doc, &map.values().cloned().collect());
  map.insert(comp.id.clone(), inst_id.to_string());

  let mut bound = false;
  for cid in comp_nodes.iter().skip(1) {
    let Some(src) = doc.get(cid).cloned() else { continue };
    bound |= src.prop_refs.is_some();
    let mut n = src.clone();
    n.id = map[cid].clone();
    n.parent = src.parent.as_ref().and_then(|p| map.get(p).cloned());
    n.children = src.children.iter().filter_map(|c| map.get(c).cloned()).collect();
    n.page = inst.page.clone();
    n.master_id = Some(cid.clone());
    n.component = None;
    if n.kind == NodeType::Component {
      n.kind = NodeType::Frame;
    }
    if let Some(si) = swaps.get(cid) {
      n.children.clear();
      n.instance = Some(si.clone());
    }
    doc.set_node(n);
  }

  // Root takes the component's visual props; position and placement stay with the instance.
  let mut root = comp.clone();
  root.id = inst.id.clone();
  root.kind = NodeType::Instance;
  root.name = inst.name.clone();
  root.page = inst.page.clone();
  root.parent = inst.parent.clone();
  root.x = inst.x;
  root.y = inst.y;
  root.rotation = inst.rotation;
  root.flip_x = inst.flip_x;
  root.flip_y = inst.flip_y;
  root.visible = inst.visible;
  root.locked = inst.locked;
  root.constraints = inst.constraints;
  root.absolute_position = inst.absolute_position;
  root.sizing_h = inst.sizing_h;
  root.sizing_v = inst.sizing_v;
  root.interactions = inst.interactions.clone();
  root.export_settings = inst.export_settings.clone();
  root.component = None;
  root.master_id = inst.master_id.clone();
  root.prop_refs = inst.prop_refs.clone();
  root.instance = Some(info.clone());
  root.children = comp.children.iter().filter_map(|c| map.get(c).cloned()).collect();
  doc.set_node(root);

  let mut swapped: Vec<(&NodeId, &InstanceInfo)> = swaps.iter().collect();
  swapped.sort_by(|a, b| a.0.cmp(b.0));
  for (cid, si) in swapped {
    let Some(nid) = map.get(cid).cloned() else { continue };
    let nested = nested_overrides(doc, cid, si, depth + 1);
    let mut child_prefix = prefix.clone();
    child_prefix.extend(paths.get(doc).get(cid).cloned().unwrap_or_default());
    build(doc, gen, reuse, &nid, si, &nested, &child_prefix, depth + 1);
  }

  for (mid, p) in overrides {
    let target = if mid == ROOT_KEY {
      Some(inst_id.to_string())
    } else {
      map.get(mid).cloned()
    };
    if let Some(t) = target {
      doc.modify(&t, |n| {
        let _ = patch::apply(n, p);
      });
    }
  }

  // Component property values win over everything else on the layers they control.
  if bound {
    let skip: HashSet<NodeId> = swaps.keys().filter_map(|k| map.get(k).cloned()).collect();
    props::apply_values(doc, inst_id, info, overrides, &skip);
  }
}

/// The overrides a swapped nested instance applies: those that shaped its source (the nested
/// instance in the main component), moved onto the new component by layer path, under the
/// ones made through the outer instance.
fn nested_overrides(doc: &Document, source: &str, swapped: &InstanceInfo, depth: usize) -> BTreeMap<NodeId, Value> {
  let mut out = match doc.get(source).and_then(|s| s.instance.as_ref()) {
    Some(src) => {
      let base = effective_overrides(doc, source, depth);
      remap_overrides(doc, &src.component_id, &swapped.component_id, &base)
    }
    None => BTreeMap::new(),
  };
  for (k, v) in &swapped.overrides {
    merge_override(out.entry(k.clone()).or_insert_with(empty), v);
  }
  out
}

/// Everything that makes instance `id` differ from its main component, keyed by the
/// component's layers: its own overrides or, inside another instance, its source's plus
/// those made through the outer instance.
fn effective_overrides(doc: &Document, id: &str, depth: usize) -> BTreeMap<NodeId, Value> {
  let Some(n) = doc.get(id) else { return BTreeMap::new() };
  let Some(info) = n.instance.as_ref() else { return BTreeMap::new() };
  let scopes = scope_chain(doc, id);
  let (Some(parent), Some(master)) = (scopes.last(), n.master_id.as_ref()) else {
    return info.overrides.clone();
  };
  if depth >= MAX_SWAP_DEPTH {
    return info.overrides.clone();
  }
  if swap_entry(doc, parent, master).is_some() {
    return nested_overrides(doc, master, info, depth + 1);
  }
  let mut out = effective_overrides(doc, master, depth + 1);
  let Some(store) = doc.get(parent).and_then(|p| p.instance.as_ref()) else {
    return out;
  };
  let region: HashSet<NodeId> = doc.subtree(master).into_iter().skip(1).collect();
  let through: BTreeMap<NodeId, Value> = store
    .overrides
    .iter()
    .filter(|(k, _)| region.contains(*k))
    .map(|(k, v)| (k.clone(), v.clone()))
    .collect();
  for (k, v) in remap_overrides(doc, master, &info.component_id, &through) {
    merge_override(out.entry(k).or_insert_with(empty), &v);
  }
  if let Some(p) = store.overrides.get(master) {
    merge_override(out.entry(ROOT_KEY.to_string()).or_insert_with(empty), &patch::sanitize(p));
  }
  out
}

/// The overrides to keep through a swap away from `from`: those that still change something
/// (an override that merely repeats the old component's value, like text typed and typed
/// back, follows the new component), moved onto the layers of `to`. `base` holds what already
/// applies on top of `from`'s layers.
fn carry_overrides(
  doc: &Document,
  from: &str,
  to: &str,
  overrides: &BTreeMap<NodeId, Value>,
  base: &BTreeMap<NodeId, Value>,
) -> BTreeMap<NodeId, Value> {
  let mut real = BTreeMap::new();
  for (k, v) in overrides {
    let layer = if k == ROOT_KEY { from } else { k.as_str() };
    let kept = match doc.get(layer) {
      Some(n) => {
        let mut now = serde_json::to_value(n).unwrap_or(Value::Null);
        if let Some(b) = base.get(k) {
          patch::merge(&mut now, b);
        }
        prune_equal(v, &now)
      }
      None => Some(v.clone()),
    };
    if let Some(kept) = kept {
      real.insert(k.clone(), kept);
    }
  }
  remap_overrides(doc, from, to, &real)
}

/// `patch` without the fields that already hold in `base` (a layer as JSON, so a fill typed
/// as `{type, color}` counts as the layer's `{type, color, opacity, visible}` one); None when
/// nothing is left. A swap record always stays.
fn prune_equal(patch: &Value, base: &Value) -> Option<Value> {
  let node: Option<Node> = serde_json::from_value(base.clone()).ok();
  // What `base` becomes with `part` applied, at `path` (None when it doesn't apply).
  let holds = |path: &[&str], v: &Value| -> bool {
    let Some(node) = node.as_ref() else {
      return path
        .iter()
        .try_fold(base, |b, k| b.get(*k))
        .map(|b| same_value(b, v))
        .unwrap_or(false);
    };
    let mut part = v.clone();
    for k in path.iter().rev() {
      part = serde_json::json!({ *k: part });
    }
    let mut changed = node.clone();
    if patch::apply(&mut changed, &part).is_err() {
      return false;
    }
    let after = serde_json::to_value(&changed).unwrap_or(Value::Null);
    let at = |j: &Value| path.iter().try_fold(j.clone(), |b, k| b.get(*k).cloned());
    match (at(&after), at(base)) {
      (Some(x), Some(y)) => same_value(&x, &y),
      (None, None) => true,
      _ => false,
    }
  };
  let Value::Object(p) = patch else { return Some(patch.clone()) };
  let mut out = serde_json::Map::new();
  for (k, v) in p {
    if k == SWAP_KEY || k == props::PROPS_KEY {
      out.insert(k.clone(), v.clone());
      continue;
    }
    match (v, base.get(k)) {
      (Value::Object(sub), Some(Value::Object(_))) => {
        let kept: serde_json::Map<String, Value> = sub
          .iter()
          .filter(|(j, w)| !holds(&[k.as_str(), j.as_str()], w))
          .map(|(j, w)| (j.clone(), w.clone()))
          .collect();
        if !kept.is_empty() {
          out.insert(k.clone(), Value::Object(kept));
        }
      }
      _ => {
        if !holds(&[k.as_str()], v) {
          out.insert(k.clone(), v.clone());
        }
      }
    }
  }
  (!out.is_empty()).then_some(Value::Object(out))
}

/// JSON equality that doesn't tell 16 from 16.0.
fn same_value(a: &Value, b: &Value) -> bool {
  match (a, b) {
    (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
    (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_value(p, q)),
    (Value::Object(x), Value::Object(y)) => {
      x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).map(|w| same_value(v, w)).unwrap_or(false))
    }
    _ => a == b,
  }
}

/// What a nested instance swapped to `comp` already looks like before the overrides made
/// through the outer instance: the overrides of its source (`key`, the nested instance in a
/// main component), moved onto the layers of `comp`.
fn source_base(doc: &Document, key: &str, comp: &str) -> BTreeMap<NodeId, Value> {
  match doc.get(key).and_then(|s| s.instance.as_ref()) {
    Some(src) => remap_overrides(doc, &src.component_id, comp, &effective_overrides(doc, key, 0)),
    None => BTreeMap::new(),
  }
}

/// Re-keys overrides made on the layers under `from` to the layers under `to` with the same
/// path of names (Figma's rule; repeated names pair up in order). Unmatched ones are dropped.
fn remap_overrides(doc: &Document, from: &str, to: &str, overrides: &BTreeMap<NodeId, Value>) -> BTreeMap<NodeId, Value> {
  if from == to || overrides.is_empty() {
    return overrides.clone();
  }
  let from_paths = layer_paths(&doc.nodes, from);
  let to_ids: HashMap<LayerPath, NodeId> = layer_paths(&doc.nodes, to)
    .into_iter()
    .filter(|(_, p)| !p.is_empty())
    .map(|(id, p)| (p, id))
    .collect();
  let mut out = BTreeMap::new();
  for (k, v) in overrides {
    let key = if k == ROOT_KEY {
      Some(k.clone())
    } else {
      from_paths.get(k).and_then(|p| to_ids.get(p)).cloned()
    };
    if let Some(key) = key {
      merge_override(out.entry(key).or_insert_with(empty), v);
    }
  }
  out
}

/// Each layer's path under `root`: (name, how many earlier siblings share it) per level.
fn layer_paths(nodes: &imbl::OrdMap<NodeId, Arc<Node>>, root: &str) -> HashMap<NodeId, LayerPath> {
  let mut out = HashMap::new();
  let mut stack = vec![(root.to_string(), Vec::new())];
  while let Some((id, path)) = stack.pop() {
    let Some(n) = nodes.get(&id) else { continue };
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for c in &n.children {
      let Some(cn) = nodes.get(c) else { continue };
      let nth = seen.entry(cn.name.as_str()).or_insert(0);
      let mut p: LayerPath = path.clone();
      p.push((cn.name.clone(), *nth));
      *nth += 1;
      stack.push((c.clone(), p));
    }
    out.insert(id, path);
  }
  out
}

/// Merges an override patch into a recorded one; a swap record is replaced, not merged.
fn merge_override(entry: &mut Value, p: &Value) {
  patch::merge(entry, p);
  if let (Value::Object(e), Some(s)) = (entry, p.get(SWAP_KEY)) {
    e.insert(SWAP_KEY.into(), s.clone());
  }
}

pub(crate) fn empty() -> Value {
  Value::Object(Default::default())
}

type LayerPath = Vec<(String, usize)>;

/// Layer paths under a component, computed only when ids can't be reused by master.
struct LazyPaths<'a> {
  root: NodeId,
  prefix: &'a LayerPath,
  cache: Option<HashMap<NodeId, LayerPath>>,
}

impl LazyPaths<'_> {
  fn get(&mut self, doc: &Document) -> &HashMap<NodeId, LayerPath> {
    let (root, prefix) = (&self.root, self.prefix);
    self.cache.get_or_insert_with(|| {
      layer_paths(&doc.nodes, root)
        .into_iter()
        .map(|(id, p)| {
          let mut full = prefix.clone();
          full.extend(p);
          (id, full)
        })
        .collect()
    })
  }
}

/// Ids of an instance's previous copies, handed out again to the copies that replace them:
/// first by the layer they copy, then by their path (a swap to another variant keeps ids).
/// Holds only ids (never a snapshot of the document, which would make every later edit of
/// the node map copy shared chunks); the old copies' paths are captured, before they're
/// removed, only when matching by layer isn't enough.
struct Reuse {
  root: NodeId,
  /// The old copies under the instance, still in the document until `remove_old`.
  old_ids: Vec<NodeId>,
  /// The first old copy of each layer, and any further ones.
  by_master: HashMap<NodeId, NodeId>,
  more: HashMap<NodeId, Vec<NodeId>>,
  old_paths: Option<HashMap<NodeId, LayerPath>>,
  used: HashSet<NodeId>,
}

impl Reuse {
  fn new(doc: &Document, inst_id: &str) -> Self {
    let mut old_ids = doc.subtree(inst_id);
    old_ids.remove(0);
    let mut by_master: HashMap<NodeId, NodeId> = HashMap::with_capacity(old_ids.len());
    let mut more: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    for nid in &old_ids {
      let Some(m) = doc.get(nid).and_then(|n| n.master_id.as_ref()) else {
        continue;
      };
      match by_master.get(m) {
        None => {
          by_master.insert(m.clone(), nid.clone());
        }
        Some(_) => more.entry(m.clone()).or_default().push(nid.clone()),
      }
    }
    Reuse {
      root: inst_id.to_string(),
      old_ids,
      by_master,
      more,
      old_paths: None,
      used: HashSet::new(),
    }
  }

  /// Removes the old copies from the document (once), except those in `keep`, which the
  /// caller is about to overwrite.
  fn remove_old(&mut self, doc: &mut Document, keep: &HashSet<NodeId>) {
    for nid in std::mem::take(&mut self.old_ids) {
      if !keep.contains(&nid) {
        doc.nodes.remove(&nid);
      }
    }
  }

  /// Picks an id for the copy of each of `wanted`. `needs_paths` asks for the old copies'
  /// paths to be kept for later calls (a swapped nested instance re-allocates after the old
  /// copies are gone).
  fn alloc(
    &mut self,
    doc: &Document,
    gen: &mut IdGen,
    wanted: &[NodeId],
    paths: &mut LazyPaths,
    needs_paths: bool,
  ) -> HashMap<NodeId, NodeId> {
    let mut out = HashMap::with_capacity(wanted.len() + 1);
    let mut pending = Vec::new();
    if needs_paths || !self.more.is_empty() {
      self.capture_paths(doc);
    }
    for cid in wanted {
      let pick = match (self.by_master.get(cid), self.more.get(cid)) {
        (None, _) => None,
        (Some(first), None) => Some(first).filter(|i| !self.used.contains(*i)).cloned(),
        (Some(first), Some(rest)) => {
          let free: Vec<&NodeId> = std::iter::once(first).chain(rest).filter(|i| !self.used.contains(*i)).collect();
          let want = paths.get(doc).get(cid).cloned();
          let old = self.old_paths.as_ref();
          free
            .iter()
            .find(|i| old.and_then(|o| o.get(**i)) == want.as_ref())
            .or(free.first())
            .map(|i| (*i).clone())
        }
      };
      match pick {
        Some(id) => {
          self.used.insert(id.clone());
          out.insert(cid.clone(), id);
        }
        None => pending.push(cid),
      }
    }
    if pending.is_empty() {
      return out;
    }
    // Layers with no copy of their own take over a copy at the same path (a renamed or
    // replaced layer in the main component).
    self.capture_paths(doc);
    let by_path: HashMap<&LayerPath, &NodeId> = self
      .old_paths
      .as_ref()
      .map(|o| o.iter().map(|(id, p)| (p, id)).collect())
      .unwrap_or_default();
    let mut picked = Vec::new();
    for cid in pending {
      let reused = if by_path.is_empty() {
        None
      } else {
        paths
          .get(doc)
          .get(cid)
          .and_then(|p| by_path.get(p))
          .filter(|i| !self.used.contains(**i) && !picked.contains(**i))
          .map(|i| (*i).clone())
      };
      let id = reused.unwrap_or_else(|| loop {
        // Never an id the document has (the instance's own, say) or one handed out already.
        let id = doc.fresh_id(gen, "n_");
        if !self.used.contains(&id) && !picked.contains(&id) {
          break id;
        }
      });
      picked.push(id.clone());
      out.insert(cid.clone(), id);
    }
    self.used.extend(picked);
    out
  }

  /// Paths of the old copies under the instance, from the document before they're removed.
  /// A no-op once they're gone (or already captured).
  fn capture_paths(&mut self, doc: &Document) {
    if self.old_paths.is_some() || self.old_ids.is_empty() {
      return;
    }
    let root = &self.root;
    self.old_paths = Some(layer_paths(&doc.nodes, root).into_iter().filter(|(_, p)| !p.is_empty()).collect());
  }
}

/// Groups components into a component set and derives variant properties from names.
const DEFAULT_SET: &str = "Component Set";

pub fn combine_as_variants(doc: &mut Document, ids: &[NodeId], gen: &mut IdGen) -> Option<NodeId> {
  let comps: Vec<NodeId> = ids
    .iter()
    .filter(|i| doc.get(i).map(|n| n.kind == NodeType::Component).unwrap_or(false))
    .cloned()
    .collect();
  if comps.len() < 2 {
    return None;
  }
  // Properties come from the original names, before they are rewritten as "Prop=Value".
  let names: Vec<String> = comps.iter().filter_map(|c| doc.get(c)).map(|c| c.name.clone()).collect();
  let (mut set_name, pairs) = variants_from_names(&names);
  // One key order for every variant: the first name's, then keys in the order they first appear.
  let mut order: Vec<String> = Vec::new();
  for p in &pairs {
    for (k, _) in p {
      if !order.contains(k) {
        order.push(k.clone());
      }
    }
  }
  let props: Vec<BTreeMap<String, String>> = pairs.into_iter().map(|p| p.into_iter().collect()).collect();
  if set_name == DEFAULT_SET {
    // Instances take their set's name: sets without a name of their own differ by number.
    let numbered = doc.next_name(DEFAULT_SET);
    set_name = if numbered == format!("{DEFAULT_SET} 1") {
      DEFAULT_SET.into()
    } else {
      numbered
    };
  }
  let set_id = crate::ops::wrap_in_frame(doc, &comps, gen, NodeType::ComponentSet)?;
  let pad = 20.0;
  for (cid, props) in comps.iter().zip(props) {
    if let Some(c) = doc.get_mut(cid) {
      c.x += pad;
      c.y += pad;
      c.name = order
        .iter()
        .filter_map(|k| props.get(k).map(|v| format!("{k}={v}")))
        .collect::<Vec<_>>()
        .join(", ");
      c.component.get_or_insert_with(Default::default).variant_props = props;
    }
  }
  if let Some(set) = doc.get_mut(&set_id) {
    set.x -= pad;
    set.y -= pad;
    set.width += pad * 2.0;
    set.height += pad * 2.0;
    set.name = set_name;
    set.strokes = vec![crate::model::Paint::solid("#9747FF")];
    set.stroke_dash = vec![6.0, 4.0];
    set.corner_radius = 6.0;
  }
  props::merge_into_set(doc, &comps, &set_id);
  Some(set_id)
}

/// The set name and each component's variant properties, derived from component names:
/// "Button/Primary" and "Button/Secondary" make set "Button" with Property 1 = Primary or
/// Secondary; "Size=Large" names are used as they are; anything else falls back to the
/// distinct names (or "Variant 1", "Variant 2" …) under "Property 1".
fn variants_from_names(names: &[String]) -> (String, Vec<Vec<(String, String)>>) {
  if let Some(parsed) = names.iter().map(|n| variant_pairs(n)).collect::<Option<Vec<_>>>() {
    // "Button/Size=Small": a path shared by every name before the pairs names the set.
    let prefix = |n: &str| {
      n.rsplit_once('/')
        .filter(|(_, pairs)| pairs.contains('='))
        .map(|(p, _)| p.trim().to_string())
    };
    let shared = prefix(&names[0]).filter(|p| !p.is_empty() && names.iter().all(|n| prefix(n).as_deref() == Some(p.as_str())));
    return match shared {
      Some(base) => (base, names.iter().filter_map(|n| variant_pairs(n.rsplit_once('/')?.1)).collect()),
      None => (DEFAULT_SET.into(), parsed),
    };
  }
  let slash = names.iter().all(|n| n.contains('/'));
  let parts: Vec<Vec<&str>> = names
    .iter()
    .map(|n| {
      if slash {
        n.split('/').map(str::trim).filter(|s| !s.is_empty()).collect()
      } else {
        n.split_whitespace().collect()
      }
    })
    .collect();
  // Longest shared leading path, leaving every component at least one part of its own.
  let shortest = parts.iter().map(|p| p.len()).min().unwrap_or(0);
  let mut common = 0;
  while common + 1 < shortest && parts.iter().all(|p| p[common] == parts[0][common]) {
    common += 1;
  }
  let base = parts
    .first()
    .map(|p| p[..common].join(if slash { "/" } else { " " }))
    .unwrap_or_default();
  let props: Vec<Vec<(String, String)>> = parts
    .iter()
    .map(|p| {
      let rest = &p[common..];
      if slash {
        rest
          .iter()
          .enumerate()
          .map(|(i, v)| (format!("Property {}", i + 1), v.to_string()))
          .collect()
      } else {
        vec![("Property 1".to_string(), rest.join(" "))]
      }
    })
    .collect();
  let maps: Vec<BTreeMap<&String, &String>> = props.iter().map(|p| p.iter().map(|(k, v)| (k, v)).collect()).collect();
  let distinct = maps
    .iter()
    .enumerate()
    .all(|(i, p)| !p.is_empty() && p.values().all(|v| !v.is_empty()) && !maps[..i].contains(p));
  let set_name = if !base.is_empty() {
    base
  } else if !names[0].is_empty() && names.iter().all(|n| *n == names[0]) {
    names[0].clone()
  } else {
    DEFAULT_SET.into()
  };
  let props = if distinct {
    props
  } else {
    (1..=names.len())
      .map(|i| vec![("Property 1".to_string(), format!("Variant {i}"))])
      .collect()
  };
  (set_name, props)
}

/// "Size=S, State=Default" as ordered pairs. A key written twice keeps the last value at its
/// first position.
pub fn variant_pairs(name: &str) -> Option<Vec<(String, String)>> {
  if !name.contains('=') {
    return None;
  }
  let mut out: Vec<(String, String)> = Vec::new();
  for part in name.split(',') {
    let (k, v) = part.split_once('=')?;
    let (k, v) = (k.trim().to_string(), v.trim().to_string());
    match out.iter_mut().find(|(ok, _)| *ok == k) {
      Some(slot) => slot.1 = v,
      None => out.push((k, v)),
    }
  }
  Some(out)
}

pub fn parse_variant_name(name: &str) -> Option<BTreeMap<String, String>> {
  variant_pairs(name).map(|p| p.into_iter().collect())
}

/// The property keys of a component set in their written order: the first child's name, then any
/// other keys (children with more properties) sorted.
pub fn variant_order(doc: &Document, set: &str) -> Vec<String> {
  let kids: Vec<&Node> = doc
    .get(set)
    .map(|s| {
      s.children
        .iter()
        .filter_map(|c| doc.get(c))
        .filter(|c| c.kind == NodeType::Component)
        .collect()
    })
    .unwrap_or_default();
  let mut order: Vec<String> = kids
    .first()
    .and_then(|c| variant_pairs(&c.name))
    .map(|p| p.into_iter().map(|(k, _)| k).collect())
    .unwrap_or_default();
  let mut rest: Vec<String> = kids
    .iter()
    .filter_map(|c| c.component.as_ref())
    .flat_map(|c| c.variant_props.keys().cloned())
    .filter(|k| !order.contains(k))
    .collect();
  rest.sort();
  rest.dedup();
  order.extend(rest);
  order
}

/// Finds the sibling variant matching `base` props with one property changed.
pub fn find_variant(doc: &Document, comp_id: &str, prop: &str, value: &str) -> Option<NodeId> {
  let comp = doc.get(comp_id)?;
  let set = doc.get(comp.parent.as_ref()?)?;
  if set.kind != NodeType::ComponentSet {
    return None;
  }
  let mut want = comp.component.as_ref()?.variant_props.clone();
  want.insert(prop.to_string(), value.to_string());
  set
    .children
    .iter()
    .find(|c| {
      doc
        .get(c)
        .and_then(|n| n.component.as_ref())
        .map(|ci| ci.variant_props == want)
        .unwrap_or(false)
    })
    .cloned()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::new_document;
  use serde_json::json;

  /// A file with a "Button" set of two variants (State=Default, State=Pressed) and an
  /// instance of the default one inside a "Home" frame.
  fn button_set() -> (crate::engine::Engine, String, String, String) {
    use crate::engine::{Command, Engine};
    let id = |v: serde_json::Value| v["id"].as_str().unwrap().to_string();
    let mut e = Engine::new(Box::new(crate::text::HeuristicMeasurer), 4);
    let shape = |e: &mut Engine, kind, x| {
      id(
        e.dispatch(Command::CreateShape {
          kind,
          x,
          y: 0.0,
          width: 100.0,
          height: 40.0,
          parent: None,
        })
        .unwrap(),
      )
    };
    let a = shape(&mut e, NodeType::Rectangle, 0.0);
    let b = shape(&mut e, NodeType::Rectangle, 200.0);
    let ca = id(e.dispatch(Command::CreateComponent { ids: vec![a] }).unwrap());
    let cb = id(e.dispatch(Command::CreateComponent { ids: vec![b] }).unwrap());
    e.dispatch(Command::Update {
      ids: vec![ca.clone()],
      patch: json!({ "name": "State=Default" }),
    })
    .unwrap();
    e.dispatch(Command::Update {
      ids: vec![cb.clone()],
      patch: json!({ "name": "State=Pressed" }),
    })
    .unwrap();
    let set = id(
      e.dispatch(Command::CombineVariants {
        ids: vec![ca.clone(), cb.clone()],
      })
      .unwrap(),
    );
    e.dispatch(Command::Update {
      ids: vec![set],
      patch: json!({ "name": "Button" }),
    })
    .unwrap();
    // Clear of the components: a frame drawn over one would land inside it.
    let home = shape(&mut e, NodeType::Frame, 1000.0);
    e.dispatch(Command::Update {
      ids: vec![home.clone()],
      patch: json!({ "name": "Home", "x": 1000.0, "y": 300.0, "width": 400.0, "height": 400.0 }),
    })
    .unwrap();
    let inst = id(
      e.dispatch(Command::CreateInstance {
        component_id: ca,
        x: 10.0,
        y: 10.0,
        parent: Some(home.clone()),
        anchor: None,
        into_components: false,
      })
      .unwrap(),
    );
    (e, home, inst, cb)
  }

  #[test]
  fn a_component_made_from_a_layer_is_named_after_it() {
    use crate::engine::{Command, Engine};
    let mut e = Engine::new(Box::new(crate::text::HeuristicMeasurer), 4);
    let r = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
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
    let layer_name = e.doc.get(&r).unwrap().name.clone();
    let c = e.dispatch(Command::CreateComponent { ids: vec![r] }).unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    assert_eq!(e.doc.get(&c).unwrap().name, layer_name);
    assert!(!layer_name.starts_with("Frame"));
  }

  #[test]
  fn an_instance_is_named_after_its_set_across_variant_changes() {
    use crate::engine::Command;
    let (mut e, _, inst, _) = button_set();
    assert_eq!(e.doc.get(&inst).unwrap().name, "Button", "named after the set");
    e.dispatch(Command::SetVariant {
      id: inst.clone(),
      prop: "State".into(),
      value: "Pressed".into(),
    })
    .unwrap();
    assert_eq!(e.doc.get(&inst).unwrap().name, "Button", "every variant keeps the set's name");
    // A name of its own is kept.
    e.dispatch(Command::Update {
      ids: vec![inst.clone()],
      patch: json!({ "name": "Buy button" }),
    })
    .unwrap();
    e.dispatch(Command::SetVariant {
      id: inst.clone(),
      prop: "State".into(),
      value: "Default".into(),
    })
    .unwrap();
    assert_eq!(e.doc.get(&inst).unwrap().name, "Buy button");
  }

  #[test]
  fn code_uses_the_set_as_one_component_with_a_prop() {
    use crate::engine::Command;
    let (mut e, home, inst, pressed) = button_set();
    let code = crate::codegen::export_react(&e.doc, &home, &crate::text::HeuristicMeasurer);
    assert!(
      code.contains("<Button className=") && code.contains(" state=\"Default\" />"),
      "{code}"
    );
    assert!(code.contains("export function Button({ state = \"Default\", ...rest }"), "{code}");
    assert!(
      code.contains("if (state === \"Pressed\") return <ButtonPressed {...rest} />;"),
      "{code}"
    );
    assert!(
      code.contains("function ButtonDefault(") && !code.contains("export function ButtonDefault("),
      "{code}"
    );
    assert!(!code.contains("StateDefault"), "{code}");
    e.dispatch(Command::SwapComponent {
      id: inst,
      component_id: pressed,
    })
    .unwrap();
    let code = crate::codegen::export_react(&e.doc, &home, &crate::text::HeuristicMeasurer);
    assert!(code.contains(" state=\"Pressed\" />"), "{code}");
  }

  #[test]
  fn instance_follows_component_and_keeps_overrides() {
    let mut gen = IdGen::new(3);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    doc.insert(
      Node {
        id: "c".into(),
        kind: NodeType::Frame,
        width: 100.0,
        height: 40.0,
        ..Default::default()
      },
      None,
      &page,
      None,
    );
    let label = Node {
      id: "t".into(),
      kind: NodeType::Text,
      text: Some(crate::model::TextProps {
        characters: "Button".into(),
        ..Default::default()
      }),
      ..Default::default()
    };
    doc.insert(label, Some("c"), &page, None);
    let comp = create_component(&mut doc, &["c".into()], &mut gen).unwrap();
    let inst = create_instance(&mut doc, &comp, None, &page, 300.0, 0.0, &mut gen).unwrap();
    let copy = doc.get(&inst).unwrap().children[0].clone();
    assert_eq!(doc.get(&copy).unwrap().master_id.as_deref(), Some("t"));

    // Override text in the instance.
    let p = json!({"text": {"characters": "Buy now"}});
    patch::apply(doc.get_mut(&copy).unwrap(), &p).unwrap();
    record_override(&mut doc, &copy, &p);

    // Edit the main component's font size; instance keeps its text but picks up the size.
    doc.get_mut("t").unwrap().text.as_mut().unwrap().font_size = 30.0;
    sync_instance(&mut doc, &inst, &mut gen);
    let copy_after = doc.get(&inst).unwrap().children[0].clone();
    assert_eq!(copy_after, copy, "ids are stable across syncs");
    let t = doc.get(&copy_after).unwrap().text.clone().unwrap();
    assert_eq!(t.characters, "Buy now");
    assert_eq!(t.font_size, 30.0);
    assert_eq!(doc.get(&inst).unwrap().x, 300.0);
  }

  #[test]
  fn combine_as_variants_names_the_set_from_the_components() {
    let combine = |names: &[&str]| {
      let mut gen = IdGen::new(5);
      let mut doc = new_document(&mut gen, "t");
      let page = doc.pages[0].id.clone();
      let mut ids = Vec::new();
      for (i, name) in names.iter().enumerate() {
        let id = format!("c{i}");
        doc.insert(
          Node {
            id: id.clone(),
            kind: NodeType::Component,
            name: name.to_string(),
            x: i as f64 * 120.0,
            component: Some(ComponentInfo::default()),
            ..Default::default()
          },
          None,
          &page,
          None,
        );
        ids.push(id);
      }
      let set = combine_as_variants(&mut doc, &ids, &mut gen).unwrap();
      let props: Vec<BTreeMap<String, String>> = ids
        .iter()
        .map(|i| doc.get(i).unwrap().component.as_ref().unwrap().variant_props.clone())
        .collect();
      (doc.get(&set).unwrap().name.clone(), props, doc.get(&ids[0]).unwrap().name.clone())
    };
    let prop = |k: &str, v: &str| BTreeMap::from([(k.to_string(), v.to_string())]);

    let (set, props, first) = combine(&["Button/Primary", "Button/Secondary"]);
    assert_eq!(set, "Button");
    assert_eq!(props, vec![prop("Property 1", "Primary"), prop("Property 1", "Secondary")]);
    assert_eq!(first, "Property 1=Primary");

    let (set, props, _) = combine(&["Icon/Arrow/Small", "Icon/Arrow/Large", "Icon/Check/Small"]);
    assert_eq!(set, "Icon");
    assert_eq!(props[1]["Property 1"], "Arrow");
    assert_eq!(props[1]["Property 2"], "Large");

    let (set, props, _) = combine(&["Size=Small, State=Hover", "Size=Large, State=Hover"]);
    assert_eq!(set, "Component Set");
    assert_eq!(props[1]["Size"], "Large");

    let (set, props, _) = combine(&["Primary", "Secondary"]);
    assert_eq!(set, "Component Set");
    assert_eq!(props, vec![prop("Property 1", "Primary"), prop("Property 1", "Secondary")]);

    // Same names can't tell variants apart: numbered values, the shared name for the set.
    let (set, props, _) = combine(&["Card", "Card"]);
    assert_eq!(set, "Card");
    assert_eq!(props, vec![prop("Property 1", "Variant 1"), prop("Property 1", "Variant 2")]);
  }

  /// Overrides through variant swaps, nested instances and nested swaps.
  mod overrides {
    use crate::components::{carry_overrides, has_overrides, override_count, ROOT_KEY};
    use crate::engine::{Command, Engine};
    use crate::model::{NodeType, Paint};
    use crate::patch;
    use crate::text::HeuristicMeasurer;
    use serde_json::{json, Value};
    use std::collections::BTreeMap;

    const DEFAULT_FILL: &str = "#111111";
    const HOVER_FILL: &str = "#333333";
    const HOVER_BG: &str = "#444444";

    #[test]
    fn variant_swap_keeps_overrides_and_follows_the_rest() {
      let mut k = kit();
      let inst = instance(&mut k.e, &k.default, None);
      let label = named(&k.e, &inst, "Label");
      let bg = named(&k.e, &inst, "Bg");
      set_text(&mut k.e, &label, "Checkout");
      fill(&mut k.e, &bg, "#FF0000");

      variant(&mut k.e, &inst, "Hover");
      assert_eq!(k.e.doc.get(&inst).unwrap().instance.as_ref().unwrap().component_id, k.hover);
      assert_eq!(named(&k.e, &inst, "Label"), label, "corresponding layers keep their ids");
      assert_eq!(text(&k.e, &label), "Checkout", "text override kept");
      assert_eq!(fill_of(&k.e, &bg), "#FF0000", "fill override kept");
      assert_eq!(fill_of(&k.e, &inst), HOVER_FILL, "root fill follows the new variant");
      assert_eq!(font_size(&k.e, &label), 20.0, "font size follows the new variant");

      // Later edits to the new variant still reach the instance; overrides stay on top.
      let hover_label = named(&k.e, &k.hover, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![hover_label],
          patch: json!({ "text": { "fontSize": 24 } }),
        })
        .unwrap();
      assert_eq!(font_size(&k.e, &label), 24.0);
      assert_eq!(text(&k.e, &label), "Checkout");

      variant(&mut k.e, &inst, "Default");
      assert_eq!(text(&k.e, &label), "Checkout");
      assert_eq!(fill_of(&k.e, &bg), "#FF0000");
      assert_eq!(fill_of(&k.e, &inst), DEFAULT_FILL);
      assert_eq!(font_size(&k.e, &label), 16.0);

      // Undo returns to the hover variant with the same overrides.
      k.e.dispatch(Command::Undo).unwrap();
      assert_eq!(fill_of(&k.e, &inst), HOVER_FILL);
      assert_eq!(text(&k.e, &label), "Checkout");
    }

    #[test]
    fn swap_matches_repeated_names_in_order() {
      let mut e = engine();
      let make = |e: &mut Engine, x: f64, name: &str| {
        let f = shape(e, NodeType::Frame, x, None);
        rename(e, &f, name);
        for _ in 0..2 {
          let d = shape(e, NodeType::Rectangle, x, Some(&f));
          rename(e, &d, "Dot");
        }
        id(e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap())
      };
      let a = make(&mut e, 0.0, "A");
      let b = make(&mut e, 300.0, "B");
      let inst = instance(&mut e, &a, None);
      let second = e.doc.get(&inst).unwrap().children[1].clone();
      fill(&mut e, &second, "#00FF00");
      e.dispatch(Command::SwapComponent {
        id: inst.clone(),
        component_id: b,
      })
      .unwrap();
      let kids = e.doc.get(&inst).unwrap().children.clone();
      assert_eq!(fill_of(&e, &kids[1]), "#00FF00");
      assert_ne!(fill_of(&e, &kids[0]), "#00FF00");
    }

    #[test]
    fn nested_override_survives_main_component_edits() {
      let mut k = kit();
      let (card, card_inst) = card(&mut k);
      let nested = nested_instance(&k.e, &card_inst);
      let label = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &label, "Nested");
      fill(&mut k.e, &nested, "#ABCDEF");

      // Edit the Card main component.
      let title = named(&k.e, &card, "Title");
      set_text(&mut k.e, &title, "Pricing");
      assert_eq!(text(&k.e, &named(&k.e, &card_inst, "Title")), "Pricing");
      assert_eq!(text(&k.e, &label), "Nested");
      assert_eq!(fill_of(&k.e, &nested), "#ABCDEF");

      // Edit the Button main component: the change reaches the nested copy, the override stays.
      let main_label = named(&k.e, &k.default, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![main_label],
          patch: json!({ "text": { "fontSize": 30 } }),
        })
        .unwrap();
      assert_eq!(font_size(&k.e, &label), 30.0);
      assert_eq!(text(&k.e, &label), "Nested");

      // Undo/redo of the override itself.
      k.e.dispatch(Command::Undo).unwrap();
      k.e.dispatch(Command::Undo).unwrap();
      assert_eq!(text(&k.e, &label), "Nested");
      k.e.dispatch(Command::Undo).unwrap();
      k.e.dispatch(Command::Undo).unwrap();
      assert_eq!(text(&k.e, &label), "Buy");
      k.e.dispatch(Command::Redo).unwrap();
      assert_eq!(text(&k.e, &label), "Nested");
      k.e.dispatch(Command::Redo).unwrap();
      k.e.dispatch(Command::Redo).unwrap();
      k.e.dispatch(Command::Redo).unwrap();
      assert_eq!(font_size(&k.e, &label), 30.0);

      // Saved and opened again, then the main component is edited once more.
      let mut e2 = engine_seeded(8);
      e2.load(&k.e.to_json()).unwrap();
      assert_eq!(text(&e2, &label), "Nested");
      set_text(&mut e2, &title, "Plans");
      assert_eq!(text(&e2, &named(&e2, &card_inst, "Title")), "Plans");
      assert_eq!(text(&e2, &label), "Nested");
      assert_eq!(fill_of(&e2, &nested), "#ABCDEF");

      // Resetting the nested instance drops what was changed through the card.
      e2.dispatch(Command::ResetInstance { ids: vec![nested.clone()] }).unwrap();
      assert_eq!(text(&e2, &label), "Buy");
      assert_eq!(fill_of(&e2, &nested), DEFAULT_FILL);
      assert_eq!(text(&e2, &named(&e2, &card_inst, "Title")), "Plans");
    }

    #[test]
    fn nested_swap_through_an_outer_instance_persists() {
      let mut k = kit();
      let (card, card_inst) = card(&mut k);
      let nested = nested_instance(&k.e, &card_inst);
      let label = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &label, "Nested");
      let target = named(&k.e, &nested, "Bg");
      fill(&mut k.e, &target, "#FF0000");

      variant(&mut k.e, &nested, "Hover");
      let info = k.e.doc.get(&nested).unwrap().instance.clone().unwrap();
      assert_eq!(info.component_id, k.hover);
      assert_eq!(k.e.doc.get(&nested).unwrap().name, "Component Set", "named after the set");
      assert_eq!(fill_of(&k.e, &nested), HOVER_FILL);
      assert_eq!(
        text(&k.e, &named(&k.e, &nested, "Label")),
        "Nested",
        "override carried into the swap"
      );
      assert_eq!(fill_of(&k.e, &named(&k.e, &nested, "Bg")), "#FF0000");
      assert_eq!(font_size(&k.e, &named(&k.e, &nested, "Label")), 20.0);

      // The Card main component changes: the swap and its overrides stay.
      let target = named(&k.e, &card, "Title");
      set_text(&mut k.e, &target, "Pricing");
      assert_eq!(k.e.doc.get(&nested).unwrap().instance.as_ref().unwrap().component_id, k.hover);
      assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Nested");

      // The variant it was swapped to changes: the nested copy follows.
      let hover_label = named(&k.e, &k.hover, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![hover_label],
          patch: json!({ "text": { "fontSize": 26 } }),
        })
        .unwrap();
      assert_eq!(font_size(&k.e, &named(&k.e, &nested, "Label")), 26.0);
      assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Nested");

      // Overrides made after the swap are kept too.
      let label = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &label, "Deep");
      let target = named(&k.e, &card, "Title");
      set_text(&mut k.e, &target, "Plans");
      assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Deep");

      // Saved and opened again.
      let mut e2 = engine_seeded(8);
      e2.load(&k.e.to_json()).unwrap();
      let target = named(&e2, &card, "Title");
      set_text(&mut e2, &target, "Again");
      assert_eq!(e2.doc.get(&nested).unwrap().instance.as_ref().unwrap().component_id, k.hover);
      assert_eq!(text(&e2, &named(&e2, &nested, "Label")), "Deep");
      assert_eq!(fill_of(&e2, &named(&e2, &nested, "Bg")), "#FF0000");

      // Swapping the nested instance back keeps the overrides; resetting drops the swap.
      variant(&mut e2, &nested, "Default");
      assert_eq!(fill_of(&e2, &nested), DEFAULT_FILL);
      assert_eq!(text(&e2, &named(&e2, &nested, "Label")), "Deep");
      variant(&mut e2, &nested, "Hover");
      e2.dispatch(Command::ResetInstance { ids: vec![nested.clone()] }).unwrap();
      assert_eq!(e2.doc.get(&nested).unwrap().instance.as_ref().unwrap().component_id, k.default);
      assert_eq!(text(&e2, &named(&e2, &nested, "Label")), "Buy");

      // Undo brings the swap back.
      e2.dispatch(Command::Undo).unwrap();
      assert_eq!(e2.doc.get(&nested).unwrap().instance.as_ref().unwrap().component_id, k.hover);
      assert_eq!(text(&e2, &named(&e2, &nested, "Label")), "Deep");
    }

    #[test]
    fn nested_overrides_and_swaps_sync_to_collaborators() {
      let mut k = kit();
      let (card, card_inst) = card(&mut k);
      let mut b = engine_seeded(9);
      b.load(&k.e.to_json()).unwrap();
      let base = k.e.doc.clone();
      let nested = nested_instance(&k.e, &card_inst);
      let target = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &target, "Shared");
      variant(&mut k.e, &nested, "Hover");
      b.dispatch(Command::ApplyRemote {
        delta: crate::collab::delta(&base, &k.e.doc, true, true),
        local: false,
      })
      .unwrap();
      assert_eq!(b.doc.get(&nested).unwrap().instance.as_ref().unwrap().component_id, k.hover);
      assert_eq!(text(&b, &named(&b, &nested, "Label")), "Shared");
      // The collaborator edits the Card main component: both survive on their side.
      let target = named(&b, &card, "Title");
      set_text(&mut b, &target, "Theirs");
      assert_eq!(b.doc.get(&nested).unwrap().instance.as_ref().unwrap().component_id, k.hover);
      assert_eq!(text(&b, &named(&b, &nested, "Label")), "Shared");
      assert_eq!(fill_of(&b, &nested), HOVER_FILL);
    }

    #[test]
    fn instances_in_main_components_from_older_files_are_relinked() {
      let mut k = kit();
      let (card, card_inst) = card(&mut k);
      let in_card = nested_instance(&k.e, &card);
      let main_label = named(&k.e, &in_card, "Label");
      set_text(&mut k.e, &main_label, "In card");
      // Older versions dropped these links (and so recorded no overrides).
      let mut v: Value = serde_json::from_str(&k.e.to_json()).unwrap();
      for nid in k.e.doc.subtree(&in_card).into_iter().skip(1) {
        v["nodes"][&nid]["masterId"] = Value::Null;
      }
      v["nodes"][&in_card]["instance"]["overrides"] = json!({});
      let mut e = engine_seeded(10);
      e.load(&v.to_string()).unwrap();
      assert!(e.doc.get(&main_label).unwrap().master_id.is_some());
      let label = named(&e, &nested_instance(&e, &card_inst), "Label");
      set_text(&mut e, &label, "Through card");
      // Editing the Button main re-syncs the copy in the card without losing either text.
      let button_label = named(&e, &k.default, "Label");
      e.dispatch(Command::Update {
        ids: vec![button_label],
        patch: json!({ "text": { "fontSize": 18 } }),
      })
      .unwrap();
      assert_eq!(text(&e, &main_label), "In card");
      assert_eq!(font_size(&e, &main_label), 18.0);
      assert_eq!(text(&e, &label), "Through card");
      assert_eq!(font_size(&e, &label), 18.0);
    }

    #[test]
    fn swap_keeps_visibility_opacity_strokes_effects_and_resets_cleanly() {
      let mut k = kit();
      let inst = instance(&mut k.e, &k.default, None);
      let bg = named(&k.e, &inst, "Bg");
      let label = named(&k.e, &inst, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![bg.clone()],
          patch: json!({
            "opacity": 0.5,
            "strokes": [{ "type": "solid", "color": "#00FF00" }],
            "strokeWeight": 3,
            "effects": [{ "type": "dropShadow", "color": "#000000", "x": 1, "y": 2, "blur": 3, "spread": 0, "visible": true }],
          }),
        })
        .unwrap();
      k.e
        .dispatch(Command::Update {
          ids: vec![label.clone()],
          patch: json!({ "visible": false }),
        })
        .unwrap();
      variant(&mut k.e, &inst, "Hover");
      let bg = named(&k.e, &inst, "Bg");
      let n = k.e.doc.get(&bg).unwrap();
      assert_eq!(n.opacity, 0.5);
      assert_eq!(n.stroke_weight, 3.0);
      assert_eq!(n.strokes.len(), 1);
      assert_eq!(n.effects.len(), 1);
      assert_eq!(
        fill_of(&k.e, &bg),
        HOVER_BG,
        "the fill was not overridden, so it follows the variant"
      );
      assert!(!k.e.doc.get(&named(&k.e, &inst, "Label")).unwrap().visible);

      // Reset returns to the main component's look, keeping the chosen variant.
      k.e.dispatch(Command::ResetInstance { ids: vec![inst.clone()] }).unwrap();
      let n = k.e.doc.get(&named(&k.e, &inst, "Bg")).unwrap();
      assert_eq!((n.opacity, n.strokes.len(), n.effects.len()), (1.0, 0, 0));
      assert!(k.e.doc.get(&named(&k.e, &inst, "Label")).unwrap().visible);
      assert_eq!(k.e.doc.get(&inst).unwrap().instance.as_ref().unwrap().component_id, k.hover);
    }

    #[test]
    fn swap_drops_overrides_on_layers_the_new_component_lacks() {
      let mut k = kit();
      let inst = instance(&mut k.e, &k.default, None);
      let bg = named(&k.e, &inst, "Bg");
      fill(&mut k.e, &bg, "#FF0000");
      // A component whose only layer has another name.
      let other = shape(&mut k.e, NodeType::Frame, 2000.0, None);
      let layer = shape(&mut k.e, NodeType::Rectangle, 2000.0, Some(&other));
      rename(&mut k.e, &layer, "Panel");
      let other = id(k.e.dispatch(Command::CreateComponent { ids: vec![other] }).unwrap());
      k.e
        .dispatch(Command::SwapComponent {
          id: inst.clone(),
          component_id: other,
        })
        .unwrap();
      let panel = named(&k.e, &inst, "Panel");
      assert_ne!(fill_of(&k.e, &panel), "#FF0000");
      let info = k.e.doc.get(&inst).unwrap().instance.clone().unwrap();
      assert!(info.overrides.is_empty(), "{:?}", info.overrides);
    }

    #[test]
    fn overrides_two_instances_deep_survive_edits_and_saves() {
      let mut k = kit();
      let (_, card_inst) = card(&mut k);
      let card_comp = k.e.doc.get(&card_inst).unwrap().instance.as_ref().unwrap().component_id.clone();
      // A "Panel" component holding a Card instance.
      let f = shape(&mut k.e, NodeType::Frame, 3000.0, None);
      rename(&mut k.e, &f, "Panel");
      k.e
        .dispatch(Command::CreateInstance {
          component_id: card_comp,
          x: 3010.0,
          y: 10.0,
          parent: Some(f.clone()),
          anchor: None,
          into_components: false,
        })
        .unwrap();
      let panel = id(k.e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
      let panel_inst = id(
        k.e
          .dispatch(Command::CreateInstance {
            component_id: panel,
            x: 3500.0,
            y: 900.0,
            parent: None,
            anchor: None,
            into_components: false,
          })
          .unwrap(),
      );
      let label = {
        let button = nested_instance(&k.e, &nested_instance(&k.e, &panel_inst));
        named(&k.e, &button, "Label")
      };
      set_text(&mut k.e, &label, "Deep label");
      let button_label = named(&k.e, &k.default, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![button_label],
          patch: json!({ "text": { "fontSize": 33 } }),
        })
        .unwrap();
      assert_eq!(text(&k.e, &label), "Deep label");
      assert_eq!(font_size(&k.e, &label), 33.0);

      let mut e2 = engine_seeded(11);
      e2.load(&k.e.to_json()).unwrap();
      let title = named(&e2, &panel_inst, "Title");
      set_text(&mut e2, &title, "Changed");
      assert_eq!(text(&e2, &label), "Deep label");
    }

    #[test]
    fn files_without_swap_records_load_and_keep_their_overrides() {
      let mut k = kit();
      let inst = instance(&mut k.e, &k.default, None);
      let label = named(&k.e, &inst, "Label");
      set_text(&mut k.e, &label, "Kept");
      let json = k.e.to_json();
      let mut e = engine_seeded(12);
      e.load(&json).unwrap();
      let label_main = named(&e, &k.default, "Label");
      e.dispatch(Command::Update {
        ids: vec![label_main],
        patch: json!({ "text": { "fontSize": 40 } }),
      })
      .unwrap();
      assert_eq!(text(&e, &label), "Kept");
      assert_eq!(font_size(&e, &label), 40.0);
    }

    #[test]
    fn an_edit_that_puts_back_the_main_value_does_not_pin_it_across_a_swap() {
      let mut k = kit();
      let hover_label = named(&k.e, &k.hover, "Label");
      set_text(&mut k.e, &hover_label, "Buy now");
      let inst = instance(&mut k.e, &k.default, None);
      let label = named(&k.e, &inst, "Label");
      // Typing a letter and deleting it again (a SetText per keystroke), a fill set to what it was.
      set_text(&mut k.e, &label, "Buyx");
      set_text(&mut k.e, &label, "Buy");
      let bg = named(&k.e, &inst, "Bg");
      fill(&mut k.e, &bg, "#FF0000");
      fill(&mut k.e, &bg, "#222222");
      let info = k.e.doc.get(&inst).unwrap().instance.clone().unwrap();
      assert!(info.overrides.is_empty(), "{:?}", info.overrides);
      assert!(!has_overrides(&k.e.doc, &inst));
      variant(&mut k.e, &inst, "Hover");
      assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Buy now");
      assert_eq!(fill_of(&k.e, &named(&k.e, &inst, "Bg")), HOVER_BG);

      // A real override still carries over, and one equal to the *old* main is dropped even
      // when it was recorded before the main changed.
      let label = named(&k.e, &inst, "Label");
      set_text(&mut k.e, &label, "Mine");
      variant(&mut k.e, &inst, "Default");
      assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Mine");
      let old: Value = json!({ "text": { "characters": "Buy" } });
      let id_label = named(&k.e, &k.default, "Label");
      let mut hand = BTreeMap::new();
      hand.insert(id_label, old);
      let carried = carry_overrides(&k.e.doc, &k.default, &k.hover, &hand, &BTreeMap::new());
      assert!(carried.is_empty(), "{carried:?}");
    }

    #[test]
    fn a_no_op_edit_inside_a_nested_instance_is_dropped_too() {
      let mut k = kit();
      let (_, card_inst) = card(&mut k);
      let nested = nested_instance(&k.e, &card_inst);
      let label = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &label, "Buyx");
      set_text(&mut k.e, &label, "Buy");
      assert!(k.e.doc.get(&card_inst).unwrap().instance.as_ref().unwrap().overrides.is_empty());
      variant(&mut k.e, &nested, "Hover");
      assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Buy");
      let t = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &t, "Buy!");
      let t = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &t, "Buy");
      assert_eq!(override_count(&k.e.doc, &nested), 0);
      variant(&mut k.e, &nested, "Default");
      assert_eq!(fill_of(&k.e, &nested), DEFAULT_FILL);
    }

    /// Card set (Kind=A / Kind=B), each holding a Button instance; Panel holds a Card A.
    #[test]
    fn swaps_inside_a_swapped_nested_instance_persist_and_reset_one_level_at_a_time() {
      let mut k = kit();
      let mut cards = vec![];
      for (i, kind) in ["A", "B"].iter().enumerate() {
        let f = shape(&mut k.e, NodeType::Frame, 1000.0 + i as f64 * 400.0, None);
        rename(&mut k.e, &f, "Card");
        let default = k.default.clone();
        let b = instance(&mut k.e, &default, Some(&f));
        rename(&mut k.e, &b, "Btn");
        let c = id(k.e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
        rename(&mut k.e, &c, &format!("Kind={kind}"));
        cards.push(c);
      }
      k.e.dispatch(Command::CombineVariants { ids: cards.clone() }).unwrap();
      let panel_frame = shape(&mut k.e, NodeType::Frame, 3000.0, None);
      rename(&mut k.e, &panel_frame, "Panel");
      k.e
        .dispatch(Command::CreateInstance {
          component_id: cards[0].clone(),
          x: 3010.0,
          y: 10.0,
          parent: Some(panel_frame.clone()),
          anchor: None,
          into_components: false,
        })
        .unwrap();
      let panel = id(k.e.dispatch(Command::CreateComponent { ids: vec![panel_frame] }).unwrap());
      let p = instance(&mut k.e, &panel, None);

      // Level one: the Card inside the Panel instance becomes Kind=B.
      let card_n = nested_instance(&k.e, &p);
      k.e
        .dispatch(Command::SetVariant {
          id: card_n.clone(),
          prop: "Kind".into(),
          value: "B".into(),
        })
        .unwrap();
      assert_eq!(k.e.doc.get(&card_n).unwrap().instance.as_ref().unwrap().component_id, cards[1]);
      // Level two: the Button inside that swapped Card becomes Hover, with its own label.
      let btn = nested_instance(&k.e, &card_n);
      variant(&mut k.e, &btn, "Hover");
      let t = named(&k.e, &btn, "Label");
      set_text(&mut k.e, &t, "Deep");
      let check = |e: &Engine, why: &str| {
        let card_n = nested_instance(e, &p);
        let btn = nested_instance(e, &card_n);
        assert_eq!(
          e.doc.get(&card_n).unwrap().instance.as_ref().unwrap().component_id,
          cards[1],
          "{why}: card"
        );
        assert_eq!(
          e.doc.get(&btn).unwrap().instance.as_ref().unwrap().component_id,
          k.hover,
          "{why}: button"
        );
        assert_eq!(text(e, &named(e, &btn, "Label")), "Deep", "{why}: label");
        assert_eq!(fill_of(e, &btn), HOVER_FILL, "{why}: fill");
        let mut ids: Vec<&String> = e.doc.nodes.keys().collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), e.doc.nodes.len(), "{why}: ids");
      };
      check(&k.e, "after the swaps");

      // Edits to every component involved leave both swaps and the label alone.
      let default_label = named(&k.e, &k.default, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![default_label],
          patch: json!({ "text": { "fontSize": 31 } }),
        })
        .unwrap();
      let hover_bg = named(&k.e, &k.hover, "Bg");
      fill(&mut k.e, &hover_bg, "#ABCDEF");
      let kind_b_children = k.e.doc.get(&cards[1]).unwrap().children.clone();
      assert!(!kind_b_children.is_empty());
      rename(&mut k.e, &kind_b_children[0], "Btn");
      let panel_children = k.e.doc.get(&panel).unwrap().children.clone();
      k.e
        .dispatch(Command::Update {
          ids: vec![panel_children[0].clone()],
          patch: json!({ "x": 15 }),
        })
        .unwrap();
      check(&k.e, "after editing the mains");
      assert_eq!(fill_of(&k.e, &named(&k.e, &btn_of(&k.e, &p), "Bg")), "#ABCDEF");

      // Saved and opened again.
      let mut e2 = engine_seeded(21);
      e2.load(&k.e.to_json()).unwrap();
      let t = named(&e2, &p, "Label");
      set_text(&mut e2, &t, "Deep");
      check(&e2, "after save and load");

      // Reset the Button: back to its source (a Default button, no label override), the Card
      // keeps its swap. Reset the Card: Kind=A again.
      let btn = btn_of(&e2, &p);
      e2.dispatch(Command::ResetInstance { ids: vec![btn.clone()] }).unwrap();
      let card_n = nested_instance(&e2, &p);
      let btn = nested_instance(&e2, &card_n);
      assert_eq!(e2.doc.get(&card_n).unwrap().instance.as_ref().unwrap().component_id, cards[1]);
      assert_eq!(e2.doc.get(&btn).unwrap().instance.as_ref().unwrap().component_id, k.default);
      assert_eq!(text(&e2, &named(&e2, &btn, "Label")), "Buy");
      e2.dispatch(Command::ResetInstance { ids: vec![card_n.clone()] }).unwrap();
      let card_n = nested_instance(&e2, &p);
      assert_eq!(e2.doc.get(&card_n).unwrap().instance.as_ref().unwrap().component_id, cards[0]);
    }

    fn btn_of(e: &Engine, p: &str) -> String {
      nested_instance(e, &nested_instance(e, p))
    }

    #[test]
    fn concurrent_swaps_of_one_instance_converge_on_one_component() {
      let mut k = kit();
      // A third component, apart from the set.
      let f = shape(&mut k.e, NodeType::Frame, 400.0, None);
      rename(&mut k.e, &f, "Button");
      fill(&mut k.e, &f, "#555555");
      let bg = shape(&mut k.e, NodeType::Rectangle, 400.0, Some(&f));
      rename(&mut k.e, &bg, "Bg");
      fill(&mut k.e, &bg, "#222222");
      let t = id(
        k.e
          .dispatch(Command::CreateText {
            x: 410.0,
            y: 10.0,
            characters: "Buy".into(),
            parent: Some(f.clone()),
          })
          .unwrap(),
      );
      rename(&mut k.e, &t, "Label");
      let off = id(k.e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
      // Off looks like Default where Hover doesn't, so B's change leaves those fields alone.
      let hover_label = named(&k.e, &k.hover, "Label");
      set_text(&mut k.e, &hover_label, "Buy!");
      let (default, hover) = (k.default.clone(), k.hover.clone());
      let mut a = k.e;
      let i = instance(&mut a, &default, None);
      let mut b = engine_seeded(32);
      b.load(&a.to_json()).unwrap();
      let mut c = engine_seeded(33);
      c.load(&a.to_json()).unwrap();
      let base = a.doc.clone();
      a.dispatch(Command::SwapComponent {
        id: i.clone(),
        component_id: hover.clone(),
      })
      .unwrap();
      let da = crate::collab::delta(&base, &a.doc, true, true);
      let bbase = b.doc.clone();
      b.dispatch(Command::SwapComponent {
        id: i.clone(),
        component_id: off.clone(),
      })
      .unwrap();
      let db = crate::collab::delta(&bbase, &b.doc, true, true);

      // The relay orders A's change, then B's; a third peer and the relay's own copy apply both
      // in that order.
      c.dispatch(Command::ApplyRemote {
        delta: da.clone(),
        local: false,
      })
      .unwrap();
      c.dispatch(Command::ApplyRemote {
        delta: db.clone(),
        local: false,
      })
      .unwrap();
      let mut relay_doc = base.clone();
      crate::collab::apply(&mut relay_doc, &da).unwrap();
      crate::collab::apply(&mut relay_doc, &db).unwrap();

      // Merging is per field, so the instance can show a mix of both variants' layers until it
      // is next re-synced (STATUS lists this); what matters is that the peer and the relay hold
      // exactly the same thing, and that merging created nothing.
      let shape_of = |doc: &crate::model::Document| -> Vec<String> {
        let mut out = vec![format!("{:?}", doc.get(&i).unwrap().instance)];
        for d in doc.subtree(&i).iter().skip(1) {
          let n = doc.get(d).unwrap();
          out.push(format!(
            "{d} {} {:?} {:?} {:?}",
            n.name,
            n.master_id,
            n.fills,
            n.text.as_ref().map(|t| t.characters.clone())
          ));
        }
        out
      };
      assert_eq!(shape_of(&c.doc), shape_of(&relay_doc));
      assert_eq!(c.doc.get(&i).unwrap().instance.as_ref().unwrap().component_id, off);
      assert_eq!(relay_doc.nodes.len(), base.nodes.len());
    }

    /// A delta that only repoints instances must never make the merge build layers: a peer
    /// (or the relay's room doc) could otherwise be made to do unbounded work by a small patch.
    #[test]
    fn a_patch_that_repoints_instances_creates_no_nodes_when_merged() {
      let mut k = kit();
      let inst = instance(&mut k.e, &k.default, None);
      let mut doc = k.e.doc.clone();
      let before = doc.nodes.len();
      let mut patch = serde_json::Map::new();
      for _ in 0..3 {
        patch.insert(inst.clone(), json!({ "instance": { "componentId": k.hover, "overrides": {} } }));
        crate::collab::apply(&mut doc, &json!({ "patch": patch.clone() })).unwrap();
        patch.insert(inst.clone(), json!({ "instance": { "componentId": k.default, "overrides": {} } }));
        crate::collab::apply(&mut doc, &json!({ "patch": patch.clone() })).unwrap();
      }
      assert_eq!(doc.nodes.len(), before);
      let mut ids: Vec<&String> = doc.nodes.keys().collect();
      ids.sort();
      ids.dedup();
      assert_eq!(ids.len(), doc.nodes.len());
    }

    #[test]
    fn a_nested_instance_swapped_to_a_component_holding_the_outer_main_stays_bounded() {
      let mut k = kit();
      let (card_comp, _) = card(&mut k);
      // Wrap holds a Card instance, so it contains the Card main the outer instance copies.
      let w = shape(&mut k.e, NodeType::Frame, 5000.0, None);
      rename(&mut k.e, &w, "Wrap");
      k.e
        .dispatch(Command::CreateInstance {
          component_id: card_comp.clone(),
          x: 5010.0,
          y: 10.0,
          parent: Some(w.clone()),
          anchor: None,
          into_components: false,
        })
        .unwrap();
      let wrap = id(k.e.dispatch(Command::CreateComponent { ids: vec![w] }).unwrap());
      let o = instance(&mut k.e, &card_comp, None);
      let nested = nested_instance(&k.e, &o);
      let count = k.e.doc.nodes.len();
      k.e
        .dispatch(Command::SwapComponent {
          id: nested.clone(),
          component_id: wrap.clone(),
        })
        .unwrap();
      let nested = nested_instance(&k.e, &o);
      assert_eq!(k.e.doc.get(&nested).unwrap().instance.as_ref().unwrap().component_id, wrap);
      let swapped = k.e.doc.nodes.len();
      assert!(swapped > count && swapped < count + 40, "{count} -> {swapped}");
      // Edits to the mains involved re-sync it without growing.
      let title = named(&k.e, &card_comp, "Title");
      for n in 0..4 {
        k.e
          .dispatch(Command::Update {
            ids: vec![title.clone()],
            patch: json!({ "text": { "fontSize": 20 + n } }),
          })
          .unwrap();
      }
      let default_label = named(&k.e, &k.default, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![default_label],
          patch: json!({ "text": { "fontSize": 40 } }),
        })
        .unwrap();
      assert_eq!(k.e.doc.nodes.len(), swapped);
    }

    #[test]
    fn pasting_an_instance_into_its_own_main_is_refused() {
      let mut k = kit();
      let (card_comp, card_inst) = card(&mut k);
      let data = k.e.copy(std::slice::from_ref(&card_inst));
      let before = k.e.doc.nodes.len();
      let r = k.e.dispatch(Command::Paste {
        data: data.clone(),
        parent: Some(card_comp.clone()),
        x: None,
        y: None,
      });
      assert!(r.is_err());
      assert_eq!(k.e.doc.nodes.len(), before);
      // Elsewhere it pastes as usual.
      let other = shape(&mut k.e, NodeType::Frame, 8000.0, None);
      assert!(k
        .e
        .dispatch(Command::Paste {
          data,
          parent: Some(other),
          x: None,
          y: None
        })
        .is_ok());
    }

    #[test]
    fn pasting_a_copy_of_a_main_into_its_own_main_is_allowed() {
      let mut k = kit();
      let (card_comp, card_inst) = card(&mut k);
      // The copy is a new component, so nothing refers back to the main it lands in.
      let data = k.e.copy(std::slice::from_ref(&card_comp));
      let (comps, nodes) = (k.e.doc.components().len(), k.e.doc.nodes.len());
      let r = k
        .e
        .dispatch(Command::Paste {
          data,
          parent: Some(card_comp.clone()),
          x: None,
          y: None,
        })
        .unwrap();
      let copy = r["created"][0].as_str().unwrap().to_string();
      assert_ne!(copy, card_comp);
      assert_eq!(k.e.doc.get(&copy).unwrap().kind, NodeType::Component);
      assert!(k.e.doc.is_ancestor(&card_comp, &copy));
      assert_eq!(k.e.doc.components().len(), comps + 1);
      assert!(k.e.doc.nodes.len() > nodes);
      // Instances of the main still can't go in, and neither can a layer holding one.
      let data = k.e.copy(std::slice::from_ref(&card_inst));
      let r = k.e.dispatch(Command::Paste {
        data,
        parent: Some(card_comp.clone()),
        x: None,
        y: None,
      });
      assert!(r.is_err());
      let holder = shape(&mut k.e, NodeType::Frame, 9000.0, None);
      instance(&mut k.e, &card_comp, Some(&holder));
      let data = k.e.copy(std::slice::from_ref(&holder));
      let r = k.e.dispatch(Command::Paste {
        data,
        parent: Some(card_comp),
        x: None,
        y: None,
      });
      assert!(r.is_err());
    }

    #[test]
    fn a_component_cannot_end_up_containing_itself() {
      let mut k = kit();
      let (card_comp, _) = card(&mut k);
      let default = k.default.clone();
      // Placing an instance of the Card inside the Card, directly or through another component.
      let r = k.e.dispatch(Command::CreateInstance {
        component_id: card_comp.clone(),
        x: 0.0,
        y: 0.0,
        parent: Some(card_comp.clone()),
        anchor: None,
        into_components: false,
      });
      assert!(r.is_err());
      // Wrapper holds an instance of the Card; the Card can't take an instance of Wrapper.
      let w = shape(&mut k.e, NodeType::Frame, 5000.0, None);
      rename(&mut k.e, &w, "Wrapper");
      k.e
        .dispatch(Command::CreateInstance {
          component_id: card_comp.clone(),
          x: 5010.0,
          y: 10.0,
          parent: Some(w.clone()),
          anchor: None,
          into_components: false,
        })
        .unwrap();
      let wrapper = id(k.e.dispatch(Command::CreateComponent { ids: vec![w] }).unwrap());
      let r = k.e.dispatch(Command::CreateInstance {
        component_id: wrapper.clone(),
        x: 0.0,
        y: 0.0,
        parent: Some(card_comp.clone()),
        anchor: None,
        into_components: false,
      });
      assert!(r.is_err());
      // Moving an instance of Wrapper (made elsewhere) into the Card is refused too.
      let loose = instance(&mut k.e, &wrapper, None);
      let r = k.e.dispatch(Command::MoveToParent {
        ids: vec![loose.clone()],
        parent: Some(card_comp.clone()),
        index: None,
      });
      assert!(r.is_err());
      assert!(!k.e.doc.is_ancestor(&card_comp, &loose));
      // Swapping the Button inside the Wrapper's Card for the Wrapper itself is refused: no change.
      let card_in_wrapper = nested_instance(&k.e, &wrapper);
      let before = k.e.doc.get(&card_in_wrapper).unwrap().instance.clone();
      k.e
        .dispatch(Command::SwapComponent {
          id: card_in_wrapper.clone(),
          component_id: wrapper.clone(),
        })
        .unwrap();
      assert_eq!(k.e.doc.get(&card_in_wrapper).unwrap().instance, before);
      // Swapping the Button inside the Card main (an instance of Default) for the Wrapper
      // would put Wrapper (which holds the Card) inside the Card.
      let button_in_card = nested_instance(&k.e, &card_comp);
      k.e
        .dispatch(Command::SwapComponent {
          id: button_in_card.clone(),
          component_id: wrapper.clone(),
        })
        .unwrap();
      assert_eq!(
        k.e.doc.get(&button_in_card).unwrap().instance.as_ref().unwrap().component_id,
        default
      );
      // Unrelated moves still work.
      let other = shape(&mut k.e, NodeType::Frame, 7000.0, None);
      assert!(k
        .e
        .dispatch(Command::MoveToParent {
          ids: vec![loose],
          parent: Some(other),
          index: None
        })
        .is_ok());
    }

    #[test]
    fn repair_only_touches_instances_inside_main_components() {
      let mut k = kit();
      // A page-level instance whose layers lost their links (a hand-made or imported file).
      let inst = instance(&mut k.e, &k.default, None);
      let label = named(&k.e, &inst, "Label");
      set_text(&mut k.e, &label, "Mine");
      let mut v: Value = serde_json::from_str(&k.e.to_json()).unwrap();
      for d in k.e.doc.subtree(&inst).iter().skip(1) {
        v["nodes"][d]["masterId"] = Value::Null;
      }
      let mut e = engine_seeded(41);
      e.load(&v.to_string()).unwrap();
      assert!(e
        .doc
        .subtree(&inst)
        .iter()
        .skip(1)
        .all(|d| e.doc.get(d).unwrap().master_id.is_none()));

      // The same inside a main component is relinked by layer name, even when the main gained
      // a layer in front of the others since.
      let (card_comp, _) = card(&mut k);
      let nested = nested_instance(&k.e, &card_comp);
      let nested_label = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &nested_label, "Kept in main");
      let mut v: Value = serde_json::from_str(&k.e.to_json()).unwrap();
      for d in k.e.doc.subtree(&nested).iter().skip(1) {
        v["nodes"][d]["masterId"] = Value::Null;
      }
      // Swap the order of the nested instance's children so position alone would mislink them.
      let kids = k.e.doc.get(&nested).unwrap().children.clone();
      let mut rev = kids.clone();
      rev.reverse();
      v["nodes"][&nested]["children"] = json!(rev);
      let mut e = engine_seeded(42);
      e.load(&v.to_string()).unwrap();
      for d in e.doc.subtree(&nested).iter().skip(1) {
        let n = e.doc.get(d).unwrap();
        let m = n.master_id.clone().expect("relinked");
        assert_eq!(
          e.doc.get(&m).unwrap().name,
          n.name,
          "{} linked to the layer of the same name",
          n.name
        );
      }
    }

    #[test]
    fn the_override_count_covers_nested_and_through_outer_overrides() {
      let mut k = kit();
      let (_, card_inst) = card(&mut k);
      let nested = nested_instance(&k.e, &card_inst);
      assert_eq!(override_count(&k.e.doc, &card_inst), 0);
      assert_eq!(override_count(&k.e.doc, &nested), 0);
      let t = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &t, "Hi");
      assert_eq!(override_count(&k.e.doc, &card_inst), 1);
      assert_eq!(override_count(&k.e.doc, &nested), 1);
      let t = named(&k.e, &card_inst, "Title");
      set_text(&mut k.e, &t, "Hello");
      assert_eq!(override_count(&k.e.doc, &card_inst), 2);
      let r = k.e.query(crate::engine::Query::OverrideCount { id: nested.clone() }).unwrap();
      assert_eq!(r["count"], 1);
    }

    fn groups(e: &Engine, id: &str) -> Vec<String> {
      let r = e.query(crate::engine::Query::OverrideGroups { id: id.to_string() }).unwrap();
      r["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["key"].as_str().unwrap().to_string())
        .collect()
    }

    fn reset(e: &mut Engine, id: &str, groups: &[&str]) {
      e.dispatch(Command::ResetOverrideGroups {
        ids: vec![id.to_string()],
        groups: groups.iter().map(|g| g.to_string()).collect(),
      })
      .unwrap();
    }

    fn width(e: &Engine, id: &str) -> f64 {
      e.doc.get(id).unwrap().width
    }

    #[test]
    fn override_groups_sort_a_layers_changes_and_reset_one_at_a_time() {
      let mut k = kit();
      let inst = instance(&mut k.e, &k.default, None);
      let bg = named(&k.e, &inst, "Bg");
      let label = named(&k.e, &inst, "Label");
      assert!(groups(&k.e, &inst).is_empty() && groups(&k.e, &label).is_empty());
      set_text(&mut k.e, &label, "Buy now");
      fill(&mut k.e, &label, "#00FF00");
      fill(&mut k.e, &bg, "#FF0000");
      k.e
        .dispatch(Command::Update {
          ids: vec![inst.clone()],
          patch: json!({ "width": 180.0 }),
        })
        .unwrap();
      assert!(groups(&k.e, &label).contains(&"fill".to_string()));
      assert!(groups(&k.e, &label).contains(&"text".to_string()));
      assert_eq!(groups(&k.e, &bg), vec!["fill"]);
      assert_eq!(groups(&k.e, &inst), vec!["size"]);
      assert_eq!(width(&k.e, &inst), 180.0);

      // One group of the label: the text stays.
      reset(&mut k.e, &label, &["fill"]);
      assert_eq!(text(&k.e, &label), "Buy now");
      assert_ne!(fill_of(&k.e, &label), "#00FF00");
      assert!(!groups(&k.e, &label).contains(&"fill".to_string()));
      assert!(groups(&k.e, &label).contains(&"text".to_string()));
      // The fill follows the main again.
      let main_label = named(&k.e, &k.default, "Label");
      fill(&mut k.e, &main_label, "#123456");
      assert_eq!(fill_of(&k.e, &label), "#123456");
      assert_eq!(text(&k.e, &label), "Buy now");
      // The other layers' overrides are untouched.
      assert_eq!(fill_of(&k.e, &bg), "#FF0000");

      // The root's size: it follows the main's width again.
      reset(&mut k.e, &inst, &["size"]);
      assert_eq!(width(&k.e, &inst), width(&k.e, &k.default));
      assert!(groups(&k.e, &inst).is_empty());
      k.e
        .dispatch(Command::Update {
          ids: vec![k.default.clone()],
          patch: json!({ "width": 222.0 }),
        })
        .unwrap();
      assert_eq!(width(&k.e, &inst), 222.0);

      // Everything on a layer when no group is named; one undo step each.
      reset(&mut k.e, &label, &[]);
      assert_eq!(text(&k.e, &label), "Buy");
      assert!(groups(&k.e, &label).is_empty());
      k.e.dispatch(Command::Undo).unwrap();
      assert_eq!(text(&k.e, &label), "Buy now");
      k.e.dispatch(Command::Redo).unwrap();
      assert_eq!(text(&k.e, &label), "Buy");

      // Typography and text are separate groups of the text layer.
      let l2 = named(&k.e, &inst, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![l2.clone()],
          patch: json!({ "text": { "characters": "Hi", "fontSize": 40 } }),
        })
        .unwrap();
      assert_eq!(groups(&k.e, &l2), vec!["text", "typography"]);
      reset(&mut k.e, &l2, &["typography"]);
      assert_eq!(text(&k.e, &l2), "Hi");
      assert_ne!(font_size(&k.e, &l2), 40.0);
      assert_eq!(groups(&k.e, &l2), vec!["text"]);

      // Saved and opened again: still resettable.
      let mut e2 = engine_seeded(9);
      e2.load(&k.e.to_json()).unwrap();
      reset(&mut e2, &l2, &["text"]);
      assert_eq!(text(&e2, &l2), "Buy");
    }

    #[test]
    fn a_nested_layers_override_resets_through_the_outer_instance() {
      let mut k = kit();
      let (card, card_inst) = card(&mut k);
      let nested = nested_instance(&k.e, &card_inst);
      let label = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &label, "Nested");
      fill(&mut k.e, &label, "#ABCDEF");
      let title = named(&k.e, &card_inst, "Title");
      set_text(&mut k.e, &title, "Pricing");
      assert_eq!(groups(&k.e, &label).len(), 2);
      assert_eq!(groups(&k.e, &title), vec!["text"]);

      reset(&mut k.e, &label, &["fill"]);
      assert_eq!(text(&k.e, &label), "Nested");
      assert_ne!(fill_of(&k.e, &label), "#ABCDEF");
      assert_eq!(groups(&k.e, &label), vec!["text"]);
      assert_eq!(text(&k.e, &title), "Pricing", "other layers untouched");
      // The nested instance's own root can be reset through the card too.
      fill(&mut k.e, &nested, "#FF00FF");
      assert_eq!(groups(&k.e, &nested), vec!["fill"]);
      reset(&mut k.e, &nested, &["fill"]);
      assert_eq!(fill_of(&k.e, &nested), DEFAULT_FILL);
      assert_eq!(text(&k.e, &label), "Nested");
      // The main of the card is untouched by all of it.
      assert_eq!(text(&k.e, &named(&k.e, &card, "Title")), "Welcome");
    }

    #[test]
    fn a_layer_of_a_swapped_instance_resets_where_its_override_lives() {
      let mut k = kit();
      let (_, card_inst) = card(&mut k);
      let nested = nested_instance(&k.e, &card_inst);
      variant(&mut k.e, &nested, "Hover");
      let label = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &label, "Swapped");
      let bg = named(&k.e, &nested, "Bg");
      fill(&mut k.e, &bg, "#FF0000");
      assert_eq!(groups(&k.e, &bg), vec!["fill"]);
      assert!(groups(&k.e, &nested).contains(&"swap".to_string()));
      reset(&mut k.e, &bg, &["fill"]);
      assert_eq!(fill_of(&k.e, &bg), HOVER_BG);
      assert_eq!(text(&k.e, &label), "Swapped");
      assert_eq!(
        k.e.doc.get(&nested).unwrap().instance.as_ref().unwrap().component_id,
        k.hover,
        "swap kept"
      );
      // Resetting only the swap's group puts the default variant back.
      reset(&mut k.e, &nested, &["swap"]);
      assert_eq!(k.e.doc.get(&nested).unwrap().instance.as_ref().unwrap().component_id, k.default);
    }

    #[test]
    fn restore_rebuilds_a_deleted_main_from_the_instance_that_differs_least() {
      let mut k = kit();
      let main = k.default.clone();
      let a = instance(&mut k.e, &main, None);
      let b = instance(&mut k.e, &main, None);
      let a_label = named(&k.e, &a, "Label");
      set_text(&mut k.e, &a_label, "Buy now");
      let master_label = named(&k.e, &main, "Label");
      let master_bg = named(&k.e, &main, "Bg");
      let a_bg = named(&k.e, &a, "Bg");
      let b_label = named(&k.e, &b, "Label");
      let before = k.e.doc.nodes.len();
      assert!(k.e.dispatch(Command::RestoreComponent { id: a.clone() }).is_err(), "main exists");

      k.e.dispatch(Command::Delete { ids: vec![main.clone()] }).unwrap();
      assert!(k.e.doc.get(&main).is_none());
      assert!(k.e.doc.nodes.len() < before);
      let undo_point = k.e.doc.nodes.len();
      // Restoring from the overridden instance takes the other one's text.
      let r = id(k.e.dispatch(Command::RestoreComponent { id: a.clone() }).unwrap());
      assert_eq!(r, main, "the main has its old id");
      let restored = k.e.doc.get(&main).unwrap();
      assert_eq!(restored.kind, NodeType::Component);
      assert!(restored.parent.is_none() && restored.component.is_some());
      assert_eq!(k.e.selection, vec![main.clone()]);
      assert_eq!(text(&k.e, &master_label), "Buy", "from the instance with the fewest changes");
      assert_eq!(k.e.doc.get(&master_bg).unwrap().name, "Bg", "layers have their old ids");
      // Both instances point at it again, and the override is still there.
      for i in [&a, &b] {
        assert_eq!(k.e.doc.get(i).unwrap().instance.as_ref().unwrap().component_id, main);
      }
      assert_eq!(text(&k.e, &a_label), "Buy now");
      assert_eq!(text(&k.e, &b_label), "Buy");
      assert_eq!(k.e.doc.get(&a_label).unwrap().master_id.as_deref(), Some(master_label.as_str()));
      assert_eq!(k.e.doc.get(&a_bg).unwrap().master_id.as_deref(), Some(master_bg.as_str()));
      assert_eq!(groups(&k.e, &a_label), vec!["text"]);
      // It sits clear of the instances' page-level layers and edits reach the instances again.
      k.e
        .dispatch(Command::Update {
          ids: vec![master_label.clone()],
          patch: json!({ "text": { "fontSize": 33 } }),
        })
        .unwrap();
      assert_eq!(font_size(&k.e, &a_label), 33.0);
      assert_eq!(font_size(&k.e, &b_label), 33.0);
      assert_eq!(text(&k.e, &a_label), "Buy now");
      assert!(k.e.dispatch(Command::RestoreComponent { id: b.clone() }).is_err());

      // One undo (of the font edit, then of the restore) removes it again.
      k.e.dispatch(Command::Undo).unwrap();
      k.e.dispatch(Command::Undo).unwrap();
      assert!(k.e.doc.get(&main).is_none());
      assert_eq!(k.e.doc.nodes.len(), undo_point);
    }

    #[test]
    fn restore_works_from_a_component_with_a_nested_instance() {
      let mut k = kit();
      let (card, card_inst) = card(&mut k);
      let other = id(
        k.e
          .dispatch(Command::CreateInstance {
            component_id: card.clone(),
            x: 900.0,
            y: 900.0,
            parent: None,
            anchor: None,
            into_components: false,
          })
          .unwrap(),
      );
      let title = named(&k.e, &card_inst, "Title");
      set_text(&mut k.e, &title, "Mine");
      let nested = nested_instance(&k.e, &card_inst);
      let label = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &label, "Deep");
      k.e.dispatch(Command::Delete { ids: vec![card.clone()] }).unwrap();
      k.e.dispatch(Command::RestoreComponent { id: card_inst.clone() }).unwrap();
      assert_eq!(text(&k.e, &named(&k.e, &card, "Title")), "Welcome");
      let inner = nested_instance(&k.e, &card);
      let inner_label = named(&k.e, &inner, "Label");
      assert_eq!(text(&k.e, &inner_label), "Buy", "from the instance with fewer changes");
      assert_eq!(
        k.e.doc.get(&inner_label).unwrap().master_id.as_deref(),
        Some(named(&k.e, &k.default, "Label").as_str()),
        "nested layers link to the inner component's layers"
      );
      assert_eq!(text(&k.e, &title), "Mine");
      assert_eq!(text(&k.e, &label), "Deep");
      assert_eq!(text(&k.e, &named(&k.e, &other, "Title")), "Welcome");
      // The nested copy follows the Button main through the restored card.
      let main_label = named(&k.e, &k.default, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![main_label],
          patch: json!({ "text": { "fontSize": 31 } }),
        })
        .unwrap();
      assert_eq!(font_size(&k.e, &label), 31.0);
      assert_eq!(text(&k.e, &label), "Deep");
    }

    #[test]
    fn restoring_is_a_delta_that_adds_the_nodes_and_its_revert_removes_them() {
      let mut k = kit();
      let main = k.default.clone();
      let a = instance(&mut k.e, &main, None);
      k.e.dispatch(Command::Delete { ids: vec![main.clone()] }).unwrap();
      let mut peer = engine_seeded(77);
      peer.load(&k.e.to_json()).unwrap();
      let base = k.e.doc.clone();
      k.e.dispatch(Command::RestoreComponent { id: a.clone() }).unwrap();
      let d = crate::collab::delta(&base, &k.e.doc, true, true);
      assert!(d["nodes"].get(&main).is_some(), "the main is added");
      peer.dispatch(Command::ApplyRemote { delta: d, local: false }).unwrap();
      assert_eq!(peer.doc.get(&main).unwrap().kind, NodeType::Component);
      assert_eq!(peer.doc.subtree(&main).len(), k.e.doc.subtree(&main).len());
      // The revert (what undo sends) removes them again.
      let back = crate::collab::delta(&k.e.doc, &base, true, true);
      assert!(back["removed"].as_array().unwrap().iter().any(|r| r == &json!(main)));
      // A reset is a plain per-node patch.
      let label = named(&k.e, &a, "Label");
      set_text(&mut k.e, &label, "Yo");
      let base = k.e.doc.clone();
      reset(&mut k.e, &label, &["text"]);
      let d = crate::collab::delta(&base, &k.e.doc, true, true);
      assert!(d["patch"].get(&label).is_some() || d["patch"].get(&a).is_some());
      assert!(d["nodes"].as_object().is_none_or(|n| n.is_empty()));
    }

    #[test]
    fn an_instance_follows_its_mains_size_until_it_is_resized() {
      let mut k = kit();
      let main = k.default.clone();
      let inst = instance(&mut k.e, &main, None);
      assert_eq!(width(&k.e, &inst), width(&k.e, &main));
      k.e
        .dispatch(Command::Update {
          ids: vec![main.clone()],
          patch: json!({ "width": 200.0 }),
        })
        .unwrap();
      assert_eq!(width(&k.e, &inst), 200.0, "follows the main");
      k.e
        .dispatch(Command::Update {
          ids: vec![inst.clone()],
          patch: json!({ "width": 180.0 }),
        })
        .unwrap();
      k.e
        .dispatch(Command::Update {
          ids: vec![main.clone()],
          patch: json!({ "width": 260.0 }),
        })
        .unwrap();
      assert_eq!(width(&k.e, &inst), 180.0, "a resized instance keeps its size");
    }

    #[test]
    fn restore_never_takes_a_nested_copy_as_its_source() {
      let mut k = kit();
      let main = k.default.clone();
      let (card, card_inst) = card(&mut k);
      let a = instance(&mut k.e, &main, None);
      let b = instance(&mut k.e, &main, None);
      let al = named(&k.e, &a, "Label");
      set_text(&mut k.e, &al, "Top A");
      let bl = named(&k.e, &b, "Label");
      set_text(&mut k.e, &bl, "Top B");
      let nested = nested_instance(&k.e, &card_inst);
      let nl = named(&k.e, &nested, "Label");
      k.e
        .dispatch(Command::Delete {
          ids: vec![main.clone(), card.clone()],
        })
        .unwrap();
      k.e.dispatch(Command::RestoreComponent { id: a.clone() }).unwrap();
      let restored = named(&k.e, &main, "Label");
      for (inst, expect) in [(&a, "Top A"), (&b, "Top B")] {
        let l = named(&k.e, inst, "Label");
        assert_eq!(text(&k.e, &l), expect, "override intact");
        assert_eq!(
          k.e.doc.get(&l).unwrap().master_id.as_deref(),
          Some(restored.as_str()),
          "linked to the restored layer"
        );
        assert_eq!(groups(&k.e, &l), vec!["text"]);
      }
      let _ = nl;
    }

    #[test]
    fn resetting_a_swap_takes_its_name_along() {
      let mut k = kit();
      let (_, card_inst) = card(&mut k);
      let f = shape(&mut k.e, NodeType::Frame, 3000.0, None);
      rename(&mut k.e, &f, "Other");
      let other = id(k.e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
      let nested = nested_instance(&k.e, &card_inst);
      let name0 = k.e.doc.get(&nested).unwrap().name.clone();
      k.e
        .dispatch(Command::SwapComponent {
          id: nested.clone(),
          component_id: other,
        })
        .unwrap();
      assert_eq!(k.e.doc.get(&nested).unwrap().name, "Other");
      assert_eq!(
        groups(&k.e, &nested),
        vec!["swap"],
        "the name a swap brings isn't a change of its own"
      );
      reset(&mut k.e, &nested, &["swap"]);
      assert_eq!(k.e.doc.get(&nested).unwrap().name, name0);
      assert!(groups(&k.e, &nested).is_empty());
    }

    #[test]
    fn nothing_resets_while_the_main_is_deleted_and_it_returns_after_a_restore() {
      let mut k = kit();
      let main = k.default.clone();
      let a = instance(&mut k.e, &main, None);
      let l = named(&k.e, &a, "Label");
      set_text(&mut k.e, &l, "Mine");
      k.e.dispatch(Command::Delete { ids: vec![main.clone()] }).unwrap();
      assert!(groups(&k.e, &l).is_empty() && groups(&k.e, &a).is_empty());
      let r = k
        .e
        .dispatch(Command::ResetOverrideGroups {
          ids: vec![l.clone()],
          groups: vec![],
        })
        .unwrap();
      assert_eq!(r["changed"], false);
      k.e.dispatch(Command::RestoreComponent { id: a.clone() }).unwrap();
      assert_eq!(text(&k.e, &l), "Mine");
      assert_eq!(groups(&k.e, &l), vec!["text"]);
    }

    #[test]
    fn restore_links_layers_two_instances_deep_to_the_outer_main() {
      let mut k = kit();
      let (card, _) = card(&mut k);
      let f = shape(&mut k.e, NodeType::Frame, 5000.0, None);
      rename(&mut k.e, &f, "Panel");
      k.e
        .dispatch(Command::Update {
          ids: vec![f.clone()],
          patch: json!({ "width": 400, "height": 300 }),
        })
        .unwrap();
      instance(&mut k.e, &card, Some(&f));
      let panel = id(k.e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
      let pi = instance(&mut k.e, &panel, None);
      let deep = named(&k.e, &pi, "Label");
      set_text(&mut k.e, &deep, "Deep");
      k.e.dispatch(Command::Delete { ids: vec![panel.clone()] }).unwrap();
      k.e.dispatch(Command::RestoreComponent { id: pi.clone() }).unwrap();
      let card_in = nested_instance(&k.e, &panel);
      let button_in = nested_instance(&k.e, &card_in);
      let deep_main = named(&k.e, &button_in, "Label");
      let deep_copy = named(&k.e, &pi, "Label");
      assert_eq!(text(&k.e, &deep_copy), "Deep");
      // The copy points at the restored Panel's layer, which in turn is a copy of the Card main's.
      assert_eq!(k.e.doc.get(&deep_copy).unwrap().master_id.as_deref(), Some(deep_main.as_str()));
      assert_ne!(
        k.e.doc.get(&deep_main).unwrap().master_id,
        k.e.doc.get(&deep_copy).unwrap().master_id,
        "the layer in the restored main links one level up"
      );
      // An edit in the restored main survives a later edit of the Card main.
      set_text(&mut k.e, &deep_main, "EditedInMain");
      let title = named(&k.e, &card, "Title");
      set_text(&mut k.e, &title, "Card title changed");
      let again = named(&k.e, &nested_instance(&k.e, &nested_instance(&k.e, &panel)), "Label");
      assert_eq!(text(&k.e, &again), "EditedInMain");
    }

    #[test]
    fn a_restored_main_lands_on_the_page_of_the_instance_you_used() {
      let mut k = kit();
      let main = k.default.clone();
      let p1 = k.e.page.clone();
      let a = instance(&mut k.e, &main, None);
      let al = named(&k.e, &a, "Label");
      set_text(&mut k.e, &al, "x");
      k.e.dispatch(Command::AddPage { name: None }).unwrap();
      let p2 = k.e.page.clone();
      assert_ne!(p1, p2);
      // The clean instance on page 2 is the least-changed source; the main still goes where `a` is.
      instance(&mut k.e, &main, None);
      k.e.dispatch(Command::SetPage { id: p1.clone() }).unwrap();
      k.e.dispatch(Command::Delete { ids: vec![main.clone()] }).unwrap();
      k.e.dispatch(Command::RestoreComponent { id: a.clone() }).unwrap();
      for d in k.e.doc.subtree(&main) {
        assert_eq!(k.e.doc.get(&d).unwrap().page, p1);
      }
      assert!(k.e.doc.page(&p1).unwrap().children.contains(&main));
      assert!(!k.e.doc.page(&p2).unwrap().children.contains(&main));
    }

    #[test]
    fn reset_size_brings_back_hug_and_auto_resize_and_runs_are_typography() {
      let mut k = kit();
      let inst = instance(&mut k.e, &k.default.clone(), None);
      let l = named(&k.e, &inst, "Label");
      let auto = k.e.doc.get(&l).unwrap().text.as_ref().unwrap().auto_resize;
      let w0 = width(&k.e, &l);
      k.e
        .dispatch(Command::Update {
          ids: vec![l.clone()],
          patch: json!({ "width": 300.0, "text": { "autoResize": "none" } }),
        })
        .unwrap();
      assert_eq!(groups(&k.e, &l), vec!["size"]);
      reset(&mut k.e, &l, &["size"]);
      assert_eq!(k.e.doc.get(&l).unwrap().text.as_ref().unwrap().auto_resize, auto);
      assert_eq!(width(&k.e, &l), w0);
      assert!(groups(&k.e, &l).is_empty());
      // Bolding a word is typography, not text.
      k.e
        .dispatch(Command::Update {
          ids: vec![l.clone()],
          patch: json!({ "text": { "runs": [{ "start": 0, "end": 2, "fontWeight": 800 }] } }),
        })
        .unwrap();
      assert_eq!(groups(&k.e, &l), vec!["typography"]);
      reset(&mut k.e, &l, &["typography"]);
      assert!(groups(&k.e, &l).is_empty());
      assert!(k.e.doc.get(&l).unwrap().text.as_ref().unwrap().runs.is_empty());
    }

    #[test]
    fn a_restored_variant_says_it_stands_alone() {
      let mut k = kit();
      let main = k.default.clone();
      let a = instance(&mut k.e, &main, None);
      k.e.dispatch(Command::Delete { ids: vec![main.clone()] }).unwrap();
      k.e.dispatch(Command::RestoreComponent { id: a.clone() }).unwrap();
      assert_eq!(k.e.doc.get(&main).unwrap().name, "Component Set (restored)");
    }

    #[test]
    fn two_people_restoring_the_same_main_converge() {
      let mut k = kit();
      let main = k.default.clone();
      let a = instance(&mut k.e, &main, None);
      let b = instance(&mut k.e, &main, None);
      let al = named(&k.e, &a, "Label");
      set_text(&mut k.e, &al, "A");
      let bl = named(&k.e, &b, "Label");
      set_text(&mut k.e, &bl, "B");
      k.e.dispatch(Command::Delete { ids: vec![main.clone()] }).unwrap();
      let json = k.e.to_json();
      let mut p = engine_seeded(101);
      p.load(&json).unwrap();
      let mut q = engine_seeded(202);
      q.load(&json).unwrap();
      let base = p.doc.clone();
      p.dispatch(Command::RestoreComponent { id: a.clone() }).unwrap();
      q.dispatch(Command::RestoreComponent { id: b.clone() }).unwrap();
      let dp = crate::collab::delta(&base, &p.doc, true, true);
      let dq = crate::collab::delta(&base, &q.doc, true, true);
      p.dispatch(Command::ApplyRemote { delta: dq, local: false }).unwrap();
      q.dispatch(Command::ApplyRemote { delta: dp, local: false }).unwrap();
      for e in [&p, &q] {
        assert_eq!(
          e.doc.pages[0].children.iter().filter(|c| **c == main).count(),
          1,
          "one entry on the page"
        );
        assert_eq!(text(e, &named(e, &a, "Label")), "A");
        assert_eq!(text(e, &named(e, &b, "Label")), "B");
      }
      assert_eq!(p.doc.subtree(&main).len(), q.doc.subtree(&main).len());
    }

    #[test]
    fn restore_keeps_overrides_on_nested_layers_named_unlike_their_component() {
      let mut k = kit();
      let (card, card_inst) = card(&mut k);
      let in_main = nested_instance(&k.e, &card);
      let bg_main = named(&k.e, &in_main, "Bg");
      rename(&mut k.e, &bg_main, "Background");
      instance(&mut k.e, &card, None);
      let deep = named(&k.e, &card_inst, "Background");
      fill(&mut k.e, &deep, "#ABCDEF");
      k.e.dispatch(Command::Delete { ids: vec![card.clone()] }).unwrap();
      k.e.dispatch(Command::RestoreComponent { id: card_inst.clone() }).unwrap();
      let r_bg = named(&k.e, &nested_instance(&k.e, &card), "Background");
      let deep2 = named(&k.e, &card_inst, "Background");
      assert_eq!(fill_of(&k.e, &deep2), "#ABCDEF");
      assert_eq!(k.e.doc.get(&deep2).unwrap().master_id.as_deref(), Some(r_bg.as_str()));
    }

    #[test]
    fn restore_keeps_overrides_on_auto_named_text_inside_a_nested_instance() {
      let mut e = engine();
      let f = shape(&mut e, NodeType::Frame, 0.0, None);
      rename(&mut e, &f, "Btn");
      id(
        e.dispatch(Command::CreateText {
          x: 0.0,
          y: 0.0,
          characters: "Go".into(),
          parent: Some(f.clone()),
        })
        .unwrap(),
      );
      let btn = id(e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
      let c = shape(&mut e, NodeType::Frame, 1000.0, None);
      rename(&mut e, &c, "Card2");
      e.dispatch(Command::Update {
        ids: vec![c.clone()],
        patch: json!({ "width": 300, "height": 200 }),
      })
      .unwrap();
      instance(&mut e, &btn, Some(&c));
      let card = id(e.dispatch(Command::CreateComponent { ids: vec![c] }).unwrap());
      let is_text = |e: &Engine, i: &String| e.doc.get(i).unwrap().kind == NodeType::Text;
      let main_text = e.doc.subtree(&card).into_iter().find(|i| is_text(&e, i)).unwrap();
      set_text(&mut e, &main_text, "Start");
      let ci = instance(&mut e, &card, None);
      instance(&mut e, &card, None);
      let deep = e.doc.subtree(&ci).into_iter().find(|i| is_text(&e, i)).unwrap();
      set_text(&mut e, &deep, "Mine");
      e.dispatch(Command::Delete { ids: vec![card.clone()] }).unwrap();
      e.dispatch(Command::RestoreComponent { id: ci.clone() }).unwrap();
      let deep2 = e.doc.subtree(&ci).into_iter().find(|i| is_text(&e, i)).unwrap();
      assert_eq!(text(&e, &deep2), "Mine");
    }

    #[test]
    fn resetting_size_on_an_instance_root_brings_hug_back() {
      let mut k = kit();
      let main = k.default.clone();
      k.e.dispatch(Command::AddAutoLayout { ids: vec![main.clone()] }).unwrap();
      k.e
        .dispatch(Command::Update {
          ids: vec![main.clone()],
          patch: json!({ "sizingH": "hug" }),
        })
        .unwrap();
      let inst = instance(&mut k.e, &main, None);
      assert_eq!(k.e.doc.get(&inst).unwrap().sizing_h, crate::model::Sizing::Hug);
      k.e
        .dispatch(Command::Update {
          ids: vec![inst.clone()],
          patch: json!({ "width": 400.0, "sizingH": "fixed" }),
        })
        .unwrap();
      assert_eq!(width(&k.e, &inst), 400.0);
      reset(&mut k.e, &inst, &["size"]);
      assert_eq!(k.e.doc.get(&inst).unwrap().sizing_h, crate::model::Sizing::Hug);
      assert_ne!(width(&k.e, &inst), 400.0);
    }

    // QA round 14 (r14a): bindings, modes and styles on instance layers.

    /// A Theme collection (Light, Dark) with a colour variable `Text/Primary` and a number `Gap`.
    fn tokens(e: &mut Engine) {
      e.doc.variables = serde_json::from_value(json!([
        { "id": "c_t", "name": "Theme", "modes": [{ "id": "m_l", "name": "Light" }, { "id": "m_d", "name": "Dark" }],
          "variables": [
            { "id": "v_p", "name": "Primary", "type": "color", "values": { "m_l": "#111111", "m_d": "#EEEEEE" } },
            { "id": "v_q", "name": "Other", "type": "color", "values": { "m_l": "#AA0000", "m_d": "#0000AA" } },
            { "id": "v_w", "name": "Wide", "type": "number", "values": { "m_l": 100, "m_d": 140 } } ] }
      ]))
      .unwrap();
    }

    fn bind(e: &mut Engine, id: &str, prop: &str, var: Option<&str>) {
      e.dispatch(Command::BindVariable {
        ids: vec![id.to_string()],
        property: prop.into(),
        variable: var.map(String::from),
      })
      .unwrap();
    }

    fn mode(e: &mut Engine, id: &str, m: Option<&str>) {
      e.dispatch(Command::SetVariableMode {
        ids: vec![id.to_string()],
        collection: "Theme".into(),
        mode: m.map(String::from),
      })
      .unwrap();
    }

    fn override_of(e: &Engine, inst: &str, key: &str) -> Value {
      e.doc
        .get(inst)
        .unwrap()
        .instance
        .as_ref()
        .unwrap()
        .overrides
        .get(key)
        .cloned()
        .unwrap_or(Value::Null)
    }

    fn bound(e: &Engine, id: &str, prop: &str) -> Option<String> {
      e.doc.get(id).unwrap().bindings.get(prop).cloned()
    }

    /// A bound main label, an instance of it inside a frame whose mode can change.
    fn bound_kit() -> (Kit, String, String, String) {
      let mut k = kit();
      tokens(&mut k.e);
      let main_label = named(&k.e, &k.default, "Label");
      bind(&mut k.e, &main_label, "fill", Some("v_p"));
      let frame = shape(&mut k.e, NodeType::Frame, 900.0, None);
      let inst = instance(&mut k.e, &k.default, Some(&frame));
      let label = named(&k.e, &inst, "Label");
      (k, frame, inst, label)
    }

    #[test]
    fn a_colour_typed_on_an_instance_layer_survives_mode_changes_and_edits_of_the_main() {
      let (mut k, frame, inst, label) = bound_kit();
      assert_eq!(fill_of(&k.e, &label), "#111111");
      fill(&mut k.e, &label, "#00FF00");
      assert_eq!(
        override_of(&k.e, &inst, &named_master(&k.e, &label))["bindings"]["fill"],
        Value::Null
      );
      assert!(bound(&k.e, &label, "fill").is_none());
      // The main is edited (this re-syncs the copy) and the frame's mode changes.
      let main_label = named(&k.e, &k.default, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![main_label.clone()],
          patch: json!({ "opacity": 0.5 }),
        })
        .unwrap();
      mode(&mut k.e, &frame, Some("Dark"));
      assert_eq!(fill_of(&k.e, &label), "#00FF00");
      assert!(bound(&k.e, &label, "fill").is_none());
      // The main's own label still follows the mode (it is in no frame here, so check the token).
      assert_eq!(bound(&k.e, &main_label, "fill").as_deref(), Some("v_p"));
      // Reset "Variables" binds it again.
      reset(&mut k.e, &label, &["variables"]);
      assert_eq!(bound(&k.e, &label, "fill").as_deref(), Some("v_p"));
      assert_eq!(fill_of(&k.e, &label), "#EEEEEE");
    }

    fn named_master(e: &Engine, id: &str) -> String {
      e.doc.get(id).unwrap().master_id.clone().unwrap()
    }

    #[test]
    fn a_colour_typed_on_the_instance_root_survives_too() {
      let mut k = kit();
      tokens(&mut k.e);
      bind(&mut k.e, &k.default.clone(), "fill", Some("v_p"));
      let frame = shape(&mut k.e, NodeType::Frame, 900.0, None);
      let inst = instance(&mut k.e, &k.default, Some(&frame));
      fill(&mut k.e, &inst, "#00FF00");
      assert_eq!(override_of(&k.e, &inst, ROOT_KEY)["bindings"]["fill"], Value::Null);
      k.e
        .dispatch(Command::Update {
          ids: vec![k.default.clone()],
          patch: json!({ "cornerRadius": 9.0 }),
        })
        .unwrap();
      mode(&mut k.e, &frame, Some("Dark"));
      assert_eq!(fill_of(&k.e, &inst), "#00FF00");
      reset(&mut k.e, &inst, &["variables"]);
      assert_eq!(fill_of(&k.e, &inst), "#EEEEEE");
    }

    #[test]
    fn typing_a_colour_is_one_undo_step() {
      let (mut k, _, inst, label) = bound_kit();
      fill(&mut k.e, &label, "#00FF00");
      k.e.dispatch(Command::Undo).unwrap();
      assert_eq!(bound(&k.e, &label, "fill").as_deref(), Some("v_p"));
      assert_eq!(fill_of(&k.e, &label), "#111111");
      assert!(k.e.doc.get(&inst).unwrap().instance.as_ref().unwrap().overrides.is_empty());
      k.e.dispatch(Command::Redo).unwrap();
      assert_eq!(fill_of(&k.e, &label), "#00FF00");
      assert!(bound(&k.e, &label, "fill").is_none());
    }

    #[test]
    fn rebinding_and_detaching_on_an_instance_layer_are_overrides() {
      let (mut k, _, inst, label) = bound_kit();
      let main_label = named(&k.e, &k.default, "Label");
      bind(&mut k.e, &label, "fill", Some("v_q"));
      k.e
        .dispatch(Command::Update {
          ids: vec![main_label.clone()],
          patch: json!({ "opacity": 0.5 }),
        })
        .unwrap();
      assert_eq!(bound(&k.e, &label, "fill").as_deref(), Some("v_q"));
      assert_eq!(fill_of(&k.e, &label), "#AA0000");
      // Detach: the colour the variable painted stays.
      bind(&mut k.e, &label, "fill", None);
      k.e
        .dispatch(Command::Update {
          ids: vec![main_label],
          patch: json!({ "opacity": 0.6 }),
        })
        .unwrap();
      assert!(bound(&k.e, &label, "fill").is_none());
      assert_eq!(fill_of(&k.e, &label), "#AA0000");
      reset(&mut k.e, &inst, &[]);
      reset(&mut k.e, &label, &[]);
      assert_eq!(bound(&k.e, &label, "fill").as_deref(), Some("v_p"));
    }

    #[test]
    fn a_mode_pinned_on_an_instance_root_is_an_override_and_null_removes_it() {
      let (mut k, _, inst, label) = bound_kit();
      mode(&mut k.e, &inst, Some("Dark"));
      assert_eq!(override_of(&k.e, &inst, ROOT_KEY)["variableModes"]["c_t"], "m_d");
      k.e
        .dispatch(Command::Update {
          ids: vec![k.default.clone()],
          patch: json!({ "cornerRadius": 4.0 }),
        })
        .unwrap();
      assert_eq!(
        k.e.doc.get(&inst).unwrap().variable_modes.get("c_t").map(String::as_str),
        Some("m_d")
      );
      assert_eq!(fill_of(&k.e, &label), "#EEEEEE");
      mode(&mut k.e, &inst, None);
      k.e
        .dispatch(Command::Update {
          ids: vec![k.default.clone()],
          patch: json!({ "cornerRadius": 5.0 }),
        })
        .unwrap();
      assert!(k.e.doc.get(&inst).unwrap().variable_modes.is_empty());
      assert_eq!(fill_of(&k.e, &label), "#111111");
    }

    #[test]
    fn override_records_with_null_survive_save_load_and_collab() {
      let (mut k, _, inst, label) = bound_kit();
      let base = k.e.doc.clone();
      fill(&mut k.e, &label, "#00FF00");
      let key = named_master(&k.e, &label);
      let want = override_of(&k.e, &inst, &key);
      // Save and load.
      let mut e2 = Engine::new(Box::new(HeuristicMeasurer), 3);
      e2.load(&k.e.to_json()).unwrap();
      assert_eq!(override_of(&e2, &inst, &key), want);
      assert_eq!(want["bindings"]["fill"], Value::Null);
      // A peer applies the delta.
      let d = crate::collab::delta(&base, &k.e.doc, true, true);
      let mut peer = base.clone();
      crate::collab::apply(&mut peer, &d).unwrap();
      assert_eq!(peer.get(&inst).unwrap().instance.as_ref().unwrap().overrides.get(&key), Some(&want));
      // And a selective revert takes it back out.
      let back = crate::collab::revert(&peer, &k.e.doc, &base);
      assert!(back.get(&inst).unwrap().instance.as_ref().unwrap().overrides.is_empty());
    }

    #[test]
    fn an_old_file_without_nulls_loads_and_a_patch_removes_or_adds_bindings() {
      let (mut k, _, _, label) = bound_kit();
      let n = k.e.doc.get(&label).unwrap().clone();
      let mut m = n;
      patch::apply(&mut m, &json!({ "bindings": { "fill": null } })).unwrap();
      assert!(m.bindings.is_empty());
      patch::apply(&mut m, &json!({ "bindings": { "fill": "v_q" } })).unwrap();
      assert_eq!(m.bindings["fill"], "v_q");
      k.e
        .dispatch(Command::Update {
          ids: vec![label.clone()],
          patch: json!({ "bindings": { "fill": null } }),
        })
        .unwrap();
      assert!(bound(&k.e, &label, "fill").is_none());
    }

    #[test]
    fn a_style_and_a_variable_replace_each_other_on_fills_and_strokes() {
      let mut k = kit();
      tokens(&mut k.e);
      k.e
        .dispatch(Command::AddColorStyle {
          name: "Brand".into(),
          color: "#FF00FF".into(),
        })
        .unwrap();
      let sid = k.e.doc.styles.colors[0].id.clone();
      let r = named(&k.e, &k.default, "Bg");
      bind(&mut k.e, &r, "fill", Some("v_p"));
      assert!(bound(&k.e, &r, "fill").is_some());
      k.e
        .dispatch(Command::ApplyStyle {
          ids: vec![r.clone()],
          style_id: sid.clone(),
          kind: None,
        })
        .unwrap();
      assert!(bound(&k.e, &r, "fill").is_none());
      assert_eq!(fill_of(&k.e, &r), "#FF00FF");
      assert_eq!(k.e.doc.get(&r).unwrap().fill_style.as_deref(), Some(sid.as_str()));
      bind(&mut k.e, &r, "fill", Some("v_q"));
      assert!(k.e.doc.get(&r).unwrap().fill_style.is_none());
      assert_eq!(fill_of(&k.e, &r), "#AA0000");
      // Strokes.
      bind(&mut k.e, &r, "stroke", Some("v_p"));
      k.e
        .dispatch(Command::ApplyStyle {
          ids: vec![r.clone()],
          style_id: sid.clone(),
          kind: Some("stroke".into()),
        })
        .unwrap();
      assert!(bound(&k.e, &r, "stroke").is_none());
      assert!(bound(&k.e, &r, "fill").is_some());
      bind(&mut k.e, &r, "stroke", Some("v_q"));
      assert!(k.e.doc.get(&r).unwrap().stroke_style.is_none());
    }

    #[test]
    fn a_text_style_on_an_instance_label_records_the_unbinding_as_an_override() {
      let mut k = kit();
      tokens(&mut k.e);
      k.e.doc.styles_mut().texts.push(crate::model::TextStyle {
        id: "ts".into(),
        name: "Body".into(),
        font_family: "Inter".into(),
        font_size: 22.0,
        font_weight: 400,
        ..Default::default()
      });
      let main_label = named(&k.e, &k.default, "Label");
      bind(&mut k.e, &main_label, "fontSize", Some("v_w"));
      assert_eq!(font_size(&k.e, &main_label), 100.0);
      let inst = instance(&mut k.e, &k.default, None);
      let label = named(&k.e, &inst, "Label");
      assert_eq!(font_size(&k.e, &label), 100.0);
      k.e
        .dispatch(Command::ApplyStyle {
          ids: vec![label.clone()],
          style_id: "ts".into(),
          kind: None,
        })
        .unwrap();
      let key = named_master(&k.e, &label);
      assert_eq!(override_of(&k.e, &inst, &key)["bindings"]["fontSize"], Value::Null);
      assert_eq!(font_size(&k.e, &label), 22.0);
      // An edit of the main re-syncs the copy: the style still wins over the main's variable.
      k.e
        .dispatch(Command::Update {
          ids: vec![main_label.clone()],
          patch: json!({ "opacity": 0.5 }),
        })
        .unwrap();
      assert_eq!(font_size(&k.e, &label), 22.0);
      assert!(bound(&k.e, &label, "fontSize").is_none());
      assert_eq!(font_size(&k.e, &main_label), 100.0);
    }

    #[test]
    fn style_and_variable_choices_on_an_instance_layer_survive_edits_of_the_main() {
      let mut k = kit();
      tokens(&mut k.e);
      k.e
        .dispatch(Command::AddColorStyle {
          name: "Brand".into(),
          color: "#FF00FF".into(),
        })
        .unwrap();
      let sid = k.e.doc.styles.colors[0].id.clone();
      let main_bg = named(&k.e, &k.default, "Bg");
      bind(&mut k.e, &main_bg, "fill", Some("v_p"));
      let inst = instance(&mut k.e, &k.default, None);
      let bg = named(&k.e, &inst, "Bg");
      k.e
        .dispatch(Command::ApplyStyle {
          ids: vec![bg.clone()],
          style_id: sid,
          kind: None,
        })
        .unwrap();
      k.e
        .dispatch(Command::Update {
          ids: vec![main_bg.clone()],
          patch: json!({ "opacity": 0.5 }),
        })
        .unwrap();
      assert!(bound(&k.e, &bg, "fill").is_none());
      assert_eq!(fill_of(&k.e, &bg), "#FF00FF");
      bind(&mut k.e, &bg, "fill", Some("v_q"));
      k.e
        .dispatch(Command::Update {
          ids: vec![main_bg],
          patch: json!({ "opacity": 0.6 }),
        })
        .unwrap();
      assert_eq!(bound(&k.e, &bg, "fill").as_deref(), Some("v_q"));
      assert!(k.e.doc.get(&bg).unwrap().fill_style.is_none());
    }

    #[test]
    fn mode_and_collection_names_must_be_unique_but_old_duplicates_still_save() {
      let mut k = kit();
      tokens(&mut k.e);
      let rename_mode = |e: &mut Engine, name: &str| {
        let mut cs = crate::variables::plain(&e.doc.variables);
        cs[0].modes[1].name = name.into();
        e.dispatch(Command::SetVariables { collections: cs })
      };
      assert!(rename_mode(&mut k.e, "Light").unwrap_err().contains("already exists"));
      assert!(rename_mode(&mut k.e, " Light ").is_err());
      rename_mode(&mut k.e, "Night").unwrap();
      // A new collection with a taken name.
      let mut cs = crate::variables::plain(&k.e.doc.variables);
      cs.push(crate::variables::Collection {
        id: "c_2".into(),
        name: "Theme".into(),
        ..Default::default()
      });
      assert!(k
        .e
        .dispatch(Command::SetVariables { collections: cs })
        .unwrap_err()
        .contains("Theme"));
      let mut cs = crate::variables::plain(&k.e.doc.variables);
      cs.push(crate::variables::Collection {
        id: "c_2".into(),
        name: "Spacing".into(),
        ..Default::default()
      });
      cs[1].name = "Theme".into();
      assert!(k.e.dispatch(Command::SetVariables { collections: cs.clone() }).is_err());
      cs[1].name = "Spacing".into();
      k.e.dispatch(Command::SetVariables { collections: cs }).unwrap();
      // A file that already has two "Dark" modes can still edit a value.
      std::sync::Arc::make_mut(&mut k.e.doc.variables[0]).modes[0].name = "Night".into();
      let mut cs = crate::variables::plain(&k.e.doc.variables);
      std::sync::Arc::make_mut(&mut cs[0].variables[0])
        .values
        .insert("m_l".into(), json!("#222222"));
      k.e.dispatch(Command::SetVariables { collections: cs }).unwrap();
    }

    #[test]
    fn overridden_layers_lists_the_changed_layers_inside_an_instance() {
      let mut k = kit();
      let inst = instance(&mut k.e, &k.default, None);
      let label = named(&k.e, &inst, "Label");
      let bg = named(&k.e, &inst, "Bg");
      let q = |e: &Engine, id: &str| e.query(crate::engine::Query::OverriddenLayers { id: id.to_string() }).unwrap();
      assert!(q(&k.e, &inst)["layers"].as_array().unwrap().is_empty());
      set_text(&mut k.e, &label, "Hi");
      fill(&mut k.e, &bg, "#FF0000");
      let r = q(&k.e, &inst);
      let layers = r["layers"].as_array().unwrap();
      assert_eq!(layers.len(), 2);
      assert_eq!(layers[0]["id"], json!(bg));
      assert_eq!(layers[0]["name"], "Bg");
      assert_eq!(layers[0]["groups"][0]["key"], "fill");
      assert_eq!(layers[1]["id"], json!(label));
      assert_eq!(layers[1]["groups"][0]["key"], "text");
      assert_eq!(r["more"], false);
    }

    #[test]
    fn a_nested_instance_lists_layers_overridden_through_its_outer_instance() {
      let mut k = kit();
      let (_, card_inst) = card(&mut k);
      let nested = nested_instance(&k.e, &card_inst);
      let label = named(&k.e, &nested, "Label");
      set_text(&mut k.e, &label, "Through the card");
      let q = |e: &Engine, id: &str| e.query(crate::engine::Query::OverriddenLayers { id: id.to_string() }).unwrap();
      // The edit is stored on the card instance, outside the nested instance's own subtree.
      let card_layers = q(&k.e, &card_inst);
      assert!(card_layers["layers"].as_array().unwrap().iter().any(|l| l["id"] == json!(label)));
      let nested_layers = q(&k.e, &nested);
      let layers = nested_layers["layers"].as_array().unwrap();
      assert_eq!(layers.len(), 1, "{nested_layers}");
      assert_eq!(layers[0]["id"], json!(label));
      assert_eq!(layers[0]["groups"][0]["key"], "text");
    }

    #[test]
    fn restoring_a_main_names_it_after_what_its_instances_share() {
      let mut k = kit();
      let a = instance(&mut k.e, &k.default, None);
      let b = instance(&mut k.e, &k.default, None);
      let c = instance(&mut k.e, &k.default, None);
      for (i, n) in [(&a, "Button 50"), (&b, "Button"), (&c, "Button")] {
        k.e
          .dispatch(Command::Update {
            ids: vec![i.clone()],
            patch: json!({ "name": n }),
          })
          .unwrap();
      }
      k.e
        .dispatch(Command::Delete {
          ids: vec![k.default.clone()],
        })
        .unwrap();
      let r = id(k.e.dispatch(Command::RestoreComponent { id: a.clone() }).unwrap());
      assert_eq!(k.e.doc.get(&r).unwrap().name, "Button");
    }

    /// A "Button" set (State=Default / State=Hover, each a frame with "Bg" and "Label").
    struct Kit {
      e: Engine,
      default: String,
      hover: String,
    }

    fn kit() -> Kit {
      let mut e = engine();
      let make = |e: &mut Engine, x: f64, root_fill: &str, bg_fill: &str, size: f64| {
        let f = shape(e, NodeType::Frame, x, None);
        rename(e, &f, "Button");
        fill(e, &f, root_fill);
        let bg = shape(e, NodeType::Rectangle, x, Some(&f));
        rename(e, &bg, "Bg");
        fill(e, &bg, bg_fill);
        let t = id(
          e.dispatch(Command::CreateText {
            x: x + 10.0,
            y: 10.0,
            characters: "Buy".into(),
            parent: Some(f.clone()),
          })
          .unwrap(),
        );
        rename(e, &t, "Label");
        e.dispatch(Command::Update {
          ids: vec![t],
          patch: json!({ "text": { "fontSize": size } }),
        })
        .unwrap();
        id(e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap())
      };
      let default = make(&mut e, 0.0, DEFAULT_FILL, "#222222", 16.0);
      let hover = make(&mut e, 200.0, HOVER_FILL, HOVER_BG, 20.0);
      rename(&mut e, &default, "State=Default");
      rename(&mut e, &hover, "State=Hover");
      e.dispatch(Command::CombineVariants {
        ids: vec![default.clone(), hover.clone()],
      })
      .unwrap();
      Kit { e, default, hover }
    }

    /// A "Card" component (a "Title" text and a Button instance) and an instance of it.
    fn card(k: &mut Kit) -> (String, String) {
      let f = shape(&mut k.e, NodeType::Frame, 1000.0, None);
      k.e
        .dispatch(Command::Update {
          ids: vec![f.clone()],
          patch: json!({ "name": "Card", "y": 300, "width": 300, "height": 200 }),
        })
        .unwrap();
      let t = id(
        k.e
          .dispatch(Command::CreateText {
            x: 1010.0,
            y: 310.0,
            characters: "Welcome".into(),
            parent: Some(f.clone()),
          })
          .unwrap(),
      );
      rename(&mut k.e, &t, "Title");
      let default = k.default.clone();
      instance(&mut k.e, &default, Some(&f));
      let card = id(k.e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
      let inst = id(
        k.e
          .dispatch(Command::CreateInstance {
            component_id: card.clone(),
            x: 600.0,
            y: 300.0,
            parent: None,
            anchor: None,
            into_components: false,
          })
          .unwrap(),
      );
      (card, inst)
    }

    fn engine() -> Engine {
      engine_seeded(7)
    }

    /// Another editor session; each has its own id seed, as in the app.
    fn engine_seeded(seed: u64) -> Engine {
      Engine::new(Box::new(crate::text::HeuristicMeasurer), seed)
    }

    fn id(v: Value) -> String {
      v["id"].as_str().unwrap().to_string()
    }

    fn shape(e: &mut Engine, kind: NodeType, x: f64, parent: Option<&str>) -> String {
      id(
        e.dispatch(Command::CreateShape {
          kind,
          x,
          y: 0.0,
          width: 100.0,
          height: 40.0,
          parent: parent.map(String::from),
        })
        .unwrap(),
      )
    }

    fn instance(e: &mut Engine, comp: &str, parent: Option<&str>) -> String {
      id(
        e.dispatch(Command::CreateInstance {
          component_id: comp.to_string(),
          x: 0.0,
          y: 500.0,
          parent: parent.map(String::from),
          anchor: None,
          into_components: false,
        })
        .unwrap(),
      )
    }

    fn rename(e: &mut Engine, id: &str, name: &str) {
      e.dispatch(Command::Update {
        ids: vec![id.to_string()],
        patch: json!({ "name": name }),
      })
      .unwrap();
    }

    fn fill(e: &mut Engine, id: &str, color: &str) {
      e.dispatch(Command::Update {
        ids: vec![id.to_string()],
        patch: json!({ "fills": [{ "type": "solid", "color": color }] }),
      })
      .unwrap();
    }

    fn set_text(e: &mut Engine, id: &str, s: &str) {
      e.dispatch(Command::SetText {
        id: id.to_string(),
        characters: s.to_string(),
        runs: None,
      })
      .unwrap();
    }

    fn variant(e: &mut Engine, id: &str, value: &str) {
      e.dispatch(Command::SetVariant {
        id: id.to_string(),
        prop: "State".into(),
        value: value.into(),
      })
      .unwrap();
    }

    /// The first layer named `name` under `root`.
    fn named(e: &Engine, root: &str, name: &str) -> String {
      e.doc
        .subtree(root)
        .into_iter()
        .skip(1)
        .find(|i| e.doc.get(i).map(|n| n.name == name).unwrap_or(false))
        .unwrap_or_else(|| panic!("no {name} under {root}"))
    }

    fn nested_instance(e: &Engine, root: &str) -> String {
      e.doc
        .subtree(root)
        .into_iter()
        .skip(1)
        .find(|i| e.doc.get(i).map(|n| n.kind == NodeType::Instance).unwrap_or(false))
        .unwrap()
    }

    fn text(e: &Engine, id: &str) -> String {
      e.doc.get(id).unwrap().text.as_ref().unwrap().characters.clone()
    }

    fn font_size(e: &Engine, id: &str) -> f64 {
      e.doc.get(id).unwrap().text.as_ref().unwrap().font_size
    }

    fn remote_noise(e: &mut Engine, frame: &str) {
      let mut peer = e.doc.clone();
      peer.get_mut(frame).unwrap().name = format!("{} x", peer.get(frame).unwrap().name);
      let d = crate::collab::delta(&e.doc, &peer, true, true);
      e.dispatch(Command::ApplyRemote { delta: d, local: false }).unwrap();
    }

    #[test]
    fn an_update_that_types_a_colour_and_binds_keeps_the_binding_inside_an_instance() {
      let (mut k, _, inst, label) = bound_kit();
      k.e
        .dispatch(Command::Update {
          ids: vec![label.clone()],
          patch: json!({ "fills": [{ "type": "solid", "color": "#00FF00" }], "bindings": { "fill": "v_q" } }),
        })
        .unwrap();
      assert_eq!(bound(&k.e, &label, "fill").as_deref(), Some("v_q"));
      assert_eq!(override_of(&k.e, &inst, &named_master(&k.e, &label))["bindings"]["fill"], "v_q");
      let main_label = named(&k.e, &k.default, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![main_label],
          patch: json!({ "opacity": 0.5 }),
        })
        .unwrap();
      assert_eq!(bound(&k.e, &label, "fill").as_deref(), Some("v_q"));
    }

    #[test]
    fn reset_fill_also_clears_the_detach_of_the_fill() {
      let (mut k, frame, _, label) = bound_kit();
      fill(&mut k.e, &label, "#00FF00");
      let g = k.e.query(crate::engine::Query::OverrideGroups { id: label.clone() }).unwrap();
      let g = g.to_string();
      assert!(g.contains("fill") && g.contains("variables"), "{g}");
      reset(&mut k.e, &label, &["fill"]);
      mode(&mut k.e, &frame, Some("Dark"));
      assert_eq!(bound(&k.e, &label, "fill").as_deref(), Some("v_p"));
      assert_eq!(fill_of(&k.e, &label), "#EEEEEE");
    }

    #[test]
    fn reset_fill_after_applying_a_style_to_a_bound_instance_layer() {
      let (mut k, frame, _, label) = bound_kit();
      k.e
        .dispatch(Command::AddColorStyle {
          name: "Brand".into(),
          color: "#FF00FF".into(),
        })
        .unwrap();
      let sid = k.e.doc.styles.colors[0].id.clone();
      k.e
        .dispatch(Command::ApplyStyle {
          ids: vec![label.clone()],
          style_id: sid,
          kind: None,
        })
        .unwrap();
      assert_eq!(fill_of(&k.e, &label), "#FF00FF");
      reset(&mut k.e, &label, &["fill"]);
      mode(&mut k.e, &frame, Some("Dark"));
      assert_eq!(bound(&k.e, &label, "fill").as_deref(), Some("v_p"));
      assert_eq!(fill_of(&k.e, &label), "#EEEEEE");
    }

    #[test]
    fn a_style_only_update_drops_the_binding() {
      let (mut k, _, _, label) = bound_kit();
      k.e
        .dispatch(Command::AddColorStyle {
          name: "Brand".into(),
          color: "#FF00FF".into(),
        })
        .unwrap();
      let sid = k.e.doc.styles.colors[0].id.clone();
      k.e
        .dispatch(Command::Update {
          ids: vec![label.clone()],
          patch: json!({ "fillStyle": sid }),
        })
        .unwrap();
      assert!(bound(&k.e, &label, "fill").is_none());
    }

    #[test]
    fn undo_and_redo_keep_the_unbound_record_after_remote_changes() {
      let (mut k, frame, inst, label) = bound_kit();
      bind(&mut k.e, &label, "stroke", Some("v_q"));
      fill(&mut k.e, &label, "#00FF00");
      let key = named_master(&k.e, &label);
      remote_noise(&mut k.e, &frame);
      k.e.dispatch(Command::Undo).unwrap();
      assert_eq!(bound(&k.e, &label, "fill").as_deref(), Some("v_p"));
      assert!(override_of(&k.e, &inst, &key)["bindings"].get("fill").is_none());
      assert_eq!(override_of(&k.e, &inst, &key)["bindings"]["stroke"], "v_q");
      remote_noise(&mut k.e, &frame);
      k.e.dispatch(Command::Redo).unwrap();
      assert_eq!(override_of(&k.e, &inst, &key)["bindings"]["fill"], Value::Null);
      assert!(bound(&k.e, &label, "fill").is_none());
      assert_eq!(fill_of(&k.e, &label), "#00FF00");
      let main_label = named(&k.e, &k.default, "Label");
      k.e
        .dispatch(Command::Update {
          ids: vec![main_label],
          patch: json!({ "opacity": 0.5 }),
        })
        .unwrap();
      assert!(bound(&k.e, &label, "fill").is_none());
    }

    fn fill_of(e: &Engine, id: &str) -> String {
      match e.doc.get(id).unwrap().fills.first() {
        Some(Paint::Solid { color, .. }) => color.to_uppercase(),
        other => format!("{other:?}"),
      }
    }
  }

  #[test]
  fn combine_as_variants_keeps_the_written_property_order() {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let names = [
      "Size=S, State=Default, Icon=None",
      "Size=M, State=Hover, Icon=None",
      "Size=L, State=Default, Icon=Left",
      // Another property, in the middle of a name: it goes last.
      "Size=S, Tone=Soft, State=Hover, Icon=None",
    ];
    let mut ids = Vec::new();
    for (i, name) in names.iter().enumerate() {
      let id = format!("c{i}");
      doc.insert(
        Node {
          id: id.clone(),
          kind: NodeType::Component,
          name: name.to_string(),
          x: i as f64 * 120.0,
          component: Some(ComponentInfo::default()),
          ..Default::default()
        },
        None,
        &page,
        None,
      );
      ids.push(id);
    }
    let set = combine_as_variants(&mut doc, &ids, &mut gen).unwrap();
    let written: Vec<String> = ids.iter().map(|i| doc.get(i).unwrap().name.clone()).collect();
    assert_eq!(written[0], "Size=S, State=Default, Icon=None");
    assert_eq!(written[2], "Size=L, State=Default, Icon=Left");
    // Every name lists the keys in one order: the first name's, then new keys as first seen.
    assert_eq!(written[3], "Size=S, State=Hover, Icon=None, Tone=Soft");
    assert_eq!(variant_order(&doc, &set), ["Size", "State", "Icon", "Tone"]);
    let props = &doc.get(&ids[3]).unwrap().component.as_ref().unwrap().variant_props;
    assert_eq!(props["Tone"], "Soft");
  }

  #[test]
  fn variant_order_follows_the_first_child_then_sorts_the_rest() {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut add = |id: &str, name: &str, props: &[(&str, &str)]| {
      doc.insert(
        Node {
          id: id.into(),
          kind: NodeType::Component,
          name: name.into(),
          component: Some(ComponentInfo {
            variant_props: props.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
          }),
          ..Default::default()
        },
        None,
        &page,
        None,
      );
    };
    add("a", "State=Default, Size=S", &[("State", "Default"), ("Size", "S")]);
    add(
      "b",
      "Zeta=1, Alpha=2, State=Hover, Size=M",
      &[("Zeta", "1"), ("Alpha", "2"), ("State", "Hover"), ("Size", "M")],
    );
    let set = crate::ops::wrap_in_frame(&mut doc, &["a".to_string(), "b".to_string()], &mut gen, NodeType::ComponentSet).unwrap();
    // The first child's keys in their written order, then the extra keys sorted.
    assert_eq!(variant_order(&doc, &set), ["State", "Size", "Alpha", "Zeta"]);
    assert_eq!(
      variant_pairs("Size = S ,State= Hover, Size=L").unwrap(),
      [("Size".to_string(), "L".to_string()), ("State".to_string(), "Hover".to_string())]
    );
    assert!(variant_pairs("Button").is_none());
  }
}

#[cfg(test)]
mod wrapper_tests {
  use crate::engine::{Command, Engine};
  use crate::model::*;
  use serde_json::json;

  fn engine() -> Engine {
    Engine::new(Box::new(crate::text::HeuristicMeasurer), 4)
  }

  fn shape(e: &mut Engine, kind: NodeType, x: f64) -> String {
    e.dispatch(Command::CreateShape {
      kind,
      x,
      y: 0.0,
      width: 80.0,
      height: 60.0,
      parent: None,
    })
    .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string()
  }

  fn make(e: &mut Engine, ids: Vec<String>) -> String {
    e.dispatch(Command::CreateComponent { ids }).unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string()
  }

  #[test]
  fn lone_rounded_rectangle_gets_a_transparent_wrapper() {
    let mut e = engine();
    let r = shape(&mut e, NodeType::Rectangle, 0.0);
    e.dispatch(Command::Update {
      ids: vec![r.clone()],
      patch: json!({ "cornerRadius": 12.0 }),
    })
    .unwrap();
    let c = make(&mut e, vec![r.clone()]);
    let comp = e.doc.get(&c).unwrap();
    assert_eq!(comp.kind, NodeType::Component);
    assert!(comp.fills.is_empty(), "no white wrapper fill");
    assert!(!comp.clip_content);
    assert_eq!(comp.children, vec![r.clone()]);
    assert_eq!(e.doc.get(&r).unwrap().corner_radius, 12.0);
    // The change travels as a delta to a peer holding the old document.
    let done = e.doc.clone();
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.get(&c).is_none(), "one undo step removes the component and its wrapper");
    assert!(e.doc.get(&r).unwrap().parent.is_none());
    let d = crate::collab::delta(&e.doc, &done, false, false);
    let mut peer = e.doc.clone();
    crate::collab::apply(&mut peer, &d).unwrap();
    assert!(peer == done);
  }

  #[test]
  fn lone_ellipse_and_several_layers_get_a_transparent_wrapper() {
    let mut e = engine();
    let el = shape(&mut e, NodeType::Ellipse, 0.0);
    let c = make(&mut e, vec![el]);
    assert!(e.doc.get(&c).unwrap().fills.is_empty());
    let a = shape(&mut e, NodeType::Rectangle, 300.0);
    let b = shape(&mut e, NodeType::Rectangle, 500.0);
    let c = make(&mut e, vec![a, b]);
    let comp = e.doc.get(&c).unwrap();
    assert!(comp.fills.is_empty());
    assert_eq!(comp.children.len(), 2);
  }

  #[test]
  fn a_frame_keeps_its_fill_as_the_component() {
    let mut e = engine();
    let f = shape(&mut e, NodeType::Frame, 0.0);
    let had = e.doc.get(&f).unwrap().fills.clone();
    assert!(!had.is_empty());
    let c = make(&mut e, vec![f.clone()]);
    assert_eq!(c, f);
    assert_eq!(e.doc.get(&c).unwrap().fills, had);
  }
}

/// Round 19: deleting variables keeps what instance layers show; overrides of removed main
/// layers go at the next sync.
#[cfg(test)]
mod r19a_tests {
  use crate::engine::{Command, Engine, AFTER_MUTATIONS};
  use crate::model::Paint;
  use serde_json::{json, Value};

  fn engine() -> Engine {
    Engine::new(Box::new(crate::text::HeuristicMeasurer), 19)
  }

  fn run(e: &mut Engine, tool: &str, input: Value) -> Value {
    e.dispatch(Command::Ai { tool: tool.into(), input })
      .unwrap_or_else(|er| panic!("{tool} failed: {er}"))
  }

  fn one(e: &mut Engine, spec: Value) -> String {
    run(e, "create_nodes", json!({ "nodes": [spec] }))["created"][0]["id"]
      .as_str()
      .unwrap()
      .to_string()
  }

  fn fill_of(e: &Engine, id: &str) -> String {
    match e.doc.get(id).unwrap().fills.first() {
      Some(Paint::Solid { color, .. }) => color.clone(),
      other => format!("{other:?}"),
    }
  }

  fn child_named(e: &Engine, root: &str, name: &str) -> String {
    e.doc
      .subtree(root)
      .into_iter()
      .find(|i| i != root && e.doc.get(i).unwrap().name == name)
      .unwrap()
  }

  fn overrides(e: &Engine, inst: &str) -> Value {
    serde_json::to_value(&e.doc.get(inst).unwrap().instance.as_ref().unwrap().overrides).unwrap()
  }

  fn instance_of(e: &mut Engine, comp: &str, x: f64) -> String {
    run(e, "create_instance", json!({ "componentId": comp, "x": x }))["id"]
      .as_str()
      .unwrap()
      .to_string()
  }

  /// (engine, main, instance, instance body); Theme/text is #222222 in Light.
  fn setup(used_in_main: bool) -> (Engine, String, String, String) {
    let mut e = engine();
    run(
      &mut e,
      "define_variables",
      json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [
        { "name": "text", "values": { "Light": "#111111", "Dark": "#EEEEEE" } } ] }),
    );
    let bind = if used_in_main {
      json!({ "fill": "Theme/text" })
    } else {
      json!(null)
    };
    let comp = one(
      &mut e,
      json!({ "type": "component", "name": "Card", "width": 200, "height": 100, "children": [
        { "type": "rectangle", "name": "Title", "width": 50, "height": 10, "fill": "#000000", "bind": bind },
        { "type": "rectangle", "name": "Body", "y": 20, "width": 50, "height": 10, "fill": "#6B7280" } ] }),
    );
    let inst = instance_of(&mut e, &comp, 400.0);
    let body = child_named(&e, &inst, "Body");
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": body, "bind": { "fill": "Theme/text" } }] }),
    );
    run(
      &mut e,
      "define_variables",
      json!({ "collection": "Theme", "variables": [
        { "name": "text", "values": { "Light": "#222222", "Dark": "#EEEEEE" } } ] }),
    );
    (e, comp, inst, body)
  }

  fn delete_text(e: &mut Engine) {
    run(e, "define_variables", json!({ "collection": "Theme", "delete": ["text"] }));
  }

  #[test]
  fn deleting_a_variable_keeps_an_instance_layers_colour() {
    for used_in_main in [true, false] {
      let (mut e, comp, inst, body) = setup(used_in_main);
      assert_eq!(fill_of(&e, &body), "#222222");
      let before = AFTER_MUTATIONS.with(|c| c.get());
      delete_text(&mut e);
      assert_eq!(AFTER_MUTATIONS.with(|c| c.get()) - before, 1, "one pass");
      assert_eq!(fill_of(&e, &body), "#222222", "main uses it: {used_in_main}");
      let ov = overrides(&e, &inst);
      assert!(!ov.to_string().contains("\"bindings\":{}"), "{ov}");
      assert!(!ov.to_string().contains("\"bindings\""), "no dead variable named: {ov}");
      // A later edit of the main re-syncs the instance and still shows it.
      run(&mut e, "update_nodes", json!({ "updates": [{ "id": comp, "cornerRadius": 4 }] }));
      assert_eq!(fill_of(&e, &body), "#222222");
      // Undo and redo are exact.
      e.dispatch(Command::Undo).unwrap();
      e.dispatch(Command::Undo).unwrap();
      assert_eq!(e.doc.get(&body).unwrap().bindings.len(), 1);
      e.dispatch(Command::Redo).unwrap();
      e.dispatch(Command::Redo).unwrap();
      assert_eq!(fill_of(&e, &body), "#222222");
      assert!(e.doc.get(&body).unwrap().bindings.is_empty());
    }
  }

  #[test]
  fn a_main_bound_layer_in_a_dark_instance_keeps_its_dark_value() {
    let (mut e, comp, inst, _) = setup(true);
    let title = child_named(&e, &inst, "Title");
    let coll = e.doc.variables[0].id.clone();
    let dark = e.doc.variables[0].modes[1].id.clone();
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": inst, "variableModes": { coll: dark } }] }),
    );
    assert_eq!(fill_of(&e, &title), "#EEEEEE");
    delete_text(&mut e);
    assert_eq!(fill_of(&e, &title), "#EEEEEE");
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": comp, "cornerRadius": 4 }] }));
    assert_eq!(fill_of(&e, &title), "#EEEEEE");
    assert_eq!(fill_of(&e, &child_named(&e, &comp, "Title")), "#222222", "the main keeps its own");
  }

  #[test]
  fn a_nested_instance_layer_keeps_its_colour() {
    let (mut e, _comp, _inst, _) = setup(true);
    let inner = one(
      &mut e,
      json!({ "type": "component", "name": "Inner", "x": 900, "width": 80, "height": 40, "children": [
        { "type": "rectangle", "name": "Dot", "width": 10, "height": 10, "fill": "#FF0000" } ] }),
    );
    let outer = one(
      &mut e,
      json!({ "type": "component", "name": "Outer", "x": 900, "y": 200, "width": 200, "height": 100 }),
    );
    let nested = run(&mut e, "create_instance", json!({ "componentId": inner, "parentId": outer }))["id"]
      .as_str()
      .unwrap()
      .to_string();
    let dot_in_nested = child_named(&e, &nested, "Dot");
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": dot_in_nested, "bind": { "fill": "Theme/text" } }] }),
    );
    let top = instance_of(&mut e, &outer, 1200.0);
    let dot = child_named(&e, &top, "Dot");
    assert_eq!(fill_of(&e, &dot), "#222222");
    delete_text(&mut e);
    assert_eq!(fill_of(&e, &dot), "#222222");
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": outer, "cornerRadius": 4 }] }));
    assert_eq!(fill_of(&e, &dot), "#222222");
    assert!(!overrides(&e, &top).to_string().contains("\"bindings\":{}"));
  }

  #[test]
  fn overrides_of_a_removed_main_layer_go_and_return_with_undo() {
    let mut e = engine();
    let comp = one(
      &mut e,
      json!({ "type": "component", "name": "Card", "width": 200, "height": 100, "children": [
        { "type": "text", "name": "Label", "text": "Hi" },
        { "type": "rectangle", "name": "Keep", "y": 40, "width": 20, "height": 20 } ] }),
    );
    let inst = instance_of(&mut e, &comp, 400.0);
    let lab = child_named(&e, &inst, "Label");
    let keep = child_named(&e, &inst, "Keep");
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": lab, "text": "Yo" }, { "id": keep, "fill": "#123456" }] }),
    );
    assert_eq!(overrides(&e, &inst).as_object().unwrap().len(), 2);
    let main_label = child_named(&e, &comp, "Label");
    run(&mut e, "delete_nodes", json!({ "ids": [main_label] }));
    let ov = overrides(&e, &inst);
    assert_eq!(ov.as_object().unwrap().len(), 1, "{ov}");
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(overrides(&e, &inst).as_object().unwrap().len(), 2);
  }

  #[test]
  fn a_deleted_main_keeps_every_override() {
    let mut e = engine();
    let comp = one(
      &mut e,
      json!({ "type": "component", "name": "Card", "width": 200, "height": 100, "children": [
        { "type": "text", "name": "Label", "text": "Hi" } ] }),
    );
    let inst = instance_of(&mut e, &comp, 400.0);
    let lab = child_named(&e, &inst, "Label");
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": lab, "text": "Yo" }] }));
    let before = overrides(&e, &inst);
    run(&mut e, "delete_nodes", json!({ "ids": [comp] }));
    assert_eq!(overrides(&e, &inst), before);
  }

  fn two_vars(e: &mut Engine) {
    run(
      e,
      "define_variables",
      json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [
        { "name": "text", "values": { "Light": "#222222", "Dark": "#EEEEEE" } },
        { "name": "muted", "values": { "Light": "#6B7280", "Dark": "#999999" } } ] }),
    );
  }

  /// The main binds Body's fill to Theme/muted (kept), the instance rebinds it to Theme/text,
  /// and Theme/text is deleted: the instance keeps showing text's colour after main edits.
  #[test]
  fn probe_override_binding_over_a_kept_main_binding() {
    let mut e = engine();
    two_vars(&mut e);
    let comp = one(
      &mut e,
      json!({ "type": "component", "name": "Card", "width": 200, "height": 100, "children": [
        { "type": "rectangle", "name": "Body", "width": 50, "height": 10, "fill": "#000000", "bind": { "fill": "Theme/muted" } } ] }),
    );
    let inst = instance_of(&mut e, &comp, 400.0);
    let body = child_named(&e, &inst, "Body");
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": body, "bind": { "fill": "Theme/text" } }] }),
    );
    assert_eq!(fill_of(&e, &body), "#222222");
    delete_text(&mut e);
    assert_eq!(fill_of(&e, &body), "#222222");
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": comp, "cornerRadius": 4 }] }));
    assert_eq!(fill_of(&e, &body), "#222222", "the value it showed stays");
    // Still bound to muted? No: the override says unbound here.
    assert!(e.doc.get(&body).unwrap().bindings.is_empty());
  }

  /// (engine, swapped-to component, outer main, top instance, nested instance swapped through it)
  fn swapped_setup() -> (Engine, String, String, String, String) {
    let mut e = engine();
    two_vars(&mut e);
    let inner = one(
      &mut e,
      json!({ "type": "component", "name": "Inner", "x": 900, "width": 80, "height": 40, "children": [
        { "type": "rectangle", "name": "Dot", "width": 10, "height": 10, "fill": "#FF0000" } ] }),
    );
    let inner2 = one(
      &mut e,
      json!({ "type": "component", "name": "Inner2", "x": 1100, "width": 80, "height": 40, "children": [
        { "type": "rectangle", "name": "Dot", "width": 10, "height": 10, "fill": "#00FF00" },
        { "type": "text", "name": "Label", "y": 20, "text": "Hi" } ] }),
    );
    let outer = one(
      &mut e,
      json!({ "type": "component", "name": "Outer", "x": 900, "y": 200, "width": 200, "height": 100 }),
    );
    run(&mut e, "create_instance", json!({ "componentId": inner, "parentId": outer }));
    let top = instance_of(&mut e, &outer, 1400.0);
    let nested = e.doc.get(&top).unwrap().children[0].clone();
    e.dispatch(Command::SwapComponent {
      id: nested,
      component_id: inner2.clone(),
    })
    .unwrap();
    let nested = e.doc.get(&top).unwrap().children[0].clone();
    (e, inner2, outer, top, nested)
  }

  #[test]
  fn probe_swapped_nested_keeps_colour() {
    let (mut e, inner2, outer, top, nested) = swapped_setup();
    let dot = child_named(&e, &nested, "Dot");
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": dot, "bind": { "fill": "Theme/text" } }] }),
    );
    assert_eq!(fill_of(&e, &dot), "#222222");
    delete_text(&mut e);
    let dot = child_named(&e, &nested, "Dot");
    assert_eq!(fill_of(&e, &dot), "#222222");
    assert!(!overrides(&e, &top).to_string().contains("\"bindings\""), "{}", overrides(&e, &top));
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": inner2, "cornerRadius": 4 }] }));
    let dot = child_named(&e, &nested, "Dot");
    assert_eq!(fill_of(&e, &dot), "#222222");
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": outer, "cornerRadius": 4 }] }));
    let nested = e.doc.get(&top).unwrap().children[0].clone();
    let dot = child_named(&e, &nested, "Dot");
    assert_eq!(fill_of(&e, &dot), "#222222");
  }

  #[test]
  fn probe_swapped_nested_dangling() {
    let (mut e, inner2, _outer, top, nested) = swapped_setup();
    let lab = child_named(&e, &nested, "Label");
    let dot = child_named(&e, &nested, "Dot");
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": lab, "text": "Yo" }, { "id": dot, "fill": "#123456" }] }),
    );
    let main_label = child_named(&e, &inner2, "Label");
    run(&mut e, "delete_nodes", json!({ "ids": [main_label] }));
    let nested = e.doc.get(&top).unwrap().children[0].clone();
    let (t, n) = (overrides(&e, &top).to_string(), overrides(&e, &nested).to_string());
    assert!(!t.contains(&main_label), "top swap record keeps the dangling key: {t}");
    assert!(t.contains("#123456"), "the live override stays: {t}");
    assert!(!n.contains(&main_label), "nested mirror keeps the dangling key: {n}");
    e.dispatch(Command::Undo).unwrap();
    assert!(overrides(&e, &top).to_string().contains(&main_label));
  }

  /// An instance layer had its own fill (red), then was bound to a variable whose colour equals
  /// the main's literal fill. After the delete it keeps showing that colour after main edits.
  #[test]
  fn a_stale_own_fill_under_a_binding_equal_to_the_main_does_not_come_back() {
    let mut e = engine();
    two_vars(&mut e);
    let comp = one(
      &mut e,
      json!({ "type": "component", "name": "Card", "width": 200, "height": 100, "children": [
        { "type": "rectangle", "name": "Body", "width": 50, "height": 10, "fill": "#222222" } ] }),
    );
    let inst = instance_of(&mut e, &comp, 400.0);
    let body = child_named(&e, &inst, "Body");
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": body, "fill": "#FF0000" }] }));
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": body, "bind": { "fill": "Theme/text" } }] }),
    );
    assert_eq!(fill_of(&e, &body), "#222222");
    delete_text(&mut e);
    assert_eq!(fill_of(&e, &body), "#222222");
    assert!(!overrides(&e, &inst).to_string().contains("FF0000"), "{}", overrides(&e, &inst));
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": comp, "cornerRadius": 4 }] }));
    assert_eq!(fill_of(&e, &body), "#222222", "the value it showed stays");
  }
}
