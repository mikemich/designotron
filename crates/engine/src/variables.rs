//! Variables and modes: named colour/number/string/boolean values per mode,
//! bound to layer properties. Bound values are written into the layers after
//! every change, so rendering, export and lint keep reading plain properties.

use std::borrow::Borrow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::model::{Document, NodeId, Paint};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Collection {
  pub id: String,
  pub name: String,
  /// The first mode is the default.
  pub modes: Vec<VarMode>,
  /// Behind `Arc`s so a copy of the collection shares the variables an edit didn't touch; edit
  /// through [`var_mut`].
  pub variables: Vec<Arc<Variable>>,
}

/// A collection, mutable (copied out of its `Arc` only when shared with an undo snapshot).
pub fn coll_mut<'a>(doc: &'a mut Document, id: &str) -> Option<&'a mut Collection> {
  doc.variables.iter_mut().find(|c| c.id == id).map(Arc::make_mut)
}

/// A variable of `coll`, mutable (copied out of its `Arc` only when shared).
pub fn var_mut<'a>(coll: &'a mut Collection, id: &str) -> Option<&'a mut Variable> {
  coll.variables.iter_mut().find(|v| v.id == id).map(Arc::make_mut)
}

/// Gives `new` (a freshly deserialised set, as the variables dialog sends) the `Arc`s of `old`
/// wherever content is equal, matched by id and never by position, so a one-value edit leaves
/// every other collection and variable shared with the undo history. Linear in the variable count.
pub fn intern(new: Vec<Collection>, old: &[Arc<Collection>]) -> Vec<Arc<Collection>> {
  let old_by_id: BTreeMap<&str, &Arc<Collection>> = old.iter().map(|c| (c.id.as_str(), c)).collect();
  new
    .into_iter()
    .map(|mut c| {
      let Some(prev) = old_by_id.get(c.id.as_str()) else {
        return Arc::new(c);
      };
      let prev_vars: BTreeMap<&str, &Arc<Variable>> = prev.variables.iter().map(|v| (v.id.as_str(), v)).collect();
      for v in &mut c.variables {
        if let Some(p) = prev_vars.get(v.id.as_str()) {
          if **p == *v {
            *v = Arc::clone(p);
          }
        }
      }
      if c == ***prev {
        Arc::clone(prev)
      } else {
        Arc::new(c)
      }
    })
    .collect()
}

/// The collections as plain values (what `Command::SetVariables` carries). Cheap: the variables
/// inside stay shared until edited through `Arc::make_mut`.
pub fn plain(list: &[Arc<Collection>]) -> Vec<Collection> {
  list.iter().map(|c| (**c).clone()).collect()
}

/// Swaps each collection of `new` for the `Arc` of the equal collection of `old` (by id), so a
/// merge that changed one collection leaves the others shared with the undo history.
pub fn reshare(new: &mut [Arc<Collection>], old: &[Arc<Collection>]) {
  for c in new.iter_mut() {
    if let Some(o) = old.iter().find(|o| o.id == c.id) {
      if crate::model::arc_eq(o, c) {
        *c = Arc::clone(o);
      }
    }
  }
}

impl PartialEq for Collection {
  /// Destructured on purpose: a field added later must be compared here or this stops compiling.
  fn eq(&self, o: &Self) -> bool {
    let Collection {
      id,
      name,
      modes,
      variables,
    } = self;
    *id == o.id && *name == o.name && *modes == o.modes && crate::model::arcs_eq(variables, &o.variables)
  }
}

