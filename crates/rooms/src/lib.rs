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
//! - client → `{type:"join", …, lists:true}` when the editor can also read child orders as moves
//!   (`moves`, `pageMoves`) and comments per message (`commentChanges`), and prunes references to
//!   deleted styles and variables itself (see `collab::DeltaOpts`, `collab::prune_refs`).
//! - client → `{type:"join", …, text:true}` when the editor can also read per-character text changes
//!   (the delta's `text` key, see `collab::DeltaOpts` and `textseq`); it needs `lists`.
//! - server → `{type:"welcome", you, doc|null, assets, peers, ordered:true, granular:true, lists:true, text:true}`
//!   (`granular`: this room takes per-id changes; editors that sent none get the whole lists
//!   instead, taken from the room's document. `lists`: it takes moves and per-message comment
//!   changes; editors that sent no `lists` get whole child lists and comments, and the layers
//!   the room pruned, taken from the room's document. `text`: it merges text per character; editors
//!   that sent no `text` get each `text` entry as the layer's whole text from the room's document, and
//!   their own whole-text changes reset that layer's character ids)
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
//! - server → `welcome` also carries `model` (the document model revision the server understands;
//!   older servers send none), `view` (editors, when the server has view links: the id of this
//!   room's view-only link, derived from the room id) and `role:"viewer"` (viewers). `peer` and
//!   `peers` entries carry `role:"viewer"` for viewers.
//! - A viewer joins with `?view=<id>` instead of `?room=<id>` (`serve_viewer`). It sees the file,
//!   cursors and presence, but its join never sets the document, only comment-only deltas are
//!   applied (anything else is acknowledged as rejected) and the `owner` and `ended` keys of its
//!   presence are dropped. The edit room id is never sent to it.
//! - When the person who shared the file stops sharing (presence `{owner:true, ended:true}`),
//!   the room remembers it: later joins without `reset` get `{type:"ended", name}` and are
//!   disconnected, instead of rejoining a room nobody shares any more.
//!
//! Durability: with a data dir, every applied change is first appended to the room's log
//! (`<room>.log`, one JSON line per change) and `sync_data`'d; only then are the change
//! broadcast and acknowledged (group commit: changes that arrive while one batch syncs share the
//! next sync). An acknowledged change therefore survives a crash of the process or the host. The
//! room file (`<room>.json`, with the sequence number of the last change it holds) is a snapshot
//! the log is compacted into every 30 s, past 8 MB, when the room empties and at shutdown. A
//! server without a data dir (the bridge's LAN room) sends everything at once.
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
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
pub use designotron_engine::collab::MODEL_REVISION;
use designotron_engine::model::Document;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, Mutex, Notify};

/// Rooms drop references to deleted tokens from every change they apply (and replay).
const PRUNE: designotron_engine::collab::ApplyOpts = designotron_engine::collab::ApplyOpts { prune: true };

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
  /// Room log syncs so far (each makes a batch of changes durable), the changes they
  /// carried, and their average and longest duration in microseconds.
  pub log_syncs: u64,
  pub log_lines: u64,
  pub log_sync_avg_us: u64,
  pub log_sync_max_us: u64,
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
  /// Numbers temp files, so two writers never share one.
  save_seq: AtomicU64,
  /// Log syncs so far, their total and longest duration (microseconds).
  sync_count: AtomicU64,
  sync_micros: AtomicU64,
  sync_max_micros: AtomicU64,
  /// Changes written to the logs.
  sync_lines: AtomicU64,
  /// Set at shutdown: edits are no longer applied (so none is acknowledged and then lost).
  closing: std::sync::atomic::AtomicBool,
  limits: Limits,
  data_dir: Option<PathBuf>,
  /// Sum of every room's `bytes()`.
  room_bytes: AtomicUsize,
  /// Sum of every connection's `Meter`.
  conn_bytes: Arc<AtomicUsize>,
  people: AtomicUsize,
  /// Whether rooms hand out view-only links (the bridge's LAN room doesn't).
  view_links: bool,
  /// View id → room id for the rooms this server knows (see `view_id`).
  views: std::sync::Mutex<HashMap<String, String>>,
  /// Rooms whose owner stopped sharing (id → owner's name), oldest first, bounded.
  ended: std::sync::Mutex<(HashMap<String, String>, std::collections::VecDeque<String>)>,
}

/// A room's log is compacted into its snapshot after this long, or past `LOG_COMPACT_BYTES`.
const COMPACT_EVERY: Duration = Duration::from_secs(30);
const LOG_COMPACT_BYTES: usize = 8 << 20;
/// A connection whose changes leave this much unwritten log waits for the disk.
const LOG_BACKLOG: usize = 16 << 20;
/// A log sync slower than this is logged.
const SLOW_SYNC: Duration = Duration::from_millis(200);

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
  /// When the file on disk was last written.
  last_saved: Option<Instant>,
  /// The number of the last change applied (the snapshot on disk records the last one it holds).
  seq: u64,
  /// Log lines appended since the last write to disk.
  log_buf: Vec<u8>,
  /// Messages to peers that wait until the changes they describe are on disk, in order.
  held: Vec<Held>,
  /// Size of the log file once `log_buf` is written.
  log_bytes: usize,
  /// The next commit snapshots the room instead of appending (a new document, or a failed write).
  compact: bool,
  /// The room's log file; serialises disk work. Lock order: this, then the room.
  io: Arc<Mutex<RoomLog>>,
}

/// A message that goes out once the changes before it are durable.
struct Held {
  out: Outbox,
  text: Arc<String>,
  /// An acknowledgement: sent whatever the peer's backlog.
  direct: bool,
}

#[derive(Default)]
struct RoomLog {
  file: Option<Arc<std::fs::File>>,
}

/// What a connection may do in a room.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
  Editor,
  /// Joined through a view-only link: watches, and may only add to the comments.
  Viewer,
}

struct Peer {
  role: Role,
  out: Outbox,
  name: String,
  color: String,
  presence: Value,
  /// Reads per-id changes of pages, styles and variables.
  granular: bool,
  /// Also reads moves and per-message comment changes, and prunes dangling references itself.
  lists: bool,
  /// Also reads per-character text changes (the delta's `text` key); implies `lists`.
  text: bool,
  /// The document model revision this editor understands (`MODEL_REVISION` at most); the room
  /// rewrites what it sends it with `collab::downgrade`.
  model: u32,
}

/// The model of an editor that joined without saying (the field came with revision 4).
const UNSAID_MODEL: u32 = 3;

/// `text` (a message the room sends, as JSON) as an editor at document model `model` can read
/// it, or `text` itself when nothing in it needs rewriting. Revisions 3 and up only differ by
/// the names On drag and sticky, so a message without them is passed on as it is.
fn for_model(text: &Arc<String>, model: u32) -> Arc<String> {
  if model >= MODEL_REVISION || (model >= 3 && !text.contains("\"onDrag\"") && !text.contains("\"sticky\"")) {
    return text.clone();
  }
  match serde_json::from_str::<Value>(text) {
    Ok(mut v) => {
      designotron_engine::collab::downgrade_value(&mut v, model);
      Arc::new(v.to_string())
    }
    Err(_) => text.clone(),
  }
}

/// The document as one editor can read it. Only the document is rewritten, and only for editors
/// below this build's model; the images next to it are never parsed or copied.
#[derive(Serialize)]
#[serde(untagged)]
enum DocOut<'a> {
  Raw(&'a Document),
  /// Already text, with nothing in it that needs rewriting.
  Text(Box<RawValue>),
  Older(Value),
}

fn doc_for(doc: &Document, model: u32) -> DocOut<'_> {
  if model >= MODEL_REVISION {
    return DocOut::Raw(doc);
  }
  // Revisions 3 and up differ only by the names On drag and sticky: look for them in the text
  // before building a tree.
  let text = serde_json::to_string(doc).unwrap_or_default();
  if model >= 3 && !text.contains("\"onDrag\"") && !text.contains("\"sticky\"") {
    if let Ok(raw) = RawValue::from_string(text) {
      return DocOut::Text(raw);
    }
    return DocOut::Raw(doc);
  }
  let mut v = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
  designotron_engine::collab::downgrade_value(&mut v, model);
  DocOut::Older(v)
}

/// `for_model` for one message sent to several peers: one rewrite per distinct model.
#[derive(Default)]
struct ModelTexts(HashMap<u32, Arc<String>>);

impl ModelTexts {
  fn get(&mut self, text: &Arc<String>, model: u32) -> Arc<String> {
    if model >= MODEL_REVISION {
      return text.clone();
    }
    self.0.entry(model).or_insert_with(|| for_model(text, model)).clone()
  }
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
  #[serde(default)]
  lists: bool,
  #[serde(default)]
  text: bool,
  /// The editor's document model revision; editors that predate the field are at 3.
  #[serde(default)]
  model: Option<u32>,
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
  doc: Option<DocOut<'a>>,
  assets: &'a Map<String, Value>,
  peers: Vec<PeerInfo<'a>>,
  /// Deltas are acknowledged in order (see the protocol above).
  ordered: bool,
  /// Pages, styles and variables may travel as per-id changes (see the protocol above).
  granular: bool,
  /// Child orders may travel as moves and comments per message (see the protocol above).
  lists: bool,
  /// Text may travel as per-character changes (see the protocol above).
  text: bool,
  /// The document model revision this server understands.
  model: u32,
  /// The id of this room's view-only link (editors, when the server has them).
  #[serde(skip_serializing_if = "Option::is_none")]
  view: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  role: Option<&'static str>,
}

#[derive(Serialize)]
struct PeerInfo<'a> {
  id: u64,
  name: &'a str,
  color: &'a str,
  presence: &'a Value,
  #[serde(skip_serializing_if = "Option::is_none")]
  role: Option<&'static str>,
}

#[derive(Serialize)]
struct Reload<'a> {
  #[serde(rename = "type")]
  kind: &'static str,
  doc: Option<DocOut<'a>>,
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
  /// The last change in `doc` (see `Room::seq`); files without it hold change 0.
  seq: u64,
}

/// One line of a room's log.
#[derive(Serialize, Deserialize)]
struct LogLine<'a> {
  seq: u64,
  delta: Cow<'a, Value>,
  assets: Option<Cow<'a, Map<String, Value>>>,
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

