//! Tests for `arrange.rs`: page moves and copies, the Scale tool, tidy up and the selection scans.

use serde_json::{json, Value};

use crate::engine::{Command, Engine, Query};
use crate::geom::Rect;
use crate::interact::Handle;
use crate::model::{Interaction, NodeId, NodeType, Paint};
use crate::text::HeuristicMeasurer;

fn engine() -> Engine {
  Engine::new(Box::new(HeuristicMeasurer), 9)
}

fn create(e: &mut Engine, nodes: Value) {
  e.dispatch(Command::Ai {
    tool: "create_nodes".into(),
    input: json!({ "nodes": nodes }),
  })
  .unwrap();
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

fn all_named(e: &Engine, name: &str) -> Vec<NodeId> {
  e.doc.nodes.values().filter(|n| n.name == name).map(|n| n.id.clone()).collect()
}

fn query_ids(e: &Engine, q: Query) -> Vec<NodeId> {
  sorted(serde_json::from_value(e.query(q).unwrap()).unwrap())
}

fn sorted(mut v: Vec<NodeId>) -> Vec<NodeId> {
  v.sort();
  v
}

fn main_component(e: &mut Engine) -> NodeId {
  create(
    e,
    json!([{ "type": "frame", "name": "Btn", "x": 0, "y": 0, "width": 80, "height": 30,
    "children": [{ "type": "text", "name": "Label", "characters": "Go", "x": 4, "y": 4 }] }]),
  );
  let btn = named(e, "Btn");
  e.dispatch(Command::CreateComponent { ids: vec![btn] }).unwrap();
  e.doc.nodes.values().find(|n| n.kind == NodeType::Component).unwrap().id.clone()
}

fn instance(e: &mut Engine, main: &NodeId, x: f64) {
  e.dispatch(Command::CreateInstance {
    component_id: main.clone(),
    x,
    y: 0.0,
    parent: None,
    anchor: None,
    into_components: false,
  })
  .unwrap();
}

fn cards(e: &mut Engine) {
  let card = |x: f64, fill: &str| {
    json!({ "type": "frame", "name": "Card", "x": x, "y": 0, "width": 200, "height": 120,
      "children": [
        { "type": "text", "name": "Title", "characters": "Hi", "x": 10, "y": 10 },
        { "type": "rectangle", "name": "Bg", "x": 10, "y": 40, "width": 50, "height": 50, "fills": [fill] } ] })
  };
  create(e, json!([card(0.0, "#FF0000"), card(300.0, "#FF0000"), card(600.0, "#0000FF")]));
}

mod pages {
  use super::*;

  #[test]
  fn move_page_reorders_and_undo_restores() {
    let mut e = engine();
    for _ in 0..2 {
      e.dispatch(Command::AddPage { name: None }).unwrap();
    }
    let ids: Vec<String> = e.doc.pages.iter().map(|p| p.id.clone()).collect();
    e.dispatch(Command::MovePage {
      id: ids[2].clone(),
      index: 0,
    })
    .unwrap();
    let now: Vec<String> = e.doc.pages.iter().map(|p| p.id.clone()).collect();
    assert_eq!(now, [ids[2].clone(), ids[0].clone(), ids[1].clone()]);
    e.dispatch(Command::Undo).unwrap();
    let back: Vec<String> = e.doc.pages.iter().map(|p| p.id.clone()).collect();
    assert_eq!(back, ids);
  }

  #[test]
  fn page_reorder_travels_with_order() {
    let mut a = engine();
    for _ in 0..2 {
      a.dispatch(Command::AddPage { name: None }).unwrap();
    }
    let base = a.doc.clone();
    let ids: Vec<String> = a.doc.pages.iter().map(|p| p.id.clone()).collect();
    a.dispatch(Command::MovePage {
      id: ids[2].clone(),
      index: 0,
    })
    .unwrap();
    let d = crate::collab::delta(&base, &a.doc, true, true);
    assert!(d["pageChanges"]["order"].is_array(), "{d}");
    let mut peer = base.clone();
    crate::collab::apply(&mut peer, &d).unwrap();
    let order: Vec<&str> = peer.pages.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(order, [ids[2].as_str(), ids[0].as_str(), ids[1].as_str()]);
  }

  #[test]
  fn move_to_page_and_duplicate_page_reach_a_peer() {
    let mut a = engine();
    create(
      &mut a,
      json!([{ "type": "frame", "name": "F", "x": 40, "y": 50, "width": 100, "height": 100,
        "children": [{ "type": "rectangle", "name": "R", "x": 5, "y": 5, "width": 20, "height": 20 }] }]),
    );
    a.dispatch(Command::AddPage { name: None }).unwrap();
    let (p2, p1) = (a.page.clone(), a.doc.pages[0].id.clone());
    let f = named(&a, "F");
    let base = a.doc.clone();
    a.dispatch(Command::MoveToPage {
      ids: vec![f],
      page: p2.clone(),
    })
    .unwrap();
    a.dispatch(Command::DuplicatePage { id: p2.clone() }).unwrap();
    let d = crate::collab::delta(&base, &a.doc, true, true);
    let mut peer = base.clone();
    crate::collab::apply(&mut peer, &d).unwrap();
    assert_eq!(peer.pages, a.doc.pages);
    assert_eq!(peer.nodes, a.doc.nodes);
    assert!(peer.page(&p1).unwrap().children.is_empty());
  }

  #[test]
  fn duplicate_page_copies_layers_and_remaps_links() {
    let mut e = engine();
    create(
      &mut e,
      json!([
        { "type": "frame", "name": "A", "x": 0, "y": 0, "width": 100, "height": 100,
          "children": [{ "type": "rectangle", "name": "Btn", "x": 5, "y": 5, "width": 20, "height": 20 }] },
        { "type": "frame", "name": "B", "x": 200, "y": 0, "width": 100, "height": 100 }
      ]),
    );
    let (a, b, btn) = (named(&e, "A"), named(&e, "B"), named(&e, "Btn"));
    let link = Interaction {
      destination: Some(b.clone()),
      ..Default::default()
    };
    e.dispatch(Command::SetInteractions {
      id: btn,
      interactions: vec![link],
    })
    .unwrap();
    let src = e.page.clone();
    e.dispatch(Command::SetFlowStart {
      page: src.clone(),
      id: Some(a),
    })
    .unwrap();
    let before = e.doc.nodes.len();
    let r = e.dispatch(Command::DuplicatePage { id: src.clone() }).unwrap();
    let new_page = r["id"].as_str().unwrap().to_string();
    assert_eq!(e.page, new_page);
    assert_eq!(e.doc.pages[1].id, new_page);
    assert_eq!(e.doc.pages[1].name, "Page 1 copy");
    assert_eq!(e.doc.nodes.len(), before * 2);
    let copy_btn = e.doc.nodes.values().find(|n| n.name == "Btn" && n.page == new_page).unwrap();
    let dest = copy_btn.interactions[0].destination.clone().unwrap();
    assert_ne!(dest, b);
    assert_eq!(e.doc.get(&dest).unwrap().page, new_page);
    let fs = e.doc.pages[1].flow_start.clone().unwrap();
    assert_eq!(e.doc.get(&fs).unwrap().page, new_page);
    // The original page is untouched.
    let orig_btn = e.doc.nodes.values().find(|n| n.name == "Btn" && n.page == src).unwrap();
    assert_eq!(orig_btn.interactions[0].destination.as_deref(), Some(b.as_str()));
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.pages.len(), 1);
    assert_eq!(e.doc.nodes.len(), before);
  }

  #[test]
  fn duplicate_page_gives_instances_the_copied_main() {
    let mut e = engine();
    let main = main_component(&mut e);
    instance(&mut e, &main, 300.0);
    let src = e.page.clone();
    let r = e.dispatch(Command::DuplicatePage { id: src }).unwrap();
    let new_page = r["id"].as_str().unwrap().to_string();
    let inst = e
      .doc
      .nodes
      .values()
      .find(|n| n.kind == NodeType::Instance && n.page == new_page)
      .unwrap();
    let comp = inst.instance.as_ref().unwrap().component_id.clone();
    assert_ne!(comp, main);
    assert_eq!(e.doc.get(&comp).unwrap().page, new_page);
    for d in e.doc.subtree(&inst.id).into_iter().skip(1) {
      let m = e.doc.get(&d).unwrap().master_id.clone().unwrap();
      assert_eq!(e.doc.get(&m).unwrap().page, new_page, "children link to the copied main");
    }
  }

  #[test]
  fn move_to_page_moves_descendants_comments_and_undoes() {
    let mut e = engine();
    create(
      &mut e,
      json!([{ "type": "frame", "name": "F", "x": 40, "y": 50, "width": 100, "height": 100,
        "children": [{ "type": "rectangle", "name": "R", "x": 5, "y": 5, "width": 20, "height": 20 }] }]),
    );
    let (f, r) = (named(&e, "F"), named(&e, "R"));
    let p1 = e.page.clone();
    e.dispatch(Command::AddComment {
      page: Some(p1.clone()),
      x: 1.0,
      y: 1.0,
      node: Some(f.clone()),
      text: "hi".into(),
      author: "a".into(),
      time: 0.0,
    })
    .unwrap();
    e.dispatch(Command::AddPage { name: None }).unwrap();
    let p2 = e.page.clone();
    e.dispatch(Command::SetPage { id: p1.clone() }).unwrap();
    e.dispatch(Command::MoveToPage {
      ids: vec![f.clone()],
      page: p2.clone(),
    })
    .unwrap();
    assert_eq!(e.page, p2);
    assert_eq!(e.selection, std::slice::from_ref(&f));
    assert_eq!(e.doc.get(&r).unwrap().page, p2);
    assert_eq!(e.doc.page(&p2).unwrap().children, std::slice::from_ref(&f));
    assert!(e.doc.page(&p1).unwrap().children.is_empty());
    assert!(e.doc.comments.values().all(|c| c.page == p2));
    let n = e.doc.get(&f).unwrap();
    assert_eq!((n.x, n.y), (40.0, 50.0));
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&r).unwrap().page, p1);
    assert_eq!(e.doc.page(&p1).unwrap().children, [f]);
    assert!(e.doc.comments.values().all(|c| c.page == p1));
  }
}