impl Collection {
  /// A collection from plain variables (they get their `Arc`s here).
  pub fn new(id: &str, name: &str, modes: Vec<VarMode>, variables: Vec<Variable>) -> Self {
    Collection {
      id: id.into(),
      name: name.into(),
      modes,
      variables: variables.into_iter().map(Arc::new).collect(),
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VarMode {
  pub id: String,
  pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Variable {
  pub id: String,
  pub name: String,
  #[serde(rename = "type")]
  pub kind: VarKind,
  /// Mode id → value. A value of `{"alias": "<variable id>"}` refers to another variable.
  pub values: BTreeMap<String, Value>,
  pub description: String,
  /// Properties the variable is offered for (empty = all). Names from `SCOPES`.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub scopes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum VarKind {
  #[default]
  Color,
  Number,
  String,
  Boolean,
}

/// Bindable layer properties and the variable type each accepts.
pub const PROPERTIES: &[(&str, VarKind)] = &[
  ("fill", VarKind::Color),
  ("stroke", VarKind::Color),
  ("cornerRadius", VarKind::Number),
  ("gap", VarKind::Number),
  ("padding", VarKind::Number),
  ("opacity", VarKind::Number),
  ("width", VarKind::Number),
  ("height", VarKind::Number),
  ("strokeWeight", VarKind::Number),
  ("fontSize", VarKind::Number),
  ("fontFamily", VarKind::String),
  ("fontWeight", VarKind::Number),
  ("lineHeight", VarKind::Number),
  ("letterSpacing", VarKind::Number),
  ("paragraphSpacing", VarKind::Number),
  ("paddingTop", VarKind::Number),
  ("paddingRight", VarKind::Number),
  ("paddingBottom", VarKind::Number),
  ("paddingLeft", VarKind::Number),
  ("counterGap", VarKind::Number),
  ("characters", VarKind::String),
  ("visible", VarKind::Boolean),
];

/// Scope names a variable can be limited to (Figma's `VariableScope`, camel-cased). Empty = all.
pub const SCOPES: &[&str] = &[
  "fill",
  "stroke",
  "cornerRadius",
  "size",
  "gap",
  "opacity",
  "strokeWidth",
  "textContent",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "paragraphSpacing",
];

/// The scope that offers a variable for a bindable property (`None`: always offered).
pub fn scope_of(prop: &str) -> Option<&'static str> {
  Some(match prop {
    "fill" => "fill",
    "stroke" => "stroke",
    "cornerRadius" => "cornerRadius",
    "width" | "height" => "size",
    "gap" | "counterGap" | "padding" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" => "gap",
    "opacity" => "opacity",
    "strokeWeight" => "strokeWidth",
    "characters" => "textContent",
    "fontFamily" => "fontFamily",
    "fontSize" => "fontSize",
    "fontWeight" => "fontWeight",
    "lineHeight" => "lineHeight",
    "letterSpacing" => "letterSpacing",
    "paragraphSpacing" => "paragraphSpacing",
    _ => return None,
  })
}

/// True when the variable's scopes cover the property (no scopes = everything of its type).
pub fn in_scope(v: &Variable, prop: &str) -> bool {
  v.scopes.is_empty() || scope_of(prop).is_none_or(|s| v.scopes.iter().any(|x| x == s))
}

/// Variables (with their collection) a property's picker may list: right type and scope.
pub fn bindable<'a>(doc: &'a Document, prop: &str) -> Vec<(&'a Collection, &'a Variable)> {
  let Some(kind) = property_kind(prop) else { return Vec::new() };
  doc
    .variables
    .iter()
    .flat_map(|c| c.variables.iter().map(move |v| (&**c, &**v)))
    .filter(|(_, v)| v.kind == kind && in_scope(v, prop))
    .collect()
}

/// How many aliases `resolve` follows; `validate` refuses longer chains.
pub const MAX_ALIAS_DEPTH: usize = 8;

/// A value that fits a variable of `kind`, normalised (colours to `#RRGGBB[AA]`, numeric strings
/// to numbers); aliases pass. The error reads "expected a number, got a string" and leaves the
/// variable and mode for the caller to name.
pub fn check_value(kind: VarKind, v: &Value) -> Result<Value, String> {
  if v.get("alias").is_some() {
    return Ok(v.clone());
  }
  let got = match v {
    Value::Null => "null",
    Value::Bool(_) => "a boolean",
    Value::Number(_) => "a number",
    Value::String(_) => "a string",
    Value::Array(_) => "an array",
    Value::Object(_) => "an object",
  };
  let bad = |want: &str| format!("expected {want}, got {got}");
  match kind {
    VarKind::Color => {
      let c = v.as_str().ok_or_else(|| bad("a colour like '#7C5CFF'"))?;
      if crate::color::parse(c).is_none() {
        return Err(format!("unrecognised colour '{c}'; use hex like '#7C5CFF' or rgb()/rgba()"));
      }
      Ok(Value::String(crate::color::normalize(c)))
    }
    VarKind::Number => match v {
      Value::Number(n) if n.as_f64().is_some_and(f64::is_finite) => Ok(v.clone()),
      Value::String(s) => match s.trim().parse::<f64>() {
        Ok(n) if n.is_finite() => Ok(json!(n)),
        _ => Err(bad("a number")),
      },
      _ => Err(bad("a number")),
    },
    VarKind::Boolean => v.is_boolean().then(|| v.clone()).ok_or_else(|| bad("true or false")),
    VarKind::String => v.is_string().then(|| v.clone()).ok_or_else(|| bad("a string")),
  }
}

/// Rejects unknown scope names, and alias cycles and chains longer than `resolve` follows. Only
/// variables this change touched (new, or with other values than in `previous`) are checked, so a
/// cycle two peers made at once can't block every later edit of unrelated variables. A touched
/// variable also needs values of its type and a name no other variable of its collection has.
pub fn validate(collections: &[impl Borrow<Collection>], previous: &[Arc<Collection>]) -> Result<(), String> {
  let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
  let mut names: BTreeMap<&str, &str> = BTreeMap::new();
  let old: BTreeMap<&str, &Variable> = previous
    .iter()
    .flat_map(|c| c.variables.iter())
    .map(|v| (v.id.as_str(), &**v))
    .collect();
  let mut changed: Vec<&str> = Vec::new();
  for v in collections.iter().flat_map(|c| c.borrow().variables.iter()).map(|v| &**v) {
    if let Some(bad) = v.scopes.iter().find(|s| !SCOPES.contains(&s.as_str())) {
      return Err(format!("unknown variable scope '{bad}'. Scopes: {}", SCOPES.join(", ")));
    }
    names.insert(&v.id, &v.name);
    let out = edges.entry(&v.id).or_default();
    out.extend(v.values.values().filter_map(|x| x.get("alias").and_then(|a| a.as_str())));
    let before = old.get(v.id.as_str());
    if before.is_none_or(|o| o.values != v.values) {
      changed.push(&v.id);
    }
    // Only values this change introduced are type-checked. A value that equals one the variable
    // already held (a copy made by Add mode, a mode fill in a paste) or that is unchanged is old
    // data, which files from before the check may hold in any form; it must not block edits.
    let retype = before.is_some_and(|o| o.kind != v.kind);
    if before.is_none_or(|o| o.values != v.values || retype) {
      for (mode, val) in &v.values {
        let is_new = retype || before.is_none_or(|o| o.values.get(mode) != Some(val) && !o.values.values().any(|x| x == val));
        if !is_new {
          continue;
        }
        // Only an error needs the mode's name, so it is looked up there.
        let shown_of = || {
          collections
            .iter()
            .flat_map(|c| &c.borrow().modes)
            .find(|m| m.id == *mode)
            .map_or(mode.as_str(), |m| m.name.as_str())
        };
        // Stored numbers are real numbers: "12" would be accepted by `check_value` but never applied.
        let loose_number = v.kind == VarKind::Number && val.is_string();
        match check_value(v.kind, val) {
          Ok(_) if !loose_number => {}
          Ok(_) => return Err(format!("{} ({}): expected a number, got a string", v.name, shown_of())),
          Err(msg) => return Err(format!("{} ({}): {msg}", v.name, shown_of())),
        }
      }
    }
  }
  // Mode and collection names are unique too (two "Dark" modes would export two blocks, the
  // later one winning). Judged against `previous` by id, so files that already hold duplicates
  // can still be edited.
  let old_modes: BTreeMap<(&str, &str), &str> = previous
    .iter()
    .flat_map(|c| c.modes.iter().map(move |m| ((c.id.as_str(), m.id.as_str()), m.name.as_str())))
    .collect();
  let old_colls: BTreeMap<&str, &str> = previous.iter().map(|c| (c.id.as_str(), c.name.as_str())).collect();
  // How many times each name occurs, so the checks below are one lookup each.
  let mut coll_counts: HashMap<&str, usize> = HashMap::new();
  for c in collections {
    *coll_counts.entry(c.borrow().name.trim()).or_default() += 1;
  }
  for c in collections {
    let c: &Collection = c.borrow();
    let name = c.name.trim();
    if old_colls.get(c.id.as_str()).is_none_or(|o| o.trim() != name) && coll_counts.get(name).is_some_and(|n| *n > 1) {
      return Err(format!("A collection named {name} already exists"));
    }
    let mut mode_counts: HashMap<&str, usize> = HashMap::new();
    for m in &c.modes {
      *mode_counts.entry(m.name.trim()).or_default() += 1;
    }
    for m in &c.modes {
      let name = m.name.trim();
      if old_modes.get(&(c.id.as_str(), m.id.as_str())).is_none_or(|o| o.trim() != name) && mode_counts.get(name).is_some_and(|n| *n > 1) {
        return Err(format!("{name} already exists in {}", c.name));
      }
    }
  }
  for c in collections {
    let c = c.borrow();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for v in &c.variables {
      *counts.entry(v.name.as_str()).or_default() += 1;
    }
    for v in &c.variables {
      let renamed = old.get(v.id.as_str()).is_none_or(|o| o.name != v.name);
      if renamed && counts.get(v.name.as_str()).is_some_and(|n| *n > 1) {
        return Err(format!("{} already exists in {}", v.name, c.name));
      }
    }
  }
  /// How a walk over the aliases ended: the variable that closes a loop, or a chain too long.
  enum Stop<'a> {
    Cycle(&'a str),
    TooLong,
  }
  /// Longest alias chain from `node`. Each variable is measured once (`done`), and a variable met
  /// again while still being walked (`grey`) closes a loop, so the walk is O(variables + aliases).
  /// It gives up past `MAX_ALIAS_DEPTH`, which the caller refuses anyway.
  fn depth<'a>(
    edges: &HashMap<&'a str, Vec<&'a str>>,
    node: &'a str,
    level: usize,
    grey: &mut HashSet<&'a str>,
    done: &mut HashMap<&'a str, usize>,
  ) -> Result<usize, Stop<'a>> {
    if let Some(n) = done.get(node) {
      return Ok(*n);
    }
    if grey.contains(node) {
      return Err(Stop::Cycle(node));
    }
    if level > MAX_ALIAS_DEPTH {
      return Err(Stop::TooLong);
    }
    grey.insert(node);
    let mut longest = 0;
    for t in edges.get(node).into_iter().flatten() {
      if edges.contains_key(t) {
        longest = longest.max(1 + depth(edges, t, level + 1, grey, done)?);
      }
    }
    grey.remove(node);
    done.insert(node, longest);
    Ok(longest)
  }
  let mut done: HashMap<&str, usize> = HashMap::new();
  for start in changed {
    match depth(&edges, start, 0, &mut HashSet::new(), &mut done) {
      Err(Stop::Cycle(at)) => {
        return Err(format!(
          "alias cycle: {} refers back to itself through {}",
          names.get(at).unwrap_or(&at),
          names.get(start).unwrap_or(&start)
        ))
      }
      Err(Stop::TooLong) => {
        return Err(format!(
          "{} is at the end of an alias chain of {MAX_ALIAS_DEPTH} or more; at most {} aliases can be followed",
          names.get(start).unwrap_or(&start),
          MAX_ALIAS_DEPTH - 1
        ))
      }
      Ok(n) if n >= MAX_ALIAS_DEPTH => {
        return Err(format!(
          "{} is at the end of an alias chain of {n}; at most {} aliases can be followed",
          names.get(start).unwrap_or(&start),
          MAX_ALIAS_DEPTH - 1
        ))
      }
      Ok(_) => {}
    }
  }
  Ok(())
}

pub fn property_kind(prop: &str) -> Option<VarKind> {
  PROPERTIES.iter().find(|(p, _)| *p == prop).map(|(_, k)| *k)
}

/// Looks a variable up by id, or by "name" / "Collection/name".
pub fn find<'a>(doc: &'a Document, key: &str) -> Option<(&'a Collection, &'a Variable)> {
  for c in &doc.variables {
    for v in &c.variables {
      if v.id == key || v.name == key || format!("{}/{}", c.name, v.name) == key {
        return Some((c, v));
      }
    }
  }
  None
}

/// The mode a layer sees for a collection: nearest ancestor override, else the default mode.
pub fn mode_for(doc: &Document, node: &str, coll: &Collection) -> Option<String> {
  let mut cur = Some(node.to_string());
  while let Some(id) = cur {
    let n = doc.get(&id)?;
    if let Some(m) = n.variable_modes.get(&coll.id) {
      if coll.modes.iter().any(|x| &x.id == m) {
        return Some(m.clone());
      }
    }
    cur = n.parent.clone();
  }
  coll.modes.first().map(|m| m.id.clone())
}

/// A variable's value as seen by `node` (aliases followed).
pub fn resolve(doc: &Document, node: &str, var: &str) -> Option<Value> {
  let mut key = var.to_string();
  for _ in 0..MAX_ALIAS_DEPTH {
    let (c, v) = find(doc, &key)?;
    let mode = mode_for(doc, node, c)?;
    let val = v
      .values
      .get(&mode)
      .or_else(|| c.modes.first().and_then(|m| v.values.get(&m.id)))
      .or_else(|| v.values.values().next())?;
    match val.get("alias").and_then(|a| a.as_str()) {
      Some(next) => key = next.to_string(),
      None => return Some(val.clone()),
    }
  }
  None
}

/// Rewrites bindings and mode overrides given by name (from AI specs) to ids. Only layers that
/// hold a name are written: `get_mut` path-copies a layer's tree branch, and every bound layer
/// of a token-heavy file would be copied by every edit. A pin given by name wins over an
/// id-keyed pin of the same collection (it is the newer one).
pub fn normalize(doc: &mut Document) {
  if doc.variables.is_empty() {
    return;
  }
  let ids = names_to_fix(doc, doc.nodes.values().map(|n| &**n));
  normalize_ids(doc, ids);
}

