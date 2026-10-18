//! Multiplayer: one shared room per bridge. Editors exchange node-level deltas
//! (`designotron_engine::collab`) and presence over `/collab/ws`; the bridge keeps the
//! merged document so late joiners get the current state.
//!
//! Sharing (`POST /bridge/share`) starts a second listener on the LAN that serves only
//! the editor and `/collab/ws`, behind a random token. MCP, chat and fetch stay on
//! 127.0.0.1.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use designotron_engine::model::Document;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, Mutex};

use crate::Shared;

#[derive(Default)]
pub struct Collab {
  room: Mutex<Room>,
  share: Mutex<Option<ShareInfo>>,
  next_id: AtomicU64,
}

#[derive(Default)]
struct Room {
  doc: Option<Document>,
  /// Asset id → data URL for images referenced by the shared document.
  assets: Map<String, Value>,
  peers: HashMap<u64, Peer>,
}

struct Peer {
  tx: mpsc::UnboundedSender<Message>,
  name: String,
  color: String,
  presence: Value,
}

#[derive(Clone)]
struct ShareInfo {
  token: String,
  port: u16,
}

#[derive(Deserialize)]
pub struct WsParams {
  #[serde(default)]
  token: String,
}

/// 128 random bits from the OS-seeded hasher keys, as hex.
fn random_token() -> String {
  let mut out = String::new();
  for _ in 0..2 {
    let mut h = RandomState::new().build_hasher();
    h.write_u64(std::process::id() as u64);
    out.push_str(&format!("{:016x}", h.finish()));
  }
  out
}

/// This machine's address on the local network (no packets are sent).
fn lan_ip() -> String {
  UdpSocket::bind("0.0.0.0:0")
    .and_then(|s| s.connect("8.8.8.8:80").map(|_| s))
    .and_then(|s| s.local_addr())
    .map(|a| a.ip().to_string())
    .unwrap_or_else(|_| "127.0.0.1".into())
}

/// `POST /bridge/share` starts (once) the LAN listener and returns the join link.
pub async fn start_share(State(state): State<Shared>, headers: HeaderMap) -> Response {
  if !crate::security::origin_allowed(&headers) || !crate::security::host_allowed(&headers) {
    return (StatusCode::FORBIDDEN, "forbidden").into_response();
  }
  let mut guard = state.collab.share.lock().await;
  let info = match guard.as_ref() {
    Some(i) => i.clone(),
    None => {
      let port = state.port + 1;
      let token = random_token();
      let addr = SocketAddr::from(([0, 0, 0, 0], port));
      let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("cannot listen on {addr}: {e}")).into_response(),
      };
      let app = Router::new().route("/collab/ws", get(guest_ws)).with_state(state.clone());
      let app = crate::web::mount(app, &crate::web::pick(state.static_dir.clone()));
      tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
          log::error!("share listener stopped: {e}");
        }
      });
      log::info!("sharing on http://{}:{port} (token required)", lan_ip());
      let info = ShareInfo { token, port };
      *guard = Some(info.clone());
      info
    }
  };
  let url = format!("http://{}:{}/?collab={}", lan_ip(), info.port, info.token);
  Json(json!({ "url": url, "port": info.port })).into_response()
}

/// `/collab/ws` on the main (127.0.0.1) listener: the owner's editor.
pub async fn owner_ws(ws: WebSocketUpgrade, headers: HeaderMap, State(state): State<Shared>) -> Response {
  if !crate::security::origin_allowed(&headers) {
    return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
  }
  ws.on_upgrade(move |socket| serve(socket, state))
}

/// `/collab/ws` on the share listener: requires the share token.
async fn guest_ws(ws: WebSocketUpgrade, Query(p): Query<WsParams>, State(state): State<Shared>) -> Response {
  let ok = state
    .collab
    .share
    .lock()
    .await
    .as_ref()
    .map(|s| !p.token.is_empty() && s.token == p.token)
    .unwrap_or(false);
  if !ok {
    return (StatusCode::FORBIDDEN, "invalid share link").into_response();
  }
  ws.on_upgrade(move |socket| serve(socket, state))
}

async fn broadcast(room: &Room, from: u64, msg: &Value) {
  let text = msg.to_string();
  for (id, p) in &room.peers {
    if *id != from {
      let _ = p.tx.send(Message::Text(text.clone()));
    }
  }
}