mod scale {
  use super::*;

  fn scale_fixture(e: &mut Engine) -> NodeId {
    create(
      e,
      json!([{ "type": "frame", "name": "F", "x": 100, "y": 100, "width": 100, "height": 100,
        "stroke": "#000000", "strokeWidth": 2, "cornerRadius": 8,
        "layout": { "direction": "vertical", "gap": 4, "padding": 10 },
        "children": [{ "type": "text", "name": "T", "characters": "Hi", "fontSize": 16 }] }]),
    );
    named(e, "F")
  }

  #[test]
  fn resize_with_scale_doubles_lengths() {
    let mut e = engine();
    let f = scale_fixture(&mut e);
    e.dispatch(Command::BeginGesture).unwrap();
    e.dispatch(Command::Resize {
      ids: vec![f.clone()],
      handle: Handle::Se,
      dx: 100.0,
      dy: 0.0,
      keep_aspect: false,
      from_center: false,
      snap: false,
      zoom: 1.0,
      scale: true,
    })
    .unwrap();
    e.dispatch(Command::EndGesture).unwrap();
    let n = e.doc.get(&f).unwrap();
    assert_eq!((n.x, n.y, n.width, n.height), (100.0, 100.0, 200.0, 200.0));
    assert_eq!((n.stroke_weight, n.corner_radius), (4.0, 16.0));
    assert_eq!(n.layout.as_ref().map(|l| (l.padding_top, l.gap)), Some((20.0, 8.0)));
    let t = e.doc.get(&named(&e, "T")).unwrap();
    assert_eq!(t.text.as_ref().unwrap().font_size, 32.0);
    e.dispatch(Command::Undo).unwrap();
    let n = e.doc.get(&f).unwrap();
    assert_eq!((n.width, n.stroke_weight), (100.0, 2.0));
  }

