//! Design tokens on the clipboard. Copying layers also copies the variables (with their
//! collections, modes and alias targets) and styles they use, so pasting into another file
//! doesn't leave dangling ids. Paste merges them into the destination: a collection, mode,
//! variable or style that is already there (same id and name, else same name) is reused with the
//! destination's own values, and whatever is missing is added.
//!
//! References live in layers (`bindings`, `variable_modes`, the five `*_style` links) and in
//! instance overrides, which are JSON patches keyed in camelCase, nested through swap records.
//! One walker (`Visit`) serves all three jobs: collecting for copy, checking whether a paste needs
//! a merge, and rewriting ids afterwards.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{json, Value};

use crate::doc::IdGen;
use crate::model::{ColorStyle, Document, EffectStyle, GridStyle, Node, Styles, TextStyle};
use crate::variables::{Collection, VarKind, VarMode, Variable};

/// What a paste added to the destination, for the toast.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct Added {
  pub collections: usize,
  pub modes: usize,
  pub variables: usize,
  pub styles: usize,
}

impl Added {
  pub fn is_empty(&self) -> bool {
    *self == Added::default()
  }

  pub fn to_json(&self) -> Value {
    json!({ "collections": self.collections, "modes": self.modes, "variables": self.variables, "styles": self.styles })
  }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Kind {
  Color,
  Text,
  Effect,
  Grid,
}

/// The references one layer or override makes.
trait Visit {
  fn var(&mut self, id: &mut String);
  fn pin(&mut self, coll: &mut String, mode: &mut String);
  fn style(&mut self, kind: Kind, id: &mut String);
}

const OVERRIDE_STYLES: &[(&str, Kind)] = &[
  ("fillStyle", Kind::Color),
  ("strokeStyle", Kind::Color),
  ("textStyle", Kind::Text),
  ("effectStyle", Kind::Effect),
  ("gridStyle", Kind::Grid),
];

fn visit_node(n: &mut Node, v: &mut impl Visit) {
  for id in n.bindings.values_mut() {
    v.var(id);
  }
  if !n.variable_modes.is_empty() {
    n.variable_modes = std::mem::take(&mut n.variable_modes)
      .into_iter()
      .map(|(mut c, mut m)| {
        v.pin(&mut c, &mut m);
        (c, m)
      })
      .collect();
  }
  for (link, kind) in [
    (&mut n.fill_style, Kind::Color),
    (&mut n.stroke_style, Kind::Color),
    (&mut n.text_style, Kind::Text),
    (&mut n.effect_style, Kind::Effect),
    (&mut n.grid_style, Kind::Grid),
  ] {
    if let Some(id) = link {
      v.style(kind, id);
    }
  }
  if let Some(info) = &mut n.instance {
    for o in info.overrides.values_mut() {
      visit_override(o, v);
    }
  }
}

/// An override patch, and the overrides inside the swap record of a nested instance (any depth).
fn visit_override(o: &mut Value, v: &mut impl Visit) {
  let Some(obj) = o.as_object_mut() else { return };
  if let Some(Value::Object(b)) = obj.get_mut("bindings") {
    for val in b.values_mut() {
      if let Value::String(s) = val {
        v.var(s);
      }
    }
  }
  if let Some(Value::Object(m)) = obj.get_mut("variableModes") {
    let old = std::mem::take(m);
    for (mut c, val) in old {
      let Value::String(mut mode) = val else {
        m.insert(c, val);
        continue;
      };
      v.pin(&mut c, &mut mode);
      m.insert(c, Value::String(mode));
    }
  }
  for (key, kind) in OVERRIDE_STYLES {
    if let Some(Value::String(s)) = obj.get_mut(*key) {
      v.style(*kind, s);
    }
  }
  if let Some(Value::Object(swap)) = obj.get_mut(crate::components::SWAP_KEY) {
    if let Some(Value::Object(inner)) = swap.get_mut("overrides") {
      for o in inner.values_mut() {
        visit_override(o, v);
      }
    }
  }
}

fn visit_all(nodes: &mut [Node], comps: &mut [Node], v: &mut impl Visit) {
  for n in nodes.iter_mut().chain(comps.iter_mut()) {
    visit_node(n, v);
  }
}

// ---- copy ----------------------------------------------------------------------------------

/// The variables, collections (pinned modes) and styles some layers refer to.
#[derive(Default)]
pub struct Used {
  pub vars: HashSet<String>,
  pub colls: HashSet<String>,
  pub styles: HashSet<String>,
}

impl Visit for Used {
  fn var(&mut self, id: &mut String) {
    self.vars.insert(id.clone());
  }
  fn pin(&mut self, coll: &mut String, _: &mut String) {
    self.colls.insert(coll.clone());
  }
  fn style(&mut self, _: Kind, id: &mut String) {
    self.styles.insert(id.clone());
  }
}

/// Everything the layers of `nodes` refer to, read without touching them. Layers that make no
/// reference are skipped before anything is cloned (the walker takes `&mut`).
pub fn references<'a>(nodes: impl Iterator<Item = &'a Node>) -> Used {
  let mut used = Used::default();
  for n in nodes.filter(|n| has_references(n)) {
    visit_node(&mut n.clone(), &mut used);
  }
  used
}

fn has_references(n: &Node) -> bool {
  !n.bindings.is_empty()
    || !n.variable_modes.is_empty()
    || n.fill_style.is_some()
    || n.stroke_style.is_some()
    || n.text_style.is_some()
    || n.effect_style.is_some()
    || n.grid_style.is_some()
    || n.instance.as_ref().is_some_and(|i| !i.overrides.is_empty())
}

/// The `variables` and `styles` entries the copied layers need (nothing for layers without
/// tokens, so plain copies stay as small as before).
pub fn attach(doc: &Document, nodes: &mut [Node], comps: &mut [Node]) -> Vec<(&'static str, Value)> {
  let mut used = Used::default();
  visit_all(nodes, comps, &mut used);
  let mut out = Vec::new();
  if !used.vars.is_empty() || !used.colls.is_empty() {
    // Alias targets come along, whatever mode refers to them.
    let mut queue: Vec<String> = used.vars.iter().cloned().collect();
    while let Some(id) = queue.pop() {
      let Some(v) = doc.variables.iter().flat_map(|c| c.variables.iter()).find(|v| v.id == id) else {
        continue;
      };
      for target in v.values.values().filter_map(|x| x.get("alias").and_then(|a| a.as_str())) {
        if used.vars.insert(target.to_string()) {
          queue.push(target.to_string());
        }
      }
    }
    let collections: Vec<Collection> = doc
      .variables
      .iter()
      .filter(|c| used.colls.contains(&c.id) || c.variables.iter().any(|v| used.vars.contains(&v.id)))
      .map(|c| Collection {
        variables: c.variables.iter().filter(|v| used.vars.contains(&v.id)).cloned().collect(),
        ..c.clone()
      })
      .collect();
    if !collections.is_empty() {
      out.push(("variables", json!(collections)));
    }
  }
  if !used.styles.is_empty() {
    let keep = |id: &String| used.styles.contains(id);
    let styles = Styles {
      colors: doc.styles.colors.iter().filter(|s| keep(&s.id)).cloned().collect(),
      texts: doc.styles.texts.iter().filter(|s| keep(&s.id)).cloned().collect(),
      effects: doc.styles.effects.iter().filter(|s| keep(&s.id)).cloned().collect(),
      grids: doc.styles.grids.iter().filter(|s| keep(&s.id)).cloned().collect(),
    };
    if styles != Styles::default() {
      out.push(("styles", json!(styles)));
    }
  }
  out
}