/// The layers among `nodes` that hold a variable or mode name instead of an id.
fn names_to_fix<'a>(doc: &Document, nodes: impl Iterator<Item = &'a crate::model::Node>) -> Vec<NodeId> {
  let var_ids: std::collections::HashSet<&str> = doc
    .variables
    .iter()
    .flat_map(|c| c.variables.iter().map(|v| v.id.as_str()))
    .collect();
  let mode_ok = |c: &str, m: &str| doc.variables.iter().any(|x| x.id == c && x.modes.iter().any(|y| y.id == m));
  nodes
    .filter(|n| n.bindings.values().any(|v| !var_ids.contains(v.as_str())) || n.variable_modes.iter().any(|(c, m)| !mode_ok(c, m)))
    .map(|n| n.id.clone())
    .collect()
}

fn normalize_ids(doc: &mut Document, ids: Vec<NodeId>) {
  for id in ids {
    let (bindings, modes) = {
      let n = doc.get(&id).unwrap();
      (n.bindings.clone(), n.variable_modes.clone())
    };
    let bindings: BTreeMap<String, String> = bindings
      .into_iter()
      .map(|(p, v)| (p, find(doc, &v).map(|(_, var)| var.id.clone()).unwrap_or(v)))
      .collect();
    let resolve_pin = |c: &String, m: &String| match doc.variables.iter().find(|x| x.id == *c || x.name == *c) {
      Some(coll) => (
        coll.id.clone(),
        coll
          .modes
          .iter()
          .find(|x| x.id == *m || x.name == *m)
          .map(|x| x.id.clone())
          .unwrap_or_else(|| m.clone()),
      ),
      None => (c.clone(), m.clone()),
    };
    let mut resolved: BTreeMap<String, String> = BTreeMap::new();
    // Id-keyed pins first, then name-keyed ones, which replace them.
    for (c, m) in modes.iter().filter(|(c, _)| doc.variables.iter().any(|x| x.id == **c)) {
      let (c, m) = resolve_pin(c, m);
      resolved.insert(c, m);
    }
    for (c, m) in modes.iter().filter(|(c, _)| !doc.variables.iter().any(|x| x.id == **c)) {
      let (c, m) = resolve_pin(c, m);
      resolved.insert(c, m);
    }
    doc.modify(&id, |n| {
      n.bindings = bindings;
      n.variable_modes = resolved;
    });
  }
}

/// Writes bound variable values into layer properties. Returns true if anything changed.
pub fn apply(doc: &mut Document) -> bool {
  if doc.variables.is_empty() {
    return false;
  }
  let bound: Vec<NodeId> = doc
    .nodes
    .values()
    .filter(|n| !n.bindings.is_empty())
    .map(|n| n.id.clone())
    .collect();
  let mut changed = false;
  for id in bound {
    let bindings = doc.get(&id).map(|n| n.bindings.clone()).unwrap_or_default();
    let values: Vec<(String, Value)> = bindings
      .iter()
      .filter_map(|(prop, var)| resolve(doc, &id, var).map(|v| (prop.clone(), v)))
      .collect();
    // Written back only on a change: `get_mut` would copy the tree branch of every bound layer.
    let Some(before) = doc.get(&id).cloned() else { continue };
    let mut n = before.clone();
    for (prop, v) in values {
      write_prop(&mut n, &prop, &v);
    }
    if n != before {
      doc.nodes.insert(id.clone(), Arc::new(n));
      changed = true;
    }
  }
  changed
}

/// Writes one bound value into the layer property it is bound to.
fn write_prop(n: &mut crate::model::Node, prop: &str, v: &Value) {
  let num = v.as_f64();
  match prop {
    "fill" | "stroke" => {
      let Some(color) = v.as_str().map(crate::color::normalize) else {
        return;
      };
      let paints = if prop == "fill" { &mut n.fills } else { &mut n.strokes };
      match paints.first_mut() {
        Some(Paint::Solid { color: c, .. }) => *c = color,
        Some(first) => *first = Paint::solid(&color),
        None => paints.push(Paint::solid(&color)),
      }
    }
    "cornerRadius" => {
      if let Some(r) = num {
        n.corner_radius = r.max(0.0);
        n.corner_radii = None;
      }
    }
    "gap" => {
      if let (Some(g), Some(l)) = (num, n.layout.as_mut()) {
        l.gap = g;
      }
    }
    "padding" => {
      if let (Some(p), Some(l)) = (num, n.layout.as_mut()) {
        l.padding_top = p;
        l.padding_right = p;
        l.padding_bottom = p;
        l.padding_left = p;
      }
    }
    "opacity" => {
      if let Some(o) = num {
        n.opacity = if o > 1.0 { o / 100.0 } else { o }.clamp(0.0, 1.0);
      }
    }
    "width" => {
      if let Some(w) = num {
        n.width = w.max(0.01);
        n.sizing_h = crate::model::Sizing::Fixed;
      }
    }
    "height" => {
      if let Some(h) = num {
        n.height = h.max(0.01);
        n.sizing_v = crate::model::Sizing::Fixed;
      }
    }
    "strokeWeight" => {
      if let Some(w) = num {
        n.stroke_weight = w.max(0.0);
      }
    }
    "fontSize" => {
      if let (Some(s), Some(t)) = (num, n.text.as_mut()) {
        t.font_size = s.max(1.0);
      }
    }
    "fontFamily" => {
      if let (Some(f), Some(t)) = (v.as_str(), n.text.as_mut()) {
        t.font_family = f.to_string();
      }
    }
    "fontWeight" => {
      if let (Some(w), Some(t)) = (num, n.text.as_mut()) {
        t.font_weight = ((w / 100.0).round() * 100.0).clamp(100.0, 900.0) as u32;
      }
    }
    "lineHeight" => {
      if let (Some(h), Some(t)) = (num, n.text.as_mut()) {
        t.line_height = (h > 0.0).then_some(h);
      }
    }
    "letterSpacing" => {
      if let (Some(l), Some(t)) = (num, n.text.as_mut()) {
        t.letter_spacing = l;
      }
    }
    "paragraphSpacing" => {
      if let (Some(p), Some(t)) = (num, n.text.as_mut()) {
        t.paragraph_spacing = p.max(0.0);
      }
    }
    "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "counterGap" => {
      if let (Some(p), Some(l)) = (num, n.layout.as_mut()) {
        match prop {
          "paddingTop" => l.padding_top = p,
          "paddingRight" => l.padding_right = p,
          "paddingBottom" => l.padding_bottom = p,
          "paddingLeft" => l.padding_left = p,
          _ => l.counter_gap = p,
        }
      }
    }
    "characters" => {
      if let (Some(s), Some(t)) = (v.as_str(), n.text.as_mut()) {
        if t.characters != s {
          t.runs = crate::text::remap_runs(&t.characters, s, &t.runs);
          t.characters = s.to_string();
        }
      }
    }
    "visible" => {
      if let Some(b) = v.as_bool() {
        n.visible = b;
      }
    }
    _ => {}
  }
}

/// Looks variables up and finds the modes layers see, without the per-call string building and
/// ancestor `String` clones of [`find`] / [`mode_for`] (same answers, built once per pass).
pub(crate) struct Resolver<'a> {
  doc: &'a Document,
  /// Variable id, name and `Collection/name` → (collection, variable) index. Filled in
  /// `find`'s iteration order with `or_insert`, so the first match wins exactly as in `find`.
  by_key: HashMap<std::borrow::Cow<'a, str>, (usize, usize)>,
  /// Mode a layer sees per collection (index), memoised for every layer walked on the way.
  modes: HashMap<(&'a str, usize), Option<&'a str>>,
}

impl<'a> Resolver<'a> {
  pub(crate) fn new(doc: &'a Document) -> Self {
    use std::borrow::Cow;
    let mut by_key: HashMap<Cow<'a, str>, (usize, usize)> = HashMap::new();
    for (ci, c) in doc.variables.iter().enumerate() {
      for (vi, v) in c.variables.iter().enumerate() {
        by_key.entry(Cow::Borrowed(v.id.as_str())).or_insert((ci, vi));
        by_key.entry(Cow::Borrowed(v.name.as_str())).or_insert((ci, vi));
        by_key.entry(Cow::Owned(format!("{}/{}", c.name, v.name))).or_insert((ci, vi));
      }
    }
    Resolver {
      doc,
      by_key,
      modes: HashMap::new(),
    }
  }

