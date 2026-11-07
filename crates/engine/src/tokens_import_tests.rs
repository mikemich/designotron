use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::engine::{Command, Engine};
use crate::text::HeuristicMeasurer;
use crate::variables::{tokens_json_text, Collection, VarKind, VarMode, Variable};

const DTCG: &str = include_str!("../../../web/scripts/fixtures/tokens-dtcg.json");
const STUDIO: &str = include_str!("../../../web/scripts/fixtures/tokens-studio.json");

fn engine(seed: u64) -> Engine {
  Engine::new(Box::new(HeuristicMeasurer), seed)
}

fn var(id: &str, name: &str, kind: VarKind, values: &[(&str, Value)]) -> Variable {
  Variable {
    id: id.into(),
    name: name.into(),
    kind,
    values: values.iter().map(|(m, v)| (m.to_string(), v.clone())).collect(),
    description: String::new(),
    scopes: Vec::new(),
  }
}

fn mode(id: &str, name: &str) -> VarMode {
  VarMode {
    id: id.into(),
    name: name.into(),
  }
}

/// The r14 scene: primitives, a Light/Dark theme with aliases, scopes, a description, strings and
/// booleans.
fn scene() -> Vec<Collection> {
  let mut glass = var(
    "glass",
    "Surface/Glass",
    VarKind::Color,
    &[("l", json!("#11223380")), ("d", json!("#112233"))],
  );
  glass.description = "Frosted".into();
  glass.scopes = vec!["fill".into(), "stroke".into()];
  vec![
    Collection::new(
      "c1",
      "Primitives",
      vec![mode("m", "Base")],
      vec![
        var("black", "Black", VarKind::Color, &[("m", json!("#000000"))]),
        var("space", "Space", VarKind::Number, &[("m", json!(4))]),
        var("space2", "Space/2", VarKind::Number, &[("m", json!(8.5))]),
        var("flag", "Flags/On", VarKind::Boolean, &[("m", json!(true))]),
      ],
    ),
    Collection::new(
      "c2",
      "Theme",
      vec![mode("l", "Light"), mode("d", "Dark")],
      vec![
        var(
          "bg",
          "Surface/Bg",
          VarKind::Color,
          &[("l", json!("#FFFFFF")), ("d", json!({ "alias": "black" }))],
        ),
        glass,
        var("font", "Font", VarKind::String, &[("l", json!("Inter")), ("d", json!("Georgia"))]),
        var(
          "pad",
          "Pad",
          VarKind::Number,
          &[("l", json!({ "alias": "space2" })), ("d", json!(16))],
        ),
      ],
    ),
  ]
}

fn with_scene() -> Engine {
  let mut e = engine(1);
  e.dispatch(Command::SetVariables { collections: scene() }).unwrap();
  e
}

/// Collections as comparable data: mode ids are replaced by mode names (a file made by an import
/// gets new mode ids) and variables are sorted by id.
fn canon(e: &Engine) -> Value {
  let mut colls: Vec<Value> = e
    .doc
    .variables
    .iter()
    .map(|c| {
      let names: BTreeMap<&str, &str> = c.modes.iter().map(|m| (m.id.as_str(), m.name.as_str())).collect();
      let mut vars: Vec<Value> = c
        .variables
        .iter()
        .map(|v| {
          let values: BTreeMap<&str, &Value> = v.values.iter().map(|(m, x)| (names[m.as_str()], x)).collect();
          json!({ "id": v.id, "name": v.name, "type": v.kind, "values": values, "description": v.description, "scopes": v.scopes })
        })
        .collect();
      vars.sort_by_key(|v| v["id"].as_str().unwrap().to_string());
      json!({ "id": c.id, "name": c.name, "modes": c.modes.iter().map(|m| &m.name).collect::<Vec<_>>(), "variables": vars })
    })
    .collect();
  colls.sort_by_key(|c| c["id"].as_str().unwrap().to_string());
  json!(colls)
}

fn import(e: &mut Engine, text: &str, name: &str) -> Value {
  e.dispatch(Command::ImportVariables {
    json: text.into(),
    name: name.into(),
  })
  .unwrap()
}

fn find<'a>(e: &'a Engine, coll: &str, name: &str) -> (&'a Collection, &'a Variable) {
  let c = e
    .doc
    .variables
    .iter()
    .find(|c| c.name == coll)
    .unwrap_or_else(|| panic!("no collection {coll}"));
  let v = c
    .variables
    .iter()
    .find(|v| v.name == name)
    .unwrap_or_else(|| panic!("no variable {name}"));
  (c, v)
}

