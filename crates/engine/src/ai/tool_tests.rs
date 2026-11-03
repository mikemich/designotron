//! Tests for the lenient, loud tool input, the style and search tools and the compact responses.

use serde_json::{json, Value};

use crate::engine::{Command, Engine};
use crate::model::{Align, LayoutDirection, Sizing};
use crate::text::HeuristicMeasurer;

mod moving {
  use super::*;

  #[test]
  fn a_missing_parent_is_an_error_and_the_layer_stays_put() {
    let mut e = engine();
    let (screen, kids) = screen_with_two_rects(&mut e);
    let before = e.doc.get(&kids[1]).unwrap().clone();
    let r = e.dispatch(ai("move_nodes", json!({ "ids": [kids[1]], "parentId": "n_does_not_exist" })));
    assert!(r.unwrap_err().contains("n_does_not_exist"));
    let after = e.doc.get(&kids[1]).unwrap();
    assert_eq!(after.parent.as_deref(), Some(screen.as_str()));
    assert_eq!(after.x, before.x);
    assert!(e.doc.get(&screen).unwrap().children.contains(&kids[1]));
    // The raw command refuses too.
    let r = e.dispatch(Command::MoveToParent {
      ids: vec![kids[1].clone()],
      parent: Some("n_nope".into()),
      index: None,
    });
    assert!(r.is_err());
    assert_eq!(e.doc.get(&kids[1]).unwrap().parent.as_deref(), Some(screen.as_str()));
  }

  #[test]
  fn a_layer_that_cannot_hold_children_is_refused() {
    let mut e = engine();
    let (_, kids) = screen_with_two_rects(&mut e);
    let t = created(&run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "text", "text": "Hi", "x": 400 }] }),
    ))[0]
      .clone();
    for target in [t.clone(), kids[0].clone()] {
      let r = e.dispatch(ai("move_nodes", json!({ "ids": [kids[1]], "parentId": target })));
      assert!(r.unwrap_err().contains("cannot have children"));
    }
  }

  #[test]
  fn unknown_ids_are_reported_not_counted() {
    let mut e = engine();
    let (_, kids) = screen_with_two_rects(&mut e);
    let r = run(&mut e, "delete_nodes", json!({ "ids": [kids[0], "n_ghost"] }));
    assert_eq!(r["deleted"], json!([kids[0]]));
    assert_eq!(r["notFound"], json!(["n_ghost"]));
    assert!(e.doc.get(&kids[0]).is_none());
    let err = e.dispatch(ai("delete_nodes", json!({ "ids": ["n_ghost"] }))).unwrap_err();
    assert!(err.contains("n_ghost"), "{err}");
    let err = e
      .dispatch(ai("move_nodes", json!({ "ids": ["n_ghost"], "x": 3, "y": 4 })))
      .unwrap_err();
    assert!(err.contains("n_ghost"), "{err}");
    let r = run(&mut e, "move_nodes", json!({ "ids": [kids[1], "n_ghost"], "x": 300, "y": 300 }));
    assert_eq!(r["notFound"], json!(["n_ghost"]));
  }

  #[test]
  fn x_y_on_an_auto_layout_child_is_a_warning_not_a_move() {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Col", "width": 200, "layout": { "direction": "vertical", "gap": 8 },
        "children": [{ "type": "rectangle", "name": "A", "width": 50, "height": 20 }, { "type": "rectangle", "name": "B", "width": 50, "height": 20 }] }] }),
    );
    let a = r["names"]["A"].as_str().unwrap().to_string();
    let moved = run(&mut e, "move_nodes", json!({ "ids": [a], "x": 500, "y": 500 }));
    assert_eq!(moved["moved"], json!([]));
    assert!(moved["warnings"][0].as_str().unwrap().contains("auto layout"), "{moved}");
    let upd = run(&mut e, "update_nodes", json!({ "updates": [{ "id": a, "x": 9, "y": 9 }] }));
    assert!(upd["warnings"][0].as_str().unwrap().contains("x/y ignored"), "{upd}");
    // With absolute it is a real move.
    let upd = run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": a, "absolute": true, "x": 9, "y": 9 }] }),
    );
    assert!(upd.get("warnings").is_none(), "{upd}");
    assert_eq!(e.doc.get(&a).unwrap().x, 9.0);
  }
}

mod values {
  use super::*;

