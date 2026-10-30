use super::*;
use crate::engine::{Command, Engine, Query};
use serde_json::json;

/// A "Button" set (State=Default / State=Hover) whose variants each have "Bg", "Label" ("Buy")
/// and "Icon" (an instance of "Arrow"), plus the "Arrow" and "Check" icon components.
struct Kit {
  e: Engine,
  default: String,
  hover: String,
  arrow: String,
  check: String,
  set: String,
}

#[test]
fn boolean_property_hides_the_layer_in_instances_only() {
  let mut k = kit();
  let pid = add_bound(&mut k, "Show icon", PropKind::Boolean, "Icon");
  let inst = instance_of_default(&mut k);
  let icon = named(&k.e, &inst, "Icon");
  assert!(k.e.doc.get(&icon).unwrap().visible);
  set_prop(&mut k, &inst, &pid, Some(json!(false)));
  let icon = named(&k.e, &inst, "Icon");
  assert!(!k.e.doc.get(&icon).unwrap().visible, "instance layer hidden");
  assert!(
    k.e.doc.get(&named(&k.e, &k.default, "Icon")).unwrap().visible,
    "main layer untouched"
  );
  assert!(k.e.doc.get(&named(&k.e, &inst, "Label")).unwrap().visible);
  // Another instance is independent.
  let other = instance_of_default(&mut k);
  assert!(k.e.doc.get(&named(&k.e, &other, "Icon")).unwrap().visible);
  // A value the main component already shows isn't kept as a value of its own.
  set_prop(&mut k, &inst, &pid, Some(json!(true)));
  assert!(k.e.doc.get(&inst).unwrap().instance.as_ref().unwrap().prop_values.is_empty());
  assert!(k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  set_prop(&mut k, &inst, &pid, Some(json!(false)));
  // Back to the main component's state.
  set_prop(&mut k, &inst, &pid, None);
  assert!(k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  assert!(k.e.doc.get(&inst).unwrap().instance.as_ref().unwrap().prop_values.is_empty());
}

#[test]
fn hidden_layer_leaves_the_flow_of_an_auto_layout_instance() {
  let mut k = kit();
  let pid = add_bound(&mut k, "Show icon", PropKind::Boolean, "Icon");
  k.e
    .dispatch(Command::AddAutoLayout {
      ids: vec![k.default.clone()],
    })
    .unwrap();
  let inst = instance_of_default(&mut k);
  k.e
    .dispatch(Command::Update {
      ids: vec![inst.clone()],
      patch: json!({ "sizingH": "hug" }),
    })
    .unwrap();
  let before = k.e.doc.get(&inst).unwrap().width;
  set_prop(&mut k, &inst, &pid, Some(json!(false)));
  assert!(k.e.doc.get(&inst).unwrap().width < before, "hug width shrinks without the icon");
}

#[test]
fn text_property_sets_characters_and_follows_direct_edits() {
  let mut k = kit();
  let pid = add_bound(&mut k, "Label", PropKind::Text, "Label");
  let def = k.e.doc.get(&k.set).unwrap().component.as_ref().unwrap().props[0].clone();
  assert_eq!(def.default, json!("Buy"), "default comes from the layer it was made from");
  let inst = instance_of_default(&mut k);
  set_prop(&mut k, &inst, &pid, Some(json!("Checkout")));
  let label = named(&k.e, &inst, "Label");
  assert_eq!(text(&k.e, &label), "Checkout");
  assert_eq!(text(&k.e, &named(&k.e, &k.default, "Label")), "Buy");

  // Typing into the layer changes the property, not an override.
  k.e
    .dispatch(Command::SetText {
      id: label.clone(),
      characters: "Pay".into(),
    })
    .unwrap();
  let info = k.e.doc.get(&inst).unwrap().instance.clone().unwrap();
  assert_eq!(info.prop_values[&pid], json!("Pay"));
  assert!(info.overrides.is_empty(), "no override recorded: {:?}", info.overrides);

  // Main component edits keep the value (and the rest follows).
  let main_label = named(&k.e, &k.default, "Label");
  k.e
    .dispatch(Command::Update {
      ids: vec![main_label],
      patch: json!({ "text": { "fontSize": 31 } }),
    })
    .unwrap();
  let label = named(&k.e, &inst, "Label");
  assert_eq!(text(&k.e, &label), "Pay");
  assert_eq!(k.e.doc.get(&label).unwrap().text.as_ref().unwrap().font_size, 31.0);

  // A change of the default reaches the main layers and instances without a value.
  let fresh = instance_of_default(&mut k);
  k.e
    .dispatch(Command::ComponentProps {
      edit: PropsOp::Update {
        component: k.set.clone(),
        prop: pid.clone(),
        name: None,
        default: Some(json!("Order")),
        options: None,
      },
    })
    .unwrap();
  assert_eq!(text(&k.e, &named(&k.e, &k.default, "Label")), "Order");
  assert_eq!(text(&k.e, &named(&k.e, &fresh, "Label")), "Order");
  assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Pay");
}

#[test]
fn values_survive_save_and_load_undo_redo_and_variant_swaps() {
  let mut k = kit();
  let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
  let icon = add_bound(&mut k, "Show icon", PropKind::Boolean, "Icon");
  let inst = instance_of_default(&mut k);
  set_prop(&mut k, &inst, &label, Some(json!("Go")));
  set_prop(&mut k, &inst, &icon, Some(json!(false)));

  // Variant swap: the set shares its properties, so the values come along.
  k.e
    .dispatch(Command::SetVariant {
      id: inst.clone(),
      prop: "State".into(),
      value: "Hover".into(),
    })
    .unwrap();
  assert_eq!(comp_of(&k.e, &inst), k.hover);
  assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Go");
  assert!(!k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  k.e.dispatch(Command::Undo).unwrap();
  assert_eq!(comp_of(&k.e, &inst), k.default);
  assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Go");
  k.e.dispatch(Command::Redo).unwrap();
  assert!(!k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);

  // Undo and redo of the values themselves.
  k.e.dispatch(Command::Undo).unwrap();
  k.e.dispatch(Command::Undo).unwrap();
  assert!(k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Go");
  k.e.dispatch(Command::Undo).unwrap();
  assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Buy");
  k.e.dispatch(Command::Redo).unwrap();
  k.e.dispatch(Command::Redo).unwrap();
  k.e.dispatch(Command::Redo).unwrap();
  assert!(!k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  assert_eq!(comp_of(&k.e, &inst), k.hover);

  // Saved and opened again, then the main component is edited.
  let mut e2 = Engine::new(Box::new(crate::text::HeuristicMeasurer), 8);
  e2.load(&k.e.to_json()).unwrap();
  let main_bg = named(&e2, &k.hover, "Bg");
  e2.dispatch(Command::Update {
    ids: vec![main_bg],
    patch: json!({ "cornerRadius": 9 }),
  })
  .unwrap();
  assert_eq!(text(&e2, &named(&e2, &inst, "Label")), "Go");
  assert!(!e2.doc.get(&named(&e2, &inst, "Icon")).unwrap().visible);
  assert_eq!(e2.doc.get(&named(&e2, &inst, "Bg")).unwrap().corner_radius, 9.0);
}

#[test]
fn swap_property_swaps_the_nested_instance_and_refuses_cycles() {
  let mut k = kit();
  let pid = add_bound(&mut k, "Icon", PropKind::InstanceSwap, "Icon");
  let check = k.check.clone();
  let inst = instance_of_default(&mut k);
  assert_eq!(comp_of(&k.e, &named(&k.e, &inst, "Icon")), k.arrow);
  set_prop(&mut k, &inst, &pid, Some(json!(check)));
  assert_eq!(comp_of(&k.e, &named(&k.e, &inst, "Icon")), k.check);
  assert_eq!(comp_of(&k.e, &named(&k.e, &k.default, "Icon")), k.arrow, "main untouched");

  // The panel's view: current value, offered components.
  let d = k.e.query(Query::ComponentProps { id: inst.clone() }).unwrap();
  let p = &d["groups"][0]["props"][0];
  assert_eq!(p["value"], json!(k.check));
  assert_eq!(p["custom"], json!(true));
  assert!(p["options"].as_array().unwrap().iter().any(|o| o["id"] == json!(k.arrow)));

  // A component that holds a Button: fine inside an instance on the page, but never inside the
  // Button that sits in it.
  let panel = shape(&mut k.e, NodeType::Frame, 3000.0);
  let panel_btn = instance_of_default(&mut k);
  k.e
    .dispatch(Command::MoveToParent {
      ids: vec![panel_btn.clone()],
      parent: Some(panel.clone()),
      index: None,
    })
    .unwrap();
  let panel = id(k.e.dispatch(Command::CreateComponent { ids: vec![panel] }).unwrap());
  let swap = |k: &mut Kit, instance: &str, value: &str| {
    k.e.dispatch(Command::ComponentProps {
      edit: PropsOp::Set {
        instance: instance.into(),
        prop: pid.clone(),
        value: Some(json!(value)),
      },
    })
  };
  let r = swap(&mut k, &panel_btn, &panel);
  assert!(r.is_err(), "{r:?}");
  assert_eq!(comp_of(&k.e, &named(&k.e, &panel_btn, "Icon")), k.arrow);
  let d = k.e.query(Query::ComponentProps { id: panel_btn.clone() }).unwrap();
  let offered = |d: &Value| -> Vec<Value> {
    d["groups"][0]["props"][0]["options"]
      .as_array()
      .unwrap()
      .iter()
      .map(|o| o["id"].clone())
      .collect()
  };
  assert!(!offered(&d).contains(&json!(panel)), "cycle-making components aren't offered");
  let d = k.e.query(Query::ComponentProps { id: inst.clone() }).unwrap();
  assert!(offered(&d).contains(&json!(panel)));
  swap(&mut k, &inst, &panel).unwrap();
  assert_eq!(comp_of(&k.e, &named(&k.e, &inst, "Icon")), panel);
  swap(&mut k, &inst, &check).unwrap();
  // Nor can it become the default.
  let r = k.e.dispatch(Command::ComponentProps {
    edit: PropsOp::Update {
      component: k.set.clone(),
      prop: pid.clone(),
      name: None,
      default: Some(json!(panel)),
      options: None,
    },
  });
  assert!(r.is_err());

  // Back to the main component's icon.
  set_prop(&mut k, &inst, &pid, None);
  assert_eq!(comp_of(&k.e, &named(&k.e, &inst, "Icon")), k.arrow);
  let d = k.e.query(Query::ComponentProps { id: inst.clone() }).unwrap();
  assert_eq!(d["groups"][0]["props"][0]["custom"], json!(false));
  assert!(k.e.doc.get(&inst).unwrap().instance.as_ref().unwrap().overrides.is_empty());
}

#[test]
fn a_value_set_on_a_nested_instance_in_the_main_reaches_outer_instances() {
  let mut k = kit();
  let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
  let frame = shape(&mut k.e, NodeType::Frame, 5000.0);
  let inner = instance_of_default(&mut k);
  k.e
    .dispatch(Command::MoveToParent {
      ids: vec![inner.clone()],
      parent: Some(frame.clone()),
      index: None,
    })
    .unwrap();
  let card = id(k.e.dispatch(Command::CreateComponent { ids: vec![frame] }).unwrap());
  // The Card's author sets the nested Button's label in the main component.
  set_prop(&mut k, &inner, &label, Some(json!("Pay")));
  let card_inst = instance(&mut k, &card);
  let nested = nested_instance(&k.e, &card_inst);
  assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Pay");
  // Exposed, an outer instance can still override it, and reset goes back to the author's.
  k.e
    .dispatch(Command::ComponentProps {
      edit: PropsOp::Expose {
        instance: inner,
        expose: true,
      },
    })
    .unwrap();
  set_prop(&mut k, &nested, &label, Some(json!("Order")));
  assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Order");
  set_prop(&mut k, &nested, &label, None);
  assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Pay");
}

#[test]
fn an_override_from_before_binding_gives_way_to_the_property() {
  let mut k = kit();
  let inst = instance_of_default(&mut k);
  let icon = named(&k.e, &inst, "Icon");
  k.e
    .dispatch(Command::Update {
      ids: vec![icon],
      patch: json!({ "visible": false }),
    })
    .unwrap();
  assert!(!k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  let pid = add_bound(&mut k, "Icon", PropKind::Boolean, "Icon");
  assert!(
    k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible,
    "the property decides now"
  );
  set_prop(&mut k, &inst, &pid, Some(json!(false)));
  assert!(!k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  set_prop(&mut k, &inst, &pid, None);
  assert!(k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
}

#[test]
fn each_variant_keeps_its_own_layer_state_until_a_value_is_set() {
  let mut k = kit();
  let icon = add_bound(&mut k, "Icon", PropKind::Boolean, "Icon");
  // The Hover variant hides its icon by default.
  let hover_icon = named(&k.e, &k.hover, "Icon");
  k.e
    .dispatch(Command::Update {
      ids: vec![hover_icon],
      patch: json!({ "visible": false }),
    })
    .unwrap();
  let inst = instance_of_default(&mut k);
  assert!(k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  k.e
    .dispatch(Command::SetVariant {
      id: inst.clone(),
      prop: "State".into(),
      value: "Hover".into(),
    })
    .unwrap();
  assert!(
    !k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible,
    "no value set: follows the variant"
  );
  // Turning it on is a value; the other variant's state doesn't matter any more.
  set_prop(&mut k, &inst, &icon, Some(json!(true)));
  assert!(k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  let d = k.e.query(Query::ComponentProps { id: inst.clone() }).unwrap();
  assert_eq!(d["groups"][0]["props"][0]["custom"], json!(true));
  k.e
    .dispatch(Command::SetVariant {
      id: inst.clone(),
      prop: "State".into(),
      value: "Default".into(),
    })
    .unwrap();
  assert!(k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
}

#[test]
fn swapped_icon_survives_main_edits_save_load_undo_and_variant_swaps() {
  let mut k = kit();
  let pid = add_bound(&mut k, "Icon", PropKind::InstanceSwap, "Icon");
  let check = k.check.clone();
  let inst = instance_of_default(&mut k);
  set_prop(&mut k, &inst, &pid, Some(json!(check)));
  let main_label = named(&k.e, &k.default, "Label");
  k.e
    .dispatch(Command::Update {
      ids: vec![main_label],
      patch: json!({ "text": { "fontSize": 40 } }),
    })
    .unwrap();
  assert_eq!(comp_of(&k.e, &named(&k.e, &inst, "Icon")), k.check);
  k.e
    .dispatch(Command::SetVariant {
      id: inst.clone(),
      prop: "State".into(),
      value: "Hover".into(),
    })
    .unwrap();
  assert_eq!(
    comp_of(&k.e, &named(&k.e, &inst, "Icon")),
    k.check,
    "the swapped icon follows the variant swap by layer name"
  );
  let mut e2 = Engine::new(Box::new(crate::text::HeuristicMeasurer), 8);
  e2.load(&k.e.to_json()).unwrap();
  assert_eq!(comp_of(&e2, &named(&e2, &inst, "Icon")), k.check);
  k.e.dispatch(Command::Undo).unwrap();
  k.e.dispatch(Command::Undo).unwrap();
  assert_eq!(comp_of(&k.e, &named(&k.e, &inst, "Icon")), k.check);
  k.e.dispatch(Command::Undo).unwrap();
  assert_eq!(comp_of(&k.e, &named(&k.e, &inst, "Icon")), k.arrow);
}

#[test]
fn nested_instance_properties_can_be_exposed_on_the_outer_instance() {
  let mut k = kit();
  let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
  // A "Card" component holding a Button instance.
  let frame = shape(&mut k.e, NodeType::Frame, 5000.0);
  let inner = instance_of_default(&mut k);
  k.e
    .dispatch(Command::MoveToParent {
      ids: vec![inner.clone()],
      parent: Some(frame.clone()),
      index: None,
    })
    .unwrap();
  let card = id(k.e.dispatch(Command::CreateComponent { ids: vec![frame] }).unwrap());
  let card_inst = instance(&mut k, &card);
  let nested = nested_instance(&k.e, &card_inst);

  // Not exposed yet: the Card instance has no controls of its own.
  let d = k.e.query(Query::ComponentProps { id: card_inst.clone() }).unwrap();
  assert_eq!(d["groups"].as_array().unwrap().len(), 0);
  k.e
    .dispatch(Command::ComponentProps {
      edit: PropsOp::Expose {
        instance: inner.clone(),
        expose: true,
      },
    })
    .unwrap();
  let d = k.e.query(Query::ComponentProps { id: card_inst.clone() }).unwrap();
  assert_eq!(d["groups"].as_array().unwrap().len(), 1);
  assert_eq!(d["groups"][0]["instance"], json!(nested));

  // Set the nested Button's label through the Card instance.
  set_prop(&mut k, &nested, &label, Some(json!("Deep")));
  assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Deep");
  assert_eq!(
    text(&k.e, &named(&k.e, &inner, "Label")),
    "Buy",
    "the Card main's own Button is untouched"
  );
  // It survives edits of both main components, save/load and undo.
  let t = named(&k.e, &k.default, "Label");
  k.e
    .dispatch(Command::Update {
      ids: vec![t],
      patch: json!({ "text": { "fontSize": 33 } }),
    })
    .unwrap();
  let card_bg = shape(&mut k.e, NodeType::Rectangle, 5300.0);
  k.e
    .dispatch(Command::MoveToParent {
      ids: vec![card_bg],
      parent: Some(card.clone()),
      index: None,
    })
    .unwrap();
  let nested_label = named(&k.e, &nested, "Label");
  assert_eq!(text(&k.e, &nested_label), "Deep");
  assert_eq!(k.e.doc.get(&nested_label).unwrap().text.as_ref().unwrap().font_size, 33.0);
  let mut e2 = Engine::new(Box::new(crate::text::HeuristicMeasurer), 8);
  e2.load(&k.e.to_json()).unwrap();
  assert_eq!(text(&e2, &named(&e2, &nested, "Label")), "Deep");
  k.e.dispatch(Command::Undo).unwrap();
  k.e.dispatch(Command::Undo).unwrap();
  assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Deep");
  k.e.dispatch(Command::Undo).unwrap();
  k.e.dispatch(Command::Undo).unwrap();
  assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Buy");
  // Resetting the Card instance clears it.
  for _ in 0..4 {
    k.e.dispatch(Command::Redo).unwrap();
  }
  assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Deep");
  k.e
    .dispatch(Command::ResetInstance {
      ids: vec![card_inst.clone()],
    })
    .unwrap();
  assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Buy");
}

#[test]
fn property_edits_reach_collaborators_and_undo_keeps_their_changes() {
  let mut k = kit();
  let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
  let inst = instance_of_default(&mut k);
  let mut b = Engine::new(Box::new(crate::text::HeuristicMeasurer), 9);
  b.load(&k.e.to_json()).unwrap();
  let base = k.e.doc.clone();
  set_prop(&mut k, &inst, &label, Some(json!("Mine")));
  b.dispatch(Command::ApplyRemote {
    delta: crate::collab::delta(&base, &k.e.doc, true, true),
    local: false,
  })
  .unwrap();
  assert_eq!(text(&b, &named(&b, &inst, "Label")), "Mine");
  // They define a new property meanwhile; undoing my value keeps it.
  let theirs_base = b.doc.clone();
  let extra = b
    .dispatch(Command::ComponentProps {
      edit: PropsOp::Add {
        component: k.set.clone(),
        name: "Disabled".into(),
        kind: PropKind::Boolean,
        default: Some(json!(false)),
        bind: None,
      },
    })
    .unwrap();
  k.e
    .dispatch(Command::ApplyRemote {
      delta: crate::collab::delta(&theirs_base, &b.doc, true, true),
      local: false,
    })
    .unwrap();
  k.e.dispatch(Command::Undo).unwrap();
  assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Buy");
  let props = k.e.doc.get(&k.set).unwrap().component.as_ref().unwrap().props.clone();
  assert_eq!(props.len(), 2);
  assert!(props.iter().any(|p| p.id == extra["id"].as_str().unwrap()));
}

#[test]
fn files_without_properties_load_and_save_unchanged() {
  let mut k = kit();
  let _ = instance_of_default(&mut k);
  let json = k.e.to_json();
  assert!(
    !json.contains("propRefs") && !json.contains("propValues") && !json.contains("exposeProps") && !json.contains("\"props\""),
    "no new keys without properties"
  );
  // An older file's instance and component entries parse with the new fields defaulted.
  let i: InstanceInfo = serde_json::from_value(json!({ "componentId": "c1", "overrides": {} })).unwrap();
  assert!(i.prop_values.is_empty() && !i.expose_props);
  let c: ComponentInfo = serde_json::from_value(json!({ "description": "d", "variantProps": {} })).unwrap();
  assert!(c.props.is_empty());
  let mut e2 = Engine::new(Box::new(crate::text::HeuristicMeasurer), 8);
  e2.load(&json).unwrap();
  assert_eq!(e2.to_json(), json);
}

#[test]
fn combining_components_gathers_their_properties_on_the_set() {
  let mut e = Engine::new(Box::new(crate::text::HeuristicMeasurer), 7);
  let make = |e: &mut Engine, x: f64| {
    let f = id(
      e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x,
        y: 0.0,
        width: 100.0,
        height: 40.0,
        parent: None,
      })
      .unwrap(),
    );
    let t = id(
      e.dispatch(Command::CreateText {
        x,
        y: 0.0,
        characters: "Hi".into(),
        parent: Some(f.clone()),
      })
      .unwrap(),
    );
    let c = id(e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
    (c, t)
  };
  let (a, ta) = make(&mut e, 0.0);
  let (b, tb) = make(&mut e, 300.0);
  for (c, t) in [(&a, &ta), (&b, &tb)] {
    e.dispatch(Command::ComponentProps {
      edit: PropsOp::Add {
        component: c.clone(),
        name: "Title".into(),
        kind: PropKind::Text,
        default: None,
        bind: Some(t.clone()),
      },
    })
    .unwrap();
  }
  let inst = id(
    e.dispatch(Command::CreateInstance {
      component_id: b.clone(),
      x: 600.0,
      y: 0.0,
      parent: None,
      anchor: None,
      into_components: false,
    })
    .unwrap(),
  );
  let pb = e.doc.get(&b).unwrap().component.as_ref().unwrap().props[0].id.clone();
  e.dispatch(Command::ComponentProps {
    edit: PropsOp::Set {
      instance: inst.clone(),
      prop: pb,
      value: Some(json!("Mine")),
    },
  })
  .unwrap();
  let set = id(
    e.dispatch(Command::CombineVariants {
      ids: vec![a.clone(), b.clone()],
    })
    .unwrap(),
  );
  let props = e.doc.get(&set).unwrap().component.as_ref().unwrap().props.clone();
  assert_eq!(props.len(), 1, "same name and type: one property");
  assert!(e.doc.get(&a).unwrap().component.as_ref().unwrap().props.is_empty());
  // Both variants' text layers and the instance now use the shared property.
  let refs = |e: &Engine, t: &str| e.doc.get(t).unwrap().prop_refs.clone().unwrap().characters.unwrap();
  assert_eq!(refs(&e, &ta), props[0].id);
  assert_eq!(refs(&e, &tb), props[0].id);
  assert_eq!(
    e.doc.get(&inst).unwrap().instance.as_ref().unwrap().prop_values.get(&props[0].id),
    Some(&json!("Mine"))
  );
  // The value carries to the other variant when the instance is swapped.
  e.dispatch(Command::SwapComponent {
    id: inst.clone(),
    component_id: a,
  })
  .unwrap();
  let t = e
    .doc
    .subtree(&inst)
    .into_iter()
    .find(|i| e.doc.get(i).map(|n| n.kind == NodeType::Text).unwrap_or(false))
    .unwrap();
  assert_eq!(text(&e, &t), "Mine");
}

#[test]
fn bad_edits_are_refused() {
  let mut k = kit();
  let add = |k: &mut Kit, name: &str, kind, default: Option<Value>| {
    k.e.dispatch(Command::ComponentProps {
      edit: PropsOp::Add {
        component: k.set.clone(),
        name: name.into(),
        kind,
        default,
        bind: None,
      },
    })
  };
  add(&mut k, "Label", PropKind::Text, None).unwrap();
  assert!(add(&mut k, "Label", PropKind::Boolean, None).is_err(), "names are unique");
  assert!(add(&mut k, " ", PropKind::Boolean, None).is_err());
  assert!(
    add(&mut k, "Glyph", PropKind::InstanceSwap, None).is_err(),
    "swap needs a default component"
  );
  assert!(add(&mut k, "Glyph", PropKind::InstanceSwap, Some(json!("nope"))).is_err());
  let pid = k.e.doc.get(&k.set).unwrap().component.as_ref().unwrap().props[0].id.clone();
  // A text property can't control visibility; a rectangle can't take a text property.
  let icon = named(&k.e, &k.default, "Icon");
  let bg = named(&k.e, &k.default, "Bg");
  let bind = |k: &mut Kit, node: &str, field| {
    k.e.dispatch(Command::ComponentProps {
      edit: PropsOp::Bind {
        node: node.into(),
        field,
        prop: Some(pid.clone()),
      },
    })
  };
  assert!(bind(&mut k, &icon, PropField::Visible).is_err());
  assert!(bind(&mut k, &bg, PropField::Characters).is_err());
  // Layers of an instance can't be bound.
  let inst = instance_of_default(&mut k);
  let copy = named(&k.e, &inst, "Label");
  assert!(bind(&mut k, &copy, PropField::Characters).is_err());
  // Wrong value types.
  let r = k.e.dispatch(Command::ComponentProps {
    edit: PropsOp::Set {
      instance: inst,
      prop: pid,
      value: Some(json!(true)),
    },
  });
  assert!(r.is_err());
}

#[test]
fn deleting_a_property_unbinds_layers_and_forgets_values() {
  let mut k = kit();
  let pid = add_bound(&mut k, "Label", PropKind::Text, "Label");
  let inst = instance_of_default(&mut k);
  set_prop(&mut k, &inst, &pid, Some(json!("Gone")));
  k.e
    .dispatch(Command::ComponentProps {
      edit: PropsOp::Delete {
        component: k.default.clone(),
        prop: pid,
      },
    })
    .unwrap();
  assert!(k.e.doc.get(&named(&k.e, &k.default, "Label")).unwrap().prop_refs.is_none());
  assert!(k.e.doc.get(&inst).unwrap().instance.as_ref().unwrap().prop_values.is_empty());
  assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Buy");
}

#[test]
fn react_export_turns_properties_into_props() {
  let mut k = kit();
  let show = add_bound(&mut k, "Show icon", PropKind::Boolean, "Icon");
  let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
  let glyph = add_bound(&mut k, "Glyph", PropKind::InstanceSwap, "Icon");
  let check = k.check.clone();
  let page = shape(&mut k.e, NodeType::Frame, 8000.0);
  rename(&mut k.e, &page, "Home");
  let inst = instance_of_default(&mut k);
  k.e
    .dispatch(Command::MoveToParent {
      ids: vec![inst.clone()],
      parent: Some(page.clone()),
      index: None,
    })
    .unwrap();
  set_prop(&mut k, &inst, &show, Some(json!(false)));
  set_prop(&mut k, &inst, &label, Some(json!("Go")));
  let code = crate::codegen::export_react(&k.e.doc, &page, &crate::text::HeuristicMeasurer);
  assert!(code.contains(" showIcon={false}"), "{code}");
  assert!(code.contains(" label=\"Go\""), "{code}");
  // The component's function takes them, with the main component's state as defaults.
  assert!(code.contains("({ label = \"Buy\", showIcon = true, glyph, className"), "{code}");
  assert!(code.contains(">{label}</p>"), "{code}");
  assert!(
    code.contains("; showIcon?: boolean; label?: string; glyph?: React.ReactNode;"),
    "{code}"
  );
  assert!(code.contains("{showIcon && (glyph ?? <Arrow "), "{code}");
  // A swapped icon is a prop holding the other component.
  set_prop(&mut k, &inst, &glyph, Some(json!(check)));
  let code = crate::codegen::export_react(&k.e.doc, &page, &crate::text::HeuristicMeasurer);
  assert!(code.contains(" glyph={<Check />}"), "{code}");
  // Any other override inlines the instance again.
  let bg = named(&k.e, &inst, "Bg");
  k.e
    .dispatch(Command::Update {
      ids: vec![bg],
      patch: json!({ "cornerRadius": 12 }),
    })
    .unwrap();
  let code = crate::codegen::export_react(&k.e.doc, &page, &crate::text::HeuristicMeasurer);
  assert!(!code.contains(" glyph={<Check />}"), "{code}");
  // HTML export shows the instance as it looks.
  let html = crate::codegen::export_html(&k.e.doc, &page, &crate::text::HeuristicMeasurer);
  assert!(html.contains("Go"), "{html}");
}

#[test]
fn ai_tool_defines_binds_and_sets_properties_in_one_undo_step() {
  let mut k = kit();
  let label = named(&k.e, &k.default, "Label");
  let icon = named(&k.e, &k.default, "Icon");
  let inst = instance_of_default(&mut k);
  let (default, set) = (k.default.clone(), k.set.clone());
  k.e
    .dispatch(Command::Ai {
      tool: "set_component_props".into(),
      input: json!({ "ops": [
        { "op": "add", "component": default, "name": "Label", "kind": "text", "bind": label },
        { "op": "add", "component": default, "name": "Show icon", "kind": "boolean", "bind": icon },
        { "op": "set", "instance": inst, "prop": "Label", "value": "Hi" },
        { "op": "set", "instance": inst, "prop": "Show icon", "value": false },
      ] }),
    })
    .unwrap();
  assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Hi");
  assert!(!k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  assert_eq!(props_of(&k.e.doc, &set).len(), 2);
  // Properties are visible to Claude.
  let nodes = crate::ai::execute(&mut k.e, "get_nodes", &json!({ "ids": [inst.clone(), set.clone()] })).unwrap();
  assert_eq!(nodes[0]["componentProps"]["groups"][0]["props"][0]["name"], "Label");
  assert_eq!(nodes[0]["componentProps"]["groups"][0]["props"][0]["value"], "Hi");
  assert_eq!(nodes[1]["componentProps"]["props"][1]["name"], "Show icon");
  let doc = crate::ai::execute(&mut k.e, "get_document", &json!({})).unwrap();
  assert!(doc["components"].to_string().contains("Show icon"), "{doc}");
  assert_eq!(doc["layers"].to_string().matches("\"Label\":\"Hi\"").count(), 1, "{doc}");
  // One undo for the whole call.
  k.e.dispatch(Command::Undo).unwrap();
  assert!(props_of(&k.e.doc, &set).is_empty());
  assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Buy");
  // Bad input is an error, not a panic.
  let r = crate::ai::execute(&mut k.e, "set_component_props", &json!({ "ops": [{ "op": "nope" }] }));
  assert!(r.is_err());
}

fn kit() -> Kit {
  let mut e = Engine::new(Box::new(crate::text::HeuristicMeasurer), 7);
  let icon_comp = |e: &mut Engine, name: &str, x: f64| {
    let r = id(
      e.dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x,
        y: 2000.0,
        width: 16.0,
        height: 16.0,
        parent: None,
      })
      .unwrap(),
    );
    let c = id(e.dispatch(Command::CreateComponent { ids: vec![r] }).unwrap());
    rename(e, &c, name);
    c
  };
  let arrow = icon_comp(&mut e, "Arrow", 0.0);
  let check = icon_comp(&mut e, "Check", 100.0);
  let make = |e: &mut Engine, x: f64, name: &str| {
    let f = id(
      e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x,
        y: 0.0,
        width: 160.0,
        height: 40.0,
        parent: None,
      })
      .unwrap(),
    );
    let bg = id(
      e.dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x,
        y: 0.0,
        width: 160.0,
        height: 40.0,
        parent: Some(f.clone()),
      })
      .unwrap(),
    );
    rename(e, &bg, "Bg");
    let t = id(
      e.dispatch(Command::CreateText {
        x: x + 30.0,
        y: 10.0,
        characters: "Buy".into(),
        parent: Some(f.clone()),
      })
      .unwrap(),
    );
    rename(e, &t, "Label");
    let arrow = e.doc.components().iter().find(|c| c.name == "Arrow").unwrap().id.clone();
    let icon = id(
      e.dispatch(Command::CreateInstance {
        component_id: arrow,
        x: x + 8.0,
        y: 12.0,
        parent: Some(f.clone()),
        anchor: None,
        into_components: false,
      })
      .unwrap(),
    );
    rename(e, &icon, "Icon");
    let c = id(e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
    rename(e, &c, name);
    c
  };
  let default = make(&mut e, 0.0, "State=Default");
  let hover = make(&mut e, 300.0, "State=Hover");
  let set = id(
    e.dispatch(Command::CombineVariants {
      ids: vec![default.clone(), hover.clone()],
    })
    .unwrap(),
  );
  rename(&mut e, &set, "Button");
  Kit {
    e,
    default,
    hover,
    arrow,
    check,
    set,
  }
}

/// Adds a property to the set and binds the layer named `layer` in every variant to it.
fn add_bound(k: &mut Kit, name: &str, kind: PropKind, layer: &str) -> String {
  let first = named(&k.e, &k.default, layer);
  let pid = id(
    k.e
      .dispatch(Command::ComponentProps {
        edit: PropsOp::Add {
          component: k.default.clone(),
          name: name.into(),
          kind,
          default: None,
          bind: Some(first),
        },
      })
      .unwrap(),
  );
  let other = named(&k.e, &k.hover, layer);
  k.e
    .dispatch(Command::ComponentProps {
      edit: PropsOp::Bind {
        node: other,
        field: PropField::of(kind),
        prop: Some(pid.clone()),
      },
    })
    .unwrap();
  pid
}

fn set_prop(k: &mut Kit, instance: &str, prop: &str, value: Option<Value>) {
  k.e
    .dispatch(Command::ComponentProps {
      edit: PropsOp::Set {
        instance: instance.into(),
        prop: prop.into(),
        value,
      },
    })
    .unwrap();
}

fn instance_of_default(k: &mut Kit) -> String {
  let comp = k.default.clone();
  instance(k, &comp)
}

fn instance(k: &mut Kit, comp: &str) -> String {
  id(
    k.e
      .dispatch(Command::CreateInstance {
        component_id: comp.into(),
        x: 0.0,
        y: 500.0 + k.e.doc.nodes.len() as f64 * 3.0,
        parent: None,
        anchor: None,
        into_components: false,
      })
      .unwrap(),
  )
}

fn rename(e: &mut Engine, id: &str, name: &str) {
  e.dispatch(Command::Update {
    ids: vec![id.to_string()],
    patch: json!({ "name": name }),
  })
  .unwrap();
}

fn shape(e: &mut Engine, kind: NodeType, x: f64) -> String {
  id(
    e.dispatch(Command::CreateShape {
      kind,
      x,
      y: 3000.0,
      width: 100.0,
      height: 40.0,
      parent: None,
    })
    .unwrap(),
  )
}

fn id(v: Value) -> String {
  v["id"].as_str().unwrap().to_string()
}

/// The first layer named `name` under `root`.
fn named(e: &Engine, root: &str, name: &str) -> String {
  e.doc
    .subtree(root)
    .into_iter()
    .skip(1)
    .find(|i| e.doc.get(i).map(|n| n.name == name).unwrap_or(false))
    .unwrap_or_else(|| panic!("no {name} under {root}"))
}

fn nested_instance(e: &Engine, root: &str) -> String {
  e.doc
    .subtree(root)
    .into_iter()
    .skip(1)
    .find(|i| e.doc.get(i).map(|n| n.kind == NodeType::Instance).unwrap_or(false))
    .unwrap()
}

fn text(e: &Engine, id: &str) -> String {
  e.doc.get(id).unwrap().text.as_ref().unwrap().characters.clone()
}

fn comp_of(e: &Engine, id: &str) -> String {
  e.doc.get(id).unwrap().instance.as_ref().unwrap().component_id.clone()
}

/// Nested instances, layers that outlive their properties, perf and code export.
mod review {
  use super::*;

  /// A Card main holding a Button instance whose label the Card's author set to "Pay"; its
  /// properties are exposed on the Card.
  fn card(k: &mut Kit, label: &str) -> (String, String) {
    let frame = shape(&mut k.e, NodeType::Frame, 5000.0);
    let inner = instance_of_default(k);
    k.e
      .dispatch(Command::MoveToParent {
        ids: vec![inner.clone()],
        parent: Some(frame.clone()),
        index: None,
      })
      .unwrap();
    let card = id(k.e.dispatch(Command::CreateComponent { ids: vec![frame] }).unwrap());
    set_prop(k, &inner, label, Some(json!("Pay")));
    k.e
      .dispatch(Command::ComponentProps {
        edit: PropsOp::Expose {
          instance: inner.clone(),
          expose: true,
        },
      })
      .unwrap();
    (card, inner)
  }

  fn update(k: &mut Kit, id: &str, patch: Value) {
    k.e
      .dispatch(Command::Update {
        ids: vec![id.to_string()],
        patch,
      })
      .unwrap();
  }

  #[test]
  fn a_nested_value_equal_to_the_inner_default_sticks() {
    let mut k = kit();
    let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
    let (card, _) = card(&mut k, &label);
    let ci = instance(&mut k, &card);
    let nested = nested_instance(&k.e, &ci);
    assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Pay");
    // "Buy" is the Button's own default, but not what this Card shows.
    set_prop(&mut k, &nested, &label, Some(json!("Buy")));
    assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Buy");
    let d = k.e.query(Query::ComponentProps { id: ci.clone() }).unwrap();
    assert_eq!(d["groups"][0]["props"][0]["custom"], json!(true));
    // Back to what the Card shows: no value of its own.
    set_prop(&mut k, &nested, &label, Some(json!("Pay")));
    assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Pay");
    assert!(k.e.doc.get(&ci).unwrap().instance.as_ref().unwrap().overrides.is_empty());
  }

  #[test]
  fn typing_into_a_nested_label_survives_a_resync() {
    let mut k = kit();
    let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
    let (card, _) = card(&mut k, &label);
    let ci = instance(&mut k, &card);
    let nested = nested_instance(&k.e, &ci);
    let l = named(&k.e, &nested, "Label");
    k.e
      .dispatch(Command::SetText {
        id: l,
        characters: "Buy".into(),
      })
      .unwrap();
    let t = named(&k.e, &k.default, "Label");
    update(&mut k, &t, json!({ "text": { "fontSize": 30 } }));
    assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Buy");
  }

  #[test]
  fn three_levels_show_what_the_middle_component_sets() {
    let mut k = kit();
    let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
    let (card, _) = card(&mut k, &label);
    // A Toolbar main holding a Card instance whose nested Button says "Order".
    let frame = shape(&mut k.e, NodeType::Frame, 9000.0);
    let ci = instance(&mut k, &card);
    k.e
      .dispatch(Command::MoveToParent {
        ids: vec![ci.clone()],
        parent: Some(frame.clone()),
        index: None,
      })
      .unwrap();
    let toolbar = id(k.e.dispatch(Command::CreateComponent { ids: vec![frame] }).unwrap());
    let nested = nested_instance(&k.e, &ci);
    set_prop(&mut k, &nested, &label, Some(json!("Order")));
    assert_eq!(text(&k.e, &named(&k.e, &nested, "Label")), "Order");
    let ti = instance(&mut k, &toolbar);
    let shown = k
      .e
      .doc
      .subtree(&ti)
      .into_iter()
      .find(|i| k.e.doc.get(i).unwrap().name == "Label")
      .unwrap();
    assert_eq!(text(&k.e, &shown), "Order");
    // An edit of the Button main keeps both levels' values.
    let t = named(&k.e, &k.default, "Label");
    update(&mut k, &t, json!({ "text": { "fontSize": 30 } }));
    let shown = k
      .e
      .doc
      .subtree(&ti)
      .into_iter()
      .find(|i| k.e.doc.get(i).unwrap().name == "Label")
      .unwrap();
    assert_eq!(text(&k.e, &shown), "Order");
    assert_eq!(k.e.doc.get(&shown).unwrap().text.as_ref().unwrap().font_size, 30.0);
  }

  #[test]
  fn detaching_a_nested_instance_keeps_the_outer_binding_of_the_detached_layer() {
    let mut k = kit();
    let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
    let (card, inner) = card(&mut k, &label);
    let show = id(
      k.e
        .dispatch(Command::ComponentProps {
          edit: PropsOp::Add {
            component: card.clone(),
            name: "Show button".into(),
            kind: PropKind::Boolean,
            default: None,
            bind: Some(inner.clone()),
          },
        })
        .unwrap(),
    );
    let child_label = named(&k.e, &inner, "Label");
    assert!(k.e.doc.get(&child_label).unwrap().prop_refs.is_some());
    k.e.dispatch(Command::DetachInstance { ids: vec![inner.clone()] }).unwrap();
    let r = k.e.doc.get(&inner).unwrap().prop_refs.clone().unwrap();
    assert_eq!(r.visible, Some(show), "the detached frame still follows the Card's boolean");
    assert!(r.swap.is_none() && r.characters.is_none());
    assert!(
      k.e.doc.get(&child_label).unwrap().prop_refs.is_none(),
      "its layers follow the Button's properties no more"
    );
  }

  #[test]
  fn redirected_edits_undo_and_work_on_several_instances() {
    let mut k = kit();
    let pid = add_bound(&mut k, "Show icon", PropKind::Boolean, "Icon");
    let a = instance_of_default(&mut k);
    let b = instance_of_default(&mut k);
    let (ia, ib) = (named(&k.e, &a, "Icon"), named(&k.e, &b, "Icon"));
    update(&mut k, &ia, json!({ "visible": false }));
    k.e
      .dispatch(Command::Update {
        ids: vec![ia.clone(), ib.clone()],
        patch: json!({ "visible": false }),
      })
      .unwrap();
    for i in [&a, &b] {
      let info = k.e.doc.get(i).unwrap().instance.clone().unwrap();
      assert_eq!(info.prop_values.get(&pid), Some(&json!(false)));
      assert!(info.overrides.is_empty());
    }
    k.e.dispatch(Command::Undo).unwrap();
    assert!(k.e.doc.get(&named(&k.e, &b, "Icon")).unwrap().visible);
    assert!(!k.e.doc.get(&named(&k.e, &a, "Icon")).unwrap().visible);
  }

  #[test]
  fn a_pasted_variant_instance_keeps_its_values_and_stays_editable() {
    let mut k = kit();
    let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
    let inst = instance_of_default(&mut k);
    set_prop(&mut k, &inst, &label, Some(json!("Checkout")));
    let clip = k.e.copy(std::slice::from_ref(&inst));
    let mut e2 = Engine::new(Box::new(crate::text::HeuristicMeasurer), 3);
    let r = e2
      .dispatch(Command::Paste {
        data: clip,
        parent: None,
        x: None,
        y: None,
      })
      .unwrap();
    let pasted = r["created"][0].as_str().unwrap().to_string();
    let comp = comp_of(&e2, &pasted);
    assert_eq!(props_of(&e2.doc, &comp).len(), 1, "the variant brings the property it uses");
    assert_eq!(text(&e2, &named(&e2, &pasted, "Label")), "Checkout");
    let l = named(&e2, &pasted, "Label");
    e2.dispatch(Command::SetText {
      id: l,
      characters: "Hello".into(),
    })
    .unwrap();
    let t = named(&e2, &comp, "Label");
    e2.dispatch(Command::Update {
      ids: vec![t],
      patch: json!({ "text": { "fontSize": 30 } }),
    })
    .unwrap();
    assert_eq!(text(&e2, &named(&e2, &pasted, "Label")), "Hello");
  }

  #[test]
  fn a_variant_that_leaves_its_set_keeps_its_properties() {
    let mut k = kit();
    let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
    let hover = k.hover.clone();
    k.e
      .dispatch(Command::MoveToParent {
        ids: vec![hover.clone()],
        parent: None,
        index: None,
      })
      .unwrap();
    assert_eq!(props_of(&k.e.doc, &hover).len(), 1);
    assert_eq!(props_of(&k.e.doc, &hover)[0].id, label);
    let inst = instance(&mut k, &hover);
    set_prop(&mut k, &inst, &label, Some(json!("X")));
    let l = named(&k.e, &inst, "Label");
    k.e
      .dispatch(Command::SetText {
        id: l,
        characters: "Typed".into(),
      })
      .unwrap();
    let t = named(&k.e, &hover, "Label");
    update(&mut k, &t, json!({ "text": { "fontSize": 30 } }));
    assert_eq!(text(&k.e, &named(&k.e, &inst, "Label")), "Typed");
  }

  #[test]
  fn ungrouping_a_set_gives_each_variant_the_properties_it_uses() {
    let mut k = kit();
    let show = add_bound(&mut k, "Show icon", PropKind::Boolean, "Icon");
    let (default, hover, set) = (k.default.clone(), k.hover.clone(), k.set.clone());
    let inst = instance_of_default(&mut k);
    set_prop(&mut k, &inst, &show, Some(json!(false)));
    k.e.dispatch(Command::Ungroup { ids: vec![set] }).unwrap();
    for c in [&default, &hover] {
      assert_eq!(props_of(&k.e.doc, c).len(), 1, "{c}");
    }
    assert!(!k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
    let t = named(&k.e, &default, "Label");
    update(&mut k, &t, json!({ "text": { "fontSize": 30 } }));
    assert!(
      !k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible,
      "the value still applies"
    );
  }

  #[test]
  fn a_dangling_reference_controls_nothing() {
    let mut k = kit();
    let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
    let inst = instance_of_default(&mut k);
    // The layer points at a property its component doesn't have.
    let t = named(&k.e, &k.default, "Label");
    k.e.doc.get_mut(&t).unwrap().prop_refs.as_mut().unwrap().characters = Some("pr_gone".into());
    crate::components::sync_instance(&mut k.e.doc, &inst, &mut k.e.gen);
    let l = named(&k.e, &inst, "Label");
    k.e
      .dispatch(Command::SetText {
        id: l,
        characters: "Typed".into(),
      })
      .unwrap();
    update(&mut k, &t, json!({ "text": { "fontSize": 30 } }));
    assert_eq!(
      text(&k.e, &named(&k.e, &inst, "Label")),
      "Typed",
      "recorded as an ordinary override"
    );
    let _ = label;
  }

  #[test]
  fn moving_a_set_does_not_touch_its_variants() {
    let mut k = kit();
    add_bound(&mut k, "Show icon", PropKind::Boolean, "Icon");
    for _ in 0..5 {
      k.e
        .dispatch(Command::Duplicate {
          ids: vec![k.default.clone()],
        })
        .unwrap();
    }
    let before = crate::components::FINGERPRINTS.with(|c| c.get());
    for i in 0..10 {
      let set = k.set.clone();
      update(&mut k, &set, json!({ "x": 100.0 + i as f64 }));
    }
    assert_eq!(
      crate::components::FINGERPRINTS.with(|c| c.get()),
      before,
      "no variant re-fingerprinted"
    );
    // A change of the set's properties still does reach them.
    let pid = props_of(&k.e.doc, &k.set)[0].id.clone();
    let inst = instance_of_default(&mut k);
    k.e
      .dispatch(Command::ComponentProps {
        edit: PropsOp::Update {
          component: k.set.clone(),
          prop: pid.clone(),
          name: Some("Icon visible".into()),
          default: Some(json!(false)),
          options: None,
        },
      })
      .unwrap();
    assert!(!k.e.doc.get(&named(&k.e, &inst, "Icon")).unwrap().visible);
  }

  /// Relay-ordered collab: two people set different values on one instance at once. Merging is
  /// per node property, so one of the two `instance` values wins as a whole; what matters is that
  /// both editors and the relay's copy end with exactly the same thing, also after later changes.
  #[test]
  fn concurrent_values_on_one_instance_end_identical_everywhere() {
    let mut k = kit();
    let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
    let show = add_bound(&mut k, "Show icon", PropKind::Boolean, "Icon");
    let inst = instance_of_default(&mut k);
    let mut b = Engine::new(Box::new(crate::text::HeuristicMeasurer), 9);
    b.load(&k.e.to_json()).unwrap();
    let mut relay = k.e.doc.clone();
    k.e.collab_reset(true, true);
    b.collab_reset(true, true);
    set_prop(&mut k, &inst, &label, Some(json!("Mine")));
    b.dispatch(Command::ComponentProps {
      edit: PropsOp::Set {
        instance: inst.clone(),
        prop: show.clone(),
        value: Some(json!(false)),
      },
    })
    .unwrap();
    let (da, db) = (k.e.collab_delta(), b.collab_delta());
    // The relay orders A's change, then B's.
    crate::collab::apply(&mut relay, &da).unwrap();
    crate::collab::apply(&mut relay, &db).unwrap();
    k.e.dispatch(Command::CollabAck { rejected: false }).unwrap();
    k.e.dispatch(Command::ApplyRemote { delta: db, local: false }).unwrap();
    b.dispatch(Command::ApplyRemote { delta: da, local: false }).unwrap();
    b.dispatch(Command::CollabAck { rejected: false }).unwrap();
    let state = |d: &crate::model::Document| -> Vec<String> {
      let mut out = vec![format!("{:?}", d.get(&inst).unwrap().instance)];
      for i in d.subtree(&inst).iter().skip(1) {
        let n = d.get(i).unwrap();
        out.push(format!(
          "{} {} {} {:?}",
          i,
          n.name,
          n.visible,
          n.text.as_ref().map(|t| t.characters.clone())
        ));
      }
      out
    };
    assert_eq!(state(&k.e.doc), state(&relay), "A matches the relay");
    assert_eq!(state(&b.doc), state(&relay), "B matches the relay");
    // An unrelated remote change arrives while A has a local edit waiting: still identical.
    shape(&mut b, NodeType::Frame, 7000.0);
    let dc = b.collab_delta();
    crate::collab::apply(&mut relay, &dc).unwrap();
    b.dispatch(Command::CollabAck { rejected: false }).unwrap();
    shape(&mut k.e, NodeType::Rectangle, 9000.0);
    let _ = k.e.collab_delta();
    k.e.dispatch(Command::ApplyRemote { delta: dc, local: false }).unwrap();
    assert_eq!(state(&k.e.doc), state(&relay), "A still matches the relay");
    assert_eq!(state(&b.doc), state(&relay), "B still matches the relay");
  }

  #[test]
  fn deleting_a_property_leaves_no_trace_even_in_swap_records() {
    let mut k = kit();
    let label = add_bound(&mut k, "Label", PropKind::Text, "Label");
    let (card, _) = card(&mut k, &label);
    let ci = instance(&mut k, &card);
    let nested = nested_instance(&k.e, &ci);
    k.e
      .dispatch(Command::SetVariant {
        id: nested.clone(),
        prop: "State".into(),
        value: "Hover".into(),
      })
      .unwrap();
    set_prop(&mut k, &nested, &label, Some(json!("Deep")));
    assert!(k.e.to_json().contains("Deep"));
    let t = named(&k.e, &k.default, "Label");
    k.e.dispatch(Command::Delete { ids: vec![t] }).unwrap();
    k.e
      .dispatch(Command::ComponentProps {
        edit: PropsOp::Delete {
          component: k.set.clone(),
          prop: label.clone(),
        },
      })
      .unwrap();
    let json = k.e.to_json();
    assert!(!json.contains(&label), "no trace of the deleted property id");
    assert!(!json.contains("Deep"));
  }

  #[test]
  fn binding_drops_the_overrides_it_replaces() {
    let mut k = kit();
    let inst = instance_of_default(&mut k);
    let icon = named(&k.e, &inst, "Icon");
    update(&mut k, &icon, json!({ "visible": false, "opacity": 0.5 }));
    add_bound(&mut k, "Icon", PropKind::Boolean, "Icon");
    let o = k.e.doc.get(&inst).unwrap().instance.as_ref().unwrap().overrides.clone();
    let entry = o.values().next().unwrap();
    assert!(entry.get("visible").is_none() && entry.get("opacity").is_some(), "{entry}");
  }

  #[test]
  fn swap_options_leave_out_the_instances_own_component() {
    let mut k = kit();
    add_bound(&mut k, "Glyph", PropKind::InstanceSwap, "Icon");
    let inst = instance_of_default(&mut k);
    let d = k.e.query(Query::ComponentProps { id: inst }).unwrap();
    let offered: Vec<Value> = d["groups"][0]["props"][0]["options"]
      .as_array()
      .unwrap()
      .iter()
      .map(|o| o["id"].clone())
      .collect();
    assert!(offered.contains(&json!(k.check)));
    assert!(
      !offered.contains(&json!(k.default)) && !offered.contains(&json!(k.hover)),
      "{offered:?}"
    );
  }

  #[test]
  fn names_that_would_clash_as_props_are_refused() {
    let mut k = kit();
    let add = |k: &mut Kit, name: &str| {
      k.e.dispatch(Command::ComponentProps {
        edit: PropsOp::Add {
          component: k.set.clone(),
          name: name.into(),
          kind: PropKind::Boolean,
          default: None,
          bind: None,
        },
      })
    };
    assert!(add(&mut k, "State").is_err(), "a variant property's name");
    assert!(add(&mut k, "state").is_err(), "the same React prop");
    add(&mut k, "Icon").unwrap();
    assert!(add(&mut k, "icon").is_err(), "the same React prop as another property");
  }

  #[test]
  fn exported_props_are_valid_jsx_with_distinct_names() {
    let mut k = kit();
    let names = [
      ("Class name", PropKind::Text, "Label"),
      ("Key", PropKind::Boolean, "Icon"),
      ("Default", PropKind::Boolean, "Bg"),
    ];
    let mut ids = Vec::new();
    for (name, kind, layer) in names {
      ids.push(add_bound(&mut k, name, kind, layer));
    }
    let page = shape(&mut k.e, NodeType::Frame, 8000.0);
    rename(&mut k.e, &page, "Home");
    let inst = instance_of_default(&mut k);
    k.e
      .dispatch(Command::MoveToParent {
        ids: vec![inst.clone()],
        parent: Some(page.clone()),
        index: None,
      })
      .unwrap();
    set_prop(&mut k, &inst, &ids[0], Some(json!("Say \"hi\" & <bye>\nnow \\o/")));
    set_prop(&mut k, &inst, &ids[1], Some(json!(false)));
    let files = crate::codegen::export_project(&k.e.doc, &crate::text::HeuristicMeasurer);
    let all: String = files.iter().map(|f| f.content.clone()).collect();
    // Reserved and taken names get a suffix; the text can't be a plain attribute.
    assert!(
      all.contains("classNameProp") && all.contains("keyProp") && all.contains("defaultProp"),
      "{all}"
    );
    assert!(all.contains("classNameProp={\"Say \\\"hi\\\" & <bye>\\nnow \\\\o/\"}"), "{all}");
    assert!(!all.contains("classNameProp=\"Say"), "{all}");
    if let Ok(dir) = std::env::var("OUT_PROJ") {
      for f in files {
        let p = std::path::Path::new(&dir).join(&f.path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, f.content).unwrap();
      }
    }
  }
}
