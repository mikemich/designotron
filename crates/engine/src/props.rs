//! Component properties: a main component (or component set) defines named properties, layers
//! of the main bind to them, and every instance gives them values.
//!
//! - Boolean: controls a layer's visibility.
//! - Text: controls a text layer's characters.
//! - Instance swap: controls which component a nested instance is.
//!
//! Boolean and text values live on the instance (`InstanceInfo::prop_values`) and are applied
//! last when it is built, so they win over overrides on the layers they control; editing such
//! a layer inside an instance changes the property instead. A property without a value keeps
//! what the main component shows. An instance nested in a main component keeps its values in
//! its own info; one nested inside another instance keeps them in the outer instance's
//! override for it (`propValues`), so they survive re-syncs, swaps, undo and multiplayer like
//! any other override. An instance swap property has no value of its own: the swap record that
//! `components::swap_component` keeps is the value, which also gives it the recursion guard.
//! Nested instances can show their properties on the outer instance (`expose_props`).

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::components::{self, would_nest};
use crate::doc::IdGen;
use crate::model::{ComponentInfo, Document, InstanceInfo, Node, NodeId, NodeType, PropDef, PropKind, PropRefs};

/// Key, inside an override, of the property values set on a nested instance.
pub const PROPS_KEY: &str = "propValues";

/// An edit of component properties (one undo step each).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PropsOp {
  /// Defines a property on a component or component set. With `bind` it is created from that
  /// layer: bound to it, and (without `default`) starting from the layer's current state.
  Add {
    component: NodeId,
    name: String,
    kind: PropKind,
    #[serde(default)]
    default: Option<Value>,
    #[serde(default)]
    bind: Option<NodeId>,
  },
  /// Renames a property, changes its default (which updates the layers bound to it in the
  /// main components) or the components an instance swap property offers.
  Update {
    component: NodeId,
    prop: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    default: Option<Value>,
    #[serde(default)]
    options: Option<Vec<NodeId>>,
  },
  /// Removes a property; layers bound to it are unbound, instances forget its values.
  Delete { component: NodeId, prop: String },
  /// Binds a layer of a main component to a property (`prop` null unbinds).
  Bind {
    node: NodeId,
    field: PropField,
    #[serde(default)]
    prop: Option<String>,
  },
  /// Sets an instance's value for a property (`value` null goes back to the main component's).
  /// For an instance swap property the value is a component id.
  Set {
    instance: NodeId,
    prop: String,
    #[serde(default)]
    value: Option<Value>,
  },
  /// Shows (or stops showing) a nested instance's properties on instances of the outer component.
  Expose { instance: NodeId, expose: bool },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PropField {
  Visible,
  Characters,
  Swap,
}

impl PropField {
  fn kind(self) -> PropKind {
    match self {
      PropField::Visible => PropKind::Boolean,
      PropField::Characters => PropKind::Text,
      PropField::Swap => PropKind::InstanceSwap,
    }
  }

  fn of(kind: PropKind) -> PropField {
    match kind {
      PropKind::Boolean => PropField::Visible,
      PropKind::Text => PropField::Characters,
      PropKind::InstanceSwap => PropField::Swap,
    }
  }

  fn get(self, refs: &PropRefs) -> Option<&String> {
    match self {
      PropField::Visible => refs.visible.as_ref(),
      PropField::Characters => refs.characters.as_ref(),
      PropField::Swap => refs.swap.as_ref(),
    }
  }

  fn slot(self, refs: &mut PropRefs) -> &mut Option<String> {
    match self {
      PropField::Visible => &mut refs.visible,
      PropField::Characters => &mut refs.characters,
      PropField::Swap => &mut refs.swap,
    }
  }

  fn label(self) -> &'static str {
    match self {
      PropField::Visible => "visible",
      PropField::Characters => "characters",
      PropField::Swap => "swap",
    }
  }
}

/// Runs a property edit. Returns what it created (`{ "id": … }` for Add).
pub fn apply_op(doc: &mut Document, gen: &mut IdGen, op: PropsOp) -> Result<Value, String> {
  match op {
    PropsOp::Add {
      component,
      name,
      kind,
      default,
      bind,
    } => add(doc, gen, &component, &name, kind, default, bind),
    PropsOp::Update {
      component,
      prop,
      name,
      default,
      options,
    } => update(doc, gen, &component, &prop, name, default, options),
    PropsOp::Delete { component, prop } => delete(doc, &component, &prop),
    PropsOp::Bind { node, field, prop } => bind(doc, &node, field, prop.as_deref()).map(|_| json!({})),
    PropsOp::Set { instance, prop, value } => set(doc, gen, &instance, &prop, value),
    PropsOp::Expose { instance, expose } => expose_props(doc, &instance, expose),
  }
}

// ---------- Lookups ----------

/// The node that holds the properties of a component or component set: the set for a variant.
pub fn owner(doc: &Document, id: &str) -> Option<NodeId> {
  let n = doc.get(id)?;
  match n.kind {
    NodeType::ComponentSet => Some(id.to_string()),
    NodeType::Component => match n.parent.as_ref().and_then(|p| doc.get(p)) {
      Some(set) if set.kind == NodeType::ComponentSet => Some(set.id.clone()),
      _ => Some(id.to_string()),
    },
    _ => None,
  }
}

/// The properties of a component or component set (a variant has its set's).
pub fn props_of(doc: &Document, id: &str) -> Vec<PropDef> {
  owner(doc, id)
    .and_then(|o| doc.get(&o))
    .and_then(|n| n.component.as_ref())
    .map(|c| c.props.clone())
    .unwrap_or_default()
}

fn def_of(doc: &Document, comp: &str, prop: &str) -> Option<PropDef> {
  props_of(doc, comp).into_iter().find(|p| p.id == prop)
}

/// The main components that share `owner`'s properties.
fn comps_of(doc: &Document, owner: &str) -> Vec<NodeId> {
  match doc.get(owner) {
    Some(n) if n.kind == NodeType::ComponentSet => n
      .children
      .iter()
      .filter(|c| doc.get(c).map(|c| c.kind == NodeType::Component).unwrap_or(false))
      .cloned()
      .collect(),
    Some(_) => vec![owner.to_string()],
    None => vec![],
  }
}

/// Layers of the main components that share `owner`'s properties bound to `prop`.
fn bound_in_mains(doc: &Document, owner: &str, field: Option<PropField>, prop: &str) -> Vec<NodeId> {
  comps_of(doc, owner)
    .iter()
    .flat_map(|c| bound_in_comp(doc, c, field, prop))
    .collect()
}