  #[test]
  fn a_percentage_width_names_the_field() {
    let mut e = engine();
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "width": "50%", "height": 40 }] }),
      ))
      .unwrap_err();
    assert!(err.starts_with("nodes[0].width:") && err.contains("\"fill\" or \"hug\""), "{err}");
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "children": [{ "type": "frame" }, { "type": "text", "text": "x", "fontSize": "big" }] }] }),
      ))
      .unwrap_err();
    assert!(err.starts_with("nodes[0].children[1].fontSize:"), "{err}");
    assert!(e.doc.nodes.is_empty(), "an error leaves nothing behind");
  }

  #[test]
  fn strings_and_names_become_numbers() {
    let mut e = engine();
    let id = one(
      &mut e,
      json!({ "type": "text", "text": "Hi", "fontSize": "24px", "fontWeight": "bold", "lineHeight": "150%", "letterSpacing": "0.1em" }),
    );
    let t = e.doc.get(&id).unwrap().text.clone().unwrap();
    assert_eq!((t.font_size, t.font_weight, t.line_height), (24.0, 700, Some(36.0)));
    assert!((t.letter_spacing - 2.4).abs() < 1e-9);
    let id = one(
      &mut e,
      json!({ "type": "text", "text": "Hi", "fontWeight": "600", "lineHeight": 1.5, "fontSize": 20 }),
    );
    let t = e.doc.get(&id).unwrap().text.clone().unwrap();
    assert_eq!((t.font_weight, t.line_height), (600, Some(30.0)));
    let id = one(&mut e, json!({ "type": "text", "text": "Hi", "fontSize": 20, "lineHeight": "3px" }));
    assert_eq!(e.doc.get(&id).unwrap().text.as_ref().unwrap().line_height, Some(3.0));
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "text", "text": "Hi", "fontWeight": "chunky" }] }),
      ))
      .unwrap_err();
    assert!(err.contains("fontWeight") && err.contains("semibold"), "{err}");
    let id = one(&mut e, json!({ "type": "rectangle", "width": "320px", "height": " 40 " }));
    assert_eq!((e.doc.get(&id).unwrap().width, e.doc.get(&id).unwrap().height), (320.0, 40.0));
  }

  #[test]
  fn corner_radius_and_padding_take_every_common_shape() {
    let mut e = engine();
    let id = one(
      &mut e,
      json!({ "type": "rectangle", "width": 10, "height": 10, "cornerRadius": { "tl": 8 } }),
    );
    assert_eq!(e.doc.get(&id).unwrap().corner_radii, Some([8.0, 0.0, 0.0, 0.0]));
    let id = one(
      &mut e,
      json!({ "type": "rectangle", "width": 10, "height": 10, "cornerRadius": "8" }),
    );
    assert_eq!(e.doc.get(&id).unwrap().corner_radius, 8.0);
    let id = one(
      &mut e,
      json!({ "type": "rectangle", "width": 10, "height": 10, "cornerRadius": [4] }),
    );
    assert_eq!(e.doc.get(&id).unwrap().corner_radius, 4.0);
    let id = one(
      &mut e,
      json!({ "type": "rectangle", "width": 10, "height": 10, "cornerRadius": [8, 8, 0, 0] }),
    );
    assert_eq!(e.doc.get(&id).unwrap().corner_radii, Some([8.0, 8.0, 0.0, 0.0]));
    assert!(e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "rectangle", "cornerRadius": { "middle": 3 } }] })
      ))
      .is_err());
    let id = one(
      &mut e,
      json!({ "type": "frame", "width": 100, "height": 100, "layout": { "padding": { "vertical": 8, "horizontal": 16 } } }),
    );
    let l = e.doc.get(&id).unwrap().layout.clone().unwrap();
    assert_eq!(
      (l.padding_top, l.padding_right, l.padding_bottom, l.padding_left),
      (8.0, 16.0, 8.0, 16.0)
    );
    let id = one(
      &mut e,
      json!({ "type": "frame", "width": 100, "height": 100, "layout": { "padding": { "vertical": 8, "left": 3 } } }),
    );
    let l = e.doc.get(&id).unwrap().layout.clone().unwrap();
    assert_eq!(
      (l.padding_top, l.padding_right, l.padding_bottom, l.padding_left),
      (8.0, 0.0, 8.0, 3.0)
    );
  }

  #[test]
  fn enums_ignore_case_and_say_what_is_allowed() {
    let mut e = engine();
    let id = one(
      &mut e,
      json!({ "type": "frame", "width": 100, "height": 100, "layout": { "direction": "HORIZONTAL", "align": "Flex-End", "crossAlign": "CENTER" } }),
    );
    let l = e.doc.get(&id).unwrap().layout.clone().unwrap();
    assert_eq!(
      (l.direction, l.primary_align, l.counter_align),
      (LayoutDirection::Horizontal, Align::End, Align::Center)
    );
    let id = one(&mut e, json!({ "type": "frame", "width": 100, "height": 100, "layout": "row" }));
    assert_eq!(
      e.doc.get(&id).unwrap().layout.as_ref().unwrap().direction,
      LayoutDirection::Horizontal
    );
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "layout": { "direction": "row", "crossAlign": "stretch" } }] }),
      ))
      .unwrap_err();
    assert!(err.starts_with("nodes[0].layout.crossAlign:") && err.contains("'fill'"), "{err}");
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "layout": { "align": "space-around" } }] }),
      ))
      .unwrap_err();
    assert!(err.contains("space-between"), "{err}");
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "layout": { "direction": "diagonal" } }] }),
      ))
      .unwrap_err();
    assert!(err.contains("horizontal") && err.contains("vertical"), "{err}");
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "text", "text": "x", "textAlign": "middle-ish" }] }),
      ))
      .unwrap_err();
    assert!(err.contains("textAlign"), "{err}");
  }

  #[test]
  fn unknown_keys_warn_and_clear_ones_are_mapped() {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "F", "width": 100, "height": 100, "itemSpacing": 8, "layoutMode": "VERTICAL", "fillColour": "#fff" }] }),
    );
    let w: Vec<&str> = r["warnings"].as_array().unwrap().iter().map(|w| w.as_str().unwrap()).collect();
    assert!(w.iter().any(|w| w.contains("itemSpacing") && w.contains("layout.gap")), "{w:?}");
    assert!(
      w.iter().any(|w| w.contains("layoutMode") && w.contains("layout.direction")),
      "{w:?}"
    );
    assert!(w.iter().any(|w| w.contains("fillColour") && w.contains("fill")), "{w:?}");
    // A top-level gap/padding on a frame is what was meant: mapped, and said so.
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "G", "width": 100, "height": 100, "gap": 8, "padding": 16, "direction": "horizontal",
        "layoutSizingHorizontal": "FILL", "children": [{ "type": "rectangle", "width": 5, "height": 5 }] }] }),
    );
    let id = r["created"][0]["id"].as_str().unwrap();
    let n = e.doc.get(id).unwrap();
    let l = n.layout.clone().unwrap();
    assert_eq!((l.gap, l.padding_left, l.direction), (8.0, 16.0, LayoutDirection::Horizontal));
    assert_eq!(n.sizing_h, Sizing::Fill);
    assert!(
      r["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("layout.gap")),
      "{r}"
    );
    // The same warning on many layers is one line.
    let many: Vec<Value> = (0..30)
      .map(|_| json!({ "type": "rectangle", "width": 5, "height": 5, "colour": "red" }))
      .collect();
    let r = run(&mut e, "create_nodes", json!({ "nodes": many }));
    assert_eq!(r["warnings"].as_array().unwrap().len(), 1);
    assert!(r["warnings"][0].as_str().unwrap().contains("29 more"));
    // Text properties on a frame and layout on text are called out.
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "text": "oops", "width": 5, "height": 5 }, { "type": "text", "text": "x", "layout": { "gap": 4 } }] }),
    );
    assert_eq!(r["warnings"].as_array().unwrap().len(), 2, "{r}");
    // Fine input has no warnings key at all.
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "rectangle", "width": 5, "height": 5 }] }),
    );
    assert!(r.get("warnings").is_none());
  }

  #[test]
  fn items_must_be_objects_and_a_missing_type_is_a_frame() {
    let mut e = engine();
    for bad in [
      json!(["a rectangle"]),
      json!([{ "type": "frame", "children": "a rectangle" }]),
      json!([{ "type": "frame", "children": [3] }]),
    ] {
      assert!(e.dispatch(ai("create_nodes", json!({ "nodes": bad }))).is_err());
    }
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "width": 40, "height": 40, "fill": "#123456" }] }),
    );
    let id = r["created"][0]["id"].as_str().unwrap();
    assert_eq!(e.doc.get(id).unwrap().kind, crate::model::NodeType::Frame);
    assert!(r["warnings"][0].as_str().unwrap().contains("missing type"));
    // Aliases, and the real `component` type.
    for t in ["component", "div", "screen", "Frame"] {
      assert!(
        e.dispatch(ai("create_nodes", json!({ "nodes": [{ "type": t, "width": 4, "height": 4 }] })))
          .is_ok(),
        "{t}"
      );
    }
    let err = e
      .dispatch(ai("create_nodes", json!({ "nodes": [{ "type": "button" }] })))
      .unwrap_err();
    assert!(err.contains("component"), "{err}");
  }

  #[test]
  fn image_urls_and_colours_are_checked() {
    let mut e = engine();
    for bad in ["javascript:alert(1)", "file:///etc/passwd", "images/a.png"] {
      let err = e
        .dispatch(ai("create_nodes", json!({ "nodes": [{ "type": "rectangle", "imageUrl": bad }] })))
        .unwrap_err();
      assert!(err.starts_with("nodes[0].imageUrl:"), "{err}");
    }
    for ok in ["https://example.com/a.png", "data:image/png;base64,AAAA", "asset:abc"] {
      assert!(e
        .dispatch(ai("create_nodes", json!({ "nodes": [{ "type": "rectangle", "imageUrl": ok }] })))
        .is_ok());
    }
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "text", "spans": [{ "text": "a", "color": "blue-ish" }] }] }),
      ))
      .unwrap_err();
    assert!(err.starts_with("nodes[0].spans[0].color:"), "{err}");
    assert!(e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "rectangle", "fill": "linear-gradient(90deg)" }] })
      ))
      .is_err());
    let id = one(
      &mut e,
      json!({ "type": "rectangle", "width": 9, "height": 9, "shadow": "0 4px 12px rgba(0,0,0,0.1)" }),
    );
    let fx = e.doc.get(&id).unwrap().effects.clone();
    assert_eq!((fx.len(), fx[0].y, fx[0].blur), (1, 4.0, 12.0));
    let id = one(&mut e, json!({ "type": "rectangle", "width": 9, "height": 9, "opacity": 50 }));
    assert_eq!(e.doc.get(&id).unwrap().opacity, 0.5);
  }

  #[test]
  fn export_code_rejects_unknown_formats() {
    let mut e = engine();
    let (screen, _) = screen_with_two_rects(&mut e);
    let err = e.dispatch(ai("export_code", json!({ "id": screen, "format": "vue" }))).unwrap_err();
    assert!(err.contains("vue") && err.contains("react"), "{err}");
    assert!(e.dispatch(ai("export_code", json!({ "id": screen, "format": "HTML" }))).is_ok());
  }
}

