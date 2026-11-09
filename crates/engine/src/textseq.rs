//! Per-character identity for text layers, so two people typing in one layer both keep every
//! character, styles merge per character and undo only reverses one person's changes.
//!
//! Every character has a stable id `(site, ctr)`; the layer's `TextProps::seq` lists the ids in
//! document order as spans, deleted characters ("tombstones") included. An insert names the
//! character to its left, a delete names ids and a style change names the first and last id of
//! its range, so applying one in any later state of the text is exact. The relay puts every change
//! in one order and every copy applies deltas in that order, so integrating only has to be
//! deterministic (no clocks, random numbers or hash-map order): there is no transformation and no
//! vector clock. See `collab` for the wire format (`text` in a delta) and `Engine` for the commands.
//!
//! Without a stored sequence a text's implicit sequence is `[[0, 0, n]]` under epoch `fnv(characters)`:
//! character `i` is `(0, i)`. A stored sequence only counts while it describes the characters it
//! sits next to (`valid`), so a path that writes `characters` without knowing about it can never
//! misplace characters.

use std::borrow::Cow;
use std::collections::BTreeMap;

use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::model::{safe_link, TextProps, TextRun};
use crate::text;

/// A deleted stretch is forgotten once this many text changes have been applied after it.
pub const GC_AGE: u32 = 512;
/// Past this many deleted stretches in one text, the oldest are forgotten.
pub const MAX_TOMBSTONE_SPANS: usize = 256;
/// Limits of one text's sequence (a stored one beyond them is invalid, an op that would exceed
/// them is rejected).
pub const MAX_SPANS: usize = 65_536;
pub const MAX_EXTRA_ITEMS: usize = 65_536;
pub const MAX_ENTRY_CHARS: usize = 200_000;
pub const MAX_SPAN_LEN: u32 = 1 << 20;
/// Inserts, deletes and style changes in one delta entry (the work of a lookup is bounded by
/// the number of spans, so this bounds the work of a hostile entry).
pub const MAX_ENTRY_OPS: usize = 4096;
/// Sites are 48-bit numbers (what a JSON number in a browser holds exactly).
pub const MAX_SITE: u64 = (1 << 48) - 1;
/// Work one entry may cost, and all the entries of one delta together (see `Meter`): charged
/// before the work is done and counted in pieces and spans touched, so every copy rejects the same
/// entry and nobody spends minutes on a crafted one.
pub const ENTRY_BUDGET: u64 = 1 << 24;
pub const DELTA_BUDGET: u64 = 1 << 25;

/// Fails to compile when `TextRun` gains a field: `ATTRS`, `attr` and `merge_attr` must learn it.
#[allow(dead_code)]
fn every_run_field_is_an_attribute(r: &TextRun) {
  let TextRun {
    start: _,
    end: _,
    font_family: _,
    font_size: _,
    font_weight: _,
    italic: _,
    color: _,
    decoration: _,
    letter_spacing: _,
    link: _,
  } = r;
}

/// The style attributes of a run (`TextRun` field names).
const ATTRS: [&str; 8] = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "italic",
  "color",
  "decoration",
  "letterSpacing",
  "link",
];

/// Identity of one character: `[site, ctr]` in JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
pub struct CharId(pub u64, pub u32);

impl<'de> Deserialize<'de> for CharId {
  fn deserialize<D: Deserializer<'de>>(d: D) -> Result<CharId, D::Error> {
    let (site, ctr) = <(u64, u32)>::deserialize(d)?;
    if site > MAX_SITE {
      return Err(de::Error::custom("site out of range"));
    }
    Ok(CharId(site, ctr))
  }
}

/// Consecutive ids of one site (`ctr .. ctr + len`), all visible or all deleted at `del` (the
/// text's clock when it was deleted). JSON `[site, ctr, len]` or `[site, ctr, len, deletedAt]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
  pub site: u64,
  pub ctr: u32,
  pub len: u32,
  pub del: Option<u32>,
}

/// The sequence of a text: `e` is the epoch the base ids number (`fnv32` of the characters of the
/// implicit base), `h` the `fnv32` of the characters this sequence describes, `k` the number of
/// deltas applied to it (a tombstone's age) and `s` the spans in document order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextSeq {
  pub e: u32,
  pub h: u32,
  pub k: u32,
  pub s: Vec<Span>,
}

/// Where this editor's new character ids come from: a site number nobody else uses and a counter
/// that only goes up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SiteIds {
  pub site: u64,
  pub ctr: u32,
}

impl SiteIds {
  /// `n` consecutive new ids; the first counter, or `None` when the counter would overflow.
  pub fn take(&mut self, n: usize) -> Option<u32> {
    let end = (self.ctr as u64).checked_add(n as u64).filter(|e| *e <= u32::MAX as u64)?;
    let first = self.ctr;
    self.ctr = end as u32;
    Some(first)
  }
}

impl Serialize for Span {
  fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
    match self.del {
      Some(d) => (self.site, self.ctr, self.len, d).serialize(s),
      None => (self.site, self.ctr, self.len).serialize(s),
    }
  }
}

impl<'de> Deserialize<'de> for Span {
  fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Span, D::Error> {
    let v = Vec::<u64>::deserialize(d)?;
    let num = |x: u64| u32::try_from(x).map_err(|_| de::Error::custom("span number out of range"));
    let (site, ctr, len, del) = match v.as_slice() {
      [a, b, c] => (*a, num(*b)?, num(*c)?, None),
      [a, b, c, d] => (*a, num(*b)?, num(*c)?, Some(num(*d)?)),
      _ => return Err(de::Error::custom("a span has 3 or 4 numbers")),
    };
    if len == 0 || len > MAX_SPAN_LEN || ctr as u64 + len as u64 > 1 << 32 || site > MAX_SITE {
      return Err(de::Error::custom("bad span"));
    }
    Ok(Span { site, ctr, len, del })
  }
}

/// `TextProps::seq` as read from a document: a stored sequence that doesn't parse is dropped (the
/// text is then plain), never an error that would lose the file or the delta around it.
pub fn lenient<'de, D: Deserializer<'de>>(d: D) -> Result<Option<TextSeq>, D::Error> {
  let v = Value::deserialize(d)?;
  Ok(serde_json::from_value::<Option<TextSeq>>(v).ok().flatten())
}

/// FNV-1a, 32 bit, over the UTF-8 bytes.
pub fn fnv32(s: &str) -> u32 {
  let mut h: u32 = 0x811c_9dc5;
  for b in s.bytes() {
    h ^= b as u32;
    h = h.wrapping_mul(0x0100_0193);
  }
  h
}

// ---------- Sequences ----------

/// The sequence that describes `t`: its stored one while it is valid, else the implicit one.
pub fn effective(t: &TextProps) -> Cow<'_, TextSeq> {
  match &t.seq {
    Some(s) if valid(s, &t.characters) => Cow::Borrowed(s),
    _ => Cow::Owned(implicit(&t.characters)),
  }
}

/// True when `seq` describes exactly `characters` and is within the limits.
pub fn valid(seq: &TextSeq, characters: &str) -> bool {
  seq.h == fnv32(characters) && within_limits(seq, characters.chars().count())
}

/// The sequence of a text nobody has edited since it was written: ids `(0, i)`.
pub fn implicit(characters: &str) -> TextSeq {
  let n = characters.chars().count() as u64;
  let h = fnv32(characters);
  let mut s = Vec::new();
  let mut ctr = 0u64;
  while ctr < n {
    let len = (n - ctr).min(MAX_SPAN_LEN as u64);
    s.push(Span {
      site: 0,
      ctr: ctr as u32,
      len: len as u32,
      del: None,
    });
    ctr += len;
  }
  TextSeq { e: h, h, k: 0, s }
}

fn within_limits(seq: &TextSeq, visible: usize) -> bool {
  if seq.s.len() > MAX_SPANS {
    return false;
  }
  let (mut vis, mut items) = (0usize, 0usize);
  for sp in &seq.s {
    if sp.len == 0 || sp.len > MAX_SPAN_LEN || sp.ctr as u64 + sp.len as u64 > 1 << 32 || sp.site > MAX_SITE {
      return false;
    }
    items += sp.len as usize;
    if sp.del.is_none() {
      vis += sp.len as usize;
    }
  }
  if vis != visible || items > 4 * visible + MAX_EXTRA_ITEMS {
    return false;
  }
  // No id twice.
  if seq.s.len() > 1 {
    let mut ranges: Vec<(u64, u64, u64)> = seq.s.iter().map(|s| (s.site, s.ctr as u64, s.ctr as u64 + s.len as u64)).collect();
    ranges.sort_unstable();
    if ranges.windows(2).any(|w| w[0].0 == w[1].0 && w[0].2 > w[1].1) {
      return false;
    }
  }
  true
}

impl TextSeq {
  pub fn visible_len(&self) -> usize {
    self.s.iter().filter(|s| s.del.is_none()).map(|s| s.len as usize).sum()
  }

  /// The span holding `id` and the offset in it.
  pub fn find(&self, id: CharId) -> Option<(usize, u32)> {
    self
      .s
      .iter()
      .position(|s| s.site == id.0 && s.ctr <= id.1 && id.1 - s.ctr < s.len)
      .map(|i| (i, id.1 - self.s[i].ctr))
  }

  fn tombstone_spans(&self) -> usize {
    self.s.iter().filter(|s| s.del.is_some()).count()
  }

  /// Visible characters in the spans before span `i`.
  fn vis_before(&self, i: usize) -> usize {
    self.s[..i].iter().filter(|s| s.del.is_none()).map(|s| s.len as usize).sum()
  }

  /// Splits span `i` at `off` (`0 < off < len`); returns the index of the second half.
  fn split(&mut self, i: usize, off: u32) -> usize {
    let sp = self.s[i];
    self.s[i].len = off;
    self.s.insert(
      i + 1,
      Span {
        ctr: sp.ctr + off,
        len: sp.len - off,
        ..sp
      },
    );
    i + 1
  }

  /// Makes `a..b` of span `i` a span of its own; returns its index.
  fn isolate(&mut self, i: usize, a: u32, b: u32) -> usize {
    if b < self.s[i].len {
      self.split(i, b);
    }
    if a > 0 {
      self.split(i, a)
    } else {
      i
    }
  }

  /// The span index to insert at to land right after item `off` of span `i`.
  fn after(&mut self, i: usize, off: u32) -> usize {
    if off + 1 < self.s[i].len {
      self.split(i, off + 1)
    } else {
      i + 1
    }
  }

  /// The span index to insert at to land right before item `off` of span `i`.
  fn before(&mut self, i: usize, off: u32) -> usize {
    if off > 0 {
      self.split(i, off)
    } else {
      i
    }
  }

  /// Right before the visible character `at` (the end when there is no such character).
  fn at_visible(&mut self, at: usize) -> usize {
    let mut vis = 0;
    for i in 0..self.s.len() {
      if self.s[i].del.is_none() {
        let len = self.s[i].len as usize;
        if at < vis + len {
          return self.before(i, (at - vis) as u32);
        }
        vis += len;
      }
    }
    self.s.len()
  }

  /// Where an insert goes: right after `l` (the start when `l` is `None`), else right before `r`,
  /// else before the visible character `at`.
  fn place(&mut self, l: Option<CharId>, r: Option<CharId>, at: usize) -> usize {
    match l {
      None => 0,
      Some(id) => match self.find(id) {
        Some((i, off)) => self.after(i, off),
        None => match r.and_then(|r| self.find(r)) {
          Some((i, off)) => self.before(i, off),
          None => self.at_visible(at),
        },
      },
    }
  }

  /// Merges neighbours that continue one another (same site, next counters, same state).
  fn coalesce(&mut self) {
    let mut out: Vec<Span> = Vec::with_capacity(self.s.len());
    for sp in self.s.drain(..) {
      match out.last_mut() {
        Some(l)
          if l.site == sp.site
            && l.ctr as u64 + l.len as u64 == sp.ctr as u64
            && l.del == sp.del
            && l.len as u64 + sp.len as u64 <= MAX_SPAN_LEN as u64 =>
        {
          l.len += sp.len
        }
        _ => out.push(sp),
      }
    }
    self.s = out;
  }

  /// Forgets old deleted stretches: those deleted more than `GC_AGE` changes ago, then the
  /// oldest ones while more than `MAX_TOMBSTONE_SPANS` remain.
  fn gc(&mut self) {
    let k = self.k;
    self.s.retain(|s| s.del.is_none_or(|d| k.saturating_sub(d) <= GC_AGE));
    let tombs = self.tombstone_spans();
    if tombs > MAX_TOMBSTONE_SPANS {
      let mut order: Vec<(u32, usize)> = self.s.iter().enumerate().filter_map(|(i, s)| s.del.map(|d| (d, i))).collect();
      order.sort_unstable();
      let drop: std::collections::HashSet<usize> = order.iter().take(tombs - MAX_TOMBSTONE_SPANS).map(|(_, i)| *i).collect();
      let mut i = 0;
      self.s.retain(|_| {
        i += 1;
        !drop.contains(&(i - 1))
      });
    }
  }

