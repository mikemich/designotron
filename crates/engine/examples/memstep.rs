//! Memory retained per undo step on a large file (counting allocator):
//! `cargo run --release -p designotron-engine --example memstep [frames]`

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};

use designotron_engine::engine::{Command, Engine};
use designotron_engine::text::HeuristicMeasurer;
use serde_json::json;

struct Counting;
static NET: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Counting {
  unsafe fn alloc(&self, l: Layout) -> *mut u8 {
    NET.fetch_add(l.size() as isize, Ordering::Relaxed);
    System.alloc(l)
  }
  unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
    NET.fetch_sub(l.size() as isize, Ordering::Relaxed);
    System.dealloc(p, l)
  }
}

#[global_allocator]
static A: Counting = Counting;

fn mb() -> f64 {
  NET.load(Ordering::Relaxed) as f64 / 1048576.0
}

fn main() {
  let frames: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(40);
  let mut e = Engine::new(Box::new(HeuristicMeasurer), 1);
  for f in 0..frames {
    let cards: Vec<_> = (0..30)
      .map(|i| {
        json!({ "type": "frame", "name": format!("Card {i}"), "width": 300, "fill": "#FFFFFF",
          "layout": { "direction": "horizontal", "gap": 12, "padding": 12 },
          "children": [{ "type": "rectangle", "width": 48, "height": 48, "fill": "#DDD" },
            { "type": "text", "text": "Card title with some words", "fontSize": 16 },
            { "type": "text", "text": "Secondary", "fontSize": 13 }] })
      })
      .collect();
    e.dispatch(Command::Ai {
      tool: "create_nodes".into(),
      input: json!({ "nodes": [{ "type": "frame", "name": format!("S{f}"), "x": f as f64 * 500.0, "width": 393,
        "layout": { "direction": "vertical", "gap": 8, "padding": 16 }, "children": cards }] }),
    })
    .unwrap();
  }
  let ids: Vec<String> = e
    .doc
    .nodes
    .iter()
    .filter(|(_, n)| format!("{:?}", n.kind) == "Rectangle")
    .map(|(k, _)| k.clone())
    .take(300)
    .collect();
  println!("nodes {} base {:.1} MB", e.doc.nodes.len(), mb());
  let start = mb();
  for i in 0..300 {
    e.dispatch(Command::Ai {
      tool: "update_nodes".into(),
      input: json!({ "updates": [{ "id": ids[i % ids.len()], "opacity": 0.2 + (i % 8) as f64 / 10.0 }] }),
    })
    .unwrap();
    if (i + 1) % 100 == 0 {
      println!(
        "after {} edits: +{:.2} MB ({:.1} KB/step)",
        i + 1,
        mb() - start,
        (mb() - start) * 1024.0 / (i + 1) as f64
      );
    }
  }
  // One grouped turn of 50 edits: how much does a whole chat turn retain?
  let g = mb();
  e.dispatch(Command::SetHistoryGroup {
    group: Some("turn".into()),
  })
  .unwrap();
  for i in 0..50 {
    e.dispatch(Command::Ai {
      tool: "update_nodes".into(),
      input: json!({ "updates": [{ "id": ids[(i * 7) % ids.len()], "opacity": 0.9 }] }),
    })
    .unwrap();
  }
  e.dispatch(Command::SetHistoryGroup { group: None }).unwrap();
  println!("grouped turn of 50 edits: +{:.2} MB", mb() - g);

  // Deleting 40 top-level sections and undoing it (the engine side of "undo is slow").
  let roots: Vec<String> = e
    .doc
    .nodes
    .values()
    .filter(|n| n.parent.is_none())
    .map(|n| n.id.clone())
    .take(40)
    .collect();
  let t = std::time::Instant::now();
  e.dispatch(Command::Delete { ids: roots }).unwrap();
  let del = t.elapsed();
  let t = std::time::Instant::now();
  e.dispatch(Command::Undo).unwrap();
  let undo = t.elapsed();
  let t = std::time::Instant::now();
  e.dispatch(Command::Redo).unwrap();
  println!(
    "delete 40 sections {:.1} ms, undo {:.1} ms, redo {:.1} ms",
    del.as_secs_f64() * 1e3,
    undo.as_secs_f64() * 1e3,
    t.elapsed().as_secs_f64() * 1e3
  );
}