mod prototype {
  use super::*;

  #[test]
  fn typos_and_missing_destinations_are_errors() {
    let (mut e, ids) = screens();
    let (home, other, btn) = (&ids[0], &ids[1], &ids[2]);
    for input in [
      json!({ "nodeId": btn, "action": "navigte", "destinationId": other }),
      json!({ "nodeId": btn, "trigger": "tap", "destinationId": other }),
      json!({ "nodeId": btn, "transition": "fade", "destinationId": other }),
      json!({ "nodeId": btn, "action": "navigate" }),
      json!({ "nodeId": btn, "action": "navigate", "destinationId": "n_missing" }),
      json!({ "nodeId": btn, "action": "navigate", "destinationId": btn }),
      json!({ "nodeId": btn, "action": "open_url" }),
      json!({ "nodeId": "n_missing", "destinationId": other }),
    ] {
      let r = e.dispatch(ai("set_prototype", input.clone()));
      assert!(r.is_err(), "{input}");
    }
    assert!(e.doc.get(btn).unwrap().interactions.is_empty());
    let err = e
      .dispatch(ai(
        "set_prototype",
        json!({ "nodeId": btn, "action": "navigte", "destinationId": other }),
      ))
      .unwrap_err();
    assert!(err.contains("navigate") && err.contains("open_overlay"), "{err}");
    // back needs no destination.
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "action": "back", "trigger": "hover" }),
    );
    let _ = home;
  }

  #[test]
  fn a_new_interaction_replaces_the_one_with_the_same_trigger() {
    let (mut e, ids) = screens();
    let (home, other, btn) = (&ids[0], &ids[1], &ids[2]);
    run(&mut e, "set_prototype", json!({ "nodeId": btn, "destinationId": other }));
    let r = run(&mut e, "set_prototype", json!({ "nodeId": btn, "destinationId": home }));
    assert_eq!(r["replaced"], 1);
    let i = &e.doc.get(btn).unwrap().interactions;
    assert_eq!(i.len(), 1);
    assert_eq!(i[0].destination.as_deref(), Some(home.as_str()));
    // Another trigger, or `add`, keeps both.
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "destinationId": other, "trigger": "hover" }),
    );
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "destinationId": other, "add": true }),
    );
    assert_eq!(e.doc.get(btn).unwrap().interactions.len(), 3);
    // The delay is settable and defaults to 800.
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "destinationId": other, "trigger": "delay", "delay": 2500 }),
    );
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "destinationId": home, "trigger": "delay", "add": true }),
    );
    let i = &e.doc.get(btn).unwrap().interactions;
    assert_eq!((i[3].delay_ms, i[4].delay_ms), (2500.0, 800.0));
  }

  /// Home, Settings and a button inside Home: [home, settings, button].
  fn screens() -> (Engine, Vec<String>) {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [
        { "type": "frame", "name": "Home", "width": 300, "height": 300,
          "children": [{ "type": "rectangle", "name": "Go", "width": 50, "height": 20 }] },
        { "type": "frame", "name": "Settings", "x": 400, "width": 300, "height": 300 }] }),
    );
    let home = r["created"][0]["id"].as_str().unwrap().to_string();
    let btn = r["names"]["Go"].as_str().unwrap().to_string();
    (e, vec![home, r["created"][1]["id"].as_str().unwrap().to_string(), btn])
  }
}