  /// Makes the sequence fit the limits for `visible` characters by forgetting the oldest deleted
  /// stretches (as `gc` does), so two people deleting halves of a long text are never refused.
  fn fit(&mut self, visible: usize) {
    let limit = 4 * visible + MAX_EXTRA_ITEMS;
    let mut items: usize = self.s.iter().map(|s| s.len as usize).sum();
    let mut spans = self.s.len();
    if spans <= MAX_SPANS && items <= limit {
      return;
    }
    let mut order: Vec<(u32, usize)> = self.s.iter().enumerate().filter_map(|(i, s)| s.del.map(|d| (d, i))).collect();
    order.sort_unstable();
    let mut drop = vec![false; self.s.len()];
    for (_, i) in order {
      if spans <= MAX_SPANS && items <= limit {
        break;
      }
      drop[i] = true;
      spans -= 1;
      items -= self.s[i].len as usize;
    }
    let mut i = 0;
    self.s.retain(|_| {
      i += 1;
      !drop[i - 1]
    });
  }

  /// Marks the visible characters `start..end` as deleted at `age`.
  fn tombstone_visible(&mut self, start: usize, end: usize, age: u32) {
    let mut vis = 0;
    let mut i = 0;
    while i < self.s.len() && vis < end {
      let sp = self.s[i];
      if sp.del.is_some() {
        i += 1;
        continue;
      }
      let len = sp.len as usize;
      if vis + len <= start {
        vis += len;
        i += 1;
        continue;
      }
      let a = start.saturating_sub(vis) as u32;
      let b = (end - vis).min(len) as u32;
      let mid = self.isolate(i, a, b);
      self.s[mid].del = Some(age);
      vis += b as usize;
      i = mid + 1;
    }
  }

  /// A new run of `len` ids at span index `pos`.
  fn insert_run(&mut self, pos: usize, site: u64, ctr: u32, len: u32, del: Option<u32>) {
    self.s.insert(pos, Span { site, ctr, len, del });
  }
}

/// Replaces the visible characters `start..end` of a sequence by `ins_len` new ones: the deleted
/// ones become tombstones, the new ids go right after the visible character `start - 1` (before
/// any tombstones there). `None` when the ids ran out.
fn edit_seq(seq: &mut TextSeq, start: usize, end: usize, ins_len: usize, ids: &mut SiteIds) -> Option<()> {
  let first = if ins_len > 0 { Some(ids.take(ins_len)?) } else { None };
  if end > start {
    seq.tombstone_visible(start, end, seq.k);
  }
  if let Some(ctr) = first {
    let pos = if start == 0 {
      0
    } else {
      let mut vis = 0;
      let mut pos = seq.s.len();
      for i in 0..seq.s.len() {
        if seq.s[i].del.is_none() {
          let len = seq.s[i].len as usize;
          if start <= vis + len {
            pos = seq.after(i, (start - 1 - vis) as u32);
            break;
          }
          vis += len;
        }
      }
      pos
    };
    let mut ctr = ctr;
    let mut left = ins_len;
    let mut at = pos;
    while left > 0 {
      let n = left.min(MAX_SPAN_LEN as usize);
      seq.insert_run(at, ids.site, ctr, n as u32, None);
      at += 1;
      ctr += n as u32;
      left -= n;
    }
  }
  seq.coalesce();
  Some(())
}

// ---------- Local edits ----------

/// Replaces the characters `start..end` (code points) of `t` with `text`, the way a person's edit
/// does: runs follow `text::splice_runs`, the deleted characters become tombstones and the new ones
/// get ids of this editor's site. `Err` when the ids ran out (the caller then drops the sequence).
pub fn local_edit(t: &mut TextProps, start: usize, end: usize, text: &str, ids: &mut SiteIds) -> Result<(), String> {
  let len = t.characters.chars().count();
  let (start, end) = (start.min(len), end.min(len));
  let end = end.max(start);
  let mut seq = effective(t).into_owned();
  edit_seq(&mut seq, start, end, text.chars().count(), ids).ok_or("out of character ids")?;
  text::edit_text(t, start, end, text);
  seq.fit(t.characters.chars().count());
  seq.h = fnv32(&t.characters);
  t.seq = Some(seq);
  Ok(())
}

/// After `t.characters` was replaced by a path that knows nothing about sequences: a sequence for
/// the new text, made from `prev`'s by the smallest edit (the common start and end stay, the
/// middle is deleted and inserted). Does nothing when `t`'s own sequence is still valid. `false`
/// when the ids ran out.
pub fn fixup(prev: &TextProps, t: &mut TextProps, ids: &mut SiteIds) -> bool {
  // (A sequence the same as the old one beside other characters is stale, whatever its hash says.)
  let stale = t.seq.is_some() && t.seq == prev.seq && t.characters != prev.characters;
  if !stale && t.seq.as_ref().is_some_and(|s| valid(s, &t.characters)) {
    return true;
  }
  if prev.characters == t.characters {
    t.seq = prev.seq.clone().filter(|s| valid(s, &t.characters));
    return true;
  }
  let a: Vec<char> = prev.characters.chars().collect();
  let b: Vec<char> = t.characters.chars().collect();
  let prefix = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
  let max_suffix = a.len().min(b.len()) - prefix;
  let suffix = a
    .iter()
    .rev()
    .zip(b.iter().rev())
    .take(max_suffix)
    .take_while(|(x, y)| x == y)
    .count();
  let mut seq = effective(prev).into_owned();
  if edit_seq(&mut seq, prefix, a.len() - suffix, b.len() - suffix - prefix, ids).is_none() {
    t.seq = None;
    return false;
  }
  seq.fit(b.len());
  seq.h = fnv32(&t.characters);
  // (A text longer than the limits just has no sequence.)
  t.seq = within_limits(&seq, b.len()).then_some(seq);
  true
}

/// Where `new` differs from `old` (code points): the changed range in `new`, `start..end`.
pub fn changed_range(old: &str, new: &str) -> (usize, usize) {
  let a: Vec<char> = old.chars().collect();
  let b: Vec<char> = new.chars().collect();
  let prefix = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
  let max_suffix = a.len().min(b.len()) - prefix;
  let suffix = a
    .iter()
    .rev()
    .zip(b.iter().rev())
    .take(max_suffix)
    .take_while(|(x, y)| x == y)
    .count();
  (prefix, b.len() - suffix)
}

// ---------- Carets ----------

/// The character before each caret index (`None` = the start), against `seq` when given (an older
/// state the editor kept), else the current sequence of `t`. Indices past the end count as the end.
pub fn anchors(t: &TextProps, seq: Option<&TextSeq>, indices: &[usize]) -> Vec<Option<CharId>> {
  let own;
  let seq = match seq {
    Some(s) => s,
    None => {
      own = effective(t);
      &*own
    }
  };
  indices
    .iter()
    .map(|&idx| {
      if idx == 0 {
        return None;
      }
      let mut vis = 0usize;
      let mut last = None;
      for sp in seq.s.iter().filter(|s| s.del.is_none()) {
        let len = sp.len as usize;
        if idx <= vis + len {
          return Some(CharId(sp.site, sp.ctr + (idx - vis - 1) as u32));
        }
        vis += len;
        last = Some(CharId(sp.site, sp.ctr + sp.len - 1));
      }
      last
    })
    .collect()
}

/// The current caret index of each anchor: after the character, or where a deleted one was; the
/// start for `None`; `None` for an id the sequence no longer knows.
pub fn indices(t: &TextProps, anchors: &[Option<CharId>]) -> Vec<Option<usize>> {
  let seq = effective(t);
  anchors
    .iter()
    .map(|a| match a {
      None => Some(0),
      Some(id) => seq.find(*id).map(|(i, off)| {
        let before = seq.vis_before(i);
        if seq.s[i].del.is_none() {
          before + off as usize + 1
        } else {
          before
        }
      }),
    })
    .collect()
}

// ---------- Differences and the wire format ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum St {
  Absent,
  Vis,
  Tomb,
}

/// Ids of one site in one state (`c0..c1`); `vis` is the visible index of the first item when it
/// is visible, else the number of visible characters before it.
struct Range {
  c0: u32,
  c1: u32,
  st: St,
  vis: usize,
}

struct Index {
  by_site: BTreeMap<u64, Vec<Range>>,
}

impl Index {
  fn new(seq: &TextSeq) -> Index {
    let mut by_site: BTreeMap<u64, Vec<Range>> = BTreeMap::new();
    let mut vis = 0usize;
    for sp in &seq.s {
      let visible = sp.del.is_none();
      by_site.entry(sp.site).or_default().push(Range {
        c0: sp.ctr,
        c1: sp.ctr + sp.len,
        st: if visible { St::Vis } else { St::Tomb },
        vis,
      });
      if visible {
        vis += sp.len as usize;
      }
    }
    for v in by_site.values_mut() {
      v.sort_by_key(|r| r.c0);
    }
    Index { by_site }
  }

  /// `c0..c1` of `site` cut into pieces of one state: `(c0, c1, state, visible index)`.
  fn cover(&self, site: u64, c0: u32, c1: u32) -> Vec<(u32, u32, St, usize)> {
    let mut out = Vec::new();
    let mut cur = c0;
    if let Some(rs) = self.by_site.get(&site) {
      let first = rs.partition_point(|r| r.c1 <= c0);
      for r in &rs[first..] {
        if r.c0 >= c1 {
          break;
        }
        if r.c0 > cur {
          out.push((cur, r.c0, St::Absent, 0));
          cur = r.c0;
        }
        let (a, b) = (cur.max(r.c0), c1.min(r.c1));
        out.push((a, b, r.st, r.vis + if r.st == St::Vis { (a - r.c0) as usize } else { 0 }));
        cur = b;
      }
    }
    if cur < c1 {
      out.push((cur, c1, St::Absent, 0));
    }
    out
  }
}

/// A run of new (or revived) ids.
#[derive(Clone, Debug, PartialEq)]
struct Ins {
  site: u64,
  ctr: u32,
  len: u32,
  /// The characters (`None` for ids typed and deleted before they were ever sent).
  chars: Option<String>,
  l: Option<CharId>,
  r: Option<CharId>,
  at: usize,
  runs: Vec<TextRun>,
}

/// A style change over the ids from `a` to `b`: `set` values and `clr` attributes; `olds` holds
/// the value each changed attribute had before (only for a revert, where it guards the change).
#[derive(Clone, Debug, PartialEq)]
struct Sty {
  a: CharId,
  b: CharId,
  set: Map<String, Value>,
  clr: Vec<String>,
  olds: BTreeMap<String, Option<Value>>,
}

/// What it takes to turn one text into another (same epoch).
#[derive(Default)]
struct Parts {
  p: Map<String, Value>,
  ins: Vec<Ins>,
  del: Vec<(u64, u32, u32)>,
  sty: Vec<Sty>,
  /// Pieces the inserts fall into in the old text (what a reader makes of them).
  pieces: u64,
}

/// One segment of the new text's sequence: ids in one state in the old text and one in the new.
struct Seg {
  site: u64,
  c0: u32,
  c1: u32,
  old: St,
  old_vis: usize,
  new: St,
  new_vis: usize,
}

impl Seg {
  fn is_new(&self) -> bool {
    self.old == St::Absent || (self.old == St::Tomb && self.new == St::Vis)
  }
}

/// The layer-wide props of `t` as JSON, without what the sequence covers.
fn props_json(t: &TextProps) -> Map<String, Value> {
  let shell = TextProps {
    characters: String::new(),
    runs: Vec::new(),
    seq: None,
    ..t.clone()
  };
  match serde_json::to_value(shell) {
    Ok(Value::Object(mut m)) => {
      m.remove("characters");
      m.remove("runs");
      m.remove("seq");
      m
    }
    _ => Map::new(),
  }
}

/// The override attributes of a run as JSON values (`None` where it overrides nothing).
fn attr(r: &TextRun, key: &str) -> Option<Value> {
  match key {
    "fontFamily" => r.font_family.as_ref().map(|v| json!(v)),
    "fontSize" => r.font_size.map(|v| json!(v)),
    "fontWeight" => r.font_weight.map(|v| json!(v)),
    "italic" => r.italic.map(|v| json!(v)),
    "color" => r.color.as_ref().map(|v| json!(v)),
    "decoration" => r.decoration.and_then(|v| serde_json::to_value(v).ok()),
    "letterSpacing" => r.letter_spacing.map(|v| json!(v)),
    "link" => r.link.as_ref().map(|v| json!(v)),
    _ => None,
  }
}