fn value_in(e: &Engine, coll: &str, name: &str, mode: &str) -> Value {
  let (c, v) = find(e, coll, name);
  let m = c.modes.iter().find(|m| m.name == mode).unwrap();
  v.values[&m.id].clone()
}

#[test]
fn designotron_export_imports_back_identically() {
  let src = with_scene();
  let text = tokens_json_text(&src.doc);
  let mut dst = engine(2);
  let r = import(&mut dst, &text, "tokens.json");
  assert_eq!(r["collectionsAdded"], 2);
  assert_eq!(r["variablesAdded"], 8);
  assert_eq!(r["skippedCount"], 0);
  assert_eq!(canon(&dst), canon(&src));
  // Importing the same file again changes nothing.
  let again = import(&mut dst, &text, "tokens.json");
  assert_eq!(again["variablesAdded"], 0);
  assert_eq!(again["variablesUpdated"], 0);
  assert_eq!(again["collectionsAdded"], 0);
  assert_eq!(canon(&dst), canon(&src));
}

#[test]
fn reimport_updates_values_without_duplicating_and_deletes_nothing() {
  let mut e = with_scene();
  let mut changed = scene();
  Arc::make_mut(&mut changed[0].variables[1]).values.insert("m".into(), json!(6));
  let mut other = engine(3);
  other.dispatch(Command::SetVariables { collections: changed }).unwrap();
  let text = tokens_json_text(&other.doc);
  // A variable only the file has is added, one only this file has stays.
  let mut text_json: Value = serde_json::from_str(&text).unwrap();
  text_json["Primitives"]["Extra"] = json!({ "$type": "number", "$value": 1 });
  text_json["Primitives"].as_object_mut().unwrap().remove("Black");
  let r = import(&mut e, &text_json.to_string(), "tokens.json");
  assert_eq!(r["variablesUpdated"], 1);
  assert_eq!(r["variablesAdded"], 1);
  assert_eq!(value_in(&e, "Primitives", "Space", "Base"), json!(6));
  find(&e, "Primitives", "Black");
  find(&e, "Primitives", "Extra");
  assert_eq!(e.doc.variables.len(), 2);
}

#[test]
fn a_new_mode_starts_every_existing_variable_at_the_default_value() {
  let mut e = with_scene();
  let file = json!({
    "Primitives": {
      "$extensions": { "com.designotron": { "id": "c1", "name": "Primitives", "modes": ["Base", "Wide"] } },
      "Space": { "$type": "number", "$value": 4, "$extensions": { "com.designotron": { "id": "space", "modes": { "Wide": 12 } } } }
    }
  });
  let r = import(&mut e, &file.to_string(), "t.json");
  assert_eq!(r["modesAdded"], 1);
  assert_eq!(value_in(&e, "Primitives", "Space", "Wide"), json!(12));
  assert_eq!(value_in(&e, "Primitives", "Black", "Wide"), json!("#000000"));
}

#[test]
fn dtcg_types_inheritance_aliases_and_skipped_composites() {
  let mut e = engine(1);
  let r = import(&mut e, DTCG, "brand-tokens.json");
  assert_eq!(r["collectionsAdded"], 1);
  assert_eq!(r["variablesAdded"], 13);
  let skipped: Vec<String> = r["skipped"]
    .as_array()
    .unwrap()
    .iter()
    .map(|s| s["path"].as_str().unwrap().to_string())
    .collect();
  assert_eq!(skipped, ["size/lg", "size/double", "motion/lift"]);
  assert_eq!(r["skippedCount"], 3);
  let reason = |p: &str| {
    r["skipped"].as_array().unwrap().iter().find(|s| s["path"] == p).unwrap()["reason"]
      .as_str()
      .unwrap()
      .to_string()
  };
  assert!(reason("motion/lift").contains("composite"), "{}", reason("motion/lift"));
  assert!(reason("size/double").contains("partial reference or math"));
  assert!(reason("size/lg").contains("em"));
  let coll = "brand-tokens";
  let one = |n: &str| value_in(&e, coll, n, "Default");
  assert_eq!(e.doc.variables[0].modes.len(), 1);
  assert_eq!(one("color/brand/primary"), json!("#6D4AFF"));
  assert_eq!(one("color/brand/soft"), json!("#FF800080"));
  assert_eq!(one("color/raw"), json!("#0A141E"));
  assert_eq!(one("size/sm"), json!(8));
  assert_eq!(one("size/md"), json!(16));
  assert_eq!(one("weight/regular"), json!(400));
  assert_eq!(one("weight/bold"), json!(700));
  assert_eq!(one("motion/fast"), json!(200));
  assert_eq!(one("font/body"), json!("Inter"));
  assert_eq!(one("font/label"), json!("Hello"));
  assert_eq!(one("flag"), json!(true));
  assert_eq!(one("count"), json!(3));
  let (_, primary) = find(&e, coll, "color/brand/primary");
  assert_eq!(primary.description, "Brand colour");
  // The alias inherited its colour type and points at the primary.
  assert_eq!(one("color/text"), json!({ "alias": primary.id }));
  assert_eq!(find(&e, coll, "color/text").1.kind, VarKind::Color);
  // Order follows the file.
  let names: Vec<&str> = e.doc.variables[0].variables.iter().map(|v| v.name.as_str()).take(3).collect();
  assert_eq!(names, ["color/brand/primary", "color/brand/soft", "color/text"]);
}

