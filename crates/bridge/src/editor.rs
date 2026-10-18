//! WebSocket link to the open editor. Tool calls are forwarded to the editor
//! (the live source of truth) and answered asynchronously.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::{claude, Shared};

const TOOL_TIMEOUT: Duration = Duration::from_secs(180);

/// Result of a tool executed by the editor.
#[derive(Debug, Clone)]
pub struct ToolReply {
  pub ok: bool,
  pub result: Value,
  /// Base64 PNG for screenshot tools.
  pub image: Option<String>,
}

#[derive(Default)]
pub struct EditorLink {
  sender: Mutex<Option<(u64, mpsc::UnboundedSender<Message>)>>,
  pending: Mutex<HashMap<u64, oneshot::Sender<ToolReply>>>,
  next_id: AtomicU64,
}

impl EditorLink {
  pub async fn is_connected(&self) -> bool {
    self.sender.lock().await.is_some()
  }

  pub async fn send(&self, msg: Value) -> bool {
    match self.sender.lock().await.as_ref() {
      Some((_, tx)) => tx.send(Message::Text(msg.to_string())).is_ok(),
      None => false,
    }
  }

  /// Runs a tool in the editor and waits for its reply.
  pub async fn call_tool(&self, name: &str, input: Value) -> Option<ToolReply> {
    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = oneshot::channel();
    self.pending.lock().await.insert(id, tx);
    if !self
      .send(json!({ "type": "tool_call", "id": id, "name": name, "input": input }))
      .await
    {
      self.pending.lock().await.remove(&id);
      return None;
    }
    match tokio::time::timeout(TOOL_TIMEOUT, rx).await {
      Ok(Ok(reply)) => Some(reply),
      _ => {
        self.pending.lock().await.remove(&id);
        Some(ToolReply {
          ok: false,
          result: json!("the editor did not answer in time"),
          image: None,
        })
      }
    }
  }

  async fn resolve(&self, id: u64, reply: ToolReply) {
    if let Some(tx) = self.pending.lock().await.remove(&id) {
      let _ = tx.send(reply);
    }
  }
}

pub async fn ws_handler(ws: WebSocketUpgrade, headers: HeaderMap, State(state): State<Shared>) -> Response {
  if !crate::security::origin_allowed(&headers) {
    log::warn!("rejected editor websocket from origin {:?}", headers.get("origin"));
    return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
  }
  ws.on_upgrade(move |socket| serve(socket, state))
}

async fn serve(socket: WebSocket, state: Shared) {
  let (mut sink, mut stream) = socket.split();
  let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
  let conn_id = state.editor.next_id.fetch_add(1, Ordering::Relaxed) + 1;
  // The newest editor tab wins.
  *state.editor.sender.lock().await = Some((conn_id, tx.clone()));
  log::info!("editor connected");

  let writer = tokio::spawn(async move {
    while let Some(msg) = rx.recv().await {
      if sink.send(msg).await.is_err() {
        break;
      }
    }
  });

  let welcome = json!({
    "type": "welcome",
    "claude": { "available": state.claude.version.is_some(), "version": state.claude.version },
    "workspace": state.workspace,
    "mcp": format!("http://127.0.0.1:{}/mcp", state.port),
  });
  let _ = tx.send(Message::Text(welcome.to_string()));
  let _ = tx.send(Message::Text(state.preview.status(&state.workspace).await.to_string()));

  while let Some(Ok(msg)) = stream.next().await {
    let Message::Text(text) = msg else { continue };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
    match v["type"].as_str().unwrap_or("") {
      "tool_result" => {
        let id = v["id"].as_u64().unwrap_or(0);
        let image = v["image"]["data"].as_str().map(String::from);
        state
          .editor
          .resolve(
            id,
            ToolReply {
              ok: v["ok"].as_bool().unwrap_or(false),
              result: v["result"].clone(),
              image,
            },
          )
          .await;
      }
      "doc" => {
        if let Some(doc) = v["doc"].as_str() {
          state.headless.mirror(doc).await;
        }
      }
      "chat" => {
        let mut prompt = v["prompt"].as_str().unwrap_or("").to_string();
        let session = v["sessionId"].as_str().map(String::from);
        let mut images = Vec::new();
        if let Some(list) = v["attachments"].as_array().filter(|l| !l.is_empty()) {
          // Claude sees the images directly; the saved copies are for code it writes (e.g.
          // building a screenshot as a page) or tools that take a file.
          images = crate::fetch::chat_images(list);
          let paths = crate::fetch::save_attachments(&state.workspace, list);
          if !paths.is_empty() {
            let names: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
            prompt.push_str(&format!("\n\nThe attached image(s) are also saved at:\n{}", names.join("\n")));
          }
        }
        let turn = v["turn"].as_u64().unwrap_or(0);
        let st = state.clone();
        tokio::spawn(async move { claude::run_chat(st, prompt, session, images, turn).await });
      }
      "chat_cancel" => state.chat.cancel().await,
      "preview_start" => {
        tokio::spawn(crate::preview::start(state.clone()));
      }
      "preview_stop" => {
        tokio::spawn(crate::preview::stop(state.clone()));
      }
      "write_project" => {
        let files = v["files"].as_array().cloned().unwrap_or_default();
        let binaries = v["binaries"].as_array().cloned().unwrap_or_default();
        let reply = match crate::preview::write_project(&state.workspace, &files, &binaries) {
          Ok(n) => json!({ "type": "project_written", "ok": true, "written": n, "dir": state.workspace.join(crate::preview::APP_DIR) }),
          Err(e) => json!({ "type": "project_written", "ok": false, "error": e }),
        };
        let _ = tx.send(Message::Text(reply.to_string()));
        let _ = tx.send(Message::Text(state.preview.status(&state.workspace).await.to_string()));
      }
      "hello" => {}
      other => log::debug!("unknown editor message {other}"),
    }
  }

  let mut guard = state.editor.sender.lock().await;
  if guard.as_ref().map(|(id, _)| *id == conn_id).unwrap_or(false) {
    *guard = None;
  }
  drop(guard);
  writer.abort();
  log::info!("editor disconnected");
}
