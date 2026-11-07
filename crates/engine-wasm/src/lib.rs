//! WebAssembly bindings for the Designotron engine. All structured data
//! crosses the boundary as JSON strings to keep the surface small.

use std::cell::RefCell;
use std::collections::HashMap;

use designotron_engine::persist::Persist;
use designotron_engine::text::{FontSpec, TextMeasurer};
use designotron_engine::{Command, Engine, Query};
use wasm_bindgen::prelude::*;

/// Measured strings kept before the cache is dropped (about 100 bytes each).
const MAX_MEASURED: usize = 200_000;

#[wasm_bindgen]
extern "C" {
  /// Provided by the web shell (canvas `measureText`).
  #[wasm_bindgen(js_namespace = globalThis, js_name = dtMeasureText)]
  fn js_measure(family: &str, size: f64, weight: u32, italic: bool, text: &str) -> f64;
}

struct CanvasMeasurer;

impl TextMeasurer for CanvasMeasurer {
  fn measure(&self, text: &str, font: &FontSpec) -> f64 {
    let n = text.chars().count() as f64;
    let key = FontKey {
      family: font.family.to_string(),
      size: font.size.to_bits(),
      weight: font.weight,
      italic: font.italic,
    };
    let cached = MEASURED.with(|m| m.borrow().fonts.get(&key).and_then(|t| t.get(text)).copied());
    let width = cached.unwrap_or_else(|| {
      let w = js_measure(font.family, font.size, font.weight, font.italic, text);
      MEASURED.with(|m| {
        let mut m = m.borrow_mut();
        if m.entries >= MAX_MEASURED {
          *m = Measured::default();
        }
        m.entries += 1;
        m.fonts.entry(key).or_default().insert(text.to_string(), w);
      });
      w
    });
    width + n * font.letter_spacing
  }

  fn image_size(&self, src: &str) -> Option<(f64, f64)> {
    // Remember who asked: only a change to one of these can alter what was painted.
    IMAGE_ASKED.with(|a| a.borrow_mut().insert(src.to_string()));
    IMAGE_SIZES.with(|m| m.borrow().get(src).copied())
  }
}

// Pixel sizes of the images the editor has measured (`setImageSizes`), by paint source. Tiled
// image fills use them; the engine never stores them in the document.
thread_local! {
  static IMAGE_SIZES: RefCell<HashMap<String, (f64, f64)>> = RefCell::new(HashMap::new());
  // Sources a render has asked the size of (tiled fills), since the cache was last reset.
  static IMAGE_ASKED: RefCell<std::collections::HashSet<String>> = RefCell::new(std::collections::HashSet::new());
}

// Text widths already asked of the browser. Laying out a big file measures the same strings
// again and again, and every call across the boundary copies its strings into JS, so a
// relayout of 20k layers made hundreds of MB of garbage there. Dropped when fonts load.
thread_local! {
  static MEASURED: RefCell<Measured> = RefCell::new(Measured::default());
}

#[derive(Default)]
struct Measured {
  fonts: HashMap<FontKey, HashMap<String, f64>>,
  entries: usize,
}

#[derive(PartialEq, Eq, Hash)]
struct FontKey {
  family: String,
  size: u64,
  weight: u32,
  italic: bool,
}

/// Forgets measured text widths (a web font finished loading, so widths changed).
#[wasm_bindgen(js_name = clearMeasureCache)]
pub fn clear_measure_cache() {
  MEASURED.with(|m| *m.borrow_mut() = Measured::default());
}

#[wasm_bindgen]
pub struct WasmEngine {
  inner: Engine,
  persist: Persist,
}

#[wasm_bindgen]
impl WasmEngine {
  #[wasm_bindgen(constructor)]
  pub fn new(seed: f64) -> WasmEngine {
    WasmEngine {
      inner: Engine::new(Box::new(CanvasMeasurer), seed as u64),
      persist: Persist::default(),
    }
  }

  pub fn load(&mut self, json: &str) -> Result<(), JsValue> {
    self.inner.load(json).map_err(|e| JsValue::from_str(&e))
  }

  /// A second engine on the same document without serialising it (see `Engine::fork`).
  pub fn fork(&self) -> WasmEngine {
    WasmEngine {
      inner: self.inner.fork(Box::new(CanvasMeasurer)),
      persist: Persist::default(),
    }
  }

