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
    .flat_map(|c| c.variables.iter().map(move |v| (c, v)))
    .filter(|(_, v)| v.kind == kind && in_scope(v, prop))
    .collect()
}

/// How many aliases `resolve` follows; `validate` refuses longer chains.
pub const MAX_ALIAS_DEPTH: usize = 8;

/// Rejects unknown scope names, and alias cycles and chains longer than `resolve` follows. Only
/// variables this change touched (new, or with other values than in `previous`) are checked, so a
/// cycle two peers made at once can't block every later edit of unrelated variables.
pub fn validate(collections: &[Collection], previous: &[Collection]) -> Result<(), String> {
  let mut edges: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
  let mut names: BTreeMap<&str, &str> = BTreeMap::new();
  let old: BTreeMap<&str, &Variable> = previous
    .iter()
    .flat_map(|c| c.variables.iter())
    .map(|v| (v.id.as_str(), v))
    .collect();
  let mut changed: Vec<&str> = Vec::new();
  for v in collections.iter().flat_map(|c| c.variables.iter()) {
    if let Some(bad) = v.scopes.iter().find(|s| !SCOPES.contains(&s.as_str())) {
      return Err(format!("unknown variable scope '{bad}'. Scopes: {}", SCOPES.join(", ")));
    }
    names.insert(&v.id, &v.name);
    let out = edges.entry(&v.id).or_default();
    out.extend(v.values.values().filter_map(|x| x.get("alias").and_then(|a| a.as_str())));
    if old.get(v.id.as_str()).is_none_or(|o| o.values != v.values) {
      changed.push(&v.id);
    }
  }
  /// Longest alias chain from `node`, or the variable that closes a loop.
  fn depth<'a>(edges: &BTreeMap<&'a str, Vec<&'a str>>, node: &'a str, path: &mut Vec<&'a str>) -> Result<usize, &'a str> {
    if path.contains(&node) {
      return Err(node);
    }
    path.push(node);
    let mut longest = 0;
    for t in edges.get(node).into_iter().flatten() {
      if edges.contains_key(t) {
        longest = longest.max(1 + depth(edges, t, path)?);
      }
    }
    path.pop();
    Ok(longest)
  }
  for start in changed {
    match depth(&edges, start, &mut Vec::new()) {
      Err(at) => {
        return Err(format!(
          "alias cycle: {} refers back to itself through {}",
          names.get(at).unwrap_or(&at),
          names.get(start).unwrap_or(&start)
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
    // Written back only on a change: `get_mut` would copy the tree branch of every bound layer.
    let Some(before) = doc.get(&id).cloned() else { continue };
    let mut n = before.clone();
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
            match prop.as_str() {
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
    if n != before {
      doc.nodes.insert(id.clone(), n);
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
  let mut out = String::from("/* Design tokens generated from Designotron variables.\n   Number tokens are unitless, like Figma's: use calc(var(--space-8) * 1px) for lengths. */\n:root {\n");
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
pub fn mode_slug(c: &Collection, m: &VarMode) -> String {
  let name = slug(&m.name);
  if name.is_empty() {
    format!("mode-{}", c.modes.iter().position(|x| x.id == m.id).unwrap_or(0) + 1)
  } else {
    name
  }
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
      variables: vars,
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
    cyc.variables[0].values.insert("m".into(), json!({ "alias": "b" }));
    let err = e.dispatch(Command::SetVariables { collections: vec![cyc] }).unwrap_err();
    assert!(err.contains("alias cycle"), "{err}");
    let mut selfref = coll(vec![var("a", VarKind::Number, json!({ "alias": "a" }))]);
    assert!(validate(std::slice::from_ref(&selfref), &[]).is_err());
    selfref.variables[0].scopes = vec!["nope".into()];
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
    for v in &mut c.variables {
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
    next.variables[2].values.insert("m".into(), json!(2));
    assert!(validate(std::slice::from_ref(&next), std::slice::from_ref(&bad)).is_ok());
    // Touching one of the loop's variables is refused.
    let mut touched = bad.clone();
    touched.variables[0].values.insert("m".into(), alias("b"));
    touched.variables[1].values.insert("m".into(), alias("a"));
    touched.variables[0].values.insert("m2".into(), json!(1));
    assert!(validate(&[touched], std::slice::from_ref(&bad)).is_err());
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
}
