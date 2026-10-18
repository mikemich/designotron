//! Multiplayer rooms. Editors exchange node-level document deltas
//! (`designotron_engine::collab`) and presence over a WebSocket; a room keeps the merged
//! document so late joiners get the current state.
//!
//! Used by the local bridge (one room, LAN sharing) and by `designotron-relay` (many
//! rooms on the internet, addressed by an unguessable room id).
//!
//! Protocol (JSON text frames):
//! - client → `{type:"join", name, color, doc?, assets?, reset?}`; the first join with a
//!   document (or one with `reset`) sets the room's document.
//! - server → `{type:"welcome", you, doc|null, assets, peers}`
//! - client ↔ `{type:"delta", delta, assets?}`, `{type:"presence", presence}`
//! - server → `{type:"peer"|"leave"|"reload"|"error", …}`

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use designotron_engine::model::Document;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, Mutex};

/// Server-wide limits.
#[derive(Clone, Debug)]
pub struct Limits {
  /// Most rooms held at once (new room ids are refused beyond this).
  pub max_rooms: usize,
  /// Most people in one room.
  pub max_peers: usize,
  /// Largest document + assets a room accepts, in bytes of JSON.
  pub max_room_bytes: usize,
  /// Rooms nobody has joined for this long are dropped (and their saved copy deleted).
  pub idle_ttl: Duration,
}

impl Default for Limits {
  fn default() -> Self {
    Limits {
      max_rooms: 1000,
      max_peers: 50,
      max_room_bytes: 50 * 1024 * 1024,
      idle_ttl: Duration::from_secs(7 * 24 * 3600),
    }
  }
}

#[derive(Default)]
struct Room {
  doc: Option<Document>,
  /// Asset id → data URL for images referenced by the shared document.
  assets: Map<String, Value>,
  peers: HashMap<u64, Peer>,
  last_active: Option<Instant>,
  /// Changed since it was last saved to disk.
  dirty: bool,
  loaded: bool,
}

struct Peer {
  tx: mpsc::UnboundedSender<Message>,
  name: String,
  color: String,
  presence: Value,
}

/// A set of rooms, optionally saved to a directory so they survive restarts.
pub struct Rooms {
  rooms: Mutex<HashMap<String, Arc<Mutex<Room>>>>,
  next_id: AtomicU64,
  limits: Limits,
  data_dir: Option<PathBuf>,
}

