//! `designotron-relay`: hosts multiplayer rooms on the internet so people can edit a file
//! together from anywhere. Optionally serves the editor too, so one deployment gives both
//! the link people open and the rooms behind it.
//!
//! It only relays and merges documents; it never runs Claude, MCP or any tools.
//!
//! ```text
//! designotron-relay [--port 8787] [--static web/dist] [--data ./rooms]
//! env: PORT, DESIGNOTRON_STATIC, DESIGNOTRON_DATA, DESIGNOTRON_MAX_ROOMS
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use designotron_rooms::{valid_room_id, Limits, Rooms};
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

/// Largest single WebSocket message (a whole file with images when someone starts sharing).
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
struct App {
  rooms: Arc<Rooms>,
  serves_editor: bool,
}

#[derive(Deserialize)]
struct WsParams {
  #[serde(default)]
  room: String,
}

struct Config {
  port: u16,
  static_dir: Option<PathBuf>,
  data_dir: Option<PathBuf>,
  limits: Limits,
}

fn parse_args() -> Config {
  let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
  let mut cfg = Config {
    port: env("PORT").and_then(|p| p.parse().ok()).unwrap_or(8787),
    static_dir: env("DESIGNOTRON_STATIC").map(PathBuf::from),
    data_dir: env("DESIGNOTRON_DATA").map(PathBuf::from),
    limits: Limits::default(),
  };
  if let Some(n) = env("DESIGNOTRON_MAX_ROOMS").and_then(|n| n.parse().ok()) {
    cfg.limits.max_rooms = n;
  }
  let mut args = std::env::args().skip(1);
  while let Some(a) = args.next() {
    match a.as_str() {
      "--port" => cfg.port = args.next().and_then(|p| p.parse().ok()).unwrap_or(cfg.port),
      "--static" => cfg.static_dir = args.next().map(PathBuf::from),
      "--data" => cfg.data_dir = args.next().map(PathBuf::from),
      "-h" | "--help" => {
        log::info!("usage: designotron-relay [--port 8787] [--static web/dist] [--data ./rooms]");
        std::process::exit(0);
      }
      other => log::warn!("ignoring unknown argument {other}"),
    }
  }
  if cfg.static_dir.is_none() && PathBuf::from("web/dist/index.html").exists() {
    cfg.static_dir = Some(PathBuf::from("web/dist"));
  }
  cfg
}

/// Builds the router (separate from `main` so tests can run it).
fn router(app: App, static_dir: Option<PathBuf>) -> Router {
  let api = Router::new()
    .route("/ws", get(ws))
    .route("/health", get(health))
    // The editor may be hosted elsewhere (e.g. GitHub Pages); health is read cross-origin.
    .layer(CorsLayer::permissive())
    .with_state(app);
  match static_dir {
    Some(dir) => {
      let index = dir.join("index.html");
      api.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
    }
    None => api.fallback(|| async { "Designotron relay. Open a shared link in the Designotron editor." }),
  }
}

async fn ws(ws: WebSocketUpgrade, Query(p): Query<WsParams>, State(app): State<App>) -> Response {
  // The room id is the secret: anyone with the link can edit, nobody can guess one.
  if !valid_room_id(&p.room) {
    return (StatusCode::BAD_REQUEST, "invalid room").into_response();
  }
  let rooms = app.rooms.clone();
  ws.max_message_size(MAX_MESSAGE_BYTES)
    .max_frame_size(MAX_MESSAGE_BYTES)
    .on_upgrade(move |socket| rooms.serve(socket, p.room))
}

async fn health(State(app): State<App>) -> Json<serde_json::Value> {
  let (rooms, people) = app.rooms.stats().await;
  Json(
    json!({ "relay": "designotron", "version": env!("CARGO_PKG_VERSION"), "editor": app.serves_editor, "rooms": rooms, "people": people }),
  )
}

