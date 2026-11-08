//! Big-file timings: `cargo run --release -p designotron-engine --example perf18 [layers] [scenario]`.
//!
//! Builds a file of the shape QA round 18 measured (hundreds of screens, two components, a Theme
//! collection with Light/Dark, every screen fill and non-instance text bound, every other screen
//! pinned to Dark) and times one operation per scenario: settext, update1, nudge, move1, mode1,
//! upd1000, delvar, clip, clip2k, create10, render. Prints the median of the runs of each.
use designotron_engine::engine::{Command, Engine, Query};
use designotron_engine::text::HeuristicMeasurer;
use serde_json::{json, Value};
use std::time::Instant;

fn ai(e: &mut Engine, tool: &str, input: Value) -> Value {
  e.dispatch(Command::Ai { tool: tool.into(), input }).unwrap()
}

fn main() {
  let target: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(20000);
  let only: Option<String> = std::env::args().nth(2);
  let mut e = Engine::new(Box::new(HeuristicMeasurer), 1);
  let t = Instant::now();
  let card = ai(
    &mut e,
    "create_nodes",
    json!({"nodes":[{"type":"frame","name":"Card","x":-1000,"y":0,"width":358,"layout":{"direction":"vertical","gap":8,"padding":12},"cornerRadius":12,"fill":"#FFFFFF","children":[
    {"type":"rectangle","name":"Cover","width":"fill","height":140,"cornerRadius":8,"fill":"#ddd"},
    {"type":"text","name":"Title","text":"Card title","fontSize":17,"fontWeight":600,"fill":"#111827"},
    {"type":"text","name":"Body","text":"Secondary copy that explains the card","fontSize":13,"fill":"#6B7280","width":"fill"},
    {"type":"frame","name":"Action","width":120,"height":36,"cornerRadius":18,"fill":"#2563EB","children":[{"type":"text","name":"Label","text":"Open","fontSize":14,"fontWeight":600,"fill":"#FFFFFF"}]}]}]}),
  );
  let card_id = card["created"][0]["id"].as_str().unwrap().to_string();
  let cm = ai(&mut e, "arrange", json!({"action":"create_component","ids":[card_id]}));
  let card_main = cm["id"].as_str().map(String::from).unwrap_or(card_id);
  let nav = ai(
    &mut e,
    "create_nodes",
    json!({"nodes":[{"type":"frame","name":"NavItem","x":-1000,"y":500,"width":78,"height":56,"layout":{"direction":"vertical","gap":4,"padding":4},"children":[
    {"type":"rectangle","name":"Icon","width":24,"height":24,"fill":"#9CA3AF","cornerRadius":6},{"type":"text","name":"Label","text":"Home","fontSize":11,"fill":"#6B7280"}]}]}),
  );
  let nav_id = nav["created"][0]["id"].as_str().unwrap().to_string();
  let nm = ai(&mut e, "arrange", json!({"action":"create_component","ids":[nav_id]}));
  let nav_main = nm["id"].as_str().map(String::from).unwrap_or(nav_id);
  let screen = |i: usize| {
    let rows: Vec<Value> = (0..6).map(|k| json!({"type":"frame","name":format!("Row {k}"),"width":"fill","layout":{"direction":"horizontal","gap":12,"crossAxis":"center"},"children":[
      {"type":"rectangle","name":"Avatar","width":48,"height":48,"cornerRadius":24,"fill":"#ccc"},
      {"type":"frame","name":"Text","width":"fill","layout":{"direction":"vertical","gap":2},"children":[
        {"type":"text","name":"Name","text":format!("Project {i}-{k}"),"fontSize":16,"fontWeight":600,"fill":"#111827"},
        {"type":"text","name":"Meta","text":"Updated 2h ago · 3 comments","fontSize":13,"fill":"#6B7280"}]},
      {"type":"rectangle","name":"Chevron","width":8,"height":14,"fill":"#9CA3AF"}]})).collect();
    let mut ch = vec![
      json!({"type":"frame","name":"Status bar","width":"fill","height":44,"layout":{"direction":"horizontal"},"children":[{"type":"text","name":"Time","text":"9:41","fontSize":15,"fontWeight":600},{"type":"rectangle","name":"Battery","width":24,"height":12,"fill":"#111111","cornerRadius":3}]}),
      json!({"type":"frame","name":"Header","width":"fill","layout":{"direction":"horizontal","gap":8},"children":[{"type":"text","name":"Greeting","text":format!("Good morning, Ada {i}"),"fontSize":24,"fontWeight":700,"width":"fill","fill":"#111827"},{"type":"rectangle","name":"Bell","width":24,"height":24,"fill":"#E5E7EB","cornerRadius":12}]}),
      json!({"type":"frame","name":"Search","width":"fill","height":44,"cornerRadius":12,"fill":"#F3F4F6","layout":{"direction":"horizontal","padding":12},"children":[{"type":"text","name":"Placeholder","text":"Search projects","fontSize":15,"fill":"#6B7280"}]}),
    ];
    ch.extend(rows);
    ch.push(json!({"type":"instance","name":"Card","componentId":card_main,"width":358}));
    ch.push(json!({"type":"instance","name":"Card","componentId":card_main,"width":358}));
    ch.push(json!({"type":"frame","name":"Tab bar","width":"fill","height":64,"fill":"#FFFFFF","layout":{"direction":"horizontal","padding":4},"children":(0..4).map(|k| json!({"type":"instance","name":format!("Tab {k}"),"componentId":nav_main})).collect::<Vec<_>>()}));
    json!({"type":"frame","name":format!("Screen {i}"),"x":(i%25)*440,"y":(i/25)*920,"width":390,"height":844,"fill":"#FFFFFF","layout":{"direction":"vertical","gap":12,"padding":16},"children":ch})
  };
  let screens = ((target.saturating_sub(e.doc.nodes.len())) / 68).max(1);
  let mut batch_ms = vec![];
  let mut s = 0;
  while s < screens {
    let specs: Vec<Value> = (s..(s + 10).min(screens)).map(screen).collect();
    let bt = Instant::now();
    ai(&mut e, "create_nodes", json!({"nodes": specs}));
    batch_ms.push(bt.elapsed().as_secs_f64() * 1000.0);
    s += 10;
  }
  ai(
    &mut e,
    "define_variables",
    json!({"collection":"Theme","modes":["Light","Dark"],"variables":[
    {"name":"Surface","type":"color","values":{"Light":"#FFFFFF","Dark":"#0B0F19"}},
    {"name":"Text","type":"color","values":{"Light":"#111827","Dark":"#F9FAFB"}},
    {"name":"Muted","type":"color","values":{"Light":"#6B7280","Dark":"#9CA3AF"}},
    {"name":"Primary","type":"color","values":{"Light":"#2563EB","Dark":"#60A5FA"}}]}),
  );
  let nodes: Vec<_> = e.doc.nodes.values().cloned().collect();
  let screen_ids: Vec<String> = nodes
    .iter()
    .filter(|n| n.name.starts_with("Screen ") && n.parent.is_none())
    .map(|n| n.id.clone())
    .collect();
  let text_ids: Vec<String> = nodes
    .iter()
    .filter(|n| n.text.is_some() && n.instance.is_none())
    .map(|n| n.id.clone())
    .collect();
  let theme = e.doc.variables[0].id.clone();
  let dark = e.doc.variables[0].modes[1].id.clone();
  let var = |e: &Engine, name: &str| e.doc.variables[0].variables.iter().find(|v| v.name == name).unwrap().id.clone();
  let (surface, textv) = (var(&e, "Surface"), var(&e, "Text"));
  e.dispatch(Command::BindVariable {
    ids: screen_ids.clone(),
    property: "fill".into(),
    variable: Some(surface),
  })
  .unwrap();
  e.dispatch(Command::BindVariable {
    ids: text_ids.clone(),
    property: "fill".into(),
    variable: Some(textv.clone()),
  })
  .unwrap();
  for (i, sid) in screen_ids.iter().enumerate() {
    if i % 2 == 1 {
      e.dispatch(Command::SetVariableMode {
        ids: vec![sid.clone()],
        collection: theme.clone(),
        mode: Some(dark.clone()),
      })
      .unwrap();
    }
  }
  let bound = e.doc.nodes.values().filter(|n| !n.bindings.is_empty()).count();
  println!(
    "built {} nodes ({} screens, {} bound) in {:?}; create_nodes batch p50 {:.1} ms",
    e.doc.nodes.len(),
    screen_ids.len(),
    bound,
    t.elapsed(),
    {
      let mut b = batch_ms.clone();
      b.sort_by(|a, b| a.partial_cmp(b).unwrap());
      b[b.len() / 2]
    }
  );

  let run = |label: &str| only.as_deref().map(|o| label.contains(o)).unwrap_or(true);
  let time = |label: &str, n: u32, e: &mut Engine, f: &mut dyn FnMut(&mut Engine, u32)| {
    let mut each: Vec<f64> = Vec::new();
    for i in 0..n {
      let t = Instant::now();
      f(e, i);
      each.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    each.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("{label:<48} {:>9.2} ms (median of {n})", each[each.len() / 2]);
  };
  let greet = nodes.iter().find(|n| n.name == "Greeting").unwrap().id.clone();
  let rect = nodes.iter().find(|n| n.name == "Bell").unwrap().id.clone();
  if run("settext") {
    let mut s = String::from("Good morning, Ada 0");
    time("settext: SetText one char (typing)", 20, &mut e, &mut |e, _| {
      s.push('x');
      e.dispatch(Command::SetText {
        id: greet.clone(),
        characters: s.clone(),
        runs: None,
      })
      .unwrap();
    });
  }
  if run("edittext") {
    // One keystroke in a text room, as the shell does it: EditText, then the delta it sends, then
    // the room's ack (which re-applies the change on the room's document).
    e.collab_reset(true, true, true);
    e.collab_enable_text(193_847_261);
    let mut at = e.doc.get(&greet).unwrap().text.as_ref().unwrap().characters.chars().count();
    time("edittext: EditText + delta + ack (typing in a room)", 20, &mut e, &mut |e, _| {
      e.dispatch(Command::EditText {
        id: greet.clone(),
        start: at,
        end: at,
        text: "x".into(),
      })
      .unwrap();
      at += 1;
      std::hint::black_box(e.collab_delta());
      e.dispatch(Command::CollabAck { rejected: false }).unwrap();
    });
    e.collab_reset(false, false, false);
  }
  if run("update1") {
    time("update1: Update one rect opacity", 20, &mut e, &mut |e, i| {
      e.dispatch(Command::Update {
        ids: vec![rect.clone()],
        patch: json!({"opacity": 0.5 + (i as f64) / 100.0}),
      })
      .unwrap();
    });
  }
  if run("nudge") {
    time("nudge: Nudge all screens", 5, &mut e, &mut |e, _| {
      e.dispatch(Command::Nudge {
        ids: screen_ids.clone(),
        dx: 10.0,
        dy: 0.0,
      })
      .unwrap();
    });
  }
  if run("move1") {
    let target = screen_ids[3].clone();
    time("move1: MoveToParent one layer", 5, &mut e, &mut |e, i| {
      let id = nodes.iter().filter(|n| n.name == "Bell").nth(10 + i as usize).unwrap().id.clone();
      e.dispatch(Command::MoveToParent {
        ids: vec![id],
        parent: Some(target.clone()),
        index: None,
      })
      .unwrap();
    });
  }
  if run("mode1") {
    time("mode1: SetVariableMode one screen", 6, &mut e, &mut |e, i| {
      e.dispatch(Command::SetVariableMode {
        ids: vec![screen_ids[0].clone()],
        collection: theme.clone(),
        mode: if i % 2 == 0 { Some(dark.clone()) } else { None },
      })
      .unwrap();
    });
  }
  if run("upd1000") {
    let ids: Vec<String> = text_ids.iter().take(1000).cloned().collect();
    time("upd1000: Update x on 1000 texts", 3, &mut e, &mut |e, i| {
      e.dispatch(Command::Update {
        ids: ids.clone(),
        patch: json!({"x": 10 + i}),
      })
      .unwrap();
    });
    time("upd1000: undo of it", 3, &mut e, &mut |e, _| {
      e.dispatch(Command::Undo).unwrap();
    });
  }
  if run("delvar") {
    let mut cols = designotron_engine::variables::plain(&e.doc.variables);
    cols[0].variables.retain(|v| v.id != textv);
    time("delvar: SetVariables deleting Text (bound)", 1, &mut e, &mut |e, _| {
      e.dispatch(Command::SetVariables { collections: cols.clone() }).unwrap();
    });
    time("delvar: undo", 1, &mut e, &mut |e, _| {
      e.dispatch(Command::Undo).unwrap();
    });
  }
  if run("clip") {
    let ids: Vec<String> = screen_ids.iter().take(30).cloned().collect();
    let mut data = String::new();
    time("clip: copy 30 screens", 1, &mut e, &mut |e, _| {
      data = e.query(Query::Copy { ids: ids.clone() }).unwrap().as_str().unwrap().to_string();
    });
    println!("   clipboard {} KB", data.len() / 1024);
    time("clip: paste 30 screens", 1, &mut e, &mut |e, _| {
      e.dispatch(Command::Paste {
        data: data.clone(),
        parent: None,
        x: Some(-20000.0),
        y: Some(0.0),
      })
      .unwrap();
    });
    time("clip: undo paste", 1, &mut e, &mut |e, _| {
      e.dispatch(Command::Undo).unwrap();
    });
  }
  if run("clip2k") {
    let ids: Vec<String> = e.doc.nodes.keys().take(2000).cloned().collect();
    let mut data = String::new();
    time("clip2k: copy 2000 layers", 1, &mut e, &mut |e, _| {
      data = e.query(Query::Copy { ids: ids.clone() }).unwrap().as_str().unwrap().to_string();
    });
    println!("   clipboard {} KB", data.len() / 1024);
    time("clip2k: paste 2000 layers", 1, &mut e, &mut |e, _| {
      e.dispatch(Command::Paste {
        data: data.clone(),
        parent: None,
        x: Some(-20000.0),
        y: Some(-20000.0),
      })
      .unwrap();
    });
    time("clip2k: undo paste", 1, &mut e, &mut |e, _| {
      e.dispatch(Command::Undo).unwrap();
    });
    time("clip2k: move 2000 to frame", 1, &mut e, &mut |e, _| {
      let _ = e.dispatch(Command::MoveToParent {
        ids: ids.clone(),
        parent: Some(screen_ids[5].clone()),
        index: None,
      });
    });
  }
  if run("create10") {
    let mut k = 5000;
    time("create10: create_nodes 10 screens", 3, &mut e, &mut |e, _| {
      let specs: Vec<Value> = (k..k + 10).map(screen).collect();
      k += 10;
      ai(e, "create_nodes", json!({"nodes": specs}));
    });
  }
  if run("render") {
    let page = e.state()["page"].as_str().unwrap().to_string();
    let _ = e.render_incremental(&page, &[], None);
    let mut s = String::from("Good morning, Ada 0");
    time("render: SetText + render_incremental", 10, &mut e, &mut |e, _| {
      s.push('y');
      e.dispatch(Command::SetText {
        id: greet.clone(),
        characters: s.clone(),
        runs: None,
      })
      .unwrap();
      let _ = e.render_incremental(&page, &[], None);
    });
    time("render: SetText + doc_delta", 10, &mut e, &mut |e, _| {
      s.push('z');
      e.dispatch(Command::SetText {
        id: greet.clone(),
        characters: s.clone(),
        runs: None,
      })
      .unwrap();
    });
  }
}