/// The overrides in force on character `i`.
fn style_at(runs: &[TextRun], i: usize) -> TextRun {
  let k = runs.partition_point(|r| r.end <= i);
  match runs.get(k) {
    Some(r) if r.start <= i => TextRun {
      start: 0,
      end: 0,
      ..r.clone()
    },
    _ => TextRun::default(),
  }
}

/// Where the runs change inside the visible characters `lo..hi` (offsets from `lo`, strictly inside).
fn cuts(runs: &[TextRun], lo: usize, hi: usize, out: &mut Vec<usize>) {
  let first = runs.partition_point(|r| r.end <= lo);
  for r in &runs[first..] {
    if r.start >= hi {
      break;
    }
    for x in [r.start, r.end] {
      if x > lo && x < hi {
        out.push(x - lo);
      }
    }
  }
}

fn diff(base: &TextProps, doc: &TextProps, strict: bool) -> Option<Parts> {
  let (bs, ds) = (effective(base), effective(doc));
  if bs.e != ds.e {
    return None;
  }
  let (bi, di) = (Index::new(&bs), Index::new(&ds));
  let mut parts = Parts::default();

  // The new text's sequence cut where the old one's states change.
  let mut segs: Vec<Seg> = Vec::new();
  let mut dvis = 0usize;
  for sp in &ds.s {
    let visible = sp.del.is_none();
    for (c0, c1, old, ov) in bi.cover(sp.site, sp.ctr, sp.ctr + sp.len) {
      let mut a = c0;
      while a < c1 {
        // New items go in pieces no longer than an entry may be.
        let new_seg = old == St::Absent || (old == St::Tomb && visible);
        let b = if new_seg {
          c1.min(a.saturating_add(MAX_ENTRY_CHARS as u32))
        } else {
          c1
        };
        segs.push(Seg {
          site: sp.site,
          c0: a,
          c1: b,
          old,
          old_vis: ov + if old == St::Vis { (a - c0) as usize } else { 0 },
          new: if visible { St::Vis } else { St::Tomb },
          new_vis: dvis + if visible { (a - sp.ctr) as usize } else { 0 },
        });
        a = b;
      }
    }
    if visible {
      dvis += sp.len as usize;
    }
  }

  // Inserts: runs of new or revived ids that continue one another in the new document.
  let chars: Vec<char> = if segs.iter().any(|s| s.is_new() && s.new == St::Vis) {
    doc.characters.chars().collect()
  } else {
    Vec::new()
  };
  let mut i = 0;
  while i < segs.len() {
    if !segs[i].is_new() {
      i += 1;
      continue;
    }
    let first = &segs[i];
    let (site, ctr, kind, at) = (first.site, first.c0, first.new, first.new_vis);
    let mut j = i;
    let mut len = first.c1 - first.c0;
    while j + 1 < segs.len() {
      let n = &segs[j + 1];
      if n.is_new() && n.site == site && n.c0 == ctr + len && n.new == kind && (len as usize + (n.c1 - n.c0) as usize) <= MAX_ENTRY_CHARS {
        len += n.c1 - n.c0;
        j += 1;
      } else {
        break;
      }
    }
    let l = (i > 0).then(|| CharId(segs[i - 1].site, segs[i - 1].c1 - 1));
    let r = segs[j + 1..].iter().find(|s| s.old != St::Absent).map(|s| CharId(s.site, s.c0));
    let (chars_s, runs) = if kind == St::Vis {
      let end = at + len as usize;
      let s: String = chars[at..end].iter().collect();
      let first_run = doc.runs.partition_point(|r| r.end <= at);
      let runs: Vec<TextRun> = doc.runs[first_run..]
        .iter()
        .take_while(|r| r.start < end)
        .map(|r| TextRun {
          start: r.start.max(at) - at,
          end: r.end.min(end) - at,
          ..r.clone()
        })
        .collect();
      (Some(s), runs)
    } else {
      (None, Vec::new())
    };
    parts.pieces += bi.cover(site, ctr, ctr + len).len() as u64;
    parts.ins.push(Ins {
      site,
      ctr,
      len,
      chars: chars_s,
      l,
      r,
      at,
      runs,
    });
    i = j + 1;
  }

  // Deletes: visible in the old text, not in the new one.
  for sp in bs.s.iter().filter(|s| s.del.is_none()) {
    for (c0, c1, st, _) in di.cover(sp.site, sp.ctr, sp.ctr + sp.len) {
      if st == St::Vis {
        continue;
      }
      match parts.del.last_mut() {
        Some(l) if l.0 == sp.site && l.1 + l.2 == c0 => l.2 += c1 - c0,
        _ => parts.del.push((sp.site, c0, c1 - c0)),
      }
    }
  }

  // Styles: characters visible in both, per run segment, grouped while the change is the same.
  let mut group: Option<Sty> = None;
  let flush = |g: &mut Option<Sty>, out: &mut Vec<Sty>| {
    if let Some(g) = g.take() {
      out.push(g);
    }
  };
  for sg in &segs {
    if sg.new == St::Vis && sg.old != St::Vis {
      flush(&mut group, &mut parts.sty);
      continue;
    }
    if sg.old != St::Vis || sg.new != St::Vis {
      continue;
    }
    let n = (sg.c1 - sg.c0) as usize;
    let mut cut = vec![0usize, n];
    cuts(&base.runs, sg.old_vis, sg.old_vis + n, &mut cut);
    cuts(&doc.runs, sg.new_vis, sg.new_vis + n, &mut cut);
    cut.sort_unstable();
    cut.dedup();
    for w in cut.windows(2) {
      let (k0, k1) = (w[0], w[1]);
      let (b, d) = (style_at(&base.runs, sg.old_vis + k0), style_at(&doc.runs, sg.new_vis + k0));
      let mut set = Map::new();
      let mut clr = Vec::new();
      let mut olds = BTreeMap::new();
      for key in ATTRS {
        let (bv, dv) = (attr(&b, key), attr(&d, key));
        if bv == dv {
          continue;
        }
        match &dv {
          Some(v) => {
            set.insert(key.to_string(), v.clone());
          }
          None => clr.push(key.to_string()),
        }
        if strict {
          olds.insert(key.to_string(), bv);
        }
      }
      if set.is_empty() && clr.is_empty() {
        flush(&mut group, &mut parts.sty);
        continue;
      }
      let last = CharId(sg.site, sg.c0 + k1 as u32 - 1);
      match group.as_mut() {
        Some(g) if g.set == set && g.clr == clr && g.olds == olds => g.b = last,
        _ => {
          flush(&mut group, &mut parts.sty);
          group = Some(Sty {
            a: CharId(sg.site, sg.c0 + k0 as u32),
            b: last,
            set,
            clr,
            olds,
          });
        }
      }
    }
  }
  flush(&mut group, &mut parts.sty);

  // The layer-wide props.
  let (bp, dp) = (props_json(base), props_json(doc));
  for (k, v) in &dp {
    if bp.get(k) != Some(v) {
      parts.p.insert(k.clone(), v.clone());
    }
  }
  for k in bp.keys().filter(|k| !dp.contains_key(*k)) {
    parts.p.insert(k.clone(), Value::Null);
  }
  Some(parts)
}

/// The `text` entry of a delta for a text that went from `base` to `doc`: `None` when the two
/// don't share an epoch (the whole text travels instead). An entry with no changes is `{e}` only.
pub fn ops(base: &TextProps, doc: &TextProps) -> Option<Value> {
  ops_costed(base, doc).map(|(e, _)| e)
}

/// `ops`, and what applying the entry is estimated to cost (for `collab::delta` to keep a delta
/// within `DELTA_BUDGET`).
pub fn ops_costed(base: &TextProps, doc: &TextProps) -> Option<(Value, u64)> {
  let parts = diff(base, doc, false)?;
  // An entry the receivers would refuse (too many pieces or characters, or too much work) travels
  // as the whole text instead.
  // (A reader makes the inserts before it deletes, on a text as big as the bigger of the two.)
  let spans = effective(doc).s.len().max(effective(base).s.len());
  let ins_bytes: usize = parts.ins.iter().map(|i| i.chars.as_ref().map_or(0, |c| c.len())).sum();
  let ins_runs: usize = parts.ins.iter().map(|i| i.runs.len()).sum();
  let bytes = doc.characters.len().max(base.characters.len() + ins_bytes);
  let runs = doc.runs.len().max(base.runs.len() + ins_runs);
  let cost = estimate(&parts, spans, bytes, runs);
  if fits(&parts).is_err() || cost > ENTRY_BUDGET / 2 {
    return None;
  }
  let mut o = Map::new();
  o.insert("e".into(), json!(effective(doc).e));
  if !parts.p.is_empty() {
    o.insert("p".into(), Value::Object(parts.p));
  }
  if !parts.ins.is_empty() {
    let ins: Vec<Value> = parts
      .ins
      .iter()
      .map(|i| {
        let mut m = Map::new();
        m.insert("id".into(), json!([i.site, i.ctr]));
        match &i.chars {
          Some(s) => m.insert("s".into(), json!(s)),
          None => {
            m.insert("n".into(), json!(i.len));
            m.insert("d".into(), json!(true))
          }
        };
        m.insert("l".into(), json!(i.l));
        m.insert("r".into(), json!(i.r));
        m.insert("at".into(), json!(i.at));
        if !i.runs.is_empty() {
          m.insert("runs".into(), json!(i.runs));
        }
        Value::Object(m)
      })
      .collect();
    o.insert("ins".into(), Value::Array(ins));
  }
  if !parts.del.is_empty() {
    o.insert("del".into(), json!(parts.del));
  }
  if !parts.sty.is_empty() {
    let sty: Vec<Value> = parts
      .sty
      .iter()
      .map(|s| {
        let mut m = Map::new();
        m.insert("a".into(), json!(s.a));
        m.insert("b".into(), json!(s.b));
        if !s.set.is_empty() {
          m.insert("set".into(), Value::Object(s.set.clone()));
        }
        if !s.clr.is_empty() {
          m.insert("clr".into(), json!(s.clr));
        }
        Value::Object(m)
      })
      .collect();
    o.insert("sty".into(), Value::Array(sty));
  }
  Some((Value::Object(o), cost))
}

// ---------- Apply ----------

/// A `text` entry of a delta as it arrives.
#[derive(Deserialize)]
struct Entry {
  e: u32,
  #[serde(default)]
  p: Map<String, Value>,
  #[serde(default)]
  ins: Vec<WireIns>,
  #[serde(default)]
  del: Vec<(u64, u32, u32)>,
  #[serde(default)]
  sty: Vec<WireSty>,
}

#[derive(Deserialize)]
struct WireIns {
  id: CharId,
  #[serde(default)]
  s: Option<String>,
  #[serde(default)]
  n: Option<u32>,
  #[serde(default)]
  d: bool,
  #[serde(default)]
  l: Option<CharId>,
  #[serde(default)]
  r: Option<CharId>,
  #[serde(default)]
  at: usize,
  #[serde(default)]
  runs: Vec<TextRun>,
}

#[derive(Deserialize)]
struct WireSty {
  a: CharId,
  b: CharId,
  #[serde(default)]
  set: Map<String, Value>,
  #[serde(default)]
  clr: Vec<String>,
}

/// Applies a `text` entry of a delta to `t`, as every copy does in the relay's order. `Err` for a
/// malformed or over-limit entry (the caller then rejects the whole delta); never panics.
pub fn apply(t: &mut TextProps, entry: &Value) -> Result<(), String> {
  apply_as(t, entry, false, &mut ENTRY_BUDGET.clone())
}

/// `apply` that also takes its work out of `budget` (what is left of a delta's `DELTA_BUDGET`).
pub fn apply_budgeted(t: &mut TextProps, entry: &Value, budget: &mut u64) -> Result<(), String> {
  apply_as(t, entry, false, budget)
}

/// `apply` for a change this editor re-applies as its own (made while it was offline): no clock
/// tick and nothing forgotten, because the delta it sends afterwards is made from the difference
/// and the room does the ticking.
pub fn apply_local(t: &mut TextProps, entry: &Value) -> Result<(), String> {
  apply_as(t, entry, true, &mut u64::MAX.clone())
}

/// Work counted in pieces and spans touched, charged before it is done.
struct Meter(u64);

impl Meter {
  fn charge(&mut self, units: u64) -> Result<(), String> {
    match self.0.checked_sub(units) {
      Some(left) => {
        self.0 = left;
        Ok(())
      }
      None => Err("text entry over its work budget".into()),
    }
  }
}