  /// [`mode_for`]: nearest ancestor override that names a mode of the collection, else its default.
  pub(crate) fn mode(&mut self, node: &'a str, ci: usize) -> Option<&'a str> {
    let doc = self.doc;
    let coll: &'a Collection = &doc.variables[ci];
    let mut walked: Vec<&'a str> = Vec::new();
    let mut cur = node;
    let found = loop {
      if let Some(m) = self.modes.get(&(cur, ci)) {
        break *m;
      }
      // A missing layer in the chain ends the walk with no mode, as `mode_for` does.
      let Some(n) = doc.get(cur) else { break None };
      walked.push(cur);
      if let Some(m) = n.variable_modes.get(&coll.id) {
        if coll.modes.iter().any(|x| &x.id == m) {
          break Some(m.as_str());
        }
      }
      match n.parent.as_deref() {
        Some(p) if walked.len() <= doc.nodes.len() => cur = p,
        Some(_) => break None,
        None => break coll.modes.first().map(|m| m.id.as_str()),
      }
    };
    for w in walked {
      self.modes.insert((w, ci), found);
    }
    found
  }

  /// [`resolve`]: a variable's value as seen by `node`, aliases followed.
  pub(crate) fn resolve(&mut self, node: &'a str, var: &str) -> Option<Value> {
    let doc = self.doc;
    let (mut ci, mut vi) = *self.by_key.get(var)?;
    for _ in 0..MAX_ALIAS_DEPTH {
      let c: &'a Collection = &doc.variables[ci];
      let v: &'a Variable = &c.variables[vi];
      let mode = self.mode(node, ci)?;
      let val = v
        .values
        .get(mode)
        .or_else(|| c.modes.first().and_then(|m| v.values.get(&m.id)))
        .or_else(|| v.values.values().next())?;
      match val.get("alias").and_then(|a| a.as_str()) {
        Some(next) => (ci, vi) = *self.by_key.get(next)?,
        None => return Some(val.clone()),
      }
    }
    None
  }
}

/// True when writing `v` into `prop` could change `n`. Only a cheap pre-filter for the common
/// properties (answering true is always safe: the caller compares the written copy anyway).
fn may_change(n: &crate::model::Node, prop: &str, v: &Value) -> bool {
  match prop {
    "fill" | "stroke" => {
      let Some(color) = v.as_str().map(crate::color::normalize) else {
        return false;
      };
      let paints = if prop == "fill" { &n.fills } else { &n.strokes };
      !matches!(paints.first(), Some(Paint::Solid { color: c, .. }) if *c == color)
    }
    _ => true,
  }
}

/// Resolves and writes the bindings of the layers in `ids` (a bound layer each), in two phases:
/// the values are read first, and a layer is cloned only when one of them would differ.
fn apply_ids(doc: &mut Document, ids: &[NodeId]) -> bool {
  let writes: Vec<(NodeId, Vec<(String, Value)>)> = {
    let doc: &Document = doc;
    let mut r = Resolver::new(doc);
    ids
      .iter()
      .filter_map(|id| {
        let n = doc.get(id)?;
        let values: Vec<(String, Value)> = n
          .bindings
          .iter()
          .filter_map(|(prop, var)| r.resolve(&n.id, var).map(|v| (prop.clone(), v)))
          .filter(|(prop, v)| may_change(n, prop, v))
          .collect();
        (!values.is_empty()).then(|| (id.clone(), values))
      })
      .collect()
  };
  let mut changed = false;
  for (id, values) in writes {
    let Some(before) = doc.get(&id) else { continue };
    let mut n = before.clone();
    for (prop, v) in &values {
      write_prop(&mut n, prop, v);
    }
    if n != *before {
      doc.nodes.insert(id, Arc::new(n));
      changed = true;
    }
  }
  changed
}

/// The layers that were added or changed from `base` to `doc`, and those whose own change can
/// alter what their descendants resolve (added, re-parented, or with other `variableModes`).
fn diff_layers(base: &Document, doc: &Document) -> (Vec<NodeId>, Vec<NodeId>) {
  let mut dirty: Vec<NodeId> = Vec::new();
  let mut context: Vec<NodeId> = Vec::new();
  for item in base.nodes.diff(&doc.nodes) {
    match item {
      imbl::ordmap::DiffItem::Add(k, _) => {
        dirty.push(k.clone());
        context.push(k.clone());
      }
      imbl::ordmap::DiffItem::Update { old: (_, o), new: (k, n) } => {
        dirty.push(k.clone());
        if o.parent != n.parent || o.variable_modes != n.variable_modes {
          context.push(k.clone());
        }
      }
      imbl::ordmap::DiffItem::Remove(..) => {}
    }
  }
  (dirty, context)
}

/// [`apply`] for a document that follows `base` (a fixed point of `normalize` + `apply`, as every
/// document the engine finished a change on is): only layers whose result can differ are
/// resolved, that is the layers that changed, the bound layers below a layer that was added,
/// moved or got other mode pins, and every bound layer when the variables themselves changed.
/// The full [`apply`] is the oracle for this.
pub fn apply_since(doc: &mut Document, base: &Document) -> bool {
  if doc.variables.is_empty() {
    return false;
  }
  let all = !crate::model::arcs_eq(&doc.variables, &base.variables);
  let mut ids: Vec<NodeId> = Vec::new();
  if all {
    ids.extend(doc.nodes.values().filter(|n| !n.bindings.is_empty()).map(|n| n.id.clone()));
  } else {
    let (dirty, context) = diff_layers(base, doc);
    ids.extend(dirty.into_iter().filter(|id| doc.get(id).is_some_and(|n| !n.bindings.is_empty())));
    // The bound layers below a layer whose own context changed (one walk over the union).
    let mut seen: HashSet<&str> = HashSet::new();
    let mut stack: Vec<&str> = context.iter().map(|s| s.as_str()).collect();
    while let Some(cur) = stack.pop() {
      let Some(n) = doc.get(cur) else { continue };
      if !seen.insert(cur) {
        continue;
      }
      if !n.bindings.is_empty() {
        ids.push(n.id.clone());
      }
      stack.extend(n.children.iter().map(|c| c.as_str()));
    }
    ids.sort();
    ids.dedup();
  }
  apply_ids(doc, &ids)
}

/// [`normalize`] for a document that follows `base` (already normalized): only changed layers can
/// hold a name or a stale mode, unless the variables themselves changed.
pub fn normalize_since(doc: &mut Document, base: &Document) {
  if doc.variables.is_empty() {
    return;
  }
  if !crate::model::arcs_eq(&doc.variables, &base.variables) {
    return normalize(doc);
  }
  let (dirty, _) = diff_layers(base, doc);
  let candidates: Vec<NodeId> = dirty
    .into_iter()
    .filter(|id| doc.get(id).is_some_and(|n| !n.bindings.is_empty() || !n.variable_modes.is_empty()))
    .collect();
  if candidates.is_empty() {
    return;
  }
  let ids = names_to_fix(doc, candidates.iter().filter_map(|id| doc.get(id)));
  normalize_ids(doc, ids);
}

/// Rewrites the variable and mode names in a layer patch (`bindings`, `variableModes`) to ids, the way
/// `normalize` does for the layer afterwards. An instance override records the patch as it is, and
/// a name left in it would be dropped as dangling by the next prune.
pub fn resolve_names_in_patch(doc: &Document, p: &mut Value) {
  if let Some(Value::Object(b)) = p.get_mut("bindings") {
    let is_id = |s: &str| doc.variables.iter().any(|c| c.variables.iter().any(|v| v.id == s));
    for v in b.values_mut() {
      // A string that is already a variable id stays as it is, even if another variable is named
      // like it (as `normalize` leaves id-only layers alone).
      if v.as_str().is_some_and(is_id) {
        continue;
      }
      if let Some((_, var)) = v.as_str().and_then(|s| find(doc, s)) {
        *v = json!(var.id);
      }
    }
  }
  if let Some(Value::Object(m)) = p.get_mut("variableModes") {
    let old = std::mem::take(m);
    // Id-keyed entries first, then the ones given by name, which replace them (as `normalize` does).
    let by_id = |c: &str| doc.variables.iter().any(|x| x.id == c);
    for (c, v) in old.iter().filter(|(c, _)| by_id(c) || !doc.variables.iter().any(|x| x.name == **c)) {
      m.insert(c.clone(), v.clone());
    }
    for (c, v) in old.iter().filter(|(c, _)| !by_id(c)) {
      if let (Some(coll), Some(mode)) = (doc.variables.iter().find(|x| x.name == *c), v.as_str()) {
        let id = coll
          .modes
          .iter()
          .find(|x| x.id == mode || x.name == mode)
          .map(|x| x.id.clone())
          .unwrap_or_else(|| mode.to_string());
        m.insert(coll.id.clone(), json!(id));
      }
    }
  }
}

/// Property bindings a direct edit replaces (editing a bound fill detaches its variable).
/// Returns what it removed per layer, so a layer inside an instance can record the detach.
pub fn unbind_for_patch(doc: &mut Document, ids: &[NodeId], patch: &Value) -> Vec<(NodeId, Vec<String>)> {
  let mut removed: Vec<(NodeId, Vec<String>)> = Vec::new();
  let Some(obj) = patch.as_object() else { return removed };
  let mut props: Vec<&str> = Vec::new();
  for (k, v) in obj {
    match k.as_str() {
      "fills" => props.push("fill"),
      "strokes" => props.push("stroke"),
      "cornerRadius" | "cornerRadii" => props.push("cornerRadius"),
      "opacity" => props.push("opacity"),
      "width" => props.push("width"),
      "height" => props.push("height"),
      "strokeWeight" => props.push("strokeWeight"),
      "visible" => props.push("visible"),
      // A style replaces the variable too (binding one drops the style).
      "fillStyle" if v.is_string() => props.push("fill"),
      "strokeStyle" if v.is_string() => props.push("stroke"),
      "layout" => {
        if v.get("gap").is_some() {
          props.push("gap");
        }
        if v.get("counterGap").is_some() {
          props.push("counterGap");
        }
        for side in ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] {
          if v.get(side).is_some() {
            props.push("padding");
            props.push(side);
          }
        }
      }
      "text" => {
        if v.get("fontSize").is_some() {
          props.push("fontSize");
        }
        if v.get("characters").is_some() {
          props.push("characters");
        }
        for k in ["fontFamily", "fontWeight", "lineHeight", "letterSpacing", "paragraphSpacing"] {
          if v.get(k).is_some() {
            props.push(k);
          }
        }
      }
      _ => {}
    }
  }
  // A prop the patch itself binds keeps that binding.
  props.retain(|p| !patch["bindings"][*p].is_string());
  if props.is_empty() {
    return removed;
  }
  for id in ids {
    let gone: Vec<String> = match doc.get(id) {
      Some(n) => props
        .iter()
        .filter(|p| n.bindings.contains_key(**p))
        .map(|p| p.to_string())
        .collect(),
      None => continue,
    };
    if gone.is_empty() {
      continue;
    }
    if let Some(n) = doc.get_mut(id) {
      for p in &gone {
        n.bindings.remove(p);
      }
    }
    removed.push((id.clone(), gone));
  }
  removed
}

