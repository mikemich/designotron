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
//! - client → `{type:"join", …, granular:true}` when the editor can read pages, styles and
//!   variables as per-id changes (see `collab::delta`).
//! - server → `{type:"welcome", you, doc|null, assets, peers, ordered:true, granular:true}`
//!   (`granular`: this room takes per-id changes; editors that sent none get the whole lists
//!   instead, taken from the room's document)
//! - client ↔ `{type:"delta", delta, assets?}`, `{type:"presence", presence}`
//! - server → `{type:"ack", rejected?}` to the sender of each delta, at its place in the
//!   order the room applied changes (`ordered`): editors keep their own unacknowledged
//!   changes on top of everything acknowledged, so all of them converge on the room's
//!   document even when people edit the same layer at once.
//! - server → `{type:"peer"|"leave"|"reload"|"error", …}`; errors carry a `message` the
//!   editor shows as is.
//! - client → `{type:"name", name}` renames this person; others get `{type:"rename", id, name}`.
//! - client → `{type:"ping"}` (any time, joined or not); the server answers `{type:"pong"}`. Editors
//!   send one every few seconds, so a connection that went silent (a dropped network keeps the
//!   socket "open" for minutes) is noticed and replaced.
//! - When the person who shared the file stops sharing (presence `{owner:true, ended:true}`),
//!   the room remembers it: later joins without `reset` get `{type:"ended", name}` and are
//!   disconnected, instead of rejoining a room nobody shares any more.
//!
//! Memory: rooms and connections are counted in approximate bytes of JSON (a room's
//! document + images; a connection's WebSocket buffers, which keep the capacity of the
//! largest message they carried, plus what is queued for it). Past `max_total_bytes`,
//! rooms nobody is connected to are unloaded (least recently active first, only once
//! saved when there is a data dir), and joins that would need more memory are refused.
//! Rooms with people in them are never dropped.

use std::borrow::Cow;
use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use designotron_engine::model::Document;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, Mutex, Notify};

/// The answer to a client's `{type:"ping"}`.
const PONG: &str = r#"{"type":"pong"}"#;
/// Shown when the relay has no memory to spare for another file or person.
pub const BUSY: &str = "This relay is busy right now; try again in a minute.";
/// A peer with this much queued for it that it hasn't read yet is disconnected (it
/// reconnects and gets the current file) instead of buffering without bound.
const PEER_BACKLOG: usize = 16 * 1024 * 1024;
/// Presence is skipped for peers with this much still queued.
const PRESENCE_BACKLOG: usize = 256 * 1024;
/// Largest presence (cursor + selection) kept and relayed.
const MAX_PRESENCE_BYTES: usize = 16 * 1024;
/// How often a room's document size may be recomputed when a change nears the limit.
const REMEASURE_EVERY: Duration = Duration::from_secs(10);

/// Server-wide limits.
#[derive(Clone, Debug)]
pub struct Limits {
  /// Most rooms held at once (new room ids are refused beyond this).
  pub max_rooms: usize,
  /// Most people in one room.
  pub max_peers: usize,
  /// Largest document + assets a room accepts, in bytes of JSON.
  pub max_room_bytes: usize,
  /// Memory budget for all rooms and connections, in approximate bytes (see the module
  /// docs). Active rooms may edge past it; new rooms and joins wait until there is room.
  pub max_total_bytes: usize,
  /// Rooms nobody has joined for this long are dropped (and their saved copy deleted).
  pub idle_ttl: Duration,
  /// Messages per second one connection may send, sustained.
  pub msg_rate: u32,
  /// Messages one connection may send at once before `msg_rate` applies.
  pub msg_burst: u32,
  /// A connection over `msg_rate` for this long without a pause is disconnected. Until
  /// then its presence is dropped and its other messages are slowed down, never lost.
  pub max_throttled: Duration,
}

impl Default for Limits {
  fn default() -> Self {
    Limits {
      max_rooms: 1000,
      max_peers: 50,
      max_room_bytes: 50 * 1024 * 1024,
      // Sized for a 512 MB host: tracked bytes undercount parsed documents and transient
      // copies, so leave the other half as headroom.
      max_total_bytes: 192 * 1024 * 1024,
      idle_ttl: Duration::from_secs(7 * 24 * 3600),
      // An editor sends a delta per animation frame while dragging (60–120/s) plus
      // presence at up to 25/s.
      msg_rate: 100,
      msg_burst: 300,
      max_throttled: Duration::from_secs(30),
    }
  }
}

/// Snapshot for health checks.
#[derive(Clone, Debug, Default)]
pub struct Stats {
  /// Rooms in memory.
  pub rooms: usize,
  /// People connected (joined) across all rooms.
  pub people: usize,
  /// Approximate bytes held by rooms (documents + images).
  pub room_bytes: usize,
  /// Approximate bytes held by connections (buffers + queued messages).
  pub connection_bytes: usize,
  /// `Limits::max_total_bytes`.
  pub budget: usize,
}

/// Token bucket: refills `rate` tokens a second up to `burst`; starts full.
#[derive(Clone, Debug)]
pub struct TokenBucket {
  rate: f64,
  burst: f64,
  tokens: f64,
  last: Instant,
}