// ---- paste ---------------------------------------------------------------------------------

/// Old id → destination id.
#[derive(Default)]
struct Remap {
  colls: HashMap<String, String>,
  /// (clipboard collection, clipboard mode) → destination mode.
  modes: HashMap<(String, String), String>,
  vars: HashMap<String, String>,
  styles: HashMap<(Kind, String), String>,
}

impl Visit for Remap {
  fn var(&mut self, id: &mut String) {
    if let Some(n) = self.vars.get(id.as_str()) {
      *id = n.clone();
    }
  }
  fn pin(&mut self, coll: &mut String, mode: &mut String) {
    if let Some(m) = self.modes.get(&(coll.clone(), mode.clone())) {
      *mode = m.clone();
    }
    if let Some(c) = self.colls.get(coll.as_str()) {
      *coll = c.clone();
    }
  }
  fn style(&mut self, kind: Kind, id: &mut String) {
    if let Some(n) = self.styles.get(&(kind, id.clone())) {
      *id = n.clone();
    }
  }
}

/// Decides whether every token the layers reference is already in the destination: the same id
/// with the same name (ids alone can collide between unrelated files). Inside a collection that
/// has the same id and name as the clipboard's (same origin), modes and variables match by id
/// alone, so renaming one doesn't make the paste add it again.
struct Present<'a> {
  dest_vars: HashMap<&'a str, (&'a Collection, &'a Variable)>,
  dest_colls: HashMap<&'a str, &'a Collection>,
  dest_styles: HashMap<(Kind, &'a str), &'a str>,
  clip_vars: HashMap<&'a str, (&'a str, &'a Variable)>,
  clip_colls: HashMap<&'a str, &'a Collection>,
  clip_styles: HashMap<&'a str, &'a str>,
  all_present: bool,
}

impl Visit for Present<'_> {
  fn var(&mut self, id: &mut String) {
    let ok = match (self.dest_vars.get(id.as_str()), self.clip_vars.get(id.as_str())) {
      (None, _) => false,
      (Some((dc, d)), Some((clip_coll, c))) => d.kind == c.kind && (d.name == c.name || dc.name == *clip_coll),
      (Some(_), None) => true,
    };
    self.all_present &= ok;
  }
  fn pin(&mut self, coll: &mut String, mode: &mut String) {
    let ok = match self.dest_colls.get(coll.as_str()) {
      None => false,
      Some(d) => {
        let clip = self.clip_colls.get(coll.as_str());
        let named = clip.is_none_or(|c| c.name == d.name);
        named && d.modes.iter().any(|m| m.id == *mode)
      }
    };
    self.all_present &= ok;
  }
  fn style(&mut self, kind: Kind, id: &mut String) {
    let ok = match (self.dest_styles.get(&(kind, id.as_str())), self.clip_styles.get(id.as_str())) {
      (None, _) => false,
      (Some(d), Some(c)) => d == c,
      (Some(_), None) => true,
    };
    self.all_present &= ok;
  }
}

fn style_names(s: &Styles, kind: Kind) -> Vec<(String, String)> {
  match kind {
    Kind::Color => s.colors.iter().map(|x| (x.id.clone(), x.name.clone())).collect(),
    Kind::Text => s.texts.iter().map(|x| (x.id.clone(), x.name.clone())).collect(),
    Kind::Effect => s.effects.iter().map(|x| (x.id.clone(), x.name.clone())).collect(),
    Kind::Grid => s.grids.iter().map(|x| (x.id.clone(), x.name.clone())).collect(),
  }
}

fn default_value(kind: VarKind) -> Value {
  match kind {
    VarKind::Color => json!("#000000"),
    VarKind::Number => json!(0),
    VarKind::String => json!(""),
    VarKind::Boolean => json!(false),
  }
}

/// `want` if no id in `taken` is it, else a fresh one.
fn free_id(want: &str, prefix: &str, taken: &HashSet<String>, gen: &mut IdGen) -> String {
  if !want.is_empty() && !taken.contains(want) {
    return want.to_string();
  }
  loop {
    let id = gen.next(prefix);
    if !taken.contains(&id) {
      return id;
    }
  }
}

/// `name`, or `name 2`, `name 3`… when `taken` has it.
fn unused_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
  if !taken(name) {
    return name.to_string();
  }
  (2..).map(|i| format!("{name} {i}")).find(|n| !taken(n)).unwrap()
}

