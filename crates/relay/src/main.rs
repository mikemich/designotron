//! `designotron-relay`: hosts multiplayer rooms on the internet so people can edit a file
//! together from anywhere. Optionally serves the editor too, so one deployment gives both
//! the link people open and the rooms behind it.
//!
//! It only relays and merges documents; it never runs Claude, MCP or any tools.
//!
//! ```text
//! designotron-relay [--port 8787] [--static web/dist] [--data ./rooms]
//! env: PORT, DESIGNOTRON_STATIC, DESIGNOTRON_DATA, DESIGNOTRON_MAX_ROOMS,
//!      DESIGNOTRON_MAX_ROOM_BYTES, DESIGNOTRON_MAX_TOTAL_BYTES,
//!      DESIGNOTRON_MAX_CONNECTIONS_PER_IP, DESIGNOTRON_MAX_NEW_ROOMS_PER_HOUR,
//!      DESIGNOTRON_TRUST_PROXY
//! ```

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use designotron_rooms::{valid_room_id, Limits, Rooms, TokenBucket};
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

/// Room for the JSON around a file in the largest message (a join that carries it).
const MESSAGE_OVERHEAD: usize = 1024 * 1024;

#[derive(Clone)]
struct App {
  rooms: Arc<Rooms>,
  clients: Arc<Clients>,
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
  clients: ClientLimits,
}

/// Limits per client address.
#[derive(Clone, Debug)]
struct ClientLimits {
  /// WebSocket connections open at once.
  max_connections: usize,
  /// Rooms that didn't exist before, per hour.
  new_rooms_per_hour: u32,
  /// Proxies in front of the relay that append to `X-Forwarded-For` (0: use the socket
  /// address). With 1 the right-most entry is the client, the one the host's proxy added;
  /// entries to its left come from the client and can be forged.
  trust_proxy: usize,
}

impl Default for ClientLimits {
  fn default() -> Self {
    ClientLimits {
      max_connections: 20,
      new_rooms_per_hour: 30,
      trust_proxy: 0,
    }
  }
}

/// Connections and new rooms per client address. IPv6 clients are grouped by /64, since
/// one host usually holds a whole /64.
struct Clients {
  limits: ClientLimits,
  by_ip: Mutex<HashMap<IpAddr, Client>>,
}

struct Client {
  connections: usize,
  new_rooms: TokenBucket,
}

/// One open connection; frees its address's slot when dropped.
struct Slot {
  clients: Arc<Clients>,
  ip: IpAddr,
}

impl Clients {
  fn new(limits: ClientLimits) -> Arc<Self> {
    Arc::new(Clients {
      limits,
      by_ip: Mutex::new(HashMap::new()),
    })
  }

  /// The address limits apply to.
  fn ip(&self, headers: &HeaderMap, peer: IpAddr) -> IpAddr {
    match forwarded_ip(headers, self.limits.trust_proxy).unwrap_or(peer) {
      IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
        Some(v4) => IpAddr::V4(v4),
        None => {
          let s = v6.segments();
          IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
      },
      v4 => v4,
    }
  }

  /// Takes a connection slot for `ip`, or None at the limit.
  fn connect(self: &Arc<Self>, ip: IpAddr) -> Option<Slot> {
    let mut by_ip = self.by_ip.lock().unwrap();
    let c = by_ip.entry(ip).or_insert_with(|| self.client());
    if c.connections >= self.limits.max_connections {
      return None;
    }
    c.connections += 1;
    Some(Slot { clients: self.clone(), ip })
  }

  /// Counts a new room for `ip`; false once it has created too many this hour.
  fn create_room(&self, ip: IpAddr) -> bool {
    let mut by_ip = self.by_ip.lock().unwrap();
    by_ip.entry(ip).or_insert_with(|| self.client()).new_rooms.try_take()
  }

  /// Forgets addresses with nothing open and their full allowance back.
  fn sweep(&self) {
    self
      .by_ip
      .lock()
      .unwrap()
      .retain(|_, c| c.connections > 0 || !c.new_rooms.is_full());
  }