/// A set of rooms, optionally saved to a directory so they survive restarts.
pub struct Rooms {
  rooms: Mutex<HashMap<String, Arc<Mutex<Room>>>>,
  next_id: AtomicU64,
  limits: Limits,
  data_dir: Option<PathBuf>,
  /// Sum of every room's `bytes()`.
  room_bytes: AtomicUsize,
  /// Sum of every connection's `Meter`.
  conn_bytes: Arc<AtomicUsize>,
  people: AtomicUsize,
  /// Rooms whose owner stopped sharing (id → owner's name), oldest first, bounded.
  ended: std::sync::Mutex<(HashMap<String, String>, std::collections::VecDeque<String>)>,
}

/// How many ended rooms are remembered.
const MAX_ENDED: usize = 10_000;

#[derive(Default)]
struct Room {
  /// The connection that shared this file (joined with `reset`), when known.
  owner: Option<u64>,
  doc: Option<Document>,
  /// Asset id → data URL for images referenced by the shared document.
  assets: Map<String, Value>,
  peers: HashMap<u64, Peer>,
  last_active: Option<Instant>,
  /// Changed since it was last saved to disk.
  dirty: bool,
  loaded: bool,
  /// Estimated JSON size of `doc`: exact when measured, then grown by each delta's size.
  doc_bytes: usize,
  /// Exact JSON size of `assets`.
  asset_bytes: usize,
  /// `doc_bytes` when it was last measured, and when.
  measured: (usize, Option<Instant>),
}

struct Peer {
  out: Outbox,
  name: String,
  color: String,
  presence: Value,
  /// Reads per-id changes of pages, styles and variables.
  granular: bool,
}

/// The sending half of one connection.
#[derive(Clone)]
struct Outbox {
  tx: mpsc::UnboundedSender<Arc<String>>,
  meter: Arc<Meter>,
  /// Tells the connection to disconnect (it fell too far behind).
  kick: Arc<Notify>,
}

/// Approximate memory one connection holds: its read and write buffers keep the capacity
/// of the largest message they carried, plus messages queued and not yet written.
struct Meter {
  total: Arc<AtomicUsize>,
  read_peak: AtomicUsize,
  write_peak: AtomicUsize,
  queued: AtomicUsize,
}

/// One incoming message; large parts stay unparsed until they are needed.
#[derive(Deserialize)]
struct Incoming<'a> {
  #[serde(rename = "type", borrow, default)]
  kind: Cow<'a, str>,
  #[serde(borrow, default)]
  name: Option<Cow<'a, str>>,
  #[serde(borrow, default)]
  color: Option<Cow<'a, str>>,
  #[serde(borrow, default)]
  doc: Option<&'a RawValue>,
  #[serde(borrow, default)]
  assets: Option<&'a RawValue>,
  #[serde(default)]
  reset: bool,
  #[serde(default)]
  granular: bool,
  #[serde(borrow, default)]
  delta: Option<&'a RawValue>,
  #[serde(borrow, default)]
  presence: Option<&'a RawValue>,
}

#[derive(Serialize)]
struct Welcome<'a> {
  #[serde(rename = "type")]
  kind: &'static str,
  you: u64,
  doc: Option<&'a Document>,
  assets: &'a Map<String, Value>,
  peers: Vec<PeerInfo<'a>>,
  /// Deltas are acknowledged in order (see the protocol above).
  ordered: bool,
  /// Pages, styles and variables may travel as per-id changes (see the protocol above).
  granular: bool,
}

#[derive(Serialize)]
struct PeerInfo<'a> {
  id: u64,
  name: &'a str,
  color: &'a str,
  presence: &'a Value,
}

#[derive(Serialize)]
struct Reload<'a> {
  #[serde(rename = "type")]
  kind: &'static str,
  doc: &'a Option<Document>,
  assets: &'a Map<String, Value>,
}

#[derive(Serialize)]
struct DeltaOut<'a> {
  #[serde(rename = "type")]
  kind: &'static str,
  from: u64,
  delta: &'a RawValue,
  assets: Option<&'a RawValue>,
}

#[derive(Serialize)]
struct PresenceOut<'a> {
  #[serde(rename = "type")]
  kind: &'static str,
  id: u64,
  presence: &'a RawValue,
}

/// A room's file on disk.
#[derive(Serialize)]
struct Saved<'a> {
  doc: &'a Document,
  assets: &'a Map<String, Value>,
}

/// What a message handler wants done with the connection.
enum Step {
  Go,
  /// Tell the editor, keep the connection.
  Warn(String),
  /// Tell the editor and disconnect.
  Close(String),
  /// Disconnect (the handler already told the editor why).
  Leave,
}

/// Outcome of pacing one incoming message.
enum Pace {
  Go,
  Skip,
  Abuse,
}