mod tokens {
  use super::*;

  #[test]
  fn bindings_and_modes_must_exist_and_match() {
    let mut e = engine();
    run(
      &mut e,
      "define_variables",
      json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [
        { "name": "Surface", "type": "color", "values": { "Light": "#FFFFFF", "Dark": "#111111" } },
        { "name": "Radius", "type": "number", "value": 8 }] }),
    );
    let bad = |e: &mut Engine, spec: Value| e.dispatch(ai("create_nodes", json!({ "nodes": [spec] }))).unwrap_err();
    let err = bad(&mut e, json!({ "type": "rectangle", "bind": { "fill": "Surfce" } }));
    assert!(err.starts_with("nodes[0].bind.fill:") && err.contains("Theme/Surface"), "{err}");
    let err = bad(&mut e, json!({ "type": "rectangle", "bind": { "cornerRadius": "Surface" } }));
    assert!(err.contains("color variable") && err.contains("number"), "{err}");
    let err = bad(&mut e, json!({ "type": "frame", "variableModes": { "Theme": "Sepia" } }));
    assert!(err.contains("Light") && err.contains("Dark"), "{err}");
    let err = bad(&mut e, json!({ "type": "frame", "variableModes": { "Thme": "Dark" } }));
    assert!(err.contains("Theme"), "{err}");
    let err = bad(&mut e, json!({ "type": "rectangle", "bind": { "rotation": "Surface" } }));
    assert!(err.contains("can't be bound"), "{err}");
    assert!(e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "width": 10, "height": 10, "bind": { "fill": "Theme/Surface", "cornerRadius": "Radius" }, "variableModes": { "Theme": "Dark" } }] })
      ))
      .is_ok());
    // Before any variable exists the error says to create them.
    let mut fresh = engine();
    let err = bad(&mut fresh, json!({ "type": "rectangle", "bind": { "fill": "Brand" } }));
    assert!(err.contains("define_variables"), "{err}");
  }

  #[test]
  fn styles_reject_bad_colours_and_update_by_name() {
    let mut e = engine();
    let err = e
      .dispatch(ai(
        "define_styles",
        json!({ "colors": [{ "name": "Brand", "color": "not-a-colour" }] }),
      ))
      .unwrap_err();
    assert!(err.starts_with("colors[0].color:"), "{err}");
    assert!(e.doc.styles.colors.is_empty());
    let r = run(
      &mut e,
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#7C5CFF" }] }),
    );
    let id = r["created"][0].as_str().unwrap().to_string();
    let r = run(
      &mut e,
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#FF0000" }] }),
    );
    assert_eq!(r["updated"], json!([id]));
    assert_eq!(r["created"], json!([]));
    assert_eq!(e.doc.styles.colors.len(), 1);
    assert_eq!(e.doc.styles.colors[0].color, "#FF0000");
    // Text styles upsert too, and the layers that use them follow.
    let r = run(
      &mut e,
      "define_styles",
      json!({ "texts": [{ "name": "Heading", "fontSize": 24, "fontWeight": "semibold", "lineHeight": 32 }] }),
    );
    let sid = r["created"][0].as_str().unwrap().to_string();
    let t = one(&mut e, json!({ "type": "text", "text": "Title", "textStyle": "Heading" }));
    run(&mut e, "define_styles", json!({ "texts": [{ "name": "Heading", "fontSize": 30 }] }));
    assert_eq!(e.doc.styles.texts.len(), 1);
    let tp = e.doc.get(&t).unwrap().text.clone().unwrap();
    assert_eq!((tp.font_size, tp.font_weight, tp.line_height), (30.0, 600, Some(32.0)));
    assert_eq!(e.doc.get(&t).unwrap().text_style.as_deref(), Some(sid.as_str()));
  }

  #[test]
  fn get_document_lists_text_styles() {
    let mut e = engine();
    run(
      &mut e,
      "define_styles",
      json!({ "texts": [{ "name": "Heading", "fontFamily": "Inter", "fontSize": 24, "fontWeight": 600, "lineHeight": 32 }, { "name": "Body", "fontSize": 16 }] }),
    );
    let d = run(&mut e, "get_document", json!({}));
    assert_eq!(d["textStyles"][0]["name"], "Heading");
    assert_eq!(d["textStyles"][0]["font"], "Inter 600 24/32");
    assert_eq!(d["textStyles"][1]["font"], "Inter 400 16");
  }

  #[test]
  fn styles_apply_by_name_on_create_and_update() {
    let mut e = engine();
    run(
      &mut e,
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#7C5CFF" }, { "name": "Ink", "color": "#111827" }],
        "texts": [{ "name": "Heading", "fontSize": 28, "fontWeight": 700 }] }),
    );
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Card", "width": 200, "layout": { "direction": "vertical" }, "fillStyle": "brand", "strokeStyle": "Ink",
        "children": [{ "type": "text", "name": "Title", "text": "Hello", "textStyle": "Heading", "fillStyle": "Ink" }] }] }),
    );
    let card = e.doc.get(r["created"][0]["id"].as_str().unwrap()).unwrap().clone();
    let brand = e.doc.styles.colors[0].id.clone();
    assert_eq!(card.fill_style.as_deref(), Some(brand.as_str()));
    assert!(matches!(&card.fills[0], crate::model::Paint::Solid { color, .. } if color == "#7C5CFF"));
    assert!(matches!(&card.strokes[0], crate::model::Paint::Solid { color, .. } if color == "#111827"));
    let title = e.doc.get(r["names"]["Title"].as_str().unwrap()).unwrap().clone();
    let tp = title.text.clone().unwrap();
    assert_eq!((tp.font_size, tp.font_weight), (28.0, 700));
    assert_eq!(title.text_style.as_deref(), Some(e.doc.styles.texts[0].id.as_str()));
    // Update: link, then unlink with null.
    let t2 = one(&mut e, json!({ "type": "text", "text": "Plain", "x": 400 }));
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": t2, "textStyle": "Heading", "fillStyle": "Brand" }] }),
    );
    let n = e.doc.get(&t2).unwrap();
    assert_eq!(n.text.as_ref().unwrap().font_size, 28.0);
    assert_eq!(
      n.fill_style.as_deref(),
      Some(brand.as_str()),
      "the fill change doesn't unlink the style named with it"
    );
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": t2, "textStyle": null, "fillStyle": null }] }),
    );
    let n = e.doc.get(&t2).unwrap();
    assert!(n.text_style.is_none() && n.fill_style.is_none());
    // Unknown names list the styles there are.
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "text", "text": "x", "textStyle": "Headng" }] }),
      ))
      .unwrap_err();
    assert!(err.starts_with("nodes[0].textStyle:") && err.contains("Heading"), "{err}");
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "rectangle", "fillStyle": "Nope" }] }),
      ))
      .unwrap_err();
    assert!(err.contains("Brand") && err.contains("Ink"), "{err}");
  }

  #[test]
  fn component_props_errors_name_the_property() {
    let mut e = engine();
    let (_, kids) = screen_with_two_rects(&mut e);
    let comp = run(&mut e, "arrange", json!({ "action": "create_component", "ids": [kids[0]] }));
    let comp = comp["selection"][0].as_str().unwrap().to_string();
    run(
      &mut e,
      "set_component_props",
      json!({ "ops": [{ "op": "add", "component": comp, "name": "Label", "kind": "text", "default": "Hi" }] }),
    );
    let err = e
      .dispatch(ai(
        "set_component_props",
        json!({ "ops": [{ "op": "update", "component": comp, "prop": "Nope", "default": "x" }] }),
      ))
      .unwrap_err();
    assert!(err.contains("'Nope'") && err.contains("Label"), "{err}");
  }
}

