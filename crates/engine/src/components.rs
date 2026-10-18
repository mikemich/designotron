//! Components, instances, overrides and variants.
//!
//! Instances own real child nodes (copies of the main component) so rendering,
//! hit-testing and code generation treat them like frames. Each copied node
//! remembers its `master_id`; edits made inside an instance are recorded as
//! overrides on the outermost instance and re-applied whenever it re-syncs.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};

use serde_json::Value;

use crate::doc::IdGen;
use crate::model::{ComponentInfo, Document, InstanceInfo, Node, NodeId, NodeType};
use crate::patch;

pub const ROOT_KEY: &str = "__root";

/// Root keys that position an instance rather than override it.
const ROOT_LOCAL_KEYS: &[&str] = &["x", "y", "rotation", "name", "visible", "locked", "flipX", "flipY", "interactions", "constraints", "absolutePosition", "sizingH", "sizingV"];

/// Fingerprint of a component subtree; changes whenever the component is edited.
pub fn fingerprint(doc: &Document, comp_id: &str) -> u64 {
  let mut h = DefaultHasher::new();
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

/// Turns the given nodes into a main component. Returns the component id.
pub fn create_component(doc: &mut Document, ids: &[NodeId], gen: &mut IdGen) -> Option<NodeId> {
  let target = if ids.len() == 1 {
    let n = doc.get(&ids[0])?;
    if matches!(n.kind, NodeType::Frame | NodeType::Group) {
      ids[0].clone()
    } else {
      crate::ops::wrap_in_frame(doc, ids, gen, NodeType::Frame)?
    }
  } else {
    crate::ops::wrap_in_frame(doc, ids, gen, NodeType::Frame)?
  };
  for nid in doc.subtree(&target) {
    if let Some(n) = doc.get_mut(&nid) {
      n.master_id = None;
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
pub fn create_instance(doc: &mut Document, comp_id: &str, parent: Option<&str>, page: &str, x: f64, y: f64, gen: &mut IdGen) -> Option<NodeId> {
  let comp = doc.get(comp_id)?.clone();
  if comp.kind != NodeType::Component {
    return None;
  }
  let id = gen.next("n_");
  let inst = Node {
    id: id.clone(),
    kind: NodeType::Instance,
    name: comp.name.clone(),
    x,
    y,
    width: comp.width,
    height: comp.height,
    instance: Some(InstanceInfo { component_id: comp_id.to_string(), overrides: BTreeMap::new() }),
    ..Default::default()
  };
  doc.insert(inst, parent, page, None);
  sync_instance(doc, &id, gen);
  Some(id)
}

/// Rebuilds an instance's children from its main component and re-applies overrides.
pub fn sync_instance(doc: &mut Document, inst_id: &str, gen: &mut IdGen) {
  let Some(inst) = doc.get(inst_id).cloned() else { return };
  let Some(info) = inst.instance.clone() else { return };
  let Some(comp) = doc.get(&info.component_id).cloned() else { return };

  // Reuse ids of existing copies so selection survives a re-sync.
  let mut existing: HashMap<NodeId, NodeId> = HashMap::new();
  for nid in doc.subtree(inst_id).into_iter().skip(1) {
    if let Some(m) = doc.get(&nid).and_then(|n| n.master_id.clone()) {
      existing.insert(m, nid);
    }
  }
  for c in &inst.children {
    for nid in doc.subtree(c) {
      doc.nodes.remove(&nid);
    }
  }

  let comp_nodes = doc.subtree(&info.component_id);
  let mut map: HashMap<NodeId, NodeId> = HashMap::new();
  for cid in comp_nodes.iter().skip(1) {
    let new_id = existing.get(cid).cloned().unwrap_or_else(|| gen.next("n_"));
    map.insert(cid.clone(), new_id);
  }
  map.insert(info.component_id.clone(), inst_id.to_string());

  for cid in comp_nodes.iter().skip(1) {
    let Some(src) = doc.get(cid).cloned() else { continue };
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
    doc.nodes.insert(n.id.clone(), n);
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
  root.instance = Some(info.clone());
  root.children = comp.children.iter().filter_map(|c| map.get(c).cloned()).collect();
  doc.nodes.insert(root.id.clone(), root);

  for (mid, p) in &info.overrides {
    let target = if mid == ROOT_KEY { Some(inst_id.to_string()) } else { map.get(mid).cloned() };
    if let Some(t) = target {
      if let Some(n) = doc.get_mut(&t) {
        let _ = patch::apply(n, p);
      }
    }
  }
}

/// Records a property edit made on a node that lives in an instance.
pub fn record_override(doc: &mut Document, node_id: &str, p: &Value) {
  let Some(n) = doc.get(node_id) else { return };
  let outer = doc.ancestors(node_id).into_iter().rev().find(|a| doc.get(a).map(|x| x.kind == NodeType::Instance).unwrap_or(false));
  let (inst_id, key, clean) = if n.kind == NodeType::Instance && outer.is_none() {
    let mut clean = patch::sanitize(p);
    if let Value::Object(m) = &mut clean {
      for k in ROOT_LOCAL_KEYS {
        m.remove(*k);
      }
    }
    (node_id.to_string(), ROOT_KEY.to_string(), clean)
  } else if let (Some(inst), Some(mid)) = (outer, n.master_id.clone()) {
    (inst, mid, patch::sanitize(p))
  } else {
    return;
  };
  if clean.as_object().map(|m| m.is_empty()).unwrap_or(true) {
    return;
  }
  if let Some(info) = doc.get_mut(&inst_id).and_then(|i| i.instance.as_mut()) {
    let entry = info.overrides.entry(key).or_insert_with(|| Value::Object(Default::default()));
    patch::merge(entry, &clean);
  }
}

pub fn detach_instance(doc: &mut Document, inst_id: &str) {
  for nid in doc.subtree(inst_id) {
    if let Some(n) = doc.get_mut(&nid) {
      n.master_id = None;
      if nid == inst_id {
        n.kind = NodeType::Frame;
        n.instance = None;
      }
    }
  }
}

pub fn reset_overrides(doc: &mut Document, inst_id: &str, gen: &mut IdGen) {
  if let Some(info) = doc.get_mut(inst_id).and_then(|i| i.instance.as_mut()) {
    info.overrides.clear();
  }
  sync_instance(doc, inst_id, gen);
}

/// Points an instance at another component (variant swap), dropping child overrides.
pub fn swap_component(doc: &mut Document, inst_id: &str, comp_id: &str, gen: &mut IdGen) {
  if doc.get(comp_id).map(|c| c.kind != NodeType::Component).unwrap_or(true) {
    return;
  }
  if let Some(info) = doc.get_mut(inst_id).and_then(|i| i.instance.as_mut()) {
    info.component_id = comp_id.to_string();
    info.overrides.retain(|k, _| k == ROOT_KEY);
  }
  sync_instance(doc, inst_id, gen);
}

/// Groups components into a component set and derives variant properties from names.
pub fn combine_as_variants(doc: &mut Document, ids: &[NodeId], gen: &mut IdGen) -> Option<NodeId> {
  let comps: Vec<NodeId> = ids.iter().filter(|i| doc.get(i).map(|n| n.kind == NodeType::Component).unwrap_or(false)).cloned().collect();
  if comps.len() < 2 {
    return None;
  }
  let set_id = crate::ops::wrap_in_frame(doc, &comps, gen, NodeType::ComponentSet)?;
  let pad = 20.0;
  for (i, cid) in comps.iter().enumerate() {
    if let Some(c) = doc.get_mut(cid) {
      c.x += pad;
      c.y += pad;
      let props = parse_variant_name(&c.name).unwrap_or_else(|| {
        let mut m = BTreeMap::new();
        m.insert("Property 1".to_string(), format!("Variant {}", i + 1));
        m
      });
      c.name = props.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", ");
      c.component.get_or_insert_with(Default::default).variant_props = props;
    }
  }
  let base = comps.first().and_then(|c| doc.get(c)).map(|c| c.name.split(',').next().unwrap_or("").to_string()).unwrap_or_default();
  if let Some(set) = doc.get_mut(&set_id) {
    set.x -= pad;
    set.y -= pad;
    set.width += pad * 2.0;
    set.height += pad * 2.0;
    set.name = if base.contains('=') { "Component Set".into() } else { base };
    set.strokes = vec![crate::model::Paint::solid("#9747FF")];
    set.stroke_dash = vec![6.0, 4.0];
    set.corner_radius = 6.0;
  }
  Some(set_id)
}

pub fn parse_variant_name(name: &str) -> Option<BTreeMap<String, String>> {
  if !name.contains('=') {
    return None;
  }
  let mut m = BTreeMap::new();
  for part in name.split(',') {
    let (k, v) = part.split_once('=')?;
    m.insert(k.trim().to_string(), v.trim().to_string());
  }
  Some(m)
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
    .find(|c| doc.get(c).and_then(|n| n.component.as_ref()).map(|ci| ci.variant_props == want).unwrap_or(false))
    .cloned()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::new_document;
  use serde_json::json;

  #[test]
  fn instance_follows_component_and_keeps_overrides() {
    let mut gen = IdGen::new(3);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    doc.insert(Node { id: "c".into(), kind: NodeType::Frame, width: 100.0, height: 40.0, ..Default::default() }, None, &page, None);
    let label = Node { id: "t".into(), kind: NodeType::Text, text: Some(crate::model::TextProps { characters: "Button".into(), ..Default::default() }), ..Default::default() };
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
}