/// Layers of one main component bound to `prop` (never layers inside instances).
fn bound_in_comp(doc: &Document, comp: &str, field: Option<PropField>, prop: &str) -> Vec<NodeId> {
  let mut out = Vec::new();
  let mut stack = vec![comp.to_string()];
  while let Some(id) = stack.pop() {
    let Some(n) = doc.get(&id) else { continue };
    if let Some(r) = &n.prop_refs {
      let hit = match field {
        Some(f) => f.get(r).map(|p| p == prop).unwrap_or(false),
        None => [r.visible.as_ref(), r.characters.as_ref(), r.swap.as_ref()]
          .iter()
          .any(|p| p.map(|p| p == prop).unwrap_or(false)),
      };
      if hit {
        out.push(id.clone());
      }
    }
    if n.kind != NodeType::Instance {
      stack.extend(n.children.iter().rev().cloned());
    }
  }
  out
}

/// What instance `a`'s layers show for a property when it sets no value: what the layers they
/// copy show (inside a nested instance that is the outer component's copy, not the inner one's
/// own main component).
fn baseline(doc: &Document, a: &str, def: &PropDef) -> Value {
  let field = PropField::of(def.kind);
  let from_masters = bound_in_instance(doc, a, field, &def.id).iter().find_map(|l| {
    let master = doc.get(l)?.master_id.as_ref()?;
    layer_value(doc.get(master)?, field)
  });
  from_masters.unwrap_or_else(|| own_main_value(doc, a, def))
}

/// What the instance's own component shows for a property.
fn own_main_value(doc: &Document, a: &str, def: &PropDef) -> Value {
  let comp = doc
    .get(a)
    .and_then(|n| n.instance.as_ref())
    .map(|i| i.component_id.clone())
    .unwrap_or_default();
  let field = PropField::of(def.kind);
  bound_in_comp(doc, &comp, Some(field), &def.id)
    .iter()
    .find_map(|l| doc.get(l).and_then(|n| layer_value(n, field)))
    .unwrap_or_else(|| def.default.clone())
}

/// Layers inside instance `a` that its own properties control: those whose nearest instance is `a`.
fn bound_in_instance(doc: &Document, a: &str, field: PropField, prop: &str) -> Vec<NodeId> {
  let mut out = Vec::new();
  let mut stack: Vec<NodeId> = doc.get(a).map(|n| n.children.iter().rev().cloned().collect()).unwrap_or_default();
  while let Some(id) = stack.pop() {
    let Some(n) = doc.get(&id) else { continue };
    if n.prop_refs.as_ref().and_then(|r| field.get(r)).map(|p| p == prop).unwrap_or(false) {
      out.push(id.clone());
    }
    if n.kind != NodeType::Instance {
      stack.extend(n.children.iter().rev().cloned());
    }
  }
  out
}

/// The outermost instance around `id` (or `id` itself when no instance is above it).
fn outermost(doc: &Document, id: &str) -> NodeId {
  doc
    .ancestors(id)
    .into_iter()
    .rev()
    .find(|a| doc.get(a).map(|n| n.kind == NodeType::Instance).unwrap_or(false))
    .unwrap_or_else(|| id.to_string())
}

/// What a property's layers show in the main components: the first bound layer's state.
fn main_value(doc: &Document, owner: &str, def: &PropDef) -> Value {
  let field = PropField::of(def.kind);
  for id in bound_in_mains(doc, owner, Some(field), &def.id) {
    if let Some(v) = doc.get(&id).and_then(|n| layer_value(n, field)) {
      return v;
    }
  }
  def.default.clone()
}

fn layer_value(n: &Node, field: PropField) -> Option<Value> {
  match field {
    PropField::Visible => Some(json!(n.visible)),
    PropField::Characters => n.text.as_ref().map(|t| json!(t.characters)),
    PropField::Swap => n.instance.as_ref().map(|i| json!(i.component_id)),
  }
}

// ---------- Defining properties ----------

fn add(
  doc: &mut Document,
  gen: &mut IdGen,
  component: &str,
  name: &str,
  kind: PropKind,
  default: Option<Value>,
  bind_to: Option<NodeId>,
) -> Result<Value, String> {
  let owner = owner(doc, component).ok_or("select a main component or a component set")?;
  let name = name.trim().to_string();
  check_name(doc, &owner, "", &name)?;
  let layer_default = match &bind_to {
    Some(node) => {
      check_bindable(doc, node, &owner, PropField::of(kind))?;
      doc.get(node).and_then(|n| layer_value(n, PropField::of(kind)))
    }
    None => None,
  };
  let first = match (&layer_default, &default) {
    (Some(v), _) => v.clone(),
    (None, Some(v)) => v.clone(),
    (None, None) => match kind {
      PropKind::Boolean => json!(true),
      PropKind::Text => json!(""),
      PropKind::InstanceSwap => return Err("an instance swap property needs a default component".into()),
    },
  };
  let value = coerce(doc, kind, &first)?;
  let id = gen.next("pr_");
  let n = doc.get_mut(&owner).ok_or("no such component")?;
  n.component.get_or_insert_with(ComponentInfo::default).props.push(PropDef {
    id: id.clone(),
    name,
    kind,
    default: value,
    options: Vec::new(),
  });
  if let Some(node) = bind_to {
    bind(doc, &node, PropField::of(kind), Some(&id))?;
    // An explicit default also sets the layer the property was made from.
    if let (Some(v), Some(_)) = (default, layer_default) {
      apply_default(doc, gen, &owner, &id, &v)?;
    }
  }
  Ok(json!({ "id": id }))
}

fn update(
  doc: &mut Document,
  gen: &mut IdGen,
  component: &str,
  prop: &str,
  name: Option<String>,
  default: Option<Value>,
  options: Option<Vec<NodeId>>,
) -> Result<Value, String> {
  let owner = owner(doc, component).ok_or("select a main component or a component set")?;
  if def_of(doc, &owner, prop).is_none() {
    return Err("no such property".into());
  }
  if let Some(name) = &name {
    check_name(doc, &owner, prop, name.trim())?;
  }
  if let Some(options) = &options {
    if let Some(bad) = options
      .iter()
      .find(|c| doc.get(c).map(|n| n.kind != NodeType::Component).unwrap_or(true))
    {
      return Err(format!("{bad} is not a main component"));
    }
  }
  if let Some(v) = &default {
    apply_default(doc, gen, &owner, prop, v)?;
  }
  let n = doc.get_mut(&owner).ok_or("no such component")?;
  if let Some(def) = n.component.as_mut().and_then(|c| c.props.iter_mut().find(|p| p.id == prop)) {
    if let Some(name) = name {
      def.name = name.trim().to_string();
    }
    if let Some(options) = options {
      def.options = options;
    }
  }
  Ok(json!({}))
}

