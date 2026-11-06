//! Tests for the lenient, loud tool input, the style and search tools and the compact responses.

use serde_json::{json, Value};

use crate::engine::{Command, Engine};
use crate::model::{Action, Align, LayoutDirection, Sizing};
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
  fn overflow_and_scroll_behavior_are_stored_and_sticky_warns() {
    use crate::model::{NodeType, Overflow, ScrollBehavior};
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "width": 100, "height": 100, "overflow": "Vertical",
        "children": [{ "type": "rectangle", "width": 100, "height": 20, "scrollBehavior": "fixed" }] }] }),
    );
    assert!(r.get("warnings").is_none(), "{r}");
    let frame = e.doc.nodes.values().find(|n| n.kind == NodeType::Frame).unwrap();
    assert_eq!(
      (frame.overflow, frame.scroll_behavior),
      (Overflow::Vertical, ScrollBehavior::Scroll)
    );
    let rect = e.doc.nodes.values().find(|n| n.kind == NodeType::Rectangle).unwrap();
    assert_eq!(rect.scroll_behavior, ScrollBehavior::Fixed);
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "width": 10, "height": 10, "scrollBehavior": "sticky" }] }),
    );
    assert!(r.to_string().contains("sticky"), "{r}");
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "overflow": "diagonal" }] }),
      ))
      .unwrap_err();
    assert!(err.contains("overflow") && err.contains("vertical"), "{err}");
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
    // Sources the editor would fetch from somewhere unexpected are refused in every spelling,
    // through every route that makes a paint.
    for bad in [
      "//stub-exfil.test/a.png",
      "https:stub-exfil.test/a.png",
      "ht\ttps://stub-exfil.test/a.png",
      " https://stub-exfil.test/a.png",
      "https://stub-exfil.test/a b.png",
      "https://stub-exfil.test/\n.png",
    ] {
      for input in [
        json!({ "nodes": [{ "type": "rectangle", "fills": [{ "type": "image", "src": bad }] }] }),
        json!({ "nodes": [{ "type": "rectangle", "fill": { "type": "image", "src": bad } }] }),
        json!({ "nodes": [{ "type": "rectangle", "stroke": { "type": "image", "src": bad } }] }),
        json!({ "nodes": [{ "type": "rectangle", "imageUrl": bad }] }),
      ] {
        assert!(e.dispatch(ai("create_nodes", input.clone())).is_err(), "{bad}: {input}");
      }
      let id = created(&run(&mut e, "create_nodes", json!({ "nodes": [{ "type": "rectangle" }] })))[0].clone();
      for upd in [
        json!({ "id": id, "fills": [{ "type": "image", "src": bad }] }),
        json!({ "id": id, "patch": { "fills": [{ "type": "image", "src": bad }] } }),
        json!({ "id": id, "patch": { "strokes": [{ "type": "image", "src": bad }] } }),
      ] {
        assert!(
          e.dispatch(ai("update_nodes", json!({ "updates": [upd.clone()] }))).is_err(),
          "{bad}: {upd}"
        );
      }
    }
    // The renderer is a backstop for documents that already hold one.
    assert!(!crate::paint::safe_image_src("//host/a.png"));
    assert!(!crate::paint::safe_image_src("https:host/a.png"));
    assert!(crate::paint::safe_image_src("HTTPS://host/a.png"));
    assert_eq!(crate::paint::image_href("//host/a.png"), "");
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
    assert_eq!(
      r["replaced"],
      json!([{ "trigger": "onClick", "action": "navigate", "destinationId": other }])
    );
    let i = &e.doc.get(btn).unwrap().interactions;
    assert_eq!(i.len(), 1);
    assert_eq!(i[0].destination.as_deref(), Some(home.as_str()));
    // Another trigger keeps both.
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "destinationId": other, "trigger": "hover" }),
    );
    assert_eq!(e.doc.get(btn).unwrap().interactions.len(), 2);
    // The delay is settable and defaults to 800.
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "destinationId": other, "trigger": "delay", "delay": 2500 }),
    );
    assert_eq!(e.doc.get(btn).unwrap().interactions[2].delay_ms, 2500.0);
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "destinationId": home, "trigger": "delay" }),
    );
    let i = &e.doc.get(btn).unwrap().interactions;
    assert_eq!((i.len(), i[2].delay_ms), (3, 800.0));
  }

  #[test]
  fn a_url_alone_opens_the_link() {
    let (mut e, ids) = screens();
    run(&mut e, "set_prototype", json!({ "nodeId": ids[2], "url": "https://example.com" }));
    let i = &e.doc.get(&ids[2]).unwrap().interactions[0];
    assert_eq!((i.action, i.url.as_deref()), (Action::OpenUrl, Some("https://example.com")));
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
    assert_eq!(card.stroke_style.as_deref(), Some(e.doc.styles.colors[1].id.as_str()));
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
  fn effect_grid_and_stroke_styles_through_the_tools() {
    let mut e = engine();
    run(
      &mut e,
      "define_styles",
      json!({ "colors": [{ "name": "Ink", "color": "#111827" }],
        "effects": [{ "name": "Shadow/Card", "shadow": { "y": 8, "blur": 24, "color": "#00000040" }, "description": "Cards" },
                    { "name": "Glass", "backgroundBlur": 12 }],
        "grids": [{ "name": "Grid/12", "grids": [{ "pattern": "columns", "count": 12, "gutter": 24 }] }] }),
    );
    assert_eq!(e.doc.styles.effects.len(), 2);
    assert_eq!(e.doc.styles.effects[0].description, "Cards");
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Card", "width": 200, "height": 100, "effectStyle": "Shadow/Card",
        "gridStyle": "grid/12", "strokeStyle": "Ink" }] }),
    );
    assert!(r.get("warnings").is_none(), "no unknown-key warnings: {r}");
    let id = r["created"][0]["id"].as_str().unwrap().to_string();
    let n = e.doc.get(&id).unwrap().clone();
    assert_eq!(n.effect_style.as_deref(), Some(e.doc.styles.effects[0].id.as_str()));
    assert_eq!(n.effects, e.doc.styles.effects[0].effects);
    assert_eq!(n.layout_grids.len(), 1);
    assert_eq!(n.grid_style.as_deref(), Some(e.doc.styles.grids[0].id.as_str()));
    assert_eq!(
      n.stroke_style.as_deref(),
      Some(e.doc.styles.colors[0].id.as_str()),
      "strokeStyle links now"
    );
    // Redefining a style updates its layers.
    run(
      &mut e,
      "define_styles",
      json!({ "effects": [{ "name": "Shadow/Card", "shadow": { "y": 2, "blur": 4 } }] }),
    );
    assert_eq!(e.doc.get(&id).unwrap().effects[0].blur, 4.0);
    // Update: switch style, then unlink with null (values stay).
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": id, "effectStyle": "Glass" }] }));
    let n = e.doc.get(&id).unwrap();
    assert_eq!(
      n.effect_style.as_deref(),
      Some(e.doc.styles.effects[1].id.as_str()),
      "the new style stays linked"
    );
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "effectStyle": null, "strokeStyle": null }] }),
    );
    let n = e.doc.get(&id).unwrap();
    assert!(n.effect_style.is_none() && n.stroke_style.is_none() && !n.effects.is_empty());
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "effectStyle": "Shadw/Card" }] }),
      ))
      .unwrap_err();
    assert!(err.starts_with("nodes[0].effectStyle:") && err.contains("Shadow/Card"), "{err}");
    let d = run(&mut e, "get_document", json!({}));
    assert_eq!(d["effectStyles"][0]["name"], "Shadow/Card");
    assert_eq!(d["gridStyles"][0]["name"], "Grid/12");
  }

  #[test]
  fn variable_aliases_and_scopes_through_the_tools() {
    let mut e = engine();
    run(
      &mut e,
      "define_variables",
      json!({ "collection": "Tokens", "variables": [
        { "name": "Space/base", "type": "number", "value": 8, "scopes": ["gap"] },
        { "name": "Space/card", "type": "number", "value": { "alias": "Tokens/Space/base" } },
        { "name": "Radius/md", "type": "number", "value": 12 } ] }),
    );
    let c = &e.doc.variables[0];
    assert_eq!(c.variables[0].scopes, ["gap"]);
    assert_eq!(
      c.variables[1].values.values().next().unwrap(),
      &json!({ "alias": c.variables[0].id }),
      "stored by id"
    );
    let err = e
      .dispatch(ai(
        "define_variables",
        json!({ "collection": "Tokens", "variables": [{ "name": "Space/base", "type": "number", "value": { "alias": "Space/card" } }] }),
      ))
      .unwrap_err();
    assert!(err.contains("alias cycle"), "{err}");
    let err = e
      .dispatch(ai(
        "define_variables",
        json!({ "collection": "Tokens", "variables": [{ "name": "x", "type": "number", "scopes": ["nope"] }] }),
      ))
      .unwrap_err();
    assert!(err.contains("unknown scope"), "{err}");
    // Binding outside the scope still works and only warns.
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "width": 100, "height": 100, "bind": { "cornerRadius": "Space/base", "paddingLeft": "Space/card" } }] }),
    );
    assert!(r["warnings"].to_string().contains("scoped to gap"), "{r}");
    let n = e.doc.get(r["created"][0]["id"].as_str().unwrap()).unwrap();
    assert_eq!(n.corner_radius, 8.0);
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
    assert_eq!(d["layers"][9]["children"][19]["childCount"], 4);
    assert!(d["layers"][9]["children"][19].get("children").is_none());
    assert_eq!(d["layers"][0]["children"][0]["children"].as_array().unwrap().len(), 4);
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