  #[test]
  fn locked_layers_are_not_scaled_and_scale_nodes_uses_the_top_left() {
    let mut e = engine();
    let f = scale_fixture(&mut e);
    e.doc.get_mut(&f).unwrap().locked = true;
    assert!(e
      .dispatch(Command::ScaleNodes {
        ids: vec![f.clone()],
        factor: 2.0,
        anchor: None
      })
      .is_err());
    assert_eq!(e.doc.get(&f).unwrap().width, 100.0);
    e.doc.get_mut(&f).unwrap().locked = false;
    e.dispatch(Command::ScaleNodes {
      ids: vec![f.clone()],
      factor: 0.5,
      anchor: None,
    })
    .unwrap();
    let n = e.doc.get(&f).unwrap();
    assert_eq!(
      (n.x, n.y, n.width, n.stroke_weight, n.corner_radius),
      (100.0, 100.0, 50.0, 1.0, 4.0)
    );
  }

  #[test]
  fn scaling_a_group_scales_its_children() {
    let mut e = engine();
    create(
      &mut e,
      json!([{ "type": "rectangle", "name": "a", "x": 0, "y": 0, "width": 40, "height": 40 },
             { "type": "rectangle", "name": "b", "x": 60, "y": 0, "width": 40, "height": 40 }]),
    );
    let ids = vec![named(&e, "a"), named(&e, "b")];
    e.dispatch(Command::Group { ids }).unwrap();
    let g = e.selection[0].clone();
    e.dispatch(Command::ScaleNodes {
      ids: vec![g.clone()],
      factor: 0.5,
      anchor: None,
    })
    .unwrap();
    assert_eq!(e.doc.get(&g).unwrap().width, 50.0);
    let b = e.doc.get(&named(&e, "b")).unwrap();
    assert_eq!((b.x, b.width), (30.0, 20.0));
  }