mod compat {
  use super::*;

  /// What the HTML importer and the built-in templates send must neither fail nor warn.
  #[test]
  fn importer_shaped_specs_raise_nothing() {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{
        "type": "frame", "name": "Imported", "fill": "rgb(15, 23, 42)", "clip": true, "x": 0, "y": 0, "width": 800, "height": "hug",
        "layout": { "direction": "vertical", "gap": 12.5, "padding": [24, 24, 24, 24], "align": "start", "crossAlign": "start" },
        "children": [
          { "type": "frame", "name": "card", "fill": "rgba(255, 255, 255, 0.9)", "stroke": "rgb(226, 232, 240)", "strokeWidth": 1,
            "shadow": [{ "color": "rgba(0, 0, 0, 0.1)", "x": 0, "y": 4, "blur": 6, "spread": -1, "inset": false }],
            "cornerRadius": [8, 8, 0, 0], "opacity": 0.5, "x": 0, "y": 0, "width": "fill", "height": "hug",
            "layout": { "direction": "horizontal", "gap": 8, "padding": [0, 0, 0, 0], "align": "space-between", "crossAlign": "center", "wrap": true, "counterGap": 4 },
            "children": [
              { "type": "text", "text": "Hello", "fontSize": 16, "fontWeight": 400, "fontFamily": "Inter", "lineHeight": 24, "color": "rgb(15, 23, 42)", "italic": false, "textAlign": "left", "letterSpacing": 0.5, "x": 0, "y": 0 },
              { "type": "rectangle", "name": "Image", "imageUrl": "asset:abc123", "cornerRadius": 4, "x": 0, "y": 0, "width": 20, "height": 20, "absolute": true },
              { "type": "rectangle", "name": "Icon", "fills": [{ "type": "image", "src": "asset:icon", "scaleMode": "fit" }], "width": 20, "height": 20 },
              { "type": "frame", "name": "grad", "fill": "linear-gradient(rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)", "width": 10, "height": 10 }] }] }] }),
    );
    assert!(r.get("warnings").is_none(), "{r}");
    assert_eq!(e.doc.nodes.len(), 6);
  }
}

