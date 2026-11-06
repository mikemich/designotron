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

#[derive(Default)]
struct Used {
  vars: HashSet<String>,
  colls: HashSet<String>,
  styles: HashSet<String>,
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
/// with the same name (ids alone can collide between unrelated files).
struct Present<'a> {
  doc: &'a Document,
  clip_vars: HashMap<&'a str, &'a Variable>,
  clip_colls: HashMap<&'a str, &'a Collection>,
  clip_styles: HashMap<&'a str, &'a str>,
  all_present: bool,
}

impl Visit for Present<'_> {
  fn var(&mut self, id: &mut String) {
    let dest = self.doc.variables.iter().flat_map(|c| c.variables.iter()).find(|v| v.id == *id);
    let ok = match (dest, self.clip_vars.get(id.as_str())) {
      (None, _) => false,
      (Some(d), Some(c)) => d.name == c.name && d.kind == c.kind,
      (Some(_), None) => true,
    };
    self.all_present &= ok;
  }
  fn pin(&mut self, coll: &mut String, mode: &mut String) {
    let dest = self.doc.variables.iter().find(|c| c.id == *coll);
    let ok = match dest {
      None => false,
      Some(d) => {
        let clip = self.clip_colls.get(coll.as_str());
        let named = clip.is_none_or(|c| c.name == d.name);
        let dm = d.modes.iter().find(|m| m.id == *mode);
        let cm = clip.and_then(|c| c.modes.iter().find(|m| m.id == *mode));
        named && dm.is_some() && cm.is_none_or(|c| dm.is_some_and(|d| d.name == c.name))
      }
    };
    self.all_present &= ok;
  }
  fn style(&mut self, kind: Kind, id: &mut String) {
    let name = style_names(&self.doc.styles, kind)
      .into_iter()
      .find(|(i, _)| i == id)
      .map(|(_, n)| n);
    let ok = match (name, self.clip_styles.get(id.as_str())) {
      (None, _) => false,
      (Some(d), Some(c)) => d == *c,
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
    let mut present = Present {
      doc,
      clip_vars: clip_colls
        .iter()
        .flat_map(|c| c.variables.iter())
        .map(|v| (v.id.as_str(), v))
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
  let mut ensure_coll = |ci: usize, doc: &mut Document, map: &mut Remap, added: &mut Added, gen: &mut IdGen| -> usize {
    if let Some(di) = dest_of[ci] {
      return di;
    }
    let cc = &clip_colls[ci];
    let found = doc
      .variables
      .iter()
      .position(|d| d.id == cc.id && d.name == cc.name)
      .or_else(|| doc.variables.iter().position(|d| d.name == cc.name));
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
        .find(|m| m.id == cm.id && m.name == cm.name)
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
    let hit = coll
      .variables
      .iter()
      .find(|v| v.id == cv.id && v.name == cv.name && v.kind == cv.kind)
      .or_else(|| coll.variables.iter().find(|v| v.name == cv.name && v.kind == cv.kind))
      .map(|v| v.id.clone());
    let id = match hit {
      Some(id) => id,
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
      values.insert(dm, remap_alias(raw, &map));
    }
    doc.variables[di].variables[pos].values = values;
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
    // Filled from the default mode like the dialog's Add mode.
    assert_eq!(var_named(&b, "Theme", "Surface").values[&dark.id], json!("#EEEEEE"));
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
