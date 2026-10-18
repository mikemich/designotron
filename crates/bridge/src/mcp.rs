//! Minimal MCP server (Streamable HTTP, JSON responses, stateless) exposing
//! the Designotron tools to Claude Code and other MCP clients.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use designotron_engine::ai;
use serde_json::{json, Value};

use crate::Shared;

const SUPPORTED_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

pub async fn handle(State(state): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
  if !crate::security::host_allowed(&headers) || !crate::security::origin_allowed(&headers) {
    return (StatusCode::FORBIDDEN, "forbidden").into_response();
  }
  let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
    return Json(rpc_error(Value::Null, -32700, "parse error")).into_response();
  };
  match msg {
    Value::Array(batch) => {
      let mut out = Vec::new();
      for m in batch {
        if let Some(r) = dispatch(&state, m).await {
          out.push(r);
        }
      }
      if out.is_empty() {
        StatusCode::ACCEPTED.into_response()
      } else {
        Json(Value::Array(out)).into_response()
      }
    }
    m => match dispatch(&state, m).await {
      Some(r) => Json(r).into_response(),
      None => StatusCode::ACCEPTED.into_response(),
    },
  }
}

/// The server never opens a standalone SSE stream.
pub async fn reject_get() -> Response {
  StatusCode::METHOD_NOT_ALLOWED.into_response()
}

pub async fn end_session() -> Response {
  StatusCode::OK.into_response()
}

/// Handles one JSON-RPC message. Notifications return `None`.
async fn dispatch(state: &Shared, msg: Value) -> Option<Value> {
  let id = msg.get("id").cloned();
  let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
  let params = msg.get("params").cloned().unwrap_or(Value::Null);
  let id = id?;
  let result = match method {
    "initialize" => {
      let requested = params["protocolVersion"].as_str().unwrap_or(SUPPORTED_VERSIONS[0]);
      let version = if SUPPORTED_VERSIONS.contains(&requested) { requested } else { SUPPORTED_VERSIONS[0] };
      Ok(json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "designotron", "version": env!("CARGO_PKG_VERSION") },
        "instructions": instructions(state),
      }))
    }
    "ping" => Ok(json!({})),
    "tools/list" => Ok(json!({ "tools": tool_list() })),
    "tools/call" => Ok(call_tool(state, &params).await),
    "resources/list" => Ok(json!({ "resources": [] })),
    "prompts/list" => Ok(json!({ "prompts": [] })),
    other => Err(format!("method not found: {other}")),
  };
  Some(match result {
    Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
    Err(e) => rpc_error(id, -32601, &e),
  })
}

fn instructions(state: &Shared) -> String {
  format!(
    "{} The live design is in the Designotron editor; changes appear there immediately. When no editor tab is open, tools operate on {}. \
     Write application code in the working directory, not in the design.",
    ai::SYSTEM_PROMPT,
    state.workspace.join(crate::headless::DESIGN_FILE).display()
  )
}

fn tool_list() -> Vec<Value> {
  ai::tool_defs()
    .as_array()
    .cloned()
    .unwrap_or_default()
    .into_iter()
    .map(|t| json!({ "name": t["name"], "description": t["description"], "inputSchema": t["input_schema"] }))
    .collect()
}

async fn call_tool(state: &Shared, params: &Value) -> Value {
  let name = params["name"].as_str().unwrap_or("").to_string();
  let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
  if let Some(reply) = state.editor.call_tool(&name, args.clone()).await {
    let text = match &reply.result {
      Value::String(s) => s.clone(),
      other => other.to_string(),
    };
    let mut content = Vec::new();
    if let Some(img) = reply.image {
      content.push(json!({ "type": "image", "data": img, "mimeType": "image/png" }));
    }
    content.push(json!({ "type": "text", "text": text }));
    return json!({ "content": content, "isError": !reply.ok });
  }
  // No editor open: run against the workspace design file.
  match state.headless.call_tool(&name, args).await {
    Ok(v) => json!({ "content": [{ "type": "text", "text": v.to_string() }], "isError": false }),
    Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
  }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
  json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tool_list_uses_mcp_field_names() {
    let tools = tool_list();
    assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object"));
    assert!(tools.iter().any(|t| t["name"] == "create_nodes"));
  }
}
