//! The node table's in-memory type must never show in the JSON: a rich fixture (components,
//! instances with overrides, variables, styles, prototypes, comments, images, vectors) serialises
//! to the same bytes whether it goes through `to_json`, a full `doc_delta_json` or a diff delta.
//! The constants were taken from the engine before nodes became `Arc<Node>`.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::engine::{Command, Engine};
use crate::text::HeuristicMeasurer;

fn ai(tool: &str, input: Value) -> Command {
  Command::Ai { tool: tool.into(), input }
}

fn run(e: &mut Engine, tool: &str, input: Value) -> Value {
  e.dispatch(ai(tool, input)).unwrap_or_else(|er| panic!("{tool} failed: {er}"))
}

fn id_of(r: &Value) -> String {
  r["id"].as_str().unwrap().to_string()
}

/// FNV-1a, 64 bit: enough to pin a few hundred KB of JSON.
fn fnv(s: &str) -> u64 {
  s.bytes()
    .fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

fn rich() -> Engine {
  let mut e = Engine::new(Box::new(HeuristicMeasurer), 11);
  run(
    &mut e,
    "define_variables",
    json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [
      { "name": "Surface", "type": "color", "values": { "Light": "#FFFFFF", "Dark": "#111111" } },
      { "name": "Radius", "type": "number", "value": 12 } ] }),
  );
  run(
    &mut e,
    "define_styles",
    json!({ "colors": [{ "name": "Brand", "color": "#7C5CFF" }], "texts": [{ "name": "Heading", "fontSize": 24, "fontWeight": "semibold" }] }),
  );
  run(
    &mut e,
    "create_nodes",
    json!({ "nodes": [
      { "type": "frame", "name": "Home", "x": 0, "y": 0, "width": 360, "height": 640, "fill": "#F1F5F9",
        "layout": { "direction": "vertical", "gap": 12, "padding": 16 }, "children": [
        { "type": "frame", "name": "Button", "width": 200, "fill": "#7C5CFF", "cornerRadius": 8,
          "bind": { "fill": "Theme/Surface", "cornerRadius": "Radius" },
          "layout": { "direction": "horizontal", "gap": 8, "padding": 12 }, "children": [
          { "type": "text", "name": "Label", "text": "Buy now", "fontSize": 16, "textStyle": "Heading" },
          { "type": "ellipse", "name": "Dot", "width": 12, "height": 12, "fill": "#FFFFFF" } ] },
        { "type": "rectangle", "name": "Photo", "width": 100, "height": 60, "imageUrl": "asset:abc123", "cornerRadius": 4 },
        { "type": "rectangle", "name": "Icon", "width": 24, "height": 24, "fills": [{ "type": "image", "src": "asset:icon", "scaleMode": "fit" }] },
        { "type": "star", "name": "Star", "width": 30, "height": 30, "fill": "#FACC15" },
        { "type": "vector", "name": "Path", "width": 40, "height": 40, "stroke": "#000000", "strokeWidth": 2,
          "path": "M 0 0 L 40 0 L 40 40 Z" } ] },
      { "type": "frame", "name": "Other", "x": 500, "y": 0, "width": 360, "height": 640, "fill": "#E2E8F0" } ] }),
  );
  let find = |e: &Engine, name: &str| e.doc.nodes.values().find(|n| n.name == name).map(|n| n.id.clone()).unwrap();
  let home = find(&e, "Home");
  let other = find(&e, "Other");
  let button = find(&e, "Button");
  let comp = id_of(&e.dispatch(Command::CreateComponent { ids: vec![button] }).unwrap());
  let i1 = id_of(&run(
    &mut e,
    "create_instance",
    json!({ "componentId": comp, "parentId": home, "x": 10, "y": 300 }),
  ));
  run(&mut e, "create_instance", json!({ "componentId": comp, "x": 500, "y": 300 }));
  // Overrides: a label's text and a dot's fill on the first instance.
  let kids = e.doc.get(&i1).unwrap().children.clone();
  e.dispatch(Command::SetText {
    id: kids[0].clone(),
    characters: "Override".into(),
    runs: None,
  })
  .unwrap();
  e.dispatch(Command::Update {
    ids: vec![kids[1].clone()],
    patch: json!({ "fill": "#FF0000", "opacity": 0.5 }),
  })
  .unwrap();
  run(&mut e, "set_prototype", json!({ "nodeId": i1, "destinationId": other }));
  e.dispatch(Command::AddComment {
    page: None,
    x: 5.0,
    y: 6.0,
    node: Some(home),
    text: "Check this".into(),
    author: "Ann".into(),
    time: 1000.0,
  })
  .unwrap();
  e
}