  #[test]
  fn instances_scale_as_a_whole() {
    let mut e = engine();
    let main = main_component(&mut e);
    instance(&mut e, &main, 300.0);
    let inst = e.doc.nodes.values().find(|n| n.kind == NodeType::Instance).unwrap().id.clone();
    e.dispatch(Command::ScaleNodes {
      ids: vec![inst.clone()],
      factor: 2.0,
      anchor: None,
    })
    .unwrap();
    let n = e.doc.get(&inst).unwrap();
    assert_eq!((n.x, n.width, n.height), (300.0, 160.0, 60.0));
    // A layer inside an instance can't be scaled on its own.
    let inner = e.doc.get(&inst).unwrap().children[0].clone();
    assert!(e
      .dispatch(Command::ScaleNodes {
        ids: vec![inner],
        factor: 2.0,
        anchor: None
      })
      .is_err());
  }
}

mod selection {
  use super::*;

  #[test]
  fn matching_layers_across_three_cards() {
    let mut e = engine();
    cards(&mut e);
    let titles = all_named(&e, "Title");
    assert_eq!(titles.len(), 3);
    let got = query_ids(
      &e,
      Query::MatchingLayers {
        ids: vec![titles[0].clone()],
      },
    );
    assert_eq!(got, sorted(titles));
    let bg = all_named(&e, "Bg");
    let got = query_ids(&e, Query::MatchingLayers { ids: vec![bg[1].clone()] });
    assert_eq!(got, sorted(bg));
  }

  #[test]
  fn same_property_fill_returns_identical_fills_only() {
    let mut e = engine();
    cards(&mut e);
    let bg = all_named(&e, "Bg");
    let reds: Vec<NodeId> = bg
      .iter()
      .filter(|i| e.doc.get(i).unwrap().fills == vec![Paint::solid("#FF0000")])
      .cloned()
      .collect();
    assert_eq!(reds.len(), 2);
    let got = query_ids(
      &e,
      Query::SameProperty {
        id: reds[0].clone(),
        prop: "fill".into(),
      },
    );
    assert_eq!(got, sorted(reds));
    assert!(e
      .query(Query::SameProperty {
        id: bg[0].clone(),
        prop: "nope".into()
      })
      .is_err());
  }