/// What the limits allow in one entry (the writer and the reader both ask).
fn fits(parts: &Parts) -> Result<(), &'static str> {
  if parts.ins.len() + parts.del.len() + parts.sty.len() > MAX_ENTRY_OPS {
    return Err("too many text operations");
  }
  let chars: usize = parts.ins.iter().map(|i| i.len as usize).sum();
  if chars > MAX_ENTRY_CHARS {
    return Err("text entry: too long");
  }
  Ok(())
}

/// About what applying `parts` to a text of `spans` spans, `n` bytes of characters and `runs` runs
/// costs, one piece per insert (the writer's view; the reader charges the pieces it really makes).
fn estimate(parts: &Parts, spans: usize, n: usize, runs: usize) -> u64 {
  let ops = (parts.ins.len() + parts.del.len() + parts.sty.len()) as u64;
  let spans = spans as u64 + 2 * ops;
  let runs = runs as u64 + parts.ins.iter().map(|i| i.runs.len() as u64).sum::<u64>() + 2 * parts.sty.len() as u64;
  let n = n as u64;
  let mut c = spans + n + runs;
  // The reader charges every piece an insert falls into, and every delete a scan of the spans.
  c += parts.pieces.max(parts.ins.len() as u64) * piece_units(spans, n, runs, 0);
  c += parts.ins.iter().map(|i| i.len as u64 / 4).sum::<u64>();
  c += parts.del.len() as u64 * del_units(spans)
    + if parts.del.is_empty() {
      0
    } else {
      n + runs + parts.del.len() as u64
    };
  c + parts.sty.len() as u64 * sty_units(spans, runs)
}

/// Work units of one piece of `n` characters in a text of `spans` spans, `bytes` bytes and `runs` runs.
fn piece_units(spans: u64, bytes: u64, runs: u64, n: u64) -> u64 {
  4 * spans + bytes / 8 + runs + n / 4 + 1
}

fn del_units(spans: u64) -> u64 {
  4 * spans + 1
}

fn sty_units(spans: u64, runs: u64) -> u64 {
  4 * spans + 32 * runs + 1
}

fn apply_as(t: &mut TextProps, entry: &Value, local: bool, budget: &mut u64) -> Result<(), String> {
  let en = Entry::deserialize(entry).map_err(|e| format!("bad text entry: {e}"))?;
  let mut parts = Parts {
    p: en.p,
    ..Default::default()
  };
  for i in en.ins {
    let CharId(site, ctr) = i.id;
    let len = match (&i.s, i.n, i.d) {
      (Some(s), n, false) => {
        let c = s.chars().count();
        if n.is_some_and(|n| n as usize != c) {
          return Err("text entry: n doesn't match s".into());
        }
        c
      }
      (_, Some(n), true) => n as usize,
      _ => return Err("text entry: an insert needs s, or n with d".into()),
    };
    if len == 0 || len > MAX_ENTRY_CHARS || ctr as u64 + len as u64 > 1 << 32 {
      return Err("text entry: bad insert length".into());
    }
    let mut runs = i.runs;
    for r in runs.iter_mut() {
      if let Some(l) = r.link.take() {
        r.link = safe_link(&l);
      }
    }
    parts.ins.push(Ins {
      site,
      ctr,
      len: len as u32,
      chars: if i.d { None } else { i.s },
      l: i.l,
      r: i.r,
      at: i.at,
      runs,
    });
  }
  for (site, ctr, len) in en.del {
    if len == 0 || ctr as u64 + len as u64 > 1 << 32 || site > MAX_SITE {
      return Err("text entry: bad delete".into());
    }
    parts.del.push((site, ctr, len));
  }
  for s in en.sty {
    parts.sty.push(Sty {
      a: s.a,
      b: s.b,
      set: s.set,
      clr: s.clr,
      olds: BTreeMap::new(),
    });
  }
  fits(&parts).map_err(|e| e.to_string())?;
  // All or nothing: a failed entry leaves the text as it was.
  let backup = t.clone();
  let mut meter = Meter(if local { u64::MAX } else { (*budget).min(ENTRY_BUDGET) });
  let before = meter.0;
  let out = apply_parts(t, &parts, Some(en.e), local, &mut meter);
  if out.is_err() {
    *t = backup;
  }
  if !local {
    *budget = budget.saturating_sub(before - meter.0);
  }
  out
}

/// The sequence-relevant work of `apply_parts`. `epoch` is the sender's (`None`: the parts were
/// diffed against this very text, so it is the same); `local` marks a change made here (a revert):
/// no clock tick, deletions stamped with the current clock, nothing forgotten.
fn apply_parts(t: &mut TextProps, parts: &Parts, epoch: Option<u32>, local: bool, m: &mut Meter) -> Result<(), String> {
  if !parts.p.is_empty() {
    apply_props(t, &parts.p)?;
  }
  if parts.ins.is_empty() && parts.del.is_empty() && parts.sty.is_empty() {
    return Ok(());
  }
  let mut seq = effective(t).into_owned();
  let same = epoch.is_none_or(|e| e == seq.e);
  let age = if local { seq.k } else { seq.k.saturating_add(1) };
  let len = t.characters.chars().count();
  m.charge(seq.s.len() as u64 + len as u64 + t.runs.len() as u64)?;
  for ins in &parts.ins {
    apply_ins(t, &mut seq, ins, same, age, m)?;
  }
  if same {
    if !parts.del.is_empty() {
      apply_del(t, &mut seq, &parts.del, age, m)?;
    }
    let len = t.characters.chars().count();
    for sty in &parts.sty {
      apply_sty(t, &seq, sty, len, m)?;
    }
  }
  if !local {
    seq.k = seq.k.saturating_add(1);
    seq.gc();
  }
  seq.coalesce();
  let len = t.characters.chars().count();
  seq.fit(len);
  seq.h = fnv32(&t.characters);
  text::normalize_runs(&mut t.runs, len);
  if !within_limits(&seq, len) {
    return Err("text sequence over its limits".into());
  }
  t.seq = Some(seq);
  Ok(())
}

/// The layer-wide props in `p` (`null` resets one to its default).
fn apply_props(t: &mut TextProps, p: &Map<String, Value>) -> Result<(), String> {
  let characters = std::mem::take(&mut t.characters);
  let runs = std::mem::take(&mut t.runs);
  let seq = t.seq.take();
  let mut v = serde_json::to_value(&*t).map_err(|e| e.to_string())?;
  let o = v.as_object_mut().ok_or("bad text")?;
  for (k, val) in p {
    if matches!(k.as_str(), "characters" | "runs" | "seq") {
      continue;
    }
    if val.is_null() {
      o.remove(k);
    } else {
      o.insert(k.clone(), val.clone());
    }
  }
  let new: Result<TextProps, _> = serde_json::from_value(v);
  match new {
    Ok(n) => *t = n,
    Err(e) => {
      t.characters = characters;
      t.runs = runs;
      t.seq = seq;
      return Err(format!("bad text props: {e}"));
    }
  }
  t.characters = characters;
  t.runs = runs;
  t.seq = seq;
  Ok(())
}

fn byte_of(s: &str, ci: usize) -> usize {
  if s.is_ascii() {
    return ci.min(s.len());
  }
  s.char_indices().nth(ci).map_or(s.len(), |(b, _)| b)
}

/// Puts `s` (`n` characters) in at visible index `v`: runs after it shift, a run it lands in is
/// split around it, and the new characters get exactly `runs`.
fn insert_chars(t: &mut TextProps, v: usize, s: &str, n: usize, runs: &[TextRun]) {
  let b = byte_of(&t.characters, v);
  t.characters.insert_str(b, s);
  let mut out = Vec::with_capacity(t.runs.len() + runs.len() + 1);
  for r in &t.runs {
    if r.end <= v {
      out.push(r.clone());
    } else if r.start >= v {
      out.push(TextRun {
        start: r.start + n,
        end: r.end + n,
        ..r.clone()
      });
    } else {
      out.push(TextRun { end: v, ..r.clone() });
      out.push(TextRun {
        start: v + n,
        end: r.end + n,
        ..r.clone()
      });
    }
  }
  for r in runs {
    let (a, b) = (r.start.min(n), r.end.min(n));
    if b > a {
      out.push(TextRun {
        start: v + a,
        end: v + b,
        ..r.clone()
      });
    }
  }
  t.runs = out;
}

/// Takes the visible character ranges (sorted, apart, code points) out in one pass; the runs
/// follow (a run end inside a range collapses to its start).
fn remove_ranges(t: &mut TextProps, ranges: &[(usize, usize)]) {
  if ranges.is_empty() {
    return;
  }
  let mut out = String::with_capacity(t.characters.len());
  let mut ri = 0;
  for (i, c) in t.characters.chars().enumerate() {
    while ri < ranges.len() && ranges[ri].1 <= i {
      ri += 1;
    }
    if ri < ranges.len() && ranges[ri].0 <= i {
      continue;
    }
    out.push(c);
  }
  let mut cum = vec![0usize];
  for (a, b) in ranges {
    cum.push(cum.last().unwrap() + (b - a));
  }
  // Where old index `i` ends up.
  let shifted = |i: usize| -> usize {
    let k = ranges.partition_point(|r| r.1 <= i);
    let partial = ranges.get(k).map_or(0, |r| i.saturating_sub(r.0));
    i - cum[k] - partial
  };
  let len = out.chars().count();
  t.runs = t
    .runs
    .iter()
    .filter_map(|r| {
      let (s, e) = (shifted(r.start), shifted(r.end));
      (e > s).then(|| TextRun {
        start: s,
        end: e,
        ..r.clone()
      })
    })
    .collect();
  t.characters = out;
  text::normalize_runs(&mut t.runs, len);
}

/// The ids of `ins` that are new here go in (by `l`, `r` or `at`; by `at` alone when the epochs
/// differ), the ones that exist as tombstones come back in place, the ones that exist visibly stay.
fn apply_ins(t: &mut TextProps, seq: &mut TextSeq, ins: &Ins, same: bool, age: u32, m: &mut Meter) -> Result<(), String> {
  let born_deleted = ins.chars.is_none();
  if !same && born_deleted {
    return Ok(());
  }
  let chars: Vec<char> = ins.chars.as_deref().map(|s| s.chars().collect()).unwrap_or_default();
  let end = ins.ctr + ins.len;
  let mut j = ins.ctr;
  while j < end {
    match seq.find(CharId(ins.site, j)) {
      Some((i, off)) => {
        let sp = seq.s[i];
        let n = (sp.len - off).min(end - j);
        if sp.del.is_some() && !born_deleted && same {
          // Back in place.
          m.charge(piece_cost(t, seq, n))?;
          let mid = seq.isolate(i, off, off + n);
          seq.s[mid].del = None;
          let v = seq.vis_before(mid);
          let k = (j - ins.ctr) as usize;
          let part: String = chars[k..k + n as usize].iter().collect();
          let runs = runs_slice(&ins.runs, k, n as usize);
          insert_chars(t, v, &part, n as usize, &runs);
        }
        j += n;
      }
      None => {
        // How many ids from here on are new.
        let next = seq
          .s
          .iter()
          .filter(|s| s.site == ins.site && s.ctr > j && s.ctr < end)
          .map(|s| s.ctr)
          .min()
          .unwrap_or(end);
        let n = next - j;
        m.charge(piece_cost(t, seq, n))?;
        let pos = if j == ins.ctr {
          if same {
            seq.place(ins.l, ins.r, ins.at)
          } else {
            seq.at_visible(ins.at)
          }
        } else {
          seq.place(Some(CharId(ins.site, j - 1)), None, ins.at)
        };
        if born_deleted {
          seq.insert_run(pos, ins.site, j, n, Some(age));
        } else {
          let v = seq.vis_before(pos);
          seq.insert_run(pos, ins.site, j, n, None);
          let k = (j - ins.ctr) as usize;
          let part: String = chars[k..k + n as usize].iter().collect();
          let runs = runs_slice(&ins.runs, k, n as usize);
          insert_chars(t, v, &part, n as usize, &runs);
        }
        j += n;
      }
    }
  }
  Ok(())
}

/// What making a piece of `n` characters costs: the spans looked through, the characters moved
/// and the runs shifted.
fn piece_cost(t: &TextProps, seq: &TextSeq, n: u32) -> u64 {
  piece_units(seq.s.len() as u64, t.characters.len() as u64, t.runs.len() as u64, n as u64)
}

/// The runs of an insert restricted to its characters `k..k + n`, relative to `k`.
fn runs_slice(runs: &[TextRun], k: usize, n: usize) -> Vec<TextRun> {
  runs
    .iter()
    .filter(|r| r.end > k && r.start < k + n)
    .map(|r| TextRun {
      start: r.start.max(k) - k,
      end: r.end.min(k + n) - k,
      ..r.clone()
    })
    .collect()
}

