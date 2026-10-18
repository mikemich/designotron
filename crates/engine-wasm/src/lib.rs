//! WebAssembly bindings for the Designotron engine. All structured data
//! crosses the boundary as JSON strings to keep the surface small.

use designotron_engine::text::{FontSpec, TextMeasurer};
use designotron_engine::{Command, Engine, Query};
use wasm_bindgen::prelude::*;

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
    js_measure(font.family, font.size, font.weight, font.italic, text) + n * font.letter_spacing
  }
}

#[wasm_bindgen]
pub struct WasmEngine {
  inner: Engine,
}

#[wasm_bindgen]
impl WasmEngine {
  #[wasm_bindgen(constructor)]
  pub fn new(seed: f64) -> WasmEngine {
    WasmEngine {
      inner: Engine::new(Box::new(CanvasMeasurer), seed as u64),
    }
  }

  pub fn load(&mut self, json: &str) -> Result<(), JsValue> {
    self.inner.load(json).map_err(|e| JsValue::from_str(&e))
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
    let cmd: Command = serde_json::from_str(cmd).map_err(|e| JsValue::from_str(&format!("bad command: {e}")))?;
    self.inner.dispatch(cmd).map(|v| v.to_string()).map_err(|e| JsValue::from_str(&e))
  }

  pub fn query(&self, q: &str) -> Result<String, JsValue> {
    let q: Query = serde_json::from_str(q).map_err(|e| JsValue::from_str(&format!("bad query: {e}")))?;
    self.inner.query(q).map(|v| v.to_string()).map_err(|e| JsValue::from_str(&e))
  }

  /// SVG markup for a page; `hidden` is a JSON array of node ids to paint invisibly.
  pub fn render(&self, page: &str, hidden: &str) -> String {
    let hidden: Vec<String> = serde_json::from_str(hidden).unwrap_or_default();
    self.inner.render(page, &hidden)
  }

  /// JSON delta of the document since the last call (`{full}` or `{nodes, removed, meta}`).
  #[wasm_bindgen(js_name = docDelta)]
  pub fn doc_delta(&mut self, full: bool) -> String {
    self.inner.doc_delta(full).to_string()
  }

  /// JSON `{order, changed}`: only top-level layers changed since the last call are re-rendered.
  #[wasm_bindgen(js_name = renderIncremental)]
  pub fn render_incremental(&mut self, page: &str, hidden: &str, reset: bool) -> String {
    let hidden: Vec<String> = serde_json::from_str(hidden).unwrap_or_default();
    if reset {
      self.inner.reset_render_cache();
    }
    self.inner.render_incremental(page, &hidden).to_string()
  }
}