/// Pinned on the engine before the node table held `Arc<Node>` (see `rich`).
const TO_JSON_LEN: usize = 15997;
const TO_JSON_HASH: u64 = 15439693644246606565;
const DELTA_LEN: usize = 4471;
const DELTA_HASH: u64 = 16325035821582452063;

#[test]
fn json_is_byte_identical_to_the_inline_node_table() {
  let mut e = rich();
  let full = e.to_json();
  assert_eq!(e.doc_delta_json(true), format!("{{\"full\":{full}}}"));
  // A diff delta after one more edit (nodes, removed, meta).
  let dot = e.doc.nodes.values().find(|n| n.name == "Dot").map(|n| n.id.clone()).unwrap();
  e.dispatch(Command::Update {
    ids: vec![dot.clone()],
    patch: json!({ "opacity": 0.5 }),
  })
  .unwrap();
  let star = e.doc.nodes.values().find(|n| n.name == "Star").map(|n| n.id.clone()).unwrap();
  e.dispatch(Command::Delete { ids: vec![star] }).unwrap();
  let delta = e.doc_delta_json(false);
  eprintln!("GOLDEN full {} {} delta {} {}", full.len(), fnv(&full), delta.len(), fnv(&delta));
  assert_eq!((full.len(), fnv(&full)), (TO_JSON_LEN, TO_JSON_HASH));
  assert_eq!((delta.len(), fnv(&delta)), (DELTA_LEN, DELTA_HASH));
  // It still parses back to the same document.
  let mut f = Engine::new(Box::new(HeuristicMeasurer), 12);
  f.load(&e.to_json()).unwrap();
  assert_eq!(f.doc, e.doc);
  assert_eq!(f.to_json(), e.to_json());
}

#[test]
fn nodes_are_shared_between_clones_until_one_is_edited() {
  let mut e = rich();
  let snapshot = e.doc.clone();
  let dot = e.doc.nodes.values().find(|n| n.name == "Dot").map(|n| n.id.clone()).unwrap();
  let untouched = e.doc.nodes.values().find(|n| n.name == "Other").map(|n| n.id.clone()).unwrap();
  let before = snapshot.get(&dot).unwrap().opacity;
  e.doc.get_mut(&dot).unwrap().opacity = 0.25;
  assert_ne!(before, 0.25);
  assert_eq!(snapshot.get(&dot).unwrap().opacity, before);
  assert_eq!(e.doc.get(&dot).unwrap().opacity, 0.25);
  assert!(Arc::ptr_eq(&snapshot.nodes[&untouched], &e.doc.nodes[&untouched]));
  assert!(!Arc::ptr_eq(&snapshot.nodes[&dot], &e.doc.nodes[&dot]));
}

fn same_shell(a: &crate::model::Document, b: &crate::model::Document) -> bool {
  a.pages.len() == b.pages.len()
    && a.pages.iter().zip(&b.pages).all(|(x, y)| Arc::ptr_eq(x, y))
    && Arc::ptr_eq(&a.styles, &b.styles)
    && a.variables.len() == b.variables.len()
    && a.variables.iter().zip(&b.variables).all(|(x, y)| Arc::ptr_eq(x, y))
    && Arc::ptr_eq(&a.comments, &b.comments)
}

fn comment(e: &mut Engine) {
  e.dispatch(Command::AddComment {
    page: None,
    x: 1.0,
    y: 2.0,
    node: None,
    text: "hi".into(),
    author: "me".into(),
    time: 1.0,
  })
  .unwrap();
}

/// 3 collections of 100 color variables, as the variables dialog would hold them.
fn big_variables(e: &mut Engine) {
  for c in 0..3 {
    let vars: Vec<Value> = (0..100)
      .map(|i| json!({ "name": format!("Token {i}"), "type": "color", "values": { "A": format!("#{:06X}", i * 77 + c), "B": "#112233" } }))
      .collect();
    run(
      e,
      "define_variables",
      json!({ "collection": format!("C{c}"), "modes": ["A", "B"], "variables": vars }),
    );
  }
}