  #[test]
  fn instances_on_page_and_all_pages() {
    let mut e = engine();
    let main = main_component(&mut e);
    for x in [200.0, 300.0] {
      instance(&mut e, &main, x);
    }
    let p1 = e.page.clone();
    e.dispatch(Command::AddPage { name: None }).unwrap();
    instance(&mut e, &main, 0.0);
    assert_eq!(
      query_ids(
        &e,
        Query::Instances {
          component: main.clone(),
          all_pages: false
        }
      )
      .len(),
      1
    );
    assert_eq!(
      query_ids(
        &e,
        Query::Instances {
          component: main.clone(),
          all_pages: true
        }
      )
      .len(),
      3
    );
    e.dispatch(Command::SetPage { id: p1 }).unwrap();
    let any = query_ids(
      &e,
      Query::Instances {
        component: main.clone(),
        all_pages: false,
      },
    );
    assert_eq!(any.len(), 2);
    // Asking from an instance finds its siblings.
    assert_eq!(
      query_ids(
        &e,
        Query::Instances {
          component: any[0].clone(),
          all_pages: false
        }
      ),
      any
    );
  }
}

mod tidy {
  use super::*;

  #[test]
  fn six_scattered_squares_become_a_3x2_grid_with_equal_gaps() {
    let mut e = engine();
    let at = [(3.0, 5.0), (90.0, 0.0), (190.0, 8.0), (-4.0, 120.0), (100.0, 131.0), (210.0, 125.0)];
    let nodes: Vec<Value> = at
      .iter()
      .enumerate()
      .map(|(i, (x, y))| json!({ "type": "rectangle", "name": format!("s{i}"), "x": x, "y": y, "width": 40, "height": 40 }))
      .collect();
    create(&mut e, json!(nodes));
    let ids: Vec<NodeId> = (0..6).map(|i| named(&e, &format!("s{i}"))).collect();
    e.dispatch(Command::TidyUp {
      ids: ids.clone(),
      spacing: None,
    })
    .unwrap();
    let b: Vec<Rect> = ids.iter().map(|i| e.doc.abs_bounds(i)).collect();
    assert_eq!((b[3].x, b[0].x), (-4.0, -4.0));
    let gaps_h = [
      b[1].x - b[0].right(),
      b[2].x - b[1].right(),
      b[4].x - b[3].right(),
      b[5].x - b[4].right(),
    ];
    assert!(gaps_h.iter().all(|g| (g - gaps_h[0]).abs() <= 1.0), "{gaps_h:?}");
    assert!(b[0].y == b[1].y && b[1].y == b[2].y && b[3].y == b[4].y && b[4].y == b[5].y);
    assert!(b[3].y > b[0].y);
    let gap_v = b[3].y - b[0].bottom();
    assert!((gap_v - gaps_h[0]).abs() <= 1.0, "one gap for both axes: {gap_v} vs {gaps_h:?}");
    assert_eq!(b[0].y, 0.0);
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&ids[0]).unwrap().x, 3.0);
  }

  #[test]
  fn auto_layout_children_are_refused() {
    let mut e = engine();
    create(
      &mut e,
      json!([{ "type": "frame", "name": "F", "x": 0, "y": 0, "width": 200, "height": 100,
        "layout": { "direction": "horizontal", "gap": 10, "padding": 10 },
        "children": [{ "type": "rectangle", "name": "a", "width": 30, "height": 30 },
                     { "type": "rectangle", "name": "b", "width": 30, "height": 30 }] }]),
    );
    let ids = vec![named(&e, "a"), named(&e, "b")];
    assert!(e.dispatch(Command::TidyUp { ids, spacing: None }).is_err());
  }
}

mod scale_instances {
  use super::*;

  /// Main "Btn" (80x30, stroke 1) with a 10 px label at (4, 4); returns (main, instance).
  fn fixture(e: &mut Engine, with_instance_frame: bool) -> (NodeId, NodeId) {
    create(
      e,
      json!([{ "type": "frame", "name": "Btn", "x": 0, "y": 0, "width": 80, "height": 30, "fill": "#EEEEEE",
        "stroke": "#000000", "strokeWidth": 1,
        "children": [{ "type": "text", "name": "Label", "characters": "Go", "fontSize": 10, "x": 4, "y": 4 }] }]),
    );
    let btn = named(e, "Btn");
    e.dispatch(Command::CreateComponent { ids: vec![btn] }).unwrap();
    let main = e.doc.nodes.values().find(|n| n.kind == NodeType::Component).unwrap().id.clone();
    instance(e, &main, 300.0);
    let inst = e.doc.nodes.values().find(|n| n.kind == NodeType::Instance).unwrap().id.clone();
    if with_instance_frame {
      e.dispatch(Command::FrameSelection { ids: vec![inst.clone()] }).unwrap();
    }
    (main, inst)
  }