/// Gives the property a new default: layers bound to it in the main components take the value.
fn apply_default(doc: &mut Document, gen: &mut IdGen, owner: &str, prop: &str, v: &Value) -> Result<(), String> {
  let def = def_of(doc, owner, prop).ok_or("no such property")?;
  let value = coerce(doc, def.kind, v)?;
  let field = PropField::of(def.kind);
  let layers = bound_in_mains(doc, owner, Some(field), prop);
  if def.kind == PropKind::InstanceSwap {
    let target = value.as_str().unwrap_or_default().to_string();
    for id in &layers {
      if would_nest(doc, &target, &components::enclosing_component(doc, id)) {
        return Err("a component can't contain an instance of itself".into());
      }
    }
    for id in &layers {
      components::swap_component(doc, id, &target, gen);
    }
  } else {
    for id in &layers {
      if let Some(n) = doc.get_mut(id) {
        match &value {
          Value::Bool(b) => n.visible = *b,
          Value::String(s) => set_characters(n, s),
          _ => {}
        }
      }
    }
  }
  if let Some(d) = doc
    .get_mut(owner)
    .and_then(|n| n.component.as_mut())
    .and_then(|c| c.props.iter_mut().find(|p| p.id == prop))
  {
    d.default = value;
  }
  Ok(())
}

fn delete(doc: &mut Document, component: &str, prop: &str) -> Result<Value, String> {
  let owner = owner(doc, component).ok_or("select a main component or a component set")?;
  if def_of(doc, &owner, prop).is_none() {
    return Err("no such property".into());
  }
  for id in bound_in_mains(doc, &owner, None, prop) {
    if let Some(n) = doc.get_mut(&id) {
      if let Some(r) = n.prop_refs.as_mut() {
        for f in [PropField::Visible, PropField::Characters, PropField::Swap] {
          if f.get(r).map(|p| p == prop).unwrap_or(false) {
            *f.slot(r) = None;
          }
        }
        if r.is_empty() {
          n.prop_refs = None;
        }
      }
    }
  }
  if let Some(c) = doc.get_mut(&owner).and_then(|n| n.component.as_mut()) {
    c.props.retain(|p| p.id != prop);
  }
  // Instances forget their values for it (their layers fall back to the main components'),
  // also those kept in the swap records of instances swapped inside them.
  update_instances(doc, |i| {
    let mut changed = i.prop_values.remove(prop).is_some();
    for v in i.overrides.values_mut() {
      changed |= strip_values(v, prop);
    }
    if changed {
      i.overrides.retain(|_, v| !is_blank(v));
    }
    changed
  });
  Ok(json!({}))
}

/// Runs `edit` on a copy of every instance's info and stores it back when it reports a change.
fn update_instances(doc: &mut Document, mut edit: impl FnMut(&mut InstanceInfo) -> bool) {
  let all: Vec<(NodeId, InstanceInfo)> = doc
    .nodes
    .values()
    .filter_map(|n| n.instance.clone().map(|i| (n.id.clone(), i)))
    .collect();
  for (id, mut info) in all {
    if edit(&mut info) {
      if let Some(n) = doc.get_mut(&id) {
        n.instance = Some(info);
      }
    }
  }
}

/// Removes property `prop`'s value from every `propValues` map inside an override entry.
fn strip_values(v: &mut Value, prop: &str) -> bool {
  let Value::Object(m) = v else { return false };
  let mut changed = false;
  if let Some(Value::Object(pv)) = m.get_mut(PROPS_KEY) {
    changed |= pv.remove(prop).is_some();
  }
  for (k, x) in m.iter_mut() {
    if k != PROPS_KEY {
      changed |= strip_values(x, prop);
    }
  }
  changed
}

/// Drops the overrides on `node`'s `field` (made before a property took the field over) from every
/// instance, including the swap records inside them.
fn prune_overrides(doc: &mut Document, node: &str, field: PropField) {
  fn prune(map: &mut serde_json::Map<String, Value>, node: &str, field: PropField) -> bool {
    let mut changed = false;
    if let Some(Value::Object(e)) = map.get_mut(node) {
      match field {
        PropField::Visible => changed |= e.remove("visible").is_some(),
        PropField::Characters => {
          if let Some(Value::Object(t)) = e.get_mut("text") {
            changed |= t.remove("characters").is_some();
            changed |= t.remove("runs").is_some();
            if t.is_empty() {
              e.remove("text");
            }
          }
        }
        PropField::Swap => {}
      }
    }
    for e in map.values_mut() {
      if let Some(Value::Object(inner)) = e.get_mut(components::SWAP_KEY).and_then(|s| s.get_mut("overrides")) {
        changed |= prune(inner, node, field);
      }
    }
    changed
  }
  update_instances(doc, |i| {
    let mut map: serde_json::Map<String, Value> = i.overrides.clone().into_iter().collect();
    if !prune(&mut map, node, field) {
      return false;
    }
    i.overrides = map.into_iter().filter(|(_, v)| !is_blank(v)).collect();
    true
  });
}

/// An override entry left with no content (an empty object, or an empty `propValues`).
fn is_blank(v: &Value) -> bool {
  match v {
    Value::Object(m) => m.values().all(|x| match x {
      Value::Object(inner) => inner.is_empty(),
      _ => false,
    }),
    _ => false,
  }
}

fn check_name(doc: &Document, owner: &str, except: &str, name: &str) -> Result<(), String> {
  if name.is_empty() {
    return Err("a property needs a name".into());
  }
  // Names that become the same React prop count as the same name.
  let ident = crate::codegen::prop_ident(name);
  if props_of(doc, owner)
    .iter()
    .any(|p| p.id != except && (p.name == name || crate::codegen::prop_ident(&p.name) == ident))
  {
    return Err(format!("a property named “{name}” already exists"));
  }
  let variant_names = comps_of(doc, owner)
    .into_iter()
    .filter_map(|c| doc.get(&c).map(|n| n.variant_props()))
    .flat_map(|v| v.into_keys());
  if variant_names
    .into_iter()
    .any(|k| k == name || crate::codegen::prop_ident(&k) == ident)
  {
    return Err(format!("“{name}” is already a variant property of this component"));
  }
  Ok(())
}