mod hostile {
  use super::*;

  #[test]
  fn regexes_cannot_crash_or_hang_the_search() {
    let mut e = engine();
    one(
      &mut e,
      json!({ "type": "frame", "name": "x".repeat(100_000), "width": 5, "height": 5 }),
    );
    for pattern in ["/^{100000}x/", "/(a?){100000}/", "/a{100000}/", "/\\bx/", "/(/"] {
      let r = e.dispatch(ai("find_nodes", json!({ "name": pattern })));
      assert!(r.is_err(), "{pattern}");
    }
    // Linear in the text: a very long name is fine.
    let r = run(&mut e, "find_nodes", json!({ "name": "/.*x$/" }));
    assert_eq!(r["total"], 1);
    let r = run(&mut e, "find_nodes", json!({ "name": "/.*z/" }));
    assert_eq!(r["total"], 0);
  }

  #[test]
  fn an_expensive_pattern_over_many_layers_is_an_error_not_a_hang() {
    let mut e = engine();
    let layers: Vec<Value> = (0..1000)
      .map(|i| json!({ "type": "rectangle", "name": format!("{}{i}", "a".repeat(40)), "width": 2, "height": 2 }))
      .collect();
    run(&mut e, "create_nodes", json!({ "nodes": layers }));
    let start = std::time::Instant::now();
    let err = e.dispatch(ai("find_nodes", json!({ "name": "/(a?){500}a{500}$/" }))).unwrap_err();
    assert!(err.contains("too complex"), "{err}");
    assert!(start.elapsed().as_secs_f64() < 5.0, "{:?}", start.elapsed());
    // A plain pattern over the same layers is fine.
    let r = run(&mut e, "find_nodes", json!({ "name": "/^a+9$/" }));
    assert_eq!(r["total"], 1);
  }
}

mod big_files {
  use super::*;

  /// Plain patterns must work on a big file: the budget grows with the names searched.
  #[test]
  fn simple_patterns_succeed_over_twenty_thousand_layers() {
    let mut e = engine();
    for chunk in 0..4 {
      let layers: Vec<Value> = (0..5000)
        .map(|i| {
          let n = chunk * 5000 + i;
          json!({ "type": "rectangle", "name": format!("Heading {n} lorem ipsum dolor sit amet, label"), "x": n, "width": 2, "height": 2 })
        })
        .collect();
      run(&mut e, "create_nodes", json!({ "nodes": layers }));
    }
    run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "rectangle", "name": "Primary button", "x": -50, "width": 2, "height": 2 }] }),
    );
    for (pattern, total) in [("/(foo|bar|baz|lorem)/", 20_000), ("/[a-z]+ [a-z]+ ago/", 0), ("/.*button.*/", 1)] {
      let r = run(&mut e, "find_nodes", json!({ "name": pattern }));
      assert_eq!(r["total"], total, "{pattern}");
    }
  }
}

mod flat {
  use super::*;

  fn thousands() -> Vec<Value> {
    (0..3000)
      .map(|i| json!({ "type": "rectangle", "name": format!("Layer {i}"), "x": i, "width": 5, "height": 5, "fill": "#FF0000" }))
      .collect()
  }

  #[test]
  fn thousands_of_roots_stay_small_in_get_document_and_create_nodes() {
    let mut e = engine();
    let r = run(&mut e, "create_nodes", json!({ "nodes": thousands() }));
    assert_eq!(r["createdTruncated"], true);
    assert_eq!(r["createdCount"], 3000);
    assert!(r["created"][0]["id"].is_string() && r["created"][0]["name"] == "Layer 0");
    assert!(serde_json::to_string(&r).unwrap().len() < 20_000);
    let d = run(&mut e, "get_document", json!({}));
    let size = serde_json::to_string(&d).unwrap().len();
    assert!(size < 40_000, "{size} bytes");
    assert_eq!(d["layers"].as_array().unwrap().len(), 250);
    assert_eq!(d["moreLayers"], 2750);
    assert!(d["truncated"].is_string());
  }