mod find {
  use super::*;

  #[test]
  fn finds_by_name_type_text_component_and_style() {
    let mut e = engine();
    run(
      &mut e,
      "define_styles",
      json!({ "colors": [{ "name": "Brand", "color": "#7C5CFF" }] }),
    );
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Page", "width": 400, "height": 400, "layout": { "direction": "vertical" }, "children": [
        { "type": "component", "name": "Button / Primary", "width": 100, "height": 40, "children": [{ "type": "text", "name": "Label", "text": "Buy now" }] },
        { "type": "rectangle", "name": "Hero image", "width": 50, "height": 50, "fillStyle": "Brand" },
        { "type": "text", "name": "Heading", "text": "Welcome to the shop" }] }] }),
    );
    let comp = r["names"]["Button / Primary"].as_str().unwrap().to_string();
    run(&mut e, "create_instance", json!({ "componentId": comp, "x": 500, "y": 0 }));
    run(&mut e, "create_instance", json!({ "componentId": comp, "x": 500, "y": 100 }));
    let names = |r: &Value| -> Vec<String> {
      r["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["name"].as_str().unwrap().to_string())
        .collect()
    };
    let f = run(&mut e, "find_nodes", json!({ "name": "BUTTON" }));
    assert_eq!(f["total"], 3, "{f}");
    let f = run(&mut e, "find_nodes", json!({ "name": "/^button \\//" }));
    assert_eq!(f["total"], 3);
    let f = run(&mut e, "find_nodes", json!({ "name": "/hero|heading/" }));
    assert_eq!(names(&f), vec!["Hero image", "Heading"]);
    let f = run(&mut e, "find_nodes", json!({ "type": "text" }));
    assert!(names(&f).contains(&"Label".to_string()) && names(&f).contains(&"Heading".to_string()));
    assert!(f["nodes"][0]["text"].is_string());
    let f = run(&mut e, "find_nodes", json!({ "text": "SHOP" }));
    assert_eq!(names(&f), vec!["Heading"]);
    let f = run(&mut e, "find_nodes", json!({ "componentId": comp }));
    assert_eq!(f["total"], 2);
    assert_eq!(f["nodes"][0]["type"], "instance");
    let f = run(&mut e, "find_nodes", json!({ "style": "brand" }));
    assert_eq!(names(&f), vec!["Hero image"]);
    let page = r["created"][0]["id"].as_str().unwrap();
    let f = run(&mut e, "find_nodes", json!({ "within": page, "type": "rectangle" }));
    assert_eq!(f["total"], 1);
    assert_eq!(f["nodes"][0]["parentId"], page);
    let f = run(&mut e, "find_nodes", json!({ "type": "text", "limit": 1 }));
    assert_eq!((f["total"].as_u64().unwrap() > 1, f["nodes"].as_array().unwrap().len()), (true, 1));
    // Filters combine, and the page filter works.
    let f = run(&mut e, "find_nodes", json!({ "type": "text", "name": "head" }));
    assert_eq!(f["total"], 1);
    let f = run(&mut e, "find_nodes", json!({ "name": "Heading", "page": "all" }));
    assert_eq!(f["total"], 1);
    assert!(e.dispatch(ai("find_nodes", json!({ "name": "/(/" }))).is_err());
    assert!(e.dispatch(ai("find_nodes", json!({ "page": "p_nope" }))).is_err());
    assert!(e.dispatch(ai("find_nodes", json!({ "style": "Nope" }))).is_err());
    assert!(e.dispatch(ai("find_nodes", json!({ "type": "blob" }))).is_err());
  }

  #[test]
  fn find_nodes_is_in_the_tool_list() {
    let defs = crate::ai::tool_defs();
    let names: Vec<&str> = defs.as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"find_nodes"));
    let update = defs.as_array().unwrap().iter().find(|d| d["name"] == "update_nodes").unwrap();
    let props = &update["input_schema"]["properties"]["updates"]["items"]["properties"];
    assert!(props.get("fillStyle").is_some() && props.get("id").is_some() && props.get("patch").is_some());
    assert!(props.get("children").is_none() && props.get("type").is_none());
    let arrange = defs.as_array().unwrap().iter().find(|d| d["name"] == "arrange").unwrap();
    assert!(arrange["input_schema"]["properties"]["action"]["enum"].as_array().unwrap().len() > 20);
  }
}

