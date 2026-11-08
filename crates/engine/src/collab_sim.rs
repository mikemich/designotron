//! Randomised multiplayer simulation: editors make random changes to pages, styles, variables,
//! layers (reorders, moves between frames, deletes, binding and styling), comments (replies,
//! resolving) and undo/redo them, while a relay orders everything, some editors only speaking
//! the whole-list form. Everyone must end up with the relay's document, and every single change
//! must rebuild exactly from its per-id delta (and, for `lists` editors, from its moves and
//! per-message comment changes).

use std::collections::VecDeque;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::collab::{apply, apply_opts, delta, delta_with, is_empty, legacy, legacy_lists, ApplyOpts, DeltaOpts};
use crate::engine::{Command, Engine};
use crate::model::{Document, NodeType};
use crate::ops::ReorderTo;
use crate::text::HeuristicMeasurer;
use crate::variables::{Collection, VarMode, Variable};

/// Seeds per run: a few seconds in total; raise it when hunting for a failure.
const SEEDS: u64 = 40;
const STEPS: usize = 150;

/// How an editor speaks to the relay (see `Sim`).
#[derive(Clone, Copy, PartialEq, Debug)]
enum Dialect {
  /// `lists`: moves and per-message comments; prunes dangling references itself.
  Lists,
  /// Per-id pages, styles and variables, whole child lists and comments.
  Granular,
  /// Whole lists everywhere.
  Whole,
}
use Dialect::{Granular, Lists, Whole};

/// 1,000 steps, 3 editors, 5 seeds, everyone on `lists` and a relay that speaks it.
#[test]
fn lists_editors_converge() {
  for seed in 1..=5 {
    run_with(seed, &[Lists, Lists, Lists], 1000, true);
  }
}

/// The same with one editor that never heard of `lists` (one seed per kind of older editor).
#[test]
fn lists_editors_and_an_older_one_converge() {
  run_with(11, &[Lists, Lists, Granular], 1000, true);
  run_with(12, &[Lists, Whole, Lists], 1000, true);
  run_with(13, &[Granular, Lists, Lists], 1000, true);
}

/// New editors against a relay from before `lists` (no moves, no pruning, raw forwarding).
#[test]
fn new_editors_on_an_old_relay_converge() {
  for seed in 1..=5 {
    run_with(seed, &[Granular, Granular, Granular], 600, false);
  }
  run_with(9, &[Granular, Whole, Granular], 600, false);
}

/// Wider and shorter: many seeds with a few steps each.
#[test]
fn lists_editors_converge_on_many_short_runs() {
  for seed in 20..20 + SEEDS {
    run_with(seed, &[Lists, Lists, Lists], 120, true);
  }
}

#[test]
fn granular_editors_converge() {
  for seed in 1..SEEDS {
    run(seed, 3, &[], STEPS);
  }
}

#[test]
fn mixed_old_and_new_editors_converge() {
  for seed in 1..SEEDS {
    run(seed, 3, &[1], STEPS);
  }
}

/// Undoing every change in turn brings back each earlier document exactly (list order
/// included), and redoing them all brings back each later one.
#[test]
fn solo_undo_and_redo_are_exact() {
  for seed in 1..SEEDS {
    let mut r = Rng(seed * 7919 + 3);
    let mut e = engine(seed | 4);
    e.dispatch(Command::AddPage { name: None }).unwrap();
    let json = e.to_json();
    e.load(&json).unwrap();
    let mut states = vec![e.doc.clone()];
    for _ in 0..40 {
      let before = e.doc.clone();
      local_op(&mut e, &mut r, true);
      if e.doc != before {
        states.push(e.doc.clone());
      }
    }
    let same = |a: &Document, b: &Document| a.pages == b.pages && a.styles == b.styles && a.variables == b.variables && a.nodes == b.nodes;
    for i in (1..states.len()).rev() {
      e.dispatch(Command::Undo).unwrap();
      assert!(same(&e.doc, &states[i - 1]), "seed {seed}: undo to state {}", i - 1);
    }
    for (i, want) in states.iter().enumerate().skip(1) {
      e.dispatch(Command::Redo).unwrap();
      assert!(same(&e.doc, want), "seed {seed}: redo to state {i}");
    }
  }
}