/// Brings the tokens the pasted layers use into `doc` and rewrites the layers (and the
/// components they carry) to the destination's ids. Does nothing when everything referenced is
/// already there, which is every paste into the file the layers came from.
pub fn merge_tokens(doc: &mut Document, clip: &Value, gen: &mut IdGen, nodes: &mut [Node], comps: &mut [Node]) -> Result<Added, String> {
  let clip_colls: Vec<Collection> = clip
    .get("variables")
    .and_then(|v| serde_json::from_value(v.clone()).ok())
    .unwrap_or_default();
  let clip_styles: Styles = clip
    .get("styles")
    .and_then(|v| serde_json::from_value(v.clone()).ok())
    .unwrap_or_default();
  if clip_colls.is_empty() && clip_styles == Styles::default() {
    return Ok(Added::default());
  }
  {
    let mut dest_styles: HashMap<(Kind, &str), &str> = HashMap::new();
    dest_styles.extend(doc.styles.colors.iter().map(|x| ((Kind::Color, x.id.as_str()), x.name.as_str())));
    dest_styles.extend(doc.styles.texts.iter().map(|x| ((Kind::Text, x.id.as_str()), x.name.as_str())));
    dest_styles.extend(doc.styles.effects.iter().map(|x| ((Kind::Effect, x.id.as_str()), x.name.as_str())));
    dest_styles.extend(doc.styles.grids.iter().map(|x| ((Kind::Grid, x.id.as_str()), x.name.as_str())));
    let mut present = Present {
      dest_vars: doc
        .variables
        .iter()
        .flat_map(|c| c.variables.iter().map(move |v| (v.id.as_str(), (c, v))))
        .collect(),
      dest_colls: doc.variables.iter().map(|c| (c.id.as_str(), c)).collect(),
      dest_styles,
      clip_vars: clip_colls
        .iter()
        .flat_map(|c| c.variables.iter().map(move |v| (v.id.as_str(), (c.name.as_str(), v))))
        .collect(),
      clip_colls: clip_colls.iter().map(|c| (c.id.as_str(), c)).collect(),
      clip_styles: [
        clip_styles
          .colors
          .iter()
          .map(|s| (s.id.as_str(), s.name.as_str()))
          .collect::<Vec<_>>(),
        clip_styles.texts.iter().map(|s| (s.id.as_str(), s.name.as_str())).collect(),
        clip_styles.effects.iter().map(|s| (s.id.as_str(), s.name.as_str())).collect(),
        clip_styles.grids.iter().map(|s| (s.id.as_str(), s.name.as_str())).collect(),
      ]
      .into_iter()
      .flatten()
      .collect(),
      all_present: true,
    };
    visit_all(nodes, comps, &mut present);
    if present.all_present {
      return Ok(Added::default());
    }
  }

  let before = doc.variables.clone();
  let mut added = Added::default();
  let mut map = Remap::default();
  let mut taken_colls: HashSet<String> = doc.variables.iter().map(|c| c.id.clone()).collect();
  let mut taken_vars: HashSet<String> = doc
    .variables
    .iter()
    .flat_map(|c| c.variables.iter().map(|v| v.id.clone()))
    .collect();

  // What the layers refer to; alias targets of added variables join as they are found. Variables
  // matched in the destination keep their own values, so what they alias there isn't needed.
  let mut used = Used::default();
  visit_all(nodes, comps, &mut used);
  let clip_var_at: HashMap<&str, (usize, usize)> = clip_colls
    .iter()
    .enumerate()
    .flat_map(|(ci, c)| c.variables.iter().enumerate().map(move |(vi, v)| (v.id.as_str(), (ci, vi))))
    .collect();
  // Destination collection (index into `doc.variables`) per clipboard collection, made on first need.
  let mut dest_of: Vec<Option<usize>> = vec![None; clip_colls.len()];
  let pre_vars: HashSet<String> = doc
    .variables
    .iter()
    .flat_map(|c| c.variables.iter().map(|v| v.id.clone()))
    .collect();
  let mut ensure_coll = |ci: usize, doc: &mut Document, map: &mut Remap, added: &mut Added, gen: &mut IdGen| -> usize {
    if let Some(di) = dest_of[ci] {
      return di;
    }
    let cc = &clip_colls[ci];
    // The same id and name: this file is where the layers came from (or a copy of it), so modes
    // match by id even when they were renamed since.
    let origin = doc.variables.iter().position(|d| d.id == cc.id && d.name == cc.name);
    let found = origin.or_else(|| doc.variables.iter().position(|d| d.name == cc.name));
    let di = match found {
      Some(i) => i,
      None => {
        let id = free_id(&cc.id, "vc_", &taken_colls, gen);
        taken_colls.insert(id.clone());
        doc.variables.push(Collection {
          id,
          name: cc.name.clone(),
          modes: Vec::new(),
          variables: Vec::new(),
        });
        added.collections += 1;
        doc.variables.len() - 1
      }
    };
    map.colls.insert(cc.id.clone(), doc.variables[di].id.clone());
    for cm in &cc.modes {
      let d = &doc.variables[di];
      let hit = d
        .modes
        .iter()
        .find(|m| m.id == cm.id && (origin.is_some() || m.name == cm.name))
        .or_else(|| d.modes.iter().find(|m| m.name == cm.name))
        .map(|m| m.id.clone());
      let dest_mode = match hit {
        Some(id) => id,
        None => {
          let taken: HashSet<String> = d.modes.iter().map(|m| m.id.clone()).collect();
          let id = free_id(&cm.id, "vm_", &taken, gen);
          let c = &mut doc.variables[di];
          let first = c.modes.first().map(|m| m.id.clone());
          c.modes.push(VarMode {
            id: id.clone(),
            name: cm.name.clone(),
          });
          // Like adding a mode in the dialog: every variable starts with its default mode's value.
          for v in &mut c.variables {
            let val = first
              .as_ref()
              .and_then(|f| v.values.get(f).cloned())
              .unwrap_or_else(|| default_value(v.kind));
            v.values.insert(id.clone(), val);
          }
          if !d_is_new(&before, &doc.variables[di].id) {
            added.modes += 1;
          }
          id
        }
      };
      map.modes.insert((cc.id.clone(), cm.id.clone()), dest_mode);
    }
    dest_of[ci] = Some(di);
    di
  };
  for (ci, cc) in clip_colls.iter().enumerate() {
    if used.colls.contains(&cc.id) {
      ensure_coll(ci, doc, &mut map, &mut added, gen);
    }
  }

  // Variables: match, or add with empty values (filled once every one has its new id).
  let mut fresh: Vec<(usize, usize, usize)> = Vec::new(); // (clipboard coll, clipboard var, destination var)
                                                          // Variables matched in the destination (clipboard coll, clipboard var, destination var id): they
                                                          // keep their values, except in modes this paste added to a collection that was already there.
  let mut matched: Vec<(usize, usize, String)> = Vec::new();
  let mut queue: Vec<String> = used.vars.iter().cloned().collect();
  queue.sort();
  while let Some(vid) = queue.pop() {
    let Some(&(ci, vi)) = clip_var_at.get(vid.as_str()) else { continue };
    if map.vars.contains_key(&vid) {
      continue;
    }
    let di = ensure_coll(ci, doc, &mut map, &mut added, gen);
    let cv = &clip_colls[ci].variables[vi];
    let coll = &doc.variables[di];
    let same_origin = coll.id == clip_colls[ci].id && coll.name == clip_colls[ci].name;
    // Names match only variables that were here before the paste: two same-named variables in
    // the source stay two.
    let hit = coll
      .variables
      .iter()
      .find(|v| v.id == cv.id && v.kind == cv.kind && (same_origin || v.name == cv.name))
      .or_else(|| {
        coll
          .variables
          .iter()
          .find(|v| v.name == cv.name && v.kind == cv.kind && pre_vars.contains(&v.id))
      })
      .map(|v| v.id.clone());
    let id = match hit {
      Some(id) => {
        let added_modes = added_modes_of(&before, &clip_colls[ci], &doc.variables[di], &map);
        for (cm, _) in &added_modes {
          if let Some(a) = cv.values.get(cm).and_then(|x| x.get("alias")).and_then(|a| a.as_str()) {
            queue.push(a.to_string());
          }
        }
        if !added_modes.is_empty() {
          matched.push((ci, vi, id.clone()));
        }
        id
      }
      None => {
        let id = free_id(&cv.id, "v_", &taken_vars, gen);
        taken_vars.insert(id.clone());
        let name = unused_name(&cv.name, |n| coll.variables.iter().any(|v| v.name == n));
        let c = &mut doc.variables[di];
        c.variables.push(Variable {
          id: id.clone(),
          name,
          kind: cv.kind,
          values: BTreeMap::new(),
          description: cv.description.clone(),
          scopes: cv.scopes.clone(),
        });
        fresh.push((ci, vi, c.variables.len() - 1));
        added.variables += 1;
        queue.extend(
          cv.values
            .values()
            .filter_map(|x| x.get("alias").and_then(|a| a.as_str()))
            .map(String::from),
        );
        id
      }
    };
    map.vars.insert(vid, id);
  }
  for (ci, vi, pos) in fresh {
    let cc = &clip_colls[ci];
    let cv = &cc.variables[vi];
    let di = dest_of[ci].unwrap();
    let first = cc.modes.first().map(|m| m.id.clone());
    let modes: Vec<String> = doc.variables[di].modes.iter().map(|m| m.id.clone()).collect();
    let mut values = BTreeMap::new();
    for dm in modes {
      // The clipboard mode that landed on this destination mode, else the default one.
      let from = cc
        .modes
        .iter()
        .find(|m| map.modes.get(&(cc.id.clone(), m.id.clone())) == Some(&dm))
        .map(|m| m.id.clone());
      let raw = from
        .and_then(|f| cv.values.get(&f))
        .or_else(|| first.as_ref().and_then(|f| cv.values.get(f)))
        .or_else(|| cv.values.values().next())
        .cloned()
        .unwrap_or_else(|| default_value(cv.kind));
      values.insert(dm, pasted_value(cv, raw, first.as_ref(), &map));
    }
    doc.variables[di].variables[pos].values = values;
  }
  // A mode the paste added takes the source's values for the variables that were already here too
  // (aliases included), so the pasted layers look the same in it. Variables the clipboard doesn't
  // carry keep the default mode's value they were given.
  for (ci, vi, dest_id) in matched {
    let cc = &clip_colls[ci];
    let cv = &cc.variables[vi];
    let first = cc.modes.first().map(|m| m.id.clone());
    let Some(di) = dest_of[ci] else { continue };
    let added_modes = added_modes_of(&before, cc, &doc.variables[di], &map);
    for (cm, dm) in added_modes {
      let Some(raw) = cv.values.get(&cm).cloned() else { continue };
      let value = pasted_value(cv, raw, first.as_ref(), &map);
      if let Some(v) = doc.variables[di].variables.iter_mut().find(|v| v.id == dest_id) {
        v.values.insert(dm, value);
      }
    }
  }

  // Styles.
  let mut taken_styles: HashSet<String> = [Kind::Color, Kind::Text, Kind::Effect, Kind::Grid]
    .into_iter()
    .flat_map(|k| style_names(&doc.styles, k).into_iter().map(|(i, _)| i))
    .collect();
  macro_rules! merge_styles {
    ($kind:expr, $list:ident, $ty:ty) => {
      for s in &clip_styles.$list {
        let found = doc
          .styles
          .$list
          .iter()
          .find(|d| d.id == s.id && d.name == s.name)
          .or_else(|| doc.styles.$list.iter().find(|d| d.name == s.name))
          .map(|d| d.id.clone());
        let id = match found {
          Some(id) => id,
          None => {
            let id = free_id(&s.id, "s_", &taken_styles, gen);
            taken_styles.insert(id.clone());
            let mut copy: $ty = s.clone();
            copy.id = id.clone();
            doc.styles.$list.push(copy);
            added.styles += 1;
            id
          }
        };
        map.styles.insert(($kind, s.id.clone()), id);
      }
    };
  }
  merge_styles!(Kind::Color, colors, ColorStyle);
  merge_styles!(Kind::Text, texts, TextStyle);
  merge_styles!(Kind::Effect, effects, EffectStyle);
  merge_styles!(Kind::Grid, grids, GridStyle);

  visit_all(nodes, comps, &mut map);
  crate::variables::validate(&doc.variables, &before)?;
  Ok(added)
}

