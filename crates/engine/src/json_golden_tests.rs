//! The node table's in-memory type must never show in the JSON: a rich fixture (components,
//! instances with overrides, variables, styles, prototypes, comments, images, vectors) serialises
//! to the same bytes whether it goes through `to_json`, a full `doc_delta_json` or a diff delta.
//! The constants were taken from the engine before nodes became `Arc<Node>`.

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
  s.bytes().fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
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
  let i1 = id_of(&run(&mut e, "create_instance", json!({ "componentId": comp, "parentId": home, "x": 10, "y": 300 })));
  run(&mut e, "create_instance", json!({ "componentId": comp, "x": 500, "y": 300 }));
  // Overrides: a label's text and a dot's fill on the first instance.
  let kids = e.doc.get(&i1).unwrap().children.clone();
  e.dispatch(Command::SetText { id: kids[0].clone(), characters: "Override".into() }).unwrap();
  e.dispatch(Command::Update { ids: vec![kids[1].clone()], patch: json!({ "fill": "#FF0000", "opacity": 0.5 }) }).unwrap();
  run(&mut e, "set_prototype", json!({ "nodeId": i1, "destinationId": other }));
  e.dispatch(Command::AddComment { page: None, x: 5.0, y: 6.0, node: Some(home), text: "Check this".into(), author: "Ann".into(), time: 1000.0 })
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
  e.dispatch(Command::Update { ids: vec![dot.clone()], patch: json!({ "opacity": 0.5 }) }).unwrap();
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