  fn client(&self) -> Client {
    let per_hour = self.limits.new_rooms_per_hour as f64;
    Client {
      connections: 0,
      new_rooms: TokenBucket::new(per_hour / 3600.0, per_hour),
    }
  }
}

impl Drop for Slot {
  fn drop(&mut self) {
    if let Some(c) = self.clients.by_ip.lock().unwrap().get_mut(&self.ip) {
      c.connections = c.connections.saturating_sub(1);
    }
  }
}

fn parse_args() -> Config {
  let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
  let mut cfg = Config {
    port: env("PORT").and_then(|p| p.parse().ok()).unwrap_or(8787),
    static_dir: env("DESIGNOTRON_STATIC").map(PathBuf::from),
    data_dir: env("DESIGNOTRON_DATA").map(PathBuf::from),
    limits: Limits::default(),
    clients: ClientLimits::default(),
  };
  if let Some(n) = env("DESIGNOTRON_MAX_ROOMS").and_then(|n| n.parse().ok()) {
    cfg.limits.max_rooms = n;
  }
  if let Some(n) = env("DESIGNOTRON_MAX_ROOM_BYTES").and_then(|n| parse_bytes(&n)) {
    cfg.limits.max_room_bytes = n;
  }
  if let Some(n) = env("DESIGNOTRON_MAX_TOTAL_BYTES").and_then(|n| parse_bytes(&n)) {
    cfg.limits.max_total_bytes = n;
  }
  if let Some(n) = env("DESIGNOTRON_MAX_CONNECTIONS_PER_IP").and_then(|n| n.parse().ok()) {
    cfg.clients.max_connections = n;
  }
  if let Some(n) = env("DESIGNOTRON_MAX_NEW_ROOMS_PER_HOUR").and_then(|n| n.parse().ok()) {
    cfg.clients.new_rooms_per_hour = n;
  }
  if let Some(v) = env("DESIGNOTRON_TRUST_PROXY") {
    cfg.clients.trust_proxy = match v.to_ascii_lowercase().as_str() {
      "true" | "yes" | "on" => 1,
      n => n.parse().unwrap_or(0),
    };
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

async fn ws(
  ws: WebSocketUpgrade,
  Query(p): Query<WsParams>,
  ConnectInfo(peer): ConnectInfo<SocketAddr>,
  headers: HeaderMap,
  State(app): State<App>,
) -> Response {
  // The room id is the secret: anyone with the link can edit, nobody can guess one.
  if !valid_room_id(&p.room) {
    return (StatusCode::BAD_REQUEST, "invalid room").into_response();
  }
  let ip = app.clients.ip(&headers, peer.ip());
  let Some(slot) = app.clients.connect(ip) else {
    return (StatusCode::TOO_MANY_REQUESTS, "too many connections from your address").into_response();
  };
  if !app.rooms.known(&p.room).await && !app.clients.create_room(ip) {
    return (
      StatusCode::TOO_MANY_REQUESTS,
      "too many new rooms from your address; try again later",
    )
      .into_response();
  }
  let rooms = app.rooms.clone();
  // A message never needs to be much larger than a whole shared file.
  let max = rooms.limits().max_room_bytes + MESSAGE_OVERHEAD;
  ws.max_message_size(max).max_frame_size(max).on_upgrade(move |socket| async move {
    rooms.serve(socket, p.room).await;
    drop(slot);
  })
}

async fn health(State(app): State<App>) -> Json<serde_json::Value> {
  let s = app.rooms.stats().await;
  Json(json!({
    "relay": "designotron",
    "version": env!("CARGO_PKG_VERSION"),
    // The git commit the image was built from (set by relay-image.yml), to tell deploys apart.
    "commit": option_env!("DESIGNOTRON_COMMIT").unwrap_or("dev"),
    "editor": app.serves_editor,
    "rooms": s.rooms,
    "people": s.people,
    "memory": {
      "bytes": s.room_bytes + s.connection_bytes,
      "budget": s.budget,
      "roomBytes": s.room_bytes,
      "connectionBytes": s.connection_bytes,
    },
  }))
}

/// The client address `hops` proxies back in `X-Forwarded-For` (1: the right-most entry).
fn forwarded_ip(headers: &HeaderMap, hops: usize) -> Option<IpAddr> {
  if hops == 0 {
    return None;
  }
  let entries: Vec<&str> = headers
    .get_all("x-forwarded-for")
    .iter()
    .filter_map(|v| v.to_str().ok())
    .flat_map(|v| v.split(','))
    .map(str::trim)
    .filter(|e| !e.is_empty())
    .collect();
  let entry = entries.get(entries.len().checked_sub(hops)?)?;
  entry.parse().ok().or_else(|| entry.parse::<SocketAddr>().ok().map(|a| a.ip()))
}

/// Bytes from `"192MB"`, `"512k"`, `"1G"` or a plain number.
fn parse_bytes(s: &str) -> Option<usize> {
  let s = s.trim().to_ascii_lowercase();
  let s = s.strip_suffix("ib").or_else(|| s.strip_suffix('b')).unwrap_or(&s);
  let split = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
  let mult: usize = match s[split..].trim() {
    "" => 1,
    "k" => 1 << 10,
    "m" => 1 << 20,
    "g" => 1 << 30,
    _ => return None,
  };
  s[..split].trim().parse::<usize>().ok()?.checked_mul(mult)
}

#[tokio::main]
async fn main() {
  env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
  let cfg = parse_args();
  let rooms = Rooms::new(cfg.limits.clone(), cfg.data_dir.clone());
  let clients = Clients::new(cfg.clients.clone());
  let (maintain, sweep) = (rooms.clone(), clients.clone());
  tokio::spawn(async move {
    let mut tick = 0u32;
    loop {
      tokio::time::sleep(Duration::from_secs(3)).await;
      maintain.maintain().await;
      tick = (tick + 1) % 20;
      if tick == 0 {
        sweep.sweep();
      }
    }
  });
  let app = App {
    rooms: rooms.clone(),
    clients,
    serves_editor: cfg.static_dir.is_some(),
  };
  if let Some(d) = &cfg.static_dir {
    log::info!("serving the editor from {}", d.display());
  }
  match &cfg.data_dir {
    Some(d) => log::info!("saving rooms in {}", d.display()),
    None => log::warn!("no --data dir: rooms live in memory and are lost on restart"),
  }
  log::info!(
    "memory budget {} MB, files up to {} MB; per address: {} connections, {} new rooms an hour{}",
    cfg.limits.max_total_bytes >> 20,
    cfg.limits.max_room_bytes >> 20,
    cfg.clients.max_connections,
    cfg.clients.new_rooms_per_hour,
    if cfg.clients.trust_proxy > 0 {
      " (address from X-Forwarded-For)"
    } else {
      ""
    }
  );
  let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
  let listener = tokio::net::TcpListener::bind(addr).await.unwrap_or_else(|e| {
    log::error!("cannot listen on {addr}: {e}");
    std::process::exit(1);
  });
  log::info!("Designotron relay on http://{addr}");
  let service = router(app, cfg.static_dir).into_make_service_with_connect_info::<SocketAddr>();
  let server = axum::serve(listener, service).with_graceful_shutdown(async {
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
  use designotron_rooms::Stats;
  use futures_util::{SinkExt, StreamExt};
  use tokio::io::{AsyncReadExt, AsyncWriteExt};
  use tokio_tungstenite::tungstenite::client::IntoClientRequest;
  use tokio_tungstenite::tungstenite::{Error as WsError, Message};

  type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

  mod sharing {
    use super::*;

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
      let dir = temp_dir("restart");
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

    #[tokio::test]
    async fn health_reports_rooms_people_and_memory() {
      let (addr, _) = start(None).await;
      let mut a = connect(addr, &designotron_rooms::random_token(), None).await.unwrap();
      join(&mut a, Some(doc())).await;
      let mut tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
      tcp.write_all(b"GET /health HTTP/1.0\r\n\r\n").await.unwrap();
      let mut body = String::new();
      tcp.read_to_string(&mut body).await.unwrap();
      let h: serde_json::Value = serde_json::from_str(body.split("\r\n\r\n").nth(1).unwrap()).unwrap();
      assert_eq!(
        (h["relay"].as_str(), h["rooms"].as_u64(), h["people"].as_u64()),
        (Some("designotron"), Some(1), Some(1))
      );
      assert!(h["version"].is_string() && h["editor"] == false);
      assert!(h["memory"]["bytes"].as_u64().unwrap() > 0);
      assert_eq!(h["memory"]["budget"].as_u64(), Some(Limits::default().max_total_bytes as u64));
    }
  }

  mod memory {
    use super::*;

    #[tokio::test]
    async fn idle_rooms_are_unloaded_when_over_the_memory_budget() {
      let dir = temp_dir("budget");
      // Each join holds its message in a buffer and its file in the room (~2 × FILE).
      let (addr, rooms) = start_with(budget(FILE * 5 / 2), ClientLimits::default(), Some(dir.clone())).await;
      let (first, second) = (designotron_rooms::random_token(), designotron_rooms::random_token());
      let mut a = connect(addr, &first, None).await.unwrap();
      assert_eq!(join(&mut a, Some(big_doc("First"))).await["type"], "welcome");
      rooms.maintain().await;
      drop(a);
      wait_for(&rooms, |s| s.people == 0 && s.connection_bytes == 0).await;

      let mut b = connect(addr, &second, None).await.unwrap();
      assert_eq!(
        join(&mut b, Some(big_doc("Second"))).await["type"],
        "welcome",
        "room made by unloading the idle one"
      );
      assert_eq!(rooms.stats().await.rooms, 1);
      assert!(dir.join(format!("{first}.json")).exists(), "it was saved before it was unloaded");
      rooms.maintain().await;
      drop(b);
      wait_for(&rooms, |s| s.people == 0 && s.connection_bytes == 0).await;

      let mut c = connect(addr, &first, None).await.unwrap();
      let welcome = join(&mut c, None).await;
      assert_eq!(welcome["doc"]["name"], "First", "reloaded from disk, unloading the other");
      assert_eq!(rooms.stats().await.rooms, 1);
      let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn refuses_new_rooms_when_full_of_active_ones() {
      let (addr, rooms) = start_with(budget(FILE * 5 / 2), ClientLimits::default(), None).await;
      let first = designotron_rooms::random_token();
      let mut a = connect(addr, &first, None).await.unwrap();
      assert_eq!(join(&mut a, Some(big_doc("First"))).await["type"], "welcome");

      let mut b = connect(addr, &designotron_rooms::random_token(), None).await.unwrap();
      let refused = join(&mut b, Some(big_doc("Second"))).await;
      assert_eq!(refused["type"], "error");
      assert!(refused["message"].as_str().unwrap().contains("busy"), "{refused}");
      assert!(closes(&mut b).await, "the refused editor is disconnected");

      wait_for(&rooms, |s| s.people == 1).await;
      rooms.maintain().await;
      assert_eq!(rooms.stats().await.rooms, 1, "the active room stays, the refused one is gone");
      a.send(Message::Text(rename("Still editing"))).await.unwrap();
      let mut c = connect(addr, &first, None).await.unwrap();
      drop(a);
      wait_for(&rooms, |s| s.people == 0).await;
      assert_eq!(
        join(&mut c, None).await["doc"]["name"],
        "Still editing",
        "the active room kept working"
      );
    }

    #[tokio::test]
    async fn too_fast_senders_lose_presence_then_the_connection() {
      let limits = Limits {
        msg_rate: 20,
        msg_burst: 5,
        max_throttled: Duration::from_millis(500),
        ..Limits::default()
      };
      let (addr, _) = start_with(limits, ClientLimits::default(), None).await;
      let room = designotron_rooms::random_token();
      let mut a = connect(addr, &room, None).await.unwrap();
      join(&mut a, Some(doc())).await;
      let mut b = connect(addr, &room, None).await.unwrap();
      join(&mut b, None).await;
      assert_eq!(next_json(&mut a).await["type"], "peer");

      for i in 0..50 {
        let presence = json!({ "type": "presence", "presence": { "page": "p", "cursor": { "x": i, "y": 0 }, "selection": [] } });
        b.send(Message::Text(presence.to_string())).await.unwrap();
      }
      b.send(Message::Text(rename("After the burst"))).await.unwrap();
      let mut presence = 0;
      loop {
        let m = next_json(&mut a).await;
        if m["type"] == "delta" {
          assert_eq!(m["delta"]["name"], "After the burst", "changes are slowed down, never dropped");
          break;
        }
        presence += 1;
      }
      assert!(
        (1..=8).contains(&presence),
        "presence over the rate is dropped ({presence} of 50 relayed)"
      );

      for i in 0..300 {
        b.send(Message::Text(rename(&format!("Spam {i}")))).await.unwrap();
      }
      let error = loop {
        let m = next_json(&mut b).await;
        if m["type"] == "error" {
          break m;
        }
      };
      assert!(error["message"].as_str().unwrap().contains("faster"), "{error}");
      assert!(closes(&mut b).await, "sustained flooding disconnects");
    }
  }

  mod clients {
    use super::*;

    #[tokio::test]
    async fn connections_per_address_are_limited() {
      let limits = ClientLimits {
        max_connections: 2,
        trust_proxy: 1,
        ..ClientLimits::default()
      };
      let (addr, _) = start_with(Limits::default(), limits, None).await;
      let room = designotron_rooms::random_token();
      let first = connect(addr, &room, Some("203.0.113.7")).await.unwrap();
      let _second = connect(addr, &room, Some("203.0.113.7")).await.unwrap();
      assert_eq!(status(connect(addr, &room, Some("203.0.113.7")).await), Some(429));
      assert_eq!(
        status(connect(addr, &room, Some("198.51.100.1, 203.0.113.7")).await),
        Some(429),
        "entries a client adds to the left don't count"
      );
      assert!(connect(addr, &room, Some("203.0.113.8")).await.is_ok(), "other addresses are fine");

      drop(first);
      let mut reconnected = false;
      for _ in 0..100 {
        if connect(addr, &room, Some("203.0.113.7")).await.is_ok() {
          reconnected = true;
          break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
      }
      assert!(reconnected, "closing a connection frees its slot");
    }

    #[tokio::test]
    async fn new_rooms_per_address_are_limited() {
      let limits = ClientLimits {
        new_rooms_per_hour: 2,
        ..ClientLimits::default()
      };
      let (addr, _) = start_with(Limits::default(), limits, None).await;
      let first = designotron_rooms::random_token();
      for room in [first.clone(), designotron_rooms::random_token()] {
        let mut ws = connect(addr, &room, None).await.unwrap();
        join(&mut ws, Some(doc())).await;
      }
      let third = connect(addr, &designotron_rooms::random_token(), None).await;
      assert_eq!(status(third), Some(429));
      assert!(
        connect(addr, &first, None).await.is_ok(),
        "joining an existing room is not creating one"
      );
    }

    #[test]
    fn the_client_address_comes_from_the_trusted_proxy() {
      let mut h = HeaderMap::new();
      let peer: IpAddr = "10.0.0.1".parse().unwrap();
      h.insert("x-forwarded-for", "1.1.1.1, 2.2.2.2".parse().unwrap());
      let ip = |trust: usize, h: &HeaderMap| {
        Clients::new(ClientLimits {
          trust_proxy: trust,
          ..ClientLimits::default()
        })
        .ip(h, peer)
        .to_string()
      };
      assert_eq!(ip(0, &h), "10.0.0.1", "headers are ignored unless a proxy is trusted");
      assert_eq!(ip(1, &h), "2.2.2.2");
      assert_eq!(ip(2, &h), "1.1.1.1");
      assert_eq!(ip(3, &h), "10.0.0.1", "missing entries fall back to the socket address");
      h.insert("x-forwarded-for", "2001:db8:1:2:3:4:5:6".parse().unwrap());
      assert_eq!(ip(1, &h), "2001:db8:1:2::", "IPv6 is grouped by /64");
    }

    #[test]
    fn byte_sizes_parse_with_units() {
      assert_eq!(parse_bytes("256MB"), Some(256 << 20));
      assert_eq!(parse_bytes("512k"), Some(512 << 10));
      assert_eq!(parse_bytes("1 GiB"), Some(1 << 30));
      assert_eq!(parse_bytes("1000"), Some(1000));
      assert_eq!(parse_bytes("lots"), None);
    }
  }

  /// Size of the padding in `big_doc` files.
  const FILE: usize = 20_000;

  async fn start(data: Option<PathBuf>) -> (SocketAddr, Arc<Rooms>) {
    start_with(Limits::default(), ClientLimits::default(), data).await
  }

  async fn start_with(limits: Limits, clients: ClientLimits, data: Option<PathBuf>) -> (SocketAddr, Arc<Rooms>) {
    let rooms = Rooms::new(limits, data);
    let app = App {
      rooms: rooms.clone(),
      clients: Clients::new(clients),
      serves_editor: false,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let service = router(app, None).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, service).await.unwrap() });
    (addr, rooms)
  }

  fn budget(bytes: usize) -> Limits {
    Limits {
      max_total_bytes: bytes,
      ..Limits::default()
    }
  }

  fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dt-relay-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
  }

  async fn connect(addr: SocketAddr, room: &str, forwarded_for: Option<&str>) -> Result<Ws, WsError> {
    let mut req = format!("ws://{addr}/ws?room={room}").into_client_request().unwrap();
    if let Some(f) = forwarded_for {
      req.headers_mut().insert("x-forwarded-for", f.parse().unwrap());
    }
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws)
  }

  /// Sends a join and returns the reply.
  async fn join(ws: &mut Ws, doc: Option<serde_json::Value>) -> serde_json::Value {
    let mut msg = json!({ "type": "join", "name": "Tester" });
    if let Some(d) = doc {
      msg["doc"] = d;
    }
    ws.send(Message::Text(msg.to_string())).await.unwrap();
    next_json(ws).await
  }

  fn status(r: Result<Ws, WsError>) -> Option<u16> {
    match r {
      Err(WsError::Http(resp)) => Some(resp.status().as_u16()),
      _ => None,
    }
  }

  /// True if the server closes the connection (within a few seconds).
  async fn closes(ws: &mut Ws) -> bool {
    let wait = async {
      loop {
        match ws.next().await {
          Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return true,
          Some(Ok(_)) => {}
        }
      }
    };
    tokio::time::timeout(Duration::from_secs(5), wait).await.unwrap_or(false)
  }

  async fn wait_for(rooms: &Rooms, cond: impl Fn(&Stats) -> bool) {
    for _ in 0..200 {
      if cond(&rooms.stats().await) {
        return;
      }
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting: {:?}", rooms.stats().await);
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

  /// A file of about `FILE` bytes.
  fn big_doc(name: &str) -> serde_json::Value {
    let mut d = doc();
    d["name"] = json!(name);
    d["pages"][0]["name"] = json!("x".repeat(FILE));
    d
  }

  fn rename(name: &str) -> String {
    json!({ "type": "delta", "delta": { "name": name, "nodes": {}, "removed": [] } }).to_string()
  }
}
