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

use serde_json::Value;

use crate::doc::IdGen;
use crate::model::{ComponentInfo, Document, InstanceInfo, Node, NodeId, NodeType};
use crate::patch;

pub const ROOT_KEY: &str = "__root";

/// Key, inside an override, of a nested instance's swap record (its `InstanceInfo`).
const SWAP_KEY: &str = "instance";

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
/// Nested instances swapped through it are rebuilt from the component they were swapped to.
pub fn sync_instance(doc: &mut Document, inst_id: &str, gen: &mut IdGen) {
  let Some(info) = doc.get(inst_id).and_then(|n| n.instance.clone()) else {
    return;
  };
  if doc.get(&info.component_id).is_none() {
    return;
  }
  // Reuse ids of existing copies so selection (and overrides keyed by them) survive. The old
  // copies are removed by `build` once it has what it needs from them.
  let mut reuse = Reuse::new(doc, inst_id);
  build(doc, gen, &mut reuse, inst_id, &info, &info.overrides, &Vec::new(), 0);
  reuse.remove_old(doc);
}

/// Records a property edit made on a node that lives in an instance.
pub fn record_override(doc: &mut Document, node_id: &str, p: &Value) {
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

/// After changes from collaborators were merged in: instances in `touched` whose component or
/// swap records changed are rebuilt from that record. Node edits merge field by field, so two
/// people swapping one instance at once would otherwise leave copies of one variant under
/// the other. New layers get ids from a generator seeded by the instance, so every peer (and
/// the relay) ends up with the same ones.
pub fn resync_swapped(doc: &mut Document, prev: &Document, touched: &[NodeId]) {
  fn swaps(i: &InstanceInfo) -> Vec<(&NodeId, &Value)> {
    i.overrides.iter().filter_map(|(k, v)| v.get(SWAP_KEY).map(|s| (k, s))).collect()
  }
  for id in touched {
    let (Some(n), Some(p)) = (doc.get(id), prev.get(id)) else {
      continue;
    };
    let (Some(now), Some(before)) = (n.instance.as_ref(), p.instance.as_ref()) else {
      continue;
    };
    if n.kind != NodeType::Instance || (now.component_id == before.component_id && swaps(now) == swaps(before)) {
      continue;
    }
    if doc.instance_ancestor(id).is_none() {
      // FNV-1a: stable across builds, unlike the std hasher.
      let seed = id
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
      sync_instance(doc, id, &mut IdGen::new(seed));
    }
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

/// Clears an instance's overrides. Inside another instance, this clears the overrides (and
/// any swap) made on it through the outer instance, so it matches its main component again.
pub fn reset_overrides(doc: &mut Document, inst_id: &str, gen: &mut IdGen) {
  let scopes = scope_chain(doc, inst_id);
  let Some(parent) = scopes.last() else {
    if let Some(info) = doc.get_mut(inst_id).and_then(|i| i.instance.as_mut()) {
      info.overrides.clear();
    }
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

/// Points an instance at another component (variant swap or instance swap). Overrides on
/// layers that exist in both components, matched by their path of layer names, carry over;
/// everything else follows the new component. An instance inside another instance is
/// swapped through the outer one, so the swap survives the outer instance re-syncing.
pub fn swap_component(doc: &mut Document, inst_id: &str, comp_id: &str, gen: &mut IdGen) {
  let Some(new_name) = doc.get(comp_id).filter(|c| c.kind == NodeType::Component).map(|c| c.name.clone()) else {
    return;
  };
  if comp_id == inst_id || doc.is_ancestor(comp_id, inst_id) || would_nest(doc, comp_id, &enclosing_component(doc, inst_id)) {
    return;
  }
  let Some(inst) = doc.get(inst_id).cloned() else { return };
  let Some(info) = inst.instance.clone() else { return };
  let old_name = doc.get(&info.component_id).map(|c| c.name.clone());
  // An instance still named after its component follows the swap; a name of its own stays.
  let follow = inst.name.is_empty() || Some(&inst.name) == old_name.as_ref();
  let scopes = scope_chain(doc, inst_id);
  let Some(parent) = scopes.last().cloned() else {
    let overrides = carry_overrides(doc, &info.component_id, comp_id, &info.overrides, &BTreeMap::new());
    if let Some(inst) = doc.get_mut(inst_id) {
      if follow {
        inst.name = new_name;
      }
      inst.instance = Some(InstanceInfo {
        component_id: comp_id.to_string(),
        overrides,
      });
    }
    sync_instance(doc, inst_id, gen);
    return;
  };
  let Some(key) = inst.master_id.clone() else { return };
  if doc.is_ancestor(comp_id, &key) || would_nest(doc, comp_id, &enclosing_component(doc, &key)) {
    return;
  }
  let new_info = match swap_entry(doc, &parent, &key) {
    Some(swapped) => {
      let base = source_base(doc, &key, &swapped.component_id);
      InstanceInfo {
        component_id: comp_id.to_string(),
        overrides: carry_overrides(doc, &swapped.component_id, comp_id, &swapped.overrides, &base),
      }
    }
    None => {
      // First swap: overrides made through the outer instance on this one's layers move
      // into the swap (keyed by the new component's layers).
      let region: HashSet<NodeId> = doc.subtree(&key).into_iter().skip(1).collect();
      let mut moved = BTreeMap::new();
      if let Some(info) = doc.get_mut(&parent).and_then(|i| i.instance.as_mut()) {
        let keys: Vec<NodeId> = info.overrides.keys().filter(|k| region.contains(*k)).cloned().collect();
        for k in keys {
          if let Some(v) = info.overrides.remove(&k) {
            moved.insert(k, v);
          }
        }
      }
      InstanceInfo {
        component_id: comp_id.to_string(),
        overrides: carry_overrides(doc, &key, comp_id, &moved, &BTreeMap::new()),
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
fn enclosing_component(doc: &Document, id: &str) -> Option<NodeId> {
  std::iter::once(id.to_string())
    .chain(doc.ancestors(id))
    .find(|a| doc.get(a).map(|n| n.kind == NodeType::Component).unwrap_or(false))
}

/// The components instanced by `n` itself: its main component and any it was swapped to
/// (recorded in its overrides, to any depth).
fn referenced_components(n: &Node, out: &mut Vec<NodeId>) {
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
  let Some(host) = host else { return false };
  let mut seen: HashSet<NodeId> = HashSet::new();
  let mut stack = vec![comp.to_string()];
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

/// True when moving `ids` under `parent` would put a component inside itself.
pub fn would_nest_under(doc: &Document, ids: &[NodeId], parent: Option<&str>) -> bool {
  let host = parent.and_then(|p| enclosing_component(doc, p));
  if host.is_none() {
    return false;
  }
  ids.iter().any(|id| {
    doc.subtree(id).iter().any(|d| {
      let Some(n) = doc.get(d) else { return false };
      let mut refs = Vec::new();
      referenced_components(n, &mut refs);
      refs.iter().any(|c| would_nest(doc, c, &host)) || (n.kind == NodeType::Component && Some(&n.id) == host.as_ref())
    })
  })
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
fn scope_chain(doc: &Document, id: &str) -> Vec<NodeId> {
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
fn swap_entry(doc: &Document, scope: &str, master: &str) -> Option<InstanceInfo> {
  let v = doc.get(scope)?.instance.as_ref()?.overrides.get(master)?.get(SWAP_KEY)?;
  serde_json::from_value(v.clone()).ok()
}

/// Writes each nested scope's instance info back into the swap record of the scope above.
fn persist_scopes(doc: &mut Document, scopes: &[NodeId]) {
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
  reuse.remove_old(doc);
  map.insert(comp.id.clone(), inst_id.to_string());

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
    if let Some(si) = swaps.get(cid) {
      n.children.clear();
      n.instance = Some(si.clone());
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
    if let Some(n) = target.and_then(|t| doc.get_mut(&t)) {
      let _ = patch::apply(n, p);
    }
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
    if k == SWAP_KEY {
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
fn layer_paths(nodes: &imbl::OrdMap<NodeId, Node>, root: &str) -> HashMap<NodeId, LayerPath> {
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

fn empty() -> Value {
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

  /// Removes the old copies from the document (once).
  fn remove_old(&mut self, doc: &mut Document) {
    for nid in std::mem::take(&mut self.old_ids) {
      doc.nodes.remove(&nid);
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
      let id = reused.unwrap_or_else(|| gen.next("n_"));
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

  /// Overrides through variant swaps, nested instances and nested swaps.
  mod overrides {
    use crate::components::{carry_overrides, has_overrides, override_count};
    use crate::engine::{Command, Engine};
    use crate::model::{NodeType, Paint};
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
      assert_eq!(k.e.doc.get(&nested).unwrap().name, "State=Hover");
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
        delta: crate::collab::delta(&base, &k.e.doc, true),
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

    /// Every copy under `inst` copies a layer of the component the instance points at.
    fn consistent(e: &Engine, inst: &str) -> bool {
      let comp = e.doc.get(inst).unwrap().instance.as_ref().unwrap().component_id.clone();
      e.doc.subtree(inst).iter().skip(1).all(|d| {
        e.doc
          .get(d)
          .and_then(|n| n.master_id.as_ref())
          .map(|m| e.doc.is_ancestor(&comp, m))
          .unwrap_or(true)
      })
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
      let da = crate::collab::delta(&base, &a.doc, true);
      let bbase = b.doc.clone();
      b.dispatch(Command::SwapComponent {
        id: i.clone(),
        component_id: off.clone(),
      })
      .unwrap();
      let db = crate::collab::delta(&bbase, &b.doc, true);

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

      for (who, doc) in [("peer", &c.doc), ("relay", &relay_doc)] {
        let info = doc.get(&i).unwrap().instance.clone().unwrap();
        assert_eq!(info.component_id, off, "{who}");
        for d in doc.subtree(&i).iter().skip(1) {
          let m = doc.get(d).unwrap().master_id.clone().unwrap();
          assert!(doc.is_ancestor(&off, &m), "{who}: a copy of {m} under the Off instance");
        }
        let bg = doc.subtree(&i).into_iter().find(|d| doc.get(d).unwrap().name == "Bg").unwrap();
        assert!(
          matches!(doc.get(&bg).unwrap().fills.first(), Some(Paint::Solid { color, .. }) if color.eq_ignore_ascii_case("#222222")),
          "{who}"
        );
        let label = doc.subtree(&i).into_iter().find(|d| doc.get(d).unwrap().name == "Label").unwrap();
        assert_eq!(doc.get(&label).unwrap().text.as_ref().unwrap().characters, "Buy", "{who}");
      }
      assert!(consistent(&c, &i));
      assert_eq!(c.doc.get(&i).unwrap().instance.as_ref().unwrap().component_id, off);
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
        })
        .unwrap();
      let wrapper = id(k.e.dispatch(Command::CreateComponent { ids: vec![w] }).unwrap());
      let r = k.e.dispatch(Command::CreateInstance {
        component_id: wrapper.clone(),
        x: 0.0,
        y: 0.0,
        parent: Some(card_comp.clone()),
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

    fn fill_of(e: &Engine, id: &str) -> String {
      match e.doc.get(id).unwrap().fills.first() {
        Some(Paint::Solid { color, .. }) => color.to_uppercase(),
        other => format!("{other:?}"),
      }
    }
  }
}