/// Message pacing for one connection.
struct Pacer {
  bucket: TokenBucket,
  /// Since when it has been sending faster than allowed, without a pause.
  over_since: Option<Instant>,
  max_over: Duration,
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

impl TokenBucket {
  pub fn new(rate: f64, burst: f64) -> Self {
    TokenBucket {
      rate,
      burst,
      tokens: burst,
      last: Instant::now(),
    }
  }

  /// Takes a token if one is available.
  pub fn try_take(&mut self) -> bool {
    self.refill();
    if self.tokens >= 1.0 {
      self.tokens -= 1.0;
      true
    } else {
      false
    }
  }

  /// Takes a token even if that leaves the bucket in debt; returns how long to wait
  /// until the debt is paid back.
  pub fn take_owed(&mut self) -> Duration {
    self.refill();
    self.tokens -= 1.0;
    if self.tokens >= 0.0 || self.rate <= 0.0 {
      Duration::ZERO
    } else {
      Duration::from_secs_f64(-self.tokens / self.rate)
    }
  }

  /// True once the bucket has refilled completely (its state no longer matters).
  pub fn is_full(&mut self) -> bool {
    self.refill();
    self.tokens >= self.burst
  }

  fn refill(&mut self) {
    let now = Instant::now();
    let elapsed = now.duration_since(self.last).as_secs_f64();
    self.tokens = (self.tokens + elapsed * self.rate).min(self.burst);
    self.last = now;
  }
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
      room_bytes: AtomicUsize::new(0),
      conn_bytes: Arc::new(AtomicUsize::new(0)),
      people: AtomicUsize::new(0),
      ended: Default::default(),
    })
  }

  /// The owner's name when the room's owner stopped sharing.
  fn ended_by(&self, id: &str) -> Option<String> {
    self.ended.lock().ok()?.0.get(id).cloned()
  }

  fn set_ended(&self, id: &str, owner: Option<String>) {
    let Ok(mut e) = self.ended.lock() else { return };
    match owner {
      Some(name) => {
        if e.0.insert(id.to_string(), name).is_none() {
          e.1.push_back(id.to_string());
          while e.1.len() > MAX_ENDED {
            if let Some(old) = e.1.pop_front() {
              e.0.remove(&old);
            }
          }
        }
      }
      None => {
        if e.0.remove(id).is_some() {
          e.1.retain(|x| x != id);
        }
      }
    }
  }

  pub fn limits(&self) -> &Limits {
    &self.limits
  }

  /// Rooms, people and memory (for health checks).
  pub async fn stats(&self) -> Stats {
    Stats {
      rooms: self.rooms.lock().await.len(),
      people: self.people.load(Ordering::Relaxed),
      room_bytes: self.room_bytes.load(Ordering::Relaxed),
      connection_bytes: self.conn_bytes.load(Ordering::Relaxed),
      budget: self.limits.max_total_bytes,
    }
  }

  /// True if room `id` is in memory or saved on disk (joining it creates nothing new).
  pub async fn known(&self, id: &str) -> bool {
    if self.rooms.lock().await.contains_key(id) {
      return true;
    }
    match self.file(id) {
      Some(path) => tokio::fs::metadata(path).await.is_ok(),
      None => false,
    }
  }

  /// Saves changed rooms, drops idle ones and unloads idle rooms while over the memory
  /// budget. Call periodically.
  pub async fn maintain(&self) {
    let entries: Vec<(String, Arc<Mutex<Room>>)> = self.rooms.lock().await.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (id, room) in entries {
      let mut r = room.lock().await;
      if r.dirty {
        if let (Some(path), Some(doc)) = (self.file(&id), r.doc.as_ref()) {
          let body = serde_json::to_vec(&Saved { doc, assets: &r.assets }).unwrap_or_default();
          let doc_bytes = body.len().saturating_sub(r.asset_bytes);
          let tmp = path.with_extension("json.tmp");
          if tokio::fs::write(&tmp, body).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &path).await;
          }
          self.measured(&mut r, doc_bytes);
        }
        r.dirty = false;
      }
      let (measured, _) = r.measured;
      if r.doc_bytes > measured + (1024 * 1024).max(measured / 4) {
        // Deltas mostly replace layers, so the estimate drifts upwards.
        let exact = r.doc.as_ref().map(json_size).unwrap_or(0);
        self.measured(&mut r, exact);
      }
    }
    let mut deleted = Vec::new();
    {
      let mut rooms = self.rooms.lock().await;
      let now = Instant::now();
      rooms.retain(|id, room| {
        // Only the map holds it: nobody is connected, and nobody can connect meanwhile.
        if Arc::strong_count(room) > 1 {
          return true;
        }
        let Ok(r) = room.try_lock() else { return true };
        let idle = r.last_active.map(|t| now.duration_since(t)).unwrap_or_default();
        // Without a data dir, empty rooms only live in memory: keep them for an hour.
        let ttl = if self.data_dir.is_some() {
          self.limits.idle_ttl
        } else {
          self.limits.idle_ttl.min(Duration::from_secs(3600))
        };
        let keep = if r.doc.is_none() {
          // Nothing to keep (a connection that never joined, or a room that was refused).
          false
        } else if idle > ttl {
          deleted.push(id.clone());
          false
        } else {
          // Saved and quiet: free the memory; it reloads on the next join.
          !(self.data_dir.is_some() && !r.dirty && idle > Duration::from_secs(300))
        };
        if !keep {
          self.room_bytes.fetch_sub(r.bytes(), Ordering::Relaxed);
        }
        keep
      });
      self.evict_idle(&mut rooms, 0);
    }
    for id in deleted {
      if let Some(path) = self.file(&id) {
        let _ = tokio::fs::remove_file(path).await;
      }
    }
  }

  /// Serves one editor connection in room `room_id` until it disconnects.
  pub async fn serve(self: Arc<Self>, socket: WebSocket, room_id: String) {
    let (mut sink, mut stream) = socket.split();
    let room = match self.room(&room_id).await {
      Ok(r) => r,
      Err(e) => {
        let _ = sink.send(Message::Text(error_json(&e))).await;
        let _ = sink.close().await;
        return;
      }
    };
    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let meter = Arc::new(Meter::new(self.conn_bytes.clone()));
    let (tx, mut rx) = mpsc::unbounded_channel::<Arc<String>>();
    let out = Outbox {
      tx,
      meter: meter.clone(),
      kick: Arc::new(Notify::new()),
    };
    let mut writer = tokio::spawn(async move {
      while let Some(text) = rx.recv().await {
        let len = text.len();
        // Broadcasts share one string; the last peer to send it doesn't copy it.
        let text = Arc::try_unwrap(text).unwrap_or_else(|t| (*t).clone());
        let ok = sink.send(Message::Text(text)).await.is_ok();
        meter.sent(len);
        if !ok {
          return;
        }
      }
      let _ = sink.close().await;
    });
    let mut pacer = Pacer {
      bucket: TokenBucket::new(self.limits.msg_rate as f64, self.limits.msg_burst.max(1) as f64),
      over_since: None,
      max_over: self.limits.max_throttled,
    };
    let mut joined = false;
    loop {
      let msg = tokio::select! {
        m = stream.next() => m,
        _ = out.kick.notified() => {
          out.send(error_json("Your connection couldn't keep up with this file; reconnecting…"));
          break;
        }
      };
      let text = match msg {
        Some(Ok(Message::Text(t))) => t,
        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
        Some(Ok(_)) => {
          // Pings and binary frames: nothing to do, but they still count.
          if let Pace::Abuse = pacer.admit(false).await {
            break;
          }
          continue;
        }
      };
      let size = text.len();
      out.meter.read(size);
      let parsed = serde_json::from_str::<Incoming>(&text);
      let droppable = matches!(&parsed, Ok(m) if m.kind == "presence");
      match pacer.admit(droppable).await {
        Pace::Go => {}
        Pace::Skip => continue,
        Pace::Abuse => {
          out.send(error_json(
            "You're sending changes faster than this relay allows, so it disconnected you.",
          ));
          break;
        }
      }
      let Ok(m) = parsed else { continue };
      let mut r = room.lock().await;
      r.last_active = Some(Instant::now());
      let step = match m.kind.as_ref() {
        "join" if !joined => {
          let step = self.join(&room_id, &mut r, id, &out, &m, size).await;
          joined = r.peers.contains_key(&id);
          step
        }
        "ping" => {
          out.send(PONG.to_string());
          Step::Go
        }
        "delta" if joined => self.delta(&mut r, id, &m, size),
        "name" if joined => {
          let name = m.name.as_deref().unwrap_or("").trim().chars().take(40).collect::<String>();
          if let (false, Some(peer)) = (name.is_empty(), r.peers.get_mut(&id)) {
            peer.name = name.clone();
            self.broadcast(&r, id, &json!({ "type": "rename", "id": id, "name": name }), false);
          }
          Step::Go
        }
        "presence" if joined => {
          if let Some(p) = m.presence.filter(|p| p.get().len() <= MAX_PRESENCE_BYTES) {
            let presence: Value = serde_json::from_str(p.get()).unwrap_or(Value::Null);
            // The person who shared the file stopped sharing: later joins are told so.
            // Without a known owner (e.g. after a restart), whoever says they own it.
            let owner_ok = r.owner.map_or(presence["owner"] == true, |o| o == id);
            if presence["ended"] == true && owner_ok {
              let name = r.peers.get(&id).map(|p| p.name.clone()).unwrap_or_default();
              self.set_ended(&room_id, Some(name));
            }
            if let Some(peer) = r.peers.get_mut(&id) {
              peer.presence = presence;
            }
            self.broadcast(
              &r,
              id,
              &PresenceOut {
                kind: "presence",
                id,
                presence: p,
              },
              true,
            );
          }
          Step::Go
        }
        _ => Step::Go,
      };
      drop(r);
      match step {
        Step::Go => {}
        Step::Warn(e) => out.send(error_json(&e)),
        Step::Close(e) => {
          out.send(error_json(&e));
          break;
        }
        Step::Leave => break,
      }
    }
    let mut r = room.lock().await;
    if r.peers.remove(&id).is_some() {
      self.people.fetch_sub(1, Ordering::Relaxed);
      self.broadcast(&r, id, &json!({ "type": "leave", "id": id }), false);
    }
    r.last_active = Some(Instant::now());
    drop(r);
    // Let the writer deliver a final error, but not wait on a peer that stopped reading.
    drop(out);
    if tokio::time::timeout(Duration::from_secs(2), &mut writer).await.is_err() {
      writer.abort();
    }
  }

  fn file(&self, id: &str) -> Option<PathBuf> {
    self.data_dir.as_ref().map(|d| d.join(format!("{id}.json")))
  }

  /// Bytes held by rooms and connections.
  fn used(&self) -> usize {
    self.room_bytes.load(Ordering::Relaxed) + self.conn_bytes.load(Ordering::Relaxed)
  }

  /// Past this, peers that fall behind are disconnected instead of buffered.
  fn ceiling(&self) -> usize {
    self.limits.max_total_bytes.saturating_add(self.limits.max_total_bytes / 2)
  }

  async fn room(&self, id: &str) -> Result<Arc<Mutex<Room>>, String> {
    let mut rooms = self.rooms.lock().await;
    if let Some(r) = rooms.get(id) {
      return Ok(r.clone());
    }
    if rooms.len() >= self.limits.max_rooms && !self.evict_one(&mut rooms) {
      return Err(BUSY.into());
    }
    let r = Arc::new(Mutex::new(Room::default()));
    rooms.insert(id.to_string(), r.clone());
    Ok(r)
  }

  async fn join(&self, room_id: &str, r: &mut Room, id: u64, out: &Outbox, m: &Incoming<'_>, size: usize) -> Step {
    if r.peers.len() >= self.limits.max_peers {
      return Step::Close(format!(
        "This file already has the maximum number of people ({}).",
        self.limits.max_peers
      ));
    }
    if !r.loaded {
      // A saved room loads from disk the first time someone joins it.
      let saved = match self.file(room_id) {
        Some(path) => tokio::fs::metadata(&path).await.map(|m| m.len() as usize).unwrap_or(0),
        None => 0,
      };
      if !self.reserve(saved).await {
        return Step::Close(BUSY.into());
      }
      self.load(room_id, r).await;
    }
    let name = m.name.as_deref().unwrap_or("Guest").chars().take(40).collect::<String>();
    let color = m.color.as_deref().unwrap_or("#7C5CFF").chars().take(16).collect::<String>();
    if m.reset && m.doc.is_some() {
      // Shared (again) on purpose: this connection owns the room.
      self.set_ended(room_id, None);
      r.owner = Some(id);
    } else if let Some(owner) = self.ended_by(room_id) {
      out.send(json!({ "type": "ended", "name": owner }).to_string());
      return Step::Leave;
    }
    let adopt = m.doc.is_some() && (r.doc.is_none() || m.reset);
    if adopt {
      if size > self.limits.max_room_bytes {
        return Step::Close(self.too_large());
      }
      if !self.reserve(size.saturating_sub(r.bytes())).await {
        return Step::Close(BUSY.into());
      }
      let doc_raw = m.doc.map(|d| d.get()).unwrap_or("null");
      let assets = match m.assets.map(|a| serde_json::from_str::<Map<String, Value>>(a.get())) {
        Some(Ok(a)) => a,
        Some(Err(_)) | None => Map::new(),
      };
      match serde_json::from_str::<Document>(doc_raw) {
        Ok(d) => {
          r.doc = Some(d);
          r.assets = assets;
          let asset_bytes = assets_size(&r.assets);
          self.set_bytes(r, doc_raw.len(), asset_bytes);
          r.measured = (doc_raw.len(), Some(Instant::now()));
          r.dirty = true;
        }
        Err(e) => return Step::Warn(format!("This file couldn't be shared: {e}")),
      }
    } else if !self.reserve(r.bytes()).await {
      // The welcome carries the whole file.
      return Step::Close(BUSY.into());
    }
    let none = Map::new();
    let welcome = Welcome {
      kind: "welcome",
      you: id,
      // Omitted when this editor's own document became the room's.
      doc: if adopt { None } else { r.doc.as_ref() },
      assets: if adopt { &none } else { &r.assets },
      peers: r
        .peers
        .iter()
        .map(|(pid, p)| PeerInfo {
          id: *pid,
          name: &p.name,
          color: &p.color,
          presence: &p.presence,
        })
        .collect(),
      ordered: true,
      granular: true,
    };
    out.send(serde_json::to_string(&welcome).unwrap_or_default());
    if adopt && !r.peers.is_empty() {
      // A reset replaces everyone's document.
      let reload = Reload {
        kind: "reload",
        doc: &r.doc,
        assets: &r.assets,
      };
      self.broadcast(r, id, &reload, false);
    }
    r.peers.insert(
      id,
      Peer {
        out: out.clone(),
        name: name.clone(),
        color: color.clone(),
        presence: Value::Null,
        granular: m.granular,
      },
    );
    self.people.fetch_add(1, Ordering::Relaxed);
    self.broadcast(r, id, &json!({ "type": "peer", "id": id, "name": name, "color": color }), false);
    Step::Go
  }

  fn delta(&self, r: &mut Room, id: u64, m: &Incoming<'_>, size: usize) -> Step {
    let Some(raw) = m.delta else {
      return Step::Go;
    };
    if r.doc.is_none() {
      self.ack(r, id, true);
      return Step::Go;
    }
    let assets = m
      .assets
      .and_then(|a| serde_json::from_str::<Map<String, Value>>(a.get()).ok())
      .filter(|a| !a.is_empty());
    let new_asset_bytes = assets.as_ref().map(assets_size).unwrap_or(0);
    // Upper bound: most deltas replace layers rather than add them.
    let growth = size.saturating_sub(new_asset_bytes);
    let max = self.limits.max_room_bytes;
    if r.doc_bytes + growth + r.asset_bytes > max {
      let recent = r.measured.1.is_some_and(|t| t.elapsed() < REMEASURE_EVERY);
      if r.doc_bytes > r.measured.0 && !recent {
        let exact = r.doc.as_ref().map(json_size).unwrap_or(0);
        self.measured(r, exact);
      }
      if r.doc_bytes + growth + r.asset_bytes > max {
        // Not applied: reconnecting gives this editor the room's file again.
        self.ack(r, id, true);
        return Step::Close(format!("{} Your latest change wasn't shared.", self.too_large()));
      }
    }
    let Ok(delta) = serde_json::from_str::<Value>(raw.get()) else {
      self.ack(r, id, true);
      return Step::Go;
    };
    if let Err(e) = designotron_engine::collab::apply(r.doc.as_mut().unwrap(), &delta) {
      log::warn!("rejected collab delta: {e}");
      self.ack(r, id, true);
      return Step::Go;
    }
    let (doc_bytes, asset_bytes) = (r.doc_bytes + growth, r.asset_bytes);
    self.set_bytes(r, doc_bytes, asset_bytes);
    // Images are optional for the document to stay consistent: over the limit, peers get
    // the change without them.
    let keep = assets.is_some() && r.bytes() + new_asset_bytes <= max;
    if let (true, Some(a)) = (keep, assets.as_ref()) {
      self.put_assets(r, a);
    }
    r.dirty = true;
    let out = DeltaOut {
      kind: "delta",
      from: id,
      delta: raw,
      assets: if keep { m.assets } else { None },
    };
    let older = r.peers.iter().any(|(pid, p)| *pid != id && !p.granular);
    let whole = older
      .then(|| designotron_engine::collab::legacy(&delta, r.doc.as_ref().unwrap()))
      .flatten()
      .and_then(|w| serde_json::value::to_raw_value(&w).ok());
    match &whole {
      // Peers that predate per-id changes get the room's whole lists instead.
      Some(whole) => {
        let old = DeltaOut { delta: whole, ..out };
        let (new, old) = (
          Arc::new(serde_json::to_string(&out).unwrap_or_default()),
          Arc::new(serde_json::to_string(&old).unwrap_or_default()),
        );
        for (_, p) in r.peers.iter().filter(|(pid, _)| **pid != id) {
          self.deliver(&p.out, if p.granular { &new } else { &old }, false);
        }
      }
      None => self.broadcast(r, id, &out, false),
    }
    self.ack(r, id, false);
    if assets.is_some() && !keep {
      return Step::Warn(format!(
        "Images in this change would make the shared file larger than {} MB, so others won't see them.",
        max / (1024 * 1024)
      ));
    }
    Step::Go
  }

  fn too_large(&self) -> String {
    format!(
      "This file is too large to share online (the limit is {} MB, images included).",
      self.limits.max_room_bytes / (1024 * 1024)
    )
  }

  /// Loads a saved room from disk.
  async fn load(&self, id: &str, room: &mut Room) {
    room.loaded = true;
    let Some(path) = self.file(id) else { return };
    let Ok(text) = tokio::fs::read_to_string(&path).await else { return };
    #[derive(Deserialize)]
    struct File<'a> {
      #[serde(borrow)]
      doc: &'a RawValue,
      #[serde(default)]
      assets: Map<String, Value>,
    }
    let Ok(f) = serde_json::from_str::<File>(&text) else { return };
    if let Ok(doc) = serde_json::from_str::<Document>(f.doc.get()) {
      room.doc = Some(doc);
      room.assets = f.assets;
      let asset_bytes = assets_size(&room.assets);
      self.set_bytes(room, f.doc.get().len(), asset_bytes);
      room.measured = (f.doc.get().len(), Some(Instant::now()));
    }
  }

  /// Makes room for `extra` more bytes, unloading idle rooms if needed. False if the
  /// budget is still exceeded.
  async fn reserve(&self, extra: usize) -> bool {
    let fits = || self.used().saturating_add(extra) <= self.limits.max_total_bytes;
    if extra == 0 || fits() {
      return true;
    }
    let mut rooms = self.rooms.lock().await;
    self.evict_idle(&mut rooms, extra);
    fits()
  }

  /// Unloads rooms nobody is connected to, least recently active first, until `extra`
  /// more bytes fit in the budget. With a data dir only saved rooms are unloaded (the
  /// rest are saved by the next `maintain`); without one they are dropped, and editors
  /// that reconnect put the file back.
  fn evict_idle(&self, rooms: &mut HashMap<String, Arc<Mutex<Room>>>, extra: usize) {
    let over = || self.used().saturating_add(extra) > self.limits.max_total_bytes;
    if !over() {
      return;
    }
    let mut idle: Vec<(Option<Instant>, String)> = rooms
      .iter()
      .filter(|(_, room)| Arc::strong_count(room) == 1)
      .filter_map(|(id, room)| {
        let r = room.try_lock().ok()?;
        (self.data_dir.is_none() || !r.dirty).then(|| (r.last_active, id.clone()))
      })
      .collect();
    idle.sort();
    for (_, id) in idle {
      if !over() {
        break;
      }
      if let Some(room) = rooms.remove(&id) {
        let bytes = room.try_lock().map(|r| r.bytes()).unwrap_or(0);
        self.room_bytes.fetch_sub(bytes, Ordering::Relaxed);
        log::info!("over the memory budget: unloaded idle room ({bytes} bytes)");
      }
    }
  }

  /// Unloads the least recently active idle room to free a slot.
  fn evict_one(&self, rooms: &mut HashMap<String, Arc<Mutex<Room>>>) -> bool {
    let oldest = rooms
      .iter()
      .filter(|(_, room)| Arc::strong_count(room) == 1)
      .filter_map(|(id, room)| {
        let r = room.try_lock().ok()?;
        (self.data_dir.is_none() || !r.dirty).then(|| (r.last_active, id.clone()))
      })
      .min();
    let Some((_, id)) = oldest else { return false };
    if let Some(room) = rooms.remove(&id) {
      let bytes = room.try_lock().map(|r| r.bytes()).unwrap_or(0);
      self.room_bytes.fetch_sub(bytes, Ordering::Relaxed);
    }
    true
  }

  /// Tells `to` the room has applied (or `rejected`) its latest delta, after everything
  /// the room applied before it.
  fn ack(&self, room: &Room, to: u64, rejected: bool) {
    if let Some(p) = room.peers.get(&to) {
      p.out.send(
        if rejected {
          r#"{"type":"ack","rejected":true}"#
        } else {
          r#"{"type":"ack"}"#
        }
        .to_string(),
      );
    }
  }

  /// Sends `msg` to everyone in the room except `from`.
  fn broadcast(&self, room: &Room, from: u64, msg: &impl Serialize, droppable: bool) {
    if !room.peers.keys().any(|id| *id != from) {
      return;
    }
    let text = Arc::new(serde_json::to_string(msg).unwrap_or_default());
    for (id, p) in &room.peers {
      if *id != from {
        self.deliver(&p.out, &text, droppable);
      }
    }
  }

  /// Queues a broadcast for one peer, unless it has fallen behind: then presence is
  /// skipped and anything else disconnects it (it reconnects and gets the current file).
  fn deliver(&self, out: &Outbox, text: &Arc<String>, droppable: bool) {
    let (len, queued) = (text.len(), out.meter.queued.load(Ordering::Relaxed));
    if droppable {
      if queued > PRESENCE_BACKLOG {
        return;
      }
    } else if (queued > 0 && queued + len > PEER_BACKLOG) || self.used() + len > self.ceiling() {
      out.kick.notify_one();
      return;
    }
    out.meter.queue(len);
    let _ = out.tx.send(text.clone());
  }

  fn set_bytes(&self, r: &mut Room, doc_bytes: usize, asset_bytes: usize) {
    let before = r.bytes();
    r.doc_bytes = doc_bytes;
    r.asset_bytes = asset_bytes;
    let after = r.bytes();
    if after >= before {
      self.room_bytes.fetch_add(after - before, Ordering::Relaxed);
    } else {
      self.room_bytes.fetch_sub(before - after, Ordering::Relaxed);
    }
  }

  fn measured(&self, r: &mut Room, doc_bytes: usize) {
    let asset_bytes = r.asset_bytes;
    self.set_bytes(r, doc_bytes, asset_bytes);
    r.measured = (doc_bytes, Some(Instant::now()));
  }

  fn put_assets(&self, r: &mut Room, assets: &Map<String, Value>) {
    let mut asset_bytes = r.asset_bytes;
    for (k, v) in assets {
      asset_bytes += asset_size(k, v);
      if let Some(old) = r.assets.insert(k.clone(), v.clone()) {
        asset_bytes = asset_bytes.saturating_sub(asset_size(k, &old));
      }
    }
    let doc_bytes = r.doc_bytes;
    self.set_bytes(r, doc_bytes, asset_bytes);
  }
}