  /// Tells the engine the pixel sizes of images: JSON `{src: [w, h]}`. When one is new or
  /// changed, everything is painted again (tiled fills depend on it).
  #[wasm_bindgen(js_name = setImageSizes)]
  pub fn set_image_sizes(&mut self, json: &str) {
    let Ok(sizes) = serde_json::from_str::<HashMap<String, [f64; 2]>>(json) else {
      return;
    };
    let changed = IMAGE_SIZES.with(|m| {
      let mut m = m.borrow_mut();
      let mut changed = false;
      for (src, [w, h]) in sizes {
        if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) {
          continue;
        }
        if m.insert(src.clone(), (w, h)) != Some((w, h)) && IMAGE_ASKED.with(|a| a.borrow().contains(&src)) {
          changed = true;
        }
      }
      changed
    });
    if changed {
      IMAGE_ASKED.with(|a| a.borrow_mut().clear());
      self.inner.reset_render_cache();
      self.inner.rev += 1;
    }
  }

  pub fn save(&self) -> String {
    self.inner.to_json()
  }

  pub fn rev(&self) -> f64 {
    self.inner.rev as f64
  }

  pub fn state(&self) -> String {
    self.inner.state().to_string()
  }

  /// Executes a JSON command; returns the JSON result or throws the error message.
  pub fn dispatch(&mut self, cmd: &str) -> Result<String, JsValue> {
    let cmd: Command = serde_json::from_str(cmd).map_err(|e| JsValue::from_str(&parse_error("command", &e)))?;
    self.inner.dispatch(cmd).map(|v| v.to_string()).map_err(|e| JsValue::from_str(&e))
  }

  pub fn query(&self, q: &str) -> Result<String, JsValue> {
    let q: Query = serde_json::from_str(q).map_err(|e| JsValue::from_str(&format!("bad query: {e}")))?;
    self.inner.query(q).map(|v| v.to_string()).map_err(|e| JsValue::from_str(&e))
  }

  /// SVG markup for a page; `hidden` is a JSON array of node ids to paint invisibly.
  pub fn render(&self, page: &str, hidden: &str, editing: &str) -> String {
    let hidden: Vec<String> = serde_json::from_str(hidden).unwrap_or_default();
    self.inner.render(page, &hidden, Some(editing).filter(|e| !e.is_empty()))
  }

  /// Local changes since the last call, for collaborators (`{full}` the first time).
  #[wasm_bindgen(js_name = collabDelta)]
  pub fn collab_delta(&mut self) -> String {
    self.inner.collab_delta().to_string()
  }

  /// Starts the collaboration baseline at the current document; `ordered` when the relay
  /// acknowledges changes in order, `granular` when it also takes pages, styles and variables
  /// per id (see `Engine::collab_reset`).
  #[wasm_bindgen(js_name = collabReset)]
  pub fn collab_reset(&mut self, ordered: bool, granular: bool) {
    self.inner.collab_reset(ordered, granular);
  }

  /// Whether this engine reads and writes pages, styles and variables per id in deltas (what
  /// an editor tells the room it can do when joining).
  #[wasm_bindgen(js_name = collabGranular)]
  pub fn collab_granular(&self) -> bool {
    designotron_engine::collab::GRANULAR
  }

  /// `json` (a delta or document) as a relay that knows only model `relay_model` can store it
  /// (see `collab::downgrade`). Applied to what is sent, never to the editor's own copy.
  #[wasm_bindgen(js_name = collabDowngrade)]
  pub fn collab_downgrade(&self, json: &str, relay_model: f64) -> String {
    let value = serde_json::from_str(json).unwrap_or(serde_json::Value::Null);
    designotron_engine::collab::downgrade(&value, relay_model as u32).to_string()
  }

  /// JSON array of this editor's unacknowledged and unsent changes, oldest first.
  #[wasm_bindgen(js_name = collabUnsent)]
  pub fn collab_unsent(&mut self) -> String {
    self.inner.collab_unsent().to_string()
  }

  /// JSON delta of the document since the last call (`{full}` or `{nodes, removed, meta}`).
  #[wasm_bindgen(js_name = docDelta)]
  pub fn doc_delta(&mut self, full: bool) -> String {
    self.inner.doc_delta_json(full)
  }

  /// JSON `{order, changed}`: only top-level layers changed since the last call are re-rendered.
  #[wasm_bindgen(js_name = renderIncremental)]
  pub fn render_incremental(&mut self, page: &str, hidden: &str, reset: bool, editing: &str) -> String {
    let hidden: Vec<String> = serde_json::from_str(hidden).unwrap_or_default();
    if reset {
      self.inner.reset_render_cache();
    }
    self
      .inner
      .render_incremental(page, &hidden, Some(editing).filter(|e| !e.is_empty()))
      .to_string()
  }

  /// What to write to storage so it matches the document: JSON
  /// `{token, full, meta, dirty: [layer ids], names: {layer id: name}, removed: [layer ids]}` (see `persist::Plan`).
  /// Fetch each dirty layer's records with `persistChunk` (they stay available until a write that is at least as new has landed).
  #[wasm_bindgen(js_name = persistPlan)]
  pub fn persist_plan(&mut self, force_full: bool) -> String {
    let plan = self.persist.plan(&self.inner.doc, force_full);
    serde_json::json!({
      "token": plan.token,
      "full": plan.full,
      "meta": plan.meta,
      "dirty": plan.dirty,
      "names": plan.names,
      "removed": plan.removed,
    })
    .to_string()
  }

  /// The nodes of one top-level layer's tree from plan `token` of `persistPlan`, as the body
  /// of a JSON object (`"id":{...},...`); empty if the plan is no longer kept.
  #[wasm_bindgen(js_name = persistChunk)]
  pub fn persist_chunk(&self, token: f64, root: &str) -> String {
    self.persist.chunk(token as u64, root)
  }

  /// Storage now holds the document of plan `token`.
  #[wasm_bindgen(js_name = persistCommit)]
  pub fn persist_commit(&mut self, token: f64) {
    self.persist.commit(token as u64);
  }

  /// The document just loaded is exactly what storage holds: later plans cover only changes.
  #[wasm_bindgen(js_name = persistAdopt)]
  pub fn persist_adopt(&mut self) {
    self.persist.adopt(&self.inner.doc);
  }
}

/// A JSON parse failure as a message a person can act on: serde's recursion limit (128 levels)
/// is about nesting depth, which `bad command: recursion limit exceeded` doesn't say.
fn parse_error(what: &str, e: &serde_json::Error) -> String {
  let msg = e.to_string();
  if msg.contains("recursion limit") {
    "layers are nested too deeply (about 60 levels max)".into()
  } else {
    format!("bad {what}: {msg}")
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn deep_nesting_has_a_clear_message() {
    let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
    let e = serde_json::from_str::<serde_json::Value>(&deep).unwrap_err();
    assert_eq!(parse_error("command", &e), "layers are nested too deeply (about 60 levels max)");
    let e = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
    assert!(parse_error("command", &e).starts_with("bad command: "));
  }
}