  #[test]
  fn the_outline_fills_breadth_first_and_children_are_always_arrays() {
    let mut e = engine();
    // One screen with a deep branch and many shallow ones: every branch gets its top levels.
    let deep = json!({ "type": "frame", "name": "Deep", "width": 10, "height": 10, "children": [{ "type": "frame", "width": 5, "height": 5, "children": [{ "type": "frame", "width": 2, "height": 2, "children": [{ "type": "rectangle", "width": 1, "height": 1 }] }] }] });
    let shallow: Vec<Value> = (0..100)
      .map(|i| json!({ "type": "frame", "name": format!("S{i}"), "width": 10, "height": 10, "children": [{ "type": "rectangle", "width": 1, "height": 1 }, { "type": "rectangle", "width": 1, "height": 1 }] }))
      .collect();
    let mut kids = vec![deep];
    kids.extend(shallow);
    run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Screen", "width": 400, "height": 400, "children": kids }] }),
    );
    let d = run(&mut e, "get_document", json!({ "depth": 6 }));
    let screen = &d["layers"][0];
    assert_eq!(screen["children"].as_array().unwrap().len(), 101);
    // 1 + 101 + 1 + 200 + 1 + 1 = 305 layers: the deepest few are left out, never a whole branch.
    assert!(d["truncated"].is_string());
    let last = &screen["children"][100];
    assert!(last["children"].is_array() || last["childCount"] == 2);
    fn all_children_are_arrays(v: &Value) -> bool {
      match v.get("children") {
        None => true,
        Some(c) => c.as_array().is_some_and(|a| a.iter().all(all_children_are_arrays)),
      }
    }
    assert!(all_children_are_arrays(&d["layers"][0]));
  }

  #[test]
  fn created_layers_also_list_grandchildren_within_a_budget() {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Card", "width": 100, "children": [
        { "type": "frame", "name": "Row", "width": 50, "children": [{ "type": "text", "name": "Title", "text": "Hi" }] }] }] }),
    );
    assert_eq!(r["created"][0]["children"][0]["children"][0]["name"], "Title");
    // A big tree keeps the whole answer small.
    let rows: Vec<Value> = (0..250)
      .map(|i| {
        json!({ "type": "frame", "name": format!("Row {i}"), "width": 5, "children": [
        { "type": "rectangle", "width": 1, "height": 1 }, { "type": "rectangle", "width": 1, "height": 1 }] })
      })
      .collect();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "x": 900, "width": 100, "children": rows }] }),
    );
    let listed = serde_json::to_string(&r["created"]).unwrap().matches("\"id\"").count();
    assert!(listed <= 152, "{listed}");
    assert_eq!(r["created"][0]["childCount"], 250);
  }

  #[test]
  fn created_layers_list_their_direct_children() {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Card", "width": 100, "children": [
        { "type": "text", "name": "Title", "text": "Hi" }, { "type": "rectangle", "name": "Bar", "width": 5, "height": 5 }] }] }),
    );
    let c = &r["created"][0];
    assert_eq!(c["childCount"], 2);
    assert_eq!(c["children"][0]["name"], "Title");
    assert_eq!(c["children"][1]["type"], "rectangle");
    assert_eq!(c["children"][1]["id"], r["names"]["Bar"]);
    let many: Vec<Value> = (0..80).map(|_| json!({ "type": "rectangle", "width": 1, "height": 1 })).collect();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "width": 100, "x": 500, "children": many }] }),
    );
    assert_eq!(r["created"][0]["children"].as_array().unwrap().len(), 50);
    assert_eq!(r["created"][0]["childCount"], 80);
  }
}

mod strictness {
  use super::*;

  #[test]
  fn find_nodes_type_knows_every_kind_and_images() {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [
        { "type": "component", "name": "Btn", "width": 10, "height": 10 },
        { "type": "rectangle", "name": "Plain", "x": 100, "width": 10, "height": 10 },
        { "type": "rectangle", "name": "Photo", "x": 200, "width": 10, "height": 10, "imageUrl": "asset:a" }] }),
    );
    let btn = created(&r)[0].clone();
    run(&mut e, "create_instance", json!({ "componentId": btn, "x": 300 }));
    assert_eq!(run(&mut e, "find_nodes", json!({ "type": "instance" }))["total"], 1);
    assert_eq!(run(&mut e, "find_nodes", json!({ "type": "image" }))["nodes"][0]["name"], "Photo");
    assert_eq!(run(&mut e, "find_nodes", json!({ "type": "image" }))["total"], 1);
    assert_eq!(run(&mut e, "find_nodes", json!({ "type": "rectangle" }))["total"], 2);
    assert_eq!(run(&mut e, "find_nodes", json!({ "type": "component_set" }))["total"], 0);
    assert!(e.dispatch(ai("find_nodes", json!({ "type": "blob" }))).is_err());
    // A component id that isn't a component, and a `within` on another page.
    assert!(e.dispatch(ai("find_nodes", json!({ "componentId": "n_missing" }))).is_err());
    assert!(e
      .dispatch(ai("find_nodes", json!({ "componentId": r["created"][1]["id"] })))
      .is_err());
    run(&mut e, "pages", json!({ "action": "add", "name": "Two" }));
    let page2 = e.doc.pages[1].id.clone();
    run(&mut e, "pages", json!({ "action": "switch", "id": page2 }));
    let err = e.dispatch(ai("find_nodes", json!({ "within": btn }))).unwrap_err();
    assert!(err.contains("page"), "{err}");
    assert!(e.dispatch(ai("find_nodes", json!({ "within": btn, "page": "all" }))).is_ok());
  }

  #[test]
  fn values_that_used_to_be_ignored_are_read_or_rejected() {
    let mut e = engine();
    let id = one(
      &mut e,
      json!({ "type": "text", "text": "x", "visible": "false", "italic": "true", "locked": "TRUE" }),
    );
    let n = e.doc.get(&id).unwrap();
    assert!(!n.visible && n.locked && n.text.as_ref().unwrap().italic);
    for bad in [json!("maybe"), json!(2), json!([])] {
      assert!(e
        .dispatch(ai("create_nodes", json!({ "nodes": [{ "type": "rectangle", "visible": bad }] })))
        .is_err());
    }
    let id = one(
      &mut e,
      json!({ "type": "rectangle", "x": 900, "width": 5, "height": 5, "visible": 0, "locked": 1 }),
    );
    assert!(!e.doc.get(&id).unwrap().visible && e.doc.get(&id).unwrap().locked);
    let id = one(
      &mut e,
      json!({ "type": "rectangle", "width": 5, "height": 5, "strokeDash": ["4", "2px"], "stroke": "#000" }),
    );
    assert_eq!(e.doc.get(&id).unwrap().stroke_dash, vec![4.0, 2.0]);
    assert!(e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "rectangle", "strokeDash": ["a"] }] })
      ))
      .is_err());
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "text", "text": "x", "fontWeight": 5 }] }),
      ))
      .unwrap_err();
    assert!(err.contains("fontWeight"), "{err}");
    let id = one(
      &mut e,
      json!({ "type": "frame", "width": 50, "height": 50, "layout": { "padding": "8px 16px" }, "cornerRadius": "4px 8px" }),
    );
    let n = e.doc.get(&id).unwrap();
    let l = n.layout.clone().unwrap();
    assert_eq!(
      (l.padding_top, l.padding_right, l.padding_bottom, l.padding_left),
      (8.0, 16.0, 8.0, 16.0)
    );
    assert_eq!(n.corner_radii, Some([4.0, 8.0, 4.0, 8.0]));
    // `none` clears shadows like null does.
    let id = one(
      &mut e,
      json!({ "type": "rectangle", "width": 5, "height": 5, "shadow": "0 4px 12px rgba(0,0,0,0.1)" }),
    );
    assert_eq!(e.doc.get(&id).unwrap().effects.len(), 1);
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": id, "shadow": "none" }] }));
    assert!(e.doc.get(&id).unwrap().effects.is_empty());
  }

  #[test]
  fn opacity_is_a_percentage_only_from_two_up() {
    let mut e = engine();
    let opacity = |e: &mut Engine, v: Value| -> (f64, Value) {
      let r = run(
        e,
        "create_nodes",
        json!({ "nodes": [{ "type": "rectangle", "width": 5, "height": 5, "opacity": v }] }),
      );
      let id = r["created"][0]["id"].as_str().unwrap().to_string();
      (e.doc.get(&id).unwrap().opacity, r["warnings"].clone())
    };
    assert_eq!(opacity(&mut e, json!(0.5)), (0.5, Value::Null));
    assert_eq!(opacity(&mut e, json!(1)), (1.0, Value::Null));
    let (o, w) = opacity(&mut e, json!(1.5));
    assert_eq!(o, 1.0);
    assert!(w[0].as_str().unwrap().contains("clamped"));
    let (o, w) = opacity(&mut e, json!(50));
    assert_eq!(o, 0.5);
    assert!(w[0].as_str().unwrap().contains("50%"));
    let (o, w) = opacity(&mut e, json!(500));
    assert_eq!(o, 1.0);
    assert!(w[0].as_str().unwrap().contains("clamped"));
  }

  #[test]
  fn update_type_warns_and_move_takes_string_numbers() {
    let mut e = engine();
    let id = one(&mut e, json!({ "type": "rectangle", "width": 5, "height": 5 }));
    let r = run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "type": "frame" }, { "id": id, "type": "rectangle", "name": "Same" }] }),
    );
    assert_eq!(r["warnings"].as_array().unwrap().len(), 1, "{r}");
    assert_eq!(e.doc.get(&id).unwrap().kind, crate::model::NodeType::Rectangle);
    run(&mut e, "move_nodes", json!({ "ids": [id], "x": "120", "y": "30px" }));
    assert_eq!((e.doc.get(&id).unwrap().x, e.doc.get(&id).unwrap().y), (120.0, 30.0));
    assert!(e.dispatch(ai("move_nodes", json!({ "ids": [id], "x": "far", "y": 3 }))).is_err());
  }

  #[test]
  fn radial_gradients_keep_rgba_stops_whole() {
    let mut e = engine();
    let id = one(
      &mut e,
      json!({ "type": "rectangle", "width": 5, "height": 5, "fill": "radial-gradient(circle, rgba(255, 0, 0, 0.5) 0%, rgb(0, 0, 255) 100%)" }),
    );
    match &e.doc.get(&id).unwrap().fills[0] {
      crate::model::Paint::RadialGradient { stops, .. } => assert_eq!(stops.len(), 2),
      other => panic!("{other:?}"),
    }
  }

  #[test]
  fn update_nodes_schema_carries_types_not_descriptions() {
    let defs = crate::ai::tool_defs();
    let size = |name: &str| {
      let d = defs.as_array().unwrap().iter().find(|d| d["name"] == name).unwrap();
      serde_json::to_string(&d["input_schema"]).unwrap().len()
    };
    assert!(size("update_nodes") < 4_000, "{}", size("update_nodes"));
    assert!(size("create_nodes") > size("update_nodes"));
    let update = defs.as_array().unwrap().iter().find(|d| d["name"] == "update_nodes").unwrap();
    assert!(update["input_schema"]["properties"]["updates"]["items"]["properties"]["fillStyle"]["description"].is_null());
    assert!(update["input_schema"]["properties"]["updates"]["items"]["properties"]["fillStyle"]["type"].is_array());
  }
}