impl Room {
  fn bytes(&self) -> usize {
    self.doc_bytes + self.asset_bytes
  }
}

impl Outbox {
  /// Queues a message for this connection itself (no backlog check).
  fn send(&self, text: String) {
    self.meter.queue(text.len());
    let _ = self.tx.send(Arc::new(text));
  }
}

impl Meter {
  fn new(total: Arc<AtomicUsize>) -> Self {
    Meter {
      total,
      read_peak: AtomicUsize::new(0),
      write_peak: AtomicUsize::new(0),
      queued: AtomicUsize::new(0),
    }
  }

  fn read(&self, len: usize) {
    let prev = self.read_peak.fetch_max(len, Ordering::Relaxed);
    if len > prev {
      self.total.fetch_add(len - prev, Ordering::Relaxed);
    }
  }

  fn queue(&self, len: usize) {
    self.queued.fetch_add(len, Ordering::Relaxed);
    self.total.fetch_add(len, Ordering::Relaxed);
  }

  fn sent(&self, len: usize) {
    self.queued.fetch_sub(len, Ordering::Relaxed);
    self.total.fetch_sub(len, Ordering::Relaxed);
    let prev = self.write_peak.fetch_max(len, Ordering::Relaxed);
    if len > prev {
      self.total.fetch_add(len - prev, Ordering::Relaxed);
    }
  }
}

