//! Rotated auto layout children through the engine: tool calls, canvas rotation, undo,
//! components and the collab delta (the pure layout cases are in `layout.rs`).

use serde_json::{json, Value};

use crate::collab::{apply, delta};
use crate::engine::{Command, Engine};
use crate::geom::{Point, Rect};
use crate::model::NodeId;
use crate::text::HeuristicMeasurer;

fn engine() -> Engine {
  Engine::new(Box::new(HeuristicMeasurer), 16)
}

fn ai(e: &mut Engine, tool: &str, input: Value) -> Value {
  e.dispatch(Command::Ai { tool: tool.into(), input }).unwrap()
}

fn named(e: &Engine, name: &str) -> NodeId {
  e.doc
    .nodes
    .values()
    .find(|n| n.name == name)
    .unwrap_or_else(|| panic!("no layer {name}"))
    .id
    .clone()
}

fn bbox(e: &Engine, id: &str) -> Rect {
  e.doc.abs_bounds(id)
}

/// A hugging button row at (100, 100): padding 12, gap 8, a 100x20 label box, then a 20x20
/// chevron (turned `turn` degrees) and a 10x10 dot.
fn button_row(e: &mut Engine, turn: f64) {
  ai(
    e,
    "create_nodes",
    json!({ "nodes": [{
      "type": "frame", "name": "Row", "x": 100, "y": 100, "width": "hug", "height": "hug",
      "layout": { "direction": "horizontal", "gap": 8, "padding": 12, "crossAlign": "center" },
      "children": [
        { "type": "rectangle", "name": "Label", "width": 100, "height": 20 },
        { "type": "rectangle", "name": "Chevron", "width": 20, "height": 12, "rotation": turn },
        { "type": "rectangle", "name": "Dot", "width": 10, "height": 10 }
      ]
    }] }),
  );
}

#[test]
fn rotation_given_to_create_and_update_nodes_sticks() {
  let mut e = engine();
  button_row(&mut e, 90.0);
  let chev = named(&e, "Chevron");
  assert_eq!(e.doc.get(&chev).unwrap().rotation, 90.0);
  // A 20x12 box turned 90 degrees takes 12 x 20: the row is 12 + 100 + 8 + 12 + 8 + 10 + 12 wide.
  let row = named(&e, "Row");
  assert_eq!(e.doc.get(&row).unwrap().width, 162.0);
  let b = bbox(&e, &chev);
  assert!(
    (b.x - (100.0 + 12.0 + 100.0 + 8.0)).abs() < 1e-6 && (b.width - 12.0).abs() < 1e-6 && (b.height - 20.0).abs() < 1e-6,
    "{b:?}"
  );
  // The panel field (update_nodes), then an edit of a sibling.
  ai(&mut e, "update_nodes", json!({ "updates": [{ "id": chev, "rotation": 180 }] }));
  assert_eq!(e.doc.get(&chev).unwrap().rotation, 180.0);
  assert_eq!(e.doc.get(&row).unwrap().width, 12.0 + 100.0 + 8.0 + 20.0 + 8.0 + 10.0 + 12.0);
  let label = named(&e, "Label");
  ai(&mut e, "update_nodes", json!({ "updates": [{ "id": label, "width": 140 }] }));
  assert_eq!(e.doc.get(&chev).unwrap().rotation, 180.0);
  assert_eq!(e.doc.get(&row).unwrap().width, 12.0 + 140.0 + 8.0 + 20.0 + 8.0 + 10.0 + 12.0);
}

#[test]
fn rotating_on_the_canvas_sticks_and_is_one_undo_step() {
  let mut e = engine();
  button_row(&mut e, 0.0);
  let chev = named(&e, "Chevron");
  let row = named(&e, "Row");
  let w0 = e.doc.get(&row).unwrap().width;
  let c = bbox(&e, &chev).center();
  e.dispatch(Command::BeginGesture).unwrap();
  e.dispatch(Command::Rotate {
    ids: vec![chev.clone()],
    angle: 90.0,
    pivot_x: c.x,
    pivot_y: c.y,
  })
  .unwrap();
  e.dispatch(Command::EndGesture).unwrap();
  assert_eq!(e.doc.get(&chev).unwrap().rotation, 90.0);
  let b = bbox(&e, &chev);
  assert!((b.width - 12.0).abs() < 1e-6 && (b.height - 20.0).abs() < 1e-6, "{b:?}");
  assert_eq!(e.doc.get(&row).unwrap().width, w0 - 8.0, "the row hugs the turned box");
  // One undo puts the rotation and the row back.
  e.dispatch(Command::Undo).unwrap();
  assert_eq!(e.doc.get(&chev).unwrap().rotation, 0.0);
  assert_eq!(e.doc.get(&row).unwrap().width, w0);
  e.dispatch(Command::Redo).unwrap();
  assert_eq!(e.doc.get(&chev).unwrap().rotation, 90.0);
}

#[test]
fn a_collab_delta_carries_the_rotation_and_the_layout_result() {
  let mut a = engine();
  button_row(&mut a, 0.0);
  let mut b = engine();
  b.load(&a.to_json()).unwrap();
  let base = a.doc.clone();
  let chev = named(&a, "Chevron");
  ai(&mut a, "update_nodes", json!({ "updates": [{ "id": chev, "rotation": 90 }] }));
  let d = delta(&base, &a.doc, true, true);
  apply(&mut b.doc, &d).unwrap();
  let (ca, cb) = (a.doc.get(&chev).unwrap(), b.doc.get(&chev).unwrap());
  assert_eq!((cb.rotation, cb.x, cb.y), (90.0, ca.x, ca.y));
  let row = named(&a, "Row");
  assert_eq!(b.doc.get(&row).unwrap().width, a.doc.get(&row).unwrap().width);
}

#[test]
fn instances_follow_a_rotated_child_and_keep_a_rotation_override() {
  let mut e = engine();
  button_row(&mut e, 90.0);
  let row = named(&e, "Row");
  let comp = e.dispatch(Command::CreateComponent { ids: vec![row.clone()] }).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let inst = e
    .dispatch(Command::CreateInstance {
      component_id: comp,
      x: 400.0,
      y: 400.0,
      parent: None,
      anchor: None::<Point>,
      into_components: false,
    })
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let kids = e.doc.get(&inst).unwrap().children.clone();
  let chev = kids.iter().find(|k| e.doc.get(k).unwrap().name == "Chevron").unwrap().clone();
  assert_eq!(e.doc.get(&chev).unwrap().rotation, 90.0);
  assert_eq!(e.doc.get(&inst).unwrap().width, 162.0);
  // A rotation override on the instance's child sticks (and the instance re-hugs).
  e.dispatch(Command::Update {
    ids: vec![chev.clone()],
    patch: json!({ "rotation": 0 }),
  })
  .unwrap();
  assert_eq!(e.doc.get(&chev).unwrap().rotation, 0.0);
  assert_eq!(e.doc.get(&inst).unwrap().width, 12.0 + 100.0 + 8.0 + 20.0 + 8.0 + 10.0 + 12.0);
  // The main keeps its own turn.
  let main_chev = e.doc.get(&row).unwrap().children[1].clone();
  assert_eq!(e.doc.get(&main_chev).unwrap().rotation, 90.0);
}