#[test]
fn a_node_edit_shares_the_whole_shell_with_the_step_before() {
  let mut e = rich();
  comment(&mut e);
  let before = e.doc.clone();
  let dot = e.doc.nodes.values().find(|n| n.name == "Dot").map(|n| n.id.clone()).unwrap();
  e.dispatch(Command::Update {
    ids: vec![dot],
    patch: json!({ "opacity": 0.3 }),
  })
  .unwrap();
  assert_ne!(before, e.doc);
  assert!(
    same_shell(&before, &e.doc),
    "pages, styles, variables and comments must stay shared"
  );
}

#[test]
fn a_variable_edit_shares_every_other_variable_and_collection() {
  let mut e = Engine::new(Box::new(HeuristicMeasurer), 3);
  big_variables(&mut e);
  let before = e.doc.clone();
  // The dialog sends the whole set, freshly deserialised, with one value changed.
  let mut cols: Value = serde_json::to_value(&e.doc.variables).unwrap();
  let mode = cols[1]["variables"][50]["values"]
    .as_object()
    .unwrap()
    .keys()
    .next()
    .unwrap()
    .clone();
  cols[1]["variables"][50]["values"][&mode] = json!("#ABCDEF");
  e.dispatch(Command::SetVariables {
    collections: serde_json::from_value(cols).unwrap(),
  })
  .unwrap();
  assert_ne!(before.variables, e.doc.variables);
  assert!(Arc::ptr_eq(&before.variables[0], &e.doc.variables[0]));
  assert!(Arc::ptr_eq(&before.variables[2], &e.doc.variables[2]));
  assert!(!Arc::ptr_eq(&before.variables[1], &e.doc.variables[1]));
  let shared = (0..100)
    .filter(|&i| Arc::ptr_eq(&before.variables[1].variables[i], &e.doc.variables[1].variables[i]))
    .count();
  assert_eq!(shared, 99, "only the edited variable is a new allocation");
  assert!(Arc::ptr_eq(&before.pages[0], &e.doc.pages[0]) && Arc::ptr_eq(&before.styles, &e.doc.styles));
  // Interning matches by id, never by position: a reordered list still shares.
  let mut cols: Vec<crate::variables::Collection> = crate::variables::plain(&e.doc.variables);
  cols.reverse();
  cols[0].variables.reverse();
  let now = e.doc.clone();
  e.dispatch(Command::SetVariables { collections: cols }).unwrap();
  assert!(Arc::ptr_eq(&now.variables[2].variables[99], &e.doc.variables[0].variables[0]));
  assert!(Arc::ptr_eq(&now.variables[0], &e.doc.variables[2]));
  assert!(Arc::ptr_eq(&now.variables[1], &e.doc.variables[1]));
  // Undo restores the earlier handles exactly.
  e.dispatch(Command::Undo).unwrap();
  e.dispatch(Command::Undo).unwrap();
  assert!(same_shell(&before, &e.doc));
}

#[test]
fn a_page_rename_copies_only_that_page() {
  let mut e = rich();
  comment(&mut e);
  let before = e.doc.clone();
  let page = e.doc.pages[0].id.clone();
  e.dispatch(Command::RenamePage {
    id: page,
    name: "Renamed".into(),
  })
  .unwrap();
  assert_ne!(before, e.doc);
  assert!(!Arc::ptr_eq(&before.pages[0], &e.doc.pages[0]));
  assert!(Arc::ptr_eq(&before.styles, &e.doc.styles) && Arc::ptr_eq(&before.comments, &e.doc.comments));
  assert!(before.variables.iter().zip(&e.doc.variables).all(|(a, b)| Arc::ptr_eq(a, b)));
}

#[test]
fn a_document_with_comments_styles_and_variables_round_trips() {
  let mut e = rich();
  comment(&mut e);
  assert!(!e.doc.comments.is_empty() && !e.doc.styles.colors.is_empty() && !e.doc.variables.is_empty());
  let json = e.to_json();
  let mut f = Engine::new(Box::new(HeuristicMeasurer), 5);
  f.load(&json).unwrap();
  assert_eq!(f.doc, e.doc);
  assert_eq!(f.to_json(), json);
  // Equality sees through separate allocations and notices a real difference.
  let mut g = e.doc.clone();
  assert_eq!(g, e.doc);
  g.comments_mut().values_mut().next().unwrap().resolved = true;
  assert_ne!(g, e.doc);
}

