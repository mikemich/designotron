//! Multiplayer on the local network: one shared room per bridge (the room logic lives in
//! `designotron-rooms`, shared with the internet relay).
//!
//! Sharing (`POST /bridge/share`) starts a second listener on the LAN that serves only
//! the editor and `/collab/ws`, behind a random token. MCP, chat and fetch stay on
//! 127.0.0.1.

use std::net::{SocketAddr, UdpSocket};
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use designotron_rooms::{random_token, Limits, Rooms};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

use crate::Shared;

pub struct Collab {
  rooms: Arc<Rooms>,
  share: Mutex<Option<ShareInfo>>,
}

impl Default for Collab {
  fn default() -> Self {
    Collab {
      // The bridge runs on the owner's computer: memory isn't the constraint a small
      // relay host has.
      rooms: Rooms::new(
        Limits {
          max_total_bytes: usize::MAX / 2,
          ..Limits::default()
        },
        None,
      ),
      share: Mutex::new(None),
    }
  }
}

/// The bridge hosts a single room.
const LOCAL_ROOM: &str = "local-room-of-this-bridge";

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
  let rooms = state.collab.rooms.clone();
  ws.on_upgrade(move |socket| rooms.serve(socket, LOCAL_ROOM.into()))
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
  let rooms = state.collab.rooms.clone();
  ws.on_upgrade(move |socket| rooms.serve(socket, LOCAL_ROOM.into()))
}
