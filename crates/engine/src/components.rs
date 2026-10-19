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
  "constraints",
  "absolutePosition",
  "sizingH",
  "sizingV",
];

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
  let single = if ids.len() == 1 { doc.get(&ids[0]).cloned() } else { None };
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
      doc.get_mut(&id)?.name = name;
      id
    }
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
  let id = gen.next("n_");
  let inst = Node {
    id: id.clone(),
    kind: NodeType::Instance,
    name: comp.name.clone(),
    x,
    y,
    width: comp.width,
    height: comp.height,
    instance: Some(InstanceInfo {
      component_id: comp_id.to_string(),
      overrides: BTreeMap::new(),
    }),
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
    let target = if mid == ROOT_KEY {
      Some(inst_id.to_string())
    } else {
      map.get(mid).cloned()
    };
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
  let outer = doc
    .ancestors(node_id)
    .into_iter()
    .rev()
    .find(|a| doc.get(a).map(|x| x.kind == NodeType::Instance).unwrap_or(false));
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
  let Some(new_name) = doc.get(comp_id).filter(|c| c.kind == NodeType::Component).map(|c| c.name.clone()) else {
    return;
  };
  let old_name = doc
    .get(inst_id)
    .and_then(|i| i.instance.as_ref())
    .and_then(|info| doc.get(&info.component_id))
    .map(|c| c.name.clone());
  if let Some(inst) = doc.get_mut(inst_id) {
    // An instance still named after its component follows the swap; a name of its own stays.
    if inst.name.is_empty() || Some(&inst.name) == old_name.as_ref() {
      inst.name = new_name;
    }
    if let Some(info) = inst.instance.as_mut() {
      info.component_id = comp_id.to_string();
      info.overrides.retain(|k, _| k == ROOT_KEY);
    }
  }
  sync_instance(doc, inst_id, gen);
}

/// Groups components into a component set and derives variant properties from names.
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
  let (set_name, props) = variants_from_names(&names);
  let set_id = crate::ops::wrap_in_frame(doc, &comps, gen, NodeType::ComponentSet)?;
  let pad = 20.0;
  for (cid, props) in comps.iter().zip(props) {
    if let Some(c) = doc.get_mut(cid) {
      c.x += pad;
      c.y += pad;
      c.name = props.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", ");
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
  Some(set_id)
}

/// The set name and each component's variant properties, derived from component names:
/// "Button/Primary" and "Button/Secondary" make set "Button" with Property 1 = Primary or
/// Secondary; "Size=Large" names are used as they are; anything else falls back to the
/// distinct names (or "Variant 1", "Variant 2" …) under "Property 1".
fn variants_from_names(names: &[String]) -> (String, Vec<BTreeMap<String, String>>) {
  const DEFAULT_SET: &str = "Component Set";
  if let Some(parsed) = names.iter().map(|n| parse_variant_name(n)).collect::<Option<Vec<_>>>() {
    return (DEFAULT_SET.into(), parsed);
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
  let props: Vec<BTreeMap<String, String>> = parts
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
        BTreeMap::from([("Property 1".to_string(), rest.join(" "))])
      }
    })
    .collect();
  let distinct = props
    .iter()
    .enumerate()
    .all(|(i, p)| !p.is_empty() && p.values().all(|v| !v.is_empty()) && !props[..i].contains(p));
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
      .map(|i| BTreeMap::from([("Property 1".to_string(), format!("Variant {i}"))]))
      .collect()
  };
  (set_name, props)
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
    let home = shape(&mut e, NodeType::Frame, 0.0);
    e.dispatch(Command::Update {
      ids: vec![home.clone()],
      patch: json!({ "name": "Home", "x": 0.0, "y": 300.0, "width": 400.0, "height": 400.0 }),
    })
    .unwrap();
    let inst = id(
      e.dispatch(Command::CreateInstance {
        component_id: ca,
        x: 10.0,
        y: 10.0,
        parent: Some(home.clone()),
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
  fn an_instance_named_after_its_variant_follows_a_variant_change() {
    use crate::engine::Command;
    let (mut e, _, inst, _) = button_set();
    assert_eq!(e.doc.get(&inst).unwrap().name, "State=Default");
    e.dispatch(Command::SetVariant {
      id: inst.clone(),
      prop: "State".into(),
      value: "Pressed".into(),
    })
    .unwrap();
    assert_eq!(e.doc.get(&inst).unwrap().name, "State=Pressed");
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
}
