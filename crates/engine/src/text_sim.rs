//! Randomised simulation of text merging: editors type, delete, replace, style, undo and revert in
//! the same text layers while a relay orders everything (applying deltas through `collab::apply_opts`
//! as the rooms do, and rewriting them with `legacy_text` for editors that predate `text`). Editors
//! also drop off for a while and rejoin the way `collab.ts` does. Everyone must end up with the
//! relay's document, every stored sequence must describe its characters, and (when nothing is
//! deleted, undone or replaced) each person's typing must be in the final text in the order it was
//! typed, in one piece per burst.
//!
//! A failing seed prints itself and the last steps. Re-run a range with
//! `TEXT_SIM_FROM=100 TEXT_SIM_SEEDS=200 cargo test --release -p designotron-engine -- --ignored text_sim_many_seeds`.

use std::cell::RefCell;
use std::collections::VecDeque;

use serde_json::{json, Value};

use crate::collab::{apply_opts, is_empty, legacy_text, ApplyOpts};
use crate::engine::{Command, Engine, Query, TextState};
use crate::model::{Document, NodeId};
use crate::text::HeuristicMeasurer;
use crate::textseq;

/// Steps of a long run and of the many short ones.
const STEPS: usize = 1000;
const SHORT_STEPS: usize = 120;
const TEXTS: [&str; 3] = [
  "The quick brown fox jumps over the lazy dog.",
  "Hello world",
  "Line one\nLine two\nLine three",
];

/// How an editor speaks to the relay.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Dialect {
  /// Joined with `text`: per-character changes.
  Text,
  /// Joined with `lists` only: whole texts, last write wins.
  Lists,
}
use Dialect::{Lists, Text};

/// What the random operations may do.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
  /// Typing (and styles and props) only, at positions next to the original characters: the intent
  /// property holds.
  Intent,
  /// Everything: deletes, replaces, whole-text rewrites, undo, revert.
  Anything,
}
use Mode::{Anything, Intent};