impl Drop for Meter {
  fn drop(&mut self) {
    let held = *self.read_peak.get_mut() + *self.write_peak.get_mut() + *self.queued.get_mut();
    self.total.fetch_sub(held, Ordering::Relaxed);
  }
}

impl Pacer {
  /// Admits one message. Over the rate, droppable messages are skipped and the rest wait
  /// their turn; staying over it for `max_over` is abuse.
  async fn admit(&mut self, droppable: bool) -> Pace {
    if self.bucket.try_take() {
      self.over_since = None;
      return Pace::Go;
    }
    let since = *self.over_since.get_or_insert_with(Instant::now);
    if since.elapsed() > self.max_over {
      return Pace::Abuse;
    }
    if droppable {
      return Pace::Skip;
    }
    tokio::time::sleep(self.bucket.take_owed()).await;
    Pace::Go
  }
}

fn error_json(message: &str) -> String {
  json!({ "type": "error", "message": message }).to_string()
}

/// JSON size of `value`, without building the string.
fn json_size(value: &impl Serialize) -> usize {
  struct Count(usize);
  impl std::io::Write for Count {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
      self.0 += buf.len();
      Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
      Ok(())
    }
  }
  let mut c = Count(0);
  let _ = serde_json::to_writer(&mut c, value);
  c.0
}