/// A property value in its canonical form for `kind`.
fn coerce(doc: &Document, kind: PropKind, v: &Value) -> Result<Value, String> {
  match kind {
    PropKind::Boolean => v
      .as_bool()
      .map(|b| json!(b))
      .ok_or_else(|| "a boolean property takes true or false".into()),
    PropKind::Text => match v {
      Value::String(s) => Ok(json!(s)),
      Value::Number(n) => Ok(json!(n.to_string())),
      _ => Err("a text property takes a string".into()),
    },
    PropKind::InstanceSwap => match v.as_str().and_then(|c| doc.get(c)) {
      Some(c) if c.kind == NodeType::Component => Ok(json!(c.id)),
      _ => Err("an instance swap property takes the id of a main component".into()),
    },
  }
}

// ---------- Binding layers ----------

/// Why `node` can't be bound to a property of `owner` through `field`.
fn check_bindable(doc: &Document, node: &str, owner: &str, field: PropField) -> Result<(), String> {
  let n = doc.get(node).ok_or_else(|| format!("no layer {node}"))?;
  let host = components::enclosing_component(doc, node).ok_or("only layers of a main component can use properties")?;
  if host == node {
    return Err("the component itself can't be bound to a property".into());
  }
  if components::enclosing_component(doc, node)
    .and_then(|h| self::owner(doc, &h))
    .as_deref()
    != Some(owner)
  {
    return Err("that property belongs to another component".into());
  }
  if doc.instance_ancestor(node).is_some() {
    return Err("layers inside an instance can't be bound; expose the instance's properties instead".into());
  }
  match field {
    PropField::Visible => Ok(()),
    PropField::Characters if n.kind == NodeType::Text => Ok(()),
    PropField::Characters => Err("only text layers can use a text property".into()),
    PropField::Swap if n.kind == NodeType::Instance && n.instance.is_some() => Ok(()),
    PropField::Swap => Err("only an instance can use an instance swap property".into()),
  }
}

fn bind(doc: &mut Document, node: &str, field: PropField, prop: Option<&str>) -> Result<(), String> {
  match prop {
    Some(prop) => {
      let host = components::enclosing_component(doc, node).ok_or("only layers of a main component can use properties")?;
      let owner = owner(doc, &host).ok_or("only layers of a main component can use properties")?;
      let def = def_of(doc, &owner, prop).ok_or("no such property")?;
      if def.kind != field.kind() {
        return Err(format!(
          "a {} property can't control a layer's {}",
          kind_label(def.kind),
          field.label()
        ));
      }
      check_bindable(doc, node, &owner, field)?;
    }
    None if doc.get(node).is_none() => return Err(format!("no layer {node}")),
    None => {}
  }
  let n = doc.get_mut(node).ok_or("no such layer")?;
  let refs = n.prop_refs.get_or_insert_with(PropRefs::default);
  *field.slot(refs) = prop.map(String::from);
  if refs.is_empty() {
    n.prop_refs = None;
  }
  if prop.is_some() {
    prune_overrides(doc, node, field);
  }
  Ok(())
}

fn kind_label(k: PropKind) -> &'static str {
  match k {
    PropKind::Boolean => "boolean",
    PropKind::Text => "text",
    PropKind::InstanceSwap => "instance swap",
  }
}

/// Moves the properties of components that were just combined into a set onto the set. A
/// property with the same name and type as one already there joins it.
pub fn merge_into_set(doc: &mut Document, comps: &[NodeId], set: &str) {
  let mut merged: Vec<PropDef> = Vec::new();
  let mut renamed: Vec<(NodeId, String, String)> = Vec::new();
  for c in comps {
    let defs = doc
      .get_mut(c)
      .and_then(|n| n.component.as_mut())
      .map(|ci| std::mem::take(&mut ci.props))
      .unwrap_or_default();
    for d in defs {
      if merged.iter().any(|m| m.id == d.id) {
        continue;
      }
      match merged.iter().find(|m| m.name == d.name && m.kind == d.kind) {
        Some(m) => renamed.push((c.clone(), d.id, m.id.clone())),
        None => merged.push(d),
      }
    }
  }
  if merged.is_empty() {
    return;
  }
  if let Some(s) = doc.get_mut(set) {
    s.component.get_or_insert_with(ComponentInfo::default).props = merged;
  }
  for (comp, old, new) in renamed {
    for id in doc.subtree(&comp) {
      if let Some(r) = doc.get_mut(&id).and_then(|n| n.prop_refs.as_mut()) {
        for f in [PropField::Visible, PropField::Characters, PropField::Swap] {
          if f.get(r) == Some(&old) {
            *f.slot(r) = Some(new.clone());
          }
        }
      }
    }
    let users: Vec<NodeId> = doc
      .nodes
      .values()
      .filter(|n| {
        n.instance
          .as_ref()
          .map(|i| i.component_id == comp && i.prop_values.contains_key(&old))
          .unwrap_or(false)
      })
      .map(|n| n.id.clone())
      .collect();
    for id in users {
      if let Some(i) = doc.get_mut(&id).and_then(|n| n.instance.as_mut()) {
        if let Some(v) = i.prop_values.remove(&old) {
          i.prop_values.insert(new.clone(), v);
        }
      }
    }
  }
}

/// The properties of `comp`'s set that its layers use, for a copy of the variant that stands
/// alone (copied out of its set, or moved out of it).
pub fn standalone_props(doc: &Document, comp: &str) -> Vec<PropDef> {
  let used = used_ids(doc, comp);
  props_of(doc, comp).into_iter().filter(|p| used.contains(&p.id)).collect()
}

/// Ids of the properties the layers under `comp` are bound to.
fn used_ids(doc: &Document, comp: &str) -> HashSet<String> {
  doc
    .subtree(comp)
    .iter()
    .filter_map(|i| doc.get(i).and_then(|n| n.prop_refs.clone()))
    .flat_map(|r| [r.visible, r.characters, r.swap])
    .flatten()
    .collect()
}

/// After a mutation: a variant that left its component set (moved out, set ungrouped) takes the
/// set's properties its layers use, so they keep working; moved to another set, they go there.
pub fn follow_variants(doc: &mut Document, prev: &Document) {
  let mut moved: Vec<(NodeId, Vec<PropDef>)> = Vec::new();
  for item in prev.nodes.diff(&doc.nodes) {
    let imbl::ordmap::DiffItem::Update { old: (_, o), new: (k, n) } = item else {
      continue;
    };
    if n.kind != NodeType::Component || o.parent == n.parent {
      continue;
    }
    let old_set = o
      .parent
      .as_ref()
      .and_then(|p| prev.get(p))
      .filter(|s| s.kind == NodeType::ComponentSet);
    let used = used_ids(doc, k);
    let defs: Vec<PropDef> = old_set
      .and_then(|s| s.component.as_ref())
      .map(|c| c.props.iter().filter(|p| used.contains(&p.id)).cloned().collect())
      .unwrap_or_default();
    if !defs.is_empty() {
      moved.push((k.clone(), defs));
    }
  }
  for (comp, defs) in moved {
    let Some(target) = owner(doc, &comp) else { continue };
    for mut d in defs {
      let have = props_of(doc, &target);
      if have.iter().any(|p| p.id == d.id) {
        continue;
      }
      let base = d.name.clone();
      let mut i = 2;
      while check_name(doc, &target, "", &d.name).is_err() {
        d.name = format!("{base} {i}");
        i += 1;
      }
      if let Some(n) = doc.get_mut(&target) {
        n.component.get_or_insert_with(ComponentInfo::default).props.push(d);
      }
    }
  }
}