/// Deletes the id spans: visible characters in them become tombstones, and their characters go out
/// in one pass.
fn apply_del(t: &mut TextProps, seq: &mut TextSeq, del: &[(u64, u32, u32)], age: u32, m: &mut Meter) -> Result<(), String> {
  // Stamp of what this call deletes (counted as visible while the positions are worked out).
  const FRESH: u32 = u32::MAX;
  let mut gone: Vec<(usize, usize)> = Vec::new();
  for &(site, ctr, len) in del {
    m.charge(del_units(seq.s.len() as u64))?;
    let (lo, hi) = (ctr as u64, ctr as u64 + len as u64);
    let mut vis = 0usize;
    let mut i = 0;
    while i < seq.s.len() {
      let sp = seq.s[i];
      let visible = sp.del.is_none();
      let counted = visible || sp.del == Some(FRESH);
      let (c0, c1) = (sp.ctr as u64, sp.ctr as u64 + sp.len as u64);
      if visible && sp.site == site && c0 < hi && c1 > lo {
        let a = (lo.max(c0) - c0) as u32;
        let b = (hi.min(c1) - c0) as u32;
        let mid = seq.isolate(i, a, b);
        seq.s[mid].del = Some(FRESH);
        gone.push((vis + a as usize, vis + b as usize));
        vis += b as usize;
        i = mid + 1;
      } else {
        if counted {
          vis += sp.len as usize;
        }
        i += 1;
      }
    }
  }
  for sp in seq.s.iter_mut().filter(|s| s.del == Some(FRESH)) {
    sp.del = Some(age);
  }
  gone.sort_unstable();
  m.charge(t.characters.len() as u64 + t.runs.len() as u64 + gone.len() as u64)?;
  remove_ranges(t, &gone);
  Ok(())
}

/// The visible characters between ids `a` and `b` (either may be deleted; swapped when `b` comes
/// first): `start..end`, or `None` when an id is unknown.
fn resolve_range(seq: &TextSeq, a: CharId, b: CharId) -> Option<(usize, usize)> {
  let (ia, ib) = (seq.find(a)?, seq.find(b)?);
  let (first, last) = if (ia.0, ia.1) <= (ib.0, ib.1) { (ia, ib) } else { (ib, ia) };
  let pos = |(i, off): (usize, u32)| seq.vis_before(i) + if seq.s[i].del.is_none() { off as usize } else { 0 };
  let start = pos(first);
  let end = pos(last) + if seq.s[last.0].del.is_none() { 1 } else { 0 };
  (start < end).then_some((start, end))
}

fn apply_sty(t: &mut TextProps, seq: &TextSeq, sty: &Sty, len: usize, m: &mut Meter) -> Result<(), String> {
  m.charge(sty_units(seq.s.len() as u64, t.runs.len() as u64))?;
  let Some((start, end)) = resolve_range(seq, sty.a, sty.b) else {
    return Ok(());
  };
  let mut set = sty.set.clone();
  for key in set.keys() {
    if !ATTRS.contains(&key.as_str()) {
      return Err(format!("bad style attribute {key}"));
    }
  }
  let mut patch: TextRun = serde_json::from_value(Value::Object(std::mem::take(&mut set))).map_err(|e| format!("bad style: {e}"))?;
  patch.start = 0;
  patch.end = 0;
  if let Some(l) = patch.link.take() {
    patch.link = safe_link(&l);
  }
  let clr: Vec<&str> = sty.clr.iter().map(|s| s.as_str()).filter(|k| ATTRS.contains(k)).collect();
  if sty.olds.is_empty() {
    t.runs = text::style_range(&t.runs, len, start, end, &patch, &clr);
    return Ok(());
  }
  // A revert: each attribute only where it still has the value the step gave it.
  let mut cut = vec![0usize, end - start];
  cuts(&t.runs, start, end, &mut cut);
  cut.sort_unstable();
  cut.dedup();
  for w in cut.windows(2) {
    let (a, b) = (start + w[0], start + w[1]);
    let now = style_at(&t.runs, a);
    let keys: Vec<&str> = sty
      .olds
      .iter()
      .filter(|(k, old)| attr(&now, k) == **old)
      .map(|(k, _)| k.as_str())
      .collect();
    if keys.is_empty() {
      continue;
    }
    let mut p = TextRun::default();
    let mut c: Vec<&str> = Vec::new();
    for key in keys {
      if sty.set.contains_key(key) {
        merge_attr(&mut p, &patch, key);
      } else {
        c.push(key);
      }
    }
    t.runs = text::style_range(&t.runs, len, a, b, &p, &c);
  }
  Ok(())
}

/// Copies the attribute `key` of `from` into `into`.
fn merge_attr(into: &mut TextRun, from: &TextRun, key: &str) {
  match key {
    "fontFamily" => into.font_family = from.font_family.clone(),
    "fontSize" => into.font_size = from.font_size,
    "fontWeight" => into.font_weight = from.font_weight,
    "italic" => into.italic = from.italic,
    "color" => into.color = from.color.clone(),
    "decoration" => into.decoration = from.decoration,
    "letterSpacing" => into.letter_spacing = from.letter_spacing,
    "link" => into.link = from.link.clone(),
    _ => {}
  }
}

// ---------- Per-person undo ----------

