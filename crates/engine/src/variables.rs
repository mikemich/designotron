//! Variables and modes: named colour/number/string/boolean values per mode,
//! bound to layer properties. Bound values are written into the layers after
//! every change, so rendering, export and lint keep reading plain properties.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::model::{Document, NodeId, Paint};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Collection {
  pub id: String,
  pub name: String,
  /// The first mode is the default.
  pub modes: Vec<VarMode>,
  pub variables: Vec<Variable>,
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
  ("characters", VarKind::String),
  ("visible", VarKind::Boolean),
];

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
  for _ in 0..8 {
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

/// Rewrites bindings and mode overrides given by name (from AI specs) to ids.
pub fn normalize(doc: &mut Document) {
  if doc.variables.is_empty() {
    return;
  }
  let ids: Vec<NodeId> = doc
    .nodes
    .values()
    .filter(|n| !n.bindings.is_empty() || !n.variable_modes.is_empty())
    .map(|n| n.id.clone())
    .collect();
  for id in ids {
    let (bindings, modes) = {
      let n = doc.get(&id).unwrap();
      (n.bindings.clone(), n.variable_modes.clone())
    };
    let bindings = bindings
      .into_iter()
      .map(|(p, v)| (p, find(doc, &v).map(|(_, var)| var.id.clone()).unwrap_or(v)))
      .collect();
    let modes = modes
      .into_iter()
      .map(|(c, m)| match doc.variables.iter().find(|x| x.id == c || x.name == c) {
        Some(coll) => (
          coll.id.clone(),
          coll
            .modes
            .iter()
            .find(|x| x.id == m || x.name == m)
            .map(|x| x.id.clone())
            .unwrap_or(m),
        ),
        None => (c, m),
      })
      .collect();
    let n = doc.get_mut(&id).unwrap();
    n.bindings = bindings;
    n.variable_modes = modes;
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
    let Some(n) = doc.get_mut(&id) else { continue };
    let before = n.clone();
    for (prop, v) in values {
      let num = v.as_f64();
      match prop.as_str() {
        "fill" | "stroke" => {
          let Some(color) = v.as_str().map(crate::color::normalize) else {
            continue;
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
    if *n != before {
      changed = true;
    }
  }
  changed
}

/// Property bindings a direct edit replaces (editing a bound fill detaches its variable).
pub fn unbind_for_patch(doc: &mut Document, ids: &[NodeId], patch: &Value) {
  let Some(obj) = patch.as_object() else { return };
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
      "layout" => {
        if v.get("gap").is_some() {
          props.push("gap");
        }
        if ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]
          .iter()
          .any(|p| v.get(p).is_some())
        {
          props.push("padding");
        }
      }
      "text" => {
        if v.get("fontSize").is_some() {
          props.push("fontSize");
        }
        if v.get("characters").is_some() {
          props.push("characters");
        }
      }
      _ => {}
    }
  }
  if props.is_empty() {
    return;
  }
  for id in ids {
    if let Some(n) = doc.get_mut(id) {
      for p in &props {
        n.bindings.remove(*p);
      }
    }
  }
}

/// Drops bindings and mode overrides that point at variables, collections or modes that no longer exist.
pub fn prune(doc: &mut Document) {
  let vars: Vec<String> = doc
    .variables
    .iter()
    .flat_map(|c| c.variables.iter().map(|v| v.id.clone()))
    .collect();
  let modes: Vec<(String, Vec<String>)> = doc
    .variables
    .iter()
    .map(|c| (c.id.clone(), c.modes.iter().map(|m| m.id.clone()).collect()))
    .collect();
  let mode_ok = |c: &String, m: &String| modes.iter().any(|(cid, ms)| cid == c && ms.contains(m));
  let stale =
    |n: &crate::model::Node| n.bindings.values().any(|v| !vars.contains(v)) || n.variable_modes.iter().any(|(c, m)| !mode_ok(c, m));
  doc.update_where(stale, |n| {
    n.bindings.retain(|_, v| vars.contains(v));
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
    VarKind::String => format!("\"{}\"", val.as_str()?.replace('"', "\\\"")),
    VarKind::Boolean => (if val.as_bool()? { "1" } else { "0" }).to_string(),
  })
}

/// `:root` block for default modes and a `[data-<collection>="<mode>"]` block per other mode.
pub fn tokens_css(doc: &Document) -> String {
  let mut out = String::from("/* Design tokens generated from Designotron variables. */\n:root {\n");
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
      out.push_str(&format!("\n[{}=\"{}\"] {{\n", mode_attr(c), slug(&m.name)));
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

/// HTML attribute that switches a collection's mode in generated code.
pub fn mode_attr(c: &Collection) -> String {
  format!("data-{}", slug(&c.name))
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
        "values": c.modes.iter().map(|m| (m.name.clone(), v.values.get(&m.id).cloned().unwrap_or(Value::Null))).collect::<serde_json::Map<_, _>>(),
      })).collect::<Vec<_>>(),
    }))
    .collect::<Vec<_>>())
}