/// Whether an instance kept its component but got other property values.
fn values_changed(old: &Option<InstanceInfo>, new: &Option<InstanceInfo>) -> bool {
  match (old, new) {
    (Some(a), Some(b)) => a.component_id == b.component_id && a.prop_values != b.prop_values,
    _ => false,
  }
}

/// After a collaborator's change: an instance whose property values changed (its component
/// didn't) is rebuilt from them, so its layers show what they say; the layers and the info are
/// merged separately. (A swapped component is left as merged, see STATUS.)
pub fn resync_changed(doc: &mut Document, gen: &mut IdGen, prev: &Document) {
  let mut tops: Vec<NodeId> = Vec::new();
  for item in prev.nodes.diff(&doc.nodes) {
    let imbl::ordmap::DiffItem::Update { old: (_, o), new: (k, n) } = item else {
      continue;
    };
    if n.kind == NodeType::Instance && values_changed(&o.instance, &n.instance) {
      let top = outermost(doc, k);
      if !tops.contains(&top) {
        tops.push(top);
      }
    }
  }
  for t in tops {
    components::sync_instance(doc, &t, gen);
  }
}

// ---------- Values on instances ----------

fn set(doc: &mut Document, gen: &mut IdGen, instance: &str, prop: &str, value: Option<Value>) -> Result<Value, String> {
  let info = doc.get(instance).and_then(|n| n.instance.clone()).ok_or("not an instance")?;
  let def = def_of(doc, &info.component_id, prop).ok_or("the component has no such property")?;
  if def.kind == PropKind::InstanceSwap {
    return set_swap(doc, gen, instance, &def, value).map(|_| json!({}));
  }
  // A value the component already shows is no value at all.
  let value = match value {
    Some(v) => Some(coerce(doc, def.kind, &v)?).filter(|v| *v != baseline(doc, instance, &def)),
    None => None,
  };
  write_value(doc, instance, prop, value)?;
  let top = outermost(doc, instance);
  components::sync_instance(doc, &top, gen);
  Ok(json!({}))
}

fn set_swap(doc: &mut Document, gen: &mut IdGen, a: &str, def: &PropDef, value: Option<Value>) -> Result<(), String> {
  let layers = bound_in_instance(doc, a, PropField::Swap, &def.id);
  if layers.is_empty() {
    return Err("no layer of this instance uses that property".into());
  }
  let masters: Vec<NodeId> = layers.iter().filter_map(|l| doc.get(l).and_then(|n| n.master_id.clone())).collect();
  match value {
    Some(v) => {
      let target = coerce(doc, PropKind::InstanceSwap, &v)?;
      let target = target.as_str().unwrap_or_default().to_string();
      if !def.options.is_empty() && !def.options.contains(&target) && !is_default(doc, a, def, &target) {
        return Err("that component isn't one of the property's options".into());
      }
      for l in &layers {
        if would_nest(doc, &target, &components::enclosing_component(doc, l)) || instance_components(doc, l).contains(&target) {
          return Err("a component can't contain an instance of itself".into());
        }
      }
      for (l, m) in layers.iter().zip(&masters) {
        // Earlier swaps rebuild the instance; ids are kept, but look the layer up again to be sure.
        let id = if doc.get(l).is_some() {
          l.clone()
        } else {
          find_by_master(doc, a, m).unwrap_or_else(|| l.clone())
        };
        components::swap_component(doc, &id, &target, gen);
      }
    }
    None => {
      for l in &layers {
        clear_swap(doc, l);
      }
      let top = outermost(doc, a);
      components::sync_instance(doc, &top, gen);
    }
  }
  Ok(())
}

/// Whether `target` is what the main component shows for the property (always allowed).
fn is_default(doc: &Document, a: &str, def: &PropDef, target: &str) -> bool {
  let comp = doc
    .get(a)
    .and_then(|n| n.instance.as_ref())
    .map(|i| i.component_id.clone())
    .unwrap_or_default();
  owner(doc, &comp)
    .map(|o| main_value(doc, &o, def) == json!(target))
    .unwrap_or(false)
}

fn find_by_master(doc: &Document, root: &str, master: &str) -> Option<NodeId> {
  doc
    .subtree(root)
    .into_iter()
    .find(|d| doc.get(d).and_then(|n| n.master_id.as_deref()) == Some(master))
}

/// Drops the swap recorded for nested instance `x` (it goes back to the main component's).
fn clear_swap(doc: &mut Document, x: &str) {
  let scopes = components::scope_chain(doc, x);
  let (Some(scope), Some(key)) = (scopes.last().cloned(), doc.get(x).and_then(|n| n.master_id.clone())) else {
    return;
  };
  let swapped_name = components::swap_entry(doc, &scope, &key).and_then(|s| doc.get(&s.component_id).map(|c| c.name.clone()));
  if let Some(info) = doc.get_mut(&scope).and_then(|i| i.instance.as_mut()) {
    if let Some(Value::Object(m)) = info.overrides.get_mut(&key) {
      m.remove(components::SWAP_KEY);
      // The name that followed the swap goes too.
      if m.get("name").and_then(|v| v.as_str()) == swapped_name.as_deref() {
        m.remove("name");
      }
    }
    if info.overrides.get(&key).map(is_blank).unwrap_or(false) {
      info.overrides.remove(&key);
    }
  }
  components::persist_scopes(doc, &scopes);
}

/// Where an instance's own property values are kept.
enum Home {
  /// In its own info (an instance outside others, or one swapped through another).
  Own { scopes: Vec<NodeId> },
  /// In the override for it that the nearest scope instance keeps.
  Entry { scopes: Vec<NodeId>, key: NodeId },
}