/// `cur` with the change that took `from` to `to` made again (an undo of a step whose result was
/// `from`, or a redo the other way round), without touching what others did meanwhile: inserted
/// characters of the step go (by id), deleted ones come back where they were (their tombstones
/// revive; if forgotten they go back by their old neighbours), and a style comes back only on
/// characters that still have the value the step gave them. Returns `cur` with new `characters`,
/// `runs` and `seq` (other props are the caller's to merge), or `None` when the three texts
/// don't share an epoch.
pub fn revert(cur: &TextProps, from: &TextProps, to: &TextProps) -> Option<TextProps> {
  if effective(cur).e != effective(from).e {
    return None;
  }
  let mut parts = diff(from, to, true)?;
  parts.p.clear();
  let mut out = cur.clone();
  apply_parts(&mut out, &parts, None, true, &mut Meter(u64::MAX)).ok()?;
  Some(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn text(s: &str) -> TextProps {
    TextProps {
      characters: s.into(),
      ..Default::default()
    }
  }

  fn bold(start: usize, end: usize) -> TextRun {
    TextRun {
      start,
      end,
      font_weight: Some(700),
      ..Default::default()
    }
  }

  fn ids(site: u64) -> SiteIds {
    SiteIds { site, ctr: 0 }
  }

  /// `doc` made from `base` by `edit`, and its `text` entry.
  fn delta_of(base: &TextProps, edit: impl FnOnce(&mut TextProps)) -> (TextProps, Value) {
    let mut doc = base.clone();
    edit(&mut doc);
    let e = ops(base, &doc).expect("same epoch");
    (doc, e)
  }

  fn json_roundtrip(t: &TextProps) -> TextProps {
    serde_json::from_str(&serde_json::to_string(t).unwrap()).unwrap()
  }

  #[test]
  fn fnv_matches_the_reference_values() {
    assert_eq!(fnv32(""), 0x811c_9dc5);
    assert_eq!(fnv32("a"), 0xe40c_292c);
    assert_eq!(fnv32("foobar"), 0xbf9c_f968);
  }

  #[test]
  fn implicit_and_stored_sequences() {
    let t = text("hello");
    let s = effective(&t);
    assert_eq!(
      s.s,
      vec![Span {
        site: 0,
        ctr: 0,
        len: 5,
        del: None
      }]
    );
    assert_eq!(s.e, fnv32("hello"));
    assert!(t.seq.is_none());
    // A stored sequence counts while it describes the characters.
    let mut t = text("hello");
    local_edit(&mut t, 5, 5, "!", &mut ids(9)).unwrap();
    assert_eq!(t.characters, "hello!");
    let stored = t.seq.clone().unwrap();
    assert!(valid(&stored, &t.characters));
    assert_eq!(effective(&t).s.len(), 2);
    // Another path changes the characters: the stale sequence is ignored, not misapplied.
    t.characters = "hullo!".into();
    assert!(!valid(&stored, &t.characters));
    assert_eq!(
      effective(&t).s,
      vec![Span {
        site: 0,
        ctr: 0,
        len: 6,
        del: None
      }]
    );
    // Wrong length, over the limit, repeated ids.
    let bad = TextSeq {
      e: 1,
      h: fnv32("ab"),
      k: 0,
      s: vec![Span {
        site: 0,
        ctr: 0,
        len: 5,
        del: None,
      }],
    };
    assert!(!valid(&bad, "ab"));
    let twice = TextSeq {
      e: 1,
      h: fnv32("ab"),
      k: 0,
      s: vec![
        Span {
          site: 1,
          ctr: 0,
          len: 1,
          del: None,
        },
        Span {
          site: 1,
          ctr: 0,
          len: 1,
          del: None,
        },
      ],
    };
    assert!(!valid(&twice, "ab"));
    let many = TextSeq {
      e: 1,
      h: fnv32("a"),
      k: 0,
      s: (0..=MAX_SPANS as u32)
        .map(|i| Span {
          site: 1,
          ctr: i * 2,
          len: 1,
          del: Some(0),
        })
        .chain([Span {
          site: 2,
          ctr: 0,
          len: 1,
          del: None,
        }])
        .collect(),
    };
    assert!(!valid(&many, "a"));
  }

  #[test]
  fn seq_json_is_compact_and_survives_a_round_trip() {
    let mut t = text("hello world");
    local_edit(&mut t, 5, 11, "", &mut ids(193847261)).unwrap();
    local_edit(&mut t, 5, 5, "!!", &mut ids(193847261)).unwrap();
    let s = serde_json::to_value(&t).unwrap();
    let seq = &s["seq"];
    assert_eq!(seq["s"][0], json!([0, 0, 5]));
    assert!(
      seq["s"].as_array().unwrap().iter().any(|x| x.as_array().unwrap().len() == 4),
      "a tombstone has its age"
    );
    assert_eq!(json_roundtrip(&t), t);
    // An unparseable sequence in a document is dropped, not an error.
    let mut v = s.clone();
    v["seq"] = json!({"e": "x"});
    let back: TextProps = serde_json::from_value(v).unwrap();
    assert!(back.seq.is_none());
    let mut v = s;
    v["seq"]["s"] = json!([[1, 2]]);
    assert!(serde_json::from_value::<TextProps>(v).unwrap().seq.is_none());
  }

  #[test]
  fn typing_goes_after_the_left_character_before_tombstones() {
    let mut t = text("abcd");
    local_edit(&mut t, 1, 3, "", &mut ids(7)).unwrap(); // a [bc] d
    local_edit(&mut t, 1, 1, "X", &mut ids(7)).unwrap();
    assert_eq!(t.characters, "aXd");
    let s = effective(&t);
    assert_eq!(
      s.s[0],
      Span {
        site: 0,
        ctr: 0,
        len: 1,
        del: None
      }
    );
    assert_eq!(s.s[1].site, 7, "X sits right after a, before the deleted ones");
    assert_eq!(s.s[2].del, Some(0));
  }

  #[test]
  fn concurrent_inserts_at_one_spot_keep_both_runs_whole() {
    let base = text("Hello world");
    let (a_doc, a) = delta_of(&base, |t| local_edit(t, 11, 11, " AAA", &mut ids(1)).unwrap());
    let (_, b) = delta_of(&base, |t| local_edit(t, 11, 11, " BBB", &mut ids(2)).unwrap());
    assert_eq!(a_doc.characters, "Hello world AAA");
    // The room: A first, then B. The later one goes first.
    let mut room = base.clone();
    apply(&mut room, &a).unwrap();
    apply(&mut room, &b).unwrap();
    assert_eq!(room.characters, "Hello world BBB AAA");
    // The other order.
    let mut room2 = base.clone();
    apply(&mut room2, &b).unwrap();
    apply(&mut room2, &a).unwrap();
    assert_eq!(room2.characters, "Hello world AAA BBB");
  }

  #[test]
  fn typing_at_the_start_and_the_end_both_land() {
    let base = text("Hello world");
    let (_, a) = delta_of(&base, |t| local_edit(t, 11, 11, " AAA", &mut ids(1)).unwrap());
    let (_, b) = delta_of(&base, |t| local_edit(t, 0, 0, "BBB ", &mut ids(2)).unwrap());
    let mut room = base.clone();
    apply(&mut room, &b).unwrap();
    apply(&mut room, &a).unwrap();
    assert_eq!(room.characters, "BBB Hello world AAA");
  }

  #[test]
  fn characters_typed_inside_a_deleted_stretch_survive() {
    let base = text("Hello world");
    let (_, del) = delta_of(&base, |t| local_edit(t, 5, 11, "", &mut ids(1)).unwrap());
    let (_, ins) = delta_of(&base, |t| local_edit(t, 8, 8, "XY", &mut ids(2)).unwrap());
    for order in [[&del, &ins], [&ins, &del]] {
      let mut room = base.clone();
      for e in order {
        apply(&mut room, e).unwrap();
      }
      assert_eq!(room.characters, "HelloXY", "the typed characters stay");
    }
  }

  #[test]
  fn applying_twice_changes_nothing() {
    let base = text("abcdef");
    let mut doc = base.clone();
    doc.runs = vec![bold(0, 2)];
    let base2 = base.clone();
    let (_, e) = delta_of(&base2, |t| {
      local_edit(t, 2, 4, "XYZ", &mut ids(5)).unwrap();
      t.runs = text::style_range(&t.runs, 5, 0, 2, &bold(0, 0), &[]);
    });
    let mut room = base.clone();
    apply(&mut room, &e).unwrap();
    let once = room.clone();
    apply(&mut room, &e).unwrap();
    assert_eq!(room.characters, once.characters);
    assert_eq!(room.runs, once.runs);
    assert_eq!(effective(&room).s, effective(&once).s);
  }

  #[test]
  fn ops_describe_inserts_deletes_and_styles() {
    let base = text("abcdef");
    let (doc, e) = delta_of(&base, |t| {
      local_edit(t, 1, 3, "XY", &mut ids(5)).unwrap();
      t.runs = text::style_range(&t.runs, 6, 3, 5, &bold(0, 0), &[]);
    });
    assert_eq!(doc.characters, "aXYdef");
    assert_eq!(e["e"], json!(fnv32("abcdef")));
    assert_eq!(e["ins"][0]["s"], json!("XY"));
    assert_eq!(e["ins"][0]["l"], json!([0, 0]));
    assert_eq!(
      e["ins"][0]["r"],
      json!([0, 1]),
      "the nearest base item after the run, deleted or not"
    );
    assert_eq!(e["ins"][0]["at"], json!(1));
    assert_eq!(e["del"], json!([[0, 1, 2]]));
    assert_eq!(e["sty"][0]["a"], json!([0, 3]));
    assert_eq!(e["sty"][0]["b"], json!([0, 4]));
    assert_eq!(e["sty"][0]["set"], json!({"fontWeight": 700}));
    // And it rebuilds the same text elsewhere.
    let mut other = base.clone();
    apply(&mut other, &e).unwrap();
    assert_eq!(other.characters, doc.characters);
    assert_eq!(other.runs, doc.runs);
  }

  #[test]
  fn ops_of_an_unchanged_text_is_empty_and_a_replaced_text_has_none() {
    let t = text("abc");
    assert_eq!(ops(&t, &t).unwrap(), json!({"e": fnv32("abc")}));
    let replaced = text("xyz");
    assert!(ops(&t, &replaced).is_none(), "a whole replace changes the epoch");
    let mut props = t.clone();
    props.font_size = 30.0;
    props.max_lines = Some(2);
    let e = ops(&t, &props).unwrap();
    assert_eq!(e["p"], json!({"fontSize": 30.0, "maxLines": 2}));
    let mut back = t.clone();
    apply(&mut back, &e).unwrap();
    assert_eq!(back.font_size, 30.0);
    assert_eq!(back.max_lines, Some(2));
    assert!(back.seq.is_none(), "props alone don't store a sequence");
    let e = ops(&props, &t).unwrap();
    assert_eq!(e["p"]["maxLines"], Value::Null);
  }

  #[test]
  fn born_deleted_ids_travel_as_tombstones() {
    let base = text("ab");
    let (doc, e) = delta_of(&base, |t| {
      local_edit(t, 1, 1, "xyz", &mut ids(3)).unwrap();
      local_edit(t, 1, 3, "", &mut ids(3)).unwrap(); // typed and deleted before a flush
    });
    assert_eq!(doc.characters, "azb");
    assert!(e["ins"].as_array().unwrap().iter().any(|i| i["d"] == json!(true)));
    let mut room = base.clone();
    apply(&mut room, &e).unwrap();
    assert_eq!(room.characters, "azb");
    assert_eq!(
      effective(&room).s.iter().map(|s| s.len).sum::<u32>(),
      5,
      "every copy holds the same items"
    );
    assert_eq!(effective(&room).e, effective(&doc).e);
    // Anyone's later insert after a tombstone finds it.
    let (_, later) = delta_of(&doc, |t| local_edit(t, 2, 2, "Q", &mut ids(4)).unwrap());
    apply(&mut room, &later).unwrap();
    assert_eq!(room.characters, "azQb");
  }

  #[test]
  fn insert_falls_back_to_the_right_anchor_then_to_position() {
    let base = text("abcdef");
    let (_, e) = delta_of(&base, |t| local_edit(t, 3, 3, "XY", &mut ids(5)).unwrap());
    // The left anchor (0,2) was forgotten here: the run goes before (0,3).
    let mut room = base.clone();
    let mut s = implicit("abcdef");
    s.s = vec![
      Span {
        site: 0,
        ctr: 0,
        len: 2,
        del: None,
      },
      Span {
        site: 0,
        ctr: 3,
        len: 3,
        del: None,
      },
    ];
    s.h = fnv32("abdef");
    room.characters = "abdef".into();
    room.seq = Some(TextSeq { e: fnv32("abcdef"), ..s });
    apply(&mut room, &e).unwrap();
    assert_eq!(room.characters, "abXYdef");
    // Both anchors gone: by position.
    let mut room = base.clone();
    room.characters = "abdef".into();
    room.seq = Some(TextSeq {
      e: fnv32("abcdef"),
      h: fnv32("abdef"),
      k: 0,
      s: vec![Span {
        site: 0,
        ctr: 10,
        len: 5,
        del: None,
      }],
    });
    apply(&mut room, &e).unwrap();
    assert_eq!(room.characters, "abdXYef");
  }

  #[test]
  fn a_replaced_text_takes_inserts_by_position_and_drops_the_rest() {
    let base = text("abcdef");
    let (_, e) = delta_of(&base, |t| {
      local_edit(t, 3, 3, "XY", &mut ids(5)).unwrap();
      local_edit(t, 0, 1, "", &mut ids(5)).unwrap();
    });
    let mut other = text("uvwxyz"); // replaced meanwhile: another epoch
    apply(&mut other, &e).unwrap();
    assert_eq!(
      other.characters, "uvXYwxyz",
      "inserted by position; the delete and styles are dropped"
    );
    assert!(valid(other.seq.as_ref().unwrap(), &other.characters));
  }

  #[test]
  fn a_style_covers_what_arrived_inside_its_range_but_not_beside_it() {
    let base = text("abcdef");
    let (_, style) = delta_of(&base, |t| t.runs = vec![bold(1, 4)]); // bcd
    let (_, inside) = delta_of(&base, |t| local_edit(t, 2, 2, "X", &mut ids(2)).unwrap());
    let (_, before) = delta_of(&base, |t| local_edit(t, 1, 1, "P", &mut ids(3)).unwrap());
    let (_, after) = delta_of(&base, |t| local_edit(t, 4, 4, "S", &mut ids(4)).unwrap());
    let mut room = base.clone();
    for e in [&inside, &before, &after, &style] {
      apply(&mut room, e).unwrap();
    }
    let bolded: String = room
      .characters
      .chars()
      .enumerate()
      .filter(|(i, _)| room.runs.iter().any(|r| *i >= r.start && *i < r.end))
      .map(|(_, c)| c)
      .collect();
    assert_eq!(bolded, "bXcd", "the inserted X is inside the range; P and S are beside it");
  }

  #[test]
  fn a_style_over_deleted_ends_still_resolves() {
    let base = text("abcdef");
    let (_, style) = delta_of(&base, |t| t.runs = vec![bold(1, 5)]);
    let (_, del) = delta_of(&base, |t| local_edit(t, 4, 5, "", &mut ids(2)).unwrap()); // e gone
    let mut room = base.clone();
    apply(&mut room, &del).unwrap();
    apply(&mut room, &style).unwrap();
    assert_eq!(room.characters, "abcdf");
    assert_eq!(room.runs, vec![bold(1, 4)]);
  }

  #[test]
  fn unsafe_links_in_inserts_and_styles_are_dropped() {
    let base = text("ab");
    let mut e = ops(&base, &base).unwrap();
    e["ins"] = json!([{ "id": [9, 0], "s": "x", "l": [0, 1], "r": null, "at": 2,
      "runs": [{ "start": 0, "end": 1, "link": "javascript:alert(1)", "fontWeight": 700 }] }]);
    e["sty"] = json!([{ "a": [0, 0], "b": [0, 0], "set": { "link": "javascript:alert(2)", "italic": true } }]);
    let mut t = base.clone();
    apply(&mut t, &e).unwrap();
    assert!(t.runs.iter().all(|r| r.link.is_none()));
    assert!(t.runs.iter().any(|r| r.font_weight == Some(700)));
    assert!(t.runs.iter().any(|r| r.italic == Some(true)));
  }

  #[test]
  fn malformed_entries_are_errors_and_leave_the_text_alone() {
    let base = text("abc");
    for bad in [
      json!({}),
      json!({"e": "x"}),
      json!({"e": 1, "ins": [{"id": [1, 0]}]}),
      json!({"e": 1, "ins": [{"id": [1, 0], "s": "ab", "n": 3}]}),
      json!({"e": 1, "ins": [{"id": [1, 0], "d": true}]}),
      json!({"e": 1, "ins": [{"id": [1, 4294967295u32], "s": "ab"}]}),
      json!({"e": 1, "ins": [{"id": [1, 0], "n": 300000, "d": true}]}),
      json!({"e": 1, "del": [[1, 0, 0]]}),
      json!({"e": 1, "del": [[1, 4294967295u32, 9]]}),
      json!({"e": 1, "sty": [{"a": [0, 0], "b": [0, 1], "set": {"nope": 1}}]}),
      json!({"e": 1, "sty": [{"a": [0, 0], "b": [0, 1], "set": {"fontWeight": "x"}}]}),
      json!({"e": 1, "p": {"fontSize": "big"}}),
      json!([1, 2]),
    ] {
      let mut t = base.clone();
      let res = apply(&mut t, &bad);
      if res.is_ok() {
        // (An empty-looking entry that parses is fine, but it must not have changed anything.)
        assert_eq!(t.characters, "abc", "{bad}");
      } else {
        assert_eq!(t, base, "{bad}: a failed entry leaves the text as it was");
      }
    }
    let many = json!({"e": 1, "del": (0..MAX_ENTRY_OPS as u32 + 1).map(|i| json!([1, i, 1])).collect::<Vec<_>>()});
    assert!(apply(&mut base.clone(), &many).is_err());
  }

  #[test]
  fn random_json_never_panics() {
    let mut x = 0x2545_f491_4f6c_dd1du64;
    let mut next = |m: u64| {
      x ^= x << 13;
      x ^= x >> 7;
      x ^= x << 17;
      x % m
    };
    let base = text("hello world");
    for _ in 0..3000 {
      let n = |m: &mut dyn FnMut(u64) -> u64| json!([m(3), m(14)]);
      let mut e = json!({"e": if next(2) == 0 { json!(fnv32("hello world")) } else { json!(next(9)) }});
      if next(2) == 0 {
        e["ins"] = json!((0..next(3)).map(|_| {
          let s: String = (0..next(5) + 1).map(|_| (b'a' + next(26) as u8) as char).collect();
          json!({"id": n(&mut next), "s": s, "l": if next(3) == 0 { Value::Null } else { n(&mut next) }, "r": n(&mut next), "at": next(15)})
        }).collect::<Vec<_>>());
      }
      if next(2) == 0 {
        e["del"] = json!((0..next(3)).map(|_| json!([next(3), next(14), next(6) + 1])).collect::<Vec<_>>());
      }
      if next(2) == 0 {
        e["sty"] = json!((0..next(3))
          .map(|_| json!({"a": n(&mut next), "b": n(&mut next), "set": {"fontWeight": 700}}))
          .collect::<Vec<_>>());
      }
      let mut t = base.clone();
      let before = t.clone();
      match apply(&mut t, &e) {
        Ok(()) => {
          assert!(t.seq.as_ref().is_none_or(|s| valid(s, &t.characters)), "{e}");
          assert!(t.runs.iter().all(|r| r.end <= t.characters.chars().count()));
        }
        Err(_) => assert_eq!(t, before),
      }
    }
  }

  #[test]
  fn deleted_stretches_are_forgotten_by_age_and_by_count() {
    // By age.
    let mut t = text("abcdefghij");
    let (_, e) = delta_of(&t.clone(), |x| local_edit(x, 2, 4, "", &mut ids(1)).unwrap());
    apply(&mut t, &e).unwrap();
    assert!(effective(&t).s.iter().any(|s| s.del.is_some()));
    for i in 0..(GC_AGE + 2) {
      let (_, e) = delta_of(&t.clone(), |x| local_edit(x, 0, 0, "x", &mut ids(2 + i as u64)).unwrap());
      apply(&mut t, &e).unwrap();
    }
    assert!(effective(&t).s.iter().all(|s| s.del.is_none()), "the old tombstone is gone");
    // By count: every other character deleted, in deltas of 100 deletes each.
    let long: String = (0..2000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
    let mut t = text(&long);
    for batch in 0..10 {
      let (_, e) = delta_of(&t.clone(), |x| {
        for i in (0..100).rev() {
          local_edit(x, i * 2, i * 2 + 1, "", &mut ids(1 + batch as u64)).unwrap();
        }
      });
      apply(&mut t, &e).unwrap();
    }
    assert_eq!(t.characters.chars().count(), 1000);
    assert!(effective(&t).tombstone_spans() <= MAX_TOMBSTONE_SPANS);
  }

  #[test]
  fn five_thousand_edits_stay_small() {
    let mut t = text("The quick brown fox jumps over the lazy dog.");
    let mut x = 12345u64;
    let mut next = |m: usize| {
      x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
      ((x >> 33) as usize) % m
    };
    let mut ids = SiteIds { site: 5, ctr: 0 };
    let mut max_json = 0;
    for step in 0..5000 {
      let base = t.clone();
      let len = t.characters.chars().count();
      let at = next(len + 1);
      let del = if len > 30 || next(3) == 0 { next(3).min(len - at) } else { 0 };
      let ins: String = if next(4) == 0 && len > 20 {
        String::new()
      } else {
        "ab".chars().take(1 + next(2)).collect()
      };
      let mut doc = base.clone();
      local_edit(&mut doc, at, at + del, &ins, &mut ids).unwrap();
      let e = ops(&base, &doc).unwrap();
      apply(&mut t, &e).unwrap();
      let s = effective(&t);
      assert!(s.tombstone_spans() <= MAX_TOMBSTONE_SPANS, "step {step}");
      max_json = max_json.max(serde_json::to_string(&t.seq).unwrap().len());
    }
    eprintln!(
      "5000 edits: {} chars, {} spans, seq json {} bytes (max {})",
      t.characters.chars().count(),
      effective(&t).s.len(),
      serde_json::to_string(&t.seq).unwrap().len(),
      max_json
    );
    assert!(max_json < 16 * 1024, "seq json {max_json} bytes");
  }

  #[test]
  fn anchors_and_indices_follow_the_text() {
    let mut t = text("hello");
    let seq0 = effective(&t).into_owned();
    let a = anchors(&t, None, &[0, 2, 5, 99]);
    assert_eq!(a, vec![None, Some(CharId(0, 1)), Some(CharId(0, 4)), Some(CharId(0, 4))]);
    local_edit(&mut t, 0, 0, "XX", &mut ids(3)).unwrap();
    assert_eq!(indices(&t, &a), vec![Some(0), Some(4), Some(7), Some(7)]);
    // Against an older state.
    assert_eq!(anchors(&t, Some(&seq0), &[2]), vec![Some(CharId(0, 1))]);
    // A deleted anchor maps to where it was; an unknown one to nothing.
    local_edit(&mut t, 2, 5, "", &mut ids(3)).unwrap(); // XX + "llo"... deletes h, e, l
    assert_eq!(t.characters, "XXlo");
    let gone = [Some(CharId(0, 1)), Some(CharId(77, 1)), None];
    assert_eq!(indices(&t, &gone), vec![Some(2), None, Some(0)]);
    // After a tombstone is forgotten the anchor is unknown.
    assert_eq!(anchors(&text(""), None, &[0, 3]), vec![None, None]);
  }

  #[test]
  fn fixup_keeps_the_ids_of_what_did_not_change() {
    let mut prev = text("hello world");
    local_edit(&mut prev, 11, 11, "!", &mut ids(4)).unwrap();
    let mut t = prev.clone();
    t.characters = "hello brave world!".into();
    t.seq = None; // some path wrote the characters and knows nothing about sequences
    let mut gen = ids(8);
    assert!(fixup(&prev, &mut t, &mut gen));
    let s = effective(&t);
    assert!(valid(t.seq.as_ref().unwrap(), &t.characters));
    assert_eq!(s.e, effective(&prev).e);
    assert_eq!(s.visible_len(), 18);
    assert_eq!(gen.ctr, 6, "only 'brave ' got new ids");
    assert!(s.s.iter().any(|x| x.site == 0 && x.ctr == 0), "the start kept its ids");
    // A whole replacement deletes the middle and inserts the middle.
    let mut r = prev.clone();
    r.characters = "hello there!".into();
    r.seq = None;
    let mut gen = ids(8);
    fixup(&prev, &mut r, &mut gen);
    assert_eq!(gen.ctr, 5);
    assert_eq!(effective(&r).visible_len(), 12);
    // A valid sequence is left alone; equal characters take the old sequence back.
    let before = r.clone();
    fixup(&prev, &mut r, &mut gen);
    assert_eq!(r, before);
    let mut same = prev.clone();
    same.seq = None;
    fixup(&prev, &mut same, &mut gen);
    assert_eq!(same.seq, prev.seq);
  }

  #[test]
  fn revert_undoes_my_insert_and_keeps_someone_elses_text() {
    let base = text("Hello world");
    let mut mine = base.clone();
    local_edit(&mut mine, 11, 11, " AAA", &mut ids(1)).unwrap();
    // Someone typed in the middle meanwhile (applied on top of my text).
    let (_, theirs) = delta_of(&base, |t| local_edit(t, 5, 5, "XY", &mut ids(2)).unwrap());
    let mut cur = mine.clone();
    apply(&mut cur, &theirs).unwrap();
    assert_eq!(cur.characters, "HelloXY world AAA");
    let undone = revert(&cur, &mine, &base).unwrap();
    assert_eq!(undone.characters, "HelloXY world");
    // Redo brings my characters back in place.
    let redone = revert(&undone, &base, &mine).unwrap();
    assert_eq!(redone.characters, "HelloXY world AAA");
  }

  #[test]
  fn revert_of_a_delete_revives_in_place_around_someone_elses_text() {
    let base = text("Hello world");
    let mut mine = base.clone();
    local_edit(&mut mine, 5, 11, "", &mut ids(1)).unwrap();
    let (_, theirs) = delta_of(&base, |t| local_edit(t, 8, 8, "XY", &mut ids(2)).unwrap());
    let mut cur = mine.clone();
    apply(&mut cur, &theirs).unwrap();
    assert_eq!(cur.characters, "HelloXY");
    let undone = revert(&cur, &mine, &base).unwrap();
    assert_eq!(undone.characters, "Hello woXYrld", "my deleted characters come back around theirs");
    // If the tombstones were forgotten, the characters go back by their old neighbours.
    let mut forgotten = cur.clone();
    let mut s = effective(&forgotten).into_owned();
    s.s.retain(|x| x.del.is_none());
    s.h = fnv32(&forgotten.characters);
    forgotten.seq = Some(s);
    let undone = revert(&forgotten, &mine, &base).unwrap();
    assert!(
      undone.characters.contains(" wo") || undone.characters.contains("world"),
      "{}",
      undone.characters
    );
    assert_eq!(undone.characters.chars().filter(|c| "XY".contains(*c)).count(), 2);
  }

  #[test]
  fn revert_of_a_style_is_guarded_per_attribute_and_character() {
    let base = text("abcdef");
    let mut styled = base.clone();
    styled.runs = vec![bold(0, 4)];
    // Someone else made "cd" bigger and "ef" italic afterwards.
    let mut cur = styled.clone();
    cur.runs = text::style_range(
      &cur.runs,
      6,
      2,
      4,
      &TextRun {
        font_size: Some(30.0),
        ..Default::default()
      },
      &[],
    );
    cur.runs = text::style_range(
      &cur.runs,
      6,
      4,
      6,
      &TextRun {
        italic: Some(true),
        ..Default::default()
      },
      &[],
    );
    let undone = revert(&cur, &styled, &base).unwrap();
    assert!(
      undone.runs.iter().all(|r| r.font_weight.is_none()),
      "bold is gone everywhere it was"
    );
    assert!(
      undone.runs.iter().any(|r| r.font_size == Some(30.0) && r.start == 2 && r.end == 4),
      "their size stays"
    );
    assert!(undone.runs.iter().any(|r| r.italic == Some(true)));
    // Someone else unbolded "ab" already, and re-bolded "cd" differently: only matching values reset.
    let mut cur = styled.clone();
    cur.runs = vec![TextRun {
      start: 2,
      end: 4,
      font_weight: Some(900),
      ..Default::default()
    }];
    let undone = revert(&cur, &styled, &base).unwrap();
    assert!(undone.runs.iter().any(|r| r.font_weight == Some(900)), "their weight stays");
  }

  #[test]
  fn revert_needs_one_epoch() {
    let a = text("abc");
    let b = text("xyz");
    assert!(revert(&a, &a, &b).is_none());
  }

  #[test]
  fn the_writer_never_emits_what_apply_refuses() {
    // A paste of more than an entry may hold travels as the whole text.
    let base = text("x");
    let mut doc = base.clone();
    local_edit(&mut doc, 1, 1, &"y".repeat(MAX_ENTRY_CHARS + 1), &mut ids(3)).unwrap();
    assert!(ops(&base, &doc).is_none(), "an over-long paste");
    // A style over more runs than an entry may hold.
    let base = text(&"ab".repeat(4200));
    let mut doc = base.clone();
    doc.runs = (0..4100).map(|i| bold(i * 2, i * 2 + 1)).collect();
    assert!(ops(&base, &doc).is_none(), "4,100 style pieces");
    // A select-all delete over more id runs than an entry may hold.
    let n = 5000;
    let chars = "z".repeat(n);
    let seq = TextSeq {
      e: 7,
      h: fnv32(&chars),
      k: 0,
      s: (0..n as u32)
        .map(|i| Span {
          site: 1,
          ctr: i * 2,
          len: 1,
          del: None,
        })
        .collect(),
    };
    let base = TextProps {
      seq: Some(seq),
      ..text(&chars)
    };
    let mut doc = base.clone();
    local_edit(&mut doc, 0, n, "", &mut ids(2)).unwrap();
    assert!(ops(&base, &doc).is_none(), "5,000 deleted id runs");
    // An ordinary edit of a long text still travels as an entry.
    let base = text(&"line\n".repeat(20_000));
    let mut doc = base.clone();
    local_edit(&mut doc, 50_000, 50_001, "X", &mut ids(2)).unwrap();
    let e = ops(&base, &doc).unwrap();
    let mut room = base.clone();
    apply(&mut room, &e).unwrap();
    assert_eq!(room.characters, doc.characters);
  }

  #[test]
  fn two_halves_of_a_long_text_deleted_at_once_are_both_taken() {
    let base = text(&"w".repeat(70_000));
    let mut a = base.clone();
    local_edit(&mut a, 0, 35_000, "", &mut ids(1)).unwrap();
    let mut b = base.clone();
    local_edit(&mut b, 35_000, 70_000, "", &mut ids(2)).unwrap();
    let (ea, eb) = (ops(&base, &a).unwrap(), ops(&base, &b).unwrap());
    let mut room = base.clone();
    apply(&mut room, &ea).unwrap();
    apply(&mut room, &eb).unwrap();
    assert_eq!(room.characters, "");
    assert!(
      valid(room.seq.as_ref().unwrap(), &room.characters),
      "old stretches were forgotten to fit"
    );
    // The sender's own copy never holds more than the limits allow either.
    assert!(a.seq.as_ref().is_none_or(|s| valid(s, &a.characters)));
  }

  #[test]
  fn sites_are_held_to_javascript_safe_integers() {
    let base = text("ab");
    let big = 1u64 << 60;
    let mut e = ops(&base, &base).unwrap();
    e["ins"] = json!([{ "id": [big + 1, 0], "s": "x", "l": null, "r": null, "at": 0 }]);
    assert!(apply(&mut base.clone(), &e).is_err());
    e["ins"] = json!([{ "id": [MAX_SITE + 1, 0], "s": "x", "l": null, "r": null, "at": 0 }]);
    assert!(apply(&mut base.clone(), &e).is_err());
    e["ins"] = json!([{ "id": [MAX_SITE, 0], "s": "x", "l": null, "r": null, "at": 0 }]);
    let mut ok = base.clone();
    apply(&mut ok, &e).unwrap();
    assert_eq!(ok.characters, "xab");
    let mut e = ops(&base, &base).unwrap();
    e["del"] = json!([[big, 0, 1]]);
    assert!(apply(&mut base.clone(), &e).is_err());
    let mut e = ops(&base, &base).unwrap();
    e["sty"] = json!([{ "a": [big, 0], "b": [0, 0], "set": { "italic": true } }]);
    assert!(apply(&mut base.clone(), &e).is_err());
    assert!(serde_json::from_value::<Span>(json!([big, 0, 1])).is_err());
    assert!(serde_json::from_value::<Span>(json!([MAX_SITE, 0, 1])).is_ok());
    // A stored sequence with such a site is no sequence at all.
    let seq = TextSeq {
      e: 1,
      h: fnv32("ab"),
      k: 0,
      s: vec![Span {
        site: big,
        ctr: 0,
        len: 2,
        del: None,
      }],
    };
    assert!(!valid(&seq, "ab"));
  }

  #[test]
  fn a_refused_entry_leaves_the_text_untouched() {
    let base = text("abc");
    let mut e = ops(&base, &base).unwrap();
    e["ins"] = json!([{ "id": [9, 0], "s": "X", "l": [0, 2], "r": null, "at": 3 }]);
    e["sty"] = json!([{ "a": [0, 0], "b": [0, 1], "set": { "nope": 1 } }]);
    let mut t = base.clone();
    assert!(apply(&mut t, &e).is_err());
    assert_eq!(t, base);
  }

  #[test]
  fn the_position_fallback_keeps_the_pieces_of_an_insert_in_order() {
    let mut t = text("helloB");
    t.seq = Some(TextSeq {
      e: 1,
      h: fnv32("helloB"),
      k: 0,
      s: vec![
        Span {
          site: 0,
          ctr: 0,
          len: 5,
          del: None,
        },
        Span {
          site: 9,
          ctr: 1,
          len: 1,
          del: None,
        },
      ],
    });
    let e = json!({ "e": 2, "ins": [{ "id": [9, 0], "s": "ABC", "l": null, "r": null, "at": 2 }] });
    apply(&mut t, &e).unwrap();
    assert_eq!(t.characters, "heAlloBC", "A by position, C after B");
  }

  #[test]
  fn a_stale_sequence_beside_other_characters_is_rebuilt_whatever_its_hash() {
    let mut prev = text("hello");
    local_edit(&mut prev, 5, 5, "!", &mut ids(4)).unwrap();
    // (Pretend the hashes collided: both sequences say they describe the new characters.)
    prev.seq.as_mut().unwrap().h = fnv32("jello!");
    let mut t = prev.clone();
    t.characters = "jello!".into();
    assert!(valid(t.seq.as_ref().unwrap(), &t.characters));
    let mut gen = ids(8);
    fixup(&prev, &mut t, &mut gen);
    assert_ne!(t.seq, prev.seq);
    assert_eq!(gen.ctr, 1, "the changed letter has a new id");
  }

  #[test]
  fn work_is_bounded_in_release() {
    if cfg!(debug_assertions) {
      return;
    }
    let ms = |f: &mut dyn FnMut()| {
      let s = std::time::Instant::now();
      f();
      s.elapsed().as_millis()
    };
    // 4,096 style pieces on 200,000 characters: taken or refused, quickly.
    let base = text(&"a".repeat(200_000));
    let mut e = ops(&base, &base).unwrap();
    e["sty"] = json!((0..4096u32)
      .map(|i| json!({ "a": [0, i * 2], "b": [0, i * 2], "set": { "fontWeight": 700 } }))
      .collect::<Vec<_>>());
    let mut t = base.clone();
    let took = ms(&mut || drop(apply(&mut t, &e)));
    eprintln!("4096 sty ops on 200k characters: {took} ms");
    assert!(took < 100, "{took} ms");
    // 256 of them are taken.
    e["sty"] = json!((0..256u32)
      .map(|i| json!({ "a": [0, i * 2], "b": [0, i * 2], "set": { "fontWeight": 700 } }))
      .collect::<Vec<_>>());
    let mut t = base.clone();
    let took = ms(&mut || apply(&mut t, &e).unwrap());
    assert!(took < 100, "{took} ms");
    assert_eq!(t.runs.len(), 256);
    // One delete over 65,536 spans.
    let n = 32_768u32;
    let chars = "q".repeat(n as usize);
    let spans: Vec<Span> = (0..n)
      .flat_map(|i| {
        [
          Span {
            site: 1,
            ctr: i * 2,
            len: 1,
            del: None,
          },
          Span {
            site: 1,
            ctr: i * 2 + 1,
            len: 1,
            del: Some(0),
          },
        ]
      })
      .collect();
    let planted = TextProps {
      seq: Some(TextSeq {
        e: 5,
        h: fnv32(&chars),
        k: 0,
        s: spans,
      }),
      ..text(&chars)
    };
    assert!(valid(planted.seq.as_ref().unwrap(), &planted.characters));
    let e = json!({ "e": 5, "del": [[1, 0, n * 2]] });
    let mut t = planted.clone();
    let took = ms(&mut || apply(&mut t, &e).unwrap());
    eprintln!("one delete over 65,536 spans: {took} ms");
    assert!(took < 100, "{took} ms");
    assert_eq!(t.characters, "");
    // Reviving 32,768 tombstones one by one is refused by the budget, quickly and the same way twice.
    let all_gone = TextProps {
      seq: Some(TextSeq {
        e: 5,
        h: fnv32(""),
        k: 0,
        s: (0..n)
          .map(|i| Span {
            site: 1,
            ctr: i * 2,
            len: 1,
            del: Some(0),
          })
          .collect(),
      }),
      ..text("")
    };
    let e = json!({ "e": 5, "ins": [{ "id": [1, 0], "s": "q".repeat(n as usize * 2 - 1), "l": null, "r": null, "at": 0 }] });
    let (mut a, mut b) = (all_gone.clone(), all_gone.clone());
    let took = ms(&mut || {
      assert_eq!(apply(&mut a, &e).is_err(), apply(&mut b, &e).is_err());
    });
    assert!(took < 200, "{took} ms");
    assert_eq!(a, all_gone, "refused entries change nothing");
  }

  /// Whatever `ops` emits, a reader taking `base` must accept.
  fn emitted_means_accepted(base: &TextProps, doc: &TextProps) -> bool {
    match ops(base, doc) {
      Some(e) => apply(&mut base.clone(), &e).is_ok(),
      None => true,
    }
  }

  #[test]
  fn many_separate_deletes_are_emitted_only_when_a_reader_takes_them() {
    let n = 10_000u32;
    let chars = "a".repeat(n as usize);
    let seq = TextSeq {
      e: 3,
      h: fnv32(&chars),
      k: 0,
      s: (0..n)
        .map(|i| Span {
          site: 1,
          ctr: i * 2,
          len: 1,
          del: None,
        })
        .collect(),
    };
    let base = TextProps {
      seq: Some(seq),
      ..text(&chars)
    };
    let mut emitted = 0;
    for count in [100usize, 150, 500, 800] {
      let mut doc = base.clone();
      for i in (0..count).rev() {
        local_edit(&mut doc, i * 10, i * 10 + 1, "", &mut ids(2)).unwrap();
      }
      assert!(emitted_means_accepted(&base, &doc), "{count} deletes");
      emitted += ops(&base, &doc).is_some() as usize;
    }
    assert!(emitted >= 1, "ordinary sizes still travel as entries");
  }

  #[test]
  fn reviving_many_stretches_is_emitted_only_when_a_reader_takes_it() {
    let visible = 19_744u32;
    let all = "x".repeat(visible as usize + 256);
    let mut spans: Vec<Span> = (0..visible)
      .map(|i| Span {
        site: 1,
        ctr: i * 2,
        len: 1,
        del: None,
      })
      .collect();
    spans.extend((0..256u32).map(|i| Span {
      site: 2,
      ctr: i,
      len: 1,
      del: Some(i),
    }));
    let mut doc_spans = spans.clone();
    for sp in doc_spans.iter_mut().filter(|s| s.site == 2) {
      sp.del = None;
    }
    let base_chars = "x".repeat(visible as usize);
    let base = TextProps {
      seq: Some(TextSeq {
        e: 3,
        h: fnv32(&base_chars),
        k: 300,
        s: spans,
      }),
      ..text(&base_chars)
    };
    let doc = TextProps {
      seq: Some(TextSeq {
        e: 3,
        h: fnv32(&all),
        k: 300,
        s: doc_spans,
      }),
      ..text(&all)
    };
    assert!(valid(base.seq.as_ref().unwrap(), &base.characters) && valid(doc.seq.as_ref().unwrap(), &doc.characters));
    assert!(emitted_means_accepted(&base, &doc));
    // And a smaller text takes it as an entry.
    let small_base_chars = "x".repeat(900);
    let mut small: Vec<Span> = (0..900u32)
      .map(|i| Span {
        site: 1,
        ctr: i * 2,
        len: 1,
        del: None,
      })
      .collect();
    small.extend((0..256u32).map(|i| Span {
      site: 2,
      ctr: i,
      len: 1,
      del: Some(i),
    }));
    let mut small_doc = small.clone();
    for sp in small_doc.iter_mut().filter(|s| s.site == 2) {
      sp.del = None;
    }
    let sall = "x".repeat(900 + 256);
    let sb = TextProps {
      seq: Some(TextSeq {
        e: 3,
        h: fnv32(&small_base_chars),
        k: 9,
        s: small,
      }),
      ..text(&small_base_chars)
    };
    let sd = TextProps {
      seq: Some(TextSeq {
        e: 3,
        h: fnv32(&sall),
        k: 9,
        s: small_doc,
      }),
      ..text(&sall)
    };
    assert!(ops(&sb, &sd).is_some() && emitted_means_accepted(&sb, &sd));
  }

  #[test]
  fn a_big_delete_with_scattered_inserts_is_emitted_only_when_a_reader_takes_it() {
    // 200k characters, 198k of them deleted, and 650 inserts spread over the rest.
    let base = text(&"a".repeat(200_000));
    let mut doc = base.clone();
    local_edit(&mut doc, 2_000, 200_000, "", &mut ids(2)).unwrap();
    for i in (0..650).rev() {
      local_edit(&mut doc, i * 3, i * 3, "x", &mut ids(2)).unwrap();
    }
    assert!(emitted_means_accepted(&base, &doc));
    // 100k characters with 50k runs, the middle deleted, 300 and 500 inserts.
    let chars = "ab".repeat(50_000);
    let mut base = text(&chars);
    base.runs = (0..50_000).map(|i| bold(i * 2, i * 2 + 1)).collect();
    for n in [300usize, 500] {
      let mut doc = base.clone();
      local_edit(&mut doc, 20_000, 90_000, "", &mut ids(3)).unwrap();
      for i in (0..n).rev() {
        local_edit(&mut doc, i * 7, i * 7, "y", &mut ids(3)).unwrap();
      }
      assert!(emitted_means_accepted(&base, &doc), "{n} inserts");
    }
  }

  #[test]
  fn big_texts_are_fast() {
    // 10,000 characters, ~500 spans: the budget is 0.3 ms for an edit and 1 ms for ops and apply.
    let chars: String = (0..10_000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
    let mut t = text(&chars);
    let mut gen = ids(11);
    for i in 0..500 {
      local_edit(&mut t, i * 19, i * 19, "q", &mut gen).unwrap();
    }
    let spans = effective(&t).s.len();
    let time = |f: &mut dyn FnMut()| {
      let mut v: Vec<u128> = (0..3)
        .map(|_| {
          let s = std::time::Instant::now();
          for _ in 0..20 {
            f();
          }
          s.elapsed().as_nanos() / 20
        })
        .collect();
      v.sort();
      v[1]
    };
    let base = t.clone();
    let mut doc = t.clone();
    let edit = time(&mut || {
      let mut d = base.clone();
      local_edit(&mut d, 5000, 5001, "z", &mut ids(12)).unwrap();
    });
    local_edit(&mut doc, 5000, 5001, "z", &mut ids(12)).unwrap();
    let mut entry = Value::Null;
    let diff_t = time(&mut || entry = ops(&base, &doc).unwrap());
    let apply_t = time(&mut || {
      let mut d = base.clone();
      apply(&mut d, &entry).unwrap();
    });
    eprintln!("{spans} spans: edit {edit} ns (incl. clone), ops {diff_t} ns, apply {apply_t} ns (incl. clone)");
    if !cfg!(debug_assertions) {
      assert!(edit < 300_000 && diff_t < 1_000_000 && apply_t < 1_000_000, "over budget");
    }
  }
}