fn merge_assets(room: &mut Room, assets: Option<&Value>) {
  if let Some(a) = assets.and_then(|v| v.as_object()) {
    for (k, v) in a {
      room.assets.insert(k.clone(), v.clone());
    }
  }
}

async fn serve(socket: WebSocket, state: Shared) {
  let id = state.collab.next_id.fetch_add(1, Ordering::Relaxed) + 1;
  let (mut sink, mut stream) = socket.split();
  let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
  let writer = tokio::spawn(async move {
    while let Some(m) = rx.recv().await {
      if sink.send(m).await.is_err() {
        break;
      }
    }
  });
  let mut joined = false;
  while let Some(Ok(msg)) = stream.next().await {
    let Message::Text(text) = msg else { continue };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
    let mut room = state.collab.room.lock().await;
    match v["type"].as_str().unwrap_or("") {
      "join" => {
        let name = v["name"].as_str().unwrap_or("Guest").chars().take(40).collect::<String>();
        let color = v["color"].as_str().unwrap_or("#7C5CFF").chars().take(16).collect::<String>();
        // The first editor to join with a document (or one asking to reset) sets the room's document.
        let offered = v.get("doc").filter(|d| !d.is_null());
        let adopt = offered.is_some() && (room.doc.is_none() || v["reset"].as_bool().unwrap_or(false));
        if adopt {
          match serde_json::from_value::<Document>(offered.cloned().unwrap()) {
            Ok(d) => {
              room.doc = Some(d);
              room.assets.clear();
              merge_assets(&mut room, v.get("assets"));
            }
            Err(e) => {
              let _ = tx.send(Message::Text(
                json!({ "type": "error", "message": format!("bad document: {e}") }).to_string(),
              ));
              continue;
            }
          }
        }
        let peers: Vec<Value> = room
          .peers
          .iter()
          .map(|(pid, p)| json!({ "id": pid, "name": p.name, "color": p.color, "presence": p.presence }))
          .collect();
        let welcome = json!({
          "type": "welcome",
          "you": id,
          // Omitted when this editor's own document became the room's.
          "doc": if adopt { Value::Null } else { serde_json::to_value(&room.doc).unwrap_or(Value::Null) },
          "assets": if adopt { Value::Object(Map::new()) } else { Value::Object(room.assets.clone()) },
          "peers": peers,
        });
        let _ = tx.send(Message::Text(welcome.to_string()));
        if adopt && joined {
          // A reset replaces everyone's document.
          let reload = json!({ "type": "reload", "doc": room.doc, "assets": room.assets });
          broadcast(&room, id, &reload).await;
        }
        room.peers.insert(
          id,
          Peer {
            tx: tx.clone(),
            name: name.clone(),
            color: color.clone(),
            presence: Value::Null,
          },
        );
        broadcast(&room, id, &json!({ "type": "peer", "id": id, "name": name, "color": color })).await;
        joined = true;
      }
      "delta" if joined => {
        let Some(doc) = room.doc.as_mut() else { continue };
        if let Err(e) = designotron_engine::collab::apply(doc, &v["delta"]) {
          log::warn!("rejected collab delta: {e}");
          continue;
        }
        merge_assets(&mut room, v.get("assets"));
        // The owner's editor applies this too and mirrors it to the workspace file as usual.
        broadcast(
          &room,
          id,
          &json!({ "type": "delta", "from": id, "delta": v["delta"], "assets": v.get("assets").cloned().unwrap_or(Value::Null) }),
        )
        .await;
      }
      "presence" if joined => {
        if let Some(p) = room.peers.get_mut(&id) {
          p.presence = v["presence"].clone();
        }
        broadcast(&room, id, &json!({ "type": "presence", "id": id, "presence": v["presence"] })).await;
      }
      _ => {}
    }
  }
  let mut room = state.collab.room.lock().await;
  room.peers.remove(&id);
  broadcast(&room, id, &json!({ "type": "leave", "id": id })).await;
  drop(room);
  writer.abort();
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tokens_are_long_and_unique() {
    let (a, b) = (random_token(), random_token());
    assert_eq!(a.len(), 32);
    assert_ne!(a, b);
  }
}