fn home(doc: &Document, a: &str) -> Option<Home> {
  let mut scopes = components::scope_chain(doc, a);
  if scopes.is_empty() {
    return Some(Home::Own { scopes });
  }
  if components::is_swapped_nested(doc, a) {
    scopes.push(a.to_string());
    return Some(Home::Own { scopes });
  }
  let key = doc.get(a)?.master_id.clone()?;
  Some(Home::Entry { scopes, key })
}

/// The values set on instance `a` itself (not those its main component's nested instances carry).
pub fn explicit_values(doc: &Document, a: &str) -> BTreeMap<String, Value> {
  let own = |id: &str| {
    doc
      .get(id)
      .and_then(|n| n.instance.as_ref())
      .map(|i| i.prop_values.clone())
      .unwrap_or_default()
  };
  match home(doc, a) {
    Some(Home::Own { .. }) => own(a),
    Some(Home::Entry { scopes, key }) => scopes
      .last()
      .and_then(|s| doc.get(s))
      .and_then(|n| n.instance.as_ref())
      .and_then(|i| i.overrides.get(&key))
      .and_then(|o| o.get(PROPS_KEY))
      .and_then(|v| v.as_object())
      .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
      .unwrap_or_default(),
    None => BTreeMap::new(),
  }
}

/// Records (or with None removes) a value for property `prop` on instance `a`. The layers it
/// controls are updated by the next sync.
fn write_value(doc: &mut Document, a: &str, prop: &str, value: Option<Value>) -> Result<(), String> {
  match home(doc, a).ok_or("not an instance")? {
    Home::Own { scopes } => {
      let i = doc.get_mut(a).and_then(|n| n.instance.as_mut()).ok_or("not an instance")?;
      match value {
        Some(v) => i.prop_values.insert(prop.to_string(), v),
        None => i.prop_values.remove(prop),
      };
      components::persist_scopes(doc, &scopes);
    }
    Home::Entry { scopes, key } => {
      let scope = scopes.last().cloned().ok_or("not an instance")?;
      let info = doc.get_mut(&scope).and_then(|n| n.instance.as_mut()).ok_or("not an instance")?;
      let entry = info.overrides.entry(key.clone()).or_insert_with(components::empty);
      if let Value::Object(m) = entry {
        let vals = m.entry(PROPS_KEY.to_string()).or_insert_with(components::empty);
        if let Value::Object(vm) = vals {
          match value {
            Some(v) => vm.insert(prop.to_string(), v),
            None => vm.remove(prop),
          };
        }
      }
      if info.overrides.get(&key).map(is_blank).unwrap_or(false) {
        info.overrides.remove(&key);
      }
      components::persist_scopes(doc, &scopes);
    }
  }
  Ok(())
}

/// Turns an edit of a layer controlled by a property, made inside an instance, into a change
/// of the property: returns the patch without the fields the property owns.
pub fn redirect_edit(doc: &mut Document, node_id: &str, p: &Value) -> Value {
  let Some(n) = doc.get(node_id) else { return p.clone() };
  let (Some(refs), Some(_)) = (n.prop_refs.clone(), n.master_id.as_ref()) else {
    return p.clone();
  };
  let Some(a) = doc.instance_ancestor(node_id) else {
    return p.clone();
  };
  let comp = doc
    .get(&a)
    .and_then(|n| n.instance.as_ref())
    .map(|i| i.component_id.clone())
    .unwrap_or_default();
  let known = |pid: &String| def_of(doc, &comp, pid).is_some();
  // The value to record: none when the component already shows it.
  let value = |pid: &String, v: Value| {
    let same = def_of(doc, &comp, pid).map(|d| baseline(doc, &a, &d) == v).unwrap_or(false);
    (!same).then_some(v)
  };
  let mut out = p.clone();
  let mut changes: Vec<(String, Option<Value>)> = Vec::new();
  if let (Some(pid), Some(Value::Bool(b))) = (refs.visible.as_ref().filter(|x| known(x)), p.get("visible")) {
    changes.push((pid.clone(), value(pid, json!(b))));
    if let Value::Object(m) = &mut out {
      m.remove("visible");
    }
  }
  if let (Some(pid), Some(chars)) = (
    refs.characters.as_ref().filter(|x| known(x)),
    p.pointer("/text/characters").and_then(|v| v.as_str()),
  ) {
    changes.push((pid.clone(), value(pid, json!(chars))));
    if let Some(Value::Object(t)) = out.get_mut("text") {
      t.remove("characters");
      t.remove("runs");
      if t.is_empty() {
        if let Value::Object(m) = &mut out {
          m.remove("text");
        }
      }
    }
  }
  for (pid, v) in changes {
    let _ = write_value(doc, &a, &pid, v);
  }
  out
}

/// Carries an instance's property values over to another component (a variant swap or an
/// instance swap): values for properties with the same id (variants share their set's) or the
/// same name and type stay.
pub fn carry_values(doc: &Document, from: &str, to: &str, values: &BTreeMap<String, Value>) -> BTreeMap<String, Value> {
  if values.is_empty() {
    return BTreeMap::new();
  }
  let (old, new) = (props_of(doc, from), props_of(doc, to));
  let mut out = BTreeMap::new();
  for (k, v) in values {
    let Some(o) = old.iter().find(|p| p.id == *k) else { continue };
    let target = new
      .iter()
      .find(|p| p.id == o.id && p.kind == o.kind)
      .or_else(|| new.iter().find(|p| p.name == o.name && p.kind == o.kind));
    if let Some(t) = target {
      out.insert(t.id.clone(), v.clone());
    }
  }
  out
}

/// Expose or hide a nested instance's properties on the outer component's instances.
fn expose_props(doc: &mut Document, instance: &str, expose: bool) -> Result<Value, String> {
  let n = doc.get(instance).ok_or("no such layer")?;
  if n.instance.is_none() {
    return Err("not an instance".into());
  }
  if components::enclosing_component(doc, instance).is_none() || doc.instance_ancestor(instance).is_some() {
    return Err("only an instance placed directly in a main component can expose its properties".into());
  }
  if let Some(i) = doc.get_mut(instance).and_then(|n| n.instance.as_mut()) {
    i.expose_props = expose;
  }
  Ok(json!({}))
}

// ---------- Applying values when an instance is built ----------