  fn label(e: &Engine, inst: &str) -> crate::model::Node {
    let kid = e.doc.get(inst).unwrap().children[0].clone();
    e.doc.get(&kid).unwrap().clone()
  }

  #[test]
  fn an_instance_scales_its_contents_and_keeps_them_when_the_main_changes() {
    let mut e = engine();
    let (main, inst) = fixture(&mut e, false);
    let before = e.doc.nodes.clone();
    e.dispatch(Command::ScaleNodes {
      ids: vec![inst.clone()],
      factor: 2.0,
      anchor: None,
    })
    .unwrap();
    let l = label(&e, &inst);
    assert_eq!(l.text.as_ref().unwrap().font_size, 20.0);
    assert_eq!((l.x, l.y), (8.0, 8.0));
    // The main component's fill changes: the instance keeps its scaled look.
    let red = json!({ "fills": [{ "type": "solid", "color": "#FF0000", "opacity": 1, "visible": true }] });
    e.dispatch(Command::Update {
      ids: vec![main],
      patch: red,
    })
    .unwrap();
    let n = e.doc.get(&inst).unwrap();
    assert_eq!((n.width, n.height, n.stroke_weight), (160.0, 60.0, 2.0));
    let l = label(&e, &inst);
    assert_eq!((l.text.as_ref().unwrap().font_size, l.x, l.y), (20.0, 8.0, 8.0));
    e.dispatch(Command::Undo).unwrap();
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.nodes, before, "undo is exact");
  }

  #[test]
  fn an_instance_in_a_scaled_frame_scales_with_it() {
    let mut e = engine();
    let (_, inst) = fixture(&mut e, true);
    let frame = e.doc.get(&inst).unwrap().parent.clone().unwrap();
    e.dispatch(Command::ScaleNodes {
      ids: vec![frame],
      factor: 2.0,
      anchor: None,
    })
    .unwrap();
    let n = e.doc.get(&inst).unwrap();
    assert_eq!((n.width, n.stroke_weight), (160.0, 2.0));
    assert_eq!(label(&e, &inst).text.as_ref().unwrap().font_size, 20.0);
  }

  #[test]
  fn an_existing_override_is_scaled() {
    let mut e = engine();
    let (_, inst) = fixture(&mut e, false);
    let kid = e.doc.get(&inst).unwrap().children[0].clone();
    e.dispatch(Command::Update {
      ids: vec![kid],
      patch: json!({ "text": { "fontSize": 20 } }),
    })
    .unwrap();
    e.dispatch(Command::ScaleNodes {
      ids: vec![inst.clone()],
      factor: 2.0,
      anchor: None,
    })
    .unwrap();
    assert_eq!(label(&e, &inst).text.as_ref().unwrap().font_size, 40.0);
  }

  #[test]
  fn scaling_lets_go_of_text_styles() {
    let mut e = engine();
    create(&mut e, json!([{ "type": "text", "name": "T", "characters": "Hi", "fontSize": 16 }]));
    let t = named(&e, "T");
    e.dispatch(Command::AddTextStyle {
      name: "Body".into(),
      from: t.clone(),
    })
    .unwrap();
    assert!(e.doc.get(&t).unwrap().text_style.is_some());
    e.dispatch(Command::ScaleNodes {
      ids: vec![t.clone()],
      factor: 2.0,
      anchor: None,
    })
    .unwrap();
    let n = e.doc.get(&t).unwrap();
    assert_eq!(n.text.as_ref().unwrap().font_size, 32.0);
    assert!(n.text_style.is_none(), "the style link would pull the size back");
  }
}

mod scale_bookkeeping {
  use super::*;