/// True when `id` isn't a collection of the destination before the paste: all its modes are new
/// then, and adding them isn't a change to something the user had.
fn d_is_new(before: &[Collection], id: &str) -> bool {
  !before.iter().any(|c| c.id == id)
}

/// (clipboard mode id, destination mode id) for the modes this paste added to a collection the
/// destination already had.
fn added_modes_of(before: &[Collection], cc: &Collection, dest: &Collection, map: &Remap) -> Vec<(String, String)> {
  let Some(old) = before.iter().find(|c| c.id == dest.id) else {
    return Vec::new();
  };
  cc.modes
    .iter()
    .filter_map(|m| map.modes.get(&(cc.id.clone(), m.id.clone())).map(|d| (m.id.clone(), d.clone())))
    .filter(|(_, d)| !old.modes.iter().any(|o| o.id == *d))
    .collect()
}

/// A clipboard value as stored in the destination: aliases follow the remapped variable ids.
/// Source data may be invalid (files from before the type check): a paste never fails on it.
fn pasted_value(cv: &Variable, raw: Value, first: Option<&String>, map: &Remap) -> Value {
  let fallback = first.and_then(|f| cv.values.get(f));
  if raw.get("alias").is_some() {
    remap_alias(raw, map)
  } else {
    crate::variables::check_value(cv.kind, &raw)
      .ok()
      .filter(|v| cv.kind != VarKind::Number || v.is_number())
      .or_else(|| fallback.and_then(|f| crate::variables::check_value(cv.kind, f).ok()))
      .filter(|v| v.get("alias").is_none())
      .unwrap_or_else(|| default_value(cv.kind))
  }
}

