//! Rough performance check on a large synthetic file:
//! `cargo run --release -p designotron-engine --example bench [frames] [cards per frame]`

use std::time::Instant;

use designotron_engine::engine::{Command, Engine};
use designotron_engine::text::HeuristicMeasurer;
use serde_json::json;

fn main() {
  let mut args = std::env::args().skip(1);
  let frames: usize = args.next().and_then(|a| a.parse().ok()).unwrap_or(40);
  let cards: usize = args.next().and_then(|a| a.parse().ok()).unwrap_or(30);
  let mut e = Engine::new(Box::new(HeuristicMeasurer), 1);

  let t = Instant::now();
  let comp = e
    .dispatch(Command::Ai {
      tool: "create_nodes".into(),
      input: json!({ "nodes": [{ "type": "frame", "name": "Card", "x": -400, "width": 300, "fill": "#FFFFFF", "cornerRadius": 12,
        "layout": { "direction": "horizontal", "gap": 12, "padding": 12 },
        "children": [{ "type": "rectangle", "width": 48, "height": 48, "fill": "#DDD" },
          { "type": "frame", "width": "fill", "layout": { "direction": "vertical", "gap": 4 }, "children": [
            { "type": "text", "text": "Card title", "fontSize": 16, "fontWeight": 600 },
            { "type": "text", "text": "Some secondary text that wraps", "fontSize": 13, "width": "fill" }] }] }] }),
    })
    .unwrap();
  let card = comp["created"][0]["id"].as_str().unwrap().to_string();
  let comp_id = e
    .dispatch(Command::Ai {
      tool: "arrange".into(),
      input: json!({ "action": "create_component", "ids": [card] }),
    })
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let mut first_frame = String::new();
  for f in 0..frames {
    let children: Vec<_> = (0..cards).map(|_| json!({ "type": "instance", "componentId": comp_id })).collect();
    let r = e
      .dispatch(Command::Ai {
        tool: "create_nodes".into(),
        input: json!({ "nodes": [{ "type": "frame", "name": format!("Screen {f}"), "x": f as f64 * 500.0, "width": 393,
          "layout": { "direction": "vertical", "gap": 8, "padding": 16 }, "children": children }] }),
      })
      .unwrap();
    if f == 0 {
      first_frame = r["created"][0]["id"].as_str().unwrap().to_string();
    }
  }
  println!("built {} nodes in {:?}", e.doc.nodes.len(), t.elapsed());

  let page = e.state()["page"].as_str().unwrap().to_string();
  let time = |label: &str, n: u32, f: &mut dyn FnMut()| {
    let t = Instant::now();
    for _ in 0..n {
      f();
    }
    println!("{label:<40} {:>8.2} ms", t.elapsed().as_secs_f64() * 1000.0 / n as f64);
  };
  let mut e2 = e;
  time("render page (full)", 5, &mut || {
    let _ = e2.render(&page, &[]);
  });
  time("render page (incremental, nothing changed)", 5, &mut || {
    let _ = e2.render_incremental(&page, &[]);
  });
  let ff = first_frame.clone();
  e2.dispatch(Command::BeginGesture).unwrap();
  let mut dx = 0.0;
  time("translate one frame inside a gesture", 20, &mut || {
    dx += 1.0;
    e2.dispatch(Command::Translate {
      ids: vec![ff.clone()],
      dx,
      dy: 0.0,
      snap: true,
      zoom: 1.0,
    })
    .unwrap();
  });
  time("  + incremental render after translate", 20, &mut || {
    dx += 1.0;
    e2.dispatch(Command::Translate {
      ids: vec![ff.clone()],
      dx,
      dy: 0.0,
      snap: true,
      zoom: 1.0,
    })
    .unwrap();
    let _ = e2.render_incremental(&page, &[]);
  });
  e2.dispatch(Command::EndGesture).unwrap();
  time("update one fill (undo step)", 10, &mut || {
    e2.dispatch(Command::Update {
      ids: vec![ff.clone()],
      patch: json!({ "opacity": 0.9 }),
    })
    .unwrap();
  });
  time("edit the main component (resyncs instances)", 3, &mut || {
    e2.dispatch(Command::Update {
      ids: vec![comp_id.clone()],
      patch: json!({ "cornerRadius": 14 }),
    })
    .unwrap();
  });
}