mod device {
  use super::*;

  fn screen(e: &mut Engine, device: Value) -> String {
    one(
      e,
      json!({ "type": "frame", "name": "Home", "device": device,
        "layout": { "direction": "vertical", "gap": 8, "padding": 16 },
        "children": [{ "type": "text", "text": "Welcome" }] }),
    )
  }

  #[test]
  fn create_nodes_sizes_the_frame_and_adds_the_safe_area_to_the_padding() {
    let mut e = engine();
    let id = screen(&mut e, json!("iphone-17-pro"));
    let n = e.doc.get(&id).unwrap();
    assert_eq!((n.width, n.height), (402.0, 874.0));
    let l = n.layout.clone().unwrap();
    assert_eq!((l.padding_top, l.padding_bottom, l.padding_left), (78.0, 50.0, 16.0));
    assert_eq!(n.device.as_ref().unwrap().preset, "iphone-17-pro");
    assert_eq!(n.sizing_v, Sizing::Fixed);
    // Content comes first, the system UI is the last layers.
    let names: Vec<String> = n.children.iter().map(|c| e.doc.get(c).unwrap().name.clone()).collect();
    assert_eq!(names, ["Welcome", "Status bar", "Home indicator"]);
    // A given size wins over the preset's.
    let sized = one(
      &mut e,
      json!({ "type": "frame", "width": 500, "height": 900, "device": { "preset": "pixel-9", "theme": "dark" } }),
    );
    let n = e.doc.get(&sized).unwrap();
    assert_eq!((n.width, n.height), (500.0, 900.0));
    assert_eq!(n.device.as_ref().unwrap().theme, "dark");
  }