#[test]
fn dtcg_aliases_follow_through_untyped_chains() {
  let mut e = engine(1);
  let file = json!({
    "a": { "$type": "dimension", "$value": "4px" },
    "b": { "$value": "{a}" },
    "c": { "$value": "{b}" },
    "gone": { "$value": "{nowhere}" },
    "loop1": { "$value": "{loop2}" },
    "loop2": { "$value": "{loop1}" }
  });
  let r = import(&mut e, &file.to_string(), "x.json");
  assert_eq!(r["variablesAdded"], 3);
  assert_eq!(r["skippedCount"], 3);
  let (_, a) = find(&e, "x", "a");
  let (_, b) = find(&e, "x", "b");
  assert_eq!(value_in(&e, "x", "c", "Default"), json!({ "alias": b.id }));
  assert_eq!(value_in(&e, "x", "b", "Default"), json!({ "alias": a.id }));
}

#[test]
fn tokens_studio_themes_become_modes() {
  let mut e = engine(1);
  let r = import(&mut e, STUDIO, "studio.json");
  assert_eq!(r["collectionsAdded"], 2);
  let tokens = e.doc.variables.iter().find(|c| c.name == "Tokens").unwrap();
  assert_eq!(tokens.modes.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["Light", "Dark"]);
  // The later enabled set wins in each theme.
  assert_eq!(value_in(&e, "Tokens", "color/bg", "Light"), json!("#F8F8FA"));
  assert_eq!(value_in(&e, "Tokens", "color/bg", "Dark"), json!("#111111"));
  assert_eq!(value_in(&e, "Tokens", "color/primary", "Dark"), json!("#6D4AFF"));
  // Types: spacing and borderRadius are px numbers, opacity is a fraction, weights are numbers.
  assert_eq!(value_in(&e, "Tokens", "space/sm", "Light"), json!(8));
  assert_eq!(value_in(&e, "Tokens", "space/half", "Light"), json!(0.5));
  assert_eq!(value_in(&e, "Tokens", "weight", "Dark"), json!(700));
  assert_eq!(value_in(&e, "Tokens", "family", "Dark"), json!("Inter"));
  // An alias inside the collection stays an alias (in Light; Dark has a literal).
  let (_, primary) = find(&e, "Tokens", "color/primary");
  assert_eq!(value_in(&e, "Tokens", "color/text", "Light"), json!({ "alias": primary.id }));
  assert_eq!(value_in(&e, "Tokens", "color/text", "Dark"), json!("#FFFFFF"));
  let (_, sm) = find(&e, "Tokens", "space/sm");
  assert_eq!(value_in(&e, "Tokens", "space/radius", "Light"), json!({ "alias": sm.id }));
  // The Brand group: its themes make a second collection; a source set only gives alias targets,
  // so the reference to it became its value.
  let brand = e.doc.variables.iter().find(|c| c.name == "Brand").unwrap();
  assert_eq!(brand.modes.len(), 1);
  assert_eq!(brand.variables.len(), 2);
  assert_eq!(value_in(&e, "Brand", "color/onAccent", "Brand"), json!("#6D4AFF"));
  // Composite tokens and math are skipped with a report.
  let skipped: Vec<&str> = r["skipped"]
    .as_array()
    .unwrap()
    .iter()
    .map(|s| s["path"].as_str().unwrap())
    .collect();
  assert!(skipped.iter().any(|p| p.contains("elevation")), "{skipped:?}");
  assert!(skipped.iter().any(|p| p.contains("space/tall")), "{skipped:?}");
}

