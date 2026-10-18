//! Comment threads: listing with resolved positions (for the canvas and for Claude).

use serde_json::{json, Value};

use crate::model::Document;

/// Threads with their page position (attached comments follow their layer).
pub fn list(doc: &Document, page: Option<&str>, include_resolved: bool) -> Value {
  let mut out = Vec::new();
  for c in doc.comments.values() {
    if page.is_some_and(|p| p != c.page) || (c.resolved && !include_resolved) {
      continue;
    }
    let attached = c.node.as_ref().and_then(|n| doc.get(n));
    let (x, y) = match (&c.node, attached) {
      (Some(n), Some(_)) => {
        let b = doc.abs_bounds(n);
        (b.x + c.x, b.y + c.y)
      }
      _ => (c.x, c.y),
    };
    out.push(json!({
      "id": c.id,
      "page": c.page,
      "x": x,
      "y": y,
      "nodeId": attached.map(|n| n.id.clone()),
      "nodeName": attached.map(|n| n.name.clone()),
      "resolved": c.resolved,
      "messages": c.messages,
    }));
  }
  out.sort_by(|a, b| {
    let t = |v: &Value| v["messages"][0]["time"].as_f64().unwrap_or(0.0);
    t(a).total_cmp(&t(b))
  });
  Value::Array(out)
}
