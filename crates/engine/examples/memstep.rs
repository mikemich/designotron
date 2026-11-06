//! Memory retained per undo step on a large file (counting allocator):
//! `cargo run --release -p designotron-engine --example memstep [frames]`
//! `cargo run --release -p designotron-engine --example memstep t20k [layers]` builds a big file
//! (66 screens of 50 cards plus a 1000-rectangle frame) and prints net and peak memory per step.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};

use designotron_engine::engine::{Command, Engine};
use designotron_engine::persist::Persist;
use designotron_engine::text::HeuristicMeasurer;
use serde_json::json;

struct Counting;
static NET: AtomicIsize = AtomicIsize::new(0);
/// High-water mark of `NET` since the last `mark`.
static PEAK: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Counting {
  unsafe fn alloc(&self, l: Layout) -> *mut u8 {
    let n = NET.fetch_add(l.size() as isize, Ordering::Relaxed) + l.size() as isize;
    PEAK.fetch_max(n, Ordering::Relaxed);
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

/// Print net and peak (since the previous mark), then restart the peak at the current net.
fn mark(label: &str) {
  let net = NET.load(Ordering::Relaxed);
  println!(
    "{label:<36} net {:>7.1} MB  peak {:>7.1} MB",
    net as f64 / 1048576.0,
    PEAK.load(Ordering::Relaxed) as f64 / 1048576.0
  );
  PEAK.store(net, Ordering::Relaxed);
}

fn t20k(layers: usize) {
  let mut e = Engine::new(Box::new(HeuristicMeasurer), 1);
  let cards = 50;
  let screens = (layers - 1000) / (cards * 6 + 1);
  mark("start");
  for s in 0..screens {
    let kids: Vec<_> = (0..cards)
      .map(|i| {
        json!({ "type": "frame", "name": format!("Card {s}-{i}"), "width": 300, "fill": "#FFFFFF", "cornerRadius": 12,
          "layout": { "direction": "vertical", "gap": 8, "padding": 12 }, "children": [
          { "type": "rectangle", "name": "Image", "width": 276, "height": 120, "fill": "#CBD5E1", "cornerRadius": 8 },
          { "type": "text", "name": format!("Title {s}-{i}"), "text": format!("Item {s}-{i}"), "fontSize": 16, "fontWeight": 600, "color": "#0F172A" },
          { "type": "frame", "name": "Row", "layout": { "direction": "horizontal", "gap": 8, "crossAlign": "center" }, "children": [
            { "type": "text", "name": "Tag", "text": "Tag", "fontSize": 12, "color": "#475569" },
            { "type": "rectangle", "name": "Dot", "width": 24, "height": 24, "fill": "#38BDF8", "cornerRadius": 12 } ] } ] })
      })
      .collect();
    e.dispatch(Command::Ai {
      tool: "create_nodes".into(),
      input: json!({ "nodes": [{ "type": "frame", "name": format!("Screen {s}"), "x": (s % 8) * 2200, "y": (s / 8) * 13000,
        "width": 360, "fill": "#F1F5F9", "layout": { "direction": "vertical", "gap": 16, "padding": 16 }, "children": kids }] }),
    })
    .unwrap();
  }
  let kids: Vec<_> = (0..1000)
    .map(|i| json!({ "type": "rectangle", "name": format!("Dot {i}"), "x": (i % 40) * 40, "y": (i / 40) * 40, "width": 30, "height": 30, "fill": "#7C3AED", "cornerRadius": 6 }))
    .collect();
  e.dispatch(Command::Ai {
    tool: "create_nodes".into(),
    input: json!({ "nodes": [{ "type": "frame", "name": "Big", "x": -1800, "y": 0, "width": 1600, "height": 1000, "fill": "#FFFFFF", "children": kids }] }),
  })
  .unwrap();
  println!("nodes {}", e.doc.nodes.len());
  mark("built (with undo history)");
  // One property edit on a built file: what a single step retains.
  let id = e.doc.nodes.values().find(|n| n.name == "Dot 7").map(|n| n.id.clone()).unwrap();
  let base = NET.load(Ordering::Relaxed);
  for i in 0..20 {
    e.dispatch(Command::Ai {
      tool: "update_nodes".into(),
      input: json!({ "updates": [{ "id": id, "opacity": 0.1 + i as f64 / 40.0 }] }),
    })
    .unwrap();
  }
  println!(
    "single edit retains {:.1} KB/step (20 steps)",
    (NET.load(Ordering::Relaxed) - base) as f64 / 1024.0 / 20.0
  );
  // A step keeps two document clones (before, after); the page list (root ids) is copied by each.
  let n0 = NET.load(Ordering::Relaxed);
  let pages = std::hint::black_box(e.doc.pages.clone());
  println!(
    "  of which one page-list clone: {:.1} KB",
    (NET.load(Ordering::Relaxed) - n0) as f64 / 1024.0
  );
  drop(pages);
  PEAK.store(NET.load(Ordering::Relaxed), Ordering::Relaxed);
  let json = e.to_json();
  println!("doc json {:.1} MB", json.len() as f64 / 1048576.0);
  mark("to_json (json kept)");
  drop(e);
  mark("dropped builder");
  let mut e = Engine::new(Box::new(HeuristicMeasurer), 2);
  e.load(&json).unwrap();
  mark("load");
  drop(json);
  mark("drop input json");
  let d = e.doc_delta_json(true);
  println!("  docDelta full {:.1} MB", d.len() as f64 / 1048576.0);
  drop(d);
  mark("doc_delta_json(true)");
  let page = e.state()["page"].as_str().unwrap().to_string();
  let r = e.render_incremental(&page, &[], None);
  drop(r);
  mark("render_incremental (cache kept)");
  let mut p = Persist::default();
  let plan = p.plan(&e.doc, true);
  let mut total = 0;
  for r in &plan.dirty {
    total += p.chunk(plan.token, r).len();
  }
  println!("  persist chunks {:.1} MB", total as f64 / 1048576.0);
  mark("persist full plan + chunks");
  p.commit(plan.token);
  mark("persist commit");
}

fn main() {
  if std::env::args().nth(1).as_deref() == Some("t20k") {
    t20k(std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(20000));
    return;
  }
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