/// The merge patch that records a detach on an instance layer: the binding goes, and the value
/// the variable painted stays (so a mode change or an edit of the main doesn't move it).
pub fn detach_patch(node: &crate::model::Node, props: &[String]) -> Value {
  let whole = serde_json::to_value(node).unwrap_or(Value::Null);
  let mut out = serde_json::Map::new();
  let mut bindings = serde_json::Map::new();
  for p in props {
    bindings.insert(p.clone(), Value::Null);
    let paths: Vec<Vec<&str>> = match p.as_str() {
      "fill" => vec![vec!["fills"]],
      "stroke" => vec![vec!["strokes"]],
      "cornerRadius" => vec![vec!["cornerRadius"], vec!["cornerRadii"]],
      "opacity" | "width" | "height" | "strokeWeight" | "visible" => vec![vec![p.as_str()]],
      "gap" | "counterGap" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" => {
        vec![vec!["layout", p.as_str()]]
      }
      "padding" => ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]
        .iter()
        .map(|k| vec!["layout", *k])
        .collect(),
      "fontSize" | "fontFamily" | "fontWeight" | "lineHeight" | "letterSpacing" | "paragraphSpacing" | "characters" => {
        vec![vec!["text", p.as_str()]]
      }
      _ => Vec::new(),
    };
    for path in paths {
      let Some(v) = path.iter().try_fold(&whole, |b, k| b.get(*k)) else {
        continue;
      };
      let mut cur = &mut out;
      for k in &path[..path.len() - 1] {
        cur = cur
          .entry(k.to_string())
          .or_insert_with(|| Value::Object(Default::default()))
          .as_object_mut()
          .unwrap();
      }
      cur.insert(path[path.len() - 1].to_string(), v.clone());
    }
  }
  out.insert("bindings".into(), Value::Object(bindings));
  Value::Object(out)
}

/// Binds (or, with None, detaches) one property of a layer. A fill or stroke bound to a
/// variable lets go of its colour style (one source per paint). On a layer inside an instance
/// the change is recorded as an override, so it survives edits of the main and mode changes.
pub fn set_binding(doc: &mut Document, id: &str, prop: &str, var: Option<&str>) -> Result<(), String> {
  let n = doc.get_mut(id).ok_or_else(|| format!("no node {id}"))?;
  let mut patch = serde_json::Map::new();
  match var {
    Some(v) => {
      n.bindings.insert(prop.to_string(), v.to_string());
      patch.insert("bindings".into(), json!({ prop: v }));
      if prop == "fill" && n.fill_style.take().is_some() {
        patch.insert("fillStyle".into(), Value::Null);
      }
      if prop == "stroke" && n.stroke_style.take().is_some() {
        patch.insert("strokeStyle".into(), Value::Null);
      }
    }
    None => {
      if n.bindings.remove(prop).is_none() {
        return Ok(());
      }
      if let Value::Object(m) = detach_patch(n, &[prop.to_string()]) {
        patch = m;
      }
    }
  }
  crate::components::record_override(doc, id, &Value::Object(patch));
  Ok(())
}

/// Drops bindings and mode overrides that point at variables, collections or modes that no longer exist.
pub fn prune(doc: &mut Document) {
  let vars: HashSet<String> = doc
    .variables
    .iter()
    .flat_map(|c| c.variables.iter().map(|v| v.id.clone()))
    .collect();
  let modes: HashMap<String, HashSet<String>> = doc
    .variables
    .iter()
    .map(|c| (c.id.clone(), c.modes.iter().map(|m| m.id.clone()).collect()))
    .collect();
  let mode_ok = |c: &String, m: &String| modes.get(c).is_some_and(|ms| ms.contains(m));
  let stale = |n: &crate::model::Node| {
    n.bindings.values().any(|v| !vars.contains(v.as_str())) || n.variable_modes.iter().any(|(c, m)| !mode_ok(c, m))
  };
  doc.update_where(stale, |n| {
    n.bindings.retain(|_, v| vars.contains(v.as_str()));
    n.variable_modes.retain(|c, m| mode_ok(c, m));
  });
}

/// CSS custom property name for a variable ("Colors/Primary 500" → `--colors-primary-500`).
pub fn css_name(c: &Collection, v: &Variable) -> String {
  let _ = c;
  format!("--{}", slug(&v.name))
}

pub fn slug(s: &str) -> String {
  let mut out = String::new();
  for ch in s.chars() {
    if ch.is_ascii_alphanumeric() {
      out.push(ch.to_ascii_lowercase());
    } else if !out.ends_with('-') && !out.is_empty() {
      out.push('-');
    }
  }
  out.trim_end_matches('-').to_string()
}

fn css_value(doc: &Document, c: &Collection, v: &Variable, mode: &str) -> Option<String> {
  let val = v.values.get(mode).or_else(|| c.modes.first().and_then(|m| v.values.get(&m.id)))?;
  if let Some(alias) = val.get("alias").and_then(|a| a.as_str()) {
    let (ac, av) = find(doc, alias)?;
    return Some(format!("var({})", css_name(ac, av)));
  }
  Some(match v.kind {
    VarKind::Color => crate::color::css_with_opacity(&crate::color::normalize(val.as_str()?), 1.0),
    VarKind::Number => crate::geom::fmt(val.as_f64()?),
    VarKind::String => format!("\"{}\"", crate::render::css_string(val.as_str()?, '"')),
    VarKind::Boolean => (if val.as_bool()? { "1" } else { "0" }).to_string(),
  })
}

/// CSS name of the first number variable in the document, for the examples in the exported
/// docs (`None` when there isn't one).
pub fn first_number_token(doc: &Document) -> Option<String> {
  doc.variables.iter().find_map(|c| {
    c.variables
      .iter()
      .find(|v| v.kind == VarKind::Number && !slug(&v.name).is_empty())
      .map(|v| css_name(c, v))
  })
}

/// `:root` block for default modes and a `[data-<collection>="<mode>"]` block per other mode.
pub fn tokens_css(doc: &Document) -> String {
  let mut out = String::from("/* Design tokens generated from Designotron variables.\n");
  match first_number_token(doc) {
    Some(name) => out.push_str(&format!(
      "   Number tokens are unitless, like Figma's: use calc(var({name}) * 1px) for lengths. */\n"
    )),
    None => out.push_str("   Number tokens are unitless, like Figma's: multiply by 1px to use one as a length. */\n"),
  }
  out.push_str(":root {\n");
  for c in &doc.variables {
    let Some(default) = c.modes.first() else { continue };
    for v in &c.variables {
      if let Some(val) = css_value(doc, c, v, &default.id) {
        out.push_str(&format!("  {}: {val};\n", css_name(c, v)));
      }
    }
  }
  out.push_str("}\n");
  for c in &doc.variables {
    // Every mode gets a block (the default too, so it can be re-selected inside another mode).
    for m in &c.modes {
      out.push_str(&format!("\n[{}=\"{}\"] {{\n", mode_attr(doc, c), mode_slug(c, m)));
      for v in &c.variables {
        if let Some(val) = css_value(doc, c, v, &m.id) {
          out.push_str(&format!("  {}: {val};\n", css_name(c, v)));
        }
      }
      out.push_str("}\n");
    }
  }
  out
}

/// HTML attribute that switches a collection's mode in generated code: `data-<name>`, with `-2`,
/// `-3` for later collections whose names slug the same (or have no ASCII letters: `collection`).
pub fn mode_attr(doc: &Document, c: &Collection) -> String {
  let mut taken: Vec<String> = Vec::new();
  for x in &doc.variables {
    let name = slug(&x.name);
    let base = format!("data-{}", if name.is_empty() { "collection" } else { &name });
    let mut attr = base.clone();
    let mut i = 2;
    while taken.contains(&attr) {
      attr = format!("{base}-{i}");
      i += 1;
    }
    if x.id == c.id {
      return attr;
    }
    taken.push(attr);
  }
  format!("data-{}", slug(&c.name))
}