fn remap_alias(v: Value, map: &Remap) -> Value {
  match v.get("alias").and_then(|a| a.as_str()) {
    Some(a) => json!({ "alias": map.vars.get(a).map(String::as_str).unwrap_or(a) }),
    None => v,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::engine::{Command, Engine};
  use crate::model::Paint;
  use crate::text::HeuristicMeasurer;

  fn engine(seed: u64) -> Engine {
    Engine::new(Box::new(HeuristicMeasurer), seed)
  }

  fn run(e: &mut Engine, tool: &str, input: Value) -> Value {
    e.dispatch(Command::Ai { tool: tool.into(), input })
      .unwrap_or_else(|er| panic!("{tool}: {er}"))
  }

  fn paste(e: &mut Engine, data: String) -> Value {
    e.dispatch(Command::Paste {
      data,
      parent: None,
      x: Some(900.0),
      y: Some(0.0),
    })
    .unwrap()
  }

  /// Primitives plus a Theme aliasing it, styles, and a screen that uses all of them.
  /// Returns the ids by name.
  fn scene(e: &mut Engine) -> HashMap<String, String> {
    run(
      e,
      "define_variables",
      json!({ "collection": "Primitives", "variables": [
        { "name": "Gray/0", "type": "color", "value": "#FFFFFF" },
        { "name": "Gray/900", "type": "color", "value": "#111111" },
        { "name": "Space/8", "type": "number", "value": 8 }] }),
    );
    run(
      e,
      "define_variables",
      json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [
        { "name": "Surface", "type": "color",
          "values": { "Light": { "alias": "Primitives/Gray/0" }, "Dark": { "alias": "Primitives/Gray/900" } } },
        { "name": "Gap", "type": "number", "value": { "alias": "Primitives/Space/8" } }] }),
    );
    run(
      e,
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#6D4AFF" }],
        "texts": [{ "name": "Body", "fontSize": 14 }],
        "effects": [{ "name": "Card", "shadow": { "y": 4, "blur": 8 } }] }),
    );
    let r = run(
      e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Screen", "width": 300, "height": 300,
        "variableModes": { "Theme": "Dark" }, "bind": { "fill": "Theme/Surface" },
        "children": [
          { "type": "rectangle", "name": "Card", "width": 50, "height": 50, "bind": { "fill": "Theme/Surface" },
            "effectStyle": "Card" },
          { "type": "rectangle", "name": "Brand box", "x": 60, "width": 50, "height": 50, "fillStyle": "Brand" },
          { "type": "text", "name": "Label", "text": "Hi", "x": 120, "textStyle": "Body" },
          { "type": "rectangle", "name": "Chip", "x": 200, "width": 20, "height": 20, "bind": { "fill": "Theme/Surface" } }
        ] }] }),
    );
    let mut ids: HashMap<String, String> = r["names"]
      .as_object()
      .unwrap()
      .iter()
      .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
      .collect();
    ids.insert("Screen".into(), r["created"][0]["id"].as_str().unwrap().to_string());
    let comp = run(e, "arrange", json!({ "action": "create_component", "ids": [ids["Chip"]] }))["id"]
      .as_str()
      .unwrap()
      .to_string();
    ids.insert("comp".into(), comp);
    ids
  }

  fn var_named<'a>(e: &'a Engine, coll: &str, name: &str) -> &'a Variable {
    e.doc
      .variables
      .iter()
      .find(|c| c.name == coll)
      .unwrap()
      .variables
      .iter()
      .find(|v| v.name == name)
      .unwrap()
  }

  fn fill_of(e: &Engine, id: &str) -> String {
    match &e.doc.get(id).unwrap().fills[0] {
      Paint::Solid { color, .. } => color.clone(),
      _ => String::new(),
    }
  }

  #[test]
  fn pasting_into_an_empty_file_brings_variables_pins_aliases_and_styles() {
    let mut a = engine(7);
    let ids = scene(&mut a);
    let data = a.copy(&[ids["Screen"].clone()]);
    let mut b = engine(8);
    let r = paste(&mut b, data);
    let added = &r["added"];
    assert_eq!(
      (added["collections"].as_u64(), added["variables"].as_u64()),
      (Some(2), Some(3)),
      "{added}"
    );
    assert_eq!(added["styles"], 3);
    let screen = b.doc.get(r["created"][0].as_str().unwrap()).unwrap().clone();
    // The pin points at B's Theme and its Dark mode.
    let theme = b.doc.variables.iter().find(|c| c.name == "Theme").unwrap();
    let dark = theme.modes.iter().find(|m| m.name == "Dark").unwrap();
    assert_eq!(screen.variable_modes.get(&theme.id), Some(&dark.id));
    assert_eq!(theme.modes.len(), 2);
    // Aliases resolve inside B.
    let surface = var_named(&b, "Theme", "Surface");
    let gray900 = var_named(&b, "Primitives", "Gray/900");
    assert_eq!(surface.values[&dark.id], json!({ "alias": gray900.id }));
    assert_eq!(screen.bindings["fill"], surface.id);
    assert_eq!(fill_of(&b, &screen.id), "#111111", "Dark pin applied");
    // Children keep their links.
    let kids: HashMap<String, Node> = screen
      .children
      .iter()
      .map(|c| b.doc.get(c).unwrap())
      .map(|n| (n.name.clone(), n.clone()))
      .collect();
    assert_eq!(kids["Card"].bindings["fill"], surface.id);
    let card_style = kids["Card"].effect_style.clone().unwrap();
    assert_eq!(b.doc.styles.effects.iter().find(|s| s.id == card_style).unwrap().name, "Card");
    let brand = kids["Brand box"].fill_style.clone().unwrap();
    assert_eq!(b.doc.styles.colors.iter().find(|s| s.id == brand).unwrap().color, "#6D4AFF");
    let body = kids["Label"].text_style.clone().unwrap();
    assert_eq!(b.doc.styles.texts.iter().find(|s| s.id == body).unwrap().name, "Body");
    // Pasting again reuses all of it.
    let again = paste(&mut b, a.copy(&[ids["Screen"].clone()]));
    assert_eq!(again["added"], json!({ "collections": 0, "modes": 0, "variables": 0, "styles": 0 }));
    assert_eq!(b.doc.variables.len(), 2);
    assert_eq!(b.doc.styles.colors.len(), 1);
  }

  #[test]
  fn pasting_in_the_same_file_adds_nothing() {
    let mut a = engine(7);
    let ids = scene(&mut a);
    let (vars, styles) = (a.doc.variables.clone(), a.doc.styles.clone());
    let data = a.copy(&[ids["Screen"].clone()]);
    let r = paste(&mut a, data);
    assert_eq!(r["added"], Added::default().to_json());
    assert_eq!(a.doc.variables, vars);
    assert_eq!(a.doc.styles, styles);
    let pasted = a.doc.get(r["created"][0].as_str().unwrap()).unwrap();
    assert_eq!(pasted.variable_modes, a.doc.get(&ids["Screen"]).unwrap().variable_modes);
  }

  #[test]
  fn a_same_named_collection_and_variable_keep_the_destinations_values() {
    let mut a = engine(7);
    let ids = scene(&mut a);
    let mut b = engine(8);
    run(
      &mut b,
      "define_variables",
      json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [
        { "name": "Surface", "type": "color", "values": { "Light": "#EEEEEE", "Dark": "#222222" } }] }),
    );
    run(
      &mut b,
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#FF0000" }] }),
    );
    let r = paste(&mut b, a.copy(&[ids["Screen"].clone()]));
    assert_eq!(b.doc.variables.iter().filter(|c| c.name == "Theme").count(), 1);
    let theme = b.doc.variables.iter().find(|c| c.name == "Theme").unwrap();
    assert_eq!(theme.variables.iter().filter(|v| v.name == "Surface").count(), 1);
    // Surface is B's: its own values, no alias, and Primitives isn't dragged along for it.
    let surface = var_named(&b, "Theme", "Surface");
    assert!(surface.values.values().all(|v| v.is_string()));
    let screen = r["created"][0].as_str().unwrap();
    assert_eq!(fill_of(&b, screen), "#222222");
    // The colour style matched by name keeps B's colour.
    assert_eq!(b.doc.styles.colors.len(), 1);
    assert_eq!(b.doc.styles.colors[0].color, "#FF0000");
    assert_eq!(r["added"]["styles"], 2);
    assert_eq!(r["added"]["collections"], 0);
  }

  #[test]
  fn a_missing_mode_is_added_to_a_matched_collection() {
    let mut a = engine(7);
    let ids = scene(&mut a);
    let mut b = engine(8);
    run(
      &mut b,
      "define_variables",
      json!({ "collection": "Theme", "modes": ["Light"], "variables": [{ "name": "Surface", "type": "color", "value": "#EEEEEE" }] }),
    );
    let r = paste(&mut b, a.copy(&[ids["Screen"].clone()]));
    assert_eq!(r["added"]["modes"], 1);
    let theme = b.doc.variables.iter().find(|c| c.name == "Theme").unwrap();
    assert_eq!(theme.modes.len(), 2);
    let dark = theme.modes.iter().find(|m| m.name == "Dark").unwrap();
    // The mode is the source's: Surface's Dark value (an alias to a copied variable) comes along.
    let target = var_named(&b, "Theme", "Surface").values[&dark.id]["alias"]
      .as_str()
      .expect("alias")
      .to_string();
    assert!(b.doc.variables.iter().flat_map(|c| &c.variables).any(|v| v.id == target));
    assert_eq!(var_named(&b, "Theme", "Surface").values[&theme.modes[0].id], json!("#EEEEEE"));
    let screen = b.doc.get(r["created"][0].as_str().unwrap()).unwrap();
    assert_eq!(screen.variable_modes.get(&theme.id), Some(&dark.id));
  }

  #[test]
  fn colliding_ids_with_different_content_get_fresh_ids_and_the_references_follow() {
    // Same seed: both files hand out the same ids to different things.
    let mut a = engine(7);
    let ids = scene(&mut a);
    let mut b = engine(7);
    run(
      &mut b,
      "define_variables",
      json!({ "collection": "Other", "variables": [{ "name": "Mine", "type": "number", "value": 1 }] }),
    );
    run(
      &mut b,
      "define_styles",
      json!({ "colors": [{ "name": "Mine", "color": "#00FF00" }] }),
    );
    let all_ids = |e: &Engine| -> HashSet<String> {
      e.doc
        .variables
        .iter()
        .flat_map(|c| std::iter::once(c.id.clone()).chain(c.variables.iter().map(|v| v.id.clone())))
        .collect()
    };
    assert!(!all_ids(&a).is_disjoint(&all_ids(&b)), "the test needs colliding ids");
    let r = paste(&mut b, a.copy(&[ids["Screen"].clone()]));
    let mine = var_named(&b, "Other", "Mine");
    assert_eq!(mine.values.values().next(), Some(&json!(1)));
    let screen = b.doc.get(r["created"][0].as_str().unwrap()).unwrap();
    let surface = var_named(&b, "Theme", "Surface");
    assert_ne!(surface.id, mine.id);
    assert_eq!(screen.bindings["fill"], surface.id);
    assert_eq!(fill_of(&b, &screen.id), "#111111");
    assert_eq!(b.doc.styles.colors.len(), 2);
    let kids: Vec<&Node> = screen.children.iter().map(|c| b.doc.get(c).unwrap()).collect();
    let brand_box = kids.iter().find(|n| n.name == "Brand box").unwrap();
    let style = b
      .doc
      .styles
      .colors
      .iter()
      .find(|s| Some(&s.id) == brand_box.fill_style.as_ref())
      .unwrap();
    assert_eq!(style.name, "Brand");
    assert_eq!(b.doc.styles.colors.iter().find(|s| s.name == "Mine").unwrap().color, "#00FF00");
  }

  #[test]
  fn undo_removes_nodes_variables_and_styles_in_one_step() {
    let mut a = engine(7);
    let ids = scene(&mut a);
    let mut b = engine(8);
    let nodes_before = b.doc.nodes.len();
    paste(&mut b, a.copy(&[ids["Screen"].clone()]));
    assert!(!b.doc.variables.is_empty() && !b.doc.styles.texts.is_empty());
    b.dispatch(Command::Undo).unwrap();
    assert!(b.doc.variables.is_empty());
    assert!(b.doc.styles.colors.is_empty() && b.doc.styles.texts.is_empty() && b.doc.styles.effects.is_empty());
    assert_eq!(b.doc.nodes.len(), nodes_before);
    b.dispatch(Command::Redo).unwrap();
    assert_eq!(b.doc.variables.len(), 2);
  }

  #[test]
  fn undoing_a_paste_keeps_tokens_a_peers_layer_binds() {
    let mut a = engine(7);
    let ids = scene(&mut a);
    let mut b = engine(8);
    paste(&mut b, a.copy(&[ids["Screen"].clone()]));
    let mut peer = engine(20);
    peer.load(&b.to_json()).unwrap();
    let base = peer.doc.clone();
    let surface = var_named(&peer, "Theme", "Surface").id.clone();
    let mine = rect_bound_to_style(&mut peer, &surface);
    let d = crate::collab::delta(&base, &peer.doc, true, true);
    b.dispatch(Command::ApplyRemote { delta: d, local: false }).unwrap();
    b.dispatch(Command::Undo).unwrap();
    assert!(b.doc.get(&mine).is_some(), "the peer's layer survives");
    assert_eq!(b.doc.get(&mine).unwrap().bindings.get("fill"), Some(&surface));
    assert_eq!(var_named(&b, "Theme", "Surface").id, surface);
    assert_eq!(var_named(&b, "Primitives", "Gray/0").name, "Gray/0", "alias target comes along");
    assert!(b
      .doc
      .variables
      .iter()
      .all(|c| c.variables.iter().all(|v| v.id == surface || c.name == "Primitives")));
    assert_eq!(b.doc.styles.colors.len(), 1, "the style the peer's layer uses stays");
    assert!(
      b.doc.styles.texts.is_empty() && b.doc.styles.effects.is_empty(),
      "unused styles still go"
    );
  }

  fn rect_bound_to_style(e: &mut Engine, var_id: &str) -> String {
    let style = e.doc.styles.colors[0].id.clone();
    let r = run(
      e,
      "create_nodes",
      json!({ "nodes": [{ "type": "rectangle", "name": "Peer", "width": 10, "height": 10 }] }),
    );
    let id = r["created"][0]["id"].as_str().unwrap().to_string();
    e.dispatch(Command::Update {
      ids: vec![id.clone()],
      patch: json!({ "bindings": { "fill": var_id }, "fillStyle": style }),
    })
    .unwrap();
    id
  }

  #[test]
  fn collab_delta_lists_the_new_variables_and_styles() {
    let mut a = engine(7);
    let ids = scene(&mut a);
    let mut b = engine(8);
    let base = b.doc.clone();
    paste(&mut b, a.copy(&[ids["Screen"].clone()]));
    let d = crate::collab::delta(&base, &b.doc, true, true);
    assert!(d.get("variableChanges").is_some() || d.get("collectionChanges").is_some(), "{d}");
    assert!(
      d.get("colorStyles").is_some() && d.get("textStyles").is_some() && d.get("effectStyles").is_some(),
      "{d}"
    );
    // A peer applying it ends up with the same tokens.
    let mut peer = base.clone();
    crate::collab::apply(&mut peer, &d).unwrap();
    assert_eq!(peer.variables, b.doc.variables);
    assert_eq!(peer.styles, b.doc.styles);
  }

  #[test]
  fn an_old_clipboard_without_token_keys_still_pastes() {
    let mut a = engine(7);
    let ids = scene(&mut a);
    let mut clip: Value = serde_json::from_str(&a.copy(&[ids["Screen"].clone()])).unwrap();
    clip.as_object_mut().unwrap().remove("variables");
    clip.as_object_mut().unwrap().remove("styles");
    let mut b = engine(8);
    let r = paste(&mut b, clip.to_string());
    assert_eq!(r["created"].as_array().unwrap().len(), 1);
    assert!(b.doc.variables.is_empty());
  }

  #[test]
  fn a_plain_copy_carries_no_token_keys() {
    let mut e = engine(7);
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "width": 10, "height": 10 }] }),
    );
    let id = r["created"][0]["id"].as_str().unwrap().to_string();
    let clip: Value = serde_json::from_str(&e.copy(&[id])).unwrap();
    assert!(clip.get("variables").is_none() && clip.get("styles").is_none());
  }

  #[test]
  fn instance_overrides_and_swaps_are_followed_to_any_depth() {
    let mut a = engine(7);
    let ids = scene(&mut a);
    let surface = var_named(&a, "Theme", "Surface").clone();
    let theme = a.doc.variables.iter().find(|c| c.name == "Theme").unwrap().clone();
    let dark = theme.modes.iter().find(|m| m.name == "Dark").unwrap().id.clone();
    let brand = a.doc.styles.colors[0].id.clone();
    let body = a.doc.styles.texts[0].id.clone();
    // An instance of the Chip component, with overrides that name tokens, some inside swap records.
    let r = run(
      &mut a,
      "create_nodes",
      json!({ "nodes": [{ "type": "instance", "componentId": ids["comp"], "x": 400 }] }),
    );
    let inst = r["created"][0]["id"].as_str().unwrap().to_string();
    let overrides = json!({
      "__root": { "bindings": { "stroke": surface.id }, "variableModes": { theme.id.clone(): dark.clone() }, "fillStyle": brand },
      "inner": { "textStyle": body, "instance": { "componentId": ids["comp"], "overrides": {
        "deep": { "bindings": { "fill": surface.id }, "strokeStyle": brand, "instance": { "componentId": ids["comp"], "overrides": {
          "deeper": { "variableModes": { theme.id.clone(): dark.clone() } } } } } } } },
    });
    a.doc.get_mut(&inst).unwrap().instance.as_mut().unwrap().overrides = serde_json::from_value(overrides).unwrap();
    let data = a.copy(std::slice::from_ref(&inst));
    let mut b = engine(8);
    let r = paste(&mut b, data);
    let pasted = b.doc.get(r["created"][0].as_str().unwrap()).unwrap();
    let o = serde_json::to_value(&pasted.instance.as_ref().unwrap().overrides).unwrap();
    let bs = var_named(&b, "Theme", "Surface");
    let bt = b.doc.variables.iter().find(|c| c.name == "Theme").unwrap();
    let bdark = bt.modes.iter().find(|m| m.name == "Dark").unwrap().id.clone();
    let bbrand = b.doc.styles.colors[0].id.clone();
    let bbody = b.doc.styles.texts[0].id.clone();
    assert_eq!(o["__root"]["bindings"]["stroke"], json!(bs.id));
    assert_eq!(o["__root"]["variableModes"], json!({ bt.id.clone(): bdark.clone() }));
    assert_eq!(o["__root"]["fillStyle"], json!(bbrand));
    assert_eq!(o["inner"]["textStyle"], json!(bbody));
    let deep = &o["inner"]["instance"]["overrides"]["deep"];
    assert_eq!(deep["bindings"]["fill"], json!(bs.id));
    assert_eq!(deep["strokeStyle"], json!(bbrand));
    assert_eq!(
      deep["instance"]["overrides"]["deeper"]["variableModes"],
      json!({ bt.id.clone(): bdark })
    );
  }

  #[test]
  fn a_component_copied_along_follows_its_tokens() {
    let mut a = engine(7);
    let ids = scene(&mut a);
    let r = run(
      &mut a,
      "create_nodes",
      json!({ "nodes": [{ "type": "instance", "componentId": ids["comp"], "x": 400 }] }),
    );
    let inst = r["created"][0]["id"].as_str().unwrap().to_string();
    let mut b = engine(8);
    let r = paste(&mut b, a.copy(&[inst]));
    // The main component came along, bound to B's Surface.
    let surface = var_named(&b, "Theme", "Surface").id.clone();
    let comp = b
      .doc
      .nodes
      .values()
      .find(|n| n.kind == crate::model::NodeType::Component)
      .expect("main component");
    assert!(b
      .doc
      .subtree(&comp.id)
      .iter()
      .any(|id| b.doc.get(id).unwrap().bindings.get("fill") == Some(&surface)));
    assert_eq!(r["created"].as_array().unwrap().len(), 1);
  }
}