mod size {
  use super::*;

  #[test]
  fn creating_a_thousand_layers_answers_in_a_few_kilobytes() {
    let mut e = engine();
    let rows: Vec<Value> = (0..250)
      .map(|i| {
        json!({ "type": "frame", "name": format!("Row {i}"), "width": "fill", "height": 40, "layout": { "direction": "horizontal" },
          "children": [{ "type": "text", "name": format!("Label {i}"), "text": "x" }, { "type": "rectangle", "name": format!("Dot {i}"), "width": 8, "height": 8 }, { "type": "rectangle", "name": format!("Bar {i}"), "width": 8, "height": 8 }] })
      })
      .collect();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Table", "width": 400, "layout": { "direction": "vertical" }, "children": rows }] }),
    );
    assert_eq!(e.doc.nodes.len(), 1001);
    let size = serde_json::to_string(&r).unwrap().len();
    assert!(size < 20_000, "{size} bytes");
    assert_eq!(r["created"].as_array().unwrap().len(), 1);
    assert_eq!(r["namesTruncated"], true);
    assert_eq!(r["names"].as_object().unwrap().len(), 300);
    assert!(r["names"]["Row 0"].is_string());
  }

  #[test]
  fn get_document_cuts_a_big_tree_and_says_so() {
    let mut e = engine();
    let screens: Vec<Value> = (0..10)
      .map(|s| {
        let cards: Vec<Value> = (0..20)
          .map(|c| json!({ "type": "frame", "name": format!("Card {c}"), "width": 100, "height": 40, "children": [
            { "type": "rectangle", "width": 10, "height": 10, "fill": "#FF0000" }, { "type": "rectangle", "width": 10, "height": 10, "fill": "#00FF00" },
            { "type": "rectangle", "width": 10, "height": 10, "fill": "#0000FF" }, { "type": "rectangle", "width": 10, "height": 10, "fill": "#0000FF" }] }))
          .collect();
        json!({ "type": "frame", "name": format!("Screen {s}"), "x": s * 500, "width": 400, "height": 400, "children": cards })
      })
      .collect();
    run(&mut e, "create_nodes", json!({ "nodes": screens }));
    assert_eq!(e.doc.nodes.len(), 10 + 200 + 800);
    let d = run(&mut e, "get_document", json!({}));
    let size = serde_json::to_string(&d).unwrap().len();
    assert!(size < 40_000, "{size} bytes");
    assert!(d["truncated"].as_str().unwrap().contains("find_nodes"));
    // The roots and their children are there; the level that didn't fit shows counts.
    assert_eq!(d["layers"].as_array().unwrap().len(), 10);
    assert_eq!(d["layers"][0]["children"].as_array().unwrap().len(), 20);
    assert_eq!(d["layers"][0]["children"][0]["childCount"], 4);
    // A small page is untouched.
    let mut small = engine();
    one(
      &mut small,
      json!({ "type": "frame", "width": 10, "height": 10, "children": [{ "type": "rectangle", "width": 2, "height": 2 }] }),
    );
    let d = run(&mut small, "get_document", json!({}));
    assert!(d.get("truncated").is_none());
    assert_eq!(d["layers"][0]["children"].as_array().unwrap().len(), 1);
  }

  #[test]
  fn get_nodes_cuts_huge_text() {
    let mut e = engine();
    let big = "word ".repeat(40_000);
    let id = one(&mut e, json!({ "type": "text", "text": big, "width": 300 }));
    let r = run(&mut e, "get_nodes", json!({ "ids": [id] }));
    let n = &r[0];
    assert_eq!(n["textTruncated"], true);
    assert_eq!(n["textLength"], 200_000);
    assert_eq!(n["text"]["characters"].as_str().unwrap().chars().count(), 2000);
    assert!(serde_json::to_string(&r).unwrap().len() < 20_000);
    let id = one(&mut e, json!({ "type": "text", "text": "short", "x": 400 }));
    let r = run(&mut e, "get_nodes", json!({ "ids": [id] }));
    assert!(r[0].get("textTruncated").is_none());
  }
}