#[tokio::main]
async fn main() {
  env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
  let cfg = parse_args();
  let rooms = Rooms::new(cfg.limits.clone(), cfg.data_dir.clone());
  let maintain = rooms.clone();
  tokio::spawn(async move {
    loop {
      tokio::time::sleep(Duration::from_secs(3)).await;
      maintain.maintain().await;
    }
  });
  let app = App {
    rooms: rooms.clone(),
    serves_editor: cfg.static_dir.is_some(),
  };
  if let Some(d) = &cfg.static_dir {
    log::info!("serving the editor from {}", d.display());
  }
  match &cfg.data_dir {
    Some(d) => log::info!("saving rooms in {}", d.display()),
    None => log::warn!("no --data dir: rooms live in memory and are lost on restart"),
  }
  let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
  let listener = tokio::net::TcpListener::bind(addr).await.unwrap_or_else(|e| {
    log::error!("cannot listen on {addr}: {e}");
    std::process::exit(1);
  });
  log::info!("Designotron relay on http://{addr}");
  let server = axum::serve(listener, router(app, cfg.static_dir)).with_graceful_shutdown(async {
    let _ = tokio::signal::ctrl_c().await;
  });
  if let Err(e) = server.await {
    log::error!("server error: {e}");
  }
  // Save everything before exiting (redeploys).
  rooms.maintain().await;
}

#[cfg(test)]
mod tests {
  use super::*;
  use futures_util::{SinkExt, StreamExt};
  use tokio_tungstenite::tungstenite::Message;

  async fn start(data: Option<PathBuf>) -> (SocketAddr, Arc<Rooms>) {
    let rooms = Rooms::new(Limits::default(), data);
    let app = App {
      rooms: rooms.clone(),
      serves_editor: false,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router(app, None)).await.unwrap() });
    (addr, rooms)
  }

  async fn next_json(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
  ) -> serde_json::Value {
    loop {
      if let Message::Text(t) = ws.next().await.unwrap().unwrap() {
        return serde_json::from_str(&t).unwrap();
      }
    }
  }

  fn doc() -> serde_json::Value {
    json!({ "id": "d", "name": "Shared", "pages": [{ "id": "p", "name": "Page 1", "children": [] }], "nodes": {} })
  }

  #[tokio::test]
  async fn two_people_share_a_room_and_late_joiners_get_the_file() {
    let (addr, _) = start(None).await;
    let room = designotron_rooms::random_token();
    let url = format!("ws://{addr}/ws?room={room}");
    let (mut a, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    a.send(Message::Text(
      json!({ "type": "join", "name": "Ana", "doc": doc(), "reset": true }).to_string(),
    ))
    .await
    .unwrap();
    assert!(next_json(&mut a).await["doc"].is_null(), "Ana's file becomes the room's");

    let (mut b, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    b.send(Message::Text(json!({ "type": "join", "name": "Ben" }).to_string()))
      .await
      .unwrap();
    let welcome = next_json(&mut b).await;
    assert_eq!(welcome["doc"]["name"], "Shared");
    assert_eq!(welcome["peers"][0]["name"], "Ana");
    assert_eq!(next_json(&mut a).await["type"], "peer");

    b.send(Message::Text(
      json!({ "type": "delta", "delta": { "name": "Renamed by Ben", "nodes": {}, "removed": [] } }).to_string(),
    ))
    .await
    .unwrap();
    let d = next_json(&mut a).await;
    assert_eq!(
      (d["type"].as_str(), d["delta"]["name"].as_str()),
      (Some("delta"), Some("Renamed by Ben"))
    );

    let (mut c, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    c.send(Message::Text(json!({ "type": "join", "name": "Cy" }).to_string()))
      .await
      .unwrap();
    assert_eq!(
      next_json(&mut c).await["doc"]["name"],
      "Renamed by Ben",
      "late joiner gets the merged file"
    );
  }

  #[tokio::test]
  async fn rooms_survive_a_restart_with_a_data_dir() {
    let dir = std::env::temp_dir().join(format!("dt-relay-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let room = designotron_rooms::random_token();
    {
      let (addr, rooms) = start(Some(dir.clone())).await;
      let (mut a, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?room={room}"))
        .await
        .unwrap();
      a.send(Message::Text(json!({ "type": "join", "name": "Ana", "doc": doc() }).to_string()))
        .await
        .unwrap();
      next_json(&mut a).await;
      rooms.maintain().await;
    }
    let (addr, _) = start(Some(dir.clone())).await;
    let (mut b, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?room={room}"))
      .await
      .unwrap();
    b.send(Message::Text(json!({ "type": "join", "name": "Ben" }).to_string()))
      .await
      .unwrap();
    assert_eq!(next_json(&mut b).await["doc"]["name"], "Shared");
    let _ = std::fs::remove_dir_all(dir);
  }

  #[tokio::test]
  async fn rejects_bad_room_ids() {
    let (addr, _) = start(None).await;
    assert!(tokio_tungstenite::connect_async(format!("ws://{addr}/ws?room=abc")).await.is_err());
  }
}