#[cfg(test)]
mod tests_r10_review {
  use super::*;
  use crate::engine::{Command, Engine};
  use crate::text::HeuristicMeasurer;

  fn engine(seed: u64) -> Engine {
    Engine::new(Box::new(HeuristicMeasurer), seed)
  }

  fn run(e: &mut Engine, tool: &str, input: Value) -> Value {
    e.dispatch(Command::Ai { tool: tool.into(), input })
      .unwrap_or_else(|er| panic!("{tool}: {er}"))
  }

  fn old_file(vars: Vec<Variable>) -> Engine {
    let mut e = engine(7);
    e.doc.variables = vec![Collection {
      id: "vc_old".into(),
      name: "Old".into(),
      modes: vec![VarMode {
        id: "vm_a".into(),
        name: "A".into(),
      }],
      variables: vars,
    }];
    e
  }

  fn var(id: &str, name: &str, kind: VarKind, v: Value) -> Variable {
    Variable {
      id: id.into(),
      name: name.into(),
      kind,
      values: [("vm_a".to_string(), v)].into_iter().collect(),
      ..Default::default()
    }
  }

  fn rect_bound_to(e: &mut Engine, var_id: &str) -> String {
    let r = run(
      e,
      "create_nodes",
      json!({ "nodes": [{ "type": "rectangle", "width": 10, "height": 10 }] }),
    );
    let id = r["created"][0]["id"].as_str().unwrap().to_string();
    e.doc.get_mut(&id).unwrap().bindings.insert("fill".into(), var_id.into());
    id
  }