/// Revision 4 values are written only when used: the fixture above is revision 3 bytes, and with
/// On drag, sticky and a custom curve the JSON names exactly these, in this order.
#[test]
fn revision_4_values_are_written_only_when_used_and_round_trip() {
  let mut e = rich();
  let before = e.to_json();
  for name in ["onDrag", "sticky", "bezier"] {
    assert!(!before.contains(name), "{name} in a revision 3 file");
  }
  let home = e.doc.nodes.values().find(|n| n.name == "Home").map(|n| n.id.clone()).unwrap();
  let photo = e.doc.nodes.values().find(|n| n.name == "Photo").map(|n| n.id.clone()).unwrap();
  let button = e.doc.nodes.values().find(|n| n.name == "Button").map(|n| n.id.clone()).unwrap();
  run(
    &mut e,
    "update_nodes",
    json!({ "updates": [{ "id": home, "overflow": "vertical" }, { "id": photo, "scrollBehavior": "sticky" }] }),
  );
  run(
    &mut e,
    "set_prototype",
    json!({ "nodeId": button, "trigger": "drag", "action": "back", "transition": "smart_animate", "bezier": [0.25, 0.1, 0.25, 1] }),
  );
  let json = e.to_json();
  assert!(json.contains("\"scrollBehavior\":\"sticky\""), "{json}");
  let at = json.find("\"trigger\":\"onDrag\"").expect("onDrag");
  let end = at + json[at..].find('}').unwrap();
  let interaction = &json[json[..at].rfind('{').unwrap()..=end];
  // Pinned: the field order is the struct's (easing is left out at its default).
  assert!(interaction.contains("\"bezier\":[0.25,0.1,0.25,1.0]"), "{interaction}");
  assert_ne!(fnv(&json), fnv(&before));
  let mut f = Engine::new(Box::new(HeuristicMeasurer), 3);
  f.load(&json).unwrap();
  assert_eq!(f.doc, e.doc);
  assert_eq!(f.to_json(), json);
  // Taking the values away again gives the revision 3 bytes back.
  run(
    &mut e,
    "update_nodes",
    json!({ "updates": [{ "id": photo, "scrollBehavior": "scroll" }, { "id": home, "overflow": "none" }] }),
  );
  run(&mut e, "set_prototype", json!({ "nodeId": button, "clear": true }));
  assert_eq!(e.to_json(), before);
  assert_eq!((before.len(), fnv(&before)), (TO_JSON_LEN, TO_JSON_HASH));
}

#[test]
fn a_text_sequence_is_written_only_when_set_and_round_trips() {
  let mut e = rich();
  let before = e.to_json();
  assert!(!before.contains("\"seq\""));
  assert_eq!((before.len(), fnv(&before)), (TO_JSON_LEN, TO_JSON_HASH));
  let id = e
    .doc
    .nodes
    .values()
    .find(|n| n.text.is_some() && e.doc.instance_ancestor(&n.id).is_none())
    .map(|n| n.id.clone())
    .unwrap();
  e.collab_reset(true, true, true);
  e.collab_enable_text(193847261);
  e.dispatch(Command::EditText {
    id: id.clone(),
    start: 0,
    end: 0,
    text: "ab".into(),
  })
  .unwrap();
  let json = e.to_json();
  assert!(json.contains("\"seq\":{\"e\":"), "{json}");
  let t = e.doc.get(&id).unwrap().text.clone().unwrap();
  let seq = serde_json::to_value(&t.seq).unwrap();
  assert_eq!(seq["s"][0], json!([193847261, 0, 2]));
  let mut f = Engine::new(Box::new(HeuristicMeasurer), 3);
  f.load(&json).unwrap();
  assert_eq!(f.doc.get(&id).unwrap().text, e.doc.get(&id).unwrap().text);
  assert_eq!(f.to_json(), json);
  // Editing alone (not in a text room) drops it again.
  f.dispatch(Command::EditText {
    id,
    start: 0,
    end: 1,
    text: String::new(),
  })
  .unwrap();
  assert!(!f.to_json().contains("\"seq\""));
}