  #[test]
  fn a_big_plain_frame_snapshots_nothing_and_scales_fast() {
    let mut e = engine();
    let kids: Vec<Value> = (0..2000)
      .map(|i| json!({ "type": "rectangle", "name": format!("R{i}"), "x": (i % 50) * 20, "y": (i / 50) * 20, "width": 10, "height": 10, "fill": "#FF0000" }))
      .collect();
    create(
      &mut e,
      json!([{ "type": "frame", "name": "Big", "x": 0, "y": 0, "width": 1000, "height": 800, "children": kids }]),
    );
    let big = named(&e, "Big");
    assert!(crate::arrange::watched_count(&e.doc, &big) == 0, "plain layers need no snapshot");
    e.dispatch(Command::BeginGesture).unwrap();
    let t = std::time::Instant::now();
    for s in 1..=10 {
      e.dispatch(Command::Resize {
        ids: vec![big.clone()],
        handle: Handle::Se,
        dx: s as f64 * 5.0,
        dy: 0.0,
        keep_aspect: false,
        from_center: false,
        snap: false,
        zoom: 1.0,
        scale: true,
      })
      .unwrap();
    }
    let per = t.elapsed() / 10;
    e.dispatch(Command::EndGesture).unwrap();
    // Single-digit milliseconds in a release build; the test profile is unoptimised, so it only guards against a blow-up.
    assert!(per.as_millis() < 60, "{per:?} per step");
  }

  #[test]
  fn no_stroke_means_no_stroke_weight_override() {
    let mut e = engine();
    create(
      &mut e,
      json!([{ "type": "frame", "name": "Btn", "x": 0, "y": 0, "width": 80, "height": 30, "fill": "#EEEEEE" }]),
    );
    let btn = named(&e, "Btn");
    e.dispatch(Command::CreateComponent { ids: vec![btn] }).unwrap();
    let main = e.doc.nodes.values().find(|n| n.kind == NodeType::Component).unwrap().id.clone();
    instance(&mut e, &main, 300.0);
    let inst = e.doc.nodes.values().find(|n| n.kind == NodeType::Instance).unwrap().id.clone();
    e.dispatch(Command::ScaleNodes {
      ids: vec![inst.clone()],
      factor: 2.0,
      anchor: None,
    })
    .unwrap();
    let ov = &e.doc.get(&inst).unwrap().instance.as_ref().unwrap().overrides;
    assert!(!ov.values().any(|v| v.get("strokeWeight").is_some()), "{ov:?}");
  }

  #[test]
  fn a_bound_gap_in_an_instance_keeps_following_its_variable() {
    let mut e = engine();
    e.dispatch(Command::Ai {
      tool: "define_variables".into(),
      input: json!({ "collection": "Space", "variables": [{ "name": "m", "type": "number", "value": 8 }] }),
    })
    .unwrap();
    create(
      &mut e,
      json!([{ "type": "frame", "name": "Row", "x": 0, "y": 0, "width": 120, "height": 40, "bind": { "gap": "Space/m" },
        "layout": { "direction": "horizontal", "gap": 8, "padding": 4 },
        "children": [{ "type": "rectangle", "name": "a", "width": 20, "height": 20 }, { "type": "rectangle", "name": "b", "width": 20, "height": 20 }] }]),
    );
    let row = named(&e, "Row");
    assert!(!e.doc.get(&row).unwrap().bindings.is_empty(), "the gap is bound");
    e.dispatch(Command::CreateComponent { ids: vec![row] }).unwrap();
    let main = e.doc.nodes.values().find(|n| n.kind == NodeType::Component).unwrap().id.clone();
    instance(&mut e, &main, 300.0);
    let inst = e.doc.nodes.values().find(|n| n.kind == NodeType::Instance).unwrap().id.clone();
    e.dispatch(Command::ScaleNodes {
      ids: vec![inst.clone()],
      factor: 2.0,
      anchor: None,
    })
    .unwrap();
    let gap_now = e.doc.get(&inst).unwrap().layout.as_ref().unwrap().gap;
    let pad_now = e.doc.get(&inst).unwrap().layout.as_ref().unwrap().padding_top;
    // Touching the main again (sync) doesn't change the answer: the gap is not scaled and stays bound.
    e.dispatch(Command::Update {
      ids: vec![main],
      patch: json!({ "opacity": 0.9 }),
    })
    .unwrap();
    let l = e.doc.get(&inst).unwrap().layout.clone().unwrap();
    assert_eq!((l.gap, l.padding_top), (gap_now, pad_now));
    assert_eq!(l.gap, 8.0);
    assert_eq!(l.padding_top, 8.0, "unbound padding scaled");
  }
}