  #[test]
  fn add_mode_on_a_collection_with_an_old_invalid_value_works() {
    let mut e = old_file(vec![
      var("v_bad", "Bad", VarKind::Color, json!("banana")),
      var("v_n", "N", VarKind::Number, json!("12")),
    ]);
    let mut cs = e.doc.variables.clone();
    cs[0].modes.push(VarMode {
      id: "vm_b".into(),
      name: "B".into(),
    });
    for v in &mut cs[0].variables {
      let first = v.values["vm_a"].clone();
      v.values.insert("vm_b".into(), first);
    }
    e.dispatch(Command::SetVariables { collections: cs.clone() }).unwrap();
    // Deleting the mode again drops values only.
    cs[0].modes.pop();
    e.dispatch(Command::SetVariables { collections: cs }).unwrap();
    // A new bad value is still refused.
    let mut cs = e.doc.variables.clone();
    cs[0].variables[0].values.insert("vm_a".into(), json!("kiwi"));
    assert!(e.dispatch(Command::SetVariables { collections: cs }).is_err());
  }

  #[test]
  fn a_paste_never_fails_on_invalid_source_values() {
    let mut a = old_file(vec![var("v_bad", "Bad", VarKind::Color, json!("banana"))]);
    let rect = rect_bound_to(&mut a, "v_bad");
    let mut b = engine(8);
    let r = b
      .dispatch(Command::Paste {
        data: a.copy(&[rect]),
        parent: None,
        x: None,
        y: None,
      })
      .unwrap();
    assert_eq!(r["created"].as_array().unwrap().len(), 1);
    let v = &b.doc.variables[0].variables[0];
    assert_eq!(v.values.values().next(), Some(&json!("#000000")));
  }