/// A mode's value in that attribute: its slug, or `mode-N` when the name has no ASCII letters.
/// A name that slugs like an earlier mode of the collection gets `-2`, `-3` (by position), so two
/// modes called "Dark" don't write the same selector.
pub fn mode_slug(c: &Collection, m: &VarMode) -> String {
  let base = |i: usize, x: &VarMode| {
    let name = slug(&x.name);
    if name.is_empty() {
      format!("mode-{}", i + 1)
    } else {
      name
    }
  };
  let mut taken: Vec<String> = Vec::new();
  for (i, x) in c.modes.iter().enumerate() {
    let out = unique_name(&base(i, x), &taken);
    if x.id == m.id {
      return out;
    }
    taken.push(out);
  }
  base(0, m)
}

/// A number variable's value in its collection's default mode, following aliases.
pub fn default_number(doc: &Document, c: &Collection, v: &Variable) -> Option<f64> {
  let (mut c, mut v) = (c, v);
  for _ in 0..16 {
    let m = c.modes.first()?;
    let val = v.values.get(&m.id)?;
    match val.get("alias").and_then(|a| a.as_str()) {
      Some(a) => (c, v) = find(doc, a)?,
      None => return val.as_f64(),
    }
  }
  None
}

/// A DTCG name part: no `.`, braces or leading `$` (they mean something in references and keys).
fn dtcg_part(part: &str) -> String {
  let p: String = part
    .chars()
    .filter(|c| !matches!(c, '{' | '}'))
    .map(|c| if c == '.' { '_' } else { c })
    .collect();
  let p = p.trim().trim_start_matches('$').to_string();
  if p.is_empty() {
    "_".into()
  } else {
    p
  }
}

/// `base`, or `base-2`, `base-3` ... until `taken` doesn't hold it.
fn unique_name(base: &str, taken: &[String]) -> String {
  let mut out = base.to_string();
  let mut k = 2;
  while taken.contains(&out) {
    out = format!("{base}-{k}");
    k += 1;
  }
  out
}

/// The variables as a W3C design tokens file: one group per collection, `/` in a name nesting
/// groups, `$type` and `$value` from the default mode, aliases as `{group.token}` references. The
/// other modes' values (and what the DTCG format has no field for) sit in a `com.designotron`
/// extension: `modes` on the token, mode names on the collection group.
pub fn tokens_json(doc: &Document) -> Value {
  use serde_json::Map;
  const EXT: &str = "com.designotron";
  // Every token's path first, so aliases can point at tokens defined later.
  let mut paths: BTreeMap<String, Vec<String>> = BTreeMap::new();
  let mut taken: std::collections::HashSet<Vec<String>> = std::collections::HashSet::new();
  let mut coll_names: Vec<String> = Vec::new();
  for c in &doc.variables {
    let cname = unique_name(&dtcg_part(&c.name), &coll_names);
    coll_names.push(cname.clone());
    for v in &c.variables {
      let mut path = vec![cname.clone()];
      path.extend(v.name.split('/').map(str::trim).filter(|p| !p.is_empty()).map(dtcg_part));
      let base = path.clone();
      let mut k = 2;
      while taken.contains(&path) {
        path = base.clone();
        if let Some(last) = path.last_mut() {
          *last = format!("{last}-{k}");
        }
        k += 1;
      }
      taken.insert(path.clone());
      paths.insert(v.id.clone(), path);
    }
  }
  // A token whose path is also a group (`Space` next to `Space/2`) moves under `$root`.
  let groups: std::collections::HashSet<Vec<String>> = taken.iter().flat_map(|p| (1..p.len()).map(|n| p[..n].to_vec())).collect();
  for p in paths.values_mut() {
    if groups.contains(p) {
      p.push("$root".into());
    }
  }
  let value = |kind: VarKind, raw: &Value| -> Option<Value> {
    if let Some(a) = raw.get("alias").and_then(|a| a.as_str()) {
      let target = paths.get(&find(doc, a)?.1.id)?;
      return Some(Value::String(format!("{{{}}}", target.join("."))));
    }
    Some(match kind {
      VarKind::Color => json!(crate::color::normalize(raw.as_str()?)),
      VarKind::Number => {
        let f = raw.as_f64()?;
        if f.fract() == 0.0 && f.abs() < 1e15 {
          json!(f as i64)
        } else {
          json!(f)
        }
      }
      VarKind::String => json!(raw.as_str()?),
      VarKind::Boolean => json!(raw.as_bool()?),
    })
  };
  let mut root = Map::new();
  for (coll_index, (c, cname)) in doc.variables.iter().zip(&coll_names).enumerate() {
    let mut mode_names: Vec<String> = Vec::new();
    for m in &c.modes {
      let name = unique_name(&m.name, &mode_names);
      mode_names.push(name);
    }
    let mut group = Map::new();
    group.insert(
      "$extensions".into(),
      json!({ EXT: { "id": c.id, "name": c.name, "modes": mode_names, "index": coll_index } }),
    );
    let Some(default) = c.modes.first() else {
      root.insert(cname.clone(), Value::Object(group));
      continue;
    };
    for (var_index, v) in c.variables.iter().enumerate() {
      let raw = v
        .values
        .get(&default.id)
        .or_else(|| c.modes.iter().find_map(|m| v.values.get(&m.id)));
      let Some(val) = raw.and_then(|r| value(v.kind, r)) else { continue };
      let path = &paths[&v.id];
      let mut tok = Map::new();
      match v.kind {
        VarKind::Color => tok.insert("$type".into(), json!("color")),
        VarKind::Number => tok.insert("$type".into(), json!("number")),
        _ => None,
      };
      tok.insert("$value".into(), val);
      if !v.description.is_empty() {
        tok.insert("$description".into(), json!(v.description));
      }
      let mut ext = Map::new();
      ext.insert("id".into(), json!(v.id));
      // Keys of a JSON object come back sorted, so the order is written down.
      ext.insert("index".into(), json!(var_index));
      let shown: Vec<&str> = path[1..].iter().filter(|p| *p != "$root").map(String::as_str).collect();
      if shown.join("/") != v.name {
        ext.insert("name".into(), json!(v.name));
      }
      match v.kind {
        VarKind::String => ext.insert("type".into(), json!("string")),
        VarKind::Boolean => ext.insert("type".into(), json!("boolean")),
        _ => None,
      };
      let mut modes = Map::new();
      for (m, name) in c.modes.iter().zip(&mode_names).skip(1) {
        if let Some(mv) = v.values.get(&m.id).and_then(|r| value(v.kind, r)) {
          modes.insert(name.clone(), mv);
        }
      }
      if !modes.is_empty() {
        ext.insert("modes".into(), Value::Object(modes));
      }
      if !v.scopes.is_empty() {
        ext.insert("scopes".into(), json!(v.scopes));
      }
      tok.insert("$extensions".into(), json!({ EXT: Value::Object(ext) }));
      let Some((leaf, dirs)) = path[1..].split_last() else { continue };
      insert_token(&mut group, dirs, leaf, tok);
    }
    root.insert(cname.clone(), Value::Object(group));
  }
  Value::Object(root)
}

/// Puts a token at `dirs/leaf`, creating the groups on the way.
fn insert_token(group: &mut serde_json::Map<String, Value>, dirs: &[String], leaf: &str, tok: serde_json::Map<String, Value>) {
  match dirs.split_first() {
    None => {
      group.insert(leaf.to_string(), Value::Object(tok));
    }
    Some((d, rest)) => {
      if let Value::Object(g) = group.entry(d.clone()).or_insert_with(|| Value::Object(serde_json::Map::new())) {
        insert_token(g, rest, leaf, tok);
      }
    }
  }
}

/// `tokens_json` as the text of a `tokens.json` file.
pub fn tokens_json_text(doc: &Document) -> String {
  let mut s = serde_json::to_string_pretty(&tokens_json(doc)).unwrap_or_else(|_| "{}".into());
  s.push('\n');
  s
}