fn assets_size(assets: &Map<String, Value>) -> usize {
  assets.iter().map(|(k, v)| asset_size(k, v)).sum()
}

/// Approximate JSON size of one `"id":"data:…",` entry.
fn asset_size(k: &str, v: &Value) -> usize {
  k.len() + v.as_str().map(str::len).unwrap_or_else(|| json_size(v)) + 6
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

  #[test]
  fn token_buckets_allow_a_burst_then_the_rate() {
    let mut b = TokenBucket::new(10.0, 3.0);
    assert!((0..3).all(|_| b.try_take()), "the burst is available at once");
    assert!(!b.try_take(), "then it is empty");
    let wait = b.take_owed();
    assert!(wait > Duration::from_millis(50) && wait <= Duration::from_millis(100), "{wait:?}");
    assert!(!b.is_full());
  }

  #[test]
  fn meters_count_buffer_peaks_and_queued_bytes() {
    let total = Arc::new(AtomicUsize::new(0));
    {
      let m = Meter::new(total.clone());
      m.read(100);
      m.read(40);
      assert_eq!(total.load(Ordering::Relaxed), 100, "a read buffer keeps its largest size");
      m.queue(500);
      assert_eq!(total.load(Ordering::Relaxed), 600);
      m.sent(500);
      assert_eq!(total.load(Ordering::Relaxed), 600, "sent bytes stay as the write buffer's capacity");
      m.queue(10);
      m.sent(10);
      assert_eq!(total.load(Ordering::Relaxed), 600);
    }
    assert_eq!(total.load(Ordering::Relaxed), 0, "everything is released on disconnect");
  }

  #[tokio::test]
  async fn peers_that_stop_reading_are_disconnected_not_buffered() {
    let rooms = Rooms::new(Limits::default(), None);
    let (tx, _rx) = mpsc::unbounded_channel();
    let out = Outbox {
      tx,
      meter: Arc::new(Meter::new(rooms.conn_bytes.clone())),
      kick: Arc::new(Notify::new()),
    };
    let presence = Arc::new("p".repeat(PRESENCE_BACKLOG));
    let change = Arc::new("c".repeat(PEER_BACKLOG / 2 + 1));
    rooms.deliver(&out, &presence, true);
    rooms.deliver(&out, &change, false);
    rooms.deliver(&out, &presence, true);
    assert_eq!(
      out.meter.queued.load(Ordering::Relaxed),
      change.len() + presence.len(),
      "presence is skipped once behind"
    );
    let kicked = out.kick.notified();
    rooms.deliver(&out, &change, false);
    assert_eq!(
      out.meter.queued.load(Ordering::Relaxed),
      change.len() + presence.len(),
      "not queued"
    );
    tokio::time::timeout(Duration::from_secs(1), kicked)
      .await
      .expect("told to disconnect");
  }
}
