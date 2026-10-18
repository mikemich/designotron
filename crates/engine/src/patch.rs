//! JSON merge-patching of nodes. This gives the UI, AI tools and the bridge
//! one generic way to edit any property without bespoke commands.

use serde_json::{Map, Value};

use crate::model::Node;

/// Structural fields that only dedicated commands may change.
pub const PROTECTED: &[&str] = &["id", "type", "parent", "children", "page", "masterId", "instance"];

/// RFC 7386 style merge: objects merge recursively, `null` deletes, everything else replaces.
pub fn merge(target: &mut Value, patch: &Value) {
  match (target, patch) {
    (Value::Object(t), Value::Object(p)) => {
      for (k, v) in p {
        if v.is_null() {
          t.insert(k.clone(), Value::Null);
        } else {
          match t.get_mut(k) {
            Some(existing) if existing.is_object() && v.is_object() => merge(existing, v),
            _ => {
              t.insert(k.clone(), v.clone());
            }
          }
        }
      }
    }
    (t, p) => *t = p.clone(),
  }
}

/// Drops protected keys from a patch.
pub fn sanitize(patch: &Value) -> Value {
  match patch {
    Value::Object(m) => {
      let mut out = Map::new();
      for (k, v) in m {
        if !PROTECTED.contains(&k.as_str()) {
          out.insert(k.clone(), v.clone());
        }
      }
      Value::Object(out)
    }
    _ => Value::Object(Map::new()),
  }
}

/// Applies a sanitized merge patch to a node.
pub fn apply(node: &mut Node, patch: &Value) -> Result<(), String> {
  let clean = sanitize(patch);
  let mut v = serde_json::to_value(&*node).map_err(|e| e.to_string())?;
  merge(&mut v, &clean);
  let mut updated: Node = serde_json::from_value(v).map_err(|e| format!("invalid property value: {e}"))?;
  // Structural fields never change through a patch.
  updated.id = node.id.clone();
  updated.kind = node.kind;
  updated.parent = node.parent.clone();
  updated.children = node.children.clone();
  updated.page = node.page.clone();
  updated.master_id = node.master_id.clone();
  updated.instance = node.instance.clone();
  *node = updated;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn patch_merges_nested_and_protects() {
    let mut n = Node {
      id: "a".into(),
      ..Default::default()
    };
    apply(&mut n, &json!({"x": 5, "id": "evil", "text": {"characters": "hi"}})).unwrap();
    assert_eq!(n.x, 5.0);
    assert_eq!(n.id, "a");
    assert_eq!(n.text.as_ref().unwrap().characters, "hi");
    assert_eq!(n.text.as_ref().unwrap().font_size, 16.0);
    apply(&mut n, &json!({"text": {"fontSize": 24}})).unwrap();
    assert_eq!(n.text.as_ref().unwrap().characters, "hi");
    assert!(apply(&mut n, &json!({"x": "wide"})).is_err());
  }
}