  #[test]
  fn a_bad_preset_is_an_error_that_names_the_field_and_suggests_ids() {
    let mut e = engine();
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "device": "iphone-17-prp" }] }),
      ))
      .unwrap_err();
    assert!(err.contains("nodes[0].device") && err.contains("iphone-17-pro"), "{err}");
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "device": { "preset": "pixel-9", "theme": "pink" } }] }),
      ))
      .unwrap_err();
    assert!(err.contains("nodes[0].device") && err.contains("theme"), "{err}");
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "rectangle", "device": "pixel-9" }] }),
      ))
      .unwrap_err();
    assert!(err.contains("frame"), "{err}");
    assert!(e.doc.nodes.is_empty() || e.doc.nodes.values().all(|n| n.kind != crate::model::NodeType::Rectangle));
  }

  #[test]
  fn update_nodes_changes_the_theme_and_removes_the_device() {
    let mut e = engine();
    let id = screen(&mut e, json!("iphone-16"));
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "device": { "theme": "dark", "statusBar": false } }] }),
    );
    let n = e.doc.get(&id).unwrap();
    assert_eq!((n.width, n.height), (393.0, 852.0), "same preset: no resize");
    assert_eq!(n.layout.as_ref().unwrap().padding_top, 16.0);
    assert!(n.device.as_ref().unwrap().theme == "dark" && !n.device.as_ref().unwrap().status_bar);
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "device": "ipad-air-11" }] }),
    );
    assert_eq!(e.doc.get(&id).unwrap().width, 820.0);
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "layout": { "padding": 8 } }] }),
    );
    assert_eq!(
      e.doc.get(&id).unwrap().layout.as_ref().unwrap().padding_bottom,
      28.0,
      "8 plus the iPad's 20"
    );
    run(&mut e, "update_nodes", json!({ "updates": [{ "id": id, "device": null }] }));
    let n = e.doc.get(&id).unwrap();
    assert!(n.device.is_none());
    assert_eq!(n.children.len(), 1);
    assert_eq!(n.layout.as_ref().unwrap().padding_bottom, 8.0);
  }

  #[test]
  fn adding_and_removing_auto_layout_by_update_keeps_the_chrome_and_padding_right() {
    let mut e = engine();
    let id = one(&mut e, json!({ "type": "frame", "name": "Home", "device": "iphone-17-pro" }));
    assert!(e.doc.get(&id).unwrap().layout.is_none());
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "layout": { "direction": "vertical", "padding": 8 } }] }),
    );
    let n = e.doc.get(&id).unwrap();
    assert_eq!((n.sizing_h, n.sizing_v, n.height), (Sizing::Fixed, Sizing::Fixed, 874.0));
    let l = n.layout.clone().unwrap();
    assert_eq!((l.padding_top, l.padding_bottom), (70.0, 42.0));
    assert!(n
      .children
      .iter()
      .filter_map(|c| e.doc.get(c))
      .filter(|c| c.device_part.is_some())
      .all(|c| c.absolute_position));
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "patch": { "layout": null } }] }),
    );
    let n = e.doc.get(&id).unwrap();
    assert!(n.layout.is_none());
    assert_eq!(n.device.as_ref().unwrap().applied, [0.0; 4], "no stale insets");
    assert!(n
      .children
      .iter()
      .filter_map(|c| e.doc.get(c))
      .filter(|c| c.device_part.is_some())
      .all(|c| !c.absolute_position));
  }

  #[test]
  fn a_device_and_padding_in_one_update_use_the_new_padding_once() {
    let mut e = engine();
    let id = screen(&mut e, json!("iphone-16"));
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "device": "iphone-17", "layout": { "padding": 16 } }] }),
    );
    let l = e.doc.get(&id).unwrap().layout.clone().unwrap();
    assert_eq!((l.padding_top, l.padding_bottom), (78.0, 50.0));
  }

  #[test]
  fn system_ui_is_not_a_parent() {
    let mut e = engine();
    let id = screen(&mut e, json!("iphone-17"));
    let bar = e
      .doc
      .get(&id)
      .unwrap()
      .children
      .iter()
      .find(|c| e.doc.get(c).unwrap().device_part.as_deref() == Some("statusBar"))
      .unwrap()
      .clone();
    let err = e
      .dispatch(ai(
        "create_nodes",
        json!({ "parentId": bar, "nodes": [{ "type": "text", "text": "x" }] }),
      ))
      .unwrap_err();
    assert!(err.contains("system UI") && err.contains(&id), "{err}");
  }

  #[test]
  fn new_children_go_below_the_system_ui_and_the_outline_stays_compact() {
    let mut e = engine();
    let id = screen(&mut e, json!("iphone-17"));
    let added = created(&run(
      &mut e,
      "create_nodes",
      json!({ "parentId": id, "nodes": [{ "type": "text", "text": "More" }] }),
    ))[0]
      .clone();
    let n = e.doc.get(&id).unwrap();
    assert_eq!(n.children.iter().position(|c| *c == added), Some(1), "before the status bar");
    let r = run(&mut e, "get_nodes", json!({ "ids": [id], "depth": 3 }));
    let outline = &r[0]["outline"];
    assert_eq!(outline["device"], "iphone-17");
    let kids = outline["children"].as_array().unwrap();
    let bar = kids.iter().find(|k| k["devicePart"] == "statusBar").unwrap();
    assert_eq!(bar["name"], "Status bar");
    assert!(bar.get("children").is_none() && bar.get("type").is_none(), "{bar}");
  }
}

mod r9_p2 {
  use super::*;

  fn variable_err(kind: &str, value: Value) -> String {
    let mut e = engine();
    e.dispatch(ai(
      "define_variables",
      json!({ "collection": "C", "modes": ["Light", "Dark"], "variables": [{ "name": "V", "type": kind, "values": { "Dark": value } }] }),
    ))
    .unwrap_err()
  }

  #[test]
  fn variable_values_must_fit_their_type() {
    for (kind, bad) in [
      ("number", json!("banana")),
      ("number", json!(true)),
      ("color", json!(12)),
      ("color", json!("not-a-colour")),
      ("boolean", json!("yes")),
      ("string", json!(3)),
    ] {
      let err = variable_err(kind, bad.clone());
      assert!(err.contains("V (Dark)"), "{kind} {bad}: {err}");
    }
    // Good values pass; a numeric string becomes a number; aliases are left to the alias check.
    let mut e = engine();
    e.dispatch(ai(
      "define_variables",
      json!({ "collection": "C", "variables": [
        { "name": "N", "type": "number", "value": "16" },
        { "name": "B", "type": "boolean", "value": false },
        { "name": "S", "type": "string", "value": "hi" },
        { "name": "K", "type": "color", "value": "#f00" }] }),
    ))
    .unwrap();
    let c = &e.doc.variables[0];
    let n = c.variables.iter().find(|v| v.name == "N").unwrap();
    assert_eq!(n.values.values().next().unwrap(), &json!(16.0));
  }

  #[test]
  fn a_rejected_variable_call_changes_nothing() {
    let mut e = engine();
    let _ = variable_err("number", json!("x"));
    let r = e.dispatch(ai(
      "define_variables",
      json!({ "collection": "C", "variables": [{ "name": "Ok", "type": "number", "value": 1 }, { "name": "Bad", "type": "number", "value": "x" }] }),
    ));
    assert!(r.is_err());
    assert!(e.doc.variables.is_empty());
  }