#[test]
fn concurrent_delete_of_different_pages_leaves_a_page() {
  let mut sim = Sim::new(2, &[], 7);
  let pages: Vec<String> = sim.room.pages.iter().map(|p| p.id.clone()).collect();
  assert_eq!(pages.len(), 2);
  sim.eds[0].dispatch(Command::DeletePage { id: pages[0].clone() }).unwrap();
  sim.eds[1].dispatch(Command::DeletePage { id: pages[1].clone() }).unwrap();
  sim.flush(0);
  sim.flush(1);
  sim.settle();
  assert_eq!(sim.room.pages.len(), 1, "the room keeps a page");
  sim.assert_converged(0);
  // A late joiner can load the room's file.
  engine(99).load(&serde_json::to_string(&sim.room).unwrap()).unwrap();
  // Three pages, deleted by two people at once.
  let mut sim = Sim::new(2, &[], 8);
  sim.eds[0].dispatch(Command::AddPage { name: None }).unwrap();
  sim.flush(0);
  sim.settle();
  let pages: Vec<String> = sim.room.pages.iter().map(|p| p.id.clone()).collect();
  assert_eq!(pages.len(), 3);
  sim.eds[0].dispatch(Command::DeletePage { id: pages[0].clone() }).unwrap();
  sim.eds[1].dispatch(Command::DeletePage { id: pages[1].clone() }).unwrap();
  sim.eds[1].dispatch(Command::DeletePage { id: pages[2].clone() }).unwrap();
  sim.settle();
  assert!(!sim.room.pages.is_empty());
  sim.assert_converged(0);
}

#[test]
fn redo_of_a_page_delete_cannot_leave_no_page() {
  let mut sim = Sim::new(2, &[], 9);
  let pages: Vec<String> = sim.room.pages.iter().map(|p| p.id.clone()).collect();
  sim.eds[0].dispatch(Command::DeletePage { id: pages[0].clone() }).unwrap();
  sim.eds[0].dispatch(Command::Undo).unwrap();
  sim.settle();
  sim.eds[1].dispatch(Command::DeletePage { id: pages[1].clone() }).unwrap();
  sim.settle();
  assert_eq!(sim.eds[0].doc.pages.len(), 1);
  sim.eds[0].dispatch(Command::Redo).unwrap();
  assert_eq!(sim.eds[0].doc.pages.len(), 1, "redo keeps the last page");
  sim.settle();
  sim.assert_converged(0);
}

/// Cost of one send when only a layer moved, with a big variables list: the per-id form must
/// stay near the whole-list one (~0.5 ms here; it was 10 ms before unchanged lists were skipped).
/// `cargo test -p designotron-engine --release -- --ignored --nocapture bench_granular`
#[test]
#[ignore]
fn bench_granular_delta_cost() {
  let mut e = engine(3);
  let collections = (0..5)
    .map(|c| Collection {
      id: format!("c{c}"),
      name: format!("c{c}"),
      modes: vec![mode("m1"), mode("m2")],
      variables: (0..200)
        .map(|i| {
          Arc::new(Variable {
            id: format!("v{c}_{i}"),
            name: format!("var {i}"),
            values: [("m1".to_string(), json!("#123456")), ("m2".to_string(), json!("#654321"))]
              .into_iter()
              .collect(),
            ..Default::default()
          })
        })
        .collect(),
    })
    .collect();
  e.dispatch(Command::SetVariables { collections }).unwrap();
  for i in 0..200 {
    e.dispatch(Command::AddColorStyle {
      name: format!("S{i}"),
      color: "#222222".into(),
    })
    .unwrap();
  }
  for i in 0..3000 {
    rect(&mut e, i as f64);
  }
  let base = e.doc.clone();
  let id = e.doc.pages[0].children[0].clone();
  e.doc.get_mut(&id).unwrap().x = 5.0;
  for granular in [false, true] {
    let t = std::time::Instant::now();
    for _ in 0..100 {
      std::hint::black_box(delta(&base, &e.doc, true, granular));
    }
    eprintln!("granular={granular}: {:.3} ms per delta", t.elapsed().as_secs_f64() * 10.0);
  }
}

fn engine(seed: u64) -> Engine {
  Engine::new(Box::new(HeuristicMeasurer), seed)
}

fn mode(id: &str) -> VarMode {
  VarMode {
    id: id.into(),
    name: id.into(),
  }
}

fn rect(e: &mut Engine, x: f64) {
  e.dispatch(Command::CreateShape {
    kind: NodeType::Rectangle,
    x,
    y: 0.0,
    width: 10.0,
    height: 10.0,
    parent: None,
  })
  .unwrap();
}

struct Rng(u64);

impl Rng {
  fn next(&mut self) -> u64 {
    let mut x = self.0;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    self.0 = x;
    x
  }

  fn below(&mut self, n: usize) -> usize {
    (self.next() % n.max(1) as u64) as usize
  }
}