#[test]
fn tokens_studio_without_themes_makes_a_collection_per_set() {
  let mut e = engine(1);
  let file = json!({
    "core": { "color": { "blue": { "value": "#0000FF", "type": "color" } }, "n": { "value": "4", "type": "sizing" } },
    "app": { "color": { "main": { "value": "{color.blue}", "type": "color" } }, "gap": { "value": "1.5rem", "type": "spacing" } },
    "$metadata": { "tokenSetOrder": ["core", "app"] }
  });
  let r = import(&mut e, &file.to_string(), "t.json");
  assert_eq!(r["collectionsAdded"], 2);
  assert_eq!(e.doc.variables.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["core", "app"]);
  let (_, blue) = find(&e, "core", "color/blue");
  assert_eq!(value_in(&e, "app", "color/main", "Default"), json!({ "alias": blue.id }));
  assert_eq!(value_in(&e, "app", "gap", "Default"), json!(24));
}

#[test]
fn an_alias_cycle_is_refused_and_nothing_is_applied() {
  let mut e = with_scene();
  let before = canon(&e);
  let file = json!({
    "Loop": {
      "$extensions": { "com.designotron": { "id": "cl", "name": "Loop", "modes": ["A"] } },
      "X": { "$type": "color", "$value": "{Loop.Y}", "$extensions": { "com.designotron": { "id": "x" } } },
      "Y": { "$type": "color", "$value": "{Loop.X}", "$extensions": { "com.designotron": { "id": "y" } } }
    }
  });
  let err = e
    .dispatch(Command::ImportVariables {
      json: file.to_string(),
      name: "l.json".into(),
    })
    .unwrap_err();
  assert!(
    err.to_lowercase().contains("cycle") || err.to_lowercase().contains("circular"),
    "{err}"
  );
  assert_eq!(canon(&e), before);
}

