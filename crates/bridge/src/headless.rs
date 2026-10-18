//! Native engine used when no editor tab is open, plus the design file in the
//! workspace (`design.dtron.json`) that Claude Code can read directly.

use std::path::PathBuf;

use designotron_engine::text::HeuristicMeasurer;
use designotron_engine::{Command, Engine};
use serde_json::{json, Value};
use tokio::sync::Mutex;

pub const DESIGN_FILE: &str = "design.dtron.json";

pub struct Headless {
  path: PathBuf,
  /// Latest document JSON pushed by the editor.
  mirror: Mutex<Option<String>>,
}

impl Headless {
  pub fn new(workspace: PathBuf) -> Self {
    Headless {
      path: workspace.join(DESIGN_FILE),
      mirror: Mutex::new(None),
    }
  }

  /// Stores the editor's document and writes it to the workspace.
  pub async fn mirror(&self, doc: &str) {
    *self.mirror.lock().await = Some(doc.to_string());
    let wrapped =
      json!({ "format": "designotron", "version": 1, "document": serde_json::from_str::<Value>(doc).unwrap_or(Value::Null), "assets": {} });
    if let Err(e) = tokio::fs::write(&self.path, serde_json::to_string_pretty(&wrapped).unwrap_or_default()).await {
      log::warn!("could not write {}: {e}", self.path.display());
    }
  }

  /// Runs a tool against the last known document without an editor.
  pub async fn call_tool(&self, name: &str, input: Value) -> Result<Value, String> {
    let mut guard = self.mirror.lock().await;
    let source = match guard.clone() {
      Some(d) => Some(d),
      None => tokio::fs::read_to_string(&self.path).await.ok().map(|t| unwrap_dtron(&t)),
    };
    // The engine is not Send, so it must not live across an await.
    let (result, saved) = run_engine(source.as_deref(), name, input)?;
    if guard.as_deref() != Some(saved.as_str()) {
      *guard = Some(saved.clone());
      drop(guard);
      self.mirror(&saved).await;
    }
    Ok(result)
  }
}

fn run_engine(source: Option<&str>, name: &str, input: Value) -> Result<(Value, String), String> {
  let mut engine = Engine::new(Box::new(HeuristicMeasurer), seed());
  if let Some(src) = source {
    engine.load(src)?;
  }
  let result = engine.dispatch(Command::Ai {
    tool: name.to_string(),
    input,
  })?;
  Ok((result, engine.to_json()))
}

/// Accepts the `.dtron` wrapper or a bare document.
fn unwrap_dtron(text: &str) -> String {
  match serde_json::from_str::<Value>(text) {
    Ok(v) if v["format"] == "designotron" => v["document"].to_string(),
    _ => text.to_string(),
  }
}

fn seed() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos() as u64)
    .unwrap_or(7)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn headless_tools_persist_to_workspace() {
    let dir = std::env::temp_dir().join(format!("dtron-test-{}", seed()));
    std::fs::create_dir_all(&dir).unwrap();
    let h = Headless::new(dir.clone());
    let r = h
      .call_tool(
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "name": "Screen", "width": 390, "height": 844 }] }),
      )
      .await
      .unwrap();
    assert!(r["created"][0]["id"].is_string());
    let text = std::fs::read_to_string(dir.join(DESIGN_FILE)).unwrap();
    assert!(text.contains("\"Screen\""));
    // A fresh headless instance reads the file back.
    let h2 = Headless::new(dir.clone());
    let doc = h2.call_tool("get_document", json!({})).await.unwrap();
    assert_eq!(doc["layers"][0]["name"], "Screen");
    assert!(h2.call_tool("get_screenshot", json!({})).await.is_err());
    std::fs::remove_dir_all(dir).ok();
  }
}