  #[test]
  fn create_component_on_several_layers_makes_one_each() {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [
        { "type": "rectangle", "name": "A", "width": 20, "height": 20 },
        { "type": "rectangle", "name": "B", "x": 40, "width": 20, "height": 20 },
        { "type": "frame", "name": "C", "x": 80, "width": 20, "height": 20 }] }),
    );
    let ids = created(&r);
    let before = e.doc.nodes.len();
    let r = run(&mut e, "arrange", json!({ "action": "create_component", "ids": ids }));
    assert_eq!(r["ids"].as_array().unwrap().len(), 3, "{r}");
    let comps = e.doc.nodes.values().filter(|n| n.kind == crate::model::NodeType::Component).count();
    assert_eq!(comps, 3);
    // Two wrappers (the frame was already a frame): 3 + 2 new nodes.
    assert_eq!(e.doc.nodes.len(), before + 2);
    // One undo step.
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(
      e.doc.nodes.values().filter(|n| n.kind == crate::model::NodeType::Component).count(),
      0
    );
    assert_eq!(e.doc.nodes.len(), before);
  }

  #[test]
  fn create_components_is_an_edit() {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "rectangle" }, { "type": "rectangle" }] }),
    );
    let ids = created(&r);
    e.dispatch(Command::SetReadOnly { on: true }).unwrap();
    let err = e.dispatch(Command::CreateComponents { ids }).unwrap_err();
    assert_eq!(err, crate::engine::READ_ONLY);
  }

  #[test]
  fn moving_a_layer_into_itself_or_a_descendant_fails() {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Outer", "width": 200, "height": 200, "children": [
        { "type": "frame", "name": "Inner", "width": 50, "height": 50 }] }] }),
    );
    let outer = created(&r)[0].clone();
    let inner = e.doc.get(&outer).unwrap().children[0].clone();
    let err = e
      .dispatch(ai("move_nodes", json!({ "ids": [outer], "parentId": outer })))
      .unwrap_err();
    assert!(err.contains(&outer) && err.contains("itself"), "{err}");
    let err = e
      .dispatch(ai("move_nodes", json!({ "ids": [outer], "parentId": inner })))
      .unwrap_err();
    assert!(err.contains(&outer) && err.contains("descendants"), "{err}");
    assert_eq!(e.doc.get(&inner).unwrap().parent.as_deref(), Some(outer.as_str()));
  }

  #[test]
  fn fix_issues_rejects_unknown_kinds_and_arrange_unknown_ids() {
    let mut e = engine();
    let err = e
      .dispatch(ai("fix_issues", json!({ "kinds": ["lowContrast", "bogus"] })))
      .unwrap_err();
    assert!(err.contains("bogus") && err.contains("offGrid"), "{err}");
    let err = e
      .dispatch(ai("arrange", json!({ "action": "group", "ids": ["n_ghost"] })))
      .unwrap_err();
    assert!(err.contains("n_ghost"), "{err}");
  }

  #[test]
  fn component_prop_errors_name_the_op() {
    let mut e = engine();
    let err = e
      .dispatch(ai("set_component_props", json!({ "ops": [{ "nonsense": 1 }] })))
      .unwrap_err();
    assert!(err.starts_with("ops[0]"), "{err}");
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

#[test]
fn paint_specs_accept_conic_diamond_handles_and_stroke_keys() {
  use crate::model::{Paint, StrokeJoin};
  let mut e = Engine::new(Box::new(crate::text::HeuristicMeasurer), 3);
  let id = one(
    &mut e,
    json!({ "type": "rectangle", "width": 100, "height": 60, "fill": "conic-gradient(red, blue)" }),
  );
  assert!(matches!(&e.doc.get(&id).unwrap().fills[0], Paint::AngularGradient { stops, handles: None, .. } if stops.len() == 2));
  let id = one(
    &mut e,
    json!({ "type": "rectangle", "width": 100, "height": 60, "fill": "conic-gradient(from 90deg at 25% 75%, #f00 0%, #00f 100%)" }),
  );
  match &e.doc.get(&id).unwrap().fills[0] {
    Paint::AngularGradient { handles: Some(h), .. } => {
      assert_eq!(h.start, [0.25, 0.75]);
      assert!((h.end[0] - 0.75).abs() < 1e-9 && (h.end[1] - 0.75).abs() < 1e-9);
    }
    other => panic!("{other:?}"),
  }
  let id = one(
    &mut e,
    json!({ "type": "rectangle", "width": 100, "height": 60,
      "fill": { "type": "diamondGradient", "stops": [{ "color": "#fff", "position": 0 }, { "color": "#000", "position": 1 }],
        "handles": { "start": [0.5, 0.5], "end": [1, 0.5], "width": [0.5, 1] } },
      "stroke": "#000", "strokeWeights": [4, 0, 0, 0], "strokeJoin": "bevel" }),
  );
  let n = e.doc.get(&id).unwrap();
  assert!(matches!(&n.fills[0], Paint::DiamondGradient { handles: Some(_), .. }));
  assert_eq!(n.stroke_weights, Some([4.0, 0.0, 0.0, 0.0]));
  assert_eq!(n.stroke_join, Some(StrokeJoin::Bevel));
  let id = one(
    &mut e,
    json!({ "type": "rectangle", "width": 10, "height": 10, "strokeWeights": { "top": 2, "left": 1 } }),
  );
  assert_eq!(e.doc.get(&id).unwrap().stroke_weights, Some([2.0, 0.0, 0.0, 1.0]));
  for bad in [json!([1, 2]), json!("thick")] {
    assert!(e
      .dispatch(ai(
        "create_nodes",
        json!({ "nodes": [{ "type": "rectangle", "strokeWeights": bad }] })
      ))
      .is_err());
  }
  assert!(e
    .dispatch(ai(
      "create_nodes",
      json!({ "nodes": [{ "type": "rectangle", "strokeJoin": "sharp" }] })
    ))
    .is_err());
}

mod w3a_prototype {
  use super::*;
  use crate::model::{Direction, Easing, Trigger};

  /// Variants Off, On, A, B (not yet in sets) and a plain frame.
  fn sets() -> (Engine, [String; 4], String) {
    let mut e = engine();
    let r = run(
      &mut e,
      "create_nodes",
      json!({ "nodes": [
        { "type": "frame", "name": "Off", "width": 40, "height": 20, "children": [{ "type": "rectangle", "name": "Knob", "width": 10, "height": 10 }] },
        { "type": "frame", "name": "On", "x": 100, "width": 40, "height": 20 },
        { "type": "frame", "name": "A", "x": 200, "width": 40, "height": 20 },
        { "type": "frame", "name": "B", "x": 300, "width": 40, "height": 20 },
        { "type": "frame", "name": "Page", "x": 400, "width": 300, "height": 300 }] }),
    );
    let ids = created(&r);
    (e, [ids[0].clone(), ids[1].clone(), ids[2].clone(), ids[3].clone()], ids[4].clone())
  }

  #[test]
  fn new_triggers_transitions_and_easing_are_validated_loudly() {
    let (mut e, ids) = super::prototype_screens();
    let (home, other, btn) = (&ids[0], &ids[1], &ids[2]);
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "destinationId": other, "trigger": "key", "key": "shift+k",
        "transition": "push", "direction": "up", "easing": "ease_in_out_back", "duration": 450 }),
    );
    let i = &e.doc.get(btn).unwrap().interactions[0];
    assert_eq!(
      (i.trigger, i.key.as_deref(), i.direction, i.easing, i.duration_ms),
      (Trigger::Key, Some("Shift+K"), Direction::Up, Easing::EaseInOutBack, 450.0)
    );
    // A different key is its own interaction; the same key replaces.
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "destinationId": home, "trigger": "key", "key": "Enter" }),
    );
    assert_eq!(e.doc.get(btn).unwrap().interactions.len(), 2);
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "destinationId": home, "trigger": "key", "key": "Shift+K" }),
    );
    assert_eq!(e.doc.get(btn).unwrap().interactions.len(), 2);
    let err = |e: &mut Engine, v: Value| e.dispatch(ai("set_prototype", v)).unwrap_err();
    assert!(err(&mut e, json!({ "nodeId": btn, "destinationId": home, "trigger": "key" })).contains("needs `key`"));
    assert!(err(
      &mut e,
      json!({ "nodeId": btn, "destinationId": home, "trigger": "key", "key": "Shift+K+L" })
    )
    .contains("more than one key"));
    let bad = err(&mut e, json!({ "nodeId": btn, "destinationId": home, "easing": "bouncy" }));
    assert!(
      bad.contains("bouncy") && bad.contains("ease_in_out_back") && bad.contains("linear"),
      "{bad}"
    );
    assert!(err(&mut e, json!({ "nodeId": btn, "destinationId": home, "direction": "sideways" })).contains("left, right, up, down"));
    for t in ["mouse_enter", "mouse_leave", "mouse_down", "mouse_up"] {
      run(
        &mut e,
        "set_prototype",
        json!({ "nodeId": btn, "destinationId": home, "trigger": t, "transition": "move_out" }),
      );
    }
  }

  #[test]
  fn export_svg_query_answers_a_bare_string_unless_asked_for_parts() {
    use crate::engine::Query;
    let (e, ids) = super::prototype_screens();
    let ask = |hide: Vec<String>, children_only, with_bounds| {
      e.query(Query::ExportSvg {
        id: ids[0].clone(),
        hide,
        children_only,
        with_bounds,
      })
      .unwrap()
    };
    assert!(ask(vec![], false, false).is_string());
    assert!(ask(vec![ids[2].clone()], false, false).is_string());
    let parts = ask(vec![], true, false);
    assert!(
      parts["svg"].as_str().unwrap().starts_with("<svg") && parts["width"].as_f64().unwrap() > 0.0,
      "{parts}"
    );
    let whole = ask(vec![], false, true);
    assert!(whole["svg"].is_string() && whole["x"].is_number(), "{whole}");
    // The old wire form (no new fields) still parses.
    let q: Query = serde_json::from_str(r#"{"q":"exportSvg","id":"a"}"#).unwrap();
    assert!(matches!(q, Query::ExportSvg { children_only: false, .. }));
  }

  #[test]
  fn a_fork_has_the_document_but_its_changes_stay_in_it() {
    let (mut e, ids) = super::prototype_screens();
    let mut f = e.fork(Box::new(HeuristicMeasurer));
    assert_eq!(f.doc, e.doc);
    // Its first delta carries only what it changes.
    assert_eq!(f.doc_delta(false), json!({ "same": true }));
    f.dispatch(Command::Update {
      ids: vec![ids[0].clone()],
      patch: json!({ "name": "Forked" }),
    })
    .unwrap();
    let d = f.doc_delta(false);
    assert_eq!(d["nodes"].as_object().map(|m| m.len()), Some(1), "{d}");
    assert_ne!(e.doc.get(&ids[0]).unwrap().name, "Forked");
    e.dispatch(Command::Update {
      ids: vec![ids[1].clone()],
      patch: json!({ "name": "Edited" }),
    })
    .unwrap();
    assert_ne!(f.doc.get(&ids[1]).unwrap().name, "Edited");
  }

  #[test]
  fn scroll_to_needs_a_layer_in_the_same_screen() {
    let (mut e, ids) = super::prototype_screens();
    let (home, other, btn) = (&ids[0], &ids[1], &ids[2]);
    run(
      &mut e,
      "set_prototype",
      json!({ "nodeId": btn, "action": "scroll_to", "destinationId": home }),
    );
    assert_eq!(e.doc.get(btn).unwrap().interactions[0].action, Action::ScrollTo);
    let msg = e
      .dispatch(ai(
        "set_prototype",
        json!({ "nodeId": btn, "action": "scroll_to", "destinationId": other }),
      ))
      .unwrap_err();
    assert!(msg.contains("same top-level frame"), "{msg}");
    assert!(e
      .dispatch(ai("set_prototype", json!({ "nodeId": btn, "action": "scroll_to" })))
      .is_err());
  }

  #[test]
  fn change_to_must_name_a_variant_of_the_same_set() {
    let (mut e, [off, on, a, b], page) = sets();
    let comp = |e: &mut Engine, id: String| {
      e.dispatch(Command::CreateComponent { ids: vec![id] }).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
    };
    let (off, on, a, b) = (comp(&mut e, off), comp(&mut e, on), comp(&mut e, a), comp(&mut e, b));
    let toggle = e
      .dispatch(Command::CombineVariants {
        ids: vec![off.clone(), on.clone()],
      })
      .unwrap();
    let toggle = toggle["id"].as_str().unwrap().to_string();
    let other = e.dispatch(Command::CombineVariants { ids: vec![a, b] }).unwrap();
    let other = other["id"].as_str().unwrap().to_string();
    for (set, name) in [(&toggle, "Toggle"), (&other, "Other")] {
      e.dispatch(Command::Update {
        ids: vec![set.clone()],
        patch: json!({ "name": name }),
      })
      .unwrap();
    }
    let kids = |e: &Engine, s: &str| e.doc.get(s).unwrap().children.clone();
    let (t, o) = (kids(&e, &toggle), kids(&e, &other));
    let knob = e.doc.get(&t[0]).unwrap().children[0].clone();
    let set = |e: &mut Engine, v: Value| e.dispatch(ai("set_prototype", v));
    // Without a destination.
    assert!(set(&mut e, json!({ "nodeId": t[0], "action": "change_to" })).is_err());
    // On a variant, and on a layer inside one.
    set(&mut e, json!({ "nodeId": t[0], "action": "change_to", "destinationId": t[1] })).unwrap();
    set(&mut e, json!({ "nodeId": knob, "action": "change_to", "destinationId": t[1] })).unwrap();
    assert_eq!(e.doc.get(&t[0]).unwrap().interactions[0].action, Action::ChangeTo);
    // A variant of a different set names the set the layer belongs to.
    let msg = set(&mut e, json!({ "nodeId": t[0], "action": "change_to", "destinationId": o[0] })).unwrap_err();
    assert!(msg.contains("Other") && msg.contains("Toggle"), "{msg}");
    // Not a variant at all, and a layer outside any set.
    let msg = set(&mut e, json!({ "nodeId": t[0], "action": "change_to", "destinationId": page })).unwrap_err();
    assert!(msg.contains("must be a variant"), "{msg}");
    let msg = set(&mut e, json!({ "nodeId": page, "action": "change_to", "destinationId": t[1] })).unwrap_err();
    assert!(msg.contains("nothing to change"), "{msg}");
  }
}

