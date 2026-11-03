//! WebSocket link to the open editor. Tool calls are forwarded to the editor
//! (the live source of truth) and answered asynchronously.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

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

/// Which editor tab a tool call is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
  /// The tab the person last focused (terminal Claude Code, plugins, tests).
  Active,
  /// The tab whose chat started the call; never rerouted.
  Conn(u64),
}

/// The open editor tabs and the tool calls waiting on them. One std mutex covers both, so a
/// call can't be registered against a tab that has just gone (it is never held across an
/// `.await`).
#[derive(Default)]
pub struct EditorLink {
  inner: StdMutex<Inner>,
  next_id: AtomicU64,
}

#[derive(Default)]
struct Inner {
  conns: HashMap<u64, Conn>,
  pending: HashMap<u64, Pending>,
  /// Last number handed out for `Conn::focus`.
  focus_seq: u64,
}

struct Conn {
  tx: mpsc::UnboundedSender<Message>,
  /// When the tab last reported focus (0 = never; such tabs rank by connection order).
  focus: u64,
}

struct Pending {
  conn: u64,
  tx: oneshot::Sender<ToolReply>,
}

impl EditorLink {
  /// Adds a tab. Returns its id.
  pub fn connect(&self, tx: mpsc::UnboundedSender<Message>) -> u64 {
    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    self.lock().conns.insert(id, Conn { tx, focus: 0 });
    id
  }

  /// Removes a tab and fails what it still owed. Returns the tab that is active now.
  pub fn disconnect(&self, conn: u64) -> Option<u64> {
    let mut g = self.lock();
    g.conns.remove(&conn);
    let owed: Vec<u64> = g.pending.iter().filter(|(_, p)| p.conn == conn).map(|(id, _)| *id).collect();
    for id in owed {
      if let Some(p) = g.pending.remove(&id) {
        let _ = p.tx.send(closed_reply());
      }
    }
    g.active()
  }

  /// The tab reports that the person is looking at it: it becomes the active one.
  pub fn focus(&self, conn: u64) {
    let mut g = self.lock();
    g.focus_seq += 1;
    let seq = g.focus_seq;
    if let Some(c) = g.conns.get_mut(&conn) {
      c.focus = seq;
    }
  }

  pub fn active(&self) -> Option<u64> {
    self.lock().active()
  }

  pub async fn is_connected(&self) -> bool {
    !self.lock().conns.is_empty()
  }

  /// Sends to the active tab.
  pub async fn send(&self, msg: Value) -> bool {
    let g = self.lock();
    match g.active().and_then(|id| g.conns.get(&id)) {
      Some(c) => c.tx.send(Message::Text(msg.to_string())).is_ok(),
      None => false,
    }
  }

  /// Sends to one tab (false when it is gone).
  pub fn send_to(&self, conn: u64, msg: Value) -> bool {
    match self.lock().conns.get(&conn) {
      Some(c) => c.tx.send(Message::Text(msg.to_string())).is_ok(),
      None => false,
    }
  }

  /// Runs a tool in a tab and waits for its reply. `None` means no tab is open (the caller
  /// falls back to headless); a call for one particular tab never falls back, because the
  /// design it was meant for is that tab's. `group` names the chat turn the call belongs to
  /// (the tab makes the turn one undo step).
  pub async fn call_tool(&self, target: Target, name: &str, input: Value, group: Option<&str>) -> Option<ToolReply> {
    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = oneshot::channel();
    {
      let mut g = self.lock();
      let conn = match target {
        Target::Active => g.active()?,
        Target::Conn(c) => c,
      };
      let msg = json!({ "type": "tool_call", "id": id, "name": name, "input": input, "group": group });
      let sent = g.conns.get(&conn).map(|c| c.tx.send(Message::Text(msg.to_string())).is_ok());
      match (sent, target) {
        (Some(true), _) => {
          g.pending.insert(id, Pending { conn, tx });
        }
        (_, Target::Active) => return None,
        (_, Target::Conn(_)) => {
          return Some(ToolReply {
            ok: false,
            result: json!("the editor tab that started this chat was closed"),
            image: None,
          })
        }
      }
    }
    match tokio::time::timeout(TOOL_TIMEOUT, rx).await {
      Ok(Ok(reply)) => Some(reply),
      Ok(Err(_)) => Some(closed_reply()),
      Err(_) => {
        self.lock().pending.remove(&id);
        Some(ToolReply {
          ok: false,
          result: json!("the editor did not answer in time"),
          image: None,
        })
      }
    }
  }

  fn resolve(&self, id: u64, reply: ToolReply) {
    if let Some(p) = self.lock().pending.remove(&id) {
      let _ = p.tx.send(reply);
    }
  }

  fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
    self.inner.lock().unwrap_or_else(|e| e.into_inner())
  }
}

impl Inner {
  /// The tab focused most recently; with no focus reports, the newest.
  fn active(&self) -> Option<u64> {
    self.conns.iter().max_by_key(|(id, c)| (c.focus, **id)).map(|(id, _)| *id)
  }
}