thread_local! {
  static TRAIL: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
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

/// 1,000 steps, three text editors, five seeds.
#[test]
fn text_editors_converge() {
  for seed in 1..=5 {
    run(seed, &[Text, Text, Text], STEPS, Anything, true);
  }
}

/// With an editor that sends whole texts (joined without `text`).
#[test]
fn text_editors_and_an_older_one_converge() {
  for seed in 1..=3 {
    run(seed, &[Text, Text, Lists], STEPS, Anything, true);
  }
  run(4, &[Lists, Text, Text], STEPS, Anything, true);
}

/// Many short runs.
#[test]
fn text_editors_converge_on_many_short_runs() {
  for seed in 100..140 {
    let dialects: &[Dialect] = if seed % 4 == 0 { &[Text, Lists, Text] } else { &[Text, Text, Text] };
    run(seed, dialects, SHORT_STEPS, Anything, seed % 3 == 0);
  }
}

/// Typing only: everyone's letters are in the final text in the order typed, one piece per burst.
#[test]
fn typing_keeps_every_burst_whole() {
  for seed in 200..212 {
    run(seed, &[Text, Text, Text], 400, Intent, seed % 2 == 0);
  }
}

/// Five thousand edits on one text keep its merge data small.
#[test]
fn five_thousand_edits_keep_the_sequence_small() {
  let mut sim = Sim::new(77, &[Text, Text]);
  let mut r = Rng(0x9e37_79b9_7f4a_7c15);
  let mut st = [EdState::default(), EdState::default()];
  let id = sim.texts[0].clone();
  let mut max_json = 0;
  for step in 0..5000 {
    let i = r.below(2);
    let len = char_count(&sim.eds[i], &id);
    let at = r.below(len + 1);
    // Mostly typing and short deletes, keeping the text a few hundred characters long.
    let (del, ins) = if len > 300 || (len > 20 && r.below(3) == 0) {
      (r.below(4).min(len - at), String::new())
    } else {
      (r.below(2).min(len - at), letters(&mut r, 1, 3))
    };
    let _ = sim.eds[i].dispatch(Command::EditText {
      id: id.clone(),
      start: at,
      end: at + del,
      text: ins,
    });
    let _ = &mut st[i];
    if step % 3 == 0 {
      sim.flush(i);
    }
    // (Keeping up: a backlog of unacknowledged changes would only slow the test down.)
    sim.deliver(0);
    sim.deliver(1);
    if step % 50 == 0 {
      let t = sim.room.get(&id).unwrap().text.as_ref().unwrap();
      let json = serde_json::to_string(&t.seq).unwrap().len();
      max_json = max_json.max(json);
    }
  }
  sim.settle();
  sim.assert_converged(77);
  let t = sim.room.get(&id).unwrap().text.as_ref().unwrap();
  let seq = textseq::effective(t);
  let tombs = seq.s.iter().filter(|s| s.del.is_some()).count();
  let json = serde_json::to_string(&t.seq).unwrap().len();
  eprintln!(
    "5000 edits: {} characters, {} spans ({} deleted stretches), seq json {} bytes (largest seen {})",
    t.characters.chars().count(),
    seq.s.len(),
    tombs,
    json,
    max_json
  );
  assert!(tombs <= textseq::MAX_TOMBSTONE_SPANS, "{tombs} deleted stretches");
  assert!(json < 16 * 1024 && max_json < 16 * 1024, "seq json {json} bytes");
}

/// The seeds in `TEXT_SIM_FROM..TEXT_SIM_FROM + TEXT_SIM_SEEDS` (default 1000..1200), on shorter and
/// longer runs, with and without an older editor and offline spells.
/// `cargo test --release -p designotron-engine -- --ignored text_sim_many_seeds`
#[test]
#[ignore]
fn text_sim_many_seeds() {
  let env = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
  let (from, n) = (env("TEXT_SIM_FROM", 1000), env("TEXT_SIM_SEEDS", 200));
  for seed in from..from + n {
    let dialects: &[Dialect] = match seed % 5 {
      0 => &[Text, Lists, Text],
      1 => &[Text, Text],
      _ => &[Text, Text, Text],
    };
    let steps = if seed % 7 == 0 { 600 } else { 200 };
    run(seed, dialects, steps, Anything, seed % 2 == 0);
    if seed % 4 == 0 {
      run(seed, &[Text, Text, Text], 200, Intent, true);
    }
  }
  eprintln!("text_sim_many_seeds: seeds {from}..{} passed", from + n);
}

// ---------- Scenarios ----------

/// The layer "Hello world" of a room, and its id.
fn hello(dialects: &[Dialect]) -> (Sim, NodeId) {
  let sim = Sim::new(5, dialects);
  let id = sim.texts[1].clone();
  (sim, id)
}

fn edit(e: &mut Engine, id: &str, start: usize, end: usize, text: &str) {
  e.dispatch(Command::EditText {
    id: id.into(),
    start,
    end,
    text: text.into(),
  })
  .unwrap();
}

fn all_say(sim: &Sim, id: &str, want: &str) {
  assert_eq!(text_of_doc(&sim.room, id), want, "the room");
  for (i, e) in sim.eds.iter().enumerate() {
    assert_eq!(text_of(e, id), want, "editor {i}");
  }
}

#[test]
fn concurrent_typing_at_the_start_and_the_end_lands_everywhere() {
  let (mut sim, id) = hello(&[Text, Text, Text]);
  edit(&mut sim.eds[0], &id, 11, 11, " AAA");
  edit(&mut sim.eds[1], &id, 0, 0, "BBB ");
  sim.flush(0);
  sim.flush(1);
  sim.settle();
  sim.assert_converged(0);
  all_say(&sim, &id, "BBB Hello world AAA");
}

#[test]
fn typing_at_the_same_spot_keeps_both_runs_whole_the_later_one_first() {
  let (mut sim, id) = hello(&[Text, Text, Text]);
  edit(&mut sim.eds[0], &id, 5, 5, "AAA");
  edit(&mut sim.eds[1], &id, 5, 5, "BBB");
  sim.flush(0);
  sim.flush(1);
  sim.settle();
  sim.assert_converged(0);
  all_say(&sim, &id, "HelloBBBAAA world");
}

#[test]
fn characters_typed_inside_a_deleted_word_survive() {
  let (mut sim, id) = hello(&[Text, Text, Text]);
  edit(&mut sim.eds[0], &id, 6, 11, "");
  edit(&mut sim.eds[1], &id, 8, 8, "XY");
  sim.flush(1);
  sim.flush(0);
  sim.settle();
  sim.assert_converged(0);
  all_say(&sim, &id, "Hello XY");
}

#[test]
fn a_style_covers_what_reached_the_relay_before_it() {
  let bold = |sim: &mut Sim, id: &str| {
    sim.eds[1]
      .dispatch(Command::StyleText {
        id: id.into(),
        start: 0,
        end: 5,
        style: json!({ "fontWeight": 700 }),
        clear: vec![],
      })
      .unwrap()
  };
  // Typed inside "Hello" first, then the style: the typed letter is bold.
  let (mut sim, id) = hello(&[Text, Text, Text]);
  edit(&mut sim.eds[0], &id, 2, 2, "Z");
  bold(&mut sim, &id);
  sim.flush(0);
  sim.flush(1);
  sim.settle();
  sim.assert_converged(0);
  let t = sim.room.get(&id).unwrap().text.as_ref().unwrap();
  assert_eq!(t.characters, "HeZllo world");
  assert_eq!((t.runs.len(), t.runs[0].start, t.runs[0].end), (1, 0, 6), "{:?}", t.runs);
  // The other way round, the letter keeps the style it was typed with.
  let (mut sim, id) = hello(&[Text, Text, Text]);
  edit(&mut sim.eds[0], &id, 2, 2, "Z");
  bold(&mut sim, &id);
  sim.flush(1);
  sim.flush(0);
  sim.settle();
  sim.assert_converged(0);
  let t = sim.room.get(&id).unwrap().text.as_ref().unwrap();
  assert_eq!(t.characters, "HeZllo world");
  assert_eq!(t.runs.len(), 2, "{:?}", t.runs);
}

#[test]
fn undo_takes_back_only_my_characters() {
  let (mut sim, id) = hello(&[Text, Text, Text]);
  edit(&mut sim.eds[0], &id, 11, 11, " AAA");
  sim.settle();
  edit(&mut sim.eds[1], &id, 5, 5, "XY");
  sim.settle();
  all_say(&sim, &id, "HelloXY world AAA");
  sim.eds[0].dispatch(Command::Undo).unwrap();
  sim.settle();
  all_say(&sim, &id, "HelloXY world");
  sim.eds[0].dispatch(Command::Redo).unwrap();
  sim.settle();
  all_say(&sim, &id, "HelloXY world AAA");
  sim.assert_converged(0);
}

#[test]
fn undoing_an_editing_session_keeps_what_others_typed_meanwhile() {
  let (mut sim, id) = hello(&[Text, Text, Text]);
  let e = &mut sim.eds[0];
  e.dispatch(Command::BeginGesture).unwrap();
  edit(e, &id, 0, 0, "One ");
  edit(e, &id, 15, 15, " two");
  edit(e, &id, 6, 6, "!");
  e.dispatch(Command::EndGesture).unwrap();
  sim.settle();
  edit(&mut sim.eds[1], &id, 8, 8, "<b>");
  sim.settle();
  sim.eds[0].dispatch(Command::Undo).unwrap();
  sim.settle();
  sim.assert_converged(0);
  all_say(&sim, &id, "Hel<b>lo world");
}

#[test]
fn revert_text_is_exact_merged_or_an_error() {
  let (mut sim, id) = hello(&[Text, Text]);
  let before = state(&sim.eds[0], &id).unwrap();
  edit(&mut sim.eds[0], &id, 11, 11, "!!");
  let after = state(&sim.eds[0], &id).unwrap();
  // Exact: the text is still what the step left.
  let r = sim.eds[0]
    .dispatch(Command::RevertText {
      id: id.clone(),
      from: after.clone(),
      to: before.clone(),
    })
    .unwrap();
  assert_eq!((r["start"].as_u64(), r["end"].as_u64()), (Some(11), Some(11)));
  assert_eq!(text_of(&sim.eds[0], &id), "Hello world");
  // Redo it, let someone else type, then undo again: merged.
  sim.eds[0]
    .dispatch(Command::RevertText {
      id: id.clone(),
      from: before.clone(),
      to: after.clone(),
    })
    .unwrap();
  sim.settle();
  edit(&mut sim.eds[1], &id, 0, 0, ">> ");
  sim.settle();
  let r = sim.eds[0]
    .dispatch(Command::RevertText {
      id: id.clone(),
      from: after.clone(),
      to: before.clone(),
    })
    .unwrap();
  assert_eq!(text_of(&sim.eds[0], &id), ">> Hello world");
  assert_eq!(r["start"].as_u64(), Some(14), "{r}");
  sim.settle();
  sim.assert_converged(0);
  // A text with another history can't be reverted this way.
  let other = TextState {
    characters: "unrelated".into(),
    ..Default::default()
  };
  let err = sim.eds[0]
    .dispatch(Command::RevertText {
      id: id.clone(),
      from: other.clone(),
      to: other,
    })
    .unwrap_err();
  assert_eq!(err, "the text changed");
  assert_eq!(text_of(&sim.eds[0], &id), ">> Hello world");
}

#[test]
fn claude_replacing_a_text_merges_as_the_smallest_edit() {
  let (mut sim, id) = hello(&[Text, Text]);
  sim.eds[0]
    .dispatch(Command::Ai {
      tool: "update_nodes".into(),
      input: json!({ "updates": [{ "id": id, "text": "Howdy world" }] }),
    })
    .unwrap();
  let d = sim.eds[0].collab_delta();
  let ins = &d["text"][&id]["ins"];
  assert_eq!(ins.as_array().unwrap().len(), 1, "{d}");
  assert_eq!(ins[0]["s"], json!("owdy"), "{d}");
  assert_eq!(d["text"][&id]["del"], json!([[0, 1, 4]]), "{d}");
  assert!(d.get("patch").is_none_or(|p| p[&id].get("text").is_none()), "{d}");
  // Someone typed at the end at the same time: it survives.
  let (mut sim, id) = hello(&[Text, Text]);
  edit(&mut sim.eds[1], &id, 11, 11, " and more");
  sim.eds[0]
    .dispatch(Command::Ai {
      tool: "update_nodes".into(),
      input: json!({ "updates": [{ "id": id, "text": "Howdy world" }] }),
    })
    .unwrap();
  sim.flush(1);
  sim.flush(0);
  sim.settle();
  sim.assert_converged(0);
  all_say(&sim, &id, "Howdy world and more");
}

#[test]
fn typing_travels_as_a_text_entry_and_a_foreign_rewrite_travels_whole() {
  let (mut sim, id) = hello(&[Text, Text]);
  edit(&mut sim.eds[0], &id, 5, 5, ",");
  sim.eds[0]
    .dispatch(Command::Update {
      ids: vec![id.clone()],
      patch: json!({ "text": { "fontSize": 30 } }),
    })
    .unwrap();
  let d = sim.eds[0].collab_delta();
  let entry = &d["text"][&id];
  assert_eq!(entry["p"], json!({ "fontSize": 30.0 }), "{d}");
  assert_eq!(entry["ins"][0]["s"], json!(","));
  assert!(!d.to_string().contains("\"characters\""), "no whole text: {d}");
  // A path that rewrites the characters and the sequence's epoch (as an older build's whole-text
  // edit would) sends the whole text.
  let e = &mut sim.eds[1];
  let n = e.doc.get_mut(&id).unwrap().text.as_mut().unwrap();
  n.characters = "zzz".into();
  n.seq = None;
  let d = e.collab_delta();
  assert_eq!(d["patch"][&id]["text"]["characters"], json!("zzz"), "{d}");
  assert!(d.get("text").is_none(), "{d}");
}

#[test]
fn an_older_editor_gets_whole_texts_and_its_edits_reset_the_sequence() {
  let (mut sim, id) = hello(&[Text, Text, Lists]);
  edit(&mut sim.eds[0], &id, 11, 11, "!");
  sim.flush(0);
  let m = sim.inbox[2].back().unwrap().clone();
  assert!(m.get("text").is_none(), "{m}");
  assert_eq!(m["patch"][&id]["text"]["characters"], json!("Hello world!"), "{m}");
  assert!(m["patch"][&id]["text"].get("seq").is_none(), "{m}");
  sim.settle();
  // The older editor writes a whole text; the room's sequence is reset, everyone agrees.
  edit(&mut sim.eds[2], &id, 0, 0, "Oh, ");
  sim.settle();
  sim.assert_converged(0);
  all_say(&sim, &id, "Oh, Hello world!");
  assert!(sim.room.get(&id).unwrap().text.as_ref().unwrap().seq.is_none());
  // The new editors keep merging from there.
  edit(&mut sim.eds[0], &id, 0, 0, "A");
  edit(&mut sim.eds[1], &id, 0, 0, "B");
  sim.settle();
  sim.assert_converged(0);
  let t = text_of_doc(&sim.room, &id);
  assert!(t.contains('A') && t.contains('B'), "{t}");
}

#[test]
fn the_ack_rebuild_makes_every_copy_equal_to_the_room() {
  let (mut sim, id) = hello(&[Text, Text, Text]);
  for round in 0..30 {
    let i = round % 3;
    let len = char_count(&sim.eds[i], &id);
    let at = (round * 7) % (len + 1);
    edit(&mut sim.eds[i], &id, at, at, "ab");
    if round % 4 == 0 && len > 4 {
      edit(&mut sim.eds[(i + 1) % 3], &id, 1, 3, "");
    }
    sim.flush(i);
  }
  sim.settle();
  sim.assert_converged(0);
}

#[test]
fn text_in_an_instance_and_copies_never_get_a_sequence() {
  let (mut sim, id) = hello(&[Text, Text]);
  let e = &mut sim.eds[0];
  edit(e, &id, 0, 0, "x");
  assert!(e.doc.get(&id).unwrap().text.as_ref().unwrap().seq.is_some());
  // A copy starts a new history.
  let r = e.dispatch(Command::Duplicate { ids: vec![id.clone()] }).unwrap();
  let copy = r["created"][0].as_str().unwrap().to_string();
  assert!(e.doc.get(&copy).unwrap().text.as_ref().unwrap().seq.is_none());
  assert!(!e.copy(std::slice::from_ref(&id)).contains("\"seq\""));
  // A main component holding a text layer, an instance of it, edits inside both.
  let frame = e
    .dispatch(Command::CreateShape {
      kind: crate::model::NodeType::Frame,
      x: 0.0,
      y: 200.0,
      width: 200.0,
      height: 60.0,
      parent: None,
    })
    .unwrap();
  let frame = frame["id"].as_str().unwrap().to_string();
  let label = e
    .dispatch(Command::CreateText {
      x: 4.0,
      y: 4.0,
      characters: "Label".into(),
      parent: Some(frame.clone()),
    })
    .unwrap();
  let label = label["id"].as_str().unwrap().to_string();
  let main = e.dispatch(Command::CreateComponent { ids: vec![frame] }).unwrap();
  let main = main["id"].as_str().unwrap().to_string();
  let inst = e
    .dispatch(Command::CreateInstance {
      component_id: main.clone(),
      x: 300.0,
      y: 0.0,
      parent: None,
      anchor: None,
      into_components: false,
    })
    .unwrap();
  let inst = inst["id"].as_str().unwrap().to_string();
  let has_text = |e: &Engine, root: &str| -> Vec<NodeId> {
    e.doc
      .subtree(root)
      .into_iter()
      .filter(|n| e.doc.get(n).is_some_and(|n| n.text.is_some()))
      .collect()
  };
  let (inner, in_main) = (has_text(e, &inst), has_text(e, &main));
  assert!(!inner.is_empty() && !in_main.is_empty(), "{label}");
  edit(e, &in_main[0], 1, 1, "y");
  assert!(
    e.doc.get(&in_main[0]).unwrap().text.as_ref().unwrap().seq.is_some(),
    "the main's text merges"
  );
  for n in &has_text(e, &inst) {
    assert!(
      e.doc.get(n).unwrap().text.as_ref().unwrap().seq.is_none(),
      "an instance's copy has none"
    );
  }
  let inner = has_text(e, &inst);
  e.collab_delta();
  edit(e, &inner[0], 0, 0, "q");
  assert!(
    e.doc.get(&inner[0]).unwrap().text.as_ref().unwrap().seq.is_none(),
    "an override has none"
  );
  assert!(e.collab_delta().to_string().contains("\"characters\""), "an override travels whole");
}

#[test]
fn a_room_that_doesnt_merge_text_leaves_no_sequence() {
  let (mut sim, id) = hello(&[Text, Text]);
  let e = &mut sim.eds[0];
  edit(e, &id, 0, 0, "x");
  assert!(e.doc.get(&id).unwrap().text.as_ref().unwrap().seq.is_some());
  e.collab_reset(true, true, true);
  assert!(!e.collab_text());
  edit(e, &id, 0, 0, "y");
  assert!(
    e.doc.get(&id).unwrap().text.as_ref().unwrap().seq.is_none(),
    "editing alone drops it"
  );
  let d = e.collab_delta();
  assert_eq!(d["patch"][&id]["text"]["characters"], json!("yxHello world"), "{d}");
  // `text` needs `lists`.
  e.collab_reset(true, true, false);
  e.collab_enable_text(9);
  assert!(!e.collab_text());
}

#[test]
fn unsafe_links_in_a_remote_text_entry_are_dropped() {
  let (mut sim, id) = hello(&[Text, Text]);
  let mut entry = ops_entry(&sim.room, &id);
  entry["ins"] = json!([{ "id": [9, 0], "s": "x", "l": [0, 4], "r": null, "at": 5,
    "runs": [{ "start": 0, "end": 1, "link": "javascript:alert(1)", "fontWeight": 700 }] }]);
  entry["sty"] = json!([{ "a": [0, 0], "b": [0, 1], "set": { "link": "data:text/html,x" } }]);
  let d = json!({ "nodes": {}, "removed": [], "comments": {}, "commentsRemoved": [], "text": { id.clone(): entry } });
  let e = &mut sim.eds[0];
  e.dispatch(Command::ApplyRemote { delta: d, local: false }).unwrap();
  let t = e.doc.get(&id).unwrap().text.as_ref().unwrap();
  assert!(t.runs.iter().all(|r| r.link.is_none()), "{:?}", t.runs);
  assert!(t.runs.iter().any(|r| r.font_weight == Some(700)));
}

#[test]
fn a_rejected_text_delta_leaves_the_room_alone() {
  let (sim, id) = hello(&[Text]);
  let mut room = sim.room.clone();
  let bad = json!({ "text": { id.clone(): { "e": 1, "ins": [{ "id": [1, 0], "s": "ab", "n": 5 }] } } });
  let before = room.clone();
  assert!(apply_opts(&mut room, &bad, ApplyOpts { prune: true }).is_err());
  assert_eq!(room.nodes, before.nodes);
  // A text entry for a layer that is gone is skipped, like any patch.
  let gone = json!({ "text": { "n_nope": { "e": 1 } } });
  assert!(apply_opts(&mut room, &gone, ApplyOpts { prune: true }).is_ok());
  assert!(!crate::collab::is_empty(&bad));
}

#[test]
fn caret_queries_follow_other_peoples_typing() {
  let (mut sim, id) = hello(&[Text, Text]);
  let anchors = |e: &Engine, idx: Vec<usize>, seq: Option<crate::textseq::TextSeq>| {
    e.query(Query::TextAnchors {
      id: id.clone(),
      indices: idx,
      seq,
    })
    .unwrap()
  };
  let a = anchors(&sim.eds[0], vec![0, 5, 11], None);
  assert_eq!(a["anchors"][0], Value::Null);
  assert_eq!(a["anchors"][1], json!([0, 4]));
  // Someone types at the start and right at my caret.
  edit(&mut sim.eds[1], &id, 0, 0, ">>");
  edit(&mut sim.eds[1], &id, 7, 7, "++");
  sim.flush(1);
  sim.settle();
  let indices = |e: &Engine, a: &Value| {
    e.query(Query::TextIndices {
      id: id.clone(),
      anchors: serde_json::from_value(a["anchors"].clone()).unwrap(),
    })
    .unwrap()["indices"]
      .clone()
  };
  // (My caret was after "Hello": it stays before what was typed at it.)
  assert_eq!(indices(&sim.eds[0], &a), json!([0, 7, 15]), "text: {}", text_of(&sim.eds[0], &id));
  // A deleted anchor maps to where it was.
  edit(&mut sim.eds[0], &id, 2, 5, "");
  assert_eq!(indices(&sim.eds[0], &a)[1], json!(4), "text: {}", text_of(&sim.eds[0], &id));
  // An older state of the text still anchors.
  let old = state(&sim.eds[0], &id).unwrap().seq;
  let then = anchors(&sim.eds[0], vec![3], old);
  edit(&mut sim.eds[0], &id, 0, 0, "zz");
  let now = anchors(&sim.eds[0], vec![5], None);
  assert_eq!(then["anchors"][0], now["anchors"][0]);
}

#[test]
fn a_text_only_change_of_the_sequence_is_neutral_for_layout_and_render() {
  let (sim, id) = hello(&[Text]);
  let old = sim.room.get(&id).unwrap().clone();
  let mut new = old.clone();
  let mut t = new.text.clone().unwrap();
  textseq::local_edit(&mut t, 0, 0, "", &mut textseq::SiteIds { site: 3, ctr: 0 }).unwrap();
  t.seq.as_mut().unwrap().k = 9;
  new.text = Some(t);
  assert_ne!(old, new);
  assert!(crate::ops::layout_neutral(&old, &new));
  assert!(crate::ops::render_neutral(&old, &new));
  new.text.as_mut().unwrap().characters.push('x');
  assert!(!crate::ops::layout_neutral(&old, &new));
}

#[test]
fn enabling_text_again_with_the_same_site_keeps_the_counter() {
  let (mut sim, id) = hello(&[Text]);
  edit(&mut sim.eds[0], &id, 0, 0, "abc");
  sim.eds[0].collab_enable_text(site_for(5, 0, 0));
  edit(&mut sim.eds[0], &id, 0, 0, "d");
  let d = sim.eds[0].collab_delta();
  let ctrs: Vec<u64> = d["text"][&id]["ins"]
    .as_array()
    .unwrap()
    .iter()
    .map(|i| i["id"][1].as_u64().unwrap())
    .collect();
  assert!(ctrs.contains(&3), "d continues the counter: {d}");
  let t = sim.eds[0].doc.get(&id).unwrap().text.as_ref().unwrap();
  assert!(textseq::valid(t.seq.as_ref().unwrap(), &t.characters), "no id is used twice");
  // A site beyond 48 bits is brought into range.
  sim.eds[0].collab_enable_text(u64::MAX);
  edit(&mut sim.eds[0], &id, 0, 0, "e");
  let d = sim.eds[0].collab_delta();
  assert!(d["text"][&id]["ins"][0]["id"][0].as_u64().unwrap() <= textseq::MAX_SITE, "{d}");
}

#[test]
fn offline_edits_merge_on_rejoin() {
  let (mut sim, id) = hello(&[Text, Text, Text]);
  sim.go_offline(2, 1000);
  edit(&mut sim.eds[2], &id, 5, 5, "<offline>");
  edit(&mut sim.eds[0], &id, 0, 0, "A ");
  edit(&mut sim.eds[1], &id, 11, 11, " B");
  sim.flush(0);
  sim.flush(1);
  sim.reconnect(2);
  sim.settle();
  sim.assert_converged(0);
  all_say(&sim, &id, "A Hello<offline> world B");
}

// ---------- The simulation ----------

/// A relay (its document and one queue of messages per editor) and its editors.
struct Sim {
  room: Document,
  eds: Vec<Engine>,
  dialect: Vec<Dialect>,
  inbox: Vec<VecDeque<Value>>,
  /// The step an editor that is away comes back at.
  offline: Vec<Option<usize>>,
  texts: Vec<NodeId>,
  seed: u64,
  rejoins: u64,
}

/// What an editor remembers between operations.
#[derive(Default)]
struct EdState {
  /// Layer and last letter of the burst being typed.
  last: Option<(NodeId, char)>,
  /// Earlier steps made by `EditText` (before and after), for `RevertText`.
  snaps: Vec<(NodeId, TextState, TextState)>,
}

impl Sim {
  fn new(seed: u64, dialects: &[Dialect]) -> Sim {
    let mut first = engine(seed | 2);
    first.dispatch(Command::AddPage { name: None }).unwrap();
    let mut texts = Vec::new();
    for (i, t) in TEXTS.iter().enumerate() {
      let _ = first
        .dispatch(Command::CreateText {
          x: 10.0,
          y: 40.0 * i as f64,
          characters: (*t).into(),
          parent: None,
        })
        .unwrap();
      texts.push(
        first
          .doc
          .nodes
          .values()
          .find(|n| n.text.as_ref().is_some_and(|x| x.characters == *t))
          .unwrap()
          .id
          .clone(),
      );
    }
    // (Fixed-size layers: the size of an auto-size text follows the merged text on every editor, while
    // the room keeps whichever size was sent last, so only fixed ones are compared exactly.)
    for id in &texts {
      first
        .dispatch(Command::Update {
          ids: vec![id.clone()],
          patch: json!({ "text": { "autoResize": "none" } }),
        })
        .unwrap();
    }
    let json = first.to_json();
    let eds: Vec<Engine> = dialects
      .iter()
      .enumerate()
      .map(|(i, d)| {
        let mut e = engine(seed.wrapping_mul(31) + 100 + 2 * i as u64);
        e.load(&json).unwrap();
        e.collab_reset(true, true, true);
        if *d == Text {
          e.collab_enable_text(site_for(seed, i as u64, 0));
        }
        e
      })
      .collect();
    Sim {
      room: first.doc.clone(),
      eds,
      dialect: dialects.to_vec(),
      inbox: vec![VecDeque::new(); dialects.len()],
      offline: vec![None; dialects.len()],
      texts,
      seed,
      rejoins: 0,
    }
  }

  /// Editor `i` flushes (as the web shell does) and the relay handles it at once.
  fn flush(&mut self, i: usize) {
    if self.offline[i].is_some() {
      return;
    }
    let d = self.eds[i].collab_delta();
    if d.get("full").is_some() || is_empty(&d) {
      return;
    }
    let d = wire(&d);
    trail(format!("flush ed{i}"));
    if let Err(e) = apply_opts(&mut self.room, &d, ApplyOpts { prune: true }) {
      panic!("seed {}: the relay rejected ed{i}'s delta: {e}\n{d}\n{}", self.seed, last_steps());
    }
    for j in 0..self.eds.len() {
      if j == i {
        self.inbox[j].push_back(json!({ "ack": true }));
      } else if self.offline[j].is_some() {
        continue;
      } else if self.dialect[j] == Text {
        self.inbox[j].push_back(d.clone());
      } else {
        self.inbox[j].push_back(legacy_text(&d, &self.room).map(|w| wire(&w)).unwrap_or_else(|| d.clone()));
      }
    }
  }

  /// Editor `j` receives its oldest message (flushing its own changes first, as the shell does).
  fn deliver(&mut self, j: usize) {
    if self.offline[j].is_some() {
      return;
    }
    let Some(m) = self.inbox[j].pop_front() else { return };
    self.flush(j);
    trail(format!("deliver ed{j}"));
    if m.get("ack").is_some() {
      self.eds[j].dispatch(Command::CollabAck { rejected: false }).unwrap();
    } else if let Err(e) = self.eds[j].dispatch(Command::ApplyRemote {
      delta: m.clone(),
      local: false,
    }) {
      panic!("seed {}: ed{j} couldn't apply {m}: {e}\n{}", self.seed, last_steps());
    }
  }

  /// Editor `i` loses its connection: what was on its way is lost, and it keeps editing alone.
  fn go_offline(&mut self, i: usize, until: usize) {
    trail(format!("ed{i} offline until {until}"));
    self.offline[i] = Some(until);
    self.inbox[i].clear();
  }

  /// Editor `i` joins again as `collab.ts` does: its unsent changes are taken, the room's document is
  /// loaded, the baseline and a fresh site start, and the unsent changes are re-applied as its own.
  fn reconnect(&mut self, i: usize) {
    trail(format!("ed{i} reconnects"));
    self.offline[i] = None;
    self.rejoins += 1;
    let unsent = self.eds[i].collab_unsent();
    let json = serde_json::to_string(&self.room).unwrap();
    self.eds[i].load(&json).unwrap();
    self.eds[i].collab_reset(true, true, true);
    if self.dialect[i] == Text {
      self.eds[i].collab_enable_text(site_for(self.seed, i as u64, self.rejoins));
    }
    for d in unsent.as_array().into_iter().flatten() {
      let _ = self.eds[i].dispatch(Command::ApplyRemote {
        delta: d.clone(),
        local: true,
      });
    }
    self.inbox[i].clear();
    self.flush(i);
  }

  fn settle(&mut self) {
    for i in 0..self.eds.len() {
      if self.offline[i].is_some() {
        self.reconnect(i);
      }
    }
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
    panic!("seed {}: never settled", self.seed);
  }

  fn assert_converged(&self, seed: u64) {
    for (i, e) in self.eds.iter().enumerate() {
      assert!(e.doc.pages == self.room.pages, "seed {seed} editor {i}: pages differ");
      // (An editor that predates `text` doesn't keep the sequences up: compared without them.)
      let (mine, room) = if self.dialect[i] == Lists {
        (without_seq(&e.doc), without_seq(&self.room))
      } else {
        (e.doc.clone(), self.room.clone())
      };
      if mine.nodes != room.nodes {
        panic!(
          "seed {seed} editor {i} differs from the room: {}\n{}",
          diff_nodes(&mine, &room),
          last_steps()
        );
      }
    }
    for n in self.room.nodes.values() {
      if let Some(t) = &n.text {
        if let Some(s) = &t.seq {
          assert!(
            textseq::valid(s, &t.characters),
            "seed {seed}: {} has a sequence that doesn't describe it",
            n.id
          );
        }
      }
    }
  }
}

fn run(seed: u64, dialects: &[Dialect], steps: usize, mode: Mode, offline: bool) {
  let n = dialects.len();
  let mut r = Rng(seed.wrapping_mul(2_654_435_761).wrapping_add(1));
  let mut sim = Sim::new(seed, dialects);
  let mut st: Vec<EdState> = (0..n).map(|_| EdState::default()).collect();
  let mut typed: Vec<Vec<(NodeId, Vec<char>)>> = vec![Vec::new(); n];
  let mut counter = 0u32;
  for step in 0..steps {
    TRAIL.with(|t| t.borrow_mut().push(format!("-- seed {seed} step {step}")));
    for i in 0..n {
      if sim.offline[i].is_some_and(|until| step >= until) {
        sim.reconnect(i);
      }
    }
    match r.below(10) {
      0..=4 => {
        let i = r.below(n);
        local_op(&mut sim, i, &mut r, &mut st[i], &mut typed[i], &mut counter, mode);
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
    if offline && r.below(70) == 0 && sim.offline.iter().all(|o| o.is_none()) {
      let i = r.below(n);
      sim.go_offline(i, step + 20 + r.below(180));
    }
  }
  sim.settle();
  sim.assert_converged(seed);
  if mode == Intent && dialects.iter().all(|d| *d == Text) {
    for (i, bursts) in typed.iter().enumerate() {
      for (id, burst) in bursts {
        let chars: Vec<char> = sim.room.get(id).unwrap().text.as_ref().unwrap().characters.chars().collect();
        let at: Vec<Option<usize>> = burst.iter().map(|c| chars.iter().position(|x| x == c)).collect();
        assert!(
          at.iter().all(|a| a.is_some()),
          "seed {seed}: ed{i} lost characters of a burst {burst:?} in {chars:?}"
        );
        let at: Vec<usize> = at.into_iter().map(|a| a.unwrap()).collect();
        assert!(
          at.windows(2).all(|w| w[1] == w[0] + 1),
          "seed {seed}: ed{i}'s burst {burst:?} is not in one piece, in order: {at:?} in {:?}",
          chars.iter().collect::<String>()
        );
      }
    }
  }
}

// ---------- Random operations ----------

fn local_op(sim: &mut Sim, i: usize, r: &mut Rng, st: &mut EdState, typed: &mut Vec<(NodeId, Vec<char>)>, counter: &mut u32, mode: Mode) {
  let id = sim.texts[r.below(sim.texts.len())].clone();
  let e = &mut sim.eds[i];
  let chars: Vec<char> = text_of(e, &id).chars().collect();
  let len = chars.len();
  match mode {
    Intent => match r.below(10) {
      0..=7 => {
        // Continue the burst, or start one next to an original character.
        let cont = st.last.clone().filter(|(lid, c)| r.below(10) < 7 && text_of(e, lid).contains(*c));
        let (id, at, fresh) = match cont {
          Some((lid, c)) => {
            let at = text_of(e, &lid).chars().position(|x| x == c).unwrap() + 1;
            (lid, at, false)
          }
          None => {
            let spots: Vec<usize> = (0..=len).filter(|&k| k == 0 || !is_typed(chars[k - 1])).collect();
            (id, spots[r.below(spots.len())], true)
          }
        };
        if fresh {
          typed.push((id.clone(), Vec::new()));
        }
        let s: Vec<char> = (0..1 + r.below(4)).map(|_| private(counter)).collect();
        let _ = e.dispatch(Command::EditText {
          id: id.clone(),
          start: at,
          end: at,
          text: s.iter().collect(),
        });
        typed.last_mut().unwrap().1.extend(s.iter());
        st.last = Some((id, *s.last().unwrap()));
      }
      8 => style(e, &id, r, len),
      _ => props(e, &id, r),
    },
    Anything => {
      if r.below(5) != 0 {
        st.last = None;
      }
      match r.below(20) {
        0..=5 => {
          let at = r.below(len + 1);
          let before = state(e, &id);
          let _ = e.dispatch(Command::EditText {
            id: id.clone(),
            start: at,
            end: at,
            text: letters(r, 1, 4),
          });
          remember(st, &id, before, state(e, &id));
        }
        6..=7 if len > 0 => {
          let a = r.below(len);
          let b = (a + 1 + r.below(6)).min(len);
          let before = state(e, &id);
          let _ = e.dispatch(Command::EditText {
            id: id.clone(),
            start: a,
            end: b,
            text: String::new(),
          });
          remember(st, &id, before, state(e, &id));
        }
        8 if len > 0 => {
          let a = r.below(len);
          let b = (a + 1 + r.below(8)).min(len);
          let _ = e.dispatch(Command::EditText {
            id: id.clone(),
            start: a,
            end: b,
            text: letters(r, 0, 5),
          });
        }
        9 => style(e, &id, r, len),
        10 | 11 => {
          // Whole text, as Claude, a plugin or a variable writes it.
          let a = r.below(len + 1);
          let b = (a + r.below(6)).min(len);
          let mut next: String = chars[..a].iter().collect();
          next.push_str(&letters(r, 0, 5));
          next.extend(chars[b..].iter());
          if r.below(2) == 0 {
            let _ = e.dispatch(Command::SetText {
              id,
              characters: next,
              runs: None,
            });
          } else {
            let _ = e.dispatch(Command::Update {
              ids: vec![id],
              patch: json!({ "text": { "characters": next } }),
            });
          }
        }
        12 => props(e, &id, r),
        13 => {
          // A gesture: one undo step for a whole editing session.
          let _ = e.dispatch(Command::BeginGesture);
          for _ in 0..1 + r.below(4) {
            let len = char_count(e, &id);
            let a = r.below(len + 1);
            let b = (a + r.below(3)).min(len);
            let _ = e.dispatch(Command::EditText {
              id: id.clone(),
              start: a,
              end: b,
              text: letters(r, 0, 4),
            });
          }
          let _ = e.dispatch(Command::EndGesture);
        }
        14 | 15 => {
          let _ = e.dispatch(Command::Undo);
        }
        16 => {
          let _ = e.dispatch(Command::Redo);
        }
        17 | 18 if !st.snaps.is_empty() => {
          // The editor's own undo or redo of a typing step, through `RevertText`.
          let (sid, before, after) = st.snaps[r.below(st.snaps.len())].clone();
          let (from, to) = if r.below(2) == 0 { (after, before) } else { (before, after) };
          let _ = e.dispatch(Command::RevertText { id: sid, from, to });
        }
        _ => {
          let at = r.below(len + 1);
          let _ = e.dispatch(Command::EditText {
            id: id.clone(),
            start: at,
            end: at,
            text: "😀\n".into(),
          });
        }
      }
    }
  }
}

fn style(e: &mut Engine, id: &str, r: &mut Rng, len: usize) {
  let a = r.below(len + 1);
  let b = (a + 1 + r.below(10)).min(len);
  let (style, clear): (Value, Vec<String>) = match r.below(6) {
    0 => (json!({ "fontWeight": 700 }), vec![]),
    1 => (json!({ "italic": true }), vec![]),
    2 => (json!({ "color": format!("#{:02x}0000", r.below(256)) }), vec![]),
    3 => (json!({ "fontSize": 10 + r.below(20) }), vec![]),
    4 => (json!({}), vec!["fontWeight".into(), "italic".into()]),
    _ => (json!({ "letterSpacing": 1 }), vec!["color".into()]),
  };
  let _ = e.dispatch(Command::StyleText {
    id: id.into(),
    start: a,
    end: b,
    style,
    clear,
  });
}

fn props(e: &mut Engine, id: &str, r: &mut Rng) {
  let patch = match r.below(3) {
    0 => json!({ "text": { "fontSize": 12 + r.below(20) } }),
    1 => json!({ "text": { "lineHeight": 14 + r.below(20) } }),
    _ => json!({ "text": { "paragraphSpacing": r.below(10) } }),
  };
  let _ = e.dispatch(Command::Update {
    ids: vec![id.into()],
    patch,
  });
}

fn remember(st: &mut EdState, id: &str, before: Option<TextState>, after: Option<TextState>) {
  if let (Some(b), Some(a)) = (before, after) {
    st.snaps.push((id.into(), b, a));
    if st.snaps.len() > 4 {
      st.snaps.remove(0);
    }
  }
}

fn state(e: &Engine, id: &str) -> Option<TextState> {
  e.doc.get(id).and_then(|n| n.text.as_ref()).map(|t| TextState {
    characters: t.characters.clone(),
    runs: t.runs.clone(),
    seq: t.seq.clone(),
  })
}

/// The characters of a text in a room's document (see `text_of` for an editor's).
fn text_of_doc(d: &Document, id: &str) -> String {
  d.get(id)
    .and_then(|n| n.text.as_ref())
    .map(|t| t.characters.clone())
    .unwrap_or_default()
}

/// An entry that changes nothing, for `id` as it is in `d`.
fn ops_entry(d: &Document, id: &str) -> Value {
  let t = d.get(id).and_then(|n| n.text.as_ref()).unwrap();
  textseq::ops(t, t).unwrap()
}

fn text_of(e: &Engine, id: &str) -> String {
  e.doc
    .get(id)
    .and_then(|n| n.text.as_ref())
    .map(|t| t.characters.clone())
    .unwrap_or_default()
}

fn char_count(e: &Engine, id: &str) -> usize {
  text_of(e, id).chars().count()
}

/// Letters (and now and then a space or an accented one) for typing in the unrestricted mode.
fn letters(r: &mut Rng, min: usize, spread: usize) -> String {
  const SET: [char; 12] = ['a', 'b', 'c', 'x', 'y', 'z', ' ', 'é', 'Q', '7', '-', 'ß'];
  let n = min + r.below(spread);
  (0..n).map(|_| SET[r.below(SET.len())]).collect()
}

/// A letter nobody else types: private-use characters, counted.
fn private(counter: &mut u32) -> char {
  *counter += 1;
  char::from_u32(0xE000 + (*counter % 6000)).unwrap()
}

fn is_typed(c: char) -> bool {
  ('\u{E000}'..'\u{F900}').contains(&c)
}

/// A site number for editor `i`, its `n`th join: 48 bits, some near the top of the range JSON numbers hold.
fn site_for(seed: u64, i: u64, n: u64) -> u64 {
  let x = seed.wrapping_mul(0x9e37_79b9).wrapping_add(i * 7919 + n * 104_729 + 1);
  if (seed + i + n).is_multiple_of(3) {
    (1 << 48) - 1 - (x % 1000)
  } else {
    (x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 16) & ((1 << 48) - 1)
  }
  .max(1)
}

fn engine(seed: u64) -> Engine {
  Engine::new(Box::new(HeuristicMeasurer), seed)
}

/// What goes over the wire.
fn wire(v: &Value) -> Value {
  serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

/// `d` with every text's sequence taken off.
fn without_seq(d: &Document) -> Document {
  let mut out = d.clone();
  let ids: Vec<NodeId> = out
    .nodes
    .values()
    .filter(|n| n.text.as_ref().is_some_and(|t| t.seq.is_some()))
    .map(|n| n.id.clone())
    .collect();
  for id in ids {
    if let Some(t) = out.get_mut(&id).and_then(|n| n.text.as_mut()) {
      t.seq = None;
    }
  }
  out
}

/// The first layer that differs, short enough to read.
fn diff_nodes(a: &Document, b: &Document) -> String {
  for n in a.nodes.values() {
    match b.get(&n.id) {
      Some(m) if m == &**a.nodes.get(&n.id).unwrap() => {}
      Some(m) => {
        if n.text != m.text {
          return format!(
            "{} text: {} vs {}",
            n.id,
            serde_json::to_string(&n.text).unwrap(),
            serde_json::to_string(&m.text).unwrap()
          );
        }
        return format!("{} differs outside its text", n.id);
      }
      None => return format!("{} is missing in the room", n.id),
    }
  }
  "the room has layers the editor lacks".into()
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