#[test]
fn bad_input_gives_clear_errors() {
  let mut e = engine(1);
  let err = |e: &mut Engine, t: &str| {
    e.dispatch(Command::ImportVariables {
      json: t.into(),
      name: "f.json".into(),
    })
    .unwrap_err()
  };
  assert!(err(&mut e, "this is not json").contains("not valid JSON"));
  assert!(err(&mut e, "[1, 2]").contains("JSON object"));
  assert!(err(&mut e, "{}").contains("no tokens"));
  assert!(err(&mut e, r##"{"a": {"$type": "shadow", "$value": {}}}"##).contains("every token was skipped"));
}

#[test]
fn an_import_is_one_undo_step() {
  let mut e = engine(1);
  import(&mut e, DTCG, "brand-tokens.json");
  assert_eq!(e.doc.variables.len(), 1);
  import(&mut e, STUDIO, "studio.json");
  assert_eq!(e.doc.variables.len(), 3);
  e.dispatch(Command::Undo).unwrap();
  assert_eq!(e.doc.variables.len(), 1);
  e.dispatch(Command::Undo).unwrap();
  assert!(e.doc.variables.is_empty());
  e.dispatch(Command::Redo).unwrap();
  assert_eq!(e.doc.variables.len(), 1);
}

#[test]
fn a_variable_with_another_type_is_skipped_not_retyped() {
  let mut e = with_scene();
  let file = json!({ "Space": { "$type": "color", "$value": "#FF0000" } });
  let r = import(&mut e, &file.to_string(), "Primitives.json");
  assert_eq!(r["skippedCount"], 1);
  assert_eq!(find(&e, "Primitives", "Space").1.kind, VarKind::Number);
}

#[test]
fn five_thousand_tokens_import_quickly() {
  let mut group = serde_json::Map::new();
  for i in 0..5000 {
    group.insert(format!("t{i}"), json!({ "$type": "number", "$value": i }));
  }
  let text = json!({ "scale": group }).to_string();
  let mut e = engine(1);
  let t = std::time::Instant::now();
  let r = import(&mut e, &text, "big.json");
  assert_eq!(r["variablesAdded"], 5000);
  // A debug build, so the bound is loose; the release build is far below a second.
  assert!(t.elapsed().as_secs_f64() < 8.0, "{:?}", t.elapsed());
}

#[test]
fn designotron_fixture_is_the_scene_export() {
  // Regenerate with DT_REGEN=1 when the export format changes.
  let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/scripts/fixtures/tokens-designotron.json");
  let text = tokens_json_text(&with_scene().doc);
  if std::env::var("DT_REGEN").is_ok() {
    std::fs::write(path, &text).unwrap();
  }
  assert_eq!(std::fs::read_to_string(path).unwrap(), text);
}

// ---------- Review fixes ----------

/// A string token's value in the collection a one-token file made.
fn string_value(text: &str) -> String {
  let mut e = engine(1);
  import(&mut e, text, "s.json");
  let (c, v) = (&e.doc.variables[0], &e.doc.variables[0].variables[0]);
  v.values[&c.modes[0].id].as_str().unwrap().to_string()
}

#[test]
fn a_lattice_of_aliases_validates_in_linear_time() {
  // L layers of two variables, two modes, each aliasing both variables of the next layer: the
  // number of paths doubles per layer, the number of aliases does not.
  let layers = 40;
  let lattice = |layers: usize| {
    let modes = vec![mode("a", "A"), mode("b", "B")];
    let mut vars = Vec::new();
    for l in 0..layers {
      for w in 0..2 {
        let values: Vec<(&str, Value)> = if l + 1 < layers {
          vec![
            ("a", json!({ "alias": format!("v{}_0", l + 1) })),
            ("b", json!({ "alias": format!("v{}_1", l + 1) })),
          ]
        } else {
          vec![("a", json!("#FFFFFF")), ("b", json!("#000000"))]
        };
        vars.push(var(&format!("v{l}_{w}"), &format!("L{l}w{w}"), VarKind::Color, &values));
      }
    }
    vec![Collection::new("c", "C", modes, vars)]
  };
  let t = std::time::Instant::now();
  let err = crate::variables::validate(&lattice(layers), &[]).unwrap_err();
  assert!(err.contains("alias chain"), "{err}");
  // A lattice within the allowed depth is accepted.
  crate::variables::validate(&lattice(6), &[]).unwrap();
  assert!(t.elapsed().as_millis() < 100, "{:?}", t.elapsed());
  // Through the import command too.
  let mut e = engine(1);
  let mut file = serde_json::Map::new();
  file.insert(
    "$extensions".into(),
    json!({ "com.designotron": { "id": "c", "name": "C", "modes": ["A", "B"] } }),
  );
  for l in 0..layers {
    for w in 0..2 {
      let tok = if l + 1 < layers {
        json!({ "$type": "color", "$value": format!("{{C.L{}w0}}", l + 1),
          "$extensions": { "com.designotron": { "modes": { "B": format!("{{C.L{}w1}}", l + 1) } } } })
      } else {
        json!({ "$type": "color", "$value": "#ffffff" })
      };
      file.insert(format!("L{l}w{w}"), tok);
    }
  }
  let t = std::time::Instant::now();
  let text = json!({ "C": file }).to_string();
  assert!(e
    .dispatch(Command::ImportVariables {
      json: text,
      name: "l.json".into()
    })
    .is_err());
  assert!(t.elapsed().as_millis() < 500, "{:?}", t.elapsed());
}

#[test]
fn big_files_import_and_reimport_without_quadratic_work() {
  let mut text = String::from("{");
  for g in 0..400 {
    if g > 0 {
      text.push(',');
    }
    text += &format!("\"g{g}\":{{");
    for i in 0..100 {
      if i > 0 {
        text.push(',');
      }
      text += &format!("\"t{i}\":{{\"$type\":\"number\",\"$value\":{i}}}");
    }
    text.push('}');
  }
  text.push('}');
  let mut e = engine(1);
  let t = std::time::Instant::now();
  let r = import(&mut e, &text, "big.json");
  let first = t.elapsed();
  assert_eq!(r["variablesAdded"], 40000);
  let t = std::time::Instant::now();
  let again = import(&mut e, &text, "big.json");
  let second = t.elapsed();
  assert_eq!(
    (again["variablesAdded"].as_u64(), again["variablesUpdated"].as_u64()),
    (Some(0), Some(0))
  );
  println!("40k tokens: import {first:?}, re-import {second:?}");
  // Debug builds are several times slower than release; the bound only has to tell linear from
  // quadratic.
  assert!(first.as_secs() < 20 && second.as_secs() < 20, "{first:?} {second:?}");
}

#[test]
fn two_hundred_thousand_keys_in_one_object_parse_quickly() {
  let mut text = String::from("{\"g\":{");
  for i in 0..200_000 {
    if i > 0 {
      text.push(',');
    }
    text += &format!("\"k{i}\":0");
  }
  text += "}}";
  let t = std::time::Instant::now();
  let _ = engine(1).dispatch(Command::ImportVariables {
    json: text,
    name: "k.json".into(),
  });
  println!("200k keys: {:?}", t.elapsed());
  assert!(t.elapsed().as_secs() < 10, "{:?}", t.elapsed());
}

#[test]
fn a_huge_dimension_string_is_scanned_once() {
  let text = format!(
    r#"{{"a":{{"$type":"dimension","$value":"{}px!"}},"b":{{"$type":"dimension","$value":"{}"}}}}"#,
    "1".repeat(1 << 20),
    "x".repeat(1 << 20)
  );
  let t = std::time::Instant::now();
  let r = engine(1).dispatch(Command::ImportVariables {
    json: text,
    name: "d.json".into(),
  });
  assert!(r.is_err() || r.unwrap()["skippedCount"].as_u64().unwrap() >= 1);
  assert!(t.elapsed().as_secs() < 2, "{:?}", t.elapsed());
  // The message for a value that is no size stays short.
  let small = format!(
    r#"{{"a":{{"$type":"dimension","$value":"{}"}},"ok":{{"$type":"number","$value":1}}}}"#,
    "q".repeat(5000)
  );
  let r = import(&mut engine(1), &small, "d.json");
  assert!(
    r["skipped"][0]["reason"].as_str().unwrap().len() < 200,
    "{}",
    r["skipped"][0]["reason"]
  );
}

#[test]
fn a_dtcg_file_with_an_object_dimension_at_the_root_is_not_taken_for_tokens_studio() {
  let mut e = engine(1);
  let file = json!({
    "space": { "$type": "dimension", "$value": { "value": 4, "unit": "px" } },
    "brand": { "$type": "color", "$value": "#ff0000" }
  });
  let r = import(&mut e, &file.to_string(), "root.json");
  assert_eq!(r["variablesAdded"], 2);
  assert_eq!(e.doc.variables.len(), 1);
  assert_eq!(e.doc.variables[0].name, "root");
  assert_eq!(value_in(&e, "root", "space", "Default"), json!(4));
}

#[test]
fn the_designotron_round_trip_keeps_collection_and_variable_order() {
  let src = with_scene();
  let text = tokens_json_text(&src.doc);
  let mut dst = engine(2);
  import(&mut dst, &text, "tokens.json");
  let order = |e: &Engine| -> Vec<(String, Vec<String>)> {
    e.doc
      .variables
      .iter()
      .map(|c| (c.name.clone(), c.variables.iter().map(|v| v.name.clone()).collect()))
      .collect()
  };
  assert_eq!(order(&dst), order(&src));
  // Source order is not alphabetical (Space before Flags/On), so this is not the sorted map.
  assert_eq!(order(&src)[0].1, ["Black", "Space", "Space/2", "Flags/On"]);
  // An older export has no indexes: the keys come back in file order and nothing breaks.
  let mut old: Value = serde_json::from_str(&text).unwrap();
  for c in old.as_object_mut().unwrap().values_mut() {
    c["$extensions"]["com.designotron"].as_object_mut().unwrap().remove("index");
    for t in c.as_object_mut().unwrap().values_mut() {
      if let Some(x) = t.pointer_mut("/$extensions/com.designotron").and_then(Value::as_object_mut) {
        x.remove("index");
      }
    }
  }
  let mut e3 = engine(3);
  let r = import(&mut e3, &old.to_string(), "tokens.json");
  assert_eq!(r["variablesAdded"], 8);
  assert_eq!(canon(&e3), canon(&src));
}

#[test]
fn a_plain_file_writes_the_destinations_first_mode_instead_of_adding_default() {
  let mut e = with_scene();
  let file = json!({ "Surface/Bg": { "$type": "color", "$value": "#ff0000" }, "New": { "$type": "number", "$value": 3 } });
  let r = import(&mut e, &file.to_string(), "Theme.json");
  assert_eq!(r["modesAdded"], 0, "{r}");
  assert_eq!(r["collectionsAdded"], 0);
  let theme = e.doc.variables.iter().find(|c| c.name == "Theme").unwrap();
  assert_eq!(theme.modes.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["Light", "Dark"]);
  assert_eq!(value_in(&e, "Theme", "Surface/Bg", "Light"), json!("#FF0000"));
  // Dark is untouched, and the new variable starts both modes at the file's value.
  assert_eq!(value_in(&e, "Theme", "Surface/Bg", "Dark"), json!({ "alias": "black" }));
  assert_eq!(value_in(&e, "Theme", "New", "Dark"), json!(3));
  // Tokens Studio sets without themes do the same.
  let studio = json!({ "Theme": { "Font": { "value": "Mono", "type": "fontFamilies" } }, "$metadata": { "tokenSetOrder": ["Theme"] } });
  let r = import(&mut e, &studio.to_string(), "ts.json");
  assert_eq!(r["modesAdded"], 0, "{r}");
  assert_eq!(value_in(&e, "Theme", "Font", "Light"), json!("Mono"));
  assert_eq!(value_in(&e, "Theme", "Font", "Dark"), json!("Georgia"));
}

#[test]
fn names_that_collide_inside_a_file_skip_the_later_token() {
  let mut e = engine(1);
  let file = json!({
    "x/y": { "$type": "color", "$value": "#ffffff" },
    "x": { "y": { "$type": "color", "$value": "#000000" } }
  });
  let r = import(&mut e, &file.to_string(), "c.json");
  assert_eq!(r["variablesAdded"], 1);
  assert_eq!(r["skipped"][0]["reason"], "another token has the same name");
  // The first in the text stays (serde sorts the keys of the json! above: "x" comes first).
  assert_eq!(value_in(&e, "c", "x/y", "Default"), json!("#000000"));
  // Tokens Studio: the same name from "a/b" and a group a with b.
  let mut e = engine(1);
  let ts = json!({ "s": { "a/b": { "value": "#fff", "type": "color" }, "a": { "b": { "value": "#000", "type": "color" } } } });
  let r = import(&mut e, &ts.to_string(), "t.json");
  assert_eq!(r["variablesAdded"], 1);
  assert!(r["skipped"][0]["reason"].as_str().unwrap().contains("same name"));
}

#[test]
fn json_escapes_follow_the_rules_for_surrogates_and_signs() {
  let tok = |v: &str| format!(r#"{{"a":{{"$type":"string","$value":"{v}"}}}}"#);
  assert_eq!(string_value(&tok(r"😀")), "😀");
  assert_eq!(string_value(&tok(r"\ud800A")), "\u{FFFD}A");
  // A high half followed by an escape that is not a low half: the escape stands on its own.
  assert_eq!(string_value(&tok(r"\ud800A")), "\u{FFFD}A");
  assert_eq!(string_value(&tok(r"\ud800😀")), "\u{FFFD}😀");
  assert_eq!(string_value(&tok(r"\udc00")), "\u{FFFD}");
  let err = engine(1)
    .dispatch(Command::ImportVariables {
      json: tok(r"\u+041"),
      name: "s.json".into(),
    })
    .unwrap_err();
  assert!(err.contains("bad \\u escape"), "{err}");
}

#[test]
fn hostile_tokens_studio_files_stay_bounded() {
  // 150 themes in one group: the first 100 are modes, the rest are reported.
  let mut themes = Vec::new();
  for i in 0..150 {
    themes.push(json!({ "name": format!("T{i}"), "selectedTokenSets": { "s": "enabled" } }));
  }
  let file = json!({ "s": { "a": { "value": "#fff", "type": "color" } }, "$themes": themes });
  let mut e = engine(1);
  let r = import(&mut e, &file.to_string(), "t.json");
  assert_eq!(e.doc.variables[0].modes.len(), 100);
  assert_eq!(r["skipped"][0]["path"], "$themes");
  // Thousands of token sets with a reversed order list.
  let mut sets = serde_json::Map::new();
  let mut order = Vec::new();
  for i in 0..5000 {
    sets.insert(format!("s{i}"), json!({ format!("a{i}"): { "value": "#fff", "type": "color" } }));
    order.push(format!("s{}", 4999 - i));
  }
  sets.insert("$metadata".into(), json!({ "tokenSetOrder": order }));
  let t = std::time::Instant::now();
  let r = import(&mut engine(1), &Value::Object(sets).to_string(), "t.json");
  // At most 1000 collections per import; the rest are reported.
  assert_eq!(r["collectionsAdded"], 1000);
  assert!(r["skipped"].as_array().unwrap().iter().any(|x| x["path"] == "collections"));
  assert!(t.elapsed().as_secs() < 20, "{:?}", t.elapsed());
}

#[test]
fn a_long_group_key_is_skipped_instead_of_copied_into_every_token() {
  let key = "k".repeat(100_000);
  let mut group = serde_json::Map::new();
  for i in 0..10_000 {
    group.insert(format!("t{i}"), json!({ "$type": "number", "$value": i }));
  }
  let file = json!({ key.clone(): group.clone(), "ok": { "$type": "number", "$value": 1 } });
  let t = std::time::Instant::now();
  let mut e = engine(1);
  let r = import(&mut e, &file.to_string(), "k.json");
  assert!(t.elapsed().as_secs() < 2, "{:?}", t.elapsed());
  assert_eq!(r["variablesAdded"], 1);
  assert_eq!(r["skippedCount"], 1);
  let path = r["skipped"][0]["path"].as_str().unwrap();
  assert!(path.starts_with("kkkk") && path.len() < 100, "{path}");
  assert!(r["skipped"][0]["reason"].as_str().unwrap().contains("longer than"));
  // Nested one level down, and in Tokens Studio sets, the same.
  let nested = json!({ "g": { key.clone(): group.clone(), "a": { "$type": "number", "$value": 2 } } });
  let r = import(&mut engine(1), &nested.to_string(), "k.json");
  assert_eq!((r["variablesAdded"].as_u64(), r["skippedCount"].as_u64()), (Some(1), Some(1)));
  let ts = json!({ "s": { key.clone(): group, "a": { "value": "#fff", "type": "color" } }, "$metadata": { "tokenSetOrder": ["s"] } });
  let r = import(&mut engine(1), &ts.to_string(), "k.json");
  assert_eq!((r["variablesAdded"].as_u64(), r["skippedCount"].as_u64()), (Some(1), Some(1)));
  // A path made of keys that are each fine but together too long.
  let mut deep = json!({ "$type": "number", "$value": 1 });
  for _ in 0..8 {
    deep = json!({ "k".repeat(200): deep });
  }
  let file = json!({ "n": { "$type": "number", "$value": 0 }, "deep": deep });
  let r = import(&mut engine(1), &file.to_string(), "k.json");
  assert_eq!(r["skippedCount"], 1);
}

#[test]
fn tokens_times_modes_is_budgeted_before_anything_per_mode_is_built() {
  // Tokens Studio: 100 themes x 20,000 tokens.
  let mut set = serde_json::Map::new();
  for i in 0..20_000 {
    set.insert(format!("t{i}"), json!({ "value": "#fff", "type": "color" }));
  }
  let themes: Vec<Value> = (0..100)
    .map(|i| json!({ "name": format!("T{i}"), "selectedTokenSets": { "s": "enabled" } }))
    .collect();
  let file = json!({ "s": set.clone(), "$themes": themes });
  let t = std::time::Instant::now();
  let err = engine(1)
    .dispatch(Command::ImportVariables {
      json: file.to_string(),
      name: "t.json".into(),
    })
    .unwrap_err();
  assert_eq!(err, "too many values to import (20000 tokens × 100 modes)");
  assert!(t.elapsed().as_secs() < 2, "{:?}", t.elapsed());
  // Designotron: 100 modes x 15,000 tokens.
  let modes: Vec<String> = (0..100).map(|i| format!("M{i}")).collect();
  let mut coll = serde_json::Map::new();
  coll.insert(
    "$extensions".into(),
    json!({ "com.designotron": { "id": "c", "name": "C", "modes": modes } }),
  );
  for i in 0..15_000 {
    coll.insert(format!("t{i}"), json!({ "$type": "number", "$value": i }));
  }
  let err = engine(1)
    .dispatch(Command::ImportVariables {
      json: json!({ "C": coll }).to_string(),
      name: "d.json".into(),
    })
    .unwrap_err();
  assert_eq!(err, "too many values to import (15000 tokens × 100 modes)");
  // Within the budget the same shapes still import: 100 themes x 5,000 tokens.
  let mut small = serde_json::Map::new();
  for i in 0..5_000 {
    small.insert(format!("t{i}"), json!({ "value": "#fff", "type": "color" }));
  }
  let themes: Vec<Value> = (0..100)
    .map(|i| json!({ "name": format!("T{i}"), "selectedTokenSets": { "s": "enabled" } }))
    .collect();
  let r = import(&mut engine(1), &json!({ "s": small, "$themes": themes }).to_string(), "t.json");
  assert_eq!(r["variablesAdded"], 5000);
}