/// Summary for Claude: collections, modes and variables with their values by mode name.
pub fn summary(doc: &Document) -> Value {
  json!(doc
    .variables
    .iter()
    .map(|c| json!({
      "id": c.id,
      "name": c.name,
      "modes": c.modes.iter().map(|m| m.name.clone()).collect::<Vec<_>>(),
      "variables": c.variables.iter().map(|v| json!({
        "id": v.id,
        "name": v.name,
        "type": v.kind,
        "scopes": v.scopes,
        "values": c.modes.iter().map(|m| (m.name.clone(), v.values.get(&m.id).cloned().unwrap_or(Value::Null))).collect::<serde_json::Map<_, _>>(),
      })).collect::<Vec<_>>(),
    }))
    .collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::engine::{Command, Engine};
  use crate::model::NodeType;
  use crate::text::HeuristicMeasurer;

  fn var(id: &str, kind: VarKind, v: Value) -> Variable {
    Variable {
      id: id.into(),
      name: id.into(),
      kind,
      values: [("m".to_string(), v)].into_iter().collect(),
      ..Default::default()
    }
  }

  fn coll(vars: Vec<Variable>) -> Collection {
    Collection {
      id: "c".into(),
      name: "C".into(),
      modes: vec![VarMode {
        id: "m".into(),
        name: "m".into(),
      }],
      variables: vars.into_iter().map(Arc::new).collect(),
    }
  }

  fn engine() -> Engine {
    Engine::new(Box::new(HeuristicMeasurer), 1)
  }

  fn id_of(v: Value) -> String {
    v["id"].as_str().unwrap().to_string()
  }

  #[test]
  fn alias_cycles_are_refused() {
    let mut e = engine();
    let ok = coll(vec![
      var("a", VarKind::Number, json!(1)),
      var("b", VarKind::Number, json!({ "alias": "a" })),
    ]);
    e.dispatch(Command::SetVariables {
      collections: vec![ok.clone()],
    })
    .unwrap();
    let mut cyc = ok;
    Arc::make_mut(&mut cyc.variables[0])
      .values
      .insert("m".into(), json!({ "alias": "b" }));
    let err = e.dispatch(Command::SetVariables { collections: vec![cyc] }).unwrap_err();
    assert!(err.contains("alias cycle"), "{err}");
    let mut selfref = coll(vec![var("a", VarKind::Number, json!({ "alias": "a" }))]);
    assert!(validate(std::slice::from_ref(&selfref), &[]).is_err());
    Arc::make_mut(&mut selfref.variables[0]).scopes = vec!["nope".into()];
    assert!(validate(&[selfref], &[]).unwrap_err().contains("scope"));
    // The document keeps the last valid set.
    assert_eq!(e.doc.variables[0].variables[0].values["m"], json!(1));
  }

  #[test]
  fn scope_filter_lists_only_matching_variables() {
    let mut e = engine();
    let mut gap = var("gap", VarKind::Number, json!(8));
    gap.scopes = vec!["gap".into()];
    let mut radius = var("radius", VarKind::Number, json!(4));
    radius.scopes = vec!["cornerRadius".into(), "size".into()];
    let any = var("any", VarKind::Number, json!(1));
    let colour = var("brand", VarKind::Color, json!("#FF0000"));
    e.dispatch(Command::SetVariables {
      collections: vec![coll(vec![gap, radius, any, colour])],
    })
    .unwrap();
    let names = |p: &str| bindable(&e.doc, p).iter().map(|(_, v)| v.id.clone()).collect::<Vec<_>>();
    assert_eq!(names("gap"), ["gap", "any"]);
    assert_eq!(names("paddingLeft"), ["gap", "any"], "padding is covered by the gap scope");
    assert_eq!(names("cornerRadius"), ["radius", "any"]);
    assert_eq!(names("width"), ["radius", "any"]);
    assert_eq!(names("fill"), ["brand"]);
    let bad = Variable {
      scopes: vec!["bogus".into()],
      ..var("x", VarKind::Number, json!(1))
    };
    let err = e
      .dispatch(Command::SetVariables {
        collections: vec![coll(vec![bad])],
      })
      .unwrap_err();
    assert!(err.contains("scope"), "{err}");
  }

  #[test]
  fn new_bindings_apply_and_follow_modes() {
    let mut e = engine();
    let t = id_of(
      e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "Hi".into(),
        parent: None,
      })
      .unwrap(),
    );
    let f = id_of(
      e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 0.0,
        y: 100.0,
        width: 50.0,
        height: 50.0,
        parent: None,
      })
      .unwrap(),
    );
    e.dispatch(Command::Update {
      ids: vec![f.clone()],
      patch: json!({ "layout": { "direction": "horizontal" } }),
    })
    .unwrap();
    let mut c = coll(vec![
      var("lh", VarKind::Number, json!(30)),
      var("pl", VarKind::Number, json!(7)),
      var("fam", VarKind::String, json!("Georgia")),
      var("wt", VarKind::Number, json!(640)),
      var("cg", VarKind::Number, json!(3)),
    ]);
    c.modes.push(VarMode {
      id: "m2".into(),
      name: "Big".into(),
    });
    for v in c.variables.iter_mut().map(Arc::make_mut) {
      let big = match v.id.as_str() {
        "fam" => json!("Times"),
        "wt" => json!(900),
        _ => json!(v.values["m"].as_f64().unwrap() * 2.0),
      };
      v.values.insert("m2".into(), big);
    }
    e.dispatch(Command::SetVariables { collections: vec![c] }).unwrap();
    for (id, prop, var) in [
      (&t, "lineHeight", "lh"),
      (&t, "fontFamily", "fam"),
      (&t, "fontWeight", "wt"),
      (&f, "paddingLeft", "pl"),
      (&f, "counterGap", "cg"),
    ] {
      e.dispatch(Command::BindVariable {
        ids: vec![id.clone()],
        property: prop.into(),
        variable: Some(var.into()),
      })
      .unwrap();
    }
    let read = |e: &Engine| {
      let tp = e.doc.get(&t).unwrap().text.clone().unwrap();
      let l = e.doc.get(&f).unwrap().layout.clone().unwrap();
      (
        tp.line_height,
        tp.font_family,
        tp.font_weight,
        l.padding_left,
        l.padding_top,
        l.counter_gap,
      )
    };
    let (lh, fam, wt, pl, pt, cg) = read(&e);
    assert_eq!((lh, fam.as_str(), wt, pl, cg), (Some(30.0), "Georgia", 600, 7.0, 3.0));
    assert_eq!(pt, 10.0, "the other sides are untouched");
    e.dispatch(Command::SetVariableMode {
      ids: vec![t.clone(), f.clone()],
      collection: "c".into(),
      mode: Some("m2".into()),
    })
    .unwrap();
    let (lh, fam, wt, pl, _, cg) = read(&e);
    assert_eq!((lh, fam.as_str(), wt, pl, cg), (Some(60.0), "Times", 900, 14.0, 6.0));
    // A hand edit of the bound property unbinds only that property.
    e.dispatch(Command::Update {
      ids: vec![f.clone()],
      patch: json!({ "layout": { "paddingLeft": 1 } }),
    })
    .unwrap();
    let n = e.doc.get(&f).unwrap();
    assert!(!n.bindings.contains_key("paddingLeft") && n.bindings.contains_key("counterGap"));
  }

  #[test]
  fn only_cycles_through_changed_variables_and_overlong_chains_are_refused() {
    let alias = |to: &str| json!({ "alias": to });
    // A cycle that merged in (a <-> b) doesn't block an edit of an unrelated variable.
    let bad = coll(vec![
      var("a", VarKind::Number, alias("b")),
      var("b", VarKind::Number, alias("a")),
      var("x", VarKind::Number, json!(1)),
    ]);
    let mut next = bad.clone();
    Arc::make_mut(&mut next.variables[2]).values.insert("m".into(), json!(2));
    assert!(validate(std::slice::from_ref(&next), &[Arc::new(bad.clone())]).is_ok());
    // Touching one of the loop's variables is refused.
    let mut touched = bad.clone();
    Arc::make_mut(&mut touched.variables[0]).values.insert("m".into(), alias("b"));
    Arc::make_mut(&mut touched.variables[1]).values.insert("m".into(), alias("a"));
    Arc::make_mut(&mut touched.variables[0]).values.insert("m2".into(), json!(1));
    assert!(validate(&[touched], &[Arc::new(bad.clone())]).is_err());
    // A chain `resolve` can't follow is refused; the longest one it can is fine.
    let chain = |n: usize| {
      let mut vars = vec![var("v0", VarKind::Number, json!(1))];
      for i in 1..=n {
        vars.push(var(&format!("v{i}"), VarKind::Number, alias(&format!("v{}", i - 1))));
      }
      coll(vars)
    };
    assert!(validate(&[chain(MAX_ALIAS_DEPTH - 1)], &[]).is_ok());
    assert!(validate(&[chain(MAX_ALIAS_DEPTH)], &[]).unwrap_err().contains("alias chain"));
    // ...and what validate accepts really resolves.
    let mut e = engine();
    let n = MAX_ALIAS_DEPTH - 1;
    e.dispatch(Command::SetVariables {
      collections: vec![chain(n)],
    })
    .unwrap();
    let f = id_of(
      e.dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
        parent: None,
      })
      .unwrap(),
    );
    assert_eq!(resolve(&e.doc, &f, &format!("v{n}")), Some(json!(1)));
  }

  #[test]
  fn duplicate_names_and_wrong_typed_values_are_refused_but_old_ones_dont_block() {
    let mut e = engine();
    let named = |id: &str, name: &str, kind: VarKind, v: Value| Variable {
      name: name.into(),
      ..var(id, kind, v)
    };
    let set = |e: &mut Engine, vars: Vec<Variable>| {
      e.dispatch(Command::SetVariables {
        collections: vec![coll(vars)],
      })
    };
    set(
      &mut e,
      vec![
        named("a", "Gray/0", VarKind::Color, json!("#FFFFFF")),
        named("b", "Gray/1", VarKind::Color, json!("#EEEEEE")),
      ],
    )
    .unwrap();
    // Renaming onto another variable's name.
    let err = set(
      &mut e,
      vec![
        named("a", "Gray/0", VarKind::Color, json!("#FFFFFF")),
        named("b", "Gray/0", VarKind::Color, json!("#EEEEEE")),
      ],
    )
    .unwrap_err();
    assert_eq!(err, "Gray/0 already exists in C");
    // A new variable with a taken name.
    assert!(set(
      &mut e,
      vec![
        named("a", "Gray/0", VarKind::Color, json!("#FFFFFF")),
        named("b", "Gray/1", VarKind::Color, json!("#EEEEEE")),
        named("c", "Gray/1", VarKind::Color, json!("#000000"))
      ]
    )
    .is_err());
    // Values must fit the type.
    let err = set(
      &mut e,
      vec![
        named("a", "Gray/0", VarKind::Color, json!("banana")),
        named("b", "Gray/1", VarKind::Color, json!("#EEEEEE")),
      ],
    )
    .unwrap_err();
    assert!(err.contains("Gray/0") && err.contains("banana"), "{err}");
    assert!(set(
      &mut e,
      vec![
        named("a", "Gray/0", VarKind::Color, json!(12)),
        named("b", "Gray/1", VarKind::Color, json!("#EEEEEE"))
      ]
    )
    .is_err());
    assert!(set(&mut e, vec![named("n", "N", VarKind::Number, json!("12"))]).is_err());
    // Old invalid state (duplicate names, wrong types) doesn't block edits of other variables.
    let bad = vec![
      named("a", "Dup", VarKind::Color, json!("banana")),
      named("b", "Dup", VarKind::Number, json!(1)),
      named("c", "Fine", VarKind::Number, json!(1)),
    ];
    let old = vec![Arc::new(coll(bad.clone()))];
    assert!(validate(&old, &[]).is_err());
    let mut edited = bad;
    edited[2].values.insert("m".into(), json!(2));
    assert!(validate(&[coll(edited)], &old).is_ok());
    // The type check is the one the AI tool uses.
    assert_eq!(check_value(VarKind::Color, &json!("#fff")).unwrap(), json!("#FFFFFF"));
    assert!(check_value(VarKind::Boolean, &json!("yes"))
      .unwrap_err()
      .starts_with("expected true or false"));
  }

  #[test]
  fn values_of_removed_modes_are_dropped() {
    let mut e = engine();
    let mut v = var("v", VarKind::Number, json!(1));
    v.values.insert("gone".into(), json!(2));
    e.dispatch(Command::SetVariables {
      collections: vec![coll(vec![v])],
    })
    .unwrap();
    let values = &e.doc.variables[0].variables[0].values;
    assert_eq!(values.keys().collect::<Vec<_>>(), ["m"]);
  }

  #[test]
  fn normalize_leaves_id_only_documents_shared() {
    let mut e = engine();
    e.dispatch(Command::SetVariables {
      collections: vec![coll(vec![var("v", VarKind::Color, json!("#112233"))])],
    })
    .unwrap();
    let r = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
        parent: None,
      })
      .unwrap();
    let id = id_of(r);
    e.dispatch(Command::BindVariable {
      ids: vec![id.clone()],
      property: "fill".into(),
      variable: Some("v".into()),
    })
    .unwrap();
    e.dispatch(Command::SetVariableMode {
      ids: vec![id.clone()],
      collection: "c".into(),
      mode: Some("m".into()),
    })
    .unwrap();
    let before = e.doc.nodes.clone();
    let mut doc = e.doc.clone();
    normalize(&mut doc);
    assert!(doc.nodes.ptr_eq(&before), "an id-only document must not be rewritten");
    // A name is written, and only on that layer.
    e.doc.get_mut(&id).unwrap().bindings.insert("fill".into(), "C/v".into());
    let mut doc = e.doc.clone();
    normalize(&mut doc);
    assert_eq!(doc.get(&id).unwrap().bindings["fill"], "v");
  }

  #[test]
  fn error_messages_keep_the_case_of_names() {
    let mut e = engine();
    e.dispatch(Command::SetVariables {
      collections: vec![coll(vec![var("v", VarKind::Number, json!(1))])],
    })
    .unwrap();
    let id = id_of(
      e.dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
        parent: None,
      })
      .unwrap(),
    );
    let err = e
      .dispatch(Command::BindVariable {
        ids: vec![id],
        property: "fill".into(),
        variable: Some("v".into()),
      })
      .unwrap_err();
    assert!(err.contains("needs a color variable") && err.contains(", v is number"), "{err}");
  }

  fn named(id: &str, name: &str, kind: VarKind, vals: &[(&str, Value)]) -> Variable {
    Variable {
      id: id.into(),
      name: name.into(),
      kind,
      values: vals.iter().map(|(m, v)| ((*m).to_string(), v.clone())).collect(),
      ..Default::default()
    }
  }

  #[test]
  fn modes_with_the_same_name_get_distinct_slugs() {
    let c = Collection {
      id: "c".into(),
      name: "Theme".into(),
      modes: ["Dark", "Light", "Dark"]
        .iter()
        .enumerate()
        .map(|(i, n)| VarMode {
          id: format!("m{i}"),
          name: (*n).into(),
        })
        .collect(),
      variables: vec![],
    };
    let slugs: Vec<String> = c.modes.iter().map(|m| mode_slug(&c, m)).collect();
    assert_eq!(slugs, ["dark", "light", "dark-2"]);
  }

  #[test]
  fn tokens_json_is_dtcg_with_modes_in_an_extension() {
    let mut doc = crate::doc::new_document(&mut crate::doc::IdGen::new(1), "T");
    doc.variables = vec![
      Arc::new(Collection {
        id: "c1".into(),
        name: "Primitives".into(),
        modes: vec![VarMode {
          id: "m".into(),
          name: "Base".into(),
        }],
        variables: vec![
          named("black", "Black", VarKind::Color, &[("m", json!("#000"))]),
          named("space", "Space", VarKind::Number, &[("m", json!(4))]),
          named("space2", "Space/2", VarKind::Number, &[("m", json!(8))]),
          named("half", "Space/0.5", VarKind::Number, &[("m", json!(2))]),
          named("flag", "Flags/On", VarKind::Boolean, &[("m", json!(true))]),
        ]
        .into_iter()
        .map(Arc::new)
        .collect(),
      }),
      Arc::new(Collection {
        id: "c2".into(),
        name: "Theme".into(),
        modes: vec![
          VarMode {
            id: "l".into(),
            name: "Light".into(),
          },
          VarMode {
            id: "d".into(),
            name: "Dark".into(),
          },
        ],
        variables: vec![
          named(
            "bg",
            "Surface/Bg",
            VarKind::Color,
            &[("l", json!("#FFFFFF")), ("d", json!({ "alias": "black" }))],
          ),
          named(
            "glass",
            "Surface/Glass",
            VarKind::Color,
            &[("l", json!("#11223380")), ("d", json!("#112233"))],
          ),
          named("font", "Font", VarKind::String, &[("l", json!("Inter")), ("d", json!("Georgia"))]),
        ]
        .into_iter()
        .map(Arc::new)
        .collect(),
      }),
    ];
    let v = tokens_json(&doc);
    assert_eq!(
      v["Primitives"]["Black"],
      json!({
        "$type": "color",
        "$value": "#000000",
        "$extensions": { "com.designotron": { "id": "black", "index": 0 } }
      })
    );
    // A token that is also a group goes under $root, and an alias to it follows.
    assert_eq!(v["Primitives"]["Space"]["$root"]["$value"], 4.0);
    assert_eq!(v["Primitives"]["Space"]["2"]["$type"], "number");
    // A dot in a name becomes an underscore, the original is kept.
    assert_eq!(
      v["Primitives"]["Space"]["0_5"]["$extensions"]["com.designotron"]["name"],
      "Space/0.5"
    );
    // Nested groups, the default mode's value, an alias in another mode, the mode names.
    let bg = &v["Theme"]["Surface"]["Bg"];
    assert_eq!(bg["$value"], "#FFFFFF");
    assert_eq!(bg["$extensions"]["com.designotron"]["modes"]["Dark"], "{Primitives.Black}");
    assert_eq!(v["Theme"]["$extensions"]["com.designotron"]["modes"], json!(["Light", "Dark"]));
    // Translucent colours are 8-digit hex.
    assert_eq!(v["Theme"]["Surface"]["Glass"]["$value"], "#11223380");
    // Strings and booleans have no $type; the extension says what they are.
    assert!(v["Theme"]["Font"].get("$type").is_none());
    assert_eq!(v["Theme"]["Font"]["$extensions"]["com.designotron"]["type"], "string");
    assert_eq!(v["Primitives"]["Flags"]["On"]["$value"], true);
    // An alias as the default value is a reference too.
    Arc::make_mut(&mut Arc::make_mut(&mut doc.variables[1]).variables[0])
      .values
      .insert("l".into(), json!({ "alias": "space2" }));
    assert_eq!(tokens_json(&doc)["Theme"]["Surface"]["Bg"]["$value"], "{Primitives.Space.2}");
  }
}