/// The id of the view-only link of room `room_id`: derived, so a server needs no register of
/// them and the link survives a restart. It can't be turned back into the room id.
pub fn view_id(room_id: &str) -> String {
  let digest = Sha256::digest(format!("designotron-view\0{room_id}").as_bytes());
  digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// True for ids `view_id` makes: 32 lowercase hex characters.
pub fn valid_view_id(id: &str) -> bool {
  id.len() == 32 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Longest comment message a viewer may write, in bytes.
const VIEWER_MAX_TEXT: usize = 5 * 1024;
/// Most comments one viewer delta may touch.
const VIEWER_MAX_COMMENTS: usize = 20;
/// Most messages one viewer delta may add to a comment.
const VIEWER_MAX_NEW_MESSAGES: usize = 20;
/// Largest delta (the whole message, in bytes) a viewer may send.
const VIEWER_MAX_DELTA: usize = 64 * 1024;
/// Editor slots kept free of viewers (viewers are capped at `max_peers` minus this).
const EDITOR_RESERVE: usize = 10;

/// What a viewer's delta is allowed to do, as a clean delta to apply and relay; None if it
/// does anything else. Only comments: new threads, replies appended to existing ones and
/// resolving. Everything is rebuilt from typed values, so nothing else the viewer put in the
/// message (pages, styles, variables, unknown keys) can reach the room.
///
/// Replies and resolving come either as a whole comment (older editors; the old messages must be
/// an exact prefix of the new ones) or as `commentChanges` with only `add` and `set.resolved`.
fn viewer_delta(delta: &Value, doc: &Document) -> Option<Value> {
  use designotron_engine::model::{Comment, CommentMessage};
  let o = delta.as_object()?;
  // The editor always sends these three, empty; anything else but comments is refused.
  let empty = |k: &str| match o.get(k) {
    None => true,
    Some(Value::Array(a)) => a.is_empty(),
    Some(Value::Object(m)) => m.is_empty(),
    Some(_) => false,
  };
  if o
    .keys()
    .any(|k| !matches!(k.as_str(), "comments" | "nodes" | "removed" | "commentsRemoved" | "commentChanges"))
    || !empty("nodes")
    || !empty("removed")
    || !empty("commentsRemoved")
  {
    return None;
  }
  let none = Map::new();
  let given = match o.get("comments") {
    None => &none,
    Some(v) => v.as_object()?,
  };
  let changes = match o.get("commentChanges") {
    None => &none,
    Some(v) => v.as_object()?,
  };
  if given.len() + changes.len() == 0 || given.len() + changes.len() > VIEWER_MAX_COMMENTS {
    return None;
  }
  let text_ok = |m: &CommentMessage| m.text.len() <= VIEWER_MAX_TEXT && m.author.len() <= 200;
  let mut out = Map::new();
  for (id, v) in given {
    let c: Comment = serde_json::from_value(v.clone()).ok()?;
    if &c.id != id || !c.messages.iter().all(text_ok) {
      return None;
    }
    if let Some(old) = doc.comments.get(id) {
      // Append-only: the old messages stay as they were; only `resolved` may change.
      let kept = c.messages.len() >= old.messages.len() && c.messages[..old.messages.len()] == old.messages[..];
      if !kept || c.page != old.page || c.x != old.x || c.y != old.y || c.node != old.node {
        return None;
      }
    }
    let before = doc.comments.get(id).map_or(0, |old| old.messages.len());
    if c.messages.len().saturating_sub(before) > VIEWER_MAX_NEW_MESSAGES {
      return None;
    }
    out.insert(id.clone(), serde_json::to_value(&c).ok()?);
  }
  let mut clean = Map::new();
  for (id, ch) in changes {
    let ch = ch.as_object()?;
    // Never `del`, and of `set` only `resolved`.
    if ch.keys().any(|k| !matches!(k.as_str(), "set" | "add" | "del")) {
      return None;
    }
    if let Some(del) = ch.get("del") {
      if !del.as_array()?.is_empty() {
        return None;
      }
    }
    let mut part = Map::new();
    if let Some(set) = ch.get("set") {
      let set = set.as_object()?;
      if set.keys().any(|k| k != "resolved") {
        return None;
      }
      if let Some(r) = set.get("resolved") {
        part.insert("set".into(), json!({ "resolved": r.as_bool()? }));
      }
    }
    if let Some(add) = ch.get("add") {
      let add = add.as_array()?;
      if add.len() > VIEWER_MAX_NEW_MESSAGES {
        return None;
      }
      let msgs: Vec<CommentMessage> = add.iter().map(|m| serde_json::from_value(m.clone()).ok()).collect::<Option<_>>()?;
      if !msgs.iter().all(text_ok) {
        return None;
      }
      if !msgs.is_empty() {
        part.insert("add".into(), serde_json::to_value(&msgs).ok()?);
      }
    }
    if !part.is_empty() {
      clean.insert(id.clone(), Value::Object(part));
    }
  }
  if out.is_empty() && clean.is_empty() {
    return None;
  }
  let mut d = json!({ "nodes": {}, "removed": [], "comments": out, "commentsRemoved": [] });
  if !clean.is_empty() {
    d["commentChanges"] = Value::Object(clean);
  }
  Some(d)
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
    Self::build(limits, data_dir, false)
  }

  /// Like `new`, and rooms hand out view-only links (`serve_viewer`). Saved rooms in the
  /// data dir are indexed by their file names.
  pub fn with_view_links(limits: Limits, data_dir: Option<PathBuf>) -> Arc<Self> {
    Self::build(limits, data_dir, true)
  }

  fn build(limits: Limits, data_dir: Option<PathBuf>, view_links: bool) -> Arc<Self> {
    let mut views = HashMap::new();
    if let (true, Some(d)) = (view_links, &data_dir) {
      for entry in std::fs::read_dir(d).into_iter().flatten().flatten() {
        let path = entry.path();
        let stem = path.file_stem().and_then(|s| s.to_str());
        if let (Some("json"), Some(stem)) = (path.extension().and_then(|e| e.to_str()), stem) {
          if valid_room_id(stem) {
            views.insert(view_id(stem), stem.to_string());
          }
        }
      }
    }
    if let Some(d) = &data_dir {
      if let Err(e) = std::fs::create_dir_all(d) {
        log::error!("cannot create data dir {}: {e}", d.display());
      }
      // Temp files of a write that a crash interrupted ("<room>.json.<n>.tmp"); the .json beside them is intact.
      for entry in std::fs::read_dir(d).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("tmp") && entry.file_type().is_ok_and(|t| t.is_file()) {
          let _ = std::fs::remove_file(&path);
        }
      }
      // A log without a room file can only come from a room that crashed before its first
      // snapshot, which nobody was told about: nothing to replay it onto.
      for entry in std::fs::read_dir(d).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("log") && !path.with_extension("json").exists() {
          let _ = std::fs::remove_file(&path);
        }
      }
    }
    Arc::new(Rooms {
      rooms: Mutex::new(HashMap::new()),
      next_id: AtomicU64::new(0),
      save_seq: AtomicU64::new(0),
      sync_count: AtomicU64::new(0),
      sync_micros: AtomicU64::new(0),
      sync_max_micros: AtomicU64::new(0),
      sync_lines: AtomicU64::new(0),
      closing: std::sync::atomic::AtomicBool::new(false),
      limits,
      data_dir,
      room_bytes: AtomicUsize::new(0),
      conn_bytes: Arc::new(AtomicUsize::new(0)),
      people: AtomicUsize::new(0),
      view_links,
      views: std::sync::Mutex::new(views),
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
      log_syncs: self.sync_count.load(Ordering::Relaxed),
      log_lines: self.sync_lines.load(Ordering::Relaxed),
      log_sync_avg_us: self.sync_micros.load(Ordering::Relaxed) / self.sync_count.load(Ordering::Relaxed).max(1),
      log_sync_max_us: self.sync_max_micros.load(Ordering::Relaxed),
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

  /// Writes the changed rooms whose last save is old enough: at least `SAVE_EVERY` ago, or
  /// `SAVE_EVERY_BIG` for rooms over `BIG_ROOM` bytes. Call about once a second.
  pub async fn save_dirty(&self) {
    self.save_rooms(false).await;
  }

  /// Stops applying edits (call first when shutting down; follow with `save_all`). The check
  /// happens under each room's lock, as does saving, so whatever was applied is saved.
  pub fn close(&self) {
    self.closing.store(true, Ordering::SeqCst);
  }

  /// Writes every changed room now, whatever its size.
  pub async fn save_all(&self) {
    self.save_rooms(true).await;
  }

  /// Compacts the logs of changed rooms that are due: the log is past `LOG_COMPACT_BYTES`, the
  /// last snapshot is older than `COMPACT_EVERY`, nobody is in the room, or `force`. (Changes
  /// are already durable in the log; this bounds its size and replay time.)
  async fn save_rooms(&self, force: bool) {
    let entries: Vec<(String, Arc<Mutex<Room>>)> = self.rooms.lock().await.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (id, room) in entries {
      let io = {
        let mut r = room.lock().await;
        if !r.dirty {
          continue;
        }
        if self.data_dir.is_none() {
          r.dirty = false;
          r.last_saved = Some(Instant::now());
          continue;
        }
        let due = force
          || r.compact
          || r.peers.is_empty()
          || r.log_bytes > LOG_COMPACT_BYTES
          || r.last_saved.is_none_or(|t| t.elapsed() >= COMPACT_EVERY);
        if !due {
          continue;
        }
        r.io.clone()
      };
      let mut log = io.lock().await;
      self.compact(&id, &room, &mut log).await;
    }
  }

  /// Writes the room's snapshot and empties its log, then releases what was held back. Call with
  /// the room's `io` locked.
  async fn compact(&self, id: &str, room: &Arc<Mutex<Room>>, log: &mut RoomLog) {
    let (Some(path), Some(log_path)) = (self.file(id), self.log_file(id)) else {
      return;
    };
    let (doc, assets, seq, held) = {
      let mut r = room.lock().await;
      let held = std::mem::take(&mut r.held);
      if !r.dirty && !r.compact {
        // Another compaction got here first: the snapshot is current.
        drop(r);
        self.release(held);
        return;
      }
      r.log_buf.clear();
      r.compact = false;
      let Some(doc) = r.doc.clone() else {
        drop(r);
        self.release(held);
        return;
      };
      // The snapshot covers everything applied so far, so it supersedes the log.
      r.dirty = false;
      r.last_saved = Some(Instant::now());
      r.log_bytes = 0;
      (doc, r.assets.clone(), r.seq, held)
    };
    let tmp = path.with_extension(format!("json.{}.tmp", self.save_seq.fetch_add(1, Ordering::Relaxed)));
    let (tmp2, path2) = (tmp.clone(), path.clone());
    let started = Instant::now();
    let written = tokio::task::spawn_blocking(move || -> std::io::Result<usize> {
      let body = serde_json::to_vec(&Saved {
        doc: &doc,
        assets: &assets,
        seq,
      })
      .map_err(std::io::Error::other)?;
      let mut f = std::fs::File::create(&tmp2)?;
      f.write_all(&body)?;
      f.sync_all()?;
      drop(f);
      std::fs::rename(&tmp2, &path2)?;
      sync_dir(&path2)?;
      // Lines at or below the snapshot's `seq` are skipped on load, so a crash before this
      // truncation only leaves a log that replays nothing.
      match std::fs::OpenOptions::new().write(true).open(&log_path) {
        Ok(f) => {
          f.set_len(0)?;
          f.sync_data()?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
      }
      Ok(body.len())
    })
    .await
    .unwrap_or_else(|e| Err(std::io::Error::other(e)));
    // The append handle stays valid after the truncation (O_APPEND).
    let _ = log;
    match written {
      Ok(len) => {
        if started.elapsed() > SLOW_SYNC {
          log::warn!("room {}: snapshot of {len} bytes took {:?}", tag(id), started.elapsed());
        }
        let mut r = room.lock().await;
        let doc_bytes = len.saturating_sub(r.asset_bytes);
        self.measured(&mut r, doc_bytes);
        drop(r);
        self.release(held);
      }
      Err(e) => {
        log::warn!("cannot save room {}: {e}", tag(id));
        let _ = tokio::fs::remove_file(&tmp).await;
        {
          let mut r = room.lock().await;
          // Stays dirty: the next tick snapshots again (the log may hold a torn tail by now).
          r.dirty = true;
          r.compact = true;
        }
        self.fail(room, held).await;
      }
    }
  }

  /// Makes the changes appended since the last commit durable, then sends what was held back
  /// for them. Runs once per batch: while one commit syncs, later ones wait their turn and
  /// then take everything that piled up (group commit).
  async fn commit(self: Arc<Self>, id: String, room: Arc<Mutex<Room>>, io: Arc<Mutex<RoomLog>>) {
    let mut log = io.lock().await;
    let (buf, held) = {
      let mut r = room.lock().await;
      if r.log_buf.is_empty() && r.held.is_empty() && !r.compact {
        return;
      }
      if r.compact {
        drop(r);
        self.compact(&id, &room, &mut log).await;
        return;
      }
      (std::mem::take(&mut r.log_buf), std::mem::take(&mut r.held))
    };
    if !buf.is_empty() {
      let Some(path) = self.log_file(&id) else {
        self.release(held);
        return;
      };
      let lines = buf.iter().filter(|b| **b == b'\n').count() as u64;
      let file = log.file.clone();
      let started = Instant::now();
      let written = tokio::task::spawn_blocking(move || -> std::io::Result<Arc<std::fs::File>> {
        let file = match file {
          Some(f) => f,
          None => {
            let f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
            sync_dir(&path)?;
            Arc::new(f)
          }
        };
        (&*file).write_all(&buf)?;
        file.sync_data()?;
        Ok(file)
      })
      .await
      .unwrap_or_else(|e| Err(std::io::Error::other(e)));
      let took = started.elapsed();
      match written {
        Ok(f) => {
          log.file = Some(f);
          let us = took.as_micros() as u64;
          self.sync_count.fetch_add(1, Ordering::Relaxed);
          self.sync_lines.fetch_add(lines, Ordering::Relaxed);
          self.sync_micros.fetch_add(us, Ordering::Relaxed);
          self.sync_max_micros.fetch_max(us, Ordering::Relaxed);
          if took > SLOW_SYNC {
            log::warn!("room {}: syncing {lines} changes took {took:?}", tag(&id));
          }
        }
        Err(e) => {
          log::warn!("cannot write the log of room {}: {e}", tag(&id));
          log.file = None;
          {
            let mut r = room.lock().await;
            // The log may hold a torn tail: the next commit snapshots instead of appending.
            r.compact = true;
            r.dirty = true;
          }
          self.fail(&room, held).await;
          return;
        }
      }
    }
    self.release(held);
  }

  /// Sends what was held back, in order, now that the changes before it are durable.
  fn release(&self, held: Vec<Held>) {
    // What a peer had queued before the batch: the batch itself doesn't make a peer that was
    // keeping up look behind.
    let mut before: HashMap<usize, usize> = HashMap::new();
    for h in held {
      if h.direct {
        h.out.send_shared(h.text);
      } else {
        let queued = *before
          .entry(Arc::as_ptr(&h.out.meter) as usize)
          .or_insert_with(|| h.out.meter.queued.load(Ordering::Relaxed));
        self.deliver_at(&h.out, &h.text, false, queued);
      }
    }
  }

  /// The room's changes couldn't be saved: nothing held is sent (so nothing unsaved is
  /// acknowledged) and everyone reconnects, re-sending what wasn't acknowledged.
  async fn fail(&self, room: &Arc<Mutex<Room>>, held: Vec<Held>) {
    drop(held);
    let r = room.lock().await;
    for p in r.peers.values() {
      p.out.send(error_json("The relay can't save changes right now; reconnecting…"));
      p.out.kick.notify_one();
    }
  }

  /// Saves changed rooms that are due (see `save_dirty`), drops idle ones and unloads idle
  /// rooms while over the memory budget. Call periodically.
  pub async fn maintain(&self) {
    self.save_rooms(false).await;
    let entries: Vec<(String, Arc<Mutex<Room>>)> = self.rooms.lock().await.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (_, room) in entries {
      let mut r = room.lock().await;
      let (measured, _) = r.measured;
      if r.doc_bytes > measured + (1024 * 1024).max(measured / 4) {
        // Deltas mostly replace layers, so the estimate drifts upwards.
        let exact = r.doc.as_ref().map(json_size).unwrap_or(0);
        self.measured(&mut r, exact);
      }
    }
    let mut deleted = Vec::new();
    let mut emptied = Vec::new();
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
          // Only a room that was loaded and found empty is gone; an unloaded saved one still
          // has its file (and its view link).
          if r.loaded {
            emptied.push(id.clone());
          }
          false
        } else if idle > ttl {
          // Files go before the map lock is released, so a joiner can't load them and then
          // have them deleted under it.
          for path in [self.file(id), self.log_file(id)].into_iter().flatten() {
            let _ = std::fs::remove_file(path);
          }
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
    if self.view_links {
      // Forget links of rooms that exist nowhere any more.
      let rooms = self.rooms.lock().await;
      if let Ok(mut v) = self.views.lock() {
        v.retain(|_, room| rooms.contains_key(room) || (self.data_dir.is_some() && !deleted.contains(room) && !emptied.contains(room)));
      }
    }
  }

  /// The room a view-only link opens, if this server knows it (in memory or saved).
  pub async fn view_room(&self, view: &str) -> Option<String> {
    let room = self.views.lock().ok()?.get(view).cloned()?;
    self.known(&room).await.then_some(room)
  }

  /// Serves one connection through a view-only link until it disconnects. Never creates a
  /// room; an unknown link gets an error to show and is closed.
  pub async fn serve_viewer(self: Arc<Self>, socket: WebSocket, view: String) {
    match self.view_room(&view).await {
      Some(room_id) => self.serve_as(socket, room_id, Role::Viewer).await,
      None => {
        let (mut sink, _) = socket.split();
        let msg = "This view link isn't active: the file isn't being shared right now.";
        let _ = sink.send(Message::Text(error_json(msg))).await;
        let _ = sink.close().await;
      }
    }
  }

  /// Serves one editor connection in room `room_id` until it disconnects.
  pub async fn serve(self: Arc<Self>, socket: WebSocket, room_id: String) {
    self.serve_as(socket, room_id, Role::Editor).await
  }

  async fn serve_as(self: Arc<Self>, socket: WebSocket, room_id: String, role: Role) {
    let (mut sink, mut stream) = socket.split();
    let room = match self.room(&room_id).await {
      Ok(r) => r,
      Err(e) => {
        let _ = sink.send(Message::Text(error_json(&e))).await;
        let _ = sink.close().await;
        return;
      }
    };
    let io = room.lock().await.io.clone();
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
          let step = self.join(&room_id, &mut r, id, role, &out, &m, size).await;
          joined = r.peers.contains_key(&id);
          step
        }
        "ping" => {
          out.send(PONG.to_string());
          Step::Go
        }
        // Shutting down: not applied and not acknowledged, so the editor keeps the change
        // and sends it again to the next relay.
        "delta" if joined && self.closing.load(Ordering::SeqCst) => Step::Go,
        "delta" if joined => self.delta(&mut r, id, role, &m, size),
        "name" if joined => {
          let name = m.name.as_deref().unwrap_or("").trim().chars().take(40).collect::<String>();
          if let (false, Some(peer)) = (name.is_empty(), r.peers.get_mut(&id)) {
            peer.name = name.clone();
            self.notify(&mut r, id, &json!({ "type": "rename", "id": id, "name": name }));
          }
          Step::Go
        }
        "presence" if joined => {
          if let Some(p) = m.presence.filter(|p| p.get().len() <= MAX_PRESENCE_BYTES) {
            let mut presence: Value = serde_json::from_str(p.get()).unwrap_or(Value::Null);
            // A viewer can't own the file or end the room.
            let stripped = role == Role::Viewer
              && presence
                .as_object_mut()
                .is_some_and(|o| o.remove("owner").is_some() | o.remove("ended").is_some());
            let stripped = if stripped {
              serde_json::value::to_raw_value(&presence).ok()
            } else {
              None
            };
            let p = stripped.as_deref().unwrap_or(p);
            // The person who shared the file stopped sharing: later joins are told so.
            // Without a known owner (e.g. after a restart), whoever says they own it.
            let owner_ok = role == Role::Editor && r.owner.map_or(presence["owner"] == true, |o| o == id);
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
      let backlog = r.log_buf.len() > LOG_BACKLOG;
      let held = !r.held.is_empty();
      drop(r);
      if self.data_dir.is_some() && (matches!(m.kind.as_ref(), "join" | "delta") || held) {
        let commit = self.clone().commit(room_id.clone(), room.clone(), io.clone());
        if backlog {
          // The disk can't keep up: stop reading from this connection until it has.
          commit.await;
        } else {
          // Not awaited: this connection keeps reading, and its next changes share the next sync.
          tokio::spawn(commit);
        }
      }
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
      self.notify(&mut r, id, &json!({ "type": "leave", "id": id }));
    }
    r.last_active = Some(Instant::now());
    let held = !r.held.is_empty();
    drop(r);
    if held {
      tokio::spawn(self.clone().commit(room_id.clone(), room.clone(), io.clone()));
    }
    // Let the writer deliver a final error, but not wait on a peer that stopped reading.
    drop(out);
    if tokio::time::timeout(Duration::from_secs(2), &mut writer).await.is_err() {
      writer.abort();
    }
  }

  fn file(&self, id: &str) -> Option<PathBuf> {
    self.data_dir.as_ref().map(|d| d.join(format!("{id}.json")))
  }

  fn log_file(&self, id: &str) -> Option<PathBuf> {
    self.data_dir.as_ref().map(|d| d.join(format!("{id}.log")))
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
    if self.view_links {
      if let Ok(mut v) = self.views.lock() {
        v.insert(view_id(id), id.to_string());
      }
    }
    Ok(r)
  }

  #[allow(clippy::too_many_arguments)]
  async fn join(&self, room_id: &str, r: &mut Room, id: u64, role: Role, out: &Outbox, m: &Incoming<'_>, size: usize) -> Step {
    let viewers = r.peers.values().filter(|p| p.role == Role::Viewer).count();
    let viewer_cap = if self.limits.max_peers > EDITOR_RESERVE {
      self.limits.max_peers - EDITOR_RESERVE
    } else {
      self.limits.max_peers / 2
    };
    if role == Role::Viewer && viewers >= viewer_cap.max(1) {
      return Step::Close("This file already has the maximum number of people watching.".into());
    }
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
    // Viewers never bring a document.
    let doc_given = m.doc.is_some() && role == Role::Editor;
    if m.reset && doc_given {
      // Shared (again) on purpose: this connection owns the room.
      self.set_ended(room_id, None);
      r.owner = Some(id);
    } else if let Some(owner) = self.ended_by(room_id) {
      out.send(json!({ "type": "ended", "name": owner }).to_string());
      return Step::Leave;
    }
    let adopt = doc_given && (r.doc.is_none() || m.reset);
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
          // Earlier log lines belong to the replaced document: snapshot before anything else is sent.
          r.compact = self.data_dir.is_some();
        }
        Err(e) => return Step::Warn(format!("This file couldn't be shared: {e}")),
      }
    } else if !self.reserve(r.bytes()).await {
      // The welcome carries the whole file.
      return Step::Close(BUSY.into());
    }
    let none = Map::new();
    let own_model = m.model.unwrap_or(UNSAID_MODEL).min(MODEL_REVISION);
    let welcome = Welcome {
      kind: "welcome",
      you: id,
      // Omitted when this editor's own document became the room's.
      doc: if adopt {
        None
      } else {
        r.doc.as_ref().map(|d| doc_for(d, own_model))
      },
      assets: if adopt { &none } else { &r.assets },
      peers: r
        .peers
        .iter()
        .map(|(pid, p)| PeerInfo {
          id: *pid,
          name: &p.name,
          color: &p.color,
          presence: &p.presence,
          role: p.role.name(),
        })
        .collect(),
      ordered: true,
      granular: true,
      lists: true,
      text: true,
      model: designotron_engine::collab::MODEL_REVISION,
      view: (self.view_links && role == Role::Editor).then(|| view_id(room_id)),
      role: role.name(),
    };
    let welcome = serde_json::to_string(&welcome).unwrap_or_default();
    let welcome = Arc::new(welcome);
    if adopt && self.data_dir.is_some() {
      // The sharer is told once its file is saved (the commit that follows snapshots it).
      self.put(r, out, welcome, true);
    } else {
      out.send_shared(welcome);
    }
    if adopt && !r.peers.is_empty() {
      // A reset replaces everyone's document.
      // One text per model among the others: older editors get the document they can read.
      let mut texts: HashMap<u32, Arc<String>> = HashMap::new();
      let to: Vec<(Outbox, Arc<String>)> = r
        .peers
        .values()
        .map(|p| {
          let text = texts.entry(p.model).or_insert_with(|| {
            let reload = Reload {
              kind: "reload",
              doc: r.doc.as_ref().map(|d| doc_for(d, p.model)),
              assets: &r.assets,
            };
            Arc::new(serde_json::to_string(&reload).unwrap_or_default())
          });
          (p.out.clone(), text.clone())
        })
        .collect();
      for (out, text) in to {
        self.put(r, &out, text, false);
      }
    }
    r.peers.insert(
      id,
      Peer {
        role,
        out: out.clone(),
        name: name.clone(),
        color: color.clone(),
        presence: Value::Null,
        granular: m.granular,
        lists: m.lists && m.granular,
        text: m.text && m.lists && m.granular,
        model: m.model.unwrap_or(UNSAID_MODEL).min(MODEL_REVISION),
      },
    );
    self.people.fetch_add(1, Ordering::Relaxed);
    let mut peer = json!({ "type": "peer", "id": id, "name": name, "color": color });
    if let Some(role) = role.name() {
      peer["role"] = json!(role);
    }
    self.notify(r, id, &peer);
    Step::Go
  }

  fn delta(&self, r: &mut Room, id: u64, role: Role, m: &Incoming<'_>, size: usize) -> Step {
    let Some(raw) = m.delta else {
      return Step::Go;
    };
    if r.doc.is_none() {
      self.ack(r, id, true);
      return Step::Go;
    }
    let assets = m
      .assets
      .filter(|_| role == Role::Editor)
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
    let Ok(mut delta) = serde_json::from_str::<Value>(raw.get()) else {
      self.ack(r, id, true);
      return Step::Go;
    };
    // A viewer's change is rebuilt from what it may do; the rebuilt one is applied and relayed.
    let clean_raw;
    let mut raw = raw;
    if role == Role::Viewer {
      // Viewers can't fill the room: small messages, and nothing once it is half full.
      if size > VIEWER_MAX_DELTA || r.bytes() > self.limits.max_room_bytes / 2 {
        self.ack(r, id, true);
        return Step::Go;
      }
      let Some(clean) = viewer_delta(&delta, r.doc.as_ref().unwrap()) else {
        self.ack(r, id, true);
        return Step::Go;
      };
      clean_raw = serde_json::value::to_raw_value(&clean).ok();
      delta = clean;
      if let Some(c) = clean_raw.as_deref() {
        raw = c;
      }
    }
    // An editor that predates effect and grid styles sends whole `styles` without them: keep the room's.
    let sender_granular = r.peers.get(&id).is_some_and(|p| p.granular);
    let fixed = if !sender_granular && designotron_engine::collab::keep_style_lists(&mut delta, r.doc.as_ref().unwrap()) {
      serde_json::value::to_raw_value(&delta).ok()
    } else {
      None
    };
    let raw: &RawValue = fixed.as_deref().unwrap_or(raw);
    // Every copy prunes references to deleted tokens the same way (`collab::prune_refs`).
    let pruned = match designotron_engine::collab::apply_opts(r.doc.as_mut().unwrap(), &delta, PRUNE) {
      Ok(pruned) => pruned,
      Err(e) => {
        log::warn!("rejected collab delta: {e}");
        self.ack(r, id, true);
        return Step::Go;
      }
    };
    let (doc_bytes, asset_bytes) = (r.doc_bytes + growth, r.asset_bytes);
    self.set_bytes(r, doc_bytes, asset_bytes);
    // Images are optional for the document to stay consistent: over the limit, peers get
    // the change without them.
    let keep = assets.is_some() && r.bytes() + new_asset_bytes <= max;
    if let (true, Some(a)) = (keep, assets.as_ref()) {
      self.put_assets(r, a);
    }
    r.dirty = true;
    if self.data_dir.is_some() {
      // The line holds what was applied (the repaired delta, the kept images), in one line.
      let line = LogLine {
        seq: r.seq + 1,
        delta: Cow::Borrowed(&delta),
        assets: assets.as_ref().filter(|_| keep).map(Cow::Borrowed),
      };
      let mut bytes = Vec::new();
      if serde_json::to_writer(&mut bytes, &line).is_ok() {
        bytes.push(b'\n');
        r.seq += 1;
        r.log_bytes += bytes.len();
        r.log_buf.extend_from_slice(&bytes);
      } else {
        // Can't happen for a JSON value; if it did, the snapshot the commit takes covers it.
        r.compact = true;
      }
    }
    let assets_out = if keep { m.assets } else { None };
    let text_of = |d: &RawValue| {
      let out = DeltaOut {
        kind: "delta",
        from: id,
        delta: d,
        assets: assets_out,
      };
      Arc::new(serde_json::to_string(&out).unwrap_or_default())
    };
    let doc_now = r.doc.as_ref().unwrap();
    let others = |f: &dyn Fn(&Peer) -> bool| r.peers.iter().any(|(pid, p)| *pid != id && f(p));
    let to_raw = |v: &Value| serde_json::value::to_raw_value(v).ok();
    // Editors that read `text` get the delta as sent.
    let raw_text = others(&|p| p.text).then(|| text_of(raw));
    // The others get each `text` entry as the layer's whole text from the room's document; the
    // `lists` and per-id rewrites below build on that.
    let no_text = others(&|p| !p.text);
    let untexted = no_text.then(|| designotron_engine::collab::legacy_text(&delta, doc_now)).flatten();
    let untexted_raw = untexted.as_ref().and_then(to_raw);
    let base: &Value = untexted.as_ref().unwrap_or(&delta);
    let lists_text = others(&|p| p.lists && !p.text).then(|| match &untexted_raw {
      Some(w) => text_of(w),
      None => raw_text.clone().unwrap_or_else(|| text_of(raw)),
    });
    // Editors that predate `lists` get whole child lists and comments, and the layers pruned.
    let older_lists = others(&|p| !p.lists);
    let rewritten = older_lists
      .then(|| designotron_engine::collab::legacy_lists(base, doc_now, &pruned))
      .flatten();
    let rewritten_raw = rewritten.as_ref().and_then(to_raw);
    let gran_text = match &rewritten_raw {
      Some(w) => Some(text_of(w)),
      None => older_lists.then(|| lists_text.clone().or_else(|| raw_text.clone()).unwrap_or_else(|| text_of(raw))),
    };
    // Peers that predate per-id changes get the room's whole lists instead.
    let whole = others(&|p| !p.granular)
      .then(|| designotron_engine::collab::legacy(rewritten.as_ref().unwrap_or(base), doc_now))
      .flatten()
      .and_then(|w| to_raw(&w));
    let old_text = whole.as_deref().map(text_of).or_else(|| gran_text.clone());
    // Older models get each variant once, rewritten (On drag dropped, sticky as scroll).
    let mut by_model: [ModelTexts; 4] = Default::default();
    let to: Vec<(Outbox, Arc<String>)> = r
      .peers
      .iter()
      .filter(|(pid, _)| **pid != id)
      .filter_map(|(_, p)| {
        let (variant, text) = if p.text {
          (0, raw_text.clone())
        } else if p.lists {
          (1, lists_text.clone())
        } else if p.granular {
          (2, gran_text.clone())
        } else {
          (3, old_text.clone())
        };
        text.map(|t| (p.out.clone(), by_model[variant].get(&t, p.model)))
      })
      .collect();
    for (o, text) in to {
      self.put(r, &o, text, false);
    }
    self.ack(r, id, false);
    // An editor that predates `lists` doesn't prune: it is given the layers the room pruned.
    if !pruned.is_empty() && r.peers.get(&id).is_some_and(|p| !p.lists) {
      let nothing = json!({ "nodes": {}, "removed": [], "comments": {}, "commentsRemoved": [] });
      let fix = designotron_engine::collab::legacy_lists(&nothing, r.doc.as_ref().unwrap(), &pruned)
        .and_then(|v| serde_json::value::to_raw_value(&v).ok());
      if let (Some(fix), Some(out)) = (fix, r.peers.get(&id).map(|p| p.out.clone())) {
        let text = DeltaOut {
          kind: "delta",
          from: id,
          delta: &fix,
          assets: None,
        };
        // It carries whole layers from the room's document: in the sender's model.
        let model = r.peers.get(&id).map_or(UNSAID_MODEL, |p| p.model);
        self.put(
          r,
          &out,
          for_model(&Arc::new(serde_json::to_string(&text).unwrap_or_default()), model),
          false,
        );
      }
    }
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

  /// Loads a saved room from disk: its snapshot, then the log's changes made after it.
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
      /// Absent in files from before room logs.
      #[serde(default)]
      seq: u64,
    }
    let Ok(f) = serde_json::from_str::<File>(&text) else { return };
    let Ok(mut doc) = serde_json::from_str::<Document>(f.doc.get()) else {
      return;
    };
    let mut assets = f.assets;
    let mut doc_bytes = f.doc.get().len();
    room.seq = f.seq;
    if let Some(log_path) = self.log_file(id) {
      if let Ok(bytes) = tokio::fs::read(&log_path).await {
        let r = replay(&mut doc, &mut assets, f.seq, &bytes);
        if r.good < bytes.len() {
          // A torn tail (a write the crash cut short, never acknowledged): cut it off, or later
          // lines would sit behind it and never replay.
          log::warn!("room {}: dropped {} bytes of a torn log tail", tag(id), bytes.len() - r.good);
          if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&log_path) {
            let _ = file.set_len(r.good as u64).and_then(|_| file.sync_data());
          }
          // Whether or not the cut worked, the first commit snapshots and empties the log
          // before anything is appended behind garbage.
          room.compact = true;
          room.dirty = true;
        }
        room.log_bytes = r.good;
        if r.applied > 0 {
          log::info!("room {}: replayed {} logged changes", tag(id), r.applied);
          room.seq = room.seq.max(r.last);
          room.dirty = true;
          doc_bytes = json_size(&doc);
        }
      }
    }
    room.doc = Some(doc);
    room.assets = assets;
    let asset_bytes = assets_size(&room.assets);
    self.set_bytes(room, doc_bytes, asset_bytes);
    room.measured = (doc_bytes, Some(Instant::now()));
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
  fn ack(&self, room: &mut Room, to: u64, rejected: bool) {
    if let Some(out) = room.peers.get(&to).map(|p| p.out.clone()) {
      let text = if rejected {
        r#"{"type":"ack","rejected":true}"#
      } else {
        r#"{"type":"ack"}"#
      };
      self.put(room, &out, Arc::new(text.to_string()), true);
    }
  }

  /// Sends `text` to `out`, or, in a room with a log, queues it behind the changes not yet on
  /// disk (see `commit`). Everything about the change stream goes through here, so peers see
  /// changes and acknowledgements in the order the room applied them.
  fn put(&self, room: &mut Room, out: &Outbox, text: Arc<String>, direct: bool) {
    if self.data_dir.is_some() {
      room.held.push(Held {
        out: out.clone(),
        text,
        direct,
      });
    } else if direct {
      out.send_shared(text);
    } else {
      self.deliver(out, &text, false);
    }
  }

  /// `broadcast` for peers coming, going and renaming: behind whatever is held (a re-sharer's
  /// welcome carries the peer list as of its join, so a later `peer` or `leave` must not overtake it).
  fn notify(&self, room: &mut Room, from: u64, msg: &impl Serialize) {
    if self.data_dir.is_some() && !room.held.is_empty() {
      self.hold_broadcast(room, from, msg);
    } else {
      self.broadcast(room, from, msg, false);
    }
  }

  /// `broadcast` for messages that belong to the change stream.
  fn hold_broadcast(&self, room: &mut Room, from: u64, msg: &impl Serialize) {
    if !room.peers.keys().any(|id| *id != from) {
      return;
    }
    self.hold_text(room, from, serde_json::to_string(msg).unwrap_or_default());
  }

  fn hold_text(&self, room: &mut Room, from: u64, text: String) {
    let text = Arc::new(text);
    let to: Vec<Outbox> = room
      .peers
      .iter()
      .filter(|(id, _)| **id != from)
      .map(|(_, p)| p.out.clone())
      .collect();
    for out in to {
      self.put(room, &out, text.clone(), false);
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
    self.deliver_at(out, text, droppable, out.meter.queued.load(Ordering::Relaxed));
  }

  /// `deliver`, judging the backlog as `queued` bytes.
  fn deliver_at(&self, out: &Outbox, text: &Arc<String>, droppable: bool, queued: usize) {
    let len = text.len();
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

impl Role {
  /// The name sent to editors for viewers (editors need none).
  fn name(self) -> Option<&'static str> {
    (self == Role::Viewer).then_some("viewer")
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
    self.send_shared(Arc::new(text));
  }

  fn send_shared(&self, text: Arc<String>) {
    self.meter.queue(text.len());
    let _ = self.tx.send(text);
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

/// What `replay` found in a log.
struct Replayed {
  /// Bytes up to the end of the last good line.
  good: usize,
  /// Changes applied (lines newer than the snapshot).
  applied: usize,
  /// The number of the last line.
  last: u64,
}

/// Applies the log's changes with a number above `snapshot_seq` to `doc` (the others are already
/// in the snapshot: a crash can fall between writing it and emptying the log). Stops at the first
/// line that is incomplete or unreadable.
fn replay(doc: &mut Document, assets: &mut Map<String, Value>, snapshot_seq: u64, log: &[u8]) -> Replayed {
  let mut out = Replayed {
    good: 0,
    applied: 0,
    last: snapshot_seq,
  };
  for line in log.split_inclusive(|b| *b == b'\n') {
    if line.last() != Some(&b'\n') {
      break;
    }
    let Ok(l) = serde_json::from_slice::<LogLine>(line) else { break };
    out.good += line.len();
    if l.seq <= snapshot_seq {
      continue;
    }
    out.last = out.last.max(l.seq);
    match designotron_engine::collab::apply_opts(doc, &l.delta, PRUNE) {
      Ok(_) => out.applied += 1,
      Err(e) => log::warn!("skipped a logged change that no longer applies: {e}"),
    }
    for (k, v) in l.assets.iter().flat_map(|a| a.iter()) {
      assets.insert(k.clone(), v.clone());
    }
  }
  out
}

/// Makes a new or renamed file's directory entry durable.
fn sync_dir(file: &std::path::Path) -> std::io::Result<()> {
  #[cfg(unix)]
  if let Some(dir) = file.parent() {
    let dir = if dir.as_os_str().is_empty() {
      std::path::Path::new(".")
    } else {
      dir
    };
    return match std::fs::File::open(dir)?.sync_all() {
      // Some filesystems (FUSE, 9p, virtiofs) refuse fsync on a directory. Like PostgreSQL,
      // treat that as "not supported here" rather than failing every write.
      // EINVAL and EBADF are 22 and 9 on Linux and macOS.
      Err(e) if matches!(e.raw_os_error(), Some(22 | 9)) => Ok(()),
      other => other,
    };
  }
  let _ = file;
  Ok(())
}

/// A short stand-in for a room id in logs (the id is the access token to the room).
fn tag(room_id: &str) -> String {
  let digest = Sha256::digest(format!("designotron-log\0{room_id}").as_bytes());
  digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
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

  fn peer(rooms: &Rooms, granular: bool, lists: bool) -> (Peer, mpsc::UnboundedReceiver<Arc<String>>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let out = Outbox {
      tx,
      meter: Arc::new(Meter::new(rooms.conn_bytes.clone())),
      kick: Arc::new(Notify::new()),
    };
    (
      Peer {
        out,
        name: "p".into(),
        color: "#000".into(),
        presence: Value::Null,
        granular,
        lists,
        text: false,
        model: MODEL_REVISION,
        role: Role::Editor,
      },
      rx,
    )
  }

  /// An editor that predates effect and grid styles sends whole `styles` without them; the room
  /// keeps its own lists and forwards the repaired delta.
  #[tokio::test]
  async fn an_old_editors_whole_styles_do_not_wipe_effect_and_grid_styles() {
    let rooms = Rooms::new(Limits::default(), None);
    let mut doc = designotron_engine::doc::new_document(&mut designotron_engine::doc::IdGen::new(1), "t");
    doc.styles_mut().effects.push(designotron_engine::model::EffectStyle {
      id: "e1".into(),
      name: "Shadow".into(),
      ..Default::default()
    });
    doc.styles_mut().grids.push(designotron_engine::model::GridStyle {
      id: "g1".into(),
      name: "Grid".into(),
      ..Default::default()
    });
    let mut r = Room {
      doc: Some(doc),
      ..Room::default()
    };
    let (old, mut old_rx) = peer(&rooms, false, false);
    let (new, mut new_rx) = peer(&rooms, true, false);
    r.peers.insert(1, old);
    r.peers.insert(2, new);
    let msg =
      r##"{"type":"delta","delta":{"nodes":{},"removed":[],"styles":{"colors":[{"id":"c1","name":"C","color":"#111111"}],"texts":[]}}}"##;
    let m: Incoming = serde_json::from_str(msg).unwrap();
    rooms.delta(&mut r, 1, Role::Editor, &m, msg.len());
    let doc = r.doc.as_ref().unwrap();
    assert_eq!(
      (doc.styles.colors.len(), doc.styles.effects.len(), doc.styles.grids.len()),
      (1, 1, 1)
    );
    // The granular peer is sent the repaired whole `styles` (its colour change, the room's other lists).
    let got: Value = serde_json::from_str(&new_rx.try_recv().expect("forwarded")).unwrap();
    assert_eq!(got["delta"]["styles"]["effects"][0]["id"], "e1");
    assert_eq!(got["delta"]["styles"]["grids"][0]["id"], "g1");
    // The sender only gets its ack.
    let ack: Value = serde_json::from_str(&old_rx.try_recv().unwrap()).unwrap();
    assert_eq!(ack["type"], "ack");
  }

  /// Temp files left by an interrupted write are removed at start; room files stay.
  #[test]
  fn stray_temp_files_are_removed_at_start() {
    let dir = std::env::temp_dir().join(format!("dt-rooms-tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("room1.json"), "{}").unwrap();
    std::fs::write(dir.join("room1.json.7.tmp"), "{\"half").unwrap();
    let _rooms = Rooms::new(Limits::default(), Some(dir.clone()));
    assert!(dir.join("room1.json").exists());
    assert!(!dir.join("room1.json.7.tmp").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  fn tmp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dt-rooms-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  const ROOM: &str = "room0123456789abcdef";

  /// One room served without sockets: `join`, `send` and `commit` do what a connection's task does.
  struct Harness {
    rooms: Arc<Rooms>,
    room: Arc<Mutex<Room>>,
    io: Arc<Mutex<RoomLog>>,
    next: u64,
    /// Each joined connection's `kick`.
    kicks: Vec<Arc<Notify>>,
  }

  type Rx = mpsc::UnboundedReceiver<Arc<String>>;

  impl Harness {
    async fn open(dir: &std::path::Path) -> Harness {
      Self::with(Rooms::new(Limits::default(), Some(dir.to_path_buf()))).await
    }

    async fn with(rooms: Arc<Rooms>) -> Harness {
      let room = rooms.room(ROOM).await.unwrap();
      let io = room.lock().await.io.clone();
      Harness {
        rooms,
        room,
        io,
        next: 0,
        kicks: Vec::new(),
      }
    }

    async fn commit(&self) {
      self.rooms.clone().commit(ROOM.into(), self.room.clone(), self.io.clone()).await;
    }

    /// Joins (committing like a connection does); returns the person's id, the welcome and the receiver.
    async fn join(&mut self, doc: Option<Value>, reset: bool) -> (u64, Value, Rx) {
      let (id, mut rx) = self.join_uncommitted(doc, reset).await;
      self.commit().await;
      let welcome: Value = serde_json::from_str(&rx.try_recv().expect("welcome")).unwrap();
      (id, welcome, rx)
    }

    async fn join_uncommitted(&mut self, doc: Option<Value>, reset: bool) -> (u64, Rx) {
      self.join_as(doc, reset, true, false).await
    }

    /// Joins as an editor of the given dialect (`granular`: per-id changes, `lists`: moves and
    /// per-message comments); the welcome is the first message in the receiver.
    async fn join_as(&mut self, doc: Option<Value>, reset: bool, granular: bool, lists: bool) -> (u64, Rx) {
      self.join_model(doc, reset, granular, lists, None).await
    }

    /// `join_as` for an editor that says its document model revision (or none, like editors
    /// that predate revision 4).
    async fn join_model(&mut self, doc: Option<Value>, reset: bool, granular: bool, lists: bool, model: Option<u32>) -> (u64, Rx) {
      self.join_full(doc, reset, granular, lists, false, model).await
    }

    /// `join_model` for an editor that may also say `text`.
    async fn join_full(
      &mut self,
      doc: Option<Value>,
      reset: bool,
      granular: bool,
      lists: bool,
      text: bool,
      model: Option<u32>,
    ) -> (u64, Rx) {
      self.next += 1;
      let id = self.next;
      let (tx, rx) = mpsc::unbounded_channel();
      let out = Outbox {
        tx,
        meter: Arc::new(Meter::new(self.rooms.conn_bytes.clone())),
        kick: Arc::new(Notify::new()),
      };
      self.kicks.push(out.kick.clone());
      let mut msg =
        json!({ "type": "join", "name": "p", "color": "#000", "granular": granular, "lists": lists, "text": text, "reset": reset });
      if let Some(d) = doc {
        msg["doc"] = d;
      }
      if let Some(model) = model {
        msg["model"] = json!(model);
      }
      let text = msg.to_string();
      let m: Incoming = serde_json::from_str(&text).unwrap();
      let mut r = self.room.lock().await;
      let step = self.rooms.join(ROOM, &mut r, id, Role::Editor, &out, &m, text.len()).await;
      assert!(matches!(step, Step::Go));
      (id, rx)
    }

    /// `join_as` for a lists editor, committed, with its welcome read.
    async fn join_as_welcomed(&mut self, doc: Option<Value>, reset: bool) -> (u64, Value, Rx) {
      let (id, mut rx) = self.join_as(doc, reset, true, true).await;
      self.commit().await;
      let welcome: Value = serde_json::from_str(&rx.try_recv().expect("welcome")).unwrap();
      (id, welcome, rx)
    }

    async fn delta_text(&self, id: u64, text: &str) {
      let m: Incoming = serde_json::from_str(text).unwrap();
      let mut r = self.room.lock().await;
      self.rooms.delta(&mut r, id, Role::Editor, &m, text.len());
    }

    /// Applies a change from `id` without committing.
    async fn send_uncommitted(&self, id: u64, x: f64) {
      self.delta_text(id, &comment_delta(x)).await;
    }

    async fn send(&self, id: u64, x: f64) {
      self.send_uncommitted(id, x).await;
      self.commit().await;
    }
  }

  /// A document with a frame holding layers A, B, C and T, a rectangle R bound to a variable, and
  /// the variable; and the ids.
  fn lists_doc() -> (Value, Vec<String>) {
    use designotron_engine::engine::{Command, Engine};
    let mut e = Engine::new(Box::new(designotron_engine::text::HeuristicMeasurer), 5);
    let mut make = |kind: designotron_engine::model::NodeType, parent: Option<String>| {
      e.dispatch(Command::CreateShape {
        kind,
        x: 0.0,
        y: 0.0,
        width: 20.0,
        height: 20.0,
        parent,
      })
      .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
    };
    use designotron_engine::model::NodeType::{Frame, Rectangle};
    let r = make(Rectangle, None);
    let frame = make(Frame, None);
    let mut ids = vec![frame.clone()];
    for _ in 0..4 {
      ids.push(make(Rectangle, Some(frame.clone())));
    }
    ids.push(r.clone());
    e.dispatch(Command::Ai {
      tool: "define_variables".into(),
      input: json!({ "collection": "Theme", "variables": [{ "name": "Ink", "type": "color", "value": "#112233" }] }),
    })
    .unwrap();
    let var = e.doc.variables[0].variables[0].id.clone();
    e.dispatch(Command::BindVariable {
      ids: vec![r],
      property: "fill".into(),
      variable: Some(var.clone()),
    })
    .unwrap();
    ids.push(var);
    (serde_json::to_value(&e.doc).unwrap(), ids)
  }

  /// `{type: delta, delta}` for a hand-written change.
  fn delta_msg(delta: Value) -> String {
    json!({ "type": "delta", "delta": delta }).to_string()
  }

  #[tokio::test]
  async fn the_welcome_says_lists_and_only_lists_editors_get_moves() {
    let dir = tmp_dir("lists-welcome");
    let mut h = Harness::open(&dir).await;
    let (doc, ids) = lists_doc();
    let frame = ids[0].clone();
    let (ana, welcome, mut ana_rx) = {
      let (id, mut rx) = h.join_as(Some(doc), true, true, true).await;
      h.commit().await;
      let w: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
      (id, w, rx)
    };
    assert_eq!((welcome["lists"].clone(), welcome["granular"].clone()), (json!(true), json!(true)));
    // Ben speaks `lists`, Cai only per-id changes, Dan only whole lists.
    let (_ben, mut ben_rx) = h.join_as(None, false, true, true).await;
    let (_cai, mut cai_rx) = h.join_as(None, false, true, false).await;
    let (_dan, mut dan_rx) = h.join_as(None, false, false, false).await;
    h.commit().await;
    for rx in [&mut ben_rx, &mut cai_rx, &mut dan_rx] {
      let w = drain(rx).into_iter().find(|m| m["type"] == "welcome").unwrap();
      assert_eq!(w["lists"], json!(true), "the room always offers it");
    }
    drain(&mut ana_rx);
    // Ana takes A (ids[1]) to the front, replies to a comment, and the room is told what moved.
    let (a, b, c, t) = (ids[1].clone(), ids[2].clone(), ids[3].clone(), ids[4].clone());
    let new = json!([b, c, t, a]);
    let create = json!({ "nodes": {}, "removed": [], "commentsRemoved": [],
      "comments": { "c1": { "id": "c1", "page": "p", "x": 0.0, "y": 0.0, "messages": [{ "author": "Ana", "text": "Q", "time": 1.0 }] } } });
    h.delta_text(ana, &delta_msg(create)).await;
    h.commit().await;
    for rx in [&mut ben_rx, &mut cai_rx, &mut dan_rx] {
      drain(rx);
    }
    let change = json!({ "nodes": {}, "removed": [], "comments": {}, "commentsRemoved": [],
      "patch": { frame.clone(): { "children": new.clone() } },
      "moves": { frame.clone(): [a.clone()] },
      "commentChanges": { "c1": { "add": [{ "author": "Ana", "text": "R", "time": 2.0 }] } } });
    h.delta_text(ana, &delta_msg(change)).await;
    h.commit().await;
    let ben = &drain(&mut ben_rx)[0]["delta"];
    assert_eq!(ben["moves"][&frame], json!([a]), "a lists editor gets the delta as sent");
    assert_eq!(ben["commentChanges"]["c1"]["add"][0]["text"], "R");
    for (name, rx) in [("cai", &mut cai_rx), ("dan", &mut dan_rx)] {
      let got = drain(rx);
      let d = &got[0]["delta"];
      assert!(d.get("moves").is_none() && d.get("commentChanges").is_none(), "{name}: {d}");
      assert_eq!(d["patch"][&frame]["children"], new, "{name}: the room's whole child list");
      assert_eq!(
        d["comments"]["c1"]["messages"].as_array().unwrap().len(),
        2,
        "{name}: the whole thread"
      );
    }
    // The room's document holds the placed order and both messages.
    let r = h.room.lock().await;
    let doc = r.doc.as_ref().unwrap();
    assert_eq!(doc.get(&frame).unwrap().children, [b, c, t, a]);
    assert_eq!(doc.comments["c1"].messages.len(), 2);
  }

  /// A frame with a sticky layer and On drag, a click interaction, and a Move one.
  fn v4_doc() -> (Value, String) {
    let (mut doc, ids) = lists_doc();
    let frame = ids[0].clone();
    doc["nodes"][&frame]["scrollBehavior"] = json!("sticky");
    doc["nodes"][&frame]["interactions"] = json!([
      { "trigger": "onDrag", "action": "navigate", "transition": "smartAnimate" },
      { "trigger": "onClick", "action": "navigate", "transition": "push", "direction": "left" }
    ]);
    (doc, frame)
  }

  fn v4_change(frame: &str) -> String {
    delta_msg(json!({ "nodes": {}, "removed": [], "comments": {}, "commentsRemoved": [],
      "patch": { frame: { "scrollBehavior": "sticky",
        "interactions": [{ "trigger": "onDrag", "action": "back" }, { "trigger": "onClick", "action": "back" }] } } }))
  }

  #[tokio::test]
  async fn older_editors_are_sent_sticky_as_scroll_and_no_on_drag() {
    let dir = tmp_dir("model-peers");
    let mut h = Harness::open(&dir).await;
    let (doc, frame) = v4_doc();
    let (ana, _) = h.join_model(Some(doc), true, true, true, Some(4)).await;
    h.commit().await;
    // Ben joins without a model (revision 3), Cai says 4, Dan says 2.
    let (_ben, mut ben_rx) = h.join_model(None, false, true, true, None).await;
    let (_cai, mut cai_rx) = h.join_model(None, false, true, true, Some(4)).await;
    let (_dan, mut dan_rx) = h.join_model(None, false, true, true, Some(2)).await;
    h.commit().await;
    let welcomes: Vec<Value> = [&mut ben_rx, &mut cai_rx, &mut dan_rx]
      .into_iter()
      .map(|rx| drain(rx).into_iter().find(|m| m["type"] == "welcome").unwrap())
      .collect();
    let node = |w: &Value| w["doc"]["nodes"][&frame].clone();
    assert_eq!(node(&welcomes[0])["scrollBehavior"], "scroll");
    assert_eq!(node(&welcomes[0])["interactions"].as_array().unwrap().len(), 1);
    assert_eq!(node(&welcomes[0])["interactions"][0]["trigger"], "onClick");
    assert_eq!(node(&welcomes[0])["interactions"][0]["transition"], "push", "revision 3 keeps Push");
    assert_eq!(welcomes[0]["model"], 4, "the room says its own model");
    assert_eq!(node(&welcomes[1])["scrollBehavior"], "sticky");
    assert_eq!(node(&welcomes[1])["interactions"].as_array().unwrap().len(), 2);
    assert_eq!(
      node(&welcomes[2])["interactions"][0]["transition"],
      "slideLeft",
      "revision 2 gets the old names too"
    );
    // A change from Ana: raw for Cai, downgraded for Ben and Dan, and the room keeps it whole.
    h.delta_text(ana, &v4_change(&frame)).await;
    h.commit().await;
    let get = |rx: &mut Rx| drain(rx).into_iter().find(|m| m["type"] == "delta").unwrap()["delta"]["patch"][&frame].clone();
    let (ben, cai, dan) = (get(&mut ben_rx), get(&mut cai_rx), get(&mut dan_rx));
    assert_eq!(cai["scrollBehavior"], "sticky");
    assert_eq!(cai["interactions"].as_array().unwrap().len(), 2);
    for old in [&ben, &dan] {
      assert_eq!(old["scrollBehavior"], "scroll");
      assert_eq!(old["interactions"].as_array().unwrap().len(), 1);
      assert_eq!(old["interactions"][0]["trigger"], "onClick");
    }
    let r = h.room.lock().await;
    let n = r.doc.as_ref().unwrap().get(&frame).unwrap();
    assert_eq!(n.interactions.len(), 2, "the room stores revision 4 values");
    assert_eq!(n.scroll_behavior, designotron_engine::model::ScrollBehavior::Sticky);
  }

  #[tokio::test]
  async fn a_reload_is_downgraded_for_older_editors_only() {
    let dir = tmp_dir("model-reload");
    let mut h = Harness::open(&dir).await;
    let (doc, frame) = v4_doc();
    let (_ana, _) = h.join_model(Some(doc.clone()), true, true, true, Some(4)).await;
    h.commit().await;
    let (_ben, mut ben_rx) = h.join_model(None, false, true, true, None).await;
    let (_cai, mut cai_rx) = h.join_model(None, false, true, true, Some(4)).await;
    h.commit().await;
    drain(&mut ben_rx);
    drain(&mut cai_rx);
    let (_dee, _) = h.join_model(Some(doc), true, true, true, Some(4)).await;
    h.commit().await;
    let reload = |rx: &mut Rx| drain(rx).into_iter().find(|m| m["type"] == "reload").unwrap()["doc"]["nodes"][&frame].clone();
    let (ben, cai) = (reload(&mut ben_rx), reload(&mut cai_rx));
    assert_eq!(ben["scrollBehavior"], "scroll");
    assert_eq!(ben["interactions"].as_array().unwrap().len(), 1);
    assert_eq!(cai["scrollBehavior"], "sticky");
    assert_eq!(cai["interactions"].as_array().unwrap().len(), 2);
  }

  #[tokio::test]
  async fn concurrent_replies_through_the_room_both_stay() {
    let dir = tmp_dir("lists-replies");
    let mut h = Harness::open(&dir).await;
    let (doc, _) = lists_doc();
    let (ana, _, _) = h.join_as_welcomed(Some(doc), true).await;
    let (ben, _) = h.join_as(None, false, true, true).await;
    let (cai, _) = h.join_as(None, false, true, true).await;
    h.commit().await;
    let create = json!({ "nodes": {}, "removed": [], "commentsRemoved": [],
      "comments": { "c1": { "id": "c1", "page": "p", "x": 0.0, "y": 0.0, "messages": [{ "author": "Ana", "text": "Q1", "time": 1.0 }] } } });
    h.delta_text(ana, &delta_msg(create)).await;
    let reply = |who: &str, time: f64| {
      delta_msg(json!({ "nodes": {}, "removed": [], "comments": {}, "commentsRemoved": [],
        "commentChanges": { "c1": { "add": [{ "author": who, "text": format!("{who}-1"), "time": time }] } } }))
    };
    // Both replied to [Q1]; Cai's reaches the room first, with the later client clock.
    h.delta_text(cai, &reply("Cai", 9.0)).await;
    h.delta_text(ben, &reply("Ben", 3.0)).await;
    h.commit().await;
    let r = h.room.lock().await;
    let texts: Vec<_> = r.doc.as_ref().unwrap().comments["c1"]
      .messages
      .iter()
      .map(|m| m.text.clone())
      .collect();
    assert_eq!(texts, ["Q1", "Cai-1", "Ben-1"], "the room's order, not the clocks'");
  }

  #[tokio::test]
  async fn a_pruned_layer_reaches_older_peers_whole_and_lists_peers_prune_themselves() {
    let dir = tmp_dir("lists-prune");
    let mut h = Harness::open(&dir).await;
    let (mut doc, ids) = lists_doc();
    let (rect, var) = (ids[5].clone(), ids[6].clone());
    // The pruned layer is a revision 4 one: an editor without `model` must get it as scroll.
    doc["nodes"][&rect]["scrollBehavior"] = json!("sticky");
    let (ana, _, mut ana_rx) = h.join_as_welcomed(Some(doc), true).await;
    let (_ben, mut ben_rx) = h.join_as(None, false, true, true).await;
    let (cai, mut cai_rx) = h.join_as(None, false, true, false).await;
    h.commit().await;
    drain(&mut ben_rx);
    drain(&mut cai_rx);
    drain(&mut ana_rx);
    // Ana deletes the variable (her own copy would unbind R, but this change doesn't say so: another
    // editor's bind that the room orders after it has the same effect).
    let colls = {
      let r = h.room.lock().await;
      r.doc.as_ref().unwrap().variables[0].id.clone()
    };
    let delete = json!({ "nodes": {}, "removed": [], "comments": {}, "commentsRemoved": [],
      "variableChanges": { colls.clone(): { "del": [var.clone()] } } });
    h.delta_text(ana, &delta_msg(delete)).await;
    h.commit().await;
    {
      let r = h.room.lock().await;
      assert!(
        r.doc.as_ref().unwrap().get(&rect).unwrap().bindings.is_empty(),
        "the room pruned the dangling binding"
      );
    }
    // A lists peer is sent the delta as it was: it prunes by itself.
    let ben = drain(&mut ben_rx);
    assert!(
      ben[0]["delta"].get("nodes").is_none_or(|n| n.as_object().unwrap().is_empty()),
      "{}",
      ben[0]
    );
    // An older peer is sent the layer whole, without the link.
    let cai_got = drain(&mut cai_rx);
    assert_eq!(cai_got[0]["delta"]["nodes"][&rect]["id"], json!(rect));
    assert!(cai_got[0]["delta"]["nodes"][&rect]["bindings"]
      .as_object()
      .is_none_or(|b| b.is_empty()));
    // The editor that sent it is a lists one, and hears only its ack.
    assert_eq!(types(&drain(&mut ana_rx)), ["ack"]);
    // An older editor that causes a prune is told what the room pruned right after its ack.
    let bind = json!({ "nodes": {}, "removed": [], "comments": {}, "commentsRemoved": [],
      "patch": { rect.clone(): { "bindings": { "fill": "gone-variable" } } } });
    h.delta_text(cai, &delta_msg(bind)).await;
    h.commit().await;
    let got = drain(&mut cai_rx);
    assert_eq!(got[0]["type"], "ack");
    assert_eq!(got[1]["type"], "delta");
    assert_eq!(got[1]["delta"]["nodes"][&rect]["id"], json!(rect));
    assert!(got[1]["delta"]["nodes"][&rect]["bindings"].as_object().is_none_or(|b| b.is_empty()));
    assert_eq!(
      got[1]["delta"]["nodes"][&rect]["scrollBehavior"].as_str().unwrap_or("scroll"),
      "scroll",
      "the repair is in the sender's model too"
    );
    assert_eq!(
      cai_got[0]["delta"]["nodes"][&rect]["scrollBehavior"].as_str().unwrap_or("scroll"),
      "scroll"
    );
  }

  #[test]
  fn viewers_may_reply_and_resolve_through_comment_changes_only() {
    use designotron_engine::model::{Comment, CommentMessage};
    let mut doc = designotron_engine::doc::new_document(&mut designotron_engine::doc::IdGen::new(1), "t");
    doc.comments_mut().insert(
      "c1".into(),
      Comment {
        id: "c1".into(),
        page: "p".into(),
        messages: vec![CommentMessage {
          author: "Ana".into(),
          text: "Q".into(),
          time: 1.0,
        }],
        ..Default::default()
      },
    );
    let wrap = |changes: Value| json!({ "nodes": {}, "removed": [], "comments": {}, "commentsRemoved": [], "commentChanges": changes });
    let reply = json!({ "author": "Vic", "text": "hi", "time": 5.0 });
    let ok = viewer_delta(
      &wrap(json!({ "c1": { "add": [reply.clone()], "set": { "resolved": true } } })),
      &doc,
    )
    .expect("a reply and a resolve");
    assert_eq!(ok["commentChanges"]["c1"]["add"][0]["text"], "hi");
    assert_eq!(ok["commentChanges"]["c1"]["set"], json!({ "resolved": true }));
    assert!(ok["comments"].as_object().unwrap().is_empty());
    // Rebuilt from typed values: unknown keys on a message are gone.
    let sneaky = json!({ "author": "Vic", "text": "hi", "time": 5.0, "page": "x", "extra": 1 });
    let ok = viewer_delta(&wrap(json!({ "c1": { "add": [sneaky] } })), &doc).unwrap();
    assert_eq!(
      ok["commentChanges"]["c1"]["add"][0],
      json!({ "author": "Vic", "text": "hi", "time": 5.0 })
    );
    // Never: removing a message, moving or re-homing the thread, or anything else in the change.
    for bad in [
      json!({ "c1": { "del": [["Ana", 1.0, "Q"]] } }),
      json!({ "c1": { "set": { "x": 3.0 } } }),
      json!({ "c1": { "set": { "y": 3.0 } } }),
      json!({ "c1": { "set": { "node": "n" } } }),
      json!({ "c1": { "set": { "page": "q" } } }),
      json!({ "c1": { "set": { "resolved": "yes" } } }),
      json!({ "c1": { "other": 1 } }),
      json!({ "c1": { "add": [{ "author": "x", "text": "t".repeat(VIEWER_MAX_TEXT + 1), "time": 1.0 }] } }),
      json!({ "c1": { "add": (0..=VIEWER_MAX_NEW_MESSAGES).map(|i| json!({ "author": "x", "text": "t", "time": i })).collect::<Vec<_>>() } }),
      json!({ "c1": { "add": [{ "author": "x".repeat(201), "text": "t", "time": 1.0 }] } }),
      json!({ "c1": { "add": [5] } }),
      json!({}),
    ] {
      assert!(viewer_delta(&wrap(bad.clone()), &doc).is_none(), "{bad}");
    }
    // An empty `del` is harmless; a delta that also carries other parts is not.
    assert!(viewer_delta(&wrap(json!({ "c1": { "add": [reply.clone()], "del": [] } })), &doc).is_some());
    let mut with_nodes = wrap(json!({ "c1": { "add": [reply.clone()] } }));
    with_nodes["pages"] = json!([]);
    assert!(viewer_delta(&with_nodes, &doc).is_none());
    // The whole-comment form older editors send keeps working, and a new thread may be sent beside a reply.
    let whole = json!({ "nodes": {}, "removed": [], "commentsRemoved": [], "comments": { "c1": { "id": "c1", "page": "p", "x": 0.0, "y": 0.0, "resolved": false,
      "messages": [{ "author": "Ana", "text": "Q", "time": 1.0 }, { "author": "Vic", "text": "hi", "time": 5.0 }] } } });
    assert!(viewer_delta(&whole, &doc).is_some());
    let mut both = whole.clone();
    both["comments"]["c2"] =
      json!({ "id": "c2", "page": "p", "x": 1.0, "y": 1.0, "messages": [{ "author": "Vic", "text": "new", "time": 6.0 }] });
    both["comments"].as_object_mut().unwrap().remove("c1");
    both["commentChanges"] = json!({ "c1": { "add": [reply] } });
    let d = viewer_delta(&both, &doc).unwrap();
    assert!(d["comments"]["c2"].is_object() && d["commentChanges"]["c1"].is_object());
  }

  #[tokio::test]
  async fn replaying_the_log_reproduces_the_pruned_document() {
    let dir = tmp_dir("lists-replay");
    let (doc, ids) = lists_doc();
    let (rect, var) = (ids[5].clone(), ids[6].clone());
    let colls = doc["variables"][0]["id"].as_str().unwrap().to_string();
    let first = {
      let mut h = Harness::open(&dir).await;
      let (ana, _, _) = h.join_as_welcomed(Some(doc.clone()), true).await;
      let delete = json!({ "nodes": {}, "removed": [], "comments": {}, "commentsRemoved": [],
        "variableChanges": { colls: { "del": [var] } } });
      h.delta_text(ana, &delta_msg(delete)).await;
      h.commit().await;
      let r = h.room.lock().await;
      assert!(r.doc.as_ref().unwrap().get(&rect).unwrap().bindings.is_empty());
      serde_json::to_value(r.doc.as_ref().unwrap()).unwrap()
    };
    // A crash: the snapshot is the shared file as first saved, the log holds the delete.
    let mut h = Harness::open(&dir).await;
    let (_, w, _) = h.join_as_welcomed(None, false).await;
    assert_eq!(
      w["doc"]["nodes"][&rect]["bindings"], first["nodes"][&rect]["bindings"],
      "the replayed layer is unbound too"
    );
    assert_eq!(w["doc"]["nodes"], first["nodes"]);
    assert_eq!(w["doc"]["variables"], first["variables"]);
  }

  fn comment_delta_body(x: f64) -> Value {
    json!({ "nodes": {}, "removed": [], "commentsRemoved": [],
      "comments": { "c1": { "id": "c1", "page": "p", "x": x, "y": 0.0, "messages": [] } } })
  }

  fn comment_delta(x: f64) -> String {
    json!({ "type": "delta", "delta": comment_delta_body(x) }).to_string()
  }

  fn sample_doc() -> Value {
    serde_json::to_value(designotron_engine::doc::new_document(
      &mut designotron_engine::doc::IdGen::new(1),
      "t",
    ))
    .unwrap()
  }

  fn drain(rx: &mut Rx) -> Vec<Value> {
    let mut v = Vec::new();
    while let Ok(t) = rx.try_recv() {
      v.push(serde_json::from_str(&t).unwrap());
    }
    v
  }

  fn types(v: &[Value]) -> Vec<String> {
    v.iter().map(|m| m["type"].as_str().unwrap().to_string()).collect()
  }

  /// What a person joining a fresh `Rooms` on `dir` is told comment c1's x is.
  async fn welcome_x(dir: &std::path::Path) -> Value {
    let mut h = Harness::open(dir).await;
    let (_, w, _) = h.join(None, false).await;
    w["doc"]["comments"]["c1"]["x"].clone()
  }

  /// Acknowledged changes survive a crash: dropping the rooms without `save_all` is what a kill
  /// leaves (the files written so far are all there is).
  #[tokio::test]
  async fn acknowledged_changes_survive_a_crash() {
    let dir = tmp_dir("crash");
    let mut h = Harness::open(&dir).await;
    let (owner, _, mut owner_rx) = h.join(Some(sample_doc()), true).await;
    assert!(dir.join(format!("{ROOM}.json")).exists(), "the shared file is snapshotted first");
    for x in [1.0, 2.0, 3.0] {
      h.send(owner, x).await;
    }
    assert_eq!(types(&drain(&mut owner_rx)), ["ack", "ack", "ack"]);
    drop(h);
    assert_eq!(welcome_x(&dir).await, 3.0, "all three changes were replayed from the log");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Nothing goes out before the sync, and then everything goes out in order.
  #[tokio::test]
  async fn acks_and_broadcasts_wait_for_the_commit_and_keep_their_order() {
    let dir = tmp_dir("order");
    let mut h = Harness::open(&dir).await;
    let (owner, _, mut owner_rx) = h.join(Some(sample_doc()), true).await;
    let (_, _, mut peer_rx) = h.join(None, false).await;
    drain(&mut owner_rx);
    drain(&mut peer_rx);
    for x in [1.0, 2.0, 3.0] {
      h.send_uncommitted(owner, x).await;
    }
    assert!(peer_rx.try_recv().is_err() && owner_rx.try_recv().is_err(), "held until durable");
    h.commit().await;
    let (peer, own) = (drain(&mut peer_rx), drain(&mut owner_rx));
    assert_eq!(types(&peer), ["delta", "delta", "delta"]);
    assert_eq!(types(&own), ["ack", "ack", "ack"]);
    assert_eq!(peer[2]["delta"]["comments"]["c1"]["x"], 3.0);
    let stats = h.rooms.stats().await;
    assert_eq!((stats.log_syncs, stats.log_lines), (1, 3), "one sync for the whole batch");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A rejected change is acknowledged behind the changes held before it.
  #[tokio::test]
  async fn a_rejection_does_not_overtake_held_changes() {
    let dir = tmp_dir("reject");
    let mut h = Harness::open(&dir).await;
    let (owner, _, mut rx) = h.join(Some(sample_doc()), true).await;
    drain(&mut rx);
    h.send_uncommitted(owner, 1.0).await;
    h.delta_text(owner, r#"{"type":"delta","delta":{"nodes":{"n":5}}}"#).await;
    assert!(rx.try_recv().is_err());
    h.commit().await;
    let got = drain(&mut rx);
    assert_eq!((got[0]["rejected"].as_bool(), got[1]["rejected"].as_bool()), (None, Some(true)));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// The last line of a log may be cut short by a crash: it was never acknowledged, so it is
  /// dropped, and changes made after the reload are not stuck behind it.
  #[tokio::test]
  async fn a_torn_log_tail_is_ignored_and_cut_off() {
    let dir = tmp_dir("torn");
    let mut h = Harness::open(&dir).await;
    let (owner, _, _rx) = h.join(Some(sample_doc()), true).await;
    h.send(owner, 1.0).await;
    h.send(owner, 2.0).await;
    drop(h);
    let log = dir.join(format!("{ROOM}.log"));
    let mut f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
    f.write_all(br#"{"seq":3,"delta":{"nodes":{},"comments":{"c1":{"id":"c1","x":9"#)
      .unwrap();
    drop(f);
    let mut h = Harness::open(&dir).await;
    let (owner, w, _rx) = h.join(None, false).await;
    assert_eq!(w["doc"]["comments"]["c1"]["x"], 2.0);
    assert_eq!(
      std::fs::metadata(&log).unwrap().len(),
      0,
      "the first commit after the load snapshots and empties the log"
    );
    h.send(owner, 4.0).await;
    drop(h);
    assert_eq!(welcome_x(&dir).await, 4.0, "a change appended after the reload replays");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A snapshot records the last change it holds; log lines up to it are skipped (a crash can
  /// fall between writing the snapshot and emptying the log).
  #[tokio::test]
  async fn only_log_lines_newer_than_the_snapshot_replay() {
    let dir = tmp_dir("seq");
    let mut doc = designotron_engine::doc::new_document(&mut designotron_engine::doc::IdGen::new(1), "t");
    let c = designotron_engine::model::Comment {
      id: "c1".into(),
      page: "p".into(),
      x: 5.0,
      ..Default::default()
    };
    doc.comments_mut().insert("c1".into(), c);
    let saved = Saved {
      doc: &doc,
      assets: &Map::new(),
      seq: 5,
    };
    std::fs::write(dir.join(format!("{ROOM}.json")), serde_json::to_string(&saved).unwrap()).unwrap();
    let line = |seq: u64| {
      format!(
        "{}\n",
        json!({ "seq": seq, "delta": comment_delta_body(seq as f64), "assets": null })
      )
    };
    std::fs::write(dir.join(format!("{ROOM}.log")), (3..=7).map(line).collect::<String>()).unwrap();
    assert_eq!(welcome_x(&dir).await, 7.0, "6 and 7 replayed on top of the snapshot");
    // 3 to 5 alone would leave 3, 4 or 5 behind if they replayed.
    std::fs::write(dir.join(format!("{ROOM}.log")), (3..=4).map(line).collect::<String>()).unwrap();
    assert_eq!(welcome_x(&dir).await, 5.0, "the snapshot's own value stays");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Files saved before room logs have no `seq`.
  #[tokio::test]
  async fn a_snapshot_without_seq_still_loads() {
    let dir = tmp_dir("old");
    let doc = sample_doc();
    std::fs::write(dir.join(format!("{ROOM}.json")), json!({ "doc": doc, "assets": {} }).to_string()).unwrap();
    let mut h = Harness::open(&dir).await;
    let (owner, w, _rx) = h.join(None, false).await;
    assert_eq!(w["doc"]["name"], doc["name"]);
    h.send(owner, 1.0).await;
    drop(h);
    assert_eq!(welcome_x(&dir).await, 1.0, "its log starts at 1");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Sharing again replaces the document: nothing logged before it comes back, and the
  /// `reload` follows the changes held before it.
  #[tokio::test]
  async fn a_reset_supersedes_the_log_and_its_reload_comes_after_held_changes() {
    let dir = tmp_dir("reset");
    let mut h = Harness::open(&dir).await;
    let (owner, _, mut owner_rx) = h.join(Some(sample_doc()), true).await;
    let (_, _, mut peer_rx) = h.join(None, false).await;
    h.send(owner, 1.0).await;
    drain(&mut owner_rx);
    drain(&mut peer_rx);
    h.send_uncommitted(owner, 2.0).await;
    let (_, _, _fresh_rx) = h.join(Some(sample_doc()), true).await;
    assert_eq!(
      types(&drain(&mut peer_rx)),
      ["delta", "reload", "peer"],
      "the reload follows the change before it"
    );
    drop(h);
    assert_eq!(welcome_x(&dir).await, Value::Null, "nothing from before the reset replays");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A log from a room that never got a snapshot is deleted at start.
  #[test]
  fn a_log_without_a_room_file_is_removed_at_start() {
    let dir = tmp_dir("orphan");
    std::fs::write(dir.join(format!("{ROOM}.log")), "{}\n").unwrap();
    std::fs::write(dir.join("other0123456789abcd.json"), "{}").unwrap();
    std::fs::write(dir.join("other0123456789abcd.log"), "{}\n").unwrap();
    let _rooms = Rooms::new(Limits::default(), Some(dir.clone()));
    assert!(!dir.join(format!("{ROOM}.log")).exists());
    assert!(dir.join("other0123456789abcd.log").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Without a data dir (the bridge's LAN room) changes go out at once.
  #[tokio::test]
  async fn a_room_without_a_data_dir_delivers_at_once() {
    let mut h = Harness::with(Rooms::new(Limits::default(), None)).await;
    let (owner, _, mut owner_rx) = h.join(Some(sample_doc()), true).await;
    let (_, _, mut peer_rx) = h.join(None, false).await;
    drain(&mut owner_rx);
    drain(&mut peer_rx);
    h.send_uncommitted(owner, 1.0).await;
    assert_eq!(types(&drain(&mut peer_rx)), ["delta"]);
    assert_eq!(types(&drain(&mut owner_rx)), ["ack"]);
  }

  /// Logs are compacted into the snapshot after 30 s or 8 MB, or once the room is empty; not
  /// while people are in it and the log is small and young.
  #[tokio::test]
  async fn logs_are_compacted_after_30_s_8_mb_or_when_the_room_empties() {
    let dir = tmp_dir("policy");
    let rooms = Rooms::new(Limits::default(), Some(dir.clone()));
    let (tx, _rx) = mpsc::unbounded_channel();
    let mk = |peers: bool, bytes: usize, saved_ago: u64| {
      let mut r = Room {
        doc: Some(designotron_engine::doc::new_document(
          &mut designotron_engine::doc::IdGen::new(1),
          "t",
        )),
        dirty: true,
        log_bytes: bytes,
        last_saved: Some(Instant::now() - Duration::from_secs(saved_ago)),
        ..Room::default()
      };
      if peers {
        r.peers.insert(
          1,
          Peer {
            role: Role::Editor,
            out: Outbox {
              tx: tx.clone(),
              meter: Arc::new(Meter::new(rooms.conn_bytes.clone())),
              kick: Arc::new(Notify::new()),
            },
            name: "p".into(),
            color: "#000".into(),
            presence: Value::Null,
            granular: true,
            lists: true,
            text: false,
            model: MODEL_REVISION,
          },
        );
      }
      r
    };
    let cases = [
      ("young0123456789abcd", true, 100, 5, false),
      ("old0123456789abcdef", true, 100, 31, true),
      ("big0123456789abcdef", true, LOG_COMPACT_BYTES + 1, 5, true),
      ("empty0123456789abcd", false, 100, 5, true),
    ];
    for (id, peers, bytes, ago, _) in cases {
      rooms
        .rooms
        .lock()
        .await
        .insert(id.into(), Arc::new(Mutex::new(mk(peers, bytes, ago))));
    }
    rooms.save_dirty().await;
    for (id, _, _, _, saved) in cases {
      assert_eq!(dir.join(format!("{id}.json")).exists(), saved, "{id}");
    }
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A re-sharer's welcome waits for its snapshot; a person joining or leaving meanwhile is
  /// announced behind it, or the welcome's peer list would erase them.
  #[tokio::test]
  async fn peers_joining_and_leaving_do_not_overtake_a_held_welcome() {
    let dir = tmp_dir("welcome");
    let mut h = Harness::open(&dir).await;
    let (_, _, _first) = h.join(Some(sample_doc()), true).await;
    let (resharer, mut rx) = h.join_uncommitted(Some(sample_doc()), true).await;
    assert!(rx.try_recv().is_err(), "the welcome is held for the snapshot");
    let (late, _, _late_rx) = {
      // Someone joins before the snapshot is done (joining commits, so go through the pieces).
      let (id, rx) = h.join_uncommitted(None, false).await;
      (id, 0, rx)
    };
    {
      let mut r = h.room.lock().await;
      r.peers.remove(&late);
      h.rooms.notify(&mut r, late, &json!({ "type": "leave", "id": late }));
    }
    assert!(rx.try_recv().is_err(), "still nothing before the commit");
    h.commit().await;
    let got = drain(&mut rx);
    assert_eq!(types(&got)[0], "welcome", "{:?}", types(&got));
    assert_eq!(types(&got)[1..], ["peer", "leave"]);
    let _ = (resharer, std::fs::remove_dir_all(&dir));
  }

  /// A failed log write acknowledges nothing and sends everyone away to reconnect.
  #[tokio::test]
  async fn a_failed_log_write_acknowledges_nothing_and_kicks_everyone() {
    let dir = tmp_dir("failwrite");
    let mut h = Harness::open(&dir).await;
    let (owner, _, mut owner_rx) = h.join(Some(sample_doc()), true).await;
    let (_, _, mut peer_rx) = h.join(None, false).await;
    drain(&mut owner_rx);
    drain(&mut peer_rx);
    // The log can't be opened for appending.
    std::fs::create_dir(dir.join(format!("{ROOM}.log"))).unwrap();
    h.send(owner, 1.0).await;
    let (own, peer) = (drain(&mut owner_rx), drain(&mut peer_rx));
    assert!(!types(&own).contains(&"ack".to_string()), "no ack: {:?}", types(&own));
    assert!(!types(&peer).contains(&"delta".to_string()), "nobody sees the unsaved change");
    assert_eq!(types(&peer), ["error"]);
    for kick in &h.kicks {
      tokio::time::timeout(Duration::from_secs(1), kick.notified()).await.expect("kicked");
    }
    assert!(h.room.lock().await.compact, "the next commit snapshots instead of appending");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A batch of held changes doesn't make a peer that was keeping up look behind.
  #[tokio::test]
  async fn a_big_batch_does_not_kick_a_peer_that_was_keeping_up() {
    let rooms = Rooms::new(Limits::default(), None);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let out = Outbox {
      tx,
      meter: Arc::new(Meter::new(rooms.conn_bytes.clone())),
      kick: Arc::new(Notify::new()),
    };
    let held: Vec<Held> = (0..3)
      .map(|_| Held {
        out: out.clone(),
        text: Arc::new("x".repeat(PEER_BACKLOG / 3 + 1)),
        direct: false,
      })
      .collect();
    rooms.release(held);
    assert!(
      tokio::time::timeout(Duration::from_millis(50), out.kick.notified()).await.is_err(),
      "not kicked"
    );
    assert_eq!(std::iter::from_fn(|| rx.try_recv().ok()).count(), 3);
  }

  /// Nothing to snapshot, nothing written, however it is asked.
  #[tokio::test]
  async fn an_unchanged_room_is_not_snapshotted_again() {
    let dir = tmp_dir("unchanged");
    let mut h = Harness::open(&dir).await;
    let (_, _, _rx) = h.join(Some(sample_doc()), true).await;
    let json = dir.join(format!("{ROOM}.json"));
    std::fs::remove_file(&json).unwrap();
    h.rooms.save_all().await;
    assert!(!json.exists(), "not dirty: no second snapshot");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn sync_dir_reports_failures() {
    assert!(sync_dir(std::path::Path::new("/nonexistent-dir-for-test/file")).is_err() || cfg!(not(unix)));
    assert!(sync_dir(&std::env::temp_dir().join("x")).is_ok());
    // A bare file name (an empty parent) syncs the current directory.
    assert!(sync_dir(std::path::Path::new("x")).is_ok());
  }

  /// A document with the text layer "Hello world" and the engine that holds it, merging text.
  fn text_doc() -> (Value, String, designotron_engine::engine::Engine) {
    use designotron_engine::engine::{Command, Engine};
    let mut e = Engine::new(Box::new(designotron_engine::text::HeuristicMeasurer), 5);
    let id = e
      .dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "Hello world".into(),
        parent: None,
      })
      .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    let doc = serde_json::to_value(&e.doc).unwrap();
    e.collab_reset(true, true, true);
    e.collab_enable_text(777);
    (doc, id, e)
  }

  fn edit_text(e: &mut designotron_engine::engine::Engine, id: &str, start: usize, end: usize, text: &str) -> Value {
    e.dispatch(designotron_engine::engine::Command::EditText {
      id: id.into(),
      start,
      end,
      text: text.into(),
    })
    .unwrap();
    e.collab_delta()
  }

  fn delta_in(rx: &mut Rx) -> Value {
    drain(rx).into_iter().find(|m| m["type"] == "delta").expect("a delta")["delta"].clone()
  }

  #[tokio::test]
  async fn text_editors_get_the_entry_and_the_others_the_whole_text() {
    let dir = tmp_dir("text-fanout");
    let mut h = Harness::open(&dir).await;
    let (doc, id, mut e) = text_doc();
    let (ana, mut ana_rx) = h.join_full(Some(doc), true, true, true, true, None).await;
    // Ben reads `text`, Cai `lists` only, Dan per-id changes, Eve whole lists, Fay is at model 3.
    let (_ben, mut ben_rx) = h.join_full(None, false, true, true, true, None).await;
    let (_cai, mut cai_rx) = h.join_full(None, false, true, true, false, None).await;
    let (_dan, mut dan_rx) = h.join_full(None, false, true, false, false, None).await;
    let (_eve, mut eve_rx) = h.join_full(None, false, false, false, false, None).await;
    let (_fay, mut fay_rx) = h.join_full(None, false, true, true, false, Some(3)).await;
    h.commit().await;
    let welcome = drain(&mut ana_rx).into_iter().find(|m| m["type"] == "welcome").unwrap();
    assert_eq!(welcome["text"], json!(true));
    for rx in [&mut ben_rx, &mut cai_rx, &mut dan_rx, &mut eve_rx, &mut fay_rx] {
      let w = drain(rx).into_iter().find(|m| m["type"] == "welcome").unwrap();
      assert_eq!(w["text"], json!(true), "the room always offers it");
    }
    let d = edit_text(&mut e, &id, 5, 5, ",");
    assert!(d["text"][&id].is_object(), "the writer sends an entry: {d}");
    h.delta_text(ana, &delta_msg(d)).await;
    h.commit().await;
    let ben = delta_in(&mut ben_rx);
    assert!(ben["text"][&id]["ins"].is_array(), "a text editor gets the delta as sent");
    assert!(ben["patch"].get(&id).is_none_or(|p| p.get("text").is_none()));
    let room_text = {
      let r = h.room.lock().await;
      let mut t = serde_json::to_value(r.doc.as_ref().unwrap().get(&id).unwrap().text.as_ref().unwrap()).unwrap();
      assert!(t.get("seq").is_some(), "the room keeps the character ids");
      t.as_object_mut().unwrap().remove("seq");
      t
    };
    assert_eq!(room_text["characters"], json!("Hello, world"));
    for (name, rx) in [
      ("cai", &mut cai_rx),
      ("dan", &mut dan_rx),
      ("eve", &mut eve_rx),
      ("fay", &mut fay_rx),
    ] {
      let d = delta_in(rx);
      assert!(d.get("text").is_none(), "{name}: no text key");
      assert_eq!(d["patch"][&id]["text"], room_text, "{name}: the whole text, without seq");
    }
    assert_eq!(types(&drain(&mut ana_rx)), ["ack"]);
  }

  #[tokio::test]
  async fn malformed_and_oversized_text_entries_are_rejected_and_change_nothing() {
    let dir = tmp_dir("text-reject");
    let mut h = Harness::open(&dir).await;
    let (doc, id, _e) = text_doc();
    let (ana, mut ana_rx) = h.join_full(Some(doc), true, true, true, true, None).await;
    let (_ben, mut ben_rx) = h.join_full(None, false, true, true, true, None).await;
    h.commit().await;
    drain(&mut ana_rx);
    drain(&mut ben_rx);
    let before = {
      let r = h.room.lock().await;
      serde_json::to_value(r.doc.as_ref().unwrap()).unwrap()
    };
    let wrap = |entry: Value| json!({ "nodes": {}, "removed": [], "comments": {}, "commentsRemoved": [], "text": { id.clone(): entry } });
    let bad = [
      // `n` and `s` disagree, a site beyond 48 bits (inserted and deleted), too many characters.
      json!({ "e": 0, "ins": [{ "id": [5, 0], "s": "ab", "n": 5, "l": null, "r": null, "at": 0 }] }),
      json!({ "e": 0, "ins": [{ "id": [1u64 << 50, 0], "s": "a", "l": null, "r": null, "at": 0 }] }),
      json!({ "e": 0, "del": [[1u64 << 50, 0, 2]] }),
      json!({ "e": 0, "ins": [{ "id": [5, 0], "s": "x".repeat(200_001), "l": null, "r": null, "at": 0 }] }),
    ];
    for entry in bad {
      h.delta_text(ana, &delta_msg(wrap(entry.clone()))).await;
      h.commit().await;
      let got = drain(&mut ana_rx);
      assert_eq!(got.len(), 1, "{entry}");
      assert_eq!(
        got[0]["rejected"],
        json!(true),
        "{}",
        &entry.to_string()[..entry.to_string().len().min(200)]
      );
      assert!(drain(&mut ben_rx).is_empty(), "nothing reaches the others");
      let r = h.room.lock().await;
      assert_eq!(
        serde_json::to_value(r.doc.as_ref().unwrap()).unwrap(),
        before,
        "the room is unchanged"
      );
    }
  }

  #[test]
  fn a_viewer_cannot_send_text() {
    let (doc, id, mut e) = text_doc();
    let d = edit_text(&mut e, &id, 0, 0, "x");
    let doc: Document = serde_json::from_value(doc).unwrap();
    assert!(viewer_delta(&d, &doc).is_none());
  }
}