/// Applies the property values of instance `inst_id` (and of the instances nested in it that
/// aren't swapped, whose own build covers them) to the layers they control. `skip` holds the
/// nested instances that were built from their own swap records.
pub(crate) fn apply_values(
  doc: &mut Document,
  inst_id: &str,
  info: &InstanceInfo,
  overrides: &BTreeMap<NodeId, Value>,
  skip: &HashSet<NodeId>,
) {
  enum Edit {
    Visible(bool),
    Characters(String),
  }
  let mut edits: Vec<(NodeId, Edit)> = Vec::new();
  // Per instance level: the values set on it and the ids of the properties its component has
  // (a reference to any other property, left by a variant that left its set, controls nothing).
  type Level = (Rc<BTreeMap<String, Value>>, Rc<HashSet<String>>);
  let ids_of = |comp: &str| Rc::new(props_of(doc, comp).into_iter().map(|p| p.id).collect::<HashSet<String>>());
  let root: Level = (Rc::new(info.prop_values.clone()), ids_of(&info.component_id));
  let mut stack: Vec<(NodeId, Level)> = vec![(inst_id.to_string(), root)];
  while let Some((cur, (values, valid))) = stack.pop() {
    let Some(n) = doc.get(&cur) else { continue };
    for c in &n.children {
      let Some(cn) = doc.get(c) else { continue };
      let on = |p: &Option<String>| p.clone().filter(|p| valid.contains(p));
      if let Some(r) = cn.prop_refs.as_ref().map(|r| PropRefs {
        visible: on(&r.visible),
        characters: on(&r.characters),
        swap: None,
      }) {
        // The property alone decides what it controls: its value, else what the main component
        // shows (an override made before the layer was bound to it no longer counts).
        let master = cn.master_id.as_ref().and_then(|m| doc.get(m));
        let visible = match r.visible.as_ref().and_then(|p| values.get(p)) {
          Some(Value::Bool(b)) => Some(*b),
          _ => r.visible.as_ref().and(master).map(|m| m.visible),
        };
        if let Some(b) = visible.filter(|b| *b != cn.visible) {
          edits.push((c.clone(), Edit::Visible(b)));
        }
        let characters = match r.characters.as_ref().and_then(|p| values.get(p)) {
          Some(Value::String(s)) => Some(s.clone()),
          _ => r
            .characters
            .as_ref()
            .and(master)
            .and_then(|m| m.text.as_ref())
            .map(|t| t.characters.clone()),
        };
        if let Some(s) = characters.filter(|s| cn.text.as_ref().map(|t| t.characters != *s).unwrap_or(false)) {
          edits.push((c.clone(), Edit::Characters(s)));
        }
      }
      match &cn.instance {
        Some(i) if cn.kind == NodeType::Instance => {
          if skip.contains(c) {
            continue;
          }
          // A nested instance: only what was set on it through the outer one is a value here;
          // what its own main component's copy sets is already what its layers' masters show.
          let set = cn
            .master_id
            .as_ref()
            .and_then(|m| overrides.get(m))
            .and_then(|o| o.get(PROPS_KEY))
            .and_then(|v| v.as_object());
          let v: BTreeMap<String, Value> = set
            .map(|s| s.iter().map(|(k, x)| (k.clone(), x.clone())).collect())
            .unwrap_or_default();
          stack.push((c.clone(), (Rc::new(v), ids_of(&i.component_id))));
        }
        _ => stack.push((c.clone(), (values.clone(), valid.clone()))),
      }
    }
  }
  for (id, e) in edits {
    if let Some(n) = doc.get_mut(&id) {
      match e {
        Edit::Visible(b) => n.visible = b,
        Edit::Characters(s) => set_characters(n, &s),
      }
    }
  }
}

fn set_characters(n: &mut Node, s: &str) {
  if let Some(t) = n.text.as_mut() {
    if t.characters != s {
      t.runs = crate::text::remap_runs(&t.characters, s, &t.runs);
      t.characters = s.to_string();
    }
  }
}

// ---------- Describing for the panel ----------

/// What the design panel shows for `id`: the properties of a main component or set (with the
/// layers bound to them), the controls of an instance (its own and those nested instances
/// expose), or what a layer of a main component can bind to.
pub fn describe(doc: &Document, id: &str) -> Value {
  let Some(n) = doc.get(id) else { return json!({ "mode": "none" }) };
  match n.kind {
    NodeType::Component | NodeType::ComponentSet => describe_main(doc, n),
    NodeType::Instance if n.instance.is_some() => describe_instance(doc, n),
    _ => describe_layer(doc, n),
  }
}

fn describe_main(doc: &Document, n: &Node) -> Value {
  let Some(owner) = owner(doc, &n.id) else {
    return json!({ "mode": "none" });
  };
  let props: Vec<Value> = props_of(doc, &owner)
    .iter()
    .map(|d| {
      let field = PropField::of(d.kind);
      let bound: Vec<Value> = bound_in_mains(doc, &owner, Some(field), &d.id)
        .iter()
        .filter_map(|b| doc.get(b))
        .map(|b| json!({ "node": b.id, "name": b.name, "field": field.label() }))
        .collect();
      json!({
        "id": d.id,
        "name": d.name,
        "kind": d.kind,
        "default": main_value(doc, &owner, d),
        "options": d.options.iter().filter_map(|o| doc.get(o)).map(|o| json!({ "id": o.id, "name": component_label(doc, o) })).collect::<Vec<_>>(),
        "bound": bound,
      })
    })
    .collect();
  json!({ "mode": "main", "owner": owner, "props": props })
}

fn describe_layer(doc: &Document, n: &Node) -> Value {
  let Some(host) = components::enclosing_component(doc, &n.id).filter(|h| *h != n.id) else {
    return json!({ "mode": "none" });
  };
  if doc.instance_ancestor(&n.id).is_some() {
    return json!({ "mode": "none" });
  }
  let Some(owner) = owner(doc, &host) else {
    return json!({ "mode": "none" });
  };
  json!({
    "mode": "layer",
    "owner": owner,
    "props": props_of(doc, &owner).iter().map(|d| json!({ "id": d.id, "name": d.name, "kind": d.kind })).collect::<Vec<_>>(),
    "refs": n.prop_refs,
    "canBind": { "visible": true, "characters": n.kind == NodeType::Text, "swap": n.kind == NodeType::Instance && n.instance.is_some() },
  })
}

fn describe_instance(doc: &Document, n: &Node) -> Value {
  let mut groups = Vec::new();
  if let Some(g) = group(doc, n, None) {
    groups.push(g);
  }
  // Nested instances that expose their properties (each level on the way must expose too).
  let mut stack: Vec<NodeId> = n.children.iter().rev().cloned().collect();
  while let Some(id) = stack.pop() {
    let Some(c) = doc.get(&id) else { continue };
    match &c.instance {
      Some(i) if c.kind == NodeType::Instance => {
        if i.expose_props {
          if let Some(g) = group(doc, c, Some(&n.name)) {
            groups.push(g);
          }
          stack.extend(c.children.iter().rev().cloned());
        }
      }
      _ => stack.extend(c.children.iter().rev().cloned()),
    }
  }
  let in_main = components::enclosing_component(doc, &n.id).is_some() && doc.instance_ancestor(&n.id).is_none();
  json!({
    "mode": "instance",
    "groups": groups,
    "canExpose": in_main,
    "exposed": n.instance.as_ref().map(|i| i.expose_props).unwrap_or(false),
    // An instance inside a main component can also be bound to properties of that component.
    "layer": Some(describe_layer(doc, n)).filter(|l| l["mode"] == "layer"),
  })
}