fn closed_reply() -> ToolReply {
  ToolReply {
    ok: false,
    result: json!("the editor tab was closed before it answered"),
    image: None,
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
  // Tabs send {"type":"focus"} when the person looks at them; until one does, the newest
  // tab is the active one.
  let conn_id = state.editor.connect(tx.clone());
  log::info!("editor tab {conn_id} connected");

  let writer = tokio::spawn(async move {
    while let Some(msg) = rx.recv().await {
      if sink.send(msg).await.is_err() {
        break;
      }
    }
  });

  let welcome = json!({
    "type": "welcome",
    "conn": conn_id,
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
        state.editor.resolve(
          id,
          ToolReply {
            ok: v["ok"].as_bool().unwrap_or(false),
            result: v["result"].clone(),
            image,
          },
        );
      }
      "focus" => state.editor.focus(conn_id),
      "doc" => {
        // Only the tab the person is working in feeds the headless copy and the file.
        if let Some(doc) = v["doc"].as_str().filter(|_| state.editor.active() == Some(conn_id)) {
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
        tokio::spawn(async move { claude::run_chat(st, conn_id, prompt, session, images, turn).await });
      }
      "chat_cancel" => state.chat.cancel(conn_id).await,
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

  // The tab's chat has nobody to talk to any more; the tab that takes over sends its document.
  state.chat.cancel(conn_id).await;
  let was_active = state.editor.active() == Some(conn_id);
  let next = state.editor.disconnect(conn_id);
  if let Some(next) = next.filter(|_| was_active) {
    state.editor.send_to(next, json!({ "type": "send_doc" }));
  }
  writer.abort();
  log::info!("editor tab {conn_id} disconnected");
}

#[cfg(test)]
mod tests {
  use super::*;

  type Inbox = mpsc::UnboundedReceiver<Message>;

  fn tab(link: &EditorLink) -> (u64, Inbox) {
    let (tx, rx) = mpsc::unbounded_channel();
    (link.connect(tx), rx)
  }

  fn inbox(rx: &mut Inbox) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(Message::Text(t)) = rx.try_recv() {
      out.push(serde_json::from_str(&t).unwrap());
    }
    out
  }

  #[tokio::test]
  async fn a_call_for_a_tab_reaches_only_that_tab() {
    let link = std::sync::Arc::new(EditorLink::default());
    let (a, mut ra) = tab(&link);
    let (b, mut rb) = tab(&link);
    assert_eq!(link.active(), Some(b), "with no focus reports the newest tab is active");
    let l = link.clone();
    let call = tokio::spawn(async move { l.call_tool(Target::Conn(a), "get_document", json!({}), Some("chat-1-1")).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(inbox(&mut rb).is_empty());
    let got = inbox(&mut ra);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["name"], "get_document");
    assert_eq!(got[0]["group"], "chat-1-1");
    link.resolve(
      got[0]["id"].as_u64().unwrap(),
      ToolReply {
        ok: true,
        result: json!("fine"),
        image: None,
      },
    );
    assert!(call.await.unwrap().unwrap().ok);
  }

  #[tokio::test]
  async fn a_call_without_a_tab_goes_to_the_focused_one() {
    let link = std::sync::Arc::new(EditorLink::default());
    let (a, mut ra) = tab(&link);
    let (_b, mut rb) = tab(&link);
    link.focus(a);
    assert_eq!(link.active(), Some(a));
    let l = link.clone();
    tokio::spawn(async move { l.call_tool(Target::Active, "x", json!({}), None).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(inbox(&mut ra).len(), 1);
    assert!(inbox(&mut rb).is_empty());
    assert!(link.send_to(a, json!({ "type": "log" })));
    assert!(!link.send_to(999, json!({})));
  }

  #[tokio::test]
  async fn closing_a_tab_fails_its_pending_call_at_once() {
    let link = std::sync::Arc::new(EditorLink::default());
    let (a, _ra) = tab(&link);
    let (b, mut rb) = tab(&link);
    let l = link.clone();
    let call = tokio::spawn(async move { l.call_tool(Target::Conn(a), "get_screenshot", json!({}), None).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let started = std::time::Instant::now();
    link.disconnect(a);
    let reply = call.await.unwrap().unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(!reply.ok);
    assert!(reply.result.as_str().unwrap().contains("closed"));
    // The other tab is untouched, and a call aimed at the closed tab fails rather than
    // landing in it.
    assert!(inbox(&mut rb).is_empty());
    let late = link.call_tool(Target::Conn(a), "x", json!({}), None).await.unwrap();
    assert!(!late.ok && late.result.as_str().unwrap().contains("closed"));
    assert!(inbox(&mut rb).is_empty());
    assert_eq!(link.active(), Some(b));
  }

  #[tokio::test]
  async fn the_other_tab_takes_over_when_the_active_one_goes() {
    let link = EditorLink::default();
    assert!(
      link.call_tool(Target::Active, "x", json!({}), None).await.is_none(),
      "no tab: headless"
    );
    let (a, _ra) = tab(&link);
    let (b, _rb) = tab(&link);
    link.focus(a);
    assert_eq!(link.disconnect(a), Some(b));
    assert_eq!(link.disconnect(b), None);
    assert!(!link.is_connected().await);
  }

  #[tokio::test]
  async fn closing_the_newest_tab_leaves_the_rest_connected() {
    let link = EditorLink::default();
    let (a, _ra) = tab(&link);
    let (b, _rb) = tab(&link);
    assert_eq!(link.disconnect(b), Some(a));
    assert!(link.is_connected().await);
    assert!(link.send(json!({ "type": "log" })).await);
  }
}