  #[test]
  fn a_paste_adding_a_mode_to_a_file_with_old_values_works() {
    let mut a = engine(7);
    run(
      &mut a,
      "define_variables",
      json!({ "collection": "Old", "modes": ["A", "B"], "variables": [{ "name": "N", "type": "number", "value": 3 }] }),
    );
    let vid = a.doc.variables[0].variables[0].id.clone();
    let rect = rect_bound_to(&mut a, &vid);
    let mut b = old_file(vec![var("v_n", "N", VarKind::Number, json!("12"))]);
    let r = b
      .dispatch(Command::Paste {
        data: a.copy(&[rect]),
        parent: None,
        x: None,
        y: None,
      })
      .unwrap();
    assert_eq!(r["added"]["modes"], 1);
    assert_eq!(b.doc.variables[0].modes.len(), 2);
  }

  #[test]
  fn renaming_a_mode_or_variable_does_not_make_a_same_file_paste_add_it_again() {
    let mut a = engine(7);
    run(
      &mut a,
      "define_variables",
      json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [{ "name": "S", "type": "color", "values": { "Light": "#FFFFFF", "Dark": "#000000" } }] }),
    );
    let r = run(
      &mut a,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "width": 20, "height": 20, "bind": { "fill": "S" }, "variableModes": { "Theme": "Dark" } }] }),
    );
    let frame = r["created"][0]["id"].as_str().unwrap().to_string();
    let data = a.copy(std::slice::from_ref(&frame));
    let mut cs = a.doc.variables.clone();
    cs[0].modes[1].name = "Night".into();
    cs[0].variables[0].name = "Surface".into();
    a.dispatch(Command::SetVariables { collections: cs }).unwrap();
    let r = a
      .dispatch(Command::Paste {
        data,
        parent: None,
        x: None,
        y: None,
      })
      .unwrap();
    assert_eq!(r["added"], Added::default().to_json());
    assert_eq!(a.doc.variables[0].modes.len(), 2);
    assert_eq!(a.doc.variables[0].variables.len(), 1);
    let pasted = a.doc.get(r["created"][0].as_str().unwrap()).unwrap();
    assert_eq!(pasted.variable_modes.values().next(), Some(&a.doc.variables[0].modes[1].id));
  }

  #[test]
  fn same_named_variables_in_the_source_stay_two() {
    let mut a = old_file(vec![
      var("v_1", "Dup", VarKind::Number, json!(1)),
      var("v_2", "Dup", VarKind::Number, json!(2)),
    ]);
    let r1 = rect_bound_to(&mut a, "v_1");
    let r2 = rect_bound_to(&mut a, "v_2");
    let mut b = engine(8);
    b.dispatch(Command::Paste {
      data: a.copy(&[r1, r2]),
      parent: None,
      x: None,
      y: None,
    })
    .unwrap();
    let names: Vec<&str> = b.doc.variables[0].variables.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names.len(), 2);
    assert_ne!(names[0], names[1]);
  }

  #[test]
  fn a_mode_the_paste_adds_takes_the_sources_values_aliases_included() {
    let mut a = engine(7);
    a.doc.variables = serde_json::from_value(json!([
      { "id": "c_p", "name": "Primitives", "modes": [{ "id": "m_p", "name": "Mode 1" }], "variables": [
        { "id": "v_black", "name": "Black", "type": "color", "values": { "m_p": "#000000" } },
        { "id": "v_white", "name": "White", "type": "color", "values": { "m_p": "#FFFFFF" } } ] },
      { "id": "c_t", "name": "Theme", "modes": [
        { "id": "m_l", "name": "Light" }, { "id": "m_d", "name": "Dark" }, { "id": "m_h", "name": "High contrast" }],
        "variables": [
        { "id": "v_surf", "name": "Surface", "type": "color", "values": {
          "m_l": { "alias": "v_white" }, "m_d": "#222222", "m_h": { "alias": "v_black" } } } ] }
    ]))
    .unwrap();
    let frame = rect_bound_to(&mut a, "v_surf");
    a.doc.get_mut(&frame).unwrap().variable_modes.insert("c_t".into(), "m_h".into());
    let data = a.copy(std::slice::from_ref(&frame));

    let mut b = engine(8);
    b.doc.variables = serde_json::from_value(json!([
      { "id": "d_p", "name": "Primitives", "modes": [{ "id": "dm_p", "name": "Mode 1" }], "variables": [
        { "id": "dv_white", "name": "White", "type": "color", "values": { "dm_p": "#FFFFFF" } } ] },
      { "id": "d_t", "name": "Theme", "modes": [{ "id": "dm_l", "name": "Light" }, { "id": "dm_d", "name": "Dark" }],
        "variables": [
        { "id": "dv_surf", "name": "Surface", "type": "color", "values": { "dm_l": "#F0F0F0", "dm_d": "#111111" } },
        { "id": "dv_only", "name": "Only here", "type": "color", "values": { "dm_l": "#ABCDEF", "dm_d": "#123456" } } ] }
    ]))
    .unwrap();
    let r = b
      .dispatch(Command::Paste {
        data,
        parent: None,
        x: None,
        y: None,
      })
      .unwrap();
    let theme = b.doc.variables.iter().find(|c| c.name == "Theme").unwrap();
    let hc = theme
      .modes
      .iter()
      .find(|m| m.name == "High contrast")
      .expect("mode added")
      .id
      .clone();
    let surface = theme.variables.iter().find(|v| v.name == "Surface").unwrap();
    // Light and Dark stay the destination's; HC is the source's, its alias to a copied Black.
    assert_eq!(surface.values["dm_l"], json!("#F0F0F0"));
    assert_eq!(surface.values["dm_d"], json!("#111111"));
    let black = b
      .doc
      .variables
      .iter()
      .flat_map(|c| &c.variables)
      .find(|v| v.name == "Black")
      .expect("Black copied");
    assert_eq!(surface.values[&hc], json!({ "alias": black.id }));
    // A variable the clipboard doesn't carry takes its Light value.
    let only = theme.variables.iter().find(|v| v.name == "Only here").unwrap();
    assert_eq!(only.values[&hc], json!("#ABCDEF"));
    let pasted = b.doc.get(r["created"][0].as_str().unwrap()).unwrap();
    assert_eq!(crate::variables::resolve(&b.doc, &pasted.id, "dv_surf"), Some(json!("#000000")));
  }
}