/// What goes over the wire.
fn wire(v: &Value) -> Value {
  serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

/// A relay (its document and one queue of messages per editor) and its editors.
struct Sim {
  room: Document,
  eds: Vec<Engine>,
  granular: Vec<bool>,
  lists: Vec<bool>,
  /// The relay speaks `lists` (prunes, rewrites deltas for older editors); otherwise it is one
  /// from before: it applies as is and forwards as is (or in whole lists).
  new_relay: bool,
  inbox: Vec<VecDeque<Value>>,
}

impl Sim {
  fn new(n: usize, old: &[usize], seed: u64) -> Sim {
    let dialects: Vec<Dialect> = (0..n).map(|i| if old.contains(&i) { Whole } else { Granular }).collect();
    Sim::with(&dialects, seed, false)
  }

  fn with(dialects: &[Dialect], seed: u64, new_relay: bool) -> Sim {
    let n = dialects.len();
    let mut first = engine(seed | 2);
    first.dispatch(Command::AddPage { name: None }).unwrap();
    first
      .dispatch(Command::AddColorStyle {
        name: "A".into(),
        color: "#111111".into(),
      })
      .unwrap();
    let variable = Variable {
      id: "v0".into(),
      name: "v0".into(),
      kind: crate::variables::VarKind::Number,
      values: [("m1".to_string(), json!(1.0))].into_iter().collect(),
      ..Default::default()
    };
    first
      .dispatch(Command::SetVariables {
        collections: vec![Collection {
          id: "c0".into(),
          name: "c0".into(),
          modes: vec![mode("m1"), mode("m2")],
          variables: vec![Arc::new(variable)],
        }],
      })
      .unwrap();
    let json = first.to_json();
    let granular: Vec<bool> = dialects.iter().map(|d| *d != Whole).collect();
    let lists: Vec<bool> = dialects.iter().map(|d| *d == Lists && new_relay).collect();
    let eds = (0..n)
      .map(|i| {
        let mut e = engine(seed.wrapping_mul(31) + 100 + 2 * i as u64);
        e.load(&json).unwrap();
        e.collab_reset(true, granular[i], lists[i]);
        e
      })
      .collect();
    Sim {
      room: first.doc.clone(),
      eds,
      granular,
      lists,
      new_relay,
      inbox: vec![VecDeque::new(); n],
    }
  }

  /// Editor `i` flushes (as the web shell does) and the relay handles it at once.
  fn flush(&mut self, i: usize) {
    let d = self.eds[i].collab_delta();
    if d.get("full").is_some() || is_empty(&d) {
      return;
    }
    let d = wire(&d);
    if !self.new_relay {
      apply(&mut self.room, &d).expect("the relay takes every delta");
      for j in 0..self.eds.len() {
        if j == i {
          self.inbox[j].push_back(json!({ "ack": true }));
        } else if self.granular[j] {
          self.inbox[j].push_back(d.clone());
        } else {
          let older = legacy(&d, &self.room).map(|w| wire(&w)).unwrap_or_else(|| d.clone());
          self.inbox[j].push_back(older);
        }
      }
      return;
    }
    let pruned = apply_opts(&mut self.room, &d, ApplyOpts { prune: true }).expect("the relay takes every delta");
    let rewritten = legacy_lists(&d, &self.room, &pruned).map(|w| wire(&w));
    for j in 0..self.eds.len() {
      if j == i {
        self.inbox[j].push_back(json!({ "ack": true }));
        if !self.lists[i] && !pruned.is_empty() {
          // An editor that doesn't prune is told what the room pruned.
          let fix = legacy_lists(&json!({ "nodes": {} }), &self.room, &pruned).unwrap();
          self.inbox[j].push_back(wire(&fix));
        }
      } else if self.lists[j] {
        self.inbox[j].push_back(d.clone());
      } else {
        let g = rewritten.clone().unwrap_or_else(|| d.clone());
        let m = if self.granular[j] {
          g
        } else {
          legacy(&g, &self.room).map(|w| wire(&w)).unwrap_or(g)
        };
        self.inbox[j].push_back(m);
      }
    }
  }

  /// Editor `j` receives its oldest message (flushing its own changes first, as the shell does).
  fn deliver(&mut self, j: usize) {
    let Some(m) = self.inbox[j].pop_front() else { return };
    self.flush(j);
    if m.get("ack").is_some() {
      self.eds[j].dispatch(Command::CollabAck { rejected: false }).unwrap();
    } else {
      self.eds[j].dispatch(Command::ApplyRemote { delta: m, local: false }).unwrap();
    }
  }

  fn settle(&mut self) {
    for _ in 0..100 {
      for i in 0..self.eds.len() {
        self.flush(i);
      }
      let mut any = false;
      for j in 0..self.eds.len() {
        while !self.inbox[j].is_empty() {
          self.deliver(j);
          any = true;
        }
      }
      if !any {
        return;
      }
    }
    panic!("never settled");
  }

  fn assert_converged(&self, seed: u64) {
    for (i, e) in self.eds.iter().enumerate() {
      assert!(
        e.doc.pages == self.room.pages,
        "seed {seed} editor {i} pages differ: {}; {}",
        diff_pages(&e.doc, &self.room),
        last_steps()
      );
      assert_eq!(e.doc.styles, self.room.styles, "seed {seed} editor {i} styles");
      assert_eq!(e.doc.variables, self.room.variables, "seed {seed} editor {i} variables");
      assert!(
        e.doc.nodes == self.room.nodes,
        "seed {seed} editor {i} nodes: {}",
        diff_nodes(&e.doc, &self.room)
      );
      assert_eq!(e.doc.comments, self.room.comments, "seed {seed} editor {i} comments");
    }
  }
}

fn run(seed: u64, n: usize, old: &[usize], steps: usize) {
  let dialects: Vec<Dialect> = (0..n).map(|i| if old.contains(&i) { Whole } else { Granular }).collect();
  run_with(seed, &dialects, steps, false);
}

fn run_with(seed: u64, dialects: &[Dialect], steps: usize, new_relay: bool) {
  let n = dialects.len();
  let mut r = Rng(seed * 2654435761 + 1);
  let mut sim = Sim::with(dialects, seed, new_relay);
  for _ in 0..steps {
    match r.below(10) {
      0..=4 => {
        let i = r.below(n);
        trail(format!("ed{i} op"));
        local_op_in(&mut sim.eds[i], &mut r, false, new_relay);
      }
      5..=6 => {
        let i = r.below(n);
        trail(format!("flush ed{i}"));
        sim.flush(i);
      }
      _ => {
        let j = r.below(n);
        trail(format!("deliver ed{j}"));
        sim.deliver(j);
      }
    }
    assert!(!sim.room.pages.is_empty(), "seed {seed}: the room has no page");
  }
  sim.settle();
  sim.assert_converged(seed);
  if new_relay {
    // Nothing in the room (or any copy) refers to a token that is gone, and the tree is sound.
    let mut stale = sim.room.clone();
    assert!(
      crate::collab::prune_refs(&mut stale, crate::collab::Scope::All).is_empty(),
      "seed {seed}: dangling reference"
    );
    for n in sim.room.nodes.values() {
      for c in &n.children {
        assert_eq!(
          sim.room.get(c).and_then(|x| x.parent.clone()).as_deref(),
          Some(n.id.as_str()),
          "seed {seed}"
        );
      }
    }
  }
}

/// One random local change, checked to rebuild exactly from its own per-id delta.
/// With `solo`, no undo, redo or direct page reorder (which has no undo step): only changes
/// that undo and redo must reverse exactly.
fn local_op(e: &mut Engine, r: &mut Rng, solo: bool) {
  local_op_in(e, r, solo, true)
}

/// `rich`: also bind variables (a bound layer's colour is derived from the variable's value by
/// every editor, which a relay from before pruning and moves doesn't do for the room's copy).
fn local_op_in(e: &mut Engine, r: &mut Rng, solo: bool, rich: bool) {
  let solo_old = !rich;
  let before = e.doc.clone();
  let pages: Vec<String> = e.doc.pages.iter().map(|p| p.id.clone()).collect();
  let styles: Vec<String> = e.doc.styles.colors.iter().map(|s| s.id.clone()).collect();
  let page = |r: &mut Rng| pages[r.below(pages.len())].clone();
  let effects: Vec<String> = e.doc.styles.effects.iter().map(|s| s.id.clone()).collect();
  let grids: Vec<String> = e.doc.styles.grids.iter().map(|s| s.id.clone()).collect();
  let pick = r.below(46);
  trail(format!("pick {pick}"));
  let pick = if solo && matches!(pick, 4 | 11..=13) { 15 } else { pick };
  // (Adding or deleting a page while a peer adds layers to it, or while an editor that sends whole
  // page lists hasn't heard of it, leaves layers on a page that is gone: older than this and not
  // what the rich runs test. Concurrent page edits have their own tests.)
  let pick = if rich && matches!(pick, 0 | 2) { 15 } else { pick };
  // (A layer whose page a peer deleted meanwhile is left alone: nothing edits it any more.)
  let nodes: Vec<String> = e
    .doc
    .nodes
    .values()
    .filter(|n| e.doc.page(&n.page).is_some())
    .map(|n| n.id.clone())
    .collect();
  let node = |r: &mut Rng| (!nodes.is_empty()).then(|| nodes[r.below(nodes.len())].clone());
  let frames: Vec<String> = e
    .doc
    .nodes
    .values()
    .filter(|n| n.kind == NodeType::Frame)
    .map(|n| n.id.clone())
    .collect();
  let comments: Vec<String> = e.doc.comments.keys().cloned().collect();
  let colour_vars: Vec<String> = e
    .doc
    .variables
    .iter()
    .flat_map(|c| c.variables.iter())
    .filter(|v| v.kind == crate::variables::VarKind::Color)
    .map(|v| v.id.clone())
    .collect();
  match pick {
    0 => {
      let _ = e.dispatch(Command::AddPage { name: None });
    }
    1 => {
      let _ = e.dispatch(Command::RenamePage {
        id: page(r),
        name: format!("P{}", r.below(1000)),
      });
    }
    2 => {
      let _ = e.dispatch(Command::DeletePage { id: page(r) });
    }
    3 => {
      let _ = e.dispatch(Command::SetPageBackground {
        id: page(r),
        color: format!("#{:06X}", r.below(0xFFFFFF)),
      });
    }
    4 if pages.len() > 1 => {
      let (a, b) = (r.below(pages.len()), r.below(pages.len()));
      e.doc.pages.swap(a, b);
    }
    5 => {
      let _ = e.dispatch(Command::AddColorStyle {
        name: format!("S{}", r.below(1000)),
        color: "#222222".into(),
      });
    }
    6 if !styles.is_empty() => {
      let _ = e.dispatch(Command::UpdateColorStyle {
        id: styles[r.below(styles.len())].clone(),
        name: None,
        color: Some(format!("#{:06X}", r.below(0xFFFFFF))),
      });
    }
    7 if !styles.is_empty() => {
      let _ = e.dispatch(Command::DeleteStyle {
        id: styles[r.below(styles.len())].clone(),
      });
    }
    8..=10 => {
      let cs = random_variables(crate::variables::plain(&e.doc.variables), r);
      let _ = e.dispatch(Command::SetVariables { collections: cs });
    }
    11 | 12 => {
      let _ = e.dispatch(Command::Undo);
    }
    13 => {
      let _ = e.dispatch(Command::Redo);
    }
    16 | 17 => {
      // One undo step (a gesture) for the layer and the style made from it.
      e.dispatch(Command::BeginGesture).unwrap();
      // A layer with a random shadow, saved as an effect style (or a grid style).
      let id = e
        .dispatch(Command::CreateShape {
          kind: NodeType::Rectangle,
          x: 0.0,
          y: 0.0,
          width: 10.0,
          height: 10.0,
          parent: None,
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
      let (key, patch) = if pick == 16 {
        ("effects", json!([{ "type": "dropShadow", "blur": r.below(30), "y": r.below(9) }]))
      } else {
        ("layoutGrids", json!([{ "pattern": "columns", "count": r.below(12) + 1 }]))
      };
      e.dispatch(Command::Update {
        ids: vec![id.clone()],
        patch: json!({ key: patch }),
      })
      .unwrap();
      let name = format!("Fx/{}", r.below(1000));
      let _ = e.dispatch(if pick == 16 {
        Command::AddEffectStyle {
          name,
          from: id,
          description: String::new(),
        }
      } else {
        Command::AddGridStyle {
          name,
          from: id,
          description: String::new(),
        }
      });
      e.dispatch(Command::EndGesture).unwrap();
    }
    18 if !effects.is_empty() => {
      let _ = e.dispatch(Command::UpdateEffectStyle {
        id: effects[r.below(effects.len())].clone(),
        name: (r.below(2) == 0).then(|| format!("E{}", r.below(1000))),
        effects: (r.below(2) == 0).then(|| {
          vec![crate::model::Effect {
            blur: r.below(40) as f64,
            ..Default::default()
          }]
        }),
        description: (r.below(3) == 0).then(|| format!("d{}", r.below(9))),
      });
    }
    19 if !grids.is_empty() => {
      let _ = e.dispatch(Command::UpdateGridStyle {
        id: grids[r.below(grids.len())].clone(),
        name: (r.below(2) == 0).then(|| format!("G{}", r.below(1000))),
        grids: (r.below(2) == 0).then(|| {
          vec![crate::model::LayoutGrid {
            count: r.below(12) as u32 + 1,
            ..Default::default()
          }]
        }),
        description: None,
      });
    }
    20 if !effects.is_empty() || !grids.is_empty() => {
      let all: Vec<&String> = effects.iter().chain(grids.iter()).collect();
      let _ = e.dispatch(Command::DeleteStyle {
        id: all[r.below(all.len())].clone(),
      });
    }
    24..=27 => {
      if let Some(id) = node(r) {
        let to = [ReorderTo::Front, ReorderTo::Back, ReorderTo::Forward, ReorderTo::Backward][r.below(4)];
        let _ = e.dispatch(Command::Reorder { ids: vec![id], to });
      }
    }
    28 => {
      // Two layers at once (they only reorder when they share a parent).
      if let (Some(a), Some(b)) = (node(r), node(r)) {
        let to = if r.below(2) == 0 { ReorderTo::Front } else { ReorderTo::Back };
        let _ = e.dispatch(Command::Reorder { ids: vec![a, b], to });
      }
    }
    29 | 30 => {
      if let Some(id) = node(r) {
        let parent = (!frames.is_empty() && r.below(4) != 0).then(|| frames[r.below(frames.len())].clone());
        let _ = e.dispatch(Command::MoveToParent {
          ids: vec![id],
          parent,
          index: (r.below(3) != 0).then(|| r.below(5)),
        });
      }
    }
    31 | 32 => {
      let parent = (!frames.is_empty() && r.below(4) != 0).then(|| frames[r.below(frames.len())].clone());
      let _ = e.dispatch(Command::CreateShape {
        kind: if r.below(3) == 0 { NodeType::Frame } else { NodeType::Rectangle },
        x: r.below(300) as f64,
        y: 0.0,
        width: 30.0,
        height: 30.0,
        parent,
      });
    }
    33 => {
      let _ = e.dispatch(Command::AddComment {
        page: None,
        x: 3.0,
        y: 4.0,
        node: node(r),
        text: format!("q{}", r.below(1000)),
        author: format!("u{}", r.below(3)),
        time: r.below(100) as f64,
      });
    }
    34..=36 if !comments.is_empty() => {
      let _ = e.dispatch(Command::ReplyComment {
        id: comments[r.below(comments.len())].clone(),
        text: format!("r{}", r.below(1000)),
        author: format!("u{}", r.below(3)),
        time: r.below(100) as f64,
      });
    }
    37 if !comments.is_empty() => {
      let id = comments[r.below(comments.len())].clone();
      let resolved = !e.doc.comments[&id].resolved;
      let _ = e.dispatch(Command::ResolveComment { id, resolved });
    }
    38 if !comments.is_empty() && r.below(3) == 0 => {
      let _ = e.dispatch(Command::DeleteComment {
        id: comments[r.below(comments.len())].clone(),
      });
    }
    39 if r.below(2) == 0 => {
      if let Some(id) = node(r) {
        let _ = e.dispatch(Command::Delete { ids: vec![id] });
      }
    }
    40 => {
      let mut cs = crate::variables::plain(&e.doc.variables);
      let k = r.below(1_000_000);
      cs.push(Collection {
        id: format!("cc{k}"),
        name: format!("colours {k}"),
        modes: vec![mode("m1"), mode("m2")],
        variables: vec![Arc::new(Variable {
          id: format!("cv{k}"),
          name: format!("ink {k}"),
          kind: crate::variables::VarKind::Color,
          values: [("m1".to_string(), json!("#112233")), ("m2".to_string(), json!("#445566"))]
            .into_iter()
            .collect(),
          ..Default::default()
        })],
      });
      let _ = e.dispatch(Command::SetVariables { collections: cs });
    }
    41 | 42 if !colour_vars.is_empty() && !solo_old => {
      // (Layers that get bound and layers that get a style are different ones: a bound layer's
      // colour is derived from the variable by every editor, and a style written at the same
      // moment would make the editors' copies differ from the room's, which never derives.)
      if let Some(id) = node(r).filter(|id| id.len() % 2 == 0) {
        let _ = e.dispatch(Command::BindVariable {
          ids: vec![id],
          property: "fill".into(),
          variable: Some(colour_vars[r.below(colour_vars.len())].clone()),
        });
      }
    }
    43 | 44 if !styles.is_empty() => {
      if let Some(id) = node(r).filter(|id| id.len() % 2 == 1 || solo_old) {
        let _ = e.dispatch(Command::ApplyStyle {
          ids: vec![id],
          style_id: styles[r.below(styles.len())].clone(),
          kind: None,
        });
      }
    }
    _ => rect(e, r.below(500) as f64),
  }
  // (Runs with page deletes can start from a tree that is not sound; see the note on `pick == 2`.
  // `apply` repairs such a tree, the editor's own copy was not repaired: nothing to compare then.)
  let sound_before = unsound(&before).is_none();
  if let (Some(p), true, true) = (unsound(&e.doc), sound_before, rich) {
    panic!("op {pick} left the tree unsound: {p}; {}", last_steps());
  }
  let lists = wire(&delta_with(
    &before,
    &e.doc,
    DeltaOpts {
      patches: true,
      granular: true,
      lists: true,
      text: false,
    },
  ));
  let mut by_moves = before.clone();
  apply(&mut by_moves, &lists).unwrap();
  // (A layer a peer added to a page another deleted keeps pointing at it until something touches
  // it, and `repair` then re-homes it: that is older than this and not compared.)
  let orphans: Vec<String> = e
    .doc
    .nodes
    .values()
    .filter(|n| before.page(&n.page).is_none() && e.doc.page(&n.page).is_none())
    .map(|n| n.id.clone())
    .collect();
  for id in &orphans {
    if let Some(m) = by_moves.get_mut(id) {
      m.page = e.doc.get(id).unwrap().page.clone();
    }
    for p in by_moves.pages_iter_mut() {
      p.children.retain(|c| c != id);
    }
  }
  if sound_before {
    assert!(
      by_moves.nodes == e.doc.nodes,
      "nodes are not exact from moves (op {pick}): {} delta {}",
      diff_nodes(&by_moves, &e.doc),
      lists.to_string().chars().take(600).collect::<String>()
    );
    assert_eq!(by_moves.pages, e.doc.pages, "pages are not exact from moves");
    assert_eq!(by_moves.comments, e.doc.comments, "comments are not exact from per-message changes");
  }
  assert_eq!(is_empty(&lists), before == e.doc, "is_empty is wrong for lists");
  let d = wire(&delta(&before, &e.doc, true, true));
  let mut exact = before.clone();
  apply(&mut exact, &d).unwrap();
  let mut whole = before.clone();
  apply(&mut whole, &wire(&delta(&before, &e.doc, true, false))).unwrap();
  assert_eq!(exact.pages, whole.pages, "pages differ from the whole-list form");
  assert_eq!(exact.styles, e.doc.styles, "styles are not exact");
  assert_eq!(exact.variables, e.doc.variables, "variables are not exact");
  assert_eq!(exact.nodes, whole.nodes, "nodes differ from the whole-list form");
  assert_eq!(is_empty(&d), before == e.doc, "is_empty is wrong");
}

thread_local! {
  /// What the simulation did lately (editor and step), for failure messages.
  static TRAIL: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn trail(s: String) {
  TRAIL.with(|t| {
    let mut t = t.borrow_mut();
    t.push(s);
    if t.len() > 40 {
      t.remove(0);
    }
  });
}

fn last_steps() -> String {
  TRAIL.with(|t| t.borrow().join(" | "))
}

/// A problem in the tree of `d` (a layer its parent or page doesn't list, a child that points
/// elsewhere, one on a page that is gone), if any.
fn unsound(d: &Document) -> Option<String> {
  for n in d.nodes.values() {
    for c in &n.children {
      if d.get(c).and_then(|x| x.parent.clone()).as_deref() != Some(n.id.as_str()) {
        return Some(format!("child {c} of {} doesn't point back", n.id));
      }
    }
    if d.page(&n.page).is_none() {
      // A layer on a page that is gone (a peer deleted the page while another added to it) is
      // the older orphan problem: such a tree is not sound, and nothing is compared from it.
      return Some(format!("{} is on a page that is gone", n.id));
    }
    match &n.parent {
      Some(p) => {
        if !d.get(p).is_some_and(|p| p.children.contains(&n.id)) {
          return Some(format!("{} is not listed by its parent {p}", n.id));
        }
      }
      None => {
        if !d.page(&n.page).unwrap().children.contains(&n.id) {
          return Some(format!("{} is not listed by its page", n.id));
        }
      }
    }
  }
  None
}

/// The first difference between two documents' pages, short enough to read.
fn diff_pages(a: &Document, b: &Document) -> String {
  for p in a.pages.iter() {
    match b.page(&p.id) {
      None => return format!("page {} missing on the right", p.id),
      Some(q) if q.children != p.children => {
        let only_l: Vec<_> = p.children.iter().filter(|c| !q.children.contains(c)).collect();
        let only_r: Vec<_> = q.children.iter().filter(|c| !p.children.contains(c)).collect();
        let node = |d: &Document, id: &String| {
          d.get(id)
            .map(|n| format!("{} parent {:?} page {}", n.id, n.parent, n.page))
            .unwrap_or("gone".into())
        };
        return format!(
          "page {}: only left {:?} ({}), only right {:?} ({}); same ids: {}",
          p.id,
          only_l,
          only_l
            .first()
            .map(|c| format!("left: {}; right: {}", node(a, c), node(b, c)))
            .unwrap_or_default(),
          only_r,
          only_r.first().map(|c| node(b, c)).unwrap_or_default(),
          only_l.is_empty() && only_r.is_empty()
        );
      }
      Some(q) if *q != **p => return format!("page {} other fields", p.id),
      _ => {}
    }
  }
  "page lists differ".into()
}

/// The first difference between two documents' layers, short enough to read.
fn diff_nodes(a: &Document, b: &Document) -> String {
  for (id, n) in a.nodes.iter() {
    let m = b.nodes.get(id);
    if m.is_none_or(|m| m != n) {
      let (x, y) = (
        serde_json::to_value(n).unwrap(),
        m.map(|m| serde_json::to_value(m).unwrap()).unwrap_or(Value::Null),
      );
      let keys: Vec<String> = x
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, v)| y.get(k.as_str()) != Some(*v))
        .map(|(k, v)| format!("{k}: {v} vs {}", y.get(k.as_str()).cloned().unwrap_or(Value::Null)))
        .collect();
      return format!("node {id}: {}", keys.join("; "));
    }
  }
  if let Some(id) = b.nodes.keys().find(|k| !a.nodes.contains_key(*k)) {
    return format!("node {id} missing on the left");
  }
  "none".into()
}

fn random_variables(mut cs: Vec<Collection>, r: &mut Rng) -> Vec<Collection> {
  let id = |r: &mut Rng| r.below(1_000_000);
  match r.below(9) {
    8 if !cs.is_empty() => {
      // A mode goes away (layers pinned to it lose the pin everywhere).
      let k = r.below(cs.len());
      cs[k].modes.retain(|m| m.id != "m2");
    }
    0 => cs.push(Collection {
      id: format!("c{}", id(r)),
      name: "n".into(),
      modes: vec![mode("m1")],
      variables: vec![Arc::new(Variable {
        id: format!("v{}", id(r)),
        name: "x".into(),
        kind: crate::variables::VarKind::Number,
        ..Default::default()
      })],
    }),
    1 if !cs.is_empty() => {
      cs.remove(r.below(cs.len()));
    }
    2 if !cs.is_empty() => {
      let k = r.below(cs.len());
      let vid = format!("v{}", id(r));
      cs[k].variables.push(Arc::new(Variable {
        name: format!("y {vid}"),
        id: vid,
        kind: crate::variables::VarKind::Number,
        values: [("m1".to_string(), json!(r.below(9)))].into_iter().collect(),
        ..Default::default()
      }));
    }
    3 if !cs.is_empty() => {
      let k = r.below(cs.len());
      if !cs[k].variables.is_empty() {
        let j = r.below(cs[k].variables.len());
        cs[k].variables.remove(j);
      }
    }
    4 if !cs.is_empty() => {
      let k = r.below(cs.len());
      // (The colour variables layers get bound to keep their values: a bound layer shows them.)
      if !cs[k].variables.is_empty() && !cs[k].id.starts_with("cc") {
        let j = r.below(cs[k].variables.len());
        let m = if r.below(2) == 0 { "m1" } else { "m2" };
        if r.below(3) == 0 {
          Arc::make_mut(&mut cs[k].variables[j]).values.remove(m);
        } else {
          Arc::make_mut(&mut cs[k].variables[j]).values.insert(m.into(), json!(r.below(100)));
        }
      }
    }
    5 if !cs.is_empty() => {
      let k = r.below(cs.len());
      let n = cs[k].variables.len();
      if n > 1 {
        cs[k].variables.swap(0, n - 1);
      }
      if r.below(2) == 0 && cs.len() > 1 {
        let n = cs.len();
        cs.swap(0, n - 1);
      }
    }
    6 if !cs.is_empty() => {
      let k = r.below(cs.len());
      cs[k].name = format!("N{}", r.below(100));
    }
    7 if !cs.is_empty() => {
      let k = r.below(cs.len());
      if !cs[k].variables.is_empty() && !cs[k].id.starts_with("cc") {
        let j = r.below(cs[k].variables.len());
        let all = crate::variables::SCOPES;
        Arc::make_mut(&mut cs[k].variables[j]).scopes = if r.below(3) == 0 {
          vec![]
        } else {
          vec![all[r.below(all.len())].to_string()]
        };
      }
    }
    _ => {}
  }
  cs
}