/// True for room ids the relay accepts: 16–64 characters of `[A-Za-z0-9_-]`.
pub fn valid_room_id(id: &str) -> bool {
  (16..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 128 random bits from the OS-seeded hasher keys, as hex.
pub fn random_token() -> String {
  let mut out = String::new();
  for _ in 0..2 {
    let mut h = RandomState::new().build_hasher();
    h.write_u64(std::process::id() as u64);
    out.push_str(&format!("{:016x}", h.finish()));
  }
  out
}

impl Rooms {
  pub fn new(limits: Limits, data_dir: Option<PathBuf>) -> Arc<Self> {
    if let Some(d) = &data_dir {
      if let Err(e) = std::fs::create_dir_all(d) {
        log::error!("cannot create data dir {}: {e}", d.display());
      }
    }
    Arc::new(Rooms {
      rooms: Mutex::new(HashMap::new()),
      next_id: AtomicU64::new(0),
      limits,
      data_dir,
    })
  }

  /// Number of rooms in memory and people connected (for health checks).
  pub async fn stats(&self) -> (usize, usize) {
    let rooms: Vec<Arc<Mutex<Room>>> = self.rooms.lock().await.values().cloned().collect();
    let mut peers = 0;
    for r in rooms {
      peers += r.lock().await.peers.len();
    }
    (self.rooms.lock().await.len(), peers)
  }

  fn file(&self, id: &str) -> Option<PathBuf> {
    self.data_dir.as_ref().map(|d| d.join(format!("{id}.json")))
  }

  async fn room(&self, id: &str) -> Result<Arc<Mutex<Room>>, String> {
    let mut rooms = self.rooms.lock().await;
    if let Some(r) = rooms.get(id) {
      return Ok(r.clone());
    }
    if rooms.len() >= self.limits.max_rooms {
      return Err("this server is full; try again later".into());
    }
    let r = Arc::new(Mutex::new(Room::default()));
    rooms.insert(id.to_string(), r.clone());
    Ok(r)
  }

  /// Loads a saved room from disk the first time it is used.
  async fn ensure_loaded(&self, id: &str, room: &mut Room) {
    if room.loaded {
      return;
    }
    room.loaded = true;
    let Some(path) = self.file(id) else { return };
    let Ok(text) = tokio::fs::read_to_string(&path).await else { return };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return };
    if let Ok(doc) = serde_json::from_value::<Document>(v["doc"].clone()) {
      room.doc = Some(doc);
      room.assets = v["assets"].as_object().cloned().unwrap_or_default();
    }
  }

  /// Saves changed rooms and drops idle ones. Call periodically.
  pub async fn maintain(&self) {
    let entries: Vec<(String, Arc<Mutex<Room>>)> = self.rooms.lock().await.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut drop_ids = Vec::new();
    for (id, room) in entries {
      let mut r = room.lock().await;
      if r.dirty {
        if let (Some(path), Some(doc)) = (self.file(&id), r.doc.as_ref()) {
          let body = json!({ "doc": doc, "assets": r.assets }).to_string();
          let tmp = path.with_extension("json.tmp");
          if tokio::fs::write(&tmp, body).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &path).await;
          }
        }
        r.dirty = false;
      }
      if r.peers.is_empty() {
        let idle = r.last_active.map(|t| t.elapsed()).unwrap_or_default();
        // Without a data dir, empty rooms only live in memory: keep them for an hour.
        let ttl = if self.data_dir.is_some() {
          self.limits.idle_ttl
        } else {
          self.limits.idle_ttl.min(Duration::from_secs(3600))
        };
        if idle > ttl {
          drop_ids.push(id.clone());
          if let Some(path) = self.file(&id) {
            let _ = tokio::fs::remove_file(path).await;
          }
        } else if self.data_dir.is_some() && !r.dirty && idle > Duration::from_secs(300) {
          // Saved and quiet: free the memory; it reloads on the next join.
          drop_ids.push(id.clone());
        }
      }
    }
    let mut rooms = self.rooms.lock().await;
    for id in drop_ids {
      rooms.remove(&id);
    }
  }

  /// Serves one editor connection in room `room_id` until it disconnects.
  pub async fn serve(self: Arc<Self>, socket: WebSocket, room_id: String) {
    let (mut sink, mut stream) = socket.split();
    let room = match self.room(&room_id).await {
      Ok(r) => r,
      Err(e) => {
        let _ = sink.send(Message::Text(json!({ "type": "error", "message": e }).to_string())).await;
        return;
      }
    };
    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
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
      let size = text.len();
      let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
      let mut r = room.lock().await;
      self.ensure_loaded(&room_id, &mut r).await;
      r.last_active = Some(Instant::now());
      match v["type"].as_str().unwrap_or("") {
        "join" if !joined => {
          if r.peers.len() >= self.limits.max_peers {
            let _ = tx.send(Message::Text(
              json!({ "type": "error", "message": "this file already has the maximum number of people" }).to_string(),
            ));
            break;
          }
          if size > self.limits.max_room_bytes {
            let _ = tx.send(Message::Text(
              json!({ "type": "error", "message": "this file is too large to share" }).to_string(),
            ));
            break;
          }
          let name = v["name"].as_str().unwrap_or("Guest").chars().take(40).collect::<String>();
          let color = v["color"].as_str().unwrap_or("#7C5CFF").chars().take(16).collect::<String>();
          let offered = v.get("doc").filter(|d| !d.is_null());
          let adopt = offered.is_some() && (r.doc.is_none() || v["reset"].as_bool().unwrap_or(false));
          if adopt {
            match serde_json::from_value::<Document>(offered.cloned().unwrap()) {
              Ok(d) => {
                r.doc = Some(d);
                r.assets.clear();
                merge_assets(&mut r, v.get("assets"));
                r.dirty = true;
              }
              Err(e) => {
                let _ = tx.send(Message::Text(
                  json!({ "type": "error", "message": format!("bad document: {e}") }).to_string(),
                ));
                continue;
              }
            }
          }
          let peers: Vec<Value> = r
            .peers
            .iter()
            .map(|(pid, p)| json!({ "id": pid, "name": p.name, "color": p.color, "presence": p.presence }))
            .collect();
          let welcome = json!({
            "type": "welcome",
            "you": id,
            // Omitted when this editor's own document became the room's.
            "doc": if adopt { Value::Null } else { serde_json::to_value(&r.doc).unwrap_or(Value::Null) },
            "assets": if adopt { Value::Object(Map::new()) } else { Value::Object(r.assets.clone()) },
            "peers": peers,
          });
          let _ = tx.send(Message::Text(welcome.to_string()));
          if adopt && !r.peers.is_empty() {
            // A reset replaces everyone's document.
            broadcast(&r, id, &json!({ "type": "reload", "doc": r.doc, "assets": r.assets }));
          }
          r.peers.insert(
            id,
            Peer {
              tx: tx.clone(),
              name: name.clone(),
              color: color.clone(),
              presence: Value::Null,
            },
          );
          broadcast(&r, id, &json!({ "type": "peer", "id": id, "name": name, "color": color }));
          joined = true;
        }
        "delta" if joined => {
          let Some(doc) = r.doc.as_mut() else { continue };
          if let Err(e) = designotron_engine::collab::apply(doc, &v["delta"]) {
            log::warn!("rejected collab delta: {e}");
            continue;
          }
          merge_assets(&mut r, v.get("assets"));
          r.dirty = true;
          broadcast(
            &r,
            id,
            &json!({ "type": "delta", "from": id, "delta": v["delta"], "assets": v.get("assets").cloned().unwrap_or(Value::Null) }),
          );
        }
        "presence" if joined => {
          if let Some(p) = r.peers.get_mut(&id) {
            p.presence = v["presence"].clone();
          }
          broadcast(&r, id, &json!({ "type": "presence", "id": id, "presence": v["presence"] }));
        }
        _ => {}
      }
    }
    let mut r = room.lock().await;
    r.peers.remove(&id);
    r.last_active = Some(Instant::now());
    broadcast(&r, id, &json!({ "type": "leave", "id": id }));
    drop(r);
    writer.abort();
  }
}

fn broadcast(room: &Room, from: u64, msg: &Value) {
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn room_ids_must_be_unguessable_and_safe() {
    assert!(valid_room_id(&random_token()));
    assert!(!valid_room_id("short"));
    assert!(!valid_room_id("../../../../etc/passwd-aaaaaaaa"));
    assert!(!valid_room_id(&"a".repeat(65)));
  }

  #[test]
  fn tokens_are_long_and_unique() {
    let (a, b) = (random_token(), random_token());
    assert_eq!(a.len(), 32);
    assert_ne!(a, b);
  }
}