/// The controls of one instance: its component's properties with current values.
fn group(doc: &Document, a: &Node, outer: Option<&String>) -> Option<Value> {
  let info = a.instance.as_ref()?;
  let defs = props_of(doc, &info.component_id);
  if defs.is_empty() {
    return None;
  }
  let owner = owner(doc, &info.component_id)?;
  let explicit = explicit_values(doc, &a.id);
  let props: Vec<Value> = defs
    .iter()
    .map(|d| {
      let (value, custom, layers) = current(doc, &a.id, &owner, d, &explicit);
      let mut v = json!({ "id": d.id, "name": d.name, "kind": d.kind, "value": value, "custom": custom, "bound": !layers.is_empty() });
      if d.kind == PropKind::InstanceSwap {
        v["options"] = json!(swap_options(doc, d, layers.first().map(String::as_str), &value));
      }
      v
    })
    .collect();
  Some(json!({
    "instance": a.id,
    "name": a.name,
    "outer": outer,
    "component": info.component_id,
    "props": props,
  }))
}

/// A property's value on instance `a` (what its bound layers show, else the main component's),
/// whether the instance sets it itself, and the layers it controls.
fn current(doc: &Document, a: &str, owner: &str, d: &PropDef, explicit: &BTreeMap<String, Value>) -> (Value, bool, Vec<NodeId>) {
  let field = PropField::of(d.kind);
  let layers = bound_in_instance(doc, a, field, &d.id);
  let shown = layers.first().and_then(|l| doc.get(l)).and_then(|l| layer_value(l, field));
  let main = main_value(doc, owner, d);
  let (value, custom) = match d.kind {
    PropKind::InstanceSwap => {
      let value = shown.unwrap_or_else(|| main.clone());
      let custom = value != main;
      (value, custom)
    }
    _ => (shown.unwrap_or(main), explicit.contains_key(&d.id)),
  };
  (value, custom, layers)
}

/// Property name → current value for an instance of a component that has properties.
pub fn values_summary(doc: &Document, n: &Node) -> Option<Value> {
  let info = n.instance.as_ref()?;
  let defs = props_of(doc, &info.component_id);
  if defs.is_empty() {
    return None;
  }
  let owner = owner(doc, &info.component_id)?;
  let explicit = explicit_values(doc, &n.id);
  let map: serde_json::Map<String, Value> = defs
    .iter()
    .map(|d| (d.name.clone(), current(doc, &n.id, &owner, d, &explicit).0))
    .collect();
  Some(Value::Object(map))
}

/// The components an instance swap property can take for the layer `x`: its options (or every
/// main component) except those that would put a component inside itself.
fn swap_options(doc: &Document, def: &PropDef, x: Option<&str>, current: &Value) -> Vec<Value> {
  let host = x.and_then(|x| components::enclosing_component(doc, x));
  // One pass over the components for all candidates (not a walk per candidate), and never the
  // component of an instance the layer sits in (an instance can't hold its own component).
  let blocked = host.as_deref().map(|h| reaching(doc, h)).unwrap_or_default();
  let outer = x.map(|x| instance_components(doc, x)).unwrap_or_default();
  let ids: Vec<&NodeId> = if def.options.is_empty() {
    doc
      .nodes
      .values()
      .filter(|n| n.kind == NodeType::Component)
      .map(|n| &n.id)
      .collect()
  } else {
    def.options.iter().collect()
  };
  let mut out: Vec<(String, Value)> = ids
    .into_iter()
    .filter_map(|c| doc.get(c))
    .filter(|c| c.kind == NodeType::Component)
    .filter(|c| current.as_str() == Some(c.id.as_str()) || !(blocked.contains(&c.id) || outer.contains(&c.id)))
    .map(|c| {
      let label = component_label(doc, c);
      (label.clone(), json!({ "id": c.id, "name": label }))
    })
    .collect();
  out.sort_by(|a, b| a.0.cmp(&b.0));
  out.into_iter().map(|(_, v)| v).collect()
}

/// The main components of the instances around layer `x` (the ones whose content it is part of).
fn instance_components(doc: &Document, x: &str) -> HashSet<NodeId> {
  doc
    .ancestors(x)
    .iter()
    .filter_map(|a| doc.get(a))
    .filter(|a| a.kind == NodeType::Instance)
    .filter_map(|a| a.instance.as_ref().map(|i| i.component_id.clone()))
    // (a variant counts as its whole set)
    .flat_map(|c| {
      let all = owner(doc, &c).map(|o| comps_of(doc, &o)).unwrap_or_default();
      std::iter::once(c).chain(all)
    })
    .collect()
}

/// The components that are `host` or hold it (through instances, any depth): placing one of
/// them inside `host` would make it contain itself. One walk over every component's layers.
fn reaching(doc: &Document, host: &str) -> HashSet<NodeId> {
  let mut holders: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
  for c in doc.nodes.values().filter(|n| n.kind == NodeType::Component) {
    let mut refs = Vec::new();
    let mut stack = vec![c.id.clone()];
    while let Some(id) = stack.pop() {
      if let Some(n) = doc.get(&id) {
        components::referenced_components(n, &mut refs);
        stack.extend(n.children.iter().cloned());
      }
    }
    for r in refs {
      holders.entry(r).or_default().push(c.id.clone());
    }
  }
  let mut out: HashSet<NodeId> = HashSet::from([host.to_string()]);
  let mut queue: VecDeque<NodeId> = VecDeque::from([host.to_string()]);
  while let Some(c) = queue.pop_front() {
    for h in holders.get(&c).into_iter().flatten() {
      if out.insert(h.clone()) {
        queue.push_back(h.clone());
      }
    }
  }
  out
}

/// "Button / Size=Large" for a variant, the component's name otherwise.
fn component_label(doc: &Document, c: &Node) -> String {
  match c.parent.as_ref().and_then(|p| doc.get(p)) {
    Some(set) if set.kind == NodeType::ComponentSet => format!("{} / {}", set.name, c.name),
    _ => c.name.clone(),
  }
}

#[cfg(test)]
#[path = "props_tests.rs"]
mod tests;