/// Home, Settings and a button inside Home: [home, settings, button].
fn prototype_screens() -> (Engine, Vec<String>) {
  let mut e = engine();
  let r = run(
    &mut e,
    "create_nodes",
    json!({ "nodes": [
      { "type": "frame", "name": "Home", "width": 300, "height": 300,
        "children": [{ "type": "rectangle", "name": "Go", "width": 50, "height": 20 }] },
      { "type": "frame", "name": "Settings", "x": 400, "width": 300, "height": 300 }] }),
  );
  let btn = r["names"]["Go"].as_str().unwrap().to_string();
  (e, vec![created(&r)[0].clone(), created(&r)[1].clone(), btn])
}

mod r10_p2 {
  use super::*;

  fn pinned_frame(e: &mut Engine) -> String {
    run(
      e,
      "define_variables",
      json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [
        { "name": "Surface/Page", "type": "color", "values": { "Light": "#FFFFFF", "Dark": "#0B0F19" } }] }),
    );
    one(
      e,
      json!({ "type": "frame", "name": "F1", "width": 200, "height": 200, "bind": { "fill": "Surface/Page" },
        "variableModes": { "Theme": "Light" } }),
    )
  }

  fn fill(e: &Engine, id: &str) -> String {
    match &e.doc.get(id).unwrap().fills[0] {
      crate::model::Paint::Solid { color, .. } => color.clone(),
      _ => String::new(),
    }
  }

  #[test]
  fn a_pinned_frame_switches_mode_by_name() {
    let mut e = engine();
    let id = pinned_frame(&mut e);
    assert_eq!(fill(&e, &id), "#FFFFFF");
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "variableModes": { "Theme": "Dark" } }] }),
    );
    assert_eq!(fill(&e, &id), "#0B0F19");
    assert_eq!(e.doc.get(&id).unwrap().variable_modes.len(), 1);
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "patch": { "variableModes": { "Theme": "Light" } } }] }),
    );
    assert_eq!(fill(&e, &id), "#FFFFFF");
    assert_eq!(e.doc.get(&id).unwrap().variable_modes.len(), 1);
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "patch": { "variableModes": { "Theme": "Dark" } } }] }),
    );
    assert_eq!(fill(&e, &id), "#0B0F19");
    // null clears the pin.
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "variableModes": { "Theme": null } }] }),
    );
    assert!(e.doc.get(&id).unwrap().variable_modes.is_empty());
    assert_eq!(fill(&e, &id), "#FFFFFF");
  }

  /// Two components named `a` and `b`, combined into a set; returns the set id.
  fn set_of(e: &mut Engine, a: &str, b: &str, x: f64) -> String {
    let r = run(
      e,
      "create_nodes",
      json!({ "nodes": [
        { "type": "rectangle", "name": a, "x": x, "y": 3000, "width": 10, "height": 10 },
        { "type": "rectangle", "name": b, "x": x + 50.0, "y": 3000, "width": 10, "height": 10 }] }),
    );
    let ids = created(&r);
    let made = run(e, "arrange", json!({ "action": "create_component", "ids": ids }));
    let comps: Vec<String> = made["ids"]
      .as_array()
      .unwrap()
      .iter()
      .map(|v| v.as_str().unwrap().to_string())
      .collect();
    run(e, "arrange", json!({ "action": "combine_variants", "ids": comps }))["id"]
      .as_str()
      .unwrap()
      .to_string()
  }

  #[test]
  fn sets_are_named_from_a_shared_prefix_and_default_names_differ() {
    let mut e = engine();
    let set = set_of(&mut e, "Button/Size=Small", "Button/Size=Large", 0.0);
    assert_eq!(e.doc.get(&set).unwrap().name, "Button");
    let kids: Vec<String> = e
      .doc
      .get(&set)
      .unwrap()
      .children
      .iter()
      .map(|c| e.doc.get(c).unwrap().name.clone())
      .collect();
    assert_eq!(kids, ["Size=Small", "Size=Large"]);
    let first = set_of(&mut e, "State=A", "State=B", 300.0);
    let second = set_of(&mut e, "State=C", "State=D", 600.0);
    let (a, b) = (e.doc.get(&first).unwrap().name.clone(), e.doc.get(&second).unwrap().name.clone());
    assert!(
      a.starts_with("Component Set") && b.starts_with("Component Set") && a != b,
      "{a} / {b}"
    );
  }

  #[test]
  fn set_component_props_takes_the_set_id_and_property_names() {
    let mut e = engine();
    let set = set_of(&mut e, "State=A", "State=B", 0.0);
    run(
      &mut e,
      "set_component_props",
      json!({ "ops": [{ "op": "add", "component": set, "name": "Disabled", "kind": "boolean", "default": false }] }),
    );
    run(
      &mut e,
      "set_component_props",
      json!({ "ops": [{ "op": "update", "component": set, "prop": "Disabled", "name": "Off" }] }),
    );
    let defs = crate::props::props_of(&e.doc, &set);
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0].name, "Off");
  }

  #[test]
  fn create_component_on_a_main_component_changes_nothing() {
    let mut e = engine();
    let rect = one(&mut e, json!({ "type": "rectangle", "name": "Chip", "width": 20, "height": 20 }));
    let comp = run(&mut e, "arrange", json!({ "action": "create_component", "ids": [rect] }))["id"]
      .as_str()
      .unwrap()
      .to_string();
    let count = e.doc.nodes.len();
    let again = run(&mut e, "arrange", json!({ "action": "create_component", "ids": [comp] }));
    assert_eq!(again["id"], json!(comp));
    assert!(
      again["warnings"][0].as_str().unwrap().contains("already a main component"),
      "{again}"
    );
    assert_eq!(e.doc.nodes.len(), count);
    assert!(e.doc.get(&comp).unwrap().parent.is_none());
    // Mixed with a plain layer: the plain one becomes a component, the main stays out of the wrapper.
    let other = one(
      &mut e,
      json!({ "type": "rectangle", "name": "Other", "x": 100, "width": 20, "height": 20 }),
    );
    let r = run(&mut e, "arrange", json!({ "action": "create_component", "ids": [comp, other] }));
    assert!(r["warnings"].is_array());
    assert!(e.doc.get(&comp).unwrap().parent.is_none());
    assert_eq!(
      e.doc.nodes.values().filter(|n| n.kind == crate::model::NodeType::Component).count(),
      2
    );
    // The same through the raw commands.
    let id = e.dispatch(Command::CreateComponent { ids: vec![comp.clone()] }).unwrap();
    assert_eq!(id["id"], json!(comp));
    let r = e.dispatch(Command::CreateComponents { ids: vec![comp.clone()] });
    assert!(r.is_err());
  }

  #[test]
  fn unpinning_a_dangling_collection_does_not_fail_the_update() {
    let mut e = engine();
    let id = pinned_frame(&mut e);
    e.doc
      .get_mut(&id)
      .unwrap()
      .variable_modes
      .insert("vc_gone".into(), "vm_gone".into());
    run(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": id, "name": "Renamed", "variableModes": { "vc_gone": null } }] }),
    );
    let n = e.doc.get(&id).unwrap();
    assert_eq!(n.name, "Renamed");
    assert!(!n.variable_modes.contains_key("vc_gone"));
  }

  #[test]
  fn a_selection_holding_a_main_component_cannot_become_a_component() {
    let mut e = engine();
    let frame = one(
      &mut e,
      json!({ "type": "frame", "width": 100, "height": 100, "children": [{ "type": "rectangle", "name": "Inner", "width": 10, "height": 10 }] }),
    );
    let inner = e.doc.get(&frame).unwrap().children[0].clone();
    run(&mut e, "arrange", json!({ "action": "create_component", "ids": [inner] }));
    let err = e.dispatch(Command::CreateComponent { ids: vec![frame.clone()] }).unwrap_err();
    assert!(err.contains("main component inside the selection"), "{err}");
    assert_ne!(e.doc.get(&frame).unwrap().kind, crate::model::NodeType::Component);
  }
}
