//! Randomised multiplayer simulation: editors make random changes to pages, styles, variables
//! and layers (and undo/redo them) while a relay orders everything, some editors only speaking
//! the whole-list form. Everyone must end up with the relay's document, and every single change
//! must rebuild exactly from its per-id delta.

use std::collections::VecDeque;

use serde_json::{json, Value};

use crate::collab::{apply, delta, is_empty, legacy};
use crate::engine::{Command, Engine};
use crate::model::{Document, NodeType};
use crate::text::HeuristicMeasurer;
use crate::variables::{Collection, VarMode, Variable};

/// Seeds per run: a few seconds in total; raise it when hunting for a failure.
const SEEDS: u64 = 40;
const STEPS: usize = 150;

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
      name: "c".into(),
      modes: vec![mode("m1"), mode("m2")],
      variables: (0..200)
        .map(|i| Variable {
          id: format!("v{c}_{i}"),
          name: format!("var {i}"),
          values: [("m1".to_string(), json!("#123456")), ("m2".to_string(), json!("#654321"))]
            .into_iter()
            .collect(),
          ..Default::default()
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
  inbox: Vec<VecDeque<Value>>,
}

impl Sim {
  fn new(n: usize, old: &[usize], seed: u64) -> Sim {
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
      values: [("m1".to_string(), json!(1.0))].into_iter().collect(),
      ..Default::default()
    };
    first
      .dispatch(Command::SetVariables {
        collections: vec![Collection {
          id: "c0".into(),
          name: "c0".into(),
          modes: vec![mode("m1"), mode("m2")],
          variables: vec![variable],
        }],
      })
      .unwrap();
    let json = first.to_json();
    let granular: Vec<bool> = (0..n).map(|i| !old.contains(&i)).collect();
    let eds = (0..n)
      .map(|i| {
        let mut e = engine(seed.wrapping_mul(31) + 100 + 2 * i as u64);
        e.load(&json).unwrap();
        e.collab_reset(true, granular[i]);
        e
      })
      .collect();
    Sim {
      room: first.doc.clone(),
      eds,
      granular,
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
      assert_eq!(e.doc.pages, self.room.pages, "seed {seed} editor {i} pages");
      assert_eq!(e.doc.styles, self.room.styles, "seed {seed} editor {i} styles");
      assert_eq!(e.doc.variables, self.room.variables, "seed {seed} editor {i} variables");
      assert_eq!(e.doc.nodes, self.room.nodes, "seed {seed} editor {i} nodes");
    }
  }
}

fn run(seed: u64, n: usize, old: &[usize], steps: usize) {
  let mut r = Rng(seed * 2654435761 + 1);
  let mut sim = Sim::new(n, old, seed);
  for _ in 0..steps {
    match r.below(10) {
      0..=4 => {
        let i = r.below(n);
        local_op(&mut sim.eds[i], &mut r, false);
      }
      5..=6 => {
        let i = r.below(n);
        sim.flush(i);
      }
      _ => {
        let j = r.below(n);
        sim.deliver(j);
      }
    }
    assert!(!sim.room.pages.is_empty(), "seed {seed}: the room has no page");
  }
  sim.settle();
  sim.assert_converged(seed);
}

/// One random local change, checked to rebuild exactly from its own per-id delta.
/// With `solo`, no undo, redo or direct page reorder (which has no undo step): only changes
/// that undo and redo must reverse exactly.
fn local_op(e: &mut Engine, r: &mut Rng, solo: bool) {
  let before = e.doc.clone();
  let pages: Vec<String> = e.doc.pages.iter().map(|p| p.id.clone()).collect();
  let styles: Vec<String> = e.doc.styles.colors.iter().map(|s| s.id.clone()).collect();
  let page = |r: &mut Rng| pages[r.below(pages.len())].clone();
  let pick = r.below(16);
  let pick = if solo && matches!(pick, 4 | 11..=13) { 15 } else { pick };
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
      let cs = random_variables(e.doc.variables.clone(), r);
      let _ = e.dispatch(Command::SetVariables { collections: cs });
    }
    11 | 12 => {
      let _ = e.dispatch(Command::Undo);
    }
    13 => {
      let _ = e.dispatch(Command::Redo);
    }
    _ => rect(e, r.below(500) as f64),
  }
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

fn random_variables(mut cs: Vec<Collection>, r: &mut Rng) -> Vec<Collection> {
  let id = |r: &mut Rng| r.below(1_000_000);
  match r.below(7) {
    0 => cs.push(Collection {
      id: format!("c{}", id(r)),
      name: "n".into(),
      modes: vec![mode("m1")],
      variables: vec![Variable {
        id: format!("v{}", id(r)),
        name: "x".into(),
        ..Default::default()
      }],
    }),
    1 if !cs.is_empty() => {
      cs.remove(r.below(cs.len()));
    }
    2 if !cs.is_empty() => {
      let k = r.below(cs.len());
      cs[k].variables.push(Variable {
        id: format!("v{}", id(r)),
        name: "y".into(),
        values: [("m1".to_string(), json!(r.below(9)))].into_iter().collect(),
        ..Default::default()
      });
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
      if !cs[k].variables.is_empty() {
        let j = r.below(cs[k].variables.len());
        let m = if r.below(2) == 0 { "m1" } else { "m2" };
        if r.below(3) == 0 {
          cs[k].variables[j].values.remove(m);
        } else {
          cs[k].variables[j].values.insert(m.into(), json!(r.below(100)));
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
    _ => {}
  }
  cs
}