fn engine() -> Engine {
  Engine::new(Box::new(HeuristicMeasurer), 7)
}

fn ai(tool: &str, input: Value) -> Command {
  Command::Ai { tool: tool.into(), input }
}

/// Runs a tool through the engine and returns its result.
fn run(e: &mut Engine, tool: &str, input: Value) -> Value {
  e.dispatch(ai(tool, input)).unwrap_or_else(|er| panic!("{tool} failed: {er}"))
}

/// Ids of the layers a `create_nodes` result lists.
fn created(r: &Value) -> Vec<String> {
  r["created"]
    .as_array()
    .unwrap()
    .iter()
    .map(|c| c["id"].as_str().unwrap().to_string())
    .collect()
}

/// Creates one layer and returns its id.
fn one(e: &mut Engine, spec: Value) -> String {
  created(&run(e, "create_nodes", json!({ "nodes": [spec] })))[0].clone()
}

/// A screen with two rectangles: (screen id, [rect ids]).
fn screen_with_two_rects(e: &mut Engine) -> (String, Vec<String>) {
  let r = run(
    e,
    "create_nodes",
    json!({ "nodes": [{ "type": "frame", "name": "Screen", "width": 300, "height": 300, "children": [
      { "type": "rectangle", "name": "Keep", "width": 50, "height": 50 },
      { "type": "rectangle", "name": "Victim", "x": 100, "width": 50, "height": 50 }] }] }),
  );
  let screen = created(&r)[0].clone();
  let kids = e.doc.get(&screen).unwrap().children.clone();
  (screen, kids)
}
